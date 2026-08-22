# Prime

A gateway for exposing local code-mcp servers to the internet via WebSocket
tunneling. Two deployment targets:

## Option 1: Cloudflare Worker (recommended)

Globally-distributed, low-latency, high-throughput, auto-scaling. Built on
**Workers + Durable Objects** so device tunnels and pending requests are
colocated per deviceId and survive multi-isolate routing. No server to manage,
no 512MB instance to hang under load.

See [worker/README.md](worker/README.md) for architecture, deploy and test.
```bash
cd worker
npm install
npx wrangler secret put GATEWAY_TOKEN
npx wrangler secret put DEVICE_TOKEN
npx wrangler deploy
```

## Option 2: Bun self-hosted (VM / VPS)

The original single-process gateway, ideal for local/self-hosted use.

See [gateway/README.md](gateway/README.md) for detailed usage.
```bash
cd gateway
bun install
bun run start --port 8080
```

## Features (both)

- **WebSocket tunneling** — devices connect via WebSocket, relay HTTP requests
- **Two-token auth** — gateway token (client -> /mcp) and device token
  (device -> /ws), compared in constant time
- **Per-device pending budget** — one slow device cannot exhaust the gateway
- **Cross-device response guard** — a WS may only resolve its own device's
  pending requests
- **Keepalive watchdog** — stale tunnels dropped after a configurable idle window
- **Rate limiting** — per-IP limiter (+ Cloudflare edge rules on the Worker)
- **Body cap** — JSON-bomb protection
- **Registry** — track connected devices (`/devices`)

The tunnel protocol is identical in both versions: devices and MCP clients do
not need to change when migrating.
