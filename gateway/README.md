# Prime

A Bun-based gateway server for exposing local code-mcp servers via WebSocket tunneling.
Designed to be deployed on a public VM.

## Usage

```bash
bun run server.ts [options] [install|uninstall]
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--port <n>` | Listen port | `8080` |
| `--token <s>` | Gateway bearer token (client -> gateway) | none (public) |
| `--device-token <s>` | Device bearer token (device -> gateway at WS connect) | none (public) |
| `--rate-window <ms>` | Rate limit window | `60000` |
| `--rate-max <n>` | Max requests per IP per window | `100` |
| `--timeout <ms>` | Request timeout | `30000` |
| `--max-pending <n>` | Max pending requests per device | `100` |
| `--max-body <bytes>` | Max HTTP request body bytes | `1048576` (1 MiB) |
| `--trust-proxy` | Trust `X-Forwarded-For` / `X-Real-IP` for client IP | off |
| `--allowed-origin <csv>` | Comma-separated WS `Origin` whitelist | any |
| `--ping-interval <ms>` | WS ping interval | `30000` |
| `--ping-max-misses <n>` | Drop WS after N missed pongs | `2` |
| `--idle-timeout <sec>` | Bun WS idle timeout | `120` |

### Examples

```bash
# Public VM (recommended)
bun run start \
  --port 8080 \
  --token client_secret_xxx \
  --device-token device_secret_yyy \
  --trust-proxy

# Local
bun run start --port 8080
```

## Authentication

The gateway supports **two separate tokens**:

- **Gateway token** (`--token`): authenticates HTTP clients hitting `/mcp/{deviceId}`.
- **Device token** (`--device-token`): authenticates WebSocket clients connecting to `/ws/...`.

Both can be supplied via either form:

| Method | Header | Query string |
|--------|--------|--------------|
| Gateway | `Authorization: Bearer <token>` | `?auth=<token>` |
| Device  | `Authorization: Bearer <token>` | `?auth=<token>` |

Tokens are compared in constant time.

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/devices` | loopback only | List registered devices (rejected with 404 from non-loopback) |
| `POST` | `/mcp/{deviceId}` | gateway | Relay JSON-RPC body to device |
| `WS` | `/ws/{deviceId}` | device | Device WebSocket (preferred) |
| `WS` | `/ws?deviceId=<id>` | device | Legacy WebSocket (server assigns UUID if omitted) |

`POST /mcp/{deviceId}` also accepts a **device-relay token** which is forwarded to the device side via the tunnel envelope:

| Method | Header | Query string |
|--------|--------|--------------|
| Relay | `X-Device-Token: <token>` | `?token=<token>` |

This is separate from the gateway token and is opaque to the gateway.

## Security Hardening

The gateway implements:

- **Per-device authentication** at WebSocket connect time (no anonymous device registration when `--device-token` is set).
- **DeviceId collision rejection**: a second client cannot hijack an in-use deviceId (returns 409). The `register` message accepts only unused deviceIds.
- **Per-device pending budget**: one slow device cannot exhaust the global queue for the rest.
- **Cross-device response confusion guard**: a WS may only resolve pendings owned by its own deviceId.
- **Rate limit by real client IP**: defaults to TCP peer address. Use `--trust-proxy` only when behind a known proxy that sets `X-Forwarded-For`.
- **Rate limit map sweep**: expired buckets are reaped periodically (no unbounded growth from rotating IPs).
- **Request body cap** (`--max-body`) and WS payload cap to prevent JSON bombs.
- **WebSocket liveness pings**: dead TCP connections are detected and dropped within `ping-interval * (ping-max-misses + 1)` seconds.
- **`/devices` loopback-only**: never exposed to remote callers.
- **Optional Origin whitelist** (`--allowed-origin`) to mitigate cross-site WebSocket hijacking.
- **Service installer escapes paths** for plist/systemd unit files.
- **Constant-time token comparison**.

## Architecture

```
Client --HTTP--> Gateway --WS tunnel--> code-mcp (device) --localhost--> tools
```

## Tunnel Protocol

See `protocol.ts`. Envelopes:

```ts
// gateway -> device
{ id: string; request: JsonRpcRequest; token?: string }

// device -> gateway
{ id: string; response: JsonRpcResponse }   // or { id, error: string }

// device -> gateway (rebind)
{ type: 'register'; deviceId: string }

// gateway -> device
{ type: 'registered'; deviceId: string }
{ type: 'error'; error: string }
```

## Service Install

```bash
# Compile (optional)
bun run build

# Install user-level service
./dist/code-mcp-gateway install --port 8080 --token xxx --device-token yyy

# Linux: systemctl --user daemon-reload && systemctl --user enable --now code-mcp-gateway
# macOS: launchctl load ~/Library/LaunchAgents/code-mcp-gateway.plist

# Uninstall
./dist/code-mcp-gateway uninstall
```
