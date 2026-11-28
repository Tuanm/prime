// A small snapshot rides in the event that announces it, and only when what rides is what its key says.
import { deleteRows, listRows } from "./fake-list";
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";

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

const { FleetDO } = await import("../src/fleet-do");
const { handleFleetRoutes } = await import("../src/fleets-routes");
const { INLINE_PACK_BYTES } = await import("../src/fleets");

const KEY = "A".repeat(43) + "=";

/** A fleet object over storage that lists what is written, with the environment it is given. */
function world(env: Record<string, unknown> = {}, listeners: string[] = []) {
  const sent: string[] = [];
  const sentTo: Record<string, string[]> = {};
  // A fleet object runs one block at a time, as the platform does: a test that races two changes needs that to be so.
  let tail: Promise<unknown> = Promise.resolve();
  const data = new Map<string, unknown>();
  const writes: string[] = [];
  const storage: Record<string, unknown> = {
    async get(key: string) {
      const v = data.get(key);
      return v === undefined ? undefined : structuredClone(v);
    },
    async put(key: string, value: unknown) {
      writes.push("put:" + key);
      data.set(key, JSON.parse(JSON.stringify(value)));
    },
    async delete(key: string | string[]) {
      writes.push("delete:" + key);
      return Array.isArray(key) ? deleteRows(data, key) : data.delete(key);
    },
    async list(o: { prefix?: string; start?: string; limit?: number; reverse?: boolean }) {
      return listRows(data, o);
    },
  };
  if (listeners.length > 0) storage.setAlarm = async () => {};
  const objects = new Map<string, { body: string; etag: string }>();
  const bucket = {
    async get(key: string) {
      const o = objects.get(key);
      return o ? { etag: o.etag, json: async () => JSON.parse(o.body) } : null;
    },
    async put(key: string, body: string) {
      objects.set(key, { body, etag: "e" + objects.size });
      return { etag: "e" };
    },
    async delete() {},
    async list() {
      return { objects: [], truncated: false };
    },
  };
  const registry = { idFromName: () => "global", get: () => ({ fetch: async () => Response.json({ ok: true }) }) };
  const state = {
    storage,
    blockConcurrencyWhile: <T>(fn: () => Promise<T>): Promise<T> => {
      const run = tail.then(fn, fn);
      tail = run.catch(() => undefined);
      return run;
    },
    getWebSockets: () =>
      listeners.map((id) => ({
        send: (m: string) => {
          sent.push(m);
          (sentTo[id] ??= []).push(m);
        },
        close() {},
        deserializeAttachment: () => ({ deviceId: id }),
      })),
  };
  const fleet = new FleetDO(state as never, { BUCKET: bucket, REGISTRY: registry, ...env } as never);
  return { fleet, data, writes, bucket, objects, sent, sentTo };
}
type World = ReturnType<typeof world>;

async function call(w: World, path: string, device: string, caller: "admin" | "device", body: Record<string, unknown> = {}, method = "POST") {
  const headers = new Headers({ "content-type": "application/json", "x-prime-caller": caller, "x-prime-fleet": "acme" });
  if (device) headers.set("x-prime-device", device);
  const res = await w.fleet.fetch(new Request("https://fleet" + path, { method, headers, body: method === "GET" ? undefined : JSON.stringify({ pubkey: KEY, ...body }) }));
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

/** A fleet owned by `owner`, with the members `ids` admitted. */
async function fleetOf(ids: string[], env: Record<string, unknown> = {}, listeners: string[] = []): Promise<World> {
  const w = world(env, listeners);
  await call(w, "/create", "owner", "admin");
  for (const id of ["owner", ...ids]) {
    const invite = await call(w, "/invite", "owner", "admin", {});
    await call(w, "/join", id, "device", { code: invite.json.code });
    await call(w, "/approve", "operator", "admin", { deviceId: id });
  }
  return w;
}
const ask = (w: World, id: string, body: Record<string, unknown> = {}) => call(w, "/bootstrap", id, "device", body);
const setLease = (w: World, leaseMs: unknown, who = "operator", caller: "admin" | "device" = "admin") => call(w, "/meta", who, caller, { leaseMs });

beforeEach(() => setSystemTime(new Date("2026-12-01T10:00:00Z")));
afterEach(() => setSystemTime());

const sha = async (data: Uint8Array | string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : data)), (b) => b.toString(16).padStart(2, "0")).join("");

