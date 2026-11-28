// Signed tool calls, the client side: the caller key, the signature a client puts on a call, and the
// callers file a device reads. Offline: the gateway is a stub in-process.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CALL_SIG_HEADER,
  CallSigner,
  addCaller,
  allowCallerCommand,
  callSigMessage,
  keyIdOf,
  loadOrCreateCallerKey,
  methodNeedsSignature,
  parseCallSig,
  parsePublicKey,
  readCallers,
  removeCaller,
  signCall,
  signTarget,
  verifyCallSignature,
} from "../src/caller-key.ts";
import { GatewayClient } from "../src/client.ts";
import { AggregateServer } from "../src/serve.ts";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = join(ROOT, "src", "index.ts");
const POSIX = process.platform !== "win32";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "prime-caller-"));
}

function newKey() {
  return loadOrCreateCallerKey(join(scratch(), "caller.pem"));
}

describe("caller key", () => {
  test("is made once, kept private, and is the same key on every later load", () => {
    const path = join(scratch(), "nested", "caller.pem");
    const first = loadOrCreateCallerKey(path);
    expect(existsSync(path)).toBe(true);
    if (POSIX) expect(statSync(path).mode & 0o777).toBe(0o600);
    const again = loadOrCreateCallerKey(path);
    expect(again.keyId).toBe(first.keyId);
    expect(again.publicKeyB64).toBe(first.publicKeyB64);
    // Only the public half is ever shown.
    expect(first.keyId).toHaveLength(22);
    expect(first.publicKey).toHaveLength(32);
    expect(first.keyId).toBe(createHash("sha256").update(first.publicKey).digest("base64url").slice(0, 22));
  });

  test("a file that is not an Ed25519 key is an error, never replaced", () => {
    const path = join(scratch(), "caller.pem");
    writeFileSync(path, "not a key");
    expect(() => loadOrCreateCallerKey(path)).toThrow();
    expect(readFileSync(path, "utf8")).toBe("not a key");
  });

  test("parsePublicKey takes base64 and base64url of 32 bytes and nothing else", () => {
    const key = newKey();
    expect(parsePublicKey(key.publicKeyB64)?.equals(key.publicKey)).toBe(true);
    expect(parsePublicKey(key.publicKey.toString("base64url"))?.equals(key.publicKey)).toBe(true);
    expect(parsePublicKey(key.keyId)).toBeUndefined();
    expect(parsePublicKey("")).toBeUndefined();
    expect(parsePublicKey("AAAA")).toBeUndefined();
  });
});

