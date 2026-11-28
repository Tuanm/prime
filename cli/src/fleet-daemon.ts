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

import { mkdirSync, readFileSync, rmSync, watch, type FSWatcher } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { selfCommand } from "./code-mcp-host.ts";
import { loadConfig, type SpaceEntry } from "./config.ts";
import { CliError } from "./errors.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { commandOf, isFleetAgentProcess } from "./fleet-agent-lock.ts";
import { acquireStarting, claimSuccessor, clearSuccessor, isSuccessorProcess, mayAskAgainToStop, takeHandoverEnv, readSuccessor, registerSuccessor, requestStop, stopSuccessor, stopWaitingSuccessor as stopWaiting, watchForStop } from "./fleet-agent-handover.ts";
import { FAILING_MAX_MS, FleetEvents, roundSleepMs, type FleetEvent } from "./fleet-events.ts";
import { NotSealedError, NotSealedYetError, dropPreviousKey, loadOrCreateKeyPair, previousKeyPair, publish, rosterOf, type MemberPaths } from "./fleet-agent.ts";
import { keyFingerprintOf, proveKeyChange, type KeyProof } from "./fleet-crypto.ts";
import { TamperedSnapshotError } from "./fleet-trust.ts";
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
import { fleetAgentServiceConfig, fleetAgentServiceRuns, fleetAgentServiceStatus, startFleetAgentTask, sameConfig, installFleetAgentService, restartFleetAgentService, stopFleetAgentService, uninstallFleetAgentService } from "./fleet-service.ts";
import { commandRuns, runsProgram } from "./fleet-paths.ts";
import { cacheLimitMb, collectStore, storeBytes } from "./fleet-store.ts";
import { IgnoreFilter } from "./fleet-ignore.ts";
import { NestedRepoCache, SETTLE_QUIET_MS, settle, snapshot, stampTree } from "./fleet-sync.ts";
import { fetchMemberKeys, fetchRole, fetchRoster, releaseLease, reportApplied, type FleetCredentials } from "./fleet-transport.ts";
import { detectRuntime, spaceContainerRunning, type RuntimeInfo } from "./spaces.ts";
import { fleetKeyFile, fleetStateDir, readFleetState, recordedPosition, updateFleetState, writeFleetState, type FleetMemberState } from "./fleets.ts";

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

/**
 * Write the agent's state so that a reader sees the old one or the new one, never half of it
 * (a reader that finds it empty takes the agent for gone): written beside it, then renamed over it.
 */
export function writeAgentState(configPath: string, state: FleetAgentState): void {
  const file = fleetAgentStatePath(configPath);
  writeFileAtomic(file, JSON.stringify(state));
}

/**
 * Whether the state file is this process's to write or remove: it is not there, it names this
 * pid, or it names an agent that is gone. One that names another live pid is that agent's.
 */
export function ownsAgentState(configPath: string, pid: number = process.pid): boolean {
  const state = readFleetAgentState(configPath);
  return state === undefined || state.pid === pid || !pidAlive(state.pid);
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
  /** How long the files must have been still before a change is taken, in milliseconds. */
  settleMs?: number;
}

/** The settings with what they come to when nothing is set: what an agent runs with. */
export interface EffectiveSettings {
  replica: ReplicaMode;
  cacheMb: number;
  pollMs: number;
  heartbeatMs: number;
  settleMs: number;
}

const DEFAULT_POLL_MS = 1500;
const DEFAULT_HEARTBEAT_MS = 15_000;

export function effectiveSettings(settings: AgentSettings): EffectiveSettings {
  return {
    replica: settings.replica ?? "lazy",
    cacheMb: settings.cacheMb ?? cacheLimitMb({}),
    pollMs: settings.pollMs ?? DEFAULT_POLL_MS,
    heartbeatMs: settings.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    settleMs: settings.settleMs ?? SETTLE_QUIET_MS,
  };
}

