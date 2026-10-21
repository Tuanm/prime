// Temporary file storage: REST API under /api/files and the HTML pages under
// /files. Routed here from src/index.ts so the entry point stays readable.
//
// Contents live in R2; metadata and quotas live in a per-device FilesDO. Uploads
// are streamed straight from the request body into R2 - a 200 MiB file is never
// buffered in the isolate (which has a 128 MB memory limit).
//
// Auth is HTTP Basic with (deviceId, token), where both come from the device
// registry the admin UI writes. That is the same credential the device uses at
// /ws, so there is no second secret to distribute.

import type { Env, GatewayConfig } from "./config";
import { fileLimits, validDeviceId, validFileId } from "./config";
import type { FileRecord, FileUsage } from "./files-do";
import { renderDownloadPage, renderFilesPage, type FileView } from "./files-ui";
import { clientIp, type RateLimiter } from "./rate-limit";
import { timingSafeEq } from "./config";
import { effectiveDisabledSet } from "./device-state";
import { gateResponse } from "./gate-ui";
import { clearSessionCookie, sessionCookie, sessionFrom } from "./session";

const NO_STORE = { "cache-control": "no-store" } as const;

/** 401 with a browser-friendly challenge so the page can prompt for Basic auth. */
function unauthorized(realm = "Code MCP Gateway files"): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "www-authenticate": `Basic realm="${realm}", charset="UTF-8"`,
      ...NO_STORE,
    },
  });
}

function jsonError(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error, ...extra }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...NO_STORE },
  });
}

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...NO_STORE },
  });
}

/** Decode `Authorization: Basic base64(deviceId:token)`. */
export function parseBasicAuth(request: Request): { deviceId: string; token: string } | undefined {
  const header = request.headers.get("authorization");
  if (!header) return undefined;
  const match = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!match) return undefined;
  let decoded: string;
  try {
    decoded = atob(match[1]!.trim());
  } catch {
    return undefined;
  }
  const colon = decoded.indexOf(":");
  if (colon <= 0) return undefined;
  return { deviceId: decoded.slice(0, colon), token: decoded.slice(colon + 1) };
}

export interface DeviceAuth {
  deviceId: string;
}

// The registry is a Durable Object, so resolving the device map costs a
// round trip. File requests are chatty (a page load plus one request per
// action), so cache it briefly per isolate - the same 2s TTL the MCP relay uses.
let mapCache: { at: number; map: Map<string, string> } | null = null;
const MAP_CACHE_TTL_MS = 2_000;

async function deviceMap(env: Env): Promise<Map<string, string>> {
  if (mapCache && Date.now() - mapCache.at < MAP_CACHE_TTL_MS) return mapCache.map;
  const map = new Map<string, string>();
  try {
    const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
    const response = await reg.fetch("https://registry/map");
    if (response.ok) {
      const body = (await response.json()) as { map?: Record<string, string>; anonymous?: string[] };
      // File storage is for admin-registered devices: an anonymous device costs
      // nothing to create, so letting it hold files would make the R2 budget
      // anyone's to spend.
      const anonymous = new Set(body.anonymous ?? []);
      for (const [id, token] of Object.entries(body.map ?? {})) {
        if (typeof token === "string" && token.length > 0 && !anonymous.has(id)) map.set(id, token);
      }
    }
  } catch {}
  mapCache = { at: Date.now(), map };
  return map;
}

/**
 * Authenticate a request as a registered device.
 *
 * Accepts Basic auth (what the pages use, and what the browser replays
 * automatically on same-origin fetches) or an explicit
 * `X-Device-Id` + `X-Device-Token` header pair for scripts.
 */
