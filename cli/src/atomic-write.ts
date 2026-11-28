// Write a file so that a reader sees the old one or the new one, never half of it, and so that two
// writers at once (racing `prime fleets agent start`s, the agent and a command) do not trip over
// each other: each writes its own temp file, and the last rename wins.

import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";

export interface AtomicWriteOptions {
  /**
   * Have the data on disk before the name moves (fsync): after a power loss the file is then the old one
   * or the new one, not an empty one under the new name. It costs a flush, so it is for what is
   * not written again a moment later (a position that cannot be rebuilt), not for what the agent
   * rewrites every round.
   */
  durable?: boolean;
  /** Replaced in tests. */
  rename?: (from: string, to: string) => void;
  /** How long a refused rename is tried again for (default two seconds). */
  budgetMs?: number;
  /** Replaced in tests. */
  platform?: string;
}

// A rename over a file that another process has open (or is scanning) is refused on Windows (EPERM, EACCES, EBUSY) for
// as long as it is open, which is a moment: it is tried again, with growing pauses, for a couple of seconds before it
// is an error. Eight writers renaming onto one name on a slow disk can take turns for longer than a few tries allow.
// (Elsewhere the same codes are real refusals, and are reported at once.)
const RENAME_BUDGET_MS = 2000;
const BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);

export function writeFileAtomic(file: string, content: string, mode = 0o600, options: AtomicWriteOptions = {}): void {
  const scratch = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const rename = options.rename ?? renameSync;
  try {
    const fd = openSync(scratch, "w", mode);
    try {
      writeSync(fd, content);
      if (options.durable) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const until = performance.now() + (options.budgetMs ?? RENAME_BUDGET_MS);
    const windows = (options.platform ?? process.platform) === "win32";
    for (let attempt = 0; ; attempt++) {
      try {
        rename(scratch, file);
        return;
      } catch (err) {
        const left = until - performance.now();
        if (!windows || left <= 0 || !BUSY.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
        Bun.sleepSync(Math.min(Math.max(1, left), 5 * 2 ** Math.min(attempt, 6), 100) + Math.floor(Math.random() * 5));
      }
    }
  } catch (err) {
    rmSync(scratch, { force: true });
    throw err;
  }
}
