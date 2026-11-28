// The gateway's own reading of an epoch key (`api/src/fleet-epoch.ts`), against the one made here. A path that moved is a test that
// must say so, not one that passes without looking. Set PRIME_GATEWAY_EPOCH to read another copy (a branch checked out elsewhere).
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { generateEpochKey } from "../src/fleet-crypto";
import { EPOCH_ENTRY, epochEntry, epochKeyHolds, signEpochEntry } from "../src/fleet-epoch";
import { generateOwnerKey } from "../src/fleet-roster";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

const file = process.env.PRIME_GATEWAY_EPOCH ?? join(import.meta.dir, "..", "..", "api", "src", "fleet-epoch.ts");

interface Gateway {
  EPOCH_TAG: string;
  EPOCH_KEY_MAX_AHEAD_MS: number;
  parseEpochKey(body: unknown): { signed: { entry: unknown[]; sig: string }; n: number; pub: string; notAfter: number; device: string; fleet: string; incarnation: string };
  epochKeySigned(signed: { entry: unknown[]; sig: string }, spub: string): Promise<boolean>;
}

const load = async (): Promise<Gateway> => {
  expect(existsSync(file), "the gateway's epoch code is at " + file).toBe(true);
  return (await import(pathToFileURL(file).href)) as Gateway;
};

describe("an epoch key made here, read by the gateway", () => {
  test("the gateway takes the form, agrees on the tag and the signature, and the key is one this side accepts back", async () => {
    const g = await load();
    expect(g.EPOCH_TAG).toBe(EPOCH_ENTRY);
    const sign = generateOwnerKey();
    const epoch = generateEpochKey(1);
    const notAfter = Date.now() + 48 * 3_600_000;
    const entry = epochEntry("acme", "inc-1", "dev-1", 1, epoch.publicKey, notAfter);
    const sig = signEpochEntry(entry, sign.privateKeyPem);
    const parsed = g.parseEpochKey({ entry, sig });
    expect(parsed).toMatchObject({ n: 1, pub: epoch.publicKey, notAfter, device: "dev-1", fleet: "acme", incarnation: "inc-1" });
    expect(await g.epochKeySigned(parsed.signed, sign.publicKey)).toBe(true);
    expect(await g.epochKeySigned(parsed.signed, generateOwnerKey().publicKey)).toBe(false);
    // What the gateway serves back is what this side verifies.
    expect(epochKeyHolds({ n: 1, pub: epoch.publicKey, notAfter, sig }, { fleet: "acme", incarnation: "inc-1", device: "dev-1", spub: sign.publicKey }, Date.now())).toBe(true);
  });

  test("the longest a key is made for is a time the gateway takes", async () => {
    const g = await load();
    // 168 hours is the longest epoch; a key lasts twice that, and never more than 30 days.
    const lasts = Math.min(2 * 168 * 3_600_000, 30 * 24 * 3_600_000);
    expect(lasts).toBeLessThanOrEqual(g.EPOCH_KEY_MAX_AHEAD_MS);
  });

  test("what the gateway refuses is not something this side makes: other tags, short entries, keys that are not X25519", async () => {
    const g = await load();
    const sign = generateOwnerKey();
    const epoch = generateEpochKey(1);
    const entry = epochEntry("acme", "inc-1", "dev-1", 1, epoch.publicKey, Date.now() + 1000);
    const sig = signEpochEntry(entry, sign.privateKeyPem);
    expect(() => g.parseEpochKey({ entry: ["prime-epoch-v2", ...entry.slice(1)], sig })).toThrow();
    expect(() => g.parseEpochKey({ entry: entry.slice(0, 6), sig })).toThrow();
    expect(() => g.parseEpochKey({ entry: [...entry.slice(0, 5), "short", entry[6]], sig })).toThrow();
  });
});
