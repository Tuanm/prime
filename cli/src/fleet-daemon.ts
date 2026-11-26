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

import { mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";

import { selfCommand } from "./code-mcp-host.ts";
import { loadConfig, type SpaceEntry } from "./config.ts";
import { CliError } from "./errors.ts";
import { acquireAgentLock, isFleetAgentProcess } from "./fleet-agent-lock.ts";
import { FAILING_MAX_MS, FleetEvents, roundSleepMs, type FleetEvent } from "./fleet-events.ts";
import { NotSealedError, NotSealedYetError, loadOrCreateKeyPair, publish, rosterOf, type MemberPaths } from "./fleet-agent.ts";
import {
  FETCHED_REPORT_MS,
  SOCKET_HEAD_SAFETY_MS,
  applyReady,
  placeDue,
  positions,
  prefetch,
  promote,
  promotionDelayMs,
  replicaMode,
  replicaSleepMs,
  type PlaceAnswer,
  type ReplicaMode,
} from "./fleet-replica.ts";
import { fleetAgentServiceStatus, installFleetAgentService, restartFleetAgentService } from "./fleet-service.ts";
import { cacheLimitMb, collectStore, storeBytes } from "./fleet-store.ts";
import { NestedRepoCache, settle, snapshot } from "./fleet-sync.ts";
import { fetchMemberKeys, releaseLease, reportApplied, type FleetCredentials } from "./fleet-transport.ts";
import { detectRuntime, spaceContainerRunning, type RuntimeInfo } from "./spaces.ts";
import { fleetKeyFile, fleetStateDir, readFleetState, writeFleetState, type FleetMemberState } from "./fleets.ts";

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
  /** How replicas are kept: `lazy` fetches ahead and applies when needed, `mirror` applies as it fetches. */
  replica?: ReplicaMode;
  /** What the agent runs with, so that a start that asks for something else can tell. */
  settings?: EffectiveSettings;
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
  /** How long a starting agent waits for another one that is stopping to let go. */
  lockWaitMs?: number;
  /**
   * This call speaks for the person at a shell (`prime fleets agent start`): the settings in
   * its environment are what they ask for, are remembered, and restart a running agent that
   * runs with others. Without it (creating a space just needs an agent) the remembered
   * settings stand, whatever the shell happens to export.
   */
  fromShell?: boolean;
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

/** What a person can set about how the agent works, and expects to stay set. */
export interface AgentSettings {
  /** `lazy` (the default) or `mirror`: see fleet-replica.ts. */
  replica?: ReplicaMode;
  /** The size the object store is collected at, in megabytes. */
  cacheMb?: number;
  /** How often a replica looks at the fleet's head, in milliseconds. */
  pollMs?: number;
  /** How often the primary renews its lease, at most, in milliseconds. */
  heartbeatMs?: number;
}

/** The settings with what they come to when nothing is set: what an agent runs with. */
export interface EffectiveSettings {
  replica: ReplicaMode;
  cacheMb: number;
  pollMs: number;
  heartbeatMs: number;
}

const DEFAULT_POLL_MS = 1500;
const DEFAULT_HEARTBEAT_MS = 15_000;

export function effectiveSettings(settings: AgentSettings): EffectiveSettings {
  return {
    replica: settings.replica ?? "lazy",
    cacheMb: settings.cacheMb ?? cacheLimitMb({}),
    pollMs: settings.pollMs ?? DEFAULT_POLL_MS,
    heartbeatMs: settings.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
  };
}

/** The environment variable each setting is given in. */
const SETTING_ENV = {
  replica: "PRIME_FLEET_REPLICA",
  cacheMb: "PRIME_FLEET_CACHE_MB",
  pollMs: "PRIME_FLEET_POLL_MS",
  heartbeatMs: "PRIME_FLEET_HEARTBEAT_MS",
} as const satisfies Record<keyof AgentSettings, string>;

const SETTING_KEYS = Object.keys(SETTING_ENV) as Array<keyof AgentSettings>;

function positive(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

function sanitize(raw: Record<string, unknown>): AgentSettings {
  const replica = raw.replica === "lazy" || raw.replica === "mirror" ? raw.replica : undefined;
  const cacheMb = positive(raw.cacheMb);
  const pollMs = positive(raw.pollMs);
  const heartbeatMs = positive(raw.heartbeatMs);
  return {
    ...(replica ? { replica } : {}),
    ...(cacheMb ? { cacheMb } : {}),
    ...(pollMs ? { pollMs } : {}),
    ...(heartbeatMs ? { heartbeatMs } : {}),
  };
}

export function agentSettingsPath(configPath: string): string {
  return join(fleetAgentDir(configPath), "settings.json");
}

export function readAgentSettings(configPath: string): AgentSettings {
  try {
    return sanitize(JSON.parse(readFileSync(agentSettingsPath(configPath), "utf8")) as Record<string, unknown>);
  } catch {
    return {};
  }
}

/** The settings an environment asks for: only values that mean something. */
export function settingsFromEnv(env: Record<string, string | undefined>): AgentSettings {
  return sanitize({
    replica: env.PRIME_FLEET_REPLICA,
    cacheMb: env.PRIME_FLEET_CACHE_MB,
    pollMs: env.PRIME_FLEET_POLL_MS,
    heartbeatMs: env.PRIME_FLEET_HEARTBEAT_MS,
  });
}

/** The settings an environment asks to be put back to their defaults: its variable is set, and empty. */
export function clearedByEnv(env: Record<string, string | undefined>): Array<keyof AgentSettings> {
  return SETTING_KEYS.filter((key) => env[SETTING_ENV[key]] === "");
}

/**
 * What the saved settings come to once a shell's environment (and the options of the
 * call) have had their say: a value they give replaces the saved one, and an empty
 * variable (`PRIME_FLEET_REPLICA=`) takes the saved one away.
 */
export function settingsAsked(
  saved: AgentSettings,
  env: Record<string, string | undefined>,
  options: FleetAgentOptions = {},
): AgentSettings {
  const merged: AgentSettings = { ...saved };
  for (const key of clearedByEnv(env)) delete merged[key];
  Object.assign(
    merged,
    settingsFromEnv(env),
    sanitize({ pollMs: options.pollMs, heartbeatMs: options.heartbeatMs }),
  );
  return merged;
}

function writeAgentSettings(configPath: string, settings: AgentSettings): void {
  const file = agentSettingsPath(configPath);
  if (Object.keys(settings).length === 0) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(fleetAgentDir(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(file + ".tmp", JSON.stringify(settings, null, 2), { mode: 0o600 });
  renameSync(file + ".tmp", file);
}

/**
 * Remember what the environment asks of the agent, and return what is in force.
 *
 * The agent is started from a shell (`prime fleets agent start`) or by the system
 * (a login service, a restart after a crash), and only the first has the variables
 * the person set. What they asked for is written down, so that every start - and the
 * service's - has it. Only `agent start` and `agent install` call this: a command that
 * merely needs an agent running (creating a space) has no say in how it runs.
 */
export function persistAgentSettings(
  configPath: string,
  env: Record<string, string | undefined> = process.env,
  options: FleetAgentOptions = {},
): AgentSettings {
  const saved = readAgentSettings(configPath);
  const settings = settingsAsked(saved, env, options);
  if (JSON.stringify(settings) !== JSON.stringify(saved)) writeAgentSettings(configPath, settings);
  return settings;
}

/** Forget every saved setting: the agent runs with its defaults from its next start. */
export function resetAgentSettings(configPath: string): void {
  rmSync(agentSettingsPath(configPath), { force: true });
}

/** In the agent itself: what was set and remembered applies unless this start says otherwise. */
export function applyAgentSettings(configPath: string, env: Record<string, string | undefined> = process.env): void {
  const settings = readAgentSettings(configPath);
  for (const key of SETTING_KEYS) {
    const name = SETTING_ENV[key];
    const value = settings[key];
    if (env[name] === undefined && value !== undefined) env[name] = String(value);
  }
}

/**
 * The environment the agent is started with.
 *
 * The agent needs almost nothing from the caller's environment. Copying all of it
 * would silently hand it unrelated credentials, so what it gets is a short list - and
 * the settings above, which are the one thing a person sets for it. With `shell` false
 * the environment has no say in them: the saved ones are what the agent runs with.
 */
export function buildAgentEnv(
  configPath: string,
  options: FleetAgentOptions,
  env: Record<string, string | undefined> = process.env,
  shell = true,
): Record<string, string | undefined> {
  const agentEnv: Record<string, string | undefined> = { PRIME_FLEET_AGENT_DIR: fleetAgentDir(configPath) };
  const saved = readAgentSettings(configPath);
  const settings = shell ? settingsAsked(saved, env, options) : saved;
  for (const key of SETTING_KEYS) {
    const value = settings[key];
    if (value !== undefined) agentEnv[SETTING_ENV[key]] = String(value);
  }
  const inherited = new Set([
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE",
    "TERM", "NO_COLOR", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
    "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  ]);
  for (const key of inherited) {
    const value = env[key];
    if (value !== undefined) agentEnv[key] = value;
  }
  return agentEnv;
}

/** Whether a running agent runs with other settings than the ones in force. */
function settingsDiffer(running: FleetAgentState, settings: AgentSettings): boolean {
  const wanted = effectiveSettings(settings);
  // An agent from before settings were recorded says only its mode.
  const has: Partial<EffectiveSettings> = running.settings ?? { replica: running.replica ?? "lazy" };
  return SETTING_KEYS.some((key) => has[key] !== undefined && has[key] !== wanted[key]);
}

/** How the agent's login service is asked about and restarted; replaced in tests. */
export interface AgentServiceHooks {
  /** Whether a login service runs the agent here (one that a service manager can restart). */
  installed(): boolean;
  /** The pid the service manager runs the agent as, when it is running. */
  pid(): number | undefined;
  /** Ask the service manager to (re)start it; false when it would not. */
  restart(): boolean;
  /** How long a running agent is given to stop when it is replaced, or to come back (tests make it short). */
  stopWaitMs?: number;
}

const systemService: AgentServiceHooks = {
  installed: () => {
    // Only where the manager can be asked to restart it: elsewhere the agent is started as it always was.
    if (process.platform !== "darwin" && process.platform !== "linux") return false;
    try {
      return fleetAgentServiceStatus().installed;
    } catch {
      return false;
    }
  },
  pid: () => {
    try {
      return fleetAgentServiceStatus().pid;
    } catch {
      return undefined;
    }
  },
  restart: () => restartFleetAgentService(),
};

/** How long a running agent is given to stop when it has to be replaced (it may be finishing a round). */
const STOP_WAIT_MS = 15_000;

/**
 * Ensure the agent is running; returns its metadata.
 *
 * The agent is started the same way the vault broker is: a detached child
 * that writes a state file, with only the environment it needs. If one is running
 * and the person asks for a different replica mode, it is restarted: starting it
 * "again" must not quietly leave it as it was.
 *
 * An agent that the login service runs is restarted by the service manager, which
 * would start another beside any that this process spawned; and no second agent is
 * ever spawned while the old one is still alive.
 */
export async function ensureFleetAgent(
  configPath: string,
  options: FleetAgentOptions = {},
  service: AgentServiceHooks = systemService,
): Promise<FleetAgentState> {
  const shell = options.fromShell === true;
  const settings = shell ? persistAgentSettings(configPath, process.env, options) : readAgentSettings(configPath);
  const waitMs = service.stopWaitMs ?? STOP_WAIT_MS;
  const managed = service.installed();
  let existing = runningAgent(configPath);
  if (existing && managed && service.pid() !== existing.pid) {
    // An agent that is not the service's, beside a service that would start its own: one of
    // them has to go, and it is this one (an agent started by hand, or left from before the
    // service was installed).
    await stopAndWait(configPath, existing, waitMs);
    existing = undefined;
  }
  if (existing) {
    if (!settingsDiffer(existing, settings)) return existing;
    if (!managed) {
      await stopAndWait(configPath, existing, waitMs);
      existing = undefined;
    }
  }
  if (managed) {
    // The service manager starts it (or restarts it, to take the new settings): nothing is
    // spawned beside the service's own agent.
    if (!service.restart()) {
      throw new CliError(
        "the fleet agent's service would not start it",
        "run 'prime fleets agent install' to set the service up again",
      );
    }
    const deadline = Date.now() + waitMs;
    for (;;) {
      const state = runningAgent(configPath);
      if (state && state.pid !== existing?.pid) return state;
      if (Date.now() > deadline) throw new CliError("the fleet agent did not come back after the service was restarted");
      await Bun.sleep(100);
    }
  }
  rmSync(fleetAgentStatePath(configPath), { force: true });
  mkdirSync(fleetAgentDir(configPath), { recursive: true, mode: 0o700 });
  const agentEnv = buildAgentEnv(configPath, options, process.env, shell);
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
    const state = runningAgent(configPath);
    if (state) return state;
    if (Date.now() > deadline) throw new CliError("the fleet agent did not start");
    await Bun.sleep(50);
  }
}

/** The state of the agent that is running, if one is: its pid is alive and is an agent (not a pid that was reused). */
function runningAgent(configPath: string): FleetAgentState | undefined {
  const state = readFleetAgentState(configPath);
  return state && isFleetAgentProcess(state.pid, fleetAgentDir(configPath)) ? state : undefined;
}

/** Ask the agent to stop and wait for it to be gone; never leave it to be started beside. */
async function stopAndWait(configPath: string, state: FleetAgentState, waitMs: number): Promise<void> {
  stopFleetAgent(configPath);
  const gone = Date.now() + waitMs;
  while (pidAlive(state.pid) && Date.now() < gone) await Bun.sleep(50);
  if (pidAlive(state.pid)) {
    throw new CliError(
      "the running fleet agent (pid " + state.pid + ") has not stopped yet",
      "it may be finishing a round: try again in a moment",
    );
  }
}

/**
 * Install the agent as a login service. An agent that is already running is stopped first and
 * waited for: the service starts its own, and two of them would act as the primary for the
 * same spaces (an agent from before the lock existed would not even notice the other).
 */
export async function installFleetAgent(
  configPath: string,
  deps: { install: () => string; stopWaitMs?: number } = { install: () => installFleetAgentService(configPath) },
): Promise<string> {
  // The service starts without this shell's environment: what was set here is written down for it.
  persistAgentSettings(configPath);
  const running = runningAgent(configPath);
  if (running) await stopAndWait(configPath, running, deps.stopWaitMs ?? STOP_WAIT_MS);
  return deps.install();
}

/** Stop the agent. Returns true when one was running. */
export function stopFleetAgent(configPath: string): boolean {
  const state = readFleetAgentState(configPath);
  if (!state) return false;
  // A pid left in the state by an agent that is gone may belong to anything now.
  const agent = isFleetAgentProcess(state.pid, fleetAgentDir(configPath));
  if (agent) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {}
  }
  rmSync(fleetAgentStatePath(configPath), { force: true });
  return agent;
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
  replica?: ReplicaMode;
} {
  const state = runningAgent(configPath);
  if (!state) return { running: false };
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
    ...(state.replica ? { replica: state.replica } : {}),
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

/** When the object store is collected: from this size, and again after it has grown by this much (bytes). */
export const collectPolicy = { fromBytes: 32 * 1024 * 1024, growthBytes: 64 * 1024 * 1024 };

/**
 * Let go of what the object store no longer needs, once it has grown.
 *
 * It is looked at every ten minutes, once a round is over (so nothing of this
 * space is in flight). It is collected when it has passed 32 MB for the first
 * time, and then only after it has grown by 64 MB or by half of what a collection
 * left (the cap, PRIME_FLEET_CACHE_MB, makes no difference to that: a store that
 * holds nothing but what is in use is over the cap for as long as the tree is big,
 * and collecting it again and again would free nothing). What is kept is the
 * snapshot the work tree holds, the newest one fetched, and what the indexes name.
 * A store that is over the cap even so is said to be, once.
 */
export async function maybeCollect(loop: SpaceLoop, report: (what: string) => void, now: number = Date.now()): Promise<void> {
  if (now - (loop.lastStoreCheck ?? 0) < 10 * 60_000) return;
  loop.lastStoreCheck = now;
  const size = storeBytes(loop.paths.gitDir);
  const cap = cacheLimitMb() * 1024 * 1024;
  const left = loop.storeAfterCollect;
  const grown = left === undefined ? size > collectPolicy.fromBytes || size > cap : size - left > Math.max(collectPolicy.growthBytes, left / 2);
  if (!grown) return;
  const state = readFleetState(loop.configPath, loop.fleet, loop.name);
  const done = await collectStore(loop.paths.gitDir, [state.base, state.fetchedCommit]);
  if (!done) return;
  loop.storeAfterCollect = done.after;
  report("collected the object store: " + Math.round(done.before / 1048576) + " MB to " + Math.round(done.after / 1048576) + " MB");
  if (done.after > cap && !loop.capWarned) {
    loop.capWarned = true;
    report("the object store is " + Math.round(done.after / 1048576) + " MB, over the cap of " + Math.round(cap / 1048576) + " MB: it holds only what is in use");
  } else if (done.after <= cap) {
    loop.capWarned = false;
  }
}

// An error from the file system that says the work tree cannot be written to.
function cannotWrite(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && ["EACCES", "EPERM", "ENOSPC", "EROFS", "EDQUOT", "EMFILE"].includes(code);
}

/**
 * How long a space's loop sleeps before its next round.
 *
 * A replica that does not mirror sleeps long (see `replicaSleepMs`); the primary
 * keeps the pace it had. A claim that is waiting for its time wakes the round then,
 * but only for a replica that is running and well: one whose rounds are failing
 * waits as `roundSleepMs` says (a gateway that is down, over its budget or asking
 * for time must not be asked five times a second), and a member that holds the
 * place has no claim to wait for.
 */
export function loopSleepMs(loop: SpaceLoop, pollMs: number, now: number = Date.now()): number {
  const idle = loop.primary
    ? { pollMs, idleMs: undefined }
    : replicaSleepMs({ mode: replicaMode(), connected: loop.events.connected, pollMs, ...(loop.leaseMs ? { leaseMs: loop.leaseMs } : {}) });
  const sleepMs = roundSleepMs({
    paused: loop.paused,
    connected: loop.events.connected,
    supported: loop.events.supported,
    retryAfterMs: loop.retryAfterMs,
    pollMs: idle.pollMs,
    ...(idle.idleMs !== undefined ? { idleMs: idle.idleMs } : {}),
    failures: loop.failures,
  });
  if (loop.claim && !loop.primary && !loop.paused) {
    const failures = Math.min(30, loop.failures ?? 0);
    // A replica that is waiting to take the lease and whose round failed backs off from the
    // poll's pace, not from the long wait of an idle replica with a socket: the lease is free,
    // and one failed request must not put the only replica to sleep for minutes.
    // A refusal that said when to ask again (429, 503 with retry-after) is waited for, not asked again in three seconds.
    if (failures > 0) return Math.max(200, loop.claimAt - now, Math.min(FAILING_MAX_MS, Math.max(loop.refusedForMs ?? 0, pollMs * 2 ** failures)));
    return Math.min(sleepMs, Math.max(200, loop.claimAt - now));
  }
  return sleepMs;
}

/**
 * One beat of the clock a space keeps for its place, apart from its round.
 *
 * A primary renews on every beat. A replica has nothing to renew: it looks now
 * and then (see placeDue). What the fleet answers is acted on as it is anywhere
 * else - a replica that is told it could have a free lease sets about taking it,
 * and `wake` rouses the round that will. A paused fleet takes no one in, and a
 * space whose rounds keep failing is retried by the round, on its longer wait.
 */
export async function heartbeat(loop: SpaceLoop, wake: () => void, now: number = Date.now()): Promise<boolean> {
  const due =
    loop.primary ||
    placeDue({
      primary: false,
      now,
      lastBootstrap: loop.lastBootstrap,
      heartbeatMs: 0,
      wanted: false,
      eventsConnected: loop.events.connected,
      ...(loop.leaseMs ? { leaseMs: loop.leaseMs } : {}),
    });
  // A space whose rounds keep failing leaves asking to the round and its longer wait - unless it holds
  // the place: the lease is what is at stake, and renewing it is one cheap request.
  if (loop.paused || (!loop.primary && (loop.failures ?? 0) > 0) || !due) return true;
  try {
    const answer = await takePlace(loop);
    // A renewal that is already on its way (the round's) is not this one's: look again soon.
    if (answer.busy) {
      loop.beatRetryMs = BEAT_RETRY_MS;
      return false;
    }
  } catch (err) {
    // Tried again soon: the place is held for three intervals, and waiting out one of them is a third of it.
    loop.beatRetryMs = renewalRetryMs(err, loop.leaseMs);
    return false;
  }
  if (loop.claim) wake();
  return true;
}

/** One space as the agent keeps it (exported so a round can be driven in a test). */
export interface SpaceLoop {
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
  /** How long the gateway asked to be left alone after it refused the last request for the place. */
  refusedForMs?: number;
  /** The held connection that tells this space what happened. */
  events: FleetEvents;
  /** Rounds in a row that failed; the agent waits longer after each. */
  failures?: number;
  /** A replica should try to become the primary once `claimAt` has passed. */
  claim: boolean;
  /** What the fleet said the last time the member asked for its place. */
  lastAnswer?: PlaceAnswer;
  /** How soon the next beat is due after one that failed (see `renewalRetryMs`). */
  beatRetryMs?: number;
  /** The member is in the middle of trying to take the lease: takePlace leaves the claim to it. */
  promoting?: boolean;
  claimAt: number;
  /** The socket said the head moved, so there is something to fetch. */
  headDirty: boolean;
  /** The newest head sequence the socket has mentioned. */
  knownHeadSeq?: number;
  /** Its manifest, when the socket named it. */
  knownHeadManifest?: string;
  /** When the replica last told the fleet how far it has fetched. */
  lastFetchedReport?: number;
  /** When the object store was last looked at, and when it was last collected. */
  lastStoreCheck?: number;
  /** What the object store held after the last collection, and whether the cap was said to be passed. */
  storeAfterCollect?: number;
  capWarned?: boolean;
  /** When the head was last looked at; a replica that is told does not ask. */
  lastHeadCheck: number;
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
export async function round(loop: SpaceLoop, options: FleetAgentOptions, report: (what: string) => void): Promise<void> {
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
    loop.claim = false;
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
  } else if (
    placeDue({
      primary: loop.primary,
      now: Date.now(),
      lastBootstrap: loop.lastBootstrap,
      heartbeatMs: heartbeatCeiling(loop, options.heartbeatMs!),
      // A replica is only told to look when there is a reason: it asks for the
      // place when the lease is freed or when the first look said it could have it.
      wanted: loop.claim && Date.now() >= loop.claimAt,
      eventsConnected: loop.events.connected,
      ...(loop.leaseMs ? { leaseMs: loop.leaseMs } : {}),
    })
  ) {
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

  // A replica. It does not mirror: it keeps what the fleet publishes in its own
  // object store, and writes it over the work tree only when it has to. A person
  // who wants the mirror current asks (`prime fleets sync`), or sets
  // PRIME_FLEET_REPLICA=mirror to have every snapshot written as it arrives.
  loop.primary = false;
  const mode = replicaMode();
  const keep = (patch: Partial<FleetMemberState>): void => {
    writeFleetState(loop.configPath, fleet, loop.name, { ...readFleetState(loop.configPath, fleet, loop.name), ...patch });
  };

  // The lease was freed (or this member could have had it): try to take it.
  // The fleet gives it to a member that has applied the head, so a replica that
  // has only fetched writes the work tree first - and one that loses the race
  // stays what it was, having done nothing the fleet has to know about.
  if (loop.claim && Date.now() >= loop.claimAt) {
    loop.claim = false;
    loop.promoting = true;
    const began = Date.now();
    let outcome: Awaited<ReturnType<typeof promote>>;
    try {
      outcome = await promote({
        takePlace: () => takePlace(loop),
        catchUp: async () => {
          const now = readFleetState(loop.configPath, fleet, loop.name);
          await prefetch(creds, fleet, paths, now, keep);
          const done = await applyReady(creds, fleet, paths, readFleetState(loop.configPath, fleet, loop.name), keep, { report: true });
          if (done?.kept) report("kept " + done.kept.moved + " locally changed path(s) aside in " + done.kept.to);
        },
      });
    } catch (err) {
      // It could not catch up (the network, a failed apply): the member is still
      // eligible, and tries again once the round has backed off.
      // Eligible again once the round has backed off - unless nothing it can do
      // will change the answer: a snapshot sealed for it that does not exist yet (and
      // there is no primary to publish one), a key it no longer has, a work tree it
      // cannot write. Asking again would only keep the claim from a replica that can.
      loop.claim = !(err instanceof NotSealedYetError || err instanceof NotSealedError || cannotWrite(err));
      loop.claimAt = Date.now();
      throw err;
    } finally {
      loop.promoting = false;
    }
    loop.timing.pull = Date.now() - began;
    if (outcome === "primary") {
      report("took over at " + positions(readFleetState(loop.configPath, fleet, loop.name)).applied.seq);
      return;
    }
    // Another replica is catching up first, or the question was already being
    // asked: ask again soon, not at the next safety check.
    if (outcome === "claimed") {
      loop.claim = true;
      loop.claimAt = Date.now() + (loop.lastAnswer?.retryAfterMs ?? 30_000) + Math.floor(Math.random() * 2000);
    } else if (outcome === "busy" || outcome === "gave-up") {
      loop.claim = true;
      loop.claimAt = Date.now() + 1_000;
    }
  }

  // Look at the head when the fleet said it moved (the socket's news, or the
  // head that came with the answer when this member asked for its place). A
  // replica that does not mirror has no use for a fresher head than that, so it
  // does not ask for one: now and then in case a message was lost, with a socket
  // - and without one, the next time it asks for its place. A replica that
  // mirrors wants a fresh work tree and looks every round.
  const now = Date.now();
  const lazy = mode === "lazy" && positions(readFleetState(loop.configPath, fleet, loop.name)).applied.commit !== null;
  if (lazy) {
    const overdue = loop.events.connected && now - loop.lastHeadCheck >= SOCKET_HEAD_SAFETY_MS;
    if (!loop.headDirty && !overdue && loop.lastHeadCheck !== 0) return;
  } else if (!loop.headDirty && loop.events.connected && now - loop.lastHeadCheck < 30_000 && loop.lastHeadCheck !== 0) {
    return;
  }
  loop.headDirty = false;
  loop.lastHeadCheck = now;

  const pullBegan = Date.now();
  const fetchedState = readFleetState(loop.configPath, fleet, loop.name);
  // The socket said which manifest is the head: no need to ask the gateway.
  const hint =
    loop.knownHeadManifest && loop.knownHeadSeq !== undefined && loop.knownHeadSeq > positions(fetchedState).fetched.seq
      ? { seq: loop.knownHeadSeq, manifestKey: loop.knownHeadManifest }
      : undefined;
  const got = await prefetch(creds, fleet, paths, fetchedState, keep, hint);
  loop.timing.pull = Date.now() - pullBegan;
  if (got.evicted > 0) report("snapshots the catch-up needed were let go by the gateway meanwhile (" + got.evicted + " times): it was planned again");
  if (got.steps > 0) {
    report("fetched " + got.fetched.seq);
    // Tell the fleet how far this member has fetched, as seldom as is useful: it
    // is for whoever reads the fleet, and nothing waits on it.
    if (Date.now() - (loop.lastFetchedReport ?? 0) > FETCHED_REPORT_MS) {
      loop.lastFetchedReport = Date.now();
      await reportApplied(creds, fleet, positions(readFleetState(loop.configPath, fleet, loop.name)).applied.seq, got.fetched.seq).catch(() => false);
    }
  }
  // A member that has never applied anything has no baseline: whatever else it
  // is set to, it is given one, once.
  if (mode === "mirror" || fetchedState.base === undefined) {
    const done = await applyReady(creds, fleet, paths, readFleetState(loop.configPath, fleet, loop.name), keep);
    if (done) {
      if (done.kept) report("kept " + done.kept.moved + " locally changed path(s) aside in " + done.kept.to + ", then caught up");
      report("applied " + done.applied.seq);
    }
  }
}


/** The gateway answered the request for the place with a refusal (a 5xx, a 429, a 402): it did not get lost. */
export class PlaceRefused extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
  }
}

interface BootstrapResult {
  ok: boolean;
  /** The gateway answered (with a refusal), rather than the request failing on the way. */
  answered?: boolean;
  primary: boolean;
  error?: string;
  /** The fleet is paused: it will not take anyone in until it is resumed. */
  paused?: boolean;
  /** How long the fleet asked to wait before looking again. */
  retryAfterMs?: number;
  /** How long the fleet says a place lasts; the heartbeat is derived from it. */
  ttlMs?: number;
  /** Why a replica was not given the lease (`lease-held`, `not-caught-up`). */
  reason?: string;
  /** For `not-caught-up`: the sequence to have applied first. */
  catchUpTo?: number;
  /** The head, as the fleet had it when it answered. */
  head?: { seq: number; manifestKey?: string };
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
    // Asking for the place is how the lease is renewed: a request that hangs for
    // a minute would outlast the lease, so it is cut short (and asked again).
    signal: AbortSignal.timeout(Math.min(creds.timeoutMs ?? PLACE_TIMEOUT_MS, PLACE_TIMEOUT_MS)),
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
    // The gateway answered, and may have said when to ask again.
    const after = Number(res.headers.get("retry-after"));
    return {
      ok: false,
      primary: false,
      error: "status " + res.status,
      ...(Number.isFinite(after) && after > 0 ? { retryAfterMs: after * 1000 } : {}),
      answered: true,
    };
  }
  const body = (await res.json()) as {
    role?: string;
    ttlMs?: number;
    reason?: string;
    catchUpTo?: number;
    retryAfterMs?: number;
    head?: { seq?: number; manifestKey?: string };
  };
  return {
    ok: true,
    primary: body.role === "primary",
    ...(typeof body.ttlMs === "number" && body.ttlMs > 0 ? { ttlMs: body.ttlMs } : {}),
    ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
    ...(typeof body.catchUpTo === "number" ? { catchUpTo: body.catchUpTo } : {}),
    ...(typeof body.retryAfterMs === "number" && body.retryAfterMs > 0 ? { retryAfterMs: body.retryAfterMs } : {}),
    ...(body.head && typeof body.head.seq === "number" && body.head.seq > 0
      ? { head: { seq: body.head.seq, ...(typeof body.head.manifestKey === "string" && body.head.manifestKey ? { manifestKey: body.head.manifestKey } : {}) } }
      : {}),
  };
}

/** The longest a request for the place may take: under a quarter of the lease. */
export const PLACE_TIMEOUT_MS = 10_000;
/** How soon after a renewal that failed the next is tried, rather than a whole interval later. */
export const BEAT_RETRY_MS = 2_000;

/** When the next beat is due: an interval after one that went through, soon after one that did not. */
export function nextBeatDelayMs(ok: boolean, intervalMs: number, retryMs: number = BEAT_RETRY_MS): number {
  return ok ? intervalMs : Math.min(intervalMs, retryMs);
}

/**
 * When to try a renewal again after one that failed.
 *
 * A request that got lost on the way is tried again at once (two seconds): the gateway never
 * saw it. A request the gateway answered with a refusal is not hammered: it is asked again
 * when it said to (retry-after), or in a few seconds, and never later than a third of the
 * lease - the place is at stake, and the gateway is struggling, not gone.
 */
export function renewalRetryMs(err: unknown, leaseMs: number = 45_000): number {
  if (!(err instanceof PlaceRefused)) return BEAT_RETRY_MS;
  return Math.min(Math.floor(leaseMs / 3), Math.max(BEAT_RETRY_MS, err.retryAfterMs ?? 5_000));
}

/**
 * How often a primary renews its place: a third of the lease the fleet reports,
 * so that two renewals can be lost in a row and the place is still held, and
 * never more rarely than the ceiling. The lease is forty-five seconds, so fifteen.
 */
export function heartbeatIntervalMs(leaseMs: number | undefined, ceilingMs: number): number {
  return Math.max(500, Math.min(ceilingMs, Math.floor((leaseMs ?? 45_000) / 3)));
}

function heartbeatFor(loop: SpaceLoop, ceilingMs: number): number {
  return heartbeatIntervalMs(loop.leaseMs, ceilingMs);
}

/**
 * Take (or take back) this space's place in the fleet.
 *
 * Callable outside the round on purpose: a round can spend a minute pulling a
 * large pack, and the place in the fleet does not wait for that. The heartbeat
 * is on a timer of its own, so the lease is renewed while the work is still
 * arriving.
 */
async function takePlace(loop: SpaceLoop): Promise<PlaceAnswer> {
  // Asked while another ask is in flight (the heartbeat and the round meet): not
  // a "no" from the fleet, and not to be taken for one.
  if (loop.placing) return { primary: loop.primary, busy: true };
  loop.placing = true;
  try {
    const keys = loadOrCreateKeyPair(loop.paths.keyFile);
    const placed = await bootstrapHere(loop.creds, loop.fleet, keys.publicKey, loop.name);
    loop.lastBootstrap = Date.now();
    if (placed.paused) {
      loop.paused = true;
      loop.primary = false;
      loop.retryAfterMs = placed.retryAfterMs;
      return { primary: false, paused: true };
    }
    if (!placed.ok) {
      loop.refusedForMs = placed.retryAfterMs;
      throw new PlaceRefused(placed.error ?? "refused", placed.retryAfterMs);
    }
    loop.refusedForMs = undefined;
    loop.paused = false;
    loop.primary = placed.primary;
    // What the fleet says a place lasts. An agent that renews at its own pace
    // against a lease it never asked about is how a live primary loses it.
    if (placed.ttlMs) loop.leaseMs = placed.ttlMs;
    // The answer says where the head is: that is how a replica without a socket
    // learns that there is something to fetch, without asking again.
    if (placed.head && !placed.primary) {
      const fetched = positions(readFleetState(loop.configPath, loop.fleet, loop.name)).fetched.seq;
      if (placed.head.seq > (loop.knownHeadSeq ?? 0)) {
        loop.knownHeadSeq = placed.head.seq;
        if (placed.head.manifestKey) loop.knownHeadManifest = placed.head.manifestKey;
        else delete loop.knownHeadManifest;
      }
      if (placed.head.seq > fetched) loop.headDirty = true;
    }
    const answer: PlaceAnswer = {
      primary: placed.primary,
      ...(placed.reason ? { reason: placed.reason } : {}),
      ...(placed.catchUpTo !== undefined ? { catchUpTo: placed.catchUpTo } : {}),
      ...(placed.retryAfterMs !== undefined ? { retryAfterMs: placed.retryAfterMs } : {}),
    };
    loop.lastAnswer = answer;
    // Whoever asked - the round, the heartbeat, a promotion - the answer sets what
    // the member does next. While it is already trying to take the lease that is
    // the promotion's own business.
    // A member that has the place has nothing to claim, and a claim left set would
    // keep its round at the pace of a replica that is waiting for its turn.
    if (placed.primary) loop.claim = false;
    if (!placed.primary && !loop.promoting) {
      if (answer.reason === "not-caught-up") {
        // The lease is free and this member could have it once it has applied the head.
        loop.claim = true;
        loop.claimAt = Math.min(loop.claimAt || Date.now(), Date.now());
      } else if (answer.reason === "claimed") {
        // Another replica is catching up to take it: ask again when its claim runs out.
        loop.claim = true;
        loop.claimAt = Date.now() + (answer.retryAfterMs ?? 30_000);
      } else if (answer.reason === "lease-held") {
        loop.claim = false;
      }
    }
    return answer;
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
  // Two agents for the same spaces would both act as the primary. A restart finds the old
  // one still finishing its round, so it is given a moment to let go.
  const lock = await acquireAgentLock(fleetAgentDir(configPath), { waitMs: options.lockWaitMs ?? 10_000 });
  if (!lock.held) {
    process.stderr.write("another fleet agent is already running" + (lock.holder > 0 ? " (pid " + lock.holder + ")" : "") + "; this one exits\n");
    process.exitCode = 1;
    return;
  }
  try {
    await runFleetAgentLocked(configPath, options);
  } finally {
    lock.release();
  }
}

async function runFleetAgentLocked(configPath: string, options: FleetAgentOptions): Promise<void> {
  // What a person set (and the service was never told) is read from where it was written down.
  applyAgentSettings(configPath);
  const env = process.env;
  const pollMs = options.pollMs ?? positive(env.PRIME_FLEET_POLL_MS) ?? DEFAULT_POLL_MS;
  // The heartbeat never exceeds this; the fleet's own lease can lower it.
  const heartbeatMs = options.heartbeatMs ?? positive(env.PRIME_FLEET_HEARTBEAT_MS) ?? DEFAULT_HEARTBEAT_MS;
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
      replica: replicaMode(),
      settings: { ...effectiveSettings(settingsFromEnv(env)), pollMs, heartbeatMs },
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
      claim: false,
      claimAt: 0,
      headDirty: false,
      lastHeadCheck: 0,
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
    let beatOk = true;
    const beatTick = (): void => {
      const interval = heartbeatFor(loop, heartbeatCeiling(loop, options.heartbeatMs ?? heartbeatMs));
      beat = setTimeout(() => {
        void heartbeat(loop, () => wake(name, true))
          .then((ok) => void (beatOk = ok))
          .catch(() => void (beatOk = false))
          .finally(beatTick);
      }, nextBeatDelayMs(beatOk, interval, loop.beatRetryMs));
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
        const say = (what: string): void => {
          lastAction = name + ": " + what;
          lastError = undefined;
        };
        await round(loop, options, say);
        await maybeCollect(loop, say).catch(() => undefined);
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
      const sleepMs = loopSleepMs(loop, pollMs);
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
  const claimNow = (loop: SpaceLoop): void => {
    const here = positions(readFleetState(loop.configPath, loop.fleet, loop.name)).fetched.seq;
    loop.claim = true;
    loop.claimAt = Date.now() + promotionDelayMs(loop.creds.deviceId, here < (loop.knownHeadSeq ?? 0));
    // The round sleeps until something wakes it: this is that something.
    setTimeout(() => wake(loop.name, true), Math.max(0, loop.claimAt - Date.now()) + 5).unref?.();
  };

  const onEvent = (loop: SpaceLoop, event: FleetEvent): void => {
    switch (event.type) {
      case "hello":
        loop.paused = event.paused;
        // The lease length is what the heartbeat is derived from; take it if
        // no place has been taken yet to tell it.
        if (event.leaseMs > 0 && !loop.leaseMs) loop.leaseMs = event.leaseMs;
        // Nobody holds the place: a replica may as well try for it.
        if (event.leaseHolder === null && !loop.primary) claimNow(loop);
        loop.headDirty = true;
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
        if (event.seq >= (loop.knownHeadSeq ?? 0)) {
          loop.knownHeadSeq = event.seq;
          if (event.manifestKey) loop.knownHeadManifest = event.manifestKey;
          else delete loop.knownHeadManifest;
        }
        loop.headDirty = true;
        wake(loop.name, true);
        break;
      case "lease-free":
        // Whoever held the place has let go: ask for it - after a wait that
        // is shorter for the members that are further ahead, so they do not
        // all write their work tree for the same lease.
        loop.primary = false;
        claimNow(loop);
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
