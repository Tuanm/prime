// Putting a space into a fleet.
//
// A space in a fleet needs three things the gateway cannot give it by
// itself:
//
//   1. a device identity, so the fleet can tell who is calling;
//   2. membership, which takes an invite and an approval;
//   3. a work tree the host can see, so the agent can snapshot it.
//
// On the third point: a space normally keeps its work tree in a named volume,
// which only the container can see. A space in a fleet keeps it in a host
// directory bind-mounted into the container instead, because the
// synchronisation runs on the host.
//
// A new space joins the fleet and then takes its place: the first member
// with no state becomes the primary, and any other member fetches the
// current state before the container starts, so the space begins with the
// work already there.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Ctx } from "./context.ts";
import { CliError } from "./errors.ts";
import { loadOrCreateKeyPair, pull, publish, type MemberPaths } from "./fleet-agent.ts";
import { fetchRole, type FleetCredentials } from "./fleet-transport.ts";
import { fleetKeyFile, fleetStateDir, readFleetState, writeFleetState } from "./fleets.ts";

export interface FleetSpaceSetup {
  /** The device identity the space uses with the gateway. */
  deviceId: string;
  deviceToken: string;
  /** The role the space took in the fleet. */
  role: "primary" | "replica" | "pending";
  /** The host directory holding the work tree. */
  workDir: string;
  /** True when the space already holds the fleet's current state. */
  caughtUp: boolean;
  /** The sequence the space is at. */
  seq: number;
}

