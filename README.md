# Prime

**A toolkit that turns a machine, a file and a browser into tools - with limits you set.**

[![CI](https://github.com/Tuanm/prime/actions/workflows/ci.yml/badge.svg)](https://github.com/Tuanm/prime/actions/workflows/ci.yml)

| What you get | In one line |
| --- | --- |
| **[File sharing](#file-sharing)** | Devices park temporary files and hand out a link - optionally protected by a key, always expiring. |
| **[MCP device management](#prime-device-management)** | Any machine becomes an MCP device: connect it once, then reach its tools from any MCP client, anywhere. |
| **[Browser sandbox](#browser-sandbox)** | A locked-down browser tab where tools you write run with a real UI - and no access to your pages, cookies or data. |
| **[Access control](#access-control)** | Per-device tokens, an admin page, anonymous devices, and a switch to cut a device or an address off. |
| **[One server for every device](#one-server-for-every-device)** | `prime serve` presents every device's tools as a single MCP server to a client that only knows one. |
| **[Local use](#local-use-no-account)** | The same server runs on its own, without the hosted service, for one machine. |

---

## File sharing

Devices can leave a file behind and share a link to it:

```bash
curl -u my-laptop:t --data-binary @report.pdf \
  "https://<service>/api/files?name=report.pdf&expiry_days=7"
```

The answer carries the file's id and its `/files/<id>` link; the `/files` page does the
same thing with a form, and the CLI wraps the same API:

```bash
prime files upload report.pdf            # alias: prime upload report.pdf
prime files list                         # files, sizes, dates, protection
prime files download report.pdf -o copy.pdf
```

- **Protected links.** A file can carry a key, passed as the `X-File-Key` request header -
  never in the URL - so it cannot leak through access logs or a `Referer`.
- **Limits, by design.** 200 MiB per file, 7 days, 5 files and 500 MiB per device. Expired
  files are deleted automatically and never listed.
- **A page to manage them.** `/files` lists what the device holds, with upload, download,
  rename, protection and delete.
- **Even an MCP client can download** through a short-lived, single-use ticket, for clients
  that cannot send Basic auth (`GET /device/<deviceId>/download/<ticket>`).

## MCP device management

Run `prime connect` on a machine and it becomes a **device**: a named endpoint whose tools
(file read/write, shell, search, jobs, preview, memory) any MCP client can call through
`POST /device/<deviceId>`. No ports, no tunnels, no firewall rules - the device connects out
and stays connected.

```bash
prime connect                                     # this machine, as an anonymous device
prime service install --id my-laptop --token t    # ...or a registered one, at every login
prime devices list                                # what is connected
prime tools list my-laptop                        # the tools it exposes
prime tools call my-laptop.bash '{"command":"git status"}'
```

- **Registered or anonymous.** An anonymous device is created on the spot with a code you
  can keep; a registered one lives in the admin page with its own token and a stable id.
- **One tunnel per device.** Connecting a second time replaces the old connection, so a
  dead laptop never blocks the next connect.
- **Long calls.** A tool may run for minutes: the connection survives, and a call that
  outlives its client is cleaned up instead of leaking.
- **Works everywhere.** The service runs on Cloudflare Workers, so there is no server to
  patch or scale, and a device keeps its id when it reconnects from elsewhere.

## Browser sandbox

`/sandbox` turns a browser tab into a device whose tools are JavaScript you write in the page.
Your pages, cookies and local storage are not reachable from those tools - a call runs in its
own sandboxed frame, with no network and no credentials:

```js
/**
 * Add two numbers.            <- the tool's description
 * @param {number} a First     <- arguments and their JSON schema
 * @param {number} [b=1] Second
 */
export default async function add(a, b = 1) { return a + b; }
```

- **Tools in the page.** Add, save, edit, download, deactivate or delete .js tools; saving
  validates syntax, a single default async function, `@param` tags and supported types.
  Starter tools for building a dashboard are offered on the first visit.
- **An interface, not just a log.** Tools build UI with `ui.add(...)` - headings, text,
  code, images, badges, stats, progress, buttons, inputs, tables, lists, grids, cards,
  tabs, modals - and drive a named cursor per MCP client (`click`, `type`, `fill`,
  `select`, `drag`, `hover`, `scroll`). `ui.wait(id)` waits for the person to act.
- **Interactive without an agent.** `on: { click: { tool, args } }` handlers run in the
  browser, and `ui.events()` tells the agent what happened afterwards.
- **State that survives.** `kv.*` (JSON) and `db.*` (SQLite via sql.js) live in IndexedDB
  per device, and the whole dash is rebuilt on reload, across calls and restarts.
- **Isolated by construction.** Each call runs in a sandboxed, credential-less iframe with
  no network and a 120 s cap; clients are told apart by session, not by IP.

## Codespaces

`prime spaces` turns a Linux container into a local device: the device buddy runs
inside it with no gateway, and the container is registered like any other device, so
`prime devices list` and `prime tools call <space-id>.<tool>` work unchanged.

```bash
prime spaces create --name dev                  # ephemeral: stop wipes it
prime spaces create --name work --persistent    # keeps /root/work across stop/start
prime spaces list
prime spaces doctor                              # rootless? systemd? limits?
prime devices list                              # the space is a local device
prime tools call dev.bash '{"cwd":"/root/work","command":"uname -a"}'
prime spaces stop dev
prime spaces delete work
```

Spaces are rootless on the host: Apple's container micro-VM on macOS (root inside
is not root on the host) and rootless podman on Linux. Each has a random token
(passed in a 0600 env file, never on a process list), no host mounts, no docker
socket, and cpus/memory limits. The runtime's private address is the only way in:
nothing is published to the LAN. Apple's vmnet still has NAT, so an Apple space
can reach the internet and host services bound to 0.0.0.0; podman/docker
`--offline` is the no-network mode. The image is public:
`ghcr.io/tuanm/prime-space:<version>`.

## Access control

- **Per-device tokens** on both the device connection and every relayed request; unknown
  ids answer 401, so ids cannot be enumerated.
- **An admin page** (`/admin`) lists devices and anonymous devices, shows where each one
  connects from (address, location, network, user agent) and can hand out tokens.
- **Cut-offs that are immediate.** Disable a device and its tunnel is dropped; rotate its
  token and the old one stops working; block an address and it reaches nothing, not even
  the pages. The admin page itself is authenticated before it is served.
- **Access to the admin page** is delegated to the identity provider in front of the
  deployment, and the service verifies that assertion itself - so a misconfigured or
  removed identity layer closes the page instead of exposing it.

## What the service stores

**The service keeps no logs of clients or devices.** There is no request log, no connection
log, no per-device history, and Workers Logs are off. A request is answered and forgotten.

What it does keep, because the features need it:

- **The device registry**: id, token, and whether the device is online, disabled or blocked.
- **Anonymous devices**: the opaque reference the admin page shows, their token, and when
  they were created or last seen.
- **Temporary files** and their metadata, and a monthly R2 spend counter - all deleted with
  the file.
- **Sandbox session names** for the browser page, so a connected tool can be told apart.
- **Blocked addresses**, only when an operator blocks one on purpose.

Where a device connects **from** (address, country, network, user agent) is held only while
its tunnel is open, so the admin page can show it; it is not written to storage and gone
when the device disconnects. For debugging, an operator can set `TRACE_DEVICES` to have
those origin lines printed to the platform console - off by default.

## One server for every device

`prime serve` presents every device's tools as one MCP server, so a client that knows a
single server sees all machines:

```bash
claude mcp add devices -- prime serve
```

## Local use (no account)

The same server runs on its own for one machine - no service, no account:

```bash
bun cli/src/code-mcp.ts --port 7777 --token secret        # HTTP MCP at http://127.0.0.1:7777/mcp
bun cli/src/code-mcp.ts --gateway --id my-laptop --token t # ...or as a device on the service
```

## CLI

`prime` is a fast, dependency-free command line client: connect this machine, run the
server as a user service, list and inspect devices and tools, and call tools from inline
JSON, paired arguments or stdin.

```text
prime connect                                    # this machine, as an anonymous device
prime service install --id my-laptop --token t   # ...or a registered one, at every login
prime devices connect my-laptop --token t   # save credentials for a registered device
prime tools list my-laptop
prime tools call my-laptop.read '{"path":"README.md"}'
prime spaces create --name dev          # a local Linux codespace as a device
prime spaces list
prime files upload report.pdf            # store a file behind the gateway
prime files list                         # what this device has stored
prime files download report.pdf -o copy.pdf
```

Credentials and defaults live in `~/.prime/config.yaml`; flags override
environment variables, which override the device entry, which overrides the defaults
section. `prime --help` lists everything, and `prime call` is an alias for `prime tools call`.

## Documentation

- [cli/SERVER.md](cli/SERVER.md) - the device buddy: tools, flags, behaviour
- [cli/README.md](cli/README.md) - the `prime` CLI: install, commands, configuration, exit codes
- [api/README.md](api/README.md) - internals, deployment, tunables, tests
- [MCP specification](https://modelcontextprotocol.io) - the protocol all of this speaks

## Development

```bash
cd api && npm test                         # unit, smoke, files, anonymous devices (local wrangler)
cd api && npm run typecheck
cd cli && bun run test && bun test/e2e.ts      # CLI unit + end-to-end, against a local instance
cd cli && bun test/service-e2e.ts              # prime service on this OS's real service manager
cd cli && python3 -m unittest discover -s tests
```

CI runs each component's suites when it, or something it depends on, changes: the api
on Linux; the CLI on Linux and Windows (x64, Arm) plus `prime service` on Linux, macOS and
Windows; the device buddy on Linux, macOS and Windows.
