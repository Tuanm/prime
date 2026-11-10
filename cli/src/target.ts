// Resolution of "which gateway, which device, which credentials" for a command.
//
// Precedence (highest first):
//   1. command-line flag
//   2. environment variable
//   3. per-device entry in the config file
//   4. defaults section in the config file
//   5. (gateway only) the managed default, https://prime.tuanm.workers.dev
//
// The same order applies per field, so `--gateway` can be passed ad hoc while
// the token still comes from the config file.

import type { Config } from "./config.ts";
import { UsageError } from "./errors.ts";

/** Mirrors the gateway's own allowlist (gateway/src/config.ts validDeviceId). */
const DEVICE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export const ENV = {
  gateway: "PRIME_GATEWAY_URL",
  gatewayToken: "PRIME_GATEWAY_TOKEN",
  deviceToken: "PRIME_DEVICE_TOKEN",
  timeoutMs: "PRIME_TIMEOUT_MS",
} as const;

export interface Target {
  deviceId: string;
  /**
   * The fleet this call is addressed to, when it is addressed to a fleet.
   *
   * A call to a fleet goes to the member that holds the lease, so a client
   * talks to the fleet and not to one machine that happens to be up.
   */
  fleet?: string;
  /** Always an http(s) origin, no trailing slash. */
  gateway: string;
  /** A local MCP server (a space): dial it directly instead of the gateway relay. */
  localUrl?: string;
  gatewayToken?: string;
  deviceToken?: string;
  timeoutMs: number;
}

export interface TargetOverrides {
  gateway?: string;
  gatewayToken?: string;
  deviceToken?: string;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 300_000; // matches the gateway's TIMEOUT_MS default

/** The managed gateway, used when nothing else is configured (same default as code-mcp's bare --gateway). */
export const DEFAULT_GATEWAY = "https://prime.tuanm.workers.dev";

export function assertDeviceId(deviceId: string): string {
  if (!DEVICE_ID_RE.test(deviceId)) {
    throw new UsageError(
      `invalid device id "${deviceId}"`,
      "Device ids may contain letters, digits, dot, underscore and dash (max 128 chars).",
    );
  }
  return deviceId;
}

/** A local MCP base URL: http(s), no trailing slash, no /mcp suffix. */
export function normalizeLocalUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new UsageError("empty local URL");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new UsageError(`invalid local URL "${input}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError(`unsupported local URL scheme "${url.protocol.replace(":", "")}"`, "Use an http(s) URL.");
  }
  const path = url.pathname.replace(/\/+$/, "").replace(/\/mcp$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

/** Accept "host", "http://host", "https://host/" and return a clean origin. */
export function normalizeGateway(input: string): string {
  let value = input.trim();
  if (value.length === 0) throw new UsageError("empty gateway URL");
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    value = `https://${value}`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`invalid gateway URL "${input}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UsageError(
      `unsupported gateway scheme "${url.protocol.replace(":", "")}"`,
      "Use an http(s) URL: the MCP relay is plain HTTP (the device tunnel uses wss).",
    );
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

function pick(flag: string | undefined, env: string | undefined, ...fallbacks: (string | undefined)[]): string | undefined {
  if (flag !== undefined && flag.length > 0) return flag;
  if (env !== undefined && env.length > 0) return env;
  for (const value of fallbacks) if (value !== undefined && value.length > 0) return value;
  return undefined;
}

/**
 * The gateway origin for a command: --gateway > environment > device entry >
 * config defaults > the managed default gateway (prime.tuanm.workers.dev).
 */
export function resolveGateway(config: Config, flagValue?: string, entryValue?: string): string {
  return normalizeGateway(pick(flagValue, process.env[ENV.gateway], entryValue, config.defaults.gateway) ?? DEFAULT_GATEWAY);
}

export const FLEET_PREFIX = "fleet:";

/** Whether a reference names a fleet rather than a device. */
export function isFleetRef(deviceId: string): boolean {
  return deviceId.startsWith(FLEET_PREFIX);
}

export function resolveTarget(config: Config, deviceId: string, overrides: TargetOverrides = {}): Target {
  // A fleet is addressed by the client that is a member of it, so the call
  // is made as that client and the gateway routes it to the primary.
  if (isFleetRef(deviceId)) {
    const fleet = deviceId.slice(FLEET_PREFIX.length);
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(fleet)) {
      throw new UsageError("invalid fleet id \"" + fleet + "\"");
    }
    const gateway = resolveGateway(config, overrides.gateway);
    const timeoutRaw = overrides.timeoutMs ?? Number(process.env[ENV.timeoutMs] ?? Number.NaN);
    const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : (config.defaults.timeout_ms ?? DEFAULT_TIMEOUT_MS);
    // The caller is chosen without a round trip; the tools command asks the
    // fleet which of the configured devices is a member of it.
    const caller = firstDeviceWithToken(config, overrides);
    return {
      deviceId: caller.deviceId,
      fleet,
      gateway,
      gatewayToken: pick(overrides.gatewayToken, process.env[ENV.gatewayToken], config.defaults.gateway_token),
      deviceToken: caller.token,
      timeoutMs,
    };
  }
  assertDeviceId(deviceId);
  const entry = config.devices[deviceId] ?? {};

