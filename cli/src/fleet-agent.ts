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

import { applyPack, findNestedRepos, settle, snapshot, type NestedRepoCache } from "./fleet-sync";
import { generateMemberKeyPair, openForMember, sealForMembers, type MemberKeyPair } from "./fleet-crypto";
import {
  fetchHead,
  fetchManifest,
  fetchMemberKeys,
  reportApplied,
  getPayload,
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

export interface PublishResult {
  seq: number;
  commit: string;
  bytes: number;
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
 * the deltas after it, so at most this many snapshots. The gateway keeps more
 * than twice this many (`RECENT_SNAPSHOTS`), so that anchor and the deltas
 * after it are always still there.
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
  /** The manifest of the snapshot this one is built against. */
  parentManifest?: string,
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
  }

  const seq = (head?.seq ?? 0) + 1;

  // A delta is only useful to a member that already holds the snapshot it is
  // built against. A member that joined since then, or that came back with a
  // new key, cannot open what was sealed before and needs a pack that carries
  // the whole tree sealed for it. The roster tells: it names who and which
  // key, so a swap (one leaves, one joins) is a change even though the count
  // is the same. A caller with no roster on record falls back to the count.
  const roster = rosterOf(members);
  const membershipChanged = lastRoster !== undefined ? roster !== lastRoster : members.length !== lastMemberCount;
  // A member that is far behind does not make the publish a whole tree. It
  // catches up from the newest whole tree and the deltas after it, and the
  // checkpoint below guarantees there is one within FULL_PACK_WINDOW snapshots.
  // Every so often a whole tree is published anyway, so the chain of deltas
  // has an anchor and cannot grow for ever.
  const checkpoint = seq % FULL_PACK_WINDOW === 0;
  const noBase = base === null;
  const wantFull = noBase || membershipChanged || checkpoint;

  // The snapshot builds only the pack that will travel.
  const snap = await snapshot({
    work: paths.work,
    gitDir: paths.gitDir,
    base,
    seq,
    wantFull,
    ...(paths.nested ? { nested: paths.nested } : {}),
  });
  const payload = wantFull ? snap.pack : snap.delta!;

  const sealed = sealForMembers(
    payload,
    members.map((m) => ({ memberId: m.deviceId, publicKey: m.pubkey })),
    keys.privateKey,
    keys.publicKey,
  );

  const manifest: FleetManifest = {
    fleet,
    seq,
    tipCommit: snap.commit,
    tree: snap.tree,
    // The gateway fills these in: it is the one that knows where the bytes
    // ended up.
    packKey: "",
    packHash: "",
    full: wantFull,
    ...(parentManifest ? { parentManifest, parentSeq: head?.seq } : {}),
    senderPublicKey: sealed.senderPublicKey,
    wrapped: sealed.wrapped,
    epoch: head?.epoch ?? 0,
    createdAt: Date.now(),
  };
  // The pack and the manifest travel together, and the gateway moves the head
  // in the same call. One round trip instead of six.
  const moved = await putSnapshot(creds, fleet, manifest, sealed.ciphertext);
  if (!moved.ok) {
    throw new Error("the fleet head moved while publishing: " + (moved.error ?? "another member won"));
  }
  await reportApplied(creds, fleet, seq);
  return {
    seq,
    commit: snap.commit,
    bytes: sealed.ciphertext.length,
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

/** What it takes to bring a member from `lastSeq` to the head: whole tree first, then deltas. */
export interface CatchUpPlan {
  head: FleetHead;
  /** Oldest first. The first is a whole tree unless the member is only one behind. */
  chain: FleetManifest[];
}

/**
 * Work out which snapshots a member has to take to reach the head.
 *
 * The chain is walked back from the head until it reaches a whole tree or the
 * snapshot the member already holds. A member far behind therefore starts from
 * the newest checkpoint and applies the deltas after it; how far behind it was
 * does not matter. Nothing is downloaded but manifests, and nothing is written.
 * The chain is empty when there is nothing
 * newer than `lastSeq`.
 */
export async function planCatchUp(creds: FleetCredentials, fleet: string, lastSeq: number): Promise<CatchUpPlan> {
  const head: FleetHead = await fetchHead(creds, fleet);
  if (head.seq <= lastSeq) return { head, chain: [] };

  // Each snapshot names the one it was built against, so the chain is walked
  // backwards until it reaches what is already here.
  const chain: FleetManifest[] = [];
  let manifest: FleetManifest | null = await fetchManifest(creds, fleet, manifestIdOf(head.manifestKey));
  while (manifest !== null && manifest.seq > lastSeq) {
    chain.push(manifest);
    if (manifest.full || manifest.parentManifest === undefined) break;
    const parent: FleetManifest | null = await fetchManifest(creds, fleet, manifestIdOf(manifest.parentManifest)).catch(() => null);
    if (parent === null) break;
    manifest = parent;
  }
  chain.reverse();

  const first = chain[0];
  if (first === undefined) return { head, chain };
  // The chain has to start at a whole tree or right after what the member
  // holds. Anything else means the checkpoint it needs is gone.
  if (!first.full && first.seq > lastSeq + 1) {
    throw new Error(
      "this member is " + (first.seq - lastSeq) + " snapshots behind and the fleet has no whole tree for it; the primary has to publish one",
    );
  }
  return { head, chain };
}

/**
 * Download one snapshot and open it: the pack, ready to apply.
 *
 * It touches no work tree, so it can run ahead of the apply.
 */
export async function openStep(
  creds: FleetCredentials,
  fleet: string,
  keys: MemberKeyPair,
  step: FleetManifest,
): Promise<Buffer> {
  const sealed = await getPayload(creds, fleet, "packs", manifestIdOf(step.packKey));
  // The gateway cannot open this: the snapshot key was sealed for us.
  const plain = openForMember(sealed, step.wrapped, step.senderPublicKey, creds.deviceId, keys.privateKey);
  if (!plain) {
    throw new Error(
      "this snapshot was not sealed for this member: it was published before this device joined, so the primary has to publish again now that it has",
    );
  }
  return plain;
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
 */
export async function pull(
  creds: FleetCredentials,
  fleet: string,
  paths: MemberPaths,
  lastSeq: number,
  lastCommit?: string | null,
): Promise<PullResult> {
  const plan = await planCatchUp(creds, fleet, lastSeq);
  if (plan.chain.length === 0) return { seq: plan.head.seq, commit: "", applied: false, upToDate: true };
  const keys = loadOrCreateKeyPair(paths.keyFile);

  // Directories the fleet leaves alone are not mirrored, so they must survive
  // the apply untouched.
  const exclude = paths.nested ? paths.nested.get() : findNestedRepos(paths.work);

  let lastSeqApplied = lastSeq;
  let lastCommitApplied = "";
  let lastTree: string | undefined;
  let previous: string | null = lastCommit ?? null;
  for (const step of plan.chain) {
    const plain = await openStep(creds, fleet, keys, step);
    await applyPack(paths.work, paths.gitDir, step.tipCommit, plain, exclude, previous);
    previous = step.tipCommit;
    lastSeqApplied = step.seq;
    lastCommitApplied = step.tipCommit;
    lastTree = step.tree;
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
