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
  return { store, call };
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
  test("it is listed, its size is in the month's cost, and the listing is counted as the Class A calls it is", async () => {
    const b = bucket([40e9, 40e9, 40e9], 2); // 120 GB over two pages
    const { call } = await registry({ BUCKET: b });
    const usage = await call("GET", "/usage");
    expect(usage.counts.r2StoredBytes).toBe(120e9);
    expect(usage.cost.r2Storage).toBe(1.65);
    expect(usage.counts.r2Writes).toBe(2);
    expect(b.state.lists).toBe(2);
  });

  test("it is not listed again within the hours between measurements, and is once they have gone by", async () => {
    setSystemTime(new Date("2026-12-01T00:00:00Z"));
    const b = bucket([1e9]);
    const { call } = await registry({ BUCKET: b });
    await call("GET", "/usage");
    await call("GET", "/usage");
    setSystemTime(new Date("2026-12-01T05:00:00Z"));
    await call("GET", "/usage");
    expect(b.state.lists).toBe(1);
    setSystemTime(new Date("2026-12-01T07:00:00Z"));
    await call("GET", "/usage");
    expect(b.state.lists).toBe(2);
  });

  test("the size is kept when the month turns over: it is what the bucket holds, not what the month added", async () => {
    setSystemTime(new Date("2026-11-30T23:00:00Z"));
    const { call } = await registry({ BUCKET: bucket([30e9]) });
    await call("GET", "/usage");
    setSystemTime(new Date("2026-12-01T01:00:00Z"));
    const usage = await call("GET", "/usage");
    expect(usage.month).toBe("2026-12");
    expect(usage.counts.r2StoredBytes).toBe(30e9);
  });

  test("a bucket that cannot be listed leaves the guard with no size rather than failing it", async () => {
    const broken = { async list() { throw new Error("r2 is down"); } };
    const { call } = await registry({ BUCKET: broken });
    const usage = await call("GET", "/usage");
    expect(usage.counts.r2StoredBytes).toBe(0);
    expect(usage.spentUsd).toBe(5);
  });

  test("with no bucket bound there is nothing to measure", async () => {
    const { call } = await registry();
    expect((await call("GET", "/usage")).counts.r2StoredBytes).toBe(0);
  });
});
