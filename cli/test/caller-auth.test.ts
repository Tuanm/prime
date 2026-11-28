// Signed tool calls, the device side: what a device runs when the gateway tunnels a call in. Offline:
// CallerAuth is driven directly, and one test runs the real code-mcp against a stub gateway.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CallerAuth, type CallerAuthMode, REPLY_SIG_HEADER, parseCallerAuthMode, verifyReplySig } from "../src/caller-auth.ts";
import { CALL_SIG_HEADER, addCaller, loadOrCreateCallerKey, parseCallSig, signCall } from "../src/caller-key.ts";
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

const NONCE = "bm9uY2Vub25jZW5vbmNlMQ"; // 22 characters, as a real one is
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

/** What the other end is told. */
function refusedWith(a: ReturnType<CallerAuth["admit"]>): string | undefined {
  return a.action === "refuse" ? (a.response.error.data.reason as string) : undefined;
}

/** What this device wrote down about its calls (after the queued lines are written). */
async function logged(t: ReturnType<typeof setup>): Promise<Record<string, any>[]> {
  await t.auth.flush();
  return existsSync(t.logFile) ? readFileSync(t.logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
}

describe("CallerAuth: the policy", () => {
  test("off checks nothing", () => {
    const t = setup("off");
    const a = t.auth.admit(t.frame(BASH));
    expect(a.action).toBe("run");
    expect(existsSync(t.logFile)).toBe(false);
  });

  test("warn runs an unsigned call and writes it to the log; listing tools is not logged", async () => {
    const t = setup("warn");
    expect(t.auth.admit(t.frame(BASH)).action).toBe("run");
    expect(t.auth.admit(t.frame(LIST)).action).toBe("run");
    // The line is queued and written after the call, not on its way.
    expect(existsSync(t.logFile)).toBe(false);
    const lines = await logged(t);
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
    expect(refusedWith(t.auth.admit(t.frame(BASH, t.sign(BASH))))).toBe("invalid");
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
    expect(refusedWith(a)).toBe("invalid");
  });

  // [what is wrong, the call, what the other end is told, what this device writes down]
  const refusals: [string, (t: ReturnType<typeof setup>) => ReturnType<CallerAuth["admit"]>, string, string][] = [
    ["a body changed after signing", (t) => t.auth.admit(t.frame(BASH.replace("id", "ls"), t.sign(BASH))), "invalid", "bad-signature"],
    ["the wrong target", (t) => t.auth.admit(t.frame(BASH, t.sign(BASH, "device:other"))), "invalid", "bad-signature"],
    ["a fleet target (not accepted by a device on its own)", (t) => t.auth.admit(t.frame(BASH, t.sign(BASH, "fleet:acme"))), "invalid", "bad-signature"],
    ["a time in the past", (t) => t.auth.admit(t.frame(BASH, t.sign(BASH, "device:laptop", { now: Date.now() - 6 * 60_000 }))), "stale", "stale"],
    ["a time in the future", (t) => t.auth.admit(t.frame(BASH, t.sign(BASH, "device:laptop", { now: Date.now() + 6 * 60_000 }))), "stale", "stale"],
    ["a key that is not trusted", (t) => {
      const other = loadOrCreateCallerKey(join(t.dir, "other.pem"));
      return t.auth.admit(t.frame(BASH, signCall(other, "device:laptop", BASH)));
    }, "invalid", "unknown-key"],
    ["a header that is not a signature", (t) => t.auth.admit(t.frame(BASH, "v1.nope")), "invalid", "malformed"],
    ["a signature with no body to check it against", (t) => t.auth.admit({ request: JSON.parse(BASH), callerSig: t.sign(BASH) }), "invalid", "no-raw"],
  ];
  for (const [name, run, told, local] of refusals) {
    test(`is refused in enforce mode: ${name}`, async () => {
      const t = setup("enforce");
      addCaller(t.callers, { pub: t.key.publicKey });
      expect(refusedWith(run(t))).toBe(told);
      expect(t.auth.counts.invalid).toBe(1);
      // The other end is not told which keys are trusted; the log on this device says exactly why.
      expect((await logged(t))[0]).toMatchObject({ reason: local, outcome: "refused" });
    });
  }

  test("a failed check in warn mode still runs the call and logs why", async () => {
    const t = setup("warn");
    addCaller(t.callers, { pub: t.key.publicKey });
    const a = t.auth.admit(t.frame(BASH, t.sign(BASH, "device:other")));
    expect(a.action).toBe("run");
    expect((await logged(t))[0]).toMatchObject({ reason: "bad-signature", outcome: "ran", key: t.key.keyId });
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
    const good = t.sign(BASH, "device:laptop", { nonce: NONCE });
    const forged = good.replace(/\.[^.]+$/, "." + "A".repeat(86));
    expect(refusedWith(t.auth.admit(t.frame(BASH, forged)))).toBe("invalid");
    expect(t.auth.admit(t.frame(BASH, good)).action).toBe("run");
  });

  test("a nonce is kept for as long as its signature could still verify, and then it is not needed", () => {
    let now = Date.now();
    const t = setup("enforce", { now: () => now });
    addCaller(t.callers, { pub: t.key.publicKey });
    now += 1000;
    const sig = t.sign(BASH, "device:laptop", { now });
    expect(t.auth.admit(t.frame(BASH, sig)).action).toBe("run");
    now += 4 * 60_000;
    expect(refusedWith(t.auth.admit(t.frame(BASH, sig)))).toBe("replay");
    // Exactly at the end of the window the signature still verifies, so its nonce is still held.
    now = Date.parse(new Date(parseCallSig(sig)!.ts).toISOString()) + 5 * 60_000;
    expect(refusedWith(t.auth.admit(t.frame(BASH, sig)))).toBe("replay");
    now += 1; // too old to verify at all, so nothing is left to replay
    expect(refusedWith(t.auth.admit(t.frame(BASH, sig)))).toBe("stale");
  });

  test("a flood of other calls does not make a captured call replayable: what is forgotten is refused with it", () => {
    const t = setup("enforce");
    const reader = loadOrCreateCallerKey(join(t.dir, "reader.pem"));
    addCaller(t.callers, { pub: t.key.publicKey });
    addCaller(t.callers, { pub: reader.publicKey, tools: ["read"] });
    const admin = t.sign(BASH);
    expect(t.auth.admit(t.frame(BASH, admin)).action).toBe("run");
    expect(refusedWith(t.auth.admit(t.frame(BASH, admin)))).toBe("replay");
    const read = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read", arguments: { path: "a" } } });
    let ran = 0;
    for (let i = 0; i < 10_050; i++) if (t.auth.admit(t.frame(read, signCall(reader, "device:laptop", read))).action === "run") ran++;
    expect(ran).toBeGreaterThan(9_000);
    // The admin call's nonce was forgotten to make room: it is still refused, and so is everything signed no later than it.
    expect(refusedWith(t.auth.admit(t.frame(BASH, admin)))).toBe("replay");
    // A call signed after that goes through.
    expect(t.auth.admit(t.frame(BASH, signCall(t.key, "device:laptop", BASH, { now: Date.now() + 5 }))).action).toBe("run");
  });

  test("a call signed before this process started is refused, because its nonce could not be remembered", () => {
    const started = Date.now();
    const t = setup("enforce", { now: () => started });
    addCaller(t.callers, { pub: t.key.publicKey });
    expect(refusedWith(t.auth.admit(t.frame(BASH, t.sign(BASH, "device:laptop", { now: started - 60_000 }))))).toBe("replay");
    expect(refusedWith(t.auth.admit(t.frame(BASH, t.sign(BASH, "device:laptop", { now: started - 1 }))))).toBe("replay");
    expect(t.auth.admit(t.frame(BASH, t.sign(BASH, "device:laptop", { now: started + 1 }))).action).toBe("run");
  });

  test("the callers file is read again after a rewrite of the same size within the same time", () => {
    const t = setup("enforce");
    addCaller(t.callers, { pub: t.key.publicKey, tools: ["bash"] });
    expect(t.auth.admit(t.frame(BASH, t.sign(BASH))).action).toBe("run");
    const before = statSync(t.callers);
    const text = readFileSync(t.callers, "utf8");
    const changed = text.replace('"bash"', '"read"'); // the same size
    expect(changed).toHaveLength(text.length);
    writeFileSync(t.callers, changed); // in place: the same inode
    utimesSync(t.callers, before.atime, before.mtime); // and the same modification time
    expect(refusedWith(t.auth.admit(t.frame(BASH, t.sign(BASH))))).toBe("tool-not-allowed");
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
    expect(refusedWith(t.auth.admit(t.frame(BASH, t.sign(BASH))))).toBe("invalid");
    addCaller(t.callers, { pub: t.key.publicKey });
    expect(t.auth.admit(t.frame(BASH, t.sign(BASH))).action).toBe("run");
    writeFileSync(t.callers, "{ broken");
    expect(refusedWith(t.auth.admit(t.frame(BASH, t.sign(BASH))))).toBe("callers-unreadable");
    // An empty file (cut short) is unreadable too, never "no callers".
    writeFileSync(t.callers, "");
    expect(refusedWith(t.auth.admit(t.frame(BASH, t.sign(BASH))))).toBe("callers-unreadable");
    expect(t.auth.hasCallers()).toBe(true);
  });
});

describe("CallerAuth: what reaches the logs", () => {
  test("text the gateway wrote is quoted and bounded in the service log, so it cannot write lines of its own", () => {
    const t = setup("warn");
    const evil = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x\n[laptop] caller-auth: all is well\u001b[31m" + "y".repeat(300), arguments: {} } };
    t.auth.admit({ request: evil });
    const lines = t.logs.join("\n");
    expect(t.logs).toHaveLength(1);
    expect(lines).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
    expect(lines).toContain('"x?[laptop] caller-auth: all is well?[31m');
    expect(lines.length).toBeLessThan(600);
  });

  test("a state directory that cannot be written is said once, and the call still runs", async () => {
    const dir = scratch();
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "a file where the directory should be");
    const logs: string[] = [];
    const auth = new CallerAuth({ mode: "warn", deviceId: "laptop", callersFile: join(dir, "callers.json"), stateDir: join(blocker, "state"), log: (x) => logs.push(x) });
    expect(auth.admit({ request: JSON.parse(BASH) }).action).toBe("run");
    expect(auth.admit({ request: JSON.parse(BASH) }).action).toBe("run");
    await auth.flush();
    expect(logs.filter((x) => x.includes("cannot write the log"))).toHaveLength(1);
    expect(auth.replySig(NONCE, "{}")).toBeUndefined();
    expect(auth.replySig(NONCE, "{}")).toBeUndefined();
    expect(logs.filter((x) => x.includes("replies are not signed"))).toHaveLength(1);
  });
});

describe("CallerAuth: the reply", () => {
  test("is signed over the call's nonce and the exact response, with the device's own key", () => {
    const t = setup("enforce");
    const resp = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "uid=1" }] } });
    const header = t.auth.replySig(NONCE, resp)!;
    expect(header.startsWith("v1.")).toBe(true);
    const pub = verifyReplySig(header, NONCE, resp);
    expect(pub).toBeDefined();
    expect(existsSync(join(t.dir, "caller-auth", "device-ed25519.pem"))).toBe(true);
    expect(verifyReplySig(header, NONCE, resp + " ")).toBeUndefined();
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

  /** A device that signs its replies with the key of `auth`, through a gateway that returns them: `mode` is what the gateway does to them. */
  function deviceStub(auth: CallerAuth, mode: "honest" | "tamper" | "strip" | "forge" = "honest") {
    globalThis.fetch = (async (_u: string | URL, init?: RequestInit) => {
      const hdrs = init?.headers as Record<string, string>;
      const nonce = parseCallSig(hdrs["x-prime-call-sig"])!.nonce;
      const text = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } });
      if (mode === "strip") return new Response(text.replace("ok", "forged by the gateway"));
      return new Response(mode === "tamper" ? text.replace("ok", "no") : text, { headers: { [REPLY_SIG_HEADER]: auth.replySig(nonce, text)! } });
    }) as unknown as typeof fetch;
  }
  const newAuth = () => new CallerAuth({ mode: "warn", deviceId: "laptop", callersFile: join(scratch(), "c.json") });
  const newClient = (notices: string[], t: Record<string, unknown> = target) =>
    new GatewayClient(t as typeof target, { signer: new CallSigner({ path: join(scratch(), "k.pem") }), notice: (x) => notices.push(x) });
  const pins = () => (process.env.PRIME_DEVICE_KEYS = join(scratch(), "pins.json"));
  const call = (c: GatewayClient) => c.callTool("bash", {}, { handshake: "never" });

  test("a good reply pins the device's key and says nothing", async () => {
    const file = pins();
    const notices: string[] = [];
    deviceStub(newAuth());
    await call(newClient(notices));
    expect(notices).toEqual([]);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toEqual(["laptop@https://gw.test"]);
  });

  test("once a device is pinned, a reply that is tampered, signed by another key, or has its signature stripped is refused, every time", async () => {
    pins();
    const notices: string[] = [];
    const client = newClient(notices);
    const device = newAuth();
    deviceStub(device);
    await call(client); // pins
    for (const [mode, auth, what] of [
      ["tamper", device, /does not match the reply/],
      ["strip", device, /without signing its reply/],
      ["honest", newAuth(), /different key/],
    ] as const) {
      deviceStub(auth, mode);
      await expect(call(client)).rejects.toThrow(what);
      await expect(call(client)).rejects.toThrow(what); // not only the first time
    }
    // The device itself is still fine.
    deviceStub(device);
    await call(client);
  });

  test("a device that has never signed may answer unsigned (an older build), and an unsigned bad signature is reported", async () => {
    pins();
    const notices: string[] = [];
    const client = newClient(notices);
    deviceStub(newAuth(), "strip");
    await call(client);
    expect(notices).toEqual([]);
    deviceStub(newAuth(), "tamper"); // never pinned: reported, not refused
    await call(client);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("does not match");
  });

  test("a damaged pins file is left as it is, is said once, and does not stop the call", async () => {
    const file = pins();
    writeFileSync(file, '{"other@https://gw.test":"AAAA", broken');
    const notices: string[] = [];
    const client = newClient(notices);
    deviceStub(newAuth());
    await call(client);
    await call(client);
    expect(readFileSync(file, "utf8")).toBe('{"other@https://gw.test":"AAAA", broken');
    expect(notices.filter((n) => n.includes("not valid JSON"))).toHaveLength(1);
  });

  test("pins made by several processes at once are all kept", async () => {
    const file = pins();
    const script = `import { checkDeviceKey } from ${JSON.stringify(join(ROOT, "src", "device-pins.ts"))};
      checkDeviceKey("https://gw.test", process.argv[1], Buffer.alloc(32, Number(process.argv[2])), ${JSON.stringify(file)});`;
    const procs = Array.from({ length: 8 }, (_, i) => Bun.spawn(["bun", "-e", script, `dev${i}`, String(i + 1)], { stdout: "ignore", stderr: "pipe" }));
    for (const p of procs) expect(await p.exited).toBe(0);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8"))).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `dev${i}@https://gw.test`).sort());
  });

  test("a fleet is not pinned by its first reply: whichever member holds the lease answers, so only the signature is checked", async () => {
    const file = pins();
    const notices: string[] = [];
    deviceStub(newAuth());
    await call(newClient(notices, { ...target, deviceId: "member", fleet: "acme" }));
    await call(newClient(notices, { ...target, deviceId: "acme", fleetBuddy: true }));
    expect(existsSync(file)).toBe(false);
    deviceStub(newAuth()); // another member answers: not a changed key
    await call(newClient(notices, { ...target, deviceId: "acme", fleetBuddy: true }));
    deviceStub(newAuth(), "strip");
    await call(newClient(notices, { ...target, deviceId: "acme", fleetBuddy: true }));
    expect(notices).toEqual([]);
  });

  test("a reply with no signature from a device that never signed is accepted without a word", async () => {
    const file = pins();
    const notices: string[] = [];
    globalThis.fetch = (async () => new Response('{"jsonrpc":"2.0","id":1,"result":{}}')) as unknown as typeof fetch;
    await call(newClient(notices));
    expect(notices).toEqual([]);
    expect(existsSync(file)).toBe(false);
    expect(checkDeviceKey("g", "d", Buffer.alloc(32, 1), file)).toBe("pinned");
  });
});

