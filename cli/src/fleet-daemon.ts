// The fleet agent: a host-side daemon that keeps the spaces of a fleet in
// step by itself.
//
// It is shaped like the vault broker: a small process that runs on the host
// and is started when a space that needs it comes up. The agent reads the
// configuration, finds the spaces that belong to a fleet, and synchronises
// each of them in turn - publishing when it is the primary, pulling when it
// is a replica.
//
// It needs no scope registration: the configuration already says which spaces
// are in a fleet, so a new space is picked up the next time round and an agent
// that restarts picks up where it left off.
//
// How fast a change travels
//   The primary watches its work tree, so it publishes within a moment of a
//   file changing, rather than waiting for the next poll. A replica looks at
//   the fleet's head often - the call is small - and pulls only when the head
//   has moved. The result is that a file written on one machine is on the
//   others in about a second, not in half a minute.
//
// Nothing here holds a secret in the clear beyond what the configuration
// already holds, and the agent inherits only the environment it needs.

import { mkdirSync, readFileSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";

import { selfCommand } from "./code-mcp-host.ts";
import { loadConfig, type SpaceEntry } from "./config.ts";
import { CliError } from "./errors.ts";
import { loadOrCreateKeyPair, publish, pull, type MemberPaths } from "./fleet-agent.ts";
import { settle, snapshot } from "./fleet-sync.ts";
import { fetchHead, fetchMemberKeys, releaseLease, type FleetCredentials } from "./fleet-transport.ts";
import { detectRuntime, spaceContainerRunning, type RuntimeInfo } from "./spaces.ts";
import { fleetKeyFile, fleetStateDir, readFleetState, writeFleetState } from "./fleets.ts";

export interface FleetAgentState {
  pid: number;
  started_at: string;
  config_path: string;
  /** How many spaces it is keeping in step. */
  spaces?: number;
  /** How many rounds it has run. */
  rounds?: number;
  /** The last thing that went wrong, so a silent agent can be read. */
  last_error?: string;
  /** When it last did something. */
  last_action?: string;
  /** How long the last round took, in milliseconds. */
  timing?: RoundTiming;
}

export interface FleetAgentOptions {
  /** How often a replica looks at the fleet's head. */
  pollMs?: number;
  /** How often the primary renews its lease. */
  heartbeatMs?: number;
  /** How often the primary checks the work tree even if the watcher said nothing. */
  backstopMs?: number;
  /** How long to wait for a file to stop changing before it is captured. */
  settleMs?: number;
}

export function fleetAgentDir(configPath: string): string {
  return join(dirname(configPath), "fleet-agent");
}

export function fleetAgentStatePath(configPath: string): string {
  return join(fleetAgentDir(configPath), "state.json");
}

export function readFleetAgentState(configPath: string): FleetAgentState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(fleetAgentStatePath(configPath), "utf8")) as FleetAgentState;
    return parsed && parsed.pid ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the agent is running; returns its metadata.
 *
 * The agent is started the same way the vault broker is: a detached child
 * that writes a state file, with only the environment it needs.
 */
