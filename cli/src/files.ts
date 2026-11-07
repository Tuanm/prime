// "prime files ..." - list, upload and download the gateway's temporary files.
//
// The files API is plain REST (api/src/files-routes.ts): HTTP Basic with the
// (device id, token) pair of a registered device, raw request bodies, R2 behind
// it. This file stays a thin client: no protocol of its own.
//
// Where the credentials come from, highest priority first:
//   1. --device / --token / --gateway flags
//   2. the "code-mcp:" section of the config file (id, gateway-token/token,
//      gateway) - the same device "prime service install" runs
//   3. a device entry in the config file (or its defaults section)
//   4. PRIME_DEVICE_TOKEN / PRIME_GATEWAY_URL
//
// Large files: uploads stream the file (never buffered); downloads stream
// response chunks straight to disk, with an optional --resume that continues an
// interrupted transfer with a Range request.

import { existsSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, join } from "node:path";

import { bool, num, str, type ParsedArgs } from "./args.ts";
import type { Config } from "./config.ts";
import type { Ctx } from "./context.ts";
import { AuthError, CliError, UsageError } from "./errors.ts";
import { bold, dim, green, printJson, table, yellow } from "./output.ts";
import { DEFAULT_GATEWAY, ENV, assertDeviceId, normalizeGateway } from "./target.ts";

const FILE_ID_RE = /^[a-f0-9]{32}$/;
const DEFAULT_TIMEOUT_MS = 300_000;
const PROGRESS_INTERVAL_MS = 150;

export interface FilesTarget {
  /** http(s) origin, no trailing slash. */
  gateway: string;
  device: string;
  token: string;
  timeoutMs: number;
}

export interface FilesTargetFlags {
  device?: string;
  gateway?: string;
  token?: string;
  timeout?: number;
}

/** The subset of the file record the CLI renders. */
export interface FileView {
  id: string;
  name: string;
  size: number;
  content_type: string;
  created_at: string;
  expires_at: string;
  expires_in_ms: number;
  status: string;
  protected: boolean;
  key?: string;
  download_url: string;
  page_url: string;
}

export interface FilesListResponse {
  files?: FileView[];
  usage?: { count: number; bytes: number };
  limits?: { max_upload_bytes: number; max_expiry_ms: number; max_files: number; max_total_bytes: number };
  budget?: unknown;
}

/**
 * Decide which gateway/device/token a `prime files` command talks to.
 *
 * Kept pure (config + flags in, target out) so the precedence is unit-tested
 * without a config file on disk.
 */
export function resolveFilesTarget(
  config: Config,
  flags: FilesTargetFlags,
  configPath: string,
  env: Record<string, string | undefined> = process.env,
): FilesTarget {
  const codeMcp = config.codeMcp ?? {};
  const fromCodeMcp = (name: string): string | undefined => (typeof codeMcp[name] === "string" ? (codeMcp[name] as string) : undefined);

  const device = flags.device ?? fromCodeMcp("id") ?? Object.keys(config.devices)[0];
  if (!device) {
    throw new UsageError(
      "no device configured for file storage",
      "Add one with 'prime devices connect <device-id> --token <token>', or pass --device <id> --token <token>. The code-mcp section of " + configPath + " (id, token) works too.",
    );
  }
  assertDeviceId(device);

  const entry = config.devices[device];
  const gatewayRaw =
    flags.gateway ??
    (flags.device !== undefined ? entry?.gateway : undefined) ??
    fromCodeMcp("gateway") ??
    entry?.gateway ??
    config.defaults.gateway ??
    env[ENV.gateway] ??
    DEFAULT_GATEWAY;

  // The code-mcp section spells the device credential "gateway-token"; its
  // plain "token" is code-mcp's local HTTP token, which doubles as the device
  // credential when no gateway-token is set. Keep that order.
  const token =
    flags.token ??
    (flags.device !== undefined ? entry?.token : undefined) ??
    fromCodeMcp("gateway-token") ??
    fromCodeMcp("token") ??
    entry?.token ??
    config.defaults.token ??
    env[ENV.deviceToken];
  if (!token) {
    throw new UsageError(
      "no token for device " + device,
      "Store it with 'prime devices connect " + device + " --token <token>', pass --token, or set PRIME_DEVICE_TOKEN.",
    );
  }

  const timeoutMs = flags.timeout !== undefined && flags.timeout > 0 ? flags.timeout : DEFAULT_TIMEOUT_MS;
  return { gateway: normalizeGateway(gatewayRaw), device, token, timeoutMs };
}

