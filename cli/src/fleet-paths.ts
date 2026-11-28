// Whether two spellings of a path are the same place.

import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** A path as the file system knows it: symlinks followed where the file (or its directory) exists. */
export function canonicalPath(path: string): string {
  const full = resolve(path);
  try {
    return realpathSync.native(full);
  } catch {
    try {
      return join(realpathSync.native(dirname(full)), basename(full));
    } catch {
      return full;
    }
  }
}

function identity(path: string): string | null {
  try {
    const st = statSync(path);
    return st.dev + ":" + st.ino;
  } catch {
    return null;
  }
}

/**
 * Whether `a` and `b` name the same file or directory.
 *
 * Symlinks are followed, and so is a spelling that only differs in case on a file system
 * that folds it (APFS, NTFS): realpath keeps the case it was given for a directory, so the
 * strings differ while the file is one. When both exist, the file system is asked (device and
 * inode); when one does not, the names are compared as they are.
 */
export function samePath(a: string, b: string): boolean {
  if (canonicalPath(a) === canonicalPath(b)) return true;
  const ia = identity(a);
  return ia !== null && ia === identity(b);
}

/**
 * Whether a command (the argv of a process, or a service's definition split into words) runs the program at
 * `target`: one of its words is an absolute path to that file, however it is spelled (links followed).
 * A script that an interpreter runs counts: the interpreter's own path is another word.
 */
export function runsProgram(words: string[], target: string): boolean {
  return words.some((word) => isAbsolute(word) && samePath(word, target));
}

/**
 * Whether a command line, as the process list prints it (one string: the words are not told apart, so a path with a
 * space in it is one only by being there), runs the program at `target`: the file is named in it, as it is spelled or
 * as the file system resolves it, and is not just the start of a longer name.
 */
export function commandRuns(command: string, target: string): boolean {
  const names = new Set([target, resolve(target), canonicalPath(target)]);
  for (const name of names) {
    for (let from = command.indexOf(name); from !== -1; from = command.indexOf(name, from + 1)) {
      const before = from === 0 ? " " : command[from - 1]!;
      const after = from + name.length >= command.length ? " " : command[from + name.length]!;
      if (/\s/.test(before) && /\s/.test(after)) return true;
    }
  }
  return false;
}