export async function authorizeDevice(env: Env, request: Request): Promise<DeviceAuth | Response> {
  const basic = parseBasicAuth(request);
  const headerId = request.headers.get("x-device-id");
  const headerToken = request.headers.get("x-device-token");
  // The pages sign in through their own dialog, which leaves a cookie.
  const session = basic || (headerId && headerToken) ? null : sessionFrom(request);

  const deviceId = basic?.deviceId ?? headerId ?? session?.deviceId ?? "";
  const token = basic?.token ?? headerToken ?? session?.token ?? "";
  if (!validDeviceId(deviceId)) return unauthorized();
  if (!token) return unauthorized();

  const expected = (await deviceMap(env)).get(deviceId);
  // No registry entry means the device is not registered via /admin: refuse
  // rather than falling back to any shared token, so file access always
  // requires a real per-device credential.
  if (expected === undefined) return unauthorized();
  if (!timingSafeEq(token, expected)) return unauthorized();
  // Deactivated devices are cut off everywhere, not just at the MCP relay: the
  // pages, the files API and WebSocket tickets all use this credential.
  if ((await effectiveDisabledSet(env)).has(deviceId)) {
    return new Response(JSON.stringify({ error: "device disabled" }), {
      status: 403,
      headers: { "content-type": "application/json; charset=utf-8", ...NO_STORE },
    });
  }

  return { deviceId };
}

function filesStub(env: Env, deviceId: string): DurableObjectStub {
  return env.FILES.get(env.FILES.idFromName(deviceId));
}

async function doJson(stub: DurableObjectStub, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await stub.fetch("https://files" + path, init);
  let body: any = {};
  try {
    body = await response.json();
  } catch {}
  return { status: response.status, body };
}

/** Parse the requested lifetime, defaulting to the maximum. */
export function parseExpiry(
  url: URL,
  limits: { maxExpiryMs: number },
  now: number,
): number | { error: string; [extra: string]: unknown } {
  const days = url.searchParams.get("expiry_days");
  const seconds = url.searchParams.get("expires_in");
  const ms = url.searchParams.get("expiry_ms");
  let lifetime: number | undefined;

  if (days !== null) {
    const value = Number(days);
    if (!Number.isFinite(value) || value <= 0) return { error: "expiry_days must be a positive number" };
    lifetime = value * 24 * 60 * 60 * 1000;
  } else if (seconds !== null) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) return { error: "expires_in must be a positive number of seconds" };
    lifetime = value * 1000;
  } else if (ms !== null) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value <= 0) return { error: "expiry_ms must be a positive number" };
    lifetime = value;
  } else {
    lifetime = limits.maxExpiryMs; // default: the longest allowed
  }

  if (lifetime > limits.maxExpiryMs) return { error: "expiry exceeds the maximum", limit_ms: limits.maxExpiryMs };
  return now + lifetime;
}

/**
 * Header that carries a protected file's key on `GET /api/files/{id}`.
 *
 * Deliberately a header and not a query parameter: a URL lands in access logs,
 * browser history, and `Referer` headers, so a secret in one is a secret
 * disclosed. The human-facing page still accepts `?key=` because a browser
 * navigation cannot set a request header - and it then replays the key to the
 * API as this header rather than putting it back in a URL.
 */
export const FILE_KEY_HEADER = "X-File-Key";

/**
 * The same view with the raw key stripped.
 *
 * Pages embed their data, so a view that still carried the key would put the
 * secret in the HTML of a page whose whole job is to keep it out of the URL.
 * Nothing on a page needs to read the key back - the prompt collects it, and the
 * owner's own credentials authorise them.
 */
function pageView(view: FileView): FileView {
  const stripped = { ...view };
  delete stripped.key;
  return stripped;
}

function fileView(record: FileRecord, origin: string): FileView {
  const downloadPath = `/api/files/${record.id}`;
  return {
    id: record.id,
    name: record.name,
    size: record.size,
    content_type: record.contentType,
    created_at: new Date(record.createdAt).toISOString(),
    expires_at: new Date(record.expiresAt).toISOString(),
    expires_in_ms: Math.max(0, record.expiresAt - Date.now()),
    status: record.status,
    protected: Boolean(record.key),
    ...(record.key ? { key: record.key, key_header: FILE_KEY_HEADER } : {}),
    // Neither URL ever carries the key. The API one takes it as FILE_KEY_HEADER;
    // the page one takes it in the prompt. A link is for sharing - the key is
    // meant to travel separately, by whatever private channel the owner chooses.
    download_url: `${origin}${downloadPath}`,
    page_url: `${origin}/files/${record.id}`,
  };
}

