#!/usr/bin/env bun
// Minimal MCP server over HTTP (Streamable HTTP transport, JSON-RPC 2.0).
//
// Tools (always on): read, write, edit, multi_edit, bash, shell, command, powershell, grep, find, ls, job, mcp.
// Tools (conditional):
//   - preview              enabled only if `cloudflared` is on PATH
//   - remember, forget, recall  enabled only with --enable-memory
//   - get_upload_link      enabled only with --public or --domain
//
// Shell tools: only one enabled based on detected shell (bash/shell/command/powershell).
//
// Flags:
//   --port <n>         listen port (default: 7777, or $PORT)
//   --token <s>        require ?token=<s> on every request (default: no auth)
//   --enable-memory    enable the remember/forget/recall tools
//   --public           expose via a Cloudflare quick tunnel (requires cloudflared)
//   --domain <host>    use the given public hostname (assumes tunnel already routes it to this port). Mutex with --public.
//   --mcp <path>       aggregate tools from external MCP servers defined in the given JSON config (Claude Desktop format).

import { spawn, spawnSync, file, write } from "bun";
import { chmodSync, mkdtempSync, readdirSync, statSync, mkdirSync, rmdirSync, rmSync, realpathSync, lstatSync, constants as fsConstants } from "node:fs";
import { opendir as fsOpenDir, open as fsOpen, rename as fsRename, unlink as fsUnlink, stat as fsStat } from "node:fs/promises";
import { resolve, sep, basename, dirname, isAbsolute, relative, parse as parsePath } from "node:path";
import { tmpdir } from "node:os";
import { createHash, createHmac, randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { parseArgs } from "util";
import { isIP } from "node:net";

type Json = any;
type Tool = {
  description: string;
  inputSchema: Json;
  handler: (args: Json) => Promise<Json> | Json;
};

// ---------- jobs ----------
type Job = {
  id: string;
  command: string;
  proc: ReturnType<typeof spawn>;
  output: string;
  status: "running" | "exited";
  exitCode?: number;
  startedAt: number;
  completedSequence?: number;
  cancelCapture?: () => void;
  captureIncomplete?: boolean;
  finalization?: Promise<void>;
};
const jobs = new Map<string, Job>();
let jobSeq = 0;
let shuttingDown = false;
let totalJobs = 0;

// Shell command wrappers for each shell type.
function bashCmd(command: string): string[] { return ["bash", "-c", command]; }
function shCmd(command: string): string[] { return ["sh", "-c", command]; }
function cmdCmd(command: string): string[] { return ["cmd.exe", "/d", "/s", "/c", command]; }
function pwshCmd(command: string): string[] {
  // Fall back to "pwsh" name if neither variant is on PATH so spawn surfaces a
  // clear "command not found" rather than throwing earlier.
  const bin = POWERSHELL_BIN ?? "pwsh";
  // -EncodedCommand (base64 UTF-16LE) instead of raw -Command: the Windows
  // command line mangles embedded double quotes, so a quoted "|" separator
  // became a real pipeline and PowerShell tried to run "PLAT=..." as a command.
  // Base64 has no shell metacharacters, so the script arrives intact.
  // Encoded commands can serialize stderr as CLIXML on Windows PowerShell.
  // Keep errors visible and suppress module-initialization progress.
  // Parse separately so leading param/using remain valid. Inner encoding also
  // protects smart quotes. Preserve a final failed command's process status:
  // invoking a script block alone resets $? after nonterminating/native errors.
  const inner = Buffer.from(command + "\nif (-not $?) { exit 1 }", "utf16le").toString("base64");
  const script = "$ProgressPreference = 'SilentlyContinue'; "
    + "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; "
    + "& ([scriptblock]::Create("
    + "[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('" + inner + "'))))";
  return [bin, "-NoProfile", "-NonInteractive", "-OutputFormat", "Text",
    "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

// Detect running shell at startup.
type ShellType = "bash" | "sh" | "cmd" | "powershell";
const IS_WINDOWS = process.platform === "win32";

// Detect which PowerShell binary is available, using raw spawn (don't go through
// shellCmd → chicken-and-egg with DETECTED_SHELL).
function detectPowerShellBinary(): string | null {
  const probe = (bin: string) => {
    try {
      return spawnSync({
        cmd: IS_WINDOWS
          ? ["cmd.exe", "/d", "/s", "/c", `where ${bin}`]
          : ["sh", "-c", `command -v ${bin}`],
        stdout: "ignore",
        stderr: "ignore",
      }).exitCode === 0;
    } catch { return false; }
  };
  if (probe("pwsh")) return "pwsh";
  if (probe("powershell")) return "powershell";
  return null;
}
const POWERSHELL_BIN = detectPowerShellBinary();

function detectShell(): ShellType {
  if (IS_WINDOWS) {
    // PSModulePath is set inside any PowerShell session (5.1 or 7+). Use that as
    // the authoritative signal AND require a usable powershell binary; otherwise
    // fall back to cmd (which is always present).
    if (process.env.PSModulePath && POWERSHELL_BIN) return "powershell";
    return "cmd";
  }
  // Prefer bash if present (matches Python/Java); fall back to $SHELL hint then sh.
  if (spawnSync({ cmd: ["sh", "-c", "command -v bash"], stdout: "ignore", stderr: "ignore" }).exitCode === 0) return "bash";
  const shell = process.env.SHELL;
  if (shell && /\/(bash|zsh|fish|ksh)$/.test(shell)) return shell.endsWith("bash") ? "bash" : "sh";
  return "sh";
}
const DETECTED_SHELL = detectShell();
const shellCmd = DETECTED_SHELL === "bash" ? bashCmd
  : DETECTED_SHELL === "sh" ? shCmd
  : DETECTED_SHELL === "powershell" ? pwshCmd
  : cmdCmd;

// Detect optional external binaries once at startup. Use the platform's
// own binary-locator: `where` on Windows, `command -v` on POSIX. Both
// exit 0 iff the binary is found.
function hasOnPath(bin: string): boolean {
  const probe = IS_WINDOWS ? `where ${bin}` : `command -v ${bin}`;
  // PowerShell's `where` is a Where-Object alias, not the binary locator.
  return spawnSync({ cmd: IS_WINDOWS ? cmdCmd(probe) : shellCmd(probe), stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}
const hasRg = hasOnPath("rg");
const hasFindstr = hasOnPath("findstr");
const hasCloudflared = hasOnPath("cloudflared");

// ---------- args ----------
const USAGE = `Usage: bun code-mcp.ts [options]

Options:
  --port <n>             Listen port (default: 7777, or $PORT)
  --bind <addr>          Bind address (default: 127.0.0.1)
  --token <s>            Require ?token=<s> or Bearer auth on every request
  --enable-memory        Enable remember/forget/recall tools
  --disallowed-tools     Comma-separated list of tools to disable (highest priority)
  --public               Expose via Cloudflare quick tunnel (requires cloudflared)
  --domain <host>        Use given public hostname (mutually exclusive with --public)
  --mcp <path>           Aggregate tools from external MCP servers (JSON config)
  --gateway [domain]     Connect to gateway server; bare flag uses the default
                         (wss://prime.tuanm.workers.dev)
  --id <uuid>            Use specific device ID for gateway connection
  --gateway-token <s>    Device credential sent to the gateway on connect
                         (defaults to --token; must match the token registered
                         for --id in the gateway device registry)
  -h, --help             Show this help and exit`;

// Bare --gateway (no value) connects to the default managed gateway.
const DEFAULT_GATEWAY = "prime.tuanm.workers.dev";
const cliArgs = Bun.argv.slice(2);
for (let i = 0; i < cliArgs.length; i++) {
  if (cliArgs[i] === "--gateway" && (i + 1 >= cliArgs.length || cliArgs[i + 1].startsWith("--"))) {
    cliArgs.splice(i + 1, 0, DEFAULT_GATEWAY);
    break;
  }
}

let args!: Record<string, any>;
try {
  ({ values: args } = parseArgs({
    args: cliArgs,
    options: {
      port: { type: "string" },
      bind: { type: "string" },
      token: { type: "string" },
      "enable-memory": { type: "boolean" },
      "disallowed-tools": { type: "string" },
      public: { type: "boolean" },
      domain: { type: "string" },
      mcp: { type: "string" },
      gateway: { type: "string" },
      id: { type: "string" },
      "gateway-token": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  }));
} catch (e: any) {
  console.error(`error: ${e?.message ?? e}\n`);
  console.error(USAGE);
  process.exit(2);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
const portRaw = args.port ?? process.env.PORT ?? 7777;
const port = Number(portRaw);
if (!Number.isFinite(port) || port < 1 || port > 65535 || !Number.isInteger(port)) {
  console.error(`error: invalid port: ${portRaw}`);
  process.exit(2);
}
const bindAddr: string = typeof args.bind === "string" ? args.bind : "127.0.0.1";
const token: string | undefined = args.token;
// Device credential presented to the gateway on the /ws upgrade: explicit
// --gateway-token wins, otherwise --token (the token registered for the
// device id in the gateway is what authenticates the tunnel).
const gatewayToken: string | undefined = args["gateway-token"] ?? token;
const memoryEnabled = args["enable-memory"] === true;
const disallowedTools: string[] = args["disallowed-tools"]
  ? args["disallowed-tools"].split(",").map((s: string) => s.trim()).filter(Boolean)
  : [];
const makePublic = args.public === true;
const domain: string | undefined = args.domain;
const gatewayDomain: string | undefined = args.gateway;
const assignedDeviceId: string | undefined = args.id;
const mcpConfigPath: string | undefined = args.mcp;

function validPublicDomain(value: string): boolean {
  const match = /^([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(value);
  if (!match || match[0] !== value) return false;
  if (match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > 65535)) return false;
  const host = match[1].endsWith(".") ? match[1].slice(0, -1) : match[1];
  if (!host || host.length > 253) return false;
  const labels = host.split(".");
  if (labels.some(label => label.length > 63 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))) return false;
  // Numeric final labels are interpreted as IPv4 by browser URL parsers.
  // Require an unambiguous dotted-decimal address instead of a broken DNS URL.
  if (/^(?:[0-9]+|0x[0-9a-f]+)$/i.test(labels.at(-1)!)) {
    return labels.length === 4 && labels.every(label => /^(?:0|[1-9][0-9]{0,2})$/.test(label) && Number(label) <= 255);
  }
  return true;
}

if (makePublic && domain) {
  console.error("error: --public and --domain are mutually exclusive\n");
  console.error(USAGE);
  process.exit(2);
}
// Exposing the server to the internet without a token is an unauthenticated
// remote shell (read/write/bash). Refuse instead of silently enabling it.
if ((makePublic || domain) && !token) {
  console.error("error: --public/--domain require --token (otherwise the server is an unauthenticated remote shell)\n");
  console.error(USAGE);
  process.exit(2);
}
if (domain !== undefined && !validPublicDomain(domain)) {
  console.error(`error: invalid --domain: ${domain}`);
  process.exit(2);
}

// publicBaseUrl is set either synchronously (from --domain) or asynchronously
// after the cloudflared quick tunnel prints its URL. Tools that need it must
// check for `null` at call time.
let publicBaseUrl: string | null = domain ? `https://${domain}` : null;
let publicTunnelJob: Job | undefined;
function resolvedPublicBaseUrl(): string | null {
  return domain || (publicTunnelJob && jobParentRunning(publicTunnelJob)) ? publicBaseUrl : null;
}


// Upload root: /private/tmp on macOS (canonical path; /tmp is a symlink there),
// /tmp on Linux, else whatever Node says. Detected once at startup.
const UPLOAD_ROOT = resolve(
  process.platform === "darwin" ? "/private/tmp" :
  process.platform === "linux" ? "/tmp" : tmpdir(), "code-mcp", "uploads");

// ---------- result spill ----------
// Tool results larger than RESULT_SPILL_THRESHOLD bytes are written to a file
// under RESULT_SPILL_ROOT and replaced in the response with a head+tail
// preview plus a pointer to the full file. This protects the agent's context
// window even when the in-memory cap (OUTPUT_CAP_MAX = 1MB) hasn't kicked in.
//
// Threshold and preview sizes are intentionally hard-coded — see project
// CLAUDE.md and the conversation that introduced this feature for the
// rationale (avoid yet-another-flag).
const RESULT_SPILL_ROOT = resolve(tmpdir(), "code-mcp");
const RESULT_SPILL_THRESHOLD = 10_000; // bytes
const RESULT_SPILL_HEAD = 3_000;
const MAX_READ_BYTES = 100 * 1024 * 1024; // cap single-file reads (memory DoS guard)

// Best-effort cleanup of any stale spill files from a previous run. Failure
// is non-fatal: the spill directory may not exist yet, may belong to another
// user, or may be on a read-only filesystem.
// We DO NOT rmSync the shared root because concurrent instances would clobber
// each other; we just ensure our per-PID subdirectory exists.
try {
  mkdirSync(RESULT_SPILL_ROOT, { recursive: true });
  // Spill files hold tool output (potentially secrets): keep the root private
  // and sweep files older than 24h so a long session can't fill the disk or
  // leave world-readable data behind.
  try { chmodSync(RESULT_SPILL_ROOT, 0o700); } catch {}
  const cutoff = Date.now() - 86_400_000;
  for (const name of readdirSync(RESULT_SPILL_ROOT)) {
    try {
      const p = resolve(RESULT_SPILL_ROOT, name);
      const st = statSync(p);
      if (st.isFile() && st.mtimeMs < cutoff) rmSync(p, { force: true });
    } catch {}
  }
} catch (e: any) {
  console.error(`[spill] failed to prepare ${RESULT_SPILL_ROOT}: ${e?.message ?? e}`);
}

// If `text` exceeds the threshold, write it to a metadata-named file in the
// spill directory and return a preview string with a pointer. Otherwise
// pass through unchanged. Async so we don't block the event loop on the
// write; the caller is already awaiting the tool response.
//
// Preview semantics:
//   - HEAD is measured in bytes (UTF-8), matching the threshold.
//   - Slicing is byte-exact; decoding tolerates half-characters at the slice
//     boundary instead of corrupting them.
//   - After byte-slicing, head is trimmed back to the last newline, so the
//     preview lands on a line boundary. This makes log/JSON/code output
//     readable without forcing the agent to guess where the cut happened.
//   - The truncated content is not shown; only a marker pointing to the spill file.
function spillToolName(toolName?: string): string {
  return (toolName ?? "unknown").slice(0, 64).replace(/[^A-Za-z0-9_.-]/g, "_");
}

function hasUnpairedSurrogate(text: string): boolean {
  if (!/[\uD800-\uDFFF]/.test(text)) return false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

async function maybeSpillText(text: string, toolName?: string): Promise<string> {
  if (hasUnpairedSurrogate(text)) {
    const encoded = JSON.stringify(text);
    if (Buffer.byteLength(encoded, "utf8") <= RESULT_SPILL_THRESHOLD) return text;
    return "[JSON-encoded text: JSON-decode the saved file contents to recover the original string.]\n"
      + await maybeSpillText(encoded, toolName);
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= RESULT_SPILL_THRESHOLD) return text;

  // Byte-exact head. Use `fatal: false` so a multibyte char straddling
  // the cut is replaced (U+FFFD) rather than throwing.
  const buf = Buffer.from(text, "utf8");
  const dec = new TextDecoder("utf-8", { fatal: false, ignoreBOM: toolName === "read" });
  let head = dec.decode(buf.subarray(0, RESULT_SPILL_HEAD));

  // Snap to line boundaries when possible. If a line is longer than the
  // window (e.g., a 50 KB single-line JSON), fall back to the byte cut.
  const lastNl = head.lastIndexOf("\n");
  if (lastNl > 0) head = head.slice(0, lastNl);

  // Filename: <ISO compact>-<tool>-<uuid8>.txt. Sortable by time, greppable
  // by tool. UUID suffix keeps it unique within the same millisecond.
  const ts = new Date().toISOString().replace(/[-:.]/g, "").replace(/Z$/, "");
  const safeTool = spillToolName(toolName);
  const shortId = randomUUID().slice(0, 8);
  const fname = `${ts}-${safeTool}-${shortId}.txt`;
  const path = resolve(RESULT_SPILL_ROOT, fname);

  // Count total lines for the marker. This is the only O(N) operation.
  const totalLines = text.length === 0 ? 0 : (text.match(/\n/g)?.length ?? 0) + 1;

  try {
    await Bun.write(path, text);
    try { chmodSync(path, 0o600); } catch {}
  } catch (e: any) {
    // Spill failed (full disk, read-only fs, permission). Do NOT fall back
    // to returning the full text — that would blow the agent's context.
    // Return the preview with a marker explaining what happened.
    console.error(`[spill] failed to write ${path}: ${e?.message ?? e}`);
    const failMarker =
      `\n[TRUNCATED: full output is ${bytes} bytes (${totalLines} lines); ` +
      `spill to disk FAILED (${e?.message ?? "unknown error"})]\n`;
    return head + failMarker;
  }

  const marker =
    `\n[TRUNCATED: ${bytes} bytes (${totalLines} lines) saved to ${path} — ` +
    `use read with range or grep to view the remaining content]\n`;
  return head + marker;
}

function uploadWidget(url: string): string {
  return (
    "<div style=\"display: flex; flex-direction: column; gap: 12px; max-width: 560px;\"><div style=\"positio" +
    "n: relative;\"><pre style=\"margin: 0; padding: 12px 40px 12px 12px; background: var(--color-backgroun" +
    "d-secondary); border-radius: var(--border-radius-md); font-size: 12px; font-family: var(--font-mono)" +
    "; color: var(--color-text-primary); white-space: pre-wrap; overflow-wrap: anywhere;\">{UPLOAD_URL}</p" +
    "re><button type=\"button\" aria-label=\"Copy URL\" data-url=\"{UPLOAD_URL}\" style=\"position: absolute; to" +
    "p: 8px; right: 8px; width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center" +
    "; justify-content: center; color: var(--color-text-tertiary); background: transparent; border: none;" +
    " cursor: pointer; border-radius: 4px;\" onmouseover=\"this.style.background='var(--color-background-pr" +
    "imary)'; this.style.color='var(--color-text-primary)';\" onmouseout=\"this.style.background='transpare" +
    "nt'; this.style.color='var(--color-text-tertiary)';\" onclick=\"(function(b){var u=b.getAttribute('dat" +
    "a-url');var prev=b.innerHTML;var done=function(){b.innerHTML='<svg width=\\'14\\' height=\\'14\\' viewBo" +
    "x=\\'0 0 24 24\\' fill=\\'none\\' stroke=\\'currentColor\\' stroke-width=\\'2\\' stroke-linecap=\\'round\\' st" +
    "roke-linejoin=\\'round\\'><polyline points=\\'20 6 9 17 4 12\\'/></svg>';b.style.color='var(--color-text" +
    "-success)';setTimeout(function(){b.innerHTML=prev;b.style.color='var(--color-text-tertiary)';},1500)" +
    ";};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(u).then(done" +
    ").catch(function(){});}else{var ta=document.createElement('textarea');ta.value=u;ta.style.cssText='p" +
    "osition:fixed;left:-9999px;';document.body.appendChild(ta);ta.select();try{document.execCommand('cop" +
    "y');done();}catch(e){}document.body.removeChild(ta);}})(this)\"><svg width=\"14\" height=\"14\" viewBox=\"" +
    "0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin" +
    "=\"round\" aria-hidden=\"true\"><rect x=\"9\" y=\"9\" width=\"13\" height=\"13\" rx=\"2\" ry=\"2\"/><path d=\"M5 15H4" +
    "a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1\"/></svg></button></div><a href=\"{UPLOAD_URL}\" targe" +
    "t=\"_blank\" rel=\"noopener\" style=\"display: inline-block; align-self: flex-start; font-family: var(--f" +
    "ont-sans); font-size: 14px; padding: 8px 16px; background: transparent; color: var(--color-text-prim" +
    "ary); border: 0.5px solid var(--color-border-secondary); border-radius: var(--border-radius-md); tex" +
    "t-decoration: none; cursor: pointer; transition: background 100ms ease, transform 100ms ease;\" onmou" +
    "seover=\"this.style.background='var(--color-background-secondary)'\" onmouseout=\"this.style.background" +
    "='transparent'\" onmousedown=\"this.style.transform='scale(0.98)'\" onmouseup=\"this.style.transform='sc" +
    "ale(1)'\">Open</a></div>"
  ).replaceAll("{UPLOAD_URL}", xmlAttr(url));
}

// ---------- upload session HMAC ----------
// session_id = base64url(payload).base64url(HMAC-SHA256(token, payload))
// payload = `${exp_unix_ms}.${nonce_hex}`. TTL = 10 minutes.
const UPLOAD_TTL_MS = 10 * 60 * 1000;

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Buffer {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

function mintUploadSessionId(): string {
  if (!token) throw new Error("--token is required to mint upload sessions");
  const exp = Date.now() + UPLOAD_TTL_MS;
  const nonce = randomBytes(8).toString("hex");
  const payload = `${exp}.${nonce}`;
  const sig = createHmac("sha256", token).update(payload).digest();
  return `${b64url(payload)}.${b64url(sig)}`;
}

function verifiedUploadExpiry(id: string): number {
  if (!token) throw new Error("server has no token configured");
  if (typeof id !== "string" || id.length > 128 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(id)) throw new Error("malformed");
  const [body, signature] = id.split(".");
  const raw = b64urlDecode(body), sig = b64urlDecode(signature);
  if (b64url(raw) !== body || b64url(sig) !== signature) throw new Error("malformed");
  const payload = raw.toString("utf8");
  if (!/^[1-9][0-9]{0,15}\.[a-f0-9]{16}$/.test(payload)) throw new Error("malformed");
  const expiry = Number(payload.split(".")[0]);
  if (!Number.isSafeInteger(expiry)) throw new Error("malformed");
  const expected = createHmac("sha256", token).update(payload).digest();
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) throw new Error("bad signature");
  return expiry;
}

function verifyUploadSessionId(id: string): { ok: true } | { ok: false; reason: string } {
  try {
    if (Date.now() > verifiedUploadExpiry(id)) return { ok: false, reason: "expired" };
    return { ok: true };
  } catch (error: any) { return { ok: false, reason: error?.message ?? "malformed" }; }
}

// Cap how much output we keep in memory for any captured stream. When the
// buffer exceeds CAP_MAX, we trim back to CAP_KEEP from the tail. This
// matters for grep across large trees, cat-ing big files via bash, and any
// long-running background job that floods output.
const OUTPUT_CAP_MAX = 1_000_000;
const OUTPUT_CAP_KEEP = 500_000;
const DEFAULT_SHELL_TIMEOUT_MS = 60_000;

function timeoutMarker(ms: number): string {
  return `\n[TIMEOUT after ${ms}ms — long-running? use the \`job\` tool: `
    + `mode=start to launch, mode=view to check progress]`;
}

function backgroundedMarker(ms: number, jobId: string): string {
  return `\n[BACKGROUNDED after ${ms}ms — process still running as job ${jobId}. `
    + `Above output is a snapshot at handoff; further output continues into the job. `
    + `Use \`job\` tool: mode=view command=${jobId} to read, mode=stop command=${jobId} to kill. `
    + `Pass explicit timeout_ms to disable auto-background and force kill-on-timeout instead.]`;
}

// Kill a process and all its descendants. Bun's proc.kill() only signals the
// direct child; orphaned grandchildren (e.g. `sleep` spawned by a killed
// `bash`) keep stdout pipes open and stall proc.exited. Use pgrep -P to walk
// the tree and SIGKILL each pid.
async function killProcessTree(pid: number, stillRunning: () => boolean = () => true, deadline = performance.now() + 3000): Promise<boolean> {
  if (!stillRunning()) return true;
  if (process.platform === "win32") {
    const systemRoot = Object.entries(process.env).find(([key]) => key.toLowerCase() === "systemroot")?.[1] ?? "C:/Windows";
    let helper: ReturnType<typeof spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const remaining = Math.max(0, deadline - performance.now());
      if (remaining > 0 && stillRunning()) {
        // Use an owned asynchronous process and JS timer: Bun's synchronous
        // spawn timeout can expire spuriously after a long-lived shell handoff.
        helper = spawn({
          cmd: [resolve(systemRoot, "System32", "taskkill.exe"), "/F", "/T", "/PID", String(pid)],
          stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true,
          env: buildChildEnv({}),
        });
        const result = await Promise.race([
          helper.exited,
          new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), Math.max(0, deadline - performance.now())); }),
        ]);
        if (result === 0) return true;
      }
    } catch {}
    finally {
      if (timer) clearTimeout(timer);
      if (helper && typeof helper.exitCode !== "number" && !helper.signalCode) {
        try { helper.kill("SIGKILL"); } catch {}
      }
    }
    // Never target the numeric parent PID after observing its exit. A parent
    // fallback alone does not establish that descendants were terminated.
    if (stillRunning()) { try { process.kill(pid, "SIGKILL"); } catch {} }
    return false;
  }
  // Walk descendants depth-first so children die before parents (cleaner).
  let children: number[] = [];
  try {
    const out = spawnSync({ cmd: ["pgrep", "-P", String(pid)], stdout: "pipe", stderr: "ignore" })
      .stdout.toString().trim();
    if (out) children = out.split("\n").map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n));
  } catch {}
  let complete = true;
  for (const c of children) if (!(await killProcessTree(c, () => true, deadline))) complete = false;
  if (stillRunning()) {
    try { process.kill(pid, "SIGKILL"); }
    catch (error: any) { if (error?.code !== "ESRCH") complete = false; }
  }
  return complete;
}

// Shared runner for bash/shell/command/powershell tools.
//
// Two paths depending on whether the caller passed timeout_ms:
//   - explicit timeout_ms > 0: classic kill-on-timeout behaviour (exit=124 + timeoutMarker).
//   - no timeout_ms: at DEFAULT_SHELL_TIMEOUT_MS (60s) the still-running process is
//     adopted into the `job` system instead of being killed, and we return
//     exit=running + backgroundedMarker so the agent can poll with the `job` tool.
//
// Uses a single combined sink (stdout+stderr interleaved by arrival, matching the
// `job` tool's behaviour) so the sink can be handed off to the adopted Job
// without merging buffers.
// Bound concurrent shell executions (parity with Java/Python's 5 permits):
// an agent firing many bash calls in parallel must not spawn unbounded
// subprocesses (resource-DoS guard).
const MAX_CONCURRENT_SHELL = 5;
let shellActive = 0;
const shellWaiters: Array<() => void> = [];

async function acquireShellSlot(timeoutMs = 30_000): Promise<boolean> {
  if (shellActive < MAX_CONCURRENT_SHELL) { shellActive++; return true; }
  return new Promise<boolean>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      const i = shellWaiters.indexOf(wake);
      if (i >= 0) shellWaiters.splice(i, 1);
      resolve(false);
    }, timeoutMs);
    const wake = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      shellActive++;
      resolve(true);
    };
    shellWaiters.push(wake);
  });
}

function releaseShellSlot(): void {
  shellActive--;
  const w = shellWaiters.shift();
  if (w) w();
}

const SHELL_TOOL_NAMES = new Set(["bash", "shell", "command", "powershell"]);

async function runShellTool(args: unknown, wrapper: (command: string) => string[]): Promise<string> {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("shell arguments must be an object");
  const values = args as Record<string, unknown>;
  const owns = (key: string) => Object.prototype.hasOwnProperty.call(values, key);
  if (!owns("cwd") || !owns("command") || typeof values.cwd !== "string" || !values.cwd.length || typeof values.command !== "string") {
    throw new Error("shell requires a nonempty cwd string and a command string");
  }
  const { cwd, command } = values;
  for (const [name, value] of [["cwd", cwd], ["command", command]]) {
    if (value.includes("\0")) throw new Error(`${name} contains NUL`);
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(`${name} contains invalid Unicode`);
      } else if (c >= 0xdc00 && c <= 0xdfff) throw new Error(`${name} contains invalid Unicode`);
    }
  }
  let timeout: number | undefined;
  if (owns("timeout_ms")) {
    const value = values.timeout_ms;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 2147483647) {
      throw new Error("timeout_ms must be an integer from 1 to 2147483647");
    }
    timeout = value;
  }
  if (!statSync(cwd).isDirectory()) throw new Error("cwd must be an existing directory");
  return runShell(wrapper(command), cwd, command, timeout);
}

async function runShell(cmd: string[], cwd: string, command: string, timeout_ms?: number): Promise<string> {
  if (!(await acquireShellSlot())) {
    throw new Error("Too many concurrent shell executions, please try again later");
  }
  try {
    await ensureWindowsRootOwner();
    return await runShellInner(cmd, cwd, command, timeout_ms);
  } finally {
    releaseShellSlot();
  }
}

async function runShellInner(cmd: string[], cwd: string, command: string, timeout_ms?: number): Promise<string> {
  const started = performance.now();
  const explicit = typeof timeout_ms === "number" && timeout_ms > 0;
  const effective = explicit ? (timeout_ms as number) : DEFAULT_SHELL_TIMEOUT_MS;
  let proc: ReturnType<typeof spawn>;
  const verbatimCmd = process.platform === "win32" && cmd[0].toLowerCase() === "cmd.exe";
  try {
    proc = spawn({
      // CMD /s /c removes this outer pair while preserving the user's quoted
      // executable/script arguments. CRT escaping would turn them into literals.
      cmd: verbatimCmd ? [...cmd.slice(0, -1), '"' + cmd[cmd.length - 1] + '"'] : cmd,
      windowsVerbatimArguments: verbatimCmd,
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: buildChildEnv({}),
      // Own process group so killJobTree's negative-PID kill reaches
      // grandchildren (tree-kill parity with Python/Java).
      detached: process.platform !== "win32",
    });
  } catch (e) {
    const reason = (e as Error).message || String(e);
    throw new Error(`shell spawn failed: ${reason}`);
  }
  const sink = { text: "" };
  const captures = [startCapturedPump(proc.stdout as any, sink), startCapturedPump(proc.stderr as any, sink)];
  const pumps = Promise.all(captures.map(capture => capture.done));
  let parentExited = false;
  let exitCode = -1;
  const exitPromise = proc.exited.then(code => { parentExited = true; exitCode = code; return code; });
  const running = () => !parentExited && typeof proc.exitCode !== "number" && !proc.signalCode;
  const complete = Promise.all([exitPromise, pumps]);
  const snapshot = () => (captures.some(capture => capture.incomplete) ? OUTPUT_INCOMPLETE_MARKER : "") + sink.text;
  const cancelCapture = () => { for (const capture of captures) capture.cancel(); };
  const waitBriefly = async (cleanupDeadline: number) => {
    const remaining = Math.min(1000, Math.max(0, cleanupDeadline - performance.now()));
    if (remaining <= 0) { cancelCapture(); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([complete, new Promise(resolve => { timer = setTimeout(resolve, remaining); })]); }
    finally { if (timer) clearTimeout(timer); }
    cancelCapture();
  };
  let handedOff = false;
  let timerHandle: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">(resolve => {
    timerHandle = setTimeout(() => resolve("timeout"), Math.max(0, effective - (performance.now() - started)));
  });
  try {
    const winner = await Promise.race([complete, deadline]);
    if (winner !== "timeout") return `exit=${exitCode}\n${snapshot()}`;
    if (explicit) {
      // An exited parent's PID may be recycled. Only cancel our capture once
      // it exits; never tree-kill its independently surviving descendants.
      const cleanupDeadline = performance.now() + 3000;
      const terminated = !running() || await killProcessTree(proc.pid, running, cleanupDeadline);
      await waitBriefly(cleanupDeadline);
      const termination = terminated ? "" : "\n[TERMINATION INCOMPLETE: process-tree termination could not be confirmed]";
      return `exit=124\n${snapshot()}${timeoutMarker(effective)}${termination}`;
    }
    if (!running()) {
      cancelCapture();
      return `exit=${typeof proc.exitCode === "number" ? proc.exitCode : exitCode}\n${snapshot()}`;
    }
    try {
      const job = adoptJob(command, proc as any, sink, captures);
      handedOff = true;
      // Live readers retain ownership after this handoff and keep filling sink.
      return `exit=running\n${sink.text}${backgroundedMarker(effective, job.id)}`;
    } catch (error) {
      const cleanupDeadline = performance.now() + 3000;
      const terminated = !running() || await killProcessTree(proc.pid, running, cleanupDeadline);
      await waitBriefly(cleanupDeadline);
      const termination = terminated ? "" : "\n[TERMINATION INCOMPLETE: process-tree termination could not be confirmed]";
      const reason = (error as Error).message || String(error);
      return `exit=124\n${snapshot()}\n[Auto-background failed: ${reason}; termination requested.]${termination}`;
    }
  } finally {
    if (timerHandle) clearTimeout(timerHandle);
    if (!handedOff) cancelCapture();
  }
}

// Spawn-time env allow-list. Used for both .mcp.json children AND user-invoked
// shell tools. The MCP token is itself sensitive (full RCE on hand-off), so we
// limit blast radius: even if an attacker phishes the token, they can't trivially
// exfiltrate AWS_*, OPENAI_API_KEY, etc. — those vars are not forwarded.
// Users who need extra vars in their commands should set them inline:
//   bash -c "FOO=$FOO_FROM_FILE my-cmd"
const SPAWN_ENV_ALLOWLIST = new Set([
  "PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
  "TMPDIR", "TEMP", "TMP",
  "SystemRoot", "SystemDrive", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "PROGRAMFILES", "PROGRAMDATA", "WINDIR", "COMSPEC", "PATHEXT",
  // Non-secret Windows system variables. PSModulePath matters most: without it
  // Windows PowerShell rebuilds its module cache on every start ("Preparing
  // modules for first use"), which made each PowerShell command - and the job
  // helper compile - take 10-30 s instead of well under one.
  "PSModulePath", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432",
  "ALLUSERSPROFILE", "PUBLIC", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "USERNAME", "COMPUTERNAME", "HOMEDRIVE", "HOMEPATH",
]);

function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  if (process.platform === "win32") {
    const allowed = new Set([...SPAWN_ENV_ALLOWLIST].map(key => key.toLowerCase()));
    for (const [key, value] of Object.entries(process.env)) {
      if (allowed.has(key.toLowerCase()) && typeof value === "string") base[key] = value;
    }
  } else {
    for (const key of SPAWN_ENV_ALLOWLIST) {
      const value = process.env[key];
      if (typeof value === "string") base[key] = value;
    }
  }
  if (process.platform === "win32") {
    for (const [key, value] of Object.entries(extra)) {
      for (const inherited of Object.keys(base)) if (inherited.toLowerCase() === key.toLowerCase()) delete base[inherited];
      base[key] = value;
    }
    return base;
  }
  return { ...base, ...extra };
}

// Pump a readable stream into `sink.text`, capping in-place. Used by both the
// background-job harness (startJob) and one-shot tool handlers (bash, grep)
// so memory use is bounded everywhere we capture subprocess output.
//
// Decoder uses {stream:true} so a UTF-8 sequence split across chunk boundaries
// is held until completion instead of being emitted as U+FFFD. Cap is measured
// in bytes (via Buffer.byteLength) to stay consistent with maybeSpillText and
// to give honest accounting for multibyte content. Trimming advances to a
// complete UTF-8 character boundary and prefixes an explicit truncation marker,
// so retained valid text gains no replacement characters and loss is disclosed.
const OUTPUT_TRUNCATED_MARKER = "[OUTPUT TRUNCATED: earlier output discarded; retained tail follows]\n";
const OUTPUT_INCOMPLETE_MARKER = "[OUTPUT INCOMPLETE: capture stopped before all output streams closed]\n";
const captureSizes = new WeakMap<object, number>();
function appendCaptured(sink: { text: string }, value: string): void {
  if (!value) return;
  let bytes = (captureSizes.get(sink) ?? Buffer.byteLength(sink.text, "utf8")) + Buffer.byteLength(value, "utf8");
  sink.text += value;
  if (bytes > OUTPUT_CAP_MAX) {
    const encoded = Buffer.from(sink.text, "utf8");
    let offset = Math.max(0, encoded.length - OUTPUT_CAP_KEEP);
    // Discard a partial leading code point rather than injecting U+FFFD.
    while (offset < encoded.length && (encoded[offset] & 0xc0) === 0x80) offset++;
    sink.text = OUTPUT_TRUNCATED_MARKER + new TextDecoder("utf-8", { ignoreBOM: true }).decode(encoded.subarray(offset));
    bytes = Buffer.byteLength(sink.text, "utf8");
  }
  captureSizes.set(sink, bytes);
}

