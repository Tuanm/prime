// `prime devices ...` - connect, disconnect, status, list, rotate-code.

import { bool, num } from "./args.ts";
import { GatewayClient } from "./client.ts";
import { type Ctx, overridesFrom, targetFor } from "./context.ts";
import { saveConfig } from "./config.ts";
import { UsageError, exitCodeOf } from "./errors.ts";
import { bold, dim, green, printJson, red, table, yellow } from "./output.ts";
import { formatDuration, rotateAnonymousCode } from "./connect.ts";
import { assertDeviceId, entryFromOverrides } from "./target.ts";

/** Is this error the device answering (as opposed to a transport failure)? */
function isDeviceAnswer(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { name?: string }).name === "McpError");
}

/**
 * Probe a device with `ping` - the cheapest MCP request.
 *
 * A JSON-RPC error still proves the device is online and answering, which is why
 * only transport-level failures count as "offline".
 */
async function probe(
  ctx: Ctx,
  deviceId: string,
  timeoutMs?: number,
): Promise<{ online: boolean; latencyMs: number; error?: string }> {
  const overrides = overridesFrom(ctx.parsed);
  if (timeoutMs !== undefined) overrides.timeoutMs = timeoutMs;
  const target = targetFor(ctx, deviceId, overrides);
  const started = performance.now();
  try {
    await new GatewayClient(target).rpc("ping", {}, { timeoutMs: target.timeoutMs });
    return { online: true, latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    if (isDeviceAnswer(err)) return { online: true, latencyMs };
    return { online: false, latencyMs, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function devicesConnect(ctx: Ctx): Promise<void> {
  const positionals = ctx.parsed.positionals.slice(2); // drop "devices connect"
  if (positionals.length === 0) {
    throw new UsageError("missing <device-id>", "Usage: prime devices connect <device-id> [--token <t>] [--gateway <url>]");
  }
  if (positionals.length > 1) throw new UsageError(`unexpected argument "${positionals[1]}"`);
  const deviceId = assertDeviceId(positionals[0]!);

  const overrides = overridesFrom(ctx.parsed);
  const setDefault = bool(ctx.parsed, "set-default");
  const verify = !bool(ctx.parsed, "no-verify");

  const { entry, defaults } = entryFromOverrides(overrides, new Date().toISOString());
  // Merge rather than replace: re-running connect without --token must keep the
  // credentials already stored for this device.
  ctx.config.devices[deviceId] = { ...(ctx.config.devices[deviceId] ?? {}), ...entry };
  if (setDefault) ctx.config.defaults = { ...ctx.config.defaults, ...defaults };
  saveConfig(ctx.configPath, ctx.config);

  const stored = ctx.config.devices[deviceId]!;
  const gateway = stored.gateway ?? ctx.config.defaults.gateway;
  const token = stored.token ?? ctx.config.defaults.token;
  const result = verify ? await probe(ctx, deviceId) : undefined;

  if (ctx.json) {
    printJson({
      device: deviceId,
      gateway: gateway ?? null,
      token_configured: Boolean(token),
      configured: true,
      config_path: ctx.configPath,
      set_default: setDefault,
      ...(result ? { online: result.online, latency_ms: result.latencyMs, ...(result.error ? { error: result.error } : {}) } : {}),
    });
    return;
  }

  ctx.out(`${green("✓")} configured ${bold(deviceId)}`);
  ctx.out(`  config    ${dim(ctx.configPath)}`);
  if (gateway) ctx.out(`  gateway   ${gateway}`);
  ctx.out(`  token     ${token ? dim("set") : yellow("not set")}`);
  if (!result) return;
  if (result.online) {
    ctx.out(`  status    ${green("online")} ${dim(`${result.latencyMs} ms`)}`);
    return;
  }
  ctx.out(`  status    ${red("offline")}`);
  if (result.error) ctx.note(dim(`  ${result.error}`));
  ctx.note(dim(`  Saved anyway - start the device, then: prime devices status ${deviceId}`));
}

export async function devicesDisconnect(ctx: Ctx): Promise<void> {
  const positionals = ctx.parsed.positionals.slice(2);
  if (positionals.length === 0) throw new UsageError("missing <device-id>", "Usage: prime devices disconnect <device-id>");
  const deviceId = assertDeviceId(positionals[0]!);
  const existed = deviceId in ctx.config.devices;
  if (existed) {
    delete ctx.config.devices[deviceId];
    saveConfig(ctx.configPath, ctx.config);
  }
  if (ctx.json) {
    printJson({ device: deviceId, removed: existed, config_path: ctx.configPath });
    return;
  }
  ctx.out(existed ? `${green("✓")} removed ${bold(deviceId)} from ${dim(ctx.configPath)}` : dim(`${deviceId} was not configured`));
}

export async function devicesStatus(ctx: Ctx): Promise<void> {
  const positionals = ctx.parsed.positionals.slice(2);
  if (positionals.length === 0) throw new UsageError("missing <device-id>", "Usage: prime devices status <device-id>");
  const deviceId = assertDeviceId(positionals[0]!);
  const target = targetFor(ctx, deviceId, overridesFrom(ctx.parsed));

  const started = performance.now();
  let failure: unknown;
  let answered = false;
  try {
    await new GatewayClient(target).rpc("ping", {});
    answered = true;
  } catch (err) {
    if (isDeviceAnswer(err)) answered = true;
    else failure = err;
  }
  const latencyMs = Math.round(performance.now() - started);

  if (ctx.json) {
    printJson({
      device: deviceId,
      gateway: target.gateway,
      online: answered,
      latency_ms: latencyMs,
      token_configured: Boolean(target.deviceToken),
      gateway_token_configured: Boolean(target.gatewayToken),
      ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}),
    });
    if (!answered) process.exitCode = exitCodeOf(failure);
    return;
  }
  if (!answered) throw failure; // human mode: the error carries an actionable hint

  ctx.out(`${green("●")} ${bold(deviceId)} ${green("online")} ${dim(`${latencyMs} ms`)}`);
  ctx.out(`  ${target.localUrl ? "local MCP" : "gateway"} ${target.localUrl ?? target.gateway}`);
}

export async function devicesList(ctx: Ctx): Promise<void> {
  const ids = Object.keys(ctx.config.devices).sort();
  const noProbe = bool(ctx.parsed, "no-probe");
  if (ids.length === 0) {
    if (ctx.json) {
      printJson({ devices: [], config_path: ctx.configPath });
      return;
    }
    ctx.out(dim(`No devices configured in ${ctx.configPath}`));
    ctx.out(dim("Add one with: prime devices connect <device-id> --token <token> --gateway <url>"));
    return;
  }

  // A listing must never hang: offline devices answer 503 immediately, so a
  // short probe timeout only caps the pathological "reachable but stuck" case.
  const probeTimeout = num(ctx.parsed, "timeout") ?? 5000;
  const entries = ids.map((id) => ({ id, entry: ctx.config.devices[id]! }));
  const results = noProbe
    ? entries.map((e) => ({ id: e.id, online: undefined as boolean | undefined, latencyMs: 0, error: undefined as string | undefined }))
    : await Promise.all(entries.map(async (e) => ({ id: e.id, ...(await probe(ctx, e.id, probeTimeout)) })));

  const describe = (id: string) => {
    const entry = ctx.config.devices[id]!;
    return {
      gateway: entry.local_url ?? entry.gateway ?? ctx.config.defaults.gateway ?? null,
      token: entry.token ?? ctx.config.defaults.token,
      local: Boolean(entry.local_url),
      ...(entry.space ? { space: entry.space } : {}),
    };
  };

  if (ctx.json) {
    printJson({
      config_path: ctx.configPath,
      devices: results.map((r) => {
        const info = describe(r.id);
        return {
          device: r.id,
          gateway: info.gateway,
          token_configured: Boolean(info.token),
          ...(info.local ? { local: true } : {}),
          ...(info.space ? { space: info.space } : {}),
          ...(noProbe ? {} : { online: r.online, latency_ms: r.latencyMs, ...(r.error ? { error: r.error } : {}) }),
        };
      }),
    });
    return;
  }

  const rows = results.map((r) => {
    const info = describe(r.id);
    const gateway = info.gateway ? (info.local ? green("local ") + info.gateway : info.gateway) : dim("-");
    if (noProbe) return [bold(r.id), dim("unknown"), dim("-"), gateway];
    return [
      bold(r.id),
      r.online ? green("online") : red("offline"),
      r.online ? dim(`${r.latencyMs} ms`) : dim("-"),
      gateway,
    ];
  });
  ctx.out(table(["DEVICE", "STATUS", "LATENCY", "GATEWAY"], rows));
  if (!noProbe) ctx.note(dim(`${results.filter((r) => r.online).length}/${results.length} online`));
}

/**
 * `prime devices rotate-code <device-id>` - give an anonymous device a new 25-character code.
 *
 * A device made when codes were six characters keeps one that can be guessed online by enough
 * addresses. The gateway makes a new one when the device shows the code it has; the old one goes on
 * working for a day. The new code is saved here (the device's entry, and each space that is exposed
 * as the device); what is already running holds the old code and must be restarted within the day.
 */
export async function devicesRotateCode(ctx: Ctx): Promise<void> {
  const positionals = ctx.parsed.positionals.slice(2);
  if (positionals.length === 0) throw new UsageError("missing <device-id>", "Usage: prime devices rotate-code <device-id> [--gateway <url>]");
  if (positionals.length > 1) throw new UsageError(`unexpected argument "${positionals[1]}"`);
  const deviceId = assertDeviceId(positionals[0]!);
  const target = targetFor(ctx, deviceId, overridesFrom(ctx.parsed));
  if (!target.deviceToken) {
    throw new UsageError(`no token is saved for "${deviceId}"`, "Only a device this machine holds the code of can be given a new one.");
  }
  const entry = ctx.config.devices[deviceId];
  if (entry && entry.anonymous === false) {
    throw new UsageError(`"${deviceId}" is a registered device, not an anonymous one`, "Only an anonymous device's code can be made again.");
  }

  const made = await rotateAnonymousCode(target.gateway, deviceId, target.deviceToken, target.gatewayToken);

  // Saved before anything is printed: the new code exists only here from now on.
  ctx.config.devices[deviceId] = { ...(entry ?? {}), token: made.token };
  const spaces: string[] = [];
  for (const [name, space] of Object.entries(ctx.config.spaces)) {
    if (space.gateway_device === deviceId) {
      space.remote_token = made.token;
      spaces.push(name);
    }
  }
  saveConfig(ctx.configPath, ctx.config);

  const grace = made.previousValidMs !== undefined ? formatDuration(made.previousValidMs) : "a day";
  if (ctx.json) {
    printJson({ device: deviceId, rotated: true, previous_valid_ms: made.previousValidMs ?? null, spaces, config_path: ctx.configPath });
    return;
  }
  ctx.out(`${green("✓")} ${bold(deviceId)} has a new 25-character code, saved to ${dim(ctx.configPath)}`);
  ctx.out(dim(`  the old code keeps working for ${grace}`));
  if (spaces.length > 0) ctx.out(`  spaces exposed as it: ${spaces.join(", ")} - stop and start each within ${grace}, so that it holds the new code`);
  ctx.out(`  anything else that holds the old code (a running buddy, 'prime fleets' agent) - restart it within ${grace}`);
}
