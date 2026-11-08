// "prime vaults" - encrypted local values, secrets and TOTP codes, grouped by
// company (a companion). The database lives in ~/.prime/vaults.db and every
// stored value is sealed with AES-256-GCM. The key lives in the OS keychain
// when possible, otherwise in a 0600 file (with a warning), or in
// PRIME_VAULT_KEY / PRIME_VAULT_KEY_FILE for automation.
//
// A space can be assigned one or more companies.  Its run tool receives flat
// maps: values, secrets and codes (TOTP parameters).  Duplicate names across the
// selected companies are rejected so the flat syntax stays unambiguous.

import { Database } from "bun:sqlite";
import { createDecipheriv, createCipheriv, createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bool, str, strList } from "./args.ts";
import { saveConfig } from "./config.ts";
import { brokerStatus } from "./vault-broker.ts";
import type { Ctx } from "./context.ts";
import { CliError, UsageError } from "./errors.ts";
import { bold, dim, green, printJson, table, yellow } from "./output.ts";

export type VaultKind = "value" | "secret" | "code";

export interface VaultCode {
  secret: string;
  digits: number;
  period: number;
  algorithm: "SHA1" | "SHA256" | "SHA512";
  issuer?: string;
  label?: string;
  /** Hosts where the broker may send this code. */
  hosts?: string[];
}

export interface VaultSecret {
  value: string;
  hosts: string[];
}

export interface BrokerScope {
  values: Record<string, string>;
  secrets: Record<string, VaultSecret>;
  codes: Record<string, VaultCode & { hosts: string[] }>;
}

export interface VaultPayload {
  values: Record<string, string>;
  secrets: Record<string, string>;
  codes: Record<string, VaultCode>;
}

const KINDS: VaultKind[] = ["value", "secret", "code"];
const KINDSET = new Set<string>(KINDS);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KEYCHAIN_SERVICE = "prime-vault";
const KEYCHAIN_ACCOUNT = "default";
const SEAL_VERSION = "v1";

interface Sealed {
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

function vaultDir(configPath: string): string {
  return dirname(configPath);
}

function vaultPath(configPath: string): string {
  return join(vaultDir(configPath), "vaults.db");
}

function keyFilePath(configPath: string): string {
  // A separate 0700 directory from the database, so a backup of the DB never
  // carries the key with it. The OS keychain is preferred when available.
  return join(vaultDir(configPath), "keys", "vaults.key");
}

function run(bin: string, args: string[], stdin?: string): { code: number; out: string; err: string } {
  try {
    const proc = Bun.spawnSync({
      cmd: [bin, ...args],
      stdin: stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
      ...(stdin === undefined ? {} : { input: stdin }),
    });
    return { code: proc.exitCode ?? 1, out: proc.stdout ? proc.stdout.toString() : "", err: proc.stderr ? proc.stderr.toString() : "" };
  } catch (err) {
    return { code: 1, out: "", err: err instanceof Error ? err.message : String(err) };
  }
}

function encodeKey(key: Buffer): string {
  return key.toString("base64");
}

function decodeKey(text: string): Buffer {
  const trimmed = text.trim();
  const key = Buffer.from(trimmed, "base64");
  if (key.length !== 32) throw new CliError("invalid vault key", "The key must be 32 bytes, base64-encoded.");
  return key;
}

/** The OS keychain, if the platform has one and it already holds our key. */
function keychainFind(): string | undefined {
  if (process.platform === "darwin") {
    const r = run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"]);
    if (r.code === 0 && r.out.trim()) return r.out.trim();
    return undefined;
  }
  const r = run("secret-tool", ["lookup", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT]);
  if (r.code === 0 && r.out.trim()) return r.out.trim();
  return undefined;
}

function keychainStore(encoded: string): boolean {
  if (process.platform === "darwin") {
    const r = run("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", encoded]);
    return r.code === 0;
  }
  const r = run("secret-tool", ["store", "--label=prime-vault", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT], encoded);
  return r.code === 0;
}

/** Load or create the vault key, and report where it is kept.
 *  Creating a keychain item may show an authorization dialog, so it only
 *  happens with the explicit --keychain flag; otherwise a 0600 key file is used. */
