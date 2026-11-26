// What a member checks before it believes a snapshot the gateway served.
//
// The gateway stores the manifests and packs and decides which is the head, but it
// is not trusted to say what a snapshot IS. Four checks, in the order they run:
//
//  1. The seal. A manifest made by a publisher that has this module carries a tag
//     (`manifest.seal`) over the fleet, sequence, parent, commit, tree, the hash of
//     each sealed pack and the rest (`SealFields`). Only a holder of the snapshot key
//     can make it, and the snapshot key is only given to members. An old snapshot
//     shown under a newer sequence, a manifest whose tree was swapped, a pack from
//     another snapshot: none match. But every member that EVER held the snapshot key
//     can make it, a member that has since been removed among them.
//  2. The sender. Each member's entry of `wrapped` carries a tag (`mac`) over the same
//     fields made with the secret the sender and that member share (Diffie-Hellman of
//     their two keys). Only the sender, or that member, can make it: a removed member that
//     still holds an old snapshot key cannot put a current member's name on a snapshot.
//  3. The key. The key the snapshot was made with must be one the roster listed at the
//     snapshot's sequence or after: a key is kept with the highest sequence a roster that
//     listed it was read for, and a snapshot from it above that sequence makes the roster
//     be read again. A key that has left the roster is therefore accepted for the snapshots
//     it made while it was on it, and for no later one. Otherwise the gateway could make a
//     key pair of its own, wrap a snapshot key of its own for each member, and have its
//     forgery seal itself, and a removed member could go on publishing.
//  4. No downgrade. Once a snapshot with a seal (or with a sender's tag) has been taken in
//     for this fleet, a snapshot with none at or above the LOWEST such sequence taken in is
//     refused: the gateway could otherwise pass an old snapshot of a publisher that
//     predates them off as new. The bound is only recorded for a snapshot that was taken in,
//     in order (never for one that was merely downloaded ahead of the others), and is the
//     lowest, so a snapshot cannot be slipped in below a later one's sequence.
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

// How many snapshots back a key that has left the roster is kept: the gateway keeps no more.
const KEEP_LEFT_KEYS = 2 * 32 + 1;

/** How much protection a snapshot carries for this member: none, a seal, or a seal and its sender's own tag. */
function protectionOf(m: FleetManifest, memberId: string): 0 | 1 | 2 {
  if (m.seal === undefined) return 0;
  return m.wrapped.find((w) => w.memberId === memberId)?.mac !== undefined ? 2 : 1;
}

interface TrustFile {
  sealedFrom?: number;
  macFrom?: number;
  peers: Map<string, number>;
}

/** What this member has learnt about who and what to trust in one fleet. */
export class FleetTrust {
  /**
   * The lowest sequence of a sealed snapshot this member has taken in; undefined while
   * it has taken in none. A snapshot without a seal at or above it is refused.
   */
  sealedFrom: number | undefined;
  /** The same for a snapshot whose entry for this member carries its sender's own tag. */
  macFrom: number | undefined;
  /**
   * The public keys the roster has listed, each with the highest sequence a roster that listed it
   * was read for (see `trusts`).
   */
  readonly peers = new Map<string, number>();
  /** The newest sequence this member is about to take in: a roster read now stands for snapshots up to it. */
  horizon: number | undefined;
  private dirty = false;

  constructor(private readonly file: string) {
    this.merge(this.read());
  }

  private read(): TrustFile {
    const none: TrustFile = { peers: new Map() };
    try {
      if (!existsSync(this.file)) return none;
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { sealedFrom?: unknown; macFrom?: unknown; boundSeq?: unknown; peers?: unknown };
      // `boundSeq` is what an earlier build wrote (the highest one seen): the nearest thing it knew.
      const from = typeof raw.sealedFrom === "number" ? raw.sealedFrom : raw.boundSeq;
      const peers = new Map<string, number>();
      if (Array.isArray(raw.peers)) {
        // An earlier build kept a list of keys: none of them is known for any sequence, so the roster is read again for each.
        for (const key of raw.peers) if (typeof key === "string") peers.set(key, 0);
      } else if (raw.peers && typeof raw.peers === "object") {
        for (const [key, seq] of Object.entries(raw.peers)) if (typeof seq === "number" && seq >= 0) peers.set(key, seq);
      }
      return {
        ...(typeof from === "number" && from >= 0 ? { sealedFrom: from } : {}),
        ...(typeof raw.macFrom === "number" && raw.macFrom >= 0 ? { macFrom: raw.macFrom } : {}),
        peers,
      };
    } catch {
      // A file that cannot be read is no knowledge, which only makes the checks
      // that depend on it (the downgrade guard) wait to be learnt again.
      return none;
    }
  }

  private merge(other: TrustFile): void {
    if (other.sealedFrom !== undefined && (this.sealedFrom === undefined || other.sealedFrom < this.sealedFrom)) this.sealedFrom = other.sealedFrom;
    if (other.macFrom !== undefined && (this.macFrom === undefined || other.macFrom < this.macFrom)) this.macFrom = other.macFrom;
    for (const [key, seq] of other.peers) if (seq > (this.peers.get(key) ?? -1)) this.peers.set(key, seq);
  }

  /** Remember that a snapshot with a seal was taken in at `seq`. */
  noteSealed(seq: number): void {
    if (this.sealedFrom === undefined || seq < this.sealedFrom) {
      this.sealedFrom = seq;
      this.dirty = true;
    }
  }