function targetFromCtx(ctx: Ctx): FilesTarget {
  return resolveFilesTarget(
    ctx.config,
    { device: str(ctx.parsed, "device"), gateway: str(ctx.parsed, "gateway"), token: str(ctx.parsed, "token"), timeout: num(ctx.parsed, "timeout") },
    ctx.configPath,
  );
}

// ---- HTTP ---------------------------------------------------------------

function encodeBase64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function basicAuth(device: string, token: string): string {
  return "Basic " + encodeBase64(new TextEncoder().encode(device + ":" + token));
}

/** Turn a files API error response into a CLI error with its hint. */
async function apiError(response: Response): Promise<Error> {
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {}
  const error = typeof body.error === "string" ? body.error : "HTTP " + response.status;
  const extras: string[] = [];
  if (typeof body.limit_bytes === "number") extras.push("limit " + formatBytes(body.limit_bytes));
  if (typeof body.size === "number") extras.push("size " + formatBytes(body.size));
  const message = "files API: " + error + (extras.length > 0 ? " (" + extras.join(", ") + ")" : "");
  const hint = typeof body.hint === "string" ? body.hint : undefined;
  if (response.status === 401 || response.status === 403) {
    return new AuthError(message, hint ?? "The files API needs a registered device id and token; anonymous devices cannot store files. Check --device/--token.");
  }
  return new CliError(message, hint);
}

async function apiFetch(target: FilesTarget, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", basicAuth(target.device, target.token));
  headers.set("user-agent", "prime-cli");
  const response = await fetch(target.gateway + path, { ...init, headers, signal: AbortSignal.timeout(target.timeoutMs) });
  if (!response.ok) throw await apiError(response);
  return response;
}

// ---- progress -----------------------------------------------------------

function progressEnabled(ctx: Ctx, writingStdout: boolean): boolean {
  return Boolean(process.stderr.isTTY) && !ctx.quiet && !ctx.json && !writingStdout;
}

class Progress {
  private readonly started = performance.now();
  private drawnAt = 0;
  constructor(
    private readonly label: string,
    private readonly total: number,
    private readonly enabled: boolean,
  ) {}

  update(done: number, force = false): void {
    if (!this.enabled) return;
    const now = performance.now();
    if (!force && now - this.drawnAt < PROGRESS_INTERVAL_MS) return;
    this.drawnAt = now;
    const seconds = Math.max((now - this.started) / 1000, 0.001);
    const rate = done / seconds;
    const percent = this.total > 0 ? Math.min(100, Math.floor((done / this.total) * 100)) : 100;
    process.stderr.write(
      "\r  " + this.label + "  " + formatBytes(done) + " / " + formatBytes(this.total) + "  " + percent + "%  " + formatBytes(rate) + "/s\x1b[K",
    );
  }

  finish(): void {
    if (this.enabled) process.stderr.write("\r\x1b[K");
  }
}

/** Wrap a byte stream so each chunk advances the upload progress. */
function countingStream(source: ReadableStream<Uint8Array>, onProgress: (sent: number) => void): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      sent += value.byteLength;
      onProgress(sent);
      controller.enqueue(value);
    },
    cancel(reason) {
      void reader.cancel(reason);
    },
  });
}

// ---- formatting (pure, unit tested) -------------------------------------

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return bytes + " B";
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return value.toFixed(1) + " " + units[index];
}

const pad2 = (value: number) => String(value).padStart(2, "0");

