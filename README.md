# Code MCP

A minimal MCP (Model Context Protocol) server over HTTP with Streamable HTTP transport and JSON-RPC 2.0.

One implementation in TypeScript/Bun (`code-mcp.ts`).

## Features

- **Tools (always available):** read, write, edit, multi_edit, bash, grep, find, ls, job, mcp
- **Tools (conditional):**
  - `preview` — enabled when `cloudflared` is on PATH
  - `remember`, `forget`, `recall` — enabled with `--enable-memory`
  - `get_upload_link` — enabled with `--public` or `--domain` (requires `--token`)

## Usage
```bash
# Bun
bun code-mcp.ts [flags...]
```

See the **Flags** table below.

### Gateway Mode

Connect to a [code-mcp-gateway](https://github.com/Tuanm/code-mcp-gateway) to expose this server to the internet without `cloudflared`:
```bash
bun code-mcp.ts     --gateway wss://gateway.example.workers.dev --port 7777
```

## Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--port <n>` | Listen port | `7777` or `$PORT` |
| `--bind <addr>` | Bind address | `127.0.0.1` |
| `--token <s>` | Require `?token=<s>` or `Authorization: Bearer <s>` on every request | no auth |
| `--enable-memory` | Enable remember/forget/recall tools | disabled |
| `--disallowed-tools <list>` | Comma-separated list of tools to disable | none |
| `--public` | Expose via Cloudflare quick tunnel (requires `cloudflared`) | disabled |
| `--domain <host>` | Use existing public hostname (mutually exclusive with `--public`) | none |
| `--mcp <path>` | Aggregate tools from external MCP servers (Claude Desktop JSON config) | none |
| `--gateway <url>` | Connect to a gateway server and tunnel requests via WebSocket | none |
| `--id <uuid>` | Use specific device ID for gateway connection | random UUID |

### MCP Config Format
```json
{
  "mcpServers": {
    "namespace": {
      "command": "...",
      "args": [...],
      "env": {...}
    }
  }
}
```

Tools are exposed with `<namespace>__` prefix. HTTP transport servers use `{"type": "http", "url": "...", "headers": {...}}`.

## Build

### Bun
```bash
bun build ./code-mcp.ts --outfile=./code-mcp --target=bun --compile --minify
chmod +x code-mcp
```

## Security notes

- The server binds to `127.0.0.1` by default. To expose on a LAN, pass `--bind 0.0.0.0` and a `--token`.
- The `--token` is enforced with a constant-time compare; accepts both `?token=…` query string and `Authorization: Bearer …` header.
- Child processes (shell tools and external MCP servers) receive a minimal env (`PATH`, `HOME`, `SHELL`, `LANG`, `LC_CTYPE`, `TZ`, `TMP*` + Windows essentials). Secrets in the parent env (`AWS_*`, `OPENAI_API_KEY`, etc.) are not forwarded.
- Request body, WebSocket frames, and uploads are size-capped to protect against memory-DoS.
