// Tests for "mcp connect", "mcp serve" and the bundled code-mcp. Offline: the
// gateway is a fake started in-process with Bun.serve. Run: bun test
//
// The CLI is spawned as "bun src/index.ts ..." so argument parsing, config
// persistence and stdout discipline are exercised exactly as a user sees them.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emptyConfig, loadConfig, parseConfig, saveConfig, serializeConfig } from "../src/config.ts";
import {
  classifyProbe,
  connectUrlFor,
  findSavedAnonymous,
  formatDuration,
  parseAnonymousResponse,
  rememberAnonymous,
  retryAfterMs,
} from "../src/connect.ts";
import { AggregateServer, TOOL_NAME_RE, isLoopback, namespaceTools, sanitizeName, type DeviceTool } from "../src/serve.ts";
import { GATEWAY_TOKEN_ENV, PARENT_PID_ENV, RAW_ENV, codeMcpArgv, processAlive, selfCommand, watchParent } from "../src/code-mcp-host.ts";
import { codeMcpLaunch } from "../src/connect.ts";
import { GatewayClient } from "../src/client.ts";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname: on Windows the latter is "/D:/a/..." -
// not a path any API accepts.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = join(ROOT, "src", "index.ts");

// ---- bundled code-mcp ---------------------------------------------------------

