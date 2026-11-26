// The fleet member's side of the synchronisation.
//
// A primary publishes: it snapshots its work tree, seals the pack for every
// member, stores it, and moves the fleet's head. A replica pulls: it reads
// the head, fetches the manifest and the pack, opens the part that was
// sealed for it, and applies it to its own work tree.
//
// The rule that keeps a failover safe: a replica applies everything before it
// takes the lease. A primary that starts behind the head would fork the
// fleet.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { applyCommit, findNestedRepos, ingestPack, settle, snapshot, type NestedRepoCache } from "./fleet-sync";
import { generateMemberKeyPair, openForMember, sealManyForMembers, type MemberKeyPair } from "./fleet-crypto";
import {
  fetchHead,
  fetchManifest,
  fetchMemberKeys,
  reportApplied,
  getPayload,
  putPayload,
  putSnapshot,
  type FleetCredentials,
  type FleetHead,
  type FleetManifest,
} from "./fleet-transport";

export interface MemberPaths {
  /** The space's work tree. */
  work: string;
  /** prime's own object store for this member. */
  gitDir: string;
  /** The member's key pair file. */
  keyFile: string;
  /** Remembered nested repositories of the work tree, to spare the walk. */
  nested?: NestedRepoCache;
}

/**
 *  The member's key pair, created on first use.
 *
 *  The private key never leaves this machine: it is what lets the member open
 *  the snapshots sealed for it, and the gateway never sees it.
 *
 */
export function loadOrCreateKeyPair(keyFile: string): MemberKeyPair {
  if (existsSync(keyFile)) {
    const raw = JSON.parse(readFileSync(keyFile, "utf8")) as MemberKeyPair;
    if (raw && typeof raw.publicKey === "string" && typeof raw.privateKey === "string") return raw;
  }
  const pair = generateMemberKeyPair();
  mkdirSync(join(keyFile, ".."), { recursive: true });
  writeFileSync(keyFile, JSON.stringify(pair, null, 2), { mode: 0o600 });
  return pair;
}

/** The members a snapshot is sealed for, as one string: who, and with which key. */
export function rosterOf(members: Array<{ deviceId: string; pubkey?: string }>): string {
  return members.map((m) => m.deviceId + ":" + (m.pubkey ?? "").slice(0, 12)).join(",");
}

/**
 * Whether a member is in `roster` now that was not before, or has a different key.
 *
 * Only that needs a snapshot of its own: a newcomer, or a member that came back
 * with a new key, cannot open anything sealed before. A member that left needs
 * nothing - the next snapshot is simply not sealed for it, which is what keeps it
 * out.
 */
export function rosterGained(before: string, now: string): boolean {
  const had = new Map<string, string>();
  for (const entry of before.split(",")) {
    if (!entry) continue;
    const at = entry.lastIndexOf(":");
    had.set(entry.slice(0, at), entry.slice(at + 1));
  }
  for (const entry of now.split(",")) {
    if (!entry) continue;
    const at = entry.lastIndexOf(":");
    if (had.get(entry.slice(0, at)) !== entry.slice(at + 1)) return true;
  }
  return false;
}

export interface PublishResult {
  seq: number;
  commit: string;
  bytes: number;
  /** The change-only pack that travelled beside a whole tree, when there was one. */
  deltaBytes?: number;
  members: number;
  /** The members this snapshot was sealed for (see `rosterOf`). */
  roster: string;
  /** Where the manifest of this snapshot is stored. */
  manifestKey: string;
  /** True when the pack carries the whole tree rather than only the change. */
  full: boolean;
}

/**
 * How often the fleet publishes a whole tree, in snapshots.
 *
 * It is the anchor of the chain of deltas. A member that is far behind does not
 * change what is published: it starts from the newest whole tree and applies
 * the deltas after it, so at most this many snapshots. The gateway keeps twice
 * this many (`RECENT_SNAPSHOTS` in api/src/fleets.ts; a test holds the two
 * together), so that anchor and the deltas after it are always still there.
 */
