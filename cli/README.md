# mcp - code-mcp-gateway CLI

A small, fast command line client for [code-mcp-gateway](../README.md). It talks
to devices through the gateway's MCP relay and lets you list, inspect and call
their MCP tools from a terminal or a script.

- **Fast**: ~11 ms cold start, ~15 MB resident, one HTTP round trip per command.
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
mcp update [--check]
mcp help [devices|tools]
```

Aliases, as specified:

- `mcp` on its own is `mcp --help`.
- `mcp call ...` is `mcp tools call ...`.
- `mcp upgrade` is `mcp update`.

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

Five input forms, so every platform has one that needs no shell tricks. There
is no `cat` in `cmd.exe` and no single-quote syntax either, which is why
`--file` and `--arg` exist.

**1. Inline** - one reference and its arguments:

```bash
mcp tools call my-laptop.click '{"selector":"#submit"}'
mcp tools call my-laptop.snapshot '{}'
mcp tools call my-laptop.snapshot          # no arguments => {}
```

**2. Key/value** - no JSON quoting at all, which is the form that behaves
identically in cmd.exe, PowerShell and bash:

```bash
mcp tools call my-laptop.click --arg selector=#submit
mcp tools call my-device.bash --arg cwd=C:/work --arg command="echo hi"
```

Values parse as JSON scalars when they look like one, so `n=5` is a number,
`b=true` a boolean, `nil=null` null and `arr=[1,2]` an array; anything
else stays a string. Repeat `--arg` once per argument.

**3. Paired** - several tools in one command, executed in order:

```bash
mcp tools call laptop.snapshot '{}' phone.screenshot '{"full":true}'
```

Calls run **sequentially by default** so side-effecting tools (clicks, typing)
keep their order. `--parallel` runs them concurrently when they are
independent, with at most `--concurrency` (default 8) in flight - firing every
call at once would trip the gateway's per-IP rate limit and its per-device
pending cap, turning a large batch into a pile of failures.

**4. File** - the portable replacement for `cat x.json | mcp tools call`:

```bash
mcp tools call --file calls.json       # or -f
mcp tools call @calls.json             # same thing, positional
mcp tools call -f a.json -f b.json     # repeatable; the files' calls merge in order
mcp tools call --file -                # "-" means stdin
```

**5. stdin** - explicitly, or automatically when stdin is not a terminal:

```bash
type calls.json | mcp tools call         # cmd.exe
Get-Content calls.json | mcp tools call  # PowerShell
cat calls.json | mcp tools call          # bash
mcp tools call --stdin < calls.json
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

A specification file (or stdin) holds one call object, or an array of them.
Calls without an `id` are numbered automatically, continuing across multiple
files. A UTF-8 BOM and CRLF line endings are both tolerated, because Windows
editors emit them.

### Results and failures

Output follows the input: a single call prints the tool's text content on stdout;
a batch labels each result with its `id` in the specified order. `--json`
prints the raw MCP result for a single call and an array of
`{ id, name, ok, result | error }` for a batch.

**Failures are per call and never cascade.** If three calls are requested and the
middle one fails, the other two still run, still return their results, and are
still printed:

```text
--- [1] my-laptop.snapshot
...the snapshot...

--- [2] my-laptop.click (isError)
Element not found: #submit

--- [3] my-laptop.evaluate
42
```

The command then exits **1**, because the overall result was a failure. This holds
in sequential and `--parallel` mode alike - a failing or timing-out call never
cancels its siblings, and each call keeps its own timeout. A failing call that is
the *only* call keeps its specific exit code instead (3 auth, 4 offline,
5 timeout), so single-call scripts can still branch on the failure class.

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

### Cold start

Measured on an M1 Mac with the three candidates **interleaved**, 60 runs each,
every run's exit code checked (a plain `/usr/bin/true` costs ~3 ms on the same
harness, so the CLI's own startup is a few ms less than the figures below):

| Build | min | median | p90 | Size |
| --- | --- | --- | --- | --- |
| compiled + `--bytecode` | **11.2 ms** | 13.2 ms | 16.1 ms | 60.9 MB |
| compiled, no bytecode | 16.7 ms | 19.9 ms | 22.2 ms | 59.4 MB |
| `bun dist/mcp.js` | 18.4 ms | 20.6 ms | 22.2 ms | 36.4 KB |

**`--bytecode` is worth 33% of cold start** for ~1.5 MB of binary, which is why
the build uses it. It requires the entry module to avoid top-level `await` -
`src/index.ts` uses a floating async IIFE for exactly that reason.

The compiled binary is now faster than the bundle; the bundle's advantage is
purely distribution size (36 KB vs 60-82 MB) when Bun is already installed.
Peak resident memory is ~15 MB either way.

### Multi-call throughput

Eight calls to a tool that takes 200 ms each, through a local gateway:

| Calls | Sequential | `--parallel` | Speedup | Sequential per call |
| --- | --- | --- | --- | --- |
| 1 | 234 ms | 233 ms | 1.00x | 218 ms |
| 2 | 452 ms | 248 ms | 1.82x | 218 ms |
| 4 | 890 ms | 261 ms | 3.40x | 218 ms |
| 8 | 1747 ms | 280 ms | 6.23x | 216 ms |

