// A member's epoch key: signed by its signing key, kept as the newest one, served to the primary, and dropped with the signing key.
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { createHash, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign as cryptoSign } from "node:crypto";
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
const { KEY_PROOF_INFO, keyChangeMessage } = await import("../src/fleets");
const { handleFleetRoutes } = await import("../src/fleets-routes");

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

const NOW = () => Date.now();
const DAY = 24 * 3_600_000;
/** An X25519-looking public key (the gateway checks the form only) for each name. */
const epubOf = (name: string): string => createHash("sha256").update("epoch:" + name).digest().toString("base64");

/** What a member makes of an epoch key: the entry its signing key signs. */
function epochBody(w: World, device: string, n: number, over: { pub?: string; notAfter?: number; by?: Signer; fleet?: string; incarnation?: string; deviceIn?: string } = {}, inc = "") {
  const incarnation = over.incarnation ?? inc;
  const entry = ["prime-epoch-v1", over.fleet ?? "acme", incarnation, over.deviceIn ?? device, n, over.pub ?? epubOf(device + n), over.notAfter ?? NOW() + 2 * DAY];
  return { entry, sig: (over.by ?? sKey(device)).sign(entry) };
}
const keysOf = async (w: World, as: string) => {
  // The primary's lease is short: a test that moves the clock takes it again.
  await call(w, "/bootstrap", as, "device", { seals: true });
  return (await call(w, "/keys", as, "device", {}, "GET")).json.members as Array<Record<string, any>>;
};

async function fleetWithPrimary() {
  const w = await openFleet(["owner", "dev-a", "dev-b"]);
  const inc = await incarnationOf(w);
  expect((await call(w, "/bootstrap", "owner", "device", { seals: true })).json.role).toBe("primary");
  return { w, inc };
}
const put = (w: World, device: string, body: unknown) => call(w, "/epoch-key", device, "device", body as Record<string, unknown>);

