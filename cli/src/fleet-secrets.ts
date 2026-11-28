// What a fleet's publish leaves out because it looks like a secret.
//
// The work tree is mirrored to every member, and through the gateway's storage. A `.env`, a private key or a file with a
// token in it is not the work, and a member that has it does not need to: so a file that is one is left out of the snapshot
// and the publisher is told which and why (and how to let it through). The files stay where they are on the machine that has
// them; the snapshot records which were left out (`kept`, in the sealed metadata) so that a replica does not delete its own.
//
// This is a gate against accidents, not against a person who means to publish a secret: a secret in a file this does not
// recognise goes through, and so does one in a file the operator has allowed.

import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";

import { writeFileAtomic } from "./atomic-write";

const exec = promisify(execFile);

export type SecretGateMode = "off" | "warn" | "exclude";

/** `PRIME_FLEET_SECRET_GATE=off|warn|exclude`; unset (or anything else) is the safe one, `exclude`. */
export function secretGateMode(env: Record<string, string | undefined> = process.env): SecretGateMode {
  const v = (env.PRIME_FLEET_SECRET_GATE ?? "").trim().toLowerCase();
  return v === "off" || v === "warn" || v === "exclude" ? v : "exclude";
}

/** Files bigger than this are not read for content (they are not text a person keeps a secret in). */
export const SCAN_MAX_BYTES = 1024 * 1024;
/** The most paths a snapshot's metadata names as left out. */
export const KEPT_MAX = 256;
const PATH_MAX = 512;

const EXAMPLE = /\.(example|sample|template|dist)$/i;

/** Why this path looks like a secret by its name, or null. Matches on the last segment, and on `.aws/credentials`. */
export function secretPathReason(path: string): string | null {
  const parts = path.split("/");
  const name = parts[parts.length - 1] ?? "";
  const lower = name.toLowerCase();
  if (EXAMPLE.test(lower)) return null;
  if (lower === ".env" || lower.startsWith(".env.")) return "an environment file";
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/.test(lower) && !lower.endsWith(".pub")) return "a private key";
  if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(lower)) return "a key or certificate file";
  if (lower === ".netrc" || lower === "_netrc") return "a netrc file (it holds passwords)";
  if (lower === "credentials.json" || lower === "service-account.json") return "a credentials file";
  if (parts.length >= 2 && parts[parts.length - 2] === ".aws" && lower === "credentials") return "AWS credentials";
  return null;
}

