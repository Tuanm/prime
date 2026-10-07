// FilesDO - one instance per deviceId, holding that device's temporary file
// *metadata* and enforcing its quotas. Contents live in R2 under
// `<deviceId>/<fileId>`; this object never touches the bytes except to delete
// them, so a 200 MiB upload never passes through Durable Object storage.
//
// Quotas are enforced here rather than in the Worker entry because they are
// read-modify-write: two concurrent uploads must not both see "4 of 5 files".
//
// The pending/ready split is what the UI's grey dot means. An upload reserves a
// slot (status "pending"), streams the body to R2, then completes it. A
// reservation that never completes is reaped, so a failed upload cannot leak a
// slot forever.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./config";
import { fileLimits, validFileId, validDeviceId } from "./config";

/** A reservation with no completed upload is dropped after this long. */
export const PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour

export const FILE_NAME_MAX = 200;

export interface FileRecord {
  id: string;
  deviceId: string;
  name: string;
  /** Declared size at reserve time; the measured size once ready. */
  size: number;
  contentType: string;
  createdAt: number;
  expiresAt: number;
  /** Optional protection key required to download. */
  key?: string;
  status: "pending" | "ready";
}

export interface FileUsage {
  count: number; // non-expired files (what the 5-file cap counts)
  bytes: number; // every record, expired-but-undeleted included
}

const STORAGE_KEY = "files";

/** Strip anything that could confuse a header or a path. */
export function sanitizeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/^\s+|\s+$/g, "");
  return cleaned.slice(0, FILE_NAME_MAX);
}

