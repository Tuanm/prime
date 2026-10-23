// `prime connect` - connect THIS machine to a gateway as an anonymous device.
//
//   1. resolve the gateway (--gateway > environment > config defaults > managed default)
//   2. reuse the anonymous device saved for that gateway, unless --new
//      (the gateway caps the total number of devices, so repeated runs must not
//      burn a new one each time); a saved device the gateway rejects (401) is
//      replaced automatically
//   3. otherwise POST /api/devices/anonymous and save { gateway, id, token }
//   4. print the device id, code and connect URL
//   5. run the bundled code-mcp in the foreground as that device

import { createServer } from "node:net";
import { bool, num, str } from "./args.ts";
import { GATEWAY_TOKEN_ENV, PARENT_PID_ENV, RAW_ENV, selfCommand } from "./code-mcp-host.ts";
import { type Config, type DeviceEntry, saveConfig } from "./config.ts";
import { type Ctx } from "./context.ts";
import { AuthError, CliError, TimeoutError, UsageError } from "./errors.ts";
import { bold, cyan, dim, green, printJson, yellow } from "./output.ts";
import { ENV, assertDeviceId, normalizeGateway, resolveGateway } from "./target.ts";

export interface AnonymousDevice {
  deviceId: string;
  token: string;
  connectUrl: string;
  wsUrl?: string;
  rateLimit?: { max: number; window_ms: number };
}

/** Request budget for the registration and the credential probe. */
const CONNECT_TIMEOUT_MS = 20_000;

export function connectUrlFor(gateway: string, deviceId: string, token: string): string {
  return `${gateway}/device/${encodeURIComponent(deviceId)}?token=${encodeURIComponent(token)}`;
}

function errorField(text: string): { error?: string; retryAfterMs?: number; maxDevices?: number } {
  try {
    const j = JSON.parse(text) as { error?: unknown; retry_after_ms?: unknown; max_devices?: unknown };
    return {
      error: typeof j.error === "string" ? j.error : undefined,
      retryAfterMs: typeof j.retry_after_ms === "number" ? j.retry_after_ms : undefined,
      maxDevices: typeof j.max_devices === "number" ? j.max_devices : undefined,
    };
  } catch {
    return {};
  }
}

/** "45 s", "12 min", "2 h 5 min" */
export function formatDuration(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.ceil(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
}

/** Retry delay from the Retry-After header (seconds or HTTP date) or the body. */
export function retryAfterMs(headers: Headers, bodyRetryMs?: number): number | undefined {
  const header = headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return bodyRetryMs;
}

/**
 * Interpret the gateway's answer to POST /api/devices/anonymous. Pure, so the
 * whole contract (201 + every documented failure) is unit-testable.
 */
export function parseAnonymousResponse(gateway: string, status: number, headers: Headers, text: string): AnonymousDevice {
  const detail = errorField(text);
  if (status === 201 || status === 200) {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new CliError(`gateway returned a non-JSON registration (HTTP ${status})`, text.slice(0, 200) || undefined);
    }
    const deviceId = body.deviceId;
    const token = body.token;
    if (typeof deviceId !== "string" || typeof token !== "string" || token.length === 0) {
      throw new CliError("gateway registration response is missing deviceId/token", text.slice(0, 200));
    }
    assertDeviceId(deviceId);
    const rate = body.rate_limit as { max?: unknown; window_ms?: unknown } | undefined;
    return {
      deviceId,
      token,
      // The documented URL is authoritative, but never trust it to point
      // elsewhere than the gateway we asked: rebuild it if it does.
      connectUrl:
        typeof body.connect_url === "string" && body.connect_url.startsWith(`${gateway}/`)
          ? body.connect_url
          : connectUrlFor(gateway, deviceId, token),
      wsUrl: typeof body.ws_url === "string" ? body.ws_url : undefined,
      rateLimit:
        rate && typeof rate.max === "number" && typeof rate.window_ms === "number"
          ? { max: rate.max, window_ms: rate.window_ms }
          : undefined,
    };
  }
  switch (status) {
    case 401:
      throw new AuthError(
        "the gateway requires a gateway token to create devices (401)",
        `Pass --gateway-token <token> (or set ${ENV.gatewayToken}).`,
      );
    case 403:
      throw new AuthError(
        `anonymous devices are disabled on ${gateway}` + (detail.error && !/disabled/.test(detail.error) ? ` (${detail.error})` : ""),
        "Ask the gateway operator for a registered device id and token, then: prime devices connect <id> --token <token>",
      );
    case 404:
    case 405:
      throw new CliError(
        `${gateway} does not support anonymous devices (HTTP ${status})`,
        "The gateway may be an older version, or the URL is not a prime-gateway origin.",
      );
    case 429: {
      const wait = retryAfterMs(headers, detail.retryAfterMs);
      // The creation limit (per client IP, per hour) says when to come back;
      // the gateway's general request limiter does not.
      if (wait !== undefined) {
        throw new CliError(
          `too many anonymous devices created from this network (429); retry in ${formatDuration(wait)}`,
          "Reuse the device you already have (run 'prime connect' without --new), or wait and retry.",
        );
      }
      throw new CliError("rate limited by the gateway (429)", "Too many requests from this network; retry in a minute.");
    }
    case 503:
      if (detail.error && /limit/i.test(detail.error)) {
        throw new CliError(
          `the gateway's device limit is reached${detail.maxDevices !== undefined ? ` (${detail.maxDevices} devices)` : ""}`,
          "No new devices can be created until unused ones expire (an unused anonymous device is removed after about an hour). Retry later, or ask the operator.",
        );
      }
      throw new CliError(`gateway unavailable (503)${detail.error ? `: ${detail.error}` : ""}`, "Retry shortly.");
    default:
      throw new CliError(`gateway error HTTP ${status}${detail.error ? `: ${detail.error}` : ""}`);
  }
}

