// HTTP surface for fleets. Two kinds of caller, two kinds of proof:
//
//   operator (fleet operator   create a fleet, mint an invite, approve, remove. The operator is the
//             token, or the    FLEET_OPERATOR_TOKEN, which is not the gateway token (every client holds
//             admin page)      that one), or the admin page, which is behind Access.
//   device   (device token)   join with an invite, read my status, read the
//                             roster if I am in it.
//
// The Worker is the only component that can see a credential, so it is the only
// one that decides who the caller is. It then tells the Durable Object, which
// trusts the internal headers because a DO is not reachable from the internet:
// it exists only behind this Worker's binding. Authentication at the edge,
// authorization in the object.

import { timingSafeEq, extractToken, type GatewayConfig } from "./config";
import { actorOf, emailAllowed, verifyOperatorToken, forwardableHeaders } from "./access";
import { INLINE_PACK_BYTES, MAX_FLEETS_PER_DEVICE, MAX_SNAPSHOT_BYTES, checkChunkList, REAP_SILENCE_MS, validFleetId, type FleetAuth } from "./fleets";
import { countFleetR2 } from "./usage";
import { readBounded, readBoundedText } from "./body";
import { fleetBodyMax } from "./fleet-limits";
import type { Env } from "./config";

// Captured as a general action segment and then checked against an allowlist,
// so a new route cannot be reached by a path the object does not implement and
// an unknown path is a clean 404 rather than a miss.
// A payload id is a hex digest, so it can never traverse a path.
const FLEET_PATH = /^\/(?:api\/)?fleets\/([a-z0-9][a-z0-9-]{0,31})(?:\/([a-z]+(?:-[a-z]+)?(?:\/[a-z0-9-]+)?))?$/;
// The first segment of an action. A second segment names the step, as in
// "head/advance" or "packs/<id>".
const ALLOWED_ACTIONS = new Set([
  "invite",
  "join",
  "approve",
  "remove",
  "revoke",
  "members",
  "pending",
  "me",
  "bootstrap",
  "lease",
  "head",
  "role",
  "applied",
  "snapshot",
  "primary",
  "reap",
  "delete",
  "packs",
  "manifests",
  "keys",
  "index",
  "events",
  "meta",
  "audit",
  "roster",
  "remove-fence",
  "epoch-key",
]);
const READ_ACTIONS = new Set(["members", "pending", "me", "role", "head", "keys", "index", "audit", "roster"]);

/**
 * The routes a paused fleet does not serve.
 *
 * The same set the fleet object refuses, plus the snapshot upload, which would
 * store a pack in R2 before the object got the chance to say no. They are
 * answered here, from the registry's copy, so a paused fleet's object is not
 * woken by a member that keeps asking.
 */
const PAUSED_ACTIONS = new Set(["join", "bootstrap", "head/advance", "snapshot"]);
const PAUSED_RETRY_MS = 60_000;
/** How seldom the registry is told that a member of a paused fleet is alive. */
const PAUSED_SEEN_MS = 60 * 60_000;

function pausedAnswer(): Response {
  return Response.json(
    { error: "the fleet is paused", paused: true, retryAfterMs: PAUSED_RETRY_MS },
    { status: 409, headers: { "retry-after": String(Math.ceil(PAUSED_RETRY_MS / 1000)) } },
  );
}


// ---- payloads ----------------------------------------------------------

const PAYLOAD_ACTIONS = new Set(["packs", "manifests"]);
const HASH_RE = /^[0-9a-f]{16,64}$/;

/** What a member may do with the fleet's payload area right now. */
interface FleetRole {
  member: boolean;
  primary: boolean;
  epoch: number;
}

interface PayloadDeps {
  request: Request;
  env: Env;
  url: URL;
  cfg: GatewayConfig;
  fleetId: string;
  action: string | undefined;
  authorizeDevice: FleetDeps["authorizeDevice"];
  unauthorized: () => Response;
}

/** The refusal of an upload bigger than the Worker can hold: what it was, what the limit is, what to do. */
function uploadTooBig(bytes: number, what: "snapshot" | "change pack"): Response {
  const mb = (n: number): number => Math.ceil(n / (1024 * 1024));
  return Response.json(
    {
      error:
        "this " + what + " is " + mb(bytes) + " MB, and the gateway takes at most " + MAX_SNAPSHOT_BYTES / (1024 * 1024) +
        " MB for one: the work tree is too big to publish (keep what is not the work's, such as build output, out of it with .gitignore)",
      limit: MAX_SNAPSHOT_BYTES,
    },
    { status: 413 },
  );
}

/**
 * Publish a snapshot: the sealed pack and its manifest, in one request.
 *
 * The body is framed so that both parts travel together: four bytes of
 * manifest length, then the manifest, then the pack. The Worker stores the
 * two objects and moves the head, so the member spends one round trip rather
 * than six. That is most of the time a change takes to travel.
 */
