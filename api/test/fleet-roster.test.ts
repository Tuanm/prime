// The owner-signed roster: the chain the gateway keeps, the changes it applies from it, and what it refuses without it.
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
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
const { handleFleetRoutes } = await import("../src/fleets-routes");
const { fleetKeyOf, ROSTER_MAX_ENTRIES } = await import("../src/fleet-roster");
const { FENCE_TTL_MS } = await import("../src/fleets");
const witness = await import("../witness/src/lib");

beforeEach(() => setSystemTime(new Date("2026-12-01T10:00:00Z")));
afterEach(() => setSystemTime());

// ---- the CLI's end of it: keys, entries, signatures ----------------------------------------------------------------

/** A distinct valid member key for each name. */
const xpubOf = (name: string): string => {
  const raw = createHash("sha256").update("xpub:" + name).digest();
  return raw.toString("base64");
};
interface Signer {
  pub: string;
  sign(entry: unknown[]): string;
}
function signer(): Signer {
  const pair = generateKeyPairSync("ed25519");
  const pub = String(pair.publicKey.export({ format: "jwk" }).x);
  return { pub, sign: (entry) => cryptoSign(null, Buffer.from(JSON.stringify(entry)), pair.privateKey).toString("base64url") };
}
const hashOf = (s: { entry: unknown[]; sig: string }): string =>
  createHash("sha256").update(Buffer.from(JSON.stringify(s.entry))).update(Buffer.from(s.sig, "base64url")).digest("base64url");

type Signed = { entry: any[]; sig: string };

/** What the operator's machine holds: the owner key and the chain it has made. */
class Chain {
  entries: Signed[] = [];
  constructor(
    readonly fleet: string,
    readonly incarnation: string,
    readonly owner: Signer = signer(),
  ) {}
  make(op: string, f: { device?: string; xpub?: string; spub?: string; role?: string; seqAt?: number; extra?: string } = {}, by: Signer = this.owner, at = 0): Signed {
    const last = this.entries[this.entries.length - 1];
    const entry = ["prime-roster-v1", this.fleet, this.incarnation, this.entries.length, last ? hashOf(last) : null, at || Date.now(), op, f.device ?? null, f.xpub ?? null, f.spub ?? null, f.role ?? null, f.seqAt ?? null, f.extra ?? null];
    return { entry, sig: by.sign(entry) };
  }
  genesis(): Signed {
    return this.make("genesis", { seqAt: 0, extra: this.owner.pub });
  }
  accept(s: Signed): void {
    this.entries.push(s);
  }
}

// ---- the fleet object ----------------------------------------------------------------------------------------------

