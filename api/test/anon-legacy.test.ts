// Anonymous devices made when codes were six characters: one still waiting for its first connection is
// refused after an hour; one that has connected is unaffected.
import { afterEach, describe, expect, mock, setSystemTime, test } from "bun:test";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
const { RegistryDO, LEGACY_PENDING_TTL_MS } = await import("../src/registry-do");
const { verifierFor } = await import("../src/token-hash");

const PEPPER = "p".repeat(40);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function storage(initial: Record<string, unknown>) {
  const data = new Map<string, unknown>(Object.entries(structuredClone(initial)));
  return {
    data,
    async get<T>(key: string): Promise<T | undefined> {
      return structuredClone(data.get(key)) as T | undefined;
    },
    async put(key: string, value: unknown) {
      data.set(key, structuredClone(value));
    },
    async delete(key: string) {
      return data.delete(key);
    },
    async list<T>(): Promise<Map<string, T>> {
      return new Map<string, T>();
    },
  };
}

const ID = (n: number) => "anon-" + String(n).padStart(16, "0");

/** A registry holding anonymous devices as they were saved: with the records given. */
async function registry(records: Record<string, Record<string, unknown>>, env: Record<string, string> = {}) {
  const tokens: Record<string, string> = {};
  for (const id of Object.keys(records)) tokens[id] = await verifierFor({ TOKEN_PEPPER: PEPPER } as never, "device", "CODE" + id);
  const store = storage({ device_tokens: tokens, anon_devices: records });
  let ready: Promise<unknown> = Promise.resolve();
  const ctx = {
    storage: store,
    blockConcurrencyWhile(fn: () => Promise<unknown>) {
      ready = fn();
      return ready;
    },
  };
  const reg = new RegistryDO(ctx as never, { TOKEN_PEPPER: PEPPER, ...env } as never);
  await ready;
  const known = async (): Promise<string[]> => {
    const res = await reg.fetch(new Request("https://registry/map"));
    return Object.keys(((await res.json()) as { map: Record<string, string> }).map);
  };
  return { known, reg };
}

afterEach(() => setSystemTime());

describe("a six-character code that has not been used", () => {
  test("is refused after an hour, even where devices are allowed to wait for days", async () => {
    const t0 = Date.parse("2026-12-05T00:00:00Z");
    setSystemTime(t0);
    const { known } = await registry(
      {
        [ID(1)]: { ref: "a".repeat(24), createdAt: t0, lastSeenAt: null }, // legacy, pending
        [ID(2)]: { ref: "b".repeat(24), createdAt: t0, lastSeenAt: null, long: true }, // long, pending
      },
      { ANON_UNUSED_TTL_MS: String(30 * DAY) },
    );
    expect(await known()).toEqual([ID(1), ID(2)]);
    setSystemTime(t0 + LEGACY_PENDING_TTL_MS - MIN);
    expect(await known()).toEqual([ID(1), ID(2)]);
    setSystemTime(t0 + LEGACY_PENDING_TTL_MS + MIN);
    expect(await known()).toEqual([ID(2)]);
    // A long code waits as long as the deployment says.
    setSystemTime(t0 + 29 * DAY);
    expect(await known()).toEqual([ID(2)]);
    setSystemTime(t0 + 31 * DAY);
    expect(await known()).toEqual([]);
  });

  test("keeps the shorter wait when the deployment's own is shorter", async () => {
    const t0 = Date.parse("2026-12-05T00:00:00Z");
    setSystemTime(t0);
    const { known } = await registry({ [ID(1)]: { ref: "a".repeat(24), createdAt: t0, lastSeenAt: null } }, { ANON_UNUSED_TTL_MS: String(10 * MIN) });
    setSystemTime(t0 + 11 * MIN);
    expect(await known()).toEqual([]);
  });
});

describe("a six-character code that has been used", () => {
  test("is unaffected: a member of a fleet keeps its code until it is made again, and the offline cleanup is the one it always had", async () => {
    const t0 = Date.parse("2026-12-05T00:00:00Z");
    setSystemTime(t0);
    const { known } = await registry({
      [ID(1)]: { ref: "a".repeat(24), createdAt: t0 - 30 * DAY, lastSeenAt: t0 - 60_000 }, // legacy, seen a minute ago
    });
    expect(await known()).toEqual([ID(1)]);
    setSystemTime(t0 + 3 * DAY);
    expect(await known()).toEqual([ID(1)]); // offline three days: inside the seven
    setSystemTime(t0 + 8 * DAY);
    expect(await known()).toEqual([]); // offline past seven days
  });

  test("a new device is marked as made with a long code, and so is not held to the hour", async () => {
    const t0 = Date.parse("2026-12-05T00:00:00Z");
    setSystemTime(t0);
    const { reg, known } = await registry({}, { ANON_UNUSED_TTL_MS: String(DAY) });
    const res = await reg.fetch(new Request("https://registry/anon/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ip: "1.2.3.4" }) }));
    const made = (await res.json()) as { deviceId: string; token: string };
    expect(made.token).toHaveLength(25);
    setSystemTime(t0 + 2 * LEGACY_PENDING_TTL_MS);
    expect(await known()).toEqual([made.deviceId]);
  });
});
