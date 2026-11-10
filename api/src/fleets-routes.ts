// HTTP surface for fleets. Two kinds of caller, two kinds of proof:
//
//   operator (gateway token)  create a fleet, mint an invite, approve, remove.
//   device   (device token)   join with an invite, read my status, read the
//                             roster if I am in it.
//
// The Worker is the only component that can see a credential, so it is the only
// one that decides who the caller is. It then tells the Durable Object, which
// trusts the internal headers because a DO is not reachable from the internet:
// it exists only behind this Worker's binding. Authentication at the edge,
// authorization in the object.

import { timingSafeEq, extractToken, type GatewayConfig } from "./config";
import { MAX_FLEETS_PER_DEVICE, validFleetId, type FleetAuth } from "./fleets";
import type { Env } from "./config";

// Captured as a general action segment and then checked against an allowlist,
// so a new route cannot be reached by a path the object does not implement and
// an unknown path is a clean 404 rather than a miss.
// A payload id is a hex digest, so it can never traverse a path.
const FLEET_PATH = /^\/(?:api\/)?fleets\/([a-z0-9][a-z0-9-]{0,31})(?:\/([a-z]+(?:\/[a-z0-9-]+)?))?$/;
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
  "invite-check",
  "primary",
  "reap",
  "delete",
  "packs",
  "manifests",
  "keys",
]);
const READ_ACTIONS = new Set(["members", "pending", "me", "role", "head", "keys"]);


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
  if (!role.primary) return Response.json({ error: "only the primary may publish" }, { status: 409 });

  const body = Buffer.from(await deps.request.arrayBuffer());
  if (body.length < 4) return Response.json({ error: "malformed snapshot" }, { status: 400 });
  const manifestLength = body.readUInt32BE(0);
  if (manifestLength === 0 || manifestLength + 4 > body.length) {
    return Response.json({ error: "malformed snapshot" }, { status: 400 });
  }
  const manifestBytes = body.subarray(4, 4 + manifestLength);
  const pack = body.subarray(4 + manifestLength);
  if (pack.length === 0) return Response.json({ error: "empty pack" }, { status: 400 });

  let manifest: { seq?: number; packKey?: string; packHash?: string };
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8")) as { seq?: number; packKey?: string; packHash?: string };
  } catch {
    return Response.json({ error: "malformed manifest" }, { status: 400 });
  }
  const seq = typeof manifest.seq === "number" ? manifest.seq : 0;
  if (seq < 1) return Response.json({ error: "manifest has no sequence" }, { status: 400 });

  // The two objects are addressed by their contents, so writing the same bytes
  // twice is free.
  const packHash = await sha256Hex(pack);
  const packKey = "fleets/" + fleetId + "/packs/" + packHash;

  // The manifest says where its pack is. The member cannot know that - only
  // the gateway knows where the bytes ended up - so it is filled in here.
  manifest.packKey = packKey;
  manifest.packHash = packHash;
  const finalManifest = Buffer.from(JSON.stringify(manifest), "utf8");
  const manifestHash = await sha256Hex(finalManifest);
  const manifestKey = "fleets/" + fleetId + "/manifests/" + manifestHash;

  await bucket.put(packKey, pack, { httpMetadata: { contentType: "application/octet-stream" } });
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
    body: JSON.stringify({ expectedSeq: seq - 1, manifestKey, manifestHash, packKey }),
  });
  const result = (await moved.json().catch(() => ({}))) as { ok?: boolean; head?: unknown; error?: string };
  if (!moved.ok) return Response.json({ ok: false, error: result.error ?? "the head did not move" }, { status: moved.status });
  return Response.json({ ok: true, head: result.head, seq, manifestKey });
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
  const role = await fleetRole(deps, deviceId);
  if (!role) return Response.json({ error: "not a member of this fleet" }, { status: 403 });

  const prefix = "fleets/" + deps.fleetId + "/" + parts[0] + "/";

  // Upload a payload. Only the primary may publish.
  if (deps.request.method === "POST") {
    if (!role.primary) {
      return Response.json({ error: "only the primary may publish" }, { status: 409 });
    }
    const body = await deps.request.arrayBuffer();
    if (body.byteLength === 0) return Response.json({ error: "empty payload" }, { status: 400 });
    const digest = await sha256Hex(body);
    const key = prefix + digest;
    // Content addressed: writing the same bytes twice is free and idempotent.
    await bucket.put(key, body, { httpMetadata: { contentType: "application/octet-stream" } });
    return Response.json({ ok: true, key, hash: digest, size: body.byteLength, epoch: role.epoch });
  }

  // Download a payload. Any member may read.
  if (deps.request.method === "GET") {
    const id = parts[1];
    if (!id || !HASH_RE.test(id)) return Response.json({ error: "invalid payload id" }, { status: 400 });
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

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  let hex = "";
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** When each device was last seen, so the registry is told at most once a minute. */
const lastSeen = new Map<string, number>();

/**
 * The devices the gateway still knows.
 *
 * A device that is not here any more cannot be called, so it cannot be
 * taking part in a fleet.
 */
async function knownDevices(env: Env): Promise<Set<string>> {
  const known = new Set<string>();
  try {
    const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
    const res = await reg.fetch("https://registry/map");
    if (!res.ok) return known;
    const body = (await res.json()) as { map?: Record<string, string>; anonymous?: string[] };
    for (const id of Object.keys(body.map ?? {})) known.add(id);
    for (const id of body.anonymous ?? []) known.add(id);
  } catch {}
  return known;
}

/** Tell the registry that a device is still in use. */
export async function markSeen(env: Env, deviceId: string): Promise<void> {
  const now = Date.now();
  const previous = lastSeen.get(deviceId) ?? 0;
  if (now - previous < 60_000) return;
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
  unauthorized: () => Response;
}

function adminOnly(cfg: GatewayConfig, request: Request, url: URL): boolean {
  // With no gateway token configured the deployment is open (local dev).
  if (!cfg.gatewayToken) return false;
  const t = extractToken(request, url, "auth");
  return !!t && timingSafeEq(t, cfg.gatewayToken);
}

function isAdminRoute(method: string, action: string | undefined): boolean {
  if (method !== "POST" && method !== "GET" && method !== "DELETE") return false;
  if (method === "POST" && (action === "invite" || action === "approve" || action === "remove" || action === "revoke")) return true;
  if (method === "GET" && action === "pending") return true;
  return false;
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

  const admin = adminOnly(cfg, request, url);
  const adminRoute = isAdminRoute(request.method, action);

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
      if (adminRoute) return deps.unauthorized();
      return deps.unauthorized();
    }
    const verdict = await deps.authorizeDevice(claimed);
    if (!verdict.ok) return verdict.response;
    caller = { admin: false, deviceId: claimed };
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

  // Reaping a fleet nobody can reach.
  //
  // A fleet whose members are all gone - the gateway does not know any of
  // them any more - is a fleet nobody can run and nobody can leave. Any
  // proven device may clear it away.
  if (action === "reap" && request.method === "POST") {
    const namespace = deps.env.FLEET;
    if (!namespace) return Response.json({ error: "fleets are not enabled on this gateway" }, { status: 503 });
    const caller = await provenDevice({ ...deps, fleetId, action });
    if (!caller) return deps.unauthorized();
    const stub = namespace.get(namespace.idFromName(fleetId));
    const headers = new Headers({ "content-type": "application/json" });
    headers.set("x-prime-caller", "admin");
    headers.set("x-prime-fleet", fleetId);
    const reaped = await stub.fetch("https://fleet/reap", { method: "POST", headers });
    if (!reaped.ok) return Response.json({ error: "no such fleet" }, { status: 404 });
    const body = (await reaped.json()) as { members?: string[]; lastActivity?: number };
    const members = body.members ?? [];
    if (members.length === 0) return Response.json({ ok: true, gone: true, members: 0 });
    const known = await knownDevices(deps.env);
    const living = members.filter((id) => known.has(id));
    if (living.length > 0) {
      return Response.json(
        { error: "the fleet still has members the gateway knows", members: living.length },
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

  // Whether an invite is worth having. It needs no credential: the code is
  // the proof, and a caller that holds a valid code learns the same thing by
  // joining.
  if (action === "invite-check" && request.method === "POST") {
    const namespace = deps.env.FLEET;
    if (!namespace) return Response.json({ error: "fleets are not enabled on this gateway" }, { status: 503 });
    const stub = namespace.get(namespace.idFromName(fleetId));
    const headers = new Headers({ "content-type": "application/json" });
    headers.set("x-prime-caller", "admin");
    const body = await request.clone().text();
    return await stub.fetch("https://fleet/invite-check", { method: "POST", headers, body });
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
  headers.set("x-prime-fleet", fleetId);

  const target = new URL("https://fleet" + (action ? "/" + action : "/create"));
  if (!action && request.method === "GET") {
    // GET /fleets/:id is the roster; forward as /members
    target.pathname = "/members";
  }
  const method = action !== undefined && READ_ACTIONS.has(action) ? "GET" : "POST";
  const body = method === "POST" ? await request.text() : undefined;

  const response = await stub.fetch(target.toString(), { method, headers, body });

  // Count the fleet only once it exists: a retry against a fleet that is
  // already there must not use up the device's allowance.
  if (counting && response.ok && env.REGISTRY) {
    const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
    await reg.fetch("https://registry/fleet-created?id=" + encodeURIComponent(caller.deviceId!), { method: "POST" });
  }
  return response;
}