function world() {
  const data = new Map<string, unknown>();
  let tail: Promise<unknown> = Promise.resolve();
  const storage = {
    async get(key: string) {
      const v = data.get(key);
      return v === undefined ? undefined : structuredClone(v);
    },
    async put(key: string, value: unknown) {
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
  let n = 0;
  const bucket = {
    gate: undefined as undefined | Promise<void>,
    reached: undefined as undefined | (() => void),
    async get(key: string) {
      const o = objects.get(key);
      return o ? { etag: o.etag, json: async () => JSON.parse(o.body) } : null;
    },
    async put(key: string, body: string, opts?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
      if (key.endsWith("/head") && bucket.gate) {
        bucket.reached?.();
        await bucket.gate;
      }
      const cur = objects.get(key);
      const cond = opts?.onlyIf;
      if (cond?.etagMatches !== undefined && cur?.etag !== cond.etagMatches) return null;
      if (cond?.etagDoesNotMatch === "*" && cur) return null;
      const etag = "e" + n++;
      objects.set(key, { body, etag });
      return { etag };
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
    async list(o: { prefix?: string }) {
      return { objects: [...objects.keys()].filter((k) => k.startsWith(o.prefix ?? "")).map((key) => ({ key })), truncated: false };
    },
  };
  const registry = { idFromName: () => "global", get: () => ({ fetch: async () => Response.json({ ok: true }) }) };
  const sent: string[] = [];
  const hung: string[] = [];
  const state = {
    storage,
    blockConcurrencyWhile: <T>(fn: () => Promise<T>): Promise<T> => {
      const run = tail.then(fn, fn);
      tail = run.catch(() => undefined);
      return run;
    },
    getWebSockets: () => [{ send: (m: string) => void sent.push(m), close() {} }],
  };
  const fleet = new FleetDO(state as never, { BUCKET: bucket, REGISTRY: registry } as never);
  return { fleet, data, objects, bucket, sent, hung };
}
type World = ReturnType<typeof world>;

async function call(w: World, path: string, device: string, caller: "admin" | "device", body: Record<string, unknown> = {}, method = "POST") {
  const h = new Headers({ "content-type": "application/json", "x-prime-caller": caller, "x-prime-fleet": "acme" });
  if (device) h.set("x-prime-device", device);
  const res = await w.fleet.fetch(new Request("https://fleet" + path, { method, headers: h, body: method === "GET" ? undefined : JSON.stringify(body) }));
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

const SPUBS = new Map<string, Signer>();
/** The signing key a device keeps beside its sealing key. */
const sKey = (name: string): Signer => {
  let s = SPUBS.get(name);
  if (!s) SPUBS.set(name, (s = signer()));
  return s;
};

/** A device asks to join with its keys, and the operator admits it as the open roster does. */
async function admit(w: World, name: string, as?: string) {
  const invite = await call(w, "/invite", "operator", "admin");
  const joined = await call(w, "/join", name, "device", { code: invite.json.code, pubkey: xpubOf(name), spub: sKey(name).pub, label: name, ...(as ? { role: as } : {}) });
  expect(joined.status).toBe(200);
  const done = await call(w, "/approve", "operator", "admin", { deviceId: name, ...(as ? { role: as } : {}) });
  expect(done.status).toBe(200);
}
/** A device asks to join, and waits. */
async function knock(w: World, name: string, extra: Record<string, unknown> = {}) {
  const invite = await call(w, "/invite", "operator", "admin");
  const joined = await call(w, "/join", name, "device", { code: invite.json.code, pubkey: xpubOf(name), spub: sKey(name).pub, label: name, ...extra });
  expect(joined.json.status).toBe("pending");
}

async function openFleet(names = ["owner", "dev-a"]) {
  const w = world();
  await call(w, "/create", "", "admin");
  await w.fleet.fetch(new Request("https://fleet/role", { headers: { "x-prime-caller": "device", "x-prime-device": "x", "x-prime-fleet": "acme" } }));
  for (const name of names) await admit(w, name);
  return w;
}

const incarnationOf = async (w: World): Promise<string> => (await call(w, "/roster", "operator", "admin", {}, "GET")).json.incarnation;
const post = (w: World, s: Signed, device = "operator", caller: "admin" | "device" = "admin") => call(w, "/roster", device, caller, s as never);

/** Put the fleet under the owner key as `roster init` does: a genesis and an add for each member. */
async function signedFleet(names = ["owner", "dev-a"], extraRoles: Record<string, string> = {}) {
  const w = await openFleet(names);
  const chain = new Chain("acme", await incarnationOf(w));
  const g = chain.genesis();
  expect((await post(w, g)).status).toBe(200);
  chain.accept(g);
  for (const name of names) {
    const members = (await call(w, "/members", "", "admin", {}, "GET")).json.members as Array<{ deviceId: string; role: string }>;
    const role = members.find((m) => m.deviceId === name)!.role;
    const add = chain.make("add", { device: name, xpub: xpubOf(name), spub: sKey(name).pub, role: extraRoles[name] ?? role, seqAt: 0 });
    const res = await post(w, add);
    expect(res.status).toBe(200);
    chain.accept(add);
  }
  return { w, chain };
}

const publish = async (w: World, device: string, seq: number, tag = "a") => {
  const manifest = "fleets/acme/manifests/" + tag.repeat(64);
  return call(w, "/head/advance", device, "device", { expectedSeq: seq - 1, manifestKey: manifest, manifestHash: tag.repeat(64), packKey: "", meta: { sealed: true } });
};
const lead = async (w: World, device: string) => {
  const res = await call(w, "/bootstrap", device, "device", { seals: true });
  expect(res.json.role).toBe("primary");
};

// ---- tests ---------------------------------------------------------------------------------------------------------

describe("what the gateway keeps of a member's signing key", () => {
  test("is told when the member joins, listed to the operator and the owner, and waits with the request", async () => {
    const w = world();
    await call(w, "/create", "", "admin");
    await admit(w, "owner");
    await knock(w, "dev-a", { role: "viewer" });
    const pending = (await call(w, "/pending", "operator", "admin", {}, "GET")).json.pending[0];
    expect(pending).toMatchObject({ deviceId: "dev-a", spub: sKey("dev-a").pub, role: "viewer" });
    await call(w, "/approve", "operator", "admin", { deviceId: "dev-a" });
    const members = (await call(w, "/members", "", "admin", {}, "GET")).json.members as Array<{ deviceId: string; spub?: string }>;
    expect(members.map((m) => [m.deviceId, m.spub])).toEqual([["owner", sKey("owner").pub], ["dev-a", sKey("dev-a").pub]]);
    // Anything that is not a key is not kept.
    await knock(w, "dev-b", { spub: "not a key" });
    expect((await call(w, "/pending", "operator", "admin", {}, "GET")).json.pending.find((p: any) => p.deviceId === "dev-b").spub).toBeUndefined();
  });

  test("is taken from a member that has none, on its next round, while the roster is the gateway's own", async () => {
    const w = world();
    await call(w, "/create", "", "admin");
    const invite = await call(w, "/invite", "operator", "admin");
    await call(w, "/join", "old", "device", { code: invite.json.code, pubkey: xpubOf("old") });
    await call(w, "/approve", "operator", "admin", { deviceId: "old" });
    await call(w, "/bootstrap", "old", "device", { seals: true, spub: sKey("old").pub });
    const members = (await call(w, "/members", "", "admin", {}, "GET")).json.members as Array<{ spub?: string }>;
    expect(members[0]!.spub).toBe(sKey("old").pub);
  });
});

describe("putting a fleet under the owner key", () => {
  test("a fleet is open until its genesis is stored, and says which fleet of the name it is", async () => {
    const w = await openFleet();
    const before = (await call(w, "/roster", "dev-a", "device", {}, "GET")).json;
    expect(before).toMatchObject({ mode: "open", entries: [] });
    expect(typeof before.incarnation).toBe("string");
    expect(before.incarnation).toBe((await call(w, "/role", "dev-a", "device", {}, "GET")).json.incarnation);
    expect((await call(w, "/role", "dev-a", "device", {}, "GET")).json.rosterSigned).toBe(false);
  });

  test("the genesis, then an add for each member (as of snapshot 0), and then the fleet is signed", async () => {
    const { w, chain } = await signedFleet();
    const read = (await call(w, "/roster", "dev-a", "device", {}, "GET")).json;
    expect(read.mode).toBe("signed");
    expect(read.entries).toEqual(chain.entries);
    expect(read.head).toEqual({ n: 2, hash: hashOf(chain.entries[2]!) });
    expect((await call(w, "/role", "dev-a", "device", {}, "GET")).json.rosterSigned).toBe(true);
    // The witness's name for the fleet is the same, whoever works it out.
    expect(read.fleetKey).toBe(await witness.fleetKeyOf(chain.entries[0]!.entry));
    expect(read.fleetKey).toBe(await fleetKeyOf(chain.entries[0]!.entry));
    // What the roster says is what the witness's proof reads of an entry.
    const proofOf = await witness.checkProof(
      { cp: ["prime-cp-v1", read.fleetKey, "acme", read.incarnation, 1, "h".repeat(8), 2, Date.now()], sig: "x", spub: sKey("dev-a").pub, proof: { genesis: chain.entries[0]!.entry, entry: chain.entries[2]!.entry, sig: chain.entries[2]!.sig } } as never,
      read.fleetKey,
    );
    expect(proofOf.ok).toBe(true);
  });

  test("a member reads from a place on (after), and a stranger reads nothing", async () => {
    const { w } = await signedFleet();
    const tail = (await call(w, "/roster?after=1", "dev-a", "device", {}, "GET")).json;
    expect(tail.entries.map((e: Signed) => e.entry[3])).toEqual([2]);
    expect((await call(w, "/roster", "stranger", "device", {}, "GET")).status).toBe(403);
    expect((await call(w, "/roster", "operator", "admin", {}, "GET")).status).toBe(200);
  });

  test("the genesis is the owner key's, for this fleet and this incarnation, and there is one", async () => {
    const w = await openFleet();
    const inc = await incarnationOf(w);
    const wrongIncarnation = new Chain("acme", "a-fleet-that-was").genesis();
    const refusedInc = await post(w, wrongIncarnation);
    expect(refusedInc.status).toBe(400);
    expect(refusedInc.json.error).toMatch(/another incarnation/);
    expect((await post(w, new Chain("other", inc).genesis())).status).toBe(400);
    // Signed by a key other than the one it names.
    const chain = new Chain("acme", inc);
    const g = chain.genesis();
    const forged = { entry: g.entry, sig: signer().sign(g.entry) };
    expect((await post(w, forged)).status).toBe(401);
    // Malformed ones.
    for (const bad of [{}, { entry: [], sig: "x" }, { entry: g.entry.slice(0, 12), sig: g.sig }, { entry: g.entry, sig: "short" }, { entry: [...g.entry.slice(0, 12), { x: 1 }], sig: g.sig }]) {
      expect((await post(w, bad as never)).status).toBe(400);
    }
    expect((await call(w, "/roster", "dev-a", "device", {}, "GET")).json.mode).toBe("open");
    expect((await post(w, g)).status).toBe(200);
    chain.accept(g);
    // A second genesis, and one for a fleet that does not exist.
    expect((await post(w, new Chain("acme", inc).genesis())).status).toBe(409);
    const empty = world();
    expect((await post(empty, new Chain("acme", "x").genesis())).status).toBe(404);
  });

  test("only the operator posts it: neither a member nor the owner device roots the chain", async () => {
    const w = await openFleet();
    const chain = new Chain("acme", await incarnationOf(w));
    const g = chain.genesis();
    expect((await post(w, g, "dev-a", "device")).status).toBe(403);
    const byOwner = await post(w, g, "owner", "device");
    expect(byOwner.status).toBe(403);
    expect(byOwner.json.error).toMatch(/operator/);
    // Nothing was stored: the fleet is still open, and the operator's genesis is taken.
    expect((await call(w, "/roster", "dev-a", "device", {}, "GET")).json.mode).toBe("open");
    expect((await call(w, "/approve", "operator", "admin", { deviceId: "nobody" })).status).not.toBe(409);
    expect((await post(w, g)).status).toBe(200);
  });

  test("an add for a member that is in the fleet must say what the fleet holds: its key, signing key and role", async () => {
    const w = await openFleet();
    const chain = new Chain("acme", await incarnationOf(w));
    const g = chain.genesis();
    await post(w, g);
    chain.accept(g);
    for (const wrong of [
      { xpub: xpubOf("someone-else"), spub: sKey("dev-a").pub, role: "member" },
      { xpub: xpubOf("dev-a"), spub: sKey("someone-else").pub, role: "member" },
      { xpub: xpubOf("dev-a"), spub: sKey("dev-a").pub, role: "viewer" },
    ]) {
      const res = await post(w, chain.make("add", { device: "dev-a", seqAt: 0, ...wrong }));
      expect(res.status).toBe(409);
    }
    const good = chain.make("add", { device: "dev-a", xpub: xpubOf("dev-a"), spub: sKey("dev-a").pub, role: "member", seqAt: 0 });
    expect((await post(w, good)).status).toBe(200);
  });
});

describe("in a fleet whose roster is signed", () => {
  test("the plain routes that changed the members are refused, and say what to do", async () => {
    const { w } = await signedFleet();
    await knock(w, "dev-b");
    const approve = await call(w, "/approve", "operator", "admin", { deviceId: "dev-b" });
    expect(approve.status).toBe(409);
    expect(approve.json.rosterSigned).toBe(true);
    expect(approve.json.hint).toMatch(/owner key/);
    expect((await call(w, "/approve", "owner", "device", { deviceId: "dev-b" })).status).toBe(409);
    // A role change and a key approval are the same route.
    expect((await call(w, "/approve", "operator", "admin", { deviceId: "dev-a", role: "viewer" })).status).toBe(409);
    const remove = await call(w, "/remove", "operator", "admin", { deviceId: "dev-a" });
    expect(remove.status).toBe(409);
    expect(remove.json.rosterSigned).toBe(true);
    expect((await call(w, "/remove", "owner", "device", { deviceId: "dev-a" })).status).toBe(409);
    const members = (await call(w, "/members", "", "admin", {}, "GET")).json.members as Array<{ deviceId: string }>;
    expect(members.map((m) => m.deviceId)).toEqual(["owner", "dev-a"]);
  });

  test("what only gives something up is still allowed: a request declined, a key request declined, a member leaving", async () => {
    const { w } = await signedFleet(["owner", "dev-a", "dev-b"]);
    await knock(w, "dev-c");
    expect((await call(w, "/remove", "operator", "admin", { deviceId: "dev-c" })).json.removed).toBe("pending");
    expect((await call(w, "/remove", "dev-b", "device", { deviceId: "dev-b" })).json.removed).toBe("member");
  });

  test("a key the old key proves is not taken on the proof: it waits for the owner's entry", async () => {
    const { w } = await signedFleet();
    const res = await call(w, "/join", "dev-a", "device", { code: "irrelevant-code-12345678", pubkey: xpubOf("dev-a-new"), spub: sKey("dev-a-new").pub });
    expect([200, 400, 409]).toContain(res.status);
    const members = (await call(w, "/members", "", "admin", {}, "GET")).json.members as Array<{ deviceId: string; pubkey: string }>;
    expect(members.find((m) => m.deviceId === "dev-a")!.pubkey).toBe(xpubOf("dev-a"));
  });

  test("a spub that a member says later is not taken: the chain names it", async () => {
    const { w } = await signedFleet();
    await call(w, "/bootstrap", "dev-a", "device", { seals: true, spub: sKey("impostor").pub });
    const members = (await call(w, "/members", "", "admin", {}, "GET")).json.members as Array<{ deviceId: string; spub: string }>;
    expect(members.find((m) => m.deviceId === "dev-a")!.spub).toBe(sKey("dev-a").pub);
  });
});

describe("admitting a member with a signed add", () => {
  test("is the approval: the request that waits is made a member, as what the entry says", async () => {
    const { w, chain } = await signedFleet();
    await knock(w, "dev-b");
    const add = chain.make("add", { device: "dev-b", xpub: xpubOf("dev-b"), spub: sKey("dev-b").pub, role: "viewer", seqAt: 0 });
    const res = await post(w, add);
    expect(res.status).toBe(200);
    chain.accept(add);
    const members = (await call(w, "/members", "", "admin", {}, "GET")).json.members as Array<{ deviceId: string; role: string; spub: string }>;
    expect(members.find((m) => m.deviceId === "dev-b")).toMatchObject({ role: "viewer", spub: sKey("dev-b").pub });
    expect((await call(w, "/pending", "operator", "admin", {}, "GET")).json.pending).toEqual([]);
    // The same entry sent again (the answer was lost) is the answer it had.
    const again = await post(w, add);
    expect(again.status).toBe(200);
    expect(again.json.again).toBe(true);
  });

  test("is refused for a key other than the request's, a request that is not there, and a device that is not asking", async () => {
    const { w, chain } = await signedFleet();
    await knock(w, "dev-b");
    const wrongKey = chain.make("add", { device: "dev-b", xpub: xpubOf("gateway-key"), spub: sKey("dev-b").pub, role: "member", seqAt: 0 });
    expect((await post(w, wrongKey)).status).toBe(409);
    const wrongSigning = chain.make("add", { device: "dev-b", xpub: xpubOf("dev-b"), spub: sKey("gateway").pub, role: "member", seqAt: 0 });
    expect((await post(w, wrongSigning)).status).toBe(409);
    const nobody = chain.make("add", { device: "dev-z", xpub: xpubOf("dev-z"), spub: sKey("dev-z").pub, role: "member", seqAt: 0 });
    expect((await post(w, nobody)).status).toBe(409);
    // Nothing of that changed the chain.
    expect((await call(w, "/roster", "dev-a", "device", {}, "GET")).json.entries.length).toBe(chain.entries.length);
  });

  test("is refused when it is not signed by the owner key, does not follow the head, or is of the past", async () => {
    const { w, chain } = await signedFleet();
    await knock(w, "dev-b");
    const body = { device: "dev-b", xpub: xpubOf("dev-b"), spub: sKey("dev-b").pub, role: "member", seqAt: 0 };
    // The gateway's own key: whoever holds it is not the owner.
    expect((await post(w, chain.make("add", body, signer()))).status).toBe(401);
    // Not the next position, and not on the head.
    const skipped = chain.make("add", body);
    skipped.entry[3] = 9;
    skipped.sig = chain.owner.sign(skipped.entry);
    expect((await post(w, skipped)).status).toBe(409);
    const forked = chain.make("add", body);
    forked.entry[4] = hashOf(chain.entries[0]!);
    forked.sig = chain.owner.sign(forked.entry);
    expect((await post(w, forked)).status).toBe(409);
    // Another incarnation or fleet.
    const other = chain.make("add", body);
    other.entry[2] = "an-earlier-fleet";
    other.sig = chain.owner.sign(other.entry);
    expect((await post(w, other)).status).toBe(400);
    // After the head: the entry a member has not been asked for yet.
    const ahead = chain.make("add", { ...body, seqAt: 5 });
    expect((await post(w, ahead)).json.error).toMatch(/head is at 0/);
  });

  test("a new member's add names the head as it was when the member asked, or a later snapshot, never an earlier one", async () => {
    const { w, chain } = await signedFleet();
    await lead(w, "dev-a");
    expect((await publish(w, "dev-a", 1)).status).toBe(200);
    expect((await publish(w, "dev-a", 2, "b")).status).toBe(200);
    await knock(w, "dev-b");
    // The fleet goes on publishing while the owner is away from its key.
    expect((await publish(w, "dev-a", 3, "c")).status).toBe(200);
    expect((await publish(w, "dev-a", 4, "d")).status).toBe(200);
    const body = { device: "dev-b", xpub: xpubOf("dev-b"), spub: sKey("dev-b").pub, role: "member" };
    for (const seqAt of [0, 1]) {
      const early = await post(w, chain.make("add", { ...body, seqAt }));
      expect(early.status).toBe(409);
      expect(early.json.error).toMatch(/was snapshot 2/);
    }
    // Signed when the head was 2, and sent when it is 4: still taken.
    const add = chain.make("add", { ...body, seqAt: 2 });
    expect((await post(w, add)).status).toBe(200);
    chain.accept(add);
    // One that asks later is held to the head of then.
    await knock(w, "dev-c");
    expect((await post(w, chain.make("add", { device: "dev-c", xpub: xpubOf("dev-c"), spub: sKey("dev-c").pub, role: "member", seqAt: 3 }))).status).toBe(409);
    expect((await post(w, chain.make("add", { device: "dev-c", xpub: xpubOf("dev-c"), spub: sKey("dev-c").pub, role: "member", seqAt: 4 }))).status).toBe(200);
  });

  test("is the owner device's to post, as well as the operator's, and a plain member's is refused", async () => {
    const { w, chain } = await signedFleet();
    await knock(w, "dev-b");
    const add = chain.make("add", { device: "dev-b", xpub: xpubOf("dev-b"), spub: sKey("dev-b").pub, role: "member", seqAt: 0 });
    expect((await post(w, add, "dev-a", "device")).status).toBe(403);
    expect((await post(w, add, "owner", "device")).status).toBe(200);
  });

  test("the roster keeps at most as many entries as it may", async () => {
    const { w, chain } = await signedFleet();
    expect(ROSTER_MAX_ENTRIES).toBeGreaterThan(chain.entries.length);
    w.data.set("roster", Array.from({ length: ROSTER_MAX_ENTRIES }, () => chain.entries[0]));
    const res = await post(w, chain.make("caller", { spub: sKey("c").pub, extra: "ci" }));
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/as long as it may be/);
  });
});

describe("removing a member with a fence and a signed remove", () => {
  test("a removal needs the fence first, and the sequence in the entry is the fence's", async () => {
    const { w, chain } = await signedFleet(["owner", "dev-a", "dev-b"]);
    await lead(w, "dev-a");
    expect((await publish(w, "dev-a", 1)).status).toBe(200);
    expect((await post(w, chain.make("remove", { device: "dev-b", seqAt: 1 }))).json.error).toMatch(/fence dev-b first/);
    const fence = await call(w, "/remove-fence", "operator", "admin", { deviceId: "dev-b" });
    expect(fence.json).toMatchObject({ ok: true, seqAt: 1 });
    expect((await post(w, chain.make("remove", { device: "dev-b", seqAt: 0 }))).status).toBe(409);
    expect((await post(w, chain.make("remove", { device: "dev-b", seqAt: 2 }))).status).toBe(409);
    const remove = chain.make("remove", { device: "dev-b", seqAt: 1 });
    expect((await post(w, remove)).status).toBe(200);
    chain.accept(remove);
    const view = (await call(w, "/members", "", "admin", {}, "GET")).json;
    expect(view.members.map((m: any) => m.deviceId)).toEqual(["owner", "dev-a"]);
    // The key left as of the sequence the owner signed.
    expect(view.left).toEqual([{ pubkey: xpubOf("dev-b"), until: 1 }]);
    // The fence is spent: a member of the name that comes again is not fenced.
    expect((await call(w, "/remove-fence", "operator", "admin", { deviceId: "dev-b" })).status).toBe(404);
  });

  test("from the fence on the member holds no lease, takes none, and publishes nothing", async () => {
    const { w } = await signedFleet(["owner", "dev-a", "dev-b"]);
    await lead(w, "dev-a");
    expect((await publish(w, "dev-a", 1)).status).toBe(200);
    await call(w, "/applied", "dev-a", "device", { seq: 1 });
    w.sent.length = 0;
    const fence = await call(w, "/remove-fence", "operator", "admin", { deviceId: "dev-a" });
    expect(fence.json).toMatchObject({ ok: true, seqAt: 1 });
    // The lease it held is free, and the others are told.
    expect(w.sent.map((m) => JSON.parse(m).type)).toContain("lease-free");
    const refused = await publish(w, "dev-a", 2, "b");
    expect(refused.status).toBe(409);
    const retake = await call(w, "/bootstrap", "dev-a", "device", { seals: true });
    expect(retake.json).toMatchObject({ role: "replica", reason: "fenced" });
    // Another member takes the lease, and the head is where the fence said.
    await call(w, "/applied", "dev-b", "device", { seq: 1 });
    expect((await call(w, "/bootstrap", "dev-b", "device", { seals: true })).json.role).toBe("primary");
    // A fence that is lifted is no fence.
    expect((await call(w, "/remove-fence", "operator", "admin", { deviceId: "dev-a", lift: true })).json.lifted).toBe(true);
    expect((await call(w, "/bootstrap", "dev-a", "device", { seals: true })).json.reason).not.toBe("fenced");
  });

  test("a publish that is in flight when the fence comes lands first, and the fence's sequence includes it", async () => {
    const { w } = await signedFleet(["owner", "dev-a"]);
    await lead(w, "dev-a");
    let release!: () => void;
    let reached!: () => void;
    w.bucket.gate = new Promise<void>((r) => (release = r));
    const arrived = new Promise<void>((r) => (reached = r));
    w.bucket.reached = reached;
    const publishing = publish(w, "dev-a", 1);
    await arrived;
    // The head write is slow; the owner fences now.
    let answered: Record<string, any> | undefined;
    const fencing = call(w, "/remove-fence", "operator", "admin", { deviceId: "dev-a" }).then((r) => (answered = r.json));
    await Bun.sleep(30);
    expect(answered).toBeUndefined();
    w.bucket.gate = undefined;
    release();
    expect((await publishing).status).toBe(200);
    await fencing;
    expect(answered).toMatchObject({ ok: true, seqAt: 1 });
  });

  test("only the operator or the owner fences, a fleet that is not signed has nothing to fence for, and a stranger is no member", async () => {
    const { w } = await signedFleet(["owner", "dev-a", "dev-b"]);
    expect((await call(w, "/remove-fence", "dev-a", "device", { deviceId: "dev-b" })).status).toBe(403);
    expect((await call(w, "/remove-fence", "owner", "device", { deviceId: "dev-b" })).status).toBe(200);
    expect((await call(w, "/remove-fence", "operator", "admin", { deviceId: "nobody" })).status).toBe(404);
    const open = await openFleet();
    expect((await call(open, "/remove-fence", "operator", "admin", { deviceId: "dev-a" })).status).toBe(409);
  });

  test("the last member to go takes the fleet and its chain, and a fleet made again of the name has a new incarnation", async () => {
    const { w, chain } = await signedFleet(["owner"]);
    const was = chain.incarnation;
    await call(w, "/remove-fence", "operator", "admin", { deviceId: "owner" });
    const remove = chain.make("remove", { device: "owner", seqAt: 0 });
    const res = await post(w, remove);
    expect(res.json.fleet).toBe("gone");
    expect(w.data.get("roster")).toBeUndefined();
    expect(w.data.get("rosterMode")).toBeUndefined();
    expect(w.data.get("fence")).toBeUndefined();
    // Made again: open, a new incarnation, and the old chain's genesis is not for it.
    await call(w, "/create", "", "admin");
    await admit(w, "owner");
    const again = (await call(w, "/roster", "operator", "admin", {}, "GET")).json;
    expect(again.mode).toBe("open");
    expect(again.incarnation).not.toBe(was);
    expect((await post(w, chain.entries[0]!)).status).toBe(400);
  });
});

describe("a member that leaves of its own accord in a signed fleet", () => {
  test("is fenced at once, and its removal is waiting for the owner's signature, in /roster, /members and the admin's list", async () => {
    const { w, chain } = await signedFleet(["owner", "dev-a", "dev-b"]);
    await lead(w, "dev-a");
    expect((await publish(w, "dev-a", 1)).status).toBe(200);
    expect((await call(w, "/remove", "dev-b", "device", { deviceId: "dev-b" })).json.removed).toBe("member");
    // The chain still lists it: the gateway says so, with the sequence the removal is to be signed with.
    const read = (await call(w, "/roster", "dev-a", "device", {}, "GET")).json;
    expect(read.pendingRemoves).toEqual([{ deviceId: "dev-b", seqAt: 1, left: true, at: Date.now() }]);
    const view = (await call(w, "/members", "", "admin", {}, "GET")).json;
    expect(view.pendingRemoves).toEqual(read.pendingRemoves);
    // The signed remove goes through with that sequence, with no fence call of the operator's, and clears it.
    const remove = chain.make("remove", { device: "dev-b", seqAt: 1 });
    expect((await post(w, remove)).status).toBe(200);
    chain.accept(remove);
    expect((await call(w, "/roster", "dev-a", "device", {}, "GET")).json.pendingRemoves).toEqual([]);
  });

  test("what it had in flight lands first, and the sequence includes it", async () => {
    const { w } = await signedFleet(["owner", "dev-a", "dev-b"]);
    await lead(w, "dev-a");
    let release!: () => void;
    w.bucket.gate = new Promise<void>((r) => (release = r));
    const reached = new Promise<void>((r) => (w.bucket.reached = r));
    const running = publish(w, "dev-a", 1);
    await reached;
    const left = call(w, "/remove", "dev-a", "device", { deviceId: "dev-a" });
    await new Promise((r) => setTimeout(r, 20));
    release();
    expect((await running).status).toBe(200);
    expect((await left).json.removed).toBe("member");
    const read = (await call(w, "/roster", "owner", "device", {}, "GET")).json;
    expect(read.pendingRemoves.map((p: any) => [p.deviceId, p.seqAt])).toEqual([["dev-a", 1]]);
  });

  test("the head a request is recorded at is read for a request that will wait, not for a join that is refused", async () => {
    const { w } = await signedFleet();
    let reads = 0;
    const get = w.bucket.get;
    w.bucket.get = async (k: string) => {
      reads++;
      return get(k);
    };
    const bad = await call(w, "/join", "dev-x", "device", { code: "pf1_" + "z".repeat(32), pubkey: xpubOf("dev-x"), spub: sKey("dev-x").pub });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(reads).toBe(0);
    await knock(w, "dev-y");
    expect(reads).toBe(1);
  });

  test("a leaver whose head could not be read is given its sequence at the next read", async () => {
    const { w } = await signedFleet(["owner", "dev-a", "dev-b"]);
    await lead(w, "dev-a");
    expect((await publish(w, "dev-a", 1)).status).toBe(200);
    const get = w.bucket.get;
    w.bucket.get = async () => {
      throw new Error("bucket down");
    };
    expect((await call(w, "/remove", "dev-b", "device", { deviceId: "dev-b" })).json.removed).toBe("member");
    w.bucket.get = get;
    const read = (await call(w, "/roster", "dev-a", "device", {}, "GET")).json;
    expect(read.pendingRemoves.map((p: any) => [p.deviceId, p.seqAt])).toEqual([["dev-b", 1]]);
  });

  test("an open fleet has nothing waiting", async () => {
    const w = await openFleet(["owner", "dev-a"]);
    await call(w, "/remove", "dev-a", "device", { deviceId: "dev-a" });
    expect((await call(w, "/members", "", "admin", {}, "GET")).json.pendingRemoves).toEqual([]);
  });
});

describe("a fence is seen, and lapses", () => {
  test("is shown to the operator and the owner (and to the member fenced), with when it lapses", async () => {
    const { w } = await signedFleet(["owner", "dev-a", "dev-b"]);
    expect((await call(w, "/remove-fence", "operator", "admin", { deviceId: "dev-b" })).status).toBe(200);
    const admin = (await call(w, "/members", "", "admin", {}, "GET")).json;
    expect(admin.fences).toEqual([{ deviceId: "dev-b", seqAt: 0, at: Date.now(), lapsesAt: Date.now() + FENCE_TTL_MS }]);
    const owner = (await call(w, "/members", "owner", "device", {}, "GET")).json;
    expect(owner.fences.map((f: any) => f.deviceId)).toEqual(["dev-b"]);
    // A plain member does not see who is being removed; the member fenced is told of its own.
    expect((await call(w, "/members", "dev-a", "device", {}, "GET")).json.fences).toBeUndefined();
    expect((await call(w, "/role", "dev-b", "device", {}, "GET")).json).toMatchObject({ fenced: true, fenceLapsesAt: Date.now() + FENCE_TTL_MS });
    expect((await call(w, "/role", "dev-a", "device", {}, "GET")).json.fenced).toBeUndefined();
    const info = (await call(w, "/reap", "", "admin")).json;
    expect(info.fences.map((f: any) => f.deviceId)).toEqual(["dev-b"]);
  });

  test("lapses after seven days, which is audited, and the member publishes again", async () => {
    const { w } = await signedFleet(["owner", "dev-a", "dev-b"]);
    await lead(w, "dev-b");
    expect((await call(w, "/remove-fence", "operator", "admin", { deviceId: "dev-b" })).status).toBe(200);
    expect((await publish(w, "dev-b", 1)).status).toBe(409);
    setSystemTime(new Date(Date.now() + FENCE_TTL_MS - 1000));
    expect((await publish(w, "dev-b", 1)).status).toBe(409);
    setSystemTime(new Date(Date.now() + 2000));
    expect((await call(w, "/members", "", "admin", {}, "GET")).json.fences).toEqual([]);
    expect((await call(w, "/bootstrap", "dev-b", "device", { seals: true })).json.role).toBe("primary");
    expect((await publish(w, "dev-b", 1)).status).toBe(200);
    const log = (await call(w, "/audit", "operator", "admin", {}, "GET")).json.entries as Array<{ action: string; target?: string; actor: { kind: string } }>;
    const lapsed = log.filter((e) => e.action === "remove-fence-lapsed");
    expect(lapsed).toHaveLength(1);
    expect(lapsed[0]).toMatchObject({ target: "dev-b", actor: { kind: "gateway" } });
  });

  test("a fence that is signed away is not a lapse", async () => {
    const { w, chain } = await signedFleet(["owner", "dev-a", "dev-b"]);
    await call(w, "/remove-fence", "operator", "admin", { deviceId: "dev-b" });
    const remove = chain.make("remove", { device: "dev-b", seqAt: 0 });
    expect((await post(w, remove)).status).toBe(200);
    setSystemTime(new Date(Date.now() + FENCE_TTL_MS + 1000));
    const log = (await call(w, "/audit", "operator", "admin", {}, "GET")).json.entries as Array<{ action: string }>;
    expect(log.some((e) => e.action === "remove-fence-lapsed")).toBe(false);
  });
});

describe("a member's own key and role under the signed roster", () => {
  test("a new key waits as a request, and the owner's rotate replaces it, as of the sequence it says", async () => {
    const { w, chain } = await signedFleet(["owner", "dev-a"]);
    await lead(w, "dev-a");
    await publish(w, "dev-a", 1);
    // The member comes back with a new key and a new signing key.
    const asked = await call(w, "/bootstrap", "dev-a", "device", { seals: true, pubkey: xpubOf("dev-a-2"), spub: sKey("dev-a-2").pub });
    expect(asked.status).toBe(409);
    expect(asked.json.keyChange).toBe("pending");
    const pending = (await call(w, "/pending", "operator", "admin", {}, "GET")).json.pending[0];
    expect(pending).toMatchObject({ deviceId: "dev-a", keyChange: true, spub: sKey("dev-a-2").pub });
    // The plain approval is refused; the entry is the approval.
    expect((await call(w, "/approve", "operator", "admin", { deviceId: "dev-a", key: "x" })).status).toBe(409);
    expect((await post(w, chain.make("rotate", { device: "dev-a", xpub: xpubOf("gateway"), spub: sKey("dev-a-2").pub, seqAt: 1 }))).status).toBe(409);
    const rotate = chain.make("rotate", { device: "dev-a", xpub: xpubOf("dev-a-2"), spub: sKey("dev-a-2").pub, seqAt: 1 });
    expect((await post(w, rotate)).status).toBe(200);
    chain.accept(rotate);
    const view = (await call(w, "/members", "", "admin", {}, "GET")).json;
    expect(view.members.find((m: any) => m.deviceId === "dev-a")).toMatchObject({ pubkey: xpubOf("dev-a-2"), spub: sKey("dev-a-2").pub });
    expect(view.left).toEqual([{ pubkey: xpubOf("dev-a"), until: 1 }]);
    expect((await call(w, "/pending", "operator", "admin", {}, "GET")).json.pending).toEqual([]);
  });

  test("a member changes its signing key with an entry the old signing key signs, and nobody else can", async () => {
    const { w, chain } = await signedFleet(["owner", "dev-a", "dev-b"]);
    const next = sKey("dev-a-next");
    const body = { device: "dev-a", spub: next.pub, seqAt: 0 };
    // The owner key does not sign a rotate-self; a stranger's key does not either.
    expect((await post(w, chain.make("rotate-self", body, chain.owner), "dev-a", "device")).status).toBe(401);
    expect((await post(w, chain.make("rotate-self", body, signer()), "dev-a", "device")).status).toBe(401);
    // A member that is neither the device nor the owner may not send it.
    expect((await post(w, chain.make("rotate-self", body, sKey("dev-a")), "dev-b", "device")).status).toBe(403);
    // The sealing key is not its to change.
    expect((await post(w, chain.make("rotate-self", { ...body, xpub: xpubOf("elsewhere") }, sKey("dev-a")), "dev-a", "device")).status).toBe(409);
    const ok = chain.make("rotate-self", body, sKey("dev-a"));
    expect((await post(w, ok, "dev-a", "device")).status).toBe(200);
    chain.accept(ok);
    const members = (await call(w, "/members", "", "admin", {}, "GET")).json.members as Array<{ deviceId: string; spub: string }>;
    expect(members.find((m) => m.deviceId === "dev-a")!.spub).toBe(next.pub);
    // The next one is signed by the new key, and the old one no longer is the member's.
    expect((await post(w, chain.make("rotate-self", { device: "dev-a", spub: sKey("again").pub, seqAt: 0 }, sKey("dev-a")), "dev-a", "device")).status).toBe(401);
  });

  test("a role entry makes a member a viewer, which gives up its lease, and the owner's is not changed that way", async () => {
    const { w, chain } = await signedFleet(["owner", "dev-a"]);
    await lead(w, "dev-a");
    w.sent.length = 0;
    const role = chain.make("role", { device: "dev-a", role: "viewer", seqAt: 0 });
    expect((await post(w, role)).status).toBe(200);
    chain.accept(role);
    expect(((await call(w, "/members", "", "admin", {}, "GET")).json.members as any[]).find((m) => m.deviceId === "dev-a").role).toBe("viewer");
    expect(w.sent.map((m) => JSON.parse(m).type)).toContain("lease-free");
    expect((await post(w, chain.make("role", { device: "owner", role: "viewer", seqAt: 0 }))).status).toBe(409);
    expect((await post(w, chain.make("role", { device: "dev-a", role: "owner", seqAt: 0 }))).status).toBe(409);
  });

  test("the entries the members read and the gateway does nothing with are kept: a caller key, and an owner rotation", async () => {
    const { w, chain } = await signedFleet();
    const caller = chain.make("caller", { spub: sKey("ci").pub, extra: "ci" });
    expect((await post(w, caller)).status).toBe(200);
    chain.accept(caller);
    const removeCaller = chain.make("caller-remove", { spub: sKey("ci").pub });
    expect((await post(w, removeCaller)).status).toBe(200);
    chain.accept(removeCaller);
    expect((await post(w, chain.make("caller-remove", { spub: sKey("ci").pub }))).status).toBe(409);
    const next = signer();
    const rotate = chain.make("owner-rotate", { extra: next.pub });
    expect((await post(w, rotate)).status).toBe(200);
    chain.accept(rotate);
    // From then on the new key signs, and the old one does not.
    expect((await post(w, chain.make("caller", { spub: sKey("ci2").pub }, chain.owner))).status).toBe(401);
    expect((await post(w, chain.make("caller", { spub: sKey("ci2").pub }, next))).status).toBe(200);
  });
});

describe("through the Worker", () => {
  async function through(path: string, method: string, body?: unknown) {
    const seen: Array<{ url: string; method: string; body: string | undefined }> = [];
    const stub = {
      async fetch(input: Request | string, init?: RequestInit) {
        const url = typeof input === "string" ? input : input.url;
        seen.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
        return Response.json({ ok: true });
      },
    };
    const env = { FLEET: { idFromName: (n: string) => n, get: () => stub }, FLEET_OPERATOR_TOKEN: "op-secret" } as never;
    const url = new URL("https://gateway" + path);
    const request = new Request(url, { method, headers: { authorization: "Bearer op-secret", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = (await handleFleetRoutes({ request, env, url, cfg: { fleetOperatorToken: "op-secret" } as never, authorizeDevice: async () => ({ ok: true as const }), unauthorized: () => new Response(null, { status: 401 }) }))!;
    return { res, seen };
  }

  test("the roster is read (from a place on) and posted, and a removal is fenced, by their names", async () => {
    const read = await through("/fleets/acme/roster?after=3", "GET");
    expect(read.res.status).toBe(200);
    expect(read.seen[0]).toMatchObject({ url: "https://fleet/roster?after=3", method: "GET" });
    const posted = await through("/fleets/acme/roster", "POST", { entry: [], sig: "" });
    expect(posted.seen[0]).toMatchObject({ url: "https://fleet/roster", method: "POST" });
    const fenced = await through("/fleets/acme/remove-fence", "POST", { deviceId: "dev-a" });
    expect(fenced.res.status).toBe(200);
    expect(fenced.seen[0]).toMatchObject({ url: "https://fleet/remove-fence", method: "POST" });
  });
});
