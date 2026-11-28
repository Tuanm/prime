// What a caller of a fleet believes of its replies: that a member of the fleet, as the owner's signed roster names it, gave them.
//
// The caller pins the owner's fingerprint for a fleet (`prime fleets roster pin-caller`), reads the signed roster from the gateway (which
// may serve nothing but the owner's chain, whatever else it says), and takes a reply as a member's when the reply carries that member's
// certificate for the key it is signed with (fleet-reply-cert.ts). Without a pin, or when the chain cannot be had or does not verify,
// nothing is believed: a reply is then what it was before, a signature that someone made.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic-write.ts";
import { replyCertOf, verifyReplySig } from "./caller-auth.ts";
import { withDirLockSync } from "./dir-lock.ts";
import { type VerifiedRoster, normalizeFingerprint, isFingerprint, verifyChain } from "./fleet-roster.ts";
import { checkReplyCert, parseReplyCert } from "./fleet-reply-cert.ts";

export function fleetOwnersPath(): string {
  const override = process.env.PRIME_FLEET_OWNERS;
  if (override && override.trim().length > 0) return override.trim();
  return join(homedir(), ".prime", "fleet-owners.json");
}

export interface OwnerPin {
  ownerFp: string;
  /** The newest roster entry this machine verified: a chain that does not contain it is a rollback. */
  head?: { n: number; hash: string };
}

function originOf(gateway: string): string {
  try {
    return new URL(gateway).origin;
  } catch {
    return gateway;
  }
}

const pinName = (gateway: string, fleet: string) => `${fleet}@${originOf(gateway)}`;

function readPins(path: string): Record<string, OwnerPin> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${path} is not valid JSON; fix or delete it (the owners of fleets are not pinned until then)`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} does not hold an object of pinned owners; fix or delete it`);
  const out: Record<string, OwnerPin> = {};
  for (const [name, v] of Object.entries(parsed as Record<string, unknown>)) {
    const r = v as { ownerFp?: unknown; head?: { n?: unknown; hash?: unknown } } | null;
    if (!r || typeof r.ownerFp !== "string" || !isFingerprint(r.ownerFp)) continue;
    const head = r.head && typeof r.head.n === "number" && Number.isSafeInteger(r.head.n) && typeof r.head.hash === "string" ? { n: r.head.n, hash: r.head.hash } : undefined;
    out[name] = { ownerFp: normalizeFingerprint(r.ownerFp), ...(head ? { head } : {}) };
  }
  return out;
}

function updatePins<T>(path: string, change: (pins: Record<string, OwnerPin>) => { pins?: Record<string, OwnerPin>; result: T }): T {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withDirLockSync(
    `${path}.lock`,
    () => {
      const { pins, result } = change(readPins(path));
      if (pins) writeFileAtomic(path, JSON.stringify(pins, null, 2) + "\n", 0o600, { durable: true });
      return result;
    },
    { waitMs: 10_000, staleMs: 60_000 },
  );
}

export function pinnedFleetOwner(gateway: string, fleet: string, path: string = fleetOwnersPath()): OwnerPin | undefined {
  return readPins(path)[pinName(gateway, fleet)];
}

/** Pin the owner of a fleet (the head seen under another owner is dropped). Returns the pin that was there. */
export function pinFleetOwner(gateway: string, fleet: string, ownerFp: string, path: string = fleetOwnersPath()): OwnerPin | undefined {
  const fp = normalizeFingerprint(ownerFp);
  return updatePins(path, (pins) => ({ pins: { ...pins, [pinName(gateway, fleet)]: { ownerFp: fp } }, result: pins[pinName(gateway, fleet)] }));
}

export function unpinFleetOwner(gateway: string, fleet: string, path: string = fleetOwnersPath()): boolean {
  return updatePins(path, (pins) => {
    const name = pinName(gateway, fleet);
    if (!(name in pins)) return { result: false };
    const { [name]: _gone, ...rest } = pins;
    return { pins: rest, result: true };
  });
}

function noteHead(gateway: string, fleet: string, ownerFp: string, head: { n: number; hash: string }, path: string): void {
  updatePins(path, (pins) => {
    const name = pinName(gateway, fleet);
    const have = pins[name];
    if (!have || have.ownerFp !== ownerFp || (have.head && have.head.n >= head.n)) return { result: undefined };
    return { pins: { ...pins, [name]: { ownerFp, head } }, result: undefined };
  });
}

