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

import { applyPack, findNestedRepos, settle, snapshot } from "./fleet-sync";
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

export interface PublishResult {
  seq: number;
  commit: string;
  bytes: number;
  members: number;
  /** Where the manifest of this snapshot is stored. */
  manifestKey: string;
  /** True when the pack carries the whole tree rather than only the change. */
  full: boolean;
}

/**
 * How far a member may fall behind before it is given a whole tree again.
 *
 * The gateway keeps a bounded number of snapshots. A member that is further
 * behind than this cannot be caught up with deltas alone.
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
): Promise<PublishResult> {
  const keys = loadOrCreateKeyPair(paths.keyFile);
  const members = await fetchMemberKeys(creds, fleet);
  const head = await fetchHead(creds, fleet).catch(() => null);

  // A member that took over has to fetch the state it is about to replace
  // before it publishes on top of it. Otherwise the fleet would lose
  // whatever this member never saw.
  if (head !== null && head.seq > appliedSeq) {
    const caught = await pull(creds, fleet, paths, appliedSeq);
    if (!caught.applied) {
      throw new Error("the fleet is at sequence " + head.seq + " and this member has only applied " + appliedSeq);
    }
    await reportApplied(creds, fleet, caught.seq);
    appliedSeq = caught.seq;
  }

  const seq = (head?.seq ?? 0) + 1;

  // A delta is only useful to a member that already holds the snapshot it is
  // built against. A member that joined since then needs a pack that carries
  // the whole tree, and so does a member that fell too far behind. The
  // membership tells the first case; the distance tells the second.
  const membershipChanged = members.length !== lastMemberCount;
  // A member that is behind cannot be caught up with deltas alone, because
  // the snapshots it missed may be gone.
  const someoneBehind = members.some((m) => seq - (m.applied ?? 0) > FULL_PACK_WINDOW);
  // Every so often a whole tree is published anyway, so the chain of deltas
  // has an anchor and cannot grow for ever.
  const checkpoint = seq % FULL_PACK_WINDOW === 0;
  const noBase = base === null;
  const wantFull = noBase || membershipChanged || someoneBehind || checkpoint;

  // The snapshot builds only the pack that will travel.
  const snap = await snapshot({ work: paths.work, gitDir: paths.gitDir, base, seq, wantFull });
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

/**
 *  Fetch the fleet's current state and apply it to this member's work tree.
 *
 *  Returns upToDate when the member already holds this sequence, so a caller
 *  can poll without doing any work.
 *
 */
export async function pull(
  creds: FleetCredentials,
  fleet: string,
  paths: MemberPaths,
  lastSeq: number,
): Promise<PullResult> {
  const head: FleetHead = await fetchHead(creds, fleet);
  if (head.seq <= lastSeq) {
    return { seq: head.seq, commit: "", applied: false, upToDate: true };
  }
  const keys = loadOrCreateKeyPair(paths.keyFile);

  // Walk back from the head until the snapshot this member already holds.
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

  // A member that is too far behind cannot be caught up with deltas: it
  // needs a snapshot that carries the whole tree.
  const first = chain[0];
  if (first === undefined) return { seq: head.seq, commit: "", applied: false, upToDate: true };
  if (!first.full && first.seq > lastSeq + 1) {
    throw new Error(
      "this member is " + (first.seq - lastSeq) + " snapshots behind and the fleet has no whole tree for it; the primary has to publish one",
    );
  }

  // Directories the fleet leaves alone are not mirrored, so they must survive
  // the apply untouched.
  const exclude = findNestedRepos(paths.work);

  let applied = false;
  let lastSeqApplied = lastSeq;
  let lastCommit = "";
  let lastTree: string | undefined;
  for (const step of chain) {
    const sealed = await getPayload(creds, fleet, "packs", manifestIdOf(step.packKey));

    // The gateway cannot open this: the snapshot key was sealed for us.
    const plain = openForMember(sealed, step.wrapped, step.senderPublicKey, creds.deviceId, keys.privateKey);
    if (!plain) {
      throw new Error(
        "this snapshot was not sealed for this member: it was published before this device joined, so the primary has to publish again now that it has",
      );
    }
    await applyPack(paths.work, paths.gitDir, step.tipCommit, plain, exclude);
    applied = true;
    lastSeqApplied = step.seq;
    lastCommit = step.tipCommit;
    lastTree = step.tree;
  }
  if (!applied) return { seq: head.seq, commit: "", applied: false, upToDate: true };
  await reportApplied(creds, fleet, lastSeqApplied);
  return { seq: lastSeqApplied, commit: lastCommit, applied: true, upToDate: false, ...(lastTree ? { tree: lastTree } : {}) };
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
