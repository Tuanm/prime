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
const { loadConfig } = await import("../src/config");

// Operators who sign in with Cloudflare Access: the identity runs the fleet and is what the fleet is told.

const pair = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1", alg: "RS256" };
const TEAM = "sso-team.example.com";
const AUD = "sso-aud";
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

interface Seen {
  caller: string | null;
  device: string | null;
  actor: string | null;
  path: string;
}

function fleetStub() {
  const seen: Seen[] = [];
  const stub = {
    async fetch(input: Request | string, init?: RequestInit) {
      const headers = new Headers(init?.headers ?? (typeof input === "string" ? undefined : input.headers));
      seen.push({ caller: headers.get("x-prime-caller"), device: headers.get("x-prime-device"), actor: headers.get("x-prime-actor"), path: new URL(typeof input === "string" ? input : input.url).pathname });
      return Response.json({ ok: true });
    },
  };
  const registry = { idFromName: () => "g", get: () => ({ fetch: async () => Response.json({ count: 0 }) }) };
  return { seen, env: { FLEET: { idFromName: (n: string) => n, get: () => stub }, REGISTRY: registry, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD } as Record<string, unknown> };
}

async function fleetsCall(opts: { cfg?: Record<string, unknown>; headers?: Record<string, string>; path?: string; method?: string }) {
  const { seen, env } = fleetStub();
  const url = new URL("https://gateway" + (opts.path ?? "/fleets/acme/invite"));
  const method = opts.method ?? "POST";
  const res = await handleFleetRoutes({
    request: new Request(url, { method, headers: { "content-type": "application/json", ...opts.headers }, body: method === "GET" ? undefined : "{}" }),
    env: env as never,
    url,
    cfg: { gatewayToken: "gateway-token", fleetOperatorToken: "operator-token", ...opts.cfg } as never,
    authorizeDevice: async () => ({ ok: true as const }),
    unauthorized: () => new Response(null, { status: 401 }),
  });
  return { res: res!, seen };
}

