import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync as renameFor, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LockBusyError, withDirLock, withDirLockSync, type DirLockOptions } from "../src/dir-lock";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    try {
      chmodSync(d, 0o755);
    } catch {
      // Gone.
    }
    rmSync(d, { recursive: true, force: true });
  }
});
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "dir-lock-"));
  dirs.push(d);
  return d;
};

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code + ": refused"), { code });
// A process of another that stays alive for the test, so that its pid is a live one that is not this process's.
const aliveChildren: Array<ReturnType<typeof Bun.spawn>> = [];
function otherLivePid(): number {
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  aliveChildren.push(child);
  return child.pid;
}
afterAll(() => {
  for (const c of aliveChildren) c.kill();
});
const DEAD_PID = 2 ** 22 + 4242;
function leave(lock: string, note: Record<string, unknown>): void {
  mkdirSync(lock);
  writeFileSync(join(lock, "owner"), JSON.stringify(note));
}
function age(path: string, ms: number): void {
  const t = new Date(Date.now() - ms);
  utimesSync(path, t, t);
}
// Run a body in a process of its own with a hard limit: a wait that never ends cannot be stopped from inside.
async function inChild(body: string, limitMs = 10_000): Promise<{ code: number | null; out: string; killed: boolean }> {
  const script =
    "import { withDirLockSync, withDirLock, LockBusyError } from " + JSON.stringify(join(import.meta.dir, "../src/dir-lock.ts")) + ";" +
    "const t0 = performance.now(); try { const r = await (async () => {" + body + "})(); console.log('ok ' + JSON.stringify(r)); } catch (e) { console.log('threw ' + e.constructor.name + ' ' + e.message); }";
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe", timeout: limitMs, killSignal: "SIGKILL" });
  const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return { code, out: out.trim(), killed: child.signalCode !== null };
}

