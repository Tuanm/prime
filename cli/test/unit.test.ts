// Offline unit tests: no gateway, no network. Run: bun test/unit.test.ts
//
// Covers the parts that are pure logic and therefore cheap to pin down:
// config round-trips, secret permissions, label resolution, argument parsing,
// target precedence, and tool-result rendering.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseArgs, flag } from "../src/args.ts";
import { GatewayClient, MAX_ATTEMPTS, backoffFor, isSafeToRetry } from "../src/client.ts";
import { pool } from "../src/pool.ts";
import { compareVersions, isValidVersion, versionProblem } from "../src/version.ts";
import { assetNameFor, parseChecksums, selectLatest, versionFromTag, type Release } from "../src/update.ts";
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

describe("retry policy", () => {
  const target = { deviceId: "dev", gateway: "https://gw.test", deviceToken: "tok", timeoutMs: 5000 };
  const realFetch = globalThis.fetch;

  /** Replace fetch with a stub; returns the recorded requests. */
  function stubFetch(handler: (attempt: number) => Response | Promise<Response>): { url: string }[] {
    const seen: { url: string }[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      seen.push({ url: String(url) });
      return handler(seen.length);
    }) as unknown as typeof fetch;
    return seen;
  }

  const okBody = '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}';

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("retries a rate limit and then succeeds", async () => {
    const seen = stubFetch((attempt) =>
      attempt < MAX_ATTEMPTS ? new Response('{"error":"rate limited"}', { status: 429 }) : new Response(okBody, { status: 200 }),
    );
    const client = new GatewayClient(target);
    expect(await client.rpc("ping")).toEqual({ ok: true });
    expect(seen.length).toBe(MAX_ATTEMPTS);
    expect(client.lastAttempts).toBe(MAX_ATTEMPTS);
  });

  test("retries a full pending queue (device busy)", async () => {
    const seen = stubFetch((attempt) =>
      attempt === 1 ? new Response('{"error":"device busy"}', { status: 503 }) : new Response(okBody, { status: 200 }),
    );
    await new GatewayClient(target).rpc("ping");
    expect(seen.length).toBe(2);
  });

  test("does not retry an offline device", async () => {
    const seen = stubFetch(() => new Response('{"error":"device offline"}', { status: 503 }));
    await expect(new GatewayClient(target).rpc("ping")).rejects.toThrow(/offline/i);
    expect(seen.length).toBe(1);
  });

  test("does not retry a server error", async () => {
    const seen = stubFetch(() => new Response("boom", { status: 500 }));
    await expect(new GatewayClient(target).rpc("ping")).rejects.toThrow();
    expect(seen.length).toBe(1);
  });

  test("does not retry a dropped connection (a tool may have run)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("socket closed");
    }) as unknown as typeof fetch;
    await expect(new GatewayClient(target).rpc("ping")).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("gives up after the attempt limit", async () => {
    const seen = stubFetch(() => new Response('{"error":"rate limited"}', { status: 429 }));
    await expect(new GatewayClient(target).rpc("ping")).rejects.toThrow(/rate limited/);
    expect(seen.length).toBe(MAX_ATTEMPTS);
  });

  test("classifies retryable statuses", () => {
    expect(isSafeToRetry(429, "")).toBe(true);
    expect(isSafeToRetry(502, "")).toBe(true);
    expect(isSafeToRetry(503, '{"error":"device busy"}')).toBe(true);
    expect(isSafeToRetry(503, '{"error":"device offline"}')).toBe(false);
    expect(isSafeToRetry(401, "")).toBe(false);
    expect(isSafeToRetry(504, "")).toBe(false);
    expect(isSafeToRetry(200, "")).toBe(false);
  });

  test("backoff grows and is capped", () => {
    expect(backoffFor(1)).toBeGreaterThanOrEqual(200);
    expect(backoffFor(2)).toBeGreaterThanOrEqual(400);
    expect(backoffFor(99)).toBeLessThanOrEqual(1100);
  });
});

