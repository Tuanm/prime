// Fleet membership: who is allowed to take part in a fleet, and how a new
// member proves it is the one the operator meant to admit.
//
// Model
//   A *device* is the existing unit of identity: a deviceId plus a per-device
//   secret, already enforced by authorizeDevice(). A *fleet* is a named group
//   of devices with one owner. A *member* is a device admitted to a fleet.
//
// Two credentials, two different jobs
//   - fleet operator token (FLEET_OPERATOR_TOKEN): operator authority (create a fleet, mint an
//     invite, approve/remove a member). Not the gateway token, which every client of the gateway
//     holds; the admin page, behind Access, is the operator too.
//   - device token: the identity of one device. A device can only ever act as
//     itself, because the Worker proves it against the device registry before
//     the Durable Object sees the request.
//
// The invite is what makes an admission deliberate: a single-use, short-lived
// code that the operator hands to the new device out of band. Knowing the fleet
// name is not enough to join, and a leaked code cannot be replayed.

// A fleet id doubles as the id of the device that reaches it, so it must not
// be one the gateway gives out: anon- is where the anonymous devices live.
export const FLEET_ID_RE = /^(?!anon-)[a-z0-9][a-z0-9-]{0,31}$/;
export const INVITE_PREFIX = "pf1_";
export const INVITE_DEFAULT_TTL_MS = 10 * 60 * 1000;
export const INVITE_MAX_TTL_MS = 60 * 60 * 1000;
export const MAX_MEMBERS = 32;

/**
 * How long a place in a fleet lasts without being renewed, and the bounds an operator may move it between.
 *
 * The default is forty-five seconds: comfortably more than the slowest agent's heartbeat (an agent renews
 * every third of the lease, at most every fifteen seconds), so a live primary never loses the place between two
 * renewals. A longer lease makes the fleet cheaper (each renewal is a request and storage rows) and its
 * failover slower (a primary that dies is replaced when the lease runs out, so up to one lease later); a
 * shorter one the other way round. Below thirty seconds an agent of the earlier builds, renewing at fifteen,
 * would have fewer than two renewals in a lease and could lose the place to a single late one; above three
 * minutes a crashed primary leaves the fleet without one for too long to be a failover at all.
 */
export const LEASE_DEFAULT_MS = 45_000;
export const LEASE_MIN_MS = 30_000;
export const LEASE_MAX_MS = 180_000;

/** The smallest the floor may be set to (FLEET_LEASE_MIN_MS, for a test that must see a lease run out in seconds). */
const LEASE_MIN_FLOOR_MS = 1_000;

/** The bounds in force: the constants, with the floor lowered by FLEET_LEASE_MIN_MS where it is set. */
export function leaseBounds(env: { FLEET_LEASE_MIN_MS?: string }): { min: number; max: number } {
  const asked = Number(env.FLEET_LEASE_MIN_MS);
  const min = Number.isFinite(asked) && asked >= LEASE_MIN_FLOOR_MS && asked <= LEASE_MIN_MS ? Math.floor(asked) : LEASE_MIN_MS;
  return { min, max: LEASE_MAX_MS };
}

/**
 * The lease a fleet is run with: what its operator set (`meta.leaseMs`), else the gateway's FLEET_LEASE_MS,
 * else forty-five seconds, held between the bounds. A value that is not a number is not used.
 */
export function effectiveLeaseMs(fleetMs: number | undefined, env: { FLEET_LEASE_MS?: string; FLEET_LEASE_MIN_MS?: string }): number {
  const { min, max } = leaseBounds(env);
  const fromEnv = Number(env.FLEET_LEASE_MS);
  const chosen = typeof fleetMs === "number" && Number.isFinite(fleetMs) ? fleetMs : Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : LEASE_DEFAULT_MS;
  return Math.min(max, Math.max(min, Math.round(chosen)));
}

/**
 * What a member says it can do (`caps` in its bootstrap): a short list of lowercase names, so that a format
 * is used only when every member can read it. A malformed entry is dropped, the list is cut at sixteen, and
 * it is sorted and without repeats, so that two lists that say the same thing are equal.
 */
