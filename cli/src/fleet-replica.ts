// How a replica keeps up without mirroring.
//
// A replica does not write what the fleet publishes into its work tree as it
// arrives. It learns that the head moved, takes the new snapshots into its own
// object store in the background (`fetchAhead`: download, open, check, keep),
// and writes them out only when it has to: when it is about to become the
// primary, or when a person asks it to catch up. The work tree of a replica
// may therefore be behind the fleet; what it holds is always one snapshot the
// fleet really had, the last one applied.
//
// Three positions are kept in the member's state file:
//   applied  the snapshot the work tree holds (seq, base, tree);
//   fetched  the newest snapshot in the store (fetchedSeq, ...), never behind
//            applied;
//   head     what the fleet has, which the agent learns from its socket.

import { rmSync } from "node:fs";
import { join } from "node:path";

import { applyFetched, fetchAhead, type HeadHint, type MemberPaths, type Position } from "./fleet-agent";
import { hasCommit, preserveLocalChange, readApplySidecar, snapshot, withApplyLock, workTreeMatchesApply } from "./fleet-sync";
import { reportApplied, type FleetCredentials, type FleetHead } from "./fleet-transport";

/** `lazy` fetches ahead and applies on demand; `mirror` applies after every fetch. */
export type ReplicaMode = "lazy" | "mirror";

export function replicaMode(env: Record<string, string | undefined> = process.env): ReplicaMode {
  return env.PRIME_FLEET_REPLICA === "mirror" ? "mirror" : "lazy";
}

/** The part of a member's state file that says how far it has got. */
export interface ReplicaState {
  /** Applied: the snapshot the work tree holds. */
  seq?: number;
  base?: string;
  tree?: string;
  /** Fetched: the newest snapshot in the store. */
  fetchedSeq?: number;
  fetchedCommit?: string;
  fetchedTree?: string;
  /** Who the fetched snapshot was sealed for. */
  fetchedRoster?: string;
  /** Who the snapshot the work tree holds (or the last publish) was sealed for. */
  roster?: string;
}

/** The snapshot the work tree holds, and the newest the store holds (never behind it). */
export function positions(state: ReplicaState): { applied: Position; fetched: Position } {
  const applied: Position = { seq: state.seq ?? 0, commit: state.base ?? null, ...(state.tree ? { tree: state.tree } : {}) };
  if (state.fetchedCommit && (state.fetchedSeq ?? 0) > applied.seq) {
    return {
      applied,
      fetched: {
        seq: state.fetchedSeq!,
        commit: state.fetchedCommit,
        ...(state.fetchedTree ? { tree: state.fetchedTree } : {}),
        ...(state.fetchedRoster !== undefined ? { roster: state.fetchedRoster } : {}),
      },
    };
  }
  return { applied, fetched: applied };
}

/**
 * Take what the fleet has published into the store, without applying it.
 *
 * `save` records the new fetched position as soon as each snapshot is kept, so
 * a failure part-way (or a restart) loses nothing already downloaded.
 */
export async function prefetch(
  creds: FleetCredentials,
  fleet: string,
  paths: MemberPaths,
  state: ReplicaState,
  save: (patch: Partial<ReplicaState>, opts?: { rewind?: boolean }) => void,
  /** What the socket said the head is: with it, the gateway is not asked for the head. */
  hint?: HeadHint,
): Promise<{ head: FleetHead; fetched: Position; steps: number; evicted: number }> {
  let { fetched } = positions(state);
  // What the state says is in the store may not be (a copied state directory, a
  // garbage collection run by hand, an older client that cleaned up): every
  // change would then fail to resolve against a base that is not there, for ever.
  // Start from what is there - the snapshot the work tree holds, or nothing.
  if (fetched.commit !== null && !(await hasCommit(paths.gitDir, fetched.commit))) {
    const { applied } = positions({ ...state, fetchedSeq: 0 });
    fetched = (await hasCommit(paths.gitDir, applied.commit)) ? applied : { seq: 0, commit: null };
    save({ fetchedSeq: fetched.seq, ...(fetched.commit ? { fetchedCommit: fetched.commit } : {}) }, { rewind: true });
  }
  return fetchAhead(
    creds,
    fleet,
    paths,
    fetched,
    (p) => {
      save({
        fetchedSeq: p.seq,
        ...(p.commit ? { fetchedCommit: p.commit } : {}),
        ...(p.tree ? { fetchedTree: p.tree } : {}),
        // "Unknown" is the empty roster, not the roster of an earlier snapshot: a snapshot
        // from a publisher that does not say who it was sealed for must not be taken for
        // one that does.
        fetchedRoster: p.roster ?? "",
      });
    },
    hint,
  );
}

// Whether the last apply into this store wrote `commit` (it finished: the sidecar
// is only written when it has).
async function workTreeHolds(gitDir: string, commit: string | null): Promise<boolean> {
  if (commit === null) return false;
  try {
    return readApplySidecar(gitDir)?.commit === commit;
  } catch {
    return false;
  }
}

