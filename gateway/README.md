# Prime

A Bun-based gateway server for exposing local code-mcp servers via WebSocket tunneling.

## Usage

```bash
bun run server.ts [options]
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--port <n>` | Listen port | `8080` |
| `--token <s>` | Bearer token auth | none |
| `--rate-window <ms>` | Rate limit window | `60000` |
| `--rate-max <n>` | Max requests per window | `100` |
| `--timeout <ms>` | Request timeout | `30000` |
| `--max-pending <n>` | Max pending requests | `100` |

## Examples

```bash
# Basic
bun run start --port 8080

# With auth
bun run start --port 8080 --token mysecret

# High performance
bun run start --port 8080 --rate-max 1000 --timeout 60000
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/devices` | List registered devices |
| `POST` | `/mcp` | Relay JSON-RPC to device |
| `WS` | `/ws?deviceId=<id>` | Device WebSocket |

### Headers

| Header | Required | Description |
|--------|----------|-------------|
| `x-device-id` | Yes* | Target device UUID |
| `x-token` | No | Device auth token |
| `Authorization` | No* | Bearer token for gateway auth |

*Required unless using WebSocket with deviceId in query

## Architecture

```
Client → Gateway (HTTP) → WebSocket → code-mcp (device) → localhost
```
