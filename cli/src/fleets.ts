// `prime fleets ...` - fleet membership.
//
// A fleet is a named group of devices that hold the same work. Exactly one is
// the primary and may write; the others mirror it.
//
// Membership has two steps on purpose. The operator mints an invite; the
// device presents it and waits for approval. The device that creates a fleet
// is its owner.
//
// Credentials, highest priority first:
//   1. --gateway / --gateway-token (operator) and --device / --token (member)
//   2. the config file's defaults and device entries
//   3. PRIME_GATEWAY_URL / PRIME_GATEWAY_TOKEN / PRIME_DEVICE_TOKEN

import { bool, num, str } from "./args.ts";
import type { Config, SpaceEntry } from "./config.ts";
import type { Ctx } from "./context.ts";
import { CliError, UsageError } from "./errors.ts";
import { bold, dim, green, printJson, table, yellow } from "./output.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadOrCreateKeyPair, pull, publish, type MemberPaths } from "./fleet-agent.ts";
import { snapshot } from "./fleet-sync.ts";
import { fetchMemberKeys, fetchRole, type FleetCredentials } from "./fleet-transport.ts";
import { ensureFleetAgent, fleetAgentStatus, stopFleetAgent } from "./fleet-daemon.ts";
import { DEFAULT_GATEWAY, ENV, normalizeGateway } from "./target.ts";

const FLEET_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface FleetTarget {
  gateway: string;
  /** Operator credential; absent for member-only calls. */
  gatewayToken?: string;
  /** Device id this call speaks as. */
  device?: string;
  /** Device token this call speaks as. */
  deviceToken?: string;
  timeoutMs: number;
}

export interface FleetTargetFlags {
  gateway?: string;
  gatewayToken?: string;
  device?: string;
  token?: string;
  timeout?: number;
}

/**
 * Decide which gateway and credentials a fleet command talks to.
 *
 * Pure, so the precedence is unit-tested without a config file on disk.
 * A space may supply the device credentials, which is how a space that was
 * created for a fleet talks to the gateway without extra flags.
 */
export function resolveFleetTarget(
  config: Config,
  flags: FleetTargetFlags,
  spaceName?: string,
  env: Record<string, string | undefined> = process.env,
): FleetTarget {
  const space = spaceName ? config.spaces[spaceName] : undefined;
  const device = flags.device ?? space?.gateway_device ?? space?.id ?? Object.keys(config.devices)[0];
  const deviceToken = flags.token ?? space?.remote_token ?? space?.token;
  const gateway = normalizeGateway(flags.gateway ?? space?.gateway ?? config.defaults.gateway ?? env[ENV.gateway] ?? DEFAULT_GATEWAY);
  const gatewayToken = flags.gatewayToken ?? env[ENV.gatewayToken] ?? config.defaults.gateway_token ?? space?.gateway_token;
  const timeoutMs = flags.timeout ?? config.defaults.timeout_ms ?? 300_000;
  return { gateway, gatewayToken, device, deviceToken, timeoutMs };
}

export interface FleetMember {
  deviceId: string;
  role: "owner" | "member";
  addedAt: number;
  addedBy?: string;
}

export interface FleetInvite {
  code: string;
  expiresAt: number;
  autoApprove?: boolean;
}

export interface FleetBootstrap {
  role: "primary" | "replica";
  epoch: number;
  reason?: string;
  head?: { seq: number; manifestKey: string; manifestHash: string; epoch: number };
}

