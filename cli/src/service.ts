// 'prime service install|uninstall|status' - run the bundled code-mcp as a user
// service that starts with the session and restarts on failure:
//
//   Linux    systemd user unit   ~/.config/systemd/user/code-mcp.service
//   macOS    launchd agent       ~/Library/LaunchAgents/dev.prime.code-mcp.plist
//   Windows  Scheduled Task      \prime\code-mcp (at logon, no admin needed)
//
// The service runs "prime code-mcp --service --config <path>": options are read at
// every start from the config's "code-mcp:" section plus the overrides given to
// 'service install' (kept in service.yaml beside the config, 0600). So no
// credential is ever written into the service definition or onto a command
// line where ps would show it.

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { selfCommand } from "./code-mcp-host.ts";
import { type OptionMap, optionsFromConfig } from "./code-mcp-options.ts";
import { defaultConfigPath, yamlScalar } from "./config.ts";
import { CliError } from "./errors.ts";
import { samePath } from "./fleet-paths.ts";

export type Platform = "linux" | "darwin" | "win32";

export const SERVICE_NAME = "code-mcp";
export const LAUNCHD_LABEL = "dev.prime.code-mcp";
export const TASK_PATH = "\\prime\\";
export const TASK_NAME = "code-mcp";

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  /** Where the definition lives (file, or the task's full name). */
  where: string;
  detail?: string;
  /** The process the manager is running for it, when it says. */
  pid?: number;
  /**
   * Whether the manager answered at all. A service file can be there with nothing to run it (a
   * headless login, no user bus, an install that stopped half way); false says so. Left out where
   * there is no manager to ask.
   */
  reachable?: boolean;
}

export interface ServiceSpec {
  /** argv of the service process: the mcp binary (or bun + script) + code-mcp --service ... */
  command: string[];
  configPath: string;
  logPath: string;
  /** PATH captured at install: services otherwise get a minimal one, and code-mcp runs the user's commands. */
  pathEnv: string;
  home: string;
  /** The service's own name: "code-mcp" for the buddy, "prime-fleet-agent" for a fleet member. */
  name?: string;
  /** The launchd label, which is a domain name rather than a file name. */
  label?: string;
  /** One line the person reads in systemctl/list and in the unit file. */
  description?: string;
  /** What to do after the process exits. A buddy may exit cleanly; an agent should stay. */
  restart?: "on-failure" | "always";
  /** Run at login and come back after any exit, including a clean one. */
  keepAlive?: boolean;
}

// ---- paths -------------------------------------------------------------------

export function overridesPath(configPath: string): string {
  return join(dirname(configPath), "service.yaml");
}

export function systemdUnitPath(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
  name = SERVICE_NAME,
): string {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() ? env.XDG_CONFIG_HOME : join(home, ".config");
  return join(base, "systemd", "user", name + ".service");
}

export function launchdPlistPath(home = homedir(), label = LAUNCHD_LABEL): string {
  return join(home, "Library", "LaunchAgents", label + ".plist");
}

export function defaultLogPath(platform: Platform, configPath: string, home = homedir()): string {
  if (platform === "darwin") return join(home, "Library", "Logs", "prime", "code-mcp.log");
  // Linux logs to the journal; this file is only used on Windows.
  return join(dirname(configPath), "code-mcp.log");
}

// ---- overrides file ----------------------------------------------------------

export function loadOverrides(path: string): OptionMap {
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new CliError("invalid YAML in " + path + ": " + (err instanceof Error ? err.message : String(err)), "Re-run 'prime service install' to rewrite it.");
  }
  const section = raw && typeof raw === "object" ? (raw as Record<string, unknown>)["code-mcp"] : undefined;
  if (!section || typeof section !== "object") return {};
  const cleaned: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(section as Record<string, unknown>)) {
    if (typeof v === "boolean" || typeof v === "string") cleaned[k] = v;
    else if (typeof v === "number") cleaned[k] = String(v);
  }
  return optionsFromConfig(cleaned, path);
}

/**
 * Network settings carried from the shell that ran 'prime service install' to
 * the service. A service starts with almost no environment, so without these a
 * machine behind a proxy, or one whose network inspects TLS, connects fine from
 * a terminal and fails from the service ("TLS handshake failed"). Bun reads the
 * CA variables only at process start, so they are applied by relaunching.
 */
