// The wire between a fleet member and the gateway.
//
// A member never talks to R2 directly: the account cannot give it S3
// credentials, and the gateway is the component that holds them. So the
// member sends the gateway what it wants stored and asks for what it wants
// back, and the gateway stores bytes it cannot read.

import { createHash } from "node:crypto";

/** What a member says it can read, by name: a small snapshot that comes with the news of the head (`head` event's `inline`). The gateway sends it only to members that say so. */
export const INLINE_CAP = "inline";

/**
 * What a member says it can read, by name (`meta2`: a manifest whose commit, tree and roster are sealed, see `SnapshotMeta`): a
 * format is published only when every member of the fleet lists it (the keys listed for the snapshot carry each member's).
 */
export const META_CAP = "meta2";

/** What a member says it can read, by name: packs in pieces, for a snapshot bigger than one request. */
export const CHUNKS_CAP = "chunks";

/**
 * What this build can do beyond the first form of the wire, said to the fleet each time a place is taken (`caps` in
 * the body of a bootstrap). A format that only some members read is used by a publisher only when every member of the
 * fleet lists its name (`role.fleetCaps`; see `fleetHas`). Short lower-case names, added here as the code that
 * reads and writes the form lands, and nowhere else: this build says only what it does.
 */
export const MEMBER_CAPS: readonly string[] = [META_CAP, INLINE_CAP, CHUNKS_CAP];

/** What a capability's name looks like: the pattern the gateway keeps (`^[a-z0-9][a-z0-9-]{0,23}$`), so that both sides read the same names. */
export const CAP_NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;

/** Text a gateway sent, made safe to print in a terminal or a log: no control characters (an escape sequence is not a hint), cut short. */
export function plainText(text: string, max = 400): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, max);
}

/** The part of a bootstrap body that says what the member can do: nothing at all while it can do nothing more. */
export function capsBody(caps: readonly string[] = MEMBER_CAPS): { caps?: string[] } {
  return caps.length > 0 ? { caps: [...caps] } : {};
}

/** Whether every member of the fleet has the capability (an advisory answer: it is never what a security rule rests on). */
export function fleetHas(role: { fleetCaps?: readonly string[] }, cap: string): boolean {
  return role.fleetCaps?.includes(cap) === true;
}

export interface FleetCredentials {
  gateway: string;
  deviceId: string;
  deviceToken: string;
  timeoutMs?: number;
}

export interface FleetHead {
  seq: number;
  manifestKey: string;
  manifestHash: string;
  epoch: number;
}

/** One piece of a sealed pack that was too big for one request: stored under its own hash, in order. */
export interface Chunk {
  /** sha256 (hex) of the piece. */
  hash: string;
  bytes: number;
}

/** The size a pack is cut into, and the most a member takes a manifest to say: it is the gateway's word, so it is checked. */
export const CHUNK_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES_MAX = 2 * CHUNK_BYTES;
/** The most pieces one pack may have, and the most bytes one chunked pack may be, whatever a manifest says. */
export const CHUNKS_MAX = 128;
export const CHUNKED_BYTES_MAX = 512 * 1024 * 1024;

