// A space's tool server is told which keys may call it, where to keep its state and where to journal its calls;
// the CLI that made the space is allowed to call it from the start.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCodeMcpArgs, toCodeMcpArgv } from "../src/code-mcp-options.ts";
import { callTarget, loadOrCreateCallerKey, readCallers, removeCaller, signCall } from "../src/caller-key.ts";
import { CallerAuth } from "../src/caller-auth.ts";
import type { Ctx } from "../src/context.ts";
import type { SpaceEntry } from "../src/config.ts";
import { refreshCommandAfterUpdate } from "../src/update.ts";
import { devicesAllowCaller, devicesCallers, devicesRevokeCaller } from "../src/devices.ts";
import { ENTRYPOINT_VERSION, containerArgs, ensureSpaceAuth, entrypointScript, mayMakeContainerAgain, spaceNeedsRefresh, spaceActivityFile, spaceCallersFile, spaceStateDir } from "../src/spaces.ts";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

let dir: string;
const saved: Record<string, string | undefined> = {};
const notes: string[] = [];
const ctx = { note: (text: string) => notes.push(text) } as unknown as Ctx;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prime-space-auth-"));
  for (const name of ["PRIME_CALLER_KEY", "PRIME_CALLERS"]) saved[name] = process.env[name];
  process.env.PRIME_CALLER_KEY = join(dir, "host-key.pem");
  notes.length = 0;
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

const space = (extra: Partial<SpaceEntry> = {}): SpaceEntry =>
  ({ id: "s1", runtime: "docker", image: "i", mode: "ephemeral", container: "c", token: "t", ...extra }) as unknown as SpaceEntry;

