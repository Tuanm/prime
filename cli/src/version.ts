// Version validation.
//
// The CLI uses CalVer-style dates: 26.10.3 means 2026-10-03. A date reads well
// for a self-contained binary that cannot auto-update - `mcp --version` tells a
// user immediately how stale their download is.
//
// But the same string also lands in package.json and a GitHub Release tag, both
// of which get parsed as SemVer. The rule that actually bites is leading zeros:
// strict SemVer rejects "26.10.03" outright (npm and bun will still pack it, so
// the problem surfaces late). Dates therefore drop the padding - 26.10.3 - and a
// second release on the same day uses build metadata: 26.10.3+1.
//
// This is the single source of truth: scripts/build.ts and the release workflow
// both enforce it, so a bad tag fails the build instead of shipping a version no
// SemVer tool can order. The pattern is the official one from semver.org, kept
// whole so that prereleases (26.10.4-rc1) stay expressible.

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function isValidVersion(version: string): boolean {
  return SEMVER_RE.test(version);
}

/** A human explanation for a rejected version, or undefined when it is fine. */
export function versionProblem(version: string): string | undefined {
  if (isValidVersion(version)) return undefined;

  // The common and most confusing case: a zero-padded date. Valid-looking,
  // accepted by npm pack, rejected by every strict SemVer parser.
  const unpadded = version.replace(/(?<=\.)0+(?=\d)/g, "");
  if (unpadded !== version && isValidVersion(unpadded)) {
    return `"${version}" is not valid SemVer: numeric parts must not have leading zeros. Use ${unpadded}.`;
  }
  if (/^\d+\.\d+\.\d+/.test(version)) {
    return `"${version}" is not valid SemVer. Use a date like 26.10.3 (year.month.day), optionally with build metadata (26.10.3+1) or a prerelease (26.10.3-rc1).`;
  }
  return `"${version}" is not a version. Use a date like 26.10.3 (year.month.day).`;
}
