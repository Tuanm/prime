# mcp - code-mcp-gateway CLI

A small, fast command line client for [code-mcp-gateway](../README.md). It talks
to devices through the gateway's MCP relay and lets you list, inspect and call
their MCP tools from a terminal or a script.

- **Fast**: ~15 ms cold start, ~15 MB resident, one HTTP round trip per command.
- **Light**: no runtime dependencies, no MCP SDK, no YAML library.
- **Cross-platform**: one self-contained binary per OS/arch.
- **Scriptable**: typed exit codes, JSON output, stdin batching.

```text
mcp devices connect my-laptop --token dev-secret --gateway https://gw.example.dev
mcp devices connect my-laptop                 # later: defaults already stored
mcp devices list
mcp tools list my-laptop
mcp tools view my-laptop.snapshot
mcp tools call my-laptop.click '{"selector":"#submit"}'
```

## Install

```bash
cd cli
bun run build          # every platform → dist/
bun run build:host     # just this machine (fast)
```

`bun run build` writes `dist/mcp` (the host build, under the bare name it is
installed as) plus one binary per platform:

| Artifact | Size | Needs Bun at runtime |
| --- | --- | --- |
| `dist/mcp` (host) | 59.4 MB | no - runtime is embedded |
| `dist/mcp-darwin-arm64` | 59.4 MB | no |
| `dist/mcp-darwin-x64` | 66.2 MB | no |
| `dist/mcp-linux-x64` / `-linux-arm64` | 77.6 / 77.5 MB | no |
| `dist/mcp-windows-x64.exe` | 82.1 MB | no |
| `dist/mcp.js` | 32.5 KB | yes |

The compiled binaries are large because `bun build --compile` embeds the
whole Bun runtime; that is the price of shipping one file that runs anywhere
with no install step. If Bun (>= 1.2, for the built-in YAML parser) is already
present, the 32 KB bundle is the leaner choice:

```bash
install -m 755 dist/mcp.js ~/.local/bin/mcp
```

## Commands

```text
mcp devices connect <device-id> [options]
mcp devices disconnect <device-id>
mcp devices status <device-id>
mcp devices list [--no-probe]
mcp tools list <device-id>
mcp tools view <device-id>.<tool-id>
mcp tools call <device-id>.<tool-id> [<json>] [options]
mcp tools call <device-id>.<tool-id> <json> <device-id>.<tool-id> <json> ...
... | mcp tools call
mcp help [devices|tools]
```

Aliases, as specified:

- `mcp` on its own is `mcp --help`.
- `mcp call ...` is `mcp tools call ...`.

Every subcommand supports `--help`, and global flags are available everywhere:
`--json`, `--no-color`, `--config <path>`, `--verbose`, `--quiet`.

### devices connect

Saves the device in the config file and then probes it. Anything you omit falls
back to the environment, the device's existing entry, then the defaults section -
so a full connect once makes every later device a one-liner.

```bash
mcp devices connect staging --token dev-token --gateway https://gw.example.dev --gateway-token gw-token
mcp devices connect laptop                       # inherits gateway + gateway token
mcp devices connect laptop --no-verify           # save without probing
mcp devices connect laptop --set-default         # also update the defaults section
```

Re-running `connect` **merges**: omitting `--token` keeps the token already
stored rather than clearing it.

### devices list / status

`status` sends an MCP `ping` and reports reachability plus round-trip time.
`list` probes every configured device concurrently and prints a table;
`--no-probe` skips the probes for an instant offline listing.

```text
DEVICE    STATUS   LATENCY   GATEWAY
alpha     online   12 ms     https://gw.example.dev
staging   offline  -         https://staging.example.dev
```

## Calling tools

Arguments are JSON. There are three input forms.

**1. Inline** - one reference and its arguments:

```bash
mcp tools call my-laptop.click '{"selector":"#submit"}'
mcp tools call my-laptop.snapshot '{}'
mcp tools call my-laptop.snapshot          # no arguments => {}
```

**2. Paired** - several tools in one command, executed in order:

```bash
mcp tools call laptop.snapshot '{}' phone.screenshot '{"full":true}'
```

Calls run **sequentially by default** so side-effecting tools (clicks, typing)
keep their order. `--parallel` runs them concurrently when they are
independent.

**3. stdin** - a single call object, or an array of them:

```bash
echo '{"name":"my-laptop.snapshot","arguments":{}}' | mcp tools call

cat call.json | mcp tools call
```

```json
{ "name": "my-laptop.click", "arguments": { "selector": "#submit" } }
```

```json
[
  { "id": 1, "name": "my-laptop.snapshot", "arguments": {} },
  { "id": 2, "name": "my-laptop.click", "arguments": { "selector": "#submit" } }
]
```

