// Cloudflare Worker entry for the code-mcp gateway.
//
// Routing model:
//   GET  /admin                   -> admin UI (Cloudflare Access protected)
//   GET  /admin/api/devices       -> device registry (admin token)
//   POST /admin/api/devices       -> register/update a device (admin token)
//   DELETE /admin/api/devices/{id}-> remove a device (admin token)
//   GET  /devices                 -> online deviceIds (admin token)
//   POST /device/{deviceId}       -> gateway auth + rate limit -> DeviceDO
//        (/mcp/{deviceId} stays as an alias for older clients)
//   GET  /sse/{deviceId}          -> gateway auth + rate limit -> DeviceDO SSE stream
//   POST /messages/{deviceId}     -> SSE client->server leg (202 + stream response)
//   WS   /ws/{deviceId}           -> device auth + origin check -> DeviceDO upgrade
//   WS   /ws?deviceId=            -> legacy path -> DeviceDO upgrade
//   POST /api/devices/anonymous   -> create an anonymous device (generated id + 25-char code)
//   /admin/api/anonymous/{ref}... -> admin actions on anonymous devices, by opaque ref
//
// All device state (WebSocket + pending requests) lives in a DeviceDO keyed by
// deviceId, so every HTTP request finds the right tunnel regardless of which
// isolate handled it. The device registry is writable and lives in the
// RegistryDO (durable storage), seeded once from the DEVICE_TOKENS secret, so
// the admin UI can register devices at runtime without a redeploy. It keeps a
// verifier per device (src/token-hash.ts), never the token.

import { anonConfig, anonLockKey, loadConfig, timingSafeEq, extractToken, extractDeviceToken, validDeviceId, virtualDeviceIds } from "./config";
import { fingerprint, isVerifier, pepperFrom, pepperMissingResponse, tokenVerifies } from "./token-hash";
import type { Env, GatewayConfig } from "./config";
import { RateLimiter, clientIp } from "./rate-limit";
import { readBounded, readBoundedText } from "./body";
import { INVITE_CHECK_BODY_MAX, limitAsk } from "./fleet-limits";
import { ADMIN_HTML } from "./admin-ui";
import { LANDING_HTML } from "./landing-page";
import { HOME_HTML } from "./home-page";
import { JOIN_HTML } from "./join-page";
import { SECURITY_HTML } from "./security-page";
import { handleCloudMcp } from "./cloud-device";
import { handleFiles } from "./files-routes";
import { handleFleetRoutes, markSeen } from "./fleets-routes";
import { keyFingerprintLong, onlineNow, validFleetId } from "./fleets";
import { sendUsage, takeFleetR2 } from "./usage";
import { handleSandbox, handleSandboxDevicePage, verifyTicket } from "./sandbox";
import { effectiveDisabledSet, invalidateDisabledCache } from "./device-state";
import { ipBlockKey } from "./config";
import { verifyAccessJwt } from "./access";
import { sandboxAsset } from "./sandbox-assets";

export { DeviceDO } from "./device-do";
export { RegistryDO } from "./registry-do";
export { CodingSandbox } from "./coding-sandbox";
export { FilesDO } from "./files-do";
export { FleetDO } from "./fleet-do";

const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401 });

// Per-isolate rate limiter. Configured once on first fetch (module scope is
// shared across requests within an isolate; a fresh isolate re-creates it).
let rateLimiter: RateLimiter | null = null;
let limiterWindowMs = 0;
let limiterMax = 0;

// Effective device->token map, backed by the RegistryDO (durable storage).
// Cached briefly per isolate; admin mutations invalidate the local cache and
// other isolates pick the change up within the TTL.
interface RegistrySnapshot {
  map: Map<string, string>; // deviceId -> token (registered, anonymous and virtual)
  anon: Set<string>; // which of those are anonymous
  locked: Set<string>; // (device, address) pairs locked after too many wrong codes: see anonLockKey
  buddies: Map<string, string>; // fleetId -> the token its clients present
  online: Set<string>; // which devices hold a tunnel right now
  paused: Set<string>; // the fleets the operator has paused
  blocked: Set<string>; // address keys that reach nothing (see ipBlockKey)
  disabled: Set<string>; // devices the operator switched off
}
let mapCache: { at: number; snap: RegistrySnapshot } | null = null;

// What this isolate has served, sent on in batches: a write per request would
// cost more than it measures.
let gatewayHits = 0;
let gatewayHitsAt = 0;
function noteGatewayRequest(env: Env): void {
  gatewayHits += 1;
  const now = Date.now();
  if (gatewayHits < 200 && now - gatewayHitsAt < 60_000) return;
  const count = gatewayHits;
  const r2 = takeFleetR2();
  gatewayHits = 0;
  gatewayHitsAt = now;
  void sendUsage(env.REGISTRY.get(env.REGISTRY.idFromName("global")), {
    gatewayRequests: count,
    r2Writes: r2.writes,
    r2Reads: r2.reads,
  });
}

// The month's spend, as the registry last told this isolate. Cached for a
// moment: the budget is a monthly ceiling, not a per-request one.
let usageCache: { at: number; spentUsd: number; budgetUsd: number; over: boolean } | null = null;

async function fleetBudgetSpent(env: Env): Promise<{ over: boolean; spentUsd: number; budgetUsd: number }> {
  if (usageCache && Date.now() - usageCache.at < 30_000) {
    return { over: usageCache.over, spentUsd: usageCache.spentUsd, budgetUsd: usageCache.budgetUsd };
  }
  try {
    const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
    const res = await reg.fetch("https://registry/usage");
    if (res.ok) {
      const body = (await res.json()) as { spentUsd?: number; budgetUsd?: number; overBudget?: boolean };
      const spentUsd = Number(body.spentUsd ?? 0);
      const budgetUsd = Number(body.budgetUsd ?? 0);
      const over = body.overBudget === true || spentUsd >= budgetUsd;
      usageCache = { at: Date.now(), spentUsd, budgetUsd, over };
      return { over, spentUsd, budgetUsd };
    }
  } catch {}
  return { over: false, spentUsd: 0, budgetUsd: 0 };
}
const MAP_CACHE_TTL_MS = 2_000;

// Relay requests that authenticated as an anonymous device. Their lower
// budget (ANON_RATE_LIMIT_MAX per client IP per RATE_LIMIT_WINDOW_MS) is
// enforced by the device's DeviceDO, which every one of its requests reaches -
// so it holds globally, not per isolate. The forwarders mark the DO request.
const anonymousRequests = new WeakSet<Request>();

function markAnonymous(headers: Headers, request: Request, cfg: GatewayConfig, env: Env): void {
  if (!anonymousRequests.has(request)) return;
  headers.set("x-anon-rate-max", String(anonConfig(env).rateMax));
  headers.set("x-anon-rate-window-ms", String(cfg.rateWindowMs));
  const cip = clientIp(request);
  headers.set("x-client-ip", cip && cip !== "unknown" ? cip : "unknown");
}

// The blocked address keys (see ipBlockKey) travel in the registry snapshot:
// one ask of the registry per request, not one per list the gateway checks.
// Changing them invalidates the snapshot.
async function effectiveBlockedSet(env: Env): Promise<Set<string>> {
  return (await effectiveSnapshot(env)).blocked;
}

function invalidateBlockedCache(): void {
  mapCache = null;
}

/** A device's tunnel origin, plus the address key blocking would use. */
async function originFor(env: Env, stub: DurableObjectStub): Promise<Response> {
  const r = await stub.fetch("https://device/origin");
  const body = (await r.json().catch(() => ({}))) as { online?: boolean; origin?: { ip?: string } | null };
  const origin = body.origin && typeof body.origin === "object" ? body.origin : null;
  const key = origin ? ipBlockKey(String(origin.ip || "")) : null;
  const blocked = key ? (await effectiveBlockedSet(env)).has(key) : false;
  return Response.json({ online: !!body.online, origin, block_key: key, blocked });
}

/** Drop this device's live tunnel. Called when it is disabled, removed or
 *  given a new token: an open socket authenticated with the old credential must
 *  not stay connected. */
async function kickDeviceTunnel(env: Env, deviceId: string): Promise<boolean> {
  try {
    const r = await env.DEVICES.get(env.DEVICES.idFromName(deviceId)).fetch(new Request("https://device/disconnect", { method: "POST" }));
    if (!r.ok) return false;
    return ((await r.json()) as { hadTunnel?: boolean }).hadTunnel === true;
  } catch {
    return false;
  }
}

// Per-device auth mode must be driven ONLY by real (tunnel) device tokens.
// Anonymous devices do not count either: creating one must not flip an open
// gateway into per-device mode and lock out every unregistered device.
// The in-process virtual devices (e.g. the built-in "cloud" worker device) are a
// separate concern: they must NOT force every tunnel deviceId into per-device
// mode, or a gateway that is only running the cloud device would 401 any
// unregistered tunnel device (silently disabling open / shared-token access).
function hasNonVirtualDevice(snap: RegistrySnapshot, env: Env): boolean {
  const virt = virtualDeviceIds(env);
  for (const id of snap.map.keys()) if (!virt.has(id) && !snap.anon.has(id)) return true;
  return false;
}