/** ISO timestamp -> "2026-11-07 20:38" in local time. */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return (
    date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate()) + " " + pad2(date.getHours()) + ":" + pad2(date.getMinutes())
  );
}

/** ISO expiry -> "in 6d" / "in 3h" / "expired". */
export function formatExpiry(iso: string, now: number = Date.now()): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso;
  const delta = time - now;
  if (delta <= 0) return "expired";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return "in " + Math.max(1, minutes) + "m";
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return "in " + hours + "h";
  const days = Math.floor(hours / 24);
  if (days < 60) return "in " + days + "d";
  return "in " + Math.floor(days / 30) + "mo";
}

/** filename / filename*=UTF-8''... out of a Content-Disposition header. */
export function parseContentDispositionName(header: string | null): string | undefined {
  if (!header) return undefined;
  const extended = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (extended) {
    try {
      return decodeURIComponent(extended[1]!.trim());
    } catch {}
  }
  const quoted = /filename\s*=\s*"([^"]*)"/i.exec(header);
  if (quoted) return quoted[1];
  const plain = /filename\s*=\s*([^;]+)/i.exec(header);
  return plain ? plain[1]!.trim() : undefined;
}

/** --expires-in / --expiry-days as the API's query parameters. */
export function expiryParams(parsed: ParsedArgs): URLSearchParams {
  const seconds = num(parsed, "expires-in");
  const days = num(parsed, "expiry-days");
  if (seconds !== undefined && days !== undefined) throw new UsageError("pass only one of --expires-in and --expiry-days");
  const params = new URLSearchParams();
  if (seconds !== undefined) {
    if (!Number.isFinite(seconds) || seconds <= 0) throw new UsageError("--expires-in must be a positive number of seconds");
    params.set("expires_in", String(seconds));
  }
  if (days !== undefined) {
    if (!Number.isFinite(days) || days <= 0) throw new UsageError("--expiry-days must be a positive number");
    params.set("expiry_days", String(days));
  }
  return params;
}

// ---- list ---------------------------------------------------------------

export async function filesList(ctx: Ctx): Promise<void> {
  const target = targetFromCtx(ctx);
  const response = await apiFetch(target, "/api/files");
  const data = (await response.json()) as FilesListResponse;
  const files = data.files ?? [];
  const showKeys = bool(ctx.parsed, "show-keys");

  if (ctx.json) {
    printJson({
      config_path: ctx.configPath,
      gateway: target.gateway,
      device: target.device,
      files,
      usage: data.usage ?? null,
      limits: data.limits ?? null,
      budget: data.budget ?? null,
    });
    return;
  }

  if (files.length === 0) {
    ctx.out(dim("No uploaded files for " + target.device + " (" + target.gateway + ")."));
    ctx.out(dim("Upload one with: prime files upload <path>"));
    return;
  }

  const rows = files.map((file) => [
    bold(file.name),
    file.id,
    formatBytes(file.size),
    file.content_type,
    formatTimestamp(file.created_at),
    formatExpiry(file.expires_at),
    file.protected ? (showKeys && file.key ? "key " + file.key : "yes") : dim("no"),
  ]);
  ctx.out(table(["NAME", "ID", "SIZE", "TYPE", "CREATED", "EXPIRES", "LOCKED"], rows));

  const summary = [files.length + " file" + (files.length === 1 ? "" : "s")];
  if (data.usage) summary.push(formatBytes(data.usage.bytes) + " used");
  if (data.limits) summary.push(formatBytes(data.limits.max_upload_bytes) + " per file", data.limits.max_files + " files max");
  ctx.note(dim(summary.join(" - ")));
  if (!showKeys && files.some((file) => file.protected)) ctx.note(dim("Protected files show 'yes'; --show-keys prints the key (owner only)."));
}

// ---- upload -------------------------------------------------------------

