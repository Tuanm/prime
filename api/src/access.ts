// Defence in depth for /admin: Cloudflare Access sits in front of it, but the
// Worker checks the Access JWT itself, so deleting or misconfiguring the Access
// application cannot expose the admin API - it closes it instead.
//
// The JWT is signed by the team's Access keys (RS256); it is verified against
// the team's published certificate set and its audience must be the admin
// application's AUD tag.

export interface AccessConfig {
  /** e.g. "tuanm.cloudflareaccess.com" - the Access team domain. */
  team: string;
  /** The Access application's Audience (AUD) tag. */
  aud: string;
  /** Test seam: the certificate set, instead of fetching it. */
  certs?: () => Promise<{ keys: Jwk[] }>;
}

type Jwk = JsonWebKey & { kid?: string };

export type AccessVerdict = { ok: true; email?: string; commonName?: string } | { ok: false; reason: string };

/** Who an accepted assertion names, as the fleet's record puts it: a person's email, or a service token's name. */
export function actorOf(verdict: { email?: string; commonName?: string }): string | undefined {
  if (verdict.email) return "access:" + verdict.email.toLowerCase();
  if (verdict.commonName) return "access:service:" + verdict.commonName;
  return undefined;
}

let certCache: { team: string; at: number; keys: Jwk[] } | null = null;
let certFailure: { team: string; at: number; message: string } | null = null;
let lastRefetch = 0;
const CERT_TTL_MS = 60 * 60_000;
// A key the cache does not have means Cloudflare has rotated: fetch the set again, but no oftener than this, so
// that tokens with made-up key ids cannot make a subrequest each.
const CERT_REFETCH_MS = 60_000;
// A failed fetch is remembered this long, so an outage (or a wrong team name) is not retried by every request.
const CERT_FAILURE_MS = 30_000;

async function teamCerts(team: string, refresh = false): Promise<Jwk[]> {
  const now = Date.now();
  if (!refresh && certCache && certCache.team === team && now - certCache.at < CERT_TTL_MS) return certCache.keys;
  if (certFailure && certFailure.team === team && now - certFailure.at < CERT_FAILURE_MS) throw new Error(certFailure.message);
  try {
    const r = await fetch("https://" + team + "/cdn-cgi/access/certs", { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error("could not fetch Access certificates (HTTP " + r.status + ")");
    const body = (await r.json()) as { keys?: Jwk[] };
    const keys = Array.isArray(body.keys) ? body.keys : [];
    if (!keys.length) throw new Error("the Access certificate set is empty");
    certCache = { team, at: now, keys };
    certFailure = null;
    return keys;
  } catch (err) {
    certFailure = { team, at: now, message: err instanceof Error ? err.message : "certificates unavailable" };
    throw err;
  }
}

function b64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function jsonPart(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(value))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The Access assertion a request carries: the header Access adds, or its cookie. */
export function accessToken(request: Request): string | null {
  const header = request.headers.get("cf-access-jwt-assertion");
  if (header && header.trim()) return header.trim();
  const cookies = request.headers.get("cookie") || "";
  for (const part of cookies.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === "CF_Authorization") return part.slice(eq + 1).trim();
  }
  return null;
}

export async function verifyAccessJwt(request: Request, config: AccessConfig, now = Date.now()): Promise<AccessVerdict> {
  const token = accessToken(request);
  if (!token) return { ok: false, reason: "no Access token" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };
  const header = jsonPart(parts[0]);
  const payload = jsonPart(parts[1]);
  if (!header || !payload) return { ok: false, reason: "malformed token" };
  if (header.alg !== "RS256") return { ok: false, reason: "unexpected algorithm " + String(header.alg) };

  let keys: Jwk[];
  try {
    keys = config.certs ? (await config.certs()).keys : await teamCerts(config.team);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "certificates unavailable" };
  }
  let candidates = keys.filter((k) => !header.kid || k.kid === header.kid);
  if (!candidates.length && !config.certs && Date.now() - lastRefetch >= CERT_REFETCH_MS) {
    lastRefetch = Date.now();
    try {
      candidates = (await teamCerts(config.team, true)).filter((k) => !header.kid || k.kid === header.kid);
    } catch {
      // the set we had stands, and has no such key
    }
  }
  if (!candidates.length) return { ok: false, reason: "no key matches the token" };

  const data = new TextEncoder().encode(parts[0] + "." + parts[1]);
  const signature = b64urlToBytes(parts[2]);
  let verified = false;
  for (const jwk of candidates) {
    try {
      const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      if (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature as BufferSource, data as BufferSource)) {
        verified = true;
        break;
      }
    } catch {
      // Try the next key.
    }
  }
  if (!verified) return { ok: false, reason: "bad signature" };

  const iss = typeof payload.iss === "string" ? payload.iss : "";
  if (iss !== "https://" + config.team) return { ok: false, reason: "wrong issuer" };
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(config.aud)) return { ok: false, reason: "wrong audience" };
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  const nbf = typeof payload.nbf === "number" ? payload.nbf : 0;
  const LEEWAY_S = 60;
  if (exp * 1000 + LEEWAY_S * 1000 < now) return { ok: false, reason: "expired" };
  if (nbf && nbf * 1000 - LEEWAY_S * 1000 > now) return { ok: false, reason: "not valid yet" };
  const email = typeof payload.email === "string" && payload.email ? payload.email : undefined;
  const commonName = typeof payload.common_name === "string" && /^[\x21-\x7e]{1,128}$/.test(payload.common_name) ? payload.common_name : undefined;
  return { ok: true, email, commonName };
}

/** Whether an identity may operate: any, when no list is set; otherwise only a listed email (compared in lower case). */
export function emailAllowed(allowed: readonly string[] | undefined, email: string | undefined): boolean {
  if (!allowed || allowed.length === 0) return true;
  return !!email && allowed.includes(email.toLowerCase());
}

/**
 * The Access assertion a command-line operator presents as `cf-access-token` (what `cloudflared access token`
 * prints), checked like the admin page's. It is the header only, never the cookie: a browser sends a cookie on its
 * own, a header it has to be told to send.
 */
export async function verifyOperatorToken(request: Request, config: AccessConfig, now = Date.now()): Promise<AccessVerdict | null> {
  const token = request.headers.get("cf-access-token")?.trim();
  if (!token) return null;
  return verifyAccessJwt(new Request(request.url, { headers: { "cf-access-jwt-assertion": token } }), config, now);
}

/**
 * The headers of a request, for passing on to a Durable Object. The object is told who is acting, and what the
 * client's address is, by headers the Worker sets itself, so none the caller sent may reach it (x-prime-*,
 * x-client-ip, x-anon-rate-*), nor the Access assertion or the browser's cookies.
 *
 * The caller's own credential for the device (`authorization`, `x-device-token`) is dropped too, unless the object
 * itself checks it again: a device's tunnel upgrade does, as defence in depth, and falls back to these when the
 * Worker sets no x-auth-token.
 */
export function forwardableHeaders(headers: Headers, opts: { keepDeviceCredential?: boolean } = {}): Headers {
  const out = new Headers(headers);
  const names: string[] = [];
  out.forEach((_value, name) => names.push(name));
  for (const name of names) {
    if (
      name.startsWith("x-prime-") ||
      name.startsWith("cf-access-") ||
      name.startsWith("x-anon-rate-") ||
      name === "x-client-ip" ||
      name === "cookie" ||
      (!opts.keepDeviceCredential && (name === "authorization" || name === "x-device-token"))
    ) {
      out.delete(name);
    }
  }
  return out;
}
