// Signed tool calls through the gateway: the client's body and signature header reach the
// device exactly as sent, and the device's reply signature and signed text come back untouched.
import { describe, expect, mock, test } from "bun:test";

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

const { DeviceDO, TUNNEL_FRAME_MAX, frameFits } = await import("../src/device-do");
const { default: worker } = await import("../src/index");
const { verifierFor } = await import("../src/token-hash");

const SIG = "v1.AAAAAAAAAAAAAAAAAAAAAA.1700000000000.BBBBBBBBBBBBBBBBBBBBBB.CCCC_-cccc";
const REPLY = "v1.DDDDDDDDDD.EEEEEEEEEE";

// A device object with a fake tunnel: `sent` is every frame the gateway wrote to the device.
function device(env: Record<string, unknown> = {}) {
  const sent: Record<string, unknown>[] = [];
  const registry = { idFromName: () => "global", get: () => ({ fetch: async () => Response.json({}) }) };
  const ctx = { getWebSockets: () => [], waitUntil: () => {}, storage: { get: async () => undefined, put: async () => {}, delete: async () => true, list: async () => new Map(), setAlarm: async () => {}, getAlarm: async () => null, deleteAlarm: async () => {} } };
  const dev = new DeviceDO(ctx as never, { REGISTRY: registry, ...env } as never) as unknown as {
    ws: unknown;
    fetch(r: Request): Promise<Response>;
    webSocketMessage(ws: unknown, m: string): Promise<void>;
  };
  // control frames (registered, keepalive-ack) are not calls, and are not recorded
  const ws = { readyState: 1, send: (s: string) => void ((JSON.parse(s) as { type?: string }).type ? undefined : sent.push(JSON.parse(s))),  serializeAttachment: () => {} };
  dev.ws = ws;
  (dev as unknown as { deviceId: string }).deviceId = "dev1"; // set by the first request, which a register frame may come before
  const post = (body: string | Uint8Array, headers: Record<string, string> = {}, path = "/mcp") =>
    dev.fetch(new Request("https://do" + path, { method: "POST", headers: { "x-device-id": "dev1", "content-type": "application/json", ...headers }, body }));
  // answer the oldest unanswered frame
  const reply = (frame: Record<string, unknown>) => dev.webSocketMessage(ws, JSON.stringify({ id: sent[sent.length - 1]!.id, ...frame }));
  const register = (capabilities?: unknown) => dev.webSocketMessage(ws, JSON.stringify({ type: "register", deviceId: "dev1", ...(capabilities !== undefined && { capabilities }) }));
  return { dev, ws, sent, post, reply, register };
}

const CALL = '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"bash","arguments":{"command":"echo \\u00e9  \\n"}}}';

