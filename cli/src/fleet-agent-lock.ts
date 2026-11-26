// One fleet agent per configuration.
//
// Two agents for the same spaces both think they are the primary: they write the same
// index files, each takes the other's note of an apply for its own mess, and the gateway's
// traffic doubles. They can start by accident (a login service that restarts what a shell
// just stopped, a second shell, a restart that was slower than expected), so the agent
// itself refuses to run beside another one: a file in its directory, created exclusively,
// holds the pid of the one that is running.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The lock lives in the agent's own directory (`fleetAgentDir`). */
export function agentLockPath(agentDir: string): string {
  return join(agentDir, "agent.lock");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, and is somebody else's.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** How recently a live agent has touched its lock (it does so every few seconds). */
const FRESH_MS = 30_000;

function freshFile(file: string): boolean {
  return youngerThan(file, FRESH_MS);
}

/** What `ps -p <pid> -o command=` said: null when it could not be run at all. */
export type ProcessProbe = (pid: number) => { status: number | null; stdout: string } | null;

const psProbe: ProcessProbe = (pid) => {
  try {
    const listed = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 5000 });
    if (listed.error) return null;
    return { status: listed.status, stdout: listed.stdout ?? "" };
  } catch {
    return null;
  }
};

// Linux says it without a process to run (and in containers that have no ps).
const procProbe: ProcessProbe = (pid) => {
  try {
    const line = readFileSync("/proc/" + pid + "/cmdline", "utf8").replace(/\0/g, " ").trim();
    return line === "" ? null : { status: 0, stdout: line };
  } catch {
    return null;
  }
};

const defaultProbe: ProcessProbe = (pid) => (process.platform === "linux" ? procProbe(pid) : null) ?? psProbe(pid);

/**
 * Whether this pid is a fleet agent. A pid in a lock that survived a reboot may belong to
 * any process now, and a lock that is never let go of would keep the agent from starting
 * for ever. The process list says what the process is when it gives an answer: one command
 * line. Nothing else is an answer. The pid is alive (that was checked), so a `ps` that
 * prints nothing or exits non-zero (busybox, which has no -p; one that is not allowed to see
 * the process; none at all) has not said it is gone. Then the files say: the lock names this
 * pid and was touched lately (every agent holds and touches one), or, for an agent of a build
 * from before the lock, there is no lock and its state file names this pid and was written lately.
 */
export function isFleetAgentProcess(pid: number, agentDir?: string, probe: ProcessProbe = defaultProbe): boolean {
  if (!pidAlive(pid)) return false;
  if (process.platform !== "win32") {
    const answer = probe(pid);
    if (answer && answer.status === 0 && answer.stdout.trim() !== "") return answer.stdout.includes("__fleet-agent");
  }
  if (agentDir === undefined) return true;
  const lock = agentLockPath(agentDir);
  if (existsSync(lock)) return readHolder(lock) === pid && freshFile(lock);
  const state = join(agentDir, "state.json");
  return statePid(state) === pid && freshFile(state);
}

function statePid(file: string): number | null {
  try {
    const pid = (JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown }).pid;
    return typeof pid === "number" ? pid : null;
  } catch {
    return null;
  }
}

export interface AgentLockOptions {
  /** How long to wait for a live agent to let go (it is stopping). */
  waitMs?: number;
  /** Whether a pid is a running agent; for tests. */
  isAgent?: (pid: number) => boolean;
  /** This process's pid; for tests. */
  pid?: number;
  /** How often the holder touches its lock, so it reads as fresh while the agent lives (default 5 s). */
  touchMs?: number;
  /** Called after this process has written its pid and before it puts the lock in place; for tests. */
  beforeLink?: () => Promise<void> | void;
  /** Called after a lock was judged dead and before it is taken away; for tests. */
  beforeTakeover?: () => Promise<void> | void;
  /** How the lock is put in place (a hard link); replaced in tests. */
  link?: (from: string, to: string) => void;
}

export type AgentLock = { held: true; release: () => void } | { held: false; holder: number };

/** A lock file with nothing in it this young is being written, not abandoned. */
const WRITING_MS = 5000;

