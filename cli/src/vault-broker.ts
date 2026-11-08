// Host-side vault broker.
//
// The vault key and raw secrets never enter a space.  A single broker per host
// runs on demand (started by prime spaces), keeps only the scopes registered by
// the host CLI, and exposes an allowlisted HTTP tool over a per-space token.
// The control channel is a Unix socket (host-only); the HTTP listener binds to
// the space's private gateway address, never to a public interface.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { lookup } from "node:dns/promises";
import { createHmac, randomBytes } from "node:crypto";

export interface BrokerScope {
  values?: Record<string, string>;
  secrets: Record<string, { value: string; hosts: string[] }>;
  codes: Record<string, { secret: string; digits: number; period: number; algorithm: string; hosts: string[] }>;
}

export interface BrokerState {
  pid: number;
  socket: string;
  token: string;
  started_at: string;
}

interface ListenerInfo {
  bind: string;
  port: number;
  server: ReturnType<typeof Bun.serve>;
  tokens: Set<string>;
  unix?: string;
}

const IDLE_MS = Math.max(1_000, Number(process.env.PRIME_BROKER_IDLE_MS) || 10 * 60_000);
// A host CLI can crash between registering a scope and unregistering it. Bound
// how long an abandoned scope can keep secrets in broker memory.
const SCOPE_TTL_MS = Math.max(1_000, Number(process.env.PRIME_BROKER_SCOPE_TTL_MS) || 24 * 60 * 60_000);
const MAX_BODY = 1_000_000;
const REQUEST_TIMEOUT_MS = 10_000;
const DANGEROUS_METHODS = new Set(["CONNECT", "TRACE"]);

function brokerDir(configPath: string): string {
  return dirname(configPath);
}

function brokerStatePath(configPath: string): string {
  return join(brokerDir(configPath), "broker.json");
}

function brokerSocketPath(configPath: string): string {
  return join(brokerDir(configPath), "broker.sock");
}

function randomToken(): string {
  return randomBytes(24).toString("hex");
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

function totpNow(entry: { secret: string; digits: number; period: number; algorithm: string }, now = Date.now()): string {
  const period = entry.period || 30;
  const counter = Math.floor(now / 1000 / period);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac((entry.algorithm || "SHA1").toLowerCase(), base32(entry.secret)).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0xf;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  const digits = entry.digits || 6;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

function isPrivateAddress(address: string): boolean {
  if (address === "::1" || address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80")) return true;
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function hostAllowed(host: string, allowed: string[]): boolean {
  const target = host.toLowerCase();
  return allowed.some((entry) => {
    const rule = entry.toLowerCase();
    return target === rule || target.endsWith("." + rule);
  });
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

function usedPlaceholders(value: unknown, present: Set<string>, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const placeholder of present) if (value.includes(placeholder)) out.add(placeholder);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) usedPlaceholders(item, present, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) usedPlaceholders(item, present, out);
  }
  return out;
}

function redact(value: unknown, secrets: string[], placeholders: string[]): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const secret of secrets) if (secret.length > 0) text = text.split(secret).join("***");
    for (const placeholder of placeholders) text = text.split(placeholder).join("***");
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets, placeholders));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = redact(item, secrets, placeholders);
    return out;
  }
  return value;
}