describe("the call goes to the device as it was signed", () => {
  test("a signed call's frame carries the body byte for byte and the header verbatim", async () => {
    const { sent, post, reply } = device();
    // odd on purpose: key order, escapes, runs of spaces, a final newline: a re-serialisation would change them
    const body = '{ "params" : {"name":"bash", "arguments":{"command":"echo \\u00e9   x"}},\n "method":"tools/call","id":7,"jsonrpc":"2.0" }\n';
    const res = post(body, { "x-prime-call-sig": SIG });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.raw).toBe(body);
    expect(sent[0]!.callerSig).toBe(SIG);
    expect((sent[0]!.request as { method: string }).method).toBe("tools/call"); // the parsed copy is still there for older devices
    await reply({ response: { jsonrpc: "2.0", id: 7, result: {} } });
    expect((await res).status).toBe(200);
  });

  test("a body with a byte-order mark and multi-byte characters arrives exactly, the mark included", async () => {
    const { sent, post, reply } = device();
    const bytes = new TextEncoder().encode('\ufeff{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x","arguments":{"t":"日本語 \u{1F600}"}}}');
    const res = post(bytes, { "x-prime-call-sig": SIG });
    await new Promise((r) => setTimeout(r, 20));
    expect(new TextEncoder().encode(sent[0]!.raw as string)).toEqual(bytes);
    await reply({ response: { jsonrpc: "2.0", id: 1, result: {} } });
    expect((await res).status).toBe(200); // and the call itself still works, as it did before the mark was kept
  });

  test("an unsigned call's frame is what it always was: no raw, no callerSig", async () => {
    const { sent, post, reply } = device();
    const res = post(CALL);
    await new Promise((r) => setTimeout(r, 20));
    expect(Object.keys(sent[0]!).sort()).toEqual(["client", "id", "request"]);
    await reply({ response: { jsonrpc: "2.0", id: 7, result: {} } });
    await res;
  });

  test("a header that cannot be a signature is not forwarded; a body that is not UTF-8 goes without raw", async () => {
    const { sent, post, reply } = device();
    const a = post(CALL, { "x-prime-call-sig": "has a space" });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent[0]).not.toHaveProperty("callerSig");
    expect(sent[0]).not.toHaveProperty("raw");
    await reply({ response: { jsonrpc: "2.0", id: 7, result: {} } });
    await a;
    // 0xff inside a string: valid to the old relay (it replaces the byte), no exact text exists for it
    const bad = new Uint8Array([...new TextEncoder().encode('{"jsonrpc":"2.0","id":8,"method":"ping","x":"'), 0xff, ...new TextEncoder().encode('"}')]);
    const b = post(bad, { "x-prime-call-sig": SIG });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent[1]!.callerSig).toBe(SIG);
    expect(sent[1]).not.toHaveProperty("raw");
    await reply({ response: { jsonrpc: "2.0", id: 8, result: {} } });
    await b;
  });

  test("the cap is in bytes: a body of few characters and many bytes is refused", async () => {
    const { sent, post } = device({ MAX_BODY_BYTES: "300" });
    const body = '{"jsonrpc":"2.0","id":1,"method":"ping","params":{"p":"' + "日".repeat(120) + '"}}'; // fewer than 300 characters, more than 300 bytes
    expect(body.length).toBeLessThan(300);
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(300);
    expect((await post(body, { "x-prime-call-sig": SIG })).status).toBe(413);
    expect(sent).toHaveLength(0);
  });

  test("the body cap still applies, and a signed body is counted once", async () => {
    const { sent, post, reply } = device({ MAX_BODY_BYTES: "300" });
    const pad = (n: number) => '{"jsonrpc":"2.0","id":1,"method":"ping","params":{"p":"' + "x".repeat(n) + '"}}';
    const fits = pad(300 - pad(0).length);
    expect(fits.length).toBe(300);
    const ok = post(fits, { "x-prime-call-sig": SIG });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(1); // 300 bytes of body is not 600
    await reply({ response: { jsonrpc: "2.0", id: 1, result: {} } });
    expect((await ok).status).toBe(200);
    const over = await post(pad(300 - pad(0).length + 1), { "x-prime-call-sig": SIG });
    expect(over.status).toBe(413);
    expect(sent).toHaveLength(1);
  });
});

describe("how big a frame gets", () => {
  // Backslashes are the worst case: the body carries each as an escaped pair, and `raw` (a string inside the frame) escapes
  // every one of those again, so `raw` alone is twice the body, and with the parsed copy the frame is about three times.
  const heavy = (bytes: number) => {
    const head = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x","arguments":{"t":"';
    const tail = '"}}}';
    const filler = "\\\\\\\\";
    const n = Math.floor((bytes - head.length - tail.length) / filler.length);
    const body = head + filler.repeat(n) + tail;
    return body + " ".repeat(bytes - body.length);
  };

  test("an escape-heavy body at the cap makes a frame about three times its size, far inside the tunnel's message limit", async () => {
    const cap = 1024 * 1024;
    const { sent, post, reply } = device({ MAX_BODY_BYTES: String(cap) });
    const body = heavy(cap);
    expect(body.length).toBe(cap);
    const res = post(body, { "x-prime-call-sig": SIG });
    await new Promise((r) => setTimeout(r, 200));
    expect(sent).toHaveLength(1);
    const frameBytes = new TextEncoder().encode(JSON.stringify(sent[0])).byteLength;
    expect(frameBytes).toBeGreaterThan(2.5 * cap);
    expect(frameBytes).toBeLessThan(3.5 * cap);
    expect(frameBytes).toBeLessThan(TUNNEL_FRAME_MAX);
    await reply({ response: { jsonrpc: "2.0", id: 1, result: {} } });
    await res;
  });

  test("a frame over the limit is a 413 that says so, and nothing is sent; the same body unsigned still goes", async () => {
    const cap = 12 * 1024 * 1024;
    const { sent, post } = device({ MAX_BODY_BYTES: String(cap) });
    const body = heavy(cap);
    const res = await post(body, { "x-prime-call-sig": SIG });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { reason: string }).reason).toBe("frame");
    expect(sent).toHaveLength(0);
    void post(body);
    await new Promise((r) => setTimeout(r, 400));
    expect(sent).toHaveLength(1);
  });

  test("frameFits counts bytes, not characters", () => {
    expect(frameFits("x".repeat(1000))).toBe(true);
    expect(frameFits("x".repeat(TUNNEL_FRAME_MAX + 1))).toBe(false);
    expect(frameFits("日".repeat(Math.floor(TUNNEL_FRAME_MAX / 3) + 10))).toBe(false); // short in characters, over in bytes
    expect(frameFits("日".repeat(Math.floor(TUNNEL_FRAME_MAX / 3) - 10))).toBe(true);
  });
});

