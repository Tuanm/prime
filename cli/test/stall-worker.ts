// The watcher of a test run, in a thread of its own (see stall-guard.ts): it is the one thing that goes on when the
// main thread is blocked in a synchronous call (a spawnSync of a process that never ends, an Atomics.wait, a loop), where
// no timer of the runner fires and so no test time limit can. It reads no clock but its own: the main thread only
// counts, and this thread notes when the count last changed.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { parentPort, workerData } from "node:worker_threads";

type Start = { beat: SharedArrayBuffer; stallMs: number; pid: number };
const { beat, stallMs, pid } = workerData as Start;
const counter = new Int32Array(beat);
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

/** The processes below `root` on Windows, from the process table, with their command lines (best effort). */
function windowsDescendants(root: number): Child[] {
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 1 << 25 },
  );
  try {
    const parsed = JSON.parse(String(r.stdout ?? "")) as unknown;
    const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ ProcessId?: number; ParentProcessId?: number; CommandLine?: string | null }>;
    const found: Child[] = [];
    const visit = (parent: number, depth: number): void => {
      if (depth > 8) return;
      for (const row of rows) {
        if (row.ParentProcessId === parent && typeof row.ProcessId === "number" && row.ProcessId !== parent) {
          visit(row.ProcessId, depth + 1);
          found.push({ pid: row.ProcessId, command: String(row.CommandLine ?? "").slice(0, 200) });
        }
      }
    };
    visit(root, 0);
    return found;
  } catch {
    return [];
  }
}

/**
 * Processes of the tests whose parent is gone (a detached agent, a child of a shell that left): not below this process any
 * more, but their command lines name the temporary directories the tests made. Found by name in the places the tests
 * make them in, among the processes that init has taken over, so another run's live processes are never among them.
 */
function leftBehind(): Child[] {
  if (process.platform === "win32") return [];
  const places = new Set<string>([tmpdir()]);
  try {
    places.add(realpathSync(tmpdir()));
  } catch {
    // Not a path that exists.
  }
  const escape = (p: string): string => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = "(" + [...places].map(escape).join("|") + ")/(fleet|prime|stall|handover|dir-lock|atomic|svc)-";
  const listed = spawnSync("pgrep", [process.platform === "darwin" ? "-fl" : "-a", "-P", "1", "-f", pattern], { encoding: "utf8", timeout: 5000 });
  const found: Child[] = [];
  for (const line of String(listed.stdout ?? "").split("\n")) {
    const m = /^\s*(\d+)\s*(.*)$/.exec(line);
    const left = Number(m?.[1]);
    if (Number.isInteger(left) && left > 1 && left !== pid) found.push({ pid: left, command: (m?.[2] ?? "").slice(0, 200) });
  }
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

function kill(c: Child): void {
  try {
    process.kill(c.pid, "SIGKILL");
  } catch {
    // Gone already.
  }
}

function giveUp(blockedMs: number): never {
  const lines = [
    "",
    `TEST STALLED: the test run has not left a synchronous call for ${Math.round(blockedMs / 1000)} s (PRIME_TEST_STALL_MS=${stallMs}).`,
    `  The test that is running is the one after the last "(pass)" line above, in ${file}.`,
  ];
  lines.push(...whereItIsStuck());
  const children = process.platform === "win32" ? windowsDescendants(pid) : descendants(pid);
  lines.push(children.length === 0 ? "  It has no child process." : "  Its child processes (the one it waits for is among them):");
  for (const c of children) lines.push(`    ${c.pid}  ${c.command}`);
  const left = leftBehind();
  if (left.length > 0) {
    lines.push("  Processes of tests whose parent has gone, named by the temporary directories of the run (ended too):");
    for (const c of left) lines.push(`    ${c.pid}  ${c.command}`);
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
  } else {
    for (const c of [...children, ...left]) kill(c);
  }
  process.kill(pid, "SIGKILL");
  // Not reached when the signal is delivered; a platform that cannot do it ends this thread, and the job's own limit remains.
  return process.exit(1) as never;
}

let seen = Atomics.load(counter, 0);
let changedAt = performance.now();
setInterval(() => {
  const now = Atomics.load(counter, 0);
  const at = performance.now();
  if (now !== seen) {
    seen = now;
    changedAt = at;
  } else if (at - changedAt > stallMs) {
    giveUp(at - changedAt);
  }
}, Math.max(50, Math.min(1000, Math.floor(stallMs / 4))));
