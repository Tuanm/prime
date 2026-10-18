#!/usr/bin/env bun
// End-to-end test of 'mcp service' against the REAL service manager of this OS
// (systemd user units / launchd / Task Scheduler), with the compiled binary.
//
//   bun test/service-e2e.ts            (refuses if a code-mcp service is already installed)
//
// Everything runs against an isolated config (CODE_MCP_GATEWAY_CONFIG), and the
// service is always uninstalled at the end.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchdPlistPath, systemdUnitPath } from "../src/service.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const IS_WINDOWS = process.platform === "win32";
const BIN = process.env.MCP_BIN || join(ROOT, "dist", "mcp-service-e2e" + (IS_WINDOWS ? ".exe" : ""));
const SECRET = "svc-" + crypto.randomUUID().replace(/-/g, "");
const BASE_PORT = 17000 + Math.floor(Math.random() * 2000);
const CONFIG_PORT = String(BASE_PORT);
const OVERRIDE_PORT = String(BASE_PORT + 1);

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, cond: unknown, detail = "") {
  if (cond) {
    pass++;
    console.log("PASS " + name);
  } else {
    fail++;
    failures.push(name + (detail ? ": " + detail : ""));
    console.log("FAIL " + name + (detail ? ": " + detail : ""));
  }
}

const dir = mkdtempSync(join(tmpdir(), "mcp-service-e2e-"));
const CONFIG = join(dir, "config.yaml");
const ENV = { ...process.env, CODE_MCP_GATEWAY_CONFIG: CONFIG, NO_COLOR: "1" };

async function mcp(args: string[], timeoutMs = 120_000) {
  const proc = Bun.spawn([BIN, ...args], { env: ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, out, err };
}

/** tools/list against a local code-mcp; undefined when nothing answers. */
async function listTools(port: string, token = SECRET): Promise<string[] | undefined> {
  try {
    const r = await fetch("http://127.0.0.1:" + port + "/mcp?token=" + token, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      signal: AbortSignal.timeout(3000),
    });
    if (r.status !== 200) return undefined;
    const j = (await r.json()) as { result?: { tools?: { name: string }[] } };
    return (j.result?.tools ?? []).map((t) => t.name);
  } catch {
    return undefined;
  }
}

async function waitFor<T>(probe: () => Promise<T | undefined>, ms: number): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await probe();
    if (v !== undefined) return v;
    await Bun.sleep(500);
  }
  return undefined;
}

async function closed(port: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await listTools(port)) === undefined) return true;
    await Bun.sleep(500);
  }
  return false;
}

