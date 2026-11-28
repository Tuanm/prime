// Staging what the watcher named instead of walking the work tree (N2), and a replica that looks at its files' times
// against what the last apply wrote instead of taking a snapshot of them (N3).
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { closeSync, chmodSync, lstatSync, openSync, writeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCommit, ingestPack, settle, snapshot, stampTree, workTreeMatchesApply } from "../src/fleet-sync";
import { MAX_CHANGED_PATHS, noteChangedPath, takeChangedPaths } from "../src/fleet-daemon";
import { gitEnv, MAX_NAMED_BYTES, MAX_STAGED_PATHS, worthNaming } from "../src/fleet-sync";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

/** Git, run by the test: with a time limit of its own, and never asking a person. */
function gitSync(args: string[], options: { encoding: "utf8" }): string;
function gitSync(args: string[]): Buffer;
function gitSync(args: string[], options?: { encoding: "utf8" }): string | Buffer {
  return execFileSync("git", args, { timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, ...options });
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "fleet-incr-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function put(work: string, rel: string, text: string): void {
  mkdirSync(join(work, rel, ".."), { recursive: true });
  writeFileSync(join(work, rel), text);
}

/** A work tree with a few files, and a store that has taken a snapshot of it in full. */
async function member(extra: Record<string, string> = {}) {
  const root = scratch();
  const work = join(root, "work");
  const gitDir = join(root, "store");
  mkdirSync(work, { recursive: true });
  put(work, ".gitignore", "*.log\nbuild/\n");
  put(work, "a.txt", "alpha\n");
  put(work, "src/b.ts", "export const b = 1;\n");
  put(work, "src/deep/c.ts", "export const c = 1;\n");
  put(work, "docs/readme.md", "# read me\n");
  for (const [rel, text] of Object.entries(extra)) put(work, rel, text);
  const first = await snapshot({ work, gitDir, treeOnly: true });
  return { root, work, gitDir, first };
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

const wholeAdds = (commands: string[]): number => commands.filter((c) => /^add -A -- \./.test(c)).length;
const namedAdds = (commands: string[]): number => commands.filter((c) => /^add -A --pathspec-from-file/.test(c)).length;

/** The tree the work tree has now, taken in full, in the same store: what a snapshot by name has to equal. */
async function wholeTree(m: { work: string; gitDir: string }): Promise<string> {
  return (await snapshot({ work: m.work, gitDir: m.gitDir, treeOnly: true })).tree;
}

describe("a snapshot of the paths that changed", () => {
  const scenarios: Array<{ name: string; paths: string[]; change: (work: string) => void; posix?: true }> = [
    { name: "a file edited", paths: ["a.txt"], change: (w) => put(w, "a.txt", "alpha, edited\n") },
    { name: "a file made, in a directory that is new", paths: ["new/dir/d.txt"], change: (w) => put(w, "new/dir/d.txt", "d\n") },
    { name: "a file deleted", paths: ["src/b.ts"], change: (w) => unlinkSync(join(w, "src/b.ts")) },
    { name: "a directory deleted with what is in it", paths: ["src"], change: (w) => rmSync(join(w, "src"), { recursive: true }) },
    { name: "a file renamed (both names are told)", paths: ["a.txt", "z.txt"], change: (w) => renameSync(join(w, "a.txt"), join(w, "z.txt")) },
    { name: "a directory renamed (both names are told)", paths: ["src", "lib"], change: (w) => renameSync(join(w, "src"), join(w, "lib")) },
    { name: "a directory made a file", paths: ["docs"], change: (w) => (rmSync(join(w, "docs"), { recursive: true }), put(w, "docs", "now a file\n")) },
    { name: "a file made a directory, and the path inside it told", paths: ["a.txt", "a.txt/inner.txt"], change: (w) => (unlinkSync(join(w, "a.txt")), put(w, "a.txt/inner.txt", "i\n")) },
    { name: "a file's mode changed", paths: ["a.txt"], change: (w) => chmodSync(join(w, "a.txt"), 0o755), posix: true },
    { name: "a symbolic link made", paths: ["link"], change: (w) => symlinkSync("a.txt", join(w, "link")), posix: true },
    { name: "names that are pathspecs made", paths: [":(top)x", ":!y", "*.q", "a b.txt", "dir/[z].txt"], change: (w) => ["x", ":!y", "*.q", "a b.txt", "dir/[z].txt"].forEach((n) => put(w, n === "x" ? ":(top)x" : n, n + "\n")), posix: true },
    { name: "an ignored file told by name, as the watcher does not but may", paths: ["debug.log", "a.txt"], change: (w) => (put(w, "debug.log", "noise\n"), put(w, "a.txt", "edited\n")) },
    { name: "a file under an ignored directory made", paths: ["build/out.js"], change: (w) => put(w, "build/out.js", "x\n") },
    { name: "a name that is not ASCII", paths: ["naïve/ünï.txt"], change: (w) => put(w, "naïve/ünï.txt", "u\n") },
    { name: "a path that is not there and never was", paths: ["ghost/none.txt", "a.txt"], change: (w) => put(w, "a.txt", "edited\n") },
    { name: "nothing told, nothing changed", paths: [], change: () => undefined },
  ];

  for (const sc of scenarios) {
    test("comes out as the tree of the whole work tree: " + sc.name, async () => {
      if (sc.posix && process.platform === "win32") return;
      const m = await member();
      sc.change(m.work);
      const named = await snapshot({ work: m.work, gitDir: m.gitDir, treeOnly: true, paths: sc.paths });
      expect(named.tree).toBe(await wholeTree(m));
    });
  }

  test("a file with a name that is not ASCII is taken out when it goes, by the name the watcher said, whichever way it is spelled", async () => {
    const decomposed = "cafe\u0301.txt"; // as a file system may hand it back
    const m = await member({ [decomposed]: "x\n", "plain.txt": "y\n" });
    const tree = async (t: string): Promise<string> => gitSync(["--git-dir=" + m.gitDir, "ls-tree", "-r", "--name-only", "-z", t], { encoding: "utf8" });
    expect((await tree(m.first.tree)).normalize("NFC")).toContain("caf\u00e9.txt");
    unlinkSync(join(m.work, decomposed));
    const named = await snapshot({ work: m.work, gitDir: m.gitDir, treeOnly: true, paths: [decomposed] });
    expect(await tree(named.tree)).not.toContain("caf");
    expect(named.tree).toBe(await wholeTree(m));
  });

  test("does not walk the work tree: the paths are staged by name, and nothing is staged when none changed", async () => {
    const m = await member();
    put(m.work, "a.txt", "edited\n");
    const one = await traced(() => snapshot({ work: m.work, gitDir: m.gitDir, treeOnly: true, paths: ["a.txt"] }));
    expect(namedAdds(one.commands)).toBe(1);
    expect(wholeAdds(one.commands)).toBe(0);
    const none = await traced(() => snapshot({ work: m.work, gitDir: m.gitDir, treeOnly: true, paths: [] }));
    expect(namedAdds(none.commands)).toBe(0);
    expect(wholeAdds(none.commands)).toBe(0);
    expect(none.value.tree).toBe(one.value.tree);
    // Without paths the work tree is staged whole, as ever.
    const whole = await traced(() => snapshot({ work: m.work, gitDir: m.gitDir, treeOnly: true }));
    expect(wholeAdds(whole.commands)).toBe(1);
  });

  test("falls back to staging the whole tree when git will not take a path by name, and is right", async () => {
    const m = await member();
    put(m.work, "debug.log", "ignored\n"); // git refuses to add an ignored path by name
    put(m.work, "a.txt", "edited\n");
    const r = await traced(() => snapshot({ work: m.work, gitDir: m.gitDir, treeOnly: true, paths: ["debug.log", "a.txt"] }));
    expect(wholeAdds(r.commands)).toBe(1);
    expect(r.value.tree).toBe(await wholeTree(m));
  });

  test("leaves a nested repository alone, and a path inside one is not staged", async () => {
    const m = await member();
    const nested = join(m.work, "vendor", "lib");
    mkdirSync(nested, { recursive: true });
    gitSync(["init", "-q", nested]);
    put(m.work, "vendor/lib/inner.txt", "inside\n");
    const named = await snapshot({ work: m.work, gitDir: m.gitDir, treeOnly: true, paths: ["vendor/lib/inner.txt", "vendor/lib", "a.txt"], exclude: ["vendor/lib"] });
    expect(named.tree).toBe(await wholeTree({ work: m.work, gitDir: m.gitDir }).catch(() => named.tree));
    const listing = gitSync(["--git-dir=" + m.gitDir, "ls-tree", "-r", "--name-only", named.tree], { encoding: "utf8" });
    expect(listing).not.toContain("vendor");
  });

  test("a nested repository that became a plain folder (its .git removed) is in the tree when its folder is named", async () => {
    const m = await member();
    const sub = join(m.work, "sub");
    mkdirSync(sub, { recursive: true });
    gitSync(["init", "-q", sub]);
    put(m.work, "sub/f1.txt", "inside\n");
    const nested = new (await import("../src/fleet-sync")).NestedRepoCache(m.work);
    const within = await snapshot({ work: m.work, gitDir: m.gitDir, treeOnly: true, nested });
    expect(gitSync(["--git-dir=" + m.gitDir, "ls-tree", "-r", "--name-only", within.tree], { encoding: "utf8" })).not.toContain("sub/f1.txt");
    rmSync(join(sub, ".git"), { recursive: true, force: true });
    nested.noteChange("rename", "sub/.git");
    const loop: { changed?: Set<string>; changedAll?: boolean } = {};
    noteChangedPath(loop, "sub/.git");
    const named = await snapshot({ work: m.work, gitDir: m.gitDir, treeOnly: true, nested, paths: [...loop.changed!] });
    expect(gitSync(["--git-dir=" + m.gitDir, "ls-tree", "-r", "--name-only", named.tree], { encoding: "utf8" })).toContain("sub/f1.txt");
    expect(named.tree).toBe(await wholeTree(m));
  });

  test("more paths than are worth naming are not named: the work tree is staged whole", async () => {
    const m = await member();
    put(m.work, "a.txt", "edited\n");
    const many = Array.from({ length: MAX_STAGED_PATHS + 1 }, (_, i) => "nothing/" + i);
    const r = await traced(() => snapshot({ work: m.work, gitDir: m.gitDir, treeOnly: true, paths: many }));
    expect(wholeAdds(r.commands)).toBe(1);
    expect(r.value.tree).toBe(await wholeTree(m));
  });

  test("a thousand paths are not named: the whole tree is staged (naming costs paths times files)", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) files["bulk/f" + i + ".txt"] = "v1 " + i;
    const m = await member(files);
    for (let i = 0; i < 1000; i++) put(m.work, "bulk/f" + i + ".txt", "v2 " + i);
    const r = await traced(() => snapshot({ work: m.work, gitDir: m.gitDir, treeOnly: true, paths: Object.keys(files) }));
    expect(wholeAdds(r.commands)).toBe(1);
    expect(namedAdds(r.commands)).toBe(0);
    expect(r.value.tree).toBe(await wholeTree(m));
  });

  test("names that are few but long are not named either, in the snapshot and in the wait", async () => {
    // Under 256 names, each about 100 characters: a path a Windows work tree can hold, 26 KB of them in all.
    const dir = "d".repeat(40);
    const names = Array.from({ length: MAX_STAGED_PATHS }, (_, i) => dir + "/" + "n".repeat(55) + String(i).padStart(3, "0"));
    expect(names.length).toBeLessThanOrEqual(MAX_STAGED_PATHS);
    expect(worthNaming(names)).toBe(false);
    expect(worthNaming(["a.txt", "src/b.ts"])).toBe(true);
    expect(worthNaming(Array.from({ length: MAX_STAGED_PATHS }, (_, i) => "f" + i))).toBe(true);
    expect(worthNaming(Array.from({ length: MAX_STAGED_PATHS + 1 }, (_, i) => "f" + i))).toBe(false);
    expect(names.join("").length).toBeGreaterThan(MAX_NAMED_BYTES);
    const m = await member();
    for (const n of names.slice(0, 5)) put(m.work, n, "x\n");
    put(m.work, "a.txt", "edited\n");
    const r = await traced(() => snapshot({ work: m.work, gitDir: m.gitDir, treeOnly: true, paths: names }));
    expect(wholeAdds(r.commands)).toBe(1);
    expect(r.value.tree).toBe(await wholeTree(m));
    // The wait: all of the tree is looked at (a stamp is still taken: it does not fall back to a walk of ignored folders).
    const seen: string[] = [];
    const stamp = await stampTree(m.work, m.gitDir, [], (p) => (seen.push(p), lstatSync(p)), names);
    expect(stamp).not.toBeNull();
    expect(seen.some((p) => p.endsWith("a.txt"))).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(5);
  });

  test("the git of the store does not start a file-system monitor or trust a cache of untracked files, whatever the user's configuration says", async () => {
    const m = await member();
    const env = gitEnv(m.gitDir, m.work, join(m.gitDir, "snapshot.index"));
    expect(env.GIT_CONFIG_COUNT).toBeDefined();
    const asked = (key: string): string => execFileSync("git", ["config", "--get", key], { env: { ...env, GIT_CONFIG_GLOBAL: join(m.root, "global") }, encoding: "utf8", timeout: 30_000 }).trim();
    writeFileSync(join(m.root, "global"), "[core]\n\tfsmonitor = true\n\tuntrackedCache = true\n");
    expect(asked("core.fsmonitor")).toBe("false");
    expect(asked("core.untrackedCache")).toBe("false");
    // Added to what the environment already says.
    const before = process.env.GIT_CONFIG_COUNT;
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.abbrev";
    process.env.GIT_CONFIG_VALUE_0 = "9";
    try {
      const both = gitEnv(m.gitDir, m.work, "x");
      expect(both.GIT_CONFIG_COUNT).toBe("3");
      expect(both.GIT_CONFIG_KEY_0).toBe("core.abbrev");
      expect(both.GIT_CONFIG_KEY_1).toBe("core.fsmonitor");
    } finally {
      if (before === undefined) delete process.env.GIT_CONFIG_COUNT;
      else process.env.GIT_CONFIG_COUNT = before;
      delete process.env.GIT_CONFIG_KEY_0;
      delete process.env.GIT_CONFIG_VALUE_0;
    }
  });

  test("a change that was not told is not in it, and the next whole staging has it (what the backstop is for)", async () => {
    const m = await member();
    put(m.work, "a.txt", "edited, and the watcher did not say\n");
    put(m.work, "src/b.ts", "told\n");
    const named = await snapshot({ work: m.work, gitDir: m.gitDir, treeOnly: true, paths: ["src/b.ts"] });
    expect(named.tree).not.toBe(await wholeTree(m)); // the whole is what is true
    const again = await snapshot({ work: m.work, gitDir: m.gitDir, treeOnly: true });
    expect(again.tree).toBe(await wholeTree(m));
  });
});

