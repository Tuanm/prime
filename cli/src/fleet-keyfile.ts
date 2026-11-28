// The member's key file: the pair it opens snapshots with, its signing key and its epoch keys, one JSON file under a lock.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { withDirLockSync } from "./dir-lock";
import type { MemberKeyPair } from "./fleet-crypto";

/** The pair the file holds, or undefined when there is none (or it is not one). */
export function readKeyPair(keyFile: string): MemberKeyPair | undefined {
  if (!existsSync(keyFile)) return undefined;
  const raw = JSON.parse(readFileSync(keyFile, "utf8")) as MemberKeyPair;
  return raw && typeof raw.publicKey === "string" && typeof raw.privateKey === "string" ? raw : undefined;
}

/** Run `fn` holding the key file's lock: every change to the file is made under it, so two processes of one member do not lose each other's. */
export function withKeyFileLock<T>(keyFile: string, fn: () => T): T {
  mkdirSync(join(keyFile, ".."), { recursive: true });
  return withDirLockSync(keyFile + ".lock", fn, { waitMs: 5000, staleMs: 10_000 });
}

/**
 * Change the key file: `change` gets the pair as the file has it now, under the lock, and returns what it should have (or
 * undefined to leave it as it is). Returns what the file holds afterwards, or undefined when there is no key file yet.
 */
export function updateKeyFile(keyFile: string, change: (pair: MemberKeyPair) => MemberKeyPair | undefined): MemberKeyPair | undefined {
  if (!existsSync(keyFile)) return undefined;
  return withKeyFileLock(keyFile, () => {
    const now = readKeyPair(keyFile);
    if (!now) return undefined;
    const next = change(now);
    if (next === undefined) return now;
    writeFileAtomic(keyFile, JSON.stringify(next, null, 2), 0o600);
    return next;
  });
}
