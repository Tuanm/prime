import { describe, expect, test } from "bun:test";
import {
  cleanLabel,
  clampTtl,
  hashCode,
  INVITE_DEFAULT_TTL_MS,
  INVITE_MAX_TTL_MS,
  inviteShape,
  keyFingerprint,
  FleetCreationAllowance,
  MAX_FLEETS_PER_DEVICE,
  MAX_MEMBERS,
  MAX_SNAPSHOT_BYTES,
  RECENT_SNAPSHOTS,
  newInviteCode,
  onlineNow,
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
        // a copy, as the real storage gives: a caller that holds one does not see another's writes
        const value = data.get(key);
        return (value === undefined ? undefined : structuredClone(value)) as T | undefined;
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
    async delete(key: string | string[]) {
      for (const k of Array.isArray(key) ? key : [key]) objects.delete(k);
    },
    async list(opts: { prefix?: string; limit?: number; cursor?: string }) {
      // As R2's: the cursor is the last key given, so deleting what was listed does not move the next page.
      const keys = [...objects.keys()].filter((k) => k.startsWith(opts.prefix ?? "") && (opts.cursor === undefined || k > opts.cursor)).sort();
      const limit = opts.limit ?? 1000;
      const page = keys.slice(0, limit);
      const truncated = keys.length > limit;
      return { objects: page.map((key) => ({ key })), truncated, ...(truncated ? { cursor: page[page.length - 1]! } : {}) };
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

describe("whether a primary is taken to be gone", () => {
  test("a tunnel that came up after the snapshot was read is found, so the lease it just took is not taken away", async () => {
    let fresh = 0;
    const stale = async () => new Set<string>(); // read before the primary's tunnel opened
    const now = async () => {
      fresh++;
      return new Set(["dev-primary"]);
    };
    expect(await onlineNow("dev-primary", stale, now)).toBe(true);
    expect(fresh).toBe(1);
  });

  test("a device found offline is not looked for again, in a registry read of everything, for a moment", async () => {
    let fresh = 0;
    const now = async () => {
      fresh++;
      return new Set<string>();
    };
    const offlineAt = new Map<string, number>();
    let clock = 1_000;
    const at = () => clock;
    for (let i = 0; i < 50; i++) expect(await onlineNow("dev-primary", async () => new Set<string>(), now, offlineAt, 2_000, at)).toBe(false);
    expect(fresh).toBe(1);
    // Then it is looked for again, and a tunnel that opened since is found.
    clock += 2_500;
    expect(await onlineNow("dev-primary", async () => new Set<string>(), async () => new Set(["dev-primary"]), offlineAt, 2_000, at)).toBe(true);
    // And once found online it is no longer remembered as offline.
    expect(offlineAt.has("dev-primary")).toBe(false);
  });

  test("a device that took its place after the verdict is looked for again, whatever the verdict said", async () => {
    let tunnel = false;
    let clock = 10_000;
    const at = () => clock;
    const offlineAt = new Map<string, number>();
    const snap = async () => new Set<string>(); // the registry snapshot predates the tunnel
    const fresh = async () => new Set<string>(tunnel ? ["p"] : []);
    expect(await onlineNow("p", snap, fresh, offlineAt, 2_000, at)).toBe(false);
    clock += 300;
    tunnel = true;
    const tookPlace = clock; // its tunnel opened, and it took the lease
    clock += 700;
    // Without the lease's age, the call a second later would vacate it on the verdict from before.
    expect(await onlineNow("p", snap, fresh, offlineAt, 2_000, at, tookPlace)).toBe(true);
  });

  test("and a lease that is not young is judged by the verdict, which is read once", async () => {
    let reads = 0;
    const offlineAt = new Map<string, number>();
    const fresh = async () => {
      reads++;
      return new Set<string>();
    };
    let clock = 10_000;
    for (let i = 0; i < 20; i++) expect(await onlineNow("p", async () => new Set<string>(), fresh, offlineAt, 2_000, () => clock, 1_000)).toBe(false);
    expect(reads).toBe(1);
  });

  test("one the snapshot lists is not asked about again, and one nobody lists is gone", async () => {
    let fresh = 0;
    const now = async () => {
      fresh++;
      return new Set<string>();
    };
    expect(await onlineNow("dev-primary", async () => new Set(["dev-primary"]), now)).toBe(true);
    expect(fresh).toBe(0);
    expect(await onlineNow("dev-primary", async () => new Set<string>(), now)).toBe(false);
    expect(fresh).toBe(1);
  });
});

describe("the keys of members that have left", () => {
  const PUB_B = "B".repeat(43) + "=";
  async function twoMembers() {
    const made = makeDo();
    await makeFleet(made.doInstance, "dev-owner");
    const inv = await call(made.doInstance, "/invite", { caller: "device", device: "dev-owner", body: { autoApprove: true } });
    await call(made.doInstance, "/join", { caller: "device", device: "dev-two", body: { code: inv.json.code, pubkey: PUB_B } });
    await call(made.doInstance, "/approve", { caller: "admin", device: "operator", body: { deviceId: "dev-two" } });
    return made;
  }
  const roster = (d: FleetDO, device: string) => call(d, "/members", { caller: "device", device, method: "GET" });

  test("a member that leaves is listed with the sequence the head was at, for the members that took in less", async () => {
    const { doInstance, state } = await twoMembers();
    state.data.set("index", [{ seq: 2, manifestKey: "m2", full: false }, { seq: 3, manifestKey: "m3", full: false }]);
    const gone = await call(doInstance, "/remove", { caller: "device", device: "dev-two", body: { deviceId: "dev-two" } });
    expect(gone.status).toBe(200);
    const seen = await roster(doInstance, "dev-owner");
    expect(seen.json.members.map((m: { pubkey?: string }) => m.pubkey)).not.toContain(PUB_B);
    expect(seen.json.left).toEqual([{ pubkey: PUB_B, until: 3 }]);
  });

  test("removed by the operator it is the same, and it goes with the fleet", async () => {
    const { doInstance, state } = await twoMembers();
    state.data.set("index", [{ seq: 5, manifestKey: "m5", full: true }]);
    await call(doInstance, "/remove", { caller: "admin", device: "operator", body: { deviceId: "dev-two" } });
    expect((await roster(doInstance, "dev-owner")).json.left).toEqual([{ pubkey: PUB_B, until: 5 }]);
    await call(doInstance, "/delete", { caller: "admin", device: "operator", body: {} });
    expect(state.data.get("left")).toBeUndefined();
  });
});

describe("a member that goes while its publish is in flight, or is re-keyed", () => {
  const PUB_B = "B".repeat(43) + "=";
  const roster = (d: FleetDO, device: string) => call(d, "/members", { caller: "device", device, method: "GET" });
  async function fleetOfTwo(bucket = fakeBucket()) {
    const made = makeDo(bucket);
    await makeFleet(made.doInstance, "dev-owner");
    const inv = await call(made.doInstance, "/invite", { caller: "device", device: "dev-owner", body: { autoApprove: true } });
    await call(made.doInstance, "/join", { caller: "device", device: "dev-two", body: { code: inv.json.code, pubkey: PUB_B } });
    await call(made.doInstance, "/approve", { caller: "admin", device: "operator", body: { deviceId: "dev-two" } });
    await call(made.doInstance, "/bootstrap", { caller: "device", device: "dev-owner" });
    return made;
  }
  const publish = (d: FleetDO, device: string, expectedSeq: number) =>
    call(d, "/head/advance", { caller: "device", device, body: { expectedSeq, manifestKey: "m/" + (expectedSeq + 1), manifestHash: "h" + (expectedSeq + 1), meta: { full: true } } });

  test("is a member's key for the snapshot it was publishing, not only for the ones before", async () => {
    const bucket = fakeBucket();
    const { doInstance } = await fleetOfTwo(bucket);
    expect((await publish(doInstance, "dev-owner", 0)).status).toBe(200);
    // The head write is slow: the operator removes the member while it is in flight.
    const realPut = bucket.put;
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const arrived = new Promise<void>((r) => (reached = r));
    bucket.put = async (...args: Parameters<typeof realPut>) => {
      reached();
      await gate;
      return realPut.apply(bucket, args);
    };
    const inflight = publish(doInstance, "dev-owner", 1);
    await arrived;
    const gone = await call(doInstance, "/remove", { caller: "admin", device: "operator", body: { deviceId: "dev-owner" } });
    expect(gone.status).toBe(200);
    release();
    const done = await inflight;
    expect(done.status).toBe(200);
    // The snapshot it made is the head now: its key is a member's for it.
    expect((await roster(doInstance, "dev-two")).json.left).toEqual([{ pubkey: TEST_PUBKEY, until: 2 }]);
  });

  test("what a publish is in the middle of storing is not offered for deletion, and what a refused one stored is", async () => {
    const bucket = fakeBucket();
    const { doInstance } = await fleetOfTwo(bucket);
    const hex = (c: string) => c.repeat(64);
    const manifest = "fleets/acme/manifests/" + hex("a");
    const pack = "fleets/acme/packs/" + hex("b");
    const unreferenced = async (keys: string[]) => (await call(doInstance, "/unreferenced", { caller: "device", device: "dev-owner", body: { keys } })).json.keys as string[];
    const realPut = bucket.put;
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const arrived = new Promise<void>((r) => (reached = r));
    bucket.put = async (...args: Parameters<typeof realPut>) => {
      reached();
      await gate;
      return realPut.apply(bucket, args);
    };
    const inflight = call(doInstance, "/head/advance", { caller: "device", device: "dev-owner", body: { expectedSeq: 0, manifestKey: manifest, manifestHash: hex("a"), packKey: pack, meta: { full: true } } });
    await arrived;
    // The head is being written; a retry of the same publish asks whether its objects are anyone's.
    expect(await unreferenced([manifest, pack])).toEqual([]);
    release();
    expect((await inflight).status).toBe(200);
    expect(await unreferenced([manifest, pack])).toEqual([]);

    // A publish that lost: what it stored is nobody's once it has said so.
    bucket.put = async () => null; // the head is not the one it expected
    const lost = "fleets/acme/manifests/" + hex("c");
    const refused = await call(doInstance, "/head/advance", { caller: "device", device: "dev-owner", body: { expectedSeq: 1, manifestKey: lost, manifestHash: hex("c"), meta: { full: true } } });
    expect(refused.status).toBe(409);
    expect(await unreferenced([lost])).toEqual([lost]);
  });

  describe("a join request that waits while the fleet publishes", () => {
    async function waiting(bucket = fakeBucket()) {
      const made = await fleetOfTwo(bucket);
      const inv = await call(made.doInstance, "/invite", { caller: "device", device: "dev-owner", body: {} });
      const joined = await call(made.doInstance, "/join", { caller: "device", device: "dev-three", body: { code: inv.json.code, pubkey: "C".repeat(43) + "=" } });
      expect(joined.json.status).toBe("pending");
      return made;
    }
    const hex = (c: string) => c.repeat(64);

    test("is still there after a publish that was accepted and one that was refused, and can be approved", async () => {
      const bucket = fakeBucket();
      const { doInstance } = await waiting(bucket);
      const advance = (expectedSeq: number, c: string) =>
        call(doInstance, "/head/advance", { caller: "device", device: "dev-owner", body: { expectedSeq, manifestKey: "fleets/acme/manifests/" + hex(c), manifestHash: hex(c), packKey: "fleets/acme/packs/" + hex(c), meta: { full: true } } });
      expect((await advance(0, "a")).status).toBe(200);
      expect((await advance(0, "b")).status).toBe(409); // another publish on the same head: refused
      const listed = await call(doInstance, "/pending", { caller: "admin", device: "operator", method: "GET" });
      expect((listed.json.pending as Array<{ deviceId: string }>).map((p) => p.deviceId)).toEqual(["dev-three"]);
      expect((await call(doInstance, "/me", { caller: "device", device: "dev-three", method: "GET" })).json.status).toBe("pending");
      expect((await call(doInstance, "/approve", { caller: "admin", device: "operator", body: { deviceId: "dev-three" } })).status).toBe(200);
    });

    test("does not stop the object from answering which stored objects belong to no snapshot", async () => {
      const { doInstance } = await waiting();
      const orphan = "fleets/acme/packs/" + hex("c");
      const asked = await call(doInstance, "/unreferenced", { caller: "device", device: "dev-owner", body: { keys: [orphan] } });
      expect(asked.status).toBe(200);
      expect(asked.json.keys).toEqual([orphan]);
    });

    test("is not listed as the keys of a publish in flight, and a request that arrives meanwhile is kept", async () => {
      const bucket = fakeBucket();
      const { doInstance } = await fleetOfTwo(bucket);
      const realPut = bucket.put;
      let release!: () => void;
      let reached!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const arrived = new Promise<void>((r) => (reached = r));
      bucket.put = async (...args: Parameters<typeof realPut>) => {
        reached();
        await gate;
        return realPut.apply(bucket, args);
      };
      const inflight = call(doInstance, "/head/advance", { caller: "device", device: "dev-owner", body: { expectedSeq: 0, manifestKey: "fleets/acme/manifests/" + hex("a"), manifestHash: hex("a"), meta: { full: true } } });
      await arrived;
      const inv = await call(doInstance, "/invite", { caller: "device", device: "dev-owner", body: {} });
      await call(doInstance, "/join", { caller: "device", device: "dev-three", body: { code: inv.json.code, pubkey: "C".repeat(43) + "=" } });
      const during = await call(doInstance, "/pending", { caller: "admin", device: "operator", method: "GET" });
      expect((during.json.pending as Array<{ deviceId: string }>).map((p) => p.deviceId)).toEqual(["dev-three"]);
      release();
      expect((await inflight).status).toBe(200);
      const after = await call(doInstance, "/pending", { caller: "admin", device: "operator", method: "GET" });
      expect((after.json.pending as Array<{ deviceId: string }>).map((p) => p.deviceId)).toEqual(["dev-three"]);
    });

    test("two publishes in flight each keep their own objects, and one finishing does not release the other's", async () => {
      const bucket = fakeBucket();
      const { doInstance, state } = await fleetOfTwo(bucket);
      const realPut = bucket.put;
      const gates: Array<() => void> = [];
      let reached = 0;
      bucket.put = async (...args: Parameters<typeof realPut>) => {
        reached++;
        await new Promise<void>((r) => gates.push(r));
        return realPut.apply(bucket, args);
      };
      const one = call(doInstance, "/head/advance", { caller: "device", device: "dev-owner", body: { expectedSeq: 0, manifestKey: "fleets/acme/manifests/" + hex("a"), manifestHash: hex("a"), meta: { full: true } } });
      while (reached < 1) await new Promise((r) => setTimeout(r, 1));
      const two = call(doInstance, "/head/advance", { caller: "device", device: "dev-owner", body: { expectedSeq: 0, manifestKey: "fleets/acme/manifests/" + hex("b"), manifestHash: hex("b"), meta: { full: true } } });
      while (reached < 2) await new Promise((r) => setTimeout(r, 1));
      const manifests = () => Object.values((state.data.get("storing") ?? {}) as Record<string, { manifestKey: string }>).map((v) => v.manifestKey).sort();
      expect(manifests()).toEqual(["fleets/acme/manifests/" + hex("a"), "fleets/acme/manifests/" + hex("b")]);
      gates[1]!(); // the second's write is the one that loses or wins; whichever, the other's entry stays until it ends
      await new Promise((r) => setTimeout(r, 5));
      expect(manifests()).toContain("fleets/acme/manifests/" + hex("a"));
      gates[0]!();
      await Promise.all([one, two]);
      expect(state.data.get("storing")).toBeUndefined();
    });

    test("an identical publish sent again does not drop the protection of the first when it ends first", async () => {
      const bucket = fakeBucket();
      const { doInstance, state } = await fleetOfTwo(bucket);
      const realPut = bucket.put;
      const gates: Array<() => void> = [];
      let calls = 0;
      bucket.put = async (...args: Parameters<typeof realPut>) => {
        const mine = ++calls;
        await new Promise<void>((r) => gates.push(r));
        if (mine === 2) throw new Error("refused"); // the retry's head write fails; the first's goes through
        return realPut.apply(bucket, args);
      };
      const pack = "fleets/acme/packs/" + hex("p");
      const body = { expectedSeq: 0, manifestKey: "fleets/acme/manifests/" + hex("a"), manifestHash: hex("a"), packKey: pack, meta: { full: true } };
      const first = call(doInstance, "/head/advance", { caller: "device", device: "dev-owner", body });
      while (gates.length < 1) await new Promise((r) => setTimeout(r, 1));
      const again = call(doInstance, "/head/advance", { caller: "device", device: "dev-owner", body });
      while (gates.length < 2) await new Promise((r) => setTimeout(r, 1));
      expect(Object.keys(state.data.get("storing") as object)).toHaveLength(2);
      gates[1]!();
      expect((await again).status).toBe(409); // ends first
      // The first is still writing its head: what it names is still not offered for deletion.
      expect(Object.keys(state.data.get("storing") as object)).toHaveLength(1);
      const asked = await call(doInstance, "/unreferenced", { caller: "device", device: "dev-owner", body: { keys: [pack] } });
      expect(asked.json.keys).toEqual([]);
      gates[0]!();
      expect((await first).status).toBe(200);
      expect(state.data.get("storing")).toBeUndefined();
    });

    describe("an object that died between writing the head and keeping the snapshot", () => {
      const advanceBody = (c: string, expectedSeq: number) => ({ expectedSeq, manifestKey: "fleets/acme/manifests/" + hex(c), manifestHash: hex(c), packKey: "fleets/acme/packs/" + hex(c), extraKeys: ["fleets/acme/packs/" + hex("d")], meta: { full: true } });
      /** The publish dies when it goes to write `recent`, after the head is in R2. */
      async function crashed() {
        const bucket = fakeBucket();
        const { doInstance, state } = await fleetOfTwo(bucket);
        const realPut = state.storage.put;
        state.storage.put = async (key: string, value: unknown) => {
          if (key === "recent") throw new Error("the object was reset");
          return realPut.call(state.storage, key, value);
        };
        const dead = await call(doInstance, "/head/advance", { caller: "device", device: "dev-owner", body: advanceBody("a", 0) }).catch(() => ({ status: 500 }));
        state.storage.put = realPut;
        return { doInstance, state, bucket, dead };
      }
      const kept = (state: { data: Map<string, unknown> }) => ((state.data.get("recent") ?? []) as string[]).flatMap((e) => e.split("\n"));
      const aged = (state: { data: Map<string, unknown> }) => {
        const storing = state.data.get("storing") as Record<string, { at: number }>;
        for (const v of Object.values(storing)) v.at -= 5 * 60_000;
      };

      test("the next publish keeps the snapshot the head names", async () => {
        const { doInstance, state, bucket } = await crashed();
        expect(kept(state)).toEqual([]); // the crash point: head written, snapshot not kept
        expect(Object.keys(state.data.get("storing") as object)).toHaveLength(1);
        aged(state);
        const next = await call(doInstance, "/head/advance", { caller: "device", device: "dev-owner", body: advanceBody("b", 1) });
        expect(next.status).toBe(200);
        expect(kept(state)).toEqual(expect.arrayContaining(["fleets/acme/manifests/" + hex("a"), "fleets/acme/packs/" + hex("a"), "fleets/acme/manifests/" + hex("b")]));
        expect(state.data.get("storing")).toBeUndefined();
        expect(((state.data.get("index") ?? []) as Array<{ seq: number }>).map((e) => e.seq)).toEqual([1, 2]);
        void bucket;
      });

      test("an alarm keeps it too, and what it names is not offered for deletion", async () => {
        const { doInstance, state } = await crashed();
        aged(state);
        await doInstance.alarm();
        expect(kept(state)).toContain("fleets/acme/manifests/" + hex("a"));
        const asked = await call(doInstance, "/unreferenced", { caller: "device", device: "dev-owner", body: { keys: ["fleets/acme/packs/" + hex("a")] } });
        expect(asked.json.keys).toEqual([]);
      });

      test("a request that is still running is not settled, however slow its head write", async () => {
        const bucket = fakeBucket();
        const { doInstance, state } = await fleetOfTwo(bucket);
        const realPut = bucket.put;
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        let reached!: () => void;
        const arrived = new Promise<void>((r) => (reached = r));
        bucket.put = async (...args: Parameters<typeof realPut>) => {
          reached();
          await gate;
          return realPut.apply(bucket, args);
        };
        const body = advanceBody("a", 0);
        const inflight = call(doInstance, "/head/advance", { caller: "device", device: "dev-owner", body });
        await arrived;
        const realNow = Date.now;
        Date.now = () => realNow() + 5 * 60_000; // far past the grace: the write is only slow
        try {
          await doInstance.alarm();
          expect(Object.keys(state.data.get("storing") as object)).toHaveLength(1);
          const asked = await call(doInstance, "/unreferenced", { caller: "device", device: "dev-owner", body: { keys: [body.packKey, body.manifestKey] } });
          expect(asked.json.keys).toEqual([]);
        } finally {
          Date.now = realNow;
        }
        release();
        expect((await inflight).status).toBe(200);
        expect(kept(state)).toContain(body.manifestKey);
        expect(state.data.get("storing")).toBeUndefined();
      });

      test("a publish that is still young is not settled from under its request", async () => {
        const { doInstance, state } = await crashed();
        await doInstance.alarm();
        expect(kept(state)).toEqual([]);
        expect(Object.keys(state.data.get("storing") as object)).toHaveLength(1);
      });

      test("an entry whose head write did not happen is let go, and keeps nothing", async () => {
        const { doInstance, state } = await crashed();
        // as if the write had not landed: the head names another snapshot
        const storing = state.data.get("storing") as Record<string, { manifestKey: string }>;
        for (const v of Object.values(storing)) v.manifestKey = "fleets/acme/manifests/" + hex("f");
        aged(state);
        await doInstance.alarm();
        expect(kept(state)).toEqual([]);
        expect(state.data.get("storing")).toBeUndefined();
      });
    });

    test("an object whose storage holds the keys of a publish under the name of the requests (an earlier build) still lists and approves the requests", async () => {
      const { doInstance, state } = await fleetOfTwo();
      state.data.set("pending", ["fleets/acme/manifests/" + hex("a"), "fleets/acme/packs/" + hex("b")]);
      expect(((await call(doInstance, "/pending", { caller: "admin", device: "operator", method: "GET" })).json.pending as unknown[]).length).toBe(0);
      const inv = await call(doInstance, "/invite", { caller: "device", device: "dev-owner", body: {} });
      expect((await call(doInstance, "/join", { caller: "device", device: "dev-three", body: { code: inv.json.code, pubkey: "C".repeat(43) + "=" } })).json.status).toBe("pending");
      expect((await call(doInstance, "/approve", { caller: "admin", device: "operator", body: { deviceId: "dev-three" } })).status).toBe(200);
      const unref = await call(doInstance, "/unreferenced", { caller: "device", device: "dev-owner", body: { keys: ["fleets/acme/packs/" + hex("d")] } });
      expect(unref.status).toBe(200);
    });
  });

  test("a key that left is credited up to the head in storage, which can be ahead of the index", async () => {
    const bucket = fakeBucket();
    const { doInstance, state } = await fleetOfTwo(bucket);
    await publish(doInstance, "dev-owner", 0);
    // The head was written and the object went away before it pushed the index.
    bucket.objects.set("fleets/acme/head", { body: JSON.stringify({ seq: 3, manifestKey: "m/3", manifestHash: "h3", epoch: 1 }), etag: "x" });
    expect((state.data.get("index") as Array<{ seq: number }>).at(-1)!.seq).toBe(1);
    await call(doInstance, "/remove", { caller: "admin", device: "operator", body: { deviceId: "dev-owner" } });
    expect((await roster(doInstance, "dev-two")).json.left).toEqual([{ pubkey: TEST_PUBKEY, until: 3 }]);
  });

  test("a key a member replaces, when it joins again or takes its place, is recorded as left", async () => {
    const { doInstance } = await fleetOfTwo();
    await publish(doInstance, "dev-owner", 0);
    const code = (await call(doInstance, "/invite", { caller: "device", device: "dev-owner", body: {} })).json.code;
    const C = "C".repeat(43) + "=";
    const D = "D".repeat(43) + "=";
    await call(doInstance, "/join", { caller: "device", device: "dev-two", body: { code, pubkey: C } });
    await call(doInstance, "/bootstrap", { caller: "device", device: "dev-two", body: { pubkey: D } });
    const left = (await roster(doInstance, "dev-owner")).json.left as Array<{ pubkey: string; until: number }>;
    expect(left).toEqual([{ pubkey: PUB_B, until: 1 }, { pubkey: C, until: 1 }]);
  });

  test("the keys that left are kept for a fleet that has had many members, and go with the snapshots they could have made", async () => {
    const { doInstance, state } = await fleetOfTwo();
    const keys = Array.from({ length: 100 }, (_, i) => ({ pubkey: String(i).padStart(43, "X") + "=", until: 5 }));
    state.data.set("left", keys);
    state.data.set("index", [{ seq: 5, manifestKey: "m5", full: true }]);
    await call(doInstance, "/remove", { caller: "admin", device: "operator", body: { deviceId: "dev-two" } });
    expect(((await roster(doInstance, "dev-owner")).json.left as unknown[]).length).toBe(101);
  });
});

describe("the lease's epoch", () => {
  test("two holders in a row, neither of which published, are not given the same epoch", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-a");
    const inv = await call(doInstance, "/invite", { caller: "device", device: "dev-a", body: { autoApprove: true } });
    await call(doInstance, "/join", { caller: "device", device: "dev-b", body: { code: inv.json.code, pubkey: "B".repeat(43) + "=" } });
    await call(doInstance, "/approve", { caller: "admin", device: "operator", body: { deviceId: "dev-b" } });
    const first = await call(doInstance, "/bootstrap", { caller: "device", device: "dev-a" });
    await call(doInstance, "/lease/release", { caller: "device", device: "dev-a" });
    const second = await call(doInstance, "/bootstrap", { caller: "device", device: "dev-b" });
    await call(doInstance, "/lease/release", { caller: "device", device: "dev-b" });
    const third = await call(doInstance, "/bootstrap", { caller: "device", device: "dev-a" });
    expect([first.json.epoch, second.json.epoch, third.json.epoch]).toEqual([1, 2, 3]);
  });
});

describe("the lease's epoch, for a holder that asks again", () => {
  async function held() {
    const made = makeDo();
    await makeFleet(made.doInstance, "dev-a");
    const inv = await call(made.doInstance, "/invite", { caller: "device", device: "dev-a", body: { autoApprove: true } });
    await call(made.doInstance, "/join", { caller: "device", device: "dev-b", body: { code: inv.json.code, pubkey: "B".repeat(43) + "=" } });
    await call(made.doInstance, "/approve", { caller: "admin", device: "operator", body: { deviceId: "dev-b" } });
    const first = await call(made.doInstance, "/bootstrap", { caller: "device", device: "dev-a" });
    return { ...made, first };
  }

  test("a holder's own bootstrap and renewals keep its epoch, and since when it has held it", async () => {
    const { doInstance, state, first } = await held();
    const since = (state.data.get("lease") as { since: number }).since;
    await new Promise((r) => setTimeout(r, 3));
    for (let i = 0; i < 5; i++) {
      const again = await call(doInstance, "/bootstrap", { caller: "device", device: "dev-a" });
      expect([again.json.role, again.json.epoch]).toEqual(["primary", first.json.epoch]);
      const renewed = await call(doInstance, "/lease/renew", { caller: "device", device: "dev-a", body: {} });
      expect(renewed.json.epoch).toBe(first.json.epoch);
    }
    expect((state.data.get("lease") as { since: number; epoch: number }).since).toBe(since);
    expect((await call(doInstance, "/role", { caller: "device", device: "dev-a", method: "GET" })).json.epoch).toBe(first.json.epoch);
  });

  test("a publish started under an epoch is not refused because the holder asked again meanwhile", async () => {
    const { doInstance } = await held();
    await call(doInstance, "/bootstrap", { caller: "device", device: "dev-a" });
    const published = await call(doInstance, "/head/advance", { caller: "device", device: "dev-a", body: { expectedSeq: 0, manifestKey: "m/1", manifestHash: "h1" } });
    expect(published.status).toBe(200);
    expect(published.json.head.epoch).toBe(1);
  });

  test("a handover is a new epoch, and so is a grant after the lease lapsed, even to the same member", async () => {
    const { doInstance, state, first } = await held();
    await call(doInstance, "/lease/release", { caller: "device", device: "dev-a" });
    const handed = await call(doInstance, "/bootstrap", { caller: "device", device: "dev-b" });
    expect(handed.json.epoch).toBe(first.json.epoch + 1);
    (state.data.get("lease") as { expiresAt: number }).expiresAt = Date.now() - 1000;
    const again = await call(doInstance, "/bootstrap", { caller: "device", device: "dev-b" });
    expect(again.json.epoch).toBe(first.json.epoch + 2);
  });
});

describe("a sealed tip that was written before the index said so", () => {
  async function fleet(manifest: object | null) {
    const made = makeDo();
    await makeFleet(made.doInstance, "dev-old");
    const inv = await call(made.doInstance, "/invite", { caller: "admin", device: "dev-old", body: {} });
    await call(made.doInstance, "/join", { caller: "device", device: "dev-new", body: { code: inv.json.code } });
    await call(made.doInstance, "/approve", { caller: "admin", device: "operator", body: { deviceId: "dev-new" } });
    await call(made.doInstance, "/bootstrap", { caller: "device", device: "dev-old" });
    // The head moves through the gateway as it was before the index noted seals.
    expect((await call(made.doInstance, "/head/advance", { caller: "device", device: "dev-old", body: { expectedSeq: 0, manifestKey: "fleets/acme/manifests/t1", manifestHash: "h1", meta: { full: true } } })).status).toBe(200);
    const index = made.state.data.get("index") as Array<{ sealed?: boolean }>;
    delete index[0]!.sealed;
    if (manifest) made.bucket.objects.set("fleets/acme/manifests/t1", { body: JSON.stringify(manifest), etag: "m" });
    return made;
  }
  const unsealed = (d: FleetDO) => call(d, "/head/advance", { caller: "device", device: "dev-old", body: { expectedSeq: 1, manifestKey: "m/2", manifestHash: "h2", meta: { full: false } } });

  test("is read once from its manifest, so the gate fires, and the flag is filled in", async () => {
    const { doInstance, state } = await fleet({ seq: 1, seal: "v1:abc" });
    const refused = await unsealed(doInstance);
    expect(refused.status).toBe(409);
    expect(refused.json.upgrade).toBe(true);
    expect((state.data.get("index") as Array<{ sealed?: boolean }>)[0]!.sealed).toBe(true);
  });

  test("a tip whose manifest has no seal does not trip the gate, and is marked so that it is not read again", async () => {
    const { doInstance, state, bucket } = await fleet({ seq: 1 });
    expect((await unsealed(doInstance)).status).toBe(200);
    const index = state.data.get("index") as Array<{ sealed?: boolean }>;
    expect(index[0]!.sealed).toBe(false);
    expect(index[1]!.sealed).toBe(false);
    const get = bucket.get;
    let manifestReads = 0;
    bucket.get = async (key: string) => {
      if (key.includes("/manifests/")) manifestReads++;
      return get.call(bucket, key);
    };
    await call(doInstance, "/head/advance", { caller: "device", device: "dev-old", body: { expectedSeq: 2, manifestKey: "m/3", manifestHash: "h3", meta: { full: false } } });
    expect(manifestReads).toBe(0);
  });

  test("a manifest that cannot be read does not fire the gate (it is a rule about availability)", async () => {
    const { doInstance } = await fleet(null);
    expect((await unsealed(doInstance)).status).toBe(200);
  });

  test("the index a member reads says a snapshot was sealed, and says nothing when it was not", async () => {
    const { doInstance } = await fleet({ seq: 1, seal: "v1:abc" });
    await unsealed(doInstance);
    const listed = await call(doInstance, "/index", { caller: "device", device: "dev-new", method: "GET" });
    expect(listed.json.entries).toEqual([{ seq: 1, manifestKey: "fleets/acme/manifests/t1", full: true, sealed: true }]);
  });
});

describe("a member that is barred for publishing without a seal", () => {
  async function barred() {
    const made = makeDo();
    await makeFleet(made.doInstance, "dev-old");
    const inv = await call(made.doInstance, "/invite", { caller: "admin", device: "dev-old", body: {} });
    await call(made.doInstance, "/join", { caller: "device", device: "dev-new", body: { code: inv.json.code } });
    await call(made.doInstance, "/approve", { caller: "admin", device: "operator", body: { deviceId: "dev-new" } });
    await call(made.doInstance, "/bootstrap", { caller: "device", device: "dev-old" });
    await call(made.doInstance, "/head/advance", { caller: "device", device: "dev-old", body: { expectedSeq: 0, manifestKey: "m/1", manifestHash: "h1", meta: { full: true, sealed: true } } });
    const refused = await call(made.doInstance, "/head/advance", { caller: "device", device: "dev-old", body: { expectedSeq: 1, manifestKey: "m/2", manifestHash: "h2", meta: { full: false } } });
    expect(refused.status).toBe(409);
    return made;
  }

  test("is told to upgrade for as long as it asks as the build that was refused", async () => {
    const { doInstance } = await barred();
    expect((await call(doInstance, "/bootstrap", { caller: "device", device: "dev-old" })).json.reason).toBe("upgrade-required");
  });

  test("has the bar lifted as soon as it says it seals", async () => {
    const { doInstance } = await barred();
    const asked = await call(doInstance, "/bootstrap", { caller: "device", device: "dev-old", body: { seals: true } });
    expect(asked.json.role).toBe("primary");
  });

  test("the gateway says it has the gate", async () => {
    const { doInstance } = await barred();
    const role = await call(doInstance, "/role", { caller: "device", device: "dev-old", method: "GET" });
    expect(role.json.sealGate).toBe(true);
  });
});

describe("the holder of a lease, as the Worker asks about it", () => {
  test("says since when it has held it, and a renewal does not move that", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-a");
    const before = Date.now();
    await call(doInstance, "/bootstrap", { caller: "device", device: "dev-a" });
    const first = (await call(doInstance, "/primary", { caller: "device", device: "dev-a", method: "GET" })).json;
    expect(first.since).toBeGreaterThanOrEqual(before);
    await new Promise((r) => setTimeout(r, 5));
    await call(doInstance, "/lease/renew", { caller: "device", device: "dev-a", body: {} });
    const again = (await call(doInstance, "/primary", { caller: "device", device: "dev-a", method: "GET" })).json;
    expect(again.since).toBe(first.since);
  });
});

