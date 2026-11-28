// Fleet state synchronisation.
//
// A member that holds the lease is the primary. It watches its work tree,
// snapshots it, packs it, encrypts it for the members, and publishes it. A
// replica fetches the newest published state and applies it to its own work
// tree. A replica never writes.
//
// Why git, and why outside the work tree:
//   - git already does content addressing, tree structure and delta
//     compression, and the packs it produces are exactly what a replica
//     needs to reconstruct a tree byte for byte;
//   - the object store lives in prime's own directory, so the work tree
//     keeps no trace of the mechanism (no .git, no index, no refs).
//
// Why the packs are encrypted: the gateway stores them, and it must not be
// able to read the workspace. Each snapshot gets a random key, the pack is
// sealed with it, and the key is wrapped separately for each member. The
// gateway sees ciphertext and wrapped keys it cannot open.

import { execFile, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve as absolute, sep } from "node:path";

import { withDirLock } from "./dir-lock";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface Snapshot {
  /** Commit that names the tree. */
  commit: string;
  tree: string;
  parent: string | null;
  /**
   * Self-contained pack: the replica can apply it without any history.
   *
   * It carries the whole tree (and only the tree: no earlier snapshot), so it
   * is what a member that joins later needs.
   */
  pack: Buffer;
  /**
   * The same tree as a delta against the previous snapshot.
   *
   * It carries only what changed, so it is what the members that are already
   * caught up want. A member that has the previous snapshot can apply it on
   * its own.
   */
  delta: Buffer | null;
}

export interface SnapshotOptions {
  /** The work tree to snapshot. */
  work: string;
  /** prime's own object store for this fleet member. */
  gitDir: string;
  /** Directories to leave alone, relative to the work tree. */
  exclude?: string[];
  /** Previous snapshot commit, for the history. */
  base?: string | null;
  /** The sequence this snapshot is, so its commit can be kept reachable. */
  seq?: number;
  /** Which pack to build: the whole tree, only the change, or both. */
  wantFull?: boolean;
  /** With a whole-tree pack, build the change since `base` too (a checkpoint carries both). */
  withDelta?: boolean;
  /** Build no pack at all: the caller only wants to know the tree. */
  treeOnly?: boolean;
  /**
   * The tree the work tree is known to hold right now (the caller has just taken it and has checked
   * that nothing has changed since): staging and writing the tree again is skipped, and the commit and
   * the packs are made from it.
   */
  tree?: string;
  /** Remembered nested repositories of this work tree, to spare the walk. */
  nested?: NestedRepoCache;
  /**
   * The only paths (relative to the work tree, `/`-separated) that can differ from the last time the work tree was staged
   * in this store, because the watcher saw them change and nothing else: only those are staged, and the work tree is not
   * walked. The caller promises that the store's index was brought up to date by a snapshot before the first of these
   * changes (and has not been touched by anything else since), so that the rest of the index is still right. Anything git
   * cannot do with them (a path that is ignored, a git older than 2.25) is a full staging, as when no paths are given.
   */
  paths?: string[];
}

export function gitEnv(gitDir: string, work: string, indexFile: string): Record<string, string> {
  // The user's own git configuration may start a file-system monitor on their work tree or trust a cache of untracked files
  // (`core.fsmonitor`, `core.untrackedCache`); a snapshot reads the files' times itself and trusts neither. Added after any
  // setting of the same kind already in the environment (git 2.31 and later; an older git keeps the user's).
  const already = Number(process.env.GIT_CONFIG_COUNT);
  const n = Number.isInteger(already) && already >= 0 ? already : 0;
  return {
    ...(process.env as Record<string, string>),
    GIT_CONFIG_COUNT: String(n + 2),
    [`GIT_CONFIG_KEY_${n}`]: "core.fsmonitor",
    [`GIT_CONFIG_VALUE_${n}`]: "false",
    [`GIT_CONFIG_KEY_${n + 1}`]: "core.untrackedCache",
    [`GIT_CONFIG_VALUE_${n + 1}`]: "false",
    GIT_DIR: gitDir,
    GIT_WORK_TREE: work,
    GIT_INDEX_FILE: indexFile,
    // A snapshot must never pick up the user's hooks or their configuration.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

// Run git, optionally feeding it stdin and collecting stdout as bytes.
//
// execFile cannot write to a child's stdin, and git pack-objects needs it:
// the revisions to pack are passed that way.
//
// A git that could not take one of its own lock files (another git of this store holds it: the
// agent and `prime fleets sync`, or two syncs, work in one store) has done nothing yet, so it is run
// again after a short wait, for as long as a lock is plausibly held. Only that failure is retried.
const LOCK_RETRY_MS = 15_000;
const LOCK_CONFLICT = /could not lock config file [^\n]*: File exists|Unable to create '[^']*\.lock': File exists/;

// On Windows, git that writes an object another git is writing at that moment (two snapshots of the same tree
// made in the same second make the same commit) is refused the file while the other has it open. The object
// is content-addressed, so the write is as good as done once the other has finished, and is simply run again.
const OBJECT_BUSY = /unable to write file [^\n]*[\\/]objects[\\/][0-9a-f]{2}[\\/][0-9a-f]+: Permission denied/;

/**
 * Whether git's message says it could not take a lock file that another git holds, or (on Windows) write an
 * object that another git is writing - and that nothing else is wrong.
 */
export function isLockConflict(message: string, platform: NodeJS.Platform = process.platform): boolean {
  return LOCK_CONFLICT.test(message) || (platform === "win32" && OBJECT_BUSY.test(message));
}

async function gitRun(
  gitDir: string,
  args: string[],
  env: Record<string, string>,
  input?: string | Buffer,
  /** Told the pid of the git process as soon as it exists. */
  onSpawn?: (pid: number) => void,
): Promise<Buffer> {
  const until = performance.now() + LOCK_RETRY_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await gitRunOnce(gitDir, args, env, input, onSpawn);
    } catch (err) {
      if (!(err instanceof Error) || !isLockConflict(err.message) || performance.now() > until) throw err;
      await new Promise((r) => setTimeout(r, 30 + Math.floor(Math.random() * 90) + Math.min(attempt, 10) * 20));
    }
  }
}

function gitRunOnce(
  gitDir: string,
  args: string[],
  env: Record<string, string>,
  input?: string | Buffer,
  onSpawn?: (pid: number) => void,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // git reads the names it is given (a pathspec, a list on stdin) from where it is run: from the folder of the work tree
    // the process happens to be in, not from the top of it. It is run from the top, so that a name means the same wherever
    // the agent was started. The places it is told of are made absolute first, as they were meant from where the agent is.
    const top = env.GIT_WORK_TREE !== undefined ? absolute(env.GIT_WORK_TREE) : undefined;
    const where: Record<string, string> = { ...env };
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) if (where[key] !== undefined) where[key] = absolute(where[key]!);
    const child = spawn("git", ["--git-dir=" + absolute(gitDir)].concat(args), {
      env: where,
      cwd: top !== undefined && existsSync(top) ? top : undefined,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.pid !== undefined) onSpawn?.(child.pid);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error("git " + args.join(" ") + " failed (" + code + "): " + Buffer.concat(err).toString().slice(0, 300)));
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function gitText(gitDir: string, args: string[], env: Record<string, string>, onSpawn?: (pid: number) => void): Promise<string> {
  return (await gitRun(gitDir, args, env, undefined, onSpawn)).toString("utf8").trim();
}

