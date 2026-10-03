// Self-update: `mcp update` (alias `mcp upgrade`).
//
// The CLI ships as a self-contained binary with no package manager behind it, so
// this is the only way to move forward without re-downloading by hand.
//
// The flow is: list the repo's releases, keep the ones tagged `cli-v*`, pick the
// highest by SemVer, and if it beats the running version, download that release's
// asset for this platform together with its SHA256SUMS, verify the digest, and
// swap the file in atomically.
//
// On the checksum: it is fetched from the same origin as the asset, so it proves
// the download is intact and is the artifact the release published - it is not a
// defence against a compromised release. That is the honest guarantee.

import { accessSync, chmodSync, constants, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CliError, UsageError } from "./errors.ts";
import { bold, dim, green, yellow } from "./output.ts";
import { compareVersions, isValidVersion } from "./version.ts";

export const TAG_PREFIX = "cli-v";
export const DEFAULT_REPO = "Tuanm/code-mcp-gateway";
export const DEFAULT_API_BASE = "https://api.github.com";

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface Release {
  tag: string;
  version: string;
  prerelease: boolean;
  htmlUrl: string;
  assets: ReleaseAsset[];
}

export interface InstallTarget {
  path: string;
  kind: "binary" | "bundle" | "source";
}

export interface UpdateOptions {
  check?: boolean;
  force?: boolean;
  version?: string;
  to?: string;
  json?: boolean;
  quiet?: boolean;
}

export interface UpdateOutcome {
  current: string;
  latest: string;
  update_available: boolean;
  target: string;
  kind: InstallTarget["kind"];
  updated: boolean;
  installed_version?: string;
  asset?: string;
  release_url?: string;
}

// ---- pure helpers (unit tested) -------------------------------------------

/** "cli-v26.10.3" -> "26.10.3"; undefined when the tag is not a CLI release. */
export function versionFromTag(tag: string, prefix = TAG_PREFIX): string | undefined {
  if (!tag.startsWith(prefix)) return undefined;
  const version = tag.slice(prefix.length);
  return isValidVersion(version) ? version : undefined;
}

export function osName(platform: string): string | undefined {
  if (platform === "darwin") return "darwin";
  if (platform === "linux") return "linux";
  if (platform === "win32") return "windows";
  return undefined;
}

export function archName(arch: string): string | undefined {
  if (arch === "arm64") return "arm64";
  if (arch === "x64") return "x64";
  return undefined;
}

/** The release asset this machine would install, e.g. mcp-26.10.3-darwin-arm64. */
export function assetNameFor(version: string, kind: "binary" | "bundle", platform: string, arch: string): string {
  if (kind === "bundle") return `mcp-${version}.js`;
  const os = osName(platform);
  const cpu = archName(arch);
  if (!os || !cpu) {
    throw new CliError(
      `no prebuilt binary for ${platform}/${arch}`,
      "Download the JS bundle from the release page and run it with Bun instead.",
    );
  }
  return `mcp-${version}-${os}-${cpu}${os === "windows" ? ".exe" : ""}`;
}

/** Does this destination path want the JS bundle rather than a native binary? */
export function kindForTarget(target: string, installationKind: InstallTarget["kind"]): "binary" | "bundle" {
  if (/\.m?js$/i.test(target)) return "bundle";
  return installationKind === "bundle" ? "bundle" : "binary";
}

/** Highest version among releases, ignoring prereleases unless nothing else exists. */
export function selectLatest(releases: Release[]): Release | undefined {
  const stable = releases.filter((r) => !r.prerelease);
  const pool = stable.length > 0 ? stable : releases;
  let best: Release | undefined;
  for (const release of pool) {
    if (!best || compareVersions(release.version, best.version) > 0) best = release;
  }
  return best;
}

/** Parse a SHA256SUMS file (the `<hex>  <name>` format sha256sum emits). */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match) out.set(match[2]!, match[1]!);
  }
  return out;
}

export function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

// ---- environment ----------------------------------------------------------

export function apiBase(): string {
  return (process.env.MCP_CLI_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, "");
}