describe("which fleet a name stands for", () => {
  const role = (d: FleetDO, device: string) => call(d, "/role", { caller: "device", device, method: "GET" });

  test("a member is told the fleet's incarnation, the same every time", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    const first = await role(doInstance, "dev-owner");
    expect(typeof first.json.incarnation).toBe("string");
    expect(first.json.incarnation.length).toBeGreaterThan(8);
    expect((await role(doInstance, "dev-owner")).json.incarnation).toBe(first.json.incarnation);
    // A stranger is told nothing of it.
    expect((await role(doInstance, "dev-stranger")).json.incarnation).toBeUndefined();
  });

  test("a fleet made again under a deleted fleet's name is another incarnation", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    const before = (await role(doInstance, "dev-owner")).json.incarnation;
    await call(doInstance, "/delete", { caller: "admin", device: "operator", body: {} });
    await makeFleet(doInstance, "dev-owner");
    const after = (await role(doInstance, "dev-owner")).json.incarnation;
    expect(after).not.toBe(before);
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

describe("what the operator is shown of a member", () => {
  test("the fingerprint of its key is the one `prime fleets members` prints", async () => {
    const { createHash } = await import("node:crypto");
    const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7 + 1)).toString("base64");
    // The CLI: the first eight bytes of the key's SHA-256, in base64.
    const cli = createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 8).toString("base64");
    expect(await keyFingerprint(key)).toBe(cli);
    expect(await keyFingerprint("not base64 !!")).toBe("");
  });

  test("the roster for the operator says how far each member has applied and fetched, and carries the key", async () => {
    const { doInstance, state } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    state.data.set("applied", { "dev-owner": 7 });
    state.data.set("fetched", { "dev-owner": 9 });
    const roster = await call(doInstance, "/members", { caller: "admin", device: "operator", method: "GET" });
    const owner = (roster.json.members as Array<{ deviceId: string; applied: number; fetched?: number; pubkey?: string }>).find((m) => m.deviceId === "dev-owner")!;
    expect(owner.applied).toBe(7);
    expect(owner.fetched).toBe(9);
    expect(owner.pubkey).toBe(TEST_PUBKEY);
  });
});

