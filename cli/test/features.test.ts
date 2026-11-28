// Tests for "prime connect", "prime serve" and the bundled code-mcp. Offline: the
// gateway is a fake started in-process with Bun.serve. Run: bun test
//
// The CLI is spawned as "bun src/index.ts ..." so argument parsing, config
// persistence and stdout discipline are exercised exactly as a user sees them.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emptyConfig, loadConfig, parseConfig, saveConfig, serializeConfig, updateConfig } from "../src/config.ts";
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
import { applyTestTimeout } from "./setup";

applyTestTimeout();

// fileURLToPath, not URL.pathname: on Windows the latter is "/D:/a/..." -
// not a path any API accepts.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = join(ROOT, "src", "index.ts");

// ---- bundled code-mcp ---------------------------------------------------------

describe("bundled code-mcp", () => {
  test("is the device buddy in this package", () => {
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

  test("'prime code-mcp --help' runs code-mcp; normal commands never start it", () => {
    const help = Bun.spawnSync(["bun", ENTRY, "code-mcp", "--help"], { stdout: "pipe", stderr: "pipe" });
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain("--gateway-token");
    const version = Bun.spawnSync(["bun", ENTRY, "--version"], { stdout: "pipe", stderr: "pipe" });
    expect(version.stdout.toString()).toMatch(/^prime /);
    expect(version.stderr.toString()).not.toContain("MCP server");
    // Two bun subprocesses on a cold Windows runner can take longer than the
    // five seconds bun gives a test by default; the test is about what the
    // commands do, not about how fast the runner is.
  }, 30_000);

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
    // An explicit flag (direct "prime code-mcp" use) wins over the environment.
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
    const dir = mkdtempSync(join(tmpdir(), "prime-host-"));
    const probe = join(dir, "probe.ts");
    await Bun.write(
      probe,
      `const real = Bun.argv; Bun.plugin({ name: "probe", setup(b) { b.onLoad({ filter: /code-mcp\\.ts$/ }, () => ({ loader: "js", contents: "console.log(JSON.stringify({ argv: Bun.argv.slice(2), env: process.env.${GATEWAY_TOKEN_ENV} ?? null })); process.exit(0);" })); } }); void real;`,
    );
    // As 'prime connect' launches it: raw, exactly these arguments.
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
      env: { ...process.env, PRIME_CONFIG: config },
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
  ws_url: "wss://gw.test/device/ws/anon-0123456789abcdef",
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
  /** The code this one replaced (good for a day, but only to repeat a call). */
  previous?: string;
  online: boolean;
  tools: { name: string; description?: string; inputSchema?: unknown }[];
}

const fake = {
  devices: new Map<string, FakeDevice>(),
  created: 0,
  /** Forced status for POST /api/devices/anonymous (0 = normal). */
  anonStatus: 0,
  /** Forced status for POST /api/devices/anonymous/rotate (0 = normal). */
  rotateStatus: 0,
  rotated: 0,
  /** The next rotation is applied but its answer is lost. */
  loseAnswer: false,
  operatorToken: "operator-secret",
  rotateCalls: [] as Array<{ id: string; proposed: string; presented: string; operator: boolean }>,
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
            connect_url: `${url.origin}/device/${deviceId}?token=${token}`,
            ws_url: `ws://${url.host}/device/ws/${deviceId}`,
            anonymous: true,
            rate_limit: { max: 30, window_ms: 60000 },
          },
          { status: 201 },
        );
      }
      const opRotate = /^\/api\/devices\/anonymous\/([^/]+)\/rotate$/.exec(url.pathname);
      if ((url.pathname === "/api/devices/anonymous/rotate" || opRotate) && request.method === "POST") {
        // What the registry decides: only the current code asks, the replaced one may only repeat a call
        // that is done, the operator needs no code.
        const operator = opRotate !== null;
        const id = operator ? decodeURIComponent(opRotate![1]!) : (request.headers.get("x-prime-device") ?? "");
        const device = fake.devices.get(id);
        const proposed = ((await request.json().catch(() => ({}))) as { proposed?: string }).proposed ?? "";
        fake.rotateCalls.push({ id, proposed, presented: request.headers.get("x-device-token") ?? "", operator });
        if (fake.rotateStatus) return Response.json({ error: "no" }, { status: fake.rotateStatus, headers: { "retry-after": "90" } });
        if (operator && request.headers.get("authorization") !== "Bearer " + fake.operatorToken) return Response.json({ error: "no" }, { status: 403 });
        if (!device) return Response.json({ error: "unauthorized" }, { status: 401 });
        const presented = request.headers.get("x-device-token") ?? "";
        if (!/^[0-9A-Z]{25}$/.test(proposed)) return Response.json({ error: "bad code" }, { status: 400 });
        const answer = (repeated: boolean) =>
          Response.json({ deviceId: id, token: proposed, previous_valid_ms: 86_400_000, anonymous: true, ...(repeated ? { repeated: true } : {}) });
        const isCurrent = presented === device.token;
        const isBefore = device.previous !== undefined && presented === device.previous;
        if (proposed === device.token && (operator || isCurrent || isBefore)) return answer(true);
        if (!operator && !isCurrent) return isBefore ? Response.json({ error: "replaced" }, { status: 409 }) : Response.json({ error: "unauthorized" }, { status: 401 });
        fake.rotated++;
        device.previous = device.token;
        device.token = proposed;
        if (fake.loseAnswer) {
          fake.loseAnswer = false;
          return new Response("gateway timeout", { status: 504 }); // applied, and the caller never learns it
        }
        return answer(false);
      }
      const m = /^\/device\/([^/]+)$/.exec(url.pathname);
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
  fake.rotateStatus = 0;
  fake.loseAnswer = false;
  fake.rotateCalls.length = 0;
});

