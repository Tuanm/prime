// A fleet's lease is set by its operator within bounds, a holder cannot name its own, and each member says what
// it can do, which is written once and read back as what every member can do.
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
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

const { FleetDO, LEASE_TTL_MS } = await import("../src/fleet-do");
const { handleFleetRoutes } = await import("../src/fleets-routes");
const { default: worker } = await import("../src/index");
const { cleanCaps, commonCaps, effectiveLeaseMs, LEASE_MAX_MS, LEASE_MIN_MS } = await import("../src/fleets");

const KEY = "A".repeat(43) + "=";

/** A fleet object over storage that lists what is written, with the environment it is given. */
function world(env: Record<string, unknown> = {}, socket = false) {
  const sent: string[] = [];
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
      for (const k of Array.isArray(key) ? key : [key]) writes.push("delete:" + k);
      return Array.isArray(key) ? deleteRows(data, key) : data.delete(key);
    },
    async list(o: { prefix?: string; start?: string; limit?: number; reverse?: boolean }) {
      return listRows(data, o);
    },
  };
  if (socket) storage.setAlarm = async () => {};
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
    getWebSockets: () => (socket ? [{ send: (m: string) => void sent.push(m), close() {} }] : []),
  };
  const fleet = new FleetDO(state as never, { BUCKET: bucket, REGISTRY: registry, ...env } as never);
  return { fleet, data, writes, bucket, objects, sent };
}
type World = ReturnType<typeof world>;