export interface AuthorityOptions {
  gateway: string;
  fleet: string;
  /** The headers that make the gateway answer for this caller (its credentials). */
  headers: () => Record<string, string>;
  fetchFn?: typeof fetch;
  now?: () => number;
  pinsPath?: string;
  /** How long a roster that verified is used before it is read again. */
  ttlMs?: number;
  timeoutMs?: number;
}

/** What a caller knows of a fleet's members. */
export class FleetAuthority {
  private cached: { at: number; roster: VerifiedRoster } | undefined;
  private failure: string | undefined;

  constructor(private readonly opts: AuthorityOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private path(): string {
    return this.opts.pinsPath ?? fleetOwnersPath();
  }

  /** Is the owner of this fleet pinned on this machine? (A damaged pins file counts as not.) */
  pinned(): boolean {
    try {
      return pinnedFleetOwner(this.opts.gateway, this.opts.fleet, this.path()) !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * Should the client say, now, that the replies of this fleet are not authenticated? Once a day for a fleet, not once for each process: a one-shot
   * `prime tools call --fleet` is a process of its own. What was said is kept beside the pins.
   */
  shouldSayUnpinned(): boolean {
    const file = this.path() + ".said";
    const name = pinName(this.opts.gateway, this.opts.fleet);
    try {
      const said = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, number>) : {};
      const now = this.now();
      if (typeof said[name] === "number" && now - said[name]! < 24 * 60 * 60_000) return false;
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileAtomic(file, JSON.stringify({ ...said, [name]: now }) + "\n", 0o600);
    } catch {
      // not being able to remember is no reason not to say it
    }
    return true;
  }

  /** Why the roster could not be used the last time it was asked for. */
  lastFailure(): string | undefined {
    return this.failure;
  }

  /** The owner's roster as this machine can verify it, or undefined (not pinned, not signed, not reachable, or not the owner's). */
  async roster(fresh = false): Promise<VerifiedRoster | undefined> {
    const ttl = this.opts.ttlMs ?? 60_000;
    if (!fresh && this.cached && this.now() - this.cached.at < ttl) return this.cached.roster;
    let pin: OwnerPin | undefined;
    try {
      pin = pinnedFleetOwner(this.opts.gateway, this.opts.fleet, this.path());
    } catch (err) {
      this.failure = err instanceof Error ? err.message : String(err);
      return undefined;
    }
    if (!pin) {
      this.failure = "the owner of this fleet is not pinned on this machine";
      return undefined;
    }
    try {
      const url = `${this.opts.gateway.replace(/\/+$/, "")}/fleets/${encodeURIComponent(this.opts.fleet)}/roster`;
      const res = await (this.opts.fetchFn ?? fetch)(url, { headers: { accept: "application/json", ...this.opts.headers() }, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000) });
      if (!res.ok) {
        this.failure = `the gateway answered ${res.status} for the roster`;
        return undefined;
      }
      const body = (await res.json()) as { mode?: unknown; entries?: unknown };
      if (body.mode !== "signed" || !Array.isArray(body.entries)) {
        this.failure = "the fleet's roster is not signed";
        return undefined;
      }
      const roster = verifyChain(body.entries, { ownerFp: pin.ownerFp, fleet: this.opts.fleet, ...(pin.head ? { pinned: pin.head } : {}) });
      try {
        noteHead(this.opts.gateway, this.opts.fleet, pin.ownerFp, roster.head, this.path());
      } catch {
        // not remembering the head costs rollback protection across runs, not this answer
      }
      this.cached = { at: this.now(), roster };
      this.failure = undefined;
      return roster;
    } catch (err) {
      this.failure = err instanceof Error ? err.message : String(err);
      return undefined;
    }
  }

  /**
   * Is this reply one that `member` gave? Its signature must be good (checked here), and its certificate must be one that a live member
   * of the owner's roster, the one named `member`, signed for the key of the reply.
   */
  async certifiedBy(replySig: string, nonce: string, requestBody: string, responseText: string, member: string, options: { fresh?: boolean } = {}): Promise<boolean> {
    const certText = replyCertOf(replySig);
    if (certText === undefined) return false;
    const cert = parseReplyCert(certText);
    const pub = verifyReplySig(replySig, nonce, requestBody, responseText);
    if (!cert || !pub) return false;
    if (!checkReplyCert(cert, { fleet: this.opts.fleet, device: member, replyKey: pub.toString("base64url") }, this.now())) return false;
    // A member that was removed must not vouch for a retry for as long as the roster that listed it is cached: `fresh` reads it again.
    const roster = await this.roster(options.fresh === true);
    if (!roster) return false;
    return roster.tenures.some((t) => t.device === member && t.spub === cert.spub && t.until === null && t.role !== "viewer");
  }
}
