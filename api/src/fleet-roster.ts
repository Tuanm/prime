/**
 * The owner-signed roster of a fleet, as the gateway checks it.
 *
 * A fleet's members are kept by the gateway, which is the one party that cannot be trusted with them: left to itself it
 * could add a key of its own so that the primary seals the next snapshot for it, or swap a member's key. So a fleet can
 * be put under a chain of entries signed by an Ed25519 key the operator holds (the owner key), each naming the hash of
 * the one before, from a genesis entry that names the key. The members check the chain themselves (cli/src/fleet-roster.ts);
 * the gateway checks it too, so that what it keeps is a chain a member will accept, and it applies the changes the
 * chain says to the member list it serves to the older members.
 *
 * The forms are fixed by api/witness/README.md ("Exact forms"), which the witness reads too, and are the same as the CLI's:
 *
 *   entry = ["prime-roster-v1", fleet, incarnation, n, prevHash|null, at, op, device|null, xpub|null,
 *            spub|null, role|null, seqAt|null, extra|null]
 *
 * every element a string of at most 256 characters, a safe integer or null; the signature is Ed25519 over
 * utf8(JSON.stringify(entry)), as base64url of the raw 64 bytes; the Ed25519 keys (`spub`, the genesis `extra`) are
 * base64url of the raw 32 bytes. Nothing is hashed or signed as stored text: the array is parsed and written again.
 *
 * What is decided here is only whether an entry may follow the chain (shape, position, hash, signer, and that it does
 * something that can be done). Whether the fleet's own state agrees with it (a request that is waiting, a fence) is the
 * object's to decide.
 */

export const ROSTER_TAG = "prime-roster-v1";
/** The most entries a fleet's chain may hold. There is no compaction: a fleet that reaches it is put under a new genesis. */
export const ROSTER_MAX_ENTRIES = 1000;

export type Scalar = string | number | null;
export type RosterEntry = Scalar[];

export interface SignedEntry {
  entry: RosterEntry;
  /** base64url of the raw 64-byte signature. */
  sig: string;
}

export type RosterOp = "genesis" | "add" | "remove" | "rotate" | "rotate-self" | "role" | "caller" | "caller-remove" | "owner-rotate";
export type RosterRole = "owner" | "member" | "viewer";

/** An entry the chain cannot take: what is wrong with it, and the status to answer. */
export class RosterRefusal extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const OPS: ReadonlySet<string> = new Set(["genesis", "add", "remove", "rotate", "rotate-self", "role", "caller", "caller-remove", "owner-rotate"]);
const ROLES: ReadonlySet<string> = new Set(["owner", "member", "viewer"]);
const TOKEN_RE = /^[A-Za-z0-9._~:+=/-]{1,128}$/;
const B64URL_32_RE = /^[A-Za-z0-9_-]{43}$/;
const B64URL_64_RE = /^[A-Za-z0-9_-]{86}$/;
const XPUB_RE = /^[A-Za-z0-9+/]{43}=$/;

// The places of the elements of an entry.
export const N = 3;
export const PREV = 4;
export const OP = 6;
export const DEVICE = 7;
export const XPUB = 8;
export const SPUB = 9;
export const ROLE = 10;
export const SEQ_AT = 11;
export const EXTRA = 12;

const text = new TextEncoder();

/** What is hashed and signed of an entry. */
export const entryBytes = (entry: readonly unknown[]): Uint8Array => text.encode(JSON.stringify(entry));