export const FULL_PACK_WINDOW = 32;

/**
 *  Publish the current work tree as the fleet's new state.
 *
 *  The pack is sealed once, and the snapshot key is wrapped for each member
 *  that offered a public key. A member that offered none cannot read this
 *  snapshot, which is the honest outcome: it never said how it wanted its
 *  data protected.
 *
 */
export async function publish(
  creds: FleetCredentials,
  fleet: string,
  paths: MemberPaths,
  base: string | null,
  /** The sequence this member has already applied. */
  appliedSeq = 0,
  /** How many members the last publish sealed for. */
  lastMemberCount = 0,
  /** Who the last publish sealed for (see `rosterOf`); tells a swap from no change. */
  lastRoster?: string,
): Promise<PublishResult> {
  const keys = loadOrCreateKeyPair(paths.keyFile);
  const members = await fetchMemberKeys(creds, fleet);
  const head = await fetchHead(creds, fleet).catch(() => null);

  // A member that took over has to fetch the state it is about to replace
  // before it publishes on top of it. Otherwise the fleet would lose
  // whatever this member never saw.
  if (head !== null && head.seq > appliedSeq) {
    const caught = await pull(creds, fleet, paths, appliedSeq, base);
    if (!caught.applied) {
      throw new Error("the fleet is at sequence " + head.seq + " and this member has only applied " + appliedSeq);
    }
    await reportApplied(creds, fleet, caught.seq);
    appliedSeq = caught.seq;
    // What this snapshot is built on is the state it has just caught up to,
    // not the one the caller's state file remembered from before.
    base = caught.commit;
  }

  const seq = (head?.seq ?? 0) + 1;

  // A delta is only useful to a member that already holds the snapshot it is
  // built against. A member that joined since then, or that came back with a
  // new key, cannot open what was sealed before and needs a pack that carries
  // the whole tree sealed for it. The roster tells: it names who and which
  // key, so a swap (one leaves, one joins) is a change even though the count
  // is the same, while a member that only left is not. A caller with no roster
  // on record falls back to the count.
  const roster = rosterOf(members);
  const membershipChanged = lastRoster !== undefined ? rosterGained(lastRoster, roster) : members.length !== lastMemberCount;
  // A member that is far behind does not make the publish a whole tree. It
  // catches up from the newest whole tree and the deltas after it, and the
  // checkpoint below guarantees there is one within FULL_PACK_WINDOW snapshots.
  // Every so often a whole tree is published anyway, so the chain of deltas
  // has an anchor and cannot grow for ever.
  const checkpoint = seq % FULL_PACK_WINDOW === 0;
  const noBase = base === null;
  const wantFull = noBase || membershipChanged || checkpoint;

  // The snapshot builds the packs that will travel: the whole tree when a member
  // needs one, only the change otherwise. A whole tree built on a snapshot of
  // the fleet's own also carries the change, so the members that hold that
  // snapshot (nearly all of them, at a checkpoint) do not have to take the tree.
  const withDelta = wantFull && base !== null;
  const snap = await snapshot({
    work: paths.work,
    gitDir: paths.gitDir,
    base,
    seq,
    wantFull,
    withDelta,
    ...(paths.nested ? { nested: paths.nested } : {}),
  });
  const payloads = [wantFull ? snap.pack : snap.delta!];
  if (withDelta && snap.delta) payloads.push(snap.delta);

  // One key seals them all, so a member opens either with what it was given.
  const sealed = sealManyForMembers(
    payloads,
    members.map((m) => ({ memberId: m.deviceId, publicKey: m.pubkey })),
    keys.privateKey,
    keys.publicKey,
  );
  const main = sealed.ciphertexts[0]!;

  // The change travels first and on its own: the gateway stores it and the
  // manifest names it, as it names the pack.
  let delta: FleetManifest["delta"];
  if (sealed.ciphertexts[1]) {
    const stored = await putPayload(creds, fleet, "packs", sealed.ciphertexts[1]);
    delta = { packKey: stored.key, packHash: stored.hash, bytes: sealed.ciphertexts[1].length };
  }

  const manifest: FleetManifest = {
    fleet,
    seq,
    tipCommit: snap.commit,
    tree: snap.tree,
    // The gateway fills these in: it is the one that knows where the bytes
    // ended up.
    packKey: "",
    packHash: "",
    packBytes: main.length,
    ...(delta ? { delta } : {}),
    full: wantFull,
    // The snapshot this one follows is the head's, whoever published it: the
    // gateway only accepts a publish on top of the head, so this link is always
    // the one a member that was away can walk back along.
    ...(head ? { parentManifest: head.manifestKey, parentSeq: head.seq } : {}),
    senderPublicKey: sealed.senderPublicKey,
    wrapped: sealed.wrapped,
    epoch: head?.epoch ?? 0,
    createdAt: Date.now(),
  };
  // The pack and the manifest travel together, and the gateway moves the head
  // in the same call. One round trip instead of six.
  const moved = await putSnapshot(creds, fleet, manifest, main);
  if (!moved.ok) {
    throw new Error("the fleet head moved while publishing: " + (moved.error ?? "another member won"));
  }
  await reportApplied(creds, fleet, seq);
  return {
    seq,
    commit: snap.commit,
    bytes: main.length,
    ...(delta ? { deltaBytes: delta.bytes } : {}),
    members: sealed.wrapped.length,
    roster,
    manifestKey: moved.manifestKey ?? "",
    full: wantFull,
  };
}