describe("prime devices callers: the keys to compare out of band", () => {
  async function cli(args: string[], env: Record<string, string>) {
    const proc = Bun.spawn(["bun", join(ROOT, "src", "index.ts"), ...args], {
      env: { ...process.env, NO_COLOR: "1", PRIME_GATEWAY_URL: "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out, err };
  }

  test("shows the key pinned for a device, forgets it on request, and shows the key a device signs its replies with", async () => {
    const dir = scratch();
    const env = { PRIME_CONFIG: join(dir, "config.yaml"), PRIME_DEVICE_KEYS: join(dir, "pins.json"), PRIME_CALLERS: join(dir, "callers.json"), PRIME_CALLER_KEY: join(dir, "me.pem") };
    const gateway = "http://127.0.0.1:9";
    const none = await cli(["devices", "callers", "--device", "laptop", "--gateway", gateway, "--json"], env);
    expect(JSON.parse(none.out).pinned).toEqual({ device: "laptop", gateway, key: null });

    const device = new CallerAuth({ mode: "warn", deviceId: "laptop", callersFile: join(dir, "callers.json") });
    const header = device.replySig(NONCE, "{}")!;
    const pub = verifyReplySig(header, NONCE, "{}")!;
    checkDeviceKey(gateway, "laptop", pub, env.PRIME_DEVICE_KEYS);

    const shown = JSON.parse((await cli(["devices", "callers", "--device", "laptop", "--gateway", gateway, "--json"], env)).out);
    expect(shown.pinned.key).toBe(pub.toString("base64"));
    // The machine the device runs on shows the same key, so the two can be compared.
    expect(shown.device_reply_key.public_key).toBe(pub.toString("base64"));
    const human = await cli(["devices", "callers", "--device", "laptop", "--gateway", gateway], env);
    expect(human.out).toContain(pub.toString("base64"));

    const forgotten = await cli(["devices", "callers", "--device", "laptop", "--forget", "--gateway", gateway, "--json"], env);
    expect(JSON.parse(forgotten.out)).toEqual({ device: "laptop", forgotten: true });
    expect(JSON.parse(readFileSync(env.PRIME_DEVICE_KEYS, "utf8"))).toEqual({});
    expect((await cli(["devices", "callers", "--forget"], env)).code).toBe(2);
  });

  test("a damaged pins file is reported, not replaced", async () => {
    const dir = scratch();
    const pinsFile = join(dir, "pins.json");
    writeFileSync(pinsFile, "{ broken");
    const r = await cli(["devices", "callers", "--device", "laptop", "--gateway", "http://127.0.0.1:9"], {
      PRIME_CONFIG: join(dir, "config.yaml"), PRIME_DEVICE_KEYS: pinsFile, PRIME_CALLERS: join(dir, "callers.json"), PRIME_CALLER_KEY: join(dir, "me.pem"),
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain("not valid JSON");
    expect(readFileSync(pinsFile, "utf8")).toBe("{ broken");
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
    /** The gateway's address: a POST to it is turned into a frame the way the gateway does it (raw body, the signature header). */
    url: string;
    stop(): void;
  }

  async function run(mode: string, callers: string): Promise<Run> {
    let socket: { send(text: string): void } | undefined;
    const pending = new Map<string, (m: Record<string, any>) => void>();
    let ready!: () => void;
    const connected = new Promise<void>((r) => (ready = r));
    let sendFrame!: (frame: Record<string, unknown>) => Promise<Record<string, any>>;
    const gw = Bun.serve({
      port: 0,
      async fetch(req, server) {
        if (server.upgrade(req)) return undefined;
        if (req.method !== "POST") return new Response("no", { status: 400 });
        // The gateway's side of the contract: the raw body and the signature go to the device as they came, and the
        // reply goes back with its signature in a header and `responseText` (when sent) as the body, byte for byte.
        const text = await req.text();
        const sig = req.headers.get(CALL_SIG_HEADER);
        const m = await sendFrame({ request: JSON.parse(text), raw: text, ...(sig ? { callerSig: sig } : {}) });
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (typeof m.replySig === "string") headers[REPLY_SIG_HEADER] = m.replySig;
        return new Response(typeof m.responseText === "string" ? m.responseText : JSON.stringify(m.response), { headers });
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
      { cwd: scratch(), env: { ...process.env, HOME: scratch() }, stdout: "ignore", stderr: "pipe" },
    );
    procs.push(proc);
    // A code-mcp that cannot start says why, instead of leaving the test waiting for a connection.
    await Promise.race([
      connected,
      proc.exited.then(async (code) => {
        throw new Error(`code-mcp exited ${code}: ${await new Response(proc.stderr as ReadableStream).text()}`);
      }),
    ]);
    let n = 0;
    sendFrame = (frame) => {
      const id = `f${++n}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no reply from code-mcp")), 20_000);
        pending.set(id, (m) => {
          clearTimeout(timer);
          resolve(m);
        });
        socket!.send(JSON.stringify({ id, ...frame }));
      });
    };
    return {
      url: `http://127.0.0.1:${gw.port}`,
      send: sendFrame,
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

  test("the reply frame carries the text that was signed, and a gateway that sends it as the body gives the caller what the signature covers", async () => {
    const dir = scratch();
    const callers = join(dir, "callers.json");
    const key = loadOrCreateCallerKey(join(dir, "me.pem"));
    addCaller(callers, { pub: key.publicKey });
    const r = await run("enforce", callers);
    try {
      const raw = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "write", arguments: { cwd: dir, path: join(dir, "a.txt"), content: "a" } } });
      const sig = signCall(key, "device:laptop", raw);
      const frame = await r.send({ request: JSON.parse(raw), raw, callerSig: sig });
      expect(typeof frame.responseText).toBe("string");
      expect(frame.responseText).toBe(JSON.stringify(frame.response));
      // The gateway of the contract (G9): body = responseText as it is, signature in x-prime-reply-sig.
      const sig2 = signCall(key, "device:laptop", raw);
      const http = await fetch(r.url, { method: "POST", body: raw, headers: { [CALL_SIG_HEADER]: sig2 } });
      const body = await http.text();
      const header = http.headers.get(REPLY_SIG_HEADER);
      expect(header).not.toBeNull();
      expect(verifyReplySig(header!, parseCallSig(sig2)!.nonce, body)).toBeDefined();
      expect(JSON.parse(body).id).toBe(7);
      // A body that is not the text that was signed does not verify, however alike it looks.
      expect(verifyReplySig(header!, parseCallSig(sig2)!.nonce, JSON.stringify(JSON.parse(body), null, 1))).toBeUndefined();
    } finally {
      r.stop();
    }
  });

  test("the CLI against a device behind that gateway: the reply is verified and the device pinned; a signature left off a later reply is refused", async () => {
    const dir = scratch();
    const callers = join(dir, "callers.json");
    const keyPath = join(dir, "me.pem");
    const key = loadOrCreateCallerKey(keyPath);
    addCaller(callers, { pub: key.publicKey });
    process.env.PRIME_DEVICE_KEYS = join(dir, "pins.json");
    const r = await run("enforce", callers);
    const realFetch = globalThis.fetch;
    try {
      const notices: string[] = [];
      const client = new GatewayClient({ deviceId: "laptop", gateway: r.url, timeoutMs: 20_000 } as never, { signer: new CallSigner({ path: keyPath }), notice: (x) => notices.push(x) });
      const call = () => client.callTool("write", { cwd: dir, path: join(dir, "b.txt"), content: "b" }, { handshake: "never" });
      await call();
      expect(notices).toEqual([]);
      expect(Object.keys(JSON.parse(readFileSync(join(dir, "pins.json"), "utf8")))).toEqual([`laptop@${r.url}`]);
      // The same gateway now drops the header: the pinned device is refused.
      globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
        const res = await realFetch(u, init);
        const headers = new Headers(res.headers);
        headers.delete(REPLY_SIG_HEADER);
        return new Response(await res.text(), { status: res.status, headers });
      }) as typeof fetch;
      await expect(call()).rejects.toThrow(/without signing its reply/);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.PRIME_DEVICE_KEYS;
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