describe("a member's epoch key", () => {
  test("is taken when its signing key signed it, and the primary reads it in /keys beside the key to check it with", async () => {
    const { w, inc } = await fleetWithPrimary();
    const res = await put(w, "dev-a", epochBody(w, "dev-a", 1, {}, inc));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, n: 1 });
    const keys = await keysOf(w, "owner");
    const a = keys.find((m) => m.deviceId === "dev-a")!;
    expect(a.spub).toBe(sKey("dev-a").pub);
    expect(a.epochKey).toMatchObject({ n: 1, pub: epubOf("dev-a1") });
    expect(typeof a.epochKey.sig).toBe("string");
    expect(a.epochKey.at).toBeUndefined();
    // A member that published none has none; the long-term key is still there.
    const b = keys.find((m) => m.deviceId === "dev-b")!;
    expect(b.epochKey).toBeUndefined();
    expect(b.pubkey).toBe(xpubOf("dev-b"));
  });

  test("is refused when the signature is not the member's signing key's, the device or fleet is another, or the form is wrong", async () => {
    const { w, inc } = await fleetWithPrimary();
    expect((await put(w, "dev-a", epochBody(w, "dev-a", 1, { by: signer() }, inc))).status).toBe(401);
    // Signed by another member's key.
    expect((await put(w, "dev-a", epochBody(w, "dev-a", 1, { by: sKey("dev-b") }, inc))).status).toBe(401);
    // The entry of dev-b, sent by dev-a, even if dev-a signs it.
    expect((await put(w, "dev-a", epochBody(w, "dev-a", 1, { deviceIn: "dev-b" }, inc))).status).toBe(400);
    expect((await put(w, "dev-a", epochBody(w, "dev-a", 1, { fleet: "other" }, inc))).status).toBe(409);
    expect((await put(w, "dev-a", epochBody(w, "dev-a", 1, {}, "a-fleet-that-was"))).status).toBe(409);
    expect((await put(w, "dev-a", epochBody(w, "dev-a", 1, { pub: "short" }, inc))).status).toBe(400);
    expect((await put(w, "dev-a", { entry: ["prime-roster-v1"], sig: "x" })).status).toBe(400);
    expect((await put(w, "dev-a", { entry: epochBody(w, "dev-a", 1, {}, inc).entry, sig: "x" })).status).toBe(400);
    expect((await put(w, "dev-a", epochBody(w, "dev-a", -1, {}, inc))).status).toBe(400);
    // A stranger is no member.
    expect((await put(w, "stranger", epochBody(w, "stranger", 1, {}, inc))).status).toBe(403);
    expect((await call(w, "/epoch-key", "operator", "admin", epochBody(w, "dev-a", 1, {}, inc) as never)).status).toBe(403);
    expect((await keysOf(w, "owner")).every((m) => m.epochKey === undefined)).toBe(true);
  });

  test("must be valid now and not more than 31 days ahead", async () => {
    const { w, inc } = await fleetWithPrimary();
    expect((await put(w, "dev-a", epochBody(w, "dev-a", 1, { notAfter: NOW() - 1 }, inc))).status).toBe(400);
    expect((await put(w, "dev-a", epochBody(w, "dev-a", 1, { notAfter: NOW() + 32 * DAY }, inc))).status).toBe(400);
    expect((await put(w, "dev-a", epochBody(w, "dev-a", 1, { notAfter: NOW() + 30 * DAY }, inc))).status).toBe(200);
    // Once it has passed, /keys does not offer it: the publisher wraps to the long-term key.
    setSystemTime(new Date(NOW() + 31 * DAY));
    expect((await keysOf(w, "owner")).find((m) => m.deviceId === "dev-a")!.epochKey).toBeUndefined();
  });

  test("only goes up: an older or equal n is refused, the same key again is the answer it had, and a newer one waits five minutes", async () => {
    const { w, inc } = await fleetWithPrimary();
    const first = epochBody(w, "dev-a", 5, {}, inc);
    expect((await put(w, "dev-a", first)).status).toBe(200);
    const again = await put(w, "dev-a", first);
    expect(again.status).toBe(200);
    expect(again.json.again).toBe(true);
    expect((await put(w, "dev-a", epochBody(w, "dev-a", 5, { pub: epubOf("other") }, inc))).status).toBe(409);
    const stale = await put(w, "dev-a", epochBody(w, "dev-a", 4, {}, inc));
    expect(stale.status).toBe(409);
    expect(stale.json.n).toBe(5);
    // Too soon: 429 with when to come back.
    const soon = await put(w, "dev-a", epochBody(w, "dev-a", 6, {}, inc));
    expect(soon.status).toBe(429);
    expect(soon.json.retryAfterMs).toBeGreaterThan(0);
    setSystemTime(new Date(NOW() + 5 * 60_000 + 1));
    expect((await put(w, "dev-a", epochBody(w, "dev-a", 6, {}, inc))).status).toBe(200);
    expect((await keysOf(w, "owner")).find((m) => m.deviceId === "dev-a")!.epochKey.n).toBe(6);
  });

  test("goes with the signing key it was signed by: a changed signing key drops it", async () => {
    const { w, chain } = await (async () => {
      const f = await signedFleet(["owner", "dev-a"]);
      return f;
    })();
    expect((await call(w, "/bootstrap", "owner", "device", { seals: true })).json.role).toBe("primary");
    const inc = await incarnationOf(w);
    expect((await put(w, "dev-a", epochBody(w, "dev-a", 1, {}, inc))).status).toBe(200);
    expect((await keysOf(w, "owner")).find((m) => m.deviceId === "dev-a")!.epochKey.n).toBe(1);
    // The member changes its signing key (rotate-self): the key the roster has for it no longer checks the old epoch key.
    const next = sKey("dev-a-next");
    const rot = chain.make("rotate-self", { device: "dev-a", spub: next.pub, seqAt: 0 }, sKey("dev-a"));
    expect((await post(w, rot, "dev-a", "device")).status).toBe(200);
    const after = (await keysOf(w, "owner")).find((m) => m.deviceId === "dev-a")!;
    expect(after.epochKey).toBeUndefined();
    expect(after.spub).toBe(next.pub);
    // Its new epoch key is signed by the new one (and n may restart: the old one is gone).
    const fresh = epochBody(w, "dev-a", 1, { by: next }, inc);
    expect((await put(w, "dev-a", fresh)).status).toBe(200);
    // The old signing key signs nothing any more.
    expect((await put(w, "dev-a", epochBody(w, "dev-a", 2, { by: sKey("dev-a") }, inc))).status).toBe(401);
  });

  test("a member without a signing key on the fleet cannot have one checked", async () => {
    const w = world();
    await call(w, "/create", "", "admin");
    await w.fleet.fetch(new Request("https://fleet/role", { headers: { "x-prime-caller": "device", "x-prime-device": "x", "x-prime-fleet": "acme" } }));
    const invite = await call(w, "/invite", "operator", "admin");
    await call(w, "/join", "old", "device", { code: invite.json.code, pubkey: xpubOf("old"), label: "old" });
    await call(w, "/approve", "operator", "admin", { deviceId: "old" });
    const inc = await incarnationOf(w);
    const res = await put(w, "old", epochBody(w, "old", 1, {}, inc));
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/no signing key/);
  });

  test("goes when the member does, and a viewer may have one too", async () => {
    const w = await openFleet(["owner"]);
    await admit(w, "eye", "viewer");
    const inc = await incarnationOf(w);
    await call(w, "/bootstrap", "owner", "device", { seals: true });
    expect((await put(w, "eye", epochBody(w, "eye", 1, {}, inc))).status).toBe(200);
    expect((await keysOf(w, "owner")).find((m) => m.deviceId === "eye")).toMatchObject({ role: "viewer", epochKey: { n: 1 } });
    await call(w, "/remove", "operator", "admin", { deviceId: "eye" });
    expect((await keysOf(w, "owner")).some((m) => m.deviceId === "eye")).toBe(false);
  });
});