describe("writers in several processes take turns", () => {
  test("a process in a loop of writes does not keep the lock from the others until its loop is done", async () => {
    const root = scratch();
    const lock = join(root, "the.lock");
    const counter = join(root, "count");
    writeFileSync(counter, "0");
    // Each writer holds the lock for 40 ms (a write that is flushed to a slow disk) and comes back at once,
    // twelve times, and may wait two seconds for it. Six of them take 2.9 s one after the other, so the last
    // can only get through if they take turns: one that runs its whole loop before the next starts makes it
    // wait for everybody else's (2.4 s). Taking turns, nobody waits for more than the five others' one write.
    const script =
      "import { withDirLockSync } from " + JSON.stringify(join(import.meta.dir, "../src/dir-lock.ts")) + ";" +
      "import { readFileSync, writeFileSync } from 'node:fs';" +
      "const [lock, counter] = process.argv.slice(1); const nap = new Int32Array(new SharedArrayBuffer(4));" +
      "for (let k = 0; k < 12; k++)" +
      " withDirLockSync(lock, () => { writeFileSync(counter, String(Number(readFileSync(counter, 'utf8')) + 1)); Atomics.wait(nap, 0, 0, 40); }, { waitMs: 2000, staleMs: 10000 });";
    const children = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, "-e", script, lock, counter], { env: process.env, stdout: "ignore", stderr: "pipe" }));
    // None of them gives up on the lock, and none is let in while another holds it (a count that a
    // reader-and-writer under the lock gets wrong by one has lost an update).
    for (const c of children) {
      const [code, said] = await Promise.all([c.exited, new Response(c.stderr).text()]);
      expect({ code, said }).toEqual({ code: 0, said: "" });
    }
    expect(Number(readFileSync(counter, "utf8"))).toBe(6 * 12);
    // Nothing is left beside the lock.
    expect(readdirSync(root).sort()).toEqual(["count"]);
  }, 60_000);

  test("writers that are killed inside the lock, with others waiting to break it, are never inside it together", async () => {
    const root = scratch();
    const lock = join(root, "state.lock");
    const log = join(root, "log");
    writeFileSync(log, "");
    const script =
      "import { withDirLockSync, LockBusyError } from " + JSON.stringify(join(import.meta.dir, "../src/dir-lock.ts")) + "; import { appendFileSync } from 'node:fs';" +
      "const [lock, log] = process.argv.slice(1); const nap = new Int32Array(new SharedArrayBuffer(4)); let n = 0;" +
      "for (;;) { try { withDirLockSync(lock, () => { const id = process.pid + '.' + (n++); appendFileSync(log, 'E ' + id + '\\n');" +
      " if (Math.random() < 0.2) { appendFileSync(log, 'C ' + id + '\\n'); process.kill(process.pid, 'SIGKILL'); }" +
      " Atomics.wait(nap, 0, 0, 1); appendFileSync(log, 'X ' + id + '\\n'); }, { waitMs: 2000, staleMs: 10000 }); }" +
      " catch (e) { if (!(e instanceof LockBusyError)) appendFileSync(log, 'F ' + String(e) + '\\n'); } }";
    const end = Date.now() + 6000;
    const kids = new Set<ReturnType<typeof Bun.spawn>>();
    const spawn = (): void => {
      const k = Bun.spawn([process.execPath, "-e", script, lock, log], { stdout: "ignore", stderr: "ignore" });
      kids.add(k);
      void k.exited.then(() => {
        kids.delete(k);
        if (Date.now() < end) spawn();
      });
    };
    for (let i = 0; i < 4; i++) spawn();
    while (Date.now() < end) await Bun.sleep(100);
    for (const k of kids) k.kill("SIGKILL");
    await Bun.sleep(300);
    let inside: string | null = null;
    let overlaps = 0;
    let entries = 0;
    let crashes = 0;
    const failures: string[] = [];
    for (const line of readFileSync(log, "utf8").split("\n")) {
      const [t, id] = line.split(" ");
      if (t === "E") {
        entries++;
        if (inside !== null) overlaps++;
        inside = id!;
      } else if ((t === "X" || t === "C") && id === inside) {
        inside = null;
        if (t === "C") crashes++;
      } else if (t === "C") crashes++;
      else if (t === "F") failures.push(line);
    }
    // The run did what it is for: many holders, a good part of them killed with the lock in their hands.
    expect(crashes).toBeGreaterThan(5);
    expect(entries).toBeGreaterThan(50);
    expect(failures).toEqual([]);
    expect(overlaps).toBe(0);
  }, 30_000);

  test("a writer that comes back after letting go of the lock waits for the others at most a moment when nobody takes it", () => {
    const root = scratch();
    const lock = join(root, "the.lock");
    const started = Date.now();
    for (let k = 0; k < 5; k++) withDirLockSync(lock, () => undefined);
    // It gives the others up to 30 ms each time it comes back (the first time it has nothing to wait for).
    expect(Date.now() - started).toBeLessThan(5 * 30 + 400);
  });

  test("a clock that a test has frozen does not make a writer wait for ever for the lock it let go of", async () => {
    const root = scratch();
    const { code, out, killed } = await inChild(
      "Date.now = () => 1_000_000; for (let k = 0; k < 3; k++) withDirLockSync(" + JSON.stringify(join(root, "the.lock")) + ", () => undefined, { waitMs: 2000 }); return 'done';",
    );
    expect({ code, out, killed }).toEqual({ code: 0, out: 'ok "done"', killed: false });
  }, 30_000);
});