function startCapturedPump(stream: ReadableStream<Uint8Array> | null, sink: { text: string }) {
  let stopped = false, completed = !stream, failed = false;
  const reader = stream?.getReader();
  const done = (async () => {
    if (!reader) return;
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    try {
      while (!stopped) {
        const item = await reader.read();
        if (stopped) break;
        if (item.done) {
          appendCaptured(sink, decoder.decode());
          completed = true;
          break;
        }
        appendCaptured(sink, decoder.decode(item.value, { stream: true }));
      }
    } catch { failed = true; }
    finally { try { reader.releaseLock(); } catch {} }
  })();
  return {
    done,
    get incomplete() { return failed || !completed; },
    cancel() {
      if (completed || stopped) return;
      stopped = true;
      // Cancellation owns the stream, not the descendant that inherited its
      // write end. Never wait for cancellation acknowledgement in a response.
      try { void reader?.cancel().catch(() => {}); } catch {}
    },
  };
}

async function pumpCapped(stream: ReadableStream<Uint8Array> | null, sink: { text: string }): Promise<void> {
  const pump = startCapturedPump(stream, sink);
  await pump.done;
  if (pump.incomplete) appendCaptured(sink, OUTPUT_INCOMPLETE_MARKER);
}

let completedJobSequence = 0;
function pruneCompletedJobs(): void {
  const completed = [...jobs.values()].filter(job => job.status === "exited")
    .sort((a, b) => (a.completedSequence ?? 0) - (b.completedSequence ?? 0));
  for (const job of completed.slice(0, Math.max(0, completed.length - 100))) jobs.delete(job.id);
}

function ownJobCapture(job: Job, sink: { text: string }, captures: ReturnType<typeof startCapturedPump>[]): void {
  let markedIncomplete = false;
  job.cancelCapture = () => {
    for (const capture of captures) capture.cancel();
    if (!markedIncomplete && captures.some(capture => capture.incomplete)) {
      markedIncomplete = true;
      job.captureIncomplete = true;
      appendCaptured(sink, OUTPUT_INCOMPLETE_MARKER);
    }
  };
  const pumps = Promise.all(captures.map(capture => capture.done));
  job.finalization = job.proc.exited.then(async code => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([pumps, new Promise(resolve => { timer = setTimeout(resolve, 1000); })]);
    } finally {
      if (timer) clearTimeout(timer);
      job.cancelCapture?.();
    }
    // Publish completed state only after final output has stopped changing.
    job.exitCode = code;
    job.completedSequence = ++completedJobSequence;
    job.status = "exited";
    totalJobs--;
    pruneCompletedJobs();
  });
  void job.finalization.catch(error => {
    job.cancelCapture?.();
    appendCaptured(sink, `\n[JOB FINALIZATION FAILED: ${String(error)}]\n`);
  });
}

function jobParentRunning(job: { proc: any; status: string }): boolean {
  return job.status === "running" && typeof job.proc.exitCode !== "number" && !job.proc.signalCode;
}

async function stopOwnedJob(job: Job, graceMs = 500): Promise<void> {
  const deadline = performance.now() + 3000;
  let confirmed = await killJobTree(job, "SIGTERM", deadline);
  const wait = async (milliseconds: number) => {
    const remaining = Math.min(milliseconds, Math.max(0, deadline - performance.now()));
    if (remaining <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([job.finalization ?? job.proc.exited, new Promise(resolve => { timer = setTimeout(resolve, remaining); })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  const grace = typeof graceMs === "number" && Number.isFinite(graceMs) ? Math.max(0, Math.min(1000, graceMs)) : 500;
  await wait(grace);
  // Windows already requested forced tree termination; do not start a second
  // three-second taskkill after consuming part of the shared cleanup budget.
  if (process.platform !== "win32" && jobParentRunning(job) && performance.now() < deadline) {
    confirmed = (await killJobTree(job, "SIGKILL", deadline)) && confirmed;
  }
  if (process.platform !== "win32" && !jobParentRunning(job)) {
    try { process.kill(-job.proc.pid, 0); confirmed = false; }
    catch (e: any) { if (e.code !== "ESRCH") confirmed = false; }
  }
  await wait(3000);
  if (job.status !== "exited") job.cancelCapture?.();
  if (!confirmed || jobParentRunning(job) || job.status !== "exited" || job.captureIncomplete) {
    throw new Error(`${job.id}: termination incomplete; process-tree termination or final capture could not be confirmed`);
  }
}

function startJob(command: string, cwd: string): Promise<Job> {
  return startJobImpl(shellCmd(command), command, cwd);
}

// Like startJob but spawns argv directly (no shell interpolation): use for
// tool inputs that must never reach a shell (e.g. preview's URL).
function startJobArgv(argv: string[], displayCommand: string, cwd: string): Promise<Job> {
  return startJobImpl(argv, displayCommand, cwd);
}

async function startJobImpl(argv: string[], displayCommand: string, cwd: string): Promise<Job> {
  await ensureWindowsRootOwner();
  pruneCompletedJobs();
  if (totalJobs >= MAX_JOBS) throw new Error(`max concurrent jobs (${MAX_JOBS}) exceeded`);
  if (shuttingDown) throw new Error("server is shutting down");
  totalJobs++;
  const id = `j${++jobSeq}`;
  let proc: any;
  const verbatimCmd = process.platform === "win32" && argv[0].toLowerCase() === "cmd.exe";
  try {
    proc = spawn({
      cmd: verbatimCmd ? [...argv.slice(0, -1), '"' + argv[argv.length - 1] + '"'] : argv,
      windowsVerbatimArguments: verbatimCmd,
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: buildChildEnv({}),
      // Own process group so killJobTree's negative-PID kill reaches
      // grandchildren too (tree-kill parity with Python/Java).
      detached: process.platform !== "win32",
    });
  } catch (e) {
    totalJobs--;
    throw e;
  }
  const job: Job = { id, command: displayCommand, proc, output: "", status: "running", startedAt: Date.now() };
  jobs.set(id, job);

  const sink = { get text() { return job.output; }, set text(v: string) { job.output = v; } };
  ownJobCapture(job, sink, [startCapturedPump(proc.stdout as any, sink), startCapturedPump(proc.stderr as any, sink)]);
  return job;
}

// Adopt an already-spawned process (whose stdout/stderr are being pumped into `sink`)
// into the job registry. Reuses the existing sink so in-flight pump writes continue
// to land in job.output without dropping data; the sink's `text` accessor is rebound
// to delegate to job.output so subsequent reads and appends stay coherent.
function adoptJob(command: string, proc: any, sink: { text: string }, captures: ReturnType<typeof startCapturedPump>[]): Job {
  pruneCompletedJobs();
  if (totalJobs >= MAX_JOBS) throw new Error(`max concurrent jobs (${MAX_JOBS}) exceeded`);
  if (shuttingDown) throw new Error("server is shutting down");
  totalJobs++;
  const id = `j${++jobSeq}`;
  const job: Job = { id, command, proc, output: sink.text, status: "running", startedAt: Date.now() };
  jobs.set(id, job);
  Object.defineProperty(sink, "text", {
    get: () => job.output,
    set: (v: string) => { job.output = v; },
    configurable: true,
    enumerable: true,
  });
  ownJobCapture(job, sink, captures);
  return job;
}

// ---------- memos ----------
type Memo = { id: number; ts: number; memo: string; tags?: string[] };

// Filter to a clean string[] or undefined. Drops null/numbers/empty strings.
function sanitizeTags(tags: unknown): string[] | undefined {
  if (!Array.isArray(tags)) return undefined;
  const out: string[] = [];
  for (const t of tags) {
    if (typeof t === "string" && t.length > 0) out.push(t);
  }
  return out.length ? out : undefined;
}

// Gregorian dates repeat every 400 years. Keep native date conversion within
// 1970..2369 while supporting every nonnegative safe-integer millisecond value.
function formatMemoTimestamp(ms: number): string {
  const cycleMs = 146097 * 86400000;
  const date = new Date(ms % cycleMs);
  const year = date.getUTCFullYear() + Math.floor(ms / cycleMs) * 400;
  const prefix = year <= 9999 ? String(year).padStart(4, "0") : "+" + String(year).padStart(6, "0");
  return prefix + date.toISOString().slice(4);
}

type RecallEntry = { memo: Memo; ordinal: number };
async function selectRecallPage(cwd: string, query: unknown, tags: unknown, limit: number, offset: number): Promise<{ total: number; page: Memo[] }> {
  const q = typeof query === "string" && query.length ? query.toLowerCase() : null;
  const wanted = sanitizeTags(tags)?.map(tag => tag.toLowerCase());
  const scan = async (capacity: number) => {
    const heap: RecallEntry[] = [];
    let total = 0;
    const compare = (a: RecallEntry, b: RecallEntry) => a.memo.id - b.memo.id || b.ordinal - a.ordinal;
    await readMemoAppendState(cwd, (raw) => {
      if (q && !raw.memo.toLowerCase().includes(q)) return;
      const clean = sanitizeTags(raw.tags);
      if (wanted) {
        const actual = new Set(clean?.map(tag => tag.toLowerCase()));
        if (!wanted.every(tag => actual.has(tag))) return;
      }
      const entry: RecallEntry = { memo: { id: raw.id, ts: raw.ts, memo: raw.memo, ...(clean ? { tags: clean } : {}) }, ordinal: total++ };
      if (heap.length < capacity) {
        heap.push(entry);
        let at = heap.length - 1;
        while (at > 0) {
          const parent = (at - 1) >> 1;
          if (compare(heap[at], heap[parent]) >= 0) break;
          [heap[at], heap[parent]] = [heap[parent], heap[at]];
          at = parent;
        }
      } else if (compare(entry, heap[0]) > 0) {
        heap[0] = entry;
        let at = 0;
        while (at * 2 + 1 < heap.length) {
          let child = at * 2 + 1;
          if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) < 0) child++;
          if (compare(heap[at], heap[child]) <= 0) break;
          [heap[at], heap[child]] = [heap[child], heap[at]];
          at = child;
        }
      }
    });
    return { total, heap };
  };
  // Common pages retain at most 2,000 entries. Deep pages use one scan and
  // native sorting: a tail probe plus rescan doubled their measured latency.
  if (offset > 1000) {
    const memos: Memo[] = [];
    await readMemoAppendState(cwd, raw => {
      if (q && !raw.memo.toLowerCase().includes(q)) return;
      const clean = sanitizeTags(raw.tags);
      if (wanted && !wanted.every(tag => clean?.some(value => value.toLowerCase() === tag))) return;
      memos.push({ id: raw.id, ts: raw.ts, memo: raw.memo, ...(clean ? { tags: clean } : {}) });
    });
    memos.sort((a, b) => b.id - a.id);
    return { total: memos.length, page: memos.slice(offset, offset + limit) };
  }
  const selected = await scan(offset + limit);
  selected.heap.sort((a, b) => b.memo.id - a.memo.id || a.ordinal - b.ordinal);
  return { total: selected.total, page: selected.heap.slice(offset, offset + limit).map(entry => entry.memo) };
}

async function readMemos(cwd: string): Promise<Memo[]> {
  const memos: Memo[] = [];
  await readMemoAppendState(cwd, (m) => {
    const cleanTags = sanitizeTags(m.tags);
    if (cleanTags) m.tags = cleanTags; else delete m.tags;
    memos.push(m);
  });
  return memos;
}

// ---------- cross-process memo lock ----------
// Multiple Claude agents on the same device may share a cwd. Coordinate via
// an EEXIST lockfile so remember/forget never interleave across processes.
const MEMO_LOCK_TIMEOUT_MS = 30_000;
const STALE_MEMO_LOCK_MS = 60_000;
const MEMO_LOCK_RETRY_MS = 40;

// Only a proven dead owner permits stale-lock recovery. Unknown/denied
// process queries and malformed lock contents must not evict a live writer.
async function memoLockOwnerDefinitelyDead(lockPath: string): Promise<boolean> {
  const fh = await fsOpen(lockPath, "r");
  let owner: string;
  try {
    const bytes = Buffer.alloc(128);
    const { bytesRead } = await fh.read(bytes, 0, bytes.length, 0);
    owner = bytes.subarray(0, bytesRead).toString("utf8");
  } finally { await fh.close(); }
  const match = /^([1-9][0-9]{0,9})\r?\n/.exec(owner);
  if (!match) return false;
  return memoProcessDefinitelyDead(Number(match[1]));
}

function memoProcessDefinitelyDead(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1 || pid > 2147483647) return false;
  try { process.kill(pid, 0); return false; }
  catch (error: any) { return error?.code === "ESRCH"; }
}

// Recovery participants own unique paths: a crashed reaper cannot leave a
// second shared stale lock. Completed tickets order competing recovery only.
async function memoRecoveryEntries(root: string, deadline: number): Promise<Array<{ name: string; ticket: number }>> {
  const entries: Array<{ name: string; ticket: number }> = [];
  const directory = await fsOpenDir(root);
  let count = 0;
  for await (const item of directory) {
    if (performance.now() >= deadline) throw new Error("timeout waiting for memo lock recovery");
    if (++count > 4096) throw new Error("too many memo recovery participants");
    const match = /^p([1-9][0-9]{0,9})-([0-9a-f]{32})$/.exec(item.name);
    if (!match) continue;
    const participant = resolve(root, item.name);
    try {
      const info = lstatSync(participant);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("invalid memo recovery participant");
      if (memoProcessDefinitelyDead(Number(match[1]))) {
        // No recursive removal. Preserve unexpected contents and user files.
        try { const st = lstatSync(resolve(participant, "ticket")); if (st.isFile() && !st.isSymbolicLink()) await fsUnlink(resolve(participant, "ticket")); } catch { }
        try { rmdirSync(participant); } catch { }
        continue;
      }
      let ticket = 0;
      try {
        const path = resolve(participant, "ticket"), st = lstatSync(path);
        if (!st.isFile() || st.isSymbolicLink() || st.size > 64) throw new Error("invalid memo recovery ticket");
        const fh = await fsOpen(path, "r");
        let text: string;
        try { const bytes = Buffer.alloc(65); const read = await fh.read(bytes, 0, bytes.length, 0); text = bytes.subarray(0, read.bytesRead).toString("utf8"); }
        finally { await fh.close(); }
        // No LF yet means its owner is still publishing the ticket.
        if (text.endsWith("\n")) {
          if (!/^[1-9][0-9]{0,15}\n$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error("invalid memo recovery ticket");
          ticket = Number(text);
        } else if (text.length > 16 || !/^[0-9]*$/.test(text)) throw new Error("invalid memo recovery ticket");
      } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
      entries.push({ name: item.name, ticket });
    } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  }
  return entries;
}

async function withMemoRecovery(cwd: string, deadline: number, action: () => Promise<void>): Promise<void> {
  const root = resolve(cwd, ".memo.recovery");
  try { mkdirSync(root, { mode: 0o700 }); } catch (error: any) { if (error?.code !== "EEXIST") throw error; }
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("memo recovery must be a real directory");
  const name = `p${process.pid}-${randomUUID().replaceAll("-", "")}`, participant = resolve(root, name);
  mkdirSync(participant, { mode: 0o700 });
  try {
    const peers = await memoRecoveryEntries(root, deadline);
    const ticket = Math.max(0, ...peers.map(peer => peer.ticket)) + 1;
    if (!Number.isSafeInteger(ticket)) throw new Error("memo recovery ticket space exhausted");
    const fh = await fsOpen(resolve(participant, "ticket"), "wx", 0o600);
    try { await fh.writeFile(`${ticket}\n`); } finally { await fh.close(); }
    while (performance.now() < deadline) {
      const waiting = (await memoRecoveryEntries(root, deadline)).some(peer => peer.name !== name
        && (peer.ticket === 0 || peer.ticket < ticket || (peer.ticket === ticket && peer.name < name)));
      if (!waiting) { await action(); return; }
      await new Promise(resolve => setTimeout(resolve, MEMO_LOCK_RETRY_MS));
    }
    throw new Error("timeout waiting for memo lock recovery");
  } finally {
    // Another reader may briefly hold our ticket open on Windows. This path is
    // unique to this invocation; retry cleanup, never replay the protected work.
    for (let attempt = 0; ; attempt++) {
      try {
        try { await fsUnlink(resolve(participant, "ticket")); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
        rmdirSync(participant); break;
      } catch (error: any) {
        if (error?.code === "ENOENT") break;
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error?.code) || attempt >= 5) throw error;
        await new Promise(resolve => setTimeout(resolve, MEMO_LOCK_RETRY_MS));
      }
    }
  }
}

async function removeOwnedMemoLock(lockPath: string, identity: { dev: bigint; ino: bigint }, token: string, allowPartial = false): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const matches = (st: { dev: bigint; ino: bigint; isFile(): boolean; isSymbolicLink(): boolean }) => st.isFile() && !st.isSymbolicLink()
        && st.dev === identity.dev && st.ino === identity.ino;
      if (!matches(lstatSync(lockPath, { bigint: true }))) return;
      const current = await fsOpen(lockPath, "r");
      try {
        if (!matches(await current.stat({ bigint: true }))) return;
        const bytes = Buffer.alloc(128);
        const { bytesRead } = await current.read(bytes, 0, bytes.length, 0);
        const actual = bytes.subarray(0, bytesRead).toString("utf8");
        if (allowPartial ? !token.startsWith(actual) : actual !== token) return;
      } finally { await current.close(); }
      if (matches(lstatSync(lockPath, { bigint: true }))) await fsUnlink(lockPath);
      return;
    } catch (error: any) {
      if (error?.code === "ENOENT") return;
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error?.code) || attempt >= 5) throw error;
      await new Promise(resolve => setTimeout(resolve, MEMO_LOCK_RETRY_MS));
    }
  }
}

async function acquireMemoLock(cwd: string): Promise<() => Promise<void>> {
  const lockPath = resolve(cwd, ".memo.lock");
  const start = performance.now();
  let permissionRetries = 0;
  while (performance.now() - start < MEMO_LOCK_TIMEOUT_MS) {
    let opened = false;
    try {
      const fh = await fsOpen(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      );
      opened = true;
      let identity: { dev: bigint; ino: bigint } | undefined;
      const token = `${process.pid}\n${randomUUID()}\n`;
      try {
        try { identity = await fh.stat({ bigint: true }); await fh.writeFile(token); } finally { await fh.close(); }
      } catch (failure) {
        if (!identity) throw new Error(`memo lock ownership could not be verified; .memo.lock may remain. No memory was written by this request. Inspect .memo.lock before retrying: ${String(failure)}`, { cause: failure });
        if (identity) {
          try { await removeOwnedMemoLock(lockPath, identity, token, true); }
          catch (cleanup) { throw new AggregateError([failure, cleanup], "memo lock initialization and cleanup failed"); }
        }
        throw failure;
      }
      const ownedIdentity = identity;
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await removeOwnedMemoLock(lockPath, ownedIdentity, token);
      };
    } catch (e) {
      // Windows can report EPERM while an unlinked lock's last handle is
      // closing. Retry only creation, briefly; persistent ACL errors still fail.
      if (!opened && process.platform === "win32" && (e as NodeJS.ErrnoException)?.code === "EPERM"
          && permissionRetries++ < 5) {
        await new Promise((resolve) => setTimeout(resolve, MEMO_LOCK_RETRY_MS));
        continue;
      }
      if (opened || (e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
      permissionRetries = 0;
      try {
        const st = await fsStat(lockPath);
        if (Date.now() - st.mtimeMs > STALE_MEMO_LOCK_MS) {
          await withMemoRecovery(cwd, start + MEMO_LOCK_TIMEOUT_MS, async () => {
            try {
              const latest = lstatSync(lockPath);
              if (!latest.isFile() || latest.isSymbolicLink()) throw new Error("memo lock must be a regular file");
              if (Date.now() - latest.mtimeMs > STALE_MEMO_LOCK_MS && await memoLockOwnerDefinitelyDead(lockPath)) await fsUnlink(lockPath);
            } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
          });
        }
      } catch (error: any) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      await new Promise((r) => setTimeout(r, MEMO_LOCK_RETRY_MS + Math.random() * 30));
    }
  }
  throw new Error(`could not acquire memo lock at ${lockPath} within ${MEMO_LOCK_TIMEOUT_MS}ms`);
}

// Manual edits and recovery can reorder records. Use the highest valid ID,
// with a bounded strict UTF-8 record scan rather than trusting the last line.
type MemoStorageSnapshot = { identity: string; key: string; size: number };
function memoStorageInfo(info: import("node:fs").BigIntStats): MemoStorageSnapshot {
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("memo storage must be a regular file");
  if (BigInt(info.nlink) !== 1n) throw new Error("memo storage must not have hardlink aliases");
  return { identity: [info.dev, info.ino].join(":"), key: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":"), size: Number(info.size) };
}
function memoStorageSnapshot(path: string): MemoStorageSnapshot | null {
  try { return memoStorageInfo(lstatSync(path, { bigint: true })); }
  catch (error: any) { if (error?.code === "ENOENT") return null; throw error; }
}
function requireMemoSnapshot(path: string, expected: MemoStorageSnapshot | null): void {
  if (memoStorageSnapshot(path)?.key !== expected?.key) throw new Error("memo storage changed during append preparation");
}
async function readMemoAppendState(cwd: string, visit?: (memo: Memo) => void): Promise<{ highest: number; separator: string; size: number; snapshot: MemoStorageSnapshot | null }> {
  const path = resolve(cwd, ".memo.jsonl"), snapshot = memoStorageSnapshot(path);
  if (!snapshot) return { highest: 0, separator: "", size: 0, snapshot: null };
  if (snapshot.size > MAX_READ_BYTES) throw new Error("memo storage exceeds 100 MiB limit");
  let highest = 0, consumed = 0, lastByte = -1;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const accept = (bytes: Uint8Array) => {
    if (!bytes.length) return;
    const line = decoder.decode(bytes); // Invalid UTF-8 is never a skippable JSON record.
    // Only objects can allocate IDs; avoid parser exceptions for blank lines.
    if (!line.trimStart().startsWith("{")) return;
    let m: Memo;
    try { m = parseMcpJson(line); }
    catch { return; } // Preserve malformed JSON lines without allocating an ID.
    if (m && Number.isSafeInteger(m.id) && m.id > 0 && Number.isSafeInteger(m.ts)
        && m.ts >= 0 && typeof m.memo === "string") {
      highest = Math.max(highest, m.id);
      visit?.(m);
    }
  };
  const fh = await fsOpen(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    if (memoStorageInfo(await fh.stat({ bigint: true })).key !== snapshot.key)
      throw new Error("memo storage changed during read");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let parts: Buffer[] = [], partBytes = 0;
    while (true) {
      const { bytesRead } = await fh.read(buffer, 0, Math.min(buffer.length, snapshot.size - consumed + 1), consumed);
      if (!bytesRead) break;
      consumed += bytesRead;
      if (consumed > snapshot.size) throw new Error("memo storage changed during read");
      lastByte = buffer[bytesRead - 1];
      const chunk = buffer.subarray(0, bytesRead);
      let start = 0;
      while (start < bytesRead) {
        const i = chunk.indexOf(10, start);
        if (i < 0) break;
        const segment = chunk.subarray(start, i);
        if (parts.length) {
          parts.push(segment); accept(Buffer.concat(parts, partBytes + segment.length));
          parts = []; partBytes = 0;
        } else accept(segment);
        start = i + 1;
      }
      if (start < bytesRead) { const part = Buffer.from(buffer.subarray(start, bytesRead)); parts.push(part); partBytes += part.length; }
    }
    if (parts.length) accept(Buffer.concat(parts, partBytes));
    if (consumed !== snapshot.size || memoStorageInfo(await fh.stat({ bigint: true })).key !== snapshot.key)
      throw new Error("memo storage changed during read");
  } finally { await fh.close(); }
  requireMemoSnapshot(path, snapshot);
  return { highest, separator: consumed && lastByte !== 10 ? "\n" : "", size: snapshot.size, snapshot };
}

async function rollbackMemoAppend(fh: Awaited<ReturnType<typeof fsOpen>>, path: string, opened: MemoStorageSnapshot, size: number, data: Buffer): Promise<void> {
  // Windows append handles cannot truncate; bind a separate repair handle to
  // the same identity before checking or removing this append.
  const repair = await fsOpen(path, fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const current = memoStorageInfo(await repair.stat({ bigint: true }));
    if (memoStorageInfo(await fh.stat({ bigint: true })).key !== current.key)
      throw new Error("memo append recovery refused: handle identity changed");
    const extra = current.size - size;
    if (current.identity !== opened.identity || extra < 0 || extra > data.length)
      throw new Error("memo append recovery refused: file identity or size changed");
    requireMemoSnapshot(path, current);
    const buffer = Buffer.alloc(Math.min(64 * 1024, extra));
    for (let offset = 0; offset < extra;) {
      const { bytesRead } = await repair.read(buffer, 0, Math.min(buffer.length, extra - offset), size + offset);
      if (!bytesRead || !buffer.subarray(0, bytesRead).equals(data.subarray(offset, offset + bytesRead)))
        throw new Error("memo append recovery refused: appended bytes changed");
      offset += bytesRead;
    }
    if (memoStorageInfo(await fh.stat({ bigint: true })).key !== current.key
        || memoStorageInfo(await repair.stat({ bigint: true })).key !== current.key)
      throw new Error("memo append recovery refused: file changed while checking");
    requireMemoSnapshot(path, current);
    if (extra) await repair.truncate(size);
    await repair.sync();
  } finally { await repair.close(); }
}

// ---------- guide ----------
// Renders an XML-block operating manual for the agent. Reflects live state
// of this server (enabled tools, memos in cwd, project docs, external MCP
// servers). Called by the `guide` tool.

function xmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function collectMemoState(cwd: string): Promise<{ count: number; latest: string | null; lockHeld: boolean }> {
  const selected = await selectRecallPage(cwd, undefined, undefined, 1, 0);
  const memos = selected.page;
  let latest: string | null = null;
  if (memos.length) {
    const newest = memos.reduce((a, b) => (a.id >= b.id ? a : b));
    const ts = formatMemoTimestamp(newest.ts);
    const tagStr = newest.tags?.length ? `, tags=[${newest.tags.join(",")}]` : "";
    latest = `${ts}${tagStr}`;
  }
  let lockHeld = false;
  try {
    const path = resolve(cwd, ".memo.lock"), st = lstatSync(path);
    // Age cannot prove that a writer exited. Unknown ownership stays conservative.
    lockHeld = !st.isFile() || !await memoLockOwnerDefinitelyDead(path);
  } catch (error: any) { lockHeld = error?.code !== "ENOENT"; }
  return { count: selected.total, latest, lockHeld };
}

async function collectProjectDocs(cwd: string): Promise<string[]> {
  const docs: string[] = [];
  for (const name of ["CLAUDE.md", "README.md"]) {
    try {
      const st = await fsStat(resolve(cwd, name));
      if (st.isFile()) docs.push(name);
    } catch { /* not present */ }
  }
  return docs;
}

// Lightweight scan of <cwd>/.mcp.json for the guide block: name + transport only.
// Lenient (e.g. accepts http://localhost URLs) because the guide is informational;
// the strict validation happens when the mcp tool actually loads the server.
async function collectLoadableServers(cwd: string): Promise<Array<{ ns: string; transport: "stdio" | "http" }>> {
  try {
    const raw = await readMcpConfigText(resolve(cwd, ".mcp.json"));
    const parsed = parseMcpJson(raw);
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== "object") return [];
    const out: Array<{ ns: string; transport: "stdio" | "http" }> = [];
    for (const [ns, cfg] of Object.entries(servers as Record<string, any>)) {
      if (!NAMESPACE_RE.test(ns)) continue;
      if (!cfg || typeof cfg !== "object") continue;
      const transport: "stdio" | "http" = cfg.type === "http" ? "http" : "stdio";
      if (transport === "http" && typeof cfg.url !== "string") continue;
      if (transport === "stdio" && typeof cfg.command !== "string") continue;
      out.push({ ns, transport });
    }
    return out.sort((a, b) => a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : 0);
  } catch { return []; }
}

function listExternalServers(): Array<{ ns: string; tools: string[] }> {
  // Source of truth: aggregatorKnownServers (declared in --mcp config).
  // Tool names come from aggregatedTools (only populated for probed servers).
  const probedByNs = new Map<string, string[]>();
  for (const [, tool] of aggregatedTools) {
    const list = probedByNs.get(tool.namespace) ?? [];
    list.push(tool.originalName);
    probedByNs.set(tool.namespace, list);
  }
  return [...aggregatorKnownServers].sort().map((ns) => ({
    ns,
    tools: (probedByNs.get(ns) ?? []).slice().sort(),
  }));
}

async function renderGuide(cwd: string): Promise<string> {
  const lines: string[] = [];
  lines.push(`<guide tool="code-mcp">`);
  lines.push("");

  const canRecall = Object.hasOwn(tools, "recall"), canRemember = Object.hasOwn(tools, "remember"), canForget = Object.hasOwn(tools, "forget");
  const canMcp = Object.hasOwn(tools, "mcp");
  const memoState = canRecall ? await collectMemoState(cwd) : null;
  const docs = Object.hasOwn(tools, "read") ? await collectProjectDocs(cwd) : [];

  // state block
  lines.push(`<state cwd="${xmlAttr(cwd)}">`);
  if (memoState) {
    const latest = memoState.latest ? ` (latest ${xmlAttr(memoState.latest)})` : "";
    lines.push(`memos: ${memoState.count}${latest}`);
    lines.push(`concurrent_writer: ${memoState.lockHeld ? "yes" : "no"}`);
  }
  if (docs.length) {
    lines.push(`project_docs: ${docs.join(", ")}  (read for project rules)`);
  }
  lines.push(`</state>`);

  // session_start
  if (canRecall || docs.length) {
    lines.push("");
    lines.push(`<session_start>`);
    let step = 1;
    if (canRecall) lines.push(`${step++}. call recall(cwd) first to load prior memos`);
    if (docs.length) lines.push(`${step++}. read ${docs.join(" and ")} for project rules`);
    if (canRecall) lines.push(`${step++}. "(no matches)" from recall = fresh session`);
    lines.push(`</session_start>`);
  }

  if (canRemember) {
    lines.push("");
    lines.push(`<when_to_remember>`);
    lines.push(`- user signals handoff (e.g. "handoff", "wrap up"): tags=["handoff"],`);
    lines.push(`  include file paths, last action, next step`);
    lines.push(`- design or architectural decisions: tags=["decision"]`);
    lines.push(`- non-obvious behaviors, surprising bugs: tags=["gotcha"]`);
    lines.push(`- followups: tags=["todo"]`);
    lines.push(`</when_to_remember>`);

    lines.push("");
  }
  if (canRecall || canRemember || canForget) {
    lines.push(`<memory_rules>`);
    lines.push(`- memos are private to this cwd; never access the storage file directly,`);
    lines.push(`  use the enabled memory tools listed below`);
    if (canRecall) lines.push(`- tags are case-insensitive; multiple tags = AND filter`);
    if (canRemember) lines.push(`- non-string tags are dropped on write`);
    lines.push(`- multiple agents on the same cwd are serialized automatically`);
    if (canRecall) lines.push(`- recall: limit default 20 (max 1000), offset default 0`);
    if (canRecall) lines.push(`- paging past end returns "(no matches at offset=N; total=M)"`);
    lines.push(`</memory_rules>`);
  }

  // tools block
  lines.push("");
  lines.push(`<tools>`);
  const builtin = Object.keys(tools).sort().join(", ");
  lines.push(`built-in: ${builtin}`);
  const externals = canMcp ? listExternalServers() : [];
  const loadable = canMcp ? await collectLoadableServers(cwd) : [];
  const loadableSet = new Set(loadable.map((l) => l.ns));
  const externalsSet = new Set(externals.map((e) => e.ns));
  if (externals.length) {
    lines.push(`external (via mcp tool, prefix "<server>__<tool>"):`);
    const nsWidth = Math.max(...externals.map((e) => e.ns.length));
    for (const e of externals) {
      const padded = e.ns.padEnd(nsWidth);
      const alsoNote = loadableSet.has(e.ns) ? "  [also in .mcp.json]" : "";
      if (e.tools.length) {
        const preview = e.tools.slice(0, 6).join(", ");
        const hint = e.tools.length > 6 ? `${preview}, ... (${e.tools.length} total)` : preview;
        lines.push(`- ${padded}  tools: ${xmlAttr(hint)}${alsoNote}`);
      } else {
        lines.push(`- ${padded}  (tools not yet probed; call mcp(action="list") to discover)${alsoNote}`);
      }
    }
    lines.push(`call mcp(action="list") for full schemas of external tools.`);
  }
  const loadableOnly = loadable.filter((l) => !externalsSet.has(l.ns));
  if (loadableOnly.length) {
    if (externals.length) lines.push("");
    lines.push(`loadable (via mcp tool from .mcp.json in cwd):`);
    const lWidth = Math.max(...loadableOnly.map((l) => l.ns.length));
    for (const l of loadableOnly) {
      lines.push(`- ${l.ns.padEnd(lWidth)}  ${l.transport}`);
    }
    lines.push(`call mcp(action="list", server="<name>") to load tools on demand.`);
  }
  lines.push(`</tools>`);

  // cheat_sheet
  lines.push("");
  lines.push(`<cheat_sheet>`);
  if (canRecall) {
    lines.push(`recall(cwd)`);
    lines.push(`recall(cwd, query="webhook")`);
    lines.push(`recall(cwd, tags=["decision"], limit=5)`);
  }
  if (canRemember) lines.push(`remember(cwd, "fixed bug at file.py:42", tags=["bug","fix"])`);
  if (canForget) lines.push(`forget(cwd, 7)`);
  lines.push(`guide(cwd)`);
  if (externals.length) lines.push(`mcp(action="list")`);
  if (loadableOnly.length) lines.push(`mcp(action="list", server="${loadableOnly[0].ns}")`);
  lines.push(`</cheat_sheet>`);

  lines.push("");
  lines.push(`</guide>`);
  return lines.join("\n");
}

// ---------- upload page ----------
// Full HTML page served at GET /upload/<session_id>. The page embeds a drop
// zone that POSTs back to the same URL. Auth lives in the URL path.
const UPLOAD_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Upload to local machine</title>
<style>
  :root {
    --bg: #faf9f5;
    --surface: #ffffff;
    --text-primary: #181818;
    --text-secondary: #6b6b63;
    --text-tertiary: #96958b;
    --text-info: #2d5fb3;
    --text-success: #0f6e56;
    --text-warning: #854f0b;
    --text-danger: #a32d2d;
    --border-tertiary: rgba(24, 24, 24, 0.08);
    --border-secondary: rgba(24, 24, 24, 0.16);
    --border-info: rgba(45, 95, 179, 0.3);
    --bg-info: rgba(45, 95, 179, 0.06);
    --bg-tertiary: #f1efe8;
    --radius-md: 8px;
    --radius-lg: 12px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text-primary);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 16px;
    line-height: 1.5;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem 1rem;
  }
  .container {
    width: 100%;
    max-width: 560px;
  }
  .dropzone {
    display: block;
    background: transparent;
    border: 0.5px dashed var(--border-secondary);
    border-radius: var(--radius-lg);
    padding: 2rem 1.25rem;
    text-align: center;
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease;
    user-select: none;
    -webkit-user-select: none;
    -webkit-tap-highlight-color: transparent;
  }
  .dropzone:hover {
    background: var(--bg-info);
    border-color: var(--border-info);
  }
  .dropzone.hover {
    background: var(--bg-info);
    border-color: var(--border-info);
  }
  .dropzone.disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
  .dropzone .icon { display: flex; justify-content: center; margin-bottom: 12px; color: var(--text-secondary); }
  .dropzone .title { margin: 0; font-size: 14px; color: var(--text-primary); }
  .dropzone .browse { color: var(--text-info); text-decoration: underline; }
  .file-list { margin-top: 0.75rem; display: none; flex-direction: column; gap: 6px; }
  .file-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px;
    background: var(--surface);
    border: 0.5px solid var(--border-tertiary);
    border-radius: var(--radius-md);
  }
  .file-row .info { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex: 1; }
  .file-row .name { font-size: 13px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-row .size { font-size: 12px; color: var(--text-tertiary); flex-shrink: 0; }
  .file-row button {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text-tertiary);
    background: transparent;
    border: none;
    cursor: pointer;
    border-radius: 4px;
  }
  .file-row button:hover { background: var(--bg-tertiary); color: var(--text-primary); }
  .file-row button:disabled { cursor: not-allowed; opacity: 0.4; }
  .progress-wrap { margin-top: 0.75rem; display: none; }
  .progress-track {
    background: var(--bg-tertiary);
    border-radius: 999px;
    height: 4px;
    overflow: hidden;
  }
  .progress-bar {
    height: 100%;
    width: 0%;
    background: var(--text-info);
    transition: width 120ms ease;
  }
  .progress-message { margin: 8px 0 0; font-size: 12px; color: var(--text-secondary); }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 0.75rem; }
  .actions button {
    font-family: inherit;
    font-size: 14px;
    padding: 8px 16px;
    background: transparent;
    color: var(--text-primary);
    border: 0.5px solid var(--border-secondary);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: background 100ms ease, transform 100ms ease;
  }
  .actions button:hover:not(:disabled) { background: var(--bg-tertiary); }
  .actions button:active:not(:disabled) { transform: scale(0.98); }
  .actions button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
