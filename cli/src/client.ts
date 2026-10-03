// Transport: JSON-RPC over the gateway's MCP relay (`POST {gateway}/mcp/{deviceId}`).
//
// The gateway tunnels the body to the device over its WebSocket and returns the
// device's JSON-RPC response verbatim. One command = one HTTP round trip unless
// the server insists on an MCP handshake first (see HandshakeMode).

import {
  AuthError,
  CliError,
  McpError,
  OfflineError,
  TimeoutError,
} from "./errors.ts";
import type { Target } from "./target.ts";

export const MCP_PROTOCOL_VERSION = "2024-11-05";

/** Total attempts for a call, including the first one. */
export const MAX_ATTEMPTS = 3;

/**
 * Is this failure safe to retry?
 *
 * Only failures that provably happened *before* the request reached the tool:
 * a rate limit or a full pending queue are rejected at the gateway, and a 502
 * means the tunnel send itself failed. A timeout is NOT retryable - the tool
 * may still be running - and neither is a dropped connection, for the same
 * reason. Retrying those would duplicate side effects.
 */
export function isSafeToRetry(status: number, body: string): boolean {
  if (status === 429) return true; // rate limited, never forwarded
  if (status === 502) return true; // tunnel send failed
  if (status === 503) return /device busy/i.test(body); // pending queue full, never forwarded
  return false;
}

