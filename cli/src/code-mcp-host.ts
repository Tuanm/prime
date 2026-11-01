// The bundled code-mcp device server: src/code-mcp.ts in this package.
//
// code-mcp.ts is a script, not a library: importing it parses Bun.argv, starts
// an HTTP server and (with --gateway) dials the gateway. It must therefore never
// be imported statically. The only way in is the hidden "prime code-mcp"
// subcommand, which rewrites argv and then imports it dynamically.
//
// The specifier "#code-mcp" is a package.json subpath import that points at
// ./src/code-mcp.ts. It is a static string literal, so Bun.build and
// "bun build --compile" include the module in the bundle/binary. It is not a
// relative path so that "bun run typecheck" (tsconfig.typecheck.json) can map it
// to a declaration stub: code-mcp is written to its own conventions, not this
// package's strict compiler settings.

import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type OptionMap, mergeOptions, optionsFromConfig, parseCodeMcpArgs, toCodeMcpArgv } from "./code-mcp-options.ts";
import { defaultConfigPath, loadConfig } from "./config.ts";
import { UsageError } from "./errors.ts";
import { DEFAULT_GATEWAY } from "./target.ts";
import { type ServiceStatus, loadOverrides, loadServiceEnv, overridesPath, pidFilePath, serviceStatus } from "./service.ts";

/**
 * Environment variable carrying the device credential from "prime connect" to the
 * code-mcp child. A command-line flag would be visible to every local user via
 * ps; the environment of a process is not (only to its owner and root).
 */
export const GATEWAY_TOKEN_ENV = "MCP_CODE_MCP_GATEWAY_TOKEN";

/**
 * The argv code-mcp should see: the given args, plus "--gateway-token <value>"
 * from GATEWAY_TOKEN_ENV unless the args already carry an explicit one.
 * Exported for tests; the injected value only ever exists in this process.
 */
export function codeMcpArgv(args: string[], env: Record<string, string | undefined> = process.env): string[] {
  const token = env[GATEWAY_TOKEN_ENV];
  const explicit = args.some((a) => a === "--gateway-token" || a.startsWith("--gateway-token="));
  return token && !explicit ? [...args, "--gateway-token", token] : [...args];
}

/**
 * The pid of the "prime connect" that launched this code-mcp. Killing a process
 * does not kill its children - on Windows never (only a console Ctrl-C reaches
 * both), on POSIX not for SIGKILL - so without this an orphaned code-mcp would
 * keep the device online after "prime connect" is gone.
 */
export const PARENT_PID_ENV = "MCP_CODE_MCP_PARENT_PID";
const PARENT_POLL_MS = 1_000;

/** Is the process alive? Signal 0 only probes; EPERM still means it exists. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Exit when the launching process disappears. Returns the timer (for tests). */
export function watchParent(pid: number, exit: () => void = () => process.exit(0), who = "'prime connect'"): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    if (!processAlive(pid)) {
      clearInterval(timer);
      console.error(`[mcp] ${who} is gone; stopping code-mcp`);
      exit();
    }
  }, PARENT_POLL_MS);
  timer.unref();
  return timer;
}

/**
 * Set by 'prime connect' on its child: run code-mcp with exactly the given
 * arguments. The config's code-mcp section (and the running-service check) are
 * for people running 'prime code-mcp' themselves, not for connect's own device.
 */
export const RAW_ENV = "MCP_CODE_MCP_RAW";

/** Flags of 'prime code-mcp' itself; everything else belongs to code-mcp. */
export interface HostFlags {
  service: boolean;
  config?: string;
  log?: string;
}