export interface FilesRouteContext {
  request: Request;
  env: Env;
  url: URL;
  cfg: GatewayConfig;
  limiter: { allow(ip: string): boolean };
}

/**
 * Handle a file request, or return null when the path is not ours.
 */
export async function handleFiles(ctx: FilesRouteContext): Promise<Response | null> {
  const { request, env, url, cfg, limiter } = ctx;

  // ---- page sign-in ------------------------------------------------------
  // The pages no longer rely on the browser's Basic-auth prompt: the form posts
  // here, the pair is checked once, and an HttpOnly cookie carries it for the
  // session. Signing out clears it.
  if (url.pathname === "/api/session") {
    const secure = url.protocol === "https:";
    if (request.method === "DELETE") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json; charset=utf-8", "set-cookie": clearSessionCookie(secure), ...NO_STORE },
      });
    }
    if (request.method !== "POST") return jsonError(405, "method not allowed", { allow: "POST, DELETE" });
    if (!limiter.allow(clientIp(request))) return jsonError(429, "rate limited");
    let body: { device?: unknown; token?: unknown };
    try {
      body = (await request.json()) as { device?: unknown; token?: unknown };
    } catch {
      return jsonError(400, "invalid json");
    }
    const deviceId = typeof body.device === "string" ? body.device.trim() : "";
    const token = typeof body.token === "string" ? body.token : "";
    if (!validDeviceId(deviceId) || !token) return jsonError(401, "unauthorized");
    const expected = (await deviceMap(env)).get(deviceId);
    if (expected === undefined || !timingSafeEq(token, expected)) return jsonError(401, "unauthorized");
    if ((await effectiveDisabledSet(env)).has(deviceId)) return jsonError(403, "device disabled");
    return new Response(JSON.stringify({ ok: true, device: deviceId }), {
      headers: { "content-type": "application/json; charset=utf-8", "set-cookie": sessionCookie(deviceId, token, secure), ...NO_STORE },
    });
  }

  const isApi = url.pathname === "/api/files" || url.pathname.startsWith("/api/files/");
  const isPage = url.pathname === "/files" || url.pathname.startsWith("/files/");
  if (!isApi && !isPage) return null;

  // Storage is optional so the worker can deploy before R2 is enabled; say so
  // clearly instead of throwing.
  if (!env.BUCKET) {
    return isApi
      ? jsonError(503, "file storage is not configured", { hint: "Bind an R2 bucket as BUCKET (see gateway/README.md)." })
      : new Response(renderUnavailablePage(), {
          status: 503,
          headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE },
        });
  }

  if (isApi && !limiter.allow(clientIp(request))) {
    return jsonError(429, "rate limited");
  }

  const limits = fileLimits(env);
  const origin = url.origin;

  // ---- REST API ----------------------------------------------------------

  if (url.pathname === "/api/files") {
    if (request.method === "POST") {
      const auth = await authorizeDevice(env, request);
      if (auth instanceof Response) return auth;
      return uploadFile(request, env, url, auth.deviceId, limits, origin);
    }
    if (request.method === "GET") {
      const auth = await authorizeDevice(env, request);
      if (auth instanceof Response) return auth;
      const stub = filesStub(env, auth.deviceId);
      const { status, body } = await doJson(stub, "/list");
      if (status !== 200) return jsonError(status, body.error ?? "list failed");
      return jsonOk({
        files: (body.files as FileRecord[]).map((record) => fileView(record, origin)),
        usage: body.usage,
        budget: await budgetStatus(env),
        limits: {
          max_upload_bytes: limits.maxUploadBytes,
          max_expiry_ms: limits.maxExpiryMs,
          max_files: limits.maxPerDevice,
          max_total_bytes: limits.maxTotalBytes,
        },
      });
    }
    return jsonError(405, "method not allowed", { allow: "GET, POST" });
  }

  const apiId = url.pathname.startsWith("/api/files/") ? url.pathname.slice("/api/files/".length) : "";
  if (apiId) {
    if (!validFileId(apiId)) return jsonError(400, "invalid file id");
    if (request.method === "GET") return downloadFile(request, env, url, apiId, origin, false);
    if (request.method === "DELETE") {
      const auth = await authorizeDevice(env, request);
      if (auth instanceof Response) return auth;
      const stub = filesStub(env, auth.deviceId);
      // Only the owning device may delete: fetching through its own DO makes
      // that structural rather than a check that could be forgotten.
      const { body } = await doJson(stub, "/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: apiId }),
      });
      if (body.removed === true) await unindexFile(env, apiId);
      return jsonOk({ ok: true, removed: body.removed === true });
    }
    // Changing the protection key after the fact, so a file can be protected (or
    // unprotected) without re-uploading it. Routed through the owner's DO, like
    // DELETE, so only the owning device can do it.
    if (request.method === "PATCH") {
      const auth = await authorizeDevice(env, request);
      if (auth instanceof Response) return auth;
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return jsonError(400, "invalid json");
      }
      const raw = body.key === undefined || body.key === null ? "" : String(body.key);
      if (raw.length > 256) return jsonError(400, "key too long");
      const stub = filesStub(env, auth.deviceId);
      const { status, body: updated } = await doJson(stub, "/set-key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: apiId, key: raw }),
      });
      if (status !== 200) return jsonError(status, updated.error ?? "update failed");
      return jsonOk({ ok: true, file: fileView(updated.file as FileRecord, origin) });
    }
    return jsonError(405, "method not allowed", { allow: "GET, PATCH, DELETE" });
  }

  // ---- HTML pages --------------------------------------------------------

  if (url.pathname === "/files") {
    const auth = await authorizeDevice(env, request);
    if (auth instanceof Response) {
      // Nothing of the page is sent before the pair checks out: just the form.
      const error = auth.status === 403 ? ((await auth.json().catch(() => ({}))) as { error?: string }).error : undefined;
      return gateResponse({ request, title: "Files", device: null, next: url.pathname, error });
    }
    const stub = filesStub(env, auth.deviceId);
    const { body } = await doJson(stub, "/list");
    const files = ((body.files ?? []) as FileRecord[]).map((record) => pageView(fileView(record, origin)));
    return html(
      renderFilesPage({
        deviceId: auth.deviceId,
        files,
        usage: body.usage as FileUsage,
        limits,
        budget: await budgetStatus(env),
      }),
    );
  }

  const pageId = url.pathname.slice("/files/".length);
  if (pageId) {
    if (!validFileId(pageId)) return new Response("not found", { status: 404, headers: NO_STORE });
    return downloadFile(request, env, url, pageId, origin, true);
  }

  return null;
}

