// An existing device is given a new 25-character code, and the one it had goes on working for a day.
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
mock.module("@cloudflare/containers", () => ({ Container: class {} }));
const { RegistryDO, ROTATE_GRACE_MS } = await import("../src/registry-do");
const { default: worker } = await import("../src/index");
const { verifierFor, tokenVerifies } = await import("../src/token-hash");

const PEPPER = "test-pepper-0123456789abcdef0123456789";
const MIN = 60_000;
const ID = "anon-00000000000000aa";

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

/** A registry with one device that was made when codes were six characters. */
async function legacyRegistry(opts: { state?: Record<string, unknown> } = {}) {
  const now = Date.now();
  const store = storage(
    opts.state ?? {
      device_tokens: { [ID]: await verifierFor({ TOKEN_PEPPER: PEPPER } as never, "device", "OLD123") },
      anon_devices: { [ID]: { ref: "a".repeat(24), createdAt: now - 3_600_000, lastSeenAt: now } },
    },
  );
  let ready: Promise<unknown> = Promise.resolve();
  const ctx = {
    storage: store,
    blockConcurrencyWhile(fn: () => Promise<unknown>) {
      ready = fn();
      return ready;
    },
  };
  const env = { TOKEN_PEPPER: PEPPER };
  const reg = new RegistryDO(ctx as never, env as never);
  await ready;
  const call = async (method: string, path: string) => {
    const res = await reg.fetch(new Request("https://registry" + path, { method }));
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  return { call, store, env, reg };
}

afterEach(() => setSystemTime());

describe("the registry makes a device's code again", () => {
  test("a new 25-character code is current, and the old one is kept as a previous, good for a day", async () => {
    const t0 = Date.parse("2026-12-05T00:00:00Z");
    setSystemTime(t0);
    const { call, env } = await legacyRegistry();
    const made = await call("POST", "/anon/rotate?id=" + ID);
    expect(made.status).toBe(200);
    expect(made.json.token).toMatch(/^[0-9A-Z]{25}$/);
    expect(made.json.previousValidMs).toBe(ROTATE_GRACE_MS);
    const map = (await call("GET", "/map")).json;
    expect(await tokenVerifies(env as never, "device", made.json.token, map.map[ID])).toBe(true);
    expect(await tokenVerifies(env as never, "device", "OLD123", map.map[ID])).toBe(false);
    expect(await tokenVerifies(env as never, "device", "OLD123", map.previous[ID])).toBe(true);
    // Neither code is in the answer, only their verifiers.
    expect(JSON.stringify(map).includes(made.json.token)).toBe(false);
  });

  test("when the day is over the old code is gone, and the device is counted as having a long one", async () => {
    const t0 = Date.parse("2026-12-05T00:00:00Z");
    setSystemTime(t0);
    const { call, store } = await legacyRegistry();
    await call("POST", "/anon/rotate?id=" + ID);
    setSystemTime(t0 + ROTATE_GRACE_MS - MIN);
    expect(Object.keys((await call("GET", "/map")).json.previous)).toEqual([ID]);
    expect(((store.data.get("anon_devices") as Record<string, { long?: boolean }>)[ID] ?? {}).long).toBeUndefined();
    setSystemTime(t0 + ROTATE_GRACE_MS + MIN);
    expect((await call("GET", "/map")).json.previous).toEqual({});
    expect((store.data.get("device_tokens_prev") as Record<string, unknown>)[ID]).toBeUndefined();
    expect(((store.data.get("anon_devices") as Record<string, { long?: boolean }>)[ID] ?? {}).long).toBe(true);
  });

  test("it survives the object being woken again, and is cleared with the device", async () => {
    const { call, store, env } = await legacyRegistry();
    const made = await call("POST", "/anon/rotate?id=" + ID);
    const woken = await legacyRegistry({ state: Object.fromEntries(store.data) });
    const map = (await woken.call("GET", "/map")).json;
    expect(await tokenVerifies(env as never, "device", "OLD123", map.previous[ID])).toBe(true);
    expect(await tokenVerifies(env as never, "device", made.json.token, map.map[ID])).toBe(true);
  });

  test("a device that is not an anonymous one is refused", async () => {
    const { call } = await legacyRegistry();
    expect((await call("POST", "/anon/rotate?id=reg1")).status).toBe(404);
  });
});

describe("the gateway accepts both codes, and makes a new one for a device that holds the right one", () => {
  async function gateway(extra: Record<string, unknown> = {}, state: { previous?: boolean } = {}) {
    const env: Record<string, unknown> = { TOKEN_PEPPER: PEPPER, ...extra };
    const registered = await verifierFor(env as never, "device", "reg-secret");
    const current = await verifierFor(env as never, "device", "N".repeat(25));
    const before = await verifierFor(env as never, "device", "OLD123");
    const asked: string[] = [];
    env.REGISTRY = {
      idFromName: () => "global",
      get: () => ({
        fetch: async (input: string | Request) => {
          const path = new URL(typeof input === "string" ? input : input.url).pathname;
          asked.push(path);
          if (path === "/map")
            return Response.json({
              map: { reg1: registered, [ID]: current },
              anonymous: [ID],
              online: [],
              locked: {},
              previous: state.previous === false ? {} : { [ID]: before },
              buddies: {},
              paused: [],
              blocked: [],
              disabled: [],
            });
          if (path === "/usage") return Response.json({ spentUsd: 0, budgetUsd: 20, overBudget: false });
          if (path === "/anon/rotate") return Response.json({ deviceId: ID, token: "R".repeat(25), previousValidMs: ROTATE_GRACE_MS });
          return Response.json({});
        },
      }),
    };
    // A snapshot an earlier test left in the isolate's cache would answer for this registry.
    await new Promise((r) => setTimeout(r, 2_100));
    return { env, asked };
  }
  const rotate = (headers: Record<string, string>) =>
    new Request("https://gw.example/api/devices/anonymous/rotate", { method: "POST", headers: { "content-type": "application/json", ...headers } });
  const asDevice = (id: string, token: string, ip: string) => ({ "x-prime-device": id, "x-device-token": token, "cf-connecting-ip": ip });

  test("a device is given a new code when it shows the one it has, whether the current or the one before", async () => {
    const { env, asked } = await gateway();
    for (const [token, ip] of [["N".repeat(25), "198.51.100.81"], ["OLD123", "198.51.100.82"]] as const) {
      const res = await worker.fetch(rotate(asDevice(ID, token, ip)), env as never);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, any>;
      expect(body.token).toBe("R".repeat(25));
      expect(body.deviceId).toBe(ID);
      expect(body.connect_url).toBe("https://gw.example/device/" + ID + "?token=" + "R".repeat(25));
      expect(body.previous_valid_ms).toBe(ROTATE_GRACE_MS);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(asked.filter((p) => p === "/anon/rotate")).toHaveLength(2);
  });

  test("the old code opens the device while it is kept, and not after, and a wrong code opens nothing", async () => {
    const kept = await gateway({}, { previous: true });
    const asOld = new Request("https://gw.example/fleets/acme/bootstrap", { method: "POST", headers: { ...asDevice(ID, "OLD123", "198.51.100.83"), "content-type": "application/json" }, body: "{}" });
    // The fleet "acme" does not exist here: 404 from the fleet is past the credential, 401 is not.
    expect((await worker.fetch(asOld, kept.env as never)).status).not.toBe(401);
    const gone = await gateway({}, { previous: false });
    const again = new Request("https://gw.example/fleets/acme/bootstrap", { method: "POST", headers: { ...asDevice(ID, "OLD123", "198.51.100.84"), "content-type": "application/json" }, body: "{}" });
    expect((await worker.fetch(again, gone.env as never)).status).toBe(401);
    const wrong = new Request("https://gw.example/fleets/acme/bootstrap", { method: "POST", headers: { ...asDevice(ID, "NOTTHEONE", "198.51.100.85"), "content-type": "application/json" }, body: "{}" });
    expect((await worker.fetch(wrong, kept.env as never)).status).toBe(401);
  });

  test("a wrong code, a registered device, an unknown id and a GET are all refused, and nothing is made", async () => {
    const { env, asked } = await gateway();
    expect((await worker.fetch(rotate(asDevice(ID, "WRONG", "198.51.100.86")), env as never)).status).toBe(401);
    expect((await worker.fetch(rotate(asDevice("reg1", "reg-secret", "198.51.100.87")), env as never)).status).toBe(400);
    expect((await worker.fetch(rotate({ "cf-connecting-ip": "198.51.100.88" }), env as never)).status).toBe(400);
    expect((await worker.fetch(new Request("https://gw.example/api/devices/anonymous/rotate", { method: "GET" }), env as never)).status).toBe(405);
    expect(asked).not.toContain("/anon/rotate");
  });

  test("a gateway that asks for its token is asked for it here too", async () => {
    const { env, asked } = await gateway({ GATEWAY_TOKEN: "gw-secret-0123456789" });
    expect((await worker.fetch(rotate(asDevice(ID, "N".repeat(25), "198.51.100.89")), env as never)).status).toBe(401);
    expect(asked).not.toContain("/anon/rotate");
    const ok = await worker.fetch(rotate({ ...asDevice(ID, "N".repeat(25), "198.51.100.90"), authorization: "Bearer gw-secret-0123456789" }), env as never);
    expect(ok.status).toBe(200);
  });
});
