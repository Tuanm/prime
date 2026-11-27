// A lock between processes (and between tasks of one), made of a directory: it can only be made once.
//
// The directory holds a note of who made it (`owner`: the pid, a token of its own, the host and the time).
// What makes the things that go wrong with a lock of this kind safe:
//  - a lock is published whole: the directory and its note are made under a name of their own and moved to
//    the lock's name, which only works while that name is free. There is never a lock without a note, and a
//    process that is slow between making the lock and writing the note cannot write it into another's;
//  - a holder only ever removes a lock that is its own (the token), and takes it away by moving it aside
//    first, so that nobody meets one that is half removed;
//  - a lock whose holder is gone (its pid is not running on this host, or it was made in an earlier boot of this
//    machine, or it is a leftover of this very process) or that is older than `staleMs` is broken by one
//    process at a time (a gate of its own): what is there is looked at again under the gate, and only a lock
//    that is still the one that was judged is moved away. A lock that was judged by another host is not
//    judged by its pid, only by its age;
//  - every wait has a deadline, by the monotonic clock, and the asynchronous lock waits by timers, so the event
//    loop (the agent's heartbeat among it) goes on meanwhile;
//  - a process that lets go of the synchronous lock and wants it again at once (a loop of writes) leaves a
//    moment for the ones waiting for it to take it (see `HANDOFF_MS`): otherwise the holder is back before any
//    of them has looked, and they wait for the whole loop - and for each other's loops - until they give up.
//
// What it does not do: it cannot stop a holder that is judged stale while it is still running (it held the lock
// for longer than `staleMs`) from carrying on, so two holders are possible then, which is what the age is
// for. It makes the loss loud instead of silent: the holder is told it has lost the lock when it asks
// (`held.assert()`, which a critical write does first) and when it lets go (`LockLostError`). It trusts the file
// system's rename to be atomic, as it is on a local disk; on a network file system the clocks of the host and
// of the server may differ, and a lock is judged by its age only if its host is not this one.

import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync, type Stats } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname, uptime } from "node:os";
import { basename, dirname, join } from "node:path";