// Directories inside the work tree that are themselves git repositories.
//
// The fleet leaves them alone: it does not mirror them and does not reach
// inside them. A nested repository keeps its own history, and a snapshot
// that reached into it would either duplicate that history or destroy it.
//
export function findNestedRepos(work: string, maxDepth = 6): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === ".git") continue;
      const full = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      if (existsSync(join(full, ".git"))) {
        // The paths are handed to git, which speaks forward slashes on
        // every platform: a Windows separator would name nothing.
        found.push(relative(work, full).split(sep).join("/"));
        continue; // a nested repository is a boundary; do not descend
      }
      walk(full, depth + 1);
    }
  };
  walk(work, 0);
  return found;
}

/**
 * How long a walk for nested repositories is trusted when the watcher has said
 * nothing. The watcher catches the changes that matter at once; this only
 * bounds how long a change it could not see (a directory that holds a
 * repository moved as a whole) can go unnoticed.
 */
export const NESTED_REPOS_TTL_MS = 30_000;

/**
 * The nested repositories of one work tree, found once and remembered.
 *
 * Finding them walks the whole tree, ignored directories included, and a
 * snapshot or a pull asks every time. The answer changes only when somebody
 * creates, removes or moves a repository, and that shows up as a change under a
 * `.git` path, so the walk is repeated then and otherwise every
 * `NESTED_REPOS_TTL_MS`. The answer is the same one `findNestedRepos` gives.
 */
export class NestedRepoCache {
  private found: string[] | null = null;
  private at = 0;
  /** Whether the last `get` walked the tree, rather than answering from memory. */
  walked = false;

  constructor(
    private readonly work: string,
    private readonly ttlMs: number = NESTED_REPOS_TTL_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  /** The nested repositories, relative to the work tree. */
  get(): string[] {
    const now = this.clock();
    // A repository that is gone from where it was is a stale answer whatever
    // the age: a missing exclusion is harmless, a wrong one is not.
    if (this.found !== null && now - this.at < this.ttlMs && this.found.every((p) => existsSync(join(this.work, p, ".git")))) {
      this.walked = false;
      return [...this.found];
    }
    this.found = findNestedRepos(this.work);
    this.at = now;
    this.walked = true;
    return [...this.found];
  }

  /** Forget the answer; the next `get` walks the tree again. */
  invalidate(): void {
    this.found = null;
  }

  /**
   * Tell the cache about a change the watcher saw.
   *
   * A repository comes or goes as a `.git` entry that appears or disappears, so
   * that is the signal - wherever it is, except at the top: the work tree's own
   * repository is not a nested one, and its files change whenever somebody runs
   * git. A directory that was created or moved is a rename of the directory
   * itself and may hold a repository deeper down (a whole `mv ~/stuff work/`),
   * which reports no event under `.git`. An event with no path says nothing, so
   * it is treated as a change.
   */
  noteChange(eventType: string | undefined, filename: string | null | undefined): void {
    if (!filename) {
      this.invalidate();
      return;
    }
    const parts = filename.split(/[\\/]/);
    if (parts[0] === ".git") return;
    if (parts[parts.length - 1] === ".git") {
      this.invalidate();
      return;
    }
    // Something inside a .git directory: a repository being used, not arriving.
    if (parts.includes(".git")) return;
    if (eventType === "rename") {
      try {
        if (statSync(join(this.work, filename)).isDirectory()) this.invalidate();
      } catch {
        // Gone already: a removal of something that is not a directory any more.
      }
    }
  }
}

// What the store's config looked like right after `ensureStore` set it up, per store:
// as long as the file is the one it wrote (same inode, size and mtime) for the same
// work tree, the three settings are still there and need not be written again.
const configured = new Map<string, { work: string; stamp: string }>();

function configStamp(gitDir: string): string | null {
  try {
    const st = statSync(join(gitDir, "config"));
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

/** Make sure prime's object store exists and points at the work tree. */
async function ensureStore(gitDir: string, work: string, env: Record<string, string>): Promise<void> {
  mkdirSync(gitDir, { recursive: true });
  const known = configured.get(gitDir);
  if (known && known.work === work && existsSync(join(gitDir, "HEAD")) && known.stamp === configStamp(gitDir)) return;
  if (!existsSync(join(gitDir, "HEAD"))) {
    await gitRun(gitDir, ["init", "-q", "--bare", gitDir], process.env as Record<string, string>);
  }
  await gitText(gitDir, ["config", "core.bare", "false"], env);
  await gitText(gitDir, ["config", "core.worktree", work], env);
  // git sets core.ignorecase on a file system that folds case (macOS, Windows), and
  // then a file renamed from Notes.md to NOTES.md is the same file to it: the snapshot
  // sees no change, the fleet keeps the old spelling, and the primary's disk drifts
  // from the fleet's tree. The store follows the names on disk exactly instead (see
  // `reconcileCase` for the one thing that costs).
  await gitText(gitDir, ["config", "core.ignorecase", "false"], env);
  // Commits need an author; the store's own, so the user's git config is not needed.
  await gitText(gitDir, ["config", "user.email", "fleet@prime"], env);
  await gitText(gitDir, ["config", "user.name", "prime fleet"], env);
  const stamp = configStamp(gitDir);
  if (stamp) configured.set(gitDir, { work, stamp });
}

const foldsCaseCache = new Map<string, boolean>();

/** Whether this directory is on a file system that finds `Name` when asked for `NAME`. */
export function foldsCase(dir: string): boolean {
  const known = foldsCaseCache.get(dir);
  if (known !== undefined) return known;
  let folds = false;
  try {
    const name = basename(dir);
    const swapped = name === name.toLowerCase() ? name.toUpperCase() : name.toLowerCase();
    if (swapped !== name) {
      // The directory's own name, in the other case, if it has one: nothing is written.
      const same = statSync(join(dir, "..", swapped));
      const own = statSync(dir);
      folds = same.ino === own.ino && same.dev === own.dev;
    } else {
      // A name with no letters in it (`2024`) cannot be asked for in the other case: a file
      // made for the purpose can, and is gone again.
      folds = foldsCaseInside(dir);
    }
  } catch {
    folds = false;
  }
  foldsCaseCache.set(dir, folds);
  return folds;
}

// The probe is made beside the directory (same file system, and not in a tree that `git add -A` of
// another process - `prime fleets sync` - may be listing at that moment); only a parent that cannot
// be written to makes it go inside.
function foldsCaseInside(dir: string): boolean {
  const name = ".prime-Case-probe-" + process.pid + "-" + Date.now();
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch {
    return false; // not there: it cannot be asked about
  }
  for (const where of [join(dir, ".."), dir]) {
    const probe = join(where, name);
    try {
      writeFileSync(probe, "");
      const slash = probe.lastIndexOf("/") + 1;
      const lower = probe.slice(0, slash) + probe.slice(slash).toLowerCase();
      const a = statSync(probe);
      const b = statSync(lower);
      return a.ino === b.ino && a.dev === b.dev;
    } catch {
      // Could not be made here (or looked at): try the next place.
    } finally {
      rmSync(probe, { force: true });
    }
  }
  return false;
}

// On a file system that folds case, `git add -A` after a case-only rename finds the old
// spelling still "there" (asking for it finds the renamed file) and the new one as a new
// path: the index holds both. The old spelling is not a file on disk any more - the
// directory listing says so - and goes.
async function reconcileCase(work: string, gitDir: string, env: Record<string, string>): Promise<void> {
  const listed = (await gitRun(gitDir, ["ls-files", "-z"], env)).toString("utf8").split("\u0000").filter(Boolean);
  const byFolded = new Map<string, string[]>();
  for (const path of listed) {
    const key = path.normalize("NFC").toLowerCase();
    const group = byFolded.get(key);
    if (group) group.push(path);
    else byFolded.set(key, [path]);
  }
  // Names as the directory lists them, in NFC: git keeps index paths in NFC on macOS
  // (core.precomposeunicode) while APFS hands back whatever bytes the name was created
  // with, so a directory made with a decomposed name never matches byte for byte. null:
  // the directory could not be read, which says nothing about what is in it.
  const names = new Map<string, Set<string> | null>();
  const here = (dir: string): Set<string> | null => {
    let set = names.get(dir);
    if (set === undefined) {
      try {
        set = new Set(readdirSync(dir).map((name) => name.normalize("NFC")));
      } catch {
        set = null;
      }
      names.set(dir, set);
    }
    return set;
  };
  // Whether the path is on disk under exactly this spelling. A directory that cannot be
  // listed counts as "yes": the entry is kept rather than dropped on a guess.
  const exact = (path: string): boolean => {
    let dir = work;
    for (const part of path.split("/")) {
      const set = here(dir);
      if (set === null) return true;
      if (!set.has(part.normalize("NFC"))) return false;
      dir = join(dir, part);
    }
    return true;
  };
  const stale: string[] = [];
  for (const group of byFolded.values()) {
    if (group.length < 2) continue;
    const gone = group.filter((path) => !exact(path));
    // Every spelling "gone" means this check cannot tell them apart (a name it does
    // not understand), not that the file is gone: a real file is never dropped for it.
    if (gone.length < group.length) stale.push(...gone);
  }
  if (stale.length > 0) {
    await gitRun(gitDir, ["update-index", "--force-remove", "-z", "--stdin"], env, stale.join("\u0000") + "\u0000");
  }
}

/** Whether prime's object store has this commit (and so its tree and what it needs to build on it). */
export async function hasCommit(gitDir: string, commit: string | null | undefined): Promise<boolean> {
  if (!commit || !OBJECT_ID.test(commit)) return false;
  try {
    await gitRun(gitDir, ["cat-file", "-e", commit + "^{commit}"], process.env as Record<string, string>);
    return true;
  } catch {
    return false;
  }
}

/** Whether the work tree holds any file at all. */
export function hasFiles(work: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(work);
  } catch {
    return false;
  }
  for (const name of entries) {
    if (name === ".git") continue;
    const full = join(work, name);
    try {
      if (statSync(full).isDirectory()) {
        if (hasFiles(full)) return true;
        continue;
      }
      return true;
    } catch {}
  }
  return false;
}

let pathspecFileSupport: boolean | undefined;

/** Whether this git can read pathspecs from a file (`add --pathspec-from-file`: git 2.25 and later). */
async function canReadPathspecFile(): Promise<boolean> {
  if (pathspecFileSupport !== undefined) return pathspecFileSupport;
  try {
    const out = await new Promise<string>((resolve, reject) =>
      execFile("git", ["--version"], { env: process.env, timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))),
    );
    const m = /git version (\d+)\.(\d+)/.exec(out);
    pathspecFileSupport = m !== null && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 25));
  } catch {
    pathspecFileSupport = false;
  }
  return pathspecFileSupport;
}

