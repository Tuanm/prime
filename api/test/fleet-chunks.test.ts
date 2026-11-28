// A snapshot too big for one request: published in pieces, which the object keeps, the sweep spares, and only members that read them may have.
import { afterEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import { deleteRows, listRows } from "./fake-list";

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

const { installStreamPolyfill } = await import("./stream-polyfill");
installStreamPolyfill();
const { FleetDO } = await import("../src/fleet-do");
const { handleFleetRoutes } = await import("../src/fleets-routes");
const { sweepFleets } = await import("../src/fleet-sweep");
const { CHUNK_BYTES, MAX_CHUNKS, MAX_CHUNKED_SNAPSHOT_BYTES } = await import("../src/fleets");

const KEY = "A".repeat(43) + "=";
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 11, 1, 3, 17);
const hex = (c: string): string => c.repeat(64);
const sha = (d: string | Uint8Array): string => createHash("sha256").update(d).digest("hex");

/** R2 with upload times, listing by prefix and delimiter, and the conditional write the head relies on. */
function bucketAt(clock: { now: number }) {
  const objects = new Map<string, { body: string; etag: string; uploaded: number; size: number }>();
  let n = 0;
  const bucket = {
    objects,
    deleted: [] as string[],
    failHead: false,
    failSize: false,
    seed(key: string, ageMs: number, body = "x") {
      objects.set(key, { body, etag: "s" + n++, uploaded: clock.now - ageMs, size: body.length });
    },
    async delete(key: string | string[]) {
      for (const k of Array.isArray(key) ? key : [key]) {
        bucket.deleted.push(k);
        objects.delete(k);
      }
    },
    async list(opts: { prefix?: string; limit?: number; cursor?: string; delimiter?: string }) {
      const prefix = opts.prefix ?? "";
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix) && (opts.cursor === undefined || k > opts.cursor)).sort();
      if (opts.delimiter) {
        const groups = new Set(keys.map((k) => k.slice(0, prefix.length + k.slice(prefix.length).indexOf(opts.delimiter!) + 1)));
        return { objects: [], delimitedPrefixes: [...groups], truncated: false };
      }
      const limit = opts.limit ?? 1000;
      const page = keys.slice(0, limit);
      const truncated = keys.length > limit;
      return { objects: page.map((key) => ({ key, uploaded: new Date(objects.get(key)!.uploaded) })), truncated, ...(truncated ? { cursor: page[page.length - 1]! } : {}) };
    },
    async head(key: string) {
      if (bucket.failSize) throw new Error("the bucket is down");
      const o = objects.get(key);
      return o ? { key, size: o.size } : null;
    },
    async get(key: string) {
      if (bucket.failHead && key.endsWith("/head")) throw new Error("the bucket is down");
      const o = objects.get(key);
      if (!o) return null;
      return { etag: o.etag, json: async () => JSON.parse(o.body) };
    },
    /** What the last puts were given: a stream is a body that was not held whole. */
    putKinds: [] as string[],
    async put(key: string, given: string | Uint8Array | ReadableStream<Uint8Array>, opts?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string }; sha256?: string }) {
      bucket.putKinds.push(typeof given === "string" ? "string" : given instanceof ReadableStream ? "stream" : "bytes");
      const body: string | Uint8Array = given instanceof ReadableStream ? new Uint8Array(await new Response(given).arrayBuffer()) : given;
      // The bucket checks a hash it is given, and keeps nothing (and leaves what is under the key) when the body is another.
      const wanted = (opts as { sha256?: string } | undefined)?.sha256;
      if (wanted !== undefined && createHash("sha256").update(typeof body === "string" ? Buffer.from(body) : body).digest("hex") !== wanted) {
        throw new Error("put: the SHA-256 checksum you specified did not match what we received (10037)");
      }
      const cur = objects.get(key);
      const cond = opts?.onlyIf;
      if (cond?.etagMatches !== undefined && cur?.etag !== cond.etagMatches) return null;
      if (cond?.etagDoesNotMatch === "*" && cur) return null;
      const etag = "e" + n++;
      const size = typeof body === "string" ? body.length : ((body as { byteLength?: number }).byteLength ?? 0);
      const text = typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array);
      objects.set(key, { body: text.startsWith("{") ? text : "binary", etag, uploaded: clock.now, size });
      return { etag, size: body.length };
    },
  };
  return bucket;
}

