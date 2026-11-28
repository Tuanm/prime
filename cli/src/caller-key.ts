// The caller key: the Ed25519 key this machine signs its tool calls with, and the callers file a
// device keeps of the keys it trusts.
//
// A call is signed over the exact JSON body that is sent, so the gateway that relays it can pass it
// on but cannot change it or make one up. The device checks the signature against its callers file
// (see the verification in code-mcp.ts). Wire format:
//
//   x-prime-call-sig: v1.<keyId>.<ts>.<nonce>.<sig>
//
//   keyId  base64url(sha256(raw public key))[0..22]
//   ts     milliseconds since the epoch, decimal
//   nonce  16 random bytes, base64url
//   sig    base64url Ed25519 signature over
//          "prime-call-v1\n" + target + "\n" + ts + "\n" + nonce + "\n" + hex(sha256(body bytes))
//
//   target "device:<device id>" for a call to a device, "fleet:<fleet id>" for a call to a fleet.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { defaultConfigPath } from "./config.ts";
import { withDirLockSync } from "./dir-lock.ts";

export const CALL_SIG_HEADER = "x-prime-call-sig";
export const CALL_SIG_VERSION = "v1";
const CALL_SIG_PREFIX = "prime-call-v1\n";

/** The JSON-RPC error a device answers with when it only runs calls signed by a key it trusts. */
export const CALLER_REFUSED_CODE = -32001;

/** Methods a device answers without a signature (they reveal only the tool list), so they are not signed either. */
const UNSIGNED_METHODS = new Set(["initialize", "ping", "tools/list"]);

/** Does a device require a signature on this JSON-RPC method? */
export function methodNeedsSignature(method: string): boolean {
  return !UNSIGNED_METHODS.has(method) && !method.startsWith("notifications/");
}

// ---- keys --------------------------------------------------------------------

// PKCS#8 / SPKI wrappers around a raw Ed25519 key: the DER prefix, then the 32 bytes.
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const RAW_KEY_RE = /^[A-Za-z0-9_-]{43}={0,1}$|^[A-Za-z0-9+/]{43}=$/;

/** The raw 32-byte public key of a key object. */
export function rawPublicKey(key: KeyObject): Buffer {
  const der = (key.type === "private" ? createPublicKey(key) : key).export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(der.length - 32));
}

/** The public key object for a raw 32-byte Ed25519 key. */
export function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error("an Ed25519 public key is 32 bytes");
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

/** A public key as a person pastes it: base64 or base64url of the raw 32 bytes. undefined if it is not one. */
export function parsePublicKey(text: string): Buffer | undefined {
  const trimmed = text.trim();
  if (!RAW_KEY_RE.test(trimmed)) return undefined;
  const raw = Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return raw.length === 32 ? raw : undefined;
}

/** The short id of a public key: what the signature header carries and what a callers file is looked up by. */
export function keyIdOf(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("base64url").slice(0, 22);
}

export function callerKeyPath(): string {
  const override = process.env.PRIME_CALLER_KEY;
  if (override && override.trim().length > 0) return override.trim();
  return join(homedir(), ".prime", "caller-ed25519.pem");
}

/**
 * The callers file of the device that runs with this config: callers.json beside the config file (PRIME_CALLERS
 * overrides it). The device reads the same name, so the file a command writes is the file the device reads.
 */
export function callersPath(configPath: string = defaultConfigPath()): string {
  const override = process.env.PRIME_CALLERS;
  if (override && override.trim().length > 0) return override.trim();
  return join(dirname(configPath), "callers.json");
}

export interface CallerKey {
  privateKey: KeyObject;
  /** Raw 32-byte public key. */
  publicKey: Buffer;
  keyId: string;
  /** Public key as base64, the form `prime devices allow-caller` takes. */
  publicKeyB64: string;
}

function fromPrivate(privateKey: KeyObject): CallerKey {
  const publicKey = rawPublicKey(privateKey);
  return { privateKey, publicKey, keyId: keyIdOf(publicKey), publicKeyB64: publicKey.toString("base64") };
}

/** Group or other may read this file: a private key like that is not used (the rule ssh has). POSIX only. */
function tooOpen(path: string): string | undefined {
  if (process.platform === "win32") return undefined;
  const mode = statSync(path).mode & 0o777;
  return (mode & 0o077) !== 0 ? mode.toString(8).padStart(3, "0") : undefined;
}

