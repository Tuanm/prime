// Cloudflare Worker entry for the code-mcp gateway.
//
// Routing model:
//   GET  /admin                   -> admin UI (Cloudflare Access protected)
//   GET  /admin/api/devices       -> device registry (admin token)
//   POST /admin/api/devices       -> register/update a device (admin token)
//   DELETE /admin/api/devices/{id}-> remove a device (admin token)
//   GET  /devices                 -> online deviceIds (admin token)
//   POST /mcp/{deviceId}          -> gateway auth + rate limit -> DeviceDO
//   WS   /ws/{deviceId}           -> device auth + origin check -> DeviceDO upgrade
//   WS   /ws?deviceId=            -> legacy path -> DeviceDO upgrade
//
// All device state (WebSocket + pending requests) lives in a DeviceDO keyed by
// deviceId, so every HTTP request finds the right tunnel regardless of which
// isolate handled it. The device->token registry is writable and lives in the
// RegistryDO (durable storage), seeded once from the DEVICE_TOKENS secret, so
// the admin UI can register devices at runtime without a redeploy.

import { loadConfig, timingSafeEq, extractToken, extractDeviceToken, validDeviceId } from "./config";
import type { Env, GatewayConfig } from "./config";
import { RateLimiter, clientIp } from "./rate-limit";
import { ADMIN_HTML } from "./admin-ui";

export { DeviceDO } from "./device-do";
export { RegistryDO } from "./registry-do";

const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401 });

// Per-isolate rate limiter. Configured once on first fetch (module scope is
// shared across requests within an isolate; a fresh isolate re-creates it).
let rateLimiter: RateLimiter | null = null;
let limiterWindowMs = 0;
let limiterMax = 0;

// Effective device->token map, backed by the RegistryDO (durable storage).
// Cached briefly per isolate; admin mutations invalidate the local cache and
// other isolates pick the change up within the TTL.
let mapCache: { at: number; map: Map<string, string> } | null = null;
const MAP_CACHE_TTL_MS = 2_000;

async function effectiveDeviceMap(env: Env): Promise<Map<string, string>> {
  if (mapCache && Date.now() - mapCache.at < MAP_CACHE_TTL_MS) return mapCache.map;
  const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
  const map = new Map<string, string>();
  try {
    const r = await reg.fetch("https://registry/map");
    if (r.ok) {
      const j = (await r.json()) as { map?: Record<string, string> };
      for (const [id, tok] of Object.entries(j.map || {})) {
        if (typeof tok === "string" && tok.length > 0) map.set(id, tok);
      }
    }
  } catch {}
  mapCache = { at: Date.now(), map };
  return map;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cfg = loadConfig(env);
    const url = new URL(request.url);

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

      if (request.method === "GET" && url.pathname === "/admin/api/devices") {
        return reg.fetch("https://registry/full");
      }
      if (request.method === "POST" && url.pathname === "/admin/api/devices") {
        mapCache = null;
        const upstream = new Request("https://registry/upsert", {
          method: "POST",
          headers: { "content-type": request.headers.get("content-type") || "application/json" },
          body: request.body,
        });
        return reg.fetch(upstream);
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/admin/api/devices/")) {
        const deviceId = url.pathname.slice("/admin/api/devices/".length);
        if (!validDeviceId(deviceId)) return Response.json({ error: "invalid deviceId" }, { status: 400 });
        mapCache = null;
        return reg.fetch(
          new Request("https://registry/remove", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ deviceId }),
          }),
        );
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
      const map = await effectiveDeviceMap(env);
      const perDeviceMode = map.size > 0;
      if (perDeviceMode && !map.has(deviceId)) return unauthorized();
      const expected = map.get(deviceId) ?? cfg.deviceToken;
      if (expected !== undefined) {
        const given = extractDeviceToken(request, url);
        if (!given || !timingSafeEq(given, expected)) return unauthorized();
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
      const xdt = request.headers.get("x-device-token");
      if (xdt) headers.set("x-device-token", xdt);
      // Preserve auth params for the DO's own device-auth check.
      const t = extractToken(request, url, "auth");
      if (t) headers.set("x-auth-token", t);
      const upstream = new Request(doUrl, { method: "POST", headers, body: request.body });
      return stub.fetch(upstream);
    }

    // WS upgrade: /ws/{deviceId} (preferred) or /ws?deviceId= (legacy)
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
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
      const map = await effectiveDeviceMap(env);
      const perDeviceMode = map.size > 0;
      if (perDeviceMode && !map.has(deviceId)) return unauthorized();
      const expected = map.get(deviceId) ?? cfg.deviceToken;
      if (expected !== undefined) {
        const given = extractDeviceToken(request, url);
        if (!given || !timingSafeEq(given, expected)) return unauthorized();
      }

      const stub = env.DEVICES.get(env.DEVICES.idFromName(deviceId));
      // Keep the upgrade headers; add x-device-id for the DO, and forward the
      // validated device token as x-auth-token + the effective expected token
      // as x-expected-token so the DO's defense-in-depth check matches the
      // registry (the DO reads x-expected-token first, then its env copy).
      const headers = new Headers(request.headers);
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