async function publishSnapshot(deps: FleetDeps, fleetId: string): Promise<Response> {
  const bucket = deps.env.BUCKET;
  if (!bucket) return Response.json({ error: "storage is not configured" }, { status: 503 });
  const deviceId = deps.request.headers.get("x-prime-device") ?? "";
  const deviceToken = deps.request.headers.get("x-device-token") ?? "";
  if (!deviceId || !deviceToken) return deps.unauthorized();
  const verdict = await deps.authorizeDevice(deviceId);
  if (!verdict.ok) return verdict.response;

  // Only the member that holds the lease may publish. The check is before
  // anything is written: a member that is not the primary must not be able
  // to fill the account's storage.
  const role = await fleetRole({ request: deps.request, env: deps.env, url: deps.url, cfg: deps.cfg, fleetId, action: "role", authorizeDevice: deps.authorizeDevice, unauthorized: deps.unauthorized }, deviceId);
  if (!role) return Response.json({ error: "not a member of this fleet" }, { status: 403 });
  if (!role.primary) return Response.json({ error: "only the primary may publish", code: "not-primary" }, { status: 409 });

  const tooBig = (bytes: number): Response => uploadTooBig(bytes, "snapshot");
  // Said before the body is read, when the sender says how long it is.
  const declared = Number(deps.request.headers.get("content-length") ?? 0);
  if (declared > MAX_SNAPSHOT_BYTES) return tooBig(declared);
  // Read up to the limit and no further: a body with no length said (chunked) is stopped at it too.
  const read = await readBounded(deps.request, MAX_SNAPSHOT_BYTES);
  if (read instanceof Response) return tooBig(MAX_SNAPSHOT_BYTES + 1);
  const body = Buffer.from(read);
  if (body.length < 4) return Response.json({ error: "malformed snapshot" }, { status: 400 });
  const manifestLength = body.readUInt32BE(0);
  if (manifestLength === 0 || manifestLength + 4 > body.length) {
    return Response.json({ error: "malformed snapshot" }, { status: 400 });
  }
  const manifestBytes = body.subarray(4, 4 + manifestLength);
  const pack = body.subarray(4 + manifestLength);

  let manifest: {
    seq?: number;
    packKey?: string;
    packHash?: string;
    full?: unknown;
    packBytes?: unknown;
    seal?: unknown;
    delta?: { packKey?: unknown; bytes?: unknown; chunks?: unknown };
    chunks?: unknown;
  };
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8")) as typeof manifest;
  } catch {
    return Response.json({ error: "malformed manifest" }, { status: 400 });
  }
  const seq = typeof manifest.seq === "number" ? manifest.seq : 0;
  if (seq < 1) return Response.json({ error: "manifest has no sequence" }, { status: 400 });

  const prefix = "fleets/" + fleetId + "/packs/";
  // A snapshot is in the frame, or in pieces that were uploaded before it (and then the frame carries the manifest alone).
  const chunked = manifest.chunks !== undefined;
  if (chunked && pack.length > 0) return Response.json({ error: "a snapshot in pieces is published as its manifest alone: the pack is not in the frame as well" }, { status: 400 });
  if (!chunked && pack.length === 0) return Response.json({ error: "empty pack" }, { status: 400 });
  // Every piece that is named: the objects it must find in the bucket, and what the object keeps with the snapshot.
  const pieces: Array<{ key: string; bytes: number }> = [];
  const extraKeys: string[] = [];
  let packHash: string;
  let packKey: string;
  if (chunked) {
    const listed = checkChunkList(manifest.chunks, manifest.packBytes, "chunks");
    if (!listed.ok) return Response.json({ error: listed.error }, { status: 400 });
    // The seal binds the hash of the whole pack, which the gateway cannot work out without reading all of it: it is the member's
    // to say (and every member checks it when it joins the pieces).
    if (typeof manifest.packHash !== "string" || !/^[0-9a-f]{64}$/.test(manifest.packHash)) {
      return Response.json({ error: "a snapshot in pieces names the hash of the whole pack (packHash)" }, { status: 400 });
    }
    packHash = manifest.packHash;
    packKey = prefix + listed.hashes[0];
    if (manifest.packKey !== undefined && manifest.packKey !== packKey) {
      return Response.json({ error: "packKey of a snapshot in pieces is the key of its first piece" }, { status: 400 });
    }
    listed.hashes.forEach((h, i) => {
      pieces.push({ key: prefix + h, bytes: listed.bytes[i]! });
      if (i > 0) extraKeys.push(prefix + h);
    });
  } else {
    // The two objects are addressed by their contents, so writing the same bytes
    // twice is free.
    packHash = await sha256Hex(pack);
    packKey = prefix + packHash;
  }

  // The manifest says where its pack is. The member cannot know that - only
  // the gateway knows where the bytes ended up - so it is filled in here (for a snapshot in pieces, where the first piece is,
  // and the hash of the whole pack stays what the member said).
  manifest.packKey = packKey;
  manifest.packHash = packHash;
  // A checkpoint's whole tree may carry the change since the snapshot before as
  // a pack of its own, uploaded just before. The object is told, so it is kept
  // for as long as the snapshot is and let go with it. That pack may be in pieces too.
  let deltaChunked = false;
  if (manifest.delta?.chunks !== undefined) {
    const listed = checkChunkList(manifest.delta.chunks, manifest.delta.bytes, "delta.chunks");
    if (!listed.ok) return Response.json({ error: listed.error }, { status: 400 });
    const first = prefix + listed.hashes[0];
    if (manifest.delta.packKey !== undefined && manifest.delta.packKey !== first) {
      return Response.json({ error: "delta.packKey of a change pack in pieces is the key of its first piece" }, { status: 400 });
    }
    manifest.delta.packKey = first;
    deltaChunked = true;
    listed.hashes.forEach((h, i) => {
      pieces.push({ key: prefix + h, bytes: listed.bytes[i]! });
      extraKeys.push(prefix + h);
    });
  } else if (typeof manifest.delta?.packKey === "string") {
    extraKeys.push(manifest.delta.packKey);
  }
  // The pieces are in the bucket, each the size it is said to be: a snapshot that names one that is not would be one nobody can read.
  if (pieces.length > 0) {
    const absent = await missingPieces(bucket, pieces);
    if (absent.length > 0) {
      return Response.json(
        { error: "the gateway does not hold " + absent.length + " of the pieces the snapshot names, at the size it says: upload them again, then publish", missing: absent.map((p) => p.key.slice(prefix.length)) },
        { status: 409 },
      );
    }
  }
  const finalManifest = Buffer.from(JSON.stringify(manifest), "utf8");
  const manifestHash = await sha256Hex(finalManifest);
  const manifestKey = "fleets/" + fleetId + "/manifests/" + manifestHash;

  if (!chunked) {
    countFleetR2("write");
    await bucket.put(packKey, pack, { httpMetadata: { contentType: "application/octet-stream" } });
  }
  countFleetR2("write");
  await bucket.put(manifestKey, finalManifest, { httpMetadata: { contentType: "application/json" } });

  // Move the head. The object decides: it checks the sequence, the lease and
  // whether this member has caught up.
  const namespace = deps.env.FLEET;
  if (!namespace) return Response.json({ error: "fleets are not enabled on this gateway" }, { status: 503 });
  const stub = namespace.get(namespace.idFromName(fleetId));
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("x-prime-caller", "device");
  headers.set("x-prime-device", deviceId);
  headers.set("x-prime-fleet", fleetId);
  const moved = await stub.fetch("https://fleet/head/advance", {
    method: "POST",
    headers,
    body: JSON.stringify({
      expectedSeq: seq - 1,
      manifestKey,
      manifestHash,
      packKey,
      extraKeys,
      // A small edit goes to the members that listen in the event that announces it: the object checks it is what the key
      // says, and does not store it.
      ...(!chunked && !deltaChunked && manifest.full !== true && pack.length <= INLINE_PACK_BYTES
        ? { inline: { manifest: finalManifest.toString("utf8"), pack: pack.toString("base64") } }
        : {}),
      // What a member needs to choose its route without opening every manifest.
      meta: {
        full: manifest.full === true,
        // Whether the publisher sealed the manifest: the fleet does not move from sealed to unsealed.
        ...(typeof manifest.seal === "string" && manifest.seal !== "" ? { sealed: true } : {}),
        // In pieces: only members that read them may be in the fleet (the object checks).
        ...(chunked || deltaChunked ? { chunked: true } : {}),
        ...(typeof manifest.packBytes === "number" ? { packBytes: manifest.packBytes } : {}),
        ...(typeof manifest.delta?.bytes === "number" ? { deltaBytes: manifest.delta.bytes } : {}),
      },
    }),
  });
  const result = (await moved.json().catch(() => ({}))) as { ok?: boolean; head?: unknown; error?: string; chunks?: boolean; members?: number };
  if (!moved.ok) {
    // The head did not move, so what was stored for it belongs to no snapshot. (A refusal that
    // never reached the object, or a publisher that dies after uploading its change pack and
    // before this request, still leaves objects behind.)
    // (A member that is told to catch up stores the change pack again before it sends the manifest
    // that names it: what it sent for a refused publish is not kept for one that may not come.)
    await dropUnreferenced(bucket, stub, deviceId, fleetId, [packKey, manifestKey, ...extraKeys]);
    return Response.json({ ok: false, error: result.error ?? "the head did not move", ...(result.chunks === false ? { chunks: false, members: result.members } : {}) }, { status: moved.status });
  }
  return Response.json({ ok: true, head: result.head, seq, manifestKey });
}

