# prime - the CLI

A small, fast command line client for the [Prime gateway](../README.md). It talks
to devices through the gateway's MCP relay and lets you list, inspect and call
their MCP tools from a terminal or a script.

- **Fast**: ~11 ms cold start, ~15 MB resident, one HTTP round trip per command.
- **Light**: no runtime dependencies, no MCP SDK, no YAML library.
- **Cross-platform**: one self-contained binary per OS/arch.
- **Scriptable**: typed exit codes, JSON output, stdin batching.

```text
prime connect                                   # THIS machine as an anonymous device
claude mcp add gateway -- prime serve           # every device's tools in Claude Code
prime devices connect my-laptop --token dev-secret --gateway https://gw.example.dev
prime devices connect my-laptop                 # later: defaults already stored
prime devices list
prime tools list my-laptop
prime tools view my-laptop.snapshot
prime tools call my-laptop.click '{"selector":"#submit"}'
```

## Install

```bash
cd cli
bun run build          # every platform → dist/
bun run build:host     # just this machine (fast)
```

`bun run build` writes `dist/prime` (the host build, under the bare name it is
installed as) plus one binary per platform:

| Artifact | Size | Needs Bun at runtime |
| --- | --- | --- |
| `dist/prime` (host) | 59.4 MB | no - runtime is embedded |
| `dist/prime-darwin-arm64` | 59.4 MB | no |
| `dist/prime-darwin-x64` | 66.2 MB | no |
| `dist/prime-linux-x64` / `-linux-arm64` | 77.6 / 77.5 MB | no |
| `dist/prime-windows-x64.exe` / `-windows-arm64.exe` | ~95 / ~84 MB | no |
| `dist/prime.js` | ~240 KB (includes the device buddy) | yes |

The compiled binaries are large because `bun build --compile` embeds the
whole Bun runtime; that is the price of shipping one file that runs anywhere
with no install step. If Bun (>= 1.2, for the built-in YAML parser) is already
present, the ~240 KB bundle (most of it the embedded device buddy) is the leaner choice:

```bash
install -m 755 dist/prime.js ~/.local/bin/prime
```

## Commands

```text
prime connect [--gateway <url>] [--new] [--no-start] [-- <device flags>]
prime serve [<device-id>...] [--port <n> [--host <addr>]]
prime devices connect <device-id> [options]
prime devices disconnect <device-id>
prime devices status <device-id>
prime devices list [--no-probe]
prime files list [--json] [--show-keys]
prime files upload <path> [--name <n>] [--key <k>] [--expiry-days <n>]
prime files download <id|name> [-o <path>] [--key <k>] [--resume]
prime spaces create [--name <n>] [--persistent] [--cpus <n>] [--memory <4g>]
prime spaces list|start|stop|delete|logs <name>
prime tools list <device-id>
prime tools view <device-id>.<tool-id>
prime tools call <device-id>.<tool-id> [<json>] [options]
prime tools call <device-id>.<tool-id> <json> <device-id>.<tool-id> <json> ...
... | prime tools call
prime update [--check]
prime service install [options]            # the device buddy as a user service
prime service uninstall
prime service status
prime help [connect|serve|service|devices|tools|code-mcp]
prime code-mcp [options]                   # the bundled device buddy, with the config's options
```

When no gateway is given or configured anywhere, every command uses the
managed gateway `https://prime.tuanm.workers.dev` (precedence: `--gateway` >
`PRIME_GATEWAY_URL` > device entry > `defaults.gateway` > that default).

Aliases, as specified:

- `prime` on its own is `prime --help`.
- `prime call ...` is `prime tools call ...`.
- `prime upgrade` is `prime update`.
- `prime upload ...` is `prime files upload ...`, and `prime download ...` is
  `prime files download ...`.

Every subcommand supports `--help`, and global flags are available everywhere:
`--json`, `--no-color`, `--config <path>`, `--verbose`, `--quiet`.

### connect - this machine as an anonymous device

```bash
prime connect                                # default gateway: prime.tuanm.workers.dev
prime connect --gateway https://gw.example.dev
prime connect --new                          # force a fresh device
prime connect --no-start --json              # just print/save the credentials
prime connect -- --enable-memory             # extra flags for the device buddy
```

