// A member's epoch key: a short-lived X25519 public key the snapshot key is wrapped to, instead of the member's long-term one.
// The member signs it with its signing key (the one in the roster), so that a gateway cannot invent one for it. This module is
// the form and the check; the object keeps the key and the route serves it.

import { type SignedEntry, RosterRefusal, verifyEntry } from "./fleet-roster";

export const EPOCH_TAG = "prime-epoch-v1";
/** The shortest time between two epoch keys the object takes from one member: the row it rewrites is the cost of a key. */
export const EPOCH_KEY_MIN_INTERVAL_MS = 5 * 60_000;
/** How far ahead of now a key may be valid (a member's longest epoch, plus what it keeps a private for after, and some margin). */
export const EPOCH_KEY_MAX_AHEAD_MS = 31 * 24 * 3_600_000;
const MAX_N = 2_147_483_647;
const PUB_RE = /^[A-Za-z0-9+/]{43}=$/;
const TOKEN_RE = /^[A-Za-z0-9._~:+=/-]{1,128}$/;
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;

/** What the object keeps of a member's epoch key, and what `GET /keys` says of it. */
export interface EpochKey {
  n: number;
  pub: string;
  notAfter: number;
  sig: string;
  /** When the object took it (not part of what is signed). */
  at: number;
}

/** `["prime-epoch-v1", fleet, incarnation, device, n, pub, notAfter]` and its signature, or why the body is not one. */
export function parseEpochKey(body: unknown): { signed: SignedEntry; n: number; pub: string; notAfter: number; device: string; fleet: string; incarnation: string } {
  const v = body as { entry?: unknown; sig?: unknown } | null;
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new RosterRefusal("an epoch key is {entry, sig}");
  const e = v.entry;
  if (!Array.isArray(e) || e.length !== 7) throw new RosterRefusal("an epoch key entry has 7 elements: [" + EPOCH_TAG + ", fleet, incarnation, device, n, pub, notAfter]");
  if (e[0] !== EPOCH_TAG) throw new RosterRefusal("not an epoch key (its tag is not " + EPOCH_TAG + ")");
  const [, fleet, incarnation, device, n, pub, notAfter] = e as unknown[];
  if (typeof fleet !== "string" || !TOKEN_RE.test(fleet)) throw new RosterRefusal("the fleet in an epoch key is not a name");
  if (typeof incarnation !== "string" || !TOKEN_RE.test(incarnation)) throw new RosterRefusal("the incarnation in an epoch key is not a name");
  if (typeof device !== "string" || !TOKEN_RE.test(device)) throw new RosterRefusal("the device in an epoch key is not a name");
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > MAX_N) throw new RosterRefusal("n of an epoch key is a count from 0");
  if (typeof pub !== "string" || !PUB_RE.test(pub)) throw new RosterRefusal("the epoch key is not an X25519 public key (base64 of 32 bytes)");
  if (typeof notAfter !== "number" || !Number.isSafeInteger(notAfter) || notAfter < 0) throw new RosterRefusal("notAfter is a time in milliseconds");
  if (typeof v.sig !== "string" || !SIG_RE.test(v.sig)) throw new RosterRefusal("a signature is base64url of 64 bytes");
  return { signed: { entry: e as SignedEntry["entry"], sig: v.sig }, n, pub, notAfter, device, fleet, incarnation };
}

/** Whether the member's signing key signed this epoch key. */
export function epochKeySigned(signed: SignedEntry, spub: string): Promise<boolean> {
  return verifyEntry(signed.entry, signed.sig, spub);
}
