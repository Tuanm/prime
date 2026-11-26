import { describe, expect, test } from "bun:test";
import {
  cleanLabel,
  clampTtl,
  hashCode,
  INVITE_DEFAULT_TTL_MS,
  INVITE_MAX_TTL_MS,
  inviteShape,
  FleetCreationAllowance,
  MAX_FLEETS_PER_DEVICE,
  MAX_MEMBERS,
  OWNER_SILENCE_MS,
  RECENT_SNAPSHOTS,
  newInviteCode,
  validFleetId,
} from "../src/fleets";
import { FleetDO } from "../src/fleet-do";
import { handleFleetRoutes } from "../src/fleets-routes";

// ---- helpers -------------------------------------------------------------

// A stand-in for DurableObjectStorage that keeps everything in one Map and
// runs the blockConcurrencyWhile callback immediately. Enough to exercise the
// state machine; it does not model the scheduler.
function fakeState() {
  const data = new Map<string, unknown>();
  return {
    data,
    storage: {
      async get<T>(key: string): Promise<T | undefined> {
        return data.get(key) as T | undefined;
      },
      async put(key: string, value: unknown): Promise<void> {
        // round-trip through JSON, like a real SQLite-backed DO
        data.set(key, JSON.parse(JSON.stringify(value)));
      },
      async delete(key: string): Promise<boolean> {
        return data.delete(key);
      },
    },
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  };
}

// An R2 stand-in with the real conditional-write semantics: a mismatched etag
// returns null instead of throwing, which is what the code relies on.
function fakeBucket() {
  const objects = new Map<string, { body: string; etag: string }>();
  let n = 0;
  const etagOf = (body: string) => "e" + body.length + "-" + (n++).toString(16);
  return {
    objects,
    async delete(key: string) {
      objects.delete(key);
    },
    async get(key: string) {
      const o = objects.get(key);
      if (!o) return null;
      return { etag: o.etag, json: async () => JSON.parse(o.body) };
    },
    async put(key: string, body: string, opts?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
      const cur = objects.get(key);
      const cond = opts?.onlyIf;
      if (cond?.etagMatches !== undefined && cur?.etag !== cond.etagMatches) return null;
      if (cond?.etagDoesNotMatch !== undefined) {
        if (cond.etagDoesNotMatch === "*" && cur) return null;
        if (cond.etagDoesNotMatch !== "*" && cur?.etag === cond.etagDoesNotMatch) return null;
      }
      const etag = etagOf(body);
      objects.set(key, { body, etag });
      return { etag, size: body.length };
    },
  };
}

/** A stand-in for the registry: the fleet ids it knows. */
function fakeRegistry() {
  const fleets = new Set<string>();
  return {
    fleets,
    idFromName: () => "global",
    get: () => ({
      fetch: async (input: Request | string, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.url;
        const path = new URL(url).pathname;
        const id = new URL(url).searchParams.get("id") || "";
        if (path === "/fleet-add" && id) {
          fleets.add(id);
          return Response.json({ ok: true });
        }
        if (path === "/fleet-remove" && id) {
          fleets.delete(id);
          return Response.json({ ok: true });
        }
        if (path === "/fleets") return Response.json({ fleets: [...fleets] });
        return Response.json({ ok: true });
      },
    }),
  };
}

function makeDo(bucket = fakeBucket()) {
  const state = fakeState();
  const env = { BUCKET: bucket } as unknown as Record<string, unknown>;
  const realState = { storage: state.storage, blockConcurrencyWhile: state.blockConcurrencyWhile } as unknown as DurableObjectState;
  const doInstance = new FleetDO(realState, env as never);
  return { doInstance, state, bucket };
}

/** A key shaped like a real one: base64 of 32 bytes. */
const TEST_PUBKEY = "A".repeat(43) + "=";

async function call(
  doInstance: FleetDO,
  path: string,
  opts: { caller?: "admin" | "device"; device?: string; fleet?: string; method?: string; body?: unknown } = {},
) {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.caller) headers.set("x-prime-caller", opts.caller);
  if (opts.device) headers.set("x-prime-device", opts.device);
  headers.set("x-prime-fleet", opts.fleet ?? "acme");
  // Read-only routes are GET; every mutation is POST. /create has no body but is
  // still a POST, so the method cannot be inferred from the body alone.
  const READ_ONLY = ["/members", "/pending", "/me"];
  const method = opts.method ?? (READ_ONLY.includes(path) ? "GET" : "POST");
  // A member publishes snapshots sealed for the members' keys, so a member
  // without one may not hold the lease. Real members always have one.
  let body = opts.body;
  if (body === undefined && (path === "/create" || path === "/join")) {
    body = { pubkey: TEST_PUBKEY };
  } else if (body !== undefined && typeof body === "object" && !("pubkey" in body)) {
    body = { ...body, pubkey: TEST_PUBKEY };
  }
  const response = await doInstance.fetch(
    new Request("https://fleet" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
  );
  return { status: response.status, json: (await response.json()) as Record<string, any> };
}

describe("a member that comes back with a new key", () => {
  test("the fleet learns the new key when it joins again", async () => {
    const { doInstance, state } = makeDo();
    await makeFleet(doInstance, "owner-1");
    const invite = await call(doInstance, "/invite", { caller: "device", device: "owner-1", body: {} });
    await call(doInstance, "/join", { caller: "device", device: "member-1", body: { code: invite.json.code, pubkey: TEST_PUBKEY } });
    await call(doInstance, "/approve", { caller: "admin", device: "operator", body: { deviceId: "member-1" } });
    const joined = await call(doInstance, "/join", { caller: "device", device: "member-1", body: { code: invite.json.code, pubkey: "B".repeat(43) + "=" } });
    expect(joined.status).toBe(200);
    // The key it came back with is the key the fleet seals for.
    const members = state.data.get("members") as Record<string, { pubkey?: string }>;
    expect(members["member-1"]?.pubkey).toBe("B".repeat(43) + "=");
  });

  test("the fleet learns the new key when it takes its place", async () => {
    const { doInstance, state } = makeDo();
    await makeFleet(doInstance, "owner-1");
    const invite = await call(doInstance, "/invite", { caller: "device", device: "owner-1", body: { autoApprove: true } });
    await call(doInstance, "/join", { caller: "device", device: "member-1", body: { code: invite.json.code, pubkey: TEST_PUBKEY } });
    await call(doInstance, "/approve", { caller: "admin", device: "operator", body: { deviceId: "member-1" } });
    await call(doInstance, "/bootstrap", { caller: "device", device: "member-1", body: { pubkey: "C".repeat(43) + "=" } });
    const members = state.data.get("members") as Record<string, { pubkey?: string }>;
    expect(members["member-1"]?.pubkey).toBe("C".repeat(43) + "=");
  });
});

/**
 * A fleet as the operator sets it up: the operator creates it, the device
 * asks to join, and the operator admits it. The first member admitted owns
 * the fleet.
 */
async function makeFleet(doInstance: FleetDO, owner = "dev-owner"): Promise<void> {
  await call(doInstance, "/create", { caller: "admin", device: "operator" });
  const invite = await call(doInstance, "/invite", { caller: "admin", device: "operator", body: {} });
  await call(doInstance, "/join", { caller: "device", device: owner, body: { code: invite.json.code, pubkey: TEST_PUBKEY } });
  await call(doInstance, "/approve", { caller: "admin", device: "operator", body: { deviceId: owner } });
}

// ---- pure helpers --------------------------------------------------------

describe("fleet ids", () => {
  test("accepts readable ids and rejects anything that could traverse a path", () => {
    expect(validFleetId("acme")).toBe(true);
    expect(validFleetId("team-1")).toBe(true);
    expect(validFleetId("a")).toBe(true);
    expect(validFleetId("9lives")).toBe(true);
    expect(validFleetId("Acme")).toBe(false);
    expect(validFleetId("-acme")).toBe(false);
    expect(validFleetId("../etc")).toBe(false);
    expect(validFleetId("a/b")).toBe(false);
    expect(validFleetId("")).toBe(false);
    expect(validFleetId("x".repeat(33))).toBe(false);
  });

  test("leaves the ids the gateway gives out to the anonymous devices", () => {
    // An anonymous device is anon-<hex>; a fleet with that name would answer
    // to a device's id.
    expect(validFleetId("anon-0123456789abcdef")).toBe(false);
    expect(validFleetId("anonymous")).toBe(true);
  });
});

