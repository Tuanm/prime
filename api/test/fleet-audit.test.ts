// The fleet's audit log: what was done to it, by whom, in a chain that shows a change, bounded in size, and with
// nothing of what a call carried.
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
const A = await import("../src/fleet-audit");
const { AUDIT_BATCH, AUDIT_HARD, AUDIT_KEEP, AuditLog, GENESIS, actorOf, auditLimits, brokenAt, canonical, cleanDetail, describeCall, entryHash } = A;

const KEY = "A".repeat(43) + "=";
const KEY2 = "B".repeat(43) + "=";

beforeEach(() => setSystemTime(new Date("2026-12-01T10:00:00Z")));
afterEach(() => setSystemTime());

// ---- the log itself ---------------------------------------------------------------------------------------------

function memoryStore() {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(k: string) {
      return data.get(k) as T | undefined;
    },
    async put(k: string, v: unknown) {
      data.set(k, JSON.parse(JSON.stringify(v)));
    },
    async delete(keys: string[]) {
      return deleteRows(data, keys);
    },
    async list<T>(o: { prefix: string; start?: string; limit?: number; reverse?: boolean }) {
      return listRows(data, o) as Map<string, T>;
    },
  };
}
const op = { kind: "operator" } as const;
const note = (n: number) => ({ actor: op, action: "x", detail: { n } });
const rowsOf = (store: ReturnType<typeof memoryStore>) => [...store.data.values()] as import("../src/fleet-audit").AuditEntry[];

describe("the chain", () => {
  test("each entry carries the hash of the one before; the first carries the genesis; a change shows in the entry after it", async () => {
    const store = memoryStore();
    const log = new AuditLog(store, async () => {});
    for (let i = 0; i < 5; i++) await log.append(note(i));
    const rows = rowsOf(store);
    expect(rows.map((e) => e.n)).toEqual([1, 2, 3, 4, 5]);
    expect(rows[0]!.prev).toBe(GENESIS);
    expect(await brokenAt(rows)).toBeNull();
    expect(rows[1]!.prev).toBe(await entryHash(rows[0]!));
    // Changed, removed, reordered.
    const changed = structuredClone(rows);
    changed[2]!.action = "other";
    expect(await brokenAt(changed)).toBe(4);
    expect(await brokenAt([rows[0]!, rows[2]!, rows[3]!])).toBe(3);
    expect(await brokenAt([rows[1]!, rows[0]!, rows[2]!])).toBe(2);
    // A later part checks against the hash of what came before it.
    expect(await brokenAt(rows.slice(2), await entryHash(rows[1]!))).toBeNull();
    expect(await brokenAt(rows.slice(2), GENESIS)).toBe(3);
  });

  test("appends that run at once are still one after another: numbers are not shared and the chain holds", async () => {
    const store = memoryStore();
    const log = new AuditLog(store, async () => {});
    await Promise.all(Array.from({ length: 20 }, (_, i) => log.append(note(i))));
    const rows = rowsOf(store).sort((a, b) => a.n - b.n);
    expect(rows.map((e) => e.n)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await brokenAt(rows)).toBeNull();
  });

  test("a log that wakes up goes on from what is stored", async () => {
    const store = memoryStore();
    await new AuditLog(store, async () => {}).append(note(1));
    await new AuditLog(store, async () => {}).append(note(2));
    expect(await brokenAt(rowsOf(store))).toBeNull();
    expect(rowsOf(store).map((e) => e.n)).toEqual([1, 2]);
  });

  test("the same entry is the same bytes, whichever order its keys came in; nothing undefined is in it", () => {
    expect(canonical({ b: 1, a: { d: 2, c: [3, { z: 1, y: undefined }] } })).toBe('{"a":{"c":[3,{"z":1}],"d":2},"b":1}');
  });

  test("a detail keeps short plain values only: a long text is cut, an object or a list is left out", () => {
    const d = cleanDetail({ a: "x".repeat(500), b: 1, c: true, d: null, e: Number.NaN, f: { g: 1 } as never, h: [1] as never });
    expect(d!.a).toHaveLength(120);
    expect(Object.keys(d!).sort()).toEqual(["a", "b", "c", "d"]);
    expect(cleanDetail({})).toBeUndefined();
  });

  test("who: an operator call says by its header; a device is itself, whatever header it sends", () => {
    expect(actorOf("admin", "", null, false)).toEqual({ kind: "operator" });
    expect(actorOf("admin", "", "access:Ops@Example.com", false)).toEqual({ kind: "access", email: "Ops@Example.com" });
    expect(actorOf("admin", "", "access:service:ci-bot", false)).toEqual({ kind: "access", id: "service:ci-bot" });
    expect(actorOf("admin", "", "device:dev-9", false)).toEqual({ kind: "device", id: "dev-9" });
    expect(actorOf("admin", "", "gateway", false)).toEqual({ kind: "gateway" });
    expect(actorOf("admin", "", "fleet-token", false)).toEqual({ kind: "fleet-token" });
    expect(actorOf("admin", "", "access:", false)).toEqual({ kind: "operator" });
    expect(actorOf("admin", "", "whatever", false)).toEqual({ kind: "operator" });
    expect(actorOf("device", "dev-1", "access:evil@x.com", false)).toEqual({ kind: "device", id: "dev-1" });
    expect(actorOf("device", "dev-1", null, true)).toEqual({ kind: "owner", id: "dev-1" });
  });
});

describe("what a relayed call is called", () => {
  const body = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v)).buffer as ArrayBuffer;
  test("its method and the tool's name, never the arguments", () => {
    const secret = "sk-live-0123456789";
    expect(describeCall(body({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "files_read", arguments: { path: "/etc/passwd", token: secret } } }))).toBe("tools/call:files_read");
    expect(describeCall(body({ method: "tools/list" }))).toBe("tools/list");
    expect(describeCall(body({ method: "initialize", params: { name: "client" } }))).toBe("initialize");
  });
  test("what is not one call is a question mark", () => {
    expect(describeCall(body("not json"))).toBe("?");
    expect(describeCall(body("[]"))).toBe("batch");
    expect(describeCall(body("5"))).toBe("?");
    expect(describeCall(body({ no: "method" }))).toBe("?");
    expect(describeCall(new ArrayBuffer(0))).toBe("?");
    expect(describeCall(new ArrayBuffer(300 * 1024))).toBe("?");
  });
});