/** The environment variable each setting is given in. */
const SETTING_ENV = {
  replica: "PRIME_FLEET_REPLICA",
  cacheMb: "PRIME_FLEET_CACHE_MB",
  pollMs: "PRIME_FLEET_POLL_MS",
  heartbeatMs: "PRIME_FLEET_HEARTBEAT_MS",
  settleMs: "PRIME_FLEET_SETTLE_MS",
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
  const settleMs = positive(raw.settleMs);
  return {
    ...(replica ? { replica } : {}),
    ...(cacheMb ? { cacheMb } : {}),
    ...(pollMs ? { pollMs } : {}),
    ...(heartbeatMs ? { heartbeatMs } : {}),
    ...(settleMs ? { settleMs } : {}),
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
    settleMs: env.PRIME_FLEET_SETTLE_MS,
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
    sanitize({ pollMs: options.pollMs, heartbeatMs: options.heartbeatMs, settleMs: options.settleMs }),
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
  writeFileAtomic(file, JSON.stringify(settings, null, 2));
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
  // A command started this agent after the old one was gone: if the lock is held it lost a race, and leaves at once.
  const agentEnv: Record<string, string | undefined> = { PRIME_FLEET_AGENT_DIR: fleetAgentDir(configPath), PRIME_FLEET_LOCK_WAIT_MS: "0" };
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

/** A process that was started to be the agent: its pid, and its exit code once it has exited. */
export interface StartedAgent {
  pid: number;
  exitCode: number | null;
}

/** How the agent's login service is asked about and restarted; replaced in tests. */
export interface AgentServiceHooks {
  /** Whether a login service runs the agent here (one that a service manager can restart). */
  installed(): boolean;
  /** The pid the service manager runs the agent as, when it is running. */
  pid(): number | undefined;
  /**
   * Whether a service is installed for this configuration and its manager cannot be reached from
   * here (no login session, no user bus): `installed()` is then false, but an agent that is
   * running may well be the service's own.
   */
  unreachable?(): boolean;
  /**
   * Ask the service manager to (re)start it; false when it would not. `gentle` asks for the running
   * agent to be stopped the way the manager stops it for good, and not to be waited for.
   */
  restart(gentle?: boolean): boolean;
  /** Whether the service runs this program (undefined: its definition cannot say). Replaced in tests. */
  runs?(target: string): boolean | undefined;
  /**
   * Windows: whether a Scheduled Task is registered for this configuration's agent (`installed()` is false there: the
   * agent is not restarted through a manager that can be asked to stop it), and a way to start it now.
   */
  task?(): boolean;
  startTask?(): boolean;
  /** Ask the service manager to stop it (it stays installed); false when it would not. */
  stop?(): boolean;
  /**
   * Whether the manager has the service loaded or running, so that it would start an agent that is
   * gone: false for one that was stopped (or never started), which nothing starts again.
   */
  loaded?(): boolean;
  /** How long a running agent is given to stop when it is replaced, or to come back (tests make it short). */
  stopWaitMs?: number;
  /** Start a detached agent with this environment; replaced in tests. It may return the process it started. */
  spawnAgent?: (env: Record<string, string | undefined>) => void | StartedAgent;
}

/**
 * The login service as one configuration sees it. There is one service per machine and it runs
 * one configuration: for any other the service is not there, and nothing is asked of it.
 * The manager is only reached through `status` and `restart` (replaced in tests).
 */
export function agentServiceFor(
  configPath: string,
  probe: () => { installed: boolean; running?: boolean; detail?: string; pid?: number; reachable?: boolean } = () => fleetAgentServiceStatus(configPath),
  restart: (gentle?: boolean) => boolean = restartFleetAgentService,
  stop: () => boolean = stopFleetAgentService,
  /** The platform whose manager is asked (replaced in tests). */
  platform: string = process.platform,
  /** Whether the service's definition runs a program (replaced in tests). */
  runs: (target: string) => boolean | undefined = fleetAgentServiceRuns,
  /** Start the Scheduled Task (Windows; replaced in tests). */
  startTask: () => boolean = startFleetAgentTask,
): AgentServiceHooks {
  // The manager is asked once for what the hooks below want to know together (is it installed, which
  // pid, can it be reached): each is a process spawned to the manager. What it said is good for a moment.
  let asked: { at: number; answer: ReturnType<typeof probe> } | undefined;
  const status = (): ReturnType<typeof probe> => {
    if (asked === undefined || Date.now() - asked.at > STATUS_FRESH_MS) asked = { at: Date.now(), answer: probe() };
    return asked.answer;
  };
  return {
    installed: () => {
      // Only where the manager can be asked to restart it: elsewhere the agent is started as it always was.
      if (platform !== "darwin" && platform !== "linux") return false;
      try {
        // A service file with nothing to run it (no login session, no user bus) manages nothing:
        // the agent is handled as if there were no service, which is what it would be.
        const answer = status();
        return answer.installed && answer.reachable !== false;
      } catch {
        return false;
      }
    },
    pid: () => {
      try {
        return status().pid;
      } catch {
        return undefined;
      }
    },
    unreachable: () => {
      if (platform !== "darwin" && platform !== "linux") return false;
      try {
        const answer = status();
        return answer.installed && answer.reachable === false;
      } catch {
        return false;
      }
    },
    loaded: () => {
      if (platform !== "darwin" && platform !== "linux") return false;
      try {
        return managerHolds(status(), platform);
      } catch {
        return false;
      }
    },
    restart: (gentle) => {
      asked = undefined; // whatever it said before is not what it says after
      return restart(gentle);
    },
    task: () => {
      if (platform !== "win32") return false;
      try {
        // Bound to this configuration (a task that runs another's is not this one's).
        return status().installed;
      } catch {
        return false;
      }
    },
    startTask: () => {
      asked = undefined;
      return platform === "win32" && startTask();
    },
    runs: (target) => {
      if (platform !== "darwin" && platform !== "linux") return undefined;
      try {
        return runs(target);
      } catch {
        return undefined;
      }
    },
    stop: () => {
      asked = undefined;
      return stop();
    },
  };
}

/**
 * Whether the manager would start the agent again if it died: it has the service running, or waiting to
 * be started again. launchd says "not loaded" for one that was booted out; systemd says "inactive" (or
 * "failed" once it has given up) for one that was stopped.
 */
export function managerHolds(status: { installed: boolean; running?: boolean; detail?: string }, platform: string): boolean {
  if (!status.installed) return false;
  if (status.running === true) return true;
  if (platform === "darwin") return status.detail !== undefined && status.detail !== "not loaded";
  if (platform === "linux") return status.detail === "activating" || status.detail === "reloading";
  return false;
}

// How long what the service manager said stays true for one `ensureFleetAgent`.
const STATUS_FRESH_MS = 2_000;

/** A stop in the first moments after a claim counts for the agent started for it (the margin of the start time's own error). */
const SINCE_MARGIN_MS = 100;

/** How often a running agent looks for a request to stop in its directory. */
const STOP_WATCH_MS = 1_000;

/** How long a running agent is given to stop when it has to be replaced (it may be finishing a round). */
const STOP_WAIT_MS = 15_000;

/**
 * The command that starts the agent for a configuration.
 *
 * selfCommand, not process.execPath: when the CLI runs from source the executable is bun, and
 * bun would look for a file named __fleet-agent. The configuration is an absolute path: whoever
 * finds the agent's lock tells whose agent it is by that path, and a relative one (from another
 * directory, or after a chdir) cannot be told, which a service's definition never has.
 */
export function agentCommand(configPath: string): string[] {
  return [...selfCommand(), "__fleet-agent", "--config", resolve(configPath)];
}

/**
 * The agent is running, and the settings asked for are saved but cannot be given to it from here
 * (its service's manager cannot be reached, or would not restart it). Not a failure to start it:
 * the agent is up, with its old settings.
 */
export class SettingsPendingError extends CliError {}

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
  service: AgentServiceHooks = agentServiceFor(configPath),
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
    // The settings are saved, but the agent that is running cannot be given them from here: its
    // service is installed and its manager cannot be reached, so it may be the service's own.
    // Stopping it and spawning another would have the manager's restarts collide with that one
    // ("another fleet agent is already running") until a command that reaches it runs.
    if (!managed && service.unreachable?.()) {
      throw new SettingsPendingError(
        "the fleet agent (pid " + existing.pid + ") runs as a login service whose manager cannot be reached from here, so it cannot be restarted with the new settings",
        "they are saved and apply the next time the service restarts; or run this from a login session (or stop the service) to apply them now",
      );
    }
    if (!managed) {
      await stopAndWait(configPath, existing, waitMs);
      existing = undefined;
    }
  }
  if (managed && service.restart()) {
    // The service manager starts it (or restarts it, to take the new settings): nothing is
    // spawned beside the service's own agent.
    const deadline = Date.now() + waitMs;
    for (;;) {
      const state = runningAgent(configPath);
      if (state && state.pid !== existing?.pid) return state;
      if (Date.now() > deadline) throw new CliError("the fleet agent did not come back after the service was restarted");
      await Bun.sleep(100);
    }
  }
  if (managed && existing) {
    // The manager answered, and then would not restart the agent that is running: it keeps the
    // settings it has. Its state is not deleted and nothing is spawned for it to refuse.
    throw new SettingsPendingError(
      "the service manager would not restart the running fleet agent (pid " + existing.pid + "), which keeps its old settings",
      "try again, or run 'prime fleets agent install' to set the service up again",
    );
  }
  // No service for this configuration, or the manager has no agent to restart and would not start
  // one: the agent is started directly. If the manager did start one meanwhile, the lock makes this
  // one exit and that one's state is returned.
  // (Not a live agent's state, though: a racing start may have just started one.)
  if (!runningAgent(configPath)) rmSync(fleetAgentStatePath(configPath), { force: true });
  startAgentProcess(configPath, buildAgentEnv(configPath, options, process.env, shell), service);
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
async function stopAndWait(configPath: string, state: FleetAgentState, waitMs: number, platform: string = process.platform): Promise<void> {
  // The agent that is in the way, and no other: what asks for it here is a command that sets the service (or the
  // settings) up, and the agent the service starts is the one that must run (see `stopFleetAgent`).
  await stopAgentProcess(configPath, state, waitMs, platform, true);
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
 * Stop the agent process, and any successor that waits for its lock. Where a signal stops a process at the end of its
 * round (everywhere but Windows) that is what is sent. On Windows a signal is TerminateProcess, which ends it in the
 * middle of its round: the agent is asked in a file that it looks at while it runs, given `waitMs` to finish and leave,
 * and ended only if it does not.
 */
async function stopAgentProcess(configPath: string, state: FleetAgentState, waitMs: number, platform: string = process.platform, only: boolean = false): Promise<boolean> {
  if (platform === "win32") {
    const was = isFleetAgentProcess(state.pid, fleetAgentDir(configPath));
    requestStop(fleetAgentDir(configPath), Date.now(), only ? state.pid : undefined);
    const gone = Date.now() + waitMs;
    while (pidAlive(state.pid) && Date.now() < gone) await Bun.sleep(50);
    // One that left in time is stopped; one that did not is ended now.
    return stopFleetAgent(configPath, only) || was;
  }
  return stopFleetAgent(configPath, only);
}

/** The pid of the successor that waits for the lock, if one does. */
function waitingSuccessor(configPath: string): number | undefined {
  const dir = fleetAgentDir(configPath);
  const there = readSuccessor(dir);
  return there && there.pid > 0 && isSuccessorProcess(dir, there.pid) ? there.pid : undefined;
}

/** Stop the successor of an agent (see `fleet-agent-handover.ts`) that is waiting for the lock. True when there was one. */
function stopWaitingSuccessor(configPath: string): boolean {
  return stopWaiting(fleetAgentDir(configPath));
}

/** Start a detached agent with this environment. */
function startAgentProcess(configPath: string, env: Record<string, string | undefined>, service: AgentServiceHooks): StartedAgent | undefined {
  mkdirSync(fleetAgentDir(configPath), { recursive: true, mode: 0o700 });
  if (service.spawnAgent) return service.spawnAgent(env) ?? undefined;
  const child = Bun.spawn({
    cmd: agentCommand(configPath),
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  (child as unknown as { unref?: () => void }).unref?.();
  return child;
}

/** What `restartFleetAgentAfterUpdate` did. */
export type AgentRestart =
  | { restarted: false; reason?: string }
  | { restarted: true; via: "service" | "direct"; pid?: number; pending?: boolean; inProgress?: boolean };

export interface AgentRestartOptions {
  /** The file the update installed; the agent is restarted only if that is the program it runs. */
  target?: string;
  /** Replaced in tests. */
  platform?: string;
  /**
   * The command line of the running agent, when it is known (replaced in tests; the process list says). Without it
   * (Windows has no way to ask; null says so) the program of this process is taken for the agent's: what an update replaces.
   */
  agentCommand?: string | null;
  /** What this process would start the agent with (replaced in tests). */
  command?: string[];
  /** Whether a pid is a fleet agent of this configuration (replaced in tests; the lock, the state and the process list say). */
  isAgent?: (pid: number) => boolean;
  /** How long the new agent waits for the old one to let go of the lock. */
  lockWaitMs?: number;
  /** How long a new agent has to stay up for the new build to count as started. */
  startCheckMs?: number;
}

/** How long a service manager is given to bring the agent back (it stops the old one first: up to its TimeoutStopSec). */
const SERVICE_RESTART_WAIT_MS = 120_000;
/** How long an agent on Windows is given to finish its round when it is asked to stop, before it is ended. */
const WINDOWS_GRACE_MS = 60_000;
/** How long a restarted agent waits for the one it replaces to finish its round and let go (and then, if it is still there, waits on). */
const REPLACE_LOCK_WAIT_MS = 15 * 60_000;
const START_CHECK_MS = 1_500;

/**
 * Restart the fleet agent of this configuration, if one is running, so that it runs the build that was just
 * installed. An update replaces the program on disk and leaves the agent running the one it started from, and
 * for as long as it does, old and new builds are both at work on the same state (and on the same locks).
 *
 * Only this configuration's agent is touched, and only when the program that was updated is the one it
 * runs (an update `--to` another place changes nothing it runs). The agent finishes its round and is never
 * left without a successor:
 * - A service's agent is restarted by its manager, which stops it the way it stops it for good (and gives it
 *   its stop timeout) and starts it again. If the manager cannot be reached from here, nothing is done: a
 *   second agent started here would run beside the service's, which its manager would restart on the lock.
 * - On Windows a registered Scheduled Task is the manager: the agent is asked to stop in a file it looks at between
 *   rounds (a signal there would end it in the middle of one), the task is started again when it has left, and the
 *   agent is ended only if it is still at it after a minute.
 * - One that nobody supervises is replaced: the new build is started first and waits for the agent lock, and
 *   it is only then that the old agent is asked to stop (on Windows, in that file). The old one finishes its round,
 *   lets go of the lock, and the new one takes it, with whatever time that takes (it waits for as long as the old
 *   agent lives). The new build is written down (`fleet-agent/successor`) so that a stop of the agent reaches it and a
 *   second update does not start another. A new build that does not start leaves the old agent as it was.
 */
export async function restartFleetAgentAfterUpdate(
  configPath: string,
  service: AgentServiceHooks = agentServiceFor(configPath),
  opts: AgentRestartOptions = {},
): Promise<AgentRestart> {
  const existing = runningAgent(configPath);
  if (!existing) return { restarted: false };
  const platform = opts.platform ?? process.platform;
  const dir = fleetAgentDir(configPath);
  const notIt = (): AgentRestart => ({
    restarted: false,
    reason: "the update went to " + opts.target + ", which is not the program of the fleet agent, so it was left running",
  });
  const waitMs = service.stopWaitMs;
  if (service.installed() && service.pid() === existing.pid) {
    if (opts.target !== undefined && service.runs?.(opts.target) === false) return notIt();
    // One that an earlier update left waiting for the lock would take it from the service's agent.
    stopWaitingSuccessor(configPath);
    if (!service.restart(true)) throw new CliError("the service manager would not restart the fleet agent (pid " + existing.pid + ")", "restart it by hand, or run 'prime fleets agent install' to set the service up again");
    const deadline = Date.now() + (waitMs ?? SERVICE_RESTART_WAIT_MS);
    for (;;) {
      const state = runningAgent(configPath);
      if (state && state.pid !== existing.pid) return { restarted: true, via: "service", pid: state.pid };
      if (Date.now() > deadline) {
        // Still finishing its round: the manager has asked it to stop, and starts the new build when it has.
        if (pidAlive(existing.pid)) return { restarted: true, via: "service", pending: true };
        throw new CliError("the fleet agent did not come back after the service was restarted", "start it with 'prime fleets agent start'");
      }
      await Bun.sleep(100);
    }
  }
  // Which program the agent runs: its own command line says, where the process list can be asked.
  const agentCommand = opts.agentCommand === undefined ? commandOf(existing.pid) : (opts.agentCommand ?? undefined);
  if (opts.target !== undefined) {
    const runs = agentCommand !== undefined ? commandRuns(agentCommand, opts.target) : runsProgram(opts.command ?? selfCommand(), opts.target);
    if (!runs) return notIt();
  }
  if (service.unreachable?.()) {
    throw new CliError(
      "the fleet agent (pid " + existing.pid + ") runs as a login service whose manager cannot be reached from here, so it was not restarted",
      "restart it from a login session ('prime fleets agent start'), or run 'prime update' there",
    );
  }
  const graceMs = waitMs ?? (platform === "win32" ? WINDOWS_GRACE_MS : STOP_WAIT_MS);
  // Whether the pid is still the agent that was running: a pid that has left is another process's before long (Windows
  // reuses them readily), and nothing is signalled, or waited for, on its account.
  const isAgent = opts.isAgent ?? ((pid: number): boolean => isFleetAgentProcess(pid, dir));
  /** Ask the old agent to stop: in the file on Windows (a signal would end it mid-round), by SIGTERM elsewhere. */
  const askToStop = (): void => {
    if (platform === "win32") requestStop(dir, Date.now(), existing.pid);
    else if (isAgent(existing.pid)) endAgent(existing.pid);
  };
  if (platform === "win32" && service.task?.()) {
    // The Scheduled Task is what runs it: ask the agent to stop in the way it can finish its round for, start the task
    // again when it has left.
    stopWaitingSuccessor(configPath);
    requestStop(dir, Date.now(), existing.pid);
    await waitGone(existing.pid, graceMs, isAgent);
    if (isAgent(existing.pid)) {
      endAgent(existing.pid);
      await waitGone(existing.pid, 5_000, isAgent);
    }
    if (!service.startTask?.()) {
      throw new CliError(
        "the fleet agent stopped, and Task Scheduler would not start its task again",
        "start it with 'prime fleets agent start' (or 'prime fleets agent install' to register the task again)",
      );
    }
    const deadline = Date.now() + (waitMs ?? SERVICE_RESTART_WAIT_MS);
    for (;;) {
      const state = runningAgent(configPath);
      if (state && state.pid !== existing.pid) return { restarted: true, via: "service", pid: state.pid };
      if (Date.now() > deadline) throw new CliError("the fleet agent did not come back after its task was started", "start it with 'prime fleets agent start'");
      await Bun.sleep(100);
    }
  }
  // The new build first, and the old agent only once the new one is up and waiting for its lock. Of two updates at the
  // same moment, one starts it.
  const claim = claimSuccessor(dir, existing.pid);
  if (!claim.claimed) {
    // Another update has started one. If it is past the time it is given to show that it started, and was started for
    // this agent, the update that started it may have died before it asked the agent to stop: asking again costs
    // nothing. Before that (a claim with no process yet, or a build that is still being looked at) the update at it asks
    // itself, and an agent that is stopped for a build that then fails to start is one that nothing runs.
    const startCheck = opts.startCheckMs ?? (waitMs === undefined ? START_CHECK_MS : Math.min(START_CHECK_MS, waitMs));
    const again = mayAskAgainToStop(dir, existing.pid, startCheck);
    if (again) askToStop();
    return { restarted: true, via: "direct", ...(claim.pid > 0 ? { pid: claim.pid } : {}), pending: true, ...(again ? {} : { inProgress: true }) };
  }
  const env = {
    ...buildAgentEnv(configPath, {}, process.env, false),
    PRIME_FLEET_LOCK_WAIT_MS: String(opts.lockWaitMs ?? REPLACE_LOCK_WAIT_MS),
    PRIME_FLEET_REPLACES: String(existing.pid),
    // A stop asked for from the moment of the claim is for it, though it is started a moment after (see `runFleetAgent`).
    PRIME_FLEET_SINCE: String(claim.at),
  };
  let child: StartedAgent | undefined;
  try {
    child = startAgentProcess(configPath, env, service);
  } catch (err) {
    clearSuccessor(dir);
    throw err;
  }
  if (child) registerSuccessor(dir, child.pid, Date.now(), existing.pid);
  const checkUntil = Date.now() + (opts.startCheckMs ?? (waitMs === undefined ? START_CHECK_MS : Math.min(START_CHECK_MS, waitMs)));
  while (Date.now() < checkUntil) {
    if (child && child.exitCode !== null) {
      clearSuccessor(dir);
      throw new CliError(
        "the new build of the fleet agent did not start (exit " + child.exitCode + "); the running agent was left as it was",
        "check that 'prime --version' runs, then run 'prime fleets agent start'",
      );
    }
    await Bun.sleep(50);
  }
  askToStop();
  // Its state is left for it to remove when it is done: until then it is what is running.
  let deadline = Date.now() + graceMs;
  let ended = false;
  for (;;) {
    const state = runningAgent(configPath);
    if (state && state.pid !== existing.pid) return { restarted: true, via: "direct", pid: state.pid };
    const old = isAgent(existing.pid);
    if (!old && child && child.exitCode !== null) {
      throw new CliError(
        "the old fleet agent stopped, and the new one exited (code " + child.exitCode + "): no fleet agent is running",
        "start it with 'prime fleets agent start'",
      );
    }
    if (Date.now() > deadline) {
      // On Windows a round that has not finished in the time it is given is ended; the successor takes the lock then.
      if (platform === "win32" && old && !ended) {
        ended = true;
        endAgent(existing.pid);
        deadline = Date.now() + 5_000;
        continue;
      }
      // The old agent is finishing its round; the new one waits for the lock and starts when it is let go.
      if (old || (child && child.exitCode === null)) return { restarted: true, via: "direct", pid: child?.pid, pending: true };
      throw new CliError("no fleet agent is running after the update", "start it with 'prime fleets agent start'");
    }
    await Bun.sleep(100);
  }
}

async function waitGone(pid: number, ms: number, alive: (pid: number) => boolean = pidAlive): Promise<void> {
  const until = Date.now() + ms;
  while (alive(pid) && Date.now() < until) await Bun.sleep(50);
}

/** End an agent now (SIGTERM; on Windows that is TerminateProcess). */
function endAgent(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Gone already.
  }
}

/**
 * Install the agent as a login service. An agent that is already running is stopped first and
 * waited for: the service starts its own, and two of them would act as the primary for the
 * same spaces (an agent from before the lock existed would not even notice the other).
 */
export async function installFleetAgent(
  configPath: string,
  deps: {
    install: () => string;
    stopWaitMs?: number;
    /** The configuration the installed service runs, if one is installed. */
    boundTo?: () => string | undefined;
    /** The pid the service manager runs the agent as. */
    servicePid?: () => number | undefined;
  } = { install: () => installFleetAgentService(configPath) },
): Promise<string> {
  // There is one service per machine, and it runs one configuration: installing for another
  // would move it, and the first would have no agent.
  const bound = (deps.boundTo ?? fleetAgentServiceConfig)();
  if (bound !== undefined && !sameConfig(bound, configPath)) {
    throw new CliError(
      "the fleet agent service is installed for " + bound + " (there is one per machine)",
      "run 'prime fleets agent uninstall' first if it should run " + configPath + " instead",
    );
  }
  // The service starts without this shell's environment: what was set here is written down for it.
  persistAgentSettings(configPath);
  const running = runningAgent(configPath);
  // The service's own agent is replaced by the manager (bootout / restart stop it themselves);
  // any other is stopped here, so the one the service starts is the only one.
  const own = running !== undefined && (deps.servicePid ?? (() => fleetAgentServiceStatus(configPath).pid))() === running.pid;
  // An update's successor that still waits for the lock would take it from the service's agent.
  stopWaitingSuccessor(configPath);
  if (running && !own) await stopAndWait(configPath, running, deps.stopWaitMs ?? STOP_WAIT_MS);
  return deps.install();
}

/**
 * Remove the login service. There is one per machine and it runs one configuration: removing it
 * from another is refused unless asked for (`force`), so that a command for one configuration
 * cannot take the default one's agent away.
 */
export function uninstallFleetAgent(
  configPath: string,
  deps: { uninstall?: () => boolean; boundTo?: () => string | undefined; force?: boolean } = {},
): boolean {
  const bound = (deps.boundTo ?? fleetAgentServiceConfig)();
  if (bound !== undefined && !sameConfig(bound, configPath) && !deps.force) {
    throw new CliError(
      "the fleet agent service runs " + bound + ", not " + configPath + " (there is one per machine)",
      "run it with --config " + bound + ", or pass --force to remove it anyway",
    );
  }
  return (deps.uninstall ?? (() => uninstallFleetAgentService(configPath)))();
}

/**
 * Stop the agent the way it can be stopped. When a login service runs it, signalling the process
 * only has the service manager start another a few seconds later, so the manager is asked to stop
 * the service (it stays installed, and `prime fleets agent start` starts it again). That is done only
 * for the agent that IS the service's: one started by hand beside the service is signalled, and the
 * service is stopped as well when the manager holds it, because it would start its own the moment
 * the agent's lock was free. Without a service, or when its manager will not stop it, the process is
 * stopped as before, and `restarts` says whether a manager is left that starts another.
 */
export async function stopFleetAgentManaged(
  configPath: string,
  service: AgentServiceHooks = agentServiceFor(configPath),
  waitMs: number = service.stopWaitMs ?? STOP_WAIT_MS,
  platform: string = process.platform,
): Promise<{ stopped: boolean; via: "service" | "process"; restarts: boolean; serviceStopped?: boolean }> {
  // First: a successor that waits for the lock would take it the moment the agent lets go of it.
  const hadSuccessor = stopWaitingSuccessor(configPath);
  const existing = runningAgent(configPath);
  const installed = service.installed();
  const held = installed && (service.loaded?.() ?? true);
  if (existing === undefined) {
    // Nothing runs, but a service the manager holds is about to start one (or is failing to): stop it too.
    if (installed && service.loaded?.() === true && service.stop?.()) return { stopped: hadSuccessor, via: "service", restarts: false, serviceStopped: true };
    return { stopped: hadSuccessor, via: "process", restarts: false };
  }
  if (installed && service.pid() === existing.pid && service.stop?.()) {
    const gone = Date.now() + waitMs;
    while (pidAlive(existing.pid) && Date.now() < gone) await Bun.sleep(50);
    if (pidAlive(existing.pid)) {
      throw new CliError("the service was asked to stop, and the fleet agent (pid " + existing.pid + ") has not stopped yet", "it may be finishing a round: try again in a moment");
    }
    rmSync(fleetAgentStatePath(configPath), { force: true });
    return { stopped: true, via: "service", restarts: false };
  }
  // Not the service's agent, or its manager would not stop it: the process is stopped here. A service the
  // manager holds is stopped too (after the process, which it is not running), or it starts another.
  const stopped = await stopAgentProcess(configPath, existing, waitMs, platform);
  if (installed && service.pid() !== existing.pid && held && service.stop?.()) return { stopped, via: "process", restarts: false, serviceStopped: true };
  return { stopped, via: "process", restarts: held };
}

/**
 * Stop the agent. Returns true when one was running (or was about to: a successor that waits for the lock).
 * The request to stop is written first, so that a successor that is taking the lock at this moment sees it.
 *
 * A request is for every agent that was started before it, which is what `agent stop` means. With `only` it is not: a
 * command that is setting the service up, or changing the agent's settings, stops the agent that is in the way (that is
 * a signal, which needs no request where it is one) and the successor of an update that waits, and no more. A request
 * for all would be taken by the agent the service has started meanwhile, which is waiting for the very lock this
 * agent holds, and it would leave the moment it had it.
 */
export function stopFleetAgent(configPath: string, only: boolean = false): boolean {
  const dir = fleetAgentDir(configPath);
  const state = readFleetAgentState(configPath);
  const waiting = readSuccessor(dir);
  if (!state && !waiting) return false;
  if (!only) requestStop(dir);
  else if (waiting && waiting.pid === 0) requestStop(dir);
  else if (waiting && isSuccessorProcess(dir, waiting.pid)) requestStop(dir, Date.now(), waiting.pid);
  const successor = stopSuccessor(dir) !== undefined;
  if (!state) return successor;
  // A pid left in the state by an agent that is gone may belong to anything now.
  const agent = isFleetAgentProcess(state.pid, dir);
  if (agent) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {}
  }
  rmSync(fleetAgentStatePath(configPath), { force: true });
  return agent || successor;
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
  /** The pid of a new build that waits for this agent to finish its round and take over (an update started it). */
  successor?: number;
} {
  const state = runningAgent(configPath);
  const waiting = waitingSuccessor(configPath);
  if (!state) return { running: false, ...(waiting ? { successor: waiting } : {}) };
  return {
    ...(waiting ? { successor: waiting } : {}),
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
/**
 * Whether a path from the watcher is something inside a `.git` directory: a repository being used
 * (an editor running `git status`), which is never part of what the fleet publishes. A `.git` that
 * itself appears or goes (a repository arriving) is not.
 */
export function insideGitDir(filename: string | null | undefined): boolean {
  if (!filename) return false;
  const parts = filename.split(/[\\/]/);
  return parts.includes(".git") && parts[parts.length - 1] !== ".git";
}

/** How long a path waits for git to say whether it is ignored before it wakes the primary regardless. */
const WAKE_PATIENCE_MS = 250;

export function watchTree(
  work: string,
  onChange: (eventType?: string, filename?: string | null) => void,
  opts: {
    /**
     * What the snapshot would leave out: a change to it does not wake anything. Asked of git, so it takes a
     * moment longer than a path that nothing is asked about; a path it cannot say anything of is not left out.
     */
    ignore?: IgnoreFilter;
    /** A path git has not answered about by then is let through as not ignored (milliseconds; default 250). */
    patienceMs?: number;
  } = {},
): { stop: () => void } {
  let watcher: FSWatcher | undefined;
  let stopped = false;
  const { ignore } = opts;
  try {
    watcher = watch(work, { recursive: true }, (eventType, filename) => {
      // Nothing in a repository's own files is the fleet's: it would wake the primary for a look at nothing.
      if (insideGitDir(filename)) return;
      if (!ignore || !filename) {
        onChange(eventType, filename);
        return;
      }
      // The rules are told first (a `.gitignore` that changed changes the answer), then the path is asked about.
      // A git that is slow to answer does not make the primary deaf: the path is let through after a moment.
      ignore.noteChange(eventType, filename);
      let timer: ReturnType<typeof setTimeout> | undefined;
      void Promise.race([
        ignore.isIgnored(filename).catch(() => false),
        new Promise<boolean>((resolve) => void (timer = setTimeout(() => resolve(false), opts.patienceMs ?? WAKE_PATIENCE_MS))),
      ]).then((ignored) => {
        clearTimeout(timer);
        if (!ignored && !stopped) onChange(eventType, filename);
      });
    });
  } catch {
    // A platform that cannot watch recursively: the agent falls back to
    // checking the tree on its own.
  }
  return {
    stop: () => {
      stopped = true;
      ignore?.close();
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

// An error from the file system that says the work tree cannot be written to. (Not EMFILE: too
// many files open is the agent's own load and passes.)
export function cannotWrite(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && ["EACCES", "EPERM", "ENOSPC", "EROFS", "EDQUOT"].includes(code);
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
  const sleepMs = baseSleepMs(loop, pollMs, now);
  // A primary with a change that is held back wakes when the hold is over, not at the end of a long sleep.
  if (loop.primary && loop.dirty && (loop.holdUntil ?? 0) > now) return Math.min(sleepMs, Math.max(20, (loop.holdUntil ?? 0) - now + 5));
  return sleepMs;
}

function baseSleepMs(loop: SpaceLoop, pollMs: number, now: number): number {
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
  // Only a claim that can be acted on now wakes the round: one that has to wait for another's turn would
  // wake it for a round that does nothing.
  if (loop.claim && Date.now() >= loop.claimAt) wake();
  return true;
}

/** A publish that comes within this of the end of the hold it came after is in a rush: the tree is being written without a pause. */
export const RAPID_PUBLISH_MS = 1000;
/** The first hold, and the longest, when publishes keep coming in a rush. */
export const HOLD_FIRST_MS = 1000;
export const HOLD_MAX_MS = 5000;

/**
 * How long a change is held back after a publish, so a tree that is written to without a pause (a log
 * not in .gitignore, a download, a database file) is published a few seconds apart, not once per round.
 *
 * A publish that comes within `RAPID_PUBLISH_MS` of the end of the hold the one before it set (so
 * within a second of the one before, where there was no hold) doubles the hold, from `HOLD_FIRST_MS` (a second) to `HOLD_MAX_MS`; one that comes after a pause takes it away
 * again. A change on its own is never held: the first publish after a pause, and one in a train that
 * is slower than a second, go out as soon as the tree is still.
 */
export function holdAfterPublish(
  before: { lastPublish: number; rapid: number; holdMs: number },
  now: number,
): { rapid: number; holdMs: number } {
  const rush = now - before.lastPublish < before.holdMs + RAPID_PUBLISH_MS;
  const rapid = rush ? Math.min(before.rapid + 1, 16) : 0;
  return { rapid, holdMs: rapid === 0 ? 0 : Math.min(HOLD_MAX_MS, HOLD_FIRST_MS * 2 ** (rapid - 1)) };
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
  /** Publishes in a row that followed the one before within moments (see `holdAfterPublish`). */
  rapid?: number;
  /** How long the next change is held back after the last publish, and until when. */
  holdMs?: number;
  holdUntil?: number;
  holdTimer?: ReturnType<typeof setTimeout>;
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
  /**
   * What a publish that went through said of this member's position, when the state file could not be written (its lock was
   * busy). The snapshot is the fleet's head and this member's own: the next round starts from it and writes it down, and does
   * not take its own snapshot for another member's and write it over what was changed since.
   */
  unrecorded?: Partial<FleetMemberState>;
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

/**
 * The state of the member as it is, with what a publish said and could not write down. It is written now if it can be;
 * if not it is what the round goes on from all the same: the member published that snapshot, and it must not be pulled
 * over what has been changed since as if another member had.
 */
function settleUnrecorded(loop: SpaceLoop, state: FleetMemberState): FleetMemberState {
  const pending = loop.unrecorded;
  if (!pending) return state;
  // Written down by somebody else meanwhile (or by a later publish): nothing is left to say.
  if ((state.seq ?? 0) >= (pending.seq ?? 0)) {
    loop.unrecorded = undefined;
    return state;
  }
  const settled = { ...state, ...pending };
  try {
    writeFleetState(loop.configPath, loop.fleet, loop.name, settled);
    loop.unrecorded = undefined;
  } catch {
    // Still busy: it is the next round's to write.
  }
  return settled;
}

/** One round for one space: take a place, then publish or pull. */
export async function round(loop: SpaceLoop, options: FleetAgentOptions, report: (what: string) => void): Promise<void> {
  const { creds, fleet, paths } = loop;
  const state = settleUnrecorded(loop, readFleetState(loop.configPath, fleet, loop.name));

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
  // is resumed, so there is nothing to ask - but the gateway keeps a device only
  // while it hears from it (an anonymous device is let go after days offline,
  // and a socket to a fleet is not that), so one look every few hours says the
  // device is still here. Without a socket, a look now and then (as often as the
  // gateway asked) finds out.
  if (loop.paused) {
    const since = Date.now() - loop.lastBootstrap;
    if (loop.events.connected ? since < PAUSED_PRESENCE_MS : since < (loop.retryAfterMs ?? 60_000)) return;
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
    // A tree that has been published in a rush waits out its hold; the change stays noted, and the loop wakes when it is over.
    if (changed && !due && Date.now() < (loop.holdUntil ?? 0)) return;
    loop.dirty = false;
    loop.lastCheck = Date.now();

    // A file that is still being written must not be captured half-written.
    // It only matters when something changed: otherwise there is nothing to
    // capture.
    const settled = changed ? await settle(paths.work, options.settleMs ?? SETTLE_QUIET_MS, { gitDir: paths.gitDir, left: paths.nested?.get() ?? [] }) : null;
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
      // The tree just taken is published as it is when the files are still as they were when it was
      // taken (a snapshot of the same files again would only find the same tree). The watcher having
      // spoken since says they are not, and nothing is then looked at.
      settled && !settled.racy && !loop.dirty
        ? {
            known: {
              tree: snap.tree,
              base: state.base ?? null,
              // The watcher speaking after the look at the files, up to the moment the tree is used.
              quiet: () => !loop.dirty,
              unchanged: async () => {
                const now = paths.nested?.get() ?? [];
                if (now.length !== settled.left.length || now.some((p, i) => p !== settled.left[i])) return false;
                const again = await stampTree(paths.work, paths.gitDir, now);
                return again !== null && again.key === settled.key;
              },
            },
          }
        : undefined,
    );
    loop.timing.publish = Date.now() - publishBegan;
    const published: Partial<FleetMemberState> = {
      base: result.commit,
      seq: result.seq,
      memberCount: result.members,
      // What the snapshot was sealed for, not what was asked a moment before:
      // a member that joined in between is then still seen as new next round.
      roster: result.roster,
      tree: snap.tree,
    };
    try {
      writeFleetState(loop.configPath, fleet, loop.name, { ...state, ...published });
    } catch (err) {
      // The snapshot is the fleet's head now: that is remembered, and written down by the next round (see `settleUnrecorded`).
      loop.unrecorded = published;
      throw err;
    }
    const publishedAt = Date.now();
    const hold = holdAfterPublish({ lastPublish: loop.lastPublish, rapid: loop.rapid ?? 0, holdMs: loop.holdMs ?? 0 }, publishedAt);
    loop.rapid = hold.rapid;
    loop.holdMs = hold.holdMs;
    loop.holdUntil = hold.holdMs > 0 ? publishedAt + hold.holdMs : 0;
    loop.lastPublish = publishedAt;
    report("published " + result.seq);
    return;
  }

  // A replica. It does not mirror: it keeps what the fleet publishes in its own
  // object store, and writes it over the work tree only when it has to. A person
  // who wants the mirror current asks (`prime fleets sync`), or sets
  // PRIME_FLEET_REPLICA=mirror to have every snapshot written as it arrives.
  loop.primary = false;
  const mode = replicaMode();
  const keep = (patch: Partial<FleetMemberState>, opts?: { rewind?: boolean }): void => {
    updateFleetState(loop.configPath, fleet, loop.name, patch, opts);
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
      // cannot write, a snapshot it refuses (see fleet-trust.ts). Asking again would
      // only keep the claim from a replica that can.
      loop.claim = !(err instanceof NotSealedYetError || err instanceof NotSealedError || err instanceof TamperedSnapshotError || cannotWrite(err));
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
  /** The key this member offered waits for the operator to approve it. */
  keyPending?: true;
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
async function bootstrapHere(creds: FleetCredentials, fleet: string, pubkey?: string, label?: string, keyProof?: KeyProof): Promise<BootstrapResult> {
  const res = await fetch(creds.gateway + "/fleets/" + encodeURIComponent(fleet) + "/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-prime-device": creds.deviceId, "x-device-token": creds.deviceToken },
    // The key travels with it: a member that lost its key can only catch up
    // if the fleet learns the new one. The name travels too, so a space that
    // was renamed - or an identity another space took over - reads correctly
    // in the operator's list.
    // A key other than the one the fleet holds is taken only on the old key's proof, or the operator's say-so.
    body: JSON.stringify({ ...(pubkey ? { pubkey } : {}), ...(keyProof ? { keyProof } : {}), ...(label ? { label } : {}), seals: true }),
    // Asking for the place is how the lease is renewed: a request that hangs for
    // a minute would outlast the lease, so it is cut short (and asked again).
    signal: AbortSignal.timeout(Math.min(creds.timeoutMs ?? PLACE_TIMEOUT_MS, PLACE_TIMEOUT_MS)),
  });
  if (!res.ok) {
    // A paused fleet answers with a reason and how long to wait: that is not
    // a failure to report, it is the operator's choice.
    const body = (await res.json().catch(() => undefined)) as { paused?: unknown; retryAfterMs?: unknown; keyChange?: unknown; error?: unknown } | undefined;
    // The fleet holds another key for this member and could not be shown the old one: the new key waits for
    // the operator. It is said as it is, because it is the one refusal that needs somebody to act.
    if (body && body.keyChange === "pending" && typeof body.error === "string") {
      const after = Number(res.headers.get("retry-after"));
      return { ok: false, primary: false, answered: true, keyPending: true, error: body.error, ...(Number.isFinite(after) && after > 0 ? { retryAfterMs: after * 1000 } : {}) };
    }
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

/** How often a paused member with a live socket still says it is here (see the paused branch of a round). */
export const PAUSED_PRESENCE_MS = 6 * 60 * 60_000;

/**
 * Drop the key pair a rotation replaced once nothing is left that was sealed for it.
 *
 * The fleet lists a replaced key with the sequence the head was at when it was replaced (`left`): the snapshots
 * up to there may be sealed for it, and a member that has not taken them in yet opens them with the old pair.
 * Once this member has applied past that sequence (by opening them, or by taking the whole tree that was published
 * for its new key) the pair is of no more use. A fleet that does not list the key (a gateway that does not
 * keep them) has nothing sealed for it that a member needs. A roster that cannot be read keeps the pair.
 */
async function dropPreviousWhenSpent(loop: SpaceLoop, previousPublicKey: string): Promise<void> {
  try {
    const { left } = await fetchRoster(loop.creds, loop.fleet);
    const entry = left.find((k) => k.pubkey === previousPublicKey);
    const applied = positions(readFleetState(loop.configPath, loop.fleet, loop.name)).applied.seq;
    if (!entry || applied >= entry.until) dropPreviousKey(loop.paths.keyFile, previousPublicKey);
  } catch {
    // Kept: asked again with the next place.
  }
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
    // A member that rotated its key (`prime fleets rotate-key`) shows the fleet that the new one is its own:
    // a proof made with the key it had, until the fleet has taken the new one.
    const before = previousKeyPair(loop.paths.keyFile);
    let proof: KeyProof | undefined;
    let asked = false;
    if (before) {
      const fetchedAt = Date.now();
      const role = await fetchRole(loop.creds, loop.fleet).catch(() => undefined);
      asked = role?.keyProofKey !== undefined;
      // On the gateway's clock when it says what it is (a proof is good for ten minutes), else on this machine's.
      if (role?.keyProofKey) proof = proveKeyChange(before.privateKey, role.keyProofKey, keys.publicKey, loop.fleet, loop.creds.deviceId, role.serverTimeMs !== undefined ? role.serverTimeMs + (Date.now() - fetchedAt) : Date.now());
    }
    const placed = await bootstrapHere(loop.creds, loop.fleet, keys.publicKey, loop.name, proof).catch((err: unknown) => {
      // The request did not get an answer: what an earlier refusal asked for is history.
      loop.refusedForMs = undefined;
      throw err;
    });
    loop.lastBootstrap = Date.now();
    // The fleet answered with a place (or a wait for one) rather than a refusal, so it holds the key this
    // member has now - on the proof, or because a gateway that predates it asks for none. The old pair is kept
    // until what was sealed for it has been taken in (see `dropPreviousWhenSpent`).
    if (before && placed.ok && (proof || !asked)) await dropPreviousWhenSpent(loop, before.publicKey);
    if (placed.paused) {
      loop.paused = true;
      loop.primary = false;
      loop.retryAfterMs = placed.retryAfterMs;
      loop.refusedForMs = undefined;
      return { primary: false, paused: true };
    }
    if (!placed.ok) {
      loop.refusedForMs = placed.retryAfterMs;
      // What the operator compares the request with: the key this machine holds, as the list of requests prints it.
      throw new PlaceRefused((placed.error ?? "refused") + (placed.keyPending ? " (this member's key is " + keyFingerprintOf(keys.publicKey) + ")" : ""), placed.retryAfterMs);
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
 * How long a starting agent waits for the holder of the lock when it was not told (PRIME_FLEET_LOCK_WAIT_MS). An agent that
 * a command started (after it had stopped any old one and waited for it to be gone) is told not to wait: a live holder is
 * a winner of a race, and it leaves at once. One a service manager restarts waits for the old one to finish its round.
 */
const DEFAULT_LOCK_WAIT_MS = 10_000;

/**
 * A line in the agent's log (its standard error, which the service manager writes to the agent's log file): when it
 * started, which lock it waited for, what asked it to stop and why it left. Without them, an agent that left, or was
 * started again, left nothing to say why.
 */
function logAgent(text: string): void {
  process.stderr.write(new Date().toISOString() + " fleet agent (pid " + process.pid + "): " + text + "\n");
}

/**
 * The agent's loop.
 *
 * Every space gets its own loop, so a space that is slow does not hold up the
 * others.
 */
export async function runFleetAgent(configPath: string, options: FleetAgentOptions = {}): Promise<void> {
  // When this process was started: a stop that was asked for after that is for this agent too.
  const realStart = Date.now() - process.uptime() * 1000;
  // What an update that started this process told it (and which is not passed on to what it starts).
  const handover = takeHandoverEnv(process.env, realStart);
  // (An agent that an update started was started on behalf of the update's claim, a moment earlier: see `claimSuccessor`.)
  const startedAtMs = Math.min(realStart, handover.since !== undefined ? handover.since - SINCE_MARGIN_MS : Infinity);
  const replaces = handover.replaces;
  logAgent("starting" + (replaces !== undefined ? ", to replace the agent of pid " + replaces : "") + (handover.since !== undefined ? ", for an update's claim made " + (Math.round(realStart - handover.since)) + " ms before" : ""));
  const waitingSince = Date.now();
  // Two agents for the same spaces would both act as the primary. A restart finds the old
  // one still finishing its round, so it is given a moment to let go (and one that was started to replace it
  // waits for as long as that agent is at it).
  const lock = await acquireStarting(fleetAgentDir(configPath), {
    waitMs: options.lockWaitMs ?? handover.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS,
    startedAt: startedAtMs,
    ...(replaces !== undefined ? { replaces } : {}),
    onWait: (holder) => logAgent("the fleet agent (pid " + holder + ") is still finishing its round; this one keeps waiting for it"),
    lock: {
      // Another agent has the lock: two took a dead one at the same moment. This one stops, and its
      // manager (or the next command) starts it again behind the lock. It finishes its current round
      // first, so the two overlap for up to one touch interval plus that round.
      onLost: () => {
        logAgent("the lock was taken by another agent; this one stops");
        process.exitCode = 1;
        process.kill(process.pid, "SIGTERM");
      },
    },
  });
  if (!lock.held) {
    if ("stopped" in lock) {
      logAgent("asked to stop while it was starting (a request to stop that is newer than this process); it did not start, and leaves");
      return;
    }
    logAgent("another fleet agent is already running" + (lock.holder > 0 ? " (pid " + lock.holder + ")" : "") + "; this one exits after waiting " + (Date.now() - waitingSince) + " ms for the lock");
    process.exitCode = 1;
    return;
  }
  logAgent("holds the lock" + (Date.now() - waitingSince > 100 ? " (after waiting " + (Date.now() - waitingSince) + " ms)" : ""));
  try {
    await runFleetAgentLocked(configPath, options, startedAtMs);
    logAgent("leaving: stopped" + (process.exitCode ? " (exit code " + process.exitCode + ")" : ""));
  } catch (err) {
    logAgent("leaving: " + (err instanceof Error ? err.message : String(err)));
    throw err;
  } finally {
    lock.release();
  }
}

async function runFleetAgentLocked(configPath: string, options: FleetAgentOptions, startedAtMs: number): Promise<void> {
  // What a person set (and the service was never told) is read from where it was written down.
  applyAgentSettings(configPath);
  const env = process.env;
  const pollMs = options.pollMs ?? positive(env.PRIME_FLEET_POLL_MS) ?? DEFAULT_POLL_MS;
  // The heartbeat never exceeds this; the fleet's own lease can lower it.
  const heartbeatMs = options.heartbeatMs ?? positive(env.PRIME_FLEET_HEARTBEAT_MS) ?? DEFAULT_HEARTBEAT_MS;
  const settleMs = options.settleMs ?? positive(env.PRIME_FLEET_SETTLE_MS) ?? SETTLE_QUIET_MS;
  options = { ...options, heartbeatMs, settleMs };
  const dir = fleetAgentDir(configPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let stopping = false;
  const wakeups = new Map<string, () => void>();
  const stop = (why: string): void => {
    if (!stopping) logAgent("asked to stop (" + why + "); it finishes its round and leaves");
    stopping = true;
    // A loop may be asleep for minutes now; it has to see the signal at once.
    for (const w of wakeups.values()) w();
  };
  process.on("SIGTERM", () => stop("signal SIGTERM"));
  process.on("SIGINT", () => stop("signal SIGINT"));
  // A stop that is asked for in a file (where a signal would end the agent in the middle of its round): the loops
  // finish what they are doing and the agent leaves, as it does for SIGTERM.
  const endStopWatch = watchForStop(dir, startedAtMs, () => stop("a request to stop in the agent's directory"), STOP_WATCH_MS);

  // The runtime is found once: it is used to tell whether a space is
  // running, and looking it up on every round would be slow.
  const runtimeFound = detectRuntime().catch(() => undefined);
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
      settings: { ...effectiveSettings(settingsFromEnv(env)), pollMs, heartbeatMs, settleMs },
      ...(lastError ? { last_error: lastError } : {}),
      ...(lastAction ? { last_action: lastAction } : {}),
      ...(timing ? { timing } : {}),
      ...pushState(),
    };
    // An agent that lost its lock must not overwrite the one that won it (it runs for a moment more).
    if (ownsAgentState(configPath)) writeAgentState(configPath, state);
  };

  const loops = new Map<string, SpaceLoop>();
  const watchers = new Map<string, { stop: () => void }>();
  // A wake that came while the loop was busy, so it is not lost: an event that
  // says "pull now" must not wait for the next sleep to end.
  const pending = new Set<string>();
  write(0);
  // Looked for while the first state was being written: a start that is waiting for the state does not wait for this.
  const runtime = await runtimeFound;

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
        recorded: recordedPosition(configPath, fleet, name),
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
    const watcher = watchTree(
      work,
      (eventType, filename) => {
        // A repository that appeared or went away changes what is left alone.
        loop.paths.nested?.noteChange(eventType, filename);
        loop.dirty = true;
        // A change held back by a rush of publishes wakes the round once the hold is over, not at every write.
        const held = (loop.holdUntil ?? 0) - Date.now();
        if (held > 0) {
          loop.holdTimer ??= setTimeout(() => {
            loop.holdTimer = undefined;
            wake(name);
          }, held + 5);
          loop.holdTimer.unref?.();
          return;
        }
        wake(name);
      },
      // What git leaves out of a snapshot (a build's output, `node_modules`) wakes nothing.
      { ignore: new IgnoreFilter(work, loop.paths.gitDir) },
    );
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
    if (loop.holdTimer) clearTimeout(loop.holdTimer);
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

  endStopWatch();
  for (const watcher of watchers.values()) watcher.stop();
  // Only this agent's own state: one that lost its lock to another is leaving, and the state
  // that is there is the other's.
  if (ownsAgentState(configPath)) rmSync(fleetAgentStatePath(configPath), { force: true });
}
