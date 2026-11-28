// How one fleet agent hands over to the next, and how a person's "stop" reaches an agent that is not running yet.
//
// An update starts the new build before it asks the old agent to stop: the new one (the successor) waits for the
// agent lock, which the old one lets go of when its round is done. Two things follow, and both live here:
//
// - The successor is invisible to everything that looks at the agent's state (which names the old agent until the
//   successor holds the lock). It is written down in `fleet-agent/successor` so that `agent stop`, `agent install`
//   and a second update can see it, stop it, or leave it be.
// - A stop that arrives while the successor waits must win: it is a "stop request" file with the time it was made, and
//   an agent that was started before that time and is only now taking the lock leaves at once. The same file is the way
//   to ask a running agent to stop where a signal would kill it in the middle of its round (Windows): the agent looks
//   at it while it runs.

import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { acquireAgentLock, commandOf, isFleetAgentProcess, type AgentLock, type AgentLockOptions } from "./fleet-agent-lock.ts";

export const SUCCESSOR_FILE = "successor";
export const STOP_FILE = "stop";

/** How often a waiting successor touches its entry, and how long an entry that was touched is believed. */
const TOUCH_MS = 5_000;
const FRESH_MS = 30_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether the process the successor entry names is that successor. A waiting successor holds no lock and has no state
 * to say so, and where the process list cannot be asked (Windows) nothing else says what a pid is: so it touches its entry
 * while it waits, and an entry that was touched lately names a process that is alive. Where the process list can be asked
 * it is asked, and the process must be an agent.
 */
export function isSuccessorProcess(agentDir: string, pid: number): boolean {
  if (!pidAlive(pid)) return false;
  const command = commandOf(pid);
  if (command !== undefined) return command.includes("__fleet-agent");
  try {
    return Date.now() - statSync(successorPath(agentDir)).mtimeMs < FRESH_MS;
  } catch {
    return false;
  }
}

/**
 * An agent's start time is worked out from its uptime, which is not exact to the millisecond: a request made this soon
 * after it started (a stop, and then a start right behind it) is of the agent before it.
 */
const SLACK_MS = 50;

/** How long a claim on being the successor (made before the process exists) is believed. */
export const CLAIM_MS = 10_000;

export const successorPath = (agentDir: string): string => join(agentDir, SUCCESSOR_FILE);
export const stopPath = (agentDir: string): string => join(agentDir, STOP_FILE);

export interface Successor {
  /** The process that waits for the lock; 0 while it is being started (a claim). */
  pid: number;
  /** When it was written. */
  at: number;
}

export function readSuccessor(agentDir: string): Successor | undefined {
  try {
    const raw = JSON.parse(readFileSync(successorPath(agentDir), "utf8")) as { pid?: unknown; at?: unknown };
    if (typeof raw.pid !== "number" || typeof raw.at !== "number") return undefined;
    return { pid: raw.pid, at: raw.at };
  } catch {
    return undefined;
  }
}

/**
 * Say that a successor is about to be started, before it is: of two updates at the same moment only one gets to
 * start one. `running` is the agent that holds the lock: a successor file that names it is the successor that took
 * over, and is not waiting for anything.
 */
export function claimSuccessor(
  agentDir: string,
  running: number | undefined,
  now: number = Date.now(),
  isAgent: (pid: number) => boolean = (pid) => isSuccessorProcess(agentDir, pid),
): { claimed: true } | { claimed: false; pid: number } {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      writeFileSync(successorPath(agentDir), JSON.stringify({ pid: 0, at: now }), { flag: "wx", mode: 0o600 });
      return { claimed: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const there = readSuccessor(agentDir);
    if (there && there.pid > 0 && there.pid !== running && isAgent(there.pid)) return { claimed: false, pid: there.pid };
    if (there && there.pid === 0 && now - there.at < CLAIM_MS) return { claimed: false, pid: 0 };
    // Left by a successor that is gone, or by one that took over: not waiting for anything.
    rmSync(successorPath(agentDir), { force: true });
  }
  return { claimed: false, pid: 0 };
}

/** Say which process the successor is, once it is started. */
export function registerSuccessor(agentDir: string, pid: number, now: number = Date.now()): void {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  writeFileSync(successorPath(agentDir), JSON.stringify({ pid, at: now }), { mode: 0o600 });
}

/** Forget the successor (it holds the lock, or was never started): only if it is `pid`'s, when one is named. */
export function clearSuccessor(agentDir: string, pid?: number): void {
  if (pid !== undefined) {
    const there = readSuccessor(agentDir);
    if (there && there.pid !== pid && there.pid !== 0) return;
  }
  rmSync(successorPath(agentDir), { force: true });
}