`prime connect` asks the gateway for an anonymous device
(`POST /api/devices/anonymous`), saves `{gateway, id, token}` in the config file
(marked `anonymous: true`), prints the device id, the 6-character device code and
the connect URL, and then runs the **bundled device buddy** in the foreground as that
device (`prime code-mcp --gateway <origin> --id <id> --port <free port> --bind
127.0.0.1`). Ctrl-C stops it; the command exits with its status. The
device code is handed over in the `PRIME_CHILD_DEVICE_TOKEN` environment
variable rather than on the command line, so `ps` never shows it; the child turns
it into its `--gateway-token` in-process and removes it from its
environment, so its own subprocesses never inherit it.

```text
✓ registered anonymous device anon-05ece6d0e71cfce9
  device id    anon-05ece6d0e71cfce9
  device code  O184FH
  gateway      https://prime.tuanm.workers.dev
  connect url  https://prime.tuanm.workers.dev/device/anon-05ece6d0e71cfce9?token=O184FH
```

- **Reuse.** The saved device for that gateway is reused on every later run - the
  gateway caps the total number of devices (100), so repeated runs must not burn
  new ones. `--new` registers a fresh one.
- **Expiry.** The gateway deletes an anonymous device that never connected after
  about an hour, and one offline for 7 days. A saved device the gateway rejects
  (401) is replaced automatically, with a note. A device the operator disabled
  (403) is reported (exit 3) rather than silently replaced.
- **Errors.** 429 (too many devices created from your network) shows when to
  retry; 503 means the gateway's device limit is reached; 403 means anonymous
  devices are disabled there (exit 3); a gateway that requires a gateway token
  answers 401 (pass `--gateway-token`, exit 3).
- The device is an ordinary config entry, so `prime tools list <id>`,
  `prime call <id>.bash ...` and `prime serve` use it directly.
- The connect URL and code grant shell access to this machine: keep them secret.
  Anonymous devices get a lower request budget and cannot use file storage.

### serve - every device as one MCP server

```bash
claude mcp add gateway -- prime serve          # Claude Code (stdio)
codex mcp add gateway -- prime serve           # Codex (stdio)
prime serve laptop staging                     # only these devices
prime serve --port 7800                        # Streamable HTTP on http://127.0.0.1:7800/mcp
```

`prime serve` aggregates the tools of every configured device (the same devices
and credentials `prime tools list` / `prime call` use, or just the ids given) into
**one** MCP server.

- **stdio** (default): newline-delimited JSON-RPC 2.0 - `initialize`,
  `tools/list`, `tools/call`, `ping`; notifications get no response. stdout
  carries nothing but JSON-RPC; notes go to stderr.
- **HTTP** (`--port`): `POST /mcp` with JSON responses (batches accepted, a
  notification-only body gets 202); `GET` returns 405. It listens on
  `127.0.0.1` unless `--host` says otherwise; a non-loopback `--host` also needs
  `--allow-remote` and prints a warning, because the server has **no
  authentication**. Browser origins other than localhost get 403.
- **Names** are `<device>__<tool>`: characters outside `[a-zA-Z0-9_-]` become
  `_` (`alpha.v2` + `file.read` → `alpha_v2__file_read`). Names that collide
  after sanitizing, or exceed 64 characters, get a 6-hex hash of their own
  (device, tool) pair, so they are stable regardless of which devices are online.
  Descriptions are prefixed `[<device-id>]`; schemas and annotations are kept.
- **Calls** are routed to the device and its result returned verbatim
  (`isError` included). A device-side JSON-RPC error is passed through; a
  transport failure (offline, timeout) becomes an `isError` result.
- **Availability.** Offline devices are skipped with a stderr note. The list is
  re-read on `tools/list` (cached 15 s) and, in stdio mode, every 60 s with a
  `notifications/tools/list_changed`, so devices that come online later appear.
  With no reachable device the server still starts with an empty list.

### code-mcp - the device buddy

The CLI embeds the device buddy (documented in
[SERVER.md](SERVER.md)), which exposes a machine's files and shell. `prime connect` runs it for you;
`prime code-mcp [options]` runs it directly (`prime code-mcp --help` lists its
options), e.g. as a registered device:

```bash
prime code-mcp --gateway gw.example.dev --id my-laptop --gateway-token <token>
```

Its options can live in the config, in a `code-mcp:` section (its option
names without the dashes); options on the command line override them:

```yaml
devices:
  ...

code-mcp:
  port: "7777"
  bind: "127.0.0.1"
  id: "demo"
  token: "demo"
  gateway: "prime.tuanm.workers.dev"
  enable-memory: true
```

