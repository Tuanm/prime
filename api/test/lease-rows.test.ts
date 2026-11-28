// How many storage rows a lease renewal costs, and that the lease and the epoch mean what they did.
//
// A primary asks to take its place every fifteen seconds. Each ask is billed by the row, so what it
// writes matters at scale; what it MEANS must not move: a renewal keeps the holder's epoch and since,
// extends the expiry, and a grant to anybody else is a new epoch.
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { FleetDO, LEASE_TTL_MS } from "../src/fleet-do";

const KEY = "A".repeat(43) + "=";

/** Storage with the calls a counted object makes, and a socket and an alarm if asked for. */
function world(opts: { socket: boolean }) {
  const data = new Map<string, unknown>();
  const writes: string[] = [];
  const alarms: number[] = [];
  const storage: Record<string, unknown> = {
    async get(key: string) {
      const v = data.get(key);
      return v === undefined ? undefined : structuredClone(v);
    },
    async put(key: string, value: unknown) {
      writes.push("put:" + key);
      data.set(key, JSON.parse(JSON.stringify(value)));
    },
    async delete(key: string) {
      writes.push("delete:" + key);
      return data.delete(key);
    },
  };
  if (opts.socket) {
    storage.setAlarm = async (at: number) => {
      writes.push("alarm");
      alarms.push(at);
    };
  }
  const usage: Array<Record<string, number>> = [];
  const registry = {
    idFromName: () => "global",
    get: () => ({
      fetch: async (input: Request | string, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.url;
        if (new URL(url).pathname === "/usage-add") usage.push(JSON.parse(String(init?.body ?? "{}")));
        return Response.json({ ok: true });
      },
    }),
  };
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
  const state = {
    storage,
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
    getWebSockets: () => (opts.socket ? [{ send() {}, close() {} }] : []),
  };
  const fleet = new FleetDO(state as never, { BUCKET: bucket, REGISTRY: registry } as never);
  /** What the object has counted since the last call: rows written and read. */
  const rows = () => {
    usage.length = 0;
    (fleet as unknown as { meter: { flush: () => void } }).meter.flush();
    const sum = (k: string) => usage.reduce((n, u) => n + (u[k] ?? 0), 0);
    return { written: sum("doRowsWritten"), read: sum("doRowsRead") };
  };
  return { fleet, data, writes, alarms, rows };
}

type World = ReturnType<typeof world>;

