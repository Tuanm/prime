// Cloud device - an in-process "virtual device" for the code-mcp gateway.
//
// Unlike tunnel devices (which answer MCP requests through a WebSocket that
// dials out to /ws/{deviceId}), a virtual device needs no tunnel: its tools
// execute right here in the gateway Worker against Cloudflare services.
// Agents reach it exactly like any other device: POST /mcp/{deviceId} (see
// index.ts), authenticated with the device token registered for it in the
// registry (VIRTUAL_DEVICE_TOKENS secret, merged by RegistryDO).
//
// The cloud device is a BACKEND, not an AI: it exposes storage / data /
// web primitives that AI harnesses running on other devices (codex, code-mcp)
// connect to through the gateway and use to do work. No model runs here.
//
// Tool surface (v1, all GA / free tier):
//   web.fetch  - fetch any URL server-side (no CORS, no local network limits)
//   kv.get/set/list/delete - Cloudflare KV (lightweight shared key-value store)
//   d1.query   - SQL against the code-mcp D1 database (SELECT/INSERT/...)
//   r2.*       - (planned) object storage once R2 is enabled on the account
//
// Missing bindings degrade to a clear per-tool "not configured" error instead
// of crashing, so the gateway deploys even without them.

import type { Env } from "./config";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: unknown;
}

class McpError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const SERVER_NAME = "cloud-mcp";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2024-11-05"; // matches code-mcp.ts so clients handshake identically
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_TEXT_OUTPUT = 64 * 1024; // truncate tool text output

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: "web.fetch",
    description:
      "Fetch a URL from the Cloudflare edge and return status + body text (truncated to ~64KB). " +
      "Useful for reading docs/APIs from any agent session without local network or CORS constraints.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string", enum: ["GET", "POST"], default: "GET" },
        headers: { type: "object", description: "optional HTTP headers" },
        body: { type: "string", description: "request body for POST" },
      },
      required: ["url"],
    },
  },
  {
    name: "kv.get",
    description: "Read a value from the code-mcp Cloudflare KV namespace (cloud device workspace).",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "kv.set",
    description: "Write a value to the code-mcp Cloudflare KV namespace. Non-string values are JSON-encoded.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: { description: "string or JSON-serializable value" },
        ttlSeconds: { type: "number", description: "optional expiration, seconds from now" },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "kv.list",
    description: "List keys in the code-mcp Cloudflare KV namespace (optionally filtered by prefix).",
    inputSchema: {
      type: "object",
      properties: {
        prefix: { type: "string" },
        limit: { type: "number", default: 100 },
      },
    },
  },
  {
    name: "kv.delete",
    description: "Delete a key from the code-mcp Cloudflare KV namespace.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "d1.query",
    description:
      "Run a SQL statement against the code-mcp D1 database. Supports SELECT/INSERT/UPDATE/DELETE/DDL. " +
      "Use ? placeholders with the params array. Returns rows for SELECT, changes/meta for writes.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string" },
        params: { type: "array", items: {} },
      },
      required: ["sql"],
    },
  },
  // ---- coding sandbox (Cloudflare Containers) tools ----
  // These exec real processes in the cloud device's dev container
  // (node/bun/python/git/bash/ripgrep). Returns { pid, exitCode, stdout, stderr }.
  {
    name: "shell.run",
    description:
      "Run a shell command inside the cloud device's dev container (bash -lc). " +
      "Returns { pid, exitCode, stdout, stderr }. Use for builds, tests, scripts, anything a shell can do.",
    inputSchema: {
      type: "object",
      properties: {
        cmd: { type: "string", description: "shell command to run" },
        cwd: { type: "string", description: "working directory inside the container" },
        stdin: { type: "string", description: "optional text to pipe to the process stdin" },
      },
      required: ["cmd"],
    },
  },
  {
    name: "fs.read",
    description: "Read a file from the cloud device's container filesystem.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "fs.write",
    description: "Write (create/overwrite) a file in the cloud device's container filesystem.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "fs.list",
    description: "List a directory in the cloud device's container filesystem (ls -la).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", default: "/workspace" } },
      required: ["path"],
    },
  },
  {
    name: "jobs.start",
    description:
      "Start a background job in the container (nohup). Returns the pid; poll with jobs.status, " +
      "stop with jobs.stop. Output is captured to a job log.",
    inputSchema: {
      type: "object",
      properties: { cmd: { type: "string", description: "command to run in the background" } },
      required: ["cmd"],
    },
  },
  {
    name: "jobs.status",
    description: "Check a background job: RUNNING/EXITED plus the last 50 lines of its log.",
    inputSchema: {
      type: "object",
      properties: { pid: { type: "number" } },
      required: ["pid"],
    },
  },
  {
    name: "jobs.stop",
    description: "Kill a background job by pid.",
    inputSchema: {
      type: "object",
      properties: { pid: { type: "number" } },
      required: ["pid"],
    },
  },
];

