// Signed releases: what `prime update` checks before it installs, the keys built into the CLI, the
// space image by digest, and the guards on the release workflow. Offline: the release index is a fetch stub.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, createPublicKey, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { RELEASE_KEYS, parseReleaseFile, trustedReleaseKeys, verifyReleaseSignature } from "../src/release-key.ts";
import { assetNameFor, runUpdate } from "../src/update.ts";
import { defaultImage, imageLabel } from "../src/spaces.ts";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO = join(ROOT, "..");

// A sample RELEASE, signed once by each of the real release keys (the current one and the next one). The
// signatures are public: they prove the keys built into the CLI are the keys that sign, and sign nothing
// that could be installed (a test version, the hash of nothing).
const SAMPLE = "prime-release-v1\nversion 0.0.0-test\nsha256sums 0000000000000000000000000000000000000000000000000000000000000000\n";
const SAMPLE_SIGNED_BY_CURRENT =
  "1JTGeYdS2DmcjIzdg/FHmHYBCIcTS5XdVH6xCdWlZxwe8xMvoB4NiJOni3Xd4oxBmBKBJBz+GJOc1XnPO3scAg==";
const SAMPLE_SIGNED_BY_NEXT =
  "crGOtYD4tChduCnDWU5Qgoc4Y9BGaNsrfINrRzDiYLv+avqH2B02lWFD6CIuLxkBp/R54VJfDQRMsUJhJY2LBA==";

describe("the release keys built into the CLI", () => {
  const embedded = RELEASE_KEYS.map((k) => Buffer.from(k, "base64"));
  const sample = new TextEncoder().encode(SAMPLE);

  test("the current key and the next key each verify what they signed", () => {
    expect(embedded).toHaveLength(2);
    expect(embedded.every((k) => k.length === 32)).toBe(true);
    expect(verifyReleaseSignature(sample, Buffer.from(SAMPLE_SIGNED_BY_CURRENT, "base64"), embedded)).toBe(true);
    expect(verifyReleaseSignature(sample, Buffer.from(SAMPLE_SIGNED_BY_NEXT, "base64"), embedded)).toBe(true);
    // Each is checked against its own key: a signature by one is not a signature by the other.
    expect(verifyReleaseSignature(sample, Buffer.from(SAMPLE_SIGNED_BY_CURRENT, "base64"), [embedded[1]!])).toBe(false);
    expect(verifyReleaseSignature(sample, Buffer.from(SAMPLE_SIGNED_BY_NEXT, "base64"), [embedded[0]!])).toBe(false);
  });

  test("a changed byte, a short signature or another file does not verify", () => {
    const sig = Buffer.from(SAMPLE_SIGNED_BY_CURRENT, "base64");
    expect(verifyReleaseSignature(new TextEncoder().encode(SAMPLE.replace("0.0.0", "0.0.1")), sig, embedded)).toBe(false);
    const flipped = Buffer.from(sig);
    flipped[3] = flipped[3]! ^ 1;
    expect(verifyReleaseSignature(sample, flipped, embedded)).toBe(false);
    expect(verifyReleaseSignature(sample, sig.subarray(0, 63), embedded)).toBe(false);
    expect(verifyReleaseSignature(sample, new Uint8Array(0), embedded)).toBe(false);
  });

  test("MCP_CLI_RELEASE_KEY adds keys to the built-in ones, and ignores what is not a key", () => {
    const extra = Buffer.alloc(32, 7).toString("base64");
    const keys = trustedReleaseKeys({ MCP_CLI_RELEASE_KEY: ` ${extra} , not-a-key ,` });
    expect(keys).toHaveLength(3);
    expect(trustedReleaseKeys({})).toHaveLength(2);
  });
});

