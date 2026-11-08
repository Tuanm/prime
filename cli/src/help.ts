// Help text. Kept in one place so every command's --help stays consistent.
//
// Prose uses plain quotes rather than backticks: these blocks are template
// literals, so an unescaped backtick would terminate the string.

import { bold, cyan, dim } from "./output.ts";

const ROOT = `prime - command line client for the Prime gateway

Connects to devices exposed through the Prime gateway and drives their
MCP tools. Credentials and defaults live in ~/.prime/config.yaml.

USAGE
  prime [command] [options]

COMMANDS
  connect [--gateway <url>] [--new]       Connect THIS machine as an anonymous device
                                          (registers or reuses one, runs the device buddy)
  serve [--port <n>]                      Serve every device's tools as one MCP server
                                          (stdio by default; HTTP with --port)
  devices connect <device-id> [options]   Save credentials for a device and verify it
  devices disconnect <device-id>          Forget a device's local configuration
  devices status <device-id>              Probe one device
  devices list                            List configured devices
  tools list <device-id>                  List a device's MCP tools
  tools view <device-id>.<tool-id>        Show one tool's schema
  tools call <device-id>.<tool-id> [json] Call one or more tools
  files list                              List uploaded files and their metadata
  files upload <path> [options]           Upload a file through the files API
  files download <id|name> [options]      Download an uploaded file
  spaces create [--name <n>] [--persistent] A rootless Linux codespace running the device buddy
  spaces list|start|stop|delete|logs <name> Manage the codespaces (local devices)
  service install [options]               Run the device buddy as a user service (starts at
                                          login, restarts on failure)
  service uninstall                       Stop and remove that service
  service status                          Is it installed / running?
  update                                  Update the CLI to the newest release
  help [command]                          Show help

ADVANCED
  code-mcp [options]                      Run the bundled device buddy with
                                          the config's options ('prime help code-mcp')

ALIASES
  prime                   Same as 'prime --help'
  prime call                Same as 'prime tools call'
  prime upgrade             Same as 'prime update'
  prime upload              Same as 'prime files upload'
  prime download            Same as 'prime files download'

EXAMPLES
  prime connect                                    # this machine, on the default gateway
  claude mcp add gateway -- prime serve            # all devices as one MCP server
  prime devices connect my-laptop --token dev-secret --gateway https://gw.example.dev
  prime devices connect my-laptop                  # uses defaults from config
  prime devices list
  prime tools list my-laptop
  prime tools view my-laptop.snapshot
  prime tools call my-laptop.click '{"selector":"#submit"}'
  echo '{"name":"my-laptop.snapshot","arguments":{}}' | prime tools call
  prime call my-laptop.snapshot '{}' my-laptop.click '{"selector":"#ok"}'
  prime files upload ./report.pdf --expiry-days 1
  prime files list
  prime files download report.pdf -o ./report.pdf

CONFIG
  Precedence per field: --flag > environment > device entry > defaults section.
  With no gateway configured anywhere, https://prime.tuanm.workers.dev is used.
  Environment: PRIME_CONFIG, PRIME_GATEWAY_URL, PRIME_GATEWAY_TOKEN,
  PRIME_DEVICE_TOKEN, PRIME_TIMEOUT_MS.

EXIT CODES
  0 success   1 error   2 usage   3 authentication   4 device offline   5 timeout
`;

const DEVICES = `prime devices - manage device connections

USAGE
  prime devices connect <device-id> [options]
  prime devices disconnect <device-id>
  prime devices status <device-id> [--json]
  prime devices list [--no-probe] [--json]

${bold("connect")}
  Stores <device-id> (and any credentials given) in the config file, then probes
  the device. Unspecified fields fall back to environment variables, the device's
  existing entry, then the defaults section - so after one full connect, later
  devices need only 'prime devices connect <device-id>'.

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

const TOOLS = `prime tools - list, inspect and call device tools

USAGE
  prime tools list <device-id> [--json]
  prime tools view <device-id>.<tool-id> [--json]
  prime tools call <device-id>.<tool-id> [<arguments-json>] [options]
  prime tools call <device-id>.<tool-id> <args> <device-id>.<tool-id> <args> ...
  ... | prime tools call

${bold("list")}
  Lists the tools a device exposes: name and one-line description.

${bold("view")}
  Prints one tool's description, JSON input schema, and a ready-to-run call
  command with the required arguments scaffolded.

