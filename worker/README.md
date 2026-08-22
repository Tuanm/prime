# Prime (Cloudflare Worker)

A high-throughput, globally-distributed reimplementation of the code-mcp gateway
built on **Cloudflare Workers + Durable Objects**. It is wire-compatible with the
Bun gateway (`../gateway`): devices and MCP clients do not need to change.

## Why Durable Objects?

A Cloudflare Worker runs many **isolates** with no shared memory. A device's
WebSocket is pinned to the isolate that accepted it, so a plain-Worker design
could not find the tunnel when an HTTP `/mcp/{deviceId}` request landed on a
different isolate.

**Durable Objects** give every deviceId a deterministic single instance
(`idFromName(deviceId)`) that owns BOTH the WebSocket AND the pending-request
registry. Every `/mcp` and `/ws` request routes to the same colocated object,
so routing is always correct, low-latency, and scales horizontally per device
(a busy device only affects its own object, not the whole gateway).

## Architecture

```
MCP client --HTTP--> Worker --DO stub--> DeviceDO(deviceId) --WS--> code-mcp device
                                   \-> RegistryDO (global /devices listing)
```

- **`src/index.ts`** — entry point: routing, gateway/device auth, per-isolate
  rate limiting, origin whitelist. Stateless, scales across all isolates.
- **`src/device-do.ts`** — one object per device: WebSocket + pending requests,
  request timeout, keepalive watchdog (via alarms so it fires while hibernated),
  per-device pending budget, cross-device response guard (trivially safe: the DO
  owns exactly one device).
- **`src/registry-do.ts`** — single shared object that tracks online deviceIds
  for `GET /devices` (persisted to durable storage, TTL-swept).
- **`src/config.ts` / `src/rate-limit.ts`** — env-based config + helpers.

The DeviceDO uses the **WebSocket Hibernation API** (`state.acceptWebSocket()`),
so idle device tunnels cost nothing (the object sleeps between messages) and
wake instantly on traffic — ideal for a fleet of long-lived device connections.

## Deploy

```bash
cd worker
npm install

# Configure secrets (tokens are NEVER committed; use wrangler secrets)
# RECOMMENDED: per-device tokens so no one can claim/intercept another device.
npx wrangler secret put DEVICE_TOKENS    # JSON map: {"deviceId": "token", ...}
npx wrangler secret put GATEWAY_TOKEN    # optional bearer token for /mcp/*
npx wrangler secret put ADMIN_TOKEN      # optional /devices auth (defaults to GATEWAY_TOKEN)

npx wrangler deploy
```

Tunables live in `wrangler.toml` under `[vars]` (mirror the Bun gateway flags):
`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `TIMEOUT_MS`,
`MAX_PENDING_PER_DEVICE`, `MAX_BODY_BYTES`, `KEEPALIVE_TIMEOUT_MS`,
`PING_INTERVAL_MS`, `PING_MAX_MISSES`, `IDLE_TIMEOUT_MS`,
`ALLOWED_ORIGINS` (comma-separated origin whitelist).

> **Long tool calls**: `TIMEOUT_MS` defaults to 300s (5 minutes). Cloudflare
> gives Durable Objects and incoming HTTP requests **unlimited wall time** while
> the caller stays connected, so long operations (recording, `wait_for`,
> downloads) are relayed correctly as long as the client keeps the connection
> open - the per-device keepalive (25s) does exactly that.

> Durable Objects require a Cloudflare **Paid** plan (or higher).

## Local development

```bash
cd worker
npm run dev          # wrangler dev --local (miniflare/workerd on :8787)
```

## Test

```bash
cd worker
npm test             # starts two local wrangler instances, runs 16 scenarios
```

For a manual run against already-started instances:

```bash
# terminal 1
wrangler dev --local --port 8801 --var TIMEOUT_MS:3000 --var ALLOWED_ORIGINS:https://good.example --var MAX_PENDING_PER_DEVICE:2 --var MAX_BODY_BYTES:256
# terminal 2
wrangler dev --local --port 8802 --var GATEWAY_TOKEN:gw-secret-abc --var DEVICE_TOKEN:dev-secret-xyz --var ADMIN_TOKEN:admin-secret-xyz
# terminal 3
GW_PLAIN_PORT=8801 GW_AUTH_PORT=8802 bun test/smoke.ts
```

> Note: miniflare persists Durable Object state under `.wrangler/state`. After
> a hard kill, stale sockets may linger until the keepalive alarm fires
> (default 90s). For a clean local run: `rm -rf .wrangler/state` before starting.

Covers: gateway/device auth, duplicate registration rejection, register-message
takeover blocking, end-to-end JSON-RPC relay, cross-device response blocking,
request timeout, body cap, per-device pending budget, origin whitelist,
keepalive ack, invalid deviceId rejection, /devices listing, relay-token
forwarding.

## Security model

Hardened beyond the Bun gateway - designed so no attacker can steal or
intercept a connection, and no one can learn who is connected:

- **Per-device authentication** (`DEVICE_TOKENS`, a JSON map
  `{deviceId: token}`). At `/ws` connect AND at `/mcp` relay, the device's
  secret is required and compared in constant time. An attacker who does not
  know a device's token cannot:
  - claim that deviceId over WebSocket (hijack), or
  - relay requests to it over `/mcp` (intercept), or
  - learn whether the deviceId exists (unknown ids return the same 401 -
    no existence oracle), or
  - force Durable Object creation for made-up ids (no DO churn / cost).
  A shared `DEVICE_TOKEN` fallback is supported for deployments that do not
  need per-device secrets.
- **/devices is NEVER public**: it requires the admin token; if no admin token
  is configured the endpoint is hidden entirely (404), so a misconfigured
  gateway does not leak the device roster.
- **`GATEWAY_TOKEN`** (optional): additional client -> gateway auth for /mcp.
- **DeviceId collision rejection** (409) — a second client cannot hijack an
  in-use deviceId (enforced atomically inside the DO).
- **Register-message mismatch rejected** — a device bound to one DO cannot rebind
  to another deviceId.
- **Per-device pending budget** — one slow device cannot exhaust the gateway.
- **Cross-device response guard** — a WS may only resolve pendings of its own
  device (inherent: one DO = one device).
- **Body cap** (`MAX_BODY_BYTES`) against JSON bombs.
- **Keepalive watchdog** — stale tunnels dropped after `KEEPALIVE_TIMEOUT_MS`
  with no frame (alarm-driven, survives hibernation).
- **Origin whitelist** for browser-style WS clients.
- **Rate limiting**: per-isolate in-memory limiter (cheap first line). For
  global per-IP limits, add a Cloudflare **Rate Limiting rule** in the dashboard
  targeting `CF-Connecting-IP` (the edge header is set by Cloudflare and cannot
  be spoofed by clients).

## API (unchanged from the Bun gateway)

| Method | Path                | Auth      | Description                          |
| ------ | ------------------- | --------- | ------------------------------------ |
| GET    | /devices            | admin     | List registered devices (token-gated)|
| POST   | /mcp/{deviceId}     | gateway   | Relay JSON-RPC body to device        |
| WS     | /ws/{deviceId}      | device    | Device WebSocket (preferred)         |
| WS     | /ws?deviceId=<id>   | device    | Legacy device WebSocket              |

`POST /mcp/{deviceId}` also accepts a device-relay token forwarded to the
device via the tunnel envelope (`X-Device-Token` header or `?token=` query) —
opaque to the gateway, validated device-side.
