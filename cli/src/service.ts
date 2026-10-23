// 'prime service install|uninstall|status' - run the bundled code-mcp as a user
// service that starts with the session and restarts on failure:
//
//   Linux    systemd user unit   ~/.config/systemd/user/code-mcp.service
//   macOS    launchd agent       ~/Library/LaunchAgents/dev.prime-gateway.code-mcp.plist
//   Windows  Scheduled Task      \prime-gateway\code-mcp (at logon, no admin needed)
//
// The service runs "prime code-mcp --service --config <path>": options are read at
// every start from the config's "code-mcp:" section plus the overrides given to
// 'service install' (kept in service.yaml beside the config, 0600). So no
// credential is ever written into the service definition or onto a command
// line where ps would show it.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { selfCommand } from "./code-mcp-host.ts";
import { type OptionMap, optionsFromConfig } from "./code-mcp-options.ts";
import { defaultConfigPath, yamlScalar } from "./config.ts";
import { CliError } from "./errors.ts";

export type Platform = "linux" | "darwin" | "win32";

export const SERVICE_NAME = "code-mcp";
export const LAUNCHD_LABEL = "dev.prime-gateway.code-mcp";
export const TASK_PATH = "\\prime-gateway\\";
export const TASK_NAME = "code-mcp";
/** Before the rename the agent/task was installed under these names. */
export const LEGACY_LAUNCHD_LABEL = "dev.code-mcp-gateway.code-mcp";
export const LEGACY_TASK_PATH = "\\code-mcp-gateway\\";

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  /** Where the definition lives (file, or the task's full name). */
  where: string;
  detail?: string;
}

export interface ServiceSpec {
  /** argv of the service process: the mcp binary (or bun + script) + code-mcp --service ... */
  command: string[];
  configPath: string;
  logPath: string;
  /** PATH captured at install: services otherwise get a minimal one, and code-mcp runs the user's commands. */
  pathEnv: string;
  home: string;
}

// ---- paths -------------------------------------------------------------------

export function overridesPath(configPath: string): string {
  return join(dirname(configPath), "service.yaml");
}

export function systemdUnitPath(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() ? env.XDG_CONFIG_HOME : join(home, ".config");
  return join(base, "systemd", "user", SERVICE_NAME + ".service");
}

export function launchdPlistPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", LAUNCHD_LABEL + ".plist");
}

