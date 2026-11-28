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
//   1. --gateway / --operator-token (operator) and --device / --token (member)
//   2. the config file's defaults (`fleet_operator_token`) and device entries
//   3. PRIME_GATEWAY_URL / PRIME_FLEET_OPERATOR_TOKEN / PRIME_DEVICE_TOKEN
//
// The operator's credential is the gateway's FLEET_OPERATOR_TOKEN. It is not the gateway token: that one
// is what every machine and client of the gateway holds, and it does not run fleets.

import { createHash } from "node:crypto";
import { bool, num, str } from "./args.ts";
import type { Config, SpaceEntry } from "./config.ts";
import type { Ctx } from "./context.ts";
import { CliError, UsageError } from "./errors.ts";
import { bold, dim, green, printJson, table, yellow } from "./output.ts";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadOrCreateKeyPair, loadOrCreateSignKey, previousKeyPair, pull, publish, rosterOf, rotateKeyPair, withChain, type MemberPaths, type Position, type SinceWhole } from "./fleet-agent.ts";
import { positions } from "./fleet-replica.ts";
import { keyFingerprintOf } from "./fleet-crypto.ts";
import { FleetTrust } from "./fleet-trust.ts";
import {
  RosterError,
  checkSigned,
  createOwnerKeyFile,
  entryHash,
  fleetKeyOf,
  inviteWithOwner,
  isFingerprint,
  normalizeFingerprint,
  liveMembers,
  makeEntry,
  ownerFingerprint,
  parseInviteCode,
  readOwnerKey,
  signEntry,
  verifyChain,
  type OwnerKey,
  type RosterEntry,
  type SignedEntry,
  type VerifiedRoster,
} from "./fleet-roster.ts";
import { preserveLocalChange, snapshot, withApplyLock } from "./fleet-sync.ts";
import { capsBody, fetchMemberKeys, fetchRole, plainText, reportApplied, type FleetCredentials } from "./fleet-transport.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { keyIdOf, loadOrCreateCallerKey, parsePublicKey } from "./caller-key.ts";
import { withDirLockSync, type HeldLock } from "./dir-lock.ts";
import { fleetAgentServiceStatus } from "./fleet-service.ts";
import { ensureFleetAgent, fleetAgentStatus, installFleetAgent, resetAgentSettings, stopFleetAgentManaged, uninstallFleetAgent } from "./fleet-daemon.ts";
import { DEFAULT_GATEWAY, ENV, normalizeGateway } from "./target.ts";
import { pinFleetOwner, unpinFleetOwner } from "./fleet-reply-trust.ts";
import { accessToken, defaultAccessRunner, type AccessRunner } from "./access-login.ts";

/** How the Access token is fetched; tests replace it. */
let accessRunner: AccessRunner = defaultAccessRunner;
export function useAccessRunner(run: AccessRunner | undefined): void {
  accessRunner = run ?? defaultAccessRunner;
}

import { readAllow, secretGateMode, writeAllow } from "./fleet-secrets.ts";

const FLEET_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface FleetTarget {
  gateway: string;
  /** The gateway's fleet operator credential; absent for member-only calls. */
  operatorToken?: string;
  /** Device id this call speaks as. */
  device?: string;
  /** Device token this call speaks as. */
  deviceToken?: string;
  timeoutMs: number;
  /** Speak as the person Cloudflare Access knows (`--sso`): the call carries their Access token, not the operator token. */
  sso?: boolean;
}

export interface FleetTargetFlags {
  gateway?: string;
  operatorToken?: string;
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
  // The credential of the device that was picked, so a command that named no
  // space still has something to speak with.
  const deviceToken = flags.token ?? space?.remote_token ?? space?.token ?? (device ? config.devices[device]?.token : undefined);
  const gateway = normalizeGateway(flags.gateway ?? space?.gateway ?? config.defaults.gateway ?? env[ENV.gateway] ?? DEFAULT_GATEWAY);
  // The operator's credential from the environment or the config goes to the gateway that is configured as this
  // machine's own, and to no other: a space may point at another one, and that gateway is not owed it. One passed
  // on the command line goes where the command goes.
  const ownGateway = normalizeGateway(config.defaults.gateway ?? env[ENV.gateway] ?? DEFAULT_GATEWAY);
  const operatorToken = flags.operatorToken ?? (gateway === ownGateway ? env[ENV.fleetOperatorToken] ?? config.defaults.fleet_operator_token : undefined);
  const timeoutMs = flags.timeout ?? config.defaults.timeout_ms ?? 300_000;
  return { gateway, operatorToken, device, deviceToken, timeoutMs };
}

export interface FleetMember {
  deviceId: string;
  role: "owner" | "member";
  addedAt: number;
  addedBy?: string;
  /** The key snapshots are sealed for, as the member offered it. */
  pubkey?: string;
}

/**
 * The roster as `prime fleets members` prints it. The KEY column is a fingerprint of the member's
 * public key: a gateway that swaps a member's key for its own keeps the device and changes only
 * this, so it is the one place the swap shows. Compare it with what the member itself reports
 * (`prime fleets members` on that device) by another way than through the gateway.
 */
export function memberRows(members: FleetMember[]): string[][] {
  return members.map((m) => [m.deviceId, m.role, m.pubkey ? keyFingerprintOf(m.pubkey) : "-", new Date(m.addedAt).toISOString()]);
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
  // With --sso the call is the person's: their Access token says who, and the shared operator token is left out.
  if (target.sso) headers["cf-access-token"] = await accessToken(target.gateway, accessRunner);
  else if (target.operatorToken) headers["authorization"] = "Bearer " + target.operatorToken;
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
  throw new CliError(what + ": " + message, typeof json?.hint === "string" ? json.hint : undefined);
}

