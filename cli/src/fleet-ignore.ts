// Which paths git would leave out of a snapshot, for the watcher.
//
// A write in a folder git ignores (`node_modules`, a build's output) is nothing a snapshot would
// take, so it need not wake the primary for a look at the tree. What is ignored is not decided here:
// it is asked of git itself (`check-ignore`), in the store's own environment - the one the snapshot
// runs in - so the answer is the snapshot's: every `.gitignore` of the work tree (nested ones and
// negations included), the store's `info/exclude` and `core.excludesFile`. A file the snapshot already
// holds is never ignored, whatever the rules say, as for `git add -A`.
//
// The watcher only uses this to leave things out, so every doubt says "not ignored": a path git could
// not be asked about is waited for like any other.
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import { gitEnv } from "./fleet-sync.ts";

/** How many verdicts are kept; a tree with more changing paths than this starts over. */
const MAX_CACHED = 50_000;
/**
 * How long one question to git may take. A git that takes longer (a hung disk, a lock) is given up on: its
 * paths are called not ignored, which costs a look and loses nothing.
 */
const ASK_TIMEOUT_MS = 2_000;

/**
 * Run git in the store's environment, and tell `track` how to stop it. Exit codes in `ok` are answers
 * (`check-ignore` says 1 for "none of these", `config --get` for "not set"); anything else is a failure.
 */
export type GitRunner = (args: string[], input: string | undefined, ok: number[], track: (kill: () => void) => void) => Promise<Buffer>;

function gitRunner(work: string, gitDir: string): GitRunner {
  return (args, input, ok, track) =>
    new Promise((resolve, reject) => {
      const env = gitEnv(gitDir, work, join(gitDir, "snapshot.index"));
      const child = spawn("git", ["--git-dir=" + gitDir].concat(args), { env, cwd: work, stdio: ["pipe", "pipe", "pipe"] });
      track(() => child.kill());
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (c: Buffer) => out.push(c));
      child.stderr.on("data", (c: Buffer) => err.push(c));
      child.stdin.on("error", () => undefined);
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== null && ok.includes(code)) resolve(Buffer.concat(out));
        else reject(new Error("git " + args.join(" ") + " failed (" + code + "): " + Buffer.concat(err).toString().slice(0, 200)));
      });
      child.stdin.end(input);
    });
}

/** The question was not answered in time. */
class AskTimeout extends Error {}

function statKey(file: string): string {
  try {
    const st = statSync(file);
    return st.ino + ":" + st.size + ":" + st.mtimeMs;
  } catch {
    return "-";
  }
}

export class IgnoreFilter {
  /** What was asked, for tests: how many times git was run to check paths, and how many answers came from the cache. */
  readonly stats = { asks: 0, cached: 0 };
  private readonly verdicts = new Map<string, boolean>();
  private readonly waiting = new Map<string, Array<(ignored: boolean) => void>>();
  private draining = false;
  private closed = false;
  /** Bumped whenever the rules may have changed: what git answered across a bump is not kept. */
  private generation = 0;
  /** The `core.excludesFile` git resolves, and every file its configuration is read from, once asked. */
  private excludesFile = "";
  private configFiles: string[] = [];
  private stamp = "";
  private resolveAgain = true;
  private readonly running = new Set<{ kill: () => void; abort: () => void }>();
  private readonly runner: GitRunner;
  private readonly timeoutMs: number;

  constructor(
    private readonly work: string,
    private readonly gitDir: string,
    /** For tests: another way to run git, and how long a question may take. */
    opts: { runner?: GitRunner; timeoutMs?: number } = {},
  ) {
    this.runner = opts.runner ?? gitRunner(work, gitDir);
    this.timeoutMs = opts.timeoutMs ?? ASK_TIMEOUT_MS;
  }

  /** Forget every answer: the rules have changed (or may have). */
  invalidate(): void {
    this.generation++;
    this.verdicts.clear();
  }

  /**
   * Stop asking: a git that is running is ended, and what is waiting for an answer is told "not ignored".
   * The filter answers "not ignored" from then on.
   */
  close(): void {
    this.closed = true;
    for (const run of [...this.running]) {
      run.kill();
      run.abort();
    }
    this.running.clear();
    for (const resolvers of this.waiting.values()) for (const done of resolvers) done(false);
    this.waiting.clear();
  }

  /**
   * Tell the filter what the watcher saw, before asking about it. A `.gitignore` changing changes the
   * rules for everything below it; a directory arriving or going (it may hold one, and a moved one takes
   * its rules along) may change them for what is in it. Either clears what is known.
   */
  noteChange(eventType: string | undefined, filename: string | null | undefined): void {
    if (!filename) return;
    const path = this.normal(filename);
    if (basename(path) === ".gitignore") {
      this.invalidate();
      return;
    }
    if (eventType === "rename") {
      let directory = false;
      let there = true;
      try {
        directory = statSync(join(this.work, path)).isDirectory();
      } catch {
        there = false;
      }
      if (directory || !there) this.invalidate();
    }
  }

