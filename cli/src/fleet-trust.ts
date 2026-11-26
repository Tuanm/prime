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

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { knownSealKind, type OpenedPayload, type SealFields } from "./fleet-crypto";
import { fetchRole, fetchRoster, manifestHashOf, payloadHash, type FleetCredentials, type FleetManifest } from "./fleet-transport";

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
  incarnation?: string;
  incarnationFrom?: number;
  accepted: string[];
  peers: Map<string, number>;
}

// Gateways that were asked which fleet of a name it is and said nothing (one that predates it): not
// asked again for a while, by anyone in this process - there would be nothing new to learn each time.
const saysNoIncarnation = new Map<string, number>();
const NO_INCARNATION_MS = 10 * 60_000;

/** Whether this gateway was found, lately, not to say which fleet of a name it is. */
export function gatewayHasNoIncarnation(creds: FleetCredentials, fleet: string): boolean {
  const until = saysNoIncarnation.get(creds.gateway + "\n" + fleet);
  return until !== undefined && until > Date.now();
}

/** Remember that this gateway did not say (or that it does, so it is asked as usual). */
export function noteIncarnationAnswer(creds: FleetCredentials, fleet: string, said: boolean): void {
  const key = creds.gateway + "\n" + fleet;
  if (said) saysNoIncarnation.delete(key);
  else saysNoIncarnation.set(key, Date.now() + NO_INCARNATION_MS);
}

