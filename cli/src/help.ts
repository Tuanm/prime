// Help text. Kept in one place so every command's --help stays consistent.
//
// Prose uses plain quotes rather than backticks: these blocks are template
// literals, so an unescaped backtick would terminate the string.

import { bold, cyan, dim } from "./output.ts";

const ROOT = `mcp - command line client for code-mcp-gateway

Connects to devices exposed through a code-mcp-gateway Worker and drives their
MCP tools. Credentials and defaults live in ~/.code-mcp-gateway/config.yaml.

USAGE
  mcp [command] [options]

COMMANDS
  devices connect <device-id> [options]   Save credentials for a device and verify it
  devices disconnect <device-id>          Forget a device's local configuration
  devices status <device-id>              Probe one device
  devices list                            List configured devices
  tools list <device-id>                  List a device's MCP tools
  tools view <device-id>.<tool-id>        Show one tool's schema
  tools call <device-id>.<tool-id> [json] Call one or more tools
  update                                  Update the CLI to the newest release
  help [command]                          Show help

ALIASES
  mcp                     Same as 'mcp --help'
  mcp call                Same as 'mcp tools call'
  mcp upgrade             Same as 'mcp update'

EXAMPLES
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
  macOS and Linux; on Windows a running .exe cannot be replaced, so the update
  is staged as <path>.new and the exact move command is printed.

  The checksum comes from the same release as the artifact, so it proves the
  download is intact and unmodified in transit - not that the release itself is
  trustworthy.

  If the install directory is not writable, re-run with the privileges that own
  it (for example: sudo mcp update), or use --to for a directory you own.

ENVIRONMENT
  GITHUB_TOKEN        Raises the GitHub API rate limit (optional)
  MCP_CLI_REPO        Override the repository, default Tuanm/code-mcp-gateway
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
  if (topic === "help") return `${ROOT}\n${dim("Usage: mcp help [devices|tools|call]")}`;
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
  if (topic === "tools" || topic === "call") {
    if (sub === "list") return "Usage: mcp tools list <device-id>";
    if (sub === "view") return "Usage: mcp tools view <device-id>.<tool-id>";
    if (sub === "call") return "Usage: mcp tools call <device-id>.<tool-id> [<arguments-json>]";
    return "Usage: mcp tools <list|view|call> [args]";
  }
  return "Usage: mcp [command] [options]";
}

export const TOPIC_HINT = `Run '${cyan("mcp --help")}' for the command list.`;
