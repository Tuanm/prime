// A lock between processes (and between tasks of one), made of a directory: it can only be made once.
//
// The directory holds a note of who made it (`owner`: the pid, a token of its own, the host and the time).
// What makes the things that go wrong with a lock of this kind safe:
//  - a lock is published whole: the directory and its note are made under a name of their own and moved to
//    the lock's name, which only works while that name is free. There is never a lock without a note, and a
//    process that is slow between making the lock and writing the note cannot write it into another's;
//  - a holder only ever removes a lock that is its own (the token), and takes it away by moving it aside
//    first, so that nobody meets one that is half removed;
//  - a lock whose holder is gone (its pid is not running on this host, or it is from before the machine was
//    started, or it is a leftover of this very process) or that is older than `staleMs` is broken by one
//    process at a time (a gate of its own): what is there is looked at again under the gate, and only a lock
//    that is still the one that was judged is moved away. A lock that was judged by another host is not
//    judged by its pid, only by its age;
//  - every wait has a deadline, by the monotonic clock, and the asynchronous lock waits by timers, so the event
//    loop (the agent's heartbeat among it) goes on meanwhile;
//  - a process that lets go of the synchronous lock and wants it again at once (a loop of writes) leaves a
//    moment for the ones waiting for it to take it (see `HANDOFF_MS`): otherwise the holder is back before any
//    of them has looked, and they wait for the whole loop - and for each other's loops - until they give up.
//
// What it does not do: it does not tell a holder that was judged stale while it was still running (it held
// the lock for longer than `staleMs`) that it has lost it, so two holders are possible then, as the age is
// for. It trusts the file system's rename to be atomic, as it is on a local disk; on a network file system
// the clocks of the host and of the server may differ, and a lock is judged by its age only if its host is
// not this one.

import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync, type Stats } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname, uptime } from "node:os";
import { join } from "node:path";

/** Replaced in tests: the file system calls that fail in ways only another platform shows. */
export interface DirLockHooks {
  /** Move a directory (publishing a lock, setting one aside). */
  rename?: (from: string, to: string) => void;
  /** Remove a directory and what is in it. */
  remove?: (path: string) => void;
  /** The platform the refusals are read for (default: this one). */
  platform?: NodeJS.Platform;
}

export interface DirLockOptions {
  /** How long to wait for the lock before giving up (default 5 s). */
  waitMs?: number;
  /** A lock older than this is broken even if its holder seems to be running (default: never). */
  staleMs?: number;
  /** How long a lock without a note (one that an older build made, or damaged) is left before it is judged (default 2 s). */
  graceMs?: number;
  /** For tests only. */
  hooks?: DirLockHooks;
}

/** The lock could not be taken in time. */
export class LockBusyError extends Error {
  constructor(
    readonly lock: string,
    /** What the file system last refused with while the lock could not be made (see `BUSY`), if it did. */
    readonly refused?: NodeJS.ErrnoException,
    /** What stands at the lock's name, when it is not a lock that is merely held. */
    readonly found?: string,
  ) {
    super(
      "another process holds " +
        lock +
        " and did not let go in time" +
        (found ? " (" + found + ")" : "") +
        (refused ? " (" + (refused.code ?? "error") + ": " + refused.message + ")" : ""),
    );
  }
}

interface Owner {
  pid: number;
  token: string;
  host?: string;
  at?: number;
}

// What Windows says, instead of "it exists", to making a directory whose name another process has just
// removed and still has open (it is deleted when the last handle is closed): the lock is as good as held,
// and it is waited for like one. Elsewhere the same codes are real refusals (no permission), and they are
// reported at once.
const BUSY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const busy = (opts: DirLockOptions, err: unknown): boolean =>
  (opts.hooks?.platform ?? process.platform) === "win32" && BUSY_CODES.has((err as NodeJS.ErrnoException).code ?? "");

// What the file system answers to moving a directory onto a name that is taken.
const TAKEN_CODES = new Set(["EEXIST", "ENOTEMPTY", "ENOTDIR"]);

/** A gate that a breaker that died left is removed after this long. */
const BREAK_GATE_MS = 10_000;
/** A lock made before the machine was started (less this) is of a process that is gone, whatever its pid is now. */
const BOOT_MARGIN_MS = 10 * 60_000;

const HOST = hostname();

// The tokens of the locks this process holds now: a note with this process's pid and another token is
// a lock it left behind (a removal that was refused for good), not one that is held.
const held = new Set<string>();

