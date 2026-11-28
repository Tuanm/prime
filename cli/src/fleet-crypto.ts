// Per-member content encryption for fleet snapshots.
//
// Every member holds an X25519 key pair. The primary seals a snapshot with a
// random key and wraps that key separately for each member, using the
// shared secret the member's public key derives. The gateway stores the
// ciphertext and the wrapped keys, and can open neither: it never sees a
// member's private key.
//
// The sender's public key travels with the snapshot, because a receiver
// derives the same shared secret from its own private key and the sender's
// public key.
//
// Why this and not a shared fleet secret: with one shared secret, every
// member can read every snapshot even after it is removed, and handing the
// secret to a new member means re-encrypting the history for it. With a
// key per member, removal is immediate and joining costs nothing.

import { createCipheriv, createDecipheriv, createHash, createHmac, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, createPublicKey, createPrivateKey, timingSafeEqual } from "node:crypto";

export interface MemberKeyPair {
  /** base64 of the raw 32 byte public key. */
  publicKey: string;
  /** PEM of the private key, for the local key file. */
  privateKey: string;
  /**
   * The pair this one replaced, while snapshots sealed for it may still be waiting to be opened (see `rotateKeyPair`).
   * Only the key file has it; it is tried when the current key does not open a snapshot.
   */
  previous?: MemberKeyPair;
  /** The member's signing key (see `loadOrCreateSignKey`); made when it is first needed, and kept across rotations of the pair. */
  sign?: MemberSignKey;
  /**
   * The epoch keys this member holds (see `EpochKey`), oldest first. A snapshot can be wrapped to one of them rather than to the
   * pair above, and deleting an epoch's private half is what makes the snapshots wrapped to it unreadable from this file.
   */
  epochs?: EpochKey[];
}

/**
 * An X25519 pair a member makes every day or so and publishes (signed with its signing key) for the primary to wrap snapshot keys to.
 * Its private half is deleted once the member has taken in a snapshot wrapped to a newer one, so a copy of the key file taken later
 * opens only the snapshots of the epochs still on disk, not every snapshot the gateway still holds.
 */
export interface EpochKey {
  /** Counts up from 1 and never repeats for a member of a fleet. */
  n: number;
  /** base64 of the raw 32 byte public key. */
  publicKey: string;
  /** PEM of the private key. */
  privateKey: string;
  createdAt: number;
  /** The signing key (its public half) the fleet took this key under: a key not posted, or posted under a signing key since replaced, is posted again. */
  posted?: string;
  /** When a snapshot wrapped to a newer epoch was taken in: the private half is deleted a little after (see `pruneEpochs`). */
  supersededAt?: number;
}

/** A new epoch key. */
export function generateEpochKey(n: number, now: number = Date.now()): EpochKey {
  const pair = generateMemberKeyPair();
  return { n, publicKey: pair.publicKey, privateKey: pair.privateKey, createdAt: now };
}

/** The Ed25519 key a member signs with: its roster entries (rotate-self), its witness checkpoints, its calls. */
export interface MemberSignKey {
  /** base64url of the raw 32 byte public key: the `spub` the fleet's roster names. */
  publicKey: string;
  /** PEM (PKCS#8) of the private key. */
  privateKey: string;
}

const CURVE = "x25519";
const INFO = Buffer.from("prime-fleet-content-v1");

/** Generate a key pair for one member. */
export function generateMemberKeyPair(): MemberKeyPair {
  const pair = generateKeyPairSync(CURVE);
  return {
    publicKey: publicKeyBytes(pair.publicKey).toString("base64"),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** The raw 32 bytes of an X25519 public key. */
export function publicKeyBytes(key: { export(...args: never[]): Buffer }): Buffer {
  const der = key.export({ type: "spki", format: "der" } as never) as Buffer;
  // A SPKI X25519 key is a fixed 12 byte prefix followed by the raw key.
  return der.subarray(der.length - 32);
}

/** Rebuild a public key object from its raw bytes. */
function publicKeyFromRaw(raw: Buffer): ReturnType<typeof createPublicKey> {
  const prefix = Buffer.from("302a300506032b656e032100", "hex");
  return createPublicKey({ key: Buffer.concat([prefix, raw]), format: "der", type: "spki" });
}

/** The shared secret two keys derive, run through HKDF. */
function sharedSecret(privateKeyPem: string, peerPublicKeyB64: string): Buffer {
  const priv = createPrivateKey({ key: privateKeyPem, format: "pem", type: "pkcs8" });
  const peer = publicKeyFromRaw(Buffer.from(peerPublicKeyB64, "base64"));
  const secret = diffieHellman({ privateKey: priv, publicKey: peer });
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(32), INFO, 32));
}

