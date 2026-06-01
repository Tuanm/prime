import { parseArgs } from './config';
import { RateLimiter, extractClientIp, isLoopback } from './rate-limit';
import { PendingRegistry } from './pending';
import { installService, uninstallService } from './installer';
import type { TunnelRequest, TunnelMessage } from './protocol';

interface WSData {
  deviceId: string;
  missedPings: number;
}

type WS = {
  data: WSData;
  send: (data: string) => number;
  ping: (data?: string) => number;
  close: (code?: number, reason?: string) => void;
  readyState: number;
};

// Bun exposes WebSocket as a global; pin the OPEN constant to a literal so the
// readyState check is resilient to runtime variations.
const WS_OPEN = 1;

// deviceId character allowlist + length cap. Prevents path-traversal-flavored
// confusion in /mcp/{id} routing and bounds memory for spurious registrations.
const DEVICE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
function validDeviceId(s: string): boolean {
  return DEVICE_ID_RE.test(s);
}

const { config, action } = parseArgs(Bun.argv.slice(2));

if (action === 'install' || action === 'uninstall') {
  const scriptPath = process.argv[1];
  const isScript = !!scriptPath && (scriptPath.endsWith('.ts') || scriptPath.endsWith('.js'));
  if (action === 'install') {
    await installService({
      execPath: process.execPath,
      scriptPath: isScript ? scriptPath : undefined,
      port: config.port,
      token: config.gatewayToken,
      deviceToken: config.deviceToken,
    });
  } else {
    await uninstallService();
  }
  process.exit(0);
}

const rateLimiter = new RateLimiter(config.rateWindowMs, config.rateMax);
const pending = new PendingRegistry(config.maxPendingPerDevice);
const wsMap = new Map<string, WS>();

function unauthorized(): Response {
  return Response.json({ error: 'unauthorized' }, { status: 401 });
}

function extractToken(req: Request, url: URL, queryName: string): string | null {
  const auth = req.headers.get('authorization');
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) return m[1].trim();
  }
  const q = url.searchParams.get(queryName);
  if (q) return q;
  return null;
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function authGateway(req: Request, url: URL): boolean {
  if (!config.gatewayToken) return true;
  const t = extractToken(req, url, 'auth');
  return !!t && timingSafeEq(t, config.gatewayToken);
}

function authDevice(req: Request, url: URL): boolean {
  if (!config.deviceToken) return true;
  const t = extractToken(req, url, 'auth');
  return !!t && timingSafeEq(t, config.deviceToken);
}

function originAllowed(req: Request): boolean {
  if (!config.allowedOrigins || config.allowedOrigins.size === 0) return true;
  const origin = req.headers.get('origin');
  if (!origin) return true; // non-browser clients send no Origin
  return config.allowedOrigins.has(origin);
}

