# Prime

Cloudflare Worker gateway for exposing your **browser-mcp** (or code-mcp)
devices to MCP clients over the internet via WebSocket tunneling.

Built on **Workers + Durable Objects**: each device's WebSocket tunnel and
pending-request state live in a Durable Object keyed by `deviceId`, so every
`/mcp` and `/ws` request routes to the same object regardless of which isolate
handled it. Globally distributed, auto-scaling, zero servers to manage.

## Quick start
```bash
cd worker
npm install
npx wrangler secret put DEVICE_TOKENS   # JSON map, e.g. {"my-device":"my-secret"}
npx wrangler secret put ADMIN_TOKEN     # optional: gates GET /devices (hidden without it)
npx wrangler deploy
```

- Device connects: `wss://<worker>/ws/<deviceId>?token=<deviceToken>`
- MCP clients call: `POST <worker>/mcp/<deviceId>?token=<deviceToken>`

## Documentation

- [worker/README.md](worker/README.md) — architecture, security model, deploy & test
- [browser-mcp](https://github.com/Tuanm/browser-mcp) — the browser extension that acts as the MCP device

## Development
```bash
cd worker
npm test         # smoke suite (spawns local wrangler instances)
npm run typecheck
npm run deploy
```
