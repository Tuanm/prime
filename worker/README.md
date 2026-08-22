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
npx wrangler secret put GATEWAY_TOKEN    # optional bearer token for /mcp/*
npx wrangler secret put DEVICE_TOKEN     # optional bearer token for /ws/* device auth
npx wrangler secret put ADMIN_TOKEN      # optional; defaults to GATEWAY_TOKEN for /devices

npx wrangler deploy
```

Tunables live in `wrangler.toml` under `[vars]` (mirror the Bun gateway flags):
`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `TIMEOUT_MS`,
`MAX_PENDING_PER_DEVICE`, `MAX_BODY_BYTES`, `KEEPALIVE_TIMEOUT_MS`,
`PING_INTERVAL_MS`, `PING_MAX_MISSES`, `IDLE_TIMEOUT_MS`,
`ALLOWED_ORIGINS` (comma-separated origin whitelist).

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

Identical guarantees to the Bun gateway:

- **Two separate tokens**: `GATEWAY_TOKEN` (HTTP clients -> /mcp) and
  `DEVICE_TOKEN` (devices -> /ws). Both accept `Authorization: Bearer` or
  `?auth=`; compared in constant time.
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