async function call(w: World, path: string, device: string, caller: "admin" | "device", body: Record<string, unknown> = {}, method = "POST") {
  const headers = new Headers({ "content-type": "application/json", "x-prime-caller": caller, "x-prime-fleet": "acme" });
  if (device) headers.set("x-prime-device", device);
  const res = await w.fleet.fetch(new Request("https://fleet" + path, { method, headers, body: method === "GET" ? undefined : JSON.stringify({ pubkey: KEY, ...body }) }));
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

/** A fleet owned by `owner`, with the members `ids` admitted. */
async function fleetOf(ids: string[], env: Record<string, unknown> = {}, socket = false): Promise<World> {
  const w = world(env, socket);
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

describe("the lease a fleet runs on", () => {
  test("is forty-five seconds unless something says otherwise", async () => {
    const w = await fleetOf(["a"]);
    const got = await ask(w, "a");
    expect(got.json.role).toBe("primary");
    expect(got.json.ttlMs).toBe(45_000);
    expect(LEASE_TTL_MS).toBe(45_000);
    expect((w.data.get("lease") as { expiresAt: number }).expiresAt).toBe(Date.now() + 45_000);
  });

  test("is what the operator set for the fleet: bootstrap, renewal and the hello that a listener gets all use it", async () => {
    const w = await fleetOf(["a"]);
    expect((await setLease(w, 90_000)).json.leaseMs).toBe(90_000);
    const got = await ask(w, "a");
    expect(got.json.ttlMs).toBe(90_000);
    expect((w.data.get("lease") as { expiresAt: number }).expiresAt).toBe(Date.now() + 90_000);
    setSystemTime(Date.now() + 30_000);
    await ask(w, "a");
    expect((w.data.get("lease") as { expiresAt: number }).expiresAt).toBe(Date.now() + 90_000);
    setSystemTime(Date.now() + 10_000);
    const renewed = await call(w, "/lease/renew", "a", "device", {});
    expect(renewed.status).toBe(200);
    expect((w.data.get("lease") as { expiresAt: number }).expiresAt).toBe(Date.now() + 90_000);
    const hello = await (w.fleet as unknown as { helloFrame: () => Promise<Record<string, unknown>> }).helloFrame();
    expect(hello.leaseMs).toBe(90_000);
    expect((await call(w, "/role", "a", "device", {}, "GET")).json.leaseMs).toBe(90_000);
  });

  test("a holder cannot make its own lease longer: the ttl it asks for in a renewal is not used", async () => {
    const w = await fleetOf(["a"]);
    await ask(w, "a");
    setSystemTime(Date.now() + 10_000);
    // Before: the renewal took what was asked, up to five minutes.
    for (const ttlMs of [300_000, 1_000_000, 5_000, -1, "forever"]) {
      const renewed = await call(w, "/lease/renew", "a", "device", { ttlMs });
      expect(renewed.status).toBe(200);
      expect((w.data.get("lease") as { expiresAt: number }).expiresAt).toBe(Date.now() + 45_000);
    }
  });

  test("a change of the lease reaches the holder at its next renewal, not before", async () => {
    const w = await fleetOf(["a"]);
    await ask(w, "a");
    const before = (w.data.get("lease") as { expiresAt: number }).expiresAt;
    await setLease(w, 120_000);
    expect((w.data.get("lease") as { expiresAt: number }).expiresAt).toBe(before);
    setSystemTime(Date.now() + 15_000);
    await ask(w, "a");
    expect((w.data.get("lease") as { expiresAt: number }).expiresAt).toBe(Date.now() + 120_000);
  });

  test("a lease the operator sets is kept between the bounds: outside them is refused, and nothing changes", async () => {
    const w = await fleetOf(["a"]);
    for (const bad of [LEASE_MIN_MS - 1, 1, 0, -5, LEASE_MAX_MS + 1, 300_000, "90000", true, {}]) {
      const res = await setLease(w, bad);
      expect(res.status).toBe(400);
      expect(res.json.min).toBe(LEASE_MIN_MS);
      expect(res.json.max).toBe(LEASE_MAX_MS);
    }
    expect((w.data.get("meta") as { leaseMs?: number } | undefined)?.leaseMs).toBeUndefined();
    for (const good of [LEASE_MIN_MS, 45_000, 90_000, LEASE_MAX_MS]) {
      expect((await setLease(w, good)).status).toBe(200);
      expect((w.data.get("meta") as { leaseMs: number }).leaseMs).toBe(good);
    }
  });

  test("null puts a fleet back on the gateway's lease, and setting it leaves the label and the pause alone", async () => {
    const w = await fleetOf(["a"]);
    await call(w, "/meta", "operator", "admin", { label: "prod", disabled: false });
    await setLease(w, 60_000);
    expect((w.data.get("meta") as Record<string, unknown>).label).toBe("prod");
    expect((await setLease(w, null)).json.leaseMs).toBe(45_000);
    const meta = w.data.get("meta") as Record<string, unknown>;
    expect(meta.leaseMs).toBeUndefined();
    expect(meta.label).toBe("prod");
  });

  test("the gateway's FLEET_LEASE_MS is the default, held between the bounds, and a fleet's own setting beats it", async () => {
    const w = await fleetOf(["a"], { FLEET_LEASE_MS: "90000" });
    expect((await ask(w, "a")).json.ttlMs).toBe(90_000);
    await setLease(w, 60_000);
    setSystemTime(Date.now() + 10_000);
    expect((await ask(w, "a")).json.ttlMs).toBe(60_000);
    for (const [env, want] of [["5", LEASE_MIN_MS], ["9999999", LEASE_MAX_MS], ["soon", 45_000], ["", 45_000], ["-3", 45_000], [undefined, 45_000]] as const) {
      expect(effectiveLeaseMs(undefined, { FLEET_LEASE_MS: env })).toBe(want);
    }
    expect(effectiveLeaseMs(Number.NaN, {})).toBe(45_000);
  });

  test("the floor can be lowered for a test that must see a lease run out in seconds, and no lower than a second", async () => {
    const w = await fleetOf(["a"], { FLEET_LEASE_MIN_MS: "2000" });
    expect((await setLease(w, 2_000)).status).toBe(200);
    expect((await ask(w, "a")).json.ttlMs).toBe(2_000);
    expect((await setLease(w, 1_999)).status).toBe(400);
    expect(effectiveLeaseMs(10_000, { FLEET_LEASE_MIN_MS: "10" })).toBe(LEASE_MIN_MS);
    expect(effectiveLeaseMs(1_000, { FLEET_LEASE_MIN_MS: "1000" })).toBe(1_000);
    expect(effectiveLeaseMs(500, { FLEET_LEASE_MIN_MS: "1000" })).toBe(1_000);
    expect(effectiveLeaseMs(5_000, { FLEET_LEASE_MIN_MS: "99999" })).toBe(LEASE_MIN_MS);
  });

  test("the floor FLEET_LEASE_MIN_MS lowers is the operator's alone: an owner device never sets a lease under thirty seconds", async () => {
    const w = await fleetOf(["a"], { FLEET_LEASE_MIN_MS: "2000" });
    const refused = await setLease(w, 2_000, "owner", "device");
    expect(refused.status).toBe(400);
    expect(refused.json.min).toBe(LEASE_MIN_MS);
    expect(w.data.get("meta")).toBeUndefined();
    expect((await setLease(w, LEASE_MIN_MS, "owner", "device")).status).toBe(200);
    expect((await setLease(w, 2_000)).status).toBe(200);
  });

  test("a change of the lease is said to every listener as a frame of its own, and nothing is said when it stays as it was", async () => {
    const w = await fleetOf(["a"], {}, true);
    w.sent.length = 0;
    await setLease(w, 90_000);
    expect(w.sent.map((m) => JSON.parse(m))).toEqual([{ type: "lease", leaseMs: 90_000 }]);
    w.sent.length = 0;
    await setLease(w, 90_000);
    await call(w, "/meta", "operator", "admin", { label: "x" });
    expect(w.sent).toEqual([]);
    await setLease(w, null);
    expect(w.sent.map((m) => JSON.parse(m))).toEqual([{ type: "lease", leaseMs: 45_000 }]);
    // A pause is still said as it was, and says nothing of the lease.
    w.sent.length = 0;
    await call(w, "/meta", "operator", "admin", { disabled: true });
    expect(w.sent.map((m) => JSON.parse(m))).toEqual([{ type: "paused" }]);
  });

  test("a replica is told the lease in every answer it is given, so that it follows a change", async () => {
    const w = await fleetOf(["a", "b", "c"]);
    await setLease(w, 120_000);
    await ask(w, "a");
    const held = await ask(w, "b");
    expect(held.json.reason).toBe("lease-held");
    expect(held.json.ttlMs).toBe(120_000);
    // A fleet that has published: a replica that is behind is told to catch up, and the next is told to wait for it.
    w.objects.set("fleets/acme/head", { body: JSON.stringify({ seq: 3, manifestKey: "m", manifestHash: "h", epoch: 1 }), etag: "e0" });
    await call(w, "/lease/release", "a", "device");
    const behind = await ask(w, "b");
    expect(behind.json.reason).toBe("not-caught-up");
    expect(behind.json.ttlMs).toBe(120_000);
    const waiting = await ask(w, "c");
    expect(waiting.json.reason).toBe("claimed");
    expect(waiting.json.ttlMs).toBe(120_000);
  });

  test("two changes at once, the page's label and an owner's lease, both stand", async () => {
    const w = await fleetOf(["a"]);
    // A write that takes a moment, as a real one does: the second change starts while the first is being stored.
    const storage = (w.fleet as unknown as { state: { storage: { put: (k: string, v: unknown) => Promise<void> } } }).state.storage;
    const put = storage.put;
    storage.put = async (k, v) => {
      if (k === "meta") await new Promise((r) => setTimeout(r, 5));
      return put.call(storage, k, v);
    };
    const [a, b] = await Promise.all([call(w, "/meta", "operator", "admin", { label: "Acme" }), setLease(w, 90_000, "owner", "device")]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(w.data.get("meta")).toEqual({ label: "Acme", leaseMs: 90_000 });
  });

  test("the lease apart from that means what it did: a renewal keeps the epoch, and a lapse is a new one", async () => {
    const w = await fleetOf(["a", "b"]);
    await setLease(w, 60_000);
    const first = await ask(w, "a");
    setSystemTime(Date.now() + 20_000);
    expect((await ask(w, "a")).json.epoch).toBe(first.json.epoch);
    expect((await ask(w, "b")).json.reason).toBe("lease-held");
    setSystemTime(Date.now() + 61_000);
    const taken = await ask(w, "b");
    expect(taken.json.role).toBe("primary");
    expect(taken.json.epoch).toBe(first.json.epoch + 1);
  });

  test("reading the lease costs no storage read on a renewal beyond the first: it is kept in memory", async () => {
    const w = await fleetOf(["a"]);
    await ask(w, "a");
    let reads = 0;
    const real = (w.fleet as unknown as { state: { storage: { get: (k: string) => Promise<unknown> } } }).state.storage.get;
    (w.fleet as unknown as { state: { storage: { get: (k: string) => Promise<unknown> } } }).state.storage.get = async (k: string) => {
      if (k === "meta") reads += 1;
      return real(k);
    };
    for (let i = 0; i < 5; i++) {
      setSystemTime(Date.now() + 15_000);
      await ask(w, "a");
    }
    expect(reads).toBe(0);
  });
});

describe("who may set the lease", () => {
  test("the owner of the fleet may, and may set nothing else of it", async () => {
    const w = await fleetOf(["a"]);
    expect((await setLease(w, 60_000, "owner", "device")).status).toBe(200);
    expect((w.data.get("meta") as { leaseMs: number }).leaseMs).toBe(60_000);
    expect((await call(w, "/meta", "owner", "device", { label: "mine" })).status).toBe(403);
    expect((await call(w, "/meta", "owner", "device", { disabled: true })).status).toBe(403);
    expect((await call(w, "/meta", "owner", "device", { leaseMs: 50_000, disabled: true })).status).toBe(403);
    expect((w.data.get("meta") as { leaseMs: number; disabled?: boolean }).leaseMs).toBe(60_000);
    expect((w.data.get("meta") as { disabled?: boolean }).disabled).toBeUndefined();
  });

  test("another member, and a device that is no member, may not", async () => {
    const w = await fleetOf(["a"]);
    expect((await setLease(w, 60_000, "a", "device")).status).toBe(403);
    expect((await setLease(w, 60_000, "stranger", "device")).status).toBe(403);
    expect(w.data.get("meta")).toBeUndefined();
  });

  describe("through the fleet routes", () => {
    const OP = "operator-secret-0123456789abcdef0123";
    /** The Worker's route in front of the object: the operator's token, or a proven device. */
    async function route(w: World, body: unknown, who: { operator: true } | { device: string }, method = "POST") {
      const stub = { fetch: (i: Request | string, init?: RequestInit) => w.fleet.fetch(typeof i === "string" ? new Request(i, init) : i) };
      const env = { FLEET: { idFromName: (n: string) => n, get: () => stub }, REGISTRY: { idFromName: () => "g", get: () => ({ fetch: async () => Response.json({ ok: true }) }) } } as never;
      const url = new URL("https://gateway/fleets/acme/meta");
      const headers: Record<string, string> = { "content-type": "application/json" };
      if ("operator" in who) headers.authorization = "Bearer " + OP;
      else {
        headers["x-prime-device"] = who.device;
        headers["x-device-token"] = "t";
      }
      const res = await handleFleetRoutes({
        request: new Request(url, { method, headers, body: method === "POST" ? JSON.stringify(body) : undefined }),
        env,
        url,
        cfg: { fleetOperatorToken: OP } as never,
        authorizeDevice: async () => ({ ok: true as const }),
        unauthorized: () => new Response(null, { status: 401 }),
      });
      return { status: res!.status, json: (await res!.json().catch(() => ({}))) as Record<string, any> };
    }

    test("the operator's token and the owner device set the lease; a member does not", async () => {
      const w = await fleetOf(["a"]);
      expect((await route(w, { leaseMs: 100_000 }, { operator: true })).json.leaseMs).toBe(100_000);
      expect((await route(w, { leaseMs: 70_000 }, { device: "owner" })).json.leaseMs).toBe(70_000);
      expect((await route(w, { leaseMs: 50_000 }, { device: "a" })).status).toBe(403);
      expect((w.data.get("meta") as { leaseMs: number }).leaseMs).toBe(70_000);
    });

    test("only the lease goes through: the label and the pause, which the registry must hear of, do not", async () => {
      const w = await fleetOf(["a"]);
      const res = await route(w, { leaseMs: 60_000, label: "x", disabled: true }, { operator: true });
      expect(res.status).toBe(200);
      const meta = w.data.get("meta") as Record<string, unknown>;
      expect(meta).toEqual({ leaseMs: 60_000 });
      expect((await route(w, { label: "x", disabled: true }, { operator: true })).status).toBe(400);
      expect((await route(w, { leaseMs: 5_000 }, { operator: true })).status).toBe(400);
    });

    test("the answer to a get is not served: it is a post", async () => {
      const w = await fleetOf(["a"]);
      const res = await route(w, undefined, { operator: true }, "GET");
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });
});

describe("through the admin page", () => {
  async function page(w: World, body: unknown) {
    const stub = { fetch: (i: Request | string, init?: RequestInit) => w.fleet.fetch(typeof i === "string" ? new Request(i, init) : i) };
    const reg = { fetch: async () => Response.json({ ok: true, devices: [], buddies: [] }) };
    const env = { ADMIN_ACCESS: "off", FLEET: { idFromName: (n: string) => n, get: () => stub }, REGISTRY: { idFromName: () => "g", get: () => reg } } as never;
    const res = await worker.fetch(
      new Request("https://gateway/admin/api/fleets/acme/meta", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.41" }, body: JSON.stringify(body) }),
      env,
    );
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
  }

  test("sets the lease, and a value that is not a number is refused with the bounds, as on the fleet routes", async () => {
    const w = await fleetOf(["a"]);
    const ok = await page(w, { leaseMs: 60_000 });
    expect(ok.status).toBe(200);
    expect((w.data.get("meta") as { leaseMs: number }).leaseMs).toBe(60_000);
    for (const bad of ["90000", true, {}, [1]]) {
      const res = await page(w, { leaseMs: bad });
      expect(res.status).toBe(400);
    }
    expect((w.data.get("meta") as { leaseMs: number }).leaseMs).toBe(60_000);
    expect((await page(w, { leaseMs: null })).status).toBe(200);
    expect((w.data.get("meta") as { leaseMs?: number }).leaseMs).toBeUndefined();
  });
});

describe("what a member can do", () => {
  test("a bootstrap says it, and it is stored cleaned: sorted, without repeats, malformed names and more than sixteen dropped", async () => {
    const w = await fleetOf(["a"]);
    await ask(w, "a", { caps: ["inline", "chunks", "chunks", "Bad", "has space", "", 7, null, "epoch", "x".repeat(30)] });
    expect((w.data.get("members") as Record<string, { caps?: string[] }>).a!.caps).toEqual(["chunks", "epoch", "inline"]);
    const many = Array.from({ length: 40 }, (_, i) => "cap" + String(i).padStart(2, "0"));
    expect(cleanCaps(many)).toHaveLength(16);
    expect(cleanCaps("chunks")).toEqual([]);
    expect(cleanCaps(undefined)).toEqual([]);
  });

  test("it is written once: asking again with the same caps, in any order, writes nothing to the roster", async () => {
    const w = await fleetOf(["a"]);
    await ask(w, "a", { caps: ["meta2", "chunks"] });
    for (const caps of [["meta2", "chunks"], ["chunks", "meta2"], ["chunks", "meta2", "chunks"]]) {
      setSystemTime(Date.now() + 15_000);
      w.writes.length = 0;
      await ask(w, "a", { caps });
      expect(w.writes).not.toContain("put:members");
      expect(w.writes).toEqual(["put:lease"]);
    }
    // A change is one write.
    w.writes.length = 0;
    setSystemTime(Date.now() + 15_000);
    await ask(w, "a", { caps: ["meta2", "chunks", "epoch"] });
    expect(w.writes.filter((x) => x === "put:members")).toHaveLength(1);
  });

  test("a member that says nothing (an earlier build) has none, and a member that went back to one loses what it had", async () => {
    const w = await fleetOf(["a"]);
    await ask(w, "a", { caps: ["chunks"] });
    expect((w.data.get("members") as Record<string, { caps?: string[] }>).a!.caps).toEqual(["chunks"]);
    setSystemTime(Date.now() + 15_000);
    await ask(w, "a", {});
    expect((w.data.get("members") as Record<string, { caps?: string[] }>).a!.caps).toBeUndefined();
    // And one that never said anything is not written at all by asking.
    w.writes.length = 0;
    setSystemTime(Date.now() + 15_000);
    await ask(w, "a", {});
    expect(w.writes).toEqual(["put:lease"]);
  });

  test("the primary is told every member's caps with the keys, and a member with none is listed without", async () => {
    const w = await fleetOf(["a", "b"]);
    const got = await ask(w, "owner", { caps: ["chunks", "epoch"] });
    expect(got.json.role).toBe("primary");
    await ask(w, "b", { caps: ["chunks"] });
    const keys = await call(w, "/keys", "owner", "device", {}, "GET");
    const byId = Object.fromEntries((keys.json.members as Array<{ deviceId: string; caps?: string[] }>).map((m) => [m.deviceId, m.caps]));
    expect(byId).toEqual({ owner: ["chunks", "epoch"], a: undefined, b: ["chunks"] });
  });

  test("the fleet's caps are what every member has: one that says nothing makes it none", async () => {
    const w = await fleetOf(["a", "b"]);
    const fleetCaps = async () => (await call(w, "/role", "owner", "device", {}, "GET")).json.fleetCaps as string[];
    await ask(w, "owner", { caps: ["chunks", "epoch", "inline"] });
    await ask(w, "a", { caps: ["chunks", "epoch"] });
    expect(await fleetCaps()).toEqual([]); // b has said nothing yet
    await ask(w, "b", { caps: ["epoch", "chunks", "meta2"] });
    expect(await fleetCaps()).toEqual(["chunks", "epoch"]);
    await ask(w, "a", {}); // a is an earlier build again
    expect(await fleetCaps()).toEqual([]);
    expect(commonCaps([])).toEqual([]);
    expect(commonCaps([["x"], undefined])).toEqual([]);
    expect(commonCaps([["b", "a"], ["a", "b", "c"]])).toEqual(["a", "b"]);
  });

  test("the caps are the member's word and not another's: a replica cannot set the primary's", async () => {
    const w = await fleetOf(["a"]);
    await ask(w, "owner", { caps: ["chunks"] });
    await ask(w, "a", { caps: ["epoch"] });
    const members = w.data.get("members") as Record<string, { caps?: string[] }>;
    expect(members.owner!.caps).toEqual(["chunks"]);
    expect(members.a!.caps).toEqual(["epoch"]);
  });
});