describe("a device that reads a signed call from raw alone", () => {
  test("is sent no parsed copy, and only for a signed call", async () => {
    const { sent, post, register, reply } = device();
    await register(["call-raw-only"]);
    const signed = post(CALL, { "x-prime-call-sig": SIG });
    await new Promise((r) => setTimeout(r, 20));
    expect(Object.keys(sent[0]!).sort()).toEqual(["callerSig", "client", "id", "raw"]);
    expect(sent[0]!.raw).toBe(CALL);
    await reply({ responseText: '{"jsonrpc":"2.0","id":7,"result":{}}', replySig: REPLY });
    await signed;
    const unsigned = post(CALL);
    await new Promise((r) => setTimeout(r, 20));
    expect(Object.keys(sent[1]!).sort()).toEqual(["client", "id", "request"]); // an unsigned call has no raw to be read from
    await reply({ response: { jsonrpc: "2.0", id: 7, result: {} } });
    await unsigned;
  });

  test("a device that did not say so, or said something else, is sent both", async () => {
    const { sent, post, register, reply } = device();
    const a = post(CALL, { "x-prime-call-sig": SIG });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent[0]).toHaveProperty("request");
    await reply({ response: { jsonrpc: "2.0", id: 7, result: {} } });
    await a;
    await register(["something-else", 5, null]);
    const b = post(CALL, { "x-prime-call-sig": SIG });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent[1]).toHaveProperty("request");
    await reply({ response: { jsonrpc: "2.0", id: 7, result: {} } });
    await b;
  });

  test("a body that is not UTF-8 has no raw, so the parsed copy still goes", async () => {
    const { sent, post, register, reply } = device();
    await register(["call-raw-only"]);
    const bad = new Uint8Array([...new TextEncoder().encode('{"jsonrpc":"2.0","id":8,"method":"ping","x":"'), 0xff, ...new TextEncoder().encode('"}')]);
    const res = post(bad, { "x-prime-call-sig": SIG });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent[0]).toHaveProperty("request");
    expect(sent[0]).not.toHaveProperty("raw");
    await reply({ response: { jsonrpc: "2.0", id: 8, result: {} } });
    await res;
  });

  test("the capability is kept with the connection, so a woken object remembers it", async () => {
    const a = device();
    const kept: unknown[] = [];
    a.ws.serializeAttachment = (v: unknown) => void kept.push(v);
    await a.register(["call-raw-only"]);
    expect((kept[kept.length - 1] as { caps: string[] }).caps).toEqual(["call-raw-only"]);
    const attachment = kept[kept.length - 1];
    const storage = { get: async () => undefined, put: async () => {}, delete: async () => true, list: async () => new Map(), setAlarm: async () => {}, getAlarm: async () => null, deleteAlarm: async () => {} };
    const env = { REGISTRY: { idFromName: () => "g", get: () => ({ fetch: async () => Response.json({}) }) } };
    const woken = new DeviceDO({ getWebSockets: () => [{ deserializeAttachment: () => attachment, readyState: 1 }], waitUntil: () => {}, storage } as never, env as never) as unknown as { deviceCaps: Set<string> };
    expect([...woken.deviceCaps]).toEqual(["call-raw-only"]);
  });

  test("a woken object takes the tunnel accepted last, not the first one listed, while a replaced socket is still closing", async () => {
    const storage = { get: async () => undefined, put: async () => {}, delete: async () => true, list: async () => new Map(), setAlarm: async () => {}, getAlarm: async () => null, deleteAlarm: async () => {} };
    const env = { REGISTRY: { idFromName: () => "g", get: () => ({ fetch: async () => Response.json({}) }) } };
    const old = { name: "old", readyState: 2, deserializeAttachment: () => ({ deviceId: "dev1", lastSeen: 5, origin: "old", caps: [], acc: 1000 }) };
    const fresh = { name: "fresh", readyState: 1, deserializeAttachment: () => ({ deviceId: "dev1", lastSeen: 6, origin: "fresh", caps: ["call-raw-only"], acc: 2000 }) };
    for (const listed of [[old, fresh], [fresh, old]]) {
      const woken = new DeviceDO({ getWebSockets: () => listed, waitUntil: () => {}, storage } as never, env as never) as unknown as { ws: { name: string }; deviceCaps: Set<string>; tunnelOrigin: unknown };
      expect(woken.ws.name).toBe("fresh");
      expect([...woken.deviceCaps]).toEqual(["call-raw-only"]);
      expect(woken.tunnelOrigin).toBe("fresh");
    }
  });
});