function readOwner(lock: string): Owner | null {
  try {
    const raw = JSON.parse(readFileSync(join(lock, "owner"), "utf8")) as { pid?: unknown; token?: unknown; host?: unknown; at?: unknown };
    if (typeof raw.pid !== "number" || typeof raw.token !== "string") return null;
    return {
      pid: raw.pid,
      token: raw.token,
      ...(typeof raw.host === "string" ? { host: raw.host } : {}),
      ...(typeof raw.at === "number" ? { at: raw.at } : {}),
    };
  } catch {
    return null;
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // No permission to signal it still means that it exists.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// What stands at the lock's name, for an error.
function describe(lock: string): string | undefined {
  try {
    const st = lstatSync(lock);
    if (st.isSymbolicLink()) return "a symbolic link stands there";
    if (!st.isDirectory()) return "a file stands there";
    const owner = readOwner(lock);
    return owner ? "held by process " + owner.pid + (owner.host && owner.host !== HOST ? " on " + owner.host : "") : "a directory without a note stands there";
  } catch {
    return undefined;
  }
}

type Verdict = { token: string | null };

// What to do about a lock that is there: its holder's token if it is stale, null if it is to be waited for.
function judge(lock: string, st: Pick<Stats, "mtimeMs" | "isDirectory">, opts: DirLockOptions): Verdict | null {
  // A lock is a directory: whatever else stands at the name (a link, a file) is not one, and is cleared away.
  if (!st.isDirectory()) return { token: null };
  const age = Date.now() - st.mtimeMs;
  const owner = readOwner(lock);
  if (owner === null) return age > (opts.graceMs ?? 2000) ? { token: null } : null;
  // The holder's pid means something on its own host only.
  const remote = owner.host !== undefined && owner.host !== HOST;
  const old = opts.staleMs !== undefined && age > opts.staleMs;
  if (remote) return old ? { token: owner.token } : null;
  if (owner.pid === process.pid && !held.has(owner.token)) return { token: owner.token };
  if (!running(owner.pid) || old) return { token: owner.token };
  // Made before this machine was started: every process of that time is gone, and the pid is another's now.
  if (owner.at !== undefined && owner.at < Date.now() - uptime() * 1000 - BOOT_MARGIN_MS) return { token: owner.token };
  return null;
}

function removeQuietly(path: string, opts: DirLockOptions): void {
  try {
    (opts.hooks?.remove ?? ((p) => rmSync(p, { recursive: true, force: true })))(path);
  } catch {
    // Left where it was set aside, under a name nobody takes for a lock.
  }
}

const rename = (opts: DirLockOptions, from: string, to: string): void => (opts.hooks?.rename ?? renameSync)(from, to);

// Clear a stale lock away, one process at a time. True when the lock's name has been looked at again and
// may be free (or is a lock that is not the one that was judged); false when it could not be cleared now.
function breakStale(lock: string, judged: Verdict, opts: DirLockOptions): boolean {
  const gate = lock + ".break";
  try {
    mkdirSync(gate);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      // Another is breaking it; a gate that a breaker died holding is removed after a while.
      try {
        if (Date.now() - lstatSync(gate).mtimeMs > BREAK_GATE_MS) rmdirSync(gate);
      } catch {
        // Gone, or not ours to remove.
      }
      return false;
    }
    if (busy(opts, err)) return false;
    throw err;
  }
  try {
    let st: Stats;
    try {
      st = lstatSync(lock);
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT";
    }
    // Under the gate nobody else breaks it, and nobody makes a lock while one is there: it is judged again,
    // and only the lock that was judged is moved.
    const again = judge(lock, st, opts);
    if (again === null || again.token !== judged.token) return true;
    const aside = lock + ".broken." + process.pid + "." + randomBytes(4).toString("hex");
    try {
      rename(opts, lock, aside);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
      return false; // refused: it is waited for until the deadline, and said then
    }
    const was = readOwner(aside);
    if ((was?.token ?? null) !== judged.token) {
      // What was moved is not what was judged (its holder let go and another took the name in between):
      // it is put back if the name is still free; if it is not, it is left where it is rather than removed.
      try {
        rename(opts, aside, lock);
      } catch {
        // Left aside.
      }
      return true;
    }
    removeQuietly(aside, opts);
    return true;
  } finally {
    try {
      rmdirSync(gate);
    } catch {
      // Not ours any more, or refused for a moment: a gate is removed after BREAK_GATE_MS anyway.
    }
  }
}

// Publish a lock whole: made under a name of its own, with its note, and moved to the lock's name. "taken":
// the name is not free; "busy": it is refused as a lock that is being removed is (see `BUSY_CODES`).
function publish(lock: string, token: string, opts: DirLockOptions, last: { refused?: NodeJS.ErrnoException }): "made" | "taken" | "busy" {
  const mine = lock + ".new." + token;
  mkdirSync(mine);
  try {
    writeFileSync(join(mine, "owner"), JSON.stringify({ pid: process.pid, token, host: HOST, at: Date.now() }));
    rename(opts, mine, lock);
    return "made";
  } catch (err) {
    removeQuietly(mine, opts);
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (TAKEN_CODES.has(code)) return "taken";
    if (busy(opts, err)) {
      last.refused = err as NodeJS.ErrnoException;
      return "busy";
    }
    throw err;
  }
}

// One try at taking the lock: true when it is held now, false when somebody holds it, or it cannot be cleared
// now (a stale lock is broken, and taken at once if that frees it). Bounded by `until` like every wait.
function tryTake(lock: string, token: string, opts: DirLockOptions, until: number, last: { refused?: NodeJS.ErrnoException }): boolean {
  while (performance.now() <= until) {
    let st: Stats;
    try {
      st = lstatSync(lock);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        if (busy(opts, err)) {
          last.refused = err as NodeJS.ErrnoException;
          return false;
        }
        throw err;
      }
      const made = publish(lock, token, opts, last);
      if (made === "made") {
        held.add(token);
        return true;
      }
      if (made === "busy") return false;
      continue; // somebody was first: look at what is there
    }
    const stale = judge(lock, st, opts);
    if (stale === null) return false;
    if (!breakStale(lock, stale, opts)) return false;
  }
  return false;
}

