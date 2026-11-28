// RegistryDO keeps a verifier for every buddy and fleet token, never the token.
import { describe, expect, mock, test } from "bun:test";

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
const { RegistryDO } = await import("../src/registry-do");
const { verifierFor, isVerifier } = await import("../src/token-hash");

const PEPPER = "registry-test-pepper-0123456789abcdef";

/** A Durable Object's storage, in memory, that remembers every write. */
function fakeStorage(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(structuredClone(initial)));
  const puts: string[] = [];
  return {
    data,
    puts,
    async get<T>(key: string): Promise<T | undefined> {
      return structuredClone(data.get(key)) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      puts.push(key);
      data.set(key, structuredClone(value));
    },
    async delete(key: string): Promise<boolean> {
      return data.delete(key);
    },
    async list<T>(opts: { prefix?: string } = {}): Promise<Map<string, T>> {
      const out = new Map<string, T>();
      for (const [k, v] of data) if (!opts.prefix || k.startsWith(opts.prefix)) out.set(k, v as T);
      return out;
    },
  };
}

async function registry(storage = fakeStorage(), env: Record<string, string> = { TOKEN_PEPPER: PEPPER }) {
  let ready: Promise<unknown> = Promise.resolve();
  const ctx = {
    storage,
    blockConcurrencyWhile(fn: () => Promise<unknown>) {
      ready = fn();
      return ready;
    },
  };
  const reg = new RegistryDO(ctx as never, env as never);
  await ready;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await reg.fetch(
      new Request("https://registry" + path, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: res.status, text: await res.text() };
  };
  return { reg, storage, call };
}

const env = { TOKEN_PEPPER: PEPPER };

describe("migration", () => {
  test("raw tokens in storage are replaced by their verifiers on load", async () => {
    const storage = fakeStorage({
      device_tokens: { a: "raw-token-a", b: await verifierFor(env, "device", "raw-token-b") },
      fleet_buddies: { f: "raw-token-f" },
    });
    await registry(storage);
    const tokens = storage.data.get("device_tokens") as Record<string, string>;
    expect(tokens.a).toBe(await verifierFor(env, "device", "raw-token-a"));
    expect(tokens.b).toBe(await verifierFor(env, "device", "raw-token-b"));
    const buddies = storage.data.get("fleet_buddies") as Record<string, string>;
    expect(buddies.f).toBe(await verifierFor(env, "fleet", "raw-token-f"));
    const all = JSON.stringify([...storage.data]);
    for (const raw of ["raw-token-a", "raw-token-b", "raw-token-f"]) expect(all.includes(raw)).toBe(false);
  });

  test("a second load writes nothing to the token maps", async () => {
    const storage = fakeStorage({ device_tokens: { a: "raw-token-a" }, fleet_buddies: { f: "raw-token-f" } });
    await registry(storage);
    storage.puts.length = 0;
    await registry(storage);
    expect(storage.puts.filter((k) => k === "device_tokens" || k === "fleet_buddies")).toEqual([]);
  });

  test("the DEVICE_TOKENS seed is stored as verifiers", async () => {
    const storage = fakeStorage();
    await registry(storage, { TOKEN_PEPPER: PEPPER, DEVICE_TOKENS: '{"s":"seed-token"}' });
    const tokens = storage.data.get("device_tokens") as Record<string, string>;
    expect(tokens.s).toBe(await verifierFor(env, "device", "seed-token"));
    expect(JSON.stringify([...storage.data]).includes("seed-token")).toBe(false);
  });

  test("VIRTUAL_DEVICE_TOKENS is stored as verifiers and not rewritten on every load", async () => {
    const storage = fakeStorage();
    const venv = { TOKEN_PEPPER: PEPPER, VIRTUAL_DEVICE_TOKENS: '{"cloud":"virtual-token"}', VIRTUAL_DEVICE_IDS: "cloud" };
    await registry(storage, venv);
    expect((storage.data.get("device_tokens") as Record<string, string>).cloud).toBe(await verifierFor(env, "device", "virtual-token"));
    storage.puts.length = 0;
    await registry(storage, venv);
    expect(storage.puts.filter((k) => k === "device_tokens")).toEqual([]);
  });

  test("without a pepper storage is left alone and nothing raw is served", async () => {
    const storage = fakeStorage({ device_tokens: { a: "raw-token-a" } });
    const { call } = await registry(storage, {});
    expect((storage.data.get("device_tokens") as Record<string, string>).a).toBe("raw-token-a");
    const map = await call("GET", "/map");
    expect(map.text.includes("raw-token-a")).toBe(false);
    // The id stays listed with a value no token matches: an unmigrated registry
    // must never read as an empty, open one.
    const served = JSON.parse(map.text).map.a;
    expect(typeof served).toBe("string");
    expect(isVerifier(served)).toBe(false);
    const full = await call("GET", "/full");
    expect(full.text.includes("raw-token-a")).toBe(false);
    expect((await call("POST", "/upsert", { deviceId: "n", token: "new-token" })).status).toBe(503);
    expect((await call("POST", "/anon/create", { ip: "1.2.3.4" })).status).toBe(503);
    expect((await call("POST", "/fleet-buddy?id=f1", { token: "fleet-token-1" })).status).toBe(503);
  });
});