export interface FleetManifest {
  fleet: string;
  seq: number;
  /** The commit whose tree this snapshot holds. */
  tipCommit: string;
  /** The tree itself, so a replica can check what it applied. */
  tree: string;
  /** Where the sealed pack is stored. */
  packKey: string;
  /** sha256 of the sealed pack. */
  packHash: string;
  /** Size of the sealed pack in bytes, so a member can choose the cheaper route. */
  packBytes?: number;
  /**
   * The pack in pieces, when it was too big to send at once: `packHash` is still the hash of the whole sealed
   * pack (what the seal binds), and `packKey` is the first piece's. Present only when every member could read it.
   */
  chunks?: Chunk[];
  /**
   * The change since the snapshot before, for a snapshot whose pack is a whole
   * tree. A member that holds that snapshot takes this instead of the tree; it
   * is sealed with the same key as the pack. Older members ignore it.
   */
  delta?: { packKey: string; packHash: string; bytes: number; chunks?: Chunk[] };
  /**
   * True when the pack carries the whole tree.
   *
   * A member that joins the fleet, or one that has fallen too far behind to
   * have the base, needs one of these: a delta is only useful to a member
   * that already holds the snapshot it is built against.
   */
  full: boolean;
  /** The manifest of the snapshot this one is built against. */
  parentManifest?: string;
  /** The sequence of that snapshot. */
  parentSeq?: number;
  /** The sender's public key, so a receiver can derive the shared secret. */
  senderPublicKey: string;
  /** The snapshot key, wrapped for each member. */
  wrapped: Array<{ memberId: string; wrapped: string; keyId?: string; mac?: string }>;
  /**
   * Who this snapshot was sealed for, and with which keys (see `rosterOf`). A
   * member that applies it knows the roster it stands on, so when it takes over it
   * does not take the fleet for changed and publish a whole tree it need not.
   */
  roster?: string;
  /**
   * Which fleet of this name the snapshot belongs to (the gateway's `/role` says which it is now: `fetchRole`): sealed, so a
   * snapshot of an earlier fleet that had the name does not pass for this one's.
   */
  incarnation?: string;
  /**
   * The publisher's seal over what the manifest claims (see `SealFields` in
   * fleet-crypto.ts). Only a member that holds the snapshot key can make it, so a
   * manifest the gateway edited, or an old snapshot shown under a newer sequence,
   * does not match. Absent from snapshots of publishers that predate it.
   */
  seal?: string;
  /**
   * What the gateway has no need to read, sealed with a key derived from the snapshot key (see `SnapshotMeta` in
   * fleet-crypto.ts): the commit and tree, who the snapshot is sealed for, and what a feature adds. A member
   * reads these from here when it is present, and from the fields above only when it is not. When every member can
   * read it (`META_CAP`), those fields are left empty (`tipCommit` and `tree` are "", `roster` is absent) and the
   * entries of `wrapped` are listed under `wrapIdOf`, not device ids. Absent from snapshots of publishers that predate it.
   */
  meta?: string;
  /** Which epoch published this, for the fencing check. */
  epoch: number;
  createdAt: number;
}

export class FleetTransportError extends Error {}

/** A payload the gateway no longer has (a snapshot it let go while it was being fetched). */
export class PayloadGoneError extends FleetTransportError {
  constructor() {
    super("no such payload");
  }
}

function headers(creds: FleetCredentials, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {
    "x-prime-device": creds.deviceId,
    "x-device-token": creds.deviceToken,
    ...extra,
  };
  return out;
}

