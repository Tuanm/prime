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
   * A tag over the manifest's seal fields made with a key only the sender and this member can
   * derive (their Diffie-Hellman secret): what the seal cannot say, which is that the sender
   * is the one that made it. Every member that ever held the snapshot key can make the seal; only
   * this one and the sender can make this. Absent from snapshots of older publishers.
   */
  mac?: string;
}

/** A short fingerprint of a member's public key (base64), to tell its keys apart. */
export function keyIdOf(publicKeyB64: string): string {
  return createHash("sha256").update(Buffer.from(publicKeyB64, "base64")).digest().subarray(0, 8).toString("base64");
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
  /**
   * The seal of a manifest: a tag only a holder of this snapshot key can make
   * (see `SealFields`). It travels in the manifest. Sealing also puts each member's own
   * tag (`WrappedKey.mac`) on its entry of `wrapped`, which is why it is called once the
   * fields are known and before the manifest is stored.
   */
  seal(fields: SealFields): string;
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
  const expected = Buffer.from(tagOf(sealKey, fields), "utf8");
  const got = Buffer.from(tag, "utf8");
  return expected.length === got.length && timingSafeEqual(expected, got);
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
  members: Array<{ memberId: string; publicKey?: string }>,
  senderPrivateKeyPem: string,
  senderPublicKeyB64: string,
): SealedManyForMembers {
  const snapshotKey = randomBytes(32);
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
    const wrapper = createCipheriv("aes-256-gcm", wrapKey, wrapIv);
    const sealed = Buffer.concat([wrapper.update(snapshotKey), wrapper.final()]);
    const entry: WrappedKey = {
      memberId: member.memberId,
      keyId: keyIdOf(member.publicKey),
      wrapped: Buffer.concat([wrapIv, sealed, wrapper.getAuthTag()]).toString("base64"),
    };
    wrapped.push(entry);
    macKeys.push({ entry, key: macKeyOf(wrapKey) });
  }
  const sealKey = sealKeyOf(snapshotKey);
  return {
    ciphertexts,
    wrapped,
    senderPublicKey: senderPublicKeyB64,
    seal: (fields) => {
      for (const { entry, key } of macKeys) entry.mac = macOf(key, entry.memberId, fields);
      return tagOf(sealKey, fields);
    },
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
): OpenedPayload | null {
  const entry = wrapped.find((w) => w.memberId === memberId);
  if (!entry) return null;
  const raw = Buffer.from(entry.wrapped, "base64");
  if (raw.length < 12 + 16) return null;
  const wrapIv = raw.subarray(0, 12);
  const wrapTag = raw.subarray(raw.length - 16);
  const wrapBody = raw.subarray(12, raw.length - 16);
  const wrapKey = sharedSecret(memberPrivateKeyPem, senderPublicKeyB64);
  let snapshotKey: Buffer;
  try {
    const unwrapper = createDecipheriv("aes-256-gcm", wrapKey, wrapIv);
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
    };
  } catch {
    return null;
  }
}
