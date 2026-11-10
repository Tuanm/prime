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
  const response = await doInstance.fetch(
    new Request("https://fleet" + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
  );
  return { status: response.status, json: (await response.json()) as Record<string, any> };
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
    const created = await call(doInstance, "/create", { caller: "admin", device: "dev-owner" });
    expect(created.status).toBe(200);
    expect(created.json.member.role).toBe("owner");
    const again = await call(doInstance, "/create", { caller: "admin", device: "dev-other" });
    expect(again.status).toBe(409);
  });

  test("a device can create a fleet of its own", async () => {
    const { doInstance } = makeDo();
    const created = await call(doInstance, "/create", { caller: "device", device: "dev-first" });
    expect(created.status).toBe(200);
    expect(created.json.member.deviceId).toBe("dev-first");
    expect(created.json.member.role).toBe("owner");
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
    await call(doInstance, "/create", { caller: "admin", device: "dev-owner" });
    const inv = await call(doInstance, "/invite", { caller: "admin", device: "dev-owner", body: {} });
    expect(inv.status).toBe(200);
    expect(inviteShape(inv.json.code)).toBe(true);
    const stored = JSON.stringify(state.data.get("invites"));
    expect(stored).not.toContain(inv.json.code);
    expect(stored).toContain(await hashCode(inv.json.code));
  });

  test("a device cannot mint an invite", async () => {
    const { doInstance } = makeDo();
    await call(doInstance, "/create", { caller: "admin", device: "dev-owner" });
    const inv = await call(doInstance, "/invite", { caller: "device", device: "dev-owner", body: {} });
    expect(inv.status).toBe(403);
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
    await call(doInstance, "/create", { caller: "admin", device: "dev-owner" });
    const inv = await call(doInstance, "/invite", { caller: "admin", device: "dev-owner", body: {} });
    const joined = await call(doInstance, "/join", { caller: "device", device: "dev-new", body: { code: inv.json.code, label: "laptop" } });
    expect(joined.status).toBe(200);
    expect(joined.json.status).toBe("pending");
    const me = await call(doInstance, "/me", { caller: "device", device: "dev-new", method: "GET" });
    expect(me.json.status).toBe("pending");
  });

  test("an unknown code is refused, and a code is single use", async () => {
    const { doInstance } = makeDo();
    await call(doInstance, "/create", { caller: "admin", device: "dev-owner" });
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
    await call(doInstance, "/create", { caller: "admin", device: "dev-owner" });
    const inv = await call(doInstance, "/invite", { caller: "admin", device: "dev-owner", body: { ttlMs: 1 } });
    await new Promise((r) => setTimeout(r, 10));
    const joined = await call(doInstance, "/join", { caller: "device", device: "dev-late", body: { code: inv.json.code } });
    expect(joined.status).toBe(403);
    expect(Object.keys((state.data.get("invites") as Record<string, unknown>) ?? {})).toHaveLength(0);
  });

  test("auto-approve admits immediately", async () => {
    const { doInstance } = makeDo();
    await call(doInstance, "/create", { caller: "admin", device: "dev-owner" });
    const inv = await call(doInstance, "/invite", { caller: "admin", device: "dev-owner", body: { autoApprove: true } });
    const joined = await call(doInstance, "/join", { caller: "device", device: "dev-fast", body: { code: inv.json.code } });
    expect(joined.json.status).toBe("member");
    expect(joined.json.member.role).toBe("member");
  });

  test("re-joining when already a member is idempotent", async () => {
    const { doInstance } = makeDo();
    await call(doInstance, "/create", { caller: "admin", device: "dev-owner" });
    const inv = await call(doInstance, "/invite", { caller: "admin", device: "dev-owner", body: { autoApprove: true } });
    await call(doInstance, "/join", { caller: "device", device: "dev-fast", body: { code: inv.json.code } });
    const again = await call(doInstance, "/join", { caller: "device", device: "dev-fast", body: { code: newInviteCode() } });
    expect(again.status).toBe(200);
    expect(again.json.status).toBe("member");
  });

  test("an operator cannot join as a device", async () => {
    const { doInstance } = makeDo();
    await call(doInstance, "/create", { caller: "admin", device: "dev-owner" });
    const joined = await call(doInstance, "/join", { caller: "admin", device: "dev-owner", body: { code: newInviteCode() } });
    expect(joined.status).toBe(403);
  });
});

