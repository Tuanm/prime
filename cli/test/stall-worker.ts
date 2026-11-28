// The watcher of a test run (its clock is `performance.timeOrigin + performance.now()`, as in stall-guard.ts: `Date` is what tests set), in a thread of its own (see stall-guard.ts): it is the one thing that goes on when the
// main thread is blocked in a synchronous call (a spawnSync of a process that never ends, an Atomics.wait, a loop), where
// no timer of the runner fires and so no test time limit can.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

type Start = { beat: SharedArrayBuffer; stallMs: number; pid: number };
const { beat, stallMs, pid } = workerData as Start;
const clock = new BigInt64Array(beat);
let file = "(no test file has started)";
parentPort?.on("message", (m: { file: string }) => {
  file = m.file;
});

type Child = { pid: number; command: string };

/** The processes started (directly or not) by `root`, children before their parents, with their command lines when pgrep says them. */
function descendants(root: number): Child[] {
  const found: Child[] = [];
  const visit = (parent: number, depth: number): void => {
    if (depth > 8) return;
    // `-a` prints the command line on Linux, `-fl` on macOS; where neither is known the pid alone is listed.
    let listed = spawnSync("pgrep", [process.platform === "darwin" ? "-fl" : "-a", "-P", String(parent)], { encoding: "utf8", timeout: 5000 });
    if (listed.status !== 0 && listed.status !== 1) listed = spawnSync("pgrep", ["-P", String(parent)], { encoding: "utf8", timeout: 5000 });
    for (const line of String(listed.stdout ?? "").split("\n")) {
      const m = /^\s*(\d+)\s*(.*)$/.exec(line);
      const child = Number(m?.[1]);
      if (Number.isInteger(child) && child > 0) {
        visit(child, depth + 1);
        found.push({ pid: child, command: (m?.[2] ?? "").slice(0, 200) });
      }
    }
  };
  visit(root, 0);
  return found;
}

/** Where the blocked thread is, as far as the platform's tools say (best effort: nothing is printed when they are not there). */
function whereItIsStuck(): string[] {
  const out: string[] = [];
  try {
    if (process.platform === "darwin") {
      const r = spawnSync("sample", [String(pid), "2"], { encoding: "utf8", timeout: 30_000 });
      // The report comes on stdout when that is a pipe, and in a file (named on stdout) when it is a terminal.
      let text = String(r.stdout ?? "");
      const file = /written to file (\S+)/.exec(text)?.[1];
      if (file && existsSync(file)) {
        text = readFileSync(file, "utf8");
        rmSync(file, { force: true });
      }
      if (text.includes("Call graph:")) {
        const at = text.indexOf("Call graph:");
        out.push("  Where its threads stand (sample, the first lines of the call graph):", ...text.slice(at).split("\n").slice(0, 30).map((l) => "    " + l));
      }
    } else if (process.platform === "linux") {
      out.push("  Its threads (name, state, kernel wait):");
      for (const tid of readdirSync(`/proc/${pid}/task`)) {
        const stat = readFileSync(`/proc/${pid}/task/${tid}/stat`, "utf8");
        const state = /\)\s+(\S)/.exec(stat)?.[1] ?? "?";
        let wchan = "";
        try {
          wchan = readFileSync(`/proc/${pid}/task/${tid}/wchan`, "utf8").trim();
        } catch {
          // Not readable here.
        }
        out.push(`    ${tid} ${/\(([^)]*)\)/.exec(stat)?.[1] ?? ""} ${state} ${wchan}`);
      }
    }
  } catch {
    // What could not be found out is left out.
  }
  return out;
}

function giveUp(blockedMs: number): never {
  const lines = [
    "",
    `TEST STALLED: the test run has not left a synchronous call for ${Math.round(blockedMs / 1000)} s (PRIME_TEST_STALL_MS=${stallMs}).`,
    `  The test that is running is the one after the last "(pass)" line above, in ${file}.`,
  ];
  lines.push(...whereItIsStuck());
  if (process.platform !== "win32") {
    const children = descendants(pid);
    lines.push(children.length === 0 ? "  It has no child process." : "  Its child processes (the one it waits for is among them):");
    for (const c of children) lines.push(`    ${c.pid}  ${c.command}`);
    for (const c of children) {
      try {
        process.kill(c.pid, "SIGKILL");
      } catch {
        // Gone already.
      }
    }
  }
  lines.push("  The run is ended here (exit 137 on Unix) so that it does not wait for the job's limit.", "");
  try {
    // Written in one go to the descriptor itself: this thread's process.stderr may be buffered behind the blocked one.
    writeSync(2, lines.join("\n"));
  } catch {
    // Nowhere to write to.
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 10_000 });
  }
  process.kill(pid, "SIGKILL");
  // Not reached when the signal is delivered; a platform that cannot do it ends this thread, and the job's own limit remains.
  return process.exit(1) as never;
}

setInterval(() => {
  const blockedMs = performance.timeOrigin + performance.now() - Number(Atomics.load(clock, 0));
  if (blockedMs > stallMs) giveUp(blockedMs);
}, Math.max(50, Math.min(1000, Math.floor(stallMs / 4))));