describe("fleet operator actions with a Cloudflare Access token", () => {
  test("a valid Access token runs the fleet as the operator, and the fleet is told who", async () => {
    const jwt = await token(claims("Ops@Example.com"));
    const { res, seen } = await fleetsCall({ headers: { "cf-access-token": jwt, "x-prime-device": "dev-owner" } });
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ caller: "admin", device: "dev-owner", actor: "access:ops@example.com", path: "/invite" }]);
  });

  test("an identity that is not listed in FLEET_OPERATOR_EMAILS is refused, and the fleet is not reached", async () => {
    const jwt = await token(claims("other@example.com"));
    const { res, seen } = await fleetsCall({ cfg: { fleetOperatorEmails: ["ops@example.com"] }, headers: { "cf-access-token": jwt } });
    expect(res.status).toBe(403);
    expect(seen).toEqual([]);
    const ok = await fleetsCall({ cfg: { fleetOperatorEmails: ["ops@example.com"] }, headers: { "cf-access-token": await token(claims("OPS@example.com")) } });
    expect(ok.res.status).toBe(200);
  });

  test("a token the gateway's Access application did not sign for is refused with 401, even beside a good operator token", async () => {
    for (const bad of [claims("ops@example.com", { aud: ["someone-else"] }), claims("ops@example.com", { exp: now - 3600 }), claims("ops@example.com", { iss: "https://evil.example.com" })]) {
      const { res, seen } = await fleetsCall({ headers: { "cf-access-token": await token(bad), authorization: "Bearer operator-token" } });
      expect(res.status).toBe(401);
      expect(seen).toEqual([]);
    }
    const { res } = await fleetsCall({ headers: { "cf-access-token": "not.a.jwt" } });
    expect(res.status).toBe(401);
  });

  test("an Access service token is named by its service; a token that names nobody is refused; so is a service when emails are listed", async () => {
    const svc = await token(claims(undefined, { common_name: "ci-runner" }));
    const ok = await fleetsCall({ headers: { "cf-access-token": svc, "x-prime-device": "dev-owner" } });
    expect(ok.res.status).toBe(200);
    expect(ok.seen[0]!.actor).toBe("access:service:ci-runner");
    for (const jwt of [await token(claims(undefined)), await token(claims(undefined, { common_name: "" }))]) {
      const { res, seen } = await fleetsCall({ headers: { "cf-access-token": jwt } });
      expect(res.status).toBe(403);
      expect(seen).toEqual([]);
    }
    const listed = await fleetsCall({ cfg: { fleetOperatorEmails: ["ops@example.com"] }, headers: { "cf-access-token": svc } });
    expect(listed.res.status).toBe(403);
  });

  test("a refused Access token is answered the same whatever was wrong with it", async () => {
    const bodies = new Set<string>();
    for (const jwt of [await token(claims("ops@example.com", { aud: ["someone-else"] })), await token(claims("ops@example.com", { exp: now - 3600 })), "not.a.jwt"]) {
      const { res } = await fleetsCall({ headers: { "cf-access-token": jwt } });
      expect(res.status).toBe(401);
      bodies.add(JSON.stringify(await res.json()));
    }
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).not.toMatch(/audience|expired|signature/i);
  });

  test("without the Access application configured, a token opens nothing", async () => {
    const { env } = fleetStub();
    delete env.ACCESS_AUD;
    const url = new URL("https://gateway/fleets/acme/invite");
    const res = await handleFleetRoutes({
      request: new Request(url, { method: "POST", headers: { "cf-access-token": await token(claims("ops@example.com")) }, body: "{}" }),
      env: env as never,
      url,
      cfg: { fleetOperatorToken: "operator-token" } as never,
      authorizeDevice: async () => ({ ok: true as const }),
      unauthorized: () => new Response(null, { status: 401 }),
    });
    expect(res!.status).toBe(401);
  });

  test("the Access cookie is not an operator credential here: a browser would send it unasked", async () => {
    const { res } = await fleetsCall({ headers: { cookie: "CF_Authorization=" + (await token(claims("ops@example.com"))), "cf-access-jwt-assertion": await token(claims("ops@example.com")) } });
    expect(res.status).toBe(401);
  });

  test("an actor a client names is never passed on; the operator token carries no identity", async () => {
    const { res, seen } = await fleetsCall({ headers: { authorization: "Bearer operator-token", "x-prime-device": "dev-owner", "x-prime-actor": "access:boss@example.com" } });
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ caller: "admin", device: "dev-owner", actor: null, path: "/invite" }]);
  });

  test("FLEET_OPERATOR_SSO_ONLY switches the operator token off and says why; the Access token still works", async () => {
    const cfg = { fleetOperatorSsoOnly: true };
    const refused = await fleetsCall({ cfg, headers: { authorization: "Bearer operator-token", "x-prime-device": "dev-owner" } });
    expect(refused.res.status).toBe(403);
    expect(((await refused.res.json()) as { hint: string }).hint).toContain("Access");
    expect(refused.seen).toEqual([]);
    const ok = await fleetsCall({ cfg, headers: { "cf-access-token": await token(claims("ops@example.com")), "x-prime-device": "dev-owner" } });
    expect(ok.res.status).toBe(200);
    expect(ok.seen[0]!.actor).toBe("access:ops@example.com");
  });

  test("the settings are read from the environment", () => {
    const cfg = loadConfig({ FLEET_OPERATOR_SSO_ONLY: "1", FLEET_OPERATOR_EMAILS: " Ops@Example.com, ,b@example.com " } as never);
    expect(cfg.fleetOperatorSsoOnly).toBe(true);
    expect(cfg.fleetOperatorEmails).toEqual(["ops@example.com", "b@example.com"]);
    const none = loadConfig({} as never);
    expect(none.fleetOperatorSsoOnly).toBe(false);
    expect(none.fleetOperatorEmails).toEqual([]);
  });
});

