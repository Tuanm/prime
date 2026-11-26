import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFleetState, resolveFleetTarget, updateFleetState, writeFleetState } from "../src/fleets";
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
        'import { updateFleetState } from "' + join(import.meta.dir, "../src/fleets.ts") + '";' +
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
