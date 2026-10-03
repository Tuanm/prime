// Offline unit tests: no gateway, no network. Run: bun test/unit.test.ts
//
// Covers the parts that are pure logic and therefore cheap to pin down:
// config round-trips, secret permissions, label resolution, argument parsing,
// target precedence, and tool-result rendering.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseArgs, flag } from "../src/args.ts";
import { emptyConfig, loadConfig, parseConfig, saveConfig, serializeConfig } from "../src/config.ts";
import { splitLabel } from "../src/labels.ts";
import { renderToolResult, truncate } from "../src/output.ts";
import { normalizeGateway, resolveTarget, assertDeviceId } from "../src/target.ts";

describe("config", () => {
  test("round-trips through YAML", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-cli-"));
    const path = join(dir, "config.yaml");
    const config = emptyConfig();
    config.defaults = { gateway: "https://gw.example.dev", gateway_token: "gw-tok", timeout_ms: 1000 };
    config.devices = { alpha: { gateway: "https://other.dev", token: "dev-tok", connected_at: "2026-01-01T00:00:00.000Z" } };
    saveConfig(path, config);
    expect(loadConfig(path)).toEqual(config);
  });

  test("creates the file 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-cli-"));
    const path = join(dir, "config.yaml");
    saveConfig(path, emptyConfig());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("quotes values that would otherwise break YAML", () => {
    const config = emptyConfig();
    config.devices = { "we:ird": { token: 'has "quotes" and: colon', note: "back\\slash" } };
    const text = serializeConfig(config);
    expect(text).toContain('"has \\"quotes\\" and: colon"');
    // The emitter's output must parse back to exactly what went in.
    expect(parseConfig(text, "memory").devices["we:ird"]!.token).toBe('has "quotes" and: colon');
    expect(parseConfig(text, "memory").devices["we:ird"]!.note).toBe("back\\slash");
  });

  test("rejects malformed YAML with an actionable error", () => {
    expect(() => parseConfig("devices: [unclosed", "memory")).toThrow(/invalid YAML/);
  });

  test("ignores unknown keys and wrong types", () => {
    const parsed = parseConfig("defaults:\n  gateway: 42\n  nope: 1\ndevices:\n  a:\n    token: ok\n", "memory");
    expect(parsed.defaults.gateway).toBeUndefined();
    expect(parsed.devices.a!.token).toBe("ok");
  });
});

describe("label resolution", () => {
  const known = ["alpha", "alpha.v2", "beta"];

  test("prefers the longest configured device id", () => {
    // "alpha.v2.echo" must resolve to device "alpha.v2", not "alpha".
    expect(splitLabel("alpha.v2.echo", known)).toEqual({ deviceId: "alpha.v2", toolName: "echo" });
  });

  test("falls back to the first dot", () => {
    expect(splitLabel("unknown.tool", known)).toEqual({ deviceId: "unknown", toolName: "tool" });
  });

  test("keeps dots inside the tool name", () => {
    expect(splitLabel("alpha.file.read", known)).toEqual({ deviceId: "alpha", toolName: "file.read" });
  });

  test("accepts a bare tool name when exactly one device is configured", () => {
    expect(splitLabel("snapshot", ["solo"])).toEqual({ deviceId: "solo", toolName: "snapshot" });
  });

  test("rejects a bare tool name with several devices", () => {
    expect(() => splitLabel("snapshot", known)).toThrow(/device-id>\.<tool-id>/);
  });
});