describe("the tool server of a space", () => {
  /** Run the entrypoint with a `prime` that lists the options it is given, and return the arguments it was started with. */
  function started(help: string, script: string): string[] {
    const root = mkdtempSync(join(tmpdir(), "prime-entry-"));
    try {
      const fake = join(root, "prime");
      const out = join(root, "args");
      writeFileSync(fake, `#!/bin/sh\nif [ "$2" = "--help" ]; then printf '%s\\n' ${JSON.stringify(help)}; exit 0; fi\nprintf '%s\\n' "$@" > ${out}\n`, { mode: 0o755 });
      writeFileSync(join(root, "token"), "tok\n");
      const patched = script.replaceAll("/usr/local/bin/prime", fake).replaceAll("/run/prime/token", join(root, "token")).replaceAll("/run/prime/gateway-token", join(root, "token"));
      const r = Bun.spawnSync(["/bin/sh", "-c", patched], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
      expect(r.exitCode).toBe(0);
      return readFileSync(out, "utf8").trim().split("\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const NEW_HELP = "--callers <file>  keys\n--caller-state <dir>  state\n--activity-log <file>  journal";

  test.skipIf(process.platform === "win32")("is started with the callers file, a state directory of its own and the journal", () => {
    for (const exposed of [false, true]) {
      const script = entrypointScript(space(exposed ? { expose: true, gateway: "https://gw.example.dev", gateway_device: "anon-1" } : {}));
      // The callers file is in the directory the space reads and cannot write; the state is in the one it can.
      expect(script).not.toContain("--callers /run/prime-state");
      const args = started(NEW_HELP, script);
      expect(args).toContain("--token");
      expect(args.slice(args.indexOf("--callers"), args.indexOf("--callers") + 2)).toEqual(["--callers", "/run/prime/callers.json"]);
      expect(args.slice(args.indexOf("--caller-state"), args.indexOf("--caller-state") + 2)).toEqual(["--caller-state", "/run/prime-state/caller-auth"]);
      expect(args.slice(args.indexOf("--activity-log"), args.indexOf("--activity-log") + 2)).toEqual(["--activity-log", "/run/prime-state/activity.jsonl"]);
      if (exposed) expect(args).toContain("--gateway");
    }
  });

  test.skipIf(process.platform === "win32")("an image whose prime does not know an option is not given it: a space on an old image starts as it did", () => {
    const script = entrypointScript(space());
    // before signed calls
    expect(started("--port <n>  port\n--token <s>  token", script)).not.toContain("--callers");
    // an image that has the callers file and the journal and not --caller-state (26.11.51): the callers file would keep its reply key
    // on a mount that cannot be written, so it is not given the callers file at all
    const mid = started("--callers <file>  keys\n--activity-log <file>  journal", script);
    expect(mid).not.toContain("--callers");
    expect(mid).not.toContain("--caller-state");
    expect(mid).toContain("--activity-log");
    // a prime that cannot print its help at all is started without them, not stopped
    expect(started("", script)).not.toContain("--callers");
  });

  test("gets the secret directory read-only and a state directory it can write", () => {
    const args = containerArgs({ kind: "docker", bin: "docker" }, space({ port: 1 } as Partial<SpaceEntry>), "img", join(dir, "spaces", "c"));
    expect(args).toContain(join(dir, "spaces", "c") + ":/run/prime:ro");
    const mount = args.find((a) => a.endsWith(":/run/prime-state"));
    expect(mount).toBe(spaceStateDir(join(dir, "spaces", "c")) + ":/run/prime-state");
    expect(mount).not.toContain(":ro");
  });
});

describe("a space's callers file", () => {
  test("allows this machine's caller key when it is made, and keeps its state private", () => {
    const secret = join(dir, "spaces", "c");
    mkdirSync(secret, { recursive: true });
    ensureSpaceAuth(ctx, secret);
    const callers = readCallers(spaceCallersFile(secret));
    expect(callers.map((c) => c.keyId)).toEqual([loadOrCreateCallerKey().keyId]);
    expect(callers[0]!.label).toBe("host");
    expect(existsSync(spaceStateDir(secret))).toBe(true);
    if (process.platform !== "win32") expect(statSync(spaceStateDir(secret)).mode & 0o077).toBe(0);
    expect(spaceActivityFile(secret)).toBe(join(spaceStateDir(secret), "activity.jsonl"));
  });

  test("is left alone when it is there: a key that was revoked stays revoked, and an added one stays", () => {
    const secret = join(dir, "spaces", "c");
    mkdirSync(secret, { recursive: true });
    ensureSpaceAuth(ctx, secret);
    const file = spaceCallersFile(secret);
    const before = readFileSync(file, "utf8");
    ensureSpaceAuth(ctx, secret);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(removeCaller(file, loadOrCreateCallerKey().keyId)).toBe(true);
    ensureSpaceAuth(ctx, secret);
    expect(readCallers(file)).toEqual([]);
  });

  test("a space in a fleet is not given this machine's key: the fleet's roster says who may call it", () => {
    const secret = join(dir, "spaces", "f");
    mkdirSync(secret, { recursive: true });
    ensureSpaceAuth(ctx, secret, { enrol: false });
    expect(existsSync(spaceCallersFile(secret))).toBe(false);
    expect(existsSync(spaceStateDir(secret))).toBe(true);
    // ... and a file that is not there means no callers, so the device warns until someone is allowed
    expect(readCallers(spaceCallersFile(secret))).toEqual([]);
  });

  test("a device that reads it takes the host's signature and nobody else's", () => {
    const secret = join(dir, "spaces", "c");
    mkdirSync(secret, { recursive: true });
    ensureSpaceAuth(ctx, secret);
    const auth = new CallerAuth({ deviceId: "anon-1", callersFile: spaceCallersFile(secret), stateDir: join(spaceStateDir(secret), "caller-auth") });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bash" } });
    const unsigned = auth.admit({ raw: body });
    expect(unsigned.action).toBe("refuse");
    const signed = auth.admit({ raw: body, callerSig: signCall(loadOrCreateCallerKey(), callTarget("device", "anon-1"), body) });
    expect(signed.action).toBe("run");
    const stranger = join(dir, "other.pem");
    const other = loadOrCreateCallerKey(stranger);
    const body2 = body.replace('"id":1', '"id":2');
    expect(auth.admit({ raw: body2, callerSig: signCall(other, callTarget("device", "anon-1"), body2) }).action).toBe("refuse");
  });
});

describe("--caller-state", () => {
  test("is a code-mcp option, in the config section and on the command line", () => {
    expect(parseCodeMcpArgs(["--caller-state", "/s/state"]).options).toEqual({ "caller-state": "/s/state" });
    expect(toCodeMcpArgv({ "caller-state": "/s/state" })).toEqual(["--caller-state", "/s/state"]);
  });

  test("is one the tool server itself accepts", () => {
    const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "index.ts"), "code-mcp", "--caller-state", "/s/state", "--help"], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("--caller-state <dir>");
  });
});

describe("prime devices allow-caller | callers | revoke-caller --space", () => {
  const out: string[] = [];
  const errs: string[] = [];
  const cmd = (sub: string, flags: Record<string, string | boolean>, positionals: string[] = []) =>
    ({
      config: { defaults: {}, devices: {}, spaces: { work: { id: "s1", runtime: "docker", image: "i", mode: "ephemeral", container: "c", token: "t", secret_dir: join(dir, "spaces", "c") } }, codeMcp: {} },
      configPath: join(dir, "config.yaml"),
      json: false,
      out: (l: string) => out.push(l),
      note: (l: string) => errs.push(l),
      parsed: { positionals: ["devices", sub, ...positionals], flags: new Map<string, string | boolean>(Object.entries(flags)), help: false },
    }) as unknown as Ctx;

  test("work on the file a space's device reads, and show the reply key it keeps in its state directory", async () => {
    const secret = join(dir, "spaces", "c");
    mkdirSync(secret, { recursive: true });
    const other = loadOrCreateCallerKey(join(dir, "other.pem"));
    out.length = 0;
    await devicesAllowCaller(cmd("allow-caller", { space: "work", label: "second" }, [other.publicKeyB64]));
    expect(readCallers(spaceCallersFile(secret)).map((c) => c.keyId)).toEqual([other.keyId]);
    // the device keeps its reply key in the state directory, not beside the callers file
    const reply = loadOrCreateCallerKey(join(spaceStateDir(secret), "caller-auth", "device-ed25519.pem"));
    errs.length = 0;
    await devicesCallers(cmd("callers", { space: "work" }));
    expect(errs.join("\n")).toContain(reply.keyId);
    await devicesRevokeCaller(cmd("revoke-caller", { space: "work" }, [other.keyId]));
    expect(readCallers(spaceCallersFile(secret))).toEqual([]);
  });

  test("a space that is not there, or has no callers file, or --space with --callers, is a usage error", async () => {
    await expect(devicesCallers(cmd("callers", { space: "nope" }))).rejects.toThrow('no space named "nope"');
    await expect(devicesCallers(cmd("callers", { space: "work", callers: "/x/callers.json" }))).rejects.toThrow("both name a callers file");
  });
});

describe("prime update moves a fleet's spaces with the build it has installed", () => {
  test("the container is made with the entrypoint's version, and a space made with another is moved though its image is the same", () => {
    const args = containerArgs({ kind: "podman" } as never, space({ port: 7777 }), "img", join(dir, "secret"));
    expect(args).toContain("prime.entrypoint=" + ENTRYPOINT_VERSION);
    expect(spaceNeedsRefresh(space({ image: "img" }), "img")).toBe(true); // made by a build that did not record one
    expect(spaceNeedsRefresh(space({ image: "img", entrypoint: ENTRYPOINT_VERSION - 1 }), "img")).toBe(true);
    expect(spaceNeedsRefresh(space({ image: "img", entrypoint: ENTRYPOINT_VERSION }), "img")).toBe(false);
    expect(spaceNeedsRefresh(space({ image: "old", entrypoint: ENTRYPOINT_VERSION }), "img")).toBe(true);
  });

  test("the command is the installed build's, never this process's own; a compiled binary installing a bundle runs it as bun", () => {
    const base = { target: "/usr/local/bin/prime", updated: true };
    expect(refreshCommandAfterUpdate({ ...base, kind: "binary" }, "/c/config.yaml", "/bin/bun")).toEqual({ argv: ["/usr/local/bin/prime", "spaces", "refresh-fleet", "--config", "/c/config.yaml"], env: {} });
    expect(refreshCommandAfterUpdate({ ...base, kind: "bundle", target: "/i/prime.js" }, "/c/config.yaml", "/bin/bun")).toEqual({ argv: ["/bin/bun", "/i/prime.js", "spaces", "refresh-fleet", "--config", "/c/config.yaml"], env: {} });
    // a compiled binary (process.execPath is prime itself) that installs a .js: it is asked to be bun
    expect(refreshCommandAfterUpdate({ ...base, kind: "binary", target: "/t/prime.js" }, "/c/config.yaml", "/opt/prime", { compiled: true })).toEqual({
      argv: ["/opt/prime", "/t/prime.js", "spaces", "refresh-fleet", "--config", "/c/config.yaml"],
      env: { BUN_BE_BUN: "1" },
    });
    // the flags that decide how a space is run are passed on
    expect(refreshCommandAfterUpdate({ ...base, kind: "binary" }, "/c/config.yaml", "/bin/bun", { flags: ["--allow-rootful", "--allow-no-limits"] })?.argv).toEqual(["/usr/local/bin/prime", "spaces", "refresh-fleet", "--config", "/c/config.yaml", "--allow-rootful", "--allow-no-limits"]);
    expect(refreshCommandAfterUpdate({ ...base, kind: "source" }, "/c/config.yaml", "/bin/bun")).toBeUndefined();
    expect(refreshCommandAfterUpdate({ ...base, kind: "binary", updated: false }, "/c/config.yaml", "/bin/bun")).toBeUndefined();
  });

  test("a persistent space of a fleet is made again when its container was removed to move it; any other persistent space is not", () => {
    expect(mayMakeContainerAgain({ mode: "persistent", fleet: "acme" }, true)).toBe(true);
    expect(mayMakeContainerAgain({ mode: "persistent", fleet: "acme" }, false)).toBe(false); // a container that went missing by itself
    expect(mayMakeContainerAgain({ mode: "persistent" }, true)).toBe(false);
    expect(mayMakeContainerAgain({ mode: "ephemeral" }, false)).toBe(true);
  });

  test("'prime spaces refresh-fleet' is a command of the build, and with no fleet space it has nothing to do", () => {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    const cfg = join(dir, "config.yaml");
    writeFileSync(cfg, "spaces: {}\n");
    const r = Bun.spawnSync(["bun", fileURLToPath(new URL("../src/index.ts", import.meta.url)), "spaces", "refresh-fleet", "--config", cfg], { cwd: dir, env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 30_000, stdout: "pipe", stderr: "pipe" });
    expect(r.stderr.toString()).not.toContain("unknown");
    expect(r.exitCode).toBe(0);
  });
});

describe("a space in a fleet is not persistent", () => {
  test("prime spaces create --fleet --persistent is refused before anything is made", async () => {
    const { spacesCreate } = await import("../src/spaces.ts");
    const parsed = { flags: new Map<string, unknown>([["fleet", "acme"], ["persistent", true]]), positionals: [] } as never;
    const ctx = { parsed, config: { defaults: {}, devices: {}, spaces: {}, codeMcp: {} }, note: () => undefined, out: () => undefined } as unknown as Ctx;
    await expect(spacesCreate(ctx, "26.11.0")).rejects.toThrow("not persistent");
  });
});

describe("what a person allowed when they started a space", () => {
  const cfgWith = (extra: string) => {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    const cfg = join(dir, "config.yaml");
    writeFileSync(cfg, "devices: {}\nspaces:\n  work:\n    id: space-1\n    runtime: docker\n    image: img\n    mode: ephemeral\n    container: prime-space-1\n    token: t\n" + extra);
    return { cfg, home };
  };
  const run = (args: string[], cfg: string, home: string) =>
    Bun.spawnSync(["bun", fileURLToPath(new URL("../src/index.ts", import.meta.url)), ...args, "--config", cfg], { cwd: dir, env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 30_000, stdout: "pipe", stderr: "pipe" });

  test("'prime spaces show' says what is recorded, and no secret", () => {
    const { cfg, home } = cfgWith("    allow_rootful: true\n");
    const r = run(["spaces", "show", "work", "--json"], cfg, home);
    expect(r.exitCode).toBe(0);
    const shown = JSON.parse(r.stdout.toString());
    expect(shown).toMatchObject({ name: "work", allow_rootful: true, allow_no_limits: false });
    expect(r.stdout.toString()).not.toContain('"token"');
  });

  test("a start that a person makes takes back what was recorded; only the start `prime update` makes repeats it", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/spaces.ts", import.meta.url)), "utf8");
    // the unattended start (the refresh) is the only one that reads what is recorded without the flags
    expect(src).toContain("{ recreate: true, unattended: true }");
    expect(src).toContain('space.allow_rootful = bool(ctx.parsed, "allow-rootful") ? true : undefined;');
    expect(src.match(/unattended: true/g) ?? []).toHaveLength(1);
  });
});
