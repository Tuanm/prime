// Write a file so that a reader sees the old one or the new one, never half of it, and so that two
// writers at once (racing `prime fleets agent start`s, the agent and a command) do not trip over
// each other: each writes its own temp file, and the last rename wins.

import { randomBytes } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";

export function writeFileAtomic(file: string, content: string, mode = 0o600): void {
  const scratch = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(scratch, content, { mode });
    renameSync(scratch, file);
  } catch (err) {
    rmSync(scratch, { force: true });
    throw err;
  }
}
