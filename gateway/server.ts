import { DeviceRegistry } from './device-registry';
import { TunnelRequest, TunnelMessage, TunnelResponse, TunnelError } from './protocol';

interface Env {
  DEVICE_REGISTRY: DurableObjectNamespace<DeviceRegistry>;
  GATEWAY_TOKEN?: string;
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 100;
const TIMEOUT_MS = 30_000;
const MAX_PENDING = 100;

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

const wsMap = new Map<string, WebSocket>();
const pendingMap = new Map<string, { resolve: (v: TunnelResponse | TunnelError) => void; timer: ReturnType<typeof setTimeout> }>();

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

function authenticate(request: Request, token: string | undefined): Response | null {
  if (!token) return null;
  const auth = request.headers.get('Authorization');
  if (auth !== `Bearer ${token}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

function getStub(env: Env): DurableObjectStub<DeviceRegistry> {
  return env.DEVICE_REGISTRY.get(env.DEVICE_REGISTRY.idFromName('global'));
}

function respond(id: string, res: TunnelResponse | TunnelError): void {
  const p = pendingMap.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pendingMap.delete(id);
  p.resolve(res);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const pair = new WebSocketPair();
      const clientWs = pair[0];
      const serverWs = pair[1];

      const upgrade = request.headers.get('Upgrade');
      if (upgrade !== 'websocket') {
        return new Response('Expected Upgrade: websocket', { status: 426 });
      }

      let deviceId: string | null = null;

      const deviceClose = () => {
        if (deviceId) {
          wsMap.delete(deviceId);
          getStub(env).close(deviceId);
        }
      };

      serverWs.addEventListener('close', deviceClose);
      serverWs.addEventListener('message', async (e) => {
        try {
          const data = e.data as string;
          const msg = JSON.parse(data) as TunnelMessage;

          if (msg.type === 'register') {
            deviceId = (msg as any).deviceId;
            wsMap.set(deviceId, serverWs);
            await getStub(env).register(deviceId);
            serverWs.send(JSON.stringify({ type: 'registered', deviceId }));
          } else if (deviceId && ('response' in msg || 'error' in msg)) {
            respond(msg.id, msg);
          }
        } catch (err) {
          console.error('Message error:', err);
        }
      });

      serverWs.accept();
      return new Response(null, { status: 101, webSocket: clientWs });
    }

    const authError = authenticate(request, env.GATEWAY_TOKEN);
    if (authError) return authError;

    if (request.method === 'POST' && url.pathname === '/mcp') {
      const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      if (!rateLimit(ip)) {
        return Response.json({ error: 'rate limited' }, { status: 429 });
      }

      const deviceId = request.headers.get('x-device-id');
      if (!deviceId) {
        return Response.json({ error: 'missing x-device-id' }, { status: 400 });
      }

      const ws = wsMap.get(deviceId);
      if (!ws) {
        return Response.json({ error: 'device offline' }, { status: 503 });
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: 'invalid json' }, { status: 400 });
      }

      if (pendingMap.size >= MAX_PENDING) {
        return Response.json({ error: 'device busy' }, { status: 503 });
      }

      const id = crypto.randomUUID();
      const token = request.headers.get('x-token') ?? undefined;

      const tunnelReq: TunnelRequest = { id, request: body as TunnelRequest['request'], ...(token && { token }) };
      ws.send(JSON.stringify(tunnelReq));

      const result = await new Promise<TunnelResponse | TunnelError>((resolve) => {
        const timer = setTimeout(() => {
          pendingMap.delete(id);
          resolve({ id, error: 'timeout' });
        }, TIMEOUT_MS);
        pendingMap.set(id, { resolve, timer });
      });

      if ('error' in result) {
        if (result.error === 'timeout') {
          return Response.json({ error: 'timeout' }, { status: 504 });
        }
      }

      return Response.json(result);
    }

    if (request.method === 'GET' && url.pathname === '/devices') {
      const stub = getStub(env);
      const devices = await stub.listDevices();
      return Response.json({ devices: [...devices] });
    }

    return Response.json({ error: 'not found' }, { status: 404 });
  },
};

import { DurableObject } from 'cloudflare:workers';

export class DeviceRegistry extends DurableObject {
  private devices: string[] = [];

  async register(deviceId: string): Promise<void> {
    if (!this.devices.includes(deviceId)) {
      this.devices.push(deviceId);
    }
  }

  async close(deviceId: string): Promise<void> {
    this.devices = this.devices.filter(d => d !== deviceId);
  }

  listDevices(): string[] {
    return this.devices;
  }
}
