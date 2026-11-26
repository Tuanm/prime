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
//  - waiting is by timers, so the event loop (the agent's heartbeat among it) goes on meanwhile.

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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

// What to do about a lock that is there: its holder's note if it is stale, null if it is to be waited for.
function staleOwner(lock: string, opts: DirLockOptions): { token: string | null } | null {
  let age: number;
  try {
    age = Date.now() - statSync(lock).mtimeMs;
  } catch {
    return { token: null }; // gone while looking: try to take it
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

/** Run `fn` holding the lock `lock` (a path that does not exist yet). Never holds it past `fn`. */
export async function withDirLock<T>(lock: string, fn: () => Promise<T> | T, opts: DirLockOptions = {}): Promise<T> {
  const until = Date.now() + (opts.waitMs ?? 5000);
  const token = randomBytes(8).toString("hex");
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const stale = staleOwner(lock, opts);
    if (stale) {
      breakLock(lock, stale, opts);
      continue;
    }
    if (Date.now() > until) throw new LockBusyError(lock);
    await new Promise((r) => setTimeout(r, 10 + Math.floor(Math.random() * 20)));
  }
  try {
    writeFileSync(join(lock, "owner"), JSON.stringify({ pid: process.pid, token }));
  } catch (err) {
    rmSync(lock, { recursive: true, force: true });
    throw err;
  }
  try {
    return await fn();
  } finally {
    // Only a lock that is still this one's: one that was broken and taken by another is theirs.
    if (readOwner(lock)?.token === token) rmSync(lock, { recursive: true, force: true });
  }
}
