// What the secret gate costs the snapshot: files that look like secrets are taken out of the tree that was taken, not out of the work
// tree staged a second time.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOrCreateKeyPair, publish, type MemberPaths } from "../src/fleet-agent";
import { forgetScanned } from "../src/fleet-secrets";
import { snapshot } from "../src/fleet-sync";
import { forgetIncarnationAnswers } from "../src/fleet-trust";

import { FakeGateway, credsFor, useFakeGateway } from "./fleet-fake-gateway";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

const roots: string[] = [];
afterEach(() => {
  (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
  delete process.env.PRIME_FLEET_SECRET_GATE;
});

function world() {
  forgetIncarnationAnswers();
  forgetScanned();
  const root = mkdtempSync(join(tmpdir(), "fleet-secrets-hook-"));
  roots.push(root);
  const work = join(root, "work");
  mkdirSync(join(work, "src"), { recursive: true });
  writeFileSync(join(work, "a.txt"), "one\n");
  writeFileSync(join(work, "src", "b.txt"), "b\n");
  writeFileSync(join(work, ".env"), "DB_PASSWORD=hunter2\n");
  return { root, work, gitDir: join(root, "meta"), keyFile: join(root, "k.key") };
}

const git = (gitDir: string, work: string, args: string[]): string => {
  const out = Bun.spawnSync(["git", "--git-dir=" + gitDir, "--work-tree=" + work, ...args], { stdout: "pipe", stderr: "pipe", timeout: 30_000, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  if (out.exitCode !== 0) throw new Error(out.stderr.toString());
  return out.stdout.toString().trim();
};
const listing = (gitDir: string, work: string, tree: string): string[] => git(gitDir, work, ["ls-tree", "-r", "--name-only", tree]).split("\n").filter(Boolean);
const blobOf = (gitDir: string, work: string, tree: string, path: string): string => git(gitDir, work, ["show", tree + ":" + path]);

describe("a tree less the files that look like secrets", () => {
  test("is the tree that was taken without them: the work tree is not read again (a file changed since is not in it)", async () => {
    const w = world();
    const taken = await snapshot({ work: w.work, gitDir: w.gitDir, base: null, treeOnly: true });
    expect(listing(w.gitDir, w.work, taken.tree)).toEqual([".env", "a.txt", "src/b.txt"]);
    // The work tree moves on; the tree that was taken is what is published.
    writeFileSync(join(w.work, "a.txt"), "two\n");
    const without = await snapshot({ work: w.work, gitDir: w.gitDir, base: null, treeOnly: true, tree: taken.tree, drop: [".env"] });
    expect(listing(w.gitDir, w.work, without.tree)).toEqual(["a.txt", "src/b.txt"]);
    expect(blobOf(w.gitDir, w.work, without.tree, "a.txt")).toBe("one");
  });

  test("is made from the tree it is given, whatever the index of the snapshots holds", async () => {
    const w = world();
    const taken = await snapshot({ work: w.work, gitDir: w.gitDir, base: null, treeOnly: true });
    // The index now holds another tree (the work tree was staged as it became).
    rmSync(join(w.work, "src", "b.txt"));
    writeFileSync(join(w.work, "c.txt"), "c\n");
    await snapshot({ work: w.work, gitDir: w.gitDir, base: null, treeOnly: true });
    const without = await snapshot({ work: w.work, gitDir: w.gitDir, base: null, treeOnly: true, tree: taken.tree, drop: [".env", "src/nothing"] });
    expect(listing(w.gitDir, w.work, without.tree)).toEqual(["a.txt", "src/b.txt"]);
  });

  test("leaves the index of the snapshots as it was: the file is in the next tree, however it is staged, and the whole tree has it too", async () => {
    const w = world();
    const taken = await snapshot({ work: w.work, gitDir: w.gitDir, base: null, treeOnly: true });
    await snapshot({ work: w.work, gitDir: w.gitDir, base: null, treeOnly: true, tree: taken.tree, drop: [".env"] });
    writeFileSync(join(w.work, "a.txt"), "two\n");
    const next = await snapshot({ work: w.work, gitDir: w.gitDir, base: null, treeOnly: true, paths: ["a.txt"] });
    expect(listing(w.gitDir, w.work, next.tree)).toEqual([".env", "a.txt", "src/b.txt"]);
    expect(blobOf(w.gitDir, w.work, next.tree, "a.txt")).toBe("two");
  });

  test("takes the names as they are, many of them, and with a name that looks like a pathspec", async () => {
    const w = world();
    const names: string[] = [];
    mkdirSync(join(w.work, "fixtures"), { recursive: true });
    for (let i = 0; i < 400; i++) {
      names.push("fixtures/" + "k".repeat(60) + i + ".txt");
      writeFileSync(join(w.work, names[i]!), "x\n");
    }
    // A name with a colon is not a file name on Windows; `*` is only asked for, and is no file anywhere.
    const odd = process.platform === "win32" ? [] : [":(top)odd"];
    for (const name of odd) writeFileSync(join(w.work, name), "o\n");
    const taken = await snapshot({ work: w.work, gitDir: w.gitDir, base: null, treeOnly: true });
    const without = await snapshot({ work: w.work, gitDir: w.gitDir, base: null, treeOnly: true, tree: taken.tree, drop: [...names, ...odd, "*"] });
    expect(listing(w.gitDir, w.work, without.tree)).toEqual([".env", "a.txt", "src/b.txt"]);
  });
});

describe("a publish that leaves a file out", () => {
  test("publishes the tree the caller took, less the file: it does not stage the work tree again", async () => {
    const w = world();
    const gateway = new FakeGateway();
    useFakeGateway(gateway);
    const paths: MemberPaths = { work: w.work, gitDir: w.gitDir, keyFile: w.keyFile };
    gateway.seed("primary-device", loadOrCreateKeyPair(w.keyFile).publicKey);
    const taken = await snapshot({ work: w.work, gitDir: w.gitDir, base: null, treeOnly: true });
    // The work tree changes after the tree was taken, and the caller (which watches it) has not been told: this is the tree to publish.
    writeFileSync(join(w.work, "a.txt"), "two\n");
    const out = await publish(credsFor("primary-device"), "x", paths, null, 0, 1, undefined, { known: { tree: taken.tree, base: null, quiet: () => true, unchanged: async () => true } });
    expect(out.kept).toEqual([".env"]);
    expect(listing(w.gitDir, w.work, git(w.gitDir, w.work, ["rev-parse", out.commit + "^{tree}"]))).toEqual(["a.txt", "src/b.txt"]);
    expect(blobOf(w.gitDir, w.work, out.commit, "a.txt")).toBe("one");
  });
});

describe("the list of what was left out", () => {
  // A key is added to a file that was published clean; the next snapshot is of another file only, and staged by its name.
  const AWS = "AK" + "IA" + "ABCDEFGHIJKLMNOP";
  test("is in every snapshot while the file is left out, so a member that jumps over one is told and keeps the file", async () => {
    const w = world();
    rmSync(join(w.work, ".env"));
    writeFileSync(join(w.work, "config.txt"), "region=eu\n");
    const gateway = new FakeGateway();
    useFakeGateway(gateway);
    const paths: MemberPaths = { work: w.work, gitDir: w.gitDir, keyFile: w.keyFile };
    gateway.seed("primary-device", loadOrCreateKeyPair(w.keyFile).publicKey);
    const pub = async (base: string | null, seq: number, named?: string[]) => {
      const taken = await snapshot({ work: w.work, gitDir: w.gitDir, base, treeOnly: true, ...(named ? { paths: named } : {}) });
      return publish(credsFor("primary-device"), "x", paths, base, seq, 1, undefined, { known: { tree: taken.tree, base, quiet: () => true, unchanged: async () => true } });
    };
    const before = await pub(null, 0);
    expect(before.kept).toBeUndefined();
    writeFileSync(join(w.work, "config.txt"), "region=eu\nkey=" + AWS + "\n");
    const added = await pub(before.commit, before.seq, ["config.txt"]);
    expect(added.kept).toEqual(["config.txt"]);
    writeFileSync(join(w.work, "a.txt"), "changed\n");
    const after = await pub(added.commit, added.seq, ["a.txt"]);
    // Nothing of config.txt was staged again, and it is still listed.
    expect(after.kept).toEqual(["config.txt"]);
    // A member that applies `after` from `before` is told by that snapshot's list (the old blob was clean, so its own check could not know).
  });
});
