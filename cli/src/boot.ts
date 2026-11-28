// Which boot of the machine a moment belongs to, told without the wall clock (which is stepped when a machine without a
// clock gets the time, or when a clock that ran fast is corrected). Something written down by a process (a lock's note, a
// request to stop) carries this, and is of an earlier boot when the id differs or, where the system has none, when it
// records a longer uptime than the machine has now.
import { readFileSync } from "node:fs";
import { uptime } from "node:os";

export interface Boot {
  /** An id that differs between boots, where the system has one (Linux). */
  id?: string;
  /** Seconds since the machine was started. */
  up: number;
}

/**
 * How much longer than now an uptime has to be to be of an earlier boot. Uptime only grows within a boot, but it is
 * not exact across a suspend on every system: a margin keeps a recorded uptime that is a little ahead from counting.
 */
export const BOOT_MARGIN_S = 10 * 60;

let bootId: string | null | undefined;

/** This boot. */
export function currentBoot(): Boot {
  if (bootId === undefined) {
    try {
      bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
    } catch {
      bootId = null;
    }
  }
  return { ...(bootId ? { id: bootId } : {}), up: uptime() };
}

/** Whether what was recorded (`then`) is of an earlier boot than `now`. Nothing recorded says nothing: it is not. */
export function fromEarlierBoot(then: { boot?: string; up?: number }, now: Boot): boolean {
  if (then.boot !== undefined && now.id !== undefined) return then.boot !== now.id;
  return then.up !== undefined && then.up > now.up + BOOT_MARGIN_S;
}
