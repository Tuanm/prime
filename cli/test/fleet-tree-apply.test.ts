// Writing a snapshot over a work tree by the names that differ from the one before it (N4), not by walking the index.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { applyCommit, changesBetween, foldsCase, gitEnv, ingestPack, MAX_TREE_APPLY, snapshot, workTreeMatchesApply } from "../src/fleet-sync";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

/** Git, run by the test: with a time limit of its own, and never asking a person. */
function gitSync(args: string[], env?: Record<string, string>): string {
  return execFileSync("git", args, { timeout: 30_000, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env } });
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  delete process.env.PRIME_FLEET_TREE_APPLY;
  while (cleanups.length) cleanups.pop()!();
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "fleet-tree-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function put(work: string, rel: string, text: string): void {
  mkdirSync(join(work, rel, ".."), { recursive: true });
  writeFileSync(join(work, rel), text);
}

type Snap = Awaited<ReturnType<typeof snapshot>>;

/** A primary, and one or two replicas of it (each with a store of its own), all at the first snapshot. */
async function fleetOf(files: Record<string, string>, replicas = 1) {
  const root = scratch();
  const work = join(root, "primary");
  const gitDir = join(root, "primary-store");
  mkdirSync(work, { recursive: true });
  for (const [rel, text] of Object.entries(files)) put(work, rel, text);
  const first = await snapshot({ work, gitDir });
  const members = [] as Array<{ work: string; gitDir: string }>;
  for (let i = 0; i < replicas; i++) {
    const member = { work: join(root, "replica" + i), gitDir: join(root, "replica" + i + "-store") };
    mkdirSync(member.work, { recursive: true });
    await ingestPack(member.work, member.gitDir, first.commit, first.pack);
    await applyCommit(member.work, member.gitDir, first.commit, [], null);
    members.push(member);
  }
  let last: Snap = first;
  /** The primary's tree as it is now, taken in by every replica (not applied). */
  const next = async (): Promise<Snap> => {
    const snap = await snapshot({ work, gitDir, base: last.commit, wantFull: false });
    for (const m of members) await ingestPack(m.work, m.gitDir, snap.commit, snap.delta!, { tree: snap.tree });
    return snap;
  };
  const done = (snap: Snap): void => {
    last = snap;
  };
  return { root, work, gitDir, first, members, next, done, get last() { return last; } };
}

/** What the work tree holds, with each file's content or link target and whether it can be run (folders are not the fleet's: git has no empty one). */
function contents(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const rel = relative(dir, full).split("\\").join("/");
      const st = lstatSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isSymbolicLink()) out[rel] = "-> " + readlinkSync(full);
      else out[rel] = readFileSync(full, "utf8") + (process.platform !== "win32" && (st.mode & 0o111) !== 0 ? " (runs)" : "");
    }
  };
  walk(dir);
  return out;
}

/** The tree the apply index holds. */
function indexTree(gitDir: string, work: string): string {
  return gitSync(["--git-dir=" + gitDir, "write-tree"], gitEnv(gitDir, work, join(gitDir, "apply.index"))).trim();
}

