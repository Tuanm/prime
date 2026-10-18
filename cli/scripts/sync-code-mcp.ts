// Refresh the vendored code-mcp device server (src/code-mcp.ts) from upstream.
//
//   bun scripts/sync-code-mcp.ts                 newest main: local checkout, else GitHub
//   bun scripts/sync-code-mcp.ts --from <path>   a specific local checkout (or file)
//   bun scripts/sync-code-mcp.ts --github        skip local checkouts, fetch from GitHub
//   bun scripts/sync-code-mcp.ts --ref <ref>     another branch/tag/commit (default main)
//   bun scripts/sync-code-mcp.ts --check         verify the vendored copy only, change nothing
//   bun scripts/sync-code-mcp.ts --allow-offline no source reachable -> keep the vendored copy, exit 0
//
// Why a vendored copy instead of a symlink to ../../code-mcp: CI and every
// other clone do not have the sibling repository, so a symlink would break the
// build there. The copy is byte-identical to upstream and its provenance (repo,
// commit, sha256) is recorded in src/code-mcp.source.json; the unit tests check
// the two agree.
//
// Source order: --from, then the sibling checkout ../../code-mcp (relative to
// cli/), then GitHub (public repo; set GITHUB_TOKEN to raise the API limit).
// A local checkout contributes its committed <ref> (as it is locally - run
// "git pull" there first for the newest upstream), never uncommitted edits, so
// the recorded commit always describes the vendored bytes exactly.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const TARGET = join(ROOT, "src", "code-mcp.ts");
const META = join(ROOT, "src", "code-mcp.source.json");
const REPO = process.env.CODE_MCP_REPO ?? "Tuanm/code-mcp";
const FILE = "code-mcp.ts";
const SIBLING = resolve(ROOT, "..", "..", "code-mcp");

export interface SourceMeta {
  repo: string;
  path: string;
  ref: string;
  commit: string;
  sha256: string;
  bytes: number;
}

interface Fetched {
  content: Uint8Array;
  commit: string;
  ref: string;
  from: string;
}

const argv = process.argv.slice(2);
const has = (name: string) => argv.includes(name);
const value = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const fromPath = value("--from");
const ref = value("--ref") ?? "main";
const check = has("--check");
const allowOffline = has("--allow-offline");
const githubOnly = has("--github");

export function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function git(cwd: string, args: string[]): { ok: boolean; out: Buffer } {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout };
}

/** Sanity check: anything that is not the code-mcp script must never be vendored. */
function looksLikeCodeMcp(bytes: Uint8Array): boolean {
  const text = new TextDecoder().decode(bytes.subarray(0, 4096));
  return bytes.length > 10_000 && text.startsWith("#!/usr/bin/env bun") && /MCP server/i.test(text);
}

function fromLocal(path: string, explicit: boolean): Fetched | undefined {
  if (!existsSync(path)) {
    if (explicit) throw new Error(`--from ${path}: no such file or directory`);
    return undefined;
  }
  if (statSync(path).isFile()) {
    // A bare file has no history: record it honestly as unversioned.
    return { content: new Uint8Array(readFileSync(path)), commit: "unversioned", ref: "file", from: path };
  }
  const top = git(path, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    const file = join(path, FILE);
    if (!existsSync(file)) {
      if (explicit) throw new Error(`--from ${path}: neither a git checkout nor a directory containing ${FILE}`);
      return undefined;
    }
    return { content: new Uint8Array(readFileSync(file)), commit: "unversioned", ref: "file", from: file };
  }
  // The local branch is the source of truth (it may hold commits not pushed
  // yet); the remote-tracking branch is only a fallback when there is no local
  // one. Nothing is fetched: a build must not touch another checkout.
  const candidates = [ref, `origin/${ref}`];
  for (const candidate of candidates) {
    const rev = git(path, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]);
    if (!rev.ok) continue;
    const commit = rev.out.toString().trim();
    const blob = git(path, ["show", `${commit}:${FILE}`]);
    if (!blob.ok) continue;
    const dirty = git(path, ["status", "--porcelain", "--", FILE]).out.toString().trim();
    if (dirty) console.log(`note: ${join(path, FILE)} has uncommitted changes; vendoring the committed ${candidate} instead`);
    return { content: new Uint8Array(blob.out), commit, ref, from: `${path} (${candidate})` };
  }
  if (explicit) throw new Error(`--from ${path}: ref "${ref}" not found or has no ${FILE}`);
  return undefined;
}