function processLines(): string[] {
  const out = IS_WINDOWS
    ? Bun.spawnSync(["powershell", "-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { [string]$_.ProcessId + ' ' + $_.CommandLine }"], { stdout: "pipe" })
    : Bun.spawnSync(["ps", "-axww", "-o", "pid=,args="], { stdout: "pipe" });
  return out.stdout.toString().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** The service's own code-mcp process (identified by the isolated config path). */
function servicePids(): number[] {
  return processLines()
    .filter((l) => l.includes("code-mcp --service") && l.includes(CONFIG) && !l.includes("conhost"))
    .map((l) => Number(l.split(/\s+/)[0]))
    .filter((n) => n > 0);
}

function definitionText(): string {
  if (process.platform === "linux") return existsSync(systemdUnitPath()) ? readFileSync(systemdUnitPath(), "utf8") : "";
  if (process.platform === "darwin") return existsSync(launchdPlistPath()) ? readFileSync(launchdPlistPath(), "utf8") : "";
  const r = Bun.spawnSync(["powershell", "-NoProfile", "-Command", "Export-ScheduledTask -TaskPath '\\code-mcp-gateway\\' -TaskName 'code-mcp' -ErrorAction SilentlyContinue"], { stdout: "pipe" });
  return r.stdout.toString();
}

if (!process.env.MCP_BIN) {
  console.log("Building the binary...");
  const build = Bun.spawnSync(["bun", "build", "--compile", "--minify", "--bytecode", "--format=esm", "--outfile", BIN, join(ROOT, "src", "index.ts")], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (build.exitCode !== 0) {
    console.error(build.stderr.toString());
    process.exit(1);
  }
}

const before = await mcp(["service", "status", "--json"]);
if (JSON.parse(before.out || "{}").installed === true) {
  console.error("A code-mcp service is already installed on this machine; refusing to touch it. Run this test where none is installed.");
  process.exit(1);
}

writeFileSync(CONFIG, [
  "devices: {}",
  "",
  "code-mcp:",
  '  port: "' + CONFIG_PORT + '"',
  '  bind: "127.0.0.1"',
  '  token: "' + SECRET + '"',
  "  enable-memory: true",
  "",
].join("\n"));

try {
  // ---- install: config options + a command-line override ----
  const install = await mcp(["service", "install", "--port", OVERRIDE_PORT]);
  check("service install succeeds", install.code === 0, "code=" + install.code + " out=" + install.out.slice(0, 300) + " err=" + install.err.slice(0, 600));
  const tools = await waitFor(() => listTools(OVERRIDE_PORT), 30_000);
  check("the service answers on the overriding port", Array.isArray(tools) && tools.includes("read"), JSON.stringify(tools));
  check("...with the config's other options (enable-memory -> remember tool)", Array.isArray(tools) && tools.includes("remember"), JSON.stringify(tools));
  check("...and the config's token is enforced", (await listTools(OVERRIDE_PORT, "wrong-token")) === undefined);
  check("the config's own port is not used (the override wins)", (await listTools(CONFIG_PORT)) === undefined);
  check("install output masks the token", !install.out.includes(SECRET) && install.out.includes("--token ***"), install.out.slice(0, 300));

  // ---- no credential in the definition or on any command line ----
  const definition = definitionText();
  check("a service definition exists", definition.length > 0);
  check("the definition holds no credential", definition.length > 0 && !definition.includes(SECRET));
  check("no process command line holds the credential", !processLines().some((l) => l.includes(SECRET)));
  const overrides = join(dir, "service.yaml");
  check("the overrides are saved beside the config", existsSync(overrides) && readFileSync(overrides, "utf8").includes(OVERRIDE_PORT));
  check("...privately (0600)", IS_WINDOWS || (statSync(overrides).mode & 0o777) === 0o600, (statSync(overrides).mode & 0o777).toString(8));

  // ---- status, and the foreground command refuses to compete ----
  const status = await mcp(["service", "status", "--json"]);
  const statusJson = JSON.parse(status.out || "{}");
  check("service status reports running", statusJson.installed === true && statusJson.running === true, status.out);
  const refused = await mcp(["code-mcp"], 20_000);
  check("'mcp code-mcp' refuses while the service runs", refused.code === 2 && refused.err.includes("service is running"), "code=" + refused.code + " err=" + refused.err.slice(0, 300));

  // ---- a crash is restarted ----
  const pids = servicePids();
  check("the service process is identifiable", pids.length > 0, processLines().filter((l) => l.includes("code-mcp")).join(" | ").slice(0, 400));
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  const down = await closed(OVERRIDE_PORT, 10_000);
  const back = await waitFor(() => listTools(OVERRIDE_PORT), 90_000);
  check("after being killed, the service is restarted", down && Array.isArray(back), "down=" + down + " back=" + JSON.stringify(back));
  check("...as a new process", servicePids().every((p) => !pids.includes(p)));

  // ---- reinstall without options: the old override is gone ----
  const reinstall = await mcp(["service", "install"]);
  check("reinstall succeeds", reinstall.code === 0, reinstall.err.slice(0, 400));
  const onConfigPort = await waitFor(() => listTools(CONFIG_PORT), 30_000);
  check("reinstalling without options goes back to the config's port", Array.isArray(onConfigPort));
  check("...and the old port is released", await closed(OVERRIDE_PORT, 10_000));

  // ---- uninstall ----
  const uninstall = await mcp(["service", "uninstall"]);
  check("service uninstall succeeds", uninstall.code === 0 && uninstall.out.includes("uninstalled"), "code=" + uninstall.code + " " + uninstall.out + uninstall.err);
  check("the service stops", await closed(CONFIG_PORT, 15_000));
  check("no service process is left", (await waitFor(async () => (servicePids().length === 0 ? true : undefined), 10_000)) === true, processLines().filter((l) => l.includes(CONFIG)).join(" | "));
  check("the definition is removed", definitionText().trim().length === 0);
  check("the overrides file is removed", !existsSync(overrides));
  const after = JSON.parse((await mcp(["service", "status", "--json"])).out || "{}");
  check("status reports not installed", after.installed === false && after.running === false, JSON.stringify(after));
  const again = await mcp(["service", "uninstall"]);
  check("uninstalling twice is harmless", again.code === 0 && again.out.includes("no code-mcp service"), again.out + again.err);

  // ---- with no service, 'mcp code-mcp' runs on the config's options ----
  const fg = Bun.spawn([BIN, "code-mcp"], { env: ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const fgTools = await waitFor(() => listTools(CONFIG_PORT), 30_000);
  check("'mcp code-mcp' uses the config's port, token and options", Array.isArray(fgTools) && fgTools.includes("remember"), JSON.stringify(fgTools));
  check("...without the credential on its command line", !processLines().some((l) => l.includes(SECRET)));
  fg.kill();
  await fg.exited;
  const override = Bun.spawn([BIN, "code-mcp", "--port", OVERRIDE_PORT], { env: ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  check("'mcp code-mcp --port' overrides the config", Array.isArray(await waitFor(() => listTools(OVERRIDE_PORT), 30_000)));
  override.kill();
  await override.exited;

  // ---- a bad config fails at install, before anything is installed ----
  writeFileSync(CONFIG, 'code-mcp:\n  prot: "1"\n');
  const typo = await mcp(["service", "install"]);
  check("a typo in the config fails the install with a clear error", typo.code === 2 && typo.err.includes('unknown code-mcp option "prot"'), typo.err.slice(0, 300));
  check("...and installs nothing", JSON.parse((await mcp(["service", "status", "--json"])).out || "{}").installed === false);
} catch (err) {
  fail++;
  failures.push("harness: " + ((err as Error).stack || err));
  console.log("FAIL harness: " + ((err as Error).stack || err));
} finally {
  await mcp(["service", "uninstall"]);
  rmSync(dir, { recursive: true, force: true });
  if (!process.env.MCP_BIN) rmSync(BIN, { force: true });
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (failures.length) console.log("Failures:\n  - " + failures.join("\n  - "));
process.exit(fail === 0 ? 0 : 1);