export function vaultKey(configPath: string, create: boolean, useKeychain = false): { key: Buffer; backend: string } {
  const fromEnv = process.env.PRIME_VAULT_KEY;
  if (fromEnv) return { key: decodeKey(fromEnv), backend: "environment (PRIME_VAULT_KEY)" };
  const envFile = process.env.PRIME_VAULT_KEY_FILE;
  if (envFile) {
    if (!existsSync(envFile)) throw new CliError("vault key file is missing: " + envFile, "Create it with a 32-byte base64 key, or unset PRIME_VAULT_KEY_FILE.");
    return { key: decodeKey(readFileSync(envFile, "utf8")), backend: "file " + envFile };
  }
  try {
    const found = keychainFind();
    if (found) return { key: decodeKey(found), backend: process.platform === "darwin" ? "macOS Keychain" : "Secret Service" };
  } catch {
    // A missing keychain tool or a locked keychain falls through to the file.
  }
  const file = keyFilePath(configPath);
  if (existsSync(file)) return { key: decodeKey(readFileSync(file, "utf8")), backend: "file " + file };
  if (!create) throw new CliError("vault is not initialised", "Run 'prime vaults init' first.");
  const key = randomBytes(32);
  if (useKeychain && keychainStore(encodeKey(key))) {
    return { key, backend: process.platform === "darwin" ? "macOS Keychain" : "Secret Service" };
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(dirname(file), 0o700);
  writeFileSync(file, encodeKey(key) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return {
    key,
    backend: "file " + file + (useKeychain ? " (keychain creation was not authorized)" : " (use --keychain for the OS keychain)"),
    warning: true,
  } as { key: Buffer; backend: string };
}

function seal(key: Buffer, plaintext: string, aad: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  return { iv, ciphertext, tag: cipher.getAuthTag() };
}

function openSealed(key: Buffer, sealed: Sealed, aad: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(sealed.tag);
  try {
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new CliError("cannot decrypt a vault entry", "The key changed or the database was modified; restore the original key or re-add the entry.");
  }
}

function aad(company: string, kind: string, name: string): string {
  return SEAL_VERSION + "|" + company + "|" + kind + "|" + name;
}

function openDb(configPath: string, create: boolean, useKeychain = false): { db: Database; key: Buffer; backend: string } {
  const file = vaultPath(configPath);
  if (!existsSync(file) && !create) throw new CliError("vault is not initialised", "Run 'prime vaults init' first.");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const { key, backend } = vaultKey(configPath, create, useKeychain);
  const db = new Database(file, { create: true });
  db.exec("PRAGMA foreign_keys = ON;");
  if (create) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS companies (name TEXT PRIMARY KEY, created_at TEXT NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS entries (" +
        " company TEXT NOT NULL REFERENCES companies(name) ON DELETE CASCADE," +
        " kind TEXT NOT NULL CHECK (kind IN ('value','secret','code'))," +
        " name TEXT NOT NULL," +
        " iv BLOB NOT NULL, ciphertext BLOB NOT NULL, tag BLOB NOT NULL," +
        " updated_at TEXT NOT NULL," +
        " PRIMARY KEY (company, kind, name));",
    );
    try {
      chmodSync(file, 0o600);
    } catch {}
  }
  return { db, key, backend };
}

function assertCompany(db: Database, company: string): void {
  const row = db.query("SELECT name FROM companies WHERE name = ?").get(company);
  if (!row) throw new UsageError('no company named "' + company + '"', "Create it with: prime vaults company add " + company);
}

function assertName(name: string): void {
  if (!NAME_RE.test(name)) throw new UsageError('invalid name "' + name + '"', "Use letters, digits, dot, dash or underscore (max 64).");
}

function assertKind(kind: string): VaultKind {
  if (!KINDSET.has(kind)) throw new UsageError('unknown kind "' + kind + '"', "Use value, secret or code.");
  return kind as VaultKind;
}

function encodeBase32(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = text.replace(/[\s=]/g, "").toUpperCase();
  if (!/^[A-Z2-7]+$/.test(clean) || clean.length === 0) throw new UsageError("invalid TOTP secret", "The secret must be base32 (A-Z, 2-7).");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new UsageError("invalid TOTP secret", "The secret must be base32 (A-Z, 2-7).");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

export function parseOtpAuth(uri: string): VaultCode {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    throw new UsageError("invalid otpauth URI", "Expected otpauth://totp/Label?secret=BASE32&issuer=...");
  }
  if (url.protocol !== "otpauth:" || url.hostname.toLowerCase() !== "totp") {
    throw new UsageError("only TOTP otpauth URIs are supported", "Expected otpauth://totp/Label?secret=...");
  }
  const secret = url.searchParams.get("secret");
  if (!secret) throw new UsageError("otpauth URI has no secret", "Add ?secret=BASE32.");
  const digits = Number(url.searchParams.get("digits") ?? "6");
  const period = Number(url.searchParams.get("period") ?? "30");
  const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
  if (![6, 8].includes(digits)) throw new UsageError("unsupported TOTP digits", "Use 6 or 8 digits.");
  if (!Number.isFinite(period) || period < 10 || period > 120) throw new UsageError("unsupported TOTP period", "Use a period between 10 and 120 seconds.");
  if (algorithm !== "SHA1" && algorithm !== "SHA256" && algorithm !== "SHA512") throw new UsageError("unsupported TOTP algorithm", "Use SHA1, SHA256 or SHA512.");
  let label = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!label) label = undefined as unknown as string;
  return {
    secret,
    digits,
    period,
    algorithm,
    issuer: url.searchParams.get("issuer") ?? undefined,
    label: label || undefined,
  };
}

export function totpAt(code: VaultCode, now = Date.now()): { code: string; expires_at: string; expires_in_ms: number; period: number; digits: number } {
  const period = code.period;
  const counter = Math.floor(now / 1000 / period);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(code.algorithm.toLowerCase(), encodeBase32(code.secret)).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0xf;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  const digits = code.digits;
  const value = String(binary % 10 ** digits).padStart(digits, "0");
  const expiry = (counter + 1) * period * 1000;
  return { code: value, expires_at: new Date(expiry).toISOString(), expires_in_ms: Math.max(0, expiry - now), period, digits };
}

function readValue(ctx: Ctx, kind: VaultKind, uri: string | undefined): string {
  const flag = str(ctx.parsed, "value");
  if (kind === "code") {
    const raw = uri ?? (bool(ctx.parsed, "stdin") ? readFileSync(0, "utf8").trim() : undefined);
    if (!raw) throw new UsageError("missing TOTP URI", "Pass --uri otpauth://... or pipe the URI with --stdin.");
    return raw;
  }
  if (flag !== undefined) {
    if (kind === "secret") {
      throw new UsageError("--value would expose a secret in the process list", "Pipe it instead: printf '%s' \"$SECRET\" | prime vaults set " + (ctx.parsed.positionals[2] ?? "company") + " secret " + (ctx.parsed.positionals[4] ?? "name") + " --stdin");
    }
    return flag;
  }
  if (bool(ctx.parsed, "stdin")) return readFileSync(0, "utf8").replace(/\r?\n$/, "");
  throw new UsageError("missing value", "Pass --value for values, or --stdin to read from the terminal/pipe.");
}

function upsert(ctx: Ctx, company: string, kind: VaultKind, name: string, plaintext: string): void {
  const { db, key } = openDb(ctx.configPath, false);
  try {
    assertCompany(db, company);
    assertName(name);
    const sealed = seal(key, plaintext, aad(company, kind, name));
    db.query(
      "INSERT INTO entries (company, kind, name, iv, ciphertext, tag, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(company, kind, name) DO UPDATE SET iv=excluded.iv, ciphertext=excluded.ciphertext, tag=excluded.tag, updated_at=excluded.updated_at",
    ).run(company, kind, name, sealed.iv, sealed.ciphertext, sealed.tag, new Date().toISOString());
  } finally {
    db.close();
  }
}

function decryptEntry(db: Database, key: Buffer, company: string, kind: string, name: string): string {
  const row = db.query("SELECT iv, ciphertext, tag FROM entries WHERE company = ? AND kind = ? AND name = ?").get(company, kind, name) as
    | { iv: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array }
    | null;
  if (!row) throw new UsageError('no ' + kind + ' named "' + name + '" in company "' + company + '"', "Run 'prime vaults list " + company + "'.");
  return openSealed(key, { iv: Buffer.from(row.iv), ciphertext: Buffer.from(row.ciphertext), tag: Buffer.from(row.tag) }, aad(company, kind, name));
}

function sealed(row: { iv: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array }): Sealed {
  return { iv: Buffer.from(row.iv), ciphertext: Buffer.from(row.ciphertext), tag: Buffer.from(row.tag) };
}

function codeEntry(db: Database, key: Buffer, company: string, name: string): VaultCode {
  try {
    return JSON.parse(decryptEntry(db, key, company, "code", name)) as VaultCode;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError("stored TOTP entry is invalid", "Remove and add it again with 'prime vaults set ... code ...'.");
  }
}

function mask(text: string): string {
  return text.length === 0 ? "(empty)" : "*".repeat(Math.min(Math.max(text.length, 8), 24));
}

export function allVaultCompanies(configPath: string): string[] {
  const { db } = openDb(configPath, false);
  try {
    return (db.query("SELECT name FROM companies ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
  } finally {
    db.close();
  }
}

export function vaultPayloadFor(configPath: string, companies: string[], kinds?: string[], trusted = true): VaultPayload {
  const payload: VaultPayload = { values: {}, secrets: {}, codes: {} };
  if (companies.length === 0) return payload;
  const { db, key } = openDb(configPath, false);
  try {
    for (const company of companies) {
      assertCompany(db, company);
      const rows = db.query("SELECT kind, name, iv, ciphertext, tag FROM entries WHERE company = ? ORDER BY kind, name").all(company) as Array<{
        kind: string;
        name: string;
        iv: Uint8Array;
        ciphertext: Uint8Array;
        tag: Uint8Array;
      }>;
      for (const row of rows) {
        if (!trusted && row.kind !== "value") continue;
        if (kinds && kinds.length > 0 && !kinds.includes(row.kind)) continue;
        const plaintext = openSealed(key, sealed(row), aad(company, row.kind, row.name));
        const target = row.kind === "value" ? payload.values : row.kind === "secret" ? payload.secrets : payload.codes;
        if (Object.hasOwn(payload.values, row.name) || Object.hasOwn(payload.secrets, row.name) || Object.hasOwn(payload.codes, row.name)) {
          throw new CliError('duplicate vault name "' + row.name + '" across assigned companies', "Rename the entry so the flat values/secrets/codes maps stay unambiguous.");
        }
        if (row.kind === "code") payload.codes[row.name] = JSON.parse(plaintext) as VaultCode;
        else (target as Record<string, string>)[row.name] = plaintext;
      }
    }
  } finally {
    db.close();
  }
  return payload;
}


/** Per-space broker scope: values are returned; secrets/codes keep their
 *  allowed-host list so the broker can enforce it. */
export function brokerScopeFor(configPath: string, companies: string[], kinds?: string[]): BrokerScope {
  const scope: BrokerScope = { values: {}, secrets: {}, codes: {} };
  const { db, key } = openDb(configPath, false);
  try {
    for (const company of companies) {
      assertCompany(db, company);
      const rows = db.query("SELECT kind, name, iv, ciphertext, tag FROM entries WHERE company = ? ORDER BY kind, name").all(company) as Array<{
        kind: string;
        name: string;
        iv: Uint8Array;
        ciphertext: Uint8Array;
        tag: Uint8Array;
      }>;
      for (const row of rows) {
        if (kinds && kinds.length > 0 && !kinds.includes(row.kind)) continue;
        if (Object.hasOwn(scope.values, row.name) || Object.hasOwn(scope.secrets, row.name) || Object.hasOwn(scope.codes, row.name)) {
          throw new CliError('duplicate vault name "' + row.name + '" across assigned companies', "Rename the entry so the flat maps stay unambiguous.");
        }
        const plaintext = openSealed(key, sealed(row), aad(company, row.kind, row.name));
        if (row.kind === "value") {
          scope.values[row.name] = plaintext;
        } else if (row.kind === "secret") {
          let value = plaintext;
          let hosts: string[] = [];
          try {
            const parsed = JSON.parse(plaintext) as { value?: unknown; hosts?: unknown };
            if (typeof parsed.value === "string") value = parsed.value;
            if (Array.isArray(parsed.hosts)) hosts = parsed.hosts.filter((host): host is string => typeof host === "string");
          } catch {}
          scope.secrets[row.name] = { value, hosts };
        } else {
          const parsed = JSON.parse(plaintext) as VaultCode;
          scope.codes[row.name] = { ...parsed, hosts: Array.isArray(parsed.hosts) ? parsed.hosts : [] };
        }
      }
    }
  } finally {
    db.close();
  }
  return scope;
}

export async function vaultsCommand(ctx: Ctx): Promise<void> {
  const args = ctx.parsed.positionals;
  const sub = args[1];
  if (!sub) throw new UsageError("missing vaults command", "Usage: prime vaults <init|company|set|list|get|code|rm|assign|status> [args]");
  if (sub === "init") return vaultsInit(ctx);
  if (sub === "company" || sub === "companies") return vaultsCompany(ctx, args[2], args[3]);
  if (sub === "set") return vaultsSet(ctx);
  if (sub === "list") return vaultsList(ctx, args[2]);
  if (sub === "get") return vaultsGet(ctx);
  if (sub === "code") return vaultsCode(ctx);
  if (sub === "rm" || sub === "remove") return vaultsRemove(ctx);
  if (sub === "assign") return vaultsAssign(ctx);
  if (sub === "status") return vaultsStatus(ctx);
  throw new UsageError('unknown vaults command "' + sub + '"', "Valid: init, company, set, list, get, code, rm, assign, status.");
}

function vaultsInit(ctx: Ctx): void {
  const file = vaultPath(ctx.configPath);
  const existing = existsSync(file);
  const { db, backend } = openDb(ctx.configPath, true, bool(ctx.parsed, "keychain"));
  db.close();
  if (ctx.json) {
    printJson({ initialised: true, database: file, key_backend: backend, already_existed: existing });
    return;
  }
  ctx.out(green("\u2713") + " vault ready");
  ctx.out("  database " + dim(file));
  ctx.out("  key      " + dim(backend));
  if (/^file /.test(backend)) ctx.note(yellow("  warning: the key is a local 0600 file; pass --keychain to use the OS keychain, or set PRIME_VAULT_KEY_FILE"));
}

function vaultsCompany(ctx: Ctx, action: string | undefined, name: string | undefined): void {
  const { db } = openDb(ctx.configPath, false);
  try {
    if (!action) throw new UsageError("missing company action", "Usage: prime vaults company <add|list|rm> [name]");
    if (action === "list") {
      const rows = db.query("SELECT name, (SELECT COUNT(*) FROM entries WHERE company = companies.name) AS entries FROM companies ORDER BY name").all() as Array<{
        name: string;
        entries: number;
      }>;
      if (ctx.json) {
        printJson({ companies: rows });
        return;
      }
      if (rows.length === 0) {
        ctx.out(dim("No companies yet. Create one with: prime vaults company add <name>"));
        return;
      }
      ctx.out(table(["COMPANY", "ENTRIES"], rows.map((row) => [bold(row.name), String(row.entries)])));
      return;
    }
    if (!name) throw new UsageError("missing company name", "Usage: prime vaults company " + action + " <name>");
    assertName(name);
    if (action === "add") {
      db.query("INSERT INTO companies (name, created_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING").run(name, new Date().toISOString());
      ctx.out(green("\u2713") + " company " + bold(name));
      return;
    }
    if (action === "rm" || action === "remove") {
      assertCompany(db, name);
      db.query("DELETE FROM companies WHERE name = ?").run(name);
      ctx.out(green("\u2713") + " removed company " + bold(name) + dim(" (and its entries)"));
      return;
    }
    throw new UsageError('unknown company action "' + action + '"', "Valid: add, list, rm.");
  } finally {
    db.close();
  }
}

function vaultsSet(ctx: Ctx): void {
  const [, , company, kindRaw, name] = ctx.parsed.positionals;
  if (!company || !kindRaw || !name) throw new UsageError("missing arguments", "Usage: prime vaults set <company> <value|secret|code> <name> [--value <v> | --stdin | --uri <otpauth://...>]");
  const kind = assertKind(kindRaw);
  assertName(name);
  const hosts = strList(ctx.parsed, "allow-host").map((host) => host.trim().toLowerCase()).filter(Boolean);
  const raw = readValue(ctx, kind, str(ctx.parsed, "uri"));
  const plaintext =
    kind === "code"
      ? JSON.stringify({ ...parseOtpAuth(raw), hosts })
      : kind === "secret"
        ? JSON.stringify({ value: raw, hosts })
        : raw;
  upsert(ctx, company, kind, name, plaintext);
  ctx.out(green("\u2713") + " stored " + kind + " " + bold(name) + " in company " + bold(company));
  if (kind !== "value") {
    if (hosts.length === 0) ctx.note(yellow("  warning: no --allow-host set; the broker cannot use this " + kind));
    ctx.note(dim("  use 'prime vaults get " + company + " " + kind + " " + name + " --reveal' to print it (careful)"));
  }
}

function vaultsList(ctx: Ctx, company: string | undefined): void {
  const { db } = openDb(ctx.configPath, false);
  try {
    if (company) assertCompany(db, company);
    const rows = (company
      ? db.query("SELECT company, kind, name, updated_at FROM entries WHERE company = ? ORDER BY company, kind, name").all(company)
      : db.query("SELECT company, kind, name, updated_at FROM entries ORDER BY company, kind, name").all()) as Array<{
      company: string;
      kind: string;
      name: string;
      updated_at: string;
    }>;
    if (ctx.json) {
      printJson({ entries: rows });
      return;
    }
    if (rows.length === 0) {
      ctx.out(dim("No entries yet. Add one with: prime vaults set <company> <value|secret|code> <name>"));
      return;
    }
    ctx.out(table(["COMPANY", "KIND", "NAME", "UPDATED"], rows.map((row) => [row.company, row.kind, bold(row.name), dim(row.updated_at)])));
  } finally {
    db.close();
  }
}

function vaultsGet(ctx: Ctx): void {
  const [, , company, kindRaw, name] = ctx.parsed.positionals;
  if (!company || !kindRaw || !name) throw new UsageError("missing arguments", "Usage: prime vaults get <company> <value|secret|code> <name> [--reveal] [--json]");
  const kind = assertKind(kindRaw);
  const { db, key } = openDb(ctx.configPath, false);
  try {
    assertCompany(db, company);
    if (kind === "code") {
      const entry = codeEntry(db, key, company, name);
      const totp = totpAt(entry);
      if (ctx.json) printJson({ company, name, kind, ...totp });
      else ctx.out(totp.code + dim("  expires in " + Math.ceil(totp.expires_in_ms / 1000) + "s"));
      return;
    }
    const stored = decryptEntry(db, key, company, kind, name);
    let value = stored;
    if (kind === "secret") {
      try {
        const parsed = JSON.parse(stored) as { value?: unknown };
        if (typeof parsed.value === "string") value = parsed.value;
      } catch {}
    }
    const reveal = bool(ctx.parsed, "reveal");
    if (ctx.json) {
      printJson({ company, name, kind, value: reveal ? value : mask(value), revealed: reveal });
      return;
    }
    ctx.out(reveal ? value : mask(value));
    if (!reveal) ctx.note(dim("  pass --reveal to print the value"));
  } finally {
    db.close();
  }
}

function vaultsCode(ctx: Ctx): void {
  const [, , company, name] = ctx.parsed.positionals;
  if (!company || !name) throw new UsageError("missing arguments", "Usage: prime vaults code <company> <name> [--json]");
  const { db, key } = openDb(ctx.configPath, false);
  try {
    assertCompany(db, company);
    const entry = codeEntry(db, key, company, name);
    const totp = totpAt(entry);
    if (ctx.json) printJson({ company, name, kind: "code", ...totp });
    else ctx.out(totp.code + dim("  expires in " + Math.ceil(totp.expires_in_ms / 1000) + "s"));
  } finally {
    db.close();
  }
}

function vaultsRemove(ctx: Ctx): void {
  const [, , company, kindRaw, name] = ctx.parsed.positionals;
  if (!company || !kindRaw || !name) throw new UsageError("missing arguments", "Usage: prime vaults rm <company> <value|secret|code> <name>");
  const kind = assertKind(kindRaw);
  const { db } = openDb(ctx.configPath, false);
  try {
    assertCompany(db, company);
    const result = db.query("DELETE FROM entries WHERE company = ? AND kind = ? AND name = ?").run(company, kind, name);
    if (result.changes === 0) throw new UsageError('no ' + kind + ' named "' + name + '" in "' + company + '"', "Run 'prime vaults list " + company + "'.");
    ctx.out(green("\u2713") + " removed " + kind + " " + bold(name) + " from " + bold(company));
  } finally {
    db.close();
  }
}

function vaultsAssign(ctx: Ctx): void {
  const [, , spaceName, ...companies] = ctx.parsed.positionals;
  if (!spaceName) throw new UsageError("missing space name", "Usage: prime vaults assign <space> <company...> [--all] [--clear]");
  const space = ctx.config.spaces[spaceName];
  if (!space) throw new UsageError('no space named "' + spaceName + '"', "Create it with: prime spaces create --name " + spaceName);
  const { db } = openDb(ctx.configPath, false);
  try {
    if (bool(ctx.parsed, "clear")) {
      space.vaults = [];
      space.vault_kinds = undefined;
      space.trusted = undefined;
      saveConfig(ctx.configPath, ctx.config);
      ctx.out(green("\u2713") + " cleared vaults for space " + bold(spaceName));
      return;
    }
    let selected = companies;
    if (bool(ctx.parsed, "all")) {
      selected = (db.query("SELECT name FROM companies ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    }
    if (selected.length === 0) throw new UsageError("no companies selected", "Pass company names, or --all.");
    for (const company of selected) assertCompany(db, company);
    const kindsRaw = strList(ctx.parsed, "vault-kind");
    const kinds = new Set<"value" | "secret" | "code">();
    if (kindsRaw.length > 0) {
      for (const item of kindsRaw) {
        const value = String(item).toLowerCase();
        if (value === "value" || value === "values") kinds.add("value");
        else if (value === "secret" || value === "secrets") kinds.add("secret");
        else if (value === "code" || value === "codes") kinds.add("code");
        else throw new UsageError('unknown vault category "' + item + '"', "Use values, secrets or codes.");
      }
    }
    space.vaults = [...new Set(selected)].sort();
    space.vault_kinds = kindsRaw.length > 0 ? [...kinds] : undefined;
    if (bool(ctx.parsed, "trusted")) space.trusted = true;
    saveConfig(ctx.configPath, ctx.config);
    ctx.out(green("\u2713") + " space " + bold(spaceName) + " can use " + space.vaults.join(", "));
    ctx.note(dim("  restart the space to pick up the assignment"));
  } finally {
    db.close();
  }
}

async function vaultsStatus(ctx: Ctx): Promise<void> {
  const file = vaultPath(ctx.configPath);
  if (!existsSync(file)) {
    if (ctx.json) printJson({ initialised: false, database: file });
    else ctx.out(dim("Vault is not initialised. Run: prime vaults init"));
    return;
  }
  const { db, backend } = openDb(ctx.configPath, false);
  try {
    const companies = Number((db.query("SELECT COUNT(*) AS n FROM companies").get() as { n: number }).n);
    const entries = Number((db.query("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n);
    const broker = await brokerStatus(ctx.configPath);
    if (ctx.json) printJson({ initialised: true, database: file, key_backend: backend, companies, entries, broker });
    else {
      ctx.out("  database  " + dim(file));
      ctx.out("  key       " + dim(backend));
      ctx.out("  companies " + companies + "   entries " + entries);
      if (broker.running) {
        ctx.out("  broker    " + green("running") + "   pid " + broker.pid + "   scopes " + (broker.scopes ?? 0) + "   requests " + (broker.requests ?? 0));
        ctx.out("  socket    " + dim(broker.socket ?? ""));
      } else {
        ctx.out("  broker    " + dim("not running (starts on demand)"));
      }
    }
  } finally {
    db.close();
  }
}
