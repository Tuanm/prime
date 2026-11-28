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
//
// With no mode given (the default) a device enforces as soon as its callers file lists a key, and warns while it
// lists none: a device that nobody has enrolled a key on keeps working, and one that has been told whom to trust
// does not run what anybody else sends.

import { createHash, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { writeFileAtomic } from "./atomic-write.ts";
import { dirname, join } from "node:path";
import { FLEET_CALLERS_FRESH_MS, FLEET_CALL_SKEW_MS, FLEET_FUTURE_MS, type FleetCallersFile, fleetCallersPathFor, readFleetCallers } from "./fleet-callers.ts";
import {
  callTarget,
  fleetMemberTarget,
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
/** How many nonces of signed refusals are kept (see `retired`); when they are all in use, refusals go unsigned. */
const RETIRED_LIMIT = 10_000;
/** How many nonces of refusals for keys nobody allowed are kept (in memory only). */
const RETIRED_UNKNOWN_LIMIT = 1_000;
/** The file in the state directory that keeps them over a restart, and how long past the end of their calls' life they are kept. */
const RETIRED_FILE = "retired-nonces.jsonl";
const RETIRED_MARGIN_MS = 60_000;
const LOG_LIMIT_BYTES = 1024 * 1024;

export const REPLY_SIG_HEADER = "x-prime-reply-sig";
export const REPLY_SIG_VERSION = "v2";
const REPLY_PREFIX = "prime-reply-v2\n";

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
  | "not-primary"
  | "before-primary"
  | "fleet-member"
  | "fleet-unbound"
  | "ahead"
  | "tool-not-allowed";

/** The frame the gateway tunnels in. `raw` and `callerSig` are absent on an unsigned call and from an older gateway. */
/** What a device says in its register frame when it takes a signed call as `raw` alone, and answers with `responseText` alone. */
export const CALL_RAW_ONLY = "call-raw-only";

/** The request in a body (a leading byte-order mark is not part of the JSON), or undefined when it cannot be read. */
function parseBody(raw: unknown, parse: (text: string) => unknown): unknown {
  if (typeof raw !== "string") return undefined;
  try {
    return parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return undefined;
  }
}

/** What a reply is signed over: the call it answers (its nonce and the exact body) and the text of the reply. */
export interface ReplyBinding {
  nonce: string;
  raw: string;
  /** The call named the member (`fleet:<id>@<member>`, or `@` for the question which): the reply carries the member's certificate for the key it is signed with. Not the replies to the form older builds sign, which they would take for a changed signature. */
  fleet?: boolean;
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
      /** Set when a trusted key signed the call. */
      keyId?: string;
      /** Set when the reply is to be signed: what it is bound to. */
      reply?: ReplyBinding;
    }
  | {
      action: "refuse";
      response: { jsonrpc: "2.0"; id: unknown; error: { code: number; message: string; data: { reason: CallerFailure; member?: string } } };
      /** Set when the refusal may be signed (see admit). */
      reply?: ReplyBinding;
    };

export interface CallerAuthOptions {
  /** Absent: enforce while the callers file lists a key (or cannot be read), warn otherwise. */
  mode?: CallerAuthMode;
  /** The id the device is registered as: the target a signature must name. */
  deviceId: string;
  callersFile: string;
  /**
   * The keys a fleet's signed roster lets call this space while it is the fleet's primary (see fleet-callers.ts);
   * fleet-callers.json beside the callers file by default. A call signed for `fleet:<id>` is checked against it.
   */
  fleetCallersFile?: string;
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

interface FleetCache {
  stamp: string;
  file?: FleetCallersFile;
  error?: string;
}

interface CallersCache {
  stamp: string;
  entries: CallerEntry[] | undefined;
  error?: string;
}

export class CallerAuth {
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
  /**
   * Nonces that a signed refusal was made for. A refusal that is signed tells its caller "this call did not run", so
   * that nonce must never run afterwards: a gateway that changed a byte of the header (the key id, a byte of the
   * signature) gets a signed refusal bound to the caller's own nonce and body, and could then send the real call and
   * hand back the refusal. Keyed by nonce alone, as the header that carries it is the gateway's to change.
   */
  private readonly retired = new Map<string, number>();
  /** The nonces of calls that ran, by nonce alone (`seen` is by key id and nonce): a refusal is never signed for one. */
  private readonly ranNonces = new Map<string, number>();
  private logQueue: string[] = [];
  private flushing: Promise<void> | undefined;
  private logFailureSaid = false;
  private replyFailureSaid = false;
  private retiredFailureSaid = false;
  private readonly retiredUnknown = new Map<string, number>();
  private retiredLines = 0;
  private cache: CallersCache | undefined;
  private fleetCache: FleetCache | undefined;
  private modeSeen: CallerAuthMode | undefined;
  private replyKey: CallerKey | undefined;
  private readonly said = new Set<string>();
  private readonly stateDir: string;

  constructor(opts: CallerAuthOptions) {
    this.opts = opts;
    this.stateDir = opts.stateDir ?? join(dirname(opts.callersFile), "caller-auth");
    this.floorTs = (opts.now ?? Date.now)() - 1;
    if (opts.mode !== "off") this.loadRetired();
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

  /** The fleet callers file, re-read when the agent writes it. A missing file lists nobody. */
  private fleetCallers(): { file?: FleetCallersFile; error?: string } {
    const path = this.opts.fleetCallersFile ?? fleetCallersPathFor(this.opts.callersFile);
    let stamp: string;
    try {
      const st = statSync(path);
      stamp = `${st.ino}:${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
    } catch (err) {
      stamp = (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : `error:${(err as NodeJS.ErrnoException).code}`;
    }
    if (!this.fleetCache || this.fleetCache.stamp !== stamp) {
      const read = stamp.startsWith("error:") ? { error: `${path} cannot be read (${stamp.slice(6)})` } : readFleetCallers(path);
      this.fleetCache = { stamp, ...read };
    }
    return this.fleetCache;
  }

  /** The mode in force now: the one that was asked for, or what the callers file says (see the top of this file). */
  get mode(): CallerAuthMode {
    if (this.opts.mode) return this.opts.mode;
    const mode: CallerAuthMode = this.hasCallers() ? "enforce" : "warn";
    // A device whose mode follows its files says when it changes (a key was allowed, or the last one revoked, or a roster signed).
    if (this.modeSeen !== undefined && this.modeSeen !== mode) {
      this.opts.log?.(
        mode === "enforce"
          ? "caller-auth: now enforce (a key is allowed here, or the fleet's signed roster lists callers): a call that none of them signed is refused"
          : "caller-auth: now warn (no key is allowed here any more): every call runs, and the unsigned ones are logged",
      );
    }
    this.modeSeen = mode;
    return mode;
  }

  /** One line for the service log at start: the mode, and why it is that one. */
  describeMode(): string {
    const mode = this.mode;
    if (this.opts.mode) return `caller-auth: ${mode} (--caller-auth)`;
    return mode === "enforce"
      ? "caller-auth: enforce (the callers file, or the fleet's signed roster, lists keys: a call that none of them signed is refused; --caller-auth warn runs such calls and logs them)"
      : "caller-auth: warn (no key is allowed yet, so every call runs and the unsigned ones are logged; once 'prime devices allow-caller' has allowed a key, unsigned calls are refused)";
  }

  /** Does the callers file, or the fleet's signed roster, name any caller? (Used to decide a default; an unreadable file counts as yes.) */
  hasCallers(): boolean {
    const c = this.callers();
    if (!c.entries || c.entries.length > 0) return true;
    // A space in a fleet is let in by the fleet's signed roster: once its agent says the member has taken a signed roster into
    // account (`enforce`: an owner is pinned, or a roster was seen) the space enforces whatever the list holds, so that a roster the gateway
    // makes empty or refused cannot turn it off. A file the agent wrote that cannot be read counts as one that lists callers.
    const fleet = this.fleetCallers();
    return fleet.error !== undefined || fleet.file?.enforce === true || (fleet.file?.roster === "signed" && fleet.file.callers.length > 0);
  }

  /**
   * Decide what to do with one tunnelled request.
   *
   * A frame whose signature header parses and that carries the body (`raw`) gets a signed reply, whatever is
   * decided: the reply signature binds this device's key to the call's nonce, the exact body and the text of the
   * reply, so a caller that pinned the device can tell its answer, a refusal included, from one the gateway
   * made up. Such a frame is run from `raw` (what the reply is bound to), in every mode.
   * Two kinds of refusal are not signed, because a gateway could produce them after the call had run, and a
   * signed "refused" would tell the caller that it did not: a replay (or a call older than the nonces that are
   * kept) and a nonce that this device has already run.
   */
  admit(frame: TunnelFrame): Admission {
    const parse = this.opts.parse ?? JSON.parse;
    const sig = typeof frame.callerSig === "string" ? parseCallSig(frame.callerSig) : undefined;
    const binding: ReplyBinding | undefined = sig && typeof frame.raw === "string" ? { nonce: sig.nonce, raw: frame.raw } : undefined;
    // A frame of a device that asked for them (CALL_RAW_ONLY) has `raw` and no `request`.
    const fromRaw = binding ? parseBody(frame.raw, parse) : undefined;
    const request = fromRaw !== undefined ? fromRaw : Object.hasOwn(frame, "request") ? frame.request : parseBody(frame.raw, parse);

    const mode = this.mode;
    if (mode === "off") {
      if (request === undefined) return this.unreadable(frame);
      return { action: "run", request, ...(binding && fromRaw !== undefined ? { reply: binding } : {}) };
    }

    let failure: CallerFailure | undefined;
    let fleetCall = false;
    // The signature was checked against a key one of the callers files lists (what is true of a failure after that: not the primary, a tool not allowed...).
    let signatureVerified = false;
    if (typeof frame.callerSig === "string") {
      const verdict = this.verify(frame);
      if (verdict.ok) {
        this.counts.signed++;
        return { action: "run", request: verdict.request, keyId: verdict.keyId, reply: { nonce: verdict.nonce, raw: frame.raw as string, ...(verdict.fleet ? { fleet: true } : {}) } };
      }
      failure = verdict.failure;
      fleetCall = verdict.fleet === true;
      signatureVerified = verdict.verified === true;
    }

    if (request === undefined) return this.unreadable(frame);
    const bound = binding && fromRaw !== undefined ? (fleetCall ? { ...binding, fleet: true } : binding) : undefined;
    if (!requiresSignature(request)) return { action: "run", request, ...(bound ? { reply: bound } : {}) };

    failure ??= "unsigned";
    if (failure === "unsigned") this.counts.unsigned++;
    else this.counts.invalid++;
    this.record(failure, request, mode === "enforce" ? "refused" : "ran", frame, mode);
    // The question which member this is is never run, whatever the mode: it is not a call.
    if (mode !== "enforce" && failure !== "fleet-member") return { action: "run", request, ...(bound ? { reply: bound } : {}) };
    this.counts.refused++;
    const signable =
      bound !== undefined &&
      sig !== undefined &&
      failure !== "replay" &&
      failure !== "stale" &&
      sig.ts > this.floorTs &&
      !this.ranNonces.has(sig.nonce) &&
      this.retire(sig.nonce, sig.ts, signatureVerified);
    return {
      action: "refuse",
      response: {
        jsonrpc: "2.0",
        id: requestId(request),
        error: {
          code: CALLER_REFUSED_CODE,
          message: refusalMessage(failure, this.opts.deviceId),
          data: { reason: visibleReason(failure), ...(failure === "fleet-member" ? { member: this.opts.deviceId } : {}) },
        },
      },
      ...(signable ? { reply: bound } : {}),
    };
  }

  /** Keep a nonce from ever running, because a refusal for it is to be signed. False when no more can be kept: then the refusal is not signed. */
  private retire(nonce: string, ts: number, known: boolean): boolean {
    const now = this.now();
    if (!known) return this.retireStranger(nonce, ts, now);
    for (const [key, at] of this.retired) {
      if (at + MAX_SKEW_MS >= now) break;
      this.retired.delete(key);
    }
    if (this.retired.has(nonce)) return false;
    if (this.retired.size >= RETIRED_LIMIT) return false;
    // Kept across a restart too: a call signed after the moment this process started is not refused as older than it, so without this a refusal that
    // said "did not run" could be followed by the call running. If it cannot be kept, the refusal is not signed.
    if (!this.persistRetired(nonce, ts)) return false;
    this.retired.set(nonce, ts);
    return true;
  }

  /**
   * A frame whose signature did not verify against a listed key is a stranger's, whatever key id it carries (the id is in every call the gateway relays). Its refusal is signed too (a caller that is not allowed yet is told so by the device, not by
   * a gateway that could have made it up), and its nonce is kept so that the call cannot run after a refusal that said it did not (a gateway that
   * changed the key id of a genuine call gets the refusal for the changed one). But a stranger costs nothing to be, so its nonces have a set of their
   * own, small, in memory only: frames from keys nobody allowed can neither fill the set that the refusals that matter use nor write to the disk.
   * When it is full the refusal goes unsigned, and its caller is told the call may or may not have run.
   */
  private retireStranger(nonce: string, ts: number, now: number): boolean {
    for (const [key, at] of this.retiredUnknown) {
      if (at + MAX_SKEW_MS >= now) break;
      this.retiredUnknown.delete(key);
    }
    if (this.retiredUnknown.has(nonce) || this.retiredUnknown.size >= RETIRED_UNKNOWN_LIMIT) return false;
    this.retiredUnknown.set(nonce, ts);
    return true;
  }

  private retiredFile(): string {
    return join(this.stateDir, RETIRED_FILE);
  }

  /** The nonces that were retired before this process started and have not run out (a call stops verifying MAX_SKEW_MS after its time, and RETIRED_MARGIN_MS more is kept). */
  private loadRetired(): void {
    let text: string;
    try {
      text = readFileSync(this.retiredFile(), "utf8");
    } catch {
      return;
    }
    const now = this.now();
    const live: Array<[string, number]> = [];
    let lines = 0;
    for (const line of text.split("\n")) {
      if (!line) continue;
      lines++;
      try {
        const v = JSON.parse(line) as { n?: unknown; t?: unknown };
        if (typeof v.n === "string" && v.n.length > 0 && v.n.length <= 128 && typeof v.t === "number" && Number.isFinite(v.t) && v.t + MAX_SKEW_MS + RETIRED_MARGIN_MS >= now) live.push([v.n, v.t]);
      } catch {
        // a line that is not one is no nonce
      }
    }
    live.sort((a, b) => a[1] - b[1]);
    for (const [n, t] of live.slice(-RETIRED_LIMIT)) this.retired.set(n, t);
    this.retiredLines = live.length;
    if (lines > live.length) this.rewriteRetired();
  }

  private rewriteRetired(): boolean {
    try {
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
      const body = [...this.retired].map(([n, t]) => JSON.stringify({ n, t })).join("\n");
      writeFileAtomic(this.retiredFile(), body ? body + "\n" : "", 0o600);
      this.retiredLines = this.retired.size;
      return true;
    } catch {
      return false;
    }
  }

  private persistRetired(nonce: string, ts: number): boolean {
    try {
      // Entries that have run out are dropped when the file has grown to twice what can be held (and when it is read at the start).
      if (this.retiredLines >= RETIRED_LIMIT * 2) {
        const now = this.now();
        for (const [key, at] of this.retired) if (at + MAX_SKEW_MS + RETIRED_MARGIN_MS < now) this.retired.delete(key);
        if (!this.rewriteRetired()) return false;
      }
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
      appendFileSync(this.retiredFile(), JSON.stringify({ n: nonce, t: ts }) + "\n", { mode: 0o600 });
      this.retiredLines++;
      return true;
    } catch (err) {
      if (!this.retiredFailureSaid) {
        this.retiredFailureSaid = true;
        this.opts.log?.(`caller-auth: refusals are not signed: cannot keep the nonces of the calls refused (${err instanceof Error ? err.message : String(err)})`);
      }
      return false;
    }
  }

  /** Neither a request nor a body that can be read: there is nothing to run, whatever the mode. */
  private unreadable(frame: TunnelFrame): Admission {
    this.record("bad-body", undefined, "refused", frame);
    return { action: "refuse", response: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "the request could not be read", data: { reason: "invalid" } } } };
  }

  private verify(frame: TunnelFrame): { ok: true; request: unknown; nonce: string; keyId: string; fleet?: boolean } | { ok: false; failure: CallerFailure; fleet?: boolean; verified?: boolean } {
    const parsed = parseCallSig(frame.callerSig as string);
    if (!parsed) return { ok: false, failure: "malformed" };
    if (typeof frame.raw !== "string") return { ok: false, failure: "no-raw" };
    const now = this.now();
    if (Math.abs(now - parsed.ts) > MAX_SKEW_MS) return { ok: false, failure: "stale" };
    // A refusal was signed for this nonce: the call must not run now (see `retired`).
    if (this.retired.has(parsed.nonce) || this.retiredUnknown.has(parsed.nonce)) return { ok: false, failure: "replay" };
    const callers = this.callers();
    if (!callers.entries) return { ok: false, failure: "callers-unreadable" };
    const entry = callers.entries.find((e) => e.keyId === parsed.keyId);
    // A key of the fleet's roster may call this space only for the fleet (see fleet-callers.ts): its signature names
    // `fleet:<id>`, and what a device's own key signed for the device is never taken for it.
    const fleet = this.fleetCallers();
    const fleetEntry = fleet.file?.callers.find((e) => e.keyId === parsed.keyId);
    if (!entry && !fleetEntry) return { ok: false, failure: "unknown-key" };
    let signer: CallerEntry | undefined;
    let forFleet = false;
    if (entry && verifyCallSignature(parsed, Buffer.from(entry.pub, "base64"), callTarget("device", this.opts.deviceId), frame.raw)) {
      signer = entry;
    } else if (fleetEntry && fleet.file) {
      // A call for the fleet names the one member that is to run it, so that a gateway that sent it to two cannot have it run twice.
      const key = Buffer.from(fleetEntry.pub, "base64");
      const id = fleet.file.fleet;
      if (verifyCallSignature(parsed, key, fleetMemberTarget(id, this.opts.deviceId), frame.raw)) {
        signer = fleetEntry;
        forFleet = true;
      } else if (verifyCallSignature(parsed, key, fleetMemberTarget(id, ""), frame.raw)) {
        // The question which member this is (nothing signed for it can run): answered, not run.
        return { ok: false, failure: "fleet-member", fleet: true, verified: true };
      } else if (verifyCallSignature(parsed, key, callTarget("fleet", id), frame.raw)) {
        // The form an older build makes: it names no member, so it could be run by every member that is sent it.
        return { ok: false, failure: "fleet-unbound", verified: true };
      }
    }
    if (!signer) return { ok: false, failure: "bad-signature" };
    if (forFleet) {
      const f = fleet.file!;
      // The agent's word that this space is the primary is good for a while after it was written, and no longer.
      if (!f.primary || now - f.writtenAt > FLEET_CALLERS_FRESH_MS || f.writtenAt - now > MAX_SKEW_MS) return { ok: false, failure: "not-primary", fleet: true, verified: true };
      // A call made for the fleet is not signed ahead of the clock, and one signed before this space became the primary - or within the
      // skew of the members' clocks of it - may have run on the member that was.
      if (parsed.ts - now > FLEET_FUTURE_MS) return { ok: false, failure: "ahead", fleet: true, verified: true };
      if (parsed.ts <= f.primarySince + FLEET_CALL_SKEW_MS) return { ok: false, failure: "before-primary", fleet: true, verified: true };
    }
    // Signed before this process started, or before a nonce that was forgotten: it may be a call that was run.
    if (parsed.ts <= this.floorTs) return { ok: false, failure: "replay", verified: true };
    let request: unknown;
    try {
      // The signature covers the bytes as they came, a leading byte-order mark included; JSON.parse does not take one.
      request = (this.opts.parse ?? JSON.parse)(frame.raw.charCodeAt(0) === 0xfeff ? frame.raw.slice(1) : frame.raw);
    } catch {
      return { ok: false, failure: "bad-body", verified: true };
    }
    // A nonce is spent only by a call whose signature is good, so nobody else can fill the table.
    const nonceKey = `${parsed.keyId}.${parsed.nonce}`;
    this.forgetOldNonces(now);
    if (this.seen.has(nonceKey)) return { ok: false, failure: "replay", verified: true };
    if (signer.tools && isToolCall(request) && !signer.tools.includes(toolName(request))) {
      return { ok: false, failure: "tool-not-allowed", verified: true };
    }
    this.seen.set(nonceKey, { ts: parsed.ts });
    this.ranNonces.set(parsed.nonce, parsed.ts);
    if (this.seen.size > NONCE_LIMIT) {
      const oldest = this.seen.entries().next().value;
      if (oldest !== undefined) {
        this.seen.delete(oldest[0]);
        this.ranNonces.delete(oldest[0].slice(oldest[0].indexOf(".") + 1));
        // Forgotten, so everything signed up to then is refused from now on: it can be replayed no more.
        this.floorTs = Math.max(this.floorTs, oldest[1].ts);
      }
    }
    return { ok: true, request, nonce: parsed.nonce, keyId: parsed.keyId, ...(forFleet ? { fleet: true } : {}) };
  }

  private forgetOldNonces(now: number): void {
    // A signature stops verifying MAX_SKEW_MS after its time, so that is when its nonce is no longer needed.
    for (const [key, spent] of this.seen) {
      if (spent.ts + MAX_SKEW_MS >= now) break;
      this.seen.delete(key);
      this.ranNonces.delete(key.slice(key.indexOf(".") + 1));
    }
  }

  private record(failure: CallerFailure, request: unknown, outcome: "ran" | "refused", frame: TunnelFrame, mode: CallerAuthMode = this.mode): void {
    const method = isRecord(request) && typeof request.method === "string" ? request.method : "?";
    const tool = isToolCall(request) ? toolName(request) : undefined;
    const keyId = typeof frame.callerSig === "string" ? parseCallSig(frame.callerSig)?.keyId : undefined;
    const line = JSON.stringify({
      ts: new Date(this.now()).toISOString(),
      mode: mode,
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
        `caller-auth (${mode}): ${outcome === "refused" ? "refused" : "ran"} a ${printable(method)}${tool ? ` ${printable(tool)}` : ""} call: ${failure}${
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

  /** The member's certificate for this reply key, when the agent has written one that is for it and has not run out. */
  private replyCert(replyKey: string): string | undefined {
    const c = this.fleetCallers().file?.replyCert;
    return c && c.key === replyKey && c.until > this.now() + 60_000 ? c.cert : undefined;
  }

  /** Sign a reply so the caller knows this device (and not the gateway) answered. undefined if the key cannot be had. */
  replySig(call: ReplyBinding, responseText: string): string | undefined {
    try {
      this.replyKey ??= loadOrCreateCallerKey(join(this.stateDir, "device-ed25519.pem"));
      const sig = cryptoSign(null, replyMessage(call.nonce, call.raw, responseText), this.replyKey.privateKey).toString("base64url");
      const head = `${REPLY_SIG_VERSION}.${this.replyKey.publicKey.toString("base64url")}.${sig}`;
      const cert = call.fleet ? this.replyCert(this.replyKey.publicKey.toString("base64url")) : undefined;
      return cert ? `${head}.${cert}` : head;
    } catch (err) {
      if (!this.replyFailureSaid) {
        this.replyFailureSaid = true;
        this.opts.log?.(`caller-auth: replies are not signed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return undefined;
    }
  }
}

/** The bytes a reply signature covers: the call (nonce and exact body) and the text of the reply, each by its hash. */
function replyMessage(nonce: string, requestBody: string, responseText: string): Buffer {
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  return Buffer.from(`${REPLY_PREFIX}${nonce}\n${hash(requestBody)}\n${hash(responseText)}`, "utf8");
}

/**
 * Check a reply signature header against the call's nonce, the body that was sent and the response text received.
 * Returns the device's public key when the signature is good, undefined when it is malformed or wrong.
 * Whether that key is the one this device is known by is for the caller to decide (see device-pins.ts).
 */
export function verifyReplySig(header: string, nonce: string, requestBody: string, responseText: string): Buffer | undefined {
  const parts = header.trim().split(".");
  // A fourth part is a certificate for the key (fleet replies, from a later build; see fleet-reply-cert.ts). It is not covered by this signature
  // and is checked on its own by whoever reads it, so a build that does not know it still checks the signature.
  if (parts.length < 3 || parts.length > 4 || parts[0] !== REPLY_SIG_VERSION) return undefined;
  const pub = parsePublicKey(parts[1]!);
  const sig = Buffer.from(parts[2]!, "base64url");
  if (!pub || sig.length !== 64) return undefined;
  try {
    const ok = cryptoVerify(null, replyMessage(nonce, requestBody, responseText), publicKeyFromRaw(pub), sig);
    return ok ? pub : undefined;
  } catch {
    return undefined;
  }
}

/** The certificate that came with a reply signature, if one did. */
export function replyCertOf(header: string): string | undefined {
  const parts = header.trim().split(".");
  return parts.length === 4 && parts[0] === REPLY_SIG_VERSION ? parts[3] : undefined;
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

export function refusalMessage(failure: CallerFailure, member?: string): string {
  const base =
    "this device only runs calls signed by a key it trusts; run 'prime devices allow-caller' on this machine " +
    "(if this machine is already allowed, the signature did not reach the device as it was signed: send the call again)";
  switch (failure) {
    case "stale":
      return `${base} (the signature's time is more than 5 minutes from this device's clock: check both clocks)`;
    case "replay":
      return "this call was already received, or was signed before this device last started; send it again";
    case "fleet-member":
      return `this is the member ${member ?? ""} of the fleet: this was the question which member it is, and nothing ran`;
    case "ahead":
      return "this call was signed more than a minute ahead of this device's clock (the fleet's members and this machine should agree within a minute): check both clocks; it did not run";
    case "fleet-unbound":
      return "a call for a fleet names the member that is to run it, and this one did not: either this prime is older than the fleet's (update prime on this machine), or the question which member answers did not get through (send the call again); it did not run";
    case "not-primary":
      return "this space is not the fleet's primary now (or its agent has not said so lately), so it runs no call made for the fleet: the call did not run here (the answers of a fleet are not authenticated, so look at the work tree before you send it again)";
    case "before-primary":
      return "this space became the fleet's primary after this call was signed, and the call may have run on the member that was: it did not run here (the answers of a fleet are not authenticated); look at the work tree before you send it again";
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
