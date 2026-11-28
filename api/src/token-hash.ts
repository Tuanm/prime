// What the gateway keeps for a token: a verifier, never the token.
//
// A verifier is "h1:" + base64url(HMAC-SHA256(TOKEN_PEPPER, "prime-<kind>:" + token)).
// The pepper is a Worker secret, kept apart from the Durable Object storage the
// verifiers live in, so a copy of that storage yields nothing a client could
// present - even for a short anonymous code (older ones are 6 characters), which an unkeyed hash would
// give up in seconds. A check hashes what the client sent and compares.

import { timingSafeEq } from "./config";

export type TokenKind = "device" | "fleet";

const PREFIX = "h1:";
const VERIFIER_RE = /^h1:[A-Za-z0-9_-]{43}$/;
const MIN_PEPPER = 32;

/** No usable TOKEN_PEPPER: nothing can be hashed, so nothing is checked. */
export class PepperMissingError extends Error {
  constructor() {
    super("TOKEN_PEPPER is not set");
    this.name = "PepperMissingError";
  }
}

/** The answer a request gets when the gateway cannot check a token at all. */
export function pepperMissingResponse(): Response {
  return Response.json({ error: "TOKEN_PEPPER is not set" }, { status: 503 });
}

/** The pepper, or null when it is unset or too short to be one. */
export function pepperFrom(env: { TOKEN_PEPPER?: string }): string | null {
  const p = env.TOKEN_PEPPER;
  return typeof p === "string" && p.length >= MIN_PEPPER ? p : null;
}

const encoder = new TextEncoder();
let cachedKey: { pepper: string; key: Promise<CryptoKey> } | null = null;

function pepperKey(env: { TOKEN_PEPPER?: string }): Promise<CryptoKey> {
  const pepper = pepperFrom(env);
  if (pepper === null) return Promise.reject(new PepperMissingError());
  if (!cachedKey || cachedKey.pepper !== pepper) {
    const key = crypto.subtle.importKey("raw", encoder.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    cachedKey = { pepper, key };
  }
  return cachedKey.key;
}

function b64url(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function mac(env: { TOKEN_PEPPER?: string }, message: string): Promise<ArrayBuffer> {
  return crypto.subtle.sign("HMAC", await pepperKey(env), encoder.encode(message));
}

/** The verifier of a token. Throws PepperMissingError without a pepper. */
export async function verifierFor(env: { TOKEN_PEPPER?: string }, kind: TokenKind, token: string): Promise<string> {
  return PREFIX + b64url(await mac(env, "prime-" + kind + ":" + token));
}

/** Whether a stored value is a verifier. */
export function isVerifier(value: unknown): value is string {
  return typeof value === "string" && VERIFIER_RE.test(value);
}

/**
 * Whether the token a client sent matches what is stored.
 *
 * False for an empty token, for nothing stored, for a stored value that is not
 * a verifier, and when there is no pepper: a check that cannot be made fails.
 */
export async function tokenVerifies(
  env: { TOKEN_PEPPER?: string },
  kind: TokenKind,
  given: string | null | undefined,
  stored: string | undefined,
): Promise<boolean> {
  if (!given || !isVerifier(stored) || pepperFrom(env) === null) return false;
  return timingSafeEq(await verifierFor(env, kind, given), stored);
}

/** A short handle the admin page can show: tells two tokens apart, opens neither. */
export async function fingerprint(stored: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(stored));
  let hex = "";
  for (const b of new Uint8Array(digest).slice(0, 4)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * The key a sandbox ticket is signed with, for one device's verifier.
 *
 * Derived through the pepper, so the verifiers alone cannot mint a ticket, and
 * a replaced token invalidates the tickets signed for the old one.
 */
export async function ticketKey(env: { TOKEN_PEPPER?: string }, verifier: string): Promise<CryptoKey> {
  const raw = await mac(env, "prime-ticket:" + verifier);
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
