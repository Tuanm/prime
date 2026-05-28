import type { TunnelResponse, TunnelError, JsonRpcResponse } from './protocol';

export type PendingResolve = (res: Response) => void;

interface PendingEntry {
  deviceId: string;
  resolve: PendingResolve;
  timer: ReturnType<typeof setTimeout>;
}

export class PendingRegistry {
  private byId = new Map<string, PendingEntry>();
  private countByDevice = new Map<string, number>();

  constructor(private maxPerDevice: number) {}

  // Atomically register a pending request. Returns false if device is at capacity.
  tryAdd(
    id: string,
    deviceId: string,
    resolve: PendingResolve,
    timer: ReturnType<typeof setTimeout>,
  ): boolean {
    const cur = this.countByDevice.get(deviceId) ?? 0;
    if (cur >= this.maxPerDevice) return false;
    this.byId.set(id, { deviceId, resolve, timer });
    this.countByDevice.set(deviceId, cur + 1);
    return true;
  }

  // Device sent a response. Reject if id doesn't belong to that device (cross-device confusion).
  resolveFromDevice(id: string, fromDeviceId: string, res: TunnelResponse | TunnelError): boolean {
    const entry = this.byId.get(id);
    if (!entry) return false;
    if (entry.deviceId !== fromDeviceId) return false;
    this.detach(id, entry);
    entry.resolve(Response.json(toJsonRpc(res)));
    return true;
  }

  // Timer fired before device responded.
  timeoutId(id: string): boolean {
    const entry = this.byId.get(id);
    if (!entry) return false;
    this.detach(id, entry);
    entry.resolve(Response.json({ error: 'timeout' }, { status: 504 }));
    return true;
  }

  // Caller-side abort (e.g. send to device threw). Returns true if entry existed.
  abortId(id: string, status: number, message: string): boolean {
    const entry = this.byId.get(id);
    if (!entry) return false;
    this.detach(id, entry);
    entry.resolve(Response.json({ error: message }, { status }));
    return true;
  }

  // Fail every pending request for a device (e.g. ws closed or reregistered).
  failDevice(deviceId: string, status: number, reason: string): void {
    for (const [id, entry] of this.byId) {
      if (entry.deviceId !== deviceId) continue;
      this.detach(id, entry);
      entry.resolve(Response.json({ error: reason }, { status }));
    }
  }

  pendingCount(deviceId: string): number {
    return this.countByDevice.get(deviceId) ?? 0;
  }

  private detach(id: string, entry: PendingEntry): void {
    clearTimeout(entry.timer);
    this.byId.delete(id);
    const cur = this.countByDevice.get(entry.deviceId) ?? 0;
    if (cur <= 1) this.countByDevice.delete(entry.deviceId);
    else this.countByDevice.set(entry.deviceId, cur - 1);
  }
}

function toJsonRpc(res: TunnelResponse | TunnelError): JsonRpcResponse {
  if ('response' in res) return res.response;
  return { jsonrpc: '2.0', id: null, error: { code: -32603, message: res.error } };
}