/** Stop the successor that waits for the lock, if there is one. Returns its pid when it was signalled. */
export function stopSuccessor(
  agentDir: string,
  isAgent: (pid: number) => boolean = (pid) => isSuccessorProcess(agentDir, pid),
  kill: (pid: number) => void = (pid) => process.kill(pid, "SIGTERM"),
): number | undefined {
  const there = readSuccessor(agentDir);
  // Asked before the entry is removed: where the process list cannot say what a process is, the entry does.
  const live = there !== undefined && there.pid > 0 && isAgent(there.pid);
  rmSync(successorPath(agentDir), { force: true });
  if (!there || !live) return undefined;
  try {
    kill(there.pid);
  } catch {
    return undefined;
  }
  return there.pid;
}

/**
 * Ask for the agents that were started before now to stop (whether they are running, or waiting for the lock). With
 * `only`, for that one agent: an update asks the agent it replaces, and not the successor it started before asking.
 */
export function requestStop(agentDir: string, now: number = Date.now(), only?: number): void {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  writeFileSync(stopPath(agentDir), JSON.stringify({ at: now, ...(only !== undefined ? { only } : {}) }), { mode: 0o600 });
}

/** Whether a stop was asked for after `since` (when the asking agent was started), of this agent (`pid`, when it is told). */
export function stopRequestedSince(agentDir: string, since: number, pid?: number): boolean {
  try {
    const raw = JSON.parse(readFileSync(stopPath(agentDir), "utf8")) as { at?: unknown; only?: unknown };
    if (typeof raw.at !== "number" || raw.at <= since + SLACK_MS) return false;
    return raw.only === undefined || pid === undefined || raw.only === pid;
  } catch {
    return false;
  }
}

/** A request that is older than the agent that finds it is of no use to anybody. */
export function dropOldStopRequest(agentDir: string, since: number): void {
  try {
    const at = (JSON.parse(readFileSync(stopPath(agentDir), "utf8")) as { at?: unknown }).at;
    if (typeof at !== "number" || at <= since + SLACK_MS) rmSync(stopPath(agentDir), { force: true });
  } catch {
    // None, or unreadable: nothing to drop.
  }
}

export interface StartingOptions {
  waitMs: number;
  /** When this agent's process was started (ms since the epoch). */
  startedAt: number;
  /** The agent this one replaces, which was asked to stop: while it holds the lock, this one waits on. */
  replaces?: number;
  /** Replaced in tests. */
  acquire?: (agentDir: string, opts: AgentLockOptions) => Promise<AgentLock>;
  isAgent?: (pid: number) => boolean;
  /** Told when the wait is renewed. */
  onWait?: (holder: number) => void;
  lock?: AgentLockOptions;
}

/**
 * Take the agent lock for an agent that is starting. Three differences from `acquireAgentLock`:
 * - one that replaces an agent keeps waiting while that agent, which was asked to stop, is still alive and holds the lock
 *   (a round can last longer than any wait; giving up would leave nothing running once it ends);
 * - one that holds the lock and finds that a stop was asked for after it was started leaves at once ("stopped"); that is
 *   what a stop that arrives while the handover is being made turns into;
 * - the successor's own entry is removed once it holds the lock.
 */
export async function acquireStarting(agentDir: string, o: StartingOptions): Promise<AgentLock | { held: false; holder: number; stopped: true }> {
  const acquire = o.acquire ?? acquireAgentLock;
  const isAgent = o.isAgent ?? ((pid: number) => isFleetAgentProcess(pid, agentDir));
  // While it waits, it says it is there (see `isSuccessorProcess`).
  const touch = setInterval(() => {
    try {
      if (readSuccessor(agentDir)?.pid === process.pid) utimesSync(successorPath(agentDir), new Date(), new Date());
    } catch {
      // Gone: it was stopped, or took over.
    }
  }, TOUCH_MS);
  touch.unref?.();
  let lock: AgentLock;
  try {
    lock = await acquire(agentDir, { ...o.lock, waitMs: o.waitMs });
    while (!lock.held && o.replaces !== undefined && lock.holder === o.replaces && isAgent(o.replaces)) {
      o.onWait?.(lock.holder);
      lock = await acquire(agentDir, { ...o.lock, waitMs: o.waitMs });
    }
  } finally {
    clearInterval(touch);
  }
  if (!lock.held) return lock;
  clearSuccessor(agentDir, process.pid);
  if (stopRequestedSince(agentDir, o.startedAt, process.pid)) {
    lock.release();
    return { held: false, holder: 0, stopped: true };
  }
  dropOldStopRequest(agentDir, o.startedAt);
  return lock;
}

/**
 * Look for a request to stop while the agent runs, and call `onStop` (once) when there is one. Returns what ends the look.
 * The look is a read of one small file every `everyMs`.
 */
export function watchForStop(agentDir: string, since: number, onStop: () => void, everyMs: number): () => void {
  let done = false;
  const timer = setInterval(() => {
    if (done || !stopRequestedSince(agentDir, since, process.pid)) return;
    done = true;
    onStop();
  }, everyMs);
  timer.unref?.();
  return () => {
    done = true;
    clearInterval(timer);
  };
}
