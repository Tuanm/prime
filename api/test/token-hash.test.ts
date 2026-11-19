import { describe, expect, test } from "bun:test";
import {
  PepperMissingError,
  fingerprint,
  isVerifier,
  pepperFrom,
  ticketKey,
  tokenVerifies,
  verifierFor,
} from "../src/token-hash";

const env = { TOKEN_PEPPER: "p".repeat(32) };
const other = { TOKEN_PEPPER: "q".repeat(32) };

describe("verifierFor", () => {
  test("is deterministic, marked h1:, and recognised as a verifier", async () => {
    const a = await verifierFor(env, "device", "tok");
    expect(a).toBe(await verifierFor(env, "device", "tok"));
    expect(a.startsWith("h1:")).toBe(true);
    expect(isVerifier(a)).toBe(true);
  });

  test("depends on the kind and on the pepper", async () => {
    const device = await verifierFor(env, "device", "tok");
    expect(await verifierFor(env, "fleet", "tok")).not.toBe(device);
    expect(await verifierFor(other, "device", "tok")).not.toBe(device);
  });

  test("never contains the token", async () => {
    const v = await verifierFor(env, "device", "A1B2C3");
    expect(v.includes("A1B2C3")).toBe(false);
  });

  test("refuses to run without a pepper", async () => {
    await expect(verifierFor({}, "device", "tok")).rejects.toBeInstanceOf(PepperMissingError);
    await expect(verifierFor({ TOKEN_PEPPER: "short" }, "device", "tok")).rejects.toBeInstanceOf(PepperMissingError);
  });
});

describe("pepperFrom", () => {
  test("is null when unset or shorter than 32 characters", () => {
    expect(pepperFrom({})).toBeNull();
    expect(pepperFrom({ TOKEN_PEPPER: "" })).toBeNull();
    expect(pepperFrom({ TOKEN_PEPPER: "x".repeat(31) })).toBeNull();
    expect(pepperFrom(env)).toBe(env.TOKEN_PEPPER);
  });
});

describe("isVerifier", () => {
  test("rejects raw tokens and malformed values", () => {
    expect(isVerifier("tok")).toBe(false);
    expect(isVerifier("h1:short")).toBe(false);
    expect(isVerifier(undefined)).toBe(false);
    expect(isVerifier(42)).toBe(false);
  });
});

describe("tokenVerifies", () => {
  test("accepts the token the verifier was made from", async () => {
    const stored = await verifierFor(env, "device", "tok");
    expect(await tokenVerifies(env, "device", "tok", stored)).toBe(true);
  });

  test("refuses a wrong, empty or missing token", async () => {
    const stored = await verifierFor(env, "device", "tok");
    expect(await tokenVerifies(env, "device", "tok2", stored)).toBe(false);
    expect(await tokenVerifies(env, "device", "", stored)).toBe(false);
    expect(await tokenVerifies(env, "device", null, stored)).toBe(false);
    expect(await tokenVerifies(env, "device", undefined, stored)).toBe(false);
  });

  test("refuses when nothing, or a raw value, is stored", async () => {
    expect(await tokenVerifies(env, "device", "tok", undefined)).toBe(false);
    // A raw stored value equal to the given token must never pass.
    expect(await tokenVerifies(env, "device", "tok", "tok")).toBe(false);
  });

  test("refuses a token of the other kind", async () => {
    const fleet = await verifierFor(env, "fleet", "tok");
    expect(await tokenVerifies(env, "device", "tok", fleet)).toBe(false);
  });

  test("refuses everything without a pepper", async () => {
    const stored = await verifierFor(env, "device", "tok");
    expect(await tokenVerifies({}, "device", "tok", stored)).toBe(false);
  });
});

describe("fingerprint", () => {
  test("is 8 lowercase hex characters, stable, and differs between tokens", async () => {
    const a = await verifierFor(env, "device", "a");
    const b = await verifierFor(env, "device", "b");
    const fa = await fingerprint(a);
    expect(fa).toMatch(/^[0-9a-f]{8}$/);
    expect(await fingerprint(a)).toBe(fa);
    expect(await fingerprint(b)).not.toBe(fa);
  });
});

describe("ticketKey", () => {
  test("differs per verifier and per pepper", async () => {
    const msg = new TextEncoder().encode("sandbox|demo|1|n");
    const va = await verifierFor(env, "device", "a");
    const vb = await verifierFor(env, "device", "b");
    const sig = async (e: { TOKEN_PEPPER?: string }, v: string) =>
      Buffer.from(await crypto.subtle.sign("HMAC", await ticketKey(e, v), msg)).toString("hex");
    const a = await sig(env, va);
    expect(await sig(env, va)).toBe(a);
    expect(await sig(env, vb)).not.toBe(a);
    expect(await sig(other, va)).not.toBe(a);
  });

  test("refuses to run without a pepper", async () => {
    await expect(ticketKey({}, "h1:x")).rejects.toBeInstanceOf(PepperMissingError);
  });
});
