// The fleet agent as a user service.
//
// A fleet member holds the fleet's lease while it is running. If its agent only
// exists while somebody has a terminal open, a logout or a reboot leaves the
// fleet with no primary until a person notices and starts it again - which is
// exactly what happened. Installing it is 'prime fleets agent install'.

import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { selfCommand } from "./code-mcp-host.ts";
import { defaultConfigPath } from "./config.ts";
import { samePath } from "./fleet-paths.ts";
import {
  installService,
  readServiceDefinition,
  restartService,
  serviceDefinitionPath,
  serviceStatus,
  uninstallService,
  type Platform,
  type ServiceSpec,
  type ServiceStatus,
} from "./service.ts";

/** The unit name and launchd label. Named for what it is, not for the buddy. */
export const FLEET_AGENT_NAME = "prime-fleet-agent";
export const FLEET_AGENT_LABEL = "dev.prime.fleet-agent";

/**
 * The service definition for this machine.
 *
 * Unlike the buddy, the agent must come back after any exit, including a clean
 * one: a fleet with no agent is a fleet whose place in it lapses.
 */
export function fleetAgentSpec(configPath: string, platform: Platform = process.platform as Platform): ServiceSpec {
  const home = homedir();
  const logPath =
    platform === "darwin"
      ? join(home, "Library", "Logs", "prime", "fleet-agent.log")
      : join(home, ".prime", "fleet-agent.log");
  return {
    command: [...selfCommand(), "__fleet-agent", "--config", resolve(configPath)],
    configPath,
    logPath,
    pathEnv: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    home,
    name: FLEET_AGENT_NAME,
    label: FLEET_AGENT_LABEL,
    description: "Prime fleet agent (keeps this machine's spaces in step)",
    restart: "always",
    keepAlive: true,
  };
}

/** Install (or reinstall) and start it. Returns where the definition lives. */
export function installFleetAgentService(configPath: string = defaultConfigPath()): string {
  return installService(process.platform as Platform, fleetAgentSpec(configPath));
}

/** Stop and remove it. Returns whether one was installed. */
export function uninstallFleetAgentService(configPath: string = defaultConfigPath()): boolean {
  return uninstallService(process.platform as Platform, configPath, { name: FLEET_AGENT_NAME, label: FLEET_AGENT_LABEL });
}

/**
 * The configuration the installed service runs, from its definition (the manager is not asked).
 * A definition that does not say which (a binary plist, a hand-edited ExecStart) is taken for the
 * default configuration's, which is what every install made.
 */
export function fleetAgentServiceConfig(
  definition: { config: string | undefined } | null = readServiceDefinition(process.platform as Platform, { name: FLEET_AGENT_NAME, label: FLEET_AGENT_LABEL }) ?? null,
): string | undefined {
  if (definition === null) return undefined;
  // Not defaultConfigPath(): that honours PRIME_CONFIG, and an install is made for the real default.
  return definition.config ?? join(homedir(), ".prime", "config.yaml");
}

/**
 * Whether the configuration a service definition names is this one. The definition's path is read
 * the way the manager runs it: relative to the home it starts in (`WorkingDirectory`), not to
 * wherever this command was typed; and both sides are compared as the file system names them.
 */
export function sameConfig(runs: string, configPath: string, home: string = homedir()): boolean {
  return samePath(resolve(home, runs), configPath);
}

/** A status as seen from one configuration: a service that runs another is not this one's. */
export function bindServiceStatus(
  status: ServiceStatus,
  runs: string | undefined,
  configPath: string,
  home: string = homedir(),
): ServiceStatus & { config?: string } {
  if (runs === undefined) return status;
  const config = resolve(home, runs);
  if (sameConfig(runs, configPath, home)) return { ...status, config };
  return { installed: false, running: false, where: status.where, detail: "installed for " + config, config };
}

/**
 * Whether it is installed for this configuration, and whether it is running. There is one
 * service per machine, and it runs one configuration: for any other it is not installed.
 */
export function fleetAgentServiceStatus(
  configPath: string = defaultConfigPath(),
  deps: {
    /** What the service's definition says (null: there is none); replaced in tests. */
    definition?: { config: string | undefined } | null;
    /** Ask the manager; replaced in tests. */
    probe?: () => ServiceStatus;
  } = {},
): ServiceStatus & { config?: string } {
  const identity = { name: FLEET_AGENT_NAME, label: FLEET_AGENT_LABEL };
  const platform = process.platform as Platform;
  const definition =
    deps.definition !== undefined ? deps.definition ?? undefined : readServiceDefinition(platform, identity);
  // No definition file for this configuration's service on a platform that keeps one: there is nothing
  // for the manager to say, and asking it (launchctl print, systemctl show) is a call for nothing.
  const where = serviceDefinitionPath(platform, identity);
  if (definition === undefined && where !== undefined) {
    return { installed: false, running: false, where };
  }
  const status = (deps.probe ?? (() => serviceStatus(platform, configPath, identity)))();
  return bindServiceStatus(status, fleetAgentServiceConfig(definition ?? null), configPath);
}

/** Restart the installed service through its manager. Returns whether the manager did. */
export function restartFleetAgentService(): boolean {
  return restartService(process.platform as Platform, { name: FLEET_AGENT_NAME, label: FLEET_AGENT_LABEL });
}
