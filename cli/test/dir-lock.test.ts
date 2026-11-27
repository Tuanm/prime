import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDirLockSync } from "../src/dir-lock";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

describe("the lock between processes, with several of them writing in turn", () => {
  test("a process in a loop of writes does not keep the lock from the others until its loop is done", async () => {
    const root = mkdtempSync(join(tmpdir(), "dir-lock-fair-"));
    try {
      const lock = join(root, "the.lock");
      const counter = join(root, "count");
      writeFileSync(counter, "0");
      // Each writer holds the lock for 20 ms (a write that is flushed to a slow disk) and comes back at once,
      // fifteen times, and may wait two seconds for it. Eight of them take 2.4 s one after the other, so they
      // can only all get through if they take turns: one that runs its whole loop before the next starts
      // makes the last wait for everybody else's.
      const script =
        "import { withDirLockSync } from " + JSON.stringify(join(import.meta.dir, "../src/dir-lock.ts")) + ";" +
        "import { readFileSync, writeFileSync } from 'node:fs';" +
        "const [lock, counter] = process.argv.slice(1); const nap = new Int32Array(new SharedArrayBuffer(4));" +
        "for (let k = 0; k < 15; k++)" +
        " withDirLockSync(lock, () => { writeFileSync(counter, String(Number(readFileSync(counter, 'utf8')) + 1)); Atomics.wait(nap, 0, 0, 20); }, { waitMs: 2000, staleMs: 10000 });";
      const children = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, "-e", script, lock, counter], { env: process.env, stdout: "ignore", stderr: "pipe" }));
      // None of them gives up on the lock, and none is let in while another holds it (a count that a
      // reader-and-writer under the lock gets wrong by one has lost an update).
      for (const c of children) {
        const [code, said] = await Promise.all([c.exited, new Response(c.stderr).text()]);
        expect({ code, said }).toEqual({ code: 0, said: "" });
      }
      expect(Number(readFileSync(counter, "utf8"))).toBe(8 * 15);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("a clock that a test has frozen does not make a writer wait for ever for the lock it let go of", async () => {
    const root = mkdtempSync(join(tmpdir(), "dir-lock-frozen-"));
    try {
      const script =
        "import { withDirLockSync } from " + JSON.stringify(join(import.meta.dir, "../src/dir-lock.ts")) + ";" +
        "Date.now = () => 1_000_000; const lock = process.argv[1];" +
        "for (let k = 0; k < 3; k++) withDirLockSync(lock, () => undefined, { waitMs: 2000 }); console.log('done');";
      // In a process of its own, with a limit: a wait that never ends cannot be stopped from inside.
      const child = Bun.spawn([process.execPath, "-e", script, join(root, "the.lock")], { stdout: "pipe", stderr: "pipe", timeout: 10_000, killSignal: "SIGKILL" });
      const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect({ code, out: out.trim() }).toEqual({ code: 0, out: "done" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("a writer that comes back after the lock was let go of waits for nobody when nobody is waiting", () => {
    const root = mkdtempSync(join(tmpdir(), "dir-lock-alone-"));
    try {
      const lock = join(root, "the.lock");
      const started = Date.now();
      for (let k = 0; k < 5; k++) withDirLockSync(lock, () => undefined);
      // It gives the others a moment each time (at most 30 ms), and not more than that.
      expect(Date.now() - started).toBeLessThan(5 * 60);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
