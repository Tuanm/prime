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

mkdirSync(DIST, { recursive: true });

// The JS bundle is the lightweight option: ~100 KB, needs Bun at runtime.
if (!args.has("--no-bundle")) {
  const out = `${DIST}/mcp.js`;
  const result = await Bun.build({
    entrypoints: [ENTRY],
    target: "bun",
    minify: true,
    outdir: DIST,
    naming: "mcp.js",
    banner: "#!/usr/bin/env bun",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  console.log(`bundle  ${out}  ${(statSync(out).size / 1024).toFixed(1)} KB`);
}

if (bundleOnly) process.exit(0);

// process.platform says "win32" where Bun's target says "windows".
const hostTarget = `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const selected = hostOnly ? TARGETS.filter((t) => t.target === hostTarget) : TARGETS;

if (selected.length === 0) {
  // Fall back to the compiler's own default target when the host pair is unusual.
  const out = `${DIST}/mcp`;
  rmSync(out, { force: true });
  await $`bun build --compile --minify --outfile ${out} ${ENTRY}`;
  console.log(`compile ${out}  ${(statSync(out).size / 1024 / 1024).toFixed(1)} MB`);
  process.exit(0);
}

for (const { target, out } of selected) {
  const path = `${DIST}/${out}`;
  rmSync(path, { force: true });
  try {
    await $`bun build --compile --minify --target=${target} --outfile ${path} ${ENTRY}`.quiet();
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