const WRAP_V2_INFO = Buffer.from("prime-fleet-wrap-v2");

/**
 * The key a snapshot key is wrapped under for an epoch key: the secret the sender's ephemeral key shares with it and the secret the sender's
 * long-term key shares with it, together. The first is what a later theft of the sender's key file cannot give back (the ephemeral
 * private half is not kept); the second says who wrapped it.
 */
function epochWrapKey(epochPublicB64: string, ephemeralPrivatePem: string, senderPrivatePem: string): Buffer {
  const peer = publicKeyFromRaw(Buffer.from(epochPublicB64, "base64"));
  const a = diffieHellman({ privateKey: createPrivateKey({ key: ephemeralPrivatePem, format: "pem", type: "pkcs8" }), publicKey: peer });
  const b = diffieHellman({ privateKey: createPrivateKey({ key: senderPrivatePem, format: "pem", type: "pkcs8" }), publicKey: peer });
  return Buffer.from(hkdfSync("sha256", Buffer.concat([a, b]), Buffer.alloc(32), WRAP_V2_INFO, 32));
}

/** The same key, from the other end: the epoch's private half, the ephemeral public key, and the sender's long-term public key. */
function epochUnwrapKey(epochPrivatePem: string, ephemeralPublicB64: string, senderPublicB64: string): Buffer {
  const priv = createPrivateKey({ key: epochPrivatePem, format: "pem", type: "pkcs8" });
  const a = diffieHellman({ privateKey: priv, publicKey: publicKeyFromRaw(Buffer.from(ephemeralPublicB64, "base64")) });
  const b = diffieHellman({ privateKey: priv, publicKey: publicKeyFromRaw(Buffer.from(senderPublicB64, "base64")) });
  return Buffer.from(hkdfSync("sha256", Buffer.concat([a, b]), Buffer.alloc(32), WRAP_V2_INFO, 32));
}

export interface WrappedKey {
  /** The member this key is for. */
  memberId: string;
  /**
   * Which of the member's keys it was wrapped for: a short fingerprint. A member
   * that came back with a new key has the same id and cannot open what was
   * wrapped for the old one. Absent in snapshots from older publishers.
   */
  keyId?: string;
  /** base64 of the sealed snapshot key. */
  wrapped: string;
  /**
   * The epoch key of the member this entry is wrapped to (see `EpochKey`), when it is: the key is then unwrapped with the
   * epoch's private half and the manifest's `epk`, not with the member's long-term key. The entry's `keyId` and `mac` are the
   * long-term key's all the same, so who made the snapshot is checked as it always was.
   */
  epoch?: number;
  /**
   * A tag over the manifest's seal fields made with a key only the sender and this member can
   * derive (their Diffie-Hellman secret): what the seal cannot say, which is that the sender
   * is the one that made it. Every member that ever held the snapshot key can make the seal; only
   * this one and the sender can make this. Absent from snapshots of older publishers.
   */
  mac?: string;
}

/** The label that separates a key-change proof from every other use of a key; the gateway's copy is `KEY_PROOF_INFO` in api/src/fleets.ts. */
const KEY_PROOF_INFO = "prime-fleet-key-change-v1";

/** What a key-change proof is a MAC of (the same as `keyChangeMessage` in api/src/fleets.ts: a JSON array, so no field runs into the next). */
export function keyChangeMessage(newPubkey: string, fleet: string, deviceId: string, ts: number, nonce: string): string {
  return JSON.stringify([KEY_PROOF_INFO, newPubkey, fleet, deviceId, ts, nonce]);
}

