import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCommit, ingestPack, snapshot } from "../src/fleet-sync";
import { COLLECT_GRACE_MS, cacheLimitMb, collectStore, storeBytes } from "../src/fleet-store";

const git = (gitDir: string, args: string[], input?: string): string =>
  execFileSync("git", ["--git-dir=" + gitDir].concat(args), { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

// Make everything in the store look old, as it would after the grace period.
function age(gitDir: string): void {
  const long = new Date(Date.now() - 2 * COLLECT_GRACE_MS);
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      if (name.isDirectory()) walk(full);
      else utimesSync(full, long, long);
    }
  };
  walk(join(gitDir, "objects"));
}

function noiseMaker(): () => string {
  let seed = 5;
  return () => {
    let out = "";
    for (let i = 0; i < 3000; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      out += (seed % 36).toString(36);
    }
    return out;
  };
}

describe("keeping the object store small", () => {
  test("a store that has seen sixty snapshots shrinks to the trees that are still needed, and goes on working", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-store-"));
    try {
      const noise = noiseMaker();
      const work = join(root, "w");
      const gitDir = join(root, "pg");
      const other = join(root, "o");
      const otherGit = join(root, "og");
      mkdirSync(work);
      mkdirSync(other);
      for (let i = 0; i < 20; i++) writeFileSync(join(work, "f" + i + ".txt"), noise());

      let snap = await snapshot({ work, gitDir, seq: 1, wantFull: true });
      await ingestPack(other, otherGit, snap.commit, snap.pack, { tree: snap.tree, seq: 1 });
      await applyCommit(other, otherGit, snap.commit, [], null);
      const first = snap.commit;
      for (let seq = 2; seq <= 60; seq++) {
        for (let k = 0; k < 4; k++) writeFileSync(join(work, "f" + ((seq * 3 + k) % 20) + ".txt"), noise());
        const base = snap.commit;
        snap = await snapshot({ work, gitDir, base, seq, wantFull: false });
        await ingestPack(other, otherGit, snap.commit, snap.delta!, { tree: snap.tree, seq });
        await applyCommit(other, otherGit, snap.commit, [], base);
      }
      age(gitDir);
      age(otherGit);

      for (const [dir, label] of [[gitDir, "primary"], [otherGit, "replica"]] as const) {
        const before = storeBytes(dir);
        const done = await collectStore(dir, [snap.commit]);
        expect(done, label).not.toBeNull();
        // Twenty files of noise, and nothing of the other fifty-nine snapshots.
        expect(done!.after, label).toBeLessThan(before / 5);
        expect(() => git(dir, ["cat-file", "-e", first + "^{commit}"]), label).toThrow();
        expect(git(dir, ["cat-file", "-t", snap.commit]), label).toBe("commit");
        // Only the snapshot that is kept has a ref.
        expect(git(dir, ["for-each-ref", "--format=%(refname)", "refs/prime/snapshots", "refs/prime/fetched"]).split("\n").filter(Boolean).length, label).toBe(1);
      }

      // The primary goes on: its stat cache still names objects that are there.
      writeFileSync(join(work, "f0.txt"), noise());
      writeFileSync(join(work, "new.txt"), "new");
      const next = await snapshot({ work, gitDir, base: snap.commit, seq: 61, wantFull: false });
      // The replica applies the next change on top of the snapshot it kept.
      await ingestPack(other, otherGit, next.commit, next.delta!, { tree: next.tree, seq: 61 });
      await applyCommit(other, otherGit, next.commit, [], snap.commit);
      expect(readFileSync(join(other, "new.txt"), "utf8")).toBe("new");
      expect(readFileSync(join(other, "f0.txt"), "utf8")).toBe(readFileSync(join(work, "f0.txt"), "utf8"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("what is younger than the grace period is not touched, and a work tree edit that was never published survives", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-store-"));
    try {
      const work = join(root, "w");
      const gitDir = join(root, "g");
      mkdirSync(work);
      writeFileSync(join(work, "a.txt"), "alpha");
      const snap = await snapshot({ work, gitDir, seq: 1 });
      // An unpublished edit, staged in the stat cache by a snapshot with no ref.
      writeFileSync(join(work, "a.txt"), "alpha, edited and never published");
      await snapshot({ work, gitDir, base: snap.commit, treeOnly: true });
      const stray = git(gitDir, ["hash-object", "-w", "--stdin"], "just written, nobody refers to it");
      const oldStray = git(gitDir, ["hash-object", "-w", "--stdin"], "written long ago, nobody refers to it");
      const loose = (id: string): string => join(gitDir, "objects", id.slice(0, 2), id.slice(2));
      utimesSync(loose(oldStray), new Date(Date.now() - 2 * COLLECT_GRACE_MS), new Date(Date.now() - 2 * COLLECT_GRACE_MS));

      await collectStore(gitDir, [snap.commit]);
      expect(git(gitDir, ["cat-file", "-t", stray])).toBe("blob");
      expect(() => git(gitDir, ["cat-file", "-e", oldStray])).toThrow();
      // The stat cache can still write a tree: its objects were kept.
      const again = await snapshot({ work, gitDir, base: snap.commit, treeOnly: true });
      expect(again.tree).toMatch(/^[0-9a-f]{40}/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a snapshot that came in a whole-tree pack, whose parent this member never had, is collected like any other", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-store-"));
    try {
      const work = join(root, "w");
      const gitDir = join(root, "g");
      const other = join(root, "o");
      const otherGit = join(root, "og");
      mkdirSync(work);
      mkdirSync(other);
      writeFileSync(join(work, "a.txt"), "one");
      const first = await snapshot({ work, gitDir, seq: 1, wantFull: false });
      writeFileSync(join(work, "a.txt"), "two");
      // The commit has a parent; the whole-tree pack does not carry it.
      const second = await snapshot({ work, gitDir, base: first.commit, seq: 2, wantFull: true });
      await ingestPack(other, otherGit, second.commit, second.pack, { tree: second.tree, seq: 2 });
      await applyCommit(other, otherGit, second.commit, [], null);
      age(otherGit);
      // `git gc` cannot get past that parent; this can.
      const done = await collectStore(otherGit, [second.commit]);
      expect(done).not.toBeNull();
      expect(git(otherGit, ["cat-file", "-p", second.commit + ":a.txt"])).toBe("two");
      writeFileSync(join(work, "a.txt"), "three");
      const third = await snapshot({ work, gitDir, base: second.commit, seq: 3, wantFull: false });
      await ingestPack(other, otherGit, third.commit, third.delta!, { tree: third.tree, seq: 3 });
      await applyCommit(other, otherGit, third.commit, [], second.commit);
      expect(readFileSync(join(other, "a.txt"), "utf8")).toBe("three");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("with nothing to keep it does nothing, and a commit the store lacks is not kept", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-store-"));
    try {
      const work = join(root, "w");
      const gitDir = join(root, "g");
      mkdirSync(work);
      writeFileSync(join(work, "a.txt"), "x");
      await snapshot({ work, gitDir, seq: 1 });
      expect(await collectStore(gitDir, [])).toBeNull();
      expect(await collectStore(gitDir, [null, undefined, "0123456789abcdef0123456789abcdef01234567"])).toBeNull();
      expect(existsSync(join(gitDir, "objects"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the cap is 512 MB unless the environment says otherwise", () => {
    expect(cacheLimitMb({})).toBe(512);
    expect(cacheLimitMb({ PRIME_FLEET_CACHE_MB: "64" })).toBe(64);
    expect(cacheLimitMb({ PRIME_FLEET_CACHE_MB: "-3" })).toBe(512);
    expect(cacheLimitMb({ PRIME_FLEET_CACHE_MB: "lots" })).toBe(512);
  });
});
