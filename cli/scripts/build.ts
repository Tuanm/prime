// Build the `prime` CLI.
//
//   bun scripts/build.ts              full cross-platform compile + JS bundle
//   bun scripts/build.ts --host-only  just this machine's binary (fast, for tests)
//   bun scripts/build.ts --bundle-only  just the portable JS bundle
//
// The code-mcp device buddy ("prime code-mcp" / "prime connect") is built in from
// src/code-mcp.ts in this package - so an artifact is reproducible
// from the commit it was built at. Every artifact is smoke-tested to run it.
//
// `bun build --compile` embeds the Bun runtime, so each artifact runs on a
// machine with no Bun installed. Targets are listed explicitly because a
// cross-compiled binary needs its own runtime downloaded once.

import { chmodSync, copyFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { $ } from "bun";
import { versionProblem as versionProblemFor } from "../src/version.ts";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname: on Windows the latter is "/D:/a/..." -
// not a path any API accepts.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = `${ROOT}src/index.ts`;
const DIST = `${ROOT}dist`;

interface BuildTarget {
  /** Bun --target value. */
  target: string;
  /** Output file name. */
  out: string;
}

const TARGETS: BuildTarget[] = [
  { target: "bun-darwin-arm64", out: "prime-darwin-arm64" },
  { target: "bun-darwin-x64", out: "prime-darwin-x64" },
  { target: "bun-linux-x64", out: "prime-linux-x64" },
  { target: "bun-linux-arm64", out: "prime-linux-arm64" },
  { target: "bun-windows-x64", out: "prime-windows-x64.exe" },
  { target: "bun-windows-arm64", out: "prime-windows-arm64.exe" },
];

const args = new Set(process.argv.slice(2));
const hostOnly = args.has("--host-only");
const bundleOnly = args.has("--bundle-only");

// Version precedence: --version <value> flag, MCP_CLI_VERSION env, package.json.
const versionFlagIndex = process.argv.indexOf("--version");
const pkg = (await Bun.file(`${ROOT}package.json`).json()) as { version?: string };
const VERSION = versionFlagIndex !== -1 ? process.argv[versionFlagIndex + 1] : (process.env.MCP_CLI_VERSION ?? pkg.version ?? "0.0.0");
if (!VERSION) {
  console.error("no version given and package.json has none");
  process.exit(1);
}
const versionProblem = versionProblemFor(VERSION);
if (versionProblem) {
  console.error(versionProblem);
  process.exit(1);
}
// `process.env.MCP_CLI_VERSION` is substituted with the literal at build time,
// so the artifact reports the version it was built from - not the environment.
const DEFINE = `--define=process.env.MCP_CLI_VERSION="${VERSION}"`;
console.log(`version ${VERSION}`);

/** The bundled code-mcp must be reachable in the artifact, not just in src/. */
function codeMcpSmoke(command: string[]): string | undefined {
  // Run from a directory without src/, so only the embedded copy can answer.
  const smoke = Bun.spawnSync([...command, "code-mcp", "--help"], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe" });
  const out = smoke.stdout.toString();
  if (smoke.exitCode === 0 && out.includes("--gateway-token")) return undefined;
  return `exit=${smoke.exitCode} stdout=${JSON.stringify(out.slice(0, 120))} stderr=${smoke.stderr.toString().trim().slice(0, 200)}`;
}

mkdirSync(DIST, { recursive: true });

// The JS bundle is the lightweight option: ~100 KB, needs Bun at runtime.
if (!args.has("--no-bundle")) {
  const out = `${DIST}/prime.js`;
  // No `banner`: src/index.ts already starts with a shebang and Bun preserves
  // it, so adding one here produces a second "#!/usr/bin/env bun" on line 3 -
  // which is a syntax error, not a comment. `bun dist/prime.js` then exits 1
  // without running anything (and still "starts fast", which is how the bug
  // survived a timing-only check).
  const result = await Bun.build({
    entrypoints: [ENTRY],
    target: "bun",
    minify: true,
    outdir: DIST,
    naming: "prime.js",
    define: { "process.env.MCP_CLI_VERSION": JSON.stringify(VERSION) },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  // Guard: a bundle that does not actually run must fail the build, not ship.
  const smoke = Bun.spawnSync(["bun", out, "--version"], { stdout: "pipe", stderr: "pipe" });
  const printed = smoke.stdout.toString().trim();
  if (smoke.exitCode !== 0 || !printed.startsWith("prime ")) {
    console.error(`FAILED bundle smoke test: exit=${smoke.exitCode} stdout=${JSON.stringify(printed)} stderr=${smoke.stderr.toString().trim().slice(0, 200)}`);
    process.exit(1);
  }
  const codeMcp = codeMcpSmoke(["bun", out]);
  if (codeMcp) {
    console.error(`FAILED bundle code-mcp smoke test: ${codeMcp}`);
    process.exit(1);
  }
  console.log(`bundle  ${out}  ${(statSync(out).size / 1024).toFixed(1)} KB  (runs: ${printed}; code-mcp bundled)`);
}

if (bundleOnly) process.exit(0);

// process.platform says "win32" where Bun's target says "windows".
const hostTarget = `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const selected = hostOnly ? TARGETS.filter((t) => t.target === hostTarget) : TARGETS;

if (selected.length === 0) {
  // Fall back to the compiler's own default target when the host pair is unusual.
  const out = `${DIST}/prime`;
  rmSync(out, { force: true });
  await $`bun build --compile --minify --bytecode --format=esm ${DEFINE} --outfile ${out} ${ENTRY}`;
  console.log(`compile ${out}  ${(statSync(out).size / 1024 / 1024).toFixed(1)} MB`);
  process.exit(0);
}

for (const { target, out } of selected) {
  const path = `${DIST}/${out}`;
  rmSync(path, { force: true });
  try {
    // --format=esm: the bundled code-mcp (src/code-mcp.ts) uses top-level
    // await, which the default CommonJS bytecode output rejects; ESM bytecode
    // accepts it and starts just as fast.
    // --bytecode precompiles the module graph, which measurably cuts cold
    // start (~30-40% on an M1). It requires the entry to be free of top-level
    // await; src/index.ts uses a floating async IIFE for exactly this reason.
    await $`bun build --compile --minify --bytecode --format=esm ${DEFINE} --target=${target} --outfile ${path} ${ENTRY}`.quiet();
    console.log(`compile ${path}  ${(statSync(path).size / 1024 / 1024).toFixed(1)} MB  (${target})`);
    // Also expose the host build under its bare name, so a local run yields a
    // binary literally called `prime` (the name it is installed as).
    if (target === hostTarget) {
      const codeMcp = codeMcpSmoke([path]);
      if (codeMcp) {
        console.error(`FAILED ${target} code-mcp smoke test: ${codeMcp}`);
        process.exitCode = 1;
        continue;
      }
      const bare = `${DIST}/prime${process.platform === "win32" ? ".exe" : ""}`;
      copyFileSync(path, bare);
      chmodSync(bare, 0o755);
      console.log(`install ${bare}  (same binary, no platform suffix)`);
    }
  } catch (err) {
    console.error(`FAILED ${target}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