async function request(
  creds: FleetCredentials,
  method: string,
  path: string,
  body?: Buffer | string,
  contentType?: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), creds.timeoutMs ?? 120_000);
  try {
    const extra: Record<string, string> = {};
    if (contentType) extra["content-type"] = contentType;
    return await fetch(creds.gateway + path, {
      method,
      headers: headers(creds, extra),
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** The sha256 of a payload, used as its storage id. */
export function payloadHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Read the fleet's current head. */
export async function fetchHead(creds: FleetCredentials, fleet: string): Promise<FleetHead> {
  const res = await request(creds, "GET", "/fleets/" + encodeURIComponent(fleet) + "/head");
  if (res.status === 404) throw new FleetTransportError("this fleet has no head yet");
  if (!res.ok) throw new FleetTransportError("could not read the head: " + res.status);
  const body = (await res.json()) as { head: FleetHead };
  return body.head;
}

/** Store a sealed payload. The gateway keeps bytes it cannot open. */
export async function putPayload(
  creds: FleetCredentials,
  fleet: string,
  kind: "packs" | "manifests",
  bytes: Buffer,
): Promise<{ key: string; hash: string; size: number }> {
  const res = await request(
    creds,
    "POST",
    "/fleets/" + encodeURIComponent(fleet) + "/" + kind,
    bytes,
    "application/octet-stream",
  );
  if (res.status === 409) throw new FleetTransportError("only the primary may publish");
  if (!res.ok) throw new FleetTransportError("could not store the payload: " + res.status);
  return (await res.json()) as { key: string; hash: string; size: number };
}

/** Fetch a manifest by the id it is stored under. */
// The id a manifest was fetched under (the hash of its bytes), for the manifests that were. Kept beside
// the manifest rather than in it: it is not part of what the publisher made or sealed.
const fetchedAs = new WeakMap<FleetManifest, string>();

/** The id (hash) a manifest was fetched under, if it was fetched. */
export function manifestHashOf(m: FleetManifest): string | undefined {
  return fetchedAs.get(m);
}

/** A copy of a manifest (with its metadata read into it) is the same manifest as far as the hash it was fetched under goes. */
export function manifestCopy(from: FleetManifest, changes: Partial<FleetManifest>): FleetManifest {
  const copy: FleetManifest = { ...from, ...changes };
  const hash = fetchedAs.get(from);
  if (hash !== undefined) fetchedAs.set(copy, hash);
  return copy;
}

export async function fetchManifest(creds: FleetCredentials, fleet: string, id: string): Promise<FleetManifest> {
  // A manifest is stored under the hash of its bytes. A name that is not one leaves nothing to check
  // what comes back against, so it is not asked for.
  if (!/^[0-9a-f]{64}$/.test(id)) throw new FleetTransportError("a manifest is named by its hash, and " + id.slice(0, 40) + " is not a hash");
  const bytes = await getPayload(creds, fleet, "manifests", id);
  // What came back is what the head (or the snapshot after it) named, or it is not this manifest at all.
  if (payloadHash(bytes) !== id) {
    throw new FleetTransportError("the manifest the gateway returned is not the one that was asked for");
  }
  const manifest = JSON.parse(bytes.toString("utf8")) as FleetManifest;
  // The hash it was stored under: of the bytes that came back, which is what the id says when it is a hash.
  fetchedAs.set(manifest, payloadHash(bytes));
  return manifest;
}

// What the socket brought of the newest snapshots: found by the hash of the bytes, which is the id the gateway
// stores them under (a manifest by the hash of its text, a pack by the hash of the sealed pack), so a part that
// is asked for by its id is exactly the bytes that hash to it. A few small snapshots, for a few minutes.
// (Entries are not tied to a gateway: two gateways hosting a fleet of the same name share them, and that is harmless,
// since what is served is only what hashes to the id asked for.)
const INLINE_KEEP = 16; // parts: a manifest and a pack each, so 8 snapshots
const INLINE_TTL_MS = 5 * 60_000;
const inlineHeld = new Map<string, { bytes: Buffer; at: number }>();

/** How many bytes of a manifest or pack are taken from a socket message. */
const INLINE_BYTES_MAX = 96 * 1024;

/**
 * Keep the manifest and pack a head event carried, so the next ask for them by id is answered from here.
 *
 * Each part is kept under the sha256 of its own bytes, whatever the event says it is, so it can only answer an ask
 * for exactly those bytes: a manifest or pack that is not the one the head names is never asked for, and one that is
 * can only be itself. What the snapshot then is gets checked as for any fetched one (seal, sender, key).
 */
export function noteInline(fleet: string, inline: { manifest: string; pack: string }, now: number = Date.now()): void {
  const manifest = Buffer.from(inline.manifest, "utf8");
  const pack = Buffer.from(inline.pack, "base64");
  if (manifest.length === 0 || pack.length === 0 || manifest.length > INLINE_BYTES_MAX || pack.length > INLINE_BYTES_MAX) return;
  for (const [kind, bytes] of [["manifests", manifest], ["packs", pack]] as const) {
    const key = fleet + "/" + kind + "/" + payloadHash(bytes);
    inlineHeld.delete(key);
    inlineHeld.set(key, { bytes, at: now });
  }
  while (inlineHeld.size > INLINE_KEEP) inlineHeld.delete(inlineHeld.keys().next().value as string);
}

/** Forget what the socket brought (a test, or a member that is done with a fleet). */
export function forgetInline(): void {
  inlineHeld.clear();
}

function inlineFor(fleet: string, kind: "packs" | "manifests", id: string, now: number = Date.now()): Buffer | undefined {
  const key = fleet + "/" + kind + "/" + id;
  const held = inlineHeld.get(key);
  if (held === undefined) return undefined;
  if (now - held.at > INLINE_TTL_MS) {
    inlineHeld.delete(key);
    return undefined;
  }
  return Buffer.from(held.bytes);
}

/**
 * Store a sealed pack as pieces of at most `chunkBytes`, at most `inFlight` at a time. Each piece is stored under
 * its own hash, and the hash the gateway answers with has to be the one computed here. Nothing is cleaned up on a
 * failure: what was stored is content-addressed, so sending it again costs nothing, and the gateway sweeps what
 * no snapshot names.
 */
export async function putChunks(
  creds: FleetCredentials,
  fleet: string,
  pack: Buffer,
  chunkBytes: number = CHUNK_BYTES,
  inFlight = 4,
): Promise<{ chunks: Chunk[]; firstKey: string }> {
  const size = Math.max(1, Math.min(chunkBytes, CHUNK_BYTES_MAX));
  const pieces: Buffer[] = [];
  for (let at = 0; at < pack.length; at += size) pieces.push(pack.subarray(at, Math.min(pack.length, at + size)));
  if (pieces.length === 0 || pieces.length > CHUNKS_MAX) throw new FleetTransportError("a pack of " + pack.length + " bytes is " + pieces.length + " pieces of " + size + ": more than the " + CHUNKS_MAX + " pieces one pack may be (the gateway's piece size is " + size + " bytes)");
  const keys: string[] = new Array(pieces.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= pieces.length) return;
      const piece = pieces[i]!;
      const stored = await putPayload(creds, fleet, "packs", piece);
      if (stored.hash !== payloadHash(piece)) {
        throw new FleetTransportError("the gateway stored piece " + (i + 1) + " under another hash than the one it was sent with (" + stored.hash + ")");
      }
      keys[i] = stored.key;
    }
  };
  await Promise.all(Array.from({ length: Math.min(inFlight, pieces.length) }, worker));
  return { chunks: pieces.map((p) => ({ hash: payloadHash(p), bytes: p.length })), firstKey: keys[0]! };
}

/** Whether a manifest's list of pieces is one a member will fetch: it is the gateway's word until the whole pack is checked against the seal. */
export function chunkListProblem(chunks: unknown): string | undefined {
  if (!Array.isArray(chunks) || chunks.length === 0 || chunks.length > CHUNKS_MAX) return "its list of pieces is empty or too long";
  let total = 0;
  for (const c of chunks as Array<Partial<Chunk>>) {
    if (typeof c?.hash !== "string" || !/^[0-9a-f]{64}$/.test(c.hash)) return "a piece of it is not named by a hash";
    if (typeof c.bytes !== "number" || !Number.isSafeInteger(c.bytes) || c.bytes <= 0 || c.bytes > CHUNK_BYTES_MAX) return "a piece of it has a size no piece has";
    total += c.bytes;
  }
  if (total > CHUNKED_BYTES_MAX) return "its pieces add up to more than a pack may be";
  return undefined;
}

/**
 * Fetch the pieces of a pack, at most `inFlight` at a time, and join them. Each piece is checked against the hash and
 * size the manifest lists it with, as it arrives; whether they make the pack the publisher sealed is checked by the caller
 * against the hash the seal binds. The result is built in one buffer (about the size of the pack, once).
 */
export async function getChunks(creds: FleetCredentials, fleet: string, chunks: Chunk[], inFlight = 4): Promise<Buffer> {
  const problem = chunkListProblem(chunks);
  if (problem) throw new FleetTransportError(problem);
  const offsets: number[] = [];
  let total = 0;
  for (const c of chunks) {
    offsets.push(total);
    total += c.bytes;
  }
  const out = Buffer.allocUnsafe(total);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= chunks.length) return;
      const c = chunks[i]!;
      const piece = await getPayload(creds, fleet, "packs", c.hash);
      if (piece.length !== c.bytes || payloadHash(piece) !== c.hash) {
        throw new FleetTransportError("piece " + (i + 1) + " of " + chunks.length + " is not the one its manifest names (its hash or size differs)");
      }
      piece.copy(out, offsets[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(inFlight, chunks.length) }, worker));
  return out;
}

