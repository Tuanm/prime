// The fleet agent as a user service.
//
// A fleet member holds the fleet's lease while it is running. If its agent only
// exists while somebody has a terminal open, a logout or a reboot leaves the
// fleet with no primary until a person notices and starts it again - which is
// exactly what happened. Installing it is 'prime fleets agent install'.

import { homedir } from "node:os";
import { join } from "node:path";

import { selfCommand } from "./code-mcp-host.ts";
import { defaultConfigPath } from "./config.ts";
import {
  installService,
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
    command: [...selfCommand(), "__fleet-agent", "--config", configPath],
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

/** Whether it is installed, and whether it is running. */
export function fleetAgentServiceStatus(configPath: string = defaultConfigPath()): ServiceStatus {
  return serviceStatus(process.platform as Platform, configPath, { name: FLEET_AGENT_NAME, label: FLEET_AGENT_LABEL });
}