export interface PullResult {
  seq: number;
  commit: string;
  applied: boolean;
  /** True when there was nothing new to fetch. */
  upToDate: boolean;
  /** The tree that was applied, so the caller knows what it now holds. */
  tree?: string;
}

/** One snapshot to take on the way to the head, and which of its packs to take. */
export interface RouteStep {
  manifest: FleetManifest;
  /** Where the pack to download is stored. */
  packKey: string;
  /** Its size, sealed. */
  bytes: number;
  /** Whether it is the whole tree (an anchor) rather than the change. */
  whole: boolean;
}

/** What it takes to bring a member from `lastSeq` to the head. */
export interface CatchUpPlan {
  head: FleetHead;
  /** Oldest first: a whole tree, if the route needs one, then changes. */
  chain: RouteStep[];
}

// How many manifests are looked at before giving up on finding a route.
const WALK_LIMIT = 2 * FULL_PACK_WINDOW + 1;
// A size that is not known (a snapshot published before sizes were recorded):
// a whole tree is assumed large and a change small.
const UNKNOWN_WHOLE = 1e12;
const UNKNOWN_CHANGE = 1;

function openableBy(manifest: FleetManifest, memberId: string): boolean {
  return manifest.wrapped.some((w) => w.memberId === memberId);
}

// The pack that brings a member that holds the snapshot before this one to this
// snapshot, if there is one it can open.
function changeOf(manifest: FleetManifest, memberId: string): RouteStep | null {
  if (!openableBy(manifest, memberId)) return null;
  if (!manifest.full) {
    return { manifest, packKey: manifest.packKey, bytes: manifest.packBytes ?? UNKNOWN_CHANGE, whole: false };
  }
  if (manifest.delta) return { manifest, packKey: manifest.delta.packKey, bytes: manifest.delta.bytes, whole: false };
  return null;
}

// The pack that brings a member that holds nothing of the fleet to this snapshot.
function wholeOf(manifest: FleetManifest, memberId: string): RouteStep | null {
  if (!manifest.full || !openableBy(manifest, memberId)) return null;
  return { manifest, packKey: manifest.packKey, bytes: manifest.packBytes ?? UNKNOWN_WHOLE, whole: true };
}

/**
 * Pick the cheapest way from what a member holds to the snapshots it needs.
 *
 * `walked` is the snapshots from the head back, newest first, with consecutive
 * sequences. A route is either all the changes since `lastSeq`, or a whole tree
 * at some snapshot and the changes after it; the one that moves the fewest bytes
 * wins, and with equal bytes the one with fewer steps. A snapshot the member
 * cannot open (sealed before it joined, or for another key) is not a step.
 * Returns null when there is no route.
 */