export function splitHostFlags(args: string[]): { host: HostFlags; rest: string[] } {
  const host: HostFlags = { service: false };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--service") host.service = true;
    else if (arg === "--config" || arg === "--log") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a path`);
      host[arg === "--config" ? "config" : "log"] = value;
      i++;
    } else if (arg.startsWith("--config=")) host.config = arg.slice("--config=".length);
    else if (arg.startsWith("--log=")) host.log = arg.slice("--log=".length);
    else rest.push(arg);
  }
  return { host, rest };
}

/**
 * The argv code-mcp gets from 'prime code-mcp': the config's code-mcp section,
 * then (for the service) the overrides from 'service install', then the
 * command line - later layers win.
 */
export function effectiveCodeMcpArgv(rest: string[], host: HostFlags, configPath: string): { argv: string[]; options: OptionMap; help: boolean } {
  const parsed = parseCodeMcpArgs(rest);
  if (parsed.help) return { argv: ["--help"], options: {}, help: true };
  const config = loadConfig(configPath);
  const fromConfig = optionsFromConfig(config.codeMcp, configPath);
  const overrides = host.service ? loadOverrides(overridesPath(configPath)) : {};
  const options = withDefaultGateway(mergeOptions(fromConfig, overrides, parsed.options), config.defaults.gateway);
  return { argv: toCodeMcpArgv(options), options, help: false };
}

/**
 * A device id only means something on a gateway: code-mcp dials one only when
 * given --gateway, so "--id demo --token demo" alone silently ran a local-only
 * server. With an id and no gateway, use the CLI's gateway - the config's
 * default, else the managed one - like every other mcp command.
 */
export function withDefaultGateway(options: OptionMap, configuredDefault: string | undefined): OptionMap {
  if (typeof options.id !== "string" || typeof options.gateway === "string") return options;
  return { ...options, gateway: configuredDefault ?? DEFAULT_GATEWAY };
}

/** Send everything this process prints to a file (the Windows service has no console). */
function redirectOutput(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const write = (chunk: unknown) => {
    try {
      appendFileSync(path, typeof chunk === "string" || chunk instanceof Uint8Array ? chunk : String(chunk));
    } catch {}
    return true;
  };
  process.stdout.write = write as typeof process.stdout.write;
  process.stderr.write = write as typeof process.stderr.write;
  const line = (...parts: unknown[]) => write(parts.map((p) => (typeof p === "string" ? p : Bun.inspect(p))).join(" ") + "\n");
  console.log = line;
  console.info = line;
  console.warn = line;
  console.error = line;
  write(`\n--- code-mcp service started ${new Date().toISOString()} (pid ${process.pid}) ---\n`);
}

/** Set on the relaunched service process, so it does not relaunch again. */
export const SERVICE_ENV_APPLIED = "MCP_CODE_MCP_SERVICE_ENV";

/**
 * The environment the service's code-mcp runs with: this process's, plus the
 * network settings saved at install, plus trust in the operating system's
 * certificate store - where an organisation installs its root certificate - in
 * addition to Bun's own (NODE_USE_SYSTEM_CA=1, unless the user chose otherwise).
 */
export function serviceEnv(base: Record<string, string | undefined>, saved: Record<string, string>): Record<string, string | undefined> {
  return { NODE_USE_SYSTEM_CA: "1", ...base, ...saved };
}

async function relaunchWithServiceEnv(args: string[], configPath: string): Promise<void> {
  const env = { ...serviceEnv(process.env, loadServiceEnv(overridesPath(configPath))), [SERVICE_ENV_APPLIED]: "1", [PARENT_PID_ENV]: String(process.pid) };
  const child = Bun.spawn([...selfCommand(), "code-mcp", ...args], { env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const stop = (signal: NodeJS.Signals) => () => {
    try {
      child.kill(signal);
    } catch {}
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, stop(signal));
  // Windows: the task runs conhost, which runs this. When the task is stopped,
  // conhost goes and so must this process - and its child with it.
  if (process.platform === "win32" && process.ppid > 0) {
    watchParent(process.ppid, () => {
      try {
        child.kill();
      } catch {}
      process.exit(0);
    }, "the service's console host");
  }
  const code = await child.exited;
  process.exit(child.signalCode ? 1 : (code ?? 1));
}

/** Status check that never blocks 'prime code-mcp' on a broken service manager. */
function serviceStatusSafe(configPath: string): ServiceStatus | undefined {
  try {
    return serviceStatus(undefined, configPath);
  } catch {
    return undefined;
  }
}

/** Run code-mcp in this process: config + (service) overrides + command line. */
export async function runCodeMcp(args: string[]): Promise<void> {
  if (process.env[RAW_ENV] === "1") {
    delete process.env[RAW_ENV];
    return runRaw(args);
  }
  const { host, rest } = splitHostFlags(args);
  const configPath = host.config ?? defaultConfigPath();
  const { argv, help } = effectiveCodeMcpArgv(rest, host, configPath);
  if (!help && !host.service) {
    // One code-mcp per machine and config: the service already owns the port
    // and the device id, and a second copy would fight it for both.
    const status = serviceStatusSafe(configPath);
    if (status?.running) {
      throw new UsageError(
        `the code-mcp service is running (${status.where})`,
        "It already serves these options. Stop it first with 'prime service uninstall', or check it with 'prime service status'.",
      );
    }
  }
  if (host.service && process.env[SERVICE_ENV_APPLIED] !== "1") {
    // Relaunch once with the network settings in the environment: Bun reads the
    // CA variables only at start, and a service starts without them.
    return relaunchWithServiceEnv(args, configPath);
  }
  delete process.env[SERVICE_ENV_APPLIED];
  if (host.service) {
    if (host.log) redirectOutput(host.log);
    // Lets 'service status' (and 'prime code-mcp') tell that the service is up.
    const pidFile = pidFilePath(configPath);
    try {
      writeFileSync(pidFile, String(process.pid));
      process.on("exit", () => {
        try {
          if (readFileSync(pidFile, "utf8").trim() === String(process.pid)) rmSync(pidFile, { force: true });
        } catch {}
      });
    } catch {}
    // Windows: the task runs conhost, which runs this. Stopping the task ends
    // conhost only - follow it out rather than linger as an orphan.
    if (process.platform === "win32" && process.ppid > 0) watchParent(process.ppid, undefined, "the service's console host");
  }
  return runRaw(argv);
}

async function runRaw(args: string[]): Promise<void> {
  const effective = codeMcpArgv(args);
  // Consumed: code-mcp's own child processes (bash, jobs, MCP servers) inherit
  // process.env, and must never receive the device credential.
  delete process.env[GATEWAY_TOKEN_ENV];
  const parent = Number(process.env[PARENT_PID_ENV]);
  delete process.env[PARENT_PID_ENV];
  if (Number.isInteger(parent) && parent > 0) watchParent(parent);
  // code-mcp reads Bun.argv.slice(2). Rewrite both argv views in place so the
  // script sees exactly its own flags (not "code-mcp" or any mcp flag). This
  // changes only the in-memory arrays, not what ps shows for this process.
  for (const argv of [Bun.argv, process.argv]) {
    const head = argv.slice(0, 2);
    argv.splice(0, argv.length, ...head, ...effective);
  }
  await import("#code-mcp");
}

/**
 * The argv that re-runs this CLI: the compiled binary itself, or the Bun
 * runtime plus the script (src/index.ts or dist/prime.js).
 */
export function selfCommand(): string[] {
  const main = Bun.main;
  // A compiled executable reports its embedded entry point from the virtual
  // filesystem: /$bunfs/root/... on POSIX, B:/~BUN/root/... on Windows.
  const compiled = main.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(main);
  return compiled ? [process.execPath] : [process.execPath, main];
}