/** What a publisher makes of a pack: its manifest as stored, the key the manifest is stored under, and the body of the advance. */
async function snapshot(pack: Uint8Array, over: Record<string, unknown> = {}) {
  const packHash = await sha(pack);
  const manifestText = JSON.stringify({ seq: 1, full: false, packKey: "fleets/acme/packs/" + packHash, packHash, packBytes: pack.length, ...over });
  const manifestHash = await sha(manifestText);
  const manifestKey = "fleets/acme/manifests/" + manifestHash;
  return { packHash, manifestText, manifestHash, manifestKey, b64: Buffer.from(pack).toString("base64") };
}

/** dev-a holds the lease; `listeners` have a socket open; dev-b says it takes a small snapshot in the event, unless `caps` says otherwise. */
async function primary(listeners: string[] = ["dev-b"], caps: string[] = ["inline"]) {
  const w = world({}, listeners);
  await call(w, "/create", "owner", "admin");
  const invite = await call(w, "/invite", "owner", "admin", {});
  await call(w, "/join", "dev-a", "device", { code: invite.json.code });
  await call(w, "/approve", "operator", "admin", { deviceId: "dev-a" });
  const inv2 = await call(w, "/invite", "owner", "admin", {});
  await call(w, "/join", "dev-b", "device", { code: inv2.json.code });
  await call(w, "/approve", "operator", "admin", { deviceId: "dev-b" });
  expect((await call(w, "/bootstrap", "dev-a", "device", { seals: true })).json.role).toBe("primary");
  await call(w, "/bootstrap", "dev-b", "device", { seals: true, caps });
  w.sent.length = 0;
  for (const k of Object.keys(w.sentTo)) delete w.sentTo[k];
  return w;
}
const advance = (w: World, s: Awaited<ReturnType<typeof snapshot>>, inline: unknown, meta: Record<string, unknown> = { sealed: true }) =>
  call(w, "/head/advance", "dev-a", "device", { expectedSeq: 0, manifestKey: s.manifestKey, manifestHash: s.manifestHash, packKey: "", meta, ...(inline === undefined ? {} : { inline }) });
const heads = (w: World) => w.sent.map((m) => JSON.parse(m)).filter((e) => e.type === "head");

