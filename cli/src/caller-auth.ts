// The device side of signed tool calls: decide, for each request the gateway tunnels in, whether a key
// this device trusts signed it. (The signing side is caller-key.ts; the wire format is described there.)
//
// The gateway puts the exact body it received in `raw` and the client's x-prime-call-sig header in
// `callerSig`. A call that verifies is run from `raw`, never from `request` (which the gateway
// re-serialised, and could have written itself). initialize, ping, tools/list and notifications
// reveal only the tool list and pass unsigned.
//
//   off      nothing is checked
//   warn     a call that is not signed by a trusted key still runs, and is logged
//   enforce  such a call is refused with JSON-RPC error -32001

import { createHash, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { mkdirSync, renameSync, statSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  callTarget,
  CALLER_REFUSED_CODE,
  type CallerEntry,
  type CallerKey,
  loadOrCreateCallerKey,
  methodNeedsSignature,
  parseCallSig,
  parsePublicKey,
  publicKeyFromRaw,
  readCallers,
  verifyCallSignature,
} from "./caller-key.ts";

export type CallerAuthMode = "off" | "warn" | "enforce";
export const CALLER_AUTH_MODES: readonly CallerAuthMode[] = ["off", "warn", "enforce"];

/** How far a signature's time may be from this device's clock. */
export const MAX_SKEW_MS = 5 * 60_000;
const NONCE_LIMIT = 10_000;
const LOG_LIMIT_BYTES = 1024 * 1024;

export const REPLY_SIG_HEADER = "x-prime-reply-sig";
export const REPLY_SIG_VERSION = "v1";
const REPLY_PREFIX = "prime-reply-v1\n";

/** Why a call was not accepted as signed. */
/**
 * What a refusal tells the other end. The reasons that would tell a gateway which keys this device trusts
 * (an unknown key or a bad signature) are one; the log on this device keeps the detail.
 */
export function visibleReason(failure: CallerFailure): CallerFailure {
  return failure === "unknown-key" || failure === "bad-signature" || failure === "malformed" || failure === "no-raw" || failure === "bad-body"
    ? "invalid"
    : failure;
}

export type CallerFailure =
  | "invalid"
  | "unsigned"
  | "malformed"
  | "no-raw"
  | "bad-body"
  | "stale"
  | "unknown-key"
  | "callers-unreadable"
  | "bad-signature"
  | "replay"
  | "tool-not-allowed";

/** The frame the gateway tunnels in. `raw` and `callerSig` are absent on an unsigned call and from an older gateway. */
/** What a device says in its register frame when it takes a signed call as `raw` alone, and answers with `responseText` alone. */
export const CALL_RAW_ONLY = "call-raw-only";

/** The request in a body, or undefined when it is not one that can be read. */
function parseLoosely(raw: unknown): unknown {
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return undefined;
  }
}

export interface TunnelFrame {
  request?: unknown;
  raw?: unknown;
  callerSig?: unknown;
}

export type Admission =
  | {
      action: "run";
      /** What to hand to the JSON-RPC handler. */
      request: unknown;
      /** Set when a trusted key signed the call: the nonce the reply is signed with. */
      nonce?: string;
      keyId?: string;
    }
  | { action: "refuse"; response: { jsonrpc: "2.0"; id: unknown; error: { code: number; message: string; data: { reason: CallerFailure } } } };

export interface CallerAuthOptions {
  mode: CallerAuthMode;
  /** The id the device is registered as: the target a signature must name. */
  deviceId: string;
  callersFile: string;
  /** Holds the device reply key and the log of calls that were not signed by a trusted key. */
  stateDir?: string;
  /** Parses `raw` (code-mcp's depth-limited parser); JSON.parse by default. */
  parse?: (text: string) => unknown;
  now?: () => number;
  /** One line per notable event, for the service log. */
  log?: (text: string) => void;
}

/** Text from outside, made safe to put in a log line: no control characters, no escape sequences, bounded. */
export function printable(text: string, max = 100): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "?");
  return JSON.stringify(clean.length > max ? clean.slice(0, max) + "..." : clean);
}

interface Spent {
  /** The signature's own time: the entry is good for as long as the call could still verify as fresh. */
  ts: number;
}

