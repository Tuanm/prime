import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LockBusyError } from "../src/dir-lock";
import { bootstrap, fleetKeyFile, fleetStateDir, fleetsJoin, memberRows, readFleetState, resolveFleetTarget, updateFleetState, writeFleetState } from "../src/fleets";
import type { Config } from "../src/config";

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
      defaults: { gateway: "https://default.example", gateway_token: "from-defaults" },
      devices: { one: { gateway: "https://from-device.example", token: "device-token" } },
    });
    const t = resolveFleetTarget(c, { gateway: "https://from-flag.example", gatewayToken: "from-flag", device: "other", token: "flag-token" });
    expect(t.gateway).toBe("https://from-flag.example");
    expect(t.gatewayToken).toBe("from-flag");
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
    const t = resolveFleetTarget(c, {}, undefined, { PRIME_GATEWAY_URL: "https://env.example", PRIME_GATEWAY_TOKEN: "env-token" });
    expect(t.gateway).toBe("https://env.example");
    expect(t.gatewayToken).toBe("env-token");
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
        "const i = Number(process.argv[1]); for (let k = 0; k < 15; k++) updateFleetState(process.argv[2], 'f', 's', { fetchedSeq: i * 100 + k, fetchedCommit: 'c' + (i * 100 + k) });";
      const children = [1, 2, 3, 4, 5, 6].map((i) => Bun.spawn([process.execPath, "-e", script, String(i), config], { env: process.env, stdout: "ignore", stderr: "pipe" }));
      for (const c of children) expect(await c.exited).toBe(0);
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
    expect(a[0]![2]).toMatch(/^[A-Za-z0-9+/]{11}=$/);
    expect(a[0]![2]).not.toBe(b[0]![2]);
    expect(memberRows([{ deviceId: "d2", role: "member", addedAt: at }])[0]![2]).toBe("-");
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
    try {
      writeFleetState(cfg, "x", "s", { seq: 1 }, { replace: true });
      mkdirSync(join(dir, "state.lock"));
      writeFileSync(join(dir, "state.lock", "owner"), JSON.stringify({ pid: process.pid, token: "somebody else" }));
      expect(() => updateFleetState(cfg, "x", "s", { seq: 9 })).toThrow(LockBusyError);
      expect(readFleetState(cfg, "x", "s").seq).toBe(1);
      // And the other's lock is still there: it was not this writer's to remove.
      expect(existsSync(join(dir, "state.lock"))).toBe(true);
    } finally {
      done();
    }
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

  test("one that keeps being refused, or fails for another reason, throws and leaves no temporary file", async () => {
    const { writeFileAtomic } = await import("../src/atomic-write");
    const { mkdtempSync, readdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "atomic-"));
    try {
      let tries = 0;
      expect(() =>
        writeFileAtomic(join(dir, "a"), "x", 0o600, {
          rename: () => {
            tries++;
            throw busy("EBUSY");
          },
        }),
      ).toThrow();
      expect(tries).toBe(7); // the first and six more
      expect(() => writeFileAtomic(join(dir, "b"), "x", 0o600, { rename: () => { throw busy("ENOSPC"); } })).toThrow();
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
