// In-memory sliding-window limiter, keyed by client IP.
// NOTE: Cloudflare runs many isolates; this limiter is per-isolate. For global
// enforcement add a Cloudflare Rate Limiting rule in the dashboard
// (https://dash.cloudflare.com -> Security -> WAF -> Rate limiting rules),
// using CF-Connecting-IP as the target. The per-isolate limiter here still
// protects each isolate from burst floods and is cheap (no extra round trip).

export class RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private windowMs: number,
    private max: number,
  ) {
    if (typeof setInterval !== "undefined") {
      const interval = Math.max(windowMs, 10_000);
      this.sweepTimer = setInterval(() => this.sweep(), interval);
    }
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
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}

// Client IP on Cloudflare: CF-Connecting-IP is set by the edge and cannot be
// spoofed by clients (unlike X-Forwarded-For). Fall back to X-Forwarded-For's
// first entry, then a placeholder.
export function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}
