// A space's tool server is told which keys may call it, where to keep its state and where to journal its calls;
// the CLI that made the space is allowed to call it from the start.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCodeMcpArgs, toCodeMcpArgv } from "../src/code-mcp-options.ts";
import { callTarget, loadOrCreateCallerKey, readCallers, removeCaller, signCall } from "../src/caller-key.ts";
import { CallerAuth } from "../src/caller-auth.ts";
import type { Ctx } from "../src/context.ts";
import type { SpaceEntry } from "../src/config.ts";
import { containerArgs, ensureSpaceAuth, entrypointScript, spaceActivityFile, spaceCallersFile, spaceStateDir } from "../src/spaces.ts";
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
    // with the callers file and the journal, before --caller-state
    const mid = started("--callers <file>  keys\n--activity-log <file>  journal", script);
    expect(mid).toContain("--callers");
    expect(mid).toContain("--activity-log");
    expect(mid).not.toContain("--caller-state");
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

  test("a device that reads it takes the host's signature and nobody else's", () => {
    const secret = join(dir, "spaces", "c");
    mkdirSync(secret, { recursive: true });
    ensureSpaceAuth(ctx, secret);
    const auth = new CallerAuth({ mode: "enforce", deviceId: "anon-1", callersFile: spaceCallersFile(secret), stateDir: join(spaceStateDir(secret), "caller-auth") });
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