describe("the RELEASE file", () => {
  const sums = "a".repeat(64);
  const image = "ghcr.io/tuanm/prime-space@sha256:" + "b".repeat(64);

  test("reads the version, the checksums hash and the image", () => {
    expect(parseReleaseFile(`prime-release-v1\nversion 26.12.10\nsha256sums ${sums}\nspace-image ${image}\n`)).toEqual({
      version: "26.12.10",
      sha256sums: sums,
      spaceImage: image,
    });
    expect(parseReleaseFile(`prime-release-v1\r\nversion 1.2.3\r\nsha256sums ${sums}\r\n`)).toEqual({ version: "1.2.3", sha256sums: sums });
  });

  test.each([
    ["no header", `version 1.2.3\nsha256sums ${sums}\n`],
    ["another header", `prime-release-v2\nversion 1.2.3\nsha256sums ${sums}\n`],
    ["no version", `prime-release-v1\nsha256sums ${sums}\n`],
    ["no checksums hash", `prime-release-v1\nversion 1.2.3\n`],
    ["a short checksums hash", `prime-release-v1\nversion 1.2.3\nsha256sums ${"a".repeat(63)}\n`],
    ["a repeated version", `prime-release-v1\nversion 1.2.3\nversion 9.9.9\nsha256sums ${sums}\n`],
    ["an image by tag", `prime-release-v1\nversion 1.2.3\nsha256sums ${sums}\nspace-image ghcr.io/tuanm/prime-space:latest\n`],
    ["a field with no value", `prime-release-v1\nversion\nsha256sums ${sums}\n`],
  ])("is refused: %s", (_name, text) => {
    expect(parseReleaseFile(text)).toBeUndefined();
  });
});

// ---- prime update -----------------------------------------------------------------------------

