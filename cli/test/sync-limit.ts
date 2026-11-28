// No imports: the helpers that the end-to-end scripts use take it too, and those do not run under `bun test`.
/**
 * How long a test waits for a process it runs with a synchronous call (`Bun.spawnSync`). Such a call blocks the
 * thread that the test's time limit is kept by, so the call has to carry its own: a child that never exits would
 * otherwise hold the whole run (see stall-guard.ts, which ends a run that has been held that long anyway).
 */
export const SYNC_CHILD_MS = process.platform === "win32" ? 90_000 : 30_000;