/**
 * How long a process that has just let go of the synchronous lock gives the others to take it before it takes
 * it again. A waiter looks every few milliseconds and a holder that comes straight back does so within
 * microseconds, so without this a loop of writes keeps the lock until it is done, and the processes behind it
 * (each with a loop of its own) wait for all of them one after the other. It costs the process that asks again
 * within this time of letting go this long if nobody takes the lock, and no more than this if somebody does.
 */
const HANDOFF_MS = 30;
const letGoAt = new Map<string, number>();

// Whether the lock was let go of a moment ago, and nobody has taken it yet. (Timed by the monotonic clock,
// which a test that sets the date does not move: a wait on a frozen clock would never end.)
function handingOver(lock: string): boolean {
  const at = letGoAt.get(lock);
  if (at === undefined) return false;
  if (performance.now() - at >= HANDOFF_MS || exists(lock)) {
    letGoAt.delete(lock);
    return false;
  }
  return true;
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// One try at letting go of a lock that is ours: "done" (it is not there, or not ours, or removed), or "again"
// (refused for a moment, as Windows does while another process reads the note in it). The lock is moved aside
// first, so its name is free whatever happens to what is in it, and nobody meets a lock that is half removed.
function releaseOnce(lock: string, token: string, opts: DirLockOptions): "done" | "again" {
  if (readOwner(lock)?.token !== token) return "done";
  const aside = lock + ".gone." + token;
  try {
    rename(opts, lock, aside);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (code === "ENOENT") return "done";
    if (busy(opts, err) || code === "ENOTEMPTY") return "again";
    throw err;
  }
  if (readOwner(aside)?.token !== token) {
    // Not ours after all: the lock was broken and taken by another between looking and moving. Put back.
    try {
      rename(opts, aside, lock);
    } catch {
      // Left aside.
    }
    return "done";
  }
  removeQuietly(aside, opts);
  return "done";
}

const RELEASE_TRIES = 10;

function releaseSync(lock: string, token: string, opts: DirLockOptions): void {
  held.delete(token);
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < RELEASE_TRIES; attempt++) {
    if (releaseOnce(lock, token, opts) === "done") break;
    Atomics.wait(nap, 0, 0, 5 * (attempt + 1));
  }
  if (letGoAt.size > 64) letGoAt.clear();
  letGoAt.set(lock, performance.now());
}

async function releaseAsync(lock: string, token: string, opts: DirLockOptions): Promise<void> {
  held.delete(token);
  for (let attempt = 0; attempt < RELEASE_TRIES; attempt++) {
    if (releaseOnce(lock, token, opts) === "done") return;
    await new Promise((r) => setTimeout(r, 5 * (attempt + 1)));
  }
}

/** Run `fn` holding the lock `lock` (a path that does not exist yet). Never holds it past `fn`. */
export async function withDirLock<T>(lock: string, fn: () => Promise<T> | T, opts: DirLockOptions = {}): Promise<T> {
  const until = performance.now() + (opts.waitMs ?? 5000);
  const token = randomBytes(8).toString("hex");
  const last: { refused?: NodeJS.ErrnoException } = {};
  while (!tryTake(lock, token, opts, until, last)) {
    if (performance.now() > until) throw new LockBusyError(lock, last.refused, describe(lock));
    await new Promise((r) => setTimeout(r, 10 + Math.floor(Math.random() * 20)));
  }
  try {
    return await fn();
  } finally {
    await releaseAsync(lock, token, opts);
  }
}

/**
 * `withDirLock` for a critical section of a few milliseconds that has to be synchronous (a read and a
 * write of a small file). It waits by blocking, so only the holder of a lock that is being let go of
 * is waited for: a lock of a process that is gone is broken at once, not waited out.
 */
export function withDirLockSync<T>(lock: string, fn: () => T, opts: DirLockOptions = {}): T {
  const until = performance.now() + (opts.waitMs ?? 2000);
  const token = randomBytes(8).toString("hex");
  const last: { refused?: NodeJS.ErrnoException } = {};
  const nap = new Int32Array(new SharedArrayBuffer(4));
  while (handingOver(lock)) Atomics.wait(nap, 0, 0, 2);
  while (!tryTake(lock, token, opts, until, last)) {
    if (performance.now() > until) throw new LockBusyError(lock, last.refused, describe(lock));
    Atomics.wait(nap, 0, 0, 5);
  }
  try {
    return fn();
  } finally {
    releaseSync(lock, token, opts);
  }
}
