// The daily sweep of what fleets leave in the bucket: it deletes what no snapshot keeps, and nothing else.
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

import { deleteRows, listRows } from "./fake-list";

const { FleetDO } = await import("../src/fleet-do");
const { sweepFleets, SWEEP_MIN_AGE_MS, SWEEP_ORPHAN_AGE_MS, SWEEP_PER_FLEET } = await import("../src/fleet-sweep");
const { default: worker } = await import("../src/index");

const KEY = "A".repeat(43) + "=";
const HOUR = 3_600_000;
const hex = (c: string): string => c.repeat(64);
const T0 = Date.UTC(2026, 11, 1, 3, 17);

/** R2 with upload times, listing by prefix and delimiter, and the conditional write the head relies on. */
function bucketAt(clock: { now: number }) {
  const objects = new Map<string, { body: string; etag: string; uploaded: number }>();
  let n = 0;
  const bucket = {
    objects,
    deleted: [] as string[],
    failHead: false,
    seed(key: string, ageMs: number, body = "x") {
      objects.set(key, { body, etag: "s" + n++, uploaded: clock.now - ageMs });
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
    async get(key: string) {
      if (bucket.failHead && key.endsWith("/head")) throw new Error("the bucket is down");
      const o = objects.get(key);
      if (!o) return null;
      return { etag: o.etag, json: async () => JSON.parse(o.body) };
    },
    async put(key: string, body: string, opts?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
      const cur = objects.get(key);
      const cond = opts?.onlyIf;
      if (cond?.etagMatches !== undefined && cur?.etag !== cond.etagMatches) return null;
      if (cond?.etagDoesNotMatch === "*" && cur) return null;
      const etag = "e" + n++;
      objects.set(key, { body: typeof body === "string" ? body : String(body), etag, uploaded: clock.now });
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
    /** A fleet with one member who holds the lease. */
    async fleet(id: string) {
      await world.call(id, "/create", "admin", "operator");
      registered.add(id);
      const invite = await world.call(id, "/invite", "admin", "operator", {});
      await world.call(id, "/join", "device", "dev-a", { code: invite.json.code });
      await world.call(id, "/approve", "admin", "operator", { deviceId: "dev-a" });
      expect((await world.call(id, "/bootstrap", "device", "dev-a", {})).json.role).toBe("primary");
    },
    /** What the publisher does: store the snapshot's objects, then move the head. */
    async publish(id: string, seq: number, tag: string, extra: Record<string, unknown> = {}) {
      const pack = "fleets/" + id + "/packs/" + hex(tag);
      const manifest = "fleets/" + id + "/manifests/" + hex(tag).replace(/.$/, "0");
      bucket.seed(pack, 0);
      bucket.seed(manifest, 0, JSON.stringify({ seq, packKey: pack, ...extra }));
      const res = await world.call(id, "/head/advance", "device", "dev-a", { expectedSeq: seq - 1, manifestKey: manifest, manifestHash: hex("f"), packKey: pack, meta: { full: true } });
      expect(res.status).toBe(200);
      return { pack, manifest };
    },
  };
  return world;
}

const keysOf = (b: Bucket): string[] => [...b.objects.keys()].sort();

describe("the sweep of a fleet that exists", () => {
  test("deletes what no snapshot keeps once it is an hour old, and never what one does", async () => {
    const w = world();
    await w.fleet("acme");
    const live = await w.publish("acme", 1, "a");
    const orphanOld = "fleets/acme/packs/" + hex("1");
    const orphanOldManifest = "fleets/acme/manifests/" + hex("2");
    const orphanYoung = "fleets/acme/packs/" + hex("3");
    w.bucket.seed(orphanOld, SWEEP_MIN_AGE_MS + 1000);
    w.bucket.seed(orphanOldManifest, 5 * HOUR);
    w.bucket.seed(orphanYoung, SWEEP_MIN_AGE_MS - 60_000);
    // Not what a snapshot is made of: never touched, however old.
    w.bucket.seed("fleets/acme/notes", 90 * 24 * HOUR);
    w.bucket.seed("fleets/acme/packs/not-a-hash", 90 * 24 * HOUR);
    w.clock.now += 0;

    const report = await sweepFleets(w.env, { now: T0 });
    expect(report.orphans).toBe(2);
    expect(report.skipped).toEqual([]);
    expect(w.bucket.deleted.sort()).toEqual([orphanOld, orphanOldManifest].sort());
    const left = keysOf(w.bucket);
    expect(left).toContain(live.pack);
    expect(left).toContain(live.manifest);
    expect(left).toContain("fleets/acme/head");
    expect(left).toContain(orphanYoung);
    expect(left).toContain("fleets/acme/notes");
    expect(left).toContain("fleets/acme/packs/not-a-hash");

    // An hour later the young one is an orphan too.
    expect((await sweepFleets(w.env, { now: T0 + 2 * HOUR })).orphans).toBe(1);
    expect(keysOf(w.bucket)).not.toContain(orphanYoung);
  });

  test("says in the fleet's log how many objects it cleared, and says nothing when it cleared none or only counted", async () => {
    const w = world();
    await w.fleet("acme");
    await w.publish("acme", 1, "a");
    const swept = async () => ((await w.call("acme", "/audit?tail=100", "admin", "operator", undefined, "GET")).json.entries as Array<{ action: string; actor: { kind: string }; detail?: { objects?: number } }>).filter((e) => e.action === "bucket-swept");
    w.bucket.seed("fleets/acme/packs/" + hex("1"), 5 * HOUR);
    w.bucket.seed("fleets/acme/manifests/" + hex("2"), 5 * HOUR);
    await sweepFleets(w.env, { now: T0, dryRun: true });
    expect(await swept()).toEqual([]);
    await sweepFleets(w.env, { now: T0 });
    const [entry] = await swept();
    expect(entry).toMatchObject({ actor: { kind: "gateway" }, detail: { objects: 2 } });
    await sweepFleets(w.env, { now: T0 });
    expect((await swept()).length).toBe(1);
    // Only the gateway may write the note, and only with a count.
    expect((await w.call("acme", "/note", "device", "dev-a", { action: "bucket-swept", count: 3 })).status).toBe(403);
    expect((await w.call("acme", "/note", "admin", "operator", { action: "bucket-swept", count: "many" })).status).toBe(400);
    expect((await w.call("acme", "/note", "admin", "operator", { action: "bucket-swept" })).status).toBe(400);
  });

  test("keeps what is old and still named: every snapshot the fleet keeps, and the change pack of a checkpoint", async () => {
    const w = world();
    await w.fleet("acme");
    const first = await w.publish("acme", 1, "a");
    const delta = "fleets/acme/packs/" + hex("d");
    w.bucket.seed(delta, 0);
    const pack = "fleets/acme/packs/" + hex("b");
    const manifest = "fleets/acme/manifests/" + hex("c");
    w.bucket.seed(pack, 0);
    w.bucket.seed(manifest, 0, JSON.stringify({ seq: 2, packKey: pack, delta: { packKey: delta } }));
    expect((await w.call("acme", "/head/advance", "device", "dev-a", { expectedSeq: 1, manifestKey: manifest, manifestHash: hex("c"), packKey: pack, extraKeys: [delta], meta: { full: true } })).status).toBe(200);

    const report = await sweepFleets(w.env, { now: T0 + 400 * 24 * HOUR });
    expect(report.orphans).toBe(0);
    expect(w.bucket.deleted).toEqual([]);
    for (const key of [first.pack, first.manifest, pack, manifest, delta]) expect(keysOf(w.bucket)).toContain(key);
  });

  test("keeps what a publish in flight is storing, however old the objects", async () => {
    const w = world();
    await w.fleet("acme");
    const pack = "fleets/acme/packs/" + hex("e");
    const manifest = "fleets/acme/manifests/" + hex("f");
    w.bucket.seed(pack, 3 * HOUR);
    w.bucket.seed(manifest, 3 * HOUR);
    // The publish writes the head: the sweep runs while that write is in flight.
    const realPut = w.bucket.put;
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const arrived = new Promise<void>((r) => (reached = r));
    w.bucket.put = async (...args: Parameters<typeof realPut>) => {
      reached();
      await gate;
      return realPut.apply(w.bucket, args);
    };
    const inflight = w.call("acme", "/head/advance", "device", "dev-a", { expectedSeq: 0, manifestKey: manifest, manifestHash: hex("f"), packKey: pack, meta: { full: true } });
    await arrived;
    const report = await sweepFleets(w.env, { now: T0 });
    expect(report.orphans).toBe(0);
    release();
    expect((await inflight).status).toBe(200);
    expect(keysOf(w.bucket)).toContain(pack);
    expect(keysOf(w.bucket)).toContain(manifest);
  });

  test("keeps what the head names even if the object has lost its own record of it", async () => {
    const w = await (async () => {
      const x = world();
      await x.fleet("acme");
      return x;
    })();
    const live = await w.publish("acme", 1, "a");
    // The object's storage forgot its list of snapshots (and nothing is being stored).
    w.states.get("acme")!.data.delete("recent");
    w.states.get("acme")!.data.delete("storing");
    const report = await sweepFleets(w.env, { now: T0 + 30 * 24 * HOUR });
    expect(report.orphans).toBe(0);
    expect(keysOf(w.bucket)).toContain(live.pack);
    expect(keysOf(w.bucket)).toContain(live.manifest);
  });

  test("deletes nothing of a fleet whose head cannot be read, and says so", async () => {
    const w = world();
    await w.fleet("acme");
    await w.publish("acme", 1, "a");
    const orphan = "fleets/acme/packs/" + hex("1");
    w.bucket.seed(orphan, 5 * HOUR);
    w.bucket.failHead = true;
    const report = await sweepFleets(w.env, { now: T0 });
    expect(report.orphans).toBe(0);
    expect(report.skipped.map((s) => s.fleet)).toEqual(["acme"]);
    expect(keysOf(w.bucket)).toContain(orphan);
  });

  test("deletes nothing when the registry cannot say which fleets there are", async () => {
    const w = world();
    await w.fleet("acme");
    w.bucket.seed("fleets/acme/packs/" + hex("1"), 5 * HOUR);
    w.bucket.seed("fleets/ghost/packs/" + hex("2"), 99 * 24 * HOUR);
    w.registryDown = true;
    const report = await sweepFleets(w.env, { now: T0 });
    expect(w.bucket.deleted).toEqual([]);
    expect(report.skipped).toEqual([{ fleet: "*", why: "the registry could not be read" }]);
  });

  test("a dry run counts and deletes nothing", async () => {
    const w = world();
    await w.fleet("acme");
    w.bucket.seed("fleets/acme/packs/" + hex("1"), 5 * HOUR);
    w.bucket.seed("fleets/ghost/packs/" + hex("2"), 99 * 24 * HOUR);
    const report = await sweepFleets(w.env, { now: T0, dryRun: true });
    expect(report).toMatchObject({ dryRun: true, orphans: 1, goneObjects: 1 });
    expect(w.bucket.deleted).toEqual([]);
  });

  test("deletes at most 1,000 objects of one fleet in a run, and says it stopped early", async () => {
    const w = world();
    await w.fleet("acme");
    for (let i = 0; i < SWEEP_PER_FLEET + 200; i++) w.bucket.seed("fleets/acme/packs/" + i.toString(16).padStart(64, "0"), 5 * HOUR);
    const report = await sweepFleets(w.env, { now: T0 });
    expect(report.orphans).toBe(SWEEP_PER_FLEET);
    expect(report.capped).toBe(true);
    expect(w.bucket.deleted.length).toBe(SWEEP_PER_FLEET);
    // Tomorrow's run takes the rest.
    expect((await sweepFleets(w.env, { now: T0 })).orphans).toBe(200);
  });
});

describe("the sweep on a gateway with many fleets", () => {
  async function many(names: string[]) {
    const w = world();
    for (const id of names) {
      await w.fleet(id);
      w.bucket.seed("fleets/" + id + "/packs/" + hex("1"), 5 * HOUR);
    }
    return w;
  }
  const orphansLeft = (w: ReturnType<typeof world>, names: string[]) => names.filter((id) => w.bucket.objects.has("fleets/" + id + "/packs/" + hex("1")));

  test("stops at its budget of calls, and the next run begins where it stopped, so that no fleet is starved", async () => {
    const names = ["a", "b", "c", "d", "e", "f"];
    const w = await many(names);
    const first = await sweepFleets(w.env, { now: T0, subrequests: 14 });
    expect(first.capped).toBe(true);
    expect(first.next).toBe("c");
    expect(first.fleets).toBe(2);
    expect(orphansLeft(w, names)).toEqual(["c", "d", "e", "f"]);
    expect(await w.bucket.get("sweep/cursor").then((o) => o?.json())).toEqual({ next: "c" });
    const second = await sweepFleets(w.env, { now: T0, subrequests: 14 });
    expect(second.next).toBe("e");
    expect(orphansLeft(w, names)).toEqual(["e", "f"]);
    const third = await sweepFleets(w.env, { now: T0, subrequests: 14 });
    expect(third.next).toBeUndefined();
    expect(third.capped).toBe(false);
    expect(orphansLeft(w, names)).toEqual([]);
    // The end of the list clears the place: the next day begins from the start.
    expect(w.bucket.objects.has("sweep/cursor")).toBe(false);
  });

  test("a run that begins in the middle goes to the end of the list and ends the round there", async () => {
    const names = ["a", "b", "c", "d"];
    const w = await many(names);
    w.bucket.seed("sweep/cursor", 0, JSON.stringify({ next: "c" }));
    const report = await sweepFleets(w.env, { now: T0, subrequests: 14 });
    expect(report.next).toBeUndefined();
    expect(report.fleets).toBe(2);
    expect(orphansLeft(w, names)).toEqual(["a", "b"]);
    expect(w.bucket.objects.has("sweep/cursor")).toBe(false);
  });

  test("a dry run names a sample of the keys, and neither deletes nor moves the place", async () => {
    const names = ["a", "b", "c", "d", "e", "f"];
    const w = await many(names);
    const dry = await sweepFleets(w.env, { now: T0, dryRun: true, subrequests: 14 });
    expect(dry.sample.slice(0, 2)).toEqual(["fleets/a/packs/" + hex("1"), "fleets/b/packs/" + hex("1")]);
    expect(w.bucket.deleted).toEqual([]);
    expect(w.bucket.objects.has("sweep/cursor")).toBe(false);
    const big = await many(["g"]);
    for (let i = 0; i < 50; i++) big.bucket.seed("fleets/g/packs/" + i.toString(16).padStart(64, "0"), 5 * HOUR);
    expect((await sweepFleets(big.env, { now: T0, dryRun: true })).sample.length).toBe(20);
  });

  test("a fleet that is not reached because the budget ran out is not reported as skipped", async () => {
    const w = await many(["a", "b", "c"]);
    const report = await sweepFleets(w.env, { now: T0, subrequests: 8 });
    expect(report.skipped).toEqual([]);
    expect(report.capped).toBe(true);
  });
});

describe("the sweep of a fleet that is gone", () => {
  test("clears what is left under its name once it is a day old, and leaves a fleet that exists though the registry does not list it", async () => {
    const w = world();
    await w.fleet("acme");
    // Made but not (yet) in the registry's list.
    await w.fleet("fresh");
    w.registered.delete("fresh");
    const fresh = await w.publish("fresh", 1, "a");
    w.clock.now = T0;

    w.bucket.seed("fleets/ghost/head", 3 * 24 * HOUR);
    w.bucket.seed("fleets/ghost/packs/" + hex("1"), 3 * 24 * HOUR);
    w.bucket.seed("fleets/ghost/manifests/" + hex("2"), SWEEP_ORPHAN_AGE_MS + 1000);
    w.bucket.seed("fleets/ghost/packs/" + hex("3"), SWEEP_ORPHAN_AGE_MS - 60_000);

    const report = await sweepFleets(w.env, { now: T0 });
    expect(report.goneObjects).toBe(3);
    // One object of it is younger than a day: the fleet is cleared tomorrow.
    expect(report.goneFleets).toBe(0);
    expect(keysOf(w.bucket).filter((k) => k.startsWith("fleets/ghost/"))).toEqual(["fleets/ghost/packs/" + hex("3")]);
    expect(keysOf(w.bucket)).toContain(fresh.pack);
    expect(keysOf(w.bucket)).toContain("fleets/fresh/head");

    const later = await sweepFleets(w.env, { now: T0 + 2 * 24 * HOUR });
    expect(later.goneFleets).toBe(1);
    expect(keysOf(w.bucket).some((k) => k.startsWith("fleets/ghost/"))).toBe(false);
  });

  test("never touches a deleted fleet's audit record, which is not under fleets/", async () => {
    const w = world();
    w.bucket.seed("audit/ghost/0000000000001-000000000001.jsonl", 400 * 24 * HOUR);
    w.bucket.seed("fleets/ghost/packs/" + hex("1"), 400 * 24 * HOUR);
    await sweepFleets(w.env, { now: T0 });
    expect(keysOf(w.bucket)).toEqual(["audit/ghost/0000000000001-000000000001.jsonl"]);
  });

  test("a fleet that was deleted through the object leaves nothing, and a later sweep finds nothing to do", async () => {
    const w = world();
    await w.fleet("acme");
    await w.publish("acme", 1, "a");
    expect((await w.call("acme", "/delete", "admin", "operator", {})).status).toBe(200);
    w.registered.delete("acme");
    const report = await sweepFleets(w.env, { now: T0 + 400 * 24 * HOUR });
    expect(report).toMatchObject({ orphans: 0, goneObjects: 0, goneFleets: 0 });
  });
});

describe("what the object lets the sweep ask", () => {
  test("a member is held to the keys of a snapshot in pieces (two lists of 128, and the manifest and pack) and its own fleet; only the gateway asks about many", async () => {
    const w = world();
    await w.fleet("acme");
    const keys = Array.from({ length: 300 }, (_, i) => "fleets/acme/packs/" + i.toString(16).padStart(64, "0"));
    const member = await w.call("acme", "/unreferenced", "device", "dev-a", { keys });
    expect(member.json.keys.length).toBe(264);
    const stranger = await w.call("acme", "/unreferenced", "device", "dev-x", { keys });
    expect(stranger.status).toBe(403);
    const gateway = await w.call("acme", "/unreferenced", "admin", "operator", { keys });
    expect(gateway.json.keys.length).toBe(300);
    expect(gateway.json.exists).toBe(true);
    // Only the gateway may ask whether a fleet exists.
    expect((await w.call("acme", "/exists", "device", "dev-a", undefined, "GET")).status).toBe(403);
    expect((await w.call("acme", "/exists", "admin", "operator", undefined, "GET")).json).toEqual({ exists: true });
    expect((await w.call("nobody", "/exists", "admin", "operator", undefined, "GET")).json).toEqual({ exists: false });
  });
});

describe("the gateway runs the sweep", () => {
  test("on the daily schedule, and counts the bucket's operations it made", async () => {
    const w = world();
    await w.fleet("acme");
    const orphan = "fleets/acme/packs/" + hex("1");
    w.bucket.seed(orphan, 5 * HOUR);
    const waits: Promise<unknown>[] = [];
    const usage: Array<Record<string, number>> = [];
    const registry = w.env as unknown as { REGISTRY: { get: () => { fetch: (u: string, init?: RequestInit) => Promise<Response> } } };
    const inner = registry.REGISTRY.get();
    const env = {
      ...(w.env as object),
      REGISTRY: {
        idFromName: () => "global",
        get: () => ({
          fetch: async (u: string, init?: RequestInit) => {
            if (u.endsWith("/usage-add")) usage.push(JSON.parse(String(init?.body)));
            return inner.fetch(u, init);
          },
        }),
      },
    };
    // The sweep reads the clock itself.
    w.clock.now = Date.now();
    w.bucket.objects.get(orphan)!.uploaded = Date.now() - 5 * HOUR;
    await worker.scheduled!({} as never, env as never, { waitUntil: (p: Promise<unknown>) => void waits.push(p) } as never);
    await Promise.all(waits);
    expect(w.bucket.deleted).toContain(orphan);
    expect(usage.length).toBe(1);
    expect(usage[0]!.r2Writes).toBeGreaterThan(0);
  });
});
