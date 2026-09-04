// DeviceDO - one Durable Object instance per deviceId.
//
// WHY Durable Objects: a Cloudflare Worker runs many isolates with no shared
// memory. A device's WebSocket is pinned to the isolate that accepted it, so a
// plain-Worker design would fail to find the socket when an HTTP /mcp request
// lands on a different isolate. Durable Objects give every deviceId a
// deterministic, single instance (idFromName(deviceId)) that owns BOTH the
// WebSocket AND the pending-request registry - so every /mcp and /ws request
// routes to the same colocated object. This is the canonical Cloudflare pattern
// for stateful WebSocket servers (see workers-chat-demo).
//
// WebSocket Hibernation: state.acceptWebSocket() lets the DO hibernate when
// idle (free), waking on messages - ideal for a fleet of long-lived device
// tunnels. Pending HTTP requests keep the object alive while awaiting the
// device reply, so setTimeout for the request timeout is safe.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./config";
import { validDeviceId, timingSafeEq, extractToken } from "./config";
import type { TunnelRequest, TunnelMessage } from "./protocol";

// Per-device token lookup (parsed once per DO instance).
function perDeviceToken(env: Env, deviceId: string): string | undefined {
  const raw = env.DEVICE_TOKENS;
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const v = obj[deviceId];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

type PendingEntry =
  | { kind: "http"; deviceId: string; resolve: (res: Response) => void; timer: ReturnType<typeof setTimeout> }
  | { kind: "sse"; deviceId: string; sessionId: string; clientId: unknown; timer: ReturnType<typeof setTimeout> };

interface SseSession {
  sessionId: string;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  timer: ReturnType<typeof setTimeout> | null;
  inbound: number;
}

const CLIENT_TTL_MS = 600_000; // relay clients shown for the last 10 min
const MAX_TRACKED_CLIENTS = 2_000; // cap distinct relay-client IPs (memory guard)
const SSE_IDLE_TIMEOUT_MS = 120_000; // close an SSE session with no activity (stream-spam guard)
const MAX_SSE_SESSIONS = 32; // cap concurrent SSE streams per device (memory guard)

export class DeviceDO extends DurableObject<Env> {
  private ws: WebSocket | null = null;
  private lastRegistryAt = 0; // last time we refreshed the registry online marker
  private clients = new Map<string, { ip: string; name?: string; lastSeen: number; count: number }>();
  private pending = new Map<string, PendingEntry>();
  private lastSeen = 0;
  private keepaliveTimeoutMs = 90_000;
  private maxPending = 100;
  private timeoutMs = 30_000;
  private maxBodyBytes = 1024 * 1024;
  private sseSessions = new Map<string, SseSession>();
  private sseIdleTimeoutMs = SSE_IDLE_TIMEOUT_MS;
  private maxSseSessions = MAX_SSE_SESSIONS;
  private deviceToken?: string;
  private perDeviceToken: string | null = null;
  private deviceId = "";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Restore configuration (env bindings are stable across hibernation).
    this.keepaliveTimeoutMs = num(env.KEEPALIVE_TIMEOUT_MS, 90_000);
    this.maxPending = num(env.MAX_PENDING_PER_DEVICE, 100);
    this.timeoutMs = num(env.TIMEOUT_MS, 30_000);
    this.maxBodyBytes = num(env.MAX_BODY_BYTES, 1024 * 1024);
    this.sseIdleTimeoutMs = num(env.SSE_IDLE_TIMEOUT_MS, SSE_IDLE_TIMEOUT_MS);
    this.maxSseSessions = num(env.MAX_SSE_SESSIONS, MAX_SSE_SESSIONS);
    this.deviceToken = env.DEVICE_TOKEN || undefined;
    this.perDeviceToken = null;
    // Restore a live WebSocket after hibernation wake: class fields are reset
    // when the object is thawed, so re-attach from ctx.getWebSockets().
    const sockets = this.ctx.getWebSockets();
    if (sockets.length > 0) {
      this.ws = sockets[0];
      const meta = this.ws.deserializeAttachment?.() as
        | { deviceId?: string; lastSeen?: number }
        | undefined;
      if (meta?.deviceId) this.deviceId = meta.deviceId;
      if (meta?.lastSeen) this.lastSeen = meta.lastSeen;
    }
  }

  // ---- fetch(): all requests for this deviceId route here ----------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Internal device auth + identity: the worker entry sets these headers so
    // the DO can enforce per-device auth and know which device it is without
    // trusting the path (the DO id is the device, but keep it explicit).
    this.deviceId = request.headers.get("x-device-id") || url.searchParams.get("deviceId") || "";
    const authToken =
      request.headers.get("x-auth-token") || extractToken(request, url, "auth");

    // WebSocket upgrade: /ws (device tunnel)
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.handleUpgrade(request, url, authToken);
    }

    // HTTP relay: POST /mcp (JSON-RPC body)
    if (request.method === "POST" && (url.pathname === "/mcp" || url.pathname === "/")) {
      return this.handleMcp(request);
    }

    // SSE transport: GET /sse opens a server->client stream, POST /messages
    // carries client->server JSON-RPC. Both are reached from index.ts (which
    // rewrites /sse/{id} -> /sse and /messages/{id} -> /messages after auth).
    if (request.method === "GET" && url.pathname === "/sse") {
      return this.handleSse(request);
    }
    if (request.method === "POST" && url.pathname === "/messages") {
      return this.handleMessages(request);
    }

    // Admin: relay clients seen for this device (recent, TTL-swept).
    if (request.method === "GET" && url.pathname === "/clients") {
      const now = Date.now();
      const list: Array<{ ip: string; name?: string; lastSeen: number; count: number }> = [];
      for (const [key, c] of this.clients) {
        if (now - c.lastSeen > CLIENT_TTL_MS) this.clients.delete(key);
        else list.push(c);
      }
      list.sort((a, b) => b.lastSeen - a.lastSeen);
      return Response.json({ clients: list });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  }

  // ---- WebSocket lifecycle -------------------------------------------------

  private async handleUpgrade(request: Request, url: URL, authToken: string | null): Promise<Response> {
    // Device auth at connect time (defense in depth; the worker entry already
    // checked). The worker forwards the effective expected token (registry-
    // backed) as x-expected-token; fall back to the env-based per-device /
    // shared token when absent (legacy paths).
    const expectedHeader = request.headers.get("x-expected-token");
    if (this.deviceId) this.perDeviceToken = perDeviceToken(this.env, this.deviceId) ?? null;
    const expected = expectedHeader ?? this.perDeviceToken ?? this.deviceToken;
    if (expected && (!authToken || !timingSafeEq(authToken, expected))) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    // A deviceId may only have ONE live tunnel. If an existing ws is attached
    // (including after hibernation wake), reject the newcomer with 409 - the
    // same collision semantics as the Bun gateway.
    if (this.ws) {
      return Response.json({ error: "deviceId already in use" }, { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Hibernation API: the object can sleep between messages.
    this.ctx.acceptWebSocket(server);
    this.ws = server;
    this.lastSeen = Date.now();
    server.serializeAttachment({ deviceId: this.deviceId, lastSeen: this.lastSeen });

    // App-layer register ack (client expects {type:"registered"}).
    server.send(JSON.stringify({ type: "registered", deviceId: this.deviceId }));
    // Report to the global registry so /devices works across isolates.
    try {
      const reg = this.env.REGISTRY.get(this.env.REGISTRY.idFromName("global"));
      await reg.fetch(
        "https://registry/register?id=" + encodeURIComponent(this.deviceId),
        { method: "POST" },
      );
      this.lastRegistryAt = Date.now();
    } catch {}
    this.scheduleKeepaliveCheck();

    return new Response(null, { status: 101, webSocket: client });
  }

  // Hibernation callbacks -----------------------------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.lastSeen = Date.now();
    // The registry TTL-sweeps its online entries; re-register periodically so
    // a long-lived tunnel stays "online" in the admin UI (throttled - the
    // keepalive every 25s keeps this cheap).
    this.maybeRefreshRegistry();
    try {
      ws.serializeAttachment({ deviceId: this.deviceId, lastSeen: this.lastSeen });
    } catch {}
    this.scheduleKeepaliveCheck();

    let msg: TunnelMessage | { type: string; deviceId?: string };
    try {
      msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    // Any well-formed frame proves liveness (HTTP/2-tunnel safe).
    this.lastSeen = Date.now();

    if ("id" in msg && typeof msg.id === "string" && ("response" in msg || "result" in msg || "error" in msg)) {
      // Anti cross-device response: the pending id must belong to THIS device
      // (it always does - the DO owns one device - but verify the entry).
      this.resolveFromDevice(msg.id, msg as TunnelMessage);
      return;
    }

    if ("type" in msg && (msg as { type: string }).type === "keepalive") {
      try {
        ws.send(JSON.stringify({ type: "keepalive-ack" }));
      } catch {}
      return;
    }

    if ("type" in msg && (msg as { type: string }).type === "register") {
      const requested = String((msg as { deviceId?: unknown }).deviceId || "").trim();
      if (!validDeviceId(requested)) return;
      // The device is bound to this DO's id; allow re-register of the SAME id
      // (the extension sends register on every connect), reject different ids
      // (a rebind would require moving to another DO - not allowed).
      if (requested !== this.deviceId) {
        try {
          ws.send(JSON.stringify({ type: "error", error: "deviceId mismatch" }));
        } catch {}
        return;
      }
      try {
        ws.send(JSON.stringify({ type: "registered", deviceId: this.deviceId }));
      } catch {}
      return;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    if (this.ws === ws) this.ws = null;
    await this.unregisterFromRegistry();
    this.failDevice("device disconnected");
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    if (this.ws === ws) this.ws = null;
    await this.unregisterFromRegistry();
    this.failDevice("device error");
  }

  private maybeRefreshRegistry(): void {
    const now = Date.now();
    const intervalMs = parseInt(this.env.REGISTRY_REFRESH_MS || "30000", 10) || 30000;
    if (now - this.lastRegistryAt < intervalMs) return;
    this.lastRegistryAt = now;
    this.env.REGISTRY
      .get(this.env.REGISTRY.idFromName("global"))
      .fetch("https://registry/register?id=" + encodeURIComponent(this.deviceId), { method: "POST" })
      .catch(() => {});
  }

  private recordClient(request: Request, body: unknown): void {
    try {
      const ip = request.headers.get("x-client-ip") || "unknown";
      const now = Date.now();
      let name: string | undefined;
      const m = (body || {}) as { method?: string; params?: { clientInfo?: { name?: string } } };
      if (
        m.method === "initialize" &&
        m.params &&
        m.params.clientInfo &&
        typeof m.params.clientInfo.name === "string"
      ) {
        name = m.params.clientInfo.name.slice(0, 64);
      }
      const existing = this.clients.get(ip);
      if (existing) {
        existing.lastSeen = now;
        existing.count += 1;
        if (name) existing.name = name;
      } else {
        // Bound the map: a flood of distinct client IPs (botnet) must not grow
        // it without limit before the TTL sweep runs. Evict the least recently
        // seen entry when over the cap.
        if (this.clients.size >= MAX_TRACKED_CLIENTS) {
          let oldestKey: string | null = null;
          let oldestSeen = Infinity;
          for (const [k, c] of this.clients) {
            if (c.lastSeen < oldestSeen) { oldestSeen = c.lastSeen; oldestKey = k; }
          }
          if (oldestKey !== null) this.clients.delete(oldestKey);
        }
        this.clients.set(ip, { ip, name, lastSeen: now, count: 1 });
      }
    } catch {}
  }

  private async unregisterFromRegistry(): Promise<void> {
    try {
      const reg = this.env.REGISTRY.get(this.env.REGISTRY.idFromName("global"));
      await reg.fetch(
        "https://registry/unregister?id=" + encodeURIComponent(this.deviceId),
        { method: "POST" },
      );
    } catch {}
  }

  // Keepalive watchdog: use an alarm so stale sockets are dropped even while
  // the DO is hibernated. Alarms wake the object; timers would not fire while
  // asleep.
  private scheduleKeepaliveCheck(): void {
    const deadline = Date.now() + this.keepaliveTimeoutMs;
    this.ctx.storage.setAlarm(deadline).catch(() => {});
  }

  async alarm(): Promise<void> {
    if (!this.ws) return;
    if (Date.now() - this.lastSeen > this.keepaliveTimeoutMs) {
      try {
        this.ws.close(1011, "keepalive timeout");
      } catch {}
      this.ws = null;
      this.failDevice("keepalive timeout");
      return;
    }
    this.scheduleKeepaliveCheck();
  }

  // ---- HTTP relay: POST /mcp -------------------------------------------------

  private async handleMcp(request: Request): Promise<Response> {
    if (!this.deviceId || !validDeviceId(this.deviceId)) {
      return Response.json({ error: "invalid deviceId" }, { status: 400 });
    }
    // NOTE: the device token is NOT checked here - it only gates the WS upgrade
    // (handleUpgrade). The /mcp relay is authenticated by the gateway token in
    // the worker entry; requiring the device token here would break clients that
    // legitimately use only the gateway token. The DO's job is device-liveness,
    // budget, and relay.
    if (!this.ws || this.ws.readyState !== 1) {
      return Response.json({ error: "device offline" }, { status: 503 });
    }
    if (this.pending.size >= this.maxPending) {
      return Response.json({ error: "device busy" }, { status: 503 });
    }

    // Body cap: enforce our own limit (Workers default allows 100MB; we cap).
    const length = Number(request.headers.get("content-length") || 0);
    if (length > this.maxBodyBytes) {
      return Response.json({ error: "payload too large" }, { status: 413 });
    }
    let raw: string;
    try {
      raw = await request.text();
    } catch {
      return Response.json({ error: "invalid body" }, { status: 400 });
    }
    if (raw.length > this.maxBodyBytes) {
      return Response.json({ error: "payload too large" }, { status: 413 });
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 });
    }

    // Track relay clients (admin "Clients" view): keyed by client IP, with
    // the MCP client name captured from initialize when present.
    this.recordClient(request, body);

    // Relay token (device-side auth, opaque to the gateway) - same as Bun.
    const relayToken =
      request.headers.get("x-device-token") || new URL(request.url).searchParams.get("token") || undefined;

    const id = crypto.randomUUID();
    const tunnelReq: TunnelRequest = {
      id,
      request: body as TunnelRequest["request"],
      ...(relayToken && { token: relayToken }),
    };

    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => this.expirePending(id), this.timeoutMs);
      this.pending.set(id, { kind: "http", deviceId: this.deviceId, resolve, timer });

      try {
        const ws = this.ws;
        if (!ws || ws.readyState !== 1) {
          clearTimeout(timer);
          this.pending.delete(id);
          resolve(Response.json({ error: "device offline" }, { status: 503 }));
          return;
        }
        ws.send(JSON.stringify(tunnelReq));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(Response.json({ error: "device send failed" }, { status: 502 }));
      }
    });
  }

  // ---- SSE transport: GET /sse + POST /messages --------------------------
  //
  // Legacy MCP "HTTP with SSE" transport. index.ts authenticates each request
  // (gateway token + device token + rate limit + disabled/virtual checks) and
  // rewrites the path to /sse or /messages before calling here. This DO already
  // owns the device tunnel (this.ws) and the pending-request registry, so the
  // SSE stream reuses both: POST /messages sends a tunnel request, and the
  // device's response is pushed onto the open SSE stream instead of an HTTP body.

  private async handleSse(request: Request): Promise<Response> {
    if (!this.deviceId || !validDeviceId(this.deviceId)) {
      return Response.json({ error: "invalid deviceId" }, { status: 400 });
    }
    if (this.sseSessions.size >= this.maxSseSessions) {
      return Response.json({ error: "too many streams" }, { status: 503 });
    }
    // The stream is only useful while the device tunnel is up; reject eagerly so
    // a client does not hold a dead stream open (parity with /mcp's 503).
    if (!this.ws || this.ws.readyState !== 1) {
      return Response.json({ error: "device offline" }, { status: 503 });
    }

    const sessionId = crypto.randomUUID();
    const sess: SseSession = { sessionId, controller: null, timer: null, inbound: 0 };
    const rs = new ReadableStream<Uint8Array>({
      start: (controller) => {
        sess.controller = controller;
      },
      cancel: () => {
        // Client went away (or the response was aborted): drop the session.
        this.closeSession(sessionId, null);
      },
    });
    this.sseSessions.set(sessionId, sess);
    this.resetSessionIdle(sess);

    // First event tells the client where to POST JSON-RPC messages. Standard
    // MCP clients resolve it against their SSE URL (new URL(data, base)).
    const endpoint = "/messages/" + encodeURIComponent(this.deviceId) + "?session=" + encodeURIComponent(sessionId);
    this.pushSseFrame(sess, "endpoint", endpoint);

    return new Response(rs, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      },
    });
  }

  private async handleMessages(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("session") || request.headers.get("mcp-session-id") || "";
    if (!sessionId || !this.sseSessions.has(sessionId)) {
      return Response.json({ error: "unknown session" }, { status: 400 });
    }

    const length = Number(request.headers.get("content-length") || 0);
    if (length > this.maxBodyBytes) {
      return Response.json({ error: "payload too large" }, { status: 413 });
    }
    let raw: string;
    try {
      raw = await request.text();
    } catch {
      return Response.json({ error: "invalid body" }, { status: 400 });
    }
    if (raw.length > this.maxBodyBytes) {
      return Response.json({ error: "payload too large" }, { status: 413 });
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 });
    }

    this.recordClient(request, body);

    const obj = (body && typeof body === "object" ? body : {}) as { id?: unknown };
    const clientId = obj.id ?? null;

    if (!this.ws || this.ws.readyState !== 1) {
      return Response.json({ error: "device offline" }, { status: 503 });
    }
    if (this.pending.size >= this.maxPending) {
      return Response.json({ error: "device busy" }, { status: 503 });
    }

    const relayToken =
      request.headers.get("x-device-token") || url.searchParams.get("token") || undefined;

    const id = crypto.randomUUID();
    const tunnelReq: TunnelRequest = {
      id,
      request: body as TunnelRequest["request"],
      ...(relayToken && { token: relayToken }),
    };
    const sess = this.sseSessions.get(sessionId)!;
    this.resetSessionIdle(sess);
    const timer = setTimeout(() => this.expirePending(id), this.timeoutMs);
    this.pending.set(id, { kind: "sse", deviceId: this.deviceId, sessionId, clientId, timer });
    try {
      this.ws.send(JSON.stringify(tunnelReq));
    } catch {
      clearTimeout(timer);
      this.pending.delete(id);
      return Response.json({ error: "device send failed" }, { status: 502 });
    }
    // Accepted: the JSON-RPC response arrives asynchronously over the SSE stream.
    return new Response(null, { status: 202 });
  }

  private expirePending(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (entry.kind === "http") {
      entry.resolve(Response.json({ error: "timeout" }, { status: 504 }));
    } else {
      const sess = this.sseSessions.get(entry.sessionId);
      if (sess) this.pushSseError(sess, entry.clientId, -32603, "timeout");
    }
  }

  private pushSseMessage(sess: SseSession, msg: TunnelMessage): boolean {
    const payload = jsonRpcPayload(msg);
    if (payload === null) return true; // notification acknowledged - no frame
    return this.pushSseFrame(sess, "message", JSON.stringify(payload));
  }

  private pushSseError(sess: SseSession, id: unknown, code: number, message: string): boolean {
    const payload = { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
    return this.pushSseFrame(sess, "message", JSON.stringify(payload));
  }

  private pushSseFrame(sess: SseSession, event: string, data: string): boolean {
    if (!sess.controller) return false;
    const frame = "event: " + event + "\ndata: " + data + "\n\n";
    try {
      sess.controller.enqueue(new TextEncoder().encode(frame));
      return true;
    } catch {
      this.closeSession(sess.sessionId, null);
      return false;
    }
  }

  private resetSessionIdle(sess: SseSession): void {
    if (sess.timer) clearTimeout(sess.timer);
    sess.timer = setTimeout(() => this.closeSession(sess.sessionId, null), this.sseIdleTimeoutMs);
  }

  private closeSession(sessionId: string, err: { code: number; message: string } | null): void {
    const sess = this.sseSessions.get(sessionId);
    if (!sess) return;
    this.sseSessions.delete(sessionId);
    if (sess.timer) clearTimeout(sess.timer);
    // Drop any in-flight requests bound to this session.
    for (const [id, e] of this.pending) {
      if (e.kind === "sse" && e.sessionId === sessionId) {
        clearTimeout(e.timer);
        this.pending.delete(id);
      }
    }
    if (err) this.pushSseFrame(sess, "message", JSON.stringify({ jsonrpc: "2.0", id: null, error: err }));
    if (sess.controller) {
      try {
        sess.controller.close();
      } catch {}
    }
  }

  private resolveFromDevice(id: string, msg: TunnelMessage): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    // entry.deviceId === this.deviceId always (DO owns one device).
    clearTimeout(entry.timer);
    this.pending.delete(id);
    if (entry.kind === "http") {
      entry.resolve(toJsonRpcResponse(msg));
    } else {
      const sess = this.sseSessions.get(entry.sessionId);
      if (sess) {
        this.resetSessionIdle(sess);
        this.pushSseMessage(sess, msg);
      }
    }
  }

  private failDevice(reason: string): void {
    const victims = [...this.pending.values()];
    this.pending.clear();
    for (const v of victims) {
      clearTimeout(v.timer);
      if (v.kind === "http") {
        try {
          v.resolve(Response.json({ error: reason }, { status: 503 }));
        } catch {}
      } else {
        const sess = this.sseSessions.get(v.sessionId);
        if (sess) this.pushSseError(sess, v.clientId, -32603, reason);
      }
    }
    // The device tunnel is gone: every open SSE stream is now unserviceable and
    // must be closed (in-flight requests were already errored above).
    for (const sid of [...this.sseSessions.keys()]) this.closeSession(sid, null);
  }
}

function num(raw: string | undefined, def: number): number {
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

// Shared: extract the JSON-RPC payload from a tunnel message. Returns null when
// the message is a notification acknowledgement (bare {} or response:null) -
// the client expects no response body, so callers end the exchange silently.
function jsonRpcPayload(msg: TunnelMessage): unknown | null {
  if ("response" in msg && msg.response !== null && msg.response !== undefined) {
    // Bare {} = notification acknowledged by a legacy device client (it has no
    // response body for notifications). Real tool responses always carry the
    // full JSON-RPC envelope, so a key-less object is unambiguous.
    if (typeof msg.response === "object" && Object.keys(msg.response as unknown as Record<string, unknown>).length === 0) {
      return null;
    }
    return msg.response;
  }
  if ("error" in msg && msg.error) {
    return { jsonrpc: "2.0", id: null, error: { code: -32603, message: String(msg.error) } };
  }
  // response:null (or no response) = notification acknowledged - no body.
  return null;
}

function toJsonRpcResponse(msg: TunnelMessage): Response {
  const payload = jsonRpcPayload(msg);
  if (payload === null) return new Response(null, { status: 204 });
  return Response.json(payload);
}