describe("invite codes", () => {
  test("are prefixed, fixed-shape, and unique", () => {
    const a = newInviteCode();
    const b = newInviteCode();
    expect(a).not.toBe(b);
    expect(inviteShape(a)).toBe(true);
    expect(a.startsWith("pf1_")).toBe(true);
    expect(new Set(Array.from({ length: 200 }, () => newInviteCode())).size).toBe(200);
  });

  test("reject anything that is not a code", () => {
    expect(inviteShape("")).toBe(false);
    expect(inviteShape("pf1_")).toBe(false);
    expect(inviteShape("pf1_short")).toBe(false);
    expect(inviteShape("nope")).toBe(false);
    expect(inviteShape("pf1_" + "x".repeat(31))).toBe(false);
    expect(inviteShape(newInviteCode() + "x")).toBe(false);
    // a path-looking value must never be treated as a code
    expect(inviteShape("../../etc/passwd")).toBe(false);
  });

  test("hash deterministically and never store the code itself", async () => {
    const code = newInviteCode();
    const h1 = await hashCode(code);
    const h2 = await hashCode(code);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(code);
    expect(h1).toHaveLength(64);
    expect(await hashCode(code + "x")).not.toBe(h1);
  });
});

describe("limits", () => {
  test("ttl is clamped to a sane window", () => {
    expect(clampTtl(undefined)).toBe(INVITE_DEFAULT_TTL_MS);
    expect(clampTtl(0)).toBe(INVITE_DEFAULT_TTL_MS);
    expect(clampTtl(-5)).toBe(INVITE_DEFAULT_TTL_MS);
    expect(clampTtl(60_000)).toBe(60_000);
    expect(clampTtl(INVITE_MAX_TTL_MS * 10)).toBe(INVITE_MAX_TTL_MS);
  });

  test("labels are cosmetic: stripped of control characters and bounded", () => {
    expect(cleanLabel("  laptop  ")).toBe("laptop");
    expect(cleanLabel("   ")).toBeUndefined();
    expect(cleanLabel(42)).toBeUndefined();
    expect(cleanLabel("a\u0000b\u001fc")).toBe("abc");
    expect(cleanLabel("x".repeat(200))!.length).toBe(48);
  });
});
// ---- the Durable Object state machine ------------------------------------

describe("fleet creation", () => {
  test("an operator or a proven device can create, and only once", async () => {
    const { doInstance } = makeDo();
    const created = await call(doInstance, "/create", { caller: "admin", device: "operator" });
    expect(created.status).toBe(200);
    // The fleet is empty: the operator admits the members.
    const members = await call(doInstance, "/members", { caller: "admin", device: "operator" });
    expect((members.json.members ?? []).length).toBe(0);
    const again = await call(doInstance, "/create", { caller: "admin", device: "operator" });
    expect(again.status).toBe(409);
  });

  test("a device cannot create a fleet of its own", async () => {
    const { doInstance } = makeDo();
    const created = await call(doInstance, "/create", { caller: "device", device: "dev-first" });
    expect(created.status).toBe(403);
  });

  test("the first member the operator admits owns the fleet", async () => {
    const { doInstance } = makeDo();
    await call(doInstance, "/create", { caller: "admin", device: "operator" });
    const invite = await call(doInstance, "/invite", { caller: "admin", device: "operator", body: {} });
    await call(doInstance, "/join", { caller: "device", device: "dev-first", body: { code: invite.json.code, pubkey: TEST_PUBKEY } });
    const pending = await call(doInstance, "/pending", { caller: "admin", device: "operator" });
    expect((pending.json.requests ?? pending.json.pending ?? []).length).toBe(1);
    const approved = await call(doInstance, "/approve", { caller: "admin", device: "operator", body: { deviceId: "dev-first" } });
    expect(approved.status).toBe(200);
    expect(approved.json.member.role).toBe("owner");
  });

  test("the device allowance is counted where every device shares it", () => {
    // The count lives in one place that every device shares, because a count
    // kept per fleet would be fresh for every new fleet and so would never
    // count anything.
    const allowance = new FleetCreationAllowance();
    expect(allowance.count("dev-1")).toBe(0);
    expect(allowance.allows("dev-1")).toBe(true);
    for (let i = 0; i < MAX_FLEETS_PER_DEVICE; i++) {
      allowance.record("dev-1");
    }
    expect(allowance.count("dev-1")).toBe(MAX_FLEETS_PER_DEVICE);
    expect(allowance.allows("dev-1")).toBe(false);
    // Another device has its own allowance.
    expect(allowance.count("dev-2")).toBe(0);
    expect(allowance.allows("dev-2")).toBe(true);
  });

  test("the allowance forgets what falls outside its window", () => {
    const allowance = new FleetCreationAllowance(2, 1000);
    allowance.record("dev-1", 1000);
    allowance.record("dev-1", 1500);
    expect(allowance.allows("dev-1", 1500)).toBe(false);
    // Half an hour later the first two are outside the window.
    expect(allowance.allows("dev-1", 2600)).toBe(true);
  });
});

describe("invites", () => {
  test("an operator mints a code, and only its hash is stored", async () => {
    const { doInstance, state } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    const inv = await call(doInstance, "/invite", { caller: "admin", device: "dev-owner", body: {} });
    expect(inv.status).toBe(200);
    expect(inviteShape(inv.json.code)).toBe(true);
    const stored = JSON.stringify(state.data.get("invites"));
    expect(stored).not.toContain(inv.json.code);
    expect(stored).toContain(await hashCode(inv.json.code));
  });

  test("the owner of a fleet can mint an invite, and a stranger cannot", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    // The device that created the fleet runs it.
    const own = await call(doInstance, "/invite", { caller: "device", device: "dev-owner", body: {} });
    expect(own.status).toBe(200);
    expect(inviteShape(own.json.code)).toBe(true);
    // A device that is not the owner has no say in the fleet.
    const stranger = await call(doInstance, "/invite", { caller: "device", device: "dev-stranger", body: {} });
    expect(stranger.status).toBe(403);
  });

  test("an invite on a fleet that does not exist is refused", async () => {
    const { doInstance } = makeDo();
    const inv = await call(doInstance, "/invite", { caller: "admin", device: "dev-owner", body: {} });
    expect(inv.status).toBe(404);
  });
});

describe("joining", () => {
  test("a valid code admits the device to the pending list", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    const inv = await call(doInstance, "/invite", { caller: "admin", device: "dev-owner", body: {} });
    const joined = await call(doInstance, "/join", { caller: "device", device: "dev-new", body: { code: inv.json.code, label: "laptop" } });
    expect(joined.status).toBe(200);
    expect(joined.json.status).toBe("pending");
    const me = await call(doInstance, "/me", { caller: "device", device: "dev-new", method: "GET" });
    expect(me.json.status).toBe("pending");
  });

  test("an unknown code is refused, and a code is single use", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    const bad = await call(doInstance, "/join", { caller: "device", device: "dev-x", body: { code: newInviteCode() } });
    expect(bad.status).toBe(403);

    const inv = await call(doInstance, "/invite", { caller: "admin", device: "dev-owner", body: {} });
    const first = await call(doInstance, "/join", { caller: "device", device: "dev-a", body: { code: inv.json.code } });
    expect(first.status).toBe(200);
    const second = await call(doInstance, "/join", { caller: "device", device: "dev-b", body: { code: inv.json.code } });
    expect(second.status).toBe(403);
  });

  test("an expired invite is refused and removed", async () => {
    const { doInstance, state } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    const inv = await call(doInstance, "/invite", { caller: "admin", device: "dev-owner", body: { ttlMs: 1 } });
    await new Promise((r) => setTimeout(r, 10));
    const joined = await call(doInstance, "/join", { caller: "device", device: "dev-late", body: { code: inv.json.code } });
    expect(joined.status).toBe(403);
    expect(Object.keys((state.data.get("invites") as Record<string, unknown>) ?? {})).toHaveLength(0);
  });

  test("a join waits for the operator", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    const inv = await call(doInstance, "/invite", { caller: "admin", device: "dev-owner", body: {} });
    const joined = await call(doInstance, "/join", { caller: "device", device: "dev-fast", body: { code: inv.json.code } });
    expect(joined.json.status).toBe("pending");
    // It is not a member until the operator admits it.
    const me = await call(doInstance, "/me", { caller: "device", device: "dev-fast", method: "GET" });
    expect(me.json.status).toBe("pending");
  });

  test("re-joining when already a member is idempotent", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    const inv = await call(doInstance, "/invite", { caller: "admin", device: "dev-owner", body: {} });
    await call(doInstance, "/join", { caller: "device", device: "dev-fast", body: { code: inv.json.code } });
    await call(doInstance, "/approve", { caller: "admin", device: "operator", body: { deviceId: "dev-fast" } });
    await call(doInstance, "/approve", { caller: "admin", device: "operator", body: { deviceId: "dev-fast" } });
    const again = await call(doInstance, "/join", { caller: "device", device: "dev-fast", body: { code: newInviteCode() } });
    expect(again.status).toBe(200);
    expect(again.json.status).toBe("member");
  });

  test("an operator cannot join as a device", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    const joined = await call(doInstance, "/join", { caller: "admin", device: "dev-owner", body: { code: newInviteCode() } });
    expect(joined.status).toBe(403);
  });
});