describe("bundled code-mcp", () => {
  test("is the device server in this package", () => {
    // One source, in this package: src/code-mcp.ts is the server itself.
    const entry = readFileSync(join(ROOT, "src", "code-mcp.ts"), "utf8");
    expect(entry).toContain("code-mcp listening on");
    expect(entry).not.toMatch(/^import\.{2}\/.*code-mcp\/code-mcp\.ts/m);
  });

  test("is wired through the #code-mcp import, never a static import", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { imports?: Record<string, string> };
    expect(pkg.imports?.["#code-mcp"]).toBe("./src/code-mcp.ts");
    for (const file of ["index.ts", "connect.ts", "serve.ts", "code-mcp-host.ts"]) {
      const text = readFileSync(join(ROOT, "src", file), "utf8");
      expect(text).not.toMatch(/^import[^\n]*(#code-mcp|\.\/code-mcp\.ts)/m);
    }
  });

  test("'mcp code-mcp --help' runs code-mcp; normal commands never start it", () => {
    const help = Bun.spawnSync(["bun", ENTRY, "code-mcp", "--help"], { stdout: "pipe", stderr: "pipe" });
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain("--gateway-token");
    const version = Bun.spawnSync(["bun", ENTRY, "--version"], { stdout: "pipe", stderr: "pipe" });
    expect(version.stdout.toString()).toMatch(/^mcp /);
    expect(version.stderr.toString()).not.toContain("MCP server");
  });

  test("connect keeps the device code off the child's command line", () => {
    const { command, env } = codeMcpLaunch("https://gw.test", { deviceId: "anon-0123456789abcdef", token: "SECR3T" }, 4321, ["--enable-memory"]);
    expect(command.some((a) => a.includes("SECR3T"))).toBe(false);
    expect(command).not.toContain("--gateway-token");
    expect(command.slice(-10)).toEqual(["code-mcp", "--gateway", "https://gw.test", "--id", "anon-0123456789abcdef", "--port", "4321", "--bind", "127.0.0.1", "--enable-memory"]);
    expect(env[GATEWAY_TOKEN_ENV]).toBe("SECR3T");
  });

  test("the code-mcp host injects the token from the environment", () => {
    const args = ["--gateway", "g", "--id", "d"];
    expect(codeMcpArgv(args, { [GATEWAY_TOKEN_ENV]: "SECR3T" })).toEqual([...args, "--gateway-token", "SECR3T"]);
    expect(codeMcpArgv(args, {})).toEqual(args);
    // An explicit flag (direct "mcp code-mcp" use) wins over the environment.
    expect(codeMcpArgv([...args, "--gateway-token", "mine"], { [GATEWAY_TOKEN_ENV]: "SECR3T" })).toEqual([...args, "--gateway-token", "mine"]);
    expect(codeMcpArgv([...args, "--gateway-token=mine"], { [GATEWAY_TOKEN_ENV]: "SECR3T" })).toEqual([...args, "--gateway-token=mine"]);
  });

  test("connect tells the child its parent, so an orphaned code-mcp stops", async () => {
    const launch = codeMcpLaunch("https://gw.example", { deviceId: "anon-0123456789abcdef", token: "ABC123" }, 4321, []);
    expect(launch.env[PARENT_PID_ENV]).toBe(String(process.pid));
    expect(processAlive(process.pid)).toBe(true);

    // A process that has exited: the watchdog must notice and stop.
    const gone = Bun.spawn([process.execPath, "-e", "0"]);
    await gone.exited;
    expect(processAlive(gone.pid)).toBe(false);
    let stopped = false;
    const timer = watchParent(gone.pid, () => {
      stopped = true;
    });
    await Bun.sleep(1_500);
    clearInterval(timer);
    expect(stopped).toBe(true);

    // ...and a live parent keeps it running.
    let wrongly = false;
    const alive = watchParent(process.pid, () => {
      wrongly = true;
    });
    await Bun.sleep(1_500);
    clearInterval(alive);
    expect(wrongly).toBe(false);
  });

  test("the injected token reaches code-mcp but not its environment", async () => {
    // A preload stands in for code-mcp: it records what the real script
    // would see (argv and env) at import time, then stops the process.
    const dir = mkdtempSync(join(tmpdir(), "mcp-host-"));
    const probe = join(dir, "probe.ts");
    await Bun.write(
      probe,
      `const real = Bun.argv; Bun.plugin({ name: "probe", setup(b) { b.onLoad({ filter: /code-mcp\\.ts$/ }, () => ({ loader: "js", contents: "console.log(JSON.stringify({ argv: Bun.argv.slice(2), env: process.env.${GATEWAY_TOKEN_ENV} ?? null })); process.exit(0);" })); } }); void real;`,
    );
    // As 'mcp connect' launches it: raw, exactly these arguments.
    const proc = Bun.spawnSync(["bun", "--preload", probe, ENTRY, "code-mcp", "--gateway", "g", "--id", "d"], {
      env: { ...process.env, [GATEWAY_TOKEN_ENV]: "SECR3T", [RAW_ENV]: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const seen = JSON.parse(proc.stdout.toString().trim()) as { argv: string[]; env: string | null };
    expect(seen.argv).toEqual(["--gateway", "g", "--id", "d", "--gateway-token", "SECR3T"]);
    expect(seen.env).toBeNull();

    // Run by a person: the config's code-mcp section, the command line winning.
    const config = join(dir, "config.yaml");
    await Bun.write(config, 'code-mcp:\n  port: "1111"\n  token: "cfg-secret"\n  enable-memory: true\n');
    const own = Bun.spawnSync(["bun", "--preload", probe, ENTRY, "code-mcp", "--port", "2222"], {
      env: { ...process.env, CODE_MCP_GATEWAY_CONFIG: config },
      stdout: "pipe",
      stderr: "pipe",
    });
    // On a machine where the code-mcp service is running, refusing is the
    // specified behaviour (one code-mcp per machine) - that is the outcome then.
    if (own.stdout.toString().trim() === "" && own.stderr.toString().includes("service is running")) {
      expect(own.exitCode).toBe(2);
    } else {
      const fromConfig = JSON.parse(own.stdout.toString().trim()) as { argv: string[] };
      expect(fromConfig.argv).toEqual(["--port", "2222", "--token", "cfg-secret", "--enable-memory"]);
    }
  });

  test("selfCommand re-runs the script under bun", () => {
    const cmd = selfCommand();
    expect(cmd[0]).toBe(process.execPath);
  });
});

// ---- anonymous registration (pure) ------------------------------------------------

const GW = "https://gw.test";
const okBody = JSON.stringify({
  deviceId: "anon-0123456789abcdef",
  token: "A1B2C3",
  connect_url: `${GW}/mcp/anon-0123456789abcdef?token=A1B2C3`,
  ws_url: "wss://gw.test/ws/anon-0123456789abcdef",
  anonymous: true,
  rate_limit: { max: 30, window_ms: 60000 },
});

describe("anonymous registration response", () => {
  test("accepts the documented 201", () => {
    const d = parseAnonymousResponse(GW, 201, new Headers(), okBody);
    expect(d.deviceId).toBe("anon-0123456789abcdef");
    expect(d.token).toBe("A1B2C3");
    expect(d.connectUrl).toBe(`${GW}/mcp/anon-0123456789abcdef?token=A1B2C3`);
    expect(d.rateLimit).toEqual({ max: 30, window_ms: 60000 });
  });

  test("rebuilds a connect URL that points at another origin", () => {
    const body = JSON.parse(okBody);
    body.connect_url = "https://evil.test/mcp/x";
    expect(parseAnonymousResponse(GW, 201, new Headers(), JSON.stringify(body)).connectUrl).toBe(
      connectUrlFor(GW, "anon-0123456789abcdef", "A1B2C3"),
    );
  });

  test("rejects malformed success bodies", () => {
    expect(() => parseAnonymousResponse(GW, 201, new Headers(), "nope")).toThrow(/non-JSON/);
    expect(() => parseAnonymousResponse(GW, 201, new Headers(), '{"deviceId":"x"}')).toThrow(/missing/);
    expect(() => parseAnonymousResponse(GW, 201, new Headers(), '{"deviceId":"bad id","token":"T"}')).toThrow(/invalid device id/);
  });

  test("maps every documented failure to an actionable error and exit code", () => {
    const fail = (status: number, body: unknown, headers = new Headers()) => {
      try {
        parseAnonymousResponse(GW, status, headers, JSON.stringify(body));
      } catch (err) {
        return err as Error & { exitCode: number; hint?: string };
      }
      throw new Error("expected a throw");
    };
    const limited = fail(429, { error: "rate limited", retry_after_ms: 720000 }, new Headers({ "retry-after": "720" }));
    expect(limited.message).toContain("retry in 12 min");
    expect(limited.exitCode).toBe(1);
    expect(fail(429, { error: "rate limited", retry_after_ms: 30000 }).message).toContain("retry in 30 s");
    expect(fail(429, { error: "rate limited" }).message).toBe("rate limited by the gateway (429)");
    const full = fail(503, { error: "device limit reached", max_devices: 100 });
    expect(full.message).toContain("device limit");
    expect(full.message).toContain("100");
    const disabled = fail(403, { error: "anonymous devices are disabled" });
    expect(disabled.message).toContain("disabled");
    expect(disabled.exitCode).toBe(3);
    expect(fail(401, { error: "unauthorized" }).hint).toContain("--gateway-token");
    expect(fail(404, { error: "not found" }).message).toContain("does not support anonymous devices");
  });

  test("retry-after parsing and duration formatting", () => {
    expect(retryAfterMs(new Headers({ "retry-after": "5" }))).toBe(5000);
    expect(retryAfterMs(new Headers(), 1234)).toBe(1234);
    expect(retryAfterMs(new Headers())).toBeUndefined();
    expect(formatDuration(1)).toBe("1 s");
    expect(formatDuration(3_600_000)).toBe("60 min");
    expect(formatDuration(7_500_000)).toBe("2 h 5 min");
  });

  test("probe classification: 503 offline proves the code, 401 means gone", () => {
    expect(classifyProbe(503, "device offline")).toBe("valid");
    expect(classifyProbe(503, "device busy")).toBe("online");
    expect(classifyProbe(200, undefined)).toBe("online");
    expect(classifyProbe(401, "unauthorized")).toBe("rejected");
    expect(classifyProbe(403, "device disabled")).toBe("disabled");
    expect(classifyProbe(429, "too many failed attempts; try again later")).toBe("locked");
  });

  test("saved anonymous devices are found per gateway, newest first, and round-trip", () => {
    const config = emptyConfig();
    rememberAnonymous(config, GW, { deviceId: "anon-old", token: "OLD111" }, undefined, "2026-01-01T00:00:00.000Z");
    rememberAnonymous(config, GW, { deviceId: "anon-new", token: "NEW222" }, undefined, "2026-02-01T00:00:00.000Z");
    rememberAnonymous(config, "http://127.0.0.1:9", { deviceId: "anon-local", token: "LOC333" }, "gw", "2026-03-01T00:00:00.000Z");
    config.devices["registered"] = { gateway: GW, token: "x" };
    expect(findSavedAnonymous(config, GW)?.deviceId).toBe("anon-new");
    expect(findSavedAnonymous(config, "http://127.0.0.1:9")?.entry.gateway_token).toBe("gw");
    expect(findSavedAnonymous(config, "https://other.test")).toBeUndefined();
    const reparsed = parseConfig(serializeConfig(config), "memory");
    expect(reparsed).toEqual(config);
    expect(reparsed.devices["anon-new"]!.anonymous).toBe(true);
    expect(reparsed.devices["registered"]!.anonymous).toBeUndefined();
  });
});

// ---- tool namespacing ----------------------------------------------------------------

const tool = (deviceId: string, name: string, description = "d"): DeviceTool => ({
  deviceId,
  tool: { name, description, inputSchema: { type: "object", properties: {} } },
});

describe("tool namespacing", () => {
  test("namespaces as <device>__<tool> and sanitizes dots", () => {
    const out = namespaceTools([tool("laptop", "bash"), tool("alpha.v2", "file.read")]);
    expect(out.map((t) => t.name)).toEqual(["laptop__bash", "alpha_v2__file_read"]);
    expect(out[1]!.toolName).toBe("file.read");
    expect(out[1]!.deviceId).toBe("alpha.v2");
    expect(out[0]!.definition.description).toBe("[laptop] d");
    expect(sanitizeName("a b/c")).toBe("a_b_c");
  });

  test("dedupes collisions deterministically and independently of order", () => {
    const items = [tool("a.b", "x"), tool("a_b", "x"), tool("solo", "y")];
    const first = namespaceTools(items);
    const second = namespaceTools([...items].reverse());
    const names = first.map((t) => t.name);
    expect(new Set(names).size).toBe(3);
    expect(names[2]).toBe("solo__y"); // untouched by the collision
    expect(names[0]).not.toBe("a_b__x");
    const byKey = (list: typeof first) => Object.fromEntries(list.map((t) => [`${t.deviceId}/${t.toolName}`, t.name]));
    expect(byKey(first)).toEqual(byKey(second));
  });

  test("every name is valid for Claude/Codex, even long or empty ones", () => {
    const long = "d".repeat(100);
    const out = namespaceTools([tool(long, "t".repeat(80)), tool(long, "t".repeat(81)), tool("x", ""), tool("x", "dup"), tool("x", "dup")]);
    for (const t of out) expect(t.name).toMatch(TOOL_NAME_RE);
    expect(new Set(out.map((t) => t.name)).size).toBe(out.length);
  });

  test("keeps the device's schema and extra fields", () => {
    const item: DeviceTool = { deviceId: "d", tool: { name: "t", inputSchema: { type: "object", required: ["a"] }, annotations: { readOnlyHint: true } } };
    const [out] = namespaceTools([item]);
    expect(out!.definition.inputSchema).toEqual({ type: "object", required: ["a"] });
    expect(out!.definition.annotations).toEqual({ readOnlyHint: true });
    expect(isLoopback("127.0.0.1") && isLoopback("localhost") && !isLoopback("0.0.0.0")).toBe(true);
  });
});

// ---- fake gateway ----------------------------------------------------------------------

interface FakeDevice {
  token: string;
  online: boolean;
  tools: { name: string; description?: string; inputSchema?: unknown }[];
}

const fake = {
  devices: new Map<string, FakeDevice>(),
  created: 0,
  /** Forced status for POST /api/devices/anonymous (0 = normal). */
  anonStatus: 0,
  calls: [] as string[],
};

let gateway: ReturnType<typeof Bun.serve>;
let GATEWAY = "";

function startFakeGateway() {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/devices/anonymous" && request.method === "POST") {
        if (fake.anonStatus === 429) {
          return Response.json({ error: "rate limited", retry_after_ms: 600000 }, { status: 429, headers: { "retry-after": "600" } });
        }
        if (fake.anonStatus === 503) return Response.json({ error: "device limit reached", max_devices: 100 }, { status: 503 });
        if (fake.anonStatus === 403) return Response.json({ error: "anonymous devices are disabled" }, { status: 403 });
        fake.created++;
        const deviceId = `anon-${fake.created.toString(16).padStart(16, "0")}`;
        const token = `T${String(fake.created).padStart(5, "0")}`;
        fake.devices.set(deviceId, { token, online: false, tools: [] });
        return Response.json(
          {
            deviceId,
            token,
            connect_url: `${url.origin}/mcp/${deviceId}?token=${token}`,
            ws_url: `ws://${url.host}/ws/${deviceId}`,
            anonymous: true,
            rate_limit: { max: 30, window_ms: 60000 },
          },
          { status: 201 },
        );
      }
      const m = /^\/mcp\/([^/]+)$/.exec(url.pathname);
      if (m && request.method === "POST") {
        const id = decodeURIComponent(m[1]!);
        const device = fake.devices.get(id);
        const given = request.headers.get("x-device-token") ?? url.searchParams.get("token");
        if (!device || given !== device.token) return Response.json({ error: "unauthorized" }, { status: 401 });
        if (!device.online) return Response.json({ error: "device offline" }, { status: 503 });
        const rpc = (await request.json()) as { id?: unknown; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
        if (rpc.id === undefined || rpc.id === null) return new Response(null, { status: 204 });
        const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id: rpc.id, result });
        switch (rpc.method) {
          case "initialize":
            return ok({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: id, version: "1" } });
          case "ping":
            return ok({});
          case "tools/list":
            return ok({ tools: device.tools });
          case "tools/call": {
            const name = rpc.params?.name ?? "";
            fake.calls.push(`${id}:${name}:${JSON.stringify(rpc.params?.arguments ?? {})}`);
            if (name === "echo") return ok({ content: [{ type: "text", text: `echo:${String(rpc.params?.arguments?.text ?? "")}` }] });
            if (name === "boom") return ok({ content: [{ type: "text", text: "boom" }], isError: true });
            return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: `unknown tool: ${name}` } });
          }
          default:
            return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "nope" } });
        }
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
}

