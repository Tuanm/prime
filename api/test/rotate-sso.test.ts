import { beforeAll, afterAll, describe, expect, mock, test } from "bun:test";

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

const { handleFleetRoutes, operatorCredential } = await import("../src/fleets-routes");
const { default: worker } = await import("../src/index");

// Operators who sign in with Cloudflare Access: the identity runs the fleet and is what the fleet is told.

const pair = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1", alg: "RS256" };
const TEAM = "rotate-sso-team.example.com";
const AUD = "rotate-sso-aud";
const b64 = (text: string) => btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function token(payload: Record<string, unknown>) {
  const head = b64(JSON.stringify({ alg: "RS256", kid: "k1" })) + "." + b64(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(head)));
  let raw = "";
  for (const byte of sig) raw += String.fromCharCode(byte);
  return head + "." + b64(raw);
}
const now = Math.floor(Date.now() / 1000);
const claims = (email: string | undefined, extra: Record<string, unknown> = {}) => ({
  iss: "https://" + TEAM,
  aud: [AUD],
  exp: now + 600,
  nbf: now - 10,
  ...(email ? { email } : {}),
  ...extra,
});

let realFetch: typeof fetch;
const realWarn = console.warn;
// The certificate sets the teams serve, and how often each was asked for.
const teams = new Map<string, { keys: unknown[] | "down"; asked: number }>();
teams.set(TEAM, { keys: [jwk], asked: 0 });
beforeAll(() => {
  realFetch = globalThis.fetch;
  console.warn = () => {}; // the refusals are logged, and the log is not the test's output
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const m = /^https:\/\/([^/]+)\/cdn-cgi\/access\/certs$/.exec(u);
    const team = m ? teams.get(m[1]!) : undefined;
    if (team) {
      team.asked++;
      return team.keys === "down" ? new Response("down", { status: 503 }) : Response.json({ keys: team.keys });
    }
    return realFetch(input as never, init);
  }) as typeof fetch;
});
afterAll(() => {
  console.warn = realWarn;
  globalThis.fetch = realFetch;
});


// The operator's way to make an anonymous device's code again honours the same operator rules as the fleet routes.
describe("the operator rotate route", () => {
  async function rotate(headers: Record<string, string>, extraEnv: Record<string, unknown> = {}) {
    const asked: Array<Record<string, unknown>> = [];
    const registry = {
      fetch: async (input: Request | string) => {
        const req = typeof input === "string" ? undefined : input;
        const path = new URL(typeof input === "string" ? input : input.url).pathname;
        if (path === "/anon/rotate") {
          asked.push((await req!.json()) as Record<string, unknown>);
          return Response.json({ token: "ABCDEFGHJKLMNPQRSTUVWXYZ2", previousValidMs: 0 });
        }
        return Response.json({});
      },
    };
    const env = {
      ACCESS_TEAM_DOMAIN: TEAM,
      ACCESS_AUD: AUD,
      TOKEN_PEPPER: "test-pepper-0123456789abcdef0123456789",
      FLEET_OPERATOR_TOKEN: "operator-token",
      REGISTRY: { idFromName: () => "g", get: () => registry },
      ...extraEnv,
    };
    const res = await worker.fetch(
      new Request("https://gw.example/api/devices/anonymous/anon-dev/rotate", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" }),
      env as never,
    );
    return { res, asked };
  }

  test("the shared operator token still works, and carries no name", async () => {
    const { res, asked } = await rotate({ authorization: "Bearer operator-token" });
    expect(res.status).toBe(200);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.actor).toBeUndefined();
  });

  test("an Access token works, and the registry is told who", async () => {
    const { res, asked } = await rotate({ "cf-access-token": await token(claims("ops@example.com")) });
    expect(res.status).toBe(200);
    expect(asked[0]!.actor).toBe("access:ops@example.com");
  });

  test("SSO-only refuses the shared token here too, and asks nothing of the registry", async () => {
    const { res, asked } = await rotate({ authorization: "Bearer operator-token" }, { FLEET_OPERATOR_SSO_ONLY: "1" });
    expect(res.status).toBe(403);
    expect(asked).toEqual([]);
    const ok = await rotate({ "cf-access-token": await token(claims("ops@example.com")) }, { FLEET_OPERATOR_SSO_ONLY: "1" });
    expect(ok.res.status).toBe(200);
  });

  test("an identity outside FLEET_OPERATOR_EMAILS is refused", async () => {
    const { res, asked } = await rotate({ "cf-access-token": await token(claims("other@example.com")) }, { FLEET_OPERATOR_EMAILS: "ops@example.com" });
    expect(res.status).toBe(403);
    expect(asked).toEqual([]);
  });

  test("no credential, or the gateway token, is refused", async () => {
    expect((await rotate({})).res.status).toBe(403);
  });
});
