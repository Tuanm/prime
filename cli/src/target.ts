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

export function resolveTarget(config: Config, deviceId: string, overrides: TargetOverrides = {}): Target {
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
