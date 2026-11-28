// The registry keeps the month's counts, and measures what the bucket holds now and then.
import { describe, expect, mock, setSystemTime, test, afterEach } from "bun:test";

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

function storage() {
  const data = new Map<string, unknown>();
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
    async list<T>(opts: { prefix?: string } = {}): Promise<Map<string, T>> {
      const out = new Map<string, T>();
      for (const [k, v] of data) if (!opts.prefix || k.startsWith(opts.prefix)) out.set(k, v as T);
      return out;
    },
  };
}

/** A bucket that lists `objects` in pages of `per`, and counts the listings. */
function bucket(sizes: number[], per = 1000) {
  const state = { lists: 0 };
  return {
    state,
    async list(opts: { cursor?: string; limit?: number }) {
      state.lists += 1;
      const from = opts.cursor ? Number(opts.cursor) : 0;
      const page = sizes.slice(from, from + per);
      const next = from + per;
      return { objects: page.map((size) => ({ size })), truncated: next < sizes.length, cursor: String(next) };
    },
  };
}

async function registry(env: Record<string, unknown> = {}) {
  const store = storage();
  // The runtime has one alarm; the test fires it when it says it is due.
  const alarm: { at: number | null; sets: number[] } = { at: null, sets: [] };
  (store as Record<string, unknown>).setAlarm = async (at: number) => {
    alarm.at = at;
    alarm.sets.push(at);
  };
  let ready: Promise<unknown> = Promise.resolve();
  const ctx = {
    storage: store,
    blockConcurrencyWhile(fn: () => Promise<unknown>) {
      ready = fn();
      return ready;
    },
  };
  const reg = new RegistryDO(ctx as never, { TOKEN_PEPPER: "p".repeat(40), ...env } as never);
  await ready;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await reg.fetch(
      new Request("https://registry" + path, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return (await res.json()) as Record<string, any>;
  };
  /** Fire the alarm if it is set, as the runtime would, and wait for what it does. */
  const fire = async () => {
    if (alarm.at === null) return false;
    alarm.at = null;
    await reg.alarm();
    return true;
  };
  return { store, call, alarm, fire, reg };
}

afterEach(() => setSystemTime());

describe("the usage the registry keeps", () => {
  test("rows written and read are added to the month, and the bill includes them", async () => {
    const { call } = await registry();
    await call("POST", "/usage-add", { doRowsWritten: 60_000_000, doRowsRead: 1_000, doRequests: 5 });
    await call("POST", "/usage-add", { doRowsWritten: 38_000_000, doRowsRead: 500 });
    const usage = await call("GET", "/usage");
    expect(usage.counts.doRowsWritten).toBe(98_000_000);
    expect(usage.counts.doRowsRead).toBeGreaterThanOrEqual(1_500);
    expect(usage.cost.doRows).toBe(48);
    expect(usage.spentUsd).toBe(53);
  });

  test("a stored size sent as a count is not taken: it is measured, not added", async () => {
    const { call } = await registry();
    await call("POST", "/usage-add", { r2StoredBytes: 500e9 });
    expect((await call("GET", "/usage")).counts.r2StoredBytes).toBe(0);
  });
});

describe("the warning before the budget trips", () => {
  test("/usage says where the month is going, and warns when it will pass the budget but has not yet", async () => {
    setSystemTime(new Date("2026-12-11T00:00:00Z"));
    const { call } = await registry();
    await call("POST", "/usage-add", { doRowsWritten: 40_000_000 });
    const usage = await call("GET", "/usage");
    expect(usage.overBudget).toBe(false);
    expect(usage.projectionWarning).toBe(true);
    expect(usage.projectedUsd).toBeGreaterThan(70);
    expect(usage.warning).toMatch(/pace/);
    expect(usage.warning).toMatch(/FLEET_MONTHLY_BUDGET_USD/);
  });

  test("a quiet month has a projection and no warning", async () => {
    setSystemTime(new Date("2026-12-11T00:00:00Z"));
    const { call } = await registry();
    await call("POST", "/usage-add", { doRequests: 1000 });
    const usage = await call("GET", "/usage");
    expect(usage.projectionWarning).toBe(false);
    expect(usage.projectedUsd).toBe(5);
    expect(usage.warning).toBeUndefined();
  });

  test("in the first days there is no projection", async () => {
    setSystemTime(new Date("2026-12-01T06:00:00Z"));
    const { call } = await registry();
    const usage = await call("GET", "/usage");
    expect(usage.projectedUsd).toBeNull();
    expect(usage.projectionWarning).toBe(false);
  });

  test("a month that has already spent its budget is not warned about: the guard has stopped it", async () => {
    setSystemTime(new Date("2026-12-11T00:00:00Z"));
    const { call } = await registry();
    await call("POST", "/usage-add", { doRowsWritten: 100_000_000 });
    const usage = await call("GET", "/usage");
    expect(usage.overBudget).toBe(true);
    expect(usage.projectionWarning).toBe(false);
  });
});

describe("what the bucket holds", () => {
  test("the guard's ask is answered at once and does not list the bucket; the alarm it set does, and the next ask has the size", async () => {
    const b = bucket([40e9, 40e9, 40e9], 2); // 120 GB over two pages
    const { call, fire, alarm } = await registry({ BUCKET: b });
    const first = await call("GET", "/usage");
    // Nothing is measured yet, and the ask did not wait for a listing.
    expect(b.state.lists).toBe(0);
    expect(first.counts.r2StoredBytes).toBe(0);
    expect(first.r2MeasuredAt).toBeNull();
    expect(alarm.at).not.toBeNull();
    expect(await fire()).toBe(true);
    expect(b.state.lists).toBe(2);
    const usage = await call("GET", "/usage");
    expect(usage.counts.r2StoredBytes).toBe(120e9);
    expect(usage.cost.r2Storage).toBe(1.65);
    expect(usage.counts.r2Writes).toBe(2); // the listing, counted as the Class A calls it is
    expect(usage.r2StoredTruncated).toBe(false);
    expect(typeof usage.r2MeasuredAt).toBe("number");
  });

  test("asking again before the alarm has run sets no second alarm", async () => {
    const { call, alarm } = await registry({ BUCKET: bucket([1e9]) });
    await call("GET", "/usage");
    await call("GET", "/usage");
    await call("GET", "/usage");
    expect(alarm.sets).toHaveLength(1);
  });

  test("it is not listed again within the hours between measurements: the alarm sets the next for six hours on", async () => {
    setSystemTime(new Date("2026-12-01T00:00:00Z"));
    const b = bucket([1e9]);
    const { call, fire, alarm } = await registry({ BUCKET: b });
    await call("GET", "/usage");
    await fire();
    expect(alarm.at).toBe(Date.parse("2026-12-01T06:00:00Z"));
    setSystemTime(new Date("2026-12-01T05:00:00Z"));
    await call("GET", "/usage");
    expect(alarm.sets).toHaveLength(2); // the one the first measure left, and none from this ask
    setSystemTime(new Date("2026-12-01T06:00:00Z"));
    expect(await fire()).toBe(true);
    expect(b.state.lists).toBe(2);
  });

  test("the size is kept when the month turns over: it is what the bucket holds, not what the month added", async () => {
    setSystemTime(new Date("2026-11-30T23:00:00Z"));
    const { call, fire } = await registry({ BUCKET: bucket([30e9]) });
    await call("GET", "/usage");
    await fire();
    setSystemTime(new Date("2026-12-01T01:00:00Z"));
    const usage = await call("GET", "/usage");
    expect(usage.month).toBe("2026-12");
    expect(usage.counts.r2StoredBytes).toBe(30e9);
  });

  test("a bucket that cannot be listed leaves the guard with no size rather than failing it, and is tried again in ten minutes", async () => {
    setSystemTime(new Date("2026-12-01T00:00:00Z"));
    const broken = { async list() { throw new Error("r2 is down"); } };
    const { call, fire, alarm } = await registry({ BUCKET: broken });
    await call("GET", "/usage");
    await fire();
    expect(alarm.at).toBe(Date.parse("2026-12-01T00:10:00Z"));
    const usage = await call("GET", "/usage");
    expect(usage.counts.r2StoredBytes).toBe(0);
    expect(usage.spentUsd).toBe(5);
  });

  test("a listing that was cut short is reported, so that the size is read as at least", async () => {
    // 21 pages of one object each; the walk is twenty pages.
    const b = bucket(Array.from({ length: 21 }, () => 1e9), 1);
    const { call, fire } = await registry({ BUCKET: b });
    await call("GET", "/usage");
    await fire();
    const usage = await call("GET", "/usage");
    expect(usage.r2StoredTruncated).toBe(true);
    expect(usage.counts.r2StoredBytes).toBe(20e9);
  });

  test("with no bucket bound there is nothing to measure and no alarm", async () => {
    const { call, alarm } = await registry();
    expect((await call("GET", "/usage")).counts.r2StoredBytes).toBe(0);
    expect(alarm.sets).toHaveLength(0);
  });
});
