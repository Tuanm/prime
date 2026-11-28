// A viewer: sealed for like any member, and never the one that writes.
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

async function call(w: World, path: string, device: string, caller: "admin" | "device", body: Record<string, unknown> = {}, method = "POST", headers: Record<string, string> = {}) {
  const h = new Headers({ "content-type": "application/json", "x-prime-caller": caller, "x-prime-fleet": "acme", ...headers });
  if (device) h.set("x-prime-device", device);
  const res = await w.fleet.fetch(new Request("https://fleet" + path, { method, headers: h, body: method === "GET" ? undefined : JSON.stringify({ pubkey: KEY, ...body }) }));
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}
const asAccess = (email: string) => ({ "x-prime-actor": "access:" + email });


/** A fleet whose members are admitted in order: the first owns it; `viewers` are admitted as viewers. */
async function fleetOf(members: string[], viewers: string[] = [], socket = false) {
  const w = world({}, socket);
  await call(w, "/create", "owner", "admin");
  for (const [id, role] of [...["owner", ...members].map((m) => [m, undefined] as const), ...viewers.map((v) => [v, "viewer"] as const)]) {
    const invite = await call(w, "/invite", "owner", "admin");
    await call(w, "/join", id, "device", { code: invite.json.code });
    const done = await call(w, "/approve", "operator", "admin", { deviceId: id, ...(role ? { role } : {}) });
    expect(done.status).toBe(200);
  }
  return w;
}
const ask = (w: World, id: string, body: Record<string, unknown> = {}) => call(w, "/bootstrap", id, "device", { seals: true, ...body });

describe("admitting a viewer", () => {
  test("is a member the operator or the owner admits as a viewer, and it is listed as one", async () => {
    const w = await fleetOf(["dev-a"], ["watcher"]);
    const members = (await call(w, "/members", "", "admin", {}, "GET")).json.members as Array<{ deviceId: string; role: string }>;
    expect(members.map((m) => [m.deviceId, m.role])).toEqual([["owner", "owner"], ["dev-a", "member"], ["watcher", "viewer"]]);
    // The owner may admit one too.
    const invite = await call(w, "/invite", "owner", "device");
    await call(w, "/join", "second-eye", "device", { code: invite.json.code });
    expect((await call(w, "/approve", "owner", "device", { deviceId: "second-eye", role: "viewer" })).json.member.role).toBe("viewer");
  });

  test("the first one in owns the fleet, so it cannot be a viewer; and the owner is not made by a role", async () => {
    const w = world();
    await call(w, "/create", "owner", "admin");
    const invite = await call(w, "/invite", "owner", "admin");
    await call(w, "/join", "first", "device", { code: invite.json.code });
    const refused = await call(w, "/approve", "operator", "admin", { deviceId: "first", role: "viewer" });
    expect(refused.status).toBe(409);
    expect((await call(w, "/members", "", "admin", {}, "GET")).json.members).toEqual([]);
    // The request is still waiting, and is admitted as the owner.
    expect((await call(w, "/approve", "operator", "admin", { deviceId: "first" })).json.member.role).toBe("owner");
    const second = await call(w, "/invite", "first", "device");
    await call(w, "/join", "two", "device", { code: second.json.code });
    for (const role of ["owner", "admin", 5, null]) expect((await call(w, "/approve", "operator", "admin", { deviceId: "two", role })).status).toBe(400);
  });

  test("a viewer's key is sealed for: it is among the keys the primary reads, marked as a viewer", async () => {
    const w = await fleetOf(["dev-a"], ["watcher"]);
    await ask(w, "dev-a");
    const keys = (await call(w, "/keys", "dev-a", "device", {}, "GET")).json.members as Array<{ deviceId: string; role?: string; pubkey?: string }>;
    const watcher = keys.find((k) => k.deviceId === "watcher")!;
    expect(watcher.pubkey).toBe(KEY);
    expect(watcher.role).toBe("viewer");
    expect(keys.find((k) => k.deviceId === "dev-a")!.role).toBeUndefined();
  });
});