/** Start the broker process; used by the hidden CLI command. */
export async function brokerMain(): Promise<void> {
  const dir = process.env.PRIME_BROKER_DIR;
  if (!dir) throw new Error("PRIME_BROKER_DIR is required");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const socketPath = join(dir, "broker.sock");
  const statePath = join(dir, "broker.json");
  rmSync(statePath, { force: true });
  rmSync(socketPath, { force: true });

  const controlToken = randomToken();
  const scopes = new Map<string, { scope: BrokerScope; bind: string; port: number; listenerKey: string; expires: number }>();
  const rate = new Map<string, { count: number; start: number }>();
  const listeners = new Map<string, ListenerInfo>();
  const stats = { requests: 0, startedAt: Date.now() };
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (scopes.size > 0) return;
    idleTimer = setTimeout(() => shutdown(), IDLE_MS);
    (idleTimer as any).unref?.();
  };

  const shutdown = () => {
    for (const listener of listeners.values()) {
      try {
        listener.server.stop(true);
      } catch {}
    }
    try {
      control.stop(true);
    } catch {}
    rmSync(statePath, { force: true });
    rmSync(socketPath, { force: true });
    process.exit(0);
  };

  const auth = (req: Request) => req.headers.get("x-broker-control") === controlToken;

  const control = Bun.serve({
    unix: socketPath,
    fetch: async (req) => {
      if (!auth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
      let body: any;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "invalid JSON" }, { status: 400 });
      }
      if (body?.op === "status") {
        return Response.json({
          ok: true,
          pid: process.pid,
          started_at: new Date(stats.startedAt).toISOString(),
          scopes: scopes.size,
          listeners: [...listeners.values()].map((l) => ({ bind: l.bind, port: l.port, tokens: l.tokens.size })),
          requests: stats.requests,
        });
      }
      if (body?.op === "shutdown") {
        setTimeout(() => shutdown(), 10);
        return Response.json({ ok: true });
      }
      if (body?.op === "register") {
        const token = String(body.token ?? "");
        const unix = typeof body.unix === "string" && body.unix.length > 0 ? body.unix : undefined;
        const bind = unix ? "unix" : String(body.bind ?? "");
        const port = unix ? 0 : Number(body.port);
        if (!token || (!unix && (!bind || !Number.isInteger(port) || port < 1 || port > 65535))) {
          return Response.json({ error: "invalid register" }, { status: 400 });
        }
        if (!unix && bind !== "127.0.0.1" && bind !== "0.0.0.0" && !isPrivateAddress(bind)) {
          return Response.json({ error: "bind address must be private" }, { status: 400 });
        }
        const key = unix ? "unix:" + unix : bind + ":" + port;
        let listener = listeners.get(key);
        if (!listener) {
          const handler = async (req: Request) => {
            if (req.method !== "POST" || new URL(req.url).pathname !== "/http") return Response.json({ error: "not found" }, { status: 404 });
            const tokenHeader = req.headers.get("x-prime-broker-token") ?? "";
            const registration = scopes.get(tokenHeader);
            if (!registration) return Response.json({ error: "unauthorized" }, { status: 401 });
            const now = Date.now();
            if (registration.expires < now) return Response.json({ error: "scope expired" }, { status: 401 });
            registration.expires = now + SCOPE_TTL_MS;
            const bucket = rate.get(tokenHeader);
            if (!bucket || now - bucket.start >= 60_000) rate.set(tokenHeader, { count: 1, start: now });
            else if (++bucket.count > 120) return Response.json({ error: "broker rate limit exceeded" }, { status: 429 });
            const declared = Number(req.headers.get("content-length") ?? "0");
            if (Number.isFinite(declared) && declared > 64_000) return Response.json({ error: "request too large" }, { status: 413 });
            return httpTool(req, registration.scope);
          };
          let server: ReturnType<typeof Bun.serve>;
          try {
            server = unix ? Bun.serve({ unix, fetch: handler }) : Bun.serve({ hostname: bind, port, fetch: handler });
          } catch (err) {
            return Response.json({ error: "cannot bind " + (unix ?? bind + ":" + port) + ": " + (err instanceof Error ? err.message : String(err)) }, { status: 500 });
          }
          listener = { bind: unix ?? bind, port, server, tokens: new Set(), ...(unix ? { unix } : {}) };
          listeners.set(key, listener);
        }
        listener.tokens.add(token);
        scopes.set(token, { scope: body.scope as BrokerScope, bind: unix ?? bind, port, listenerKey: key, expires: Date.now() + SCOPE_TTL_MS });
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        return Response.json({ ok: true });
      }
      if (body?.op === "unregister") {
        const token = String(body.token ?? "");
        const registration = scopes.get(token);
        if (registration) {
          scopes.delete(token);
          const listener = listeners.get(registration.listenerKey);
          listener?.tokens.delete(token);
          if (listener && listener.tokens.size === 0) {
            try {
              listener.server.stop(true);
            } catch {}
            if (listener.unix) rmSync(listener.unix, { force: true });
            listeners.delete(registration.listenerKey);
          }
        }
        if (scopes.size === 0) scheduleIdle();
        return Response.json({ ok: true });
      }
      return Response.json({ error: "unknown op" }, { status: 400 });
    },
  });
  try {
    chmodSync(socketPath, 0o600);
  } catch {}
  const state: BrokerState = { pid: process.pid, socket: socketPath, token: controlToken, started_at: new Date(stats.startedAt).toISOString() };
  writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  chmodSync(statePath, 0o600);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  scheduleIdle();
  const prune = setInterval(() => {
    const now = Date.now();
    for (const [token, registration] of scopes) {
      if (registration.expires >= now) continue;
      scopes.delete(token);
      const listener = listeners.get(registration.listenerKey);
      if (!listener) continue;
      listener.tokens.delete(token);
      if (listener.tokens.size > 0) continue;
      try {
        listener.server.stop(true);
      } catch {}
      if (listener.unix) rmSync(listener.unix, { force: true });
      listeners.delete(registration.listenerKey);
    }
    if (scopes.size === 0) scheduleIdle();
  }, Math.min(60_000, Math.max(1_000, Math.floor(SCOPE_TTL_MS / 4))));
  (prune as any).unref?.();
  await new Promise<void>(() => {});
}