/**
 * The most paths staged or looked at one by one: git matches every named path against every entry of the index, so the cost
 * is paths times files, and past a few hundred (at 100 000 files: 3000 paths took 14 s against 2.7 s for the whole tree) the
 * whole tree is cheaper. Measured break-even: 150 to 300 paths at 100 000 files, under 100 at 10 000.
 */
export const MAX_STAGED_PATHS = 256;

/** The most bytes of names put on a command line (Windows allows 32 767 characters in all, macOS about 1 MiB). */
export const MAX_NAMED_BYTES = 24_000;

/** Whether this many names of this many bytes are worth naming (and fit on a command line). */
export function worthNaming(paths: readonly string[]): boolean {
  if (paths.length > MAX_STAGED_PATHS) return false;
  let bytes = 0;
  for (const p of paths) bytes += Buffer.byteLength(p) + 12;
  return bytes <= MAX_NAMED_BYTES;
}

/**
 * Stage only the named paths: what exists is added (a directory with everything in it that is not ignored, deletions
 * inside it included), and what is gone is taken out of the index, with everything below it. Returns false when it did
 * not (or could not) do it, so that the caller stages the whole tree instead; the index is then still brought right by
 * that, since staging only ever adds what is true of the work tree.
 */
async function stagePaths(gitDir: string, work: string, env: Record<string, string>, paths: string[], left: string[]): Promise<boolean> {
  if (!worthNaming(paths) || !(await canReadPathspecFile())) return false;
  const present: string[] = [];
  const absent: string[] = [];
  const fold = foldsCase(work);
  for (const rel of new Set(paths)) {
    if (rel === "" || rel === "." || rel.split("/").includes(".git") || isLeftAlone(rel, left, fold)) continue;
    // git on macOS keeps names precomposed (NFC) while the file system and the watcher say what the name was made with:
    // a path that is gone is named both ways (what matches nothing is left alone: `--ignore-unmatch`), one that is there as
    // the precomposed one. Elsewhere a name is what it is.
    const nfc = process.platform === "darwin" ? rel.normalize("NFC") : rel;
    try {
      lstatSync(join(work, rel));
      present.push(nfc);
    } catch {
      absent.push(rel);
      if (nfc !== rel) absent.push(nfc);
    }
  }
  // Names are taken as they are: `:x` and `*` are files here, not pathspecs.
  const literal = { ...env, GIT_LITERAL_PATHSPECS: "1" };
  const list = (names: string[]): string => names.join("\u0000") + "\u0000";
  try {
    if (absent.length > 0) {
      await gitRun(gitDir, ["rm", "-r", "-f", "--cached", "-q", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"], literal, list(absent));
    }
    if (present.length > 0) {
      await gitRun(gitDir, ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], literal, list(present));
    }
    return true;
  } catch {
    // A path that is ignored (git will not add it by name), one that went between looking and adding, anything else:
    // the whole tree is staged, which is what is done without paths.
    return false;
  }
}

// Take a snapshot of the work tree.
//
// The index is a temporary file, so the user's index, refs, HEAD and working
// tree are all left exactly as they were. The snapshot is a commit in
// prime's own object store.
//
export async function snapshot(opts: SnapshotOptions): Promise<Snapshot> {
  const { work, gitDir } = opts;
  const indexFile = join(gitDir, "snapshot.index");
  const env = gitEnv(gitDir, work, indexFile);
  await ensureStore(gitDir, work, env);

  let tree: string;
  if (opts.tree !== undefined) {
    if (!OBJECT_ID.test(opts.tree)) throw new Error("not a tree: " + opts.tree);
    tree = opts.tree;
  } else {
    // Nested repositories are excluded: the fleet does not mirror them.
    const stage = async (): Promise<void> => {
      const excluded = new Set(opts.exclude ?? []);
      for (const nested of opts.nested ? opts.nested.get() : findNestedRepos(work)) excluded.add(nested);
      const left = [...excluded];
      // A path the fleet leaves alone may already be in the index, from before it
      // became a nested repository (or was excluded): add -A with an exclusion
      // leaves such entries as they were, and the old contents would be
      // published for ever. (-f: the index is only this store's, and a file that was changed since it
      // was staged is not a reason to keep it: without it git refuses to drop an entry that differs
      // from both the file and the last commit.)
      if (left.length > 0) {
        await gitText(gitDir, ["rm", "-r", "-f", "--cached", "-q", "--ignore-unmatch", "--"].concat(left.map((p) => ":(literal)" + p)), env);
      }
      if (opts.paths !== undefined && (await stagePaths(gitDir, work, env, opts.paths, left))) return;
      await gitText(gitDir, ["add", "-A", "--", "."].concat(left.map((p) => ":(exclude)" + p)), env);
    };
    try {
      await stage();
    } catch (err) {
      // A repository with no commit cannot be added at all, and one that arrived
      // since the cache last looked is exactly that case: look again, once.
      if (!opts.nested || !/does not have a commit checked out|unable to index/.test(String(err))) throw err;
      opts.nested.invalidate();
      await stage();
    }
    if (foldsCase(work)) await reconcileCase(work, gitDir, env);

    // A repository that arrived since the cache last looked, and has a commit,
    // is added as a gitlink: a pointer to history this fleet does not carry. It
    // is taken out again here, whatever the cache knew, and the cache is told.
    if (opts.nested && !opts.nested.walked) {
      const staged = (await gitRun(gitDir, ["ls-files", "-z", "--stage"], env)).toString("utf8").split("\u0000");
      const links = staged.filter((e) => e.startsWith("160000 ")).map((e) => e.slice(e.indexOf("\t") + 1));
      if (links.length > 0) {
        await gitRun(gitDir, ["update-index", "--force-remove", "-z", "--stdin"], env, links.join("\u0000") + "\u0000");
        opts.nested.invalidate();
      }
    }

    tree = await gitText(gitDir, ["write-tree"], env);
    if (tree === EMPTY_TREE && hasFiles(work)) {
      // The work tree has files and the tree does not: the add did not take.
      // An empty tree on its own is fine - a workspace can be empty, and a
      // fresh fleet has nothing to publish.
      throw new Error("the snapshot produced an empty tree; nothing was added");
    }
  }

  const parent = opts.base ?? null;
  // A snapshot that goes out as a whole tree names no parent. Its pack holds
  // only its own objects, so a member that takes it in has a commit whose parent
  // it never got; any git that later walks that commit's history (older clients
  // build their whole packs by walking it) would stop at the missing parent. With
  // none, there is nothing to miss. The change since the snapshot before is
  // built against that snapshot's tree instead (see below).
  const wholeTree = opts.wantFull === true;
  const commitArgs = ["commit-tree", tree];
  if (parent && !wholeTree) commitArgs.push("-p", parent);
  commitArgs.push("-m", "fleet snapshot");
  const commit = await gitText(gitDir, commitArgs, env);

  // Only the pack that is needed is built. Building both costs twice the git
  // work, and the common case is that only one of them travels.
  //
  // The whole-tree pack is the snapshot's own objects: its commit, its trees and
  // its blobs. Naming only the commit to pack-objects would walk the commit's
  // ancestors too, and the pack would carry every snapshot the fleet ever made:
  // it would grow with the history instead of with the tree.
  const pack =
    opts.treeOnly || opts.wantFull === false
      ? Buffer.alloc(0)
      : await gitRun(
          gitDir,
          ["pack-objects", "--stdout"],
          env,
          await gitRun(gitDir, ["rev-list", "--objects", "--no-walk", commit], env),
        );

  // The delta against the previous snapshot: only what changed. A member
  // that already has the previous snapshot can apply it on its own.
  const delta =
    opts.treeOnly || (opts.wantFull === true && !opts.withDelta) || !parent
      ? null
      : await gitRun(
          gitDir,
          ["pack-objects", "--stdout", "--revs", "--thin"],
          env,
          // A parentless commit has no history to subtract: naming the snapshot
          // before it would not mark its objects as already held, and the pack
          // would carry the whole tree. Its tree does.
          commit + "\n^" + parent + (wholeTree ? "^{tree}" : "") + "\n",
        );

  // Keep the snapshot commit reachable, or the next garbage collection
  // would take the objects the next delta is built against.
  if (opts.seq !== undefined) {
    await gitText(gitDir, ["update-ref", "refs/prime/snapshots/" + opts.seq, commit], env);
  }
  return { commit, tree, parent, pack, delta };
}

const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Whether a path is one of the directories the fleet leaves alone, or inside one. */
/**
 * Whether a path is inside one of the directories the fleet leaves alone. Where the file system
 * folds case (or normalisation), `Lib` and `lib` are one directory, so they are compared that way.
 */
export function isLeftAlone(rel: string, keep: string[], fold = false): boolean {
  const same = fold ? (a: string) => a.normalize("NFC").toLowerCase() : (a: string) => a;
  const path = same(rel);
  return keep.some((k) => {
    const dir = same(k);
    return path === dir || path.startsWith(dir + "/");
  });
}

// The paths the fleet put in the work tree before and takes out now.
//
// This is a tree diff, not a walk of the work tree: it costs what changed, and
// it can only ever name a path the fleet itself once wrote. A file the fleet
// never tracked (.env, node_modules, a build output, a note the person made)
// is never on the list.
//
export async function removedBetween(
  gitDir: string,
  env: Record<string, string>,
  previous: string | null | undefined,
  commit: string,
): Promise<string[]> {
  // No record of what this member held: the first apply, or a store that lost
  // it. Nothing is removed then. A stray file is better than a lost one: the
  // fleet cannot tell its own files from the person's, and the next apply that
  // does have a record will remove what the primary deleted from then on.
  if (!previous || previous === commit || !OBJECT_ID.test(previous)) return [];
  try {
    await gitText(gitDir, ["cat-file", "-e", previous + "^{tree}"], env);
  } catch {
    return [];
  }
  const out = await gitRun(
    gitDir,
    ["diff-tree", "-r", "--name-only", "--no-renames", "--diff-filter=D", "-z", previous, commit],
    env,
  );
  return out.toString("utf8").split("\u0000").filter(Boolean);
}

// Remove a file the fleet no longer has, and the directories that leaves empty.
//
// The path names a file inside the work tree, and it has to stay there: a
// directory the fleet (or the replica's owner) turned into a symlink would
// carry a removal out of the work tree to whatever it points at. Every
// directory on the way is looked at without following links, and a path
// through anything that is not a plain directory is left alone, as git does.
function removeTracked(work: string, rel: string): void {
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return;
  const dirs: string[] = [work];
  for (let i = 0; i < parts.length - 1; i++) {
    const next = join(dirs[dirs.length - 1]!, parts[i]!);
    try {
      if (!lstatSync(next).isDirectory()) return;
    } catch {
      return;
    }
    dirs.push(next);
  }
  const full = join(dirs[dirs.length - 1]!, parts[parts.length - 1]!);
  try {
    // On a file system that folds case (or normalisation) a name that differs
    // only in that way finds the same file: it is the member's own file under
    // another name, or the file the fleet has just written, and is not ours
    // to remove.
    if (!readdirSync(dirs[dirs.length - 1]!).includes(parts[parts.length - 1]!)) return;
    // A path that has become a directory (a file replaced by a folder of the
    // same name) is the new tree's, not a leftover.
    if (lstatSync(full).isDirectory()) return;
    rmSync(full, { force: true });
  } catch {
    return;
  }
  // Like git, take away a directory that the removal emptied; never one that
  // still holds something, and never the work tree itself.
  for (let i = dirs.length - 1; i >= 1; i--) {
    try {
      rmdirSync(dirs[i]!);
    } catch {
      return;
    }
  }
}

// Make the apply index say what this member's work tree holds from the fleet.
//
// read-tree compares its index with the new tree and removes whatever the
// index has and the tree lacks. That is a second deleter, and it deletes by
// what the index happens to hold: after the member was primary for a while, or
// after a half-finished apply, the index is the tree of some older apply, and
// it would take away files that are the member's own. So before every apply
// the index is brought to exactly `previous` - the tree the fleet last gave
// this member - and the directories the fleet leaves alone are taken out of it.
// Then the only entries read-tree can find that the new tree lacks are the ones
// in previous-but-not-new, which the guarded removal below has already taken
// out of the work tree and the index.
//
// The index is only rebuilt when it is not already `previous` (a sidecar file
// says which tree it was written for), so a steady replica pays nothing.
//
async function alignApplyIndex(
  gitDir: string,
  env: Record<string, string>,
  previous: string | null | undefined,
  keep: string[],
): Promise<void> {
  const indexFile = join(gitDir, "apply.index");
  const sidecar = join(gitDir, "apply.commit");
  let known = false;
  if (previous && OBJECT_ID.test(previous)) {
    try {
      await gitText(gitDir, ["cat-file", "-e", previous + "^{tree}"], env);
      known = true;
    } catch {}
  }
  if (!known) {
    // No record of what came before: the index may name anything, so it names
    // nothing, and nothing is removed.
    rmSync(indexFile, { force: true });
    rmSync(sidecar, { force: true });
    return;
  }
  let trusted = false;
  trusted = existsSync(indexFile) && readApplySidecar(gitDir)?.commit === previous;
  if (!trusted) {
    rmSync(indexFile, { force: true });
    rmSync(sidecar, { force: true });
    await gitRun(gitDir, ["read-tree", previous!], env);
    // read-tree leaves no stat data, and without it the next read-tree -u would
    // write every file again. A refresh records it; files that differ or are
    // missing make it exit non-zero, which is not a failure here.
    await gitRun(gitDir, ["update-index", "-q", "--refresh"], env).catch(() => undefined);
  }
  if (keep.length > 0) {
    const listed = await gitRun(
      gitDir,
      ["ls-files", "-z", "--cached", "--"].concat(keep.map((p) => ":(literal)" + p)),
      env,
    );
    if (listed.length > 0) await gitRun(gitDir, ["update-index", "--force-remove", "-z", "--stdin"], env, listed);
  }
}

/**
 * Take a pack into this member's object store, and touch nothing else.
 *
 * The work tree is not read or written, so a member can do this ahead of
 * time: the snapshot is verified and kept, and applied only when it is needed.
 * It is safe to repeat. `tree` is what the manifest says the snapshot's tree is;
 * a pack whose commit names another tree is refused (a pack that does not match
 * its manifest, not an authentication of either). `seq` keeps the objects
 * reachable under a ref until a garbage collection has a say.
 */
export async function ingestPack(
  work: string,
  gitDir: string,
  commit: string,
  pack: Buffer,
  opts: { tree?: string; seq?: number } = {},
): Promise<void> {
  mkdirSync(gitDir, { recursive: true });
  const env = gitEnv(gitDir, work, join(gitDir, "apply.index"));
  await ensureStore(gitDir, work, env);
  // --fix-thin: a delta pack names the objects it was built against, and
  // those live in the replica's own store from the snapshot before it.
  // Without this the pack cannot be resolved and git refuses it.
  await gitRun(gitDir, ["index-pack", "--stdin", "--fix-thin"], env, pack);
  if (opts.tree !== undefined) {
    const actual = await gitText(gitDir, ["rev-parse", commit + "^{tree}"], env);
    if (actual !== opts.tree) {
      throw new Error("the snapshot's pack does not match its manifest: the tree is " + actual + ", expected " + opts.tree);
    }
  }
  if (opts.seq !== undefined) {
    await gitText(gitDir, ["update-ref", "refs/prime/fetched/" + opts.seq, commit], env);
  }
}

/**
 * Write a snapshot that is already in the store over the work tree.
 *
 * What is removed is decided by the diff between the previous tree and the new
 * one (`removedBetween`) and carried out by `removeTracked`, before anything is
 * written: it is the one place that knows about symlinks, case folding and the
 * directories the fleet leaves alone. The apply index is aligned to the
 * previous tree first, so git's own deletion in read-tree can only ever name
 * the same set; it is a safety net for a crash, not a second opinion.
 *
 * One call covers any number of snapshots: the work tree only ever sees the
 * difference between `previous` and `commit`.
 */
export async function applyCommit(
  work: string,
  gitDir: string,
  commit: string,
  /** Directories the fleet leaves alone; their contents are not mirrored. */
  exclude?: string[],
  /** The commit (or tree) this member held before, so what the fleet dropped can be removed. */
  previous?: string | null,
): Promise<void> {
  mkdirSync(gitDir, { recursive: true });
  const env = gitEnv(gitDir, work, join(gitDir, "apply.index"));
  await ensureStore(gitDir, work, env);
  // An apply that finished writing the work tree and was stopped before the member recorded
  // it: the work tree holds that snapshot, whatever the member's state says it held.
  previous = finishedApply(gitDir, previous ?? null) ?? previous;
  // An earlier apply that was killed may still be writing (git is its own process
  // and outlives its parent): its lock on the index says so. Wait for it.
  await waitForIndexLock(join(gitDir, "apply.index.lock"));
  const keep = (exclude ?? []).map((p) => p.replace(/\/$/, ""));
  // What this apply is for is written down before the work tree is touched. An apply
  // that is killed half way leaves files of both snapshots in the work tree, and the
  // next look needs to know that those are the fleet's: see `localChanges`.
  writeFileSync(join(gitDir, "apply.target"), JSON.stringify({ from: previous ?? null, to: commit }));
  await alignApplyIndex(gitDir, env, previous, keep);
  // What goes is worked out from the two trees, and goes first: git's own
  // order is removals, then writes. A name that only changes case is then
  // removed before the new spelling is written, never after it.
  const gone = (await removedBetween(gitDir, env, previous, commit)).filter((rel) => !isLeftAlone(rel, keep, foldsCase(work)));
  for (const rel of gone) removeTracked(work, rel);
  if (gone.length > 0) {
    await gitRun(gitDir, ["update-index", "--force-remove", "-z", "--stdin"], env, gone.join("\u0000") + "\u0000");
  }
  // The sidecar goes while the index is in between; it comes back when the
  // apply is whole, so an apply that dies half way is rebuilt next time.
  rmSync(join(gitDir, "apply.commit"), { force: true });
  // The git that writes the work tree outlives an agent that is killed: its pid is written down so
  // that the next apply can tell a git that is still writing from a lock that nothing holds.
  const pidFile = join(gitDir, "apply.index.lock.pid");
  try {
    await gitText(gitDir, ["read-tree", "--reset", "-u", commit], env, (pid) => writeFileSync(pidFile, String(pid)));
  } finally {
    rmSync(pidFile, { force: true });
  }
  // What the work tree holds, and what it was brought from: see `finishedApply`.
  writeFileSync(join(gitDir, "apply.commit"), commit + "\nfrom " + (previous ?? "none") + "\n");
  rmSync(join(gitDir, "apply.target"), { force: true });
}

/** What the last finished apply wrote, and what it started from (`none` when it started from nothing, empty in a sidecar of an older build). */
export function readApplySidecar(gitDir: string): { commit: string; from: string } | null {
  try {
    const [commit, from] = readFileSync(join(gitDir, "apply.commit"), "utf8").split("\n");
    if (!commit || !OBJECT_ID.test(commit.trim())) return null;
    return { commit: commit.trim(), from: from?.startsWith("from ") ? from.slice(5).trim() : "" };
  } catch {
    return null;
  }
}

/**
 * Whether the work tree is, as far as git can tell without hashing a file that has not changed, exactly what the last
 * apply wrote: no tracked file changed or gone, and no file in it that git would add and the apply did not write.
 *
 * It is the question a replica asks before it writes a newer snapshot over the work tree, to know whether anything of the
 * member's own is there to keep. The apply index holds the tree of that apply, with what the files looked like when they
 * were written, so the answer is the work tree's stat against it (git's own racy-timestamp rules included: a file whose time
 * cannot tell is read) and a look for files it does not hold. A walk and no hashing, where a snapshot of the whole work
 * tree stages every file that looks different. False means "look closer": it is never an answer that a change is there.
 */
export async function workTreeMatchesApply(work: string, gitDir: string, commit: string | null | undefined, left?: string[]): Promise<boolean> {
  if (!commit || !OBJECT_ID.test(commit)) return false;
  try {
    // The apply index is the tree of this commit only when the last finished apply wrote this commit.
    if (readApplySidecar(gitDir)?.commit !== commit) return false;
    const indexFile = join(gitDir, "apply.index");
    if (!existsSync(indexFile) || existsSync(join(gitDir, "apply.target")) || existsSync(indexFile + ".lock")) return false;
    const env = gitEnv(gitDir, work, indexFile);
    await ensureStore(gitDir, work, env);
    // Records what the files look like now, where the stat data was never written or has gone stale; exits non-zero when a
    // file differs or is missing, which is the answer below, not a failure.
    await gitRun(gitDir, ["update-index", "-q", "--refresh"], env).catch(() => undefined);
    if ((await gitRun(gitDir, ["diff-files", "--name-only", "-z"], env)).length > 0) return false;
    // Files git would add that the apply did not write. The nested repositories (the caller's list of them, or a walk) are
    // left alone, as they are by a snapshot.
    const excluded = [...new Set(left ?? findNestedRepos(work))];
    const extra = await gitRun(
      gitDir,
      ["ls-files", "-o", "--exclude-standard", "-z", "--no-empty-directory", "--", "."].concat(excluded.map((p) => ":(exclude)" + p)),
      env,
    );
    return extra.length === 0;
  } catch {
    return false;
  }
}

/**
 * The snapshot the work tree holds when a finished apply has not been recorded.
 *
 * An apply writes the work tree, then the sidecar, and only after that does the member save its
 * state. A stop in between leaves the state at the snapshot the apply started from while the
 * work tree holds the one it wrote. The sidecar says both: it names what was written and what it
 * started from, so when that start is the member's recorded base, the base is out of date and the
 * written commit is what the work tree holds. Null when there is no such apply.
 */
export function finishedApply(gitDir: string, base: string | null): string | null {
  const done = readApplySidecar(gitDir);
  // With no base there is no record to be out of date: an apply from nothing removes nothing, as ever.
  if (done === null || base === null || done.commit === base) return null;
  return done.from === base ? done.commit : null;
}

/**
 * Run `fn` as the only one writing this member's work tree (the agent, `prime fleets sync` and a
 * takeover all do, from separate processes). What the work tree holds and what the member's
 * state says it holds are only the same if nobody else writes between the two.
 */
export function withApplyLock<T>(gitDir: string, fn: () => Promise<T> | T): Promise<T> {
  mkdirSync(gitDir, { recursive: true });
  // An apply of a very large tree takes minutes; a holder whose process is gone is not waited for.
  return withDirLock(join(gitDir, "apply.lock"), fn, { waitMs: 5 * 60_000, staleMs: 60 * 60_000 });
}

/** A lock this old, with no note of which git holds it, is a git that died: nothing writes an index for ten minutes. */
const STALE_LOCK_MS = 10 * 60_000;
/** A lock this old is nobody's even when the pid noted for it runs: after a crash or a reboot the pid is another process's. */
const PID_LOCK_MAX_MS = 60 * 60_000;

function pidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Wait until a lock file is gone (a git that was left running by an agent that was
 * killed lets go of it when it finishes). A lock that is still there when the wait is over
 * may belong to a git that is still writing the work tree - taking it away would let two
 * `read-tree -u` write one index - so the apply fails (and is tried again at the next
 * round).
 *
 * Whether a git still holds it is what the apply that started it wrote down (`<lock>.pid`, the pid
 * of the git): a lock of a git that is not running is removed at once, and one of a git that is
 * running is waited for even when the lock is older than any time that could be guessed (a huge
 * checkout, or a git suspended with the machine), but not past an hour: after a crash or a reboot the
 * pid that runs may be another process's. Only a lock with no such note (an earlier build's) falls back
 * to ten minutes.
 */
