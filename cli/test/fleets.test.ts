import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LockBusyError } from "../src/dir-lock";
import { keyFingerprintOf, keyIdOf } from "../src/fleet-crypto";
import { bootstrap, fleetKeyFile, fleetStateDir, fleetsJoin, memberRows, readFleetState, resolveFleetTarget, updateFleetState, writeFleetState } from "../src/fleets";
import type { Config } from "../src/config";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

function config(over: Partial<Config> = {}): Config {
  return {
    defaults: {},
    devices: {},
    spaces: {},
    codeMcp: {},
    ...over,
  };
}

describe("choosing which gateway a fleet command talks to", () => {
  test("a flag wins over everything else", () => {
    const c = config({
      defaults: { gateway: "https://default.example", gateway_token: "gateway-token", fleet_operator_token: "from-defaults" },
      devices: { one: { gateway: "https://from-device.example", token: "device-token" } },
    });
    const t = resolveFleetTarget(c, { gateway: "https://from-flag.example", operatorToken: "from-flag", device: "other", token: "flag-token" });
    expect(t.gateway).toBe("https://from-flag.example");
    expect(t.operatorToken).toBe("from-flag");
    expect(t.device).toBe("other");
    expect(t.deviceToken).toBe("flag-token");
  });

  test("a device picked from the config brings its token with it", () => {
    const c = config({
      devices: { "anon-one": { gateway: "https://one.example", token: "one-token" } },
    });
    // No space named, so the first configured device speaks for the fleet -
    // and its credential has to come with it.
    const t = resolveFleetTarget(c, {});
    expect(t.device).toBe("anon-one");
    expect(t.deviceToken).toBe("one-token");
  });

  test("a space supplies the credentials of its gateway identity", () => {
    const c = config({
      spaces: {
        work: {
          id: "space-local-id",
          runtime: "apple",
          image: "img",
          mode: "ephemeral",
          container: "prime-space-x",
          token: "local-mcp-token",
          gateway: "https://space.example",
          gateway_device: "anon-space",
          remote_token: "space-gateway-token",
        },
      },
    });
    const t = resolveFleetTarget(c, {}, "work");
    expect(t.gateway).toBe("https://space.example");
    expect(t.device).toBe("anon-space");
    expect(t.deviceToken).toBe("space-gateway-token");
  });

  test("the environment is used when nothing is stored", () => {
    const c = config();
    const t = resolveFleetTarget(c, {}, undefined, { PRIME_GATEWAY_URL: "https://env.example", PRIME_FLEET_OPERATOR_TOKEN: "env-token" });
    expect(t.gateway).toBe("https://env.example");
    expect(t.operatorToken).toBe("env-token");
  });

  test("the gateway token is not the operator's credential: it is not picked up from the flag, the environment, the defaults or a space", () => {
    const c = config({
      defaults: { gateway: "https://g.example", gateway_token: "defaults-gateway-token" },
      spaces: {
        work: { id: "s", runtime: "apple", image: "img", mode: "ephemeral", container: "c", token: "t", gateway: "https://g.example", gateway_device: "anon-space", remote_token: "r", gateway_token: "space-gateway-token" },
      },
    });
    const t = resolveFleetTarget(c, {}, "work", { PRIME_GATEWAY_TOKEN: "env-gateway-token" });
    expect(t.operatorToken).toBeUndefined();
  });

  test("the operator's credential from the environment or the config is not sent to another gateway than this machine's own", () => {
    const c = config({
      defaults: { gateway: "https://own.example", fleet_operator_token: "operator-token" },
      spaces: {
        elsewhere: { id: "s", runtime: "apple", image: "img", mode: "ephemeral", container: "c", token: "t", gateway: "https://other.example", gateway_device: "anon-x", remote_token: "r" },
        here: { id: "s2", runtime: "apple", image: "img", mode: "ephemeral", container: "c2", token: "t", gateway: "https://own.example/", gateway_device: "anon-y", remote_token: "r" },
      },
    });
    expect(resolveFleetTarget(c, {}, "here").operatorToken).toBe("operator-token");
    expect(resolveFleetTarget(c, {}, "elsewhere").operatorToken).toBeUndefined();
    expect(resolveFleetTarget(c, {}, "elsewhere", { PRIME_FLEET_OPERATOR_TOKEN: "env-token" }).operatorToken).toBeUndefined();
    // On the command line it goes where the command goes.
    expect(resolveFleetTarget(c, { operatorToken: "flag-token" }, "elsewhere").operatorToken).toBe("flag-token");
  });

  test("the operator's credential is sent to the gateway as the bearer token, and nothing else is", async () => {
    const { fleetsMembers } = await import("../src/fleets");
    const seen: Array<Headers> = [];
    const real = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(new Headers(init.headers));
      return Response.json({ ok: true, members: [] });
    };
    try {
      const ctx = (parsed: Record<string, string>) =>
        ({ config: config({ defaults: { gateway: "https://g.example", gateway_token: "gateway-token", fleet_operator_token: "operator-token" } }), configPath: "/nowhere", json: true, out: () => undefined, parsed: { positionals: ["fleets", "members", "acme"], flags: new Map(Object.entries(parsed)) } }) as never;
      await fleetsMembers(ctx({ device: "dev-1", token: "device-token" }));
      expect(seen[0]!.get("authorization")).toBe("Bearer operator-token");
      expect(seen[0]!.get("x-device-token")).toBe("device-token");
      for (const value of seen[0]!.values()) expect(value).not.toContain("gateway-token");
    } finally {
      (globalThis as { fetch: unknown }).fetch = real;
    }
  });

  test("approving a new key sends its fingerprint, and declining one asks to keep the member", async () => {
    const { fleetsApprove, fleetsRemove } = await import("../src/fleets");
    const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
    const real = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async (url: string, init: { body: string }) => {
      sent.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
      return Response.json({ ok: true, removed: "dev-2" });
    };
    const out: string[] = [];
    try {
      const ctx = (sub: string, flags: Record<string, string | boolean>) =>
        ({ config: config({ defaults: { gateway: "https://g.example", fleet_operator_token: "op" } }), configPath: "/nowhere", json: false, out: (l: string) => out.push(l), parsed: { positionals: ["fleets", sub, "acme"], flags: new Map<string, string | boolean>(Object.entries(flags)) } }) as never;
      await fleetsApprove(ctx("approve", { member: "dev-2", key: "AbCdEf012345" }));
      expect(sent[0]).toEqual({ path: "/fleets/acme/approve", body: { deviceId: "dev-2", key: "AbCdEf012345" } });
      await fleetsRemove(ctx("remove", { member: "dev-2", "key-change": true }));
      expect(sent[1]).toEqual({ path: "/fleets/acme/remove", body: { deviceId: "dev-2", keyChange: true } });
      expect(out.join("\n")).toContain("declined the new key of");
      expect(out.join("\n")).not.toContain("removed");
      await fleetsRemove(ctx("remove", { member: "dev-2" }));
      expect(sent[2]!.body).toEqual({ deviceId: "dev-2" });
    } finally {
      (globalThis as { fetch: unknown }).fetch = real;
    }
  });

  test("the gateway origin never keeps a trailing slash", () => {
    const t = resolveFleetTarget(config(), { gateway: "https://slash.example/" });
    expect(t.gateway).toBe("https://slash.example");
  });
});