/** Forget which gateways were found not to say (for a process that talks to a gateway that has since been upgraded, and for tests). */
export function forgetIncarnationAnswers(): void {
  saysNoIncarnation.clear();
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
  /** Which fleet of this name this member belongs to (see `ensureIncarnation`); undefined until it has learnt. */
  incarnation: string | undefined;
  /** The lowest sequence of a snapshot taken in that names its fleet's incarnation. */
  incarnationFrom: number | undefined;
  /**
   * Manifests (by hash) that the operator has said to take though they carry no seal. Each is one
   * snapshot: nothing else is let through by it, and no bound above is changed.
   */
  readonly accepted = new Set<string>();
  /**
   * The public keys the roster has listed, each with the highest sequence a roster that listed it
   * was read for (see `trusts`).
   */
  readonly peers = new Map<string, number>();
  private dirty = false;

  constructor(private readonly file: string) {
    this.merge(this.read());
  }

  private read(): TrustFile {
    const none: TrustFile = { peers: new Map(), accepted: [] };
    try {
      if (!existsSync(this.file)) return none;
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as {
        sealedFrom?: unknown;
        macFrom?: unknown;
        incarnation?: unknown;
        incarnationFrom?: unknown;
        accepted?: unknown;
        boundSeq?: unknown;
        peers?: unknown;
      };
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
        ...(typeof raw.incarnation === "string" && raw.incarnation ? { incarnation: raw.incarnation } : {}),
        ...(typeof raw.incarnationFrom === "number" && raw.incarnationFrom >= 0 ? { incarnationFrom: raw.incarnationFrom } : {}),
        accepted: Array.isArray(raw.accepted) ? raw.accepted.filter((h): h is string => typeof h === "string" && /^[0-9a-f]{64}$/.test(h)) : [],
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
    // What is on disk was learnt of the fleet this member is in: it fills in what is not known, never replaces it.
    this.incarnation ??= other.incarnation;
    if (other.incarnationFrom !== undefined && (this.incarnationFrom === undefined || other.incarnationFrom < this.incarnationFrom)) this.incarnationFrom = other.incarnationFrom;
    for (const hash of other.accepted) this.accepted.add(hash);
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
    const hash = manifestHashOf(m);
    // One manifest without a seal that the operator said to take: nothing else, and no other kind.
    if (m.seal === undefined && hash !== undefined && this.accepted.has(hash)) return;
    const level = protectionOf(m, memberId);
    if (level < 1 && this.sealedFrom !== undefined && m.seq >= this.sealedFrom) {
      // The one refusal that has an honest cause: a member of an old build that was promoted publishes this way.
      throw new TamperedSnapshotError(
        m.seq,
        "it carries no seal, but snapshot " +
          this.sealedFrom +
          " did: either the gateway swapped in an old snapshot, or a member that has not been upgraded published it. Upgrade that member. If it is gone and nobody else can take over, and you know this snapshot is the fleet's own" +
          (hash !== undefined ? " (manifest " + hash + ": compare it with what that member's own 'prime fleets status' says it published)" : "") +
          ", run 'prime fleets trust accept <fleet> --space <space> --manifest " +
          (hash ?? "<hash>") +
          "' on this member to take that one snapshot",
        true,
      );
    }
    // The others are not made by any build that was released: a snapshot with a seal and no tag for this
    // member, or none that names the fleet, after ones that had them, is made by someone who cannot make
    // them. There is nothing to accept.
    if (level < 2 && this.macFrom !== undefined && m.seq >= this.macFrom) {
      throw new TamperedSnapshotError(
        m.seq,
        "it carries no tag from its sender for this member, but snapshot " + this.macFrom + " did: it was not made by a member of this fleet (it is tampered with)",
        true,
      );
    }
    if (m.incarnation === undefined && this.incarnationFrom !== undefined && m.seq >= this.incarnationFrom) {
      throw new TamperedSnapshotError(
        m.seq,
        "it carries no mark of which fleet of this name it belongs to, but snapshot " + this.incarnationFrom + " did: it was not made by a member of this fleet (it is tampered with)",
        true,
      );
    }
  }

  /** A snapshot has been taken in: what it showed is now known of this fleet. */
  noteTakenIn(m: FleetManifest, memberId: string): void {
    const level = protectionOf(m, memberId);
    if (level >= 1) this.noteSealed(m.seq);
    if (level >= 2) this.noteMac(m.seq);
    if (m.incarnation !== undefined && (this.incarnationFrom === undefined || m.seq < this.incarnationFrom)) {
      this.incarnationFrom = m.seq;
      this.dirty = true;
    }
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
        ...(this.incarnation !== undefined ? { incarnation: this.incarnation } : {}),
        ...(this.incarnationFrom !== undefined ? { incarnationFrom: this.incarnationFrom } : {}),
        ...(this.accepted.size > 0 ? { accepted: [...this.accepted].slice(-16) } : {}),
        peers,
      }) + "\n",
      { mode: 0o600 },
    );
    renameSync(tmp, this.file);
  }

  /**
   * Take one snapshot that carries no seal, by the hash its manifest is stored under. It is for the
   * operator to ask for when the member that published it (an old build that was promoted) is gone and
   * the fleet cannot go on without it. Only that manifest is let through: no bound this member keeps
   * is lowered, so the next snapshot without a seal, a tag or a mark of the fleet is refused as before.
   * What is on disk is added to, never replaced, so an agent that saves at the same moment loses nothing.
   */
  static accept(keyFile: string, manifestHash: string): void {
    if (!/^[0-9a-f]{64}$/.test(manifestHash)) throw new Error("a manifest is named by its hash: 64 hexadecimal characters");
    const trust = FleetTrust.beside(keyFile);
    trust.accepted.add(manifestHash);
    trust.dirty = true;
    trust.save(); // merged with what is on disk now
  }

  /**
   * Forget everything learnt of a fleet: a member that joins starts as one that knows nothing, whatever
   * an earlier membership under the same name left beside its key (the key itself is kept).
   */
  static forget(keyFile: string): void {
    rmSync(keyFile + ".trust.json", { force: true });
  }

  /** Take `incarnation` as the fleet this member is in, if it has not learnt one (a publisher was just told by the gateway). */
  pin(incarnation: string | undefined): void {
    if (incarnation !== undefined && this.incarnation === undefined) {
      this.incarnation = incarnation;
      this.dirty = true;
    }
  }

  private learning: Promise<void> | undefined;

  /**
   * Learn which fleet of this name this member is in, from the gateway, the first time it is needed:
   * it is kept, and a snapshot that names another is refused (see `verifySnapshot`). A member joins
   * a fleet by name, and a fleet that is deleted frees its name, so the name alone does not say it.
   * Returns it, or undefined for a gateway that does not say.
   */
  async ensureIncarnation(creds: FleetCredentials, fleet: string): Promise<string | undefined> {
    if (this.incarnation !== undefined) return this.incarnation;
    if (gatewayHasNoIncarnation(creds, fleet)) return undefined;
    this.learning ??= (async () => {
      try {
        const role = await fetchRole(creds, fleet);
        if (role.member) noteIncarnationAnswer(creds, fleet, role.incarnation !== undefined);
        if (role.member && role.incarnation !== undefined) {
          this.incarnation = role.incarnation;
          this.dirty = true;
          this.save();
        }
      } finally {
        this.learning = undefined;
      }
    })();
    await this.learning;
    return this.incarnation;
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

  private roster: Promise<{ keys: Set<string>; left: Map<string, number> }> | undefined;

  /**
   * Make sure a snapshot at `seq` may be from `key`, reading the roster when what is kept does not
   * say so (packs are opened side by side, and a route is taken in one go: they share one read). A
   * key that is on the roster is known for the sequence of the snapshot that was checked with it, and
   * no further: nothing credits a key for snapshots that have not been looked at. A key that has left
   * is known up to where the fleet says the head was when it did.
   */
  async ensureTrusts(creds: FleetCredentials, fleet: string, key: string, seq: number): Promise<boolean> {
    if (this.trusts(key, seq)) return true;
    this.roster ??= fetchRoster(creds, fleet).then(
      ({ keys, left }) => ({ keys: new Set(keys), left: new Map(left.map((k) => [k.pubkey, k.until])) }),
      (err: unknown) => {
        this.roster = undefined; // not a roster: asked again next time
        throw err;
      },
    );
    const { keys, left } = await this.roster;
    const known = keys.has(key) ? seq : left.get(key);
    if (known !== undefined && known > (this.peers.get(key) ?? -1)) {
      this.peers.set(key, known);
      this.dirty = true;
      // A key that left and is older than anything the gateway still holds is of no use.
      for (const [k, at] of this.peers) {
        if (!keys.has(k) && !left.has(k) && at < seq - KEEP_LEFT_KEYS) this.peers.delete(k);
      }
      this.save();
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
    incarnation: m.incarnation ?? null,
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
  if (trust && m.seal !== undefined) {
    // A fleet that is deleted frees its name, and a snapshot of the one that had it is sealed and
    // sent by members all the same: which fleet of the name this member is in is what tells them apart.
    const mine = await trust.ensureIncarnation(creds, fleet);
    if (mine !== undefined && m.incarnation !== undefined && m.incarnation !== mine) {
      throw new TamperedSnapshotError(m.seq, "it belongs to an earlier fleet that had the name " + fleet + ", not to this one");
    }
  }

  if (m.seal !== undefined) {
    if (!knownSealKind(m.seal)) throw new TamperedSnapshotError(m.seq, "its seal is of a kind this version does not know");
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