describe("approval and removal", () => {
  test("approve promotes a pending request to member", async () => {
    const { doInstance } = makeDo();
    await call(doInstance, "/create", { caller: "admin", device: "dev-owner" });
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
    await call(doInstance, "/create", { caller: "admin", device: "dev-owner" });
    const approved = await call(doInstance, "/approve", { caller: "admin", device: "dev-owner", body: { deviceId: "ghost" } });
    expect(approved.status).toBe(404);
  });

  test("the owner cannot remove itself, but can remove a member", async () => {
    const { doInstance } = makeDo();
    await call(doInstance, "/create", { caller: "admin", device: "dev-owner" });
    const inv = await call(doInstance, "/invite", { caller: "admin", device: "dev-owner", body: { autoApprove: true } });
    await call(doInstance, "/join", { caller: "device", device: "dev-m", body: { code: inv.json.code } });
    expect((await call(doInstance, "/remove", { caller: "admin", device: "dev-owner", body: { deviceId: "dev-owner" } })).status).toBe(409);
    expect((await call(doInstance, "/remove", { caller: "admin", device: "dev-owner", body: { deviceId: "dev-m" } })).status).toBe(200);
    const me = await call(doInstance, "/me", { caller: "device", device: "dev-m", method: "GET" });
    expect(me.json.status).toBe("none");
  });

  test("revoke invalidates every outstanding invite", async () => {
    const { doInstance } = makeDo();
    await call(doInstance, "/create", { caller: "admin", device: "dev-owner" });
    const inv = await call(doInstance, "/invite", { caller: "admin", device: "dev-owner", body: {} });
    const revoked = await call(doInstance, "/revoke", { caller: "admin", device: "dev-owner", body: {} });
    expect(revoked.json.revoked).toBe(1);
    expect((await call(doInstance, "/join", { caller: "device", device: "dev-z", body: { code: inv.json.code } })).status).toBe(403);
  });
});

describe("caps", () => {
  test("the member cap refuses further admissions", async () => {
    const { doInstance } = makeDo();
    await call(doInstance, "/create", { caller: "admin", device: "dev-owner" });
    // Fill to MAX_MEMBERS - 1 extra via auto-approved invites.
    for (let i = 0; i < MAX_MEMBERS - 1; i++) {
      const inv = await call(doInstance, "/invite", { caller: "admin", device: "dev-owner", body: { autoApprove: true } });
      const joined = await call(doInstance, "/join", { caller: "device", device: "dev-" + i, body: { code: inv.json.code } });
      expect(joined.json.status).toBe("member");
    }
    const roster = await call(doInstance, "/members", { caller: "admin", device: "dev-owner", method: "GET" });
    expect(roster.json.members).toHaveLength(MAX_MEMBERS);
    const over = await call(doInstance, "/invite", { caller: "admin", device: "dev-owner", body: { autoApprove: true } });
    const refused = await call(doInstance, "/join", { caller: "device", device: "dev-overflow", body: { code: over.json.code } });
    expect(refused.status).toBe(409);
  });
});

describe("bootstrap", () => {
  test("the first member with no state becomes primary", async () => {
    const { doInstance } = makeDo();
    await call(doInstance, "/create", { caller: "admin", device: "dev-owner" });
    const boot = await call(doInstance, "/bootstrap", { caller: "device", device: "dev-owner", body: {} });
    expect(boot.json.role).toBe("primary");
    expect(boot.json.epoch).toBe(1);
  });

  test("a second member cannot also become primary while the lease is held", async () => {
    const { doInstance } = makeDo();
    await call(doInstance, "/create", { caller: "admin", device: "dev-owner" });
    const inv = await call(doInstance, "/invite", { caller: "admin", device: "dev-owner", body: { autoApprove: true } });
    await call(doInstance, "/join", { caller: "device", device: "dev-two", body: { code: inv.json.code } });
    const first = await call(doInstance, "/bootstrap", { caller: "device", device: "dev-owner", body: {} });
    const second = await call(doInstance, "/bootstrap", { caller: "device", device: "dev-two", body: {} });
    expect(first.json.role).toBe("primary");
    expect(second.json.role).toBe("replica");
    expect(second.json.reason).toBe("lease-held");
  });

  test("a non-member cannot bootstrap", async () => {
    const { doInstance } = makeDo();
    await call(doInstance, "/create", { caller: "admin", device: "dev-owner" });
    const boot = await call(doInstance, "/bootstrap", { caller: "device", device: "dev-intruder", body: {} });
    expect(boot.status).toBe(403);
  });
});

describe("head advance", () => {
  test("the lease holder advances the head, and a stale sequence is refused", async () => {
    const { doInstance, bucket } = makeDo();
    await call(doInstance, "/create", { caller: "admin", device: "dev-owner" });
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
    await call(doInstance, "/create", { caller: "admin", device: "dev-owner" });
    const inv = await call(doInstance, "/invite", { caller: "admin", device: "dev-owner", body: { autoApprove: true } });
    await call(doInstance, "/join", { caller: "device", device: "dev-two", body: { code: inv.json.code } });
    await call(doInstance, "/bootstrap", { caller: "device", device: "dev-owner", body: {} });
    const res = await call(doInstance, "/head/advance", { caller: "device", device: "dev-two", body: { expectedSeq: 0, manifestKey: "evil", manifestHash: "evil" } });
    expect(res.status).toBe(409);
  });

  test("the head survives losing the object's storage, because it lives in R2", async () => {
    const { doInstance, state, bucket } = makeDo();
    await call(doInstance, "/create", { caller: "admin", device: "dev-owner" });
    await call(doInstance, "/bootstrap", { caller: "device", device: "dev-owner", body: {} });
    await call(doInstance, "/head/advance", { caller: "device", device: "dev-owner", body: { expectedSeq: 0, manifestKey: "m1", manifestHash: "h1" } });
    // simulate the object losing everything it had locally
    state.data.clear();
    const created = await call(doInstance, "/create", { caller: "admin", device: "dev-owner" });
    expect(created.status).toBe(200); // membership is gone, as expected
    const head = JSON.parse(bucket.objects.get("fleets/acme/head")!.body);
    expect(head.seq).toBe(1);
    expect(head.manifestKey).toBe("m1");
  });
});