export async function filesUpload(ctx: Ctx): Promise<void> {
  const args = ctx.parsed.positionals.slice(2);
  if (args.length === 0) throw new UsageError("missing <path>", "Usage: prime files upload <path> [--name <name>] [options]");
  if (args.length > 1) throw new UsageError('unexpected argument "' + args[1] + '"', "Usage: prime files upload <path> [options]");
  const filePath = args[0]!;
  if (!existsSync(filePath)) throw new CliError("no such file: " + filePath);
  const stat = statSync(filePath);
  if (!stat.isFile()) throw new CliError("not a regular file: " + filePath);
  if (stat.size === 0) throw new CliError("cannot upload an empty file", "The files API rejects an empty body; write at least one byte.");

  const target = targetFromCtx(ctx);
  const name = str(ctx.parsed, "name") ?? basename(filePath);
  const contentType = str(ctx.parsed, "content-type") ?? Bun.file(filePath).type ?? "application/octet-stream";
  const key = str(ctx.parsed, "key");
  const params = new URLSearchParams({ name });
  for (const [param, value] of expiryParams(ctx.parsed)) params.set(param, value);

  const headers = new Headers({ "content-type": contentType });
  headers.set("authorization", basicAuth(target.device, target.token));
  headers.set("user-agent", "prime-cli");
  if (key !== undefined && key !== "") headers.set("x-file-key", key);

  const progress = new Progress("uploading", stat.size, progressEnabled(ctx, false));
  const body = countingStream(Bun.file(filePath).stream(), (sent) => progress.update(sent));
  let response: Response;
  try {
    response = await fetch(target.gateway + "/api/files?" + params.toString(), {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(target.timeoutMs),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  } finally {
    progress.finish();
  }
  if (!response.ok) throw await apiError(response);
  const payload = (await response.json()) as { file?: FileView };
  const file = payload.file;
  if (!file) throw new CliError("files API: upload response carried no file record");
  if (file.size !== stat.size) {
    throw new CliError(
      "upload size mismatch: sent " + formatBytes(stat.size) + ", stored " + formatBytes(file.size),
      "The transfer was truncated; retry the upload.",
    );
  }

  if (ctx.json) {
    printJson({ config_path: ctx.configPath, gateway: target.gateway, device: target.device, file });
    return;
  }
  ctx.out(green("\u2713") + " uploaded " + bold(file.name) + " (" + formatBytes(file.size) + ")");
  ctx.out("  id        " + file.id);
  ctx.out("  expires   " + formatTimestamp(file.expires_at) + " (" + formatExpiry(file.expires_at) + ")");
  if (file.protected) ctx.out("  key       " + yellow("set - downloads need --key"));
  ctx.out("  page      " + file.page_url);
  ctx.out("  download  " + dim("prime download " + file.id + " -o " + JSON.stringify(file.name)));
}

// ---- download -----------------------------------------------------------

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** "bytes 100-199/500" -> 500. */
function contentRangeTotal(header: string | null): number | undefined {
  if (!header) return undefined;
  const match = /bytes\s+(\d+)-(\d+)\/(\d+)/i.exec(header);
  return match ? Number(match[3]) : undefined;
}

async function idForName(target: FilesTarget, name: string): Promise<string> {
  const response = await apiFetch(target, "/api/files");
  const data = (await response.json()) as FilesListResponse;
  const matches = (data.files ?? []).filter((file) => file.name === name);
  if (matches.length === 0) {
    throw new CliError('no file named "' + name + '" for device ' + target.device, "Run 'prime files list' to see the stored names, or pass the file id.");
  }
  if (matches.length > 1) {
    throw new CliError('multiple files named "' + name + '"', "Pass one of these ids instead: " + matches.map((file) => file.id).join(", "));
  }
  return matches[0]!.id;
}

export async function filesDownload(ctx: Ctx): Promise<void> {
  const args = ctx.parsed.positionals.slice(2);
  if (args.length === 0) throw new UsageError("missing <file-id-or-name>", "Usage: prime files download <file-id|name> [-o <path>] [options]");
  if (args.length > 1) throw new UsageError('unexpected argument "' + args[1] + '"', "Usage: prime files download <file-id|name> [options]");
  const wanted = args[0]!;
  const target = targetFromCtx(ctx);
  const id = FILE_ID_RE.test(wanted) ? wanted : await idForName(target, wanted);
  const key = str(ctx.parsed, "key");
  const output = str(ctx.parsed, "output");
  const force = bool(ctx.parsed, "force");
  const resume = bool(ctx.parsed, "resume");
  const toStdout = output === "-";

  // A concrete -o lets --resume send the Range before the body is read; a
  // directory (or no -o) means the stored filename is only known after the
  // response headers arrive.
  let outPath: string | undefined;
  let existing = 0;
  if (output !== undefined && !toStdout && !isDirectory(output)) {
    outPath = output;
    if (existsSync(outPath)) {
      const stat = statSync(outPath);
      if (resume) existing = stat.size;
      else if (!force) {
        throw new CliError(
          "refusing to overwrite " + outPath,
          "Pass --force to replace it, or --resume to continue a partial download.",
        );
      }
    }
  }
  if (resume && outPath === undefined) {
    throw new UsageError("--resume needs a concrete -o <path>", "Point it at the partially downloaded file.");
  }

  const headers = new Headers();
  headers.set("authorization", basicAuth(target.device, target.token));
  headers.set("user-agent", "prime-cli");
  if (key !== undefined && key !== "") headers.set("x-file-key", key);
  if (existing > 0) headers.set("range", "bytes=" + existing + "-");

  const response = await fetch(target.gateway + "/api/files/" + encodeURIComponent(id), {
    headers,
    signal: AbortSignal.timeout(target.timeoutMs),
  });
  if (!response.ok) throw await apiError(response);

  const fileName = parseContentDispositionName(response.headers.get("content-disposition")) ?? id;

  if (toStdout) {
    const total = Number(response.headers.get("content-length") ?? "0");
    let written = 0;
    const reader = response.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      written += value.byteLength;
      await new Promise<void>((resolve, reject) => process.stdout.write(value, (err) => (err ? reject(err) : resolve())));
    }
    if (total > 0 && written !== total) throw new CliError("download truncated: received " + formatBytes(written) + " of " + formatBytes(total));
    if (ctx.json) printJson({ downloaded: true, path: "-", size: written, file: { id, name: fileName } });
    return;
  }

  if (outPath === undefined) {
    const dir = output !== undefined && isDirectory(output) ? output : process.cwd();
    outPath = join(dir, fileName);
    if (existsSync(outPath) && !force) {
      void response.body?.cancel().catch(() => {});
      throw new CliError("refusing to overwrite " + outPath, "Pass --force, or -o <path> to choose another name.");
    }
  }

  const append = existing > 0;
  const total = append
    ? contentRangeTotal(response.headers.get("content-range"))
    : Number(response.headers.get("content-length") ?? "0") || undefined;
  const progress = new Progress("downloading", total ?? 0, progressEnabled(ctx, false));
  const handle = await open(outPath, append ? "a" : "w");
  let written = existing;
  try {
    const reader = response.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await handle.write(value);
      written += value.byteLength;
      progress.update(written);
    }
  } catch (err) {
    progress.finish();
    await handle.close();
    if (!append) rmSync(outPath, { force: true });
    throw err;
  }
  progress.finish();
  await handle.close();

  if (total !== undefined && written !== total) {
    if (!append) rmSync(outPath, { force: true });
    throw new CliError(
      "download incomplete: " + formatBytes(written) + " of " + formatBytes(total),
      "Re-run with --resume to continue where it stopped.",
    );
  }

  if (ctx.json) {
    printJson({ downloaded: true, path: outPath, size: written, resumed: append, file: { id, name: fileName, size: written } });
    return;
  }
  ctx.out(green("\u2713") + " downloaded " + bold(fileName) + " (" + formatBytes(written) + ")" + (append ? dim(" (resumed)") : ""));
  ctx.out("  saved to  " + outPath);
}
