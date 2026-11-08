// Persistent configuration: ~/.prime/config.yaml
//
// Shape (everything optional except `devices`):
//
//   defaults:
//     gateway: "https://prime.tuanm.workers.dev"
//     gateway_token: "gw-..."
//     token: "dev-..."
//     timeout_ms: 300000
//   devices:
//     my-device:
//       gateway: "https://other.example.dev"   # optional per-device override
//       gateway_token: "gw-..."
//       token: "dev-..."
//       connected_at: "2026-01-01T00:00:00.000Z"
//     anon-0123456789abcdef:                 # created by 'prime connect'
//       gateway: "https://prime.tuanm.workers.dev"
//       token: "A1B2C3"                       # the anonymous device code
//       anonymous: true
//   code-mcp:                                # options for 'prime code-mcp' and
//     port: "7777"                           # 'prime service install' - code-mcp's
//     bind: "127.0.0.1"                      # own flags, without the dashes
//     id: "demo"
//     token: "demo"
//     enable-memory: true
//
// The file holds secrets, so it is created 0600 inside a 0700 directory, and
// writes are atomic (temp file + rename) so a crash cannot truncate it.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "./errors.ts";

export interface DeviceEntry {
  gateway?: string;
  gateway_token?: string;
  token?: string;
  connected_at?: string;
  note?: string;
  /** Created by 'prime connect' via POST /api/devices/anonymous (reused per gateway). */
  anonymous?: boolean;
  /** A local MCP endpoint (a space) instead of a gateway tunnel. */
  local_url?: string;
  /** The space this local device belongs to. */
  space?: string;
}

export interface Defaults {
  gateway?: string;
  gateway_token?: string;
  token?: string;
  timeout_ms?: number;
}

/** code-mcp's own options (flag names without "--"); see code-mcp-options.ts. */
export type CodeMcpSection = Record<string, string | boolean>;

/** A local codespace: a rootless container running this machine's device buddy. */
export interface SpaceEntry {
  /** Device id the space answers as (also its container label). */
  id: string;
  runtime: string;
  image: string;
  mode: "persistent" | "ephemeral";
  container: string;
  volume?: string;
  network?: string;
  token: string;
  /** Host loopback port (podman/docker); 7777 inside an Apple space. */
  port?: number;
  cpus?: number;
  memory?: string;
  offline?: boolean;
  /** How the container manager applied limits: systemd, cgroupfs, or disabled. */
  cgroup_mode?: "systemd" | "cgroupfs" | "disabled";
  /** Host directory (0700) holding the token file mounted read-only. */
  secret_dir?: string;
  /** Companies whose values/secrets/codes this space may use. */
  vaults?: string[];
  /** Optional subset of categories: value, secret, code (default: all). */
  vault_kinds?: Array<"value" | "secret" | "code">;
  /** Trusted spaces may receive secrets/codes; untrusted ones only values. */
  trusted?: boolean;
  /** Host broker capability token while the space is running. */
  broker_token?: string;
  /** Broker HTTP URL the space's run tool uses. */
  broker_url?: string;
  /** Interface the broker listener is bound to. */
  broker_bind?: string;
  /** Publish this space through a gateway as an anonymous device. */
  expose?: boolean;
  /** Gateway origin used for --expose. */
  gateway?: string;
  /** Gateway device id assigned to this space (anonymous). */
  gateway_device?: string;
  /** Device token for the gateway device (not the local MCP token). */
  remote_token?: string;
  /** Gateway credential used for registration/probes, when the gateway needs one. */
  gateway_token?: string;
  /** Where the MCP server answers right now; recomputed on every start. */
  local_url?: string;
  created_at?: string;
}

export interface Config {
  defaults: Defaults;
  devices: Record<string, DeviceEntry>;
  /** Codespaces, keyed by their user-facing name. */
  spaces: Record<string, SpaceEntry>;
  /** The "code-mcp:" section. Kept verbatim (validated where it is used). */
  codeMcp: CodeMcpSection;
}

export function defaultConfigPath(): string {
  const override = process.env.PRIME_CONFIG;
  if (override && override.trim().length > 0) return override.trim();
  return join(homedir(), ".prime", "config.yaml");
}

