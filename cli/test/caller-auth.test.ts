// Signed tool calls, the device side: what a device runs when the gateway tunnels a call in. Offline:
// CallerAuth is driven directly, and one test runs the real code-mcp against a stub gateway.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CallerAuth, type CallerAuthMode, REPLY_SIG_HEADER, parseCallerAuthMode, verifyReplySig } from "../src/caller-auth.ts";
import { addCaller, loadOrCreateCallerKey, parseCallSig, signCall } from "../src/caller-key.ts";
import { GatewayClient } from "../src/client.ts";
import { CallSigner } from "../src/caller-key.ts";
import { optionsFromConfig, parseCodeMcpArgs, toCodeMcpArgv } from "../src/code-mcp-options.ts";
import { checkDeviceKey } from "../src/device-pins.ts";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "prime-auth-"));
  dirs.push(d);
  return d;
}

const BASH = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bash", arguments: { command: "id" } } });
const LIST = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });

function setup(mode: CallerAuthMode, options: { now?: () => number } = {}) {
  const dir = scratch();
  const callers = join(dir, "callers.json");
  const key = loadOrCreateCallerKey(join(dir, "me.pem"));
  const logs: string[] = [];
  const auth = new CallerAuth({ mode, deviceId: "laptop", callersFile: callers, log: (t) => logs.push(t), ...options });
  const sign = (raw: string, target = "device:laptop", o: { now?: number; nonce?: string } = {}) => signCall(key, target, raw, o);
  const frame = (raw: string, sig?: string) => ({ request: JSON.parse(raw), ...(sig ? { raw, callerSig: sig } : {}) });
  const logFile = join(dir, "caller-auth", "caller-auth.log");
  return { dir, callers, key, auth, logs, sign, frame, logFile };
}

function refusedWith(a: ReturnType<CallerAuth["admit"]>): string | undefined {
  return a.action === "refuse" ? (a.response.error.data.reason as string) : undefined;
}

describe("CallerAuth: the policy", () => {
  test("off checks nothing", () => {
    const t = setup("off");
    const a = t.auth.admit(t.frame(BASH));
    expect(a.action).toBe("run");
    expect(existsSync(t.logFile)).toBe(false);
  });

  test("warn runs an unsigned call and writes it to the log; listing tools is not logged", () => {
    const t = setup("warn");
    expect(t.auth.admit(t.frame(BASH)).action).toBe("run");
    expect(t.auth.admit(t.frame(LIST)).action).toBe("run");
    const lines = readFileSync(t.logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ mode: "warn", reason: "unsigned", outcome: "ran", method: "tools/call", tool: "bash" });
    expect(t.auth.counts.unsigned).toBe(1);
    // The arguments of the call are never logged.
    expect(JSON.stringify(lines[0])).not.toContain("id\"");
    // The service log hears of it once.
    t.auth.admit(t.frame(BASH));
    expect(t.logs).toHaveLength(1);
  });

  test("enforce refuses a call the gateway made up: no signature, so it does not run (H-1a)", () => {
    const t = setup("enforce");
    addCaller(t.callers, { pub: t.key.publicKey });
    const a = t.auth.admit(t.frame(BASH));
    expect(a.action).toBe("refuse");
    if (a.action === "refuse") {
      expect(a.response.error.code).toBe(-32001);
      expect(a.response.error.message).toContain("prime devices allow-caller");
      expect(a.response.id).toBe(1);
    }
    expect(t.auth.counts.refused).toBe(1);
    // ...while the calls that reveal only the tool list still pass, and a malformed request runs nothing.
    expect(t.auth.admit(t.frame(LIST)).action).toBe("run");
    expect(t.auth.admit({ request: { jsonrpc: "2.0", id: 3, method: "ping" } }).action).toBe("run");
    expect(t.auth.admit({ request: { jsonrpc: "2.0", id: 4, method: "notifications/initialized" } }).action).toBe("run");
  });

  test("enforce refuses everything that needs a signature when no key is trusted at all", () => {
    const t = setup("enforce");
    expect(refusedWith(t.auth.admit(t.frame(BASH, t.sign(BASH))))).toBe("unknown-key");
  });
});