describe("call signature", () => {
  const body = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"bash","arguments":{"command":"id"}}}';

  test("carries the version, key id, time, nonce and a signature over the target and the body hash", () => {
    const key = newKey();
    const header = signCall(key, "device:laptop", body, { now: 1_700_000_000_000, nonce: "bm9uY2U" });
    const parts = header.split(".");
    expect(parts.slice(0, 4)).toEqual(["v1", key.keyId, "1700000000000", "bm9uY2U"]);
    const parsed = parseCallSig(header)!;
    expect(parsed.keyId).toBe(key.keyId);
    expect(parsed.sig).toHaveLength(64);
    expect(verifyCallSignature(parsed, key.publicKey, "device:laptop", body)).toBe(true);
    // The message is the documented one, byte for byte.
    const digest = createHash("sha256").update(body).digest("hex");
    expect(callSigMessage("device:laptop", "1700000000000", "bm9uY2U", digest).toString()).toBe(
      `prime-call-v1\ndevice:laptop\n1700000000000\nbm9uY2U\n${digest}`,
    );
  });

  test("fails for another body, another target, another key or an altered time or nonce", () => {
    const key = newKey();
    const other = newKey();
    const parsed = parseCallSig(signCall(key, "device:laptop", body))!;
    expect(verifyCallSignature(parsed, key.publicKey, "device:laptop", body + " ")).toBe(false);
    expect(verifyCallSignature(parsed, key.publicKey, "device:other", body)).toBe(false);
    expect(verifyCallSignature(parsed, key.publicKey, "fleet:laptop", body)).toBe(false);
    expect(verifyCallSignature(parsed, other.publicKey, "device:laptop", body)).toBe(false);
    expect(verifyCallSignature({ ...parsed, tsText: String(parsed.ts + 1) }, key.publicKey, "device:laptop", body)).toBe(false);
    expect(verifyCallSignature({ ...parsed, nonce: "AAAA" }, key.publicKey, "device:laptop", body)).toBe(false);
  });

  test("covers a body with non-ASCII text as the bytes that are sent", () => {
    const key = newKey();
    const text = '{"a":"héllo ✓"}';
    const parsed = parseCallSig(signCall(key, "device:d", text))!;
    expect(verifyCallSignature(parsed, key.publicKey, "device:d", new TextEncoder().encode(text))).toBe(true);
  });

  test("a header that is not v1.<id>.<ts>.<nonce>.<sig> does not parse", () => {
    const key = newKey();
    const good = signCall(key, "device:d", body);
    expect(parseCallSig(good)).toBeDefined();
    for (const bad of ["", "v2" + good.slice(2), good.replace(/\.[^.]+$/, ".AAAA"), good + ".x", "v1.a.b.c", good.replace(/\.\d+\./, ".12ab.")]) {
      expect(parseCallSig(bad)).toBeUndefined();
    }
    expect(parseCallSig(undefined)).toBeUndefined();
  });

  test("targets: a device for a direct call, the fleet for a call that addresses one", () => {
    expect(signTarget({ deviceId: "laptop" })).toBe("device:laptop");
    expect(signTarget({ deviceId: "member", fleet: "acme" })).toBe("fleet:acme");
  });

  test("the methods a device answers unsigned are not signed", () => {
    for (const m of ["initialize", "ping", "tools/list", "notifications/initialized"]) expect(methodNeedsSignature(m)).toBe(false);
    for (const m of ["tools/call", "resources/read", "prompts/get"]) expect(methodNeedsSignature(m)).toBe(true);
  });
});

// ---- GatewayClient --------------------------------------------------------------------------

