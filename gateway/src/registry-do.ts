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
import {
  ANON_ID_RE,
  ANON_TOKEN_ALPHABET,
  ANON_TOKEN_LENGTH,
  FILE_ID_RE,
  anonConfig,
  r2Budget,
  r2Cost,
  r2MaxBytes,
  r2Round,
  validDeviceId,
  virtualDeviceIds,
} from "./config";

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
 * An anonymous device: created by POST /api/devices/anonymous with a generated
 * id and a 6-character device code. Its id and token live in `tokens` like any
 * other device, so every auth path treats it the same; this record is what makes
 * it anonymous. `ref` is a separate random handle - the admin UI addresses the
 * device by it, so the admin never sees (or can change) the id or the token.
 */
interface AnonRec {
  ref: string;
  createdAt: number;
  lastSeenAt: number | null; // null until it first connects
}

/** Persist an anonymous device's lastSeenAt at most this often (it re-registers every 30s). */
const ANON_SEEN_PERSIST_MS = 5 * 60_000;

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Unbiased device code: rejection-sample bytes into the 36-symbol alphabet. */
function randomDeviceCode(): string {
  const n = ANON_TOKEN_ALPHABET.length; // 36
  const limit = 256 - (256 % n); // 252: bytes at or above it would bias the low symbols
  let out = "";
  while (out.length < ANON_TOKEN_LENGTH) {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < limit && out.length < ANON_TOKEN_LENGTH) out += ANON_TOKEN_ALPHABET[b % n];
    }
  }
  return out;
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
  private anon = new Map<string, AnonRec>(); // deviceId -> record (persisted)
  private anonCreates = new Map<string, number[]>(); // client IP -> recent creation times (memory)
  private anonFailures = new Map<string, number[]>(); // deviceId -> recent wrong-token times (memory)
  private anonLockedUntil = new Map<string, number>(); // deviceId -> lock expiry (memory)

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
        const savedAnon = (await this.ctx.storage.get<Record<string, AnonRec>>("anon_devices")) || {};
        for (const [id, rec] of Object.entries(savedAnon)) {
          // An anonymous record without its token is debris from a partial write.
          if (validDeviceId(id) && this.tokens.has(id) && rec && typeof rec.ref === "string") this.anon.set(id, rec);
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
      const now = Date.now();
      this.online.set(id, { seenAt: now });
      await this.persist();
      const rec = this.anon.get(id);
      if (rec) {
        const stale = rec.lastSeenAt === null || now - rec.lastSeenAt > ANON_SEEN_PERSIST_MS;
        rec.lastSeenAt = now;
        if (stale) await this.persistAnon();
      }
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
      // Anonymous ids are never shown to an operator.
      return Response.json({ devices: [...this.online.keys()].filter((id) => !this.anon.has(id)) });
    }

    // ---- device registry (admin UI) ----

    if (request.method === "GET" && path === "/map") {
      // Expire anonymous devices here too: this is what the entry authenticates
      // against, so a deleted one stops working within the cache TTL.
      await this.gcAnon();
      const now = Date.now();
      return Response.json({
        map: Object.fromEntries(this.tokens),
        anonymous: [...this.anon.keys()],
        locked: [...this.anonLockedUntil].filter(([, until]) => until > now).map(([id]) => id),
      });
    }

    // ---- anonymous devices ----

    if (request.method === "POST" && path === "/anon/create") {
      const policy = anonConfig(this.env);
      if (!policy.enabled) return Response.json({ error: "anonymous devices are disabled" }, { status: 403 });
      const body = (await request.json().catch(() => ({}))) as { ip?: unknown };
      const ip = String(body.ip || "unknown").slice(0, 64);
      const now = Date.now();
      await this.gcAnon();

      // Per-IP creation limit, held here so it is global rather than per isolate.
      const recent = (this.anonCreates.get(ip) || []).filter((t) => now - t < policy.createWindowMs);
      if (recent.length >= policy.createMax) {
        const retry = Math.max(1, policy.createWindowMs - (now - recent[0]));
        return Response.json(
          { error: "rate limited", retry_after_ms: retry },
          { status: 429, headers: { "retry-after": String(Math.ceil(retry / 1000)) } },
        );
      }
      if (this.deviceCount() >= policy.maxDevices) {
        return Response.json({ error: "device limit reached", max_devices: policy.maxDevices }, { status: 503 });
      }

      let id = "";
      do id = "anon-" + randomHex(8);
      while (this.tokens.has(id) || this.virtual.has(id));
      const token = randomDeviceCode();
      this.tokens.set(id, token);
      this.anon.set(id, { ref: randomHex(12), createdAt: now, lastSeenAt: null });
      recent.push(now);
      this.anonCreates.set(ip, recent);
      this.pruneCreates(now, policy.createWindowMs);
      // Token first: an anonymous record without a token is discarded on load,
      // the reverse would be a device nobody can see.
      await this.persistTokens();
      await this.persistAnon();
      return Response.json({ deviceId: id, token }, { status: 201 });
    }

    if (request.method === "GET" && path === "/anon/list") {
      this.sweep();
      await this.gcAnon();
      const policy = anonConfig(this.env);
      const now = Date.now();
      const devices = [...this.anon.entries()]
        .map(([id, rec]) => ({
          ref: rec.ref,
          online: this.online.has(id),
          disabled: this.disabled.has(id),
          locked: (this.anonLockedUntil.get(id) || 0) > now,
          createdAt: rec.createdAt,
          lastSeenAt: rec.lastSeenAt,
        }))
        .sort((a, b) => a.createdAt - b.createdAt);
      return Response.json({ devices, count: this.deviceCount(), max_devices: policy.maxDevices });
    }

    // Internal only (the entry never exposes it): ref -> id + token, so the admin
    // API can act on an anonymous device without the UI ever holding either.
    if (request.method === "GET" && path === "/anon/resolve") {
      const ref = url.searchParams.get("ref") || "";
      for (const [id, rec] of this.anon) {
        if (rec.ref === ref) return Response.json({ deviceId: id, token: this.tokens.get(id) });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    }

    // A wrong device code for an anonymous device. Six characters is a small
    // space, so too many misses lock the device for everyone until the window
    // passes - enforced here, globally, rather than per isolate.
    if (request.method === "POST" && path === "/anon/fail") {
      const id = url.searchParams.get("id") || "";
      if (!this.anon.has(id)) return Response.json({ locked: false });
      const policy = anonConfig(this.env);
      const now = Date.now();
      const misses = (this.anonFailures.get(id) || []).filter((t) => now - t < policy.authLockMs);
      misses.push(now);
      this.anonFailures.set(id, misses);
      const locked = misses.length >= policy.authMaxFailures;
      if (locked) this.anonLockedUntil.set(id, now + policy.authLockMs);
      return Response.json({ locked });
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
      await this.gcAnon();
      const devices = [...this.tokens.entries()]
        .filter(([deviceId]) => !this.anon.has(deviceId))
        .map(([deviceId, token]) => ({
          deviceId,
          token,
          online: this.online.has(deviceId),
          virtual: this.virtual.has(deviceId),
          disabled: this.disabled.has(deviceId),
        }));
      return Response.json({ devices, count: this.deviceCount(), max_devices: anonConfig(this.env).maxDevices });
    }

    if (request.method === "POST" && path === "/upsert") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }
      const { deviceId, token, replaces } = (body || {}) as { deviceId?: unknown; token?: unknown; replaces?: unknown };
      const id = String(deviceId || "").trim();
      const tok = String(token || "").trim();
      const old = String(replaces || "").trim();
      if (!validDeviceId(id)) return Response.json({ error: "invalid deviceId" }, { status: 400 });
      if (!tok || tok.length > TOKEN_MAX) {
        return Response.json({ error: "token must be 1-" + TOKEN_MAX + " chars" }, { status: 400 });
      }
      // The anonymous namespace is the gateway's: an admin-made "anon-..." device
      // would be indistinguishable from one, and overwriting a live anonymous
      // device would hijack it.
      if (ANON_ID_RE.test(id) || this.anon.has(id)) {
        return Response.json({ error: "device ids starting with anon- are reserved for anonymous devices" }, { status: 400 });
      }
      // A rename (id changed in the UI) replaces a registered device in one step,
      // so it still works with the registry full.
      const renaming = old !== "" && old !== id && this.tokens.has(old) && !this.anon.has(old) && !this.virtual.has(old);
      await this.gcAnon();
      const max = anonConfig(this.env).maxDevices;
      if (!this.tokens.has(id) && !renaming && this.deviceCount() >= max) {
        return Response.json({ error: "device limit reached (" + max + " devices, registered and anonymous)", max_devices: max }, { status: 409 });
      }
      this.tokens.set(id, tok);
      if (renaming) {
        this.tokens.delete(old);
        this.online.delete(old);
        if (this.disabled.delete(old)) await this.persistDisabled();
        await this.persist();
      }
      await this.persistTokens();
      this.sweep();
      return Response.json({
        ok: true,
        devices: [...this.tokens.entries()].filter(([deviceId]) => !this.anon.has(deviceId)).map(([deviceId, t]) => ({
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
      await this.removeDevice(id);
      this.sweep();
      return Response.json({
        ok: true,
        devices: [...this.tokens.entries()].filter(([deviceId]) => !this.anon.has(deviceId)).map(([deviceId, t]) => ({
          deviceId,
          token: t,
          online: this.online.has(deviceId),
          virtual: this.virtual.has(deviceId),
        })),
      });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  }

  /** Devices that count against MAX_DEVICES: registered and anonymous, not virtual. */
  private deviceCount(): number {
    let n = 0;
    for (const id of this.tokens.keys()) if (!this.virtual.has(id)) n++;
    return n;
  }

  private async removeDevice(id: string): Promise<void> {
    this.tokens.delete(id);
    this.online.delete(id);
    this.disabled.delete(id);
    const wasAnon = this.anon.delete(id);
    this.anonFailures.delete(id);
    this.anonLockedUntil.delete(id);
    await this.persistTokens();
    await this.persist();
    await this.persistDisabled();
    if (wasAnon) await this.persistAnon();
  }

  /**
   * Delete anonymous devices nobody is using: never connected within
   * ANON_UNUSED_TTL_MS of creation, or offline for ANON_IDLE_TTL_MS. Without
   * this, abandoned `mcp connect` runs would fill the device cap for good.
   */
  private async gcAnon(): Promise<void> {
    if (this.anon.size === 0) return;
    const policy = anonConfig(this.env);
    const now = Date.now();
    this.sweep();
    const doomed: string[] = [];
    for (const [id, rec] of this.anon) {
      if (this.online.has(id)) continue;
      const age = rec.lastSeenAt === null ? now - rec.createdAt : now - rec.lastSeenAt;
      const ttl = rec.lastSeenAt === null ? policy.unusedTtlMs : policy.idleTtlMs;
      if (age > ttl) doomed.push(id);
    }
    for (const id of doomed) {
      this.tokens.delete(id);
      this.online.delete(id);
      this.disabled.delete(id);
      this.anon.delete(id);
      this.anonFailures.delete(id);
      this.anonLockedUntil.delete(id);
    }
    if (doomed.length) {
      await this.persistTokens();
      await this.persist();
      await this.persistDisabled();
      await this.persistAnon();
    }
    for (const [id, until] of this.anonLockedUntil) if (until <= now) this.anonLockedUntil.delete(id);
  }

  /** Bound the per-IP creation map: drop IPs with nothing left in the window. */
  private pruneCreates(now: number, windowMs: number): void {
    if (this.anonCreates.size < 1000) return;
    for (const [ip, times] of this.anonCreates) {
      if (!times.some((t) => now - t < windowMs)) this.anonCreates.delete(ip);
    }
  }

  private async persistAnon(): Promise<void> {
    try {
      await this.ctx.storage.put("anon_devices", Object.fromEntries(this.anon));
    } catch {}
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
