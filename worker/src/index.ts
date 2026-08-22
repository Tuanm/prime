// Cloudflare Worker entry for the code-mcp gateway.
//
// Routing model:
//   GET  /devices               -> RegistryDO (auth: admin/gateway token)
//   POST /mcp/{deviceId}        -> gateway auth + rate limit -> DeviceDO
//   WS   /ws/{deviceId}         -> device auth + origin check -> DeviceDO upgrade
//   WS   /ws?deviceId=          -> legacy path -> DeviceDO upgrade
//
// All device state (WebSocket + pending requests) lives in a DeviceDO keyed by
// deviceId, so every HTTP request finds the right tunnel regardless of which
// isolate handled it. This is the key difference from the single-process Bun
// gateway: on Workers, plain in-memory state would be per-isolate and would
// break cross-isolate routing.

import { loadConfig, timingSafeEq, extractToken, validDeviceId } from "./config";
import type { Env } from "./config";
import { RateLimiter, clientIp } from "./rate-limit";

export { DeviceDO } from "./device-do";
export { RegistryDO } from "./registry-do";

const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401 });

// Per-isolate rate limiter. Configured once on first fetch (module scope is
// shared across requests within an isolate; a fresh isolate re-creates it).
let rateLimiter: RateLimiter | null = null;
let limiterWindowMs = 0;
let limiterMax = 0;

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
    // /devices - admin listing. Requires the admin (or gateway) token. There is
    // no loopback concept on Workers, so token auth replaces the Bun
    // loopback-and-no-proxy-header check.
    if (request.method === "GET" && url.pathname === "/devices") {
      if (cfg.adminToken) {
        const t = extractToken(request, url, "auth");
        if (!t || !timingSafeEq(t, cfg.adminToken)) return unauthorized();
      }
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

      // Device auth at connect (checked again inside the DO for defense in
      // depth; here we reject before creating a DO instance).
      if (cfg.deviceToken) {
        const t = extractToken(request, url, "auth");
        if (!t || !timingSafeEq(t, cfg.deviceToken)) return unauthorized();
      }

      const stub = env.DEVICES.get(env.DEVICES.idFromName(deviceId));
      // Keep the upgrade headers; add x-device-id for the DO.
      const headers = new Headers(request.headers);
      headers.set("x-device-id", deviceId);
      const upstream = new Request(url, { headers, method: request.method });
      return stub.fetch(upstream);
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
};