describe("CallerAuth: a signed call", () => {
  test("from a trusted key runs, from the signed body and not from the request the gateway wrote", () => {
    const t = setup("enforce");
    addCaller(t.callers, { pub: t.key.publicKey, label: "laptop" });
    const evil = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bash", arguments: { command: "rm -rf /" } } };
    const a = t.auth.admit({ request: evil, raw: BASH, callerSig: t.sign(BASH) });
    expect(a.action).toBe("run");
    if (a.action === "run") {
      expect(a.request).toEqual(JSON.parse(BASH));
      expect(a.keyId).toBe(t.key.keyId);
      expect(a.nonce).toBeDefined();
    }
    expect(t.auth.counts.signed).toBe(1);
  });

  test("a valid signature on a ping does not let a different request through", () => {
    const t = setup("enforce");
    addCaller(t.callers, { pub: t.key.publicKey });
    const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const a = t.auth.admit({ request: JSON.parse(BASH), raw: ping + " ", callerSig: t.sign(ping) });
    expect(refusedWith(a)).toBe("bad-signature");
  });

  const refusals: [string, (t: ReturnType<typeof setup>) => ReturnType<CallerAuth["admit"]>, string][] = [
    ["a body changed after signing", (t) => t.auth.admit(t.frame(BASH.replace("id", "ls"), t.sign(BASH))), "bad-signature"],
    ["the wrong target", (t) => t.auth.admit(t.frame(BASH, t.sign(BASH, "device:other"))), "bad-signature"],
    ["a fleet target (not accepted by a device on its own)", (t) => t.auth.admit(t.frame(BASH, t.sign(BASH, "fleet:acme"))), "bad-signature"],
    ["a time in the past", (t) => t.auth.admit(t.frame(BASH, t.sign(BASH, "device:laptop", { now: Date.now() - 6 * 60_000 }))), "stale"],
    ["a time in the future", (t) => t.auth.admit(t.frame(BASH, t.sign(BASH, "device:laptop", { now: Date.now() + 6 * 60_000 }))), "stale"],
    ["a key that is not trusted", (t) => {
      const other = loadOrCreateCallerKey(join(t.dir, "other.pem"));
      return t.auth.admit(t.frame(BASH, signCall(other, "device:laptop", BASH)));
    }, "unknown-key"],
    ["a header that is not a signature", (t) => t.auth.admit(t.frame(BASH, "v1.nope")), "malformed"],
    ["a signature with no body to check it against", (t) => t.auth.admit({ request: JSON.parse(BASH), callerSig: t.sign(BASH) }), "no-raw"],
  ];
  for (const [name, run, reason] of refusals) {
    test(`is refused in enforce mode: ${name}`, () => {
      const t = setup("enforce");
      addCaller(t.callers, { pub: t.key.publicKey });
      expect(refusedWith(run(t))).toBe(reason);
      expect(t.auth.counts.invalid).toBe(1);
    });
  }

  test("a failed check in warn mode still runs the call and logs why", () => {
    const t = setup("warn");
    addCaller(t.callers, { pub: t.key.publicKey });
    const a = t.auth.admit(t.frame(BASH, t.sign(BASH, "device:other")));
    expect(a.action).toBe("run");
    expect(JSON.parse(readFileSync(t.logFile, "utf8").trim())).toMatchObject({ reason: "bad-signature", outcome: "ran", key: t.key.keyId });
  });

  test("replaying the same signed call is refused, and the same nonce from another key is not a replay", () => {
    const t = setup("enforce");
    addCaller(t.callers, { pub: t.key.publicKey });
    const sig = t.sign(BASH);
    expect(t.auth.admit(t.frame(BASH, sig)).action).toBe("run");
    expect(refusedWith(t.auth.admit(t.frame(BASH, sig)))).toBe("replay");
    const other = loadOrCreateCallerKey(join(t.dir, "other.pem"));
    addCaller(t.callers, { pub: other.publicKey });
    const nonce = parseCallSig(sig)!.nonce;
    expect(t.auth.admit(t.frame(BASH, signCall(other, "device:laptop", BASH, { nonce }))).action).toBe("run");
  });

  test("a forged signature does not use up a nonce", () => {
    const t = setup("enforce");
    addCaller(t.callers, { pub: t.key.publicKey });
    const good = t.sign(BASH, "device:laptop", { nonce: "bm9uY2U" });
    const forged = good.replace(/\.[^.]+$/, "." + "A".repeat(86));
    expect(refusedWith(t.auth.admit(t.frame(BASH, forged)))).toBe("bad-signature");
    expect(t.auth.admit(t.frame(BASH, good)).action).toBe("run");
  });

  test("a nonce is forgotten after ten minutes (the time window is five)", () => {
    let now = Date.now();
    const t = setup("enforce", { now: () => now });
    addCaller(t.callers, { pub: t.key.publicKey });
    const sig = t.sign(BASH, "device:laptop", { now });
    expect(t.auth.admit(t.frame(BASH, sig)).action).toBe("run");
    now += 4 * 60_000;
    expect(refusedWith(t.auth.admit(t.frame(BASH, sig)))).toBe("replay");
    now += 7 * 60_000; // forgotten, but the signature is by now too old to be accepted
    expect(refusedWith(t.auth.admit(t.frame(BASH, sig)))).toBe("stale");
  });

  test("the table of nonces is bounded", () => {
    const t = setup("enforce");
    addCaller(t.callers, { pub: t.key.publicKey });
    for (let i = 0; i < 10_050; i++) expect(t.auth.admit(t.frame(BASH, t.sign(BASH))).action).toBe("run");
    const sig = t.sign(BASH);
    expect(t.auth.admit(t.frame(BASH, sig)).action).toBe("run");
    expect(refusedWith(t.auth.admit(t.frame(BASH, sig)))).toBe("replay");
  });

  test("a key limited to some tools runs those and no others", () => {
    const t = setup("enforce");
    addCaller(t.callers, { pub: t.key.publicKey, tools: ["read"] });
    expect(refusedWith(t.auth.admit(t.frame(BASH, t.sign(BASH))))).toBe("tool-not-allowed");
    const read = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read", arguments: { path: "a" } } });
    expect(t.auth.admit(t.frame(read, t.sign(read))).action).toBe("run");
  });

  test("allow-caller and revoke-caller take effect without a restart; an unreadable file runs nothing", () => {
    const t = setup("enforce");
    expect(refusedWith(t.auth.admit(t.frame(BASH, t.sign(BASH))))).toBe("unknown-key");
    addCaller(t.callers, { pub: t.key.publicKey });
    expect(t.auth.admit(t.frame(BASH, t.sign(BASH))).action).toBe("run");
    writeFileSync(t.callers, "{ broken");
    expect(refusedWith(t.auth.admit(t.frame(BASH, t.sign(BASH))))).toBe("callers-unreadable");
    expect(t.auth.hasCallers()).toBe(true);
  });
});