function fakeState() {
  const data = new Map<string, unknown>();
  return {
    data,
    storage: {
      async get<T>(key: string): Promise<T | undefined> {
        const v = data.get(key);
        return (v === undefined ? undefined : structuredClone(v)) as T | undefined;
      },
      async put(key: string, value: unknown): Promise<void> {
        data.set(key, JSON.parse(JSON.stringify(value)));
      },
      async delete(key: string | string[]): Promise<boolean | number> {
        return Array.isArray(key) ? deleteRows(data, key) : data.delete(key);
      },
      async list(o: { prefix?: string; start?: string; limit?: number; reverse?: boolean }) {
        return listRows(data, o);
      },
    },
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  };
}

type Bucket = ReturnType<typeof bucketAt>;

/** A gateway's worth of fleet objects over one bucket, and a registry that lists the fleets made through it. */
function world() {
  const clock = { now: T0 };
  const bucket = bucketAt(clock);
  const registered = new Set<string>();
  const states = new Map<string, ReturnType<typeof fakeState>>();
  const objects = new Map<string, InstanceType<typeof FleetDO>>();
  const fleetObject = (id: string) => {
    let o = objects.get(id);
    if (!o) {
      const state = fakeState();
      states.set(id, state);
      o = new FleetDO({ storage: state.storage, blockConcurrencyWhile: state.blockConcurrencyWhile } as never, { BUCKET: bucket } as never);
      objects.set(id, o);
    }
    return o;
  };
  const registry = {
    idFromName: () => "global",
    get: () => ({
      fetch: async (input: string) => {
        if (new URL(input).pathname === "/fleets") return world.registryDown ? new Response("no", { status: 500 }) : Response.json({ fleets: [...registered] });
        return Response.json({ ok: true });
      },
    }),
  };
  const world = {
    clock,
    bucket,
    registered,
    states,
    registryDown: false,
    env: { BUCKET: bucket, REGISTRY: registry, FLEET: { idFromName: (n: string) => n, get: (n: string) => ({ fetch: (u: string, init?: RequestInit) => fleetObject(n).fetch(new Request(u, init)) }) } } as never,
    fleetObject,
    async call(id: string, path: string, caller: "admin" | "device", device: string, body?: unknown, method = "POST") {
      const headers = new Headers({ "content-type": "application/json", "x-prime-caller": caller, "x-prime-device": device, "x-prime-fleet": id });
      const res = await fleetObject(id).fetch(new Request("https://fleet" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify({ pubkey: KEY, ...(body as object) }) }));
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    },
    /** A fleet whose members `caps` say they read pieces (or not); dev-a holds the lease. */
    async fleet(id: string, caps: Record<string, string[]> = { "dev-a": ["chunks"], "dev-b": ["chunks"] }) {
      await world.call(id, "/create", "admin", "operator");
      registered.add(id);
      for (const dev of Object.keys(caps)) {
        const invite = await world.call(id, "/invite", "admin", "operator", {});
        await world.call(id, "/join", "device", dev, { code: invite.json.code });
        await world.call(id, "/approve", "admin", "operator", { deviceId: dev });
      }
      expect((await world.call(id, "/bootstrap", "device", "dev-a", { caps: caps["dev-a"] })).json.role).toBe("primary");
      for (const dev of Object.keys(caps)) if (dev !== "dev-a") await world.call(id, "/bootstrap", "device", dev, { caps: caps[dev] });
    },
    /** A request through the Worker, as a member makes it. */
    async http(id: string, method: string, path: string, body?: Uint8Array | string, device = "dev-a", headers: Record<string, string> = {}) {
      const url = new URL("https://gateway/fleets/" + id + path);
      const request = new Request(url, { method, headers: { "x-prime-device": device, "x-device-token": "t", ...(body !== undefined ? { "content-length": String(typeof body === "string" ? Buffer.byteLength(body) : body.length) } : {}), ...headers }, body: body as never });
      const res = (await handleFleetRoutes({ request, env: world.env, url, cfg: {} as never, authorizeDevice: async () => ({ ok: true as const }), unauthorized: () => new Response(null, { status: 401 }) }))!;
      return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
    },
    /** Upload a piece as an ordinary pack. */
    async piece(id: string, bytes: Uint8Array, streamed = true) {
      // A member that says the hash of the piece (as a newer build does) has it streamed; one that does not has it held and hashed.
      const up = await world.http(id, "POST", "/packs", bytes, "dev-a", streamed ? { "x-prime-sha256": sha(bytes) } : {});
      expect(up.status).toBe(200);
      return { hash: up.json.hash as string, bytes: bytes.length };
    },
    /** Publish a manifest alone (the frame is its length and itself). */
    async publishManifest(id: string, manifest: Record<string, unknown>, pack?: Uint8Array) {
      const text = Buffer.from(JSON.stringify(manifest));
      const head = Buffer.alloc(4);
      head.writeUInt32BE(text.length, 0);
      return world.http(id, "POST", "/snapshot", Buffer.concat([head, text, pack ?? Buffer.alloc(0)]));
    },
  };
  return world;
}