  /**
   * Whether the snapshot would leave this path out (a path relative to the work tree, as the watcher says it).
   * False for anything that is in doubt, and for the files that name the rules themselves.
   */
  isIgnored(filename: string | null | undefined): Promise<boolean> {
    if (!filename || this.closed) return Promise.resolve(false);
    const path = this.normal(filename);
    // The rules are never skipped over: a `.gitignore` is looked at like any other file, and a path inside
    // a repository's own folder is not what this is asked about.
    if (path === "" || basename(path) === ".gitignore" || path.split("/").includes(".git")) return Promise.resolve(false);
    const now = this.externalStamp();
    if (now !== this.stamp) {
      this.invalidate();
      this.stamp = now;
      this.resolveAgain = true;
    }
    const known = this.verdicts.get(path);
    if (known !== undefined) {
      this.stats.cached++;
      return Promise.resolve(known);
    }
    return new Promise((resolve) => {
      const same = this.waiting.get(path);
      if (same) same.push(resolve);
      else this.waiting.set(path, [resolve]);
      if (!this.draining) {
        this.draining = true;
        // Whatever else the watcher says in this turn goes to git in the same question.
        setImmediate(() => void this.drain());
      }
    });
  }

  private normal(filename: string): string {
    return (sep === "/" ? filename : filename.split(sep).join("/")).replace(/^\.\//, "");
  }

  // The files outside the work tree that decide what is ignored: the store's own exclude file and
  // config, the user's git configuration (and what it includes), and the file `core.excludesFile` names
  // (or the default).
  private externalFiles(): string[] {
    const home = process.env.HOME || process.env.USERPROFILE || homedir();
    const config = process.env.XDG_CONFIG_HOME || join(home, ".config");
    return [
      join(this.gitDir, "info", "exclude"),
      join(this.gitDir, "config"),
      process.env.GIT_CONFIG_GLOBAL ?? "",
      join(home, ".gitconfig"),
      join(config, "git", "config"),
      join(config, "git", "ignore"),
      this.excludesFile,
      ...this.configFiles,
    ].filter((f) => f !== "");
  }

  private externalStamp(): string {
    return [...new Set(this.externalFiles())].map((f) => f + "=" + statKey(f)).join("|");
  }

  // One question to git, ended if it takes too long (or if the filter is closed).
  private ask(args: string[], input: string | undefined, ok: number[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const handle = { kill: () => undefined as void, abort: () => undefined as void };
      let finished = false;
      const finish = (then: () => void): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.running.delete(handle);
        then();
      };
      const timer = setTimeout(() => {
        const stop = handle.kill;
        finish(() => reject(new AskTimeout()));
        stop();
      }, this.timeoutMs);
      handle.abort = () => finish(() => reject(new Error("the filter was closed")));
      this.running.add(handle);
      this.runner(args, input, ok, (kill) => void (handle.kill = kill)).then(
        (out) => finish(() => resolve(out)),
        (err) => finish(() => reject(err)),
      );
    });
  }

  // Which of the paths git calls ignored. A path that makes git refuse the question (it is beyond a
  // symbolic link, or git cannot read it as a path) is not allowed to spoil the answer for the rest: the
  // paths are halved until the one that does it is alone, and that one is "in doubt" (null).
  private async check(paths: string[]): Promise<Map<string, boolean | null>> {
    const verdicts = new Map<string, boolean | null>();
    if (paths.length === 0) return verdicts;
    // A name that begins with a colon would be read as a pathspec with magic; "./" makes it a plain path.
    const sent = new Map(paths.map((p) => [p.startsWith(":") ? "./" + p : p, p]));
    try {
      const asked = await this.ask(["check-ignore", "-z", "--stdin"], [...sent.keys()].join("\u0000") + "\u0000", [0, 1]);
      this.stats.asks++;
      const ignored = new Set(asked.toString("utf8").split("\u0000").filter((p) => p !== ""));
      for (const [wire, path] of sent) verdicts.set(path, ignored.has(wire));
    } catch (err) {
      if (err instanceof AskTimeout || this.closed) throw err;
      if (paths.length === 1) {
        verdicts.set(paths[0]!, null);
      } else {
        const half = Math.ceil(paths.length / 2);
        for (const part of [paths.slice(0, half), paths.slice(half)]) for (const [p, v] of await this.check(part)) verdicts.set(p, v);
      }
    }
    return verdicts;
  }

  private async resolveRules(): Promise<void> {
    this.excludesFile = (await this.ask(["config", "--path", "--get", "core.excludesFile"], undefined, [0, 1])).toString("utf8").trim();
    // Every file the configuration is read from, the ones that other files include among them.
    const listed = (await this.ask(["config", "--list", "--show-origin", "-z"], undefined, [0])).toString("utf8").split("\u0000");
    const files: string[] = [];
    for (let i = 0; i + 1 < listed.length; i += 2) {
      const origin = listed[i]!;
      if (origin.startsWith("file:")) files.push(resolve(this.work, origin.slice(5)));
    }
    this.configFiles = [...new Set(files)];
    this.stamp = this.externalStamp();
  }

  private async drain(): Promise<void> {
    try {
      while (this.waiting.size > 0 && !this.closed) {
        const batch = [...this.waiting.entries()];
        this.waiting.clear();
        const generation = this.generation;
        let verdicts: Map<string, boolean | null> | null = null;
        try {
          if (this.resolveAgain) {
            this.resolveAgain = false;
            await this.resolveRules();
          }
          verdicts = await this.check(batch.map(([p]) => p));
        } catch {
          // Not answered (no store yet, no git, too slow): no path is called ignored, and nothing is remembered.
          this.resolveAgain = true;
        }
        // An answer given across a change of the rules may be either side of it: it is used, not kept.
        const keep = verdicts !== null && generation === this.generation && !this.closed;
        if (keep && this.verdicts.size + batch.length > MAX_CACHED) this.verdicts.clear();
        for (const [path, resolvers] of batch) {
          const verdict = verdicts?.get(path) ?? null;
          if (keep && verdict !== null) this.verdicts.set(path, verdict);
          for (const done of resolvers) done(verdict === true);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