export const MAX_CAPS = 16;
export function cleanCaps(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const c of raw) {
    if (typeof c === "string" && /^[a-z0-9][a-z0-9-]{0,23}$/.test(c)) out.add(c);
    if (out.size >= MAX_CAPS) break;
  }
  return [...out].sort();
}

/** What every one of the lists has: a member that says nothing has nothing, so the answer is then empty. */
export function commonCaps(lists: Array<readonly string[] | undefined>): string[] {
  if (lists.length === 0) return [];
  let common = new Set(lists[0] ?? []);
  for (const list of lists.slice(1)) {
    const have = new Set(list ?? []);
    common = new Set([...common].filter((c) => have.has(c)));
  }
  return [...common].sort();
}
export const MAX_PENDING = 32;
/**
 * How long a fleet must have been untouched before it can be cleared away as abandoned (see `reap`).
 *
 * It is a second condition beside "the gateway knows none of its members": a fleet that is paused
 * records no activity at all, and a fleet whose members never came back after a long weekend is
 * not abandoned. Only the operator or the fleet's owner may delete a fleet otherwise.
 */
export const REAP_SILENCE_MS = 7 * 24 * 60 * 60_000;

/**
 * How many snapshots a fleet keeps.
 *
 * The primary publishes a whole tree every 32 snapshots and only the change in
 * between, and a member that fell behind catches up from the newest whole tree
 * and the changes after it. That is never more than 32 snapshots back, so
 * keeping at least twice the interval keeps everything such a member needs, no
 * matter how far behind it is. Older snapshots are of no use to anybody.
 */
export const RECENT_SNAPSHOTS = 64;

/**
 * The most one upload (a snapshot, the manifest and the sealed pack, or one change pack) may be.
 *
 * An isolate has 128 MB, and that is shared by every request it is serving at that moment, not given to
 * each. One upload is read whole (`arrayBuffer`), then hashed (`crypto.subtle.digest` may take its own copy),
 * then handed to R2 (`put` may take another): up to three times its size at once, on top of what the isolate
 * already holds. 32 MiB is therefore a budget, not a guarantee: one such upload leaves room for the others
 * that arrive with it, and several large ones at once can still exhaust it. The limit is a choice that keeps
 * the usual case well inside the memory, and an upload over it is refused first, with its size and the limit,
 * rather than killed by the runtime with nothing said. Going beyond it takes an upload that is streamed to R2
 * and hashed as it goes; R2 needs the length of a stream up front, so it is not done.
 */
export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;

/** How many fleets one device may create in an hour. */
export const MAX_FLEETS_PER_DEVICE = 5;

/**
 * How many fleets each device has created recently.
 *
 * The count is kept in one place that every device shares, because a count
 * kept per fleet would be fresh for every new fleet and so would never
 * count anything.
 */
export class FleetCreationAllowance {
  private readonly byDevice = new Map<string, number[]>();

  constructor(
    private readonly limit: number = MAX_FLEETS_PER_DEVICE,
    private readonly windowMs: number = 60 * 60_000,
  ) {}

  /** How many fleets this device created inside the window. */
  count(deviceId: string, now: number = Date.now()): number {
    const recent = this.prune(deviceId, now);
    this.byDevice.set(deviceId, recent);
    return recent.length;
  }

  /** Record a fleet creation and return the new count. */
  record(deviceId: string, now: number = Date.now()): number {
    const recent = this.prune(deviceId, now);
    recent.push(now);
    this.byDevice.set(deviceId, recent);
    return recent.length;
  }

  /** Whether the device may create another fleet. */
  allows(deviceId: string, now: number = Date.now()): boolean {
    return this.count(deviceId, now) < this.limit;
  }

  private prune(deviceId: string, now: number): number[] {
    return (this.byDevice.get(deviceId) ?? []).filter((at) => now - at < this.windowMs);
  }
}

