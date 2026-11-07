// "prime spaces ..." - disposable or persistent Linux codespaces that run the
// bundled device buddy (no gateway) and register themselves as local devices.
//
// Every space is a rootless container: Apple's container CLI on macOS (one
// micro-VM per space, so root inside is not root on the host) or rootless podman
// on Linux. The MCP server binds inside the container; the host reaches it over
// the runtime's private network (Apple vmnet address) or a loopback publish
// (podman/docker). The space's token is the only credential and is generated per
// space.

import { bool, num, str, type ParsedArgs } from "./args.ts";
import { saveConfig, type Config, type SpaceEntry } from "./config.ts";
import type { Ctx } from "./context.ts";
import { CliError, UsageError } from "./errors.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bold, dim, green, printJson, red, table, yellow } from "./output.ts";

const SPACE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONTAINER_PORT = 7777;
const READY_TIMEOUT_MS = 90_000;

export type RuntimeKind = "apple" | "podman" | "docker";

interface RuntimeInfo {
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
  const r = exec("podman", ["info", "--format", "json"], 20_000);
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
  const dir = process.env.XDG_RUNTIME_DIR;
  if (dir && existsSync(join(dir, "bus"))) return true;
  return exec("systemctl", ["--user", "show-environment"], 5_000).code === 0;
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
  if (runtime.kind === "apple") return exec(runtime.bin, ["image", "inspect", image], 20_000).code === 0;
  if (runtime.kind === "podman") return exec(runtime.bin, ["image", "exists", image], 20_000).code === 0;
  return exec(runtime.bin, ["image", "inspect", image], 20_000).code === 0;
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
  const r = exec(runtime.bin, ["inspect", "--format", "{{.State.Status}}", container], 30_000);
  if (r.code !== 0) return { state: "missing" };
  const status = r.out.trim();
  return { state: status === "running" ? "running" : "stopped" };
}

function containerInfo(runtime: RuntimeInfo, container: string): ContainerInfo {
  return runtime.kind === "apple" ? appleInfo(container) : podmanLikeInfo(runtime, container);
}

/** Run the container with its token in a 0600 env file, so it never appears in
 *  the host process list (the file is removed right after the runtime reads it). */
/** Force podman's OCI runtime to crun for this invocation (NoCgroups needs it).
 *  podman has dropped the per-container --runtime flag, so this uses the config
 *  override podman documents for exactly this purpose. */
function crunEnv(dir: string): Record<string, string> {
  const file = join(dir, "containers.conf");
  writeFileSync(file, "[engine]\nruntime = \"crun\"\n", { mode: 0o600 });
  return { ...process.env, CONTAINERS_CONF_OVERRIDE: file };
}