beforeAll(() => {
  gateway = startFakeGateway();
  GATEWAY = `http://127.0.0.1:${gateway.port}`;
});
afterAll(() => {
  gateway.stop(true);
});
beforeEach(() => {
  fake.anonStatus = 0;
});

function freshConfig(): string {
  return join(mkdtempSync(join(tmpdir(), "mcp-features-")), "config.yaml");
}

async function cli(args: string[], config: string, stdin?: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", ENTRY, ...args], {
    env: { ...process.env, CODE_MCP_GATEWAY_CONFIG: config, NO_COLOR: "1", CODE_MCP_GATEWAY_URL: "" },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

// ---- mcp connect -------------------------------------------------------------------------

describe("mcp connect (fake gateway)", () => {
  test("registers once, saves the device, and reuses it on later runs", async () => {
    const config = freshConfig();
    const before = fake.created;
    const first = await cli(["connect", "--gateway", GATEWAY, "--no-start", "--json"], config);
    expect(first.code).toBe(0);
    const j = JSON.parse(first.out) as { device: string; token: string; connect_url: string; reused: boolean; gateway: string };
    expect(j.reused).toBe(false);
    expect(j.gateway).toBe(GATEWAY);
    expect(j.connect_url).toBe(`${GATEWAY}/mcp/${j.device}?token=${j.token}`);
    expect(fake.created).toBe(before + 1);
    const saved = loadConfig(config).devices[j.device]!;
    expect(saved).toMatchObject({ gateway: GATEWAY, token: j.token, anonymous: true });

    const again = await cli(["connect", "--gateway", GATEWAY, "--no-start", "--json"], config);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.out)).toMatchObject({ device: j.device, token: j.token, reused: true });
    expect(fake.created).toBe(before + 1); // no device burned

    const human = await cli(["connect", "--gateway", GATEWAY, "--no-start"], config);
    expect(human.code).toBe(0);
    expect(human.out).toContain(j.device);
    expect(human.out).toContain(j.token);
    expect(human.out).toContain(`${GATEWAY}/mcp/${j.device}?token=${j.token}`);

    const forced = await cli(["connect", "--gateway", GATEWAY, "--no-start", "--json", "--new"], config);
    const k = JSON.parse(forced.out) as { device: string; reused: boolean };
    expect(k.reused).toBe(false);
    expect(k.device).not.toBe(j.device);
    expect(fake.created).toBe(before + 2);
  });

  test("replaces a saved device the gateway no longer knows (401), and says so", async () => {
    const config = freshConfig();
    const first = JSON.parse((await cli(["connect", "--gateway", GATEWAY, "--no-start", "--json"], config)).out) as { device: string };
    fake.devices.delete(first.device); // expired / deleted by the admin
    const next = await cli(["connect", "--gateway", GATEWAY, "--no-start", "--json"], config);
    expect(next.code).toBe(0);
    const j = JSON.parse(next.out) as { device: string; reused: boolean; replaced?: string };
    expect(j.reused).toBe(false);
    expect(j.replaced).toBe(first.device);
    expect(next.err).toContain("registering a new anonymous device");
    const devices = loadConfig(config).devices;
    expect(devices[first.device]).toBeUndefined();
    expect(devices[j.device]?.anonymous).toBe(true);
  });

  test("the saved device works with 'mcp tools list'", async () => {
    const config = freshConfig();
    const j = JSON.parse((await cli(["connect", "--gateway", GATEWAY, "--no-start", "--json"], config)).out) as { device: string };
    fake.devices.get(j.device)!.online = true;
    fake.devices.get(j.device)!.tools = [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }];
    const list = await cli(["tools", "list", j.device, "--json"], config);
    expect(list.code).toBe(0);
    expect((JSON.parse(list.out) as { count: number }).count).toBe(1);
  });

  test("429 / 503 / 403 / unreachable produce clear errors and exit codes", async () => {
    const config = freshConfig();
    fake.anonStatus = 429;
    const limited = await cli(["connect", "--gateway", GATEWAY, "--no-start"], config);
    expect(limited.code).toBe(1);
    expect(limited.err).toContain("retry in 10 min");
    fake.anonStatus = 503;
    const full = await cli(["connect", "--gateway", GATEWAY, "--no-start"], config);
    expect(full.code).toBe(1);
    expect(full.err).toContain("device limit");
    fake.anonStatus = 403;
    const disabled = await cli(["connect", "--gateway", GATEWAY, "--no-start", "--json"], config);
    expect(disabled.code).toBe(3);
    expect((JSON.parse(disabled.out) as { error: { message: string } }).error.message).toContain("disabled");
    const down = await cli(["connect", "--gateway", "http://127.0.0.1:1", "--no-start"], config);
    expect(down.code).toBe(1);
    expect(down.err).toContain("cannot reach the gateway");
    expect(loadConfig(config).devices).toEqual({});
  });

  test("rejects code-mcp flags that connect owns", async () => {
    const r = await cli(["connect", "--no-start", "--", "--id", "x"], freshConfig());
    expect(r.code).toBe(2);
    expect(r.err).toContain("--id");
  });
});

