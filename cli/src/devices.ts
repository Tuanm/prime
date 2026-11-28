// `prime devices ...` - connect, disconnect, status, list, rotate-code.

import { existsSync } from "node:fs";
import { bool, num, str } from "./args.ts";
import {
  addCaller,
  callerKeyPath,
  callersPath,
  loadOrCreateCallerKey,
  parsePublicKey,
  readCallers,
  removeCaller,
  keyIdOf,
} from "./caller-key.ts";
import { GatewayClient } from "./client.ts";
import { type Ctx, overridesFrom, targetFor } from "./context.ts";
import { saveConfig, updateConfig } from "./config.ts";
import { UsageError, exitCodeOf } from "./errors.ts";
import { bold, dim, green, printJson, red, table, yellow } from "./output.ts";
import { RotateRefusedError, formatDuration, newDeviceCode, rotateAnonymousCode, type RotatedCode } from "./connect.ts";
import { DEFAULT_GATEWAY, ENV, assertDeviceId, entryFromOverrides, normalizeGateway } from "./target.ts";

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
 * addresses. The new code is made HERE and saved as `pending_token` (durably, under the config's lock)
 * before the gateway is asked, and the gateway is shown the code the device has now. The gateway takes
 * it as the device's code and keeps the old one for a day. When it confirms, `pending_token` becomes
 * `token` (and the `remote_token` of each space published as the device). If the call is cut off, or
 * this process dies between the save and the answer, running the command again sends the SAME code
 * and the gateway says it is done: no second code is made, and the old one's day is not shortened.
 *
 * Only the device's current code may ask. The code it replaced works for the day, but cannot ask:
 * a machine that finds this out has been left behind, and the operator makes the code again for it
 * (`--operator`: no code of the device is needed, and a lock on the device does not stop it).
 */
export async function devicesRotateCode(ctx: Ctx): Promise<void> {
  const positionals = ctx.parsed.positionals.slice(2);
  if (positionals.length === 0) {
    throw new UsageError("missing <device-id>", "Usage: prime devices rotate-code <device-id> [--operator] [--gateway <url>]");
  }
  if (positionals.length > 1) throw new UsageError(`unexpected argument "${positionals[1]}"`);
  const deviceId = assertDeviceId(positionals[0]!);
  const operator = bool(ctx.parsed, "operator");
  const revokePrevious = bool(ctx.parsed, "revoke-previous");
  if (revokePrevious && !operator) {
    throw new UsageError("--revoke-previous is for --operator", "A device cannot cut off its own earlier code; the operator can: --operator --revoke-previous.");
  }
  const target = targetFor(ctx, deviceId, overridesFrom(ctx.parsed));

  let operatorToken: string | undefined;
  if (operator) {
    // The same rule as the fleet commands: the operator's credential from the environment or the config goes to
    // this machine's own gateway and to no other; one named on the command line goes where the command goes.
    const own = normalizeGateway(ctx.config.defaults.gateway || process.env[ENV.gateway] || DEFAULT_GATEWAY);
    operatorToken =
      str(ctx.parsed, "operator-token") ??
      (target.gateway === own ? (process.env[ENV.fleetOperatorToken] ?? ctx.config.defaults.fleet_operator_token) : undefined);
    if (!operatorToken) {
      throw new UsageError(
        "--operator needs the gateway's operator credential",
        "Pass --operator-token <token>, or set PRIME_FLEET_OPERATOR_TOKEN (the gateway's FLEET_OPERATOR_TOKEN).",
      );
    }
  }

  // 1. The proposal, saved before anything is asked. What is read here is the file as it is now.
  const first = updateConfig(ctx.configPath, (config) => {
    const entry = config.devices[deviceId];
    if (entry && entry.anonymous === false) {
      throw new UsageError(`"${deviceId}" is a registered device, not an anonymous one`, "Only an anonymous device's code can be made again.");
    }
    const held = Object.values(config.spaces).find((s) => s.gateway_device === deviceId);
    const current = target.deviceToken ?? entry?.token ?? held?.remote_token;
    if (!operator && !current) {
      throw new UsageError(`no token is saved for "${deviceId}"`, "Only a device this machine holds the code of can be given a new one; the operator can: --operator.");
    }
    // An operator that does not hold the device does not keep what it makes: it prints it.
    const keep = !operator || entry !== undefined || held !== undefined;
    const earlier = keep ? entry?.pending_token : undefined;
    const proposed = earlier ?? newDeviceCode();
    if (keep) {
      config.devices[deviceId] = { ...(entry ?? { gateway: target.gateway, anonymous: true }), pending_token: proposed };
    }
    return { current, proposed, retry: earlier !== undefined, keep };
  });

  // 2. The call.
  let made: RotatedCode;
  try {
    made = await rotateAnonymousCode(target.gateway, deviceId, {
      token: first.current,
      proposed: first.proposed,
      gatewayToken: target.gatewayToken,
      ...(operatorToken !== undefined ? { operatorToken, revokePrevious } : {}),
    });
  } catch (err) {
    // A repeat of a call that did succeed, made after the old code's day was over (or from a config that was
    // promoted and then lost): the gateway no longer knows the old code, but the code proposed is its own.
    if (!operator && first.retry && err instanceof RotateRefusedError && first.current !== first.proposed) {
      made = await rotateAnonymousCode(target.gateway, deviceId, {
        token: first.proposed,
        proposed: first.proposed,
        gatewayToken: target.gatewayToken,
      });
    } else {
      throw err;
    }
  }

  // 3. The gateway holds it: it is the device's code here too. The file is read again, so that what another
  // command wrote in the meantime stays.
  const spaces: string[] = [];
  if (first.keep) {
    updateConfig(ctx.configPath, (config) => {
      const entry = config.devices[deviceId] ?? { gateway: target.gateway, anonymous: true };
      const { pending_token: _done, ...rest } = entry;
      config.devices[deviceId] = { ...rest, token: made.token };
      for (const [name, space] of Object.entries(config.spaces)) {
        if (space.gateway_device === deviceId) {
          space.remote_token = made.token;
          spaces.push(name);
        }
      }
    });
  }

  const revoked = operator && revokePrevious;
  const grace = made.previousValidMs !== undefined && made.previousValidMs > 0 ? formatDuration(made.previousValidMs) : "a day";
  if (ctx.json) {
    printJson({
      device: deviceId,
      rotated: true,
      repeated: made.repeated,
      saved: first.keep,
      ...(first.keep ? {} : { token: made.token }),
      previous_valid_ms: revoked ? 0 : (made.previousValidMs ?? null),
      spaces,
      config_path: ctx.configPath,
    });
    return;
  }
  if (first.keep) ctx.out(`${green("✓")} ${bold(deviceId)} has a new 25-character code, saved to ${dim(ctx.configPath)}${made.repeated ? dim(" (the gateway had it already)") : ""}`);
  else {
    ctx.out(`${green("✓")} ${bold(deviceId)} has a new 25-character code: ${bold(made.token)}`);
    ctx.out(yellow("  this machine does not hold the device, so the code is not saved: this is the only time it is shown"));
  }
  if (revoked) {
    ctx.out(yellow("  the old code stops working now: whatever holds it is refused until it is given the new one"));
    if (spaces.length > 0) ctx.out(`  spaces exposed as it: ${spaces.join(", ")} - stop and start each, so that it holds the new code`);
    ctx.out("  anything else that holds the old code (a running buddy, 'prime fleets' agent) - give it the new code and restart it");
    return;
  }
  ctx.out(dim(`  the old code keeps working for ${grace}`));
  if (spaces.length > 0) ctx.out(`  spaces exposed as it: ${spaces.join(", ")} - stop and start each within ${grace}, so that it holds the new code`);
  ctx.out(`  anything else that holds the old code (a running buddy, 'prime fleets' agent) - restart it within ${grace}`);
}

// ---- who may call this device's tools -----------------------------------------

/** The callers file this command works on: --callers, else the one the device on this machine reads. */
function callersFile(ctx: Ctx): string {
  return str(ctx.parsed, "callers") ?? callersPath(ctx.configPath);
}

/** The file's callers, or a usage error that names the file when it cannot be read. */
function callersOrFail(path: string) {
  try {
    return readCallers(path);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err), "Fix or delete the file, then run the command again.");
  }
}