export interface KeyProof {
  ts: number;
  nonce: string;
  mac: string;
}

/**
 * Show the fleet that this member holds the key it has now (`oldPrivateKey`), when it asks for another one.
 *
 * The fleet object has an X25519 key pair of its own (`objectPublicKey`, which `/role` gives). The tag is
 * an HMAC under the Diffie-Hellman secret of the old private key and the object's public key, over the new
 * key, the fleet, the device, a time and a nonce: only a holder of the old private key can make it, and it
 * is no use for any other key, fleet, device or moment. A device's token alone is not enough to change a
 * key; this is what is.
 */
export function proveKeyChange(
  oldPrivateKeyPem: string,
  objectPublicKey: string,
  newPubkey: string,
  fleet: string,
  deviceId: string,
  now: number = Date.now(),
): KeyProof {
  const priv = createPrivateKey({ key: oldPrivateKeyPem, format: "pem", type: "pkcs8" });
  const peer = publicKeyFromRaw(Buffer.from(objectPublicKey, "base64"));
  const secret = diffieHellman({ privateKey: priv, publicKey: peer });
  const macKey = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(32), Buffer.from(KEY_PROOF_INFO), 32));
  const nonce = randomBytes(16).toString("base64");
  const mac = createHmac("sha256", macKey).update(keyChangeMessage(newPubkey, fleet, deviceId, now, nonce)).digest("base64");
  return { ts: now, nonce, mac };
}

/**
 * A short id of a member's public key (base64), to tell its keys apart: the first eight bytes of its SHA-256.
 *
 * It is what a snapshot's `wrapped[].keyId` says (members match on it, and every build that has published
 * says it this way), so it does not change. What a person compares is `keyFingerprintOf`.
 */
export function keyIdOf(publicKeyB64: string): string {
  return createHash("sha256").update(Buffer.from(publicKeyB64, "base64")).digest().subarray(0, 8).toString("base64");
}

/**
 * The fingerprint of a member's public key (base64) that a person compares with what another machine prints:
 * the first sixteen bytes (128 bits) of its SHA-256, as two halves of base64 with the padding left off,
 * joined by a dot.
 *
 * The first half is exactly the id earlier builds printed (their `keyIdOf`, without its "="), so a member
 * on an earlier build can still be compared with, by its first half; two machines of this build compare
 * both. Eight bytes were what a key-grinding gateway needed about 2^64 work to match; sixteen are 2^128.
 */
export function keyFingerprintOf(publicKeyB64: string): string {
  const digest = createHash("sha256").update(Buffer.from(publicKeyB64, "base64")).digest();
  const half = (from: number): string => digest.subarray(from, from + 8).toString("base64").replace(/=+$/, "");
  return half(0) + "." + half(8);
}

export interface SealedForMembers {
  /** The sealed payload. */
  ciphertext: Buffer;
  /** The snapshot key, wrapped for each member that offered a public key. */
  wrapped: WrappedKey[];
  /** The sender's own public key, so a receiver can derive the shared secret. */
  senderPublicKey: string;
}

export interface SealedManyForMembers {
  /** The sealed payloads, in the order given; each has its own nonce. */
  ciphertexts: Buffer[];
  wrapped: WrappedKey[];
  senderPublicKey: string;
  /** The ephemeral public key the entries wrapped to an epoch key were wrapped with (the manifest's `epk`); absent when there are none. */
  epk?: string;
  /**
   * The seal of a manifest: a tag only a holder of this snapshot key can make
   * (see `SealFields`). It travels in the manifest. Sealing also puts each member's own
   * tag (`WrappedKey.mac`) on its entry of `wrapped`, which is why it is called once the
   * fields are known and before the manifest is stored.
   */
  seal(fields: SealFields): string;
  /** The metadata of the manifest, sealed with a key derived from the snapshot key (see `SnapshotMeta`). */
  sealMeta(binding: MetaBinding, meta: SnapshotMeta): string;
}