/** The pieces that are not in the bucket at the size they were said to be (looked up a few at a time). */
async function missingPieces(
  bucket: NonNullable<FleetDeps["env"]["BUCKET"]>,
  pieces: Array<{ key: string; bytes: number }>,
): Promise<Array<{ key: string; bytes: number }>> {
  const absent: Array<{ key: string; bytes: number }> = [];
  for (let at = 0; at < pieces.length; at += 16) {
    const group = pieces.slice(at, at + 16);
    const found = await Promise.all(
      group.map(async (p) => {
        countFleetR2("read");
        const o = await bucket.head(p.key);
        return o !== null && o.size === p.bytes;
      }),
    );
    group.forEach((p, i) => {
      if (!found[i]) absent.push(p);
    });
  }
  return absent;
}

// Delete what a refused publish stored, unless a snapshot the fleet keeps names it. Never fails the answer.
async function dropUnreferenced(
  bucket: NonNullable<FleetDeps["env"]["BUCKET"]>,
  stub: { fetch(input: string, init?: RequestInit): Promise<Response> },
  deviceId: string,
  fleetId: string,
  keys: string[],
): Promise<void> {
  try {
    const headers = new Headers({ "content-type": "application/json" });
    headers.set("x-prime-caller", "device");
    headers.set("x-prime-device", deviceId);
    headers.set("x-prime-fleet", fleetId);
    const asked = await stub.fetch("https://fleet/unreferenced", { method: "POST", headers, body: JSON.stringify({ keys: keys.filter(Boolean) }) });
    if (!asked.ok) return;
    const answer = (await asked.json()) as { keys?: unknown };
    for (const key of Array.isArray(answer.keys) ? answer.keys : []) {
      if (typeof key !== "string") continue;
      countFleetR2("write");
      await bucket.delete(key);
    }
  } catch {
    // Leaving an object behind is the cost of not knowing; the publish was refused either way.
  }
}

/**
 * Tell the fleet's object that this pack is being uploaded, and learn whether the caller still holds the lease (it may have moved
 * while the body was read). "unavailable" when the object cannot say.
 */
async function noteUpload(deps: PayloadDeps, deviceId: string, hash: string): Promise<FleetRole | "unavailable"> {
  const namespace = deps.env.FLEET;
  if (!namespace) return "unavailable";
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("x-prime-caller", "device");
  headers.set("x-prime-device", deviceId);
  headers.set("x-prime-fleet", deps.fleetId);
  try {
    const res = await namespace.get(namespace.idFromName(deps.fleetId)).fetch("https://fleet/uploaded", { method: "POST", headers, body: JSON.stringify({ hash }) });
    if (!res.ok) return "unavailable";
    const body = (await res.json()) as { member?: boolean; primary?: boolean; epoch?: number };
    return { member: body.member === true, primary: body.primary === true, epoch: body.epoch ?? 0 };
  } catch {
    return "unavailable";
  }
}

