// Cloudflare Worker configuration, read from env vars (wrangler secrets/vars).
// Mirrors the tunables of the Bun gateway so the two are operationally equivalent.

export interface GatewayConfig {
  gatewayToken?: string; // client -> gateway auth for /mcp/*
  deviceToken?: string; // device -> gateway auth at WS connect
  adminToken?: string; // /devices endpoint auth (defaults to gatewayToken)
  rateWindowMs: number;
  rateMax: number;
  timeoutMs: number;
  maxPendingPerDevice: number;
  maxBodyBytes: number;
  allowedOrigins: Set<string> | null; // WS origin whitelist (null = any)
  keepaliveTimeoutMs: number; // drop WS after this long without any frame
  pingIntervalMs: number; // expected keepalive cadence (used for alarms)
  pingMaxMisses: number;
  idleTimeoutMs: number;
  env: string; // "dev" | "prod" (informational)
}

export interface Env {
  GATEWAY_TOKEN?: string;
  DEVICE_TOKEN?: string;
  ADMIN_TOKEN?: string;
  RATE_LIMIT_WINDOW_MS?: string;
  RATE_LIMIT_MAX?: string;
  TIMEOUT_MS?: string;
  MAX_PENDING_PER_DEVICE?: string;
  MAX_BODY_BYTES?: string;
  ALLOWED_ORIGINS?: string;
  KEEPALIVE_TIMEOUT_MS?: string;
  PING_INTERVAL_MS?: string;
  PING_MAX_MISSES?: string;
  IDLE_TIMEOUT_MS?: string;
  ENVIRONMENT?: string;
  DEVICES: DurableObjectNamespace;
  REGISTRY: DurableObjectNamespace;
}

function num(env: Env, key: string, def: number): number {
  const raw = (env as unknown as Record<string, string | undefined>)[key];
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

export function loadConfig(env: Env): GatewayConfig {
  return {
    gatewayToken: env.GATEWAY_TOKEN || undefined,
    deviceToken: env.DEVICE_TOKEN || undefined,
    adminToken: env.ADMIN_TOKEN || env.GATEWAY_TOKEN || undefined,
    rateWindowMs: num(env, "RATE_LIMIT_WINDOW_MS", 60_000),
    rateMax: num(env, "RATE_LIMIT_MAX", 100),
    timeoutMs: num(env, "TIMEOUT_MS", 30_000),
    maxPendingPerDevice: num(env, "MAX_PENDING_PER_DEVICE", 100),
    maxBodyBytes: num(env, "MAX_BODY_BYTES", 1024 * 1024),
    allowedOrigins: env.ALLOWED_ORIGINS
      ? new Set(env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean))
      : null,
    keepaliveTimeoutMs: num(env, "KEEPALIVE_TIMEOUT_MS", 90_000),
    pingIntervalMs: num(env, "PING_INTERVAL_MS", 30_000),
    pingMaxMisses: num(env, "PING_MAX_MISSES", 2),
    idleTimeoutMs: num(env, "IDLE_TIMEOUT_MS", 120_000),
    env: env.ENVIRONMENT || "dev",
  };
}

// deviceId character allowlist + length cap. Prevents path-traversal-flavored
// confusion in /mcp/{id} routing and bounds memory for spurious registrations.
const DEVICE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
export function validDeviceId(s: string): boolean {
  return DEVICE_ID_RE.test(s);
}

export function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function extractToken(req: Request, url: URL, queryName: string): string | null {
  const auth = req.headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) return m[1].trim();
  }
  const q = url.searchParams.get(queryName);
  if (q) return q;
  return null;
}
