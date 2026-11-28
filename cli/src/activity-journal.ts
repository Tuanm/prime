// The activity journal: one line per tool call this device was asked to run, for the people who need to
// know afterwards what ran here and on whose word (a fleet's snapshots record it as their provenance).
//
//   {"seq":41,"fid":"3fa9c01b","ts":"2026-12-01T10:00:00.000Z","tool":"write","caller":"<key id of the signer>"}
//
// `caller` is the key id of the machine that signed the call, "unsigned" when no trusted key did, and "local"
// for a call that came to this device's own port. The arguments of a call are never recorded. The file is a
// ring: it never grows past a limit (in bytes), and when it would, the oldest lines go. `seq` counts the calls of the
// file, one more each time and never twice, so a reader can say "everything after 41" without a clock, and can tell
// when the ring dropped lines it had not read. `fid` is made when the file is made and kept as long as the file lives:
// a reader that finds another `fid` than the one it has is reading another file (deleted and made again), however far
// that one has grown.
//
// A call is only queued when it is noted (microseconds, nothing touches the disk), and the queue is written in batches,
// one at a time, under the file's lock taken without blocking the event loop: the lines of a batch get their numbers
// and are appended together, so two processes that share a file (the service and an ad-hoc run, a restart that overlaps)
// lose no line and take no number twice. A process that is killed loses the calls still in the queue (a few
// milliseconds of them); `flushSync` writes them at a clean exit.

import { appendFileSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { LockBusyError, withDirLock, withDirLockSync } from "./dir-lock.ts";

export interface ActivityEntry {
  /** 1, 2, 3, ...: the call's place in this file. */
  seq: number;
  /** The file's own id: made with the file, the same on every line of it. */
  fid: string;
  /** ISO 8601, UTC. */
  ts: string;
  tool: string;
  caller: string;
}

export const ACTIVITY_LIMIT_BYTES = 1024 * 1024;
/** Calls kept in the queue while the file cannot be written (the lock is held by another process for long, the disk is full, ...). */
export const ACTIVITY_QUEUE_LIMIT = 10_000;
const TOOL_NAME_MAX = 128;
const TAIL_BYTES = 4096;
const FID_RE = /^[0-9a-f]{8,32}$/;

export interface ActivityOptions {
  limit?: number;
  now?: () => number;
  /** How many calls wait in the queue while the file cannot be written; the oldest go first, and are counted. */
  queueLimit?: number;
  /** Told, once, why calls could not be written down. */
  onError?: (message: string) => void;
}

interface Queued {
  ts: string;
  tool: string;
  caller: string;
}

export class ActivityJournal {
  private readonly path: string;
  private readonly limit: number;
  private readonly now: () => number;
  private readonly onError?: (message: string) => void;
  private errorSaid = false;
  private queue: Queued[] = [];
  private draining: Promise<void> | undefined;
  private readonly queueLimit: number;
  /** The batch a drain has taken and not yet written: a clean exit writes it too. */
  private inflight: Queued[] | undefined;
  /** Calls dropped because the queue was full, since the last report. */
  private dropped = 0;

  constructor(path: string, options: ActivityOptions = {}) {
    this.path = path;
    this.limit = options.limit ?? ACTIVITY_LIMIT_BYTES;
    this.now = options.now ?? Date.now;
    this.onError = options.onError;
    this.queueLimit = options.queueLimit ?? ACTIVITY_QUEUE_LIMIT;
  }

  /** How many calls are waiting to be written (a measure of a journal that cannot keep up). */
  get pending(): number {
    return this.queue.length + (this.inflight?.length ?? 0);
  }

  /** Calls dropped, and not yet said, because the queue was full. */
  get droppedCalls(): number {
    return this.dropped;
  }

  /** Note one call. It only queues it: it never touches the disk, never waits and never throws. */
  record(tool: string, caller: string): void {
    this.queue.push({ ts: new Date(this.now()).toISOString(), tool: tool.slice(0, TOOL_NAME_MAX), caller });
    this.bound();
    if (!this.draining) {
      this.draining = this.drain().finally(() => {
        this.draining = undefined;
      });
    }
  }

  /** Wait until every call noted so far is in the file (tests, and whoever must know it is written). */
  async flush(): Promise<void> {
    while (this.draining) await this.draining;
  }

  /** Keep the queue within its limit: the oldest calls go, and are counted (and said, once the file can be written, or at once if it cannot). */
  private bound(): void {
    const over = this.queue.length - this.queueLimit;
    if (over <= 0) return;
    this.queue.splice(0, over);
    this.dropped += over;
    if (!this.errorSaid) {
      this.errorSaid = true;
      this.onError?.(`the activity journal ${this.path} is not being written and its queue is full: the oldest calls are dropped (${this.queueLimit} are kept)`);
    }
  }

  /**
   * Write what is queued, now, blocking: for a process that is about to exit. It never waits on this process's own lock:
   * when a drain is in progress (it may hold the lock, or be waiting for another process's), the lines are appended
   * directly, together with the batch that drain has not written yet; otherwise it takes the lock for at most 200 ms.
   */
  flushSync(): void {
    const inflight = this.inflight;
    const batch = [...(inflight ?? []), ...this.queue.splice(0)];
    if (batch.length === 0) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      if (this.draining) {
        this.write(batch);
      } else {
        try {
          withDirLockSync(this.path + ".lock", () => this.write(batch), { waitMs: 200 });
        } catch (err) {
          if (!(err instanceof LockBusyError)) throw err;
          this.write(batch); // another process holds it: the lines go in anyway, rather than be lost at exit
        }
      }
      // Written here: a drain that is still waiting for the lock finds nothing left of its batch to write.
      if (inflight) inflight.length = 0;
      this.inflight = undefined;
      this.report();
    } catch (err) {
      this.failed(err);
    }
  }

  private async drain(): Promise<void> {
    // Let the calls of this turn of the loop join the batch.
    await Promise.resolve();
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0);
      this.inflight = batch;
      try {
        mkdirSync(dirname(this.path), { recursive: true });
        await withDirLock(
          this.path + ".lock",
          () => {
            this.write(batch);
            this.inflight = undefined; // written: a clean exit has nothing more of it to write
          },
          { waitMs: 1000 },
        );
        this.report();
      } catch (err) {
        this.failed(err);
        // Not written (unless it was, and only the release of the lock failed): back to the front of the queue, within its limit, and tried again at the next call.
        if (this.inflight) {
          this.queue.unshift(...this.inflight);
          this.inflight = undefined;
          this.bound();
        }
        return;
      }
    }
  }

  /** After a write: say what was dropped while the file could not be written. */
  private report(): void {
    if (this.dropped === 0) return;
    const n = this.dropped;
    this.dropped = 0;
    this.onError?.(`the activity journal ${this.path}: ${n} call${n === 1 ? " was" : "s were"} not noted (the queue was full while the file could not be written)`);
    this.errorSaid = false; // a later failure is said again
  }

  private failed(err: unknown): void {
    if (this.errorSaid) return;
    this.errorSaid = true;
    this.onError?.(`the activity journal ${this.path} cannot be written (calls are not noted): ${err instanceof Error ? err.message : String(err)}`);
  }

  /** With the lock held: number the batch after the last line of the file and append it, the ring kept within its limit. */
  private write(batch: Queued[]): void {
    if (batch.length === 0) return;
    const last = tailOf(this.path);
    const fid = last.fid ?? randomBytes(4).toString("hex");
    let seq = last.seq;
    let lines = batch.map((q) => JSON.stringify({ seq: ++seq, fid, ts: q.ts, tool: q.tool, caller: q.caller } satisfies ActivityEntry) + "\n");
    // A batch bigger than half the limit keeps its newest lines.
    let bytes = lines.reduce((n, l) => n + Buffer.byteLength(l), 0);
    const half = Math.floor(this.limit / 2);
    while (lines.length > 1 && bytes > half) bytes -= Buffer.byteLength(lines.shift()!);
    let size = 0;
    try {
      size = statSync(this.path).size;
    } catch {}
    if (size + bytes > this.limit) this.compact(bytes);
    appendFileSync(this.path, lines.join(""), { mode: 0o600 });
  }

  /** Drop the oldest lines until the file is at most half of the limit (and has room for the lines to come). The newest line always stays: it holds the count and the file's id. */
  private compact(incoming: number): void {
    let text = "";
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      return;
    }
    const keep = Math.max(0, Math.floor(this.limit / 2) - incoming);
    const lines = text.split("\n").filter(Boolean);
    const kept: string[] = [];
    let bytes = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const next = Buffer.byteLength(lines[i]!) + 1;
      if (kept.length > 0 && bytes + next > keep) break;
      kept.unshift(lines[i]!);
      bytes += next;
    }
    writeFileAtomic(this.path, kept.length > 0 ? kept.join("\n") + "\n" : "", 0o600);
  }
}

