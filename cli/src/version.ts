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

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: (string | number)[];
  build: string[];
}

function parseVersion(version: string): ParsedVersion | undefined {
  const match = SEMVER_RE.exec(version);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: (match[4] ?? "")
      .split(".")
      .filter((part) => part.length > 0)
      .map((part) => (/^\d+$/.test(part) ? Number(part) : part)),
    build: (match[5] ?? "").split(".").filter((part) => part.length > 0),
  };
}

/**
 * SemVer precedence, with one deliberate extension.
 *
 * SemVer says build metadata is ignored for ordering, so 26.10.3+1 and 26.10.3
 * would compare equal - which would make a same-day rerelease invisible to
 * `mcp update`. That is exactly how this project does a second release in one
 * day, so build metadata is used as a *tiebreak* after the SemVer rules apply.
 * Anything still equal is reported as equal.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return a === b ? 0 : a < b ? -1 : 1;

  for (const key of ["major", "minor", "patch"] as const) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }

  // A release outranks its own prereleases: 26.10.3 > 26.10.3-rc.1.
  if (pa.prerelease.length === 0 && pb.prerelease.length > 0) return 1;
  if (pa.prerelease.length > 0 && pb.prerelease.length === 0) return -1;
  for (let i = 0; i < Math.max(pa.prerelease.length, pb.prerelease.length); i++) {
    const left = pa.prerelease[i];
    const right = pb.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    if (typeof left === "number" && typeof right === "number") return left < right ? -1 : 1;
    if (typeof left === "number") return -1; // numeric identifiers rank lower
    if (typeof right === "number") return 1;
    return left < right ? -1 : 1;
  }

  return compareBuild(pa.build, pb.build);
}

function compareBuild(a: string[], b: string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNum = /^\d+$/.test(left) ? Number(left) : undefined;
    const rightNum = /^\d+$/.test(right) ? Number(right) : undefined;
    if (leftNum !== undefined && rightNum !== undefined) return leftNum < rightNum ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
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