afterEach(() => setSystemTime());
const bytesOf = (n: number, fill: number): Uint8Array => new Uint8Array(n).fill(fill);

/** A manifest for pieces: the whole pack's hash is whatever the member says it is. */
const manifestOf = (id: string, seq: number, pieces: Array<{ hash: string; bytes: number }>, over: Record<string, unknown> = {}) => ({
  seq,
  full: false,
  seal: "tag",
  chunks: pieces,
  packBytes: pieces.reduce((n, p) => n + p.bytes, 0),
  packHash: hex("9"),
  packKey: "fleets/" + id + "/packs/" + pieces[0]!.hash,
  ...over,
});

describe("what the gateway says of pieces", () => {
  test("/role names the most a piece and a whole may be", async () => {
    const w = world();
    await w.fleet("acme");
    const role = await w.call("acme", "/role", "device", "dev-a", undefined, "GET");
    expect(role.json).toMatchObject({ chunkLimit: CHUNK_BYTES, chunkedLimit: MAX_CHUNKED_SNAPSHOT_BYTES, snapshotLimit: 32 * 1024 * 1024 });
    expect(CHUNK_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_CHUNKED_SNAPSHOT_BYTES).toBe(512 * 1024 * 1024);
  });
});

describe("publishing a snapshot in pieces", () => {
  test("the pieces are uploaded as packs, the manifest alone is published, and the head moves", async () => {
    const w = world();
    await w.fleet("acme");
    const pieces = [await w.piece("acme", bytesOf(100, 1)), await w.piece("acme", bytesOf(100, 2)), await w.piece("acme", bytesOf(37, 3))];
    const done = await w.publishManifest("acme", manifestOf("acme", 1, pieces));
    expect(done.status).toBe(200);
    expect(done.json.head.seq).toBe(1);
    // The manifest as stored keeps what the member said of the whole pack and names the first piece as the pack.
    const stored = JSON.parse(w.bucket.objects.get(done.json.manifestKey)!.body);
    expect(stored).toMatchObject({ packKey: "fleets/acme/packs/" + pieces[0]!.hash, packHash: hex("9"), packBytes: 237, chunks: pieces });
    // The snapshot is kept as one, with all its pieces, from the head on.
    const recent = (w.states.get("acme")!.data.get("recent") as string[])[0]!.split("\n");
    expect(recent.sort()).toEqual([done.json.manifestKey, ...pieces.map((p) => "fleets/acme/packs/" + p.hash)].sort());
    expect(w.states.get("acme")!.data.get("storing")).toBeUndefined();
    // The index says it is a snapshot in pieces and how big.
    expect((w.states.get("acme")!.data.get("index") as Array<Record<string, unknown>>)[0]).toMatchObject({ seq: 1, chunked: true, packBytes: 237 });
  });

  test("a manifest alone never has its packKey or packHash taken from the empty frame: the member's packHash stays, packKey is the first piece's", async () => {
    const w = world();
    await w.fleet("acme");
    const pieces = [await w.piece("acme", bytesOf(20, 1)), await w.piece("acme", bytesOf(20, 2))];
    const EMPTY_SHA256 = sha("");
    // The member leaves packKey out: the gateway names the first piece. packHash is the whole pack's, as the member said.
    const { packKey: _omitted, ...bare } = manifestOf("acme", 1, pieces, { packHash: hex("7") });
    const done = await w.publishManifest("acme", bare);
    expect(done.status).toBe(200);
    const stored = JSON.parse(w.bucket.objects.get(done.json.manifestKey)!.body);
    expect(stored.packHash).toBe(hex("7"));
    expect(stored.packHash).not.toBe(EMPTY_SHA256);
    expect(stored.packKey).toBe("fleets/acme/packs/" + pieces[0]!.hash);
    expect(stored.packKey).not.toBe("fleets/acme/packs/" + EMPTY_SHA256);
    // The manifest's bytes in the bucket hash to the manifestHash the head carries, so the member's seal still binds them.
    expect(done.json.head.manifestHash).toBe(sha(w.bucket.objects.get(done.json.manifestKey)!.body));
    // The pack of the empty frame was never stored.
    expect(w.bucket.objects.has("fleets/acme/packs/" + EMPTY_SHA256)).toBe(false);
    // Without a packHash of its own it is refused, not filled in with the hash of nothing.
    const { packHash: _gone, ...noHash } = manifestOf("acme", 2, pieces);
    expect((await w.publishManifest("acme", noHash)).status).toBe(400);
  });

  test("a packKey that is not the first piece's, and a frame that has a pack as well as pieces, are refused", async () => {
    const w = world();
    await w.fleet("acme");
    const pieces = [await w.piece("acme", bytesOf(10, 1))];
    const wrongKey = await w.publishManifest("acme", manifestOf("acme", 1, pieces, { packKey: "fleets/acme/packs/" + hex("e") }));
    expect(wrongKey.status).toBe(400);
    const both = await w.publishManifest("acme", manifestOf("acme", 1, pieces), bytesOf(5, 1));
    expect(both.status).toBe(400);
    // Without pieces, a manifest alone is still an empty pack.
    expect((await w.publishManifest("acme", { seq: 1, seal: "tag" })).json.error).toBe("empty pack");
    expect((await w.states.get("acme")!.data.get("recent")) ?? []).toEqual([]);
  });

  test("a list that is not what it must be is refused: sizes that do not add up, a bad hash, too many, too big", async () => {
    const w = await (async () => {
      const x = world();
      await x.fleet("acme");
      return x;
    })();
    const ok = [await w.piece("acme", bytesOf(10, 1))];
    const publish = (m: Record<string, unknown>) => w.publishManifest("acme", m);
    expect((await publish(manifestOf("acme", 1, ok, { packBytes: 11 }))).status).toBe(400);
    expect((await publish(manifestOf("acme", 1, ok, { packBytes: undefined }))).status).toBe(400);
    expect((await publish(manifestOf("acme", 1, [{ hash: "ABC", bytes: 10 }]))).status).toBe(400);
    expect((await publish(manifestOf("acme", 1, [{ hash: hex("a"), bytes: 0 }]))).status).toBe(400);
    expect((await publish(manifestOf("acme", 1, [{ hash: hex("a"), bytes: CHUNK_BYTES + 1 }]))).status).toBe(400);
    expect((await publish(manifestOf("acme", 1, ok, { chunks: [] }))).status).toBe(400);
    expect((await publish(manifestOf("acme", 1, ok, { chunks: "no" }))).status).toBe(400);
    const many = Array.from({ length: MAX_CHUNKS + 1 }, (_, i) => ({ hash: i.toString(16).padStart(64, "0"), bytes: 1 }));
    const tooMany = await publish(manifestOf("acme", 1, many));
    expect(tooMany.status).toBe(400);
    expect(tooMany.json.error).toMatch(/129 pieces/);
    const huge = Array.from({ length: 65 }, (_, i) => ({ hash: i.toString(16).padStart(64, "0"), bytes: CHUNK_BYTES }));
    const tooBig = await publish(manifestOf("acme", 1, huge));
    expect(tooBig.status).toBe(400);
    expect(tooBig.json.error).toMatch(/most a snapshot may be/);
    expect((await publish(manifestOf("acme", 1, ok, { packHash: "short" }))).status).toBe(400);
    // The most whole is 512 MiB: 64 pieces of the biggest size.
    const most = Array.from({ length: 64 }, (_, i) => ({ hash: i.toString(16).padStart(64, "0"), bytes: CHUNK_BYTES }));
    expect((await publish(manifestOf("acme", 1, most))).status).toBe(409); // sizes fine; the pieces are not there
  });

  test("a piece that is not in the bucket, or not that size, is named, and the head does not move", async () => {
    const w = world();
    await w.fleet("acme");
    const a = await w.piece("acme", bytesOf(50, 1));
    const b = await w.piece("acme", bytesOf(50, 2));
    const missing = { hash: hex("c"), bytes: 20 };
    const res = await w.publishManifest("acme", manifestOf("acme", 1, [a, missing, b]));
    expect(res.status).toBe(409);
    expect(res.json.missing).toEqual([hex("c")]);
    const wrong = await w.publishManifest("acme", manifestOf("acme", 1, [a, { hash: b.hash, bytes: 51 }]));
    expect(wrong.status).toBe(409);
    expect(wrong.json.missing).toEqual([b.hash]);
    expect((await w.http("acme", "GET", "/head")).json.head?.seq ?? 0).toBe(0);
    // Nothing was thrown away: the member uploads the missing one and publishes again.
    expect(w.bucket.objects.has("fleets/acme/packs/" + a.hash)).toBe(true);
    const c = await w.piece("acme", bytesOf(20, 3));
    expect((await w.publishManifest("acme", manifestOf("acme", 1, [a, c, b]))).status).toBe(200);
  });

  test("a publish that the fleet refuses cleans away the pieces, once nothing names them", async () => {
    const w = world();
    await w.fleet("acme");
    const pieces = [await w.piece("acme", bytesOf(10, 1)), await w.piece("acme", bytesOf(10, 2))];
    // Behind: the head is at 0, so seq 5 is a stale sequence.
    const refused = await w.publishManifest("acme", manifestOf("acme", 5, pieces));
    expect(refused.status).toBe(409);
    for (const p of pieces) expect(w.bucket.objects.has("fleets/acme/packs/" + p.hash)).toBe(false);
  });

  test("every member must read pieces: one that does not say so keeps the fleet from having a snapshot in pieces", async () => {
    const w = world();
    await w.fleet("acme", { "dev-a": ["chunks"], "dev-b": [] });
    const pieces = [await w.piece("acme", bytesOf(10, 1))];
    const res = await w.publishManifest("acme", manifestOf("acme", 1, pieces));
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ chunks: false, members: 1 });
    expect(res.json.error).toMatch(/needs every member to read them/);
    // And a member that says it can, later, lets it through.
    await w.call("acme", "/bootstrap", "device", "dev-b", { caps: ["chunks"] });
    const again = [await w.piece("acme", bytesOf(10, 1))];
    expect((await w.publishManifest("acme", manifestOf("acme", 1, again))).status).toBe(200);
  });

  test("the change pack beside a whole tree may be in pieces too, and is kept with the snapshot", async () => {
    const w = world();
    await w.fleet("acme");
    const main = [await w.piece("acme", bytesOf(40, 1))];
    const delta = [await w.piece("acme", bytesOf(30, 2)), await w.piece("acme", bytesOf(30, 3))];
    const res = await w.publishManifest("acme", manifestOf("acme", 1, main, { full: true, delta: { bytes: 60, chunks: delta } }));
    expect(res.status).toBe(200);
    const stored = JSON.parse(w.bucket.objects.get(res.json.manifestKey)!.body);
    expect(stored.delta.packKey).toBe("fleets/acme/packs/" + delta[0]!.hash);
    const recent = (w.states.get("acme")!.data.get("recent") as string[])[0]!.split("\n");
    for (const p of [...main, ...delta]) expect(recent).toContain("fleets/acme/packs/" + p.hash);
    // A change pack whose pieces do not add up is refused.
    const bad = await w.publishManifest("acme", manifestOf("acme", 2, main, { full: true, delta: { bytes: 61, chunks: delta } }));
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/delta\.chunks/);
  });

  test("the cap on the extra keys of a snapshot holds a whole snapshot's two lists", async () => {
    const w = world();
    await w.fleet("acme");
    // 128 pieces of 1 byte each, as the most pieces.
    const pieces: Array<{ hash: string; bytes: number }> = [];
    for (let i = 0; i < MAX_CHUNKS; i++) pieces.push(await w.piece("acme", new Uint8Array([i % 256, (i * 7) % 256, i >> 4, 9])));
    const res = await w.publishManifest("acme", manifestOf("acme", 1, pieces));
    expect(res.status).toBe(200);
    const recent = (w.states.get("acme")!.data.get("recent") as string[])[0]!.split("\n");
    expect(recent.length).toBe(MAX_CHUNKS + 1);
  });
});

