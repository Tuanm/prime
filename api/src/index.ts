// Cloudflare Worker entry for the code-mcp gateway.
//
// Routing model:
//   GET  /admin                   -> admin UI (Cloudflare Access protected)
//   GET  /admin/api/devices       -> device registry (admin token)
//   POST /admin/api/devices       -> register/update a device (admin token)
//   DELETE /admin/api/devices/{id}-> remove a device (admin token)
//   GET  /devices                 -> online deviceIds (admin token)
//   POST /mcp/{deviceId}          -> gateway auth + rate limit -> DeviceDO
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
import { handleSandbox, handleSandboxDevicePage, verifyTicket } from "./sandbox";
import { effectiveDisabledSet, invalidateDisabledCache } from "./device-state";
import { ipBlockKey } from "./config";
import { verifyAccessJwt } from "./access";
import { sandboxAsset } from "./sandbox-assets";

export { DeviceDO } from "./device-do";
export { RegistryDO } from "./registry-do";
export { CodingSandbox } from "./coding-sandbox";
export { FilesDO } from "./files-do";

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
  const snap: RegistrySnapshot = { map: new Map(), anon: new Set(), locked: new Set() };
  try {
    const r = await reg.fetch("https://registry/map");
    if (r.ok) {
      const j = (await r.json()) as { map?: Record<string, string>; anonymous?: string[]; locked?: string[] };
      for (const [id, tok] of Object.entries(j.map || {})) {
        if (typeof tok === "string" && tok.length > 0) snap.map.set(id, tok);
      }
      for (const id of j.anonymous || []) snap.anon.add(id);
      for (const id of j.locked || []) snap.locked.add(id);
    }
  } catch {}
  return snap;
}

async function effectiveSnapshot(env: Env): Promise<RegistrySnapshot> {
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
      const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
      const created = await reg.fetch("https://registry/anon/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ip: clientIp(request) }),
      });
      if (created.status !== 201) return created;
      const { deviceId, token } = (await created.json()) as { deviceId: string; token: string };
      mapCache = null;
      const wsScheme = url.protocol === "https:" ? "wss:" : "ws:";
      return Response.json(
        {
          deviceId,
          token,
          connect_url: url.origin + "/mcp/" + encodeURIComponent(deviceId) + "?token=" + encodeURIComponent(token),
          ws_url: wsScheme + "//" + url.host + "/ws/" + encodeURIComponent(deviceId),
          anonymous: true,
          rate_limit: { max: anonConfig(env).rateMax, window_ms: cfg.rateWindowMs },
        },
        { status: 201, headers: { "cache-control": "no-store" } },
      );
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

      if (request.method === "GET" && url.pathname === "/admin/api/devices") {
        return reg.fetch("https://registry/full");
      }
      if (request.method === "POST" && url.pathname === "/admin/api/devices") {
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
        const current = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return Response.json({ ...current, ok: true, disabled, tunnelDropped: dropped });
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
    const download = /^\/mcp\/([^/]+)\/download\/([a-f0-9]{64})$/.exec(url.pathname);
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

    // GET /sandbox: the Sandbox page (this browser as a device); POST
    // /sandbox?ticket=1 mints its WebSocket ticket. /mcp is the product page now
    // (the old home page), and the old sandbox URLs keep working there.
    if (url.pathname === "/sandbox" && request.method === "GET" && url.searchParams.has("asset")) return sandboxAsset(url.searchParams.get("asset"));
    if (url.pathname === "/sandbox") return handleSandbox(request, env, url);
    if (url.pathname === "/mcp" && request.method === "GET") {
      if (url.searchParams.has("asset")) return sandboxAsset(url.searchParams.get("asset"));
      if (url.searchParams.has("frame") || url.searchParams.has("ticket")) return handleSandbox(request, env, url);
      return new Response(LANDING_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "cache-control": "no-store",
        },
      });
    }
    if (url.pathname === "/mcp" && request.method === "POST" && url.searchParams.has("ticket")) return handleSandbox(request, env, url);

    // GET /sandbox/{deviceId} in a browser: the Sandbox page, which asks for
    // the device token. Old /mcp/{deviceId} links are sent there.
    if ((request.method === "GET" || request.method === "HEAD") && /^\/sandbox\/[^/]+$/.test(url.pathname)) {
      return handleSandboxDevicePage(request, env, url);
    }
    if ((request.method === "GET" || request.method === "HEAD") && /^\/mcp\/[^/]+$/.test(url.pathname) && (request.headers.get("accept") || "").includes("text/html")) {
      const to = new URL(url);
      to.pathname = "/sandbox/" + url.pathname.slice("/mcp/".length);
      return new Response(null, { status: 302, headers: { location: to.toString(), "cache-control": "no-store" } });
    }

    // Non-POST on /mcp/{deviceId}: this is a POST-only JSON-RPC endpoint.
    // Return a clear 405 instead of a bare 404 so opening the URL in a browser
    // (or an SSE-style client) gets an actionable message, not "cannot connect".
    if (request.method !== "POST" && url.pathname.startsWith("/mcp/")) {
      return Response.json(
        { error: "method not allowed", hint: "POST JSON-RPC to this URL; GET/HEAD are not supported (Streamable HTTP)" },
        { status: 405 },
      );
    }

    // POST /mcp/{deviceId}
    if (request.method === "POST" && url.pathname.startsWith("/mcp/")) {
      if (cfg.gatewayToken) {
        const t = extractToken(request, url, "auth");
        if (!t || !timingSafeEq(t, cfg.gatewayToken)) return unauthorized();
      }

      // Cheap per-isolate rate limit (global enforcement via CF edge rules).
      if (!getLimiter(cfg).allow(clientIp(request))) {
        return Response.json({ error: "rate limited" }, { status: 429 });
      }

      const deviceId = url.pathname.slice(5);
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
      const sid = request.headers.get("prime-session-id");
      if (sid && /^[\x21-\x7e]{1,128}$/.test(sid)) headers.set("prime-session-id", sid);
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
    if (request.method === "GET" && (url.pathname.startsWith("/sse/") || url.pathname === "/sse")) {
      const deviceId = url.pathname.startsWith("/sse/")
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
    if (request.method === "POST" && (url.pathname.startsWith("/messages/") || url.pathname === "/messages")) {
      const deviceId = url.pathname.startsWith("/messages/")
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

    // WS upgrade: /ws/{deviceId} (preferred) or /ws?deviceId= (legacy)
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
      if (url.pathname.startsWith("/ws/")) {
        deviceId = url.pathname.slice(4);
      } else if (url.pathname === "/ws") {
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
