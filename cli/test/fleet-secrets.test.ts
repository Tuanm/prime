// What a publish leaves out because it looks like a secret.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOrCreateKeyPair, publish, pull, type MemberPaths } from "../src/fleet-agent";
import { entropy, forgetScanned, globToRegExp, isAllowed, keptFrom, readAllow, secretContentReason, secretGateMode, secretPathReason, writeAllow } from "../src/fleet-secrets";
import { forgetIncarnationAnswers } from "../src/fleet-trust";
import { openPayload } from "../src/fleet-crypto";
import { metaBindingOf } from "../src/fleet-trust";
import { payloadHash, type FleetManifest } from "../src/fleet-transport";

import { FakeGateway, credsFor, useFakeGateway } from "./fleet-fake-gateway";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

// Built here so that this file is not itself a thing that looks like a secret.
const FAKE_GH = "gh" + "p_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const FAKE_AWS = "AK" + "IA" + "ABCDEFGHIJKLMNOP";
const FAKE_PEM = "-----BEGIN " + "RSA PRIVATE KEY-----\nMIIE\n-----END " + "RSA PRIVATE KEY-----\n";

describe("by name", () => {
  test("an environment file, a private key, a key file, netrc and credentials are secrets", () => {
    for (const p of [".env", "app/.env", ".env.local", ".env.production", "id_rsa", "home/.ssh/id_ed25519", "id_ecdsa", "tls/server.pem", "a/b.key", "x.p12", "y.pfx", ".netrc", "credentials.json", ".aws/credentials", "svc/.aws/credentials"]) {
      expect(secretPathReason(p)).not.toBeNull();
    }
  });
  test("an example, a sample, a template and a public key are not", () => {
    for (const p of [".env.example", ".env.sample", ".env.template", "id_rsa.pub", "id_ed25519.pub", "src/key.ts", "README.md", "environment.ts", "keys/readme.txt", "aws/credentials.md"]) {
      expect(secretPathReason(p)).toBeNull();
    }
  });
});

describe("by content", () => {
  test("a private key, an AWS key id, a GitHub token, a Slack token, an API key", () => {
    expect(secretContentReason(FAKE_PEM)).toMatch(/private key/);
    expect(secretContentReason("aws_key = " + FAKE_AWS)).toMatch(/AWS/);
    expect(secretContentReason("token: " + FAKE_GH)).toMatch(/GitHub/);
    expect(secretContentReason("x" + "oxb-1234567890-abcdefghij")).toMatch(/Slack/);
    expect(secretContentReason("key = 'sk-" + "abcdefghijklmnopqrstuvwx'")).toMatch(/API/);
  });
  test("a long random value assigned to a name that says it is a secret, and not a plain word, a hash in a lock file or prose", () => {
    expect(secretContentReason('API_SECRET = "9fA3kLm2Qx8ZpR7vB1nT5yUcW4eHjD6s"')).toMatch(/assigned/);
    expect(secretContentReason('password = "correct horse battery staple ok"')).toBeNull();
    expect(secretContentReason("const token = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'")).toBeNull(); // 40 characters, no entropy
    expect(secretContentReason("The secret of a good build is a clean tree.")).toBeNull();
    expect(secretContentReason("integrity sha512-" + "A".repeat(80))).toBeNull();
  });
  test("entropy counts bits per character", () => {
    expect(entropy("aaaa")).toBe(0);
    expect(entropy("abcd")).toBe(2);
  });
});