interface CallersCache {
  stamp: string;
  entries: CallerEntry[] | undefined;
  error?: string;
}

export class CallerAuth {
  readonly mode: CallerAuthMode;
  readonly counts = { signed: 0, unsigned: 0, invalid: 0, refused: 0 };
  private readonly opts: CallerAuthOptions;
  private readonly seen = new Map<string, Spent>();
  /**
   * No call signed at or before this time is accepted: it starts at the time this process did (nonces do not
   * survive a restart, so a call from before it could be played again), and rises to the time of any nonce that
   * is forgotten to make room, so a nonce that could still be replayed is never forgotten without its call being
   * refused with it.
   */
  private floorTs: number;
  private logQueue: string[] = [];
  private flushing: Promise<void> | undefined;
  private logFailureSaid = false;
  private replyFailureSaid = false;
  private cache: CallersCache | undefined;
  private replyKey: CallerKey | undefined;
  private readonly said = new Set<string>();
  private readonly stateDir: string;

  constructor(opts: CallerAuthOptions) {
    this.opts = opts;
    this.mode = opts.mode;
    this.stateDir = opts.stateDir ?? join(dirname(opts.callersFile), "caller-auth");
    this.floorTs = (opts.now ?? Date.now)() - 1;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** The callers file, re-read when it changes so `prime devices allow-caller` takes effect without a restart. */
  private callers(): { entries?: CallerEntry[]; error?: string } {
    let stamp: string;
    try {
      const st = statSync(this.opts.callersFile);
      // Every write moves a new file into place, so the inode changes; the times and size catch an in-place edit.
      stamp = `${st.ino}:${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
    } catch (err) {
      stamp = (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : `error:${(err as NodeJS.ErrnoException).code}`;
    }
    if (!this.cache || this.cache.stamp !== stamp) {
      try {
        this.cache = { stamp, entries: readCallers(this.opts.callersFile) };
      } catch (err) {
        this.cache = { stamp, entries: undefined, error: err instanceof Error ? err.message : String(err) };
      }
    }
    return this.cache.entries ? { entries: this.cache.entries } : { error: this.cache.error ?? "unreadable" };
  }

  /** Does the callers file hold any caller? (Used to decide a default; an unreadable file counts as yes.) */
  hasCallers(): boolean {
    const c = this.callers();
    return c.entries ? c.entries.length > 0 : true;
  }

  /** Decide what to do with one tunnelled request. */
  admit(frame: TunnelFrame): Admission {
    if (this.mode === "off") return { action: "run", request: frame.request };

    let failure: CallerFailure | undefined;
    if (typeof frame.callerSig === "string") {
      const verdict = this.verify(frame);
      if (verdict.ok) {
        this.counts.signed++;
        return { action: "run", request: verdict.request, nonce: verdict.nonce, keyId: verdict.keyId };
      }
      failure = verdict.failure;
    }

    // A frame of a device that asked for them (CALL_RAW_ONLY) has `raw` and no `request`: what it says is read from `raw`.
    const request = Object.hasOwn(frame, "request") ? frame.request : parseLoosely(frame.raw);
    if (request === undefined) {
      // Neither a request nor a body that can be read: there is nothing to run, whatever the mode.
      this.record("bad-body", undefined, "refused", frame);
      return { action: "refuse", response: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "the request could not be read", data: { reason: "invalid" } } } };
    }
    if (!requiresSignature(request)) return { action: "run", request };

    failure ??= "unsigned";
    if (failure === "unsigned") this.counts.unsigned++;
    else this.counts.invalid++;
    this.record(failure, request, this.mode === "enforce" ? "refused" : "ran", frame);
    if (this.mode !== "enforce") return { action: "run", request };
    this.counts.refused++;
    return {
      action: "refuse",
      response: {
        jsonrpc: "2.0",
        id: requestId(request),
        error: { code: CALLER_REFUSED_CODE, message: refusalMessage(failure), data: { reason: visibleReason(failure) } },
      },
    };
  }

  private verify(frame: TunnelFrame): { ok: true; request: unknown; nonce: string; keyId: string } | { ok: false; failure: CallerFailure } {
    const parsed = parseCallSig(frame.callerSig as string);
    if (!parsed) return { ok: false, failure: "malformed" };
    if (typeof frame.raw !== "string") return { ok: false, failure: "no-raw" };
    const now = this.now();
    if (Math.abs(now - parsed.ts) > MAX_SKEW_MS) return { ok: false, failure: "stale" };
    const callers = this.callers();
    if (!callers.entries) return { ok: false, failure: "callers-unreadable" };
    const entry = callers.entries.find((e) => e.keyId === parsed.keyId);
    if (!entry) return { ok: false, failure: "unknown-key" };
    const publicKey = Buffer.from(entry.pub, "base64");
    if (!verifyCallSignature(parsed, publicKey, callTarget("device", this.opts.deviceId), frame.raw)) {
      return { ok: false, failure: "bad-signature" };
    }
    // Signed before this process started, or before a nonce that was forgotten: it may be a call that was run.
    if (parsed.ts <= this.floorTs) return { ok: false, failure: "replay" };
    let request: unknown;
    try {
      // The signature covers the bytes as they came, a leading byte-order mark included; JSON.parse does not take one.
      request = (this.opts.parse ?? JSON.parse)(frame.raw.charCodeAt(0) === 0xfeff ? frame.raw.slice(1) : frame.raw);
    } catch {
      return { ok: false, failure: "bad-body" };
    }
    // A nonce is spent only by a call whose signature is good, so nobody else can fill the table.
    const nonceKey = `${parsed.keyId}.${parsed.nonce}`;
    this.forgetOldNonces(now);
    if (this.seen.has(nonceKey)) return { ok: false, failure: "replay" };
    if (entry.tools && isToolCall(request) && !entry.tools.includes(toolName(request))) {
      return { ok: false, failure: "tool-not-allowed" };
    }
    this.seen.set(nonceKey, { ts: parsed.ts });
    if (this.seen.size > NONCE_LIMIT) {
      const oldest = this.seen.entries().next().value;
      if (oldest !== undefined) {
        this.seen.delete(oldest[0]);
        // Forgotten, so everything signed up to then is refused from now on: it can be replayed no more.
        this.floorTs = Math.max(this.floorTs, oldest[1].ts);
      }
    }
    return { ok: true, request, nonce: parsed.nonce, keyId: parsed.keyId };
  }

  private forgetOldNonces(now: number): void {
    // A signature stops verifying MAX_SKEW_MS after its time, so that is when its nonce is no longer needed.
    for (const [key, spent] of this.seen) {
      if (spent.ts + MAX_SKEW_MS >= now) break;
      this.seen.delete(key);
    }
  }

  private record(failure: CallerFailure, request: unknown, outcome: "ran" | "refused", frame: TunnelFrame): void {
    const method = isRecord(request) && typeof request.method === "string" ? request.method : "?";
    const tool = isToolCall(request) ? toolName(request) : undefined;
    const keyId = typeof frame.callerSig === "string" ? parseCallSig(frame.callerSig)?.keyId : undefined;
    const line = JSON.stringify({
      ts: new Date(this.now()).toISOString(),
      mode: this.mode,
      reason: failure,
      outcome,
      method,
      ...(tool ? { tool } : {}),
      ...(keyId ? { key: keyId } : {}),
    });
    this.queueLog(line);
    // The service log hears of each kind of event once, not once per call. What the gateway wrote (the method and
    // the tool name) is shown quoted and bounded, so it cannot write lines of its own.
    const said = `${failure}:${outcome}`;
    if (!this.said.has(said)) {
      this.said.add(said);
      this.opts.log?.(
        `caller-auth (${this.mode}): ${outcome === "refused" ? "refused" : "ran"} a ${printable(method)}${tool ? ` ${printable(tool)}` : ""} call: ${failure}${
          failure === "stale" ? " (this device's clock and the caller's differ by more than 5 minutes)" : ""
        }; details in ${join(this.stateDir, "caller-auth.log")}`,
      );
    }
  }

  /** Lines are written in batches, off the path of the call: a busy device does not wait for the disk once per call. */
  private queueLog(line: string): void {
    this.logQueue.push(line + "\n");
    if (!this.flushing) this.flushing = Promise.resolve().then(() => this.writeQueued());
  }

  private async writeQueued(): Promise<void> {
    const text = this.logQueue.join("");
    this.logQueue = [];
    try {
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
      const file = join(this.stateDir, "caller-auth.log");
      try {
        if (statSync(file).size > LOG_LIMIT_BYTES) renameSync(file, `${file}.1`);
      } catch {}
      await appendFile(file, text, { mode: 0o600 });
    } catch (err) {
      // A log that cannot be written must not stop a call, but it is said once.
      if (!this.logFailureSaid) {
        this.logFailureSaid = true;
        this.opts.log?.(`caller-auth: cannot write the log in ${this.stateDir}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      this.flushing = undefined;
      if (this.logQueue.length > 0) this.flushing = Promise.resolve().then(() => this.writeQueued());
    }
  }

  /** Wait for the lines queued so far to be written (tests, and a clean exit). */
  async flush(): Promise<void> {
    while (this.flushing) await this.flushing;
  }

  /** Sign a reply so the caller knows this device (and not the gateway) answered. undefined if the key cannot be had. */
  replySig(nonce: string, responseText: string): string | undefined {
    try {
      this.replyKey ??= loadOrCreateCallerKey(join(this.stateDir, "device-ed25519.pem"));
      const digest = createHash("sha256").update(responseText).digest("hex");
      const sig = cryptoSign(null, Buffer.from(`${REPLY_PREFIX}${nonce}\n${digest}`, "utf8"), this.replyKey.privateKey).toString("base64url");
      return `${REPLY_SIG_VERSION}.${this.replyKey.publicKey.toString("base64url")}.${sig}`;
    } catch (err) {
      if (!this.replyFailureSaid) {
        this.replyFailureSaid = true;
        this.opts.log?.(`caller-auth: replies are not signed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return undefined;
    }
  }
}

/**
 * Check a reply signature header against the call's nonce and the response text received.
 * Returns the device's public key when the signature is good, undefined when it is malformed or wrong.
 * Whether that key is the one this device is known by is for the caller to decide (see device-pins.ts).
 */
export function verifyReplySig(header: string, nonce: string, responseText: string): Buffer | undefined {
  const parts = header.trim().split(".");
  if (parts.length !== 3 || parts[0] !== REPLY_SIG_VERSION) return undefined;
  const pub = parsePublicKey(parts[1]!);
  const sig = Buffer.from(parts[2]!, "base64url");
  if (!pub || sig.length !== 64) return undefined;
  const digest = createHash("sha256").update(responseText).digest("hex");
  try {
    const ok = cryptoVerify(null, Buffer.from(`${REPLY_PREFIX}${nonce}\n${digest}`, "utf8"), publicKeyFromRaw(pub), sig);
    return ok ? pub : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isToolCall(request: unknown): request is Record<string, unknown> {
  return isRecord(request) && request.method === "tools/call";
}

function toolName(request: Record<string, unknown>): string {
  const params = request.params;
  return isRecord(params) && typeof params.name === "string" ? params.name : "";
}

function requestId(request: unknown): unknown {
  return isRecord(request) && (typeof request.id === "string" || typeof request.id === "number") ? request.id : null;
}

/** Does this request need a signature? Anything the handler would reject as malformed does not: it runs nothing. */
export function requiresSignature(request: unknown): boolean {
  return isRecord(request) && typeof request.method === "string" && methodNeedsSignature(request.method);
}

export function refusalMessage(failure: CallerFailure): string {
  const base = "this device only runs calls signed by a key it trusts; run 'prime devices allow-caller' on this machine";
  switch (failure) {
    case "stale":
      return `${base} (the signature's time is more than 5 minutes from this device's clock: check both clocks)`;
    case "replay":
      return "this call was already received, or was signed before this device last started; send it again";
    case "tool-not-allowed":
      return "the key that signed this call is not allowed to run this tool on this device";
    case "callers-unreadable":
      return "this device's callers file cannot be read, so it runs no call";
    default:
      return base;
  }
}

/** The mode named by a flag value, or undefined if it is not one. */
export function parseCallerAuthMode(value: unknown): CallerAuthMode | undefined {
  return typeof value === "string" && (CALLER_AUTH_MODES as readonly string[]).includes(value) ? (value as CallerAuthMode) : undefined;
}
