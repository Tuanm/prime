// Code mode for a space: the run tool executes a small JavaScript program in a
// child process.  The child never receives vault secrets: it sees opaque
// placeholders and calls back into the parent (the MCP server) to execute
// tools; the parent substitutes real secrets only for approved integrations and
// redacts them from every result.  Codes (TOTP) are short-lived values and are
// passed as {code, expires_at}; values are ordinary strings.

import { createHmac } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";

export interface RunCode {
  secret: string;
  digits: number;
  period: number;
  algorithm: string;
}

export interface RunVault {
  values: Record<string, string>;
  secrets: Record<string, string>;
  codes: Record<string, RunCode>;
}

export interface RunToolDef {
  handler: (args: any) => Promise<any> | any;
}

export interface RunOutcome {
  ok: boolean;
  result?: unknown;
  logs?: unknown[];
  error?: string;
}

const SECRET_PREFIX = "__prime_vault_secret__:";
const SECRET_SUFFIX = "__";
const DANGEROUS_SECRET_TOOLS = new Set([
  "bash",
  "shell",
  "command",
  "powershell",
  "read",
  "write",
  "edit",
  "multi_edit",
  "grep",
  "find",
  "ls",
  "job",
]);

/** Load the vault payload the entrypoint mounted, then drop the file. The host
 *  removes it as soon as the server answers; reading here keeps the values in
 *  memory only. */
export function loadRunVault(): RunVault {
  const empty: RunVault = { values: {}, secrets: {}, codes: {} };
  const file = process.env.PRIME_VAULT_FILE;
  if (!file || !existsSync(file)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<RunVault>;
    try {
      rmSync(file, { force: true });
    } catch {}
    return {
      values: parsed.values ?? {},
      secrets: parsed.secrets ?? {},
      codes: parsed.codes ?? {},
    };
  } catch {
    try {
      rmSync(file, { force: true });
    } catch {}
    return empty;
  }
}

function base32(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = text.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

export function totpEntry(entry: RunCode, now = Date.now()): { code: string; expires_at: string; expires_in_ms: number; period: number; digits: number } {
  const period = entry.period || 30;
  const counter = Math.floor(now / 1000 / period);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac((entry.algorithm || "SHA1").toLowerCase(), base32(entry.secret)).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0xf;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  const digits = entry.digits || 6;
  return {
    code: String(binary % 10 ** digits).padStart(digits, "0"),
    expires_at: new Date((counter + 1) * period * 1000).toISOString(),
    expires_in_ms: Math.max(0, (counter + 1) * period * 1000 - now),
    period,
    digits,
  };
}

function redact(value: unknown, secrets: string[], placeholders: string[], seen = new Set<unknown>()): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const secret of secrets) {
      if (secret.length >= 3) text = text.split(secret).join("***");
    }
    for (const placeholder of placeholders) text = text.split(placeholder).join("***");
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets, placeholders, seen));
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = redact(item, secrets, placeholders, seen);
    return out;
  }
  return value;
}

function substitute(value: unknown, mapping: Map<string, string>): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const [placeholder, secret] of mapping) text = text.split(placeholder).join(secret);
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, mapping));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = substitute(item, mapping);
    return out;
  }
  return value;
}

function hasPlaceholder(value: unknown, mapping: Map<string, string>): boolean {
  if (typeof value === "string") {
    for (const placeholder of mapping.keys()) if (value.includes(placeholder)) return true;
    return false;
  }
  if (Array.isArray(value)) return value.some((item) => hasPlaceholder(item, mapping));
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).some((item) => hasPlaceholder(item, mapping));
  return false;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Run code in a child process and proxy its tool calls back here. */
