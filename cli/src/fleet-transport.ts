// The wire between a fleet member and the gateway.
//
// A member never talks to R2 directly: the account cannot give it S3
// credentials, and the gateway is the component that holds them. So the
// member sends the gateway what it wants stored and asks for what it wants
// back, and the gateway stores bytes it cannot read.

import { createHash } from "node:crypto";

/**
 * What this build can do beyond the first form of the wire, said to the fleet each time a place is taken (`caps` in
 * the body of a bootstrap). A format that only some members read is used by a publisher only when every member of the
 * fleet lists its name (`role.fleetCaps`; see `fleetHas`). Short lower-case names, added here as the code that
 * reads and writes the form lands, and nowhere else: this build says only what it does.
 */
export const MEMBER_CAPS: readonly string[] = [];

/** What a capability's name looks like: the pattern the gateway keeps (`^[a-z0-9][a-z0-9-]{0,23}$`), so that both sides read the same names. */
export const CAP_NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;

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
   * The change since the snapshot before, for a snapshot whose pack is a whole
   * tree. A member that holds that snapshot takes this instead of the tree; it
   * is sealed with the same key as the pack. Older members ignore it.
   */
  delta?: { packKey: string; packHash: string; bytes: number };
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

/** Fetch a stored payload. */
export async function getPayload(creds: FleetCredentials, fleet: string, kind: "packs" | "manifests", id: string): Promise<Buffer> {
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
): Promise<{ ok: boolean; seq?: number; manifestKey?: string; error?: string; status?: number }> {
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
  const result = (await res.json().catch(() => ({}))) as { ok?: boolean; seq?: number; manifestKey?: string; error?: string };
  if (!res.ok) return { ok: false, error: result.error ?? ("status " + res.status), status: res.status };
  return { ok: true, seq: result.seq, manifestKey: result.manifestKey };
}

/** Ask the fleet which role this device has. */
export async function fetchRole(
  creds: FleetCredentials,
  fleet: string,
): Promise<{ member: boolean; primary: boolean; epoch: number; incarnation?: string; sealGate?: true; snapshotLimit?: number; keyProofKey?: string; serverTimeMs?: number; fleetCaps?: string[] }> {
  const res = await request(creds, "GET", "/fleets/" + encodeURIComponent(fleet) + "/role");
  if (!res.ok) return { member: false, primary: false, epoch: 0 };
  const body = (await res.json()) as { member?: boolean; primary?: boolean; epoch?: number; incarnation?: unknown; sealGate?: unknown; snapshotLimit?: unknown; keyProofKey?: unknown; fleetCaps?: unknown };
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
): Promise<Array<{ deviceId: string; pubkey?: string; applied?: number }>> {
  const res = await request(creds, "GET", "/fleets/" + encodeURIComponent(fleet) + "/keys");
  if (!res.ok) throw new FleetTransportError("could not read the members' keys: " + res.status);
  const body = (await res.json()) as { members?: Array<{ deviceId: string; pubkey?: string; applied?: number }> };
  return body.members ?? [];
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