describe("an epoch key goes with the key file: any change of the sealing key or the signing key drops it", () => {
  const newXKey = createHash("sha256").update("new-x").digest().toString("base64");
  const newX = () => newXKey;

  async function rekeyedByOperator(spubMode: "same" | "none" | "other") {
    const { w, inc } = await fleetWithPrimary();
    expect((await put(w, "dev-a", epochBody(w, "dev-a", 1, {}, inc))).status).toBe(200);
    const invite = await call(w, "/invite", "operator", "admin");
    const spub = spubMode === "same" ? sKey("dev-a").pub : spubMode === "other" ? sKey("dev-a-other").pub : undefined;
    const joined = await call(w, "/join", "dev-a", "device", { code: invite.json.code, pubkey: newX(), ...(spub ? { spub } : {}), label: "dev-a" });
    expect(joined.status).toBeLessThan(500);
    const { keyFingerprintLong } = await import("../src/fleets");
    expect((await call(w, "/approve", "operator", "admin", { deviceId: "dev-a", key: await keyFingerprintLong(newX()) })).status).toBe(200);
    return { w, inc };
  }

  for (const mode of ["same", "none", "other"] as const) {
    test("the operator approves a new sealing key (signing key " + mode + "): the epoch key is not served any more", async () => {
      const { w } = await rekeyedByOperator(mode);
      const after = (await keysOf(w, "owner")).find((m) => m.deviceId === "dev-a")!;
      expect(after.pubkey).toBe(newX());
      expect(after.epochKey).toBeUndefined();
    });
  }

  test("a new epoch key can be published after that, signed by the signing key the fleet holds", async () => {
    const { w, inc } = await rekeyedByOperator("same");
    expect((await put(w, "dev-a", epochBody(w, "dev-a", 1, {}, inc))).status).toBe(200);
    expect((await keysOf(w, "owner")).find((m) => m.deviceId === "dev-a")!.epochKey.n).toBe(1);
  });

  test("an owner-signed rotate that changes only the sealing key drops it", async () => {
    const { w, chain } = await signedFleet(["owner", "dev-a"]);
    expect((await call(w, "/bootstrap", "owner", "device", { seals: true })).json.role).toBe("primary");
    const inc = await incarnationOf(w);
    expect((await put(w, "dev-a", epochBody(w, "dev-a", 1, {}, inc))).status).toBe(200);
    // The member asks for another sealing key and keeps its signing key; the owner's rotate replaces it.
    const asked = await call(w, "/bootstrap", "dev-a", "device", { seals: true, pubkey: newX(), spub: sKey("dev-a").pub });
    expect(asked.json.keyChange).toBe("pending");
    const rotate = chain.make("rotate", { device: "dev-a", xpub: newX(), spub: sKey("dev-a").pub, seqAt: 0 });
    expect((await post(w, rotate)).status).toBe(200);
    const after = (await keysOf(w, "owner")).find((m) => m.deviceId === "dev-a")!;
    expect(after.pubkey).toBe(newX());
    expect(after.epochKey).toBeUndefined();
  });

  test("a key change the old key proves drops it, whether the signing key is sent again or not", async () => {
    for (const sendSpub of [true, false]) {
      const w = await openFleet(["owner"]);
      const inc = await incarnationOf(w);
      // A member whose sealing key is a real X25519 key, so that it can prove it holds it.
      const pair = generateKeyPairSync("x25519");
      const der = pair.publicKey.export({ type: "spki", format: "der" }) as Buffer;
      const oldPub = der.subarray(der.length - 32).toString("base64");
      const invite = await call(w, "/invite", "operator", "admin");
      await call(w, "/join", "prover", "device", { code: invite.json.code, pubkey: oldPub, spub: sKey("prover").pub, label: "prover" });
      await call(w, "/approve", "operator", "admin", { deviceId: "prover" });
      await call(w, "/bootstrap", "owner", "device", { seals: true });
      expect((await put(w, "prover", epochBody(w, "prover", 1, {}, inc))).status).toBe(200);
      expect((await keysOf(w, "owner")).find((m) => m.deviceId === "prover")!.epochKey.n).toBe(1);
      const objectKey = (await call(w, "/role", "prover", "device", {}, "GET")).json.keyProofKey as string;
      const spki = Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), Buffer.from(objectKey, "base64")]);
      const shared = diffieHellman({ privateKey: pair.privateKey, publicKey: createPublicKey({ key: spki, format: "der", type: "spki" }) });
      const macKey = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(32), Buffer.from(KEY_PROOF_INFO), 32));
      const ts = Date.now();
      const nonce = randomBytes(16).toString("base64");
      const mac = createHmac("sha256", macKey).update(keyChangeMessage(newX(), "acme", "prover", ts, nonce)).digest("base64");
      const res = await call(w, "/bootstrap", "prover", "device", { seals: true, pubkey: newX(), ...(sendSpub ? { spub: sKey("prover").pub } : {}), keyProof: { ts, nonce, mac } });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const after = (await keysOf(w, "owner")).find((m) => m.deviceId === "prover")!;
      expect(after.pubkey).toBe(newX());
      expect(after.epochKey).toBeUndefined();
    }
  });
});

