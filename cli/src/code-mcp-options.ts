// code-mcp's command-line options, as the "code-mcp:" config section and as
// arguments to 'mcp code-mcp' / 'mcp service install'.
//
// The list mirrors code-mcp's own parseArgs table (src/code-mcp.ts). It is
// validated here so a typo in config.yaml fails with a message about the config
// file, not with code-mcp's usage text from inside a service log.

import { type CodeMcpSection } from "./config.ts";
import { UsageError } from "./errors.ts";

export type OptionType = "string" | "boolean";

/** code-mcp's options (help excluded: it is passed straight through). */
export const CODE_MCP_OPTIONS: Readonly<Record<string, OptionType>> = {
  port: "string",
  bind: "string",
  token: "string",
  "enable-memory": "boolean",
  "disallowed-tools": "string",
  public: "boolean",
  domain: "string",
  mcp: "string",
  gateway: "string",
  id: "string",
  "gateway-token": "string",
};

/** Options whose values are credentials: never echoed back in full. */
export const SECRET_OPTIONS = new Set(["token", "gateway-token"]);

/** What a bare --gateway means to code-mcp (it inserts the same default). */
export const CODE_MCP_DEFAULT_GATEWAY = "code-mcp.tuanm.workers.dev";

export type OptionMap = Record<string, string | boolean>;

function unknownOption(name: string, where: string): UsageError {
  const known = Object.keys(CODE_MCP_OPTIONS).join(", ");
  return new UsageError(`unknown code-mcp option "${name}" ${where}`, `Known options: ${known}.`);
}

/** Validate the config section (key names and value types). */
export function optionsFromConfig(section: CodeMcpSection, source: string): OptionMap {
  const out: OptionMap = {};
  for (const [key, value] of Object.entries(section)) {
    const type = CODE_MCP_OPTIONS[key];
    if (!type) throw unknownOption(key, `in the code-mcp section of ${source}`);
    if (type === "boolean") {
      if (typeof value !== "boolean") {
        throw new UsageError(`code-mcp.${key} in ${source} must be true or false`, `e.g. ${key}: true`);
      }
      out[key] = value;
    } else {
      if (typeof value !== "string" || value.length === 0) {
        throw new UsageError(`code-mcp.${key} in ${source} must be a non-empty string`, `e.g. ${key}: "value"`);
      }
      out[key] = value;
    }
  }
  return out;
}

/**
 * Parse code-mcp style arguments: --name value, --name=value, boolean flags.
 * A bare --gateway means code-mcp's default gateway, exactly as code-mcp reads it.
 * --help/-h is reported separately so it can be passed straight through.
 */
export function parseCodeMcpArgs(args: string[]): { options: OptionMap; help: boolean } {
  const options: OptionMap = {};
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new UsageError(`unexpected argument "${arg}"`, "code-mcp takes only --option flags, e.g. --port 7777");
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const type = CODE_MCP_OPTIONS[name];
    if (!type) throw unknownOption(name, "on the command line");
    if (type === "boolean") {
      if (eq !== -1) {
        const text = arg.slice(eq + 1);
        if (text !== "true" && text !== "false") throw new UsageError(`--${name} takes no value (or =true / =false)`);
        options[name] = text === "true";
      } else {
        options[name] = true;
      }
      continue;
    }
    if (eq !== -1) {
      options[name] = arg.slice(eq + 1);
      continue;
    }
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) {
      if (name === "gateway") {
        options[name] = CODE_MCP_DEFAULT_GATEWAY;
        continue;
      }
      throw new UsageError(`--${name} needs a value`);
    }
    options[name] = next;
    i++;
  }
  return { options, help };
}

/** Later layers win: config, then overrides (service install), then the command line. */
export function mergeOptions(...layers: OptionMap[]): OptionMap {
  return Object.assign({}, ...layers) as OptionMap;
}

/** The argv code-mcp should see, in a stable order. false booleans are omitted. */
export function toCodeMcpArgv(options: OptionMap): string[] {
  const argv: string[] = [];
  for (const name of Object.keys(CODE_MCP_OPTIONS)) {
    const value = options[name];
    if (value === undefined || value === false) continue;
    if (value === true) argv.push(`--${name}`);
    else argv.push(`--${name}`, value);
  }
  return argv;
}

/** For display: secrets reduced to a hint. */
export function describeOptions(options: OptionMap): string {
  const parts = Object.keys(CODE_MCP_OPTIONS)
    .filter((name) => options[name] !== undefined && options[name] !== false)
    .map((name) => {
      const value = options[name]!;
      if (value === true) return `--${name}`;
      if (SECRET_OPTIONS.has(name)) return `--${name} ***`;
      return `--${name} ${value}`;
    });
  return parts.length > 0 ? parts.join(" ") : "(code-mcp defaults)";
}