describe("the admin page's calls", () => {
  async function admin(opts: { env?: Record<string, unknown>; headers?: Record<string, string>; method?: string; path?: string }) {
    const { seen, env } = fleetStub();
    const res = await worker.fetch(
      new Request("https://gw.example" + (opts.path ?? "/admin/api/fleets/acme/approve"), {
        method: opts.method ?? "POST",
        headers: { "content-type": "application/json", ...opts.headers },
        body: (opts.method ?? "POST") === "GET" ? undefined : JSON.stringify({ deviceId: "dev-a" }),
      }),
      { ...env, ADMIN_ACCESS: "off", ...opts.env } as never,
    );
    return { res, seen };
  }

  test("a POST that the browser says came from another site is refused, with Access or without", async () => {
    for (const headers of [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { origin: "http://gw.example" }]) {
      const { res, seen } = await admin({ headers });
      expect(res.status).toBe(403);
      expect(seen).toEqual([]);
    }
    const enforcing = await admin({
      env: { ADMIN_ACCESS: "enforce" },
      headers: { origin: "https://evil.example", "cf-access-jwt-assertion": await token(claims("ops@example.com")) },
    });
    expect(enforcing.res.status).toBe(403);
    expect(enforcing.seen).toEqual([]);
  });

  test("the page's own calls, and scripts that send neither header, go through; a read from anywhere is only a read", async () => {
    for (const headers of [{ origin: "https://gw.example" }, { "sec-fetch-site": "same-origin" }, {}]) {
      const { res, seen } = await admin({ headers });
      expect(res.status).toBe(200);
      expect(seen.map((s) => s.path)).toEqual(["/approve"]);
    }
    const read = await admin({ method: "GET", path: "/admin/api/blocked", headers: { origin: "https://evil.example" } });
    expect(read.res.status).not.toBe(403);
  });

  test("the identity Access gives the admin page is what the fleet is told, for each action", async () => {
    const jwt = await token(claims("Ops@Example.com"));
    const headers = { "cf-access-jwt-assertion": jwt, origin: "https://gw.example" };
    const env = { ADMIN_ACCESS: "enforce" };
    const done: Array<[string, string]> = [["POST", "approve"], ["POST", "invite"], ["POST", "remove"], ["POST", "reap"], ["POST", "meta"], ["POST", ""], ["DELETE", ""]];
    for (const [method, step] of done) {
      const { res, seen } = await admin({ env, headers, method, path: "/admin/api/fleets/acme" + (step ? "/" + step : "") });
      expect(res.status).toBe(200);
      expect(seen.map((s) => s.actor)).toEqual(["access:ops@example.com"]);
    }
  });

  test("with FLEET_OPERATOR_EMAILS set, an identity Access admits that is not listed gets nothing of the admin", async () => {
    const env = { ADMIN_ACCESS: "enforce", FLEET_OPERATOR_EMAILS: "ops@example.com" };
    const refused = await admin({ env, headers: { "cf-access-jwt-assertion": await token(claims("intruder@example.com")), origin: "https://gw.example" } });
    expect(refused.res.status).toBe(403);
    expect(refused.seen).toEqual([]);
    const ok = await admin({ env, headers: { "cf-access-jwt-assertion": await token(claims("ops@example.com")), origin: "https://gw.example" } });
    expect(ok.res.status).toBe(200);
  });
});

// ---- the second round ----