function transportError(gateway: string, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new TimeoutError(`the gateway at ${gateway} did not answer within ${CONNECT_TIMEOUT_MS / 1000} s`, "Check your network and retry.");
  }
  return new CliError(
    `cannot reach the gateway at ${gateway}: ${message}`,
    "Check the URL (--gateway), your network, and any proxy.",
  );
}

function authHeaders(gatewayToken: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { "user-agent": "prime-gateway-cli", accept: "application/json" };
  if (gatewayToken) headers.authorization = `Bearer ${gatewayToken}`;
  return headers;
}

export async function registerAnonymous(gateway: string, gatewayToken: string | undefined): Promise<AnonymousDevice> {
  let response: Response;
  try {
    response = await fetch(`${gateway}/api/devices/anonymous`, {
      method: "POST",
      headers: { ...authHeaders(gatewayToken), "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
  } catch (err) {
    throw transportError(gateway, err);
  }
  return parseAnonymousResponse(gateway, response.status, response.headers, await response.text());
}

export type ProbeVerdict = "valid" | "online" | "rejected" | "disabled" | "locked" | "unknown";

/**
 * Is a saved anonymous credential still accepted? A ping through the relay
 * answers without the device being connected: the gateway checks the device
 * code before it looks for a tunnel, so 503 (offline) still proves the code,
 * while a deleted/expired device or a wrong code gets 401.
 */
export async function probeCredential(
  gateway: string,
  deviceId: string,
  token: string,
  gatewayToken: string | undefined,
): Promise<{ verdict: ProbeVerdict; status?: number; detail?: string }> {
  let response: Response;
  try {
    response = await fetch(`${gateway}/device/${encodeURIComponent(deviceId)}`, {
      method: "POST",
      headers: { ...authHeaders(gatewayToken), "content-type": "application/json", "x-device-token": token },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
  } catch (err) {
    throw transportError(gateway, err);
  }
  const text = await response.text();
  const detail = errorField(text).error;
  return { verdict: classifyProbe(response.status, detail), status: response.status, detail };
}

export function classifyProbe(status: number, detail: string | undefined): ProbeVerdict {
  if (status === 200 || status === 204) return "online";
  if (status === 503) return detail && /busy/i.test(detail) ? "online" : "valid";
  if (status === 401) return "rejected";
  if (status === 403) return "disabled";
  if (status === 429) return detail && /fail/i.test(detail) ? "locked" : "unknown";
  return "unknown";
}

/** The most recently saved anonymous device for this gateway, if any. */
export function findSavedAnonymous(config: Config, gateway: string): { deviceId: string; entry: DeviceEntry } | undefined {
  const matches = Object.entries(config.devices)
    .filter(([, entry]) => entry.anonymous === true && typeof entry.token === "string")
    .filter(([, entry]) => {
      try {
        return normalizeGateway(entry.gateway ?? config.defaults.gateway ?? "") === gateway;
      } catch {
        return false;
      }
    })
    .sort(([a, x], [b, y]) => (y.connected_at ?? "").localeCompare(x.connected_at ?? "") || a.localeCompare(b));
  const first = matches[0];
  return first ? { deviceId: first[0], entry: first[1] } : undefined;
}

/** Record an anonymous device in the config (gateway always stored explicitly). */
export function rememberAnonymous(config: Config, gateway: string, device: { deviceId: string; token: string }, gatewayToken: string | undefined, now: string): void {
  config.devices[device.deviceId] = {
    gateway,
    ...(gatewayToken ? { gateway_token: gatewayToken } : {}),
    token: device.token,
    connected_at: now,
    note: "anonymous device created by 'prime connect'",
    anonymous: true,
  };
}

/** An unused local TCP port for code-mcp's own HTTP listener. */
export function freePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/** Flags that `prime connect` sets itself and must not be overridden after "--". */
const RESERVED_CODE_MCP_FLAGS = ["--gateway", "--id", "--gateway-token"];

export async function connectCommand(ctx: Ctx, passthrough: string[]): Promise<void> {
  const extra = ctx.parsed.positionals.slice(1, ctx.parsed.positionals.length - passthrough.length);
  if (extra.length > 0) {
    throw new UsageError(`unexpected argument "${extra[0]}"`, "Usage: prime connect [--gateway <url>] [--new] [-- <code-mcp flags>]");
  }
  for (const arg of passthrough) {
    const name = arg.split("=")[0]!;
    if (RESERVED_CODE_MCP_FLAGS.includes(name)) {
      throw new UsageError(`${name} cannot be passed to code-mcp: 'prime connect' sets it`, "Use 'prime connect --gateway <url>' to choose the gateway.");
    }
  }

  const gateway = resolveGateway(ctx.config, str(ctx.parsed, "gateway"));
  const gatewayToken = str(ctx.parsed, "gateway-token") || process.env[ENV.gatewayToken] || ctx.config.defaults.gateway_token || undefined;
  const forceNew = bool(ctx.parsed, "new");
  const start = !bool(ctx.parsed, "no-start");

  let device: AnonymousDevice | undefined;
  let reused = false;
  let replaced: string | undefined;

  const saved = forceNew ? undefined : findSavedAnonymous(ctx.config, gateway);
  if (saved) {
    const token = saved.entry.token!;
    const savedGatewayToken = gatewayToken ?? saved.entry.gateway_token;
    const probe = await probeCredential(gateway, saved.deviceId, token, savedGatewayToken);
    switch (probe.verdict) {
      case "valid":
      case "online":
      case "unknown":
        device = { deviceId: saved.deviceId, token, connectUrl: connectUrlFor(gateway, saved.deviceId, token) };
        reused = true;
        if (probe.verdict === "online") {
          ctx.note(yellow(`warning: ${saved.deviceId} is already online - another 'prime connect' may be running; this one will take over the tunnel.`));
        } else if (probe.verdict === "unknown") {
          ctx.note(dim(`note: could not verify the saved device (HTTP ${probe.status}${probe.detail ? `: ${probe.detail}` : ""}); using it anyway.`));
        }
        break;
      case "rejected":
        // Deleted (unused for an hour, or offline for 7 days), or removed by the
        // admin: the id is gone for good, so replace it.
        ctx.note(yellow(`The gateway no longer accepts the saved device ${saved.deviceId} (401); registering a new anonymous device.`));
        replaced = saved.deviceId;
        delete ctx.config.devices[saved.deviceId];
        break;
      case "disabled":
        throw new AuthError(
          `the saved device ${saved.deviceId} is disabled by the gateway operator (403)`,
          "Run 'prime connect --new' to register a different device, or ask the operator to re-enable it.",
        );
      case "locked":
        throw new CliError(
          `the saved device ${saved.deviceId} is temporarily locked after too many failed attempts (429)`,
          "Retry in about 10 minutes, or run 'prime connect --new'.",
        );
    }
  }

  if (!device) {
    device = await registerAnonymous(gateway, gatewayToken);
  }
  rememberAnonymous(ctx.config, gateway, device, gatewayToken ?? (reused ? saved?.entry.gateway_token : undefined), new Date().toISOString());
  saveConfig(ctx.configPath, ctx.config);

  if (ctx.json) {
    printJson({
      device: device.deviceId,
      token: device.token,
      gateway,
      connect_url: device.connectUrl,
      ...(device.wsUrl ? { ws_url: device.wsUrl } : {}),
      anonymous: true,
      reused,
      ...(replaced ? { replaced } : {}),
      ...(device.rateLimit ? { rate_limit: device.rateLimit } : {}),
      config_path: ctx.configPath,
      starting: start,
    });
  } else {
    ctx.out(`${green("✓")} ${reused ? "using saved anonymous device" : "registered anonymous device"} ${bold(device.deviceId)}`);
    ctx.out(`  device id    ${bold(device.deviceId)}`);
    ctx.out(`  device code  ${bold(device.token)}`);
    ctx.out(`  gateway      ${gateway}`);
    ctx.out(`  connect url  ${cyan(device.connectUrl)}`);
    ctx.out(`  config       ${dim(ctx.configPath)}`);
    if (device.rateLimit) ctx.out(dim(`  rate limit   ${device.rateLimit.max} requests per ${formatDuration(device.rateLimit.window_ms)}`));
    ctx.out("");
    ctx.out(dim("  Use it from any MCP client (keep the URL secret - it grants shell access):"));
    ctx.out(dim(`    claude mcp add --transport http ${device.deviceId} "${device.connectUrl}"`));
    ctx.out(dim(`    prime tools list ${device.deviceId}      prime serve   (all devices as one MCP server)`));
  }
  if (!start) return;

  const port = num(ctx.parsed, "port") ?? (await freePort());
  const { command, env } = codeMcpLaunch(gateway, device, port, passthrough);
  if (!ctx.json) ctx.out(dim(`\nStarting code-mcp as ${device.deviceId} (local port ${port}). Press Ctrl-C to stop.\n`));
  process.exitCode = await runForeground(command, env);
}

/**
 * The child that runs code-mcp as the device. The device code travels in the
 * environment (GATEWAY_TOKEN_ENV), never on the command line where ps would
 * show it; "prime code-mcp" turns it back into --gateway-token in-process.
 */
export function codeMcpLaunch(
  gateway: string,
  device: { deviceId: string; token: string },
  port: number,
  passthrough: string[],
): { command: string[]; env: Record<string, string | undefined> } {
  return {
    command: [
      ...selfCommand(),
      "code-mcp",
      "--gateway", gateway,
      "--id", device.deviceId,
      "--port", String(port),
      "--bind", "127.0.0.1",
      ...passthrough,
    ],
    // The parent pid lets the child stop itself if this process is killed
    // outright (on Windows, killing a process never takes its children).
    // RAW: connect's device runs with exactly these arguments - not the config's
    // code-mcp section, and not refused when the code-prime service is running.
    // NODE_USE_SYSTEM_CA: trust the OS certificate store as well (where an
    // organisation installs its root certificate), unless the user set it.
    env: { NODE_USE_SYSTEM_CA: "1", ...process.env, [GATEWAY_TOKEN_ENV]: device.token, [PARENT_PID_ENV]: String(process.pid), [RAW_ENV]: "1" },
  };
}

const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };

/** Run a child with inherited stdio; forward signals; resolve to its exit code. */
export async function runForeground(command: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env });
  // A terminal Ctrl-C reaches the whole foreground process group, child
  // included; forwarding covers signals sent to this process alone (kill, a
  // supervisor). code-mcp ignores a repeated signal while it shuts down.
  const forward = (signal: NodeJS.Signals) => () => {
    try {
      child.kill(signal);
    } catch {}
  };
  const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => {
    const handler = forward(signal);
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  const code = await child.exited;
  for (const [signal, handler] of handlers) process.off(signal, handler);
  if (child.signalCode) return 128 + (SIGNAL_NUMBERS[child.signalCode] ?? 1);
  return code ?? 1;
}
