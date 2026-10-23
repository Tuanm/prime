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

export type AccessVerdict = { ok: true; email?: string } | { ok: false; reason: string };

let certCache: { team: string; at: number; keys: Jwk[] } | null = null;
const CERT_TTL_MS = 60 * 60_000;

async function teamCerts(team: string): Promise<Jwk[]> {
  if (certCache && certCache.team === team && Date.now() - certCache.at < CERT_TTL_MS) return certCache.keys;
  const r = await fetch("https://" + team + "/cdn-cgi/access/certs", { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error("could not fetch Access certificates (HTTP " + r.status + ")");
  const body = (await r.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  if (!keys.length) throw new Error("the Access certificate set is empty");
  certCache = { team, at: Date.now(), keys };
  return keys;
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
  const candidates = keys.filter((k) => !header.kid || k.kid === header.kid);
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
  const email = typeof payload.email === "string" ? payload.email : undefined;
  return { ok: true, email };
}