export function repoSlug(): string {
  return process.env.MCP_CLI_REPO ?? DEFAULT_REPO;
}

/**
 * Where this process was installed from.
 *
 * A compiled binary reports its own path in `process.execPath`, but its
 * `argv[1]` is a virtual `/$bunfs/...` entrypoint. Under `bun mcp.js` it is the
 * other way round: execPath is the Bun runtime and argv[1] is the script.
 */
export function currentInstall(): InstallTarget {
  const script = process.argv[1] ?? "";
  const isEmbedded = script.includes("$bunfs") || !existsSync(script);
  if (isEmbedded) return { path: process.execPath, kind: "binary" };
  if (script.endsWith(".js") || script.endsWith(".mjs")) return { path: script, kind: "bundle" };
  return { path: script, kind: "source" };
}

// ---- network --------------------------------------------------------------

function requestHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "code-mcp-gateway-cli",
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

export async function fetchReleases(): Promise<Release[]> {
  const url = `${apiBase()}/repos/${repoSlug()}/releases?per_page=50`;
  let response: Response;
  try {
    response = await fetch(url, { headers: requestHeaders() });
  } catch (err) {
    throw new CliError(
      `cannot reach the release index: ${err instanceof Error ? err.message : String(err)}`,
      "Check your network or proxy. Set MCP_CLI_API_BASE to use a mirror.",
    );
  }
  if (response.status === 403 || response.status === 429) {
    throw new CliError(
      "GitHub rate limit reached while listing releases (403)",
      "Set GITHUB_TOKEN to raise the limit, or retry later.",
    );
  }
  if (!response.ok) {
    throw new CliError(`release index returned HTTP ${response.status}`, `${apiBase()}/repos/${repoSlug()}/releases`);
  }

  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) throw new CliError("unexpected response from the release index");

  const releases: Release[] = [];
  for (const item of body as Record<string, unknown>[]) {
    if (item && typeof item === "object" && item.draft === true) continue;
    const tag = typeof item.tag_name === "string" ? item.tag_name : undefined;
    if (!tag) continue;
    const version = versionFromTag(tag);
    if (!version) continue;
    const assets = Array.isArray(item.assets)
      ? (item.assets as Record<string, unknown>[])
          .filter((a) => a && typeof a.name === "string" && typeof a.browser_download_url === "string")
          .map((a) => ({ name: a.name as string, url: a.browser_download_url as string, size: Number(a.size ?? 0) }))
      : [];
    releases.push({
      tag,
      version,
      prerelease: item.prerelease === true,
      htmlUrl: typeof item.html_url === "string" ? item.html_url : "",
      assets,
    });
  }
  return releases;
}