describe("size", () => {
  const L = { keep: 6, batch: 2, hard: 14 };
  const NAME = async () => "audit/acme/";
  const fill = async (log: InstanceType<typeof AuditLog>, n: number, from = 0) => {
    for (let i = 0; i < n; i++) await log.append(note(from + i));
  };
  const keep = (files: Map<string, string>) => async (name: string, body: string) => void files.set(name, body);

  test("the limits are the constants, and a setting can only lower them", () => {
    expect(auditLimits({})).toEqual({ keep: AUDIT_KEEP, batch: AUDIT_BATCH, hard: AUDIT_HARD });
    expect(auditLimits({ FLEET_AUDIT_KEEP: "6", FLEET_AUDIT_BATCH: "2" })).toEqual({ keep: 6, batch: 2, hard: 18 });
    for (const bad of ["20000", "3", "x", "", "6.5"]) expect(auditLimits({ FLEET_AUDIT_KEEP: bad }).keep).toBe(AUDIT_KEEP);
    expect(auditLimits({ FLEET_AUDIT_BATCH: "5000" }).batch).toBe(AUDIT_BATCH);
    expect(auditLimits({ FLEET_AUDIT_KEEP: "4", FLEET_AUDIT_BATCH: "900" }).batch).toBe(4);
  });

  test("past the limit the oldest batch goes to the bucket as one file and out of the object, and the chain runs across", async () => {
    const store = memoryStore();
    const files = new Map<string, string>();
    const log = new AuditLog(store, keep(files), NAME, Date.now, L);
    await fill(log, L.keep + L.batch - 1);
    expect(log.due()).toBe(false);
    await fill(log, 1, L.keep + L.batch);
    expect(log.due()).toBe(true);
    await log.trim();
    expect(log.due()).toBe(false);
    expect(store.data.size).toBe(L.keep);
    expect(files.size).toBe(1);
    const [name, text] = [...files][0]!;
    expect(name).toMatch(/^audit\/acme\/\d{13}-000000000001\.jsonl$/);
    const archived = text.trim().split("\n").map((l) => JSON.parse(l));
    expect(archived).toHaveLength(L.batch);
    expect(await brokenAt(archived)).toBeNull();
    const held = rowsOf(store).sort((a, b) => a.n - b.n);
    expect(held[0]!.n).toBe(L.batch + 1);
    // The first one held carries the hash of the last one that went.
    expect(await brokenAt(held, await entryHash(archived[archived.length - 1]), L.batch + 1)).toBeNull();
    // ...and a log that goes on, goes on from the head.
    await fill(log, 1, 0);
    expect(rowsOf(store).some((e) => e.n === L.keep + L.batch + 1)).toBe(true);
  });

  test("a reader that keeps the head it saw checks that the next entry is the one after it, not only that the hashes join", async () => {
    const store = memoryStore();
    const log = new AuditLog(store, async () => {});
    await fill(log, 4);
    const rows = rowsOf(store);
    expect(await brokenAt(rows.slice(2), await entryHash(rows[1]!), 3)).toBeNull();
    expect(await brokenAt(rows.slice(2), await entryHash(rows[1]!), 5)).toBe(3);
  });

  test("a copy that is in flight does not hold the log: an entry is written while it waits, and the trim then still deletes only what it copied", async () => {
    const store = memoryStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const files = new Map<string, string>();
    const log = new AuditLog(store, async (n, b) => (await gate, void files.set(n, b)), NAME, Date.now, L);
    await fill(log, L.keep + L.batch);
    const trimming = log.trim();
    await Bun.sleep(5);
    // Before: this waited for the copy, and a decision that waits inside a held object waited with it until the object was reset.
    const written = await Promise.race([log.append(note(99)).then(() => "written"), Bun.sleep(500).then(() => "stuck")]);
    expect(written).toBe("written");
    expect(await Promise.race([log.read(0, 5).then(() => "read"), Bun.sleep(500).then(() => "stuck")])).toBe("read");
    release();
    await trimming;
    expect(files.size).toBe(1);
    const held = rowsOf(store).sort((a, b) => a.n - b.n);
    expect(held.map((e) => e.n)).toEqual(Array.from({ length: L.keep + 1 }, (_, i) => i + L.batch + 1));
    expect(await brokenAt(held, held[0]!.prev)).toBeNull();
  });

  test("two trims do not run at once, and the second copies nothing", async () => {
    const store = memoryStore();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const log = new AuditLog(store, async () => (calls++, await gate), NAME, Date.now, L);
    await fill(log, L.keep + L.batch);
    const one = log.trim();
    const two = log.trim();
    await Bun.sleep(5);
    release();
    await Promise.all([one, two]);
    expect(calls).toBe(1);
  });

  test("a trim does nothing while the fleet's name is not known: nothing is archived under another name", async () => {
    const store = memoryStore();
    let calls = 0;
    const log = new AuditLog(store, async () => void calls++, async () => null, Date.now, L);
    await fill(log, L.keep + L.batch);
    await log.trim();
    expect(calls).toBe(0);
    expect(store.data.size).toBe(L.keep + L.batch);
    expect(await log.retire()).toBe(false);
    expect(store.data.size).toBe(L.keep + L.batch);
  });

  test("a bucket that will not take the file keeps the entries, and is asked again no sooner than a minute", async () => {
    const store = memoryStore();
    let asked = 0;
    const log = new AuditLog(store, async () => {
      asked++;
      throw new Error("bucket down");
    }, NAME, Date.now, L);
    const quiet = console.error;
    console.error = () => {};
    try {
      await fill(log, L.keep + L.batch);
      await log.trim();
      expect(store.data.size).toBe(L.keep + L.batch);
      expect(asked).toBe(1);
      await log.trim();
      expect(asked).toBe(1);
      setSystemTime(Date.now() + 61_000);
      await log.trim();
      expect(asked).toBe(2);
      expect(store.data.size).toBe(L.keep + L.batch);
    } finally {
      console.error = quiet;
    }
  });

  test("a bucket that is down for so long that the object holds the most it may drops the oldest batch, and says so in an entry", async () => {
    const store = memoryStore();
    const log = new AuditLog(store, async () => {
      throw new Error("bucket down");
    }, NAME, Date.now, L);
    const quiet = console.error;
    console.error = () => {};
    try {
      await fill(log, L.hard);
      await log.trim();
      const held = rowsOf(store).sort((a, b) => a.n - b.n);
      expect(held).toHaveLength(L.hard - L.batch + 1);
      const gap = held[held.length - 1]!;
      expect(gap.action).toBe("audit-dropped");
      expect(gap.detail).toEqual({ from: 1, to: L.batch });
      // The chain from the first entry that is left to the end is whole: the hole is before it, and the entry says where.
      expect(held[0]!.n).toBe(L.batch + 1);
      expect(await brokenAt(held, held[0]!.prev)).toBeNull();
    } finally {
      console.error = quiet;
    }
  });

  test("a fleet that is deleted has all it holds copied out, and the object holds none; a fleet of the name made after starts again", async () => {
    const store = memoryStore();
    const files = new Map<string, string>();
    const log = new AuditLog(store, keep(files), NAME, Date.now, L);
    await fill(log, 5);
    expect(await log.retire()).toBe(true);
    expect(store.data.size).toBe(0);
    expect([...files.values()].join("").trim().split("\n")).toHaveLength(5);
    await log.append(note(1));
    expect(rowsOf(store)[0]!.n).toBe(1);
    expect(rowsOf(store)[0]!.prev).toBe(GENESIS);
    expect(await new AuditLog(memoryStore(), async () => {}).retire()).toBe(true);
  });

  test("a copy in flight when the fleet is deleted does not hold the log either, and what is written meanwhile is copied too", async () => {
    const store = memoryStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const files = new Map<string, string>();
    const log = new AuditLog(store, async (n, b) => (await gate, void files.set(n, b)), NAME, Date.now, L);
    await fill(log, 3);
    const retiring = log.retire();
    await Bun.sleep(5);
    expect(await Promise.race([log.append(note(9)).then(() => "written"), Bun.sleep(500).then(() => "stuck")])).toBe("written");
    release();
    expect(await retiring).toBe(true);
    expect(store.data.size).toBe(0);
    expect([...files.values()].join("").trim().split("\n")).toHaveLength(4);
  });

  test("when the copy fails the entries stay where they are, and say so; the log carries on from them", async () => {
    const store = memoryStore();
    const log = new AuditLog(store, async () => {
      throw new Error("bucket down");
    }, NAME, Date.now, L);
    await fill(log, 3);
    const quiet = console.error;
    console.error = () => {};
    try {
      expect(await log.retire()).toBe(false);
    } finally {
      console.error = quiet;
    }
    expect(store.data.size).toBe(3);
    expect(await log.held()).toBe(3);
    await log.append(note(4));
    expect(await brokenAt(rowsOf(store))).toBeNull();
  });

  test("two readers that wake the log at once share one read, and neither sets the head back", async () => {
    const store = memoryStore();
    await fill(new AuditLog(store, async () => {}), 3);
    const fresh = new AuditLog(store, async () => {});
    const [a, b, written] = await Promise.all([fresh.read(0, 10), fresh.held(), fresh.append(note(4))]);
    expect(a.head.n === 3 || a.head.n === 4).toBe(true);
    expect(b).toBeGreaterThanOrEqual(3);
    expect(written.n).toBe(4);
    expect(rowsOf(store).map((e) => e.n)).toEqual([1, 2, 3, 4]);
  });
});

