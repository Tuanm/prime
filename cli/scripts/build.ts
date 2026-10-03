// Build the `mcp` CLI.
//
//   bun scripts/build.ts              full cross-platform compile + JS bundle
//   bun scripts/build.ts --host-only  just this machine's binary (fast, for tests)
//   bun scripts/build.ts --bundle-only  just the portable JS bundle
//
// `bun build --compile` embeds the Bun runtime, so each artifact runs on a
// machine with no Bun installed. Targets are listed explicitly because a
// cross-compiled binary needs its own runtime downloaded once.

import { chmodSync, copyFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { $ } from "bun";

const ROOT = new URL("..", import.meta.url).pathname;
const ENTRY = `${ROOT}src/index.ts`;
const DIST = `${ROOT}dist`;

interface BuildTarget {
  /** Bun --target value. */
  target: string;
  /** Output file name. */
  out: string;
}

const TARGETS: BuildTarget[] = [
  { target: "bun-darwin-arm64", out: "mcp-darwin-arm64" },
  { target: "bun-darwin-x64", out: "mcp-darwin-x64" },
  { target: "bun-linux-x64", out: "mcp-linux-x64" },
  { target: "bun-linux-arm64", out: "mcp-linux-arm64" },
  { target: "bun-windows-x64", out: "mcp-windows-x64.exe" },
];

const args = new Set(process.argv.slice(2));
const hostOnly = args.has("--host-only");
const bundleOnly = args.has("--bundle-only");

// Version precedence: --version <value> flag, MCP_CLI_VERSION env, package.json.
const versionFlagIndex = process.argv.indexOf("--version");
const pkg = (await Bun.file(`${ROOT}package.json`).json()) as { version?: string };
const VERSION = versionFlagIndex !== -1 ? process.argv[versionFlagIndex + 1] : (process.env.MCP_CLI_VERSION ?? pkg.version ?? "0.0.0");
if (!VERSION || !/^\d+\.\d+\.\d+/.test(VERSION)) {
  console.error(`invalid version "${VERSION}"`);
  process.exit(1);
}
// `process.env.MCP_CLI_VERSION` is substituted with the literal at build time,
// so the artifact reports the version it was built from - not the environment.
const DEFINE = `--define=process.env.MCP_CLI_VERSION="${VERSION}"`;
console.log(`version ${VERSION}`);

mkdirSync(DIST, { recursive: true });

// The JS bundle is the lightweight option: ~100 KB, needs Bun at runtime.
if (!args.has("--no-bundle")) {
  const out = `${DIST}/mcp.js`;
  // No `banner`: src/index.ts already starts with a shebang and Bun preserves
  // it, so adding one here produces a second "#!/usr/bin/env bun" on line 3 -
  // which is a syntax error, not a comment. `bun dist/mcp.js` then exits 1
  // without running anything (and still "starts fast", which is how the bug
  // survived a timing-only check).
  const result = await Bun.build({
    entrypoints: [ENTRY],
    target: "bun",
    minify: true,
    outdir: DIST,
    naming: "mcp.js",
    define: { "process.env.MCP_CLI_VERSION": JSON.stringify(VERSION) },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  // Guard: a bundle that does not actually run must fail the build, not ship.
  const smoke = Bun.spawnSync(["bun", out, "--version"], { stdout: "pipe", stderr: "pipe" });
  const printed = smoke.stdout.toString().trim();
  if (smoke.exitCode !== 0 || !printed.startsWith("mcp ")) {
    console.error(`FAILED bundle smoke test: exit=${smoke.exitCode} stdout=${JSON.stringify(printed)} stderr=${smoke.stderr.toString().trim().slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`bundle  ${out}  ${(statSync(out).size / 1024).toFixed(1)} KB  (runs: ${printed})`);
}

if (bundleOnly) process.exit(0);

// process.platform says "win32" where Bun's target says "windows".
const hostTarget = `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const selected = hostOnly ? TARGETS.filter((t) => t.target === hostTarget) : TARGETS;

if (selected.length === 0) {
  // Fall back to the compiler's own default target when the host pair is unusual.
  const out = `${DIST}/mcp`;
  rmSync(out, { force: true });
  await $`bun build --compile --minify --bytecode ${DEFINE} --outfile ${out} ${ENTRY}`;
  console.log(`compile ${out}  ${(statSync(out).size / 1024 / 1024).toFixed(1)} MB`);
  process.exit(0);
}

for (const { target, out } of selected) {
  const path = `${DIST}/${out}`;
  rmSync(path, { force: true });
  try {
    // --bytecode precompiles the module graph, which measurably cuts cold
    // start (~30-40% on an M1). It requires the entry to be free of top-level
    // await; src/index.ts uses a floating async IIFE for exactly this reason.
    await $`bun build --compile --minify --bytecode ${DEFINE} --target=${target} --outfile ${path} ${ENTRY}`.quiet();
    console.log(`compile ${path}  ${(statSync(path).size / 1024 / 1024).toFixed(1)} MB  (${target})`);
    // Also expose the host build under its bare name, so a local run yields a
    // binary literally called `mcp` (the name it is installed as).
    if (target === hostTarget) {
      const bare = `${DIST}/mcp${process.platform === "win32" ? ".exe" : ""}`;
      copyFileSync(path, bare);
      chmodSync(bare, 0o755);
      console.log(`install ${bare}  (same binary, no platform suffix)`);
    }
  } catch (err) {
    console.error(`FAILED ${target}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
