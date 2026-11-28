// No imports: the helpers that the end-to-end scripts use take it too, and those do not run under `bun test`.
/**
 * How long a test waits for a process it runs with a synchronous call (`Bun.spawnSync`). Such a call blocks the
 * thread that the test's time limit is kept by, so the call has to carry its own: a child that never exits would
 * otherwise hold the whole run (see stall-guard.ts, which ends a run that has been held that long anyway).
 */
export const SYNC_CHILD_MS = process.platform === "win32" ? 90_000 : 30_000;

/** The limit of the commands that the helpers for the built CLI run (they are the longest: an install, a service start). */
export const HELPER_SYNC_MS = process.platform === "win32" ? 120_000 : 60_000;

/**
 * How long the main thread of a test run may stand still before the run is ended (stall-guard.ts): the backstop behind
 * every limit above and the product's own for a command of the service manager, with half a minute to spare, so that a
 * call that is only slow fails one test by its own limit and never costs the run.
 */
export const SYNC_BACKSTOP_MS = process.platform === "win32" ? 150_000 : 90_000;