function runContainer(
  runtime: RuntimeInfo,
  space: SpaceEntry,
  image: string,
  note: (text: string) => void,
): { code: number; out: string; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "prime-space-"));
  const envFile = join(dir, "env");
  try {
    writeFileSync(envFile, "PRIME_SPACE_TOKEN=" + space.token + "\n", { mode: 0o600 });
    if (runtime.kind !== "podman") {
      return exec(runtime.bin, containerArgs(runtime, space, image, envFile), 300_000);
    }
    // Rootless podman wants a user systemd for cgroup handling. WSL2 often has
    // none: try the default, then cgroupfs, then disabled cgroups (no limits).
    // NOTE: --cgroups is a "run" flag, so it must follow the subcommand; only
    // --cgroup-manager is a global flag.
    const systemd = hasUserSystemd();
    const crun = hasCrun();
    const attempts: Array<{ globals: string[]; flags: string[]; limits: boolean; crun?: boolean }> = [];
    if (!systemd) attempts.push({ globals: ["--cgroup-manager=cgroupfs"], flags: [], limits: true });
    attempts.push({ globals: [], flags: [], limits: true });
    // NoCgroups only works with crun; runc rejects it ("not compatible with
    // NoCgroups") and podman has no per-container --runtime flag any more, so
    // the runtime is forced through a config override. Without crun, the real
    // fix is enabling systemd in WSL.
    if (crun) attempts.push({ globals: [], flags: ["--cgroups=disabled"], limits: false, crun: true });
    const seen = new Set<string>();
    let warnedLimits = false;
    let last = { code: 1, out: "", err: "" };
    for (const attempt of attempts) {
      const key = JSON.stringify([attempt.globals, attempt.flags, attempt.limits]);
      if (seen.has(key)) continue;
      seen.add(key);
      // containerArgs already starts with "run": globals go before it, the
      // run-only flags (--cgroups) right after it.
      const base = containerArgs(runtime, space, image, envFile, attempt.limits);
      const env = attempt.crun ? crunEnv(dir) : undefined;
      last = exec(runtime.bin, [...attempt.globals, base[0]!, ...attempt.flags, ...base.slice(1)], 300_000, env);
      if (last.code === 0) return last;
      exec(runtime.bin, ["rm", "-f", space.container], 60_000);
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
  const r = exec(runtime.bin, args, 60_000);
  if (r.code !== 0 && !/already exists/i.test(r.err)) fail("cannot create volume " + name, r.err.slice(0, 300));
}

function volumeDelete(runtime: RuntimeInfo, name: string): void {
  const args = runtime.kind === "apple" ? ["volume", "delete", name] : ["volume", "rm", "-f", name];
  exec(runtime.bin, args, 60_000);
}

function networkCreate(runtime: RuntimeInfo, name: string, internal: boolean): void {
  if (runtime.kind === "apple") return;
  const args = ["network", "create"];
  if (internal) args.push("--internal");
  args.push(name);
  const r = exec(runtime.bin, args, 60_000);
  if (r.code !== 0 && !/already exists/i.test(r.err)) fail("cannot create the space network", r.err.slice(0, 300));
}

function networkDelete(runtime: RuntimeInfo, name: string | undefined): void {
  if (runtime.kind === "apple" || !name || name === "none") return;
  exec(runtime.bin, ["network", "rm", name], 60_000);
}

function containerArgs(runtime: RuntimeInfo, space: SpaceEntry, image: string, envFile: string, limits = true): string[] {
  const args: string[] = ["run", "-d", "--name", space.container, "--label", "prime.space=" + space.id];
  args.push("--env-file", envFile);
  if (runtime.kind === "apple") {
    args.push("-c", String(space.cpus ?? 2), "-m", space.memory ?? "4g");
    if (space.volume) args.push("-v", space.volume + ":/root/work");
    return args.concat([image]);
  }
  args.push("--network", space.offline ? "none" : space.network ?? "", "--publish", "127.0.0.1:" + space.port + ":" + CONTAINER_PORT);
  if (limits) args.push("--cpus", String(space.cpus ?? 2), "--memory", space.memory ?? "4g");
  args.push(...(limits ? ["--pids-limit", "512"] : []), "--security-opt", "no-new-privileges");
  if (space.volume) args.push("-v", space.volume + ":/root/work");
  return args.concat([image]);
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

export async function spacesCreate(ctx: Ctx, version: string): Promise<void> {
  const name = str(ctx.parsed, "name") ?? newSpaceId();
  assertSpaceName(name);
  if (ctx.config.spaces[name]) {
    throw new UsageError('a space named "' + name + '" already exists', "Use --name with another name, or 'prime spaces delete " + name + "'.");
  }
  const persistent = bool(ctx.parsed, "persistent");
  if (persistent && bool(ctx.parsed, "ephemeral")) throw new UsageError("--persistent and --ephemeral contradict each other");
  const offline = bool(ctx.parsed, "offline");
  const runtime = await detectRuntime(str(ctx.parsed, "runtime"), bool(ctx.parsed, "allow-rootful"));
  if (offline && runtime.kind === "apple") {
    throw new UsageError("--offline is not supported with Apple containers", "Apple vmnet always has NAT; use podman/docker for an offline space.");
  }
  const image = str(ctx.parsed, "image") ?? defaultImage(version);
  const cpus = num(ctx.parsed, "cpus") ?? 2;
  const memory = str(ctx.parsed, "memory") ?? "4g";
  if (cpus <= 0) throw new UsageError("--cpus must be a positive number");
  if (!/^[0-9]+(\.[0-9]+)?[kmgt]?$/i.test(memory)) throw new UsageError("--memory must look like 512m, 4g or 2048m");
  const id = newSpaceId();
  const token = newToken();
  const port = runtime.kind === "apple" ? CONTAINER_PORT : await freePort();
  const container = "prime-space-" + id.slice("space-".length);
  const volume = persistent ? container + "-work" : undefined;
  const network = runtime.kind === "apple" ? undefined : (offline ? "none" : container + "-net");
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
    created_at: new Date().toISOString(),
  };

  await ensureImage(runtime, image, (text) => ctx.note(text));
  if (volume) volumeCreate(runtime, volume);
  if (network && network !== "none") networkCreate(runtime, network, offline);
  const started = Date.now();
  const run = runContainer(runtime, space, image, (text) => ctx.note(text));
  if (run.code !== 0) {
    if (volume) volumeDelete(runtime, volume);
    networkDelete(runtime, network);
    fail("cannot start the space container", ((run.err || run.out).slice(0, 400) + (runtime.kind === "podman" ? "\n" + (podmanFailureHint() ?? "") : "")).trim() || undefined);
  }
  let url: string | undefined;
  try {
    url = requireRunningAddress(runtime, space);
    if (!url) fail("the space container started but has no address yet");
    await waitReady(url, token, ctx.quiet);
  } catch (err) {
    exec(runtime.bin, ["rm", "-f", container], 120_000);
    if (volume) volumeDelete(runtime, volume);
    networkDelete(runtime, network);
    throw err;
  }
  space.local_url = url;
  const bootMs = Date.now() - started;
  registerDevice(ctx.config, name, space, url);
  ctx.config.spaces[name] = space;
  saveConfig(ctx.configPath, ctx.config);
  if (ctx.json) {
    printJson({ created: true, name, space, device: space.id, url, boot_ms: bootMs, config_path: ctx.configPath });
    return;
  }
  ctx.out(green("\u2713") + " created space " + bold(name) + " (" + space.mode + ", " + runtime.kind + ")");
  ctx.out("  device    " + space.id);
  ctx.out("  url       " + url);
  ctx.out("  image     " + image);
  ctx.out("  limits    " + cpus + " cpu, " + memory + (offline ? ", offline" : ""));
  ctx.out("  boot      " + (bootMs / 1000).toFixed(1) + "s");
  ctx.out("  try       " + dim("prime tools call " + space.id + ".bash '{\"cwd\":\"/root/work\",\"command\":\"uname -a\"}'"));
}

export async function spacesStart(ctx: Ctx): Promise<void> {
  const name = requirePositional(ctx, "<name>", "prime spaces start <name>");
  const space = requireSpace(ctx.config, name);
  const runtime = await runtimeFor(space.runtime, bool(ctx.parsed, "allow-rootful"));
  await ensureImage(runtime, space.image, (text) => ctx.note(text));
  const existing = containerInfo(runtime, space.container);
  const started = Date.now();
  if (existing.state === "missing") {
    if (space.mode === "persistent") {
      fail('the persistent container for space "' + name + '" is gone', "Its volume still exists. Delete the space and create it again to start over.");
    }
    const run = runContainer(runtime, space, space.image, (text) => ctx.note(text));
    if (run.code !== 0) fail("cannot start the space container", ((run.err || run.out).slice(0, 400) + (runtime.kind === "podman" ? "\n" + (podmanFailureHint() ?? "") : "")).trim() || undefined);
  } else if (existing.state === "stopped") {
    const globalFlags = runtime.kind === "podman" && !hasUserSystemd() ? ["--cgroup-manager=cgroupfs"] : [];
    let start = exec(runtime.bin, [...globalFlags, "start", space.container], 120_000);
    if (start.code !== 0 && runtime.kind === "podman" && isPodmanCgroupFailure(start.err + start.out)) {
      start = exec(runtime.bin, ["--cgroup-manager=cgroupfs", "start", space.container], 120_000);
    }
    if (start.code !== 0 && runtime.kind === "podman" && hasCrun()) {
      const dir = mkdtempSync(join(tmpdir(), "prime-space-"));
      try {
        start = exec(runtime.bin, ["start", space.container], 120_000, crunEnv(dir));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    if (start.code !== 0) fail("cannot start the space", ((start.err || start.out).slice(0, 400) + "\n" + (podmanFailureHint() ?? "")).trim());
  }
  const url = requireRunningAddress(runtime, space);
  if (!url) fail("the space container is running but has no address yet");
  await waitReady(url, space.token, ctx.quiet);
  space.local_url = url;
  registerDevice(ctx.config, name, space, url);
  saveConfig(ctx.configPath, ctx.config);
  if (ctx.json) {
    printJson({ started: true, name, space, url, boot_ms: Date.now() - started });
    return;
  }
  ctx.out(green("\u2713") + " started space " + bold(name) + " (" + ((Date.now() - started) / 1000).toFixed(1) + "s)");
  ctx.out("  url       " + url);
}

export async function spacesStop(ctx: Ctx): Promise<void> {
  const name = requirePositional(ctx, "<name>", "prime spaces stop <name>");
  const space = requireSpace(ctx.config, name);
  const runtime = await runtimeFor(space.runtime, bool(ctx.parsed, "allow-rootful"));
  const info = containerInfo(runtime, space.container);
  let wiped = false;
  if (info.state !== "missing") {
    exec(runtime.bin, ["stop", space.container], 120_000);
    if (space.mode === "ephemeral") {
      exec(runtime.bin, ["rm", "-f", space.container], 120_000);
      if (space.volume) volumeDelete(runtime, space.volume);
      wiped = true;
    }
  }
  space.local_url = undefined;
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
  const runtime = await runtimeFor(space.runtime, bool(ctx.parsed, "allow-rootful"));
  exec(runtime.bin, ["stop", space.container], 120_000);
  exec(runtime.bin, ["rm", "-f", space.container], 120_000);
  if (space.volume) volumeDelete(runtime, space.volume);
  networkDelete(runtime, space.network);
  delete ctx.config.spaces[name];
  delete ctx.config.devices[space.id];
  saveConfig(ctx.configPath, ctx.config);
  if (ctx.json) {
    printJson({ deleted: true, name, device: space.id });
    return;
  }
  ctx.out(green("\u2713") + " deleted space " + bold(name));
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
    row.space.image,
  ]);
  ctx.out(table(["NAME", "MODE", "STATUS", "DEVICE", "URL", "IMAGE"], tableRows));
  const running = rows.filter((r) => r.state === "running").length;
  ctx.note(dim(running + "/" + rows.length + " running" + (runtimeError ? " (runtime: " + runtimeError + ")" : "")));
}

export async function spacesLogs(ctx: Ctx): Promise<void> {
  const name = requirePositional(ctx, "<name>", "prime spaces logs <name>");
  const space = requireSpace(ctx.config, name);
  const runtime = await runtimeFor(space.runtime, bool(ctx.parsed, "allow-rootful"));
  const r = exec(runtime.bin, ["logs", space.container], 60_000);
  if (r.code !== 0) fail("cannot read the space logs", (r.err || r.out).slice(0, 300));
  process.stdout.write(r.out);
}

export const SPACE_COMMANDS = ["create", "start", "stop", "delete", "list", "logs"] as const;
export type SpaceCommand = (typeof SPACE_COMMANDS)[number];

export function isSpaceCommand(value: string | undefined): value is SpaceCommand {
  return value !== undefined && (SPACE_COMMANDS as readonly string[]).includes(value);
}

export function parseSpaceMode(parsed: ParsedArgs): "persistent" | "ephemeral" {
  if (bool(parsed, "persistent")) return "persistent";
  if (bool(parsed, "ephemeral")) return "ephemeral";
  return "ephemeral";
}
