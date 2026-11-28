// Ends a test run that is stuck in a synchronous call, and says which file it was in and what it was waiting for.
//
// The time limit of a test (setDefaultTimeout) is a timer of the runner's event loop, so it cannot end a test that
// blocks that loop: `Bun.spawnSync` of a process that does not exit, `Atomics.wait` for a flag nobody sets, a loop.
// Such a run stops printing and waits for the job's limit (ten minutes seen). A thread of its own looks at a clock the
// main thread writes to twice a second; when the clock has not moved for PRIME_TEST_STALL_MS (45 s by default; 0 turns
// it off) it prints what is running, ends the child processes and the run.
import { beforeEach } from "bun:test";
import { Worker } from "node:worker_threads";

export const STALL_MS = 45_000;

/** Milliseconds on a clock that `setSystemTime` (a test that freezes the date) does not move, and both threads read alike. */
export const wallMs = (): number => performance.timeOrigin + performance.now();

/** How long the main thread may stand still: PRIME_TEST_STALL_MS, 0 for never. */
export function stallMs(env: Record<string, string | undefined> = process.env): number {
  const asked = env.PRIME_TEST_STALL_MS;
  if (asked === undefined || asked.trim() === "") return STALL_MS;
  const n = Number(asked);
  return Number.isFinite(n) && n >= 0 ? n : STALL_MS;
}

let worker: Worker | undefined;

/** Starts the watcher (once per run) and tells it which file's tests are running. Called by each test file. */
export function guardAgainstStalls(file: string): void {
  const limit = stallMs();
  if (limit === 0) return;
  if (worker === undefined) {
    const beat = new SharedArrayBuffer(8);
    const clock = new BigInt64Array(beat);
    const tick = (): void => {
      Atomics.store(clock, 0, BigInt(Math.round(wallMs())));
    };
    tick();
    setInterval(tick, 250).unref();
    worker = new Worker(new URL("./stall-worker.ts", import.meta.url), { workerData: { beat, stallMs: limit, pid: process.pid } });
    worker.unref();
  }
  const w = worker;
  beforeEach(() => {
    w.postMessage({ file });
  });
}

/** The file that is asking, from the stack of the call (the first frame outside this file and setup.ts). */
export function callerFile(stack: string | undefined = new Error().stack): string {
  for (const line of (stack ?? "").split("\n")) {
    const m = /\(?((?:file:\/\/)?[^()\s]+\.(?:test\.)?ts):\d+:\d+\)?\s*$/.exec(line.trim());
    const path = m?.[1];
    if (path && !/[\\/](?:stall-guard|setup)\.ts$/.test(path)) return path.replace(/^file:\/\//, "");
  }
  return "(unknown file)";
}
