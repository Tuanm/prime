import { afterEach, describe, expect, test } from "bun:test";
import { gitSync } from "./git";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { watchTree } from "../src/fleet-daemon";
import { IgnoreFilter, type GitRunner } from "../src/fleet-ignore";
import { gitEnv, snapshot } from "../src/fleet-sync";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function layout(files: Record<string, string>): { root: string; work: string; gitDir: string } {
  const root = mkdtempSync(join(tmpdir(), "fleet-ignore-"));
  roots.push(root);
  const work = join(root, "work");
  const gitDir = join(root, "store");
  mkdirSync(work, { recursive: true });
  put(work, files);
  return { root, work, gitDir };
}

function put(work: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(work, rel, ".."), { recursive: true });
    writeFileSync(join(work, rel), body);
  }
}

// Every file under the work tree, as the watcher names it.
function listFiles(work: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(work, full).split(sep).join("/"));
    }
  };
  walk(work);
  return out.sort();
}

// What a snapshot of the work tree takes, by git itself.
async function taken(work: string, gitDir: string): Promise<string[]> {
  const snap = await snapshot({ work, gitDir, base: null, treeOnly: true });
  return gitSync(["--git-dir=" + gitDir, "ls-tree", "-r", "--name-only", snap.tree], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .sort();
}

// The paths the filter calls ignored.
async function ignoredBy(filter: IgnoreFilter, files: string[]): Promise<string[]> {
  const verdicts = await Promise.all(files.map(async (f) => [f, await filter.isIgnored(f)] as const));
  return verdicts.filter(([, ignored]) => ignored).map(([f]) => f).sort();
}

// A store that holds nothing yet: no file is tracked.
function emptyStore(gitDir: string): void {
  gitSync(["init", "-q", "--bare", gitDir], { stdio: "pipe" });
}

// The filter says "ignored" for exactly the files the snapshot leaves out (asked before the snapshot
// is taken, so what the snapshot tracks has not yet been told to it).
async function expectSameAsSnapshot(work: string, gitDir: string, filter: IgnoreFilter): Promise<string[]> {
  const files = listFiles(work);
  const said = await ignoredBy(filter, files);
  const took = new Set(await taken(work, gitDir));
  const left = files.filter((f) => !took.has(f)).sort();
  expect(said).toEqual(left);
  return left;
}

// The files git leaves out of the next snapshot, by git itself, without taking one (so it can be asked again
// after the rules change): neither tracked in the snapshot's index nor untracked and not ignored.
function leftOut(work: string, gitDir: string): string[] {
  const env = gitEnv(gitDir, work, join(gitDir, "snapshot.index"));
  const ls = (...args: string[]): string[] =>
    gitSync(["--git-dir=" + gitDir, "ls-files", "-z", ...args], { env, cwd: work, encoding: "utf8" }).split("\u0000").filter(Boolean);
  const takes = new Set([...ls("--cached"), ...ls("--others", "--exclude-standard")]);
  return listFiles(work).filter((f) => !takes.has(f));
}

async function expectSameAsGit(work: string, gitDir: string, filter: IgnoreFilter): Promise<string[]> {
  const left = leftOut(work, gitDir);
  expect(await ignoredBy(filter, listFiles(work))).toEqual(left);
  return left;
}

describe("what the watcher leaves out follows git's own rules", () => {
  test("nested .gitignore files, negation and directory patterns", async () => {
    const { work, gitDir } = layout({
      ".gitignore": "*.log\nbuild/\n!important.log\n",
      "a.log": "x",
      "important.log": "x",
      "src/main.ts": "x",
      "build/out.js": "x",
      "build/keep.log": "x",
      "sub/.gitignore": "*.tmp\n!keep.tmp\n/only-here.txt\n",
      "sub/b.log": "x",
      "sub/x.tmp": "x",
      "sub/keep.tmp": "x",
      "sub/only-here.txt": "x",
      "sub/deeper/only-here.txt": "x",
      "sub/deeper/.gitignore": "!*.log\n",
      "sub/deeper/c.log": "x",
      "sub/deeper/y.tmp": "x",
      "sub/build/z.js": "x",
    });
    const filter = new IgnoreFilter(work, gitDir);
    emptyStore(gitDir);
    const left = await expectSameAsSnapshot(work, gitDir, filter);
    // What git is known to do with these rules, so the comparison above is not two empty lists.
    expect(left).toEqual(["a.log", "build/keep.log", "build/out.js", "sub/b.log", "sub/build/z.js", "sub/deeper/y.tmp", "sub/only-here.txt", "sub/x.tmp"]);
  });

  test("a file the snapshot holds is never left out, whatever the rules now say", async () => {
    const { work, gitDir } = layout({ "kept.log": "1", "other.log": "1", "src/a.ts": "1" });
    await taken(work, gitDir); // both logs are taken: nothing ignores them yet
    put(work, { ".gitignore": "*.log\n", "kept.log": "2", "fresh.log": "2" });
    const filter = new IgnoreFilter(work, gitDir);
    const left = await expectSameAsSnapshot(work, gitDir, filter);
    expect(left).toEqual(["fresh.log"]);
    // The tracked files are still not ignored even though the rule matches them.
    expect(await filter.isIgnored("kept.log")).toBe(false);
    expect(await filter.isIgnored("other.log")).toBe(false);
    expect(await filter.isIgnored("fresh.log")).toBe(true);
  });

  test("the store's info/exclude counts, and a change to it is seen", async () => {
    const { work, gitDir } = layout({ "secret.txt": "1", "public.txt": "1", "notes/secret.txt": "1" });
    emptyStore(gitDir);
    const filter = new IgnoreFilter(work, gitDir);
    expect(await ignoredBy(filter, listFiles(work))).toEqual([]);
    mkdirSync(join(gitDir, "info"), { recursive: true });
    writeFileSync(join(gitDir, "info", "exclude"), "secret.txt\n");
    // No event for it: the file is outside the work tree, so the filter looks at it itself.
    const left = await expectSameAsGit(work, gitDir, filter);
    expect(left).toEqual(["notes/secret.txt", "secret.txt"]);
    writeFileSync(join(gitDir, "info", "exclude"), "/secret.txt\n");
    expect(await filter.isIgnored("notes/secret.txt")).toBe(false);
    expect(await filter.isIgnored("secret.txt")).toBe(true);
  });

  test("the exclude file of a repository in the work tree is not the snapshot's, so it is not the watcher's", async () => {
    const { work, gitDir } = layout({ "mine.txt": "1", "other.txt": "1" });
    mkdirSync(join(work, ".git", "info"), { recursive: true });
    writeFileSync(join(work, ".git", "info", "exclude"), "mine.txt\n");
    const filter = new IgnoreFilter(work, gitDir);
    const left = await expectSameAsSnapshot(work, gitDir, filter);
    // The snapshot takes it (its rules are the store's), so it must wake the primary.
    expect(left).toEqual([]);
  });

  test("core.excludesFile counts, and so does changing it", async () => {
    const { root, work, gitDir } = layout({ "a.bak": "1", "b.txt": "1", "c.old": "1" });
    const excludes = join(root, "global-ignore");
    const other = join(root, "other-ignore");
    const config = join(root, "gitconfig");
    writeFileSync(excludes, "*.bak\n");
    writeFileSync(other, "*.old\n");
    const asPath = (p: string): string => p.replace(/\\/g, "/");
    writeFileSync(config, "[core]\n\texcludesFile = " + asPath(excludes) + "\n");
    const before = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = config;
    try {
      emptyStore(gitDir);
      const filter = new IgnoreFilter(work, gitDir);
      expect(await expectSameAsGit(work, gitDir, filter)).toEqual(["a.bak"]);
      // The file it names changes.
      writeFileSync(excludes, "*.bak\n*.txt\n");
      expect(await expectSameAsGit(work, gitDir, filter)).toEqual(["a.bak", "b.txt"]);
      // The setting changes to name another file.
      writeFileSync(config, "[core]\n\texcludesFile = " + asPath(other) + "\n");
      expect(await expectSameAsGit(work, gitDir, filter)).toEqual(["c.old"]);
    } finally {
      if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = before;
    }
  });

  test("the answers are kept and asked for together, and a .gitignore that changes starts them over", async () => {
    const { work, gitDir } = layout({ ".gitignore": "*.log\n" });
    const names = Array.from({ length: 40 }, (_, i) => "d/f" + i + (i % 2 ? ".log" : ".txt"));
    put(work, Object.fromEntries(names.map((n) => [n, "x"])));
    emptyStore(gitDir);
    const filter = new IgnoreFilter(work, gitDir);
    const first = await ignoredBy(filter, names);
    expect(first.length).toBe(20);
    expect(filter.stats.asks).toBe(1); // one git for forty paths
    expect(await ignoredBy(filter, names)).toEqual(first);
    expect(filter.stats.asks).toBe(1); // none for the same forty
    expect(filter.stats.cached).toBeGreaterThanOrEqual(40);

    writeFileSync(join(work, ".gitignore"), "*.txt\n");
    filter.noteChange("change", ".gitignore");
    const second = await ignoredBy(filter, names);
    expect(second.every((n) => n.endsWith(".txt"))).toBe(true);
    expect(second.length).toBe(20);
    expect(filter.stats.asks).toBe(2);
  });

  test("a directory that moves takes its rules with it", async () => {
    const { work, gitDir } = layout({ "one/.gitignore": "*.dat\n", "one/a.dat": "1" });
    emptyStore(gitDir);
    const filter = new IgnoreFilter(work, gitDir);
    expect(await filter.isIgnored("one/a.dat")).toBe(true);
    renameSync(join(work, "one"), join(work, "two"));
    filter.noteChange("rename", "one");
    filter.noteChange("rename", "two");
    // A new `one`, without the rules.
    put(work, { "one/a.dat": "2" });
    filter.noteChange("rename", "one");
    expect(await filter.isIgnored("one/a.dat")).toBe(false);
    expect(await filter.isIgnored("two/a.dat")).toBe(true);
  });

  test("what git cannot be asked about is not left out and is not remembered", async () => {
    const { work, gitDir } = layout({ "a.log": "1", ".gitignore": "*.log\n" });
    const filter = new IgnoreFilter(work, join(work, "no-store-here", "x"));
    expect(await filter.isIgnored("a.log")).toBe(false);
    expect(await filter.isIgnored("a.log")).toBe(false);
    expect(filter.stats.cached).toBe(0);
    // The paths that name the rules, and anything in a repository's own folder, are never asked about.
    emptyStore(gitDir);
    const real = new IgnoreFilter(work, gitDir);
    expect(await real.isIgnored(".gitignore")).toBe(false);
    expect(await real.isIgnored("lib/.git/index")).toBe(false);
    expect(await real.isIgnored(null)).toBe(false);
    expect(real.stats.asks).toBe(0);
  });
});

const notWindows = process.platform === "win32" ? test.skip : test;

// What git answers for the paths of a question: the real thing, but for the paths named it fails (as git does for some).
function refusing(work: string, gitDir: string, bad: string[]): { runner: GitRunner; asked: string[][] } {
  const asked: string[][] = [];
  const real = new IgnoreFilter(work, gitDir) as unknown as { runner: GitRunner };
  const runner: GitRunner = (args, input, ok, track) => {
    if (args[0] === "check-ignore") {
      const paths = (input ?? "").split("\u0000").filter(Boolean);
      asked.push(paths);
      if (paths.some((p) => bad.includes(p))) return Promise.reject(new Error("git check-ignore failed (128): fatal"));
    }
    return real.runner(args, input, ok, track);
  };
  return { runner, asked };
}

describe("names git could misread, and a git that does not answer", () => {
  notWindows("a name that starts with a colon is a name, not a pathspec: a tracked file is never called ignored", async () => {
    const { work, gitDir } = layout({
      ".gitignore": "build/\nx\nicase\n",
      "build/out.o": "o",
      ":build": "notes",
      ":!x": "1",
      ":(icase)ICASE": "1",
      ":(glob)x": "1",
      "x": "ignored",
      "src/a.ts": "1",
    });
    emptyStore(gitDir);
    const filter = new IgnoreFilter(work, gitDir);
    const left = await expectSameAsSnapshot(work, gitDir, filter);
    // The snapshot takes every one of the colon names, and the filter says so; what is ignored is ignored.
    expect(left).toEqual(["build/out.o", "x"]);
    // Written to afterwards, with the snapshot holding them: still not ignored.
    expect(await ignoredBy(filter, [":build", ":!x", ":(icase)ICASE", ":(glob)x"])).toEqual([]);
  });

  test("a path git refuses does not spoil the answer for the others, and is not called ignored", async () => {
    const { work, gitDir } = layout({ ".gitignore": "*.log\n", "a.log": "1", "b.txt": "1", "c.log": "1", "d.txt": "1" });
    emptyStore(gitDir);
    const { runner, asked } = refusing(work, gitDir, ["b.txt"]);
    const filter = new IgnoreFilter(work, gitDir, { runner });
    const names = ["a.log", "b.txt", "c.log", "d.txt"];
    expect(await ignoredBy(filter, names)).toEqual(["a.log", "c.log"]);
    // The paths that could be answered are remembered; the one that could not is asked again next time.
    const before = asked.length;
    expect(await ignoredBy(filter, ["a.log", "c.log", "d.txt"])).toEqual(["a.log", "c.log"]);
    expect(asked.length).toBe(before);
    expect(await filter.isIgnored("b.txt")).toBe(false);
    expect(asked.length).toBe(before + 1);
  });

  notWindows("a path beyond a symbolic link is refused by git and costs nothing to the rest", async () => {
    const { root, work, gitDir } = layout({ ".gitignore": "node_modules/\n", "node_modules/pkg/i.js": "1", "src/a.ts": "1" });
    mkdirSync(join(root, "elsewhere"));
    writeFileSync(join(root, "elsewhere", "r.txt"), "1");
    symlinkSync(join(root, "elsewhere"), join(work, "link"));
    emptyStore(gitDir);
    const filter = new IgnoreFilter(work, gitDir);
    const verdicts = await Promise.all(["node_modules/pkg/i.js", "link/r.txt", "src/a.ts"].map((f) => filter.isIgnored(f)));
    expect(verdicts).toEqual([true, false, false]);
    expect(filter.stats.asks).toBeGreaterThan(0);
    expect(await filter.isIgnored("node_modules/pkg/i.js")).toBe(true);
    expect(filter.stats.cached).toBe(1);
  });

  test("a git that does not answer in time is given up on: not ignored, nothing remembered, and the git is ended", async () => {
    const { work, gitDir } = layout({ ".gitignore": "*.log\n", "a.log": "1" });
    emptyStore(gitDir);
    let killed = 0;
    // Answers the questions about configuration, and hangs on the one about paths until it is killed.
    const real = new IgnoreFilter(work, gitDir) as unknown as { runner: GitRunner };
    const runner: GitRunner = (args, input, ok, track) => {
      if (args[0] !== "check-ignore") return real.runner(args, input, ok, track);
      return new Promise<Buffer>(() => track(() => void killed++));
    };
    const filter = new IgnoreFilter(work, gitDir, { runner, timeoutMs: 150 });
    const began = Date.now();
    expect(await filter.isIgnored("a.log")).toBe(false);
    expect(Date.now() - began).toBeLessThan(1500);
    expect(killed).toBe(1);
    expect(filter.stats.cached).toBe(0);
    expect(await filter.isIgnored("a.log")).toBe(false);
    expect(killed).toBe(2); // asked again, not remembered
  });

  test("closing the filter ends the git that is running and lets what waits through", async () => {
    const { work, gitDir } = layout({ ".gitignore": "*.log\n", "a.log": "1" });
    emptyStore(gitDir);
    let killed = 0;
    const real = new IgnoreFilter(work, gitDir) as unknown as { runner: GitRunner };
    const runner: GitRunner = (args, input, ok, track) => {
      if (args[0] !== "check-ignore") return real.runner(args, input, ok, track);
      return new Promise<Buffer>(() => track(() => void killed++));
    };
    const filter = new IgnoreFilter(work, gitDir, { runner, timeoutMs: 60_000 });
    const waiting = filter.isIgnored("a.log");
    await Bun.sleep(200); // the question is with git
    filter.close();
    expect(await waiting).toBe(false);
    expect(killed).toBe(1);
    expect(await filter.isIgnored("a.log")).toBe(false);
  });

  test("the watcher does not go deaf while git is slow: a path is let through after a moment, and stop() ends the git", async () => {
    const { work, gitDir } = layout({ ".gitignore": "*.log\n", "a.txt": "1" });
    emptyStore(gitDir);
    let killed = 0;
    const real = new IgnoreFilter(work, gitDir) as unknown as { runner: GitRunner };
    const runner: GitRunner = (args, input, ok, track) => {
      if (args[0] !== "check-ignore") return real.runner(args, input, ok, track);
      return new Promise<Buffer>(() => track(() => void killed++));
    };
    const seen: string[] = [];
    const watcher = watchTree(work, (_e, name) => void seen.push(String(name)), { ignore: new IgnoreFilter(work, gitDir, { runner, timeoutMs: 60_000 }), patienceMs: 100 });
    try {
      await Bun.sleep(150);
      writeFileSync(join(work, "a.txt"), "2");
      await Bun.sleep(800);
      expect(seen).toContain("a.txt");
    } finally {
      watcher.stop();
    }
    expect(killed).toBeGreaterThanOrEqual(1);
  });

  test("a configuration that another includes is watched too", async () => {
    const { root, work, gitDir } = layout({ "a.bak": "1", "b.old": "1" });
    const first = join(root, "ignore-1");
    const second = join(root, "ignore-2");
    const included = join(root, "included.cfg");
    const config = join(root, "gitconfig");
    const asPath = (p: string): string => p.replace(/\\/g, "/");
    writeFileSync(first, "*.bak\n");
    writeFileSync(second, "*.old\n");
    writeFileSync(included, "[core]\n\texcludesFile = " + asPath(first) + "\n");
    writeFileSync(config, "[include]\n\tpath = " + asPath(included) + "\n");
    const before = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = config;
    try {
      emptyStore(gitDir);
      const filter = new IgnoreFilter(work, gitDir);
      expect(await expectSameAsGit(work, gitDir, filter)).toEqual(["a.bak"]);
      // The setting is changed in the included file, not in the one that git is pointed at.
      writeFileSync(included, "[core]\n\texcludesFile = " + asPath(second) + "\n\t# changed\n");
      expect(await expectSameAsGit(work, gitDir, filter)).toEqual(["b.old"]);
    } finally {
      if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = before;
    }
  });
});

describe("the watcher with the rules", () => {
  test("stays quiet for what git ignores, speaks for the rest and for the rules themselves", async () => {
    const { work, gitDir } = layout({ ".gitignore": "node_modules/\n*.log\n", "src/a.ts": "1" });
    mkdirSync(join(work, "node_modules", "pkg"), { recursive: true });
    emptyStore(gitDir);
    const seen: string[] = [];
    const watcher = watchTree(work, (_e, name) => void seen.push(String(name)), { ignore: new IgnoreFilter(work, gitDir) });
    try {
      await Bun.sleep(150);
      writeFileSync(join(work, "node_modules", "pkg", "index.js"), "1");
      writeFileSync(join(work, "debug.log"), "1");
      await Bun.sleep(600);
      expect(seen.filter((n) => n.includes("node_modules") && n.includes("index.js"))).toEqual([]);
      expect(seen).not.toContain("debug.log");
      writeFileSync(join(work, "src", "a.ts"), "2");
      await Bun.sleep(600);
      expect(seen).toContain(join("src", "a.ts"));
      // The rules changing is heard, and so is what they let through afterwards.
      seen.length = 0;
      writeFileSync(join(work, ".gitignore"), "node_modules/\n");
      await Bun.sleep(600);
      expect(seen).toContain(".gitignore");
      seen.length = 0;
      writeFileSync(join(work, "debug.log"), "2");
      await Bun.sleep(600);
      expect(seen).toContain("debug.log");
    } finally {
      watcher.stop();
    }
  });
});