describe("CallerAuth: the reply", () => {
  test("is signed over the call's nonce and the exact response, with the device's own key", () => {
    const t = setup("enforce");
    const resp = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "uid=1" }] } });
    const header = t.auth.replySig("bm9uY2U", resp)!;
    expect(header.startsWith("v1.")).toBe(true);
    const pub = verifyReplySig(header, "bm9uY2U", resp);
    expect(pub).toBeDefined();
    expect(existsSync(join(t.dir, "caller-auth", "device-ed25519.pem"))).toBe(true);
    expect(verifyReplySig(header, "bm9uY2U", resp + " ")).toBeUndefined();
    expect(verifyReplySig(header, "other", resp)).toBeUndefined();
    // The same device key signs every reply.
    expect(verifyReplySig(t.auth.replySig("x", resp)!, "x", resp)?.equals(pub!)).toBe(true);
  });
});

describe("the CLI checks a device's reply signature", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.PRIME_DEVICE_KEYS;
  });
  const target = { deviceId: "laptop", gateway: "https://gw.test", timeoutMs: 5000 };

  /** A device that signs its replies with `device` (a key under dirs), through a gateway that returns them. */
  function deviceStub(auth: CallerAuth, tamper = false) {
    globalThis.fetch = (async (_u: string | URL, init?: RequestInit) => {
      const hdrs = init?.headers as Record<string, string>;
      const nonce = parseCallSig(hdrs["x-prime-call-sig"])!.nonce;
      const text = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } });
      return new Response(tamper ? text.replace("ok", "no") : text, { headers: { [REPLY_SIG_HEADER]: auth.replySig(nonce, text)! } });
    }) as unknown as typeof fetch;
  }
  const newAuth = () => new CallerAuth({ mode: "warn", deviceId: "laptop", callersFile: join(scratch(), "c.json") });
  const newClient = (notices: string[]) =>
    new GatewayClient(target, { signer: new CallSigner({ path: join(scratch(), "k.pem") }), notice: (t) => notices.push(t) });

  test("a good reply pins the device's key and says nothing", async () => {
    process.env.PRIME_DEVICE_KEYS = join(scratch(), "pins.json");
    const notices: string[] = [];
    deviceStub(newAuth());
    await newClient(notices).callTool("bash", {}, { handshake: "never" });
    expect(notices).toEqual([]);
    expect(Object.keys(JSON.parse(readFileSync(process.env.PRIME_DEVICE_KEYS, "utf8")))).toEqual(["laptop@https://gw.test"]);
  });

  test("a reply that was changed on the way, or signed by another key than the first, is reported once", async () => {
    process.env.PRIME_DEVICE_KEYS = join(scratch(), "pins.json");
    const notices: string[] = [];
    const client = newClient(notices);
    deviceStub(newAuth());
    await client.callTool("bash", {}, { handshake: "never" }); // pins
    deviceStub(newAuth(), true);
    await client.callTool("bash", {}, { handshake: "never" });
    await client.callTool("bash", {}, { handshake: "never" });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("does not match");
    deviceStub(newAuth()); // a good signature, by a key that is not the pinned one
    await client.callTool("bash", {}, { handshake: "never" });
    expect(notices).toHaveLength(2);
    expect(notices[1]).toContain("different key");
  });

  test("a reply with no signature (an older device) is accepted without a word", async () => {
    process.env.PRIME_DEVICE_KEYS = join(scratch(), "pins.json");
    const notices: string[] = [];
    globalThis.fetch = (async () => new Response('{"jsonrpc":"2.0","id":1,"result":{}}')) as unknown as typeof fetch;
    await newClient(notices).callTool("bash", {}, { handshake: "never" });
    expect(notices).toEqual([]);
    expect(existsSync(process.env.PRIME_DEVICE_KEYS)).toBe(false);
    expect(checkDeviceKey("g", "d", Buffer.alloc(32, 1), process.env.PRIME_DEVICE_KEYS)).toBe("pinned");
  });
});