/**
 * What a seal binds, so that the manifest the gateway stores and serves cannot
 * be edited, and a snapshot cannot be shown under another place in the chain.
 *
 * The packs' own encryption (AES-GCM under the snapshot key) already says their
 * bytes are the publisher's; it says nothing about which snapshot they are. The
 * seal does: the fleet, the sequence, the snapshot it follows (by the hash its
 * manifest is stored under), the commit and tree, whether the pack is a whole tree,
 * the hash of each sealed pack, who it is sealed by and for. Sizes (`packBytes`) are not
 * bound: they only steer the choice of route, and a lie costs bandwidth, not
 * content.
 */
export interface SealFields {
  fleet: string;
  seq: number;
  parentSeq: number | null;
  parentManifest: string | null;
  tipCommit: string;
  tree: string;
  full: boolean;
  /** sha256 of the sealed main pack. */
  packHash: string;
  /** sha256 of the sealed change pack that travels beside a whole tree, if any. */
  deltaHash: string | null;
  senderPublicKey: string;
  roster: string | null;
  /** Which fleet of this name it is; null from a publisher that does not know. */
  incarnation: string | null;
}

/**
 * What a snapshot's sealed metadata holds: the facts of the snapshot that the gateway has no need
 * to read (see `FleetManifest.meta`). `tipCommit` and `tree` are what the seal binds; `roster` is who
 * the snapshot is sealed for; `actor` and `kept` are filled by what produces them and opaque here.
 */
export interface SnapshotMeta {
  tipCommit: string;
  tree: string;
  roster?: string;
  actor?: unknown;
  kept?: unknown;
}

/**
 * Which manifest a sealed metadata belongs to: the parts of the manifest it does not itself hold. It is
 * the associated data of the encryption, so metadata moved to another manifest (another sequence, parent,
 * pack, sender or fleet of the name) does not open. (The seal that follows binds the metadata's own contents.)
 */
export interface MetaBinding {
  fleet: string;
  seq: number;
  parentSeq: number | null;
  parentManifest: string | null;
  full: boolean;
  /** sha256 of the sealed main pack. */
  packHash: string;
  deltaHash: string | null;
  senderPublicKey: string;
  incarnation: string | null;
}

const META_INFO = Buffer.from("prime-fleet-meta-v1");
/** The most a sealed metadata may be when opened, in bytes of plaintext: a manifest's metadata is a few hundred. */
const META_MAX_BYTES = 64 * 1024;

function metaKeyOf(snapshotKey: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", snapshotKey, Buffer.alloc(32), META_INFO, 32));
}

function metaAad(b: MetaBinding): Buffer {
  return createHash("sha256")
    .update(JSON.stringify(["prime-fleet-meta-v1", b.fleet, b.seq, b.parentSeq, b.parentManifest, b.full, b.packHash, b.deltaHash, b.senderPublicKey, b.incarnation]), "utf8")
    .digest();
}

function sealMetaWith(snapshotKey: Buffer, binding: MetaBinding, meta: SnapshotMeta): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", metaKeyOf(snapshotKey), iv);
  cipher.setAAD(metaAad(binding));
  const body = Buffer.concat([cipher.update(fitMeta(meta)), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64");
}

/**
 * The metadata as the bytes that are sealed. What a reader would refuse for its size (`META_MAX_BYTES`) is not sealed: the optional
 * parts (what was left out as secrets, which can be long, then what ran) go before the snapshot does, since a snapshot nobody can read is worse than one that says less.
 */
function fitMeta(meta: SnapshotMeta): Buffer {
  let bytes = Buffer.from(JSON.stringify(meta), "utf8");
  for (const drop of ["kept", "actor"] as const) {
    if (bytes.length <= META_MAX_BYTES) break;
    const { [drop]: _dropped, ...rest } = meta;
    meta = rest as SnapshotMeta;
    bytes = Buffer.from(JSON.stringify(meta), "utf8");
  }
  if (bytes.length > META_MAX_BYTES) throw new Error("the snapshot's sealed metadata is " + bytes.length + " bytes, and a member reads at most " + META_MAX_BYTES);
  return bytes;
}

function openMetaWith(snapshotKey: Buffer, binding: MetaBinding, blob: string): SnapshotMeta | null {
  const raw = Buffer.from(blob, "base64");
  if (raw.length < 12 + 16 || raw.length > META_MAX_BYTES + 12 + 16) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", metaKeyOf(snapshotKey), raw.subarray(0, 12));
    decipher.setAAD(metaAad(binding));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const parsed = JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8")) as Partial<SnapshotMeta> | null;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.tipCommit !== "string" || typeof parsed.tree !== "string") return null;
    if (parsed.roster !== undefined && typeof parsed.roster !== "string") return null;
    return parsed as SnapshotMeta;
  } catch {
    return null;
  }
}

