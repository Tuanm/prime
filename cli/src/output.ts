// Terminal output: colour, tables, and MCP tool-result rendering.
//
// Colour is opt-out (NO_COLOR / --no-color / not a TTY) so piping is always clean.

export interface OutputOptions {
  json?: boolean;
  color?: boolean;
  quiet?: boolean;
}

let colorEnabled = false;

export function initColor(explicit: boolean | undefined): void {
  if (explicit !== undefined) {
    colorEnabled = explicit;
    return;
  }
  colorEnabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
}

export function color(code: number, text: string): string {
  return colorEnabled ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const dim = (t: string) => color(90, t);
export const bold = (t: string) => color(1, t);
export const red = (t: string) => color(31, t);
export const green = (t: string) => color(32, t);
export const yellow = (t: string) => color(33, t);
export const cyan = (t: string) => color(36, t);

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Render a simple aligned table (no dependency, no padding surprises). */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(strWidth(h), ...rows.map((r) => strWidth(r[i] ?? ""))));
  const line = (cells: string[]) => cells.map((c, i) => pad(c, widths[i]!)).join("  ").replace(/\s+$/, "");
  const out = [line(headers.map((h) => bold(h))), ...rows.map(line)];
  return out.join("\n");
}

/** Visible width, ignoring ANSI escapes. */
function strWidth(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function pad(text: string, width: number): string {
  const diff = width - strWidth(text);
  return diff > 0 ? text + " ".repeat(diff) : text;
}

export interface RenderedResult {
  text: string;
  isError: boolean;
  /** True when the result had no text content (rendered as JSON instead). */
  raw: boolean;
}

/**
 * Render an MCP `tools/call` result.
 *
 * The spec shape is `{ content: [{type:"text", text|data}, ...], isError? }`;
 * text blocks are concatenated, non-text blocks become a short placeholder,
 * and anything unexpected falls back to raw JSON so nothing is ever lost.
 */
export function renderToolResult(result: unknown): RenderedResult {
  if (result === null || result === undefined) return { text: "", isError: false, raw: false };
  if (typeof result !== "object") return { text: String(result), isError: false, raw: true };

  const obj = result as { content?: unknown; isError?: unknown; structuredContent?: unknown };
  const isError = obj.isError === true;
  const blocks = Array.isArray(obj.content) ? obj.content : undefined;

  if (blocks) {
    const parts: string[] = [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: unknown; text?: unknown; mimeType?: unknown; data?: unknown };
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      else if (b.type === "image") parts.push(`[image ${typeof b.mimeType === "string" ? b.mimeType : ""} ${typeof b.data === "string" ? `${b.data.length} b64 chars` : ""}]`);
      else if (typeof b.type === "string") parts.push(`[${b.type}]`);
    }
    if (parts.length > 0) return { text: parts.join("\n"), isError, raw: false };
  }

  if (obj.structuredContent !== undefined && blocks === undefined) {
    return { text: JSON.stringify(obj.structuredContent, null, 2), isError, raw: true };
  }
  return { text: JSON.stringify(result, null, 2), isError, raw: true };
}

/** Does an MCP tool result report failure via `isError`? */
export function isErrorResult(result: unknown): boolean {
  return Boolean(result && typeof result === "object" && (result as { isError?: unknown }).isError === true);
}

/** "1 tool" / "3 tools" */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function truncate(text: string, max = 72): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
