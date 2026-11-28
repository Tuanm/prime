// What a caller with no standing may ask of the fleet routes: a few a minute from one address, a body
// the size of a code, and a lock that is held against an address, not against the member.
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
mock.module("@cloudflare/containers", () => ({ Container: class {} }));

const { default: worker } = await import("../src/index");
const { verifierFor } = await import("../src/token-hash");
const { anonLockKey } = await import("../src/config");

const PEPPER = "test-pepper-0123456789abcdef0123456789";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A gateway in registry mode: one registered device (limits-dev), one anonymous one (limits-anon), fleet "acme" paused. */
async function gateway(extra: Record<string, unknown> = {}, locked: string[] = []) {
  const asked: string[] = [];
  const fleetAsked: string[] = [];
  const env: Record<string, unknown> = { TOKEN_PEPPER: PEPPER, ...extra };
  const answers: Record<string, unknown> = {
    "/map": {
      map: { "limits-dev": await verifierFor(env as never, "device", "member-token"), "limits-anon": await verifierFor(env as never, "device", "ANONCODE") },
      anonymous: ["limits-anon"],
      online: [],
      locked,
      buddies: {},
      paused: ["acme"],
      blocked: [],
      disabled: [],
    },
    "/usage": { spentUsd: 0, budgetUsd: 20, overBudget: false },
  };
  env.REGISTRY = {
    idFromName: () => "global",
    get: () => ({
      fetch: async (input: string | Request) => {
        const path = new URL(typeof input === "string" ? input : input.url).pathname;
        if (path !== "/usage-add") asked.push(path);
        return Response.json(answers[path] ?? {});
      },
    }),
  };
  env.FLEET = {
    idFromName: () => "acme",
    get: () => ({
      fetch: async (input: string | Request) => {
        fleetAsked.push(new URL(typeof input === "string" ? input : input.url).pathname);
        return Response.json({ ok: true });
      },
    }),
  };
  // A snapshot another test left in the isolate's cache would answer for this registry: a lock is only seen
  // once it has aged out.
  if (locked.length) await sleep(2_100);
  return { env, asked, fleetAsked };
}

function post(path: string, headers: Record<string, string>, body = "{}") {
  return new Request("https://gw.example" + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
}
const member = (ip: string) => ({ "x-prime-device": "limits-dev", "x-device-token": "member-token", "cf-connecting-ip": ip });

// A cache another test left warm would answer for this registry: wait it out once.
await sleep(2_100);

describe("unknown devices", () => {
  test("an address that keeps naming devices the gateway does not know is stopped, and the registry is read no more for it", async () => {
    const { env, asked } = await gateway({ FLEET_UNKNOWN_RATE_MAX: "5" });
    const ip = "198.51.100.11";
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await worker.fetch(post("/fleets/acme/bootstrap", { "x-prime-device": "ghost-" + i, "x-device-token": "x", "cf-connecting-ip": ip }), env as never);
      statuses.push(res.status);
      if (i === 5) {
        expect(res.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
        expect(((await res.json()) as { error: string }).error).toBe("rate limited");
      }
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429, 429]);
    // The registry was read for the five that were let through, and not for the three that were not.
    expect(asked.filter((p) => p === "/map").length).toBeLessThanOrEqual(6);
    const before = asked.length;
    await worker.fetch(post("/fleets/acme/bootstrap", { "x-prime-device": "ghost-9", "x-device-token": "x", "cf-connecting-ip": ip }), env as never);
    expect(asked.length).toBe(before);
  });

  test("another address, and a device that is known, are not held by it", async () => {
    const { env } = await gateway({ FLEET_UNKNOWN_RATE_MAX: "2" });
    const flooder = "198.51.100.12";
    for (let i = 0; i < 4; i++) await worker.fetch(post("/fleets/acme/bootstrap", { "x-prime-device": "ghost-" + i, "x-device-token": "x", "cf-connecting-ip": flooder }), env as never);
    const stopped = await worker.fetch(post("/fleets/acme/bootstrap", { "x-prime-device": "ghost-z", "x-device-token": "x", "cf-connecting-ip": flooder }), env as never);
    expect(stopped.status).toBe(429);
    // Its own member, from the same address, is a known device: it asks nothing of the limit.
    expect((await worker.fetch(post("/fleets/acme/bootstrap", member(flooder)), env as never)).status).toBe(409);
    // And a stranger's address has its own count.
    const other = await worker.fetch(post("/fleets/acme/bootstrap", { "x-prime-device": "ghost-a", "x-device-token": "x", "cf-connecting-ip": "198.51.100.13" }), env as never);
    expect(other.status).toBe(401);
  });

  test("0 turns the limit off", async () => {
    const { env } = await gateway({ FLEET_UNKNOWN_RATE_MAX: "0" });
    for (let i = 0; i < 10; i++) {
      const res = await worker.fetch(post("/fleets/acme/bootstrap", { "x-prime-device": "ghost-" + i, "x-device-token": "x", "cf-connecting-ip": "198.51.100.14" }), env as never);
      expect(res.status).toBe(401);
    }
  });
});

