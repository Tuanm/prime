// End-to-end test: a real local gateway (wrangler dev) + mock devices, driven by
// the COMPILED mcp binary. Run: bun test/e2e.ts
//
// This is the test that proves the CLI works against the real gateway protocol:
// auth on both credentials, the tunnel relay, JSON-RPC error mapping, and every
// documented input form.

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const REPO = join(ROOT, "..");
const WRANGLER = join(REPO, "worker", "node_modules", ".bin", "wrangler");
const PORT = 8811;
const BASE = `http://127.0.0.1:${PORT}`;
const GATEWAY_TOKEN = "gw-e2e-secret";
const DEVICE_TOKEN = "dev-e2e-secret";
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "mcp-e2e-"));
const CONFIG = join(CONFIG_DIR, "config.yaml");
const BIN = join(ROOT, "dist", "mcp-e2e");

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string): void {
  pass++;
  console.log(`PASS ${name}`);
}
function bad(name: string, why: string): void {
  fail++;
  failures.push(`${name}: ${why}`);
  console.log(`FAIL ${name}: ${why}`);
}
function check(name: string, condition: boolean, why = ""): void {
  if (condition) ok(name);
  else bad(name, why || "assertion failed");
}

interface RunResult {
  code: number;
  out: string;
  err: string;
  ms: number;
}

const BUNDLE = join(ROOT, "dist", "mcp.js");

