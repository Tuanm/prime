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
import { validFleetId, type FleetAuth } from "./fleets";
import type { Env } from "./config";

// Captured as a general action segment and then checked against an allowlist,
// so a new route cannot be reached by a path the object does not implement and
// an unknown path is a clean 404 rather than a miss.
const FLEET_PATH = /^\/(?:api\/)?fleets\/([a-z0-9][a-z0-9-]{0,31})(?:\/([a-z]+(?:\/[a-z]+)?))?$/;
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
  "lease/renew",
  "lease/release",
  "head/advance",
]);
const READ_ACTIONS = new Set(["members", "pending", "me"]);

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
  // POST /fleets (no action) creates a fleet: operator authority.
  if (method === "POST" && action === undefined) return true;
  return false;
}

export async function handleFleetRoutes(deps: FleetDeps): Promise<Response | null> {
  const { request, env, url, cfg } = deps;
  const match = FLEET_PATH.exec(url.pathname);
  if (!match) return null;

  const fleetId = match[1]!;
  const action = match[2];
  if (!validFleetId(fleetId)) return Response.json({ error: "invalid fleet id" }, { status: 400 });
  if (action !== undefined && !ALLOWED_ACTIONS.has(action)) {
    return Response.json({ error: "no such fleet action" }, { status: 404 });
  }

  const admin = adminOnly(cfg, request, url);
  const adminRoute = isAdminRoute(request.method, action);

  // Operator routes need the gateway token; without one, refuse rather than
  // silently degrade to "anyone may mint invites".
  if (adminRoute && !admin) {
    if (cfg.gatewayToken) return deps.unauthorized();
    return Response.json({ error: "fleet administration requires a gateway token" }, { status: 403 });
  }

  // Device routes need a proven device credential. The device names itself, but
  // the credential proves the name: authorizeDevice checks the token against the
  // registry entry for exactly that id.
  let caller: FleetAuth = { admin };
  if (!admin) {
    const claimed = request.headers.get("x-prime-device") ?? url.searchParams.get("device") ?? "";
    if (!claimed) return deps.unauthorized();
    const verdict = await deps.authorizeDevice(claimed);
    if (!verdict.ok) return verdict.response;
    caller = { admin: false, deviceId: claimed };
  }

  const namespace = env.FLEET;
  if (!namespace) return Response.json({ error: "fleets are not enabled on this gateway" }, { status: 503 });
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

  return stub.fetch(target.toString(), { method, headers, body });
}