export const NETWORK_ENV_NAMES = [
  "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_USE_SYSTEM_CA",
] as const;

export function captureNetworkEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of NETWORK_ENV_NAMES) {
    const value = env[name];
    if (typeof value === "string" && value.trim() !== "") out[name] = value;
  }
  return out;
}

export function loadServiceEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  const section = raw && typeof raw === "object" ? (raw as Record<string, unknown>).env : undefined;
  const out: Record<string, string> = {};
  if (!section || typeof section !== "object") return out;
  const allowed = new Set<string>(NETWORK_ENV_NAMES);
  for (const [k, v] of Object.entries(section as Record<string, unknown>)) {
    if (allowed.has(k) && typeof v === "string") out[k] = v;
  }
  return out;
}

export function saveOverrides(path: string, options: OptionMap, env: Record<string, string> = {}): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let text = "# Options given to 'prime service install'. They override the code-mcp\n";
  text += "# section of config.yaml for the service only. Holds secrets: keep it private.\n";
  const keys = Object.keys(options);
  text += keys.length === 0 ? "code-mcp: {}\n" : "code-mcp:\n" + keys.map((k) => "  " + k + ": " + yamlScalar(options[k]!) + "\n").join("");
  // Proxy URLs can hold credentials: this file is 0600, the service definition is not.
  const envKeys = Object.keys(env);
  if (envKeys.length > 0) {
    text += "# Network settings from the shell that ran 'prime service install'.\n";
    text += "env:\n" + envKeys.map((k) => "  " + k + ": " + yamlScalar(env[k]!) + "\n").join("");
  }
  writeFileSync(path, text, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {}
}

// ---- definitions (pure) ------------------------------------------------------

/** systemd ExecStart quoting: double quotes, with \ " escaped and % $ doubled. */
export function systemdQuote(arg: string): string {
  return '"' + arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$") + '"';
}

/** Environment= quoting: like ExecStart, but $ is literal there (only % is a specifier). */
export function systemdEnvQuote(assignment: string): string {
  return '"' + assignment.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%") + '"';
}

/** The `--config` a launchd definition runs its program with. */
export function parseLaunchdConfig(plist: string): string | undefined {
  const unescape = (t: string) =>
    t
      .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number.parseInt(d, 10)))
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&");
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1];
  if (args === undefined) return undefined;
  const list = [...args.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unescape(m[1]!));
  return configOf(list);
}

/** The value of `--config <path>` or `--config=<path>` in an argument list. */
function configOf(list: string[]): string | undefined {
  const at = list.indexOf("--config");
  if (at >= 0) return list[at + 1];
  const joined = list.find((a) => a.startsWith("--config="));
  return joined === undefined ? undefined : joined.slice("--config=".length);
}

/** The `--config` a systemd unit's ExecStart runs its program with (see `systemdQuote`). */
export function parseSystemdConfig(unit: string): string | undefined {
  // As systemd reads it: `ExecStart=` with nothing after it clears what came before, and
  // the last command given is the one that runs (a drop-in's, after the unit's own).
  let line: string | undefined;
  for (const found of unit.matchAll(/^ExecStart=(.*)$/gm)) {
    const value = found[1]!.trim();
    line = value === "" ? undefined : value;
  }
  if (line === undefined) return undefined;
  const list = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\(.)/g, "$1").replace(/%%/g, "%").replace(/\$\$/g, "$"));
  return configOf(list);
}

/**
 * The directories a systemd user manager reads units and their drop-ins from, highest priority first
 * (systemd.unit(5)): the user's own and the machine's (`/etc/systemd/user` among them).
 */