async function httpTool(req: Request, scope: BrokerScope): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const method = String(body?.method ?? "GET").toUpperCase();
  if (DANGEROUS_METHODS.has(method)) return Response.json({ error: "method not allowed" }, { status: 400 });
  const url = String(body?.url ?? "");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Response.json({ error: "invalid url" }, { status: 400 });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return Response.json({ error: "only http(s) is allowed" }, { status: 400 });
  const secretPlaceholders = new Set(Object.keys(scope.secrets));
  const codePlaceholders = new Set(Object.keys(scope.codes));
  const usedSecrets = usedPlaceholders(body, secretPlaceholders);
  const usedCodes = usedPlaceholders(body, codePlaceholders);
  if (usedSecrets.size === 0 && usedCodes.size === 0) {
    return Response.json({ error: "no vault secret/code is used; use local tools for non-secret requests" }, { status: 400 });
  }
  const allowedHosts = new Set<string>();
  for (const placeholder of usedSecrets) for (const host of scope.secrets[placeholder]!.hosts) allowedHosts.add(host);
  for (const placeholder of usedCodes) for (const host of scope.codes[placeholder]!.hosts) allowedHosts.add(host);
  if (allowedHosts.size === 0) return Response.json({ error: "no allowed_hosts configured for the used secret/code" }, { status: 403 });
  if (!hostAllowed(parsed.hostname, [...allowedHosts])) return Response.json({ error: "host is not allowed for the used secret/code" }, { status: 403 });
  try {
    const resolved = await lookup(parsed.hostname);
    if (isPrivateAddress(resolved.address)) return Response.json({ error: "private addresses are not allowed" }, { status: 403 });
  } catch {
    return Response.json({ error: "cannot resolve host" }, { status: 502 });
  }
  const mapping = new Map<string, string>();
  const currentCodes: string[] = [];
  for (const placeholder of usedSecrets) mapping.set(placeholder, scope.secrets[placeholder]!.value);
  for (const placeholder of usedCodes) {
    const code = totpNow(scope.codes[placeholder]!);
    currentCodes.push(code);
    mapping.set(placeholder, code);
  }
  const substituted = substitute(body, mapping) as any;
  const headers: Record<string, string> = {};
  if (substituted.headers && typeof substituted.headers === "object") {
    for (const [key, value] of Object.entries(substituted.headers as Record<string, unknown>)) {
      if (typeof value === "string" && !/^(host|content-length|transfer-encoding)$/i.test(key)) headers[key] = value;
    }
  }
  const target = new URL(String(substituted.url));
  if (!hostAllowed(target.hostname, [...allowedHosts])) return Response.json({ error: "redirect target is not allowed" }, { status: 403 });
  let response: Response;
  try {
    response = await fetch(target, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : typeof substituted.body === "string" ? substituted.body : JSON.stringify(substituted.body ?? ""),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return Response.json({ error: "upstream request failed" }, { status: 502 });
  }
  if (response.status >= 300 && response.status < 400) return Response.json({ error: "redirects are not followed" }, { status: 502 });
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_BODY) return Response.json({ error: "response too large" }, { status: 502 });
  const text = Buffer.from(buffer).toString("utf8");
  const secretValues = [...usedSecrets].map((placeholder) => scope.secrets[placeholder]!.value);
  const responseHeaders: Record<string, string> = {};
  for (const [key, value] of response.headers.entries()) responseHeaders[key] = value;
  const redacted = redact({ status: response.status, headers: responseHeaders, body: text }, [...secretValues, ...currentCodes], [...usedSecrets, ...usedCodes]);
  return Response.json(redacted);
}