function fromB64url(s: string, bytes: number): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    if (bin.length !== bytes) return null;
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const toB64url = (bytes: ArrayBuffer | Uint8Array): string => {
  let s = "";
  for (const b of bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** The entry and signature of a body, or why it is not one. Only the form is checked here. */
export function parseSigned(value: unknown): SignedEntry {
  const v = value as { entry?: unknown; sig?: unknown } | null;
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new RosterRefusal("a signed entry is {entry, sig}");
  const e = v.entry;
  if (!Array.isArray(e) || e.length !== 13) throw new RosterRefusal("a roster entry has 13 elements");
  for (const x of e) {
    const ok = x === null || (typeof x === "string" && x.length <= 256) || (typeof x === "number" && Number.isSafeInteger(x));
    if (!ok) throw new RosterRefusal("a roster entry holds only strings of at most 256 characters, integers and null");
  }
  if (e[0] !== ROSTER_TAG) throw new RosterRefusal("not a roster entry (its tag is not " + ROSTER_TAG + ")");
  if (typeof e[1] !== "string" || !TOKEN_RE.test(e[1])) throw new RosterRefusal("the fleet in an entry is not a name");
  if (typeof e[2] !== "string" || !TOKEN_RE.test(e[2])) throw new RosterRefusal("the incarnation in an entry is not a name");
  if (typeof e[N] !== "number" || e[N] < 0) throw new RosterRefusal("n is a position, not below 0");
  if (e[PREV] !== null && (typeof e[PREV] !== "string" || !B64URL_32_RE.test(e[PREV]))) throw new RosterRefusal("prevHash is a hash or null");
  if (typeof e[5] !== "number" || e[5] < 0) throw new RosterRefusal("at is a time in milliseconds");
  if (typeof e[OP] !== "string" || !OPS.has(e[OP])) throw new RosterRefusal("unknown operation " + JSON.stringify(e[OP]));
  if (e[DEVICE] !== null && (typeof e[DEVICE] !== "string" || !TOKEN_RE.test(e[DEVICE]))) throw new RosterRefusal("device is not a name");
  if (e[XPUB] !== null && (typeof e[XPUB] !== "string" || !XPUB_RE.test(e[XPUB]))) throw new RosterRefusal("xpub is not a member's key");
  if (e[SPUB] !== null && (typeof e[SPUB] !== "string" || !B64URL_32_RE.test(e[SPUB]))) throw new RosterRefusal("spub is not a base64url Ed25519 key of 32 bytes");
  if (e[ROLE] !== null && (typeof e[ROLE] !== "string" || !ROLES.has(e[ROLE]))) throw new RosterRefusal("role is owner, member or viewer");
  if (e[SEQ_AT] !== null && (typeof e[SEQ_AT] !== "number" || e[SEQ_AT] < 0)) throw new RosterRefusal("seqAt is a sequence");
  if (typeof v.sig !== "string" || !B64URL_64_RE.test(v.sig)) throw new RosterRefusal("a signature is base64url of 64 bytes");
  return { entry: e as RosterEntry, sig: v.sig };
}

/** Whether `sig` is the Ed25519 signature of the key `pub` (base64url of 32 raw bytes) over the entry. */
export async function verifyEntry(entry: RosterEntry, sig: string, pub: string): Promise<boolean> {
  const key = fromB64url(pub, 32);
  const signature = fromB64url(sig, 64);
  if (!key || !signature) return false;
  try {
    const imported = await crypto.subtle.importKey("raw", key as BufferSource, "Ed25519", false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", imported, signature as BufferSource, entryBytes(entry) as BufferSource);
  } catch {
    return false;
  }
}

/** What the entry after this one carries as its prevHash: sha256 of the entry's bytes and the 64 raw bytes of its signature. */
export async function entryHash(signed: SignedEntry): Promise<string> {
  const body = entryBytes(signed.entry);
  const signature = fromB64url(signed.sig, 64) ?? new Uint8Array(0);
  const joined = new Uint8Array(body.length + signature.length);
  joined.set(body, 0);
  joined.set(signature, body.length);
  return toB64url(await crypto.subtle.digest("SHA-256", joined));
}

/** The name of the fleet's roster at the witness: the hash of the genesis entry alone. */
export async function fleetKeyOf(genesis: RosterEntry): Promise<string> {
  return toB64url(await crypto.subtle.digest("SHA-256", entryBytes(genesis) as BufferSource));
}

/** The period a key held a device's place, in the sequences of the fleet's snapshots. */
export interface Tenure {
  device: string;
  xpub: string | null;
  spub: string | null;
  role: RosterRole;
  from: number;
  n: number;
}

/** What a chain says now. */
export interface ChainState {
  fleet: string;
  incarnation: string;
  /** The key that signs the chain now (the genesis one, unless it was rotated). */
  owner: string;
  genesisOwner: string;
  head: { n: number; hash: string };
  /** The devices that are members, with the key each holds its place with. */
  live: Map<string, Tenure>;
  /** Caller keys (spub), by label. */
  callers: Map<string, string>;
}

/** The state a genesis entry starts: it must name an owner key and be signed by it. */
export async function begin(signed: SignedEntry, fleet: string, incarnation: string): Promise<ChainState> {
  const g = signed.entry;
  if (g[N] !== 0 || g[OP] !== "genesis" || g[PREV] !== null) throw new RosterRefusal("the roster begins with a genesis entry (n 0, no previous)", 409);
  const owner = g[EXTRA];
  if (typeof owner !== "string" || !B64URL_32_RE.test(owner)) throw new RosterRefusal("the genesis entry does not name an owner key");
  if (g[1] !== fleet) throw new RosterRefusal("the genesis entry is of another fleet (" + String(g[1]) + ")");
  // Bound to this fleet object, so that the chain of an earlier fleet of the name cannot be put under this one.
  if (g[2] !== incarnation) throw new RosterRefusal("the genesis entry is of another incarnation of this fleet than this one (" + incarnation + ")");
  if (!(await verifyEntry(g, signed.sig, owner))) throw new RosterRefusal("the genesis entry is not signed by the owner key it names", 401);
  return { fleet, incarnation, owner, genesisOwner: owner, head: { n: 0, hash: await entryHash(signed) }, live: new Map(), callers: new Map() };
}

const needStr = (value: Scalar, what: string, op: string): string => {
  if (typeof value !== "string") throw new RosterRefusal("the " + op + " entry has no " + what);
  return value;
};
const needNum = (value: Scalar, what: string, op: string): number => {
  if (typeof value !== "number") throw new RosterRefusal("the " + op + " entry has no " + what);
  return value;
};

/**
 * The state after one more entry, or a refusal: it has the next position, names the hash of the head, is of this fleet and
 * incarnation, is signed by the owner key (or, for a rotate-self, by the key the device holds its place with), and does
 * something that can be done (adds a device that is not there, removes one that is). `trusted` skips the signature, for an
 * entry that was checked when it was stored.
 */
export async function extend(state: ChainState, signed: SignedEntry, trusted = false): Promise<ChainState> {
  const e = signed.entry;
  const op = e[OP] as RosterOp;
  if (op === "genesis") throw new RosterRefusal("a roster has one genesis entry", 409);
  if (e[N] !== state.head.n + 1) throw new RosterRefusal("the entry says it is entry " + String(e[N]) + ", and the next is " + (state.head.n + 1), 409);
  if (e[PREV] !== state.head.hash) throw new RosterRefusal("the entry does not follow the head of the roster (its previous hash differs)", 409);
  if (e[1] !== state.fleet || e[2] !== state.incarnation) throw new RosterRefusal("the entry is of another fleet or incarnation than the genesis");

  const device = e[DEVICE] as string | null;
  const current = device !== null ? state.live.get(device) : undefined;
  const signer = op === "rotate-self" ? (current?.spub ?? null) : state.owner;
  if (!trusted && (signer === null || !(await verifyEntry(e, signed.sig, signer)))) {
    throw new RosterRefusal("the entry (" + op + ") is not signed by " + (op === "rotate-self" ? "the key the device holds its place with" : "the owner key"), 401);
  }

  const live = new Map(state.live);
  const callers = new Map(state.callers);
  let owner = state.owner;
  switch (op) {
    case "add": {
      const d = needStr(device, "device", op);
      const role = needStr(e[ROLE], "role", op);
      const xpub = needStr(e[XPUB], "key (xpub)", op);
      const from = needNum(e[SEQ_AT], "seqAt", op);
      needStr(e[SPUB], "signing key (spub)", op);
      if (live.has(d)) throw new RosterRefusal("the entry adds " + d + ", which is a member already", 409);
      live.set(d, { device: d, xpub, spub: e[SPUB] as string, role: role as RosterRole, from, n: e[N] as number });
      break;
    }
    case "remove": {
      const d = needStr(device, "device", op);
      const until = needNum(e[SEQ_AT], "seqAt", op);
      if (current === undefined) throw new RosterRefusal("the entry removes " + d + ", which is not a member", 409);
      if (until < current.from) throw new RosterRefusal("the entry removes " + d + " from before it was added");
      live.delete(d);
      break;
    }
    case "rotate":
    case "rotate-self": {
      const d = needStr(device, "device", op);
      const from = needNum(e[SEQ_AT], "seqAt", op);
      if (current === undefined) throw new RosterRefusal("the entry changes the key of " + d + ", which is not a member", 409);
      if (from < current.from) throw new RosterRefusal("the entry changes the key of " + d + " from before it was added");
      const spub = needStr(e[SPUB], "signing key (spub)", op);
      let xpub: string | null;
      if (op === "rotate-self") {
        if (e[XPUB] !== null && e[XPUB] !== current.xpub) throw new RosterRefusal("a rotate-self does not change the key snapshots are sealed for, which only the owner may", 409);
        xpub = current.xpub;
      } else {
        xpub = needStr(e[XPUB], "key (xpub)", op);
      }
      live.set(d, { device: d, xpub, spub, role: current.role, from, n: e[N] as number });
      break;
    }
    case "role": {
      const d = needStr(device, "device", op);
      const role = needStr(e[ROLE], "role", op);
      const from = needNum(e[SEQ_AT], "seqAt", op);
      if (current === undefined) throw new RosterRefusal("the entry changes the role of " + d + ", which is not a member", 409);
      if (from < current.from) throw new RosterRefusal("the entry changes the role of " + d + " from before it was added");
      live.set(d, { ...current, role: role as RosterRole, from, n: e[N] as number });
      break;
    }
    case "caller": {
      const key = needStr(e[SPUB], "key (spub)", op);
      callers.set(key, typeof e[EXTRA] === "string" ? e[EXTRA] : "");
      break;
    }
    case "caller-remove": {
      const key = needStr(e[SPUB], "key (spub)", op);
      if (!callers.delete(key)) throw new RosterRefusal("the entry removes a caller key that was not added", 409);
      break;
    }
    case "owner-rotate": {
      const next = needStr(e[EXTRA], "new owner key (extra)", op);
      if (typeof next !== "string" || !B64URL_32_RE.test(next)) throw new RosterRefusal("the entry names a new owner key that is not a key");
      owner = next;
      break;
    }
  }
  return { ...state, owner, live, callers, head: { n: e[N] as number, hash: await entryHash(signed) } };
}

/** The state a whole stored chain says. The signatures were checked when the entries were stored. */
export async function foldTrusted(entries: SignedEntry[], fleet: string, incarnation: string): Promise<ChainState | null> {
  if (entries.length === 0) return null;
  let state = await begin(entries[0]!, fleet, incarnation);
  for (let i = 1; i < entries.length; i++) state = await extend(state, entries[i]!, true);
  return state;
}
