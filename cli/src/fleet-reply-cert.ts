// A certificate that a fleet member's space signs its replies with the key it says.
//
// A reply of a fleet is signed by the space's reply key (see caller-auth.ts), and a gateway has keys of its own to sign with, so the
// signature says only that a key signed it. The member's signing key (the `spub` the fleet's owner-signed roster names for the member)
// stays on the host with the agent: the agent signs this certificate - "in fleet F, the space of device D signs its replies with R, until T" -
// and writes it where the space reads it. A caller that holds the roster (and the owner's fingerprint it pinned) checks the certificate
// against the member the roster names, and then the reply against R. What the gateway signs itself is no member's.
//
// The certificate travels as a fourth part of the reply signature: `v2.<R>.<signature>.<certificate>`, where the certificate is
// `c1:<spub>:<until, ms>:<signature>` (colons, so that it is one part of a signature header that is split at dots). F, D and R are what the caller already has (the fleet, the member it named, the key of the reply),
// so they are covered by the signature and not repeated.

import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";

export const REPLY_CERT_VERSION = "c1";
const PREFIX = "prime-reply-cert-v1\n";
/** How long a certificate is good for, and when the agent makes a new one (while the old one still has this much left). */
export const REPLY_CERT_TTL_MS = 24 * 60 * 60_000;
export const REPLY_CERT_RENEW_MS = 12 * 60 * 60_000;
/** The longest a certificate that was handed over may claim to last: a longer one is not one this build made. */
export const REPLY_CERT_MAX_MS = 48 * 60 * 60_000;

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const B64U_KEY = /^[A-Za-z0-9_-]{43}$/;

function message(fleet: string, device: string, replyKey: string, until: number): Buffer {
  return Buffer.from(`${PREFIX}${fleet}\n${device}\n${replyKey}\n${until}`, "utf8");
}

/** The raw public key of an Ed25519 private key in PEM, base64url (what the roster calls an `spub`). */
export function publicKeyOfPem(privateKeyPem: string): string {
  const der = createPublicKey(createPrivateKey(privateKeyPem)).export({ type: "spki", format: "der" }) as Buffer;
  return der.subarray(der.length - 32).toString("base64url");
}

export interface ReplyCertSubject {
  fleet: string;
  /** The device id the space answers as: the member the call was made for. */
  device: string;
  /** The space's reply public key, base64url. */
  replyKey: string;
}

/** Sign a certificate for a space's reply key with the member's signing key (PEM). */
export function signReplyCert(signKeyPem: string, subject: ReplyCertSubject, until: number): string {
  const spub = publicKeyOfPem(signKeyPem);
  const sig = cryptoSign(null, message(subject.fleet, subject.device, subject.replyKey, until), createPrivateKey(signKeyPem)).toString("base64url");
  return `${REPLY_CERT_VERSION}:${spub}:${until}:${sig}`;
}

export interface ParsedReplyCert {
  spub: string;
  until: number;
  sig: string;
}

export function parseReplyCert(text: string): ParsedReplyCert | undefined {
  const parts = text.split(":");
  if (parts.length !== 4 || parts[0] !== REPLY_CERT_VERSION) return undefined;
  const until = Number(parts[2]);
  if (!B64U_KEY.test(parts[1]!) || !/^[0-9]{1,16}$/.test(parts[2]!) || !Number.isSafeInteger(until)) return undefined;
  if (!/^[A-Za-z0-9_-]{86}$/.test(parts[3]!)) return undefined;
  return { spub: parts[1]!, until, sig: parts[3]! };
}

/** Does the certificate carry the signature of its `spub` for this subject, and has it not run out (and was it not made to last too long)? */
export function checkReplyCert(cert: ParsedReplyCert, subject: ReplyCertSubject, now: number): boolean {
  if (cert.until <= now || cert.until - now > REPLY_CERT_MAX_MS) return false;
  if (!B64U_KEY.test(subject.replyKey)) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(cert.spub, "base64url")]), format: "der", type: "spki" });
    return cryptoVerify(null, message(subject.fleet, subject.device, subject.replyKey, cert.until), key, Buffer.from(cert.sig, "base64url"));
  } catch {
    return false;
  }
}