describe("approval and removal", () => {
  test("approve promotes a pending request to member", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    const inv = await call(doInstance, "/invite", { caller: "admin", device: "dev-owner", body: {} });
    await call(doInstance, "/join", { caller: "device", device: "dev-new", body: { code: inv.json.code } });
    const pending = await call(doInstance, "/pending", { caller: "admin", device: "dev-owner", method: "GET" });
    expect(pending.json.pending).toHaveLength(1);
    const approved = await call(doInstance, "/approve", { caller: "admin", device: "dev-owner", body: { deviceId: "dev-new" } });
    expect(approved.status).toBe(200);
    const me = await call(doInstance, "/me", { caller: "device", device: "dev-new", method: "GET" });
    expect(me.json.status).toBe("member");
  });

  test("approving something that is not pending is refused", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    const approved = await call(doInstance, "/approve", { caller: "admin", device: "dev-owner", body: { deviceId: "ghost" } });
    expect(approved.status).toBe(404);
  });

  test("the owner may leave, and the fleet goes to the member that stayed longest", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    const inv = await call(doInstance, "/invite", { caller: "admin", device: "dev-owner", body: { autoApprove: true } });
    await call(doInstance, "/join", { caller: "device", device: "dev-m", body: { code: inv.json.code } });
    await call(doInstance, "/approve", { caller: "admin", device: "operator", body: { deviceId: "dev-m" } });
    const left = await call(doInstance, "/remove", { caller: "admin", device: "dev-owner", body: { deviceId: "dev-owner" } });
    expect(left.status).toBe(200);
    // The member that stayed is the owner now, so it can run the fleet.
    const roster = await call(doInstance, "/members", { caller: "admin", device: "dev-op", method: "GET" });
    expect(roster.json.members).toHaveLength(1);
    expect(roster.json.members[0].deviceId).toBe("dev-m");
    expect(roster.json.members[0].role).toBe("owner");
    const inv2 = await call(doInstance, "/invite", { caller: "device", device: "dev-m", body: {} });
    expect(inv2.status).toBe(200);
  });

  test("the owner can remove a member", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    const inv = await call(doInstance, "/invite", { caller: "admin", device: "dev-owner", body: { autoApprove: true } });
    await call(doInstance, "/join", { caller: "device", device: "dev-m", body: { code: inv.json.code } });
    await call(doInstance, "/approve", { caller: "admin", device: "operator", body: { deviceId: "dev-m" } });
    expect((await call(doInstance, "/remove", { caller: "admin", device: "dev-owner", body: { deviceId: "dev-m" } })).status).toBe(200);
    const me = await call(doInstance, "/me", { caller: "device", device: "dev-m", method: "GET" });
    expect(me.json.status).toBe("none");
  });

  test("a fleet with no members left is gone", async () => {
    const { doInstance, state } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    const left = await call(doInstance, "/remove", { caller: "admin", device: "dev-owner", body: { deviceId: "dev-owner" } });
    expect(left.status).toBe(200);
    expect(state.data.get("members")).toBeUndefined();
    // The name is free again.
    const again = await call(doInstance, "/create", { caller: "admin", device: "dev-second" });
    expect(again.status).toBe(200);
  });

  test("revoke invalidates every outstanding invite", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    const inv = await call(doInstance, "/invite", { caller: "admin", device: "dev-owner", body: {} });
    const revoked = await call(doInstance, "/revoke", { caller: "admin", device: "dev-owner", body: {} });
    expect(revoked.json.revoked).toBe(1);
    expect((await call(doInstance, "/join", { caller: "device", device: "dev-z", body: { code: inv.json.code } })).status).toBe(403);
  });
});

describe("deleting a fleet", () => {
  test("the owner may delete it, and the name is free again", async () => {
    const { doInstance, state } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    const inv = await call(doInstance, "/invite", { caller: "device", device: "dev-owner", body: {} });
    expect(inv.status).toBe(200);

    const stranger = await call(doInstance, "/delete", { caller: "device", device: "dev-stranger" });
    expect(stranger.status).toBe(403);

    const deleted = await call(doInstance, "/delete", { caller: "device", device: "dev-owner" });
    expect(deleted.status).toBe(200);
    expect(state.data.get("members")).toBeUndefined();
    expect(state.data.get("invites")).toBeUndefined();

    // The name can be used again.
    const again = await call(doInstance, "/create", { caller: "admin", device: "operator" });
    expect(again.status).toBe(200);
  });
});

describe("a fleet nobody is running", () => {
  test("a proven device may clean it up once it has gone quiet", async () => {
    const { doInstance, state } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    // While the fleet is alive, nobody may delete it but its owner.
    const tooEarly = await call(doInstance, "/delete", { caller: "device", device: "dev-stranger" });
    expect(tooEarly.status).toBe(403);

    // Once it has been quiet for a day, it is not being run by anybody.
    state.data.set("lastActivity", Date.now() - OWNER_SILENCE_MS - 1000);
    const cleaned = await call(doInstance, "/delete", { caller: "device", device: "dev-stranger" });
    expect(cleaned.status).toBe(200);
    expect(state.data.get("members")).toBeUndefined();
  });

  test("the owner may always delete its own fleet", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    const deleted = await call(doInstance, "/delete", { caller: "device", device: "dev-owner" });
    expect(deleted.status).toBe(200);
  });
});

describe("caps", () => {
  test("the member cap refuses further admissions", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    // Fill to MAX_MEMBERS - 1 extra, each one admitted by the operator.
    for (let i = 0; i < MAX_MEMBERS - 1; i++) {
      const inv = await call(doInstance, "/invite", { caller: "admin", device: "dev-owner", body: {} });
      const joined = await call(doInstance, "/join", { caller: "device", device: "dev-" + i, body: { code: inv.json.code } });
      expect(joined.json.status).toBe("pending");
      await call(doInstance, "/approve", { caller: "admin", device: "operator", body: { deviceId: "dev-" + i } });
    }
    const roster = await call(doInstance, "/members", { caller: "admin", device: "dev-owner", method: "GET" });
    expect(roster.json.members).toHaveLength(MAX_MEMBERS);
    const over = await call(doInstance, "/invite", { caller: "admin", device: "dev-owner", body: {} });
    const refused = await call(doInstance, "/join", { caller: "device", device: "dev-overflow", body: { code: over.json.code } });
    expect(refused.status).toBe(409);
  });
});

describe("bootstrap", () => {
  test("the first member with no state becomes primary", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    const boot = await call(doInstance, "/bootstrap", { caller: "device", device: "dev-owner", body: {} });
    expect(boot.json.role).toBe("primary");
    expect(boot.json.epoch).toBe(1);
  });

  test("a second member cannot also become primary while the lease is held", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    const inv = await call(doInstance, "/invite", { caller: "admin", device: "dev-owner", body: { autoApprove: true } });
    await call(doInstance, "/join", { caller: "device", device: "dev-two", body: { code: inv.json.code } });
    await call(doInstance, "/approve", { caller: "admin", device: "operator", body: { deviceId: "dev-two" } });
    const first = await call(doInstance, "/bootstrap", { caller: "device", device: "dev-owner", body: {} });
    const second = await call(doInstance, "/bootstrap", { caller: "device", device: "dev-two", body: {} });
    expect(first.json.role).toBe("primary");
    expect(second.json.role).toBe("replica");
    expect(second.json.reason).toBe("lease-held");
  });

  test("a non-member cannot bootstrap", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    const boot = await call(doInstance, "/bootstrap", { caller: "device", device: "dev-intruder", body: {} });
    expect(boot.status).toBe(403);
  });
});