describe("prime update checks the signature", () => {
  const realFetch = globalThis.fetch;
  const saved = { api: process.env.MCP_CLI_API_BASE, key: process.env.MCP_CLI_RELEASE_KEY };
  const platform = process.platform;
  const arch = process.arch;
  const BASE = "https://releases.test";
  let signing: KeyObject;
  let dir: string;
  const warnings: string[] = [];
  const note = (t: string) => warnings.push(t);

  const rawPub = (k: KeyObject) => Buffer.from(createPublicKey(k).export({ format: "der", type: "spki" }).subarray(-32)).toString("base64");
  const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

  beforeEach(() => {
    signing = generateKeyPairSync("ed25519").privateKey;
    process.env.MCP_CLI_API_BASE = BASE;
    process.env.MCP_CLI_RELEASE_KEY = rawPub(signing);
    dir = mkdtempSync(join(tmpdir(), "prime-sign-"));
    warnings.length = 0;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const [name, value] of [["MCP_CLI_API_BASE", saved.api], ["MCP_CLI_RELEASE_KEY", saved.key]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  interface Options {
    version?: string;
    /** What the release serves as the binary (SHA256SUMS is made from it unless `sums` is given). */
    binary?: string;
    signed?: "good" | "none" | "release-only" | "sig-only" | "other-key";
    /** The version line inside RELEASE. */
    signedVersion?: string;
    /** The text of SHA256SUMS the release serves; the RELEASE signs the hash of `signedSums` instead when given. */
    sums?: string;
    signedSums?: string;
    signWith?: KeyObject;
  }

  /** Serve a one-release index; returns what was requested. */
  function serve(options: Options = {}): string[] {
    const version = options.version ?? "26.12.10";
    const binary = options.binary ?? "the real binary";
    const asset = assetNameFor(version, "binary", platform, arch);
    const sums = options.sums ?? `${sha(binary)}  ${asset}\n`;
    const release =
      `prime-release-v1\nversion ${options.signedVersion ?? version}\nsha256sums ${sha(options.signedSums ?? sums)}\n`;
    const key = options.signWith ?? signing;
    const sig = cryptoSign(null, Buffer.from(release), key);
    const mode = options.signed ?? "good";
    const assets: { name: string; browser_download_url: string; size: number }[] = [
      { name: asset, browser_download_url: `${BASE}/asset`, size: binary.length },
      { name: "SHA256SUMS", browser_download_url: `${BASE}/sums`, size: sums.length },
    ];
    if (mode === "good" || mode === "release-only" || mode === "other-key") assets.push({ name: "RELEASE", browser_download_url: `${BASE}/release`, size: release.length });
    if (mode === "good" || mode === "sig-only" || mode === "other-key") assets.push({ name: "RELEASE.sig", browser_download_url: `${BASE}/sig`, size: 64 });
    const requested: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      requested.push(path);
      if (path.endsWith("/releases")) {
        return Response.json([{ tag_name: `prime-v${version}`, draft: false, prerelease: false, html_url: "", assets }]);
      }
      if (path === "/asset") return new Response(binary);
      if (path === "/sums") return new Response(sums);
      if (path === "/release") return new Response(release);
      if (path === "/sig") return new Response(sig);
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;
    return requested;
  }

  const update = (current: string, extra: Partial<Parameters<typeof runUpdate>[1]> = {}) => {
    const to = join(dir, "prime");
    return runUpdate(current, { to, note, ...extra }).then((outcome) => ({ outcome, to }));
  };

  test("a release signed by the release key installs, and says it was verified", async () => {
    serve();
    const { outcome, to } = await update("26.12.5");
    expect(outcome.updated).toBe(true);
    expect(outcome.signature).toBe("verified");
    expect(readFileSync(to, "utf8")).toBe("the real binary");
  });

  test("a modified binary with SHA256SUMS recomputed to match is refused (before signing it installed)", async () => {
    // The attacker replaces the binary and rewrites SHA256SUMS to match; the signed RELEASE still names the old SHA256SUMS.
    const genuine = `${sha("the real binary")}  ${assetNameFor("26.12.10", "binary", platform, arch)}\n`;
    serve({ binary: "a backdoored binary", signedSums: genuine });
    await expect(update("26.12.5")).rejects.toThrow(/not signed by the prime release key.*SHA256SUMS is not the one that was signed/s);
    expect(existsSync(join(dir, "prime"))).toBe(false);
  });

  test("a signed release of another version cannot pass for this one", async () => {
    serve({ signedVersion: "26.12.9" });
    await expect(update("26.12.5")).rejects.toThrow(/signed as version 26.12.9/);
    expect(existsSync(join(dir, "prime"))).toBe(false);
  });

  test("a release that is newer and not signed is refused, and so is one with half of the pair", async () => {
    for (const signed of ["none", "release-only", "sig-only"] as const) {
      serve({ signed });
      await expect(update("26.12.5")).rejects.toThrow(/not signed by the prime release key; nothing was installed/);
      expect(existsSync(join(dir, "prime"))).toBe(false);
    }
  });

  test("a signature by a key that is not a release key is refused", async () => {
    serve({ signed: "other-key", signWith: generateKeyPairSync("ed25519").privateKey });
    await expect(update("26.12.5")).rejects.toThrow(/does not match any release key/);
  });

  test("a release signed by the next key is accepted", async () => {
    // The test key stands in for the second key: both are accepted alike.
    const second = generateKeyPairSync("ed25519").privateKey;
    process.env.MCP_CLI_RELEASE_KEY = `${rawPub(signing)},${rawPub(second)}`;
    serve({ signWith: second });
    expect((await update("26.12.5")).outcome.signature).toBe("verified");
  });

  test("a release older than this build with no signature (made before signing) installs with a warning", async () => {
    serve({ version: "26.11.50", signed: "none" });
    const { outcome, to } = await update("26.12.5", { version: "26.11.50", force: true });
    expect(outcome.updated).toBe(true);
    expect(outcome.signature).toBe("unsigned");
    expect(warnings.join("\n")).toMatch(/warning: release 26.11.50 is older than this build and carries no signature/);
    expect(readFileSync(to, "utf8")).toBe("the real binary");
  });

  test("an older release that is signed is checked all the same", async () => {
    serve({ version: "26.12.2", signedVersion: "26.12.1" });
    await expect(update("26.12.5", { version: "26.12.2", force: true })).rejects.toThrow(/signed as version 26.12.1/);
  });

  test("an unsigned release is not installed again over the same version", async () => {
    serve({ version: "26.12.5", signed: "none" });
    await expect(update("26.12.5", { force: true })).rejects.toThrow(/not signed/);
  });

  test("the signature is checked before the binary is downloaded", async () => {
    const requested = serve({ signed: "none" });
    await expect(update("26.12.5")).rejects.toThrow();
    expect(requested).not.toContain("/asset");
  });

  test("a bad checksum of the binary is still refused after the signature passes", async () => {
    const asset = assetNameFor("26.12.10", "binary", platform, arch);
    serve({ binary: "tampered after signing", sums: `${sha("the real binary")}  ${asset}\n` });
    await expect(update("26.12.5")).rejects.toThrow(/checksum mismatch/);
    expect(existsSync(join(dir, "prime"))).toBe(false);
  });

  test("--check does not need a signature", async () => {
    serve({ signed: "none" });
    const { outcome } = await update("26.12.5", { check: true });
    expect(outcome.update_available).toBe(true);
    expect(outcome.updated).toBe(false);
  });
});

// ---- the space image ----------------------------------------------------------------------------

describe("the space image by digest", () => {
  const digest = "sha256:" + "c".repeat(64);

  test("a build with a digest names the image by it; one without names the tag", () => {
    expect(defaultImage("26.12.10", digest)).toBe(`ghcr.io/tuanm/prime-space@${digest}`);
    expect(defaultImage("26.12.10", undefined)).toBe("ghcr.io/tuanm/prime-space:26.12.10");
    expect(defaultImage("26.12.10+1", undefined)).toBe("ghcr.io/tuanm/prime-space:26.12.10+1");
  });

  test("a development build and a malformed digest use the tag", () => {
    expect(defaultImage("26.12.10-dev", digest)).toBe("ghcr.io/tuanm/prime-space:26.12.10");
    expect(defaultImage("26.12.10", "sha256:short")).toBe("ghcr.io/tuanm/prime-space:26.12.10");
    expect(defaultImage("26.12.10", "latest")).toBe("ghcr.io/tuanm/prime-space:26.12.10");
  });

  test("a message calls an image by its tag or the start of its digest", () => {
    expect(imageLabel("ghcr.io/tuanm/prime-space:26.11.44")).toBe("26.11.44");
    expect(imageLabel(`ghcr.io/tuanm/prime-space@${digest}`)).toBe("sha256:cccccccccccc");
  });

  test("the build refuses a digest that is not sha256:<64 hex>", () => {
    const run = Bun.spawnSync(["bun", join(ROOT, "scripts", "build.ts"), "--bundle-only", "--version", "26.12.10", "--space-image-digest", "sha256:abc"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain("--space-image-digest needs sha256:");
  });
});

// ---- the workflows ------------------------------------------------------------------------------

describe("the workflows", () => {
  const lint = (workflows: string) => {
    const proc = Bun.spawnSync(["bun", join(REPO, "scripts", "check-workflows.ts"), workflows], { stdout: "pipe", stderr: "pipe" });
    return { code: proc.exitCode, out: proc.stdout.toString() };
  };

  test("every action of this repository is pinned to a commit", () => {
    const result = lint(join(REPO, ".github", "workflows"));
    expect(result.out).toContain("0 problem(s)");
    expect(result.code).toBe(0);
  });

  test("the check refuses an action pinned by tag or branch, and accepts a commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "prime-wf-"));
    const workflow = (uses: string) => `name: t\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${uses}\n`;
    mkdirSync(join(dir, "ok"));
    writeFileSync(join(dir, "ok", "a.yml"), workflow("actions/checkout@" + "1".repeat(40) + " # v4.1.0"));
    expect(lint(join(dir, "ok")).code).toBe(0);
    for (const bad of ["actions/checkout@v4", "actions/checkout@main", "actions/checkout@" + "1".repeat(39), "actions/checkout"]) {
      const sub = join(dir, bad.replace(/\W/g, "_"));
      mkdirSync(sub);
      writeFileSync(join(sub, "a.yml"), workflow(bad));
      const result = lint(sub);
      expect(result.code).toBe(1);
      expect(result.out).toContain("not pinned to a commit SHA");
    }
  });

  const release = readFileSync(join(REPO, ".github", "workflows", "release-cli.yml"), "utf8");

  test("the space image is pushed before the binaries that name it are built, and the release is a draft", () => {
    expect(release.indexOf("name: Build and push the space image")).toBeGreaterThan(0);
    expect(release.indexOf("name: Build and push the space image")).toBeLessThan(release.indexOf("name: Build every target"));
    expect(release).toContain('--space-image-digest "$SPACE_IMAGE_DIGEST"');
    expect(release).toMatch(/gh release create "\$TAG" --draft /);
    expect(release).toContain("prime-* SHA256SUMS RELEASE");
    expect(release).not.toContain(":latest");
  });
});