/** Exponential backoff with jitter, capped so a retry never stalls a batch. */
export function backoffFor(attempt: number): number {
  return Math.min(1000, 200 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 100);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * MCP servers SHOULD reject requests before `initialize`. Current code-mcp
 * devices do not enforce that, so paying a second round trip on every command
 * would be waste. `auto` therefore tries the direct call first and only
 * handshakes when the server actually complains about it.
 */
export type HandshakeMode = "auto" | "always" | "never";

export interface CallOptions {
  handshake?: HandshakeMode;
  timeoutMs?: number;
}

export interface CallTrace {
  /** Wall-clock time for the last HTTP round trip, in milliseconds. */
  ms: number;
  method: string;
}

export class GatewayClient {
  readonly target: Target;
  private lastMs = 0;
  private lastAttemptCount = 0;
  private handshaken = false;

  constructor(target: Target) {
    this.target = target;
  }

  get lastRoundTripMs(): number {
    return this.lastMs;
  }

  /** Attempts used by the most recent call (1 = no retry was needed). */
  get lastAttempts(): number {
    return this.lastAttemptCount;
  }

  set lastAttempts(value: number) {
    this.lastAttemptCount = value;
  }

  private endpoint(): string {
    return `${this.target.gateway}/mcp/${encodeURIComponent(this.target.deviceId)}`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "code-mcp-gateway-cli",
    };
    // Gateway credential (entry auth) and device credential are distinct: the
    // entry checks the first, the DeviceDO forwards the second to the device.
    if (this.target.gatewayToken) headers.authorization = `Bearer ${this.target.gatewayToken}`;
    if (this.target.deviceToken) headers["x-device-token"] = this.target.deviceToken;
    return headers;
  }

  /** Raw JSON-RPC call. Returns the `result`; throws McpError on a JSON-RPC error. */
  async rpc(method: string, params?: unknown, opts: CallOptions = {}): Promise<unknown> {
    const timeoutMs = opts.timeoutMs ?? this.target.timeoutMs;
    const isNotification = method.startsWith("notifications/");
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: isNotification ? null : 1,
      method,
      ...(params === undefined ? {} : { params }),
    });

    // One signal for the whole call, not per attempt: --timeout is the budget
    // the user asked for, so retries must fit inside it rather than multiply it.
    const signal = AbortSignal.timeout(timeoutMs);
    const deadline = performance.now() + timeoutMs;
    this.lastAttempts = 0;

    const started = performance.now();
    for (let attempt = 1; ; attempt++) {
      this.lastAttempts = attempt;
      let response: Response;
      try {
        response = await fetch(this.endpoint(), { method: "POST", headers: this.headers(), body, signal });
      } catch (err) {
        this.lastMs = Math.round(performance.now() - started);
        // Never retried: a dropped connection may have reached the device, and
        // re-sending a side-effecting tool call would duplicate it.
        throw this.transportError(err, timeoutMs);
      }
      this.lastMs = Math.round(performance.now() - started);

      if (response.status === 204) return undefined; // notification acknowledged
      const text = await response.text();

      if (!response.ok) {
        const error = this.httpError(response.status, text);
        if (attempt >= MAX_ATTEMPTS || !isSafeToRetry(response.status, text)) throw error;
        const backoffMs = backoffFor(attempt);
        if (performance.now() + backoffMs >= deadline) throw error;
        await sleep(backoffMs);
        continue;
      }
      return this.parseBody(response.status, text);
    }
  }

  private parseBody(status: number, text: string): unknown {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CliError(
        `gateway returned a non-JSON response (HTTP ${status})`,
        text.length > 0 ? `Body: ${text.slice(0, 200)}` : undefined,
      );
    }

    const envelope = parsed as { result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
    if (envelope.error) {
      throw new McpError(
        typeof envelope.error.code === "number" ? envelope.error.code : -32000,
        envelope.error.message ?? "device returned an error",
        envelope.error.data,
      );
    }
    return envelope.result;
  }

  /** Run `fn` directly, retrying once after an `initialize` handshake if needed. */
  async withHandshake<T>(fn: () => Promise<T>, mode: HandshakeMode = "auto"): Promise<T> {
    if (mode === "never") return fn();
    if (mode === "always") {
      await this.handshake();
      return fn();
    }
    try {
      return await fn();
    } catch (err) {
      if (!this.handshaken && isInitializationComplaint(err)) {
        await this.handshake();
        return fn();
      }
      throw err;
    }
  }

  async handshake(opts: CallOptions = {}): Promise<void> {
    if (this.handshaken) return;
    await this.rpc(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "code-mcp-gateway-cli", version: "0.1.0" },
      },
      opts,
    );
    this.handshaken = true;
    // Best-effort notification; a device that does not implement it is fine.
    try {
      await this.rpc("notifications/initialized", {}, opts);
    } catch {}
  }

  async listTools(opts: CallOptions = {}): Promise<{ name: string; description?: string; inputSchema?: unknown }[]> {
    const result = (await this.withHandshake(() => this.rpc("tools/list", {}, opts), opts.handshake)) as
      | { tools?: unknown }
      | undefined;
    const tools = result && typeof result === "object" && Array.isArray((result as { tools?: unknown }).tools)
      ? ((result as { tools: unknown[] }).tools as Record<string, unknown>[])
      : [];
    return tools
      .filter((t) => t && typeof t === "object" && typeof t.name === "string")
      .map((t) => ({
        name: t.name as string,
        description: typeof t.description === "string" ? t.description : undefined,
        inputSchema: t.inputSchema,
      }));
  }

  async callTool(name: string, args: unknown, opts: CallOptions = {}): Promise<unknown> {
    return this.withHandshake(
      () => this.rpc("tools/call", { name, arguments: args ?? {} }, opts),
      opts.handshake,
    );
  }

  private transportError(err: unknown, timeoutMs: number): Error {
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError" || /timed? ?out|abort/i.test(message)) {
      return new TimeoutError(
        `request timed out after ${timeoutMs} ms`,
        "Raise it with --timeout <ms>, or set a longer TIMEOUT_MS on the gateway.",
      );
    }
    return new CliError(
      `cannot reach the gateway at ${this.target.gateway}: ${message}`,
      "Check the URL, your network, and any proxy; a 401/404 from the gateway means it is reachable but rejected the request.",
    );
  }

  private httpError(status: number, text: string): Error {
    const detail = errorDetail(text);
    switch (status) {
      case 401:
        return new AuthError(
          "unauthorized" + (detail ? `: ${detail}` : ""),
          "Check --gateway-token (gateway credential) and --token (device credential). Run 'mcp devices connect' to update them.",
        );
      case 404:
        return new CliError(
          "gateway endpoint not found (404)" + (detail ? `: ${detail}` : ""),
          "Verify the gateway URL - it should be the Worker origin, e.g. https://code-mcp.tuanm.workers.dev",
        );
      case 405:
        return new CliError("gateway rejected the request method (405)");
      case 413:
        return new CliError("arguments too large for the gateway (413)", "MAX_BODY_BYTES caps the relayed body.");
      case 429:
        return new CliError("rate limited by the gateway (429)", "Retry shortly, or raise RATE_LIMIT_MAX on the gateway.");
      case 503:
        return new OfflineError(
          detail === "device busy" ? "device is busy (too many in-flight requests)" : "device is offline",
          `No live tunnel for "${this.target.deviceId}". Start the device (e.g. the Browser MCP extension) and confirm it shows Connected, then retry.`,
        );
      case 502:
        return new CliError("device send failed (502)", "The tunnel dropped mid-request; retry.");
      case 504:
        return new TimeoutError("gateway timed out waiting for the device (504)");
      default:
        return new CliError(`gateway error HTTP ${status}${detail ? `: ${detail}` : ""}`);
    }
  }
}

function errorDetail(text: string): string | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { error?: unknown; hint?: unknown };
    if (typeof parsed.error === "string") {
      return typeof parsed.hint === "string" ? `${parsed.error} - ${parsed.hint}` : parsed.error;
    }
  } catch {}
  return text.slice(0, 200);
}

/** Did the device reject us for not having initialized the session? */
function isInitializationComplaint(err: unknown): boolean {
  if (err instanceof McpError) {
    if (err.code === -32002) return true; // "Server not initialized"
    return /initiali[sz]/i.test(err.message);
  }
  return false;
}