describe("catch up before promoting", () => {
  test("a member that takes over must apply the state it replaces", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-one");
    const first = await call(doInstance, "/bootstrap", { caller: "device", device: "dev-one" });
    expect(first.json.role).toBe("primary");
    await call(doInstance, "/head/advance", {
      caller: "device",
      device: "dev-one",
      body: { expectedSeq: 0, manifestKey: "m/1", manifestHash: "h1" },
    });

    // A second member joins, so there is somebody to take over.
    const invite = await call(doInstance, "/invite", { caller: "admin", device: "dev-one", body: {} });
    await call(doInstance, "/join", { caller: "device", device: "dev-two", body: { code: invite.json.code } });
    await call(doInstance, "/approve", { caller: "admin", device: "operator", body: { deviceId: "dev-two" } });

    // The primary lets go. The member that is left has not applied the state,
    // so it is not given the lease: it would block the one that can publish.
    await call(doInstance, "/lease/release", { caller: "device", device: "dev-one" });
    const notYet = await call(doInstance, "/bootstrap", { caller: "device", device: "dev-two" });
    expect(notYet.json.role).toBe("replica");
    expect(notYet.json.reason).toBe("not-caught-up");
    expect(notYet.json.catchUpTo).toBe(1);

    // It may not publish before it has applied what it is replacing.
    const tooEarly = await call(doInstance, "/head/advance", {
      caller: "device",
      device: "dev-two",
      body: { expectedSeq: 1, manifestKey: "m/2", manifestHash: "h2" },
    });
    expect(tooEarly.status).toBe(409);

    // It catches up, and only then takes the lease.
    const applied = await call(doInstance, "/applied", { caller: "device", device: "dev-two", body: { seq: 1 } });
    expect(applied.status).toBe(200);
    const takeover = await call(doInstance, "/bootstrap", { caller: "device", device: "dev-two" });
    expect(takeover.json.role).toBe("primary");
    const ok = await call(doInstance, "/head/advance", {
      caller: "device",
      device: "dev-two",
      body: { expectedSeq: 1, manifestKey: "m/2", manifestHash: "h2" },
    });
    expect(ok.status).toBe(200);
  });
});

describe("replicas racing for a free lease", () => {
  async function three() {
    const made = makeDo();
    const d = made.doInstance;
    await makeFleet(d, "dev-one");
    await call(d, "/bootstrap", { caller: "device", device: "dev-one" });
    await call(d, "/head/advance", { caller: "device", device: "dev-one", body: { expectedSeq: 0, manifestKey: "m/1", manifestHash: "h1" } });
    for (const dev of ["dev-two", "dev-three"]) {
      const invite = await call(d, "/invite", { caller: "admin", device: "dev-one", body: {} });
      await call(d, "/join", { caller: "device", device: dev, body: { code: invite.json.code } });
      await call(d, "/approve", { caller: "admin", device: "operator", body: { deviceId: dev } });
    }
    await call(d, "/lease/release", { caller: "device", device: "dev-one" });
    return made;
  }
  const ask = (d: FleetDO, dev: string) => call(d, "/bootstrap", { caller: "device", device: dev });

  test("the first to ask is told to catch up, and the others to wait", async () => {
    const { doInstance } = await three();
    const first = await ask(doInstance, "dev-two");
    expect(first.json.reason).toBe("not-caught-up");
    const second = await ask(doInstance, "dev-three");
    expect(second.json.reason).toBe("claimed");
    expect(second.json.holder).toBe("dev-two");
    expect(second.json.retryAfterMs).toBeGreaterThan(0);
    expect(second.json.retryAfterMs).toBeLessThanOrEqual(30_000);
    // The one that holds the claim is asked the same again: it goes on.
    expect((await ask(doInstance, "dev-two")).json.reason).toBe("not-caught-up");
  });

  test("the claim is only about who writes a work tree: who gets the lease is as it was", async () => {
    const { doInstance } = await three();
    await ask(doInstance, "dev-two");
    // The member that is current takes the lease whatever the claim.
    const old = await ask(doInstance, "dev-one");
    expect(old.json.role).toBe("primary");
    // And with the lease held, nobody is asked to catch up for it.
    expect((await ask(doInstance, "dev-three")).json.reason).toBe("lease-held");
  });

  test("a claimant that caught up takes the lease, and the claim goes with it", async () => {
    const { doInstance, state } = await three();
    await ask(doInstance, "dev-two");
    await call(doInstance, "/applied", { caller: "device", device: "dev-two", body: { seq: 1 } });
    expect((await ask(doInstance, "dev-two")).json.role).toBe("primary");
    expect(state.data.has("claim")).toBe(false);
  });

  test("a holder that is alive and never catches up cannot hold the claim for ever, whatever asks it makes", async () => {
    const { doInstance, state } = await three();
    // dev-two asks every round, as a client that ignores the answer does, and never applies.
    for (let i = 0; i < 40; i++) expect(["not-caught-up", "claimed"]).toContain((await ask(doInstance, "dev-two")).json.reason);
    const claim = state.data.get("claim") as { since: number; until: number };
    // The claim's total life is bounded however often it was renewed.
    expect(claim.until).toBeLessThanOrEqual(claim.since + 60_000);

    // A minute in, it is still asking: the claim lapses, and it may not take it again at once.
    state.data.set("claim", { ...claim, since: Date.now() - 61_000, until: Date.now() + 25_000 });
    const lapsed = await ask(doInstance, "dev-two");
    expect(lapsed.json.reason).toBe("claimed");
    expect(lapsed.json.holder).toBe("dev-two");
    expect(lapsed.json.retryAfterMs).toBeGreaterThan(0);
    expect((await ask(doInstance, "dev-two")).json.reason).toBe("claimed");

    // The next replica to ask is given it, and can catch up and take the lease.
    expect((await ask(doInstance, "dev-three")).json.reason).toBe("not-caught-up");
    expect((await ask(doInstance, "dev-two")).json.reason).toBe("claimed");
    await call(doInstance, "/applied", { caller: "device", device: "dev-three", body: { seq: 1 } });
    expect((await ask(doInstance, "dev-three")).json.role).toBe("primary");
  });

  test("the one that was barred may claim again once its window has gone", async () => {
    const { doInstance, state } = await three();
    await ask(doInstance, "dev-two");
    const claim = state.data.get("claim") as { since: number; until: number };
    state.data.set("claim", { ...claim, since: Date.now() - 61_000, until: Date.now() + 25_000 });
    expect((await ask(doInstance, "dev-two")).json.reason).toBe("claimed");
    const barred = state.data.get("claim") as { barred: { device: string; until: number } };
    state.data.set("claim", { ...barred, barred: { ...barred.barred, until: Date.now() - 1 } });
    expect((await ask(doInstance, "dev-two")).json.reason).toBe("not-caught-up");
  });

  test("a claim that lapses (its holder died half way) lets the next ask take over the catching up", async () => {
    const { doInstance, state } = await three();
    await ask(doInstance, "dev-two");
    const claim = state.data.get("claim") as { until: number };
    state.data.set("claim", { ...claim, until: Date.now() - 1 });
    expect((await ask(doInstance, "dev-three")).json.reason).toBe("not-caught-up");
    expect((await ask(doInstance, "dev-two")).json.reason).toBe("claimed");
  });
});