async function call(
  target: FleetTarget,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (target.gatewayToken) headers["authorization"] = "Bearer " + target.gatewayToken;
  if (target.device) headers["x-prime-device"] = target.device;
  if (target.deviceToken) headers["x-device-token"] = target.deviceToken;
  if (body !== undefined) headers["content-type"] = "application/json";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), target.timeoutMs);
  try {
    const res = await fetch(target.gateway + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: text.slice(0, 200) };
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

function requireFleetId(raw: string): string {
  if (!FLEET_ID_RE.test(raw)) {
    throw new UsageError(
      "invalid fleet id \"" + raw + "\"",
      "A fleet id is 1 to 32 characters: lower-case letters, digits and dashes, starting with a letter or a digit.",
    );
  }
  return raw;
}

function failOn(status: number, json: any, what: string): void {
  if (status < 400) return;
  const message = typeof json?.error === "string" ? json.error : "request failed";
  throw new CliError(what + ": " + message);
}

function target(ctx: Ctx, spaceName?: string): FleetTarget {
  const t = resolveFleetTarget(
    ctx.config,
    {
      gateway: str(ctx.parsed, "gateway"),
      gatewayToken: str(ctx.parsed, "gateway-token"),
      device: str(ctx.parsed, "device"),
      token: str(ctx.parsed, "token"),
      timeout: ctx.parsed.flags.has("timeout") ? Number(ctx.parsed.flags.get("timeout")) : undefined,
    },
    spaceName,
  );
  // A fleet command speaks for a device. Without its credential the gateway
  // cannot tell who is asking, and the answer would be a bare
  // "unauthorized" that says nothing about what to do.
  if (!t.gatewayToken && !t.deviceToken) {
    throw new CliError(
      "no credential to speak with",
      "Name the device this command is about: --space <name>, or --device <id> --token <token>. The operator's own credential is --gateway-token.",
    );
  }
  return t;
}

/** The space a device is the identity of, if it is one. */
function spaceOfDevice(config: Config, deviceId: string): string | undefined {
  for (const [id, entry] of Object.entries(config.devices)) {
    if (id === deviceId && entry.space) return entry.space;
  }
  for (const [name, space] of Object.entries(config.spaces)) {
    if (space.gateway_device === deviceId) return name;
  }
  return undefined;
}

function spaceArg(ctx: Ctx): string | undefined {
  return str(ctx.parsed, "space");
}

export async function fleetsCreate(ctx: Ctx): Promise<void> {
  const fleetId = requireFleetId(ctx.parsed.positionals[2] ?? "");
  const t = target(ctx, spaceArg(ctx));
  const res = await call(t, "POST", "/fleets/" + encodeURIComponent(fleetId), {});
  if (res.status === 403) {
    throw new CliError(
      "only the operator may create a fleet",
      "A fleet is set up in the admin interface, where the operator admits the spaces that join it.",
    );
  }
  failOn(res.status, res.json, "could not create the fleet");
  if (ctx.json) {
    printJson({ fleet: fleetId, member: res.json.member });
    return;
  }
  ctx.out(green("created fleet ") + " " + bold(fleetId));
  ctx.out(dim("this device is the owner; it can mint invites and approve members"));
}

/**
 * Clear away a fleet that nobody can reach.
 *
 * A fleet whose members are all gone - the gateway does not know any of
 * them any more - cannot be run and cannot be left. Any proven device may
 * clear it away.
 */
export async function fleetsReap(ctx: Ctx): Promise<void> {
  const fleetId = requireFleetId(ctx.parsed.positionals[2] ?? "");
  const t = target(ctx, spaceArg(ctx));
  const res = await call(t, "POST", "/fleets/" + encodeURIComponent(fleetId) + "/reap", {});
  failOn(res.status, res.json, "could not clear the fleet away");
  if (ctx.json) {
    printJson({ fleet: fleetId, gone: true, members: res.json.members ?? 0 });
    return;
  }
  ctx.out(green("cleared away ") + " " + bold(fleetId) + dim(" (" + (res.json.members ?? 0) + " members, all gone)"));
}

export async function fleetsInvite(ctx: Ctx): Promise<void> {
  const fleetId = requireFleetId(ctx.parsed.positionals[2] ?? "");
  const t = target(ctx, spaceArg(ctx));
  const ttlMs = ctx.parsed.flags.has("ttl") ? Number(ctx.parsed.flags.get("ttl")) : undefined;
  const res = await call(t, "POST", "/fleets/" + encodeURIComponent(fleetId) + "/invite", { ttlMs });
  failOn(res.status, res.json, "could not mint an invite");
  const invite = res.json as FleetInvite;
  if (ctx.json) {
    printJson({ fleet: fleetId, invite });
    return;
  }
  ctx.out(yellow("invite code (single use, expires in " + Math.round((invite.expiresAt - Date.now()) / 1000) + "s)"));
  ctx.out("  " + bold(invite.code));
  ctx.out(dim("the device that presents this code still waits for the operator to admit it"));
}

export async function fleetsJoin(ctx: Ctx): Promise<void> {
  const fleetId = requireFleetId(ctx.parsed.positionals[2] ?? "");
  const code = str(ctx.parsed, "code");
  if (!code) throw new UsageError("missing --code", "Run 'prime fleets invite <fleet>' on the operator's machine and pass the code it prints.");
  const t = target(ctx, spaceArg(ctx));

  // The member's key. The fleet seals every snapshot for the keys its
  // members hold, so a member that joins without one could never open
  // anything it is sent. The key of a space is the key its agent uses, so
  // the same file is kept.
  if (!t.device) {
    throw new UsageError(
      "no device to join with",
      "Name the device that is joining: --space <name>, or --device <id> --token <token>.",
    );
  }
  const spaceName = spaceArg(ctx) ?? spaceOfDevice(ctx.config, t.device);
  const keyFile = fleetKeyFile(ctx.configPath, fleetId, spaceName ?? t.device ?? "device");
  const keys = loadOrCreateKeyPair(keyFile);
  const label = str(ctx.parsed, "label") ?? spaceName ?? "";

  const res = await call(t, "POST", "/fleets/" + encodeURIComponent(fleetId) + "/join", {
    code,
    ...(label ? { label } : {}),
    pubkey: keys.publicKey,
  });
  failOn(res.status, res.json, "could not join the fleet");
  if (ctx.json) {
    printJson({ fleet: fleetId, status: res.json.status });
    return;
  }
  if (res.json.status === "member") {
    ctx.out(green("joined fleet ") + " " + bold(fleetId));
  } else {
    ctx.out(yellow("request recorded; waiting for the operator to approve it"));
    ctx.out(dim("  the operator admits it in the admin interface"));
  }
}

export async function fleetsApprove(ctx: Ctx): Promise<void> {
  const fleetId = requireFleetId(ctx.parsed.positionals[2] ?? "");
  const deviceId = str(ctx.parsed, "member");
  if (!deviceId) throw new UsageError("missing --member", "The device id of the request to approve, as shown by 'prime fleets pending <fleet>'.");
  const t = target(ctx, spaceArg(ctx));
  const res = await call(t, "POST", "/fleets/" + encodeURIComponent(fleetId) + "/approve", { deviceId });
  failOn(res.status, res.json, "could not approve the request");
  if (ctx.json) {
    printJson({ fleet: fleetId, member: res.json.member });
    return;
  }
  ctx.out(green("approved") + " " + deviceId);
}

export async function fleetsPending(ctx: Ctx): Promise<void> {
  const fleetId = requireFleetId(ctx.parsed.positionals[2] ?? "");
  const t = target(ctx, spaceArg(ctx));
  const res = await call(t, "GET", "/fleets/" + encodeURIComponent(fleetId) + "/pending");
  failOn(res.status, res.json, "could not list the requests");
  const pending = (res.json.pending ?? []) as Array<{ deviceId: string; label?: string; requestedAt: number }>;
  if (ctx.json) {
    printJson({ fleet: fleetId, pending });
    return;
  }
  if (pending.length === 0) {
    ctx.out(dim("no requests waiting"));
    return;
  }
  ctx.out(table(["DEVICE", "LABEL", "REQUESTED"], [
    ...pending.map((p) => [p.deviceId, p.label ?? "-", new Date(p.requestedAt).toISOString()]),
  ]));
}

export async function fleetsMembers(ctx: Ctx): Promise<void> {
  const fleetId = requireFleetId(ctx.parsed.positionals[2] ?? "");
  const t = target(ctx, spaceArg(ctx));
  const res = await call(t, "GET", "/fleets/" + encodeURIComponent(fleetId) + "/members");
  failOn(res.status, res.json, "could not read the roster");
  const members = (res.json.members ?? []) as FleetMember[];
  if (ctx.json) {
    printJson({ fleet: fleetId, members });
    return;
  }
  ctx.out(table(["DEVICE", "ROLE", "ADDED"], [
    ...members.map((m) => [m.deviceId, m.role, new Date(m.addedAt).toISOString()]),
  ]));
}

export async function fleetsRemove(ctx: Ctx): Promise<void> {
  const fleetId = requireFleetId(ctx.parsed.positionals[2] ?? "");
  const deviceId = str(ctx.parsed, "member");
  if (!deviceId) throw new UsageError("missing --member", "The device id to remove.");
  const t = target(ctx, spaceArg(ctx));
  const res = await call(t, "POST", "/fleets/" + encodeURIComponent(fleetId) + "/remove", { deviceId });
  failOn(res.status, res.json, "could not remove the member");
  if (ctx.json) {
    printJson({ fleet: fleetId, removed: res.json.removed });
    return;
  }
  ctx.out(green("removed") + " " + deviceId + " from " + fleetId);
}

export async function fleetsLeave(ctx: Ctx): Promise<void> {
  const fleetId = requireFleetId(ctx.parsed.positionals[2] ?? "");
  const t = target(ctx, spaceArg(ctx));
  if (!t.device) throw new UsageError("no device to leave with", "Pass --device <id>.");
  const res = await call(t, "POST", "/fleets/" + encodeURIComponent(fleetId) + "/remove", { deviceId: t.device });
  failOn(res.status, res.json, "could not leave the fleet");
  if (ctx.json) {
    printJson({ fleet: fleetId, removed: res.json.removed });
    return;
  }
  ctx.out(green("left fleet ") + " " + fleetId);
}

/**
 * What the fleet agent is doing, and how to stop it.
 *
 * The agent is started on demand: a space that belongs to a fleet brings it
 * up, and it keeps every space of the fleet in step by itself.
 */
export async function fleetsAgent(ctx: Ctx): Promise<void> {
  const what = ctx.parsed.positionals[2] ?? "status";
  if (what === "stop") {
    const stopped = stopFleetAgent(ctx.configPath);
    if (ctx.json) {
      printJson({ stopped });
      return;
    }
    ctx.out(stopped ? green("stopped the fleet agent") : dim("the fleet agent was not running"));
    return;
  }
  if (what === "start") {
    const state = await ensureFleetAgent(ctx.configPath);
    if (ctx.json) {
      printJson({ started: true, pid: state.pid });
      return;
    }
    ctx.out(green("started the fleet agent") + " (pid " + state.pid + ")");
    return;
  }
  const status = fleetAgentStatus(ctx.configPath);
  if (ctx.json) {
    printJson(status);
    return;
  }
  if (!status.running) {
    ctx.out(dim("the fleet agent is not running"));
    return;
  }
  ctx.out(green("the fleet agent is running") + " (pid " + status.pid + ")");
  ctx.out(dim("  started   " + (status.started_at ?? "-")));
  ctx.out(dim("  spaces    " + (status.spaces ?? 0)));
  ctx.out(dim("  rounds    " + (status.rounds ?? 0)));
  if (status.last_action) ctx.out(dim("  last      " + status.last_action));
  if (status.last_error) ctx.out(yellow("  error     " + status.last_error));
  const t = status.timing;
  if (t) {
    const parts: string[] = [];
    if (t.bootstrap !== undefined) parts.push("lease " + t.bootstrap + "ms");
    if (t.snapshot !== undefined) parts.push("snapshot " + t.snapshot + "ms");
    if (t.publish !== undefined) parts.push("publish " + t.publish + "ms");
    if (t.pull !== undefined) parts.push("pull " + t.pull + "ms");
    if (parts.length > 0) ctx.out(dim("  timing    " + parts.join(", ")));
  }
}

export async function fleetsDelete(ctx: Ctx): Promise<void> {
  const fleetId = requireFleetId(ctx.parsed.positionals[2] ?? "");
  const t = target(ctx, spaceArg(ctx));
  const res = await call(t, "POST", "/fleets/" + encodeURIComponent(fleetId) + "/delete", {});
  failOn(res.status, res.json, "could not delete the fleet");
  if (ctx.json) {
    printJson({ fleet: fleetId, deleted: true });
    return;
  }
  ctx.out(green("deleted fleet ") + " " + bold(fleetId));
}

export async function fleetsRevoke(ctx: Ctx): Promise<void> {
  const fleetId = requireFleetId(ctx.parsed.positionals[2] ?? "");
  const t = target(ctx, spaceArg(ctx));
  const res = await call(t, "POST", "/fleets/" + encodeURIComponent(fleetId) + "/revoke", {});
  failOn(res.status, res.json, "could not revoke the invites");
  if (ctx.json) {
    printJson({ fleet: fleetId, revoked: res.json.revoked });
    return;
  }
  ctx.out(green("revoked") + " " + res.json.revoked + " invite(s)");
}

export async function fleetsStatus(ctx: Ctx): Promise<void> {
  const fleetId = requireFleetId(ctx.parsed.positionals[2] ?? "");
  const t = target(ctx, spaceArg(ctx));
  const res = await call(t, "GET", "/fleets/" + encodeURIComponent(fleetId) + "/me");
  failOn(res.status, res.json, "could not read the fleet status");
  if (ctx.json) {
    printJson({ fleet: fleetId, ...res.json });
    return;
  }
  ctx.out(bold(fleetId) + ": " + res.json.status);
  if (res.json.member) ctx.out(dim("role: " + res.json.member.role));
}
/** One round of synchronisation: take a place, then publish or pull. */
export async function syncFleetSpace(
  configPath: string,
  fleetId: string,
  spaceName: string,
  space: SpaceEntry,
  force = false,
): Promise<string> {
  const work = space.work_dir;
  if (!work) throw new CliError("the space " + spaceName + " has no work directory yet");
  const gateway = space.gateway;
  const deviceId = space.gateway_device;
  const deviceToken = space.remote_token;
  if (!gateway || !deviceId || !deviceToken) {
    throw new CliError("the space " + spaceName + " has no gateway credentials");
  }
  const creds: FleetCredentials = { gateway, deviceId, deviceToken, timeoutMs: 120_000 };
  const paths: MemberPaths = {
    work,
    gitDir: fleetStateDir(configPath, fleetId, spaceName),
    keyFile: fleetKeyFile(configPath, fleetId, spaceName),
  };
  const role = await fetchRole(creds, fleetId);
  if (!role.member) throw new CliError("this device is not a member of the fleet " + fleetId);

  const state = readFleetState(configPath, fleetId, spaceName);

  // Take a place in the fleet first. The lease is short-lived, so a member
  // that has not spoken for a while has to take it again before it may write.
  const placed = await bootstrap(creds, fleetId);
  if (placed.primary) {
    // A snapshot is taken every round: it is what says whether there is
    // anything to publish at all.
    const snap = await snapshot({ work: paths.work, gitDir: paths.gitDir, base: state.base ?? null, seq: state.seq ?? 0 });

    // Nothing changed in the workspace and nobody joined: publishing the
    // same tree again would cost a pack and a write for nothing. But a
    // member that has just joined needs a snapshot sealed for it, so the
    // membership is part of the question.
    // The roster is part of the question: a member that joined, or that came
    // back with a new key, needs a snapshot sealed for it.
    const members = await fetchMemberKeys(creds, fleetId);
    const roster = members.map((m) => m.deviceId + ":" + (m.pubkey ?? "").slice(0, 12)).join(",");
    if (state.tree !== undefined && !force) {
      if (roster === (state.roster ?? "") && snap.tree === state.tree) {
        return "unchanged";
      }
    }

    const result = await publish(
      creds,
      fleetId,
      paths,
      state.base ?? null,
      state.seq ?? 0,
      state.manifest,
      state.memberCount ?? 0,
    );
    writeFleetState(configPath, fleetId, spaceName, {
      ...state,
      base: result.commit,
      seq: result.seq,
      manifest: result.manifestKey,
      memberCount: result.members,
      roster,
      // Remember the tree, so the next round knows there is nothing to do.
      tree: snap.tree,
    });
    return "published " + result.seq;
  }

  const pulled = await pull(creds, fleetId, paths, state.seq ?? 0);
  if (pulled.applied) {
    writeFleetState(configPath, fleetId, spaceName, { ...state, seq: pulled.seq, base: pulled.commit });
    return "applied " + pulled.seq;
  }
  return "up to date";
}

/**
 * Keep a space in step with its fleet.
 *
 * With --watch it keeps going: it takes its place in the fleet, publishes
 * when it is the primary and pulls when it is a replica, until it is asked to
 * stop. A round that fails is reported and the next one is tried, because a
 * network that blinks is not a reason to give up on the fleet.
 */
export async function fleetsSync(ctx: Ctx): Promise<void> {
  const fleetId = requireFleetId(ctx.parsed.positionals[2] ?? "");
  const spaceName = spaceArg(ctx);
  if (!spaceName) {
    throw new UsageError("missing --space", "Name the space that belongs to the fleet.");
  }
  const space = ctx.config.spaces[spaceName];
  if (!space) throw new UsageError("unknown space \"" + spaceName + "\"", "Run 'prime spaces list' to see the spaces.");
  if (!space.fleet) throw new UsageError("the space \"" + spaceName + "\" is not in a fleet", "Create it with 'prime spaces create --fleet <id>'.");

  const work = space.work_dir;
  if (!work) throw new UsageError("the space has no work directory yet", "Start the space first.");
  const t = target(ctx, spaceName);
  if (!t.device || !t.deviceToken) {
    throw new UsageError("no device credentials for this space", "The space must be exposed to the gateway to take part in a fleet.");
  }
  if (!t.device || !t.deviceToken) {
    throw new UsageError("no device credentials for this space", "The space must be exposed to the gateway to take part in a fleet.");
  }

  const watch = bool(ctx.parsed, "watch");
  if (!watch) {
    const what = await syncFleetSpace(ctx.configPath, fleetId, spaceName, space, bool(ctx.parsed, "force"));
    if (ctx.json) {
      printJson({ fleet: fleetId, space: spaceName, result: what });
      return;
    }
    ctx.out(what);
    return;
  }

  // Keep going until asked to stop.
  const intervalMs = Math.max(1, num(ctx.parsed, "interval") ?? 15) * 1000;
  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  ctx.note(dim("watching " + fleetId + " for " + spaceName + ", every " + Math.round(intervalMs / 1000) + "s; press ctrl-c to stop"));
  while (!stopping) {
    try {
      const what = await syncFleetSpace(ctx.configPath, fleetId, spaceName, space, bool(ctx.parsed, "force"));
      if (what !== "unchanged" && what !== "up to date") ctx.note(green(what));
    } catch (err) {
      ctx.note(yellow("round failed: " + (err instanceof Error ? err.message : String(err))));
    }
    // Wait, but wake early if the agent is asked to stop.
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      const onStop = (): void => {
        clearTimeout(timer);
        resolve(undefined);
      };
      process.once("SIGINT", onStop);
      process.once("SIGTERM", onStop);
    });
  }
  ctx.note(dim("stopped"));
}
/**
 * Take a place in the fleet.
 *
 * The lease is short-lived: a member that has not spoken for a while has to
 * take it again before it may write. The fleet decides whether it can.
 */
