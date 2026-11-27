// Loaded before every `bun test` run in this package (see bunfig.toml).
//
// A test's default time limit is five seconds. Tests here drive git, spawn processes and write
// work trees, which take several times longer on a Windows runner (and longer still on its
// emulated Arm one), so a test that is fine runs out of time there, and the one that is still
// running when it is abandoned goes on to use what the next test has set up. Elsewhere the limit
// stays where it is; PRIME_TEST_TIMEOUT_MS sets it for any platform.
import { setDefaultTimeout } from "bun:test";

const WINDOWS_MS = 60_000;
const asked = Number(process.env.PRIME_TEST_TIMEOUT_MS);
const ms = Number.isFinite(asked) && asked > 0 ? asked : process.platform === "win32" ? WINDOWS_MS : undefined;
if (ms !== undefined) setDefaultTimeout(ms);
