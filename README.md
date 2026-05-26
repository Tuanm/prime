# Prime

A Bun-based gateway for exposing local code-mcp servers to the internet via WebSocket tunneling.

## Quick Start
```bash
cd gateway
bun install
bun run start --port 8080
```

## Features

- **WebSocket tunneling** - Devices connect via WebSocket, relay HTTP requests
- **Rate limiting** - Configurable per-IP rate limits
- **Token auth** - Optional bearer token for gateway access
- **In-memory registry** - Tracks connected devices

## Documentation

See [gateway/README.md](gateway/README.md) for detailed usage.