// Always read the authoritative registry snapshot, bypassing the TTL cache.
async function freshSnapshot(env: Env): Promise<RegistrySnapshot> {
  const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
  const snap: RegistrySnapshot = {
    map: new Map(),
    anon: new Set(),
    locked: new Set(),
    buddies: new Map(),
    online: new Set(),
    paused: new Set(),
    blocked: new Set(),
    disabled: new Set(),
  };
  try {
    const r = await reg.fetch("https://registry/map");
    if (r.ok) {
      const j = (await r.json()) as {
        map?: Record<string, string>;
        anonymous?: string[];
        locked?: string[];
        buddies?: Record<string, string>;
        online?: string[];
        paused?: string[];
        blocked?: string[];
        disabled?: string[];
      };
      for (const [id, tok] of Object.entries(j.map || {})) {
        if (typeof tok === "string" && tok.length > 0) snap.map.set(id, tok);
      }
      for (const id of j.anonymous || []) snap.anon.add(id);
      for (const id of j.locked || []) snap.locked.add(id);
      for (const [id, tok] of Object.entries(j.buddies || {})) {
        if (typeof tok === "string" && tok.length > 0) snap.buddies.set(id, tok);
      }
      for (const id of j.online || []) snap.online.add(id);
      for (const id of j.paused || []) snap.paused.add(id);
      for (const key of j.blocked || []) if (typeof key === "string" && key) snap.blocked.add(key);
      for (const id of j.disabled || []) if (validDeviceId(id)) snap.disabled.add(id);
    }
  } catch {}
  return snap;
}

export async function effectiveSnapshot(env: Env): Promise<RegistrySnapshot> {
  if (mapCache && Date.now() - mapCache.at < MAP_CACHE_TTL_MS) return mapCache.snap;
  const snap = await freshSnapshot(env);
  mapCache = { at: Date.now(), snap };
  return snap;
}

// Resolve the device -> token map for identity checks. A device registered via
// the admin UI moments ago may not be visible to every isolate yet because the
// TTL cache (MAP_CACHE_TTL_MS) is per-isolate and the admin mutation only
// invalidates the isolate that serviced it. Without a fresh read, a legitimate
// first connection right after registration would be spuriously 401'd (the
// gateway CI flake "Expected 101"). Re-reading the registry when the cached map
// would reject an unknown id closes that window; genuinely unknown ids are still
// 401, preserving the no-existence-oracle property.
async function resolveSnapshot(env: Env, deviceId: string): Promise<RegistrySnapshot> {
  let snap = await effectiveSnapshot(env);
  // Also re-read for an unknown id in open mode: it may be an anonymous device
  // created moments ago on another isolate, whose code must then be enforced.
  if (!snap.map.has(deviceId)) {
    snap = await freshSnapshot(env);
    mapCache = { at: Date.now(), snap };
  }
  return snap;
}

interface DeviceAuth {
  denied: Response | null;
  expected?: string; // what the device's credential must match: a verifier, or the shared DEVICE_TOKEN (undefined in open mode)
  presented?: string; // the caller's credential in the same form as `expected`, once it matched
  anonymous: boolean;
}

/**
 * The device-credential gate shared by POST /mcp, the SSE pair, downloads and
 * the WS upgrade - one copy, so the anonymous rules cannot drift between them.
 * Callers have already checked the gateway token, the IP limiter and the id
 * format.
 */
/**
 * Relay a call that addressed a fleet to the member that holds the lease.
 *
 * The caller proves it is a device, and that it is a member of the fleet.
 * The gateway then talks to the primary on the caller's behalf, because the
 * caller's own credential is not the primary's.
 *
 * When the primary is gone and no one has taken over yet, the call fails
 * rather than going somewhere that is not the fleet's state.
 */
async function relayToFleet(
  env: Env,
  request: Request,
  url: URL,
  cfg: GatewayConfig,
  fleetId: string,
  callerId: string,
  asBuddy = false,
): Promise<Response> {
  // A fleet has a token of its own, set by the operator: a client that
  // presents it reaches the fleet without being a member of it. The token
  // was checked before this was called.
  if (!asBuddy) {
    const auth = await authorizeDevice(callerId, request, url, cfg, env);
    if (auth.denied) return auth.denied;
    // The caller is alive: it just proved it. The note is for its own
    // bookkeeping and nothing waits on it, so the call does not either.
    void markSeen(env, callerId);
  }
  if (!env.FLEET) return Response.json({ error: "fleets are not enabled on this gateway" }, { status: 503 });
  // The name is checked before the Durable Object is touched: an unchecked
  // name would let a caller create an object per name, and every object
  // costs something to keep.
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(fleetId)) {
    return Response.json({ error: "invalid fleet id" }, { status: 400 });
  }
  const stub = env.FLEET.get(env.FLEET.idFromName(fleetId));
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("x-prime-caller", "device");
  headers.set("x-prime-device", callerId);
  headers.set("x-prime-fleet", fleetId);
  // A member asks as itself; a fleet's own token has already been proved by
  // the gateway, so the fleet answers the gateway itself.
  const info = await stub.fetch("https://fleet/primary", {
    method: "GET",
    headers: asBuddy ? adminHeaders(headers) : headers,
  });
  if (!info.ok) return Response.json({ error: "no such fleet" }, { status: 404 });
  const body = (await info.json()) as { member?: boolean; primary?: string | null; since?: number };
  if (!asBuddy && !body.member) return Response.json({ error: "not a member of this fleet" }, { status: 403 });
  // The lease outlives the space that holds it by design, so a primary whose
  // tunnel is gone would be the answer for a while yet. It is taken out of the
  // running here, and the fleet is asked again: the member that is waiting in
  // the wings takes over on its next round, a second or two away.
  if (body.primary && (await vacateSilentPrimary(env, fleetId, body.primary, typeof body.since === "number" ? body.since : undefined))) {
    const again = await stub.fetch("https://fleet/primary", {
      method: "GET",
      headers: asBuddy ? adminHeaders(headers) : headers,
    });
    if (again.ok) {
      const next = (await again.json()) as { member?: boolean; primary?: string | null };
      if (!asBuddy && !next.member) return Response.json({ error: "not a member of this fleet" }, { status: 403 });
      body.primary = next.primary ?? null;
    }
  }
  if (!body.primary) {
    return Response.json(
      {
        error: "the fleet has no primary right now: none has taken over yet",
        hint: "the member that holds the lease is not connected; another one takes over within a few seconds",
      },
      { status: 503 },
    );
  }

  // The gateway relays on the primary's behalf. It has proved the caller and
  // it learned the primary from the fleet's own lease, so it hands nobody's
  // token on: it keeps none to hand. The primary must still be a device this
  // gateway knows.
  const snap = await effectiveSnapshot(env);
  if (!snap.map.has(body.primary) && !cfg.deviceToken) {
    return Response.json({ error: "the fleet's primary is not registered on this gateway" }, { status: 503 });
  }

  const deviceStub = env.DEVICES.get(env.DEVICES.idFromName(body.primary));
  const doUrl = new URL(url);
  doUrl.pathname = "/mcp";
  doUrl.search = "";
  const relayHeaders = new Headers();
  relayHeaders.set("content-type", request.headers.get("content-type") || "application/json");
  relayHeaders.set("x-device-id", body.primary);
  const cip = clientIp(request);
  if (cip && cip !== "unknown") relayHeaders.set("x-client-ip", cip);
  const sid = request.headers.get("mcp-session-id");
  if (sid && /^[\x21-\x7e]{1,128}$/.test(sid)) relayHeaders.set("mcp-session-id", sid);
  markAnonymous(relayHeaders, request, cfg, env);
  const relayBody = await readBounded(request, cfg.maxBodyBytes);
  if (relayBody instanceof Response) return relayBody;
  const relayed = await deviceStub.fetch(new Request(doUrl, { method: "POST", headers: relayHeaders, body: relayBody }));
  // A primary that cannot be reached is the fleet's problem, not the
  // caller's: say so, and say which member it was.
  if (relayed.status === 503) {
    const detail = await relayed.clone().text().catch(() => "");
    if (detail.includes("device offline")) {
      return Response.json(
        {
          error: "the fleet's primary is not reachable right now: " + body.primary,
          primary: body.primary,
          hint: "the member that holds the lease is not connected; another member takes over when the lease runs out",
        },
        { status: 503 },
      );
    }
  }
  return relayed;
}

/**
 * The verifier of the token a fleet answers to as a device, if it is a fleet at all.
 *
 * A fleet is reached under its own name: the operator gives it a token, and
 * a client that presents it talks to the fleet's primary without being a
 * member of the fleet. Nothing is returned for a name that is not a fleet,
 * so a device keeps its own route.
 */
async function fleetBuddyToken(env: Env, id: string): Promise<string | undefined> {
  // The verifier rides in the registry snapshot, which every request already
  // reads: looking a fleet up costs nothing extra.
  const snap = await effectiveSnapshot(env);
  return snap.buddies.get(id);
}

/** What the operator sees of a fleet's token: its fingerprint, or "" for none. */
async function buddyFingerprint(stored: string | undefined): Promise<string> {
  return isVerifier(stored) ? fingerprint(stored) : "";
}

/** Whether the request carries the fleet token this verifier was made from. */
async function tokenMatches(env: Env, request: Request, url: URL, verifier: string): Promise<boolean> {
  return tokenVerifies(env, "fleet", extractDeviceToken(request, url), verifier);
}

/**
 * The fleets a device is a member of.
 *
 * Membership lives in each fleet's own object, and the objects cannot be
 * enumerated, so the registry's list of fleets is walked.
 */
async function fleetsWithMember(env: Env, deviceId: string): Promise<string[]> {
  if (!env.FLEET) return [];
  try {
    const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
    const listed = await reg.fetch("https://registry/fleets");
    if (!listed.ok) return [];
    const ids = ((await listed.json()) as { fleets?: string[] }).fleets ?? [];
    const found: string[] = [];
    for (const id of ids) {
      const headers = new Headers({ "x-prime-caller": "admin", "x-prime-fleet": id });
      const stub = env.FLEET.get(env.FLEET.idFromName(id));
      const roster = await stub.fetch("https://fleet/members", { method: "GET", headers }).catch(() => null);
      if (!roster || !roster.ok) continue;
      const body = (await roster.json().catch(() => ({}))) as { members?: Array<{ deviceId?: string }> };
      if ((body.members ?? []).some((m) => m.deviceId === deviceId)) found.push(id);
    }
    return found;
  } catch {
    return [];
  }
}