async function fleetRole(deps: PayloadDeps, deviceId: string): Promise<FleetRole | null> {
  const namespace = deps.env.FLEET;
  if (!namespace) return null;
  const stub = namespace.get(namespace.idFromName(deps.fleetId));
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("x-prime-caller", "device");
  headers.set("x-prime-device", deviceId);
  headers.set("x-prime-fleet", deps.fleetId);
  const res = await stub.fetch("https://fleet/role", { method: "GET", headers });
  if (!res.ok) return null;
  const body = (await res.json()) as { member?: boolean; primary?: boolean; epoch?: number };
  if (!body.member) return null;
  return { member: true, primary: body.primary === true, epoch: body.epoch ?? 0 };
}

// The device proves who it is; the object decides what that identity may do.
async function provenDevice(deps: PayloadDeps): Promise<string | null> {
  const claimed = deps.request.headers.get("x-prime-device") ?? deps.url.searchParams.get("device") ?? "";
  if (!claimed) return null;
  const verdict = await deps.authorizeDevice(claimed);
  if (!verdict.ok) return null;
  return claimed;
}

async function handleFleetPayload(deps: PayloadDeps): Promise<Response | null> {
  const action = deps.action;
  if (!action) return null;
  const parts = action.split("/");
  if (!PAYLOAD_ACTIONS.has(parts[0]!)) return null;

  const bucket = deps.env.BUCKET;
  if (!bucket) return Response.json({ error: "storage is not configured" }, { status: 503 });

  const deviceId = await provenDevice(deps);
  if (!deviceId) return deps.unauthorized();
  // Asked before the body is read: a member that is not the primary is refused without its (up to 32 MiB) body being read for nothing.
  const role = await fleetRole(deps, deviceId);
  if (!role) return Response.json({ error: "not a member of this fleet" }, { status: 403 });

  const prefix = "fleets/" + deps.fleetId + "/" + parts[0] + "/";

  // Upload a payload. Only the primary may publish.
  if (deps.request.method === "POST") {
    if (!role.primary) {
      return Response.json({ error: "only the primary may publish", code: "not-primary" }, { status: 409 });
    }
    // Said before the body is read, when the sender says how long it is, and again after.
    const declared = Number(deps.request.headers.get("content-length") ?? 0);
    if (declared > MAX_SNAPSHOT_BYTES) return uploadTooBig(declared, "change pack");
    // A pack whose sender says its hash (and how long it is) is streamed to the bucket as it arrives and hashed on the way: the Worker
    // shares its memory with every other request, and a piece held whole is 8 MiB of it, four times over, for each member uploading.
    const claimed = (deps.request.headers.get("x-prime-sha256") ?? "").toLowerCase();
    if (parts[0] === "packs" && /^[0-9a-f]{64}$/.test(claimed) && Number.isInteger(declared) && declared > 0 && canStream()) {
      return streamedPack(deps, deviceId, role, bucket, prefix, claimed, declared);
    }
    const body = await readBounded(deps.request, MAX_SNAPSHOT_BYTES);
    if (body instanceof Response) return uploadTooBig(MAX_SNAPSHOT_BYTES + 1, "change pack");
    if (body.byteLength === 0) return Response.json({ error: "empty payload" }, { status: 400 });
    const digest = await sha256Hex(body);
    const key = prefix + digest;
    // A pack that no snapshot names yet is one of the pieces of a snapshot that is being uploaded, or an orphan: the object notes it
    // before it is stored, so that the sweep does not take a piece of a slow upload from under the publisher. The lease may have
    // moved while the body was read: then it is not stored.
    if (parts[0] === "packs") {
      const noted = await noteUpload(deps, deviceId, digest);
      // The object could not say (not the same as not being the primary): try again, nothing was stored.
      if (noted === "unavailable") return Response.json({ error: "the fleet could not be reached to note the upload: try again", code: "fleet-unreachable" }, { status: 503, headers: { "retry-after": "5" } });
      if (!noted.primary) return Response.json({ error: "only the primary may publish", code: "not-primary" }, { status: 409 });
    }
    // Content addressed: writing the same bytes twice is free and idempotent.
    countFleetR2("write");
    await bucket.put(key, body, { httpMetadata: { contentType: "application/octet-stream" } });
    return Response.json({ ok: true, key, hash: digest, size: body.byteLength, epoch: role.epoch });
  }

  // Download a payload. Any member may read.
  if (deps.request.method === "GET") {
    const id = parts[1];
    if (!id || !HASH_RE.test(id)) return Response.json({ error: "invalid payload id" }, { status: 400 });
    countFleetR2("read");
    const obj = await bucket.get(prefix + id);
    if (!obj) return Response.json({ error: "no such payload" }, { status: 404 });
    return new Response(obj.body, {
      headers: {
        "content-type": "application/octet-stream",
        "x-prime-payload": id,
        "x-prime-epoch": String(role.epoch),
      },
    });
  }

  return null;
}

/** Whether this runtime can give the bucket a body of a length it knows (the Workers runtime can). */
function canStream(): boolean {
  return typeof (globalThis as { FixedLengthStream?: unknown }).FixedLengthStream === "function";
}

/**
 * Store a pack from a body that is read once, as it comes, straight into the bucket under the key the sender named. The bucket checks
 * the hash itself (`sha256`) and refuses a body that is not that pack, or not as long as it said, without writing anything and without
 * touching an object that is already under the key: nothing here ever deletes. A pack the bucket already holds at that size is not
 * written again (the body is dropped unread).
 */
