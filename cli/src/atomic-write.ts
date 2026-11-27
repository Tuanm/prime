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
}

// A rename over a file that another process has open is refused on Windows (EPERM, EACCES, EBUSY) for
// as long as it is open, which is a moment: it is tried again a few times before it is an error.
const RENAME_RETRIES = 6;
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
    for (let attempt = 0; ; attempt++) {
      try {
        rename(scratch, file);
        return;
      } catch (err) {
        if (attempt >= RENAME_RETRIES || !BUSY.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
        Bun.sleepSync(10 * (attempt + 1));
      }
    }
  } catch (err) {
    rmSync(scratch, { force: true });
    throw err;
  }
}
