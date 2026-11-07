#!/usr/bin/env bun
// prime - command line client for the Prime gateway.
//
// Command surface:
//   prime connect [--gateway <url>]     this machine as an anonymous device (runs code-mcp)
//   prime serve [--port <n>]           all devices' tools as one MCP server
//   prime devices connect|disconnect|status|list
//   prime tools   list|view|call
//   prime code-mcp [flags]             (advanced) the bundled device buddy
//   prime service install|uninstall|status   code-mcp as a user service
//   prime help [topic]
//
// Aliases: `prime` (bare) shows help; `prime call ...` === `prime tools call ...`.

import { bool, flag, parseArgs, str, type FlagSpec } from "./args.ts";
import { runCodeMcp } from "./code-mcp-host.ts";
import { serviceInstall, serviceStatusCommand, serviceUninstall } from "./service-command.ts";
import { connectCommand } from "./connect.ts";
import { serveCommand } from "./serve.ts";
import { type Ctx, makeCtx } from "./context.ts";
import { devicesConnect, devicesDisconnect, devicesList, devicesStatus } from "./devices.ts";
import { filesDownload, filesList, filesUpload } from "./files.ts";
import { EXIT, exitCodeOf, hintOf, UsageError } from "./errors.ts";
import { TOPIC_HINT, helpFor, rootHelp, usageLine } from "./help.ts";
import { dim, initColor, red } from "./output.ts";
import { toolsCall, toolsList, toolsView } from "./tools.ts";
import { isSpaceCommand, spacesCreate, spacesDelete, spacesList, spacesLogs, spacesStart, spacesStop } from "./spaces.ts";
import { removeStaleWindowsBinary, renderUpdate, runUpdate } from "./update.ts";

// Replaced at build time by scripts/build.ts (--define). The fallback keeps
// `bun run src/index.ts` working during development.
const VERSION = process.env.MCP_CLI_VERSION ?? "26.11.9-dev";

// ---- per-command flag sets -------------------------------------------------

const GATEWAY_FLAGS: FlagSpec[] = [
  flag("gateway", "string", "Gateway origin, e.g. https://gw.example.dev", { placeholder: "<url>" }),
  flag("gateway-token", "string", "Gateway credential (Authorization: Bearer)", { placeholder: "<token>" }),
  flag("token", "string", "Device token (X-Device-Token)", { placeholder: "<token>" }),
  flag("timeout", "number", "Per-request timeout in milliseconds", { placeholder: "<ms>" }),
];

const CONNECT_FLAGS: FlagSpec[] = [
  ...GATEWAY_FLAGS,
  flag("no-verify", "boolean", "Skip the reachability probe after saving"),
  flag("set-default", "boolean", "Also store the given values as defaults"),
];

const LIST_FLAGS: FlagSpec[] = [
  flag("no-probe", "boolean", "Do not probe devices (instant, offline listing)"),
  flag("timeout", "number", "Probe timeout in milliseconds", { placeholder: "<ms>" }),
];

const TOOL_FLAGS: FlagSpec[] = [
  ...GATEWAY_FLAGS,
  flag("handshake", "string", "When to send the MCP initialize handshake: auto|always|never", { placeholder: "<mode>" }),
];

const CALL_FLAGS: FlagSpec[] = [
  ...TOOL_FLAGS,
  flag("file", "string", "Read the call specification from a JSON file ('-' = stdin); repeatable", { short: "f", placeholder: "<path>", repeatable: true }),
  flag("stdin", "boolean", "Read the call specification from stdin"),
  flag("arg", "string", "Set one argument as name=value, no JSON quoting needed; repeatable", { placeholder: "<name=value>", repeatable: true }),
  flag("parallel", "boolean", "Run multiple calls concurrently (default: sequential)"),
  flag("concurrency", "number", "Max calls in flight with --parallel (default 8)", { placeholder: "<n>" }),
  flag("device", "string", "Force the device id for an ambiguous label", { placeholder: "<id>" }),
  flag("tool", "string", "Force the tool name for an ambiguous label", { placeholder: "<name>" }),
];

const VIEW_FLAGS: FlagSpec[] = [...TOOL_FLAGS, flag("device", "string", "Force the device id", { placeholder: "<id>" }), flag("tool", "string", "Force the tool name", { placeholder: "<name>" })];