// ---- the fleet object --------------------------------------------------------------------------------------------

function world(env: Record<string, unknown> = {}) {
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
      return o ? { etag: o.etag, body: o.body, json: async () => JSON.parse(o.body) } : null;
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
    getWebSockets: () => [],
  };
  const fleet = new FleetDO(state as never, { BUCKET: bucket, REGISTRY: registry, ...env } as never);
  /** The same storage under an object that has just woken up, as after the platform let the other one go. */
  const wake = (more: Record<string, unknown> = {}) => new FleetDO(state as never, { BUCKET: bucket, REGISTRY: registry, ...env, ...more } as never);
  return { fleet, data, objects, failing, bucket, wake };
}
type World = ReturnType<typeof world>;

async function call(w: World, path: string, device: string, caller: "admin" | "device", body: Record<string, unknown> = {}, method = "POST", headers: Record<string, string> = {}) {
  const h = new Headers({ "content-type": "application/json", "x-prime-caller": caller, "x-prime-fleet": "acme", ...headers });
  if (device) h.set("x-prime-device", device);
  const res = await w.fleet.fetch(new Request("https://fleet" + path, { method, headers: h, body: method === "GET" ? undefined : JSON.stringify({ pubkey: KEY, ...body }) }));
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}
const asAccess = (email: string) => ({ "x-prime-actor": "access:" + email });

/** The whole log, read as the operator reads it. */
async function logOf(w: World) {
  const out: any[] = [];
  let after = 0;
  for (;;) {
    const r = await call(w, "/audit?after=" + after + "&limit=500", "", "admin", {}, "GET");
    expect(r.status).toBe(200);
    out.push(...r.json.entries);
    if (r.json.entries.length === 0 || r.json.entries[r.json.entries.length - 1].n >= r.json.head.n) return { entries: out, head: r.json.head, first: r.json.first, unrecorded: r.json.unrecorded };
    after = r.json.entries[r.json.entries.length - 1].n;
  }
}
const actions = (entries: any[]) => entries.map((e) => e.action);

/** A fleet, an invite and a member admitted (the owner, the first), with the log as it stands. */
async function fleetWith(ids: string[], env: Record<string, unknown> = {}) {
  const w = world(env);
  await call(w, "/create", "owner", "admin", {}, "POST", asAccess("ops@example.com"));
  for (const id of ids) {
    const invite = await call(w, "/invite", "owner", "admin", {}, "POST", asAccess("ops@example.com"));
    await call(w, "/join", id, "device", { code: invite.json.code });
    await call(w, "/approve", "operator", "admin", { deviceId: id }, "POST", asAccess("ops@example.com"));
  }
  return w;
}

