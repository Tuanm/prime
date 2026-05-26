import { DeviceRegistry } from './device-registry';
import type { TunnelRequest, TunnelMessage, TunnelResponse, TunnelError } from './protocol';

// Configuration from flags
let PORT = 8080;
let GATEWAY_TOKEN: string | undefined;
let RATE_LIMIT_WINDOW_MS = 60_000;
let RATE_LIMIT_MAX = 100;
let TIMEOUT_MS = 30_000;
let MAX_PENDING = 100;

// Parse args
for (let i = 0; i < Bun.argv.length; i++) {
  const arg = Bun.argv[i];
  if (arg === "--port" && i + 1 < Bun.argv.length) {
    PORT = parseInt(Bun.argv[++i]);
  } else if (arg === "--token" && i + 1 < Bun.argv.length) {
    GATEWAY_TOKEN = Bun.argv[++i];
  } else if (arg === "--rate-window" && i + 1 < Bun.argv.length) {
    RATE_LIMIT_WINDOW_MS = parseInt(Bun.argv[++i]);
  } else if (arg === "--rate-max" && i + 1 < Bun.argv.length) {
    RATE_LIMIT_MAX = parseInt(Bun.argv[++i]);
  } else if (arg === "--timeout" && i + 1 < Bun.argv.length) {
    TIMEOUT_MS = parseInt(Bun.argv[++i]);
  } else if (arg === "--max-pending" && i + 1 < Bun.argv.length) {
    MAX_PENDING = parseInt(Bun.argv[++i]);
  } else if (arg === "-h" || arg === "--help") {
    console.log(`Usage: bun server.ts [options]
Options:
  --port <n>          Listen port (default: 8080)
  --token <s>         Bearer token auth (optional)
  --rate-window <ms>   Rate limit window (default: 60000)
  --rate-max <n>       Max requests per window (default: 100)
  --timeout <ms>        Request timeout (default: 30000)
  --max-pending <n>    Max pending requests (default: 100)`);
    process.exit(0);
  }
}

// State
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
type PendingResolve = (v: TunnelResponse | TunnelError | null) => void;
const pendingMap = new Map<string, { resolve: PendingResolve; timer: ReturnType<typeof setTimeout> }>();
const wsMap = new Map<string, Bun.WebSocket>();
const deviceRegistry = new DeviceRegistry();

// Helper functions
function rateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

function authenticate(request: Request): Response | null {
  if (!GATEWAY_TOKEN) return null;
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${GATEWAY_TOKEN}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

function respond(id: string, res: TunnelResponse | TunnelError | null): void {
  const p = pendingMap.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pendingMap.delete(id);
  if (res) p.resolve(res);
}

// Server
const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    // Auth check
    const authError = authenticate(req);
    if (authError) return authError;

    // GET /devices
    if (req.method === "GET" && url.pathname === "/devices") {
      return Response.json({ devices: deviceRegistry.listDevices() });
    }

    // POST /mcp/{device-id}?token=xxx (path-based, recommended)
    if (req.method === "POST" && url.pathname.startsWith("/mcp/")) {
      const ip = req.headers.get("x-forwarded-for") || "unknown";
      if (!rateLimit(ip)) {
        return Response.json({ error: "rate limited" }, { status: 429 });
      }

      const deviceId = url.pathname.slice(5); // Remove "/mcp/" prefix
      if (!deviceId) {
        return Response.json({ error: "missing deviceId" }, { status: 400 });
      }

      const ws = wsMap.get(deviceId);
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return Response.json({ error: "device offline" }, { status: 503 });
      }

      let body: unknown;
      try {
        body = req.json();
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }

      if (pendingMap.size >= MAX_PENDING) {
        return Response.json({ error: "device busy" }, { status: 503 });
      }

      const id = crypto.randomUUID();
      const token = url.searchParams.get("token") || undefined;
      const tunnelReq: TunnelRequest = { id, request: body as TunnelRequest["request"], ...(token && { token }) };
      ws.send(JSON.stringify(tunnelReq));

      return new Promise<Response>((resolve) => {
        const timer = setTimeout(() => {
          pendingMap.delete(id);
          resolve(Response.json({ error: "timeout" }, { status: 504 }));
        }, TIMEOUT_MS);
        pendingMap.set(id, { resolve, timer });
      });
    }

    // WebSocket upgrade: /ws/{device-id} (path-based)
    if (url.pathname.startsWith("/ws/") && req.headers.get("upgrade") === "websocket") {
      const deviceId = url.pathname.slice(4); // Remove "/ws/" prefix
      if (!deviceId) {
        return Response.json({ error: "missing deviceId" }, { status: 400 });
      }
      server.upgrade(req, { data: deviceId });
      return;
    }
    // Backward compat: /ws?deviceId=xxx
    if (url.pathname === "/ws" && req.headers.get("upgrade") === "websocket") {
      const deviceId = url.searchParams.get("deviceId") || crypto.randomUUID();
      server.upgrade(req, { data: deviceId });
      return;
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },

  websocket: {
    open(ws) {
      const deviceId = ws.data as string;
      wsMap.set(deviceId, ws);
      deviceRegistry.register(deviceId);
      ws.send(JSON.stringify({ type: "registered", deviceId }));
    },
    close(ws) {
      const deviceId = ws.data as string;
      wsMap.delete(deviceId);
      deviceRegistry.close(deviceId);
    },
    message(ws, data) {
      try {
        const msg = JSON.parse(data as string) as TunnelMessage;
        if ("id" in msg && ("response" in msg || "result" in msg || "error" in msg)) {
          respond(msg.id, msg as TunnelResponse | TunnelError);
        } else if ("type" in msg && (msg as any).type === "register") {
          // Client requested to change deviceId - update registry
          const newDeviceId = (msg as any).deviceId as string;
          const oldDeviceId = ws.data as string;
          if (newDeviceId && newDeviceId !== oldDeviceId) {
            wsMap.delete(oldDeviceId);
            wsMap.set(newDeviceId, ws);
            deviceRegistry.close(oldDeviceId);
            deviceRegistry.register(newDeviceId);
            ws.data = newDeviceId;
          }
          ws.send(JSON.stringify({ type: "registered", deviceId: newDeviceId || ws.data }));
        }
      } catch {
        // Ignore invalid messages
      }
    },
  },
});

console.log(`Gateway listening on http://localhost:${PORT}`);
console.log(`Token auth: ${GATEWAY_TOKEN ? "enabled" : "disabled"}`);
