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

export const FLEET_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
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
 * A member that falls further behind than this is given a whole tree again,
 * so the older snapshots are of no use to anybody.
 */
export const RECENT_SNAPSHOTS = 64;

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
  autoApprove: boolean;
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

