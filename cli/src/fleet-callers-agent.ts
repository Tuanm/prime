// The agent's side of fleet-callers.ts: what it writes for a space's tool server, from the roster it verified and the
// lease it holds.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic-write.ts";
import type { CallerEntry } from "./caller-key.ts";
import { loadOrCreateSignKey } from "./fleet-agent.ts";
import { REPLY_CERT_RENEW_MS, REPLY_CERT_TTL_MS, publicKeyOfPem, signReplyCert } from "./fleet-reply-cert.ts";
import { type FleetCallersFile, FLEET_CALLERS_FILE, FLEET_CALLERS_RENEW_MS, FLEET_ROSTER_KEEP_MS, FLEET_ROSTER_REFRESH_MS, FLEET_CALLERS_VERSION, callersOfRoster, replyKeyFileOf } from "./fleet-callers.ts";
import type { FleetCredentials } from "./fleet-transport.ts";
import { FleetTrust, RosterRefusedError } from "./fleet-trust.ts";
import type { VerifiedRoster } from "./fleet-roster.ts";

/** What the agent knows of a space's place in the fleet, and writes where the space reads it. */
export class FleetCallersWriter {
  private wasPrimary = false;
  private primarySince = 0;
  private lastText = "";
  private lastWrite = 0;
  private lastRoster: { roster: FleetCallersFile["roster"]; note?: string; head?: { n: number; hash: string }; callers: CallerEntry[] } = {
    roster: "refused",
    note: "the agent has not read the roster yet",
    callers: [],
  };
  private failureSaid = false;
  /** The member's certificate for this space's reply key (see fleet-reply-cert.ts). */
  private replyCert: FleetCallersFile["replyCert"];
  /** When the roster was last read (and verified, or refused): a roster that cannot be read is believed for FLEET_ROSTER_KEEP_MS and no longer. */
  private rosterAt = 0;

  constructor(
    private readonly file: string,
    private readonly fleet: string,
    private readonly log: (text: string) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record what the roster says now (a verified chain, an open roster, or why it was refused). */
  setRoster(v: VerifiedRoster | { open: true } | { refused: string }): void {
    this.rosterAt = this.now();
    if ("open" in v) {
      this.lastRoster = { roster: "open", note: "the roster of this fleet is not signed: no key is listed", callers: [] };
    } else if ("refused" in v) {
      this.lastRoster = { roster: "refused", note: v.refused, callers: [] };
    } else {
      this.lastRoster = { roster: "signed", head: { n: v.head.n, hash: v.head.hash }, callers: callersOfRoster(v) };
    }
  }

  /** The certificate that is being written now, if any. */
  currentReplyCert(): FleetCallersFile["replyCert"] {
    return this.replyCert;
  }

  setReplyCert(cert: FleetCallersFile["replyCert"]): void {
    this.replyCert = cert;
  }

  /** Whether the roster is to be read again: when the space has just become the primary, and then every FLEET_ROSTER_REFRESH_MS. */
  wantsRoster(primary: boolean): boolean {
    return primary && (!this.wasPrimary || this.now() - this.rosterAt >= FLEET_ROSTER_REFRESH_MS);
  }

  /**
   * Write the file for the state it is given now. Written when something changed, and every FLEET_CALLERS_RENEW_MS
   * otherwise, because a space believes "primary" only for FLEET_CALLERS_FRESH_MS after it was written. A space that
   * stops being the primary is written at once.
   */
  update(primary: boolean): void {
    const now = this.now();
    if (primary && !this.wasPrimary) this.primarySince = now;
    this.wasPrimary = primary;
    // A roster that could not be read for a long time is not one to go on believing: nobody is listed from then on.
    if (this.lastRoster.roster === "signed" && now - this.rosterAt > FLEET_ROSTER_KEEP_MS) {
      this.lastRoster = { roster: "refused", note: "the roster could not be read for " + Math.round(FLEET_ROSTER_KEEP_MS / 60_000) + " minutes", callers: [] };
    }
    const content: FleetCallersFile = {
      version: FLEET_CALLERS_VERSION,
      fleet: this.fleet,
      roster: this.lastRoster.roster,
      ...(this.lastRoster.note ? { note: this.lastRoster.note } : {}),
      primary,
      primarySince: this.primarySince,
      writtenAt: now,
      ...(this.lastRoster.head ? { head: this.lastRoster.head } : {}),
      ...(this.replyCert ? { replyCert: this.replyCert } : {}),
      callers: this.lastRoster.callers,
    };
    // What the file says apart from when it was written.
    const stable = JSON.stringify({ ...content, writtenAt: 0 });
    if (stable === this.lastText && now - this.lastWrite < FLEET_CALLERS_RENEW_MS) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileAtomic(this.file, JSON.stringify(content, null, 2) + "\n", 0o600);
      this.lastText = stable;
      this.lastWrite = now;
      this.failureSaid = false;
    } catch (err) {
      // A space that cannot be told stops believing the agent after FLEET_CALLERS_FRESH_MS; say it once.
      if (!this.failureSaid) {
        this.failureSaid = true;
        this.log(`cannot write ${this.file}: ${err instanceof Error ? err.message : String(err)}; fleet calls to this space are refused until it can be written`);
      }
    }
  }
}


