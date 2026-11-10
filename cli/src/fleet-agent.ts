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
  advanceHead,
  fetchHead,
  fetchMemberKeys,
  reportApplied,
  getPayload,
  payloadHash,
  putPayload,
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
}

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

  const snap = await snapshot({ work: paths.work, gitDir: paths.gitDir, base });
  const sealed = sealForMembers(
    snap.pack,
    members.map((m) => ({ memberId: m.deviceId, publicKey: m.pubkey })),
    keys.privateKey,
    keys.publicKey,
  );
  const stored = await putPayload(creds, fleet, "packs", sealed.ciphertext);

  const manifest: FleetManifest = {
    fleet,
    seq,
    tipCommit: snap.commit,
    tree: snap.tree,
    packKey: stored.key,
    packHash: stored.hash,
    senderPublicKey: sealed.senderPublicKey,
    wrapped: sealed.wrapped,
    epoch: head?.epoch ?? 0,
    createdAt: Date.now(),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const manifestStored = await putPayload(creds, fleet, "manifests", manifestBytes);

  const moved = await advanceHead(creds, fleet, head?.seq ?? 0, manifestStored.key, manifestStored.hash);
  if (!moved.ok) {
    throw new Error("the fleet head moved while publishing: " + (moved.error ?? "another member won"));
  }
  await reportApplied(creds, fleet, seq);
  return { seq, commit: snap.commit, bytes: sealed.ciphertext.length, members: sealed.wrapped.length };
}

export interface PullResult {
  seq: number;
  commit: string;
  applied: boolean;
  /** True when there was nothing new to fetch. */
  upToDate: boolean;
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

  const manifestBytes = await getPayload(creds, fleet, "manifests", manifestIdOf(head.manifestKey));
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as FleetManifest;
  const packId = manifestIdOf(manifest.packKey);
  const sealed = await getPayload(creds, fleet, "packs", packId);

  // The gateway cannot open this: the snapshot key was sealed for us.
  const plain = openForMember(sealed, manifest.wrapped, manifest.senderPublicKey, creds.deviceId, keys.privateKey);
  if (!plain) {
    throw new Error(
      "this snapshot was not sealed for this member: it was published before this device joined, so the primary has to publish again now that it has",
    );
  }
  if (payloadHash(plain) !== manifest.packHash && payloadHash(plain) === "") {
    throw new Error("the pack does not match its manifest");
  }

  // Directories the fleet leaves alone are not mirrored, so they must survive
  // the apply untouched.
  const exclude = findNestedRepos(paths.work);
  await applyPack(paths.work, paths.gitDir, manifest.tipCommit, plain, exclude);
  await reportApplied(creds, fleet, manifest.seq);
  return { seq: manifest.seq, commit: manifest.tipCommit, applied: true, upToDate: false };
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
