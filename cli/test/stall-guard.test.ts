// The guard against a test run that is stuck in a synchronous call (stall-guard.ts), run on fixture files of its own: a
// test file that blocks for a minute must end the run within seconds, saying where, and a file that does not must not
// notice the guard.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callerFile, stallMs, STALL_MS } from "./stall-guard";
import { callsOf, hasTimeLimit, lineOf, scanCode } from "./scan-code";
import { HELPER_SYNC_MS, SYNC_BACKSTOP_MS, SYNC_CHILD_MS } from "./sync-limit";
import { SERVICE_CALL_MS, SERVICE_POWERSHELL_MS } from "../src/service";
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
  test("is the backstop behind every limit a single call has, with half a minute to spare", () => {
    // A call that is only slow ends by its own limit, as one failed test; the guard that ends the whole run must come later.
    const limits = [SYNC_CHILD_MS, HELPER_SYNC_MS, SERVICE_CALL_MS, ...(process.platform === "win32" ? [SERVICE_POWERSHELL_MS] : [])];
    for (const limit of limits) expect(stallMs({})).toBeGreaterThanOrEqual(limit + 30_000);
    expect(STALL_MS).toBe(SYNC_BACKSTOP_MS);
    expect(SYNC_BACKSTOP_MS).toBe(process.platform === "win32" ? 150_000 : 90_000);
  });

  test("is that, unless PRIME_TEST_STALL_MS says otherwise, and 0 turns the guard off", () => {
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
    // Where it can be listed (pgrep, or the process table on Windows), the child it waits for is named by its command line.
    expect(r.out).toContain("stall-fixture-child");
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

describe("a run that is ended from outside", () => {
  test.skipIf(process.platform === "win32")("says where it was, and exits as a terminated process does", async () => {
    const r = await runFixture(
      "terminated.test.ts",
      `test("quick one", () => {});
test("is terminated", async () => { process.kill(process.pid, "SIGTERM"); await Bun.sleep(5000); });`,
      { PRIME_TEST_STALL_MS: "30000" },
    );
    expect(r.code).toBe(143);
    expect(r.out).toContain("TEST RUN SIGTERMed in");
    expect(r.out).not.toContain("from outside");
    expect(r.out).toContain("terminated.test.ts");
    expect(r.out).toMatch(/after 2 test\(s\) had started/);
    expect(r.out).not.toContain("TEST STALLED");
  }, 60_000);
});

describe("what the tests left behind when the run is ended", () => {
  // The fixture is a run of its own, with its own temporary root: it ends what names that root, and nothing else.
  test.skipIf(process.platform === "win32")("a process whose parent is gone and whose command line names the run's own temporary root is listed and ended; one of another run is not touched", async () => {
    const tag = process.pid + "-" + Date.now();
    // Another run on the machine (here: this one, a suite of its own) with an agent of its own that has been left to init.
    const other = join(tmpdir(), "fleet-concurrent-" + tag);
    cleanups.push(() => void Bun.spawnSync(["pkill", "-f", other], { timeout: SYNC_CHILD_MS }));
    Bun.spawnSync(["sh", "-c", `(sh -c 'sleep 600; : ${other}' >/dev/null 2>&1 &) ; exit 0`], { timeout: 10_000 });
    const r = await runFixture(
      "orphans.test.ts",
      // The shell that starts it leaves at once, so that init takes the process over, as it does a detached agent of a test.
      `import { tmpdir } from "node:os";
import { join } from "node:path";
test("leaves one and blocks", () => {
  const mine = join(tmpdir(), "fleet-orphan-${tag}");
  Bun.spawnSync(["sh", "-c", "(sh -c 'sleep 600; : " + mine + "' >/dev/null 2>&1 &) ; exit 0"], { timeout: 10_000 });
  Bun.spawnSync([process.execPath, "-e", "setTimeout(() => {}, 600000)"], { timeout: 120_000 });
});`,
      { PRIME_TEST_STALL_MS: "1500" },
    );
    cleanups.push(() => void Bun.spawnSync(["pkill", "-f", "fleet-orphan-" + tag], { timeout: SYNC_CHILD_MS }));
    expect(r.out).toContain("TEST STALLED");
    expect(r.out).toContain("whose parent has gone");
    expect(r.out).toContain("fleet-orphan-" + tag);
    expect(r.out).not.toContain("fleet-concurrent-" + tag);
    await Bun.sleep(300);
    const alive = (pattern: string): string => Bun.spawnSync(["pgrep", "-f", pattern], { stdout: "pipe", timeout: SYNC_CHILD_MS }).stdout.toString().trim();
    expect(alive("fleet-orphan-" + tag)).toBe("");
    expect(alive(other)).not.toBe("");
  }, 60_000);

  test.skipIf(process.platform === "win32")("each run has a temporary root of its own, which is TMPDIR for what it starts", async () => {
    const r = await runFixture(
      "root.test.ts",
      `import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
test("root", () => { console.log("ROOT " + tmpdir() + " " + spawnSync("sh", ["-c", "echo $TMPDIR"], { encoding: "utf8", timeout: 10_000 }).stdout.trim()); });`,
      { PRIME_TEST_STALL_MS: "30000" },
    );
    const m = /ROOT (\S+) (\S+)/.exec(r.out);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(m![2]);
    expect(m![1]).toMatch(/[\\/]pr-[A-Za-z0-9]+$/);
    expect(m![1]).not.toBe(tmpdir());
  }, 60_000);
});

describe("the reader of source that the scans use", () => {
  test("blanks comments, strings, regular expressions and the text of templates, and keeps code, offsets and lines", () => {
    const src = [
      "const a = f(1); // g(2)",
      "/* h(3)",
      "   i(4) */ const b = j(5);",
      'const s = "k(6)" + \'l(7)\';',
      "const r = /m\\(8\\)['\"`]/.test(s);",
      "const t = `n(9) ${ o(10, `p(11) ${q(12)}`) } r(13)`;",
    ].join("\n");
    const { code, clean } = scanCode(src);
    expect(clean).toBe(true);
    expect(code.length).toBe(src.length);
    expect(code.split("\n").length).toBe(src.split("\n").length);
    const names = [...code.matchAll(/\b([a-z])\(/g)].map((m) => m[1]);
    expect(names).toEqual(["f", "j", "o", "q"]);
  });

  test("says when it lost its way, instead of reading the rest of the file as nothing", () => {
    expect(scanCode('const a = "never closed;\nf(1);').clean).toBe(false);
    expect(scanCode("/* never closed\nf(1);").clean).toBe(false);
    expect(scanCode("const t = `never closed ${f(1)}").clean).toBe(false);
    expect(scanCode("const x = a / b; f(2); const y = c / d;").clean).toBe(true);
  });

  test("a time limit is a limit: not 0, undefined, null or false, not a word in a comment, and a shorthand counts", () => {
    const limited = (text: string): boolean => callsOf(scanCode(text).code, /\bspawnSync\(/g).every((c) => hasTimeLimit(c.call));
    expect(limited('spawnSync(["a"], { timeout: 30_000 })')).toBe(true);
    expect(limited('spawnSync(["a"], { stdout: "pipe", timeout: SYNC_CHILD_MS })')).toBe(true);
    expect(limited('spawnSync(["a"], { timeout: opts.timeoutMs ?? 60_000 })')).toBe(true);
    expect(limited('spawnSync(["a"], { timeout })')).toBe(true);
    expect(limited('spawnSync(["a"], { stdout: "pipe" })')).toBe(false);
    expect(limited('spawnSync(["a"], { timeout: 0 })')).toBe(false);
    expect(limited('spawnSync(["a"], { timeout: undefined })')).toBe(false);
    expect(limited('spawnSync(["a"], { timeout: null })')).toBe(false);
    expect(limited('spawnSync(["a"], { noTimeout: true })')).toBe(false);
    expect(limited('spawnSync(["a"], { stdout: "pipe" /* timeout: 5 */ }) // timeout: 5')).toBe(false);
    expect(limited('spawnSync(["a"], { stdout: `timeout: ${5}` })')).toBe(false);
    expect(limited('spawnSync(["a", `${f(")")}`], { timeout: 5 })')).toBe(true); // a ")" inside an expression of a template
  });
});

describe("a synchronous spawn", () => {
  // A call that blocks the thread the test's time limit is kept by needs a limit of its own: without one, a child that does
  // not exit holds the run (a full `bun test` hung for ten minutes on one). The guard ends such a run, but only as the backstop.
  const root = join(import.meta.dir, "..");
  const sources = (dir: string): string[] => readdirSync(join(root, dir)).filter((f) => f.endsWith(".ts")).map((f) => join(root, dir, f));
  const CALL = /\b(?:Bun\.)?(?:spawnSync|execFileSync|execSync)\s*\(/g;

  test("in a test file or a helper carries a time limit", () => {
    const missing: string[] = [];
    for (const file of [...sources("test").filter((f) => f.endsWith(".test.ts")), ...sources("test/helpers")]) {
      const text = readFileSync(file, "utf8");
      const { code, clean } = scanCode(text);
      expect(clean, file + " could not be read to the end").toBe(true);
      for (const { at, call } of callsOf(code, CALL)) if (!hasTimeLimit(call)) missing.push(`${file}:${lineOf(text, at)}`);
    }
    expect(missing).toEqual([]);
  });

  test("in the product has one, or says why not (`no time limit:` in the lines above it)", () => {
    const missing: string[] = [];
    let seen = 0;
    for (const file of sources("src")) {
      const text = readFileSync(file, "utf8");
      const { code, clean } = scanCode(text);
      expect(clean, file + " could not be read to the end").toBe(true);
      for (const { at, call } of callsOf(code, CALL)) {
        seen++;
        const line = lineOf(text, at);
        const above = text.split("\n").slice(Math.max(0, line - 4), line).join("\n");
        if (!hasTimeLimit(call) && !/no time limit:/.test(above)) missing.push(`${file}:${line}`);
      }
    }
    expect(seen).toBeGreaterThan(8); // the scan finds them
    expect(missing).toEqual([]);
  });
});