export function emptyConfig(): Config {
  return { defaults: {}, devices: {}, spaces: {}, codeMcp: {} };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Parse the YAML text into a validated Config (never throws on unknown keys). */
export function parseConfig(text: string, source: string): Config {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text);
  } catch (err) {
    throw new CliError(
      `invalid YAML in ${source}: ${err instanceof Error ? err.message : String(err)}`,
      "Fix the file, or delete it to start fresh.",
    );
  }
  if (raw === null || raw === undefined) return emptyConfig();
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new CliError(`invalid config in ${source}: expected a YAML mapping at the top level`);
  }
  const doc = raw as Record<string, unknown>;
  const config = emptyConfig();

  const defaults = asRecord(doc.defaults);
  config.defaults = {
    gateway: asString(defaults.gateway),
    gateway_token: asString(defaults.gateway_token),
    token: asString(defaults.token),
    timeout_ms: typeof defaults.timeout_ms === "number" ? defaults.timeout_ms : undefined,
  };

  for (const [id, value] of Object.entries(asRecord(doc.devices))) {
    const entry = asRecord(value);
    config.devices[id] = {
      gateway: asString(entry.gateway),
      gateway_token: asString(entry.gateway_token),
      token: asString(entry.token),
      connected_at: asString(entry.connected_at),
      note: asString(entry.note),
      ...(entry.anonymous === true ? { anonymous: true } : {}),
      ...(asString(entry.local_url) ? { local_url: asString(entry.local_url) } : {}),
      ...(asString(entry.space) ? { space: asString(entry.space) } : {}),
    };
  }

  for (const [name, value] of Object.entries(asRecord(doc.spaces))) {
    const entry = asRecord(value);
    const mode = entry.mode === "persistent" ? "persistent" : "ephemeral";
    config.spaces[name] = {
      id: asString(entry.id) ?? "",
      runtime: asString(entry.runtime) ?? "",
      image: asString(entry.image) ?? "",
      mode,
      container: asString(entry.container) ?? "",
      token: asString(entry.token) ?? "",
      ...(asString(entry.volume) ? { volume: asString(entry.volume) } : {}),
      ...(asString(entry.network) ? { network: asString(entry.network) } : {}),
      ...(typeof entry.port === "number" ? { port: entry.port } : {}),
      ...(typeof entry.cpus === "number" ? { cpus: entry.cpus } : {}),
      ...(asString(entry.memory) ? { memory: asString(entry.memory) } : {}),
      ...(entry.offline === true ? { offline: true } : {}),
      ...(entry.cgroup_mode === "systemd" || entry.cgroup_mode === "cgroupfs" || entry.cgroup_mode === "disabled"
        ? { cgroup_mode: entry.cgroup_mode }
        : {}),
      ...(asString(entry.secret_dir) ? { secret_dir: asString(entry.secret_dir) } : {}),
      ...(Array.isArray(entry.vaults) ? { vaults: entry.vaults.filter((flag): flag is string => typeof flag === "string") } : {}),
      ...(entry.trusted === true ? { trusted: true } : {}),
      ...(asString(entry.broker_token) ? { broker_token: asString(entry.broker_token) } : {}),
      ...(asString(entry.broker_url) ? { broker_url: asString(entry.broker_url) } : {}),
      ...(asString(entry.broker_bind) ? { broker_bind: asString(entry.broker_bind) } : {}),
      ...(Array.isArray(entry.vault_kinds)
        ? {
            vault_kinds: entry.vault_kinds.filter(
              (kind): kind is "value" | "secret" | "code" => kind === "value" || kind === "secret" || kind === "code",
            ),
          }
        : {}),
      ...(entry.expose === true ? { expose: true } : {}),
      ...(asString(entry.gateway) ? { gateway: asString(entry.gateway) } : {}),
      ...(asString(entry.gateway_device) ? { gateway_device: asString(entry.gateway_device) } : {}),
      ...(asString(entry.remote_token) ? { remote_token: asString(entry.remote_token) } : {}),
      ...(asString(entry.gateway_token) ? { gateway_token: asString(entry.gateway_token) } : {}),
      ...(asString(entry.local_url) ? { local_url: asString(entry.local_url) } : {}),
      ...(asString(entry.created_at) ? { created_at: asString(entry.created_at) } : {}),
    };
  }

  // Scalars only: numbers are kept as their text ("7777"), booleans as flags.
  const section = doc["code-mcp"];
  if (section !== undefined && section !== null) {
    if (typeof section !== "object" || Array.isArray(section)) {
      throw new CliError(`invalid config in ${source}: "code-mcp" must be a mapping of code-mcp options`, 'e.g.\ncode-mcp:\n  port: "7777"');
    }
    for (const [key, value] of Object.entries(section as Record<string, unknown>)) {
      if (typeof value === "boolean" || typeof value === "string") config.codeMcp[key] = value;
      else if (typeof value === "number" && Number.isFinite(value)) config.codeMcp[key] = String(value);
      else if (value === null) continue; // "key:" with no value - treat as unset
      else throw new CliError(`invalid config in ${source}: code-mcp.${key} must be a string, number or true/false`);
    }
  }
  return config;
}