// ---- upload ---------------------------------------------------------------

async function uploadFile(
  request: Request,
  env: Env,
  url: URL,
  deviceId: string,
  limits: ReturnType<typeof fileLimits>,
  origin: string,
): Promise<Response> {
  const name = url.searchParams.get("name") ?? url.searchParams.get("filename") ?? "";
  if (!name.trim()) return jsonError(400, "missing ?name=<filename>");

  const now = Date.now();
  const expiry = parseExpiry(url, limits, now);
  if (typeof expiry !== "number") return jsonError(400, expiry.error, expiry);

  const declaredRaw = request.headers.get("content-length");
  const declared = declaredRaw === null ? Number.NaN : Number(declaredRaw);
  if (Number.isFinite(declared) && declared > limits.maxUploadBytes) {
    return jsonError(413, "file too large", { limit_bytes: limits.maxUploadBytes, size: declared });
  }
  if (!request.body || declared === 0) return jsonError(400, "empty request body");

  // Reserve the declared size against the account's monthly R2 budget before a
  // single byte is stored, then reconcile with the real size once it is written.
  const admitted = Number.isFinite(declared) ? declared : 0;
  const overBudget = await budgetAdmit(env, admitted, 1);
  if (overBudget) return overBudget;

  // The protection key may arrive as the X-File-Key header, which is preferred: a
  // query string is written to access logs. ?key= still works for existing
  // clients. Setting it here, at creation, matters - protecting a file with a
  // follow-up PATCH would leave a window in which it is publicly linkable.
  const headerKey = request.headers.get(FILE_KEY_HEADER.toLowerCase());
  const key = (headerKey !== null && headerKey !== "" ? headerKey : url.searchParams.get("key")) ?? undefined;
  const stub = filesStub(env, deviceId);
  const reserved = await doJson(stub, "/reserve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deviceId,
      name,
      size: Number.isFinite(declared) ? declared : 0,
      contentType: request.headers.get("content-type") ?? "application/octet-stream",
      expiresAt: expiry,
      key,
    }),
  });
  if (reserved.status !== 201) {
    await budgetRelease(env, admitted);
    return jsonError(reserved.status, reserved.body.error ?? "upload rejected", reserved.body);
  }
  const record = reserved.body.file as FileRecord;
  await indexFile(env, record);
  const objectKey = `${record.deviceId}/${record.id}`;

  const putOptions = {
    httpMetadata: { contentType: record.contentType },
    customMetadata: { deviceId, fileId: record.id, name: record.name },
  };

  let written = 0;
  try {
    written = Number.isFinite(declared)
      ? await putKnownLength(env.BUCKET!, objectKey, request.body, putOptions)
      : await putChunked(env.BUCKET!, objectKey, request.body, putOptions, limits.maxUploadBytes);
  } catch (err) {
    await doJson(stub, "/abort", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: record.id }),
    });
    await budgetRelease(env, admitted);
    if (err instanceof UploadTooLarge) {
      return jsonError(413, "file too large", { limit_bytes: limits.maxUploadBytes, size: err.size });
    }
    return jsonError(500, "upload failed", { detail: err instanceof Error ? err.message : String(err) });
  }

  // The body may have been shorter or longer than declared, so settle the
  // difference before the file counts as stored.
  if (written > admitted) {
    const over = await budgetAdmit(env, written - admitted, 0);
    if (over) {
      // Nothing may be stored that the budget did not admit, so undo all of it.
      try {
        await env.BUCKET!.delete(objectKey);
      } catch {}
      await doJson(stub, "/abort", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: record.id }),
      });
      await unindexFile(env, record.id);
      await budgetRelease(env, admitted);
      return over;
    }
  } else if (written < admitted) {
    await budgetRelease(env, admitted - written);
  }

  const completed = await doJson(stub, "/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: record.id, size: written }),
  });
  if (completed.status !== 200) {
    return jsonError(completed.status, completed.body.error ?? "upload rejected", completed.body);
  }

  return jsonOk({ ok: true, file: fileView(completed.body.file as FileRecord, origin) }, 201);
}

