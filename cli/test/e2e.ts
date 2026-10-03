// End-to-end test: a real local gateway (wrangler dev) + mock devices, driven by
// the COMPILED mcp binary. Run: bun test/e2e.ts
//
// This is the test that proves the CLI works against the real gateway protocol:
// auth on both credentials, the tunnel relay, JSON-RPC error mapping, and every
// documented input form.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
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

async function cli(args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}): Promise<RunResult> {
  const started = performance.now();
  const proc = Bun.spawn([BIN, ...args], {
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
const build = Bun.spawnSync(["bun", "build", "--compile", "--minify", "--outfile", BIN, join(ROOT, "src", "index.ts")], {
  cwd: ROOT,
  stdout: "pipe",
  stderr: "pipe",
});
if (build.exitCode !== 0) {
  console.error(build.stderr.toString());
  process.exit(1);
}
console.log(`binary: ${(statSync(BIN).size / 1024 / 1024).toFixed(1)} MB`);

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
  check("tools list --json count", toolsJson.count === 5 && toolsJson.tools.some((t) => t.name === "file.read"));

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
