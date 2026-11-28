import { describe, expect, test } from "bun:test";
import { bucketBytes, costOf, HitMeter, meterStorage, monthKey, monthProgress, monthlyBudget, PRICES, ZERO_USAGE, type UsageCounts } from "../src/usage";

describe("what a month of the gateway costs", () => {
  test("an idle month costs the plan and nothing else", () => {
    const cost = costOf(ZERO_USAGE);
    expect(cost.plan).toBe(PRICES.planMonthly);
    expect(cost.total).toBe(PRICES.planMonthly);
  });

  test("the allowances are applied before anything is charged", () => {
    // Exactly the included requests cost nothing on top of the plan.
    const inside = costOf({ ...ZERO_USAGE, gatewayRequests: PRICES.includedGatewayRequests, doRequests: PRICES.includedDoRequests });
    expect(inside.gatewayRequests).toBe(0);
    expect(inside.doRequests).toBe(0);
    expect(inside.total).toBe(PRICES.planMonthly);
  });

  test("what is over the allowance is charged at the list price", () => {
    const cost = costOf({ ...ZERO_USAGE, doRequests: PRICES.includedDoRequests + 8_000_000 });
    // Eight million over, at fifteen cents a million.
    expect(cost.doRequests).toBe(1.2);
    const gw = costOf({ ...ZERO_USAGE, gatewayRequests: PRICES.includedGatewayRequests + 5_000_000 });
    expect(gw.gatewayRequests).toBe(1.5);
  });

  test("a fleet that is always on is what an object's busy time costs", () => {
    // A month of one object working the whole time.
    const month = 30 * 24 * 3600 * 1000;
    const cost = costOf({ ...ZERO_USAGE, doActiveMs: month });
    // 30 days * 24h * 3600s * 0.125 GB = 324,000 GB-s, under the 400,000 free.
    expect(cost.doDuration).toBe(0);
    // Two of them go past the allowance: 648,000 GB-s, so 248,000 over, a
    // little over three dollars.
    const two = costOf({ ...ZERO_USAGE, doActiveMs: month * 2 });
    expect(two.doDuration).toBe(3.1);
  });

  test("the budget defaults to twenty dollars and can be set", () => {
    expect(monthlyBudget({})).toBe(20);
    expect(monthlyBudget({ FLEET_MONTHLY_BUDGET_USD: "35" })).toBe(35);
    expect(monthlyBudget({ FLEET_MONTHLY_BUDGET_USD: "nonsense" })).toBe(20);
    expect(monthlyBudget({ FLEET_MONTHLY_BUDGET_USD: "0" })).toBe(20);
  });

  test("the month key and the progress through it", () => {
    expect(monthKey(Date.UTC(2026, 10, 9))).toBe("2026-11");
    const early = monthProgress(Date.UTC(2026, 10, 1));
    const late = monthProgress(Date.UTC(2026, 10, 30));
    expect(early).toBeLessThan(late);
    expect(late).toBeLessThanOrEqual(1);
  });
});

describe("how long an object was busy", () => {
  function metered() {
    const sent: Array<Partial<UsageCounts>> = [];
    return { sent, meter: new HitMeter((add) => sent.push(add)) };
  }

  test("a short request is its own few milliseconds, not the minute it fell in", () => {
    const { sent, meter } = metered();
    const t = 1_000_000_000_000;
    meter.hit(t);
    const done = meter.begin(t);
    done(t + 20);
    meter.flush(t + 20);
    expect(sent).toEqual([{ doRequests: 1, doActiveMs: 20, r2Writes: 0, r2Reads: 0 }]);
  });

  test("requests that overlap are counted once, as the object is up once", () => {
    const { sent, meter } = metered();
    const t = 1_000_000_000_000;
    const a = meter.begin(t);
    const b = meter.begin(t + 50);
    a(t + 100);
    b(t + 150);
    meter.flush(t + 150);
    expect(sent[0].doActiveMs).toBe(150);
  });

  test("a flush in the middle of work sends what has passed and keeps the rest", () => {
    const { sent, meter } = metered();
    const t = 1_000_000_000_000;
    const done = meter.begin(t);
    meter.flush(t + 30);
    done(t + 50);
    meter.flush(t + 50);
    expect(sent.map((s) => s.doActiveMs)).toEqual([30, 20]);
  });

  test("an old month's minutes do not make it into the cost", () => {
    const legacy = { ...ZERO_USAGE, doMinutes: 10_000_000 } as unknown as UsageCounts;
    expect(costOf(legacy).doDuration).toBe(0);
  });
});