export async function ensureFleetAgent(configPath: string, options: FleetAgentOptions = {}): Promise<FleetAgentState> {
  const existing = readFleetAgentState(configPath);
  if (existing && pidAlive(existing.pid)) return existing;
  rmSync(fleetAgentStatePath(configPath), { force: true });
  const dir = fleetAgentDir(configPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const agentEnv: Record<string, string | undefined> = { PRIME_FLEET_AGENT_DIR: dir };
  // The timings travel with the agent, so a user can trade traffic for speed.
  if (options.pollMs !== undefined) agentEnv.PRIME_FLEET_POLL_MS = String(options.pollMs);
  if (options.heartbeatMs !== undefined) agentEnv.PRIME_FLEET_HEARTBEAT_MS = String(options.heartbeatMs);
  // The agent needs almost nothing from the caller's environment. Copying all
  // of it would silently hand it unrelated credentials.
  const inherited = new Set([
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE",
    "TERM", "NO_COLOR", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
    "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  ]);
  for (const key of inherited) {
    const value = process.env[key];
    if (value !== undefined) agentEnv[key] = value;
  }
  const child = Bun.spawn({
    // selfCommand, not process.execPath: when the CLI runs from source the
    // executable is bun, and bun would look for a file named __fleet-agent.
    cmd: [...selfCommand(), "__fleet-agent", "--config", configPath],
    env: agentEnv,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  (child as unknown as { unref?: () => void }).unref?.();
  const deadline = Date.now() + 5000;
  for (;;) {
    const state = readFleetAgentState(configPath);
    if (state && pidAlive(state.pid)) return state;
    if (Date.now() > deadline) throw new CliError("the fleet agent did not start");
    await Bun.sleep(50);
  }
}

/** Stop the agent. Returns true when one was running. */
export function stopFleetAgent(configPath: string): boolean {
  const state = readFleetAgentState(configPath);
  if (!state) return false;
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {}
  rmSync(fleetAgentStatePath(configPath), { force: true });
  return true;
}

/** Whether the agent is running, and what it is doing. */
export function fleetAgentStatus(configPath: string): {
  running: boolean;
  pid?: number;
  started_at?: string;
  spaces?: number;
  rounds?: number;
  last_error?: string;
  last_action?: string;
  timing?: RoundTiming;
} {
  const state = readFleetAgentState(configPath);
  if (!state || !pidAlive(state.pid)) return { running: false };
  return {
    running: true,
    pid: state.pid,
    started_at: state.started_at,
    spaces: state.spaces,
    rounds: state.rounds,
    last_error: state.last_error,
    last_action: state.last_action,
    timing: state.timing,
  };
}

/** The spaces in the configuration that belong to a fleet. */
export function fleetSpaces(configPath: string): Array<{ name: string; space: SpaceEntry }> {
  const config = loadConfig(configPath);
  const out: Array<{ name: string; space: SpaceEntry }> = [];
  for (const [name, space] of Object.entries(config.spaces)) {
    if (space.fleet) out.push({ name, space });
  }
  return out;
}

/**
 * Watch a work tree and say when something in it changed.
 *
 * The watcher is what makes a change travel fast: the primary does not have to
 * wait for a poll to notice. It is a hint, not a promise - the agent still
 * checks the tree from time to time, because a watcher can miss something.
 */
export function watchTree(work: string, onChange: () => void): { stop: () => void } {
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(work, { recursive: true }, () => onChange());
  } catch {
    // A platform that cannot watch recursively: the agent falls back to
    // checking the tree on its own.
  }
  return {
    stop: () => {
      try {
        watcher?.close();
      } catch {}
    },
  };
}

/** How long each part of a round took, in milliseconds. */
export interface RoundTiming {
  bootstrap?: number;
  snapshot?: number;
  publish?: number;
  pull?: number;
  total?: number;
}

interface SpaceLoop {
  configPath: string;
  name: string;
  space: SpaceEntry;
  fleet: string;
  creds: FleetCredentials;
  paths: MemberPaths;
  dirty: boolean;
  lastPublish: number;
  lastCheck: number;
  primary: boolean;
  /** When it last took a place in the fleet. */
  lastBootstrap: number;
  /** How long the fleet says a place lasts, from the last bootstrap. */
  leaseMs?: number;
  timing: RoundTiming;
  /** The runtime, so the agent can tell whether the space is running. */
  runtime?: RuntimeInfo;
}

/** One round for one space: take a place, then publish or pull. */
async function round(loop: SpaceLoop, options: FleetAgentOptions, report: (what: string) => void): Promise<void> {
  const { creds, fleet, paths } = loop;
  const state = readFleetState(loop.configPath, fleet, loop.name);

  // A space that is not running must not hold the fleet. If it did, the
  // lease would keep a primary that nobody can reach, and no other member
  // could take over when it dies.
  if (loop.runtime && !spaceContainerRunning(loop.runtime, loop.space)) {
    if (loop.primary) {
      await releaseLease(creds, fleet).catch(() => false);
      report("the space is not running; the lease was given up");
    }
    loop.primary = false;
    return;
  }

  // Take a place in the fleet. The lease is short-lived, so a member that has
  // not spoken for a while has to take it again before it may write.
  // Taking a place renews the lease, and that is a write. It is done often
  // enough to keep the lease and no more: a write on every round would put
  // the gateway under needless load.
  const now = Date.now();
  // The heartbeat is what keeps the lease, and the lease is how long the fleet
  // waits before it lets another member take over. The fleet says how long its
  // lease is; the heartbeat is a third of that, so two renewals can be lost
  // before the place is gone. Five seconds is the ceiling on a long lease.
  const heartbeatMs = Math.max(
    500,
    Math.min(options.heartbeatMs ?? 5_000, Math.floor((loop.leaseMs ?? 15_000) / 3)),
  );
  const stale = now - loop.lastBootstrap > heartbeatMs;
  if (stale || !loop.primary) {
    const began = Date.now();
    const keys = loadOrCreateKeyPair(paths.keyFile);
    const placed = await bootstrapHere(creds, fleet, keys.publicKey, loop.name);
    loop.timing.bootstrap = Date.now() - began;
    loop.lastBootstrap = now;
    if (!placed.ok) throw new Error(placed.error);
    loop.primary = placed.primary;
    // What the fleet says a place lasts. An agent that renews at its own pace
    // against a lease it never asked about is how a live primary loses it.
    if (placed.ttlMs) loop.leaseMs = placed.ttlMs;
  }

  if (loop.primary) {
    const due = Date.now() - loop.lastCheck > (options.backstopMs ?? 60_000);
    const changed = loop.dirty;
    if (!changed && !due) return;
    loop.dirty = false;
    loop.lastCheck = Date.now();

    // A file that is still being written must not be captured half-written.
    // It only matters when something changed: otherwise there is nothing to
    // capture.
    if (changed) await settle(paths.work, options.settleMs ?? 250);
    const snapBegan = Date.now();
    const snap = await snapshot({ work: paths.work, gitDir: paths.gitDir, base: state.base ?? null, seq: state.seq ?? 0, treeOnly: true });
    loop.timing.snapshot = Date.now() - snapBegan;
    const members = await fetchMemberKeys(creds, fleet);
    // Nothing changed in the workspace and nobody joined: publishing the same
    // tree again would cost a pack and a write for nothing. But a member that
    // has just joined - or that came back with a new key - needs a snapshot
    // sealed for it, so the membership is part of the question. The keys are
    // part of it too: a member that lost its key cannot open what was sealed
    // for the old one.
    const roster = members.map((m) => m.deviceId + ":" + (m.pubkey ?? "").slice(0, 12)).join(",");
    if (state.tree !== undefined && snap.tree === state.tree && roster === (state.roster ?? "")) {
      return;
    }
    const publishBegan = Date.now();
    const result = await publish(
      creds,
      fleet,
      paths,
      state.base ?? null,
      state.seq ?? 0,
      state.manifest,
      state.memberCount ?? 0,
    );
    loop.timing.publish = Date.now() - publishBegan;
    writeFleetState(loop.configPath, fleet, loop.name, {
      ...state,
      base: result.commit,
      seq: result.seq,
      manifest: result.manifestKey,
      memberCount: result.members,
      roster,
      tree: snap.tree,
    });
    loop.lastPublish = Date.now();
    report("published " + result.seq);
    return;
  }

  // A replica: it looks at the head often, and pulls only when the head moved.
  loop.primary = false;
  const head = await fetchHead(creds, fleet);
  if (head.seq <= (state.seq ?? 0)) return;

  // A replica mirrors the primary. If its workspace was changed locally, the
  // pull would throw that work away, so it is not applied: the change is
  // reported instead, and the person who made it decides what to do with it.
  if (state.tree !== undefined) {
    const local = await snapshot({ work: paths.work, gitDir: paths.gitDir, base: state.base ?? null, seq: state.seq ?? 0 });
    if (local.tree !== state.tree) {
      report("the workspace was changed locally and the fleet has moved on; the change was left alone");
      return;
    }
  }

  const pullBegan = Date.now();
  const pulled = await pull(creds, fleet, paths, state.seq ?? 0);
  loop.timing.pull = Date.now() - pullBegan;
  if (pulled.applied) {
    // The tree it now holds is remembered, so the next round can tell a
    // change made here from the state it already had.
    writeFleetState(loop.configPath, fleet, loop.name, {
      ...state,
      seq: pulled.seq,
      base: pulled.commit,
      ...(pulled.tree ? { tree: pulled.tree } : {}),
    });
    report("applied " + pulled.seq);
  }
}


interface BootstrapResult {
  ok: boolean;
  primary: boolean;
  error?: string;
  /** How long the fleet says a place lasts; the heartbeat is derived from it. */
  ttlMs?: number;
}

/** Take a place in the fleet, without the CLI's machinery. */
async function bootstrapHere(creds: FleetCredentials, fleet: string, pubkey?: string, label?: string): Promise<BootstrapResult> {
  const res = await fetch(creds.gateway + "/fleets/" + encodeURIComponent(fleet) + "/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-prime-device": creds.deviceId, "x-device-token": creds.deviceToken },
    // The key travels with it: a member that lost its key can only catch up
    // if the fleet learns the new one. The name travels too, so a space that
    // was renamed - or an identity another space took over - reads correctly
    // in the operator's list.
    body: JSON.stringify({ ...(pubkey ? { pubkey } : {}), ...(label ? { label } : {}) }),
    signal: AbortSignal.timeout(creds.timeoutMs ?? 60_000),
  });
  if (!res.ok) return { ok: false, primary: false, error: "status " + res.status };
  const body = (await res.json()) as { role?: string; ttlMs?: number };
  return {
    ok: true,
    primary: body.role === "primary",
    ...(typeof body.ttlMs === "number" && body.ttlMs > 0 ? { ttlMs: body.ttlMs } : {}),
  };
}

/**
 * The agent's loop.
 *
 * Every space gets its own loop, so a space that is slow does not hold up the
 * others.
 */
export async function runFleetAgent(configPath: string, options: FleetAgentOptions = {}): Promise<void> {
  const env = process.env;
  const pollMs = options.pollMs ?? Number(env.PRIME_FLEET_POLL_MS ?? 1500);
  const heartbeatMs = options.heartbeatMs ?? Number(env.PRIME_FLEET_HEARTBEAT_MS ?? 5_000);
  const dir = fleetAgentDir(configPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  // The runtime is found once: it is used to tell whether a space is
  // running, and looking it up on every round would be slow.
  const runtime = await detectRuntime().catch(() => undefined);
  const startedAt = new Date().toISOString();
  let lastError: string | undefined;
  let lastAction: string | undefined;
  let timing: RoundTiming | undefined;
  let rounds = 0;
  const write = (spaces: number): void => {
    const state: FleetAgentState = {
      pid: process.pid,
      started_at: startedAt,
      config_path: configPath,
      spaces,
      rounds,
      ...(lastError ? { last_error: lastError } : {}),
      ...(lastAction ? { last_action: lastAction } : {}),
      ...(timing ? { timing } : {}),
    };
    writeFileSync(fleetAgentStatePath(configPath), JSON.stringify(state), { mode: 0o600 });
  };

  const loops = new Map<string, SpaceLoop>();
  const watchers = new Map<string, { stop: () => void }>();
  const wakeups = new Map<string, () => void>();
  write(0);

  // A signal that a space's work tree changed, so a sleeping loop wakes at once
  // rather than waiting for its next turn.
  const wake = (name: string): void => {
    const w = wakeups.get(name);
    if (w) w();
  };

  const runSpace = async (name: string, space: SpaceEntry): Promise<void> => {
    const fleet = space.fleet!;
    const work = space.work_dir;
    if (!work || !space.gateway || !space.gateway_device || !space.remote_token) return;
    const loop: SpaceLoop = {
      configPath,
      name,
      space,
      fleet,
      creds: {
        gateway: space.gateway,
        deviceId: space.gateway_device,
        deviceToken: space.remote_token,
        timeoutMs: 60_000,
      },
      paths: {
        work,
        gitDir: fleetStateDir(configPath, fleet, name),
        keyFile: fleetKeyFile(configPath, fleet, name),
      },
      dirty: false,
      lastPublish: 0,
      lastCheck: 0,
      primary: false,
      lastBootstrap: 0,
      timing: {},
      ...(runtime ? { runtime } : {}),
    };
    loops.set(name, loop);
    const watcher = watchTree(work, () => {
      loop.dirty = true;
      wake(name);
    });
    watchers.set(name, watcher);

    while (!stopping) {
      try {
        await round(loop, { ...options, heartbeatMs }, (what) => {
          lastAction = name + ": " + what;
          lastError = undefined;
        });
        timing = loop.timing;
      } catch (err) {
        // A space that cannot be reached this round is not a reason to stop the
        // agent: the network blinks, and the next round tries again.
        lastError = name + ": " + (err instanceof Error ? err.message : String(err));
      }
      rounds++;
      write(spacesSeen);
      // Sleep until the next turn, or until something happens.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wakeups.delete(name);
          resolve();
        }, pollMs);
        wakeups.set(name, () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };

  let spacesSeen = 0;
  let running = new Map<string, Promise<void>>();
  while (!stopping) {
    const spaces = fleetSpaces(configPath);
    spacesSeen = spaces.length;
    // A space that was deleted stops being watched.
    for (const [name, watcher] of watchers) {
      if (!spaces.some((s) => s.name === name)) {
        watcher.stop();
        watchers.delete(name);
        loops.delete(name);
      }
    }
    // Each space has its own loop, so a slow one does not hold up the others.
    for (const { name, space } of spaces) {
      if (!running.has(name)) {
        running.set(name, runSpace(name, space).finally(() => running.delete(name)));
      }
    }
    write(spacesSeen);
    await Bun.sleep(pollMs);
  }
  for (const task of running.values()) await task.catch(() => {});

  for (const watcher of watchers.values()) watcher.stop();
  rmSync(fleetAgentStatePath(configPath), { force: true });
}
