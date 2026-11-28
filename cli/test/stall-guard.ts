// Ends a test run that is stuck in a synchronous call, and says which file it was in and what it was waiting for.
//
// The time limit of a test (setDefaultTimeout) is a timer of the runner's event loop, so it cannot end a test that
// blocks that loop: `Bun.spawnSync` of a process that does not exit, `Atomics.wait` for a flag nobody sets, a loop.
// Such a run stops printing and waits for the job's limit (ten minutes seen). The main thread adds one to a counter four
// times a second; a thread of its own notes, by its own clock, when the counter last changed. When it has not changed
// for PRIME_TEST_STALL_MS (see `STALL_MS`; 0 turns the guard off) the thread prints what is running, ends the child
// processes and the run. The limit is the backstop behind every limit a single call has (`SYNC_CHILD_MS` and the others in
// sync-limit.ts): a call that is merely slow ends by its own limit, as one failed test, and never ends the run.
import { beforeEach } from "bun:test";
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { SYNC_BACKSTOP_MS } from "./sync-limit";

/** The longest the main thread may stand still when nothing says otherwise. */
export const STALL_MS = SYNC_BACKSTOP_MS;

/** How long the main thread may stand still: PRIME_TEST_STALL_MS, 0 for never. */
export function stallMs(env: Record<string, string | undefined> = process.env): number {
  const asked = env.PRIME_TEST_STALL_MS;
  if (asked === undefined || asked.trim() === "") return STALL_MS;
  const n = Number(asked);
  return Number.isFinite(n) && n >= 0 ? n : STALL_MS;
}

/**
 * The directory every temporary directory of this run is made in: TMPDIR (TEMP and TMP on Windows) is pointed at it, so that
 * everything the tests and the processes they start make, and name on their command lines, is under a path that is this
 * run's alone. What the guard ends when it gives up is found by that path, so another run on the machine (a second suite,
 * another session's agents) is never touched. Taken off again when the process exits, where that event is delivered (it is not under `bun test`: see below).
 */
function ownTemporaryRoot(): string {
  const parent = realpathSync(tmpdir());
  // `bun test` ends without an exit event, so a run's root is not removed by the run: those of earlier runs that are old
  // enough not to be in use are (what the tests themselves left in them is theirs to have cleaned up).
  try {
    for (const name of readdirSync(parent)) {
      if (!/^pr-[A-Za-z0-9]{6}$/.test(name)) continue;
      const old = Date.now() - statSync(join(parent, name)).mtimeMs > 6 * 3600_000;
      if (old) rmSync(join(parent, name), { recursive: true, force: true });
    }
  } catch {
    // Not ours to clean, or gone already.
  }
  const root = mkdtempSync(join(parent, "pr-"));
  for (const name of process.platform === "win32" ? ["TEMP", "TMP"] : ["TMPDIR"]) process.env[name] = root;
  process.on("exit", () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Held by a process that is still running: the system's own clean-up of its temporary directory takes it.
    }
  });
  return root;
}

let worker: Worker | undefined;
// What a run that is ended from outside says of where it was (the thread that watches cannot be asked after a SIGTERM).
let currentFile = "(no test file has started)";
let started = 0;

/** Starts the watcher (once per run) and tells it which file's tests are running. Called by each test file. */
export function guardAgainstStalls(file: string): void {
  const limit = stallMs();
  if (limit === 0) return;
  if (worker === undefined) {
    const beat = new SharedArrayBuffer(4);
    const counter = new Int32Array(beat);
    setInterval(() => Atomics.add(counter, 0, 1), 250).unref();
    const runRoot = ownTemporaryRoot();
    worker = new Worker(new URL("./stall-worker.ts", import.meta.url), { workerData: { beat, stallMs: limit, pid: process.pid, runRoot } });
    worker.unref();
    // A run that is terminated by a signal (another session's pkill, a job's timeout, an agent of a test that was told to
    // stop and stopped this process) says where it was, so that it is not mistaken for a hang or for a failure of the test
    // it happened in. Who sent it is not known here.
    process.on("SIGTERM", () => {
      try {
        writeSync(2, `\nTEST RUN SIGTERMed in ${currentFile}, after ${started} test(s) had started in the run (the signal's sender is not known: another process, or a test's own agent that stopped this one).\n`);
      } catch {
        // Nowhere to write to.
      }
      process.exit(143);
    });
  }
  const w = worker;
  beforeEach(() => {
    currentFile = file;
    started++;
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
