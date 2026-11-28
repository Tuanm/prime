// What the witness Worker is made of, apart from its exports. Kept out of
// witness.ts because a Worker module may export nothing but its handler and its
// Durable Object classes: the runtime rejects any other export at start-up.

export interface Env {
  WITNESS: DurableObjectNamespace;
  REGISTRY: DurableObjectNamespace;
  /** Optional Workers rate-limit binding; the per-isolate limiter below always runs too. */
  LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  RATE_LIMIT_MAX?: string;
  MAX_FLEETS?: string;
  /** Comma-separated base64url owner public keys whose fleets the witness holds; "*" means any owner, empty means none. */
  OWNER_KEYS?: string;
  /** Fleets one address (one /64) may create in an hour. */
  FLEET_CREATES_PER_HOUR?: string;
}

export const MAX_BODY_BYTES = 4096;
/** Devices the owner's roster has added, each holding one slot for its current key. Never displaced, never expired by idleness. */
export const MAX_DEVICES = 64;
/** Device records kept, removed ones included (a record is what stops an older entry from undoing a later one). */
export const MAX_DEVICE_RECORDS = 256;
/** Retired keys remembered, so that a replaced key cannot come back as unproven. */
export const MAX_RETIRED = 1024;
/** Signers with no proof: a small separate tier that proven signers never compete with. */
export const MAX_UNPROVEN = 8;
/** History kept per signer (its newest included), and per tier as a whole: a busy signer cannot push the rest out. */
export const ROWS_PER_PROVEN_SIGNER = 32;
export const ROWS_PER_UNPROVEN_SIGNER = 8;
export const MAX_ROWS_PROVEN = 512;
export const MAX_ROWS_UNPROVEN = 32;
export const UNPROVEN_IDLE_MS = 30 * 24 * 3600_000;
export const FLEET_IDLE_MS = 365 * 24 * 3600_000;
export const ALARM_EVERY_MS = 24 * 3600_000;
export const FUTURE_SKEW_MS = 10 * 60_000;
export const DEFAULT_RATE_PER_MINUTE = 60;
export const DEFAULT_MAX_FLEETS = 1000;
export const MAX_LIMITER_ENTRIES = 5000;
export const DEFAULT_CREATES_PER_HOUR = 10;
export const MAX_CREATE_TRACK = 5000;
export const KNOWN_TTL_MS = 5 * 60_000;
export const MAX_KNOWN = 1000;

export const FLEET_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const TOKEN_RE = /^[A-Za-z0-9._~:+=/-]{1,128}$/;

/** ["prime-cp-v1", fleetKey, fleet, incarnation, seq, manifestHash, rosterN, ts] */
export type Cp = [string, string, string, string, number, string, number | null, number];
/** ["prime-roster-v1", fleet, incarnation, n, prevHash, at, op, device, xpub, spub, role, seqAt, extra] */
export type RosterEntry = (string | number | null)[];

export interface Proof {
  /** The fleet's genesis roster entry; its sha256 is the fleetKey. Its `extra` is the owner's public key. */
  genesis?: RosterEntry;
  /** A roster entry that names the checkpoint's signer as `spub`. */
  entry: RosterEntry;
  sig: string;
  /** Set when `entry` is a rotate-self signed by this (already proven) signer; otherwise `entry` is owner-signed. */
  by?: string;
}

export interface Checkpoint {
  cp: Cp;
  sig: string;
  spub: string;
  proof?: Proof;
}

