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

import { createHash, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

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
  /** Remembered nested repositories of this work tree, to spare the walk. */
  nested?: NestedRepoCache;
}

function gitEnv(gitDir: string, work: string, indexFile: string): Record<string, string> {
  return {
    ...process.env,
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
function gitRun(
  gitDir: string,
  args: string[],
  env: Record<string, string>,
  input?: string | Buffer,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--git-dir=" + gitDir].concat(args), { env, stdio: ["pipe", "pipe", "pipe"] });
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

async function gitText(gitDir: string, args: string[], env: Record<string, string>): Promise<string> {
  return (await gitRun(gitDir, args, env)).toString("utf8").trim();
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

function foldsCaseInside(dir: string): boolean {
  const probe = join(dir, ".prime-Case-probe-" + process.pid + "-" + Date.now());
  try {
    writeFileSync(probe, "");
    const slash = probe.lastIndexOf("/") + 1;
    const lower = probe.slice(0, slash) + probe.slice(slash).toLowerCase();
    const a = statSync(probe);
    const b = statSync(lower);
    return a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  } finally {
    rmSync(probe, { force: true });
  }
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

  // Nested repositories are excluded: the fleet does not mirror them.
  const stage = async (): Promise<void> => {
    const excluded = new Set(opts.exclude ?? []);
    for (const nested of opts.nested ? opts.nested.get() : findNestedRepos(work)) excluded.add(nested);
    const left = [...excluded];
    // A path the fleet leaves alone may already be in the index, from before it
    // became a nested repository (or was excluded): add -A with an exclusion
    // leaves such entries as they were, and the old contents would be
    // published for ever.
    if (left.length > 0) {
      await gitText(gitDir, ["rm", "-r", "--cached", "-q", "--ignore-unmatch", "--"].concat(left.map((p) => ":(literal)" + p)), env);
    }
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

  const tree = await gitText(gitDir, ["write-tree"], env);
  if (tree === EMPTY_TREE && hasFiles(work)) {
    // The work tree has files and the tree does not: the add did not take.
    // An empty tree on its own is fine - a workspace can be empty, and a
    // fresh fleet has nothing to publish.
    throw new Error("the snapshot produced an empty tree; nothing was added");
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

export interface Sealed {
  /** The sealed pack. */
  ciphertext: Buffer;
  /** The random key that opened it, in the clear: only for local use. */
  key: Buffer;
}

/** Seal a pack with a fresh random key. */
export function seal(plain: Buffer): Sealed {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { ciphertext: Buffer.concat([iv, body, cipher.getAuthTag()]), key };
}

/** Open a sealed pack. */
export function unseal(sealed: Buffer, key: Buffer): Buffer {
  if (sealed.length < 12 + 16) throw new Error("the sealed payload is too short to be valid");
  const iv = sealed.subarray(0, 12);
  const tag = sealed.subarray(sealed.length - 16);
  const body = sealed.subarray(12, sealed.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** A stable id for a payload, used as its storage key. */
export function payloadId(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Whether a path is one of the directories the fleet leaves alone, or inside one. */
function isLeftAlone(rel: string, keep: string[]): boolean {
  return keep.some((k) => rel === k || rel.startsWith(k + "/"));
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
  const gone = (await removedBetween(gitDir, env, previous, commit)).filter((rel) => !isLeftAlone(rel, keep));
  for (const rel of gone) removeTracked(work, rel);
  if (gone.length > 0) {
    await gitRun(gitDir, ["update-index", "--force-remove", "-z", "--stdin"], env, gone.join("\u0000") + "\u0000");
  }
  // The sidecar goes while the index is in between; it comes back when the
  // apply is whole, so an apply that dies half way is rebuilt next time.
  rmSync(join(gitDir, "apply.commit"), { force: true });
  await gitText(gitDir, ["read-tree", "--reset", "-u", commit], env);
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

/** A lock this old is a git that died: nothing writes an index for ten minutes. */
const STALE_LOCK_MS = 10 * 60_000;

/**
 * Wait until a lock file is gone (a git that was left running by an agent that was
 * killed lets go of it when it finishes). A lock that is still there when the wait is over
 * may belong to a git that is still writing the work tree - taking it away would let two
 * `read-tree -u` write one index - so the apply fails (and is tried again at the next
 * round) unless the lock is so old that nothing can be holding it.
 */
export async function waitForIndexLock(lock: string, waitMs = 15_000, staleMs = STALE_LOCK_MS): Promise<void> {
  const until = Date.now() + waitMs;
  while (existsSync(lock)) {
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

/** Wait until the work tree stops changing, so a half-written file is not captured. */
export async function settle(work: string, settleMs = 120): Promise<void> {
  const stamp = (): string => {
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
          else parts.push(name + ":" + st.size + ":" + st.mtimeMs);
        } catch {}
      }
    };
    walk(work);
    return parts.sort().join("|");
  };
  let previous = stamp();
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((r) => setTimeout(r, settleMs));
    const next = stamp();
    if (next === previous) return;
    previous = next;
  }
}

export function timingSafeEqualBytes(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
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
      return (await differing(held)).filter((path) => !isLeftAlone(path, keep));
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
    return paths.filter((path) => !isLeftAlone(path, keep));
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

