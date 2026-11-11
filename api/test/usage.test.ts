import { describe, expect, test } from "bun:test";
import { costOf, monthKey, monthProgress, monthlyBudget, PRICES, ZERO_USAGE } from "../src/usage";

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

  test("a fleet that is always on is what an object's minutes cost", () => {
    // A month of minutes, one object awake the whole time.
    const minutes = 30 * 24 * 60;
    const cost = costOf({ ...ZERO_USAGE, doMinutes: minutes });
    // 30 days * 24h * 60m * 60s * 0.125 GB = 324,000 GB-s, under the 400,000 free.
    expect(cost.doDuration).toBe(0);
    // Two of them go past the allowance: 648,000 GB-s, so 248,000 over, a
    // little over three dollars.
    const two = costOf({ ...ZERO_USAGE, doMinutes: minutes * 2 });
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
