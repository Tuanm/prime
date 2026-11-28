// The keys a release of prime is signed with, and the check of a signed release.
//
// A release carries `RELEASE`, a short text file that binds the release's version to the hash of its
// `SHA256SUMS` (and names the space image by digest), and `RELEASE.sig`, the raw 64-byte Ed25519
// signature over the exact bytes of `RELEASE`:
//
//   prime-release-v1
//   version 26.12.10
//   sha256sums <sha256 of SHA256SUMS, hex>
//   space-image ghcr.io/tuanm/prime-space@sha256:<hex>
//
// `prime update` checks the signature, then that the version is the release's own (an older signed
// release cannot pass for the newest), then that SHA256SUMS is the one that was signed, and only then
// the hash of the asset it downloaded. The private keys are kept off the release pipeline.

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

// The SPKI wrapper around a raw Ed25519 public key: the DER prefix, then the 32 bytes.
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const publicKeyFromRaw = (raw: Buffer) => createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });

/**
 * The public halves, raw 32-byte Ed25519 keys in base64. The first signs releases today; the second is
 * the next key, trusted in advance so the signing key can be rotated without stranding old installs.
 */
export const RELEASE_KEYS: readonly string[] = [
  "Ww6UD+ajPCK5MUT4iaNsPIbGIeVYDqab/EjyrmHw1Hk=",
  "34Usis0Ul+ZziayGpmbB4DVsjsRxJ3MyFVQ2EY+hgUU=",
];

/**
 * The first version that ships signed releases. A release at or above it that carries no signature is never
 * installed, whatever the running version is and even with --force: a release made by someone who can write to the
 * release page could otherwise have its signature taken off and be installed as one "from before signing".
 * Every release up to 26.11.50 was made before signing existed, so this is the lowest version a release with this
 * code can have; a release made later under a higher version is covered too, and the versions in between never existed.
 */
export const SIGNED_SINCE = "26.11.51";

/**
 * The releases that were published before signing: 26.11.7 to 26.11.50, one each (the list of the releases of the
 * repository when signing was added). Only these can be installed without a signature, and only as a rollback: a
 * version below SIGNED_SINCE that was never published (26.11.50+1, 26.11.9-rc.1, 26.10.1) is not one, and
 * whoever can write to the release page could otherwise make one up.
 */
export const FIRST_UNSIGNED = 7;
export const LAST_UNSIGNED = 50;
export function isPreSigningRelease(version: string): boolean {
  const m = /^26\.11\.(0|[1-9]\d*)$/.exec(version);
  return m !== null && Number(m[1]) >= FIRST_UNSIGNED && Number(m[1]) <= LAST_UNSIGNED;
}

/** Extra trusted keys for a test build: MCP_CLI_RELEASE_KEY, comma separated base64. Honoured in development builds only. */
export const EXTRA_KEY_ENV = "MCP_CLI_RELEASE_KEY";

/** A development build: run from source, or built with a -dev version. A release build has its version built in (the environment cannot change it). */
export function isDevBuild(version: string | undefined = process.env.MCP_CLI_VERSION): boolean {
  return version === undefined || /-dev([.+]|$)/.test(version);
}

export function trustedReleaseKeys(env: Record<string, string | undefined> = process.env, allowExtra: boolean = isDevBuild()): Buffer[] {
  const extra = (allowExtra ? (env[EXTRA_KEY_ENV] ?? "") : "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const keys: Buffer[] = [];
  for (const text of [...RELEASE_KEYS, ...extra]) {
    const raw = Buffer.from(text, "base64");
    if (raw.length === 32) keys.push(raw);
  }
  return keys;
}

/** Is `signature` a valid signature of `release` by any of the keys? */
export function verifyReleaseSignature(release: Uint8Array, signature: Uint8Array, keys: readonly Buffer[] = trustedReleaseKeys()): boolean {
  if (signature.length !== 64) return false;
  return keys.some((key) => {
    try {
      return cryptoVerify(null, release, publicKeyFromRaw(key), signature);
    } catch {
      return false;
    }
  });
}

export interface ReleaseInfo {
  version: string;
  /** Hex sha256 of the release's SHA256SUMS file. */
  sha256sums: string;
  /** The space image the release uses, by digest. */
  spaceImage?: string;
}

const HEADER = "prime-release-v1";

/** Parse the signed RELEASE text. undefined when it is not one (a wrong header, a repeated or malformed field). */
export function parseReleaseFile(text: string): ReleaseInfo | undefined {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  if (lines[0] !== HEADER) return undefined;
  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    if (line === "") continue;
    const space = line.indexOf(" ");
    if (space <= 0) return undefined;
    const name = line.slice(0, space);
    if (fields.has(name)) return undefined;
    fields.set(name, line.slice(space + 1));
  }
  const version = fields.get("version");
  const sums = fields.get("sha256sums");
  const image = fields.get("space-image");
  if (!version || !sums || !/^[0-9a-f]{64}$/.test(sums)) return undefined;
  if (image !== undefined && !/^[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}$/.test(image)) return undefined;
  return { version, sha256sums: sums, ...(image ? { spaceImage: image } : {}) };
}

export function sha256OfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