async function streamedPack(
  deps: PayloadDeps,
  deviceId: string,
  role: FleetRole,
  bucket: NonNullable<FleetDeps["env"]["BUCKET"]>,
  prefix: string,
  hash: string,
  length: number,
): Promise<Response> {
  const key = prefix + hash;
  const noted = await noteUpload(deps, deviceId, hash);
  if (noted === "unavailable") return Response.json({ error: "the fleet could not be reached to note the upload: try again", code: "fleet-unreachable" }, { status: 503, headers: { "retry-after": "5" } });
  if (!noted.primary) return Response.json({ error: "only the primary may publish", code: "not-primary" }, { status: 409 });
  const body = deps.request.body;
  if (!body) return Response.json({ error: "empty payload" }, { status: 400 });
  // Whether it is there already is not guessed at: a bucket that cannot say is not "absent".
  let held: { size: number } | null;
  try {
    countFleetR2("read");
    held = await bucket.head(key);
  } catch {
    await body.cancel().catch(() => {});
    return Response.json({ error: "the bucket could not be asked: try again", code: "bucket-unavailable" }, { status: 503, headers: { "retry-after": "5" } });
  }
  if (held && held.size === length) {
    await body.cancel().catch(() => {});
    return Response.json({ ok: true, key, hash, size: length, epoch: role.epoch, again: true });
  }
  const fixed = new FixedLengthStream(length);
  const copying = body.pipeTo(fixed.writable);
  countFleetR2("write");
  try {
    await Promise.all([bucket.put(key, fixed.readable, { sha256: hash, httpMetadata: { contentType: "application/octet-stream" } }), copying]);
  } catch (error) {
    // A body that is not the pack it names, or not as long as it said, or that broke off: the bucket kept nothing of it (and left what
    // was under the key as it was). Anything else the bucket says is its own trouble, to be tried again.
    if (/checksum|sha-?256|too many bytes|fewer bytes|FixedLengthStream/i.test(String(error))) {
      return Response.json({ error: "the body is not the pack whose hash was named, or not as long as it said: upload it again", code: "body-mismatch" }, { status: 400 });
    }
    return Response.json({ error: "the bucket could not take the pack: try again", code: "bucket-unavailable" }, { status: 503, headers: { "retry-after": "5" } });
  }
  return Response.json({ ok: true, key, hash, size: length, epoch: role.epoch });
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  let hex = "";
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** When each device was last seen, so the registry is told at most once a minute. */
const lastSeen = new Map<string, number>();

/**
 * The devices the gateway still knows, or null when that cannot be said.
 *
 * A device that is not here any more cannot be called, so it cannot be taking part in a fleet.
 * The answer is used to take a fleet away, so anything short of a whole answer (the registry
 * failed, was slow, or sent something that is not both lists) is null, and a caller that gets null
 * keeps what it was going to delete: an empty set would read as "nobody is known".
 */
async function knownDevices(env: Env): Promise<Set<string> | null> {
  try {
    const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
    const res = await reg.fetch("https://registry/map");
    if (!res.ok) return null;
    const body = (await res.json()) as { map?: unknown; anonymous?: unknown };
    if (!body || typeof body.map !== "object" || body.map === null || Array.isArray(body.map) || !Array.isArray(body.anonymous)) return null;
    const known = new Set<string>(Object.keys(body.map));
    for (const id of body.anonymous) {
      if (typeof id !== "string") return null;
      known.add(id);
    }
    return known;
  } catch {
    return null;
  }
}

/**
 * Tell the registry that a device is still in use.
 *
 * `everyMs` is how seldom it is told: a device that is working is told once a minute, and one of a paused fleet,
 * which only asks to find out whether it is resumed, once an hour. A device the registry has not heard from for
 * ANON_IDLE_TTL_MS is collected, and a member of a fleet that is paused for longer than that would otherwise
 * be gone, and unable to come back, when the operator resumes it.
 */
export async function markSeen(env: Env, deviceId: string, everyMs = 60_000): Promise<void> {
  const now = Date.now();
  const previous = lastSeen.get(deviceId) ?? 0;
  if (now - previous < everyMs) return;
  lastSeen.set(deviceId, now);
  try {
    const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
    await reg.fetch("https://registry/anon/seen?id=" + encodeURIComponent(deviceId), { method: "POST" });
  } catch {}
}

export interface FleetDeps {
  request: Request;
  env: Env;
  url: URL;
  cfg: GatewayConfig;
  /** prove a device credential; returns the deviceId or null. */
  authorizeDevice: (deviceId: string) => Promise<{ ok: true } | { ok: false; response: Response }>;
  /** whether a device holds a tunnel right now, as the registry sees it. */
  deviceOnline?: (deviceId: string, since?: number) => Promise<boolean>;
  /** whether the operator has paused this fleet, from the registry's copy. */
  fleetPaused?: (fleetId: string) => Promise<boolean>;
  unauthorized: () => Response;
}

/**
 * Who the fleet operator is, when the request carries a credential for it. Every route that acts as the operator
 * asks this one place, so that FLEET_OPERATOR_SSO_ONLY and FLEET_OPERATOR_EMAILS cannot be forgotten by one of them.
 *
 * - An Access assertion as `cf-access-token` (what `cloudflared access token` prints) is the operator when the
 *   deployment's Access application signed it (ACCESS_TEAM_DOMAIN and ACCESS_AUD, as for the admin page). Only the
 *   header counts, not the cookie, which a browser sends unasked. It must name someone, a person's email or a
 *   service token's name, and when FLEET_OPERATOR_EMAILS lists identities, one of them. `actor` is how the fleet's
 *   record names them.
 * - FLEET_OPERATOR_TOKEN is the operator without a name, unless FLEET_OPERATOR_SSO_ONLY switches it off. Only that
 *   token counts: the gateway token is what every machine and MCP client of the gateway is given, so it is not an
 *   authority over fleets; a deployment that sets none has no token operator at all (the admin page and a fleet's
 *   owner device remain).
 * - `none`: no operator credential was presented. `refused`: one was, and `response` says why; it is the answer.
 */
export type Operator = { kind: "access"; actor: string } | { kind: "token" } | { kind: "none" } | { kind: "refused"; response: Response };

export async function operatorCredential(cfg: GatewayConfig, env: Env, request: Request, url: URL): Promise<Operator> {
  const refuse = (status: number, error: string, hint?: string): Operator => ({
    kind: "refused",
    response: Response.json({ error, ...(hint ? { hint } : {}) }, { status, headers: { "cache-control": "no-store" } }),
  });
  if (request.headers.get("cf-access-token")?.trim()) {
    const team = (env.ACCESS_TEAM_DOMAIN ?? "").trim();
    const aud = (env.ACCESS_AUD ?? "").trim();
    // The answers say no more than that the token was not accepted: why is for the gateway's log.
    if (!team || !aud) {
      console.warn("operator: an Access token was presented, but ACCESS_TEAM_DOMAIN / ACCESS_AUD are not set");
      return refuse(401, "the Access token was not accepted");
    }
    const verdict = await verifyOperatorToken(request, { team, aud });
    if (!verdict || !verdict.ok) {
      console.warn("operator: Access token refused (" + (verdict?.reason ?? "none") + ")");
      return refuse(401, "the Access token was not accepted");
    }
    const actor = actorOf(verdict);
    if (!actor) {
      console.warn("operator: Access token names no identity");
      return refuse(403, "the Access token names no one");
    }
    if (!emailAllowed(cfg.fleetOperatorEmails, verdict.email)) {
      console.warn("operator: " + actor + " is not in FLEET_OPERATOR_EMAILS");
      return refuse(403, "this identity may not operate fleets here");
    }
    return { kind: "access", actor };
  }
  if (cfg.fleetOperatorToken) {
    const t = extractToken(request, url, "auth");
    if (t && timingSafeEq(t, cfg.fleetOperatorToken)) {
      if (cfg.fleetOperatorSsoOnly) {
        return refuse(403, "the operator token is switched off", "FLEET_OPERATOR_SSO_ONLY is set on this gateway: sign in with Cloudflare Access (cf-access-token)");
      }
      return { kind: "token" };
    }
  }
  return { kind: "none" };
}

/**
 * Whether the request carries the gateway token (which used to be, and no longer is, the operator's), or the
 * shared device token while FLEET_OPERATOR_TOKEN is set to that same value and so not accepted.
 */
function carriesGatewayToken(cfg: GatewayConfig, request: Request, url: URL): boolean {
  const t = extractToken(request, url, "auth");
  if (!t) return false;
  if (cfg.gatewayToken && timingSafeEq(t, cfg.gatewayToken)) return true;
  return !!cfg.fleetOperatorTokenRefused && !!cfg.deviceToken && timingSafeEq(t, cfg.deviceToken);
}

// Creating a fleet is open to a proven device as well as to the operator:
// the first member of a fleet is a space, and it has to be able to bring
// the fleet into being. Admission of everyone else still takes an invite
// and an approval, and the Durable Object caps how many fleets one device
// may create.
function isCreateRoute(method: string, action: string | undefined): boolean {
  return method === "POST" && action === undefined;
}

export async function handleFleetRoutes(deps: FleetDeps): Promise<Response | null> {
  const { request, env, url, cfg } = deps;
  const match = FLEET_PATH.exec(url.pathname);
  if (!match) return null;

  const fleetId = match[1]!;
  const action = match[2];
  if (!validFleetId(fleetId)) return Response.json({ error: "invalid fleet id" }, { status: 400 });
  // A payload action carries an id after it, so the allowlist is checked on
  // the first segment only.
  const actionHead = action === undefined ? undefined : action.split("/")[0];
  if (actionHead !== undefined && !ALLOWED_ACTIONS.has(actionHead)) {
    return Response.json({ error: "no such fleet action" }, { status: 404 });
  }

  const operator = await operatorCredential(cfg, env, request, url);
  if (operator.kind === "refused") return operator.response;
  const admin = operator.kind !== "none";
  const actor = operator.kind === "access" ? operator.actor : undefined;

  // The routes that run a fleet are open to the operator and to the owner of
  // that fleet. A member it invited would have no way to admit anyone if only
  // the operator could, so the device path proves the credential and the
  // object decides whether this device owns the fleet.
  //
  // Device routes need a proven device credential. The device names itself, but
  // the credential proves the name: authorizeDevice checks the token against the
  // registry entry for exactly that id.
  let caller: FleetAuth = { admin };
  if (!admin) {
    const claimed = request.headers.get("x-prime-device") ?? url.searchParams.get("device") ?? "";
    if (!claimed) {
      // A caller that came with the gateway token and no device is an operator of an earlier gateway: say
      // what changed, instead of a bare "unauthorized".
      if (carriesGatewayToken(cfg, request, url)) {
        return Response.json(
          {
            error: "the gateway token does not run fleets any more",
            hint: cfg.fleetOperatorTokenRefused
              ? "FLEET_OPERATOR_TOKEN is the same value as GATEWAY_TOKEN (or DEVICE_TOKEN), so it is not used: it must differ from both"
              : "set FLEET_OPERATOR_TOKEN on the gateway and present that value (prime: --operator-token, or PRIME_FLEET_OPERATOR_TOKEN); the admin page and a fleet's owner device work as before",
          },
          { status: 403 },
        );
      }
      return deps.unauthorized();
    }
    const verdict = await deps.authorizeDevice(claimed);
    if (!verdict.ok) return verdict.response;
    caller = { admin: false, deviceId: claimed };
    // A paused fleet is answered here, before anything that wakes the fleet's object. The registry is told
    // the device is alive all the same, but seldom (see `markSeen`): a paused fleet's members are not unused
    // devices, and must not be collected as such while the operator has the fleet paused.
    if (deps.fleetPaused && action !== undefined && PAUSED_ACTIONS.has(action) && (await deps.fleetPaused(fleetId))) {
      await markSeen(env, claimed, PAUSED_SEEN_MS);
      return pausedAnswer();
    }
    // The device is alive: it just proved it. Without this a device that
    // only ever talks to the fleet would be collected as unused.
    await markSeen(env, claimed);
  } else if (isCreateRoute(request.method, action)) {
    // The operator may create a fleet on behalf of a device it names.
    const named = request.headers.get("x-prime-device") ?? url.searchParams.get("device") ?? "";
    if (!named) return deps.unauthorized();
    caller = { admin: true, deviceId: named };
  }

  const namespace = env.FLEET;
  if (!namespace) return Response.json({ error: "fleets are not enabled on this gateway" }, { status: 503 });

  // A device may create only a few fleets an hour. The count is kept in the
  // registry object, which every device shares.
  const counting = isCreateRoute(request.method, action) && !admin && caller.deviceId;
  if (counting && env.REGISTRY) {
    const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
    const counted = await reg.fetch("https://registry/fleet-count?id=" + encodeURIComponent(caller.deviceId!));
    const body = (await counted.json().catch(() => ({}))) as { count?: number };
    if ((body.count ?? 0) >= MAX_FLEETS_PER_DEVICE) {
      return Response.json({ error: "too many fleets created by this device" }, { status: 429 });
    }
  }

  // A member listens for what happens in the fleet over a socket, so it does not
  // have to ask. Only a member may listen - the object checks - and a paused
  // fleet still lets it, because that is how the member hears the pause end.
  if (action === "events") {
    if (request.method !== "GET") return Response.json({ error: "events is a GET" }, { status: 405 });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "expected a websocket upgrade" }, { status: 426 });
    }
    if (caller.admin || !caller.deviceId) return deps.unauthorized();
    // The member's own headers go on (the upgrade), but none that name an actor or carry a credential: the object
    // is told who it is by the headers set below.
    const listenHeaders = forwardableHeaders(request.headers);
    listenHeaders.set("x-prime-caller", "device");
    listenHeaders.set("x-prime-device", caller.deviceId);
    listenHeaders.set("x-prime-fleet", fleetId);
    const listenStub = namespace.get(namespace.idFromName(fleetId));
    return await listenStub.fetch(new Request("https://fleet/events", { method: "GET", headers: listenHeaders }));
  }

  // Clearing away a fleet that nobody can reach.
  //
  // A fleet whose members are all gone - the gateway knows none of them any more - is a fleet nobody
  // can run and nobody can leave, so any proven device may clear it away. That is the one way a device
  // that is not the fleet's owner can delete a fleet, and it fails closed: a registry that cannot be
  // read, or answers in part, keeps the fleet, and so does a fleet that has been touched within
  // REAP_SILENCE_MS (a paused fleet records nothing, so being quiet alone is not enough, and it is
  // not the only condition).
  if (action === "reap" && request.method === "POST") {
    const namespace = deps.env.FLEET;
    if (!namespace) return Response.json({ error: "fleets are not enabled on this gateway" }, { status: 503 });
    const caller = await provenDevice({ ...deps, fleetId, action });
    if (!caller) return deps.unauthorized();
    const stub = namespace.get(namespace.idFromName(fleetId));
    const headers = new Headers({ "content-type": "application/json" });
    headers.set("x-prime-caller", "admin");
    headers.set("x-prime-fleet", fleetId);
    // The gateway clears the fleet at this device's asking, and the log says whose.
    headers.set("x-prime-actor", "device:" + caller);
    const reaped = await stub.fetch("https://fleet/reap", { method: "POST", headers });
    if (!reaped.ok) return Response.json({ error: "no such fleet" }, { status: 404 });
    const body = (await reaped.json()) as { members?: string[]; lastActivity?: number; created?: number; meta?: { disabled?: boolean } };
    const members = body.members ?? [];
    if (members.length === 0) return Response.json({ ok: true, gone: true, members: 0 });
    // A paused fleet is the operator's to keep: its members are not asking, so the gateway forgets them and the
    // fleet looks untouched, which is what an abandoned one looks like. Only the operator or the owner deletes it.
    if (body.meta?.disabled === true) {
      return Response.json({ error: "the fleet is paused, so it is kept", members: members.length }, { status: 409 });
    }
    const known = await knownDevices(deps.env);
    if (known === null) {
      return Response.json(
        { error: "the gateway could not say which of the fleet's members it knows, so the fleet is kept", hint: "try again in a moment" },
        { status: 503, headers: { "retry-after": "30" } },
      );
    }
    const living = members.filter((id) => known.has(id));
    if (living.length > 0) {
      return Response.json(
        { error: "the fleet still has members the gateway knows", members: living.length },
        { status: 409 },
      );
    }
    const touched = Math.max(body.lastActivity ?? 0, body.created ?? 0);
    if (touched === 0 || Date.now() - touched < REAP_SILENCE_MS) {
      return Response.json(
        { error: "the fleet was in use less than " + Math.round(REAP_SILENCE_MS / 86_400_000) + " days ago, so it is kept", members: members.length },
        { status: 409 },
      );
    }
    const gone = await stub.fetch("https://fleet/delete", {
      method: "POST",
      headers,
      body: JSON.stringify({ reason: "every member is gone" }),
    });
    if (!gone.ok) return Response.json({ error: "could not clear the fleet" }, { status: 500 });
    return Response.json({ ok: true, gone: true, members: members.length });
  }

  // Who holds the lease. A member may ask; anyone else learns nothing.
  if (action === "primary" && request.method === "GET") {
    const namespace = deps.env.FLEET;
    if (!namespace) return Response.json({ error: "fleets are not enabled on this gateway" }, { status: 503 });
    const caller = await provenDevice({ ...deps, fleetId, action });
    if (!caller) return deps.unauthorized();
    const stub = namespace.get(namespace.idFromName(fleetId));
    const headers = new Headers({ "content-type": "application/json" });
    headers.set("x-prime-caller", "device");
    headers.set("x-prime-device", caller);
    headers.set("x-prime-fleet", fleetId);
    return await stub.fetch("https://fleet/primary", { method: "GET", headers });
  }

  // A snapshot is the pack and its manifest, stored together and the head
  // moved in one call. The member would otherwise spend six round trips on
  // it, and that is most of the time a change takes to travel.
  if (action === "snapshot" && request.method === "POST") {
    return await publishSnapshot(deps, fleetId);
  }

  // Payloads (encrypted packs and manifests) are stored in R2 by this Worker,
  // not by the Durable Object: they carry bytes, and an object that holds a
  // request body is a poor place for them.
  const payload = await handleFleetPayload({ request, env, url, cfg, fleetId, action, authorizeDevice: deps.authorizeDevice, unauthorized: deps.unauthorized });
  if (payload) return payload;
  const stub = namespace.get(namespace.idFromName(fleetId));
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("x-prime-caller", caller.admin ? "admin" : "device");
  // On an operator call the owner of record is whoever the operator names; the
  // DO stores it so invites can be attributed. A device caller is itself.
  const owner = request.headers.get("x-prime-device") ?? url.searchParams.get("device") ?? "";
  headers.set("x-prime-device", caller.admin ? owner : (caller.deviceId ?? ""));
  // Who the operator is, when an Access identity says so. Set here, from the verified assertion: a client's own
  // x-prime-actor is not passed on, since these headers are built fresh.
  if (actor) headers.set("x-prime-actor", actor);
  headers.set("x-prime-fleet", fleetId);

  const target = new URL("https://fleet" + (action ? "/" + action : "/create"));
  // The index is asked from a sequence on.
  if (action === "index") target.search = url.search;
  // The log is read from the entry after `after`, a page at a time.
  if (action === "roster") {
    const after = url.searchParams.get("after");
    if (after !== null) target.searchParams.set("after", after);
  }
  if (action === "audit") {
    for (const name of ["after", "limit", "tail"]) {
      const v = url.searchParams.get(name);
      if (v !== null) target.searchParams.set(name, v);
    }
  }
  if (!action && request.method === "GET") {
    // GET /fleets/:id is the roster; forward as /members
    target.pathname = "/members";
  }
  // The roster is read and written at one name.
  const method = action === "roster" ? (request.method === "POST" ? "POST" : "GET") : action !== undefined && READ_ACTIONS.has(action) ? "GET" : "POST";
  // Every route takes a small JSON document; what is bigger is refused here, not handed to the object.
  let body: string | undefined;
  if (method === "POST") {
    const read = await readBoundedText(request, fleetBodyMax(env));
    if (read instanceof Response) return read;
    body = read;
  }
  // The one thing set through the fleet routes is the lease. The label and the pause are the admin page's: the
  // registry that answers for a paused fleet without waking it is told there, and would not be told here.
  if (action === "meta") {
    let asked: unknown;
    try {
      asked = JSON.parse(body ?? "{}");
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 });
    }
    const leaseMs = (asked as { leaseMs?: unknown } | null)?.leaseMs;
    if (leaseMs === undefined) return Response.json({ error: "leaseMs is what is set here (a number of milliseconds, or null for the gateway's)" }, { status: 400 });
    body = JSON.stringify({ leaseMs });
  }

  let response = await stub.fetch(target.toString(), { method, headers, body });

  // A member that asks to take its place is told that the lease is held. If the
  // one holding it is not connected, the lease is a leftover clock, and the
  // fleet should not wait it out: the holder is taken out of the running and
  // the ask is repeated, so the takeover costs a round instead of a lease.
  if (action === "bootstrap" && response.ok && deps.deviceOnline) {
    const ask = (await response.clone().json().catch(() => ({}))) as { reason?: string; holder?: string; holderSince?: number };
    if (ask.reason === "lease-held" && ask.holder && !(await deps.deviceOnline(ask.holder, typeof ask.holderSince === "number" ? ask.holderSince : undefined))) {
      const vacateHeaders = new Headers(headers);
      vacateHeaders.set("x-prime-caller", "admin");
      // The gateway's own doing, not the operator's.
      vacateHeaders.set("x-prime-actor", "gateway");
      await stub
        .fetch("https://fleet/vacate", {
          method: "POST",
          headers: vacateHeaders,
          // quiet: the asker takes the place on the repeat just below; nobody else
          // needs to be woken for it.
          body: JSON.stringify({ deviceId: ask.holder, quiet: true }),
        })
        .catch(() => null);
      response = await stub.fetch(target.toString(), { method, headers, body });
    }
  }

  // Count the fleet only once it exists: a retry against a fleet that is
  // already there must not use up the device's allowance.
  if (counting && response.ok && env.REGISTRY) {
    const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
    await reg.fetch("https://registry/fleet-created?id=" + encodeURIComponent(caller.deviceId!), { method: "POST" });
  }
  return response;
}