async function fromGitHub(): Promise<Fetched> {
  const api = process.env.CODE_MCP_API_BASE ?? "https://api.github.com";
  const raw = process.env.CODE_MCP_RAW_BASE ?? "https://raw.githubusercontent.com";
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "code-mcp-gateway-cli-sync" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const signal = AbortSignal.timeout(20_000);
  // Resolve the ref to a commit first and download by commit, so the recorded
  // commit and the downloaded bytes cannot disagree if main moves meanwhile.
  const r = await fetch(`${api}/repos/${REPO}/commits/${encodeURIComponent(ref)}`, { headers, signal });
  if (!r.ok) throw new Error(`GitHub API ${r.status} resolving ${REPO}@${ref}`);
  const commit = ((await r.json()) as { sha?: string }).sha;
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) throw new Error("GitHub API returned no commit sha");
  const f = await fetch(`${raw}/${REPO}/${commit}/${FILE}`, { signal });
  if (!f.ok) throw new Error(`download ${FILE}@${commit.slice(0, 7)} failed: HTTP ${f.status}`);
  return { content: new Uint8Array(await f.arrayBuffer()), commit, ref, from: `github.com/${REPO}` };
}

function readMeta(): SourceMeta | undefined {
  try {
    return JSON.parse(readFileSync(META, "utf8")) as SourceMeta;
  } catch {
    return undefined;
  }
}

function verifyVendored(): { ok: boolean; why?: string } {
  const meta = readMeta();
  if (!meta) return { ok: false, why: `missing or invalid ${META}` };
  if (!existsSync(TARGET)) return { ok: false, why: `missing ${TARGET}` };
  const bytes = new Uint8Array(readFileSync(TARGET));
  const digest = sha256(bytes);
  if (digest !== meta.sha256) return { ok: false, why: `sha256 ${digest} does not match the recorded ${meta.sha256}` };
  return { ok: true };
}

async function main(): Promise<number> {
  if (check) {
    const v = verifyVendored();
    const meta = readMeta();
    if (!v.ok) {
      console.error(`code-mcp: vendored copy is inconsistent: ${v.why}`);
      return 1;
    }
    console.log(`code-mcp: vendored copy OK (${meta!.repo}@${meta!.commit.slice(0, 12)}, sha256 ${meta!.sha256.slice(0, 12)})`);
    return 0;
  }

  let fetched: Fetched | undefined;
  const errors: string[] = [];
  try {
    if (fromPath) fetched = fromLocal(resolve(fromPath), true);
    else if (!githubOnly) fetched = fromLocal(SIBLING, false);
  } catch (err) {
    // An explicit --from that fails is an error, never a silent fallback.
    console.error(`code-mcp: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (!fetched) {
    try {
      fetched = await fromGitHub();
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (!fetched) {
    const v = verifyVendored();
    const meta = readMeta();
    const why = errors.join("; ") || "no source";
    if (allowOffline && v.ok) {
      console.log(`note: code-mcp source not reachable (${why}); using the vendored copy ${meta!.repo}@${meta!.commit.slice(0, 12)}`);
      return 0;
    }
    console.error(`code-mcp: no source reachable (${why})${v.ok ? "" : `, and the vendored copy is inconsistent: ${v.why}`}`);
    return 1;
  }

  if (!looksLikeCodeMcp(fetched.content)) {
    console.error(`code-mcp: ${fetched.from} does not look like code-mcp.ts (refusing to vendor it)`);
    return 1;
  }

  const meta: SourceMeta = {
    repo: `https://github.com/${REPO}`,
    path: FILE,
    ref: fetched.ref,
    commit: fetched.commit,
    sha256: sha256(fetched.content),
    bytes: fetched.content.length,
  };
  const before = readMeta();
  const current = existsSync(TARGET) ? sha256(new Uint8Array(readFileSync(TARGET))) : "";
  const unchanged = current === meta.sha256 && before?.commit === meta.commit && before?.sha256 === meta.sha256;
  if (unchanged) {
    console.log(`code-mcp: up to date (${meta.commit.slice(0, 12)} from ${fetched.from})`);
    return 0;
  }
  // Content first, then the record: a crash in between leaves a mismatch the
  // unit test and --check report, rather than a record vouching for old bytes.
  writeFileSync(TARGET, fetched.content);
  writeFileSync(META, `${JSON.stringify(meta, null, 2)}\n`);
  const was = before ? `${before.commit.slice(0, 12)} -> ` : "";
  console.log(`code-mcp: synced ${was}${meta.commit.slice(0, 12)} from ${fetched.from} (${(meta.bytes / 1024).toFixed(1)} KB)`);
  return 0;
}

if (import.meta.main) process.exit(await main());
