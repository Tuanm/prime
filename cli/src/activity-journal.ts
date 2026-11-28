// The activity journal: one line per tool call this device was asked to run, for the people who need to
// know afterwards what ran here and on whose word (a fleet's snapshots record it as their provenance).
//
//   {"ts":"2026-12-01T10:00:00.000Z","tool":"write","caller":"<key id of the signer>"}
//
// `caller` is the key id of the machine that signed the call, "unsigned" when no trusted key did, and "local"
// for a call that came to this device's own port. The arguments of a call are never recorded. The file is a
// ring: it never grows past a limit, and when it would, the oldest lines go.

import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";

export interface ActivityEntry {
  /** ISO 8601, UTC: entries compare as text in the order they happened. */
  ts: string;
  tool: string;
  caller: string;
}

export const ACTIVITY_LIMIT_BYTES = 1024 * 1024;
const TOOL_NAME_MAX = 128;

export class ActivityJournal {
  private readonly path: string;
  private readonly limit: number;
  private readonly now: () => number;

  constructor(path: string, options: { limit?: number; now?: () => number } = {}) {
    this.path = path;
    this.limit = options.limit ?? ACTIVITY_LIMIT_BYTES;
    this.now = options.now ?? Date.now;
  }

  /** Note one call. It never throws: a journal that cannot be written must not stop a tool from running. */
  record(tool: string, caller: string): void {
    try {
      const entry: ActivityEntry = { ts: new Date(this.now()).toISOString(), tool: tool.slice(0, TOOL_NAME_MAX), caller };
      const line = JSON.stringify(entry) + "\n";
      mkdirSync(dirname(this.path), { recursive: true });
      let size = 0;
      try {
        size = statSync(this.path).size;
      } catch {}
      if (size + line.length > this.limit) this.compact(line.length);
      appendFileSync(this.path, line, { mode: 0o600 });
    } catch {
      // see above
    }
  }

  /** Drop the oldest lines until the file is at most half of the limit (and has room for the line to come). */
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
      const next = lines[i]!.length + 1;
      if (bytes + next > keep) break;
      kept.unshift(lines[i]!);
      bytes += next;
    }
    writeFileAtomic(this.path, kept.length > 0 ? kept.join("\n") + "\n" : "", 0o600);
  }
}

/** The entries in a journal, oldest first, from `since` (exclusive; an ISO time) on. Lines that are not entries are skipped. */
export function readActivity(path: string, since?: string): ActivityEntry[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: ActivityEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const v = JSON.parse(line) as Partial<ActivityEntry>;
      if (typeof v.ts !== "string" || typeof v.tool !== "string" || typeof v.caller !== "string") continue;
      if (since !== undefined && v.ts <= since) continue;
      out.push({ ts: v.ts, tool: v.tool, caller: v.caller });
    } catch {}
  }
  return out;
}