describe("a member that does not read pieces, in a fleet whose head is in pieces", () => {
  async function chunkedFleet() {
    const w = world();
    await w.fleet("acme");
    const pieces = [await w.piece("acme", bytesOf(10, 1))];
    expect((await w.publishManifest("acme", manifestOf("acme", 1, pieces))).status).toBe(200);
    return w;
  }
  const admitLate = async (w: Awaited<ReturnType<typeof chunkedFleet>>, dev: string) => {
    const invite = await w.call("acme", "/invite", "admin", "operator", {});
    await w.call("acme", "/join", "device", dev, { code: invite.json.code });
    return w.call("acme", "/approve", "admin", "operator", { deviceId: dev });
  };

  test("is warned of at its admission, and told to upgrade at its bootstrap, without being given the lease", async () => {
    const w = await chunkedFleet();
    const approved = await admitLate(w, "dev-old");
    expect(approved.status).toBe(200);
    expect(approved.json.warning).toMatch(/in pieces/);
    const asked = await w.call("acme", "/bootstrap", "device", "dev-old", {});
    expect(asked.status).toBe(200);
    expect(asked.json).toMatchObject({ role: "replica", reason: "upgrade-required", need: "chunks", retryAfterMs: 60_000 });
    expect(typeof asked.json.hint).toBe("string");
    // The primary is not disturbed, and a member that says it reads pieces is let in as any other.
    expect((await w.call("acme", "/bootstrap", "device", "dev-a", { caps: ["chunks"] })).json.role).toBe("primary");
    const reads = await w.call("acme", "/bootstrap", "device", "dev-old", { caps: ["chunks"] });
    expect(reads.json.reason).not.toBe("upgrade-required");
  });

  test("is let in again once the fleet's newest snapshot is not in pieces", async () => {
    const w = await chunkedFleet();
    await admitLate(w, "dev-old");
    expect((await w.call("acme", "/bootstrap", "device", "dev-old", {})).json.reason).toBe("upgrade-required");
    await w.call("acme", "/bootstrap", "device", "dev-a", { caps: ["chunks"] });
    expect((await w.publishManifest("acme", { seq: 2, seal: "tag", full: false }, bytesOf(5, 9))).status).toBe(200);
    expect((await w.call("acme", "/bootstrap", "device", "dev-old", {})).json.reason).not.toBe("upgrade-required");
  });

  test("an ordinary fleet gives no warning and no refusal", async () => {
    const w = world();
    await w.fleet("acme");
    expect((await w.publishManifest("acme", { seq: 1, seal: "tag", full: false }, bytesOf(5, 9))).status).toBe(200);
    const invite = await w.call("acme", "/invite", "admin", "operator", {});
    await w.call("acme", "/join", "device", "dev-x", { code: invite.json.code });
    expect((await w.call("acme", "/approve", "admin", "operator", { deviceId: "dev-x" })).json.warning).toBeUndefined();
    expect((await w.call("acme", "/bootstrap", "device", "dev-x", {})).json.reason).not.toBe("upgrade-required");
  });
});