</head>
<body>
  <div class="container">
    <input type="file" id="file-input" multiple style="position: absolute; left: -9999px; width: 1px; height: 1px; opacity: 0;" />
    <label id="dropzone" class="dropzone" for="file-input">
      <div class="icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
      </div>
      <p class="title">Drop files here, or <span class="browse">browse</span></p>
    </label>

    <div id="file-list" class="file-list"></div>

    <div id="progress-wrap" class="progress-wrap">
      <div class="progress-track"><div id="progress-bar" class="progress-bar"></div></div>
      <p id="progress-message" class="progress-message"></p>
    </div>

    <div class="actions">
      <button id="cancel-btn">Cancel</button>
      <button id="upload-btn" disabled>Upload</button>
    </div>
  </div>

<script data-cfasync="false">
(function () {
  var dropzone = document.getElementById('dropzone');
  var fileInput = document.getElementById('file-input');
  var fileList = document.getElementById('file-list');
  var progressWrap = document.getElementById('progress-wrap');
  var progressBar = document.getElementById('progress-bar');
  var progressMessage = document.getElementById('progress-message');
  var uploadBtn = document.getElementById('upload-btn');
  var cancelBtn = document.getElementById('cancel-btn');

  var UPLOAD_URL = window.location.href;

  var queue = [];
  var uploading = false;
  var cancelled = false;
  var currentXhr = null;
  var finished = false;

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  function setBtn(btn, enabled) {
    btn.disabled = !enabled;
  }

  function refreshButtons() {
    if (finished) {
      setBtn(uploadBtn, false);
      setBtn(cancelBtn, false);
      return;
    }
    setBtn(uploadBtn, !uploading && queue.length > 0);
    setBtn(cancelBtn, true);
  }

  function renderList() {
    if (queue.length === 0) {
      fileList.style.display = 'none';
      fileList.innerHTML = '';
      refreshButtons();
      return;
    }
    fileList.style.display = 'flex';
    fileList.innerHTML = '';
    queue.forEach(function (file, idx) {
      var row = document.createElement('div');
      row.className = 'file-row';

      var info = document.createElement('div');
      info.className = 'info';
      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = file.name;
      var size = document.createElement('span');
      size.className = 'size';
      size.textContent = fmtBytes(file.size);
      info.appendChild(name);
      info.appendChild(size);

      var remove = document.createElement('button');
      remove.setAttribute('aria-label', 'Remove ' + file.name);
      remove.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      remove.disabled = uploading || finished;
      remove.addEventListener('click', function (e) {
        e.stopPropagation();
        if (uploading || finished) return;
        queue.splice(idx, 1);
        renderList();
      });

      row.appendChild(info);
      row.appendChild(remove);
      fileList.appendChild(row);
    });
    refreshButtons();
  }

  function addFiles(files) {
    if (uploading || finished) return;
    for (var i = 0; i < files.length; i++) queue.push(files[i]);
    renderList();
  }

  function uploadOne(file, onProgress) {
    return new Promise(function (resolve) {
      var xhr = new XMLHttpRequest();
      currentXhr = xhr;
      var form = new FormData();
      form.append('file', file);

      xhr.upload.addEventListener('progress', function (e) {
        if (e.lengthComputable) onProgress(e.loaded, e.total);
      });
      xhr.addEventListener('load', function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          var body = {};
          try { body = JSON.parse(xhr.responseText); } catch (e) {}
          resolve({ ok: true, path: body.path || file.name, file: file });
        } else {
          resolve({ ok: false, status: xhr.status, file: file });
        }
      });
      xhr.addEventListener('error', function () {
        resolve({ ok: false, networkError: true, file: file });
      });
      xhr.addEventListener('abort', function () {
        resolve({ ok: false, aborted: true, file: file });
      });
      xhr.open('POST', UPLOAD_URL);
      xhr.send(form);
    });
  }

  function disableAll() {
    finished = true;
    dropzone.classList.add('disabled');
    fileInput.disabled = true;
    refreshButtons();
    // re-render list so the remove buttons get disabled
    renderList();
  }

  function runUpload() {
    if (uploading || queue.length === 0) return;
    uploading = true;
    cancelled = false;
    refreshButtons();
    progressWrap.style.display = 'block';
    progressBar.style.background = 'var(--text-info)';
    progressBar.style.width = '0%';
    progressMessage.style.color = 'var(--text-secondary)';

    var files = queue.slice();
    var totalBytes = files.reduce(function (s, f) { return s + f.size; }, 0);
    var completedBytes = 0;
    var results = [];

    function next(i) {
      if (cancelled || i >= files.length) return finish(results, files, i);
      var f = files[i];
      progressMessage.textContent = 'Uploading ' + f.name + ' (' + (i + 1) + '/' + files.length + ')';
      uploadOne(f, function (loaded) {
        var pct = totalBytes === 0 ? 0 : ((completedBytes + loaded) / totalBytes) * 100;
        progressBar.style.width = pct + '%';
      }).then(function (res) {
        completedBytes += f.size;
        results.push(res);
        next(i + 1);
      });
    }

    function finish(results, allFiles, stoppedAt) {
      uploading = false;
      currentXhr = null;
      var ok = results.filter(function (r) { return r.ok; });
      var failed = results.filter(function (r) { return !r.ok && !r.aborted; });

      progressBar.style.width = '100%';

      if (cancelled) {
        progressBar.style.background = 'var(--text-warning)';
        progressMessage.textContent = 'Cancelled — ' + ok.length + ' uploaded before stop';
        progressMessage.style.color = 'var(--text-warning)';
      } else if (failed.length === 0) {
        progressBar.style.background = 'var(--text-success)';
        progressMessage.textContent = 'Uploaded ' + ok.length + ' file' + (ok.length === 1 ? '' : 's') + '. Tell Claude where they landed:';
        progressMessage.style.color = 'var(--text-success)';
      } else {
        progressBar.style.background = 'var(--text-danger)';
        progressMessage.textContent = ok.length + ' uploaded, ' + failed.length + ' failed';
        progressMessage.style.color = 'var(--text-danger)';
      }

      if (ok.length > 0) {
        var summaryWrap = document.createElement('div');
        summaryWrap.style.cssText = 'position: relative; margin-top: 12px;';
        var summary = document.createElement('pre');
        summary.style.cssText = 'margin: 0; padding: 12px 40px 12px 12px; background: var(--bg-tertiary); border-radius: var(--radius-md); font-size: 12px; font-family: ui-monospace, "SF Mono", Menlo, monospace; color: var(--text-primary); white-space: pre-wrap; overflow-wrap: anywhere;';
        var text = ok.map(function (r) { return r.path; }).join('\\n');
        summary.textContent = text;
        var copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.setAttribute('aria-label', 'Copy paths');
        copyBtn.style.cssText = 'position: absolute; top: 8px; right: 8px; width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; color: var(--text-tertiary); background: transparent; border: none; cursor: pointer; border-radius: 4px;';
        copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
        copyBtn.addEventListener('mouseenter', function () { copyBtn.style.background = 'var(--surface)'; copyBtn.style.color = 'var(--text-primary)'; });
        copyBtn.addEventListener('mouseleave', function () { copyBtn.style.background = 'transparent'; copyBtn.style.color = 'var(--text-tertiary)'; });
        copyBtn.addEventListener('click', function () {
          var done = function () {
            var prev = copyBtn.innerHTML;
            copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
            copyBtn.style.color = 'var(--text-success)';
            setTimeout(function () { copyBtn.innerHTML = prev; copyBtn.style.color = 'var(--text-tertiary)'; }, 1500);
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done).catch(function () {});
          } else {
            // fallback for older browsers / non-secure contexts
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position: fixed; left: -9999px;';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); done(); } catch (err) {}
            document.body.removeChild(ta);
          }
        });
        summaryWrap.appendChild(summary);
        summaryWrap.appendChild(copyBtn);
        progressWrap.appendChild(summaryWrap);
      }

      // clear queue, disable the page
      queue = [];
      fileList.style.display = 'none';
      fileList.innerHTML = '';
      disableAll();
    }

    next(0);
  }

  function runCancel() {
    if (uploading) {
      cancelled = true;
      if (currentXhr) try { currentXhr.abort(); } catch (e) {}
    } else {
      queue = [];
      progressWrap.style.display = 'none';
      renderList();
      progressMessage.textContent = 'Upload cancelled.';
      progressMessage.style.color = 'var(--text-warning)';
      progressWrap.style.display = 'block';
      progressBar.style.background = 'var(--text-warning)';
      progressBar.style.width = '100%';
      disableAll();
    }
  }

  dropzone.addEventListener('click', function (e) {
    // <label for="file-input"> handles the click natively. JS click() is
    // unreliable on mobile browsers — we let the label do its job.
    if (uploading || finished) e.preventDefault();
  });
  fileInput.addEventListener('change', function (e) {
    var files = e.target.files || fileInput.files;
    if (files && files.length) {
      // copy FileList to array — some mobile browsers invalidate it after value reset
      var arr = [];
      for (var i = 0; i < files.length; i++) arr.push(files[i]);
      addFiles(arr);
    }
    fileInput.value = '';
  });
  dropzone.addEventListener('dragover', function (e) { e.preventDefault(); if (!uploading && !finished) dropzone.classList.add('hover'); });
  dropzone.addEventListener('dragleave', function () { dropzone.classList.remove('hover'); });
  dropzone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropzone.classList.remove('hover');
    if (uploading || finished) return;
    if (e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  uploadBtn.addEventListener('click', runUpload);
  cancelBtn.addEventListener('click', runCancel);
})();
</script>
</body>
</html>
`;

function renderUploadPage(): string {
  return UPLOAD_PAGE_HTML;
}

// ---------- mcp aggregator ----------
// Spawn external MCP servers (stdio transport) and forward tool calls to them.
// Tools are exposed to clients with a "<namespace>__" prefix to avoid collisions
// (Anthropic's tool name regex disallows ":", so we use double underscore).
// Lazy spawn + per-server idle timeout. Tool list is probed once at startup
// and cached (so tools/list works without keeping every subprocess alive).

type StdioServerConfig = {
  type?: "stdio"; // default
  command: string;
  args?: string[];
  env?: Record<string, string>;
  idleTimeoutMs?: number;
};

type HttpServerConfig = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  // idleTimeoutMs is accepted but ignored for HTTP (no subprocess to stop).
  idleTimeoutMs?: number;
};

type McpServerConfig = StdioServerConfig | HttpServerConfig;

type AggregatedTool = {
  definition?: Json;
  namespace: string;
  originalName: string;
  description: string;
  inputSchema: Json;
};

// Common fields for both transports.
type BaseServerState = {
  nextId: number;
  initialized: boolean;
  initPromise: Promise<void> | null;
  isProbe: boolean;
  unloaded: boolean;
  activeRequests: Set<AbortController>;
  setupDeadline: number | null;
  cacheKey?: string;
  configSignature?: string;
};

type StdioServerState = BaseServerState & {
  transport: "stdio";
  cwd?: string;
  config: StdioServerConfig;
  proc: ReturnType<typeof spawn> | null;
  stdoutChunks: Buffer[];
  stdoutBytes: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleUsers: number;
  stderrLogPath: string;
  // Outstanding RPC calls: id -> resolver. Only stdio needs this because
  // responses arrive interleaved on a single stream. HTTP responses come
  // back as the body of the originating fetch() and don't need routing.
  pending: Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>;
};

type HttpServerState = BaseServerState & {
  transport: "http";
  config: HttpServerConfig;
  sessionId: string | null; // Mcp-Session-Id assigned by server after initialize
  protocolVersion: string | null;
};

type ServerState = StdioServerState | HttpServerState;

// Require the actual end of input (JavaScript $ also accepts a final newline).
const NAMESPACE_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}(?![\s\S])/;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const SUBPROCESS_CALL_TIMEOUT_MS = 90_000;
const MCP_HTTP_CONTROL_TIMEOUT_MS = 30_000;
const MCP_HTTP_CALL_TIMEOUT_MS = 90_000;
const MAX_JOBS = 10;

function safeResolve(cwd: string, userPath: string, allowSpill = false): { ok: true; path: string } | { ok: false; reason: string } {
  const cwdResolved = resolve(cwd);
  try {
    const p = resolve(cwdResolved, userPath);
    let base: string;
    try { base = realpathSync(cwdResolved); } catch { base = cwdResolved; } // cwd missing: fall back to lexical base
    // path.resolve() is lexical: a symlinked INTERMEDIATE directory could
    // smuggle the target outside the cwd. Real-path the deepest existing
    // ancestor, re-append the non-existent tail, then enforce the boundary.
    let probe: string = p;
    const tail: string[] = [];
    let real: string | null = null;
    for (;;) {
      try { real = realpathSync(probe); break; }
      catch {
        const parent = dirname(probe);
        if (parent === probe) break;
        tail.unshift(basename(probe));
        probe = parent;
      }
    }
    const final = real !== null ? resolve(real, ...tail) : p;
    if (final !== base && !final.startsWith(base + sep)) {
      // Spill files live under RESULT_SPILL_ROOT, outside cwd. read/grep must
      // reach them because spill markers point callers at that path.
      if (allowSpill) {
        let spillBase: string;
        try { spillBase = realpathSync(RESULT_SPILL_ROOT); } catch { spillBase = RESULT_SPILL_ROOT; }
        if (final === spillBase || final.startsWith(spillBase + sep)) return { ok: true, path: final };
      }
      return { ok: false, reason: `path escapes cwd: ${userPath}` };
    }
    return { ok: true, path: final };
  } catch {
    return { ok: false, reason: `invalid path: ${userPath}` };
  }
}


// Preserve filesystem security metadata when replacing an existing file.
// Native file copy retains metadata not exposed by Node APIs (macOS ACLs and
// NTFS named streams). Linux can copy attributes without copying old file data.
async function copyWriteMetadata(source: string, target: string): Promise<void> {
  let argv: string[];
  let metadataPaths: { CODE_MCP_METADATA_SOURCE: string; CODE_MCP_METADATA_TARGET: string } | undefined;
  if (process.platform === "win32") {
    // Keep the script static and paths as child-only data. Nested encoded
    // scripts trigger Windows security heuristics and are unnecessary here.
    const script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $s=$env:CODE_MCP_METADATA_SOURCE; $d=$env:CODE_MCP_METADATA_TARGET; Copy-Item -LiteralPath $s -Destination $d -Force; $acl=Get-Acl -LiteralPath $s; Set-Acl -LiteralPath $d -AclObject $acl";
    metadataPaths = { CODE_MCP_METADATA_SOURCE: source, CODE_MCP_METADATA_TARGET: target };
    const bin = POWERSHELL_BIN ?? resolve(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    argv = [bin, "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-Command", script];
  } else if (process.platform === "darwin") {
    argv = ["/bin/cp", "-p", source, target];
  } else if (process.platform === "linux") {
    argv = ["/bin/cp", "--attributes-only", "--preserve=mode,ownership,timestamps,xattr", "--", source, target];
  } else {
    throw new Error("atomic overwrite metadata preservation is unsupported on this platform");
  }
  const child = spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe",
    env: metadataPaths ? { ...process.env, ...metadataPaths } : process.env });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const [status, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (status !== 0) throw new Error(`cannot preserve destination metadata: ${error.trim() || `exit ${status}`}`);
  } finally { clearTimeout(timeout); }
}

// Bun normalizes `symlink/..` before realpath, so resolve each component
// separately to match native filesystem/Python/Java physical path semantics.
function physicalPath(input: string, allowMissing: boolean): string {
  const absolute = isAbsolute(input) ? input : `${process.cwd()}${sep}${input}`;
  const root = parsePath(absolute).root;
  let current = root;
  const parts = absolute.slice(root.length).split(process.platform === "win32" ? /[\\/]/ : /\//);
  for (const part of parts) {
    if (!part) continue;
    try {
      if (!statSync(current).isDirectory()) throw new Error("write parent is not a directory");
    } catch (e: any) { if (!allowMissing || e?.code !== "ENOENT") throw e; }
    if (part === ".") continue;
    if (part === "..") { current = dirname(current); continue; }
    const candidate = resolve(current, part);
    try { lstatSync(candidate); }
    catch (e: any) {
      if (!allowMissing || e?.code !== "ENOENT") throw e;
      current = candidate;
      continue;
    }
    current = realpathSync(candidate); // Existing dangling links must fail.
  }
  return current;
}

// Internal optimistic guard connecting Edit's read to Write's initial
// snapshot. Tool arguments cannot supply this guard or disable its checks.
type FileSnapshot = { path: string; stat: ReturnType<typeof lstatSync> };
function verifyFileSnapshot(expected: FileSnapshot, path: string, actual: ReturnType<typeof lstatSync> | undefined): void {
  const before = expected.stat;
  if (path !== expected.path || !actual?.isFile() || before.dev !== actual.dev || before.ino !== actual.ino
    || before.mode !== actual.mode || before.size !== actual.size || before.mtimeMs !== actual.mtimeMs || before.ctimeMs !== actual.ctimeMs) {
    throw new Error("edit target changed during operation");
  }
}

// Read scans LF-delimited bytes before decoding so unselected invalid UTF-8
// does not affect a range, and a large skipped prefix never accumulates in RAM.
async function readFileText(args: unknown, internal?: { allowSpill?: boolean; expected?: FileSnapshot }): Promise<string> {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("read arguments must be an object");
  const values = args as Record<string, unknown>;
  const { cwd, path, range } = values;
  if (typeof cwd !== "string" || !cwd.length || typeof path !== "string" || !path.length) {
    throw new Error("read requires nonempty cwd/path strings");
  }
  for (const [name, value] of [["cwd", cwd], ["path", path]]) {
    if (value.includes("\0")) throw new Error("invalid path");
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(`${name} contains invalid Unicode`);
      } else if (c >= 0xdc00 && c <= 0xdfff) throw new Error(`${name} contains invalid Unicode`);
    }
  }
  const finalComponent = path.split(process.platform === "win32" ? /[\\/]/ : /\//).at(-1);
  if (!finalComponent || finalComponent === "." || finalComponent === "..") throw new Error("read path must name a file");
  if ("no_truncate" in values && typeof values.no_truncate !== "boolean") throw new Error("no_truncate must be a boolean");
  let start = 1, end = Number.MAX_SAFE_INTEGER;
  const ranged = "range" in values;
  if (ranged) {
    if (!Array.isArray(range) || range.length !== 2 || !range.every(v => typeof v === "number" && Number.isSafeInteger(v) && v >= 1) || range[0] > range[1]) {
      throw new Error("range must be [start,end] with 1 <= start <= end <= 9007199254740991");
    }
    [start, end] = range;
  }
  const base = physicalPath(cwd, false);
  if (!statSync(base).isDirectory()) throw new Error("cwd must be an existing directory");
  const target = physicalPath(isAbsolute(path) ? path : `${base}${sep}${path}`, true);
  const contained = (root: string) => {
    const offset = relative(root, target);
    return offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
  };
  if (!contained(base) && (internal?.allowSpill === false || !contained(physicalPath(RESULT_SPILL_ROOT, false)))) throw new Error("path escapes cwd");
  const before = lstatSync(target);
  if (internal?.expected) verifyFileSnapshot(internal.expected, target, before);
  if (!before.isFile()) throw new Error("not a regular file");
  // Nonblocking + no-follow prevents an obvious FIFO/symlink swap from turning
  // this into an unbounded wait or reading a different destination.
  const handle = await fsOpen(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  try {
    const initial = await handle.stat();
    if (internal?.expected) verifyFileSnapshot(internal.expected, target, initial);
    if (!initial.isFile() || initial.dev !== before.dev || initial.ino !== before.ino) throw new Error("read path changed during operation");
    if (!ranged && initial.size > MAX_READ_BYTES) throw new Error(`file too large (${initial.size} bytes > ${MAX_READ_BYTES}); use a range`);
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const text: string[] = [];
    let selectedBytes = 0;
    const append = (bytes: Uint8Array) => {
      selectedBytes += bytes.byteLength;
      if (selectedBytes > MAX_READ_BYTES) throw new Error(`selected text too large (> ${MAX_READ_BYTES} bytes); use a smaller range`);
      if (bytes.byteLength) text.push(decoder.decode(bytes, { stream: true }));
    };
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0, line = 1, done = false;
    // Regular virtual files may report zero bytes. Probe EOF, but bound the
    // entire scan so a range beyond an unbounded stream cannot run forever.
    const unknownSize = initial.size === 0;
    while ((unknownSize || position < initial.size) && !done) {
      const remaining = unknownSize ? MAX_READ_BYTES + 1 - position : initial.size - position;
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), position);
      if (!bytesRead) {
        if (unknownSize) break;
        throw new Error("file changed during read");
      }
      position += bytesRead;
      if (unknownSize && position > MAX_READ_BYTES) throw new Error("zero-size file exceeded read scan limit");
      if (!ranged) { append(buffer.subarray(0, bytesRead)); continue; }
      let offset = 0, selectedStart = line >= start ? 0 : -1;
      while (offset < bytesRead) {
        const newline = buffer.indexOf(10, offset);
        if (newline < 0 || newline >= bytesRead) break;
        if (line === end) {
          if (selectedStart >= 0) append(buffer.subarray(selectedStart, newline));
          done = true;
          break;
        }
        line++;
        offset = newline + 1;
        if (line === start) selectedStart = offset;
      }
      if (!done && selectedStart >= 0) append(buffer.subarray(selectedStart, bytesRead));
    }
    text.push(decoder.decode());
    const final = await handle.stat();
    if (final.size !== initial.size || final.mtimeMs !== initial.mtimeMs || final.ctimeMs !== initial.ctimeMs) throw new Error("file changed during read");
    return text.join("");
  } finally { await handle.close(); }
}

// Write validates before touching the filesystem, then replaces one complete
// UTF-8 file atomically. Unlike Bun.write, this never follows a dangling link
// or modifies another pathname through an existing hardlink.
async function writeFileAtomic(args: unknown, expected?: FileSnapshot, beforeCommit?: () => void, binaryBytes?: Uint8Array): Promise<string> {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("write arguments must be an object");
  const { cwd, path, content } = args as Record<string, unknown>;
  if (typeof cwd !== "string" || cwd.length === 0 || typeof path !== "string" || path.length === 0 || typeof content !== "string") {
    throw new Error("write requires nonempty cwd/path strings and a content string");
  }
  if (cwd.includes("\0") || path.includes("\0")) throw new Error("invalid path");
  const finalComponent = path.split(process.platform === "win32" ? /[\\/]/ : /\//).at(-1);
  if (!finalComponent || finalComponent === "." || finalComponent === "..") throw new Error("write path must name a file");
  // JS replaces lone UTF-16 surrogates during UTF-8 conversion. Validate paths
  // too, otherwise the filesystem may receive a different filename than asked.
  for (const [name, text] of [["cwd", cwd], ["path", path], ["content", content]]) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = text.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(`${name} contains invalid Unicode`);
      } else if (c >= 0xdc00 && c <= 0xdfff) throw new Error(`${name} contains invalid Unicode`);
    }
  }
  const bytes = binaryBytes ?? Buffer.from(content, "utf8");
  const base = physicalPath(cwd, false);
  if (!statSync(base).isDirectory()) throw new Error("cwd must be an existing directory");
  const lexical = isAbsolute(path) ? path : `${base}${sep}${path}`;
  const resolveTarget = () => {
    const target = physicalPath(lexical, true);
    const offset = relative(base, target);
    if (offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw new Error("path escapes cwd");
    return target;
  };
  const snapshots = new Map<string, ReturnType<typeof lstatSync>>();
  const maybeStat = (p: string) => {
    try { return lstatSync(p); }
    catch (e: any) { if (e?.code === "ENOENT") return undefined; throw e; }
  };
  const sameIdentity = (a: ReturnType<typeof lstatSync>, b: ReturnType<typeof lstatSync>) =>
    a.dev === b.dev && a.ino === b.ino && (a.mode & 0o170000) === (b.mode & 0o170000);
  // Record existing lexical ancestors as well as their resolved counterparts:
  // a caller's contained symlink must not be retargeted halfway through a write.
  const recordAncestors = (start: string) => {
    for (let p = start; ; p = dirname(p)) {
      const st = maybeStat(p);
      if (st) {
        if (st.isSymbolicLink()) realpathSync(p); // dangling links are never write targets
        snapshots.set(p, st);
      }
      if (dirname(p) === p) break;
    }
  };
  recordAncestors(dirname(lexical));
  const lexicalStat = maybeStat(lexical);
  if (lexicalStat?.isSymbolicLink()) {
    realpathSync(lexical);
    snapshots.set(lexical, lexicalStat);
  }
  const target = resolveTarget();
  if (expected) verifyFileSnapshot(expected, target, maybeStat(target));
  if (target === base) throw new Error("not a regular file");
  const parent = dirname(target);
  recordAncestors(parent);
  const verifyAncestors = () => {
    for (const [p, expected] of snapshots) {
      const actual = maybeStat(p);
      if (!actual || !sameIdentity(actual, expected)) throw new Error("write path changed during operation");
    }
    if (resolveTarget() !== target) throw new Error("write path changed during operation");
  };
  // Create missing directories individually, rechecking the known parent chain.
  const missing: string[] = [];
  for (let p = parent; !maybeStat(p); p = dirname(p)) missing.unshift(p);
  for (const p of missing) {
    verifyAncestors();
    try { mkdirSync(p); } catch (e: any) { if (e?.code !== "EEXIST") throw e; }
    const st = lstatSync(p);
    if (!st.isDirectory()) throw new Error("write parent must be a directory");
    snapshots.set(p, st);
  }
  verifyAncestors();
  const original = maybeStat(target);
  if (expected) verifyFileSnapshot(expected, target, original);
  if (original && !original.isFile()) throw new Error("not a regular file");
  if (original && !(original.mode & 0o222)) throw new Error("destination is not writable");
  const verifyTarget = () => {
    const current = maybeStat(target);
    if (original ? !current || !sameIdentity(original, current) || original.size !== current.size || original.mtimeMs !== current.mtimeMs || original.ctimeMs !== current.ctimeMs : current !== undefined) {
      throw new Error("write target changed during operation");
    }
  };
  if (original) {
    // Atomic replacement must not bypass an existing file's write permission.
    const check = await fsOpen(target, fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try { if (!sameIdentity(original, await check.stat())) throw new Error("write target changed during operation"); }
    finally { await check.close(); }
  }
  const temp = resolve(parent, `.code-mcp-write-${crypto.randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fsOpen>> | undefined;
  let tempStat: Awaited<ReturnType<typeof fsStat>> | undefined;
  try {
    verifyAncestors(); verifyTarget();
    handle = await fsOpen(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    tempStat = await handle.stat();
    if (original) {
      await handle.close(); handle = undefined;
      verifyAncestors(); verifyTarget();
      await copyWriteMetadata(target, temp);
      verifyAncestors(); verifyTarget();
      const copied = lstatSync(temp);
      if (!sameIdentity(tempStat, copied) || !copied.isFile()) throw new Error("write staging file changed during operation");
      if (process.platform !== "win32" && (copied.uid !== original.uid || copied.gid !== original.gid || (copied.mode & 0o777) !== (original.mode & 0o777))) throw new Error("cannot preserve destination ownership or permissions");
      handle = await fsOpen(temp, fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0));
      if (!sameIdentity(copied, await handle.stat())) throw new Error("write staging file changed during operation");
      await handle.truncate(0);
    }
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close(); handle = undefined;
    verifyAncestors(); verifyTarget();
    const staged = lstatSync(temp);
    if (!sameIdentity(tempStat, staged) || !staged.isFile() || staged.size !== bytes.length) throw new Error("write staging file changed during operation");
    beforeCommit?.();
    await fsRename(temp, target);
    return `wrote ${bytes.length} bytes to ${path}`;
  } finally {
    await handle?.close();
    const leftover = maybeStat(temp);
    // Only clean up our own temporary inode; never unlink a substituted entry.
    if (leftover && tempStat && sameIdentity(tempStat, leftover)) await fsUnlink(temp);
  }
}