Output follows the input: a single call prints the tool's text content on stdout;
a batch labels each result with its `id` in the specified order. `--json`
prints the raw MCP result for a single call and an array of
`{ id, name, ok, result | error }` for a batch.

A tool that reports failure (`isError`) is printed and exits 1. In a batch, one
failing call does not abort the others - every outcome is reported and the exit
code is 1.

### Device and tool references

`<device-id>.<tool-id>` is split on the **longest configured device id**, so a
device named `alpha.v2` and a tool named `file.read` both resolve correctly:

```text
alpha.v2.echo     -> device "alpha.v2", tool "echo"
alpha.file.read   -> device "alpha",   tool "file.read"
```

When a label is genuinely ambiguous, `--device` and `--tool` override either
half.

## Configuration

Defaults live in `~/.code-mcp-gateway/config.yaml` (override with `--config` or
`CODE_MCP_GATEWAY_CONFIG`). The file holds secrets: it is created `0600` inside a
`0700` directory, and every write is atomic.

```yaml
defaults:
  gateway: "https://gw.example.dev"
  gateway_token: "gw-..."
  token: "dev-..."
  timeout_ms: 300000
devices:
  my-laptop:
    token: "dev-laptop-secret"
    connected_at: "2026-02-14T09:00:00.000Z"
```

Per field, precedence is:

```text
--flag  >  environment variable  >  device entry  >  defaults section
```

| Environment variable | Meaning |
| --- | --- |
| `CODE_MCP_GATEWAY_CONFIG` | Config file path |
| `CODE_MCP_GATEWAY_URL` | Gateway origin |
| `CODE_MCP_GATEWAY_TOKEN` | Gateway credential (`Authorization: Bearer`) |
| `CODE_MCP_GATEWAY_DEVICE_TOKEN` | Device credential (`X-Device-Token`) |
| `CODE_MCP_GATEWAY_TIMEOUT_MS` | Per-request timeout |

Two credentials are involved: the **gateway token** authenticates you to the
Worker, and the **device token** is forwarded through the tunnel to the device.
A deployment may use either, both, or neither.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | A tool call failed (including `isError` results) |
| 2 | Usage error: bad flags, bad JSON, unknown command |
| 3 | Authentication rejected (401) |
| 4 | Device offline (503) |
| 5 | Timeout |

Note on 3 versus 4: a gateway configured with **per-device tokens** answers 401
for a device id it does not know, deliberately, so nobody can enumerate valid
ids. That means an *unregistered* id exits 3, and only a *registered but
currently disconnected* device exits 4.

With `--json`, failures are printed as `{ "error": { "message", "hint", "exit_code" } }`
on stdout, so a script can read both the reason and the code.

## Performance

Measured on an M1 Mac, 20 runs each, with every run's exit code checked
(`/usr/bin/true` costs 2.7 ms on the same harness, so the CLI's own startup is
~13 ms):

| Metric | Compiled binary | `bun dist/mcp.js` |
| --- | --- | --- |
| Cold start, min / median | 15.9 / 17.0 ms | 16.2 / 17.7 ms |
| Peak resident memory | 14.2 MB | 14.7 MB |
| Artifact size | 59-82 MB | 32.5 KB |

Startup is the same either way - both boot a Bun runtime and then evaluate the
same code. The bundle's advantage is purely **distribution size**: 32 KB versus
59-82 MB, at the cost of requiring Bun on the target machine.

Against the deployed gateway one `tools call` costs ~420-450 ms end to end
(Cloudflare edge + device round trip), which is network, not CLI startup. HTTP
round trips per command: **1**.

Design choices behind those numbers:

- **No dependencies.** JSON-RPC over `fetch` is ~150 lines; the config file is
  parsed with Bun's built-in `Bun.YAML.parse`, and the CLI writes YAML with a
  small emitter. Nothing to resolve, nothing to load.
- **One round trip per command.** MCP servers *should* require `initialize`
  before other requests, but current code-mcp devices do not. `--handshake auto`
  (the default) therefore calls directly and only handshakes if the server
  actually complains - see `--handshake always|never` to force it.
- **Connection reuse within a batch.** A batch spanning several devices creates
  one client per device, not per call.
- **Concurrent probes for `devices list`**, with a short probe timeout so a stuck
  device cannot stall a listing.

## Development

```bash
bun test          # unit tests (offline)
bun test:e2e      # end-to-end: boots a local wrangler gateway + mock devices
bun run typecheck
```

The end-to-end suite compiles the host binary and drives it against a real local
gateway, covering both credentials, the tunnel relay, every input form, exit
codes, handshake modes, dotted device ids, sequential ordering, `--parallel`
overlap, timeouts, and the offline path.
