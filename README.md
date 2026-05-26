# Prime

A Cloudflare Workers gateway that exposes local code-mcp servers to the internet without requiring `cloudflared` tunnels.

## Architecture
```
External Caller → Cloudflare Workers
                            ↓ WebSocket
              code-mcp --gateway {domain} (device)
                            ↓ HTTP
              code-mcp server (localhost)
```

## Quick Start

### 1. Deploy Gateway
```bash
cd gateway
cp .env.example .env
# Edit .env with:
#   CLOUDFLARE_ACCOUNT_ID
#   CLOUDFLARE_API_TOKEN

wrangler deploy
```

The deployed URL (e.g., `https://code-gateway.your-subdomain.workers.dev`) is your gateway domain.

### 2. Connect Devices
```bash
# Bun
bun code-mcp.ts --gateway https://code-gateway.your-subdomain.workers.dev --port 7777
```

Each device registers with a self-generated UUID and maintains a persistent WebSocket connection.

### 3. Send Requests
```bash
curl -X POST https://code-gateway.your-subdomain.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -H "x-device-id: <device-uuid>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"bash","params":{"command":"ls"}}}'
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/devices` | List registered device IDs |
| `POST` | `/mcp` | Relay JSON-RPC request to device |
| `WS` | `/ws` | Device WebSocket connection |

### Request Headers

| Header | Required | Description |
|--------|----------|-------------|
| `x-device-id` | Yes | Target device UUID |
| `x-token` | No | Device auth token (if configured) |

### Response Codes

| Code | Meaning |
|------|---------|
| `200` | Success |
| `400` | Invalid JSON |
| `401` | Unauthorized |
| `429` | Rate limited |
| `503` | Device offline or busy |
| `504` | Request timeout |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token |
| `GATEWAY_TOKEN` | Optional bearer token — if set, all requests require `Authorization: Bearer <token>` |