describe("what stands at the lock's name", () => {
  test("a symbolic link that leads nowhere, or round in a circle, is cleared away and the lock taken, without a spin", async () => {
    for (const make of [
      (root: string) => symlinkSync(join(root, "nowhere"), join(root, "state.lock")),
      (root: string) => symlinkSync(join(root, "state.lock"), join(root, "state.lock")),
    ]) {
      const root = scratch();
      make(root);
      for (const call of ["withDirLockSync(L, () => 1, { waitMs: 200 })", "await withDirLock(L, () => 1, { waitMs: 200 })"]) {
        const { out, killed } = await inChild("const L = " + JSON.stringify(join(root, "state.lock")) + "; return " + call + ";", 8000);
        expect({ out, killed }).toEqual({ out: "ok 1", killed: false });
        // The next one finds the name free again.
        rmSync(join(root, "state.lock"), { force: true, recursive: true });
        make(root);
      }
    }
  }, 60_000);

  test("a link to a directory is removed, and the directory it led to is left alone", () => {
    const root = scratch();
    const target = join(root, "target");
    mkdirSync(target);
    writeFileSync(join(target, "keep"), "x");
    symlinkSync(target, join(root, "state.lock"));
    expect(withDirLockSync(join(root, "state.lock"), () => "took it")).toBe("took it");
    expect(existsSync(join(target, "keep"))).toBe(true);
  });

  test("a stale lock that cannot be moved is waited for until the deadline, and the error says what stands there", () => {
    const root = scratch();
    const lock = join(root, "state.lock");
    leave(lock, { pid: DEAD_PID, token: "dead" });
    const started = performance.now();
    let caught: unknown;
    try {
      withDirLockSync(lock, () => "no", { waitMs: 200, hooks: { rename: () => { throw errno("EPERM"); }, platform: "win32" } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LockBusyError);
    expect((caught as LockBusyError).message).toContain("held by process " + DEAD_PID);
    // Not a spin, and not a wait past the deadline.
    expect(performance.now() - started).toBeLessThan(1500);
  });

  test("a symbolic link at the name is named in the error when it cannot be cleared", () => {
    const root = scratch();
    symlinkSync(join(root, "nowhere"), join(root, "state.lock"));
    expect(() => withDirLockSync(join(root, "state.lock"), () => "no", { waitMs: 100, hooks: { rename: () => { throw errno("EBUSY"); }, platform: "win32" } })).toThrow(/symbolic link/);
  });
});

describe("a refusal from the file system", () => {
  test("on Windows, a lock whose name is still being removed is waited for, not failed on", () => {
    const root = scratch();
    let refused = 2;
    const opts: DirLockOptions = {
      hooks: {
        platform: "win32",
        rename: (from, to) => {
          if (refused-- > 0) throw errno("EPERM");
          renameFor(from, to);
        },
      },
    };
    expect(withDirLockSync(join(root, "the.lock"), () => "took it", opts)).toBe("took it");
    expect(refused).toBeLessThan(0);
    expect(readdirSync(root)).toEqual([]);
  });

  test("on Windows, a refusal that does not stop is reported with what the file system said, when the wait is over", () => {
    const root = scratch();
    const opts: DirLockOptions = { waitMs: 60, hooks: { platform: "win32", rename: () => { throw errno("EACCES"); } } };
    let caught: unknown;
    try {
      withDirLockSync(join(root, "the.lock"), () => "no", opts);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LockBusyError);
    expect((caught as LockBusyError).message).toContain("EACCES");
    expect(readdirSync(root)).toEqual([]);
  });

  test("elsewhere, a refusal of permission is an error at once, not a lock that is held", () => {
    const root = scratch();
    const started = performance.now();
    expect(() => withDirLockSync(join(root, "the.lock"), () => "no", { waitMs: 2000, hooks: { platform: "linux", rename: () => { throw errno("EACCES"); } } })).toThrow(/EACCES/);
    expect(performance.now() - started).toBeLessThan(500);
    expect(readdirSync(root)).toEqual([]);
  });

  test("a directory that may not be written to is an error at once, with the real cause", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return; // permissions are not what they are for this user
    const root = scratch();
    mkdirSync(join(root, "ro"));
    chmodSync(join(root, "ro"), 0o555);
    for (const call of ["withDirLockSync(L, () => 1, { waitMs: 3000 })", "await withDirLock(L, () => 1, { waitMs: 3000 })"]) {
      const { out } = await inChild("const L = " + JSON.stringify(join(root, "ro", "state.lock")) + "; return " + call + ";");
      expect(out).toMatch(/^threw Error .*EACCES|^threw Error .*permission denied/i);
      expect(out).not.toContain("LockBusyError");
    }
  }, 30_000);
});

describe("a lock that cannot be removed", () => {
  // The lock is made (the rename that publishes it is let through the first time), and letting go of it is refused.
  function refusedRelease(): DirLockOptions {
    let publishing = true;
    return {
      hooks: {
        platform: "win32",
        rename: (from, to) => {
          if (publishing) {
            publishing = false;
            renameFor(from, to);
            return;
          }
          throw errno("EPERM");
        },
      },
    };
  }

  test("the process that left it is not kept out by it: its own leftover is taken over", () => {
    const root = scratch();
    const lock = join(root, "state.lock");
    expect(withDirLockSync(lock, () => "first", refusedRelease())).toBe("first");
    expect(existsSync(lock)).toBe(true); // still there: its removal was refused
    const started = performance.now();
    expect(withDirLockSync(lock, () => "second", { waitMs: 2000, staleMs: 10_000 })).toBe("second");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("a lock that is held, by this process, is not taken for a leftover of it", async () => {
    const root = scratch();
    const lock = join(root, "state.lock");
    let release!: () => void;
    const holding = withDirLock(lock, () => new Promise<void>((r) => (release = r)));
    await Bun.sleep(20);
    await expect(withDirLock(lock, () => "no", { waitMs: 100 })).rejects.toBeInstanceOf(LockBusyError);
    release();
    await holding;
  });

  test("letting go of the asynchronous lock does not stop the event loop while it is refused", async () => {
    const root = scratch();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    let first = true;
    const hooks: DirLockOptions["hooks"] = {
      platform: "win32",
      rename: (from, to) => {
        if (first) {
          first = false;
          renameFor(from, to);
          return;
        }
        throw errno("EBUSY");
      },
    };
    const started = performance.now();
    await withDirLock(join(root, "apply.lock"), () => undefined, { hooks });
    clearInterval(timer);
    expect(performance.now() - started).toBeGreaterThan(100); // the retries were made
    expect(ticks).toBeGreaterThan(20); // and the loop went on meanwhile
  });
});

describe("a lock that another made", () => {
  test("a lock cannot be published into one that was made in the meantime, and leaves nothing behind", () => {
    const root = scratch();
    const lock = join(root, "state.lock");
    const pid = otherLivePid();
    let first = true;
    const opts: DirLockOptions = {
      waitMs: 150,
      hooks: {
        rename: (from, to) => {
          // Another process makes its lock between this one's look and its move.
          if (first) {
            first = false;
            leave(lock, { pid, token: "theirs", host: undefined, at: Date.now() });
          }
          renameFor(from, to);
        },
      },
    };
    expect(() => withDirLockSync(lock, () => "no", opts)).toThrow(LockBusyError);
    // Theirs is as it was made: nothing was written into it, and nothing of this one's is left beside it.
    expect(JSON.parse(readFileSync(join(lock, "owner"), "utf8")).token).toBe("theirs");
    expect(readdirSync(root)).toEqual(["state.lock"]);
  });

  test("a lock of another host is not judged by its pid, only by its age", () => {
    const root = scratch();
    const lock = join(root, "state.lock");
    leave(lock, { pid: DEAD_PID, token: "far away", host: "some-other-host.example", at: Date.now() });
    expect(() => withDirLockSync(lock, () => "no", { waitMs: 100, staleMs: 60_000 })).toThrow(LockBusyError);
    age(lock, 120_000);
    expect(withDirLockSync(lock, () => "took it", { waitMs: 1000, staleMs: 60_000 })).toBe("took it");
  });

  test("a lock of a process that is gone is broken at once, and one of a live process is not", () => {
    const root = scratch();
    const lock = join(root, "state.lock");
    leave(lock, { pid: DEAD_PID, token: "dead", at: Date.now() });
    const started = performance.now();
    expect(withDirLockSync(lock, () => "took it", { waitMs: 2000 })).toBe("took it");
    expect(performance.now() - started).toBeLessThan(500);
    leave(lock, { pid: otherLivePid(), token: "alive", at: Date.now() });
    expect(() => withDirLockSync(lock, () => "no", { waitMs: 100 })).toThrow(LockBusyError);
  });

  test("a lock made before the machine was started is of a process that is gone, though its pid is a live one's now", () => {
    const root = scratch();
    const lock = join(root, "apply.lock");
    const pid = otherLivePid();
    // Written by an older build: no time in it, so it is as good as its pid.
    leave(lock, { pid, token: "before the reboot" });
    expect(() => withDirLockSync(lock, () => "no", { waitMs: 100 })).toThrow(LockBusyError);
    rmSync(lock, { recursive: true });
    // Made a month before the machine started.
    leave(lock, { pid, token: "before the reboot", at: Date.now() - 400 * 86_400_000 });
    expect(withDirLockSync(lock, () => "took it", { waitMs: 1000 })).toBe("took it");
  });

  test("a lock without a note is left for a moment and then cleared, a gate a breaker died in is cleared too", () => {
    const root = scratch();
    const lock = join(root, "state.lock");
    mkdirSync(lock);
    expect(() => withDirLockSync(lock, () => "no", { waitMs: 100, graceMs: 5000 })).toThrow(LockBusyError);
    age(lock, 10_000);
    mkdirSync(lock + ".break");
    age(lock + ".break", 60_000);
    // The first look removes the gate that was left, the next takes the lock.
    expect(withDirLockSync(lock, () => "took it", { waitMs: 2000, graceMs: 2000 })).toBe("took it");
    expect(readdirSync(root)).toEqual([]);
  });
});