export async function devicesAllowCaller(ctx: Ctx): Promise<void> {
  const positionals = ctx.parsed.positionals.slice(2);
  const self = bool(ctx.parsed, "self");
  if (positionals.length > 1) throw new UsageError(`unexpected argument "${positionals[1]}"`);
  if (self === (positionals.length === 1)) {
    throw new UsageError(
      "give the public key to allow, or --self for this machine's own",
      "Usage: prime devices allow-caller <public-key> [--label <text>] [--tools a,b | --all-tools]   (the key is what a refused call prints)",
    );
  }
  let pub: Buffer;
  if (self) {
    pub = loadOrCreateCallerKey().publicKey;
  } else {
    const given = parsePublicKey(positionals[0]!);
    if (!given) {
      throw new UsageError(
        "that is not a public key",
        "Pass the caller's public key: 43-44 characters of base64, as printed by a refused call. A key id alone is not enough.",
      );
    }
    pub = given;
  }
  const toolsText = str(ctx.parsed, "tools");
  const tools = toolsText?.split(",").map((t) => t.trim()).filter(Boolean);
  // A restriction that names no tool must not silently mean "all of them".
  if (toolsText !== undefined && (tools?.length ?? 0) === 0) {
    throw new UsageError("--tools names no tool", "Give the tools the key may call, e.g. --tools read,write; to allow every tool use --all-tools.");
  }
  const allTools = bool(ctx.parsed, "all-tools");
  if (tools && allTools) throw new UsageError("--tools and --all-tools cannot be used together");
  const path = callersFile(ctx);
  callersOrFail(path); // a malformed file is reported, not overwritten
  const { entry, added } = addCaller(path, {
    pub,
    ...(str(ctx.parsed, "label") !== undefined ? { label: str(ctx.parsed, "label")! } : {}),
    ...(tools ? { tools } : {}),
    ...(allTools ? { allTools: true } : {}),
  });
  if (ctx.json) {
    printJson({ key_id: entry.keyId, label: entry.label, tools: entry.tools ?? null, added, callers_file: path });
    return;
  }
  ctx.out(`${green("✓")} ${added ? "allowed" : "updated"} ${bold(entry.keyId)}${entry.label ? ` (${entry.label})` : ""}`);
  ctx.out(`  callers file  ${dim(path)}`);
  ctx.out(`  tools         ${entry.tools ? entry.tools.join(", ") : "all"}`);
}

