// 'mcp service install [code-mcp options...]', 'mcp service uninstall',
// 'mcp service status' - see service.ts for what each platform gets.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { describeOptions, mergeOptions, type OptionMap, optionsFromConfig, parseCodeMcpArgs } from "./code-mcp-options.ts";
import { defaultConfigPath, loadConfig } from "./config.ts";
import { CliError, UsageError } from "./errors.ts";
import { bold, dim, green, printJson, red, yellow } from "./output.ts";
import {
  type Platform,
  installService,
  loadOverrides,
  overridesPath,
  saveOverrides,
  serviceSpecFor,
  serviceStatus,
  uninstallService,
} from "./service.ts";

const SUPPORTED: Platform[] = ["linux", "darwin", "win32"];

function platformOrThrow(): Platform {
  const p = process.platform as Platform;
  if (!SUPPORTED.includes(p)) {
    throw new CliError("'mcp service' supports Linux (systemd), macOS (launchd) and Windows (Task Scheduler); this is " + process.platform);
  }
  return p;
}

export interface ServiceCommandOptions {
  json: boolean;
  out: (text: string) => void;
  note: (text: string) => void;
}

/** Where the running service can be reached locally (for the summary). */
function localUrl(options: OptionMap): string {
  const bind = typeof options.bind === "string" ? options.bind : "127.0.0.1";
  const host = bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind.includes(":") ? "[" + bind + "]" : bind;
  const port = typeof options.port === "string" ? options.port : "7777";
  return "http://" + host + ":" + port + "/mcp";
}

/** The last lines the service wrote, to explain a failed start. */
function recentLog(platform: Platform, logPath: string): string {
  try {
    if (platform === "linux") {
      const r = Bun.spawnSync(["journalctl", "--user", "-u", "code-mcp.service", "-n", "25", "--no-pager", "-o", "cat"], { stdout: "pipe", stderr: "pipe" });
      return r.stdout.toString().trim();
    }
    if (existsSync(logPath)) return readFileSync(logPath, "utf8").split(/\r?\n/).slice(-25).join("\n").trim();
  } catch {}
  return "";
}

/** Wait until the service is running - and still running a moment later (no crash loop). */
async function waitRunning(platform: Platform, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serviceStatus(platform).running) {
      await Bun.sleep(2_500);
      if (serviceStatus(platform).running) return true;
    }
    await Bun.sleep(500);
  }
  return false;
}

export async function serviceInstall(args: string[], opts: ServiceCommandOptions): Promise<void> {
  const platform = platformOrThrow();
  const { options: passed, help } = parseCodeMcpArgs(args);
  if (help) throw new UsageError("'mcp service install' takes code-mcp options (see 'mcp code-mcp --help'), e.g. mcp service install --port 7777");
  const configPath = resolve(defaultConfigPath());
  // Validate now, not inside a service log: a typo in the config fails here.
  const fromConfig = optionsFromConfig(loadConfig(configPath).codeMcp, configPath);
  const effective = mergeOptions(fromConfig, passed);

  if (typeof effective.token !== "string" && typeof effective.gateway !== "string") {
    opts.note(yellow("note: no token configured - code-mcp will accept unauthenticated requests on " + localUrl(effective) + " (code-mcp's default, loopback only)."));
  }

  const spec = serviceSpecFor(platform, configPath);
  saveOverrides(overridesPath(configPath), passed);
  const where = installService(platform, spec);
  const running = await waitRunning(platform);
  const status = serviceStatus(platform);

  if (!running) {
    const log = recentLog(platform, spec.logPath);
    throw new CliError(
      "the code-mcp service was installed but is not staying up (" + (status.detail ?? "not running") + ")" + (log ? "\n\n" + log + "\n" : ""),
      "Fix the options (config: " + configPath + "), then run 'mcp service install' again - or remove it with 'mcp service uninstall'.",
    );
  }

  if (opts.json) {
    printJson({ installed: true, running: true, platform, where, options: describeOptions(effective), url: localUrl(effective), log: platform === "linux" ? "journalctl --user -u code-mcp" : spec.logPath, config: configPath, overrides: overridesPath(configPath) });
    return;
  }
  opts.out(green("✓") + " code-mcp service installed and running");
  opts.out("  definition  " + where);
  opts.out("  options     " + describeOptions(effective));
  opts.out("  local URL   " + localUrl(effective));
  opts.out("  logs        " + (platform === "linux" ? "journalctl --user -u code-mcp -f" : spec.logPath));
  opts.out(dim("  Options come from " + configPath + " (code-mcp section), overridden by the ones given here (" + overridesPath(configPath) + ")."));
  opts.out(dim("  They are read at every start: after editing the config, re-run 'mcp service install' to restart it."));
  if (platform === "linux") {
    const linger = Bun.spawnSync(["loginctl", "show-user", process.env.USER ?? "", "-p", "Linger", "--value"], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
    if (linger === "no") opts.out(dim("  It runs while you are logged in. To keep it running after logout: loginctl enable-linger " + (process.env.USER ?? "$USER")));
  }
}

export async function serviceUninstall(args: string[], opts: ServiceCommandOptions): Promise<void> {
  if (args.length > 0) throw new UsageError("'mcp service uninstall' takes no arguments");
  const platform = platformOrThrow();
  const configPath = resolve(defaultConfigPath());
  const had = uninstallService(platform, configPath);
  rmSync(overridesPath(configPath), { force: true });
  const after = serviceStatus(platform);
  if (after.running || after.installed) {
    throw new CliError("the code-mcp service could not be fully removed (" + (after.detail ?? "still present") + ")", "Check " + after.where);
  }
  if (opts.json) {
    printJson({ uninstalled: had, platform, where: after.where });
    return;
  }
  opts.out(had ? green("✓") + " code-mcp service stopped and uninstalled" : "no code-mcp service was installed");
}

export async function serviceStatusCommand(args: string[], opts: ServiceCommandOptions): Promise<void> {
  if (args.length > 0) throw new UsageError("'mcp service status' takes no arguments");
  const platform = platformOrThrow();
  const configPath = resolve(defaultConfigPath());
  const status = serviceStatus(platform);
  let options: OptionMap | undefined;
  try {
    options = mergeOptions(optionsFromConfig(loadConfig(configPath).codeMcp, configPath), loadOverrides(overridesPath(configPath)));
  } catch {}
  if (opts.json) {
    printJson({ ...status, platform, options: options ? describeOptions(options) : undefined, url: options ? localUrl(options) : undefined });
    return;
  }
  const state = status.running ? green("running") : status.installed ? yellow(status.detail ?? "installed, not running") : red("not installed");
  opts.out("code-mcp service: " + bold(state));
  opts.out("  definition  " + status.where);
  if (options && status.installed) {
    opts.out("  options     " + describeOptions(options));
    opts.out("  local URL   " + localUrl(options));
  }
}
