// Help text. Kept in one place so every command's --help stays consistent.
//
// Prose uses plain quotes rather than backticks: these blocks are template
// literals, so an unescaped backtick would terminate the string.

import { bold, cyan, dim } from "./output.ts";

const ROOT = `mcp - command line client for prime-gateway

Connects to devices exposed through the Prime gateway and drives their
MCP tools. Credentials and defaults live in ~/.prime-gateway/config.yaml.

USAGE
  mcp [command] [options]

COMMANDS
  connect [--gateway <url>] [--new]       Connect THIS machine as an anonymous device
                                          (registers or reuses one, runs code-mcp)
  serve [--port <n>]                      Serve every device's tools as one MCP server
                                          (stdio by default; HTTP with --port)
  devices connect <device-id> [options]   Save credentials for a device and verify it
  devices disconnect <device-id>          Forget a device's local configuration
  devices status <device-id>              Probe one device
  devices list                            List configured devices
  tools list <device-id>                  List a device's MCP tools
  tools view <device-id>.<tool-id>        Show one tool's schema
  tools call <device-id>.<tool-id> [json] Call one or more tools
  service install [code-mcp options]      Run code-mcp as a user service (starts at
                                          login, restarts on failure)
  service uninstall                       Stop and remove that service
  service status                          Is it installed / running?
  update                                  Update the CLI to the newest release
  help [command]                          Show help

ADVANCED
  code-mcp [code-mcp options]             Run the bundled code-mcp device server with
                                          the config's code-mcp options ('mcp help code-mcp')

ALIASES
  mcp                     Same as 'mcp --help'
  mcp call                Same as 'mcp tools call'
  mcp upgrade             Same as 'mcp update'

EXAMPLES
  mcp connect                                    # this machine, on the default gateway
  claude mcp add gateway -- mcp serve            # all devices as one MCP server
  mcp devices connect my-laptop --token dev-secret --gateway https://gw.example.dev
  mcp devices connect my-laptop                  # uses defaults from config
  mcp devices list
  mcp tools list my-laptop
  mcp tools view my-laptop.snapshot
  mcp tools call my-laptop.click '{"selector":"#submit"}'
  echo '{"name":"my-laptop.snapshot","arguments":{}}' | mcp tools call
  mcp call my-laptop.snapshot '{}' my-laptop.click '{"selector":"#ok"}'

CONFIG
  Precedence per field: --flag > environment > device entry > defaults section.
  With no gateway configured anywhere, https://prime.tuanm.workers.dev is used.
  Environment: CODE_MCP_GATEWAY_CONFIG, CODE_MCP_GATEWAY_URL,
  CODE_MCP_GATEWAY_TOKEN, CODE_MCP_GATEWAY_DEVICE_TOKEN,
  CODE_MCP_GATEWAY_TIMEOUT_MS.

EXIT CODES
  0 success   1 error   2 usage   3 authentication   4 device offline   5 timeout
`;

const DEVICES = `mcp devices - manage device connections

USAGE
  mcp devices connect <device-id> [options]
  mcp devices disconnect <device-id>
  mcp devices status <device-id> [--json]
  mcp devices list [--no-probe] [--json]

${bold("connect")}
  Stores <device-id> (and any credentials given) in the config file, then probes
  the device. Unspecified fields fall back to environment variables, the device's
  existing entry, then the defaults section - so after one full connect, later
  devices need only 'mcp devices connect <device-id>'.

  Options:
    --token <token>          Device token (sent as X-Device-Token)
    --gateway <url>          Gateway origin, e.g. https://gw.example.dev
    --gateway-token <token>  Gateway credential (sent as Authorization: Bearer)
    --timeout <ms>           Per-request timeout (default 300000)
    --no-verify              Skip the reachability probe
    --set-default            Also write the given values into the defaults section

${bold("disconnect")}
  Removes the device's entry from the config file. It does not affect the device
  itself, which keeps its own tunnel to the gateway. Idempotent.

${bold("status")}
  Sends an MCP 'ping' and reports reachability and round-trip time. Exits 4 when
  the device is offline, 3 when the credentials are rejected.

${bold("list")}
  Lists configured devices and probes them concurrently. --no-probe skips the
  probes for an instant, offline listing.
`;