const TOKEN_RULES: Array<{ re: RegExp; what: string }> = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: "a private key" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: "an AWS access key id" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, what: "a GitHub token" },
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/, what: "a Slack token" },
  { re: /\bsk-[A-Za-z0-9_-]{20,}/, what: "an API secret key" },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, what: "a Google API key" },
];

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// An assignment whose name says it is a secret and whose value looks random: `token = "9f8a..."`, `API_SECRET: abcdef...`.
const ASSIGNMENT = /\b[A-Za-z0-9_.-]*(?:secret|token|passwd|password|api[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?([A-Za-z0-9+/=_.-]{32,})["']?/gi;

/** Why this text looks like it holds a secret, or null. */
export function secretContentReason(text: string): string | null {
  for (const rule of TOKEN_RULES) if (rule.re.test(text)) return rule.what;
  for (const m of text.matchAll(ASSIGNMENT)) {
    const value = m[1]!;
    if (entropy(value) > 4.5) return "a secret assigned to a name that says so";
  }
  return null;
}

/** A glob (`*` within a segment, `**` across them, `?`) as the expression that matches a whole path. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") i++;
        re += "(?:.*/)?";
        // a trailing ** matches anything below
        if (i === glob.length - 1) re = re.slice(0, -"(?:.*/)?".length) + ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

export function isAllowed(path: string, allow: readonly string[]): boolean {
  return allow.some((g) => globToRegExp(g).test(path));
}

// ---- the operator's allow list, beside the member's key file ---------------------------------------------

export function allowFile(keyFile: string): string {
  return keyFile + ".secrets.json";
}

export function readAllow(keyFile: string): string[] {
  const file = allowFile(keyFile);
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { allow?: unknown };
    return Array.isArray(raw.allow) ? raw.allow.filter((g): g is string => typeof g === "string" && g.length > 0 && g.length <= PATH_MAX) : [];
  } catch {
    return [];
  }
}

export function writeAllow(keyFile: string, allow: string[]): void {
  writeFileAtomic(allowFile(keyFile), JSON.stringify({ allow: [...new Set(allow)].sort() }, null, 2) + "\n", 0o600);
}

// ---- looking at a tree ------------------------------------------------------------------------------------

export interface SecretHit {
  path: string;
  why: string;
}

const gitEnv = (gitDir: string): Record<string, string> => ({ ...(process.env as Record<string, string>), GIT_DIR: gitDir, GIT_OPTIONAL_LOCKS: "0" });

/** blob id -> why it looks like a secret (or null); what has been read once is not read again in this process. */
const contentCache = new Map<string, string | null>();
const CACHE_MAX = 50_000;
export function forgetScanned(): void {
  contentCache.clear();
}

/** Read blobs one after another through one `git cat-file --batch`. */
async function readBlobs(gitDir: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const child = spawn("git", ["cat-file", "--batch"], { env: gitEnv(gitDir), stdio: ["pipe", "pipe", "ignore"] });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (d: Buffer) => chunks.push(d));
  const done = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", () => resolve());
  });
  child.stdin.end(ids.join("\n") + "\n");
  await done;
  const buf = Buffer.concat(chunks);
  let at = 0;
  for (const id of ids) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) break;
    const header = buf.subarray(at, nl).toString("utf8").split(" ");
    if (header[1] === "missing") {
      at = nl + 1;
      continue;
    }
    const size = Number(header[2]);
    if (!Number.isSafeInteger(size)) break;
    const body = buf.subarray(nl + 1, nl + 1 + size);
    // A file with a NUL in it is not text.
    if (!body.includes(0)) out.set(id, body.toString("utf8"));
    at = nl + 1 + size + 1;
  }
  return out;
}

/**
 * The files of a snapshot's tree that look like secrets, and are not allowed: by name, and by what a text file of at most
 * `SCAN_MAX_BYTES` holds. `tree` is read from the member's object store (`gitDir`), so nothing in the work tree is touched.
 */
export async function findSecrets(gitDir: string, tree: string, allow: readonly string[] = []): Promise<SecretHit[]> {
  const listed = (await exec("git", ["ls-tree", "-r", "-z", "--long", tree], { env: gitEnv(gitDir), maxBuffer: 256 * 1024 * 1024, encoding: "utf8" })).stdout;
  const hits: SecretHit[] = [];
  const toRead: Array<{ id: string; path: string }> = [];
  for (const row of listed.split("\u0000")) {
    if (row === "") continue;
    const tab = row.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, id, size] = row.slice(0, tab).split(/\s+/);
    const path = row.slice(tab + 1);
    if (type !== "blob" || mode === "120000" || id === undefined) continue; // a symbolic link is a name, not a file's content
    if (isAllowed(path, allow)) continue;
    const byName = secretPathReason(path);
    if (byName !== null) {
      hits.push({ path, why: byName });
      continue;
    }
    if (Number(size) > SCAN_MAX_BYTES || Number(size) === 0) continue;
    const cached = contentCache.get(id);
    if (cached !== undefined) {
      if (cached !== null) hits.push({ path, why: cached });
      continue;
    }
    toRead.push({ id, path });
  }
  const unique = [...new Set(toRead.map((t) => t.id))];
  for (let i = 0; i < unique.length; i += 500) {
    const part = unique.slice(i, i + 500);
    const texts = await readBlobs(gitDir, part);
    for (const id of part) {
      if (contentCache.size >= CACHE_MAX) contentCache.clear();
      const text = texts.get(id);
      contentCache.set(id, text === undefined ? null : secretContentReason(text));
    }
  }
  for (const t of toRead) {
    const why = contentCache.get(t.id);
    if (why) hits.push({ path: t.path, why });
  }
  return hits.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The paths a snapshot's metadata says were left out; what is not a plain list of paths is ignored. */
export function keptFrom(kept: unknown): string[] {
  if (!Array.isArray(kept)) return [];
  return kept.filter((p): p is string => typeof p === "string" && p.length > 0 && p.length <= PATH_MAX).slice(0, KEPT_MAX);
}
