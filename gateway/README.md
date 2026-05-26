# Code Gateway Server (Cloudflare Workers)

## Deploy

```bash
cp .env.example .env
# Fill in CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, GATEWAY_DOMAIN, GATEWAY_TOKEN
wrangler deploy
```

## Cloudflare API Token Permissions

Create a custom token at **Cloudflare Dashboard → My Profile → API Tokens → Create Custom Token** with:

| Resource | Permission |
|----------|------------|
| `Account` | `Edit` |

This is the minimum required for `wrangler deploy`.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/ws` | WebSocket upgrade — device connects here |
| POST | `/mcp` | HTTP MCP relay — requires `x-device-id` header, optional `x-token` header |
| GET | `/devices` | List online device IDs |

### POST /mcp Headers

| Header | Required | Description |
|--------|----------|-------------|
| `x-device-id` | Yes | Target device UUID |
| `x-token` | No | Auth token forwarded to local code-mcp as `?token=` |

## Security

| Feature | Description |
|---------|-------------|
| **Gateway auth** | Optional `GATEWAY_TOKEN` env var — if set, all requests require `Authorization: Bearer <token>` |
| **Rate limiting** | 100 requests/minute per IP (via `CF-Connecting-IP`) |
| **Pending cap** | Max 100 in-flight requests per device — rejects with 503 if exceeded |
| **Body validation** | Invalid JSON returns 400 |
| **Request timeout** | 30s per request — returns 504 on timeout |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CLOUDFLARE_ACCOUNT_ID` | Found in Cloudflare Dashboard URL or overview page |
| `CLOUDFLARE_API_TOKEN` | Token with `Account: Edit` permission |
| `GATEWAY_DOMAIN` | Public domain after deploy |
| `GATEWAY_TOKEN` | Optional bearer token for gateway-level auth |