export function chooseRoute(walked: FleetManifest[], lastSeq: number, memberId: string): RouteStep[] | null {
  if (walked.length === 0) return [];
  const byRow = [...walked].reverse(); // oldest first
  const head = byRow[byRow.length - 1]!.seq;
  const lowest = byRow[0]!.seq;
  const at = (seq: number): FleetManifest | undefined => byRow[seq - lowest];

  const changesFrom = (first: number): RouteStep[] | null => {
    const steps: RouteStep[] = [];
    for (let seq = first; seq <= head; seq++) {
      const m = at(seq);
      const step = m ? changeOf(m, memberId) : null;
      if (!step) return null;
      steps.push(step);
    }
    return steps;
  };
  const cost = (steps: RouteStep[]): number => steps.reduce((sum, s) => sum + s.bytes, 0);

  let best: RouteStep[] | null = null;
  const consider = (steps: RouteStep[] | null): void => {
    if (!steps) return;
    if (best === null || cost(steps) < cost(best) || (cost(steps) === cost(best) && steps.length < best.length)) best = steps;
  };
  // Only the changes, from what the member holds: needs every one of them.
  if (lowest <= lastSeq + 1) consider(changesFrom(lastSeq + 1));
  // A whole tree at k, then the changes after it.
  for (let k = Math.max(lowest, lastSeq + 1); k <= head; k++) {
    const m = at(k);
    const whole = m ? wholeOf(m, memberId) : null;
    if (!whole) continue;
    const rest = k === head ? [] : changesFrom(k + 1);
    if (rest) consider([whole, ...rest]);
  }
  return best;
}

/**
 * Work out which snapshots a member has to take to reach the head.
 *
 * The chain is walked back from the head until it reaches the snapshot the member
 * already holds, a snapshot with only a whole tree (nothing older can matter), or
 * the end of what the gateway keeps; then `chooseRoute` picks the cheapest
 * route. Nothing is downloaded but manifests, and nothing is written. The chain
 * is empty when there is nothing newer than `lastSeq`.
 */
export async function planCatchUp(creds: FleetCredentials, fleet: string, lastSeq: number): Promise<CatchUpPlan> {
  const head: FleetHead = await fetchHead(creds, fleet);
  if (head.seq <= lastSeq) return { head, chain: [] };

  // Each snapshot names the one it was built against, so the chain is walked
  // backwards until it reaches what is already here.
  const walked: FleetManifest[] = [];
  let manifest: FleetManifest | null = await fetchManifest(creds, fleet, manifestIdOf(head.manifestKey));
  while (manifest !== null && manifest.seq > lastSeq) {
    walked.push(manifest);
    // A whole tree with no change beside it ends the walk: no route goes back past it.
    if (manifest.full && !manifest.delta) break;
    if (manifest.parentManifest === undefined || walked.length >= WALK_LIMIT) break;
    const parent: FleetManifest | null = await fetchManifest(creds, fleet, manifestIdOf(manifest.parentManifest)).catch(() => null);
    if (parent === null || parent.seq !== manifest.seq - 1) break;
    manifest = parent;
  }
  if (walked.length === 0) return { head, chain: [] };

  const chain = chooseRoute(walked, lastSeq, creds.deviceId);
  if (chain === null) {
    const oldest = walked[walked.length - 1]!;
    throw new Error(
      "this member is " + (oldest.seq - lastSeq) + " snapshots behind and the fleet no longer has a whole tree to start from; it gets one at the next checkpoint (every " + FULL_PACK_WINDOW + " snapshots) or when a member joins",
    );
  }
  return { head, chain };
}

/**
 * Download one pack and open it, ready to apply.
 *
 * It touches no work tree, so it can run ahead of the apply.
 */
