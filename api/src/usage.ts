/**
 * What the gateway has used this month, and what that costs.
 *
 * The numbers here are counted, not guessed: every request that reaches the
 * gateway is counted, every Durable Object counts the requests it serves and
 * how long it was busy serving them, and the R2 calls the fleets make are counted where
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
  /**
   * Milliseconds in which a Durable Object was working: a request, a socket
   * message or an alarm in hand. Summed over the objects.
   */
  doActiveMs: number;
  /** R2 writes (Class A). */
  r2Writes: number;
  /** R2 reads (Class B). */
  r2Reads: number;
  /**
   * Rows written to Durable Object storage: one for each key put or deleted and one for each alarm
   * set. Cloudflare bills them, and a fleet that renews its lease every fifteen seconds writes
   * them all day.
   */
  doRowsWritten: number;
  /** Rows read from Durable Object storage: one for each key asked for. */
  doRowsRead: number;
  /**
   * Bytes the bucket holds right now. Not a count that goes up: the last measurement of a thing
   * that goes both ways, which is billed by the month it is held for.
   */
  r2StoredBytes: number;
}

export const ZERO_USAGE: UsageCounts = {
  gatewayRequests: 0,
  doRequests: 0,
  doActiveMs: 0,
  r2Writes: 0,
  r2Reads: 0,
  doRowsWritten: 0,
  doRowsRead: 0,
  r2StoredBytes: 0,
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
  /**
   * A Durable Object is billed for the time it is working, at 128 MB each. An
   * object whose sockets are hibernated is not billed while it waits.
   */
  perMillionGbSeconds: 12.5,
  includedGbSeconds: 400_000,
  gbPerDo: 0.125,
  /** R2 operations beyond the included allowances. */
  perMillionR2Writes: 4.5,
  includedR2Writes: 1_000_000,
  perMillionR2Reads: 0.36,
  includedR2Reads: 10_000_000,
  /** Durable Object SQLite rows (the storage every object here uses). */
  perMillionRowsWritten: 1,
  includedRowsWritten: 50_000_000,
  perMillionRowsRead: 0.001,
  includedRowsRead: 25_000_000_000,
  /** R2 storage, per gigabyte-month beyond the included ten. A gigabyte is 10^9 bytes. */
  perGbR2Storage: 0.015,
  includedR2StorageGb: 10,
  bytesPerGb: 1_000_000_000,
} as const;

export interface UsageCost {
  plan: number;
  gatewayRequests: number;
  doRequests: number;
  doDuration: number;
  r2: number;
  /** Rows written and read in the objects' storage. */
  doRows: number;
  /** What the bucket holds, at this size for the month. */
  r2Storage: number;
  total: number;
}

