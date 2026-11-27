// The time limit of the tests in a file, which each test file asks for (`applyTestTimeout()`).
//
// A test's default time limit is five seconds. Tests here drive git, spawn processes and write
// work trees, which take several times longer on a Windows runner (and longer still on its
// emulated Arm one), so a test that is fine runs out of time there, and the one that is still
// running when it is abandoned goes on to use what the next test has set up. Elsewhere the limit
// stays where it is; PRIME_TEST_TIMEOUT_MS sets it for any platform.
//
// Asked for by each file, not by a preload: a preload did not take effect on the Windows runner.
import { setDefaultTimeout } from "bun:test";

const WINDOWS_MS = 60_000;

/** The limit for this platform, or undefined to leave the runner's own. */
export function testTimeoutMs(env: Record<string, string | undefined> = process.env, platform: string = process.platform): number | undefined {
  const asked = Number(env.PRIME_TEST_TIMEOUT_MS);
  if (Number.isFinite(asked) && asked > 0) return asked;
  return platform === "win32" ? WINDOWS_MS : undefined;
}

export function applyTestTimeout(): void {
  const ms = testTimeoutMs();
  if (ms !== undefined) setDefaultTimeout(ms);
}