/**
 * What a member is. The owner runs the fleet and a member takes part in it. A viewer is sealed for like the others
 * (it can read every snapshot) and is refused every write by the gateway: it holds no lease, takes no claim, and cannot
 * make the fleet's tools be called. That refusal is the gateway's alone: the members do not yet treat a viewer's key as a
 * reader's (see docs/fleets.md).
 */
export type MemberRole = "owner" | "member" | "viewer";

export interface Member {
  deviceId: string;
  role: MemberRole;
  addedAt: number;
  addedBy: string;
  /**
   * The member's public key for content encryption, base64.
   *
   * A member publishes snapshots sealed for the members' keys, so the gateway
   * stores ciphertext it cannot open. The key is public, so it is not a
   * secret: it is the half the gateway is not given.
   */
  pubkey?: string;
  /**
   * The member's Ed25519 key for signing (base64url of the raw 32 bytes), as it said it when it joined or took its place.
   * The signed roster names it (and the key above) for each member; it is the member's word until the operator has compared
   * it with what the member's own machine prints and signed it in.
   */
  spub?: string;
  /**
   * What the operator reads in the list: the space's name, as the space itself
   * gives it on every round. It is not an identity - the id is - and a space
   * that was renamed says so the next time it takes its place.
   */
  label?: string;
  /**
   * What the member can do, as it said in its last bootstrap (see `cleanCaps`). Absent for a member that
   * says nothing (an earlier build). It is the member's word: a gateway that lies about it can only keep
   * the older format in use or make a member that cannot read a newer one fail to open it.
   */
  caps?: string[];
}

export interface PendingRequest {
  deviceId: string;
  label?: string;
  /** The member's public key for content encryption, when it offered one. */
  pubkey?: string;
  /** The member's Ed25519 signing key (see `Member.spub`). */
  spub?: string;
  /** Set when the device asks to be a viewer. It is a wish: the one who admits decides. */
  role?: "viewer";
  requestedAt: number;
  /**
   * Set when the device is already a member and this is the key it asks to have instead of the one
   * the fleet holds (it could not prove it held the old one). Approving it replaces the key.
   */
  keyChange?: true;
}

/** What a member sends to change its key without the operator: the old key's proof (see `keyChangeMessage`). */
export interface KeyProof {
  ts: number;
  nonce: string;
  mac: string;
}

/** The label that domain-separates a key-change proof, for the HKDF and the message alike. */
export const KEY_PROOF_INFO = "prime-fleet-key-change-v1";
/** How far a proof's own clock may be from the object's. */
export const KEY_PROOF_WINDOW_MS = 10 * 60_000;

/**
 * What a key-change proof is a MAC of: the key it asks for, the fleet and the device it is for, and
 * when and once. A JSON array, so no field can run into the next.
 */
export function keyChangeMessage(newPubkey: string, fleetId: string, deviceId: string, ts: number, nonce: string): string {
  return JSON.stringify([KEY_PROOF_INFO, newPubkey, fleetId, deviceId, ts, nonce]);
}

/** A proof as a request carries it, or undefined when it is not shaped like one. */
export function cleanKeyProof(raw: unknown): KeyProof | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.ts !== "number" || !Number.isFinite(r.ts)) return undefined;
  if (typeof r.nonce !== "string" || !/^[A-Za-z0-9+/_=-]{16,64}$/.test(r.nonce)) return undefined;
  if (typeof r.mac !== "string" || !/^[A-Za-z0-9+/_=-]{43,88}$/.test(r.mac)) return undefined;
  return { ts: r.ts, nonce: r.nonce, mac: r.mac };
}

export interface Invite {
  codeHash: string;
  expiresAt: number;
  createdBy: string;
  createdAt: number;
}

export function validFleetId(id: string): boolean {
  return FLEET_ID_RE.test(id);
}