async function call(w: World, path: string, device: string, caller: "admin" | "device", body: Record<string, unknown> = {}, method = "POST") {
  const headers = new Headers({ "content-type": "application/json", "x-prime-caller": caller, "x-prime-fleet": "acme" });
  if (device) headers.set("x-prime-device", device);
  const res = await w.fleet.fetch(new Request("https://fleet" + path, { method, headers, body: method === "GET" ? undefined : JSON.stringify({ pubkey: KEY, ...body }) }));
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

/** A fleet with two admitted members. */
async function fleetOf(socket: boolean): Promise<World> {
  const w = world({ socket });
  await call(w, "/create", "operator", "admin");
  for (const id of ["a", "b"]) {
    const invite = await call(w, "/invite", "operator", "admin", {});
    await call(w, "/join", id, "device", { code: invite.json.code });
    await call(w, "/approve", "operator", "admin", { deviceId: id });
  }
  return w;
}

const ask = (w: World, id: string) => call(w, "/bootstrap", id, "device");

beforeEach(() => setSystemTime(new Date("2026-12-01T10:00:00Z")));
afterEach(() => setSystemTime());

describe("what a renewal costs in storage rows", () => {
  test("a renewal with a listening socket writes two rows: the lease and the alarm", async () => {
    const w = await fleetOf(true);
    expect((await ask(w, "a")).json.role).toBe("primary");
    w.rows();
    setSystemTime(Date.now() + 15_000);
    w.writes.length = 0;
    const renewed = await ask(w, "a");
    expect(renewed.json.role).toBe("primary");
    expect(w.writes).toEqual(["put:lease", "alarm"]);
    const counted = w.rows();
    // Five rows written and seven read before; two written and nine read now. A row read costs a
    // thousandth of a row written, and the two reads are what keeps the epoch and the claim exact.
    expect(counted.written).toBe(2);
    expect(counted.read).toBeLessThanOrEqual(9);
  });

  test("without a socket there is no alarm to set, so a renewal writes one row", async () => {
    const w = await fleetOf(false);
    await ask(w, "a");
    setSystemTime(Date.now() + 15_000);
    w.writes.length = 0;
    await ask(w, "a");
    expect(w.writes).toEqual(["put:lease"]);
  });

  test("the first ask of a minute still marks the fleet as touched, and the next ones in that minute do not", async () => {
    const w = await fleetOf(true);
    setSystemTime(Date.now() + 120_000);
    w.writes.length = 0;
    await ask(w, "a");
    expect(w.writes).toContain("put:lastActivity");
    const stamped = w.data.get("lastActivity") as number;
    expect(stamped).toBe(Date.now());
    for (const gap of [15_000, 15_000, 15_000]) {
      setSystemTime(Date.now() + gap);
      w.writes.length = 0;
      await ask(w, "a");
      expect(w.writes).not.toContain("put:lastActivity");
    }
    // A minute on, it is marked again, and with the time it was marked.
    setSystemTime(Date.now() + 20_000);
    w.writes.length = 0;
    await ask(w, "a");
    expect(w.writes).toContain("put:lastActivity");
    expect(w.data.get("lastActivity")).toBe(Date.now());
  });

  test("the throttle starts again with a fleet made anew after a delete", async () => {
    const w = await fleetOf(true);
    await ask(w, "a");
    await call(w, "/delete", "operator", "admin", { reason: "test" });
    expect(w.data.has("lastActivity")).toBe(false);
    await call(w, "/create", "operator", "admin");
    const invite = await call(w, "/invite", "operator", "admin", {});
    w.writes.length = 0;
    await call(w, "/join", "a", "device", { code: invite.json.code });
    expect(w.writes).toContain("put:lastActivity");
  });
});

describe("the lease and the epoch mean what they did", () => {
  test("a renewal keeps the holder's epoch and since, and moves the expiry on", async () => {
    const w = await fleetOf(true);
    const first = await ask(w, "a");
    const lease1 = w.data.get("lease") as { epoch: number; since: number; expiresAt: number };
    setSystemTime(Date.now() + 15_000);
    const renewed = await ask(w, "a");
    const lease2 = w.data.get("lease") as { epoch: number; since: number; expiresAt: number; holder: string };
    expect(renewed.json.epoch).toBe(first.json.epoch);
    expect(lease2.holder).toBe("a");
    expect(lease2.epoch).toBe(lease1.epoch);
    expect(lease2.since).toBe(lease1.since);
    expect(lease2.expiresAt).toBe(Date.now() + LEASE_TTL_MS);
    expect(w.data.get("epoch")).toBe(first.json.epoch);
  });

  test("a grant to another member after the lease lapses is a new epoch, and the stored epoch follows it", async () => {
    const w = await fleetOf(true);
    const a = await ask(w, "a");
    expect(a.json.epoch).toBe(1);
    // b is told to wait while a holds the place.
    expect((await ask(w, "b")).json.reason).toBe("lease-held");
    setSystemTime(Date.now() + LEASE_TTL_MS + 1_000);
    const b = await ask(w, "b");
    expect(b.json.role).toBe("primary");
    expect(b.json.epoch).toBe(2);
    expect(w.data.get("epoch")).toBe(2);
    // ...and a, back after its lease lapsed and b took it, is a replica again, not the holder.
    expect((await ask(w, "a")).json.reason).toBe("lease-held");
  });

  test("the same member asking again after its own lease lapsed is a new epoch too", async () => {
    const w = await fleetOf(true);
    expect((await ask(w, "a")).json.epoch).toBe(1);
    setSystemTime(Date.now() + LEASE_TTL_MS + 1_000);
    expect((await ask(w, "a")).json.epoch).toBe(2);
    expect(w.data.get("epoch")).toBe(2);
  });

  test("a claim that is held is still cleared when the lease is granted, and none is deleted when there is none", async () => {
    const w = await fleetOf(true);
    w.writes.length = 0;
    await ask(w, "a");
    expect(w.writes).not.toContain("delete:claim");
    // A claim left behind by a replica that was catching up.
    w.data.set("claim", { device: "b", since: Date.now(), until: Date.now() + 1000, queue: [] });
    setSystemTime(Date.now() + LEASE_TTL_MS + 1_000);
    w.writes.length = 0;
    expect((await ask(w, "a")).json.role).toBe("primary");
    expect(w.data.has("claim")).toBe(false);
    expect(w.writes).toContain("delete:claim");
  });

  test("an epoch that was stored behind the lease's (a write that did not finish) is put right by the next renewal", async () => {
    const w = await fleetOf(true);
    await ask(w, "a");
    w.data.set("epoch", 0);
    setSystemTime(Date.now() + 15_000);
    w.writes.length = 0;
    await ask(w, "a");
    expect(w.data.get("epoch")).toBe(1);
    expect(w.writes).toContain("put:epoch");
  });

  test("a primary's renewal is refused to nobody, and a stranger's ask changes no row", async () => {
    const w = await fleetOf(true);
    await ask(w, "a");
    w.writes.length = 0;
    const lease = JSON.stringify(w.data.get("lease"));
    const stranger = await call(w, "/lease/renew", "b", "device", {});
    expect(stranger.status).toBe(409);
    expect(JSON.stringify(w.data.get("lease"))).toBe(lease);
    expect(w.writes).toEqual([]);
  });
});