describe("what a viewer is never given", () => {
  test("the lease, even when it is free and the viewer has applied the head: it is told it is a replica, each time", async () => {
    const w = await fleetOf([]);
    const inv = await call(w, "/invite", "owner", "admin");
    await call(w, "/join", "watcher", "device", { code: inv.json.code });
    await call(w, "/approve", "operator", "admin", { deviceId: "watcher", role: "viewer" });
    for (let i = 0; i < 3; i++) {
      const got = await ask(w, "watcher");
      expect(got.status).toBe(200);
      expect(got.json.role).toBe("replica");
      expect(got.json.reason).toBe("viewer");
      expect(got.json.retryAfterMs).toBeGreaterThan(0);
      expect(got.json.ttlMs).toBe(45_000);
    }
    expect(w.data.get("lease")).toBeUndefined();
    expect(w.data.get("claim")).toBeUndefined();
    expect((await ask(w, "owner")).json.role).toBe("primary");
    expect((await ask(w, "watcher")).json.reason).toBe("viewer");
  });

  test("a claim to catch up: a viewer that is behind does not take it from the members that can publish", async () => {
    const w = await fleetOf(["dev-a", "dev-b"], ["watcher"]);
    w.objects.set("fleets/acme/head", { body: JSON.stringify({ seq: 4, manifestKey: "m", manifestHash: "h", epoch: 1 }), etag: "e0" });
    const got = await ask(w, "watcher");
    expect(got.json.reason).toBe("viewer");
    expect(w.data.get("claim")).toBeUndefined();
    const member = await ask(w, "dev-a");
    expect(member.json.reason).toBe("not-caught-up");
    expect((w.data.get("claim") as { device: string }).device).toBe("dev-a");
  });

  test("a publish: refused with 403 even if it somehow holds the lease", async () => {
    const w = await fleetOf(["dev-a"], ["watcher"]);
    await ask(w, "dev-a");
    // A lease row written for it by a role that changed under it.
    const lease = w.data.get("lease") as Record<string, unknown>;
    w.data.set("lease", { ...lease, holder: "watcher" });
    const manifest = "m".repeat(64);
    const res = await call(w, "/head/advance", "watcher", "device", { expectedSeq: 0, manifestKey: "fleets/acme/manifests/" + manifest, manifestHash: manifest, packKey: "", meta: { sealed: true } });
    expect(res.status).toBe(403);
    expect(w.objects.has("fleets/acme/head")).toBe(false);
  });

  test("a viewer reads what the fleet holds: the head, the index and its own place in it", async () => {
    const w = await fleetOf(["dev-a"], ["watcher"]);
    expect((await call(w, "/head", "watcher", "device", {}, "GET")).status).toBe(200);
    expect((await call(w, "/index", "watcher", "device", {}, "GET")).status).toBe(200);
    expect((await call(w, "/role", "watcher", "device", {}, "GET")).json).toMatchObject({ member: true, role: "viewer", primary: false });
    expect((await call(w, "/applied", "watcher", "device", { seq: 0 })).status).toBe(200);
    // ...and cannot admit anyone, delete the fleet, or read the audit log, like any member that is not the owner.
    expect((await call(w, "/invite", "watcher", "device")).status).toBe(403);
    expect((await call(w, "/delete", "watcher", "device")).status).toBe(403);
    expect((await call(w, "/audit", "watcher", "device", {}, "GET")).status).toBe(403);
  });
});

describe("a viewer and the owner of the fleet", () => {
  test("the fleet is handed to the longest-standing member that is not a viewer, and to nobody when only viewers are left", async () => {
    const w = await fleetOf(["dev-a", "dev-b"], ["watcher"]);
    await call(w, "/remove", "operator", "admin", { deviceId: "owner" });
    const roles = Object.fromEntries(((await call(w, "/members", "", "admin", {}, "GET")).json.members as Array<{ deviceId: string; role: string }>).map((m) => [m.deviceId, m.role]));
    expect(roles).toEqual({ "dev-a": "owner", "dev-b": "member", watcher: "viewer" });
    await call(w, "/remove", "operator", "admin", { deviceId: "dev-a" });
    await call(w, "/remove", "operator", "admin", { deviceId: "dev-b" });
    const left = (await call(w, "/members", "", "admin", {}, "GET")).json.members as Array<{ deviceId: string; role: string }>;
    expect(left.map((m) => [m.deviceId, m.role])).toEqual([["watcher", "viewer"]]);
  });
});

