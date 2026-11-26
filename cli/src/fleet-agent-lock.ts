// One fleet agent per configuration.
//
// Two agents for the same spaces both think they are the primary: they write the same
// index files, each takes the other's note of an apply for its own mess, and the gateway's
// traffic doubles. They can start by accident (a login service that restarts what a shell
// just stopped, a second shell, a restart that was slower than expected), so the agent
// itself refuses to run beside another one: a file in its directory, created exclusively,
// holds the pid of the one that is running.

import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
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

/** How recently a live agent has written its lock or its state file (it rewrites the state every second or two). */
const FRESH_MS = 30_000;

function freshFile(file: string): boolean {
  try {
    return Date.now() - statSync(file).mtimeMs < FRESH_MS;
  } catch {
    return false;
  }
}

/**
 * Whether this pid is a fleet agent. A pid in a lock that survived a reboot may belong to
 * any process now, and a lock that is never let go of would keep the agent from starting
 * for ever. The process list says what the process is; where it cannot be asked (some
 * sandboxes, Windows), a live pid counts only while the lock or the agent's state file
 * was written recently.
 */
export function isFleetAgentProcess(pid: number, agentDir?: string): boolean {
  if (!pidAlive(pid)) return false;
  if (process.platform !== "win32") {
    try {
      const listed = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 5000 });
      if (!listed.error) return listed.status === 0 && listed.stdout.includes("__fleet-agent");
    } catch {
      // Not askable: judged by the files below.
    }
  }
  if (agentDir === undefined) return true;
  return freshFile(agentLockPath(agentDir)) || freshFile(join(agentDir, "state.json"));
}

export interface AgentLockOptions {
  /** How long to wait for a live agent to let go (it is stopping). */
  waitMs?: number;
  /** Whether a pid is a running agent; for tests. */
  isAgent?: (pid: number) => boolean;
  /** This process's pid; for tests. */
  pid?: number;
}

export type AgentLock = { held: true; release: () => void } | { held: false; holder: number };

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
 */
export async function acquireAgentLock(agentDir: string, opts: AgentLockOptions = {}): Promise<AgentLock> {
  const file = agentLockPath(agentDir);
  const me = opts.pid ?? process.pid;
  const isAgent = opts.isAgent ?? ((pid: number) => isFleetAgentProcess(pid, agentDir));
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const until = Date.now() + (opts.waitMs ?? 0);
  for (;;) {
    try {
      const fd = openSync(file, "wx", 0o600);
      try {
        writeSync(fd, String(me) + "\n");
      } finally {
        closeSync(fd);
      }
      let released = false;
      return {
        held: true,
        release: () => {
          if (released) return;
          released = true;
          // Only a lock that is still ours: it may have been taken over after a long stall.
          if (readHolder(file) === me) rmSync(file, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const holder = readHolder(file);
    if (holder === me) {
      // Left by an earlier run of this very pid: the lock is ours.
      return { held: true, release: () => rmSync(file, { force: true }) };
    }
    if (holder === null || !isAgent(holder)) {
      // Nobody holds it. The file is removed only if it still says what was just read, so two
      // agents that find the same dead lock do not take each other's new one away.
      if (readHolder(file) === holder) rmSync(file, { force: true });
      continue;
    }
    if (Date.now() >= until) return { held: false, holder };
    await new Promise((r) => setTimeout(r, 100));
  }
}
