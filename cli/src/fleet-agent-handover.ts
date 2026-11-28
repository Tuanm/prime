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

import { currentBoot, fromEarlierBoot } from "./boot.ts";
import type { AgentRestart } from "./fleet-daemon.ts";
import { acquireAgentLock, commandOf, isFleetAgentProcess, runsHere, type AgentLock, type AgentLockOptions } from "./fleet-agent-lock.ts";

export const SUCCESSOR_FILE = "successor";
export const STOP_FILE = "stop";

/** How often a waiting successor touches its entry, and how long an entry that was touched is believed. */
const TOUCH_MS = 5_000;
const FRESH_MS = 30_000;
/** How often a successor looks whether the agent it waits for is still there. */
const TURN_MS = 1_000;

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
export function isSuccessorProcess(agentDir: string, pid: number, commandOfPid: (pid: number) => string | undefined = commandOf): boolean {
  if (!pidAlive(pid)) return false;
  const command = commandOfPid(pid);
  // An agent of THIS configuration: another configuration's agent may have been given the pid since.
  if (command !== undefined) return command.includes("__fleet-agent") && runsHere(command, agentDir);
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
  /** The agent it was started to replace (an update says so, once it has started it). */
  replaces?: number;
}

export function readSuccessor(agentDir: string): Successor | undefined {
  try {
    const raw = JSON.parse(readFileSync(successorPath(agentDir), "utf8")) as { pid?: unknown; at?: unknown; replaces?: unknown };
    if (typeof raw.pid !== "number" || typeof raw.at !== "number") return undefined;
    return { pid: raw.pid, at: raw.at, ...(typeof raw.replaces === "number" ? { replaces: raw.replaces } : {}) };
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
): { claimed: true; at: number } | { claimed: false; pid: number } {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      writeFileSync(successorPath(agentDir), JSON.stringify({ pid: 0, at: now }), { flag: "wx", mode: 0o600 });
      return { claimed: true, at: now };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const there = readSuccessor(agentDir);
    // (One that was started for another agent than the one that runs is not waiting for this one's round: it does not
    // stand in the way of an update that goes on from here.)
    if (there && there.pid > 0 && there.pid !== running && (there.replaces === undefined || there.replaces === running) && isAgent(there.pid)) {
      return { claimed: false, pid: there.pid };
    }
    if (there && there.pid === 0 && now - there.at < CLAIM_MS) return { claimed: false, pid: 0 };
    // Left by a successor that is gone, or by one that took over: not waiting for anything.
    rmSync(successorPath(agentDir), { force: true });
  }
  return { claimed: false, pid: 0 };
}