describe("invite checks", () => {
  // The way a code is checked by a caller with nothing to show: asking for an anonymous device with it.
  const make = (ip: string, code = "ABCD-EFGH") => post("/api/devices/anonymous", { "cf-connecting-ip": ip }, JSON.stringify({ fleet: "acme", code }));

  test("an address is held to its few a minute, and the fleet is not woken for the ones refused", async () => {
    const { env, fleetAsked } = await gateway({ FLEET_INVITE_RATE_MAX: "3" });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await worker.fetch(make("198.51.100.21", "c" + i), env as never);
      statuses.push(res.status);
      if (res.status === 429) {
        expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
        expect(((await res.json()) as { error: string }).error).toBe("rate limited");
      }
    }
    expect(statuses.slice(3)).toEqual([429, 429]);
    expect(statuses.slice(0, 3).every((s) => s !== 429)).toBe(true);
    expect(fleetAsked.filter((p) => p === "/invite-check").length).toBe(3);
  });

  test("another address has its own count", async () => {
    const { env } = await gateway({ FLEET_INVITE_RATE_MAX: "1" });
    await worker.fetch(make("198.51.100.29"), env as never);
    expect((await worker.fetch(make("198.51.100.29"), env as never)).status).toBe(429);
    expect((await worker.fetch(make("198.51.100.30"), env as never)).status).not.toBe(429);
  });

  test("a body bigger than a code is refused before the fleet is woken", async () => {
    const { env, fleetAsked } = await gateway();
    const res = await worker.fetch(make("198.51.100.22", "x".repeat(5000)), env as never);
    expect(res.status).toBe(413);
    expect(fleetAsked).toEqual([]);
  });

  test("a code is checked as before", async () => {
    const { env, fleetAsked } = await gateway();
    await worker.fetch(make("198.51.100.23"), env as never);
    expect(fleetAsked).toEqual(["/invite-check"]);
  });

  test("a rate-limit binding that says no is obeyed, one that cannot be asked is not a reason to refuse", async () => {
    const no = await gateway({ FLEET_RL_INVITE: { limit: async () => ({ success: false }) } });
    const refused = await worker.fetch(make("198.51.100.24"), no.env as never);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(no.fleetAsked).toEqual([]);
    const broken = await gateway({ FLEET_RL_INVITE: { limit: async () => { throw new Error("down"); } } });
    expect((await worker.fetch(make("198.51.100.25"), broken.env as never)).status).not.toBe(429);
    const yes = await gateway({ FLEET_RL_INVITE: { limit: async () => ({ success: true }) } });
    expect((await worker.fetch(make("198.51.100.26"), yes.env as never)).status).not.toBe(429);
  });

  test("/fleets/:id/invite-check is not a route: it answers 404 however it is asked, and wakes no fleet", async () => {
    const { env, fleetAsked } = await gateway();
    for (const headers of [member("198.51.100.35"), { "cf-connecting-ip": "198.51.100.36" }]) {
      const res = await worker.fetch(post("/fleets/acme/invite-check", headers, JSON.stringify({ code: "ABCD-EFGH" })), env as never);
      expect(res.status).toBe(404);
    }
    const operator = await gateway({ FLEET_OPERATOR_TOKEN: "operator-secret-0123456789" });
    const asked = await worker.fetch(
      post("/api/fleets/acme/invite-check", { authorization: "Bearer operator-secret-0123456789", "x-prime-device": "limits-dev", "cf-connecting-ip": "198.51.100.37" }),
      operator.env as never,
    );
    expect(asked.status).toBe(404);
    expect(fleetAsked).toEqual([]);
    expect(operator.fleetAsked).toEqual([]);
  });

  test("a body that carries no code is not an invite check and costs no count", async () => {
    const { env, fleetAsked } = await gateway({ FLEET_INVITE_RATE_MAX: "1" });
    for (let i = 0; i < 3; i++) await worker.fetch(post("/api/devices/anonymous", { "cf-connecting-ip": "198.51.100.34" }, "{}"), env as never);
    expect(fleetAsked).toEqual([]);
  });
});