export async function openStep(
  creds: FleetCredentials,
  fleet: string,
  keys: MemberKeyPair,
  step: RouteStep,
): Promise<Buffer> {
  const sealed = await getPayload(creds, fleet, "packs", manifestIdOf(step.packKey));
  // The gateway cannot open this: the snapshot key was sealed for us.
  const m = step.manifest;
  const plain = openForMember(sealed, m.wrapped, m.senderPublicKey, creds.deviceId, keys.privateKey);
  if (!plain) {
    throw new Error(
      "this snapshot was not sealed for this member: it was published before this device joined, so the primary has to publish again now that it has",
    );
  }
  return plain;
}

/** A snapshot that has been applied to the work tree. */
export interface AppliedStep {
  seq: number;
  commit: string;
  tree: string;
}

/**
 *  Fetch the fleet's current state and apply it to this member's work tree.
 *
 *  Returns upToDate when the member already holds this sequence, so a caller
 *  can poll without doing any work.
 *
 *  `lastCommit` is the snapshot commit the member holds now (the one its state
 *  file records). It tells the apply what the fleet itself wrote, so that only
 *  what the fleet dropped is removed; with none, nothing is removed.
 *
 *  The whole chain is downloaded and opened before the first step is applied,
 *  so a chain that cannot be fetched or opened touches nothing. Each step is
 *  reported to `onStep` as soon as it is applied: the caller records it then,
 *  so a failure part-way leaves a state that still describes the work tree
 *  (otherwise the next round would take the applied files for local edits).
 *
 */
export async function pull(
  creds: FleetCredentials,
  fleet: string,
  paths: MemberPaths,
  lastSeq: number,
  lastCommit?: string | null,
  onStep?: (step: AppliedStep) => void | Promise<void>,
): Promise<PullResult> {
  const plan = await planCatchUp(creds, fleet, lastSeq);
  if (plan.chain.length === 0) return { seq: plan.head.seq, commit: "", applied: false, upToDate: true };
  const keys = loadOrCreateKeyPair(paths.keyFile);

  // Everything is fetched and opened first. Memory holds the chain: a whole
  // tree at most, and up to 31 deltas after it.
  const packs: Buffer[] = [];
  for (const step of plan.chain) packs.push(await openStep(creds, fleet, keys, step));

  // Directories the fleet leaves alone are not mirrored, so they must survive
  // the apply untouched.
  const exclude = paths.nested ? paths.nested.get() : findNestedRepos(paths.work);

  let lastSeqApplied = lastSeq;
  let lastCommitApplied = "";
  let lastTree: string | undefined;
  let previous: string | null = lastCommit ?? null;
  try {
    for (const [i, step] of plan.chain.entries()) {
      const m = step.manifest;
      await ingestPack(paths.work, paths.gitDir, m.tipCommit, packs[i]!, { tree: m.tree, seq: m.seq });
      await applyCommit(paths.work, paths.gitDir, m.tipCommit, exclude, previous);
      previous = m.tipCommit;
      lastSeqApplied = m.seq;
      lastCommitApplied = m.tipCommit;
      lastTree = m.tree;
      await onStep?.({ seq: m.seq, commit: m.tipCommit, tree: m.tree });
    }
  } catch (err) {
    // What was applied is real; say so before failing, so the fleet knows.
    if (lastSeqApplied > lastSeq) await reportApplied(creds, fleet, lastSeqApplied).catch(() => false);
    throw err;
  }
  await reportApplied(creds, fleet, lastSeqApplied);
  return { seq: lastSeqApplied, commit: lastCommitApplied, applied: true, upToDate: false, ...(lastTree ? { tree: lastTree } : {}) };
}

/** The storage id at the end of a payload key. */
export function manifestIdOf(key: string): string {
  const parts = key.split("/");
  return parts[parts.length - 1] ?? key;
}

/** Wait until the work tree stops changing, then snapshot it. */
export async function snapshotNow(work: string, gitDir: string, base: string | null) {
  await settle(work);
  return snapshot({ work, gitDir, base });
}