Sequential per-call overhead beyond the tool's own 200 ms is ~18 ms, which
includes process start, TLS reuse and the gateway round trip. `--parallel`
costs the same for 8 calls as for 1 because they are dispatched concurrently.

Failure isolation was measured in both modes with the pattern
`[ok, FAIL, ok]`: exit code 1, both successful results present, failure
reported - and the same for a mid-batch timeout.

Against the deployed gateway (code-mcp.tuanm.workers.dev, device on a home
connection) a single `tools call` costs ~0.4-1.2 s end to end depending on
network conditions - Cloudflare edge plus the device round trip, not CLI
startup. HTTP round trips per command: **1**.

`--parallel` scales on the real gateway too, with a device that sleeps 2 s per
call:

| Calls | Sequential | `--parallel` | Speedup |
| --- | --- | --- | --- |
| 1 | 2599 ms | 2528 ms | 1.03x |
| 2 | 4955 ms | 2650 ms | 1.87x |
| 4 | 10416 ms | 2554 ms | **4.08x** |

Four parallel calls finish in the same wall time as one.

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
- **Bytecode-compiled binaries** (`--bytecode`), which remove most of the module
  graph's parse/compile cost at startup.
- **Per-call isolation in batches**, so a call that rejects for any reason -
  including a bug in the error path itself - cannot discard its siblings'
  results.
- **Bounded concurrency** (`--concurrency`, default 8) instead of firing every
  call at once, which would trip the gateway's per-IP rate limit and its
  per-device pending cap.
- **Retries only where they are provably safe** - see below.

## Reliability

A retry is only safe when the request provably never reached the tool, so the
CLI retries a deliberately narrow set of failures, up to 3 attempts with
exponential backoff and jitter:

| Failure | Retried | Why |
| --- | --- | --- |
| 429 rate limited | yes | rejected at the gateway, never forwarded |
| 502 device send failed | yes | the tunnel send itself failed |
| 503 device busy | yes | the pending queue was full, never forwarded |
| 503 device offline | no | nothing to wait for |
| 504 / timeout | **no** | the tool may still be running |
| dropped connection | **no** | the request may have been delivered |

The last two matter: retrying them could run a side-effecting tool twice, so the
CLI would rather report a failure you can retry yourself. A retry never extends
`--timeout` - the timeout is the budget for the whole call, retries included.

## Updating

The CLI ships as a self-contained binary with no package manager behind it, so
it updates itself:

```bash
mcp update              # install the newest release (alias: mcp upgrade)
mcp update --check      # only report whether one exists
mcp update --json       # machine-readable result
```

```text
  current   26.10.3
  latest    26.10.4
  installed 26.10.4 -> /Users/you/.local/bin/mcp
```

It lists the repo's releases, keeps the `cli-v*` tags, picks the highest by
SemVer, downloads the asset for this platform, checks it against the release's
`SHA256SUMS`, and replaces the file atomically - so an interrupted update cannot
leave a half-written executable. A release without `SHA256SUMS` is refused
rather than installed unverified; note that this proves the download is intact
and is what the release published, **not** that the release itself is
trustworthy.

| Situation | Behaviour |
| --- | --- |
| Already newest | Reports "already up to date", changes nothing |
| `--check` | Never writes, and works from a source checkout |
| Not writable (e.g. `/usr/local/bin`) | Explains and suggests `sudo mcp update` or `--to <path>` |
| Windows, binary in use | Stages `<path>.new` and prints the move command |
| Source checkout (`.ts`) | Refuses, so your working tree is never overwritten |
| `--to install/mcp.js` | Installs the JS bundle instead of a native binary |

Other flags: `--force` reinstalls the current version, and
`--release-version <v>` installs one specific version.

One caveat: a release built before this command existed cannot update itself.
Install that one release by hand (below), and `mcp update` takes over from there.

## Releasing

`.github/workflows/release-cli.yml` builds every platform on a single Linux
runner (Bun cross-compiles) and publishes a GitHub Release:

```bash
git tag cli-v26.10.3
git push origin cli-v26.10.3
```

The tag supplies the version baked into the binaries, so `mcp --version` in a
release reports the release it came from.

### Versioning

Versions are dates: **26.10.3** is 2026-10-03. For a 60 MB binary with no
auto-update, `mcp --version` telling you *how stale* the download is matters more
than a compatibility signal.

The one subtlety is that the version also lands in `package.json` and a Release
tag, and both are parsed as SemVer - which **forbids leading zeros**. So the day
is not padded: `26.10.3`, never `26.10.03`. (`npm pack` accepts the padded form,
so this fails late and confusingly.) A second release on the same day uses build
metadata: `cli-v26.10.3+1`.

`cli/src/version.ts` is the single source of truth, enforced by both the build
(`bun run build --version <v>` rejects a bad value with a hint) and the release
workflow. Use plain SemVer instead if the CLI ever gains consumers who pin it. A manual `workflow_dispatch` run builds
the same artifacts and uploads them as workflow artifacts without publishing a
release. Each release carries the five platform binaries, the JS bundle, and a
`SHA256SUMS` file.

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