describe("the size of what a fleet route forwards", () => {
  test("a body over 64 KB is refused, and one at the limit goes through", async () => {
    const { env, fleetAsked } = await gateway();
    const ip = "198.51.100.31";
    // A member of a fleet that is not paused: the fleet "other" is not in the paused list.
    const to = (n: number) => post("/fleets/other/join", member(ip), JSON.stringify({ pad: "x".repeat(n) }));
    const tooBig = await worker.fetch(to(70_000), env as never);
    expect(tooBig.status).toBe(413);
    expect(fleetAsked).toEqual([]);
    const fine = await worker.fetch(to(60_000), env as never);
    expect(fine.status).toBe(200);
    expect(fleetAsked).toEqual(["/join"]);
  });

  test("a body with no length said is stopped at the limit too", async () => {
    const { env, fleetAsked } = await gateway();
    const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 20) return controller.close();
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const req = new Request("https://gw.example/fleets/other/join", {
      method: "POST",
      headers: { ...member("198.51.100.32"), "content-type": "application/json" },
      body: stream,
      // @ts-expect-error: required by the runtime for a streamed request body
      duplex: "half",
    });
    const res = await worker.fetch(req, env as never);
    expect(res.status).toBe(413);
    expect(fleetAsked).toEqual([]);
    expect(sent).toBeLessThan(20);
  });

  test("the limit can be set", async () => {
    const { env } = await gateway({ FLEET_BODY_MAX_BYTES: "1000" });
    const res = await worker.fetch(post("/fleets/other/join", member("198.51.100.33"), JSON.stringify({ pad: "x".repeat(2000) })), env as never);
    expect(res.status).toBe(413);
  });
});

describe("a lock on an anonymous device", () => {
  const anon = (ip: string) => ({ "x-prime-device": "limits-anon", "x-device-token": "ANONCODE", "cf-connecting-ip": ip });

  test("refuses the address it was made against, the right code included, and says when to come back", async () => {
    const { env } = await gateway({}, [anonLockKey("limits-anon", "203.0.113.9")]);
    const res = await worker.fetch(post("/fleets/acme/bootstrap", anon("203.0.113.9")), env as never);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("600");
  });

  test("lets in the member from any other address", async () => {
    const { env } = await gateway({}, [anonLockKey("limits-anon", "203.0.113.9")]);
    // 409 is the paused fleet's answer to a member that is known: the lock did not stop it.
    expect((await worker.fetch(post("/fleets/acme/bootstrap", anon("203.0.113.10")), env as never)).status).toBe(409);
  });

  test("a wrong code from an address tells the registry which address it came from", async () => {
    const seen: string[] = [];
    const { env } = await gateway();
    const reg = env.REGISTRY as { get: () => { fetch: (i: string | Request) => Promise<Response> } };
    const inner = reg.get().fetch;
    reg.get = () => ({
      fetch: async (input: string | Request) => {
        const url = typeof input === "string" ? input : input.url;
        if (new URL(url).pathname === "/anon/fail") seen.push(new URL(url).search);
        return inner(input);
      },
    });
    const res = await worker.fetch(post("/fleets/acme/bootstrap", { "x-prime-device": "limits-anon", "x-device-token": "WRONGCODE", "cf-connecting-ip": "203.0.113.20" }), env as never);
    expect(res.status).toBe(401);
    expect(seen).toEqual(["?id=limits-anon&ip=203.0.113.20"]);
  });
});
