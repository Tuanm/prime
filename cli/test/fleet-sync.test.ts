import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  EMPTY_TREE,
  applyPack,
  findNestedRepos,
  hasFiles,
  payloadId,
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
      await applyPack(other, otherGit, second.commit, second.pack);
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