  const gateway = resolveGateway(config, overrides.gateway, entry.gateway);
  const localUrl = entry.local_url ? normalizeLocalUrl(entry.local_url) : undefined;

  const timeoutRaw = overrides.timeoutMs ?? Number(process.env[ENV.timeoutMs] ?? Number.NaN);
  const timeoutMs =
    Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? Number(timeoutRaw)
      : (config.defaults.timeout_ms ?? DEFAULT_TIMEOUT_MS);

  return {
    deviceId,
    gateway,
    ...(localUrl ? { localUrl } : {}),
    gatewayToken: pick(overrides.gatewayToken, process.env[ENV.gatewayToken], entry.gateway_token, config.defaults.gateway_token),
    deviceToken: pick(overrides.deviceToken, process.env[ENV.deviceToken], entry.token, config.defaults.token),
    timeoutMs,
  };
}

/** The first configured device that has a token. */
function firstDeviceWithToken(config: Config, overrides: TargetOverrides): { deviceId: string; token: string } {
  if (overrides.deviceToken) {
    const id = Object.keys(config.devices).find((d) => config.devices[d]?.token === overrides.deviceToken);
    if (id) return { deviceId: id, token: overrides.deviceToken };
  }
  for (const [id, entry] of Object.entries(config.devices)) {
    if (entry.token) return { deviceId: id, token: entry.token };
  }
  throw new UsageError(
    "no device credential to call the fleet with",
    "A call to a fleet is made as one of its members. Add one with 'prime devices connect <device-id> --token <token>'.",
  );
}

/**
 * The device that makes the call: one of the fleet's members.
 *
 * A call to a fleet is made as a member of it, so the credential has to be
 * one the fleet knows. The configured devices are tried until one of them
 * answers as a member; the one named on the command line is tried first.
 */
export async function fleetCaller(
  config: Config,
  fleet: string,
  gateway: string,
  overrides: TargetOverrides,
): Promise<{ deviceId: string; token: string }> {
  const candidates: Array<{ deviceId: string; token: string }> = [];
  if (overrides.deviceToken) {
    const id = Object.keys(config.devices).find((d) => config.devices[d]?.token === overrides.deviceToken);
    if (id) candidates.push({ deviceId: id, token: overrides.deviceToken });
  }
  for (const [id, entry] of Object.entries(config.devices)) {
    if (entry.token && !candidates.some((c) => c.deviceId === id)) candidates.push({ deviceId: id, token: entry.token });
  }
  if (candidates.length === 0) {
    throw new UsageError(
      "no device credential to call the fleet with",
      "A call to a fleet is made as one of its members. Add one with 'prime devices connect <device-id> --token <token>'.",
    );
  }

  for (const candidate of candidates) {
    try {
      const res = await fetch(gateway + "/fleets/" + encodeURIComponent(fleet) + "/me", {
        headers: { "x-prime-device": candidate.deviceId, "x-device-token": candidate.token },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { status?: string };
      if (body.status === "member") return candidate;
    } catch {}
  }
  throw new UsageError(
    "no configured device is a member of the fleet " + fleet,
    "A call to a fleet is made as one of its members. Pass --device <id> for the member that should make the call.",
  );
}

/** The values a `devices connect` stores (only what was actually supplied). */
export function entryFromOverrides(overrides: TargetOverrides, now: string): { entry: Config["devices"][string]; defaults: Partial<Config["defaults"]> } {
  const entry: Config["devices"][string] = {};
  if (overrides.gateway !== undefined) entry.gateway = normalizeGateway(overrides.gateway);
  if (overrides.gatewayToken !== undefined) entry.gateway_token = overrides.gatewayToken;
  if (overrides.deviceToken !== undefined) entry.token = overrides.deviceToken;
  entry.connected_at = now;

  const defaults: Partial<Config["defaults"]> = {};
  if (overrides.gateway !== undefined) defaults.gateway = normalizeGateway(overrides.gateway);
  if (overrides.gatewayToken !== undefined) defaults.gateway_token = overrides.gatewayToken;
  if (overrides.deviceToken !== undefined) defaults.token = overrides.deviceToken;
  if (overrides.timeoutMs !== undefined) defaults.timeout_ms = overrides.timeoutMs;
  return { entry, defaults };
}