/** The host directory a fleet space keeps its work tree in. */
export function fleetWorkDir(ctx: Ctx, spaceName: string): string {
  const dir = join(ctx.configPath, "..", "spaces", spaceName, "work");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export interface FleetSpaceOptions {
  fleet: string;
  spaceName: string;
  gateway: string;
  deviceId: string;
  deviceToken: string;
  /** The invite code, when the space is joining an existing fleet. */
  code?: string;
  /** True when the space is the first member and creates the fleet. */
  create: boolean;
  /** How long to wait for the publisher to publish a snapshot for this member. */
  waitMs?: number;
}

/**
 *  Put a space into a fleet and bring it up to date.
 *
 *  The order matters: the space joins first, because a space that is not a
 *  member has no standing in the fleet. Then it takes its place, and only
 *  then does it fetch the current state. A replica that fetched nothing
 *  would fork the fleet the moment it took over.
 *
 */
export async function setupFleetSpace(ctx: Ctx, opts: FleetSpaceOptions): Promise<FleetSpaceSetup> {
  const creds: FleetCredentials = {
    gateway: opts.gateway,
    deviceId: opts.deviceId,
    deviceToken: opts.deviceToken,
    timeoutMs: 120_000,
  };
  const workDir = fleetWorkDir(ctx, opts.spaceName);
  const paths: MemberPaths = {
    work: workDir,
    gitDir: fleetStateDir(ctx.configPath, opts.fleet, opts.spaceName),
    keyFile: fleetKeyFile(ctx.configPath, opts.fleet, opts.spaceName),
  };

  // The member's key pair exists before it joins, so the roster already
  // carries the key the primary will seal snapshots for.
  const keys = loadOrCreateKeyPair(paths.keyFile);

  // A device that is already a member does not join again: a create that
  // failed after the join is retried with the same device, and it must not
  // need a second invite.
  const already = await fleetCall(creds, "GET", "/fleets/" + encodeURIComponent(opts.fleet) + "/me", undefined);
  const isMember = already.status === 200 && already.json?.status === "member";
  if (!isMember) {
    if (opts.create) {
      const created = await fleetCall(creds, "POST", "/fleets/" + encodeURIComponent(opts.fleet), {
        pubkey: keys.publicKey,
      });
      if (created.status >= 400) {
        // The fleet already exists: this space joins it instead.
        await joinFleet(ctx, creds, opts);
      }
    } else {
      await joinFleet(ctx, creds, opts);
    }
  }

  const role = await fetchRole(creds, opts.fleet);
  if (!role.member) {
    return { deviceId: opts.deviceId, deviceToken: opts.deviceToken, role: "pending", workDir, caughtUp: false, seq: 0 };
  }

  // Take a place in the fleet. The fleet decides: the first member with no
  // state becomes the primary, any other member becomes a replica.
  const bootstrapped = await fleetCall(creds, "POST", "/fleets/" + encodeURIComponent(opts.fleet) + "/bootstrap", {});
  if (bootstrapped.status >= 400) {
    throw new CliError("could not take a place in the fleet: " + (bootstrapped.json?.error ?? bootstrapped.status));
  }
  const isPrimary = bootstrapped.json?.role === "primary";
  const state = readFleetState(ctx.configPath, opts.fleet, opts.spaceName);

  if (isPrimary) {
    // The primary publishes the state it already holds, so a replica that
    // arrives later has something to fetch.
    const published = await publish(creds, opts.fleet, paths, state.base ?? null, state.seq ?? 0, state.manifest, state.memberCount ?? 0);
    writeFleetState(ctx.configPath, opts.fleet, opts.spaceName, {
      base: published.commit,
      seq: published.seq,
      manifest: published.manifestKey,
      memberCount: published.members,
    });
    return {
      deviceId: opts.deviceId,
      deviceToken: opts.deviceToken,
      role: "primary",
      workDir,
      caughtUp: true,
      seq: published.seq,
    };
  }

  // A replica fetches the current state before it starts working.
  //
  // A member that has just joined cannot open the snapshot that was
  // published before it arrived: the publisher seals each snapshot for the
  // members that were there at the time. So the first attempt waits for the
  // publisher to publish again, which it does as soon as it notices the
  // membership changed.
  const deadline = Date.now() + (opts.waitMs ?? 120_000);
  // The first attempt fails with an error when the snapshot was not sealed
  // for this member, so it is caught and the wait begins.
  // The reason the last attempt failed is kept, so the answer says what went
  // wrong rather than only that something did.
  let lastError: string | undefined;
  let pulled = await pull(creds, opts.fleet, paths, state.seq ?? 0).catch((err: unknown) => {
    lastError = err instanceof Error ? err.message : String(err);
    return null;
  });
  while ((pulled === null || (!pulled.applied && !pulled.upToDate)) && Date.now() < deadline) {
    await Bun.sleep(2000);
    pulled = await pull(creds, opts.fleet, paths, state.seq ?? 0).catch((err: unknown) => {
      lastError = err instanceof Error ? err.message : String(err);
      return pulled;
    });
  }
  if (pulled === null || (!pulled.applied && !pulled.upToDate)) {
    throw new CliError(
      "the fleet has no snapshot this member can open yet" + (lastError ? ": " + lastError : ""),
      "The publisher has to publish again now that this device has joined. It does so on its next round; try 'prime fleets sync --space " + opts.spaceName + "' in a moment.",
    );
  }
  if (pulled.applied) {
    writeFleetState(ctx.configPath, opts.fleet, opts.spaceName, { seq: pulled.seq, base: pulled.commit });
  }
  return {
    deviceId: opts.deviceId,
    deviceToken: opts.deviceToken,
    role: "replica",
    workDir,
    caughtUp: pulled.applied || pulled.upToDate,
    seq: pulled.seq,
  };
}

async function joinFleet(ctx: Ctx, creds: FleetCredentials, opts: FleetSpaceOptions): Promise<void> {
  if (!opts.code) {
    throw new CliError(
      "the fleet exists already",
      "Pass the invite code the operator printed: prime spaces create --fleet " + opts.fleet + " --code <code>.",
    );
  }
  const keys = loadOrCreateKeyPair(fleetKeyFile(ctx.configPath, opts.fleet, opts.spaceName));
  const joined = await fleetCall(creds, "POST", "/fleets/" + encodeURIComponent(opts.fleet) + "/join", {
    code: opts.code,
    label: opts.spaceName,
    pubkey: keys.publicKey,
  });
  if (joined.status >= 400) {
    throw new CliError("could not join the fleet: " + (joined.json?.error ?? joined.status));
  }
}


interface FleetCall {
  status: number;
  json: any;
}

async function fleetCall(creds: FleetCredentials, method: string, path: string, body: unknown): Promise<FleetCall> {
  const res = await fetch(creds.gateway + path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-prime-device": creds.deviceId,
      "x-device-token": creds.deviceToken,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(creds.timeoutMs ?? 120_000),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: text.slice(0, 200) };
  }
  return { status: res.status, json };
}
