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

import { writeFileAtomic } from "./atomic-write";
import { applyCommit, findNestedRepos, ingestPack, snapshot, withApplyLock, type NestedRepoCache } from "./fleet-sync";
import { generateMemberKeyPair, keyIdOf, openPayload, sealManyForMembers, wrapIdOf, wrappedEntryFor, type MemberKeyPair } from "./fleet-crypto";
import { FleetTrust, TamperedSnapshotError, gatewayHasNoIncarnation, noteIncarnationAnswer, metaBindingOf, sealFieldsOf, verifySnapshot } from "./fleet-trust";
import {
  PayloadGoneError,
  type IndexEntry,
  fetchHead,
  fetchIndex,
  fetchManifest,
  fetchMemberKeys,
  fetchRole,
  reportApplied,
  getPayload,
  payloadHash,
  putPayload,
  putSnapshot,
  type FleetCredentials,
  META_CAP,
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
  /**
   * Where the member's state file says the work tree is, read fresh. The agent, `prime fleets
   * sync` and a takeover all write the work tree, each from a position it read some time ago:
   * with this, an apply asks again once it holds the work tree's lock (see `applyAndRecord`).
   */
  recorded?: () => Position;
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

/**
 * Take a new key pair and keep the one it replaces beside it. The old pair is what shows the fleet that the new key is
 * this member's own (see `proveKeyChange`), and what opens the snapshots that were sealed for it and are not taken in yet.
 * It stays in the file until both are done (`dropPreviousKey`). Rotating again before that keeps the first old pair: the
 * fleet still holds that one.
 */
export function rotateKeyPair(keyFile: string): MemberKeyPair {
  const current = loadOrCreateKeyPair(keyFile);
  const previous = current.previous ?? { publicKey: current.publicKey, privateKey: current.privateKey };
  const pair = generateMemberKeyPair();
  const next: MemberKeyPair = { ...pair, previous };
  writeFileAtomic(keyFile, JSON.stringify(next, null, 2), 0o600);
  return pair;
}

/** The key pair this member held before it rotated, when the fleet may still hold it. */
export function previousKeyPair(keyFile: string): MemberKeyPair | undefined {
  if (!existsSync(keyFile)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(keyFile, "utf8")) as MemberKeyPair;
    const p = raw.previous;
    return p && typeof p.publicKey === "string" && typeof p.privateKey === "string" ? p : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The old pair is of no more use: it is not kept. `only` names the pair that was meant (its public key), so a pair that
 * a later rotation put there is not dropped by an answer to the one before.
 */
export function dropPreviousKey(keyFile: string, only?: string): void {
  const previous = previousKeyPair(keyFile);
  if (!previous || (only !== undefined && previous.publicKey !== only)) return;
  const raw = JSON.parse(readFileSync(keyFile, "utf8")) as MemberKeyPair;
  const { previous: _gone, ...kept } = raw;
  writeFileAtomic(keyFile, JSON.stringify(kept, null, 2), 0o600);
}

/** Whether a manifest shows the gateway nothing of the snapshot (see `FleetManifest.meta`). */
function hidesMeta(m: FleetManifest): boolean {
  return m.meta !== undefined && m.tipCommit === "" && m.tree === "";
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

/** A tree the caller has just taken, so that publishing it need not take it again. */
export interface KnownTree {
  /** The tree of the snapshot just taken. */
  tree: string;
  /** What that snapshot was built on; it is only the tree of this publish if the publish builds on the same. */
  base: string | null;
  /** Whether the files are still as they were when it was taken (a look that costs far less than taking it again). */
  unchanged: () => Promise<boolean>;
  /**
   * Asked again at the moment the tree is used, after the requests to the fleet: false if something has been seen
   * to change since (the watcher spoke). It covers what happened after the files were looked at.
   */
  quiet?: () => boolean;
}

export interface PublishOptions {
  known?: KnownTree;
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

/** What a snapshot's manifest and framing add to its pack, at most, for the check against the gateway's limit. */
const MANIFEST_ALLOWANCE_BYTES = 256 * 1024;

function snapshotTooBigMessage(bytes: number, limit: number): string {
  const mb = (n: number): number => Math.ceil(n / (1024 * 1024));
  return (
    "this snapshot is " + mb(bytes) + " MB, and the gateway takes at most " + mb(limit) +
    " MB for one: the work tree is too big to publish (keep what is not the work's, such as build output, out of it with .gitignore)"
  );
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
  options: PublishOptions = {},
): Promise<PublishResult> {
  const keys = loadOrCreateKeyPair(paths.keyFile);
  // Whether the work tree is still the one of the snapshot the caller took, asked while the fleet is
  // being asked about the head (the two do not wait for each other). Not trusted if this publish
  // writes into the work tree (it catches up first) or builds on something else.
  const known = options.known;
  const treeUnchanged: Promise<boolean> = known && known.base === base ? known.unchanged().catch(() => false) : Promise.resolve(false);
  let caughtUp = false;
  const [members, head, role] = await Promise.all([
    fetchMemberKeys(creds, fleet),
    fetchHead(creds, fleet).catch(() => null),
    // Which fleet of this name it is, for the seal; a gateway that does not say, or does not answer, leaves it out.
    gatewayHasNoIncarnation(creds, fleet) ? Promise.resolve(undefined) : fetchRole(creds, fleet).catch(() => undefined),
  ]);
  if (role?.member) noteIncarnationAnswer(creds, fleet, role.incarnation !== undefined);
  const incarnation = role?.member ? role.incarnation : undefined;

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
    caughtUp = true;
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
  // A snapshot built on one that has no seal, none of the tags a sender makes for its members, or no
  // mark of its fleet (an old member took over, or this fleet is mid-upgrade), is a whole tree: a replica that
  // has seen them refuses that one, and a whole tree is the way around it - the replica starts
  // from this one and never needs the snapshot it refused. A head whose manifest cannot be read
  // is taken as one of those: the whole tree is the safe side of not knowing.
  // The manifest's metadata is sealed, and nothing in the clear but what the gateway needs, when every member can
  // read that (the gateway says so in `fleetCaps`). A fleet that has a member that cannot is published as it always was,
  // and a snapshot that is built on one in the other form is a whole tree, which the member that cannot read it needs.
  const hideMeta = role?.member === true && members.length > 0 && members.every((m) => m.caps?.includes(META_CAP) === true);
  const headUnsealed =
    head !== null && !(noBase || membershipChanged || checkpoint)
      ? await fetchManifest(creds, fleet, manifestIdOf(head.manifestKey)).then(
          (m) =>
            m.seal === undefined ||
            !m.wrapped.some((w) => w.mac !== undefined) ||
            (incarnation !== undefined && m.incarnation === undefined) ||
            (m.meta !== undefined && hidesMeta(m) !== hideMeta),
          () => true,
        )
      : false;
  const wantFull = noBase || membershipChanged || checkpoint || headUnsealed;

  // The snapshot builds the packs that will travel: the whole tree when a member
  // needs one, only the change otherwise. A whole tree built on a snapshot of
  // the fleet's own also carries the change, so the members that hold that
  // snapshot (nearly all of them, at a checkpoint) do not have to take the tree.
  const withDelta = wantFull && base !== null;
  // The tree the caller took is the tree to publish when the files have not changed since: the same
  // files would be staged again and come out as the same tree. When they have, or when this publish
  // is not built on what the caller's snapshot was, the work tree is taken again, as it is now.
  const reuse = known !== undefined && !caughtUp && (await treeUnchanged) && (known.quiet?.() ?? true);
  const snap = await snapshot({
    work: paths.work,
    gitDir: paths.gitDir,
    base,
    seq,
    wantFull,
    withDelta,
    ...(reuse && known ? { tree: known.tree } : {}),
    ...(paths.nested ? { nested: paths.nested } : {}),
  });
  const payloads = [wantFull ? snap.pack : snap.delta!];
  if (withDelta && snap.delta) payloads.push(snap.delta);

  // One key seals them all, so a member opens either with what it was given.
  const sealed = sealManyForMembers(
    payloads,
    members.map((m) => ({ memberId: hideMeta ? wrapIdOf(incarnation, m.deviceId) : m.deviceId, publicKey: m.pubkey })),
    keys.privateKey,
    keys.publicKey,
  );
  const main = sealed.ciphertexts[0]!;
  // What the gateway would refuse is not uploaded in part: the change pack of a checkpoint goes up before
  // the snapshot that names it, and one that is then refused leaves it stored, one more for every attempt.
  const limit = role?.snapshotLimit;
  if (limit !== undefined) {
    const biggest = Math.max(...sealed.ciphertexts.map((c) => c.length)) + MANIFEST_ALLOWANCE_BYTES;
    if (biggest > limit) throw new Error(snapshotTooBigMessage(biggest, limit));
  }

  // The change travels first and on its own: the gateway stores it and the
  // manifest names it, as it names the pack.
  let delta: FleetManifest["delta"];
  if (sealed.ciphertexts[1]) {
    // The change pack is stored before the manifest that names it, and nothing
    // takes it away if the publish then fails (a gateway that predates this does
    // not know it belongs to a snapshot). So the head is looked at once more
    // first: a publish that is going to be refused is refused before the upload.
    // A look that did not get an answer says nothing about the head: it is asked
    // once more, and if there is still none the check is left out (the publish is
    // refused by the fleet if the head did move, as it always was).
    let again = await fetchHead(creds, fleet).catch(() => null);
    if (again === null) again = await fetchHead(creds, fleet).catch(() => null);
    if (again !== null && again.seq !== (head?.seq ?? 0)) {
      throw new Error("the fleet head moved while publishing: another member won");
    }
    const stored = await putPayload(creds, fleet, "packs", sealed.ciphertexts[1]);
    // The hash the seal binds is the one computed here, of the bytes that were sealed: what the
    // gateway says it stored them under is only believed if it is the same.
    const deltaHash = payloadHash(sealed.ciphertexts[1]);
    if (stored.hash !== deltaHash) {
      throw new Error("the gateway stored the change pack under another hash than the one it was sent with (" + stored.hash + ", not " + deltaHash + ")");
    }
    delta = { packKey: stored.key, packHash: deltaHash, bytes: sealed.ciphertexts[1].length };
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
    roster,
    ...(incarnation !== undefined ? { incarnation } : {}),
    epoch: head?.epoch ?? 0,
    createdAt: Date.now(),
  };
  // The seal binds what the gateway must not be able to change: which snapshot
  // this is, what it follows, and the packs it is made of. (The gateway fills in
  // the packs' keys, but the hashes it computes are the ones taken here.)
  manifest.seal = sealed.seal(sealFieldsOf(manifest, payloadHash(main), delta?.packHash ?? null));
  // What the manifest says of the snapshot, sealed, for a member that reads it from here. The fields beside it stay as
  // they were (a member that predates it reads them) unless every member can read it: then the gateway is shown none.
  manifest.meta = sealed.sealMeta(metaBindingOf(manifest, payloadHash(main), delta?.packHash ?? null), {
    tipCommit: manifest.tipCommit,
    tree: manifest.tree,
    roster: manifest.roster,
  });
  if (hideMeta) {
    manifest.tipCommit = "";
    manifest.tree = "";
    delete manifest.roster;
  }
  // The pack and the manifest travel together, and the gateway moves the head
  // in the same call. One round trip instead of six.
  let moved = await putSnapshot(creds, fleet, manifest, main);
  if (!moved.ok && /catch up first/.test(moved.error ?? "") && (head?.seq ?? 0) <= appliedSeq) {
    // The fleet says this member has not applied the head, which it holds: the
    // report that said so was lost. Say it again, and publish once more.
    await reportApplied(creds, fleet, appliedSeq);
    // The refusal may have taken what the manifest names with it (a gateway cleans up after a publish
    // that did not move the head): the change pack is stored again before the manifest is sent again.
    if (sealed.ciphertexts[1]) await putPayload(creds, fleet, "packs", sealed.ciphertexts[1]);
    moved = await putSnapshot(creds, fleet, manifest, main);
  }
  // Too big for the gateway to take: the head did not move, and nobody won; the gateway says what to do.
  if (!moved.ok && moved.status === 413) throw new Error(moved.error ?? "the snapshot is too big for the gateway");
  if (!moved.ok) {
    throw new Error("the fleet head moved while publishing: " + (moved.error ?? "another member won"));
  }
  // A fleet that records the publisher as applied at once needs no report; an
  // older one does, and a report that cannot get through is made good the next
  // time the fleet says "catch up first" (see above), so it is not an error here.
  await reportApplied(creds, fleet, seq).catch(() => undefined);
  // This fleet has a snapshot with a seal now: from here an unsealed one that is newer is refused.
  const trust = FleetTrust.beside(paths.keyFile);
  trust.noteTakenIn(manifest, creds.deviceId);
  trust.pin(incarnation);
  try {
    trust.save();
  } catch {
    // Not being able to write it only leaves the guard to be learnt from the next sealed snapshot read.
  }
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
  /** Who that snapshot was sealed for, when it says. */
  roster?: string;
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
  /**
   * Packs already being downloaded, by key, because the plan was still being made when the manifest
   * said which one the route would almost certainly take. A step takes its pack from here when it is
   * there, and downloads it itself when it is not; one the route did not take is simply dropped.
   */
  prefetched?: Map<string, Promise<Buffer>>;
}

// How many manifests are looked at before giving up on finding a route.
const WALK_LIMIT = 2 * FULL_PACK_WINDOW + 1;
/**
 * What each step of a route costs besides its pack, in bytes.
 *
 * A step is two round trips (the manifest and the pack), a manifest that carries
 * a wrapped key for every member (about 4 KB with thirty-two of them), two git
 * processes and a record of progress. Counting only the bytes of the packs would
 * send a member forty-one steps and eighty-four requests to save two kilobytes
 * over one whole tree. Twenty-four kilobytes is about where a round trip over a
 * poor link and the manifest stop being noise.
 */
export const ROUTE_STEP_COST = 24 * 1024;

// A size that is not known (a snapshot published before sizes were recorded):
// a whole tree is assumed large and a change small.
const UNKNOWN_WHOLE = 1e12;
const UNKNOWN_CHANGE = 1;

/** Who is asking, so the route only goes through what this member can open. */
export interface Asker {
  memberId: string;
  /** Its key's fingerprint (see `keyIdOf`): a snapshot wrapped for another key of its own is not openable. */
  keyId?: string;
  /** The fingerprint of the key it had before it rotated: what was sealed for that one opens too, until it is taken in. */
  alsoKeyId?: string;
  /** Snapshots up to this sequence are known not to open (a step that failed): leave them out. */
  skipThrough?: number;
  /** What a step costs besides its pack, in bytes (default `ROUTE_STEP_COST`). */
  stepCost?: number;
}

function openableBy(manifest: FleetManifest, who: Asker): boolean {
  if (who.skipThrough !== undefined && manifest.seq <= who.skipThrough) return false;
  const entry = wrappedEntryFor(manifest.wrapped, who.memberId, manifest.incarnation);
  if (!entry) return false;
  // A snapshot from an older publisher does not say which key: trust the id.
  return entry.keyId === undefined || who.keyId === undefined || entry.keyId === who.keyId || (who.alsoKeyId !== undefined && entry.keyId === who.alsoKeyId);
}

// The pack that brings a member that holds the snapshot before this one to this
// snapshot, if there is one it can open.
function changeOf(manifest: FleetManifest, who: Asker): RouteStep | null {
  if (!openableBy(manifest, who)) return null;
  if (!manifest.full) {
    return { manifest, packKey: manifest.packKey, bytes: manifest.packBytes ?? UNKNOWN_CHANGE, whole: false };
  }
  if (manifest.delta) return { manifest, packKey: manifest.delta.packKey, bytes: manifest.delta.bytes, whole: false };
  return null;
}

// The pack that brings a member that holds nothing of the fleet to this snapshot.
function wholeOf(manifest: FleetManifest, who: Asker): RouteStep | null {
  if (!manifest.full || !openableBy(manifest, who)) return null;
  return { manifest, packKey: manifest.packKey, bytes: manifest.packBytes ?? UNKNOWN_WHOLE, whole: true };
}

/**
 * Pick the cheapest way from what a member holds to the snapshots it needs.
 *
 * `walked` is the snapshots from the head back, newest first, with consecutive
 * sequences. A route is either all the changes since `lastSeq`, or a whole tree
 * at some snapshot and the changes after it; the one that moves the fewest bytes
 * wins (each step counting `ROUTE_STEP_COST` besides its pack), and with equal
 * cost the one with fewer steps. A snapshot the member
 * cannot open (sealed before it joined, or for another key) is not a step.
 * Returns null when there is no route.
 */
export function chooseRoute(walked: FleetManifest[], lastSeq: number, asker: Asker | string): RouteStep[] | null {
  const who: Asker = typeof asker === "string" ? { memberId: asker } : asker;
  if (walked.length === 0) return [];
  const byRow = [...walked].reverse(); // oldest first
  const head = byRow[byRow.length - 1]!.seq;
  const lowest = byRow[0]!.seq;
  const at = (seq: number): FleetManifest | undefined => byRow[seq - lowest];

  const changesFrom = (first: number): RouteStep[] | null => {
    const steps: RouteStep[] = [];
    for (let seq = first; seq <= head; seq++) {
      const m = at(seq);
      const step = m ? changeOf(m, who) : null;
      if (!step) return null;
      steps.push(step);
    }
    return steps;
  };
  const each = who.stepCost ?? ROUTE_STEP_COST;
  const cost = (steps: RouteStep[]): number => steps.reduce((sum, s) => sum + s.bytes + each, 0);

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
    const whole = m ? wholeOf(m, who) : null;
    if (!whole) continue;
    const rest = k === head ? [] : changesFrom(k + 1);
    if (rest) consider([whole, ...rest]);
  }
  return best;
}

/** The head as the socket told it: enough to start without asking the gateway. */
export interface HeadHint {
  seq: number;
  manifestKey?: string;
}

/**
 * Work out which snapshots a member has to take to reach the head.
 *
 * With the gateway's index the route is chosen from sizes in one request, and
 * only the manifests of the snapshots on the route are fetched, side by side.
 * Without one (an older gateway, or a gap in what it recorded) the chain is
 * walked back from the head until it reaches the snapshot the member already
 * holds, a snapshot with only a whole tree (nothing older can matter), or the
 * end of what the gateway keeps; then `chooseRoute` picks the cheapest route.
 * Nothing is downloaded but manifests, and nothing is written. The chain is
 * empty when there is nothing newer than `lastSeq`.
 */
export async function planCatchUp(
  creds: FleetCredentials,
  fleet: string,
  lastSeq: number,
  /** What the socket said the head is, if it did. */
  hint?: HeadHint,
  /** The key the member holds, and snapshots known not to open with it. */
  asker?: Omit<Asker, "memberId">,
): Promise<CatchUpPlan> {
  const who: Asker = { memberId: creds.deviceId, ...asker };
  const known = hint && hint.seq > lastSeq && hint.manifestKey;
  const head: FleetHead = known
    ? { seq: hint.seq, manifestKey: hint.manifestKey!, manifestHash: "", epoch: 0 }
    : await fetchHead(creds, fleet);
  if (head.seq <= lastSeq) return { head, chain: [] };

  // The head's manifest is asked for while the index is, not after it: it is where the route ends
  // (nearly always), and the pack it names is asked for the moment it arrives, still before the plan is made.
  const early = startHeadFetch(creds, fleet, lastSeq, head, who);
  const indexed = await planFromIndex(creds, fleet, lastSeq, head, who, early);
  if (indexed) return { ...indexed, prefetched: early.packs };
  return { ...(await planByWalking(creds, fleet, lastSeq, head, who, early)), prefetched: early.packs };
}

/** What is already being fetched of the head while the route is planned. */
interface HeadFetch {
  /** The manifest the head names. A failure is the one of asking for it, reported where it is awaited. */
  manifest: Promise<FleetManifest>;
  manifestKey: string;
  packs: Map<string, Promise<Buffer>>;
}

// Start fetching the head's manifest, and its pack as soon as the manifest says which. Nothing here is
// written anywhere: what is not used is dropped with the plan, and a fetch that fails is only heard of
// by the step that takes its pack.
function startHeadFetch(creds: FleetCredentials, fleet: string, lastSeq: number, head: FleetHead, who: Asker): HeadFetch {
  const packs = new Map<string, Promise<Buffer>>();
  const manifest = fetchManifest(creds, fleet, manifestIdOf(head.manifestKey));
  const quiet = (): void => undefined;
  manifest.then((m) => {
    // A member one snapshot behind has no other route than this snapshot, and the planner chooses the
    // pack to take from it as it will from the index (the sizes are the same): the one it would take is
    // asked for. A snapshot the member cannot open is not fetched at all.
    if (m.seq !== lastSeq + 1 || m.seq !== head.seq) return;
    const step = chooseRoute([m], lastSeq, who)?.[0];
    if (!step || packs.has(step.packKey)) return;
    const pack = getPayload(creds, fleet, "packs", manifestIdOf(step.packKey));
    pack.catch(quiet);
    packs.set(step.packKey, pack);
  }, quiet);
  return { manifest, manifestKey: head.manifestKey, packs };
}

// Choose the route from the index, then fetch the manifests it names. Returns
// null whenever the index does not settle it, so the caller walks.
async function planFromIndex(creds: FleetCredentials, fleet: string, lastSeq: number, head: FleetHead, who: Asker, early: HeadFetch): Promise<CatchUpPlan | null> {
  const entries = await fetchIndex(creds, fleet, lastSeq).catch(() => null);
  if (!entries || entries.length === 0) return null;
  // Consecutive, and reaching the head: otherwise the index is behind or has a hole.
  for (let i = 1; i < entries.length; i++) if (entries[i]!.seq !== entries[i - 1]!.seq + 1) return null;
  const tip = entries[entries.length - 1]!;
  if (tip.seq < head.seq) return null;

  // A skeleton of each manifest, as sealed for this member: the real one is
  // fetched (and checked) for the snapshots the route turns out to use.
  const skeleton = (e: IndexEntry): FleetManifest => ({
    fleet,
    seq: e.seq,
    tipCommit: "",
    tree: "",
    packKey: "",
    packHash: "",
    ...(e.packBytes !== undefined ? { packBytes: e.packBytes } : {}),
    ...(e.deltaBytes !== undefined ? { delta: { packKey: "", packHash: "", bytes: e.deltaBytes } } : {}),
    full: e.full,
    senderPublicKey: "",
    // Unknown who it is sealed for: assumed this member, and checked on the
    // manifest of every snapshot the route turns out to use.
    wrapped: [{ memberId: who.memberId, wrapped: "", ...(who.keyId ? { keyId: who.keyId } : {}) }],
    epoch: 0,
    createdAt: 0,
  });
  const route = chooseRoute([...entries].reverse().map(skeleton), lastSeq, who);
  if (route === null) return null;

  const bySeq = new Map(entries.map((e) => [e.seq, e]));
  // The newest snapshot first, on its own: if it is not sealed for this member no
  // route reaches it, and nothing else need be read.
  // The head's manifest is already being fetched: what is asked for by the same name is not asked for twice.
  const manifestOf = (key: string): Promise<FleetManifest> => (key === early.manifestKey ? early.manifest : fetchManifest(creds, fleet, manifestIdOf(key)));
  const newest = await manifestOf(tip.manifestKey).catch((err: unknown) => {
    if (err instanceof PayloadGoneError) return null; // the index is behind what the gateway keeps
    throw err;
  });
  if (newest === null) return null;
  if (newest.seq === tip.seq && !openableBy(newest, who)) throw new NotSealedYetError();
  let real: FleetManifest[];
  try {
    real = await mapLimit(route, 6, async (step) =>
      step.manifest.seq === newest.seq ? newest : manifestOf(bySeq.get(step.manifest.seq)!.manifestKey),
    );
  } catch (err) {
    if (err instanceof PayloadGoneError) return null; // let go since the index was read
    throw err;
  }
  const chain: RouteStep[] = [];
  for (const [i, step] of route.entries()) {
    const m = real[i]!;
    const chosen = step.whole ? wholeOf(m, who) : changeOf(m, who);
    // The manifest says otherwise (not sealed for this member, or not what the
    // index claimed): do not trust the index for this one.
    if (!chosen || m.seq !== step.manifest.seq) return null;
    chain.push(chosen);
  }
  return { head: tip.seq > head.seq ? { ...head, seq: tip.seq, manifestKey: tip.manifestKey } : head, chain };
}

// Run `fn` over `items`, a few at a time, keeping the order of the results.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function planByWalking(creds: FleetCredentials, fleet: string, lastSeq: number, head: FleetHead, who: Asker, early: HeadFetch): Promise<CatchUpPlan> {
  // Each snapshot names the one it was built against, so the chain is walked
  // backwards until it reaches what is already here.
  const walked: FleetManifest[] = [];
  let manifest: FleetManifest | null = await early.manifest;
  while (manifest !== null && manifest.seq > lastSeq) {
    walked.push(manifest);
    // The newest snapshot is not sealed for this member: no route reaches it.
    if (walked.length === 1 && !openableBy(manifest, who)) throw new NotSealedYetError();
    // A snapshot this member cannot open ends the walk: a route through it does not
    // exist, and one that starts after it needs nothing older.
    if (!openableBy(manifest, who)) break;
    // A whole tree with no change beside it ends the walk: no route goes back past it.
    if (manifest.full && !manifest.delta) break;
    if (manifest.parentManifest === undefined || walked.length >= WALK_LIMIT) break;
    const parent: FleetManifest | null = await fetchManifest(creds, fleet, manifestIdOf(manifest.parentManifest)).catch(() => null);
    if (parent === null) break; // let go by the gateway (or not readable): the walk ends here, as it always did
    // A snapshot follows the head it was published on, whose sequence is one below its own: a chain
    // that says otherwise was rearranged (a snapshot shown under a sequence that is not its own), and
    // that is what is reported, not that no whole tree is left to start from.
    if (parent.seq !== manifest.seq - 1 || (manifest.parentSeq !== undefined && manifest.parentSeq !== parent.seq)) {
      throw new TamperedSnapshotError(
        manifest.seq,
        "the snapshot it says it follows is snapshot " + parent.seq + ", not " + (manifest.seq - 1) + ": the chain of snapshots was rearranged, as when an older snapshot is shown under a newer sequence",
      );
    }
    manifest = parent;
  }
  if (walked.length === 0) return { head, chain: [] };

  const chain = chooseRoute(walked, lastSeq, who);
  if (chain === null) {
    const oldest = walked[walked.length - 1]!;
    throw new NoRouteError(
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
  /** What this member trusts (see fleet-trust.ts); without it only the seal is checked. */
  trust?: FleetTrust,
): Promise<Buffer> {
  return (await downloadStep(creds, fleet, keys, step, trust)).plain;
}

// `openStep`, with the pack it opened as one piece: checking that the snapshot may be taken in
// after the ones before it is left to the caller, which takes them in in order.
async function downloadStep(
  creds: FleetCredentials,
  fleet: string,
  keys: MemberKeyPair,
  step: RouteStep,
  trust?: FleetTrust,
  /** The pack, when it is already being downloaded. */
  ahead?: Promise<Buffer>,
): Promise<{ plain: Buffer; manifest: FleetManifest }> {
  const sealed = await (ahead ?? getPayload(creds, fleet, "packs", manifestIdOf(step.packKey)));
  // The gateway cannot open this: the snapshot key was sealed for us.
  const m = step.manifest;
  // A member that rotated its key still opens what was sealed for the key it had, until it has taken that in.
  const opened =
    openPayload(sealed, m.wrapped, m.senderPublicKey, creds.deviceId, keys.privateKey, m.incarnation) ??
    (keys.previous ? openPayload(sealed, m.wrapped, m.senderPublicKey, creds.deviceId, keys.previous.privateKey, m.incarnation) : null);
  if (!opened) {
    // A sealed snapshot with a key wrapped for exactly this member's key, whose pack
    // does not open, is not "sealed before this device joined": it is damaged or swapped.
    const mine = wrappedEntryFor(m.wrapped, creds.deviceId, m.incarnation);
    const ours = [keyIdOf(keys.publicKey), ...(keys.previous ? [keyIdOf(keys.previous.publicKey)] : [])];
    if (m.seal !== undefined && mine?.keyId !== undefined && ours.includes(mine.keyId)) {
      throw new TamperedSnapshotError(m.seq, "its pack does not open with the key it was wrapped for this member (damaged, or another snapshot's)");
    }
    throw new NotSealedError(m.seq);
  }
  // Opening proves the pack came from a holder of the snapshot key; it does not say
  // that the manifest is the one that holder made.
  // What it says of the commit, tree and roster is read from its sealed metadata when it has any, and that is
  // what the caller goes on with.
  const checked = await verifySnapshot(creds, fleet, m, sealed, m.delta !== undefined && step.packKey === m.delta.packKey, opened, trust);
  return { plain: opened.plain, manifest: checked };
}

/** The fleet has no route from what a member holds to its head (no whole tree to start from). */
export class NoRouteError extends Error {}

/**
 * The newest snapshot is not sealed for this member: it joined, or came back with
 * a new key, after it was published. Nothing can be done until the primary
 * publishes again, which it does as soon as it notices the roster changed.
 */
export class NotSealedYetError extends Error {
  constructor() {
    super(
      "the fleet has no snapshot sealed for this member yet: it joined (or came back with a new key) after the newest one was published, and the primary publishes again as soon as it notices",
    );
  }
}

/** A snapshot this member cannot open: sealed before it joined, or for a key it no longer has. */
export class NotSealedError extends Error {
  constructor(readonly seq: number) {
    super(
      "snapshot " + seq + " was not sealed for this member: it was published before this device joined, or for another key of its own, so the primary has to publish again now that it has",
    );
  }
}

/** A snapshot that has been applied to the work tree. */
export interface AppliedStep {
  seq: number;
  commit: string;
  tree: string;
  /** Who the snapshot was sealed for, when it says. */
  roster?: string;
}

/** A snapshot a member holds: its sequence, the commit that names it and its tree. */
export interface Position {
  seq: number;
  commit: string | null;
  tree?: string;
  /** Who the snapshot was sealed for, when it says. */
  roster?: string;
}

// How many packs are downloaded at the same time while earlier ones are taken in.
const DOWNLOADS_AT_ONCE = 4;

/**
 * Bring the snapshots up to the head into this member's object store.
 *
 * It only downloads, opens and keeps: the work tree is not touched, so a
 * member can do this in the background and apply later (or never). The route is
 * the cheapest the planner finds from `from`, which is the newest snapshot the
 * member holds in its store - applied or only fetched. Packs are downloaded a few
 * at a time and taken in in order; each one is reported to `onFetched` as it is
 * kept, so a failure part-way loses nothing already fetched.
 */
export async function fetchAhead(
  creds: FleetCredentials,
  fleet: string,
  paths: MemberPaths,
  from: Position,
  onFetched?: (fetched: Position) => void | Promise<void>,
  /** What the socket said the head is, so the gateway need not be asked. */
  hint?: HeadHint,
): Promise<{ head: FleetHead; fetched: Position; steps: number; evicted: number }> {
  const keys = loadOrCreateKeyPair(paths.keyFile);
  const keyId = keyIdOf(keys.publicKey);
  // A route can run through a snapshot that cannot be opened (the index does not
  // say who a snapshot is sealed for, and a manifest only turns up the problem
  // when it is read). Then the route is planned again without it, so a member is
  // never stuck on a step it can never take while a whole tree it can open waits
  // at the head.
  let skipThrough: number | undefined;
  // The snapshot that was refused, and could be routed around: if nothing can, it is what to tell.
  let refused: TamperedSnapshotError | undefined;
  let position = from;
  let steps = 0;
  // How often a snapshot the route needed was let go by the gateway before it was
  // fetched: it keeps a number of snapshots, not a length of time, and a fleet
  // that publishes fast outruns a member that downloads a big tree slowly.
  let evicted = 0;
  for (let attempt = 0; ; attempt++) {
    const plan = await planCatchUp(creds, fleet, position.seq, hint, { keyId, ...(keys.previous ? { alsoKeyId: keyIdOf(keys.previous.publicKey) } : {}), ...(skipThrough !== undefined ? { skipThrough } : {}) }).catch((err: unknown) => {
      // Going around a refused snapshot found no route: say why it was refused, not what the planner missed.
      throw refused && (err instanceof NotSealedYetError || err instanceof NoRouteError) ? refused : err;
    });
    if (plan.chain.length === 0) return { head: plan.head, fetched: position, steps, evicted };
    const progress: Position[] = [];
    try {
      const got = await ingestRoute(creds, fleet, paths, keys, plan, position, async (p) => {
        progress.push(p);
        await onFetched?.(p);
      });
      return { head: plan.head, fetched: got, steps: steps + plan.chain.length, evicted };
    } catch (err) {
      if (err instanceof PayloadGoneError && attempt < 3) {
        // Plan again from what was kept: the head has moved on, and so has the route.
        evicted++;
        const last = progress[progress.length - 1];
        if (last) {
          steps += progress.length;
          position = last;
        }
        continue;
      }
      if (err instanceof PayloadGoneError) {
        throw new Error(
          "the snapshots this catch-up needs were let go by the gateway while it ran " + (evicted + 1) + " times: the fleet publishes faster than this member can fetch",
        );
      }
      // A snapshot that cannot be opened, or one that is refused for a reason that a later whole
      // tree does away with (an unsealed one after sealed ones; one sealed by a member that has
      // left), is routed around: the route is planned again without it.
      const skippable = err instanceof NotSealedError || (err instanceof TamperedSnapshotError && err.skippable);
      if (!skippable || attempt >= 3) throw err;
      if (err instanceof TamperedSnapshotError) refused = err;
      skipThrough = Math.max(skipThrough ?? 0, err.seq);
      // What was kept before the step that failed stays kept.
      const kept = keptBefore(plan, err.seq, position);
      steps += kept.steps;
      position = kept.position;
    }
  }
}

// The newest position the route kept before it failed at `failedSeq`.
function keptBefore(plan: CatchUpPlan, failedSeq: number, from: Position): { position: Position; steps: number } {
  let position = from;
  let steps = 0;
  for (const step of plan.chain) {
    if (step.manifest.seq >= failedSeq) break;
    position = {
      seq: step.manifest.seq,
      commit: step.manifest.tipCommit,
      tree: step.manifest.tree,
      ...(step.manifest.roster !== undefined ? { roster: step.manifest.roster } : {}),
    };
    steps++;
  }
  return { position, steps };
}

// Download the route a few packs at a time and take them in, in order.
async function ingestRoute(
  creds: FleetCredentials,
  fleet: string,
  paths: MemberPaths,
  keys: MemberKeyPair,
  plan: CatchUpPlan,
  from: Position,
  onFetched?: (fetched: Position) => void | Promise<void>,
): Promise<Position> {
  const downloads: Array<Promise<{ plain: Buffer; manifest: FleetManifest }> | undefined> = [];
  const trust = FleetTrust.beside(paths.keyFile);
  const start = (i: number): void => {
    if (i < plan.chain.length && downloads[i] === undefined) {
      const step = plan.chain[i]!;
      const p = downloadStep(creds, fleet, keys, step, trust, plan.prefetched?.get(step.packKey));
      // A failure is reported where it is awaited, in order.
      p.catch(() => undefined);
      downloads[i] = p;
    }
  };
  for (let i = 0; i < DOWNLOADS_AT_ONCE; i++) start(i);

  let fetched = from;
  for (const [i, step] of plan.chain.entries()) {
    const { plain: pack, manifest: m } = await downloads[i]!;
    downloads[i] = undefined; // let the bytes go
    start(i + DOWNLOADS_AT_ONCE);
    // From here the step is the snapshot as it was opened (a failure later on is routed around from what was kept).
    step.manifest = m;
    // Whether this one may be taken in is asked here, in order, and what it shows is
    // remembered once it has been: a snapshot downloaded ahead of the ones before it
    // says nothing yet about what the fleet has shown.
    await trust.learnGate(creds, fleet, m);
    trust.checkNotDowngrade(m, creds.deviceId);
    // Only the newest one is named by a ref: it is what the member goes on from,
    // and one ref (one more git process) per step is cost for nothing.
    await ingestPack(paths.work, paths.gitDir, m.tipCommit, pack, {
      tree: m.tree,
      ...(i === plan.chain.length - 1 ? { seq: m.seq } : {}),
    });
    trust.noteTakenIn(m, creds.deviceId);
    trust.save();
    fetched = { seq: m.seq, commit: m.tipCommit, tree: m.tree, ...(m.roster !== undefined ? { roster: m.roster } : {}) };
    await onFetched?.(fetched);
  }
  return fetched;
}

/**
 * Write `fetched` over the work tree and record it, as one step nobody else's can come between.
 *
 * The work tree has one lock, taken here. Inside it the recorded position is read again: if
 * another writer has already brought the work tree to `fetched` or beyond, nothing is written (its
 * state is the truth, and writing an older snapshot over a newer one is exactly what must not
 * happen); if it has brought it part of the way, the apply starts from there. `record` runs before
 * the lock is let go, so the state always says what the work tree holds. Returns what the work
 * tree holds now, and whether this call wrote it.
 */
export async function applyAndRecord(
  paths: MemberPaths,
  applied: Position,
  fetched: Position,
  record: () => void | Promise<void>,
  /** Run inside the lock, once the position the apply starts from is known (before anything is written). */
  prepare?: (from: Position) => void | Promise<void>,
): Promise<{ position: Position; wrote: boolean }> {
  return withApplyLock(paths.gitDir, async () => {
    const now = paths.recorded?.();
    if (now && now.seq >= fetched.seq && now.commit !== null) return { position: now, wrote: false };
    const from = now && now.seq > applied.seq ? now : applied;
    await prepare?.(from);
    await applyFetched(paths, from, fetched);
    await record();
    return { position: fetched, wrote: true };
  });
}

/**
 * Write what has been fetched over the work tree.
 *
 * One apply covers every snapshot between `applied` and `fetched`: the work
 * tree only sees the difference. Directories the fleet leaves alone are not
 * mirrored, so they survive untouched.
 */
export async function applyFetched(paths: MemberPaths, applied: Position, fetched: Position): Promise<void> {
  if (fetched.commit === null) throw new Error("nothing has been fetched to apply");
  const exclude = paths.nested ? paths.nested.get() : findNestedRepos(paths.work);
  await applyCommit(paths.work, paths.gitDir, fetched.commit, exclude, applied.commit);
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
 *  `fetched` is a newer snapshot the member has already taken into its store
 *  without applying it: the route starts from there, and its packs are not
 *  downloaded again.
 *
 *  Everything is fetched and opened before anything is written, so a chain that
 *  cannot be fetched or opened touches nothing. The work tree is then written
 *  once, for the whole lag, and `onStep` hears about it when it has the newest
 *  snapshot: the caller records the state right then.
 *
 */
export async function pull(
  creds: FleetCredentials,
  fleet: string,
  paths: MemberPaths,
  lastSeq: number,
  lastCommit?: string | null,
  onStep?: (step: AppliedStep) => void | Promise<void>,
  fetched?: Position,
): Promise<PullResult> {
  const applied: Position = { seq: lastSeq, commit: lastCommit ?? null };
  const from = fetched && fetched.seq > lastSeq ? fetched : applied;
  const got = await fetchAhead(creds, fleet, paths, from);
  if (got.fetched.seq <= lastSeq || got.fetched.commit === null) {
    return { seq: got.head.seq, commit: "", applied: false, upToDate: true };
  }
  const tip = got.fetched;
  const step: AppliedStep = { seq: tip.seq, commit: tip.commit!, tree: tip.tree ?? "", ...(tip.roster !== undefined ? { roster: tip.roster } : {}) };
  const done = await applyAndRecord(paths, applied, tip, () => onStep?.(step));
  if (!done.wrote) {
    // Another writer has the work tree at this snapshot or a newer one already: that is where it is.
    const at = done.position;
    await reportApplied(creds, fleet, at.seq);
    return { seq: at.seq, commit: at.commit ?? "", applied: true, upToDate: false, ...(at.tree ? { tree: at.tree } : {}) };
  }
  await reportApplied(creds, fleet, tip.seq);
  return {
    seq: tip.seq,
    commit: tip.commit!,
    applied: true,
    upToDate: false,
    ...(tip.tree ? { tree: tip.tree } : {}),
    ...(tip.roster !== undefined ? { roster: tip.roster } : {}),
  };
}

/** The storage id at the end of a payload key. */
export function manifestIdOf(key: string): string {
  const parts = key.split("/");
  return parts[parts.length - 1] ?? key;
}