const SPACE_CREATE_FLAGS: FlagSpec[] = [
  flag("name", "string", "Space name (default: a generated device id)", { placeholder: "<name>" }),
  flag("persistent", "boolean", "Keep the state across stop/start"),
  flag("ephemeral", "boolean", "Discard the state on stop (default)"),
  flag("image", "string", "Image to use (default: the release's ghcr.io/tuanm/prime-space tag)", { placeholder: "<image>" }),
  flag("cpus", "number", "CPUs for the container (default 2)", { placeholder: "<n>" }),
  flag("memory", "string", "Memory limit, e.g. 4g (default 4g)", { placeholder: "<size>" }),
  flag("offline", "boolean", "No network access (podman/docker only)"),
  flag("runtime", "string", "Runtime: apple|podman|docker", { placeholder: "<runtime>" }),
  flag("allow-rootful", "boolean", "Permit rootful docker (not recommended)"),
];

const SPACE_LIFECYCLE_FLAGS: FlagSpec[] = [
  flag("allow-rootful", "boolean", "Permit rootful docker (not recommended)"),
];

const SPACE_LIST_FLAGS: FlagSpec[] = [
  flag("allow-rootful", "boolean", "Permit rootful docker (not recommended)"),
];

const FILES_TARGET_FLAGS: FlagSpec[] = [
  flag("device", "string", "Device id whose files to use (default: the code-mcp section's id)", { placeholder: "<id>" }),
  flag("gateway", "string", "Gateway origin", { placeholder: "<url>" }),
  flag("token", "string", "Device token", { placeholder: "<token>" }),
  flag("timeout", "number", "Per-request timeout in milliseconds", { placeholder: "<ms>" }),
];

const FILES_LIST_FLAGS: FlagSpec[] = [
  ...FILES_TARGET_FLAGS,
  flag("show-keys", "boolean", "Print each protected file's key (owner only)"),
];

const FILES_UPLOAD_FLAGS: FlagSpec[] = [
  ...FILES_TARGET_FLAGS,
  flag("name", "string", "Stored file name (default: the path's basename)", { placeholder: "<name>" }),
  flag("key", "string", "Protect the file with this key; downloads then need --key", { placeholder: "<key>" }),
  flag("content-type", "string", "MIME type (default: from the file)", { placeholder: "<type>" }),
  flag("expires-in", "number", "Lifetime in seconds (default: the server maximum)", { placeholder: "<seconds>" }),
  flag("expiry-days", "number", "Lifetime in days", { placeholder: "<days>" }),
];

const FILES_DOWNLOAD_FLAGS: FlagSpec[] = [
  ...FILES_TARGET_FLAGS,
  flag("output", "string", "Write to this path (- for stdout; default: the stored name)", { short: "o", placeholder: "<path>" }),
  flag("key", "string", "File key for a protected file", { placeholder: "<key>" }),
  flag("resume", "boolean", "Continue a partial download (needs -o <path>)"),
  flag("force", "boolean", "Overwrite an existing output file"),
];

const ANON_CONNECT_FLAGS: FlagSpec[] = [
  flag("gateway", "string", "Gateway origin (default: saved default, else https://prime.tuanm.workers.dev)", { placeholder: "<url>" }),
  flag("gateway-token", "string", "Gateway credential, only for gateways that require one", { placeholder: "<token>" }),
  flag("new", "boolean", "Register a fresh anonymous device instead of reusing the saved one"),
  flag("no-start", "boolean", "Register/reuse and print the credentials, but do not run code-mcp"),
  flag("port", "number", "Local port for code-mcp's own HTTP listener (default: a free port)", { placeholder: "<n>" }),
];

const SERVE_FLAGS: FlagSpec[] = [
  ...GATEWAY_FLAGS,
  flag("port", "number", "Serve Streamable HTTP on this port instead of stdio", { placeholder: "<n>" }),
  flag("host", "string", "Address for --port (default 127.0.0.1)", { placeholder: "<addr>" }),
  flag("allow-remote", "boolean", "Permit a non-loopback --host (no authentication!)"),
];

const UPDATE_FLAGS: FlagSpec[] = [
  flag("check", "boolean", "Only report whether a newer release exists"),
  flag("force", "boolean", "Reinstall even when the version is already current"),
  flag("to", "string", "Install to this path instead of replacing the running binary", { placeholder: "<path>" }),
  flag("release-version", "string", "Install this specific version instead of the newest", { placeholder: "<version>" }),
];

// ---- help ------------------------------------------------------------------

function showHelp(text: string | undefined, topic: string, sub?: string): void {
  if (text) {
    process.stdout.write(`${text.trimEnd()}\n`);
    return;
  }
  process.stderr.write(`${red("prime:")} unknown command "${[topic, sub].filter(Boolean).join(" ")}"\n`);
  process.stderr.write(`${TOPIC_HINT}\n`);
  process.exitCode = EXIT.USAGE;
}

// ---- main ------------------------------------------------------------------