export function defaultLogPath(platform: Platform, configPath: string, home = homedir()): string {
  if (platform === "darwin") return join(home, "Library", "Logs", "prime-gateway", "code-mcp.log");
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

export function renderSystemdUnit(spec: ServiceSpec): string {
  const envLine = (k: string, v: string) => "Environment=" + systemdEnvQuote(k + "=" + v);
  return [
    "# Installed by 'prime service install'. Remove with 'prime service uninstall'.",
    "[Unit]",
    "Description=code-mcp (Prime gateway device server)",
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "ExecStart=" + spec.command.map(systemdQuote).join(" "),
    // A bare path: WorkingDirectory= does not take quotes (only % is special).
    "WorkingDirectory=" + spec.home.replace(/%/g, "%%"),
    envLine("PATH", spec.pathEnv),
    "Restart=on-failure",
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
    "  <key>Label</key>" + s(LAUNCHD_LABEL),
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
    "  <!-- Restart after a crash, not after a clean stop. -->",
    "  <key>KeepAlive</key>",
    "  <dict><key>SuccessfulExit</key><false/></dict>",
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

const TASK_REF = "-TaskPath " + psQuote(TASK_PATH) + " -TaskName " + psQuote(TASK_NAME);

/**
 * Register the Scheduled Task. It runs under conhost --headless so the console
 * program gets no window, for the logged-on user only (no admin rights needed),
 * starts at logon, never times out, and restarts after a failure.
 */
export function renderWindowsInstallScript(spec: ServiceSpec): string {
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
      "-Description 'code-mcp (installed by prime service install)' -Force | Out-Null",
    "Start-ScheduledTask " + TASK_REF,
  ].join("\n");
}

export function renderWindowsUninstallScript(configPath: string): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$task = Get-ScheduledTask " + TASK_REF,
    "if ($task) { Stop-ScheduledTask " + TASK_REF + "; Unregister-ScheduledTask " + TASK_REF + " -Confirm:$false }",
    // Belt and braces: the service's own process (it also exits on its own when
    // its conhost parent goes away).
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('code-mcp --service') -and $_.CommandLine.Contains(" +
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

function uid(): number {
  return typeof process.getuid === "function" ? process.getuid() : userInfo().uid;
}

// ---- status / install / uninstall per platform -------------------------------

export function serviceStatus(platform: Platform = process.platform as Platform, configPath: string = defaultConfigPath()): ServiceStatus {
  if (platform === "linux") {
    const where = systemdUnitPath();
    if (!Bun.which("systemctl")) return { installed: existsSync(where), running: false, where, detail: "systemctl not found" };
    const active = run(["systemctl", "--user", "is-active", SERVICE_NAME + ".service"]).out.trim();
    return { installed: existsSync(where), running: active === "active", where, detail: active || undefined };
  }
  if (platform === "darwin") {
    const where = launchdPlistPath();
    const printed = run(["launchctl", "print", "gui/" + uid() + "/" + LAUNCHD_LABEL]);
    const state = /^\s*state = (\S+)/m.exec(printed.out)?.[1];
    return { installed: existsSync(where), running: printed.code === 0 && state === "running", where, detail: printed.code === 0 ? state : "not loaded" };
  }
  if (platform === "win32") {
    const where = "Task Scheduler " + TASK_PATH + TASK_NAME;
    // schtasks answers in well under a second, and its exit code is not localized.
    const installed = run(["schtasks", "/query", "/tn", TASK_PATH + TASK_NAME], { timeoutMs: 30_000 }).code === 0;
    const running = installed && pidAlive(pidFilePath(configPath));
    return { installed, running, where, detail: installed ? (running ? "running" : "not running") : undefined };
  }
  throw new CliError("'prime service' supports Linux (systemd), macOS (launchd) and Windows (Task Scheduler); this is " + platform);
}

/** The spec for this machine: the running prime, its config, the current PATH. */
export function serviceSpecFor(platform: Platform, configPath: string): ServiceSpec {
  const logPath = defaultLogPath(platform, configPath);
  const command = [...selfCommand(), "code-mcp", "--service", "--config", configPath];
  // Windows has no service-manager log capture for a task: the host writes it.
  if (platform === "win32") command.push("--log", logPath);
  return { command, configPath, logPath, pathEnv: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", home: homedir() };
}

/** Remove a service installed by the pre-rename CLI, so an upgrade leaves one. */
export function removeLegacyService(platform: Platform): void {
  if (platform === "darwin") {
    run(["launchctl", "bootout", "gui/" + uid() + "/" + LEGACY_LAUNCHD_LABEL]);
    rmSync(join(homedir(), "Library", "LaunchAgents", LEGACY_LAUNCHD_LABEL + ".plist"), { force: true });
    return;
  }
  if (platform === "win32") {
    run(["schtasks", "/Delete", "/TN", LEGACY_TASK_PATH + SERVICE_NAME, "/F"]);
  }
}

export function installService(platform: Platform, spec: ServiceSpec): string {
  removeLegacyService(platform);
  if (platform === "linux") {
    if (!Bun.which("systemctl")) throw new CliError("systemctl not found: 'prime service' needs systemd on Linux");
    const unit = systemdUnitPath();
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, renderSystemdUnit(spec), { mode: 0o644 });
    const hint = "Is a systemd user session running? (systemctl --user status). Over SSH: loginctl enable-linger $USER, then log in again.";
    must(run(["systemctl", "--user", "daemon-reload"]), "systemctl --user daemon-reload", hint);
    must(run(["systemctl", "--user", "enable", SERVICE_NAME + ".service"]), "systemctl --user enable", hint);
    // restart, not start: a reinstall must pick up the new definition.
    must(run(["systemctl", "--user", "restart", SERVICE_NAME + ".service"]), "systemctl --user restart", hint);
    return unit;
  }
  if (platform === "darwin") {
    const plist = launchdPlistPath();
    const target = "gui/" + uid();
    run(["launchctl", "bootout", target + "/" + LAUNCHD_LABEL]); // a reinstall replaces the old one
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
    powershell(renderWindowsUninstallScript(spec.configPath));
    for (let i = 0; i < 40 && pidAlive(pidFilePath(spec.configPath)); i++) Bun.sleepSync(250);
    must(powershell(renderWindowsInstallScript(spec)), "registering the Scheduled Task");
    return "Task Scheduler " + TASK_PATH + TASK_NAME;
  }
  throw new CliError("'prime service' is not supported on " + platform);
}

/** Stop and remove. Returns what was there (false: nothing was installed). */
export function uninstallService(platform: Platform, configPath: string): boolean {
  removeLegacyService(platform);
  if (platform === "linux") {
    const unit = systemdUnitPath();
    const had = existsSync(unit);
    if (Bun.which("systemctl")) {
      run(["systemctl", "--user", "disable", "--now", SERVICE_NAME + ".service"]);
      rmSync(unit, { force: true });
      run(["systemctl", "--user", "daemon-reload"]);
      run(["systemctl", "--user", "reset-failed", SERVICE_NAME + ".service"]);
    } else {
      rmSync(unit, { force: true });
    }
    return had;
  }
  if (platform === "darwin") {
    const plist = launchdPlistPath();
    const had = existsSync(plist);
    const out = run(["launchctl", "bootout", "gui/" + uid() + "/" + LAUNCHD_LABEL]);
    rmSync(plist, { force: true });
    return had || out.code === 0;
  }
  if (platform === "win32") {
    return powershell(renderWindowsUninstallScript(configPath)).out.trim() === "removed";
  }
  throw new CliError("'prime service' is not supported on " + platform);
}