describe("what a client sends never names the actor, and its credentials stay at the Worker", () => {
  test("the events route: a member's own x-prime-actor, cookie and Access token do not reach the fleet object", async () => {
    const { seen, env } = fleetStub();
    const seenHeaders: Headers[] = [];
    const base = (env.FLEET as { get: () => { fetch: (i: Request | string, init?: RequestInit) => Promise<Response> } }).get();
    (env.FLEET as { get: () => unknown }).get = () => ({
      fetch: async (input: Request | string, init?: RequestInit) => {
        seenHeaders.push(new Headers(init?.headers ?? (typeof input === "string" ? undefined : input.headers)));
        return base.fetch(input, init);
      },
    });
    const url = new URL("https://gateway/fleets/acme/events");
    const res = await handleFleetRoutes({
      request: new Request(url, {
        headers: {
          upgrade: "websocket",
          "x-prime-device": "dev-member",
          "x-prime-actor": "access:boss@example.com",
          "x-prime-future": "x",
          cookie: "CF_Authorization=abc; other=1",
          "cf-access-jwt-assertion": "a.b.c",
          authorization: "Bearer member-credential",
          "x-device-token": "member-credential",
          "x-client-ip": "6.6.6.6",
          "sec-websocket-key": "k",
        },
      }),
      env: env as never,
      url,
      cfg: { gatewayToken: "g", fleetOperatorToken: "operator-token" } as never,
      authorizeDevice: async () => ({ ok: true as const }),
      unauthorized: () => new Response(null, { status: 401 }),
    });
    expect(res!.status).toBe(200);
    expect(seen).toEqual([{ caller: "device", device: "dev-member", actor: null, path: "/events" }]);
    const h = seenHeaders[0]!;
    expect(h.get("cookie")).toBeNull();
    expect(h.get("cf-access-jwt-assertion")).toBeNull();
    expect(h.get("x-prime-future")).toBeNull();
    // the member's own credential was for the Worker: the fleet object checks nothing of it
    expect(h.get("authorization")).toBeNull();
    expect(h.get("x-device-token")).toBeNull();
    expect(h.get("x-client-ip")).toBeNull();
    expect(h.get("upgrade")).toBe("websocket"); // what the object needs of the upgrade stays
    expect(h.get("sec-websocket-key")).toBe("k");
  });

  test("every route of the Worker that reaches a fleet object, a device object or the registry: none sees a client's actor, cookie or Access token", async () => {
    const reached: Array<{ to: string; path: string; headers: Headers }> = [];
    const recorder = (to: string, answer: (path: string) => Response) => ({
      fetch: async (input: Request | string, init?: RequestInit) => {
        const req = typeof input === "string" ? undefined : input;
        reached.push({ to, path: new URL(typeof input === "string" ? input : input.url).pathname, headers: new Headers(init?.headers ?? req?.headers) });
        return answer(new URL(typeof input === "string" ? input : input.url).pathname);
      },
    });
    const pepperEnv = { TOKEN_PEPPER: "test-pepper-0123456789abcdef0123456789", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_ACCESS: "off" } as Record<string, unknown>;
    const { verifierFor } = await import("../src/token-hash");
    const verifier = await verifierFor(pepperEnv as never, "device", "dev-token");
    const answers: Record<string, unknown> = {
      "/map": { map: { "hyg-dev": verifier }, anonymous: [], online: [], locked: [], buddies: {}, paused: [], blocked: [], disabled: [] },
      "/blocked": { ips: [] },
      "/disabled": { disabled: [] },
      "/usage": { spentUsd: 0, budgetUsd: 20, overBudget: false },
    };
    const registry = recorder("registry", (p) => Response.json(answers[p] ?? {}));
    const device = recorder("device", () => Response.json({ ok: true }));
    const fleet = recorder("fleet", () => Response.json({ ok: true }));
    const env = {
      ...pepperEnv,
      FLEET_OPERATOR_TOKEN: "operator-token",
      REGISTRY: { idFromName: () => "g", get: () => registry },
      DEVICES: { idFromName: (n: string) => n, get: () => device },
      FLEET: { idFromName: (n: string) => n, get: () => fleet },
    };
    const spoof = { "x-prime-actor": "access:boss@example.com", "x-prime-caller": "admin", "x-prime-fleet": "other", cookie: "CF_Authorization=abc", "cf-access-jwt-assertion": "a.b.c", "x-device-token": "dev-token", "x-prime-device": "hyg-dev", "x-client-ip": "6.6.6.6", "x-anon-rate-max": "999999", "x-anon-rate-window-ms": "1" };
    const routes: Array<[string, string, Record<string, string>?]> = [
      ["GET", "/device/ws/hyg-dev", { upgrade: "websocket" }],
      ["POST", "/device/hyg-dev"],
      ["GET", "/sse/hyg-dev"],
      ["POST", "/messages/hyg-dev"],
      ["GET", "/fleets/acme/events", { upgrade: "websocket" }],
      ["POST", "/fleets/acme/invite", { authorization: "Bearer operator-token" }],
      ["GET", "/fleets/acme/pending", { authorization: "Bearer operator-token" }],
      ["POST", "/fleets/acme/approve", { authorization: "Bearer operator-token" }],
      ["POST", "/admin/api/fleets/acme/invite", { origin: "https://gw.example" }],
      ["POST", "/admin/api/fleets/acme", { origin: "https://gw.example" }],
      ["POST", "/admin/api/devices/hyg-dev/tools", { origin: "https://gw.example" }],
    ];
    for (const [method, path, extra] of routes) {
      await worker.fetch(
        new Request("https://gw.example" + path, { method, headers: { "content-type": "application/json", ...spoof, ...extra }, body: method === "GET" ? undefined : "{}" }),
        env as never,
      ).catch(() => null);
    }
    // Not vacuous: the routes that copy a client's headers and the fleet routes were reached.
    expect(reached.filter((r) => r.to === "device").length).toBeGreaterThanOrEqual(1);
    expect(reached.filter((r) => r.to === "fleet").length).toBeGreaterThanOrEqual(3);
    for (const r of reached) {
      expect(r.headers.get("x-prime-actor")).toBeNull();
      expect(r.headers.get("cookie")).toBeNull();
      expect(r.headers.get("cf-access-jwt-assertion")).toBeNull();
      expect(r.headers.get("cf-access-token")).toBeNull();
      // the address and the anonymous allowance are the Worker's to say, never a client's
      expect(r.headers.get("x-client-ip")).not.toBe("6.6.6.6");
      expect(r.headers.get("x-anon-rate-max")).not.toBe("999999");
      expect(r.headers.get("x-anon-rate-window-ms")).not.toBe("1");
      if (r.to === "fleet") {
        expect(r.headers.get("x-prime-fleet")).toBe("acme");
        expect(r.headers.get("x-prime-caller")).not.toBe(null);
      }
    }
  });
});

