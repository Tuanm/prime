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