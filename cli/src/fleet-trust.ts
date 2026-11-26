// What a member checks before it believes a snapshot the gateway served.
//
// The gateway stores the manifests and packs and decides which is the head, but it
// is not trusted to say what a snapshot IS. Three checks, in the order they run:
//
//  1. The seal. A manifest made by a publisher that has this module carries a tag
//     (`manifest.seal`) over the fleet, sequence, parent, commit, tree, the hash of
//     each sealed pack and the rest (`SealFields`). Only a holder of the snapshot key
//     can make it, and the snapshot key is only given to members. An old snapshot
//     shown under a newer sequence, a manifest whose tree was swapped, a pack from
//     another snapshot: none match.
//  2. The sender. The key the snapshot was wrapped with must be one the roster lists
//     (or listed when this member last looked). Otherwise the gateway could make a
//     key pair of its own, wrap a snapshot key of its own for each member, and have
//     its forgery seal itself.
//  3. No downgrade. Once a snapshot with a seal has been taken in for this fleet, a
//     snapshot with none at or above the LOWEST sealed sequence taken in is refused:
//     the gateway could otherwise pass an old snapshot of a publisher that predates
//     seals off as new. The bound is only recorded for a snapshot that was taken in,
//     in order (never for one that was merely downloaded ahead of the others), and is
//     the lowest, so a snapshot cannot be slipped in below a later one's sequence.
//
// What this does not do is told in docs/fleets.md ("What the gateway can still do").

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { SEAL_PREFIX, type OpenedPayload, type SealFields } from "./fleet-crypto";
import { fetchRosterKeys, payloadHash, type FleetCredentials, type FleetManifest } from "./fleet-transport";

/** A snapshot that is not what its manifest says it is, or is not from a member. */
export class TamperedSnapshotError extends Error {
  constructor(
    readonly seq: number,
    reason: string,
    /**
     * Whether a route that goes around this snapshot (a later whole tree) is still
     * safe to take: true for a snapshot that is not wrong in itself but is not one
     * to build on (an old member's, or a member that has since left), false for one
     * whose manifest or pack does not match what its publisher sealed.
     */
    readonly skippable = false,
  ) {
    super("snapshot " + seq + " was refused: " + reason);
  }
}

/** What this member has learnt about who and what to trust in one fleet. */
export class FleetTrust {
  /**
   * The lowest sequence of a sealed snapshot this member has taken in; undefined while
   * it has taken in none. A snapshot without a seal at or above it is refused.
   */
  sealedFrom: number | undefined;
  /** The public keys that were on the roster when it was last read. */
  readonly peers = new Set<string>();
  private dirty = false;

  constructor(private readonly file: string) {
    this.merge(this.read());
  }

  private read(): { sealedFrom?: number; peers: string[] } {
    try {
      if (!existsSync(this.file)) return { peers: [] };
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { sealedFrom?: unknown; boundSeq?: unknown; peers?: unknown };
      // `boundSeq` is what an earlier build wrote (the highest one seen): the nearest thing it knew.
      const from = typeof raw.sealedFrom === "number" ? raw.sealedFrom : raw.boundSeq;
      return {
        ...(typeof from === "number" && from >= 0 ? { sealedFrom: from } : {}),
        peers: Array.isArray(raw.peers) ? raw.peers.filter((p): p is string => typeof p === "string") : [],
      };
    } catch {
      // A file that cannot be read is no knowledge, which only makes the checks
      // that depend on it (the downgrade guard) wait to be learnt again.
      return { peers: [] };
    }
  }

  private merge(other: { sealedFrom?: number; peers: string[] }): void {
    if (other.sealedFrom !== undefined && (this.sealedFrom === undefined || other.sealedFrom < this.sealedFrom)) this.sealedFrom = other.sealedFrom;
    for (const p of other.peers) this.peers.add(p);
  }

  /** Remember that a snapshot with a seal was taken in at `seq`. */
  noteSealed(seq: number): void {
    if (this.sealedFrom === undefined || seq < this.sealedFrom) {
      this.sealedFrom = seq;
      this.dirty = true;
    }
  }

  /**
   * Refuse a snapshot without a seal that is at or above the lowest sealed one taken in.
   * Called when a snapshot is about to be taken in, in order: not while packs are being
   * downloaded side by side.
   */
  checkNotDowngrade(m: FleetManifest): void {
    if (m.seal === undefined && this.sealedFrom !== undefined && m.seq >= this.sealedFrom) {
      throw new TamperedSnapshotError(
        m.seq,
        "it carries no seal, but snapshot " +
          this.sealedFrom +
          " did: either the gateway swapped in an old snapshot, or a member that has not been upgraded published it. Upgrade that member; if it is gone and nobody else can take over, run 'prime fleets trust reset <fleet> --space <space>' on this member to accept it",
        true,
      );
    }
  }

