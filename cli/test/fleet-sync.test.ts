import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, rmSync, existsSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import {
  EMPTY_TREE,
  applyCommit,
  applyPack,
  ingestPack,
  findNestedRepos,
  hasFiles,
  localChanges,
  NestedRepoCache,
  payloadId,
  preserveLocalChange,
  removedBetween,
  seal,
  snapshot,
  unseal,
} from "../src/fleet-sync";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "fleet-sync-"));
}

function gitIn(dir: string, args: string[]): void {
  execFileSync("git", ["-C", dir].concat(args), { stdio: ["pipe", "pipe", "pipe"] });
}

describe("nested repositories", () => {
  test("are found at any depth and treated as boundaries", () => {
    const root = scratch();
    try {
      mkdirSync(join(root, "a", "b"), { recursive: true });
      mkdirSync(join(root, "plain"), { recursive: true });
      writeFileSync(join(root, "plain", "file.txt"), "x");
      gitIn(join(root, "a", "b"), ["init", "-q", "."]);
      const nested = findNestedRepos(root);
      expect(nested).toContain("a/b");
      expect(nested).not.toContain("plain");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a repository inside a repository is not reported twice", () => {
    const root = scratch();
    try {
      mkdirSync(join(root, "outer"), { recursive: true });
      gitIn(join(root, "outer"), ["init", "-q", "."]);
      mkdirSync(join(root, "outer", "inner"), { recursive: true });
      gitIn(join(root, "outer", "inner"), ["init", "-q", "."]);
      const nested = findNestedRepos(root);
      expect(nested).toEqual(["outer"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("snapshots", () => {
  test("capture the work tree and leave no trace in it", async () => {
    const root = scratch();
    try {
      const work = join(root, "work");
      const gitDir = join(root, "meta");
      mkdirSync(work, { recursive: true });
      writeFileSync(join(work, "a.txt"), "alpha");
      mkdirSync(join(work, "sub"), { recursive: true });
      writeFileSync(join(work, "sub", "b.txt"), "beta");
      const before = readdirSync(work).sort();

      const snap = await snapshot({ work, gitDir });
      expect(snap.tree).not.toBe(EMPTY_TREE);
      expect(snap.pack.length).toBeGreaterThan(0);
      expect(readdirSync(work).sort()).toEqual(before);
      expect(existsSync(join(work, ".git"))).toBe(false);
      expect(existsSync(join(work, ".gitignore"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an empty work tree is a valid snapshot", async () => {
    const root = scratch();
    try {
      const work = join(root, "work");
      const gitDir = join(root, "meta");
      mkdirSync(work, { recursive: true });
      // A fresh fleet has nothing to publish, and that is not a failure: the
      // empty tree is the state.
      expect(hasFiles(work)).toBe(false);
      const snap = await snapshot({ work, gitDir });
      expect(snap.tree).toBe(EMPTY_TREE);
      expect(snap.pack.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a work tree with files is not empty", () => {
    const root = scratch();
    try {
      const work = join(root, "work");
      mkdirSync(join(work, "deep"), { recursive: true });
      expect(hasFiles(work)).toBe(false);
      writeFileSync(join(work, "deep", "a.txt"), "a");
      expect(hasFiles(work)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("leave a nested repository alone: its contents are not captured", async () => {
    const root = scratch();
    try {
      const work = join(root, "work");
      const gitDir = join(root, "meta");
      const nested = join(work, "project");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(work, "loose.txt"), "loose");
      gitIn(nested, ["init", "-q", "."]);
      gitIn(nested, ["config", "user.email", "t@t"]);
      gitIn(nested, ["config", "user.name", "t"]);
      writeFileSync(join(nested, "code.py"), "print(1)");
      gitIn(nested, ["add", "-A"]);
      gitIn(nested, ["commit", "-qm", "init"]);
      writeFileSync(join(nested, "code.py"), "print(2) agent edit");

      const snap = await snapshot({ work, gitDir });
      const listed = execFileSync("git", ["--git-dir=" + gitDir, "ls-tree", "-r", snap.commit], { encoding: "utf8" });
      expect(listed).toContain("loose.txt");
      // The nested repository is excluded outright: the fleet neither mirrors
      // its contents nor records a reference to it. A reference would be a
      // promise the replica could not keep.
      expect(listed).not.toContain("project");
      expect(listed).not.toContain("code.py");
      expect(listed).not.toContain("160000");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an explicitly excluded directory is not captured", async () => {
    const root = scratch();
    try {
      const work = join(root, "work");
      const gitDir = join(root, "meta");
      mkdirSync(join(work, "keep"), { recursive: true });
      mkdirSync(join(work, "skip"), { recursive: true });
      writeFileSync(join(work, "keep", "a.txt"), "a");
      writeFileSync(join(work, "skip", "b.txt"), "b");
      const snap = await snapshot({ work, gitDir, exclude: ["skip"] });
      const listed = execFileSync("git", ["--git-dir=" + gitDir, "ls-tree", "-r", snap.commit], { encoding: "utf8" });
      expect(listed).toContain("keep/a.txt");
      expect(listed).not.toContain("skip/b.txt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a second snapshot keeps the first as its parent", async () => {
    const root = scratch();
    try {
      const work = join(root, "work");
      const gitDir = join(root, "meta");
      mkdirSync(work, { recursive: true });
      writeFileSync(join(work, "a.txt"), "one");
      const first = await snapshot({ work, gitDir });
      writeFileSync(join(work, "a.txt"), "two");
      const second = await snapshot({ work, gitDir, base: first.commit });
      expect(second.parent).toBe(first.commit);
      const parents = execFileSync("git", ["--git-dir=" + gitDir, "rev-list", "--parents", "-n", "1", second.commit], { encoding: "utf8" });
      expect(parents).toContain(first.commit);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("applying a snapshot", () => {
  test("reproduces the tree on another machine", async () => {
    const root = scratch();
    try {
      const work = join(root, "work");
      const gitDir = join(root, "meta");
      mkdirSync(work, { recursive: true });
      writeFileSync(join(work, "a.txt"), "alpha");
      mkdirSync(join(work, "sub"), { recursive: true });
      writeFileSync(join(work, "sub", "b.txt"), "beta");
      const snap = await snapshot({ work, gitDir });

      const other = join(root, "other");
      const otherGit = join(root, "other-meta");
      mkdirSync(other, { recursive: true });
      await applyPack(other, otherGit, snap.commit, snap.pack);
      expect(readFileSync(join(other, "a.txt"), "utf8")).toBe("alpha");
      expect(readFileSync(join(other, "sub", "b.txt"), "utf8")).toBe("beta");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("removes files the snapshot does not contain", async () => {
    const root = scratch();
    try {
      const work = join(root, "work");
      const gitDir = join(root, "meta");
      mkdirSync(work, { recursive: true });
      writeFileSync(join(work, "a.txt"), "alpha");
      writeFileSync(join(work, "stale.txt"), "old");
      const first = await snapshot({ work, gitDir });

      // The file goes away, and the next snapshot does not have it.
      rmSync(join(work, "stale.txt"));
      const second = await snapshot({ work, gitDir, base: first.commit });
      const listed = execFileSync("git", ["--git-dir=" + gitDir, "ls-tree", "-r", second.commit], { encoding: "utf8" });
      expect(listed).toContain("a.txt");
      expect(listed).not.toContain("stale.txt");

      const other = join(root, "other");
      const otherGit = join(root, "other-meta");
      mkdirSync(other, { recursive: true });
      await applyPack(other, otherGit, second.commit, second.pack);
      expect(existsSync(join(other, "a.txt"))).toBe(true);
      expect(existsSync(join(other, "stale.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a replica that already has a file the primary removed loses it", async () => {
    const root = scratch();
    try {
      const work = join(root, "work");
      const gitDir = join(root, "meta");
      mkdirSync(work, { recursive: true });
      writeFileSync(join(work, "keep.txt"), "keep");
      writeFileSync(join(work, "gone.txt"), "gone");
      const first = await snapshot({ work, gitDir });

      const other = join(root, "other");
      const otherGit = join(root, "other-meta");
      mkdirSync(other, { recursive: true });
      await applyPack(other, otherGit, first.commit, first.pack);
      expect(existsSync(join(other, "gone.txt"))).toBe(true);

      // The primary deletes the file and publishes again.
      rmSync(join(work, "gone.txt"));
      const second = await snapshot({ work, gitDir, base: first.commit });
      await applyPack(other, otherGit, second.commit, second.pack, [], first.commit);
      expect(existsSync(join(other, "keep.txt"))).toBe(true);
      expect(existsSync(join(other, "gone.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an excluded directory survives the apply", async () => {
    const root = scratch();
    try {
      const work = join(root, "work");
      const gitDir = join(root, "meta");
      mkdirSync(join(work, "mine"), { recursive: true });
      writeFileSync(join(work, "a.txt"), "alpha");
      writeFileSync(join(work, "mine", "local.txt"), "mine alone");
      const snap = await snapshot({ work, gitDir, exclude: ["mine"] });

      const other = join(root, "other");
      const otherGit = join(root, "other-meta");
      mkdirSync(join(other, "mine"), { recursive: true });
      writeFileSync(join(other, "mine", "local.txt"), "still mine");
      await applyPack(other, otherGit, snap.commit, snap.pack, ["mine"]);
      expect(existsSync(join(other, "a.txt"))).toBe(true);
      expect(readFileSync(join(other, "mine", "local.txt"), "utf8")).toBe("still mine");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// A replica with the primary's first snapshot applied, ready for the next one.
async function replicaOf(files: Record<string, string>) {
  const root = scratch();
  const work = join(root, "work");
  const gitDir = join(root, "meta");
  const other = join(root, "other");
  const otherGit = join(root, "other-meta");
  mkdirSync(work, { recursive: true });
  mkdirSync(other, { recursive: true });
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(work, path, ".."), { recursive: true });
    writeFileSync(join(work, path), body);
  }
  const first = await snapshot({ work, gitDir });
  await applyPack(other, otherGit, first.commit, first.pack);
  return { root, work, gitDir, other, otherGit, first };
}

describe("applying a snapshot keeps what the fleet never synced", () => {
  test("a gitignored file and an untracked directory survive, a dropped tracked file goes", async () => {
    const r = await replicaOf({ "a.txt": "alpha", "gone.txt": "bye", "sub/deep.txt": "deep", ".gitignore": ".env\nnode_modules/\n" });
    try {
      // Things the replica's owner has and the fleet never carried.
      writeFileSync(join(r.other, ".env"), "SECRET=1");
      mkdirSync(join(r.other, "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(r.other, "node_modules", "pkg", "index.js"), "x");
      writeFileSync(join(r.other, "notes.md"), "mine");

      rmSync(join(r.work, "gone.txt"));
      writeFileSync(join(r.work, "a.txt"), "alpha 2");
      const second = await snapshot({ work: r.work, gitDir: r.gitDir, base: r.first.commit, wantFull: false });
      await applyPack(r.other, r.otherGit, second.commit, second.delta!, [], r.first.commit);

      expect(readFileSync(join(r.other, "a.txt"), "utf8")).toBe("alpha 2");
      expect(existsSync(join(r.other, "gone.txt"))).toBe(false);
      expect(readFileSync(join(r.other, ".env"), "utf8")).toBe("SECRET=1");
      expect(existsSync(join(r.other, "node_modules", "pkg", "index.js"))).toBe(true);
      expect(readFileSync(join(r.other, "notes.md"), "utf8")).toBe("mine");
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  test("the first apply, with no record of what came before, removes nothing", async () => {
    const root = scratch();
    try {
      const work = join(root, "work");
      const other = join(root, "other");
      mkdirSync(work, { recursive: true });
      mkdirSync(other, { recursive: true });
      writeFileSync(join(work, "a.txt"), "alpha");
      writeFileSync(join(other, "already-here.txt"), "not the fleet's");
      const snap = await snapshot({ work, gitDir: join(root, "meta") });
      await applyPack(other, join(root, "other-meta"), snap.commit, snap.pack);
      expect(existsSync(join(other, "a.txt"))).toBe(true);
      expect(existsSync(join(other, "already-here.txt"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a previous commit the store does not have removes nothing and does not fail", async () => {
    const r = await replicaOf({ "a.txt": "alpha", "b.txt": "beta" });
    try {
      rmSync(join(r.work, "b.txt"));
      const second = await snapshot({ work: r.work, gitDir: r.gitDir, base: r.first.commit });
      writeFileSync(join(r.other, "keep-me.txt"), "mine");
      await applyPack(r.other, r.otherGit, second.commit, second.pack, [], "0123456789abcdef0123456789abcdef01234567");
      expect(existsSync(join(r.other, "keep-me.txt"))).toBe(true);
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  test("a directory the removal empties goes with it, one that still holds something stays", async () => {
    const r = await replicaOf({ "only/one.txt": "1", "shared/two.txt": "2", "shared/three.txt": "3" });
    try {
      writeFileSync(join(r.other, "shared", "mine.txt"), "mine");
      rmSync(join(r.work, "only"), { recursive: true });
      rmSync(join(r.work, "shared", "two.txt"));
      const second = await snapshot({ work: r.work, gitDir: r.gitDir, base: r.first.commit });
      await applyPack(r.other, r.otherGit, second.commit, second.pack, [], r.first.commit);
      expect(existsSync(join(r.other, "only"))).toBe(false);
      expect(existsSync(join(r.other, "shared", "two.txt"))).toBe(false);
      expect(existsSync(join(r.other, "shared", "three.txt"))).toBe(true);
      expect(existsSync(join(r.other, "shared", "mine.txt"))).toBe(true);
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  test("a file that became a directory of the same name is the new tree's", async () => {
    const r = await replicaOf({ "thing": "was a file", "keep.txt": "k" });
    try {
      rmSync(join(r.work, "thing"));
      mkdirSync(join(r.work, "thing"));
      writeFileSync(join(r.work, "thing", "inner.txt"), "now a folder");
      const second = await snapshot({ work: r.work, gitDir: r.gitDir, base: r.first.commit });
      await applyPack(r.other, r.otherGit, second.commit, second.pack, [], r.first.commit);
      expect(readFileSync(join(r.other, "thing", "inner.txt"), "utf8")).toBe("now a folder");
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  test("a whole-tree checkpoint after a long gap still removes what the fleet dropped in between", async () => {
    const r = await replicaOf({ "a.txt": "alpha", "old.txt": "old" });
    try {
      let base = r.first.commit;
      rmSync(join(r.work, "old.txt"));
      for (let i = 0; i < 3; i++) {
        writeFileSync(join(r.work, "a.txt"), "alpha " + i);
        base = (await snapshot({ work: r.work, gitDir: r.gitDir, base })).commit;
      }
      const checkpoint = await snapshot({ work: r.work, gitDir: r.gitDir, base, wantFull: true });
      writeFileSync(join(r.other, ".env"), "mine");
      await applyPack(r.other, r.otherGit, checkpoint.commit, checkpoint.pack, [], r.first.commit);
      expect(existsSync(join(r.other, "old.txt"))).toBe(false);
      expect(readFileSync(join(r.other, "a.txt"), "utf8")).toBe("alpha 2");
      expect(existsSync(join(r.other, ".env"))).toBe(true);
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  test("a path inside an excluded directory is never removed", async () => {
    const r = await replicaOf({ "mine/x.txt": "x", "a.txt": "a" });
    try {
      rmSync(join(r.work, "mine"), { recursive: true });
      const second = await snapshot({ work: r.work, gitDir: r.gitDir, base: r.first.commit });
      await applyPack(r.other, r.otherGit, second.commit, second.pack, ["mine"], r.first.commit);
      expect(existsSync(join(r.other, "mine", "x.txt"))).toBe(true);
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });
});

describe("what leaves the work tree is decided by the two trees", () => {
  test("with no apply index at all, the dropped file still goes: the tree diff is the deleter", async () => {
    const r = await replicaOf({ "a.txt": "alpha", "gone.txt": "bye", "sub/deep.txt": "d" });
    try {
      writeFileSync(join(r.other, "mine.txt"), "mine");
      rmSync(join(r.work, "gone.txt"));
      const second = await snapshot({ work: r.work, gitDir: r.gitDir, base: r.first.commit });
      rmSync(join(r.otherGit, "apply.index"), { force: true });
      await applyPack(r.other, r.otherGit, second.commit, second.pack, [], r.first.commit);
      expect(existsSync(join(r.other, "gone.txt"))).toBe(false);
      expect(existsSync(join(r.other, "mine.txt"))).toBe(true);
      expect(readFileSync(join(r.other, "a.txt"), "utf8")).toBe("alpha");
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  test("the diff names exactly the paths the fleet dropped, whatever they are called", async () => {
    const odd = "dir with space/it's \"q\" é.txt";
    const r = await replicaOf({ "keep.txt": "k", [odd]: "x", "gone.txt": "g", "sub/gone2.txt": "g2" });
    try {
      rmSync(join(r.work, "gone.txt"));
      rmSync(join(r.work, "sub"), { recursive: true });
      rmSync(join(r.work, "dir with space"), { recursive: true });
      writeFileSync(join(r.work, "new.txt"), "n");
      const second = await snapshot({ work: r.work, gitDir: r.gitDir, base: r.first.commit });
      const env = { ...process.env } as Record<string, string>;
      const gone = (await removedBetween(r.gitDir, env, r.first.commit, second.commit)).sort();
      expect(gone).toEqual([odd, "gone.txt", "sub/gone2.txt"].sort());
      expect(await removedBetween(r.gitDir, env, null, second.commit)).toEqual([]);
      expect(await removedBetween(r.gitDir, env, second.commit, second.commit)).toEqual([]);
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  test("a stale apply index (the member was primary in between) cannot delete its own files", async () => {
    // M applies T1, in which .env was tracked. M is promoted, ignores .env and
    // publishes T2. Later M is a replica again and applies T3: its apply index
    // still says T1, which names .env, but the fleet dropped nothing of M's.
    const r = await replicaOf({ "a.txt": "a", ".env": "T1" });
    try {
      writeFileSync(join(r.other, ".gitignore"), ".env\n");
      writeFileSync(join(r.other, ".env"), "M's own secret");
      const t2 = await snapshot({ work: r.other, gitDir: r.otherGit, base: r.first.commit });
      await applyPack(r.work, r.gitDir, t2.commit, t2.pack, [], r.first.commit);
      writeFileSync(join(r.work, "a.txt"), "a3");
      const t3 = await snapshot({ work: r.work, gitDir: r.gitDir, base: t2.commit });
      await applyPack(r.other, r.otherGit, t3.commit, t3.delta ?? t3.pack, [], t2.commit);
      expect(readFileSync(join(r.other, ".env"), "utf8")).toBe("M's own secret");
      expect(readFileSync(join(r.other, "a.txt"), "utf8")).toBe("a3");
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  test("a directory that became a nested repository on the replica loses nothing, whatever the index says", async () => {
    const r = await replicaOf({ "lib/a.js": "a", "lib/b.js": "b", "top.txt": "t" });
    try {
      gitIn(join(r.other, "lib"), ["init", "-q", "."]);
      rmSync(join(r.work, "lib", "a.js"));
      const second = await snapshot({ work: r.work, gitDir: r.gitDir, base: r.first.commit });
      await applyPack(r.other, r.otherGit, second.commit, second.pack, ["lib"], r.first.commit);
      expect(readFileSync(join(r.other, "lib", "a.js"), "utf8")).toBe("a");
      expect(readFileSync(join(r.other, "lib", "b.js"), "utf8")).toBe("b");
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  test("with no record of what came before, a stale index deletes nothing either", async () => {
    const r = await replicaOf({ "a.txt": "a", "old.txt": "o" });
    try {
      rmSync(join(r.work, "old.txt"));
      const second = await snapshot({ work: r.work, gitDir: r.gitDir, base: r.first.commit });
      // The apply index names old.txt, but this apply is told nothing about
      // the snapshot before: it removes nothing.
      await applyPack(r.other, r.otherGit, second.commit, second.pack, [], null);
      expect(existsSync(join(r.other, "old.txt"))).toBe(true);
      expect(readFileSync(join(r.other, "a.txt"), "utf8")).toBe("a");
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });
});

describe("taking a snapshot in and writing it out are two steps", () => {
  test("ingesting leaves the work tree exactly as it was; applying the commit then writes it", async () => {
    const r = await replicaOf({ "a.txt": "alpha", "gone.txt": "bye", "sub/b.txt": "beta" });
    try {
      writeFileSync(join(r.work, "a.txt"), "alpha 2");
      rmSync(join(r.work, "gone.txt"));
      const second = await snapshot({ work: r.work, gitDir: r.gitDir, base: r.first.commit, wantFull: false });
      const before = readdirSync(r.other).sort();

      await ingestPack(r.other, r.otherGit, second.commit, second.delta!, { tree: second.tree, seq: 2 });
      expect(readFileSync(join(r.other, "a.txt"), "utf8")).toBe("alpha");
      expect(existsSync(join(r.other, "gone.txt"))).toBe(true);
      expect(readdirSync(r.other).sort()).toEqual(before);
      const ref = execFileSync("git", ["--git-dir=" + r.otherGit, "rev-parse", "refs/prime/fetched/2"], { encoding: "utf8" }).trim();
      expect(ref).toBe(second.commit);
      // Repeating it is harmless.
      await ingestPack(r.other, r.otherGit, second.commit, second.delta!, { tree: second.tree });

      await applyCommit(r.other, r.otherGit, second.commit, [], r.first.commit);
      expect(readFileSync(join(r.other, "a.txt"), "utf8")).toBe("alpha 2");
      expect(existsSync(join(r.other, "gone.txt"))).toBe(false);
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  test("one apply covers several snapshots that were only ingested", async () => {
    const r = await replicaOf({ "a.txt": "alpha", "b.txt": "beta" });
    try {
      let base = r.first.commit;
      let last = r.first;
      for (let i = 0; i < 4; i++) {
        writeFileSync(join(r.work, "a.txt"), "alpha " + i);
        if (i === 2) rmSync(join(r.work, "b.txt"));
        last = await snapshot({ work: r.work, gitDir: r.gitDir, base, wantFull: false });
        if (i < 3) await ingestPack(r.other, r.otherGit, last.commit, last.delta!, { tree: last.tree });
        base = last.commit;
      }
      await ingestPack(r.other, r.otherGit, last.commit, last.delta!, { tree: last.tree });
      await applyCommit(r.other, r.otherGit, last.commit, [], r.first.commit);
      expect(readFileSync(join(r.other, "a.txt"), "utf8")).toBe("alpha 3");
      expect(existsSync(join(r.other, "b.txt"))).toBe(false);
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  test("a pack whose commit names another tree than its manifest is refused", async () => {
    const r = await replicaOf({ "a.txt": "alpha" });
    try {
      writeFileSync(join(r.work, "a.txt"), "alpha 2");
      const second = await snapshot({ work: r.work, gitDir: r.gitDir, base: r.first.commit, wantFull: false });
      let message = "";
      try {
        await ingestPack(r.other, r.otherGit, second.commit, second.delta!, { tree: r.first.tree, seq: 2 });
      } catch (err) {
        message = String(err);
      }
      expect(message).toContain("does not match its manifest");
      // It is not kept as fetched.
      expect(() => execFileSync("git", ["--git-dir=" + r.otherGit, "rev-parse", "--verify", "-q", "refs/prime/fetched/2"], { stdio: "pipe" })).toThrow();
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });
});

describe("a removal never leaves the work tree", () => {
  test("a directory the primary turned into a symlink does not take outside files with it", async () => {
    const r = await replicaOf({ "cfg/secret.txt": "fleet", "keep.txt": "k" });
    try {
      mkdirSync(join(r.root, "outside"));
      writeFileSync(join(r.root, "outside", "secret.txt"), "the user's, outside the work tree");
      // The primary replaces cfg/ with a link out of the tree.
      rmSync(join(r.work, "cfg"), { recursive: true });
      symlinkSync("../outside", join(r.work, "cfg"));
      const second = await snapshot({ work: r.work, gitDir: r.gitDir, base: r.first.commit });
      await applyPack(r.other, r.otherGit, second.commit, second.pack, [], r.first.commit);
      expect(readFileSync(join(r.root, "outside", "secret.txt"), "utf8")).toBe("the user's, outside the work tree");
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  test("a tracked directory the replica's owner turned into a symlink is not followed", async () => {
    const r = await replicaOf({ "cfg/secret.txt": "fleet", "keep.txt": "k" });
    try {
      mkdirSync(join(r.root, "outside"));
      writeFileSync(join(r.root, "outside", "secret.txt"), "the user's, outside the work tree");
      rmSync(join(r.other, "cfg"), { recursive: true });
      symlinkSync("../outside", join(r.other, "cfg"));
      // The primary deletes the file; the replica's cfg is a link now.
      rmSync(join(r.work, "cfg"), { recursive: true });
      const second = await snapshot({ work: r.work, gitDir: r.gitDir, base: r.first.commit });
      await applyPack(r.other, r.otherGit, second.commit, second.pack, [], r.first.commit);
      expect(readFileSync(join(r.root, "outside", "secret.txt"), "utf8")).toBe("the user's, outside the work tree");
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });
});

describe("names that differ only in case", () => {
  // Needs a file system that folds case (macOS, Windows); elsewhere the two
  // names are two files and there is nothing to lose.
  function foldsCase(dir: string): boolean {
    writeFileSync(join(dir, "Probe.tmp"), "x");
    const folds = existsSync(join(dir, "probe.tmp"));
    rmSync(join(dir, "Probe.tmp"));
    return folds;
  }

  test("a rename that only changes case does not leave the replica with neither file", async () => {
    const r = await replicaOf({ "README.md": "hello", "other.txt": "o" });
    try {
      if (!foldsCase(r.other)) return;
      // A primary on a case-sensitive file system renamed README.md -> readme.md.
      const git = (args: string[], input?: string) =>
        execFileSync("git", ["--git-dir=" + r.gitDir, ...args], {
          input,
          env: { ...process.env, GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@a", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@a" },
        }).toString().trim();
      const hello = git(["hash-object", "-w", "--stdin"], "hello");
      const other = git(["hash-object", "-w", "--stdin"], "o");
      const tree = git(["mktree"], "100644 blob " + hello + "\treadme.md\n100644 blob " + other + "\tother.txt\n");
      const commit = git(["commit-tree", tree, "-p", r.first.commit, "-m", "x"]);
      const pack = execFileSync("git", ["--git-dir=" + r.gitDir, "pack-objects", "--stdout", "--revs"], { input: commit + "\n" });
      await applyPack(r.other, r.otherGit, commit, pack, [], r.first.commit);
      expect(readFileSync(join(r.other, "readme.md"), "utf8")).toBe("hello");
      expect(readdirSync(r.other).filter((n) => n.toLowerCase() === "readme.md")).toEqual(["readme.md"]);
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  test("a file that is not named exactly as the dropped path is not the fleet's to remove", async () => {
    const r = await replicaOf({ "Notes.txt": "fleet", "keep.txt": "k" });
    try {
      if (!foldsCase(r.other)) return;
      // The fleet drops Notes.txt. On disk the name is notes.txt now (the
      // owner renamed it): a different name, so it is left alone.
      rmSync(join(r.other, "Notes.txt"));
      writeFileSync(join(r.other, "notes.txt"), "the owner's");
      rmSync(join(r.work, "Notes.txt"));
      const second = await snapshot({ work: r.work, gitDir: r.gitDir, base: r.first.commit });
      await applyPack(r.other, r.otherGit, second.commit, second.pack, [], r.first.commit);
      expect(readFileSync(join(r.other, "notes.txt"), "utf8")).toBe("the owner's");
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });
});

describe("a whole-tree pack carries the tree, not the history", () => {
  test("its size does not grow with the snapshots that came before, and a joiner can use it", async () => {
    const root = scratch();
    try {
      const work = join(root, "work");
      const gitDir = join(root, "meta");
      mkdirSync(work, { recursive: true });
      let seed = 7;
      const noise = (): string => {
        let out = "";
        for (let i = 0; i < 4000; i++) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          out += (seed % 36).toString(36);
        }
        return out;
      };
      for (let i = 0; i < 10; i++) writeFileSync(join(work, "f" + i + ".txt"), noise());
      const first = await snapshot({ work, gitDir, wantFull: true });
      let base = first.commit;
      let last = first;
      // Every snapshot rewrites most of the files, so each leaves its own blobs behind.
      for (let n = 0; n < 12; n++) {
        for (let i = 0; i < 8; i++) writeFileSync(join(work, "f" + i + ".txt"), noise());
        last = await snapshot({ work, gitDir, base, wantFull: true });
        base = last.commit;
      }
      expect(last.pack.length).toBeLessThan(first.pack.length * 1.2);

      // A member that has nothing opens it, and a delta applies on top.
      const other = join(root, "other");
      mkdirSync(other);
      await applyPack(other, join(root, "other-meta"), last.commit, last.pack, [], null);
      expect(readFileSync(join(other, "f0.txt"), "utf8")).toBe(readFileSync(join(work, "f0.txt"), "utf8"));
      writeFileSync(join(work, "f9.txt"), "after the anchor");
      const next = await snapshot({ work, gitDir, base: last.commit, wantFull: false });
      await applyPack(other, join(root, "other-meta"), next.commit, next.delta!, [], last.commit);
      expect(readFileSync(join(other, "f9.txt"), "utf8")).toBe("after the anchor");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a snapshot that goes out as a whole tree", () => {
  test("names no parent, and the change beside it is built against the tree before, so it is small", async () => {
    const noise = (): string => randomBytes(1500).toString("hex");
    const b = noise();
    const r = await replicaOf({ "a.txt": noise(), "b.txt": b, "c.txt": noise() });
    try {
      const changed = noise();
      writeFileSync(join(r.work, "a.txt"), changed);
      const second = await snapshot({ work: r.work, gitDir: r.gitDir, base: r.first.commit, wantFull: true, withDelta: true });
      const parents = execFileSync("git", ["--git-dir=" + r.gitDir, "rev-list", "--parents", "-n", "1", second.commit], { encoding: "utf8" }).trim();
      expect(parents).toBe(second.commit); // no parent after it
      // The change carries the changed file and not the two that did not change.
      expect(second.delta!.length).toBeLessThan(second.pack.length * 0.6); // one of three files

      // A member holding the snapshot before takes the change; one that holds nothing takes the tree.
      await applyPack(r.other, r.otherGit, second.commit, second.delta!, [], r.first.commit);
      expect(readFileSync(join(r.other, "a.txt"), "utf8")).toBe(changed);
      const fresh = join(r.root, "fresh");
      mkdirSync(fresh);
      await applyPack(fresh, join(r.root, "fresh-meta"), second.commit, second.pack, [], null);
      expect(readFileSync(join(fresh, "b.txt"), "utf8")).toBe(b);
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  test("an older client that took it in can still publish a whole tree of its own", async () => {
    // main's fleet-sync, as it was before this work: it builds whole packs by walking
    // the snapshot's history, and stops at a parent it never received.
    let oldSource = "";
    try {
      oldSource = execFileSync("git", ["show", "26e61d1:cli/src/fleet-sync.ts"], { encoding: "utf8", cwd: join(import.meta.dir, "..") });
    } catch {
      return; // no history to read (a shallow checkout): nothing to compare with
    }
    const r = await replicaOf({ "a.txt": "alpha".repeat(200), "b.txt": "beta".repeat(200) });
    try {
      writeFileSync(join(r.work, "a.txt"), "alpha, a checkpoint".repeat(200));
      const checkpoint = await snapshot({ work: r.work, gitDir: r.gitDir, base: r.first.commit, wantFull: true });

      const file = join(r.root, "old-fleet-sync.ts");
      writeFileSync(file, oldSource);
      const old = (await import(pathToFileURL(file).href)) as typeof import("../src/fleet-sync");
      // A member on the old version that joined at the checkpoint: it has never seen the snapshot before it.
      const work = join(r.root, "old-work");
      const gitDir = join(r.root, "old-meta");
      mkdirSync(work);
      await old.applyPack(work, gitDir, checkpoint.commit, checkpoint.pack);
      // It is promoted, edits, and its next checkpoint (or a join) is a whole tree.
      writeFileSync(join(work, "b.txt"), "beta, edited by the old member".repeat(200));
      const mine = await old.snapshot({ work, gitDir, base: checkpoint.commit, wantFull: true });
      expect(mine.pack.length).toBeGreaterThan(0);

      // And the new version applies what it publishes.
      const next = join(r.root, "next");
      mkdirSync(next);
      await applyPack(next, join(r.root, "next-meta"), mine.commit, mine.pack, [], null);
      expect(readFileSync(join(next, "b.txt"), "utf8")).toBe("beta, edited by the old member".repeat(200));
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });
});

describe("a case-only rename on the primary", () => {
  test("is published: the fleet's tree follows the names on disk", async () => {
    const root = scratch();
    try {
      const work = join(root, "work");
      const gitDir = join(root, "meta");
      mkdirSync(join(work, "docs"), { recursive: true });
      writeFileSync(join(work, "Notes.md"), "notes v1");
      writeFileSync(join(work, "docs", "a.txt"), "a");
      writeFileSync(join(work, "keep.txt"), "k");
      const first = await snapshot({ work, gitDir });
      // Needs a file system that folds case (macOS, Windows); elsewhere the two names are two files.
      writeFileSync(join(work, "Probe.tmp"), "x");
      const folds = existsSync(join(work, "probe.tmp"));
      rmSync(join(work, "Probe.tmp"));
      if (!folds) return;

      renameSync(join(work, "Notes.md"), join(work, "tmp-name"));
      renameSync(join(work, "tmp-name"), join(work, "NOTES.md"));
      renameSync(join(work, "docs"), join(work, "tmp-dir"));
      renameSync(join(work, "tmp-dir"), join(work, "Docs"));
      const second = await snapshot({ work, gitDir, base: first.commit, wantFull: false });
      const names = execFileSync("git", ["--git-dir=" + gitDir, "ls-tree", "-r", "--name-only", second.commit], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
      expect(names).toEqual(["Docs/a.txt", "NOTES.md", "keep.txt"]);
      expect(second.tree).not.toBe(first.tree);

      // And the next snapshot, with nothing changed, is the same tree: nothing flaps.
      const third = await snapshot({ work, gitDir, base: second.commit, wantFull: false });
      expect(third.tree).toBe(second.tree);

      // A replica that held the old spelling ends with the new one and nothing else.
      const other = join(root, "other");
      mkdirSync(other);
      await applyPack(other, join(root, "other-meta"), first.commit, first.pack, [], null);
      await applyPack(other, join(root, "other-meta"), second.commit, second.delta!, [], first.commit);
      expect(readdirSync(other).sort()).toEqual(["Docs", "NOTES.md", "keep.txt"]);
      expect(readFileSync(join(other, "NOTES.md"), "utf8")).toBe("notes v1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the object store's settings", () => {
  const configFile = (gitDir: string) => join(gitDir, "config");
  const setting = (gitDir: string, key: string) => execFileSync("git", ["--git-dir=" + gitDir, "config", "--get", key], { encoding: "utf8" }).trim();

  test("are written when the store is made or its work tree moves, not on every snapshot", async () => {
    const root = scratch();
    try {
      const work = join(root, "work");
      const gitDir = join(root, "meta");
      mkdirSync(work);
      writeFileSync(join(work, "a.txt"), "a");
      const first = await snapshot({ work, gitDir });
      const written = statSync(configFile(gitDir));
      writeFileSync(join(work, "a.txt"), "b");
      await snapshot({ work, gitDir, base: first.commit, wantFull: false });
      // git replaces the file whenever it sets a key, even to the value it has.
      expect(statSync(configFile(gitDir)).ino).toBe(written.ino);
      expect(statSync(configFile(gitDir)).mtimeMs).toBe(written.mtimeMs);

      // The work tree moved: the store follows.
      const moved = join(root, "moved");
      renameSync(work, moved);
      await snapshot({ work: moved, gitDir, base: first.commit, wantFull: false });
      expect(setting(gitDir, "core.worktree")).toBe(moved);
      expect(setting(gitDir, "core.ignorecase")).toBe("false");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("are put back when something else rewrote the config", async () => {
    const root = scratch();
    try {
      const work = join(root, "work");
      const gitDir = join(root, "meta");
      mkdirSync(work);
      writeFileSync(join(work, "a.txt"), "a");
      const first = await snapshot({ work, gitDir });
      execFileSync("git", ["--git-dir=" + gitDir, "config", "core.ignorecase", "true"]);
      await snapshot({ work, gitDir, base: first.commit, wantFull: false });
      expect(setting(gitDir, "core.ignorecase")).toBe("false");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a case-only rename under a directory whose name is decomposed unicode", () => {
  // macOS keeps the bytes a name was created with (Cafe + U+0301), and git keeps index
  // paths composed (U+00E9): the two never compared equal, and both spellings of the
  // renamed file were removed from the published tree.
  test("the renamed file stays in the fleet's tree, with the spelling on disk", async () => {
    const root = scratch();
    try {
      const work = join(root, "work");
      const gitDir = join(root, "meta");
      const nfd = "Cafe\u0301";
      mkdirSync(join(work, nfd), { recursive: true });
      writeFileSync(join(work, nfd, "notes.md"), "the user's notes");
      writeFileSync(join(work, "other.txt"), "x");
      const first = await snapshot({ work, gitDir });
      writeFileSync(join(work, "Probe.tmp"), "x");
      const folds = existsSync(join(work, "probe.tmp"));
      rmSync(join(work, "Probe.tmp"));
      // Needs a case-folding file system that keeps decomposed names as they were made (macOS).
      if (!folds || readdirSync(work).every((n) => n !== nfd)) return;

      renameSync(join(work, nfd, "notes.md"), join(work, nfd, "tmp-name"));
      renameSync(join(work, nfd, "tmp-name"), join(work, nfd, "Notes.md"));
      const second = await snapshot({ work, gitDir, base: first.commit, wantFull: false });
      const names = () =>
        execFileSync("git", ["-c", "core.quotepath=false", "--git-dir=" + gitDir, "ls-tree", "-r", "--name-only", second.commit], { encoding: "utf8" })
          .split("\n")
          .filter(Boolean)
          .map((n) => n.normalize("NFC"))
          .sort();
      expect(names()).toEqual(["Caf\u00e9/Notes.md", "other.txt"]);
      const third = await snapshot({ work, gitDir, base: second.commit, wantFull: false });
      expect(third.tree).toBe(second.tree);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("an apply that was killed half way", () => {
  test("the files it had written are the fleet's, and only the member's own edit is reported", async () => {
    const r = await replicaOf({ "a.txt": "a1", "b.txt": "b1", "c.txt": "c1", "keep.txt": "k" });
    try {
      writeFileSync(join(r.work, "a.txt"), "a2");
      writeFileSync(join(r.work, "b.txt"), "b2");
      writeFileSync(join(r.work, "d.txt"), "d2");
      rmSync(join(r.work, "keep.txt"));
      const second = await snapshot({ work: r.work, gitDir: r.gitDir, base: r.first.commit, wantFull: false });
      await ingestPack(r.other, r.otherGit, second.commit, second.delta!, { tree: second.tree });

      // The apply began (it wrote down what it was for), wrote a.txt and d.txt, took keep.txt away, and was killed.
      writeFileSync(join(r.otherGit, "apply.target"), JSON.stringify({ from: r.first.commit, to: second.commit }));
      writeFileSync(join(r.other, "a.txt"), "a2");
      writeFileSync(join(r.other, "d.txt"), "d2");
      rmSync(join(r.other, "keep.txt"));
      // Meanwhile the member had edited c.txt.
      writeFileSync(join(r.other, "c.txt"), "c1, edited by the member");

      expect(await localChanges(r.other, r.otherGit, r.first.tree, { base: r.first.commit })).toEqual(["c.txt"]);
      // Without the note, the same work tree reads as four edits.
      rmSync(join(r.otherGit, "apply.target"));
      expect((await localChanges(r.other, r.otherGit, r.first.tree)).sort()).toEqual(["a.txt", "c.txt", "d.txt", "keep.txt"]);
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  test("a note that does not start from where the member is is not trusted", async () => {
    const r = await replicaOf({ "a.txt": "a1", "b.txt": "b1" });
    try {
      writeFileSync(join(r.work, "a.txt"), "a2");
      writeFileSync(join(r.work, "b.txt"), "b2");
      const second = await snapshot({ work: r.work, gitDir: r.gitDir, base: r.first.commit, wantFull: false });
      await ingestPack(r.other, r.otherGit, second.commit, second.delta!, { tree: second.tree });
      await applyCommit(r.other, r.otherGit, second.commit, [], r.first.commit);
      // The member's first apply (null -> first) left its note behind when it was stopped after the sidecar.
      // Since then the member holds the second snapshot, and its owner puts b.txt back as the first one had it.
      writeFileSync(join(r.otherGit, "apply.target"), JSON.stringify({ from: null, to: r.first.commit }));
      writeFileSync(join(r.other, "b.txt"), "b1");
      expect(await localChanges(r.other, r.otherGit, second.tree, { base: second.commit })).toEqual(["b.txt"]);
      // The note of an apply that did start from where the member is still counts.
      writeFileSync(join(r.otherGit, "apply.target"), JSON.stringify({ from: second.commit, to: r.first.commit }));
      expect(await localChanges(r.other, r.otherGit, second.tree, { base: second.commit })).toEqual([]);
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  test("an apply that finishes leaves no note, and one that waits for a lock left by a killed git gets through", async () => {
    const r = await replicaOf({ "a.txt": "a1", "b.txt": "b1" });
    try {
      writeFileSync(join(r.work, "a.txt"), "a2");
      const second = await snapshot({ work: r.work, gitDir: r.gitDir, base: r.first.commit, wantFull: false });
      await ingestPack(r.other, r.otherGit, second.commit, second.delta!, { tree: second.tree });
      // A git that was left running holds the index lock for a moment.
      const lock = join(r.otherGit, "apply.index.lock");
      writeFileSync(lock, "");
      setTimeout(() => rmSync(lock, { force: true }), 400);
      const began = Date.now();
      await applyCommit(r.other, r.otherGit, second.commit, [], r.first.commit);
      expect(Date.now() - began).toBeGreaterThanOrEqual(300);
      expect(readFileSync(join(r.other, "a.txt"), "utf8")).toBe("a2");
      expect(existsSync(join(r.otherGit, "apply.target"))).toBe(false);
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });
});

describe("what changed locally", () => {
  test("only the edited file is reported, and only it is moved aside", async () => {
    const r = await replicaOf({ "a.txt": "alpha", "b.txt": "beta", "sub/c.txt": "gamma" });
    try {
      const tree = r.first.tree;
      expect(await localChanges(r.other, r.otherGit, tree)).toEqual([]);

      writeFileSync(join(r.other, "b.txt"), "beta, edited here");
      expect(await localChanges(r.other, r.otherGit, tree)).toEqual(["b.txt"]);

      const kept = await preserveLocalChange(r.other, r.otherGit, tree);
      expect(kept.moved).toBe(1);
      expect(readFileSync(join(kept.to, "b.txt"), "utf8")).toBe("beta, edited here");
      expect(readFileSync(join(r.other, "a.txt"), "utf8")).toBe("alpha");
      expect(readFileSync(join(r.other, "sub", "c.txt"), "utf8")).toBe("gamma");
      rmSync(kept.to, { recursive: true, force: true });
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  test("a new file and a deleted file are reported; an ignored file is not", async () => {
    const r = await replicaOf({ ".gitignore": "*.log\nbuild/\n", "a.txt": "alpha", "b.txt": "beta" });
    try {
      writeFileSync(join(r.other, "new.txt"), "new");
      rmSync(join(r.other, "b.txt"));
      writeFileSync(join(r.other, "debug.log"), "noise");
      mkdirSync(join(r.other, "build"));
      writeFileSync(join(r.other, "build", "out.js"), "x");
      expect((await localChanges(r.other, r.otherGit, r.first.tree)).sort()).toEqual(["b.txt", "new.txt"]);
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  test("a nested repository is not reported and not moved", async () => {
    const r = await replicaOf({ "a.txt": "alpha" });
    try {
      const nested = join(r.other, "project");
      mkdirSync(nested, { recursive: true });
      gitIn(nested, ["init", "-q", "."]);
      writeFileSync(join(nested, "code.py"), "print(1)");
      writeFileSync(join(r.other, "edited.txt"), "mine");

      expect(await localChanges(r.other, r.otherGit, r.first.tree)).toEqual(["edited.txt"]);
      const kept = await preserveLocalChange(r.other, r.otherGit, r.first.tree);
      expect(kept.moved).toBe(1);
      expect(existsSync(join(r.other, "project", ".git"))).toBe(true);
      expect(existsSync(join(r.other, "project", "code.py"))).toBe(true);
      rmSync(kept.to, { recursive: true, force: true });
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  test("a moved-aside edit is replaced by the fleet's file on the next apply, even when the change does not touch it", async () => {
    const r = await replicaOf({ "a.txt": "alpha", "b.txt": "beta" });
    try {
      writeFileSync(join(r.other, "a.txt"), "alpha, edited here");
      const kept = await preserveLocalChange(r.other, r.otherGit, r.first.tree);
      expect(existsSync(join(r.other, "a.txt"))).toBe(false);

      writeFileSync(join(r.work, "b.txt"), "beta 2");
      const second = await snapshot({ work: r.work, gitDir: r.gitDir, base: r.first.commit, wantFull: false });
      await applyPack(r.other, r.otherGit, second.commit, second.delta!, [], r.first.commit);
      expect(readFileSync(join(r.other, "a.txt"), "utf8")).toBe("alpha");
      expect(readFileSync(join(r.other, "b.txt"), "utf8")).toBe("beta 2");
      rmSync(kept.to, { recursive: true, force: true });
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });
});

describe("nested repositories are remembered", () => {
  test("the walk is not repeated until something says it must be", () => {
    const root = scratch();
    try {
      mkdirSync(join(root, "a"), { recursive: true });
      gitIn(join(root, "a"), ["init", "-q", "."]);
      let now = 1000;
      const cache = new NestedRepoCache(root, 30_000, () => now);
      expect(cache.get()).toEqual(["a"]);

      // A repository appears: the cache does not know yet.
      mkdirSync(join(root, "b"), { recursive: true });
      gitIn(join(root, "b"), ["init", "-q", "."]);
      expect(cache.get()).toEqual(["a"]);

      // Changes the watcher reports that have nothing to do with a repository.
      cache.noteChange("change", "a/file.txt");
      cache.noteChange("rename", "c.txt");
      expect(cache.get()).toEqual(["a"]);

      // A change under .git is the signal.
      cache.noteChange("rename", "b/.git");
      expect(cache.get().sort()).toEqual(["a", "b"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a repository that arrives whole, a repository that leaves, an event with no path, and the age all refresh it", () => {
    const root = scratch();
    try {
      let now = 1000;
      const cache = new NestedRepoCache(root, 30_000, () => now);
      expect(cache.get()).toEqual([]);

      // A directory holding a repository moved in: the event names the directory.
      mkdirSync(join(root, "moved"), { recursive: true });
      gitIn(join(root, "moved"), ["init", "-q", "."]);
      cache.noteChange("rename", "moved");
      expect(cache.get()).toEqual(["moved"]);

      // It goes away: the answer is wrong at once, whatever the age.
      rmSync(join(root, "moved"), { recursive: true });
      expect(cache.get()).toEqual([]);

      mkdirSync(join(root, "later"), { recursive: true });
      gitIn(join(root, "later"), ["init", "-q", "."]);
      expect(cache.get()).toEqual([]);
      cache.noteChange("rename", null);
      expect(cache.get()).toEqual(["later"]);

      // With no event at all it is found when the answer is old enough.
      mkdirSync(join(root, "quiet"), { recursive: true });
      gitIn(join(root, "quiet"), ["init", "-q", "."]);
      expect(cache.get()).toEqual(["later"]);
      now += 31_000;
      expect(cache.get().sort()).toEqual(["later", "quiet"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a snapshot given the cache excludes the same repositories as one that walks", async () => {
    const root = scratch();
    try {
      const work = join(root, "work");
      mkdirSync(join(work, "project"), { recursive: true });
      writeFileSync(join(work, "loose.txt"), "loose");
      gitIn(join(work, "project"), ["init", "-q", "."]);
      writeFileSync(join(work, "project", "code.py"), "print(1)");
      const walked = await snapshot({ work, gitDir: join(root, "m1") });
      const cached = await snapshot({ work, gitDir: join(root, "m2"), nested: new NestedRepoCache(work) });
      expect(cached.tree).toBe(walked.tree);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a repository that arrives while the cache is stale", () => {
  function repoWithCommit(dir: string): void {
    mkdirSync(dir, { recursive: true });
    gitIn(dir, ["init", "-q", "."]);
    gitIn(dir, ["config", "user.email", "t@t"]);
    gitIn(dir, ["config", "user.name", "t"]);
    writeFileSync(join(dir, "code.py"), "print(1)");
    gitIn(dir, ["add", "."]);
    gitIn(dir, ["commit", "-q", "-m", "init"]);
  }
  const listed = (gitDir: string, args: string[]): string =>
    execFileSync("git", ["--git-dir=" + gitDir].concat(args), { encoding: "utf8" });

  test("a directory moved in with a repository deeper down puts no gitlink in the snapshot", async () => {
    const root = scratch();
    try {
      const work = join(root, "work");
      const gitDir = join(root, "meta");
      mkdirSync(work, { recursive: true });
      writeFileSync(join(work, "a.txt"), "a");
      const cache = new NestedRepoCache(work);
      await snapshot({ work, gitDir, nested: cache });
      // `mv ~/stuff work/`: the cache is not told, and the repository is two levels down.
      repoWithCommit(join(work, "stuff", "proj"));
      const snap = await snapshot({ work, gitDir, nested: cache });
      expect(listed(gitDir, ["ls-tree", "-r", snap.commit])).not.toContain("160000");
      expect(listed(gitDir, ["ls-tree", "-r", snap.commit])).not.toContain("proj");
      // And not in the index the next snapshot starts from.
      expect(listed(gitDir, ["ls-files", "-s"])).not.toContain("160000");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a repository with no commit does not make the snapshot fail", async () => {
    const root = scratch();
    try {
      const work = join(root, "work");
      const gitDir = join(root, "meta");
      mkdirSync(join(work, "stuff", "fresh"), { recursive: true });
      writeFileSync(join(work, "a.txt"), "a");
      const cache = new NestedRepoCache(work);
      await snapshot({ work, gitDir, nested: cache });
      gitIn(join(work, "stuff", "fresh"), ["init", "-q", "."]);
      writeFileSync(join(work, "stuff", "fresh", "x.txt"), "x");
      const snap = await snapshot({ work, gitDir, nested: cache });
      expect(listed(gitDir, ["ls-tree", "-r", snap.commit])).toContain("a.txt");
      expect(listed(gitDir, ["ls-tree", "-r", snap.commit])).not.toContain("fresh");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a directory that was synced and then became a repository stops being published", async () => {
    const root = scratch();
    try {
      const work = join(root, "work");
      const gitDir = join(root, "meta");
      mkdirSync(join(work, "lib"), { recursive: true });
      writeFileSync(join(work, "lib", "a.js"), "v1");
      writeFileSync(join(work, "top.txt"), "t");
      const first = await snapshot({ work, gitDir });
      expect(listed(gitDir, ["ls-tree", "-r", "--name-only", first.commit])).toContain("lib/a.js");
      gitIn(join(work, "lib"), ["init", "-q", "."]);
      writeFileSync(join(work, "lib", "a.js"), "v2");
      const second = await snapshot({ work, gitDir, base: first.commit });
      expect(listed(gitDir, ["ls-tree", "-r", "--name-only", second.commit])).not.toContain("lib/a.js");
      expect(listed(gitDir, ["ls-tree", "-r", "--name-only", second.commit])).toContain("top.txt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the cache hears about a directory that arrives, and ignores the work tree's own .git", () => {
    const root = scratch();
    try {
      const cache = new NestedRepoCache(root);
      expect(cache.get()).toEqual([]);
      repoWithCommit(join(root, "stuff", "proj"));
      // The files of the work tree's own repository change all the time.
      cache.noteChange("change", ".git/index");
      cache.noteChange("rename", ".git/index.lock");
      cache.noteChange("change", "other/.git/HEAD");
      expect(cache.get()).toEqual([]);
      // A directory that was moved in is a rename of the directory itself.
      cache.noteChange("rename", "stuff");
      expect(cache.get()).toEqual(["stuff/proj"]);
      // A .git entry that appears or goes is the signal, wherever it is.
      mkdirSync(join(root, "x"), { recursive: true });
      gitIn(join(root, "x"), ["init", "-q", "."]);
      cache.noteChange("rename", "x/.git");
      expect(cache.get().sort()).toEqual(["stuff/proj", "x"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("sealing", () => {
  test("round trips exactly", () => {
    const plain = Buffer.from("the workspace contents".repeat(100));
    const sealed = seal(plain);
    expect(Buffer.compare(unseal(sealed.ciphertext, sealed.key), plain)).toBe(0);
    expect(sealed.ciphertext.length).not.toBe(plain.length);
  });

  test("a wrong key does not open it", () => {
    const sealed = seal(Buffer.from("secret"));
    let failed = false;
    try {
      unseal(sealed.ciphertext, Buffer.alloc(32));
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  test("a tampered payload does not open it", () => {
    const sealed = seal(Buffer.from("secret"));
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    let failed = false;
    try {
      unseal(tampered, sealed.key);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  test("payload ids are stable and content addressed", () => {
    expect(payloadId(Buffer.from("a"))).toBe(payloadId(Buffer.from("a")));
    expect(payloadId(Buffer.from("a"))).not.toBe(payloadId(Buffer.from("b")));
    expect(payloadId(Buffer.from("a"))).toHaveLength(64);
  });
});