function readKey(path: string): CallerKey {
  const open = tooOpen(path);
  if (open) throw new Error(`${path}: the key file is readable by others (mode ${open}); run: chmod 600 ${path}`);
  let key: KeyObject;
  try {
    key = createPrivateKey(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${path}: not a readable Ed25519 PEM key`);
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${path}: not an Ed25519 key`);
  return fromPrivate(key);
}

/** Read a key file that another process may still be writing: a short wait for it to be whole. */
function readKeyWhenWhole(path: string): CallerKey {
  for (let attempt = 0; ; attempt++) {
    try {
      return readKey(path);
    } catch (err) {
      if (attempt >= 20 || !/not a readable Ed25519/.test((err as Error).message)) throw err;
      Bun.sleepSync(25);
    }
  }
}

export interface KeyFileHooks {
  /** Replaced in tests: a file system with no hard links. */
  link?: (existing: string, created: string) => void;
}

/**
 * This machine's caller key, made on first use. The private half is written once, mode 0600, and is
 * never printed: two processes that start together end up with the same key. A key file that others can read
 * is refused, not used. (On Windows the mode means nothing: the file is protected by the access rules of the
 * user's profile.)
 */
export function loadOrCreateCallerKey(path: string = callerKeyPath(), hooks: KeyFileHooks = {}): CallerKey {
  if (existsSync(path)) return readKeyWhenWhole(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const pem = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  const scratch = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(scratch, pem, { mode: 0o600 });
    try {
      // A hard link fails when the name is taken, which is how a racing process loses: it reads the winner's key.
      (hooks.link ?? linkSync)(scratch, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return readKeyWhenWhole(path);
      // A file system with no hard links: create the name exclusively. Whoever gets it first keeps it; the
      // other reads it, so no two processes ever hold different keys.
      try {
        writeFileSync(path, pem, { flag: "wx", mode: 0o600 });
      } catch (second) {
        if ((second as NodeJS.ErrnoException).code === "EEXIST") return readKeyWhenWhole(path);
        throw second;
      }
    }
  } finally {
    rmSync(scratch, { force: true });
  }
  try {
    chmodSync(path, 0o600);
  } catch {}
  return readKey(path);
}

// ---- signing -----------------------------------------------------------------

export function callSigMessage(target: string, ts: string, nonce: string, bodySha256Hex: string): Buffer {
  return Buffer.from(`${CALL_SIG_PREFIX}${target}\n${ts}\n${nonce}\n${bodySha256Hex}`, "utf8");
}

export function bodyDigest(body: string | Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export interface SignOptions {
  now?: number;
  nonce?: string;
}

/** The `x-prime-call-sig` value for a call to `target` with exactly this body. */
export function signCall(key: CallerKey, target: string, body: string, options: SignOptions = {}): string {
  const ts = String(options.now ?? Date.now());
  const nonce = options.nonce ?? randomBytes(16).toString("base64url");
  const sig = cryptoSign(null, callSigMessage(target, ts, nonce, bodyDigest(body)), key.privateKey).toString("base64url");
  return [CALL_SIG_VERSION, key.keyId, ts, nonce, sig].join(".");
}

export interface ParsedCallSig {
  keyId: string;
  ts: number;
  tsText: string;
  nonce: string;
  sig: Buffer;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

export function parseCallSig(header: string | undefined | null): ParsedCallSig | undefined {
  if (!header) return undefined;
  const parts = header.trim().split(".");
  if (parts.length !== 5 || parts[0] !== CALL_SIG_VERSION) return undefined;
  const [, keyId, tsText, nonce, sig] = parts as [string, string, string, string, string];
  // Exact lengths, so what a device remembers per call (the nonce) is of a known size.
  if (keyId.length !== 22 || nonce.length !== 22 || sig.length !== 86) return undefined;
  if (!B64URL.test(keyId) || !B64URL.test(nonce) || !B64URL.test(sig) || !/^\d{1,16}$/.test(tsText)) return undefined;
  const sigBytes = Buffer.from(sig, "base64url");
  if (sigBytes.length !== 64) return undefined;
  return { keyId, ts: Number(tsText), tsText, nonce, sig: sigBytes };
}

/** Is this signature a valid one by `publicKey` over this target and body? (No freshness check: see the device's verifier.) */
export function verifyCallSignature(parsed: ParsedCallSig, publicKey: Buffer, target: string, body: string | Uint8Array): boolean {
  try {
    return cryptoVerify(null, callSigMessage(target, parsed.tsText, parsed.nonce, bodyDigest(body)), publicKeyFromRaw(publicKey), parsed.sig);
  } catch {
    return false;
  }
}

/**
 * The name a signature is made for: "device:<id>" for a call to a device, "fleet:<id>" for a call to a fleet.
 * The signer and the device that verifies derive it with this one function.
 */
export function callTarget(kind: "device" | "fleet", id: string): string {
  return `${kind}:${id}`;
}

/**
 * The signature target of a call. A call addresses a fleet when it goes through `?fleet=` (the member that is
 * called is `deviceId`, the fleet is `fleet`), and also when the name in the path is a fleet reached with its own
 * token (`fleetBuddy`): then the name is the fleet's.
 */
export function signTarget(target: { deviceId: string; fleet?: string; fleetBuddy?: boolean }): string {
  if (target.fleet) return callTarget("fleet", target.fleet);
  if (target.fleetBuddy) return callTarget("fleet", target.deviceId);
  return callTarget("device", target.deviceId);
}

/** How long after a failure to make or read the key the signer tries again. */
const KEY_RETRY_MS = 30_000;

/**
 * Signs calls for a client. The key is made the first time a call needs it; if it cannot be made or read
 * (a read-only home, a key file others can read), the call goes out unsigned, the reason is given once, and the
 * key is tried again after a while, so a repaired file is picked up without a restart.
 */
export class CallSigner {
  private key: CallerKey | undefined;
  private failedAt: number | undefined;
  private reason: string | undefined;
  private warned: string | undefined;
  private readonly path: string | undefined;
  private readonly warn: (text: string) => void;
  private readonly now: () => number;

  constructor(options: { path?: string; warn?: (text: string) => void; now?: () => number } = {}) {
    this.path = options.path;
    this.warn = options.warn ?? ((text) => process.stderr.write(`${text}\n`));
    this.now = options.now ?? Date.now;
  }

  /** The key, or undefined if there is none to be had (see `problem`). */
  callerKey(): CallerKey | undefined {
    if (this.key) return this.key;
    if (this.failedAt !== undefined && this.now() - this.failedAt < KEY_RETRY_MS) return undefined;
    try {
      this.key = loadOrCreateCallerKey(this.path);
      this.failedAt = undefined;
      this.reason = undefined;
      return this.key;
    } catch (err) {
      this.failedAt = this.now();
      this.reason = err instanceof Error ? err.message : String(err);
      if (this.warned !== this.reason) {
        this.warned = this.reason;
        this.warn(`prime: calls are not signed: ${this.reason}`);
      }
      return undefined;
    }
  }

  /** Why there is no key, when there is none. */
  problem(): string | undefined {
    return this.key ? undefined : this.reason;
  }

  /** The header for one call, or undefined when it should go unsigned. */
  header(method: string, target: { deviceId: string; fleet?: string; fleetBuddy?: boolean }, body: string): string | undefined {
    if (!methodNeedsSignature(method)) return undefined;
    const key = this.callerKey();
    return key ? signCall(key, signTarget(target), body) : undefined;
  }
}

/** The line a person runs on the device's machine to let this machine's calls in. */
export function allowCallerCommand(key: CallerKey): string {
  return `prime devices allow-caller ${key.publicKeyB64}`;
}

/**
 * What to tell someone whose call a device refused for want of a signature it trusts. `signer` is undefined when
 * the call was sent unsigned on purpose (--no-sign). A call to a fleet is let in by the fleet's owner, not by a
 * device's callers file.
 */
export function callerRefusedHint(signer: CallSigner | undefined, options: { fleet?: boolean } = {}): string {
  if (!signer) return "This call was sent unsigned because of --no-sign; a device that only runs signed calls refuses it. Run it again without --no-sign.";
  const key = signer.callerKey();
  if (!key) {
    return `This device only runs signed calls, and this machine has no usable caller key to sign with${signer.problem() ? ` (${signer.problem()})` : ""}.`;
  }
  if (options.fleet) {
    return `This fleet does not trust this machine's caller key (${key.keyId}). Ask the fleet's owner to allow this key: ${key.publicKeyB64}\nIf it is already allowed, the signature may have been altered on the way: run the call again.`;
  }
  return (
    `This device does not trust this machine's caller key (${key.keyId}). Run on the device's machine: ${allowCallerCommand(key)}\n` +
    "(for a space made with 'prime spaces create', add --space <name> to that command)\n" +
    "If this machine is already allowed there, the signature may have been altered on the way (the gateway can do that): run the call again."
  );
}

// ---- the callers file --------------------------------------------------------
//
//   { "version": 1, "callers": [ { "keyId", "pub", "label", "addedAt", "tools"? } ] }
//
// A file that is missing holds no callers. A file that is empty, cut short, of another version or otherwise not
// this format is an error and never "no callers": a device that enforces signatures must not stop enforcing
// because the file it keeps them in was truncated.

export const CALLERS_FILE_VERSION = 1;

export interface CallerEntry {
  keyId: string;
  /** Raw public key, base64. */
  pub: string;
  label: string;
  addedAt: string;
  /** The only tools this key may call; every tool when absent. Never present and empty. */
  tools?: string[];
}

function fail(path: string, why: string): never {
  throw new Error(`${path}: ${why}`);
}

function asEntry(path: string, value: unknown): CallerEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "a caller entry is not an object");
  const v = value as Record<string, unknown>;
  const raw = typeof v.pub === "string" ? parsePublicKey(v.pub) : undefined;
  if (!raw) fail(path, "a caller entry has no valid public key");
  // A restriction that cannot be read is an error, not "every tool".
  let tools: string[] | undefined;
  if (v.tools !== undefined) {
    if (!Array.isArray(v.tools) || v.tools.length === 0 || !v.tools.every((t) => typeof t === "string" && t.length > 0)) {
      fail(path, `the tools of caller ${keyIdOf(raw)} must be a non-empty list of tool names`);
    }
    tools = [...(v.tools as string[])];
  }
  // The id is derived from the key, never taken on trust from the file.
  return {
    keyId: keyIdOf(raw),
    pub: raw.toString("base64"),
    label: typeof v.label === "string" ? v.label : "",
    addedAt: typeof v.addedAt === "string" ? v.addedAt : "",
    ...(tools ? { tools } : {}),
  };
}

/** The callers in the file. Missing is none; anything that is not a whole file of this format is an error. */
export function readCallers(path: string = callersPath()): CallerEntry[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  if (text.trim().length === 0) fail(path, "the file is empty (it may have been cut short); delete it or run 'prime devices allow-caller' again");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(path, "not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail(path, `must hold {"version": ${CALLERS_FILE_VERSION}, "callers": [...]}`);
  const file = parsed as Record<string, unknown>;
  if (file.version !== CALLERS_FILE_VERSION) fail(path, `version ${String(file.version)} is not one this build reads (it reads ${CALLERS_FILE_VERSION})`);
  if (!Array.isArray(file.callers)) fail(path, "has no callers list");
  const entries = file.callers.map((item) => asEntry(path, item));
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.keyId)) fail(path, `caller ${entry.keyId} is listed twice`);
    seen.add(entry.keyId);
  }
  return entries;
}