export async function bootstrap(creds: FleetCredentials, fleet: string): Promise<{ primary: boolean; catchUpTo?: number }> {
  const res = await fetch(creds.gateway + "/fleets/" + encodeURIComponent(fleet) + "/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-prime-device": creds.deviceId, "x-device-token": creds.deviceToken },
    body: "{}",
    signal: AbortSignal.timeout(creds.timeoutMs ?? 120_000),
  });
  if (!res.ok) throw new CliError("could not take a place in the fleet: " + res.status);
  const body = (await res.json()) as { role?: string; catchUpTo?: number };
  return { primary: body.role === "primary", ...(body.catchUpTo !== undefined ? { catchUpTo: body.catchUpTo } : {}) };
}

/** Where a member keeps its own state for a fleet, under prime's directory. */
export function fleetStateDir(configPath: string, fleetId: string, spaceName: string): string {
  const dir = join(dirname(configPath), "fleets", fleetId, spaceName);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Where a member keeps the key that opens the snapshots sealed for it. */
export function fleetKeyFile(configPath: string, fleetId: string, spaceName: string): string {
  const dir = join(dirname(configPath), "fleets", fleetId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, spaceName + ".key");
}

export interface FleetMemberState {
  /** The sequence this member last published or applied. */
  seq?: number;
  /** The commit this member's store last held. */
  base?: string;
  /** Where the manifest of that snapshot is stored: the next one names it. */
  manifest?: string;
  /** How many members the last publish sealed for. */
  memberCount?: number;
  /** The members and their keys, so a member that changed is sealed again. */
  roster?: string;
  /** The tree of the last publish, so an unchanged workspace is not published again. */
  tree?: string;
}

/** The member's own record of how far it has got. */
export function readFleetState(configPath: string, fleetId: string, spaceName: string): FleetMemberState {
  const file = join(fleetStateDir(configPath, fleetId, spaceName), "state.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as FleetMemberState;
  } catch {
    return {};
  }
}

export function writeFleetState(configPath: string, fleetId: string, spaceName: string, state: FleetMemberState): void {
  const file = join(fleetStateDir(configPath, fleetId, spaceName), "state.json");
  writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
}