export class FilesDO extends DurableObject<Env> {
  private files = new Map<string, FileRecord>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      try {
        const saved = (await this.ctx.storage.get<Record<string, FileRecord>>(STORAGE_KEY)) ?? {};
        for (const [id, rec] of Object.entries(saved)) {
          if (rec && validFileId(id)) this.files.set(id, rec);
        }
      } catch {}
      await this.reap();
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "POST" && path === "/reserve") return this.reserve(request);
    if (request.method === "POST" && path === "/complete") return this.complete(request);
    if (request.method === "POST" && path === "/abort") return this.abort(request);
    if (request.method === "POST" && path === "/delete") return this.remove(request);
    if (request.method === "GET" && path === "/list") return this.list();
    if (request.method === "GET" && path === "/get") {
      const id = url.searchParams.get("id") ?? "";
      if (!validFileId(id)) return Response.json({ error: "invalid file id" }, { status: 400 });
      await this.reap();
      const rec = this.files.get(id);
      if (!rec) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({ file: rec });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  /** Wake hourly at minimum so an idle device still purges expiring files. */
  async alarm(): Promise<void> {
    await this.reap();
  }

  // ---- operations ---------------------------------------------------------

  private async reserve(request: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 });
    }

    const deviceId = String(body.deviceId ?? "");
    if (!validDeviceId(deviceId)) return Response.json({ error: "invalid deviceId" }, { status: 400 });

    const name = sanitizeFileName(String(body.name ?? ""));
    if (!name) return Response.json({ error: "missing file name" }, { status: 400 });

    const size = Number(body.size);
    if (!Number.isFinite(size) || size < 0) return Response.json({ error: "invalid size" }, { status: 400 });

    const limits = fileLimits(this.env);
    if (size > limits.maxUploadBytes) {
      return Response.json(
        { error: "file too large", limit_bytes: limits.maxUploadBytes, size },
        { status: 413 },
      );
    }

    const now = Date.now();
    const expiresAt = Number(body.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      return Response.json({ error: "expiry must be in the future" }, { status: 400 });
    }
    if (expiresAt - now > limits.maxExpiryMs) {
      return Response.json(
        { error: "expiry too far in the future", limit_ms: limits.maxExpiryMs },
        { status: 400 },
      );
    }

    await this.reap();

    const active = [...this.files.values()].filter((r) => now < r.expiresAt).length;
    if (active >= limits.maxPerDevice) {
      return Response.json(
        { error: "file limit reached", limit_files: limits.maxPerDevice, files: active },
        { status: 409 },
      );
    }

    // Total counts expired-but-undeleted records too, as specified.
    const totalBytes = [...this.files.values()].reduce((sum, r) => sum + (r.size || 0), 0);
    if (totalBytes + size > limits.maxTotalBytes) {
      return Response.json(
        { error: "storage limit reached", limit_bytes: limits.maxTotalBytes, used_bytes: totalBytes },
        { status: 413 },
      );
    }

    const rawKey = body.key === undefined || body.key === null ? "" : String(body.key);
    if (rawKey.length > 256) return Response.json({ error: "key too long" }, { status: 400 });

    const record: FileRecord = {
      id: crypto.randomUUID().replace(/-/g, ""),
      deviceId,
      name,
      size,
      contentType: String(body.contentType ?? "application/octet-stream").slice(0, 200),
      createdAt: now,
      expiresAt,
      ...(rawKey ? { key: rawKey } : {}),
      status: "pending",
    };
    this.files.set(record.id, record);
    await this.persist();
    await this.scheduleAlarm();

    return Response.json({ ok: true, file: record }, { status: 201 });
  }

  private async complete(request: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 });
    }
    const id = String(body.id ?? "");
    if (!validFileId(id)) return Response.json({ error: "invalid file id" }, { status: 400 });
    const record = this.files.get(id);
    if (!record) return Response.json({ error: "not found" }, { status: 404 });

    // The body may have been shorter or longer than declared, so re-check the
    // total against the measured size before accepting the upload.
    const measured = Number(body.size);
    const size = Number.isFinite(measured) && measured >= 0 ? measured : record.size;
    const limits = fileLimits(this.env);
    const others = [...this.files.values()].filter((r) => r.id !== id).reduce((sum, r) => sum + (r.size || 0), 0);
    if (others + size > limits.maxTotalBytes) {
      this.files.delete(id);
      await this.persist();
      await this.deleteObject(record);
      return Response.json(
        { error: "storage limit reached", limit_bytes: limits.maxTotalBytes, used_bytes: others },
        { status: 413 },
      );
    }

    record.size = size;
    record.status = "ready";
    await this.persist();
    return Response.json({ ok: true, file: record });
  }

  private async abort(request: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 });
    }
    const id = String(body.id ?? "");
    if (!validFileId(id)) return Response.json({ error: "invalid file id" }, { status: 400 });
    const record = this.files.get(id);
    if (record) {
      this.files.delete(id);
      await this.persist();
      await this.deleteObject(record);
    }
    return Response.json({ ok: true, removed: Boolean(record) });
  }

  private async remove(request: Request): Promise<Response> {
    return this.abort(request);
  }

  private async list(): Promise<Response> {
    await this.reap();
    const now = Date.now();
    const files = [...this.files.values()]
      .filter((r) => now < r.expiresAt)
      .sort((a, b) => b.createdAt - a.createdAt);
    return Response.json({ files, usage: this.usage() });
  }

  // ---- internals ----------------------------------------------------------

  private usage(): FileUsage {
    const now = Date.now();
    let bytes = 0;
    let count = 0;
    for (const rec of this.files.values()) {
      bytes += rec.size || 0;
      if (now < rec.expiresAt) count++;
    }
    return { count, bytes };
  }

  private objectKey(record: FileRecord): string {
    return `${record.deviceId}/${record.id}`;
  }

  private async deleteObject(record: FileRecord): Promise<void> {
    try {
      await this.env.BUCKET?.delete(this.objectKey(record));
    } catch {}
  }

  /**
   * Permanently drop expired files and abandoned reservations.
   *
   * Both the object and the metadata go, so an expired file is neither listed
   * nor stored - the spec's "expired files are not displayed or stored".
   */
  private async reap(): Promise<number> {
    const now = Date.now();
    let removed = 0;
    for (const [id, rec] of [...this.files.entries()]) {
      const expired = now >= rec.expiresAt;
      const abandoned = rec.status === "pending" && now - rec.createdAt > PENDING_TTL_MS;
      if (!expired && !abandoned) continue;
      this.files.delete(id);
      await this.deleteObject(rec);
      removed++;
    }
    if (removed > 0) await this.persist();
    await this.scheduleAlarm();
    return removed;
  }

  /** Wake at the next expiry (or pending deadline), at least hourly. */
  private async scheduleAlarm(): Promise<void> {
    let next = Number.POSITIVE_INFINITY;
    for (const rec of this.files.values()) {
      next = Math.min(next, rec.expiresAt);
      if (rec.status === "pending") next = Math.min(next, rec.createdAt + PENDING_TTL_MS);
    }
    const ceiling = Date.now() + 60 * 60 * 1000;
    try {
      if (next === Number.POSITIVE_INFINITY) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(Math.min(next, ceiling));
    } catch {}
  }

  private async persist(): Promise<void> {
    try {
      await this.ctx.storage.put(STORAGE_KEY, Object.fromEntries(this.files));
    } catch {}
  }
}
