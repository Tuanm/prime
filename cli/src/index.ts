#!/usr/bin/env bun
// mcp - command line client for code-mcp-gateway.
//
// Command surface:
//   mcp devices connect|disconnect|status|list
//   mcp tools   list|view|call
//   mcp help [topic]
//
// Aliases: `mcp` (bare) shows help; `mcp call ...` === `mcp tools call ...`.

import { flag, parseArgs, type FlagSpec } from "./args.ts";
import { type Ctx, makeCtx } from "./context.ts";
import { devicesConnect, devicesDisconnect, devicesList, devicesStatus } from "./devices.ts";
import { EXIT, exitCodeOf, hintOf, UsageError } from "./errors.ts";
import { TOPIC_HINT, helpFor, rootHelp, usageLine } from "./help.ts";
import { dim, initColor, red } from "./output.ts";
import { toolsCall, toolsList, toolsView } from "./tools.ts";

const VERSION = "0.1.0";

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
  flag("parallel", "boolean", "Run multiple calls concurrently (default: sequential)"),
  flag("device", "string", "Force the device id for an ambiguous label", { placeholder: "<id>" }),
  flag("tool", "string", "Force the tool name for an ambiguous label", { placeholder: "<name>" }),
];

const VIEW_FLAGS: FlagSpec[] = [...TOOL_FLAGS, flag("device", "string", "Force the device id", { placeholder: "<id>" }), flag("tool", "string", "Force the tool name", { placeholder: "<name>" })];

// ---- help ------------------------------------------------------------------

function showHelp(text: string | undefined, topic: string, sub?: string): void {
  if (text) {
    process.stdout.write(`${text.trimEnd()}\n`);
    return;
  }
  process.stderr.write(`${red("mcp:")} unknown command "${[topic, sub].filter(Boolean).join(" ")}"\n`);
  process.stderr.write(`${TOPIC_HINT}\n`);
  process.exitCode = EXIT.USAGE;
}

// ---- main ------------------------------------------------------------------

async function main(argv: string[]): Promise<void> {
  if (argv.length === 0) {
    process.stdout.write(rootHelp().trimEnd() + "\n");
    return;
  }
  if (argv[0] === "--version" || argv[0] === "version") {
    process.stdout.write(`mcp ${VERSION}\n`);
    return;
  }

  // `mcp call ...` is an alias for `mcp tools call ...`.
  if (argv[0] === "call") argv = ["tools", "call", ...argv.slice(1)];

  const topic = argv[0]!;
  const rest = argv.slice(1);

  if (topic === "--help" || topic === "-h" || topic === "help") {
    const wanted = topic === "help" ? rest : [];
    showHelp(helpFor(wanted[0], wanted[1]), wanted[0] ?? "help", wanted[1]);
    return;
  }

  const sub = rest[0];
  const wantHelp = rest.includes("--help") || rest.includes("-h") || sub === undefined;

  if (topic === "devices" || topic === "tools") {
    if (wantHelp) {
      showHelp(helpFor(topic, sub), topic, sub);
      return;
    }
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
  return [];
}

function reportError(err: unknown, jsonWanted: boolean): void {
  const code = exitCodeOf(err);
  const message = err instanceof Error ? err.message : String(err);
  const hint = hintOf(err);
  if (jsonWanted) {
    process.stdout.write(`${JSON.stringify({ error: { message, ...(hint ? { hint } : {}), exit_code: code } }, null, 2)}\n`);
  } else {
    process.stderr.write(`${red("mcp:")} ${message}\n`);
    if (hint) process.stderr.write(`${dim(`  ${hint}`)}\n`);
  }
  process.exitCode = code;
}

// `mcp tools list | head` closes the pipe early; that is not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
  });
}

const argv = process.argv.slice(2);
initColor(argv.includes("--no-color") ? false : undefined);

try {
  await main(argv);
} catch (err) {
  reportError(err, argv.includes("--json"));
}
