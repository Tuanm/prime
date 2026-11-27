// How often a request through the Worker asks the registry. Every ask is a
// Durable Object request on the bill, so a member that keeps knocking on a
// paused fleet must cost one ask, not one per list the gateway checks.
import { expect, mock, test } from "bun:test";

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

const PEPPER = "test-pepper-0123456789abcdef0123456789";

async function gateway(opts: { blocked?: string[]; disabled?: string[] } = {}) {
  const asked: string[] = [];
  const env = { TOKEN_PEPPER: PEPPER } as Record<string, unknown>;
  const verifier = await verifierFor(env as never, "device", "member-token");
  const answers: Record<string, unknown> = {
    "/map": {
      map: { "dev-1": verifier },
      anonymous: [],
      online: [],
      locked: [],
      buddies: {},
      paused: ["acme"],
      blocked: opts.blocked ?? [],
      disabled: opts.disabled ?? [],
    },
    "/blocked": { ips: opts.blocked ?? [] },
    "/disabled": { disabled: opts.disabled ?? [] },
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
  env.FLEET = { idFromName: () => "acme", get: () => ({ fetch: async () => Response.json({ ok: true }) }) };
  return { env, asked };
}

function bootstrap(ip = "198.51.100.9") {
  return new Request("https://gw.example/fleets/acme/bootstrap", {
    method: "POST",
    headers: { "x-prime-device": "dev-1", "x-device-token": "member-token", "cf-connecting-ip": ip, "content-type": "application/json" },
    body: "{}",
  });
}

test("a member knocking on a paused fleet costs the registry one ask, and says it is alive once an hour", async () => {
  const { env, asked } = await gateway();
  // Long enough after any earlier test that no isolate cache is warm.
  await new Promise((r) => setTimeout(r, 2_100));
  const res = await worker.fetch(bootstrap(), env as never);
  expect(res.status).toBe(409);
  expect(((await res.json()) as { paused?: boolean }).paused).toBe(true);
  // The one ask for the map, and one note that the device is alive (it is let go after days of silence).
  expect(asked.filter((p) => p !== "/usage")).toEqual(["/map", "/anon/seen"]);
  // Knocking again costs no second note.
  asked.length = 0;
  await new Promise((r) => setTimeout(r, 2_100));
  expect((await worker.fetch(bootstrap(), env as never)).status).toBe(409);
  expect(asked).not.toContain("/anon/seen");
});

test("a blocked address is still refused, read from the same ask", async () => {
  const { env, asked } = await gateway({ blocked: ["ipv4:203.0.113.7"] });
  await new Promise((r) => setTimeout(r, 2_100));
  const res = await worker.fetch(bootstrap("203.0.113.7"), env as never);
  expect(res.status).toBe(403);
  expect(asked).toEqual(["/map"]);
});

test("a disabled device is still refused, read from the same ask", async () => {
  const { env, asked } = await gateway({ disabled: ["dev-1"] });
  await new Promise((r) => setTimeout(r, 2_100));
  const res = await worker.fetch(bootstrap(), env as never);
  expect(res.status).toBe(403);
  expect(((await res.json()) as { error?: string }).error).toBe("device disabled");
  expect(asked.filter((p) => p !== "/usage")).toEqual(["/map"]);
});