class UploadTooLarge extends Error {
  constructor(readonly size: number) {
    super("upload exceeds the size limit");
  }
}

/**
 * Stream a body of known length straight into R2.
 *
 * `bucket.put` accepts a ReadableStream only when its length is known, and the
 * incoming `request.body` is exactly that - so a 200 MiB upload is piped through
 * without ever being buffered (the isolate only has 128 MB of memory, so
 * buffering is not an option). Wrapping it in a TransformStream to count bytes -
 * the obvious way to guard the size - destroys that known length and R2 rejects
 * it, which is why the length check happens up front instead.
 */
async function putKnownLength(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream<Uint8Array>,
  options: R2PutOptions,
): Promise<number> {
  const object = await bucket.put(key, body, options);
  return object?.size ?? 0;
}

/** R2 requires every part but the last to be at least 5 MiB. */
const PART_SIZE = 5 * 1024 * 1024;

/**
 * Stream a body of *unknown* length (chunked transfer encoding) via a multipart
 * upload, buffering at most one part at a time and aborting as soon as the
 * running total passes the cap.
 */
async function putChunked(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream<Uint8Array>,
  options: R2PutOptions,
  maxBytes: number,
): Promise<number> {
  const upload = await bucket.createMultipartUpload(key, options);
  const parts: R2UploadedPart[] = [];
  const reader = body.getReader();
  let buffer = new Uint8Array(PART_SIZE);
  let filled = 0;
  let total = 0;
  let partNumber = 1;

  const flush = async (): Promise<void> => {
    // R2 rejects an empty part, so only send when there is something to send.
    if (filled === 0 && parts.length > 0) return;
    parts.push(await upload.uploadPart(partNumber++, buffer.slice(0, filled)));
    filled = 0;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new UploadTooLarge(total);
      let offset = 0;
      while (offset < value.byteLength) {
        const room = PART_SIZE - filled;
        const take = Math.min(room, value.byteLength - offset);
        buffer.set(value.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled === PART_SIZE) await flush();
      }
    }
    if (filled > 0 || parts.length === 0) await flush();
    const object = await upload.complete(parts);
    return object.size;
  } catch (err) {
    try {
      await upload.abort();
    } catch {}
    throw err;
  } finally {
    buffer = new Uint8Array(0);
  }
}

