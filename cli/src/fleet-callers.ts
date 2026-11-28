// Which keys may call the tools of a fleet's primary, from the fleet's signed roster.
//
// The fleet's agent (on the host) verifies the roster and writes <secret dir>/fleet-callers.json for the space's
// tool server (code-mcp), which only reads it. The file holds
//   - the signing keys of the fleet's live members that are not viewers (a viewer reads and never writes),
//   - the keys the owner signed in as callers (`prime fleets roster add-caller`),
//   - whether this space is the fleet's primary now, and since when.
// A call signed for `fleet:<id>` is run only by the primary (a replica that is sent one refuses it: a gateway that
// kept a signed fleet call must not get it run a second time somewhere else), only for a key in this file, and only
// when the call was signed after the space became the primary (a call from before it may already have run on the
// member that was).
//
// Nothing the gateway says is in the file: a roster the gateway keeps (open mode) lists nobody here, and a roster
// that does not verify lists nobody either.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { type CallerEntry, keyIdOf, parsePublicKey } from "./caller-key.ts";
import type { VerifiedRoster } from "./fleet-roster.ts";

export const FLEET_CALLERS_FILE = "fleet-callers.json";
export const FLEET_CALLERS_VERSION = 1;
/** The longest the agent's word that a space is the primary is believed without being renewed. */
export const FLEET_CALLERS_FRESH_MS = 2 * 60_000;
/** How often the agent writes the file when nothing changed (so a space can tell its agent is alive). */
export const FLEET_CALLERS_RENEW_MS = 20_000;

export interface FleetCallersFile {
  version: typeof FLEET_CALLERS_VERSION;
  fleet: string;
  /** What the roster is: only a signed roster names callers. */
  roster: "signed" | "open" | "refused";
  /** When it is not "signed": why nobody is listed. */
  note?: string;
  /** This space holds the fleet's place now (from the agent's own lease state). */
  primary: boolean;
  /** When this space last became the primary (ms since the epoch, the agent's clock, which is the device's). */
  primarySince: number;
  /** When the agent wrote the file. */
  writtenAt: number;
  /** The roster's head the list comes from. */
  head?: { n: number; hash: string };
  callers: CallerEntry[];
}

/** The 32 raw bytes of a base64url public key, or undefined if it is not one. */
function rawKey(b64u: string | null): Buffer | undefined {
  if (b64u === null || !/^[A-Za-z0-9_-]{43}$/.test(b64u)) return undefined;
  const raw = Buffer.from(b64u, "base64url");
  return raw.length === 32 ? raw : undefined;
}

/** The keys a verified roster lets call the primary: live members that are not viewers, and the owner's caller keys. */
export function callersOfRoster(v: VerifiedRoster): CallerEntry[] {
  const out = new Map<string, CallerEntry>();
  const at = (n: number): string => {
    const ms = v.entries[n]?.entry[5];
    return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "";
  };
  for (const t of v.tenures) {
    if (t.until !== null || t.role === "viewer") continue;
    const raw = rawKey(t.spub);
    if (!raw) continue;
    out.set(keyIdOf(raw), { keyId: keyIdOf(raw), pub: raw.toString("base64"), label: "member " + t.device, addedAt: at(t.n) });
  }
  for (const c of v.callers) {
    const raw = rawKey(c.spub);
    if (!raw) continue;
    out.set(keyIdOf(raw), { keyId: keyIdOf(raw), pub: raw.toString("base64"), label: c.label, addedAt: at(c.n) });
  }
  return [...out.values()];
}

/** What a space reads: the file, or why it cannot use it. A missing file is not an error: no fleet calls are accepted. */
export function readFleetCallers(path: string): { file?: FleetCallersFile; error?: string } {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { error: `${path} is not valid JSON` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: `${path} is not a fleet callers file` };
  const f = parsed as Record<string, unknown>;
  if (f.version !== FLEET_CALLERS_VERSION) return { error: `${path} is version ${String(f.version)}, which this build does not read` };
  if (typeof f.fleet !== "string" || f.fleet.length === 0) return { error: `${path} names no fleet` };
  if (typeof f.primary !== "boolean") return { error: `${path} does not say whether this space is the primary` };
  if (typeof f.primarySince !== "number" || !Number.isFinite(f.primarySince)) return { error: `${path} has no time for the primary` };
  if (typeof f.writtenAt !== "number" || !Number.isFinite(f.writtenAt)) return { error: `${path} has no time it was written` };
  if (!Array.isArray(f.callers)) return { error: `${path} has no callers list` };
  const callers: CallerEntry[] = [];
  for (const item of f.callers) {
    const v = item as Record<string, unknown> | null;
    const raw = v && typeof v.pub === "string" ? parsePublicKey(v.pub) : undefined;
    if (!raw) return { error: `${path} has a caller with no valid key` };
    callers.push({ keyId: keyIdOf(raw), pub: raw.toString("base64"), label: typeof v!.label === "string" ? v!.label : "", addedAt: typeof v!.addedAt === "string" ? v!.addedAt : "" });
  }
  const roster = f.roster === "signed" || f.roster === "open" || f.roster === "refused" ? f.roster : "refused";
  return {
    file: {
      version: FLEET_CALLERS_VERSION,
      fleet: f.fleet,
      roster,
      ...(typeof f.note === "string" ? { note: f.note.slice(0, 300) } : {}),
      primary: f.primary,
      primarySince: f.primarySince,
      writtenAt: f.writtenAt,
      callers: roster === "signed" ? callers : [],
    },
  };
}

/** Where a space's tool server looks for the file: beside its callers file. */
export function fleetCallersPathFor(callersFile: string): string {
  return join(dirname(callersFile), FLEET_CALLERS_FILE);
}