function text(content: string, isError = false): Record<string, unknown> {
  return { content: [{ type: "text", text: content }], isError };
}

function truncate(s: string): string {
  return s.length > MAX_TEXT_OUTPUT ? s.slice(0, MAX_TEXT_OUTPUT) + `\n... [truncated ${s.length - MAX_TEXT_OUTPUT} chars]` : s;
}

function jsonRpc(id: number | string | null, body: Record<string, unknown>): Response {
  return Response.json({ jsonrpc: "2.0", id, ...body });
}

// Entry point: handle one JSON-RPC POST for a virtual device.
export async function handleCloudMcp(env: Env, request: Request): Promise<Response> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return jsonRpc(null, { error: { code: -32600, message: "request too large" } });
  }
  let msg: JsonRpcRequest;
  try {
    msg = JSON.parse(raw) as JsonRpcRequest;
  } catch {
    return jsonRpc(null, { error: { code: -32700, message: "parse error" } });
  }
  if (Array.isArray(msg)) {
    return jsonRpc(null, { error: { code: -32600, message: "batch requests not supported" } });
  }
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return jsonRpc(msg?.id ?? null, { error: { code: -32600, message: "invalid request" } });
  }

  // Notifications (no id) are acknowledged 204 like the tunnel relay path.
  if (msg.id === null || msg.id === undefined) {
    void dispatch(env, msg.method, msg.params).catch(() => {});
    return new Response(null, { status: 204 });
  }

  try {
    const result = await dispatch(env, msg.method, msg.params);
    return jsonRpc(msg.id, { result });
  } catch (err) {
    const code = err instanceof McpError ? err.code : -32603;
    const message = err instanceof Error ? err.message : String(err);
    return jsonRpc(msg.id, { error: { code, message } });
  }
}

async function dispatch(env: Env, method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const p = (params || {}) as { name?: unknown; arguments?: Record<string, unknown> };
      const name = String(p.name || "");
      const args = (p.arguments || {}) as Record<string, unknown>;
      const result = await runTool(env, name, args);
      // MCP tools/call results must carry a content array; error results
      // (isError) from text() already do.
      if (Array.isArray((result as { content?: unknown }).content)) return result;
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    default:
      throw new McpError(-32601, `method not found: ${method}`);
  }
}

