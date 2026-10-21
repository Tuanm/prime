// A browser session for the pages: the device/token pair is typed into the
// page's own dialog, checked once, and kept in an HttpOnly SameSite=Strict
// cookie - so the page reloads authenticated without the browser's Basic-auth
// prompt, and no credential ends up in a URL or in page storage.

export const SESSION_COOKIE = "mcp_device";
export const SESSION_MAX_AGE_S = 60 * 60;

function b64urlEncode(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return atob(padded);
}

export function encodeSession(deviceId: string, token: string): string {
  return b64urlEncode(deviceId + ":" + token);
}

export function decodeSession(value: string): { deviceId: string; token: string } | null {
  try {
    const raw = b64urlDecode(value);
    const at = raw.indexOf(":");
    if (at <= 0) return null;
    const deviceId = raw.slice(0, at);
    const token = raw.slice(at + 1);
    return deviceId && token ? { deviceId, token } : null;
  } catch {
    return null;
  }
}

/** The Cookie header of a request, as a name -> value map. */
export function cookies(request: Request): Map<string, string> {
  const out = new Map<string, string>();
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name) out.set(name, part.slice(eq + 1).trim());
  }
  return out;
}

export function sessionFrom(request: Request): { deviceId: string; token: string } | null {
  const value = cookies(request).get(SESSION_COOKIE);
  return value ? decodeSession(value) : null;
}

export function sessionCookie(deviceId: string, token: string, secure: boolean, path = "/"): string {
  return [
    SESSION_COOKIE + "=" + encodeSession(deviceId, token),
    "Path=" + path,
    "Max-Age=" + SESSION_MAX_AGE_S,
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearSessionCookie(secure: boolean, path = "/"): string {
  return [SESSION_COOKIE + "=", "Path=" + path, "Max-Age=0", "HttpOnly", "SameSite=Strict", ...(secure ? ["Secure"] : [])].join("; ");
}
