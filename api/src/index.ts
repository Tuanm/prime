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
//   POST /api/devices/anonymous   -> create an anonymous device (generated id + 6-char code)
//   /admin/api/anonymous/{ref}... -> admin actions on anonymous devices, by opaque ref
//
// All device state (WebSocket + pending requests) lives in a DeviceDO keyed by
// deviceId, so every HTTP request finds the right tunnel regardless of which
// isolate handled it. The device->token registry is writable and lives in the
// RegistryDO (durable storage), seeded once from the DEVICE_TOKENS secret, so
// the admin UI can register devices at runtime without a redeploy.

import { anonConfig, loadConfig, timingSafeEq, extractToken, extractDeviceToken, validDeviceId, virtualDeviceIds } from "./config";
import type { Env, GatewayConfig } from "./config";
import { RateLimiter, clientIp } from "./rate-limit";
import { ADMIN_HTML } from "./admin-ui";
import { LANDING_HTML } from "./landing-page";
import { HOME_HTML } from "./home-page";
import { handleCloudMcp } from "./cloud-device";
import { handleFiles } from "./files-routes";
import { handleFleetRoutes, markSeen } from "./fleets-routes";
import { validFleetId } from "./fleets";
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

/**
 * Read a relayed body in full, bounded by the body cap.
 *
 * The device DO buffers the whole body anyway (it calls request.text()), so
 * forwarding a live stream buys nothing and costs something: when the DO refuses
 * before reading it - device offline, device busy, over the cap - the stream is
 * left dangling, and workerd then reads it after the response has been sent. That
 * logs an uncaught "Can't read from request stream after response has been sent"
 * for every refused request and, occasionally, drops the connection as a 500
 * where the caller was owed a 503.
 *
 * Reading it here settles the stream. It never buffers more than the cap plus one
 * chunk, so a lying Content-Length or a chunked body cannot force a large
 * allocation.
 */
async function readBounded(request: Request, max: number): Promise<ArrayBuffer | Response> {
  if (!request.body) return new ArrayBuffer(0);
  const tooLarge = () => Response.json({ error: "payload too large" }, { status: 413 });
  if (Number(request.headers.get("content-length") || 0) > max) return tooLarge();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return tooLarge();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

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
  locked: Set<string>; // anonymous devices locked after too many wrong codes
  buddies: Map<string, string>; // fleetId -> the token its clients present
  online: Set<string>; // which devices hold a tunnel right now
}
let mapCache: { at: number; snap: RegistrySnapshot } | null = null;
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

// Cached set of blocked address keys (see ipBlockKey). Same short TTL as the
// device map, invalidated by the admin block routes.
let blockedCache: { at: number; set: Set<string> } | null = null;

async function effectiveBlockedSet(env: Env): Promise<Set<string>> {
  if (blockedCache && Date.now() - blockedCache.at < MAP_CACHE_TTL_MS) return blockedCache.set;
  const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
  const set = new Set<string>();
  try {
    const r = await reg.fetch("https://registry/blocked");
    if (r.ok) {
      const j = (await r.json()) as { ips?: string[] };
      for (const key of j.ips || []) if (typeof key === "string" && key) set.add(key);
    }
  } catch {}
  blockedCache = { at: Date.now(), set };
  return set;
}