// ---- mcp serve ----------------------------------------------------------------------------

/** A config with one online device (2 tools), one with a dotted id, one offline. */
function serveFixture(): string {
  const config = freshConfig();
  fake.devices.set("laptop", {
    token: "tok-l",
    online: true,
    tools: [
      { name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
      { name: "boom", description: "Fails" },
    ],
  });
  fake.devices.set("alpha.v2", { token: "tok-a", online: true, tools: [{ name: "echo", description: "Echo too" }] });
  fake.devices.set("sleepy", { token: "tok-s", online: false, tools: [{ name: "zzz" }] });
  const c = emptyConfig();
  c.defaults.gateway = GATEWAY;
  c.devices = { laptop: { token: "tok-l" }, "alpha.v2": { token: "tok-a" }, sleepy: { token: "tok-s" } };
  saveConfig(config, c);
  return config;
}

describe("mcp serve over stdio", () => {
  test("speaks newline-delimited JSON-RPC and nothing else on stdout", async () => {
    const config = serveFixture();
    const input =
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "laptop__echo", arguments: { text: "hi" } } },
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "laptop__boom", arguments: {} } },
        { jsonrpc: "2.0", id: 5, method: "ping" },
        { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope__x", arguments: {} } },
        { jsonrpc: "2.0", id: 7, method: "bogus/method" },
        { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "alpha_v2__echo", arguments: { text: "dotted" } } },
      ]
        .map((m) => JSON.stringify(m))
        .join("\n") + "\n{not json\n";
    const r = await cli(["serve"], config, input);
    expect(r.code).toBe(0);
    const lines = r.out.split("\n").filter((l) => l.length > 0);
    const messages = lines.map((l) => JSON.parse(l) as { jsonrpc: string; id: unknown; result?: any; error?: any });
    for (const m of messages) {
      expect(m.jsonrpc).toBe("2.0");
      expect("result" in m || "error" in m).toBe(true);
    }
    // 8 requests + 1 parse error; the notification got no response.
    expect(messages.length).toBe(9);
    const byId = new Map(messages.map((m) => [m.id, m]));
    expect(byId.get(1)!.result.capabilities.tools).toBeDefined();
    expect(byId.get(1)!.result.protocolVersion).toBe("2025-06-18");
    const names = (byId.get(2)!.result.tools as { name: string; description: string }[]).map((t) => t.name).sort();
    expect(names).toEqual(["alpha_v2__echo", "laptop__boom", "laptop__echo"]);
    for (const n of names) expect(n).toMatch(TOOL_NAME_RE);
    expect(byId.get(3)!.result).toEqual({ content: [{ type: "text", text: "echo:hi" }] });
    expect(byId.get(4)!.result.isError).toBe(true);
    expect(byId.get(5)!.result).toEqual({});
    expect(byId.get(6)!.error.code).toBe(-32602);
    expect(byId.get(7)!.error.code).toBe(-32601);
    expect(byId.get(8)!.result.content[0].text).toBe("echo:dotted");
    expect(byId.get(null)!.error.code).toBe(-32700);
    expect(r.err).toContain("skipping sleepy");
    expect(fake.calls).toContain('alpha.v2:echo:{"text":"dotted"}');
  });

  test("starts with an empty tool list when nothing is configured", async () => {
    const r = await cli(["serve"], freshConfig(), JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out.trim())).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
  });

  test("a device that comes online later appears on a later tools/list", async () => {
    fake.devices.set("late", { token: "tok-z", online: false, tools: [{ name: "hello", description: "hi" }] });
    const target = { deviceId: "late", gateway: GATEWAY, deviceToken: "tok-z", timeoutMs: 5000 };
    const server = new AggregateServer({ deviceIds: ["late"], clientFor: () => new GatewayClient(target), version: "t", note: () => {}, listTtlMs: 0 });
    const list = async () => ((await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as any).result.tools as { name: string }[];
    expect(await list()).toEqual([]);
    fake.devices.get("late")!.online = true;
    expect((await list()).map((t) => t.name)).toEqual(["late__hello"]);
  });
});