async function runTool(env: Env, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    switch (name) {
      case "web.fetch":
        return await toolWebFetch(args);
      case "kv.get":
        return await toolKvGet(env, args);
      case "kv.set":
        return await toolKvSet(env, args);
      case "kv.list":
        return await toolKvList(env, args);
      case "kv.delete":
        return await toolKvDelete(env, args);
      case "d1.query":
        return await toolD1(env, args);
      case "shell.run":
        return await toolSandbox(env, "shellRun", args);
      case "fs.read":
        return await toolSandbox(env, "fsRead", args);
      case "fs.write":
        return await toolSandbox(env, "fsWrite", args);
      case "fs.list":
        return await toolSandbox(env, "fsList", args);
      case "jobs.start":
        return await toolSandbox(env, "jobStart", args);
      case "jobs.status":
        return await toolSandbox(env, "jobStatus", args);
      case "jobs.stop":
        return await toolSandbox(env, "jobStop", args);
      default:
        return text(`unknown tool: ${name}`, true);
    }
  } catch (err) {
    return text(`tool error: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

// ---- coding sandbox RPC -----------------------------------------------------

interface SandboxExecResult {
  pid: number;
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface SandboxRpc {
  shellRun(cmd: string, opts?: { stdin?: string; cwd?: string }): Promise<SandboxExecResult>;
  fsRead(path: string): Promise<SandboxExecResult>;
  fsWrite(path: string, content: string): Promise<SandboxExecResult>;
  fsList(path: string): Promise<SandboxExecResult>;
  jobStart(cmd: string): Promise<SandboxExecResult>;
  jobStatus(pid: number): Promise<SandboxExecResult>;
  jobStop(pid: number): Promise<SandboxExecResult>;
}

function sandboxStub(env: Env): SandboxRpc {
  const ns = need(env.CODING_SANDBOX, "CODING_SANDBOX");
  return ns.get(ns.idFromName("default")) as unknown as SandboxRpc;
}

// Map MCP tool name -> RPC method + argument conversion.
async function toolSandbox(env: Env, method: keyof SandboxRpc, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sb = sandboxStub(env);
  let res: SandboxExecResult;
  switch (method) {
    case "shellRun":
      res = await sb.shellRun(String(args.cmd || ""), {
        cwd: typeof args.cwd === "string" && args.cwd ? args.cwd : undefined,
        stdin: typeof args.stdin === "string" ? args.stdin : undefined,
      });
      break;
    case "fsRead":
      res = await sb.fsRead(String(args.path || ""));
      break;
    case "fsWrite":
      res = await sb.fsWrite(String(args.path || ""), String(args.content ?? ""));
      break;
    case "fsList":
      res = await sb.fsList(String(args.path || "/"));
      break;
    case "jobStart":
      res = await sb.jobStart(String(args.cmd || ""));
      break;
    case "jobStatus":
      res = await sb.jobStatus(Number(args.pid));
      break;
    case "jobStop":
      res = await sb.jobStop(Number(args.pid));
      break;
    default:
      return text(`unknown sandbox method: ${String(method)}`, true);
  }
  if (res.exitCode !== 0 && res.stderr) {
    return text(
      JSON.stringify({ pid: res.pid, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr }, null, 2),
      true,
    );
  }
  return { pid: res.pid, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
}

// ---- tools ----------------------------------------------------------------

async function toolWebFetch(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = String(args.url || "");
  if (!/^https?:\/\//i.test(url)) return text("url must start with http:// or https://", true);
  const method = String(args.method || "GET").toUpperCase();
  const headers: Record<string, string> = {};
  if (args.headers && typeof args.headers === "object") {
    for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) {
      if (typeof v === "string") headers[k] = v;
    }
  }
  const init: RequestInit = { method, headers, redirect: "follow" };
  if (method === "POST" && typeof args.body === "string") init.body = args.body;
  const res = await fetch(url, init);
  const bodyText = truncate(await res.text());
  return {
    status: res.status,
    statusText: res.statusText,
    contentType: res.headers.get("content-type") || "",
    finalUrl: res.url,
    body: bodyText,
  };
}

function need<T>(v: T | undefined, label: string): T {
  if (v === undefined) throw new Error(`${label} binding not configured on this gateway (check wrangler.toml)`);
  return v;
}

async function toolKvGet(env: Env, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const kv = need(env.KV, "KV");
  const key = String(args.key || "");
  if (!key) return text("key is required", true);
  const value = await kv.get(key);
  return { key, value: value ?? null };
}

async function toolKvSet(env: Env, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const kv = need(env.KV, "KV");
  const key = String(args.key || "");
  if (!key) return text("key is required", true);
  const value = typeof args.value === "string" ? args.value : JSON.stringify(args.value);
  const ttl = typeof args.ttlSeconds === "number" && Number.isFinite(args.ttlSeconds) ? args.ttlSeconds : undefined;
  if (ttl !== undefined) await kv.put(key, value, { expirationTtl: ttl });
  else await kv.put(key, value);
  return { ok: true, key };
}

async function toolKvList(env: Env, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const kv = need(env.KV, "KV");
  const prefix = typeof args.prefix === "string" ? args.prefix : "";
  const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 1000);
  const res = await kv.list({ prefix, limit });
  return { keys: res.keys.map((k) => ({ name: k.name, expiration: k.expiration ?? null })) };
}

async function toolKvDelete(env: Env, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const kv = need(env.KV, "KV");
  const key = String(args.key || "");
  if (!key) return text("key is required", true);
  await kv.delete(key);
  return { ok: true, deleted: key };
}

async function toolD1(env: Env, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const db = need(env.DB, "DB");
  const sql = String(args.sql || "").trim();
  if (!sql) return text("sql is required", true);
  const params = Array.isArray(args.params) ? args.params : [];
  const stmt = db.prepare(sql);
  const res = params.length > 0 ? await stmt.bind(...params).all() : await stmt.all();
  const meta = (res as { meta?: Record<string, unknown> }).meta;
  const out: Record<string, unknown> = { success: res.success, results: res.results };
  if (meta) out.meta = { rows_read: meta.rows_read, rows_written: meta.rows_written, changes: meta.changes };
  return out;
}