/** What a proof established, once its signatures verified. */
export type ProofResult =
  | { kind: "owner"; owner: string; device: string; n: number }
  | { kind: "rotate"; by: string; device: string; n: number };

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" };

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function fromB64url(s: string, bytes: number): Uint8Array | null {
  if (!B64URL_RE.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    if (bin.length !== bytes) return null;
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const toB64url = (b: ArrayBuffer): string => {
  let s = "";
  for (const x of new Uint8Array(b)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isToken = (v: unknown): v is string => typeof v === "string" && TOKEN_RE.test(v);
const isScalar = (v: unknown): v is string | number | null =>
  v === null || (typeof v === "string" && v.length <= 256) || (typeof v === "number" && Number.isSafeInteger(v));

function parseEntry(raw: unknown): RosterEntry | null {
  if (!Array.isArray(raw) || raw.length !== 13 || raw[0] !== "prime-roster-v1" || !raw.every(isScalar)) return null;
  return raw as RosterEntry;
}

/** The checkpoint shape, or why it is refused. */
export function parseCheckpoint(raw: unknown, now: number): { ok: true; value: Checkpoint } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "body must be an object" };
  const { cp, sig, spub, proof } = raw as Record<string, unknown>;
  if (!Array.isArray(cp) || cp.length !== 8 || cp[0] !== "prime-cp-v1") return { ok: false, error: "cp must be a prime-cp-v1 array of 8 items" };
  const [, fleetKey, fleet, incarnation, seq, manifestHash, rosterN, ts] = cp;
  if (typeof fleetKey !== "string" || !FLEET_KEY_RE.test(fleetKey)) return { ok: false, error: "cp[1] must be the fleetKey" };
  if (!isToken(fleet) || !isToken(incarnation) || !isToken(manifestHash)) return { ok: false, error: "fleet, incarnation and manifestHash must be short plain strings" };
  if (!isCount(seq)) return { ok: false, error: "seq must be a non-negative integer" };
  if (rosterN !== null && !isCount(rosterN)) return { ok: false, error: "rosterN must be a non-negative integer or null" };
  if (!isCount(ts)) return { ok: false, error: "ts must be a non-negative integer (milliseconds)" };
  if (ts > now + FUTURE_SKEW_MS) return { ok: false, error: "ts is ahead of the witness clock" };
  if (typeof sig !== "string" || typeof spub !== "string") return { ok: false, error: "sig and spub must be base64url strings" };
  const value: Checkpoint = { cp: cp as Cp, sig, spub };
  if (proof !== undefined) {
    if (typeof proof !== "object" || proof === null || Array.isArray(proof)) return { ok: false, error: "proof must be an object" };
    const p = proof as Record<string, unknown>;
    const entry = parseEntry(p.entry);
    const genesis = p.genesis === undefined ? undefined : parseEntry(p.genesis);
    if (!entry || (p.genesis !== undefined && !genesis)) return { ok: false, error: "proof entries must be prime-roster-v1 arrays of 13 plain values" };
    if (typeof p.sig !== "string" || (p.by !== undefined && typeof p.by !== "string")) return { ok: false, error: "proof sig and by must be base64url strings" };
    value.proof = { entry, sig: p.sig, ...(genesis && { genesis }), ...(p.by !== undefined && { by: p.by as string }) };
  }
  return { ok: true, value };
}

async function verify(pubB64: string, sigB64: string, message: unknown): Promise<boolean> {
  const pub = fromB64url(pubB64, 32);
  const sig = fromB64url(sigB64, 64);
  if (!pub || !sig) return false;
  try {
    const key = await crypto.subtle.importKey("raw", pub as BufferSource, "Ed25519", false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, sig as BufferSource, new TextEncoder().encode(JSON.stringify(message)) as BufferSource);
  } catch {
    return false;
  }
}

/** True when `sig` is spub's Ed25519 signature over JSON.stringify(cp). */
export const checkpointSigned = (c: Checkpoint): Promise<boolean> => verify(c.spub, c.sig, c.cp);

/** base64url(sha256(utf8(JSON.stringify(genesis entry)))): the fleetKey a genesis entry names. */
export async function fleetKeyOf(genesis: RosterEntry): Promise<string> {
  return toB64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(genesis))));
}

/**
 * Whether the proof shows the owner (or an already proven signer) put `c.spub` in the roster.
 * Stateless: the Durable Object decides whether `by` is proven. Only add/rotate entries count as
 * owner proof; a removal later in the chain is not visible here (the members judge that).
 */
export async function checkProof(c: Checkpoint, fleetKey: string): Promise<{ ok: true; result: ProofResult } | { ok: false; error: string }> {
  const proof = c.proof;
  if (!proof) return { ok: false, error: "no proof" };
  const [, , fleet, incarnation] = c.cp;
  const e = proof.entry;
  if (e[1] !== fleet || e[2] !== incarnation) return { ok: false, error: "proof entry is for another fleet or incarnation" };
  if (e[9] !== c.spub) return { ok: false, error: "proof entry does not name the signer" };
  const device = e[7];
  const n = e[3];
  if (!isToken(device) || !isCount(n)) return { ok: false, error: "proof entry must name a device (index 7) and carry its position n (index 3)" };
  if (proof.by !== undefined) {
    if (e[6] !== "rotate-self") return { ok: false, error: "a proof with `by` must be a rotate-self entry" };
    return (await verify(proof.by, proof.sig, e)) ? { ok: true, result: { kind: "rotate", by: proof.by, device, n } } : { ok: false, error: "proof signature does not verify" };
  }
  const g = proof.genesis;
  if (!g) return { ok: false, error: "an owner proof must carry the genesis entry" };
  if (g[6] !== "genesis" || g[3] !== 0 || g[1] !== fleet || g[2] !== incarnation || typeof g[12] !== "string" || !fromB64url(g[12], 32)) return { ok: false, error: "genesis entry is malformed or for another fleet" };
  if ((await fleetKeyOf(g)) !== fleetKey) return { ok: false, error: "genesis entry does not hash to the fleetKey" };
  if (e[6] !== "add" && e[6] !== "rotate") return { ok: false, error: "only add and rotate entries prove a signer" };
  return (await verify(g[12], proof.sig, e)) ? { ok: true, result: { kind: "owner", owner: g[12], device, n } } : { ok: false, error: "proof signature does not verify" };
}

/**
 * Whether a fleet of this genesis owner may live here: the owner must be one of OWNER_KEYS. An empty
 * list allows nobody, so a witness deployed without one is closed, never open by accident; "*" allows any.
 */
