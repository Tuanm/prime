// The short looks code-mcp takes at start for a program on the path. Each has a time limit (a shell that waits on something,
// a slow disk, a scanner on Windows must not hold the start for ever), and a look that ran out of time is said, so that
// "found nothing" is not mistaken for "not there".
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The result of a spawn as far as a probe cares. */
export interface ProbeResult {
  exitCode: number | null;
  exitedDueToTimeout?: boolean;
}

export type ProbeSpawn = (cmd: string[], timeoutMs: number) => ProbeResult;

/**
 * Whether the command exits 0 within `timeoutMs`. A command that did not finish in time, or could not be started, is
 * false, and a line on `log` says which (it is a doubt, not an answer).
 */
export function probeExits(
  cmd: string[],
  label: string,
  timeoutMs: number,
  run: ProbeSpawn,
  log: (line: string) => void = (line) => console.error(line),
): boolean {
  try {
    const result = run(cmd, timeoutMs);
    if (result.exitedDueToTimeout) {
      log(`[code-mcp] looking for ${label} took longer than ${Math.round(timeoutMs / 1000)} s and was given up: taken as not found`);
      return false;
    }
    return result.exitCode === 0;
  } catch (error) {
    log(`[code-mcp] looking for ${label} failed (${error instanceof Error ? error.message : String(error)}): taken as not found`);
    return false;
  }
}

/** Where Windows PowerShell is, on every Windows that has it: a fixed place that needs no look along the path. */
export function windowsPowerShellPath(env: Record<string, string | undefined> = process.env): string {
  return join(env.SystemRoot ?? env.windir ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * The PowerShell to use, if there is one. `probe(name)` asks the path (and may run out of time). Windows PowerShell is
 * also found by its fixed place, so that a slow `where` cannot make code-mcp fall back to cmd on a machine that has it.
 */
export function pickPowerShell(
  probe: (bin: string) => boolean,
  windows: boolean,
  exists: (path: string) => boolean = existsSync,
  env: Record<string, string | undefined> = process.env,
): "pwsh" | "powershell" | null {
  if (probe("pwsh")) return "pwsh";
  if (windows && exists(windowsPowerShellPath(env))) return "powershell";
  if (probe("powershell")) return "powershell";
  return null;
}