const TOOLS = `mcp tools - list, inspect and call device tools

USAGE
  mcp tools list <device-id> [--json]
  mcp tools view <device-id>.<tool-id> [--json]
  mcp tools call <device-id>.<tool-id> [<arguments-json>] [options]
  mcp tools call <device-id>.<tool-id> <args> <device-id>.<tool-id> <args> ...
  ... | mcp tools call

${bold("list")}
  Lists the tools a device exposes: name and one-line description.

${bold("view")}
  Prints one tool's description, JSON input schema, and a ready-to-run call
  command with the required arguments scaffolded.

${bold("call")}
  Five input forms, so every platform has one that needs no shell tricks.
  cmd.exe has no 'cat' and no single-quote syntax, hence --file and --arg:

    1. inline     mcp tools call dev.tool '{"a":1}'
    2. key/value  mcp tools call dev.tool --arg a=1 --arg b=text
    3. paired     mcp tools call dev1.t1 '{}' dev2.t2 '{"b":2}'
    4. file       mcp tools call --file calls.json       (-f, or '-' for stdin)
                  mcp tools call @calls.json
    5. stdin      mcp tools call --stdin
                  type calls.json | mcp tools call

  Specification file or stdin - one object, or an array of them:
    { "name": "<device>.<tool>", "arguments": { ... } }
    [ { "id": 1, "name": "<device>.<tool>", "arguments": { ... } }, ... ]

  Options:
    -f, --file <path>   Read the specification from a file ('-' = stdin);
                        repeatable, and files may each hold an array
    --stdin             Read the specification from stdin
    --arg <name=value>  Set one argument without JSON quoting; repeatable.
                        Values parse as JSON scalars, so n=5 is a number and
                        s=text is a string
    --json              Output raw MCP results as JSON
    --parallel          Run multiple calls concurrently (default: sequential)
    --concurrency <n>   Max calls in flight with --parallel (default 8)
    --handshake <mode>  auto | always | never (default auto) - when to send the
                        MCP initialize handshake before the first request
    --timeout <ms>      Per-call timeout
    --device <device>   Force the device id when the label is ambiguous
    --tool <tool>       Force the tool name when the label is ambiguous

  A single reference without arguments calls the tool with {}.

  Failures are per call: one failing call never stops the others, every result
  is still reported, and the command exits 1 if any call failed or returned
  isError. A call that fails on its own keeps its specific exit code (3 auth,
  4 offline, 5 timeout).
`;

const CONNECT = `mcp connect - connect THIS machine to the gateway as an anonymous device

USAGE
  mcp connect [--gateway <url>] [--new] [--no-start] [--json] [-- <code-mcp flags>]

Creates an anonymous device on the gateway (POST /api/devices/anonymous), saves
its id and device code in the config file, prints them with the connect URL,
then runs the bundled code-mcp in the foreground as that device - your files
and shell become MCP tools reachable through the gateway. Ctrl-C stops it.

The device is saved per gateway and reused on every later run (the gateway
caps the total number of devices), so 'mcp connect' always comes back as the
same device. If the gateway no longer knows it (an unused anonymous device is
deleted after about an hour, one offline for 7 days is deleted too), a new one
is registered automatically and the note says so.

The saved device is an ordinary config entry: 'mcp tools list <id>',
'mcp call <id>.<tool>' and 'mcp serve' use it like any other device.

OPTIONS
  --gateway <url>          Gateway origin. Default: the saved default gateway,
                           else https://prime.tuanm.workers.dev
  --gateway-token <token>  Gateway credential, for gateways that require one
  --new                    Register a fresh device instead of reusing the saved one
  --no-start               Only register/reuse and print; do not run code-mcp
  --port <n>               Local port for code-mcp's HTTP listener (default: free)
  --json                   Print the credentials as JSON (then run code-mcp)
  -- <flags>               Extra code-mcp flags, e.g. -- --enable-memory

  Keep the connect URL and device code secret: they grant shell access to this
  machine. Anonymous devices have a lower request budget than registered ones
  and cannot use file storage.

ERRORS
  429  too many devices created from your network - the retry time is shown
  503  the gateway's device limit is reached
  403  anonymous devices are disabled on this gateway (exit 3)
`;

