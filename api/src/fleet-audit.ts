/**
 * The fleet's audit log: what was done to it, by whom, in an order nobody can change afterwards.
 *
 * One row per entry in the fleet object's own storage, key `audit:` and the number padded to twelve digits, so
 * that listing the rows lists them in order. Each entry carries `prev`, the SHA-256 of the entry before it
 * (its canonical JSON, `prev` included), so removing, changing or reordering an entry shows in the entry after
 * it, and the head - the number and hash of the last entry - is what somebody keeps to check the rest against.
 *
 * What is logged is who and what, never what a call carried: a relayed call is its method, its tool's name and
 * its size; an invite is its lifetime, never its code; a key is its fingerprint.
 *
 * Growth is bounded. The object keeps the newest `AUDIT_KEEP` entries (and up to `AUDIT_BATCH` more): when it
 * holds that many the oldest `AUDIT_BATCH` are written to the bucket, as one file, and then taken out of the
 * object. The first entry that is left carries the hash of the last that went, so the chain runs across the two.
 * When the bucket cannot be written for so long that the object holds `AUDIT_HARD` entries, the oldest batch is
 * dropped without a copy and the log says so in an entry of its own, so that a gap is never silent.
 */

/** Who did it, as far as the gateway can tell. */
export interface AuditActor {
  /**
   * `operator`: the fleet operator token. `access`: a person who came through Access (`email`) or a service
   * token (`id`). `owner`: the fleet's own owner device, acting as its operator. `device`: a member. `fleet-token`:
   * a client that came with the fleet's own token. `gateway`: the gateway on its own account.
   */
  kind: "operator" | "access" | "owner" | "device" | "fleet-token" | "gateway";
  id?: string;
  email?: string;
}

/** What an entry may say besides who and what: short plain values, so nothing a caller sent can ride in it. */
export type AuditDetail = Record<string, string | number | boolean | null>;

export interface AuditEntry {
  /** Its number: one more than the entry before. */
  n: number;
  /** The SHA-256 (hex) of the entry before this one; `GENESIS` for the first. */
  prev: string;
  /** When, in milliseconds. */
  at: number;
  actor: AuditActor;
  action: string;
  /** The device (or other thing) it was done to, when there is one. */
  target?: string;
  detail?: AuditDetail;
}

export type AuditInput = Pick<AuditEntry, "actor" | "action"> & { target?: string; detail?: AuditDetail };

/** The `prev` of the first entry of a log. */
export const GENESIS = "0".repeat(64);
/** Entries kept in the object. */
export const AUDIT_KEEP = 10_000;
/** How many go to the bucket at once, and how far past `AUDIT_KEEP` the object may be before they do. */
export const AUDIT_BATCH = 1_000;
/** The most the object holds when the bucket will not take them: past it the oldest batch is dropped (and says so). */
export const AUDIT_HARD = 30_000;
/** The most entries one read answers. */
export const AUDIT_PAGE_MAX = 500;
/** How long after a failed copy to the bucket the next one is tried. */
const ARCHIVE_RETRY_MS = 60_000;
/** The most keys one storage delete takes. */
const DELETE_CHUNK = 128;

const PREFIX = "audit:";
const key = (n: number): string => PREFIX + String(n).padStart(12, "0");

/** What the log needs of storage: the few calls of a Durable Object's, and nothing else. */
export interface AuditStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T>(options: { prefix: string; start?: string; limit?: number; reverse?: boolean }): Promise<Map<string, T>>;
}

/** JSON with its keys in order and nothing undefined, so that the same entry is the same bytes whoever wrote it. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map((v) => canonical(v)).join(",") + "]";
  const parts: string[] = [];
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[k];
    if (v === undefined) continue;
    parts.push(JSON.stringify(k) + ":" + canonical(v));
  }
  return "{" + parts.join(",") + "}";
}

/** The hash an entry's successor carries as its `prev`. */
export async function entryHash(entry: AuditEntry): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(entry))));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether these entries, in order, are a chain: each one's number is one more than the one before, and its `prev` is
 * that one's hash. `prev` is the hash the first is expected to carry (`GENESIS` for a log from the start, or the
 * last hash of what came before when it is a later part). Returns the number of the first entry that does not
 * follow, or null when all do.
 */
export async function brokenAt(entries: AuditEntry[], prev: string = GENESIS): Promise<number | null> {
  let expect = prev;
  let last: number | undefined;
  for (const e of entries) {
    if (e.prev !== expect || (last !== undefined && e.n !== last + 1)) return e.n;
    expect = await entryHash(e);
    last = e.n;
  }
  return null;
}

const MAX_TEXT = 120;
const text = (v: string): string => (v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) : v);

