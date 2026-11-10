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
): Promise<{ ok: boolean; seq?: number; error?: string }> {
  const res = await request(creds, "POST", "/fleets/" + encodeURIComponent(fleet) + "/head/advance", JSON.stringify({ expectedSeq, manifestKey, manifestHash }));
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
 * The members' public keys, which only the primary may read.
 *
 * The roster keeps the other devices' ids cut short for ordinary members,
 * so the keys come from their own route.
 */
export async function fetchMemberKeys(
  creds: FleetCredentials,
  fleet: string,
): Promise<Array<{ deviceId: string; pubkey?: string }>> {
  const res = await request(creds, "GET", "/fleets/" + encodeURIComponent(fleet) + "/keys");
  if (!res.ok) throw new FleetTransportError("could not read the members' keys: " + res.status);
  const body = (await res.json()) as { members?: Array<{ deviceId: string; pubkey?: string }> };
  return body.members ?? [];
}