export function systemdUserDirs(env: Record<string, string | undefined> = process.env, home = homedir()): string[] {
  const config = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() ? env.XDG_CONFIG_HOME : join(home, ".config");
  const data = env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim() ? env.XDG_DATA_HOME : join(home, ".local", "share");
  const runtime = env.XDG_RUNTIME_DIR && env.XDG_RUNTIME_DIR.trim() ? env.XDG_RUNTIME_DIR : undefined;
  return [
    join(config, "systemd", "user.control"),
    ...(runtime ? [join(runtime, "systemd", "user.control"), join(runtime, "systemd", "transient")] : []),
    join(config, "systemd", "user"),
    "/etc/xdg/systemd/user",
    "/etc/systemd/user",
    ...(runtime ? [join(runtime, "systemd", "user")] : []),
    "/run/systemd/user",
    join(data, "systemd", "user"),
    "/usr/local/lib/systemd/user",
    "/usr/lib/systemd/user",
    "/lib/systemd/user",
  ];
}

/**
 * The drop-in files that apply to a unit, in the order systemd merges them: `<unit>.service.d/*.conf`
 * from every directory it reads, ordered by file name, and a file of a name that a higher directory
 * has too is that directory's (it masks the other).
 */
export function systemdDropIns(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
  name = SERVICE_NAME,
  roots: string[] = systemdUserDirs(env, home),
): string[] {
  const byName = new Map<string, string>();
  for (const root of roots) {
    let names: string[];
    try {
      names = readdirSync(join(root, name + ".service.d"));
    } catch {
      continue; // none here
    }
    for (const file of names) if (file.endsWith(".conf") && !byName.has(file)) byName.set(file, join(root, name + ".service.d", file));
  }
  return [...byName.keys()].sort().map((file) => byName.get(file)!);
}

/**
 * What an installed service's definition says (read from its file, the manager is not asked):
 * undefined when there is no definition, and `config` undefined when there is one that does not
 * say which configuration it runs (unreadable: a binary plist, a hand-edited ExecStart).
 */
export function readServiceDefinition(
  platform: Platform,
  identity: { name?: string; label?: string } = {},
  home = homedir(),
  env: Record<string, string | undefined> = process.env,
  /** The directories of units systemd reads, highest priority first (see `systemdUserDirs`); replaced in tests. */
  dropInRoots?: string[],
): { config: string | undefined } | undefined {
  try {
    if (platform === "linux") {
      const unit = systemdUnitPath(env, home, identity.name ?? SERVICE_NAME);
      // The unit's own text, then its drop-ins (`<unit>.d/*.conf`, in name order) as systemd merges them:
      // `systemctl --user edit` writes the ones that override ExecStart there.
      let text = readFileSync(unit, "utf8");
      for (const file of systemdDropIns(env, home, identity.name ?? SERVICE_NAME, dropInRoots)) text += "\n" + readFileSync(file, "utf8");
      return { config: parseSystemdConfig(text) };
    }
    if (platform === "darwin") {
      return { config: parseLaunchdConfig(readFileSync(launchdPlistPath(home, identity.label ?? LAUNCHD_LABEL), "utf8")) };
    }
  } catch {
    // Not installed.
  }
  return undefined;
}

/** Where a service's definition file lives (the unit, the plist); undefined where there is none (Windows keeps it in Task Scheduler). */
export function serviceDefinitionPath(
  platform: Platform,
  identity: { name?: string; label?: string } = {},
  home = homedir(),
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (platform === "linux") return systemdUnitPath(env, home, identity.name ?? SERVICE_NAME);
  if (platform === "darwin") return launchdPlistPath(home, identity.label ?? LAUNCHD_LABEL);
  return undefined;
}

/** The configuration an installed service runs, as its definition says; undefined when none is installed or it does not say. */
export function definedServiceConfig(
  platform: Platform,
  identity: { name?: string; label?: string } = {},
  home = homedir(),
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return readServiceDefinition(platform, identity, home, env)?.config;
}

