import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  EMPTY_TREE,
  applyPack,
  findNestedRepos,
  hasFiles,
  localChanges,
  NestedRepoCache,
  payloadId,
  preserveLocalChange,
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
      // The apply's own index no longer knows the file (as after a switch of
      // role), so only the tree diff names it - and the exclusion holds.
      rmSync(join(r.otherGit, "apply.index"), { force: true });
      await applyPack(r.other, r.otherGit, second.commit, second.pack, ["mine"], r.first.commit);
      expect(existsSync(join(r.other, "mine", "x.txt"))).toBe(true);
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