const server = Bun.serve({
  port: config.port,
  maxRequestBodySize: config.maxBodyBytes,
  idleTimeout: config.idleTimeoutSec,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const peerIp = srv.requestIP(req)?.address ?? 'unknown';

    // /devices: loopback only AND no proxy headers. If a reverse proxy
    // (cloudflared, nginx, Caddy) runs on the same host it connects via
    // 127.0.0.1, so peerIp alone cannot prove the request originated locally.
    // Any forwarding header indicates a hop and disqualifies the request.
    if (req.method === 'GET' && url.pathname === '/devices') {
      const proxied =
        req.headers.get('x-forwarded-for') ||
        req.headers.get('x-real-ip') ||
        req.headers.get('forwarded') ||
        req.headers.get('cf-connecting-ip') ||
        req.headers.get('cf-ray') ||
        req.headers.get('x-forwarded-proto') ||
        req.headers.get('x-forwarded-host');
      if (!isLoopback(peerIp) || proxied) {
        return Response.json({ error: 'not found' }, { status: 404 });
      }
      return Response.json({ devices: [...wsMap.keys()] });
    }

    // POST /mcp/{deviceId}
    if (req.method === 'POST' && url.pathname.startsWith('/mcp/')) {
      if (!authGateway(req, url)) return unauthorized();

      const rlKey = extractClientIp(req, peerIp, config.trustProxy);
      if (!rateLimiter.allow(rlKey)) {
        return Response.json({ error: 'rate limited' }, { status: 429 });
      }

      const deviceId = url.pathname.slice(5);
      if (!validDeviceId(deviceId)) {
        return Response.json({ error: 'invalid deviceId' }, { status: 400 });
      }

      const ws = wsMap.get(deviceId);
      if (!ws || ws.readyState !== WS_OPEN) {
        return Response.json({ error: 'device offline' }, { status: 503 });
      }
      if (pending.pendingCount(deviceId) >= config.maxPendingPerDevice) {
        return Response.json({ error: 'device busy' }, { status: 503 });
      }

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: 'invalid json' }, { status: 400 });
      }

      // Device-side token (relayed via tunnel) - separate from gateway token.
      const relayToken =
        req.headers.get('x-device-token') || url.searchParams.get('token') || undefined;
      const id = crypto.randomUUID();
      const tunnelReq: TunnelRequest = {
        id,
        request: body as TunnelRequest['request'],
        ...(relayToken && { token: relayToken }),
      };

      return new Promise<Response>((resolve) => {
        const timer = setTimeout(() => pending.timeoutId(id), config.timeoutMs);
        if (!pending.tryAdd(id, deviceId, resolve, timer)) {
          clearTimeout(timer);
          resolve(Response.json({ error: 'device busy' }, { status: 503 }));
          return;
        }
        // Bun's ws.send returns the number of bytes queued, or 0/-1 on
        // back-pressure / closed peer. A failed send must abort the pending
        // immediately; otherwise the request hangs until --timeout fires.
        let sent = 0;
        try {
          sent = ws.send(JSON.stringify(tunnelReq));
        } catch {
          pending.abortId(id, 502, 'device send failed');
          return;
        }
        if (sent <= 0) {
          pending.abortId(id, 503, 'device backpressure');
        }
      });
    }

    // WS upgrade: /ws/{deviceId} (preferred)
    if (url.pathname.startsWith('/ws/') && req.headers.get('upgrade') === 'websocket') {
      if (!originAllowed(req)) return Response.json({ error: 'forbidden origin' }, { status: 403 });
      if (!authDevice(req, url)) return unauthorized();
      const deviceId = url.pathname.slice(4);
      if (!validDeviceId(deviceId)) {
        return Response.json({ error: 'invalid deviceId' }, { status: 400 });
      }
      if (wsMap.has(deviceId)) {
        return Response.json({ error: 'deviceId already in use' }, { status: 409 });
      }
      const data: WSData = { deviceId, missedPings: 0 };
      if (srv.upgrade(req, { data })) return undefined;
      return Response.json({ error: 'upgrade failed' }, { status: 400 });
    }
    // Legacy WS: /ws?deviceId=xxx (server assigns UUID if missing)
    if (url.pathname === '/ws' && req.headers.get('upgrade') === 'websocket') {
      if (!originAllowed(req)) return Response.json({ error: 'forbidden origin' }, { status: 403 });
      if (!authDevice(req, url)) return unauthorized();
      const requested = url.searchParams.get('deviceId');
      const deviceId = requested || crypto.randomUUID();
      if (requested && !validDeviceId(requested)) {
        return Response.json({ error: 'invalid deviceId' }, { status: 400 });
      }
      if (requested && wsMap.has(requested)) {
        return Response.json({ error: 'deviceId already in use' }, { status: 409 });
      }
      const data: WSData = { deviceId, missedPings: 0 };
      if (srv.upgrade(req, { data })) return undefined;
      return Response.json({ error: 'upgrade failed' }, { status: 400 });
    }

    return Response.json({ error: 'not found' }, { status: 404 });
  },

  websocket: {
    maxPayloadLength: config.maxBodyBytes,
    sendPings: false, // we manage our own ping/pong for liveness tracking
    idleTimeout: config.idleTimeoutSec,
    open(ws: WS) {
      const { deviceId } = ws.data;
      // Defensive: if someone won the race, reject.
      if (wsMap.has(deviceId)) {
        try {
          ws.send(JSON.stringify({ type: 'error', error: 'deviceId already in use' }));
        } catch {}
        ws.close(1008, 'deviceId already in use');
        return;
      }
      wsMap.set(deviceId, ws);
      try {
        ws.send(JSON.stringify({ type: 'registered', deviceId }));
      } catch {}
    },
    close(ws: WS) {
      const { deviceId } = ws.data;
      if (wsMap.get(deviceId) === ws) wsMap.delete(deviceId);
      pending.failDevice(deviceId, 503, 'device disconnected');
    },
    pong(ws: WS) {
      ws.data.missedPings = 0;
    },
    message(ws: WS, data: string | Buffer) {
      let msg: TunnelMessage | { type: string; deviceId?: string };
      try {
        msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      // Successful parse of a well-formed app-layer message proves liveness.
      // Reset only AFTER parse so garbage frames cannot keep a zombie ws alive.
      // Survives HTTP/2 tunnels (Cloudflare Zero Trust, etc.) that may swallow
      // WS control ping/pong frames.
      ws.data.missedPings = 0;

      if (
        'id' in msg &&
        typeof msg.id === 'string' &&
        ('response' in msg || 'result' in msg || 'error' in msg)
      ) {
        // Anti cross-device response: id must belong to this ws's device.
        pending.resolveFromDevice(msg.id, ws.data.deviceId, msg as any);
        return;
      }

      if ('type' in msg && (msg as any).type === 'keepalive') {
        try {
          ws.send(JSON.stringify({ type: 'keepalive-ack' }));
        } catch {}
        return;
      }

      if ('type' in msg && (msg as any).type === 'register') {
        const requested = String((msg as any).deviceId || '').trim();
        if (!validDeviceId(requested)) return;
        const current = ws.data.deviceId;
        if (requested === current) {
          try {
            ws.send(JSON.stringify({ type: 'registered', deviceId: current }));
          } catch {}
          return;
        }
        const existing = wsMap.get(requested);
        if (existing && existing !== ws) {
          try {
            ws.send(JSON.stringify({ type: 'error', error: 'deviceId already in use' }));
          } catch {}
          return;
        }
        // Only release `current` if THIS ws owns it. Otherwise another ws is the
        // legitimate owner of `current` and we must not wipe its pendings.
        const weOwnedCurrent = wsMap.get(current) === ws;
        if (weOwnedCurrent) {
          wsMap.delete(current);
          pending.failDevice(current, 503, 'device reregistered');
        }
        wsMap.set(requested, ws);
        ws.data.deviceId = requested;
        try {
          ws.send(JSON.stringify({ type: 'registered', deviceId: requested }));
        } catch {}
        return;
      }
      // Unknown messages: ignore.
    },
  },
});