describe("head advance", () => {
  test("the lease holder advances the head, and a stale sequence is refused", async () => {
    const { doInstance, bucket } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    await call(doInstance, "/bootstrap", { caller: "device", device: "dev-owner", body: {} });
    const first = await call(doInstance, "/head/advance", { caller: "device", device: "dev-owner", body: { expectedSeq: 0, manifestKey: "m1", manifestHash: "h1" } });
    expect(first.status).toBe(200);
    expect(first.json.head.seq).toBe(1);
    const stale = await call(doInstance, "/head/advance", { caller: "device", device: "dev-owner", body: { expectedSeq: 0, manifestKey: "m2", manifestHash: "h2" } });
    expect(stale.status).toBe(409);
    expect(bucket.objects.get("fleets/acme/head")!.body).toContain("m1");
  });

  test("a member without the lease cannot advance the head", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    const inv = await call(doInstance, "/invite", { caller: "admin", device: "dev-owner", body: { autoApprove: true } });
    await call(doInstance, "/join", { caller: "device", device: "dev-two", body: { code: inv.json.code } });
    await call(doInstance, "/approve", { caller: "admin", device: "operator", body: { deviceId: "dev-two" } });
    await call(doInstance, "/bootstrap", { caller: "device", device: "dev-owner", body: {} });
    const res = await call(doInstance, "/head/advance", { caller: "device", device: "dev-two", body: { expectedSeq: 0, manifestKey: "evil", manifestHash: "evil" } });
    expect(res.status).toBe(409);
  });

  test("the head survives losing the object's storage, because it lives in R2", async () => {
    const { doInstance, state, bucket } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    await call(doInstance, "/bootstrap", { caller: "device", device: "dev-owner", body: {} });
    await call(doInstance, "/head/advance", { caller: "device", device: "dev-owner", body: { expectedSeq: 0, manifestKey: "m1", manifestHash: "h1" } });
    // simulate the object losing everything it had locally
    state.data.clear();
    const created = await call(doInstance, "/create", { caller: "admin", device: "operator" });
    expect(created.status).toBe(200); // membership is gone, as expected
    const head = JSON.parse(bucket.objects.get("fleets/acme/head")!.body);
    expect(head.seq).toBe(1);
    expect(head.manifestKey).toBe("m1");
  });
});

describe("what a member far behind needs is kept", () => {
  // The member publishes a whole tree every 32 snapshots (FULL_PACK_WINDOW in
  // the CLI, which has a test that RECENT_SNAPSHOTS is at least twice that) and deltas in between, and a member that fell behind starts from
  // the newest whole tree. So the gateway has to keep the newest checkpoint and
  // every delta after it, at any head.
  const CHECKPOINT_EVERY = 32;

  test("the retention covers a whole checkpoint interval plus the checkpoint before it", () => {
    expect(RECENT_SNAPSHOTS).toBeGreaterThanOrEqual(2 * CHECKPOINT_EVERY);
  });

  test("at any head, the newest checkpoint and the deltas after it are still stored", async () => {
    const { doInstance, bucket } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    await call(doInstance, "/bootstrap", { caller: "device", device: "dev-owner", body: {} });
    const total = RECENT_SNAPSHOTS + CHECKPOINT_EVERY + 5;
    for (let seq = 1; seq <= total; seq++) {
      bucket.objects.set("fleets/acme/manifests/m" + seq, { body: "{}", etag: "x" });
      bucket.objects.set("fleets/acme/packs/p" + seq, { body: "pack", etag: "x" });
      const res = await call(doInstance, "/head/advance", {
        caller: "device",
        device: "dev-owner",
        body: { expectedSeq: seq - 1, manifestKey: "fleets/acme/manifests/m" + seq, manifestHash: "h" + seq, packKey: "fleets/acme/packs/p" + seq },
      });
      expect(res.status).toBe(200);
      await call(doInstance, "/applied", { caller: "device", device: "dev-owner", body: { seq } });

      const checkpoint = seq - (seq % CHECKPOINT_EVERY);
      if (checkpoint >= 1) {
        for (let kept = checkpoint; kept <= seq; kept++) {
          expect(bucket.objects.has("fleets/acme/manifests/m" + kept)).toBe(true);
          expect(bucket.objects.has("fleets/acme/packs/p" + kept)).toBe(true);
        }
      }
    }
    // Old snapshots do go: the store is bounded.
    expect(bucket.objects.has("fleets/acme/packs/p1")).toBe(false);
  });
});

describe("a snapshot's other packs", () => {
  async function advance(doInstance: FleetDO, seq: number, extra?: string[]) {
    return call(doInstance, "/head/advance", {
      caller: "device",
      device: "dev-owner",
      body: {
        expectedSeq: seq - 1,
        manifestKey: "fleets/acme/manifests/m" + seq,
        manifestHash: "h" + seq,
        packKey: "fleets/acme/packs/p" + seq,
        ...(extra ? { extraKeys: extra } : {}),
      },
    });
  }

  test("the change pack beside a checkpoint is let go with its snapshot, and only this fleet's own can be named", async () => {
    const { doInstance, bucket } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    await call(doInstance, "/bootstrap", { caller: "device", device: "dev-owner", body: {} });
    const mine = "fleets/acme/packs/" + "a".repeat(16);
    const theirs = "fleets/other/packs/" + "b".repeat(16);
    bucket.objects.set(mine, { body: "delta", etag: "x" });
    bucket.objects.set(theirs, { body: "not ours", etag: "x" });
    for (let seq = 1; seq <= RECENT_SNAPSHOTS + 3; seq++) {
      bucket.objects.set("fleets/acme/manifests/m" + seq, { body: "{}", etag: "x" });
      bucket.objects.set("fleets/acme/packs/p" + seq, { body: "pack", etag: "x" });
      const res = await advance(doInstance, seq, seq === 1 ? [mine, theirs, 42 as unknown as string] : undefined);
      expect(res.status).toBe(200);
      await call(doInstance, "/applied", { caller: "device", device: "dev-owner", body: { seq } });
    }
    expect(bucket.objects.has(mine)).toBe(false);
    expect(bucket.objects.has(theirs)).toBe(true);
    expect(bucket.objects.has("fleets/acme/packs/p1")).toBe(false);
  });

  test("an older client names no extra packs and everything works as it did", async () => {
    const { doInstance, bucket } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    await call(doInstance, "/bootstrap", { caller: "device", device: "dev-owner", body: {} });
    const res = await advance(doInstance, 1);
    expect(res.status).toBe(200);
    expect(res.json.head.seq).toBe(1);
    void bucket;
  });
});

