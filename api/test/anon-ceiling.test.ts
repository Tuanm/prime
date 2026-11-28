// A code that is still six characters can be guessed online by enough addresses, each with a count of its
// own. The device is locked for everyone when the misses from all of them pass a ceiling, nothing with a
// recent miss is forgotten to make room, and the locks kept are bounded.
import { afterEach, describe, expect, mock, setSystemTime, test } from "bun:test";

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
const { RegistryDO } = await import("../src/registry-do");
const { anonDeviceLockKey, anonLockKey } = await import("../src/config");
const { verifierFor } = await import("../src/token-hash");

const PEPPER = "p".repeat(40);
const MIN = 60_000;

function storage(initial: Record<string, unknown>) {
  const data = new Map<string, unknown>(Object.entries(structuredClone(initial)));
  return {
    data,
    async get<T>(key: string): Promise<T | undefined> {
      return structuredClone(data.get(key)) as T | undefined;
    },
    async put(key: string, value: unknown) {
      data.set(key, structuredClone(value));
    },
    async delete(key: string) {
      return data.delete(key);
    },
    async list<T>(): Promise<Map<string, T>> {
      return new Map<string, T>();
    },
  };
}

const ID = (n: number) => "anon-" + String(n).padStart(16, "0");

/** A registry holding devices as saved: `legacy` ones have no `long` mark (six-character codes), `long` ones have. */
async function registry(devices: { legacy?: number[]; long?: number[] }, env: Record<string, string> = {}) {
  const now = Date.now();
  const records: Record<string, Record<string, unknown>> = {};
  const tokens: Record<string, string> = {};
  for (const n of devices.legacy ?? []) records[ID(n)] = { ref: String(n).padStart(24, "a"), createdAt: now - MIN, lastSeenAt: now };
  for (const n of devices.long ?? []) records[ID(n)] = { ref: String(n).padStart(24, "b"), createdAt: now - MIN, lastSeenAt: now, long: true };
  for (const id of Object.keys(records)) tokens[id] = await verifierFor({ TOKEN_PEPPER: PEPPER } as never, "device", "CODE" + id);
  const store = storage({ device_tokens: tokens, anon_devices: records });
  let ready: Promise<unknown> = Promise.resolve();
  const ctx = {
    storage: store,
    blockConcurrencyWhile(fn: () => Promise<unknown>) {
      ready = fn();
      return ready;
    },
  };
  const reg = new RegistryDO(ctx as never, { TOKEN_PEPPER: PEPPER, ...env } as never);
  await ready;
  const call = async (method: string, path: string) => {
    const res = await reg.fetch(new Request("https://registry" + path, { method }));
    return (await res.json()) as Record<string, any>;
  };
  const fail = async (id: string, ip: string) => (await call("POST", "/anon/fail?id=" + id + "&ip=" + encodeURIComponent(ip))).locked as boolean;
  const locked = async () => (await call("GET", "/map")).locked as Record<string, number>;
  return { fail, locked, call, store };
}

afterEach(() => setSystemTime());

describe("a device with a six-character code", () => {
  test("is locked for everyone when the misses from all addresses together pass the ceiling, though no address has missed twice", async () => {
    const { fail, locked } = await registry({ legacy: [1] }, { ANON_LEGACY_MAX_FAILURES: "50" });
    let first = -1;
    for (let i = 0; i < 60; i++) {
      // A different address each time, as a /48 of /64s would be.
      if ((await fail(ID(1), "2001:db8:" + i.toString(16) + "::1")) && first < 0) first = i;
    }
    // One short of the ceiling, nothing; at it, the device.
    expect(first).toBe(49);
    const held = await locked();
    expect(Object.keys(held)).toEqual([anonDeviceLockKey(ID(1))]);
    expect(held[anonDeviceLockKey(ID(1))]).toBeGreaterThan(Date.now());
  });

  test("the ceiling is 200 misses in ten minutes unless set, and the misses age out of the window", async () => {
    const t0 = Date.parse("2026-12-05T00:00:00Z");
    setSystemTime(t0);
    const { fail, locked } = await registry({ legacy: [1] });
    for (let i = 0; i < 150; i++) await fail(ID(1), "198.51." + (i >> 8) + "." + (i & 255));
    expect(await locked()).toEqual({});
    // Eleven minutes on, those 150 are gone from the window: 150 more do not make 300.
    setSystemTime(t0 + 11 * MIN);
    for (let i = 0; i < 150; i++) await fail(ID(1), "203.0." + (i >> 8) + "." + (i & 255));
    expect(await locked()).toEqual({});
    for (let i = 150; i < 200; i++) await fail(ID(1), "203.0." + (i >> 8) + "." + (i & 255));
    expect(Object.keys(await locked())).toContain(anonDeviceLockKey(ID(1)));
  });

  test("the lock for everyone is for the window, and then the member is let in again", async () => {
    const t0 = Date.parse("2026-12-05T00:00:00Z");
    setSystemTime(t0);
    const { fail, locked } = await registry({ legacy: [1] }, { ANON_LEGACY_MAX_FAILURES: "5" });
    for (let i = 0; i < 5; i++) await fail(ID(1), "198.51.100." + i);
    expect(Object.keys(await locked())).toEqual([anonDeviceLockKey(ID(1))]);
    setSystemTime(t0 + 11 * MIN);
    expect(await locked()).toEqual({});
  });
});