${bold("call")}
  Five input forms, so every platform has one that needs no shell tricks.
  cmd.exe has no 'cat' and no single-quote syntax, hence --file and --arg:

    1. inline     prime tools call dev.tool '{"a":1}'
    2. key/value  prime tools call dev.tool --arg a=1 --arg b=text
    3. paired     prime tools call dev1.t1 '{}' dev2.t2 '{"b":2}'
    4. file       prime tools call --file calls.json       (-f, or '-' for stdin)
                  prime tools call @calls.json
    5. stdin      prime tools call --stdin
                  type calls.json | prime tools call

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

const CONNECT = `prime connect - connect THIS machine to the gateway as an anonymous device

USAGE
  prime connect [--gateway <url>] [--new] [--no-start] [--json] [-- <device flags>]

Creates an anonymous device on the gateway (POST /api/devices/anonymous), saves
its id and device code in the config file, prints them with the connect URL,
then runs the bundled device buddy in the foreground as that device - your files
and shell become MCP tools reachable through the gateway. Ctrl-C stops it.

The device is saved per gateway and reused on every later run (the gateway
caps the total number of devices), so 'prime connect' always comes back as the
same device. If the gateway no longer knows it (an unused anonymous device is
deleted after about an hour, one offline for 7 days is deleted too), a new one
is registered automatically and the note says so.

The saved device is an ordinary config entry: 'prime tools list <id>',
'prime call <id>.<tool>' and 'prime serve' use it like any other device.

OPTIONS
  --gateway <url>          Gateway origin. Default: the saved default gateway,
                           else https://prime.tuanm.workers.dev
  --gateway-token <token>  Gateway credential, for gateways that require one
  --new                    Register a fresh device instead of reusing the saved one
  --no-start               Only register/reuse and print; do not run it
  --port <n>               Local port for its HTTP listener (default: free)
  --json                   Print the credentials as JSON (then run the device buddy)
  -- <flags>               Extra device-buddy flags, e.g. -- --enable-memory

  Keep the connect URL and device code secret: they grant shell access to this
  machine. Anonymous devices have a lower request budget than registered ones
  and cannot use file storage.

ERRORS
  429  too many devices created from your network - the retry time is shown
  503  the gateway's device limit is reached
  403  anonymous devices are disabled on this gateway (exit 3)
`;

const SERVE = `prime serve - every device's tools as ONE MCP server

USAGE
  prime serve [<device-id>...] [options]                stdio (default)
  prime serve [<device-id>...] --port <n> [--host <a>]  Streamable HTTP on /mcp

Aggregates the tools of the configured devices (the same devices and
credentials 'prime tools list' / 'prime call' use; or only the ids given) behind a
single MCP server, for MCP clients:

  claude mcp add gateway -- prime serve
  codex mcp add gateway -- prime serve
  prime serve --port 7800        then point a client at http://127.0.0.1:7800/mcp

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

const CODE_MCP = `prime code-mcp - the bundled device buddy   (advanced)

USAGE
  prime code-mcp [options]
  prime code-mcp --help          its own flag reference

The CLI embeds the device buddy (one module in this package), the MCP server that
exposes this machine's files and shell as tools. 'prime connect' runs it for
you; use this command for anything else it supports, e.g. a registered
device:

  prime code-mcp --gateway gw.example.dev --id my-laptop --gateway-token <token>

OPTIONS FROM THE CONFIG
  The config's matching section holds its options (names without the dashes);
  options given here override them:

    code-mcp:
      port: "7777"
      bind: "127.0.0.1"
      id: "my-laptop"
      token: "dev-secret"
      gateway: "prime.tuanm.workers.dev"
      enable-memory: true

  Values from the config never appear on a command line (ps).

  Refuses to start while the service is running ('prime service').
`;

const SERVICE = `prime service - the device buddy as a user service

USAGE
  prime service install [options]            install (or reinstall) and start it
  prime service uninstall                    stop and remove it
  prime service status [--json]              is it installed / running?

The service runs 'prime code-mcp' with the matching section of
~/.prime/config.yaml, overridden by the options given to
'service install' (kept in service.yaml next to the config). Options are read
at every start, so to apply a config change, run 'prime service install' again.
No credential is written into the service definition or onto a command line.

  Linux    systemd user unit  ~/.config/systemd/user/code-mcp.service
           logs: journalctl --user -u code-mcp
  macOS    launchd agent      ~/Library/LaunchAgents/dev.prime.code-mcp.plist
           logs: ~/Library/Logs/prime/code-mcp.log
  Windows  Scheduled Task     \\prime\\code-mcp (at logon; no admin needed)
           logs: code-mcp.log next to the config

It starts at login and is restarted if it crashes. On Linux it stops at logout
unless lingering is on: loginctl enable-linger USER.

EXAMPLES
  prime service install                         # the config's service options as is
  prime service install --port 7788 --enable-memory
  prime service status
  prime service uninstall
