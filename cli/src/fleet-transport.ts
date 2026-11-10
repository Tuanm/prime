// The wire between a fleet member and the gateway.
//
// A member never talks to R2 directly: the account cannot give it S3
// credentials, and the gateway is the component that holds them. So the
// member sends the gateway what it wants stored and asks for what it wants
// back, and the gateway stores bytes it cannot read.

import { createHash } from "node:crypto";

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
  wrapped: Array<{ memberId: string; wrapped: string }>;
  /** Which epoch published this, for the fencing check. */
  epoch: number;
  createdAt: number;
}

export class FleetTransportError extends Error {}

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
export async function fetchManifest(creds: FleetCredentials, fleet: string, id: string): Promise<FleetManifest> {
  const bytes = await getPayload(creds, fleet, "manifests", id);
  return JSON.parse(bytes.toString("utf8")) as FleetManifest;
}

/** Fetch a stored payload. */
export async function getPayload(creds: FleetCredentials, fleet: string, kind: "packs" | "manifests", id: string): Promise<Buffer> {
  const res = await request(creds, "GET", "/fleets/" + encodeURIComponent(fleet) + "/" + kind + "/" + encodeURIComponent(id));
  if (res.status === 404) throw new FleetTransportError("no such payload");
  if (!res.ok) throw new FleetTransportError("could not read the payload: " + res.status);
  return Buffer.from(await res.arrayBuffer());
}

/** Publish a manifest as the fleet's new head. */
export async function advanceHead(
  creds: FleetCredentials,
  fleet: string,
  expectedSeq: number,
  manifestKey: string,
  manifestHash: string,
  /** The pack this manifest points at, so the gateway can let the old ones go. */
  packKey?: string,
): Promise<{ ok: boolean; seq?: number; error?: string }> {
  const res = await request(
    creds,
    "POST",
    "/fleets/" + encodeURIComponent(fleet) + "/head/advance",
    JSON.stringify({ expectedSeq, manifestKey, manifestHash, ...(packKey ? { packKey } : {}) }),
  );
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; seq?: number; error?: string };
  if (!res.ok) {
    return { ok: false, error: body.error ?? ("status " + res.status) };
  }
  return { ok: true, seq: body.seq };
}

/**
 * Tell the fleet how far this member has got.
 *
 * The fleet uses this to fence a member that took over: it may not publish
 * until it has applied the state it is about to replace.
 */
export async function reportApplied(creds: FleetCredentials, fleet: string, seq: number): Promise<boolean> {
  const res = await request(creds, "POST", "/fleets/" + encodeURIComponent(fleet) + "/applied", JSON.stringify({ seq }));
  return res.ok;
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
): Promise<{ ok: boolean; seq?: number; manifestKey?: string; error?: string }> {
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
  if (!res.ok) return { ok: false, error: result.error ?? ("status " + res.status) };
  return { ok: true, seq: result.seq, manifestKey: result.manifestKey };
}

/** Ask the fleet which role this device has. */
export async function fetchRole(
  creds: FleetCredentials,
  fleet: string,
): Promise<{ member: boolean; primary: boolean; epoch: number }> {
  const res = await request(creds, "GET", "/fleets/" + encodeURIComponent(fleet) + "/role");
  if (!res.ok) return { member: false, primary: false, epoch: 0 };
  const body = (await res.json()) as { member?: boolean; primary?: boolean; epoch?: number };
  return { member: body.member === true, primary: body.primary === true, epoch: body.epoch ?? 0 };
}

/** Renew the lease this device holds. */
export async function renewLease(creds: FleetCredentials, fleet: string, ttlMs: number): Promise<boolean> {
  const res = await request(creds, "POST", "/fleets/" + encodeURIComponent(fleet) + "/lease/renew", JSON.stringify({ ttlMs }));
  return res.ok;
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