// base64url without padding: short enough to read aloud, wide enough that
// guessing is not a strategy (192 bits).
export function newInviteCode(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return INVITE_PREFIX + btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function inviteShape(code: string): boolean {
  if (!code.startsWith(INVITE_PREFIX)) return false;
  return /^[A-Za-z0-9_-]{32}$/.test(code.slice(INVITE_PREFIX.length));
}

// Invites are stored as a hash. A dump of the Durable Object's storage must not
// yield usable codes.
export async function hashCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("prime-invite:" + code));
  let hex = "";
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export function clampTtl(ttlMs: number | undefined): number {
  if (!ttlMs || !Number.isFinite(ttlMs) || ttlMs <= 0) return INVITE_DEFAULT_TTL_MS;
  return Math.min(Math.round(ttlMs), INVITE_MAX_TTL_MS);
}

// A label is shown to the operator so they can tell requests apart. It is
// cosmetic: never trust it as identity.
/**
 * A member's public key: base64 of a 32 byte X25519 public key.
 *
 * The shape is checked here so a malformed key cannot reach the Durable
 * Object, and so a member cannot smuggle an arbitrary string into the roster.
 */
export function cleanPubkey(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(trimmed)) return undefined;
  return trimmed;
}

/** A member's Ed25519 signing key as it is told to the gateway: base64url of 32 raw bytes. */
export function cleanSpub(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return /^[A-Za-z0-9_-]{43}$/.test(trimmed) ? trimmed : undefined;
}

export function cleanLabel(label: unknown): string | undefined {
  if (typeof label !== "string") return undefined;
  const trimmed = label.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 48);
  return trimmed.length > 0 ? trimmed : undefined;
}

export interface FleetAuth {
  /** true when the caller proved the gateway token (operator authority). */
  admin: boolean;
  /** the authenticated device, when the caller proved a device token. */
  deviceId?: string;
}


/**
 * Whether a device holds a tunnel right now, when the answer is to be acted on (a lease is taken
 * from a primary that is not).
 *
 * The registry's snapshot is kept for a couple of seconds, and a tunnel that came up since it was
 * read is not in it: a primary that took the lease the moment its tunnel opened would be found
 * "not connected" by the first replica that asked, and lose the lease it had taken a second ago. So
 * a snapshot that says yes is believed, and one that says no is checked against a fresh one - once
 * for `negativeTtlMs`: a device that is really offline is not worth a read of the whole registry (one
 * object for the gateway) on every call that is addressed to its fleet.
 */
export async function onlineNow(
  deviceId: string,
  cached: () => Promise<Set<string>>,
  /** A snapshot of who is online that was read no earlier than `notBefore` (a time), when that is given. */
  fresh: (notBefore?: number) => Promise<Set<string>>,
  /** When each device was last found offline by a fresh read; the caller keeps it between calls. */
  offlineAt: Map<string, number> = new Map(),
  negativeTtlMs = 2_000,
  now: () => number = Date.now,
  /**
   * When the device took the place the answer is about (its lease). A tunnel that opened after the
   * last verdict is what a device that has just taken its place has, so an offline verdict from before
   * it - cached or read - says nothing about it: it is looked for again, for the first `negativeTtlMs`.
   */
  since?: number,
): Promise<boolean> {
  if ((await cached()).has(deviceId)) return true;
  const known = offlineAt.get(deviceId);
  const young = since !== undefined && now() - since < negativeTtlMs;
  if (known !== undefined && now() - known < negativeTtlMs && !(young && known <= since!)) return false;
  const online = (await fresh(young ? since : undefined)).has(deviceId);
  if (online) offlineAt.delete(deviceId);
  else {
    if (offlineAt.size >= 256) offlineAt.clear(); // devices come and go: the map is a cache, not a record
    offlineAt.set(deviceId, now());
  }
  return online;
}

/**
 * A short id of a member's public key (base64), to tell its keys apart: the first eight bytes of the
 * key's SHA-256, in base64. It is what earlier builds of the CLI print as the KEY column of
 * `prime fleets members`, and what an approval from one of them names. "" for a key that is not base64.
 */
export async function keyFingerprint(pubkeyB64: string): Promise<string> {
  try {
    const raw = Uint8Array.from(atob(pubkeyB64), (c) => c.charCodeAt(0));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
    return btoa(String.fromCharCode(...digest.subarray(0, 8)));
  } catch {
    return "";
  }
}