/** Fetch a stored payload. */
export async function getPayload(creds: FleetCredentials, fleet: string, kind: "packs" | "manifests", id: string): Promise<Buffer> {
  const brought = inlineFor(fleet, kind, id);
  if (brought !== undefined) return brought;
  const res = await request(creds, "GET", "/fleets/" + encodeURIComponent(fleet) + "/" + kind + "/" + encodeURIComponent(id));
  if (res.status === 404) throw new PayloadGoneError();
  if (!res.ok) throw new FleetTransportError("could not read the payload: " + res.status);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Tell the fleet how far this member has got.
 *
 * The fleet uses this to fence a member that took over: it may not publish
 * until it has applied the state it is about to replace. It is safe to repeat
 * (the fleet keeps the highest), so it is retried, and it throws when it cannot
 * get through.
 */
export async function reportApplied(creds: FleetCredentials, fleet: string, seq: number, fetched?: number): Promise<true> {
  const body = JSON.stringify({ seq, ...(fetched !== undefined ? { fetched } : {}) });
  let last = "";
  for (let attempt = 0; attempt <= reportBackoff.delays.length; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, reportBackoff.delays[attempt - 1]));
    try {
      const res = await request(creds, "POST", "/fleets/" + encodeURIComponent(fleet) + "/applied", body);
      if (res.ok) return true;
      last = "status " + res.status;
      // A refusal that asking again will not change (not a member, no such fleet).
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
  }
  // The report is what lets the fleet give this member the lease. Saying nothing
  // about a failure would leave a member that is in fact current waiting for ever.
  throw new FleetTransportError("could not tell the fleet how far this member has got: " + last);
}

