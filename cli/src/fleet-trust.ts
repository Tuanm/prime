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
//  3. No downgrade. Once a snapshot with a seal has been seen for this fleet, a
//     snapshot with none and a higher sequence is refused: the gateway could
//     otherwise pass an old snapshot of a publisher that predates seals off as new.
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
  ) {
    super("snapshot " + seq + " was refused: " + reason);
  }
}

/** What this member has learnt about who and what to trust in one fleet. */
export class FleetTrust {
  /** The highest sequence seen with a seal; undefined while none has been. */
  boundSeq: number | undefined;
  /** The public keys that were on the roster when it was last read. */
  readonly peers = new Set<string>();
  private dirty = false;

  constructor(private readonly file: string) {
    this.merge(this.read());
  }

  private read(): { boundSeq?: number; peers: string[] } {
    try {
      if (!existsSync(this.file)) return { peers: [] };
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { boundSeq?: unknown; peers?: unknown };
      return {
        ...(typeof raw.boundSeq === "number" && raw.boundSeq >= 0 ? { boundSeq: raw.boundSeq } : {}),
        peers: Array.isArray(raw.peers) ? raw.peers.filter((p): p is string => typeof p === "string") : [],
      };
    } catch {
      // A file that cannot be read is no knowledge, which only makes the checks
      // that depend on it (the downgrade guard) wait to be learnt again.
      return { peers: [] };
    }
  }

  private merge(other: { boundSeq?: number; peers: string[] }): void {
    if (other.boundSeq !== undefined && (this.boundSeq === undefined || other.boundSeq > this.boundSeq)) this.boundSeq = other.boundSeq;
    for (const p of other.peers) this.peers.add(p);
  }

  /** Remember that a snapshot with a seal was seen at `seq`. */
  noteBound(seq: number): void {
    if (this.boundSeq === undefined || seq > this.boundSeq) {
      this.boundSeq = seq;
      this.dirty = true;
    }
  }

  /** Write what has been learnt, merged with what another process wrote meanwhile. */
  save(): void {
    if (!this.dirty) return;
    this.merge(this.read());
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + "." + process.pid + ".tmp";
    writeFileSync(tmp, JSON.stringify({ boundSeq: this.boundSeq, peers: [...this.peers].sort() }) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
    this.dirty = false;
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
 * error and is retried like any other.
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

  if (m.seal === undefined) {
    // A publisher that predates seals. Fine, unless this fleet has already shown it
    // has newer ones: then this is either a downgrade or an old member that took over.
    if (trust?.boundSeq !== undefined && m.seq > trust.boundSeq) {
      throw new TamperedSnapshotError(
        m.seq,
        "it carries no seal, but snapshot " + trust.boundSeq + " did: either the gateway swapped in an old snapshot, or a member that has not been upgraded published it (upgrade it)",
      );
    }
  } else {
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
      throw new TamperedSnapshotError(m.seq, "it was sealed with a key that is not any member's: the gateway cannot make a snapshot, only a member can");
    }
    if (m.seal !== undefined) {
      trust.noteBound(m.seq);
      trust.save();
    }
  }
}