/**
 * The fingerprint a person compares, as the CLI prints it (`keyFingerprintOf`): the first sixteen bytes
 * (128 bits) of the key's SHA-256 as two halves of base64, padding left off, joined by a dot. The first
 * half is the short id above, without its "=", so a member on an earlier build can still be compared with.
 * "" for a key that is not base64.
 */
export async function keyFingerprintLong(pubkeyB64: string): Promise<string> {
  try {
    const raw = Uint8Array.from(atob(pubkeyB64), (c) => c.charCodeAt(0));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
    const half = (from: number): string => btoa(String.fromCharCode(...digest.subarray(from, from + 8))).replace(/=+$/, "");
    return half(0) + "." + half(8);
  } catch {
    return "";
  }
}

/**
 * Whether a fingerprint a caller names is of this key: the whole one, or the short one an earlier build
 * of the CLI names (its first half). Spaces, dots and padding are not part of it, so it can be copied as
 * printed or as typed in two halves. An approval is matched against the key that was read, so that a
 * request replaced since is not approved by mistake; the comparison with the member's own machine is the
 * person's, and is made on the whole one.
 */
export async function keyFingerprintMatches(named: string, pubkeyB64: string): Promise<boolean> {
  const whole = await keyFingerprintLong(pubkeyB64);
  if (whole === "") return false;
  const plain = (s: string): string => s.replace(/[\s.=]/g, "");
  const given = plain(named);
  const full = plain(whole);
  return given !== "" && (given === full || given === full.slice(0, 11));
}

/** What a member says (in `caps`) when it takes a small snapshot from the event that announces it, instead of asking for it. */
export const INLINE_CAP = "inline";
/** The most a pack may be and still ride in the socket message that announces its snapshot. */
export const INLINE_PACK_BYTES = 64 * 1024;
/** The most of a manifest that rides there (its text, in characters). */
export const INLINE_MANIFEST_CHARS = 128 * 1024;

const hex = (digest: ArrayBuffer): string => Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The manifest and pack of a small snapshot, as they go in the `head` event: only when they are what the manifest key
 * says they are, so that no listener is handed bytes that the key it GETs them by would not give.
 *
 * `manifest` must be the text whose SHA-256 is `manifestHash` (the id in `manifestKey`), and the pack (`pack`, standard
 * base64) the one whose SHA-256 the manifest names as `packHash`; the pack is at most 64 KiB, the snapshot is not a whole tree
 * (`full`), and it is not one that comes in chunks. Anything else is undefined, and the event carries no `inline`: the
 * member GETs as it always did. The members check what they take from here again (an id is a hash of its bytes).
 */
export async function checkedInline(
  asked: unknown,
  manifestKey: string,
  manifestHash: string,
  fleetId: string,
  full: boolean,
): Promise<{ manifest: string; pack: string } | undefined> {
  if (full || asked === null || typeof asked !== "object") return undefined;
  const { manifest, pack } = asked as { manifest?: unknown; pack?: unknown };
  if (typeof manifest !== "string" || typeof pack !== "string") return undefined;
  if (manifest.length === 0 || manifest.length > INLINE_MANIFEST_CHARS) return undefined;
  if (pack.length === 0 || pack.length > Math.ceil(INLINE_PACK_BYTES / 3) * 4) return undefined;
  if (manifestKey !== "fleets/" + fleetId + "/manifests/" + manifestHash) return undefined;
  try {
    if (hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(manifest))) !== manifestHash) return undefined;
    const parsed = JSON.parse(manifest) as { packHash?: unknown; chunks?: unknown; full?: unknown };
    if (parsed.full === true || parsed.chunks !== undefined || typeof parsed.packHash !== "string") return undefined;
    const bytes = Uint8Array.from(atob(pack), (c) => c.charCodeAt(0));
    if (bytes.length === 0 || bytes.length > INLINE_PACK_BYTES) return undefined;
    if (hex(await crypto.subtle.digest("SHA-256", bytes)) !== parsed.packHash) return undefined;
    return { manifest, pack };
  } catch {
    return undefined;
  }
}