describe("GatewayClient signing", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  interface Seen {
    url: string;
    headers: Record<string, string>;
    body: string;
  }

  function stubFetch(handler: (n: number) => Response): Seen[] {
    const seen: Seen[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body) });
      return handler(seen.length);
    }) as unknown as typeof fetch;
    return seen;
  }

  const ok = () => new Response('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}', { status: 200 });
  const target = { deviceId: "laptop", gateway: "https://gw.test", deviceToken: "tok", timeoutMs: 5000 };

  test("a tools/call carries a signature that verifies over the exact body that was sent", async () => {
    const key = newKey();
    const seen = stubFetch(ok);
    const signer = new CallSigner({ path: join(scratch(), "k.pem") });
    // Use a known key: the signer under test makes its own, so check against it.
    const client = new GatewayClient(target, { signer });
    await client.callTool("bash", { command: "id" }, { handshake: "never" });
    expect(seen).toHaveLength(1);
    const header = seen[0]!.headers[CALL_SIG_HEADER];
    expect(header).toBeDefined();
    const parsed = parseCallSig(header)!;
    const own = signer.callerKey()!;
    expect(parsed.keyId).toBe(own.keyId);
    expect(parsed.keyId).not.toBe(key.keyId);
    expect(verifyCallSignature(parsed, own.publicKey, "device:laptop", seen[0]!.body)).toBe(true);
    expect(JSON.parse(seen[0]!.body).params).toEqual({ name: "bash", arguments: { command: "id" } });
    expect(Math.abs(parsed.ts - Date.now())).toBeLessThan(60_000);
    // The credentials are still sent as before.
    expect(seen[0]!.headers["x-device-token"]).toBe("tok");
  });

  test("a call to a fleet is signed for the fleet", async () => {
    const seen = stubFetch(ok);
    const signer = new CallSigner({ path: join(scratch(), "k.pem") });
    await new GatewayClient({ ...target, fleet: "acme" }, { signer }).callTool("bash", {}, { handshake: "never" });
    expect(seen[0]!.url).toContain("fleet=acme");
    const parsed = parseCallSig(seen[0]!.headers[CALL_SIG_HEADER])!;
    const pub = signer.callerKey()!.publicKey;
    expect(verifyCallSignature(parsed, pub, "fleet:acme", seen[0]!.body)).toBe(true);
    expect(verifyCallSignature(parsed, pub, "device:laptop", seen[0]!.body)).toBe(false);
  });

  test("ping, initialize and tools/list go unsigned, and make no key", async () => {
    const seen = stubFetch(ok);
    const path = join(scratch(), "k.pem");
    const client = new GatewayClient(target, { signer: new CallSigner({ path }) });
    await client.rpc("ping");
    await client.rpc("initialize", {});
    await client.rpc("tools/list", {});
    expect(seen).toHaveLength(3);
    for (const s of seen) expect(s.headers[CALL_SIG_HEADER]).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });

  test("a client with no signer sends no signature", async () => {
    const seen = stubFetch(ok);
    await new GatewayClient(target).callTool("bash", {}, { handshake: "never" });
    expect(seen[0]!.headers[CALL_SIG_HEADER]).toBeUndefined();
  });

  test("a retry is signed afresh, with its own nonce", async () => {
    const seen = stubFetch((n) => (n === 1 ? new Response('{"error":"rate limited"}', { status: 429 }) : ok()));
    const signer = new CallSigner({ path: join(scratch(), "k.pem") });
    await new GatewayClient(target, { signer }).callTool("bash", {}, { handshake: "never" });
    expect(seen).toHaveLength(2);
    const a = parseCallSig(seen[0]!.headers[CALL_SIG_HEADER])!;
    const b = parseCallSig(seen[1]!.headers[CALL_SIG_HEADER])!;
    expect(a.nonce).not.toBe(b.nonce);
    expect(verifyCallSignature(b, signer.callerKey()!.publicKey, "device:laptop", seen[1]!.body)).toBe(true);
  });

  test("a key that cannot be made leaves the call unsigned and says so once", async () => {
    const seen = stubFetch(ok);
    const dir = scratch();
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "a file where a directory is needed");
    const warnings: string[] = [];
    const signer = new CallSigner({ path: join(blocker, "k.pem"), warn: (t) => warnings.push(t) });
    const client = new GatewayClient(target, { signer });
    await client.callTool("bash", {}, { handshake: "never" });
    await client.callTool("bash", {}, { handshake: "never" });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.headers[CALL_SIG_HEADER]).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not signed");
  });
});

describe("prime serve: a device that refuses an unsigned call", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("the answer names the key to allow", async () => {
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      const method = JSON.parse(String(init?.body)).method as string;
      if (method === "tools/list") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "bash", inputSchema: {} }] } }));
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: "this device only runs calls signed by a key it trusts" } }));
    }) as unknown as typeof fetch;
    const signer = new CallSigner({ path: join(scratch(), "k.pem") });
    const target = { deviceId: "laptop", gateway: "https://gw.test", timeoutMs: 5000 };
    const server = new AggregateServer({
      deviceIds: ["laptop"],
      clientFor: () => new GatewayClient(target, { signer }),
      version: "t",
      note: () => {},
      signer,
    });
    const reply = (await server.handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "laptop__bash", arguments: {} } })) as {
      error?: { code: number; message: string };
    };
    expect(reply.error?.code).toBe(-32001);
    expect(reply.error?.message).toContain(allowCallerCommand(signer.callerKey()!));
  });
});

// ---- the callers file -----------------------------------------------------------------------