/** How long to wait before asking again when a report did not get through. */
export const reportBackoff = { delays: [150, 450] as number[] };

/** One snapshot the gateway keeps, as its index lists it. */
export interface IndexEntry {
  seq: number;
  manifestKey: string;
  full: boolean;
  packBytes?: number;
  deltaBytes?: number;
}

/**
 * The snapshots the gateway keeps from `after` on, in one request.
 *
 * Returns null when the gateway does not have an index (an older one): the
 * caller walks the manifests instead.
 */
export async function fetchIndex(creds: FleetCredentials, fleet: string, after: number): Promise<IndexEntry[] | null> {
  const res = await request(creds, "GET", "/fleets/" + encodeURIComponent(fleet) + "/index?after=" + Math.max(0, Math.floor(after)));
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { entries?: unknown } | null;
  if (!body || !Array.isArray(body.entries)) return null;
  const entries: IndexEntry[] = [];
  for (const raw of body.entries) {
    const e = raw as Partial<IndexEntry>;
    if (typeof e.seq !== "number" || typeof e.manifestKey !== "string" || typeof e.full !== "boolean") return null;
    entries.push({
      seq: e.seq,
      manifestKey: e.manifestKey,
      full: e.full,
      ...(typeof e.packBytes === "number" ? { packBytes: e.packBytes } : {}),
      ...(typeof e.deltaBytes === "number" ? { deltaBytes: e.deltaBytes } : {}),
    });
  }
  return entries;
}

/**
 * Publish a snapshot: the sealed pack and its manifest, in one request.
 *
 * The body is framed: four bytes of manifest length, then the manifest, then
 * the pack. The gateway stores both and moves the head, so a publish costs
 * one round trip rather than six - and the round trip is most of the time
 * a change takes to travel.
 */
export async function putSnapshot(
  creds: FleetCredentials,
  fleet: string,
  manifest: FleetManifest,
  pack: Buffer,
): Promise<{ ok: boolean; seq?: number; manifestKey?: string; error?: string; status?: number; missing?: string[]; chunks?: false }> {
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(manifestBytes.length, 0);
  const body = Buffer.concat([header, manifestBytes, pack]);
  const res = await request(
    creds,
    "POST",
    "/fleets/" + encodeURIComponent(fleet) + "/snapshot",
    body,
    "application/octet-stream",
  );
  const result = (await res.json().catch(() => ({}))) as { ok?: boolean; seq?: number; manifestKey?: string; error?: string; missing?: unknown; chunks?: unknown };
  if (!res.ok) {
    // A gateway that takes pieces says which of them it does not have (a refused publish took them with it), and when a member cannot read them.
    const missing = Array.isArray(result.missing) ? result.missing.filter((h): h is string => typeof h === "string" && /^[0-9a-f]{64}$/.test(h)) : [];
    return { ok: false, error: result.error ?? ("status " + res.status), status: res.status, ...(missing.length > 0 ? { missing } : {}), ...(result.chunks === false ? { chunks: false as const } : {}) };
  }
  return { ok: true, seq: result.seq, manifestKey: result.manifestKey };
}