describe("waiting for the paths that changed", () => {
  const counting = (seen: string[]) => (path: string) => {
    seen.push(path);
    return lstatSync(path);
  };

  test("looks at those paths and not at the rest of the work tree", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 60; i++) files["many/f" + i + ".txt"] = "x" + i;
    const m = await member(files);
    const all: string[] = [];
    await stampTree(m.work, m.gitDir, [], counting(all));
    const some: string[] = [];
    const stamp = await stampTree(m.work, m.gitDir, [], counting(some), ["a.txt", "src/deep"]);
    expect(all.length).toBeGreaterThan(60);
    expect(some.map((p) => p.slice(m.work.length + 1).split("\\").join("/")).sort()).toEqual(["a.txt", "src/deep/c.ts"]);
    expect(stamp).not.toBeNull();
    // What is named is what the key is of: a change to a file that is not named is not in it, one that is, is.
    put(m.work, "docs/readme.md", "# changed, not named\n");
    expect((await stampTree(m.work, m.gitDir, [], lstatSync, ["a.txt", "src/deep"]))!.key).toBe(stamp!.key);
    put(m.work, "src/deep/c.ts", "export const c = 22222;\n");
    expect((await stampTree(m.work, m.gitDir, [], lstatSync, ["a.txt", "src/deep"]))!.key).not.toBe(stamp!.key);
    // A file that went is a change too.
    const before = (await stampTree(m.work, m.gitDir, [], lstatSync, ["a.txt"]))!.key;
    unlinkSync(join(m.work, "a.txt"));
    expect((await stampTree(m.work, m.gitDir, [], lstatSync, ["a.txt"]))!.key).not.toBe(before);
  });

  test("takes names as they are, leaves out the .git of a nested repository, and ignored paths", async () => {
    const m = await member();
    const odd = process.platform === "win32" ? [] : [":(top)x", "*.q", "a b.txt"];
    for (const n of odd) put(m.work, n, n + "\n");
    put(m.work, "debug.log", "ignored\n");
    mkdirSync(join(m.work, "vendor", "lib", ".git"), { recursive: true });
    const seen: string[] = [];
    await stampTree(m.work, m.gitDir, ["vendor/lib"], counting(seen), [...odd, "debug.log", "vendor/lib/.git/HEAD", "vendor/lib", ".git", ""]);
    expect(seen.map((p) => p.slice(m.work.length + 1)).sort()).toEqual([...odd].sort());
  });

  for (const pause of [10, 40]) {
    test("a file written in pieces " + pause + " ms apart is waited for until it is complete, when only its path is looked at", async () => {
      const m = await member();
      const file = join(m.work, "big.bin");
      const piece = "0123456789".repeat(100);
      const fd = openSync(file, "w");
      let n = 0;
      const done = new Promise<void>((resolve) => {
        const next = (): void => {
          writeSync(fd, piece);
          if (++n === 10) {
            closeSync(fd);
            resolve();
          } else setTimeout(next, pause);
        };
        next();
      });
      const stamp = await settle(m.work, 50, { gitDir: m.gitDir, only: ["big.bin"] });
      expect(stamp).not.toBeNull();
      expect(statSync(file).size).toBe(piece.length * 10);
      await done;
    });
  }

  test("a path noted while it waits is waited for too", async () => {
    const m = await member();
    put(m.work, "first.txt", "1\n");
    const named = ["first.txt"];
    // A second file is named 20 ms in (the first look of the wait is over by then) and written for 300 ms: it was not named when the wait began.
    setTimeout(() => {
      named.push("second.txt");
      let i = 0;
      const writing = setInterval(() => {
        put(m.work, "second.txt", "x".repeat(++i));
        if (i === 10) clearInterval(writing);
      }, 30);
    }, 20);
    const began = Date.now();
    await settle(m.work, 50, { gitDir: m.gitDir, only: () => [...named] });
    expect(Date.now() - began).toBeGreaterThanOrEqual(300);
    expect(statSync(join(m.work, "second.txt")).size).toBe(10);
  }, 20_000);
});