/** Take a switched-off device out of the running in every fleet it is in. */
async function vacateInFleets(env: Env, deviceId: string): Promise<string[]> {
  if (!env.FLEET) return [];
  const vacated: string[] = [];
  for (const id of await fleetsWithMember(env, deviceId)) {
    const headers = new Headers({ "content-type": "application/json", "x-prime-caller": "admin", "x-prime-fleet": id });
    const stub = env.FLEET.get(env.FLEET.idFromName(id));
    const res = await stub
      .fetch("https://fleet/vacate", { method: "POST", headers, body: JSON.stringify({ deviceId }) })
      .catch(() => null);
    if (res && res.ok) {
      const body = (await res.json().catch(() => ({}))) as { vacated?: boolean };
      if (body.vacated) vacated.push(id);
    }
  }
  return vacated;
}

/**
 * Whether a device holds a tunnel right now.
 *
 * The answer rides in the registry snapshot every request already reads, so
 * this costs nothing: a primary whose tunnel is gone is not a primary anybody
 * can reach, and the fleet should not wait the rest of its lease to say so.
 */
const offlineAt = new Map<string, number>();
async function deviceOnline(env: Env, deviceId: string, since?: number): Promise<boolean> {
  return onlineNow(
    deviceId,
    async () => (await effectiveSnapshot(env)).online,
    async (notBefore) => {
      // A snapshot read a moment ago is as fresh as one read now (unless the device took its place after it).
      if (mapCache && Date.now() - mapCache.at < 250 && (notBefore === undefined || mapCache.at >= notBefore)) return mapCache.snap.online;
      const snap = await freshSnapshot(env);
      mapCache = { at: Date.now(), snap };
      return snap.online;
    },
    offlineAt,
    MAP_CACHE_TTL_MS,
    Date.now,
    since,
  );
}

/**
 * Take a primary that is not connected out of the running, so the next member
 * that asks takes its place.
 *
 * The lease is a clock, not a liveness check: a space whose machine went to
 * sleep still holds it until it runs out. This turns that wait into one round:
 * the space comes back in a second or two instead of in fifteen.
 */
async function vacateSilentPrimary(env: Env, fleetId: string, holder: string | null | undefined, since?: number): Promise<string | null> {
  if (!env.FLEET || !holder) return null;
  if (await deviceOnline(env, holder, since)) return null;
  const stub = env.FLEET.get(env.FLEET.idFromName(fleetId));
  const headers = new Headers({ "content-type": "application/json", "x-prime-caller": "admin", "x-prime-fleet": fleetId });
  await stub
    .fetch("https://fleet/vacate", { method: "POST", headers, body: JSON.stringify({ deviceId: holder }) })
    .catch(() => null);
  return holder;
}

/**
 * The policy the public pages are served under.
 *
 * These pages are documents: they hold no user input and run no code, except
 * the one on /connect. So the default is nothing at all - no frames, no plugins,
 * no base tag, no forms - plus the two sources they actually use: their own
 * inline styles, and the web font. The script, on the page that has one, is
 * named by the hash of its own text, not by `unsafe-inline`.
 */
/**
 * The policy the public pages are served under.
 *
 * These pages are documents with one stylesheet and, on one of them, one script.
 * Neither is allowed by name: each is allowed by the hash of its own text, so a
 * style or a script that was not written here cannot run at all.
 */
const PAGE_CSP_HEAD =
  "default-src 'none'; img-src data:; connect-src https://api.github.com; font-src https://fonts.gstatic.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** sha256 of a piece of text, base64, in the shape a CSP wants it. */
async function cspHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return "'sha256-" + btoa(binary) + "'";
}

/** The policy for one page, with its own style and script named by hash. */
let pageCspCache: { html: string; csp: string } | null = null;
async function pageCsp(html: string): Promise<string> {
  if (pageCspCache && pageCspCache.html === html) return pageCspCache.csp;
  const parts: string[] = [];
  const style = /<style>([\s\S]*?)<\/style>/.exec(html);
  parts.push(
    style
      ? "style-src " + (await cspHash(style[1]!)) + " https://fonts.googleapis.com"
      : "style-src https://fonts.googleapis.com",
  );
  const script = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (script) parts.push("script-src " + (await cspHash(script[1]!)));
  const csp = PAGE_CSP_HEAD + "; " + parts.join("; ");
  pageCspCache = { html, csp };
  return csp;
}

/** The headers every public page is served with. */
async function pageHeaders(html: string, cache: string): Promise<Record<string, string>> {
  return {
    "content-type": "text/html; charset=utf-8",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": await pageCsp(html),
    "cache-control": cache,
  };
}

/** The same headers, but the gateway speaking for itself. */
function adminHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  out.set("x-prime-caller", "admin");
  out.delete("x-prime-device");
  return out;
}

/**
 * The operator's view of the fleets.
 *
 * Each fleet is its own object, so the list of them lives in the registry.
 * For each one the object is asked who is in it and who holds the lease; the
 * registry says which of them are connected.
 */
/** Every device id that some fleet counts as one of its own. */
async function fleetMemberIds(env: Env): Promise<Set<string>> {
  const ids = new Set<string>();
  if (!env.FLEET) return ids;
  const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
  const listed = await reg.fetch("https://registry/fleets").catch(() => null);
  const fleetIds = listed ? (((await listed.json()) as { fleets?: string[] }).fleets ?? []) : [];
  await Promise.all(
    fleetIds.map(async (fleetId) => {
      const headers = new Headers();
      headers.set("x-prime-caller", "admin");
      headers.set("x-prime-fleet", fleetId);
      const stub = env.FLEET!.get(env.FLEET!.idFromName(fleetId));
      const roster = await stub.fetch("https://fleet/members", { method: "GET", headers }).catch(() => null);
      if (!roster || !roster.ok) return;
      const body = (await roster.json().catch(() => ({}))) as { members?: Array<{ deviceId?: string }> };
      for (const member of body.members ?? []) ids.add(String(member.deviceId ?? ""));
    }),
  );
  return ids;
}

/**
 * The anonymous devices that belong to nobody.
 *
 * A space joins a fleet as an anonymous device, so it would otherwise be listed
 * twice: once under the fleet that owns it, and once here, where it looks like a
 * stray. The fleet is where it belongs - this list is for the ones that belong
 * to no fleet at all. The id is used to decide that and never leaves the server;
 * the row still goes to the page by its opaque ref.
 */
async function adminAnon(env: Env, reg: DurableObjectStub): Promise<Response> {
  const [listed, inFleet] = await Promise.all([reg.fetch("https://registry/anon/list"), fleetMemberIds(env)]);
  if (!listed.ok) return listed;
  const body = (await listed.json()) as { devices?: Array<{ id?: string }> };
  // The totals stay as they are: a space is a device, whether or not it is in a
  // fleet. Only the list of stray devices changes.
  const devices = (body.devices ?? [])
    .filter((device) => !device.id || !inFleet.has(device.id))
    .map(({ id: _id, ...rest }) => rest);
  return Response.json({ ...body, devices });
}

async function adminFleets(env: Env): Promise<Response> {
  const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
  const listed = await reg.fetch("https://registry/fleets").catch(() => null);
  const ids = listed ? (((await listed.json()) as { fleets?: string[] }).fleets ?? []) : [];
  // Which devices are connected: the registry knows, and the admin list
  // already shows it.
  const full = await reg.fetch("https://registry/full").catch(() => null);
  const devices = full ? (((await full.json()) as { devices?: Array<{ deviceId?: string; online?: boolean }> }).devices ?? []) : [];
  const known = new Set(devices.map((d) => String(d.deviceId ?? "")));
  // The members of a fleet are often anonymous devices, and the device list
  // leaves those out. The registry says which of them are connected.
  const live = await reg.fetch("https://registry/online").catch(() => null);
  const liveBody = live ? ((await live.json()) as { online?: string[]; disabled?: string[] }) : {};
  const online = new Set(liveBody.online ?? []);
  const off = new Set(liveBody.disabled ?? []);
  const snapshot = await effectiveSnapshot(env);
  const fleets: Array<Record<string, unknown>> = [];
  for (const id of ids) {
    if (!env.FLEET) break;
    const stub = env.FLEET.get(env.FLEET.idFromName(id));
    const headers = new Headers({ "content-type": "application/json" });
    headers.set("x-prime-caller", "admin");
    headers.set("x-prime-fleet", id);
    const info = await stub.fetch("https://fleet/reap", { method: "POST", headers }).catch(() => null);
    if (!info || !info.ok) continue;
    const body = (await info.json()) as { members?: string[]; lastActivity?: number; meta?: { label?: string; disabled?: boolean } };
    // The registry's copy of "paused" is only a copy: put it right if it fell behind.
    if ((body.meta?.disabled === true) !== snapshot.paused.has(id)) void setFleetPaused(env, id, body.meta?.disabled === true);
    const roster = await stub.fetch("https://fleet/members", { method: "GET", headers }).catch(() => null);
    const rosterBody = roster && roster.ok ? ((await roster.json()) as { members?: Array<Record<string, unknown>> }) : {};
    const primary = await stub.fetch("https://fleet/primary", { method: "GET", headers: adminHeaders(headers) }).catch(() => null);
    const primaryBody = primary && primary.ok ? ((await primary.json()) as { primary?: string | null }) : {};
    // The spaces that asked to join and are waiting for the operator.
    const waiting = await stub.fetch("https://fleet/pending", { method: "GET", headers }).catch(() => null);
    const waitingBody = waiting && waiting.ok ? ((await waiting.json()) as { pending?: Array<Record<string, unknown>> }) : {};
    const pending = await Promise.all(
      (waitingBody.pending ?? []).map(async (p) => ({
        deviceId: String(p.deviceId ?? ""),
        label: typeof p.label === "string" ? p.label : undefined,
        requestedAt: typeof p.requestedAt === "number" ? p.requestedAt : 0,
        online: online.has(String(p.deviceId ?? "")),
        // A member that asks to have another key: the fingerprint of the key it offers, to compare with
        // what the member's own machine prints, which the operator approves or declines.
        ...(p.keyChange === true ? { keyChange: true, ...(typeof p.pubkey === "string" && p.pubkey ? { key: await keyFingerprintLong(p.pubkey) } : {}) } : {}),
      })),
    );
    const members = await Promise.all(
      (rosterBody.members ?? []).map(async (m) => ({
        deviceId: String(m.deviceId ?? ""),
        role: String(m.role ?? "member"),
        label: typeof m.label === "string" ? m.label : undefined,
        addedAt: typeof m.addedAt === "number" ? m.addedAt : 0,
        online: online.has(String(m.deviceId ?? "")),
        disabled: off.has(String(m.deviceId ?? "")),
        known: known.has(String(m.deviceId ?? "")),
        // The key snapshots are sealed for, as a fingerprint: a gateway that swapped a member's key for
        // its own keeps the device and changes only this, so it is where the operator can see it.
        ...(typeof m.pubkey === "string" && m.pubkey ? { key: await keyFingerprintLong(m.pubkey) } : {}),
        // How far the member says it has got. Informational: nothing in the gateway decides on `fetched`.
        ...(typeof m.applied === "number" ? { applied: m.applied } : {}),
        ...(typeof m.fetched === "number" ? { fetched: m.fetched } : {}),
      })),
    );
    fleets.push({
      fleet: id,
      label: body.meta?.label ?? "",
      disabled: body.meta?.disabled === true,
      // Which token this fleet answers to as a device, if the operator set
      // one: a fingerprint, never the token.
      buddy: await buddyFingerprint(snapshot.buddies.get(id)),
      members,
      memberCount: members.length,
      primary: primaryBody.primary ?? null,
      pending,
      lastActivity: body.lastActivity ?? 0,
    });
  }
  return Response.json({ fleets });
}