// Edit validates literal strings before reading and delegates replacement to
// Write so metadata preservation, hardlink detachment and cleanup stay shared.
async function editFileAtomic(args: unknown): Promise<string> {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("edit arguments must be an object");
  const { cwd, path, old_str, new_str } = args as Record<string, unknown>;
  if (typeof cwd !== "string" || !cwd.length || typeof path !== "string" || !path.length
    || typeof old_str !== "string" || !old_str.length || typeof new_str !== "string") {
    throw new Error("edit requires nonempty cwd/path/old_str strings and a new_str string");
  }
  if (cwd.includes("\0") || path.includes("\0")) throw new Error("invalid path");
  for (const [name, value] of [["cwd", cwd], ["path", path], ["old_str", old_str], ["new_str", new_str]]) {
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(`${name} contains invalid Unicode`);
      } else if (c >= 0xdc00 && c <= 0xdfff) throw new Error(`${name} contains invalid Unicode`);
    }
  }
  const finalComponent = path.split(process.platform === "win32" ? /[\\/]/ : /\//).at(-1);
  if (!finalComponent || finalComponent === "." || finalComponent === "..") throw new Error("edit path must name a file");
  const base = physicalPath(cwd, false);
  if (!statSync(base).isDirectory()) throw new Error("cwd must be an existing directory");
  const lexical = isAbsolute(path) ? path : `${base}${sep}${path}`;
  const target = physicalPath(lexical, true);
  const offset = relative(base, target);
  if (offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw new Error("path escapes cwd");
  const stat = lstatSync(target);
  if (!stat.isFile()) throw new Error("not a regular file");
  const expected: FileSnapshot = { path: target, stat };
  const text = await readFileText({ cwd, path }, { allowSpill: false, expected });
  verifyFileSnapshot(expected, physicalPath(lexical, true), lstatSync(target));
  const first = text.indexOf(old_str);
  if (first < 0) throw new Error("old_str not found");
  if (text.indexOf(old_str, first + 1) >= 0) throw new Error("old_str not unique");
  const content = text.slice(0, first) + new_str + text.slice(first + old_str.length);
  await writeFileAtomic({ cwd, path, content }, expected);
  return "ok";
}

// Multi_edit keeps all validation and staging ahead of replacement. Each
// rename is atomic; rollback is guarded and cannot promise crash atomicity.
async function multiEditFiles(args: unknown): Promise<string> {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("multi_edit arguments must be an object");
  const { cwd, edits } = args as Record<string, unknown>;
  const validString = (name: string, value: unknown, nonempty: boolean, path = false): string => {
    if (typeof value !== "string" || (nonempty && !value.length)) throw new Error(`${name} must be ${nonempty ? "a nonempty" : "a"} string`);
    if (path && value.includes("\0")) throw new Error(`${name} contains NUL`);
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(`${name} contains invalid Unicode`);
      } else if (c >= 0xdc00 && c <= 0xdfff) throw new Error(`${name} contains invalid Unicode`);
    }
    return value;
  };
  // Bun does not apply ordinary Win32 trailing-dot/space aliases itself.
  // Keep explicit namespace paths literal, and never normalize UNC roots.
  const normalizeMultiPath = (path: string): string => {
    if (process.platform !== "win32") return path;
    const slash = sep;
    const windows = path.split("/").join(slash);
    if (windows.startsWith(slash + slash + "?" + slash) || windows.startsWith(slash + slash + "." + slash)) return path;
    const root = parsePath(windows).root;
    const parts = windows.slice(root.length).split(slash);
    const tail = parts.map((part, index) => {
      if (!part || part === "." || part === "..") return part;
      // Only one terminal period is removed from intermediate components.
      // Remaining dot/space suffixes are rejected because component-wise
      // filesystem resolution cannot preserve them consistently across runtimes.
      const normalized = index === parts.length - 1
        ? part.replace(/[. ]+$/, "")
        : part.endsWith(".") && !part.endsWith("..") ? part.slice(0, -1) : part;
      if (!normalized) throw new Error("path component becomes empty under Win32 normalization");
      if (index < parts.length - 1 && /[. ]$/.test(normalized)) {
        throw new Error("unsupported or ambiguous Windows path: intermediate component ends in a dot or space");
      }
      return normalized;
    }).join(slash);
    return root + tail;
  };
  const directory = normalizeMultiPath(validString("cwd", cwd, true, true));
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > 1000) throw new Error("edits must contain 1 to 1000 items");
  const validated = edits.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`edit #${i + 1} must be an object`);
    const path = validString("path", item.path, true, true);
    const last = path.split(process.platform === "win32" ? /[\\/]/ : /\//).at(-1);
    if (!last || last === "." || last === "..") throw new Error("edit path must name a file");
    return { path, old: validString("old_str", item.old_str, true), replacement: validString("new_str", item.new_str, false) };
  });
  type Stat = ReturnType<typeof lstatSync>;
  type Artifact = { path: string; stat: Stat };
  type Entry = {
    path: string; stat: Stat; parents: Map<string, Stat>; requests: string[];
    original: string; text: string; bytes: number; count: number;
    stage?: Artifact; backup?: Artifact; committed?: Stat; replaced: boolean; retain: boolean;
  };
  const key = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
  const base = physicalPath(directory, false);
  if (!statSync(base).isDirectory()) throw new Error("cwd must be an existing directory");
  const identity = (a: Stat, b: Stat) => a.dev === b.dev && a.ino === b.ino && (a.mode & 0o170000) === (b.mode & 0o170000);
  // Own renames may change another hardlink's ctime. Do not mistake that for
  // a concurrent content change; identity, size, mode and mtime remain stable.
  const same = (a: Stat, b: Stat) => identity(a, b) && a.size === b.size && a.mode === b.mode && a.mtimeMs === b.mtimeMs;
  const resolveRequest = (path: string) => {
    const normalized = normalizeMultiPath(path);
    const target = physicalPath(isAbsolute(normalized) ? normalized : `${base}${sep}${normalized}`, true);
    const offset = relative(base, target);
    if (offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw new Error("path escapes cwd");
    return target;
  };
  const entries = new Map<string, Entry>();
  const requests = new Map<string, Entry>();
  const ordered: { entry: Entry; old: string; replacement: string }[] = [];
  let originalTotal = 0;
  for (const edit of validated) {
    let entry = requests.get(edit.path);
    if (!entry) {
      const path = resolveRequest(edit.path), canonical = key(path);
      entry = entries.get(canonical);
      if (!entry) {
        const stat = lstatSync(path);
        if (!stat.isFile()) throw new Error("not a regular file");
        if (!(stat.mode & 0o222)) throw new Error("destination is not writable");
        originalTotal += stat.size;
        if (originalTotal > MAX_READ_BYTES) throw new Error("total original text exceeds 100 MiB");
        const parents = new Map<string, Stat>();
        for (let parent = dirname(path); ; parent = dirname(parent)) {
          const st = lstatSync(parent);
          if (!st.isDirectory()) throw new Error("parent is not a directory");
          parents.set(parent, st);
          if (dirname(parent) === parent) break;
        }
        entry = { path, stat, parents, requests: [], original: "", text: "", bytes: 0, count: 0, replaced: false, retain: false };
        entries.set(canonical, entry);
      }
      requests.set(edit.path, entry);
      entry.requests.push(edit.path);
    }
    entry.count++;
    ordered.push({ entry, old: edit.old, replacement: edit.replacement });
  }
  const checkPaths = (entry: Entry) => {
    if (key(physicalPath(directory, false)) !== key(base)) throw new Error("cwd changed during operation");
    for (const request of entry.requests) if (key(resolveRequest(request)) !== key(entry.path)) throw new Error("edit path changed during operation");
    for (const [path, before] of entry.parents) {
      const current = lstatSync(path);
      if (!current.isDirectory() || !identity(before, current) || before.mode !== current.mode) throw new Error("parent changed during operation");
    }
  };
  const checkOriginal = (entry: Entry) => {
    checkPaths(entry);
    if (!same(entry.stat, lstatSync(entry.path))) throw new Error(`file changed during operation: ${entry.path}`);
  };
  const checkArtifact = (artifact: Artifact) => {
    const current = lstatSync(artifact.path);
    if (!current.isFile() || !same(artifact.stat, current)) throw new Error(`staging file changed: ${artifact.path}`);
  };
  let actualOriginalTotal = 0;
  for (const entry of entries.values()) {
    checkOriginal(entry);
    if (actualOriginalTotal + entry.stat.size > MAX_READ_BYTES) throw new Error("total original text exceeds 100 MiB");
    entry.original = await readFileText({ cwd: directory, path: entry.path }, { allowSpill: false, expected: { path: entry.path, stat: entry.stat } });
    checkOriginal(entry);
    entry.text = entry.original;
    entry.bytes = Buffer.byteLength(entry.text, "utf8");
    actualOriginalTotal += entry.bytes;
    if (actualOriginalTotal > MAX_READ_BYTES) throw new Error("total original text exceeds 100 MiB");
    const access = await fsOpen(entry.path, fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    try { if (!same(entry.stat, await access.stat())) throw new Error("file changed during write-access check"); }
    finally { await access.close(); }
  }
  let workingTotal = actualOriginalTotal;
  for (const [i, edit] of ordered.entries()) {
    const { entry, old, replacement } = edit;
    const first = entry.text.indexOf(old);
    if (first < 0) throw new Error(`edit #${i + 1}: old_str not found`);
    if (entry.text.indexOf(old, first + 1) >= 0) throw new Error(`edit #${i + 1}: old_str not unique`);
    const delta = Buffer.byteLength(replacement, "utf8") - Buffer.byteLength(old, "utf8");
    if (workingTotal + delta > MAX_READ_BYTES) throw new Error("total working text exceeds 100 MiB");
    entry.text = entry.text.slice(0, first) + replacement + entry.text.slice(first + old.length);
    entry.bytes += delta;
    workingTotal += delta;
  }
  const stage = async (entry: Entry, backup: boolean) => {
    checkOriginal(entry);
    const path = resolve(dirname(entry.path), `.code-mcp-multi-${backup ? "backup" : "stage"}-${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof fsOpen>> | undefined;
    try {
      handle = await fsOpen(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
      const artifact: Artifact = { path, stat: await handle.stat() };
      if (backup) entry.backup = artifact; else entry.stage = artifact;
      await handle.close(); handle = undefined;
      checkOriginal(entry);
      await copyWriteMetadata(entry.path, path);
      checkOriginal(entry);
      const copied = lstatSync(path);
      if (!copied.isFile() || !identity(artifact.stat, copied)) throw new Error("staging identity changed");
      if (process.platform !== "win32" && (copied.uid !== entry.stat.uid || copied.gid !== entry.stat.gid || (copied.mode & 0o777) !== (entry.stat.mode & 0o777))) throw new Error("cannot preserve destination metadata");
      handle = await fsOpen(path, fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0));
      if (!identity(artifact.stat, await handle.stat())) throw new Error("staging identity changed");
      await handle.truncate(0);
      await handle.writeFile(Buffer.from(backup ? entry.original : entry.text, "utf8"));
      if (backup && process.platform !== "win32") {
        // Data writes can clear setuid/setgid and security.capability. Restore
        // original metadata only for rollback backups, never edited outputs.
        await handle.sync();
        await handle.close(); handle = undefined;
        checkOriginal(entry);
        await copyWriteMetadata(entry.path, path);
        checkOriginal(entry);
        const restored = lstatSync(path);
        if (!restored.isFile() || !identity(artifact.stat, restored)
          || restored.size !== Buffer.byteLength(entry.original, "utf8")
          || restored.mode !== entry.stat.mode || restored.uid !== entry.stat.uid || restored.gid !== entry.stat.gid) {
          throw new Error("cannot preserve original backup metadata");
        }
        handle = await fsOpen(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        const opened = await handle.stat();
        if (!same(restored, opened) || restored.uid !== opened.uid || restored.gid !== opened.gid) throw new Error("backup identity or metadata changed");
      }
      if (backup) await handle.utimes(entry.stat.atime, entry.stat.mtime);
      await handle.sync();
      artifact.stat = await handle.stat();
      if (artifact.stat.size !== Buffer.byteLength(backup ? entry.original : entry.text, "utf8")) throw new Error("incomplete staging file");
      checkOriginal(entry);
    } finally { await handle?.close(); }
  };
  const cleanup = async (): Promise<string[]> => {
    const failures: string[] = [];
    for (const entry of entries.values()) for (const artifact of [entry.stage, entry.retain ? undefined : entry.backup]) {
      if (!artifact) continue;
      try {
        checkPaths(entry);
        let current: Stat;
        try { current = lstatSync(artifact.path); }
        catch (e: any) { if (e?.code === "ENOENT") continue; throw e; }
        if (!identity(artifact.stat, current)) throw new Error("artifact was replaced externally");
        await fsUnlink(artifact.path);
      } catch (e: any) { failures.push(`${artifact.path}: ${e?.message ?? e}`); }
    }
    return failures;
  };
  try {
    for (const entry of entries.values()) { await stage(entry, true); await stage(entry, false); }
    for (const entry of entries.values()) checkOriginal(entry);
    for (const entry of entries.values()) {
      checkOriginal(entry);
      checkArtifact(entry.stage!); checkArtifact(entry.backup!);
      await fsRename(entry.stage!.path, entry.path);
      entry.replaced = true;
      // Remember our staged inode before inspecting the new pathname. If that
      // inspection fails, rollback refuses to overwrite an unknown target.
      entry.committed = entry.stage!.stat;
      const committed = lstatSync(entry.path);
      if (!same(entry.committed, committed)) throw new Error("committed target changed");
      entry.committed = committed;
    }
  } catch (error: any) {
    const partial: string[] = [];
    for (const entry of [...entries.values()].reverse()) {
      if (!entry.replaced) continue;
      try {
        checkPaths(entry);
        if (!entry.committed || !same(entry.committed, lstatSync(entry.path))) throw new Error("committed target changed externally");
        checkArtifact(entry.backup!);
        await fsRename(entry.backup!.path, entry.path);
      } catch (rollback: any) {
        entry.retain = true;
        partial.push(`${entry.path} -> ${entry.backup!.path} (${rollback?.message ?? rollback})`);
      }
    }
    const leftovers = await cleanup();
    const detail = partial.length ? `; PARTIAL FAILURE; original backups retained: ${partial.join("; ")}` : "; no batch changes remain (committed files restored)";
    throw new Error(`${error?.message ?? error}${detail}${leftovers.length ? `; cleanup failed: ${leftovers.join("; ")}` : ""}`);
  }
  const leftovers = await cleanup();
  if (leftovers.length) throw new Error(`edits committed; cleanup failed: ${leftovers.join("; ")}`);
  const summary = [...entries.values()].map(entry => `${entry.path} (${entry.count} edit${entry.count > 1 ? "s" : ""})`).join(", ");
  return `applied ${validated.length} edit(s) across ${entries.size} file(s): ${summary}`;
}

const aggregatorServers = new Map<string, ServerState>();
const activeMcpProbes = new Set<ServerState>();
const aggregatedTools = new Map<string, AggregatedTool>(); // prefixed name -> info
// All namespaces declared in --mcp config (including those whose probe failed).
// Source of truth for guide's external block — never re-read the config file.
const aggregatorKnownServers = new Set<string>();

// ---------- mcp tool: per-cwd server cache ----------

const MAX_CONCURRENT_SPAWNS = 3;
const MAX_SERVERS_PER_CWD = 10;
const MAX_TOTAL_CACHED_SERVERS = 50;
const SPAWN_TIMEOUT_MS = 30_000;

const cwdServers = new Map<string, Map<string, ServerState>>(); // cwd -> [config path, namespace] -> state
const serverMetadata = new Map<string, { tools: AggregatedTool[]; loadedAt: number }>();
// Concurrent callers share discovery only for the same live connection.
const mcpDiscoveries = new WeakMap<object, Promise<Json[]>>();
const mcpConfigServerId = (path: string, ns: string) => JSON.stringify([path, ns]);
const mcpMetadataKey = (cwd: string, id: string) => JSON.stringify([cwd, id]);
const activeSpawns = new Map<string, { state: ServerState; promise: Promise<void> }>();
const spawnWaiters: Array<() => void> = []; // FIFO of resolvers waiting for a slot
function notifySpawnWaiters() {
  const next = spawnWaiters.shift();
  if (next) next();
}

// ---------- mcp tool: validation functions ----------

function validateMcpConfigPath(cwd: string, mcpConfigPath: string): { ok: true; path: string } | { ok: false; reason: string } {
  try {
    const physicalRoot = physicalPath(cwd, false);
    const root = IS_WINDOWS ? realpathSync.native(physicalRoot) : physicalRoot;
    if (!statSync(root).isDirectory()) throw new Error("cwd must be an existing directory");
    let target = physicalPath(isAbsolute(mcpConfigPath) ? mcpConfigPath : `${root}${sep}${mcpConfigPath}`, true);
    if (IS_WINDOWS) {
      try { target = realpathSync.native(target); }
      catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    }
    const offset = relative(root, target);
    if (!offset || offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw new Error("config path escapes cwd or names cwd itself");
    return { ok: true, path: target };
  } catch (error: any) { return { ok: false, reason: error?.message ?? String(error) }; }
}

function validateServerName(servers: Record<string, McpServerConfig>, serverName: string): { ok: true } | { ok: false; reason: string } {
  if (!servers || typeof servers !== "object") {
    return { ok: false, reason: "invalid .mcp.json: missing mcpServers object" };
  }
  if (!Object.hasOwn(servers, serverName)) {
    const names = Object.keys(servers).join(", ");
    return { ok: false, reason: `server '${serverName}' not found in .mcp.json (available: ${names})` };
  }
  if (!NAMESPACE_RE.test(serverName)) {
    return { ok: false, reason: `invalid server name '${serverName}' (must match ${NAMESPACE_RE})` };
  }
  return { ok: true };
}

function validateToolArgs(args: any): { ok: true; sanitized: Record<string, any> } | { ok: false; reason: string } {
  if (args === null || args === undefined) {
    return { ok: true, sanitized: {} };
  }
  if (typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, reason: "args must be a plain object" };
  }
  // JSON data keys are not prototype assignments. The JSON round-trip below
  // preserves literal keys without merging them into a prototype-bearing object.
  const seen = new WeakSet();
  const queue = [args];
  while (queue.length > 0) {
    const val = queue.pop();
    if (typeof val === "function") {
      return { ok: false, reason: "args contains functions" };
    }
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) continue;
      seen.add(val);
      for (const key of Object.keys(val)) {
        queue.push(val[key]);
      }
    }
  }
  return { ok: true, sanitized: JSON.parse(JSON.stringify(args)) };
}

function validateServerConfig(ns: string, cfg: McpServerConfig): { ok: true } | { ok: false; reason: string } {
  try {
    const text = (value: unknown, label: string, empty = true): string => {
      if (typeof value !== "string" || (!empty && !value.length)) throw new Error(`${label} must be ${empty ? "a" : "a nonempty"} string`);
      if (value.includes("\0") || Buffer.from(value, "utf8").toString("utf8") !== value) throw new Error(`${label} must be valid Unicode without NUL`);
      return value;
    };
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("config must be an object");
    if (Object.hasOwn(cfg, "idleTimeoutMs") && (!Number.isInteger(cfg.idleTimeoutMs) || cfg.idleTimeoutMs! < 0 || cfg.idleTimeoutMs! > 2147483647))
      throw new Error("idleTimeoutMs must be an integer from 0 through 2147483647");
    if (cfg.type === "http") {
      const raw = text(cfg.url, "url", false);
      if (/[\x00-\x20]/.test(raw)) throw new Error("invalid http url");
      const url = new URL(raw);
      const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
      if (!["http:", "https:"].includes(url.protocol) || (url.protocol === "http:" && !loopback)) throw new Error("http transport requires HTTPS except for loopback");
      if (Object.hasOwn(cfg, "headers")) {
        if (!cfg.headers || typeof cfg.headers !== "object" || Array.isArray(cfg.headers)) throw new Error("headers must be an object");
        for (const [key, value] of Object.entries(cfg.headers)) {
          if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) throw new Error("invalid header name");
          if (!/^[\t\x20-\x7e\x80-\xff]*$/.test(text(value, "header value"))) throw new Error("invalid header value");
        }
      }
    } else if (cfg.type === "stdio" || cfg.type === undefined) {
      if (/[;|<>&]/.test(text(cfg.command, "command", false))) throw new Error("command contains shell operators");
      if (Object.hasOwn(cfg, "args")) {
        if (!Array.isArray(cfg.args)) throw new Error("args must be an array of strings");
        for (const arg of cfg.args) text(arg, "argument");
      }
      if (Object.hasOwn(cfg, "env")) {
        if (!cfg.env || typeof cfg.env !== "object" || Array.isArray(cfg.env)) throw new Error("env must be an object");
        for (const [key, value] of Object.entries(cfg.env)) {
          if (text(key, "env key", false).includes("=")) throw new Error("invalid env key");
          text(value, "env value");
        }
      }
    } else throw new Error("unsupported transport type");
    return { ok: true };
  } catch (error: any) {
    return { ok: false, reason: `server '${ns}': ${error.message}` };
  }
}

// ---------- mcp tool: helper functions ----------

function mcpConfigSignature(cfg: McpServerConfig): string {
  // Stable case-insensitive sorting preserves the order of colliding keys:
  // Windows env overrides and HTTP header overrides are order-dependent.
  const pairs = (value: Record<string, string> | undefined, insensitive: boolean) => Object.entries(value ?? {}).sort(([a], [b]) => {
    if (insensitive) { a = a.toLowerCase(); b = b.toLowerCase(); }
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const effective = cfg.type === "http"
    ? ["http", cfg.url, pairs(cfg.headers, true)]
    : ["stdio", cfg.command, cfg.args ?? [], pairs(cfg.env, process.platform === "win32"), cfg.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS];
  return createHash("sha256").update(JSON.stringify(effective)).digest("hex");
}

async function reconcileMcpConfig(cwd: string, path: string, servers: Record<string, McpServerConfig>): Promise<void> {
  const retired: Promise<unknown>[] = [];
  for (const [id, state] of cwdServers.get(cwd) ?? []) {
    const [cachedPath, ns] = JSON.parse(id) as [string, string];
    if (cachedPath !== path) continue;
    const cfg = Object.hasOwn(servers, ns) ? servers[ns] : undefined;
    if (!cfg || state.configSignature !== mcpConfigSignature(cfg)) retired.push(unloadCachedServer(cwd, id, state));
  }
  await Promise.all(retired);
}

function getOrCreateServerState(cwd: string, ns: string, cfg: McpServerConfig, configPath = resolve(cwd, ".mcp.json")): ServerState {
  const id = mcpConfigServerId(configPath, ns);
  const existing = cwdServers.get(cwd)?.get(id);
  const signature = mcpConfigSignature(cfg);
  if (existing) {
    if (existing.configSignature !== signature) throw new Error("MCP configuration changed during request");
    return existing;
  }
  // Do not retain an empty project cache when admission fails globally.
  const cwdMap = cwdServers.get(cwd) ?? new Map<string, ServerState>();
  if (cwdMap.size >= MAX_SERVERS_PER_CWD) {
    throw new Error(`max servers per cwd (${MAX_SERVERS_PER_CWD}) exceeded for ${cwd}`);
  }
  let totalServers = 0;
  for (const m of cwdServers.values()) totalServers += m.size;
  if (totalServers >= MAX_TOTAL_CACHED_SERVERS) {
    throw new Error(`max total cached servers (${MAX_TOTAL_CACHED_SERVERS}) exceeded`);
  }
  const state = makeServerState(ns, cfg, false);
  if (state.transport === "stdio") state.cwd = cwd;
  state.cacheKey = mcpMetadataKey(cwd, id);
  state.configSignature = signature;
  cwdServers.set(cwd, cwdMap);
  cwdMap.set(id, state);
  return state;
}

// Bound configuration input before decoding/parsing, including files changed mid-read.
const MAX_MCP_CONFIG_BYTES = 16 * 1024 * 1024;
async function readMcpConfigText(path: string): Promise<string> {
  const before = lstatSync(path);
  if (!before.isFile()) throw new Error("MCP config must be a regular file");
  if (before.size > MAX_MCP_CONFIG_BYTES) throw new Error("MCP config exceeds 16 MiB limit");
  const handle = await fsOpen(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  try {
    const initial = await handle.stat();
    const matches = (value: typeof before) => value.isFile() && value.dev === before.dev && value.ino === before.ino
      && value.size === before.size && value.mtimeMs === before.mtimeMs && value.ctimeMs === before.ctimeMs;
    if (!matches(initial)) throw new Error("MCP config changed during read");
    const bytes = Buffer.allocUnsafe(initial.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, Math.min(64 * 1024, bytes.length - used), used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used !== initial.size || !matches(await handle.stat()) || !matches(lstatSync(path))) throw new Error("MCP config changed during read");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used));
  } finally { await handle.close(); }
}

async function loadMcpConfig(cwd: string, mcpConfigPath: string): Promise<{ path: string; servers: Record<string, McpServerConfig> } | { error: string }> {
  const validation = validateMcpConfigPath(cwd, mcpConfigPath);
  if (!validation.ok) {
    return { error: validation.reason };
  }
  let raw: string;
  try {
    raw = await readMcpConfigText(validation.path);
  } catch (e: any) {
    return { error: `failed to read .mcp.json: ${e?.message ?? e}` };
  }
  let parsed: any;
  try {
    parsed = parseMcpJson(raw);
  } catch (e: any) {
    return { error: `.mcp.json is not valid JSON: ${e?.message ?? e}` };
  }
  const servers = parsed?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return { error: `.mcp.json has no 'mcpServers' object` };
  }
  for (const [ns, cfg] of Object.entries(servers as Record<string, McpServerConfig>)) {
    const v = validateServerConfig(ns, cfg as McpServerConfig);
    if (!v.ok) {
      return { error: v.reason };
    }
  }
  return { path: validation.path, servers };
}

function waitForSpawnSlot(state: ServerState): Promise<void> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const cleanup = () => {
      if (controller) {
        state.activeRequests.delete(controller);
        controller.signal.removeEventListener("abort", cancel);
      }
    };
    const wake = () => { cleanup(); resolve(); };
    const cancel = () => {
      const index = spawnWaiters.indexOf(wake);
      if (index !== -1) spawnWaiters.splice(index, 1);
      cleanup();
      reject(new Error("MCP server was unloaded while queued"));
      if (activeSpawns.size < MAX_CONCURRENT_SPAWNS) notifySpawnWaiters();
    };
    spawnWaiters.push(wake);
    if (controller) {
      state.activeRequests.add(controller);
      controller.signal.addEventListener("abort", cancel, { once: true });
      if (state.unloaded) cancel();
    }
  });
}

async function spawnServerWithLimit(cwd: string, ns: string, state: ServerState): Promise<void> {
  const key = state.cacheKey ?? `${cwd}:${ns}`;
  while (true) {
    if (state.unloaded) {
      if (activeSpawns.size < MAX_CONCURRENT_SPAWNS) notifySpawnWaiters();
      throw new Error("MCP server was unloaded");
    }
    const active = activeSpawns.get(key);
    if (active) {
      if (activeSpawns.size < MAX_CONCURRENT_SPAWNS) notifySpawnWaiters();
      if (active.state === state) return active.promise;
      // A replacement must initialize its own state, not inherit the outcome
      // of the old generation that happened to occupy the same key.
      try { await active.promise; } catch {}
      continue;
    }
    if (activeSpawns.size >= MAX_CONCURRENT_SPAWNS) {
      await waitForSpawnSlot(state);
      continue; // Recheck both ownership and capacity after every wakeup.
    }
    const task = { state, promise: ensureSpawned(ns, state) };
    activeSpawns.set(key, task);
    try {
      await task.promise;
      return;
    } finally {
      if (activeSpawns.get(key) === task) activeSpawns.delete(key);
      notifySpawnWaiters();
    }
  }
}

function unloadState(state: ServerState): void {
  state.unloaded = true;
  state.initialized = false;
  for (const controller of state.activeRequests) controller.abort();
  state.activeRequests.clear();
}

const retiringStdio = new WeakMap<object, Promise<void>>();
const mcpCleanupTasks = new Set<Promise<void>>();
function retireStdioProcess(state: StdioServerState, proc = state.proc): Promise<void> {
  if (!proc) return Promise.resolve();
  const existing = retiringStdio.get(proc);
  if (existing) return existing;
  mcpStdioWriters.get(proc)?.close();
  if (state.proc === proc) {
    state.initialized = false;
    if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }
    for (const request of state.pending.values()) request.reject(new Error("MCP subprocess closed"));
    state.pending.clear();
  }
  const task = (async () => {
    // Keep stdin open until the tree has been enumerated and terminated.
    // EOF first lets a cooperative parent exit and orphan inherited pipes.
    try {
      if (IS_WINDOWS) {
        // This is our Job Object owner, not the original server. Terminating it
        // closes its job handle, including already-orphaned children.
        if (proc.exitCode === null && !proc.signalCode) proc.kill("SIGKILL");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([proc.exited, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("MCP process owner termination timed out")), 3000);
          })]);
        } finally { if (timer) clearTimeout(timer); }
      } else {
        const stopped = await killProcessTree(proc.pid, () => proc.exitCode === null && !proc.signalCode);
        if (!stopped) throw new Error("MCP subprocess tree termination could not be confirmed");
      }
    } finally {
      try { await Promise.resolve((proc.stdin as import("bun").FileSink).end()); } catch {}
      if (state.proc === proc) {
        state.proc = null;
        state.stdoutChunks = [];
        state.stdoutBytes = 0;
      }
    }
  })();
  retiringStdio.set(proc, task);
  mcpCleanupTasks.add(task);
  task.then(() => mcpCleanupTasks.delete(task), () => mcpCleanupTasks.delete(task));
  return task;
}

async function unloadServer(cwd: string, ns: string, configPath = resolve(cwd, ".mcp.json")): Promise<{ success: boolean; error?: string }> {
  return unloadCachedServer(cwd, mcpConfigServerId(configPath, ns));
}

async function unloadCachedServer(cwd: string, id: string, expected?: ServerState): Promise<{ success: boolean; error?: string }> {
  const cwdMap = cwdServers.get(cwd);
  if (!cwdMap) return { success: true };
  const state = cwdMap.get(id);
  if (!state || (expected && state !== expected)) return { success: true };
  unloadState(state);
  // Detach only this generation before awaiting cleanup. New requests can
  // create a replacement without an old timer or exit handler killing it.
  cwdMap.delete(id);
  serverMetadata.delete(mcpMetadataKey(cwd, id));
  if (cwdMap.size === 0) cwdServers.delete(cwd);
  if (state.transport === "stdio") await retireStdioProcess(state);
  return { success: true };
}

async function unloadAllForCwd(cwd: string): Promise<{ success: boolean }> {
  const names = [...(cwdServers.get(cwd)?.keys() ?? [])];
  await Promise.all(names.map(id => unloadCachedServer(cwd, id)));
  return { success: true };
}

function aggregatorLogDir(): string {
  const dir = resolve(process.env.HOME ?? process.cwd(), ".code-mcp", "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Match Java's parser bound before native parsing or recursive serialization.
// Regex searches skip ordinary string runs in native code; quoted brackets and
// escaped quotes never contribute to the container depth.
class McpJsonDepthError extends Error {}
class McpJsonNumberError extends Error {}
function parseMcpJson(text: string, maxDepth = 256): any {
  const tokens = /"[^"\\]*"|["{}\[\]]|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g;
  // Bound regex state for escape-heavy strings; consume at most 256 escapes
  // per chunk rather than allocating backtracking state for the entire string.
  const quotedChunk = /[^"\\]*(?:\\[\s\S][^"\\]*){0,256}/y;
  let depth = 0, match: RegExpExecArray | null;
  while ((match = tokens.exec(text)) !== null) {
    const ch = match[0][0];
    if (ch === '"' && match[0].length === 1) {
      let pos = tokens.lastIndex;
      while (pos < text.length) {
        quotedChunk.lastIndex = pos;
        quotedChunk.exec(text);
        pos = quotedChunk.lastIndex;
        if (text[pos] === '"') { pos++; break; }
        if (pos >= text.length) break;
        // The chunk hit its escape limit, or a malformed trailing backslash.
        pos += 2;
      }
      tokens.lastIndex = pos;
    } else if (ch === '{' || ch === '[') {
      if (++depth > maxDepth) throw new McpJsonDepthError(`JSON: too deeply nested (>${maxDepth})`);
    } else if (ch === '}' || ch === ']') depth--;
    else if (ch !== '"') {
      const token = match[0];
      // Short non-exponent numbers cannot overflow binary64.
      if ((token.length >= 309 || /[eE]/.test(token)) && !Number.isFinite(Number(token)))
        throw new McpJsonNumberError("JSON: number exceeds finite range");
    }
  }
  return JSON.parse(text);
}

const MAX_STDIO_BUFFER_BYTES = 16 * 1024 * 1024;
function readJsonRpcLines(state: StdioServerState, chunk: Uint8Array): Json[] {
  const bytes = Buffer.from(chunk);
  const out: Json[] = [];
  let start = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(10, start);
    const end = newline === -1 ? bytes.length : newline + 1;
    const part = bytes.subarray(start, end);
    if (state.stdoutBytes + part.length > MAX_STDIO_BUFFER_BYTES)
      throw new Error("MCP stdio frame exceeds 16 MiB");
    state.stdoutChunks.push(part);
    state.stdoutBytes += part.length;
    start = end;
    if (newline === -1) break;
    const frame = Buffer.concat(state.stdoutChunks, state.stdoutBytes);
    state.stdoutChunks = [];
    state.stdoutBytes = 0;
    const line = new TextDecoder("utf-8", { fatal: true }).decode(frame).trim();
    if (!line) continue;
    try { out.push(parseMcpJson(line)); } catch (error) {
      if (error instanceof McpJsonDepthError || error instanceof McpJsonNumberError) throw error;
      /* ignore non-JSON noise */
    }
  }
  return out;
}

// Server requests have their own ID namespace, even when an ID equals one
// of our pending calls. Only these client-side methods are supported.
function mcpIsNotification(msg: any): boolean {
  return msg.jsonrpc === "2.0" && typeof msg.method === "string"
    && !Object.hasOwn(msg, "id") && !Object.hasOwn(msg, "result") && !Object.hasOwn(msg, "error");
}

function handleServerRequest(msg: any): Json {
  const id = typeof msg.id === "string" || (typeof msg.id === "number" && Number.isFinite(msg.id)) ? msg.id : null;
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (id === null || msg.jsonrpc !== "2.0" || typeof msg.method !== "string" || Object.hasOwn(msg, "result") || Object.hasOwn(msg, "error"))
    return error(-32600, "Invalid Request");
  if (Object.hasOwn(msg, "params") && (!msg.params || typeof msg.params !== "object" || Array.isArray(msg.params)))
    return error(-32602, "Invalid params");
  if (msg.method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (msg.method === "roots/list") return { jsonrpc: "2.0", id, result: { roots: [] } };
  return error(-32601, "Method not found");
}

// Keep legacy JSON-RPC batches bounded and validate IDs before delivering any
// member, so an ambiguous duplicate cannot partially complete pending calls.
const MCP_MAX_BATCH_MESSAGES = 1024;
function mcpBatchMessages(value: any): any[] {
  if (!Array.isArray(value)) return [value];
  if (value.length > MCP_MAX_BATCH_MESSAGES) throw new Error("MCP batch exceeds 1024 messages");
  const requests = new Set<string | number>(), responses = new Set<string | number>();
  for (const message of value) {
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const id = message.id;
    if (typeof id !== "string" && !(typeof id === "number" && Number.isFinite(id))) continue;
    const ids = Object.hasOwn(message, "method") ? requests : responses;
    if (ids.has(id)) throw new Error("duplicate MCP batch request or response ID");
    ids.add(id);
  }
  return value;
}

// Admission includes waiting calls. Callback replies bypass these permits so a
// server can finish a request even when all sixteen outbound slots are occupied.
let mcpStdioActiveCalls = 0;
type McpStdioSlotWaiter = {
  proc: ReturnType<typeof spawn>; deadline: number; timer: ReturnType<typeof setTimeout>;
  resolve: (release: () => void) => void; reject: (error: Error) => void;
};
const mcpStdioSlotWaiters = new Set<McpStdioSlotWaiter>();
function mcpStdioReleasePermit(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mcpStdioActiveCalls--;
    for (const waiter of mcpStdioSlotWaiters) {
      mcpStdioSlotWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      if (performance.now() >= waiter.deadline) {
        waiter.reject(new Error("MCP stdio capacity deadline exceeded"));
        continue;
      }
      if (mcpStdioWriters.get(waiter.proc)?.closed !== false) {
        waiter.reject(new Error("MCP subprocess closed"));
        continue;
      }
      mcpStdioActiveCalls++;
      waiter.resolve(mcpStdioReleasePermit());
      break;
    }
  };
}
function acquireMcpStdioPermit(proc: ReturnType<typeof spawn>, deadline: number): Promise<() => void> {
  if (performance.now() >= deadline) return Promise.reject(new Error("MCP stdio capacity deadline exceeded"));
  if (mcpStdioWriters.get(proc)?.closed !== false) return Promise.reject(new Error("MCP subprocess closed"));
  if (mcpStdioActiveCalls < 16) {
    mcpStdioActiveCalls++;
    return Promise.resolve(mcpStdioReleasePermit());
  }
  if (mcpStdioSlotWaiters.size >= 64) return Promise.reject(new Error("MCP stdio call capacity exceeded"));
  return new Promise((resolve, reject) => {
    const waiter: McpStdioSlotWaiter = {proc, deadline, resolve, reject, timer: undefined!};
    waiter.timer = setTimeout(() => {
      mcpStdioSlotWaiters.delete(waiter);
      reject(new Error("MCP stdio capacity deadline exceeded"));
    }, Math.max(0, deadline - performance.now()));
    mcpStdioSlotWaiters.add(waiter);
  });
}

type McpStdioWrite = {
  payload: Buffer; deadline: number; resolve: () => void; reject: (error: Error) => void;
};
const mcpStdioWriters = new WeakMap<object, McpStdioWriter>();
class McpStdioWriter {
  closed = false;
  private failure = new Error("MCP subprocess closed");
  private controls: McpStdioWrite[] = [];
  private requests: McpStdioWrite[] = [];
  private bytes = 0;
  private count = 0;
  private draining = false;
  private active: McpStdioWrite | null = null;
  private abortWrite: ((error: Error) => void) | null = null;
  constructor(private state: StdioServerState, private proc: ReturnType<typeof spawn>) {}

  enqueue(payload: Buffer, deadline: number, control = false): Promise<void> {
    if (this.closed) throw this.failure;
    if (payload.length > MAX_STDIO_BUFFER_BYTES) throw new Error("MCP stdio frame exceeds 16 MiB");
    if (this.count >= 64 || this.bytes + payload.length > MAX_STDIO_BUFFER_BYTES)
      throw new Error("MCP stdio write queue capacity exceeded");
    const promise = new Promise<void>((resolve, reject) => {
      (control ? this.controls : this.requests).push({payload, deadline, resolve, reject});
      this.bytes += payload.length;
      this.count++;
    });
    if (!this.draining) void this.drain();
    return promise;
  }

  close(error = new Error("MCP subprocess closed")): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    this.abortWrite?.(error);
    this.active?.reject(error);
    for (const job of [...this.controls, ...this.requests]) job.reject(error);
    this.controls = [];
    this.requests = [];
    this.bytes = this.count = 0;
    for (const waiter of mcpStdioSlotWaiters) {
      if (waiter.proc !== this.proc) continue;
      mcpStdioSlotWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (!this.closed) {
        const job = this.controls.shift() ?? this.requests.shift();
        if (!job) break;
        this.active = job;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (performance.now() >= job.deadline) throw new Error("MCP stdio write deadline exceeded");
          const stdin = this.proc.stdin as import("bun").FileSink;
          // FileSink.write can reject asynchronously on a broken pipe.
          // Observe both operations under the same cancellation/deadline race.
          const writing = Promise.resolve(stdin.write(job.payload)).then(() => {
            if (this.closed) throw this.failure;
            return stdin.flush();
          });
          await Promise.race([
            writing,
            new Promise<never>((_, reject) => { this.abortWrite = reject; }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("MCP stdio write deadline exceeded")), Math.max(0, job.deadline - performance.now()));
            }),
          ]);
          if (this.closed) throw this.failure;
          if (performance.now() >= job.deadline) throw new Error("MCP stdio write deadline exceeded");
          job.resolve();
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          job.reject(failure);
          this.close(failure);
          void retireStdioProcess(this.state, this.proc).catch(error => console.error(String(error)));
        } finally {
          if (timer) clearTimeout(timer);
          this.active = null;
          this.abortWrite = null;
          if (!this.closed) { this.bytes -= job.payload.length; this.count--; }
        }
      }
    } finally { this.draining = false; }
  }
}

async function stdioRpc(state: StdioServerState, method: string, params: Json, notification: boolean, parentDeadline = Infinity): Promise<Json> {
  if (state.unloaded || !state.proc) throw new Error("MCP subprocess is not running");
  const proc = state.proc;
  const deadline = Math.min(performance.now() + (method === "tools/call" ? SUBPROCESS_CALL_TIMEOUT_MS : SPAWN_TIMEOUT_MS), state.setupDeadline ?? Infinity, parentDeadline);
  const release = await acquireMcpStdioPermit(proc, deadline);
  try {
    if (state.unloaded || state.proc !== proc) throw new Error("MCP server was unloaded during request");
    const writer = mcpStdioWriters.get(proc)!;
    const id = state.nextId++;
    const payload = Buffer.from(JSON.stringify({jsonrpc: "2.0", ...(notification ? {} : {id}), method, params}) + "\n");
    if (notification) { await writer.enqueue(payload, deadline); return {}; }
    const pending = state.pending;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(new Error("MCP stdio deadline exceeded"));
        void retireStdioProcess(state, proc).catch(error => console.error(String(error)));
      }, Math.max(0, deadline - performance.now()));
      pending.set(id, {
        resolve: value => {
          clearTimeout(timer);
          if (performance.now() >= deadline) {
            reject(new Error("MCP stdio deadline exceeded"));
            void retireStdioProcess(state, proc).catch(error => console.error(String(error)));
          } else resolve(value);
        },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      const failed = (error: Error) => {
        const request = pending.get(id);
        pending.delete(id);
        request?.reject(error);
      };
      try { void writer.enqueue(payload, deadline).catch(failed); }
      catch (error) { failed(error instanceof Error ? error : new Error(String(error))); }
    });
  } finally { release(); }
}

function attachStdioIO(ns: string, state: StdioServerState) {
  const proc = state.proc!;
  const pending = state.pending;
  // Narrow Bun's stdio union (`number | ReadableStream` / `number | FileSink`)
  // to the concrete types we get when spawning with `pipe`. These are runtime
  // invariants from spawnStdioServer(); the casts only quiet the type checker.
  const procStdout = proc.stdout as ReadableStream<Uint8Array>;
  const procStderr = proc.stderr as ReadableStream<Uint8Array>;
  const sendReply = (reply: any) => {
    void mcpStdioWriters.get(proc)!.enqueue(Buffer.from(JSON.stringify(reply) + "\n"), performance.now() + SPAWN_TIMEOUT_MS, true)
      .catch(() => retireStdioProcess(state, proc)).catch(error => console.error(String(error)));
  };
  const deliverResponse = (msg: any) => {
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      try { p.resolve(mcpRpcResult(msg, msg.id)); }
      catch (error: any) { p.reject(error); }
    }
  };
  // Stdout: parse JSON-RPC responses, route to pending requests.
  (async () => {
    const reader = procStdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (state.proc !== proc) break;
        if (done) {
          if (state.stdoutBytes) throw new Error("unterminated MCP stdio frame");
          // EOF closes the RPC channel even if the process remains alive.
          throw new Error("MCP stdio stream closed");
        }
        for (const payload of readJsonRpcLines(state, value)) {
          // Ordinary messages avoid batch arrays and ID-set allocation.
          if (!Array.isArray(payload)) {
            if (!payload || typeof payload !== "object") continue;
            if (Object.hasOwn(payload, "method")) {
              if (!mcpIsNotification(payload)) sendReply(handleServerRequest(payload));
            } else deliverResponse(payload);
            continue;
          }
          const messages = mcpBatchMessages(payload), replies: Json[] = [], responses: any[] = [];
          for (const msg of messages) {
            if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
              replies.push(handleServerRequest({}));
            } else if (Object.hasOwn(msg, "method")) {
              if (!mcpIsNotification(msg)) replies.push(handleServerRequest(msg));
            } else if (Object.hasOwn(msg, "result") || Object.hasOwn(msg, "error") || pending.has(msg.id)) {
              responses.push(msg);
            } else replies.push(handleServerRequest(msg));
          }
          // An empty batch gets one Invalid Request response, not an empty array.
          if (!messages.length) sendReply(handleServerRequest({}));
          else if (replies.length) sendReply(replies);
          for (const msg of responses) deliverResponse(msg);
        }
      }
    } catch (e: any) {
      if (state.proc === proc) {
        for (const request of pending.values()) request.reject(new Error(`invalid MCP stdio stream: ${e?.message ?? e}`));
        pending.clear();
        state.stdoutChunks = [];
        state.stdoutBytes = 0;
        state.initialized = false;
        await retireStdioProcess(state, proc).catch(error => console.error(String(error)));
      }
      // Reader throws when the stream is forcibly closed. The exit handler
      // below covers normal shutdown; only surface errors that happen
      // while the subprocess is still considered live.
      if (!shuttingDown && !state.isProbe && state.proc === proc) {
        console.error(`[mcp:${ns}] stdout reader error: ${e?.message ?? e}`);
      }
    }
  })();
  // Stderr: append to log file.
  (async () => {
    const reader = procStderr.getReader();
    const dec = new TextDecoder();
    const sink = Bun.file(state.stderrLogPath).writer();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sink.write(dec.decode(value));
        sink.flush();
      }
    } catch (e: any) {
      if (!shuttingDown && !state.isProbe && state.proc === proc) {
        console.error(`[mcp:${ns}] stderr reader error: ${e?.message ?? e}`);
      }
    } finally { sink.end(); }
  })();
  // Exit: reject all pending, mark dead.
  (async () => {
    const code = await proc.exited;
    mcpStdioWriters.get(proc)?.close(new Error(`subprocess exited (code=${code})`));
    for (const p of pending.values()) p.reject(new Error(`subprocess exited (code=${code})`));
    pending.clear();
    if (state.proc !== proc) return;
    state.stdoutChunks = [];
    state.stdoutBytes = 0;
    state.proc = null;
    state.initialized = false;
    state.initPromise = null;
    if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }
    if (code !== 0 && code != null && !shuttingDown && !state.isProbe) {
      console.error(`[mcp:${ns}] subprocess exited code=${code}; see ${state.stderrLogPath}`);
    }
  })();
}

// Same readable Job Object helper as Java and Python. The child is suspended
// until assigned, and its job dies when either child or pinned owner exits.
const MCP_WINDOWS_JOB_SOURCE = String.raw`using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class CodeMcpWindowsJob {
    [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low, High; public ulong Value { get { return ((ulong)High << 32) | Low; } } }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
        public uint Size; public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XChars, YChars, FillAttribute, Flags;
        public ushort ShowWindow, ReservedCount; public IntPtr ReservedData, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo Info; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits limits, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, uint count, uint flags, ref UIntPtr bytes);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute, IntPtr value, UIntPtr bytes, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out FileTime created, out FileTime exited, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetStdHandle(int which, IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, IntPtr attributes, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr handle, IntPtr bytes, uint length, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(IntPtr handle, IntPtr bytes, uint length, out uint written, IntPtr overlapped);
    static ManualResetEvent outputDone = new ManualResetEvent(false);
    static volatile bool outputFailed;
    static void RelayOutput(IntPtr source, IntPtr sink) {
        byte[] bytes = new byte[65536]; GCHandle buffer = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        try {
            uint read;
            while (ReadFile(source, buffer.AddrOfPinnedObject(), (uint)bytes.Length, out read, IntPtr.Zero)) {
                if (read == 0) return;
                uint offset = 0;
                while (offset < read) {
                    uint written; Check(WriteFile(sink, IntPtr.Add(buffer.AddrOfPinnedObject(), (int)offset), read-offset, out written, IntPtr.Zero));
                    if (written == 0) throw new IOException("MCP output write made no progress");
                    offset += written;
                }
            }
            int failure = Marshal.GetLastWin32Error();
            if (failure != 109) throw new Win32Exception(failure);
        } catch { outputFailed = true; }
        finally { buffer.Free(); CloseHandle(source); CloseHandle(sink); outputDone.Set(); }
    }
    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static IntPtr Inherit(int which) {
        IntPtr source = GetStdHandle(which), result;
        // Only the explicit child duplicate may be inherited. An extra copy
        // would keep the pipe alive after the child closes its standard stream.
        Check(SetHandleInformation(source, 1, 0));
        Check(DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), out result, 0, true, 2)); return result;
    }
    static void ReleaseProtocolHandles() {
        IntPtr input = GetStdHandle(-10), output = GetStdHandle(-11), error = GetStdHandle(-12);
        Check(SetStdHandle(-10, IntPtr.Zero)); Check(SetStdHandle(-11, IntPtr.Zero));
        // Keep stderr for ownership diagnostics; the helper never uses the
        // protocol streams once the suspended child has received its handles.
        if (input != error) CloseHandle(input);
        if (output != input && output != error) CloseHandle(output);
    }
    static ulong Created(IntPtr process) { FileTime created, exited, kernel, user; Check(GetProcessTimes(process, out created, out exited, out kernel, out user)); return created.Value; }
    static string Quote(string argument) {
        StringBuilder result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in argument) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); }
            else { result.Append('\\', slashes); result.Append(c); }
            slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
    }
    // The guardian starts before assigning the root, so it remains outside
    // this Job. Detached descendants survive their shell but not their server.
    public static void GuardRoot(uint ownerId) {
        IntPtr owner = IntPtr.Zero, job = IntPtr.Zero;
        try {
            owner = OpenProcess(0x101101, false, ownerId); Check(owner != IntPtr.Zero);
            if (Created(owner) > Created(GetCurrentProcess()) || WaitForSingleObject(owner, 0) != 258)
                throw new InvalidOperationException("MCP root owner already exited");
            job = CreateJobObjectW(IntPtr.Zero, null); Check(job != IntPtr.Zero);
            ExtendedLimits limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000;
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
            Check(AssignProcessToJobObject(job, owner));
            Console.WriteLine("CODE_MCP_ROOT_READY"); Console.Out.Flush();
            Check(WaitForSingleObject(owner, 0xffffffff) == 0);
        } finally {
            if (job != IntPtr.Zero) CloseHandle(job);
            if (owner != IntPtr.Zero) CloseHandle(owner);
        }
    }
    public static int Main(string[] args) {
        IntPtr owner = IntPtr.Zero, job = IntPtr.Zero, input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
        ProcessInfo child = new ProcessInfo(); bool assigned = false, relayStarted = false;
        IntPtr relayRead = IntPtr.Zero, relaySink = IntPtr.Zero;
        try {
            // Fixed control fields are never inferred from the child command.
            // The executable and all its arguments remain literal payload data.
            uint ownerId;
            if (args.Length < 4 || !UInt32.TryParse(args[0], out ownerId) || ownerId == 0)
                throw new ArgumentException("missing MCP owner or command");
            if (args[1] != "stdio" && args[1] != "job") throw new ArgumentException("invalid process owner mode");
            bool backgroundJob = args[1] == "job";
            bool rawCommand = args[2] == "raw" || args[2] == "raw-file";
            string[] original;
            if (args[2] == "file" || args[2] == "raw-file") {
                if (args.Length != 4) throw new ArgumentException("invalid MCP argument file envelope");
                // Java's Windows ProcessBuilder quoting differs from the CLR.
                // Transfer exact UTF-8 argv without a second command-line parse.
                using (FileStream request = new FileStream(args[3], FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete, 4096, FileOptions.DeleteOnClose)) {
                    if (request.Length > 262144) throw new ArgumentException("MCP argument file exceeds limit");
                    byte[] bytes = new byte[(int)request.Length]; int offset = 0;
                    while (offset < bytes.Length) { int n = request.Read(bytes, offset, bytes.Length - offset); if (n == 0) throw new EndOfStreamException(); offset += n; }
                    original = new UTF8Encoding(false, true).GetString(bytes).Split(new char[] { '\0' });
                }
            } else if (args[2] == "argv" || args[2] == "raw") {
                original = new string[args.Length - 3];
                Array.Copy(args, 3, original, 0, original.Length);
            } else throw new ArgumentException("invalid MCP argument transport");
            string[] decoded = new string[original.Length + 1]; decoded[0] = args[0];
            Array.Copy(original, 0, decoded, 1, original.Length); args = decoded;
            owner = OpenProcess(0x101000, false, ownerId); Check(owner != IntPtr.Zero);
            // Pin the owner handle. If its PID was recycled before this helper
            // opened it, the new process cannot predate this helper's creation.
            if (Created(owner) > Created(GetCurrentProcess()) || WaitForSingleObject(owner, 0) != 258) throw new InvalidOperationException("MCP owner already exited");
            job = CreateJobObjectW(IntPtr.Zero, null); Check(job != IntPtr.Zero);
            ExtendedLimits limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000;
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
            input = Inherit(-10); error = Inherit(-12);
            Check(CreatePipe(out relayRead, out output, IntPtr.Zero, 65536));
            Check(SetHandleInformation(output, 1, 1));
            Check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(-11), GetCurrentProcess(), out relaySink, 0, false, 2));
            StartupInfoEx startup = new StartupInfoEx(); startup.Info.Size = (uint)Marshal.SizeOf(typeof(StartupInfoEx));
            startup.Info.Flags = 0x100; startup.Info.Input = input; startup.Info.Output = output; startup.Info.Error = error;
            StringBuilder command = new StringBuilder();
            if (rawCommand) {
                // CMD parses its /s /c command itself; CRT escaping changes both
                // quoted executable paths and shell metacharacter semantics.
                if (original.Length != 1) throw new ArgumentException("invalid raw command envelope");
                command.Append(original[0]);
            } else {
                for (int i=1; i<args.Length; i++) { if (i>1) command.Append(' '); command.Append(Quote(args[i])); }
            }
            if (command.Length >= 32767) throw new ArgumentException("MCP command exceeds Windows command-line limit");
            // The managed runtime can hold additional inheritable handles.
            // Pass only our three distinct stdio duplicates to the child.
            IntPtr handleList = IntPtr.Zero; bool attributesReady = false;
            try {
                UIntPtr attributeBytes = UIntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeBytes);
                int attributeLength = checked((int)attributeBytes.ToUInt64());
                if (attributeLength <= 0) throw new InvalidOperationException("invalid MCP process attribute size");
                startup.Attributes = Marshal.AllocHGlobal(attributeLength);
                Check(InitializeProcThreadAttributeList(startup.Attributes, 1, 0, ref attributeBytes)); attributesReady = true;
                handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
                Marshal.WriteIntPtr(handleList, 0, input); Marshal.WriteIntPtr(handleList, IntPtr.Size, output); Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, error);
                Check(UpdateProcThreadAttribute(startup.Attributes, 0, new UIntPtr(0x20002), handleList, new UIntPtr((uint)(IntPtr.Size * 3)), IntPtr.Zero, IntPtr.Zero));
                if (!CreateProcessW(null, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080004, IntPtr.Zero, null, ref startup, out child)) {
                    int failure = Marshal.GetLastWin32Error(); child = new ProcessInfo(); throw new Win32Exception(failure);
                }
            } finally {
                if (attributesReady) DeleteProcThreadAttributeList(startup.Attributes);
                if (startup.Attributes != IntPtr.Zero) Marshal.FreeHGlobal(startup.Attributes);
                if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            }
            // The child cannot spawn anything before assignment succeeds.
            Check(AssignProcessToJobObject(job, child.Process)); assigned = true;
            if (WaitForSingleObject(owner, 0) != 258) throw new InvalidOperationException("MCP owner exited during spawn");
            Check(ResumeThread(child.Thread) != 0xffffffff);
            CloseHandle(child.Thread); child.Thread = IntPtr.Zero;
            CloseHandle(input); input = IntPtr.Zero; CloseHandle(output); output = IntPtr.Zero; CloseHandle(error); error = IntPtr.Zero;
            ReleaseProtocolHandles();
            Thread relay = new Thread(() => RelayOutput(relayRead, relaySink)); relay.IsBackground = true;
            relay.Start(); relayStarted = true;
            IntPtr done = outputDone.SafeWaitHandle.DangerousGetHandle();
            uint signaled = WaitForMultipleObjects(3, new IntPtr[] { child.Process, owner, done }, false, 0xffffffff);
            // Background jobs can close stdout while continuing useful work.
            // Protocol children retain their existing EOF retirement behavior.
            if (signaled == 2 && backgroundJob && !outputFailed)
                signaled = WaitForMultipleObjects(2, new IntPtr[] { child.Process, owner }, false, 0xffffffff);
            if (signaled == 0) {
                uint code; Check(GetExitCodeProcess(child.Process, out code));
                // End inherited descendants, then drain every already-written byte.
                Check(TerminateJobObject(job, 125));
                uint drained = WaitForMultipleObjects(2, new IntPtr[] { done, owner }, false, 0xffffffff);
                if (drained == 1 || outputFailed) return 125;
                if (drained != 0) throw new Win32Exception(Marshal.GetLastWin32Error());
                return unchecked((int)code);
            }
            if (signaled == 1) return 125;
            if (signaled == 2) {
                if (outputFailed) return 125;
                // Stdio may close just before normal process termination. Give
                // that exit a bounded chance to publish its original status.
                if (WaitForSingleObject(child.Process, 100) == 0) {
                    uint code; Check(GetExitCodeProcess(child.Process, out code)); return unchecked((int)code);
                }
                return 0;
            }
            throw new Win32Exception(Marshal.GetLastWin32Error());
        } catch (Exception failure) {
            Console.Error.WriteLine("MCP process ownership failed: " + failure.Message); return 125;
        } finally {
            if (job != IntPtr.Zero) { TerminateJobObject(job, 125); CloseHandle(job); }
            if (child.Process != IntPtr.Zero) {
                if (!assigned) TerminateProcess(child.Process, 125);
                WaitForSingleObject(child.Process, 2000); CloseHandle(child.Process);
            }
            if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
            if (input != IntPtr.Zero) CloseHandle(input); if (output != IntPtr.Zero) CloseHandle(output); if (error != IntPtr.Zero) CloseHandle(error);
            // Once started, the background relay owns its pipe handles. If the
            // owner disappears during a blocked write, process exit closes them.
            if (!relayStarted) { if (relayRead != IntPtr.Zero) CloseHandle(relayRead); if (relaySink != IntPtr.Zero) CloseHandle(relaySink); }
            if (owner != IntPtr.Zero) CloseHandle(owner);
        }
    }
}
`;
let mcpWindowsJobDirectory: string | null = null;
let mcpWindowsJobPreparation: Promise<string> | null = null;
function windowsMcpJobHelper(): Promise<string> {
  if (mcpWindowsJobPreparation) return mcpWindowsJobPreparation;
  mcpWindowsJobPreparation = (async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "code-mcp-job-"));
    mcpWindowsJobDirectory = directory;
    const source = resolve(directory, "owner.cs"), executable = resolve(directory, "owner.exe");
    let compiler: ReturnType<typeof spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await write(source, MCP_WINDOWS_JOB_SOURCE);
      const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
      const script = "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ([IO.File]::ReadAllText("
        + quote(source) + ")) -OutputAssembly " + quote(executable) + " -OutputType ConsoleApplication";
      const systemRoot = Object.entries(process.env).find(([key]) => key.toLowerCase() === "systemroot")?.[1] ?? "C:/Windows";
      compiler = spawn({cmd: [resolve(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        cwd: directory, env: buildChildEnv({}), stdin: "ignore", stdout: "ignore", stderr: "ignore"});
      const code = await Promise.race([compiler.exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Windows MCP process owner compilation timed out")), 10_000);
      })]);
      if (code !== 0 || !(await file(executable).exists())) throw new Error("Windows MCP process owner compilation failed");
      return executable;
    } catch (error) {
      if (compiler && compiler.exitCode === null && !compiler.signalCode) {
        const child = compiler;
        await killProcessTree(child.pid, () => child.exitCode === null && !child.signalCode);
      }
      rmSync(directory, {recursive: true, force: true, maxRetries: 10, retryDelay: 50});
      mcpWindowsJobDirectory = null;
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  })();
  const preparation = mcpWindowsJobPreparation;
  void preparation.catch(() => {
    if (mcpWindowsJobPreparation === preparation) mcpWindowsJobPreparation = null;
  });
  return preparation;
}

let windowsRootOwnerPreparation: Promise<void> | null = null;
let windowsRootOwner: ReturnType<typeof spawn> | null = null;
function ensureWindowsRootOwner(): Promise<void> {
  if (!IS_WINDOWS) return Promise.resolve();
  if (shuttingDown) return Promise.reject(new Error("server is shutting down"));
  if (windowsRootOwner && (windowsRootOwner.exitCode !== null || windowsRootOwner.signalCode))
    return Promise.reject(new Error("Windows root process owner exited"));
  if (windowsRootOwnerPreparation) return windowsRootOwnerPreparation;
  windowsRootOwnerPreparation = (async () => {
    const executable = await windowsMcpJobHelper();
    if (shuttingDown) throw new Error("server is shutting down");
    const script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; "
      + "Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:CODE_MCP_OWNER_SOURCE)); "
      + "[CodeMcpWindowsJob]::GuardRoot([uint32]$env:CODE_MCP_OWNER_PID)";
    const guard = spawn({cmd: [resolve(process.env.SystemRoot ?? "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      "-NoProfile", "-NonInteractive", "-Command", script], stdin: "ignore", stdout: "pipe", stderr: "ignore",
      cwd: resolve(process.env.SystemRoot ?? "C:/Windows", "System32"),
      env: buildChildEnv({CODE_MCP_OWNER_SOURCE: resolve(dirname(executable), "owner.cs"), CODE_MCP_OWNER_PID: String(process.pid)})});
    guard.unref();
    const reader = guard.stdout.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = (async () => {
        let value = "";
        while (value.length < 128 && !value.includes("\n")) {
          const chunk = await reader.read();
          if (chunk.done) break;
          value += new TextDecoder().decode(chunk.value);
        }
        if (value.trim() !== "CODE_MCP_ROOT_READY") throw new Error("Windows root process owner did not become ready");
      })();
      await Promise.race([ready, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Windows root process owner startup timed out")), 15000);
      })]);
      windowsRootOwner = guard;
    } catch (error) {
      if (guard.exitCode === null && !guard.signalCode) await killProcessTree(guard.pid, () => guard.exitCode === null && !guard.signalCode);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      await reader.cancel().catch(() => {}); reader.releaseLock();
    }
  })();
  const preparation = windowsRootOwnerPreparation;
  void preparation.catch(() => { if (windowsRootOwnerPreparation === preparation) windowsRootOwnerPreparation = null; });
  return preparation;
}

async function spawnStdioServer(ns: string, state: StdioServerState): Promise<void> {
  if (state.unloaded) throw new Error("MCP server was unloaded");
  state.setupDeadline ??= performance.now() + SPAWN_TIMEOUT_MS;
  const { command, args: cmdArgs = [], env = {} } = state.config;
  const cmd = IS_WINDOWS ? [await windowsMcpJobHelper(), String(process.pid), "stdio", "argv", command, ...cmdArgs] : [command, ...cmdArgs];
  if (shuttingDown || state.unloaded) throw new Error("MCP server was unloaded or shut down during spawn");
  const proc = spawn({
    cmd,
    cwd: state.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: buildChildEnv(env),
  });
  state.proc = proc;
  state.stdoutChunks = [];
  state.stdoutBytes = 0;
  state.pending = new Map();
  state.nextId = 1;
  state.initialized = false;
  mcpStdioWriters.set(proc, new McpStdioWriter(state, proc));
  attachStdioIO(ns, state);

  // MCP handshake: initialize + notifications/initialized.
  await rpcCall(state, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: { roots: {} },
    clientInfo: { name: "code-mcp-aggregator", version: "0.1.0" },
  });
  await rpcNotify(state, "notifications/initialized", {});
  if (state.unloaded) throw new Error("MCP server was unloaded during initialization");
  state.initialized = true;
}

async function ensureSpawned(ns: string, state: ServerState): Promise<void> {
  if (shuttingDown) throw new Error("server is shutting down");
  if (state.unloaded) throw new Error("MCP server was unloaded");
  // HTTP transport has no `proc`; the `initialized` flag alone gates it.
  if (state.transport === "stdio" ? state.proc && state.initialized : state.initialized) return;
  if (state.initPromise) return state.initPromise;
  // Retry only for a new caller, sharing initialization; never replay failed tool work.
  state.initPromise = (async () => {
    try {
      if (state.transport === "stdio") {
        await spawnStdioServer(ns, state);
      } else {
        await initHttpServer(ns, state);
      }
    } catch (e) {
      if (state.transport === "stdio") {
        await retireStdioProcess(state).catch(error => console.error(String(error)));
      } else {
        state.sessionId = null;
        state.protocolVersion = null;
        state.setupDeadline = null;
      }
      state.initialized = false;
      state.setupDeadline = null;
      throw e;
    } finally {
      state.initPromise = null;
    }
  })();
  return state.initPromise;
}

function rpcNotify(state: ServerState, method: string, params: Json): Promise<void> {
  if (state.transport === "stdio") return stdioRpc(state, method, params, true).then(() => {});
  return httpSend(state, { jsonrpc: "2.0", method, params }).then(() => {});
}

function rpcCall(state: ServerState, method: string, params: Json, parentDeadline = Infinity): Promise<Json> {
  if (state.unloaded) return Promise.reject(new Error("MCP server was unloaded"));
  if (state.transport === "stdio") return stdioRpc(state, method, params, false, parentDeadline).then(result => {
    if (method === "initialize") mcpNegotiatedVersion(result);
    return result;
  });
  const id = state.nextId++;
  return httpSend(state, { jsonrpc: "2.0", id, method, params }, parentDeadline).then(resp => mcpRpcResult(resp, id));
}

// Handshake revisions understood by this tools client. Do not accept an
// arbitrary future revision merely because its initialize envelope is valid.
const MCP_HANDSHAKE_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
function mcpNegotiatedVersion(result: Json): string {
  const version = result.protocolVersion;
  if (typeof version !== "string" || !MCP_HANDSHAKE_VERSIONS.has(version))
    throw new Error("unsupported or invalid MCP protocol version");
  return version;
}

function mcpRpcResult(resp: any, id: number): Json {
  if (!resp || typeof resp !== "object" || Array.isArray(resp) || resp.jsonrpc !== "2.0" || resp.id !== id)
    throw new Error("invalid RPC response envelope");
  if (Object.hasOwn(resp, "result") === Object.hasOwn(resp, "error")) throw new Error("RPC response must contain exactly one of result or error");
  if (Object.hasOwn(resp, "error")) throw new Error(resp.error?.message ?? "rpc error");
  if (!resp.result || typeof resp.result !== "object" || Array.isArray(resp.result)) throw new Error("MCP RPC result must be an object");
  return resp.result;
}

// Callback replies have reserved capacity: calls waiting on a server callback
// must not consume the capacity needed to send that callback's response.
let mcpHttpActiveCallbacks = 0;
const mcpHttpCallbackWaiters = new Set<() => void>();
function acquireMcpHttpCallback(deadline: number, signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    let settled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { mcpHttpCallbackWaiters.delete(start); if (timer) clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const fail = (message: string) => { if (!settled) { settled = true; cleanup(); reject(new Error(message)); } };
    const abort = () => fail("MCP HTTP callback was cancelled");
    const start = () => {
      if (settled) return;
      if (signal.aborted) { abort(); return; }
      if (performance.now() >= deadline) { fail("MCP HTTP callback deadline exceeded"); return; }
      if (mcpHttpActiveCallbacks >= 16) return;
      settled = true; cleanup(); mcpHttpActiveCallbacks++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true; mcpHttpActiveCallbacks--;
        for (const next of mcpHttpCallbackWaiters) { if (mcpHttpActiveCallbacks >= 16) break; next(); }
      });
    };
    if (mcpHttpActiveCallbacks < 16) { start(); return; }
    if (mcpHttpCallbackWaiters.size >= 64) { fail("MCP HTTP callback capacity exceeded"); return; }
    mcpHttpCallbackWaiters.add(start);
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => fail("MCP HTTP callback deadline exceeded"), Math.max(0, deadline - performance.now()));
    if (signal.aborted) abort();
  });
}

async function dispatchMcpHttpMessage(payload: any, id: number, reply: (value: any) => Promise<void>): Promise<any | null> {
  const batched = Array.isArray(payload);
  // Preserve strict envelope checking by rpcCall for ordinary responses.
  if (!batched && (!payload || typeof payload !== "object" || !Object.hasOwn(payload, "method"))) return payload;
  const messages = mcpBatchMessages(payload), replies: Json[] = [];
  let response: any = null, sawResponse = false;
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      replies.push(handleServerRequest({}));
    } else if (Object.hasOwn(message, "method")) {
      if (!mcpIsNotification(message)) replies.push(handleServerRequest(message));
    } else if (Object.hasOwn(message, "result") || Object.hasOwn(message, "error") || message.id === id) {
      sawResponse = true;
      if (message.id === id) response = message;
    } else replies.push(handleServerRequest(message));
  }
  if (sawResponse && response === null) throw new Error("MCP HTTP batch has no matching RPC response");
  if (!messages.length) await reply(handleServerRequest({}));
  else if (replies.length) await reply(batched ? replies : replies[0]);
  return response;
}

// Retire the exact state object. Keeping old callers attached to it prevents
// late responses/callbacks from borrowing or retiring a replacement session.
function expireMcpHttp(state: HttpServerState): void {
  unloadState(state);
  for (const [ns, current] of aggregatorServers) {
    if (current === state) aggregatorServers.set(ns, makeServerState(ns, state.config, false));
  }
  for (const [cwd, servers] of cwdServers) {
    for (const [ns, current] of servers) {
      if (current === state) {
        servers.delete(ns);
        serverMetadata.delete(mcpMetadataKey(cwd, ns));
      }
    }
    if (!servers.size) cwdServers.delete(cwd);
  }
}

// ---- HTTP transport ----

async function httpSend(state: HttpServerState, body: Json, parentDeadline = Infinity, parentSignal?: AbortSignal): Promise<any | null> {
  if (parentSignal?.aborted) throw new Error("MCP HTTP callback was cancelled");
  const oneWay = Array.isArray(body) || !Object.hasOwn(body, "method") || !Object.hasOwn(body, "id");
  if (state.unloaded) throw new Error("MCP server was unloaded");
  const headers = new Headers();
  for (const [key, value] of Object.entries(state.config.headers ?? {})) headers.set(key, value);
  // Transport-owned headers cannot be overridden through case variants.
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json, text/event-stream");
  headers.delete("Mcp-Session-Id");
  headers.delete("MCP-Protocol-Version");
  if (body.method !== "initialize" && state.protocolVersion) headers.set("MCP-Protocol-Version", state.protocolVersion);
  if (body.method !== "initialize" && state.sessionId) headers.set("Mcp-Session-Id", state.sessionId);

  // Keep the abort deadline alive until the BODY is consumed: clearing it at
  // the response headers left the body read unbounded (a stalled server could
  // pin the request forever).
  const ctrl = new AbortController();
  let timeoutMs = Math.min(body.method === "tools/call" ? MCP_HTTP_CALL_TIMEOUT_MS : MCP_HTTP_CONTROL_TIMEOUT_MS, parentDeadline - performance.now());
  if (state.setupDeadline !== null) {
    timeoutMs = Math.min(timeoutMs, state.setupDeadline - performance.now());
    if (timeoutMs <= 0) throw new Error("MCP setup deadline exceeded");
  }
  if (timeoutMs <= 0) throw new Error("MCP HTTP response deadline exceeded");
  const deadline = performance.now() + timeoutMs;
  const abortParent = () => ctrl.abort();
  parentSignal?.addEventListener("abort", abortParent, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  state.activeRequests.add(ctrl);
  let callbackCount = 0;
  const dispatch = (payload: any) => {
    if (ctrl.signal.aborted || performance.now() >= deadline) throw new Error("MCP HTTP response deadline exceeded");
    return dispatchMcpHttpMessage(payload, body.id, async reply => {
      callbackCount += Array.isArray(reply) ? reply.length : 1;
      if (callbackCount > MCP_MAX_BATCH_MESSAGES) throw new Error("MCP HTTP response exceeds 1024 callbacks");
      const callbackDeadline = Math.min(deadline, performance.now() + MCP_HTTP_CONTROL_TIMEOUT_MS);
      const release = await acquireMcpHttpCallback(callbackDeadline, ctrl.signal);
      try { await httpSend(state, reply, callbackDeadline, ctrl.signal); }
      finally { release(); }
    });
  };
  let resp: Response | undefined;
  try {
    const encoded = JSON.stringify(body);
    if (oneWay && Buffer.byteLength(encoded) > MCP_HTTP_RESP_MAX) throw new Error("MCP HTTP callback response exceeds 16 MiB");
    if (ctrl.signal.aborted || performance.now() >= deadline) throw new Error("MCP HTTP response deadline exceeded");
    resp = await fetch(state.config.url, {
      method: "POST", headers, body: encoded, signal: ctrl.signal,
      redirect: "error",
    });
    if (state.unloaded) throw new Error("MCP server was unloaded during request");
    if (!resp.ok) {
      if (resp.status === 404 && headers.has("Mcp-Session-Id")) {
        expireMcpHttp(state);
        throw new Error("MCP HTTP session expired; start a new call to reconnect");
      }
      throw new Error(`http ${resp.status}: ${await readBodyCapped(resp, MCP_HTTP_RESP_MAX)}`);
    }

    // Notifications return 202 No Content (or empty 200) — no body to parse.
    if (resp.status === 202 || resp.headers.get("content-length") === "0") return null;

    // A reply/notification cannot start another callback conversation.
    if (oneWay) { await readBodyCapped(resp, MCP_HTTP_RESP_MAX); return null; }
    const ct = (resp.headers.get("content-type") ?? "").toLowerCase();
    let message: any;
    if (ct.includes("text/event-stream")) {
      message = await parseSseSingleResponse(resp, dispatch);
    } else {
      const text = await readBodyCapped(resp, MCP_HTTP_RESP_MAX);
      if (!text.trim()) return null;
      message = await dispatch(parseMcpJson(text));
    }
    if (ctrl.signal.aborted || performance.now() >= deadline) throw new Error("MCP HTTP response deadline exceeded");
    if (body.method === "initialize") {
      // Commit session metadata only after a successful, matching RPC result.
      const version = mcpNegotiatedVersion(mcpRpcResult(message, body.id));
      const sid = resp.headers.get("Mcp-Session-Id") || null;
      if (sid !== null && !/^[\x21-\x7e]+$/.test(sid)) throw new Error("invalid MCP session ID");
      if (state.unloaded) throw new Error("MCP server was unloaded during request");
      state.sessionId = sid;
      state.protocolVersion = version;
    }
    return message;
  } finally {
    state.activeRequests.delete(ctrl);
    parentSignal?.removeEventListener("abort", abortParent);
    ctrl.abort();
    clearTimeout(timer);
    try { await resp?.body?.cancel(); } catch { /* already consumed/cancelled */ }
  }
}

// Max bytes to buffer from an external MCP HTTP server (memory-DoS guard).
const MCP_HTTP_RESP_MAX = 16 * 1024 * 1024;

async function readBodyCapped(resp: Response, max: number): Promise<string> {
  const cl = Number(resp.headers.get("content-length") ?? "0");
  if (Number.isFinite(cl) && cl > max) {
    throw new Error(`response too large (${cl} bytes > ${max})`);
  }
  if (!resp.body) return "";
  const reader = resp.body.getReader();
  const dec = new TextDecoder("utf-8", { fatal: true });
  let out = "";
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        throw new Error(`response too large (> ${max} bytes)`);
      }
      out += dec.decode(value, { stream: true });
    }
    return out + dec.decode();
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

// Parse SSE stream and return the first JSON-RPC response it contains.
// MCP servers often return a single response then close the stream.
async function parseSseSingleResponse(resp: Response, dispatch: (payload: any) => Promise<any | null>): Promise<any | null> {
  if (!resp.body) return null;
  const reader = resp.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0, skipLF = false;
  let parts: string[] = [], data: string[] = [];
  const finishLine = (): any | null => {
    const line = parts.join(""); parts = [];
    if (!line.length) {
      const payload = data.join("\n"); data = [];
      try {
        const message = parseMcpJson(payload);
        if (Array.isArray(message) || (message && typeof message === "object"
            && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error") || Object.hasOwn(message, "method")))) return message;
      } catch (error) {
        if (error instanceof McpJsonDepthError || error instanceof McpJsonNumberError) throw error;
        /* ignore non-RPC events; total bytes and deadline remain bounded */
      }
      return null;
    }
    const colon = line.indexOf(":"), field = colon < 0 ? line : line.slice(0, colon);
    if (field === "data") {
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      data.push(value);
    }
    return null;
  };
  const feed = async (text: string): Promise<any | null> => {
    let start = 0;
    for (const match of text.matchAll(/[\r\n]/g)) {
      const index = match.index!, char = match[0];
      if (skipLF) {
        skipLF = false;
        if (char === "\n" && index === start) { start = index + 1; continue; }
      }
      parts.push(text.slice(start, index));
      const payload = finishLine();
      if (payload !== null) { const result = await dispatch(payload); if (result !== null) return result; }
      skipLF = char === "\r";
      start = index + 1;
    }
    if (start < text.length) { parts.push(text.slice(start)); skipLF = false; }
    return null;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return await feed(decoder.decode());
      total += value.byteLength;
      if (total > MCP_HTTP_RESP_MAX) throw new Error("SSE response exceeds 16 MiB");
      const result = await feed(decoder.decode(value, { stream: true }));
      if (result !== null) return result;
    }
  } finally {
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
  }
}

function finishSetup(state: ServerState): void {
  if (state.unloaded) throw new Error("MCP server was unloaded");
  if (state.setupDeadline !== null && performance.now() >= state.setupDeadline)
    throw new Error("MCP setup deadline exceeded");
  state.setupDeadline = null;
}

async function initHttpServer(ns: string, state: HttpServerState): Promise<void> {
  state.nextId = 1;
  state.initialized = false;
  state.sessionId = null;
  state.protocolVersion = null;
  state.setupDeadline ??= performance.now() + MCP_HTTP_CONTROL_TIMEOUT_MS;
  // MCP handshake.
  await rpcCall(state, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: { roots: {} },
    clientInfo: { name: "code-mcp-aggregator", version: "0.1.0" },
  });
  await rpcNotify(state, "notifications/initialized", {});
  if (state.unloaded) throw new Error("MCP server was unloaded during initialization");
  state.initialized = true;
}

// ---- end HTTP transport ----

async function withMcpActivity<T>(state: ServerState, operation: () => Promise<T>): Promise<T> {
  if (state.transport !== "stdio") return operation();
  state.idleUsers++;
  if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }
  try { return await operation(); }
  finally {
    state.idleUsers--;
    if (state.idleUsers === 0) resetIdleTimer(state);
  }
}

function resetIdleTimer(state: StdioServerState) {
  if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }
  const ttl = state.config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const proc = state.proc;
  if (ttl <= 0 || !proc || !state.initialized || state.unloaded || shuttingDown || state.idleUsers) return;
  const timer = setTimeout(async () => {
    if (state.idleTimer !== timer || state.proc !== proc) return;
    state.idleTimer = null;
    if (state.idleUsers || state.unloaded || shuttingDown) return;
    await retireStdioProcess(state, proc).catch(error => console.error(String(error)));
  }, ttl);
  state.idleTimer = timer;
}

function makeServerState(ns: string, cfg: McpServerConfig, isProbe: boolean): ServerState {
  const base = {
    nextId: 1,
    initialized: false,
    initPromise: null,
    isProbe,
    unloaded: false,
    activeRequests: new Set<AbortController>(),
    setupDeadline: null,
  };
  if (cfg.type === "http") {
    return {
      ...base,
      transport: "http",
      config: cfg,
      sessionId: null,
      protocolVersion: null,
    };
  }
  return {
    ...base,
    transport: "stdio",
    config: cfg,
    proc: null,
    stdoutChunks: [],
    stdoutBytes: 0,
    idleTimer: null,
    idleUsers: 0,
    stderrLogPath: resolve(aggregatorLogDir(), `${ns}.stderr.log`),
    pending: new Map(),
  };
}

function validateMcpToolResult(result: Json): Json {
  const object = (value: any) => value !== null && typeof value === "object" && !Array.isArray(value);
  const invalid = (field: string): never => { throw new Error(`tools/call returned invalid ${field}`); };
  const metadata = (value: Json) => {
    for (const field of ["annotations", "_meta"]) if (Object.hasOwn(value, field) && !object(value[field])) invalid(field);
  };
  const strings = (value: Json, fields: string[]) => {
    for (const field of fields) if (typeof value[field] !== "string") invalid(field);
  };
  if (!object(result) || !Array.isArray(result.content)) invalid("content");
  if (Object.hasOwn(result, "isError") && typeof result.isError !== "boolean") invalid("isError");
  for (const field of ["structuredContent", "_meta"]) if (Object.hasOwn(result, field) && !object(result[field])) invalid(field);
  for (const block of result.content) {
    if (!object(block) || typeof block.type !== "string" || !block.type) invalid("content block");
    metadata(block);
    if (block.type === "text") strings(block, ["text"]);
    else if (block.type === "image" || block.type === "audio") strings(block, ["data", "mimeType"]);
    else if (block.type === "resource_link") {
      strings(block, ["uri", "name"]);
      for (const field of ["mimeType", "title", "description"]) if (Object.hasOwn(block, field)) strings(block, [field]);
    } else if (block.type === "resource") {
      const resource = block.resource;
      if (!object(resource)) invalid("resource");
      strings(resource, ["uri"]);
      metadata(resource);
      if (!Object.hasOwn(resource, "text") && !Object.hasOwn(resource, "blob")) invalid("resource content");
      for (const field of ["text", "blob", "mimeType"]) if (Object.hasOwn(resource, field)) strings(resource, [field]);
    }
    // Unknown extension block types stay intact for downstream consumers.
  }
  return result;
}

// Validate the fields consumed by the proxy; this is not a JSON Schema evaluator.
function validateMcpToolDefinition(tool: Json): void {
  const object = (value: any) => value !== null && typeof value === "object" && !Array.isArray(value);
  const invalid = (field: string): never => { throw new Error(`tools/list returned invalid ${field}`); };
  for (const field of ["inputSchema", "outputSchema"]) {
    if (!Object.hasOwn(tool, field)) continue;
    const schema = tool[field];
    if (!object(schema)) invalid(field);
    if (Object.hasOwn(schema, "type") && schema.type !== "object") invalid(field + ".type");
    if (Object.hasOwn(schema, "$schema") && typeof schema.$schema !== "string") invalid(field + ".$schema");
    if (Object.hasOwn(schema, "properties") && !object(schema.properties)) invalid(field + ".properties");
    if (Object.hasOwn(schema, "required") && (!Array.isArray(schema.required) || schema.required.some((value: any) => typeof value !== "string"))) invalid(field + ".required");
  }
  for (const field of ["description", "title"]) if (Object.hasOwn(tool, field) && typeof tool[field] !== "string") invalid(field);
  for (const field of ["annotations", "_meta", "execution"]) if (Object.hasOwn(tool, field) && !object(tool[field])) invalid(field);
  if (tool.annotations) {
    for (const field of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"])
      if (Object.hasOwn(tool.annotations, field) && typeof tool.annotations[field] !== "boolean") invalid("annotations." + field);
    if (Object.hasOwn(tool.annotations, "title") && typeof tool.annotations.title !== "string") invalid("annotations.title");
  }
  if (Object.hasOwn(tool, "icons")) {
    if (!Array.isArray(tool.icons)) invalid("icons");
    for (const icon of tool.icons) {
      if (!object(icon) || typeof icon.src !== "string") invalid("icons.src");
      for (const field of ["mimeType", "theme"]) if (Object.hasOwn(icon, field) && typeof icon[field] !== "string") invalid("icons." + field);
      if (Object.hasOwn(icon, "sizes") && (!Array.isArray(icon.sizes) || icon.sizes.some((value: any) => typeof value !== "string"))) invalid("icons.sizes");
    }
  }
}

async function discoverMcpTools(state: ServerState): Promise<Json> {
  const deadline = Math.min(performance.now() + MCP_HTTP_CONTROL_TIMEOUT_MS, state.setupDeadline ?? Infinity);
  const tools: Json[] = [], names = new Set<string>(), cursors = new Set<string>();
  let params: Json = {}, bytes = 0;
  for (let pageNumber = 0; pageNumber < 256; pageNumber++) {
    if (performance.now() >= deadline) throw new Error("MCP discovery deadline exceeded");
    const page = await rpcCall(state, "tools/list", params, deadline);
    if (!Array.isArray(page.tools)) throw new Error("tools/list response must contain a tools array");
    const more = Object.hasOwn(page, "nextCursor");
    // The transport already bounds a single page. Only pagination needs an
    // additional aggregate serialization budget on the common discovery path.
    if (pageNumber || more) {
      bytes += Buffer.byteLength(JSON.stringify(page), "utf8");
      if (bytes > MCP_HTTP_RESP_MAX) throw new Error("MCP discovery exceeds 16 MiB limit");
    }
    for (const tool of page.tools) {
      if (!tool || typeof tool !== "object" || typeof tool.name !== "string" || !tool.name)
        throw new Error("tools/list returned an invalid tool");
      validateMcpToolDefinition(tool);
      if (names.has(tool.name)) throw new Error("tools/list contains duplicate tool names");
      names.add(tool.name);
      tools.push(tool);
    }
    if (performance.now() >= deadline) throw new Error("MCP discovery deadline exceeded");
    if (!more) return { tools };
    if (typeof page.nextCursor !== "string") throw new Error("tools/list nextCursor must be a string");
    if (cursors.has(page.nextCursor)) throw new Error("tools/list repeated a pagination cursor");
    cursors.add(page.nextCursor);
    params = { cursor: page.nextCursor };
  }
  throw new Error("MCP discovery exceeds 256 pages");
}

async function probeServer(ns: string, config: McpServerConfig): Promise<AggregatedTool[]> {
  if (shuttingDown) throw new Error("server is shutting down");
  const state = makeServerState(ns, config, true);
  activeMcpProbes.add(state);
  try {
    if (state.transport === "stdio") {
      await spawnStdioServer(ns, state);
    } else {
      await initHttpServer(ns, state);
    }
    const result = await discoverMcpTools(state);
    const list: AggregatedTool[] = (result?.tools ?? []).map((t: any) => ({
      namespace: ns,
      originalName: t.name,
      definition: t,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object" },
    }));
    finishSetup(state);
    return list;
  } finally {
    unloadState(state);
    try {
      if (state.transport === "stdio") await retireStdioProcess(state);
    } finally { activeMcpProbes.delete(state); }
  }
}

async function loadAggregator(configPath: string): Promise<void> {
  let raw: string;
  try {
    raw = await readMcpConfigText(physicalPath(configPath, false));
  } catch (e: any) {
    console.error(`[mcp] failed to read config ${configPath}: ${e?.message ?? e}`);
    return;
  }
  let parsed: any;
  try {
    parsed = parseMcpJson(raw);
  } catch (e: any) {
    console.error(`[mcp] config is not valid JSON: ${e?.message ?? e}`);
    return;
  }
  const servers = parsed?.mcpServers;
  if (!servers || typeof servers !== "object") {
    console.error(`[mcp] config has no 'mcpServers' object; aggregation disabled`);
    return;
  }

  // Phase 1: validate all entries synchronously, collecting the valid ones.
  // Invalid entries get their skip messages out immediately so config errors
  // are obvious even if a probe later hangs.
  type Entry = { ns: string; cfg: McpServerConfig };
  const valid: Entry[] = [];
  for (const [ns, cfg] of Object.entries(servers as Record<string, McpServerConfig>)) {
    if (!NAMESPACE_RE.test(ns)) {
      console.error(`[mcp] skipping invalid namespace '${ns}' (must match ${NAMESPACE_RE})`);
      continue;
    }
    const validation = validateServerConfig(ns, cfg);
    if (!validation.ok) {
      console.error(`[mcp] skipping '${ns}': ${validation.reason}`);
      continue;
    }
    valid.push({ ns, cfg });
    aggregatorKnownServers.add(ns);
  }
  if (valid.length === 0) return;

  // Phase 2: probe with bounded fan-out. Each probe spawns its own subprocess
  // (or initializes its own HTTP session), so startup time is bounded by the
  // slowest server rather than the sum - but never fire more than
  // MAX_PROBE_CONCURRENCY at once (resource guard).
  const MAX_PROBE_CONCURRENCY = 5;
  const results: Array<{ ns: string; cfg: McpServerConfig; ok: boolean; list?: any; error?: string }> = [];
  let probeIdx = 0;
  async function worker() {
    while (probeIdx < valid.length) {
      const index = probeIdx++;
      const { ns, cfg } = valid[index];
      try {
        const list = await probeServer(ns, cfg);
        results[index] = { ns, cfg, ok: true, list };
      } catch (e: any) {
        results[index] = { ns, cfg, ok: false, error: e?.message ?? String(e) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_PROBE_CONCURRENCY, valid.length) }, worker));

  // Phase 3: register and log in the original config order so output is
  // deterministic regardless of which probe finished first.
  const ambiguousNames = new Set<string>();
  for (const r of results) {
    if (!r.ok) {
      console.error(`[mcp] probe '${r.ns}' failed: ${r.error}`);
      continue;
    }
    const state = makeServerState(r.ns, r.cfg, false);
    aggregatorServers.set(r.ns, state);
    for (const tool of r.list) {
      const prefixed = `${r.ns}__${tool.originalName}`;
      if (disallowedTools.includes(prefixed) || ambiguousNames.has(prefixed)) continue;
      if (aggregatedTools.has(prefixed)) {
        aggregatedTools.delete(prefixed);
        ambiguousNames.add(prefixed);
        console.error(`[mcp] ambiguous tool ${JSON.stringify(prefixed)} disabled; rename namespaces or upstream tools`);
      } else {
        aggregatedTools.set(prefixed, tool);
      }
    }
    const transport = r.cfg.type === "http" ? "http" : "stdio";
    console.error(`[mcp] probed '${r.ns}' (${transport}): ${r.list.length} tool(s) cached`);
  }
}

async function callAggregated(prefixed: string, args: Json): Promise<Json> {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("arguments must be an object");
  const tool = aggregatedTools.get(prefixed);
  if (!tool) throw new Error(`unknown aggregated tool: ${prefixed}`);
  const state = aggregatorServers.get(tool.namespace);
  if (!state) throw new Error(`no server state for namespace '${tool.namespace}'`);
  return withMcpActivity(state, async () => {
    await ensureSpawned(tool.namespace, state);
    finishSetup(state);
    return validateMcpToolResult(await rpcCall(state, "tools/call", { name: tool.originalName, arguments: args }));
  });
}

async function shutdownAggregator() {
  const cleanups: Promise<unknown>[] = [];
  for (const state of new Set([...aggregatorServers.values(), ...activeMcpProbes])) {
    unloadState(state);
    if (state.transport === "stdio") cleanups.push(retireStdioProcess(state));
  }
  aggregatorServers.clear();
  for (const cwd of [...cwdServers.keys()]) cleanups.push(unloadAllForCwd(cwd));
  cleanups.push(...mcpCleanupTasks);
  await Promise.allSettled(cleanups);
  if (mcpWindowsJobPreparation) await mcpWindowsJobPreparation.catch(() => {});
  if (mcpWindowsJobDirectory) {
    rmSync(mcpWindowsJobDirectory, {recursive: true, force: true, maxRetries: 10, retryDelay: 50});
    mcpWindowsJobDirectory = null;
  }
}

// Exact UTF-8 bytes of the shared Windows grep helper; requests travel only on stdin.
const GREP_WINDOWS_FALLBACK_UTF8_BASE64 = "JEVycm9yQWN0aW9uUHJlZmVyZW5jZSA9ICdTdG9wJwpbQ29uc29sZV06OklucHV0RW5jb2RpbmcgPSBbVGV4dC5VVEY4RW5jb2RpbmddOjpuZXcoJGZhbHNlKQpbQ29uc29sZV06Ok91dHB1dEVuY29kaW5nID0gW1RleHQuVVRGOEVuY29kaW5nXTo6bmV3KCRmYWxzZSkKJE91dHB1dEVuY29kaW5nID0gW0NvbnNvbGVdOjpPdXRwdXRFbmNvZGluZwp0cnkgewogICAgJHJlcXVlc3QgPSBbQ29uc29sZV06OkluLlJlYWRUb0VuZCgpIHwgQ29udmVydEZyb20tSnNvbgogICAgJG1hdGNoZXIgPSBbcmVnZXhdOjpuZXcoW3N0cmluZ10kcmVxdWVzdC5wYXR0ZXJuLCBbVGV4dC5SZWd1bGFyRXhwcmVzc2lvbnMuUmVnZXhPcHRpb25zXTo6Q3VsdHVyZUludmFyaWFudCwgW1RpbWVTcGFuXTo6RnJvbU1pbGxpc2Vjb25kcygyNTApKQogICAgJHJvb3QgPSBbSU8uUGF0aF06OkdldEZ1bGxQYXRoKFtzdHJpbmddJHJlcXVlc3QucGF0aCkKICAgICRnbG9iID0gW3N0cmluZ10kcmVxdWVzdC5nbG9iCiAgICAkZmlsdGVyID0gJG51bGwKICAgIGlmICgkZ2xvYikgewogICAgICAgICRnID0gJGdsb2IuUmVwbGFjZSgnXCcsJy8nKQogICAgICAgICRuZWdhdGUgPSAkZy5TdGFydHNXaXRoKCchJykKICAgICAgICBpZiAoJG5lZ2F0ZSkgeyAkZyA9ICRnLlN1YnN0cmluZygxKSB9CiAgICAgICAgaWYgKC1ub3QgJGcpIHsgdGhyb3cgJ0dsb2IgbXVzdCBub3QgYmUgZW1wdHkgYWZ0ZXIgbmVnYXRpb24nIH0KICAgICAgICAkZGVwdGg9MAogICAgICAgICRwcmVmaXggPSBpZiAoJGcuQ29udGFpbnMoJy8nKSkgeyAnXicgfSBlbHNlIHsgJyhefC8pJyB9CiAgICAgICAgJHJ4ID0gW1RleHQuU3RyaW5nQnVpbGRlcl06Om5ldygkcHJlZml4KQogICAgICAgIGZvciAoJGk9MDsgJGkgLWx0ICRnLkxlbmd0aDsgJGkrKykgewogICAgICAgICAgICAkYz0kZ1skaV0KICAgICAgICAgICAgaWYgKCRjIC1lcSAnKicpIHsKICAgICAgICAgICAgICAgIGlmICgkaSsxIC1sdCAkZy5MZW5ndGggLWFuZCAkZ1skaSsxXSAtZXEgJyonKSB7CiAgICAgICAgICAgICAgICAgICAgJGkrKwogICAgICAgICAgICAgICAgICAgIGlmICgkaSsxIC1sdCAkZy5MZW5ndGggLWFuZCAkZ1skaSsxXSAtZXEgJy8nKSB7ICRpKys7IFt2b2lkXSRyeC5BcHBlbmQoJyg/Oi4qLyk/JykgfQogICAgICAgICAgICAgICAgICAgIGVsc2UgeyBbdm9pZF0kcnguQXBwZW5kKCcuKicpIH0KICAgICAgICAgICAgICAgIH0gZWxzZSB7IFt2b2lkXSRyeC5BcHBlbmQoJ1teL10qJykgfQogICAgICAgICAgICB9IGVsc2VpZiAoJGMgLWVxICc/JykgeyBbdm9pZF0kcnguQXBwZW5kKCdbXi9dJykgfQogICAgICAgICAgICBlbHNlaWYgKCRjIC1lcSAnWycpIHsKICAgICAgICAgICAgICAgICRlbmQ9JGcuSW5kZXhPZignXScsJGkrMSkKICAgICAgICAgICAgICAgIGlmICgkZW5kIC1sdCAwKSB7IHRocm93ICdVbmNsb3NlZCBnbG9iIGNoYXJhY3RlciBjbGFzcycgfQogICAgICAgICAgICAgICAgJGJvZHk9JGcuU3Vic3RyaW5nKCRpKzEsJGVuZC0kaS0xKQogICAgICAgICAgICAgICAgaWYgKC1ub3QgJGJvZHkgLW9yICRib2R5LkNvbnRhaW5zKCdbJykgLW9yICRib2R5LkNvbnRhaW5zKCcvJykpIHsgdGhyb3cgJ0ludmFsaWQgZ2xvYiBjaGFyYWN0ZXIgY2xhc3MnIH0KICAgICAgICAgICAgICAgIGlmICgkYm9keS5TdGFydHNXaXRoKCchJykgLW9yICRib2R5LlN0YXJ0c1dpdGgoJ14nKSkgeyAkYm9keT0nXi8nKyRib2R5LlN1YnN0cmluZygxKSB9CiAgICAgICAgICAgICAgICBbdm9pZF0kcnguQXBwZW5kKCcoPyEvKVsnKyRib2R5KyddJyk7ICRpPSRlbmQKICAgICAgICAgICAgfSBlbHNlaWYgKCRjIC1lcSAneycpIHsgJGRlcHRoKys7IGlmKCRkZXB0aCAtZ3QgMTYpe3Rocm93ICdHbG9iIG5lc3RpbmcgbGltaXQgZXhjZWVkZWQnfTsgW3ZvaWRdJHJ4LkFwcGVuZCgnKD86JykgfQogICAgICAgICAgICBlbHNlaWYgKCRjIC1lcSAnfScpIHsgaWYoJGRlcHRoIC1lcSAwKXt0aHJvdyAnVW5tYXRjaGVkIGdsb2IgYnJhY2UnfTsgJGRlcHRoLS07IFt2b2lkXSRyeC5BcHBlbmQoJyknKSB9CiAgICAgICAgICAgIGVsc2VpZiAoJGMgLWVxICcsJyAtYW5kICRkZXB0aCAtZ3QgMCkgeyBbdm9pZF0kcnguQXBwZW5kKCd8JykgfQogICAgICAgICAgICBlbHNlIHsgW3ZvaWRdJHJ4LkFwcGVuZChbcmVnZXhdOjpFc2NhcGUoW3N0cmluZ10kYykpIH0KICAgICAgICB9CiAgICAgICAgaWYoJGRlcHRoIC1uZSAwKXt0aHJvdyAnVW5jbG9zZWQgZ2xvYiBicmFjZSd9CiAgICAgICAgW3ZvaWRdJHJ4LkFwcGVuZCgnKD86Ly4qKT8kJykKICAgICAgICAkZmlsdGVyPVtyZWdleF06Om5ldygkcnguVG9TdHJpbmcoKSxbVGV4dC5SZWd1bGFyRXhwcmVzc2lvbnMuUmVnZXhPcHRpb25zXTo6Q3VsdHVyZUludmFyaWFudCxbVGltZVNwYW5dOjpGcm9tTWlsbGlzZWNvbmRzKDI1MCkpCiAgICB9CiAgICAkYmFzZSA9IGlmIChbSU8uRGlyZWN0b3J5XTo6RXhpc3RzKCRyb290KSkgeyAkcm9vdC5UcmltRW5kKCdcJywnLycpKydcJyB9IGVsc2UgeyBbSU8uUGF0aF06OkdldERpcmVjdG9yeU5hbWUoJHJvb3QpLlRyaW1FbmQoJ1wnLCcvJykrJ1wnIH0KICAgICRzdGFjaz1bQ29sbGVjdGlvbnMuR2VuZXJpYy5TdGFja1tzdHJpbmddXTo6bmV3KCk7JHN0YWNrLlB1c2goJHJvb3QpCiAgICAkbWF0Y2hlZD0kZmFsc2U7JHZpc2l0ZWQ9MAogICAgd2hpbGUgKCRzdGFjay5Db3VudCAtZ3QgMCkgewogICAgICAgICR2aXNpdGVkKys7aWYoJHZpc2l0ZWQgLWd0IDEwMDAwMCl7dGhyb3cgJ1NlYXJjaCBlbnRyeSBsaW1pdCBleGNlZWRlZCd9CiAgICAgICAgJHBhdGg9JHN0YWNrLlBvcCgpOyRhdHRycz1bSU8uRmlsZV06OkdldEF0dHJpYnV0ZXMoJHBhdGgpCiAgICAgICAgaWYgKCgkYXR0cnMgLWJhbmQgW0lPLkZpbGVBdHRyaWJ1dGVzXTo6UmVwYXJzZVBvaW50KSAtbmUgMCkgeyBjb250aW51ZSB9CiAgICAgICAgaWYgKCgkYXR0cnMgLWJhbmQgW0lPLkZpbGVBdHRyaWJ1dGVzXTo6RGlyZWN0b3J5KSAtbmUgMCkgewogICAgICAgICAgICBmb3JlYWNoICgkZW50cnkgaW4gW0lPLkRpcmVjdG9yeV06OkVudW1lcmF0ZUZpbGVTeXN0ZW1FbnRyaWVzKCRwYXRoKSkgewogICAgICAgICAgICAgICAgJG5hbWU9W0lPLlBhdGhdOjpHZXRGaWxlTmFtZSgkZW50cnkpCiAgICAgICAgICAgICAgICBpZiAoJG5hbWUuU3RhcnRzV2l0aCgnLicpIC1hbmQgLW5vdCAoJGZpbHRlciAtYW5kIC1ub3QgJG5lZ2F0ZSkpIHsgY29udGludWUgfQogICAgICAgICAgICAgICAgaWYgKChbSU8uRmlsZV06OkdldEF0dHJpYnV0ZXMoJGVudHJ5KSAtYmFuZCBbSU8uRmlsZUF0dHJpYnV0ZXNdOjpIaWRkZW4pIC1uZSAwIC1hbmQgLW5vdCAoJGZpbHRlciAtYW5kIC1ub3QgJG5lZ2F0ZSkpIHsgY29udGludWUgfQogICAgICAgICAgICAgICAgaWYoJHN0YWNrLkNvdW50IC1nZSAxMDAwMDApe3Rocm93ICdTZWFyY2ggcGVuZGluZyBlbnRyeSBsaW1pdCBleGNlZWRlZCd9CiAgICAgICAgICAgICAgICAkc3RhY2suUHVzaCgkZW50cnkpCiAgICAgICAgICAgIH0KICAgICAgICAgICAgY29udGludWUKICAgICAgICB9CiAgICAgICAgJHJlbGF0aXZlPSRwYXRoLlN1YnN0cmluZygkYmFzZS5MZW5ndGgpLlJlcGxhY2UoJ1wnLCcvJykKICAgICAgICBpZiAoJGZpbHRlcikgeyAkaW5jbHVkZWQ9JGZpbHRlci5Jc01hdGNoKCRyZWxhdGl2ZSk7IGlmICgkbmVnYXRlKSB7ICRpbmNsdWRlZD0tbm90ICRpbmNsdWRlZCB9OyBpZiAoLW5vdCAkaW5jbHVkZWQpIHsgY29udGludWUgfSB9CiAgICAgICAgJHN0cmVhbT1bSU8uRmlsZV06Ok9wZW4oJHBhdGgsW0lPLkZpbGVNb2RlXTo6T3BlbixbSU8uRmlsZUFjY2Vzc106OlJlYWQsW0lPLkZpbGVTaGFyZV06OlJlYWRXcml0ZSkKICAgICAgICB0cnkgewogICAgICAgICAgICAkaW5pdGlhbExlbmd0aD0kc3RyZWFtLkxlbmd0aAogICAgICAgICAgICBpZiAoJGluaXRpYWxMZW5ndGggLWd0IDEwNDg1NzYwMCkgeyB0aHJvdyAnU2VhcmNoIGZpbGUgZXhjZWVkcyAxMDAgTWlCIGxpbWl0JyB9CiAgICAgICAgICAgICRwcm9iZT1bYnl0ZVtdXTo6bmV3KDgxOTIpOyRjb3VudD0kc3RyZWFtLlJlYWQoJHByb2JlLDAsJHByb2JlLkxlbmd0aCkKICAgICAgICAgICAgJGJpbmFyeT0kZmFsc2U7Zm9yKCRpPTA7JGkgLWx0ICRjb3VudDskaSsrKXtpZigkcHJvYmVbJGldIC1lcSAwKXskYmluYXJ5PSR0cnVlO2JyZWFrfX0KICAgICAgICAgICAgaWYoJGJpbmFyeSl7Y29udGludWV9OyRzdHJlYW0uUG9zaXRpb249aWYoJGNvdW50IC1nZSAzIC1hbmQgJHByb2JlWzBdIC1lcSAyMzkgLWFuZCAkcHJvYmVbMV0gLWVxIDE4NyAtYW5kICRwcm9iZVsyXSAtZXEgMTkxKXszfWVsc2V7MH0KICAgICAgICAgICAgJHJlYWRlcj1bSU8uU3RyZWFtUmVhZGVyXTo6bmV3KCRzdHJlYW0sW1RleHQuVVRGOEVuY29kaW5nXTo6bmV3KCRmYWxzZSwkdHJ1ZSksJGZhbHNlLDY1NTM2LCR0cnVlKQogICAgICAgICAgICB0cnkgewogICAgICAgICAgICAgICAgJGxpbmVObz0wOyRsaW5lPVtUZXh0LlN0cmluZ0J1aWxkZXJdOjpuZXcoKTskY2hhcnM9W2NoYXJbXV06Om5ldyg2NTUzNikKICAgICAgICAgICAgICAgIHdoaWxlKCgkcmVhZD0kcmVhZGVyLlJlYWQoJGNoYXJzLDAsJGNoYXJzLkxlbmd0aCkpIC1ndCAwKSB7CiAgICAgICAgICAgICAgICAgICAgaWYoJHN0cmVhbS5Qb3NpdGlvbiAtZ3QgJGluaXRpYWxMZW5ndGggLW9yICRzdHJlYW0uUG9zaXRpb24gLWd0IDEwNDg1NzYwMCl7dGhyb3cgJ1NlYXJjaCBmaWxlIGdyZXcgYmV5b25kIGl0cyBpbml0aWFsIHNpemUnfQogICAgICAgICAgICAgICAgICAgICRjaHVuaz1bc3RyaW5nXTo6bmV3KCRjaGFycywwLCRyZWFkKTskb2Zmc2V0PTAKICAgICAgICAgICAgICAgICAgICB3aGlsZSgkb2Zmc2V0IC1sdCAkY2h1bmsuTGVuZ3RoKSB7CiAgICAgICAgICAgICAgICAgICAgICAgICRlbmQ9JGNodW5rLkluZGV4T2YoImBuIiwkb2Zmc2V0KQogICAgICAgICAgICAgICAgICAgICAgICAkbGVuZ3RoPWlmKCRlbmQgLWx0IDApeyRjaHVuay5MZW5ndGgtJG9mZnNldH1lbHNleyRlbmQtJG9mZnNldH0KICAgICAgICAgICAgICAgICAgICAgICAgaWYoJGxpbmUuTGVuZ3RoKyRsZW5ndGggLWd0IDEwNDg1NzYpe3Rocm93ICdTZWFyY2ggbGluZSBleGNlZWRzIDEwNDg1NzYgY2hhcmFjdGVyIGxpbWl0J30KICAgICAgICAgICAgICAgICAgICAgICAgW3ZvaWRdJGxpbmUuQXBwZW5kKCRjaHVuaywkb2Zmc2V0LCRsZW5ndGgpCiAgICAgICAgICAgICAgICAgICAgICAgIGlmKCRlbmQgLWx0IDApe2JyZWFrfQogICAgICAgICAgICAgICAgICAgICAgICAkbGluZU5vKys7JHRleHQ9JGxpbmUuVG9TdHJpbmcoKTtpZigkdGV4dC5FbmRzV2l0aCgiYHIiKSl7JHRleHQ9JHRleHQuU3Vic3RyaW5nKDAsJHRleHQuTGVuZ3RoLTEpfQogICAgICAgICAgICAgICAgICAgICAgICBpZigkbWF0Y2hlci5Jc01hdGNoKCR0ZXh0KSl7W0NvbnNvbGVdOjpPdXQuV3JpdGVMaW5lKCRwYXRoKyc6JyskbGluZU5vKyc6JyskdGV4dCk7JG1hdGNoZWQ9JHRydWV9CiAgICAgICAgICAgICAgICAgICAgICAgIFt2b2lkXSRsaW5lLkNsZWFyKCk7JG9mZnNldD0kZW5kKzEKICAgICAgICAgICAgICAgICAgICB9CiAgICAgICAgICAgICAgICB9CiAgICAgICAgICAgICAgICBpZigkc3RyZWFtLkxlbmd0aCAtbmUgJGluaXRpYWxMZW5ndGgpe3Rocm93ICdTZWFyY2ggZmlsZSBzaXplIGNoYW5nZWQgZHVyaW5nIHNlYXJjaCd9CiAgICAgICAgICAgICAgICBpZigkbGluZS5MZW5ndGggLWd0IDApeyRsaW5lTm8rKzskdGV4dD0kbGluZS5Ub1N0cmluZygpO2lmKCRtYXRjaGVyLklzTWF0Y2goJHRleHQpKXtbQ29uc29sZV06Ok91dC5Xcml0ZUxpbmUoJHBhdGgrJzonKyRsaW5lTm8rJzonKyR0ZXh0KTskbWF0Y2hlZD0kdHJ1ZX19CiAgICAgICAgICAgIH0gZmluYWxseSB7JHJlYWRlci5EaXNwb3NlKCl9CiAgICAgICAgfSBmaW5hbGx5IHskc3RyZWFtLkRpc3Bvc2UoKX0KICAgIH0KICAgIGlmKCRtYXRjaGVkKXtleGl0IDB9ZWxzZXtleGl0IDF9Cn0gY2F0Y2ggewogICAgW0NvbnNvbGVdOjpFcnJvci5Xcml0ZUxpbmUoJF8uRXhjZXB0aW9uLk1lc3NhZ2UpCiAgICBleGl0IDIKfQo=";

async function runGrep(args: unknown): Promise<string> {
  const validated = validateGrepArguments(args);
  const glob = validated.glob.replace(/\\/g, "/");
  if (!(await acquireShellSlot())) throw new Error("Too many concurrent shell executions, please try again later");
  let proc: ReturnType<typeof spawn> | undefined;
  let captures: ReturnType<typeof startCapturedPump>[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inputSink: any;
  try {
    const deadline = performance.now() + 30_000;
    const rg = Bun.which(IS_WINDOWS ? "rg.exe" : "rg");
    let cmd: string[], input: string | undefined;
    if (rg) {
      cmd = [resolve(rg), "--no-config", "--line-number", "--with-filename", "--no-heading", "--color=never",
        ...(glob ? ["--glob", glob] : []), "--", validated.pattern, validated.path];
    } else if (IS_WINDOWS) {
      const systemRoot = Object.entries(process.env).find(([key]) => key.toLowerCase() === "systemroot")?.[1] ?? "C:/Windows";
      const script = Buffer.from(GREP_WINDOWS_FALLBACK_UTF8_BASE64, "base64").toString("utf8");
      cmd = [resolve(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
      input = JSON.stringify({ path: validated.path, pattern: validated.pattern, glob });
    } else {
      const grep = Bun.which("grep");
      if (!grep) throw new Error("grep backend unavailable: neither ripgrep nor grep was found");
      cmd = [resolve(grep), "-rEnH", ...(glob ? ["--include", glob] : []), "--", validated.pattern, validated.path];
    }
    proc = spawn({
      cmd, cwd: validated.cwd, env: buildChildEnv({}),
      stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe",
      detached: process.platform !== "win32",
    });
    const child = proc;
    const stdout = { text: "" }, stderr = { text: "" };
    captures = [startCapturedPump(child.stdout as any, stdout), startCapturedPump(child.stderr as any, stderr)];
    let exited = false;
    const exit = child.exited.then(code => { exited = true; return code; });
    const running = () => !exited && typeof child.exitCode !== "number" && !child.signalCode;
    inputSink = input === undefined ? undefined : child.stdin;
    const written = (async () => {
      if (!inputSink) return;
      inputSink.write(Buffer.from(input!, "utf8"));
      await inputSink.flush();
      await inputSink.end();
    })();
    const complete = Promise.all([exit, written, ...captures.map(capture => capture.done)]);
    const expiration = new Promise<"timeout">(resolve => {
      timer = setTimeout(() => resolve("timeout"), Math.max(0, deadline - performance.now()));
    });
    try {
      const result = await Promise.race([complete, expiration]);
      if (result === "timeout") throw new Error("grep timed out after 30000ms");
      if (captures.some(capture => capture.incomplete)) throw new Error("grep output capture incomplete");
      const code = result[0];
      if (code === 1) return "(no matches)";
      if (code !== 0) throw new Error(`grep backend failed (exit=${code}): ${stderr.text.trim() || "no diagnostic output"}`);
      return stdout.text || "(no matches)";
    } catch (error) {
      const cleanupDeadline = performance.now() + 3000;
      const terminated = !running() || await killProcessTree(child.pid, running, cleanupDeadline);
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const remaining = Math.min(1000, Math.max(0, cleanupDeadline - performance.now()));
        if (remaining > 0) await Promise.race([
          complete.catch(() => {}), new Promise(resolve => { drainTimer = setTimeout(resolve, remaining); }),
        ]);
      } finally { if (drainTimer) clearTimeout(drainTimer); }
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${reason}${terminated ? "" : "; process-tree termination could not be confirmed"}`);
    }
  } finally {
    if (timer) clearTimeout(timer);
    for (const capture of captures) capture.cancel();
    // Never wait indefinitely on stdin closure after a backend stops reading.
    if (inputSink) { try { void Promise.resolve(inputSink.end()).catch(() => {}); } catch {} }
    releaseShellSlot();
  }
}