export async function waitForIndexLock(lock: string, waitMs = 15_000, staleMs = STALE_LOCK_MS): Promise<void> {
  const until = Date.now() + waitMs;
  const pidFile = lock + ".pid";
  while (existsSync(lock)) {
    let holder: number | undefined;
    try {
      const n = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
      if (Number.isInteger(n) && n > 0) holder = n;
    } catch {
      holder = undefined;
    }
    if (holder !== undefined) {
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        return;
      }
      if (!pidRunning(holder) || age > PID_LOCK_MAX_MS) {
        rmSync(lock, { force: true });
        rmSync(pidFile, { force: true });
        return;
      }
    } else {
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        return;
      }
      if (age > staleMs) {
        rmSync(lock, { force: true });
        return;
      }
    }
    if (Date.now() > until) {
      throw new Error("another git is still writing this work tree (" + lock + " is held); the apply is tried again shortly");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

// The tree an interrupted apply was writing, if one was: files of it in the work tree
// are the fleet's, not the member's. The note counts only for an apply that started from
// where this member's state says it is (`base`): a note left by an apply that finished
// (the stop came between its two last writes) describes some older move, and trusting
// it would hide edits that happen to equal the old snapshot.
async function interruptedTarget(gitDir: string, env: Record<string, string>, base: string | null): Promise<string | null> {
  try {
    const target = JSON.parse(readFileSync(join(gitDir, "apply.target"), "utf8")) as { from?: unknown; to?: unknown };
    if (typeof target.to !== "string" || !OBJECT_ID.test(target.to)) return null;
    if ((typeof target.from === "string" ? target.from : null) !== base) return null;
    return await gitText(gitDir, ["rev-parse", target.to + "^{tree}"], env);
  } catch {
    return null;
  }
}

// Apply a pack to a work tree: take it into the store, then write it out.
//
// The objects go into prime's own store, and the tree is written over the
// work tree. A replica must end up with the primary's tree for the paths the
// fleet owns: those the new snapshot has are written, and those the previous
// snapshot had and the new one does not are removed. Everything else in the
// work tree belongs to the member and is left alone.
//
export async function applyPack(
  work: string,
  gitDir: string,
  commit: string,
  pack: Buffer,
  /** Directories the fleet leaves alone; their contents are not mirrored. */
  exclude?: string[],
  /** The commit (or tree) this member held before, so what the fleet dropped can be removed. */
  previous?: string | null,
): Promise<void> {
  await ingestPack(work, gitDir, commit, pack);
  await applyCommit(work, gitDir, commit, exclude, previous);
}

/** Where to look when waiting for a work tree to settle: the store, and what the fleet leaves alone. */
export interface SettleOptions {
  /** The member's store. With it, only the files a snapshot would take are watched; without it, the whole tree is. */
  gitDir?: string;
  /** Directories the fleet leaves alone (nested repositories among them): nothing in them is waited for. */
  left?: string[];
  /**
   * Only these paths (a file, or a directory with all that is in it) are looked at, as the watcher said they were what
   * changed: the work tree is not walked. A function is asked at every look, so that a path that is noted while the wait
   * is on is waited for too.
   */
  only?: string[] | (() => string[]);
}

// The files a snapshot of this work tree would take, as git names them: what is tracked in the last
// snapshot's index and what is untracked and not ignored, without the directories that are left alone.
// git does not descend into an ignored directory, so a `node_modules` costs nothing. null: git could
// not say (no store yet), and the caller looks at everything.
async function capturedFiles(work: string, gitDir: string, left: string[], only?: string[]): Promise<string[] | null> {
  try {
    const env = gitEnv(gitDir, work, join(gitDir, "snapshot.index"));
    // `only`: the named paths, each as a name and not as a pathspec (`:x` and `*` are files here). A name with `.git` in it,
    // or one the fleet leaves alone, is not looked at.
    const fold = foldsCase(work);
    // Too many names (or too long) to put on a command line, and slower than the whole tree besides: look at all of it.
    const asked = only !== undefined && worthNaming(only) ? only : undefined;
    const named = asked?.filter((p) => p !== "" && p !== "." && !p.split("/").includes(".git") && !isLeftAlone(p, left, fold)).map((p) => ":(literal)" + p);
    if (named !== undefined && named.length === 0) return [];
    const out = await gitRun(
      gitDir,
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--"].concat(named ?? ["."], left.map((p) => ":(exclude)" + p)),
      env,
    );
    return out.toString("utf8").split("\u0000").filter((p) => p !== "");
  } catch {
    return null;
  }
}

/** How long the files a snapshot would take must have been still before it is taken, in milliseconds. */
export const SETTLE_QUIET_MS = 50;

// The longest a tree that keeps changing (a log written to all the time) is waited for.
const SETTLE_LIMIT_MS = 5000;

// How recent a change has to be to be told apart from the file's last write only by the clock: the
// timestamps of a file system are made on a tick, and a write within the tick of the one before it
// leaves the same time behind. Ticks are a few milliseconds on the file systems that keep fine times
// and a second or two on those that do not (their times are whole seconds). It is decided for each
// file by its own times: one file that was given a whole second (unpacked from an archive) says
// nothing about the rest of the tree.
const TIMESTAMP_TICK_MS = 40;
const COARSE_TICK_MS = 2000;

/**
 * What a look at the files of a work tree found: one string that changes when a file a snapshot
 * would take is written, replaced, resized or has its mode changed (its size, times and identity),
 * and whether any change is too recent for the string to be trusted.
 */
export interface TreeStamp {
  key: string;
  /**
   * A file was changed so lately, by the clock of its file system, that a write straight after would
   * leave the same stamp. Such a stamp says "nothing changed" only for as long as it is looked at
   * again later than the file's tick, never as proof for a tree that is built from it.
   */
  racy: boolean;
  /** When the last of the doubtful times is a tick old (ms since the epoch); 0 when none is. */
  racyUntil: number;
  /** The newest time of any of the files (the later of its write and its change), in ms. 0: no file. */
  newest: number;
  /** The directories left alone that it was taken with. */
  left: string[];
}

/** What a stamp needs of a file's `lstat` (a test gives it a file system with coarse times). */
export interface StatTimes {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

/**
 * Look at the files a snapshot of this work tree would take: what git would add (see `capturedFiles`),
 * by size, write time, change time and identity. null: git could not say (no store yet).
 *
 * A time later than the clock (a file dated in the future by a skewed clock or an archive) cannot hide
 * a write: the write would put the present time on it, which is a change. It is not held against the stamp.
 */
export async function stampTree(
  work: string,
  gitDir: string,
  left: string[] = [],
  stat: (path: string) => StatTimes = lstatSync,
  only?: string[],
): Promise<TreeStamp | null> {
  const files = await capturedFiles(work, gitDir, left, only);
  if (files === null) return null;
  const now = Date.now();
  const parts: string[] = [];
  let newest = 0;
  let racyUntil = 0;
  for (const rel of files) {
    try {
      const st = stat(join(work, rel));
      parts.push(rel + ":" + st.size + ":" + st.mtimeMs + ":" + st.ctimeMs + ":" + st.ino);
      // Whole seconds: a file system that does not keep finer times (or a file that was given one).
      const tick = st.mtimeMs % 1000 === 0 || st.ctimeMs % 1000 === 0 ? COARSE_TICK_MS : TIMESTAMP_TICK_MS;
      for (const t of [st.mtimeMs, st.ctimeMs]) {
        if (t > now) continue;
        if (t > newest) newest = t;
        if (now - t < tick) racyUntil = Math.max(racyUntil, t + tick);
      }
    } catch {}
  }
  return { key: parts.sort().join("|"), racy: racyUntil > 0, racyUntil, newest, left };
}

/**
 * Wait until the work tree stops changing, so a half-written file is not captured.
 *
 * It is only the files a snapshot would take that matter: a build running in an ignored folder, or
 * an IDE writing inside a nested repository's `.git`, has no effect on what is published, and
 * neither costs a look at its files nor makes this wait.
 *
 * The tree has settled when two looks `settleMs` apart found every file as it was (size, write and
 * change time, identity) and none of them was written within the last `settleMs`: a writer that
 * pauses for less than that between its writes is waited for, one that stops for longer is
 * taken to be done. On a file system whose times are whole seconds a write cannot be told from the
 * next one inside the second, so the look is repeated until the last write is older than that (up
 * to about two seconds). It gives up on a tree that never stops after a few seconds.
 *
 * Returns the stamp it settled on when it could take one (see `stampTree`), so the caller can ask later
 * whether the tree is still the one it saw; null when it could not, or the tree never settled.
 */
export async function settle(work: string, settleMs = SETTLE_QUIET_MS, opts: SettleOptions = {}, stat?: (path: string) => StatTimes): Promise<TreeStamp | null> {
  const walked = (): string => {
    const parts: string[] = [];
    const walk = (dir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        const full = join(dir, name);
        try {
          const st = statSync(full);
          if (st.isDirectory()) walk(full);
          else parts.push(name + ":" + st.size + ":" + st.mtimeMs + ":" + st.ctimeMs);
        } catch {}
      }
    };
    walk(work);
    return parts.sort().join("|");
  };
  const left = opts.left ?? [];
  // `stamp` is what a snapshot would see, when git can say; `key` alone otherwise.
  const look = async (): Promise<{ key: string; newest: number; stamp: TreeStamp | null }> => {
    const only = typeof opts.only === "function" ? opts.only() : opts.only;
    const taken = opts.gitDir ? await stampTree(work, opts.gitDir, left, stat, only) : null;
    return taken ? { key: taken.key, newest: taken.newest, stamp: taken } : { key: walked(), newest: 0, stamp: null };
  };
  const deadline = Date.now() + SETTLE_LIMIT_MS;
  let previous = await look();
  while (Date.now() < deadline) {
    // As long as the last look says (a tick of a coarse file system), if that is longer than the quiet period.
    await new Promise((r) => setTimeout(r, Math.max(settleMs, (previous.stamp?.racyUntil ?? 0) - Date.now())));
    const next = await look();
    // A file written a moment ago by the clock is not still: the writer may be between two writes.
    const lately = next.newest > 0 && next.newest <= Date.now() && Date.now() - next.newest < settleMs;
    if (next.key === previous.key && !lately && !next.stamp?.racy) return next.stamp;
    previous = next;
  }
  return null;
}

/**
 * The paths that differ from the state the fleet gave this member.
 *
 * `tree` is the tree the member recorded for the last state it took (the same
 * tree the state file keeps), so this answers "what has changed here since".
 *
 * Only paths that really differ from that tree are named: a file edited, a file
 * deleted, a file added. Files git ignores are never named, and neither is
 * anything inside a nested repository: they are not the fleet's, so they must
 * not be moved aside either.
 */
export async function localChanges(
  work: string,
  gitDir: string,
  tree: string,
  opts: {
    exclude?: string[];
    nested?: NestedRepoCache;
    /** The commit this member's state says it holds (null: none yet); an interrupted apply counts only from there. */
    base?: string | null;
  } = {},
): Promise<string[]> {
  if (!tree) return [];
  const indexFile = join(gitDir, "local-check.index");
  rmSync(indexFile, { force: true });
  const env = gitEnv(gitDir, work, indexFile);
  try {
    await ensureStore(gitDir, work, env);
    // The temporary index starts as exactly what the fleet gave us. The work
    // tree is then staged on top of it the way a snapshot does it (ignored
    // files stay out, nested repositories are left alone), and git compares
    // the result with the recorded tree. The member's own store and its
    // snapshot index are not touched.
    await gitRun(gitDir, ["read-tree", tree], env);
    const left = new Set((opts.exclude ?? []).map((p) => p.replace(/\/$/, "")));
    for (const nested of opts.nested ? opts.nested.get() : findNestedRepos(work)) left.add(nested);
    const pathspec = ["."];
    for (const path of left) pathspec.push(":(exclude)" + path);
    await gitText(gitDir, ["add", "-A", "--"].concat(pathspec), env);
    const differing = async (against: string): Promise<string[]> =>
      (await gitRun(gitDir, ["diff-index", "--cached", "--name-only", "--no-renames", "-z", against], env)).toString("utf8").split("\u0000").filter((p) => p !== "");
    let paths = await differing(tree);
    // An apply that finished and was not recorded: the work tree holds its snapshot, and nothing
    // of the one before is the fleet's any more (an edit that puts a file back as it was then is the member's).
    const finished = finishedApply(gitDir, opts.base ?? null);
    if (finished !== null) {
      const held = await gitText(gitDir, ["rev-parse", finished + "^{tree}"], env);
      const keep = [...left];
      return (await differing(held)).filter((path) => !isLeftAlone(path, keep, foldsCase(work)));
    }
    // An apply that was stopped half way left files of the snapshot it was writing beside
    // those of the one before: a file that is the same as either is the fleet's. Only what is
    // like neither is the member's own.
    const writing = await interruptedTarget(gitDir, env, opts.base ?? null);
    if (writing !== null && writing !== tree) {
      const notTarget = new Set(await differing(writing));
      paths = paths.filter((p) => notTarget.has(p));
    }
    const keep = [...left];
    return paths.filter((path) => !isLeftAlone(path, keep, foldsCase(work)));
  } finally {
    rmSync(indexFile, { force: true });
  }
}

/**
 * Move this member's local changes aside so the mirror can be updated.
 *
 * The work tree is the fleet's, and a mirror that was edited cannot be updated
 * without throwing the edit away. So the edit is not deleted: it is moved to a
 * folder beside the work tree, the path it came from is recorded, and the pull
 * that follows brings the mirror up to the fleet's state. The person can move
 * anything back with a single `mv`.
 */
export async function preserveLocalChange(
  work: string,
  gitDir: string,
  tree: string,
  opts: { exclude?: string[]; nested?: NestedRepoCache; base?: string | null } = {},
): Promise<{ moved: number; to: string }> {
  const changed = await localChanges(work, gitDir, tree, opts);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const to = join(work, "..", "local-change-" + stamp);
  let moved = 0;
  for (const path of changed) {
    const from = join(work, path);
    if (!existsSync(from)) continue;
    const dest = join(to, path);
    mkdirSync(join(dest, ".."), { recursive: true });
    try {
      renameSync(from, dest);
      moved++;
    } catch {
      // A path that cannot be moved (a busy file) stays where it is: the pull
      // below will report the conflict instead of silently dropping anything.
    }
  }
  return { moved, to };
}