/**
 * An action on a fleet, made by the operator.
 *
 * The operator acts for the fleet: the gateway passes itself as the caller,
 * so an operator can admit a member or clear a fleet away.
 */
/**
 * Tell the registry whether a fleet is paused.
 *
 * Best effort on purpose: the fleet object is the authority and still refuses a
 * paused fleet's calls by itself, so a missed write costs a woken object, not a
 * wrong answer. The operator's list heals a registry that fell behind.
 */
async function setFleetPaused(env: Env, fleetId: string, paused: boolean): Promise<void> {
  try {
    const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
    await reg.fetch("https://registry/fleet-paused?id=" + encodeURIComponent(fleetId) + "&paused=" + (paused ? "1" : "0"), { method: "POST" });
    mapCache = null;
  } catch {}
}

async function adminFleetAction(env: Env, fleetId: string, step: string, body: Record<string, unknown>): Promise<Response> {
  if (!env.FLEET) return Response.json({ error: "fleets are not enabled on this gateway" }, { status: 503 });
  const stub = env.FLEET.get(env.FLEET.idFromName(fleetId));
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("x-prime-caller", "admin");
  headers.set("x-prime-fleet", fleetId);
  const path = step === "delete" ? "delete" : step;
  const res = await stub.fetch("https://fleet/" + path, { method: "POST", headers, body: JSON.stringify(body) });
  const answer = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) return Response.json({ error: String(answer.error ?? "the fleet refused") }, { status: res.status });
  return Response.json(answer);
}

async function authorizeDevice(
  deviceId: string,
  request: Request,
  url: URL,
  cfg: GatewayConfig,
  env: Env,
  // A sandbox ticket for this device that the caller has already verified: it
  // stands in for the token, which a browser WebSocket cannot send.
  ticketVerified = false,
): Promise<DeviceAuth> {
  // Without the pepper no token can be checked, so none is accepted - and the
  // refusal says why, instead of passing for an open gateway or a wrong token.
  if (pepperFrom(env) === null) return { denied: pepperMissingResponse(), anonymous: false };
  let snap = await effectiveSnapshot(env);
  if (!snap.map.has(deviceId)) {
    // An id the cache does not know is read again from the registry, in case it was made a moment ago
    // elsewhere (see resolveSnapshot). A caller that is making ids up would cost a registry read for
    // each, so each address is held to a few of them a minute. Only where an unknown id is always refused
    // (the registry has devices): a gateway with none is open, and every id is unknown there. A caller
    // that presents the one shared device token is exempt too: none of the devices of a gateway that
    // uses it is in the registry.
    const given = extractDeviceToken(request, url);
    const shared = !!cfg.deviceToken && !!given && timingSafeEq(given, cfg.deviceToken);
    if (!shared && hasNonVirtualDevice(snap, env)) {
      const limited = await limitAsk(env, "unknown-device", request);
      if (limited) return { denied: limited, anonymous: false };
    }
    snap = await resolveSnapshot(env, deviceId);
  }
  const anonymous = snap.anon.has(deviceId);
  if (hasNonVirtualDevice(snap, env) && !snap.map.has(deviceId)) return { denied: unauthorized(), anonymous };
  // Locked after too many wrong codes: that address is refused, the right code included, or the lock
  // would not stop it guessing. Only that address: another one, with the right code, is let in, so a
  // stranger's wrong codes cannot shut the member out.
  if (anonymous && snap.locked.has(anonLockKey(deviceId, clientIp(request)))) {
    return {
      denied: Response.json({ error: "too many failed attempts; try again later" }, { status: 429, headers: { "retry-after": "600" } }),
      anonymous,
    };
  }
  // The registry holds a verifier; the one shared DEVICE_TOKEN is an env secret
  // and compares as it is. `presented` is the caller's credential in the same
  // form as `expected`, for the Durable Object's own check on the upgrade.
  const stored = snap.map.get(deviceId);
  const expected = stored ?? cfg.deviceToken;
  const given = extractDeviceToken(request, url);
  let presented: string | undefined = given ?? undefined;
  if (expected !== undefined) {
    let match: boolean;
    if (stored !== undefined) {
      match = ticketVerified || (await tokenVerifies(env, "device", given, stored));
      presented = match ? stored : undefined;
    } else {
      match = !!given && timingSafeEq(given, expected);
    }
    if (!match) {
      if (anonymous) {
        try {
          const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
          const r = await reg.fetch("https://registry/anon/fail?id=" + encodeURIComponent(deviceId) + "&ip=" + encodeURIComponent(clientIp(request)), { method: "POST" });
          const j = (await r.json()) as { locked?: boolean };
          if (j.locked) mapCache = null; // pick the lock up on the next request
        } catch {}
      }
      return { denied: unauthorized(), expected, anonymous };
    }
  }
  // Read from the snapshot the credential was checked against: one ask.
  if (snap.disabled.has(deviceId)) {
    return { denied: Response.json({ error: "device disabled" }, { status: 403 }), expected, anonymous };
  }
  return { denied: null, expected, presented, anonymous };
}



function getLimiter(cfg: ReturnType<typeof loadConfig>): RateLimiter {
  if (!rateLimiter || limiterWindowMs !== cfg.rateWindowMs || limiterMax !== cfg.rateMax) {
    if (rateLimiter) rateLimiter.stop();
    rateLimiter = new RateLimiter(cfg.rateWindowMs, cfg.rateMax);
    limiterWindowMs = cfg.rateWindowMs;
    limiterMax = cfg.rateMax;
  }
  return rateLimiter;
}

// Shared authorization for the relay endpoints (POST /mcp, GET /sse, POST
// /messages). Every relay request must pass the same gates: gateway token,
// rate limit, valid deviceId, device credential, disabled + virtual checks.
// Returns null when authorized, else an error Response. The caller then forwards
// to the DeviceDO (which re-checks / records the client for defense in depth).
async function authorizeRelay(
  deviceId: string,
  request: Request,
  url: URL,
  cfg: GatewayConfig,
  env: Env,
): Promise<Response | null> {
  if (cfg.gatewayToken) {
    const t = extractToken(request, url, "auth");
    if (!t || !timingSafeEq(t, cfg.gatewayToken)) return unauthorized();
  }
  if (!getLimiter(cfg).allow(clientIp(request))) {
    return Response.json({ error: "rate limited" }, { status: 429 });
  }
  if (!validDeviceId(deviceId)) {
    return Response.json({ error: "invalid deviceId" }, { status: 400 });
  }
  const auth = await authorizeDevice(deviceId, request, url, cfg, env);
  if (auth.denied) return auth.denied;
  if (auth.anonymous) anonymousRequests.add(request);
  if (virtualDeviceIds(env).has(deviceId)) {
    // Virtual devices are in-process only (handleCloudMcp) - there is no tunnel
    // to stream over, so SSE cannot serve them (same as the WS upgrade).
    return Response.json({ error: "virtual device has no tunnel" }, { status: 400 });
  }
  return null;
}

