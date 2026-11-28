// Who made a snapshot, as far as the member that published it can tell: its key and its software, and which tools the
// work tree's own tool server ran since the last snapshot (from the device's activity journal, see activity-journal.ts).
//
// It travels in the snapshot's sealed metadata (`actor`), so the gateway never sees it, and a member reads it only after the
// snapshot has been opened and checked. It is the publisher's own statement: a member that is not honest can write what it
// likes, and a snapshot that was not made through code-mcp has none of it. It says what happened; it proves nothing.

import { lstatSync } from "node:fs";
import { readActivity, type ActivityPosition } from "./activity-journal.ts";
import { keyIdOf } from "./fleet-crypto.ts";

/** The most tools named in one snapshot's actor. */
export const ACTOR_TOOLS_MAX = 32;

export interface SnapshotActor {
  /** The id of the publisher's key (what `prime fleets members` shows). */
  key: string;
  /** The software that published: `prime/<version>`. */
  agent: string;
  /** The tools that ran since the last snapshot, most often first: how many times, and for whom (the key id of the caller, `unsigned` or `local`). */
  tools?: Array<{ tool: string; caller: string; n: number }>;
  /** True when calls were made that the journal could not hand over (its ring dropped them, or it is another file). */
  gap?: true;
}

export interface ActivitySource {
  /** The journal the tool server writes (`--activity-log`). */
  file: string;
  /** Where the last snapshot's read ended. */
  after?: ActivityPosition;
}

/** Fold the calls into per-(tool, caller) counts, most often first, at most `ACTOR_TOOLS_MAX`. */
export function toolCounts(entries: Array<{ tool: string; caller: string }>): Array<{ tool: string; caller: string; n: number }> {
  const counts = new Map<string, { tool: string; caller: string; n: number }>();
  for (const e of entries) {
    const k = e.tool + "\u0000" + e.caller;
    const c = counts.get(k);
    if (c) c.n++;
    else counts.set(k, { tool: e.tool, caller: e.caller, n: 1 });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0)).slice(0, ACTOR_TOOLS_MAX);
}

/**
 * The actor of the snapshot about to be published, and where the journal was read to. A journal that cannot be read
 * (not there yet, not a file) is no calls and the same position: the snapshot is published all the same.
 */
export function actorOf(publicKey: string, activity: ActivitySource | undefined, version: string = process.env.MCP_CLI_VERSION ?? "dev"): { actor: SnapshotActor; position?: ActivityPosition } {
  const base: SnapshotActor = { key: keyIdOf(publicKey), agent: "prime/" + version };
  if (!activity) return { actor: base };
  try {
    // Where `O_NOFOLLOW` is not there (Windows) the open follows a link: a journal that is one is not read, whatever the open does.
    if (lstatSync(activity.file).isSymbolicLink()) throw new Error("the activity journal is a link, and is not read");
    const read = readActivity(activity.file, activity.after ?? { seq: 0 });
    const tools = toolCounts(read.entries);
    return {
      actor: { ...base, ...(tools.length > 0 ? { tools } : {}), ...(read.gap ? { gap: true as const } : {}) },
      position: read.position,
    };
  } catch {
    return { actor: base, ...(activity.after ? { position: activity.after } : {}) };
  }
}

/** What a snapshot's metadata says of its actor, if it is one (anything else is ignored). */
export function actorFrom(value: unknown): SnapshotActor | undefined {
  const a = value as SnapshotActor | undefined;
  if (!a || typeof a !== "object" || typeof a.key !== "string" || typeof a.agent !== "string") return undefined;
  const tools = Array.isArray(a.tools)
    ? a.tools.filter((t) => t && typeof t.tool === "string" && typeof t.caller === "string" && Number.isSafeInteger(t.n) && t.n > 0).slice(0, ACTOR_TOOLS_MAX)
    : undefined;
  return { key: a.key.slice(0, 64), agent: a.agent.slice(0, 64), ...(tools && tools.length > 0 ? { tools } : {}), ...(a.gap === true ? { gap: true as const } : {}) };
}