/** How often the agent looks at a space's place in the fleet and writes what the space reads. */
export const FLEET_CALLERS_TICK_MS = 5_000;

/** What `refreshFleetCallers` needs of a space's loop. */
export interface CallersLoop {
  fleet: string;
  creds: FleetCredentials;
  primary: boolean;
  paths: { keyFile: string };
  space: { secret_dir?: string };
  callersWriter?: FleetCallersWriter;
}

/** The file of a space (it is in the space's secret directory, which the space can read and not write). */
export function fleetCallersFileOf(secretDir: string): string {
  return join(secretDir, FLEET_CALLERS_FILE);
}

/**
 * Write what the space's tool server reads. The roster is fetched (and verified) only while the space is the primary, and
 * every FLEET_ROSTER_REFRESH_MS then (a member that is removed from it is out within that and the file's own renewal):
 * a replica refuses every call made for the fleet, whoever the roster lists. A roster that cannot be fetched keeps
 * what was last verified; one that is refused (the gateway's word against what this member pinned) lists nobody.
 */
export async function refreshFleetCallers(loop: CallersLoop, log: (text: string) => void = () => undefined): Promise<void> {
  const dir = loop.space.secret_dir;
  if (!dir) return;
  const writer = (loop.callersWriter ??= new FleetCallersWriter(fleetCallersFileOf(dir), loop.fleet, log));
  if (writer.wantsRoster(loop.primary)) {
    try {
      const v = await FleetTrust.beside(loop.paths.keyFile).verifiedRoster(loop.creds, loop.fleet);
      writer.setRoster(v ?? { open: true });
    } catch (err) {
      if (err instanceof RosterRefusedError) writer.setRoster({ refused: err.message });
      // Anything else is the network: what was verified last stays.
    }
  }
  issueReplyCert(loop, writer, dir, log);
  writer.update(loop.primary);
}

/**
 * Certify the key this space signs its replies with, with the member's signing key (which stays here, on the host). The space makes
 * its reply key when it first signs a reply, so until then there is nothing to certify. A new certificate is made when the key changed
 * or the one that is held has less than REPLY_CERT_RENEW_MS left.
 */
export function issueReplyCert(loop: CallersLoop & { creds: { deviceId: string } }, writer: FleetCallersWriter, secretDir: string, log: (text: string) => void, now: number = Date.now()): void {
  let replyKey: string | undefined;
  try {
    const file = replyKeyFileOf(secretDir);
    replyKey = existsSync(file) ? publicKeyOfPem(readFileSync(file, "utf8")) : undefined;
  } catch {
    replyKey = undefined;
  }
  if (replyKey === undefined) {
    writer.setReplyCert(undefined);
    return;
  }
  const held = writer.currentReplyCert();
  if (held && held.key === replyKey && held.until - now > REPLY_CERT_RENEW_MS) return;
  try {
    const sign = loadOrCreateSignKey(loop.paths.keyFile);
    const until = now + REPLY_CERT_TTL_MS;
    writer.setReplyCert({ key: replyKey, until, cert: signReplyCert(sign.privateKey, { fleet: loop.fleet, device: loop.creds.deviceId, replyKey }, until) });
  } catch (err) {
    writer.setReplyCert(undefined);
    log(`cannot certify the reply key of this space: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Refresh a space's file now and then. Returns what stops it (it writes "not the primary" once more). */
export function startFleetCallers(loop: CallersLoop, log: (text: string) => void = () => undefined, tickMs = FLEET_CALLERS_TICK_MS): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void refreshFleetCallers(loop, log).finally(() => void (busy = false));
  }, tickMs);
  timer.unref?.();
  void refreshFleetCallers(loop, log);
  return () => {
    clearInterval(timer);
    loop.callersWriter?.update(false);
  };
}