function validateGrepArguments(args: unknown): { cwd: string; pattern: string; path: string; glob: string } {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("grep arguments must be an object");
  const values = args as Record<string, unknown>;
  const owns = (key: string) => Object.prototype.hasOwnProperty.call(values, key);
  if (!owns("cwd") || !owns("pattern")) throw new Error("grep requires cwd and pattern strings");
  const string = (name: string, value: unknown, nonempty = false): string => {
    if (typeof value !== "string" || (nonempty && !value.length)) throw new Error(`${name} must be ${nonempty ? "a nonempty" : "a"} string`);
    if (value.includes("\0")) throw new Error(`${name} contains NUL`);
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(`${name} contains invalid Unicode`);
      } else if (c >= 0xdc00 && c <= 0xdfff) throw new Error(`${name} contains invalid Unicode`);
    }
    return value;
  };
  const cwd = string("cwd", values.cwd, true);
  const pattern = string("pattern", values.pattern);
  const path = owns("path") ? string("path", values.path, true) : ".";
  const glob = owns("glob") ? string("glob", values.glob) : "";
  if (glob) {
    const normalized = glob.replace(/\\/g, "/");
    if (normalized.startsWith("/") || normalized.startsWith("~") || /^[A-Za-z]:/.test(normalized)) throw new Error("glob must be relative");
    if (normalized.split("/").includes("..")) throw new Error("glob may not contain '..'");
  }
  const base = physicalPath(cwd, false);
  if (!statSync(base).isDirectory()) throw new Error("cwd must be an existing directory");
  const target = physicalPath(isAbsolute(path) ? path : `${base}${sep}${path}`, true);
  const contained = (root: string) => {
    const offset = relative(root, target);
    return offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
  };
  if (!contained(base) && !contained(physicalPath(RESULT_SPILL_ROOT, false))) throw new Error("path escapes cwd");
  const stat = lstatSync(target);
  if (!stat.isFile() && !stat.isDirectory()) throw new Error("grep path must be a regular file or directory");
  if ((process.platform === "win32" ? /[\\/]$/ : /\/$/).test(path) && !stat.isDirectory()) throw new Error("grep path ending with a separator must be a directory");
  return { cwd: base, pattern, path: target, glob };
}