function readHolder(file: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Take the lock, or say who has it. A lock whose holder is gone (or is not an agent) is
 * taken over; one whose holder is alive is waited for up to `waitMs` (the case of a restart,
 * where the old agent is finishing its round), and then refused.
 *
 * The lock is put in place already holding the pid: it is written to a file of its own and
 * linked to the lock's name, which fails if the name is taken. A lock that is created empty
 * and filled afterwards reads as "nobody" in between, and two agents would both hold it.
 */
export async function acquireAgentLock(agentDir: string, opts: AgentLockOptions = {}): Promise<AgentLock> {
  const file = agentLockPath(agentDir);
  const me = opts.pid ?? process.pid;
  const isAgent = opts.isAgent ?? ((pid: number) => isFleetAgentProcess(pid, agentDir));
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  sweepLeftovers(agentDir);
  const mine = join(agentDir, `agent.lock.${me}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(mine, String(me) + "\n", { mode: 0o600 });
  const until = Date.now() + (opts.waitMs ?? 0);
  try {
    for (;;) {
      await opts.beforeLink?.();
      try {
        (opts.link ?? linkSync)(mine, file);
        return held(file, me, opts.touchMs ?? 5000);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "ENOTSUP" || code === "ENOSYS" || code === "EOPNOTSUPP") {
          // A file system without hard links (FAT, some network mounts): the lock is created
          // exclusively with its pid in a single write. (A reader that meets it empty waits.)
          try {
            writeFileSync(file, String(me) + "\n", { flag: "wx", mode: 0o600 });
            return held(file, me, opts.touchMs ?? 5000);
          } catch (inner) {
            if ((inner as NodeJS.ErrnoException).code !== "EEXIST") throw inner;
          }
        } else if (code !== "EEXIST") throw err;
      }
      const holder = readHolder(file);
      if (holder === me) {
        // Left by an earlier run of this very pid: the lock is ours.
        return held(file, me, opts.touchMs ?? 5000);
      }
      if (holder === null && youngerThan(file, WRITING_MS)) {
        // Somebody is writing it (an agent of an older build creates it empty).
        if (Date.now() >= until) return { held: false, holder: 0 };
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      if (holder === null || !isAgent(holder)) {
        // Nobody holds it. It is taken away by renaming it, and what was moved is looked at: if
        // another agent has taken the dead lock over since it was judged, it is the live lock
        // that was moved, and it is put back. (Reading and then removing could remove that one.)
        await opts.beforeTakeover?.();
        const stale = `${file}.stale.${randomBytes(4).toString("hex")}`;
        try {
          renameSync(file, stale);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw err;
        }
        if (readHolder(stale) !== holder) {
          try {
            linkSync(stale, file);
          } catch {
            // Taken again meanwhile: whoever holds it holds it.
          }
        }
        rmSync(stale, { force: true });
        continue;
      }
      if (Date.now() >= until) return { held: false, holder };
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    rmSync(mine, { force: true });
  }
}

/** Files of attempts that were cut short (a crash between writing and linking) are not left for ever. */
function sweepLeftovers(agentDir: string): void {
  try {
    for (const name of readdirSync(agentDir)) {
      if (!/^agent\.lock\.(.*\.tmp|stale\.[0-9a-f]+)$/.test(name)) continue;
      const file = join(agentDir, name);
      if (!youngerThan(file, 60_000)) rmSync(file, { force: true });
    }
  } catch {
    // Nothing to sweep.
  }
}

function youngerThan(file: string, ms: number): boolean {
  try {
    return Date.now() - statSync(file).mtimeMs < ms;
  } catch {
    return false;
  }
}

function held(file: string, me: number, touchMs: number): AgentLock {
  // A live agent's lock is never old: where the process list cannot say what a pid is, how
  // recently the lock was written does, and an agent that is finishing a long round while it
  // stops writes nothing else.
  const timer = setInterval(() => {
    try {
      if (readHolder(file) === me) {
        const now = new Date();
        utimesSync(file, now, now);
      }
    } catch {
      // The lock is gone: nothing to keep fresh.
    }
  }, touchMs);
  timer.unref();
  let released = false;
  return {
    held: true,
    release: () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      // Only a lock that is still ours: it may have been taken over after a long stall.
      if (readHolder(file) === me) rmSync(file, { force: true });
    },
  };
}
