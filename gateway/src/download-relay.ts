// Ticket-only relay: one outstanding pull per stream and no queued chunks.
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_CHUNK = 64 * 1024;
interface Transfer {
  resolve: (response: Response) => void;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  head: boolean; length: number; received: number; pulling: boolean;
  pullDone?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  overall: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}
export class DownloadRelay {
  private transfers = new Map<string, Transfer>();
  constructor(private send: (frame: unknown) => void, private timeoutMs: number) {}
  start(ticket: string, token: string, signal: AbortSignal): Promise<Response> {
    if (this.transfers.size >= 4) return Promise.resolve(Response.json({ error: "device busy" }, { status: 503 }));
    if (signal.aborted) return Promise.resolve(new Response(null, { status: 499 }));
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const abort = () => this.fail(id, "download cancelled", 499);
      const t: Transfer = {
        resolve, head: false, length: 0, received: 0, pulling: false,
        overall: setTimeout(() => this.fail(id, "download timeout", 504), 600_000),
        cleanup: () => signal.removeEventListener("abort", abort),
      };
      this.transfers.set(id, t);
      signal.addEventListener("abort", abort, { once: true });
      this.arm(id, t);
      try { this.send({ type: "download-start", id, ticket, token }); }
      catch { this.fail(id, "device send failed", 502); }
    });
  }
  frame(msg: Record<string, unknown>): void {
    if (typeof msg.id !== "string") return;
    const id = msg.id;
    const t = this.transfers.get(id);
    if (!t) return;
    try {
      if (msg.type === "download-error") throw new Error("device download failed");
      if (msg.type === "download-head") {
        if (t.head || !Number.isInteger(msg.status)) throw new Error("invalid download head");
        const status = msg.status as number;
        if (status >= 400 && status <= 599) {
          this.finish(id);
          t.resolve(new Response(null, { status, headers: { "cache-control": "no-store" } }));
          return;
        }
        if (status !== 200 || !msg.headers || typeof msg.headers !== "object" || Array.isArray(msg.headers)) throw new Error("invalid download head");
        const headers = new Headers();
        const entries = Object.entries(msg.headers);
        if (entries.length > 16) throw new Error("invalid download headers");
        for (const [name, value] of entries) {
          if (typeof value !== "string" || value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error("invalid download header");
          const lower = name.toLowerCase();
          if (["content-length", "content-type", "content-disposition"].includes(lower)) {
            if (headers.has(lower)) throw new Error("duplicate download header");
            headers.set(lower, value);
          }
        }
        const length = headers.get("content-length") || "";
        if (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > MAX_BYTES) throw new Error("invalid download length");
        t.length = Number(length);
        const disposition = headers.get("content-disposition");
        if (!disposition || !/^attachment(?:;|$)/i.test(disposition)) headers.set("content-disposition", "attachment");
        headers.set("content-type", headers.get("content-type") || "application/octet-stream");
        headers.set("cache-control", "no-store");
        headers.set("x-content-type-options", "nosniff");
        clearTimeout(t.timer);
        t.head = true;
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => { t.controller = controller; },
          pull: () => new Promise<void>((done) => {
            if (!this.transfers.has(id)) { done(); return; }
            t.pulling = true;
            t.pullDone = done;
            this.arm(id, t);
            try { this.send({ type: "download-pull", id }); }
            catch { this.fail(id, "device send failed", 502); }
          }),
          cancel: () => { this.fail(id, "download cancelled", 499); },
        }, { highWaterMark: 0 });
        t.resolve(new Response(body, { status: 200, headers }));
        return;
      }
      if (msg.type !== "download-chunk" || !t.head || !t.pulling || typeof msg.done !== "boolean" || typeof msg.data !== "string") throw new Error("unexpected download frame");
      if (msg.data.length > 4 * Math.ceil(MAX_CHUNK / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(msg.data)) throw new Error("invalid download chunk");
      const raw = atob(msg.data);
      if (raw.length > MAX_CHUNK || btoa(raw) !== msg.data || (!raw.length && !msg.done)) throw new Error("invalid download chunk");
      const total = t.received + raw.length;
      if (total > t.length || (msg.done && total !== t.length)) throw new Error("download length mismatch");
      t.received = total;
      clearTimeout(t.timer);
      t.pulling = false;
      if (raw.length) t.controller!.enqueue(Uint8Array.from(raw, (c) => c.charCodeAt(0)));
      if (msg.done) { t.controller!.close(); this.finish(id); }
      else { const done = t.pullDone; t.pullDone = undefined; done?.(); }
    } catch (e) {
      this.fail(id, e instanceof Error ? e.message : "invalid download frame", 502);
    }
  }
  failAll(reason: string): void { for (const id of this.transfers.keys()) this.fail(id, reason, 503); }
  private arm(id: string, t: Transfer): void {
    clearTimeout(t.timer);
    t.timer = setTimeout(() => this.fail(id, "download timeout", 504), this.timeoutMs);
  }
  private finish(id: string): Transfer | undefined {
    const t = this.transfers.get(id);
    if (!t) return;
    this.transfers.delete(id);
    clearTimeout(t.timer); clearTimeout(t.overall); t.cleanup(); t.pullDone?.();
    return t;
  }
  private fail(id: string, reason: string, status: number): void {
    const t = this.finish(id);
    if (!t) return;
    try { this.send({ type: "download-cancel", id }); } catch {}
    if (t.head) { try { t.controller?.error(new Error(reason)); } catch {} }
    else t.resolve(Response.json({ error: reason }, { status }));
  }
}
