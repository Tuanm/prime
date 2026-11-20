import { describe, expect, test } from "bun:test";
import { costOf, HitMeter, monthKey, monthProgress, monthlyBudget, PRICES, ZERO_USAGE, type UsageCounts } from "../src/usage";

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
