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

interface PendingEntry {
  deviceId: string;
  resolve: (res: Response) => void;
  timer: ReturnType<typeof setTimeout>;
}

const CLIENT_TTL_MS = 600_000; // relay clients shown for the last 10 min
const MAX_TRACKED_CLIENTS = 2_000; // cap distinct relay-client IPs (memory guard)

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
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(Response.json({ error: "timeout" }, { status: 504 }));
      }, this.timeoutMs);
      this.pending.set(id, { deviceId: this.deviceId, resolve, timer });

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

  private resolveFromDevice(id: string, msg: TunnelMessage): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    // entry.deviceId === this.deviceId always (DO owns one device).
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(toJsonRpcResponse(msg));
  }

  private failDevice(reason: string): void {
    const victims = [...this.pending.values()];
    this.pending.clear();
    for (const v of victims) {
      clearTimeout(v.timer);
      try {
        v.resolve(Response.json({ error: reason }, { status: 503 }));
      } catch {}
    }
  }
}

function num(raw: string | undefined, def: number): number {
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function toJsonRpcResponse(msg: TunnelMessage): Response {
  if ("response" in msg && msg.response !== null && msg.response !== undefined) {
    return Response.json(msg.response);
  }
  if ("error" in msg && msg.error) {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: msg.error } });
  }
  // response:null = notification acknowledged - the client expects 204 No
  // Content, never an error body.
  return new Response(null, { status: 204 });
}
