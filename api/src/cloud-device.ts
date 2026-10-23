// Cloud device - an in-process "virtual device" for the code-mcp gateway.
//
// Unlike tunnel devices (which answer MCP requests through a WebSocket that
// dials out to /ws/{deviceId}), a virtual device needs no tunnel: its tools
// execute right here in the gateway Worker against Cloudflare services.
// Agents reach it exactly like any other device: POST /mcp/{deviceId} (see
// index.ts), authenticated with the device token registered for it in the
// registry (VIRTUAL_DEVICE_TOKENS secret, merged by RegistryDO).
//
// The cloud device is a BACKEND, not an AI: it exposes storage / data / web /
// sandbox primitives that AI harnesses running on other devices (codex,
// code-mcp) connect to through the gateway and use to do work. No model runs
// here. Tool names follow the code-mcp convention (single lowercase words):
//   bash    - run a shell command in the dev container (real processes)
//   read    - read a file from the container filesystem
//   write   - write a file in the container filesystem
//   ls      - list a directory in the container filesystem
//   job     - background jobs: mode=start|status|stop
//   fetch   - fetch any URL server-side (no CORS, no local network limits)
//   search  - web search (DuckDuckGo HTML + Instant Answer, Wikipedia fallback)
//   kv      - Cloudflare KV: mode=get|set|list|delete
//   sql     - SQL against the code-mcp D1 database (SELECT/INSERT/...)
//   guide   - this overview, so agents know how to use the device
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
const SERVER_VERSION = "0.2.0";
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
    name: "bash",
    description:
      "Run a shell command inside the cloud device's dev container (bash -lc; node, bun, python, git, ripgrep " +
      "installed). Returns { pid, exitCode, stdout, stderr }. Use for builds, tests, git, scripts. " +
      "Filesystem is ephemeral: work in /workspace, persist durable data with kv/sql.",
    inputSchema: {
      type: "object",
      properties: {
        cmd: { type: "string", description: "shell command to run" },
        cwd: { type: "string", description: "working directory inside the container (default /workspace)" },
        stdin: { type: "string", description: "optional text to pipe to the process stdin" },
      },
      required: ["cmd"],
    },
  },
  {
    name: "read",
    description: "Read a file from the cloud device's container filesystem.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write",
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
    name: "ls",
    description: "List a directory in the cloud device's container filesystem (ls -la).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", default: "/workspace" } },
      required: ["path"],
    },
  },
  {
    name: "job",
    description:
      "Manage background jobs in the container. mode=start (cmd) returns a pid; mode=status (pid) reports " +
      "RUNNING/EXITED plus the last 50 log lines; mode=stop (pid) kills it. Output is captured to a job log.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["start", "status", "stop"] },
        cmd: { type: "string", description: "command to run (mode=start)" },
        pid: { type: "number", description: "job pid (mode=status|stop)" },
      },
      required: ["mode"],
    },
  },
  {
    name: "fetch",
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
    name: "search",
    description:
      "Web search from the Cloudflare edge (DuckDuckGo, Wikipedia fallback). Returns up to max results with " +
      "title, url, and snippet. No API key needed.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        max: { type: "number", default: 5, description: "max results (1-8)" },
      },
      required: ["query"],
    },
  },
  {
    name: "kv",
    description:
      "Cloudflare KV key-value store (durable across container restarts). mode=get (key), set (key+value, " +
      "optional ttlSeconds), list (optional prefix, limit), delete (key).",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["get", "set", "list", "delete"] },
        key: { type: "string" },
        value: { description: "value to store (mode=set); non-strings are JSON-encoded" },
        ttlSeconds: { type: "number" },
        prefix: { type: "string" },
        limit: { type: "number", default: 100 },
      },
      required: ["mode"],
    },
  },
  {
    name: "sql",
    description:
      "Run a SQL statement against the code-mcp D1 database (durable). Supports SELECT/INSERT/UPDATE/DELETE/DDL. " +
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
  {
    name: "guide",
    description:
      "How to use the cloud device: tool list, filesystem semantics (ephemeral /workspace, durable kv/sql), " +
      "and the clone-a-repo-and-work-on-it workflow.",
    inputSchema: { type: "object", properties: {} },
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
      case "bash":
        return await toolSandbox(env, "shellRun", args);
      case "read":
        return await toolSandbox(env, "fsRead", args);
      case "write":
        return await toolSandbox(env, "fsWrite", args);
      case "ls":
        return await toolSandbox(env, "fsList", args);
      case "job":
        return await toolJob(env, args);
      case "fetch":
        return await toolFetch(args);
      case "search":
        return await toolSearch(args);
      case "kv":
        return await toolKv(env, args);
      case "sql":
        return await toolSql(env, args);
      case "guide":
        return toolGuide();
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

// Map MCP tool -> RPC method + argument conversion.
async function toolSandbox(env: Env, method: keyof SandboxRpc, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sb = sandboxStub(env);
  let res: SandboxExecResult;
  switch (method) {
    case "shellRun":
      res = await sb.shellRun(String(args.cmd || ""), {
        cwd: typeof args.cwd === "string" && args.cwd ? args.cwd : "/workspace",
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
      res = await sb.fsList(String(args.path || "/workspace"));
      break;
    default:
      return text(`unknown sandbox method: ${String(method)}`, true);
  }
  return sandboxResult(res);
}

function sandboxResult(res: SandboxExecResult): Record<string, unknown> {
  if (res.exitCode !== 0 && res.stderr) {
    return text(JSON.stringify({ pid: res.pid, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr }, null, 2), true);
  }
  return { pid: res.pid, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
}

async function toolJob(env: Env, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sb = sandboxStub(env);
  const mode = String(args.mode || "");
  switch (mode) {
    case "start": {
      const res = await sb.jobStart(String(args.cmd || ""));
      return sandboxResult(res);
    }
    case "status": {
      const res = await sb.jobStatus(Number(args.pid));
      return sandboxResult(res);
    }
    case "stop": {
      const res = await sb.jobStop(Number(args.pid));
      return sandboxResult(res);
    }
    default:
      return text(`job mode must be start|status|stop (got '${mode}')`, true);
  }
}

// ---- tools ----------------------------------------------------------------

function need<T>(v: T | undefined, label: string): T {
  if (v === undefined) throw new Error(`${label} binding not configured on this gateway (check wrangler.toml)`);
  return v;
}

async function toolFetch(args: Record<string, unknown>): Promise<Record<string, unknown>> {
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

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// Parse DuckDuckGo's HTML result page.
function parseDdg(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const blocks = html.split(/<div class="result /);
  for (const b of blocks.slice(1)) {
    const a = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!a) continue;
    let url = a[1];
    if (url.startsWith("//")) url = "https:" + url;
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) {
      try {
        url = decodeURIComponent(uddg[1]);
      } catch {}
    }
    const sn = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    out.push({
      title: decodeEntities(stripTags(a[2])),
      url,
      snippet: sn ? decodeEntities(stripTags(sn[1])).slice(0, 300) : "",
    });
    if (out.length >= 8) break;
  }
  return out;
}

async function toolSearch(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = String(args.query || "").trim();
  if (!q) return text("query is required", true);
  const max = Math.min(Math.max(Number(args.max) || 5, 1), 8);

  // 1) DuckDuckGo HTML results (general web search, no key).
  try {
    const res = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), {
      headers: { "user-agent": "Mozilla/5.0 (compatible; code-mcp-cloud/1.0)" },
      redirect: "follow",
    });
    if (res.ok) {
      const results = parseDdg(await res.text()).slice(0, max);
      if (results.length > 0) return { query: q, engine: "duckduckgo", results };
    }
  } catch {}

  // 2) DuckDuckGo Instant Answer API (fallback).
  try {
    const res = await fetch(
      "https://api.duckduckgo.com/?q=" + encodeURIComponent(q) + "&format=json&no_html=1&skip_disambig=1",
      { headers: { "user-agent": "code-mcp-cloud/1.0" } },
    );
    const j = (await res.json()) as {
      AbstractText?: string;
      Answer?: string;
      AbstractURL?: string;
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
    };
    const topics = (j.RelatedTopics || []).slice(0, max).filter((t) => t.Text).map((t) => ({ title: t.Text, url: t.FirstURL, snippet: "" }));
    return { query: q, engine: "duckduckgo-instant", answer: j.Answer || "", abstract: j.AbstractText || "", abstractUrl: j.AbstractURL || "", results: topics };
  } catch {}

  // 3) Wikipedia search API (last resort, open + reliable).
  try {
    const res = await fetch(
      "https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=" +
        encodeURIComponent(q) +
        "&format=json&srlimit=" +
        max +
        "&origin=*",
      { headers: { "user-agent": "code-mcp-cloud/1.0" } },
    );
    const j = (await res.json()) as { query?: { search?: Array<{ title: string; snippet: string }> } };
    const results = (j.query?.search || []).map((r) => ({
      title: r.title,
      url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(r.title.replace(/ /g, "_")),
      snippet: decodeEntities(stripTags(r.snippet)),
    }));
    if (results.length > 0) return { query: q, engine: "wikipedia", results };
  } catch {}

  return text("search failed (all engines unreachable)", true);
}

async function toolKv(env: Env, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const kv = need(env.KV, "KV");
  const mode = String(args.mode || "");
  switch (mode) {
    case "get": {
      const key = String(args.key || "");
      if (!key) return text("key is required", true);
      return { key, value: (await kv.get(key)) ?? null };
    }
    case "set": {
      const key = String(args.key || "");
      if (!key) return text("key is required", true);
      const value = typeof args.value === "string" ? args.value : JSON.stringify(args.value);
      const ttl = typeof args.ttlSeconds === "number" && Number.isFinite(args.ttlSeconds) ? args.ttlSeconds : undefined;
      if (ttl !== undefined) await kv.put(key, value, { expirationTtl: ttl });
      else await kv.put(key, value);
      return { ok: true, key };
    }
    case "list": {
      const prefix = typeof args.prefix === "string" ? args.prefix : "";
      const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 1000);
      const res = await kv.list({ prefix, limit });
      return { keys: res.keys.map((k) => ({ name: k.name, expiration: k.expiration ?? null })) };
    }
    case "delete": {
      const key = String(args.key || "");
      if (!key) return text("key is required", true);
      await kv.delete(key);
      return { ok: true, deleted: key };
    }
    default:
      return text(`kv mode must be get|set|list|delete (got '${mode}')`, true);
  }
}

async function toolSql(env: Env, args: Record<string, unknown>): Promise<Record<string, unknown>> {
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

function toolGuide(): Record<string, unknown> {
  return {
    device: "cloud",
    description:
      "In-process backend device on the code-mcp gateway: storage, data, web, and a real coding sandbox (Cloudflare Containers). No AI model runs here - an AI harness on another device calls these tools through the gateway.",
    tools: "bash, read, write, ls, job, fetch, search, kv, sql",
    filesystem:
      "bash/read/write/ls operate inside the dev container (node, bun, python, git, bash, ripgrep). /workspace is the default workdir and the container has internet access (git clone, npm/pip install work). The filesystem is EPHEMERAL: it resets when the container instance sleeps or recycles (scale-to-zero). Use kv/sql for anything that must survive.",
    workflow: [
      'Clone a repo: bash(cmd="git clone <url>", cwd="/workspace")',
      'Work on it: bash(cmd="npm install && npm test", cwd="/workspace/<repo>")',
      "Long-running processes: job(mode=start, cmd=...) -> job(mode=status, pid=...) -> job(mode=stop, pid=...)",
      "Durable state: kv(mode=get|set|list|delete) and sql (D1 database)",
      "Web: fetch(url) for pages/APIs, search(query) for web search",
    ],
    cost:
      "The container scales to zero when idle; you are billed only for actively-running time (covered by the Workers Paid plan allotment). Deactivating the device stops all requests - no cost while deactivated.",
  };
}