describe("a device with a 25-character code", () => {
  test("is never locked for everyone, however many addresses miss: it cannot be guessed, and the lock would be a lever", async () => {
    const { fail, locked } = await registry({ long: [1] }, { ANON_LEGACY_MAX_FAILURES: "5" });
    for (let i = 0; i < 300; i++) expect(await fail(ID(1), "10.9." + (i >> 8) + "." + (i & 255))).toBe(false);
    expect(await locked()).toEqual({});
  });
});

describe("the misses kept", () => {
  test("nothing with a miss in the window is forgotten to make room: past the cap a new address is not tracked, and a tracked one still locks", async () => {
    // A long-code device, so that only the per-address count is in play.
    const { fail } = await registry({ long: [1] }, { ANON_AUTH_MAX_FAILURES: "3" });
    // 10,050 addresses, each missing once: the first 10,000 are kept.
    for (let i = 0; i < 10_050; i++) await fail(ID(1), "10." + (i >> 16) + "." + ((i >> 8) & 255) + "." + (i & 255));
    // Three more rounds over them: a tracked address reaches three and is locked; none was dropped to make room.
    let locks = 0;
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 10_050; i++) if (await fail(ID(1), "10." + (i >> 16) + "." + ((i >> 8) & 255) + "." + (i & 255))) locks += 1;
    }
    // Before: the quietest were dropped above the cap, and round-robin never let any address reach its third miss.
    expect(locks).toBeGreaterThan(9_000);
  });

  test("entries whose misses have aged out are dropped, and the room is used again", async () => {
    const t0 = Date.parse("2026-12-05T00:00:00Z");
    setSystemTime(t0);
    const { fail } = await registry({ long: [1] }, { ANON_AUTH_MAX_FAILURES: "2" });
    for (let i = 0; i < 10_000; i++) await fail(ID(1), "10." + (i >> 16) + "." + ((i >> 8) & 255) + "." + (i & 255));
    // Full of recent misses: a new address is not tracked, so its second miss locks nothing.
    await fail(ID(1), "192.0.2.1");
    expect(await fail(ID(1), "192.0.2.1")).toBe(false);
    // Eleven minutes on, all of that is stale: the new address is tracked again.
    setSystemTime(t0 + 11 * MIN);
    await fail(ID(1), "192.0.2.1");
    expect(await fail(ID(1), "192.0.2.1")).toBe(true);
  });

  test("a device with a short code gets the ceiling even from addresses the map cannot hold", async () => {
    const { fail, locked } = await registry({ long: [2], legacy: [1] }, { ANON_AUTH_MAX_FAILURES: "3", ANON_LEGACY_MAX_FAILURES: "10100" });
    // The long device fills the map with recent entries, from one device.
    for (let i = 0; i < 10_000; i++) await fail(ID(2), "10." + (i >> 16) + "." + ((i >> 8) & 255) + "." + (i & 255));
    // The legacy one's addresses cannot be tracked singly now; their misses count in its total, which locks it.
    let lockedAt = -1;
    for (let i = 0; i < 10_200 && lockedAt < 0; i++) if (await fail(ID(1), "172.16." + (i >> 8) + "." + (i & 255))) lockedAt = i;
    expect(lockedAt).toBe(10_099);
    expect(Object.keys(await locked())).toContain(anonDeviceLockKey(ID(1)));
  });
});

describe("the locks kept", () => {
  test("a device with a long code keeps at most twenty locked addresses, the soonest to end let go", async () => {
    const { fail, locked } = await registry({ long: [1] }, { ANON_AUTH_MAX_FAILURES: "2" });
    for (let i = 0; i < 60; i++) {
      await fail(ID(1), "198.51.100." + i);
      await fail(ID(1), "198.51.100." + i);
    }
    const keys = Object.keys(await locked());
    expect(keys.length).toBe(20);
    // The newest are the ones kept.
    expect(keys).toContain(anonLockKey(ID(1), "198.51.100.59"));
    expect(keys).not.toContain(anonLockKey(ID(1), "198.51.100.0"));
  });

  test("a device with a short code that has more than twenty addresses locked is locked for everyone, and the address locks are dropped", async () => {
    const { fail, locked } = await registry({ legacy: [1] }, { ANON_AUTH_MAX_FAILURES: "2" });
    for (let i = 0; i < 21; i++) {
      await fail(ID(1), "198.51.100." + i);
      await fail(ID(1), "198.51.100." + i);
    }
    expect(Object.keys(await locked())).toEqual([anonDeviceLockKey(ID(1))]);
  });

  test("the whole is capped, so that /map stays small however many devices an attacker has locked addresses on", async () => {
    const ids = Array.from({ length: 40 }, (_, i) => i + 1);
    const { fail, locked } = await registry({ long: ids }, { ANON_AUTH_MAX_FAILURES: "2" });
    for (const n of ids) {
      for (let i = 0; i < 20; i++) {
        await fail(ID(n), "198.51.100." + i);
        await fail(ID(n), "198.51.100." + i);
      }
    }
    expect(Object.keys(await locked()).length).toBeLessThanOrEqual(500);
  });
});
