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
import { generateMemberKeyPair, keyIdOf, openForMember, sealManyForMembers, type MemberKeyPair } from "./fleet-crypto";
import {
  PayloadGoneError,
  type IndexEntry,
  fetchHead,
  fetchIndex,
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
    roster,
    epoch: head?.epoch ?? 0,
    createdAt: Date.now(),
  };
  // The pack and the manifest travel together, and the gateway moves the head
  // in the same call. One round trip instead of six.
  let moved = await putSnapshot(creds, fleet, manifest, main);
  if (!moved.ok && /catch up first/.test(moved.error ?? "") && (head?.seq ?? 0) <= appliedSeq) {
    // The fleet says this member has not applied the head, which it holds: the
    // report that said so was lost. Say it again, and publish once more.
    await reportApplied(creds, fleet, appliedSeq);
    moved = await putSnapshot(creds, fleet, manifest, main);
  }
  if (!moved.ok) {
    throw new Error("the fleet head moved while publishing: " + (moved.error ?? "another member won"));
  }
  // A fleet that records the publisher as applied at once needs no report; an
  // older one does, and a report that cannot get through is made good the next
  // time the fleet says "catch up first" (see above), so it is not an error here.
  await reportApplied(creds, fleet, seq).catch(() => undefined);
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
  /** Snapshots up to this sequence are known not to open (a step that failed): leave them out. */
  skipThrough?: number;
  /** What a step costs besides its pack, in bytes (default `ROUTE_STEP_COST`). */
  stepCost?: number;
}

function openableBy(manifest: FleetManifest, who: Asker): boolean {
  if (who.skipThrough !== undefined && manifest.seq <= who.skipThrough) return false;
  const entry = manifest.wrapped.find((w) => w.memberId === who.memberId);
  if (!entry) return false;
  // A snapshot from an older publisher does not say which key: trust the id.
  return entry.keyId === undefined || who.keyId === undefined || entry.keyId === who.keyId;
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

  const indexed = await planFromIndex(creds, fleet, lastSeq, head, who);
  if (indexed) return indexed;
  return planByWalking(creds, fleet, lastSeq, head, who);
}

// Choose the route from the index, then fetch the manifests it names. Returns
// null whenever the index does not settle it, so the caller walks.
async function planFromIndex(creds: FleetCredentials, fleet: string, lastSeq: number, head: FleetHead, who: Asker): Promise<CatchUpPlan | null> {
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
  const newest = await fetchManifest(creds, fleet, manifestIdOf(tip.manifestKey)).catch((err: unknown) => {
    if (err instanceof PayloadGoneError) return null; // the index is behind what the gateway keeps
    throw err;
  });
  if (newest === null) return null;
  if (newest.seq === tip.seq && !openableBy(newest, who)) throw new NotSealedYetError();
  let real: FleetManifest[];
  try {
    real = await mapLimit(route, 6, async (step) =>
      step.manifest.seq === newest.seq ? newest : fetchManifest(creds, fleet, manifestIdOf(bySeq.get(step.manifest.seq)!.manifestKey)),
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

async function planByWalking(creds: FleetCredentials, fleet: string, lastSeq: number, head: FleetHead, who: Asker): Promise<CatchUpPlan> {
  // Each snapshot names the one it was built against, so the chain is walked
  // backwards until it reaches what is already here.
  const walked: FleetManifest[] = [];
  let manifest: FleetManifest | null = await fetchManifest(creds, fleet, manifestIdOf(head.manifestKey));
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
    if (parent === null || parent.seq !== manifest.seq - 1) break;
    manifest = parent;
  }
  if (walked.length === 0) return { head, chain: [] };

  const chain = chooseRoute(walked, lastSeq, who);
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
  if (!plain) throw new NotSealedError(m.seq);
  return plain;
}

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
  let position = from;
  let steps = 0;
  // How often a snapshot the route needed was let go by the gateway before it was
  // fetched: it keeps a number of snapshots, not a length of time, and a fleet
  // that publishes fast outruns a member that downloads a big tree slowly.
  let evicted = 0;
  for (let attempt = 0; ; attempt++) {
    const plan = await planCatchUp(creds, fleet, position.seq, hint, { keyId, ...(skipThrough !== undefined ? { skipThrough } : {}) });
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
      if (!(err instanceof NotSealedError) || attempt >= 2) throw err;
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
  const downloads: Array<Promise<Buffer> | undefined> = [];
  const start = (i: number): void => {
    if (i < plan.chain.length && downloads[i] === undefined) {
      const p = openStep(creds, fleet, keys, plan.chain[i]!);
      // A failure is reported where it is awaited, in order.
      p.catch(() => undefined);
      downloads[i] = p;
    }
  };
  for (let i = 0; i < DOWNLOADS_AT_ONCE; i++) start(i);

  let fetched = from;
  for (const [i, step] of plan.chain.entries()) {
    const pack = await downloads[i]!;
    downloads[i] = undefined; // let the bytes go
    start(i + DOWNLOADS_AT_ONCE);
    const m = step.manifest;
    // Only the newest one is named by a ref: it is what the member goes on from,
    // and one ref (one more git process) per step is cost for nothing.
    await ingestPack(paths.work, paths.gitDir, m.tipCommit, pack, {
      tree: m.tree,
      ...(i === plan.chain.length - 1 ? { seq: m.seq } : {}),
    });
    fetched = { seq: m.seq, commit: m.tipCommit, tree: m.tree, ...(m.roster !== undefined ? { roster: m.roster } : {}) };
    await onFetched?.(fetched);
  }
  return fetched;
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
  await applyFetched(paths, applied, tip);
  const step: AppliedStep = { seq: tip.seq, commit: tip.commit!, tree: tip.tree ?? "", ...(tip.roster !== undefined ? { roster: tip.roster } : {}) };
  await onStep?.(step);
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

/** Wait until the work tree stops changing, then snapshot it. */
export async function snapshotNow(work: string, gitDir: string, base: string | null) {
  await settle(work);
  return snapshot({ work, gitDir, base });
}