export function renderSystemdUnit(spec: ServiceSpec): string {
  const envLine = (k: string, v: string) => "Environment=" + systemdEnvQuote(k + "=" + v);
  return [
    "# Installed by 'prime service install'. Remove with 'prime service uninstall'.",
    "[Unit]",
    "Description=" + (spec.description ?? "code-mcp (Prime gateway device buddy)"),
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "ExecStart=" + spec.command.map(systemdQuote).join(" "),
    // A bare path: WorkingDirectory= does not take quotes (only % is special).
    "WorkingDirectory=" + spec.home.replace(/%/g, "%%"),
    envLine("PATH", spec.pathEnv),
    "Restart=" + (spec.restart ?? "on-failure"),
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function renderLaunchdPlist(spec: ServiceSpec): string {
  const s = (v: string) => "<string>" + xmlEscape(v) + "</string>";
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    "<!-- Installed by 'prime service install'. Remove with 'prime service uninstall'. -->",
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>" + s(spec.label ?? LAUNCHD_LABEL),
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...spec.command.map((a) => "    " + s(a)),
    "  </array>",
    "  <key>WorkingDirectory</key>" + s(spec.home),
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>PATH</key>" + s(spec.pathEnv),
    "  </dict>",
    "  <key>RunAtLoad</key><true/>",
    spec.keepAlive
      ? "  <!-- Back after any exit: an agent that stops is a fleet with no primary. -->\n  <key>KeepAlive</key><true/>"
      : "  <!-- Restart after a crash, not after a clean stop. -->\n  <key>KeepAlive</key>\n  <dict><key>SuccessfulExit</key><false/></dict>",
    "  <key>ThrottleInterval</key><integer>10</integer>",
    "  <key>StandardOutPath</key>" + s(spec.logPath),
    "  <key>StandardErrorPath</key>" + s(spec.logPath),
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** One argument for a Windows command line (CommandLineToArgvW rules). */
export function windowsQuote(arg: string): string {
  if (arg.length > 0 && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      slashes++;
      continue;
    }
    if (ch === '"') {
      out += "\\".repeat(slashes * 2 + 1) + '"';
    } else {
      out += "\\".repeat(slashes) + ch;
    }
    slashes = 0;
  }
  return out + "\\".repeat(slashes * 2) + '"';
}

/** A PowerShell single-quoted literal. */
export function psQuote(text: string): string {
  return "'" + text.replace(/'/g, "''") + "'";
}

/**
 * The Scheduled Task a service is registered as: `\prime\<name>`. The buddy is "code-mcp" and the fleet agent
 * "prime-fleet-agent", so installing one never replaces, stops or removes the other's task.
 */
export function taskNameOf(identity: { name?: string } = {}): string {
  return identity.name ?? TASK_NAME;
}

function taskRef(identity: { name?: string }): string {
  return "-TaskPath " + psQuote(TASK_PATH) + " -TaskName " + psQuote(taskNameOf(identity));
}

// What a service's process has on its command line: how the Windows script tells it from the other's.
function processMarker(identity: { name?: string }): string {
  return taskNameOf(identity) === TASK_NAME ? "code-mcp --service" : "__fleet-agent";
}

/**
 * An earlier build registered the fleet agent as the buddy's own task, `\prime\code-mcp`. Whether that
 * task is the agent's is told by what it runs: `__fleet-agent` and not `code-mcp --service`. The buddy's
 * task is never touched.
 */
export function isFleetAgentAction(argument: string): boolean {
  return argument.includes("__fleet-agent") && !argument.includes("code-mcp --service");
}

/** What the old task `\prime\code-mcp` is, read-only: its action's arguments and whether it is running. */
function renderWindowsOldTaskProbeScript(): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$task = Get-ScheduledTask -TaskPath " + psQuote(TASK_PATH) + " -TaskName " + psQuote(TASK_NAME),
    "if ($task) { 'task ' + $task.State; $task.Actions | ForEach-Object { 'arguments ' + $_.Arguments } }",
  ].join("\n");
}

/**
 * Remove the old task when it is the fleet agent's, and the agent process of this configuration. It
 * looks again inside the script, so that a task replaced by the buddy's between the look and this is
 * left alone.
 */
export function renderWindowsRetireOldAgentScript(configPath: string): string {
  const ref = "-TaskPath " + psQuote(TASK_PATH) + " -TaskName " + psQuote(TASK_NAME);
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$task = Get-ScheduledTask " + ref,
    "$arguments = if ($task) { ($task.Actions | ForEach-Object { $_.Arguments }) -join ' ' } else { '' }",
    "if ($task -and $arguments.Contains('__fleet-agent') -and -not $arguments.Contains('code-mcp --service')) {",
    "  Stop-ScheduledTask " + ref,
    "  Unregister-ScheduledTask " + ref + " -Confirm:$false",
    "  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('__fleet-agent') -and $_.CommandLine.Contains(" + psQuote(configPath) + ") } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
    "  'removed'",
    "} else { 'absent' }",
  ].join("\n");
}

