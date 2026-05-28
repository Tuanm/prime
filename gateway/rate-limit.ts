export class RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  private sweepTimer: ReturnType<typeof setInterval>;

  constructor(
    private windowMs: number,
    private max: number,
  ) {
    // Periodic sweep so rotated IPs (XFF spoofing) cannot grow the map without bound.
    const interval = Math.max(windowMs, 10_000);
    this.sweepTimer = setInterval(() => this.sweep(), interval);
  }

  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.buckets.get(key);
    if (!entry || now > entry.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (entry.count >= this.max) return false;
    entry.count++;
    return true;
  }

  size(): number {
    return this.buckets.size;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.buckets) {
      if (now > v.resetAt) this.buckets.delete(k);
    }
  }

  stop(): void {
    clearInterval(this.sweepTimer);
  }
}

export function extractClientIp(req: Request, fallback: string, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers.get('x-forwarded-for');
    if (xff) {
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }
    const xri = req.headers.get('x-real-ip');
    if (xri) {
      const t = xri.trim();
      if (t) return t;
    }
  }
  return fallback;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopback(addr: string | undefined | null): boolean {
  if (!addr) return false;
  return LOOPBACK.has(addr);
}