describe("mcp serve over HTTP", () => {
  test("POST /mcp answers JSON-RPC, GET is 405, notifications are 202", async () => {
    const config = serveFixture();
    const proc = Bun.spawn(["bun", ENTRY, "serve", "--port", "0"], {
      env: { ...process.env, CODE_MCP_GATEWAY_CONFIG: config, NO_COLOR: "1", CODE_MCP_GATEWAY_URL: "" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = proc.stderr.getReader();
      let err = "";
      let url = "";
      const deadline = Date.now() + 15_000;
      while (!url && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        err += new TextDecoder().decode(value);
        url = /listening on (http:\/\/\S+\/mcp)/.exec(err)?.[1] ?? "";
      }
      reader.releaseLock();
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      const post = (body: unknown) =>
        fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });

      const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
      expect(init.status).toBe(200);
      expect(((await init.json()) as any).result.serverInfo.name).toBe("prime-gateway");
      expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
      const list = (await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as any;
      expect(list.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["alpha_v2__echo", "laptop__boom", "laptop__echo"]);
      const call = (await (await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "laptop__echo", arguments: { text: "http" } } })).json()) as any;
      expect(call.result.content[0].text).toBe("echo:http");
      const batch = (await (await post([{ jsonrpc: "2.0", id: 4, method: "ping" }, { jsonrpc: "2.0", method: "notifications/x" }])).json()) as any[];
      expect(batch).toEqual([{ jsonrpc: "2.0", id: 4, result: {} }]);
      expect((await fetch(url)).status).toBe(405);
      expect((await fetch(url, { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" })).status).toBe(403);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });

  test("refuses a non-loopback host without --allow-remote", async () => {
    const r = await cli(["serve", "--port", "0", "--host", "0.0.0.0"], freshConfig());
    expect(r.code).toBe(2);
    expect(r.err).toContain("--allow-remote");
  });
});
