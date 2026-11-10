// "prime spaces ..." - disposable or persistent Linux codespaces that run the
// bundled device buddy (no gateway) and register themselves as local devices.
//
// Every space is a rootless container: Apple's container CLI on macOS (one
// micro-VM per space, so root inside is not root on the host) or rootless podman
// on Linux. The MCP server binds inside the container; the host reaches it over
// the runtime's private network (Apple vmnet address) or a loopback publish
// (podman/docker). The space's token is the only credential and is generated per
// space.

import { bool, num, str, strList, type ParsedArgs } from "./args.ts";
import { saveConfig, type Config, type SpaceEntry } from "./config.ts";
import type { Ctx } from "./context.ts";
import { CliError, UsageError } from "./errors.ts";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bold, cyan, dim, green, printJson, red, table, yellow } from "./output.ts";
import { formatBytes } from "./files.ts";
import { connectUrlFor, probeCredential, registerAnonymous, type AnonymousDevice } from "./connect.ts";
import { fleetWorkDir, setupFleetSpace } from "./fleet-space.ts";
import { ensureFleetAgent } from "./fleet-daemon.ts";
import { ENV, resolveGateway } from "./target.ts";
import { allVaultCompanies, brokerScopeFor } from "./vaults.ts";
import { type BrokerScope, ensureBroker, registerBrokerScope, unregisterBrokerScope } from "./vault-broker.ts";

const SPACE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONTAINER_PORT = 7777;
const READY_TIMEOUT_MS = 90_000;

export type RuntimeKind = "apple" | "podman" | "docker";

export interface RuntimeInfo {
  kind: RuntimeKind;
  bin: string;
}

interface ContainerInfo {
  state: "running" | "stopped" | "missing";
  ip?: string;
}

// ---- small process helpers -------------------------------------------------

function exec(
  bin: string,
  args: string[],
  timeoutMs = 60_000,
  env?: Record<string, string | undefined>,
): { code: number; out: string; err: string } {
  try {
    const proc = Bun.spawnSync({
      cmd: [bin, ...args],
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      timeout: timeoutMs,
      ...(env ? { env } : {}),
    });
    return {
      code: proc.exitCode ?? 1,
      out: proc.stdout ? proc.stdout.toString() : "",
      err: proc.stderr ? proc.stderr.toString() : "",
    };
  } catch (err) {
    // A missing binary (systemctl on macOS, for example) is just a failed probe.
    return { code: 1, out: "", err: err instanceof Error ? err.message : String(err) };
  }
}

