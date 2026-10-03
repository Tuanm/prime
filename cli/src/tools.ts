// `mcp tools ...` - list, view and call device tools.

import { bool, str } from "./args.ts";
import { type HandshakeMode, GatewayClient } from "./client.ts";
import { type Ctx, overridesFrom, targetFor } from "./context.ts";
import { EXIT, McpError, UsageError } from "./errors.ts";
import { splitLabel } from "./labels.ts";
import { bold, cyan, dim, isErrorResult, printJson, red, renderToolResult, table, truncate } from "./output.ts";
import type { Target } from "./target.ts";

interface CallRequest {
  id: number | string;
  name: string;
  arguments: unknown;
}

interface CallOutcome {
  id: number | string;
  name: string;
  ok: boolean;
  /** The RPC succeeded but the tool reported failure (`isError: true`). */
  isError?: boolean;
  result?: unknown;
  error?: { message: string; code?: number };
}

function handshakeMode(ctx: Ctx): HandshakeMode {
  const raw = str(ctx.parsed, "handshake");
  if (raw === undefined) return "auto";
  if (raw === "auto" || raw === "always" || raw === "never") return raw;
  throw new UsageError(`invalid --handshake "${raw}"`, "Expected one of: auto, always, never.");
}

/** Suggestion list for a mistyped tool name (cheap prefix/substring/edit match). */
function suggest(name: string, options: string[], limit = 3): string[] {
  const lower = name.toLowerCase();
  const scored = options
    .map((option) => {
      const candidate = option.toLowerCase();
      let score = -1;
      if (candidate === lower) score = 100;
      else if (candidate.startsWith(lower) || lower.startsWith(candidate)) score = 80;
      else if (candidate.includes(lower) || lower.includes(candidate)) score = 60;
      else {
        const distance = editDistance(lower, candidate, 4);
        if (distance <= 3) score = 40 - distance;
      }
      return { option, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((entry) => entry.option);
}

function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

export async function toolsList(ctx: Ctx): Promise<void> {
  const positionals = ctx.parsed.positionals.slice(2);
  if (positionals.length === 0) throw new UsageError("missing <device-id>", "Usage: mcp tools list <device-id>");
  if (positionals.length > 1) throw new UsageError(`unexpected argument "${positionals[1]}"`);
  const deviceId = positionals[0]!;
  const target = targetFor(ctx, deviceId, overridesFrom(ctx.parsed));
  const client = new GatewayClient(target);
  const tools = await client.listTools({ handshake: handshakeMode(ctx) });

  if (ctx.json) {
    printJson({ device: deviceId, gateway: target.gateway, count: tools.length, tools });
    return;
  }
  if (tools.length === 0) {
    ctx.out(dim(`${deviceId} exposes no tools`));
    return;
  }
  ctx.out(table(["TOOL", "DESCRIPTION"], tools.map((t) => [bold(t.name), dim(truncate(t.description ?? "", 74))])));
  ctx.note(dim(`${tools.length} tools on ${deviceId} ${ctx.verbose ? `(${client.lastRoundTripMs} ms)` : ""}`));
}

export async function toolsView(ctx: Ctx): Promise<void> {
  const positionals = ctx.parsed.positionals.slice(2);
  if (positionals.length === 0) {
    throw new UsageError("missing <device-id>.<tool-id>", "Usage: mcp tools view <device-id>.<tool-id>");
  }
  const { deviceId, toolName } = resolveLabel(ctx, positionals[0]!);
  const target = targetFor(ctx, deviceId, overridesFrom(ctx.parsed));
  const client = new GatewayClient(target);
  const tools = await client.listTools({ handshake: handshakeMode(ctx) });
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) {
    const near = suggest(toolName, tools.map((t) => t.name));
    throw new UsageError(
      `${deviceId} has no tool named "${toolName}"`,
      near.length > 0 ? `Did you mean: ${near.join(", ")}?` : `Run 'mcp tools list ${deviceId}' to see all ${tools.length} tools.`,
    );
  }

  const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);

  if (ctx.json) {
    printJson({ device: deviceId, gateway: target.gateway, tool });
    return;
  }

  ctx.out(bold(tool.name) + dim(`  (${deviceId})`));
  if (tool.description) ctx.out(tool.description.trim());
  ctx.out("");
  const params = Object.keys(properties);
  if (params.length === 0) {
    ctx.out(dim("No arguments."));
  } else {
    ctx.out(bold("ARGUMENTS"));
    const rows = params.map((name) => {
      const prop = properties[name] as { type?: unknown; description?: unknown; enum?: unknown[] } | undefined;
      const type = Array.isArray(prop?.enum)
        ? prop.enum.map((v) => JSON.stringify(v)).join("|")
        : typeof prop?.type === "string"
          ? prop.type
          : "any";
      return [
        `${required.has(name) ? cyan(name) : name}`,
        dim(type),
        dim(truncate(typeof prop?.description === "string" ? prop.description : "", 60)),
      ];
    });
    ctx.out(table(["NAME", "TYPE", "DESCRIPTION"], rows));
    ctx.out("");
    ctx.out(dim(`required: ${required.size > 0 ? [...required].join(", ") : "none"}`));
  }

  const skeleton = Object.fromEntries([...required].map((name) => [name, placeholderFor(properties[name])]));
  ctx.out("");
  ctx.out(dim("EXAMPLE"));
  ctx.out(`  mcp tools call ${deviceId}.${tool.name} '${JSON.stringify(skeleton)}'`);
}

function placeholderFor(prop: unknown): unknown {
  const type = prop && typeof prop === "object" ? (prop as { type?: unknown }).type : undefined;
  if (type === "number" || type === "integer") return 0;
  if (type === "boolean") return false;
  if (type === "array") return [];
  if (type === "object") return {};
  return "";
}

/** Resolve <device>.<tool>, honouring explicit --device/--tool overrides. */
function resolveLabel(ctx: Ctx, label: string): { deviceId: string; toolName: string } {
  const known = Object.keys(ctx.config.devices);
  const forcedDevice = str(ctx.parsed, "device");
  const forcedTool = str(ctx.parsed, "tool");
  if (forcedDevice && forcedTool) return { deviceId: forcedDevice, toolName: forcedTool };
  const resolved = splitLabel(label, known);
  return {
    deviceId: forcedDevice ?? resolved.deviceId,
    toolName: forcedTool ?? resolved.toolName,
  };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  try {
    return await Bun.stdin.text();
  } catch {
    return "";
  }
}

/** Parse the stdin document: a single call object or an array of them. */
function parseStdinCalls(text: string, source: string): CallRequest[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new UsageError(`stdin is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, source);
  }
  const toCall = (value: unknown, index: number): CallRequest => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new UsageError("each call must be a JSON object with \"name\" and \"arguments\"");
    }
    const obj = value as { id?: unknown; name?: unknown; arguments?: unknown };
    if (typeof obj.name !== "string" || obj.name.length === 0) {
      throw new UsageError("each call requires a string \"name\" field (\"<device-id>.<tool-id>\")");
    }
    const id = typeof obj.id === "string" || typeof obj.id === "number" ? obj.id : index + 1;
    return { id, name: obj.name, arguments: obj.arguments ?? {} };
  };
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) throw new UsageError("stdin contained an empty array of calls");
    return parsed.map(toCall);
  }
  return [toCall(parsed, 0)];
}

/** Parse the positional form: one label (args optional) or label/args pairs. */
function parsePositionalCalls(rest: string[]): { label: string; args: unknown }[] {
  if (rest.length === 1) return [{ label: rest[0]!, args: {} }];
  if (rest.length % 2 !== 0) {
    throw new UsageError(
      `expected <device>.<tool> <json> pairs, got ${rest.length} arguments`,
      "Pass one label with its JSON arguments, or several label/JSON pairs. Use '--' before JSON that starts with '-'.",
    );
  }
  const calls: { label: string; args: unknown }[] = [];
  for (let i = 0; i < rest.length; i += 2) {
    const label = rest[i]!;
    const raw = rest[i + 1]!;
    let args: unknown;
    try {
      args = JSON.parse(raw);
    } catch (err) {
      throw new UsageError(
        `arguments for ${label} are not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        `Received: ${truncate(raw, 80)}`,
      );
    }
    calls.push({ label, args });
  }
  return calls;
}