// ---- download -------------------------------------------------------------

async function downloadFile(
  request: Request,
  env: Env,
  url: URL,
  id: string,
  origin: string,
  asPage: boolean,
): Promise<Response> {
  // The DO is per device, so find the record by asking each candidate? No: the
  // id is globally unique, and the record carries its deviceId, so a light
  // lookup DO resolves it (see below).
  const lookup = await lookupRecord(env, id);
  if (!lookup) return asPage ? notFoundPage() : jsonError(404, "not found");
  const { record } = lookup;

  if (record.status !== "ready") return asPage ? notFoundPage() : jsonError(409, "upload not complete");
  if (Date.now() >= record.expiresAt) return asPage ? notFoundPage() : jsonError(410, "file expired");

  const owner = await authorizeDevice(env, request);
  const ownerOk = !(owner instanceof Response) && owner.deviceId === record.deviceId;
  const headerKey = request.headers.get(FILE_KEY_HEADER.toLowerCase()) ?? "";

  if (asPage) {
    // The page never takes a key from its URL: a link is shareable, the key is
    // not, so the owner sends it separately and the visitor types it into the
    // prompt. Anyone but the owner gets that prompt, always.
    const authorised = !record.key || ownerOk;
    return html(
      renderDownloadPage({
        file: pageView(fileView(record, origin)),
        protectedFile: Boolean(record.key),
        authorised,
      }),
    );
  }

  // The REST API accepts the key ONLY as a header, never from the query string.
  if (record.key && !ownerOk && !timingSafeEq(headerKey, record.key)) {
    return new Response(JSON.stringify({ error: "unauthorized", hint: `send the file key in the ${FILE_KEY_HEADER} header` }), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8", ...NO_STORE },
    });
  }

  // Only ask R2 for a range when the client sent one: R2 (and miniflare) report
  // a full-object range otherwise, which would turn every download into a 206.
  const rangeHeader = request.headers.get("range");
  const object = await env.BUCKET!.get(
    `${record.deviceId}/${record.id}`,
    rangeHeader ? { range: request.headers } : undefined,
  );
  if (!object) return jsonError(404, "not found");

  budgetReads(env, 1);

  const headers = new Headers();
  headers.set("content-type", record.contentType || "application/octet-stream");
  headers.set("cache-control", "private, no-store");
  // An uploaded file is attacker-supplied bytes: never let a browser sniff it
  // into something renderable, and never leak the page URL onward.
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set(
    "content-disposition",
    `attachment; filename="${record.name.replace(/[\r\n"\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(record.name)}`,
  );
  headers.set("accept-ranges", "bytes");
  headers.set("etag", object.httpEtag);
  if (rangeHeader && object.range) {
    const range = object.range as { offset: number; length?: number };
    const length = range.length ?? Math.max(0, object.size - range.offset);
    headers.set("content-range", `bytes ${range.offset}-${range.offset + length - 1}/${record.size}`);
    headers.set("content-length", String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("content-length", String(object.size));
  return new Response(object.body, { status: 200, headers });
}

/**
 * Find a record by file id without knowing its device.
 *
 * A download URL carries only the id, while the metadata lives in the per-device
 * DO, so the global registry keeps an id -> device index. The index entry expires
 * with its file, so a stale id resolves to nothing instead of lingering.
 */
// A file's owner never changes, so the id -> device hop is cacheable. This
// matters for resumed downloads, which issue one request per Range, and it
// halves the Durable Object round trips per download (index + device).
const ownerCache = new Map<string, { deviceId: string; at: number }>();
const OWNER_CACHE_TTL_MS = 60_000;
const OWNER_CACHE_MAX = 500;

function rememberOwner(id: string, deviceId: string, now: number): void {
  for (const [key, entry] of ownerCache) {
    if (now - entry.at > OWNER_CACHE_TTL_MS) ownerCache.delete(key);
  }
  // Bounded: ids come from URLs, so an unbounded map would be a memory leak.
  while (ownerCache.size >= OWNER_CACHE_MAX) {
    const oldest = ownerCache.keys().next().value;
    if (oldest === undefined) break;
    ownerCache.delete(oldest);
  }
  ownerCache.set(id, { deviceId, at: now });
}

async function lookupRecord(env: Env, id: string): Promise<{ record: FileRecord } | null> {
  const now = Date.now();
  let deviceId = ownerCache.get(id)?.deviceId;
  if (deviceId === undefined) {
    const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
    const found = await doJson(reg, `/file-lookup?id=${encodeURIComponent(id)}`);
    if (found.status !== 200 || !found.body.deviceId) return null;
    deviceId = String(found.body.deviceId);
    rememberOwner(id, deviceId, now);
  }

  const stub = filesStub(env, deviceId);
  const record = await doJson(stub, `/get?id=${encodeURIComponent(id)}`);
  if (record.status !== 200) {
    // Deleted or expired: forget the owner so a later lookup asks again.
    ownerCache.delete(id);
    return null;
  }
  return { record: record.body.file as FileRecord };
}

/** Record id -> device in the global index so downloads can resolve it. */
/**
 * Reserve R2 usage against the account's monthly budget.
 *
 * Returns a 507 Response when this upload would push the month past the cap, or
 * null to proceed. A registry hiccup lets the upload through: the per-device
 * caps still bound it, and failing closed would break uploads for everyone if
 * one Durable Object blinks.
 */
async function budgetAdmit(env: Env, bytes: number, classA: number): Promise<Response | null> {
  try {
    const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
    const res = await reg.fetch("https://registry/budget/admit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bytes, classA }),
    });
    if (res.ok) return null;
    const body = await res.json().catch(() => ({}));
    return Response.json(body, { status: res.status });
  } catch {
    return null;
  }
}