async function download(url: string, what: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url, { headers: requestHeaders(), redirect: "follow" });
  } catch (err) {
    throw new CliError(`cannot download ${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) throw new CliError(`cannot download ${what}: HTTP ${response.status}`, url);
  return new Uint8Array(await response.arrayBuffer());
}

// ---- install --------------------------------------------------------------

function installBytes(target: string, bytes: Uint8Array, mode: number): void {
  const dir = dirname(target);
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    throw new CliError(
      `${dir} is not writable`,
      `Re-run with the privileges that own it, e.g. sudo mcp update, or install elsewhere with --to <path>.`,
    );
  }

  // Windows refuses to replace a running executable, so stage the new build next
  // to it and say what to do rather than failing with EBUSY.
  if (process.platform === "win32") {
    const staged = `${target}.new`;
    writeFileSync(staged, bytes);
    throw new CliError(
      `downloaded the update to ${staged}, but Windows cannot replace a running executable`,
      `Close all mcp processes, then: move /Y "${staged}" "${target}"`,
    );
  }

  const tmp = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, bytes, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, target); // atomic within the same filesystem
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    throw new CliError(`cannot install into ${target}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- the command ----------------------------------------------------------

export async function runUpdate(current: string, options: UpdateOptions): Promise<UpdateOutcome> {
  const installation = currentInstall();
  const target = options.to ?? installation.path;

  // Refuse to clobber a source checkout: `mcp update` replaces a binary or the
  // published .js bundle, not your working tree. Only when it would actually
  // write - `--check` is read-only and must work anywhere.
  if (!options.check && !options.to && installation.kind === "source") {
    throw new CliError(
      `refusing to update ${target}`,
      "That looks like a source checkout (a .ts entrypoint). Install a release artifact and update that instead.",
    );
  }

  const releases = await fetchReleases();
  if (releases.length === 0) {
    throw new CliError(
      "no CLI releases found",
      `Looked for tags matching ${TAG_PREFIX}* in ${repoSlug()}. Publish one with: git tag ${TAG_PREFIX}<version>.`,
    );
  }

  // An explicit --version installs exactly that release; otherwise take the newest.
  let chosen: Release | undefined;
  if (options.version) {
    if (!isValidVersion(options.version)) {
      throw new UsageError(`invalid --version "${options.version}"`, "Use a date like 26.10.4.");
    }
    chosen = releases.find((r) => r.version === options.version);
    if (!chosen) {
      throw new CliError(
        `release ${options.version} not found`,
        `Available: ${releases.map((r) => r.version).slice(0, 8).join(", ")}`,
      );
    }
  } else {
    chosen = selectLatest(releases);
  }
  if (!chosen) throw new CliError("could not determine the newest release");

  const comparison = compareVersions(chosen.version, current);
  const updateAvailable = comparison > 0;
  const outcome: UpdateOutcome = {
    current,
    latest: chosen.version,
    update_available: updateAvailable,
    target,
    kind: installation.kind,
    updated: false,
    release_url: chosen.htmlUrl,
  };

  if (options.check) return outcome;
  if (!updateAvailable && !options.force) return outcome;

  // The destination decides: `--to install/mcp.js` asks for the bundle even when
  // this process is a compiled binary.
  const kind = kindForTarget(target, installation.kind);
  const assetName = assetNameFor(chosen.version, kind, process.platform, process.arch);
  const asset = chosen.assets.find((a) => a.name === assetName);
  if (!asset) {
    throw new CliError(
      `release ${chosen.version} has no asset ${assetName}`,
      `Available: ${chosen.assets.map((a) => a.name).join(", ") || "(none)"}`,
    );
  }

  const bytes = await download(asset.url, assetName);

  // Mandatory, not best-effort: a self-updater that silently installs whatever it
  // downloaded when the checksums are missing is worse than one that refuses.
  const checksums = chosen.assets.find((a) => a.name === "SHA256SUMS");
  if (!checksums) {
    throw new CliError(
      `release ${chosen.version} publishes no SHA256SUMS`,
      "Refusing to install a download that cannot be verified.",
    );
  }
  const expected = parseChecksums(new TextDecoder().decode(await download(checksums.url, "SHA256SUMS"))).get(assetName);
  if (!expected) {
    throw new CliError(`SHA256SUMS has no entry for ${assetName}`, "Refusing to install an unverifiable download.");
  }
  const actual = sha256Hex(bytes);
  if (expected !== actual) {
    throw new CliError(
      `checksum mismatch for ${assetName}`,
      `expected ${expected}, got ${actual}. The download is corrupt; nothing was installed.`,
    );
  }

  installBytes(target, bytes, 0o755);
  outcome.updated = true;
  outcome.installed_version = chosen.version;
  outcome.asset = assetName;
  return outcome;
}

/** Human-readable report for the update command. */
export function renderUpdate(outcome: UpdateOutcome): string {
  const lines: string[] = [];
  lines.push(`  current   ${bold(outcome.current)}`);
  lines.push(`  latest    ${bold(outcome.latest)}`);

  if (outcome.updated) {
    lines.push(`  installed ${green(outcome.installed_version ?? outcome.latest)} -> ${outcome.target}`);
    if (outcome.kind === "bundle") lines.push(dim("  (run it with: bun " + outcome.target + ")"));
  } else if (outcome.update_available) {
    lines.push(`  ${yellow("update available")} ${dim("run 'mcp update' without --check to install it")}`);
  } else {
    lines.push(`  ${green("already up to date")}`);
  }
  if (outcome.release_url) lines.push(dim(`  ${outcome.release_url}`));
  return lines.join("\n");
}
