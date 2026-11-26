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
import { FleetEvents, roundSleepMs, type FleetEvent } from "./fleet-events.ts";
import { loadOrCreateKeyPair, publish, pull, rosterOf, type MemberPaths } from "./fleet-agent.ts";
import { NestedRepoCache, preserveLocalChange, settle, snapshot } from "./fleet-sync.ts";
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
  /** Told by the fleet (push) or asking it (polling). */
  updates?: "push" | "polling";
  /** True while a fleet this agent keeps is paused. */
  paused?: boolean;
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
  updates?: "push" | "polling";
  paused?: boolean;
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
    ...(state.updates ? { updates: state.updates } : {}),
    ...(state.paused ? { paused: true } : {}),
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
export function watchTree(
  work: string,
  onChange: (eventType?: string, filename?: string | null) => void,
): { stop: () => void } {
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(work, { recursive: true }, (eventType, filename) => onChange(eventType, filename));
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
  /** A placement in flight, so the timer and the round cannot both ask. */
  placing?: boolean;
  timing: RoundTiming;
  /** The runtime, so the agent can tell whether the space is running. */
  runtime?: RuntimeInfo;
  /** The operator paused the fleet: no place is taken and nothing is renewed. */
  paused: boolean;
  /** How long the gateway asked to wait before looking at a paused fleet again. */
  retryAfterMs?: number;
  /** The held connection that tells this space what happened. */
  events: FleetEvents;
  /** Rounds in a row that failed; the agent waits longer after each. */
  failures?: number;
}

/**
 * The most often a place is renewed. With events the fleet tells a replica
 * when the place is free, so a slow heartbeat is enough; without them the
 * short one stays.
 */
const EVENTS_HEARTBEAT_MS = 15_000;

function heartbeatCeiling(loop: SpaceLoop, ceilingMs: number): number {
  return loop.events.connected ? Math.max(ceilingMs, EVENTS_HEARTBEAT_MS) : ceilingMs;
}

