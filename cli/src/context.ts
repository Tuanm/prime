// Shared per-invocation context: parsed flags, loaded config, output helpers.

import { type ParsedArgs, bool, num, str } from "./args.ts";
import { type Config, defaultConfigPath, loadConfig } from "./config.ts";
import { fleetCaller, resolveTarget, type Target, type TargetOverrides } from "./target.ts";

export interface Ctx {
  parsed: ParsedArgs;
  config: Config;
  configPath: string;
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  color: boolean | undefined;
  out(text: string): void;
  note(text: string): void;
}

export function makeCtx(parsed: ParsedArgs): Ctx {
  const configPath = str(parsed, "config") ?? defaultConfigPath();
  const json = bool(parsed, "json");
  const quiet = bool(parsed, "quiet");
  return {
    parsed,
    config: loadConfig(configPath),
    configPath,
    json,
    quiet,
    verbose: bool(parsed, "verbose"),
    color: bool(parsed, "no-color") ? false : undefined,
    out(text: string) {
      process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    },
    note(text: string) {
      if (!quiet) process.stderr.write(`${text.endsWith("\n") ? text : `${text}\n`}`);
    },
  };
}

export function overridesFrom(parsed: ParsedArgs): TargetOverrides {
  const overrides: TargetOverrides = {};
  const gateway = str(parsed, "gateway");
  const token = str(parsed, "token");
  const gatewayToken = str(parsed, "gateway-token");
  const timeout = num(parsed, "timeout");
  if (gateway !== undefined) overrides.gateway = gateway;
  if (token !== undefined) overrides.deviceToken = token;
  if (gatewayToken !== undefined) overrides.gatewayToken = gatewayToken;
  if (timeout !== undefined) overrides.timeoutMs = timeout;
  return overrides;
}

export function targetFor(ctx: Ctx, deviceId: string, overrides: TargetOverrides = {}): Target {
  return resolveTarget(ctx.config, deviceId, overrides);
}

/**
/**
 * The target for a call that addresses a fleet.
 *
 * A call to a fleet is made as one of the fleet's members, so the credential
 * has to be one the fleet knows. The configured devices are tried until one of
 * them answers as a member.
 */
export async function fleetTargetFor(ctx: Ctx, fleet: string, overrides: TargetOverrides = {}): Promise<Target> {
  const target = resolveTarget(ctx.config, "fleet:" + fleet, overrides);
  const caller = await fleetCaller(ctx.config, fleet, target.gateway, overrides);
  return { ...target, deviceId: caller.deviceId, deviceToken: caller.token };
}