export async function runCodeInChild(
  code: string,
  timeoutMs: number,
  tools: Record<string, RunToolDef>,
  vault: RunVault,
): Promise<RunOutcome> {
  if (typeof code !== "string" || code.trim().length === 0) return { ok: false, error: "code must be a nonempty string" };
  if (code.length > 100_000) return { ok: false, error: "code is too large (max 100000 characters)" };
  const mapping = new Map<string, string>();
  const childSecrets: Record<string, string> = {};
  for (const [name, secret] of Object.entries(vault.secrets)) {
    const placeholder = SECRET_PREFIX + name + SECRET_SUFFIX;
    mapping.set(placeholder, secret);
    childSecrets[name] = placeholder;
  }
  const childCodes: Record<string, ReturnType<typeof totpEntry>> = {};
  for (const [name, entry] of Object.entries(vault.codes)) childCodes[name] = totpEntry(entry);

  const payload = {
    code,
    values: vault.values,
    secrets: childSecrets,
    codes: childCodes,
  };
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "PRIME_VAULT_FILE") env[key] = value;
  }
  const proc = Bun.spawn({
    cmd: [process.execPath, "__run-sandbox"],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = proc.stdout.getReader();
  const readLine = async (): Promise<string | undefined> => {
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        return line;
      }
      const chunk = await reader.read();
      if (chunk.done) return buffer.length > 0 ? buffer : undefined;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("run timed out after " + timeoutMs + "ms")), timeoutMs));
  const sanitize = (value: unknown) => redact(value, Object.values(vault.secrets), [...mapping.keys()]);
  let stderr = "";
  if (proc.stderr) {
    const stderrReader = proc.stderr.getReader();
    (async () => {
      for (;;) {
        const chunk = await stderrReader.read();
        if (chunk.done) break;
        stderr += new TextDecoder().decode(chunk.value);
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      }
    })().catch(() => {});
  }
  try {
    proc.stdin.write(stringify(payload) + "\n");
  } catch (err) {
    proc.kill();
    return { ok: false, error: "cannot start the code sandbox: " + (err instanceof Error ? err.message : String(err)) };
  }
  try {
    for (;;) {
      const line = await Promise.race([readLine(), timeout]);
      if (line === undefined) break;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message?.type === "tool" && typeof message.name === "string") {
        const id = Number(message.id);
        const name = message.name;
        const args = message.args ?? {};
        let outcome: { ok: boolean; result?: unknown; error?: string };
        try {
          const tool = Object.hasOwn(tools, name) ? tools[name] : undefined;
          if (!tool) throw new Error('unknown tool "' + name + '"');
          if (name === "run") throw new Error("run cannot call itself");
          if (DANGEROUS_SECRET_TOOLS.has(name) && hasPlaceholder(args, mapping)) {
            throw new Error("vault secrets cannot be passed to " + name + " (they would appear in files or shell output); use an mcp integration instead");
          }
          const substituted = substitute(args, mapping);
          const result = await tool.handler(substituted);
          outcome = { ok: true, result: sanitize(result) };
        } catch (err) {
          outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        try {
          proc.stdin.write(stringify({ type: "result", id, ...outcome }) + "\n");
        } catch {}
        continue;
      }
      if (message?.type === "done") {
        const result = sanitize(message.result);
        const logs = Array.isArray(message.logs) ? (sanitize(message.logs) as unknown[]) : undefined;
        return message.ok ? { ok: true, result, logs } : { ok: false, error: String(message.error ?? "run failed"), logs };
      }
    }
    const code = await proc.exited;
    return { ok: false, error: "the code sandbox exited without a result" + (code ? " (exit " + code + ")" : "") + (stderr ? ": " + stderr.trim() : "") };
  } catch (err) {
    proc.kill();
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      await proc.exited;
    } catch {}
  }
}

/** Child process entry: "prime __run-sandbox". Never sees real secrets. */
export async function runSandboxChild(): Promise<void> {
  const rl = createInterface({ input: process.stdin });
  const iterator = rl[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) return;
  const payload = JSON.parse(first.value) as { code: string; values: Record<string, string>; secrets: Record<string, string>; codes: Record<string, unknown> };
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let nextId = 1;
  const write = (message: unknown) => process.stdout.write(stringify(message) + "\n");
  (async () => {
    for await (const line of rl) {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message?.type === "result" && typeof message.id === "number") {
        const entry = pending.get(message.id);
        if (!entry) continue;
        pending.delete(message.id);
        if (message.ok) entry.resolve(message.result);
        else entry.reject(new Error(String(message.error ?? "tool failed")));
      }
    }
  })().catch(() => {});
  const rpc = (name: string, args: unknown) => {
    const id = nextId++;
    write({ type: "tool", id, name, args });
    return new Promise<any>((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  const tools = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then") return undefined;
        if (typeof property !== "string") return undefined;
        return (args: unknown = {}) => rpc(property, args);
      },
    },
  );
  const logs: unknown[] = [];
  const consoleProxy = {
    log: (...args: unknown[]) => logs.push(args.length === 1 ? args[0] : args),
    info: (...args: unknown[]) => logs.push(args.length === 1 ? args[0] : args),
    warn: (...args: unknown[]) => logs.push(args.length === 1 ? args[0] : args),
    error: (...args: unknown[]) => logs.push(args.length === 1 ? args[0] : args),
  };
  try {
    const fn = new Function(
      "tools",
      "values",
      "secrets",
      "codes",
      "console",
      '"use strict"; return (async () => {\n' + payload.code + "\n})();",
    );
    const result = await fn(tools, payload.values, payload.secrets, payload.codes, consoleProxy);
    write({ type: "done", ok: true, result, logs });
  } catch (err) {
    write({ type: "done", ok: false, error: err instanceof Error ? err.message : String(err), logs });
  }
  process.exit(0);
}