`;

const UPDATE = `prime update - install the newest release   (alias: prime upgrade)

USAGE
  prime update [--check] [--force] [--release-version <v>] [--to <path>] [--json]

Checks the GitHub releases for a newer 'prime-v<version>' tag and, if there is
one, downloads the asset for this platform, verifies it against the release's
SHA256SUMS, and swaps it in.

  current   26.10.3
  latest    26.10.4
  installed 26.10.4 -> /Users/you/.local/bin/prime

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
  it (for example: sudo prime update), or use --to for a directory you own.

ENVIRONMENT
  GITHUB_TOKEN        Raises the GitHub API rate limit (optional)
  MCP_CLI_REPO        Override the repository, default Tuanm/prime
  MCP_CLI_API_BASE    Override the API base, default https://api.github.com
`;

const FILES = `prime files - list, upload and download files on the gateway

USAGE
  prime files list [options]
  prime files upload <path> [options]       (alias: prime upload)
  prime files download <id|name> [options]  (alias: prime download)

The files API stores files in R2 under a registered device. Uploads expire
(default: the gateway maximum, 7 days) and count against per-device limits.
Every command authenticates with a device id + token. By default both come from
the device configured for the background service (the options 'prime service
install' writes), so once the service is installed the file commands just
work. Flags override each field:

  --device <id>       Device whose files to use (default: the service's device)
  --token <token>     Device token (default: the service's credential)
  --gateway <url>     Gateway origin (default: the service's gateway)
  --timeout <ms>      Per-request timeout (default 300000)

${bold("list")}
  Prints the stored files with their metadata: name, id, size, content type,
  creation time, expiry and whether the file has a protection key. --json
  prints the full API record, including the download and page URLs and the
  device's usage. --show-keys prints protection keys (owner only).

${bold("upload")}
  Streams the file to POST /api/files - nothing is buffered, so a large file
  is never held in memory. Progress is drawn on stderr when it is a TTY.

  --name <name>          Stored name (default: the path basename)
  --key <key>            Protect the file at creation; downloads then need the
                         same key, sent as a request header
  --content-type <type>  MIME type (default: the file type, else
                         application/octet-stream)
  --expires-in <sec>     Lifetime in seconds
  --expiry-days <days>   Lifetime in days
  --json                 Machine-readable result

${bold("download")}
  Streams GET /api/files/<id> straight to disk. Without -o the stored name is
  used, in the current directory or inside -o's directory.

  -o, --output <path>    Output path (- writes the bytes to stdout)
  --key <key>            Key for a protected file (owner auth also works)
  --resume               Continue a partial download with a Range request
                         (needs a concrete -o)
  --force                Overwrite an existing output file
  --json                 Machine-readable result

  A file may be named instead of an id when exactly one file on the device has
  that name; for duplicates the command lists the matching ids.

EXIT CODES
  0 success   1 error   2 usage   3 authentication   4 device offline   5 timeout
`;

const SPACES = `prime spaces - disposable or persistent Linux codespaces

USAGE
  prime spaces create [--name <name>] [--persistent] [options]
  prime spaces list [--json]
  prime spaces start <name>
  prime spaces stop <name>
  prime spaces delete <name>
  prime spaces logs <name>
  prime spaces doctor [--json]

A space is a rootless Linux container that runs the device buddy (no gateway)
and registers itself as a local device, so "prime devices list" and
"prime tools call <space-id>.<tool>" work like any other device - except that
the container is the machine.

RUNTIME
  macOS   the Apple container CLI: one lightweight micro-VM per space, so root
          inside is not root on the host. No Docker Desktop needed.
  Linux   rootless podman (containers get a user namespace; root inside maps to
          your host user). Docker is a fallback and needs --allow-rootful unless
          it runs rootless.
  Every space gets its own network (an Apple vmnet or a podman bridge), so two
  spaces cannot reach each other. The host reaches a space over that private
  address (Apple) or a 127.0.0.1 publish (podman/docker); nothing is exposed to
  the LAN.

STATE
  --ephemeral (default)  stop deletes the container: the next start is a clean
                         environment.
  --persistent           /root/work is a named volume and stop keeps the
                         container, so start resumes exactly where it was.

SECURITY
  Rootless runtime + no host mounts + no docker socket + per-space network.
  Resource limits are REQUIRED by default: --cpus (default 2), --memory
  (default 4g); podman also pins --pids-limit 512 and no-new-privileges. If the
  runtime cannot enforce cgroups (rootless podman without systemd, WSL2), create
  refuses unless --allow-no-limits is passed. The MCP server needs a random
  per-space token; it is passed in a 0600 env file, not on a process list.
  Online spaces have NAT: they reach the internet and host services on 0.0.0.0.
  --offline puts a space on an internal network (Apple internal vmnet or podman
  internal): no internet, but the host can still reach it.
  WSL2 without systemd: enable systemd, or install crun - prime then forces
  engine.runtime=crun and retries with --cgroups=disabled (no limits: refused
  unless --allow-no-limits). runc cannot do NoCgroups, and podman has no
  per-container --runtime flag.

OPTIONS (create)
  --name <name>       space name (default: a generated device id)
  --persistent        keep /root/work and the container across stop/start
  --image <image>     default: ghcr.io/tuanm/prime-space:<version>
  --cpus <n>          default 2
  --memory <size>     default 4g, e.g. 512m, 2g
  --offline           internal network only (no internet), host still connects
  --runtime <rt>      apple|podman|docker
  --allow-rootful     permit rootful docker (not recommended)
  --allow-no-limits   accept a space without enforced cpu/memory limits

EXAMPLES
  prime spaces create --name dev                    # ephemeral, 2 cpu, 4g
  prime spaces create --name work --persistent      # keeps /root/work
  prime devices list                                # the space shows up local
  prime tools call dev.bash '{"cwd":"/root/work","command":"uname -a"}'
  prime spaces stop dev                             # deletes the container state
  prime spaces start work                           # resumes the persistent space
  prime spaces delete work                          # container, volume, device entry
  prime spaces doctor                               # rootless? systemd? crun? limits?
`;
export function rootHelp(): string {
  return ROOT;
}

export function helpFor(topic: string | undefined, sub: string | undefined): string | undefined {
  if (!topic) return ROOT;
  if (topic === "devices") return DEVICES;
  if (topic === "tools") return TOOLS;
  if (topic === "call") return TOOLS;
  if (topic === "files" || topic === "upload" || topic === "download") return FILES;
  if (topic === "spaces") return SPACES;
  if (topic === "update" || topic === "upgrade") return UPDATE;
  if (topic === "connect") return CONNECT;
  if (topic === "serve") return SERVE;
  if (topic === "code-mcp") return CODE_MCP;
  if (topic === "service") return SERVICE;
  if (topic === "help") return `${ROOT}\n${dim("Usage: prime help [connect|serve|service|devices|tools|files|spaces|call|update|code-mcp]")}`;
  void sub;
  return undefined;
}

/** One-line usage hint shown when a command is invoked incorrectly. */
export function usageLine(topic: string, sub?: string): string {
  if (topic === "devices") {
    if (sub === "connect") return "Usage: prime devices connect <device-id> [--token <t>] [--gateway <url>]";
    if (sub === "disconnect") return "Usage: prime devices disconnect <device-id>";
    if (sub === "status") return "Usage: prime devices status <device-id>";
    if (sub === "list") return "Usage: prime devices list";
    return "Usage: prime devices <connect|disconnect|status|list> [args]";
  }
  if (topic === "update" || topic === "upgrade") return "Usage: prime update [--check] [--force] [--to <path>]";
  if (topic === "connect") return "Usage: prime connect [--gateway <url>] [--new] [-- <device flags>]";
  if (topic === "serve") return "Usage: prime serve [<device-id>...] [--port <n>] [--host <addr>]";
  if (topic === "spaces") {
    if (sub === "create") return "Usage: prime spaces create [--name <name>] [--persistent] [--cpus <n>] [--memory <4g>]";
    if (sub === "list") return "Usage: prime spaces list [--json]";
    if (sub === "logs") return "Usage: prime spaces logs <name>";
    if (sub === "doctor") return "Usage: prime spaces doctor [--json]";
    return "Usage: prime spaces <create|start|stop|delete|list|logs|doctor> [args]";
  }
  if (topic === "files" || topic === "upload" || topic === "download") {
    if (sub === "list") return "Usage: prime files list [--device <id>] [--json]";
    if (sub === "upload") return "Usage: prime files upload <path> [--name <name>] [--expiry-days <n>] [--key <key>]";
    if (sub === "download") return "Usage: prime files download <id|name> [-o <path>] [--key <key>] [--resume]";
    return "Usage: prime files <list|upload|download> [args]";
  }
  if (topic === "tools" || topic === "call") {
    if (sub === "list") return "Usage: prime tools list <device-id>";
    if (sub === "view") return "Usage: prime tools view <device-id>.<tool-id>";
    if (sub === "call") return "Usage: prime tools call <device-id>.<tool-id> [<arguments-json>]";
    return "Usage: prime tools <list|view|call> [args]";
  }
  return "Usage: prime [command] [options]";
}

export const TOPIC_HINT = `Run '${cyan("prime --help")}' for the command list.`;