/** A 302 to another path on this host, keeping the query string. */
function redirectTo(url: URL, pathname: string): Response {
  const to = new URL(url);
  to.pathname = pathname;
  return new Response(null, { status: 302, headers: { location: to.toString(), "cache-control": "no-store" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cfg = loadConfig(env);
    const url = new URL(request.url);
    // What the gateway is being asked for, for the monthly cost of it.
    noteGatewayRequest(env);

    // ---- Blocked addresses ----
    // A blocked address reaches nothing: not the MCP relay, not a tunnel, not
    // the file API. /admin is exempt on purpose - it is already gated by
    // Cloudflare Access, and blocking the operator's own address there would
    // leave no way to unblock it.
    if (!url.pathname.startsWith("/admin")) {
      const blockKey = ipBlockKey(clientIp(request));
      if (blockKey && (await effectiveBlockedSet(env)).has(blockKey)) {
        return Response.json({ error: "blocked" }, { status: 403, headers: { "cache-control": "no-store" } });
      }
    }

    // ---- One canonical URL per page ----
    // "/files/", "/mcp/" and "/mcp/{device}/" used to answer 404/405 with no
    // page at all - easy to land on by typing or pasting a trailing slash.
    // Redirect them to the canonical path (308 keeps a POST a POST).
    // Only reads: a POST to /mcp/ is an MCP client's mistake and keeps its
    // existing answer ("invalid deviceId"), not a redirect.
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname.length > 1 && url.pathname.endsWith("/")) {
      const to = new URL(url);
      to.pathname = url.pathname.replace(/\/+$/, "") || "/";
      return new Response(null, { status: 308, headers: { location: to.toString(), "cache-control": "no-store" } });
    }

    // ---- Front page ----
    if ((request.method === "GET" || request.method === "HEAD") && (url.pathname === "/" || url.pathname === "/index.html")) {
      return new Response(request.method === "HEAD" ? null : HOME_HTML, {
        headers: await pageHeaders(HOME_HTML, "public, max-age=300"),
      });
    }

    // ---- Anonymous device registration ----
    // A client that has no registered device asks for one here: the gateway
    // picks an unused id and a 25-character code. Limits (per-IP creations, the
    // device cap) are enforced in the RegistryDO, so they hold across isolates.
    if (url.pathname === "/api/devices/anonymous") {
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
      if (cfg.gatewayToken) {
        const t = extractToken(request, url, "auth");
        if (!t || !timingSafeEq(t, cfg.gatewayToken)) return unauthorized();
      }
      if (!getLimiter(cfg).allow(clientIp(request))) {
        return Response.json({ error: "rate limited" }, { status: 429 });
      }
      // A space that is about to join a fleet is a first-class device, not a
      // throwaway one, so the limit on how many anonymous devices one
      // address may make does not apply to it. The invite code is the proof:
      // it is single-use, it expires, and the fleet has its own limits.
      let exempt = false;
      // The body is a fleet and a code at most: more than that is not read.
      const asked = await readBoundedText(request, INVITE_CHECK_BODY_MAX);
      if (asked instanceof Response) return asked;
      try {
        const wanted = (() => {
          try {
            return JSON.parse(asked) as { fleet?: unknown; code?: unknown };
          } catch {
            return {} as { fleet?: unknown; code?: unknown };
          }
        })();
        const fleet = typeof wanted.fleet === "string" ? wanted.fleet : "";
        const code = typeof wanted.code === "string" ? wanted.code : "";
        if (fleet && code && env.FLEET && /^[a-z0-9][a-z0-9-]{0,31}$/.test(fleet)) {
          // This asks a fleet whether a code is good, which is what invite-check does, so it is held to the
          // same few a minute for an address.
          const probeLimited = await limitAsk(env, "invite-check", request);
          if (probeLimited) return probeLimited;
          const stub = env.FLEET.get(env.FLEET.idFromName(fleet));
          const headers = new Headers({ "content-type": "application/json" });
          headers.set("x-prime-caller", "admin");
          const checked = await stub.fetch("https://fleet/invite-check", {
            method: "POST",
            headers,
            body: JSON.stringify({ code }),
          });
          exempt = checked.ok;
        }
      } catch {}
      const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
      const created = await reg.fetch("https://registry/anon/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ip: clientIp(request), exempt }),
      });
      if (created.status !== 201) return created;
      const { deviceId, token } = (await created.json()) as { deviceId: string; token: string };
      mapCache = null;
      const wsScheme = url.protocol === "https:" ? "wss:" : "ws:";
      return Response.json(
        {
          deviceId,
          token,
          connect_url: url.origin + "/device/" + encodeURIComponent(deviceId) + "?token=" + encodeURIComponent(token),
          ws_url: wsScheme + "//" + url.host + "/device/ws/" + encodeURIComponent(deviceId),
          anonymous: true,
          rate_limit: { max: anonConfig(env).rateMax, window_ms: cfg.rateWindowMs },
        },
        { status: 201, headers: { "cache-control": "no-store" } },
      );
    }

    // ---- Fleets ----
    // Membership and bootstrap. The Worker proves the credential here; the
    // Durable Object only ever sees an identity this Worker established.
    // ---- Fleets ----
    // A fleet costs the gateway money to run: the agents keep the objects awake
    // and the relays keep the requests coming. The budget is a monthly ceiling
    // the operator sets, and the fleets stop at it.
    if (url.pathname.startsWith("/fleets/") || url.pathname.startsWith("/api/fleets/") || url.pathname === "/fleets") {
      const budget = await fleetBudgetSpent(env);
      if (budget.over && !url.pathname.startsWith("/admin/")) {
        return Response.json(
          {
            error: "the gateway's monthly fleet budget is spent",
            spent_usd: budget.spentUsd,
            budget_usd: budget.budgetUsd,
            hint: "raise FLEET_MONTHLY_BUDGET_USD, or wait for the month to turn over",
          },
          { status: 402 },
        );
      }
      if (url.pathname === "/fleets") {
        // The fleets that exist, for the operator: the list lives in the
        // registry, because the fleet objects cannot be enumerated.
        if (request.method !== "GET") return Response.json({ error: "fleet id required" }, { status: 400 });
        const t = extractToken(request, url, "auth");
        if (!cfg.fleetOperatorToken || !t || !timingSafeEq(t, cfg.fleetOperatorToken)) {
          return Response.json({ error: "only the operator may list the fleets" }, { status: 403 });
        }
        const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
        return reg.fetch("https://registry/fleets");
      }
      const fleetResponse = await handleFleetRoutes({
        request,
        env,
        url,
        cfg,
        unauthorized,
        authorizeDevice: async (deviceId) => {
          const auth = await authorizeDevice(deviceId, request, url, cfg, env);
          return auth.denied ? { ok: false as const, response: auth.denied } : { ok: true as const };
        },
        deviceOnline: (deviceId: string, since?: number) => deviceOnline(env, deviceId, since),
        fleetPaused: async (fleetId: string) => (await effectiveSnapshot(env)).paused.has(fleetId),
      });
      if (fleetResponse) return fleetResponse;
    }

    // ---- Temporary files (REST API + pages) ----
    // Handled before the device routing because /files and /api/files are
    // self-contained: they authenticate with device Basic auth, not the gateway
    // token, and never touch a tunnel.
    const filesResponse = await handleFiles({
      request,
      env,
      url,
      cfg,
      limiter: getLimiter(cfg),
    });
    if (filesResponse) return filesResponse;

    // ---- Admin: only for someone Cloudflare Access let through ----
    // The Access application at the edge is the first gate; this is the second.
    // ADMIN_ACCESS=enforce (default) refuses everything without a valid Access
    // JWT, so deleting or breaking the Access app closes the admin instead of
    // exposing it. "warn" allows with a log line (used while rolling this out),
    // "off" disables the check (local development and tests).
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/api/")) {
      const mode = (env.ADMIN_ACCESS ?? "enforce").trim().toLowerCase();
      if (mode !== "off") {
        const team = (env.ACCESS_TEAM_DOMAIN ?? "").trim();
        const aud = (env.ACCESS_AUD ?? "").trim();
        let verdict: { ok: boolean; reason?: string; email?: string };
        if (!team || !aud) verdict = { ok: false, reason: "ACCESS_TEAM_DOMAIN / ACCESS_AUD are not configured" };
        else verdict = await verifyAccessJwt(request, { team, aud });
        if (!verdict.ok) {
          if (mode === "warn") {
            console.warn("admin: Access check failed (" + verdict.reason + ") - allowed because ADMIN_ACCESS=warn");
          } else {
            return Response.json(
              {
                error: "admin requires Cloudflare Access",
                reason: verdict.reason,
                hint: "This page and its API only answer requests Cloudflare Access has authenticated. Configure ACCESS_TEAM_DOMAIN and ACCESS_AUD for this Worker, or set ADMIN_ACCESS=off for local development.",
              },
              { status: 403, headers: { "cache-control": "no-store" } },
            );
          }
        }
      }
    }

    // ---- Admin UI ----
    // The page itself is gated by Cloudflare Access at the edge (policies:
    // allow the admin email + @tuanm.dev); the API below additionally requires
    // the admin token (defense in depth, also works for local dev).
    if (request.method === "GET" && url.pathname === "/admin") {
      return new Response(ADMIN_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    // ---- Admin API (device registry) ----
    // Auth is delegated to Cloudflare Access at the edge (the Access app is
    // scoped to /admin*, so every request here already passed the policy
    // check). No worker-level admin token is required - the UI is the only
    // consumer and it lives behind the same Access app.
    if (url.pathname.startsWith("/admin/api/")) {
      const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));

      // ---- blocked addresses ----
      if (url.pathname === "/admin/api/blocked") {
        if (request.method === "GET") return reg.fetch("https://registry/blocked");
        let blockBody: unknown;
        try {
          blockBody = await request.json();
        } catch {
          return Response.json({ error: "invalid json" }, { status: 400 });
        }
        const ip = typeof (blockBody as { ip?: unknown })?.ip === "string" ? String((blockBody as { ip: string }).ip) : "";
        const blockIt = (blockBody as { blocked?: unknown })?.blocked !== false;
        invalidateBlockedCache();
        return reg.fetch(new Request("https://registry/blocked", {
          method: blockIt ? "POST" : "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ip }),
        }));
      }

      // ---- anonymous devices, by opaque ref ----
      // The admin can see and act on them but never sees their id or code: the
      // ref is resolved to the real device here, server-side.
      if (request.method === "GET" && url.pathname === "/admin/api/anonymous") {
        return adminAnon(env, reg);
      }
      // Where an anonymous device's tunnel comes from (the admin's View dialog).
      const anonOriginRoute = /^\/admin\/api\/anonymous\/([a-f0-9]{24})\/origin$/.exec(url.pathname);
      if (anonOriginRoute && request.method === "GET") {
        const resolved = await reg.fetch("https://registry/anon/resolve?ref=" + anonOriginRoute[1]);
        if (!resolved.ok) return Response.json({ error: "not found" }, { status: 404 });
        const { deviceId } = (await resolved.json()) as { deviceId: string };
        return originFor(env, env.DEVICES.get(env.DEVICES.idFromName(deviceId)));
      }
      const anonRoute = /^\/admin\/api\/anonymous\/([a-f0-9]{24})(\/(state|clients|tools))?$/.exec(url.pathname);
      if (anonRoute) {
        const resolved = await reg.fetch("https://registry/anon/resolve?ref=" + anonRoute[1]);
        if (!resolved.ok) return Response.json({ error: "not found" }, { status: 404 });
        const { deviceId } = (await resolved.json()) as { deviceId: string };
        const action = anonRoute[3] || "";
        if (request.method === "DELETE" && action === "") {
          mapCache = null;
          invalidateDisabledCache();
          await reg.fetch(new Request("https://registry/remove", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ deviceId }),
          }));
          await kickDeviceTunnel(env, deviceId);
          return Response.json({ ok: true });
        }
        if (request.method === "POST" && action === "state") {
          let body: unknown;
          try {
            body = await request.json();
          } catch {
            return Response.json({ error: "invalid json" }, { status: 400 });
          }
          const disabled = !!(body as { disabled?: unknown })?.disabled;
          mapCache = null;
          invalidateDisabledCache();
          await reg.fetch(new Request("https://registry/setstate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ deviceId, disabled }),
          }));
          const dropped = disabled ? await kickDeviceTunnel(env, deviceId) : false;
          return Response.json({ ok: true, disabled, tunnelDropped: dropped });
        }
        if (request.method === "GET" && action === "clients") {
          return env.DEVICES.get(env.DEVICES.idFromName(deviceId)).fetch("https://device/clients");
        }
        if (request.method === "POST" && action === "tools") {
          // Same answer the registered-device Tools dialog gets, relayed by the
          // gateway itself: the operator is proved by Access, and the gateway
          // has no code to hand on.
          if ((await effectiveDisabledSet(env)).has(deviceId)) {
            return Response.json({ error: "device disabled" }, { status: 403 });
          }
          const headers = new Headers({ "content-type": "application/json", "x-device-id": deviceId });
          return env.DEVICES.get(env.DEVICES.idFromName(deviceId)).fetch(new Request("https://device/mcp", {
            method: "POST",
            headers,
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
          }));
        }
        return Response.json({ error: "not found" }, { status: 404 });
      }

      // ---- fleets ----
      // The operator's view of the fleets: who is in them, which member
      // holds the lease, and which of them are connected right now.
      if (request.method === "GET" && url.pathname === "/admin/api/fleets") {
        return await adminFleets(env);
      }
      if (url.pathname.startsWith("/admin/api/fleets/")) {
        const rest = url.pathname.slice("/admin/api/fleets/".length);
        const slash = rest.indexOf("/");
        const fleetId = slash === -1 ? rest : rest.slice(0, slash);
        const step = slash === -1 ? "" : rest.slice(slash + 1);
        if (!validFleetId(fleetId)) return Response.json({ error: "invalid fleet id" }, { status: 400 });
        if (request.method === "POST" && step === "") {
          // A fleet is created here and nowhere else: the operator sets it
          // up, and the spaces join it afterwards.
          if (!env.FLEET) return Response.json({ error: "fleets are not enabled on this gateway" }, { status: 503 });
          const stub = env.FLEET.get(env.FLEET.idFromName(fleetId));
          const headers = new Headers({ "content-type": "application/json" });
          headers.set("x-prime-caller", "admin");
          headers.set("x-prime-fleet", fleetId);
          const made = await stub.fetch("https://fleet/create", { method: "POST", headers, body: "{}" });
          const answer = (await made.json().catch(() => ({}))) as Record<string, unknown>;
          if (!made.ok) return Response.json({ error: String(answer.error ?? "could not create the fleet") }, { status: made.status });
          return Response.json(answer);
        }
        if (request.method === "DELETE" && step === "") {
          return await adminFleetAction(env, fleetId, "delete", {});
        }
        if (request.method === "POST" && step === "invite") {
          return await adminFleetAction(env, fleetId, "invite", {});
        }
        if (request.method === "POST" && step === "approve") {
          const body = (await request.json().catch(() => ({}))) as { deviceId?: unknown; key?: unknown };
          return await adminFleetAction(env, fleetId, "approve", { deviceId: String(body.deviceId ?? ""), ...(typeof body.key === "string" ? { key: body.key } : {}) });
        }
        if (request.method === "POST" && step === "remove") {
          const body = (await request.json().catch(() => ({}))) as { deviceId?: unknown; keyChange?: unknown };
          return await adminFleetAction(env, fleetId, "remove", { deviceId: String(body.deviceId ?? ""), ...(body.keyChange === true ? { keyChange: true } : {}) });
        }
        if (request.method === "POST" && step === "reap") {
          return await adminFleetAction(env, fleetId, "reap", {});
        }
        if (request.method === "POST" && step === "buddy") {
          // The token a client presents to reach the fleet as a device.
          const body = (await request.json().catch(() => ({}))) as { token?: unknown };
          const token = typeof body.token === "string" ? body.token.trim() : "";
          mapCache = null;
          if (!env.REGISTRY) return Response.json({ error: "fleets are not enabled" }, { status: 503 });
          const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
          const res = await reg.fetch("https://registry/fleet-buddy?id=" + encodeURIComponent(fleetId), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token }),
          });
          return new Response(res.body, { status: res.status, headers: res.headers });
        }
        if (request.method === "POST" && step === "meta") {
          const body = (await request.json().catch(() => ({}))) as { label?: unknown; disabled?: unknown };
          const patch: Record<string, unknown> = {};
          if (typeof body.label === "string") patch.label = body.label;
          if (typeof body.disabled === "boolean") patch.disabled = body.disabled;
          const done = await adminFleetAction(env, fleetId, "meta", patch);
          // The fleet object decided; the registry is told so the Worker can answer
          // for a paused fleet without waking the object.
          if (done.ok && typeof patch.disabled === "boolean") await setFleetPaused(env, fleetId, patch.disabled);
          return done;
        }
        return Response.json({ error: "not found" }, { status: 404 });
      }

      if (request.method === "GET" && url.pathname === "/admin/api/usage") {
        // What the month has cost so far, against the budget it must not pass.
        const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
        const res = await reg.fetch("https://registry/usage");
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return Response.json({ ...body, ok: res.ok });
      }
      if (request.method === "GET" && url.pathname === "/admin/api/devices") {
        return reg.fetch("https://registry/full");
      }
      if (request.method === "POST" && url.pathname === "/admin/api/devices") {
        // A fleet answers to its own name as a device, so a device cannot
        // take the name of a fleet.
        try {
          const peek = (await request.clone().json()) as { deviceId?: unknown };
          const wanted = typeof peek.deviceId === "string" ? peek.deviceId : "";
          if (wanted) {
            const r = await reg.fetch("https://registry/name-taken?kind=device&id=" + encodeURIComponent(wanted));
            const answered = r.ok ? ((await r.json()) as { taken?: boolean }) : {};
            if (answered.taken) {
              return Response.json({ error: "a fleet already has that id", hint: "give the device another id" }, { status: 409 });
            }
          }
        } catch {}
        mapCache = null;
        const sent = await request.text();
        const upstream = new Request("https://registry/upsert", {
          method: "POST",
          headers: { "content-type": request.headers.get("content-type") || "application/json" },
          body: sent,
        });
        const res = await reg.fetch(upstream);
        // A new token must invalidate a tunnel opened with the old one. The
        // registry is the one that can tell: it compares the verifiers.
        const answer = (await res.json().catch(() => ({}))) as { rotated?: unknown };
        if (res.ok && answer.rotated === true) {
          let id: unknown;
          try {
            id = (JSON.parse(sent) as { deviceId?: unknown }).deviceId;
          } catch {}
          if (typeof id === "string" && validDeviceId(id.trim())) await kickDeviceTunnel(env, id.trim());
        }
        return Response.json(answer, { status: res.status });
      }
      if (request.method === "GET" && url.pathname.startsWith("/admin/api/devices/") && url.pathname.endsWith("/origin")) {
        const deviceId = url.pathname.slice("/admin/api/devices/".length, -"/origin".length);
        if (!validDeviceId(deviceId)) return Response.json({ error: "invalid deviceId" }, { status: 400 });
        return originFor(env, env.DEVICES.get(env.DEVICES.idFromName(deviceId)));
      }
      // The MCP sessions a device was opened with (clientInfo name and time, from
      // its own storage), with the relay clients seen in the last ten minutes
      // beside them. Read-only: the object lists, it does not prune.
      if (request.method === "GET" && url.pathname.startsWith("/admin/api/devices/") && url.pathname.endsWith("/sessions")) {
        const deviceId = url.pathname.slice("/admin/api/devices/".length, -"/sessions".length);
        if (!validDeviceId(deviceId)) return Response.json({ error: "invalid deviceId" }, { status: 400 });
        const stub = env.DEVICES.get(env.DEVICES.idFromName(deviceId));
        const sessions = (await (await stub.fetch("https://device/sessions")).json().catch(() => ({}))) as { sessions?: unknown };
        const clients = (await (await stub.fetch("https://device/clients")).json().catch(() => ({}))) as { clients?: unknown };
        return Response.json({ deviceId, sessions: sessions.sessions ?? [], clients: clients.clients ?? [] });
      }
      if (request.method === "GET" && url.pathname.startsWith("/admin/api/devices/") && url.pathname.endsWith("/clients")) {
        const deviceId = url.pathname.slice("/admin/api/devices/".length, -"/clients".length);
        if (!validDeviceId(deviceId)) return Response.json({ error: "invalid deviceId" }, { status: 400 });
        const stub = env.DEVICES.get(env.DEVICES.idFromName(deviceId));
        return stub.fetch("https://device/clients");
      }
      if (request.method === "POST" && url.pathname.startsWith("/admin/api/devices/") && url.pathname.endsWith("/tools")) {
        // A device's tools, for the operator's Tools dialog: relayed by the
        // gateway itself, which keeps no token to hand on. The operator is
        // proved by Access; a fleet member is an anonymous device and goes
        // the same way.
        const deviceId = url.pathname.slice("/admin/api/devices/".length, -"/tools".length);
        if (!validDeviceId(deviceId)) return Response.json({ error: "invalid deviceId" }, { status: 400 });
        if ((await effectiveDisabledSet(env)).has(deviceId)) {
          return Response.json({ error: "device disabled" }, { status: 403 });
        }
        const map = await reg.fetch("https://registry/map");
        const known = map.ok ? ((await map.json()) as { map?: Record<string, string> }).map?.[deviceId] !== undefined : false;
        if (!known) return Response.json({ error: "no such device" }, { status: 404 });
        const headers = new Headers({ "content-type": "application/json", "x-device-id": deviceId });
        return env.DEVICES.get(env.DEVICES.idFromName(deviceId)).fetch(new Request("https://device/mcp", {
          method: "POST",
          headers,
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        }));
      }
      if (request.method === "POST" && url.pathname.startsWith("/admin/api/devices/") && url.pathname.endsWith("/state")) {
        const deviceId = url.pathname.slice("/admin/api/devices/".length, -"/state".length);
        if (!validDeviceId(deviceId)) return Response.json({ error: "invalid deviceId" }, { status: 400 });
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid json" }, { status: 400 });
        }
        const disabled = !!(body as { disabled?: unknown })?.disabled;
        mapCache = null;
        invalidateDisabledCache();
        const res = await reg.fetch(
          new Request("https://registry/setstate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ deviceId, disabled }),
          }),
        );
        const dropped = disabled ? await kickDeviceTunnel(env, deviceId) : false;
        if (!res.ok) return res;
        // A space that has been switched off must not keep driving its fleet:
        // the lease goes back, and the next member that asks takes its place.
        const vacated = disabled ? await vacateInFleets(env, deviceId) : [];
        const current = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return Response.json({ ...current, ok: true, disabled, tunnelDropped: dropped, fleetsVacated: vacated });
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/admin/api/devices/")) {
        const deviceId = url.pathname.slice("/admin/api/devices/".length);
        if (!validDeviceId(deviceId)) return Response.json({ error: "invalid deviceId" }, { status: 400 });
        mapCache = null;
        invalidateDisabledCache();
        const res = await reg.fetch(
          new Request("https://registry/remove", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ deviceId }),
          }),
        );
        await kickDeviceTunnel(env, deviceId);
        return res;
      }
      return Response.json({ error: "not found" }, { status: 404 });
    }

    // /devices - admin listing. NEVER public: it reveals which devices are
    // online. Requires the admin (or gateway) token; if no admin token is
    // configured the endpoint is hidden entirely (404), so a misconfigured
    // gateway does not silently leak the device roster.
    if (request.method === "GET" && url.pathname === "/devices") {
      if (!cfg.adminToken) return Response.json({ error: "not found" }, { status: 404 });
      const t = extractToken(request, url, "auth");
      if (!t || !timingSafeEq(t, cfg.adminToken)) return unauthorized();
      const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
      return reg.fetch("https://registry/devices");
    }

    // Fixed ticket grammar: no arbitrary path, URL, or upstream proxy target.
    const download = /^\/(?:device|mcp)\/([^/]+)\/download\/([a-f0-9]{64})$/.exec(url.pathname);
    if (download) {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
      const denied = await authorizeRelay(download[1], request, url, cfg, env);
      if (denied) return denied;
      const token = request.headers.get("x-device-token");
      if (!token) return unauthorized();
      const target = new URL(request.url);
      target.pathname = "/download/" + download[2];
      target.search = "";
      const headers = new Headers({ "x-device-id": download[1], "x-device-token": token });
      markAnonymous(headers, request, cfg, env);
      return env.DEVICES.get(env.DEVICES.idFromName(download[1])).fetch(new Request(target, {
        method: "GET", headers, signal: request.signal,
      }));
    }

    // GET /connect: the Device Connect page. GET /connect/{deviceId}: the
    // Sandbox page for that device, which asks for its token. POST
    // /sandbox?ticket=1 mints the sandbox's WebSocket ticket.
    if (url.pathname === "/sandbox" && request.method === "GET" && url.searchParams.has("asset")) return sandboxAsset(url.searchParams.get("asset"));
    if (url.pathname === "/sandbox") return handleSandbox(request, env, url);
    if (url.pathname === "/mcp" && request.method === "POST" && url.searchParams.has("ticket")) return handleSandbox(request, env, url);
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/security") {
      return new Response(request.method === "HEAD" ? null : SECURITY_HTML, {
        headers: await pageHeaders(SECURITY_HTML, "no-store"),
      });
    }
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/join") {
      return new Response(request.method === "HEAD" ? null : JOIN_HTML, {
        headers: await pageHeaders(JOIN_HTML, "no-store"),
      });
    }
    if ((request.method === "GET" || request.method === "HEAD") && (url.pathname === "/connect" || url.pathname === "/mcp")) {
      if (url.pathname === "/mcp") return redirectTo(url, "/connect");
      if (url.searchParams.has("asset")) return sandboxAsset(url.searchParams.get("asset"));
      if (url.searchParams.has("frame") || url.searchParams.has("ticket")) return handleSandbox(request, env, url);
      return new Response(request.method === "HEAD" ? null : LANDING_HTML, {
        headers: await pageHeaders(LANDING_HTML, "no-store"),
      });
    }
    if ((request.method === "GET" || request.method === "HEAD") && /^\/connect\/[^/]+$/.test(url.pathname)) {
      return handleSandboxDevicePage(request, env, url);
    }
    // Old page links: /device/{id} (the sandbox page before the move),
    // /sandbox/{id} and /mcp/{id} all land on /connect/{id}. An invalid id is a
    // 404 for everyone; a non-HTML GET keeps the relay's 405 so MCP clients see
    // the endpoint they expect.
    const oldPage = (request.method === "GET" || request.method === "HEAD") ? /^\/(device|sandbox|mcp)\/([^/]+)$/.exec(url.pathname) : null;
    if (oldPage) {
      if (!validDeviceId(oldPage[2]!)) return new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
      if ((request.headers.get("accept") || "").includes("text/html")) return redirectTo(url, "/connect/" + oldPage[2]);
    }

    // Non-POST on /device/{deviceId} (or the old /mcp/{deviceId}): this is a
    // POST-only JSON-RPC endpoint. Return a clear 405 instead of a bare 404 so
    // opening the URL in a browser gets an actionable message.
    if (request.method !== "POST" && (/^\/device\/[^/]*$/.test(url.pathname) || /^\/mcp\/[^/]*$/.test(url.pathname))) {
      return Response.json(
        { error: "method not allowed", hint: "POST JSON-RPC to this URL; GET/HEAD are not supported (Streamable HTTP)" },
        { status: 405 },
      );
    }

    // POST /device/{deviceId} (the old /mcp/{deviceId} alias stays for clients
    // that have not moved yet)
    if (request.method === "POST" && (/^\/device\/[^/]*$/.test(url.pathname) || /^\/mcp\/[^/]*$/.test(url.pathname))) {
      if (cfg.gatewayToken) {
        const t = extractToken(request, url, "auth");
        if (!t || !timingSafeEq(t, cfg.gatewayToken)) return unauthorized();
      }

      // Cheap per-isolate rate limit (global enforcement via CF edge rules).
      if (!getLimiter(cfg).allow(clientIp(request))) {
        return Response.json({ error: "rate limited" }, { status: 429 });
      }

      const deviceId = url.pathname.startsWith("/device/") ? url.pathname.slice("/device/".length) : url.pathname.slice(5);
      if (!validDeviceId(deviceId)) {
        return Response.json({ error: "invalid deviceId" }, { status: 400 });
      }

      // Device credential check BEFORE touching the DeviceDO. The registry is
      // the source of truth (admin UI + DEVICE_TOKENS seed). In per-device
      // mode an unknown deviceId is rejected outright (no existence oracle)
      // and unauthenticated probes get 401 - never instantiating a Durable
      // Object for them (no DO churn / cost).
      // Deactivated devices are rejected outright (admin UI toggle), inside
      // authorizeDevice, after the credential check.
      // A client may address a fleet instead of a device. The call goes to
      // the member that holds the lease, so a client talks to the fleet and
      // not to one machine that happens to be up.
      const fleetId = url.searchParams.get("fleet");
      if (fleetId) {
        return await relayToFleet(env, request, url, cfg, fleetId, deviceId);
      }

      // A fleet also answers to its own name, with the token the operator
      // gave it: the client does not have to be a member of the fleet.
      const buddy = await fleetBuddyToken(env, deviceId);
      if (buddy !== undefined) {
        if (pepperFrom(env) === null) return pepperMissingResponse();
        if (!buddy || !(await tokenMatches(env, request, url, buddy))) return unauthorized();
        return await relayToFleet(env, request, url, cfg, deviceId, deviceId, true);
      }

      const auth = await authorizeDevice(deviceId, request, url, cfg, env);
      if (auth.denied) return auth.denied;
      if (auth.anonymous) anonymousRequests.add(request);

      // Virtual devices (in-process, no tunnel): handle the MCP request right
      // here. Auth above already validated the gateway token and the device
      // credential (registered via VIRTUAL_DEVICE_TOKENS), so this is the same
      // trust boundary as a tunnel device - just without a WebSocket.
      if (virtualDeviceIds(env).has(deviceId)) {
        return handleCloudMcp(env, request);
      }

      const stub = env.DEVICES.get(env.DEVICES.idFromName(deviceId));
      // Rewrite the path to /mcp (the DO matches that) and add x-device-id so
      // the DO knows its device regardless of the URL.
      const doUrl = new URL(url);
      doUrl.pathname = "/mcp";
      // Keep the relay token (?token=) which the DO forwards to the device;
      // drop everything else (auth= etc.) from the forwarded URL.
      const relayTok = url.searchParams.get("token");
      doUrl.search = relayTok ? "?token=" + encodeURIComponent(relayTok) : "";
      const headers = new Headers();
      headers.set("content-type", request.headers.get("content-type") || "application/json");
      headers.set("x-device-id", deviceId);
      const cip = clientIp(request);
      if (cip && cip !== "unknown") headers.set("x-client-ip", cip);
      const xdt = request.headers.get("x-device-token");
      if (xdt) headers.set("x-device-token", xdt);
      // The MCP session (issued by the DO on initialize) tells clients apart.
      const sid = request.headers.get("mcp-session-id");
      if (sid && /^[\x21-\x7e]{1,128}$/.test(sid)) headers.set("mcp-session-id", sid);
      // Preserve auth params for the DO's own device-auth check.
      const t = extractToken(request, url, "auth");
      if (t) headers.set("x-auth-token", t);
      markAnonymous(headers, request, cfg, env);
      const body = await readBounded(request, cfg.maxBodyBytes);
      if (body instanceof Response) return body;
      const upstream = new Request(doUrl, { method: "POST", headers, body });
      return stub.fetch(upstream);
    }

    // ---- SSE transport ----------------------------------------------------
    // GET /sse/{deviceId} opens a server->client text/event-stream. The first
    // event tells the client the /messages POST endpoint, on which it then sends
    // JSON-RPC requests (responses arrive over the stream). Auth is identical to
    // POST /mcp; GET /sse?deviceId= is a legacy alias. Virtual devices have no
    // tunnel, so SSE cannot serve them (401/400 like the WS upgrade path).
    if (request.method === "GET" && (url.pathname.startsWith("/device/sse/") || url.pathname.startsWith("/sse/") || url.pathname === "/sse")) {
      const deviceId = url.pathname.startsWith("/device/sse/")
        ? url.pathname.slice("/device/sse/".length)
        : url.pathname.startsWith("/sse/")
        ? url.pathname.slice(5)
        : url.searchParams.get("deviceId") || "";
      const denied = await authorizeRelay(deviceId, request, url, cfg, env);
      if (denied) return denied;

      const stub = env.DEVICES.get(env.DEVICES.idFromName(deviceId));
      const doUrl = new URL(url);
      doUrl.pathname = "/sse";
      const headers = new Headers();
      headers.set("x-device-id", deviceId);
      const cip = clientIp(request);
      if (cip && cip !== "unknown") headers.set("x-client-ip", cip);
      const t = extractToken(request, url, "auth");
      if (t) headers.set("x-auth-token", t);
      markAnonymous(headers, request, cfg, env);
      return stub.fetch(new Request(doUrl, { method: "GET", headers }));
    }

    // POST /messages/{deviceId}?session=... - the SSE client->server leg. A
    // POST is ACKed with 202; the JSON-RPC response is pushed over the stream.
    if (request.method === "POST" && (url.pathname.startsWith("/device/messages/") || url.pathname.startsWith("/messages/") || url.pathname === "/messages")) {
      const deviceId = url.pathname.startsWith("/device/messages/")
        ? url.pathname.slice("/device/messages/".length)
        : url.pathname.startsWith("/messages/")
        ? url.pathname.slice(10)
        : url.searchParams.get("deviceId") || "";
      const denied = await authorizeRelay(deviceId, request, url, cfg, env);
      if (denied) return denied;

      const stub = env.DEVICES.get(env.DEVICES.idFromName(deviceId));
      const doUrl = new URL(url);
      doUrl.pathname = "/messages";
      const headers = new Headers();
      headers.set("content-type", request.headers.get("content-type") || "application/json");
      headers.set("x-device-id", deviceId);
      const cip = clientIp(request);
      if (cip && cip !== "unknown") headers.set("x-client-ip", cip);
      const xdt = request.headers.get("x-device-token");
      if (xdt) headers.set("x-device-token", xdt);
      const t = extractToken(request, url, "auth");
      if (t) headers.set("x-auth-token", t);
      markAnonymous(headers, request, cfg, env);
      const body = await readBounded(request, cfg.maxBodyBytes);
      if (body instanceof Response) return body;
      return stub.fetch(new Request(doUrl, { method: "POST", headers, body }));
    }

    // WS upgrade: /device/ws/{deviceId} (preferred), /ws/{deviceId} (legacy) or /ws?deviceId=
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      // Probe gate: bound how many WS upgrades an IP can initiate, which also
      // caps the cost of the fresh-identity read for unknown ids below.
      if (!getLimiter(cfg).allow(clientIp(request))) {
        return Response.json({ error: "rate limited" }, { status: 429 });
      }
      // Origin whitelist applies to browser-style WS clients.
      if (cfg.allowedOrigins && cfg.allowedOrigins.size > 0) {
        const origin = request.headers.get("origin");
        if (origin && !cfg.allowedOrigins.has(origin)) {
          return Response.json({ error: "forbidden origin" }, { status: 403 });
        }
      }

      let deviceId: string;
      if (url.pathname.startsWith("/device/ws/")) {
        deviceId = url.pathname.slice("/device/ws/".length);
      } else if (url.pathname.startsWith("/ws/")) {
        deviceId = url.pathname.slice(4);
      } else if (url.pathname === "/ws" || url.pathname === "/device/ws") {
        deviceId = url.searchParams.get("deviceId") || "";
      } else {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      if (!deviceId || !validDeviceId(deviceId)) {
        return Response.json({ error: "invalid deviceId" }, { status: 400 });
      }

      // Device auth at connect, checked BEFORE creating a DO instance:
      // an attacker must know the device's secret to claim its identity, so
      // hijacking / intercepting an in-use deviceId is impossible. Unknown
      // deviceIds get the same 401 (no existence oracle). The DO re-checks
      // the credential for defense in depth.
      // A Sandbox page connects with ?ticket= (a browser WebSocket cannot send
      // headers, and the device token must never sit in a URL). A valid ticket
      // stands in for the token; the DO then refuses its nonce a second time.
      if (pepperFrom(env) === null) return pepperMissingResponse();
      let ticketNonce: string | null = null;
      const ticket = url.searchParams.get("ticket");
      if (ticket) {
        const registered = (await resolveSnapshot(env, deviceId)).map.get(deviceId);
        const verdict = registered === undefined ? null : await verifyTicket(env, deviceId, ticket, registered);
        if (!verdict) return unauthorized();
        ticketNonce = verdict.nonce;
        url.searchParams.delete("ticket");
        request = new Request(url, { headers: request.headers, method: request.method });
      }

      // A verified ticket stands in for the token; the lock and the disabled
      // checks still run.
      const auth = await authorizeDevice(deviceId, request, url, cfg, env, ticketNonce !== null);
      if (auth.denied) return auth.denied;
      const expected = auth.expected;

      // Virtual devices are in-process only - they have no tunnel to upgrade.
      if (virtualDeviceIds(env).has(deviceId)) {
        return Response.json({ error: "virtual device has no tunnel" }, { status: 400 });
      }

      const stub = env.DEVICES.get(env.DEVICES.idFromName(deviceId));
      // Keep the upgrade headers; add x-device-id for the DO, and forward the
      // checked credential as x-auth-token + what it had to match as
      // x-expected-token, in the same form (a verifier, or the shared env
      // token), so the DO's defense-in-depth check matches the registry
      // without the DO ever seeing a stored token. A client cannot set either.
      const headers = new Headers(request.headers);
      headers.delete("x-ticket-nonce");
      headers.delete("x-expected-token");
      headers.delete("x-auth-token");
      // Where this tunnel comes from (kept by the DO for the life of the tunnel):
      // the gateway owner can see which machine holds a device.
      headers.delete("x-tunnel-origin");
      {
        const cf = (request as unknown as { cf?: Record<string, unknown> }).cf || {};
        headers.set("x-tunnel-origin", JSON.stringify({
          ip: clientIp(request), country: cf.country, region: cf.region, city: cf.city,
          asn: cf.asn, as: cf.asOrganization, colo: cf.colo, ua: (request.headers.get("user-agent") || "").slice(0, 120), at: new Date().toISOString(),
        }));
      }
      if (ticketNonce) headers.set("x-ticket-nonce", ticketNonce);
      headers.set("x-device-id", deviceId);
      if (expected !== undefined) headers.set("x-expected-token", expected);
      if (auth.presented) headers.set("x-auth-token", auth.presented);
      const upstream = new Request(url, { headers, method: request.method });
      return stub.fetch(upstream);
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
};