/** Replaced in tests: the file system calls that fail in ways only another platform shows. */
export interface DirLockHooks {
  /** Move a directory (publishing a lock, setting one aside). */
  rename?: (from: string, to: string) => void;
  /** Remove a directory and what is in it. */
  remove?: (path: string) => void;
  /** The platform the refusals are read for (default: this one). */
  platform?: NodeJS.Platform;
  /** This boot of the machine: an id that differs between boots where there is one, and the uptime in seconds. */
  boot?: () => { id?: string; up: number };
  /** Called just before a lock that is made is moved to the lock's name, with that name. */
  publishing?: (lock: string) => void;
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

/** The lock this holder took was taken from it (it was judged stale while the holder still ran). */
export class LockLostError extends Error {
  constructor(readonly lock: string) {
    super("the lock " + lock + " was taken from this process while it held it: another process may have been working at the same time");
  }
}

/** What a critical section is given, to ask whether it still holds the lock. */
export interface HeldLock {
  /** Throws `LockLostError` if the lock is no longer this holder's. */
  assert(): void;
}

interface Owner {
  pid: number;
  token: string;
  host?: string;
  at?: number;
  up?: number;
  boot?: string;
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

/** A gate is held for microseconds: one that a breaker died inside is removed after this long. */
const BREAK_GATE_MS = 2_000;
/**
 * A lock whose note records a longer uptime than this machine has now (by this much) was made in an earlier
 * boot, and the pid in it is another process's now. Uptime only grows within a boot, and it is not read from
 * the wall clock that is stepped when a machine without a clock gets the time. Where the system has a boot id
 * (Linux), that is compared instead and the margin is not needed.
 */
const BOOT_MARGIN_S = 10 * 60;
/** Leftovers of a process killed mid-way (`.new`, `.gone`, `.broken`) are removed after this long. */
const LITTER_MS = 60_000;

let bootId: string | null | undefined;
function thisBoot(opts: DirLockOptions): { id?: string; up: number } {
  if (opts.hooks?.boot) return opts.hooks.boot();
  if (bootId === undefined) {
    try {
      bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
    } catch {
      bootId = null;
    }
  }
  return { ...(bootId ? { id: bootId } : {}), up: uptime() };
}

const HOST = hostname();

// The tokens of the locks this process holds now: a note with this process's pid and another token is
// a lock it left behind (a removal that was refused for good), not one that is held.
const held = new Set<string>();

function readOwner(lock: string): Owner | null {
  try {
    const raw = JSON.parse(readFileSync(join(lock, "owner"), "utf8")) as { pid?: unknown; token?: unknown; host?: unknown; at?: unknown; up?: unknown; boot?: unknown };
    if (typeof raw.pid !== "number" || typeof raw.token !== "string") return null;
    return {
      pid: raw.pid,
      token: raw.token,
      ...(typeof raw.host === "string" ? { host: raw.host } : {}),
      ...(typeof raw.at === "number" ? { at: raw.at } : {}),
      ...(typeof raw.up === "number" ? { up: raw.up } : {}),
      ...(typeof raw.boot === "string" ? { boot: raw.boot } : {}),
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
    if (!owner) return "a directory without a note stands there";
    if (owner.host && owner.host !== HOST) return "held by process " + owner.pid + " on " + owner.host;
    // A holder that is gone leaves a lock that is cleared away when it can be: if it is still there, it cannot be moved.
    if (!running(owner.pid)) return "left by process " + owner.pid + ", which is no longer running, and it could not be moved";
    return "held by process " + owner.pid;
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
  // Made in an earlier boot of this machine: every process of that time is gone, and the pid is another's now.
  const now = thisBoot(opts);
  if (owner.boot !== undefined && now.id !== undefined ? owner.boot !== now.id : owner.up !== undefined && owner.up > now.up + BOOT_MARGIN_S) return { token: owner.token };
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

function clearDeadGate(gate: string, opts: DirLockOptions): void {
  const aside = gate + ".gone." + randomBytes(4).toString("hex");
  try {
    if (Date.now() - lstatSync(gate).mtimeMs <= BREAK_GATE_MS) return;
    rename(opts, gate, aside);
  } catch {
    return; // gone, or somebody else's to clear
  }
  try {
    // What was moved may be a gate that was made after the one that was looked at: the name is made again.
    if (Date.now() - lstatSync(aside).mtimeMs <= BREAK_GATE_MS) {
      try {
        mkdirSync(gate);
      } catch {
        // Made by another in the meantime: that is the gate now.
      }
    }
    rmdirSync(aside);
  } catch {
    // Left aside; swept as litter.
  }
}

// Clear a stale lock away, one process at a time. True when the lock's name has been looked at again and
// may be free (or is a lock that is not the one that was judged); false when it could not be cleared now.
function breakStale(lock: string, judged: Verdict, opts: DirLockOptions): boolean {
  const gate = lock + ".break";
  try {
    mkdirSync(gate);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      // Another is breaking it. A gate that a breaker died holding is moved aside before it is looked at, so
      // that two who find it old cannot both remove it - and the second remove a gate made since.
      clearDeadGate(gate, opts);
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
function publish(lock: string, token: string, opts: DirLockOptions, last: Attempt): "made" | "taken" | "busy" {
  // A name of its own for this attempt: one that an earlier attempt could not remove must not be made again.
  const mine = lock + ".new." + token + "." + randomBytes(3).toString("hex");
  mkdirSync(mine);
  try {
    const boot = thisBoot(opts);
    writeFileSync(
      join(mine, "owner"),
      JSON.stringify({ pid: process.pid, token, host: HOST, at: Date.now(), up: boot.up, ...(boot.id ? { boot: boot.id } : {}) }),
    );
    opts.hooks?.publishing?.(lock);
    // A rename replaces an empty directory, and an empty directory at the name is a lock that a build of before
    // this one is making (it makes the directory, then writes its note): it is not replaced, it is held.
    if (exists(lock)) {
      removeQuietly(mine, opts);
      return "taken";
    }
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

// Remove what a process killed in the middle of making, setting aside or breaking a lock left beside it.
const sweptAt = new Map<string, number>();
function sweepLitter(lock: string, opts: DirLockOptions): void {
  const last = sweptAt.get(lock);
  if (last !== undefined && performance.now() - last < LITTER_MS) return;
  if (sweptAt.size > 64) sweptAt.clear();
  sweptAt.set(lock, performance.now());
  try {
    const parent = dirname(lock);
    const base = basename(lock);
    for (const name of readdirSync(parent)) {
      if (!name.startsWith(base + ".new.") && !name.startsWith(base + ".gone.") && !name.startsWith(base + ".broken.") && !name.startsWith(base + ".break.gone.")) continue;
      const path = join(parent, name);
      try {
        if (Date.now() - lstatSync(path).mtimeMs > LITTER_MS) removeQuietly(path, opts);
      } catch {
        // Gone already.
      }
    }
  } catch {
    // The directory cannot be listed: nothing is swept.
  }
}

// What one wait for a lock remembers between its tries.
interface Attempt {
  /** The last refusal of the kind a lock that is being removed gets on Windows (see `BUSY_CODES`). */
  refused?: NodeJS.ErrnoException;
  /** When the lock that is there was last looked into (its note read) and found held. */
  looked?: number;
}

/**
 * How often a waiter reads the note of the lock it waits for. Reading it is what opens the file, and where a
 * directory cannot be moved while a file in it is open (Windows) every waiter that is reading it every few
 * milliseconds is a refusal for the holder that is letting go - and a longer turn for everybody behind it.
 */
const LOOK_EVERY_MS = 100;

// One try at taking the lock: true when it is held now, false when somebody holds it, or it cannot be cleared
// now (a stale lock is broken, and taken at once if that frees it). Bounded by `until` like every wait.
function tryTake(lock: string, token: string, opts: DirLockOptions, until: number, last: Attempt): boolean {
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
        sweepLitter(lock, opts);
        return true;
      }
      if (made === "busy") return false;
      continue; // somebody was first: look at what is there
    }
    if (last.looked !== undefined && performance.now() - last.looked < LOOK_EVERY_MS) return false;
    const stale = judge(lock, st, opts);
    if (stale === null) {
      last.looked = performance.now();
      return false;
    }
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

function holdOf(lock: string, token: string): HeldLock {
  return {
    assert: () => {
      if (readOwner(lock)?.token !== token) throw new LockLostError(lock);
    },
  };
}

/**
 * Run `fn` holding the lock `lock` (a path that does not exist yet). Never holds it past `fn`.
 * If the lock was taken from this holder meanwhile (see the header), `fn` can ask (`held.assert()`),
 * and a holder that did not ask is told when `fn` is done (`LockLostError`).
 */
export async function withDirLock<T>(lock: string, fn: (held: HeldLock) => Promise<T> | T, opts: DirLockOptions = {}): Promise<T> {
  const until = performance.now() + (opts.waitMs ?? 5000);
  const token = randomBytes(8).toString("hex");
  const last: Attempt = {};
  while (!tryTake(lock, token, opts, until, last)) {
    if (performance.now() > until) throw new LockBusyError(lock, last.refused, describe(lock));
    await new Promise((r) => setTimeout(r, 10 + Math.floor(Math.random() * 20)));
  }
  let result: T;
  let lost = false;
  try {
    result = await fn(holdOf(lock, token));
    lost = readOwner(lock)?.token !== token;
  } finally {
    await releaseAsync(lock, token, opts);
  }
  if (lost) throw new LockLostError(lock);
  return result;
}

/**
 * `withDirLock` for a critical section of a few milliseconds that has to be synchronous (a read and a
 * write of a small file). It waits by blocking, so only the holder of a lock that is being let go of
 * is waited for: a lock of a process that is gone is broken at once, not waited out.
 */
export function withDirLockSync<T>(lock: string, fn: (held: HeldLock) => T, opts: DirLockOptions = {}): T {
  const until = performance.now() + (opts.waitMs ?? 2000);
  const token = randomBytes(8).toString("hex");
  const last: Attempt = {};
  const nap = new Int32Array(new SharedArrayBuffer(4));
  while (handingOver(lock)) Atomics.wait(nap, 0, 0, 2);
  while (!tryTake(lock, token, opts, until, last)) {
    if (performance.now() > until) throw new LockBusyError(lock, last.refused, describe(lock));
    Atomics.wait(nap, 0, 0, 5);
  }
  let result: T;
  let lost = false;
  try {
    result = fn(holdOf(lock, token));
    lost = readOwner(lock)?.token !== token;
  } finally {
    releaseSync(lock, token, opts);
  }
  if (lost) throw new LockLostError(lock);
  return result;
}
