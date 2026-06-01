# Prime

A Bun-based gateway server for exposing local code-mcp servers via WebSocket tunneling.
Designed to be deployed on a public VM.

## Usage

```bash
bun run server.ts [options] [install|uninstall]
```

### Options

| Flag                     | Description                                           | Default           |
| ------------------------ | ----------------------------------------------------- | ----------------- |
| `--port <n>`             | Listen port                                           | `8080`            |
| `--token <s>`            | Gateway bearer token (client -> gateway)              | none (public)     |
| `--device-token <s>`     | Device bearer token (device -> gateway at WS connect) | none (public)     |
| `--rate-window <ms>`     | Rate limit window                                     | `60000`           |
| `--rate-max <n>`         | Max requests per IP per window                        | `100`             |
| `--timeout <ms>`         | Request timeout                                       | `30000`           |
| `--max-pending <n>`      | Max pending requests per device                       | `100`             |
| `--max-body <bytes>`     | Max HTTP request body bytes                           | `1048576` (1 MiB) |
| `--trust-proxy`          | Trust `X-Forwarded-For` / `X-Real-IP` for client IP   | off               |
| `--allowed-origin <csv>` | Comma-separated WS `Origin` whitelist                 | any               |
| `--ping-interval <ms>`   | WS ping interval                                      | `30000`           |
| `--ping-max-misses <n>`  | Drop WS after N missed pongs                          | `2`               |
| `--idle-timeout <sec>`   | Bun WS idle timeout                                   | `120`             |

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

| Method  | Header                          | Query string    |
| ------- | ------------------------------- | --------------- |
| Gateway | `Authorization: Bearer <token>` | `?auth=<token>` |
| Device  | `Authorization: Bearer <token>` | `?auth=<token>` |

Tokens are compared in constant time.

## API Endpoints

| Method | Path                | Auth       | Description                                                                                                |
| ------ | ------------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| `GET`  | `/devices`          | local-only | List registered devices. Requires loopback peer IP AND absence of any proxy header. Returns 404 otherwise. |
| `POST` | `/mcp/{deviceId}`   | gateway    | Relay JSON-RPC body to device                                                                              |
| `WS`   | `/ws/{deviceId}`    | device     | Device WebSocket (preferred)                                                                               |
| `WS`   | `/ws?deviceId=<id>` | device     | Legacy WebSocket (server assigns UUID if omitted)                                                          |

`POST /mcp/{deviceId}` also accepts a **device-relay token** which is forwarded to the device side via the tunnel envelope:

| Method | Header                    | Query string     |
| ------ | ------------------------- | ---------------- |
| Relay  | `X-Device-Token: <token>` | `?token=<token>` |

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
- **WebSocket liveness**: combined WS-level ping/pong + app-layer keepalive (see [Liveness](#liveness)). Dead TCP and half-open connections are detected within `ping-interval * (ping-max-misses + 1)` seconds.
- **`/devices` local-only**: peer IP must be loopback AND no proxy header (`X-Forwarded-*`, `Forwarded`, `CF-Connecting-IP`, `CF-Ray`) may be present. This blocks the common "same-host reverse proxy" bypass where cloudflared / nginx / Caddy run on the same machine and reach the gateway via 127.0.0.1.
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

// device -> gateway (heartbeat, every ~25s)
{ type: 'keepalive' }

// gateway -> device (heartbeat reply)
{ type: 'keepalive-ack' }
```

## Liveness

Two complementary mechanisms detect dead and half-open WebSocket connections:

1. **WS-level ping/pong** (server-driven). The server sends a control ping every
   `--ping-interval` ms. If `--ping-max-misses` pongs are missed in a row, the WS
   is closed with code 1011.

2. **App-layer keepalive** (client-driven). Each client sends
   `{ "type": "keepalive" }` as a normal text frame every ~25 seconds. The server
   replies `{ "type": "keepalive-ack" }`. Any inbound data frame also resets the
   server's missed-pong counter.

The app-layer path exists because HTTP/2 reverse-proxies (Cloudflare Zero Trust
tunnel, some load balancers) may convert WebSocket to HTTP/2 streams where
control ping/pong frames are not always treated as stream activity. Data frames
always propagate as stream messages, so a JSON keepalive is the most portable
liveness signal across proxy chains.

Clients also run a 75-second inbound watchdog: if no frame of any kind arrives
within that window, the socket is force-closed and the client reconnects.

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