describe("the member's state, written by the agent and by `prime fleets sync`", () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-state-"));
    return { root, config: join(root, "config.yaml") };
  };

  test("a writer holding an older copy does not take the positions back", () => {
    const { root, config } = setup();
    try {
      writeFleetState(config, "f", "s", { seq: 5, base: "b5", tree: "t5", fetchedSeq: 5, fetchedCommit: "b5", fetchedTree: "t5" });
      // The agent has fetched 9 and written 7 to the work tree since `sync` read the state at 5.
      writeFleetState(config, "f", "s", { seq: 7, base: "b7", tree: "t7", fetchedSeq: 9, fetchedCommit: "b9", fetchedTree: "t9" });
      // `sync` was working with its copy from 5 and now records 6.
      writeFleetState(config, "f", "s", { seq: 6, base: "b6", tree: "t6", fetchedSeq: 6, fetchedCommit: "b6", fetchedTree: "t6" });
      expect(readFleetState(config, "f", "s")).toEqual({ seq: 7, base: "b7", tree: "t7", fetchedSeq: 9, fetchedCommit: "b9", fetchedTree: "t9" });
      // Forward is forward.
      writeFleetState(config, "f", "s", { seq: 9, base: "b9", tree: "t9", fetchedSeq: 9, fetchedCommit: "b9", fetchedTree: "t9" });
      expect(readFleetState(config, "f", "s").seq).toBe(9);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a new start replaces it, and a store that lost what it fetched may rewind on purpose", () => {
    const { root, config } = setup();
    try {
      writeFleetState(config, "f", "s", { seq: 40, base: "old", fetchedSeq: 41, fetchedCommit: "oldf" });
      writeFleetState(config, "f", "s", { seq: 2, base: "new" }, { replace: true });
      expect(readFleetState(config, "f", "s")).toEqual({ seq: 2, base: "new" });
      writeFleetState(config, "f", "s", { seq: 2, base: "b2", fetchedSeq: 9, fetchedCommit: "b9" });
      // Without `rewind` a patch cannot go back.
      updateFleetState(config, "f", "s", { fetchedSeq: 4, fetchedCommit: "b4" });
      expect(readFleetState(config, "f", "s")).toMatchObject({ seq: 2, fetchedSeq: 9, fetchedCommit: "b9" });
      updateFleetState(config, "f", "s", { fetchedSeq: 4, fetchedCommit: "b4" }, { rewind: true });
      expect(readFleetState(config, "f", "s")).toMatchObject({ seq: 2, fetchedSeq: 4, fetchedCommit: "b4" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writers in several processes at once end with the highest of what they wrote", async () => {
    const { root, config } = setup();
    try {
      const script =
        // The module is named by a JSON string, so that a Windows path's backslashes are not read as escapes.
        "import { updateFleetState } from " + JSON.stringify(join(import.meta.dir, "../src/fleets.ts")) + ";" +
        "import { LockBusyError } from " + JSON.stringify(join(import.meta.dir, "../src/dir-lock.ts")) + ";" +
        // A writer that cannot get the lock in the time it is given is tried again at the next round (see `withStateLock`):
        // here the next try is the same write again. Six processes that do nothing else take turns at a lock that
        // each hand-over costs tens of milliseconds on a slow file system, and one of them can be kept waiting for a
        // couple of seconds. Anything that is not a busy lock (a refusal that reached the caller) is a failure.
        "const i = Number(process.argv[1]); for (let k = 0; k < 15; k++) { for (let tries = 0; ; tries++) { try { updateFleetState(process.argv[2], 'f', 's', { fetchedSeq: i * 100 + k, fetchedCommit: 'c' + (i * 100 + k) }); break; } catch (e) { if (!(e instanceof LockBusyError) || tries >= 10) throw e; } } }";
      const children = [1, 2, 3, 4, 5, 6].map((i) => Bun.spawn([process.execPath, "-e", script, String(i), config], { env: process.env, stdout: "ignore", stderr: "pipe" }));
      // A writer that fails says why: what it printed is shown with its exit code.
      for (const c of children) {
        const [code, said] = await Promise.all([c.exited, new Response(c.stderr).text()]);
        expect({ code, said }).toEqual({ code: 0, said: "" });
      }
      const state = readFleetState(config, "f", "s");
      expect(state.fetchedSeq).toBe(614);
      expect(state.fetchedCommit).toBe("c614");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the roster as printed", () => {
  test("shows a fingerprint of each member's key, which changes when the key is swapped", () => {
    const at = Date.UTC(2025, 0, 1);
    const a = memberRows([{ deviceId: "d1", role: "owner", addedAt: at, pubkey: Buffer.alloc(32, 1).toString("base64") }]);
    const b = memberRows([{ deviceId: "d1", role: "owner", addedAt: at, pubkey: Buffer.alloc(32, 2).toString("base64") }]);
    // 128 bits: two halves of eleven characters, padding left off, joined by a dot.
    expect(a[0]![2]).toMatch(/^[A-Za-z0-9+/]{11}\.[A-Za-z0-9+/]{11}$/);
    expect(a[0]![2]).not.toBe(b[0]![2]);
    expect(memberRows([{ deviceId: "d2", role: "member", addedAt: at }])[0]![2]).toBe("-");
  });
});

describe("the fingerprint a person compares", () => {
  const key = (n: number) => Buffer.alloc(32, n).toString("base64");

  test("is 128 bits of the key's hash, and its first half is what builds before it printed", () => {
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const k = key(7);
    const digest = createHash("sha256").update(Buffer.from(k, "base64")).digest();
    const fp = keyFingerprintOf(k);
    const [head, tail] = fp.split(".") as [string, string];
    expect(Buffer.from(head + "=", "base64").equals(digest.subarray(0, 8))).toBe(true);
    expect(Buffer.from(tail + "=", "base64").equals(digest.subarray(8, 16))).toBe(true);
    // The earlier print, without its padding, is the first half.
    expect(head).toBe(keyIdOf(k).replace(/=+$/, ""));
  });

  test("the id a snapshot's wrapped key carries is unchanged, so members of every build still match on it", () => {
    expect(keyIdOf(key(1))).toMatch(/^[A-Za-z0-9+/]{11}=$/);
  });

  test("two keys differ in both halves, and the same key prints the same", () => {
    const a = keyFingerprintOf(key(1)).split(".");
    const b = keyFingerprintOf(key(2)).split(".");
    expect(a[0]).not.toBe(b[0]);
    expect(a[1]).not.toBe(b[1]);
    expect(keyFingerprintOf(key(1))).toBe(keyFingerprintOf(key(1)));
  });
});

describe("the lock on a member's state file", () => {
  function stateDir(): { cfg: string; dir: string; done: () => void } {
    const root = mkdtempSync(join(tmpdir(), "fleet-state-lock-"));
    const cfg = join(root, "config.yaml");
    return { cfg, dir: fleetStateDir(cfg, "x", "s"), done: () => rmSync(root, { recursive: true, force: true }) };
  }

  test("a lock whose holder is gone is broken at once, not waited out", () => {
    const { cfg, dir, done } = stateDir();
    try {
      mkdirSync(join(dir, "state.lock"));
      writeFileSync(join(dir, "state.lock", "owner"), JSON.stringify({ pid: 2 ** 22 + 777, token: "dead" }));
      const started = Date.now();
      updateFleetState(cfg, "x", "s", { seq: 4 });
      expect(Date.now() - started).toBeLessThan(1000);
      expect(readFleetState(cfg, "x", "s").seq).toBe(4);
      expect(existsSync(join(dir, "state.lock"))).toBe(false);
    } finally {
      done();
    }
  });

  test("a lock that a running process holds is not written around: the writer fails and leaves the state as it was", () => {
    const { cfg, dir, done } = stateDir();
    // Another process that is running: a lock with this process's own pid and no hold on it is its leftover.
    const other = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
    try {
      writeFleetState(cfg, "x", "s", { seq: 1 }, { replace: true });
      mkdirSync(join(dir, "state.lock"));
      writeFileSync(join(dir, "state.lock", "owner"), JSON.stringify({ pid: other.pid, token: "somebody else" }));
      expect(() => updateFleetState(cfg, "x", "s", { seq: 9 })).toThrow(LockBusyError);
      expect(readFleetState(cfg, "x", "s").seq).toBe(1);
      // And the other's lock is still there: it was not this writer's to remove.
      expect(existsSync(join(dir, "state.lock"))).toBe(true);
    } finally {
      other.kill();
      done();
    }
  });
});

describe("what a member says it can do", () => {
  test("nothing is said while this build does nothing beyond the first form of the wire, and a list is said as it is", async () => {
    const { MEMBER_CAPS, capsBody, fleetHas } = await import("../src/fleet-transport");
    expect(MEMBER_CAPS).toEqual([]);
    expect(capsBody()).toEqual({});
    expect(capsBody(["meta2", "inline"])).toEqual({ caps: ["meta2", "inline"] });
    expect(fleetHas({ fleetCaps: ["meta2"] }, "meta2")).toBe(true);
    expect(fleetHas({ fleetCaps: ["inline"] }, "meta2")).toBe(false);
    expect(fleetHas({}, "meta2")).toBe(false); // a gateway that says nothing of it: the old form
  });

  test("a capability's name is the gateway's pattern, here and in everything this build says or reads", async () => {
    const { CAP_NAME, MEMBER_CAPS } = await import("../src/fleet-transport");
    for (const ok of ["meta2", "chunks", "a", "0", "tree-diff", "a".repeat(24), "x1-y2-z3"]) expect(CAP_NAME.test(ok), ok).toBe(true);
    for (const bad of ["", "-a", "A", "Meta2", "a b", "a_b", "a".repeat(25), "meta2\n", "é"]) expect(CAP_NAME.test(bad), bad).toBe(false);
    expect(CAP_NAME.source).toBe("^[a-z0-9][a-z0-9-]{0,23}$");
    for (const cap of MEMBER_CAPS) expect(CAP_NAME.test(cap), cap).toBe(true);
  });

  test("the list of this build goes in the body of every ask for a place, wherever it is made", async () => {
    const { MEMBER_CAPS } = await import("../src/fleet-transport");
    const caps = MEMBER_CAPS as string[];
    caps.push("test1");
    const real = globalThis.fetch;
    const sent: unknown[] = [];
    (globalThis as { fetch: unknown }).fetch = async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, role: "primary" });
    };
    try {
      await bootstrap({ gateway: "https://gw.example", deviceId: "d", deviceToken: "t" } as never, "x");
    } finally {
      (globalThis as { fetch: unknown }).fetch = real;
      caps.pop();
    }
    expect(sent).toEqual([{ seals: true, caps: ["test1"] }]);
  });

  test("every place in the source that asks for a place says what the member can do", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const src = join(import.meta.dir, "../src");
    const asking = readdirSync(src).filter((f) => f.endsWith(".ts") && /["`]\/bootstrap["`]/.test(readFileSync(join(src, f), "utf8")));
    expect(asking.sort()).toEqual(["fleet-daemon.ts", "fleet-space.ts", "fleets.ts"]);
    for (const f of asking) expect(readFileSync(join(src, f), "utf8"), f).toContain("capsBody()");
  });

  test("the role says what every member can do, and nothing that is not a name of one", async () => {
    const { fetchRole } = await import("../src/fleet-transport");
    const real = globalThis.fetch;
    let answer: unknown = { member: true, primary: true, epoch: 1, fleetCaps: ["meta2", "Bad Name", 7, "inline", "tree-diff", "a".repeat(24), "a".repeat(25), "-x"] };
    (globalThis as { fetch: unknown }).fetch = async () => Response.json(answer);
    try {
      const creds = { gateway: "https://gw.example", deviceId: "d", deviceToken: "t" } as never;
      expect((await fetchRole(creds, "x")).fleetCaps).toEqual(["meta2", "inline", "tree-diff", "a".repeat(24)]);
      answer = { member: true, primary: true, epoch: 1 };
      expect("fleetCaps" in (await fetchRole(creds, "x"))).toBe(false);
      answer = { member: true, primary: true, epoch: 1, fleetCaps: [] };
      expect((await fetchRole(creds, "x")).fleetCaps).toEqual([]);
    } finally {
      (globalThis as { fetch: unknown }).fetch = real;
    }
  });
});

describe("`prime fleets set`: how long a place lasts", () => {
  test("a lease is written as a person writes a time, and anything else is refused", async () => {
    const { parseLease } = await import("../src/fleets");
    expect(parseLease("90s")).toBe(90_000);
    expect(parseLease("2m")).toBe(120_000);
    expect(parseLease("90")).toBe(90_000); // seconds, never milliseconds
    expect(parseLease("1500ms")).toBe(1500);
    expect(parseLease("1.5m")).toBe(90_000);
    expect(parseLease(" 45S ")).toBe(45_000);
    expect(parseLease("default")).toBeNull();
    for (const bad of ["", "soon", "-5s", "0", "0s", "9x", "1h", "NaN"]) expect(() => parseLease(bad)).toThrow(/not a time/);
  });

  test("sends the lease to the fleet's meta route, as the operator or owner, and says what the gateway made of it", async () => {
    const { fleetsSet } = await import("../src/fleets");
    const sent: Array<{ path: string; method: string; body: unknown }> = [];
    const real = globalThis.fetch;
    let answer: { status: number; json: unknown } = { status: 200, json: { ok: true, leaseMs: 90_000 } };
    (globalThis as { fetch: unknown }).fetch = async (url: string, init: { method: string; body: string }) => {
      sent.push({ path: new URL(url).pathname, method: init.method, body: JSON.parse(init.body) });
      return Response.json(answer.json, { status: answer.status });
    };
    const out: string[] = [];
    try {
      const ctx = (flags: Record<string, string | boolean>, json = false) =>
        ({ config: config({ defaults: { gateway: "https://g.example", fleet_operator_token: "op" } }), configPath: "/nowhere", json, out: (l: string) => out.push(l), parsed: { positionals: ["fleets", "set", "acme"], flags: new Map<string, string | boolean>(Object.entries(flags)) } }) as never;
      await fleetsSet(ctx({ lease: "90s", device: "d1", token: "t1" }));
      expect(sent[0]).toEqual({ path: "/fleets/acme/meta", method: "POST", body: { leaseMs: 90_000 } });
      expect(out.join("\n")).toContain("90 s");
      expect(out.join("\n")).toContain("every 30 s");
      answer = { status: 200, json: { ok: true, leaseMs: 45_000 } };
      await fleetsSet(ctx({ lease: "default", device: "d1", token: "t1" }));
      expect(sent[1]!.body).toEqual({ leaseMs: null });
      // The gateway's bounds are its own: what it refuses is said as it said it.
      answer = { status: 400, json: { error: "leaseMs must be a number between 30000 and 180000" } };
      await expect(fleetsSet(ctx({ lease: "5s", device: "d1", token: "t1" }))).rejects.toThrow(/could not set the lease: leaseMs must be a number between 30000 and 180000/);
      // Nothing asked is not a request.
      const before = sent.length;
      await expect(fleetsSet(ctx({ device: "d1", token: "t1" }))).rejects.toThrow(/nothing to set/);
      await expect(fleetsSet(ctx({ lease: "soon", device: "d1", token: "t1" }))).rejects.toThrow(/not a time/);
      expect(sent.length).toBe(before);
    } finally {
      (globalThis as { fetch: unknown }).fetch = real;
    }
  });

  test("is a command with its own flag, listed in the help", async () => {
    const { fleetFlagsFor } = await import("../src/fleet-flags");
    expect(fleetFlagsFor("set").map((f) => f.name)).toContain("lease");
    expect(fleetFlagsFor("members").map((f) => f.name)).not.toContain("lease");
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(import.meta.dir, "../src/help.ts"), "utf8")).toContain("prime fleets set <fleet-id> --lease <time>");
  });
});

describe("taking a place in the fleet", () => {
  test("says that this build seals what it publishes, so a bar for an older build does not keep it from the lease", async () => {
    const real = globalThis.fetch;
    let sent: unknown;
    (globalThis as { fetch: unknown }).fetch = async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({ ok: true, role: "primary" });
    };
    try {
      await bootstrap({ gateway: "https://gw.example", deviceId: "d", deviceToken: "t" } as never, "x");
    } finally {
      (globalThis as { fetch: unknown }).fetch = real;
    }
    expect(sent).toEqual({ seals: true });
  });
});

describe("what a member knows of a fleet, when it joins", () => {
  function joinCtx(configPath: string) {
    return {
      parsed: { positionals: ["fleets", "join", "x"], flags: new Map<string, string | number | boolean>([["code", "c0de"], ["device", "dev-1"], ["token", "t"], ["gateway", "https://gw.example"], ["json", true]]), help: false },
      config: { defaults: {}, devices: {}, spaces: {}, codeMcp: {} },
      configPath,
      json: true,
      quiet: true,
      verbose: false,
      color: false,
      out() {},
      note() {},
    } as never;
  }

  async function withGateway(joined: number, me: "member" | "none", fn: () => Promise<void>): Promise<void> {
    const real = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/me")) return Response.json({ ok: true, status: me });
      return Response.json(joined === 200 ? { status: "member" } : { error: "no" }, { status: joined });
    };
    try {
      await fn();
    } finally {
      (globalThis as { fetch: unknown }).fetch = real;
    }
  }

  test("is forgotten when a new membership has been made, and kept when the join failed", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-join-"));
    try {
      const cfg = join(root, "config.yaml");
      const trustFile = fleetKeyFile(cfg, "x", "dev-1") + ".trust.json";
      writeFileSync(trustFile, JSON.stringify({ sealedFrom: 3, peers: {} }));
      await withGateway(403, "none", async () => {
        await expect(fleetsJoin(joinCtx(cfg))).rejects.toThrow();
      });
      // A join that failed (a wrong code, a gateway that was down) changes nothing.
      expect(existsSync(trustFile)).toBe(true);
      await withGateway(200, "none", async () => {
        await fleetsJoin(joinCtx(cfg));
      });
      expect(existsSync(trustFile)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is kept when the member joins again: that is not a new membership", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-join-"));
    try {
      const cfg = join(root, "config.yaml");
      const trustFile = fleetKeyFile(cfg, "x", "dev-1") + ".trust.json";
      writeFileSync(trustFile, JSON.stringify({ sealedFrom: 3, macFrom: 3, peers: {} }));
      await withGateway(200, "member", async () => {
        await fleetsJoin(joinCtx(cfg));
      });
      expect(JSON.parse(readFileSync(trustFile, "utf8")).sealedFrom).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("writing a file so that nobody sees half of it", () => {
  const busy = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

  test("a rename that Windows refuses while the file is open is tried again, and goes through", async () => {
    const { writeFileAtomic } = await import("../src/atomic-write");
    const { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "atomic-"));
    try {
      const file = join(dir, "state.json");
      let refused = 0;
      writeFileAtomic(file, "one", 0o600, {
        durable: true,
        platform: "win32",
        rename: (from, to) => {
          if (refused++ < 2) throw busy("EPERM");
          renameSync(from, to);
        },
      });
      expect(refused).toBe(3);
      expect(readFileSync(file, "utf8")).toBe("one");
      expect(readdirSync(dir)).toEqual(["state.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a rename that is refused for longer than a few tries (eight writers on a slow disk) still goes through", async () => {
    const { writeFileAtomic } = await import("../src/atomic-write");
    const { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "atomic-"));
    try {
      const file = join(dir, "state.json");
      const began = performance.now();
      writeFileAtomic(file, "late", 0o600, {
        platform: "win32",
        rename: (from, to) => {
          if (performance.now() - began < 600) throw busy("EPERM");
          renameSync(from, to);
        },
      });
      expect(readFileSync(file, "utf8")).toBe("late");
      expect(readdirSync(dir)).toEqual(["state.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("one that keeps being refused, or fails for another reason, throws and leaves no temporary file", async () => {
    const { writeFileAtomic } = await import("../src/atomic-write");
    const { mkdtempSync, readdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "atomic-"));
    try {
      let tries = 0;
      const began = performance.now();
      expect(() =>
        writeFileAtomic(join(dir, "a"), "x", 0o600, {
          platform: "win32",
          budgetMs: 200,
          rename: () => {
            tries++;
            throw busy("EBUSY");
          },
        }),
      ).toThrow();
      // Tried again for the time it is given, and not for much longer.
      expect(performance.now() - began).toBeGreaterThanOrEqual(190);
      expect(performance.now() - began).toBeLessThan(1500);
      expect(tries).toBeGreaterThan(3);
      expect(() => writeFileAtomic(join(dir, "b"), "x", 0o600, { platform: "win32", rename: () => { throw busy("ENOSPC"); } })).toThrow();
      // Elsewhere a refusal of permission is an error at once.
      tries = 0;
      expect(() => writeFileAtomic(join(dir, "c"), "x", 0o600, { platform: "linux", rename: () => { tries++; throw busy("EACCES"); } })).toThrow();
      expect(tries).toBe(1);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