describe("what a replica reports and what the index says", () => {
  async function fleetWithTwo() {
    const made = makeDo();
    await makeFleet(made.doInstance, "dev-owner");
    const inv = await call(made.doInstance, "/invite", { caller: "admin", device: "dev-owner", body: { autoApprove: true } });
    await call(made.doInstance, "/join", { caller: "device", device: "dev-two", body: { code: inv.json.code } });
    await call(made.doInstance, "/approve", { caller: "admin", device: "operator", body: { deviceId: "dev-two" } });
    await call(made.doInstance, "/bootstrap", { caller: "device", device: "dev-owner", body: {} });
    return made;
  }
  const advance = (d: FleetDO, seq: number, meta?: Record<string, unknown>) =>
    call(d, "/head/advance", {
      caller: "device",
      device: "dev-owner",
      body: { expectedSeq: seq - 1, manifestKey: "m" + seq, manifestHash: "h" + seq, ...(meta ? { meta } : {}) },
    });

  test("how far a replica has fetched is recorded apart from how far it has applied", async () => {
    const { doInstance } = await fleetWithTwo();
    await advance(doInstance, 1);
    // An older client says only what it applied.
    const old = await call(doInstance, "/applied", { caller: "device", device: "dev-two", body: { seq: 1 } });
    expect(old.json).toEqual({ ok: true, applied: 1 });
    // A replica that fetches ahead says both. Applied still gates the lease.
    const fetched = await call(doInstance, "/applied", { caller: "device", device: "dev-two", body: { seq: 1, fetched: 5 } });
    expect(fetched.json).toEqual({ ok: true, applied: 1, fetched: 5 });
    // It never goes backwards.
    expect((await call(doInstance, "/applied", { caller: "device", device: "dev-two", body: { seq: 1, fetched: 3 } })).json.fetched).toBe(5);
    const keys = await call(doInstance, "/keys", { caller: "device", device: "dev-owner", method: "GET" });
    const two = (keys.json.members as Array<{ deviceId: string; applied: number; fetched?: number }>).find((m) => m.deviceId === "dev-two")!;
    expect(two.applied).toBe(1);
    expect(two.fetched).toBe(5);
    const owner = (keys.json.members as Array<{ deviceId: string; fetched?: number }>).find((m) => m.deviceId === "dev-owner")!;
    expect(owner.fetched).toBeUndefined();
  });

  test("the index lists the snapshots from a sequence on, with what a member needs to pick a route", async () => {
    const { doInstance } = await fleetWithTwo();
    await advance(doInstance, 1, { full: true, packBytes: 5000 });
    await call(doInstance, "/applied", { caller: "device", device: "dev-owner", body: { seq: 1 } });
    await advance(doInstance, 2, { full: false, packBytes: 40 });
    await call(doInstance, "/applied", { caller: "device", device: "dev-owner", body: { seq: 2 } });
    await advance(doInstance, 3, { full: true, packBytes: 5100, deltaBytes: 45 });
    // An older publisher sends no sizes at all.
    await call(doInstance, "/applied", { caller: "device", device: "dev-owner", body: { seq: 3 } });
    await advance(doInstance, 4, { junk: "x", packBytes: -4, deltaBytes: "big" });

    const all = await call(doInstance, "/index", { caller: "device", device: "dev-two", method: "GET" });
    expect(all.status).toBe(200);
    expect(all.json.entries).toEqual([
      { seq: 1, manifestKey: "m1", full: true, packBytes: 5000 },
      { seq: 2, manifestKey: "m2", full: false, packBytes: 40 },
      { seq: 3, manifestKey: "m3", full: true, packBytes: 5100, deltaBytes: 45 },
      { seq: 4, manifestKey: "m4", full: false },
    ]);
    // Asked from a sequence on, it lists only what is newer.
    const later = await call(doInstance, "/index?after=2", { caller: "device", device: "dev-two", method: "GET" });
    expect((later.json.entries as Array<{ seq: number }>).map((e) => e.seq)).toEqual([3, 4]);
  });

  test("only a member may read the index, and it is bounded like the snapshots it describes", async () => {
    const { doInstance } = await fleetWithTwo();
    const stranger = await call(doInstance, "/index", { caller: "device", device: "dev-nobody", method: "GET" });
    expect(stranger.status).toBe(403);
    for (let seq = 1; seq <= RECENT_SNAPSHOTS + 4; seq++) {
      expect((await advance(doInstance, seq, { full: false })).status).toBe(200);
      await call(doInstance, "/applied", { caller: "device", device: "dev-owner", body: { seq } });
    }
    const listed = (await call(doInstance, "/index", { caller: "device", device: "dev-two", method: "GET" })).json.entries as Array<{ seq: number }>;
    expect(listed.length).toBe(RECENT_SNAPSHOTS);
    expect(listed[0]!.seq).toBe(5);
    expect(listed[listed.length - 1]!.seq).toBe(RECENT_SNAPSHOTS + 4);
  });
});

describe("the publisher is applied to what it publishes", () => {
  test("a publish needs no report afterwards: the next one is not refused as 'catch up first'", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    await call(doInstance, "/bootstrap", { caller: "device", device: "dev-owner", body: {} });
    for (let seq = 1; seq <= 3; seq++) {
      const res = await call(doInstance, "/head/advance", {
        caller: "device",
        device: "dev-owner",
        body: { expectedSeq: seq - 1, manifestKey: "m" + seq, manifestHash: "h" + seq },
      });
      expect(res.status).toBe(200); // no /applied call in between: the one a client sends may be lost
    }
  });
});

describe("a fleet the registry has forgotten", () => {
  test("says who it is again when it is woken up", async () => {
    const registry = fakeRegistry();
    const state = fakeState();
    const env = { BUCKET: fakeBucket(), REGISTRY: registry } as unknown as never;
    const wake = () =>
      new FleetDO({ storage: state.storage, blockConcurrencyWhile: state.blockConcurrencyWhile } as unknown as DurableObjectState, env);

    const first = wake();
    await call(first, "/create", { caller: "admin", device: "operator" });
    expect([...registry.fleets]).toContain("acme");

    // A fleet made before the registry existed, or one whose entry was lost,
    // is invisible to the operator: the list of fleets lives there.
    registry.fleets.clear();

    const second = wake();
    await call(second, "/members", { caller: "admin", device: "operator" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect([...registry.fleets]).toContain("acme");
  });

  test("a fleet that was deleted does not come back", async () => {
    const registry = fakeRegistry();
    const state = fakeState();
    const env = { BUCKET: fakeBucket(), REGISTRY: registry } as unknown as never;
    const wake = () =>
      new FleetDO({ storage: state.storage, blockConcurrencyWhile: state.blockConcurrencyWhile } as unknown as DurableObjectState, env);
    const first = wake();
    await call(first, "/create", { caller: "admin", device: "operator" });
    await call(first, "/delete", { caller: "admin", device: "operator", method: "POST" });
    expect([...registry.fleets]).not.toContain("acme");
    const second = wake();
    await call(second, "/members", { caller: "admin", device: "operator" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect([...registry.fleets]).not.toContain("acme");
  });
});

describe("the name a space gives for itself", () => {
  test("is kept in step on every round, so a stale one is corrected", async () => {
    const { doInstance, state } = makeDo();
    await makeFleet(doInstance, "owner-1");
    // The name the space gives when it takes its place.
    await call(doInstance, "/bootstrap", { caller: "device", device: "owner-1", body: { label: "renamed" } });
    const members = state.data.get("members") as Record<string, { label?: string }>;
    expect(members["owner-1"]?.label).toBe("renamed");
    // And a later round that says nothing does not wipe it.
    await call(doInstance, "/bootstrap", { caller: "device", device: "owner-1", body: {} });
    expect(members["owner-1"]?.label).toBe("renamed");
  });
});

describe("two spaces of a fleet cannot share a name", () => {
  test("the second one to ask is refused, and told what to do", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "owner-1");
    // The first space is already in, under a name.
    const members = (await call(doInstance, "/members", { caller: "admin", device: "operator" })).json.members as Array<{ deviceId: string; label?: string }>;
    expect(members.length).toBe(1);
    expect(members[0]!.label).toBeUndefined();

    const first = await call(doInstance, "/bootstrap", { caller: "device", device: "owner-1", body: { label: "alpha" } });
    expect(first.status).toBe(200);

    // Another space with the same name cannot join.
    const invite = await call(doInstance, "/invite", { caller: "admin", device: "operator", body: {} });
    const joined = await call(doInstance, "/join", { caller: "device", device: "member-2", body: { code: invite.json.code, label: "Alpha" } });
    expect(joined.status).toBe(409);
    expect(String(joined.json.error)).toContain("already in this fleet");
    expect(String(joined.json.hint)).toContain("--name");

    // A name nobody uses goes through.
    const invite2 = await call(doInstance, "/invite", { caller: "admin", device: "operator", body: {} });
    const ok = await call(doInstance, "/join", { caller: "device", device: "member-2", body: { code: invite2.json.code, label: "beta" } });
    expect(ok.status).toBe(200);
  });

  test("a waiting request holds its name too", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "owner-1");
    const invite = await call(doInstance, "/invite", { caller: "admin", device: "operator", body: {} });
    await call(doInstance, "/join", { caller: "device", device: "waiting-1", body: { code: invite.json.code, label: "gamma" } });
    const invite2 = await call(doInstance, "/invite", { caller: "admin", device: "operator", body: {} });
    const clash = await call(doInstance, "/join", { caller: "device", device: "waiting-2", body: { code: invite2.json.code, label: "gamma" } });
    expect(clash.status).toBe(409);
    expect(String(clash.json.error)).toContain("already waiting");
  });

  test("a name another space uses is not taken on when a space takes its place", async () => {
    const { doInstance, state } = makeDo();
    await makeFleet(doInstance, "owner-1");
    await call(doInstance, "/bootstrap", { caller: "device", device: "owner-1", body: { label: "alpha" } });
    const invite = await call(doInstance, "/invite", { caller: "admin", device: "operator", body: {} });
    await call(doInstance, "/join", { caller: "device", device: "member-2", body: { code: invite.json.code, label: "beta" } });
    await call(doInstance, "/approve", { caller: "admin", device: "operator", body: { deviceId: "member-2" } });
    // It tries to take the other one's name: it keeps its own instead.
    await call(doInstance, "/bootstrap", { caller: "device", device: "member-2", body: { label: "alpha" } });
    const members = state.data.get("members") as Record<string, { label?: string }>;
    expect(members["member-2"]?.label).toBe("beta");
  });
});

