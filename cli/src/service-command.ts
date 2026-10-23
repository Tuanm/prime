// 'prime service install [code-mcp options...]', 'prime service uninstall',
// 'prime service status' - see service.ts for what each platform gets.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { describeOptions, mergeOptions, type OptionMap, optionsFromConfig, parseCodeMcpArgs } from "./code-mcp-options.ts";
import { withDefaultGateway } from "./code-mcp-host.ts";
import { defaultConfigPath, loadConfig } from "./config.ts";
import { CliError, UsageError } from "./errors.ts";
import { bold, dim, green, printJson, red, yellow } from "./output.ts";
import {
  type Platform,
  captureNetworkEnv,
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
    throw new CliError("'prime service' supports Linux (systemd), macOS (launchd) and Windows (Task Scheduler); this is " + process.platform);
  }
  return p;
}

export interface ServiceCommandOptions {
  json: boolean;
  /** --config <path>: the config the service reads (default: the usual one). */
  config?: string;
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

type OnlineCheck = { state: "online" | "offline" | "rejected"; gateway: string; status?: number; detail: string };

/**
 * Ask the gateway whether the device is online: a ping through the relay
 * answers 200 once the device's tunnel is up, 503 while it is not, and 401/403
 * when the gateway does not accept these credentials.
 */
async function waitOnline(options: OptionMap, timeoutMs = 30_000): Promise<OnlineCheck> {
  const raw = String(options.gateway);
  const gateway = (/^[a-z]+:\/\//i.test(raw) ? raw : "https://" + raw).replace(/^ws(s?):/i, "http$1:").replace(/\/+$/, "");
  const token = typeof options["gateway-token"] === "string" ? options["gateway-token"] : options.token;
  const deadline = Date.now() + timeoutMs;
  let last: OnlineCheck = { state: "offline", gateway, detail: "no answer" };
  while (Date.now() < deadline) {
    try {
      const r = await fetch(gateway + "/mcp/" + encodeURIComponent(String(options.id)), {
        method: "POST",
        headers: { "content-type": "application/json", ...(typeof token === "string" ? { "x-device-token": token } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await r.text();
      if (r.status === 200) return { state: "online", gateway, status: 200, detail: "online" };
      if (r.status === 401 || r.status === 403) return { state: "rejected", gateway, status: r.status, detail: text.slice(0, 120) };
      last = { state: "offline", gateway, status: r.status, detail: "HTTP " + r.status + " " + text.slice(0, 80) };
    } catch (err) {
      last = { state: "offline", gateway, detail: err instanceof Error ? err.message : String(err) };
    }
    await Bun.sleep(1_000);
  }
  return last;
}

/** Wait until the service is running - and still running a moment later (no crash loop). */
async function waitRunning(platform: Platform, configPath: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serviceStatus(platform, configPath).running) {
      await Bun.sleep(2_500);
      if (serviceStatus(platform, configPath).running) return true;
    }
    await Bun.sleep(500);
  }
  return false;
}

export async function serviceInstall(args: string[], opts: ServiceCommandOptions): Promise<void> {
  const platform = platformOrThrow();
  const { options: passed, help } = parseCodeMcpArgs(args);
  if (help) throw new UsageError("'prime service install' takes code-mcp options (see 'prime code-prime --help'), e.g. prime service install --port 7777");
  const configPath = resolve(opts.config ?? defaultConfigPath());
  // Validate now, not inside a service log: a typo in the config fails here.
  const config = loadConfig(configPath);
  const fromConfig = optionsFromConfig(config.codeMcp, configPath);
  // Exactly what the service will compute at start (see effectiveCodeMcpArgv).
  const effective = withDefaultGateway(mergeOptions(fromConfig, passed), config.defaults.gateway);

  if (typeof effective.token !== "string" && typeof effective.gateway !== "string") {
    opts.note(yellow("note: no token configured - code-mcp will accept unauthenticated requests on " + localUrl(effective) + " (code-mcp's default, loopback only)."));
  }

  const spec = serviceSpecFor(platform, configPath);
  const networkEnv = captureNetworkEnv();
  saveOverrides(overridesPath(configPath), passed, networkEnv);
  const where = installService(platform, spec);
  const running = await waitRunning(platform, configPath);
  const status = serviceStatus(platform, configPath);

  if (!running) {
    const log = recentLog(platform, spec.logPath);
    throw new CliError(
      "the code-prime service was installed but is not staying up (" + (status.detail ?? "not running") + ")" + (log ? "\n\n" + log + "\n" : ""),
      "Fix the options (config: " + configPath + "), then run 'prime service install' again - or remove it with 'prime service uninstall'.",
    );
  }

  // Running locally is not the whole job when a device id is set: the device
  // must also be ONLINE on its gateway, with credentials the gateway accepts.
  const online = typeof effective.id === "string" ? await waitOnline(effective) : undefined;
  if (online?.state === "rejected") {
    throw new CliError(
      "code-mcp is running, but " + online.gateway + " rejects device " + effective.id + " with this token (HTTP " + online.status + ")",
      "Check the id and token registered in the gateway's admin page, fix them, then run 'prime service install' again.",
    );
  }
  if (online?.state === "offline") {
    const log = recentLog(platform, spec.logPath);
    opts.note(yellow("warning: code-mcp is running but device " + effective.id + " is not online on " + online.gateway + " yet (" + online.detail + ")") + (log ? "\n" + dim(log) : ""));
  }

  if (opts.json) {
    printJson({ installed: true, running: true, platform, where, device: online ? { id: effective.id, gateway: online.gateway, online: online.state === "online" } : undefined, options: describeOptions(effective), url: localUrl(effective), log: platform === "linux" ? "journalctl --user -u code-mcp" : spec.logPath, config: configPath, overrides: overridesPath(configPath) });
    return;
  }
  opts.out(green("✓") + " code-prime service installed and running");
  opts.out("  definition  " + where);
  opts.out("  options     " + describeOptions(effective));
  opts.out("  local URL   " + localUrl(effective));
  if (online?.state === "online") opts.out("  device      " + bold(String(effective.id)) + " online on " + online.gateway);
  const carried = Object.keys(networkEnv);
  if (carried.length > 0) opts.out("  network     " + carried.join(", ") + " (from this shell)");
  opts.out("  logs        " + (platform === "linux" ? "journalctl --user -u code-mcp -f" : spec.logPath));
  opts.out(dim("  Options come from " + configPath + " (code-mcp section), overridden by the ones given here (" + overridesPath(configPath) + ")."));
  opts.out(dim("  They are read at every start: after editing the config, re-run 'prime service install' to restart it."));
  if (platform === "linux") {
    const linger = Bun.spawnSync(["loginctl", "show-user", process.env.USER ?? "", "-p", "Linger", "--value"], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
    if (linger === "no") opts.out(dim("  It runs while you are logged in. To keep it running after logout: loginctl enable-linger " + (process.env.USER ?? "$USER")));
  }
}

export async function serviceUninstall(args: string[], opts: ServiceCommandOptions): Promise<void> {
  if (args.length > 0) throw new UsageError("'prime service uninstall' takes no arguments");
  const platform = platformOrThrow();
  const configPath = resolve(opts.config ?? defaultConfigPath());
  const had = uninstallService(platform, configPath);
  rmSync(overridesPath(configPath), { force: true });
  const after = serviceStatus(platform, configPath);
  if (after.running || after.installed) {
    throw new CliError("the code-prime service could not be fully removed (" + (after.detail ?? "still present") + ")", "Check " + after.where);
  }
  if (opts.json) {
    printJson({ uninstalled: had, platform, where: after.where });
    return;
  }
  opts.out(had ? green("✓") + " code-prime service stopped and uninstalled" : "no code-prime service was installed");
}

export async function serviceStatusCommand(args: string[], opts: ServiceCommandOptions): Promise<void> {
  if (args.length > 0) throw new UsageError("'prime service status' takes no arguments");
  const platform = platformOrThrow();
  const configPath = resolve(opts.config ?? defaultConfigPath());
  const status = serviceStatus(platform, configPath);
  let options: OptionMap | undefined;
  try {
    // The same options the service computes at start, default gateway included.
    const config = loadConfig(configPath);
    options = withDefaultGateway(mergeOptions(optionsFromConfig(config.codeMcp, configPath), loadOverrides(overridesPath(configPath))), config.defaults.gateway);
  } catch {}
  if (opts.json) {
    printJson({ ...status, platform, options: options ? describeOptions(options) : undefined, url: options ? localUrl(options) : undefined });
    return;
  }
  const state = status.running ? green("running") : status.installed ? yellow(status.detail ?? "installed, not running") : red("not installed");
  opts.out("code-prime service: " + bold(state));
  opts.out("  definition  " + status.where);
  if (options && status.installed) {
    opts.out("  options     " + describeOptions(options));
    opts.out("  local URL   " + localUrl(options));
  }
}