async function main(argv: string[]): Promise<void> {
  if (argv.length === 0) {
    process.stdout.write(rootHelp().trimEnd() + "\n");
    return;
  }
  // Hidden/advanced: run the bundled device buddy. Every argument
  // belongs to code-mcp (including --help), so mcp's parser must not see them.
  if (argv[0] === "code-mcp") {
    await runCodeMcp(argv.slice(1));
    return;
  }
  // 'service install' takes code-mcp's options, which mcp's own parser does not
  // know - so it is routed before that parser, like code-mcp itself.
  if (argv[0] === "service") {
    const sub = argv[1];
    const rest = argv.slice(2);
    if (sub === undefined || sub === "--help" || sub === "-h" || rest.includes("--help") || rest.includes("-h")) {
      showHelp(helpFor("service", undefined), "service");
      return;
    }
    // prime's own flags here: --json, and the global --config (the config file
    // the service will read). Everything else belongs to code-mcp.
    const json = rest.includes("--json");
    let config: string | undefined;
    const args: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (arg === "--json") continue;
      if (arg === "--config") {
        config = rest[++i];
        if (!config) throw new UsageError("--config needs a path");
        continue;
      }
      if (arg.startsWith("--config=")) {
        config = arg.slice("--config=".length);
        continue;
      }
      args.push(arg);
    }
    const line = (t: string) => (t.endsWith("\n") ? t : t + "\n");
    const opts = { json, config, out: (t: string) => void process.stdout.write(line(t)), note: (t: string) => void process.stderr.write(line(t)) };
    if (sub === "install") return serviceInstall(args, opts);
    if (sub === "uninstall") return serviceUninstall(args, opts);
    if (sub === "status") return serviceStatusCommand(args, opts);
    throw new UsageError(`unknown service command "${sub}"`, "Valid: install, uninstall, status.");
  }
  if (argv[0] === "--version" || argv[0] === "version") {
    process.stdout.write(`prime ${VERSION}\n`);
    return;
  }

  // Aliases: `prime call ...` === `prime tools call ...`, `prime upgrade` === `prime update`,
  // `prime upload`/`prime download` === `prime files upload`/`prime files download`.
  if (argv[0] === "call") argv = ["tools", "call", ...argv.slice(1)];
  if (argv[0] === "upgrade") argv = ["update", ...argv.slice(1)];
  if (argv[0] === "upload") argv = ["files", "upload", ...argv.slice(1)];
  if (argv[0] === "download") argv = ["files", "download", ...argv.slice(1)];

  const topic = argv[0]!;
  const rest = argv.slice(1);

  if (topic === "--help" || topic === "-h" || topic === "help") {
    const wanted = topic === "help" ? rest : [];
    showHelp(helpFor(wanted[0], wanted[1]), wanted[0] ?? "help", wanted[1]);
    return;
  }

  const sub = rest[0];
  const wantHelp = rest.includes("--help") || rest.includes("-h") || sub === undefined;

  if (topic === "connect" || topic === "serve") {
    // Only mcp's own flags count: "prime connect -- --help" is code-mcp's.
    const own = rest.includes("--") ? rest.slice(0, rest.indexOf("--")) : rest;
    if (own.includes("--help") || own.includes("-h")) {
      showHelp(helpFor(topic, undefined), topic);
      return;
    }
  }

  if (topic === "devices" || topic === "tools" || topic === "files" || topic === "spaces") {
    if (wantHelp) {
      showHelp(helpFor(topic, sub), topic, sub);
      return;
    }
  }
  // update has no subcommands: a bare "prime update" is the install itself (it
  // used to print help, while its own hint says to run exactly that).
  if (topic === "update" && (rest.includes("--help") || rest.includes("-h"))) {
    showHelp(helpFor(topic, undefined), topic);
    return;
  }

  const ctx: Ctx = makeCtx(parseArgs(argv, flagsFor(topic, sub)));

  switch (topic) {
    case "devices":
      switch (sub) {
        case "connect":
          return devicesConnect(ctx);
        case "disconnect":
          return devicesDisconnect(ctx);
        case "status":
          return devicesStatus(ctx);
        case "list":
          return devicesList(ctx);
        default:
          throw new UsageError(`unknown devices command "${sub}"`, `Valid: connect, disconnect, status, list. ${usageLine("devices")}`);
      }
    case "spaces":
      switch (sub) {
        case "create":
          return spacesCreate(ctx, VERSION);
        case "start":
          return spacesStart(ctx);
        case "stop":
          return spacesStop(ctx);
        case "delete":
          return spacesDelete(ctx);
        case "list":
          return spacesList(ctx);
        case "logs":
          return spacesLogs(ctx);
        default:
          throw new UsageError(`unknown spaces command "${sub}"`, `Valid: create, start, stop, delete, list, logs. ${usageLine("spaces")}`);
      }
    case "files":
      switch (sub) {
        case "list":
          return filesList(ctx);
        case "upload":
          return filesUpload(ctx);
        case "download":
          return filesDownload(ctx);
        default:
          throw new UsageError(`unknown files command "${sub}"`, `Valid: list, upload, download. ${usageLine("files")}`);
      }
    case "tools":
      switch (sub) {
        case "list":
          return toolsList(ctx);
        case "view":
          return toolsView(ctx);
        case "call":
          return toolsCall(ctx);
        default:
          throw new UsageError(`unknown tools command "${sub}"`, `Valid: list, view, call. ${usageLine("tools")}`);
      }
    case "connect": {
      const dashdash = argv.indexOf("--");
      return connectCommand(ctx, dashdash === -1 ? [] : argv.slice(dashdash + 1));
    }
    case "serve":
      return serveCommand(ctx, VERSION);
    case "update": {
      const outcome = await runUpdate(VERSION, {
        check: bool(ctx.parsed, "check"),
        force: bool(ctx.parsed, "force"),
        version: str(ctx.parsed, "release-version"),
        to: str(ctx.parsed, "to"),
      });
      if (ctx.json) process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
      else process.stdout.write(`${renderUpdate(outcome)}\n`);
      return;
    }
    default:
      throw new UsageError(`unknown command "${topic}"`, TOPIC_HINT);
  }
}