/** How the Windows scripts are run; replaced in tests. */
export interface Shell {
  run(cmd: string[], opts?: { timeoutMs?: number }): RunResult;
  powershell(script: string): RunResult;
}

const realShell: Shell = { run: (cmd, opts) => run(cmd, opts), powershell: (script) => powershell(script) };

/** The configuration an old agent task's command line names (`--config <path>`, quoted or not). */
export function configOfTaskArguments(argument: string): string | undefined {
  const found = /--config\s+(?:"((?:[^"\\]|\\.)*)"|(\S+))/.exec(argument);
  if (!found) return undefined;
  return found[1] !== undefined ? found[1].replace(/\\"/g, '"') : found[2];
}

/**
 * The old `\prime\code-mcp` task when it is a fleet agent's, with the configuration it runs (undefined when
 * its command line does not say, which the agent's always did). There is one such task per machine.
 */
function oldAgentTask(shell: Shell): { running: boolean; config: string | undefined } | undefined {
  if (shell.run(["schtasks", "/query", "/tn", TASK_PATH + TASK_NAME], { timeoutMs: 30_000 }).code !== 0) return undefined;
  const lines = shell.powershell(renderWindowsOldTaskProbeScript()).out.split(/\r?\n/).map((line) => line.trim());
  const state = lines.find((line) => line.startsWith("task "));
  if (!state) return undefined;
  const argument = lines.filter((line) => line.startsWith("arguments ")).join(" ");
  if (!isFleetAgentAction(argument)) return undefined;
  return { running: state === "task Running", config: configOfTaskArguments(argument) };
}

/** Whether an old agent task runs this configuration. One that does not say is not taken for it. */
function oldTaskIsFor(old: { config: string | undefined }, configPath: string): boolean {
  return old.config !== undefined && samePath(old.config, configPath);
}

/**
 * Register the Scheduled Task. It runs under conhost --headless so the console
 * program gets no window, for the logged-on user only (no admin rights needed),
 * starts at logon, never times out, and restarts after a failure.
 */
export function renderWindowsInstallScript(spec: ServiceSpec): string {
  const TASK_REF = taskRef(spec);
  const argument = "--headless " + spec.command.map(windowsQuote).join(" ");
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
    "$conhost = Join-Path $env:SystemRoot 'System32\\conhost.exe'",
    "$action = New-ScheduledTaskAction -Execute $conhost -Argument " + psQuote(argument) + " -WorkingDirectory " + psQuote(spec.home),
    "$atLogOn = New-ScheduledTaskTrigger -AtLogOn -User $user",
    // Task Scheduler's restart-on-failure covers a task that fails to START,
    // not one whose process dies later. A one-minute repetition (with
    // IgnoreNew) brings a crashed service back without ever running two.
    "$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(5) -RepetitionInterval (New-TimeSpan -Minutes 1)",
    "$trigger = @($atLogOn, $watchdog)",
    "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable " +
      "-ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew",
    "$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited",
    "Register-ScheduledTask " + TASK_REF + " -Action $action -Trigger $trigger -Settings $settings -Principal $principal " +
      "-Description " + psQuote(spec.description ?? "code-mcp (installed by prime service install)") + " -Force | Out-Null",
    "Start-ScheduledTask " + TASK_REF,
  ].join("\n");
}

export function renderWindowsUninstallScript(configPath: string, identity: { name?: string } = {}): string {
  const TASK_REF = taskRef(identity);
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$task = Get-ScheduledTask " + TASK_REF,
    "if ($task) { Stop-ScheduledTask " + TASK_REF + "; Unregister-ScheduledTask " + TASK_REF + " -Confirm:$false }",
    // Belt and braces: the service's own process (it also exits on its own when
    // its conhost parent goes away).
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains(" + psQuote(processMarker(identity)) + ") -and $_.CommandLine.Contains(" +
      psQuote(configPath) + ") } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
    "if ($task) { 'removed' } else { 'absent' }",
  ].join("\n");
}

/**
 * The running service writes its pid here (removed on a clean exit). On Windows
 * it is how "running" is decided: Task Scheduler's own state is slow to query
 * through PowerShell and localized through schtasks.
 */