type FindToken = [string, any];
const FIND_NOISE = new Set(["node_modules", ".git", ".next", ".nuxt", ".turbo", ".cache", "dist", "build", "out", "target", "coverage", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".idea", ".vscode"]);
function findPatterns(pattern: string): { glob: string; tokens: FindToken[] }[] {
  pattern = pattern.replace(/\\/g, "/");
  if (pattern.startsWith("/") || pattern.startsWith("~") || /^[A-Za-z]:/.test(pattern)) throw new Error("pattern must be relative to the working directory");
  if (pattern.split("/").includes("..")) throw new Error("pattern may not contain '..'");
  while (pattern.startsWith("./")) pattern = pattern.slice(2);
  if (!pattern || Array.from(pattern).length > 4096) throw new Error("pattern must contain 1 to 4096 characters");
  const pending: [string, number][] = [[pattern, 0]], expanded: string[] = [];
  while (pending.length) {
    const [value, depth] = pending.pop()!;
    let start = -1, balance = 0, inClass = false, cut = 0, end = -1, classFirst = -1;
    const pieces: string[] = [];
    for (let i = 0; i < value.length; i++) {
      const ch = value[i];
      if (ch === "[" && !inClass) {
        inClass = true; classFirst = i + 1;
        if (value[classFirst] === "!" || value[classFirst] === "^") classFirst++;
      } else if (ch === "]" && inClass && i > classFirst) inClass = false;
      else if (!inClass) {
        if (ch === "{") { if (!balance) { start = i; cut = i + 1; } balance++; }
        else if (ch === "}") {
          if (!balance) throw new Error("unmatched glob brace");
          if (!--balance) { pieces.push(value.slice(cut, i)); end = i; break; }
        } else if (ch === "," && balance === 1) { pieces.push(value.slice(cut, i)); cut = i + 1; }
      }
    }
    if (balance) throw new Error("unmatched glob brace");
    if (end >= 0) {
      if (depth >= 16 || pieces.length < 2) throw new Error("glob braces require alternatives and at most 16 expansions in depth");
      for (const piece of pieces) pending.push([value.slice(0, start) + piece + value.slice(end + 1), depth + 1]);
      if (pending.length + expanded.length > 256) throw new Error("glob exceeds 256 alternatives");
    } else expanded.push(value);
  }
  let total = 0;
  return expanded.map(value => {
    if (value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:/.test(value) || value.split("/").includes(".."))
      throw new Error("glob alternatives must be relative and may not contain '..'");
    const glob = value.includes("/") ? value : `**/${value}`;
    const chars = Array.from(glob), tokens: FindToken[] = [];
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === "*") {
        let j = i; while (chars[j] === "*") j++;
        const whole = (!i || chars[i - 1] === "/") && (j === chars.length || chars[j] === "/");
        if (j - i >= 2 && whole) { tokens.push([j < chars.length ? "G" : "D", null]); if (j < chars.length) j++; }
        else tokens.push(["S", null]);
        i = j - 1;
      } else if (ch === "?") tokens.push(["Q", null]);
      else if (ch === "[") {
        let j = i + 1; const negate = chars[j] === "!" || chars[j] === "^"; if (negate) j++;
        const ranges: [number, number][] = [];
        while (j < chars.length && (chars[j] !== "]" || !ranges.length)) {
          const lo = chars[j].codePointAt(0)!; let hi = lo;
          if (chars[j] === "/") throw new Error("glob classes cannot contain separators");
          if (j + 2 < chars.length && chars[j + 1] === "-" && chars[j + 2] !== "]") {
            hi = chars[j + 2].codePointAt(0)!;
            if (hi < lo || chars[j + 2] === "/") throw new Error("invalid glob class range");
            j += 3;
          } else j++;
          ranges.push([lo, hi]);
        }
        if (j === chars.length || !ranges.length) throw new Error("unclosed or empty glob class");
        tokens.push(["C", [negate, ranges]]); i = j;
      } else if ("{}]".includes(ch)) throw new Error("unmatched glob delimiter");
      else tokens.push(["L", ch]);
    }
    total += tokens.length; if (total > 16384) throw new Error("glob exceeds token budget");
    return { glob, tokens };
  });
}
function findMatches(tokens: FindToken[], value: string, budget: { work: number }, prefix = false): boolean {
  const chars = Array.from(value), length = chars.length;
  budget.work -= tokens.reduce((sum, [kind, data]) => sum + (kind === "C" ? Math.max(1, data[1].length) : 1), 0) * (length + 1);
  if (budget.work < 0) throw new Error("find exceeds glob matching work limit");
  let previous = new Uint8Array(length + 1); previous[0] = 1;
  for (const [kind, data] of tokens) {
    const current = new Uint8Array(length + 1);
    if (kind === "S" || kind === "D" || kind === "G") {
      current[0] = previous[0]; let seen = !!previous[0];
      for (let j = 1; j <= length; j++) {
        const ch = chars[j - 1];
        if (kind === "G") { current[j] = +(!!previous[j] || (seen && ch === "/")); seen ||= !!previous[j]; }
        else current[j] = +(!!previous[j] || (!!current[j - 1] && (kind === "D" || ch !== "/")));
      }
    } else {
      for (let j = 1; j <= length; j++) {
        if (!previous[j - 1]) continue;
        const ch = chars[j - 1]; let match: boolean;
        if (kind === "L") match = ch === data;
        else if (kind === "Q") match = ch !== "/";
        else { const [negate, ranges] = data; const cp = ch.codePointAt(0)!; match = ch !== "/" && ranges.some(([lo, hi]: [number, number]) => lo <= cp && cp <= hi) !== negate; }
        current[j] = +(!!previous[j - 1] && match);
      }
    }
    if (prefix && current[length]) return true;
    previous = current;
  }
  return !!previous[length];
}
async function runFind(args: unknown): Promise<string> {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("find arguments must be an object");
  const values = args as Record<string, unknown>;
  const has = (key: string) => Object.prototype.hasOwnProperty.call(values, key);
  const { cwd, pattern, path } = validateGrepArguments({ cwd: values.cwd, pattern: values.pattern, ...(has("path") ? { path: values.path } : {}) });
  if (has("include_hidden") && typeof values.include_hidden !== "boolean") throw new Error("include_hidden must be a boolean");
  if (!statSync(path).isDirectory()) throw new Error("path must be an existing directory");
  const patterns = findPatterns(pattern);
  const parts = patterns.flatMap(p => p.glob.split("/"));
  const explicit = new Set(parts.filter(p => !/[*?\[]/.test(p)));
  const hidden = parts.filter(p => p.startsWith(".")).map(p => findPatterns(p)[0].tokens.slice(1));
  const deadline = performance.now() + 30000, budget = { work: 10_000_000 };
  const pending: [string, string, number][] = [[path, "", 0]], results: string[] = [];
  let visited = 0, bytes = 0;
  const check = () => { if (performance.now() >= deadline) throw new Error("find timed out after 30000 ms"); };
  while (pending.length) {
    const [directory, prefix, depth] = pending.pop()!; check();
    if (relative(directory, realpathSync(directory))) continue;
    const entries = await fsOpenDir(directory);
    try {
      for await (const entry of entries) {
        if (++visited > 100000) throw new Error("find exceeds 100000 filesystem entries");
        check();
        const name = entry.name;
        if (name.startsWith(".") && values.include_hidden !== true && !hidden.some(tokens => findMatches(tokens, name, budget))) continue;
        const full = `${directory}${sep}${name}`, info = lstatSync(full);
        if (info.isSymbolicLink()) continue;
        const rel = prefix + name;
        if (info.isDirectory()) {
          if (FIND_NOISE.has(name) && !explicit.has(name)) continue;
          if (!patterns.some(p => findMatches(p.tokens, rel + "/", budget, true))) continue;
          if (depth >= 256) throw new Error("find exceeds 256 directory levels");
          pending.push([full, rel + "/", depth + 1]);
        } else if (info.isFile() && patterns.some(p => findMatches(p.tokens, rel, budget))) {
          const physical = realpathSync(full), offset = relative(cwd, physical);
          if (offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset)) continue;
          const result = offset.split(sep).join("/"); bytes += Buffer.byteLength(result, "utf8") + 1;
          if (results.length >= 10000 || bytes > 1000000) throw new Error("find result limit exceeded (10000 files or 1000000 UTF-8 bytes); narrow the pattern/path");
          results.push(result);
        }
      }
    } finally {
      try { await entries.close(); }
      catch (e: any) { if (e.code !== "ERR_DIR_CLOSED") throw e; }
    }
  }
  return results.length ? results.sort().join("\n") : "(no matches)";
}