  /** Remember that a snapshot with its sender's tag for this member was taken in at `seq`. */
  noteMac(seq: number): void {
    if (this.macFrom === undefined || seq < this.macFrom) {
      this.macFrom = seq;
      this.dirty = true;
    }
  }

  /**
   * Refuse a snapshot that carries less than one this member has taken in at or below its
   * sequence: no seal where there was one, or no sender's tag for this member where there was
   * one. Called when a snapshot is about to be taken in, in order: not while packs are being
   * downloaded side by side.
   */
  checkNotDowngrade(m: FleetManifest, memberId: string): void {
    const level = protectionOf(m, memberId);
    const what =
      level < 1 && this.sealedFrom !== undefined && m.seq >= this.sealedFrom
        ? "no seal, but snapshot " + this.sealedFrom + " did"
        : level < 2 && this.macFrom !== undefined && m.seq >= this.macFrom
          ? "no tag from its sender for this member, but snapshot " + this.macFrom + " did"
          : null;
    if (what === null) return;
    throw new TamperedSnapshotError(
      m.seq,
      "it carries " +
        what +
        ": either the gateway swapped in an old snapshot, or a member that has not been upgraded published it. Upgrade that member; if it is gone and nobody else can take over, run 'prime fleets trust reset <fleet> --space <space>' on this member to accept it",
      true,
    );
  }

  /** A snapshot has been taken in: what it showed is now known of this fleet. */
  noteTakenIn(m: FleetManifest, memberId: string): void {
    const level = protectionOf(m, memberId);
    if (level >= 1) this.noteSealed(m.seq);
    if (level >= 2) this.noteMac(m.seq);
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
    const peers: Record<string, number> = {};
    for (const key of [...this.peers.keys()].sort()) peers[key] = this.peers.get(key)!;
    writeFileSync(
      tmp,
      JSON.stringify({
        ...(this.sealedFrom !== undefined ? { sealedFrom: this.sealedFrom } : {}),
        ...(this.macFrom !== undefined ? { macFrom: this.macFrom } : {}),
        peers,
      }) + "\n",
      { mode: 0o600 },
    );
    renameSync(tmp, this.file);
  }

  /**
   * Forget that this fleet has shown seals, so that a snapshot without one is taken again
   * (until the next sealed one is). It is for the operator to ask for when the member that
   * published without a seal is gone and the fleet cannot go on without taking its snapshot.
   * What the roster's keys are is kept. Returns the lowest sealed sequence it had seen.
   */
  static reset(keyFile: string): number | undefined {
    const trust = FleetTrust.beside(keyFile);
    const was = trust.sealedFrom;
    trust.sealedFrom = undefined;
    trust.macFrom = undefined;
    trust.write();
    return was;
  }

  /** Where this member keeps it, beside its key file. */
  static beside(keyFile: string): FleetTrust {
    return new FleetTrust(keyFile + ".trust.json");
  }

  /** Whether a snapshot at `seq` may be from `key`: a roster that listed the key was read for a sequence that is not below it. */
  trusts(key: string, seq: number): boolean {
    const known = this.peers.get(key);
    return known !== undefined && seq <= known;
  }

  private reading: Promise<void> | undefined;
  private readFor = -1;

  /**
   * Make sure a snapshot at `seq` may be from `key`, reading the roster when what is kept does not
   * say so (packs are opened side by side: they share one read). The roster that is read lists
   * who is a member now, so each key on it is known for snapshots up to the newest this member is
   * taking in (`horizon`, or `seq`); a key that is not on it keeps what it had, and so is not
   * known for any later snapshot.
   */
  async ensureTrusts(creds: FleetCredentials, fleet: string, key: string, seq: number): Promise<boolean> {
    for (let round = 0; round < 3 && !this.trusts(key, seq); round++) {
      if (this.reading) {
        await this.reading;
        continue;
      }
      // What a roster read now stands for: only a roster read for this sequence or a later one settles it.
      const upTo = Math.max(this.horizon ?? 0, seq);
      if (this.readFor >= seq) break;
      this.reading = (async () => {
        try {
          const keys = await fetchRosterKeys(creds, fleet);
          for (const k of keys) {
            if (upTo > (this.peers.get(k) ?? -1)) {
              this.peers.set(k, upTo);
              this.dirty = true;
            }
          }
          // A key that left and is older than anything the gateway still holds is of no use.
          for (const [k, known] of this.peers) {
            if (!keys.includes(k) && known < upTo - KEEP_LEFT_KEYS) {
              this.peers.delete(k);
              this.dirty = true;
            }
          }
          this.readFor = upTo;
          this.save();
        } finally {
          this.reading = undefined;
        }
      })();
      await this.reading;
    }
    return this.trusts(key, seq);
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
    // The tag the sender made for this member alone: the seal cannot say who made it.
    if (opened.macMatches(fields) === false) {
      throw new TamperedSnapshotError(
        m.seq,
        "the tag its sender made for this member does not match: it was not made by the member whose key it names (a removed member that kept an old snapshot key, or the gateway)",
      );
    }
    const expected = usesDelta ? m.delta?.packHash : m.packHash;
    if (expected === undefined || payloadHash(sealed) !== expected) {
      throw new TamperedSnapshotError(m.seq, "the pack is not the one its publisher sealed");
    }
  }

  if (trust && !(await trust.ensureTrusts(creds, fleet, m.senderPublicKey, m.seq))) {
    throw new TamperedSnapshotError(
      m.seq,
      "it was made with a key that is not any member's (or is no longer one, for a snapshot this late): the gateway cannot make a snapshot, only a member can",
      true,
    );
  }
}