describe("a piece that says its hash is streamed to the bucket, which checks it", () => {
  const withHash = (bytes: Uint8Array, hash = sha(bytes)) => ({ "x-prime-sha256": hash });

  test("goes to the bucket as a stream, under the hash it named, and is checked against it", async () => {
    const w = world();
    await w.fleet("acme");
    const bytes = bytesOf(5000, 7);
    const res = await w.http("acme", "POST", "/packs", bytes, "dev-a", withHash(bytes));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ hash: sha(bytes), size: 5000, key: "fleets/acme/packs/" + sha(bytes) });
    expect(w.bucket.putKinds).toEqual(["stream"]);
    expect(w.bucket.objects.get("fleets/acme/packs/" + sha(bytes))!.size).toBe(5000);
    // It is noted for the sweep as any other upload is.
    expect(Object.keys(w.states.get("acme")!.data.get("uploads") as object)).toEqual([sha(bytes)]);
  });

  test("one that is not the pack whose hash was named is refused with 400 and nothing is written", async () => {
    const w = world();
    await w.fleet("acme");
    const bytes = bytesOf(4000, 3);
    const other = sha(bytesOf(4000, 4));
    const res = await w.http("acme", "POST", "/packs", bytes, "dev-a", withHash(bytes, other));
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("body-mismatch");
    expect(w.bucket.objects.has("fleets/acme/packs/" + other)).toBe(false);
    expect(w.bucket.deleted).toEqual([]);
  });

  test("a wrong body under the hash of a pack that is there, at the same size or another, leaves that pack as it was: nothing is overwritten or deleted", async () => {
    const w = world();
    await w.fleet("acme");
    const good = bytesOf(4000, 4);
    expect((await w.http("acme", "POST", "/packs", good, "dev-a", withHash(good))).status).toBe(200);
    const key = "fleets/acme/packs/" + sha(good);
    const etag = w.bucket.objects.get(key)!.etag;
    // The same size: the pack is there, so the body is dropped.
    const sameSize = await w.http("acme", "POST", "/packs", bytesOf(4000, 9), "dev-a", withHash(good));
    expect(sameSize.json).toMatchObject({ again: true });
    // Another size: the bucket checks the hash, finds a body that is not the pack, and keeps what it has.
    for (const length of [10, 5000]) {
      const res = await w.http("acme", "POST", "/packs", bytesOf(length, 9), "dev-a", withHash(good));
      expect(res.status).toBe(400);
    }
    expect(w.bucket.objects.get(key)!.etag).toBe(etag);
    expect(w.bucket.objects.get(key)!.size).toBe(4000);
    expect(w.bucket.deleted).toEqual([]);
  });

  test("a bucket that cannot say whether the pack is there is a 503 with nothing written, not 'absent'", async () => {
    const w = world();
    await w.fleet("acme");
    const bytes = bytesOf(100, 6);
    w.bucket.failSize = true;
    const res = await w.http("acme", "POST", "/packs", bytes, "dev-a", withHash(bytes));
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("bucket-unavailable");
    w.bucket.failSize = false;
    expect(w.bucket.putKinds).toEqual([]);
    expect(w.bucket.deleted).toEqual([]);
    expect((await w.http("acme", "POST", "/packs", bytes, "dev-a", withHash(bytes))).status).toBe(200);
  });

  test("one that is sent again at the size the bucket holds is not written again", async () => {
    const w = world();
    await w.fleet("acme");
    const bytes = bytesOf(3000, 9);
    await w.http("acme", "POST", "/packs", bytes, "dev-a", withHash(bytes));
    const again = await w.http("acme", "POST", "/packs", bytes, "dev-a", withHash(bytes));
    expect(again.json).toMatchObject({ ok: true, again: true, hash: sha(bytes) });
    expect(w.bucket.putKinds).toEqual(["stream"]);
  });

  test("a bucket that fails on its own is a 503 to try again, and nothing is deleted", async () => {
    const w = world();
    await w.fleet("acme");
    const bytes = bytesOf(3000, 5);
    const put = w.bucket.put;
    w.bucket.put = async () => {
      throw new Error("internal error (500)");
    };
    expect((await w.http("acme", "POST", "/packs", bytes, "dev-a", withHash(bytes))).status).toBe(503);
    w.bucket.put = put;
    expect(w.bucket.deleted).toEqual([]);
  });

  test("a hash that is not 64 hex characters, or none, is the held path as before; and so is a runtime that cannot stream", async () => {
    const w = world();
    await w.fleet("acme");
    const a = bytesOf(100, 1);
    expect((await w.http("acme", "POST", "/packs", a, "dev-a", { "x-prime-sha256": "abc" })).status).toBe(200);
    expect((await w.http("acme", "POST", "/packs", bytesOf(100, 2))).status).toBe(200);
    const { removeStreamPolyfill, installStreamPolyfill: put } = await import("./stream-polyfill");
    removeStreamPolyfill();
    const b = bytesOf(100, 3);
    expect((await w.http("acme", "POST", "/packs", b, "dev-a", withHash(b))).status).toBe(200);
    put();
    expect(w.bucket.putKinds).toEqual(["bytes", "bytes", "bytes"]);
  });

  test("a member that is not the primary is refused before its body is read, hash or no hash", async () => {
    const w = world();
    await w.fleet("acme", { "dev-a": ["chunks"], "dev-b": ["chunks"] });
    const bytes = bytesOf(100, 1);
    const refused = await w.http("acme", "POST", "/packs", bytes, "dev-b", withHash(bytes));
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("not-primary");
    expect(w.bucket.putKinds).toEqual([]);
  });
});