async function runLs(args: unknown): Promise<string> {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("ls arguments must be an object");
  const values = args as Record<string, unknown>;
  const { path } = validateGrepArguments({ cwd: values.cwd, pattern: "", ...(Object.prototype.hasOwnProperty.call(values, "path") ? { path: values.path } : {}) });
  if (!statSync(path).isDirectory()) throw new Error("path must be an existing directory");
  const lines: string[] = [], deadline = performance.now() + 30000;
  let size = 0;
  const entries = await fsOpenDir(path);
  try {
    for await (const entry of entries) {
      if (lines.length >= 100000) throw new Error("ls exceeds 100000 entries; choose a narrower directory");
      if (performance.now() >= deadline) throw new Error("ls timed out after 30000 ms");
      const name = entry.name;
      if (Buffer.from(name, "utf8").toString("utf8") !== name) throw new Error("directory entry name contains invalid Unicode");
      let line: string;
      try {
        const info = lstatSync(`${path}${sep}${name}`);
        const kind = info.isSymbolicLink() ? "l" : info.isDirectory() ? "d" : info.isFile() ? "-" : "?";
        line = kind === "?" ? `? ${name}` : `${kind}${String(kind === "-" ? info.size : 0).padStart(10)} ${name}`;
      } catch { line = `? ${name}`; }
      size += Buffer.byteLength(line, "utf8") + 1;
      if (size > 1000000) throw new Error("ls exceeds 1000000 UTF-8 bytes; choose a narrower directory");
      lines.push(line);
    }
  } finally {
    try { await entries.close(); } catch (e: any) { if (e.code !== "ERR_DIR_CLOSED") throw e; }
  }
  return lines.sort().join("\n");
}

// ---------- tools ----------
const tools: Record<string, Tool> = {
  read: {
    description: "Read a file. Optional line range [start,end] (1-indexed, inclusive). Pass no_truncate=true to disable output truncation.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        path: { type: "string" },
        range: { type: "array", items: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, minItems: 2, maxItems: 2 },
        no_truncate: { type: "boolean" },
      },
      required: ["cwd", "path"],
    },
    handler: readFileText,
  },

  write: {
    description: "Write/overwrite a file with the given content.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["cwd", "path", "content"],
    },
    handler: writeFileAtomic,
  },

  edit: {
    description: "Replace old_str with new_str in a file. old_str must be nonempty and occur exactly once, including overlapping matches.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        path: { type: "string" },
        old_str: { type: "string", minLength: 1 },
        new_str: { type: "string" },
      },
      required: ["cwd", "path", "old_str", "new_str"],
    },
    handler: editFileAtomic,
  },

  multi_edit: {
    description: "Apply ordered edits after validating and staging the entire batch; atomically replace each file with guarded rollback on failure. Simultaneous multi-file visibility and crash atomicity are not guaranteed. Limited to 1000 edits and 100 MiB total original/working text.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        edits: {
          type: "array",
          minItems: 1,
          maxItems: 1000,
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              old_str: { type: "string", minLength: 1 },
              new_str: { type: "string" },
            },
            required: ["path", "old_str", "new_str"],
          },
        },
      },
      required: ["cwd", "edits"],
    },
    handler: multiEditFiles,
  },

  bash: {
    description: "Run a bash command. Returns combined stdout+stderr. If still running at 60s with no timeout_ms set, auto-detaches into the `job` tool (the return value carries the job id). Pass an explicit timeout_ms to force kill-on-timeout instead.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", minLength: 1 },
        command: { type: "string" },
        timeout_ms: { type: "integer", minimum: 1, maximum: 2147483647 },
      },
      required: ["cwd", "command"],
    },
    handler: (args) => runShellTool(args, bashCmd),
  },

  shell: {
    description: "Run a POSIX sh command. Returns combined stdout+stderr. If still running at 60s with no timeout_ms set, auto-detaches into the `job` tool (the return value carries the job id). Pass an explicit timeout_ms to force kill-on-timeout instead.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", minLength: 1 },
        command: { type: "string" },
        timeout_ms: { type: "integer", minimum: 1, maximum: 2147483647 },
      },
      required: ["cwd", "command"],
    },
    handler: (args) => runShellTool(args, shCmd),
  },

  command: {
    description: "Run a Windows CMD command. Returns combined stdout+stderr. If still running at 60s with no timeout_ms set, auto-detaches into the `job` tool (the return value carries the job id). Pass an explicit timeout_ms to force kill-on-timeout instead.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", minLength: 1 },
        command: { type: "string" },
        timeout_ms: { type: "integer", minimum: 1, maximum: 2147483647 },
      },
      required: ["cwd", "command"],
    },
    handler: (args) => runShellTool(args, cmdCmd),
  },

  powershell: {
    description: "Run a PowerShell command. Returns combined stdout+stderr. If still running at 60s with no timeout_ms set, auto-detaches into the `job` tool (the return value carries the job id). Pass an explicit timeout_ms to force kill-on-timeout instead.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", minLength: 1 },
        command: { type: "string" },
        timeout_ms: { type: "integer", minimum: 1, maximum: 2147483647 },
      },
      required: ["cwd", "command"],
    },
    handler: (args) => runShellTool(args, pwshCmd),
  },

  grep: {
    description: "Search files by regex, preferring ripgrep. Windows fallback uses PowerShell/.NET; POSIX fallback uses grep ERE. Regex and ignore features may differ by backend. Windows fallback skips hidden, reparse and binary files by default; explicit targets or positive globs allow hidden files. Ignore files require ripgrep.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", minLength: 1 },
        pattern: { type: "string" },
        path: { type: "string", minLength: 1 },
        glob: { type: "string" },
      },
      required: ["cwd", "pattern"],
    },
    handler: runGrep,
  },

  find: {
    description: "Find regular files with case-sensitive globs (*, ?, [], {a,b}, **). Bare patterns match at any depth. Returns sorted cwd-relative paths. Prunes common noise directories unless explicitly named; dot names require include_hidden=true or an explicit dot component. Skips symlink/reparse entries during traversal. Search/output/complexity limits return errors; narrow the pattern or path (maximum 10000 results, 1000000 UTF-8 bytes, 100000 entries, 256 directory levels).",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        pattern: { type: "string" },
        path: { type: "string" },
        include_hidden: { type: "boolean" },
      },
      required: ["cwd", "pattern"],
    },
    handler: runFind,
  },

  ls: {
    description: "List one directory, including hidden entries. Sorted lines contain type, byte size and name: '-' file, 'd' directory, 'l' link (target metadata is not followed), '?' unavailable or unsupported metadata. Directory/link sizes are 0. Errors above 100000 entries or 1000000 UTF-8 output bytes.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        path: { type: "string" },
      },
      required: ["cwd"],
    },
    handler: runLs,
  },

  job: {
    description: "Manage background jobs using the selected shell. mode: list|view|start|stop; list is in creation order. command is required for start, or holds the job id for view/stop. cwd is required but used only for start. timeout_ms is stop grace (default 500 ms, capped at 1000); Windows forces termination immediately. Stop uses a shared 3000 ms process/capture confirmation deadline and reports incomplete cleanup as an error.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        mode: { type: "string", enum: ["list", "view", "start", "stop"] },
        command: { type: "string" },
        timeout_ms: { type: "number" },
      },
      required: ["cwd", "mode"],
    },
    handler: async (args: unknown) => {
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("job arguments must be an object");
      const values = args as Record<string, unknown>;
      const string = (key: string, required = true): string | undefined => {
        if (!required && !Object.prototype.hasOwnProperty.call(values, key)) return undefined;
        const value = values[key];
        if (typeof value !== "string" || (required && !value.length)) throw new Error(`${key} must be ${required ? "a nonempty" : "a"} string`);
        if (value.includes("\0") || Buffer.from(value, "utf8").toString("utf8") !== value) throw new Error(`${key} contains NUL or invalid Unicode`);
        return value;
      };
      let cwd = string("cwd")!;
      const mode = string("mode")!;
      const command = string("command", mode !== "list");
      let timeout_ms = 500;
      if (Object.prototype.hasOwnProperty.call(values, "timeout_ms")) {
        const timeout = values.timeout_ms;
        if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > 2147483647)
          throw new Error("timeout_ms must be an integer from 1 to 2147483647");
        timeout_ms = timeout;
      }
      if (mode === "start") {
        cwd = realpathSync(cwd);
        if (!statSync(cwd).isDirectory()) throw new Error("cwd must be an existing directory");
      }
      if (mode !== "list" && mode !== "start" && mode !== "view" && mode !== "stop") {
        throw new Error(`unknown mode: ${mode}`);
      }
      if (mode === "list") {
        if (jobs.size === 0) return "(no jobs)";
        return [...jobs.values()]
          .map((j) => `${j.id} [${j.status}${j.exitCode != null ? ` ${j.exitCode}` : ""}] ${j.command}`)
          .join("\n");
      }
      if (mode === "start") {
        if (!command) throw new Error("command required");
        const j = await startJob(command, cwd);
        return `started ${j.id}`;
      }
      if (!command) throw new Error("job id required (pass as command)");
      const j = jobs.get(command);
      if (!j) throw new Error(`no such job: ${command}`);
      if (mode === "view") {
        return `[${j.id}] ${j.command}\n[${j.status}${j.exitCode != null ? ` ${j.exitCode}` : ""}]\n${j.output}`;
      }
      if (mode === "stop") {
        if (j.status !== "running") return `${j.id} already ${j.status}`;
        await stopOwnedJob(j, timeout_ms);
        return `${j.id} stopped`;
      }
      throw new Error(`bad mode: ${mode}`);
    },
  },

  preview: {
    description: "Start a Cloudflare quick tunnel to the given local URL and return the public URL.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
      },
      required: ["url"],
    },
    handler: async (input: unknown) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("preview arguments must be an object");
      const { url } = input as Record<string, unknown>;
      if (typeof url !== "string" || !url) throw new Error("url required");
      if (/[\x00-\x20\x7f\\]/.test(url) || /%(?![0-9a-fA-F]{2})/.test(url)
          || Buffer.from(url, "utf8").toString("utf8") !== url || !/^https?:\/\/[^/?#]/i.test(url)) throw new Error("invalid http(s) url");
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new Error("invalid url"); }
      const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
      if (!host) throw new Error("invalid host");
      // Protect known host names/literals. This is not a DNS-rebinding boundary.
      if (host === "169.254.169.254" || host === "[::ffff:a9fe:a9fe]"
          || host === "metadata.google.internal" || host === "metadata" || host.endsWith(".internal"))
        throw new Error("url targets a protected host");
      const j = await startJobArgv(["cloudflared", "tunnel", "--url", url, "--no-autoupdate"],
        `cloudflared tunnel --url ${url} --no-autoupdate`, process.cwd());
      const deadline = performance.now() + 20_000;
      // A capture can end mid-hostname; wait for an actual log delimiter.
      const re = /https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=[\s|])/i;
      try {
        while (performance.now() < deadline) {
          if (!jobParentRunning(j)) throw new Error(`cloudflared exited (job ${j.id}): ${j.output.slice(-500)}`);
          const match = j.output.match(re);
          if (match) return `${match[0]} (job ${j.id})`;
          await Bun.sleep(250);
        }
        throw new Error(`timeout waiting for tunnel URL (job ${j.id}). output:\n${j.output.slice(-500)}`);
      } catch (failure) {
        try { await stopOwnedJob(j, 0); }
        catch (cleanup) { throw new AggregateError([failure, cleanup], `${String(failure)}; cleanup failed for ${j.id}: ${String(cleanup)}`); }
        throw failure;
      }
    },
  },

  remember: {
    description: "Append a memo. Returns the assigned id.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        memo: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["cwd", "memo"],
    },
    handler: async (input: unknown) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("remember arguments must be an object");
      const { cwd: suppliedCwd, memo, tags } = input as Record<string, unknown>;
      if (typeof suppliedCwd !== "string" || !suppliedCwd.length) throw new Error("cwd must be a nonempty string");
      if (suppliedCwd.includes("\0") || Buffer.from(suppliedCwd, "utf8").toString("utf8") !== suppliedCwd)
        throw new Error("cwd contains NUL or invalid Unicode");
      if (typeof memo !== "string") throw new Error("memo must be a string");
      const cwd = physicalPath(suppliedCwd, false);
      if (!statSync(cwd).isDirectory()) throw new Error("cwd must be an existing directory");
      const cleanTags = sanitizeTags(tags);
      const release = await acquireMemoLock(cwd);
      let savedId: number | undefined;
      let attemptedId: number | undefined;
      let operationFailure: unknown;
      try {
        const state = await readMemoAppendState(cwd);
        const previous = state.highest;
        if (previous >= Number.MAX_SAFE_INTEGER) throw new Error("memo ID space exhausted");
        const id = previous + 1;
        const entry: Memo = { id, ts: Date.now(), memo, ...(cleanTags ? { tags: cleanTags } : {}) };
        const line = state.separator + JSON.stringify(entry) + "\n";
        if (state.size + Buffer.byteLength(line, "utf8") > 100 * 1024 * 1024)
          throw new Error("memo storage exceeds 100 MiB limit");
        const path = resolve(cwd, ".memo.jsonl");
        requireMemoSnapshot(path, state.snapshot);
        const flags = fsConstants.O_RDWR | fsConstants.O_APPEND | (fsConstants.O_NOFOLLOW ?? 0)
          | (state.snapshot ? 0 : fsConstants.O_CREAT | fsConstants.O_EXCL);
        const fh = await fsOpen(path, flags);
        let appendFailure: unknown;
        try {
          const opened = memoStorageInfo(await fh.stat({ bigint: true }));
          if (state.snapshot ? opened.key !== state.snapshot.key : opened.size !== 0)
            throw new Error("memo storage changed during append preparation");
          requireMemoSnapshot(path, opened);
          attemptedId = id;
          try {
            await fh.writeFile(line);
            await fh.sync();
          } catch (failure) {
            try { await rollbackMemoAppend(fh, path, opened, state.size, Buffer.from(line, "utf8")); }
            catch (recovery) { throw new AggregateError([failure, recovery], `append failed: ${String(failure)}; recovery failed: ${String(recovery)}`); }
            attemptedId = undefined;
            throw new Error(`memory append failed; appended bytes removed: ${String(failure)}`, { cause: failure });
          }
        } catch (failure) {
          appendFailure = failure;
          throw failure;
        } finally {
          try { await fh.close(); }
          catch (closing) {
            if (appendFailure !== undefined) throw new AggregateError([appendFailure, closing], `${String(appendFailure)}; close failed: ${String(closing)}`);
            throw closing;
          }
        }
        savedId = id;
        return `remembered #${id}`;
      } catch (failure) {
        operationFailure = attemptedId === undefined ? failure : new Error(
          `memory #${attemptedId} may be partially or fully stored. Inspect .memo.jsonl before retrying: ${String(failure)}`,
          { cause: failure },
        );
        throw operationFailure;
      } finally {
        try { await release(); }
        catch (cleanup) {
          if (savedId !== undefined) throw new Error(`remembered #${savedId}; lock cleanup failed: ${String(cleanup)}. Do not resend this memory.`);
          if (operationFailure !== undefined) throw new AggregateError([operationFailure, cleanup], `memory operation failed: ${String(operationFailure)}; lock cleanup failed: ${String(cleanup)}`);
          throw cleanup;
        }
      }
    },
  },

  forget: {
    description: "Remove a memo by id.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        memo_id: { type: "number" },
      },
      required: ["cwd", "memo_id"],
    },
    handler: async (input: unknown) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("forget arguments must be an object");
      const { cwd: suppliedCwd, memo_id } = input as Record<string, unknown>;
      if (typeof suppliedCwd !== "string" || !suppliedCwd.length) throw new Error("cwd must be a nonempty string");
      if (suppliedCwd.includes("\0") || Buffer.from(suppliedCwd, "utf8").toString("utf8") !== suppliedCwd)
        throw new Error("cwd contains NUL or invalid Unicode");
      if (typeof memo_id !== "number" || !Number.isSafeInteger(memo_id) || memo_id < 1)
        throw new Error("memo_id must be a positive safe integer");
      const cwd = physicalPath(suppliedCwd, false);
      if (!statSync(cwd).isDirectory()) throw new Error("cwd must be an existing directory");
      const release = await acquireMemoLock(cwd);
      let attempted = false, saved = false, operationFailure: unknown;
      try {
        const path = resolve(cwd, ".memo.jsonl"), snapshot = memoStorageSnapshot(path);
        if (!snapshot) throw new Error(`no memo with id ${memo_id}`);
        const expected: FileSnapshot = { path, stat: lstatSync(path) };
        requireMemoSnapshot(path, snapshot);
        const text = await readFileText({ cwd, path }, { allowSpill: false, expected });
        requireMemoSnapshot(path, snapshot);
        const kept: string[] = [];
        let removed = false;
        for (let start = 0; start < text.length;) {
          const newline = text.indexOf("\n", start), end = newline < 0 ? text.length : newline + 1;
          const raw = text.slice(start, end);
          let matches = false;
          try {
            const m = parseMcpJson(raw);
            matches = m && Number.isSafeInteger(m.id) && m.id === memo_id && Number.isSafeInteger(m.ts)
              && m.ts >= 0 && typeof m.memo === "string";
          } catch { /* Malformed non-target records remain byte-for-byte intact. */ }
          if (matches) removed = true; else kept.push(raw);
          start = end;
        }
        if (!removed) throw new Error(`no memo with id ${memo_id}`);
        requireMemoSnapshot(path, snapshot);
        attempted = true;
        await writeFileAtomic({ cwd, path, content: kept.join("") }, expected, () => requireMemoSnapshot(path, snapshot));
        saved = true;
        return `forgot #${memo_id}`;
      } catch (failure) {
        operationFailure = attempted ? new Error(`forget #${memo_id} may have completed. Inspect .memo.jsonl before retrying: ${String(failure)}`, { cause: failure }) : failure;
        throw operationFailure;
      } finally {
        try { await release(); }
        catch (cleanup) {
          if (saved) throw new Error(`forgot #${memo_id}; lock cleanup failed: ${String(cleanup)}. Do not retry this deletion.`);
          if (operationFailure !== undefined) throw new AggregateError([operationFailure, cleanup], `${String(operationFailure)}; lock cleanup failed: ${String(cleanup)}`);
          throw cleanup;
        }
      }
    },
  },

  recall: {
    description: "Search memos by substring (query) and/or tags (AND). Both are case-insensitive. Sorted newest first. Paginated.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        query: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        limit: { type: "number" },
        offset: { type: "number" },
      },
      required: ["cwd"],
    },
    handler: async (input: unknown) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("recall arguments must be an object");
      const { cwd: suppliedCwd, query, tags, limit, offset } = input as Record<string, any>;
      if (typeof suppliedCwd !== "string" || !suppliedCwd.length) throw new Error("cwd must be a nonempty string");
      if (suppliedCwd.includes("\0") || Buffer.from(suppliedCwd, "utf8").toString("utf8") !== suppliedCwd)
        throw new Error("cwd contains NUL or invalid Unicode");
      const cwd = physicalPath(suppliedCwd, false);
      if (!statSync(cwd).isDirectory()) throw new Error("cwd must be an existing directory");
      const lim = Number.isFinite(limit) && limit >= 1 ? Math.min(Math.floor(limit), 1000) : 20;
      const off = Number.isFinite(offset) && offset >= 0 ? Math.min(Math.floor(offset), Number.MAX_SAFE_INTEGER) : 0;
      const { total, page } = await selectRecallPage(cwd, query, tags, lim, off);
      if (!total) return "(no matches)";
      if (off >= total) return `(no matches at offset=${off}; total=${total})`;
      const lines = page.map((m) => {
        const ts = formatMemoTimestamp(m.ts);
        const tagStr = m.tags?.length ? ` [${m.tags.join(",")}]` : "";
        return `#${m.id} ${ts}${tagStr} ${m.memo}`;
      });
      const end = off + page.length;
      const hasMore = end < total;
      const footer = `-- ${off + 1}-${end} of ${total}${hasMore ? ` (next: offset=${end})` : ""}`;
      return lines.join("\n") + "\n" + footer;
    },
  },

  guide: {
    description: "Operating manual for this code-mcp server: live state, session-start ritual, when to remember, tool catalog. Call at session start.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
      },
      required: ["cwd"],
    },
    handler: async (input: unknown) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("guide arguments must be an object");
      const { cwd: suppliedCwd } = input as Record<string, unknown>;
      if (typeof suppliedCwd !== "string" || !suppliedCwd.length) throw new Error("cwd must be a nonempty string");
      if (suppliedCwd.includes("\0") || Buffer.from(suppliedCwd, "utf8").toString("utf8") !== suppliedCwd)
        throw new Error("cwd contains NUL or invalid Unicode");
      const cwd = physicalPath(suppliedCwd, false);
      if (!statSync(cwd).isDirectory()) throw new Error("cwd must be an existing directory");
      return renderGuide(cwd);
    },
  },

  get_upload_link: {
    description:
      "Return an upload link the user can open to upload files to Tuan's local machine. " +
      "Files are saved to `${UPLOAD_ROOT}/<session_id>/`. Session is valid for 10 minutes. " +
      "Returns a JSON object with: `url` (the upload URL), `expiresInMinutes` (10), " +
      "`widget` (an HTML button matching the upload page style), and `hint`. " +
      "When responding to the user, render the `widget` HTML by calling the " +
      "`visualize:show_widget` tool (or equivalent) so the user sees a clickable button " +
      "instead of a raw URL. Also include the URL as a markdown link in your response " +
      "as a fallback for clients that don't render widgets.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    handler: (input: unknown) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("get_upload_link arguments must be an object");
      const base = resolvedPublicBaseUrl();
      if (!base) {
        throw new Error(
          "get_upload_link requires --public or --domain; the server has no public base URL."
        );
      }
      if (!token) {
        throw new Error("get_upload_link requires --token to sign upload sessions.");
      }
      const sessionId = mintUploadSessionId();
      const url = `${base}/upload/${sessionId}`;
      const widget = uploadWidget(url);
      return JSON.stringify({
        url,
        expiresInMinutes: 10,
        widget,
        hint:
          "Render the `widget` HTML by calling visualize:show_widget. " +
          "Also show the `url` as a markdown link as fallback.",
      });
    },
  },

  mcp: {
    description:
      "Manage MCP servers from local .mcp.json files. " +
      "Actions: " +
      "  list: List all servers defined in .mcp.json for cwd " +
      "  list server=X: Load server X and return its tools " +
      "  call server=X tool=Y args={}: Call tool Y on loaded server X " +
      "  unload: Unload all servers for this cwd " +
      "  unload server=X: Unload server X from the selected configuration file. If a config alias was removed, use unload without server or supply the physical config path.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", minLength: 1, description: "Working directory containing .mcp.json" },
        action: { type: "string", enum: ["list", "call", "unload"], description: "Action to perform" },
        server: { type: "string", minLength: 1, description: "Server name (required for call, optional for list/unload)" },
        tool: { type: "string", minLength: 1, description: "Tool name (required for call)" },
        args: { type: "object", description: "Tool arguments (defaults to an empty object)", default: {}, additionalProperties: true },
        mcpConfigPath: { type: "string", minLength: 1, default: ".mcp.json", description: "Path to .mcp.json relative to cwd" },
      },
      required: ["cwd", "action"],
    },
    handler: async (input: unknown) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("mcp arguments must be an object");
      const values = input as Record<string, unknown>;
      const owns = (key: string) => Object.prototype.hasOwnProperty.call(values, key);
      const string = (key: string, required = true): string | undefined => {
        if (!required && !owns(key)) return undefined;
        const value = values[key];
        if (typeof value !== "string" || !value.length) throw new Error(`${key} must be a nonempty string`);
        if (value.includes("\0") || Buffer.from(value, "utf8").toString("utf8") !== value) throw new Error(`${key} contains NUL or invalid Unicode`);
        return value;
      };
      const physicalCwd = physicalPath(string("cwd")!, false), action = string("action")!;
      const cwd = IS_WINDOWS ? realpathSync.native(physicalCwd) : physicalCwd;
      if (!statSync(cwd).isDirectory()) throw new Error("cwd must be an existing directory");
      if (!["list", "call", "unload"].includes(action)) throw new Error(`unknown action: ${action}`);
      const server = string("server", action === "call"), tool = string("tool", action === "call");
      const mcpConfigPath = owns("mcpConfigPath") ? string("mcpConfigPath")! : ".mcp.json";
      if (owns("args") && (!values.args || typeof values.args !== "object" || Array.isArray(values.args))) throw new Error("args must be an object");
      const args = owns("args") ? values.args : {};
      if (action === "unload") {
        const validation = validateMcpConfigPath(cwd, mcpConfigPath);
        if (!validation.ok) throw new Error(validation.reason);
        return server ? unloadServer(cwd, server, validation.path) : unloadAllForCwd(cwd);
      }
      const config = await loadMcpConfig(cwd, mcpConfigPath);
      if ("error" in config) throw new Error(config.error);
      await reconcileMcpConfig(cwd, config.path, config.servers);
      const cacheId = server ? mcpConfigServerId(config.path, server) : "";
      const cacheKey = mcpMetadataKey(cwd, cacheId);

      if (action === "list" && !server) {
        const servers: any[] = [];
        for (const [name, cfg] of Object.entries(config.servers)) {
          const id = mcpConfigServerId(config.path, name);
          const key = mcpMetadataKey(cwd, id);
          const meta = serverMetadata.get(key);
          const cwdMap = cwdServers.get(cwd);
          const state = cwdMap?.get(id);
          const isLoaded = !!state?.initialized && !!meta && state.configSignature === mcpConfigSignature(cfg);
          servers.push({
            name,
            status: isLoaded ? "loaded" : "unloaded",
            tools: isLoaded ? meta!.tools.map((t: AggregatedTool) => t.originalName) : [],
            idleTimeoutMs: cfg.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
          });
        }
        return { servers, mcpConfigPath };
      }

      const discoverTools = (state: ServerState): Promise<Json[]> => {
        const owner = state.transport === "stdio" ? state.proc : state;
        if (!owner) return Promise.reject(new Error("MCP subprocess closed"));
        const pending = mcpDiscoveries.get(owner);
        if (pending) return pending;
        const ownsConnection = () => cwdServers.get(cwd)?.get(cacheId) === state
          && (state.transport === "http" || state.proc === owner);
        const initializing = state.setupDeadline !== null;
        const task = (async () => {
          try {
            const result = await discoverMcpTools(state);
            if (!Array.isArray(result?.tools)) throw new Error("tools/list response must contain a tools array");
            const definitions = result.tools.map((entry: any) => {
              if (!entry || typeof entry !== "object" || typeof entry.name !== "string" || !entry.name)
                throw new Error("tools/list returned an invalid tool");
              return { ...entry, description: entry.description ?? "", inputSchema: entry.inputSchema ?? { type: "object" } };
            });
            const tools: AggregatedTool[] = definitions.map((entry: any) => ({
              namespace: server!, originalName: entry.name, description: entry.description, inputSchema: entry.inputSchema,
            }));
            if (!ownsConnection() || !state.initialized) throw new Error("MCP server was unloaded during discovery");
            finishSetup(state);
            serverMetadata.set(cacheKey, { tools, loadedAt: Date.now() });
            return definitions;
          } catch (error) {
            if (initializing && ownsConnection()) {
              await unloadServer(cwd, server!, config.path);
            }
            throw error;
          }
        })();
        mcpDiscoveries.set(owner, task);
        const release = () => { if (mcpDiscoveries.get(owner) === task) mcpDiscoveries.delete(owner); };
        void task.then(release, release);
        return task;
      };

      if (action === "list" && server) {
        const v = validateServerName(config.servers, server);
        if (!v.ok) throw new Error(v.reason);
        const cfg = config.servers[server];
        const key = `${cwd}:${server}`;
        let state = getOrCreateServerState(cwd, server, cfg, config.path);
        return withMcpActivity(state, async () => {
          if (!state.initialized) {
            state = getOrCreateServerState(cwd, server, cfg, config.path);
            state.setupDeadline ??= performance.now() + MCP_HTTP_CONTROL_TIMEOUT_MS;
            let spawnTimer: ReturnType<typeof setTimeout> | null = null;
            try {
              await Promise.race([
                spawnServerWithLimit(cwd, server, state),
                new Promise<void>((_, reject) => {
                  spawnTimer = setTimeout(() => reject(new Error(`spawn timeout after ${SPAWN_TIMEOUT_MS}ms`)), SPAWN_TIMEOUT_MS);
                }),
              ]);
            } catch (error) {
              if (cwdServers.get(cwd)?.get(cacheId) === state) await unloadServer(cwd, server, config.path);
              throw error;
            } finally {
              if (spawnTimer) clearTimeout(spawnTimer);
            }
          }
          const tools = await discoverTools(state);
          return {
            server,
            status: "loaded",
            tools,
            idleTimeoutMs: cfg.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
          };
        });
      }

      if (action === "call") {
        if (!server) throw new Error("server name required for call action");
        if (!tool) throw new Error("tool name required for call action");
        const v = validateServerName(config.servers, server);
        if (!v.ok) throw new Error(v.reason);
        const argsValidation = validateToolArgs(args);
        if (!argsValidation.ok) throw new Error(argsValidation.reason);
        const cfg = config.servers[server];
        let state = getOrCreateServerState(cwd, server, cfg, config.path);
        return withMcpActivity(state, async () => {
          if (!state.initialized) {
            state = getOrCreateServerState(cwd, server, cfg, config.path);
            state.setupDeadline ??= performance.now() + MCP_HTTP_CONTROL_TIMEOUT_MS;
            let spawnTimer: ReturnType<typeof setTimeout> | null = null;
            try {
              await Promise.race([
                spawnServerWithLimit(cwd, server, state),
                new Promise<void>((_, reject) => {
                  spawnTimer = setTimeout(() => reject(new Error(`spawn timeout after ${SPAWN_TIMEOUT_MS}ms`)), SPAWN_TIMEOUT_MS);
                }),
              ]);
            } catch (error) {
              if (cwdServers.get(cwd)?.get(cacheId) === state) await unloadServer(cwd, server, config.path);
              throw error;
            } finally {
              if (spawnTimer) clearTimeout(spawnTimer);
            }
          }
          if (!serverMetadata.has(cacheKey)) await discoverTools(state);
          return validateMcpToolResult(await rpcCall(state, "tools/call", { name: tool, arguments: argsValidation.sanitized }));
        });
      }

      throw new Error(`unknown action: ${action}`);
    },
  },
};

