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
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await reg.fetch(new Request("https://registry" + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }));
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  return { call, store, env, reg };
}

afterEach(() => setSystemTime());

const P1 = "P".repeat(25);
const P2 = "Q".repeat(25);
const P3 = "R".repeat(25);
const rotate = (id: string, body: Record<string, unknown>) => ["POST", "/anon/rotate?id=" + id, body] as const;

describe("the registry makes a device's code again", () => {
  test("the device's proposal is current, and the old code is kept as a previous, good for a day", async () => {
    const t0 = Date.parse("2026-12-05T00:00:00Z");
    setSystemTime(t0);
    const { call, env } = await legacyRegistry();
    const made = await call(...rotate(ID, { proposed: P1, presented: "OLD123" }));
    expect(made.status).toBe(200);
    expect(made.json.token).toBe(P1);
    expect(made.json.previousValidMs).toBe(ROTATE_GRACE_MS);
    const map = (await call("GET", "/map")).json;
    expect(await tokenVerifies(env as never, "device", P1, map.map[ID])).toBe(true);
    expect(await tokenVerifies(env as never, "device", "OLD123", map.map[ID])).toBe(false);
    expect(await tokenVerifies(env as never, "device", "OLD123", map.previous[ID])).toBe(true);
    // Neither code is in the answer, only their verifiers.
    expect(JSON.stringify(map).includes(P1)).toBe(false);
  });

  test("a proposal that is not 25 characters of 0-9 and A-Z, or none, is refused and nothing changes", async () => {
    const { call } = await legacyRegistry();
    for (const proposed of ["SHORT", "a".repeat(25), "P".repeat(26), "P".repeat(24) + "-", 7]) {
      expect((await call(...rotate(ID, { proposed, presented: "OLD123" }))).status).toBe(400);
    }
    expect((await call(...rotate(ID, { presented: "OLD123" }))).status).toBe(400);
    expect(Object.keys((await call("GET", "/map")).json.previous)).toEqual([]);
  });

  test("a code that is not the device's is refused", async () => {
    const { call } = await legacyRegistry();
    expect((await call(...rotate(ID, { proposed: P1, presented: "WRONG1" }))).status).toBe(401);
    expect((await call(...rotate(ID, { proposed: P1 }))).status).toBe(401);
  });

  test("the thief: whoever holds the code that was replaced cannot make the device their own, and the owner's code lives on", async () => {
    const t0 = Date.parse("2026-12-05T00:00:00Z");
    setSystemTime(t0);
    const { call, env } = await legacyRegistry();
    expect((await call(...rotate(ID, { proposed: P1, presented: "OLD123" }))).status).toBe(200); // the owner
    setSystemTime(t0 + MIN);
    const thief = await call(...rotate(ID, { proposed: P2, presented: "OLD123" }));
    expect(thief.status).toBe(409);
    expect(thief.json.error).toContain("replaced");
    // After the day the owner's code is the device's only one; the thief's proposal was never stored.
    setSystemTime(t0 + ROTATE_GRACE_MS + MIN);
    const map = (await call("GET", "/map")).json;
    expect(await tokenVerifies(env as never, "device", P1, map.map[ID])).toBe(true);
    expect(await tokenVerifies(env as never, "device", P2, map.map[ID])).toBe(false);
    expect(map.previous).toEqual({});
  });

  test("a call whose answer was lost is repeated with the same proposal and succeeds, with nothing changed", async () => {
    const t0 = Date.parse("2026-12-05T00:00:00Z");
    setSystemTime(t0);
    const { call, env } = await legacyRegistry();
    await call(...rotate(ID, { proposed: P1, presented: "OLD123" }));
    const before = JSON.stringify((await call("GET", "/map")).json);
    setSystemTime(t0 + 5 * MIN);
    // The device still holds the old code (it never heard the answer) and proposes the same one again.
    const again = await call(...rotate(ID, { proposed: P1, presented: "OLD123" }));
    expect(again.status).toBe(200);
    expect(again.json.token).toBe(P1);
    expect(again.json.repeated).toBe(true);
    // The grace is what is left of the first, not a new day: the original code still goes at the same time.
    expect(again.json.previousValidMs).toBe(ROTATE_GRACE_MS - 5 * MIN);
    expect(JSON.stringify((await call("GET", "/map")).json)).toBe(before);
    // With the new code it is repeatable too.
    expect((await call(...rotate(ID, { proposed: P1, presented: P1 }))).json.repeated).toBe(true);
    const map = (await call("GET", "/map")).json;
    expect(await tokenVerifies(env as never, "device", "OLD123", map.previous[ID])).toBe(true);
  });

  test("the current code may rotate again, and the code it replaced then has the day, not the first one", async () => {
    const t0 = Date.parse("2026-12-05T00:00:00Z");
    setSystemTime(t0);
    const { call, env } = await legacyRegistry();
    await call(...rotate(ID, { proposed: P1, presented: "OLD123" }));
    setSystemTime(t0 + 2 * MIN);
    expect((await call(...rotate(ID, { proposed: P2, presented: P1 }))).status).toBe(200);
    const map = (await call("GET", "/map")).json;
    expect(await tokenVerifies(env as never, "device", P2, map.map[ID])).toBe(true);
    expect(await tokenVerifies(env as never, "device", P1, map.previous[ID])).toBe(true);
    // The first code has no grace left any more (the owner chose to rotate again).
    expect(await tokenVerifies(env as never, "device", "OLD123", map.previous[ID])).toBe(false);
  });

  test("a replaced code whose day is over may not repeat anything", async () => {
    const t0 = Date.parse("2026-12-05T00:00:00Z");
    setSystemTime(t0);
    const { call } = await legacyRegistry();
    await call(...rotate(ID, { proposed: P1, presented: "OLD123" }));
    setSystemTime(t0 + ROTATE_GRACE_MS + MIN);
    expect((await call(...rotate(ID, { proposed: P1, presented: "OLD123" }))).status).toBe(401);
  });

  test("two asks at once from the current code: one wins, the other is told the code was replaced and not made current", async () => {
    const { call, env } = await legacyRegistry();
    const [a, b] = await Promise.all([call(...rotate(ID, { proposed: P1, presented: "OLD123" })), call(...rotate(ID, { proposed: P2, presented: "OLD123" }))]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const map = (await call("GET", "/map")).json;
    const winner = a.status === 200 ? P1 : P2;
    expect(await tokenVerifies(env as never, "device", winner, map.map[ID])).toBe(true);
  });

  test("the operator needs no code, is not held up by a lock, and clears the locks so the new code works at once", async () => {
    const { call, env } = await legacyRegistry();
    for (let i = 0; i < 200; i++) await call("POST", "/anon/fail?id=" + ID + "&ip=198.51." + (i >> 8) + "." + (i & 255));
    expect(Object.keys((await call("GET", "/map")).json.locked)).toEqual([ID + "|*"]);
    const made = await call(...rotate(ID, { proposed: P1, operator: true }));
    expect(made.status).toBe(200);
    const map = (await call("GET", "/map")).json;
    expect(map.locked).toEqual({});
    expect(await tokenVerifies(env as never, "device", P1, map.map[ID])).toBe(true);
    expect(await tokenVerifies(env as never, "device", "OLD123", map.previous[ID])).toBe(true);
    // Left to the gateway to choose, the operator is given a code; a repeat of the same proposal changes nothing.
    const chosen = await call(...rotate(ID, { operator: true }));
    expect(chosen.json.token).toMatch(/^[0-9A-Z]{25}$/);
    expect((await call(...rotate(ID, { proposed: chosen.json.token, operator: true }))).json.repeated).toBe(true);
  });

  test("the operator can have the old code stop at once: a stolen code does not keep the device for a day", async () => {
    const { call, env } = await legacyRegistry();
    // The owner migrated; then the old code is found to have leaked.
    await call(...rotate(ID, { proposed: P1, presented: "OLD123" }));
    const made = await call(...rotate(ID, { proposed: P2, operator: true, revoke_previous: true }));
    expect(made.status).toBe(200);
    expect(made.json.previousValidMs).toBe(0);
    const map = (await call("GET", "/map")).json;
    expect(await tokenVerifies(env as never, "device", P2, map.map[ID])).toBe(true);
    expect(map.previous).toEqual({});
    // Neither earlier code is kept, and neither can ask.
    expect((await call(...rotate(ID, { proposed: P3, presented: "OLD123" }))).status).toBe(401);
    expect((await call(...rotate(ID, { proposed: P3, presented: P1 }))).status).toBe(401);
  });

  test("without the option the operator's rotate keeps the old code for the day, as a migration does", async () => {
    const { call, env } = await legacyRegistry();
    await call(...rotate(ID, { proposed: P1, operator: true }));
    const map = (await call("GET", "/map")).json;
    expect(await tokenVerifies(env as never, "device", "OLD123", map.previous[ID])).toBe(true);
  });

  test("a device cannot ask for the revocation: only the operator's option is taken", async () => {
    const { call, env } = await legacyRegistry();
    await call(...rotate(ID, { proposed: P1, presented: "OLD123", revoke_previous: true }));
    const map = (await call("GET", "/map")).json;
    expect(await tokenVerifies(env as never, "device", "OLD123", map.previous[ID])).toBe(true);
  });

  test("a revocation whose answer was lost is finished by the same call again: the proposal is current, the old code goes", async () => {
    const { call } = await legacyRegistry();
    await call(...rotate(ID, { proposed: P1, operator: true }));
    const again = await call(...rotate(ID, { proposed: P1, operator: true, revoke_previous: true }));
    expect(again.status).toBe(200);
    expect(again.json.repeated).toBe(true);
    expect((await call("GET", "/map")).json.previous).toEqual({});
  });

  test("when the code cannot be stored nothing is said to be done: 503, memory put back, and a try again works", async () => {
    const { call, store, env } = await legacyRegistry();
    const real = store.put.bind(store);
    let failing = true;
    store.put = async (key: string, value: unknown) => {
      if (failing && (key === "device_tokens" || key === "device_tokens_prev")) throw new Error("storage is busy");
      return real(key, value);
    };
    const refused = await call(...rotate(ID, { proposed: P1, presented: "OLD123" }));
    expect(refused.status).toBe(503);
    // The device still has the code it had, and no previous.
    let map = (await call("GET", "/map")).json;
    expect(await tokenVerifies(env as never, "device", "OLD123", map.map[ID])).toBe(true);
    expect(map.previous).toEqual({});
    expect((store.data.get("device_tokens") as Record<string, string>)[ID]).toBe(map.map[ID]);
    // A failure of the second write leaves the first put back too.
    failing = false;
    const realTokens = store.put;
    store.put = async (key: string, value: unknown) => {
      if (key === "device_tokens") throw new Error("storage is busy");
      return realTokens(key, value);
    };
    expect((await call(...rotate(ID, { proposed: P1, presented: "OLD123" }))).status).toBe(503);
    expect(((store.data.get("device_tokens_prev") as Record<string, unknown>) ?? {})[ID]).toBeUndefined();
    store.put = real;
    expect((await call(...rotate(ID, { proposed: P1, presented: "OLD123" }))).status).toBe(200);
    map = (await call("GET", "/map")).json;
    expect(await tokenVerifies(env as never, "device", P1, map.map[ID])).toBe(true);
  });

  test("when the day is over the old code is gone, and the device is counted as having a long one", async () => {
    const t0 = Date.parse("2026-12-05T00:00:00Z");
    setSystemTime(t0);
    const { call, store } = await legacyRegistry();
    await call(...rotate(ID, { proposed: P1, presented: "OLD123" }));
    setSystemTime(t0 + ROTATE_GRACE_MS - MIN);
    expect(Object.keys((await call("GET", "/map")).json.previous)).toEqual([ID]);
    expect(((store.data.get("anon_devices") as Record<string, { long?: boolean }>)[ID] ?? {}).long).toBeUndefined();
    setSystemTime(t0 + ROTATE_GRACE_MS + MIN);
    expect((await call("GET", "/map")).json.previous).toEqual({});
    expect((store.data.get("device_tokens_prev") as Record<string, unknown>)[ID]).toBeUndefined();
    expect(((store.data.get("anon_devices") as Record<string, { long?: boolean }>)[ID] ?? {}).long).toBe(true);
  });

  test("it survives the object being woken again", async () => {
    const { call, store, env } = await legacyRegistry();
    await call(...rotate(ID, { proposed: P1, presented: "OLD123" }));
    const woken = await legacyRegistry({ state: Object.fromEntries(store.data) });
    const map = (await woken.call("GET", "/map")).json;
    expect(await tokenVerifies(env as never, "device", "OLD123", map.previous[ID])).toBe(true);
    expect(await tokenVerifies(env as never, "device", P1, map.map[ID])).toBe(true);
  });

  test("a device that is not an anonymous one is refused", async () => {
    const { call } = await legacyRegistry();
    expect((await call(...rotate("reg1", { proposed: P1, presented: "x" }))).status).toBe(404);
  });
});

describe("the gateway", () => {
  /** A gateway whose registry holds one anonymous device and answers the rotate call the way the real one decides it. */
  async function gateway(extra: Record<string, unknown> = {}, state: { previous?: boolean } = {}) {
    const env: Record<string, unknown> = { TOKEN_PEPPER: PEPPER, ...extra };
    const registered = await verifierFor(env as never, "device", "reg-secret");
    const current = await verifierFor(env as never, "device", "N".repeat(25));
    const before = await verifierFor(env as never, "device", "OLD123");
    const asked: Array<{ path: string; body: Record<string, unknown> }> = [];
    env.REGISTRY = {
      idFromName: () => "global",
      get: () => ({
        fetch: async (input: string | Request) => {
          const req = typeof input === "string" ? new Request(input) : input;
          const path = new URL(req.url).pathname;
          const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
          asked.push({ path, body });
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
          if (path === "/anon/resolve") return Response.json({ deviceId: ID });
          if (path === "/anon/rotate") return Response.json({ deviceId: ID, token: String(body.proposed ?? "G".repeat(25)), previousValidMs: ROTATE_GRACE_MS });
          return Response.json({});
        },
      }),
    };
    // A snapshot an earlier test left in the isolate's cache would answer for this registry.
    await new Promise((r) => setTimeout(r, 2_100));
    return { env, asked, rotated: () => asked.filter((a) => a.path === "/anon/rotate") };
  }
  const post = (path: string, headers: Record<string, string>, body: unknown = {}) =>
    new Request("https://gw.example" + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const asDevice = (id: string, token: string, ip: string) => ({ "x-prime-device": id, "x-device-token": token, "cf-connecting-ip": ip });
  const ROTATE = "/api/devices/anonymous/rotate";

  test("the device is given its proposal back, with what the registry is told: the proposal and the code shown", async () => {
    const { env, rotated } = await gateway();
    const res = await worker.fetch(post(ROTATE, asDevice(ID, "N".repeat(25), "198.51.100.81"), { proposed: P1 }), env as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.token).toBe(P1);
    expect(body.deviceId).toBe(ID);
    expect(body.connect_url).toBe("https://gw.example/device/" + ID + "?token=" + P1);
    expect(body.previous_valid_ms).toBe(ROTATE_GRACE_MS);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(rotated()[0]!.body).toEqual({ proposed: P1, presented: "N".repeat(25) });
  });

  test("the code that was replaced is let through to the registry, which is the one that decides", async () => {
    const { env, rotated } = await gateway();
    await worker.fetch(post(ROTATE, asDevice(ID, "OLD123", "198.51.100.82"), { proposed: P1 }), env as never);
    expect(rotated()[0]!.body.presented).toBe("OLD123");
  });

  test("the registry's refusal is the answer: 409 for a replaced code", async () => {
    const { env } = await gateway();
    const real = env.REGISTRY as { get: () => { fetch: (i: string | Request) => Promise<Response> } };
    const inner = real.get().fetch;
    (env.REGISTRY as { get: () => unknown }).get = () => ({
      fetch: async (i: string | Request) => {
        const url = typeof i === "string" ? i : i.url;
        if (new URL(url).pathname === "/anon/rotate") return Response.json({ error: "this code has been replaced; use the new one" }, { status: 409 });
        return inner(i);
      },
    });
    const res = await worker.fetch(post(ROTATE, asDevice(ID, "OLD123", "198.51.100.83"), { proposed: P2 }), env as never);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("replaced");
  });

  test("the old code opens the device while it is kept, and not after, and a wrong code opens nothing", async () => {
    const kept = await gateway({}, { previous: true });
    const asOld = post("/fleets/acme/bootstrap", asDevice(ID, "OLD123", "198.51.100.84"));
    expect((await worker.fetch(asOld, kept.env as never)).status).not.toBe(401);
    const gone = await gateway({}, { previous: false });
    expect((await worker.fetch(post("/fleets/acme/bootstrap", asDevice(ID, "OLD123", "198.51.100.85")), gone.env as never)).status).toBe(401);
    expect((await worker.fetch(post("/fleets/acme/bootstrap", asDevice(ID, "NOTTHEONE", "198.51.100.86")), kept.env as never)).status).toBe(401);
  });

  test("a wrong code, a registered device, no device id, bad JSON and a GET are all refused, and nothing is made", async () => {
    const { env, rotated } = await gateway();
    expect((await worker.fetch(post(ROTATE, asDevice(ID, "WRONG", "198.51.100.87"), { proposed: P1 }), env as never)).status).toBe(401);
    expect((await worker.fetch(post(ROTATE, asDevice("reg1", "reg-secret", "198.51.100.88"), { proposed: P1 }), env as never)).status).toBe(400);
    expect((await worker.fetch(post(ROTATE, { "cf-connecting-ip": "198.51.100.89" }, { proposed: P1 }), env as never)).status).toBe(400);
    const bad = new Request("https://gw.example" + ROTATE, { method: "POST", headers: asDevice(ID, "N".repeat(25), "198.51.100.90"), body: "{nope" });
    expect((await worker.fetch(bad, env as never)).status).toBe(400);
    expect((await worker.fetch(new Request("https://gw.example" + ROTATE, { method: "GET" }), env as never)).status).toBe(405);
    expect(rotated()).toHaveLength(0);
  });

  test("a gateway that asks for its token is asked for it here too", async () => {
    const { env, rotated } = await gateway({ GATEWAY_TOKEN: "gw-secret-0123456789" });
    expect((await worker.fetch(post(ROTATE, asDevice(ID, "N".repeat(25), "198.51.100.91"), { proposed: P1 }), env as never)).status).toBe(401);
    expect(rotated()).toHaveLength(0);
    const ok = await worker.fetch(post(ROTATE, { ...asDevice(ID, "N".repeat(25), "198.51.100.92"), authorization: "Bearer gw-secret-0123456789" }, { proposed: P1 }), env as never);
    expect(ok.status).toBe(200);
  });

  describe("the operator's rotate", () => {
    const OP = "operator-secret-0123456789abcdef0123";
    const route = "/api/devices/anonymous/" + ID + "/rotate";

    test("with the operator token it needs no code and is not stopped by a lock on the device", async () => {
      const { env, rotated } = await gateway({ FLEET_OPERATOR_TOKEN: OP });
      // The device is locked for every address: its own code is refused...
      const reg = env.REGISTRY as { get: () => { fetch: (i: string | Request) => Promise<Response> } };
      const inner = reg.get().fetch;
      (env.REGISTRY as { get: () => unknown }).get = () => ({
        fetch: async (i: string | Request, init?: RequestInit) => {
          const req = typeof i === "string" ? new Request(i, init) : i;
          if (new URL(req.url).pathname === "/map") {
            const j = (await (await inner(req.clone())).json()) as Record<string, unknown>;
            return Response.json({ ...j, locked: { [ID + "|*"]: Date.now() + 600_000 } });
          }
          return inner(req);
        },
      });
      await new Promise((r) => setTimeout(r, 2_100));
      const refused = await worker.fetch(post(ROTATE, asDevice(ID, "N".repeat(25), "198.51.100.93"), { proposed: P1 }), env as never);
      expect(refused.status).toBe(429);
      // ...and the operator's is not.
      const res = await worker.fetch(post(route, { authorization: "Bearer " + OP, "cf-connecting-ip": "198.51.100.94" }, { proposed: P2 }), env as never);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { token: string }).token).toBe(P2);
      expect(rotated().at(-1)!.body).toEqual({ proposed: P2, operator: true, revoke_previous: false });
    });

    test("the option to stop the old code at once is passed on from the operator's route and the admin page's, and from nowhere else", async () => {
      const { env, rotated } = await gateway({ FLEET_OPERATOR_TOKEN: OP, ADMIN_ACCESS: "off" });
      await worker.fetch(post(route, { authorization: "Bearer " + OP, "cf-connecting-ip": "198.51.100.99" }, { proposed: P1, revoke_previous: true }), env as never);
      expect(rotated().at(-1)!.body).toEqual({ proposed: P1, operator: true, revoke_previous: true });
      await worker.fetch(post(route, { authorization: "Bearer " + OP, "cf-connecting-ip": "198.51.100.99" }, { proposed: P2, revoke_previous: "yes" }), env as never);
      expect(rotated().at(-1)!.body.revoke_previous).toBe(false);
      await worker.fetch(post("/admin/api/anonymous/" + "a".repeat(24) + "/rotate", { "cf-connecting-ip": "198.51.100.99" }, { revoke_previous: true }), env as never);
      expect(rotated().at(-1)!.body).toEqual({ operator: true, revoke_previous: true });
      // A device's own call has no such thing.
      await worker.fetch(post(ROTATE, asDevice(ID, "N".repeat(25), "198.51.100.99"), { proposed: P3, revoke_previous: true }), env as never);
      expect(rotated().at(-1)!.body).toEqual({ proposed: P3, presented: "N".repeat(25) });
    });

    test("when the registry cannot store the code the answer is the 503, not a code", async () => {
      const { env } = await gateway({ FLEET_OPERATOR_TOKEN: OP });
      const inner = (env.REGISTRY as { get: () => { fetch: (i: string | Request) => Promise<Response> } }).get().fetch;
      (env.REGISTRY as { get: () => unknown }).get = () => ({
        fetch: async (i: string | Request) => {
          const u = typeof i === "string" ? i : i.url;
          if (new URL(u).pathname === "/anon/rotate") return Response.json({ error: "could not store the new code; nothing was changed. Try again." }, { status: 503 });
          return inner(i);
        },
      });
      const res = await worker.fetch(post(route, { authorization: "Bearer " + OP, "cf-connecting-ip": "198.51.100.100" }, { proposed: P1 }), env as never);
      expect(res.status).toBe(503);
      expect(JSON.stringify(await res.json())).not.toContain(P1);
    });

    test("without the operator token, or with the gateway's or a device's, it is refused, and nothing is made", async () => {
      const { env, rotated } = await gateway({ FLEET_OPERATOR_TOKEN: OP, GATEWAY_TOKEN: "gw-secret-0123456789" });
      for (const headers of [{}, { authorization: "Bearer gw-secret-0123456789" }, { authorization: "Bearer " + OP + "x" }, asDevice(ID, "N".repeat(25), "")]) {
        const res = await worker.fetch(post(route, { "cf-connecting-ip": "198.51.100.95", ...headers }, { proposed: P1 }), env as never);
        expect(res.status).toBe(403);
      }
      expect(rotated()).toHaveLength(0);
      const none = await gateway({});
      expect((await worker.fetch(post(route, { authorization: "Bearer " + OP, "cf-connecting-ip": "198.51.100.96" }, { proposed: P1 }), none.env as never)).status).toBe(403);
    });

    test("the admin page's route, behind Access, makes the code again and answers it to the operator", async () => {
      const { env, rotated } = await gateway({ ADMIN_ACCESS: "off" });
      const res = await worker.fetch(post("/admin/api/anonymous/" + "a".repeat(24) + "/rotate", { "cf-connecting-ip": "198.51.100.97" }), env as never);
      expect(res.status).toBe(200);
      expect(rotated().at(-1)!.body).toEqual({ operator: true, revoke_previous: false });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.token).toHaveLength(25);
      expect(body.previous_valid_ms).toBe(ROTATE_GRACE_MS);
      // The page is not given the device's id (or a URL that holds it): it asks by the opaque ref.
      expect(JSON.stringify(body)).not.toContain(ID);
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    test("the admin page offers it, asks first, and shows the code once without the device's id", async () => {
      const { ADMIN_HTML } = await import("../src/admin-ui");
      expect(ADMIN_HTML).toContain("Make code again");
      expect(ADMIN_HTML).toContain('"/admin/api/anonymous/" + dev.ref + "/rotate"');
      expect(ADMIN_HTML).toContain("shown once");
      // ...with the choice to stop the old code now, sent as the option the gateway knows.
      expect(ADMIN_HTML).toContain('id="revokeNow"');
      expect(ADMIN_HTML).toContain("revoke_previous: revoke");
      // A question first, as for a delete: the click alone does not rotate.
      // The page's script still parses (a stray quote in a template string would break the whole page).
      for (const m of ADMIN_HTML.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) expect(() => new Function(m[1]!)).not.toThrow();
      expect(ADMIN_HTML).toContain('openDialog("Make the code again"');
      expect(ADMIN_HTML).toContain('id="rotateYes"');
    });

    test("Access still guards the admin route: without it nothing is made", async () => {
      const { env, rotated } = await gateway({ ADMIN_ACCESS: "enforce" });
      const res = await worker.fetch(post("/admin/api/anonymous/" + "a".repeat(24) + "/rotate", { "cf-connecting-ip": "198.51.100.98" }), env as never);
      expect(res.status).toBe(403);
      expect(rotated()).toHaveLength(0);
    });
  });
});