describe("uploading a piece", () => {
  test("asks the fleet's object whether the caller is the primary before it reads the body, then notes the pack before it stores it", async () => {
    const w = world();
    await w.fleet("acme");
    const seen: string[] = [];
    const fleet = (w.env as { FLEET: { get: (n: string) => { fetch: (u: string, i?: RequestInit) => Promise<Response> } } }).FLEET;
    const get = fleet.get;
    fleet.get = (n: string) => {
      const stub = get(n);
      return { fetch: (u: string, i?: RequestInit) => (seen.push(new URL(u).pathname), stub.fetch(u, i)) };
    };
    const piece = await w.piece("acme", bytesOf(10, 1));
    expect(seen).toEqual(["/role", "/uploaded"]);
    expect(Object.keys(w.states.get("acme")!.data.get("uploads") as object)).toEqual([piece.hash]);
  });

  test("is answered 503, with nothing stored, when the fleet's object cannot be asked to note it (not the 409 of a member that is not the primary)", async () => {
    const w = world();
    await w.fleet("acme");
    const fleet = (w.env as { FLEET: { get: (n: string) => { fetch: (u: string, i?: RequestInit) => Promise<Response> } } }).FLEET;
    const get = fleet.get;
    fleet.get = (n: string) => {
      const stub = get(n);
      return { fetch: (u: string, i?: RequestInit) => (new URL(u).pathname === "/uploaded" ? Promise.reject(new Error("object unavailable")) : stub.fetch(u, i)) };
    };
    const res = await w.http("acme", "POST", "/packs", bytesOf(10, 1));
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("fleet-unreachable");
    expect([...w.bucket.objects.keys()].filter((k) => k.includes("/packs/"))).toEqual([]);
    fleet.get = get;
    expect((await w.http("acme", "POST", "/packs", bytesOf(10, 1))).status).toBe(200);
  });

  test("an empty body and one that is too big say so in a code, held and streamed alike", async () => {
    const w = world();
    await w.fleet("acme");
    expect((await w.http("acme", "POST", "/packs", new Uint8Array(0), "dev-a")).json.code).toBe("empty-payload");
    const big = await w.http("acme", "POST", "/packs", bytesOf(1, 1), "dev-a", { "content-length": String(40 * 1024 * 1024) });
    expect(big.status).toBe(413);
    expect(big.json.code).toBe("too-big");
  });

  test("is refused to a member that is not the primary and to a stranger, and stores and notes nothing", async () => {
    const w = world();
    await w.fleet("acme", { "dev-a": ["chunks"], "dev-b": ["chunks"] });
    const seen: string[] = [];
    const fleet = (w.env as { FLEET: { get: (n: string) => { fetch: (u: string, i?: RequestInit) => Promise<Response> } } }).FLEET;
    const get = fleet.get;
    fleet.get = (n: string) => {
      const stub = get(n);
      return { fetch: (u: string, i?: RequestInit) => (seen.push(new URL(u).pathname), stub.fetch(u, i)) };
    };
    const second = await w.http("acme", "POST", "/packs", bytesOf(10, 1), "dev-b");
    expect(second.status).toBe(409);
    // Refused on the role alone: the object was not asked to note anything.
    expect(seen).toEqual(["/role"]);
    const stranger = await w.http("acme", "POST", "/packs", bytesOf(10, 1), "stranger");
    expect(stranger.status).toBe(403);
    expect(stranger.json.code).toBe("not-a-member");
    expect([...w.bucket.objects.keys()].filter((k) => k.includes("/packs/"))).toEqual([]);
    expect(w.states.get("acme")!.data.get("uploads")).toBeUndefined();
    // The primary is still taken.
    expect((await w.http("acme", "POST", "/packs", bytesOf(10, 1))).status).toBe(200);
  });

  test("the record holds the pieces of three snapshots' worth, the newest, and is a row a Durable Object can hold", async () => {
    const w = world();
    await w.fleet("acme");
    const { UPLOADS_KEPT } = await import("../src/fleets");
    expect(UPLOADS_KEPT).toBeGreaterThanOrEqual(3 * MAX_CHUNKS);
    const rowBytes = JSON.stringify(Object.fromEntries(Array.from({ length: UPLOADS_KEPT }, (_, i) => [i.toString(16).padStart(64, "0"), Date.now()]))).length;
    expect(rowBytes).toBeLessThan(100 * 1024);
    for (let i = 0; i < 8; i++) await w.piece("acme", new Uint8Array([i, 7, 7]));
    expect(Object.keys(w.states.get("acme")!.data.get("uploads") as object).length).toBe(8);
  });
});

