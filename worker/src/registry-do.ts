// RegistryDO - a SINGLE shared instance that tracks:
//   1. the device -> token map (writable: the admin UI registers devices here;
//      seeded once from the DEVICE_TOKENS secret on first run), and
//   2. which deviceIds are currently online.
//
// A plain Worker cannot enumerate devices or hold shared state across
// isolates, so both the roster and the device registry live in this one
// Durable Object. Everything is persisted to durable storage so it survives
// restarts. The online set is TTL-swept (devices that died without a clean
// unregister).

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./config";
import { validDeviceId } from "./config";

const ONLINE_TTL_MS = 150_000; // longer than keepalive timeout; swept on read
const TOKEN_MAX = 256; // token length cap (sanity bound)

interface DeviceRec {
  seenAt: number;
}

export class RegistryDO extends DurableObject<Env> {
  private online = new Map<string, DeviceRec>();
  private tokens = new Map<string, string>(); // deviceId -> token (authoritative)

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Warm from durable storage on wake (hibernation restores memory too, but
    // this covers cold starts after eviction). Seed the device map from the
    // DEVICE_TOKENS secret the first time the object is created.
    this.ctx.blockConcurrencyWhile(async () => {
      try {
        const saved = (await this.ctx.storage.get<string[]>("online")) || [];
        const now = Date.now();
        for (const id of saved) {
          if (validDeviceId(id)) this.online.set(id, { seenAt: now });
        }
      } catch {}
      try {
        const saved = (await this.ctx.storage.get<Record<string, string>>("device_tokens")) || {};
        for (const [id, tok] of Object.entries(saved)) {
          if (validDeviceId(id) && typeof tok === "string" && tok.length > 0) this.tokens.set(id, tok);
        }
        if (this.tokens.size === 0 && this.env.DEVICE_TOKENS) {
          try {
            const seed = JSON.parse(this.env.DEVICE_TOKENS) as Record<string, unknown>;
            for (const [id, tok] of Object.entries(seed)) {
              if (typeof tok === "string" && validDeviceId(id) && tok.length > 0) this.tokens.set(id, tok);
            }
            if (this.tokens.size > 0) await this.persistTokens();
          } catch {}
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

    // ---- device registry (admin UI) ----

    if (request.method === "GET" && path === "/map") {
      return Response.json({ map: Object.fromEntries(this.tokens) });
    }

    if (request.method === "GET" && path === "/full") {
      this.sweep();
      const devices = [...this.tokens.entries()].map(([deviceId, token]) => ({
        deviceId,
        token,
        online: this.online.has(deviceId),
      }));
      return Response.json({ devices });
    }

    if (request.method === "POST" && path === "/upsert") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }
      const { deviceId, token } = (body || {}) as { deviceId?: unknown; token?: unknown };
      const id = String(deviceId || "").trim();
      const tok = String(token || "").trim();
      if (!validDeviceId(id)) return Response.json({ error: "invalid deviceId" }, { status: 400 });
      if (!tok || tok.length > TOKEN_MAX) {
        return Response.json({ error: "token must be 1-" + TOKEN_MAX + " chars" }, { status: 400 });
      }
      this.tokens.set(id, tok);
      await this.persistTokens();
      this.sweep();
      return Response.json({
        ok: true,
        devices: [...this.tokens.entries()].map(([deviceId, t]) => ({
          deviceId,
          token: t,
          online: this.online.has(deviceId),
        })),
      });
    }

    if (request.method === "POST" && path === "/remove") {
      let id = "";
      try {
        const body = (await request.json()) as { deviceId?: unknown };
        id = String((body && body.deviceId) || "").trim();
      } catch {
        id = url.searchParams.get("id") || "";
      }
      if (!validDeviceId(id)) return Response.json({ error: "invalid deviceId" }, { status: 400 });
      this.tokens.delete(id);
      this.online.delete(id);
      await this.persistTokens();
      await this.persist();
      this.sweep();
      return Response.json({
        ok: true,
        devices: [...this.tokens.entries()].map(([deviceId, t]) => ({
          deviceId,
          token: t,
          online: this.online.has(deviceId),
        })),
      });
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

  private async persistTokens(): Promise<void> {
    try {
      await this.ctx.storage.put("device_tokens", Object.fromEntries(this.tokens));
    } catch {}
  }
}