describe("the Access certificate set", () => {
  test("a key the cached set lacks (Cloudflare rotated) makes one fresh fetch, not more than once a minute", async () => {
    const team = "rotate-team.example.com";
    const entry = { keys: [jwk] as unknown[], asked: 0 };
    teams.set(team, entry);
    const oldKeyOnly = async (kid: string) => {
      const head = b64(JSON.stringify({ alg: "RS256", kid })) + "." + b64(JSON.stringify({ iss: "https://" + team, aud: [AUD], exp: now + 600, email: "ops@example.com" }));
      const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(head)));
      let raw = "";
      for (const byte of sig) raw += String.fromCharCode(byte);
      return head + "." + b64(raw);
    };
    const { verifyAccessJwt } = await import("../src/access");
    const ask = (jwt: string) => verifyAccessJwt(new Request("https://gw.example/admin", { headers: { "cf-access-jwt-assertion": jwt } }), { team, aud: AUD });
    expect((await ask(await oldKeyOnly("k1"))).ok).toBe(true);
    expect(entry.asked).toBe(1);
    // Cloudflare adds a key; a token signed with it arrives while the set is cached
    entry.keys = [jwk, { ...jwk, kid: "k2" }];
    expect((await ask(await oldKeyOnly("k2"))).ok).toBe(true);
    expect(entry.asked).toBe(2);
    // made-up key ids do not each cost a fetch
    for (let i = 0; i < 5; i++) expect((await ask(await oldKeyOnly("nope" + i))).ok).toBe(false);
    expect(entry.asked).toBeLessThanOrEqual(3);
  });

  test("a failed fetch is remembered for a while, so an outage is not asked about by every request", async () => {
    const team = "outage-team.example.com";
    const entry = { keys: "down" as unknown[] | "down", asked: 0 };
    teams.set(team, entry);
    const { verifyAccessJwt } = await import("../src/access");
    const jwt = await token(claims("ops@example.com", { iss: "https://" + team }));
    for (let i = 0; i < 6; i++) {
      const v = await verifyAccessJwt(new Request("https://gw.example/admin", { headers: { "cf-access-jwt-assertion": jwt } }), { team, aud: AUD });
      expect(v.ok).toBe(false);
    }
    expect(entry.asked).toBe(1);
  });
});