describe("the sweep and a snapshot in pieces", () => {
  test("the pieces of a slow upload are spared for a day, however old, and then go if nothing names them", async () => {
    setSystemTime(new Date(T0));
    const w = world();
    await w.fleet("acme");
    const pieces = [await w.piece("acme", bytesOf(10, 1)), await w.piece("acme", bytesOf(10, 2))];
    // The upload has gone on for three hours: the pieces are old to the sweep, and no snapshot names them yet.
    for (const p of pieces) w.bucket.objects.get("fleets/acme/packs/" + p.hash)!.uploaded = T0 - 3 * HOUR;
    const during = await sweepFleets(w.env, { now: T0 });
    expect(during.orphans).toBe(0);
    for (const p of pieces) expect(w.bucket.objects.has("fleets/acme/packs/" + p.hash)).toBe(true);
    // The publisher died: after a day nothing keeps them.
    w.clock.now = T0 + 25 * HOUR;
    setSystemTime(new Date(T0 + 25 * HOUR));
    const later = await sweepFleets(w.env, { now: T0 + 25 * HOUR });
    expect(later.orphans).toBe(2);
  });

  test("a published snapshot's pieces are never swept: not by the object's record, nor when it has lost it", async () => {
    const w = world();
    await w.fleet("acme");
    const pieces = [await w.piece("acme", bytesOf(10, 1)), await w.piece("acme", bytesOf(10, 2))];
    const delta = [await w.piece("acme", bytesOf(10, 3)), await w.piece("acme", bytesOf(10, 4))];
    expect((await w.publishManifest("acme", manifestOf("acme", 1, pieces, { full: true, delta: { bytes: 20, chunks: delta } }))).status).toBe(200);
    const orphan = await w.piece("acme", bytesOf(10, 5));
    for (const o of w.bucket.objects.values()) o.uploaded = T0 - 400 * HOUR;
    const state = w.states.get("acme")!.data;
    // The object's own records of what it keeps are gone.
    state.delete("recent");
    state.delete("storing");
    state.delete("uploads");
    const report = await sweepFleets(w.env, { now: T0 });
    expect(report.skipped).toEqual([]);
    expect(report.orphans).toBe(1);
    expect(w.bucket.deleted).toEqual(["fleets/acme/packs/" + orphan.hash]);
    for (const p of [...pieces, ...delta]) expect(w.bucket.objects.has("fleets/acme/packs/" + p.hash)).toBe(true);
  });
});