// ---- host CLI helpers ------------------------------------------------------

export function readBrokerState(configPath: string): BrokerState | undefined {
  const file = brokerStatePath(configPath);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as BrokerState;
    if (!parsed.pid || !parsed.socket || !parsed.token) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function control(configPath: string, body: unknown, timeoutMs = 1000): Promise<any> {
  const state = readBrokerState(configPath);
  if (!state) throw new Error("broker is not running");
  const response = await fetch("http://broker/control", {
    method: "POST",
    unix: state.socket,
    headers: { "content-type": "application/json", "x-broker-control": state.token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  } as RequestInit & { unix: string });
  return response.json();
}

/** Ensure the single host broker is running; returns its metadata. */
export async function ensureBroker(configPath: string): Promise<BrokerState> {
  const existing = readBrokerState(configPath);
  if (existing && pidAlive(existing.pid) && existsSync(existing.socket)) {
    try {
      await control(configPath, { op: "status" }, 800);
      return existing;
    } catch {}
  }
  rmSync(brokerStatePath(configPath), { force: true });
  rmSync(brokerSocketPath(configPath), { force: true });
  const dir = brokerDir(configPath);
  const brokerEnv: Record<string, string | undefined> = { PRIME_BROKER_DIR: dir };
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "PRIME_VAULT_KEY" || key === "PRIME_VAULT_KEY_FILE" || key === "PRIME_BROKER_DIR") continue;
    if (value !== undefined) brokerEnv[key] = value;
  }
  const child = Bun.spawn({
    cmd: [process.execPath, "__vault-broker"],
    env: brokerEnv,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  (child as any).unref?.();
  const deadline = Date.now() + 3000;
  for (;;) {
    const state = readBrokerState(configPath);
    if (state && pidAlive(state.pid)) return state;
    if (Date.now() > deadline) throw new Error("the vault broker did not start");
    await Bun.sleep(50);
  }
}

export async function registerBrokerScope(
  configPath: string,
  token: string,
  bind: string | undefined,
  port: number | undefined,
  scope: BrokerScope,
  unix?: string,
): Promise<void> {
  const result = await control(configPath, { op: "register", token, bind, port, scope, unix }, 3000);
  if (!result?.ok) throw new Error(result?.error ?? "broker registration failed");
}

export async function unregisterBrokerScope(configPath: string, token: string | undefined): Promise<void> {
  if (!token) return;
  try {
    await control(configPath, { op: "unregister", token }, 800);
  } catch {}
}

export async function brokerStatus(configPath: string): Promise<{ running: boolean; pid?: number; socket?: string; started_at?: string; scopes?: number; listeners?: unknown; requests?: number }> {
  const state = readBrokerState(configPath);
  if (!state || !pidAlive(state.pid)) return { running: false };
  try {
    const result = await control(configPath, { op: "status" }, 800);
    return { running: true, pid: state.pid, socket: state.socket, started_at: result.started_at, scopes: result.scopes, listeners: result.listeners, requests: result.requests };
  } catch {
    return { running: false, pid: state.pid, socket: state.socket };
  }
}
