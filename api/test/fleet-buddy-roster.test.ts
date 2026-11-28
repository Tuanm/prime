// A client that reaches a fleet by its own name and token (a buddy of the fleet) may read that fleet's roster chain, and nothing else of it.
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { deleteRows, listRows } from "./fake-list";

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

const { FleetDO } = await import("../src/fleet-do");
const { default: worker, resetRegistryCache } = await import("../src/index");
const { verifierFor } = await import("../src/token-hash");

const KEY = "A".repeat(43) + "=";
const PEPPER = "test-pepper-0123456789abcdef0123456789";

beforeEach(() => setSystemTime(new Date("2026-12-01T10:00:00Z")));
afterEach(() => setSystemTime());

// ---- the fleet object --------------------------------------------------------------------------------------------

function world(env: Record<string, unknown> = {}, socket = false) {
  const sent: string[] = [];
  const data = new Map<string, unknown>();
  const failing = new Set<string>();
  let tail: Promise<unknown> = Promise.resolve();
  const storage = {
    async get(key: string) {
      const v = data.get(key);
      return v === undefined ? undefined : structuredClone(v);
    },
    async put(key: string, value: unknown) {
      if ([...failing].some((p) => key.startsWith(p))) throw new Error("storage refused " + key);
      data.set(key, JSON.parse(JSON.stringify(value)));
    },
    async delete(key: string | string[]) {
      return Array.isArray(key) ? deleteRows(data, key) : data.delete(key);
    },
    async list(o: { prefix?: string; start?: string; limit?: number; reverse?: boolean }) {
      return listRows(data, o);
    },
  };
  const objects = new Map<string, { body: string; etag: string }>();
  const bucket = {
    async get(key: string) {
      const o = objects.get(key);
      return o ? { etag: o.etag, json: async () => JSON.parse(o.body) } : null;
    },
    async put(key: string, body: string) {
      objects.set(key, { body, etag: "e" + objects.size });
      return { etag: "e" };
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
    async list(o: { prefix?: string }) {
      return { objects: [...objects.keys()].filter((k) => k.startsWith(o.prefix ?? "")).map((key) => ({ key })), truncated: false };
    },
  };
  const registry = { idFromName: () => "global", get: () => ({ fetch: async () => Response.json({ ok: true }) }) };
  const state = {
    storage,
    blockConcurrencyWhile: <T>(fn: () => Promise<T>): Promise<T> => {
      const run = tail.then(fn, fn);
      tail = run.catch(() => undefined);
      return run;
    },
    getWebSockets: () => (socket ? [{ send: (m: string) => void sent.push(m), close() {} }] : []),
  };
  const fleet = new FleetDO(state as never, { BUCKET: bucket, REGISTRY: registry, ...env } as never);
  return { fleet, data, objects, failing, sent };
}
type World = ReturnType<typeof world>;

let fleetName = "acme";
async function call(w: World, path: string, device: string, caller: "admin" | "device", body: Record<string, unknown> = {}, method = "POST", headers: Record<string, string> = {}) {
  const h = new Headers({ "content-type": "application/json", "x-prime-caller": caller, "x-prime-fleet": fleetName, ...headers });
  if (device) h.set("x-prime-device", device);
  const res = await w.fleet.fetch(new Request("https://fleet" + path, { method, headers: h, body: method === "GET" ? undefined : JSON.stringify({ pubkey: KEY, ...body }) }));
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}



async function fleetOf(name: string, members: string[]) {
  fleetName = name;
  const w = world();
  await call(w, "/create", "owner", "admin");
  for (const id of ["owner", ...members]) {
    const invite = await call(w, "/invite", "owner", "admin");
    await call(w, "/join", id, "device", { code: invite.json.code });
    expect((await call(w, "/approve", "operator", "admin", { deviceId: id })).status).toBe(200);
  }
  return w;
}

/** The gateway with two fleets, each answering under its own name to its own token. */
async function gateway(buddies: Record<string, string>) {
  const acme = await fleetOf("acme", ["dev-a"]);
  const other = await fleetOf("other", ["dev-b"]);
  const worlds: Record<string, World> = { acme, other };
  const env: Record<string, unknown> = { TOKEN_PEPPER: PEPPER, ADMIN_ACCESS: "off" };
  const dev = await verifierFor(env as never, "device", "token-for-dev-a");
  const verifiers: Record<string, string> = {};
  for (const [name, token] of Object.entries(buddies)) verifiers[name] = await verifierFor(env as never, "fleet", token);
  env.FLEET = { idFromName: (n: string) => n, get: (n: string) => ({ fetch: (i: Request | string, init?: RequestInit) => worlds[n]!.fleet.fetch(typeof i === "string" ? new Request(i, init) : i) }) };
  env.REGISTRY = {
    idFromName: () => "global",
    get: () => ({
      fetch: async (input: string | Request) => {
        const path = new URL(typeof input === "string" ? input : input.url).pathname;
        if (path === "/map") return Response.json({ map: { "dev-a": dev }, anonymous: [], online: ["dev-a"], locked: {}, previous: {}, buddies: verifiers, paused: [], blocked: [], disabled: [] });
        if (path === "/usage") return Response.json({ spentUsd: 0, budgetUsd: 20, overBudget: false });
        return Response.json({ ok: true, fleets: [], buddies: [] });
      },
    }),
  };
  resetRegistryCache();
  return env;
}

let ip = 10;
const asFleet = (env: unknown, fleet: string, route: string, as: string, token: string, method = "GET", body?: unknown) =>
  worker.fetch(
    new Request("https://gw.example/fleets/" + fleet + route, {
      method,
      headers: { "content-type": "application/json", "x-prime-device": as, "x-device-token": token, "cf-connecting-ip": "198.51.100." + ip++ },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env as never,
  );

describe("a fleet's own token and its roster", () => {
  test("reads the roster of that fleet, with the shape a member gets, and from a given entry on", async () => {
    const env = await gateway({ acme: "acme-buddy-token-0123456789", other: "other-buddy-token-0123456789" });
    const res = await asFleet(env, "acme", "/roster", "acme", "acme-buddy-token-0123456789");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; mode: string; entries: unknown[]; incarnation: string };
    expect(body).toMatchObject({ ok: true, mode: "open", entries: [] });
    expect(typeof body.incarnation).toBe("string");
    expect((await asFleet(env, "acme", "/roster?after=3", "acme", "acme-buddy-token-0123456789")).status).toBe(200);
  });

  test("is refused at another fleet's roster, whether it names itself or the other fleet", async () => {
    const env = await gateway({ acme: "acme-buddy-token-0123456789", other: "other-buddy-token-0123456789" });
    // Acme's token, as acme, at the other fleet's route: the name does not match the fleet asked.
    expect((await asFleet(env, "other", "/roster", "acme", "acme-buddy-token-0123456789")).status).toBe(401);
    // The other fleet's token under the other's name at acme's route.
    expect((await asFleet(env, "acme", "/roster", "other", "other-buddy-token-0123456789")).status).toBe(401);
    // The other fleet's token under acme's name.
    expect((await asFleet(env, "acme", "/roster", "acme", "other-buddy-token-0123456789")).status).toBe(401);
    // No token.
    expect((await asFleet(env, "acme", "/roster", "acme", "")).status).toBe(401);
  });

  test("is refused everything else of the fleet: the members, the pending, a write, the audit", async () => {
    const env = await gateway({ acme: "acme-buddy-token-0123456789" });
    for (const route of ["/members", "/pending", "/audit", "/me", "/keys", "/head", "/index", "/invite", ""]) {
      const res = await asFleet(env, "acme", route, "acme", "acme-buddy-token-0123456789");
      expect([route, res.status]).toEqual([route, 401]);
    }
    const write = await asFleet(env, "acme", "/roster", "acme", "acme-buddy-token-0123456789", "POST", { entry: [], sig: "" });
    expect(write.status).toBe(401);
    const approve = await asFleet(env, "acme", "/approve", "acme", "acme-buddy-token-0123456789", "POST", { deviceId: "dev-a" });
    expect(approve.status).toBe(401);
  });

  test("is refused when the fleet has no token any more, or has a new one; a member reads as before", async () => {
    const none = await gateway({});
    expect((await asFleet(none, "acme", "/roster", "acme", "acme-buddy-token-0123456789")).status).toBe(401);
    const rotated = await gateway({ acme: "acme-buddy-token-NEW-0123456789" });
    expect((await asFleet(rotated, "acme", "/roster", "acme", "acme-buddy-token-0123456789")).status).toBe(401);
    expect((await asFleet(rotated, "acme", "/roster", "acme", "acme-buddy-token-NEW-0123456789")).status).toBe(200);
    // A member of the fleet reads its roster with its own credential, as it did.
    expect((await asFleet(rotated, "acme", "/roster", "dev-a", "token-for-dev-a")).status).toBe(200);
    expect((await asFleet(rotated, "other", "/roster", "dev-a", "token-for-dev-a")).status).toBe(403);
  });

  test("a wrong token and a fleet with no token are held to the same limit, so that the limit does not say which has one", async () => {
    const env = (await gateway({ acme: "acme-buddy-token-0123456789" })) as Record<string, unknown>;
    env.FLEET_RL_UNKNOWN = { limit: async () => ({ success: false }) };
    const wrong = await asFleet(env, "acme", "/roster", "acme", "not-the-token-0123456789");
    const none = await asFleet(env, "other", "/roster", "other", "not-the-token-0123456789");
    expect([wrong.status, none.status]).toEqual([429, 429]);
    // The right token is not counted.
    expect((await asFleet(env, "acme", "/roster", "acme", "acme-buddy-token-0123456789")).status).toBe(200);
  });
});
