// The guard against a test run that is stuck in a synchronous call (stall-guard.ts), run on fixture files of its own: a
// test file that blocks for a minute must end the run within seconds, saying where, and a file that does not must not
// notice the guard.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callerFile, stallMs, STALL_MS } from "./stall-guard";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const SETUP = JSON.stringify(join(import.meta.dir, "setup.ts"));

/** Runs `bun test` on a file with the given body (after the lines that ask for the guard). */
async function runFixture(name: string, body: string, env: Record<string, string> = {}): Promise<{ code: number | null; out: string; ms: number }> {
  const dir = mkdtempSync(join(tmpdir(), "stall-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, name);
  writeFileSync(file, `import { test, expect } from "bun:test";\nimport { applyTestTimeout } from ${SETUP};\napplyTestTimeout();\n${body}\n`);
  const t0 = Date.now();
  const p = Bun.spawn([process.execPath, "test", file], { cwd: dir, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const killer = setTimeout(() => p.kill("SIGKILL"), 40_000);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(killer);
  return { code, out: out + err, ms: Date.now() - t0 };
}

describe("the setting", () => {
  test("is 45 s unless PRIME_TEST_STALL_MS says otherwise, and 0 turns the guard off", () => {
    expect(stallMs({})).toBe(STALL_MS);
    expect(stallMs({ PRIME_TEST_STALL_MS: "" })).toBe(STALL_MS);
    expect(stallMs({ PRIME_TEST_STALL_MS: "nope" })).toBe(STALL_MS);
    expect(stallMs({ PRIME_TEST_STALL_MS: "-5" })).toBe(STALL_MS);
    expect(stallMs({ PRIME_TEST_STALL_MS: "1500" })).toBe(1500);
    expect(stallMs({ PRIME_TEST_STALL_MS: "0" })).toBe(0);
  });

  test("the file that asked is the first frame that is not the guard's or setup's", () => {
    const stack = ["Error", "    at callerFile (/r/cli/test/stall-guard.ts:50:30)", "    at applyTestTimeout (/r/cli/test/setup.ts:28:3)", "    at <anonymous> (/r/cli/test/fleets.test.ts:12:1)", "    at loader (/x/y.ts:1:1)"].join("\n");
    expect(callerFile(stack)).toBe("/r/cli/test/fleets.test.ts");
    expect(callerFile("    at <anonymous> (D:\\a\\prime\\prime\\cli\\test\\fleets.test.ts:12:1)")).toBe("D:\\a\\prime\\prime\\cli\\test\\fleets.test.ts");
    expect(callerFile("")).toBe("(unknown file)");
  });
});

describe("a test run that blocks its thread", () => {
  test("is ended within seconds, and the message names the file and the process it waits for", async () => {
    const r = await runFixture(
      "blocks.test.ts",
      // The child is what a spawnSync would wait for; it has a command line that names it.
      `test("quick one", () => {});
test("never returns", () => { Bun.spawnSync([process.execPath, "-e", "setTimeout(() => {}, 600000) /* stall-fixture-child */"]); });
test("not reached", () => {});`,
      { PRIME_TEST_STALL_MS: "1500" },
    );
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("TEST STALLED");
    expect(r.out).toContain("blocks.test.ts");
    expect(r.out).toContain("(pass) quick one");
    if (process.platform !== "win32") expect(r.out).toContain("stall-fixture-child");
    expect(r.out).not.toContain("not reached");
    expect(r.ms).toBeLessThan(30_000);
  }, 60_000);

  test("a long wait that does not block the thread is the runner's own time limit, not a stall", async () => {
    const r = await runFixture("waits.test.ts", `test("sleeps", async () => { await Bun.sleep(2500); expect(1).toBe(1); });`, { PRIME_TEST_STALL_MS: "1000" });
    expect(r.out).not.toContain("TEST STALLED");
    expect(r.code).toBe(0);
  }, 60_000);

  test("a test that sets the date does not make the guard see a stall", async () => {
    const r = await runFixture(
      "dated.test.ts",
      `import { setSystemTime } from "bun:test";
test("sets the date far back and waits", async () => { setSystemTime(new Date("2001-02-03T04:05:06Z")); await Bun.sleep(2500); expect(new Date().getFullYear()).toBe(2001); setSystemTime(); });`,
      { PRIME_TEST_STALL_MS: "1000" },
    );
    expect(r.out).not.toContain("TEST STALLED");
    expect(r.code).toBe(0);
  }, 60_000);

  test("a run that does not block ends as soon as its tests do, with the guard running", async () => {
    const r = await runFixture("fine.test.ts", `test("fine", () => { expect(1).toBe(1); });`, { PRIME_TEST_STALL_MS: "5000" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 pass");
    expect(r.ms).toBeLessThan(20_000);
  }, 60_000);

  test("PRIME_TEST_STALL_MS=0 leaves the guard off", async () => {
    const r = await runFixture("off.test.ts", `test("blocks a while", () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500); });`, { PRIME_TEST_STALL_MS: "0" });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("TEST STALLED");
  }, 60_000);
});

describe("a synchronous spawn in a test", () => {
  // `Bun.spawnSync` blocks the thread the test's time limit is kept by: without a limit of its own, a child that does
  // not exit holds the run (a full `bun test` hung for ten minutes on one). The guard ends such a run in 45 s; this keeps
  // the call itself from needing it.
  const dir = import.meta.dir;
  const files = [
    ...readdirSync(dir).filter((f) => f.endsWith(".test.ts")).map((f) => join(dir, f)),
    ...readdirSync(join(dir, "helpers")).filter((f) => f.endsWith(".ts")).map((f) => join(dir, "helpers", f)),
  ];
  /** The text of each call of `name(`, up to its closing parenthesis (strings and templates are skipped over). */
  function callsOf(text: string, name: RegExp): Array<{ at: number; call: string }> {
    const out: Array<{ at: number; call: string }> = [];
    for (const m of text.matchAll(name)) {
      if (/["'`]/.test(text[m.index! - 1] ?? "")) continue; // the text of a call in a string (a test of a scan)
      let depth = 0;
      let i = m.index! + m[0].length - 1;
      const start = i;
      for (; i < text.length; i++) {
        const c = text[i]!;
        if (c === '"' || c === "'" || c === "`") {
          for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
        } else if (c === "(") depth++;
        else if (c === ")" && --depth === 0) break;
      }
      out.push({ at: m.index!, call: text.slice(start, i + 1) });
    }
    return out;
  }

  test("carries a time limit, in every test file and helper", () => {
    const missing: string[] = [];
    for (const file of files) {
      if (file.endsWith("stall-guard.test.ts")) continue; // its fixtures block on purpose
      const text = readFileSync(file, "utf8");
      for (const { at, call } of callsOf(text, /\b(?:Bun\.spawnSync|spawnSync)\(/g)) {
        if (!/timeout/.test(call)) missing.push(`${file}:${text.slice(0, at).split("\n").length}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("the scan sees a call without a limit", () => {
    const calls = callsOf('x(); Bun.spawnSync(["a", ")"], { stdout: "pipe" }); y(); Bun.spawnSync(["b"], { timeout: 5 });', /\bBun\.spawnSync\(/g);
    expect(calls.map((c) => /timeout/.test(c.call))).toEqual([false, true]);
  });
});