/**
 * The id a snapshot lists a member under when it does not list device ids (phase two of sealed
 * metadata): a hash of the fleet's incarnation and the device id, cut to 22 characters (132 bits). The
 * incarnation is in it so the same device has a different id in another fleet of the name, and the
 * hash so that a manifest read in storage does not name devices. A member finds its entry by this or by its device id.
 */
export function wrapIdOf(incarnation: string | undefined, deviceId: string): string {
  return createHash("sha256").update(JSON.stringify(["prime-fleet-mid-v1", incarnation ?? "", deviceId]), "utf8").digest("base64url").slice(0, 22);
}

/** This member's entry of a snapshot's wrapped keys, listed under its device id or under `wrapIdOf`. */
export function wrappedEntryFor<T extends { memberId: string }>(wrapped: T[], deviceId: string, incarnation: string | undefined): T | undefined {
  const id = wrapIdOf(incarnation, deviceId);
  return wrapped.find((w) => w.memberId === deviceId) ?? wrapped.find((w) => w.memberId === id);
}

const SEAL_INFO = Buffer.from("prime-fleet-seal-v1");
const MAC_INFO = Buffer.from("prime-fleet-seal-v2");
export const SEAL_PREFIX = "v1:";
/**
 * What a seal that covers the fleet's incarnation starts with. The bytes it is made over have one
 * more element, so an earlier build that checks it would call it a manifest that was changed; with a
 * prefix of its own that build says what it is: a kind it does not know.
 */
export const SEAL_PREFIX_INCARNATION = "v2:";

/** Whether a seal is of a kind this version knows. */
export function knownSealKind(seal: string): boolean {
  return seal.startsWith(SEAL_PREFIX) || seal.startsWith(SEAL_PREFIX_INCARNATION);
}

// The key that seals manifests is derived from the snapshot key, not the snapshot
// key itself, so a tag reveals nothing about the key that opens the packs.
function sealKeyOf(snapshotKey: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", snapshotKey, Buffer.alloc(32), SEAL_INFO, 32));
}

function sealBytes(f: SealFields): Buffer {
  // A fixed order and no optional keys: the same fields always give the same bytes.
  // The incarnation is appended only when there is one, so what a publisher that has none seals is what it always was.
  return Buffer.from(
    JSON.stringify([
      "prime-fleet-seal-v1",
      f.fleet,
      f.seq,
      f.parentSeq,
      f.parentManifest,
      f.tipCommit,
      f.tree,
      f.full,
      f.packHash,
      f.deltaHash,
      f.senderPublicKey,
      f.roster,
      ...(f.incarnation !== null ? [f.incarnation] : []),
    ]),
    "utf8",
  );
}

function tagOf(sealKey: Buffer, fields: SealFields): string {
  return (fields.incarnation !== null ? SEAL_PREFIX_INCARNATION : SEAL_PREFIX) + createHmac("sha256", sealKey).update(sealBytes(fields)).digest("base64");
}

// What the sender and one member tag the seal fields with, from the secret the two of them share.
// (The wrap key is already that secret run through HKDF; this is a key of its own from it.)
function macKeyOf(wrapKey: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", wrapKey, Buffer.alloc(32), MAC_INFO, 32));
}

function macOf(macKey: Buffer, memberId: string, fields: SealFields): string {
  const digest = createHash("sha256").update(sealBytes(fields)).digest();
  return createHmac("sha256", macKey).update(MAC_INFO).update(Buffer.from(JSON.stringify(memberId), "utf8")).update(digest).digest("base64");
}

