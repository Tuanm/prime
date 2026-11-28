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
 * follow, or null when all do. `firstN` is the number the first entry must have (the kept head's number plus one).
 */
export async function brokenAt(entries: AuditEntry[], prev: string = GENESIS, firstN?: number): Promise<number | null> {
  let expect = prev;
  // A reader that keeps the head it last saw (`{n, hash}`) passes `n + 1` and the hash: the first entry must follow that one.
  let last: number | undefined = firstN === undefined ? undefined : firstN - 1;
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

/** The sizes the log is kept to: constants, or lower ones where a test must see a trim in a few entries. */
export interface AuditLimits {
  keep: number;
  batch: number;
  hard: number;
}
export const DEFAULT_LIMITS: AuditLimits = { keep: AUDIT_KEEP, batch: AUDIT_BATCH, hard: AUDIT_HARD };

/**
 * The limits in force. FLEET_AUDIT_KEEP and FLEET_AUDIT_BATCH may only make them smaller (to 4 and 2 at the least), so
 * that a smoke test can reach a trim in a few entries; a value that would raise them is not used.
 */
export function auditLimits(env: { FLEET_AUDIT_KEEP?: string; FLEET_AUDIT_BATCH?: string }): AuditLimits {
  const small = (v: string | undefined, max: number, min: number): number | undefined => {
    const n = Number(v);
    return v !== undefined && Number.isInteger(n) && n >= min && n < max ? n : undefined;
  };
  const keep = small(env.FLEET_AUDIT_KEEP, AUDIT_KEEP, 4) ?? AUDIT_KEEP;
  const batch = Math.min(small(env.FLEET_AUDIT_BATCH, AUDIT_BATCH, 2) ?? AUDIT_BATCH, keep);
  return { keep, batch, hard: keep === AUDIT_KEEP ? AUDIT_HARD : keep * 3 };
}

/**
 * The log over one fleet object's storage.
 *
 * Nothing in here holds the append queue across a call that leaves the object (the bucket): a decision that is
 * being made inside `blockConcurrencyWhile` appends to this log, and waits for the queue, and the continuation of a
 * call that went out would not run while the object is held shut for that decision. A trim or a retirement takes
 * the queue to look and again to delete, and copies to the bucket in between with it let go.
 */
export class AuditLog {
  /** The last entry's number and hash, once read. */
  private head: { n: number; hash: string } | undefined;
  /** The number of the oldest entry the object holds, 0 when it holds none. */
  private first = 0;
  private loading: Promise<void> | undefined;
  private loaded = false;
  /** Appends one after another: an entry's number and `prev` come from the one before it. */
  private queue: Promise<unknown> = Promise.resolve();
  private lastArchiveFailure = 0;
  private trimming = false;

  constructor(
    private readonly store: AuditStore,
    /** Keeps a file of entries (in the bucket), by name; `meta` says whose they are. */
    private readonly archive: (name: string, body: string, meta: Record<string, string>) => Promise<void>,
    /** Where this fleet's files go (`audit/<fleet>/`), or null while the fleet's name is not known: nothing is archived then. */
    private readonly prefix: () => Promise<string | null> = async () => "audit/unknown/",
    private readonly now: () => number = Date.now,
    private readonly limits: AuditLimits = DEFAULT_LIMITS,
  ) {}

  /** Read once, by whoever comes first: two that load at once share one read, so neither can set the head back. */
  private load(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    this.loading ??= (async () => {
      const newest = [...(await this.store.list<AuditEntry>({ prefix: PREFIX, reverse: true, limit: 1 })).values()][0];
      const oldest = [...(await this.store.list<AuditEntry>({ prefix: PREFIX, limit: 1 })).values()][0];
      this.head = newest ? { n: newest.n, hash: await entryHash(newest) } : { n: 0, hash: GENESIS };
      this.first = oldest ? oldest.n : 0;
      this.loaded = true;
    })().catch((e) => {
      this.loading = undefined;
      throw e;
    });
    return this.loading;
  }

  /** Run `work` after what is queued, alone: one step on the log at a time, never across a call that leaves the object. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      await this.load();
      return work();
    };
    const done = this.queue.then(run, run);
    this.queue = done.catch(() => undefined);
    return done;
  }

  /** Add an entry. Resolves with it once it is stored; a log that cannot store it rejects, and nothing is recorded. */
  append(input: AuditInput): Promise<AuditEntry> {
    return this.exclusive(() => this.write(input));
  }

  /**
   * Whether the object holds more than it should, so that `trim` has work. Answered from what is known without a
   * read, so that it can be asked after every request: a log that has not been touched since the object woke holds
   * what it held, and is trimmed when something is next written.
   */
  due(): boolean {
    return !this.trimming && this.loaded && this.first !== 0 && this.head!.n - this.first + 1 >= this.limits.keep + this.limits.batch;
  }

  /**
   * Move the oldest entries to the bucket and out of the object (see the top of this file): look under the queue, copy
   * with it let go, delete under it again. A failure is logged and tried again a minute later; only one runs at a time.
   */
  async trim(): Promise<void> {
    if (this.trimming) return;
    this.trimming = true;
    try {
      const prefix = await this.prefix();
      if (prefix === null) return;
      const looked = await this.exclusive(async () => {
        const held = this.head!.n - this.first + 1;
        if (this.first === 0 || held < this.limits.keep + this.limits.batch) return null;
        if (this.now() - this.lastArchiveFailure < ARCHIVE_RETRY_MS && held < this.limits.hard) return null;
        const rows = await this.store.list<AuditEntry>({ prefix: PREFIX, limit: this.limits.batch });
        return rows.size === 0 ? null : { rows: [...rows.values()], held };
      });
      if (!looked) return;
      const { rows: batch } = looked;
      let copied = true;
      try {
        await this.archive(this.fileName(prefix, batch[0]!), this.lines(batch), { fleet: prefix.split("/")[1] ?? "", first: String(batch[0]!.n), last: String(batch[batch.length - 1]!.n) });
      } catch (e) {
        copied = false;
        this.lastArchiveFailure = this.now();
        console.error("audit: could not copy " + batch.length + " entries to the bucket: " + String(e));
      }
      await this.exclusive(async () => {
        // The same batch is still the oldest, and the copy is there (or the object is full of what it could not copy).
        if (this.first !== batch[0]!.n) return;
        if (!copied && this.head!.n - this.first + 1 < this.limits.hard) return;
        await this.remove(batch.map((e) => key(e.n)));
        this.first = batch[batch.length - 1]!.n + 1;
        if (!copied) {
          // The log says what it lost, so that nobody takes the hole for the whole: the first entry left carries the hash of
          // the last one that went, so the chain shows it, and this entry says which numbers they were.
          await this.write({ actor: { kind: "gateway" }, action: "audit-dropped", detail: { from: batch[0]!.n, to: batch[batch.length - 1]!.n } });
        }
      });
    } catch (e) {
      console.error("audit: could not trim the log: " + String(e));
    } finally {
      this.trimming = false;
    }
  }

  private lines(batch: AuditEntry[]): string {
    return batch.map((e) => JSON.stringify(e)).join("\n") + "\n";
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
    return this.exclusive(async () => {
      const from = Math.max(Math.floor(after), 0) + 1;
      const cap = Math.min(Math.max(Math.floor(limit), 1), AUDIT_PAGE_MAX);
      const rows = await this.store.list<AuditEntry>({ prefix: PREFIX, start: key(from), limit: cap });
      return { entries: [...rows.values()], head: { ...this.head! }, first: this.first };
    });
  }

  /** The newest `count` entries, for a page that shows what happened last. */
  async readLast(count: number): Promise<{ entries: AuditEntry[]; head: { n: number; hash: string }; first: number }> {
    const n = await this.exclusive(async () => this.head!.n);
    return this.read(Math.max(n - Math.min(Math.max(Math.floor(count), 1), AUDIT_PAGE_MAX), 0), AUDIT_PAGE_MAX);
  }

  /** The entries the object holds. */
  held(): Promise<number> {
    return this.exclusive(async () => (this.first === 0 ? 0 : this.head!.n - this.first + 1));
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
   * deleted, whose record of who did that must outlive it. A copy that cannot be made leaves the entries where they
   * are, and resolves false: a fleet made again under the name carries on from them (see `held`).
   */
  async retire(stillRetiring: () => Promise<boolean> = async () => true): Promise<boolean> {
    const prefix = await this.prefix();
    if (prefix === null) return false;
    for (;;) {
      // Look at what is oldest; when nothing is left the log is empty, and starts again from the genesis, in this one step. A copy that
      // finds the fleet has come back in the meantime (the name was made again while the bucket was being written to) stops: what is
      // left is the new fleet's log, which goes on from where it is.
      const batch = await this.exclusive(async () => {
        if (!(await stillRetiring())) return null;
        const rows = [...(await this.store.list<AuditEntry>({ prefix: PREFIX, limit: this.limits.batch })).values()];
        if (rows.length === 0) {
          this.head = { n: 0, hash: GENESIS };
          this.first = 0;
        }
        return rows;
      });
      if (batch === null) return false;
      if (batch.length === 0) return true;
      try {
        await this.archive(this.fileName(prefix, batch[0]!), this.lines(batch), { fleet: prefix.split("/")[1] ?? "", first: String(batch[0]!.n), last: String(batch[batch.length - 1]!.n) });
      } catch (e) {
        console.error("audit: could not copy " + batch.length + " entries to the bucket, so they are kept: " + String(e));
        return false;
      }
      await this.exclusive(async () => {
        await this.remove(batch.map((e) => key(e.n)));
        this.first = batch[batch.length - 1]!.n + 1;
      });
    }
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