/** Ask the fleet which role this device has. */
export async function fetchRole(
  creds: FleetCredentials,
  fleet: string,
): Promise<{ member: boolean; primary: boolean; epoch: number; incarnation?: string; sealGate?: true; snapshotLimit?: number; chunkLimit?: number; chunkedLimit?: number; keyProofKey?: string; serverTimeMs?: number; fleetCaps?: string[] }> {
  const res = await request(creds, "GET", "/fleets/" + encodeURIComponent(fleet) + "/role");
  if (!res.ok) return { member: false, primary: false, epoch: 0 };
  const body = (await res.json()) as { member?: boolean; primary?: boolean; epoch?: number; incarnation?: unknown; sealGate?: unknown; snapshotLimit?: unknown; chunkLimit?: unknown; chunkedLimit?: unknown; keyProofKey?: unknown; fleetCaps?: unknown };
  // The gateway's clock, from the answer's Date header: a proof is only good for a few minutes of its own, so a
  // machine whose clock is off must not make every proof fail.
  const dated = Date.parse(res.headers.get("date") ?? "");
  return {
    member: body.member === true,
    primary: body.primary === true,
    epoch: body.epoch ?? 0,
    ...(Number.isFinite(dated) ? { serverTimeMs: dated } : {}),
    // Which fleet of this name it is: absent from a gateway that predates it.
    ...(typeof body.incarnation === "string" && body.incarnation ? { incarnation: body.incarnation } : {}),
    // Whether the gateway refuses to move the head from a sealed snapshot to one that is not.
    ...(body.sealGate === true ? { sealGate: true as const } : {}),
    // The most one upload may be: said by a gateway that has a limit.
    ...(typeof body.snapshotLimit === "number" && body.snapshotLimit > 0 ? { snapshotLimit: body.snapshotLimit } : {}),
    // What one piece of a chunked pack may be, and the most a whole chunked pack may be: said by a gateway that takes them.
    ...(typeof body.chunkLimit === "number" && body.chunkLimit > 0 ? { chunkLimit: body.chunkLimit } : {}),
    ...(typeof body.chunkedLimit === "number" && body.chunkedLimit > 0 ? { chunkedLimit: body.chunkedLimit } : {}),
    // The key a member shows that it holds its old key with, when it changes its own: said by a gateway that asks for the proof.
    ...(typeof body.keyProofKey === "string" && body.keyProofKey ? { keyProofKey: body.keyProofKey } : {}),
    // What every member of the fleet can do (what all of them list): said by a gateway that has them.
    ...(Array.isArray(body.fleetCaps) ? { fleetCaps: body.fleetCaps.filter((c): c is string => typeof c === "string" && CAP_NAME.test(c)) } : {}),
  };
}

/**
 * Give up the lease this device holds.
 *
 * A member that is not running should not hold the fleet: the lease would
 * keep a primary that nobody can reach, and no other member could take
 * over.
 */
export async function releaseLease(creds: FleetCredentials, fleet: string): Promise<boolean> {
  const res = await request(creds, "POST", "/fleets/" + encodeURIComponent(fleet) + "/lease/release", "{}");
  return res.ok;
}

/**
 * The members' public keys, which only the primary may read.
 *
 * The roster keeps the other devices' ids cut short for ordinary members,
 * so the keys come from their own route.
 */
export async function fetchMemberKeys(
  creds: FleetCredentials,
  fleet: string,
): Promise<Array<{ deviceId: string; pubkey?: string; applied?: number; caps?: string[] }>> {
  const res = await request(creds, "GET", "/fleets/" + encodeURIComponent(fleet) + "/keys");
  if (!res.ok) throw new FleetTransportError("could not read the members' keys: " + res.status);
  const body = (await res.json()) as { members?: Array<{ deviceId: string; pubkey?: string; applied?: number; caps?: unknown }> };
  // What each member says it can do comes in the same answer as the keys it is sealed for: a format is used only when
  // every member that is sealed for can read it, and a member admitted between two answers cannot slip between them.
  return (body.members ?? []).map((m) => {
    const { caps, ...rest } = m;
    return Array.isArray(caps) ? { ...rest, caps: caps.filter((c): c is string => typeof c === "string") } : rest;
  });
}

/**
 * The public keys the roster lists, as any member may read them.
 *
 * (The device ids are cut short for ordinary members; the keys are not.) A snapshot
 * is accepted only from a key on this list, or one that was on it when it was last
 * looked at (see fleet-trust.ts).
 */
export async function fetchRosterKeys(creds: FleetCredentials, fleet: string): Promise<string[]> {
  return (await fetchRoster(creds, fleet)).keys;
}

/** The keys of the members that have left, each with the sequence the head was at when it did. */
export interface LeftKey {
  pubkey: string;
  until: number;
}

/** The roster's keys, and those of members that have left (a gateway that predates the history says none). */
export async function fetchRoster(creds: FleetCredentials, fleet: string): Promise<{ keys: string[]; left: LeftKey[] }> {
  const res = await request(creds, "GET", "/fleets/" + encodeURIComponent(fleet) + "/members");
  if (!res.ok) throw new FleetTransportError("could not read the roster: " + res.status);
  const body = (await res.json()) as { members?: Array<{ pubkey?: unknown }>; left?: unknown };
  const keys: string[] = [];
  for (const m of body.members ?? []) if (typeof m.pubkey === "string" && m.pubkey) keys.push(m.pubkey);
  const left: LeftKey[] = [];
  if (Array.isArray(body.left)) {
    for (const k of body.left as Array<{ pubkey?: unknown; until?: unknown }>) {
      if (typeof k?.pubkey === "string" && k.pubkey && typeof k.until === "number" && k.until >= 0) left.push({ pubkey: k.pubkey, until: k.until });
    }
  }
  return { keys, left };
}
