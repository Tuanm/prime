// Shared per-invocation context: parsed flags, loaded config, output helpers.

import { type ParsedArgs, bool, num, str } from "./args.ts";
import { type Config, defaultConfigPath, loadConfig } from "./config.ts";
import { resolveTarget, type Target, type TargetOverrides } from "./target.ts";

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
