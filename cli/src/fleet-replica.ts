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

import { applyFetched, fetchAhead, type HeadHint, type MemberPaths, type Position } from "./fleet-agent";
import { preserveLocalChange, snapshot } from "./fleet-sync";
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
}

/** The snapshot the work tree holds, and the newest the store holds (never behind it). */
export function positions(state: ReplicaState): { applied: Position; fetched: Position } {
  const applied: Position = { seq: state.seq ?? 0, commit: state.base ?? null, ...(state.tree ? { tree: state.tree } : {}) };
  if (state.fetchedCommit && (state.fetchedSeq ?? 0) > applied.seq) {
    return {
      applied,
      fetched: { seq: state.fetchedSeq!, commit: state.fetchedCommit, ...(state.fetchedTree ? { tree: state.fetchedTree } : {}) },
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
  save: (patch: Partial<ReplicaState>) => void,
  /** What the socket said the head is: with it, the gateway is not asked for the head. */
  hint?: HeadHint,
): Promise<{ head: FleetHead; fetched: Position; steps: number }> {
  const { fetched } = positions(state);
  return fetchAhead(
    creds,
    fleet,
    paths,
    fetched,
    (p) => {
      save({ fetchedSeq: p.seq, ...(p.commit ? { fetchedCommit: p.commit } : {}), ...(p.tree ? { fetchedTree: p.tree } : {}) });
    },
    hint,
  );
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
  save: (patch: Partial<ReplicaState>) => void,
): Promise<ApplyReport | null> {
  const { applied, fetched } = positions(state);
  if (fetched.seq <= applied.seq || fetched.commit === null) return null;

  let kept: ApplyReport["kept"];
  if (state.tree !== undefined) {
    const local = await snapshot({
      work: paths.work,
      gitDir: paths.gitDir,
      base: state.base ?? null,
      treeOnly: true,
      ...(paths.nested ? { nested: paths.nested } : {}),
    });
    if (local.tree !== state.tree) {
      kept = await preserveLocalChange(paths.work, paths.gitDir, state.tree, paths.nested ? { nested: paths.nested } : {});
    }
  }
  await applyFetched(paths, applied, fetched);
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
  });
  await reportApplied(creds, fleet, now.seq);
  return { applied: now, ...(kept ? { kept } : {}) };
}

/** What the fleet said when this member asked for its place. */
export interface PlaceAnswer {
  primary: boolean;
  paused?: boolean;
  /** Why a replica was not given the lease, as the fleet put it. */
  reason?: string;
  /** For `not-caught-up`: the sequence the member has to have applied first. */
  catchUpTo?: number;
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
}): Promise<"primary" | "lease-held" | "paused" | "gave-up"> {
  for (let attempt = 0; attempt < (deps.attempts ?? 3); attempt++) {
    const answer = await deps.takePlace();
    if (answer.primary) return "primary";
    if (answer.paused) return "paused";
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
  // message was missed: rarely when the fleet tells it, about as often as the
  // lease is renewed when it has to ask.
  return since > (a.eventsConnected ? 60_000 : Math.max(5_000, Math.floor((a.leaseMs ?? DEFAULT_LEASE_MS) / 3)));
}