async function execStream(bin: string, args: string[]): Promise<number> {
  const proc = Bun.spawn({ cmd: [bin, ...args], stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  return await proc.exited;
}

function which(cmd: string): string | undefined {
  return Bun.which(cmd) ?? undefined;
}

/** systemd's per-user bus, if this machine has one (WSL2 often does, but the
 *  invoking shell may lack XDG_RUNTIME_DIR, which breaks podman's cgroup path). */
function systemdBus(): string | undefined {
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  const bus = "/run/user/" + uid + "/bus";
  return existsSync(bus) ? bus : undefined;
}

/** Environment that lets podman reach the user systemd manager. */
function podmanEnv(): Record<string, string | undefined> | undefined {
  const bus = systemdBus();
  if (!bus) return undefined;
  // Always point podman at the user manager's bus. A shell can inherit an
  // ad-hoc dbus-launch bus instead; podman then cannot activate
  // org.freedesktop.systemd1 ("exited with status 1"), so cgroup setup fails.
  const uid = process.getuid!();
  return {
    ...process.env,
    XDG_RUNTIME_DIR: "/run/user/" + uid,
    DBUS_SESSION_BUS_ADDRESS: "unix:path=" + bus,
  };
}

function podmanExec(args: string[], timeoutMs = 60_000, env?: Record<string, string | undefined>) {
  const base = podmanEnv();
  return exec("podman", args, timeoutMs, env ?? base);
}

/** Run a command in a space's runtime, with the user-systemd env for podman. */
function runtimeExec(
  runtime: RuntimeInfo,
  args: string[],
  timeoutMs = 60_000,
  env?: Record<string, string | undefined>,
) {
  if (runtime.kind === "podman") {
    const base = env ?? podmanEnv();
    return exec(runtime.bin, args, timeoutMs, base);
  }
  return exec(runtime.bin, args, timeoutMs, env);
}

function fail(message: string, hint?: string): never {
  throw new CliError(message, hint);
}

// ---- runtime detection -----------------------------------------------------

function appleReady(): boolean {
  return exec("container", ["system", "status"], 10_000).code === 0;
}

async function appleEnsureService(where: string): Promise<void> {
  if (appleReady()) return;
  process.stderr.write(dim("  starting the Apple container service...") + "\n");
  const code = await execStream("container", ["system", "start"]);
  if (code !== 0 || !appleReady()) fail("cannot start the Apple container service", where);
}

function podmanRootless(): boolean {
  const r = podmanExec(["info", "--format", "json"], 20_000);
  if (r.code !== 0) return false;
  try {
    const info = JSON.parse(r.out) as { host?: { security?: { rootless?: boolean } } };
    return info.host?.security?.rootless === true;
  } catch {
    return false;
  }
}

function dockerReachable(): boolean {
  return exec("docker", ["info"], 20_000).code === 0;
}

function dockerRootless(): boolean {
  const r = exec("docker", ["info", "--format", "{{json .SecurityOptions}}"], 20_000);
  return r.code === 0 && /rootless/i.test(r.out);
}

/** Is a per-user systemd available for podman's cgroup manager? */
function hasUserSystemd(): boolean {
  if (systemdBus()) return true;
  const env = podmanEnv();
  return exec("systemctl", ["--user", "show-environment"], 5_000, env).code === 0;
}

/** podman on WSL2 without systemd fails while applying cgroups / moving the
 *  rootless netns into the systemd user slice. Those are retried differently. */
export function isPodmanCgroupFailure(text: string): boolean {
  return /cgroup|systemd|user\.slice|slirp4netns|libpod-/i.test(text);
}

/** crun is the only runtime that accepts NoCgroups; runc rejects it. */
function hasCrun(): boolean {
  return which("crun") !== undefined;
}

function isWsl2(): boolean {
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

/** A hint shown only when the fallbacks also failed. */
function podmanFailureHint(): string | undefined {
  if (!isWsl2()) return undefined;
  const crun = hasCrun()
    ? "crun is installed, so prime forces engine.runtime=crun and retries with --cgroups=disabled (limits unenforced)."
    : "or install crun (sudo apt install crun): prime then forces engine.runtime=crun for its containers and retries with --cgroups=disabled (limits unenforced).";
  return "WSL2: enable systemd ([boot]\\nsystemd=true in /etc/wsl.conf, then wsl --shutdown) and run loginctl enable-linger $USER; " + crun;
}

function runtimeBin(kind: RuntimeKind): string | undefined {
  return which(kind === "apple" ? "container" : kind);
}

/** Pick a runtime: Apple container on macOS, rootless podman on Linux (docker as
 *  fallback). --runtime forces one; --allow-rootful permits rootful docker. */
export async function detectRuntime(forced?: string, allowRootful = false): Promise<RuntimeInfo> {
  const order: RuntimeKind[] = forced
    ? [forced as RuntimeKind]
    : process.platform === "darwin"
      ? ["apple", "podman", "docker"]
      : ["podman", "docker"];
  for (const kind of order) {
    if (kind !== "apple" && kind !== "podman" && kind !== "docker") {
      throw new UsageError('unknown runtime "' + forced + '"', "Use --runtime apple|podman|docker.");
    }
    if (!runtimeBin(kind)) continue;
    if (kind === "apple") {
      if (process.platform !== "darwin") {
        if (forced) fail("the Apple container runtime is macOS-only");
        continue;
      }
      await appleEnsureService("Apple container is not available");
      return { kind, bin: "container" };
    }
    if (kind === "podman") {
      if (!podmanRootless()) {
        if (forced) fail("podman is not running rootless", "Start 'podman machine' (macOS) or check 'podman info'.");
        continue;
      }
      return { kind, bin: "podman" };
    }
    if (!dockerReachable()) {
      if (forced) fail("the docker daemon is not reachable", "Start Docker (or use --runtime podman / Apple container).");
      continue;
    }
    const rootless = process.platform === "darwin" || dockerRootless();
    if (!rootless && !allowRootful) {
      if (forced) fail("docker is running rootful", "Containers would hold host root. Use rootless podman, or pass --allow-rootful if you accept that.");
      continue;
    }
    return { kind, bin: "docker" };
  }
  fail("no container runtime found", "Install Apple container (macOS 26+), or rootless podman (Linux). See 'prime help spaces'.");
}

async function runtimeFor(kind: string, allowRootful = false): Promise<RuntimeInfo> {
  if (kind !== "apple" && kind !== "podman" && kind !== "docker") {
    fail('the space was created with an unknown runtime "' + kind + '"');
  }
  if (!runtimeBin(kind)) fail('the "' + kind + '" runtime that this space needs is not installed');
  if (kind === "apple") {
    await appleEnsureService("Apple container is not available");
  } else if (kind === "podman" && !podmanRootless()) {
    fail("podman is not running rootless", "Start it, then retry.");
  } else if (kind === "docker" && (!dockerReachable() || (!allowRootful && process.platform !== "darwin" && !dockerRootless()))) {
    fail("docker is not available rootless", "Start rootless docker, or pass --allow-rootful.");
  }
  return { kind, bin: kind === "apple" ? "container" : kind };
}

// ---- container operations ---------------------------------------------------

function imageExists(runtime: RuntimeInfo, image: string): boolean {
  if (runtime.kind === "apple") return runtimeExec(runtime, ["image", "inspect", image], 20_000).code === 0;
  if (runtime.kind === "podman") return runtimeExec(runtime, ["image", "exists", image], 20_000).code === 0;
  return runtimeExec(runtime, ["image", "inspect", image], 20_000).code === 0;
}

export function defaultImage(version: string): string {
  const tag = version.replace(/-dev$/, "");
  return "ghcr.io/tuanm/prime-space:" + tag;
}

async function ensureImage(runtime: RuntimeInfo, image: string, note: (text: string) => void): Promise<void> {
  if (imageExists(runtime, image)) return;
  note(dim("  pulling " + image + " (first run only)"));
  const args = runtime.kind === "apple" ? ["image", "pull", image] : ["pull", image];
  const code = await execStream(runtime.bin, args);
  if (code !== 0 || !imageExists(runtime, image)) {
    fail("cannot pull the space image " + image, "Check the network, or build it locally and pass --image <tag>.");
  }
}

function appleInfo(container: string): ContainerInfo {
  const r = exec("container", ["list", "--all", "--format", "json"], 30_000);
  if (r.code !== 0) fail("cannot query Apple containers", r.err.slice(0, 300));
  let list: Array<Record<string, any>> = [];
  try {
    list = JSON.parse(r.out) as Array<Record<string, any>>;
  } catch {
    fail("Apple container list returned invalid JSON");
  }
  const found = list.find((c) => c.configuration?.id === container || c.id === container);
  if (!found) return { state: "missing" };
  const status = (found.status ?? {}) as Record<string, any>;
  const rawState = String(status.state ?? found.state ?? "unknown");
  const address = status.networks?.[0]?.ipv4Address as string | undefined;
  return { state: rawState === "running" ? "running" : "stopped", ip: address ? address.split("/")[0] : undefined };
}

function podmanLikeInfo(runtime: RuntimeInfo, container: string): ContainerInfo {
  const r = runtimeExec(runtime, ["inspect", "--format", "{{.State.Status}}", container], 30_000);
  if (r.code !== 0) return { state: "missing" };
  const status = r.out.trim();
  return { state: status === "running" ? "running" : "stopped" };
}

function containerInfo(runtime: RuntimeInfo, container: string): ContainerInfo {
  return runtime.kind === "apple" ? appleInfo(container) : podmanLikeInfo(runtime, container);
}

/**
 * Is this space's container running?
 *
 * The fleet agent uses it: a space that is not running must not hold the
 * fleet's lease, or no other member could take over when it dies.
 */
export function spaceContainerRunning(runtime: RuntimeInfo, space: SpaceEntry): boolean {
  if (!space.container) return false;
  try {
    return containerInfo(runtime, space.container).state === "running";
  } catch {
    return false;
  }
}

/** Run the container with its token in a 0600 env file, so it never appears in
 *  the host process list (the file is removed right after the runtime reads it). */
/** Force podman's OCI runtime to crun for this invocation (NoCgroups needs it).
 *  podman has dropped the per-container --runtime flag, so this uses the config
 *  override podman documents for exactly this purpose. */
function crunEnv(dir: string): Record<string, string | undefined> {
  const file = join(dir, "containers.conf");
  writeFileSync(file, "[engine]\nruntime = \"crun\"\n", { mode: 0o600 });
  return { ...process.env, ...(podmanEnv() ?? {}), CONTAINERS_CONF_OVERRIDE: file };
}

function runContainer(
  runtime: RuntimeInfo,
  space: SpaceEntry,
  image: string,
  secretDir: string,
  allowNoLimits: boolean,
  note: (text: string) => void,
): { code: number; out: string; err: string; cgroup?: "systemd" | "cgroupfs" | "disabled" } {
  const dir = mkdtempSync(join(tmpdir(), "prime-space-"));
  try {
    if (runtime.kind !== "podman") {
      return runtimeExec(runtime, containerArgs(runtime, space, image, secretDir), 300_000);
    }
    // Rootless podman wants a user systemd for cgroup handling. WSL2 often has
    // none: try the default, then cgroupfs, then disabled cgroups (no limits).
    // NOTE: --cgroups is a "run" flag, so it must follow the subcommand; only
    // --cgroup-manager is a global flag.
    const systemd = hasUserSystemd();
    const crun = hasCrun();
    const attempts: Array<{
      globals: string[];
      flags: string[];
      limits: boolean;
      crun?: boolean;
      mode: "systemd" | "cgroupfs" | "disabled";
    }> = [];
    if (!systemd) attempts.push({ globals: ["--cgroup-manager=cgroupfs"], flags: [], limits: true, mode: "cgroupfs" });
    attempts.push({ globals: [], flags: [], limits: true, mode: "systemd" });
    // A second default attempt: the rootless systemd cgroup setup occasionally
    // fails once right after a restart and succeeds on the immediate retry.
    attempts.push({ globals: [], flags: [], limits: true, mode: "systemd" });
    // NoCgroups only works with crun; runc rejects it ("not compatible with
    // NoCgroups") and podman has no per-container --runtime flag any more, so
    // the runtime is forced through a config override. Only when the caller
    // explicitly accepted running without limits.
    if (crun && allowNoLimits) {
      attempts.push({ globals: [], flags: ["--cgroups=disabled"], limits: false, crun: true, mode: "disabled" });
    }
    let warnedLimits = false;
    let last = { code: 1, out: "", err: "" };
    for (const attempt of attempts) {
      // containerArgs already starts with "run": globals go before it, the
      // run-only flags (--cgroups) right after it.
      const base = containerArgs(runtime, space, image, secretDir, attempt.limits);
      const env = attempt.crun ? crunEnv(dir) : undefined;
      last = runtimeExec(runtime, [...attempt.globals, base[0]!, ...attempt.flags, ...base.slice(1)], 300_000, env);
      if (last.code === 0) return { ...last, cgroup: attempt.mode };
      runtimeExec(runtime, ["rm", "-f", space.container], 60_000);
      if (process.env.PRIME_DEBUG === "1") {
        note("  debug: " + attempt.mode + " attempt failed: " + (last.err || last.out).trim().slice(0, 400));
      }
      if (!isPodmanCgroupFailure(last.err + last.out)) return last;
      if (!attempt.limits && !warnedLimits) {
        warnedLimits = true;
        note("  cgroups are unavailable here; the cpu/memory limits are not enforced");
      }
    }
    return last;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function requireRunningAddress(runtime: RuntimeInfo, space: SpaceEntry): string | undefined {
  if (runtime.kind === "apple") {
    const info = appleInfo(space.container);
    return info.state === "running" && info.ip ? "http://" + info.ip + ":" + CONTAINER_PORT : undefined;
  }
  return space.port ? "http://127.0.0.1:" + space.port : undefined;
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  const port = server.port;
  server.stop(true);
  if (port === undefined) fail("cannot allocate a local port");
  return port;
}

function volumeCreate(runtime: RuntimeInfo, name: string): void {
  const args = ["volume", "create", name];
  const r = runtimeExec(runtime, args, 60_000);
  if (r.code !== 0 && !/already exists/i.test(r.err)) fail("cannot create volume " + name, r.err.slice(0, 300));
}

function volumeDelete(runtime: RuntimeInfo, name: string): void {
  const args = runtime.kind === "apple" ? ["volume", "delete", name] : ["volume", "rm", "-f", name];
  runtimeExec(runtime, args, 60_000);
}

function networkCreate(runtime: RuntimeInfo, name: string, internal: boolean): void {
  const args = ["network", "create"];
  if (internal) args.push("--internal");
  args.push(name);
  const r = runtime.kind === "apple" ? exec("container", args, 60_000) : runtimeExec(runtime, args, 60_000);
  if (r.code !== 0 && !/already exists/i.test(r.err)) fail("cannot create the space network", r.err.slice(0, 300));
}

function networkDelete(runtime: RuntimeInfo, name: string | undefined): void {
  if (!name || name === "none") return;
  if (runtime.kind === "apple") {
    exec("container", ["network", "delete", name], 60_000);
    return;
  }
  runtimeExec(runtime, ["network", "rm", name], 60_000);
}

function shellArg(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** The container entrypoint. The local MCP token (and, when exposed, the
 *  gateway device token) come from read-only mounted files; only the public
 *  gateway origin and device id are command-line arguments. */
export function entrypointScript(space: SpaceEntry): string {
  const base =
    'set -e; token=$(cat /run/prime/token); [ -n "$token" ] || { echo "prime: token file missing" >&2; exit 1; }; ' +
    'export PRIME_VAULT_FILE=/run/prime/vault.json; ';
  // A space that is exposed, and a space that is in a fleet, both talk to
  // the gateway: a fleet's primary has to be reachable, or a client that
  // addresses the fleet has nothing to call.
  if ((space.expose || space.fleet) && space.gateway && space.gateway_device) {
    return (
      base +
      'export PRIME_CHILD_DEVICE_TOKEN=$(cat /run/prime/gateway-token); ' +
      'exec /usr/local/bin/prime code-mcp --bind 0.0.0.0 --port 7777 --token "$token" --gateway ' +
      shellArg(space.gateway) +
      " --id " +
      shellArg(space.gateway_device)
    );
  }
  return base + 'exec /usr/local/bin/prime code-mcp --bind 0.0.0.0 --port 7777 --token "$token"';
}

/** Host directory (0700) with a 0600 token file, mounted read-only into the
 *  space, so the token never appears in the container config or env. */
function secretDirFor(ctx: Ctx, container: string): string {
  const dir = join(dirname(ctx.configPath), "spaces", container);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

function ensureSecret(dir: string, token: string, remoteToken?: string): void {
  const file = join(dir, "token");
  writeFileSync(file, token + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  const remote = join(dir, "gateway-token");
  if (remoteToken) {
    writeFileSync(remote, remoteToken + "\n", { mode: 0o600 });
    chmodSync(remote, 0o600);
  } else {
    rmSync(remote, { force: true });
  }
}

function removeSecret(dir: string | undefined): void {
  if (dir) rmSync(dir, { recursive: true, force: true });
}

/** Plaintext secret files only need to exist until the entrypoint read them.
 *  Removing them while the container runs keeps bash/file tools from reading
 *  the tokens or the vault payload. The directory itself stays mounted so a
 *  later start can write them again. */
function wipeSecretFiles(dir: string | undefined): void {
  if (!dir) return;
  for (const name of ["token", "gateway-token", "vault.json"]) rmSync(join(dir, name), { force: true });
}

function networkGateway(runtime: RuntimeInfo, network: string): string | undefined {
  if (runtime.kind === "apple") {
    const r = exec("container", ["network", "inspect", network], 20_000);
    if (r.code !== 0) return undefined;
    try {
      const parsed = JSON.parse(r.out) as Array<{ status?: { ipv4Gateway?: string } }>;
      return parsed[0]?.status?.ipv4Gateway?.split("/")[0];
    } catch {
      return undefined;
    }
  }
  const r = runtimeExec(runtime, ["network", "inspect", network, "--format", "json"], 20_000);
  if (r.code !== 0) return undefined;
  try {
    if (runtime.kind === "podman") {
      const parsed = JSON.parse(r.out) as Array<{ subnets?: Array<{ gateway?: string }> }>;
      return parsed[0]?.subnets?.[0]?.gateway;
    }
    const parsed = JSON.parse(r.out) as Array<{ IPAM?: { Config?: Array<{ Gateway?: string }> } }>;
    return parsed[0]?.IPAM?.Config?.[0]?.Gateway;
  } catch {
    return undefined;
  }
}

/** Build the space's vault payload. Values stay local; secrets/codes become
 *  placeholders and are registered with the host broker, which alone holds the
 *  real values and enforces the allowed-host list for its HTTP tool. */
interface PendingBroker {
  token: string;
  transport: "tcp" | "unix";
  bind?: string;
  port?: number;
  unix?: string;
  scope: BrokerScope;
}

async function prepareVault(ctx: Ctx, space: SpaceEntry, runtime: RuntimeInfo): Promise<PendingBroker | undefined> {
  if (!space.vaults || space.vaults.length === 0 || !space.secret_dir) return;
  const scope = brokerScopeFor(ctx.configPath, space.vaults, space.vault_kinds);
  const secretNames = Object.keys(scope.secrets);
  const codeNames = Object.keys(scope.codes);
  const file = join(space.secret_dir, "vault.json");
  if (secretNames.length === 0 && codeNames.length === 0) {
    writeFileSync(file, JSON.stringify({ values: scope.values }), { mode: 0o600 });
    chmodSync(file, 0o600);
    space.broker_token = undefined;
    space.broker_url = undefined;
    space.broker_bind = undefined;
    return undefined;
  }
  let transport: "tcp" | "unix" = "tcp";
  let bind: string | undefined;
  let unixPath: string | undefined;
  let brokerHost: string | undefined;
  let port: number | undefined;
  if (runtime.kind === "apple") {
    if (!space.network) fail("the space has no network for the vault broker");
    const gateway = networkGateway(runtime, space.network);
    if (!gateway) fail("cannot determine the host gateway for the vault broker");
    bind = gateway;
    brokerHost = gateway;
    port = await freePort();
  } else if (runtime.kind === "podman") {
    // Linux containers can connect to a Unix socket bind-mounted from the host,
    // which avoids listening on a network interface at all.
    transport = "unix";
    unixPath = join(space.secret_dir, "broker.sock");
  } else {
    bind = "0.0.0.0";
    brokerHost = "host.docker.internal";
    port = await freePort();
  }
  const token = newToken();
  const secretPayload: Record<string, string> = {};
  const codePayload: Record<string, unknown> = {};
  const secretScope: Record<string, { value: string; hosts: string[] }> = {};
  const codeScope: Record<string, { secret: string; digits: number; period: number; algorithm: string; hosts: string[] }> = {};
  for (const name of secretNames) {
    const placeholder = "__prime_secret_" + Buffer.from(randomBytes(12)).toString("hex") + "__";
    secretPayload[name] = placeholder;
    secretScope[placeholder] = scope.secrets[name]!;
  }
  for (const name of codeNames) {
    const placeholder = "__prime_code_" + Buffer.from(randomBytes(12)).toString("hex") + "__";
    codePayload[name] = { code: placeholder, expires_at: null };
    codeScope[placeholder] = scope.codes[name]!;
  }
  const brokerInfo = transport === "unix" ? { unix: "/run/prime/broker.sock", token } : { url: "http://" + brokerHost + ":" + port, token };
  writeFileSync(file, JSON.stringify({ values: scope.values, secrets: secretPayload, codes: codePayload, broker: brokerInfo }), { mode: 0o600 });
  chmodSync(file, 0o600);
  space.broker_token = token;
  space.broker_url = transport === "unix" ? "unix:///run/prime/broker.sock" : "http://" + brokerHost + ":" + port;
  space.broker_bind = bind ?? unixPath ?? "unix";
  return {
    token,
    transport,
    ...(bind ? { bind } : {}),
    ...(port ? { port } : {}),
    ...(unixPath ? { unix: unixPath } : {}),
    scope: { secrets: secretScope, codes: codeScope },
  };
}

/** Bind the broker listener only after the space's network interface exists. */
async function activateBroker(ctx: Ctx, pending: PendingBroker | undefined): Promise<void> {
  if (!pending) return;
  await ensureBroker(ctx.configPath);
  if (pending.transport === "unix") {
    await registerBrokerScope(ctx.configPath, pending.token, undefined, undefined, pending.scope, pending.unix);
  } else {
    await registerBrokerScope(ctx.configPath, pending.token, pending.bind!, pending.port!, pending.scope);
  }

}

function containerArgs(runtime: RuntimeInfo, space: SpaceEntry, image: string, secretDir: string, limits = true): string[] {
  const args: string[] = ["run", "-d", "--name", space.container, "--label", "prime.space=" + space.id];
  args.push("--entrypoint", "/bin/sh");
  args.push("-v", secretDir + ":/run/prime:ro");
  if (runtime.kind === "apple") {
    args.push("-c", String(space.cpus ?? 2), "-m", space.memory ?? "4g");
    if (space.network) args.push("--network", space.network);
    if (space.volume) args.push("-v", space.volume + ":/root/work");
    return args.concat([image, "-c", entrypointScript(space)]);
  }
  const podmanNetwork = space.network && space.network !== "none" ? space.network : "none";
  args.push("--network", podmanNetwork);
  if (podmanNetwork !== "none") args.push("--publish", "127.0.0.1:" + space.port + ":" + CONTAINER_PORT);
  if (limits) args.push("--cpus", String(space.cpus ?? 2), "--memory", space.memory ?? "4g");
  args.push(...(limits ? ["--pids-limit", "512"] : []), "--security-opt", "no-new-privileges");
  if (space.volume) args.push("-v", space.volume + ":/root/work");
  return args.concat([image, "-c", entrypointScript(space)]);
}

async function waitReady(url: string, token: string, quiet: boolean): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url + "/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        signal: AbortSignal.timeout(2_000),
      });
      if (res.status === 200) {
        await res.text();
        return;
      }
    } catch {}
    await Bun.sleep(100);
  }
  if (!quiet) process.stderr.write(dim("  the space is still booting; 'prime spaces list' will show it when ready") + "\n");
  throw new CliError("the space did not answer on " + url, "Inspect its logs: prime spaces logs <name>.");
}

// ---- config helpers ---------------------------------------------------------

function spaceNames(config: Config): string[] {
  return Object.keys(config.spaces).sort();
}

export function requireSpace(config: Config, name: string): SpaceEntry {
  const space = config.spaces[name];
  if (!space) {
    const known = spaceNames(config);
    throw new UsageError(
      'no space named "' + name + '"',
      known.length > 0 ? "Known spaces: " + known.join(", ") + "." : "Create one with: prime spaces create --name " + name,
    );
  }
  return space;
}

function assertSpaceName(name: string): void {
  if (!SPACE_NAME_RE.test(name)) {
    throw new UsageError('invalid space name "' + name + '"', "Use letters, digits, dot, underscore or dash (max 64 chars; no leading dash).");
  }
}

function positional(ctx: Ctx): string | undefined {
  return ctx.parsed.positionals[2];
}

function requirePositional(ctx: Ctx, what: string, usage: string): string {
  const value = positional(ctx);
  if (!value) throw new UsageError("missing " + what, "Usage: " + usage);
  if (ctx.parsed.positionals.length > 3) throw new UsageError('unexpected argument "' + ctx.parsed.positionals[3] + '"');
  return value;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function randomHex(length: number): string {
  return Array.from(randomBytes(Math.ceil(length / 2)), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, length);
}

export function newSpaceId(): string {
  return "space-" + randomHex(8);
}

function newToken(): string {
  return randomHex(48);
}

function registerDevice(config: Config, spaceName: string, space: SpaceEntry, url: string): void {
  config.devices[space.id] = {
    local_url: url,
    token: space.token,
    space: spaceName,
    note: "space " + spaceName,
    connected_at: new Date().toISOString(),
  };
}

// ---- commands ---------------------------------------------------------------



function parseVaultKinds(ctx: Ctx): Array<"value" | "secret" | "code"> | undefined {
  const raw = strList(ctx.parsed, "vault-kind");
  if (raw.length === 0) return undefined;
  const out = new Set<"value" | "secret" | "code">();
  for (const item of raw) {
    const value = item.toLowerCase();
    if (value === "value" || value === "values") out.add("value");
    else if (value === "secret" || value === "secrets") out.add("secret");
    else if (value === "code" || value === "codes") out.add("code");
    else throw new UsageError('unknown vault category "' + item + '"', "Use values, secrets or codes.");
  }
  return [...out];
}

function resolveGatewayToken(ctx: Ctx, saved?: string): string | undefined {
  const flag = str(ctx.parsed, "gateway-token");
  if (flag) return flag;
  const env = process.env[ENV.gatewayToken];
  if (env) return env;
  return saved || ctx.config.defaults.gateway_token || undefined;
}

/** The identity this space already has in that fleet, if it still has one. */
function existingFleetDevice(config: Config, fleet: string, spaceName: string): AnonymousDevice | undefined {
  // The identity that was made for this fleet comes first.
  for (const [id, entry] of Object.entries(config.devices)) {
    if (entry.fleet !== fleet || entry.space !== spaceName || !entry.token) continue;
    return { deviceId: id, token: entry.token, connectUrl: entry.gateway ?? "" };
  }
  // Then any other remote identity of this space: one that was made before
  // the fleet was written down still works.
  for (const [id, entry] of Object.entries(config.devices)) {
    if (entry.local_url || entry.space !== spaceName || !entry.token) continue;
    return { deviceId: id, token: entry.token, connectUrl: entry.gateway ?? "" };
  }
  // Then any remote identity that no space is using. It is kept in the
  // configuration, so the gateway is not asked for a new one - and the
  // gateway limits how many anonymous devices one address may make.
  const used = new Set<string>();
  for (const space of Object.values(config.spaces)) {
    if (space.id) used.add(space.id);
    if (space.gateway_device) used.add(space.gateway_device);
  }
  for (const [id, entry] of Object.entries(config.devices)) {
    if (entry.local_url || used.has(id) || !entry.token) continue;
    return { deviceId: id, token: entry.token, connectUrl: entry.gateway ?? "" };
  }
  return undefined;
}

/** Register/update the anonymous device entry for an exposed space. */
function rememberExposed(
  ctx: Ctx,
  name: string,
  space: SpaceEntry,
  device: AnonymousDevice,
  gateway: string,
  gatewayToken: string | undefined,
): void {
  // Drop the previous remote entry only; the local direct entry stays.
  for (const [id, entry] of Object.entries(ctx.config.devices)) {
    if (entry.space === name && !entry.local_url) delete ctx.config.devices[id];
  }
  ctx.config.devices[device.deviceId] = {
    gateway,
    ...(gatewayToken ? { gateway_token: gatewayToken } : {}),
    token: device.token,
    anonymous: true,
    connected_at: new Date().toISOString(),
    note: "anonymous device exposed by 'prime spaces create'",
    space: name,
  };
  space.expose = true;
  space.gateway = gateway;
  space.gateway_device = device.deviceId;
  space.remote_token = device.token;
  if (gatewayToken) space.gateway_token = gatewayToken;
}

/**
 * Put the fleet identity back, if it was lost.
 *
 * The identity is what the fleet knows the space by, so a space that has
 * lost it cannot call the fleet. The space entry still holds the
 * credential, so it can be put back.
 */
function restoreFleetDevice(ctx: Ctx, name: string, space: SpaceEntry): void {
  if (!space.fleet || !space.gateway_device || !space.remote_token) return;
  if (ctx.config.devices[space.gateway_device]) return;
  ctx.config.devices[space.gateway_device] = {
    gateway: space.gateway,
    ...(space.gateway_token ? { gateway_token: space.gateway_token } : {}),
    token: space.remote_token,
    anonymous: true,
    connected_at: new Date().toISOString(),
    note: "gateway identity of the fleet space '" + name + "'",
    space: name,
    fleet: space.fleet,
  };
}

/**
 * Remember the gateway identity a fleet space uses.
 *
 * The fleet is administered by the device that owns it, so the credential
 * has to be kept: without it the fleet could not be invited into, removed
 * from, or deleted.
 */
function rememberFleetDevice(
  ctx: Ctx,
  name: string,
  space: SpaceEntry,
  device: AnonymousDevice,
  gateway: string,
  gatewayToken: string | undefined,
): void {
  for (const [id, entry] of Object.entries(ctx.config.devices)) {
    if (entry.space === name && !entry.local_url) delete ctx.config.devices[id];
  }
  ctx.config.devices[device.deviceId] = {
    gateway,
    ...(gatewayToken ? { gateway_token: gatewayToken } : {}),
    token: device.token,
    anonymous: true,
    connected_at: new Date().toISOString(),
    note: "gateway identity of the fleet space '" + name + "'",
    space: name,
    // It is the identity the fleet knows this space by, so it survives a
    // stop: the space can be started again and must still be able to call.
    ...(space.fleet ? { fleet: space.fleet } : {}),
  };
  space.gateway = gateway;
  space.gateway_device = device.deviceId;
  space.remote_token = device.token;
  if (gatewayToken) space.gateway_token = gatewayToken;
}

/** Is the anonymous device still accepted? Re-register when the gateway has
 *  forgotten it (unused anonymous devices expire). */
async function refreshExposure(ctx: Ctx, name: string, space: SpaceEntry, gatewayToken: string | undefined): Promise<void> {
  const gateway = space.gateway;
  if (!gateway || !space.gateway_device || !space.remote_token) {
    fail('space "' + name + '" was exposed but its gateway credentials are missing', "Delete the space and create it again with --expose.");
  }
  let verdict: "valid" | "online" | "rejected" | "disabled" | "locked" | "unknown";
  try {
    const probe = await probeCredential(gateway, space.gateway_device, space.remote_token, gatewayToken);
    verdict = probe.verdict;
  } catch (err) {
    // Keep the local space usable when the gateway is temporarily unreachable;
    // the tunnel inside the space retries on its own.
    ctx.note(yellow("  warning: cannot reach the gateway for \"" + name + "\": " + (err instanceof Error ? err.message : String(err))));
    ensureSecret(space.secret_dir!, space.token, space.remote_token);
    return;
  }
  if (verdict === "rejected") {
    const device = await registerAnonymous(gateway, gatewayToken);
    rememberExposed(ctx, name, space, device, gateway, gatewayToken);
    ctx.note("  the old anonymous device expired; registered " + device.deviceId);
  } else if (verdict === "disabled") {
    fail('the gateway disabled the anonymous device for space "' + name + '"', "Create the space again with --expose (or without it for a local-only space).");
  } else if (verdict === "locked") {
    fail('the gateway temporarily locked the anonymous device for space "' + name + '"', "Retry in about 10 minutes, or create the space again with --expose.");
  } else if (verdict === "unknown") {
    ctx.note(yellow("  warning: could not verify the anonymous device; using it anyway"));
  }
  ensureSecret(space.secret_dir!, space.token, space.remote_token);
}

async function waitGatewayOnline(
  gateway: string,
  deviceId: string,
  token: string,
  gatewayToken: string | undefined,
  timeoutMs = 8_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const probe = await probeCredential(gateway, deviceId, token, gatewayToken);
      if (probe.verdict === "online") return true;
      if (probe.verdict === "rejected" || probe.verdict === "disabled" || probe.verdict === "locked") return false;
    } catch {
      return false;
    }
    if (Date.now() > deadline) return false;
    await Bun.sleep(500);
  }
}

function clearBroker(space: SpaceEntry): void {
  space.broker_token = undefined;
  space.broker_url = undefined;
  space.broker_bind = undefined;
}

export async function spacesCreate(ctx: Ctx, version: string): Promise<void> {
  const name = str(ctx.parsed, "name") ?? newSpaceId();
  assertSpaceName(name);
  if (ctx.config.spaces[name]) {
    throw new UsageError('a space named "' + name + '" already exists', "Use --name with another name, or 'prime spaces delete " + name + "'.");
  }
  const persistent = bool(ctx.parsed, "persistent");
  if (persistent && bool(ctx.parsed, "ephemeral")) throw new UsageError("--persistent and --ephemeral contradict each other");
  const offline = bool(ctx.parsed, "offline");
  const expose = bool(ctx.parsed, "expose");
  const fleet = str(ctx.parsed, "fleet");
  if (fleet && offline) {
    throw new UsageError("--fleet needs network access", "An offline space cannot reach the gateway; drop --offline to put it in a fleet.");
  }
  if (expose && offline) {
    throw new UsageError("--expose needs network access", "An offline space cannot reach the gateway; drop --offline to expose it.");
  }
  const runtime = await detectRuntime(str(ctx.parsed, "runtime"), bool(ctx.parsed, "allow-rootful"));
  const gateway = expose || fleet ? resolveGateway(ctx.config, str(ctx.parsed, "gateway")) : undefined;
  const gatewayToken = expose || fleet ? resolveGatewayToken(ctx) : undefined;
  let vaultCompanies = strList(ctx.parsed, "vault");
  if (bool(ctx.parsed, "vault-all")) vaultCompanies = allVaultCompanies(ctx.configPath);
  vaultCompanies = [...new Set(vaultCompanies)].sort();
  const vaultKinds = parseVaultKinds(ctx);
  const trusted = bool(ctx.parsed, "trusted");
  const image = str(ctx.parsed, "image") ?? defaultImage(version);
  const cpus = num(ctx.parsed, "cpus") ?? 2;
  const memory = str(ctx.parsed, "memory") ?? "4g";
  if (cpus <= 0) throw new UsageError("--cpus must be a positive number");
  if (!/^[0-9]+(\.[0-9]+)?[kmgt]?$/i.test(memory)) throw new UsageError("--memory must look like 512m, 4g or 2048m");
  const id = newSpaceId();
  const token = newToken();
  const port = runtime.kind === "apple" ? CONTAINER_PORT : await freePort();
  const container = "prime-space-" + id.slice("space-".length);
  // A space in a fleet keeps its work tree in a host directory, because the
  // synchronisation runs on the host and has to be able to read it.
  const fleetWork = fleet ? fleetWorkDir(ctx, name) : undefined;
  const volume = fleetWork ?? (persistent ? container + "-work" : undefined);
  const network = container + "-net";
  const space: SpaceEntry = {
    id,
    runtime: runtime.kind,
    image,
    mode: persistent ? "persistent" : "ephemeral",
    container,
    volume,
    network,
    token,
    ...(runtime.kind === "apple" ? {} : { port }),
    cpus,
    memory,
    ...(offline ? { offline: true } : {}),
    ...(fleet ? { fleet } : {}),
    ...(fleetWork ? { work_dir: fleetWork } : {}),
    ...(vaultCompanies.length > 0 ? { vaults: vaultCompanies } : {}),
    ...(vaultCompanies.length > 0 && vaultKinds ? { vault_kinds: vaultKinds } : {}),
    ...(vaultCompanies.length > 0 && trusted ? { trusted: true } : {}),
    created_at: new Date().toISOString(),
  };

  await ensureImage(runtime, image, (text) => ctx.note(text));
  if (volume && !fleetWork) volumeCreate(runtime, volume);
  networkCreate(runtime, network, offline);
  const secretDir = secretDirFor(ctx, container);
  ensureSecret(secretDir, token);
  space.secret_dir = secretDir;
  let pendingBroker: PendingBroker | undefined;
  if (vaultCompanies.length > 0) {
    try {
      pendingBroker = await prepareVault(ctx, space, runtime);
    } catch (err) {
      removeSecret(secretDir);
      networkDelete(runtime, network);
      if (volume && !fleetWork) volumeDelete(runtime, volume);
      throw err;
    }
  }
  let exposed: AnonymousDevice | undefined;
  if (expose) {
    try {
      exposed = await registerAnonymous(gateway!, gatewayToken);
    } catch (err) {
      removeSecret(secretDir);
      networkDelete(runtime, network);
      if (volume && !fleetWork) volumeDelete(runtime, volume);
      throw err;
    }
    rememberExposed(ctx, name, space, exposed, gateway!, gatewayToken);
    ensureSecret(secretDir, token, exposed.token);
  }
  // A fleet space takes its place in the fleet and, if it is a replica, gets
  // the current state before the container starts. A space that began empty
  // and caught up later would have a window where the two disagree.
  if (fleet) {
    let device: AnonymousDevice | undefined;
    try {
      // The identity the fleet knows this space by is kept across a
      // recreate: a new identity would be a new member, and the gateway
      // limits how many anonymous devices one address may make.
      const known = existingFleetDevice(ctx.config, fleet, name);
      if (known) {
        // It is used only if the gateway still knows it.
        const probe = await probeCredential(gateway!, known.deviceId, known.token, gatewayToken).catch(() => ({ verdict: "unknown" as const }));
        if (probe.verdict === "valid" || probe.verdict === "online") {
          device = known;
          ctx.note("  reusing the fleet identity " + known.deviceId);
        }
      }
      // A fleet space tells the gateway which fleet it is joining, so the
      // device is made without the limit that applies to throwaway ones.
      const code = str(ctx.parsed, "code");
      device =
        device ??
        (await registerAnonymous(gateway!, gatewayToken, code ? { id: fleet, code } : undefined));
      const setup = await setupFleetSpace(ctx, {
        fleet,
        spaceName: name,
        gateway: gateway!,
        deviceId: device.deviceId,
        deviceToken: device.token,
        ...(str(ctx.parsed, "code") ? { code: str(ctx.parsed, "code") } : {}),
        create: !str(ctx.parsed, "code"),
      });
      space.fleet_role = setup.role;
      rememberFleetDevice(ctx, name, space, device, gateway!, gatewayToken);
      ensureSecret(secretDir, token, device.token);
    } catch (err) {
      // A space that joined a fleet and then failed must not stay in it as a
      // ghost: it would take up a place in the roster for ever.
      const joined = device;
      try {
        if (joined) {
          await fetch(gateway! + "/fleets/" + encodeURIComponent(fleet) + "/remove", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-prime-device": joined.deviceId,
              "x-device-token": joined.token,
            },
            body: JSON.stringify({ deviceId: joined.deviceId }),
            signal: AbortSignal.timeout(15_000),
          });
        }
      } catch {}
      removeSecret(secretDir);
      networkDelete(runtime, network);
      if (volume && !fleetWork) volumeDelete(runtime, volume);
      throw err;
    }
  }
  const started = Date.now();
  const run = runContainer(runtime, space, image, secretDir, bool(ctx.parsed, "allow-no-limits"), (text) => ctx.note(text));
  if (run.code === 0 && pendingBroker) {
    try {
      await activateBroker(ctx, pendingBroker);
    } catch (err) {
      runtimeExec(runtime, ["rm", "-f", container], 120_000);
      if (volume && !fleetWork) volumeDelete(runtime, volume);
      networkDelete(runtime, network);
      removeSecret(secretDir);
      if (pendingBroker) await unregisterBrokerScope(ctx.configPath, pendingBroker.token);
      throw err;
    }
  }
  if (run.code !== 0) {
    if (volume && !fleetWork) volumeDelete(runtime, volume);
    networkDelete(runtime, network);
    removeSecret(secretDir);
    fail("cannot start the space container", ((run.err || run.out).slice(0, 400) + (runtime.kind === "podman" ? "\n" + (podmanFailureHint() ?? "") : "")).trim() || undefined);
  }
  if (run.cgroup === "disabled" && !bool(ctx.parsed, "allow-no-limits")) {
    runtimeExec(runtime, ["rm", "-f", container], 120_000);
    if (volume && !fleetWork) volumeDelete(runtime, volume);
    networkDelete(runtime, network);
    removeSecret(secretDir);
    fail("this runtime cannot enforce the cpu/memory limits", "Enable systemd cgroups (run 'prime spaces doctor') and retry, or pass --allow-no-limits to accept a space without resource limits.");
  }
  let url: string | undefined;
  try {
    url = requireRunningAddress(runtime, space);
    if (!url) fail("the space container started but has no address yet");
    await waitReady(url, token, ctx.quiet);
  } catch (err) {
    runtimeExec(runtime, ["rm", "-f", container], 120_000);
    if (volume && !fleetWork) volumeDelete(runtime, volume);
    networkDelete(runtime, network);
    removeSecret(secretDir);
    if (pendingBroker) await unregisterBrokerScope(ctx.configPath, pendingBroker.token);
    throw err;
  }
  space.local_url = url;
  space.cgroup_mode = run.cgroup;
  wipeSecretFiles(secretDir);
  const bootMs = Date.now() - started;
  let exposedOnline = false;
  if (expose && exposed) {
    exposedOnline = await waitGatewayOnline(gateway!, exposed.deviceId, exposed.token, gatewayToken);
  }
  registerDevice(ctx.config, name, space, url);
  ctx.config.spaces[name] = space;
  saveConfig(ctx.configPath, ctx.config);
  // A space in a fleet needs the agent that keeps it in step. It is started
  // the same way the vault broker is: on demand, and only when there is
  // something for it to do.
  if (space.fleet) {
    try {
      await ensureFleetAgent(ctx.configPath);
    } catch (err) {
      ctx.note(yellow("  the fleet agent did not start: " + (err instanceof Error ? err.message : String(err))));
    }
  }
  if (ctx.json) {
    printJson({
      created: true,
      name,
      space,
      device: space.id,
      url,
      boot_ms: bootMs,
      ...(expose && exposed
        ? {
            exposed: {
              device: exposed.deviceId,
              gateway: gateway!,
              connect_url: connectUrlFor(gateway!, exposed.deviceId, exposed.token),
              online: exposedOnline,
              ...(exposed.rateLimit ? { rate_limit: exposed.rateLimit } : {}),
            },
          }
        : {}),
      config_path: ctx.configPath,
    });
    return;
  }
  ctx.out(green("\u2713") + " created space " + bold(name) + " (" + space.mode + ", " + runtime.kind + ")");
  ctx.out("  device    " + space.id);
  ctx.out("  url       " + url);
  ctx.out("  image     " + image);
  ctx.out("  limits    " + cpus + " cpu, " + memory + (offline ? ", offline" : ""));
  ctx.out("  boot      " + (bootMs / 1000).toFixed(1) + "s");
  if (space.vaults && space.vaults.length > 0) ctx.out("  vaults    " + space.vaults.join(", "));
  if (expose && exposed) {
    ctx.out("  exposed   " + bold(exposed.deviceId) + (exposedOnline ? green(" (online)") : yellow(" (tunnel starting)")));
    ctx.out("  connect   " + cyan(connectUrlFor(gateway!, exposed.deviceId, exposed.token)));
    ctx.note(yellow("  warning: anyone with that URL can run commands in this space"));
  } else {
    ctx.out("  try       " + dim("prime tools call " + space.id + ".bash '{\"cwd\":\"/root/work\",\"command\":\"uname -a\"}'"));
  }
}