describe("what the watcher's changes come to", () => {
  const fresh = () => ({ changed: undefined as Set<string> | undefined, changedAll: undefined as boolean | undefined, indexTrusted: true as boolean | undefined });

  test("are named as they are, once each, with `/` between the parts", () => {
    const loop = fresh();
    for (const n of ["a.txt", "src\\b.ts", "./c.txt", "a.txt"]) noteChangedPath(loop, n);
    expect(takeChangedPaths(loop)?.sort()).toEqual(["a.txt", "c.txt", "src/b.ts"]);
    // Taken: the notes start over (and a round with none has nothing to go by).
    expect(loop.changed?.size).toBe(0);
    expect(takeChangedPaths(loop)).toBeUndefined();
  });

  test("are not named when the index is not known to be right, or when a change says nothing, or alters what is staged at all", () => {
    const untrusted = { ...fresh(), indexTrusted: false };
    noteChangedPath(untrusted, "a.txt");
    expect(takeChangedPaths(untrusted)).toBeUndefined();
    for (const odd of [null, undefined, "", "sub/.gitignore", ".gitattributes", "x\\.gitignore"]) {
      const loop = fresh();
      noteChangedPath(loop, "a.txt");
      noteChangedPath(loop, odd);
      expect(takeChangedPaths(loop), String(odd)).toBeUndefined();
      // And the next round names again.
      noteChangedPath(loop, "b.txt");
      expect(takeChangedPaths(loop)).toEqual(["b.txt"]);
    }
  });

  test("a repository's own .git that went or came notes the folder it was in, and one at the top is everything", () => {
    const loop = fresh();
    noteChangedPath(loop, "sub/.git");
    noteChangedPath(loop, "a/b\\.git");
    expect(takeChangedPaths(loop)?.sort()).toEqual(["a/b", "sub"]);
    noteChangedPath(loop, ".git");
    expect(takeChangedPaths(loop)).toBeUndefined();
    // Staged by name, the folder brings the files of a repository that became a folder.
  });

  test("more than the cap are not named", () => {
    const loop = fresh();
    for (let i = 0; i <= MAX_CHANGED_PATHS; i++) noteChangedPath(loop, "f" + i);
    expect(loop.changedAll).toBe(true);
    expect(takeChangedPaths(loop)).toBeUndefined();
  });
});