// Startup services remain usable when their corresponding agent tool is hidden.
const launchPublicTunnel = tools.preview.handler;

// Prune tools based on startup flags and binary availability. Always apply
// the default pruning first (cloudflared, memory, public, shell match), then
// remove anything listed in --disallowed-tools on top.
if (!hasCloudflared) delete tools.preview;
if (!memoryEnabled) {
  delete tools.remember;
  delete tools.forget;
  delete tools.recall;
}
if (!publicBaseUrl && !makePublic) {
  delete (tools as any).get_upload_link;
}
if (DETECTED_SHELL !== "bash") delete tools.bash;
if (DETECTED_SHELL !== "sh") delete tools.shell;
if (DETECTED_SHELL !== "cmd") delete tools.command;
if (DETECTED_SHELL !== "powershell") delete tools.powershell;
for (const name of disallowedTools) {
  delete tools[name];
}

// Load external MCP aggregation config if --mcp was given. Pass the user's
// path through unchanged — Bun/Node resolve relative paths against the
// process cwd at file-open time, so an explicit resolve here is redundant.
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
if (mcpConfigPath) {
  await loadAggregator(mcpConfigPath);
}

// Walk an MCP `content` array and spill any oversized blocks. Text blocks
// go through maybeSpillText. Image, audio, and resource blocks with large embedded
// base64 payloads (`data` field, or `resource.blob` / `resource.text`) are
// spilled too — otherwise a downstream MCP returning, say, a screenshot
// blob will still blow the agent's context window. The replacement text
// block points at the spill file and preserves the original mimeType.
async function spillContentBlocks(content: any, toolName?: string): Promise<any> {
  if (!Array.isArray(content)) return content;
  // Limit per-reply disk operations and promises even for very large arrays.
  const output = new Array(content.length);
  let next = 0, failed = false, failure: unknown;
  await Promise.all(Array.from({ length: Math.min(8, content.length) }, async () => {
    while (!failed && next < content.length) {
      const index = next++;
      try { output[index] = await spillContentBlock(content[index], toolName); }
      catch (error) {
        if (!failed) { failed = true; failure = error; }
      }
    }
  }));
  // Drain in-flight writes before reporting a failure; do not leave background
  // spill operations running after the caller receives its error.
  if (failed) throw failure;
  return output;
}

async function spillContentBlock(block: any, toolName?: string): Promise<any> {
  if (!block || typeof block !== "object") return block;
  if (block.type === "text" && typeof block.text === "string") {
    return { ...block, text: await maybeSpillText(block.text, toolName) };
  }
  if ((block.type === "image" || block.type === "audio") && typeof block.data === "string") {
    const spilled = await maybeSpillBinaryBlock(block.data, block.mimeType ?? (block.type === "image" ? "image/png" : "application/octet-stream"), toolName);
    return spilled ? spillBlockReplacement(block, spilled) : block;
  }
  if (block.type === "resource" && block.resource && typeof block.resource === "object") {
    const r = block.resource;
    if (typeof r.text === "string") {
      return { ...block, resource: { ...r, text: await maybeSpillText(r.text, toolName) } };
    }
    if (typeof r.blob === "string") {
      const spilled = await maybeSpillBinaryBlock(r.blob, r.mimeType ?? "application/octet-stream", toolName);
      return spilled ? spillBlockReplacement(block, spilled) : block;
    }
  }
  return block;
}

function spillBlockReplacement(block: Json, spilled: Json): Json {
  const { data, mimeType, resource, ...metadata } = block;
  return { ...metadata, ...spilled };
}

// Spill an oversized base64 payload to disk and return a text-block summary
// pointing at the file. Returns null if under threshold (caller keeps the
// original block). The raw bytes (not the base64 string) are what's written,
// so the spilled file is directly usable.
async function maybeSpillBinaryBlock(b64: string, mimeType: string, toolName?: string): Promise<any | null> {
  // base64 length ≈ ceil(bytes / 3) * 4. Skip the decode if obviously small.
  if (b64.length < (RESULT_SPILL_THRESHOLD * 4) / 3) return null;

  // Keep malformed input intact instead of silently dropping bytes during decode.
  if (typeof mimeType !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)
      || (b64.includes("=") && b64.length % 4 !== 0)) return null;
  let raw: Buffer;
  try {
    raw = Buffer.from(b64, "base64");
    if (raw.toString("base64").replace(/=+$/, "") !== b64.replace(/=+$/, "")) return null;
  } catch {
    return null;
  }
  if (raw.byteLength <= RESULT_SPILL_THRESHOLD) return null;

  const ts = new Date().toISOString().replace(/[-:.]/g, "").replace(/Z$/, "");
  const safeTool = spillToolName(toolName);
  const shortId = randomUUID().slice(0, 8);
  // Extension hint from mime type, best-effort only.
  const slash = mimeType.indexOf("/");
  const ext = slash < 0 ? "bin" : mimeType.slice(slash + 1, slash + 17).split("/", 1)[0]!.replace(/[^A-Za-z0-9]/g, "");
  const fname = `${ts}-${safeTool}-${shortId}.${ext || "bin"}`;
  const path = resolve(RESULT_SPILL_ROOT, fname);
  try {
    await Bun.write(path, raw);
    try { chmodSync(path, 0o600); } catch {}
  } catch (e: any) {
    console.error(`[spill] failed to write binary ${path}: ${e?.message ?? e}`);
    return {
      type: "text",
      text:
        await maybeSpillText(`[TRUNCATED: ${mimeType} payload of ${raw.byteLength} bytes; ` +
        `spill to disk FAILED (${e?.message ?? "unknown error"}). Payload dropped.]`, toolName),
    };
  }
  return {
    type: "text",
    text:
      await maybeSpillText(`[TRUNCATED: ${mimeType} payload of ${raw.byteLength} bytes, ` +
      `saved to ${path} — read the file directly to access it.]`, toolName),
  };
}

// ---------- JSON-RPC dispatch ----------
function validMcpRequest(msg: Json): boolean {
  // Reject malformed envelopes before any method dispatch or tool side effect.
  if (!msg || typeof msg !== "object" || Array.isArray(msg)
      || msg.jsonrpc !== "2.0" || typeof msg.method !== "string"
      || (Object.hasOwn(msg, "id") && msg.id !== null && typeof msg.id !== "string"
          && !(typeof msg.id === "number" && Number.isFinite(msg.id)))) {
    return false;
  }
  return true;
}

async function handle(msg: Json): Promise<Json | null> {
  if (!validMcpRequest(msg)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  const result = await dispatchMcpRequest(msg);
  return Object.hasOwn(msg, "id") ? result : null;
}

async function dispatchMcpRequest(msg: Json): Promise<Json | null> {
  const { id, method, params } = (msg ?? {}) as any;
  const ok = (result: Json) => ({ jsonrpc: "2.0", id, result });
  const err = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

  // params (when present) must be an object or array per JSON-RPC 2.0. We use
  // object-style throughout; reject array / scalar with -32602 rather than
  // tripping over typeof errors deeper in handlers.
  if (params !== undefined && params !== null && (typeof params !== "object" || Array.isArray(params))) {
    return err(-32602, "Invalid params: expected object");
  }
  try {
    if (method === "initialize") {
      return ok({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "code-mcp", version: "0.1.0" },
      });
    }
    if (method === "notifications/initialized" && !Object.hasOwn(msg, "id")) return null; // notification
    if (method === "ping") return ok({});
    if (method === "tools/list") {
      const builtin = Object.entries(tools).map(([name, t]) => ({
        name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      const aggregated = [...aggregatedTools.entries()].map(([name, info]) => ({
        ...info.definition,
        name,
        description: info.description,
        inputSchema: info.inputSchema,
      }));
      return ok({ tools: [...builtin, ...aggregated] });
    }
    if (method === "tools/call") {
      if (!params || typeof params.name !== "string" || !params.name.length) {
        return err(-32602, "Invalid params: name must be a nonempty string");
      }
      const { name, arguments: args } = params;
      // Aggregated tool: forward to subprocess, spill oversized blocks
      // before returning so the agent's context window stays bounded.
      if (aggregatedTools.has(name)) {
        const result = await callAggregated(name, Object.hasOwn(params, "arguments") ? args : {});
        if (result && typeof result === "object" && "content" in result) {
          return ok({ ...result, content: await spillContentBlocks(result.content, name) });
        }
        return ok(result);
      }
      // Explicit disallowed check BEFORE lookup: PY/JV report a tool that was
      // stripped by --disallowed-tools as "disabled", not as "unknown".
      if (disallowedTools.includes(name)) {
        return ok({ content: [{ type: "text", text: `ERROR: tool '${name}' disabled` }], isError: true });
      }
      const t = Object.hasOwn(tools, name) ? tools[name] : undefined;
      if (!t && SHELL_TOOL_NAMES.has(name)) throw new Error(`shell tool '${name}' is unavailable on this server`);
      if (!t) return err(-32601, `unknown tool: ${name}`);
      const result = await t.handler(args === undefined ? {} : args);
      const text = typeof result === "string" ? result : JSON.stringify(result);
      // `read` honors a no_truncate flag end-to-end: the handler already returned
      // the full content, so don't re-spill it here.
      const skipSpill = name === "read" && (args as any)?.no_truncate === true;
      const finalText = skipSpill ? text : await maybeSpillText(text, name);
      const upstreamError = name === "mcp" && args?.action === "call" && result?.isError === true;
      return ok({ content: [{ type: "text", text: finalText }], ...(upstreamError ? { isError: true } : {}) });
    }
    return err(-32601, `unknown method: ${method}`);
  } catch (e: any) {
    // handle() suppresses replies only when the ID member is absent.
    const text = `ERROR: ${e?.message ?? e}`;
    return ok({ content: [{ type: "text", text: await maybeSpillText(text) }], isError: true });
  }
}

// ---------- server ----------
const CORS_HEADERS: Record<string, string> = token ? {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
} : {};

// Hard cap per file to avoid memory blowup on a single upload.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MiB per file
const MAX_UPLOAD_BODY_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024; // bounded multipart overhead

function prepareUploadDirectory(sessionId: string) {
  verifiedUploadExpiry(sessionId);
  const base = realpathSync(dirname(dirname(UPLOAD_ROOT)));
  const snapshots: Array<{ path: string; dev: number; ino: number }> = [];
  let path = base;
  for (const part of ["code-mcp", "uploads", sessionId]) {
    path = resolve(path, part);
    try { mkdirSync(path, { mode: 0o700 }); } catch (error: any) { if (error?.code !== "EEXIST") throw error; }
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) throw new Error("upload path invalid");
    snapshots.push({ path, dev: info.dev, ino: info.ino });
  }
  const verify = () => {
    for (const item of snapshots) {
      const now = lstatSync(item.path);
      if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== item.dev || now.ino !== item.ino || realpathSync(item.path) !== item.path) throw new Error("upload path changed");
    }
  };
  return { root: dirname(path), directory: path, verify };
}

function checkUploadFile(path: string) {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("upload file invalid");
  } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
}

function sweepUploads(root: string, currentSession: string) {
  // Never sweep the general temp directory. Unknown/key-rotated entries stay
  // untouched; an old folder name alone is not proof that this server owns it.
  const cutoff = Date.now() - 900_000;
  try {
    for (const name of readdirSync(root)) {
      if (name === currentSession) continue;
      try {
        if (verifiedUploadExpiry(name) >= cutoff) continue;
        const path = resolve(root, name), info = lstatSync(path);
        if (info.isDirectory() && !info.isSymbolicLink()) rmSync(path, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

type UploadPart = { name: string; mime: string; data: Buffer };
function uploadParameters(value: string): { type: string; params: Map<string, string> } {
  const first = value.indexOf(";");
  const type = (first < 0 ? value : value.slice(0, first)).trim().toLowerCase();
  const params = new Map<string, string>();
  let at = first < 0 ? value.length : first;
  while (at < value.length) {
    if (value[at++] !== ";") throw new Error("invalid multipart parameter");
    while (value[at] === " " || value[at] === "\t") at++;
    const start = at;
    while (at < value.length && /[!#$%&'*+.^_`|~0-9A-Za-z-]/.test(value[at])) at++;
    const key = value.slice(start, at).toLowerCase();
    while (value[at] === " " || value[at] === "\t") at++;
    if (!key || value[at++] !== "=") throw new Error("invalid multipart parameter");
    while (value[at] === " " || value[at] === "\t") at++;
    let text = "";
    if (value[at] === '"') {
      at++; let closed = false;
      while (at < value.length) {
        let char = value[at++];
        if (char === '"') { closed = true; break; }
        if (char === "\\") { if (at >= value.length) throw new Error("invalid multipart quote"); char = value[at++]; }
        text += char;
      }
      if (!closed) throw new Error("invalid multipart quote");
      while (value[at] === " " || value[at] === "\t") at++;
      if (at < value.length && value[at] !== ";") throw new Error("invalid multipart parameter");
    } else {
      const start = at; while (at < value.length && value[at] !== ";") at++;
      text = value.slice(start, at).trim();
    }
    if (params.has(key) || /[\r\n\0]/.test(text)) throw new Error("ambiguous multipart parameter");
    params.set(key, text);
  }
  return { type, params };
}

function uploadFilename(value: string): string {
  let name = value.replaceAll("\\", "/").split("/").at(-1)!.replace(/[\x00-\x1f\x7f<>:"|?*]/g, "_").replace(/[ .]+$/, "");
  if (!name) name = "upload.bin";
  if (/^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(name.split(".")[0].trimEnd())) name = "_" + name;
  if (Buffer.byteLength(name, "utf8") > 255) throw new Error("filename exceeds 255 UTF-8 bytes");
  return name;
}

function parseUploadForm(contentType: string, body: Buffer): UploadPart {
  const parsed = uploadParameters(contentType), boundary = parsed.params.get("boundary") ?? "";
  if (parsed.type !== "multipart/form-data" || !/^[0-9A-Za-z'()+_,./:=? -]{1,70}$/.test(boundary) || boundary.endsWith(" ")) throw new Error("invalid multipart boundary");
  const marker = Buffer.from("--" + boundary), prefix = Buffer.concat([Buffer.from("\r\n"), marker]);
  type Delimiter = { position: number; after: number; closing: boolean };
  const delimiter = (position: number): Delimiter | null => {
    let at = position + marker.length;
    const closing = body[at] === 45 && body[at + 1] === 45;
    if (closing) at += 2;
    while (body[at] === 32 || body[at] === 9) at++;
    if (closing && at === body.length) return { position, after: at, closing };
    if (body[at] === 13 && body[at + 1] === 10) return { position, after: at + 2, closing };
    return null;
  };
  const nextDelimiter = (from: number): Delimiter | null => {
    for (let found = body.indexOf(prefix, from); found >= 0; found = body.indexOf(prefix, found + prefix.length)) {
      const value = delimiter(found + 2); if (value) return value;
    }
    return null;
  };
  let current = body.subarray(0, marker.length).equals(marker) ? delimiter(0) : nextDelimiter(0);
  let selected: UploadPart | undefined, count = 0;
  while (current && !current.closing) {
    if (++count > 128) throw new Error("too many multipart parts");
    const next = nextDelimiter(current.after);
    if (!next) throw new Error("truncated multipart body");
    const end = next.position - 2, headerEnd = body.indexOf("\r\n\r\n", current.after, "ascii");
    if (headerEnd < current.after || headerEnd + 4 > end || headerEnd - current.after > 65536) throw new Error("invalid multipart headers");
    const headers = new Map<string, string>();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(current.after, headerEnd));
    for (const line of text.split("\r\n")) {
      const colon = line.indexOf(":"), key = line.slice(0, colon).toLowerCase();
      if (colon <= 0 || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(key) || headers.has(key)) throw new Error("invalid multipart headers");
      headers.set(key, line.slice(colon + 1).trim());
    }
    const disposition = uploadParameters(headers.get("content-disposition") ?? "");
    if (disposition.type !== "form-data" || !disposition.params.has("name")) throw new Error("invalid content disposition");
    if (disposition.params.get("name") === "file") {
      if (selected || !disposition.params.has("filename")) throw new Error("expected one file field");
      let mime = headers.get("content-type") ?? "application/octet-stream";
      mime = mime && /^[\x20-\x7e]+$/.test(mime) ? mime.toLowerCase() : "application/octet-stream";
      selected = { name: uploadFilename(disposition.params.get("filename")!), mime, data: body.subarray(headerEnd + 4, end) };
    }
    current = next;
  }
  if (!current?.closing || !selected) throw new Error("missing file field");
  return selected;
}


// Only commit work is serialized per upload session. Bodies for independent
// sessions still read/write concurrently, and completed entries are removed.
const uploadWriteQueues = new Map<string, Promise<void>>();
async function withUploadWriteLock<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
  const previous = uploadWriteQueues.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  uploadWriteQueues.set(sessionId, current);
  await previous;
  try { return await action(); }
  finally {
    release();
    if (uploadWriteQueues.get(sessionId) === current) uploadWriteQueues.delete(sessionId);
  }
}

// Bound body buffers independently of MCP traffic; stalled uploads cannot fill RAM.
let activeUploads = 0;
async function handleUpload(req: Request, sessionId: string): Promise<Response> {
  const check = verifyUploadSessionId(sessionId);
  if (!check.ok) return new Response(JSON.stringify({ error: check.reason }), {
    status: 401, headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
  if (activeUploads >= 4) return new Response(JSON.stringify({ error: "too many active uploads" }), {
    status: 503, headers: { "Content-Type": "application/json", "Retry-After": "1", ...CORS_HEADERS },
  });
  activeUploads++;
  try { return await handleUploadBody(req, sessionId); }
  finally { activeUploads--; }
}

class UploadBodyTimeout extends Error {}
class UploadBodyTooLarge extends Error {}
async function readUploadBody(req: Request): Promise<Buffer> {
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  let expired = false, size = 0, buffer = Buffer.allocUnsafe(65536);
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel("upload body deadline exceeded").catch(() => {});
  }, 60_000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (expired) throw new UploadBodyTimeout("upload body deadline exceeded");
      if (done) return buffer.subarray(0, size);
      const needed = size + value.byteLength;
      if (needed > MAX_UPLOAD_BODY_BYTES) {
        void reader.cancel("upload body too large").catch(() => {});
        throw new UploadBodyTooLarge("upload body too large");
      }
      if (needed > buffer.length) {
        const grown = Buffer.allocUnsafe(Math.min(MAX_UPLOAD_BODY_BYTES, Math.max(needed, buffer.length * 2)));
        buffer.copy(grown, 0, 0, size);
        buffer = grown;
      }
      buffer.set(value, size);
      size = needed;
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

async function handleUploadBody(req: Request, sessionId: string): Promise<Response> {
  const check = verifyUploadSessionId(sessionId);
  if (!check.ok) {
    return new Response(JSON.stringify({ error: check.reason }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
  // Reject early via Content-Length before parsing the entire body into memory.
  const declaredLen = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLen) && declaredLen > MAX_UPLOAD_BODY_BYTES) {
    return new Response(JSON.stringify({ error: `upload body exceeds ${MAX_UPLOAD_BODY_BYTES} bytes` }), {
      status: 413,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
  let part: UploadPart;
  try {
    const body = await readUploadBody(req);
    if (body.length > MAX_UPLOAD_BODY_BYTES) {
      return new Response(JSON.stringify({ error: `upload body exceeds ${MAX_UPLOAD_BODY_BYTES} bytes` }), {
        status: 413, headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }
    part = parseUploadForm(req.headers.get("content-type") ?? "", body);
  } catch (e: any) {
    return new Response(JSON.stringify({ error: `bad form: ${e?.message ?? e}` }), {
      status: e instanceof UploadBodyTimeout ? 408 : e instanceof UploadBodyTooLarge ? 413 : 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
  if (part.data.length > MAX_UPLOAD_BYTES) {
    return new Response(JSON.stringify({ error: `file too large (max ${MAX_UPLOAD_BYTES} bytes)` }), {
      status: 413, headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
  const safe = part.name;

  return withUploadWriteLock(sessionId, async () => {
    try {
      req.signal.throwIfAborted();
      const owned = prepareUploadDirectory(sessionId);
      const path = resolve(owned.directory, safe);
      if (dirname(path) !== owned.directory) throw new Error("upload filename invalid");
      checkUploadFile(path);
      const buf = part.data;
      await writeFileAtomic({ cwd: owned.root, path, content: "" }, undefined,
        () => {
          // The HTTP parser can abort after delivering the body (for example,
          // unsupported trailers). Never commit a write after that rejection.
          req.signal.throwIfAborted();
          owned.verify(); checkUploadFile(path);
        }, buf);
      owned.verify();
      sweepUploads(owned.root, sessionId);
      const hash = new Bun.CryptoHasher("sha256");
      hash.update(buf);
      const sha256 = hash.digest("hex");
      return new Response(
        JSON.stringify({ path, size: buf.length, sha256, mime: part.mime }),
        { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    } catch (e: any) {
      return new Response(JSON.stringify({ error: `write failed: ${e?.message ?? e}` }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }
  });
}

// Never resolve an untrusted Host: anonymous access must not follow attacker DNS.
function trustedAnonymousHost(authority: string | null): boolean {
  if (!authority) return false;
  const match = /^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(authority);
  if (!match || (match[2] !== undefined && (+match[2] < 1 || +match[2] > 65535))) return false;
  const host = match[1].replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === bindAddr.toLowerCase() || isIP(host) !== 0;
}

const httpServer = Bun.serve({
  port,
  hostname: bindAddr,
  // Reject oversized request bodies at the server level (chunked uploads have
  // no Content-Length, so the handler-level check alone can be bypassed).
  maxRequestBodySize: MAX_UPLOAD_BODY_BYTES,
  async fetch(req) {
    const url = new URL(req.url);

    // Anonymous native clients are supported; browser-origin tool access needs
    // a configured credential, including same-origin/rebinding and null origins.
    if (url.pathname === "/mcp" && !token && (req.headers.has("Origin") || req.method === "OPTIONS")) {
      return Response.json({ error: "browser MCP access requires --token" }, { status: 403 });
    }
    if (url.pathname === "/mcp" && !token) {
      if (!trustedAnonymousHost(req.headers.get("Host"))) {
        return Response.json({ error: "untrusted Host; configure --token for DNS aliases" }, { status: 403 });
      }
      if (req.method === "POST" && req.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
        return Response.json({ error: "anonymous MCP requests require application/json" }, { status: 415 });
      }
    }

    // CORS preflight — also handle /mcp so browser-based clients work.
    if (req.method === "OPTIONS" && (url.pathname.startsWith("/upload/") || url.pathname === "/mcp")) {
      return new Response(null, {
        status: 204,
        headers: {
          ...CORS_HEADERS,
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // Upload endpoint: /upload/<session_id>
    // GET → HTML page with drop zone. POST → accept file upload.
    // Both methods validate the session_id (HMAC + TTL).
    if (url.pathname.startsWith("/upload/")) {
      const sessionId = url.pathname.slice("/upload/".length);
      if (!sessionId) return new Response("missing session_id", { status: 400, headers: CORS_HEADERS });

      if (req.method === "GET") {
        const check = verifyUploadSessionId(sessionId);
        if (!check.ok) {
          return new Response(`Upload session ${check.reason}.`, {
            status: 401,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
        return new Response(renderUploadPage(), {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            // Tell Cloudflare not to inject Rocket Loader / minifiers / etc.
            "Cache-Control": "no-transform",
          },
        });
      }
      if (req.method === "POST") return handleUpload(req, sessionId);
      return new Response("GET or POST /upload/<session_id>", { status: 405, headers: CORS_HEADERS });
    }

    // MCP JSON-RPC endpoint
    if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });
    if (req.method !== "POST") return new Response("POST /mcp", { status: 405 });

    // Token check: ?token=… or Authorization: Bearer …, constant-time compare.
    if (token) {
      let given = url.searchParams.get("token") ?? "";
      if (!given) {
        const auth = req.headers.get("authorization") ?? "";
        if (auth.startsWith("Bearer ")) given = auth.slice(7).trim();
      }
      const expectedBuf = Buffer.from(token);
      const givenBuf = Buffer.from(given);
      const ok = givenBuf.length === expectedBuf.length && timingSafeEqual(givenBuf, expectedBuf);
      if (!ok) return new Response("unauthorized", { status: 401, headers: CORS_HEADERS });
    }

    let body: any;
    try {
      body = parseMcpJson(await req.text());
    } catch {
      return Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        { status: 400, headers: CORS_HEADERS });
    }
    const resp = await handle(body);
    if (resp === null) return new Response(null, { status: 204, headers: CORS_HEADERS });
    return Response.json(resp, { headers: CORS_HEADERS });
  },
});

const bindLabel = (bindAddr === "0.0.0.0" || bindAddr === "::") ? "localhost" : bindAddr;
console.error(
  `code-mcp listening on http://${bindLabel}:${port}/mcp` +
  `${token ? " (auth)" : " (no auth)"}` +
  ` — tools: ${Object.keys(tools).join(", ")}`
);
if (publicBaseUrl) {
  console.error(`public base: ${publicBaseUrl} — upload saves to ${UPLOAD_ROOT}/<session_id>/`);
}

// ---------- public tunnel ----------
// If --public is set, open a Cloudflare quick tunnel to our own port.
// The tunnel is tracked as a background job so the shutdown hook kills it.
// Sets publicBaseUrl once the URL is known so get_upload_link becomes usable.
if (makePublic) {
  void (async () => {
    let job: Job | undefined;
    try {
      if (!hasCloudflared) throw new Error("cloudflared not found on PATH");
      const host = bindAddr === "0.0.0.0" ? "127.0.0.1" : bindAddr === "::" ? "::1" : bindAddr;
      const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
      const result = await launchPublicTunnel({ url: `http://${authority}:${httpServer.port}` });
      const match = /^(https:\/\/[a-z0-9-]+\.trycloudflare\.com) \(job ([^)]+)\)$/i.exec(String(result));
      if (!match) throw new Error("invalid public tunnel result");
      job = jobs.get(match[2]);
      if (!job || !jobParentRunning(job)) throw new Error("public tunnel exited before ready");
      publicTunnelJob = job;
      publicBaseUrl = match[1];
      console.error(`public URL: ${publicBaseUrl}/mcp`);
      await job.proc.exited;
    } catch (error) {
      console.error(`warning: public tunnel unavailable: ${String(error)}`);
    } finally {
      if (job && publicTunnelJob === job) {
        publicTunnelJob = undefined;
        publicBaseUrl = null;
      }
    }
  })();
}

// ---------- gateway proxy / diagnostics ----------
// The proxy for a gateway URL, from the usual environment variables (either
// case): HTTPS_PROXY (or ALL_PROXY) for wss://, HTTP_PROXY for ws://. NO_PROXY
// is honoured: "*", a host, a ".domain" or "domain" suffix, optionally ":port".
function gatewayProxyFor(target: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const get = (name: string) => env[name] || env[name.toLowerCase()] || undefined;
  let u: URL;
  try { u = new URL(target); } catch { return undefined; }
  const secure = u.protocol === "wss:" || u.protocol === "https:";
  const proxy = (secure ? get("HTTPS_PROXY") : get("HTTP_PROXY")) || get("ALL_PROXY");
  if (!proxy) return undefined;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const port = u.port || (secure ? "443" : "80");
  for (const raw of (get("NO_PROXY") || "").split(",")) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return undefined;
    const [name, entryPort] = entry.replace(/^\[|\]$/g, "").split(/:(?=\d+$)/);
    if (entryPort && entryPort !== port) continue;
    const bare = name.replace(/^\*?\./, "");
    if (host === bare || host.endsWith("." + bare)) return undefined;
  }
  return proxy;
}

// A proxy URL for logs: never print its credentials.
function redactProxy(proxy: string): string {
  try {
    const u = new URL(proxy);
    if (u.username || u.password) { u.username = "***"; u.password = ""; }
    return u.toString().replace(/\/$/, "");
  } catch { return "(configured)"; }
}

// What to tell the user when the first connection attempt fails, by cause.
function gatewayConnectHint(error: string): string {
  if (/TLS|certificate|handshake|SSL/i.test(error)) {
    return "the TLS connection to the gateway failed. This is usually a network that inspects TLS (a corporate proxy or security agent) or that requires a proxy. "
      + "If it inspects TLS, set NODE_EXTRA_CA_CERTS to your organisation's root certificate (PEM file), or NODE_USE_SYSTEM_CA=1 to trust the operating system's certificates. "
      + "If it requires a proxy, set HTTPS_PROXY. These must be set when code-mcp starts.";
  }
  if (/Expected 101|401|403/.test(error)) {
    return "gateway rejected the upgrade (likely 401) - check that --id and --token (or --gateway-token) match the device id and its registered token in the gateway";
  }
  return "could not reach the gateway (" + (error || "no response") + ") - check the network, the --gateway address, and HTTPS_PROXY if your network needs a proxy";
}

// ---------- gateway client ----------
// If --gateway is set, connect to the gateway server via WebSocket and
// tunnel remote requests to the local MCP handler.
if (gatewayDomain) {
  const deviceId = assignedDeviceId ?? randomUUID();
  const BASE_DELAY_MS = 1000;
  const MAX_DELAY_MS = 60_000;
  let retries = 0;
  let everOpened = false;
  let lastConnectError = "";

  (function connect() {
    // Normalize the gateway domain: accept bare host, ws(s):// or http(s)://
    // prefixes (README examples use wss://). Bare hosts default to wss for
    // anything that is not a loopback/LAN address.
    const isLocal = /^(localhost|127\.|192\.168\.|10\.|172\.16\.|ws:\/\/|http:\/\/)/.test(gatewayDomain);
    let base: string;
    if (/^wss:\/\//i.test(gatewayDomain)) base = gatewayDomain;
    else if (/^https:\/\//i.test(gatewayDomain)) base = gatewayDomain.replace(/^https:\/\//i, "wss://");
    else if (/^ws:\/\//i.test(gatewayDomain)) base = gatewayDomain;
    else if (/^http:\/\//i.test(gatewayDomain)) base = gatewayDomain.replace(/^http:\/\//i, "ws://");
    else base = (isLocal ? "ws://" : "wss://") + gatewayDomain;
    const url = assignedDeviceId ? `${base}/device/ws/${assignedDeviceId}` : `${base}/device/ws`;
    console.error(`[${deviceId}] Connecting to gateway ${url} ...`);
    // Device credential: the hardened gateway requires the token registered for
    // this device id (X-Device-Token header); legacy gateways ignore it.
    // Defensive: never let a token inject headers into the handshake.
    const safeTok = gatewayToken?.replace(/[\r\n]/g, "");
    // Bun's WebSocket ignores HTTPS_PROXY on its own (fetch honours it), so a
    // network that only lets traffic out through a proxy never saw the tunnel.
    const proxy = gatewayProxyFor(url);
    if (proxy && retries === 0) console.error(`[${deviceId}] Using proxy ${redactProxy(proxy)}`);
    const ws = new WebSocket(url, {
      ...(safeTok ? { headers: { "X-Device-Token": safeTok } } : {}),
      ...(proxy ? { proxy } : {}),
    } as any);

    // App-layer keepalive: HTTP/2 tunnels (cloudflared) can swallow WS control
    // frames, so a data-frame heartbeat is what actually proves liveness.
    // Browser-style WebSocket API has no .ping() — we send JSON instead.
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
    const WATCHDOG_MS = 75_000;
    const armWatchdog = () => {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      watchdogTimer = setTimeout(() => {
        console.error(`[${deviceId}] no inbound for ${WATCHDOG_MS}ms; forcing reconnect`);
        try { ws.close(); } catch {}
      }, WATCHDOG_MS);
    };
    const cleanup = () => {
      if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
      if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
    };

    ws.addEventListener("open", () => {
      console.error(`[${deviceId}] Connected to gateway`);
      everOpened = true;
      retries = 0;
      ws.send(JSON.stringify({ type: "register", deviceId }));
      armWatchdog();
      keepaliveTimer = setInterval(() => {
        try { ws.send(JSON.stringify({ type: "keepalive" })); }
        catch (err) {
          console.error(`[${deviceId}] keepalive send failed:`, (err as any)?.message ?? err);
          try { ws.close(); } catch {}
        }
      }, 25_000);
    });

    ws.addEventListener("message", async (e) => {
      armWatchdog();
      try {
        // One additional container belongs to the gateway envelope.
        const msg = parseMcpJson(e.data as string, 257) as { id?: string; request?: Json; token?: string; type?: string };
        if (msg.type === "keepalive-ack") return;
        if (msg.id == null || !Object.hasOwn(msg, "request")) return;
        // In-process dispatch: handle() mirrors the /mcp HTTP handler exactly
        // (initialize, ping, tools/list, tools/call, raw methods, aggregated
        // tools). Bypassing the local HTTP round trip removes per-call TCP +
        // HTTP overhead and keeps the relay responsive under heavy load.
        const resp = await handle(msg.request as Json);
        if (resp === null) {
          // Notification: acknowledge with response:null so the gateway
          // answers 204 No Content (strict clients reject error bodies).
          ws.send(JSON.stringify({ id: msg.id, response: null }));
          return;
        }
        ws.send(JSON.stringify({ id: msg.id, response: resp }));
      } catch (err) {
        console.error(`[${deviceId}] handle error:`, err);
        // A frame rejected before parsing has no trustworthy correlation ID.
        if (err instanceof McpJsonDepthError || err instanceof McpJsonNumberError) { try { ws.close(1009, "JSON parser limit"); } catch {} }
      }
    });

    ws.addEventListener("close", () => {
      cleanup();
      // If the very first attempt never opened, the upgrade was rejected (e.g.
      // 401): give an actionable hint once, then keep retrying.
      if (!everOpened && retries === 0) {
        console.error(`[${deviceId}] hint: ${gatewayConnectHint(lastConnectError)}`);
      }
      // Exponential backoff with jitter — never kill the local server.
      const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(retries, 6))
        + Math.floor(Math.random() * 500);
      retries++;
      console.error(`[${deviceId}] Disconnected; retry #${retries} in ${delay}ms`);
      setTimeout(connect, delay);
    });

    ws.addEventListener("error", (err) => {
      lastConnectError = String((err as any)?.message ?? err);
      console.error(`[${deviceId}] Gateway WS error:`, (err as any)?.message ?? err);
    });
  })();
}

// ---------- shutdown ----------
async function killJobTree(j: { proc: any; status: string }, sig: "SIGTERM" | "SIGKILL", deadline = performance.now() + 3000): Promise<boolean> {
  if (!jobParentRunning(j)) return true;
  const pid = j.proc?.pid;
  if (!pid) return false;
  if (process.platform === "win32") return killProcessTree(pid, () => jobParentRunning(j), deadline);
  // These jobs own a process group. Never signal its numeric ID after the
  // spawned parent has exited, even while inherited pipes remain open.
  try { process.kill(-pid, sig); return true; } catch {}
  if (!jobParentRunning(j)) return true;
  try { j.proc.kill(sig); return false; } catch { return false; }
}

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  await shutdownAggregator();
  console.error(`\n[${signal}] stopping ${jobs.size} job(s)...`);
  await Promise.all([...jobs.values()].filter(job => job.status === "running").map(async job => {
    try { await stopOwnedJob(job); }
    catch (error) { console.error(String(error)); job.cancelCapture?.(); }
  }));
  process.exit(0);
}