// ---- the fleet tells the members that listen ---------------------------------
//
// A member's agent holds a socket open instead of asking every second. The object
// pushes what happened; a paused fleet is answered without being woken at all.

/** A socket as the runtime hands it to the object: what it was sent, and whether it was closed. */
function fakeSocket(deviceId: string) {
  const sock = {
    deviceId,
    sent: [] as string[],
    closed: null as null | { code: number; reason: string },
    send(text: string) {
      sock.sent.push(text);
    },
    close(code: number, reason: string) {
      sock.closed = { code, reason };
    },
    deserializeAttachment() {
      return { deviceId };
    },
    events() {
      return sock.sent.map((t) => JSON.parse(t) as Record<string, any>);
    },
  };
  return sock;
}

function makeListeningDo(sockets: ReturnType<typeof fakeSocket>[]) {
  const bucket = fakeBucket();
  const state = fakeState();
  const alarms: number[] = [];
  const storage = { ...state.storage, async setAlarm(at: number) { alarms.push(at); } };
  const real = {
    storage,
    blockConcurrencyWhile: state.blockConcurrencyWhile,
    getWebSockets: (tag?: string) => (tag ? sockets.filter((s) => s.deviceId === tag) : sockets),
  } as unknown as DurableObjectState;
  return { doInstance: new FleetDO(real, { BUCKET: bucket } as never), state, bucket, alarms };
}

async function twoMembers(doInstance: FleetDO) {
  await makeFleet(doInstance, "dev-owner");
  const inv = await call(doInstance, "/invite", { caller: "admin", device: "dev-owner", body: { autoApprove: true } });
  await call(doInstance, "/join", { caller: "device", device: "dev-two", body: { code: inv.json.code } });
  await call(doInstance, "/approve", { caller: "admin", device: "operator", body: { deviceId: "dev-two" } });
}

describe("what the fleet pushes to the members that listen", () => {
  test("pausing and resuming are announced once each", async () => {
    const owner = fakeSocket("dev-owner");
    const two = fakeSocket("dev-two");
    const { doInstance } = makeListeningDo([owner, two]);
    await makeFleet(doInstance, "dev-owner");
    await call(doInstance, "/meta", { caller: "admin", device: "operator", body: { disabled: true } });
    // Saying it again changes nothing, so nobody is woken for it.
    await call(doInstance, "/meta", { caller: "admin", device: "operator", body: { disabled: true } });
    await call(doInstance, "/meta", { caller: "admin", device: "operator", body: { disabled: false } });
    for (const s of [owner, two]) expect(s.events()).toEqual([{ type: "paused" }, { type: "resumed" }]);
  });

  test("renaming a fleet is not a pause", async () => {
    const owner = fakeSocket("dev-owner");
    const { doInstance } = makeListeningDo([owner]);
    await makeFleet(doInstance, "dev-owner");
    await call(doInstance, "/meta", { caller: "admin", device: "operator", body: { label: "Acme" } });
    expect(owner.events()).toEqual([]);
  });

  test("a paused fleet says how long to wait, in the body and in the header", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    await call(doInstance, "/meta", { caller: "admin", device: "operator", body: { disabled: true } });
    const headers = new Headers({ "content-type": "application/json", "x-prime-caller": "device", "x-prime-device": "dev-owner", "x-prime-fleet": "acme" });
    const res = await doInstance.fetch(new Request("https://fleet/bootstrap", { method: "POST", headers, body: "{}" }));
    expect(res.status).toBe(409);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await res.json()).toEqual({ error: "the fleet is paused", paused: true, retryAfterMs: 60000 });
  });

  test("a new head is pushed to the others and not to the one that published it", async () => {
    const owner = fakeSocket("dev-owner");
    const two = fakeSocket("dev-two");
    const { doInstance } = makeListeningDo([owner, two]);
    await makeFleet(doInstance, "dev-owner");
    await call(doInstance, "/bootstrap", { caller: "device", device: "dev-owner", body: {} });
    await call(doInstance, "/head/advance", { caller: "device", device: "dev-owner", body: { expectedSeq: 0, manifestKey: "m1", manifestHash: "h1" } });
    // The manifest comes with the news, so a member that is told need not ask for it.
    expect(two.events()).toEqual([{ type: "head", seq: 1, manifestKey: "m1" }]);
    expect(owner.events()).toEqual([]);
  });

  test("a lease that is given up or vacated tells the members to ask for it", async () => {
    const owner = fakeSocket("dev-owner");
    const two = fakeSocket("dev-two");
    const { doInstance } = makeListeningDo([owner, two]);
    await makeFleet(doInstance, "dev-owner");
    await call(doInstance, "/bootstrap", { caller: "device", device: "dev-owner", body: {} });
    await call(doInstance, "/lease/release", { caller: "device", device: "dev-owner", body: {} });
    await call(doInstance, "/bootstrap", { caller: "device", device: "dev-owner", body: {} });
    await call(doInstance, "/vacate", { caller: "admin", device: "operator", body: { deviceId: "dev-owner" } });
    expect(two.events()).toEqual([{ type: "lease-free" }, { type: "lease-free" }]);
  });

  test("a removed member is hung up on, and the others are not", async () => {
    const owner = fakeSocket("dev-owner");
    const two = fakeSocket("dev-two");
    const { doInstance } = makeListeningDo([owner, two]);
    await twoMembers(doInstance);
    await call(doInstance, "/remove", { caller: "admin", device: "operator", body: { deviceId: "dev-two" } });
    expect(two.events()).toEqual([{ type: "bye", reason: "removed" }]);
    expect(two.closed?.code).toBe(1000);
    expect(owner.closed).toBeNull();
  });

  test("deleting a fleet hangs up on everyone, and the name is not paused when it comes back", async () => {
    const owner = fakeSocket("dev-owner");
    const { doInstance } = makeListeningDo([owner]);
    await makeFleet(doInstance, "dev-owner");
    await call(doInstance, "/meta", { caller: "admin", device: "operator", body: { disabled: true } });
    await call(doInstance, "/delete", { caller: "admin", device: "operator", body: {} });
    expect(owner.closed).not.toBeNull();
    await makeFleet(doInstance, "dev-owner");
    const boot = await call(doInstance, "/bootstrap", { caller: "device", device: "dev-owner", body: {} });
    expect(boot.status).toBe(200);
    expect(boot.json.role).toBe("primary");
  });

  test("a listener is asked to be a websocket, and a non-member is refused", async () => {
    const { doInstance } = makeListeningDo([]);
    await makeFleet(doInstance, "dev-owner");
    const plain = await doInstance.fetch(
      new Request("https://fleet/events", { method: "GET", headers: { "x-prime-caller": "device", "x-prime-device": "dev-owner", "x-prime-fleet": "acme" } }),
    );
    expect(plain.status).toBe(426);
    const stranger = await doInstance.fetch(
      new Request("https://fleet/events", { method: "GET", headers: { upgrade: "websocket", "x-prime-caller": "device", "x-prime-device": "dev-stranger", "x-prime-fleet": "acme" } }),
    );
    expect(stranger.status).toBe(403);
  });
});