/** git's own trace of what a call did, as the list of commands it ran. */
async function traced<T>(fn: () => Promise<T>): Promise<{ value: T; commands: string[] }> {
  const trace = join(scratch(), "trace");
  const before = process.env.GIT_TRACE;
  process.env.GIT_TRACE = trace;
  try {
    const value = await fn();
    const text = existsSync(trace) ? readFileSync(trace, "utf8") : "";
    return { value, commands: [...text.matchAll(/built-in: git (.*)$/gm)].map((m) => m[1]!) };
  } finally {
    if (before === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = before;
  }
}

const readTrees = (commands: string[]): string[] => commands.filter((c) => /^read-tree .*--reset/.test(c));

describe("an apply writes the names that differ", () => {
  test("one edit is written by name: read-tree does not walk the tree, and the work tree and the index are the new snapshot", async () => {
    const f = await fleetOf({ "a.txt": "alpha\n", "src/b.ts": "b1\n", "src/deep/c.ts": "c1\n", "docs/r.md": "r\n" });
    const m = f.members[0]!;
    put(f.work, "src/deep/c.ts", "c2\n");
    const second = await f.next();
    const done = await traced(() => applyCommit(m.work, m.gitDir, second.commit, [], f.first.commit));
    expect(readTrees(done.commands)).toEqual([]);
    expect(done.commands.some((c) => /^checkout-index/.test(c))).toBe(true);
    expect(contents(m.work)).toEqual(contents(f.work));
    expect(indexTree(m.gitDir, m.work)).toBe(second.tree);
  });

  test("the kill switch brings back the walk of read-tree, with the same result", async () => {
    const f = await fleetOf({ "a.txt": "alpha\n", "src/b.ts": "b1\n" });
    const m = f.members[0]!;
    put(f.work, "src/b.ts", "b2\n");
    const second = await f.next();
    process.env.PRIME_FLEET_TREE_APPLY = "0";
    const done = await traced(() => applyCommit(m.work, m.gitDir, second.commit, [], f.first.commit));
    expect(readTrees(done.commands).length).toBe(1);
    expect(contents(m.work)).toEqual(contents(f.work));
  });

  test("the next apply finds the index as this one left it, and the work tree is as it was written", async () => {
    const f = await fleetOf({ "a.txt": "alpha\n", "src/b.ts": "b1\n" });
    const m = f.members[0]!;
    put(f.work, "src/b.ts", "b2\n");
    const second = await f.next();
    await applyCommit(m.work, m.gitDir, second.commit, [], f.first.commit);
    expect(await workTreeMatchesApply(m.work, m.gitDir, second.commit, [])).toBe(true);
    f.done(second);
    put(f.work, "a.txt", "alpha 2\n");
    const third = await f.next();
    const done = await traced(() => applyCommit(m.work, m.gitDir, third.commit, [], second.commit, { clean: true }));
    // The index is trusted for the snapshot before: not read again from it, and nothing is looked at but what changed.
    expect(done.commands.filter((c) => /^read-tree/.test(c))).toEqual([]);
    expect(done.commands.filter((c) => /^(update-index .*--refresh|diff-files)/.test(c))).toEqual([]);
    expect(contents(m.work)).toEqual(contents(f.work));
  });

  test("what the fleet never wrote survives: a stray file, an ignored one, a nested repository", async () => {
    const f = await fleetOf({ "a.txt": "alpha\n", "gone.txt": "bye\n", ".gitignore": ".env\nbuild/\n" });
    const m = f.members[0]!;
    put(m.work, ".env", "SECRET=1");
    put(m.work, "build/out.js", "x");
    put(m.work, "notes.md", "mine");
    mkdirSync(join(m.work, "proj"), { recursive: true });
    gitSync(["-C", join(m.work, "proj"), "init", "-q", "."]);
    put(m.work, "proj/own.txt", "theirs");
    rmSync(join(f.work, "gone.txt"));
    put(f.work, "a.txt", "alpha 2\n");
    put(f.work, "new/file.txt", "n\n");
    const second = await f.next();
    await applyCommit(m.work, m.gitDir, second.commit, ["proj"], f.first.commit);
    const held = contents(m.work);
    expect(held[".env"]).toBe("SECRET=1");
    expect(held["build/out.js"]).toBe("x");
    expect(held["notes.md"]).toBe("mine");
    expect(held["proj/own.txt"]).toBe("theirs");
    expect(held["a.txt"]).toBe("alpha 2\n");
    expect(held["new/file.txt"]).toBe("n\n");
    expect(held["gone.txt"]).toBeUndefined();
  });

  test("a file the member has moved aside, or deleted, is written again when the apply is not told the work tree is clean", async () => {
    const f = await fleetOf({ "a.txt": "alpha\n", "b.txt": "beta\n" });
    const m = f.members[0]!;
    rmSync(join(m.work, "a.txt"));
    writeFileSync(join(m.work, "b.txt"), "beta, edited here\n");
    put(f.work, "c.txt", "gamma\n");
    const second = await f.next();
    await applyCommit(m.work, m.gitDir, second.commit, [], f.first.commit);
    expect(readFileSync(join(m.work, "a.txt"), "utf8")).toBe("alpha\n");
    expect(readFileSync(join(m.work, "b.txt"), "utf8")).toBe("beta\n");
    expect(readFileSync(join(m.work, "c.txt"), "utf8")).toBe("gamma\n");
  });

  test("a change in the mode of a file alone is applied (the file can be run, or can no longer)", async () => {
    if (process.platform === "win32") return;
    const f = await fleetOf({ "run.sh": "echo\n", "plain.txt": "p\n" });
    const m = f.members[0]!;
    chmodSync(join(f.work, "run.sh"), 0o755);
    const second = await f.next();
    await applyCommit(m.work, m.gitDir, second.commit, [], f.first.commit);
    expect(lstatSync(join(m.work, "run.sh")).mode & 0o111).not.toBe(0);
    f.done(second);
    chmodSync(join(f.work, "run.sh"), 0o644);
    const third = await f.next();
    await applyCommit(m.work, m.gitDir, third.commit, [], second.commit);
    expect(lstatSync(join(m.work, "run.sh")).mode & 0o111).toBe(0);
  });

  test("a folder that becomes a file, and a file that becomes a folder, in one apply", async () => {
    const f = await fleetOf({ "was-dir/x.txt": "x\n", "was-dir/y/z.txt": "z\n", "was-file": "f\n", "keep.txt": "k\n" });
    const m = f.members[0]!;
    rmSync(join(f.work, "was-dir"), { recursive: true });
    put(f.work, "was-dir", "now a file\n");
    rmSync(join(f.work, "was-file"));
    put(f.work, "was-file/inner/deep.txt", "deep\n");
    const second = await f.next();
    await applyCommit(m.work, m.gitDir, second.commit, [], f.first.commit);
    expect(contents(m.work)).toEqual(contents(f.work));
    expect(indexTree(m.gitDir, m.work)).toBe(second.tree);
  });

  test("a folder of the member's own where the fleet now has a file is not taken away by the fleet's file; read-tree decides", async () => {
    const f = await fleetOf({ "thing/a.txt": "a\n", "keep.txt": "k\n" });
    const m = f.members[0]!;
    // The fleet turns the folder into a file; the member has put a file of its own in the folder.
    put(m.work, "thing/mine.txt", "mine");
    rmSync(join(f.work, "thing"), { recursive: true });
    put(f.work, "thing", "a file now\n");
    const second = await f.next();
    await applyCommit(m.work, m.gitDir, second.commit, [], f.first.commit);
    // Whatever read-tree does here is what is done: the fleet's file is there.
    expect(lstatSync(join(m.work, "thing")).isFile()).toBe(true);
    expect(readFileSync(join(m.work, "thing"), "utf8")).toBe("a file now\n");
    expect(indexTree(m.gitDir, m.work)).toBe(second.tree);
  });

  test("a folder that the member made into a link is not written through, and nothing outside the work tree changes", async () => {
    if (process.platform === "win32") return;
    const f = await fleetOf({ "dir/a.txt": "a\n", "dir/b.txt": "b\n", "keep.txt": "k\n" });
    const m = f.members[0]!;
    const outside = scratch();
    put(outside, "a.txt", "outside, precious");
    // The member's `dir` is a link to a folder elsewhere.
    rmSync(join(m.work, "dir"), { recursive: true });
    symlinkSync(outside, join(m.work, "dir"));
    rmSync(join(f.work, "dir", "b.txt"));
    put(f.work, "dir/a.txt", "a2\n");
    put(f.work, "dir/new.txt", "new\n");
    const second = await f.next();
    await applyCommit(m.work, m.gitDir, second.commit, [], f.first.commit).catch(() => undefined);
    expect(readFileSync(join(outside, "a.txt"), "utf8")).toBe("outside, precious");
    expect(existsSync(join(outside, "new.txt"))).toBe(false);
    expect(existsSync(join(outside, "b.txt"))).toBe(false);
  });

  test("a file that goes to a link and a link that goes to a file", async () => {
    if (process.platform === "win32") return;
    const f = await fleetOf({ "a.txt": "alpha\n", "l": "to be a link\n", "target.txt": "t\n" });
    const m = f.members[0]!;
    rmSync(join(f.work, "l"));
    symlinkSync("target.txt", join(f.work, "l"));
    const second = await f.next();
    await applyCommit(m.work, m.gitDir, second.commit, [], f.first.commit);
    expect(readlinkSync(join(m.work, "l"))).toBe("target.txt");
    f.done(second);
    rmSync(join(f.work, "l"));
    put(f.work, "l", "a file again\n");
    const third = await f.next();
    await applyCommit(m.work, m.gitDir, third.commit, [], second.commit);
    expect(lstatSync(join(m.work, "l")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(m.work, "l"), "utf8")).toBe("a file again\n");
    expect(indexTree(m.gitDir, m.work)).toBe(third.tree);
  });

  test("a name that changes only in case, on a file system that folds case", async () => {
    const f = await fleetOf({ "Readme.md": "r\n", "other.txt": "o\n" });
    const m = f.members[0]!;
    if (!foldsCase(m.work)) return;
    rmSync(join(f.work, "Readme.md"));
    put(f.work, "README.md", "r\n");
    const second = await f.next();
    await applyCommit(m.work, m.gitDir, second.commit, [], f.first.commit);
    expect(readdirSync(m.work).sort()).toEqual(["README.md", "other.txt"]);
    expect(indexTree(m.gitDir, m.work)).toBe(second.tree);
  });

  test("an apply that is stopped part way is made good by the next", async () => {
    if (process.platform === "win32" || (process.getuid?.() ?? 1) === 0) return;
    const f = await fleetOf({ "a/one.txt": "1\n", "b/two.txt": "2\n", "c/three.txt": "3\n" });
    const m = f.members[0]!;
    put(f.work, "a/one.txt", "1 new\n");
    put(f.work, "b/two.txt", "2 new\n");
    put(f.work, "c/three.txt", "3 new\n");
    const second = await f.next();
    // One folder cannot be written: the apply fails, with the others written or not.
    chmodSync(join(m.work, "b"), 0o555);
    try {
      await expect(applyCommit(m.work, m.gitDir, second.commit, [], f.first.commit)).rejects.toThrow();
    } finally {
      chmodSync(join(m.work, "b"), 0o755);
    }
    // The index was changed before the work tree was: the sidecar must not say it is still the snapshot before.
    expect(existsSync(join(m.gitDir, "apply.commit"))).toBe(false);
    expect(indexTree(m.gitDir, m.work)).not.toBe(f.first.tree);
    // The same apply again, as the agent does when it comes back: the index is not trusted, so it is made again from the
    // snapshot before (and the files that are not as that snapshot wrote them are looked at), then the change is written.
    const again = await traced(() => applyCommit(m.work, m.gitDir, second.commit, [], f.first.commit));
    expect(again.commands.some((c) => /^read-tree [0-9a-f]{40,64}$/.test(c))).toBe(true);
    expect(contents(m.work)).toEqual(contents(f.work));
    expect(indexTree(m.gitDir, m.work)).toBe(second.tree);
  });

  test("a change to more names than the limit is left to read-tree", async () => {
    const f = await fleetOf({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
    const m = f.members[0]!;
    put(f.work, "a.txt", "a2\n");
    put(f.work, "b.txt", "b2\n");
    put(f.work, "c.txt", "c2\n");
    const second = await f.next();
    const env = gitEnv(m.gitDir, m.work, join(m.gitDir, "apply.index"));
    expect((await changesBetween(m.gitDir, env, f.first.commit, second.commit))!.map((c) => c.path)).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(await changesBetween(m.gitDir, env, f.first.commit, second.commit, 2)).toBeNull();
    expect(MAX_TREE_APPLY).toBe(20_000);
  });

  test("a name with a space, a quote, a newline and non-ASCII letters is written as it is", async () => {
    const names = ["with space.txt", "naïve café.txt", "日本語.txt", "100%.txt", "a'b.txt"];
    // (a quote, a newline and a backslash are not allowed in a name on Windows)
    if (process.platform !== "win32") names.push("quo\"te.txt", "new\nline.txt");
    const f = await fleetOf({ "a.txt": "a\n" });
    const m = f.members[0]!;
    for (const n of names) put(f.work, "odd/" + n, "x " + n + "\n");
    const second = await f.next();
    await applyCommit(m.work, m.gitDir, second.commit, [], f.first.commit);
    expect(contents(m.work)).toEqual(contents(f.work));
    expect(indexTree(m.gitDir, m.work)).toBe(second.tree);
  });
});

describe("a folder the fleet leaves alone, then does not", () => {
  /** The replica's two folders `proj` and `other` are repositories of its own; the fleet has files in both. */
  async function dropped(mode: "tree" | "walk") {
    if (mode === "walk") process.env.PRIME_FLEET_TREE_APPLY = "0";
    else delete process.env.PRIME_FLEET_TREE_APPLY;
    const f = await fleetOf({ "a.txt": "1", "proj/x.txt": "fleet-x", "other/y.txt": "fleet-y" }, 0);
    const root = scratch();
    const rw = join(root, "r");
    const rg = join(root, "rg");
    for (const d of ["proj", "other"]) {
      mkdirSync(join(rw, d), { recursive: true });
      gitSync(["-C", join(rw, d), "init", "-q", "."]);
    }
    await ingestPack(rw, rg, f.first.commit, f.first.pack);
    await applyCommit(rw, rg, f.first.commit, ["proj", "other"], null);
    put(f.work, "proj/x.txt", "fleet-x2");
    const s15 = await snapshot({ work: f.work, gitDir: f.gitDir, base: f.first.commit, wantFull: false });
    await ingestPack(rw, rg, s15.commit, s15.delta!, { tree: s15.tree });
    await applyCommit(rw, rg, s15.commit, ["proj", "other"], f.first.commit);
    const mid = existsSync(join(rw, "proj/x.txt")) ? readFileSync(join(rw, "proj/x.txt"), "utf8") : null;
    // The member drops the repository of proj: it is the fleet's again; other stays a repository of the member's.
    rmSync(join(rw, "proj/.git"), { recursive: true, force: true });
    put(f.work, "a.txt", "2");
    const s2 = await snapshot({ work: f.work, gitDir: f.gitDir, base: s15.commit, wantFull: false });
    await ingestPack(rw, rg, s2.commit, s2.delta!, { tree: s2.tree });
    await applyCommit(rw, rg, s2.commit, ["other"], s15.commit);
    const env = gitEnv(rg, rw, join(rg, "apply.index"));
    const idx = gitSync(["--git-dir=" + rg, "ls-files"], env).trim().split("\n");
    const held = contents(rw);
    return { mid, a: held["a.txt"], projX: held["proj/x.txt"] ?? null, otherY: held["other/y.txt"] ?? null, idx, tree: indexTree(rg, rw), want: s2.tree };
  }

  test("the files of the fleet are not written into a repository of the member's, by either way of writing", async () => {
    const tree = await dropped("tree");
    const walk = await dropped("walk");
    expect(tree.mid).toBeNull();
    expect(walk.mid).toBeNull();
    expect(tree.otherY).toBeNull();
    expect(walk.otherY).toBeNull();
  });

  test("a folder that stops being left alone gets the fleet's files, whichever way the apply goes, and the two ways agree", async () => {
    const tree = await dropped("tree");
    const walk = await dropped("walk");
    expect(tree.projX).toBe("fleet-x2");
    expect(tree.a).toBe("2");
    expect(tree.idx).toEqual(["a.txt", "proj/x.txt"]);
    expect(tree).toEqual(walk);
  });

  test("a sidecar that names the snapshot before, over an index that is not that snapshot, is not trusted", async () => {
    const f = await fleetOf({ "a.txt": "1", "b.txt": "b", "dir/c.txt": "c" });
    const m = f.members[0]!;
    put(f.work, "a.txt", "2");
    const second = await f.next();
    // The index lost an entry (as after an apply that was stopped part way): the sidecar still says it is the first snapshot.
    const env = gitEnv(m.gitDir, m.work, join(m.gitDir, "apply.index"));
    gitSync(["--git-dir=" + m.gitDir, "update-index", "--force-remove", "dir/c.txt"], env);
    expect(readFileSync(join(m.gitDir, "apply.commit"), "utf8")).toContain(f.first.commit);
    rmSync(join(m.work, "dir"), { recursive: true });
    await applyCommit(m.work, m.gitDir, second.commit, [], f.first.commit);
    expect(readFileSync(join(m.work, "dir/c.txt"), "utf8")).toBe("c");
    expect(indexTree(m.gitDir, m.work)).toBe(second.tree);
  });

  test("on a file system that folds case, a folder left alone is left alone however the snapshot spells it", async () => {
    const f = await fleetOf({ "a.txt": "1", "proj/x.txt": "x", "dir/c.txt": "c" }, 0);
    const root = scratch();
    const rw = join(root, "r");
    const rg = join(root, "rg");
    // The work tree spells the folder `Proj` (a repository of the member's), the snapshot `proj`.
    mkdirSync(join(rw, "Proj"), { recursive: true });
    if (!foldsCase(rw)) return;
    await ingestPack(rw, rg, f.first.commit, f.first.pack);
    await applyCommit(rw, rg, f.first.commit, ["Proj"], null);
    expect(existsSync(join(rw, "Proj/x.txt"))).toBe(false);
    put(f.work, "dir/c.txt", "c2");
    const second = await snapshot({ work: f.work, gitDir: f.gitDir, base: f.first.commit, wantFull: false });
    await ingestPack(rw, rg, second.commit, second.delta!, { tree: second.tree });
    await applyCommit(rw, rg, second.commit, ["Proj"], f.first.commit);
    expect(readFileSync(join(rw, "dir/c.txt"), "utf8")).toBe("c2");
    expect(existsSync(join(rw, "Proj/x.txt"))).toBe(false);
    expect(gitSync(["--git-dir=" + rg, "ls-files"], gitEnv(rg, rw, join(rg, "apply.index"))).trim().split("\n")).toEqual(["a.txt", "dir/c.txt"]);
  });

  test("with a folder left alone the result is still checked, and the index is the snapshot without it", async () => {
    const f = await fleetOf({ "a.txt": "1", "proj/x.txt": "x", "dir/c.txt": "c" });
    const m = f.members[0]!;
    mkdirSync(join(m.work, "proj"), { recursive: true });
    put(f.work, "dir/c.txt", "c2");
    const second = await f.next();
    const done = await traced(() => applyCommit(m.work, m.gitDir, second.commit, ["proj"], f.first.commit));
    expect(readTrees(done.commands)).toEqual([]);
    expect(done.commands.some((c) => /^write-tree/.test(c))).toBe(true);
    expect(readFileSync(join(m.work, "dir/c.txt"), "utf8")).toBe("c2");
    expect(indexTree(m.gitDir, m.work)).not.toBe(second.tree);
    expect(gitSync(["--git-dir=" + m.gitDir, "ls-files"], env0(m)).trim().split("\n")).toEqual(["a.txt", "dir/c.txt"]);
  });
});

function env0(m: { work: string; gitDir: string }): Record<string, string> {
  return gitEnv(m.gitDir, m.work, join(m.gitDir, "apply.index"));
}

describe("the result is what read-tree gives, over many changes", () => {
  /** A deterministic stream of numbers: the same changes on every run. */
  function stream(seed: number): () => number {
    let x = seed >>> 0;
    return () => {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      return x / 2 ** 32;
    };
  }

  const POOL = ["a", "b", "c", "d", "e", "f", "g"];
  function change(work: string, rand: () => number): void {
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const name = (): string => pick(POOL);
    const depth = (): string => [name(), name(), name()].slice(0, 1 + Math.floor(rand() * 3)).join("/");
    const existing = (): string[] => Object.keys(contents(work)).filter((k) => !k.endsWith("/"));
    for (let i = 0; i < 1 + Math.floor(rand() * 5); i++) {
      const files = existing();
      const kind = Math.floor(rand() * 8);
      try {
        if (kind <= 1 || files.length === 0) {
          const where = depth() + ".txt";
          if (!existsSync(join(work, where)) || lstatSync(join(work, where)).isFile()) put(work, where, "new " + rand() + "\n");
        } else if (kind === 2) {
          put(work, pick(files), "edit " + rand() + "\n");
        } else if (kind === 3) {
          rmSync(join(work, pick(files)), { force: true });
        } else if (kind === 4 && process.platform !== "win32") {
          const f = pick(files);
          if (lstatSync(join(work, f)).isFile()) chmodSync(join(work, f), (lstatSync(join(work, f)).mode & 0o111) !== 0 ? 0o644 : 0o755);
        } else if (kind === 5) {
          // a file becomes a folder
          const f = pick(files);
          rmSync(join(work, f), { force: true });
          put(work, f + "/inner.txt", "inner " + rand() + "\n");
        } else if (kind === 6) {
          // a folder becomes a file
          const dirs = [...new Set(files.filter((x) => x.includes("/")).map((x) => x.slice(0, x.indexOf("/"))))];
          if (dirs.length > 0) {
            const d = pick(dirs);
            rmSync(join(work, d), { recursive: true, force: true });
            put(work, d, "was a folder " + rand() + "\n");
          }
        } else if (kind === 7 && process.platform !== "win32") {
          const f = pick(files);
          rmSync(join(work, f), { force: true });
          symlinkSync("elsewhere-" + name(), join(work, f));
        }
      } catch {
        // a change that cannot be made on this tree (a name that is already a folder) is another change
      }
    }
  }

  // (Each round is a few git runs per member, and a Windows runner is slow at those: fewer there, as the job has a time limit.)
  const rounds = process.platform === "win32" ? 4 : 8;
  for (const seed of process.platform === "win32" ? [1, 2] : [1, 2, 3, 4]) {
    test("seed " + seed + ": rounds of changes, applied by name and by read-tree, leave the same work tree and index", async () => {
      const rand = stream(seed * 7919);
      const f = await fleetOf({ "a/b.txt": "ab\n", "c.txt": "c\n", "d/e/f.txt": "def\n", "g/g.txt": "gg\n" }, 2);
      const [byName, byWalk] = f.members as [{ work: string; gitDir: string }, { work: string; gitDir: string }];
      let before = f.first;
      for (let round = 0; round < rounds; round++) {
        change(f.work, rand);
        const snap = await f.next();
        delete process.env.PRIME_FLEET_TREE_APPLY;
        await applyCommit(byName.work, byName.gitDir, snap.commit, [], before.commit);
        process.env.PRIME_FLEET_TREE_APPLY = "0";
        await applyCommit(byWalk.work, byWalk.gitDir, snap.commit, [], before.commit);
        delete process.env.PRIME_FLEET_TREE_APPLY;
        expect(contents(byName.work)).toEqual(contents(byWalk.work));
        expect(contents(byName.work)).toEqual(contents(f.work));
        expect(indexTree(byName.gitDir, byName.work)).toBe(snap.tree);
        expect(indexTree(byWalk.gitDir, byWalk.work)).toBe(snap.tree);
        f.done(snap);
        before = snap;
      }
    });
  }
});