describe("--caller-auth and --callers", () => {
  test("are code-mcp options, checked where they are given", () => {
    expect(parseCodeMcpArgs(["--caller-auth", "enforce", "--callers", "/x/callers.json"]).options).toEqual({
      "caller-auth": "enforce",
      callers: "/x/callers.json",
    });
    expect(() => parseCodeMcpArgs(["--caller-auth", "strict"])).toThrow(/off, warn or enforce/);
    expect(() => parseCodeMcpArgs(["--caller-auth=nope"])).toThrow(/off, warn or enforce/);
    expect(() => optionsFromConfig({ "caller-auth": "loud" }, "config.yaml")).toThrow(/off, warn or enforce/);
    expect(toCodeMcpArgv({ "caller-auth": "warn", callers: "/c.json" })).toEqual(["--caller-auth", "warn", "--callers", "/c.json"]);
    expect(parseCallerAuthMode("warn")).toBe("warn");
    expect(parseCallerAuthMode("on")).toBeUndefined();
  });
});

// ---- the real code-mcp, against a stub gateway --------------------------------------------------

describe("code-mcp behind a gateway that sends frames", () => {
  const procs: ReturnType<typeof Bun.spawn>[] = [];
  afterAll(() => {
    for (const p of procs) p.kill();
  });

  interface Run {
    send(frame: Record<string, unknown>): Promise<Record<string, any>>;
    stop(): void;
  }

  async function run(mode: string, callers: string): Promise<Run> {
    let socket: { send(text: string): void } | undefined;
    const pending = new Map<string, (m: Record<string, any>) => void>();
    let ready!: () => void;
    const connected = new Promise<void>((r) => (ready = r));
    const gw = Bun.serve({
      port: 0,
      fetch(req, server) {
        return server.upgrade(req) ? undefined : new Response("no", { status: 400 });
      },
      websocket: {
        open(ws) {
          socket = ws;
        },
        message(_ws, data) {
          const m = JSON.parse(String(data)) as Record<string, any>;
          if (m.type === "register") ready();
          else if (m.id && pending.has(m.id)) pending.get(m.id)!(m);
        },
      },
    });
    const free = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = free.port;
    free.stop(true);
    const proc = Bun.spawn(
      ["bun", join(ROOT, "src", "code-mcp.ts"), "--gateway", `ws://127.0.0.1:${gw.port}`, "--id", "laptop", "--port", String(port), "--bind", "127.0.0.1", "--caller-auth", mode, "--callers", callers, "--token", "t"],
      { cwd: scratch(), env: { ...process.env, HOME: scratch() }, stdout: "ignore", stderr: "ignore" },
    );
    procs.push(proc);
    await connected;
    let n = 0;
    return {
      send(frame) {
        const id = `f${++n}`;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("no reply from code-mcp")), 20_000);
          pending.set(id, (m) => {
            clearTimeout(timer);
            resolve(m);
          });
          socket!.send(JSON.stringify({ id, ...frame }));
        });
      },
      stop() {
        proc.kill();
        gw.stop(true);
      },
    };
  }

  test("enforce: a call the gateway makes up does not run; a signed one runs and its reply is signed", async () => {
    const dir = scratch();
    const callers = join(dir, "callers.json");
    const key = loadOrCreateCallerKey(join(dir, "me.pem"));
    addCaller(callers, { pub: key.publicKey });
    const marker = join(dir, "ran.txt");
    const writeCall = (path: string) => ({
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write", arguments: { cwd: dirname(path), path, content: "x" } },
    });
    const r = await run("enforce", callers);
    try {
      const forged = await r.send({ request: writeCall(marker) });
      expect(forged.response.error.code).toBe(-32001);
      expect(existsSync(marker)).toBe(false);

      const list = await r.send({ request: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
      expect(Array.isArray(list.response.result.tools)).toBe(true);

      const raw = JSON.stringify(writeCall(marker));
      const sig = signCall(key, "device:laptop", raw);
      const swapped = await r.send({ request: writeCall(join(dir, "other.txt")), raw, callerSig: sig });
      expect(swapped.response.error).toBeUndefined();
      expect(existsSync(marker)).toBe(true); // ran what was signed
      expect(existsSync(join(dir, "other.txt"))).toBe(false); // not what the gateway wrote
      const nonce = parseCallSig(sig)!.nonce;
      expect(verifyReplySig(swapped.replySig, nonce, JSON.stringify(swapped.response))).toBeDefined();

      const replay = await r.send({ request: writeCall(marker), raw, callerSig: sig });
      expect(replay.response.error.code).toBe(-32001);
    } finally {
      r.stop();
    }
  });

  test("warn: the same made-up call runs, and is logged", async () => {
    const dir = scratch();
    const marker = join(dir, "ran.txt");
    const r = await run("warn", join(dir, "callers.json"));
    try {
      const out = await r.send({ request: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write", arguments: { cwd: dir, path: marker, content: "x" } } } });
      expect(out.response.error).toBeUndefined();
      expect(existsSync(marker)).toBe(true);
      const log = readFileSync(join(dir, "caller-auth", "caller-auth.log"), "utf8");
      expect(log).toContain('"reason":"unsigned"');
      expect(log).toContain('"tool":"write"');
    } finally {
      r.stop();
    }
  });
});
