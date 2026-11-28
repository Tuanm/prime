// The chain of a signed tool call across the packages, end to end with nothing stubbed but the sockets:
// the CLI's signer and client -> the gateway's device object (api/src/device-do.ts) -> the device's CallerAuth
// -> the reply signature -> the gateway -> the CLI's check of the reply. Each side is tested against the documented
// format in its own package; this pins that the sides agree with each other.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CallerAuth } from "../src/caller-auth.ts";
import { addCaller, CallSigner, loadOrCreateCallerKey, removeCaller } from "../src/caller-key.ts";
import { GatewayClient } from "../src/client.ts";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
mock.module("@cloudflare/containers", () => ({ Container: class {} }));
// By a computed path: the gateway is another package with its own types (Cloudflare's), which this one does not load.
const DEVICE_DO = "../../api/src/device-do";
const { DeviceDO } = (await import(DEVICE_DO)) as { DeviceDO: new (ctx: never, env: never) => unknown };

const GATEWAY = "https://gw.test";

/** The gateway's device object with a fake tunnel whose far end is a real CallerAuth, reached by the CLI's own fetch. */
function world(options: { dropReplySig?: boolean; rawOnly?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "prime-interop-"));
  const callers = join(dir, "callers.json");
  const keyPath = join(dir, "me.pem");
  const key = loadOrCreateCallerKey(keyPath);
  addCaller(callers, { pub: key.publicKey });
  const auth = new CallerAuth({ mode: "enforce", deviceId: "laptop", callersFile: callers, log: () => {} });
  const ran: unknown[] = [];

  const registry = { idFromName: () => "global", get: () => ({ fetch: async () => Response.json({}) }) };
  const storage = { get: async () => undefined, put: async () => {}, delete: async () => true, list: async () => new Map(), setAlarm: async () => {}, getAlarm: async () => null, deleteAlarm: async () => {} };
  const ctx = { getWebSockets: () => [], waitUntil: () => {}, storage };
  const dev = new DeviceDO(ctx as never, { REGISTRY: registry } as never) as unknown as {
    ws: unknown;
    fetch(r: Request): Promise<Response>;
    webSocketMessage(ws: unknown, m: string): Promise<void>;
  };
  const frames: Record<string, unknown>[] = [];
  const ws = {
    readyState: 1,
    serializeAttachment: () => {},
    // The device: what code-mcp does with a frame (admit, run, sign the reply, answer).
    send: (text: string) => {
      const frame = JSON.parse(text) as Record<string, any>;
      if (typeof frame.id !== "string") return; // `registered`, and what else the gateway says that is not a call
      frames.push(frame);
      const admission = auth.admit(frame);
      let response: Record<string, unknown>;
      if (admission.action === "refuse") response = admission.response;
      else {
        const request = admission.request as { id: unknown };
        ran.push(request);
        response = { jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "ok" }] } };
      }
      const responseBody = JSON.stringify(response);
      const replySig = admission.reply ? auth.replySig(admission.reply, responseBody) : undefined;
      // A frame without `request` is answered by `responseText` alone, as code-mcp does.
      const reply = {
        id: frame.id,
        ...(Object.hasOwn(frame, "request") ? { response } : {}),
        responseText: responseBody,
        ...(replySig && !options.dropReplySig ? { replySig } : {}),
      };
      queueMicrotask(() => void dev.webSocketMessage(ws, JSON.stringify(reply)));
    },
  };
  dev.ws = ws;
  if (options.rawOnly) {
    // The device says at register that it reads a signed call from `raw` alone (the DO is bound to the id by a call's header; here, by hand).
    (dev as unknown as { deviceId: string }).deviceId = "laptop";
    void dev.webSocketMessage(ws, JSON.stringify({ type: "register", deviceId: "laptop", capabilities: ["call-raw-only"] }));
  }

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    expect(String(url)).toBe(`${GATEWAY}/device/laptop`);
    return dev.fetch(new Request("https://do/mcp", { method: "POST", headers: { "x-device-id": "laptop", "content-type": "application/json", ...(init?.headers as Record<string, string>) }, body: init?.body as string }));
  }) as typeof fetch;

  const notices: string[] = [];
  const client = new GatewayClient({ deviceId: "laptop", gateway: GATEWAY, timeoutMs: 5000 } as never, { signer: new CallSigner({ path: keyPath }), notice: (x) => notices.push(x) });
  const call = () => client.callTool("write", { cwd: dir, path: join(dir, "x.txt"), content: "x" }, { handshake: "never" });
  return { auth, ran, frames, client, call, notices, dir, callers, key };
}

