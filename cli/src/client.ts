// Transport: JSON-RPC over the gateway's relay (`POST {gateway}/device/{deviceId}`).
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
import { REPLY_SIG_HEADER, verifyReplySig } from "./caller-auth.ts";
import { CALL_SIG_HEADER, type CallSigner, parseCallSig } from "./caller-key.ts";
import { checkDeviceKey, deviceKeyLabel, pinnedDeviceKey } from "./device-pins.ts";
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
  private localSid?: string;
  private readonly signer: CallSigner | undefined;
  private readonly notice: (text: string) => void;
  private readonly noticed = new Set<string>();

  /**
   * `signer` signs each call that needs it with this machine's caller key (see caller-key.ts), so a device
   * that only runs calls signed by a key it trusts accepts it. Without one the call goes out unsigned.
   * `notice` hears of what is wrong with a reply that is not refused.
   */
  constructor(target: Target, options: { signer?: CallSigner; notice?: (text: string) => void } = {}) {
    this.target = target;
    this.signer = options.signer;
    this.notice = options.notice ?? ((text) => process.stderr.write(`${text}\n`));
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
    // A call to a fleet goes through the gateway's fleet route, which sends
    // it to the member that holds the lease.
    if (this.target.fleet) {
      // The device in the path is the caller; the fleet says where the call
      // should go. The gateway sends it to the member holding the lease.
      const url = new URL(this.target.gateway + "/device/" + encodeURIComponent(this.target.deviceId));
      url.searchParams.set("fleet", this.target.fleet);
      return url.toString();
    }
    return `${this.target.gateway}/device/${encodeURIComponent(this.target.deviceId)}`;
  }

  /** A space answers MCP directly on loopback/the vmnet address; no tunnel. */
  private get isLocal(): boolean {
    return Boolean(this.target.localUrl);
  }

  private async localRpc(method: string, params: unknown, opts: CallOptions): Promise<unknown> {
    const timeoutMs = opts.timeoutMs ?? this.target.timeoutMs;
    const isNotification = method.startsWith("notifications/");
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: isNotification ? null : 1,
      method,
      ...(params === undefined ? {} : { params }),
    });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "prime-cli",
    };
    if (this.target.deviceToken) headers.authorization = `Bearer ${this.target.deviceToken}`;
    if (this.localSid) headers["mcp-session-id"] = this.localSid;

    const signal = AbortSignal.timeout(timeoutMs);
    const started = performance.now();
    let response: Response;
    try {
      response = await fetch(`${this.target.localUrl}/mcp`, { method: "POST", headers, body, signal });
    } catch (err) {
      this.lastMs = Math.round(performance.now() - started);
      throw this.transportError(err, timeoutMs);
    }
    this.lastMs = Math.round(performance.now() - started);
    this.lastAttempts = 1;
    const sid = response.headers.get("mcp-session-id");
    if (sid) this.localSid = sid;
    if (response.status === 204) return undefined;
    const text = await response.text();
    if (!response.ok) throw this.httpError(response.status, text);
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("text/event-stream") ? sseLastJson(text) : text;
    return this.parseBody(response.status, payload ?? text);
  }

  private headers(method: string, body: string): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "prime-cli",
    };
    // Gateway credential (entry auth) and device credential are distinct: the
    // entry checks the first, the DeviceDO forwards the second to the device.
    if (this.target.gatewayToken) headers.authorization = `Bearer ${this.target.gatewayToken}`;
    if (this.target.deviceToken) headers["x-device-token"] = this.target.deviceToken;
    // Signed over the exact string that is sent, and again on every attempt: a retry is a new call.
    const signature = this.signer?.header(method, this.target, body);
    if (signature) headers[CALL_SIG_HEADER] = signature;
    return headers;
  }

  /** Raw JSON-RPC call. Returns the `result`; throws McpError on a JSON-RPC error. */
  async rpc(method: string, params?: unknown, opts: CallOptions = {}): Promise<unknown> {
    if (this.isLocal) return this.localRpc(method, params, opts);
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
      const headers = this.headers(method, body);
      try {
        response = await fetch(this.endpoint(), { method: "POST", headers, body, signal });
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
      this.checkReply(headers[CALL_SIG_HEADER], response.headers.get(REPLY_SIG_HEADER), text);
      return this.parseBody(response.status, text);
    }
  }

  /**
   * A device signs its reply to a signed call. Once a device has signed a reply, its key is pinned, and from then
   * on a reply of its that is unsigned, signed wrongly or signed by another key is not the device's answer, so it
   * is refused (the call has run, and the message says that). A device that has never signed is left alone: it
   * may be an older build. A fleet is answered by whichever member holds the lease, so its replies are checked
   * for a good signature only; their keys come from the fleet's roster, not from a first use.
   */
  private checkReply(callSig: string | undefined, replySig: string | null, text: string): void {
    if (!callSig) return;
    const nonce = parseCallSig(callSig)?.nonce;
    if (!nonce) return;
    const { gateway, deviceId: device } = this.target;
    const pooled = Boolean(this.target.fleet || this.target.fleetBuddy);
    let pinned: string | undefined;
    let pinsBroken = false;
    if (!pooled) {
      try {
        pinned = pinnedDeviceKey(gateway, device);
      } catch (err) {
        pinsBroken = true;
        this.once(`cannot check the keys pinned for devices: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const refuse = (what: string): never => {
      throw new CliError(
        `${device} ${what}; the call has run, but the answer may have been made by the gateway and is not shown`,
        `The key pinned for ${device} is ${deviceKeyLabel(Buffer.from(pinned!, "base64"))}. If the device really changed its key, run: prime devices callers --device ${device} --forget`,
      );
    };
    if (replySig === null) {
      if (pinned) refuse("answered a signed call without signing its reply, as it has before");
      return;
    }
    const pub = verifyReplySig(replySig, nonce, text);
    if (!pub) {
      if (pinned) refuse("answered with a signature that does not match the reply");
      this.once(`the reply from ${device} carries a signature that does not match it; the gateway may have changed the answer`);
      return;
    }
    if (pooled || pinsBroken) return;
    try {
      if (checkDeviceKey(gateway, device, pub) === "changed") refuse(`answered with a different key (${deviceKeyLabel(pub)}) from the one it first used`);
    } catch (err) {
      if (err instanceof CliError) throw err;
      this.once(`cannot pin the key of ${device}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private once(text: string): void {
    if (this.noticed.has(text)) return;
    this.noticed.add(text);
    this.notice(`prime: warning: ${text}`);
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
        clientInfo: { name: "prime-cli", version: "0.1.0" },
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
    const where = this.isLocal ? `the space's MCP server at ${this.target.localUrl}` : `the gateway at ${this.target.gateway}`;
    return new CliError(
      `cannot reach ${where}: ${message}`,
      this.isLocal
        ? "Check that the space is running ('prime spaces list') and retry."
        : "Check the URL, your network, and any proxy; a 401/404 from the gateway means it is reachable but rejected the request.",
    );
  }

  private httpError(status: number, text: string): Error {
    const detail = errorDetail(text);
    switch (status) {
      case 401:
        return new AuthError(
          "unauthorized" + (detail ? `: ${detail}` : ""),
          this.isLocal
            ? "The space's token does not match its config entry; 'prime spaces delete' and create it again."
            : "Check --gateway-token (gateway credential) and --token (device credential). Run 'prime devices connect' to update them.",
        );
      case 404:
        return new CliError(
          (this.isLocal ? "space MCP endpoint not found (404)" : "gateway endpoint not found (404)") + (detail ? `: ${detail}` : ""),
          this.isLocal
            ? "The space process may still be booting; 'prime spaces list' shows its state."
            : "Verify the gateway URL - it should be the Worker origin, e.g. https://prime.tuanm.workers.dev",
        );
      case 405:
        return new CliError("gateway rejected the request method (405)");
      case 413:
        return new CliError("arguments too large for the gateway (413)", "MAX_BODY_BYTES caps the relayed body.");
      case 429:
        return new CliError("rate limited by the gateway (429)", "Retry shortly, or raise RATE_LIMIT_MAX on the gateway.");
      case 503:
        // A call that addressed a fleet gets the fleet's own answer: which
        // member holds the lease, and that it cannot be reached.
        if (!this.isLocal && this.target.fleet) {
          return new OfflineError(
            detail ? `the fleet's primary is not reachable: ${detail}` : "the fleet's primary is not reachable right now",
            "The member that holds the lease is not connected. Another member takes over when the lease runs out; retry in a moment.",
          );
        }
        return new OfflineError(
          this.isLocal ? "space is not running" : detail === "device busy" ? "device is busy (too many in-flight requests)" : "device is offline",
          this.isLocal
            ? `The container for "${this.target.deviceId}" is stopped. Run 'prime spaces start <name>'.`
            : `No live tunnel for "${this.target.deviceId}". Start the device (e.g. the Browser MCP extension) and confirm it shows Connected, then retry.`,
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

/** Last JSON object in an SSE body (what MCP Streamable HTTP may reply with). */
function sseLastJson(text: string): string | undefined {
  const chunks = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  for (let i = chunks.length - 1; i >= 0; i--) {
    try {
      JSON.parse(chunks[i]!);
      return chunks[i];
    } catch {}
  }
  return chunks[chunks.length - 1];
}

/** Did the device reject us for not having initialized the session? */
function isInitializationComplaint(err: unknown): boolean {
  if (err instanceof McpError) {
    if (err.code === -32002) return true; // "Server not initialized"
    return /initiali[sz]/i.test(err.message);
  }
  return false;
}