function freshConfig(): string {
  return join(mkdtempSync(join(tmpdir(), "prime-features-")), "config.yaml");
}

async function cli(args: string[], config: string, stdin?: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", ENTRY, ...args], {
    env: { ...process.env, PRIME_CONFIG: config, NO_COLOR: "1", PRIME_GATEWAY_URL: "" },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

// ---- prime connect -------------------------------------------------------------------------

describe("prime connect (fake gateway)", () => {
  test("registers once, saves the device, and reuses it on later runs", async () => {
    const config = freshConfig();
    const before = fake.created;
    const first = await cli(["connect", "--gateway", GATEWAY, "--no-start", "--json"], config);
    expect(first.code).toBe(0);
    const j = JSON.parse(first.out) as { device: string; token: string; connect_url: string; reused: boolean; gateway: string };
    expect(j.reused).toBe(false);
    expect(j.gateway).toBe(GATEWAY);
    expect(j.connect_url).toBe(`${GATEWAY}/device/${j.device}?token=${j.token}`);
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
    expect(human.out).toContain(`${GATEWAY}/device/${j.device}?token=${j.token}`);

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

  test("the saved device works with 'prime tools list'", async () => {
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

// ---- prime serve ----------------------------------------------------------------------------

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

describe("prime serve over stdio", () => {
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

describe("prime serve over HTTP", () => {
  test("POST /mcp answers JSON-RPC, GET is 405, notifications are 202", async () => {
    const config = serveFixture();
    const proc = Bun.spawn(["bun", ENTRY, "serve", "--port", "0"], {
      env: { ...process.env, PRIME_CONFIG: config, NO_COLOR: "1", PRIME_GATEWAY_URL: "" },
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
      expect(((await init.json()) as any).result.serverInfo.name).toBe("prime");
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

// ---- prime devices rotate-code ---------------------------------------------------------------

describe("prime devices rotate-code (fake gateway)", () => {
  /** A device made through the fake gateway, and its config. */
  async function made(): Promise<{ config: string; device: string; token: string }> {
    const config = freshConfig();
    const j = JSON.parse((await cli(["connect", "--gateway", GATEWAY, "--no-start", "--json"], config)).out) as { device: string; token: string };
    return { config, device: j.device, token: j.token };
  }
  const rotate = (config: string, device: string, ...more: string[]) => cli(["devices", "rotate-code", device, "--gateway", GATEWAY, ...more], config);

  test("the code is made here, the gateway is shown the old one, and the new one becomes the device's, and the spaces' exposed as it", async () => {
    const { config, device, token } = await made();
    const doc = loadConfig(config);
    doc.spaces.dev = { token: "local", gateway: GATEWAY, gateway_device: device, remote_token: token } as never;
    doc.spaces.other = { token: "local2", gateway_device: "someone-else", remote_token: "keep-me" } as never;
    saveConfig(config, doc);

    const run = await rotate(config, device, "--json");
    expect(run.code).toBe(0);
    expect(JSON.parse(run.out)).toMatchObject({ rotated: true, repeated: false, saved: true, spaces: ["dev"], previous_valid_ms: 86_400_000 });
    const after = loadConfig(config);
    const entry = after.devices[device]!;
    expect(entry.token).toMatch(/^[0-9A-Z]{25}$/);
    expect(entry.token).not.toBe(token);
    expect(entry.pending_token).toBeUndefined();
    expect(entry.anonymous).toBe(true);
    expect(after.spaces.dev!.remote_token).toBe(entry.token!);
    expect(after.spaces.other!.remote_token).toBe("keep-me");
    // What was sent: the gateway was shown the old code and was told the new one, which it now holds.
    expect(fake.rotateCalls).toEqual([{ id: device, proposed: entry.token!, presented: token, operator: false }]);
    expect(fake.devices.get(device)!.token).toBe(entry.token!);
    expect(fake.devices.get(device)!.previous).toBe(token);
  });

  test("the human answer says the old code keeps working and what to restart", async () => {
    const { config, device } = await made();
    const run = await rotate(config, device);
    expect(run.code).toBe(0);
    expect(run.out).toContain("new 25-character code");
    expect(run.out).toContain("the old code keeps working for 24 h");
    expect(run.out).toContain("restart it within 24 h");
  });

  test("a call whose answer was lost: running it again sends the same code, and the old code's day is not started a second time", async () => {
    const { config, device, token } = await made();
    const before = fake.rotated;
    fake.loseAnswer = true;
    const first = await rotate(config, device);
    expect(first.code).not.toBe(0);
    // The gateway applied it; this machine was not told. Its config holds the proposal, and still the old code.
    const mid = loadConfig(config).devices[device]!;
    expect(mid.token).toBe(token);
    expect(mid.pending_token).toMatch(/^[0-9A-Z]{25}$/);
    expect(fake.devices.get(device)!.token).toBe(mid.pending_token!);
    const proposal = mid.pending_token!;

    const again = await rotate(config, device, "--json");
    expect(again.code).toBe(0);
    expect(JSON.parse(again.out)).toMatchObject({ rotated: true, repeated: true });
    // The same code twice; no second code was made, and the gateway still holds the ORIGINAL as the one before.
    expect(fake.rotateCalls.map((c) => c.proposed)).toEqual([proposal, proposal]);
    expect(fake.rotated).toBe(before + 1);
    expect(fake.devices.get(device)!.previous).toBe(token);
    const after = loadConfig(config).devices[device]!;
    expect(after.token).toBe(proposal);
    expect(after.pending_token).toBeUndefined();
  });

  test("a crash between saving the proposal and the call: the next run sends what was saved", async () => {
    const { config, device, token } = await made();
    // What a process that died right after step one leaves behind.
    const saved = "SAVEDBEFORECRASH000000A".padEnd(25, "Z");
    const doc = loadConfig(config);
    doc.devices[device] = { ...doc.devices[device]!, pending_token: saved };
    saveConfig(config, doc);
    const run = await rotate(config, device);
    expect(run.code).toBe(0);
    expect(fake.rotateCalls).toEqual([{ id: device, proposed: saved, presented: token, operator: false }]);
    expect(loadConfig(config).devices[device]!.token).toBe(saved);
  });

  test("a crash after the gateway had applied it but before the config was promoted is finished by the next run", async () => {
    const { config, device, token } = await made();
    const proposal = "CRASHAFTERCALL".padEnd(25, "7");
    const before = fake.rotated;
    // The gateway holds the proposal; the config holds the old code and the proposal.
    const g = fake.devices.get(device)!;
    g.previous = g.token;
    g.token = proposal;
    const doc = loadConfig(config);
    doc.devices[device] = { ...doc.devices[device]!, pending_token: proposal };
    saveConfig(config, doc);
    const run = await rotate(config, device, "--json");
    expect(run.code).toBe(0);
    expect(JSON.parse(run.out)).toMatchObject({ repeated: true });
    expect(fake.rotated).toBe(before);
    expect(loadConfig(config).devices[device]!.token).toBe(proposal);
    expect(token).not.toBe(proposal);
  });

  test("the code that was replaced cannot rotate: the thief is refused, and the owner's code is left alone", async () => {
    const owner = await made();
    expect((await rotate(owner.config, owner.device)).code).toBe(0);
    const ownerCode = loadConfig(owner.config).devices[owner.device]!.token!;
    // Someone who kept the old six-character code (here: the code the device was made with).
    const thief = freshConfig();
    const doc = loadConfig(thief);
    doc.devices[owner.device] = { gateway: GATEWAY, token: owner.token, anonymous: true };
    saveConfig(thief, doc);
    const run = await rotate(thief, owner.device);
    expect(run.code).not.toBe(0);
    expect(run.err).toContain("replaced");
    expect(run.err).toContain("--operator");
    expect(fake.devices.get(owner.device)!.token).toBe(ownerCode);
    // The proposal stays in the thief's config as pending, and was never the gateway's.
    expect(loadConfig(thief).devices[owner.device]!.token).toBe(owner.token);
  });

  test("a config that lost the promotion (an older write put the old code back) finds its way home: the proposal is presented as the code", async () => {
    const { config, device, token } = await made();
    const proposal = "LOSTPROMOTION".padEnd(25, "3");
    const g = fake.devices.get(device)!;
    g.previous = g.token;
    g.token = proposal;
    // The day is over: the old code is not even remembered as the one before.
    g.previous = undefined;
    const doc = loadConfig(config);
    doc.devices[device] = { ...doc.devices[device]!, pending_token: proposal };
    saveConfig(config, doc);
    const run = await rotate(config, device);
    expect(run.code).toBe(0);
    expect(fake.rotateCalls.map((c) => c.presented)).toEqual([token, proposal]);
    expect(loadConfig(config).devices[device]!.token).toBe(proposal);
  });

  test("the operator needs no code of the device, and the config keeps what the command did not touch", async () => {
    const { config, device, token } = await made();
    const doc = loadConfig(config);
    doc.defaults.fleet_operator_token = "operator-secret";
    doc.defaults.gateway = GATEWAY;
    saveConfig(config, doc);
    const run = await cli(["devices", "rotate-code", device, "--operator", "--json"], config);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.out)).toMatchObject({ rotated: true, saved: true });
    expect(fake.rotateCalls[0]).toMatchObject({ id: device, operator: true, presented: "" });
    const after = loadConfig(config);
    expect(after.devices[device]!.token).toBe(fake.devices.get(device)!.token);
    expect(after.devices[device]!.token).not.toBe(token);
    expect(after.defaults.gateway).toBe(GATEWAY);
  });

  test("the operator who does not hold the device is shown the code once, and nothing is saved", async () => {
    const { device } = await made();
    const config = freshConfig();
    const run = await cli(["devices", "rotate-code", device, "--operator", "--operator-token", "operator-secret", "--gateway", GATEWAY, "--json"], config);
    expect(run.code).toBe(0);
    const j = JSON.parse(run.out) as { saved: boolean; token: string };
    expect(j.saved).toBe(false);
    expect(j.token).toBe(fake.devices.get(device)!.token);
    expect(loadConfig(config).devices[device]).toBeUndefined();
  });

  test("--operator without a credential is a usage error, and a wrong one is refused", async () => {
    const { config, device, token } = await made();
    const none = await rotate(config, device, "--operator");
    expect(none.code).not.toBe(0);
    expect(none.err).toContain("operator credential");
    const wrong = await rotate(config, device, "--operator", "--operator-token", "nope");
    expect(wrong.code).not.toBe(0);
    expect(wrong.err).toContain("operator");
    expect(fake.devices.get(device)!.token).toBe(token);
  });

  test("a change another command made to the config after this one began is not lost", async () => {
    // updateConfig reads the file again under the lock: a space added after the command's start survives the promotion.
    const { config, device } = await made();
    updateConfig(config, (c) => {
      c.spaces.late = { token: "t", gateway_device: device, remote_token: "old" } as never;
    });
    expect((await rotate(config, device)).code).toBe(0);
    const after = loadConfig(config);
    expect(after.spaces.late!.remote_token).toBe(after.devices[device]!.token!);
  });

  test("nothing is saved as the device's code when the gateway refuses, and a device with no saved code is a usage error", async () => {
    const { config, device, token } = await made();
    fake.rotateStatus = 429;
    const limited = await rotate(config, device);
    expect(limited.code).not.toBe(0);
    expect(limited.err).toContain("try again in");
    fake.rotateStatus = 404;
    const old = await rotate(config, device);
    expect(old.code).not.toBe(0);
    expect(old.err).toContain("gateway is older");
    expect(loadConfig(config).devices[device]!.token).toBe(token);
    const none = await rotate(config, "nobody-here");
    expect(none.code).not.toBe(0);
    expect(none.err).toContain("no token is saved");
    const missing = await cli(["devices", "rotate-code"], config);
    expect(missing.code).not.toBe(0);
    expect(missing.err).toContain("missing <device-id>");
  });
});

// ---- the config is saved by every command through one door ----------------------------------

describe("saving the config: what another command saved meanwhile is kept", () => {
  const seed = () => {
    const path = freshConfig();
    const c = emptyConfig();
    c.devices.x = { gateway: "https://g.example", token: "X0", note: "first", anonymous: true };
    c.devices.keep = { gateway: "https://g.example", token: "K0" };
    c.spaces.s = { token: "st", gateway_device: "x", remote_token: "X0" } as never;
    saveConfig(path, c);
    return path;
  };

  test("two commands that read the config at the same time: neither change is lost, in either order", () => {
    for (const order of ["ab", "ba"]) {
      const path = seed();
      const a = loadConfig(path); // a `prime spaces ...` that began first and is slow
      const b = loadConfig(path); // a `prime devices connect ...`
      a.spaces.t = { token: "tt" } as never;
      b.devices.y = { gateway: "https://g.example", token: "Y0" };
      for (const who of order) saveConfig(path, who === "a" ? a : b);
      const after = loadConfig(path);
      expect(Object.keys(after.devices).sort()).toEqual(["keep", "x", "y"]);
      expect(Object.keys(after.spaces).sort()).toEqual(["s", "t"]);
      // The one that saved first is brought up to date in the process that saved second.
      expect(Object.keys((order === "ab" ? b : a).devices).sort()).toContain("keep");
    }
  });

  test("a code that another command saved is not put back by a command that did not touch it", () => {
    const path = seed();
    const slow = loadConfig(path);
    updateConfig(path, (c) => {
      c.devices.x = { ...c.devices.x!, token: "X1-NEW", pending_token: undefined };
      c.spaces.s!.remote_token = "X1-NEW";
    });
    slow.spaces.late = { token: "l" } as never;
    saveConfig(path, slow);
    const after = loadConfig(path);
    expect(after.devices.x!.token).toBe("X1-NEW");
    expect(after.spaces.s!.remote_token).toBe("X1-NEW");
    expect(after.spaces.late).toBeDefined();
  });

  test("two fields of one entry changed by two commands both stay; one both changed is the later save's", () => {
    const path = seed();
    const a = loadConfig(path);
    const b = loadConfig(path);
    a.devices.x!.note = "from a";
    b.devices.x!.token = "X-from-b";
    saveConfig(path, a);
    saveConfig(path, b);
    expect(loadConfig(path).devices.x).toMatchObject({ note: "from a", token: "X-from-b" });
    const c = loadConfig(path);
    const d = loadConfig(path);
    c.devices.x!.note = "c";
    d.devices.x!.note = "d";
    saveConfig(path, c);
    saveConfig(path, d);
    expect(loadConfig(path).devices.x!.note).toBe("d");
  });

  test("what a command removed is removed, and what another command added stays", () => {
    const path = seed();
    const a = loadConfig(path);
    const b = loadConfig(path);
    delete a.devices.x;
    delete a.spaces.s;
    b.devices.added = { token: "A0" };
    saveConfig(path, b);
    saveConfig(path, a);
    const after = loadConfig(path);
    expect(Object.keys(after.devices).sort()).toEqual(["added", "keep"]);
    expect(after.spaces).toEqual({});
    expect(Object.keys(a.devices).sort()).toEqual(["added", "keep"]);
  });

  test("an entry another command removed stays removed, though a slower command changed a field of it", () => {
    const path = seed();
    const slow = loadConfig(path);
    const disconnect = loadConfig(path);
    delete disconnect.devices.x;
    delete disconnect.spaces.s;
    saveConfig(path, disconnect);
    slow.devices.x!.note = "touched late";
    slow.spaces.s!.remote_token = "R-late";
    saveConfig(path, slow);
    const after = loadConfig(path);
    expect(after.devices.x).toBeUndefined();
    expect(after.spaces.s).toBeUndefined();
    expect(after.devices.keep).toBeDefined();
    // And the slow command's own view agrees with the file.
    expect(slow.devices.x).toBeUndefined();
  });

  test("a command that removes an entry another changed meanwhile removes it", () => {
    const path = seed();
    const slow = loadConfig(path);
    updateConfig(path, (c) => {
      c.devices.x!.note = "changed by another";
    });
    delete slow.devices.x;
    saveConfig(path, slow);
    expect(loadConfig(path).devices.x).toBeUndefined();
  });

  test("a space made from the code a device had, by a command that read it before the code was made again, is given the new code", () => {
    const path = seed();
    const slow = loadConfig(path);
    const oldCode = slow.devices.x!.token!;
    updateConfig(path, (c) => {
      c.devices.x!.token = "X1-NEW".padEnd(25, "0");
      c.spaces.s!.remote_token = "X1-NEW".padEnd(25, "0");
    });
    slow.spaces.s2 = { token: "t2", gateway_device: "x", remote_token: oldCode } as never;
    saveConfig(path, slow);
    const after = loadConfig(path);
    expect(after.devices.x!.token).toBe("X1-NEW".padEnd(25, "0"));
    expect(after.spaces.s!.remote_token).toBe("X1-NEW".padEnd(25, "0"));
    expect(after.spaces.s2!.remote_token).toBe("X1-NEW".padEnd(25, "0"));
    expect(slow.spaces.s2!.remote_token).toBe("X1-NEW".padEnd(25, "0"));
  });

  test("a value this command only carried never beats a newer one, and a value it changed does (the later save wins)", () => {
    const path = seed();
    const carried = loadConfig(path); // never touches the token
    const changed = loadConfig(path);
    updateConfig(path, (c) => {
      c.devices.x!.token = "ROTATED".padEnd(25, "0");
    });
    carried.devices.x!.note = "carried token, changed note";
    saveConfig(path, carried);
    expect(loadConfig(path).devices.x!.token).toBe("ROTATED".padEnd(25, "0"));
    changed.devices.x!.token = "DELIBERATE";
    saveConfig(path, changed);
    expect(loadConfig(path).devices.x!.token).toBe("DELIBERATE");
  });

  test("objects the caller holds stay live across a save: a later change to one is saved too", () => {
    const path = seed();
    const cfg = loadConfig(path);
    const space = cfg.spaces.s!;
    updateConfig(path, (c) => {
      c.devices.other = { token: "O" };
    });
    saveConfig(path, cfg);
    expect(cfg.spaces.s).toBe(space);
    expect(cfg.devices.other).toBeDefined();
    space.remote_token = "X-LATER";
    saveConfig(path, cfg);
    expect(loadConfig(path).spaces.s!.remote_token).toBe("X-LATER");
  });

  test("a config that was not read from the file is written as it is, and the file is private", () => {
    const path = seed();
    const fresh = emptyConfig();
    fresh.devices.only = { token: "O" };
    saveConfig(path, fresh);
    expect(Object.keys(loadConfig(path).devices)).toEqual(["only"]);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("no file in the config's directory is left behind but the lock's home", () => {
    const path = seed();
    const cfg = loadConfig(path);
    cfg.devices.z = { token: "Z" };
    saveConfig(path, cfg);
    const dir = path.slice(0, path.lastIndexOf("/") > 0 ? path.lastIndexOf("/") : path.lastIndexOf("\\"));
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("no command writes the config file by any road but saveConfig and updateConfig", () => {
    const src = fileURLToPath(new URL("../src/", import.meta.url));
    const offenders: string[] = [];
    for (const file of readdirSync(src).filter((f) => f.endsWith(".ts") && f !== "config.ts")) {
      const text = readFileSync(join(src, file), "utf8");
      if (/serializeConfig\(/.test(text)) offenders.push(file + ": serializeConfig");
      if (/(writeFileSync|writeFileAtomic|renameSync)\([^)]*(configPath|config\.yaml)/.test(text)) offenders.push(file + ": writes the config path");
    }
    expect(offenders).toEqual([]);
  });

  test("commands that race as processes: every device connected, the one disconnected gone, the code made again kept", async () => {
    const config = seed();
    const target = loadConfig(config);
    target.devices.gone = { gateway: GATEWAY, token: "G" };
    saveConfig(config, target);
    const ids = ["r1", "r2", "r3", "r4", "r5", "r6"];
    const runs = [
      ...ids.map((id) => cli(["devices", "connect", id, "--gateway", GATEWAY, "--token", "tok-" + id, "--no-verify"], config)),
      cli(["devices", "disconnect", "gone"], config),
    ];
    const results = await Promise.all(runs);
    for (const r of results) expect(r.code).toBe(0);
    const after = loadConfig(config);
    expect(Object.keys(after.devices).sort()).toEqual(["keep", "r1", "r2", "r3", "r4", "r5", "r6", "x"]);
    for (const id of ids) expect(after.devices[id]!.token).toBe("tok-" + id);
  });
});