function writeCallers(path: string, entries: CallerEntry[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const file = { version: CALLERS_FILE_VERSION, callers: entries };
  // Durable: the file is rarely written, and one cut short by a crash would be an error for the device.
  writeFileAtomic(path, JSON.stringify(file, null, 2) + "\n", 0o600, { durable: true });
}

/** Read, change and write the file with nobody else changing it in between (two writers must not lose each other's change). */
function updateCallers<T>(path: string, change: (entries: CallerEntry[]) => { entries?: CallerEntry[]; result: T }): T {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withDirLockSync(
    `${path}.lock`,
    () => {
      const { entries, result } = change(readCallers(path));
      if (entries) writeCallers(path, entries);
      return result;
    },
    { waitMs: 10_000, staleMs: 60_000 },
  );
}

/**
 * Add a caller. An entry that is already there keeps its label, its date and its tool restriction unless the
 * input says otherwise: `tools` sets the restriction, `allTools` lifts it.
 */
export function addCaller(
  path: string,
  input: { pub: Buffer; label?: string; tools?: string[]; allTools?: boolean },
  now: Date = new Date(),
): { entry: CallerEntry; added: boolean } {
  if (input.tools !== undefined && (input.tools.length === 0 || input.tools.some((t) => t.length === 0))) {
    throw new Error("the tools of a caller must be a non-empty list of tool names");
  }
  if (input.tools && input.allTools) throw new Error("a caller cannot be limited to some tools and allowed all of them");
  const keyId = keyIdOf(input.pub);
  return updateCallers(path, (entries) => {
    const existing = entries.find((e) => e.keyId === keyId);
    const tools = input.allTools ? undefined : (input.tools ?? existing?.tools);
    const entry: CallerEntry = {
      keyId,
      pub: input.pub.toString("base64"),
      label: input.label ?? existing?.label ?? "",
      addedAt: existing?.addedAt || now.toISOString(),
      ...(tools ? { tools } : {}),
    };
    return { entries: [...entries.filter((e) => e.keyId !== keyId), entry], result: { entry, added: !existing } };
  });
}

/** Remove a caller by key id. Returns whether it was there. */
export function removeCaller(path: string, keyId: string): boolean {
  return updateCallers(path, (entries) => {
    const kept = entries.filter((e) => e.keyId !== keyId);
    return kept.length === entries.length ? { result: false } : { entries: kept, result: true };
  });
}