export function ownerAllowed(env: Env, owner: string): boolean {
  const list = (env.OWNER_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  return list.includes("*") || list.includes(owner);
}

export interface Removal {
  device: string;
  n: number;
}

/** An owner-signed `remove` entry for a device of this fleet: {genesis, entry, sig}. Public in the roster chain, so anyone may post it. */
export async function checkRemoval(raw: unknown, fleetKey: string): Promise<{ ok: true; removal: Removal } | { ok: false; error: string }> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "body must be an object" };
  const r = raw as Record<string, unknown>;
  const g = parseEntry(r.genesis);
  const e = parseEntry(r.entry);
  if (!g || !e || typeof r.sig !== "string") return { ok: false, error: "genesis, entry and sig are required" };
  if (g[6] !== "genesis" || g[3] !== 0 || typeof g[12] !== "string" || !fromB64url(g[12], 32)) return { ok: false, error: "genesis entry is malformed" };
  if ((await fleetKeyOf(g)) !== fleetKey) return { ok: false, error: "genesis entry does not hash to the fleetKey" };
  if (e[6] !== "remove" || e[1] !== g[1] || e[2] !== g[2]) return { ok: false, error: "entry must be a remove of this fleet" };
  const device = e[7];
  const n = e[3];
  if (!isToken(device) || !isCount(n)) return { ok: false, error: "remove entry must name a device (index 7) and carry its position n (index 3)" };
  if (!(await verify(g[12], r.sig, e))) return { ok: false, error: "signature does not verify" };
  return { ok: true, removal: { device, n } };
}

/** The body, or null when it is longer than `max` bytes. Stops reading at the cap. */
export async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

// ---- rate limiting ------------------------------------------------------

/**
 * The limiter key for an address: the address itself for IPv4 (and for an IPv4-mapped IPv6 address, which is
 * the same machine), the /64 for IPv6 (one subscriber holds 2^64 of them).
 */
export function limiterKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  let text = ip.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = text.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, tail] = text.split("::", 2) as [string, string | undefined];
  const front = head === "" ? [] : head.split(":");
  const back = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups = (tail === undefined ? front : [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back]).map((g) => parseInt(g || "0", 16) || 0);
  if (groups.length === 8 && groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`;
  }
  return "v6:" + groups.slice(0, 4).map((g) => g.toString(16)).join(":");
}

// A fixed-window counter per limiter key, per isolate, in a map that cannot grow
// past MAX_LIMITER_ENTRIES: when full, the oldest entry goes (O(1)), and expired
// ones are swept at most every 10 s. Cloudflare runs many isolates, so the
// LIMITER binding (when configured) is the real limit.
const windows = new Map<string, { n: number; reset: number }>();
let lastSweep = 0;
function allowLocal(key: string, max: number, now: number): boolean {
  const w = windows.get(key);
  if (w && now <= w.reset) return ++w.n <= max;
  if (w) windows.delete(key);
  if (windows.size >= MAX_LIMITER_ENTRIES) {
    if (now - lastSweep > 10_000) {
      lastSweep = now;
      for (const [k, v] of windows) if (now > v.reset) windows.delete(k);
    }
    if (windows.size >= MAX_LIMITER_ENTRIES) windows.delete(windows.keys().next().value as string);
  }
  windows.set(key, { n: 1, reset: now + 60_000 });
  return true;
}
/** Test hook: forget every counted request and every fleet known to this isolate. */
export function resetRateLimit(): void {
  windows.clear();
  lastSweep = 0;
  knownFleets.clear();
}

// Fleets this isolate has seen the registry confirm, for a few minutes, so a
// request for a held fleet does not ask the registry (one object for every
// request). Only positive answers are kept: a fleet deleted since is told apart
// by the fleet object, which refuses a first post without the owner's proof.
const knownFleets = new Map<string, number>();
export function rememberKnown(key: string, now: number): void {
  if (knownFleets.size >= MAX_KNOWN) knownFleets.delete(knownFleets.keys().next().value as string);
  knownFleets.set(key, now + KNOWN_TTL_MS);
}
export function forgetKnown(key: string): void {
  knownFleets.delete(key);
}
export function isKnownHere(key: string, now: number): boolean {
  const until = knownFleets.get(key);
  if (until === undefined) return false;
  if (now > until) {
    knownFleets.delete(key);
    return false;
  }
  return true;
}
export const limiterSize = (): number => windows.size;

export type Admission = "ok" | "limited" | "degraded";

/**
 * "limited": over the limit. "degraded": the binding failed, only the per-isolate counter ran. The
 * Worker serves reads and known fleets on "degraded" but refuses to create a fleet.
 */
export async function admit(req: Request, env: Env, now: number): Promise<Admission> {
  const key = limiterKey(req.headers.get("cf-connecting-ip") ?? "unknown");
  const max = Math.max(1, Number(env.RATE_LIMIT_MAX) || DEFAULT_RATE_PER_MINUTE);
  if (!allowLocal(key, max, now)) return "limited";
  if (!env.LIMITER) return "ok";
  try {
    return (await env.LIMITER.limit({ key })).success ? "ok" : "limited";
  } catch {
    return "degraded";
  }
}