export async function devicesCallers(ctx: Ctx): Promise<void> {
  const path = callersFile(ctx);
  const callers = callersOrFail(path);
  const keyPath = callerKeyPath();
  // This machine's own key is shown when it exists; listing must not make one.
  // Listing the callers does not depend on this machine's key being usable.
  let own: ReturnType<typeof loadOrCreateCallerKey> | undefined;
  let ownProblem: string | undefined;
  if (existsSync(keyPath)) {
    try {
      own = loadOrCreateCallerKey(keyPath);
    } catch (err) {
      ownProblem = err instanceof Error ? err.message : String(err);
    }
  }
  if (ctx.json) {
    printJson({
      callers_file: path,
      this_machine: own ? { key_id: own.keyId, public_key: own.publicKeyB64 } : ownProblem ? { unusable: ownProblem } : null,
      callers: callers.map((c) => ({ key_id: c.keyId, label: c.label, added_at: c.addedAt, tools: c.tools ?? null })),
    });
    return;
  }
  if (callers.length === 0) {
    ctx.out(dim(`No callers allowed in ${path}`));
    ctx.out(dim("A device with no callers runs every call; allow one with: prime devices allow-caller <public-key>"));
  } else {
    ctx.out(table(["KEY", "LABEL", "ADDED", "TOOLS"], callers.map((c) => [bold(c.keyId), c.label || dim("-"), dim(c.addedAt || "-"), c.tools ? c.tools.join(", ") : dim("all")])));
  }
  if (own) ctx.note(dim(`this machine's caller key: ${own.keyId}  ${own.publicKeyB64}`));
  else if (ownProblem) ctx.note(dim(`this machine's caller key: unusable (${ownProblem})`));
}

export async function devicesRevokeCaller(ctx: Ctx): Promise<void> {
  const positionals = ctx.parsed.positionals.slice(2);
  if (positionals.length === 0) throw new UsageError("missing <key-id>", "Usage: prime devices revoke-caller <key-id | public-key>   (see 'prime devices callers')");
  const given = positionals[0]!;
  // A public key is accepted for its id, so what was passed to allow-caller can be passed back.
  const raw = parsePublicKey(given);
  const keyId = raw ? keyIdOf(raw) : given;
  const path = callersFile(ctx);
  callersOrFail(path);
  const removed = removeCaller(path, keyId);
  if (ctx.json) {
    printJson({ key_id: keyId, removed, callers_file: path });
    return;
  }
  ctx.out(removed ? `${green("✓")} revoked ${bold(keyId)}` : dim(`${keyId} was not in ${path}`));
}