/** What happened when a replica was brought up to date. */
export interface ApplyReport {
  applied: Position;
  /** Paths of the replica's own that were moved aside, and where. */
  kept?: { moved: number; to: string };
}

/**
 * Write the newest fetched snapshot over the work tree.
 *
 * Done once, for the whole lag, and only when it matters: before the member
 * takes the lease, or when a person asks. What was edited here since the last
 * apply is moved aside first (only those paths), so nothing is lost and the
 * mirror can be brought up to date. Returns null when there is nothing newer
 * than what the work tree holds.
 */
export async function applyReady(
  creds: FleetCredentials,
  fleet: string,
  paths: MemberPaths,
  state: ReplicaState,
  save: (patch: Partial<ReplicaState>, opts?: { rewind?: boolean }) => void,
  /**
   * With `report`, say where the work tree is even when there is nothing to
   * apply. A member that is taking over needs the fleet to know it is current,
   * and an earlier report may not have got through: the fleet keeps the highest,
   * so saying it again costs one request and loses nothing.
   */
  opts: { report?: boolean } = {},
): Promise<ApplyReport | null> {
  const { applied: seen, fetched } = positions(state);
  if (fetched.seq <= seen.seq || fetched.commit === null) {
    if (opts.report && seen.seq > 0) await reportApplied(creds, fleet, seen.seq);
    return null;
  }
  // The work tree is written by one at a time (the agent, `prime fleets sync`), and what is written is
  // recorded before the next one starts: so the position is read again once it is this one's turn.
  const report = await withApplyLock(paths.gitDir, async (): Promise<ApplyReport | number> => {
    let current = state;
    const fresh = paths.recorded?.();
    if (fresh && fresh.seq > (state.seq ?? 0)) {
      current = { ...state, seq: fresh.seq, ...(fresh.commit ? { base: fresh.commit } : {}), ...(fresh.tree ? { tree: fresh.tree } : {}) };
    }
    const { applied } = positions(current);
    // Another writer has brought the work tree to this snapshot, or past it, already.
    if (fetched.seq <= applied.seq || fetched.commit === null) return applied.seq;

    // A member that was stopped after it wrote the work tree and before it recorded
    // that holds the newest snapshot already, and its state says it holds an older
    // one: looking at the work tree would take every file the fleet wrote for the
    // member's own edit. The sidecar of the apply says what was written last.
    let kept: ApplyReport["kept"];
    const holds = await workTreeHolds(paths.gitDir, fetched.commit);
    // The apply that wrote it finished; a note of what it was for that is still there
    // (the stop came between the sidecar and its removal) is done with.
    if (holds) rmSync(join(paths.gitDir, "apply.target"), { force: true });
    // What the work tree holds is compared with what the last apply wrote by looking at the files' times against the apply
    // index (no file is hashed, nothing is staged): a member that edited nothing, which is nearly every replica, has
    // nothing to keep. Any doubt, and the work tree is taken as a snapshot and compared by tree, as it always was.
    const untouched = !holds && current.tree !== undefined && (await workTreeMatchesApply(paths.work, paths.gitDir, current.base, paths.nested?.get()));
    if (!holds && current.tree !== undefined && !untouched) {
      const local = await snapshot({
        work: paths.work,
        gitDir: paths.gitDir,
        base: current.base ?? null,
        treeOnly: true,
        ...(paths.nested ? { nested: paths.nested } : {}),
      });
      if (local.tree !== current.tree) {
        const moved = await preserveLocalChange(paths.work, paths.gitDir, current.tree, {
          base: current.base ?? null,
          ...(paths.nested ? { nested: paths.nested } : {}),
        });
        if (moved.moved > 0) kept = moved;
      }
    }
    if (!(await workTreeHolds(paths.gitDir, fetched.commit))) await applyFetched(paths, applied, fetched);
    const now: Position = { seq: fetched.seq, commit: fetched.commit, ...(fetched.tree ? { tree: fetched.tree } : {}) };
    // The state is recorded right after the work tree has it, so the next look
    // can tell a change made here from what the fleet gave.
    save({
      seq: now.seq,
      base: now.commit!,
      ...(now.tree ? { tree: now.tree } : {}),
      fetchedSeq: now.seq,
      fetchedCommit: now.commit!,
      ...(now.tree ? { fetchedTree: now.tree } : {}),
      // The roster the snapshot stands on: the member takes it as its own, so that
      // when it takes over it can tell a change of members from no change.
      // When the snapshot does not say, the member does not know either (the empty roster:
      // a whole tree is published when it takes over, as it always was).
      roster: fetched.roster ?? "",
      fetchedRoster: fetched.roster ?? "",
    });
    return { applied: now, ...(kept ? { kept } : {}) };
  });
  if (typeof report === "number") {
    // Nothing to write: the work tree is already there, and what is left to say is where it is.
    if (opts.report && report > 0) await reportApplied(creds, fleet, report);
    return null;
  }
  await reportApplied(creds, fleet, report.applied.seq);
  return report;
}

