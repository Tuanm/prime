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
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { defaultConfigPath } from "./config.ts";

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

/** The default callers file of the device on this machine, beside its config. */
export function callersPath(): string {
  const override = process.env.PRIME_CALLERS;
  if (override && override.trim().length > 0) return override.trim();
  return join(dirname(defaultConfigPath()), "callers.json");
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

function readKey(path: string): CallerKey {
  const key = createPrivateKey(readFileSync(path, "utf8"));
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${path} is not an Ed25519 key`);
  return fromPrivate(key);
}

/**
 * This machine's caller key, made on first use. The private half is written once, mode 0600, and is
 * never printed: two processes that start together end up with the same key.
 */
export function loadOrCreateCallerKey(path: string = callerKeyPath()): CallerKey {
  if (existsSync(path)) return readKey(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const pem = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  const scratch = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(scratch, pem, { mode: 0o600 });
    try {
      // A hard link fails when the name is taken, which is how a racing process loses: it reads the winner's key.
      linkSync(scratch, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return readKey(path);
      // A file system with no hard links: move it into place if the name is still free.
      if (existsSync(path)) return readKey(path);
      renameSync(scratch, path);
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

/** The signature target of a call: a fleet when the call addresses one, else the device. */
export function signTarget(target: { deviceId: string; fleet?: string }): string {
  return target.fleet ? `fleet:${target.fleet}` : `device:${target.deviceId}`;
}

/**
 * Signs calls for a client. The key is made the first time a call needs it; if it cannot be made or read
 * (a read-only home), the call goes out unsigned and the reason is given once.
 */
export class CallSigner {
  private key: CallerKey | undefined;
  private failed = false;
  private readonly path: string | undefined;
  private readonly warn: (text: string) => void;

  constructor(options: { path?: string; warn?: (text: string) => void } = {}) {
    this.path = options.path;
    this.warn = options.warn ?? ((text) => process.stderr.write(`${text}\n`));
  }

  /** The key, or undefined if there is none to be had. */
  callerKey(): CallerKey | undefined {
    if (this.key) return this.key;
    if (this.failed) return undefined;
    try {
      this.key = loadOrCreateCallerKey(this.path);
      return this.key;
    } catch (err) {
      this.failed = true;
      this.warn(`prime: calls are not signed: the caller key cannot be used (${err instanceof Error ? err.message : String(err)})`);
      return undefined;
    }
  }

  /** The header for one call, or undefined when it should go unsigned. */
  header(method: string, target: { deviceId: string; fleet?: string }, body: string): string | undefined {
    if (!methodNeedsSignature(method)) return undefined;
    const key = this.callerKey();
    return key ? signCall(key, signTarget(target), body) : undefined;
  }
}

/** The line a person runs on the device's machine to let this machine's calls in. */
export function allowCallerCommand(key: CallerKey): string {
  return `prime devices allow-caller ${key.publicKeyB64}`;
}

/** What to tell someone whose call a device refused for want of a signature it trusts. */
export function callerRefusedHint(signer: CallSigner | undefined): string {
  const key = signer?.callerKey();
  if (!key) return "This device only runs signed calls, and this machine has no caller key to sign with.";
  return `This device does not trust this machine's caller key (${key.keyId}). Run on the device's machine: ${allowCallerCommand(key)}`;
}

// ---- the callers file --------------------------------------------------------

export interface CallerEntry {
  keyId: string;
  /** Raw public key, base64. */
  pub: string;
  label: string;
  addedAt: string;
  /** Tools this key may call; every tool when absent. */
  tools?: string[];
}

function asEntry(value: unknown): CallerEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.pub !== "string") return undefined;
  const raw = parsePublicKey(v.pub);
  if (!raw) return undefined;
  // The id is derived from the key, never taken on trust from the file.
  const tools = Array.isArray(v.tools) ? v.tools.filter((t): t is string => typeof t === "string" && t.length > 0) : undefined;
  return {
    keyId: keyIdOf(raw),
    pub: raw.toString("base64"),
    label: typeof v.label === "string" ? v.label : "",
    addedAt: typeof v.addedAt === "string" ? v.addedAt : "",
    ...(tools && tools.length > 0 ? { tools } : {}),
  };
}

/** The callers in the file. A missing file is no callers; an unreadable or malformed one is an error, never "no callers". */
export function readCallers(path: string = callersPath()): CallerEntry[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  if (text.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${path} must hold a JSON array of callers`);
  const entries: CallerEntry[] = [];
  for (const item of parsed) {
    const entry = asEntry(item);
    if (!entry) throw new Error(`${path} has an entry with no valid public key`);
    entries.push(entry);
  }
  return entries;
}

function writeCallers(path: string, entries: CallerEntry[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, JSON.stringify(entries, null, 2) + "\n", 0o600);
}

/** Add a caller (or update its label and tools when it is already there). Returns the entry and whether it is new. */
export function addCaller(
  path: string,
  input: { pub: Buffer; label?: string; tools?: string[] },
  now: Date = new Date(),
): { entry: CallerEntry; added: boolean } {
  const entries = readCallers(path);
  const keyId = keyIdOf(input.pub);
  const existing = entries.find((e) => e.keyId === keyId);
  const tools = input.tools && input.tools.length > 0 ? input.tools : undefined;
  const entry: CallerEntry = {
    keyId,
    pub: input.pub.toString("base64"),
    label: input.label ?? existing?.label ?? "",
    addedAt: existing?.addedAt || now.toISOString(),
    ...(tools ? { tools } : {}),
  };
  writeCallers(path, [...entries.filter((e) => e.keyId !== keyId), entry]);
  return { entry, added: !existing };
}

/** Remove a caller by key id. Returns whether it was there. */
export function removeCaller(path: string, keyId: string): boolean {
  const entries = readCallers(path);
  const kept = entries.filter((e) => e.keyId !== keyId);
  if (kept.length === entries.length) return false;
  writeCallers(path, kept);
  return true;
}