function entryOf(line: string): ActivityEntry | undefined {
  try {
    const v = JSON.parse(line) as Partial<ActivityEntry>;
    if (!Number.isSafeInteger(v.seq) || (v.seq as number) < 1 || typeof v.fid !== "string" || !FID_RE.test(v.fid)) return undefined;
    if (typeof v.ts !== "string" || typeof v.tool !== "string" || typeof v.caller !== "string") return undefined;
    return { seq: v.seq as number, fid: v.fid, ts: v.ts, tool: v.tool, caller: v.caller };
  } catch {
    return undefined;
  }
}

/** The number and the file id of the last call in the file (0 and none when there is none): read from the end of the file, not the whole of it. */
function tailOf(path: string): { seq: number; fid?: string } {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { seq: 0 };
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = entryOf(lines[i]!);
      if (entry) return { seq: entry.seq, fid: entry.fid };
    }
    // Nothing readable in the last lines (a long line, damage): go through the file.
    if (size > length) {
      let found: { seq: number; fid?: string } = { seq: 0 };
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const entry = line ? entryOf(line) : undefined;
        if (entry && entry.seq >= found.seq) found = { seq: entry.seq, fid: entry.fid };
      }
      return found;
    }
    return { seq: 0 };
  } finally {
    closeSync(fd);
  }
}

/** Where a reader is in a journal: what `readActivity` gave it last. */
export interface ActivityPosition {
  seq: number;
  /** The id of the file the position was taken in (none: the reader has not read this journal before). */
  fid?: string;
}

export interface ActivityRead {
  /** The calls after the reader's position, oldest first. */
  entries: ActivityEntry[];
  /** Where to resume. */
  position: ActivityPosition;
  /** True when there are calls the reader cannot have seen: the ring dropped some before they were read, or the file is another one (deleted and made again). */
  gap: boolean;
}

/** The most of a journal a reader takes: the ring keeps 1 MiB, so a file bigger than this was not written by the journal. */
export const READ_LIMIT_BYTES = 2 * 1024 * 1024;

/**
 * The text of a journal, or undefined when there is none. The file may be one that a space writes (the space can put anything in
 * it): a link is not followed, only a regular file is read, and no more than READ_LIMIT_BYTES of it (its end: the newest calls).
 */
function readJournalText(path: string): string | undefined {
  let fd: number;
  try {
    // O_NOFOLLOW is not there on Windows; the check of the file's kind below is.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP") throw new Error(`the activity journal ${path} is a link, and is not read`);
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`the activity journal ${path} is not a regular file, and is not read`);
    const length = Math.min(st.size, READ_LIMIT_BYTES);
    const buffer = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const n = readSync(fd, buffer, got, length - got, st.size - length + got);
      if (n === 0) break;
      got += n;
    }
    let text = buffer.subarray(0, got).toString("utf8");
    // A read that began in the middle of a line drops that line.
    if (st.size > length) text = text.slice(text.indexOf("\n") + 1);
    return text;
  } finally {
    closeSync(fd);
  }
}

/** The calls in a journal after `after` (none: all of them). Lines that are not entries are skipped. */
export function readActivity(path: string, after: ActivityPosition = { seq: 0 }): ActivityRead {
  const text = readJournalText(path);
  if (text === undefined) return { entries: [], position: after, gap: false };
  const all: ActivityEntry[] = [];
  for (const line of text.split("\n")) {
    const entry = line ? entryOf(line) : undefined;
    if (entry) all.push(entry);
  }
  if (all.length === 0) return { entries: [], position: after, gap: false };
  const lastEntry = all[all.length - 1]!;
  const position: ActivityPosition = { seq: lastEntry.seq, fid: lastEntry.fid };
  // Another file than the reader's (however far it has grown), or one that counts from less than the reader's position.
  if ((after.fid !== undefined && after.fid !== lastEntry.fid) || after.seq > lastEntry.seq) return { entries: all, position, gap: true };
  const entries = all.filter((e) => e.seq > after.seq);
  return { entries, position, gap: after.seq > 0 && entries.length > 0 && entries[0]!.seq > after.seq + 1 };
}