describe("the answer comes back as the device signed it", () => {
  test("a reply of only responseText is read for its answer and sent as the text; a notification is still no body", async () => {
    const { post, reply } = device();
    const a = post(CALL, { "x-prime-call-sig": SIG });
    await new Promise((r) => setTimeout(r, 20));
    const text = '{"jsonrpc": "2.0",  "id":7,"result":{"ok":true}}';
    await reply({ responseText: text, replySig: REPLY });
    const out = await a;
    expect(out.status).toBe(200);
    expect(out.headers.get("x-prime-reply-sig")).toBe(REPLY);
    expect(await out.text()).toBe(text);
    const b = post('{"jsonrpc":"2.0","method":"notifications/initialized"}', { "x-prime-call-sig": SIG });
    await new Promise((r) => setTimeout(r, 20));
    await reply({ responseText: "{}", replySig: REPLY });
    expect((await b).status).toBe(204);
    const c = post('{"jsonrpc":"2.0","method":"notifications/initialized"}', { "x-prime-call-sig": SIG });
    await new Promise((r) => setTimeout(r, 20));
    await reply({ responseText: "null" });
    expect((await c).status).toBe(204);
  });

  test("a responseText that is not JSON is an error the caller is told of, not a body of garbage", async () => {
    const { post, reply } = device();
    const a = post(CALL, { "x-prime-call-sig": SIG });
    await new Promise((r) => setTimeout(r, 20));
    await reply({ responseText: "<html>", replySig: REPLY });
    const out = await a;
    expect(((await out.json()) as { error?: { code: number } }).error?.code).toBe(-32603);
  });

  test("the reply signature becomes a response header, and the text the device signed is the body", async () => {
    const { post, sent, reply } = device();
    const res = post(CALL, { "x-prime-call-sig": SIG });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(1);
    // spacing that JSON.stringify would not produce: the gateway must not normalise it
    const signedText = '{"jsonrpc": "2.0",  "id":7,"result":{"content":[{"type":"text","text":"é"}]}}';
    await reply({ response: JSON.parse(signedText), replySig: REPLY, responseText: signedText });
    const out = await res;
    expect(out.status).toBe(200);
    expect(out.headers.get("x-prime-reply-sig")).toBe(REPLY);
    expect(out.headers.get("content-type")).toBe("application/json");
    expect(await out.text()).toBe(signedText);
  });

  test("a device that sends only replySig gets the response serialised as before, with the header", async () => {
    const { post, reply } = device();
    const res = post(CALL, { "x-prime-call-sig": SIG });
    await new Promise((r) => setTimeout(r, 20));
    const response = { jsonrpc: "2.0", id: 7, result: { ok: true } };
    await reply({ response, replySig: REPLY });
    const out = await res;
    expect(out.headers.get("x-prime-reply-sig")).toBe(REPLY);
    expect(await out.text()).toBe(JSON.stringify(response));
  });

  test("an answer from an older device has no header and is unchanged", async () => {
    const { post, reply } = device();
    const res = post(CALL);
    await new Promise((r) => setTimeout(r, 20));
    const response = { jsonrpc: "2.0", id: 7, result: { ok: true } };
    await reply({ response });
    const out = await res;
    expect(out.headers.has("x-prime-reply-sig")).toBe(false);
    expect(await out.text()).toBe(JSON.stringify(response));
  });

  test("a reply signature that cannot be one is dropped", async () => {
    const { post, reply } = device();
    const res = post(CALL, { "x-prime-call-sig": SIG });
    await new Promise((r) => setTimeout(r, 20));
    await reply({ response: { jsonrpc: "2.0", id: 7, result: {} }, replySig: "bad value\r\nx: y" });
    expect((await res).headers.has("x-prime-reply-sig")).toBe(false);
  });

  test("a notification acknowledgement is still a 204 with no body", async () => {
    const { post, reply } = device();
    const res = post('{"jsonrpc":"2.0","method":"notifications/initialized"}', { "x-prime-call-sig": SIG });
    await new Promise((r) => setTimeout(r, 20));
    await reply({ response: null, replySig: REPLY });
    expect((await res).status).toBe(204);
  });
});