export function loadConfig(path: string): Config {
  if (!existsSync(path)) return emptyConfig();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new CliError(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (text.trim().length === 0) return emptyConfig();
  return parseConfig(text, path);
}

/** Quote a scalar so the emitter is correct for any string content. */
export function yamlScalar(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "0";
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`)}"`;
}

function emitSection(name: string, entries: Record<string, string | number | undefined>): string {
  const pairs = Object.entries(entries).filter(([, v]) => v !== undefined);
  if (pairs.length === 0) return "";
  let out = `${name}:\n`;
  for (const [key, value] of pairs) out += `  ${key}: ${yamlScalar(value as string | number)}\n`;
  return out;
}

/** Serialize deterministically: fixed key order, every string quoted. */
export function serializeConfig(config: Config): string {
  let out = "# Prime gateway CLI configuration\n";
  out += "# Generated by 'prime devices connect'. Holds secrets: keep it private (0600).\n";
  const defaults = emitSection("defaults", {
    gateway: config.defaults.gateway,
    gateway_token: config.defaults.gateway_token,
    token: config.defaults.token,
    timeout_ms: config.defaults.timeout_ms,
  });
  if (defaults) out += `\n${defaults}`;

  const ids = Object.keys(config.devices).sort();
  if (ids.length === 0) {
    out += "\ndevices: {}\n";
  } else {
    out += "\ndevices:\n";
    for (const id of ids) {
      const entry = config.devices[id]!;
      out += `  ${/^[A-Za-z0-9._-]+$/.test(id) ? id : yamlScalar(id)}:\n`;
      for (const [key, value] of [
        ["gateway", entry.gateway],
        ["gateway_token", entry.gateway_token],
        ["token", entry.token],
        ["connected_at", entry.connected_at],
        ["note", entry.note],
        ["anonymous", entry.anonymous === true ? true : undefined],
        ["local_url", entry.local_url],
        ["space", entry.space],
      ] as const) {
        if (value !== undefined) out += `    ${key}: ${yamlScalar(value)}\n`;
      }
    }
  }

  const spaceNames = Object.keys(config.spaces).sort();
  if (spaceNames.length > 0) {
    out += "\n# Codespaces: 'prime spaces ...' manages these; the matching device entry is local.\nspaces:\n";
    for (const name of spaceNames) {
      const space = config.spaces[name]!;
      out += `  ${/^[A-Za-z0-9._-]+$/.test(name) ? name : yamlScalar(name)}:\n`;
      if (space.trusted === true) out += "    trusted: true\n";
      if (space.broker_token) out += "    broker_token: " + yamlScalar(space.broker_token) + "\n";
      if (space.broker_url) out += "    broker_url: " + yamlScalar(space.broker_url) + "\n";
      if (space.broker_bind) out += "    broker_bind: " + yamlScalar(space.broker_bind) + "\n";
      if (space.vaults && space.vaults.length > 0) {
        out += "    vaults: [" + space.vaults.map((name) => yamlScalar(name)).join(", ") + "]\n";
      }
      if (space.vault_kinds && space.vault_kinds.length > 0) {
        out += "    vault_kinds: [" + space.vault_kinds.map((kind) => yamlScalar(kind)).join(", ") + "]\n";
      }
      for (const [key, value] of [
        ["id", space.id],
        ["runtime", space.runtime],
        ["image", space.image],
        ["mode", space.mode],
        ["container", space.container],
        ["volume", space.volume],
        ["network", space.network],
        ["token", space.token],
        ["port", space.port],
        ["cpus", space.cpus],
        ["memory", space.memory],
        ["offline", space.offline === true ? true : undefined],
        ["cgroup_mode", space.cgroup_mode],
        ["secret_dir", space.secret_dir],
        ["expose", space.expose === true ? true : undefined],
        ["gateway", space.gateway],
        ["gateway_device", space.gateway_device],
        ["remote_token", space.remote_token],
        ["gateway_token", space.gateway_token],
        ["local_url", space.local_url],
        ["created_at", space.created_at],
      ] as const) {
        if (value !== undefined) out += `    ${key}: ${yamlScalar(value)}\n`;
      }
    }
  }

  // Preserved on every save: 'prime connect' and 'prime devices connect' rewrite the
  // file, and must never drop the user's code-mcp options.
  const optionKeys = Object.keys(config.codeMcp);
  if (optionKeys.length > 0) {
    out += "\ncode-mcp:\n";
    for (const key of optionKeys) {
      out += `  ${/^[A-Za-z0-9._-]+$/.test(key) ? key : yamlScalar(key)}: ${yamlScalar(config.codeMcp[key]!)}\n`;
    }
  }
  return out;
}

/** Atomic write with restrictive permissions. */
export function saveConfig(path: string, config: Config): void {
  const dir = dirname(path);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new CliError(`cannot create ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, serializeConfig(config), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    throw new CliError(`cannot write ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // rename() preserves the temp file mode, but an existing target could have had
  // looser permissions from a previous tool - enforce 0600 on the final path.
  try {
    chmodSync(path, 0o600);
  } catch {}
}
