// The owner-signed, hash-chained roster of a fleet: who its members are, with which keys, since
// which snapshot, written by the fleet's owner and checked by every member.
//
// The gateway keeps the roster and cannot be trusted with it: left to itself it could add a key of its
// own, so that the primary seals the next snapshot for it, or swap a member's key. So the changes are
// entries signed by an Ed25519 key the operator holds (the owner key), chained by hash from a genesis
// entry that names that key. A member pins the key's fingerprint when it joins, checks the whole chain
// from the genesis, and accepts a sender only for the snapshots the chain says it was a member for.
//
// The forms are fixed by api/witness/README.md ("Exact forms"), which the witness also reads:
//
//   entry = ["prime-roster-v1", fleet, incarnation, n, prevHash|null, at, op, device|null, xpub|null,
//            spub|null, role|null, seqAt|null, extra|null]
//
// every element a string of at most 256 characters, a safe integer or null; the signature is Ed25519
// over utf8(JSON.stringify(entry)), as base64url of the raw 64 bytes; public keys that are Ed25519
// (`spub`, the genesis `extra`) are base64url of the raw 32 bytes. An entry is always re-serialised from
// the parsed array, never hashed or signed as stored text.

import { createHash, randomBytes, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { writeFileAtomic } from "./atomic-write.ts";
import { publicKeyFromRaw, rawPublicKey } from "./caller-key.ts";

export const ROSTER_TAG = "prime-roster-v1";

export type RosterOp = "genesis" | "add" | "remove" | "rotate" | "rotate-self" | "role" | "caller" | "caller-remove" | "owner-rotate";
export type RosterRole = "owner" | "member" | "viewer";

/** One entry, in the order of the contract: see the header. */
export type RosterEntry = [
  tag: string,
  fleet: string,
  incarnation: string,
  n: number,
  prevHash: string | null,
  at: number,
  op: RosterOp,
  device: string | null,
  xpub: string | null,
  spub: string | null,
  role: string | null,
  seqAt: number | null,
  extra: string | null,
];

export interface SignedEntry {
  entry: RosterEntry;
  /** base64url of the raw 64-byte signature. */
  sig: string;
}

/** A chain, entry or key that is not what it must be: the message says which and why. */
export class RosterError extends Error {}

const OPS: ReadonlySet<string> = new Set(["genesis", "add", "remove", "rotate", "rotate-self", "role", "caller", "caller-remove", "owner-rotate"]);
const ROLES: ReadonlySet<string> = new Set(["owner", "member", "viewer"]);
const TOKEN_RE = /^[A-Za-z0-9._~:+=/-]{1,128}$/;
const B64URL_32_RE = /^[A-Za-z0-9_-]{43}$/;
const B64URL_64_RE = /^[A-Za-z0-9_-]{86}$/;
const FIELD_MAX = 256;

// The places of the elements of an entry.
const N = 3;
const PREV = 4;
const OP = 6;
const DEVICE = 7;
const XPUB = 8;
const SPUB = 9;
const ROLE = 10;
const SEQ_AT = 11;
const EXTRA = 12;

// ---- encoding ------------------------------------------------------------------

const b64u = (bytes: Buffer): string => bytes.toString("base64url");

/** What is hashed and signed of an entry: the array as JSON, as UTF-8. */
export function entryBytes(entry: readonly unknown[]): Buffer {
  return Buffer.from(JSON.stringify(entry), "utf8");
}

/** Check that `value` is an entry of the form the contract fixes (not that it is right: see `verifyChain`). */
export function checkEntryShape(value: unknown): RosterEntry {
  if (!Array.isArray(value) || value.length !== 13) throw new RosterError("a roster entry has 13 elements");
  for (const v of value) {
    const ok = v === null || (typeof v === "string" && v.length <= FIELD_MAX) || (typeof v === "number" && Number.isSafeInteger(v));
    if (!ok) throw new RosterError("a roster entry holds only strings of at most 256 characters, integers and null");
  }
  const e = value as unknown[];
  if (e[0] !== ROSTER_TAG) throw new RosterError("not a roster entry (its tag is not " + ROSTER_TAG + ")");
  if (typeof e[1] !== "string" || !TOKEN_RE.test(e[1])) throw new RosterError("the fleet in an entry is not a name");
  if (typeof e[2] !== "string" || !TOKEN_RE.test(e[2])) throw new RosterError("the incarnation in an entry is not a name");
  if (typeof e[N] !== "number" || e[N] < 0) throw new RosterError("n is a position, not below 0");
  if (e[PREV] !== null && typeof e[PREV] !== "string") throw new RosterError("prevHash is a hash or null");
  if (typeof e[5] !== "number" || e[5] < 0) throw new RosterError("at is a time in milliseconds");
  if (typeof e[OP] !== "string" || !OPS.has(e[OP])) throw new RosterError("unknown operation " + JSON.stringify(e[OP]));
  if (e[DEVICE] !== null && (typeof e[DEVICE] !== "string" || !TOKEN_RE.test(e[DEVICE]))) throw new RosterError("device is not a name");
  if (e[SPUB] !== null && (typeof e[SPUB] !== "string" || !B64URL_32_RE.test(e[SPUB]))) throw new RosterError("spub is not a base64url Ed25519 key of 32 bytes");
  if (e[ROLE] !== null && (typeof e[ROLE] !== "string" || !ROLES.has(e[ROLE]))) throw new RosterError("role is owner, member or viewer");
  if (e[SEQ_AT] !== null && (typeof e[SEQ_AT] !== "number" || e[SEQ_AT] < 0)) throw new RosterError("seqAt is a sequence");
  return value as RosterEntry;
}

/** The entry for a signed one read from the gateway or a file: both parts of a form that can be checked, or an error. */
export function checkSigned(value: unknown): SignedEntry {
  const v = value as { entry?: unknown; sig?: unknown } | null;
  if (typeof v !== "object" || v === null) throw new RosterError("a signed entry is {entry, sig}");
  const entry = checkEntryShape(v.entry);
  if (typeof v.sig !== "string" || !B64URL_64_RE.test(v.sig)) throw new RosterError("a signature is base64url of 64 bytes");
  return { entry, sig: v.sig };
}

/** The signature an Ed25519 private key (PEM) makes over an entry. */
export function signEntry(entry: RosterEntry, privateKeyPem: string): string {
  return b64u(cryptoSign(null, entryBytes(entry), createPrivateKey(privateKeyPem)));
}

/** Whether `sig` is `pub`'s signature over the entry. */
export function verifyEntry(entry: RosterEntry, sig: string, pubB64u: string): boolean {
  if (!B64URL_32_RE.test(pubB64u) || !B64URL_64_RE.test(sig)) return false;
  try {
    return cryptoVerify(null, entryBytes(entry), publicKeyFromRaw(Buffer.from(pubB64u, "base64url")), Buffer.from(sig, "base64url"));
  } catch {
    return false;
  }
}

/** What the entry after this one carries as its `prevHash`: the entry's bytes, then the 64 raw bytes of its signature. */
export function entryHash(signed: SignedEntry): string {
  return b64u(createHash("sha256").update(entryBytes(signed.entry)).update(Buffer.from(signed.sig, "base64url")).digest());
}

/** The name of a fleet's roster at the witness: the hash of the genesis entry alone (43 characters). */
export function fleetKeyOf(genesis: RosterEntry): string {
  return b64u(createHash("sha256").update(entryBytes(genesis)).digest());
}

/** An entry with its fixed places filled; what is not given is null. */
export function makeEntry(f: {
  fleet: string;
  incarnation: string;
  n: number;
  prevHash: string | null;
  at: number;
  op: RosterOp;
  device?: string | null;
  xpub?: string | null;
  spub?: string | null;
  role?: string | null;
  seqAt?: number | null;
  extra?: string | null;
}): RosterEntry {
  return checkEntryShape([
    ROSTER_TAG,
    f.fleet,
    f.incarnation,
    f.n,
    f.prevHash,
    f.at,
    f.op,
    f.device ?? null,
    f.xpub ?? null,
    f.spub ?? null,
    f.role ?? null,
    f.seqAt ?? null,
    f.extra ?? null,
  ]);
}

// ---- the owner key ------------------------------------------------------------------

export interface OwnerKey {
  /** PEM (PKCS#8) of the private key. */
  privateKeyPem: string;
  /** base64url of the raw 32-byte public key. */
  publicKey: string;
}

/** A new owner key: Ed25519, made by node:crypto, never printed. */
export function generateOwnerKey(): OwnerKey {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: b64u(rawPublicKey(pair.publicKey)),
  };
}

