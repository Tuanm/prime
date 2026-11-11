/**
 * What the gateway has used this month, and what that costs.
 *
 * The numbers here are counted, not guessed: every request that reaches the
 * gateway is counted, every Durable Object counts the requests it serves and
 * the minutes it was awake, and the R2 calls the fleets make are counted where
 * they are made. What is left is arithmetic over Cloudflare's list prices, so
 * the operator can compare a month against a budget.
 *
 * The prices are the ones on Cloudflare's pricing page; if they change, they
 * change here. Every allowance is subtracted, so a month that stays inside the
 * free tiers costs nothing however much is counted.
 */

/** One month of counts. Everything is a number that only goes up. */
export interface UsageCounts {
  /** Requests that reached the Worker. */
  gatewayRequests: number;
  /** Requests served by the Durable Objects. */
  doRequests: number;
  /** Minutes in which a Durable Object was awake (any one of them). */
  doMinutes: number;
  /** R2 writes (Class A). */
  r2Writes: number;
  /** R2 reads (Class B). */
  r2Reads: number;
}

export const ZERO_USAGE: UsageCounts = {
  gatewayRequests: 0,
  doRequests: 0,
  doMinutes: 0,
  r2Writes: 0,
  r2Reads: 0,
};

/** Cloudflare's list prices, per month, in US dollars. */
export const PRICES = {
  /** The Workers Paid plan, which is what makes Durable Objects possible. */
  planMonthly: 5,
  /** Requests beyond the included ten million. */
  perMillionGatewayRequests: 0.3,
  includedGatewayRequests: 10_000_000,
  /** Durable Object requests beyond the included million. */
  perMillionDoRequests: 0.15,
  includedDoRequests: 1_000_000,
  /** A Durable Object is billed for the time it is loaded: 128 MB each. */
  perMillionGbSeconds: 12.5,
  includedGbSeconds: 400_000,
  gbPerDo: 0.125,
  /** R2 operations beyond the included allowances. */
  perMillionR2Writes: 4.5,
  includedR2Writes: 1_000_000,
  perMillionR2Reads: 0.36,
  includedR2Reads: 10_000_000,
} as const;

export interface UsageCost {
  plan: number;
  gatewayRequests: number;
  doRequests: number;
  doDuration: number;
  r2: number;
  total: number;
}

/** What a month of counts costs, in dollars, with the allowances applied. */
export function costOf(usage: UsageCounts): UsageCost {
  const gatewayRequests =
    (Math.max(0, usage.gatewayRequests - PRICES.includedGatewayRequests) / 1_000_000) *
    PRICES.perMillionGatewayRequests;
  const doRequests =
    (Math.max(0, usage.doRequests - PRICES.includedDoRequests) / 1_000_000) * PRICES.perMillionDoRequests;
  // A minute awake is sixty seconds of the object's memory.
  const gbSeconds = usage.doMinutes * 60 * PRICES.gbPerDo;
  const doDuration =
    (Math.max(0, gbSeconds - PRICES.includedGbSeconds) / 1_000_000) * PRICES.perMillionGbSeconds;
  const r2 =
    (Math.max(0, usage.r2Writes - PRICES.includedR2Writes) / 1_000_000) * PRICES.perMillionR2Writes +
    (Math.max(0, usage.r2Reads - PRICES.includedR2Reads) / 1_000_000) * PRICES.perMillionR2Reads;
  const total = PRICES.planMonthly + gatewayRequests + doRequests + doDuration + r2;
  return {
    plan: PRICES.planMonthly,
    gatewayRequests: round(gatewayRequests),
    doRequests: round(doRequests),
    doDuration: round(doDuration),
    r2: round(r2),
    total: round(total),
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The monthly budget, in dollars: what the gateway will stop the fleets at. */
export function monthlyBudget(env: Record<string, string | undefined>): number {
  const raw = Number(env.FLEET_MONTHLY_BUDGET_USD ?? "");
  if (!Number.isFinite(raw) || raw <= 0) return 20;
  return Math.min(raw, 10_000);
}

// The R2 calls the fleet routes make, counted where they are made and taken
// by the Worker's batch. Kept here so the routes do not import the entry.
let fleetR2Writes = 0;
let fleetR2Reads = 0;

/** Called by the fleet routes for each object they store or read. */
export function countFleetR2(op: "write" | "read"): void {
  if (op === "write") fleetR2Writes += 1;
  else fleetR2Reads += 1;
}

/** Take what has been counted since the last call. */
export function takeFleetR2(): { writes: number; reads: number } {
  const taken = { writes: fleetR2Writes, reads: fleetR2Reads };
  fleetR2Writes = 0;
  fleetR2Reads = 0;
  return taken;
}

/**
 * Add to this month's counts.
 *
 * The caller keeps the numbers in memory and sends them in batches: a write
 * per request would be a bill of its own. A batch that never leaves - an
 * isolate that is dropped mid-count - is a few requests, not a month.
 */
export async function sendUsage(
  registry: { fetch: (input: string, init?: RequestInit) => Promise<Response> },
  add: Partial<UsageCounts>,
): Promise<void> {
  try {
    await registry.fetch("https://registry/usage-add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(add),
    });
  } catch {}
}

/**
 * Counts kept in memory by one Durable Object, sent on in batches.
 *
 * A Durable Object is billed for the time it is loaded, so the minutes it was
 * touched in are counted as well as the requests: a minute with a request in
 * it is a minute it was up.
 */
export class HitMeter {
  private requests = 0;
  private readonly minutes = new Set<number>();
  private r2Writes = 0;
  private r2Reads = 0;
  private at = Date.now();

  constructor(private readonly send: (add: Partial<UsageCounts>) => void) {}

  /** Note one request served. */
  hit(now = Date.now()): void {
    this.requests += 1;
    this.minutes.add(Math.floor(now / 60_000));
    // Batched: a hundred requests, or a minute of them, whichever comes first.
    if (this.requests >= 100 || now - this.at >= 60_000) this.flush(now);
  }

  /** Note the object storing or reading something in R2 on the fleet's behalf. */
  r2(op: "write" | "read"): void {
    if (op === "write") this.r2Writes += 1;
    else this.r2Reads += 1;
  }

  /** Send what has been counted so far. */
  flush(now = Date.now()): void {
    if (this.requests === 0 && this.minutes.size === 0 && this.r2Writes === 0 && this.r2Reads === 0) return;
    const add = {
      doRequests: this.requests,
      doMinutes: this.minutes.size,
      r2Writes: this.r2Writes,
      r2Reads: this.r2Reads,
    };
    this.requests = 0;
    this.minutes.clear();
    this.r2Writes = 0;
    this.r2Reads = 0;
    this.at = now;
    // Nothing a meter does may fail a request: an object with no registry bound
    // (a test, a half-configured deployment) simply does not report.
    try {
      this.send(add);
    } catch {}
  }
}

/** The month a count belongs to, in the same shape everywhere: 2026-11. */
export function monthKey(at = Date.now()): string {
  const d = new Date(at);
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}

/** How far through the month the day is: used to say what the month will cost. */
export function monthProgress(at = Date.now()): number {
  const d = new Date(at);
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return Math.min(1, Math.max(0.01, d.getUTCDate() / daysInMonth));
}