describe("the alarm that ends a lease", () => {
  test("it is set for the moment the lease would lapse, and only when someone listens", async () => {
    const silent = makeListeningDo([]);
    await makeFleet(silent.doInstance, "dev-owner");
    await call(silent.doInstance, "/bootstrap", { caller: "device", device: "dev-owner", body: {} });
    expect(silent.alarms).toEqual([]);

    const owner = fakeSocket("dev-owner");
    const heard = makeListeningDo([owner]);
    await makeFleet(heard.doInstance, "dev-owner");
    const before = Date.now();
    await call(heard.doInstance, "/bootstrap", { caller: "device", device: "dev-owner", body: {} });
    expect(heard.alarms.length).toBe(1);
    // The lease is forty-five seconds; the alarm waits a moment past it.
    expect(heard.alarms[0]! - before).toBeGreaterThan(45_000);
    expect(heard.alarms[0]! - before).toBeLessThan(46_500);
  });

  test("a lease that really ended is announced, one that was renewed is not", async () => {
    const two = fakeSocket("dev-two");
    const { doInstance, state, alarms } = makeListeningDo([two]);
    await makeFleet(doInstance, "dev-owner");
    await call(doInstance, "/bootstrap", { caller: "device", device: "dev-owner", body: {} });
    // Renewed meanwhile: the alarm that fires is the old one, and it only moves on.
    const live = state.data.get("lease") as { expiresAt: number };
    await doInstance.alarm();
    expect(two.events()).toEqual([]);
    expect(alarms.length).toBeGreaterThan(1);
    // Ended: it is announced.
    state.data.set("lease", { ...live, expiresAt: Date.now() - 60_000 });
    await doInstance.alarm();
    expect(two.events()).toEqual([{ type: "lease-free" }]);
  });

  test("a paused fleet announces nothing: nobody is asking for the place", async () => {
    const two = fakeSocket("dev-two");
    const { doInstance, state } = makeListeningDo([two]);
    await makeFleet(doInstance, "dev-owner");
    await call(doInstance, "/bootstrap", { caller: "device", device: "dev-owner", body: {} });
    await call(doInstance, "/meta", { caller: "admin", device: "operator", body: { disabled: true } });
    const live = state.data.get("lease") as { expiresAt: number };
    state.data.set("lease", { ...live, expiresAt: Date.now() - 60_000 });
    await doInstance.alarm();
    expect(two.events()).toEqual([{ type: "paused" }]);
  });
});

describe("the Worker answers for a paused fleet", () => {
  function route(opts: { paused: boolean; method?: string; path: string; upgrade?: boolean; bearer?: string }) {
    const fetched: { url: string; headers: Headers }[] = [];
    const stub = {
      async fetch(input: Request | string) {
        const req = typeof input === "string" ? new Request(input) : input;
        fetched.push({ url: req.url, headers: req.headers });
        return Response.json({ ok: true });
      },
    };
    const env = { FLEET: { idFromName: (n: string) => n, get: () => stub } } as never;
    const headers = new Headers({ "x-prime-device": "dev-a", "content-type": "application/json" });
    if (opts.upgrade) headers.set("upgrade", "websocket");
    if (opts.bearer) headers.set("authorization", "Bearer " + opts.bearer);
    const method = opts.method ?? "POST";
    const url = new URL("https://gateway" + opts.path);
    const request = new Request(url, { method, headers, body: method === "GET" ? undefined : "{}" });
    const answer = handleFleetRoutes({
      request,
      env,
      url,
      cfg: { gatewayToken: "op-secret" } as never,
      authorizeDevice: async () => ({ ok: true as const }),
      unauthorized: () => new Response(null, { status: 401 }),
      fleetPaused: async () => opts.paused,
    });
    return { answer, fetched };
  }

  test("bootstrap, join, snapshot and head advance are refused before the object is touched", async () => {
    for (const path of ["/fleets/acme/bootstrap", "/fleets/acme/join", "/fleets/acme/snapshot", "/fleets/acme/head/advance"]) {
      const { answer, fetched } = route({ paused: true, path });
      const res = (await answer)!;
      expect(res.status).toBe(409);
      expect(res.headers.get("retry-after")).toBe("60");
      expect(await res.json()).toEqual({ error: "the fleet is paused", paused: true, retryAfterMs: 60000 });
      expect(fetched).toEqual([]);
    }
  });

  test("a fleet that is not paused reaches its object", async () => {
    const { answer, fetched } = route({ paused: false, path: "/fleets/acme/bootstrap" });
    expect((await answer)!.status).toBe(200);
    expect(fetched.length).toBe(1);
  });

  test("what only reads is still served while paused", async () => {
    const { answer, fetched } = route({ paused: true, path: "/fleets/acme/members", method: "GET" });
    expect((await answer)!.status).toBe(200);
    expect(fetched.length).toBe(1);
  });

  test("a member may still listen to a paused fleet: that is how it hears the pause end", async () => {
    const { answer, fetched } = route({ paused: true, path: "/fleets/acme/events", method: "GET", upgrade: true });
    await answer;
    expect(fetched.length).toBe(1);
    expect(fetched[0]!.url).toBe("https://fleet/events");
    // The object is told who is listening by the Worker, not by the caller.
    expect(fetched[0]!.headers.get("x-prime-caller")).toBe("device");
    expect(fetched[0]!.headers.get("x-prime-device")).toBe("dev-a");
    expect(fetched[0]!.headers.get("x-prime-fleet")).toBe("acme");
    expect(fetched[0]!.headers.get("upgrade")).toBe("websocket");
  });

  test("listening is a websocket upgrade, and the operator is not a member", async () => {
    const plain = route({ paused: false, path: "/fleets/acme/events", method: "GET" });
    expect((await plain.answer)!.status).toBe(426);
    expect(plain.fetched).toEqual([]);
    const operator = route({ paused: false, path: "/fleets/acme/events", method: "GET", upgrade: true, bearer: "op-secret" });
    expect((await operator.answer)!.status).toBe(401);
    expect(operator.fetched).toEqual([]);
  });
});


describe("the Worker publishes a snapshot", () => {
  async function publishVia(manifest: Record<string, unknown>) {
    const advances: Array<Record<string, any>> = [];
    const stub = {
      async fetch(input: Request | string, init?: RequestInit) {
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("/role")) return Response.json({ member: true, primary: true, epoch: 1 });
        if (url.endsWith("/head/advance")) {
          advances.push(JSON.parse(String(init?.body ?? "{}")));
          return Response.json({ ok: true, head: { seq: manifest.seq } });
        }
        return Response.json({ ok: true });
      },
    };
    const puts: string[] = [];
    const env = {
      BUCKET: { put: async (key: string) => void puts.push(key) },
      FLEET: { idFromName: (n: string) => n, get: () => stub },
    } as never;
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(manifestBytes.length, 0);
    const body = Buffer.concat([header, manifestBytes, Buffer.from("sealed pack bytes")]);
    const url = new URL("https://gateway/fleets/acme/snapshot");
    const request = new Request(url, { method: "POST", headers: { "x-prime-device": "dev-a", "x-device-token": "t" }, body });
    const res = (await handleFleetRoutes({
      request,
      env,
      url,
      cfg: { gatewayToken: "op-secret" } as never,
      authorizeDevice: async () => ({ ok: true as const }),
      unauthorized: () => new Response(null, { status: 401 }),
    }))!;
    return { res, advances, puts };
  }

  test("the object is told what a member needs to choose a route, and the change pack that goes with it", async () => {
    const delta = "fleets/acme/packs/" + "c".repeat(64);
    const { res, advances } = await publishVia({ seq: 4, full: true, packBytes: 1234, delta: { packKey: delta, bytes: 56 } });
    expect(res.status).toBe(200);
    expect(advances[0]!.expectedSeq).toBe(3);
    expect(advances[0]!.meta).toEqual({ full: true, packBytes: 1234, deltaBytes: 56 });
    expect(advances[0]!.extraKeys).toEqual([delta]);
  });

  test("a publisher that predates sizes and the change pack publishes as it always did", async () => {
    const { res, advances } = await publishVia({ seq: 2, full: false });
    expect(res.status).toBe(200);
    expect(advances[0]!.meta).toEqual({ full: false });
    expect(advances[0]!.extraKeys).toEqual([]);
  });

  test("the index is asked of the object from the sequence the member names", async () => {
    const fetched: string[] = [];
    const stub = { async fetch(input: Request | string) { fetched.push(typeof input === "string" ? input : input.url); return Response.json({ entries: [] }); } };
    const url = new URL("https://gateway/fleets/acme/index?after=7");
    const res = (await handleFleetRoutes({
      request: new Request(url, { method: "GET", headers: { "x-prime-device": "dev-a" } }),
      env: { FLEET: { idFromName: (n: string) => n, get: () => stub } } as never,
      url,
      cfg: { gatewayToken: "op-secret" } as never,
      authorizeDevice: async () => ({ ok: true as const }),
      unauthorized: () => new Response(null, { status: 401 }),
    }))!;
    expect(res.status).toBe(200);
    expect(fetched).toEqual(["https://fleet/index?after=7"]);
  });
});