describe("answers carry no token", () => {
  test("upsert, map, full and remove", async () => {
    const { call } = await registry();
    const up = await call("POST", "/upsert", { deviceId: "dev1", token: "secret-token-1" });
    expect(up.status).toBe(200);
    expect(up.text.includes("secret-token-1")).toBe(false);
    const listed = JSON.parse(up.text).devices.find((d: { deviceId: string }) => d.deviceId === "dev1");
    expect(listed.token).toBeUndefined();
    expect(listed.fingerprint).toMatch(/^[0-9a-f]{8}$/);

    const map = await call("GET", "/map");
    const body = JSON.parse(map.text);
    expect(body.map.dev1).toBe(await verifierFor(env, "device", "secret-token-1"));
    expect(map.text.includes("secret-token-1")).toBe(false);

    const full = await call("GET", "/full");
    expect(full.text.includes("secret-token-1")).toBe(false);
    expect(JSON.parse(full.text).devices[0].fingerprint).toBe(listed.fingerprint);

    await call("POST", "/upsert", { deviceId: "dev2", token: "secret-token-2" });
    const removed = await call("POST", "/remove", { deviceId: "dev1" });
    expect(removed.text.includes("secret-token-2")).toBe(false);
    expect(JSON.parse(removed.text).devices.map((d: { deviceId: string }) => d.deviceId)).toEqual(["dev2"]);
  });

  test("codes are not repeated and use the whole alphabet", async () => {
    const { call } = await registry();
    const seen = new Set<string>();
    const symbols = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const token = JSON.parse((await call("POST", "/anon/create", { ip: "10.0." + i + ".1", exempt: true })).text).token as string;
      seen.add(token);
      for (const c of token) symbols.add(c);
    }
    expect(seen.size).toBe(60);
    expect(symbols.size).toBeGreaterThan(30);
  });

  test("a code made when codes were six characters is still accepted", async () => {
    const legacy = await verifierFor(env, "device", "A1B2C3");
    expect(await (await import("../src/token-hash")).tokenVerifies(env, "device", "A1B2C3", legacy)).toBe(true);
    expect(await (await import("../src/token-hash")).tokenVerifies(env, "device", "A1B2C4", legacy)).toBe(false);
  });

  test("an anonymous device's code is answered once, then never again", async () => {
    const { call, storage } = await registry();
    const made = JSON.parse((await call("POST", "/anon/create", { ip: "1.2.3.4" })).text);
    // 25 symbols of 36: 129 bits. (Codes made before were 6; the gateway still accepts those.)
    expect(made.token).toMatch(/^[0-9A-Z]{25}$/);
    expect(Math.log2(36) * made.token.length).toBeGreaterThanOrEqual(128);
    expect(JSON.stringify([...storage.data]).includes(made.token)).toBe(false);
    const map = await call("GET", "/map");
    expect(map.text.includes(made.token)).toBe(false);
    expect(JSON.parse(map.text).map[made.deviceId]).toBe(await verifierFor(env, "device", made.token));
    const list = JSON.parse((await call("GET", "/anon/list")).text);
    const resolved = await call("GET", "/anon/resolve?ref=" + list.devices[0].ref);
    expect(JSON.parse(resolved.text)).toEqual({ deviceId: made.deviceId });
  });

  test("a fleet token is kept as a verifier", async () => {
    const { call, storage } = await registry();
    expect((await call("POST", "/fleet-buddy?id=team", { token: "fleet-secret-1" })).status).toBe(200);
    expect(JSON.stringify([...storage.data]).includes("fleet-secret-1")).toBe(false);
    const buddies = JSON.parse((await call("GET", "/fleet-buddies")).text).buddies;
    expect(buddies.team).toBe(await verifierFor(env, "fleet", "fleet-secret-1"));
    const map = JSON.parse((await call("GET", "/map")).text);
    expect(isVerifier(map.buddies.team)).toBe(true);
  });
});

describe("upsert", () => {
  test("a rename without a token keeps the token, under the new id", async () => {
    const { call } = await registry();
    await call("POST", "/upsert", { deviceId: "old-id", token: "rename-token" });
    const renamed = JSON.parse((await call("POST", "/upsert", { deviceId: "new-id", replaces: "old-id" })).text);
    expect(renamed.ok).toBe(true);
    expect(renamed.rotated).toBe(false);
    const map = JSON.parse((await call("GET", "/map")).text).map;
    expect(map["new-id"]).toBe(await verifierFor(env, "device", "rename-token"));
    expect(map["old-id"]).toBeUndefined();
  });

  test("rotated says whether an existing device now has another token", async () => {
    const { call } = await registry();
    expect(JSON.parse((await call("POST", "/upsert", { deviceId: "r", token: "first-token" })).text).rotated).toBe(false);
    expect(JSON.parse((await call("POST", "/upsert", { deviceId: "r", token: "first-token" })).text).rotated).toBe(false);
    expect(JSON.parse((await call("POST", "/upsert", { deviceId: "r", token: "second-token" })).text).rotated).toBe(true);
  });

  test("without a token and without a rename there is nothing to store", async () => {
    const { call } = await registry();
    expect((await call("POST", "/upsert", { deviceId: "x" })).status).toBe(400);
    expect((await call("POST", "/upsert", { deviceId: "x", replaces: "missing" })).status).toBe(400);
  });
});