describe("what a deleted fleet leaves in storage", () => {
  test("nothing of its own: its head, manifests and packs go, and another fleet's objects stay", async () => {
    const { doInstance, bucket } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    for (const key of ["fleets/acme/head", "fleets/acme/manifests/" + "a".repeat(64), "fleets/acme/packs/" + "b".repeat(64), "fleets/acme/packs/orphan"]) await bucket.put(key, "x");
    // A name that begins like it, and another fleet altogether.
    for (const key of ["fleets/acme-two/head", "fleets/acme-two/packs/" + "c".repeat(64), "fleets/other/head"]) await bucket.put(key, "x");
    const deleted = await call(doInstance, "/delete", { caller: "device", device: "dev-owner" });
    expect(deleted.status).toBe(200);
    expect([...bucket.objects.keys()].sort()).toEqual(["fleets/acme-two/head", "fleets/acme-two/packs/" + "c".repeat(64), "fleets/other/head"]);
  });

  test("more than a page of it is all taken", async () => {
    const { doInstance, bucket } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    for (let i = 0; i < 2300; i++) await bucket.put("fleets/acme/packs/p" + i, "x");
    await call(doInstance, "/delete", { caller: "device", device: "dev-owner" });
    expect(bucket.objects.size).toBe(0);
  });
});