const SERVE = `mcp serve - every device's tools as ONE MCP server

USAGE
  mcp serve [<device-id>...] [options]                stdio (default)
  mcp serve [<device-id>...] --port <n> [--host <a>]  Streamable HTTP on /mcp

Aggregates the tools of the configured devices (the same devices and
credentials 'mcp tools list' / 'mcp call' use; or only the ids given) behind a
single MCP server, for MCP clients:

  claude mcp add gateway -- mcp serve
  codex mcp add gateway -- mcp serve
  mcp serve --port 7800        then point a client at http://127.0.0.1:7800/mcp

Tool names are <device>__<tool> (characters outside [a-zA-Z0-9_-] become "_",
collisions and over-long names get a short stable hash suffix), and each
description starts with [<device-id>]. Calls are routed to the device and its
result is returned verbatim.

Offline devices are skipped (noted on stderr) and picked up again later: the
tool list is re-read on tools/list (cached for 15 s), and in stdio mode every
60 s with a tools/list_changed notification. With no reachable device the
server still starts, with an empty tool list.

In stdio mode stdout carries only JSON-RPC; all notes go to stderr.

OPTIONS
  --port <n>               Serve Streamable HTTP (POST /mcp; GET returns 405)
  --host <addr>            Listen address for --port (default 127.0.0.1)
  --allow-remote           Required for a non-loopback --host. The server has NO
                           authentication: anyone who reaches it can run every
                           device's tools, shell included
  --gateway, --gateway-token, --token, --timeout
                           Override the gateway/credentials for every device
                           (default gateway: https://prime.tuanm.workers.dev)
`;

const CODE_MCP = `mcp code-mcp - run the bundled code-mcp device server   (advanced)

USAGE
  mcp code-mcp [code-mcp flags]
  mcp code-mcp --help          code-mcp's own flag reference

The CLI embeds code-mcp (code-mcp/ in github.com/Tuanm/prime), the MCP server that
exposes this machine's files and shell as tools. 'mcp connect' runs it for
you; use this command for anything else code-mcp supports, e.g. a registered
device:

  mcp code-mcp --gateway gw.example.dev --id my-laptop --gateway-token <token>

OPTIONS FROM THE CONFIG
  The code-mcp section of ~/.prime-gateway/config.yaml holds code-mcp's
  options (names without the dashes); options given here override them:

    code-mcp:
      port: "7777"
      bind: "127.0.0.1"
      id: "my-laptop"
      token: "dev-secret"
      gateway: "prime.tuanm.workers.dev"
      enable-memory: true

  Values from the config never appear on a command line (ps).

  Refuses to start while the code-mcp service is running ('mcp service').
`;

const SERVICE = `mcp service - run code-mcp as a user service

USAGE
  mcp service install [code-mcp options]   install (or reinstall) and start it
  mcp service uninstall                    stop and remove it
  mcp service status [--json]              is it installed / running?

The service runs 'mcp code-mcp' with the code-mcp section of
~/.prime-gateway/config.yaml, overridden by the options given to
'service install' (kept in service.yaml next to the config). Options are read
at every start, so to apply a config change, run 'mcp service install' again.
No credential is written into the service definition or onto a command line.

  Linux    systemd user unit  ~/.config/systemd/user/code-mcp.service
           logs: journalctl --user -u code-mcp
  macOS    launchd agent      ~/Library/LaunchAgents/dev.prime-gateway.code-mcp.plist
           logs: ~/Library/Logs/prime-gateway/code-mcp.log
  Windows  Scheduled Task     \\prime-gateway\\code-mcp (at logon; no admin needed)
           logs: code-mcp.log next to the config

It starts at login and is restarted if it crashes. On Linux it stops at logout
unless lingering is on: loginctl enable-linger USER.

EXAMPLES
  mcp service install                         # config's code-mcp section as is
  mcp service install --port 7788 --enable-memory
  mcp service status
  mcp service uninstall
`;