describe("the head event of a small snapshot", () => {
  test("carries the manifest and the pack, which are what the key says", async () => {
    const w = await primary();
    const s = await snapshot(new TextEncoder().encode("sealed pack bytes"));
    expect((await advance(w, s, { manifest: s.manifestText, pack: s.b64 })).status).toBe(200);
    const [event] = heads(w);
    expect(event).toEqual({ type: "head", seq: 1, manifestKey: s.manifestKey, inline: { manifest: s.manifestText, pack: s.b64 } });
    // What was not asked of it is not kept: the head is as it was, nothing of the inline is stored.
    expect(JSON.stringify([...w.data])).not.toContain(s.b64);
  });

  test("carries nothing it does not have to: no inline asked, no listener, a whole tree, or a snapshot in chunks", async () => {
    const w = await primary();
    const s = await snapshot(new TextEncoder().encode("sealed pack bytes"));
    await advance(w, s, undefined);
    expect(heads(w)[0]).toEqual({ type: "head", seq: 1, manifestKey: s.manifestKey });

    const full = await primary();
    const f = await snapshot(new TextEncoder().encode("whole tree"), { full: true });
    await advance(full, f, { manifest: f.manifestText, pack: f.b64 }, { sealed: true, full: true });
    expect(heads(full)[0]!.inline).toBeUndefined();

    const chunked = await primary();
    const c = await snapshot(new TextEncoder().encode("a piece"), { chunks: [{ hash: "a".repeat(64), bytes: 7 }] });
    await advance(chunked, c, { manifest: c.manifestText, pack: c.b64 });
    expect(heads(chunked)[0]!.inline).toBeUndefined();

    const quiet = await primary([]);
    const q = await snapshot(new TextEncoder().encode("sealed pack bytes"));
    expect((await advance(quiet, q, { manifest: q.manifestText, pack: q.b64 })).status).toBe(200);
    expect(heads(quiet)).toEqual([]);
  });

  test("is not given what is not what the key says: another manifest, another pack, another key, a pack over the limit, garbage", async () => {
    const s = await snapshot(new TextEncoder().encode("sealed pack bytes"));
    const other = await snapshot(new TextEncoder().encode("another pack"));
    const big = await snapshot(new Uint8Array(INLINE_PACK_BYTES + 1).fill(7));
    const cases: Array<[string, unknown]> = [
      ["the manifest of another snapshot", { manifest: other.manifestText, pack: s.b64 }],
      ["a pack the manifest does not name", { manifest: s.manifestText, pack: other.b64 }],
      ["a manifest changed by a byte", { manifest: s.manifestText.replace("false", "false "), pack: s.b64 }],
      ["a pack over 64 KiB", { manifest: big.manifestText, pack: big.b64 }],
      ["not strings", { manifest: 1, pack: 2 }],
      ["a string", "inline"],
      ["empty", { manifest: "", pack: "" }],
      ["not base64", { manifest: s.manifestText, pack: "!!!" }],
    ];
    for (const [name, inline] of cases) {
      const w = await primary();
      const target = name.startsWith("a pack over") ? big : s;
      const res = await advance(w, target, inline);
      expect(res.status).toBe(200);
      expect([name, heads(w)[0]?.inline]).toEqual([name, undefined]);
    }
    // ...and a key that is not where the manifest is stored.
    const w = await primary();
    const res = await call(w, "/head/advance", "dev-a", "device", { expectedSeq: 0, manifestKey: "fleets/acme/manifests/" + "f".repeat(64), manifestHash: s.manifestHash, packKey: "", meta: { sealed: true }, inline: { manifest: s.manifestText, pack: s.b64 } });
    expect(res.status).toBe(200);
    expect(heads(w)[0]!.inline).toBeUndefined();
  });

  test("rides only to the listeners whose member says it takes it; the others are told as they always were", async () => {
    // dev-b says it takes it; dev-c listens too and says nothing (an earlier build); the publisher is not told at all.
    const w = await primary(["dev-b", "dev-c", "dev-a"]);
    await call(w, "/join", "dev-c", "device", { code: (await call(w, "/invite", "owner", "admin", {})).json.code });
    await call(w, "/approve", "operator", "admin", { deviceId: "dev-c" });
    await call(w, "/bootstrap", "dev-c", "device", { seals: true });
    const s = await snapshot(new TextEncoder().encode("sealed pack bytes"));
    expect((await advance(w, s, { manifest: s.manifestText, pack: s.b64 })).status).toBe(200);
    const told = (id: string) => (w.sentTo[id] ?? []).map((m) => JSON.parse(m));
    expect(told("dev-b")).toEqual([{ type: "head", seq: 1, manifestKey: s.manifestKey, inline: { manifest: s.manifestText, pack: s.b64 } }]);
    expect(told("dev-c")).toEqual([{ type: "head", seq: 1, manifestKey: s.manifestKey }]);
    expect(told("dev-a")).toEqual([]);
  });

  test("a member that went back to a build without the cap is not sent it", async () => {
    const w = await primary();
    await call(w, "/bootstrap", "dev-b", "device", { seals: true });
    const s = await snapshot(new TextEncoder().encode("sealed pack bytes"));
    await advance(w, s, { manifest: s.manifestText, pack: s.b64 });
    expect(heads(w)[0]).toEqual({ type: "head", seq: 1, manifestKey: s.manifestKey });
  });

  test("nothing is hashed when nobody else could use it: only the publisher listens, or nobody that takes it", async () => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let calls = 0;
    (crypto.subtle as { digest: unknown }).digest = (...args: Parameters<typeof digest>) => {
      calls++;
      return digest(...args);
    };
    try {
      const s = await snapshot(new TextEncoder().encode("sealed pack bytes"));
      for (const [listeners, caps] of [[["dev-a"], ["inline"]], [["dev-b"], []]] as Array<[string[], string[]]>) {
        const w = await primary(listeners, caps);
        calls = 0;
        await advance(w, s, { manifest: s.manifestText, pack: s.b64 });
        // What the object hashes for its own bookkeeping is a constant few; the two passes over the inline are not among them.
        const without = calls;
        const taker = await primary(["dev-b"], ["inline"]);
        calls = 0;
        await advance(taker, s, { manifest: s.manifestText, pack: s.b64 });
        expect(calls).toBeGreaterThan(without);
      }
    } finally {
      (crypto.subtle as { digest: unknown }).digest = digest;
    }
  });

  test("a pack of exactly 64 KiB rides, and the whole event is below what a socket message may be", async () => {
    const w = await primary();
    const s = await snapshot(new Uint8Array(INLINE_PACK_BYTES).map((_, i) => i % 251));
    await advance(w, s, { manifest: s.manifestText, pack: s.b64 });
    expect(heads(w)[0]!.inline).toBeDefined();
    expect(w.sent[0]!.length).toBeLessThan(150_000);
  });
});