describe("the rows and the bytes that are billed", () => {
  test("rows written and read are charged beyond their allowances, at the list price", () => {
    const inside = costOf({ ...ZERO_USAGE, doRowsWritten: PRICES.includedRowsWritten, doRowsRead: PRICES.includedRowsRead });
    expect(inside.doRows).toBe(0);
    // Forty-eight million rows over the fifty included, at a dollar a million.
    const over = costOf({ ...ZERO_USAGE, doRowsWritten: 98_000_000 });
    expect(over.doRows).toBe(48);
    expect(over.total).toBe(PRICES.planMonthly + 48);
    // Reads are a thousandth of that: ten billion rows over the allowance are ten dollars.
    expect(costOf({ ...ZERO_USAGE, doRowsRead: PRICES.includedRowsRead + 10_000_000_000 }).doRows).toBe(10);
  });

  test("the bucket is charged for what it holds beyond ten gigabytes", () => {
    expect(costOf({ ...ZERO_USAGE, r2StoredBytes: 10 * 1e9 }).r2Storage).toBe(0);
    // A hundred and ten gigabytes: a hundred over, at a cent and a half.
    expect(costOf({ ...ZERO_USAGE, r2StoredBytes: 110 * 1e9 }).r2Storage).toBe(1.5);
  });

  test("a hundred fleets of three, always on, are seen at what they cost, not at the quarter that was counted before", () => {
    // The month of 100 fleets x 3 members, as the cost model counts it: 98.6M rows written, the rest as listed.
    const month: UsageCounts = {
      ...ZERO_USAGE,
      gatewayRequests: 24_768_600,
      doRequests: 42_192_800 + 12_384_300 + 1_555_200,
      doActiveMs: Math.round((136_443 / PRICES.gbPerDo) * 1000),
      r2Writes: 432_000,
      r2Reads: 20_736_400,
      doRowsWritten: 98_640_700,
      doRowsRead: 117_362_300,
    };
    const seen = costOf(month);
    expect(seen.doRows).toBe(48.64);
    // Without the rows the guard saw $21.57 of a $70.21 bill; with them, all of it.
    const before = costOf({ ...month, doRowsWritten: 0, doRowsRead: 0 });
    expect(before.total).toBeLessThan(22);
    expect(seen.total).toBeGreaterThan(70);
    expect(seen.total).toBeLessThan(71);
  });

  test("a meter sends the rows it was given, and leaves them out when there are none", () => {
    const sent: Array<Partial<UsageCounts>> = [];
    const meter = new HitMeter((add) => sent.push(add));
    meter.rows("write", 5);
    meter.rows("read", 7);
    meter.rows("write", 0);
    meter.rows("read", -3);
    meter.flush();
    expect(sent).toEqual([{ doRequests: 0, doActiveMs: 0, r2Writes: 0, r2Reads: 0, doRowsWritten: 5, doRowsRead: 7 }]);
  });
});

describe("an object's storage, counted", () => {
  function counted() {
    const sent: Array<Partial<UsageCounts>> = [];
    const meter = new HitMeter((add) => sent.push(add));
    const data = new Map<string, unknown>();
    const alarms: number[] = [];
    const raw = {
      async get(k: string | string[]) {
        if (Array.isArray(k)) return new Map(k.filter((x) => data.has(x)).map((x) => [x, data.get(x)]));
        return data.get(k);
      },
      async put(k: string | Record<string, unknown>, v?: unknown) {
        if (typeof k === "string") data.set(k, v);
        else for (const [a, b] of Object.entries(k)) data.set(a, b);
      },
      async delete(k: string | string[]) {
        const keys = Array.isArray(k) ? k : [k];
        for (const x of keys) data.delete(x);
        return keys.length;
      },
      async list() {
        return new Map(data);
      },
      async setAlarm(at: number) {
        alarms.push(at);
      },
      // a method that is not a row: handed through with its own `this`
      note() {
        return this === raw ? "mine" : "not mine";
      },
    };
    const storage = meterStorage(raw, meter);
    const rows = () => {
      sent.length = 0;
      meter.flush();
      return { written: sent[0]?.doRowsWritten ?? 0, read: sent[0]?.doRowsRead ?? 0 };
    };
    return { storage, rows, alarms, data };
  }

  test("each key put or deleted and each alarm set is a row written; each key asked for is a row read", async () => {
    const { storage, rows, alarms } = counted();
    await storage.put("a", 1);
    await storage.put({ b: 2, c: 3 });
    await storage.delete("a");
    await storage.delete(["b", "c", "gone"]);
    await storage.setAlarm(5);
    await storage.get("x");
    await storage.get(["x", "y"]);
    await storage.list();
    expect(rows()).toEqual({ written: 1 + 2 + 1 + 3 + 1, read: 1 + 2 + 1 });
    expect(alarms).toEqual([5]);
  });

  test("it hands back what the storage answered, and other methods keep their own this", async () => {
    const { storage } = counted();
    await storage.put("k", { v: 1 });
    expect(await storage.get("k")).toEqual({ v: 1 });
    expect(storage.note()).toBe("mine");
  });

  test("a call that fails is not counted", async () => {
    const sent: Array<Partial<UsageCounts>> = [];
    const meter = new HitMeter((add) => sent.push(add));
    const storage = meterStorage({ async put() { throw new Error("no"); } }, meter);
    await expect(storage.put()).rejects.toThrow("no");
    meter.flush();
    expect(sent).toEqual([]);
  });
});

describe("what a bucket holds", () => {
  const pages = (sizes: number[][]) => {
    let n = 0;
    return {
      async list(opts: { cursor?: string }) {
        const page = sizes[n++] ?? [];
        return { objects: page.map((size) => ({ size })), truncated: n < sizes.length, cursor: "c" + n };
      },
    };
  };

  test("the pages are added up, and each is one call", async () => {
    expect(await bucketBytes(pages([[10, 20], [30], [40]]))).toEqual({ bytes: 100, calls: 3, truncated: false });
  });

  test("a bucket bigger than the pages it is walked for is measured to there, and says so", async () => {
    expect(await bucketBytes(pages([[1], [1], [1], [1]]), 2)).toEqual({ bytes: 2, calls: 2, truncated: true });
  });
});