describe("the event-stream transport", () => {
  test("a signed message reaches the device as signed and its reply signature rides in the event", async () => {
    const { dev, sent, reply } = device();
    const open = await dev.fetch(new Request("https://do/sse", { method: "GET", headers: { "x-device-id": "dev1" } }));
    const reader = open.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const session = /session=([^\s&]+)/.exec(first)![1]!;
    const body = '{"jsonrpc":"2.0",  "id":3,"method":"tools/call","params":{"name":"bash"}}';
    const accepted = await dev.fetch(
      new Request("https://do/messages?session=" + session, { method: "POST", headers: { "x-device-id": "dev1", "x-prime-call-sig": SIG }, body }),
    );
    expect(accepted.status).toBe(202);
    expect(sent[0]!.raw).toBe(body);
    expect(sent[0]!.callerSig).toBe(SIG);
    await reply({ response: { jsonrpc: "2.0", id: 3, result: {} }, replySig: REPLY });
    const event = new TextDecoder().decode((await reader.read()).value);
    expect(event).toContain("x-prime-reply-sig: " + REPLY + "\n");
    expect(event).toContain('data: {"jsonrpc":"2.0","id":3,"result":{}}');
    await reader.cancel();
  });

  test("the text the device signed is the event's data when it is one line, and the serialised answer when it is not", async () => {
    const { dev, sent, reply } = device();
    const open = await dev.fetch(new Request("https://do/sse", { method: "GET", headers: { "x-device-id": "dev1" } }));
    const reader = open.body!.getReader();
    const session = /session=([^\s&]+)/.exec(new TextDecoder().decode((await reader.read()).value))![1]!;
    const send = (id: number) =>
      dev.fetch(new Request("https://do/messages?session=" + session, { method: "POST", headers: { "x-device-id": "dev1", "x-prime-call-sig": SIG }, body: `{"jsonrpc":"2.0","id":${id},"method":"tools/call"}` }));
    await send(4);
    const spaced = '{"jsonrpc": "2.0",  "id":4,"result":{}}'; // JSON.stringify would not make this
    await reply({ responseText: spaced, replySig: REPLY });
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("data: " + spaced + "\n\n");
    await send(5);
    await reply({ responseText: '{"jsonrpc":"2.0","id":5,\n"result":{}}', replySig: REPLY }); // two lines: cannot be a data line as it is
    const event = new TextDecoder().decode((await reader.read()).value);
    expect(event).toContain('data: {"jsonrpc":"2.0","id":5,"result":{}}\n\n');
    expect(sent).toHaveLength(2);
    await reader.cancel();
  });
});

// ---- the Worker in front -----------------------------------------------------