/** What the fleet said when this member asked for its place. */
export interface PlaceAnswer {
  primary: boolean;
  paused?: boolean;
  /** Why a replica was not given the lease, as the fleet put it. */
  reason?: string;
  /** For `not-caught-up`: the sequence the member has to have applied first. */
  catchUpTo?: number;
  /** For `claimed`: how long before another replica's claim on catching up runs out. */
  retryAfterMs?: number;
  /** The question was not asked: one is in flight already. */
  busy?: boolean;
}

/**
 * Try to become the primary: ask for the place, catch up if the fleet says to,
 * ask again.
 *
 * The fleet gives the lease only to a member that has applied the head, and it
 * decides who wins when several ask. A member that loses - the lease is held,
 * somebody else got there first - stops there and asks nothing more: it is a
 * replica and goes on being one. A member that wins has applied the head.
 */
export async function promote(deps: {
  takePlace: () => Promise<PlaceAnswer>;
  /** Fetch up to `seq` and write it out. */
  catchUp: (seq: number) => Promise<void>;
  /** How many times the head may move under a member that is catching up. */
  attempts?: number;
}): Promise<"primary" | "lease-held" | "claimed" | "busy" | "paused" | "gave-up"> {
  for (let attempt = 0; attempt < (deps.attempts ?? 3); attempt++) {
    const answer = await deps.takePlace();
    if (answer.primary) return "primary";
    if (answer.paused) return "paused";
    if (answer.busy) return "busy";
    // Another replica is catching up to take it: this one writes nothing, and
    // asks again when that claim runs out.
    if (answer.reason === "claimed") return "claimed";
    if (answer.reason !== "not-caught-up") return "lease-held";
    await deps.catchUp(answer.catchUpTo ?? 0);
  }
  return "gave-up";
}

/**
 * How long a replica waits after the lease is freed before it asks for it.
 *
 * Every replica hears the same event at the same moment. The ones that are
 * furthest ahead go first, and the rest are spread out by a number that is
 * theirs alone (plus a little noise), so one of them is usually in charge before
 * the others have written anything. The fleet's own rules decide it when they
 * are not.
 */
export function promotionDelayMs(deviceId: string, behind: boolean, random: () => number = Math.random): number {
  let h = 0;
  for (let i = 0; i < deviceId.length; i++) h = (h * 31 + deviceId.charCodeAt(i)) >>> 0;
  return (behind ? 1500 : 0) + (h % 8) * 250 + Math.floor(random() * 200);
}

/** With a socket: how long a replica goes without asking for its place, in case it missed a message. */
export const SOCKET_PLACE_SAFETY_MS = 5 * 60_000;
/** With a socket: how long a replica goes without looking at the head. */
export const SOCKET_HEAD_SAFETY_MS = 10 * 60_000;
/** How seldom a replica says how far it has fetched. Nothing waits on it. */
export const FETCHED_REPORT_MS = 5 * 60_000;

/**
 * How long a replica's round sleeps when nothing happens.
 *
 * A replica that fetches ahead and writes its work tree only when it takes over
 * has nothing to do between messages. With a socket it sleeps until one comes
 * (and wakes now and then in case one did not); without one it looks as often as
 * a lease that runs out would be noticed - a third of the lease - and the answer
 * to its question already carries the head. A replica that mirrors wants a fresh
 * work tree, so it keeps polling.
 */
export function replicaSleepMs(a: { mode: ReplicaMode; connected: boolean; pollMs: number; leaseMs?: number }): { pollMs: number; idleMs: number } {
  if (a.mode === "mirror") return { pollMs: a.pollMs, idleMs: 30_000 };
  const lease = Math.max(5_000, Math.floor((a.leaseMs ?? DEFAULT_LEASE_MS) / 3));
  return { pollMs: Math.max(a.pollMs, lease), idleMs: SOCKET_PLACE_SAFETY_MS };
}

// How long the fleet's lease lasts, when this member has not been told: a replica
// is only told by a socket, and the fleet's lease is forty-five seconds.
const DEFAULT_LEASE_MS = 45_000;

/** Whether it is time to take (or renew) this member's place in the fleet. */
export function placeDue(a: {
  primary: boolean;
  now: number;
  lastBootstrap: number;
  /** How often a primary renews. */
  heartbeatMs: number;
  /** A promotion is wanted: the lease was freed, or the member is eligible. */
  wanted: boolean;
  eventsConnected: boolean;
  leaseMs?: number;
}): boolean {
  const since = a.now - a.lastBootstrap;
  if (a.primary) return since > a.heartbeatMs;
  if (a.wanted || a.lastBootstrap === 0) return true;
  // A replica has nothing to renew. It only looks now and then, in case a
  // message was missed: rarely when the fleet tells it (a dead socket is found
  // by its pings, and then the replica asks as if it had none), a third of a
  // lease apart when it has to ask - often enough that a lease that runs out is
  // noticed within one more.
  return since >= (a.eventsConnected ? SOCKET_PLACE_SAFETY_MS : Math.max(5_000, Math.floor((a.leaseMs ?? DEFAULT_LEASE_MS) / 3)));
}