/** The key behind a private key PEM. */
export function ownerKeyFromPem(privateKeyPem: string): OwnerKey {
  let key;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    throw new RosterError("the owner key file is not an Ed25519 private key in PEM");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new RosterError("the owner key file is not an Ed25519 key");
  return { privateKeyPem, publicKey: b64u(rawPublicKey(createPublicKey(key))) };
}

/** Read an owner key file; a missing file is an error that says where it looked. */
export function readOwnerKey(file: string): OwnerKey {
  if (!existsSync(file)) throw new RosterError("there is no owner key at " + file + " (this machine is not the fleet's operator, or the key was kept elsewhere: --owner-key <file>)");
  return ownerKeyFromPem(readFileSync(file, "utf8"));
}

/** Make an owner key file (mode 0600, written whole or not at all); an existing one is never replaced. */
export function createOwnerKeyFile(file: string): OwnerKey {
  if (existsSync(file)) throw new RosterError("there is already an owner key at " + file + ": it is not replaced (it is the fleet's authority)");
  const key = generateOwnerKey();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // The file is made whole and put in place only if nothing is there: two runs at once do not replace each other's key.
  const tmp = file + "." + process.pid + "." + randomBytes(4).toString("hex") + ".tmp";
  writeFileSync(tmp, key.privateKeyPem, { mode: 0o600, flag: "wx" });
  try {
    linkSync(tmp, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new RosterError("there is already an owner key at " + file + ": it is not replaced (it is the fleet's authority)");
    throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
  return key;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * What a person compares: the first 26 base32 characters (130 bits) of the sha256 of the raw public key, in groups of
 * five (the last of six). Two machines printing the same one hold the same key.
 */
export function ownerFingerprint(publicKeyB64u: string): string {
  const digest = createHash("sha256").update(Buffer.from(publicKeyB64u, "base64url")).digest();
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const byte of digest) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      out += BASE32[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
    if (out.length >= 26) break;
  }
  return [out.slice(0, 5), out.slice(5, 10), out.slice(10, 15), out.slice(15, 20), out.slice(20)].join("-");
}

/** A fingerprint as typed: without dashes, spaces or case. */
export function normalizeFingerprint(text: string): string {
  return text.replace(/[\s-]/g, "").toUpperCase();
}

/** Whether `text` is a fingerprint of this form (it may be typed in any case, with or without the dashes). */
export function isFingerprint(text: string): boolean {
  return /^[A-Z2-7]{26}$/.test(normalizeFingerprint(text));
}

// ---- verification ----------------------------------------------------------------------

/** The period a key held a device's place, in the sequences of the fleet's snapshots: `from` to `until`, both included. */
export interface Tenure {
  device: string;
  xpub: string | null;
  spub: string | null;
  role: RosterRole;
  from: number;
  /** null while the key still holds the place. */
  until: number | null;
  /** The entry (its position in the chain) that began it. */
  n: number;
}

export interface CallerKey {
  spub: string;
  label: string;
  n: number;
}

export interface VerifiedRoster {
  fleet: string;
  incarnation: string;
  /** The fleet's name at the witness. */
  fleetKey: string;
  /** The key that signs the chain now (the genesis one, unless it was rotated). */
  owner: string;
  /** The key that made the genesis. */
  genesisOwner: string;
  head: { n: number; hash: string };
  entries: SignedEntry[];
  tenures: Tenure[];
  callers: CallerKey[];
}

export interface VerifyOptions {
  /** The fingerprint the member pinned: the genesis must name this key. */
  ownerFp?: string;
  /** What the member has verified before: a chain that does not contain this entry at this place is a rollback or a fork. */
  pinned?: { n: number; hash: string };
  /** The fleet and incarnation it must be for. */
  fleet?: string;
  incarnation?: string;
}

function need<T>(value: T | null, what: string, op: string, n: number): T {
  if (value === null) throw new RosterError("entry " + n + " (" + op + ") has no " + what);
  return value;
}

/**
 * Check a whole chain from its genesis and return what it says.
 *
 * Every entry has the next `n`, names the hash of the one before (entry and signature), belongs to the fleet and
 * incarnation of the genesis, and is signed by the owner key (the genesis' own, or the one an `owner-rotate`
 * named), except `rotate-self`, which the device signs with the key it holds the place with. An entry that
 * does something that cannot be done (adds a device that is there, removes one that is not) is refused.
 */
export function verifyChain(chain: unknown[], options: VerifyOptions = {}): VerifiedRoster {
  if (chain.length === 0) throw new RosterError("the roster has no entries");
  const entries = chain.map((c) => checkSigned(c));
  const genesis = entries[0]!;
  const g = genesis.entry;
  if (g[N] !== 0 || g[OP] !== "genesis" || g[PREV] !== null) throw new RosterError("the roster does not begin with a genesis entry (n 0, no previous)");
  const genesisOwner = g[EXTRA];
  if (genesisOwner === null || !B64URL_32_RE.test(genesisOwner)) throw new RosterError("the genesis entry does not name an owner key");
  if (!verifyEntry(g, genesis.sig, genesisOwner)) throw new RosterError("the genesis entry is not signed by the owner key it names");
  if (options.ownerFp !== undefined && normalizeFingerprint(options.ownerFp) !== normalizeFingerprint(ownerFingerprint(genesisOwner))) {
    throw new RosterError("this roster is made by the owner key " + ownerFingerprint(genesisOwner) + ", not the one this member pinned (" + options.ownerFp + ")");
  }
  const fleet = g[1];
  const incarnation = g[2];
  if (options.fleet !== undefined && options.fleet !== fleet) throw new RosterError("this roster is of the fleet " + fleet + ", not " + options.fleet);
  if (options.incarnation !== undefined && options.incarnation !== incarnation) {
    throw new RosterError("this roster is of an earlier fleet that had the name " + fleet + " (incarnation " + incarnation + "), not of this one");
  }

  let owner = genesisOwner;
  const tenures: Tenure[] = [];
  const live = new Map<string, Tenure>();
  const callers = new Map<string, CallerKey>();
  const hashes: string[] = [entryHash(genesis)];

  for (let i = 1; i < entries.length; i++) {
    const { entry: e, sig } = entries[i]!;
    const op = e[OP] as RosterOp;
    if (e[N] !== i) throw new RosterError("entry " + i + " says it is entry " + e[N] + ": the chain is out of order or has a gap");
    if (e[PREV] !== hashes[i - 1]) throw new RosterError("entry " + i + " does not follow entry " + (i - 1) + " (its previous hash differs): the chain was changed");
    if (e[1] !== fleet || e[2] !== incarnation) throw new RosterError("entry " + i + " is of another fleet or incarnation than the genesis");
    if (op === "genesis") throw new RosterError("entry " + i + " is a second genesis");

    const device = e[DEVICE];
    const current = device !== null ? live.get(device) : undefined;
    // Who signs: the owner, but a member may change its own signing key.
    const signer = op === "rotate-self" ? current?.spub ?? null : owner;
    if (signer === null || !verifyEntry(e, sig, signer)) {
      throw new RosterError("entry " + i + " (" + op + ") is not signed by " + (op === "rotate-self" ? "the key the device holds its place with" : "the owner key"));
    }

    switch (op) {
      case "add": {
        const d = need(device, "device", op, i);
        const role = need(e[ROLE], "role", op, i);
        const xpub = need(e[XPUB], "key (xpub)", op, i);
        const from = need(e[SEQ_AT], "seqAt", op, i);
        if (live.has(d)) throw new RosterError("entry " + i + " adds " + d + ", which is already a member");
        const t: Tenure = { device: d, xpub, spub: e[SPUB], role: role as RosterRole, from, until: null, n: i };
        live.set(d, t);
        tenures.push(t);
        break;
      }
      case "remove": {
        const d = need(device, "device", op, i);
        const until = need(e[SEQ_AT], "seqAt", op, i);
        if (current === undefined) throw new RosterError("entry " + i + " removes " + d + ", which is not a member");
        if (until < current.from) throw new RosterError("entry " + i + " removes " + d + " from before it was added");
        current.until = until;
        live.delete(d);
        break;
      }
      case "rotate":
      case "rotate-self": {
        const d = need(device, "device", op, i);
        const from = need(e[SEQ_AT], "seqAt", op, i);
        if (current === undefined) throw new RosterError("entry " + i + " changes the key of " + d + ", which is not a member");
        if (from < current.from) throw new RosterError("entry " + i + " changes the key of " + d + " from before it was added");
        const spub = op === "rotate-self" ? need(e[SPUB], "signing key (spub)", op, i) : e[SPUB];
        const xpub = op === "rotate-self" ? current.xpub : need(e[XPUB], "key (xpub)", op, i);
        if (op === "rotate-self" && e[XPUB] !== null && e[XPUB] !== current.xpub) throw new RosterError("entry " + i + " (rotate-self) changes the key snapshots are sealed for, which only the owner may");
        current.until = from;
        const t: Tenure = { device: d, xpub, spub, role: current.role, from, until: null, n: i };
        live.set(d, t);
        tenures.push(t);
        break;
      }
      case "role": {
        const d = need(device, "device", op, i);
        const role = need(e[ROLE], "role", op, i);
        const from = need(e[SEQ_AT], "seqAt", op, i);
        if (current === undefined) throw new RosterError("entry " + i + " changes the role of " + d + ", which is not a member");
        if (from < current.from) throw new RosterError("entry " + i + " changes the role of " + d + " from before it was added");
        current.until = from;
        const t: Tenure = { ...current, role: role as RosterRole, from, until: null, n: i };
        live.set(d, t);
        tenures.push(t);
        break;
      }
      case "caller": {
        const key = need(e[SPUB], "key (spub)", op, i);
        callers.set(key, { spub: key, label: e[EXTRA] ?? "", n: i });
        break;
      }
      case "caller-remove": {
        const key = need(e[SPUB], "key (spub)", op, i);
        if (!callers.delete(key)) throw new RosterError("entry " + i + " removes a caller key that was not added");
        break;
      }
      case "owner-rotate": {
        const next = need(e[EXTRA], "new owner key (extra)", op, i);
        if (!B64URL_32_RE.test(next)) throw new RosterError("entry " + i + " names a new owner key that is not a key");
        owner = next;
        break;
      }
    }
    hashes.push(entryHash(entries[i]!));
  }

  const head = { n: entries.length - 1, hash: hashes[hashes.length - 1]! };
  if (options.pinned) {
    const at = options.pinned.n;
    if (at >= entries.length) {
      throw new RosterError("this roster has " + entries.length + " entries, but this member has seen " + (at + 1) + ": the gateway is showing an older roster (a rollback)");
    }
    if (hashes[at] !== options.pinned.hash) {
      throw new RosterError("this roster does not contain the entry " + at + " this member has seen: it is another history (a fork or a rollback)");
    }
  }
  return {
    fleet,
    incarnation,
    fleetKey: fleetKeyOf(g),
    owner,
    genesisOwner,
    head,
    entries,
    tenures,
    callers: [...callers.values()],
  };
}

// ---- what a verified roster says -----------------------------------------------------------

const covers = (t: Tenure, seq: number): boolean => seq >= t.from && (t.until === null || seq <= t.until);

/** The tenures that hold at snapshot `seq`: who the members were, with which keys. */
export function membersAt(v: VerifiedRoster, seq: number): Tenure[] {
  return v.tenures.filter((t) => covers(t, seq));
}

/**
 * Whether a snapshot at `seq` may be from the member that holds the X25519 key `xpub`: the chain says that key was
 * a member's (not a viewer's) at that snapshot.
 */
export function mayPublishAt(v: VerifiedRoster, xpub: string, seq: number): boolean {
  return v.tenures.some((t) => t.xpub === xpub && t.role !== "viewer" && covers(t, seq));
}

/**
 * Whether a checkpoint for snapshot `seq` signed by the signing key `spub` is one the chain stands behind: a tenure of that key
 * covers `seq`. A key the chain removed (or replaced by a rotation) counts for what it saw up to the entry that ended its
 * place, and for nothing after it (see the witness contract).
 */
export function mayCheckpointAt(v: VerifiedRoster, spub: string, seq: number): boolean {
  return v.tenures.some((t) => t.spub === spub && covers(t, seq));
}

/** Who may be sealed for now: the live members of the chain, whatever their role (a viewer reads). */
export function liveMembers(v: VerifiedRoster): Tenure[] {
  return v.tenures.filter((t) => t.until === null);
}

// ---- the chain a member keeps ------------------------------------------------------------------

/** Where a member keeps the chain it last verified, beside its key file. */
export function rosterCacheFile(keyFile: string): string {
  return keyFile + ".roster.json";
}

/** What a member kept (not trusted: it is checked again with `verifyChain` before it is used). */
export function readRosterCache(keyFile: string): SignedEntry[] {
  const file = rosterCacheFile(keyFile);
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { entries?: unknown };
    if (!Array.isArray(raw.entries)) return [];
    return raw.entries.map((e) => checkSigned(e));
  } catch {
    return [];
  }
}

export function writeRosterCache(keyFile: string, entries: SignedEntry[]): void {
  writeFileAtomic(rosterCacheFile(keyFile), JSON.stringify({ v: 1, entries }), 0o600);
}

// ---- the invite that carries the owner key ---------------------------------------------------------

/**
 * An invite code as the operator prints it: the gateway's code, and after a "~" the fingerprint of the owner key the
 * member pins. Only the code goes to the gateway; the fingerprint never does.
 */
export function parseInviteCode(text: string): { code: string; ownerFp?: string } {
  const at = text.lastIndexOf("~");
  if (at < 0) return { code: text.trim() };
  const fp = text.slice(at + 1);
  if (!isFingerprint(fp)) throw new RosterError("the part of the invite after \"~\" is not an owner key fingerprint (26 letters and digits)");
  return { code: text.slice(0, at).trim(), ownerFp: normalizeFingerprint(fp) };
}

/** The code the operator hands out: the gateway's, and the owner key's fingerprint. */
export function inviteWithOwner(code: string, ownerPublicKey: string): string {
  return code + "~" + ownerFingerprint(ownerPublicKey);
}