describe("a fleet that is left with only viewers", () => {
  test("the next member admitted that is not a viewer owns it, and can run it", async () => {
    const w = await fleetOf([], ["watcher"]);
    await call(w, "/remove", "operator", "admin", { deviceId: "owner" });
    expect(((await call(w, "/members", "", "admin", {}, "GET")).json.members as Array<{ role: string }>).map((m) => m.role)).toEqual(["viewer"]);
    const inv = await call(w, "/invite", "", "admin");
    await call(w, "/join", "dev-c", "device", { code: inv.json.code });
    expect((await call(w, "/approve", "operator", "admin", { deviceId: "dev-c" })).json.member.role).toBe("owner");
    // ...and it can invite, which with no owner nobody could.
    expect((await call(w, "/invite", "dev-c", "device")).status).toBe(200);
    // A viewer admitted into a fleet that has no owner is still a viewer, and does not become it.
    const w2 = await fleetOf([], ["watcher"]);
    await call(w2, "/remove", "operator", "admin", { deviceId: "owner" });
    const inv2 = await call(w2, "/invite", "", "admin");
    await call(w2, "/join", "second-eye", "device", { code: inv2.json.code });
    expect((await call(w2, "/approve", "operator", "admin", { deviceId: "second-eye", role: "viewer" })).json.member.role).toBe("viewer");
  });
});

describe("a viewer made a member in a fleet that has no owner", () => {
  test("owns it, and the log says so; with an owner it is a member", async () => {
    const w = await fleetOf([], ["watcher", "second-eye"]);
    await call(w, "/remove", "operator", "admin", { deviceId: "owner" });
    const made = await call(w, "/approve", "operator", "admin", { deviceId: "watcher", role: "member" });
    expect(made.json.member.role).toBe("owner");
    // The next one is a member: the fleet has an owner now.
    expect((await call(w, "/approve", "operator", "admin", { deviceId: "second-eye", role: "member" })).json.member.role).toBe("member");
    // ...and it can run the fleet, which with no owner nobody could.
    expect((await call(w, "/invite", "watcher", "device")).status).toBe(200);
    const log = (await call(w, "/audit?tail=50", "", "admin", {}, "GET")).json.entries as Array<{ action: string; detail?: Record<string, unknown> }>;
    expect(log.find((e) => e.action === "role-changed")!.detail).toMatchObject({ from: "viewer", to: "owner", owner: true });
  });
});

describe("changing a role in place", () => {
  const roles = async (w: World) => Object.fromEntries(((await call(w, "/members", "", "admin", {}, "GET")).json.members as Array<{ deviceId: string; role: string }>).map((m) => [m.deviceId, m.role]));

  test("a member becomes a viewer and back, keeping its place; the operator or the owner does it", async () => {
    const w = await fleetOf(["dev-a", "dev-b"]);
    const before = ((await call(w, "/members", "", "admin", {}, "GET")).json.members as Array<{ deviceId: string; addedAt: number }>).find((m) => m.deviceId === "dev-a")!.addedAt;
    expect((await call(w, "/approve", "operator", "admin", { deviceId: "dev-a", role: "viewer" })).json.member.role).toBe("viewer");
    expect(await roles(w)).toEqual({ owner: "owner", "dev-a": "viewer", "dev-b": "member" });
    expect((await ask(w, "dev-a")).json.reason).toBe("viewer");
    expect((await call(w, "/approve", "owner", "device", { deviceId: "dev-a", role: "member" })).json.member.role).toBe("member");
    const after = ((await call(w, "/members", "", "admin", {}, "GET")).json.members as Array<{ deviceId: string; addedAt: number }>).find((m) => m.deviceId === "dev-a")!.addedAt;
    expect(after).toBe(before);
    expect((await ask(w, "dev-a")).json.role).toBe("primary");
    // Saying what it already is changes nothing.
    expect((await call(w, "/approve", "operator", "admin", { deviceId: "dev-a", role: "member" })).json.unchanged).toBe(true);
  });

  test("a member that holds the lease lets go of it when it is made a viewer, and the others are told", async () => {
    const w = await fleetOf(["dev-a"], [], true);
    await ask(w, "dev-a");
    expect(w.data.get("lease")).toBeDefined();
    w.sent.length = 0;
    await call(w, "/approve", "operator", "admin", { deviceId: "dev-a", role: "viewer" });
    expect(w.data.get("lease")).toBeUndefined();
    expect(w.sent.map((m) => JSON.parse(m))).toEqual([{ type: "lease-free" }]);
    expect((await call(w, "/role", "dev-a", "device", {}, "GET")).json.primary).toBe(false);
  });

  test("the owner's role is not changed this way, and only member or viewer is a role to ask for; a non-owner may not ask", async () => {
    const w = await fleetOf(["dev-a", "dev-b"]);
    expect((await call(w, "/approve", "operator", "admin", { deviceId: "owner", role: "viewer" })).status).toBe(409);
    expect((await call(w, "/approve", "operator", "admin", { deviceId: "dev-a", role: "owner" })).status).toBe(400);
    expect((await call(w, "/approve", "dev-b", "device", { deviceId: "dev-a", role: "viewer" })).status).toBe(403);
    expect(await roles(w)).toEqual({ owner: "owner", "dev-a": "member", "dev-b": "member" });
  });

  test("a role sent for a device that is not a member and has no request is still 'no such request'", async () => {
    const w = await fleetOf(["dev-a"]);
    expect((await call(w, "/approve", "operator", "admin", { deviceId: "nobody", role: "viewer" })).status).toBe(404);
  });
});

