// `mcp serve` - every tool of every known device, as ONE MCP server.
//
// Transports:
//   stdio (default)  newline-delimited JSON-RPC 2.0 on stdin/stdout - what
//                    Claude Code / Codex spawn: claude mcp add gateway -- mcp serve
//                    Nothing but JSON-RPC is ever written to stdout; notes go to stderr.
//   --port <n>       Streamable HTTP: POST /mcp (JSON responses), GET -> 405.
//
// Devices come from the same place as "mcp tools list"/"mcp call": the config
// file (or the ids given as arguments), each resolved with the usual
// flag > environment > device entry > defaults precedence. Tool names are
// namespaced "<device>__<tool>" (see namespaceTools) and calls are routed back
// through GatewayClient, returning the device's result verbatim.

import { bool, num, str } from "./args.ts";
import { GatewayClient } from "./client.ts";
import { type Ctx, overridesFrom, targetFor } from "./context.ts";
import { McpError, UsageError } from "./errors.ts";
import { pool } from "./pool.ts";
import { assertDeviceId } from "./target.ts";

/** MCP tool name rule shared by Claude and Codex. */
export const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_NAME = 64;
const SEPARATOR = "__";

/** Protocol revisions this server speaks (it uses nothing revision-specific). */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/** How long a tools/list snapshot is reused before devices are asked again. */
export const LIST_TTL_MS = 15_000;
/** Background re-list (stdio only) so devices that come online later appear. */
const REFRESH_INTERVAL_MS = 60_000;
/** Listing must stay snappy: an offline device answers 503 at once anyway. */
const LIST_TIMEOUT_MS = 10_000;

export interface DeviceTool {
  deviceId: string;
  tool: Record<string, unknown> & { name: string };
}

export interface ExposedTool {
  name: string;
  deviceId: string;
  toolName: string;
  definition: Record<string, unknown>;
}

/** Replace everything outside [a-zA-Z0-9_-] with "_" (dots included). */
export function sanitizeName(text: string): string {
  const cleaned = text.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned.length > 0 ? cleaned : "_";
}

function shortHash(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 6);
}

/**
 * Deterministic, collision-free tool names: "<device>__<tool>", sanitized.
 *
 * A name keeps its plain form unless it is too long or two (device, tool)
 * pairs sanitize to the same string; those get a hash suffix of their own
 * original (device, tool) pair, so the suffix does not depend on discovery
 * order - a device coming online later cannot rename another device's tools
 * (only a genuine collision with it can).
 */