describe("who may delete a fleet", () => {
  const DAY = 24 * 60 * 60_000;

  test("a device that is not the owner may not, however long the fleet has been quiet", async () => {
    const { doInstance, state } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    state.data.set("lastActivity", Date.now() - 400 * DAY);
    const stranger = await call(doInstance, "/delete", { caller: "device", device: "dev-stranger" });
    expect(stranger.status).toBe(403);
    expect(state.data.get("members")).toBeDefined();
  });

  test("a paused fleet is not open to a stranger either, and keeps its roster and storage", async () => {
    const { doInstance, state, bucket } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    await bucket.put("fleets/acme/packs/" + "a".repeat(64), "sealed");
    await call(doInstance, "/meta", { caller: "admin", device: "operator", body: { disabled: true } });
    state.data.set("lastActivity", Date.now() - 2 * DAY);
    const stranger = await call(doInstance, "/delete", { caller: "device", device: "dev-stranger" });
    expect(stranger.status).toBe(403);
    expect(state.data.get("members")).toBeDefined();
    expect(bucket.objects.size).toBe(1);
  });

  test("a member that is not the owner may not", async () => {
    const { doInstance } = makeDo();
    await twoMembers(doInstance);
    expect((await call(doInstance, "/delete", { caller: "device", device: "dev-two" })).status).toBe(403);
  });

  test("the owner may, quiet or not, paused or not", async () => {
    const { doInstance, state } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    await call(doInstance, "/meta", { caller: "admin", device: "operator", body: { disabled: true } });
    state.data.set("lastActivity", Date.now() - 2 * DAY);
    const deleted = await call(doInstance, "/delete", { caller: "device", device: "dev-owner" });
    expect(deleted.status).toBe(200);
    expect(state.data.get("members")).toBeUndefined();
  });

  test("the operator may", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    expect((await call(doInstance, "/delete", { caller: "admin", device: "operator" })).status).toBe(200);
  });

  test("through the Worker, a proven stranger's delete of a paused fleet that has been quiet for a day is refused", async () => {
    const { doInstance, state, bucket } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    await bucket.put("fleets/acme/packs/" + "a".repeat(64), "sealed");
    await call(doInstance, "/meta", { caller: "admin", device: "operator", body: { disabled: true } });
    state.data.set("lastActivity", Date.now() - 2 * DAY);
    const res = await routeOf(doInstance, bucket, "delete", "anon-stranger");
    expect(res.status).toBe(403);
    expect(state.data.get("members")).toBeDefined();
    expect(bucket.objects.size).toBe(1);
  });
});

