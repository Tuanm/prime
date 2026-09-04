// Cloudflare Worker configuration, read from env vars (wrangler secrets/vars).
// Mirrors the tunables of the Bun gateway so the two are operationally equivalent.

export interface GatewayConfig {
  gatewayToken?: string; // client -> gateway auth for /mcp/*
  deviceToken?: string; // shared device -> gateway auth at WS connect (fallback)
  deviceTokens?: Map<string, string>; // per-device token map (preferred over deviceToken)
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
  DEVICE_TOKENS?: string; // JSON map { deviceId: token } - per-device secrets (secret)
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
  SSE_IDLE_TIMEOUT_MS?: string; // close an SSE session after this long idle (default 120s)
  MAX_SSE_SESSIONS?: string; // cap concurrent SSE streams per device (default 32)
  IDLE_TIMEOUT_MS?: string;
  ONLINE_TTL_MS?: string; // registry online-entry lifetime (default 150s)
  REGISTRY_REFRESH_MS?: string; // device -> registry re-register cadence (default 30s)
  ENVIRONMENT?: string;
  // Virtual (in-process) devices: ids handled by the gateway itself instead of
  // a WebSocket tunnel (see src/cloud-device.ts). VIRTUAL_DEVICE_IDS is a
  // comma-separated var; VIRTUAL_DEVICE_TOKENS is a JSON map { id: token } that
  // the RegistryDO merges into the device registry.
  VIRTUAL_DEVICE_IDS?: string;
  VIRTUAL_DEVICE_TOKENS?: string;
  // Optional Cloud-service bindings for the cloud device tools.
  DB?: D1Database;
  KV?: KVNamespace;
  // The coding sandbox container (CodingSandbox DO) - shell/fs/jobs tools.
  CODING_SANDBOX: DurableObjectNamespace;
  DEVICES: DurableObjectNamespace;
  REGISTRY: DurableObjectNamespace;
}

function num(env: Env, key: string, def: number): number {
  const raw = (env as unknown as Record<string, string | undefined>)[key];
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function parseDeviceTokens(raw: string | undefined): Map<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const m = new Map<string, string>();
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && validDeviceId(k) && v.length > 0) m.set(k, v);
    }
    return m.size ? m : undefined;
  } catch {
    return undefined;
  }
}

export function loadConfig(env: Env): GatewayConfig {
  return {
    gatewayToken: env.GATEWAY_TOKEN || undefined,
    deviceToken: env.DEVICE_TOKEN || undefined,
    deviceTokens: parseDeviceTokens(env.DEVICE_TOKENS),
    adminToken: env.ADMIN_TOKEN || env.GATEWAY_TOKEN || undefined,
    rateWindowMs: num(env, "RATE_LIMIT_WINDOW_MS", 60_000),
    rateMax: num(env, "RATE_LIMIT_MAX", 100),
    timeoutMs: num(env, "TIMEOUT_MS", 300_000),
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

// Parse the VIRTUAL_DEVICE_IDS var into a set of valid device ids.
export function virtualDeviceIds(env: Env): Set<string> {
  const out = new Set<string>();
  for (const part of (env.VIRTUAL_DEVICE_IDS || "").split(",")) {
    const id = part.trim();
    if (validDeviceId(id)) out.add(id);
  }
  return out;
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

// Device credential: prefers X-Device-Token header, then ?token=, then
// Authorization Bearer, then ?auth=. The extension sends ?token= on /mcp and
// (after the client update) on /ws; the relay header is the canonical form.
export function extractDeviceToken(req: Request, url: URL): string | null {
  const h = req.headers.get("x-device-token");
  if (h) return h.trim();
  const t = url.searchParams.get("token");
  if (t) return t;
  return extractToken(req, url, "auth");
}

// Resolve the expected token for a device: per-device map first, then shared.
export function deviceTokenFor(cfg: GatewayConfig, deviceId: string): string | undefined {
  if (cfg.deviceTokens && cfg.deviceTokens.has(deviceId)) return cfg.deviceTokens.get(deviceId);
  return cfg.deviceToken;
}

// In per-device mode (map configured) an id NOT in the map must be rejected -
// otherwise an attacker could distinguish configured ids (401) from unknown
// ids (503), an existence oracle. Returns true when the id is authorized to
// exist at all (i.e. auth should be enforced, not skipped).
export function deviceKnown(cfg: GatewayConfig, deviceId: string): boolean {
  if (cfg.deviceTokens && cfg.deviceTokens.size > 0) return cfg.deviceTokens.has(deviceId);
  return true; // shared-token or open mode: any valid-format id is allowed
}