export function pidFilePath(configPath: string): string {
  return join(dirname(configPath), "code-mcp.service.pid");
}

function pidAlive(path: string): boolean {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ---- running commands --------------------------------------------------------

interface RunResult {
  code: number;
  out: string;
  err: string;
}

function run(cmd: string[], opts: { timeoutMs?: number } = {}): RunResult {
  const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: opts.timeoutMs ?? 60_000 });
  return { code: result.exitCode ?? 1, out: result.stdout.toString(), err: result.stderr.toString() };
}

function powershell(script: string): RunResult {
  const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return run([ps, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { timeoutMs: 120_000 });
}

function must(result: RunResult, what: string, hint?: string): RunResult {
  if (result.code !== 0) {
    throw new CliError(what + " failed (exit " + result.code + ")" + (result.err.trim() ? ": " + result.err.trim().slice(0, 400) : ""), hint);
  }
  return result;
}

/**
 * Whether `launchctl print` of a service reached the manager of the user's session. A service that
 * is not loaded (stopped on purpose with `bootout`) is answered with "Could not find service" - the
 * manager is there and says it is not running it - while a session with no manager to ask is not.
 */
export function launchdAnswered(printed: { code: number; out: string; err: string }): boolean {
  return printed.code === 0 || /Could not find service/i.test(printed.out + "\n" + printed.err);
}

function uid(): number {
  return typeof process.getuid === "function" ? process.getuid() : userInfo().uid;
}

// ---- status / install / uninstall per platform -------------------------------

export function serviceStatus(
  platform: Platform = process.platform as Platform,
  configPath: string = defaultConfigPath(),
  identity: { name?: string; label?: string } = {},
  shell: Shell = realShell,
): ServiceStatus {
  const name = identity.name ?? SERVICE_NAME;
  const label = identity.label ?? LAUNCHD_LABEL;
  if (platform === "linux") {
    const where = systemdUnitPath(process.env, homedir(), name);
    if (!Bun.which("systemctl")) return { installed: existsSync(where), running: false, where, detail: "systemctl not found", reachable: false };
    const active = run(["systemctl", "--user", "is-active", name + ".service"]).out.trim();
    // `show -p` prints MainPID=123 on every systemd; `--value` only exists from 230. It exits 0 for
    // any unit it can look up, and non-zero when the user manager cannot be reached.
    const shown = run(["systemctl", "--user", "show", "-p", "MainPID", name + ".service"]);
    const main = Number.parseInt(/MainPID=(\d+)/.exec(shown.out)?.[1] ?? "", 10);
    return {
      installed: existsSync(where),
      running: active === "active",
      where,
      detail: active || undefined,
      reachable: shown.code === 0,
      ...(main > 0 ? { pid: main } : {}),
    };
  }
  if (platform === "darwin") {
    const where = launchdPlistPath(homedir(), label);
    const printed = run(["launchctl", "print", "gui/" + uid() + "/" + label]);
    const state = /^\s*state = (\S+)/m.exec(printed.out)?.[1];
    const pid = Number.parseInt(/^\s*pid = (\d+)/m.exec(printed.out)?.[1] ?? "", 10);
    return {
      installed: existsSync(where),
      running: printed.code === 0 && state === "running",
      where,
      detail: printed.code === 0 ? state : "not loaded",
      // Not loaded into the user's session (or no session to load it into): nothing runs it.
      reachable: launchdAnswered(printed),
      ...(pid > 0 ? { pid } : {}),
    };
  }
  if (platform === "win32") {
    const task = taskNameOf(identity);
    const where = "Task Scheduler " + TASK_PATH + task;
    // schtasks answers in well under a second, and its exit code is not localized.
    const installed = shell.run(["schtasks", "/query", "/tn", TASK_PATH + task], { timeoutMs: 30_000 }).code === 0;
    if (!installed && task !== TASK_NAME) {
      // A machine whose agent was installed by an earlier build has it under the buddy's task name.
      const old = oldAgentTask(shell);
      if (old && oldTaskIsFor(old, configPath)) {
        return {
          installed: true,
          running: old.running,
          where: "Task Scheduler " + TASK_PATH + TASK_NAME,
          detail: (old.running ? "running" : "not running") + ", registered under the name of the buddy's task by an earlier build: install it again to move it",
        };
      }
      if (old) {
        // Another configuration's agent: not this one's to report as its own, nor to remove.
        return {
          installed: false,
          running: false,
          where,
          detail: "an agent of " + (old.config ?? "an unknown configuration") + " is registered under the buddy's task name (" + TASK_PATH + TASK_NAME + ") by an earlier build; run 'prime fleets agent install' with that --config to move it",
        };
      }
    }
    // The buddy writes its pid down; the fleet agent has its own lock and state, and Task Scheduler is asked.
    const running =
      installed &&
      (task === TASK_NAME
        ? pidAlive(pidFilePath(configPath))
        : shell.powershell("(Get-ScheduledTask " + taskRef(identity) + ").State -eq 'Running'").out.trim() === "True");
    return { installed, running, where, detail: installed ? (running ? "running" : "not running") : undefined };
  }
  throw new CliError("'prime service' supports Linux (systemd), macOS (launchd) and Windows (Task Scheduler); this is " + platform);
}

/**
 * Restart an installed service through its manager, so that the manager (which restarts
 * what dies) and the person are never fighting over the process. Returns whether the
 * manager took the request; Windows has no equivalent and says no.
 */
export function restartService(
  platform: Platform = process.platform as Platform,
  identity: { name?: string; label?: string } = {},
): boolean {
  if (platform === "linux") {
    if (!Bun.which("systemctl")) return false;
    return run(["systemctl", "--user", "restart", (identity.name ?? SERVICE_NAME) + ".service"]).code === 0;
  }
  if (platform === "darwin") {
    const label = identity.label ?? LAUNCHD_LABEL;
    // -k: kill the running instance first; it is started again at once.
    if (run(["launchctl", "kickstart", "-k", "gui/" + uid() + "/" + label]).code === 0) return true;
    // A service that was stopped (see `stopService`) is not loaded: load it again, which starts it.
    const plist = launchdPlistPath(homedir(), label);
    return existsSync(plist) && run(["launchctl", "bootstrap", "gui/" + uid(), plist]).code === 0;
  }
  return false;
}

/**
 * Stop an installed service through its manager, so that the manager (which restarts what dies)
 * does not start it again behind the person's back. The service stays installed and stays stopped:
 * `restartService` starts it now, and it starts of itself when its manager does (the next login on
 * macOS, the next start of the user's manager on Linux). Returns whether the manager did; Windows has no
 * equivalent that its watchdog would not undo, and says no.
 */
export function stopService(
  platform: Platform = process.platform as Platform,
  identity: { name?: string; label?: string } = {},
): boolean {
  if (platform === "linux") {
    if (!Bun.which("systemctl")) return false;
    return run(["systemctl", "--user", "stop", (identity.name ?? SERVICE_NAME) + ".service"]).code === 0;
  }
  if (platform === "darwin") {
    // Not `stop` or `kill`: a KeepAlive job is started again at once. Unloading it is what stops it.
    return run(["launchctl", "bootout", "gui/" + uid() + "/" + (identity.label ?? LAUNCHD_LABEL)]).code === 0;
  }
  return false;
}

/** The spec for this machine: the running prime, its config, the current PATH. */
export function serviceSpecFor(platform: Platform, configPath: string): ServiceSpec {
  const logPath = defaultLogPath(platform, configPath);
  const command = [...selfCommand(), "code-mcp", "--service", "--config", configPath];
  // Windows has no service-manager log capture for a task: the host writes it.
  if (platform === "win32") command.push("--log", logPath);
  return { command, configPath, logPath, pathEnv: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", home: homedir() };
}

export function installService(platform: Platform, spec: ServiceSpec, shell: Shell = realShell): string {
  if (platform === "linux") {
    if (!Bun.which("systemctl")) throw new CliError("systemctl not found: 'prime service' needs systemd on Linux");
    const unit = systemdUnitPath(process.env, homedir(), spec.name ?? SERVICE_NAME);
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, renderSystemdUnit(spec), { mode: 0o644 });
    const unitName = (spec.name ?? SERVICE_NAME) + ".service";
    const hint = "Is a systemd user session running? (systemctl --user status). Over SSH: loginctl enable-linger $USER, then log in again.";
    must(run(["systemctl", "--user", "daemon-reload"]), "systemctl --user daemon-reload", hint);
    must(run(["systemctl", "--user", "enable", unitName]), "systemctl --user enable", hint);
    // restart, not start: a reinstall must pick up the new definition.
    must(run(["systemctl", "--user", "restart", unitName]), "systemctl --user restart", hint);
    return unit;
  }
  if (platform === "darwin") {
    const label = spec.label ?? LAUNCHD_LABEL;
    const plist = launchdPlistPath(homedir(), label);
    const target = "gui/" + uid();
    run(["launchctl", "bootout", target + "/" + label]); // a reinstall replaces the old one
    mkdirSync(dirname(plist), { recursive: true });
    mkdirSync(dirname(spec.logPath), { recursive: true });
    writeFileSync(plist, renderLaunchdPlist(spec), { mode: 0o644 });
    // bootstrap can race the bootout above ("Input/output error"): retry briefly.
    let result = run(["launchctl", "bootstrap", target, plist]);
    for (let i = 0; i < 10 && result.code !== 0; i++) {
      Bun.sleepSync(300);
      result = run(["launchctl", "bootstrap", target, plist]);
    }
    must(result, "launchctl bootstrap " + target);
    return plist;
  }
  if (platform === "win32") {
    mkdirSync(dirname(spec.logPath), { recursive: true });
    // A reinstall must stop the running instance: re-registering only replaces
    // the definition, and with IgnoreNew the new start is skipped while the old
    // process (with the old options) keeps running.
    shell.powershell(renderWindowsUninstallScript(spec.configPath, spec));
    // The agent an earlier build registered under the buddy's task name is moved, not left to race the new one.
    if (taskNameOf(spec) !== TASK_NAME) retireOldAgentTask(spec.configPath, shell);
    if (taskNameOf(spec) === TASK_NAME) for (let i = 0; i < 40 && pidAlive(pidFilePath(spec.configPath)); i++) Bun.sleepSync(250);
    must(shell.powershell(renderWindowsInstallScript(spec)), "registering the Scheduled Task");
    return "Task Scheduler " + TASK_PATH + taskNameOf(spec);
  }
  throw new CliError("'prime service' is not supported on " + platform);
}

/** Remove the old `\prime\code-mcp` task when it is the fleet agent's. Returns whether it was. */
function retireOldAgentTask(configPath: string, shell: Shell): boolean {
  const old = oldAgentTask(shell);
  if (!old || !oldTaskIsFor(old, configPath)) return false;
  return shell.powershell(renderWindowsRetireOldAgentScript(configPath)).out.trim() === "removed";
}

/** Stop and remove. Returns what was there (false: nothing was installed). */
export function uninstallService(
  platform: Platform,
  configPath: string,
  identity: { name?: string; label?: string } = {},
  shell: Shell = realShell,
): boolean {
  const name = identity.name ?? SERVICE_NAME;
  const label = identity.label ?? LAUNCHD_LABEL;
  if (platform === "linux") {
    const unit = systemdUnitPath(process.env, homedir(), name);
    const had = existsSync(unit);
    if (Bun.which("systemctl")) {
      run(["systemctl", "--user", "disable", "--now", name + ".service"]);
      rmSync(unit, { force: true });
      run(["systemctl", "--user", "daemon-reload"]);
      run(["systemctl", "--user", "reset-failed", name + ".service"]);
    } else {
      rmSync(unit, { force: true });
    }
    return had;
  }
  if (platform === "darwin") {
    const plist = launchdPlistPath(homedir(), label);
    const had = existsSync(plist);
    const out = run(["launchctl", "bootout", "gui/" + uid() + "/" + label]);
    rmSync(plist, { force: true });
    return had || out.code === 0;
  }
  if (platform === "win32") {
    const removed = shell.powershell(renderWindowsUninstallScript(configPath, identity)).out.trim() === "removed";
    if (taskNameOf(identity) === TASK_NAME) return removed;
    return retireOldAgentTask(configPath, shell) || removed;
  }
  throw new CliError("'prime service' is not supported on " + platform);
}