describe("the operator's allow list", () => {
  test("globs match whole paths: * within a segment, ** across segments", () => {
    expect(globToRegExp("*.pem").test("a.pem")).toBe(true);
    expect(globToRegExp("*.pem").test("d/a.pem")).toBe(false);
    expect(isAllowed("d/a.pem", ["**/*.pem"])).toBe(true);
    expect(isAllowed("a.pem", ["**/*.pem"])).toBe(true);
    expect(isAllowed("test/fixtures/x/.env", ["test/fixtures/**"])).toBe(true);
    expect(isAllowed("src/.env", ["test/fixtures/**"])).toBe(false);
    expect(isAllowed(".env", [".env"])).toBe(true);
    expect(isAllowed("xenv", [".env"])).toBe(false);
  });
  test("is kept beside the member's key file, sorted and without repeats", () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-allow-"));
    try {
      const keyFile = join(root, "m.key");
      expect(readAllow(keyFile)).toEqual([]);
      writeAllow(keyFile, ["b", "a", "b"]);
      expect(readAllow(keyFile)).toEqual(["a", "b"]);
      writeFileSync(keyFile + ".secrets.json", "not json");
      expect(readAllow(keyFile)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("the gate is on unless it is said to be off or to warn", () => {
    expect(secretGateMode({})).toBe("exclude");
    expect(secretGateMode({ PRIME_FLEET_SECRET_GATE: "off" })).toBe("off");
    expect(secretGateMode({ PRIME_FLEET_SECRET_GATE: "Warn" })).toBe("warn");
    expect(secretGateMode({ PRIME_FLEET_SECRET_GATE: "nonsense" })).toBe("exclude");
  });
  test("a list of left-out paths is only taken as a list of plain paths", () => {
    expect(keptFrom([".env", 3, "", "a/b"])).toEqual([".env", "a/b"]);
    expect(keptFrom("x")).toEqual([]);
  });
});

describe("publishing a tree that holds secrets", () => {
  const roots: string[] = [];
  const saved = process.env.PRIME_FLEET_SECRET_GATE;
  afterEach(() => {
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
    if (saved === undefined) delete process.env.PRIME_FLEET_SECRET_GATE;
    else process.env.PRIME_FLEET_SECRET_GATE = saved;
  });

  function world() {
    forgetIncarnationAnswers();
    forgetScanned();
    const root = mkdtempSync(join(tmpdir(), "fleet-secrets-"));
    roots.push(root);
    const gateway = new FakeGateway();
    useFakeGateway(gateway);
    const work = join(root, "primary");
    mkdirSync(join(work, "src"), { recursive: true });
    mkdirSync(join(root, "replica"), { recursive: true });
    const primary: MemberPaths = { work, gitDir: join(root, "p-meta"), keyFile: join(root, "p.key") };
    const replica: MemberPaths = { work: join(root, "replica"), gitDir: join(root, "r-meta"), keyFile: join(root, "r.key") };
    gateway.seed("primary-device", loadOrCreateKeyPair(primary.keyFile).publicKey);
    gateway.seed("replica-device", loadOrCreateKeyPair(replica.keyFile).publicKey);
    writeFileSync(join(work, "ok.txt"), "fine\n");
    writeFileSync(join(work, ".env"), "DB_PASSWORD=hunter2\n");
    writeFileSync(join(work, ".env.example"), "DB_PASSWORD=\n");
    writeFileSync(join(work, "id_ed25519"), FAKE_PEM);
    writeFileSync(join(work, "src", "config.ts"), "export const token = '" + FAKE_GH + "';\n");
    return { root, gateway, work, primary, replica };
  }
  const publishIt = (w: ReturnType<typeof world>) => publish(credsFor("primary-device"), "x", w.primary, null, 0, 2);
  const replicaHas = (w: ReturnType<typeof world>, rel: string) => existsSync(join(w.replica.work, rel));

  test("the files that look like secrets are not in what a replica gets, and the rest is (fails without the gate: all of them are)", async () => {
    const w = world();
    const out = await publishIt(w);
    expect(out.kept).toEqual([".env", "id_ed25519", "src/config.ts"]);
    await pull(credsFor("replica-device"), "x", w.replica, 0);
    expect(readFileSync(join(w.replica.work, "ok.txt"), "utf8")).toBe("fine\n");
    expect(replicaHas(w, ".env.example")).toBe(true);
    expect(replicaHas(w, ".env")).toBe(false);
    expect(replicaHas(w, "id_ed25519")).toBe(false);
    expect(replicaHas(w, "src/config.ts")).toBe(false);
    // ... and they are still where they were
    expect(readFileSync(join(w.work, ".env"), "utf8")).toContain("hunter2");
  });

  test("the left-out paths are in the sealed metadata and nowhere in the clear", async () => {
    const w = world();
    const out = await publishIt(w);
    const stored = JSON.parse(w.gateway.payloads.get(out.manifestKey)!.toString("utf8")) as FleetManifest;
    const text = JSON.stringify(stored);
    expect(text).not.toContain(".env");
    expect(text).not.toContain("id_ed25519");
    expect(typeof stored.meta).toBe("string");
    // The replica opens the pack, and with it the metadata.
    const pack = w.gateway.payloads.get(stored.packKey)!;
    const me = loadOrCreateKeyPair(w.replica.keyFile);
    const opened = openPayload(pack, stored.wrapped, stored.senderPublicKey, "replica-device", me.privateKey)!;
    const meta = opened.openMeta(metaBindingOf(stored, payloadHash(pack), null), stored.meta as string);
    expect(keptFrom(meta?.kept)).toEqual([".env", "id_ed25519", "src/config.ts"]);
  });

  test("a replica's own .env is not deleted by a snapshot that leaves it out", async () => {
    const w = world();
    writeFileSync(join(w.replica.work, ".env"), "LOCAL=1\n");
    await publishIt(w);
    await pull(credsFor("replica-device"), "x", w.replica, 0);
    expect(readFileSync(join(w.replica.work, ".env"), "utf8")).toBe("LOCAL=1\n");
    expect(replicaHas(w, "ok.txt")).toBe(true);
  });

  test("a file the operator allowed goes through, and the rest stay out", async () => {
    const w = world();
    writeAllow(w.primary.keyFile, [".env", "src/*.ts"]);
    const out = await publishIt(w);
    expect(out.kept).toEqual(["id_ed25519"]);
    await pull(credsFor("replica-device"), "x", w.replica, 0);
    expect(replicaHas(w, ".env")).toBe(true);
    expect(replicaHas(w, "src/config.ts")).toBe(true);
    expect(replicaHas(w, "id_ed25519")).toBe(false);
  });

  test("with the gate off everything is published, as before; warn publishes it and says so", async () => {
    process.env.PRIME_FLEET_SECRET_GATE = "off";
    const w = world();
    const out = await publishIt(w);
    expect(out.kept).toBeUndefined();
    await pull(credsFor("replica-device"), "x", w.replica, 0);
    expect(replicaHas(w, ".env")).toBe(true);
    const warn = world();
    process.env.PRIME_FLEET_SECRET_GATE = "warn";
    const out2 = await publishIt(warn);
    expect(out2.kept).toBeUndefined();
    await pull(credsFor("replica-device"), "x", warn.replica, 0);
    expect(replicaHas(warn, "id_ed25519")).toBe(true);
  });

  test("a tree with nothing in it that looks like a secret is published as it was, with no left-out list", async () => {
    const w = world();
    for (const f of [".env", "id_ed25519"]) rmSync(join(w.work, f));
    rmSync(join(w.work, "src", "config.ts"));
    const out = await publishIt(w);
    expect(out.kept).toBeUndefined();
  });

  test("a secret that arrives later is left out of the next snapshot, and one that is removed is out of the list", async () => {
    const w = world();
    for (const f of [".env", "id_ed25519"]) rmSync(join(w.work, f));
    rmSync(join(w.work, "src", "config.ts"));
    const first = await publishIt(w);
    writeFileSync(join(w.work, "later.txt"), "AWS_KEY=" + FAKE_AWS + "\n");
    const second = await publish(credsFor("primary-device"), "x", w.primary, first.commit, first.seq, 2);
    expect(second.kept).toEqual(["later.txt"]);
    rmSync(join(w.work, "later.txt"));
    const third = await publish(credsFor("primary-device"), "x", w.primary, second.commit, second.seq, 2);
    expect(third.kept).toBeUndefined();
  });
});

describe("prime fleets secrets", () => {
  test("allow, list and disallow keep the list beside the member's key, and refuse a path outside the work tree", async () => {
    const { fleetsSecrets } = await import("../src/fleets");
    const root = mkdtempSync(join(tmpdir(), "fleet-secrets-cmd-"));
    try {
      const out: string[] = [];
      const ctx = (positionals: string[]) =>
        ({
          config: { defaults: {}, devices: {}, spaces: { work: { fleet: "acme" } }, codeMcp: {} },
          configPath: join(root, "config.yaml"),
          json: false,
          out: (l: string) => out.push(l),
          parsed: { positionals: ["fleets", "secrets", ...positionals], flags: new Map([["space", "work"]]), help: false },
        }) as never;
      await fleetsSecrets(ctx(["allow", "acme", ".env", "test/**"]));
      expect(out.join("\n")).toContain("test/**");
      out.length = 0;
      await fleetsSecrets(ctx(["disallow", "acme", ".env"]));
      out.length = 0;
      await fleetsSecrets(ctx(["list", "acme"]));
      expect(out.join("\n")).toContain("test/**");
      expect(out.join("\n")).not.toContain("  .env");
      await expect(fleetsSecrets(ctx(["allow", "acme", "../x"]))).rejects.toThrow(/inside the work tree/);
      await expect(fleetsSecrets(ctx(["allow", "acme"]))).rejects.toThrow(/name the path/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the left-out list in the metadata", () => {
  test("is the paths that fit: no more than the count, and no more than the text a reader will take", async () => {
    const { keptForMeta, KEPT_MAX } = await import("../src/fleet-secrets");
    expect(keptForMeta([".env", "a/b"])).toEqual([".env", "a/b"]);
    expect(keptForMeta(Array.from({ length: KEPT_MAX + 50 }, (_, i) => "f" + i)).length).toBe(KEPT_MAX);
    const long = Array.from({ length: 400 }, (_, i) => "d" + i + "/" + "p".repeat(300));
    const fits = keptForMeta(long);
    expect(fits.length).toBeLessThan(120);
    expect(Buffer.byteLength(JSON.stringify(fits))).toBeLessThan(40 * 1024);
  });
});
