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
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface Snapshot {
  /** Commit that names the tree. */
  commit: string;
  tree: string;
  parent: string | null;
  /**
   * Self-contained pack: the replica can apply it without any history.
   *
   * It carries the whole tree, so it is what a member that joins later needs.
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
  /** Build no pack at all: the caller only wants to know the tree. */
  treeOnly?: boolean;
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

/** Make sure prime's object store exists and points at the work tree. */
async function ensureStore(gitDir: string, work: string, env: Record<string, string>): Promise<void> {
  mkdirSync(gitDir, { recursive: true });
  if (!existsSync(join(gitDir, "HEAD"))) {
    await gitRun(gitDir, ["init", "-q", "--bare", gitDir], process.env as Record<string, string>);
  }
  await gitText(gitDir, ["config", "core.bare", "false"], env);
  await gitText(gitDir, ["config", "core.worktree", work], env);
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
  await gitText(gitDir, ["config", "user.email", "fleet@prime"], env);
  await gitText(gitDir, ["config", "user.name", "prime fleet"], env);

  // Nested repositories are excluded: the fleet does not mirror them.
  const excluded = new Set(opts.exclude ?? []);
  for (const nested of findNestedRepos(work)) excluded.add(nested);

  const pathspec: string[] = ["."];
  for (const path of excluded) pathspec.push(":(exclude)" + path);
  await gitText(gitDir, ["add", "-A", "--"].concat(pathspec), env);

  const tree = await gitText(gitDir, ["write-tree"], env);
  if (tree === EMPTY_TREE && hasFiles(work)) {
    // The work tree has files and the tree does not: the add did not take.
    // An empty tree on its own is fine - a workspace can be empty, and a
    // fresh fleet has nothing to publish.
    throw new Error("the snapshot produced an empty tree; nothing was added");
  }

  const parent = opts.base ?? null;
  const commitArgs = ["commit-tree", tree];
  if (parent) commitArgs.push("-p", parent);
  commitArgs.push("-m", "fleet snapshot");
  const commit = await gitText(gitDir, commitArgs, env);

  // Only the pack that is needed is built. Building both costs twice the git
  // work, and the common case is that only one of them travels.
  const pack =
    opts.treeOnly || opts.wantFull === false
      ? Buffer.alloc(0)
      : await gitRun(gitDir, ["pack-objects", "--stdout", "--revs"], env, commit + "\n");

  // The delta against the previous snapshot: only what changed. A member
  // that already has the previous snapshot can apply it on its own.
  const delta =
    opts.treeOnly || opts.wantFull === true || !parent
      ? null
      : await gitRun(gitDir, ["pack-objects", "--stdout", "--revs", "--thin"], env, commit + "\n^" + parent + "\n");

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

// Apply a pack to a work tree.
//
// The objects go into prime's own store, and the tree is written over the
// work tree. Files the snapshot does not contain are removed: a replica
// must end up with the primary's tree, not with a merge of the two.
//
export async function applyPack(
  work: string,
  gitDir: string,
  commit: string,
  pack: Buffer,
  /** Directories the fleet leaves alone; their contents are not mirrored. */
  exclude?: string[],
): Promise<void> {
  mkdirSync(gitDir, { recursive: true });
  const env = gitEnv(gitDir, work, join(gitDir, "apply.index"));
  await ensureStore(gitDir, work, env);
  // --fix-thin: a delta pack names the objects it was built against, and
  // those live in the replica's own store from the snapshot before it.
  // Without this the pack cannot be resolved and git refuses it.
  await gitRun(gitDir, ["index-pack", "--stdin", "--fix-thin"], env, pack);
  await gitText(gitDir, ["read-tree", "--reset", "-u", commit], env);
  // read-tree only writes what the tree contains. A file the primary deleted
  // is still sitting in the replica, so the replica would keep it forever.
  // Remove anything the tree does not have, except the paths the fleet leaves
  // alone: those belong to the member, not to the fleet.
  const wanted = new Set(
    (await gitText(gitDir, ["ls-tree", "-r", "--name-only", commit], env))
      .split("\n")
      .filter(Boolean),
  );
  const keep = new Set((exclude ?? []).map((p) => p.replace(/\/$/, "")));
  const stray: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      const rel = prefix ? prefix + "/" + name : name;
      if (keep.has(rel)) continue;
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(full, rel);
        continue;
      }
      if (!wanted.has(rel)) stray.push(full);
    }
  };
  walk(work, "");
  for (const file of stray) {
    try {
      rmSync(file, { force: true });
    } catch {}
  }
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
 */
export async function localChanges(work: string, gitDir: string, tree: string): Promise<string[]> {
  if (!tree) return [];
  const indexFile = join(gitDir, "local-check.index");
  rmSync(indexFile, { force: true });
  const env = gitEnv(gitDir, work, indexFile);
  await ensureStore(gitDir, work, env);
  // Stage exactly what the fleet gave us, then let git say what differs. The
  // temporary index is thrown away afterwards; the member's own store is not
  // touched.
  await gitRun(gitDir, ["read-tree", tree], env);
  const out = (await gitRun(gitDir, ["status", "--porcelain", "-z", "--", "."], env)).toString("utf8");
  const paths = new Set<string>();
  let i = 0;
  while (i < out.length) {
    const end = out.indexOf("\u0000", i);
    if (end < 0) break;
    const entry = out.slice(i, end);
    i = end + 1;
    // "XY <path>", and a rename carries a second NUL-terminated path.
    const path = entry.slice(3);
    if (path) paths.add(path);
    if (entry[0] === "R" || entry[0] === "C") {
      const endSecond = out.indexOf("\u0000", i);
      if (endSecond >= 0) paths.add(out.slice(i, endSecond));
      i = endSecond + 1;
    }
  }
  rmSync(indexFile, { force: true });
  return [...paths].filter(Boolean);
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
): Promise<{ moved: number; to: string }> {
  const changed = await localChanges(work, gitDir, tree);
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