describe("a signed call across the CLI, the gateway and the device", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.PRIME_DEVICE_KEYS;
  });

  test("the device runs what was signed, and the CLI verifies and pins the device that answered", async () => {
    const pins = join(mkdtempSync(join(tmpdir(), "prime-interop-pins-")), "pins.json");
    process.env.PRIME_DEVICE_KEYS = pins;
    const w = world();
    await w.call();
    expect(w.auth.counts.signed).toBe(1);
    expect(w.auth.counts.refused).toBe(0);
    expect(w.ran).toHaveLength(1);
    // The frame the gateway wrote carries the signed body and the header as sent.
    expect(typeof w.frames[0]!.raw).toBe("string");
    expect(typeof w.frames[0]!.callerSig).toBe("string");
    expect(w.notices).toEqual([]);
    expect(Object.keys(JSON.parse(readFileSync(pins, "utf8")))).toEqual([`laptop@${GATEWAY}`]);
    // A second call goes through the same way (a new nonce each time), and a replayed frame does not.
    await w.call();
    expect(w.auth.counts.signed).toBe(2);
    const replayed = w.auth.admit(w.frames[0]!);
    expect(replayed.action).toBe("refuse");
  });

  test("a gateway that loses the device's reply signature is noticed once the device is pinned", async () => {
    process.env.PRIME_DEVICE_KEYS = join(mkdtempSync(join(tmpdir(), "prime-interop-pins-")), "pins.json");
    const good = world();
    await good.call(); // pins the key of this world's device
    const bad = world({ dropReplySig: true });
    // another device object, same name and gateway, whose key is not the pinned one and which does not sign: refused
    await expect(bad.call()).rejects.toThrow(/without signing its reply/);
  });

  test("a device that was told to refuse this machine answers with its signed refusal, which reaches the user as the refusal", async () => {
    process.env.PRIME_DEVICE_KEYS = join(mkdtempSync(join(tmpdir(), "prime-interop-pins-")), "pins.json");
    const w = world();
    await w.call(); // the device is pinned
    removeCaller(w.callers, w.key.keyId);
    const refused = await w.call().then(() => undefined, (e: unknown) => e as { code?: number; message: string });
    expect(refused?.code).toBe(-32001);
    expect(refused?.message).not.toMatch(/gateway may have made/);
    expect(w.ran).toHaveLength(1); // the second call did not run
  });

  test("a device that registered as call-raw-only is sent `raw` and no `request`, answers with `responseText` alone, and the CLI still verifies", async () => {
    process.env.PRIME_DEVICE_KEYS = join(mkdtempSync(join(tmpdir(), "prime-interop-pins-")), "pins.json");
    const w = world({ rawOnly: true });
    await w.call();
    expect(w.frames).toHaveLength(1);
    expect(w.frames[0]).not.toHaveProperty("request");
    expect(typeof w.frames[0]!.raw).toBe("string");
    expect(w.auth.counts.signed).toBe(1);
    expect(w.ran).toHaveLength(1);
    expect(w.notices).toEqual([]);
    expect(Object.keys(JSON.parse(readFileSync(process.env.PRIME_DEVICE_KEYS!, "utf8")))).toEqual([`laptop@${GATEWAY}`]); // pinned: the signature held
  });
});
