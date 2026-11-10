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
  newInviteCode,
  validFleetId,
} from "../src/fleets";
import { FleetDO } from "../src/fleet-do";

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

  test("a member that has not applied the head cannot publish over it", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-one");
    await call(doInstance, "/bootstrap", { caller: "device", device: "dev-one" });
    await call(doInstance, "/head/advance", {
      caller: "device",
      device: "dev-one",
      body: { expectedSeq: 0, manifestKey: "m/1", manifestHash: "h1" },
    });
    const blocked = await call(doInstance, "/head/advance", {
      caller: "device",
      device: "dev-one",
      body: { expectedSeq: 1, manifestKey: "m/2", manifestHash: "h2" },
    });
    expect(blocked.status).toBe(409);
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