export function namespaceTools(items: DeviceTool[]): ExposedTool[] {
  const bases = items.map((item) => `${sanitizeName(item.deviceId)}${SEPARATOR}${sanitizeName(item.tool.name)}`);
  const counts = new Map<string, number>();
  for (const base of bases) counts.set(base, (counts.get(base) ?? 0) + 1);

  const used = new Set<string>();
  const out: ExposedTool[] = [];
  items.forEach((item, index) => {
    const base = bases[index]!;
    let name = base;
    if (counts.get(base)! > 1 || base.length > MAX_NAME) {
      const suffix = `_${shortHash(`${item.deviceId}\u0000${item.tool.name}`)}`;
      name = base.slice(0, MAX_NAME - suffix.length) + suffix;
    }
    // Last resort (a hash collision, or an exact duplicate tool on one device).
    for (let n = 2; used.has(name); n++) {
      const suffix = `_${n}`;
      name = name.slice(0, MAX_NAME - suffix.length) + suffix;
    }
    used.add(name);
    const description = typeof item.tool.description === "string" ? item.tool.description : "";
    out.push({
      name,
      deviceId: item.deviceId,
      toolName: item.tool.name,
      definition: {
        ...item.tool,
        name,
        description: description ? `[${item.deviceId}] ${description}` : `[${item.deviceId}] ${item.tool.name}`,
        inputSchema:
          item.tool.inputSchema && typeof item.tool.inputSchema === "object" ? item.tool.inputSchema : { type: "object", properties: {} },
      },
    });
  });
  return out;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

type JsonRpcResponse = Record<string, unknown>;

const rpcResult = (id: unknown, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string, data?: unknown): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

export interface ServeOptions {
  deviceIds: string[];
  clientFor: (deviceId: string) => GatewayClient;
  version: string;
  note: (text: string) => void;
  listTtlMs?: number;
}

/** The transport-independent MCP server: tool aggregation and routing. */
export class AggregateServer {
  private readonly opts: ServeOptions;
  private readonly clients = new Map<string, GatewayClient>();
  private snapshot: { at: number; tools: ExposedTool[] } | undefined;
  private inflight: Promise<ExposedTool[]> | undefined;
  private readonly state = new Map<string, "online" | "offline">();
  /** Called when the exposed tool set changes (stdio sends list_changed). */
  onToolsChanged: (() => void) | undefined;

  constructor(opts: ServeOptions) {
    this.opts = opts;
  }

  private client(deviceId: string): GatewayClient {
    let client = this.clients.get(deviceId);
    if (!client) {
      client = this.opts.clientFor(deviceId);
      this.clients.set(deviceId, client);
    }
    return client;
  }

  /** Current tools, re-listing the devices when the snapshot is stale. */
  async tools(force = false): Promise<ExposedTool[]> {
    const ttl = this.opts.listTtlMs ?? LIST_TTL_MS;
    if (!force && this.snapshot && Date.now() - this.snapshot.at < ttl) return this.snapshot.tools;
    if (!this.inflight) {
      this.inflight = this.refresh().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private async listDevice(deviceId: string): Promise<DeviceTool[]> {
    const client = this.client(deviceId);
    const tools: DeviceTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const params = cursor ? { cursor } : {};
      const result = (await client.withHandshake(() => client.rpc("tools/list", params, { timeoutMs: LIST_TIMEOUT_MS }))) as
        | { tools?: unknown; nextCursor?: unknown }
        | undefined;
      for (const tool of Array.isArray(result?.tools) ? result!.tools : []) {
        if (tool && typeof tool === "object" && typeof (tool as { name?: unknown }).name === "string") {
          tools.push({ deviceId, tool: tool as DeviceTool["tool"] });
        }
      }
      cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  private async refresh(): Promise<ExposedTool[]> {
    const ids = [...this.opts.deviceIds].sort();
    const listed = await pool(ids, 8, async (deviceId) => {
      try {
        const tools = await this.listDevice(deviceId);
        if (this.state.get(deviceId) !== "online") this.opts.note(`mcp serve: ${deviceId} online (${tools.length} tools)`);
        this.state.set(deviceId, "online");
        return tools;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const previous = this.state.get(deviceId);
        if (previous === undefined) this.opts.note(`mcp serve: skipping ${deviceId}: ${message}`);
        else if (previous === "online") this.opts.note(`mcp serve: ${deviceId} went offline: ${message}`);
        this.state.set(deviceId, "offline");
        return [];
      }
    });
    const tools = namespaceTools(listed.flat());
    const before = this.snapshot?.tools.map((t) => t.name).join("\n");
    this.snapshot = { at: Date.now(), tools };
    if (before !== undefined && before !== tools.map((t) => t.name).join("\n")) this.onToolsChanged?.();
    return tools;
  }

  /** Handle one parsed JSON-RPC message; undefined = no response (notification). */
  async handle(message: unknown): Promise<JsonRpcResponse | undefined> {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return rpcError(null, -32600, "Invalid Request");
    }
    const req = message as JsonRpcRequest;
    const isNotification = !("id" in req) || req.id === undefined;
    if (typeof req.method !== "string") {
      // A response to a server->client request, or garbage: never answer it.
      if (isNotification || "result" in req || "error" in req) return undefined;
      return rpcError(req.id, -32600, "Invalid Request");
    }
    if (isNotification) return undefined; // notifications/initialized, cancelled, ...
    const id = req.id;
    const params = (req.params && typeof req.params === "object" ? req.params : {}) as Record<string, unknown>;

    switch (req.method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: this.onToolsChanged !== undefined } },
          serverInfo: { name: "code-mcp-gateway", title: "code-mcp-gateway devices", version: this.opts.version },
          instructions:
            "Tools of every device connected to code-mcp-gateway. Each tool name is <device>__<tool>; the description starts with [<device-id>].",
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list": {
        const tools = await this.tools();
        return rpcResult(id, { tools: tools.map((t) => t.definition) });
      }
      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        let target = (await this.tools()).find((t) => t.name === name);
        // The client may know a tool from an older listing that we have not
        // refreshed yet (or a device just came online): look once more.
        if (!target) target = (await this.tools(true)).find((t) => t.name === name);
        if (!target) return rpcError(id, -32602, `Unknown tool: ${name}`);
        try {
          const result = await this.client(target.deviceId).callTool(target.toolName, params.arguments ?? {});
          return rpcResult(id, result ?? { content: [] });
        } catch (err) {
          if (err instanceof McpError) return rpcError(id, err.code, err.message, err.data);
          // Transport failure (offline, timeout, auth): a tool-level error the
          // model can read and react to, rather than a protocol failure.
          const message = err instanceof Error ? err.message : String(err);
          return rpcResult(id, { content: [{ type: "text", text: `mcp serve: ${target.deviceId}: ${message}` }], isError: true });
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${req.method}`);
    }
  }

  /** Handle a raw JSON text (single message or batch); undefined = nothing to send. */
  async handleText(text: string): Promise<unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return rpcError(null, -32700, "Parse error");
    }
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return rpcError(null, -32600, "Invalid Request");
      const responses = (await Promise.all(parsed.map((m) => this.handle(m)))).filter((r) => r !== undefined);
      return responses.length > 0 ? responses : undefined;
    }
    return this.handle(parsed);
  }
}

// ---- transports --------------------------------------------------------------

async function serveStdio(server: AggregateServer, note: (t: string) => void): Promise<void> {
  const write = (value: unknown) => {
    // JSON.stringify without indentation never emits a raw newline.
    process.stdout.write(`${JSON.stringify(value)}\n`);
  };
  server.onToolsChanged = () => write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  const timer = setInterval(() => {
    server.tools(true).catch(() => {});
  }, REFRESH_INTERVAL_MS);
  timer.unref();

  const pending = new Set<Promise<void>>();
  const decoder = new TextDecoder();
  let buffer = "";
  const dispatch = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    // Requests run concurrently: a long tools/call must not block a ping.
    const job = server
      .handleText(trimmed)
      .then((response) => {
        if (response !== undefined) write(response);
      })
      .catch((err) => note(`mcp serve: internal error: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => pending.delete(job));
    pending.add(job);
  };
  // process.stdin, not Bun.stdin.stream(): the latter can leave a piped stdin
  // unread on Windows, and a server that exits at once is no server.
  for await (const chunk of process.stdin) {
    buffer += decoder.decode(typeof chunk === "string" ? new TextEncoder().encode(chunk) : (chunk as Uint8Array), { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      dispatch(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  }
  dispatch(buffer + decoder.decode());
  await Promise.all(pending);
  clearInterval(timer);
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase()) || /^127\./.test(host);
}

/** Origin allowed for a loopback server (DNS-rebinding protection, per the MCP spec). */
function originAllowed(origin: string | null): boolean {
  if (!origin) return true;
  try {
    return isLoopback(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function startHttp(server: AggregateServer, host: string, port: number): ReturnType<typeof Bun.serve> {
  const loopback = isLoopback(host);
  return Bun.serve({
    hostname: host,
    port,
    idleTimeout: 0, // tool calls may run for minutes
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/mcp") return Response.json({ error: "not found", hint: "POST JSON-RPC to /mcp" }, { status: 404 });
      if (loopback && !originAllowed(request.headers.get("origin"))) {
        return Response.json({ error: "forbidden origin" }, { status: 403 });
      }
      if (request.method !== "POST") {
        // No server-initiated stream (GET) and no sessions (DELETE).
        return new Response(null, { status: 405, headers: { allow: "POST" } });
      }
      const response = await server.handleText(await request.text());
      if (response === undefined) return new Response(null, { status: 202 });
      return Response.json(response);
    },
  });
}

export async function serveCommand(ctx: Ctx, version: string): Promise<void> {
  const positionals = ctx.parsed.positionals.slice(1);
  const deviceIds = positionals.length > 0 ? positionals.map(assertDeviceId) : Object.keys(ctx.config.devices).sort();
  const overrides = overridesFrom(ctx.parsed);
  const port = num(ctx.parsed, "port");
  const hostFlag = str(ctx.parsed, "host");
  const host = hostFlag ?? "127.0.0.1";
  if (hostFlag !== undefined && port === undefined) throw new UsageError("--host requires --port (stdio is the default transport)");
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new UsageError(`invalid --port ${port}`);
  if (!isLoopback(host) && !bool(ctx.parsed, "allow-remote")) {
    throw new UsageError(
      `refusing to listen on non-loopback address ${host}`,
      "mcp serve has no authentication and exposes every device's tools (shell included). Add --allow-remote if you really mean it.",
    );
  }

  // stdout belongs to the protocol in stdio mode: route stray logging away.
  const stdio = port === undefined;
  if (stdio) console.log = console.error;
  const note = (text: string) => ctx.note(text);

  // Resolve every target up front so a broken config fails loudly at start.
  const targets = new Map(deviceIds.map((id) => [id, targetFor(ctx, id, overrides)]));
  const server = new AggregateServer({
    deviceIds,
    clientFor: (id) => new GatewayClient(targets.get(id)!),
    version,
    note,
  });
  if (deviceIds.length === 0) {
    note("mcp serve: no devices configured - serving an empty tool list (add one with 'mcp connect' or 'mcp devices connect').");
  }

  if (stdio) {
    // Warm the tool list without delaying initialize.
    void server.tools().catch(() => {});
    await serveStdio(server, note);
    return;
  }

  const http = startHttp(server, host, port);
  const where = `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${http.port}/mcp`;
  if (!isLoopback(host)) {
    process.stderr.write(`WARNING: mcp serve is listening on ${host} WITHOUT authentication - anyone who can reach it can run every device's tools.\n`);
  }
  process.stderr.write(`mcp serve: listening on ${where} (${deviceIds.length} device${deviceIds.length === 1 ? "" : "s"}); Ctrl-C to stop\n`);
  void server.tools().catch(() => {});
  await new Promise<void>((resolve) => {
    const stop = () => {
      http.stop(true);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