describe("what is written down", () => {
  test("a fleet made, an invite, a request to join, an admission, in order, each by who did it, in a chain", async () => {
    const w = world();
    await call(w, "/create", "owner", "admin", {}, "POST", asAccess("Ops@Example.com"));
    const invite = await call(w, "/invite", "owner", "admin", { ttlMs: 600_000 }, "POST", asAccess("ops@example.com"));
    const joined = await call(w, "/join", "dev-a", "device", { code: invite.json.code, label: "laptop" });
    expect(joined.json.status).toBe("pending");
    await call(w, "/approve", "operator", "admin", { deviceId: "dev-a" });
    const { entries, head } = await logOf(w);
    expect(actions(entries)).toEqual(["fleet-created", "invite-created", "join-requested", "member-admitted"]);
    expect(entries.map((e: any) => e.actor)).toEqual([{ kind: "access", email: "Ops@Example.com" }, { kind: "access", email: "ops@example.com" }, { kind: "device", id: "dev-a" }, { kind: "operator" }]);
    expect(entries[2].target).toBe("dev-a");
    expect(entries[2].detail.label).toBe("laptop");
    expect(entries[3].detail.role).toBe("owner");
    expect(entries[1].detail).toEqual({ ttlMs: 600_000, expiresAt: Date.now() + 600_000 });
    expect(await brokenAt(entries)).toBeNull();
    expect(head).toEqual({ n: 4, hash: await entryHash(entries[3]) });
  });

  test("the invite's code is never in the log, and nor is a key, only its fingerprint", async () => {
    const w = world();
    await call(w, "/create", "owner", "admin");
    const invite = await call(w, "/invite", "owner", "admin");
    await call(w, "/join", "dev-a", "device", { code: invite.json.code });
    await call(w, "/approve", "operator", "admin", { deviceId: "dev-a" });
    const text = JSON.stringify([...w.data].filter(([k]) => k.startsWith("audit:")));
    expect(text).not.toContain(invite.json.code);
    expect(text).not.toContain(KEY);
    expect(text).toContain("key");
  });

  test("the owner, acting as its fleet's operator, is the owner in the log; an ordinary member's own act is a device's", async () => {
    const w = await fleetWith(["dev-a", "dev-b"]);
    const before = (await logOf(w)).entries.length;
    const invite = await call(w, "/invite", "owner-device", "device");
    expect(invite.status).toBe(403);
    // `fleetWith` made "dev-a" the owner, being the first member admitted.
    const own = await call(w, "/invite", "dev-a", "device");
    expect(own.status).toBe(200);
    await call(w, "/remove", "dev-b", "device", { deviceId: "dev-b" });
    const added = (await logOf(w)).entries.slice(before);
    expect(added.map((e: any) => [e.action, e.actor.kind, e.actor.id])).toEqual([
      ["invite-created", "owner", "dev-a"],
      ["member-removed", "device", "dev-b"],
    ]);
    expect(added[1].detail.self).toBe(true);
  });

  test("a device's own header cannot say it is somebody else", async () => {
    const w = await fleetWith(["dev-a"]);
    await call(w, "/invite", "dev-a", "device", {}, "POST", { "x-prime-actor": "access:evil@example.com" });
    const last = (await logOf(w)).entries.pop();
    expect(last.actor).toEqual({ kind: "owner", id: "dev-a" });
  });

  test("a removal says whether it was a member's own, whether it freed the lease, and who the fleet went to", async () => {
    const w = await fleetWith(["dev-a", "dev-b"]);
    await call(w, "/bootstrap", "dev-a", "device", { seals: true });
    await call(w, "/remove", "operator", "admin", { deviceId: "dev-a" });
    const removed = (await logOf(w)).entries.filter((e: any) => e.action === "member-removed").pop();
    expect(removed.target).toBe("dev-a");
    expect(removed.detail).toEqual({ self: false, wasOwner: true, freedLease: true, ownerTo: "dev-b" });
  });

  test("a request that is declined, and a request for another key that is declined", async () => {
    const w = await fleetWith(["dev-a"]);
    const invite = await call(w, "/invite", "dev-a", "device");
    await call(w, "/join", "dev-x", "device", { code: invite.json.code });
    await call(w, "/remove", "operator", "admin", { deviceId: "dev-x" });
    const again = await call(w, "/invite", "dev-a", "device");
    await call(w, "/join", "dev-a", "device", { code: again.json.code, pubkey: KEY2 });
    await call(w, "/remove", "operator", "admin", { deviceId: "dev-a", keyChange: true });
    const e = (await logOf(w)).entries.filter((x: any) => ["request-declined", "key-requested"].includes(x.action));
    expect(e.map((x: any) => [x.action, x.target, x.detail.keyChange])).toEqual([
      ["request-declined", "dev-x", false],
      ["key-requested", "dev-a", undefined],
      ["request-declined", "dev-a", true],
    ]);
  });

  test("a key that is replaced says by what: the operator's approval, or the proof of the old key; and which keys", async () => {
    const w = await fleetWith(["dev-a"]);
    const again = await call(w, "/invite", "dev-a", "device");
    await call(w, "/join", "dev-a", "device", { code: again.json.code, pubkey: KEY2 });
    await call(w, "/approve", "operator", "admin", { deviceId: "dev-a", key: await (await import("../src/fleets")).keyFingerprintLong(KEY2) });
    const replaced = (await logOf(w)).entries.filter((x: any) => x.action === "key-replaced");
    expect(replaced).toHaveLength(1);
    expect(replaced[0].detail.via).toBe("approved");
    expect(replaced[0].detail.key).not.toBe(replaced[0].detail.was);
    expect(replaced[0].actor).toEqual({ kind: "operator" });
  });

  test("invites revoked, the fleet changed (its lease, its label, its pause), each by the operator named", async () => {
    const w = await fleetWith(["dev-a"]);
    await call(w, "/invite", "dev-a", "device");
    await call(w, "/revoke", "operator", "admin", {}, "POST", asAccess("ops@example.com"));
    await call(w, "/meta", "operator", "admin", { leaseMs: 90_000, label: "Acme", disabled: true }, "POST", asAccess("ops@example.com"));
    await call(w, "/meta", "operator", "admin", { leaseMs: 90_000 });
    const e = (await logOf(w)).entries.slice(-2);
    expect(e[0].action).toBe("invites-revoked");
    expect(e[0].detail.count).toBe(1);
    expect(e[1].action).toBe("fleet-changed");
    expect(e[1].detail).toEqual({ paused: true, leaseMs: 90_000, label: "Acme" });
    expect(e[1].actor).toEqual({ kind: "access", email: "ops@example.com" });
  });

  test("the lease: a new holder is written, with the one it came from; a renewal never is", async () => {
    const w = await fleetWith(["dev-a", "dev-b"]);
    const before = (await logOf(w)).entries.length;
    const first = await call(w, "/bootstrap", "dev-a", "device", { seals: true });
    expect(first.json.role).toBe("primary");
    setSystemTime(Date.now() + 15_000);
    await call(w, "/bootstrap", "dev-a", "device", { seals: true });
    await call(w, "/lease/renew", "dev-a", "device", {});
    await call(w, "/bootstrap", "dev-b", "device", { seals: true });
    expect((await logOf(w)).entries.slice(before).map((e: any) => e.action)).toEqual(["lease-taken"]);
    // Gone silent, and taken by another.
    setSystemTime(Date.now() + 60_000);
    await call(w, "/bootstrap", "dev-b", "device", { seals: true });
    // Given up on purpose; vacated by the gateway.
    await call(w, "/lease/release", "dev-b", "device");
    await call(w, "/bootstrap", "dev-a", "device", { seals: true });
    await call(w, "/vacate", "", "admin", { deviceId: "dev-a" }, "POST", { "x-prime-actor": "gateway" });
    const e = (await logOf(w)).entries.slice(before);
    expect(e.map((x: any) => [x.action, x.target, x.actor.kind, x.detail.how, x.detail.from])).toEqual([
      ["lease-taken", "dev-a", "device", "free", undefined],
      ["lease-taken", "dev-b", "device", "expired", "dev-a"],
      ["lease-released", "dev-b", "device", undefined, undefined],
      ["lease-taken", "dev-a", "device", "free", undefined],
      ["lease-vacated", "dev-a", "gateway", undefined, undefined],
    ]);
    expect(e.map((x: any) => x.detail.epoch).filter((n: unknown) => n !== undefined)).toEqual([1, 2, 2, 3]);
  });

  test("a publish: who, the number, the manifest's hash, the epoch and the key it was made with", async () => {
    const w = await fleetWith(["dev-a"]);
    await call(w, "/bootstrap", "dev-a", "device", { seals: true });
    const manifest = "m".repeat(64);
    const done = await call(w, "/head/advance", "dev-a", "device", { expectedSeq: 0, manifestKey: "fleets/acme/manifests/" + manifest, manifestHash: manifest, packKey: "", meta: { sealed: true, full: true } });
    expect(done.status).toBe(200);
    const last = (await logOf(w)).entries.pop();
    expect(last.action).toBe("published");
    expect(last.actor).toEqual({ kind: "device", id: "dev-a" });
    expect(last.detail).toMatchObject({ seq: 1, manifest, epoch: 1 });
    expect(last.detail.key).toMatch(/^[A-Za-z0-9+/]{11}\.[A-Za-z0-9+/]{11}$/);
  });

  test("a relayed call is the method, the tool and the size, by the member that made it, and by the gateway when it came by the fleet's token", async () => {
    const w = await fleetWith(["dev-a"]);
    await call(w, "/bootstrap", "dev-a", "device", { seals: true });
    const member = await call(w, "/primary?audit=" + encodeURIComponent("tools/call:files_read") + "&bytes=312", "dev-a", "device", {}, "GET");
    expect(member.json.member).toBe(true);
    await call(w, "/primary?audit=tools%2Flist&bytes=40", "", "admin", {}, "GET", { "x-prime-actor": "fleet-token" });
    const [a, b] = (await logOf(w)).entries.slice(-2);
    expect([a.action, a.actor, a.target, a.detail]).toEqual(["relayed", { kind: "device", id: "dev-a" }, "dev-a", { method: "tools/call", tool: "files_read", bytes: 312 }]);
    expect([b.actor, b.detail]).toEqual([{ kind: "fleet-token" }, { method: "tools/list", bytes: 40 }]);
  });

  test("a call that has no primary to go to is not a relayed one: the Worker answers 503, and nothing is written", async () => {
    const w = await fleetWith(["dev-a"]);
    const n = (await logOf(w)).entries.length;
    expect((await call(w, "/primary?audit=tools%2Flist&bytes=40", "dev-a", "device", {}, "GET")).json.primary).toBeNull();
    expect((await call(w, "/primary?audit=tools%2Flist&bytes=40", "", "admin", {}, "GET", { "x-prime-actor": "fleet-token" })).json.primary).toBeNull();
    expect((await logOf(w)).entries.length).toBe(n);
  });

  test("a relayed call by one that is not a member, a question with no audit, and a gateway that turned it off, write nothing", async () => {
    const w = await fleetWith(["dev-a"]);
    const n = (await logOf(w)).entries.length;
    await call(w, "/primary?audit=tools%2Flist&bytes=40", "stranger", "device", {}, "GET");
    await call(w, "/primary", "dev-a", "device", {}, "GET");
    await call(w, "/primary", "", "admin", {}, "GET");
    expect((await logOf(w)).entries.length).toBe(n);
    const off = await fleetWith(["dev-a"], { FLEET_AUDIT_RELAY: "0" });
    const m = (await logOf(off)).entries.length;
    await call(off, "/primary?audit=tools%2Flist&bytes=40", "dev-a", "device", {}, "GET");
    expect((await logOf(off)).entries.length).toBe(m);
  });

  test("a method or tool that is not plain, and a size that is not a number, are what they are: a question mark and nothing", async () => {
    const w = await fleetWith(["dev-a"]);
    await call(w, "/bootstrap", "dev-a", "device", { seals: true });
    await call(w, "/primary?audit=" + encodeURIComponent("to ols:<script>") + "&bytes=abc", "dev-a", "device", {}, "GET");
    const last = (await logOf(w)).entries.pop();
    expect(last.detail).toEqual({ method: "?", tool: "?" });
  });

  test("a deleted fleet: the entry, and then all of the log is kept in the bucket outside the fleet's own prefix, while the object holds none", async () => {
    const w = await fleetWith(["dev-a"]);
    const n = (await logOf(w)).entries.length;
    const gone = await call(w, "/delete", "", "admin", { reason: "done" }, "POST", asAccess("ops@example.com"));
    expect(gone.status).toBe(200);
    expect(gone.json.auditKept).toBeUndefined();
    expect([...w.data.keys()].filter((k) => k.startsWith("audit:"))).toEqual([]);
    const files = [...w.objects.keys()].filter((k) => k.startsWith("audit/acme/"));
    expect(files).toHaveLength(1);
    const kept = w.objects.get(files[0]!)!.body.trim().split("\n").map((l) => JSON.parse(l));
    expect(kept).toHaveLength(n + 1);
    expect(kept.pop()).toMatchObject({ action: "fleet-deleted", actor: { kind: "access", email: "ops@example.com" }, detail: { reason: "done" } });
    expect(await brokenAt(kept)).toBeNull();
  });

  test("a delete of a name that is no fleet writes nothing, and a delete again after one writes nothing more", async () => {
    const w = world();
    expect((await call(w, "/delete", "", "admin")).status).toBe(200);
    expect([...w.objects.keys()].filter((k) => k.startsWith("audit/"))).toEqual([]);
    const f = await fleetWith(["dev-a"]);
    await call(f, "/delete", "", "admin");
    await call(f, "/delete", "", "admin");
    expect([...f.objects.keys()].filter((k) => k.startsWith("audit/"))).toHaveLength(1);
  });

  test("the last member leaving is the fleet's deletion, and both are written", async () => {
    const w = await fleetWith(["dev-a"]);
    await call(w, "/remove", "dev-a", "device", { deviceId: "dev-a" });
    const file = [...w.objects].find(([k]) => k.startsWith("audit/acme/"))!;
    const kept = file[1].body.trim().split("\n").map((l) => JSON.parse(l));
    expect(actions(kept).slice(-2)).toEqual(["member-removed", "fleet-deleted"]);
    expect(kept[kept.length - 1].detail.reason).toBe("the last member left");
  });

  test("a fleet of the name made again starts a log of its own", async () => {
    const w = await fleetWith(["dev-a"]);
    await call(w, "/delete", "", "admin");
    await call(w, "/create", "owner", "admin");
    const { entries } = await logOf(w);
    expect(entries.map((e: any) => [e.n, e.action])).toEqual([[1, "fleet-created"]]);
    expect(entries[0].prev).toBe(GENESIS);
  });

  test("the gateway's note that the fleet's token was set or cleared, and nothing else is taken as a note", async () => {
    const w = await fleetWith(["dev-a"]);
    expect((await call(w, "/note", "", "admin", { action: "fleet-token-set" }, "POST", asAccess("ops@example.com"))).status).toBe(200);
    expect((await call(w, "/note", "", "admin", { action: "fleet-token-cleared" })).status).toBe(200);
    expect((await call(w, "/note", "", "admin", { action: "member-admitted" })).status).toBe(400);
    expect((await call(w, "/note", "dev-a", "device", { action: "fleet-token-set" })).status).toBe(403);
    expect((await logOf(w)).entries.slice(-2).map((e: any) => [e.action, e.actor.kind])).toEqual([["fleet-token-set", "access"], ["fleet-token-cleared", "operator"]]);
  });
});