describe("the admin gate, again", () => {
  async function admin(opts: { env?: Record<string, unknown>; headers?: Record<string, string>; method?: string; path?: string; body?: string }) {
    const { seen, env } = fleetStub();
    const res = await worker.fetch(
      new Request("https://gw.example" + (opts.path ?? "/admin/api/fleets/acme/approve"), {
        method: opts.method ?? "POST",
        headers: opts.headers,
        body: (opts.method ?? "POST") === "GET" ? undefined : (opts.body ?? "{}"),
      }),
      { ...env, ADMIN_ACCESS: "off", ...opts.env } as never,
    );
    return { res, seen };
  }

  test("a form's content types are refused without any Origin; JSON, no type at all, and a read are not", async () => {
    for (const type of ["application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "text/plain", "text/plain;charset=UTF-8"]) {
      const { res, seen } = await admin({ headers: { "content-type": type } });
      expect(res.status).toBe(403);
      expect(seen).toEqual([]);
    }
    for (const headers of [{ "content-type": "application/json" }, {}]) {
      expect((await admin({ headers })).res.status).toBe(200);
    }
    expect((await admin({ method: "GET", path: "/admin/api/blocked", headers: { "content-type": "text/plain" } })).res.status).not.toBe(403);
  });

  test("a client's own x-prime-actor on an admin call is not what the fleet is told", async () => {
    const { seen } = await admin({ headers: { "x-prime-actor": "access:boss@example.com", origin: "https://gw.example" } });
    expect(seen.map((s) => s.actor)).toEqual([null]);
  });

  test("warn mode lets an unlisted identity through, but gives it no actor; a service token is named like on /fleets, an anonymous one refused", async () => {
    const env = { ADMIN_ACCESS: "warn", FLEET_OPERATOR_EMAILS: "ops@example.com" };
    const unlisted = await admin({ env, headers: { "cf-access-jwt-assertion": await token(claims("intruder@example.com")) } });
    expect(unlisted.res.status).toBe(200);
    expect(unlisted.seen.map((s) => s.actor)).toEqual([null]);

    const open = { ADMIN_ACCESS: "enforce" };
    const svc = await admin({ env: open, headers: { "cf-access-jwt-assertion": await token(claims(undefined, { common_name: "ci-runner" })) } });
    expect(svc.res.status).toBe(200);
    expect(svc.seen.map((s) => s.actor)).toEqual(["access:service:ci-runner"]);
    const nobody = await admin({ env: open, headers: { "cf-access-jwt-assertion": await token(claims(undefined)) } });
    expect(nobody.res.status).toBe(403);
  });
});

describe("operatorCredential, the one place that says who is the operator", () => {
  const url = new URL("https://gateway/api/devices/anonymous/x/rotate");
  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD } as never;
  const ask = (headers: Record<string, string>, cfg: Record<string, unknown> = {}) =>
    operatorCredential({ fleetOperatorToken: "operator-token", ...cfg } as never, env, new Request(url, { method: "POST", headers }), url);

  test("the shared token is the operator without a name; Access is the operator with one; neither is none", async () => {
    expect(await ask({ authorization: "Bearer operator-token" })).toEqual({ kind: "token" });
    expect(await ask({ "cf-access-token": await token(claims("Ops@Example.com")) })).toEqual({ kind: "access", actor: "access:ops@example.com" });
    expect(await ask({ authorization: "Bearer gateway-token" })).toEqual({ kind: "none" });
    expect(await ask({})).toEqual({ kind: "none" });
  });

  test("SSO-only refuses the shared token with 403; Access and the email list are still honoured", async () => {
    const sso = { fleetOperatorSsoOnly: true };
    const refused = await ask({ authorization: "Bearer operator-token" }, sso);
    expect(refused.kind).toBe("refused");
    expect((refused as { response: Response }).response.status).toBe(403);
    expect((await ask({ "cf-access-token": await token(claims("ops@example.com")) }, sso)).kind).toBe("access");
    const listed = await ask({ "cf-access-token": await token(claims("other@example.com")) }, { ...sso, fleetOperatorEmails: ["ops@example.com"] });
    expect(listed.kind).toBe("refused");
    expect((listed as { response: Response }).response.status).toBe(403);
  });

  test("a bad Access assertion is refused, not set aside for the token beside it", async () => {
    const r = await ask({ "cf-access-token": "a.b.c", authorization: "Bearer operator-token" });
    expect(r.kind).toBe("refused");
    expect((r as { response: Response }).response.status).toBe(401);
  });
});

describe("listing the fleets", () => {
  async function list(headers: Record<string, string>, extraEnv: Record<string, unknown> = {}) {
    const registry = { fetch: async (input: Request | string) => (new URL(typeof input === "string" ? input : input.url).pathname === "/fleets" ? Response.json({ fleets: ["acme"] }) : Response.json({})) };
    const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, FLEET_OPERATOR_TOKEN: "operator-token", REGISTRY: { idFromName: () => "g", get: () => registry }, ...extraEnv };
    return worker.fetch(new Request("https://gw.example/fleets", { headers }), env as never);
  }

  test("the operator token lists them, an Access operator lists them, and nobody else does", async () => {
    expect((await list({ authorization: "Bearer operator-token" })).status).toBe(200);
    expect((await list({ "cf-access-token": await token(claims("ops@example.com")) })).status).toBe(200);
    expect((await list({})).status).toBe(403);
    expect((await list({ authorization: "Bearer gateway-token" })).status).toBe(403);
  });

  test("SSO-only switches the token off here too; the email list limits who lists", async () => {
    expect((await list({ authorization: "Bearer operator-token" }, { FLEET_OPERATOR_SSO_ONLY: "1" })).status).toBe(403);
    expect((await list({ "cf-access-token": await token(claims("ops@example.com")) }, { FLEET_OPERATOR_SSO_ONLY: "1" })).status).toBe(200);
    expect((await list({ "cf-access-token": await token(claims("other@example.com")) }, { FLEET_OPERATOR_EMAILS: "ops@example.com" })).status).toBe(403);
  });
});