describe("targets", () => {
  test("normalizes gateway URLs", () => {
    expect(normalizeGateway("gw.example.dev")).toBe("https://gw.example.dev");
    expect(normalizeGateway("https://gw.example.dev/")).toBe("https://gw.example.dev");
    expect(normalizeGateway("http://127.0.0.1:8788/")).toBe("http://127.0.0.1:8788");
    expect(normalizeGateway("https://gw.example.dev/base/")).toBe("https://gw.example.dev/base");
    expect(() => normalizeGateway("wss://gw.example.dev")).toThrow(/unsupported gateway scheme/);
  });

  test("validates device ids like the gateway does", () => {
    expect(assertDeviceId("my-device.v2")).toBe("my-device.v2");
    expect(() => assertDeviceId("bad id")).toThrow(/invalid device id/);
    expect(() => assertDeviceId("")).toThrow(/invalid device id/);
    expect(() => assertDeviceId("x".repeat(129))).toThrow(/invalid device id/);
  });

  test("applies flag > device entry > defaults precedence", () => {
    const config = emptyConfig();
    config.defaults = { gateway: "https://defaults.dev", token: "defaults-token", gateway_token: "defaults-gw" };
    config.devices = { alpha: { gateway: "https://device.dev", token: "device-token" } };

    const fromDefaults = resolveTarget(config, "alpha");
    expect(fromDefaults.gateway).toBe("https://device.dev");
    expect(fromDefaults.deviceToken).toBe("device-token");
    expect(fromDefaults.gatewayToken).toBe("defaults-gw");

    const overridden = resolveTarget(config, "alpha", { gateway: "https://flag.dev", deviceToken: "flag-token" });
    expect(overridden.gateway).toBe("https://flag.dev");
    expect(overridden.deviceToken).toBe("flag-token");
  });

  test("explains how to fix a missing gateway", () => {
    expect(() => resolveTarget(emptyConfig(), "alpha")).toThrow(/no gateway URL configured/);
  });
});

describe("argument parsing", () => {
  const specs = [flag("token", "string", "t"), flag("json", "boolean", "j"), flag("timeout", "number", "ms")];

  test("supports --flag value, --flag=value and booleans", () => {
    const a = parseArgs(["--token", "abc", "--json", "--timeout", "50", "pos"], specs);
    expect(a.flags.get("token")).toBe("abc");
    expect(a.flags.get("json")).toBe(true);
    expect(a.flags.get("timeout")).toBe(50);
    expect(a.positionals).toEqual(["pos"]);
  });

  test("treats everything after -- as positional", () => {
    const a = parseArgs(["--", "--not-a-flag", "-x"], specs);
    expect(a.positionals).toEqual(["--not-a-flag", "-x"]);
  });

  test("rejects unknown options and missing values", () => {
    expect(() => parseArgs(["--nope"], specs)).toThrow(/unknown option/);
    expect(() => parseArgs(["--token"], specs)).toThrow(/requires a value/);
    expect(() => parseArgs(["--timeout", "soon"], specs)).toThrow(/expects a number/);
  });

  test("-h sets help", () => {
    expect(parseArgs(["-h"], specs).help).toBe(true);
  });
});

describe("tool result rendering", () => {
  test("joins text blocks", () => {
    const rendered = renderToolResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] });
    expect(rendered.text).toBe("a\nb");
    expect(rendered.isError).toBe(false);
  });

  test("flags isError", () => {
    expect(renderToolResult({ isError: true, content: [{ type: "text", text: "boom" }] }).isError).toBe(true);
  });

  test("describes non-text blocks instead of dropping them", () => {
    expect(renderToolResult({ content: [{ type: "image", mimeType: "image/png", data: "AAAA" }] }).text).toContain("image/png");
  });

  test("falls back to JSON for unknown shapes", () => {
    expect(renderToolResult({ weird: 1 }).text).toBe('{\n  "weird": 1\n}');
  });

  test("handles null", () => {
    expect(renderToolResult(null).text).toBe("");
  });
});

describe("misc", () => {
  test("truncate collapses whitespace", () => {
    expect(truncate("a\n\n b", 20)).toBe("a b");
    expect(truncate("x".repeat(10), 5)).toBe("xxxx…");
  });

  test("a missing config file yields an empty config", () => {
    expect(loadConfig(join(tmpdir(), "definitely-absent-config.yaml"))).toEqual(emptyConfig());
  });
});
