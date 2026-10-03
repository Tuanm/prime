// Minimal, dependency-free argument parser.
//
// Supported forms: --flag, --flag=value, --flag value, -h. Everything after a
// literal `--` is positional, which is how JSON arguments that begin with "-"
// are passed safely.

import { UsageError } from "./errors.ts";

export type FlagType = "string" | "number" | "boolean";

export type FlagValue = string | number | boolean;

export interface FlagSpec {
  name: string;
  type: FlagType;
  short?: string;
  /** Value placeholder shown in help, e.g. "<url>". */
  placeholder?: string;
  description: string;
  /** Collect every occurrence into an array instead of keeping the last one. */
  repeatable?: boolean;
}

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, FlagValue | FlagValue[]>;
  help: boolean;
}

export function flag(
  name: string,
  type: FlagType,
  description: string,
  extra: { short?: string; placeholder?: string; repeatable?: boolean } = {},
): FlagSpec {
  return { name, type, description, ...extra };
}

/** Flags accepted by every command. */
export const GLOBAL_FLAGS: FlagSpec[] = [
  flag("help", "boolean", "Show help for this command", { short: "h" }),
  flag("json", "boolean", "Machine-readable JSON output"),
  flag("no-color", "boolean", "Disable coloured output"),
  flag("config", "string", "Path to the config file", { placeholder: "<path>" }),
  flag("verbose", "boolean", "Show timing and connection details"),
  flag("quiet", "boolean", "Only print errors"),
];

export function parseArgs(argv: string[], specs: FlagSpec[]): ParsedArgs {
  const byName = new Map<string, FlagSpec>();
  const byShort = new Map<string, FlagSpec>();
  for (const spec of [...specs, ...GLOBAL_FLAGS]) {
    byName.set(spec.name, spec);
    if (spec.short) byShort.set(spec.short, spec);
  }

  const positionals: string[] = [];
  const flags = new Map<string, FlagValue | FlagValue[]>();
  let help = false;
  let sawDoubleDash = false;

  const store = (spec: FlagSpec, value: FlagValue): void => {
    if (!spec.repeatable) {
      flags.set(spec.name, value);
      return;
    }
    const previous = flags.get(spec.name);
    flags.set(spec.name, Array.isArray(previous) ? [...previous, value] : [value]);
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (sawDoubleDash) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      sawDoubleDash = true;
      continue;
    }

    let spec: FlagSpec | undefined;
    let rawValue: string | undefined;
    let display = token;

    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      if (eq !== -1) rawValue = token.slice(eq + 1);
      spec = byName.get(name);
      display = `--${name}`;
    } else if (token.startsWith("-") && token.length > 1) {
      const name = token.slice(1);
      spec = byShort.get(name);
      display = `-${name}`;
    } else {
      positionals.push(token);
      continue;
    }

    if (!spec) {
      throw new UsageError(
        `unknown option "${display}"`,
        `Run with --help to see the available options.`,
      );
    }

    if (spec.type === "boolean") {
      if (rawValue !== undefined) {
        store(spec, !/^(false|0|no)$/i.test(rawValue));
      } else {
        store(spec, true);
      }
    } else {
      let value = rawValue;
      if (value === undefined) {
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith("-") && next.length > 1 && !/^-?\d/.test(next))) {
          throw new UsageError(`option ${display} requires a value`);
        }
        value = next;
        i++;
      }
      if (spec.type === "number") {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) throw new UsageError(`option ${display} expects a number, got "${value}"`);
        store(spec, parsed);
      } else {
        store(spec, value);
      }
    }

    if (spec.name === "help") help = true;
  }

  return { positionals, flags, help };
}

export function str(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function num(parsed: ParsedArgs, name: string): number | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "number" ? value : undefined;
}

export function bool(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.get(name) === true;
}

/** Every occurrence of a repeatable flag, in order. */
export function strList(parsed: ParsedArgs, name: string): string[] {
  const value = parsed.flags.get(name);
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return typeof value === "string" ? [value] : [];
}
