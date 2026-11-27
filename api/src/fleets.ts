// Fleet membership: who is allowed to take part in a fleet, and how a new
// member proves it is the one the operator meant to admit.
//
// Model
//   A *device* is the existing unit of identity: a deviceId plus a per-device
//   secret, already enforced by authorizeDevice(). A *fleet* is a named group
//   of devices with one owner. A *member* is a device admitted to a fleet.
//
// Two credentials, two different jobs
//   - gateway token: operator authority (create a fleet, mint an invite,
//     approve/remove a member). Never leaves the operator's machine.
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
export const MAX_PENDING = 32;
/**
 * How long a fleet's owner may be silent before a member may clean it up.
 */
export const OWNER_SILENCE_MS = 24 * 60 * 60_000;

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
 * A Worker has 128 MB for everything it holds. The body is read whole (`arrayBuffer`), then hashed
 * (`crypto.subtle.digest` takes its own copy), then handed to R2 (`put` takes another): up to three
 * times its size at once, with the Worker's own few tens of MB on top. That puts the largest body that is
 * certain to fit near 36 MB, and a round 32 MiB is used. An upload that goes over would be killed by the
 * runtime with nothing said, so it is refused first, with its size and the limit. Going beyond it takes
 * an upload that is streamed to R2 and hashed as it goes, which the object store's API needs the length
 * of up front for: it is not done.
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

export interface Member {
  deviceId: string;
  role: "owner" | "member";
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
   * What the operator reads in the list: the space's name, as the space itself
   * gives it on every round. It is not an identity - the id is - and a space
   * that was renamed says so the next time it takes its place.
   */
  label?: string;
}

export interface PendingRequest {
  deviceId: string;
  label?: string;
  /** The member's public key for content encryption, when it offered one. */
  pubkey?: string;
  requestedAt: number;
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
 * A short fingerprint of a member's public key (base64), to tell its keys apart: the first eight bytes
 * of the key's SHA-256, in base64. It is the same as the KEY column of `prime fleets members`, so what
 * the operator sees here can be compared with what a member's own machine prints. "" for a key that is
 * not base64.
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