function sameBase64(expected: string, got: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(got, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function tagMatches(sealKey: Buffer, fields: SealFields, tag: string): boolean {
  const got = Buffer.from(tag, "utf8");
  const same = (expected: string): boolean => {
    const want = Buffer.from(expected, "utf8");
    return want.length === got.length && timingSafeEqual(want, got);
  };
  // A seal that covers the incarnation is read under either prefix: the bytes it is made over say
  // what it covers, and an earlier test build (27c7c10) wrote `v1:` for it. The prefix is for a
  // build that cannot check it to say so; what is signed does not depend on it.
  if (fields.incarnation !== null) {
    const body = createHmac("sha256", sealKey).update(sealBytes(fields)).digest("base64");
    return same(SEAL_PREFIX_INCARNATION + body) || same(SEAL_PREFIX + body);
  }
  return same(tagOf(sealKey, fields));
}

/** A payload opened, with what it takes to check the manifest that named it. */
export interface OpenedPayload {
  plain: Buffer;
  /** Whether `tag` is the seal of exactly these fields, made by a holder of the snapshot key. */
  sealMatches(fields: SealFields, tag: string): boolean;
  /**
   * Whether this member's entry carries the tag only the sender could make for it over exactly
   * these fields: true or false, or null when the entry has none (a publisher that predates it).
   */
  macMatches(fields: SealFields): boolean | null;
  /** The manifest's sealed metadata, or null when it does not open for this manifest (damaged, or from another). */
  openMeta(binding: MetaBinding, blob: string): SnapshotMeta | null;
}

/**
 * Seal several payloads of one snapshot with one fresh random key, and wrap
 * that key for each member.
 *
 * The payloads are different encodings of the same snapshot (the whole tree and
 * the change since the one before), so a member opens whichever it fetches with
 * the key it was given. Every payload has a nonce of its own.
 */
export function sealManyForMembers(
  plains: Buffer[],
  members: Array<{ memberId: string; publicKey?: string; epoch?: { n: number; publicKey: string } }>,
  senderPrivateKeyPem: string,
  senderPublicKeyB64: string,
): SealedManyForMembers {
  const snapshotKey = randomBytes(32);
  // One ephemeral key for the entries that are wrapped to an epoch key, made only when there is one.
  const ephemeral = members.some((m) => m.publicKey && m.epoch) ? generateMemberKeyPair() : undefined;
  const ciphertexts = plains.map((plain) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", snapshotKey, iv);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([iv, body, cipher.getAuthTag()]);
  });

  const wrapped: WrappedKey[] = [];
  const macKeys: Array<{ entry: WrappedKey; key: Buffer }> = [];
  for (const member of members) {
    if (!member.publicKey) continue;
    const wrapKey = sharedSecret(senderPrivateKeyPem, member.publicKey);
    const wrapIv = randomBytes(12);
    // The tag that says who made the snapshot is the long-term key's either way; only what the snapshot key is wrapped under changes.
    const wrapper = createCipheriv("aes-256-gcm", member.epoch && ephemeral ? epochWrapKey(member.epoch.publicKey, ephemeral.privateKey, senderPrivateKeyPem) : wrapKey, wrapIv);
    const sealed = Buffer.concat([wrapper.update(snapshotKey), wrapper.final()]);
    const entry: WrappedKey = {
      memberId: member.memberId,
      keyId: keyIdOf(member.publicKey),
      wrapped: Buffer.concat([wrapIv, sealed, wrapper.getAuthTag()]).toString("base64"),
      ...(member.epoch && ephemeral ? { epoch: member.epoch.n } : {}),
    };
    wrapped.push(entry);
    macKeys.push({ entry, key: macKeyOf(wrapKey) });
  }
  const sealKey = sealKeyOf(snapshotKey);
  return {
    ciphertexts,
    wrapped,
    senderPublicKey: senderPublicKeyB64,
    ...(ephemeral ? { epk: ephemeral.publicKey } : {}),
    seal: (fields) => {
      for (const { entry, key } of macKeys) entry.mac = macOf(key, entry.memberId, fields);
      return tagOf(sealKey, fields);
    },
    sealMeta: (binding, meta) => sealMetaWith(snapshotKey, binding, meta),
  };
}

/**
 * Seal a payload with a fresh random key, and wrap that key for each member.
 *
 * The wrapped keys travel with the snapshot; the snapshot key itself does not
 * leave this sender in the clear.
 *
 */
export function sealForMembers(
  plain: Buffer,
  members: Array<{ memberId: string; publicKey?: string }>,
  senderPrivateKeyPem: string,
  senderPublicKeyB64: string,
): SealedForMembers {
  const many = sealManyForMembers([plain], members, senderPrivateKeyPem, senderPublicKeyB64);
  return { ciphertext: many.ciphertexts[0]!, wrapped: many.wrapped, senderPublicKey: many.senderPublicKey };
}

/**
 * Open a payload with the key that was wrapped for this member.
 *
 * Returns null when there is no key for this member, which is the normal
 * case for a member that joined after the snapshot was taken.
 *
 */
export function openForMember(
  ciphertext: Buffer,
  wrapped: WrappedKey[],
  senderPublicKeyB64: string,
  memberId: string,
  memberPrivateKeyPem: string,
): Buffer | null {
  return openPayload(ciphertext, wrapped, senderPublicKeyB64, memberId, memberPrivateKeyPem)?.plain ?? null;
}

/** Like `openForMember`, and keeps what is needed to check the snapshot's seal. */
export function openPayload(
  ciphertext: Buffer,
  wrapped: WrappedKey[],
  senderPublicKeyB64: string,
  memberId: string,
  memberPrivateKeyPem: string,
  /** The fleet's incarnation, to find an entry listed under `wrapIdOf` rather than the device id. */
  incarnation?: string,
  /** What an entry wrapped to an epoch key is opened with: the manifest's `epk`, and the epoch keys this member holds. */
  epochs?: { epk?: string; keys: readonly EpochKey[] },
): OpenedPayload | null {
  const entry = wrappedEntryFor(wrapped, memberId, incarnation);
  if (!entry) return null;
  const raw = Buffer.from(entry.wrapped, "base64");
  if (raw.length < 12 + 16) return null;
  const wrapIv = raw.subarray(0, 12);
  const wrapTag = raw.subarray(raw.length - 16);
  const wrapBody = raw.subarray(12, raw.length - 16);
  const wrapKey = sharedSecret(memberPrivateKeyPem, senderPublicKeyB64);
  let snapshotKey: Buffer;
  try {
    let unwrapKey = wrapKey;
    if (entry.epoch !== undefined) {
      // Wrapped to an epoch key: opened with that epoch's private half, which is gone once it has been deleted.
      const held = epochs?.keys.find((k) => k.n === entry.epoch);
      if (!held || typeof epochs?.epk !== "string") return null;
      unwrapKey = epochUnwrapKey(held.privateKey, epochs.epk, senderPublicKeyB64);
    }
    const unwrapper = createDecipheriv("aes-256-gcm", unwrapKey, wrapIv);
    unwrapper.setAuthTag(wrapTag);
    snapshotKey = Buffer.concat([unwrapper.update(wrapBody), unwrapper.final()]);
  } catch {
    return null;
  }

  if (ciphertext.length < 12 + 16) return null;
  const iv = ciphertext.subarray(0, 12);
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const body = ciphertext.subarray(12, ciphertext.length - 16);
  try {
    const decipher = createDecipheriv("aes-256-gcm", snapshotKey, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]);
    const sealKey = sealKeyOf(snapshotKey);
    const macKey = macKeyOf(wrapKey);
    return {
      plain,
      sealMatches: (fields, tag) => tagMatches(sealKey, fields, tag),
      macMatches: (fields) => (typeof entry.mac === "string" ? sameBase64(macOf(macKey, entry.memberId, fields), entry.mac) : null),
      openMeta: (binding, blob) => openMetaWith(snapshotKey, binding, blob),
    };
  } catch {
    return null;
  }
}