// Active liveness probe: ping each ws; drop after N missed pongs.
const pingTimer = setInterval(() => {
  for (const ws of wsMap.values()) {
    if (ws.readyState !== WS_OPEN) continue;
    if (ws.data.missedPings >= config.pingMaxMisses) {
      try {
        ws.close(1011, 'ping timeout');
      } catch {}
      continue;
    }
    ws.data.missedPings++;
    try {
      ws.ping();
    } catch {}
  }
}, config.pingIntervalMs);

function shutdown(): void {
  clearInterval(pingTimer);
  rateLimiter.stop();
  // Fail any in-flight pendings so HTTP callers see a 503 instead of TCP reset.
  pending.failAll(503, 'gateway shutting down');
  try {
    server.stop(true);
  } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`code-mcp-gateway listening on http://localhost:${config.port}`);
console.log(`Gateway auth: ${config.gatewayToken ? 'enabled' : 'DISABLED (public)'}`);
console.log(
  `Device auth:  ${config.deviceToken ? 'enabled' : 'DISABLED (any client may register as device)'}`,
);
if (!config.gatewayToken) console.warn('WARNING: --token not set. /mcp/* is publicly accessible.');
if (!config.deviceToken)
  console.warn('WARNING: --device-token not set. Device hijacking is possible.');
if (!config.trustProxy) {
  console.warn(
    'NOTE: --trust-proxy not set; rate limit and /devices loopback check use the TCP peer IP. ' +
      'If this gateway sits behind a reverse proxy (nginx/Caddy/Cloudflare), set --trust-proxy.',
  );
}