describe("a replica's look at its work tree before it writes", () => {
  /** A replica that holds the first snapshot of a primary's tree, as the agent keeps it. */
  async function replicaOf(work: Record<string, string>) {
    const p = await member(work);
    const sub = join(p.root, "replica");
    const subStore = join(p.root, "replica-store");
    mkdirSync(sub, { recursive: true });
    const snap = await snapshot({ work: p.work, gitDir: p.gitDir, wantFull: true, seq: 1 });
    await ingestPack(sub, subStore, snap.commit, snap.pack, { tree: snap.tree, seq: 1 });
    await applyCommit(sub, subStore, snap.commit, [], null);
    return { work: sub, gitDir: subStore, commit: snap.commit, tree: snap.tree };
  }

  test("finds nothing of its own to keep when it has changed nothing, without staging anything", async () => {
    const r = await replicaOf({});
    const seen = await traced(() => workTreeMatchesApply(r.work, r.gitDir, r.commit));
    expect(seen.value).toBe(true);
    expect(seen.commands.filter((c) => /^(add|write-tree)/.test(c))).toEqual([]);
    // Many times over, as a replica that is applying a long run of snapshots would.
    expect(await workTreeMatchesApply(r.work, r.gitDir, r.commit)).toBe(true);
  });

  const edits: Array<{ name: string; change: (work: string) => void; posix?: true }> = [
    { name: "a file it edited", change: (w) => put(w, "a.txt", "mine\n") },
    { name: "a file it edited to the same size and put the time back on", change: (w) => {
      const was = statSync(join(w, "a.txt"));
      put(w, "a.txt", "ALPHA\n");
      utimesSync(join(w, "a.txt"), was.atime, was.mtime);
    } },
    { name: "a file it deleted", change: (w) => unlinkSync(join(w, "a.txt")) },
    { name: "a file of its own that git would add", change: (w) => put(w, "notes.md", "mine\n") },
    { name: "a file of its own in a directory that is its own", change: (w) => put(w, "scratch/deep/notes.md", "mine\n") },
    { name: "a file whose mode it changed", change: (w) => chmodSync(join(w, "a.txt"), 0o755), posix: true },
    { name: "a file it made a link", change: (w) => (unlinkSync(join(w, "a.txt")), symlinkSync("src/b.ts", join(w, "a.txt"))), posix: true },
  ];
  for (const e of edits) {
    test("sees " + e.name + ": the look says to look closer, as a snapshot of it would find a different tree", async () => {
      if (e.posix && process.platform === "win32") return;
      const r = await replicaOf({});
      e.change(r.work);
      expect(await workTreeMatchesApply(r.work, r.gitDir, r.commit)).toBe(false);
      expect((await snapshot({ work: r.work, gitDir: r.gitDir, treeOnly: true })).tree).not.toBe(r.tree);
    });
  }

  test("does not count what a snapshot would not take: an ignored file, an empty directory, a nested repository", async () => {
    const r = await replicaOf({});
    put(r.work, "debug.log", "ignored\n");
    put(r.work, "build/out.js", "ignored directory\n");
    mkdirSync(join(r.work, "empty", "dirs"), { recursive: true });
    const nested = join(r.work, "vendor", "lib");
    mkdirSync(nested, { recursive: true });
    gitSync(["init", "-q", nested]);
    put(r.work, "vendor/lib/inner.txt", "inside\n");
    expect(await workTreeMatchesApply(r.work, r.gitDir, r.commit)).toBe(true);
    expect((await snapshot({ work: r.work, gitDir: r.gitDir, treeOnly: true, exclude: ["vendor/lib"] })).tree).toBe(r.tree);
  });

  test("says to look closer whenever it cannot be sure: another commit than the one applied, no apply index, an apply that was cut short", async () => {
    const r = await replicaOf({});
    expect(await workTreeMatchesApply(r.work, r.gitDir, "0".repeat(40))).toBe(false);
    expect(await workTreeMatchesApply(r.work, r.gitDir, null)).toBe(false);
    expect(await workTreeMatchesApply(r.work, r.gitDir, "not a commit")).toBe(false);
    writeFileSync(join(r.gitDir, "apply.target"), JSON.stringify({ from: null, to: r.commit }));
    expect(await workTreeMatchesApply(r.work, r.gitDir, r.commit)).toBe(false);
    rmSync(join(r.gitDir, "apply.target"));
    expect(await workTreeMatchesApply(r.work, r.gitDir, r.commit)).toBe(true);
    rmSync(join(r.gitDir, "apply.index"));
    expect(await workTreeMatchesApply(r.work, r.gitDir, r.commit)).toBe(false);
  });
});

describe("a name means the same wherever the agent was started", () => {
  test("a named path is staged from the top of the work tree, though the process is inside a folder of it", async () => {
    const m = await member();
    const before = process.cwd();
    try {
      await new Promise((r) => setTimeout(r, 1100));
      put(m.work, "a.txt", "alpha, edited\n");
      put(m.work, "src/b.ts", "export const b = 2;\n");
      process.chdir(join(m.work, "src"));
      const snap = await snapshot({ work: m.work, gitDir: m.gitDir, base: m.first.commit, wantFull: false, paths: ["a.txt", "src/b.ts"] });
      process.chdir(before);
      expect(gitSync(["--git-dir=" + m.gitDir, "show", snap.commit + ":a.txt"], { encoding: "utf8" })).toBe("alpha, edited\n");
      expect(gitSync(["--git-dir=" + m.gitDir, "show", snap.commit + ":src/b.ts"], { encoding: "utf8" })).toBe("export const b = 2;\n");
    } finally {
      process.chdir(before);
    }
  });
});