export async function toolsCall(ctx: Ctx): Promise<void> {
  const rest = ctx.parsed.positionals.slice(2);
  const wantJson = ctx.json;
  const timeoutMs = overridesFrom(ctx.parsed).timeoutMs;
  const mode = handshakeMode(ctx);

  let requests: CallRequest[];
  if (rest.length > 0) {
    requests = parsePositionalCalls(rest).map((call, index) => {
      const { deviceId, toolName } = resolveLabel(ctx, call.label);
      return { id: index + 1, name: `${deviceId}.${toolName}`, arguments: call.args };
    });
  } else {
    const text = (await readStdin()).trim();
    if (text.length === 0) {
      throw new UsageError(
        "no tool calls given",
        "Usage: mcp tools call <device-id>.<tool-id> '<json>'  |  cat calls.json | mcp tools call",
      );
    }
    requests = parseStdinCalls(text, "stdin");
  }

  // One client per device, reused across calls so a batch pays connection setup
  // once per device rather than once per call.
  const clients = new Map<string, GatewayClient>();
  const plan = requests.map((request) => {
    const { deviceId, toolName } = resolveLabel(ctx, request.name);
    let client = clients.get(deviceId);
    if (!client) {
      const target: Target = targetFor(ctx, deviceId, overridesFrom(ctx.parsed));
      client = new GatewayClient(target);
      clients.set(deviceId, client);
    }
    return { request, deviceId, toolName, client };
  });

  // A single call propagates its error untouched, so the exit code keeps the
  // failure class (3 auth, 4 offline, 5 timeout) and the hint reaches the user.
  // A batch aggregates instead: one bad call must not hide the others' output.
  const single = plan.length === 1;
  const run = async (item: (typeof plan)[number]): Promise<CallOutcome> => {
    try {
      const result = await item.client.callTool(item.toolName, item.request.arguments, { handshake: mode, timeoutMs });
      return {
        id: item.request.id,
        name: `${item.deviceId}.${item.toolName}`,
        ok: true,
        isError: isErrorResult(result),
        result,
      };
    } catch (err) {
      if (single) throw err;
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof McpError ? err.code : undefined;
      return { id: item.request.id, name: `${item.deviceId}.${item.toolName}`, ok: false, error: { message, ...(code !== undefined ? { code } : {}) } };
    }
  };

  const parallel = bool(ctx.parsed, "parallel");
  const outcomes: CallOutcome[] = parallel ? await Promise.all(plan.map(run)) : await sequential(plan, run);

  if (wantJson) {
    if (outcomes.length === 1) {
      const only = outcomes[0]!;
      printJson(only.ok ? only.result : { error: only.error });
    } else {
      printJson(outcomes.map((o) => ({ id: o.id, name: o.name, ok: o.ok, ...(o.isError ? { is_error: true } : {}), ...(o.ok ? { result: o.result } : { error: o.error }) })));
    }
  } else {
    const multi = outcomes.length > 1;
    outcomes.forEach((outcome, index) => {
      if (multi) {
        if (index > 0) ctx.out("");
        const marker = !outcome.ok ? red(" (failed)") : outcome.isError ? red(" (isError)") : "";
        ctx.out(dim(`--- [${outcome.id}] ${outcome.name}`) + marker);
      }
      if (outcome.ok) {
        const rendered = renderToolResult(outcome.result);
        if (rendered.text.length > 0) ctx.out(rendered.text);
        else if (!multi) ctx.note(dim("(the tool returned no content)"));
      } else {
        ctx.out(red(`✗ ${outcome.error?.message ?? "call failed"}`));
      }
    });
  }

  if (outcomes.some((outcome) => !outcome.ok || outcome.isError)) process.exitCode = EXIT.ERROR;
}

async function sequential<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (const item of items) results.push(await run(item));
  return results;
}