describe("bounded concurrency", () => {
  test("preserves input order while running concurrently", async () => {
    const items = [40, 5, 25, 1];
    const results = await pool(items, 4, async (ms) => {
      await Bun.sleep(ms);
      return ms;
    });
    expect(results).toEqual(items);
  });

  test("never exceeds the configured limit", async () => {
    let active = 0;
    let peak = 0;
    await pool(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      active--;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  test("uses all workers when there is work for them", async () => {
    let peak = 0;
    let active = 0;
    await pool(Array.from({ length: 8 }, (_, i) => i), 8, async () => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(10);
      active--;
      return null;
    });
    expect(peak).toBe(8);
  });

  test("handles empty input and a limit larger than the work", async () => {
    expect(await pool([], 4, async () => 1)).toEqual([]);
    expect(await pool([1, 2], 100, async (n) => n * 2)).toEqual([2, 4]);
  });
});

describe("update helpers", () => {
  test("compareVersions follows SemVer, with build metadata as a tiebreak", () => {
    expect(compareVersions("26.10.3", "26.10.4")).toBe(-1);
    expect(compareVersions("26.10.4", "26.10.3")).toBe(1);
    expect(compareVersions("26.10.3", "26.10.3")).toBe(0);
    expect(compareVersions("26.9.30", "26.10.1")).toBe(-1);
    // A release outranks its own prerelease.
    expect(compareVersions("26.10.3-rc.1", "26.10.3")).toBe(-1);
    // SemVer ignores build metadata; we do not, so a same-day rerelease is seen.
    expect(compareVersions("26.10.3+1", "26.10.3")).toBe(1);
    expect(compareVersions("26.10.3+2", "26.10.3+10")).toBe(-1);
  });

  test("versionFromTag only accepts CLI release tags", () => {
    expect(versionFromTag("cli-v26.10.3")).toBe("26.10.3");
    expect(versionFromTag("cli-v26.10.3+1")).toBe("26.10.3+1");
    expect(versionFromTag("worker-v1.0.0")).toBeUndefined();
    expect(versionFromTag("cli-v26.10.03")).toBeUndefined(); // zero padded
    expect(versionFromTag("v26.10.3")).toBeUndefined();
  });

  test("assetNameFor matches the release's naming", () => {
    expect(assetNameFor("26.10.4", "binary", "darwin", "arm64")).toBe("mcp-26.10.4-darwin-arm64");
    expect(assetNameFor("26.10.4", "binary", "linux", "x64")).toBe("mcp-26.10.4-linux-x64");
    expect(assetNameFor("26.10.4", "binary", "win32", "x64")).toBe("mcp-26.10.4-windows-x64.exe");
    expect(assetNameFor("26.10.4", "bundle", "darwin", "arm64")).toBe("mcp-26.10.4.js");
    expect(() => assetNameFor("26.10.4", "binary", "aix", "ppc")).toThrow(/no prebuilt binary/);
  });

  const release = (version: string, prerelease = false): Release => ({
    tag: `cli-v${version}`,
    version,
    prerelease,
    htmlUrl: "",
    assets: [],
  });

  test("selectLatest picks the highest version, ignoring prereleases", () => {
    expect(selectLatest([release("26.10.2"), release("26.10.4"), release("26.9.9")])!.version).toBe("26.10.4");
    expect(selectLatest([release("26.10.4"), release("26.11.1", true)])!.version).toBe("26.10.4");
    // ...unless a prerelease is all there is.
    expect(selectLatest([release("26.11.1", true)])!.version).toBe("26.11.1");
    expect(selectLatest([])).toBeUndefined();
    // Build metadata still ranks, so the newest same-day rerelease wins.
    expect(selectLatest([release("26.10.3"), release("26.10.3+1")])!.version).toBe("26.10.3+1");
  });

  test("parseChecksums reads the sha256sum format", () => {
    const sums = parseChecksums(
      "aa".repeat(32) + "  mcp-26.10.4-darwin-arm64\n" + "bb".repeat(32) + " *mcp-26.10.4.js\n" + "not a line\n",
    );
    expect(sums.get("mcp-26.10.4-darwin-arm64")).toBe("aa".repeat(32));
    expect(sums.get("mcp-26.10.4.js")).toBe("bb".repeat(32)); // "*" binary marker handled
    expect(sums.size).toBe(2);
  });
});

describe("versions", () => {
  test("accepts date versions and semver", () => {
    for (const v of ["26.10.3", "0.2.0", "2026.10.3", "26.10.3+1", "26.10.3-rc.1", "26.10.3-rc.1+build.5"]) {
      expect(isValidVersion(v)).toBe(true);
    }
  });

  test("rejects zero-padded dates, which npm pack would have accepted", () => {
    // The trap: "26.10.03" looks right, packs fine, and is invalid SemVer.
    expect(isValidVersion("26.10.03")).toBe(false);
    expect(isValidVersion("2026.10.03")).toBe(false);
    expect(versionProblem("26.10.03")).toContain("Use 26.10.3");
    expect(versionProblem("2026.10.03")).toContain("Use 2026.10.3");
  });

  test("rejects versions that are not versions", () => {
    for (const v of ["", "1.0", "v26.10.3", "26.10", "26.10.3.4", "latest", "26.10.3-"]) {
      expect(isValidVersion(v)).toBe(false);
    }
    // The "v" belongs on the git tag, not in the version value.
    expect(versionProblem("v26.10.3")).toContain("not a version");
  });

  test("no problem is reported for a valid version", () => {
    expect(versionProblem("26.10.3")).toBeUndefined();
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