async function cli(
  args: string[],
  opts: { stdin?: string; env?: Record<string, string>; via?: "binary" | "bundle" } = {},
): Promise<RunResult> {
  const started = performance.now();
  const command = opts.via === "bundle" ? ["bun", BUNDLE, ...args] : [BIN, ...args];
  const proc = Bun.spawn(command, {
    env: { ...process.env, CODE_MCP_GATEWAY_CONFIG: CONFIG, NO_COLOR: "1", ...(opts.env ?? {}) },
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, out, err, ms: Math.round(performance.now() - started) };
}

// ---- mock device -----------------------------------------------------------

/** Per-device call log, so ordering (sequential vs parallel) is verifiable. */
const callLogs: Record<string, string[]> = {};

const TOOLS = [
  {
    name: "echo",
    description: "Echo the given text back",
    inputSchema: { type: "object", properties: { text: { type: "string", description: "Text to echo" } }, required: ["text"] },
  },
  { name: "boom", description: "Always returns an error result", inputSchema: { type: "object", properties: {} } },
  { name: "slow", description: "Sleeps for ms then returns", inputSchema: { type: "object", properties: { ms: { type: "number" } } } },
  { name: "state", description: "Reports the order of calls", inputSchema: { type: "object", properties: {} } },
  { name: "file.read", description: "A tool whose name contains a dot", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "args", description: "Echo the arguments back as JSON", inputSchema: { type: "object", properties: {} } },
];

function startMockDevice(deviceId: string, token: string): Promise<WebSocket> {
  callLogs[deviceId] = [];
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${deviceId}?token=${token}`);
    const timer = setTimeout(() => reject(new Error("mock device connect timeout")), 20_000);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "register", deviceId }));
    });
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String((event as MessageEvent).data)) as {
        type?: string;
        id?: string;
        request?: { id: number; method: string; params?: Record<string, unknown> };
      };
      if (msg.type === "registered") {
        clearTimeout(timer);
        resolve(ws);
        return;
      }
      if (!msg.id || !msg.request) return;
      const reply = (response: unknown) => ws.send(JSON.stringify({ id: msg.id, response }));
      const { request } = msg;
      const rpcOk = (result: unknown) => reply({ jsonrpc: "2.0", id: request.id, result });
      const rpcErr = (code: number, message: string) => reply({ jsonrpc: "2.0", id: request.id, error: { code, message } });

      switch (request.method) {
        case "initialize":
          return rpcOk({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: deviceId, version: "1.0.0" } });
        case "notifications/initialized":
          return reply({}); // bare {} = notification ack (gateway answers 204)
        case "ping":
          return rpcOk({});
        case "tools/list":
          return rpcOk({ tools: TOOLS });
        case "tools/call": {
          const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
          const name = String(params.name ?? "");
          const args = params.arguments ?? {};
          callLogs[deviceId]!.push(`${name}:${JSON.stringify(args)}`);
          switch (name) {
            case "echo":
              return rpcOk({ content: [{ type: "text", text: `echo:${String(args.text ?? "")}` }] });
            case "boom":
              return rpcOk({ content: [{ type: "text", text: "boom failed on purpose" }], isError: true });
            case "slow": {
              const wait = Number(args.ms ?? 1000);
              setTimeout(() => rpcOk({ content: [{ type: "text", text: `slept:${wait}` }] }), wait);
              return;
            }
            case "state":
              return rpcOk({ content: [{ type: "text", text: JSON.stringify(callLogs[deviceId]!) }] });
            case "file.read":
              return rpcOk({ content: [{ type: "text", text: `read:${String(args.path ?? "")}` }] });
            case "args":
              return rpcOk({ content: [{ type: "text", text: JSON.stringify(args) }] });
            default:
              return rpcErr(-32602, `unknown tool: ${name}`);
          }
        }
        default:
          return rpcErr(-32601, `unknown method: ${request.method}`);
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`mock device ${deviceId} websocket error`));
    });
  });
}

// ---- gateway ---------------------------------------------------------------

async function startGateway(): Promise<{ kill: () => void }> {
  rmSync(join(REPO, "worker", ".wrangler", `state-${PORT}`), { recursive: true, force: true });
  const proc = spawn(
    "node",
    [
      WRANGLER, "dev", "--local",
      "-c", join(REPO, "worker", "wrangler.dev.toml"),
      "--port", String(PORT), "--ip", "127.0.0.1",
      "--persist-to", join(REPO, "worker", ".wrangler", `state-${PORT}`),
      "--var", `GATEWAY_TOKEN:${GATEWAY_TOKEN}`,
      "--var", `DEVICE_TOKEN:${DEVICE_TOKEN}`,
      "--var", "ADMIN_TOKEN:admin-e2e",
      "--var", "TIMEOUT_MS:30000",
      "--var", "KEEPALIVE_TIMEOUT_MS:20000",
    ],
    { cwd: join(REPO, "worker"), stdio: ["ignore", "pipe", "pipe"] },
  );
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch(`${BASE}/mcp/probe-device`);
      if ([200, 400, 401, 404, 405, 503].includes(r.status)) return { kill: () => proc.kill() };
    } catch {}
    await Bun.sleep(250);
  }
  proc.kill();
  throw new Error("wrangler did not become ready");
}

// ---- run -------------------------------------------------------------------

console.log("Building the host binary...");
// Same flags as scripts/build.ts: the suite must test what ships.
const build = Bun.spawnSync(["bun", "build", "--compile", "--minify", "--bytecode", "--outfile", BIN, join(ROOT, "src", "index.ts")], {
  cwd: ROOT,
  stdout: "pipe",
  stderr: "pipe",
});
if (build.exitCode !== 0) {
  console.error(build.stderr.toString());
  process.exit(1);
}
console.log(`binary: ${(statSync(BIN).size / 1024 / 1024).toFixed(1)} MB`);

// The JS bundle is a second, independently built artifact. Building it must
// prove it runs, not merely that it bytes-out: a duplicate shebang makes
// `bun dist/mcp.js` exit 1 before executing anything, which a timing-only or
// size-only check happily misses.
console.log("Building the JS bundle...");
const bundleBuild = Bun.spawnSync(["bun", join(ROOT, "scripts", "build.ts"), "--bundle-only"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
check(
  "bundle builds and self-checks",
  bundleBuild.exitCode === 0 && bundleBuild.stdout.toString().includes("runs: mcp "),
  `exit=${bundleBuild.exitCode} ${bundleBuild.stdout.toString().trim()} ${bundleBuild.stderr.toString().trim().slice(0, 200)}`,
);

console.log(`Starting wrangler on ${PORT}...`);
const gateway = await startGateway();
console.log("Connecting mock devices...");
const alpha = await startMockDevice("alpha", DEVICE_TOKEN);
const dotted = await startMockDevice("alpha.v2", DEVICE_TOKEN);

try {
  // ---- help / aliases ------------------------------------------------------
  const bare = await cli([]);
  check("bare 'mcp' prints help", bare.code === 0 && bare.out.includes("USAGE"), `code=${bare.code}`);

  const version = await cli(["--version"]);
  check("--version", /^mcp \d+\.\d+\.\d+/.test(version.out.trim()), version.out.trim());

  const helpRoot = await cli(["--help"]);
  check("--help lists commands", helpRoot.out.includes("devices connect") && helpRoot.out.includes("tools call"));

  const helpDevices = await cli(["devices", "--help"]);
  check("devices --help", helpDevices.code === 0 && helpDevices.out.includes("mcp devices connect"));

  const helpToolsList = await cli(["tools", "list", "--help"]);
  check("tools list --help", helpToolsList.code === 0 && helpToolsList.out.includes("mcp tools list <device-id>"));

  const helpHelp = await cli(["help", "tools"]);
  check("mcp help tools", helpHelp.code === 0 && helpHelp.out.includes("mcp tools call"));

  const unknown = await cli(["frobnicate"]);
  check("unknown command exits 2", unknown.code === 2 && unknown.err.includes("unknown command"));

  // ---- devices connect -----------------------------------------------------
  const connect = await cli(["devices", "connect", "alpha", "--token", DEVICE_TOKEN, "--gateway", BASE, "--gateway-token", GATEWAY_TOKEN, "--set-default"]);
  check("devices connect reports online", connect.code === 0 && connect.out.includes("online"), `code=${connect.code} out=${connect.out}`);

  const configText = readFileSync(CONFIG, "utf8");
  check("config file written with the device", configText.includes("alpha:") && configText.includes(GATEWAY_TOKEN));
  check("config file is 0600", (statSync(CONFIG).mode & 0o777) === 0o600, (statSync(CONFIG).mode & 0o777).toString(8));

  const reconnect = await cli(["devices", "connect", "alpha"]);
  check("reconnect with no flags uses stored defaults", reconnect.code === 0 && reconnect.out.includes("online"), `code=${reconnect.code}`);

  const connectDotted = await cli(["devices", "connect", "alpha.v2", "--no-verify"]);
  check("connect --no-verify skips the probe", connectDotted.code === 0 && !connectDotted.out.includes("status"));

  const connectOffline = await cli(["devices", "connect", "ghost", "--no-verify"]);
  check("connect an unused id succeeds offline", connectOffline.code === 0);

  // ---- devices status / list ----------------------------------------------
  const status = await cli(["devices", "status", "alpha"]);
  check("devices status online", status.code === 0 && status.out.includes("online"), `code=${status.code} err=${status.err}`);

  const statusJson = await cli(["devices", "status", "alpha", "--json"]);
  const statusObj = JSON.parse(statusJson.out) as { online: boolean; latency_ms: number; gateway: string };
  check("devices status --json", statusJson.code === 0 && statusObj.online === true && statusObj.gateway === BASE, statusJson.out.trim());

  const statusOffline = await cli(["devices", "status", "ghost"]);
  check("devices status offline exits 4", statusOffline.code === 4, `code=${statusOffline.code} err=${statusOffline.err}`);

  const statusBadToken = await cli(["devices", "status", "alpha", "--gateway-token", "wrong"]);
  check("wrong gateway token exits 3", statusBadToken.code === 3, `code=${statusBadToken.code} err=${statusBadToken.err}`);

  const list = await cli(["devices", "list"]);
  check("devices list shows online + offline", list.code === 0 && list.out.includes("alpha") && list.out.includes("online") && list.out.includes("offline"), list.out);

  const listNoProbe = await cli(["devices", "list", "--no-probe"]);
  check("devices list --no-probe", listNoProbe.code === 0 && listNoProbe.out.includes("unknown"));

  const listJson = JSON.parse((await cli(["devices", "list", "--json"])).out) as { devices: { device: string; online: boolean }[] };
  check("devices list --json has entries", listJson.devices.length >= 3 && listJson.devices.some((d) => d.device === "alpha" && d.online));

  // ---- tools list / view ---------------------------------------------------
  const list2 = await cli(["tools", "list", "alpha"]);
  check("tools list shows tools", list2.code === 0 && list2.out.includes("echo") && list2.out.includes("boom"), list2.out);

  const toolsJson = JSON.parse((await cli(["tools", "list", "alpha", "--json"])).out) as { count: number; tools: { name: string }[] };
  check(
    "tools list --json count",
    toolsJson.count === TOOLS.length && toolsJson.tools.some((t) => t.name === "file.read") && toolsJson.tools.some((t) => t.name === "args"),
    `count=${toolsJson.count} expected=${TOOLS.length}`,
  );

  const view = await cli(["tools", "view", "alpha.echo"]);
  check("tools view shows schema and example", view.code === 0 && view.out.includes("Text to echo") && view.out.includes("mcp tools call alpha.echo"), view.out);

  const viewDottedTool = await cli(["tools", "view", "alpha.file.read"]);
  check(
    "tool names may contain dots",
    viewDottedTool.code === 0 && viewDottedTool.out.includes("file.read") && viewDottedTool.out.includes("(alpha)"),
    viewDottedTool.out,
  );

  const viewDottedDevice = await cli(["tools", "view", "alpha.v2.echo"]);
  check("dotted device id resolves by longest prefix", viewDottedDevice.code === 0 && viewDottedDevice.out.includes("alpha.v2"), viewDottedDevice.err);

  const viewMissing = await cli(["tools", "view", "alpha.nope"]);
  check("unknown tool exits 2 with a suggestion", viewMissing.code === 2 && viewMissing.err.includes("Did you mean"), viewMissing.err);

  // ---- tools call ----------------------------------------------------------
  const call = await cli(["tools", "call", "alpha.echo", '{"text":"inline"}']);
  check("inline call", call.code === 0 && call.out.includes("echo:inline"), `code=${call.code} out=${call.out} err=${call.err}`);

  const callNoArgs = await cli(["tools", "call", "alpha.state"]);
  check("single label without args calls with {}", callNoArgs.code === 0, callNoArgs.err);

  const callError = await cli(["tools", "call", "alpha.boom", "{}"]);
  check("isError result exits 1", callError.code === 1 && callError.out.includes("boom failed on purpose"), `code=${callError.code} out=${callError.out}`);

  const callRpcError = await cli(["tools", "call", "alpha.unknown.tool", "{}"]);
  check("unknown tool call exits 1", callRpcError.code === 1, `code=${callRpcError.code}`);

  const callJson = await cli(["tools", "call", "alpha.echo", '{"text":"j"}', "--json"]);
  check("--json returns the raw result", (JSON.parse(callJson.out) as { content: { text: string }[] }).content[0]!.text === "echo:j", callJson.out);

  // stdin: single object
  const stdinSingle = await cli(["tools", "call"], { stdin: JSON.stringify({ name: "alpha.echo", arguments: { text: "stdin1" } }) });
  check("stdin single object", stdinSingle.code === 0 && stdinSingle.out.includes("echo:stdin1"), `code=${stdinSingle.code} err=${stdinSingle.err}`);

  // stdin: array of calls, order preserved
  const batch = [
    { id: 1, name: "alpha.echo", arguments: { text: "first" } },
    { id: 2, name: "alpha.echo", arguments: { text: "second" } },
    { id: 3, name: "alpha.file.read", arguments: { path: "/tmp/x" } },
  ];
  const stdinBatch = await cli(["tools", "call"], { stdin: JSON.stringify(batch) });
  const positions = ["first", "second", "read:/tmp/x"].map((needle) => stdinBatch.out.indexOf(needle));
  const batchOrder = positions.every((position, index) => position > -1 && (index === 0 || position > positions[index - 1]!));
  check("stdin array keeps id order", stdinBatch.code === 0 && batchOrder, stdinBatch.out);

  const stdinBatchJson = JSON.parse((await cli(["tools", "call", "--json"], { stdin: JSON.stringify(batch) })).out) as { id: number; ok: boolean }[];
  check("stdin array --json returns ids and ok flags", stdinBatchJson.length === 3 && stdinBatchJson[0]!.id === 1 && stdinBatchJson.every((r) => r.ok));

  // stdin: malformed
  const stdinBad = await cli(["tools", "call"], { stdin: "{not json" });
  check("malformed stdin exits 2", stdinBad.code === 2 && stdinBad.err.includes("not valid JSON"));

  const stdinNoName = await cli(["tools", "call"], { stdin: JSON.stringify({ arguments: {} }) });
  check("stdin without name exits 2", stdinNoName.code === 2 && stdinNoName.err.includes('"name"'));

  // positional pairs
  const paired = await cli(["tools", "call", "alpha.echo", '{"text":"p1"}', "alpha.echo", '{"text":"p2"}']);
  check("paired positional calls", paired.code === 0 && paired.out.includes("p1") && paired.out.includes("p2"), paired.out);

  const odd = await cli(["tools", "call", "alpha.echo", '{"text":"x"}', "alpha.echo"]);
  check("odd argument count exits 2", odd.code === 2 && odd.err.includes("pairs"), odd.err);

  const badJson = await cli(["tools", "call", "alpha.echo", "{oops}"]);
  check("invalid inline JSON exits 2", badJson.code === 2 && badJson.err.includes("not valid JSON"));

  // cross-device batch
  const crossDevice = await cli(["tools", "call", "alpha.echo", '{"text":"A"}', "alpha.v2.echo", '{"text":"B"}']);
  check("cross-device batch", crossDevice.code === 0 && crossDevice.out.includes("echo:A") && crossDevice.out.includes("echo:B"), crossDevice.out);

  // alias
  const alias = await cli(["call", "alpha.echo", '{"text":"aliased"}']);
  check("'mcp call' aliases 'mcp tools call'", alias.code === 0 && alias.out.includes("echo:aliased"), alias.err);

  // separators and ordering
  callLogs["alpha"]!.length = 0;
  await cli(["tools", "call", "alpha.echo", '{"text":"1"}', "alpha.echo", '{"text":"2"}', "alpha.echo", '{"text":"3"}']);
  check("sequential call order is preserved", callLogs["alpha"]!.join(",") === 'echo:{"text":"1"},echo:{"text":"2"},echo:{"text":"3"}', callLogs["alpha"]!.join(","));

  // parallel actually overlaps
  const parallelStart = performance.now();
  const parallelResult = await cli(["tools", "call", "--parallel", "alpha.slow", '{"ms":600}', "alpha.slow", '{"ms":600}']);
  const parallelMs = Math.round(performance.now() - parallelStart);
  const serialStart = performance.now();
  await cli(["tools", "call", "alpha.slow", '{"ms":600}', "alpha.slow", '{"ms":600}']);
  const serialMs = Math.round(performance.now() - serialStart);
  check("--parallel overlaps (faster than sequential)", parallelResult.code === 0 && parallelMs + 100 < serialMs, `parallel=${parallelMs}ms serial=${serialMs}ms`);

  // timeout
  const timeout = await cli(["tools", "call", "alpha.slow", '{"ms":5000}', "--timeout", "400"]);
  check("--timeout exits 5", timeout.code === 5, `code=${timeout.code} err=${timeout.err}`);

  // A batch must not abort on the first failure: every outcome is still reported.
  const batchWithFailure = await cli(["tools", "call", "alpha.echo", '{"text":"ok1"}', "alpha.slow", '{"ms":5000}', "alpha.echo", '{"text":"ok2"}', "--timeout", "500"]);
  check(
    "a failing call in a batch still reports the others",
    batchWithFailure.code === 1 && batchWithFailure.out.includes("ok1") && batchWithFailure.out.includes("ok2") && batchWithFailure.out.includes("timed out"),
    `code=${batchWithFailure.code} out=${batchWithFailure.out}`,
  );

  // offline device
  const offline = await cli(["tools", "list", "ghost"]);
  check("offline device exits 4", offline.code === 4 && offline.err.includes("offline"), `code=${offline.code} err=${offline.err}`);

  const offlineJson = await cli(["tools", "list", "ghost", "--json"]);
  const offlineObj = JSON.parse(offlineJson.out) as { error: { message: string; exit_code: number } };
  check("--json errors are machine readable", offlineJson.code === 4 && offlineObj.error.exit_code === 4, offlineJson.out);

  // handshake modes
  const handshakeAlways = await cli(["tools", "call", "alpha.echo", '{"text":"hs"}', "--handshake", "always"]);
  check("--handshake always works", handshakeAlways.code === 0 && handshakeAlways.out.includes("echo:hs"), handshakeAlways.err);
  const handshakeBad = await cli(["tools", "list", "alpha", "--handshake", "sometimes"]);
  check("invalid --handshake exits 2", handshakeBad.code === 2 && handshakeBad.err.includes("auto, always, never"));

  // env-var configuration
  const envRun = await cli(["tools", "list", "alpha"], {
    env: { CODE_MCP_GATEWAY_URL: BASE, CODE_MCP_GATEWAY_TOKEN: GATEWAY_TOKEN, CODE_MCP_GATEWAY_DEVICE_TOKEN: DEVICE_TOKEN, CODE_MCP_GATEWAY_CONFIG: join(CONFIG_DIR, "absent.yaml") },
  });
  check("env-only configuration works", envRun.code === 0 && envRun.out.includes("echo"), `code=${envRun.code} err=${envRun.err}`);

  // ---- disconnect ----------------------------------------------------------
  const disconnect = await cli(["devices", "disconnect", "ghost"]);
  check("disconnect removes the entry", disconnect.code === 0 && !readFileSync(CONFIG, "utf8").includes("ghost"));
  const disconnectAgain = await cli(["devices", "disconnect", "ghost"]);
  check("disconnect is idempotent", disconnectAgain.code === 0 && disconnectAgain.out.includes("not configured"));

  // ---- cross-platform input forms ------------------------------------------
  // Windows has no 'cat' and cmd.exe has no single-quote syntax, so file and
  // key/value input must work without any shell help.
  const callDir = mkdtempSync(join(tmpdir(), "mcp-calls-"));
  const writeSpec = (name: string, content: string): string => {
    const path = join(callDir, name);
    writeFileSync(path, content);
    return path;
  };
  const singleFile = writeSpec("call.json", JSON.stringify({ name: "alpha.echo", arguments: { text: "from-file" } }));
  const batchFile = writeSpec(
    "calls.json",
    JSON.stringify([
      { id: 7, name: "alpha.echo", arguments: { text: "file-1" } },
      { id: 8, name: "alpha.v2.echo", arguments: { text: "file-2" } },
    ]),
  );
  const extraFileA = writeSpec("a.json", JSON.stringify({ name: "alpha.echo", arguments: { text: "merge-a" } }));
  const extraFileB = writeSpec("b.json", JSON.stringify({ name: "alpha.echo", arguments: { text: "merge-b" } }));

  const byFile = await cli(["tools", "call", "--file", singleFile]);
  check("--file reads a single call", byFile.code === 0 && byFile.out.includes("echo:from-file"), `code=${byFile.code} err=${byFile.err}`);

  const byShortFlag = await cli(["tools", "call", "-f", singleFile]);
  check("-f short form", byShortFlag.code === 0 && byShortFlag.out.includes("echo:from-file"), byShortFlag.err);

  const byBatchFile = await cli(["tools", "call", "--file", batchFile]);
  check(
    "--file reads an array and keeps its ids/order",
    byBatchFile.code === 0 && byBatchFile.out.includes("[7]") && byBatchFile.out.includes("[8]") &&
      byBatchFile.out.indexOf("file-1") < byBatchFile.out.indexOf("file-2"),
    byBatchFile.out,
  );

  const mergedFiles = await cli(["tools", "call", "--file", extraFileA, "--file", extraFileB]);
  check(
    "repeated --file merges both specifications",
    mergedFiles.code === 0 && mergedFiles.out.includes("merge-a") && mergedFiles.out.includes("merge-b") &&
      mergedFiles.out.includes("[1]") && mergedFiles.out.includes("[2]"),
    mergedFiles.out,
  );

  const fileFromStdin = await cli(["tools", "call", "--file", "-"], { stdin: readFileSync(singleFile, "utf8") });
  check("--file - reads stdin", fileFromStdin.code === 0 && fileFromStdin.out.includes("echo:from-file"), fileFromStdin.err);

  const atFile = await cli(["tools", "call", "@" + singleFile]);
  check("@file positional", atFile.code === 0 && atFile.out.includes("echo:from-file"), atFile.err);

  const atFiles = await cli(["tools", "call", "@" + extraFileA, "@" + extraFileB]);
  check("@a @b merges", atFiles.code === 0 && atFiles.out.includes("merge-a") && atFiles.out.includes("merge-b"), atFiles.out);

  const mixed = await cli(["tools", "call", "@" + singleFile, "alpha.echo", '{"text":"x"}']);
  check("@file mixed with inline exits 2", mixed.code === 2 && mixed.err.includes("cannot be mixed"), mixed.err);

  const fileAndPositional = await cli(["tools", "call", "--file", singleFile, "alpha.echo", "{}"]);
  check("--file with positionals exits 2", fileAndPositional.code === 2 && fileAndPositional.err.includes("cannot be combined"), fileAndPositional.err);

  const missingFile = await cli(["tools", "call", "--file", join(callDir, "nope.json")]);
  check("missing --file exits 2 with the path", missingFile.code === 2 && missingFile.err.includes("nope.json"), missingFile.err);

  const bomFile = writeSpec("bom.json", "\uFEFF" + JSON.stringify({ name: "alpha.echo", arguments: { text: "bom" } }));
  const bom = await cli(["tools", "call", "--file", bomFile]);
  check("UTF-8 BOM is tolerated (Windows editors add one)", bom.code === 0 && bom.out.includes("echo:bom"), `code=${bom.code} err=${bom.err}`);

  const crlfFile = writeSpec("crlf.json", JSON.stringify({ name: "alpha.echo", arguments: { text: "crlf" } }).replace(/\}/g, "}\r\n"));
  const crlf = await cli(["tools", "call", "--file", crlfFile]);
  check("CRLF line endings are tolerated", crlf.code === 0 && crlf.out.includes("echo:crlf"), `code=${crlf.code} err=${crlf.err}`);

  const emptyFile = writeSpec("empty.json", "   \n");
  const empty = await cli(["tools", "call", "--file", emptyFile]);
  check("empty specification exits 2", empty.code === 2 && empty.err.includes("empty"), empty.err);

  const explicitStdin = await cli(["tools", "call", "--stdin"], { stdin: readFileSync(singleFile, "utf8") });
  check("--stdin reads the specification", explicitStdin.code === 0 && explicitStdin.out.includes("echo:from-file"), explicitStdin.err);

  // ---- quote-free arguments (--arg) -----------------------------------------
  const argScalars = await cli(["tools", "call", "alpha.args", "--arg", "n=5", "--arg", "b=true", "--arg", "s=hello", "--arg", "nil=null", "--arg", "arr=[1,2]"]);
  check(
    "--arg builds and types arguments without JSON quoting",
    argScalars.code === 0 && argScalars.out.trim() === '{"n":5,"b":true,"s":"hello","nil":null,"arr":[1,2]}',
    argScalars.out.trim(),
  );

  const argNumbers = await cli(["tools", "call", "alpha.args", "--arg", "n=007", "--arg", "s=#submit"]);
  check(
    "--arg keeps non-JSON values as strings",
    argNumbers.code === 0 && argNumbers.out.trim() === '{"n":7,"s":"#submit"}',
    argNumbers.out.trim(),
  );

  const argTwoCalls = await cli(["tools", "call", "alpha.echo", "{}", "alpha.v2.echo", "{}", "--arg", "a=1"]);
  check("--arg with two references exits 2", argTwoCalls.code === 2 && argTwoCalls.err.includes("exactly one"), argTwoCalls.err);

  // Two bare labels are a label/arguments pair, so the second one must be JSON.
  const twoBareLabels = await cli(["tools", "call", "alpha.echo", "alpha.echo", "--arg", "a=1"]);
  check("two bare labels exit 2 explaining they are a label/JSON pair", twoBareLabels.code === 2 && twoBareLabels.err.includes("not valid JSON"), twoBareLabels.err);

  const argWithJson = await cli(["tools", "call", "alpha.echo", '{"text":"x"}', "--arg", "a=1"]);
  check("--arg with inline JSON exits 2", argWithJson.code === 2 && argWithJson.err.includes("cannot be combined"), argWithJson.err);

  const argNoEquals = await cli(["tools", "call", "alpha.echo", "--arg", "broken"]);
  check("--arg without '=' exits 2", argNoEquals.code === 2 && argNoEquals.err.includes("invalid --arg") && argNoEquals.err.includes("name>=<value>"), argNoEquals.err);

  const argNoLabel = await cli(["tools", "call", "--arg", "a=1"]);
  check("--arg without a reference exits 2", argNoLabel.code === 2 && argNoLabel.err.includes("requires a tool reference"), argNoLabel.err);

  const argWithFile = await cli(["tools", "call", "@" + singleFile, "--arg", "a=1"]);
  check("--arg with @file exits 2", argWithFile.code === 2 && argWithFile.err.includes("cannot be combined"), argWithFile.err);

  // ---- failure isolation ----------------------------------------------------
  const parallelFailure = await cli([
    "tools", "call", "--parallel",
    "alpha.slow", '{"ms":400}',
    "alpha.boom", "{}",
    "alpha.slow", '{"ms":400}',
  ]);
  check(
    "parallel: a failing call does not cancel its siblings",
    parallelFailure.code === 1 &&
      (parallelFailure.out.match(/slept:400/g) ?? []).length === 2 &&
      parallelFailure.out.includes("boom failed on purpose"),
    `code=${parallelFailure.code} out=${parallelFailure.out}`,
  );

  const parallelTransportFailure = await cli([
    "tools", "call", "--parallel", "--timeout", "400",
    "alpha.echo", '{"text":"before"}',
    "alpha.slow", '{"ms":5000}',
    "alpha.echo", '{"text":"after"}',
  ]);
  check(
    "parallel: a timeout does not cancel its siblings",
    parallelTransportFailure.code === 1 &&
      parallelTransportFailure.out.includes("before") &&
      parallelTransportFailure.out.includes("after") &&
      parallelTransportFailure.out.includes("timed out"),
    `code=${parallelTransportFailure.code} out=${parallelTransportFailure.out}`,
  );

  rmSync(callDir, { recursive: true, force: true });

  // ---- a larger parallel batch (exercises the worker pool end to end) ----
  const BIG = 24;
  const bigArgs = ["tools", "call", "--parallel", "--concurrency", "4"];
  for (let i = 0; i < BIG; i++) bigArgs.push("alpha.echo", JSON.stringify({ text: `n${i}` }));
  const big = await cli(bigArgs);
  const bigResults = (big.out.match(/echo:n\d+/g) ?? []).length;
  const bigOrdered = Array.from({ length: BIG }, (_, i) => big.out.indexOf(`echo:n${i}`)).every(
    (position, index, all) => position > -1 && (index === 0 || position > all[index - 1]!),
  );
  check(
    `${BIG} parallel calls all succeed in order`,
    big.code === 0 && bigResults === BIG && bigOrdered,
    `code=${big.code} results=${bigResults}/${BIG} ordered=${bigOrdered}`,
  );

  // ---- the JS bundle must behave identically ----
  const bundleVersion = await cli(["--version"], { via: "bundle" });
  check("bundle --version", bundleVersion.code === 0 && bundleVersion.out.trim().startsWith("mcp "), `code=${bundleVersion.code} err=${bundleVersion.err}`);

  const bundleCall = await cli(["tools", "call", "alpha.echo", '{"text":"bundle"}'], { via: "bundle" });
  check("bundle performs a real call through the gateway", bundleCall.code === 0 && bundleCall.out.includes("echo:bundle"), `code=${bundleCall.code} out=${bundleCall.out} err=${bundleCall.err}`);

  const bundleStdin = await cli(["tools", "call"], { via: "bundle", stdin: JSON.stringify({ name: "alpha.v2.echo", arguments: { text: "bundle-stdin" } }) });
  check("bundle handles stdin calls", bundleStdin.code === 0 && bundleStdin.out.includes("echo:bundle-stdin"), `code=${bundleStdin.code} err=${bundleStdin.err}`);

  // ---- self-update, against a local fake release server --------------------
  // Deliberately independent of src/update.ts: the asset name and the digest are
  // recomputed here, so a bug in the implementation cannot pass its own test.
  const UPDATE_PORT = 8899;
  const UPDATE_BASE = `http://127.0.0.1:${UPDATE_PORT}`;
  const FAKE_VERSION = "26.10.4";
  const fakeOs = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "windows";
  const fakeArch = process.arch === "arm64" ? "arm64" : "x64";
  const fakeAsset = `mcp-${FAKE_VERSION}-${fakeOs}-${fakeArch}${fakeOs === "windows" ? ".exe" : ""}`;
  const fakeBundle = `mcp-${FAKE_VERSION}.js`;
  const fakeBinaryBytes = new TextEncoder().encode("#!/bin/sh\necho fake-26.10.4\n");
  const fakeBundleBytes = new TextEncoder().encode("console.log('fake 26.10.4');\n");
  const digest = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  let corruptChecksums = false;

  const updateServer = Bun.serve({
    port: UPDATE_PORT,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/releases")) {
        return Response.json([
          {
            tag_name: `cli-v${FAKE_VERSION}`,
            draft: false,
            prerelease: false,
            html_url: `${UPDATE_BASE}/releases/tag/cli-v${FAKE_VERSION}`,
            assets: [
              { name: fakeAsset, browser_download_url: `${UPDATE_BASE}/asset`, size: fakeBinaryBytes.length },
              { name: fakeBundle, browser_download_url: `${UPDATE_BASE}/bundle`, size: fakeBundleBytes.length },
              { name: "SHA256SUMS", browser_download_url: `${UPDATE_BASE}/sums`, size: 0 },
            ],
          },
          // An older release must be ignored in favour of the newest.
          { tag_name: "cli-v26.10.2", draft: false, prerelease: false, html_url: "", assets: [] },
          // Matches the version the test binary reports, so "--release-version
          // <current>" has a real release to resolve to.
          {
            tag_name: "cli-v26.10.3-dev",
            draft: false,
            prerelease: true,
            html_url: "",
            assets: [
              { name: `mcp-26.10.3-dev-${fakeOs}-${fakeArch}${fakeOs === "windows" ? ".exe" : ""}`, browser_download_url: `${UPDATE_BASE}/asset`, size: fakeBinaryBytes.length },
              { name: "mcp-26.10.3-dev.js", browser_download_url: `${UPDATE_BASE}/bundle`, size: fakeBundleBytes.length },
              { name: "SHA256SUMS", browser_download_url: `${UPDATE_BASE}/sums-old`, size: 0 },
            ],
          },
          // A draft and a non-CLI tag must both be ignored.
          { tag_name: "cli-v99.1.1", draft: true, prerelease: false, html_url: "", assets: [] },
          { tag_name: "worker-v1.0.0", draft: false, prerelease: false, html_url: "", assets: [] },
        ]);
      }
      if (path === "/asset") return new Response(fakeBinaryBytes);
      if (path === "/bundle") return new Response(fakeBundleBytes);
      if (path === "/sums-old") {
        return new Response(`${digest(fakeBinaryBytes)}  mcp-26.10.3-dev-${fakeOs}-${fakeArch}${fakeOs === "windows" ? ".exe" : ""}\n${digest(fakeBundleBytes)}  mcp-26.10.3-dev.js\n`);
      }
      if (path === "/sums") {
        const binaryHash = corruptChecksums ? "0".repeat(64) : digest(fakeBinaryBytes);
        return new Response(`${binaryHash}  ${fakeAsset}\n${digest(fakeBundleBytes)}  ${fakeBundle}\n`);
      }
      return new Response("not found", { status: 404 });
    },
  });

  const updateEnv = { MCP_CLI_API_BASE: UPDATE_BASE };
  const installDir = mkdtempSync(join(tmpdir(), "mcp-update-"));

  const checkRun = await cli(["update", "--check", "--json"], { env: updateEnv });
  const checkJson = JSON.parse(checkRun.out) as { latest: string; update_available: boolean };
  check(
    "update --check reports the newest release (ignoring drafts and other tags)",
    checkRun.code === 0 && checkJson.latest === FAKE_VERSION && checkJson.update_available === true,
    checkRun.out.trim(),
  );

  const installTarget = join(installDir, "mcp");
  const installRun = await cli(["update", "--to", installTarget, "--json"], { env: updateEnv });
  const installJson = JSON.parse(installRun.out) as { updated: boolean; installed_version: string; asset: string };
  check(
    "update installs the platform asset and reports it",
    installRun.code === 0 && installJson.updated === true && installJson.installed_version === FAKE_VERSION &&
      installJson.asset === fakeAsset,
    installRun.out.trim(),
  );
  check(
    "the installed file is the released artifact, and executable",
    digest(new Uint8Array(readFileSync(installTarget))) === digest(fakeBinaryBytes) &&
      (statSync(installTarget).mode & 0o777) === 0o755,
    `mode=${(statSync(installTarget).mode & 0o777).toString(8)}`,
  );

  const upToDate = await cli(["update", "--release-version", "26.10.3-dev", "--to", installTarget, "--json"], { env: updateEnv });
  check(
    "--release-version equal to the running version is a no-op",
    upToDate.code === 0 && (JSON.parse(upToDate.out) as { updated: boolean }).updated === false,
    upToDate.out.trim(),
  );

  const forced = await cli(["update", "--force", "--release-version", "26.10.3-dev", "--to", join(installDir, "forced"), "--json"], { env: updateEnv });
  check("--force reinstalls the same version", forced.code === 0 && (JSON.parse(forced.out) as { updated: boolean }).updated === true, forced.out.trim());

  corruptChecksums = true;
  const neverWritten = join(installDir, "never-written");
  const corrupted = await cli(["update", "--to", neverWritten], { env: updateEnv });
  check(
    "a checksum mismatch refuses to install and writes nothing",
    corrupted.code === 1 && corrupted.err.includes("checksum mismatch") && !existsSync(neverWritten),
    `code=${corrupted.code} exists=${existsSync(neverWritten)} err=${corrupted.err.trim()}`,
  );
  corruptChecksums = false;

  const readOnlyDir = join(installDir, "readonly");
  mkdirSync(readOnlyDir);
  chmodSync(readOnlyDir, 0o500);
  const notWritable = await cli(["update", "--to", join(readOnlyDir, "mcp")], { env: updateEnv });
  chmodSync(readOnlyDir, 0o700);
  check(
    "an unwritable destination is refused with a sudo hint",
    notWritable.code === 1 && notWritable.err.includes("not writable") && notWritable.err.includes("sudo"),
    `code=${notWritable.code} err=${notWritable.err.trim()}`,
  );

  const bundleTarget = join(installDir, "mcp.js");
  const bundleUpdate = await cli(["update", "--to", bundleTarget, "--json"], { env: updateEnv });
  check(
    "--to a .js path installs the bundle asset",
    bundleUpdate.code === 0 && readFileSync(bundleTarget, "utf8").includes("fake 26.10.4"),
    bundleUpdate.out.trim(),
  );

  updateServer.stop(true);
  rmSync(installDir, { recursive: true, force: true });

  // ---- performance ---------------------------------------------------------
  const timings: number[] = [];
  for (let i = 0; i < 5; i++) timings.push((await cli(["--version"])).ms);
  const best = Math.min(...timings);
  check("startup stays under 150 ms", best < 150, `best=${best}ms`);

  const roundTrip = await cli(["tools", "call", "alpha.echo", '{"text":"rt"}', "--verbose"]);
  console.log(`INFO compiled CLI: startup ${best} ms, one tool call end-to-end ${roundTrip.ms} ms`);
} finally {
  alpha.close();
  dotted.close();
  gateway.kill();
  rmSync(CONFIG_DIR, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:\n" + failures.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}