/** Say which process the successor is, once it is started. */
export function registerSuccessor(agentDir: string, pid: number, now: number = Date.now(), replaces?: number): void {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  writeFileSync(successorPath(agentDir), JSON.stringify({ pid, at: now, ...(replaces !== undefined ? { replaces } : {}) }), { mode: 0o600 });
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
 * Whether an update that finds the successor of another may ask the agent that runs to stop (the other update may have
 * died before it did). Only a successor that is registered, is of this configuration and is waiting for exactly that
 * agent, and that has been up for longer than the time an update gives a new build to show it starts, is one that an
 * update is not still at: before that, the update that started it is the one to ask (and to leave the old agent be if the
 * new build does not start), and an agent that the successor was not started to replace is not its to have stopped.
 */
export function mayAskAgainToStop(agentDir: string, running: number, startCheckMs: number, now: number = Date.now(), isAgent: (pid: number) => boolean = (pid) => isSuccessorProcess(agentDir, pid)): boolean {
  const there = readSuccessor(agentDir);
  if (!there || there.pid <= 0 || there.replaces !== running) return false;
  return now - there.at > startCheckMs && isAgent(there.pid);
}

/** The process an update has registered as the successor in place of this one, if one has. */
function supersededBy(agentDir: string): number | undefined {
  const there = readSuccessor(agentDir);
  return there && there.pid > 0 && there.pid !== process.pid ? there.pid : undefined;
}

/** The values an update hands to the agent it starts (read once; see `takeHandoverEnv`). */
export interface Handover {
  /** The time of the update's claim, if it is believable for an agent that was started at `startedAt`. */
  since?: number;
  /** The agent it replaces. */
  replaces?: number;
  /** How long it waits for the lock. */
  lockWaitMs?: number;
}

/** The claim of an update is older than the agent it started by a moment: a time further back than this is not one. */
const SINCE_WINDOW_MS = 60_000;

/**
 * Read the handover variables of an agent's environment and remove them, so that what the agent starts (git, a container,
 * another `prime`) does not take them for its own. A claim time is believed only if it is up to a minute before the
 * moment the process started; one from further back (a variable left in a shell) would make every old stop request count.
 */
export function takeHandoverEnv(env: Record<string, string | undefined>, startedAt: number): Handover {
  const since = Number(env.PRIME_FLEET_SINCE);
  const replaces = Number(env.PRIME_FLEET_REPLACES);
  const wait = env.PRIME_FLEET_LOCK_WAIT_MS;
  const lockWait = Number(wait);
  delete env.PRIME_FLEET_SINCE;
  delete env.PRIME_FLEET_REPLACES;
  delete env.PRIME_FLEET_LOCK_WAIT_MS;
  return {
    ...(Number.isFinite(since) && since > startedAt - SINCE_WINDOW_MS && since <= startedAt + SLACK_MS ? { since } : {}),
    ...(Number.isInteger(replaces) && replaces > 0 ? { replaces } : {}),
    ...(wait !== undefined && wait !== "" && Number.isFinite(lockWait) && lockWait >= 0 ? { lockWaitMs: lockWait } : {}),
  };
}

/**
 * Stop the successor that waits for the lock, if there is one, with the request written first (see `requestStop`). A
 * claim that has no process yet is stopped too: the request is what the successor, which is started after it, finds. An
 * entry that names nothing live is only removed, and asks nobody to stop. True when a live successor was signalled.
 */
export function stopWaitingSuccessor(agentDir: string, now: number = Date.now(), isAgent: (pid: number) => boolean = (pid) => isSuccessorProcess(agentDir, pid), kill?: (pid: number) => void): boolean {
  const there = readSuccessor(agentDir);
  if (!there) return false;
  const live = there.pid > 0 ? isAgent(there.pid) : now - there.at < CLAIM_MS;
  // For the successor, and not for every agent that was started before now: the agent that a service has started
  // meanwhile is not the one that is being stopped. A claim has no process yet to name.
  if (live) requestStop(agentDir, now, there.pid > 0 ? there.pid : undefined);
  return stopSuccessor(agentDir, isAgent, kill) !== undefined;
}

/**
 * Ask for the agents that were started before now to stop (whether they are running, or waiting for the lock). With
 * `only`, for that one agent: an update asks the agent it replaces, and not the successor it started before asking.
 */
export function requestStop(agentDir: string, now: number = Date.now(), only?: number): void {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const boot = currentBoot();
  writeFileSync(
    stopPath(agentDir),
    JSON.stringify({ at: now, ...(only !== undefined ? { only } : {}), ...(boot.id ? { boot: boot.id } : {}), up: boot.up }),
    { mode: 0o600 },
  );
}

/** How far ahead of the clock a request may be before it is taken for impossible (a clock that was stepped back). */
const FUTURE_MS = 5_000;

interface StopRequest {
  at: number;
  only?: number;
  boot?: string;
  up?: number;
}

/**
 * The request in the agent's directory, if it can be believed. The time in it is the wall clock of whoever wrote it, and
 * a clock is stepped: a request from the future, or from an earlier boot, was not written to the agents that are starting
 * now, and one that was kept would stop every one of them until the clock caught up with it.
 */
function readStop(agentDir: string, now: number = Date.now()): { request: StopRequest | undefined; unusable: boolean } {
  let raw: { at?: unknown; only?: unknown; boot?: unknown; up?: unknown };
  try {
    raw = JSON.parse(readFileSync(stopPath(agentDir), "utf8"));
  } catch {
    return { request: undefined, unusable: false };
  }
  if (typeof raw.at !== "number") return { request: undefined, unusable: true };
  const request: StopRequest = {
    at: raw.at,
    ...(typeof raw.only === "number" ? { only: raw.only } : {}),
    ...(typeof raw.boot === "string" ? { boot: raw.boot } : {}),
    ...(typeof raw.up === "number" ? { up: raw.up } : {}),
  };
  if (request.at > now + FUTURE_MS || fromEarlierBoot(request, currentBoot())) return { request: undefined, unusable: true };
  return { request, unusable: false };
}

/** Whether a stop was asked for after `since` (when the asking agent was started), of this agent (`pid`, when it is told). */
export function stopRequestedSince(agentDir: string, since: number, pid?: number): boolean {
  const { request } = readStop(agentDir);
  if (!request || request.at <= since + SLACK_MS) return false;
  return request.only === undefined || pid === undefined || request.only === pid;
}

/** A request that is older than the agent that finds it, or that cannot be believed, is of no use to anybody. */
export function dropOldStopRequest(agentDir: string, since: number): void {
  const { request, unusable } = readStop(agentDir);
  if (unusable || (request && request.at <= since + SLACK_MS)) rmSync(stopPath(agentDir), { force: true });
}

export interface StartingOptions {
  waitMs: number;
  /** When this agent's process was started (ms since the epoch). */
  startedAt: number;
  /** The agent this one replaces, which was asked to stop: while it holds the lock, this one waits on. */
  replaces?: number;
  /** How long one turn of that wait is (a test shortens it). */
  turnMs?: number;
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
    if (o.replaces === undefined) lock = await acquire(agentDir, { ...o.lock, waitMs: o.waitMs });
    else {
      // The wait is made in short turns, to see whether the agent it was to replace is still the one it waits for.
      let until = Date.now() + o.waitMs;
      for (;;) {
        lock = await acquire(agentDir, { ...o.lock, waitMs: Math.max(0, Math.min(until - Date.now(), o.turnMs ?? TURN_MS)) });
        if (lock.held) break;
        if (lock.holder === o.replaces && isAgent(o.replaces)) {
          // It is still at its round: this one keeps waiting for it, for as long as it does.
          if (Date.now() >= until) {
            o.onWait?.(lock.holder);
            until = Date.now() + Math.max(o.waitMs, TURN_MS);
          }
          continue;
        }
        // Another agent has the lock, and the one that was to be replaced is gone (someone started one meanwhile). This
        // one waits on for what is left of its time, as the agent may be gone before long (and then nothing runs
        // unless this one does); it leaves if an update has put another successor in its place, which is what stops it
        // standing in the way of the updates after it.
        if (lock.holder > 0 && lock.holder !== o.replaces && supersededBy(agentDir) !== undefined) break;
        if (Date.now() >= until) break;
      }
    }
  } finally {
    clearInterval(touch);
  }
  // Gave up: its entry is not a successor's any more, and its pid is any process's before long.
  if (!lock.held) {
    clearSuccessor(agentDir, process.pid);
    return lock;
  }
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

/**
 * What `prime update --json` says of the agent restart. `agent_restarted` is only there when this update restarted (or
 * asked to restart) the agent: when another update is at it, this one did nothing, and says so alone.
 */
export function agentRestartJson(restart: AgentRestart | { error: string }): Record<string, unknown> {
  if ("error" in restart) return { agent_restart_error: restart.error };
  if (!restart.restarted) return {};
  if (restart.inProgress) return { agent_restart_in_progress: true };
  return { agent_restarted: restart.via, ...(restart.pending ? { agent_restart_pending: true } : {}) };
}