describe("the log's files are the fleet's own", () => {
  const raw = (f: FleetDOType, path: string, headers: Record<string, string>, body: unknown = {}) =>
    f.fetch(new Request("https://fleet" + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  type FleetDOType = InstanceType<typeof FleetDO>;

  test("an object woken by a request that does not say whose it is (the check of an invite) still files under its own name", async () => {
    const w = await fleetWith(["dev-a"]);
    const woken = w.wake();
    await raw(woken, "/invite-check", { "x-prime-caller": "admin" }, { code: "pf1_nope" });
    expect((await raw(woken, "/delete", { "x-prime-caller": "admin", "x-prime-fleet": "acme" })).status).toBe(200);
    expect([...w.objects.keys()].filter((k) => k.startsWith("audit/")).every((k) => k.startsWith("audit/acme/"))).toBe(true);
    expect([...w.objects.keys()].some((k) => k.startsWith("audit/unknown/"))).toBe(false);
  });

  test("a trim that a header-less wake leads to uses the name stored when the fleet was made, and says whose the file is", async () => {
    const w = await fleetWith(["dev-a"], { FLEET_AUDIT_KEEP: "4", FLEET_AUDIT_BATCH: "2" });
    const woken = w.wake();
    const stored = w.data.get("fleetName");
    expect(stored).toBe("acme");
    await raw(woken, "/invite-check", { "x-prime-caller": "admin" }, { code: "pf1_nope" });
    // Entries are made by calls that do say whose it is; a wake before them said nothing.
    for (let i = 0; i < 6; i++) await raw(woken, "/invite", { "x-prime-caller": "admin", "x-prime-fleet": "acme" });
    for (let i = 0; i < 40 && ![...w.objects.keys()].some((k) => k.startsWith("audit/")); i++) await Bun.sleep(10);
    const files = [...w.objects.keys()].filter((k) => k.startsWith("audit/"));
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((k) => k.startsWith("audit/acme/"))).toBe(true);
  });

  test("an object that has never been told its name archives nothing, rather than under another", async () => {
    const w = await fleetWith(["dev-a"], { FLEET_AUDIT_KEEP: "4", FLEET_AUDIT_BATCH: "2" });
    w.data.delete("fleetName");
    const woken = w.wake();
    // No request of this object says whose it is, so the entries stay in it.
    for (let i = 0; i < 6; i++) await raw(woken, "/invite", { "x-prime-caller": "admin" });
    await Bun.sleep(50);
    expect([...w.objects.keys()].filter((k) => k.startsWith("audit/"))).toEqual([]);
  });

  test("a decision made while the log is being copied to the bucket does not wait for the copy", async () => {
    const w = await fleetWith(["dev-a"], { FLEET_AUDIT_KEEP: "4", FLEET_AUDIT_BATCH: "2", FLEET_AUDIT_ARCHIVE_DELAY_MS: "600" });
    const started = Date.now();
    // This one's tail starts a trim (the fleet has more than keep + batch entries), which is then slow.
    await call(w, "/invite", "owner", "admin");
    const first = Date.now() - started;
    const t = Date.now();
    const during = await call(w, "/invite", "owner", "admin");
    expect(during.status).toBe(200);
    expect(Date.now() - t).toBeLessThan(400);
    expect(first).toBeLessThan(400);
    await Bun.sleep(900);
    expect([...w.objects.keys()].some((k) => k.startsWith("audit/acme/"))).toBe(true);
  });

  test("a delete while the bucket is down keeps the log: the answer says so, and a fleet made again carries on from it", async () => {
    const w = await fleetWith(["dev-a"]);
    const n = (await logOf(w)).entries.length;
    const put = w.bucket.put;
    w.bucket.put = async (k: string, b: string) => {
      if (k.startsWith("audit/")) throw new Error("bucket down");
      return put(k, b);
    };
    const quiet = console.error;
    console.error = () => {};
    let gone;
    try {
      gone = await call(w, "/delete", "", "admin");
    } finally {
      console.error = quiet;
    }
    expect(gone.status).toBe(200);
    expect(gone.json.auditKept).toBe(false);
    expect([...w.data.keys()].filter((k) => k.startsWith("audit:")).length).toBe(n + 1);
    expect(w.data.get("fleetName")).toBe("acme");
    w.bucket.put = put;
    await call(w, "/create", "owner", "admin");
    const { entries } = await logOf(w);
    expect(entries.slice(-2).map((e: any) => e.action)).toEqual(["fleet-deleted", "fleet-recreated"]);
    expect(await brokenAt(entries)).toBeNull();
  });

  test("a deleted fleet's log that could not be copied is read by the operator, and copied when the bucket is back", async () => {
    const w = await fleetWith(["dev-a"]);
    const n = (await logOf(w)).entries.length;
    const put = w.bucket.put;
    w.bucket.put = async (k: string, b: string) => {
      if (k.startsWith("audit/")) throw new Error("bucket down");
      return put(k, b);
    };
    const quiet = console.error;
    console.error = () => {};
    try {
      await call(w, "/delete", "", "admin");
      // Still down: the operator reads what the object holds; nobody else does.
      const read = await call(w, "/audit?tail=500", "", "admin", {}, "GET");
      expect(read.status).toBe(200);
      expect(read.json.entries.length).toBe(n + 1);
      expect(read.json.entries[read.json.entries.length - 1].action).toBe("fleet-deleted");
      expect((await call(w, "/audit", "dev-a", "device", {}, "GET")).status).toBe(403);
    } finally {
      console.error = quiet;
    }
    expect([...w.objects.keys()].some((k) => k.startsWith("audit/"))).toBe(false);
    // The bucket is back: the next read copies it, and then there is nothing to read.
    w.bucket.put = put;
    const copied = await call(w, "/audit?tail=500", "", "admin", {}, "GET");
    expect(copied.status).toBe(404);
    expect([...w.objects.keys()].some((k) => k.startsWith("audit/acme/"))).toBe(true);
    expect([...w.data.keys()].filter((k) => k.startsWith("audit:"))).toEqual([]);
    expect(w.data.get("fleetName")).toBeUndefined();
    expect(w.data.get("auditOrphan")).toBeUndefined();
  });

  test("a delete that copies the log leaves no name behind, and a file says which fleet it is of", async () => {
    const w = await fleetWith(["dev-a"]);
    await call(w, "/delete", "", "admin");
    expect(w.data.get("fleetName")).toBeUndefined();
    expect([...w.data.keys()].filter((k) => k.startsWith("audit:"))).toEqual([]);
  });
});

describe("who may read it", () => {
  test("the operator and the fleet's owner; no other member, and no stranger", async () => {
    const w = await fleetWith(["dev-a", "dev-b"]);
    expect((await call(w, "/audit", "", "admin", {}, "GET")).status).toBe(200);
    expect((await call(w, "/audit", "dev-a", "device", {}, "GET")).status).toBe(200);
    expect((await call(w, "/audit", "dev-b", "device", {}, "GET")).status).toBe(403);
    expect((await call(w, "/audit", "stranger", "device", {}, "GET")).status).toBe(403);
    expect((await call(world(), "/audit", "", "admin", {}, "GET")).status).toBe(404);
  });

  test("a page: after a number, at most the limit, with where the log stands and the oldest the object holds", async () => {
    const w = await fleetWith(["dev-a", "dev-b"]);
    const all = (await logOf(w)).entries;
    const page = await call(w, "/audit?after=2&limit=3", "", "admin", {}, "GET");
    expect(page.json.entries.map((e: any) => e.n)).toEqual([3, 4, 5]);
    expect(page.json.head).toEqual({ n: all.length, hash: await entryHash(all[all.length - 1]) });
    expect(page.json.first).toBe(1);
    expect((await call(w, "/audit?after=" + all.length, "", "admin", {}, "GET")).json.entries).toEqual([]);
    expect((await call(w, "/audit?limit=0&after=junk", "", "admin", {}, "GET")).json.entries.length).toBe(Math.min(100, all.length));
  });

  test("the newest entries, for a page that shows what happened last", async () => {
    const w = await fleetWith(["dev-a", "dev-b"]);
    const all = (await logOf(w)).entries;
    const last = await call(w, "/audit?tail=3", "", "admin", {}, "GET");
    expect(last.json.entries.map((e: any) => e.n)).toEqual(all.slice(-3).map((e: any) => e.n));
    expect((await call(w, "/audit?tail=1000", "", "admin", {}, "GET")).json.entries).toHaveLength(all.length);
  });
});

describe("when the log cannot be written", () => {
  test("what was decided stands, and the reader is told how many entries are missing", async () => {
    const w = await fleetWith(["dev-a"]);
    const quiet = console.error;
    console.error = () => {};
    try {
      w.failing.add("audit:");
      const invite = await call(w, "/invite", "dev-a", "device");
      expect(invite.status).toBe(200);
      expect(invite.json.code).toBeTruthy();
      await call(w, "/revoke", "dev-a", "device");
    } finally {
      console.error = quiet;
    }
    w.failing.clear();
    const read = await logOf(w);
    expect(read.unrecorded).toBe(2);
    expect(await brokenAt(read.entries)).toBeNull();
  });
});

// ---- through the gateway -----------------------------------------------------------------------------------------

describe("through the gateway", () => {
  const PEPPER = "test-pepper-0123456789abcdef0123456789";
  const OP = "operator-secret-0123456789abcdef0123";

  async function gateway(w: World, extra: Record<string, unknown> = {}) {
    const env: Record<string, unknown> = { TOKEN_PEPPER: PEPPER, ADMIN_ACCESS: "off", FLEET_OPERATOR_TOKEN: OP, ...extra };
    const tok = await verifierFor(env as never, "device", "token-for-dev-a");
    const stub = { fetch: (i: Request | string, init?: RequestInit) => w.fleet.fetch(typeof i === "string" ? new Request(i, init) : i) };
    const device = { requests: [] as Array<{ url: string; body: string }> };
    env.FLEET = { idFromName: (n: string) => n, get: () => stub };
    env.BUCKET = w.bucket;
    env.DEVICES = {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async (req: Request) => {
          device.requests.push({ url: req.url, body: await req.text() });
          return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
        },
      }),
    };
    env.REGISTRY = {
      idFromName: () => "global",
      get: () => ({
        fetch: async (input: string | Request) => {
          const path = new URL(typeof input === "string" ? input : input.url).pathname;
          if (path === "/map") return Response.json({ map: { "dev-a": tok }, anonymous: [], online: ["dev-a"], locked: {}, previous: {}, buddies: {}, paused: [], blocked: [], disabled: [] });
          if (path === "/usage") return Response.json({ spentUsd: 0, budgetUsd: 20, overBudget: false });
          return Response.json({ ok: true, fleets: [], buddies: [] });
        },
      }),
    };
    resetRegistryCache();
    return { env, device };
  }

  test("a relayed call is logged with its tool and size and never its arguments, and still reaches the primary whole", async () => {
    const w = await fleetWith(["dev-a"]);
    await call(w, "/bootstrap", "dev-a", "device", { seals: true });
    const { env, device } = await gateway(w);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "files_read", arguments: { path: "/secret/key", token: "sk-live-9999" } } });
    const res = await worker.fetch(
      new Request("https://gw.example/device/dev-a?fleet=acme", { method: "POST", headers: { "content-type": "application/json", "x-prime-device": "dev-a", "x-device-token": "token-for-dev-a", "cf-connecting-ip": "198.51.100.71" }, body }),
      env as never,
    );
    expect(res.status).toBe(200);
    expect(device.requests.map((r) => r.body)).toEqual([body]);
    const last = (await logOf(w)).entries.pop();
    expect(last.action).toBe("relayed");
    expect(last.detail).toEqual({ method: "tools/call", tool: "files_read", bytes: new TextEncoder().encode(body).length });
    expect(JSON.stringify(await logOf(w))).not.toContain("sk-live-9999");
    expect(JSON.stringify(await logOf(w))).not.toContain("/secret/key");
  });

  test("the operator reads it at /fleets/{fleet}/audit and the admin page at /admin/api/fleets/{fleet}/audit; a stranger does not", async () => {
    const w = await fleetWith(["dev-a"]);
    const { env } = await gateway(w);
    const get = (path: string, headers: Record<string, string>) => worker.fetch(new Request("https://gw.example" + path, { method: "GET", headers: { "cf-connecting-ip": "198.51.100.72", ...headers } }), env as never);
    const viaFleets = await get("/fleets/acme/audit?after=1&limit=2", { authorization: "Bearer " + OP });
    expect(viaFleets.status).toBe(200);
    const read = (await viaFleets.json()) as { entries: Array<{ n: number }> };
    expect(read.entries.map((e) => e.n)).toEqual([2, 3]);
    const viaAdmin = await get("/admin/api/fleets/acme/audit?limit=1", {});
    expect(viaAdmin.status).toBe(200);
    expect(((await viaAdmin.json()) as { entries: unknown[] }).entries).toHaveLength(1);
    expect((await get("/fleets/acme/audit", {})).status).toBe(401);
    expect((await get("/fleets/acme/audit", { "x-prime-device": "dev-a", "x-device-token": "token-for-dev-a" })).status).toBe(200);
  });

  test("the operator reads the log of a fleet that has been deleted from the bucket: the files, and each one's lines", async () => {
    const w = await fleetWith(["dev-a"]);
    await call(w, "/delete", "", "admin");
    const { env } = await gateway(w);
    const get = (path: string) => worker.fetch(new Request("https://gw.example" + path, { method: "GET", headers: { "cf-connecting-ip": "198.51.100.74" } }), env as never);
    expect((await call(w, "/audit", "", "admin", {}, "GET")).status).toBe(404);
    const listed = (await (await get("/admin/api/audit-archive/acme")).json()) as { files: Array<{ name: string }> };
    expect(listed.files).toHaveLength(1);
    const lines = (await (await get("/admin/api/audit-archive/acme?file=" + listed.files[0]!.name)).text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].action).toBe("fleet-created");
    expect(lines[lines.length - 1].action).toBe("fleet-deleted");
    expect((await get("/admin/api/audit-archive/acme?file=../fleets/acme/head")).status).toBe(400);
    expect((await get("/admin/api/audit-archive/acme?file=0000000000000-000000000999.jsonl")).status).toBe(404);
    expect((await get("/admin/api/audit-archive/Bad%20Name")).status).toBe(400);
  });

  test("the operator who sets the fleet's own token is written down, without the token", async () => {
    const w = await fleetWith(["dev-a"]);
    const { env } = await gateway(w);
    const res = await worker.fetch(
      new Request("https://gw.example/admin/api/fleets/acme/buddy", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.73" }, body: JSON.stringify({ token: "fleet-token-secret-1" }) }),
      env as never,
    );
    expect(res.status).toBe(200);
    const last = (await logOf(w)).entries.pop();
    expect(last.action).toBe("fleet-token-set");
    expect(JSON.stringify(last)).not.toContain("fleet-token-secret-1");
  });
});