With that, a bare `prime code-mcp` starts the device. A device `id` needs a
gateway: when `id` is set and `gateway` is not, the CLI's gateway is used
(`defaults.gateway`, else `https://prime.tuanm.workers.dev`). Values from the config are
handed to the device buddy inside the process, so a token there never shows up in `ps`.
An unknown key or a wrongly typed value is an error naming the config file.
`prime code-mcp` refuses to start while the **service** is running - one device buddy per machine and config.

### service - the device buddy as a user service

```bash
prime service install                          # the config's service options as is
prime service install --port 7788 --enable-memory   # ...with overrides
prime service status [--json]
prime service uninstall
```

`install` registers the device buddy with the OS so it starts at login and comes back
after a crash, then waits until it has **stayed** up before reporting success
(otherwise it prints the service's own log). With a device `id`, it also
waits for the device to be **online on the gateway**, and fails if the gateway
rejects the id/token. Running it again reinstalls and restarts it with the
current options.

| OS | Definition | Logs | Restart after a crash |
| --- | --- | --- | --- |
| Linux | systemd user unit `~/.config/systemd/user/code-mcp.service` | `journalctl --user -u code-mcp` | `Restart=on-failure` |
| macOS | launchd agent `~/Library/LaunchAgents/dev.prime.code-mcp.plist` | `~/Library/Logs/prime/code-mcp.log` | `KeepAlive` (not after a clean stop) |
| Windows | Scheduled Task `\prime\code-mcp`, at logon, no admin rights, no window | `code-mcp.log` next to the config | a one-minute watchdog trigger |

The service runs `prime code-mcp --service --config <config>` and reads its
options at every start: the config's `code-mcp:` section, overridden by the
options given to `install` (stored in `service.yaml` next to the config, mode
0600). No credential is written into the service definition or onto a command
line. To apply a config change, run `prime service install` again; `uninstall`
stops it and removes the definition and `service.yaml`. `--config <path>`
selects another config for all three commands.

**Proxies and TLS-inspecting networks.** A service starts with almost no
environment, so `install` carries over the network settings of the shell it is
run from - `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`/`NO_PROXY` (either case),
`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR` - into `service.yaml`
(0600; a proxy URL can hold a password), and lists their names. The service
also trusts the operating system's certificate store (`NODE_USE_SYSTEM_CA=1`),
where an organisation installs its TLS-inspection root, so a managed device
usually needs nothing set at all. Its tunnel uses `HTTPS_PROXY`
(respecting `NO_PROXY`). If the tunnel still reports `TLS handshake failed`,
export `NODE_EXTRA_CA_CERTS=/path/to/your-org-root.pem` and re-run `install`.

On Linux, a user service stops at logout unless lingering is enabled
(`loginctl enable-linger $USER`); `install` says so when it is off.

### devices connect

Saves the device in the config file and then probes it. Anything you omit falls
back to the environment, the device's existing entry, then the defaults section -
so a full connect once makes every later device a one-liner.

```bash
prime devices connect staging --token dev-token --gateway https://gw.example.dev --gateway-token gw-token
prime devices connect laptop                       # inherits gateway + gateway token
prime devices connect laptop --no-verify           # save without probing
prime devices connect laptop --set-default         # also update the defaults section
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

### files - list, upload and download

The gateway keeps temporary files in R2, scoped to a registered device. The
commands below speak to its REST API (`/api/files`) with that device's id and
token, and stream both directions so a large file is never held in memory.

```bash
prime files upload ./report.pdf                  # expires in 7 days (the maximum)
prime files upload ./secret.pdf --key hunter2 --expiry-days 1
prime files list                                 # name, id, size, type, dates, lock
prime files download report.pdf -o ./report.pdf  # by name, when it is unique
prime files download 1a2b3c... -o ./report.pdf   # by id, always
prime files download 1a2b... -o ./part.pdf --resume   # continue a partial file
```

By default the device and gateway are the ones configured for the background
service, so after `prime service install ... --id <id> --gateway-token <token>`
the file commands work with no extra flags. Each field can be overridden:

```text
--device <id>     device whose files to use
--token <token>   that device's token
--gateway <url>   gateway origin
--timeout <ms>    per-request timeout (default 300000)
```

Upload options: `--name` (stored name), `--key` (protect the file at creation;
downloads then need `--key`), `--content-type`, `--expires-in <seconds>` or
`--expiry-days <days>`. Download options: `-o/--output` (`-` for stdout),
`--resume` for an interrupted transfer, `--force` to overwrite. `list
--show-keys` prints protection keys for the owner; without it they show as
"locked: yes". Files are per device: 200 MiB each, 5 files and 500 MiB per
device, 7 days maximum; expired files fall out of the listing automatically.

### spaces - disposable or persistent codespaces

A space is a rootless Linux container running the device buddy with **no gateway**.
When it starts, prime registers it as a local device, so the ordinary commands
work against it: `prime devices list`, `prime tools list <space-id>`,
`prime tools call <space-id>.<tool>`.

```bash
prime spaces create --name dev                    # ephemeral, 2 cpu, 4g, /root/work
prime spaces create --name work --persistent      # keeps /root/work across restarts
prime spaces list                                 # name, mode, state, device, url
prime devices list                                # the space shows up as "local"
prime tools call dev.bash '{"cwd":"/root/work","command":"uname -a"}'
prime spaces stop dev                             # ephemeral: wipes the container
prime spaces start work                           # persistent: resumes the container
prime spaces logs work
prime spaces delete work                          # container + volume + device entry
```

**Runtimes.** macOS uses the Apple container CLI: one lightweight micro-VM per
space, so root inside is not root on the host, and no Docker Desktop is needed.
Linux uses rootless podman (a user namespace maps container root to your user);
docker is a fallback and requires `--allow-rootful` unless it runs rootless. The
host reaches the space over the runtime's private network - an Apple vmnet
address, or a loopback publish - so nothing is exposed to the LAN.

**State.** `--ephemeral` (default) deletes the container on stop: the next start is
clean. `--persistent` mounts a named volume at `/root/work` and keeps the
container on stop, so start resumes it.

**Security.** Rootless runtime, no host mounts, no docker socket. `--cpus` and
`--memory` bound the container; podman also sets `--pids-limit 512` and
`no-new-privileges`. The MCP server only answers with the random per-space token,
and `--offline` (podman/docker) puts it on an internal network. The image is
`ghcr.io/tuanm/prime-space:<version>`, built multi-arch by the release workflow.

**Flags.** `--image <tag>`, `--runtime apple|podman|docker`, `--offline`, `--allow-rootful`.

## Calling tools

Five input forms, so every platform has one that needs no shell tricks. There
is no `cat` in `cmd.exe` and no single-quote syntax either, which is why
`--file` and `--arg` exist.

**1. Inline** - one reference and its arguments:

```bash
prime tools call my-laptop.click '{"selector":"#submit"}'
prime tools call my-laptop.snapshot '{}'
prime tools call my-laptop.snapshot          # no arguments => {}
```

**2. Key/value** - no JSON quoting at all, which is the form that behaves
identically in cmd.exe, PowerShell and bash:

```bash
prime tools call my-laptop.click --arg selector=#submit
prime tools call my-device.bash --arg cwd=C:/work --arg command="echo hi"
```

Values parse as JSON scalars when they look like one, so `n=5` is a number,
`b=true` a boolean, `nil=null` null and `arr=[1,2]` an array; anything
else stays a string. Repeat `--arg` once per argument.

**3. Paired** - several tools in one command, executed in order:

```bash
prime tools call laptop.snapshot '{}' phone.screenshot '{"full":true}'
```

Calls run **sequentially by default** so side-effecting tools (clicks, typing)
keep their order. `--parallel` runs them concurrently when they are
independent, with at most `--concurrency` (default 8) in flight - firing every
call at once would trip the gateway's per-IP rate limit and its per-device
pending cap, turning a large batch into a pile of failures.

**4. File** - the portable replacement for `cat x.json | prime tools call`:

```bash
prime tools call --file calls.json       # or -f
prime tools call @calls.json             # same thing, positional
prime tools call -f a.json -f b.json     # repeatable; the files' calls merge in order
prime tools call --file -                # "-" means stdin
```

**5. stdin** - explicitly, or automatically when stdin is not a terminal:

```bash
type calls.json | prime tools call         # cmd.exe
Get-Content calls.json | prime tools call  # PowerShell
cat calls.json | prime tools call          # bash
prime tools call --stdin < calls.json
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

Defaults live in `~/.prime/config.yaml` (override with `--config` or `PRIME_CONFIG`). The file holds secrets: it is created `0600` inside a
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

The gateway additionally falls back to `https://prime.tuanm.workers.dev`
when none of these sets one.

Devices created by `prime connect` are stored like any other, with their own
gateway and `anonymous: true`:

```yaml
devices:
  anon-05ece6d0e71cfce9:
    gateway: "https://prime.tuanm.workers.dev"
    token: "O184FH"
    anonymous: true
```

| Environment variable | Meaning |
| --- | --- |
| `PRIME_CONFIG` | Config file path |
| `PRIME_GATEWAY_URL` | Gateway origin |
| `PRIME_GATEWAY_TOKEN` | Gateway credential (`Authorization: Bearer`) |
| `PRIME_DEVICE_TOKEN` | Device credential (`X-Device-Token`) |
| `PRIME_TIMEOUT_MS` | Per-request timeout |

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
| `bun dist/prime.js` | 18.4 ms | 20.6 ms | 22.2 ms | 36.4 KB |

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

Against the deployed gateway (prime.tuanm.workers.dev, device on a home
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
  before other requests, but current devices do not. `--handshake auto`
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
prime update              # install the newest release (alias: prime upgrade)
prime update --check      # only report whether one exists
prime update --json       # machine-readable result
```

```text
  current   26.10.3
  latest    26.10.4
  installed 26.10.4 -> /Users/you/.local/bin/prime
```

It lists the repo's releases, keeps the `prime-v*` tags, picks the highest by
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
| Not writable (e.g. `/usr/local/bin`) | Explains and suggests `sudo prime update` or `--to <path>` |
| Windows, binary in use | Renames the running `.exe` to `<path>.old` (Windows allows a rename, not an overwrite), installs the new one in its place, and removes `.old` on the next run |
| Source checkout (`.ts`) | Refuses, so your working tree is never overwritten |
| `--to install/prime.js` | Installs the JS bundle instead of a native binary |

Other flags: `--force` reinstalls the current version, and
`--release-version <v>` installs one specific version.

One caveat: a release built before this command existed cannot update itself.
Install that one release by hand (below), and `prime update` takes over from there.

## Releasing

`.github/workflows/release-cli.yml` builds every platform on a single Linux
runner (Bun cross-compiles) and publishes a GitHub Release:

```bash
git tag prime-v26.10.3
git push origin prime-v26.10.3
```

The tag supplies the version baked into the binaries, so `prime --version` in a
release reports the release it came from.

### Versioning

Versions are dates: **26.10.3** is 2026-10-03. For a 60 MB binary with no
auto-update, `prime --version` telling you *how stale* the download is matters more
than a compatibility signal.

The one subtlety is that the version also lands in `package.json` and a Release
tag, and both are parsed as SemVer - which **forbids leading zeros**. So the day
is not padded: `26.10.3`, never `26.10.03`. (`npm pack` accepts the padded form,
so this fails late and confusingly.) A second release on the same day uses build
metadata: `prime-v26.10.3+1`.

`cli/src/version.ts` is the single source of truth, enforced by both the build
(`bun run build --version <v>` rejects a bad value with a hint) and the release
workflow. Use plain SemVer instead if the CLI ever gains consumers who pin it. A manual `workflow_dispatch` run builds
the same artifacts and uploads them as workflow artifacts without publishing a
release. Each release carries the five platform binaries, the JS bundle, and a
`SHA256SUMS` file.

## Development

```bash
bun run test          # unit + feature tests (offline; fake gateway in-process)
bun test:e2e          # end-to-end: boots a local wrangler gateway + mock devices
bun run typecheck     # tsc with tsconfig.typecheck.json
bun test:service      # prime service against this OS's real service manager
```

### The bundled device buddy

The device buddy lives in this package as one module (`src/code-mcp.ts`), which the binary embeds -
so a binary embeds exactly the device buddy of the commit it was built
from.

- It is a script with top-level side effects, so it is never imported
  statically: only `prime code-mcp` loads it, via `await import("#code-mcp")` (a
  `package.json` subpath import, a static string so `bun build` embeds it). It is
  excluded from `tsc` (mapped to `src/code-mcp.stub.d.ts`) because it is written
  to its own conventions, not this package's strict settings. It uses top-level
  `await`, which is why binaries are compiled with `--bytecode --format=esm`.
- The build smoke-tests the server's `--help` on the bundle and the host binary from
  a directory outside the repository, so a build that lost it fails.

The end-to-end suite compiles the host binary and drives it against a real local
gateway, covering both credentials, the tunnel relay, every input form, exit
codes, handshake modes, dotted device ids, sequential ordering, `--parallel`
overlap, timeouts, and the offline path - and the anonymous flow: `prime connect`
registering and reusing a device, running the embedded device buddy (from a
directory without `src/`), real device tools through the connect URL, and
`prime serve` over stdio and HTTP.