describe("what is served of epoch keys", () => {
  test("a member that is fenced or has left has none in /keys, and the member views carry none", async () => {
    const { w, chain } = await signedFleet(["owner", "dev-a", "dev-b"]);
    expect((await call(w, "/bootstrap", "owner", "device", { seals: true })).json.role).toBe("primary");
    const inc = await incarnationOf(w);
    for (const d of ["dev-a", "dev-b"]) expect((await put(w, d, epochBody(w, d, 1, {}, inc))).status).toBe(200);
    expect((await keysOf(w, "owner")).filter((m) => m.epochKey).map((m) => m.deviceId).sort()).toEqual(["dev-a", "dev-b"]);
    // No view of the roster carries them: the operator's, the owner's, another member's.
    for (const [who, kind] of [["", "admin"], ["owner", "device"], ["dev-a", "device"], ["dev-b", "device"]] as const) {
      const view = (await call(w, "/members", who, kind, {}, "GET")).json.members as Array<Record<string, unknown>>;
      expect(view.some((m) => "epochKey" in m)).toBe(false);
    }
    // Fenced for removal: not offered to the publisher.
    expect((await call(w, "/remove-fence", "operator", "admin", { deviceId: "dev-b" })).status).toBe(200);
    expect((await keysOf(w, "owner")).find((m) => m.deviceId === "dev-b")!.epochKey).toBeUndefined();
    expect((await keysOf(w, "owner")).find((m) => m.deviceId === "dev-a")!.epochKey.n).toBe(1);
    // Left by itself, still in the chain: its fence holds it back too.
    expect((await call(w, "/remove", "dev-a", "device", { deviceId: "dev-a" })).json.removed).toBe("member");
    expect((await keysOf(w, "owner")).some((m) => m.deviceId === "dev-a")).toBe(false);
    void chain;
  });

  test("posting a key is no activity of the fleet (the reaper's clock is not moved)", async () => {
    const { w, inc } = await fleetWithPrimary();
    const before = w.data.get("lastActivity");
    setSystemTime(new Date(Date.now() + 3_600_000));
    expect((await put(w, "dev-a", epochBody(w, "dev-a", 1, { notAfter: NOW() + 2 * DAY }, inc))).status).toBe(200);
    expect(w.data.get("lastActivity")).toBe(before);
  });
});

describe("through the Worker", () => {
  test("the route is known, and carries a member's POST to the object", async () => {
    const seen: Array<{ url: string; method: string }> = [];
    const stub = { async fetch(input: Request | string, init?: RequestInit) {
      seen.push({ url: typeof input === "string" ? input : input.url, method: init?.method ?? "GET" });
      return Response.json({ ok: true });
    } };
    const env = { FLEET: { idFromName: (n: string) => n, get: () => stub } } as never;
    const url = new URL("https://gateway/fleets/acme/epoch-key");
    const request = new Request(url, { method: "POST", headers: { "x-prime-device": "dev-a", "content-type": "application/json" }, body: JSON.stringify({ entry: [], sig: "" }) });
    const res = (await handleFleetRoutes({ request, env, url, cfg: {} as never, authorizeDevice: async () => ({ ok: true as const }), unauthorized: () => new Response(null, { status: 401 }) }))!;
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({ url: "https://fleet/epoch-key", method: "POST" });
  });
});