describe("through the gateway", () => {
  const PEPPER = "test-pepper-0123456789abcdef0123456789";

  async function gateway(w: World) {
    const env: Record<string, unknown> = { TOKEN_PEPPER: PEPPER, ADMIN_ACCESS: "off" };
    const tok = await verifierFor(env as never, "device", "token-for-dev-a");
    const stub = { fetch: (i: Request | string, init?: RequestInit) => w.fleet.fetch(typeof i === "string" ? new Request(i, init) : i) };
    const reached: string[] = [];
    env.FLEET = { idFromName: (n: string) => n, get: () => stub };
    env.DEVICES = { idFromName: (n: string) => n, get: () => ({ fetch: async (req: Request) => (reached.push(await req.text()), Response.json({ jsonrpc: "2.0", id: 1, result: {} })) }) };
    env.REGISTRY = {
      idFromName: () => "global",
      get: () => ({
        fetch: async (input: string | Request) => {
          const path = new URL(typeof input === "string" ? input : input.url).pathname;
          if (path === "/map") return Response.json({ map: { watcher: tok, "dev-a": tok }, anonymous: [], online: ["dev-a"], locked: {}, previous: {}, buddies: {}, paused: [], blocked: [], disabled: [] });
          if (path === "/usage") return Response.json({ spentUsd: 0, budgetUsd: 20, overBudget: false });
          return Response.json({ ok: true, fleets: [], buddies: [] });
        },
      }),
    };
    resetRegistryCache();
    return { env, reached };
  }
  const relay = (env: unknown, as: string, ip: string) =>
    worker.fetch(
      new Request("https://gw.example/device/" + as + "?fleet=acme", {
        method: "POST",
        headers: { "content-type": "application/json", "x-prime-device": as, "x-device-token": "token-for-dev-a", "cf-connecting-ip": ip },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      env as never,
    );

  test("a viewer's call for the fleet's tools is refused with 403 and never reaches the primary; a member's does", async () => {
    const w = await fleetOf(["dev-a"], ["watcher"]);
    await ask(w, "dev-a");
    const { env, reached } = await gateway(w);
    const refused = await relay(env, "watcher", "198.51.100.81");
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toContain("viewer");
    expect(reached).toEqual([]);
    expect((await relay(env, "dev-a", "198.51.100.82")).status).toBe(200);
    expect(reached).toHaveLength(1);
  });

  test("the refused call is not written to the fleet's log as a relayed one", async () => {
    const w = await fleetOf(["dev-a"], ["watcher"]);
    await ask(w, "dev-a");
    const { env } = await gateway(w);
    await relay(env, "watcher", "198.51.100.83");
    const log = (await call(w, "/audit?tail=50", "", "admin", {}, "GET")).json.entries as Array<{ action: string }>;
    expect(log.filter((e) => e.action === "relayed")).toEqual([]);
  });

  test("the admin page admits as a viewer: the role goes through", async () => {
    const w = await fleetOf(["dev-a"]);
    const inv = await call(w, "/invite", "owner", "admin");
    await call(w, "/join", "watcher", "device", { code: inv.json.code });
    const { env } = await gateway(w);
    const res = await worker.fetch(
      new Request("https://gw.example/admin/api/fleets/acme/approve", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.84" }, body: JSON.stringify({ deviceId: "watcher", role: "viewer" }) }),
      env as never,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { member: { role: string } }).member.role).toBe("viewer");
  });
});