const UPDATE = `mcp update - install the newest release   (alias: mcp upgrade)

USAGE
  mcp update [--check] [--force] [--release-version <v>] [--to <path>] [--json]

Checks the GitHub releases for a newer 'cli-v<version>' tag and, if there is
one, downloads the asset for this platform, verifies it against the release's
SHA256SUMS, and swaps it in.

  current   26.10.3
  latest    26.10.4
  installed 26.10.4 -> /Users/you/.local/bin/mcp

OPTIONS
  --check                    Report whether an update exists; install nothing
  --force                    Reinstall even when the version is already current
  --release-version <v>      Install one specific version instead of the newest
  --to <path>                Install to this path instead of replacing the
                             running binary (useful for a prefix you own)
  --json                     Machine-readable result

NOTES
  The running binary is replaced atomically, so an interrupted update cannot
  leave a half-written executable. Replacing the running process is fine on
  macOS and Linux. On Windows, where a running .exe can be renamed but not
  overwritten, the old binary is moved aside to <path>.old and removed on the
  next run.

  The checksum comes from the same release as the artifact, so it proves the
  download is intact and unmodified in transit - not that the release itself is
  trustworthy.

  If the install directory is not writable, re-run with the privileges that own
  it (for example: sudo mcp update), or use --to for a directory you own.

ENVIRONMENT
  GITHUB_TOKEN        Raises the GitHub API rate limit (optional)
  MCP_CLI_REPO        Override the repository, default Tuanm/prime
  MCP_CLI_API_BASE    Override the API base, default https://api.github.com
`;

export function rootHelp(): string {
  return ROOT;
}

export function helpFor(topic: string | undefined, sub: string | undefined): string | undefined {
  if (!topic) return ROOT;
  if (topic === "devices") return DEVICES;
  if (topic === "tools") return TOOLS;
  if (topic === "call") return TOOLS;
  if (topic === "update" || topic === "upgrade") return UPDATE;
  if (topic === "connect") return CONNECT;
  if (topic === "serve") return SERVE;
  if (topic === "code-mcp") return CODE_MCP;
  if (topic === "service") return SERVICE;
  if (topic === "help") return `${ROOT}\n${dim("Usage: mcp help [connect|serve|service|devices|tools|call|update|code-mcp]")}`;
  void sub;
  return undefined;
}

/** One-line usage hint shown when a command is invoked incorrectly. */
export function usageLine(topic: string, sub?: string): string {
  if (topic === "devices") {
    if (sub === "connect") return "Usage: mcp devices connect <device-id> [--token <t>] [--gateway <url>]";
    if (sub === "disconnect") return "Usage: mcp devices disconnect <device-id>";
    if (sub === "status") return "Usage: mcp devices status <device-id>";
    if (sub === "list") return "Usage: mcp devices list";
    return "Usage: mcp devices <connect|disconnect|status|list> [args]";
  }
  if (topic === "update" || topic === "upgrade") return "Usage: mcp update [--check] [--force] [--to <path>]";
  if (topic === "connect") return "Usage: mcp connect [--gateway <url>] [--new] [-- <code-mcp flags>]";
  if (topic === "serve") return "Usage: mcp serve [<device-id>...] [--port <n>] [--host <addr>]";
  if (topic === "tools" || topic === "call") {
    if (sub === "list") return "Usage: mcp tools list <device-id>";
    if (sub === "view") return "Usage: mcp tools view <device-id>.<tool-id>";
    if (sub === "call") return "Usage: mcp tools call <device-id>.<tool-id> [<arguments-json>]";
    return "Usage: mcp tools <list|view|call> [args]";
  }
  return "Usage: mcp [command] [options]";
}

export const TOPIC_HINT = `Run '${cyan("mcp --help")}' for the command list.`;
