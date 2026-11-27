// A lock between processes (and between tasks of one), made of a directory: it can only be made once.
//
// The directory holds a note of who made it (`owner`: the pid and a token of its own). That is what
// makes the three things that go wrong with a lock of this kind safe:
//  - a holder only ever removes a lock that is its own (the token), never one that was taken from
//    it after it was judged dead;
//  - a lock whose holder is gone (its pid is not running) or that is older than `staleMs` is broken
//    by renaming it to a name of the breaker's own and checking the note of what was renamed: a
//    breaker that took a lock that was not the stale one gives it back, and two breakers cannot
//    both remove a lock one of them has just made;
//  - waiting is by timers, so the event loop (the agent's heartbeat among it) goes on meanwhile;
//  - a process that lets go of a lock and wants it again at once (a loop of writes, with the synchronous
//    lock) leaves a moment for the ones waiting for it to take it (see `HANDOFF_MS`): otherwise the holder is back before any of
//    them has looked, and they wait for the whole loop - and for each other's loops - until they give up.

import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export interface DirLockOptions {
  /** How long to wait for the lock before giving up (default 5 s). */
  waitMs?: number;
  /** A lock older than this is broken even if its holder seems to be running (default: never). */
  staleMs?: number;
  /** How long a lock with no note of its holder is left to be written before it is judged (default 2 s). */
  graceMs?: number;
}

/** The lock could not be taken in time. */
export class LockBusyError extends Error {
  constructor(readonly lock: string) {
    super("another process holds " + lock + " and did not let go in time");
  }
}

interface Owner {
  pid: number;
  token: string;
}

function readOwner(lock: string): Owner | null {
  try {
    const raw = JSON.parse(readFileSync(join(lock, "owner"), "utf8")) as { pid?: unknown; token?: unknown };
    return typeof raw.pid === "number" && typeof raw.token === "string" ? { pid: raw.pid, token: raw.token } : null;
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

/**
 * How long a process that has just let go of a lock gives the others to take it before it takes it again.
 * A waiter looks every few milliseconds and a holder that comes straight back does so within microseconds,
 * so without this a loop of writes keeps the lock until it is done, and the processes behind it (each
 * with a loop of its own) wait for all of them one after the other. It costs only the process that asks
 * again within this time of letting go, and only until somebody has taken the lock.
 */
const HANDOFF_MS = 30;
const letGoAt = new Map<string, number>();

// Whether the lock was let go of a moment ago, and nobody has taken it yet. (Timed by the monotonic clock,
// which a test that sets the date does not move: a wait on a frozen clock would never end.)
function handingOver(lock: string): boolean {
  const at = letGoAt.get(lock);
  if (at === undefined) return false;
  if (performance.now() - at >= HANDOFF_MS || existsSync(lock)) {
    letGoAt.delete(lock);
    return false;
  }
  return true;
}

// What to do about a lock that is there: its holder's note if it is stale, null if it is to be waited for,
// "gone" if it is not there any more (it was let go of while looking: take it).
function staleOwner(lock: string, opts: DirLockOptions): { token: string | null } | "gone" | null {
  let age: number;
  try {
    age = Date.now() - statSync(lock).mtimeMs;
  } catch {
    return "gone";
  }
  const owner = readOwner(lock);
  if (owner === null) return age > (opts.graceMs ?? 2000) ? { token: null } : null;
  if (!running(owner.pid) || (opts.staleMs !== undefined && age > opts.staleMs)) return { token: owner.token };
  return null;
}

function breakLock(lock: string, judged: { token: string | null }, opts: DirLockOptions): void {
  const aside = lock + ".broken." + process.pid + "." + randomBytes(4).toString("hex");
  try {
    renameSync(lock, aside);
  } catch {
    return; // someone else broke it, or it is gone: look again
  }
  const was = readOwner(aside);
  let fresh = false;
  if (was === null) {
    try {
      fresh = Date.now() - statSync(aside).mtimeMs <= (opts.graceMs ?? 2000);
    } catch {
      fresh = false;
    }
  }
  if ((was?.token ?? null) !== judged.token || fresh) {
    // What was moved is not what was judged: it is a lock that was taken in between. Give it back.
    try {
      renameSync(aside, lock);
      return;
    } catch {
      // Taken again meanwhile: the one that was moved was nobody's by now.
    }
  }
  rmSync(aside, { recursive: true, force: true });
}

// One try at taking the lock: true when it is held now, false when somebody holds it (a stale lock is
// broken, and taken at once if that frees it).
function tryTake(lock: string, token: string, opts: DirLockOptions): boolean {
  for (;;) {
    try {
      mkdirSync(lock);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const stale = staleOwner(lock, opts);
      if (stale === null) return false;
      // A lock that is gone by now is nobody's: it is not broken (what stands there next may be somebody's
      // that was just made), the name is taken again.
      if (stale !== "gone") breakLock(lock, stale, opts);
      continue;
    }
    try {
      writeFileSync(join(lock, "owner"), JSON.stringify({ pid: process.pid, token }));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // The directory that was just made is gone: a breaker that judged the lock before this one stood
      // there moved it away. It is nobody's to remove, and the lock is taken again.
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      // Not removed with what is in it: an empty directory is this one's, one with a note is not.
      try {
        rmdirSync(lock);
      } catch {
        // Somebody else's by now.
      }
      throw err;
    }
    return true;
  }
}

// Only a lock that is still this one's: one that was broken and taken by another is theirs.
function release(lock: string, token: string): void {
  if (readOwner(lock)?.token !== token) return;
  rmSync(lock, { recursive: true, force: true });
  if (letGoAt.size > 64) letGoAt.clear();
  letGoAt.set(lock, performance.now());
}

/** Run `fn` holding the lock `lock` (a path that does not exist yet). Never holds it past `fn`. */
export async function withDirLock<T>(lock: string, fn: () => Promise<T> | T, opts: DirLockOptions = {}): Promise<T> {
  const until = Date.now() + (opts.waitMs ?? 5000);
  const token = randomBytes(8).toString("hex");
  while (!tryTake(lock, token, opts)) {
    if (Date.now() > until) throw new LockBusyError(lock);
    await new Promise((r) => setTimeout(r, 10 + Math.floor(Math.random() * 20)));
  }
  try {
    return await fn();
  } finally {
    release(lock, token);
  }
}

/**
 * `withDirLock` for a critical section of a few milliseconds that has to be synchronous (a read and a
 * write of a small file). It waits by blocking, so only the holder of a lock that is being let go of
 * is waited for: a lock of a process that is gone is broken at once, not waited out.
 */
export function withDirLockSync<T>(lock: string, fn: () => T, opts: DirLockOptions = {}): T {
  const until = Date.now() + (opts.waitMs ?? 2000);
  const token = randomBytes(8).toString("hex");
  const nap = new Int32Array(new SharedArrayBuffer(4));
  while (handingOver(lock)) Atomics.wait(nap, 0, 0, 2);
  while (!tryTake(lock, token, opts)) {
    if (Date.now() > until) throw new LockBusyError(lock);
    Atomics.wait(nap, 0, 0, 5);
  }
  try {
    return fn();
  } finally {
    release(lock, token);
  }
}
