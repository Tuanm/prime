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
import { FILE_ID_RE, r2Budget, r2Cost, r2MaxBytes, r2Round, validDeviceId, virtualDeviceIds } from "./config";

const ONLINE_TTL_DEFAULT_MS = 150_000; // longer than keepalive timeout; swept on read
const TOKEN_MAX = 256; // token length cap (sanity bound)

/** fileId -> owning deviceId, for /files/{id} downloads that carry only an id. */
interface FileIndexEntry {
  deviceId: string;
  expiresAt: number;
}

interface DeviceRec {
  seenAt: number;
}

/**
 * What the account has spent this month, and what it is holding.
 *
 * `bytes` is deliberately *not* reset when the month rolls over: bytes admitted
 * last month are still stored, and still billed, this month. Keeping it as a
 * standing ceiling means the storage bound holds across the boundary instead of
 * resetting to zero while the data is still there. Operation counts are
 * per-month, which is how R2 bills them.
 */
interface R2BudgetState {
  month: string; // UTC "YYYY-MM", the month classA/classB belong to
  bytes: number; // live bytes admitted and not yet released
  classA: number;
  classB: number;
}

function monthKey(now: number = Date.now()): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export class RegistryDO extends DurableObject<Env> {
  private online = new Map<string, DeviceRec>();
  private tokens = new Map<string, string>(); // deviceId -> token (authoritative)
  private virtual = new Set<string>(); // in-process devices: always online, never swept
  private disabled = new Set<string>(); // deactivated devices: rejected at /mcp + /ws
  private fileIndex = new Map<string, FileIndexEntry>(); // global: fileId -> device
  private budget: R2BudgetState = { month: monthKey(), bytes: 0, classA: 0, classB: 0 };
  private onlineTtlMs = ONLINE_TTL_DEFAULT_MS;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const ttl = parseInt(env.ONLINE_TTL_MS || "", 10);
    if (Number.isFinite(ttl) && ttl > 0) this.onlineTtlMs = ttl;
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
        // Virtual devices: merge their tokens unconditionally (they may be the
        // only entries on a fresh registry) and mark them always-online.
        if (this.env.VIRTUAL_DEVICE_TOKENS) {
          try {
            const seed = JSON.parse(this.env.VIRTUAL_DEVICE_TOKENS) as Record<string, unknown>;
            let changed = false;
            for (const [id, tok] of Object.entries(seed)) {
              if (typeof tok === "string" && validDeviceId(id) && tok.length > 0) {
                this.tokens.set(id, tok);
                changed = true;
              }
            }
            if (changed) await this.persistTokens();
          } catch {}
        }
        for (const id of virtualDeviceIds(this.env)) {
          this.virtual.add(id);
          this.online.set(id, { seenAt: Date.now() });
        }
        const savedDisabled = (await this.ctx.storage.get<string[]>("disabled")) || [];
        for (const id of savedDisabled) {
          if (validDeviceId(id)) this.disabled.add(id);
        }
        const savedBudget = (await this.ctx.storage.get<R2BudgetState>("r2_budget")) || null;
        if (savedBudget && typeof savedBudget.month === "string") {
          this.budget = {
            month: savedBudget.month,
            bytes: Math.max(0, Number(savedBudget.bytes) || 0),
            classA: Math.max(0, Number(savedBudget.classA) || 0),
            classB: Math.max(0, Number(savedBudget.classB) || 0),
          };
        }
        const savedIndex = (await this.ctx.storage.get<Record<string, FileIndexEntry>>("file_index")) || {};
        const now = Date.now();
        for (const [fileId, entry] of Object.entries(savedIndex)) {
          if (entry && validDeviceId(entry.deviceId) && entry.expiresAt > now) this.fileIndex.set(fileId, entry);
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

    if (request.method === "GET" && path === "/disabled") {
      return Response.json({ disabled: [...this.disabled] });
    }

    // ---- file index ----
    // A download URL carries only a file id, but the metadata lives in the
    // per-device FilesDO, so this global map resolves id -> device. Entries
    // expire with their file, so a lookup after expiry returns 404 and drops
    // the entry rather than leaking it forever.

    if (request.method === "POST" && path === "/file-index") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }
      const { fileId, deviceId, expiresAt } = (body || {}) as {
        fileId?: unknown;
        deviceId?: unknown;
        expiresAt?: unknown;
      };
      const id = String(fileId || "");
      const owner = String(deviceId || "");
      const expires = Number(expiresAt);
      if (!FILE_ID_RE.test(id)) return Response.json({ error: "invalid fileId" }, { status: 400 });
      if (!validDeviceId(owner)) return Response.json({ error: "invalid deviceId" }, { status: 400 });
      if (!Number.isFinite(expires)) return Response.json({ error: "invalid expiresAt" }, { status: 400 });
      this.fileIndex.set(id, { deviceId: owner, expiresAt: expires });
      await this.persistFileIndex();
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && path === "/file-unindex") {
      let id = url.searchParams.get("id") || "";
      if (!id) {
        try {
          id = String(((await request.json()) as { fileId?: unknown }).fileId || "");
        } catch {}
      }
      const removed = this.fileIndex.delete(id);
      if (removed) await this.persistFileIndex();
      return Response.json({ ok: true, removed });
    }

    if (request.method === "GET" && path === "/file-lookup") {
      const id = url.searchParams.get("id") || "";
      if (!FILE_ID_RE.test(id)) return Response.json({ error: "invalid fileId" }, { status: 400 });
      const entry = this.fileIndex.get(id);
      if (!entry) return Response.json({ error: "not found" }, { status: 404 });
      if (entry.expiresAt <= Date.now()) {
        this.fileIndex.delete(id);
        await this.persistFileIndex();
        return Response.json({ error: "expired" }, { status: 404 });
      }
      return Response.json({ deviceId: entry.deviceId });
    }

    // ---- R2 monthly budget ----
    // A hard ceiling on what the gateway will let this account spend on R2. The
    // entry asks before an upload, so one device cannot run up the bill, and the
    // bytes are released again when a file is deleted or expires.

    if (request.method === "GET" && path === "/budget") {
      this.rollBudgetMonth();
      return Response.json(this.budgetStatus());
    }

    if (request.method === "POST" && path === "/budget/admit") {
      const body = (await request.json().catch(() => ({}))) as { bytes?: unknown; classA?: unknown };
      const wantBytes = Math.max(0, Number(body.bytes) || 0);
      const wantOps = Math.max(0, Number(body.classA) || 0);
      this.rollBudgetMonth();
      const budget = r2Budget(this.env);
      const projected = r2Cost(
        {
          bytes: this.budget.bytes + wantBytes,
          classA: this.budget.classA + wantOps,
          classB: this.budget.classB,
        },
        budget,
      );
      if (projected.totalUsd > budget.budgetUsd) {
        return Response.json(
          { error: "monthly R2 budget would be exceeded", projected_usd: r2Round(projected.totalUsd), ...this.budgetStatus() },
          { status: 507 },
        );
      }
      this.budget.bytes += wantBytes;
      this.budget.classA += wantOps;
      await this.persistBudget();
      return Response.json({ ok: true, ...this.budgetStatus() });
    }

    if (request.method === "POST" && path === "/budget/release") {
      const body = (await request.json().catch(() => ({}))) as { bytes?: unknown; classA?: unknown };
      const freed = Math.max(0, Number(body.bytes) || 0);
      this.budget.bytes = Math.max(0, this.budget.bytes - freed);
      this.budget.classA += Math.max(0, Number(body.classA) || 0);
      await this.persistBudget();
      return Response.json({ ok: true, ...this.budgetStatus() });
    }

    if (request.method === "POST" && path === "/budget/ops") {
      const body = (await request.json().catch(() => ({}))) as { classA?: unknown; classB?: unknown };
      this.rollBudgetMonth();
      this.budget.classA += Math.max(0, Number(body.classA) || 0);
      this.budget.classB += Math.max(0, Number(body.classB) || 0);
      await this.persistBudget();
      return Response.json({ ok: true, ...this.budgetStatus() });
    }

    // Deactivate/activate a device (persisted). Disabled devices are rejected
    // with 403 by the gateway entry before any request reaches a tunnel/DO.
    if (request.method === "POST" && path === "/setstate") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }
      const { deviceId, disabled } = (body || {}) as { deviceId?: unknown; disabled?: unknown };
      const id = String(deviceId || "").trim();
      if (!validDeviceId(id)) return Response.json({ error: "invalid deviceId" }, { status: 400 });
      const dis = disabled === true || disabled === "true";
      if (dis) this.disabled.add(id);
      else this.disabled.delete(id);
      await this.persistDisabled();
      return Response.json({ ok: true, deviceId: id, disabled: dis });
    }

    if (request.method === "GET" && path === "/full") {
      this.sweep();
      const devices = [...this.tokens.entries()].map(([deviceId, token]) => ({
        deviceId,
        token,
        online: this.online.has(deviceId),
        virtual: this.virtual.has(deviceId),
        disabled: this.disabled.has(deviceId),
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
          virtual: this.virtual.has(deviceId),
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
      this.disabled.delete(id);
      await this.persistTokens();
      await this.persist();
      await this.persistDisabled();
      this.sweep();
      return Response.json({
        ok: true,
        devices: [...this.tokens.entries()].map(([deviceId, t]) => ({
          deviceId,
          token: t,
          online: this.online.has(deviceId),
          virtual: this.virtual.has(deviceId),
        })),
      });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  }

  private sweep(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, rec] of this.online) {
      if (this.virtual.has(id)) continue; // virtual devices never go stale
      if (now - rec.seenAt > this.onlineTtlMs) {
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

  private async persistDisabled(): Promise<void> {
    try {
      await this.ctx.storage.put("disabled", [...this.disabled]);
    } catch {}
  }

  /** Reset the per-month operation counters, keeping the standing byte count. */
  private rollBudgetMonth(): void {
    const key = monthKey();
    if (this.budget.month !== key) {
      this.budget = { month: key, bytes: this.budget.bytes, classA: 0, classB: 0 };
    }
  }

  private budgetStatus(): Record<string, unknown> {
    const budget = r2Budget(this.env);
    const cost = r2Cost(
      { bytes: this.budget.bytes, classA: this.budget.classA, classB: this.budget.classB },
      budget,
    );
    return {
      month: this.budget.month,
      bytes: this.budget.bytes,
      max_bytes: r2MaxBytes(budget),
      class_a_ops: this.budget.classA,
      class_b_ops: this.budget.classB,
      budget_usd: budget.budgetUsd,
      cost_usd: r2Round(cost.totalUsd),
      remaining_usd: r2Round(Math.max(0, budget.budgetUsd - cost.totalUsd)),
      breakdown: {
        storage_usd: r2Round(cost.storageUsd),
        class_a_usd: r2Round(cost.classAUsd),
        class_b_usd: r2Round(cost.classBUsd),
      },
    };
  }

  private async persistBudget(): Promise<void> {
    await this.ctx.storage.put("r2_budget", this.budget);
  }

  private async persistFileIndex(): Promise<void> {
    try {
      await this.ctx.storage.put("file_index", Object.fromEntries(this.fileIndex));
    } catch {}
  }
}