describe("callers file", () => {
  test("a missing file is no callers; add, update and revoke round-trip", () => {
    const path = join(scratch(), "sub", "callers.json");
    expect(readCallers(path)).toEqual([]);
    const a = newKey();
    const b = newKey();
    const first = addCaller(path, { pub: a.publicKey, label: "laptop", tools: ["bash"] }, new Date("2026-01-01T00:00:00Z"));
    expect(first.added).toBe(true);
    expect(first.entry).toMatchObject({ keyId: a.keyId, label: "laptop", tools: ["bash"], addedAt: "2026-01-01T00:00:00.000Z" });
    if (POSIX) expect(statSync(path).mode & 0o777).toBe(0o600);
    addCaller(path, { pub: b.publicKey });
    // Adding again updates and keeps the first date.
    const again = addCaller(path, { pub: a.publicKey, label: "renamed" }, new Date("2030-01-01T00:00:00Z"));
    expect(again.added).toBe(false);
    expect(again.entry.addedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(again.entry.tools).toBeUndefined();
    expect(readCallers(path).map((e) => e.keyId).sort()).toEqual([a.keyId, b.keyId].sort());
    expect(removeCaller(path, a.keyId)).toBe(true);
    expect(removeCaller(path, a.keyId)).toBe(false);
    expect(readCallers(path).map((e) => e.keyId)).toEqual([b.keyId]);
  });

  test("a key id in the file is derived from the key, not taken on trust", () => {
    const path = join(scratch(), "callers.json");
    const a = newKey();
    writeFileSync(path, JSON.stringify([{ keyId: "AAAAAAAAAAAAAAAAAAAAAA", pub: a.publicKeyB64, label: "x", addedAt: "" }]));
    expect(readCallers(path)[0]!.keyId).toBe(keyIdOf(a.publicKey));
  });

  test("a malformed file is an error, never read as no callers", () => {
    const path = join(scratch(), "callers.json");
    writeFileSync(path, "{ nope");
    expect(() => readCallers(path)).toThrow(/not valid JSON/);
    writeFileSync(path, '{"a":1}');
    expect(() => readCallers(path)).toThrow(/array/);
    writeFileSync(path, '[{"pub":"short"}]');
    expect(() => readCallers(path)).toThrow(/public key/);
    expect(() => addCaller(path, { pub: newKey().publicKey })).toThrow();
    expect(readFileSync(path, "utf8")).toBe('[{"pub":"short"}]');
  });
});

// ---- the commands ---------------------------------------------------------------------------

describe("prime (spawned)", () => {
  let dir: string;
  let seen: { headers: Record<string, string>; body: string }[];
  let refuse = false;
  let stub: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    dir = scratch();
    seen = [];
    stub = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.text();
        seen.push({ headers: Object.fromEntries(req.headers), body });
        const id = (JSON.parse(body) as { id?: number }).id ?? 1;
        if (refuse) {
          return Response.json({ jsonrpc: "2.0", id, error: { code: -32001, message: "this device only runs calls signed by a key it trusts" } });
        }
        return Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "done" }] } });
      },
    });
  });
  afterAll(() => stub.stop(true));

  async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
    const proc = Bun.spawn(["bun", ENTRY, ...args], {
      env: {
        ...process.env,
        PRIME_CONFIG: join(dir, "config.yaml"),
        PRIME_CALLER_KEY: join(dir, "caller.pem"),
        PRIME_CALLERS: join(dir, "callers.json"),
        PRIME_GATEWAY_URL: "",
        NO_COLOR: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out, err };
  }

  const gw = () => `http://127.0.0.1:${stub.port}`;

  test("prime tools call signs the call; --no-sign does not", async () => {
    seen.length = 0;
    const signed = await cli(["tools", "call", "laptop.bash", '{"command":"id"}', "--gateway", gw(), "--token", "t", "--handshake", "never"]);
    expect(signed.code).toBe(0);
    expect(signed.out).toContain("done");
    expect(seen).toHaveLength(1);
    const parsed = parseCallSig(seen[0]!.headers[CALL_SIG_HEADER])!;
    expect(parsed).toBeDefined();
    const pem = loadOrCreateCallerKey(join(dir, "caller.pem"));
    expect(parsed.keyId).toBe(pem.keyId);
    expect(verifyCallSignature(parsed, pem.publicKey, "device:laptop", seen[0]!.body)).toBe(true);

    seen.length = 0;
    const bare = await cli(["tools", "call", "laptop.bash", '{"command":"id"}', "--gateway", gw(), "--token", "t", "--handshake", "never", "--no-sign"]);
    expect(bare.code).toBe(0);
    expect(seen[0]!.headers[CALL_SIG_HEADER]).toBeUndefined();
  });

  test("a refused call prints the line that lets this machine in, and running it allows the key", async () => {
    refuse = true;
    const refused = await cli(["tools", "call", "laptop.bash", "{}", "--gateway", gw(), "--token", "t", "--handshake", "never"]);
    refuse = false;
    expect(refused.code).not.toBe(0);
    const key = loadOrCreateCallerKey(join(dir, "caller.pem"));
    const line = refused.err.split("\n").find((l) => l.includes("prime devices allow-caller"));
    expect(line).toBeDefined();
    expect(line).toContain(key.publicKeyB64);
    // The line is meant to be run: its argument is the public key.
    const arg = line!.trim().split(/\s+/).pop()!;
    const allowed = await cli(["devices", "allow-caller", arg, "--label", "my laptop", "--tools", "bash,read"]);
    expect(allowed.code).toBe(0);
    expect(allowed.out).toContain(key.keyId);
    const file = readCallers(join(dir, "callers.json"));
    expect(file).toHaveLength(1);
    expect(file[0]).toMatchObject({ keyId: key.keyId, label: "my laptop", tools: ["bash", "read"] });
  });

  test("callers lists them as JSON, and revoke-caller removes one", async () => {
    const listed = JSON.parse((await cli(["devices", "callers", "--json"])).out) as {
      callers: { key_id: string; label: string; tools: string[] | null }[];
      this_machine: { key_id: string } | null;
    };
    expect(listed.callers).toHaveLength(1);
    expect(listed.callers[0]).toMatchObject({ label: "my laptop", tools: ["bash", "read"] });
    expect(listed.this_machine?.key_id).toBe(listed.callers[0]!.key_id);
    const revoked = await cli(["devices", "revoke-caller", listed.callers[0]!.key_id]);
    expect(revoked.code).toBe(0);
    expect(readCallers(join(dir, "callers.json"))).toEqual([]);
    const missing = await cli(["devices", "revoke-caller", "nope", "--json"]);
    expect(JSON.parse(missing.out)).toMatchObject({ removed: false });
  });

  test("allow-caller refuses what is not a public key, and a malformed callers file is left as it is", async () => {
    const notKey = await cli(["devices", "allow-caller", "hello"]);
    expect(notKey.code).toBe(2);
    expect(notKey.err).toContain("not a public key");
    const none = await cli(["devices", "allow-caller"]);
    expect(none.code).toBe(2);
    writeFileSync(join(dir, "callers.json"), "garbage");
    chmodSync(join(dir, "callers.json"), 0o600);
    const bad = await cli(["devices", "allow-caller", "--self"]);
    expect(bad.code).toBe(2);
    expect(readFileSync(join(dir, "callers.json"), "utf8")).toBe("garbage");
    writeFileSync(join(dir, "callers.json"), "[]");
    const self = await cli(["devices", "allow-caller", "--self", "--json"]);
    expect(self.code).toBe(0);
    expect(JSON.parse(self.out)).toMatchObject({ key_id: loadOrCreateCallerKey(join(dir, "caller.pem")).keyId, added: true });
  });
});
