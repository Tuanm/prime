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

import { createCipheriv, createDecipheriv, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, createPublicKey, createPrivateKey } from "node:crypto";

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
  /** base64 of the sealed snapshot key. */
  wrapped: string;
}

export interface SealedForMembers {
  /** The sealed payload. */
  ciphertext: Buffer;
  /** The snapshot key, wrapped for each member that offered a public key. */
  wrapped: WrappedKey[];
  /** The sender's own public key, so a receiver can derive the shared secret. */
  senderPublicKey: string;
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
  const snapshotKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", snapshotKey, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const ciphertext = Buffer.concat([iv, body, cipher.getAuthTag()]);

  const wrapped: WrappedKey[] = [];
  for (const member of members) {
    if (!member.publicKey) continue;
    const wrapKey = sharedSecret(senderPrivateKeyPem, member.publicKey);
    const wrapIv = randomBytes(12);
    const wrapper = createCipheriv("aes-256-gcm", wrapKey, wrapIv);
    const sealed = Buffer.concat([wrapper.update(snapshotKey), wrapper.final()]);
    wrapped.push({
      memberId: member.memberId,
      wrapped: Buffer.concat([wrapIv, sealed, wrapper.getAuthTag()]).toString("base64"),
    });
  }
  return { ciphertext, wrapped, senderPublicKey: senderPublicKeyB64 };
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
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return null;
  }
}