const PEPPER = "test-pepper-0123456789abcdef0123456789";
async function gateway() {
  const forwarded: { url: string; headers: Headers; body: string }[] = [];
  const env = { TOKEN_PEPPER: PEPPER } as Record<string, unknown>;
  // ids of its own: other test files leave a snapshot in the Worker's short cache, which is re-read for an id it does not know
  const verifier = await verifierFor(env as never, "device", "dev-token");
  const answers: Record<string, unknown> = {
    "/map": { map: { "sig-dev": verifier, "sig-primary": verifier }, anonymous: [], online: [], locked: [], buddies: {}, paused: [], blocked: [], disabled: [] },
    "/blocked": { ips: [] },
    "/disabled": { disabled: [] },
    "/usage": { spentUsd: 0, budgetUsd: 20, overBudget: false },
  };
  env.REGISTRY = {
    idFromName: () => "global",
    get: () => ({ fetch: async (input: string | Request) => Response.json(answers[new URL(typeof input === "string" ? input : input.url).pathname] ?? {}) }),
  };
  env.FLEET = { idFromName: () => "acme", get: () => ({ fetch: async () => Response.json({ member: true, primary: "sig-primary", since: Date.now() }) }) };
  env.DEVICES = {
    idFromName: (n: string) => n,
    get: () => ({
      fetch: async (req: Request) => {
        forwarded.push({ url: req.url, headers: req.headers, body: await req.text() });
        return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { headers: { "content-type": "application/json", "x-prime-reply-sig": REPLY } });
      },
    }),
  };
  return { env, forwarded };
}

describe("the Worker passes the signature on", () => {
  test("a call to a device carries x-prime-call-sig and the untouched body to the device object, and the reply header back", async () => {
    const { env, forwarded } = await gateway();
    const body = '{ "jsonrpc":"2.0", "id":1,"method":"tools/call","params":{"name":"x"} }';
    const res = await worker.fetch(
      new Request("https://gw/device/sig-dev", { method: "POST", headers: { "x-device-token": "dev-token", "x-prime-call-sig": SIG, "content-type": "application/json", "cf-connecting-ip": "198.51.100.1" }, body }),
      env as never,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-prime-reply-sig")).toBe(REPLY);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.headers.get("x-prime-call-sig")).toBe(SIG);
    expect(forwarded[0]!.body).toBe(body);
  });

  test("an unsigned call carries no such header", async () => {
    const { env, forwarded } = await gateway();
    await worker.fetch(
      new Request("https://gw/device/sig-dev", { method: "POST", headers: { "x-device-token": "dev-token", "content-type": "application/json", "cf-connecting-ip": "198.51.100.2" }, body: CALL }),
      env as never,
    );
    expect(forwarded[0]!.headers.has("x-prime-call-sig")).toBe(false);
  });

  test("a call to a fleet reaches the primary with the signature and the untouched body", async () => {
    const { env, forwarded } = await gateway();
    const body = '{"jsonrpc":"2.0" ,"id":1,"method":"tools/call","params":{"name":"x"}}';
    const res = await worker.fetch(
      new Request("https://gw/device/sig-dev?fleet=acme", { method: "POST", headers: { "x-device-token": "dev-token", "x-prime-call-sig": SIG, "content-type": "application/json", "cf-connecting-ip": "198.51.100.4" }, body }),
      env as never,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-prime-reply-sig")).toBe(REPLY);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.headers.get("x-device-id")).toBe("sig-primary"); // the primary, not the caller
    expect(forwarded[0]!.headers.get("x-prime-call-sig")).toBe(SIG);
    expect(forwarded[0]!.body).toBe(body);
  });

  test("the event-stream message leg passes it on too", async () => {
    const { env, forwarded } = await gateway();
    await worker.fetch(
      new Request("https://gw/messages/sig-dev?session=s1", { method: "POST", headers: { "x-device-token": "dev-token", "x-prime-call-sig": SIG, "cf-connecting-ip": "198.51.100.3" }, body: CALL }),
      env as never,
    );
    expect(forwarded[0]!.headers.get("x-prime-call-sig")).toBe(SIG);
    expect(forwarded[0]!.body).toBe(CALL);
  });
});