function invalidateBlockedCache(): void {
  blockedCache = null;
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
  expected?: string; // the token the device must present (undefined in open mode)
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
  const body = (await info.json()) as { member?: boolean; primary?: string | null };
  if (!asBuddy && !body.member) return Response.json({ error: "not a member of this fleet" }, { status: 403 });
  // The lease outlives the space that holds it by design, so a primary whose
  // tunnel is gone would be the answer for a while yet. It is taken out of the
  // running here, and the fleet is asked again: the member that is waiting in
  // the wings takes over on its next round, a second or two away.
  if (body.primary && (await vacateSilentPrimary(env, fleetId, body.primary))) {
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

  // The gateway relays on the primary's behalf, so it uses the primary's
  // own credential.
  const snap = await effectiveSnapshot(env);
  const primaryToken = snap.map.get(body.primary) ?? cfg.deviceToken;
  if (!primaryToken) return Response.json({ error: "the fleet's primary has no credential" }, { status: 503 });

  const deviceStub = env.DEVICES.get(env.DEVICES.idFromName(body.primary));
  const doUrl = new URL(url);
  doUrl.pathname = "/mcp";
  // The credential travels in the header, the same way it does for a call
  // that names a device: the object forwards it to the device, and the
  // device checks it.
  doUrl.search = "";
  const relayHeaders = new Headers();
  relayHeaders.set("content-type", request.headers.get("content-type") || "application/json");
  relayHeaders.set("x-device-id", body.primary);
  relayHeaders.set("x-device-token", primaryToken);
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
 * The token a fleet answers to as a device, if it is a fleet at all.
 *
 * A fleet is reached under its own name: the operator gives it a token, and
 * a client that presents it talks to the fleet's primary without being a
 * member of the fleet. Nothing is returned for a name that is not a fleet,
 * so a device keeps its own route.
 */
async function fleetBuddyToken(env: Env, id: string): Promise<string | undefined> {
  // The token rides in the registry snapshot, which every request already
  // reads: looking a fleet up costs nothing extra.
  const snap = await effectiveSnapshot(env);
  return snap.buddies.get(id);
}

/** Whether the request carries the given token. */
function tokenMatches(request: Request, url: URL, expected: string): boolean {
  const given = extractDeviceToken(request, url);
  return !!given && timingSafeEq(given, expected);
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
async function deviceOnline(env: Env, deviceId: string): Promise<boolean> {
  const snap = await effectiveSnapshot(env);
  return snap.online.has(deviceId);
}

/**
 * Take a primary that is not connected out of the running, so the next member
 * that asks takes its place.
 *
 * The lease is a clock, not a liveness check: a space whose machine went to
 * sleep still holds it until it runs out. This turns that wait into one round:
 * the space comes back in a second or two instead of in fifteen.
 */
async function vacateSilentPrimary(env: Env, fleetId: string, holder: string | null | undefined): Promise<string | null> {
  if (!env.FLEET || !holder) return null;
  if (await deviceOnline(env, holder)) return null;
  const stub = env.FLEET.get(env.FLEET.idFromName(fleetId));
  const headers = new Headers({ "content-type": "application/json", "x-prime-caller": "admin", "x-prime-fleet": fleetId });
  await stub
    .fetch("https://fleet/vacate", { method: "POST", headers, body: JSON.stringify({ deviceId: holder }) })
    .catch(() => null);
  return holder;
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
    const roster = await stub.fetch("https://fleet/members", { method: "GET", headers }).catch(() => null);
    const rosterBody = roster && roster.ok ? ((await roster.json()) as { members?: Array<Record<string, unknown>> }) : {};
    const primary = await stub.fetch("https://fleet/primary", { method: "GET", headers: adminHeaders(headers) }).catch(() => null);
    const primaryBody = primary && primary.ok ? ((await primary.json()) as { primary?: string | null }) : {};
    // The spaces that asked to join and are waiting for the operator.
    const waiting = await stub.fetch("https://fleet/pending", { method: "GET", headers }).catch(() => null);
    const waitingBody = waiting && waiting.ok ? ((await waiting.json()) as { pending?: Array<Record<string, unknown>> }) : {};
    const pending = (waitingBody.pending ?? []).map((p) => ({
      deviceId: String(p.deviceId ?? ""),
      label: typeof p.label === "string" ? p.label : undefined,
      requestedAt: typeof p.requestedAt === "number" ? p.requestedAt : 0,
      online: online.has(String(p.deviceId ?? "")),
    }));
    const members = (rosterBody.members ?? []).map((m) => ({
      deviceId: String(m.deviceId ?? ""),
      role: String(m.role ?? "member"),
      label: typeof m.label === "string" ? m.label : undefined,
      addedAt: typeof m.addedAt === "number" ? m.addedAt : 0,
      online: online.has(String(m.deviceId ?? "")),
      disabled: off.has(String(m.deviceId ?? "")),
      known: known.has(String(m.deviceId ?? "")),
    }));
    fleets.push({
      fleet: id,
      label: body.meta?.label ?? "",
      disabled: body.meta?.disabled === true,
      // The token this fleet answers to as a device, if the operator set one.
      buddy: snapshot.buddies.get(id) ?? "",
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

async function authorizeDevice(deviceId: string, request: Request, url: URL, cfg: GatewayConfig, env: Env): Promise<DeviceAuth> {
  const snap = await resolveSnapshot(env, deviceId);
  const anonymous = snap.anon.has(deviceId);
  if (hasNonVirtualDevice(snap, env) && !snap.map.has(deviceId)) return { denied: unauthorized(), anonymous };
  // Locked after too many wrong codes: refuse everyone, the right code included,
  // or the lock would not stop guessing.
  if (anonymous && snap.locked.has(deviceId)) {
    return {
      denied: Response.json({ error: "too many failed attempts; try again later" }, { status: 429, headers: { "retry-after": "600" } }),
      anonymous,
    };
  }
  const expected = snap.map.get(deviceId) ?? cfg.deviceToken;
  if (expected !== undefined) {
    const given = extractDeviceToken(request, url);
    if (!given || !timingSafeEq(given, expected)) {
      if (anonymous) {
        try {
          const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
          const r = await reg.fetch("https://registry/anon/fail?id=" + encodeURIComponent(deviceId), { method: "POST" });
          const j = (await r.json()) as { locked?: boolean };
          if (j.locked) mapCache = null; // pick the lock up on the next request
        } catch {}
      }
      return { denied: unauthorized(), expected, anonymous };
    }
  }
  if ((await effectiveDisabledSet(env)).has(deviceId)) {
    return { denied: Response.json({ error: "device disabled" }, { status: 403 }), expected, anonymous };
  }
  return { denied: null, expected, anonymous };
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
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        },
      });
    }

    // ---- Anonymous device registration ----
    // A client that has no registered device asks for one here: the gateway
    // picks an unused id and a 6-character code. Limits (per-IP creations, the
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
      try {
        const wanted = (await request.clone().json().catch(() => ({}))) as { fleet?: unknown; code?: unknown };
        const fleet = typeof wanted.fleet === "string" ? wanted.fleet : "";
        const code = typeof wanted.code === "string" ? wanted.code : "";
        if (fleet && code && env.FLEET && /^[a-z0-9][a-z0-9-]{0,31}$/.test(fleet)) {
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
    if (url.pathname.startsWith("/fleets/") || url.pathname.startsWith("/api/fleets/") || url.pathname === "/fleets") {
      if (url.pathname === "/fleets") {
        // The fleets that exist, for the operator: the list lives in the
        // registry, because the fleet objects cannot be enumerated.
        if (request.method !== "GET") return Response.json({ error: "fleet id required" }, { status: 400 });
        const t = extractToken(request, url, "auth");
        if (!cfg.gatewayToken || !t || !timingSafeEq(t, cfg.gatewayToken)) {
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
        deviceOnline: (deviceId: string) => deviceOnline(env, deviceId),
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
        return reg.fetch("https://registry/anon/list");
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
        const { deviceId, token } = (await resolved.json()) as { deviceId: string; token: string };
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
          // Same answer the registered-device Tools dialog gets from /mcp, but
          // relayed here so the code never reaches the browser.
          if ((await effectiveDisabledSet(env)).has(deviceId)) {
            return Response.json({ error: "device disabled" }, { status: 403 });
          }
          const headers = new Headers({ "content-type": "application/json", "x-device-id": deviceId, "x-device-token": token });
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
          const body = (await request.json().catch(() => ({}))) as { deviceId?: unknown };
          return await adminFleetAction(env, fleetId, "approve", { deviceId: String(body.deviceId ?? "") });
        }
        if (request.method === "POST" && step === "remove") {
          const body = (await request.json().catch(() => ({}))) as { deviceId?: unknown };
          return await adminFleetAction(env, fleetId, "remove", { deviceId: String(body.deviceId ?? "") });
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
          return await adminFleetAction(env, fleetId, "meta", patch);
        }
        return Response.json({ error: "not found" }, { status: 404 });
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
        // A new token must invalidate a tunnel opened with the old one: compare
        // with the current map before the upsert lands.
        let rotated: string | null = null;
        try {
          const body = (await request.clone().json()) as { deviceId?: unknown; token?: unknown };
          const id = typeof body.deviceId === "string" ? body.deviceId : "";
          const token = typeof body.token === "string" ? body.token : "";
          if (validDeviceId(id) && token) {
            const r = await reg.fetch("https://registry/map");
            if (r.ok) {
              const before = ((await r.json()) as { map?: Record<string, string> }).map?.[id];
              if (before !== undefined && before !== token) rotated = id;
            }
          }
        } catch {}
        const upstream = new Request("https://registry/upsert", {
          method: "POST",
          headers: { "content-type": request.headers.get("content-type") || "application/json" },
          body: request.body,
        });
        const res = await reg.fetch(upstream);
        if (rotated && res.ok) await kickDeviceTunnel(env, rotated);
        return res;
      }
      if (request.method === "GET" && url.pathname.startsWith("/admin/api/devices/") && url.pathname.endsWith("/origin")) {
        const deviceId = url.pathname.slice("/admin/api/devices/".length, -"/origin".length);
        if (!validDeviceId(deviceId)) return Response.json({ error: "invalid deviceId" }, { status: 400 });
        return originFor(env, env.DEVICES.get(env.DEVICES.idFromName(deviceId)));
      }
      if (request.method === "GET" && url.pathname.startsWith("/admin/api/devices/") && url.pathname.endsWith("/clients")) {
        const deviceId = url.pathname.slice("/admin/api/devices/".length, -"/clients".length);
        if (!validDeviceId(deviceId)) return Response.json({ error: "invalid deviceId" }, { status: 400 });
        const stub = env.DEVICES.get(env.DEVICES.idFromName(deviceId));
        return stub.fetch("https://device/clients");
      }
      if (request.method === "POST" && url.pathname.startsWith("/admin/api/devices/") && url.pathname.endsWith("/tools")) {
        // The same answer the tools dialog gets from /mcp, relayed here so
        // the token never reaches the browser. A fleet member is an
        // anonymous device, and the admin is not given its token.
        const deviceId = url.pathname.slice("/admin/api/devices/".length, -"/tools".length);
        if (!validDeviceId(deviceId)) return Response.json({ error: "invalid deviceId" }, { status: 400 });
        if ((await effectiveDisabledSet(env)).has(deviceId)) {
          return Response.json({ error: "device disabled" }, { status: 403 });
        }
        const map = await reg.fetch("https://registry/map");
        const token = map.ok ? ((await map.json()) as { map?: Record<string, string> }).map?.[deviceId] : undefined;
        if (!token) return Response.json({ error: "no such device" }, { status: 404 });
        const headers = new Headers({ "content-type": "application/json", "x-device-id": deviceId, "x-device-token": token });
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
    if ((request.method === "GET" || request.method === "HEAD") && (url.pathname === "/connect" || url.pathname === "/mcp")) {
      if (url.pathname === "/mcp") return redirectTo(url, "/connect");
      if (url.searchParams.has("asset")) return sandboxAsset(url.searchParams.get("asset"));
      if (url.searchParams.has("frame") || url.searchParams.has("ticket")) return handleSandbox(request, env, url);
      return new Response(request.method === "HEAD" ? null : LANDING_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "cache-control": "no-store",
        },
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
        if (!buddy || !tokenMatches(request, url, buddy)) return unauthorized();
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
      let ticketNonce: string | null = null;
      const ticket = url.searchParams.get("ticket");
      if (ticket) {
        const registered = (await resolveSnapshot(env, deviceId)).map.get(deviceId);
        const verdict = registered === undefined ? null : await verifyTicket(deviceId, ticket, registered);
        if (!verdict) return unauthorized();
        ticketNonce = verdict.nonce;
        url.searchParams.delete("ticket");
        const withToken = new Headers(request.headers);
        withToken.set("x-device-token", registered!);
        request = new Request(url, { headers: withToken, method: request.method });
      }

      const auth = await authorizeDevice(deviceId, request, url, cfg, env);
      if (auth.denied) return auth.denied;
      const expected = auth.expected;

      // Virtual devices are in-process only - they have no tunnel to upgrade.
      if (virtualDeviceIds(env).has(deviceId)) {
        return Response.json({ error: "virtual device has no tunnel" }, { status: 400 });
      }

      const stub = env.DEVICES.get(env.DEVICES.idFromName(deviceId));
      // Keep the upgrade headers; add x-device-id for the DO, and forward the
      // validated device token as x-auth-token + the effective expected token
      // as x-expected-token so the DO's defense-in-depth check matches the
      // registry (the DO reads x-expected-token first, then its env copy).
      const headers = new Headers(request.headers);
      headers.delete("x-ticket-nonce");
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
      const givenToken = extractDeviceToken(request, url);
      if (givenToken) headers.set("x-auth-token", givenToken);
      const upstream = new Request(url, { headers, method: request.method });
      return stub.fetch(upstream);
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
};