/** Give reserved bytes back when an upload does not become a stored file. */
async function budgetRelease(env: Env, bytes: number): Promise<void> {
  if (bytes <= 0) return;
  try {
    const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
    await reg.fetch("https://registry/budget/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bytes }),
    });
  } catch {}
}

/** Record read operations. Not awaited: it must not slow a download down. */
function budgetReads(env: Env, classB: number): void {
  try {
    const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
    void reg.fetch("https://registry/budget/ops", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ classB }),
    });
  } catch {}
}

/** The month's R2 spend so far, for the API response and the page. */
async function budgetStatus(env: Env): Promise<Record<string, unknown> | null> {
  try {
    const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
    const res = await reg.fetch("https://registry/budget");
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function indexFile(env: Env, record: FileRecord): Promise<void> {
  try {
    const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
    await reg.fetch("https://registry/file-index", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileId: record.id, deviceId: record.deviceId, expiresAt: record.expiresAt }),
    });
  } catch {}
}

async function unindexFile(env: Env, id: string): Promise<void> {
  try {
    const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
    await reg.fetch("https://registry/file-unindex", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileId: id }),
    });
  } catch {}
}

// ---- small helpers --------------------------------------------------------

function html(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The page URL can carry ?key=..., so it must not travel as a Referer.
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...NO_STORE,
    },
  });
}

function notFoundPage(): Response {
  return new Response(renderDownloadPage({ file: null }), {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE },
  });
}

function renderUnavailablePage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Files</title></head>
<body style="font-family:ui-monospace,Menlo,monospace;margin:48px">
<h1 style="font-size:20px">Files</h1>
<p style="color:#b91c1c">File storage is not configured on this gateway.</p>
<p style="color:#666;font-size:12px">Bind an R2 bucket as BUCKET to enable uploads.</p>
</body></html>`;
}

export { filesStub, doJson };
export type { FileUsage };