/** The Worker's fleet routes in front of one fleet object, as a proven device `device` (not the operator). */
async function routeOf(
  doInstance: FleetDO,
  bucket: ReturnType<typeof fakeBucket>,
  action: string,
  device: string,
  registry?: unknown,
): Promise<Response> {
  const stub = { fetch: (i: Request | string, init?: RequestInit) => doInstance.fetch(typeof i === "string" ? new Request(i, init) : i) };
  const env = { BUCKET: bucket, FLEET: { idFromName: (n: string) => n, get: () => stub }, REGISTRY: registry ?? fakeRegistry() } as never;
  const url = new URL("https://gateway/fleets/acme/" + action);
  const res = await handleFleetRoutes({
    request: new Request(url, { method: "POST", headers: { "x-prime-device": device, "x-device-token": "t" }, body: "{}" }),
    env,
    url,
    cfg: {} as never,
    authorizeDevice: async () => ({ ok: true as const }),
    unauthorized: () => new Response(null, { status: 401 }),
  });
  return res!;
}

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

describe("a fleet whose snapshots are sealed", () => {
  async function sealedFleet() {
    const made = makeDo();
    const { doInstance } = made;
    await makeFleet(doInstance, "dev-old");
    const invite = await call(doInstance, "/invite", { caller: "admin", device: "dev-old", body: {} });
    await call(doInstance, "/join", { caller: "device", device: "dev-new", body: { code: invite.json.code } });
    await call(doInstance, "/approve", { caller: "admin", device: "operator", body: { deviceId: "dev-new" } });
    await call(doInstance, "/bootstrap", { caller: "device", device: "dev-old" });
    // The old member is the primary; an upgraded member's snapshot was sealed.
    const sealed = await call(doInstance, "/head/advance", { caller: "device", device: "dev-old", body: { expectedSeq: 0, manifestKey: "m/1", manifestHash: "h1", meta: { full: true, sealed: true } } });
    expect(sealed.status).toBe(200);
    return made;
  }

  test("is not moved to a snapshot without a seal, and the member that tried is given no lease until it is upgraded", async () => {
    const { doInstance } = await sealedFleet();
    const refused = await call(doInstance, "/head/advance", { caller: "device", device: "dev-old", body: { expectedSeq: 1, manifestKey: "m/2", manifestHash: "h2", meta: { full: false } } });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatch(/Upgrade prime/);
    // An old client prints it after "the fleet head moved while publishing: ", and shows nothing else of the reply.
    expect("the fleet head moved while publishing: " + refused.json.error).toMatch(/^the fleet head moved while publishing: no, it did not: this publish was refused because/);
    // Its lease is handed on: the upgraded member that has applied the head takes it, and the old one cannot take it back.
    await call(doInstance, "/applied", { caller: "device", device: "dev-new", body: { seq: 1 } });
    const old = await call(doInstance, "/bootstrap", { caller: "device", device: "dev-old" });
    expect(old.json.role).toBe("replica");
    expect(old.json.reason).toBe("upgrade-required");
    const upgraded = await call(doInstance, "/bootstrap", { caller: "device", device: "dev-new" });
    expect(upgraded.json.role).toBe("primary");
    // And the head is where it was.
    const next = await call(doInstance, "/head/advance", { caller: "device", device: "dev-new", body: { expectedSeq: 1, manifestKey: "m/3", manifestHash: "h3", meta: { full: false, sealed: true } } });
    expect(next.status).toBe(200);
  });

  test("a fleet that has had no sealed snapshot takes an unsealed one, as it always did", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-old");
    await call(doInstance, "/bootstrap", { caller: "device", device: "dev-old" });
    const first = await call(doInstance, "/head/advance", { caller: "device", device: "dev-old", body: { expectedSeq: 0, manifestKey: "m/1", manifestHash: "h1", meta: { full: true } } });
    const second = await call(doInstance, "/head/advance", { caller: "device", device: "dev-old", body: { expectedSeq: 1, manifestKey: "m/2", manifestHash: "h2", meta: { full: false } } });
    expect([first.status, second.status]).toEqual([200, 200]);
  });

  test("the Worker says whether a snapshot was sealed", async () => {
    const advances: Array<Record<string, any>> = [];
    const stub = {
      async fetch(input: Request | string, init?: RequestInit) {
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("/role")) return Response.json({ member: true, primary: true, epoch: 1 });
        if (url.endsWith("/head/advance")) {
          advances.push(JSON.parse(String(init?.body ?? "{}")));
          return Response.json({ ok: true, head: { seq: 1 } });
        }
        return Response.json({ ok: true });
      },
    };
    const env = { BUCKET: { put: async () => undefined, delete: async () => undefined }, FLEET: { idFromName: (n: string) => n, get: () => stub } } as never;
    for (const manifest of [{ seq: 1, full: true, seal: "v1:abc" }, { seq: 2, full: true }]) {
      const bytes = Buffer.from(JSON.stringify(manifest));
      const header = Buffer.alloc(4);
      header.writeUInt32BE(bytes.length, 0);
      const url = new URL("https://gateway/fleets/acme/snapshot");
      await handleFleetRoutes({
        request: new Request(url, { method: "POST", headers: { "x-prime-device": "dev-a", "x-device-token": "t" }, body: Buffer.concat([header, bytes, Buffer.from("pack")]) }),
        env,
        url,
        cfg: { gatewayToken: "op-secret" } as never,
        authorizeDevice: async () => ({ ok: true as const }),
        unauthorized: () => new Response(null, { status: 401 }),
      });
    }
    expect(advances[0]!.meta.sealed).toBe(true);
    expect(advances[1]!.meta.sealed).toBeUndefined();
  });
});