/** A detail with only short plain values: a longer text is cut, anything that is not a plain value is left out. */
export function cleanDetail(detail: AuditDetail | undefined): AuditDetail | undefined {
  if (!detail) return undefined;
  const out: AuditDetail = {};
  for (const [k, v] of Object.entries(detail)) {
    if (typeof v === "string") out[k] = text(v);
    else if (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Who a call is from, as the gateway says it.
 *
 * `header` is `x-prime-actor`, which the Worker sets itself and drops from every request it takes in: an operator
 * who came through Access is `access:<email>` (`access:service:<name>` for a service token), the gateway acting on
 * its own is `gateway`, a fleet token's client `fleet-token`, and `device:<id>` a device the gateway acts for (the
 * one that asks for an abandoned fleet to be cleared away). Only a call that is the operator's is believed: a
 * device's actor is the device. No header on an operator call is the fleet operator token.
 */
export function actorOf(kind: "admin" | "device", deviceId: string, header: string | null, asOwner: boolean): AuditActor {
  if (kind === "device") return { kind: asOwner ? "owner" : "device", id: text(deviceId) };
  const h = (header ?? "").trim();
  if (h.startsWith("access:service:") && h.length > "access:service:".length) return { kind: "access", id: text("service:" + h.slice("access:service:".length)) };
  if (h.startsWith("access:") && h.length > "access:".length) return { kind: "access", email: text(h.slice("access:".length)) };
  if (h.startsWith("device:") && h.length > "device:".length) return { kind: "device", id: text(h.slice("device:".length)) };
  if (h === "fleet-token") return { kind: "fleet-token" };
  if (h === "gateway") return { kind: "gateway" };
  return { kind: "operator" };
}

export class AuditLog {
  /** The last entry's number and hash, once read. */
  private head: { n: number; hash: string } | undefined;
  /** The number of the oldest entry the object holds, 0 when it holds none. */
  private first = 0;
  private loaded = false;
  /** Appends one after another: an entry's number and `prev` come from the one before it. */
  private queue: Promise<unknown> = Promise.resolve();
  private lastArchiveFailure = 0;

  constructor(
    private readonly store: AuditStore,
    /** Where a file of entries is kept (the bucket), by name. */
    private readonly archive: (name: string, body: string) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    const newest = [...(await this.store.list<AuditEntry>({ prefix: PREFIX, reverse: true, limit: 1 })).values()][0];
    const oldest = [...(await this.store.list<AuditEntry>({ prefix: PREFIX, limit: 1 })).values()][0];
    this.head = newest ? { n: newest.n, hash: await entryHash(newest) } : { n: 0, hash: GENESIS };
    this.first = oldest ? oldest.n : 0;
    this.loaded = true;
  }

  /** Add an entry. Resolves with it once it is stored; a log that cannot store it rejects, and nothing is recorded. */
  append(input: AuditInput): Promise<AuditEntry> {
    const run = async (): Promise<AuditEntry> => {
      await this.load();
      return this.write(input);
    };
    const done = this.queue.then(run, run);
    this.queue = done.catch(() => undefined);
    return done;
  }

  /**
   * Whether the object holds more than it should, so that `trim` has work. Answered from what is known without a
   * read, so that it can be asked after every request: a log that has not been touched since the object woke holds
   * what it held, and is trimmed when something is next written.
   */
  due(): boolean {
    return this.loaded && this.first !== 0 && this.head!.n - this.first + 1 >= AUDIT_KEEP + AUDIT_BATCH;
  }

  /**
   * Move the oldest entries to the bucket and out of the object (see the top of this file). It reaches the network, so
   * it is not run while the object is held shut for a decision; a failure is logged and tried again a minute later.
   */
  trim(archiveName: string): Promise<void> {
    const run = async (): Promise<void> => {
      await this.load();
      await this.keepBounded(archiveName).catch((e) => console.error("audit: could not trim the log: " + String(e)));
    };
    const done = this.queue.then(run, run);
    this.queue = done.catch(() => undefined);
    return done;
  }

  private async write(input: AuditInput): Promise<AuditEntry> {
    const head = this.head!;
    const detail = cleanDetail(input.detail);
    const entry: AuditEntry = {
      n: head.n + 1,
      prev: head.hash,
      at: this.now(),
      actor: input.actor,
      action: input.action,
      ...(input.target !== undefined ? { target: text(input.target) } : {}),
      ...(detail ? { detail } : {}),
    };
    await this.store.put(key(entry.n), entry);
    this.head = { n: entry.n, hash: await entryHash(entry) };
    if (this.first === 0) this.first = entry.n;
    return entry;
  }

  /** The entries after number `after`, at most `limit`, and where the log stands. */
  async read(after: number, limit: number): Promise<{ entries: AuditEntry[]; head: { n: number; hash: string }; first: number }> {
    await this.queue.catch(() => undefined);
    await this.load();
    const from = Math.max(Math.floor(after), 0) + 1;
    const cap = Math.min(Math.max(Math.floor(limit), 1), AUDIT_PAGE_MAX);
    const rows = await this.store.list<AuditEntry>({ prefix: PREFIX, start: key(from), limit: cap });
    return { entries: [...rows.values()], head: { ...this.head! }, first: this.first };
  }

  /** The newest `count` entries, for a page that shows what happened last. */
  async readLast(count: number): Promise<{ entries: AuditEntry[]; head: { n: number; hash: string }; first: number }> {
    await this.queue.catch(() => undefined);
    await this.load();
    return this.read(Math.max(this.head!.n - Math.min(Math.max(Math.floor(count), 1), AUDIT_PAGE_MAX), 0), AUDIT_PAGE_MAX);
  }

  /** The entries the object holds. */
  async held(): Promise<number> {
    await this.load();
    return this.first === 0 ? 0 : this.head!.n - this.first + 1;
  }

  private async keepBounded(archiveName: string): Promise<void> {
    const held = this.head!.n - this.first + 1;
    if (this.first === 0 || held < AUDIT_KEEP + AUDIT_BATCH) return;
    if (this.now() - this.lastArchiveFailure < ARCHIVE_RETRY_MS && held < AUDIT_HARD) return;
    const rows = await this.store.list<AuditEntry>({ prefix: PREFIX, limit: AUDIT_BATCH });
    const batch = [...rows.values()];
    if (batch.length === 0) return;
    let copied = true;
    try {
      await this.archive(this.fileName(archiveName, batch[0]!), batch.map((e) => JSON.stringify(e)).join("\n") + "\n");
    } catch (e) {
      copied = false;
      this.lastArchiveFailure = this.now();
      console.error("audit: could not copy " + batch.length + " entries to the bucket: " + String(e));
    }
    if (!copied && held < AUDIT_HARD) return;
    await this.remove([...rows.keys()]);
    this.first = batch[batch.length - 1]!.n + 1;
    if (!copied) {
      // The log says what it lost, so that nobody takes the hole for the whole: this entry's `prev` is the hash of the
      // entry before it, which is of the log that was dropped, and the first one left carries a `prev` nothing here shows.
      await this.write({ actor: { kind: "gateway" }, action: "audit-dropped", detail: { from: batch[0]!.n, to: batch[batch.length - 1]!.n } });
    }
  }

  /** The name of a file of entries that begins with `firstEntry`: unique to the fleet's life, and in the order they were made. */
  private fileName(prefix: string, firstEntry: AuditEntry): string {
    return prefix + String(firstEntry.at).padStart(13, "0") + "-" + String(firstEntry.n).padStart(12, "0") + ".jsonl";
  }

  private async remove(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += DELETE_CHUNK) await this.store.delete(keys.slice(i, i + DELETE_CHUNK));
  }

  /**
   * Everything the object holds, copied to the bucket and then taken out of the object: for a fleet that is being
   * deleted, whose record of who did that must outlive it. Resolves false when the copy failed (the entries are
   * taken out of the object all the same: the fleet is going).
   */
  async retire(archiveName: string): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      await this.load();
      let ok = true;
      for (;;) {
        const rows = await this.store.list<AuditEntry>({ prefix: PREFIX, limit: AUDIT_BATCH });
        const batch = [...rows.values()];
        if (batch.length === 0) break;
        try {
          await this.archive(this.fileName(archiveName, batch[0]!), batch.map((e) => JSON.stringify(e)).join("\n") + "\n");
        } catch (e) {
          ok = false;
          console.error("audit: could not copy " + batch.length + " entries to the bucket: " + String(e));
        }
        await this.remove([...rows.keys()]);
      }
      this.head = { n: 0, hash: GENESIS };
      this.first = 0;
      return ok;
    };
    const done = this.queue.then(run, run);
    this.queue = done.catch(() => undefined);
    return done;
  }
}

/** The most of a call that is read to name it: a larger body is not parsed for it. */
const DESCRIBE_MAX_BYTES = 256 * 1024;

/**
 * What a relayed call is, as `<method>:<tool>` (just `<method>` when it is not a tool call), for the log: the JSON-RPC
 * method and the tool's name, and nothing of the arguments, which are not kept. A body that is not one call, or is
 * too large to be worth reading, is `?`; a batch is `batch`. The name is cut to what the log accepts later.
 */
export function describeCall(body: ArrayBuffer): string {
  if (body.byteLength === 0 || body.byteLength > DESCRIBE_MAX_BYTES) return "?";
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return "?";
  }
  if (Array.isArray(parsed)) return "batch";
  if (parsed === null || typeof parsed !== "object") return "?";
  const call = parsed as { method?: unknown; params?: unknown };
  if (typeof call.method !== "string") return "?";
  const params = call.params;
  const tool = params !== null && typeof params === "object" ? (params as { name?: unknown }).name : undefined;
  return call.method + (call.method === "tools/call" && typeof tool === "string" ? ":" + tool : "");
}