describe("what the Worker offers the object", () => {
  async function publishVia(pack: Uint8Array, manifest: Record<string, unknown>) {
    const advances: Array<Record<string, any>> = [];
    const stub = {
      async fetch(input: Request | string, init?: RequestInit) {
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("/role")) return Response.json({ member: true, primary: true, epoch: 1 });
        if (url.endsWith("/head/advance")) {
          advances.push(JSON.parse(String(init?.body ?? "{}")));
          return Response.json({ ok: true, head: { seq: manifest.seq } });
        }
        return Response.json({ ok: true });
      },
    };
    const stored = new Map<string, Uint8Array>();
    const env = {
      BUCKET: { put: async (key: string, v: Uint8Array) => void stored.set(key, v), delete: async () => undefined },
      FLEET: { idFromName: (n: string) => n, get: () => stub },
    } as never;
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(manifestBytes.length, 0);
    const url = new URL("https://gateway/fleets/acme/snapshot");
    const request = new Request(url, { method: "POST", headers: { "x-prime-device": "dev-a", "x-device-token": "t" }, body: Buffer.concat([header, manifestBytes, Buffer.from(pack)]) });
    const res = (await handleFleetRoutes({ request, env, url, cfg: { gatewayToken: "op-secret" } as never, authorizeDevice: async () => ({ ok: true as const }), unauthorized: () => new Response(null, { status: 401 }) }))!;
    return { res, advances, stored };
  }

  test("a small edit is offered with the manifest as it is stored (the final one) and the pack as base64", async () => {
    const pack = new TextEncoder().encode("sealed pack bytes");
    const { res, advances, stored } = await publishVia(pack, { seq: 2, full: false, packBytes: pack.length });
    expect(res.status).toBe(200);
    const inline = advances[0]!.inline as { manifest: string; pack: string };
    expect(Buffer.from(inline.pack, "base64").equals(Buffer.from(pack))).toBe(true);
    // The text is byte-identical to what was stored under its hash.
    const [manifestKey] = [...stored.keys()].filter((k) => k.includes("/manifests/"));
    expect(manifestKey!.endsWith(await sha(inline.manifest))).toBe(true);
    expect(JSON.parse(inline.manifest).packHash).toBe(await sha(pack));
  });

  test("a whole tree, and a pack over 64 KiB, are not offered", async () => {
    const small = new TextEncoder().encode("x");
    expect((await publishVia(small, { seq: 2, full: true })).advances[0]!.inline).toBeUndefined();
    const big = new Uint8Array(INLINE_PACK_BYTES + 1).fill(1);
    expect((await publishVia(big, { seq: 2, full: false })).advances[0]!.inline).toBeUndefined();
    const edge = new Uint8Array(INLINE_PACK_BYTES).fill(1);
    expect((await publishVia(edge, { seq: 2, full: false })).advances[0]!.inline).toBeDefined();
  });
});