  /** A snapshot has been taken in: what it showed is now known of this fleet. */
  noteTakenIn(m: FleetManifest): void {
    if (m.seal !== undefined) this.noteSealed(m.seq);
  }

  /** Write what has been learnt, merged with what another process wrote meanwhile. */
  save(): void {
    if (!this.dirty) return;
    this.merge(this.read());
    this.write();
    this.dirty = false;
  }

  private write(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + "." + process.pid + ".tmp";
    writeFileSync(tmp, JSON.stringify({ ...(this.sealedFrom !== undefined ? { sealedFrom: this.sealedFrom } : {}), peers: [...this.peers].sort() }) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /**
   * Forget that this fleet has shown seals, so that a snapshot without one is taken again
   * (until the next sealed one is). It is for the operator to ask for when the member that
   * published without a seal is gone and the fleet cannot go on without taking its snapshot.
   * What the roster's keys are is kept. Returns what the bound was.
   */
  static reset(keyFile: string): number | undefined {
    const trust = FleetTrust.beside(keyFile);
    const was = trust.sealedFrom;
    trust.sealedFrom = undefined;
    trust.write();
    return was;
  }

  /** Where this member keeps it, beside its key file. */
  static beside(keyFile: string): FleetTrust {
    return new FleetTrust(keyFile + ".trust.json");
  }

  private reading: Promise<void> | undefined;

  /** Read the roster's keys and keep them (packs are opened side by side: they share one read). */
  refreshPeers(creds: FleetCredentials, fleet: string): Promise<void> {
    this.reading ??= (async () => {
      try {
        for (const key of await fetchRosterKeys(creds, fleet)) {
          if (!this.peers.has(key)) {
            this.peers.add(key);
            this.dirty = true;
          }
        }
        this.save();
      } finally {
        this.reading = undefined;
      }
    })();
    return this.reading;
  }
}

/** The fields a manifest's seal is made over. `packHash` is the hash of the sealed main pack. */
export function sealFieldsOf(m: FleetManifest, packHash: string, deltaHash: string | null): SealFields {
  return {
    fleet: m.fleet,
    seq: m.seq,
    parentSeq: m.parentSeq ?? null,
    parentManifest: m.parentManifest ?? null,
    tipCommit: m.tipCommit,
    tree: m.tree,
    full: m.full,
    packHash,
    deltaHash,
    senderPublicKey: m.senderPublicKey,
    roster: m.roster ?? null,
  };
}

/**
 * Check a snapshot whose pack has been opened.
 *
 * `fleet` is the fleet this member is syncing: a snapshot of another fleet, even a
 * perfectly sealed one, is not this fleet's. `sealed` is the pack as it came
 * (before it was opened), `usesDelta` says which of the manifest's packs it is.
 * Throws `TamperedSnapshotError`; a failure to read the roster is the transport's
 * error and is retried like any other. Whether a snapshot may be taken in after the
 * ones before it (the downgrade guard) is asked in order, by `FleetTrust.checkNotDowngrade`.
 */
export async function verifySnapshot(
  creds: FleetCredentials,
  fleet: string,
  m: FleetManifest,
  sealed: Buffer,
  usesDelta: boolean,
  opened: OpenedPayload,
  trust: FleetTrust | undefined,
): Promise<void> {
  if (m.fleet !== fleet) throw new TamperedSnapshotError(m.seq, "it belongs to fleet " + m.fleet + ", not " + fleet);

  if (m.seal !== undefined) {
    if (!m.seal.startsWith(SEAL_PREFIX)) throw new TamperedSnapshotError(m.seq, "its seal is of a kind this version does not know");
    const fields = sealFieldsOf(m, m.packHash, m.delta?.packHash ?? null);
    if (!opened.sealMatches(fields, m.seal)) {
      throw new TamperedSnapshotError(m.seq, "its manifest does not match what its publisher sealed (the sequence, parent, commit, tree or packs were changed, or it is another snapshot)");
    }
    const expected = usesDelta ? m.delta?.packHash : m.packHash;
    if (expected === undefined || payloadHash(sealed) !== expected) {
      throw new TamperedSnapshotError(m.seq, "the pack is not the one its publisher sealed");
    }
  }

  if (trust) {
    if (!trust.peers.has(m.senderPublicKey)) await trust.refreshPeers(creds, fleet);
    if (!trust.peers.has(m.senderPublicKey)) {
      throw new TamperedSnapshotError(m.seq, "it was sealed with a key that is not any member's: the gateway cannot make a snapshot, only a member can", true);
    }
  }
}
