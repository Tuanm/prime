// RegistryDO - a SINGLE shared instance that tracks which deviceIds are
// currently online. A plain Worker cannot enumerate devices (no shared state
// across isolates), so /devices needs one global object.
//
// Every DeviceDO reports register/unregister via this object's fetch(). The
// set is kept in durable storage so the list survives restarts, and a TTL
// sweep drops stale entries (devices that died without a clean unregister).

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./config";
import { validDeviceId } from "./config";

const ONLINE_TTL_MS = 150_000; // longer than keepalive timeout; swept on read

interface DeviceRec {
  seenAt: number;
}

export class RegistryDO extends DurableObject<Env> {
  private online = new Map<string, DeviceRec>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Warm from durable storage on wake (hibernation restores memory too, but
    // this covers cold starts after eviction).
    this.ctx.blockConcurrencyWhile(async () => {
      try {
        const saved = (await this.ctx.storage.get<string[]>("online")) || [];
        const now = Date.now();
        for (const id of saved) {
          if (validDeviceId(id)) this.online.set(id, { seenAt: now });
        }
      } catch {}
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "POST" && path === "/register") {
      const id = url.searchParams.get("id") || "";
      if (!validDeviceId(id)) return Response.json({ error: "invalid deviceId" }, { status: 400 });
      this.online.set(id, { seenAt: Date.now() });
      await this.persist();
      return Response.json({ ok: true, deviceId: id });
    }

    if (request.method === "POST" && path === "/unregister") {
      const id = url.searchParams.get("id") || "";
      this.online.delete(id);
      await this.persist();
      return Response.json({ ok: true, deviceId: id });
    }

    if (request.method === "GET" && path === "/devices") {
      this.sweep();
      return Response.json({ devices: [...this.online.keys()] });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  }

  private sweep(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, rec] of this.online) {
      if (now - rec.seenAt > ONLINE_TTL_MS) {
        this.online.delete(id);
        changed = true;
      }
    }
    if (changed) this.persist().catch(() => {});
  }

  private async persist(): Promise<void> {
    try {
      await this.ctx.storage.put("online", [...this.online.keys()]);
    } catch {}
  }
}
