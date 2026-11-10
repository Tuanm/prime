import { describe, expect, test } from "bun:test";
import { resolveFleetTarget } from "../src/fleets";
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
