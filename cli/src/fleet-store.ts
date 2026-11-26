// Keeping the member's object store small.
//
// Every snapshot adds objects to prime's store and a ref that keeps them, and
// nothing ever took them away: after a year of edits the store held every
// version of every file the fleet had carried. What a member still needs is
// little:
//   - the snapshot its work tree holds (to know what the fleet dropped), and
//   - the newest snapshot it has fetched (the next change is built against it),
//   - and whatever its indexes name, so that a stat cache is never left pointing
//     at an object that is gone.
// Only the trees of those snapshots are needed, never their history.
//
// Git's own `gc` is not used: it walks every commit's parents, and a snapshot
// that arrived in a whole-tree pack names a parent this member never had, which
// it cannot get past. Here the objects of the snapshots to keep are written to a
// new pack by name, and the rest is let go once it is old enough that nothing
// in flight can still want it.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** The size the object store may grow to before it is collected, in megabytes. */
export function cacheLimitMb(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.PRIME_FLEET_CACHE_MB);
  return Number.isFinite(n) && n > 0 ? n : 512;
}

/** How old an object has to be before it is let go. Anything younger may be in use. */
export const COLLECT_GRACE_MS = 10 * 60_000;

function git(gitDir: string, args: string[], env: Record<string, string | undefined>, input?: string | Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--git-dir=" + gitDir].concat(args), {
      env: { ...process.env, ...env, GIT_DIR: gitDir } as Record<string, string>,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error("git " + args.join(" ") + " failed (" + code + "): " + Buffer.concat(err).toString().slice(0, 200)));
    });
    child.stdin.end(input);
  });
}

function sizeOf(dir: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const full = join(dir, name);
    try {
      const st = statSync(full);
      total += st.isDirectory() ? sizeOf(full) : st.size;
    } catch {}
  }
  return total;
}

/** How many bytes the object store takes. */
export function storeBytes(gitDir: string): number {
  return sizeOf(join(gitDir, "objects"));
}

const PRUNABLE_REFS = ["refs/prime/snapshots/", "refs/prime/fetched/"];

/**
 * Let go of everything the member no longer needs.
 *
 * `keep` is the commits of the snapshots to keep (the one the work tree holds,
 * the newest fetched, the last published): their trees stay, and so do the
 * trees the member's indexes name. The refs of every other snapshot are
 * deleted, a new pack with just those objects is written, and the older packs
 * and loose objects go. Nothing younger than the grace period is touched, and
 * the new pack is complete before anything is removed, so a crash leaves a store
 * with some garbage in it and nothing missing.
 *
 * Returns the sizes before and after, or null when there was nothing to keep.
 */
export async function collectStore(
  gitDir: string,
  keep: Array<string | null | undefined>,
  now: number = Date.now(),
): Promise<{ before: number; after: number } | null> {
  const before = storeBytes(gitDir);
  const roots = new Set<string>();
  for (const commit of keep) {
    if (!commit || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) continue;
    try {
      await git(gitDir, ["cat-file", "-e", commit + "^{commit}"], {});
      roots.add(commit);
    } catch {}
  }
  if (roots.size === 0) return null;

  // The refs of the snapshots that are not kept go; the kept ones stay.
  const refs = (await git(gitDir, ["for-each-ref", "--format=%(refname) %(objectname)"].concat(PRUNABLE_REFS), {})).toString("utf8");
  for (const line of refs.split("\n")) {
    const [name, value] = line.split(" ");
    if (name && value && !roots.has(value)) await git(gitDir, ["update-ref", "-d", name], {});
  }

  // What the member's indexes point at must survive too: a stat cache that
  // trusts an entry whose object is gone cannot write a tree. Each index is
  // written out as a tree and named by a ref, and its objects are listed with
  // the rest.
  for (const name of ["snapshot.index", "apply.index"]) {
    const file = join(gitDir, name);
    if (!existsSync(file)) continue;
    try {
      const tree = (await git(gitDir, ["write-tree"], { GIT_INDEX_FILE: file })).toString("utf8").trim();
      await git(gitDir, ["update-ref", "refs/prime/keep/" + name.replace(/\.index$/, ""), tree], {});
    } catch {
      // An index that cannot be written (it names something missing) is
      // thrown away: it is only a cache.
      rmSync(file, { force: true });
    }
  }
  const named = (await git(gitDir, ["for-each-ref", "--format=%(objectname)", "refs/prime/keep/"], {})).toString("utf8").split("\n").filter(Boolean);
  const wanted = [...roots, ...named];

  const listed = await git(gitDir, ["rev-list", "--objects", "--no-walk", "--stdin"], {}, wanted.join("\n") + "\n");
  const packDir = join(gitDir, "objects", "pack");
  const fresh = (await git(gitDir, ["pack-objects", join(packDir, "pack")], {}, listed)).toString("utf8").trim();
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(fresh)) throw new Error("the new pack was not written");

  // The new pack is whole. Now the rest may go - what is old enough.
  const old = (file: string): boolean => {
    try {
      return now - statSync(file).mtimeMs > COLLECT_GRACE_MS;
    } catch {
      return false;
    }
  };
  for (const name of readdirSync(packDir)) {
    if (name.includes(fresh)) continue;
    const full = join(packDir, name);
    if (/\.(pack|idx|rev|bitmap|keep|mtimes)$/.test(name) && old(full)) rmSync(full, { force: true });
  }
  for (const dir of readdirSync(join(gitDir, "objects"))) {
    if (!/^[0-9a-f]{2}$/.test(dir)) continue;
    const full = join(gitDir, "objects", dir);
    for (const name of readdirSync(full)) {
      if (old(join(full, name))) rmSync(join(full, name), { force: true });
    }
    try {
      if (readdirSync(full).length === 0) rmSync(full, { recursive: true, force: true });
    } catch {}
  }
  return { before, after: storeBytes(gitDir) };
}