// The remembered nested repositories, as the option the sync functions take.
function nestedOpt(paths: MemberPaths): { nested?: NestedRepoCache } {
  return paths.nested ? { nested: paths.nested } : {};
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
  // The heartbeat is what keeps the lease, and the lease is how long the fleet
  // waits before it lets another member take over. The fleet says how long its
  // lease is; the heartbeat is a third of that, so two renewals can be lost
  // before the place is gone. Five seconds is the ceiling on a long lease.
  // A paused fleet takes no one in. With a live socket the fleet says when it
  // is resumed, so there is nothing to ask; without one, a look now and then
  // (as often as the gateway asked) finds out.
  if (loop.paused) {
    if (loop.events.connected) return;
    if (Date.now() - loop.lastBootstrap < (loop.retryAfterMs ?? 60_000)) return;
    await takePlace(loop);
    if (loop.paused) {
      report("the fleet is paused");
      return;
    }
  } else if (Date.now() - loop.lastBootstrap > heartbeatCeiling(loop, options.heartbeatMs!) || !loop.primary) {
    await takePlace(loop);
    if (loop.paused) {
      report("the fleet is paused");
      return;
    }
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
    const snap = await snapshot({
      work: paths.work,
      gitDir: paths.gitDir,
      base: state.base ?? null,
      seq: state.seq ?? 0,
      treeOnly: true,
      ...nestedOpt(paths),
    });
    loop.timing.snapshot = Date.now() - snapBegan;
    const members = await fetchMemberKeys(creds, fleet);
    // Nothing changed in the workspace and nobody joined: publishing the same
    // tree again would cost a pack and a write for nothing. But a member that
    // has just joined - or that came back with a new key - needs a snapshot
    // sealed for it, so the membership is part of the question. The keys are
    // part of it too: a member that lost its key cannot open what was sealed
    // for the old one.
    const roster = rosterOf(members);
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
      state.memberCount ?? 0,
      state.roster,
    );
    loop.timing.publish = Date.now() - publishBegan;
    writeFleetState(loop.configPath, fleet, loop.name, {
      ...state,
      base: result.commit,
      seq: result.seq,
      manifest: result.manifestKey,
      memberCount: result.members,
      // What the snapshot was sealed for, not what was asked a moment before:
      // a member that joined in between is then still seen as new next round.
      roster: result.roster,
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
  // pull would throw that work away - but refusing forever is worse than the
  // edit it protects: the replica never catches up, and a fleet whose members
  // are all behind has nobody it may promote. So the change is moved aside
  // (nothing deleted) and the mirror is brought up to date.
  if (state.tree !== undefined) {
    const local = await snapshot({
      work: paths.work,
      gitDir: paths.gitDir,
      base: state.base ?? null,
      seq: state.seq ?? 0,
      treeOnly: true,
      ...nestedOpt(paths),
    });
    if (local.tree !== state.tree) {
      const kept = await preserveLocalChange(paths.work, paths.gitDir, state.tree, nestedOpt(paths));
      report("kept " + kept.moved + " locally changed path(s) aside in " + kept.to + ", then caught up");
    }
  }

  const pullBegan = Date.now();
  // The tree it now holds is remembered after every step, so the next round
  // can tell a change made here from the state it already had - also when a
  // later step fails.
  const pulled = await pull(creds, fleet, paths, state.seq ?? 0, state.base ?? null, (step) => {
    writeFleetState(loop.configPath, fleet, loop.name, { ...state, seq: step.seq, base: step.commit, tree: step.tree });
  });
  loop.timing.pull = Date.now() - pullBegan;
  if (pulled.applied) report("applied " + pulled.seq);
}


interface BootstrapResult {
  ok: boolean;
  primary: boolean;
  error?: string;
  /** The fleet is paused: it will not take anyone in until it is resumed. */
  paused?: boolean;
  /** How long the fleet asked to wait before looking again. */
  retryAfterMs?: number;
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
  if (!res.ok) {
    // A paused fleet answers with a reason and how long to wait: that is not
    // a failure to report, it is the operator's choice.
    const body = (await res.json().catch(() => undefined)) as { paused?: unknown; retryAfterMs?: unknown } | undefined;
    if (body && body.paused === true) {
      const header = Number(res.headers.get("retry-after"));
      const asked =
        typeof body.retryAfterMs === "number" && body.retryAfterMs > 0
          ? body.retryAfterMs
          : Number.isFinite(header) && header > 0
            ? header * 1000
            : undefined;
      return { ok: false, primary: false, paused: true, error: "the fleet is paused", ...(asked ? { retryAfterMs: asked } : {}) };
    }
    return { ok: false, primary: false, error: "status " + res.status };
  }
  const body = (await res.json()) as { role?: string; ttlMs?: number };
  return {
    ok: true,
    primary: body.role === "primary",
    ...(typeof body.ttlMs === "number" && body.ttlMs > 0 ? { ttlMs: body.ttlMs } : {}),
  };
}

/** How often this space must renew its place, from the lease the fleet reports. */
function heartbeatFor(loop: SpaceLoop, ceilingMs: number): number {
  return Math.max(500, Math.min(ceilingMs, Math.floor((loop.leaseMs ?? 15_000) / 3)));
}

/**
 * Take (or take back) this space's place in the fleet.
 *
 * Callable outside the round on purpose: a round can spend a minute pulling a
 * large pack, and the place in the fleet does not wait for that. The heartbeat
 * is on a timer of its own, so the lease is renewed while the work is still
 * arriving.
 */
async function takePlace(loop: SpaceLoop): Promise<void> {
  if (loop.placing) return;
  loop.placing = true;
  try {
    const keys = loadOrCreateKeyPair(loop.paths.keyFile);
    const placed = await bootstrapHere(loop.creds, loop.fleet, keys.publicKey, loop.name);
    loop.lastBootstrap = Date.now();
    if (placed.paused) {
      loop.paused = true;
      loop.primary = false;
      loop.retryAfterMs = placed.retryAfterMs;
      return;
    }
    if (!placed.ok) throw new Error(placed.error);
    loop.paused = false;
    loop.primary = placed.primary;
    // What the fleet says a place lasts. An agent that renews at its own pace
    // against a lease it never asked about is how a live primary loses it.
    if (placed.ttlMs) loop.leaseMs = placed.ttlMs;
  } finally {
    loop.placing = false;
  }
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
  // The heartbeat never exceeds this; the fleet's own lease can lower it.
  const heartbeatMs = options.heartbeatMs ?? Number(env.PRIME_FLEET_HEARTBEAT_MS ?? 5_000);
  options = { ...options, heartbeatMs };
  const dir = fleetAgentDir(configPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let stopping = false;
  const wakeups = new Map<string, () => void>();
  const stop = (): void => {
    stopping = true;
    // A loop may be asleep for minutes now; it has to see the signal at once.
    for (const w of wakeups.values()) w();
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
  // Whether the agent is told what happens or has to ask, and whether a fleet
  // it keeps is paused. Only said when there is a space to speak of.
  const pushState = (): Pick<FleetAgentState, "updates" | "paused"> => {
    const all = [...loops.values()];
    if (all.length === 0) return {};
    return {
      updates: all.every((l) => l.events.connected) ? "push" : "polling",
      ...(all.some((l) => l.paused) ? { paused: true } : {}),
    };
  };
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
      ...pushState(),
    };
    writeFileSync(fleetAgentStatePath(configPath), JSON.stringify(state), { mode: 0o600 });
  };

  const loops = new Map<string, SpaceLoop>();
  const watchers = new Map<string, { stop: () => void }>();
  // A wake that came while the loop was busy, so it is not lost: an event that
  // says "pull now" must not wait for the next sleep to end.
  const pending = new Set<string>();
  write(0);

  // A signal that a space's work tree changed, so a sleeping loop wakes at once
  // rather than waiting for its next turn.
  const wake = (name: string, remember = false): void => {
    const w = wakeups.get(name);
    if (w) w();
    else if (remember) pending.add(name);
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
        nested: new NestedRepoCache(work),
      },
      dirty: false,
      lastPublish: 0,
      lastCheck: 0,
      primary: false,
      lastBootstrap: 0,
      timing: {},
      ...(runtime ? { runtime } : {}),
      paused: false,
      events: undefined as unknown as FleetEvents,
    };
    loop.events = new FleetEvents({
      gateway: loop.creds.gateway,
      fleet,
      deviceId: loop.creds.deviceId,
      deviceToken: loop.creds.deviceToken,
      onEvent: (event) => onEvent(loop, event),
      onStatus: (connected) => {
        // Without the socket the sleep is shorter, so look again now.
        if (!connected) wake(name, true);
        write(spacesSeen);
      },
    });
    loops.set(name, loop);
    // The heartbeat runs on its own clock, not as a step of the round: a round
    // that spends a minute pulling a large pack would otherwise let the place
    // lapse while it works, and another member would take the fleet.
    let beat: ReturnType<typeof setTimeout> | undefined;
    const beatTick = (): void => {
      beat = setTimeout(() => {
        // A paused fleet takes no one in, so there is nothing to renew. A space
        // whose rounds keep failing is retried by the round, on its longer wait,
        // not here every few seconds as well.
        const renew = loop.paused || (loop.failures ?? 0) > 0 ? Promise.resolve() : takePlace(loop);
        void renew.catch(() => {}).finally(beatTick);
      }, heartbeatFor(loop, heartbeatCeiling(loop, options.heartbeatMs ?? heartbeatMs)));
    };
    beatTick();
    loop.events.start();
    const watcher = watchTree(work, (eventType, filename) => {
      // A repository that appeared or went away changes what is left alone.
      loop.paths.nested?.noteChange(eventType, filename);
      loop.dirty = true;
      wake(name);
    });
    watchers.set(name, watcher);

    while (!stopping) {
      try {
        await round(loop, options, (what) => {
          lastAction = name + ": " + what;
          lastError = undefined;
        });
        loop.failures = 0;
        timing = loop.timing;
      } catch (err) {
        // A space that cannot be reached this round is not a reason to stop the
        // agent: the network blinks, and the next round tries again.
        lastError = name + ": " + (err instanceof Error ? err.message : String(err));
        loop.failures = (loop.failures ?? 0) + 1;
      }
      rounds++;
      write(spacesSeen);
      // Sleep until the next turn, or until something happens.
      if (pending.delete(name)) continue;
      const sleepMs = roundSleepMs({
        paused: loop.paused,
        connected: loop.events.connected,
        supported: loop.events.supported,
        retryAfterMs: loop.retryAfterMs,
        pollMs,
        failures: loop.failures,
      });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wakeups.delete(name);
          resolve();
        }, sleepMs);
        wakeups.set(name, () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (beat) clearTimeout(beat);
    loop.events.stop();
  };

  // What the fleet told a space. The socket only says that something happened;
  // the loop does the work, so each case just changes what the next round does.
  const onEvent = (loop: SpaceLoop, event: FleetEvent): void => {
    switch (event.type) {
      case "hello":
        loop.paused = event.paused;
        // The lease length is what the heartbeat is derived from; take it if
        // no place has been taken yet to tell it.
        if (event.leaseMs > 0 && !loop.leaseMs) loop.leaseMs = event.leaseMs;
        wake(loop.name, true);
        break;
      case "paused":
        loop.paused = true;
        break;
      case "resumed":
        loop.paused = false;
        // Take a place now rather than at the next heartbeat.
        loop.lastBootstrap = 0;
        wake(loop.name, true);
        break;
      case "head":
        wake(loop.name, true);
        break;
      case "lease-free":
        // Whoever held the place has let go: ask for it.
        loop.primary = false;
        wake(loop.name, true);
        break;
      default:
        // "bye": the connection closes and is opened again by itself.
        break;
    }
    write(spacesSeen);
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
