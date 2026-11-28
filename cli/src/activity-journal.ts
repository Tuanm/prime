// The activity journal: one line per tool call this device was asked to run, for the people who need to
// know afterwards what ran here and on whose word (a fleet's snapshots record it as their provenance).
//
//   {"seq":41,"ts":"2026-12-01T10:00:00.000Z","tool":"write","caller":"<key id of the signer>"}
//
// `caller` is the key id of the machine that signed the call, "unsigned" when no trusted key did, and "local"
// for a call that came to this device's own port. The arguments of a call are never recorded. The file is a
// ring: it never grows past a limit (in bytes), and when it would, the oldest lines go. `seq` counts the calls of the
// file, one more each time and never twice, so a reader can say "everything after 41" without a clock, and can tell
// when the ring dropped lines it had not read. One file belongs to one device, but two processes that share it (the
// service and an ad-hoc run, a restart that overlaps) do not lose lines: every write takes a lock.

import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { withDirLockSync } from "./dir-lock.ts";

export interface ActivityEntry {
  /** 1, 2, 3, ...: the call's place in this file. */
  seq: number;
  /** ISO 8601, UTC. */
  ts: string;
  tool: string;
  caller: string;
}

export const ACTIVITY_LIMIT_BYTES = 1024 * 1024;
const TOOL_NAME_MAX = 128;
const TAIL_BYTES = 4096;

export interface ActivityOptions {
  limit?: number;
  now?: () => number;
  /** Told, once, why a call could not be written down. */
  onError?: (message: string) => void;
}

export class ActivityJournal {
  private readonly path: string;
  private readonly limit: number;
  private readonly now: () => number;
  private readonly onError?: (message: string) => void;
  private errorSaid = false;

  constructor(path: string, options: ActivityOptions = {}) {
    this.path = path;
    this.limit = options.limit ?? ACTIVITY_LIMIT_BYTES;
    this.now = options.now ?? Date.now;
    this.onError = options.onError;
  }

  /** Note one call. It never throws: a journal that cannot be written must not stop a tool from running. */
  record(tool: string, caller: string): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      withDirLockSync(
        this.path + ".lock",
        () => {
          const entry: ActivityEntry = { seq: lastSeq(this.path) + 1, ts: new Date(this.now()).toISOString(), tool: tool.slice(0, TOOL_NAME_MAX), caller };
          const line = JSON.stringify(entry) + "\n";
          const bytes = Buffer.byteLength(line);
          let size = 0;
          try {
            size = statSync(this.path).size;
          } catch {}
          if (size + bytes > this.limit) this.compact(bytes);
          appendFileSync(this.path, line, { mode: 0o600 });
        },
        { waitMs: 1000 },
      );
    } catch (err) {
      if (!this.errorSaid) {
        this.errorSaid = true;
        this.onError?.(`the activity journal ${this.path} cannot be written (calls are not noted): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Drop the oldest lines until the file is at most half of the limit (and has room for the line to come). The newest line always stays: it holds the count. */
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
    if (!Number.isSafeInteger(v.seq) || (v.seq as number) < 1 || typeof v.ts !== "string" || typeof v.tool !== "string" || typeof v.caller !== "string") return undefined;
    return { seq: v.seq as number, ts: v.ts, tool: v.tool, caller: v.caller };
  } catch {
    return undefined;
  }
}

/** The number of the last call in the file (0 when there is none): read from the end of the file, not the whole of it. */
function lastSeq(path: string): number {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return 0;
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = entryOf(lines[i]!);
      if (entry) return entry.seq;
    }
    // Nothing readable in the last lines (a long line, damage): go through the file.
    if (size > length) {
      let max = 0;
      for (const line of readFileSync(path, "utf8").split("\n")) max = Math.max(max, entryOf(line)?.seq ?? 0);
      return max;
    }
    return 0;
  } finally {
    closeSync(fd);
  }
}

export interface ActivityRead {
  /** The calls after `afterSeq`, oldest first. */
  entries: ActivityEntry[];
  /** Where to resume: the number of the last call in the file (`afterSeq` when the file has none). */
  lastSeq: number;
  /** True when there are calls the reader cannot have: the ring dropped some before they were read, or the file is not the one the position was taken from. */
  gap: boolean;
}

/** The calls in a journal after number `afterSeq` (0: all of them). Lines that are not entries are skipped. */
export function readActivity(path: string, afterSeq = 0): ActivityRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], lastSeq: afterSeq, gap: false };
    throw err;
  }
  const all: ActivityEntry[] = [];
  for (const line of text.split("\n")) {
    const entry = line ? entryOf(line) : undefined;
    if (entry) all.push(entry);
  }
  const last = all.length > 0 ? all[all.length - 1]!.seq : 0;
  // The file counts from a lower number than the reader's position: it is a new file (deleted and made again).
  if (afterSeq > last) return { entries: all, lastSeq: last, gap: true };
  const entries = all.filter((e) => e.seq > afterSeq);
  return { entries, lastSeq: last > 0 ? last : afterSeq, gap: afterSeq > 0 && entries.length > 0 && entries[0]!.seq > afterSeq + 1 };
}