describe("the Worker, asked for a place that another holds", () => {
  test("tells the check of whether the holder is connected since when the holder has held it, and vacates a holder that is not", async () => {
    const seen: Array<[string, number | undefined]> = [];
    const calls: string[] = [];
    const stub = {
      async fetch(input: Request | string) {
        const url = typeof input === "string" ? input : input.url;
        calls.push(url.replace("https://fleet", ""));
        if (url.endsWith("/role")) return Response.json({ member: true });
        if (url.endsWith("/bootstrap")) return Response.json({ ok: true, role: "replica", reason: "lease-held", holder: "dev-p", holderSince: 4242 });
        return Response.json({ ok: true });
      },
    };
    const env = { FLEET: { idFromName: (n: string) => n, get: () => stub } } as never;
    const url = new URL("https://gateway/fleets/acme/bootstrap");
    await handleFleetRoutes({
      request: new Request(url, { method: "POST", headers: { "x-prime-device": "dev-q", "x-device-token": "t" }, body: "{}" }),
      env,
      url,
      cfg: { gatewayToken: "op-secret" } as never,
      authorizeDevice: async () => ({ ok: true as const }),
      unauthorized: () => new Response(null, { status: 401 }),
      deviceOnline: async (device: string, since?: number) => {
        seen.push([device, since]);
        return false;
      },
    } as never);
    expect(seen).toEqual([["dev-p", 4242]]);
    expect(calls.filter((c) => c === "/vacate").length).toBe(1);
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

  // The tests below move the clock through the real path (every answer is the object's
  // own); nothing is written into its storage.
  async function withClock<T>(run: (advance: (ms: number) => void) => Promise<T>): Promise<T> {
    const real = Date.now;
    let now = real.call(Date);
    Date.now = () => now;
    try {
      return await run((ms) => {
        now += ms;
      });
    } finally {
      Date.now = real;
    }
  }

  // A replica that asks again when it was told to (and never catches up if it is given the claim),
  // and one that asks every 1.5 s whatever it is told.
  const patient = (d: FleetDO, dev: string) => {
    let at = 0;
    return async (now: number): Promise<string | undefined> => {
      if (now < at) return undefined;
      const answer = await ask(d, dev);
      at = answer.json.reason === "claimed" ? now + answer.json.retryAfterMs : now;
      return answer.json.reason as string;
    };
  };

  test("a holder that is alive and never catches up cannot hold the claim for ever, whatever asks it makes", () =>
    withClock(async (advance) => {
      const { doInstance, state } = await three();
      // dev-two asks every 1.5 s and never applies; dev-three asks when it is told to and does not apply either.
      const threeAsks = patient(doInstance, "dev-three");
      const turns: Array<[string, number]> = [];
      let t = 0;
      for (; t < 190_000; t += 1500) {
        const two = await ask(doInstance, "dev-two");
        const three = await threeAsks(t);
        const holder = two.json.reason === "not-caught-up" ? "dev-two" : three === "not-caught-up" ? "dev-three" : null;
        if (holder && turns[turns.length - 1]?.[0] !== holder) turns.push([holder, t]);
        const claim = state.data.get("claim") as { since: number; until: number };
        // However often it is renewed, a claim's total life is bounded.
        expect(claim.until).toBeLessThanOrEqual(claim.since + 60_000);
        advance(1500);
      }
      // dev-two has the claim for its life and no more; dev-three, who was told to wait, has the next one
      // (not dev-two again, which asked in that very second); then dev-two, which waited behind it.
      expect(turns.map(([d]) => d)).toEqual(["dev-two", "dev-three", "dev-two", "dev-three"]);
      expect(turns[1]![1]).toBeGreaterThanOrEqual(58_000);
      expect(turns[1]![1]).toBeLessThanOrEqual(64_000);
      expect(turns[2]![1] - turns[1]![1]).toBeLessThanOrEqual(64_000);
    }));

  test("the one that asked first is next, not one that asks more often", () =>
    withClock(async (advance) => {
      const { doInstance } = await three();
      const invite = await call(doInstance, "/invite", { caller: "admin", device: "dev-one", body: {} });
      await call(doInstance, "/join", { caller: "device", device: "dev-four", body: { code: invite.json.code } });
      await call(doInstance, "/approve", { caller: "admin", device: "operator", body: { deviceId: "dev-four" } });
      const threeAsks = patient(doInstance, "dev-three");
      const fourAsks = patient(doInstance, "dev-four");

      expect((await ask(doInstance, "dev-two")).json.reason).toBe("not-caught-up"); // takes the claim
      advance(2000);
      expect(await threeAsks(2000)).toBe("claimed"); // the first to wait
      advance(1000);
      expect(await fourAsks(3000)).toBe("claimed"); // the second
      // dev-two runs its claim out, asking every 1.5 s, and the two that wait ask when they were told to.
      let t = 3000;
      let first: string | null = null;
      for (; t < 66_000; t += 1500) {
        advance(1500);
        const two = (await ask(doInstance, "dev-two")).json.reason as string;
        const four = await fourAsks(t); // dev-four asks before dev-three in every round
        const three = await threeAsks(t);
        if (!first) first = two === "not-caught-up" ? null : four === "not-caught-up" ? "dev-four" : three === "not-caught-up" ? "dev-three" : null;
      }
      expect(first).toBe("dev-three");
    }));

  test("a holder nobody is waiting for may go on: the claim only changes hands when somebody asks", () =>
    withClock(async (advance) => {
      const { doInstance } = await three();
      expect((await ask(doInstance, "dev-two")).json.reason).toBe("not-caught-up");
      for (let t = 0; t < 70_000; t += 1500) {
        advance(1500);
        expect((await ask(doInstance, "dev-two")).json.reason).toBe("not-caught-up");
      }
    }));

  test("a replica that was told to wait and never came back loses its place", () =>
    withClock(async (advance) => {
      const { doInstance } = await three();
      await ask(doInstance, "dev-two");
      expect((await ask(doInstance, "dev-three")).json.reason).toBe("claimed"); // queued, then gone
      // dev-two's claim runs out without dev-three asking again; it is not kept waiting for.
      for (let t = 0; t < 120_000; t += 1500) {
        advance(1500);
        await ask(doInstance, "dev-two");
      }
      const two = await ask(doInstance, "dev-two");
      expect(two.json.reason).toBe("not-caught-up");
    }));

  test("a claim that lapses (its holder died half way) lets the next ask take over the catching up", () =>
    withClock(async (advance) => {
      const { doInstance } = await three();
      await ask(doInstance, "dev-two");
      advance(31_000);
      expect((await ask(doInstance, "dev-three")).json.reason).toBe("not-caught-up");
      expect((await ask(doInstance, "dev-two")).json.reason).toBe("claimed");
    }));

  test("the queue does not outlive the lease it was for: the claimant that caught up takes it, and the claim goes", () =>
    withClock(async (advance) => {
      const { doInstance, state } = await three();
      await ask(doInstance, "dev-two");
      await ask(doInstance, "dev-three");
      advance(5000);
      await call(doInstance, "/applied", { caller: "device", device: "dev-two", body: { seq: 1 } });
      expect((await ask(doInstance, "dev-two")).json.role).toBe("primary");
      expect(state.data.has("claim")).toBe(false);
    }));
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

describe("a report that arrives while the head is being written", () => {
  test("is not lost when the publish records its own seq", async () => {
    const bucket = fakeBucket();
    let hold: Promise<void> | null = null;
    const put = bucket.put.bind(bucket);
    bucket.put = (async (key: string, body: string, opts?: never) => {
      if (hold && key.endsWith("/head")) await hold; // the R2 write: other requests run meanwhile
      return put(key, body, opts);
    }) as typeof bucket.put;
    const { doInstance, state } = makeDo(bucket);
    await makeFleet(doInstance, "dev-one");
    const inv = await call(doInstance, "/invite", { caller: "admin", device: "dev-one", body: { autoApprove: true } });
    await call(doInstance, "/join", { caller: "device", device: "dev-two", body: { code: inv.json.code } });
    await call(doInstance, "/approve", { caller: "admin", device: "operator", body: { deviceId: "dev-two" } });
    await call(doInstance, "/bootstrap", { caller: "device", device: "dev-one" });
    await call(doInstance, "/head/advance", { caller: "device", device: "dev-one", body: { expectedSeq: 0, manifestKey: "m1", manifestHash: "h1" } });

    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    const advancing = call(doInstance, "/head/advance", { caller: "device", device: "dev-one", body: { expectedSeq: 1, manifestKey: "m2", manifestHash: "h2" } });
    await new Promise((r) => setTimeout(r, 10));
    await call(doInstance, "/applied", { caller: "device", device: "dev-two", body: { seq: 1 } });
    release();
    hold = null;
    expect((await advancing).status).toBe(200);
    expect(state.data.get("applied")).toEqual({ "dev-one": 2, "dev-two": 1 });
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
  async function publishVia(manifest: Record<string, unknown>, opts: { refuse?: boolean; refuseWith?: string; retained?: string[] } = {}) {
    const advances: Array<Record<string, any>> = [];
    const asked: string[][] = [];
    const stub = {
      async fetch(input: Request | string, init?: RequestInit) {
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("/role")) return Response.json({ member: true, primary: true, epoch: 1 });
        if (url.endsWith("/head/advance")) {
          advances.push(JSON.parse(String(init?.body ?? "{}")));
          if (opts.refuse) return Response.json({ error: opts.refuseWith ?? "stale sequence" }, { status: 409 });
          return Response.json({ ok: true, head: { seq: manifest.seq } });
        }
        if (url.endsWith("/unreferenced")) {
          const keys = (JSON.parse(String(init?.body ?? "{}")) as { keys: string[] }).keys;
          asked.push(keys);
          return Response.json({ keys: keys.filter((k) => !(opts.retained ?? []).includes(k)) });
        }
        return Response.json({ ok: true });
      },
    };
    const puts: string[] = [];
    const deleted: string[] = [];
    const env = {
      BUCKET: { put: async (key: string) => void puts.push(key), delete: async (key: string) => void deleted.push(key) },
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
    return { res, advances, puts, deleted, asked };
  }

  test("the object is told what a member needs to choose a route, and the change pack that goes with it", async () => {
    const delta = "fleets/acme/packs/" + "c".repeat(64);
    const { res, advances } = await publishVia({ seq: 4, full: true, packBytes: 1234, delta: { packKey: delta, bytes: 56 } });
    expect(res.status).toBe(200);
    expect(advances[0]!.expectedSeq).toBe(3);
    expect(advances[0]!.meta).toEqual({ full: true, packBytes: 1234, deltaBytes: 56 });
    expect(advances[0]!.extraKeys).toEqual([delta]);
  });

  test("a snapshot bigger than the Worker can hold is refused before it is read, with its size and the limit", async () => {
    const stub = { fetch: async () => Response.json({ member: true, primary: true }) };
    const reads: string[] = [];
    const env = { BUCKET: { put: async () => reads.push("put"), delete: async () => undefined }, FLEET: { idFromName: (n: string) => n, get: () => stub } } as never;
    const url = new URL("https://gateway/fleets/acme/snapshot");
    const request = new Request(url, {
      method: "POST",
      headers: { "x-prime-device": "dev-a", "x-device-token": "t", "content-length": String(MAX_SNAPSHOT_BYTES + 5 * 1024 * 1024) },
      body: Buffer.from("tiny"),
    });
    const res = (await handleFleetRoutes({
      request,
      env,
      url,
      cfg: { gatewayToken: "op-secret" } as never,
      authorizeDevice: async () => ({ ok: true as const }),
      unauthorized: () => new Response(null, { status: 401 }),
    }))!;
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; limit: number };
    expect(body.error).toMatch(/37 MB.*at most 32 MB/);
    expect(body.limit).toBe(MAX_SNAPSHOT_BYTES);
    expect(reads).toEqual([]);
  });

  test("a change pack bigger than the Worker can hold is refused the same way, before it is read and after it is", async () => {
    const puts: string[] = [];
    const stub = { fetch: async () => Response.json({ member: true, primary: true }) };
    const env = { BUCKET: { put: async (k: string) => puts.push(k), delete: async () => undefined }, FLEET: { idFromName: (n: string) => n, get: () => stub } } as never;
    const url = new URL("https://gateway/fleets/acme/packs");
    const send = async (headers: Record<string, string>, body: Buffer) =>
      (await handleFleetRoutes({
        request: new Request(url, { method: "POST", headers: { "x-prime-device": "dev-a", "x-device-token": "t", ...headers }, body }),
        env,
        url,
        cfg: { gatewayToken: "op-secret" } as never,
        authorizeDevice: async () => ({ ok: true as const }),
        unauthorized: () => new Response(null, { status: 401 }),
      }))!;
    const declared = await send({ "content-length": String(MAX_SNAPSHOT_BYTES + 5 * 1024 * 1024) }, Buffer.from("tiny"));
    expect(declared.status).toBe(413);
    expect(((await declared.json()) as { error: string }).error).toMatch(/change pack is 37 MB.*at most 32 MB/);
    const read = await send({}, Buffer.alloc(MAX_SNAPSHOT_BYTES + 1));
    expect(read.status).toBe(413);
    expect(puts).toEqual([]);
    expect((await send({}, Buffer.from("fits"))).status).toBe(200);
    expect(puts).toHaveLength(1);
  });

  test("a snapshot whose body is bigger than the limit is refused after it is read when its length was not declared", async () => {
    const puts: string[] = [];
    const stub = { fetch: async () => Response.json({ member: true, primary: true }) };
    const env = { BUCKET: { put: async (k: string) => puts.push(k), delete: async () => undefined }, FLEET: { idFromName: (n: string) => n, get: () => stub } } as never;
    const url = new URL("https://gateway/fleets/acme/snapshot");
    const res = (await handleFleetRoutes({
      request: new Request(url, { method: "POST", headers: { "x-prime-device": "dev-a", "x-device-token": "t" }, body: Buffer.alloc(MAX_SNAPSHOT_BYTES + 1) }),
      env,
      url,
      cfg: { gatewayToken: "op-secret" } as never,
      authorizeDevice: async () => ({ ok: true as const }),
      unauthorized: () => new Response(null, { status: 401 }),
    }))!;
    expect(res.status).toBe(413);
    expect(puts).toEqual([]);
  });

  test("the fleet tells a member the most an upload may be, so that it does not send what would be refused", async () => {
    const { doInstance } = makeDo(fakeBucket());
    await makeFleet(doInstance, "dev-owner");
    const role = await call(doInstance, "/role", { caller: "device", device: "dev-owner", method: "GET" });
    expect(role.json.snapshotLimit).toBe(MAX_SNAPSHOT_BYTES);
  });

  test("a publisher that predates sizes and the change pack publishes as it always did", async () => {
    const { res, advances } = await publishVia({ seq: 2, full: false });
    expect(res.status).toBe(200);
    expect(advances[0]!.meta).toEqual({ full: false });
    expect(advances[0]!.extraKeys).toEqual([]);
  });

  test("a publish the object refuses leaves nothing behind: the objects it stored are deleted, the change pack too", async () => {
    const delta = "fleets/acme/packs/" + "c".repeat(64);
    const { res, puts, deleted, asked } = await publishVia({ seq: 4, full: true, delta: { packKey: delta, bytes: 56 } }, { refuse: true });
    expect(res.status).toBe(409);
    expect(puts).toHaveLength(2);
    expect(asked).toHaveLength(1);
    expect(deleted.sort()).toEqual([...puts, delta].sort());
  });

  test("a publish refused with \"catch up first\" deletes what it stored too: the member stores the change pack again when it sends it", async () => {
    const delta = "fleets/acme/packs/" + "c".repeat(64);
    const { res, puts, deleted } = await publishVia({ seq: 4, full: true, delta: { packKey: delta, bytes: 56 } }, { refuse: true, refuseWith: "catch up first" });
    expect(res.status).toBe(409);
    expect(deleted.sort()).toEqual([...puts, delta].sort());
  });

  test("what a snapshot the fleet keeps names is not deleted, though the same bytes were sent again", async () => {
    const delta = "fleets/acme/packs/" + "c".repeat(64);
    const first = await publishVia({ seq: 4, full: true, delta: { packKey: delta, bytes: 56 } }, { refuse: true });
    const retained = first.puts; // the same request, sent twice: the first one made them the head's
    const again = await publishVia({ seq: 4, full: true, delta: { packKey: delta, bytes: 56 } }, { refuse: true, retained });
    expect(again.deleted).toEqual([delta]);
  });

  test("a publish that works deletes nothing", async () => {
    const { res, deleted, asked } = await publishVia({ seq: 4, full: false });
    expect(res.status).toBe(200);
    expect(deleted).toEqual([]);
    expect(asked).toEqual([]);
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

describe("which stored objects belong to no snapshot", () => {
  test("the object answers for its own fleet's packs and manifests that no retained snapshot names", async () => {
    const { doInstance } = makeDo();
    await makeFleet(doInstance, "dev-owner");
    const hex = (c: string) => c.repeat(64);
    const kept = "fleets/acme/manifests/" + hex("a");
    const keptPack = "fleets/acme/packs/" + hex("b");
    const orphan = "fleets/acme/packs/" + hex("c");
    const orphanManifest = "fleets/acme/manifests/" + hex("d");
    await call(doInstance, "/bootstrap", { caller: "device", device: "dev-owner", body: {} });
    const adv = await call(doInstance, "/head/advance", {
      caller: "device",
      device: "dev-owner",
      body: { expectedSeq: 0, manifestKey: kept, manifestHash: hex("a"), packKey: keptPack },
    });
    expect(adv.status).toBe(200);
    const asked = await call(doInstance, "/unreferenced", {
      caller: "device",
      device: "dev-owner",
      body: { keys: [kept, keptPack, orphan, orphanManifest, "fleets/other/packs/" + hex("e"), "fleets/acme/packs/../../x", "not a key"] },
    });
    expect(asked.status).toBe(200);
    expect(asked.json.keys).toEqual([orphan, orphanManifest]);
    // A device that is not a member is not answered.
    const stranger = await call(doInstance, "/unreferenced", { caller: "device", device: "dev-stranger", body: { keys: [orphan] } });
    expect(stranger.status).toBe(403);
  });
});