/** What a month of counts costs, in dollars, with the allowances applied. */
export function costOf(usage: UsageCounts): UsageCost {
  const gatewayRequests =
    (Math.max(0, usage.gatewayRequests - PRICES.includedGatewayRequests) / 1_000_000) *
    PRICES.perMillionGatewayRequests;
  const doRequests =
    (Math.max(0, usage.doRequests - PRICES.includedDoRequests) / 1_000_000) * PRICES.perMillionDoRequests;
  // A second of work is a second of the object's memory.
  const gbSeconds = ((usage.doActiveMs || 0) / 1000) * PRICES.gbPerDo;
  const doDuration =
    (Math.max(0, gbSeconds - PRICES.includedGbSeconds) / 1_000_000) * PRICES.perMillionGbSeconds;
  const r2 =
    (Math.max(0, usage.r2Writes - PRICES.includedR2Writes) / 1_000_000) * PRICES.perMillionR2Writes +
    (Math.max(0, usage.r2Reads - PRICES.includedR2Reads) / 1_000_000) * PRICES.perMillionR2Reads;
  const doRows =
    (Math.max(0, (usage.doRowsWritten || 0) - PRICES.includedRowsWritten) / 1_000_000) * PRICES.perMillionRowsWritten +
    (Math.max(0, (usage.doRowsRead || 0) - PRICES.includedRowsRead) / 1_000_000) * PRICES.perMillionRowsRead;
  // Held at the size it was last measured at: a month at that size is what it would cost.
  const r2Storage =
    Math.max(0, (usage.r2StoredBytes || 0) / PRICES.bytesPerGb - PRICES.includedR2StorageGb) * PRICES.perGbR2Storage;
  const total = PRICES.planMonthly + gatewayRequests + doRequests + doDuration + r2 + doRows + r2Storage;
  return {
    plan: PRICES.planMonthly,
    gatewayRequests: round(gatewayRequests),
    doRequests: round(doRequests),
    doDuration: round(doDuration),
    r2: round(r2),
    doRows: round(doRows),
    r2Storage: round(r2Storage),
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
 * A Durable Object is billed for the time it is working, so that is measured
 * as well as the requests: from when a request, a socket message or an alarm
 * is taken up until it is done. Work that overlaps is counted once, because
 * the object is up once. The time between is not counted: the objects here
 * hibernate their sockets, and an object with nothing in hand is not billed.
 */
export class HitMeter {
  private requests = 0;
  private activeMs = 0;
  private working = 0;
  private since = 0;
  private r2Writes = 0;
  private r2Reads = 0;
  private rowsWritten = 0;
  private rowsRead = 0;
  private at = Date.now();

  constructor(private readonly send: (add: Partial<UsageCounts>) => void) {}

  /** Note one request served. */
  hit(now = Date.now()): void {
    this.requests += 1;
    // Batched: a hundred requests, or a minute of them, whichever comes first.
    if (this.requests >= 100 || now - this.at >= 60_000) this.flush(now);
  }

  /** Note that the object took up some work; call what it returns when it is done. */
  begin(now = Date.now()): (end?: number) => void {
    if (this.working === 0) this.since = now;
    this.working += 1;
    let done = false;
    return (end = Date.now()) => {
      if (done) return;
      done = true;
      this.working -= 1;
      if (this.working === 0) this.activeMs += Math.max(0, end - this.since);
    };
  }

  /** Measure one piece of work, however it ends. */
  async busy<T>(work: () => Promise<T>): Promise<T> {
    const done = this.begin();
    try {
      return await work();
    } finally {
      done();
    }
  }

  /** Note the object storing or reading something in R2 on the fleet's behalf. */
  r2(op: "write" | "read"): void {
    if (op === "write") this.r2Writes += 1;
    else this.r2Reads += 1;
  }

  /** Note rows of the object's own storage read or written. */
  rows(kind: "read" | "write", n = 1): void {
    if (!(n > 0)) return;
    if (kind === "write") this.rowsWritten += n;
    else this.rowsRead += n;
  }

  /** Send what has been counted so far. */
  flush(now = Date.now()): void {
    // Work still in hand is counted up to now, and the rest of it from now.
    if (this.working > 0) {
      this.activeMs += Math.max(0, now - this.since);
      this.since = now;
    }
    if (
      this.requests === 0 && this.activeMs === 0 && this.r2Writes === 0 && this.r2Reads === 0 &&
      this.rowsWritten === 0 && this.rowsRead === 0
    ) return;
    const add: Partial<UsageCounts> = {
      doRequests: this.requests,
      doActiveMs: Math.round(this.activeMs),
      r2Writes: this.r2Writes,
      r2Reads: this.r2Reads,
      // Left out when there are none, so a meter that does not count rows sends what it always did.
      ...(this.rowsWritten > 0 ? { doRowsWritten: this.rowsWritten } : {}),
      ...(this.rowsRead > 0 ? { doRowsRead: this.rowsRead } : {}),
    };
    this.requests = 0;
    this.activeMs = 0;
    this.r2Writes = 0;
    this.r2Reads = 0;
    this.rowsWritten = 0;
    this.rowsRead = 0;
    this.at = now;
    // Nothing a meter does may fail a request: an object with no registry bound
    // (a test, a half-configured deployment) simply does not report.
    try {
      this.send(add);
    } catch {}
  }
}

/** How far through the UTC month it is, to the millisecond: 0 at the first instant, 1 at the last. */
export function monthElapsed(at = Date.now()): number {
  const d = new Date(at);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return Math.min(1, Math.max(0, (at - start) / (end - start)));
}

/** Before this much of the month has gone, the pace says nothing: the first hours are not a month. */
export const PROJECTION_MIN_ELAPSED_MS = 2 * 24 * 60 * 60_000;

export interface Projection {
  /** What the month will cost if it goes on at the pace it has gone so far. */
  usd: number;
  /** The pace passes the budget though the month so far has not. */
  warn: boolean;
}

/**
 * What the month will cost at its pace so far, or null while it is too early to say.
 *
 * The counts that go up are scaled to the whole month and priced again, so the free allowances are
 * applied once, to the month's total: a month that has used a tenth of an allowance in a tenth of
 * the time is not charged for it. What the bucket holds is a size, not a count, and is not scaled.
 */
export function projectMonth(counts: UsageCounts, budgetUsd: number, at = Date.now()): Projection | null {
  const d = new Date(at);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  if (at - start < PROJECTION_MIN_ELAPSED_MS) return null;
  const elapsed = monthElapsed(at);
  if (elapsed <= 0) return null;
  const scaled = { ...counts };
  for (const key of ["gatewayRequests", "doRequests", "doActiveMs", "r2Writes", "r2Reads", "doRowsWritten", "doRowsRead"] as const) {
    scaled[key] = Math.round((counts[key] || 0) / elapsed);
  }
  const usd = costOf(scaled).total;
  const spent = costOf(counts).total;
  return { usd, warn: spent < budgetUsd && usd > budgetUsd };
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

/** The storage calls an object makes that are billed as rows. */
interface RowStorage {
  get?: (keyOrKeys: unknown, ...rest: unknown[]) => Promise<unknown>;
  put?: (keyOrEntries: unknown, ...rest: unknown[]) => Promise<unknown>;
  delete?: (keyOrKeys: unknown, ...rest: unknown[]) => Promise<unknown>;
  list?: (...args: unknown[]) => Promise<unknown>;
  setAlarm?: (...args: unknown[]) => Promise<unknown>;
  deleteAlarm?: (...args: unknown[]) => Promise<unknown>;
}

/**
 * An object's storage, as it was, with every row it reads and writes counted.
 *
 * Cloudflare bills a Durable Object's storage by the row: a key put or deleted is a row written
 * (a delete of a key that is not there too: it is counted, so a call that has nothing to delete
 * should not be made), an alarm set is one more, a key asked for is a row read. The counts go to
 * the object's meter, which sends them on with the requests. Methods the storage does not have (a
 * test's stand-in) are left alone.
 */
export function meterStorage<T extends object>(storage: T, meter: HitMeter): T {
  const count = (name: string, args: unknown[], result: unknown): void => {
    const first = args[0];
    switch (name) {
      case "get":
        meter.rows("read", Array.isArray(first) ? first.length : first instanceof Map ? first.size : 1);
        return;
      case "list":
        meter.rows("read", Math.max(1, result instanceof Map ? result.size : 1));
        return;
      case "put":
        meter.rows("write", typeof first === "string" ? 1 : first && typeof first === "object" ? Object.keys(first).length : 1);
        return;
      case "delete":
        meter.rows("write", Array.isArray(first) ? first.length : 1);
        return;
      case "setAlarm":
      case "deleteAlarm":
        meter.rows("write", 1);
        return;
    }
  };
  const counted = new Set(["get", "list", "put", "delete", "setAlarm", "deleteAlarm"]);
  return new Proxy(storage, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof prop !== "string" || typeof value !== "function") return value;
      if (!counted.has(prop)) return (value as (...a: unknown[]) => unknown).bind(target);
      return async (...args: unknown[]): Promise<unknown> => {
        const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        try {
          count(prop, args, result);
        } catch {}
        return result;
      };
    },
  }) as T;
}

/**
 * What a bucket holds, in bytes, by listing it.
 *
 * Listing is a Class A call for each page of up to a thousand objects, so the list is walked a few
 * pages at a time and not often. A bucket with more objects than `maxPages` pages hold is measured
 * to there and `truncated` says so: the size is then at least that.
 */
export async function bucketBytes(
  bucket: { list: (opts: { cursor?: string; limit?: number }) => Promise<{ objects: Array<{ size?: number }>; truncated: boolean; cursor?: string }> },
  maxPages = 20,
): Promise<{ bytes: number; calls: number; truncated: boolean }> {
  let bytes = 0;
  let calls = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
    calls += 1;
    for (const o of page.objects) bytes += Number(o.size) || 0;
    if (!page.truncated || !page.cursor) return { bytes, calls, truncated: false };
    if (calls >= maxPages) return { bytes, calls, truncated: true };
    cursor = page.cursor;
  }
}