export async function spacesStart(ctx: Ctx): Promise<void> {
  const name = requirePositional(ctx, "<name>", "prime spaces start <name>");
  const space = requireSpace(ctx.config, name);
  const runtime = await runtimeFor(space.runtime, bool(ctx.parsed, "allow-rootful"));
  const allowNoLimits = bool(ctx.parsed, "allow-no-limits");
  await ensureImage(runtime, space.image, (text) => ctx.note(text));
  const existing = containerInfo(runtime, space.container);
  if (existing.state !== "missing") {
    if (runtime.kind !== "apple" && space.cgroup_mode !== "systemd" && space.cgroup_mode !== "cgroupfs" && !allowNoLimits) {
      fail("space \"" + name + "\" predates enforced cpu/memory limits", "Recreate it (delete + create) to record enforcement, or pass --allow-no-limits to start it anyway.");
    }
    if (!space.secret_dir) ctx.note("  legacy space: recreate it to move the token out of the container config");
  }
  if (existing.state === "missing") {
    if (!space.network || space.network === "none") space.network = space.container + "-net";
    networkCreate(runtime, space.network, space.offline === true);
  }
  if (!space.secret_dir) space.secret_dir = secretDirFor(ctx, space.container);
  const expose = space.expose === true;
  let gatewayToken: string | undefined;
  if (expose) {
    gatewayToken = resolveGatewayToken(ctx, space.gateway_token);
    await refreshExposure(ctx, name, space, gatewayToken);
  }
  ensureSecret(space.secret_dir, space.token, expose || space.fleet ? space.remote_token : undefined);
  let pendingBroker: PendingBroker | undefined;
  try {
    pendingBroker = await prepareVault(ctx, space, runtime);
  } catch (err) {
    wipeSecretFiles(space.secret_dir);
    throw err;
  }
  let started = 0;
  try {
    started = Date.now();
  if (existing.state === "missing") {
    if (space.mode === "persistent") {
      fail('the persistent container for space "' + name + '" is gone', "Its volume still exists. Delete the space and create it again to start over.");
    }
    const run = runContainer(runtime, space, space.image, space.secret_dir, allowNoLimits, (text) => ctx.note(text));
    if (run.code === 0) space.cgroup_mode = run.cgroup;
    if (run.code === 0 && run.cgroup === "disabled" && !allowNoLimits) {
      runtimeExec(runtime, ["rm", "-f", space.container], 120_000);
      networkDelete(runtime, space.network);
      removeSecret(space.secret_dir);
      fail("this runtime cannot enforce the cpu/memory limits", "Enable systemd cgroups (run 'prime spaces doctor') and retry, or pass --allow-no-limits to accept a space without resource limits.");
    }
    if (run.code !== 0) fail("cannot start the space container", ((run.err || run.out).slice(0, 400) + (runtime.kind === "podman" ? "\n" + (podmanFailureHint() ?? "") : "")).trim() || undefined);
  } else if (existing.state === "stopped") {
    const globalFlags = runtime.kind === "podman" && !hasUserSystemd() ? ["--cgroup-manager=cgroupfs"] : [];
    let start = runtimeExec(runtime, [...globalFlags, "start", space.container], 120_000);
    if (start.code !== 0 && runtime.kind === "podman" && isPodmanCgroupFailure(start.err + start.out)) {
      start = runtimeExec(runtime, ["--cgroup-manager=cgroupfs", "start", space.container], 120_000);
    }
    if (start.code !== 0 && runtime.kind === "podman" && hasCrun()) {
      const dir = mkdtempSync(join(tmpdir(), "prime-space-"));
      try {
        start = runtimeExec(runtime, ["start", space.container], 120_000, crunEnv(dir));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    if (start.code !== 0) fail("cannot start the space", ((start.err || start.out).slice(0, 400) + "\n" + (podmanFailureHint() ?? "")).trim());
  }
  await activateBroker(ctx, pendingBroker);
  const url = requireRunningAddress(runtime, space);
  if (!url) fail("the space container is running but has no address yet");
  await waitReady(url, space.token, ctx.quiet);
  space.local_url = url;
  wipeSecretFiles(space.secret_dir);
  let exposedOnline = false;
  if (expose && space.gateway && space.gateway_device && space.remote_token) {
    exposedOnline = await waitGatewayOnline(space.gateway, space.gateway_device, space.remote_token, gatewayToken);
  }
  registerDevice(ctx.config, name, space, url);
  // A space that lost its fleet identity gets it back, so it can call the
  // fleet as itself again.
  restoreFleetDevice(ctx, name, space);
  saveConfig(ctx.configPath, ctx.config);
  // A space in a fleet needs the agent that keeps it in step.
  if (space.fleet) {
    try {
      await ensureFleetAgent(ctx.configPath);
    } catch (err) {
      ctx.note(yellow("  the fleet agent did not start: " + (err instanceof Error ? err.message : String(err))));
    }
  }
  if (ctx.json) {
    printJson({
      started: true,
      name,
      space,
      url,
      boot_ms: Date.now() - started,
      ...(expose && space.gateway && space.gateway_device && space.remote_token
        ? {
            exposed: {
              device: space.gateway_device,
              gateway: space.gateway,
              connect_url: connectUrlFor(space.gateway, space.gateway_device, space.remote_token),
              online: exposedOnline,
            },
          }
        : {}),
    });
    return;
  }
  ctx.out(green("\u2713") + " started space " + bold(name) + " (" + ((Date.now() - started) / 1000).toFixed(1) + "s)");
  ctx.out("  url       " + url);
  if (expose && space.gateway && space.gateway_device && space.remote_token) {
    ctx.out("  exposed   " + bold(space.gateway_device) + (exposedOnline ? green(" (online)") : yellow(" (tunnel starting)")));
    ctx.out("  connect   " + cyan(connectUrlFor(space.gateway, space.gateway_device, space.remote_token)));
  }
  } catch (err) {
    // Never leave the decrypted token/vault files (or a live broker scope) after a failed start.
    wipeSecretFiles(space.secret_dir);
    if (pendingBroker) await unregisterBrokerScope(ctx.configPath, pendingBroker.token);
    throw err;
  }
}


/** Build the runtime exec invocation for an interactive shell/command. */
export function spaceEnterArgs(container: string, tty: boolean, shell: string, command: string[]): string[] {
  return ["exec", "-i", ...(tty ? ["-t"] : []), container, ...(command.length > 0 ? command : [shell])];
}

function runtimeInteractive(runtime: RuntimeInfo, args: string[]): number {
  const env = runtime.kind === "podman" ? { ...process.env, ...(podmanEnv() ?? {}) } : process.env;
  const result = spawnSync(runtime.bin, args, { stdio: "inherit", env });
  if (result.error) fail("cannot start the container runtime", String(result.error));
  return result.status ?? 1;
}

/** Open a shell in a running space, or run one command after `--`. */
export async function spacesEnter(ctx: Ctx): Promise<void> {
  const name = positional(ctx);
  if (!name) throw new UsageError("missing <name>", "Usage: prime spaces enter <name> [--shell <path>] [-- <command...>]");
  const space = requireSpace(ctx.config, name);
  const runtime = await runtimeFor(space.runtime, bool(ctx.parsed, "allow-rootful"));
  const info = containerInfo(runtime, space.container);
  if (info.state !== "running") fail('space "' + name + '" is not running', "Start it with: prime spaces start " + name);
  const command = ctx.parsed.positionals.slice(3);
  const shell = str(ctx.parsed, "shell") ?? "/bin/bash";
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  process.exitCode = runtimeInteractive(runtime, spaceEnterArgs(space.container, tty, shell, command));
}

export async function spacesStop(ctx: Ctx): Promise<void> {
  const name = requirePositional(ctx, "<name>", "prime spaces stop <name>");
  const space = requireSpace(ctx.config, name);
  const runtime = await runtimeFor(space.runtime, bool(ctx.parsed, "allow-rootful"));
  const info = containerInfo(runtime, space.container);
  let wiped = false;
  if (info.state !== "missing") {
    runtimeExec(runtime, ["stop", space.container], 120_000);
    if (space.mode === "ephemeral") {
      runtimeExec(runtime, ["rm", "-f", space.container], 120_000);
      if (space.volume) volumeDelete(runtime, space.volume);
      wiped = true;
    }
  }
  if (space.mode === "ephemeral") networkDelete(runtime, space.network);
  space.local_url = undefined;
  await unregisterBrokerScope(ctx.configPath, space.broker_token);
  clearBroker(space);
  saveConfig(ctx.configPath, ctx.config);
  if (ctx.json) {
    printJson({ stopped: true, name, state_wiped: wiped });
    return;
  }
  ctx.out(green("\u2713") + " stopped space " + bold(name) + (wiped ? dim(" (state wiped)") : dim(" (state kept)")));
}

export async function spacesDelete(ctx: Ctx): Promise<void> {
  const name = requirePositional(ctx, "<name>", "prime spaces delete <name>");
  const space = requireSpace(ctx.config, name);
  // A space that belongs to a fleet leaves it. Otherwise the fleet keeps a
  // member that is never there again, and one that owns it keeps a fleet
  // nobody can run.
  if (space.fleet && space.gateway_device && space.remote_token) {
    await leaveFleet(ctx, space);
  }
  const runtime = await runtimeFor(space.runtime, bool(ctx.parsed, "allow-rootful"));
  runtimeExec(runtime, ["stop", space.container], 120_000);
  runtimeExec(runtime, ["rm", "-f", space.container], 120_000);
  await unregisterBrokerScope(ctx.configPath, space.broker_token);
  if (space.volume) volumeDelete(runtime, space.volume);
  networkDelete(runtime, space.network);
  removeSecret(space.secret_dir);
  if (!space.secret_dir && space.container) removeSecret(secretDirFor(ctx, space.container));
  delete ctx.config.spaces[name];
  for (const [deviceId, entry] of Object.entries(ctx.config.devices)) {
    // The fleet identity stays: a stopped space can be started again, and it
    // has to be able to call the fleet as itself.
    if (deviceId === space.id || (entry.space === name && !entry.fleet)) delete ctx.config.devices[deviceId];
  }
  saveConfig(ctx.configPath, ctx.config);
  if (ctx.json) {
    printJson({ deleted: true, name, device: space.id });
    return;
  }
  ctx.out(green("\u2713") + " deleted space " + bold(name));
}

/**
 * Leave the fleet this space belongs to.
 *
 * The space speaks with its own gateway identity, so it removes itself from
 * the fleet. The fleet hands itself to the member that has been in it the
 * longest, and goes away when the last one leaves.
 */
async function leaveFleet(ctx: Ctx, space: SpaceEntry): Promise<void> {
  const fleet = space.fleet!;
  const gateway = space.gateway;
  if (!gateway) return;
  try {
    const res = await fetch(gateway + "/fleets/" + encodeURIComponent(fleet) + "/remove", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-prime-device": space.gateway_device!,
        "x-device-token": space.remote_token!,
      },
      body: JSON.stringify({ deviceId: space.gateway_device }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) ctx.note(yellow("  the space could not leave the fleet " + fleet + " (" + res.status + ")"));
  } catch (err) {
    ctx.note(yellow("  the space could not leave the fleet " + fleet + ": " + (err instanceof Error ? err.message : String(err))));
  }
}

export async function spacesList(ctx: Ctx): Promise<void> {
  const names = spaceNames(ctx.config);
  if (names.length === 0) {
    if (ctx.json) {
      printJson({ spaces: [], config_path: ctx.configPath });
      return;
    }
    ctx.out(dim("No spaces yet. Create one with: prime spaces create --name dev"));
    return;
  }
  const rows: Array<{ name: string; space: SpaceEntry; state: string; url?: string }> = [];
  let runtimeError: string | undefined;
  let runtime: RuntimeInfo | undefined;
  try {
    runtime = await runtimeFor(ctx.config.spaces[names[0]!]!.runtime, bool(ctx.parsed, "allow-rootful"));
  } catch (err) {
    runtimeError = err instanceof Error ? err.message : String(err);
  }
  for (const name of names) {
    const space = ctx.config.spaces[name]!;
    let state = "unknown";
    let url = space.local_url;
    if (runtime) {
      const info = containerInfo(runtime, space.container);
      state = info.state === "missing" && space.mode === "ephemeral" ? "stopped" : info.state;
      url = info.state === "running" ? requireRunningAddress(runtime, space) ?? url : url;
    }
    rows.push({ name, space, state, url });
  }
  if (ctx.json) {
    printJson({
      config_path: ctx.configPath,
      spaces: rows.map((row) => ({
        name: row.name,
        ...row.space,
        state: row.state,
        url: row.url,
        device: row.space.id,
        persistent: row.space.mode === "persistent",
      })),
      ...(runtimeError ? { runtime_error: runtimeError } : {}),
    });
    return;
  }
  const tableRows = rows.map((row) => [
    bold(row.name),
    row.space.mode,
    row.state === "running" ? green("running") : row.state === "stopped" ? yellow("stopped") : red(row.state),
    row.space.id,
    row.url ?? dim("-"),
    row.space.gateway_device ?? dim("-"),
    row.space.image,
  ]);
  ctx.out(table(["NAME", "MODE", "STATUS", "DEVICE", "URL", "EXPOSED", "IMAGE"], tableRows));
  const running = rows.filter((r) => r.state === "running").length;
  ctx.note(dim(running + "/" + rows.length + " running" + (runtimeError ? " (runtime: " + runtimeError + ")" : "")));
}

export async function spacesLogs(ctx: Ctx): Promise<void> {
  const name = requirePositional(ctx, "<name>", "prime spaces logs <name>");
  const space = requireSpace(ctx.config, name);
  const runtime = await runtimeFor(space.runtime, bool(ctx.parsed, "allow-rootful"));
  const r = runtimeExec(runtime, ["logs", space.container], 60_000);
  if (r.code !== 0) fail("cannot read the space logs", (r.err || r.out).slice(0, 300));
  process.stdout.write(r.out);
}


/** Print what a space will actually get: runtime, rootless?, user systemd,
 *  OCI runtime, crun, and whether the existing spaces enforce limits. */
export async function spacesDoctor(ctx: Ctx): Promise<void> {
  const wsl = isWsl2();
  const platform = process.platform === "darwin" ? "macOS" : wsl ? "Linux (WSL2)" : process.platform;
  const podman = which("podman");
  let rootless: boolean | undefined;
  let cgroupManager: string | undefined;
  let ociRuntime: string | undefined;
  let podmanVersion: string | undefined;
  if (podman) {
    podmanVersion = podmanExec(["--version"], 10_000).out.trim();
    const info = podmanExec(["info", "--format", "json"], 30_000);
    if (info.code === 0) {
      try {
        const d = JSON.parse(info.out) as {
          host?: { security?: { rootless?: boolean }; cgroupManager?: string; ociRuntime?: { name?: string } };
        };
        rootless = d.host?.security?.rootless;
        cgroupManager = d.host?.cgroupManager;
        ociRuntime = d.host?.ociRuntime?.name;
      } catch {}
    }
  }
  const bus = systemdBus() ?? null;
  const linger = exec("loginctl", ["show-user", process.env.USER ?? "", "-p", "Linger", "--value"], 10_000).out.trim() || null;
  const crun = which("crun") ?? null;
  const apple = which("container") ?? null;
  const docker = which("docker") ?? null;
  const spaces = Object.keys(ctx.config.spaces)
    .sort()
    .map((name) => {
      const space = ctx.config.spaces[name]!;
      return {
        name,
        mode: space.mode,
        runtime: space.runtime,
        cgroup_mode: space.cgroup_mode ?? null,
        token_in_file: Boolean(space.secret_dir),
        vaults: space.vaults ?? [],
        trusted: space.trusted === true,
        exposed: space.gateway_device
          ? {
              device: space.gateway_device,
              gateway: space.gateway,
              connect_url:
                space.gateway && space.remote_token ? connectUrlFor(space.gateway, space.gateway_device, space.remote_token) : null,
            }
          : null,
        limits_enforced:
          space.runtime === "apple"
            ? true
            : space.cgroup_mode === "systemd" || space.cgroup_mode === "cgroupfs"
              ? true
              : space.cgroup_mode === "disabled"
                ? false
                : null,
      };
    });
  const hints: string[] = [];
  if (wsl) {
    if (!bus) {
      hints.push("WSL2: no user systemd bus (/run/user/<uid>/bus). Enable systemd ([boot] systemd=true in /etc/wsl.conf), wsl --shutdown, then loginctl enable-linger.");
    } else if (rootless === true && cgroupManager !== "systemd") {
      hints.push("podman is rootless but not using systemd cgroups; prime passes XDG_RUNTIME_DIR/DBUS to podman when the bus exists, so check that podman info shows systemd.");
    }
    if (!crun) hints.push("No crun: without systemd cgroups, runc cannot disable cgroups. Install crun (sudo apt install crun) as the fallback.");
  }
  if (rootless === false) hints.push("podman is running rootful; prime only accepts rootless podman.");
  if (spaces.some((space) => space.limits_enforced === false)) {
    hints.push("Some spaces were created with cgroups disabled; cpu/memory limits are not enforced for them. Delete and recreate after fixing systemd, or start them with --allow-no-limits.");
  }
  if (spaces.some((space) => space.limits_enforced === null)) {
    hints.push("Some spaces predate limit tracking; recreate them to record and enforce limits.");
  }
  if (spaces.some((space) => !space.token_in_file)) {
    hints.push("Some spaces keep their token in the container config (legacy); recreate them to mount it as a read-only file instead.");
  }
  if (ctx.json) {
    printJson({
      platform,
      wsl2: wsl,
      uid: process.getuid?.() ?? null,
      podman: podman ? { version: podmanVersion, rootless, cgroup_manager: cgroupManager, oci_runtime: ociRuntime } : null,
      systemd_user_bus: bus,
      linger,
      crun,
      apple_container: apple,
      docker,
      spaces,
      hints,
    });
    return;
  }
  ctx.out("platform         " + platform);
  ctx.out("podman           " + (podman ? podmanVersion : "not installed") + (rootless === undefined ? "" : ", rootless=" + rootless));
  if (podman) ctx.out("cgroup manager   " + (cgroupManager ?? "unknown") + "   oci runtime " + (ociRuntime ?? "unknown"));
  ctx.out("user systemd bus " + (bus ?? "missing") + (linger ? "   linger=" + linger : ""));
  ctx.out("crun             " + (crun ?? "not installed"));
  ctx.out("apple container  " + (apple ?? "not installed"));
  ctx.out("docker           " + (docker ?? "not installed"));
  if (spaces.length > 0) {
    ctx.out("");
    const rows = spaces.map((space) => [
      bold(space.name),
      space.mode,
      space.runtime,
      space.cgroup_mode ?? dim("-"),
      space.limits_enforced === null ? yellow("unknown") : space.limits_enforced ? green("enforced") : yellow("not enforced"),
    ]);
    ctx.out(table(["SPACE", "MODE", "RUNTIME", "CGROUPS", "LIMITS"], rows));
  }
  if (hints.length > 0) {
    ctx.out("");
    for (const hint of hints) ctx.note(yellow("hint: ") + hint);
  }
}


// ---- spaces top (activity monitor) -----------------------------------------

export interface TopStats {
  cpu_percent?: number;
  cpu_usec?: number;
  memory_used_bytes?: number;
  memory_limit_bytes?: number;
  memory_percent?: number;
  net_rx_bytes?: number;
  net_tx_bytes?: number;
  block_read_bytes?: number;
  block_write_bytes?: number;
  pids?: number;
}

export interface TopProcess {
  pid: number;
  ppid: number;
  stat: string;
  cpu: number;
  mem: number;
  rss_kib: number;
  command: string;
}

/** 5.3 MB, 104.29 MiB, 12B, or a plain number of bytes. */
export function parseHumanBytes(text: string): number | undefined {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([a-z]+)?$/i.exec(text.trim());
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = (match[2] ?? "b").toLowerCase();
  const factors: Record<string, number> = {
    b: 1,
    kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4,
    kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
  };
  const factor = factors[unit];
  return factor === undefined ? undefined : value * factor;
}

function splitPair(text: string | undefined): [number | undefined, number | undefined] {
  if (!text) return [undefined, undefined];
  const parts = text.split("/");
  return [parseHumanBytes(parts[0] ?? ""), parts[1] ? parseHumanBytes(parts[1]) : undefined];
}

function percent(text: string | number | undefined): number | undefined {
  if (text === undefined) return undefined;
  if (typeof text === "number") return text;
  const value = Number(text.replace("%", "").trim());
  return Number.isFinite(value) ? value : undefined;
}

export function parseAppleStats(raw: string): TopStats | undefined {
  try {
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    const item = Array.isArray(parsed) ? parsed[0] : undefined;
    if (!item) return undefined;
    return {
      cpu_usec: Number(item.cpuUsageUsec ?? 0),
      memory_used_bytes: Number(item.memoryUsageBytes ?? 0),
      memory_limit_bytes: Number(item.memoryLimitBytes ?? 0),
      net_rx_bytes: Number(item.networkRxBytes ?? 0),
      net_tx_bytes: Number(item.networkTxBytes ?? 0),
      block_read_bytes: Number(item.blockReadBytes ?? 0),
      block_write_bytes: Number(item.blockWriteBytes ?? 0),
      pids: Number(item.numProcesses ?? 0),
    };
  } catch {
    return undefined;
  }
}

export function parsePodmanStats(raw: string): TopStats | undefined {
  try {
    const parsed = JSON.parse(raw) as Array<Record<string, string>>;
    const item = Array.isArray(parsed) ? parsed[0] : undefined;
    if (!item) return undefined;
    const [memUsed, memLimit] = splitPair(item.mem_usage);
    const [netRx, netTx] = splitPair(item.net_io);
    const [blockRead, blockWrite] = splitPair(item.block_io);
    return {
      cpu_percent: percent(item.cpu_percent),
      memory_used_bytes: memUsed,
      memory_limit_bytes: memLimit,
      memory_percent: percent(item.mem_percent),
      net_rx_bytes: netRx,
      net_tx_bytes: netTx,
      block_read_bytes: blockRead,
      block_write_bytes: blockWrite,
      pids: Number(item.pids ?? 0),
    };
  } catch {
    return undefined;
  }
}

export function parseDockerStats(raw: string): TopStats | undefined {
  try {
    const item = JSON.parse(raw) as Record<string, string>;
    const [memUsed, memLimit] = splitPair(item.MemUsage);
    const [netRx, netTx] = splitPair(item.NetIO);
    const [blockRead, blockWrite] = splitPair(item.BlockIO);
    return {
      cpu_percent: percent(item.CPUPerc),
      memory_used_bytes: memUsed,
      memory_limit_bytes: memLimit,
      memory_percent: percent(item.MemPerc),
      net_rx_bytes: netRx,
      net_tx_bytes: netTx,
      block_read_bytes: blockRead,
      block_write_bytes: blockWrite,
      pids: Number(item.PIDs ?? 0),
    };
  } catch {
    return undefined;
  }
}

/** Never print a space token that a process command line happens to carry. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(--token[=\s]+)(\"?[^\s\"]+\"?)/g, "$1***")
    .replace(/(PRIME_SPACE_TOKEN=)(\S+)/g, "$1***");
}

export function parseTopProcesses(raw: string): TopProcess[] {
  const rows: TopProcess[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([0-9.]+)\s+([0-9.]+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      stat: match[3]!,
      cpu: Number(match[4]),
      mem: Number(match[5]),
      rss_kib: Number(match[6]),
      command: redactSecrets(match[7]!.trim()).slice(0, 400),
    });
  }
  return rows.sort((a, b) => b.cpu - a.cpu || b.rss_kib - a.rss_kib);
}

function captureTopStats(runtime: RuntimeInfo, space: SpaceEntry): TopStats | undefined {
  if (runtime.kind === "apple") {
    const r = exec("container", ["stats", "--no-stream", "--format", "json", space.container], 20_000);
    return r.code === 0 ? parseAppleStats(r.out) : undefined;
  }
  if (runtime.kind === "podman") {
    const r = runtimeExec(runtime, ["stats", "--no-stream", "--format", "json", space.container], 20_000);
    return r.code === 0 ? parsePodmanStats(r.out) : undefined;
  }
  const r = runtimeExec(runtime, ["stats", "--no-stream", "--format", "{{json .}}", space.container], 20_000);
  return r.code === 0 ? parseDockerStats(r.out.trim()) : undefined;
}

function captureTopProcesses(runtime: RuntimeInfo, space: SpaceEntry): TopProcess[] {
  const ps = ["ps", "-eo", "pid,ppid,stat,pcpu,pmem,rss,args"];
  const r = runtime.kind === "apple"
    ? exec("container", ["exec", space.container, ...ps], 20_000)
    : runtimeExec(runtime, ["exec", space.container, ...ps], 20_000);
  return r.code === 0 ? parseTopProcesses(r.out) : [];
}

function topBar(stats: TopStats | undefined): string {
  if (!stats) return dim("no stats yet");
  const parts: string[] = [];
  parts.push("cpu " + (stats.cpu_percent === undefined ? dim("-") : stats.cpu_percent.toFixed(1) + "%"));
  if (stats.memory_used_bytes !== undefined) {
    const limit = stats.memory_limit_bytes ? " / " + formatBytes(stats.memory_limit_bytes) : "";
    const pct = stats.memory_percent === undefined ? "" : " (" + stats.memory_percent.toFixed(1) + "%)";
    parts.push("mem " + formatBytes(stats.memory_used_bytes) + limit + pct);
  }
  if (stats.net_rx_bytes !== undefined || stats.net_tx_bytes !== undefined) {
    parts.push("net \u2193 " + formatBytes(stats.net_rx_bytes ?? 0) + " \u2191 " + formatBytes(stats.net_tx_bytes ?? 0));
  }
  if (stats.block_read_bytes !== undefined || stats.block_write_bytes !== undefined) {
    parts.push("io " + formatBytes(stats.block_read_bytes ?? 0) + "/" + formatBytes(stats.block_write_bytes ?? 0));
  }
  if (stats.pids !== undefined) parts.push("pids " + stats.pids);
  return parts.join("   ");
}

function renderTopFrame(
  name: string,
  space: SpaceEntry,
  runtime: RuntimeInfo,
  stats: TopStats | undefined,
  processes: TopProcess[],
  limit: number,
  interval: number,
  clear: boolean,
): string {
  const width = Math.min(Math.max(process.stdout.columns ?? 100, 60), 200);
  const lines: string[] = [];
  lines.push(clear ? "\x1b[2J\x1b[H" : "");
  lines.push(bold("prime spaces top ") + space.id + "  [" + runtime.kind + "]  " + name);
  if (space.local_url) lines.push(dim(space.local_url) + "   cgroup " + (space.cgroup_mode ?? "-"));
  lines.push(topBar(stats));
  lines.push("");
  lines.push(dim("  PID  PPID STAT   CPU%   MEM%      RSS COMMAND"));
  const rows = processes.slice(0, limit);
  for (const row of rows) {
    const prefix = " " + String(row.pid).padStart(5) + " " + String(row.ppid).padStart(5) + " " + row.stat.padEnd(4) +
      " " + row.cpu.toFixed(1).padStart(5) + " " + row.mem.toFixed(1).padStart(6) + " " + formatBytes(row.rss_kib * 1024).padStart(8) + " " ;
    const room = Math.max(10, width - prefix.length);
    const command = row.command.length > room ? row.command.slice(0, room - 1) + "\u2026" : row.command;
    lines.push(prefix + command);
  }
  if (rows.length === 0) lines.push(dim("  no process data (container may not expose ps)"));
  lines.push("");
  lines.push(dim("every " + interval + "s \u00b7 q to quit"));
  return lines.join("\n") + "\n";
}

export async function spacesTop(ctx: Ctx): Promise<void> {
  const name = requirePositional(ctx, "<name>", "prime spaces top <name>");
  const space = requireSpace(ctx.config, name);
  const runtime = await runtimeFor(space.runtime, bool(ctx.parsed, "allow-rootful"));
  const info = containerInfo(runtime, space.container);
  if (info.state !== "running") fail('space "' + name + '" is not running', "Start it with: prime spaces start " + name);
  const once = ctx.json || bool(ctx.parsed, "once") || !process.stdout.isTTY;
  const interval = Math.max(1, Math.round(num(ctx.parsed, "interval") ?? 2));
  const limit = Math.max(1, Math.round(num(ctx.parsed, "limit") ?? 15));
  let previous: { usec: number; at: number } | undefined;
  const sample = () => {
    const stats = captureTopStats(runtime, space);
    const processes = captureTopProcesses(runtime, space);
    const now = Date.now();
    if (stats?.cpu_usec !== undefined) {
      if (previous) {
        const seconds = (now - previous.at) / 1000;
        if (seconds > 0) stats.cpu_percent = Math.max(0, ((stats.cpu_usec - previous.usec) / 1e6 / seconds) * 100);
      }
      previous = { usec: stats.cpu_usec, at: now };
    }
    return { stats, processes };
  };
  if (once) {
    let snapshot = sample();
    if (runtime.kind === "apple" && snapshot.stats && snapshot.stats.cpu_percent === undefined) {
      await Bun.sleep(700);
      snapshot = sample();
    }
    if (ctx.json) {
      printJson({
        name,
        device: space.id,
        runtime: runtime.kind,
        url: space.local_url,
        cpus: space.cpus,
        memory: space.memory,
        cgroup_mode: space.cgroup_mode ?? null,
        stats: snapshot.stats ?? null,
        processes: snapshot.processes,
      });
      return;
    }
    process.stdout.write(renderTopFrame(name, space, runtime, snapshot.stats, snapshot.processes, limit, interval, false));
    return;
  }
  const tty = Boolean(process.stdout.isTTY);
  const stdin = process.stdin;
  let stopped = false;
  const onSignal = () => { stopped = true; };
  const onKey = (chunk: Buffer) => {
    if (chunk.includes(0x71) || chunk.includes(0x03)) stopped = true;
  };
  if (tty) process.stdout.write("\x1b[?1049h\x1b[?25l");
  try {
    if (tty && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onKey);
    }
    process.on("SIGINT", onSignal);
    while (!stopped) {
      const snapshot = sample();
      process.stdout.write(renderTopFrame(name, space, runtime, snapshot.stats, snapshot.processes, limit, interval, true));
      await Bun.sleep(interval * 1000);
    }
  } finally {
    process.off("SIGINT", onSignal);
    if (tty) {
      stdin.off("data", onKey);
      if (typeof stdin.setRawMode === "function") stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\x1b[?25h\x1b[?1049l");
    }
  }
}
export const SPACE_COMMANDS = ["create", "start", "stop", "delete", "list", "logs", "enter", "doctor", "top"] as const;
export type SpaceCommand = (typeof SPACE_COMMANDS)[number];

export function isSpaceCommand(value: string | undefined): value is SpaceCommand {
  return value !== undefined && (SPACE_COMMANDS as readonly string[]).includes(value);
}

export function parseSpaceMode(parsed: ParsedArgs): "persistent" | "ephemeral" {
  if (bool(parsed, "persistent")) return "persistent";
  if (bool(parsed, "ephemeral")) return "ephemeral";
  return "ephemeral";
}
