// Git, run synchronously by a test: with a time limit of its own, and never waiting for a person.
//
// A synchronous call blocks the thread that a test's time limit is kept by (see stall-guard.ts), so a git that hangs (an
// `index.lock` held by a process that is gone, a prompt for a credential) must not be able to hold a test's thread for ever.
// `GIT_TERMINAL_PROMPT=0` makes git fail where it would ask, and the limit ends one that waits on anything else.
import { execFileSync, type ExecFileSyncOptions, type ExecFileSyncOptionsWithBufferEncoding, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { SYNC_CHILD_MS } from "./sync-limit";

export function gitSync(args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding): string;
export function gitSync(args: readonly string[], options?: ExecFileSyncOptionsWithBufferEncoding): Buffer;
export function gitSync(args: readonly string[], options?: ExecFileSyncOptions): string | Buffer;
export function gitSync(args: readonly string[], options: ExecFileSyncOptions = {}): string | Buffer {
  return execFileSync("git", args, { timeout: SYNC_CHILD_MS, ...options, env: { ...(options.env ?? process.env), GIT_TERMINAL_PROMPT: "0" } });
}