function target(ctx: Ctx, spaceName?: string): FleetTarget {
  const t = resolveFleetTarget(
    ctx.config,
    {
      gateway: str(ctx.parsed, "gateway"),
      operatorToken: str(ctx.parsed, "operator-token"),
      device: str(ctx.parsed, "device"),
      token: str(ctx.parsed, "token"),
      timeout: ctx.parsed.flags.has("timeout") ? Number(ctx.parsed.flags.get("timeout")) : undefined,
    },
    spaceName,
  );
  const sso = bool(ctx.parsed, "sso") || process.env.PRIME_FLEET_SSO === "1";
  if (sso) return { ...t, sso: true };
  // A fleet command speaks for a device. Without its credential the gateway
  // cannot tell who is asking, and the answer would be a bare
  // "unauthorized" that says nothing about what to do.
  if (!t.operatorToken && !t.deviceToken) {
    throw new CliError(
      "no credential to speak with",
      "Name the device this command is about: --space <name>, or --device <id> --token <token>. The operator's own credential is the gateway's FLEET_OPERATOR_TOKEN: --operator-token, or PRIME_FLEET_OPERATOR_TOKEN.",
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

/**
 * The fleets this machine knows, and what the gateway says about them.
 *
 * Every other fleet command speaks about one fleet; this one answers the
 * question they all leave open: which fleets are there? It reads them from
 * the configuration - the spaces that are in one - and asks the gateway for
 * the standing of each.
 */
export async function fleetsList(ctx: Ctx): Promise<void> {
  // Which spaces of this machine are in which fleet.
  const local = new Map<string, string[]>();
  for (const [name, space] of Object.entries(ctx.config.spaces)) {
    if (!space.fleet) continue;
    const spaces = local.get(space.fleet) ?? [];
    spaces.push(name);
    local.set(space.fleet, spaces);
  }
  const t = target(ctx, spaceArg(ctx));

  // The operator sees every fleet on the gateway, not only the ones this
  // machine has a space in.
  const remote = new Set<string>();
  if (t.operatorToken) {
    const listed = await call(t, "GET", "/fleets", undefined);
    if (listed.status === 200) {
      for (const id of (listed.json?.fleets ?? []) as string[]) remote.add(id);
    }
  }

  const ids = [...new Set([...local.keys(), ...remote])].sort();
  if (ids.length === 0) {
    ctx.out(dim("no fleets here"));
    ctx.out(dim("a space joins one with 'prime spaces create --fleet <fleet> --code <code>'"));
    return;
  }

  const rows: string[][] = [];
  for (const fleet of ids) {
    const spaces = local.get(fleet) ?? [];
    const member = spaces.find((name) => ctx.config.spaces[name]?.gateway_device && ctx.config.spaces[name]?.remote_token);
    // Without a space of this machine in the fleet there is nothing to ask
    // with, so the answer stays unknown.
    let standing = "-";
    let members = "-";
    if (member) {
      const space = ctx.config.spaces[member]!;
      // This machine's own space speaks for the fleet: it is a member.
      const as: FleetTarget = {
        gateway: t.gateway,
        ...(t.operatorToken ? { operatorToken: t.operatorToken } : {}),
        device: space.gateway_device!,
        deviceToken: space.remote_token!,
        timeoutMs: t.timeoutMs,
      };
      const me = await call(as, "GET", "/fleets/" + encodeURIComponent(fleet) + "/me", undefined);
      standing = me.json?.status ?? String(me.status);
      // This space's own role in the fleet, not the fleet's owner.
      if (me.json?.member?.role === "owner") standing += " (owner)";
      const roster = await call(as, "GET", "/fleets/" + encodeURIComponent(fleet) + "/members", undefined);
      if (roster.status === 200) members = String((roster.json?.members ?? []).length);
    }
    rows.push([fleet, spaces.length > 0 ? spaces.join(", ") : "-", standing, members]);
  }

  if (ctx.json) {
    printJson({ fleets: ids.map((id) => ({ fleet: id, spaces: local.get(id) ?? [], remote: remote.has(id) })) });
    return;
  }
  ctx.out(table(["FLEET", "SPACES HERE", "THIS DEVICE", "MEMBERS"], rows));
  if (local.size === 0) ctx.out(dim("this machine has no space in a fleet"));
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

/**
 * A lease as a person writes it: `90s`, `2m`, `1500ms`, or a bare number of seconds; `default` for none (the gateway's
 * own, null on the wire). Anything else is refused here, so that "90" is never taken for milliseconds.
 */
export function parseLease(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (t === "default") return null;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/.exec(t);
  if (!m) throw new UsageError("not a time: \"" + text + "\"", "Write it as 90s, 2m, 90000ms or a number of seconds, or \"default\".");
  const n = Number(m[1]);
  const ms = Math.round(m[2] === "ms" ? n : m[2] === "m" ? n * 60_000 : n * 1000);
  if (!Number.isFinite(ms) || ms <= 0) throw new UsageError("not a time: \"" + text + "\"", "A lease is longer than nothing.");
  return ms;
}

/**
 * `prime fleets set <fleet-id> --lease 90s`: how long a place in the fleet lasts. The operator's (or the fleet owner's)
 * to say, within the gateway's bounds; every member takes the new length at once, and renews at a third of it. A longer
 * lease costs the fleet fewer renewals and takes longer to hand over when the primary is gone.
 */
export async function fleetsSet(ctx: Ctx): Promise<void> {
  const fleetId = requireFleetId(ctx.parsed.positionals[2] ?? "");
  const asked = str(ctx.parsed, "lease");
  if (asked === undefined) throw new UsageError("nothing to set", "What can be set: --lease <time>  (30s to 180s, or \"default\").");
  const leaseMs = parseLease(asked);
  const t = target(ctx, spaceArg(ctx));
  const res = await call(t, "POST", "/fleets/" + encodeURIComponent(fleetId) + "/meta", { leaseMs });
  failOn(res.status, res.json, "could not set the lease");
  const now = typeof res.json?.leaseMs === "number" ? res.json.leaseMs : leaseMs;
  if (ctx.json) {
    printJson({ fleet: fleetId, leaseMs: now });
    return;
  }
  ctx.out(green("the lease of ") + bold(fleetId) + green(" is " + (now === null ? "the gateway's own" : now / 1000 + " s")) + (typeof now === "number" ? dim("  (the primary renews every " + Math.round(now / 3000) + " s)") : ""));
}

export async function fleetsInvite(ctx: Ctx): Promise<void> {
  const fleetId = requireFleetId(ctx.parsed.positionals[2] ?? "");
  const t = target(ctx, spaceArg(ctx));
  const ttlMs = ctx.parsed.flags.has("ttl") ? Number(ctx.parsed.flags.get("ttl")) : undefined;
  const res = await call(t, "POST", "/fleets/" + encodeURIComponent(fleetId) + "/invite", { ttlMs });
  failOn(res.status, res.json, "could not mint an invite");
  const invite = res.json as FleetInvite;
  // The operator that holds this fleet's owner key hands out its fingerprint with the code, so a new member
  // pins the key it is told of by the operator and not by whatever the gateway says later.
  let owner: OwnerKey | undefined;
  let notSigned = false;
  try {
    owner = ownerKeyIfAny(ctx, fleetId, t.gateway);
    // A member that pins an owner key refuses a roster that is not signed, so the key goes with the code only once it is.
    if (owner && (await getRosterState(t, fleetId)).mode !== "signed") {
      owner = undefined;
      notSigned = true;
    }
  } catch (err) {
    // A key file that is there and is not a key does not stop an invite: it is printed as the gateway made it, with the reason.
    ctx.out(yellow("the owner key file could not be read, so the code is printed without the key's fingerprint: ") + (err instanceof Error ? err.message : String(err)));
  }
  if (ctx.json) {
    printJson({ fleet: fleetId, invite, ...(owner ? { ownerFingerprint: ownerFingerprint(owner.publicKey), inviteWithOwner: inviteWithOwner(invite.code, owner.publicKey) } : {}) });
    return;
  }
  ctx.out(yellow("invite code (single use, expires in " + Math.round((invite.expiresAt - Date.now()) / 1000) + "s)"));
  ctx.out("  " + bold(invite.code));
  ctx.out(dim("the device that presents this code still waits for the operator to admit it"));
  if (notSigned) {
    ctx.out("");
    ctx.out(yellow("the roster of " + fleetId + " is not signed yet, so this code does not carry the owner key") + dim(": a member that pinned it would refuse the roster until it is signed. After 'prime fleets roster init " + fleetId + "', run 'prime fleets invite' again, or 'prime fleets trust pin' on each member."));
  }
  if (owner) {
    ctx.out("");
    ctx.out("owner key " + bold(ownerFingerprint(owner.publicKey)) + dim("  (the key that signs this fleet's roster)"));
    ctx.out("give the joining machine this, so it pins that key:");
    ctx.out("  " + bold(inviteWithOwner(invite.code, owner.publicKey)));
  }
}

export async function fleetsJoin(ctx: Ctx): Promise<void> {
  const fleetId = requireFleetId(ctx.parsed.positionals[2] ?? "");
  const given = str(ctx.parsed, "code");
  if (!given) throw new UsageError("missing --code", "Run 'prime fleets invite <fleet>' on the operator's machine and pass the code it prints.");
  // The code may carry the fingerprint of the fleet's owner key after a "~": it is pinned, and never sent to the gateway.
  const { code, ownerFp } = parseInvite(given);
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
  // Joining again as a member is not a new membership: what it has learnt of the fleet stays.
  const before = await call(t, "GET", "/fleets/" + encodeURIComponent(fleetId) + "/me");
  const wasMember = before.status === 200 && before.json?.status === "member";
  // A member that pinned another owner key does not take an invite that names a different one as if it had not.
  if (ownerFp !== undefined && wasMember) refuseOtherPin(keyFile, ownerFp);
  const res = await call(t, "POST", "/fleets/" + encodeURIComponent(fleetId) + "/join", {
    code,
    ...(label ? { label } : {}),
    pubkey: keys.publicKey,
    spub: loadOrCreateSignKey(keyFile).publicKey,
  });
  failOn(res.status, res.json, "could not join the fleet");
  // A new membership starts knowing nothing of the fleet: what an earlier one under this name left
  // beside the key is not this fleet's. Only once it has been made: a join that failed changes nothing.
  if (!wasMember) FleetTrust.forget(keyFile);
  if (ownerFp !== undefined) FleetTrust.pinOwner(keyFile, ownerFp);
  // (Which fleet of this name it is, is learnt when the space is set up, once the member is in: a first
  // join always waits for the operator, so there is nothing to learn from the gateway here.)
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

/**
 * Whether the gateway refused a new member's add for its place in the sequence, which signing it again at the head puts right. A gateway that
 * says so with a code (`head-moved`) is believed by the code; one from before it said only a sentence, and that is read as it was.
 */
function headMoved(json: Record<string, unknown> | undefined): boolean {
  if (json?.code === "head-moved") return true;
  if (typeof json?.code === "string") return false;
  return /head is at|was snapshot \d+/i.test(String(json?.error ?? ""));
}

export async function fleetsApprove(ctx: Ctx): Promise<void> {
  const fleetId = requireFleetId(ctx.parsed.positionals[2] ?? "");
  const deviceId = str(ctx.parsed, "member");
  if (!deviceId) throw new UsageError("missing --member", "The device id of the request to approve, as shown by 'prime fleets pending <fleet>'.");
  const t = target(ctx, spaceArg(ctx));
  // A member that asks to replace its key is approved for the key that was read in the list: `--key` names it
  // (the KEY column of `prime fleets pending`, to compare with what the member's own machine prints), so that
  // a request that was replaced since is not approved by mistake.
  const key = str(ctx.parsed, "key");
  const res = await call(t, "POST", "/fleets/" + encodeURIComponent(fleetId) + "/approve", { deviceId, ...(key ? { key } : {}) });
  // A fleet whose roster is signed takes an approval only as an entry the owner key signed.
  if (res.status === 409 && res.json?.rosterSigned === true) return approveSigned(ctx, t, fleetId, deviceId, key);
  failOn(res.status, res.json, "could not approve the request");
  if (ctx.json) {
    printJson({ fleet: fleetId, member: res.json.member, ...(res.json.keyChanged ? { keyChanged: true } : {}) });
    return;
  }
  ctx.out(green(res.json.keyChanged ? "replaced the key of" : "approved") + " " + deviceId);
}

/**
 * Take a new key pair for a space, and show the fleet that it is the space's own.
 *
 * The old pair is kept beside the new one until the fleet has taken it: the agent's next ask for its place
 * carries a proof made with the old key (the fleet checks it; nobody has to approve), and the old pair is then
 * dropped. A space that lost its key has no such proof: its new key waits for the operator.
 */
export async function fleetsRotateKey(ctx: Ctx): Promise<void> {
  const fleetId = requireFleetId(ctx.parsed.positionals[2] ?? "");
  const spaceName = spaceArg(ctx);
  if (!spaceName) throw new UsageError("missing --space", "Name the space whose key is replaced.");
  const space = ctx.config.spaces[spaceName];
  if (!space) throw new UsageError("unknown space \"" + spaceName + "\"", "Run 'prime spaces list' to see the spaces.");
  if (space.fleet !== fleetId) throw new UsageError("the space \"" + spaceName + "\" is not in the fleet " + fleetId);
  const keyFile = fleetKeyFile(ctx.configPath, fleetId, spaceName);
  if (previousKeyPair(keyFile)) {
    throw new CliError("the last rotation has not reached the fleet yet", "The agent hands it over on its next round: 'prime fleets agent status' shows it. Wait for that before rotating again.");
  }
  const pair = rotateKeyPair(keyFile);
  if (ctx.json) {
    printJson({ fleet: fleetId, space: spaceName, key: keyFingerprintOf(pair.publicKey) });
    return;
  }
  ctx.out(green("new key for ") + bold(spaceName) + dim("  " + keyFingerprintOf(pair.publicKey)));
  ctx.out(dim("  the agent shows the fleet it is the space's own on its next round; the KEY column of 'prime fleets members' then changes"));
}

export async function fleetsPending(ctx: Ctx): Promise<void> {
  const fleetId = requireFleetId(ctx.parsed.positionals[2] ?? "");
  const t = target(ctx, spaceArg(ctx));
  const res = await call(t, "GET", "/fleets/" + encodeURIComponent(fleetId) + "/pending");
  failOn(res.status, res.json, "could not list the requests");
  const pending = (res.json.pending ?? []) as Array<{ deviceId: string; label?: string; requestedAt: number; pubkey?: string; keyChange?: boolean }>;
  if (ctx.json) {
    printJson({ fleet: fleetId, pending });
    return;
  }
  if (pending.length === 0) {
    ctx.out(dim("no requests waiting"));
    return;
  }
  // The KEY of a request is the fingerprint of the key it offers: for a member that asks to replace its key it is
  // what `prime fleets approve --key` takes, and the one to compare with the member's own machine.
  ctx.out(table(["DEVICE", "LABEL", "REQUESTED", "REQUEST", "KEY"], [
    ...pending.map((p) => [p.deviceId, p.label ?? "-", new Date(p.requestedAt).toISOString(), p.keyChange ? "new key" : "join", p.pubkey ? keyFingerprintOf(p.pubkey) : "-"]),
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
  ctx.out(table(["DEVICE", "ROLE", "KEY", "ADDED"], memberRows(members)));
  for (const line of ownKeyLines(ctx, fleetId, t)) ctx.out(line);
}

/**
 * What this machine itself says of its own keys, from its own key file (not from the gateway): the fingerprints an operator compares
 * with what the gateway lists before signing them into a roster (`prime fleets roster init`, `approve --key`).
 */
function ownKeyLines(ctx: Ctx, fleetId: string, t: FleetTarget): string[] {
  const space = spaceArg(ctx) ?? (t.device ? spaceOfDevice(ctx.config, t.device) : undefined);
  if (!space) return [];
  const keyFile = fleetKeyFile(ctx.configPath, fleetId, space);
  if (!existsSync(keyFile)) return [];
  const pair = loadOrCreateKeyPair(keyFile);
  const sign = loadOrCreateSignKey(keyFile);
  return ["", bold("this machine (" + space + ")") + "  key " + keyFingerprintOf(pair.publicKey) + "  signing key " + ownerFingerprint(sign.publicKey)];
}

export async function fleetsRemove(ctx: Ctx): Promise<void> {
  const fleetId = requireFleetId(ctx.parsed.positionals[2] ?? "");
  const deviceId = str(ctx.parsed, "member");
  if (!deviceId) throw new UsageError("missing --member", "The device id to remove.");
  const t = target(ctx, spaceArg(ctx));
  // `--key-change` declines a member's request for another key and keeps the member.
  const keyChange = bool(ctx.parsed, "key-change");
  const res = await call(t, "POST", "/fleets/" + encodeURIComponent(fleetId) + "/remove", { deviceId, ...(keyChange ? { keyChange: true } : {}) });
  if (res.status === 409 && res.json?.rosterSigned === true) return removeSigned(ctx, t, fleetId, deviceId);
  failOn(res.status, res.json, keyChange ? "could not decline the new key" : "could not remove the member");
  if (ctx.json) {
    printJson({ fleet: fleetId, ...(keyChange ? { declined: deviceId } : { removed: res.json.removed }) });
    return;
  }
  ctx.out(keyChange ? green("declined the new key of") + " " + deviceId + dim("  (it stays a member, with the key it had)") : green("removed") + " " + deviceId + " from " + fleetId);
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
  // The agent holds the fleet's lease while it runs, so it has to outlive the
  // terminal that started it: a login service, not a background process.
  if (what === "install") {
    // Settings are saved for the service, and an agent that is running is stopped before it starts.
    const where = await installFleetAgent(ctx.configPath);
    if (ctx.json) {
      printJson({ installed: true, where });
      return;
    }
    ctx.out(green("installed the fleet agent as a service"));
    ctx.out(dim("  " + where));
    ctx.out(dim("  it starts at login, and comes back if it stops"));
    return;
  }
  if (what === "uninstall") {
    const had = uninstallFleetAgent(ctx.configPath, { force: bool(ctx.parsed, "force") });
    if (ctx.json) {
      printJson({ removed: had });
      return;
    }
    ctx.out(had ? green("removed the fleet agent service") : dim("the fleet agent was not installed as a service"));
    return;
  }
  if (what === "stop") {
    const { stopped, via, restarts, serviceStopped } = await stopFleetAgentManaged(ctx.configPath);
    if (ctx.json) {
      printJson({ stopped, via, ...(restarts ? { restarts: true } : {}), ...(serviceStopped ? { service_stopped: true } : {}) });
      return;
    }
    if (!stopped) {
      ctx.out(serviceStopped ? green("the fleet agent was not running; its service, which would have started one, is stopped") : dim("the fleet agent was not running"));
      if (serviceStopped) ctx.out(dim("  'prime fleets agent start' starts it again"));
      return;
    }
    ctx.out(green("stopped the fleet agent"));
    if (via === "service") ctx.out(dim("  its service is stopped with it, and stays stopped until 'prime fleets agent start' (or the next login on macOS, the next start of the user manager on Linux)"));
    if (serviceStopped) ctx.out(dim("  the service was running beside it, and is stopped too; 'prime fleets agent start' starts it again"));
    if (restarts) ctx.out(yellow("  its service's manager would not stop the service, so the manager starts another: 'prime fleets agent uninstall' removes the service"));
    return;
  }
  if (what === "reset") {
    // Forget the saved settings (mode, cache size, timings): a running agent is restarted with the defaults.
    resetAgentSettings(ctx.configPath);
    const running = fleetAgentStatus(ctx.configPath).running;
    if (running) await ensureFleetAgent(ctx.configPath);
    if (ctx.json) {
      printJson({ reset: true, restarted: running });
      return;
    }
    ctx.out(green("the fleet agent's settings are back to their defaults") + (running ? dim(" (restarted)") : ""));
    return;
  }
  if (what === "start") {
    // `start` is the person speaking: what their shell sets is what they ask for, and is remembered.
    const state = await ensureFleetAgent(ctx.configPath, { fromShell: true });
    if (ctx.json) {
      printJson({ started: true, pid: state.pid });
      return;
    }
    ctx.out(green("started the fleet agent") + " (pid " + state.pid + ")");
    return;
  }
  const status = fleetAgentStatus(ctx.configPath);
  const service = fleetAgentServiceStatus(ctx.configPath);
  if (ctx.json) {
    printJson({
      ...status,
      service: { installed: service.installed, where: service.where, ...(service.config ? { config: service.config } : {}), ...(service.detail ? { detail: service.detail } : {}) },
    });
    return;
  }
  // The one service on the machine runs one configuration; for another it is not this one's.
  const elsewhere = !service.installed && service.config !== undefined;
  const notInstalled = elsewhere
    ? "the service on this machine runs " + service.config + ", not this configuration (one per machine)"
    : "not installed as a service: run 'prime fleets agent install'";
  if (!status.running) {
    ctx.out(dim("the fleet agent is not running"));
    if (status.successor) ctx.out(dim("  a new build (pid " + status.successor + ") is waiting to take over: 'prime fleets agent stop' stops it"));
    if (!service.installed) ctx.out(dim("  " + notInstalled));
    return;
  }
  ctx.out(green("the fleet agent is running") + " (pid " + status.pid + ")");
  if (service.installed) ctx.out(dim("  service   " + service.where + (service.config ? " (runs " + service.config + ")" : "")));
  else if (elsewhere) ctx.out(yellow("  service   " + notInstalled));
  else ctx.out(yellow("  service   not installed: it stops when this machine logs out (run 'prime fleets agent install')"));
  if (status.successor) ctx.out(yellow("  restarting a new build (pid " + status.successor + ") waits for this agent to finish its round and take over"));
  ctx.out(dim("  started   " + (status.started_at ?? "-")));
  ctx.out(dim("  spaces    " + (status.spaces ?? 0)));
  ctx.out(dim("  rounds    " + (status.rounds ?? 0)));
  if (status.replica) ctx.out(dim("  replicas  " + (status.replica === "mirror" ? "mirror (work tree follows every snapshot)" : "lazy (fetch ahead, apply when needed)")));
  if (status.updates === "push") ctx.out(dim("  updates   pushed by the gateway"));
  else if (status.updates === "polling") ctx.out(dim("  updates   polling the gateway"));
  if (status.paused) ctx.out(yellow("  paused    the fleet is paused"));
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

/**
 * `prime fleets trust accept <fleet> --space <name> --manifest <hash>`: take one snapshot that carries no seal.
 *
 * A member that has taken in sealed snapshots refuses an unsealed one that follows them (see
 * fleet-trust.ts). When the member that published it was an old build that is now gone, and
 * nobody else can publish, that refusal is all there is between the fleet and a primary. The
 * operator who knows the snapshot is the fleet's own says so here, by the hash the refusal printed:
 * that one manifest is taken, and nothing else is let through by it. A snapshot that lacks a tag or
 * the mark of its fleet has no such way: it was made by someone who cannot make them.
 */
export async function fleetsTrust(ctx: Ctx): Promise<void> {
  const what = ctx.parsed.positionals[2] ?? "";
  if (what === "pin") return fleetsTrustPin(ctx, ctx.parsed.positionals[3] ?? "");
  if (what !== "accept") {
    throw new UsageError(
      "unknown trust command \"" + what + "\"",
      "Usage: prime fleets trust accept <fleet-id> --space <name> --manifest <hash>\n       prime fleets trust pin <fleet-id> --space <name> --owner <fingerprint>",
    );
  }
  const fleetId = requireFleetId(ctx.parsed.positionals[3] ?? "");
  const spaceName = spaceArg(ctx);
  if (!spaceName) throw new UsageError("missing --space", "Name the space that belongs to the fleet.");
  const hash = str(ctx.parsed, "manifest");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) throw new UsageError("missing or malformed --manifest", "The hash of the manifest, as the refusal printed it: 64 hexadecimal characters.");
  const space = ctx.config.spaces[spaceName];
  if (!space) throw new UsageError("unknown space \"" + spaceName + "\"", "Run 'prime spaces list' to see the spaces.");
  if (space.fleet !== fleetId) throw new UsageError("the space \"" + spaceName + "\" is not in the fleet " + fleetId);
  FleetTrust.accept(fleetKeyFile(ctx.configPath, fleetId, spaceName), hash);
  if (ctx.json) {
    printJson({ fleet: fleetId, space: spaceName, accepted: hash });
    return;
  }
  ctx.out(green("this member will take the snapshot whose manifest is " + hash) + dim(" (that one only; nothing else is let through)"));
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
  for (const line of ownKeyLines(ctx, fleetId, t)) ctx.out(line);
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
    recorded: recordedPosition(configPath, fleetId, spaceName),
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
    // Only the tree is wanted here; the ref of a published sequence is
    // left to the publish that makes it.
    const snap = await snapshot({ work: paths.work, gitDir: paths.gitDir, base: state.base ?? null, treeOnly: true });

    // Nothing changed in the workspace and nobody joined: publishing the
    // same tree again would cost a pack and a write for nothing. But a
    // member that has just joined needs a snapshot sealed for it, so the
    // membership is part of the question.
    // The roster is part of the question: a member that joined, or that came
    // back with a new key, needs a snapshot sealed for it.
    const members = await fetchMemberKeys(creds, fleetId);
    const roster = rosterOf(members);
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
      state.memberCount ?? 0,
      state.roster,
      withChain(state),
    );
    writeFleetState(configPath, fleetId, spaceName, {
      ...state,
      base: result.commit,
      seq: result.seq,
      memberCount: result.members,
      roster: result.roster,
      sinceWhole: result.sinceWhole,
      // Remember the tree, so the next round knows there is nothing to do.
      tree: snap.tree,
    });
    return "published " + result.seq;
  }

  // A mirror that was edited locally cannot be updated without losing the
  // edit, so the edit is moved aside first - the same rule the agent follows.
  // (Under the work tree's lock, and against the state as it is now: an apply by the agent that
  // finished since the state was read above is the fleet's own write, not an edit.)
  if (state.tree !== undefined) {
    await withApplyLock(paths.gitDir, async () => {
      const now = readFleetState(configPath, fleetId, spaceName);
      if (now.tree === undefined) return;
      const local = await snapshot({ work, gitDir: paths.gitDir, base: now.base ?? null, treeOnly: true });
      if (local.tree !== now.tree) {
        await preserveLocalChange(work, paths.gitDir, now.tree, { base: now.base ?? null });
      }
    });
  }
  // What a lazy agent has already fetched is used, not downloaded again. The
  // state is recorded when the work tree has the newest snapshot, so a failure
  // leaves a state that still describes it.
  const pulled = await pull(
    creds,
    fleetId,
    paths,
    state.seq ?? 0,
    state.base ?? null,
    (step) => {
      writeFleetState(configPath, fleetId, spaceName, {
        ...state,
        seq: step.seq,
        base: step.commit,
        tree: step.tree,
        fetchedSeq: step.seq,
        fetchedCommit: step.commit,
        fetchedTree: step.tree,
        roster: step.roster ?? "",
        fetchedRoster: step.roster ?? "",
      });
    },
    positions(state).fetched,
  );
  if (pulled.applied) {
    return "applied " + pulled.seq;
  }
  // Nothing to apply, but the fleet may not know that: an earlier report may have
  // been lost, and a member the fleet thinks is behind cannot take the lease.
  if ((state.seq ?? 0) > 0) await reportApplied(creds, fleetId, state.seq ?? 0).catch(() => false);
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
    body: JSON.stringify({ seals: true, ...capsBody() }),
    signal: AbortSignal.timeout(creds.timeoutMs ?? 120_000),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new CliError("could not take a place in the fleet: " + (detail.error ?? res.status));
  }
  const body = (await res.json()) as { role?: string; catchUpTo?: number; reason?: unknown; hint?: unknown };
  // A fleet whose newest snapshot this build cannot read gives no place, and says what to do about it.
  if (body.reason === "upgrade-required") {
    throw new CliError(typeof body.hint === "string" && body.hint.trim() ? plainText(body.hint) : "this fleet's newest snapshot cannot be read by this build: update prime");
  }
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
  /** How many members the last publish sealed for. */
  memberCount?: number;
  /** The members and their keys, so a member that changed is sealed again. */
  roster?: string;
  /** The tree of the last publish, so an unchanged workspace is not published again. */
  tree?: string;
  /** How the chain of deltas since the last whole tree stood after the last publish (see `SinceWhole`). */
  sinceWhole?: SinceWhole;
  /**
   * A replica that fetches ahead keeps what it has downloaded but not written out:
   * the newest snapshot in its store. Never behind `seq`; see fleet-replica.ts.
   */
  fetchedSeq?: number;
  fetchedCommit?: string;
  fetchedTree?: string;
  fetchedRoster?: string;
}

/** Where the member's state file says its work tree is, read when asked (see `MemberPaths.recorded`). */
export function recordedPosition(configPath: string, fleetId: string, spaceName: string): () => Position {
  return () => positions(readFleetState(configPath, fleetId, spaceName)).applied;
}

// What a publish that went through said of this member's position, when the state file could not be written (its lock
// was busy), in a file of its own that needs no lock: it is made by writing a new file and moving it into place, and
// it is read as part of the state until the state file says as much (see `readFleetState`). Without it a restart in
// between would find the fleet's head ahead of the state, take its own snapshot for another member's and pull it over
// what the person has changed since.
const PUBLISHED_FILE = "published.json";
const POSITION_KEYS = ["seq", "base", "tree", "roster", "memberCount"] as const;

/** Keep the position a publish returned, where a reader of the state finds it (no lock needed). */
export function recordPublished(configPath: string, fleetId: string, spaceName: string, position: FleetMemberState): void {
  const picked: FleetMemberState = {};
  for (const key of POSITION_KEYS) if (position[key] !== undefined) (picked as Record<string, unknown>)[key] = position[key];
  const dir = fleetStateDir(configPath, fleetId, spaceName);
  writeFileAtomic(join(dir, PUBLISHED_FILE), JSON.stringify(picked), 0o600, { durable: true });
}

function readPublished(dir: string): FleetMemberState | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(dir, PUBLISHED_FILE), "utf8")) as FleetMemberState;
    return typeof raw.seq === "number" ? raw : undefined;
  } catch {
    return undefined;
  }
}

// Taken away only by a writer that has just written a position at or past the note's, and only under the lock: a writer
// that read the state before the note was made has an older position, and must leave the note for the next to write.
function dropPublishedCoveredBy(dir: string, written: FleetMemberState): void {
  const file = join(dir, PUBLISHED_FILE);
  if (!existsSync(file)) return;
  const note = readPublished(dir);
  if (note !== undefined && note.seq! > (written.seq ?? 0)) return;
  rmSync(file, { force: true });
}

/** Whether a position that a publish returned is waiting to be written into the state file. */
export function hasUnwrittenPosition(configPath: string, fleetId: string, spaceName: string): boolean {
  return existsSync(join(fleetStateDir(configPath, fleetId, spaceName), PUBLISHED_FILE));
}

/** The member's own record of how far it has got. */
export function readFleetState(configPath: string, fleetId: string, spaceName: string): FleetMemberState {
  const dir = fleetStateDir(configPath, fleetId, spaceName);
  const file = join(dir, "state.json");
  let state: FleetMemberState = {};
  try {
    if (existsSync(file)) state = JSON.parse(readFileSync(file, "utf8")) as FleetMemberState;
  } catch {
    state = {};
  }
  // A publish that was not written down yet is where the member is, when it is ahead of what the file says.
  const published = readPublished(dir);
  return published && published.seq! > (state.seq ?? 0) ? { ...state, ...published } : state;
}

/**
 * The state two writers meant, as one that never goes back.
 *
 * The agent and `prime fleets sync` both read the state, work for a while (a publish, a
 * download) and write it back, so a writer's copy may be older than what the other has
 * recorded since. Both positions only ever move forward: the work tree's (`seq`, `base`, `tree`
 * and what goes with them) and what the store holds (`fetched*`), so each group of `next` that is
 * behind what is on disk is replaced by the one on disk.
 */
export function mergeFleetState(disk: FleetMemberState, next: FleetMemberState): FleetMemberState {
  const out: FleetMemberState = { ...next };
  if ((disk.seq ?? 0) > (next.seq ?? 0)) {
    for (const key of ["seq", "base", "tree", "roster", "memberCount", "sinceWhole"] as const) {
      if (disk[key] === undefined) delete out[key];
      else (out as Record<string, unknown>)[key] = disk[key];
    }
  }
  const floor = Math.max(out.fetchedSeq ?? 0, out.seq ?? 0);
  if ((disk.fetchedSeq ?? 0) > floor) {
    for (const key of ["fetchedSeq", "fetchedCommit", "fetchedTree", "fetchedRoster"] as const) {
      if (disk[key] === undefined) delete out[key];
      else (out as Record<string, unknown>)[key] = disk[key];
    }
  }
  return out;
}

// Take the lock on a state directory for the length of one read-and-write (a few milliseconds). The
// lock says whose it is (see dir-lock.ts): one whose holder is gone is broken at once, one older than
// ten seconds is a holder that hung, and a holder only ever releases its own. A writer that cannot
// get it in two seconds fails (and is tried again at the next round) rather than writing without it.
function withStateLock<T>(dir: string, fn: (held: HeldLock) => T): T {
  return withDirLockSync(join(dir, "state.lock"), fn, { waitMs: 2000, staleMs: 10_000 });
}

/**
 * Change part of a member's state: read it, apply `patch` and write it, under the lock, so a
 * change made by the other writer in between is not lost. The positions do not go back
 * (see `mergeFleetState`) unless `rewind` says that this is what is meant: a store that
 * lost what the state says it fetched has to start again from what it has.
 */
export function updateFleetState(
  configPath: string,
  fleetId: string,
  spaceName: string,
  patch: Partial<FleetMemberState>,
  opts: { rewind?: boolean } = {},
): FleetMemberState {
  const dir = fleetStateDir(configPath, fleetId, spaceName);
  return withStateLock(dir, (held) => {
    const disk = readFleetState(configPath, fleetId, spaceName);
    const wanted = { ...disk, ...patch };
    const next = opts.rewind ? wanted : mergeFleetState(disk, wanted);
    // A holder that was judged stale while it ran does not write over what another has written since.
    held.assert();
    writeFileAtomic(join(dir, "state.json"), JSON.stringify(next, null, 2), 0o600, { durable: true });
    dropPublishedCoveredBy(dir, next);
    return next;
  });
}

/**
 * Forget where a member was in a fleet: a member that joins a fleet starts from nothing, whatever an earlier membership
 * under the same name (of a fleet that was deleted and made again) left of its position, and of a publish that was never
 * written down. The work tree and the key are not touched.
 */
export function resetFleetState(configPath: string, fleetId: string, spaceName: string): void {
  const dir = fleetStateDir(configPath, fleetId, spaceName);
  withStateLock(dir, (held) => {
    held.assert();
    rmSync(join(dir, "state.json"), { force: true });
    rmSync(join(dir, PUBLISHED_FILE), { force: true });
  });
}

/**
 * Record a member's state. What is written never puts a position behind the one on disk
 * (see `mergeFleetState`), unless `replace` says the state is a new start (a space that
 * has just joined).
 */
export function writeFleetState(configPath: string, fleetId: string, spaceName: string, state: FleetMemberState, opts: { replace?: boolean } = {}): void {
  const dir = fleetStateDir(configPath, fleetId, spaceName);
  const file = join(dir, "state.json");
  // Written beside it and moved into place: the agent and `prime fleets sync` can
  // both write this file, and a reader that met a half-written one would take it
  // for no state at all (and apply the fleet again from nothing).
  withStateLock(dir, (held) => {
    const next = opts.replace ? state : mergeFleetState(readFleetState(configPath, fleetId, spaceName), state);
    // A pointer that older builds wrote to the last manifest: nothing reads it, and it goes when the file is next written.
    delete (next as Record<string, unknown>).manifest;
    held.assert();
    writeFileAtomic(file, JSON.stringify(next, null, 2), 0o600, { durable: true });
    dropPublishedCoveredBy(dir, next);
  });
}

// ---- the signed roster (see fleet-roster.ts and docs/fleets.md, "The signed roster") ----------------------

/** Where this machine keeps the owner key of a fleet: --owner-key, PRIME_FLEET_OWNER_KEY, or ~/.prime/fleet-owner/<gateway host>/<fleet>.ed25519.pem. */
export function ownerKeyPath(ctx: Ctx, fleetId: string, gateway: string): string {
  const given = str(ctx.parsed, "owner-key") ?? process.env.PRIME_FLEET_OWNER_KEY;
  if (given) return resolve(given);
  let host = "gateway";
  try {
    host = new URL(gateway).host;
  } catch {
    // a gateway that is not a URL has no host to name the directory by
  }
  return join(homedir(), ".prime", "fleet-owner", host.replace(/[^A-Za-z0-9._-]/g, "_"), fleetId + ".ed25519.pem");
}

/** The owner key of this fleet if this machine has one; a file that is there but is not a key is an error, not "none". */
function ownerKeyIfAny(ctx: Ctx, fleetId: string, gateway: string): OwnerKey | undefined {
  const file = ownerKeyPath(ctx, fleetId, gateway);
  return existsSync(file) ? readOwnerKey(file) : undefined;
}

/** Read the owner key this command needs, saying where it looked and what to do when it is not there. */
function requireOwnerKey(ctx: Ctx, fleetId: string, gateway: string): OwnerKey {
  try {
    return readOwnerKey(ownerKeyPath(ctx, fleetId, gateway));
  } catch (err) {
    if (err instanceof RosterError) throw new CliError(err.message, "The roster of " + fleetId + " is signed: it is changed only where its owner key is.");
    throw err;
  }
}

function parseInvite(text: string): { code: string; ownerFp?: string } {
  try {
    return parseInviteCode(text);
  } catch (err) {
    if (err instanceof RosterError) throw new UsageError(err.message, "Pass the code as 'prime fleets invite' printed it.");
    throw err;
  }
}

/** A member that pinned another owner key for this fleet does not take an invite that names a different one. */
function refuseOtherPin(keyFile: string, ownerFp: string): void {
  const pinned = FleetTrust.ownerPinned(keyFile);
  if (pinned !== undefined && pinned !== ownerFp.replace(/[\s-]/g, "").toUpperCase()) {
    throw new CliError(
      "this machine pinned another owner key for this fleet (" + pinned + "), and the invite names " + ownerFp,
      "If the operator really made a new key, pin it first: prime fleets trust pin <fleet> --space <name> --owner <fingerprint>.",
    );
  }
}

interface RosterState {
  mode: "open" | "signed";
  incarnation?: string;
  entries: SignedEntry[];
}

/** The roster as the gateway keeps it. A gateway that has none says 404: the roster is then open, as it always was. */
async function getRosterState(t: FleetTarget, fleetId: string, after?: number): Promise<RosterState> {
  const res = await call(t, "GET", "/fleets/" + encodeURIComponent(fleetId) + "/roster" + (after !== undefined ? "?after=" + after : ""));
  if (res.status === 404 || res.status === 405) return { mode: "open", entries: [] };
  failOn(res.status, res.json, "could not read the roster");
  const entries: SignedEntry[] = [];
  for (const raw of Array.isArray(res.json?.entries) ? res.json.entries : []) {
    try {
      entries.push(checkSigned(raw));
    } catch (err) {
      throw new CliError("the gateway sent a roster entry that is not one: " + (err instanceof Error ? err.message : String(err)));
    }
  }
  return {
    mode: res.json?.mode === "signed" ? "signed" : "open",
    ...(typeof res.json?.incarnation === "string" ? { incarnation: res.json.incarnation } : {}),
    entries,
  };
}

async function headSeqOf(t: FleetTarget, fleetId: string): Promise<number> {
  const res = await call(t, "GET", "/fleets/" + encodeURIComponent(fleetId) + "/head");
  if (res.status === 404) return 0;
  failOn(res.status, res.json, "could not read the head");
  const seq = res.json?.head?.seq;
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0 ? seq : 0;
}

/** Check a chain the gateway sent, as the operator: it must be the fleet's, and signed from the key this machine holds. */
function verifiedForOwner(chain: SignedEntry[], fleetId: string, owner: OwnerKey, incarnation?: string): VerifiedRoster {
  let v: VerifiedRoster;
  try {
    v = verifyChain(chain, { fleet: fleetId, ...(incarnation !== undefined ? { incarnation } : {}) });
  } catch (err) {
    if (err instanceof RosterError) throw new CliError("the roster the gateway keeps is not valid: " + err.message);
    throw err;
  }
  if (v.owner !== owner.publicKey) {
    throw new CliError(
      "this fleet's roster is signed by the owner key " + ownerFingerprint(v.owner) + ", and the key on this machine is " + ownerFingerprint(owner.publicKey),
      "Use the machine that holds the key, or --owner-key <file>.",
    );
  }
  return v;
}

/** Sign the next entry of a chain and have the gateway take it; returns the chain's new head. */
async function postEntry(
  t: FleetTarget,
  fleetId: string,
  owner: OwnerKey,
  head: { n: number; hash: string } | null,
  incarnation: string,
  f: Omit<Parameters<typeof makeEntry>[0], "fleet" | "incarnation" | "n" | "prevHash" | "at">,
): Promise<{ res: Awaited<ReturnType<typeof call>>; entry: RosterEntry; signed: SignedEntry }> {
  const entry = makeEntry({ ...f, fleet: fleetId, incarnation, n: head ? head.n + 1 : 0, prevHash: head ? head.hash : null, at: Date.now() });
  const signed: SignedEntry = { entry, sig: signEntry(entry, owner.privateKeyPem) };
  const res = await call(t, "POST", "/fleets/" + encodeURIComponent(fleetId) + "/roster", signed);
  return { res, entry, signed };
}

async function appendEntry(
  t: FleetTarget,
  fleetId: string,
  owner: OwnerKey,
  head: { n: number; hash: string } | null,
  incarnation: string,
  f: Omit<Parameters<typeof makeEntry>[0], "fleet" | "incarnation" | "n" | "prevHash" | "at">,
): Promise<{ n: number; hash: string; signed: SignedEntry }> {
  const { res, entry, signed } = await postEntry(t, fleetId, owner, head, incarnation, f);
  // The genesis is the operator's to send (the gateway refuses a device's, even the owner device's).
  if (res.status === 403 && entry[6] === "genesis") {
    throw new CliError("the gateway did not take the genesis entry of the roster: only the operator may start a signed roster", "Run this with the operator's credential (--operator-token or PRIME_FLEET_OPERATOR_TOKEN, or --sso), not a device's. The owner key file is kept.");
  }
  failOn(res.status, res.json, "the gateway did not take the roster entry " + entry[3] + " (" + entry[6] + ")");
  return { n: entry[3], hash: entryHash(signed), signed };
}

const shortKey = (b64u: string | null | undefined): string => (b64u ? ownerFingerprint(b64u).slice(0, 11) : "-");

/**
 * Approve a request in a fleet whose roster is signed: the operator's approval is an `add` entry (or, for a device that is a
 * member already and asks for a new key, a `rotate`). What is signed is what the gateway offers, so it is signed only for the key
 * the operator names: `--key` is the fingerprint the joining machine itself prints, taken to the operator by another way than
 * through the gateway. A plain approve is never a key change: that takes `--rotate` as well.
 */
async function approveSigned(ctx: Ctx, t: FleetTarget, fleetId: string, deviceId: string, key: string | undefined): Promise<void> {
  const owner = requireOwnerKey(ctx, fleetId, t.gateway);
  const state = await getRosterState(t, fleetId);
  const v = verifiedForOwner(state.entries, fleetId, owner, state.incarnation);
  const pendingRes = await call(t, "GET", "/fleets/" + encodeURIComponent(fleetId) + "/pending");
  failOn(pendingRes.status, pendingRes.json, "could not list the requests");
  const request = ((pendingRes.json.pending ?? []) as Array<{ deviceId: string; pubkey?: string; spub?: string; role?: string; keyChange?: boolean }>).find((p) => p.deviceId === deviceId);
  if (!request) throw new CliError("no request from " + deviceId + " is waiting", "'prime fleets pending " + fleetId + "' lists them.");
  if (!request.pubkey) throw new CliError("the request of " + deviceId + " offers no key to seal snapshots for");
  if (!request.spub) {
    throw new CliError(
      "the request of " + deviceId + " offers no signing key",
      "The roster names each member's signing key. Upgrade prime on that machine to a release that makes one, and ask again.",
    );
  }
  const fp = keyFingerprintOf(request.pubkey);
  const spubFp = ownerFingerprint(request.spub);
  const live = liveMembers(v).find((m) => m.device === deviceId);
  const role = request.role === "viewer" ? "viewer" : "member";
  const offered = deviceId + " offers the key " + fp + " and the signing key " + spubFp + ", as " + role;
  // The roster is signed with the owner key, so what goes into it is what the operator compared, not what the gateway lists.
  // Both keys go into the signed roster, so both are what the operator compared: a signing key the gateway chose would be the member's
  // identity for everything that member signs from then on.
  const signingKey = str(ctx.parsed, "signing-key");
  if (key === undefined || signingKey === undefined) {
    throw new CliError(
      "this roster is signed: " + offered + ", and the gateway is the one saying so",
      "Compare both with what 'prime fleets members " + fleetId + "' (or 'prime fleets status') prints on that machine itself, in full, and then: prime fleets approve " + fleetId + " --member " + deviceId + " --key <key> --signing-key <signing key>" + (live ? " --rotate" : ""),
    );
  }
  if (key !== fp) throw new CliError("the key of the request is " + fp + ", not " + key + ": it is not the one you compared (or it was replaced since)");
  const plain = (f: string): string => f.replace(/-/g, "").toUpperCase();
  if (plain(signingKey) !== plain(spubFp)) {
    throw new CliError("the signing key of the request is " + spubFp + ", not " + signingKey + ": it is not the one you compared (or it was replaced since)", "Nothing was signed.");
  }
  if (live && !bool(ctx.parsed, "rotate")) {
    throw new CliError(deviceId + " is a member already, and this request is for another key (" + fp + "): that is a key change, and takes --rotate", "Only if that machine really made a new key; the current key is " + (live.xpub ? keyFingerprintOf(live.xpub) : "unknown") + ".");
  }
  if (!live && bool(ctx.parsed, "rotate")) throw new CliError(deviceId + " is not a member of the signed roster: --rotate is for a member's new key");
  // Where the roster says this takes effect: the head, as the gateway says it, twice (it goes forward, and no further than it was).
  // A new member's place begins at the head (the gateway refuses a lower one), and a snapshot published meanwhile moves it: signed again.
  let seqAt = 0;
  let done: { n: number; hash: string; signed: SignedEntry } | undefined;
  for (let attempt = 0; done === undefined; attempt++) {
    const before = await headSeqOf(t, fleetId);
    seqAt = await headSeqOf(t, fleetId);
    if (seqAt < before) throw new CliError("the gateway's head went back from " + before + " to " + seqAt + " while this was being signed");
    const sent = await postEntry(t, fleetId, owner, v.head, v.incarnation, {
      op: live ? "rotate" : "add",
      device: deviceId,
      xpub: request.pubkey,
      spub: request.spub,
      ...(live ? {} : { role }),
      seqAt,
    });
    if (sent.res.status === 409 && headMoved(sent.res.json) && attempt < 3) continue;
    failOn(sent.res.status, sent.res.json, "the gateway did not take the roster entry " + sent.entry[3] + " (" + sent.entry[6] + ")");
    done = { n: sent.entry[3], hash: entryHash(sent.signed), signed: sent.signed };
  }
  if (ctx.json) {
    printJson({ fleet: fleetId, member: deviceId, role, entry: done.n, seqAt, ...(live ? { keyChanged: true } : {}) });
    return;
  }
  ctx.out(green(live ? "replaced the key of" : "admitted") + " " + deviceId + dim(" as " + role + "; entry " + done.n + " of the roster, effective from snapshot " + seqAt + ", signed with the owner key " + shortKey(owner.publicKey) + "; its key " + fp + ", signing key " + spubFp));
}

/** How far the sequence the gateway names for a fence may be above the head read after it: a publish that was in flight. */
const FENCE_SLACK = 1;

/**
 * Remove a member from a fleet whose roster is signed: the fleet is asked to fence it first, and the entry is signed with the
 * sequence the fence says. That sequence is the one part of a removal that has an effect (the key is a member's for snapshots up to it
 * and no further), so it is checked against the head read before the fence and after it: a gateway that names a later one would
 * keep a removed key publishing under the owner's signature.
 */
async function removeSigned(ctx: Ctx, t: FleetTarget, fleetId: string, deviceId: string): Promise<void> {
  const owner = requireOwnerKey(ctx, fleetId, t.gateway);
  const state = await getRosterState(t, fleetId);
  const v = verifiedForOwner(state.entries, fleetId, owner, state.incarnation);
  if (!liveMembers(v).some((m) => m.device === deviceId)) throw new CliError(deviceId + " is not a member in the signed roster of " + fleetId);
  const headBefore = await headSeqOf(t, fleetId);
  // From the fence on, the fleet takes nothing more from that member, so the sequence it answers is the last it can publish at.
  const fenced = await call(t, "POST", "/fleets/" + encodeURIComponent(fleetId) + "/remove-fence", { deviceId });
  failOn(fenced.status, fenced.json, "could not fence the member");
  const seqAt = fenced.json?.seqAt;
  if (typeof seqAt !== "number" || !Number.isSafeInteger(seqAt) || seqAt < 0) throw new CliError("the gateway did not say at which sequence the member was fenced");
  const headAfter = await headSeqOf(t, fleetId);
  if (seqAt < headBefore || seqAt > headAfter + FENCE_SLACK) {
    throw new CliError(
      "the gateway fenced " + deviceId + " at snapshot " + seqAt + ", but the head was " + headBefore + " before and " + headAfter + " after: that is not a sequence it could have fenced at, and nothing was signed",
      "The member is fenced at the gateway now. Run this again; if the gateway answers the same, do not trust it.",
    );
  }
  const done = await appendEntry(t, fleetId, owner, v.head, v.incarnation, { op: "remove", device: deviceId, seqAt });
  // The witness keeps a removed key's slot until it is told: the entry is public, and posting it is the operator's.
  const witness = witnessUrl(ctx);
  let posted: string | undefined;
  if (witness) posted = await postRemoveToWitness(witness, v.entries[0]!, done.signed).then(() => undefined, (e: unknown) => (e instanceof Error ? e.message : String(e)));
  if (ctx.json) {
    printJson({ fleet: fleetId, removed: deviceId, entry: done.n, seqAt, head: headAfter, ...(witness ? { witness: posted === undefined ? "posted" : "failed: " + posted } : {}) });
    return;
  }
  ctx.out(green("removed") + " " + deviceId + " from " + fleetId + dim("  entry " + done.n + " of the roster, as of snapshot " + seqAt + " (the head is " + headAfter + ")"));
  if (!witness) ctx.out(yellow("the witness was not told") + dim(": prime fleets roster witness " + fleetId + " --witness <url>   (or --witness / PRIME_FLEET_WITNESS on this command)"));
  else if (posted !== undefined) ctx.out(yellow("the witness did not take the removal (" + posted + ")") + dim(": prime fleets roster witness " + fleetId + " --witness " + witness));
  else ctx.out(dim("the witness was told"));
}

/** Where the witness is: --witness, or PRIME_FLEET_WITNESS. */
function witnessUrl(ctx: Ctx): string | undefined {
  const given = str(ctx.parsed, "witness") ?? process.env.PRIME_FLEET_WITNESS;
  if (!given) return undefined;
  try {
    const u = new URL(given);
    if (u.protocol !== "https:" && u.hostname !== "127.0.0.1" && u.hostname !== "localhost") throw new Error("not https");
    return u.origin + u.pathname.replace(/\/+$/, "");
  } catch {
    throw new UsageError("--witness is not a URL: " + given, "An https address, like https://witness.example.");
  }
}

/** `POST <witness>/w/<fleetKey>/remove` with `{genesis, entry, sig}`: public in the chain, so anyone may post it. */
async function postRemoveToWitness(witness: string, genesis: SignedEntry, removal: SignedEntry): Promise<void> {
  const res = await fetch(witness + "/w/" + encodeURIComponent(fleetKeyOf(genesis.entry)) + "/remove", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ genesis: genesis.entry, entry: removal.entry, sig: removal.sig }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error("the witness answered " + res.status + (await res.text().then((t) => " " + t.slice(0, 120), () => "")));
}

/** `prime fleets trust pin <fleet> --space <name> --owner <fingerprint>`: the owner key this member believes the roster of the fleet is signed by. */
async function fleetsTrustPin(ctx: Ctx, rawFleet: string): Promise<void> {
  const fleetId = requireFleetId(rawFleet);
  const spaceName = spaceArg(ctx);
  if (!spaceName) throw new UsageError("missing --space", "Name the space that belongs to the fleet.");
  const clear = bool(ctx.parsed, "clear");
  const fp = str(ctx.parsed, "owner");
  if (clear && fp) throw new UsageError("--clear and --owner do not go together");
  if (!clear && (!fp || !isFingerprint(fp))) {
    throw new UsageError("missing or malformed --owner", "The owner key's fingerprint, as 'prime fleets roster show' or 'prime fleets invite' prints it on the operator's machine (26 letters and digits).");
  }
  const space = ctx.config.spaces[spaceName];
  if (!space) throw new UsageError("unknown space \"" + spaceName + "\"", "Run 'prime spaces list' to see the spaces.");
  if (space.fleet !== fleetId) throw new UsageError("the space \"" + spaceName + "\" is not in the fleet " + fleetId);
  const keyFile = fleetKeyFile(ctx.configPath, fleetId, spaceName);
  if (clear) {
    const before = FleetTrust.unpinOwner(keyFile);
    if (ctx.json) printJson({ fleet: fleetId, space: spaceName, cleared: before ?? null });
    else ctx.out(before ? green("this member no longer pins an owner key for " + fleetId) + dim(" (it had " + before + "); it believes the first signed roster it sees until it is pinned again") : "this member pinned no owner key for " + fleetId);
    return;
  }
  // A pin made before the roster is signed would make this member refuse the roster as it is now: pin after `roster init`.
  const seen = await getRosterState(target(ctx, spaceName), fleetId).catch((err: unknown) => {
    throw new CliError("could not check that the roster of " + fleetId + " is signed: " + (err instanceof Error ? err.message : String(err)), "A pin is made once the roster is signed; try again when the gateway answers.");
  });
  if (seen.mode !== "signed") {
    throw new CliError(
      "the roster of " + fleetId + " is not signed yet, so there is nothing for this key to be the owner of",
      "Pin it after the operator has run 'prime fleets roster init " + fleetId + "': a member that pinned a key refuses a roster that is not signed.",
    );
  }
  const { replaced } = FleetTrust.pinOwner(keyFile, fp!, true);
  if (ctx.json) {
    printJson({ fleet: fleetId, space: spaceName, owner: fp!.replace(/[\s-]/g, "").toUpperCase(), ...(replaced ? { replaced } : {}) });
    return;
  }
  ctx.out(green("this member believes the roster of " + fleetId + " only when it is signed by the owner key ") + bold(fp!.toUpperCase()));
  if (replaced) ctx.out(yellow("it had pinned " + replaced + " before"));
}

const ROSTER_USAGE =
  "Usage: prime fleets roster init <fleet-id> [--owner-key <file>] [--yes --expect <digest>]\n" +
  "       prime fleets roster show <fleet-id> [--space <name>]\n" +
  "       prime fleets roster pin <fleet-id> --space <name> --owner <fingerprint> | --clear\n" +
  "       prime fleets roster witness <fleet-id> --witness <url>\n" +
  "       prime fleets roster add-caller <fleet-id> --key <public-key> | --self [--label <text>]\n" +
  "       prime fleets roster remove-caller <fleet-id> --key <public-key> | --self\n" +
  "       prime fleets roster pin-caller <fleet-id> --owner <fingerprint> | --clear [--gateway <url>]";

/** `prime fleets roster init|show|pin` */
export async function fleetsRoster(ctx: Ctx): Promise<void> {
  const what = ctx.parsed.positionals[2] ?? "";
  const rawFleet = ctx.parsed.positionals[3] ?? "";
  switch (what) {
    case "init":
      return rosterInit(ctx, requireFleetId(rawFleet));
    case "show":
      return rosterShow(ctx, requireFleetId(rawFleet));
    case "pin":
      return fleetsTrustPin(ctx, rawFleet);
    case "witness":
      return rosterWitness(ctx, requireFleetId(rawFleet));
    case "add-caller":
      return rosterCaller(ctx, requireFleetId(rawFleet), "caller");
    case "remove-caller":
      return rosterCaller(ctx, requireFleetId(rawFleet), "caller-remove");
    case "pin-caller":
      return rosterPinCaller(ctx, requireFleetId(rawFleet));
    default:
      throw new UsageError("unknown roster command \"" + what + "\"", ROSTER_USAGE);
  }
}

interface MemberRow {
  deviceId: string;
  role?: string;
  pubkey?: string;
  spub?: string;
  label?: string;
}

/**
 * Put a fleet's roster under the owner key: a genesis entry that names the key, and an `add` for each member the gateway lists
 * now (what the operator has compared, one by one, with what each member's own machine prints). Without `--yes` nothing is signed
 * or sent: it shows what would be. Run again after a failure it goes on from where the gateway's chain ends.
 */
async function rosterInit(ctx: Ctx, fleetId: string): Promise<void> {
  const t = target(ctx, spaceArg(ctx));
  const yes = bool(ctx.parsed, "yes");
  const file = ownerKeyPath(ctx, fleetId, t.gateway);
  const state = await getRosterState(t, fleetId);
  const membersRes = await call(t, "GET", "/fleets/" + encodeURIComponent(fleetId) + "/members");
  failOn(membersRes.status, membersRes.json, "could not read the members");
  const members = (membersRes.json.members ?? []) as MemberRow[];
  if (members.length === 0) throw new CliError("the fleet has no members to put in a roster");
  let incarnation = state.incarnation ?? (typeof membersRes.json.incarnation === "string" ? membersRes.json.incarnation : undefined);
  if (incarnation === undefined) {
    // The gateway names which fleet of this name this is on /role, too.
    const role = await call(t, "GET", "/fleets/" + encodeURIComponent(fleetId) + "/role");
    if (role.status === 200 && typeof role.json?.incarnation === "string" && role.json.incarnation) incarnation = role.json.incarnation;
  }
  if (incarnation === undefined) throw new CliError("the gateway does not say which fleet of this name this is (it has no signed roster yet): deploy a gateway that has one first");

  const unsigned = members.filter((m) => !m.pubkey || !m.spub);
  if (unsigned.length > 0) {
    throw new CliError(
      "these members have not told the gateway their keys: " + unsigned.map((m) => m.deviceId).join(", "),
      "The roster names each member's signing key. Upgrade prime on those machines to a release that makes one and let their agents run.",
    );
  }

  // What is already there decides where this goes on from: a roster of another owner key is not ours to extend.
  let owner: OwnerKey | undefined = existsSync(file) ? readOwnerKey(file) : undefined;
  let head: { n: number; hash: string } | null = null;
  let known = new Set<string>();
  // A chain that is there is gone on from, whatever mode the gateway says it is in.
  if (state.mode === "signed" || state.entries.length > 0) {
    if (!owner) throw new CliError("this fleet's roster is already signed, and there is no owner key at " + file, "Use the machine that holds the key, or --owner-key <file>.");
    const v = verifiedForOwner(state.entries, fleetId, owner, state.incarnation);
    head = v.head;
    known = new Set(liveMembers(v).map((m) => m.device));
  }
  const todo = members.filter((m) => !known.has(m.deviceId));
  const ownerFp = owner ? ownerFingerprint(owner.publicKey) : undefined;

  if (!ctx.json) {
    ctx.out(bold("roster of " + fleetId) + dim("  incarnation " + incarnation));
    ctx.out(ownerFp ? "owner key " + bold(ownerFp) : "owner key " + dim("(will be made at " + file + ")"));
    ctx.out(table(["DEVICE", "ROLE", "KEY", "SIGNING KEY", ""], members.map((m) => [m.deviceId, m.role ?? "member", keyFingerprintOf(m.pubkey!), ownerFingerprint(m.spub!), known.has(m.deviceId) ? "in the roster" : "to add"])));
  }
  if (todo.length === 0 && head !== null) {
    if (ctx.json) printJson({ fleet: fleetId, ownerFingerprint: ownerFp, entries: head.n + 1, added: [] });
    else ctx.out(dim("every member is in the roster already"));
    return;
  }
  // What is signed is what was compared: the digest of the rows to add is what the operator takes from this run to the next.
  const digest = rowsDigest(todo);
  if (!yes) {
    if (ctx.json) printJson({ fleet: fleetId, ownerFingerprint: ownerFp ?? null, wouldAdd: todo.map((m) => m.deviceId), digest, signed: false });
    else {
      ctx.out("");
      ctx.out(yellow("nothing was signed or sent."));
      ctx.out("Compare each KEY and SIGNING KEY with what 'prime fleets members " + fleetId + "' prints on that member's own machine (not through the gateway), then sign exactly these rows:");
      ctx.out("  prime fleets roster init " + fleetId + " --yes --expect " + bold(digest));
    }
    return;
  }
  const expected = str(ctx.parsed, "expect");
  if (expected === undefined) {
    throw new CliError("--yes needs --expect <digest>: what you signed has to be what you compared", "Run this without --yes: it prints the rows and the digest to give.");
  }
  if (expected !== digest) {
    throw new CliError(
      "the members the gateway lists now are not the ones that were shown (digest " + digest + ", not " + expected + "), and nothing was signed",
      "A key or a role changed since the rows were compared. Run it again without --yes and compare them again.",
    );
  }

  if (!owner) owner = createOwnerKeyFile(file);
  // The members that are there when the chain begins were members before it: their place is from the start, so that the
  // snapshots they published before this are theirs under the chain (the operator vouches for them by comparing their keys).
  const seqAt = 0;
  if (head === null) {
    const g = await appendEntry(t, fleetId, owner, null, incarnation, { op: "genesis", seqAt, extra: owner.publicKey });
    head = { n: g.n, hash: g.hash };
  }
  const added: string[] = [];
  for (const m of todo) {
    const done = await appendEntry(t, fleetId, owner, head, incarnation, {
      op: "add",
      device: m.deviceId,
      xpub: m.pubkey!,
      spub: m.spub!,
      role: m.role === "owner" || m.role === "viewer" ? m.role : "member",
      seqAt,
    });
    head = { n: done.n, hash: done.hash };
    added.push(m.deviceId);
  }
  if (ctx.json) {
    printJson({ fleet: fleetId, ownerFingerprint: ownerFingerprint(owner.publicKey), entries: head.n + 1, added });
    return;
  }
  ctx.out("");
  ctx.out(green("the roster of " + fleetId + " is signed") + dim("  " + (head.n + 1) + " entries, " + added.length + " member(s) added"));
  ctx.out("Every member pins the owner key with: prime fleets trust pin " + fleetId + " --space <name> --owner " + ownerFingerprint(owner.publicKey));
}

/** A digest of the rows `roster init` would sign: what the operator compares and takes to the run that signs. */
function rowsDigest(rows: MemberRow[]): string {
  const sorted = rows
    .map((m) => [m.deviceId, m.pubkey ?? "", m.spub ?? "", m.role === "owner" || m.role === "viewer" ? m.role : "member"])
    .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("base64url").slice(0, 22);
}

/** Print the roster as the gateway keeps it, after checking it: the owner key, the head, who is in it. */
async function rosterShow(ctx: Ctx, fleetId: string): Promise<void> {
  const spaceName = spaceArg(ctx);
  const t = target(ctx, spaceName);
  const state = await getRosterState(t, fleetId);
  if (state.mode !== "signed") {
    if (ctx.json) printJson({ fleet: fleetId, mode: "open" });
    else ctx.out("the roster of " + fleetId + " is not signed: the gateway keeps it, and a member takes its word");
    return;
  }
  // A member shows it against what it pinned and what it has seen.
  const keyFile = spaceName ? fleetKeyFile(ctx.configPath, fleetId, spaceName) : undefined;
  const pinned = keyFile ? FleetTrust.ownerPinned(keyFile) : undefined;
  let v: VerifiedRoster;
  try {
    v = verifyChain(state.entries, { fleet: fleetId, ...(pinned ? { ownerFp: pinned } : {}) });
  } catch (err) {
    if (err instanceof RosterError) throw new CliError("the roster the gateway keeps is not valid: " + err.message);
    throw err;
  }
  const live = liveMembers(v);
  if (ctx.json) {
    printJson({
      fleet: fleetId,
      mode: "signed",
      ownerFingerprint: ownerFingerprint(v.owner),
      pinned: pinned !== undefined,
      fleetKey: v.fleetKey,
      head: v.head,
      members: live.map((m) => ({ device: m.device, role: m.role, key: m.xpub ? keyFingerprintOf(m.xpub) : null, since: m.from })),
      callers: v.callers,
    });
    return;
  }
  ctx.out(bold(fleetId) + dim("  signed roster, " + v.entries.length + " entries, head " + v.head.hash.slice(0, 12)));
  ctx.out("owner key " + bold(ownerFingerprint(v.owner)) + (pinned ? green("  (the one this member pinned)") : dim("  (not pinned on this machine: compare it with the operator's)")));
  ctx.out(table(["DEVICE", "ROLE", "KEY", "SINCE SNAPSHOT"], live.map((m) => [m.device, m.role, m.xpub ? keyFingerprintOf(m.xpub) : "-", String(m.from)])));
  if (v.callers.length > 0) ctx.out(dim("caller keys: " + v.callers.map((c) => c.label || shortKey(c.spub)).join(", ")));
}

/**
 * `prime fleets roster add-caller|remove-caller <fleet> --key <public key>`: the owner key signs a caller key into the roster, so that the
 * fleet's primary accepts tool calls signed by it for the fleet (`prime tools call --fleet`). A key id is not enough: the roster holds the
 * key, and 'prime devices callers' (or a refused call) prints it in full.
 */
async function rosterCaller(ctx: Ctx, fleetId: string, op: "caller" | "caller-remove"): Promise<void> {
  const self = bool(ctx.parsed, "self");
  const given = str(ctx.parsed, "key");
  if (self === (given !== undefined)) throw new UsageError("name the key with --key <public-key> or --self", ROSTER_USAGE);
  let raw: Buffer;
  if (self) {
    raw = loadOrCreateCallerKey().publicKey;
  } else {
    const parsed = parsePublicKey(given!);
    if (!parsed) throw new UsageError("that is not a public key", "Give the caller's public key: 43-44 characters of base64, as 'prime devices callers' or a refused call prints it. A key id alone is not enough.");
    raw = parsed;
  }
  const spub = raw.toString("base64url");
  const label = str(ctx.parsed, "label") ?? "";
  if (label.length > 100) throw new UsageError("--label is longer than 100 characters");
  const t = target(ctx, spaceArg(ctx));
  const owner = requireOwnerKey(ctx, fleetId, t.gateway);
  const state = await getRosterState(t, fleetId);
  if (state.mode !== "signed" || state.entries.length === 0) throw new CliError("the roster of " + fleetId + " is not signed", "Run 'prime fleets roster init " + fleetId + "' first: only a signed roster lists callers.");
  const v = verifiedForOwner(state.entries, fleetId, owner, state.incarnation);
  const listed = v.callers.find((c) => c.spub === spub);
  if (op === "caller" && listed && listed.label === label) {
    ctx.out(dim(keyIdOf(raw) + " is a caller of " + fleetId + " already" + (label ? " (" + label + ")" : "")));
    return;
  }
  if (op === "caller-remove" && !listed) throw new CliError(keyIdOf(raw) + " is not a caller in the signed roster of " + fleetId, "'prime fleets roster show " + fleetId + "' lists them.");
  const done = await appendEntry(t, fleetId, owner, v.head, v.incarnation, { op, spub, ...(op === "caller" ? { extra: label } : {}) });
  if (ctx.json) {
    printJson({ fleet: fleetId, [op === "caller" ? "added" : "removed"]: keyIdOf(raw), entry: done.n });
    return;
  }
  ctx.out(green(op === "caller" ? "allowed" : "removed") + " " + bold(keyIdOf(raw)) + (op === "caller" ? " to call the primary of " + fleetId + (label ? " (" + label + ")" : "") : " from the callers of " + fleetId) + dim("  entry " + done.n + " of the roster"));
}

/**
 * `prime fleets roster pin-caller <fleet> --owner <fingerprint> | --clear`: on a machine that calls the fleet (not a member of it), which owner key
 * the fleet's replies are checked against. The fingerprint is what `roster init` printed, or the one in the invite (`~<fingerprint>`); compare it
 * with the operator's. Without a pin the replies of the fleet are not authenticated, and the client says so.
 */
async function rosterPinCaller(ctx: Ctx, fleetId: string): Promise<void> {
  const gateway = normalizeGateway(str(ctx.parsed, "gateway") ?? ctx.config.defaults.gateway ?? process.env[ENV.gateway] ?? DEFAULT_GATEWAY);
  if (bool(ctx.parsed, "clear")) {
    const had = unpinFleetOwner(gateway, fleetId);
    if (ctx.json) printJson({ fleet: fleetId, gateway, cleared: had });
    else ctx.out(had ? "no owner is pinned for " + bold(fleetId) + " on this machine now" : dim("no owner was pinned for " + fleetId));
    return;
  }
  const given = str(ctx.parsed, "owner");
  if (given === undefined) throw new UsageError("missing --owner <fingerprint>", ROSTER_USAGE);
  // The fingerprint itself, or an invite code that carries it (`<code>~<fingerprint>`).
  const fp = given.includes("~") ? parseInvite(given).ownerFp : isFingerprint(given) ? normalizeFingerprint(given) : undefined;
  if (fp === undefined) throw new UsageError("that is not an owner key fingerprint", "It is 26 letters and digits, as 'prime fleets roster init' prints it.");
  const before = pinFleetOwner(gateway, fleetId, fp);
  if (ctx.json) {
    printJson({ fleet: fleetId, gateway, owner: fp, ...(before && before.ownerFp !== fp ? { replaced: before.ownerFp } : {}) });
    return;
  }
  ctx.out(green("pinned") + " owner " + bold(fp) + " for " + bold(fleetId) + dim(" on " + gateway) + (before && before.ownerFp !== fp ? yellow("  (it was " + before.ownerFp + ")") : ""));
  ctx.out(dim("replies of " + fleetId + " are now accepted as a member's only when the member's key in the owner's signed roster vouches for them"));
}

/** `prime fleets roster witness <fleet> --witness <url>`: tell the witness of every removal in the chain (they are public; again is harmless). */
async function rosterWitness(ctx: Ctx, fleetId: string): Promise<void> {
  const witness = witnessUrl(ctx);
  if (!witness) throw new UsageError("missing --witness", "The witness's address (or PRIME_FLEET_WITNESS).");
  const t = target(ctx, spaceArg(ctx));
  const state = await getRosterState(t, fleetId);
  if (state.entries.length === 0) throw new CliError("the roster of " + fleetId + " is not signed: there is nothing to tell the witness");
  let v: VerifiedRoster;
  try {
    v = verifyChain(state.entries, { fleet: fleetId });
  } catch (err) {
    if (err instanceof RosterError) throw new CliError("the roster the gateway keeps is not valid: " + err.message);
    throw err;
  }
  const removals = v.entries.filter((e) => e.entry[6] === "remove");
  const failed: string[] = [];
  for (const r of removals) {
    await postRemoveToWitness(witness, v.entries[0]!, r).catch((e: unknown) => failed.push(String(r.entry[7]) + ": " + (e instanceof Error ? e.message : String(e))));
  }
  if (ctx.json) {
    printJson({ fleet: fleetId, witness, removals: removals.length, failed });
  } else {
    ctx.out(green("told the witness of " + (removals.length - failed.length) + " removal(s)") + (removals.length === 0 ? dim(" (there are none)") : ""));
    for (const f of failed) ctx.out(yellow("not taken: " + f));
  }
  if (failed.length > 0) throw new CliError("the witness did not take " + failed.length + " removal(s)");
}

// ---- the audit log (see docs/fleets.md, "Who did it") ----------------------------------------------------

/** What the fleet's audit log holds for one entry (the gateway's `AuditEntry`). */
export interface AuditRow {
  n: number;
  prev: string;
  at: number;
  actor: { kind: string; id?: string; email?: string };
  action: string;
  target?: string;
  detail?: Record<string, string | number | boolean | null>;
}

/** The `prev` of the first entry of a log. */
export const AUDIT_GENESIS = "0".repeat(64);

/** JSON with its keys in order and nothing undefined: the bytes the gateway hashes an entry as. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map((v) => canonicalJson(v)).join(",") + "]";
  const parts: string[] = [];
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[k];
    if (v === undefined) continue;
    parts.push(JSON.stringify(k) + ":" + canonicalJson(v));
  }
  return "{" + parts.join(",") + "}";
}

/** The hash the next entry carries as its `prev`. */
export function auditEntryHash(entry: AuditRow): string {
  return createHash("sha256").update(canonicalJson(entry), "utf8").digest("hex");
}

/**
 * Whether these entries, in order, are a chain, and where it breaks: the number of the first entry whose number or `prev`
 * does not follow the one before. `prev` is what the first is expected to carry; null leaves the first unchecked (a page
 * from the middle of a log). The hash the last entry's successor will carry is returned for the next page.
 */
export function checkAuditChain(entries: AuditRow[], prev: string | null): { brokenAt: number | null; last: string | null } {
  let expect = prev;
  let n: number | undefined;
  for (const e of entries) {
    if ((expect !== null && e.prev !== expect) || (n !== undefined && e.n !== n + 1)) return { brokenAt: e.n, last: null };
    expect = auditEntryHash(e);
    n = e.n;
  }
  return { brokenAt: null, last: expect };
}

const isAuditRow = (v: unknown): v is AuditRow => {
  const e = v as AuditRow;
  return (
    !!e &&
    typeof e === "object" &&
    Number.isSafeInteger(e.n) &&
    e.n > 0 &&
    typeof e.prev === "string" &&
    typeof e.at === "number" &&
    typeof e.action === "string" &&
    !!e.actor &&
    typeof e.actor.kind === "string"
  );
};

const actorText = (a: AuditRow["actor"]): string => (a.email ?? a.id ?? "") ? a.kind + ":" + (a.email ?? a.id) : a.kind;
const detailText = (d: AuditRow["detail"]): string =>
  d
    ? Object.entries(d)
        .map(([k, v]) => k + "=" + String(v))
        .join(" ")
    : "";

/** The head of the log this machine last checked, kept so that a later read can tell a log that was cut back or rewritten. */
function auditPinFile(ctx: Ctx, gateway: string, fleetId: string): string {
  let host = "gateway";
  try {
    host = new URL(gateway).host;
  } catch {
    // not a URL: the name below is only a file name
  }
  return join(dirname(ctx.configPath), "fleet-audit", host.replace(/[^A-Za-z0-9._-]/g, "_") + "-" + fleetId + ".json");
}

function readAuditPin(file: string): { n: number; hash: string } | undefined {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { n?: unknown; hash?: unknown };
    return Number.isSafeInteger(raw.n) && (raw.n as number) > 0 && typeof raw.hash === "string" && /^[0-9a-f]{64}$/.test(raw.hash) ? { n: raw.n as number, hash: raw.hash } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `prime fleets log <fleet-id> [--after <n>] [--limit <n>] [--tail [<n>]] [--all]`
 *
 * What was done to the fleet, by whom, from the gateway's hash-chained log. Every entry names the hash of the one before, so
 * an entry removed, changed or moved shows at the next one, and the command says where the chain breaks (and fails). It also
 * remembers the head it last checked: a log that is shorter than that, or whose entry at that number is another, was cut back
 * or rewritten, and that is said too.
 */
export async function fleetsLog(ctx: Ctx): Promise<void> {
  const fleetId = requireFleetId(ctx.parsed.positionals[2] ?? "");
  const t = target(ctx, spaceArg(ctx));
  const all = bool(ctx.parsed, "all");
  const wantAfter = num(ctx.parsed, "after");
  const limit = num(ctx.parsed, "limit");
  const tail = num(ctx.parsed, "tail") ?? 50;
  const base = "/fleets/" + encodeURIComponent(fleetId) + "/audit";
  const page = async (query: string): Promise<{ entries: AuditRow[]; head: { n: number; hash: string }; first: number; unrecorded?: number; pageMax: number }> => {
    const res = await call(t, "GET", base + query);
    if (res.status === 404) throw new CliError("this gateway has no audit log", "It predates the log; the operator deploys a newer gateway.");
    failOn(res.status, res.json, "could not read the log");
    const rows = Array.isArray(res.json?.entries) ? (res.json.entries as unknown[]) : [];
    if (!rows.every(isAuditRow)) throw new CliError("the gateway sent a log entry that is not one");
    const head = res.json?.head;
    if (!head || !Number.isSafeInteger(head.n) || typeof head.hash !== "string") throw new CliError("the gateway sent a log without its head");
    return { entries: rows, head, first: Number(res.json.first) || 0, ...(typeof res.json.unrecorded === "number" ? { unrecorded: res.json.unrecorded } : {}), pageMax: Number(res.json.limit) || 500 };
  };

  let entries: AuditRow[] = [];
  let head: { n: number; hash: string } | undefined;
  let first = 0;
  let unrecorded: number | undefined;
  if (all) {
    let after = wantAfter ?? 0;
    for (;;) {
      const got = await page("?after=" + after + "&limit=500");
      head = got.head;
      first = got.first;
      unrecorded = got.unrecorded;
      entries.push(...got.entries);
      if (got.entries.length === 0 || got.entries[got.entries.length - 1]!.n >= got.head.n) break;
      after = got.entries[got.entries.length - 1]!.n;
    }
  } else {
    // Without a position the newest entries; with one, the page after it.
    const got = wantAfter !== undefined ? await page("?after=" + wantAfter + (limit !== undefined ? "&limit=" + limit : "")) : await page("?tail=" + tail);
    entries = got.entries;
    head = got.head;
    first = got.first;
    unrecorded = got.unrecorded;
  }
  if (!head) throw new CliError("the gateway sent no log");

  // The chain inside what was read; the first entry is checked against the genesis only when it is the log's first.
  const firstRow = entries[0];
  const inside = checkAuditChain(entries, firstRow && firstRow.n === 1 ? AUDIT_GENESIS : null);
  let problem: string | null = inside.brokenAt !== null ? "the chain breaks at entry " + inside.brokenAt + ": an entry before it was removed, changed or moved" : null;
  // The newest entry is the head the gateway says it has.
  const lastRow = entries[entries.length - 1];
  if (!problem && lastRow && lastRow.n === head.n && inside.last !== head.hash) problem = "the head the gateway reports (entry " + head.n + ") is not the hash of its last entry";
  if (!problem && lastRow && lastRow.n > head.n) problem = "the log has entries past the head the gateway reports";

  // What this machine saw of the log before.
  const pinFile = auditPinFile(ctx, t.gateway, fleetId);
  const pinned = readAuditPin(pinFile);
  // Whether the entries read reach back to the one this machine pinned (so that the pin may move to the head read).
  let reachesPin = true;
  if (!problem && pinned) {
    if (head.n < pinned.n) problem = "the log is shorter than when it was last checked here (entry " + pinned.n + "): it was cut back";
    else {
      let seen = entries;
      const has = (n: number): boolean => seen.some((e) => e.n === n);
      // A page that does not hold the pinned entry (and the one after it, when there is one) says nothing about whether the log was
      // rewritten before it: a rewrite changes the hash of every entry from there on, the pinned one included. So those two are asked for.
      if (!has(pinned.n) || (head.n > pinned.n && !has(pinned.n + 1))) {
        try {
          seen = [...entries, ...(await page("?after=" + (pinned.n - 1) + "&limit=2")).entries];
        } catch (err) {
          if (!(err instanceof CliError)) throw err;
          reachesPin = false;
        }
      }
      const same = seen.find((e) => e.n === pinned.n);
      const next = seen.find((e) => e.n === pinned.n + 1);
      if (same && auditEntryHash(same) !== pinned.hash) problem = "entry " + pinned.n + " is not the one this machine checked before: the log was rewritten";
      else if (next && next.prev !== pinned.hash) problem = "entry " + next.n + " does not follow the entry " + pinned.n + " this machine checked before: the log was rewritten";
      // The gateway's archive may no longer serve the pinned entry: then nothing was checked against it, and the pin stays where it was.
      else if (!same) reachesPin = false;
    }
  }
  if (!problem && inside.last !== null && lastRow && lastRow.n === head.n && (!pinned || (head.n >= pinned.n && reachesPin))) {
    try {
      mkdirSync(dirname(pinFile), { recursive: true, mode: 0o700 });
      writeFileAtomic(pinFile, JSON.stringify({ n: head.n, hash: head.hash }) + "\n", 0o600);
    } catch {
      // Not being able to keep it only means the next read has nothing to compare with.
    }
  }
  const notChecked = pinned !== undefined && !problem && !reachesPin;

  if (ctx.json) {
    printJson({ fleet: fleetId, head, first, entries, verified: problem === null, ...(problem ? { problem } : {}), ...(unrecorded ? { unrecorded } : {}) });
  } else {
    if (entries.length === 0) ctx.out(dim("no entries" + (wantAfter !== undefined ? " after " + wantAfter : "")));
    else {
      ctx.out(
        table(
          ["N", "TIME", "ACTOR", "ACTION", "TARGET", "DETAIL"],
          entries.map((e) => [String(e.n), new Date(e.at).toISOString(), actorText(e.actor), e.action, e.target ?? "", detailText(e.detail)]),
        ),
      );
    }
    ctx.out(dim("head " + head.n + " " + head.hash.slice(0, 16) + (first > 1 ? "  (entries before " + first + " are in the gateway's archive)" : "")));
    if (unrecorded) ctx.out(yellow(unrecorded + " action(s) could not be written to the log"));
    if (!problem) ctx.out(green("chain intact") + dim(entries.length > 0 ? " over the " + entries.length + " entries shown" : ""));
    if (notChecked) ctx.out(yellow("not checked against the last read here (entry " + pinned!.n + "): the gateway did not give that entry. Run with --all"));
    else ctx.out(yellow("BROKEN: " + problem));
  }
  if (problem) throw new CliError("the audit log does not verify: " + problem, "The gateway (or whoever holds it) changed the log. Do not rely on it.");
}

// ---- what the publish leaves out as secrets (see fleet-secrets.ts) --------------------------------------------

/** `prime fleets secrets list|allow|disallow <fleet-id> --space <name> [glob...]` */
export async function fleetsSecrets(ctx: Ctx): Promise<void> {
  const what = ctx.parsed.positionals[2] ?? "";
  const fleetId = requireFleetId(ctx.parsed.positionals[3] ?? "");
  const spaceName = spaceArg(ctx);
  const usage = "Usage: prime fleets secrets list|allow|disallow <fleet-id> --space <name> [<path or glob>...]";
  if (!["list", "allow", "disallow"].includes(what)) throw new UsageError("unknown secrets command \"" + what + "\"", usage);
  if (!spaceName) throw new UsageError("missing --space", "Name the space that belongs to the fleet.");
  const space = ctx.config.spaces[spaceName];
  if (!space) throw new UsageError("unknown space \"" + spaceName + "\"", "Run 'prime spaces list' to see the spaces.");
  if (space.fleet !== fleetId) throw new UsageError("the space \"" + spaceName + "\" is not in the fleet " + fleetId);
  const keyFile = fleetKeyFile(ctx.configPath, fleetId, spaceName);
  const globs = ctx.parsed.positionals.slice(4);
  const current = readAllow(keyFile);
  if (what !== "list") {
    if (globs.length === 0) throw new UsageError("name the path or glob", usage);
    for (const g of globs) if (g.startsWith("/") || g.includes("..") || g.length > 512) throw new UsageError("not a path inside the work tree: " + g, "Paths are relative to the work tree, like src/.env or **/*.pem.");
    writeAllow(keyFile, what === "allow" ? [...current, ...globs] : current.filter((g) => !globs.includes(g)));
  }
  const allow = what === "list" ? current : readAllow(keyFile);
  if (ctx.json) {
    printJson({ fleet: fleetId, space: spaceName, gate: secretGateMode(), allow });
    return;
  }
  ctx.out(bold(fleetId) + dim("  secret gate: " + secretGateMode() + " (PRIME_FLEET_SECRET_GATE=off|warn|exclude)"));
  ctx.out(allow.length === 0 ? dim("nothing is allowed: files that look like secrets are left out of every snapshot") : "allowed to be published:\n" + allow.map((g) => "  " + g).join("\n"));
}