function flagsFor(topic: string, sub: string | undefined): FlagSpec[] {
  if (topic === "devices") {
    if (sub === "connect") return CONNECT_FLAGS;
    if (sub === "list") return LIST_FLAGS;
    if (sub === "status" || sub === "disconnect") return GATEWAY_FLAGS;
    return [];
  }
  if (topic === "tools") {
    if (sub === "list") return TOOL_FLAGS;
    if (sub === "view") return VIEW_FLAGS;
    if (sub === "call") return CALL_FLAGS;
    return [];
  }
  if (topic === "spaces") {
    if (sub === "create") return SPACE_CREATE_FLAGS;
    if (sub === "list") return SPACE_LIST_FLAGS;
    if (isSpaceCommand(sub)) return SPACE_LIFECYCLE_FLAGS;
    return [];
  }
  if (topic === "files") {
    if (sub === "list") return FILES_LIST_FLAGS;
    if (sub === "upload") return FILES_UPLOAD_FLAGS;
    if (sub === "download") return FILES_DOWNLOAD_FLAGS;
    return [];
  }
  if (topic === "update") return UPDATE_FLAGS;
  if (topic === "connect") return ANON_CONNECT_FLAGS;
  if (topic === "serve") return SERVE_FLAGS;
  return [];
}

function reportError(err: unknown, jsonWanted: boolean): void {
  const code = exitCodeOf(err);
  const message = err instanceof Error ? err.message : String(err);
  const hint = hintOf(err);
  if (jsonWanted) {
    process.stdout.write(`${JSON.stringify({ error: { message, ...(hint ? { hint } : {}), exit_code: code } }, null, 2)}\n`);
  } else {
    process.stderr.write(`${red("prime:")} ${message}\n`);
    if (hint) process.stderr.write(`${dim(`  ${hint}`)}\n`);
  }
  process.exitCode = code;
}

// `prime tools list | head` closes the pipe early; that is not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
  });
}

const argv = process.argv.slice(2);
removeStaleWindowsBinary();
initColor(argv.includes("--no-color") ? false : undefined);

// Deliberately not top-level `await`: `bun build --compile --bytecode` (CommonJS
// output) rejects a module with top-level await - the build now uses ESM bytecode
// because the bundled code-mcp needs it, but keeping the entry TLA-free costs
// nothing, and bytecode cuts cold start by ~30-40%. A
// floating async IIFE keeps the same semantics - the pending request (or the
// microtask chain itself) keeps the process alive, and `process.exitCode` set
// in reportError is honoured on exit.
let settled = false;
void (async () => {
  try {
    await main(argv);
  } catch (err) {
    reportError(err, argv.includes("--json"));
  } finally {
    settled = true;
  }
})();

// If the event loop empties while a command is still awaiting something that
// can never settle, Bun exits 0 with nothing printed - a silent "success" for a
// command that never ran (seen with stdin on Windows). Make that loud instead.
process.on("beforeExit", () => {
  if (settled) return;
  settled = true;
  reportError(new Error("internal error: the command stopped before finishing (an input it was waiting for never arrived)"), argv.includes("--json"));
  process.exitCode = 1;
});
