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

    // /devices: loopback only, no other authentication needed.
    if (req.method === 'GET' && url.pathname === '/devices') {
      if (!isLoopback(peerIp)) {
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
      if (!deviceId) return Response.json({ error: 'missing deviceId' }, { status: 400 });

      const ws = wsMap.get(deviceId);
      if (!ws || ws.readyState !== WebSocket.OPEN) {
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
      const relayToken = req.headers.get('x-device-token') || url.searchParams.get('token') || undefined;
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
        try {
          ws.send(JSON.stringify(tunnelReq));
        } catch {
          pending.abortId(id, 502, 'device send failed');
        }
      });
    }

    // WS upgrade: /ws/{deviceId} (preferred)
    if (url.pathname.startsWith('/ws/') && req.headers.get('upgrade') === 'websocket') {
      if (!originAllowed(req)) return Response.json({ error: 'forbidden origin' }, { status: 403 });
      if (!authDevice(req, url)) return unauthorized();
      const deviceId = url.pathname.slice(4);
      if (!deviceId) return Response.json({ error: 'missing deviceId' }, { status: 400 });
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
      let deviceId = requested || crypto.randomUUID();
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
      ws.send(JSON.stringify({ type: 'registered', deviceId }));
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

      if (
        'id' in msg &&
        typeof msg.id === 'string' &&
        ('response' in msg || 'result' in msg || 'error' in msg)
      ) {
        // Anti cross-device response: id must belong to this ws's device.
        pending.resolveFromDevice(msg.id, ws.data.deviceId, msg as any);
        return;
      }

      if ('type' in msg && (msg as any).type === 'register') {
        const requested = String((msg as any).deviceId || '').trim();
        if (!requested) return;
        const current = ws.data.deviceId;
        if (requested === current) {
          ws.send(JSON.stringify({ type: 'registered', deviceId: current }));
          return;
        }
        const existing = wsMap.get(requested);
        if (existing && existing !== ws) {
          ws.send(JSON.stringify({ type: 'error', error: 'deviceId already in use' }));
          return;
        }
        // Reassign safely: drop old slot, fail its pendings, claim new.
        if (wsMap.get(current) === ws) wsMap.delete(current);
        pending.failDevice(current, 503, 'device reregistered');
        wsMap.set(requested, ws);
        ws.data.deviceId = requested;
        ws.send(JSON.stringify({ type: 'registered', deviceId: requested }));
        return;
      }
      // Unknown messages: ignore.
    },
  },
});

// Active liveness probe: ping each ws; drop after N missed pongs.
const pingTimer = setInterval(() => {
  for (const ws of wsMap.values()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
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
if (!config.deviceToken) console.warn('WARNING: --device-token not set. Device hijacking is possible.');
