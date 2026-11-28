import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import worker, { WitnessDO, WitnessRegistry } from "../src/witness";
import {
  FUTURE_SKEW_MS,
  MAX_BODY_BYTES,
  KNOWN_TTL_MS,
  MAX_DEVICES,
  MAX_LIMITER_ENTRIES,
  MAX_ROWS_PROVEN,
  MAX_UNPROVEN,
  ROWS_PER_PROVEN_SIGNER,
  isKnownHere,
  rememberKnown,
  UNPROVEN_IDLE_MS,
  FLEET_IDLE_MS,
  limiterKey,
  limiterSize,
  parseCheckpoint,
  resetRateLimit,
  type Env,
} from "../src/lib";

// ---- stand-ins for the Durable Object runtime ------------------------------

// SqlStorage over bun:sqlite: exec(query, ...bindings) returns a cursor with toArray() and one().
function sqlOf(db: Database) {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.query(query).all(...bindings) as Record<string, unknown>[];
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`one() found ${rows.length} rows`);
          return rows[0]!;
        },
      };
    },
  };
}

// Namespaces whose objects are WitnessDO / WitnessRegistry instances over in-memory databases, one per name.
// As on Cloudflare, an object comes to exist when it is first fetched, not when a stub is made.
function fakeEnv(extra: Record<string, string> = {}, limiter?: Env["LIMITER"]) {
  const registryCalls: string[] = [];
  const hooks: { beforeDrop?: () => Promise<void> } = {};
  const dbs = new Map<string, Database>();
  const alarms = new Map<string, number>();
  const objects = new Map<string, WitnessDO>();
  let env!: Env;
  const namespace = (make: (state: unknown) => { fetch(r: Request): Promise<Response> }, prefix: string) => ({
    idFromName: (name: string) => prefix + name,
    get: (id: string) => ({
      fetch: async (url: string, init?: RequestInit) => {
        if (prefix === "r:") {
          registryCalls.push(new URL(url).pathname);
          if (url.includes("/drop") && hooks.beforeDrop) await hooks.beforeDrop();
        }
        let obj = objects.get(id) as unknown as { fetch(r: Request): Promise<Response> } | undefined;
        if (!obj) {
          const db = new Database(":memory:");
          dbs.set(id, db);
          const state = {
            storage: {
              sql: sqlOf(db),
              setAlarm: async (t: number) => void alarms.set(id, t),
              deleteAll: async () => {
                for (const t of ["meta", "devices", "cps", "retired", "fleets", "refusals", "creations"]) db.run(`DROP TABLE IF EXISTS ${t}`);
                alarms.delete(id);
              },
            },
          };
          obj = make(state);
          objects.set(id, obj as unknown as WitnessDO);
        }
        return obj.fetch(new Request(url, init));
      },
    }),
  });
  env = {
    WITNESS: namespace((s) => new WitnessDO(s as never, env), "w:"),
    REGISTRY: namespace((s) => new WitnessRegistry(s as never, env), "r:"),
    RATE_LIMIT_MAX: "100000",
    OWNER_KEYS: "*",
    ...extra,
    ...(limiter && { LIMITER: limiter }),
  } as unknown as Env;
  return {
    env,
    dbs,
    alarms,
    registryCalls,
    hooks,
    fleetDb: (key: string) => dbs.get("w:" + key),
    alarm: (key: string) => (objects.get("w:" + key) as unknown as { alarm(): Promise<void> }).alarm(),
  };
}

// ---- signers, a fleet, checkpoints and proofs ------------------------------

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

function makeSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { spub: b64url(publicKey.export({ format: "der", type: "spki" }).subarray(-32)), privateKey };
}
type Signer = ReturnType<typeof makeSigner>;
const signJson = (s: Signer, v: unknown) => b64url(sign(null, Buffer.from(JSON.stringify(v)), s.privateKey));

interface Fleet {
  owner: Signer;
  genesis: (string | number | null)[];
  key: string;
  fleet: string;
  inc: string;
}
function makeFleet(name = "acme"): Fleet {
  const owner = makeSigner();
  const inc = "inc-" + name;
  const genesis = ["prime-roster-v1", name, inc, 0, null, 1, "genesis", null, null, null, null, 0, owner.spub];
  return { owner, genesis, fleet: name, inc, key: b64url(createHash("sha256").update(JSON.stringify(genesis)).digest()) };
}

// Every signer is its own device unless told otherwise.
const deviceOf = (s: Signer) => "dev-" + s.spub.slice(0, 8);

// The owner's signed roster entry naming `s` for a device, as the proof a signer attaches to a checkpoint.
function proofFor(f: Fleet, s: Signer, over: { op?: string; device?: string; n?: number } = {}) {
  const entry = ["prime-roster-v1", f.fleet, f.inc, over.n ?? 1, "prev", 2, over.op ?? "add", over.device ?? deviceOf(s), "xpub", s.spub, "member", 0, null];
  return { genesis: f.genesis, entry, sig: signJson(f.owner, entry) };
}
// A rotate-self entry signed by the member's old key.
function rotateProof(f: Fleet, old: Signer, next: Signer, n = 2, device = deviceOf(old)) {
  const entry = ["prime-roster-v1", f.fleet, f.inc, n, "prev", 3, "rotate-self", device, "xpub", next.spub, "member", 0, null];
  return { entry, sig: signJson(old, entry), by: old.spub };
}
// An owner-signed remove of a device, posted to /remove.
function removal(f: Fleet, device: string, n: number, seqAt = 0) {
  const entry = ["prime-roster-v1", f.fleet, f.inc, n, "prev", 5, "remove", device, null, null, null, seqAt, null];
  return { genesis: f.genesis, entry, sig: signJson(f.owner, entry) };
}

interface Over {
  seq?: number;
  hash?: string;
  rosterN?: number | null;
  ts?: number;
  proof?: unknown;
  key?: string;
}
function checkpoint(f: Fleet, s: Signer, over: Over = {}, tamper?: (cp: unknown[]) => void) {
  const cp: unknown[] = ["prime-cp-v1", over.key ?? f.key, f.fleet, f.inc, over.seq ?? 1, over.hash ?? "h1", over.rosterN === undefined ? 3 : over.rosterN, over.ts ?? Date.now()];
  const sig = signJson(s, cp);
  tamper?.(cp);
  return { cp, sig, spub: s.spub, ...(over.proof !== undefined && { proof: over.proof }) };
}
// A proven member's checkpoint: carries the owner's proof.
const proven = (f: Fleet, s: Signer, over: Over & { device?: string; n?: number } = {}) =>
  checkpoint(f, s, { ...over, proof: proofFor(f, s, { device: over.device, n: over.n }) });

const post = (env: Env, key: string, body: unknown, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://w/w/${key}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "cf-connecting-ip": "1.2.3.4", ...headers } }), env);
type Listed = { cp: unknown[]; sig: string; spub: string; tier: string; at: number };
const remove = (env: Env, key: string, body: unknown) =>
  worker.fetch(new Request(`https://w/w/${key}/remove`, { method: "POST", body: JSON.stringify(body), headers: { "cf-connecting-ip": "1.2.3.4" } }), env);
const list = async (env: Env, key: string) => {
  const res = await worker.fetch(new Request(`https://w/w/${key}`, { headers: { "cf-connecting-ip": "1.2.3.4" } }), env);
  return { res, body: (await res.json()) as { checkpoints: Listed[] } };
};
const ip = (i: number) => ({ "cf-connecting-ip": `10.${(i >> 8) & 255}.${i & 255}.9` });
const status = async (env: Env) => (await (await worker.fetch(new Request("https://w/status"), env)).json()) as { fleets: number; max: number; refused: number };
const owners = (...fs: Fleet[]) => fs.map((f) => f.owner.spub).join(",");

beforeEach(() => resetRateLimit());

describe("storing and reading", () => {
  test("a signed checkpoint with the owner's proof is kept and read back as posted", async () => {
    const { env } = fakeEnv();
    const f = makeFleet();
    const a = makeSigner();
    const c = proven(f, a);
    const res = await post(env, f.key, c);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, stored: true, tier: "proven" });
    const { res: got, body } = await list(env, f.key);
    expect(got.status).toBe(200);
    expect(got.headers.get("cache-control")).toBe("no-store");
    expect(body.checkpoints).toHaveLength(1);
    expect(body.checkpoints[0]).toMatchObject({ cp: c.cp, sig: c.sig, spub: a.spub, tier: "proven" });
  });

  test("a read for a fleet the witness does not hold is a 404 and wakes no object", async () => {
    const { env, dbs } = fakeEnv();
    for (let i = 0; i < 5; i++) {
      const res = await worker.fetch(new Request(`https://w/w/${b64url(createHash("sha256").update("junk" + i).digest())}`), env);
      expect(res.status).toBe(404);
    }
    expect([...dbs.keys()].filter((k) => k.startsWith("w:"))).toEqual([]);
  });

  test("a first checkpoint without the owner's proof is refused and creates nothing", async () => {
    const { env, dbs } = fakeEnv();
    const f = makeFleet();
    const res = await post(env, f.key, checkpoint(f, makeSigner()));
    expect(res.status).toBe(400);
    expect([...dbs.keys()].filter((k) => k.startsWith("w:"))).toEqual([]);
    expect((await status(env)).fleets).toBe(0);
  });

  test("fleets do not see each other", async () => {
    const { env } = fakeEnv();
    const f = makeFleet("acme");
    const g = makeFleet("beta");
    await post(env, f.key, proven(f, makeSigner()));
    await post(env, g.key, proven(g, makeSigner()));
    expect((await list(env, f.key)).body.checkpoints).toHaveLength(1);
    expect((await list(env, g.key)).body.checkpoints).toHaveLength(1);
  });

  test("each signer keeps its own newest checkpoint, and a later post from a proven member needs no proof", async () => {
    const { env } = fakeEnv();
    const f = makeFleet();
    const a = makeSigner();
    const b = makeSigner();
    await post(env, f.key, proven(f, a, { seq: 1, hash: "ha1" }));
    await post(env, f.key, proven(f, b, { seq: 7, hash: "hb7" }));
    expect(await (await post(env, f.key, checkpoint(f, a, { seq: 2, hash: "ha2" }))).json()).toEqual({ ok: true, stored: true, tier: "proven" });
    const { body } = await list(env, f.key);
    expect(body.checkpoints.filter((c) => c.spub === a.spub).map((c) => c.cp[4])).toEqual([2, 1]);
    expect(body.checkpoints.filter((c) => c.spub === b.spub).map((c) => c.cp[4])).toEqual([7]);
  });

  test("a rollback of a signer's own record is acknowledged and ignored", async () => {
    const { env } = fakeEnv();
    const f = makeFleet();
    const a = makeSigner();
    await post(env, f.key, proven(f, a, { seq: 5, hash: "h5" }));
    const res = await post(env, f.key, checkpoint(f, a, { seq: 4, hash: "h4" }));
    expect(await res.json()).toMatchObject({ ok: true, stored: false });
    expect((await list(env, f.key)).body.checkpoints.map((c) => c.cp[4])).toEqual([5]);
  });

  test("an identical repost changes nothing: not the time the witness shows, not the order", async () => {
    const { env, fleetDb } = fakeEnv();
    const f = makeFleet();
    const a = makeSigner();
    const b = makeSigner();
    const ca = proven(f, a);
    await post(env, f.key, ca);
    await post(env, f.key, proven(f, b, { hash: "hb" }));
    fleetDb(f.key)!.run("UPDATE cps SET at = 1");
    const res = await post(env, f.key, ca, ip(77)); // anyone can repost it
    expect(await res.json()).toMatchObject({ stored: false });
    const { body } = await list(env, f.key);
    expect(body.checkpoints.map((c) => c.at)).toEqual([1, 1]);
    expect(body.checkpoints[0]!.spub).toBe(b.spub);
  });

  test("the same manifest hash at a higher seq replaces its row; at a lower seq it is ignored", async () => {
    const { env } = fakeEnv();
    const f = makeFleet();
    const a = makeSigner();
    await post(env, f.key, proven(f, a, { seq: 3, hash: "same" }));
    expect(await (await post(env, f.key, checkpoint(f, a, { seq: 4, hash: "same" }))).json()).toMatchObject({ stored: true });
    expect(await (await post(env, f.key, checkpoint(f, a, { seq: 3, hash: "same" }))).json()).toMatchObject({ stored: false });
    expect((await list(env, f.key)).body.checkpoints.map((c) => c.cp[4])).toEqual([4]);
  });

  test("two signed checkpoints for one seq with different hashes stay visible as a fork, through 20 later posts by each", async () => {
    const { env } = fakeEnv();
    const f = makeFleet();
    const a = makeSigner();
    const b = makeSigner();
    await post(env, f.key, proven(f, a, { seq: 9, hash: "left" }));
    await post(env, f.key, proven(f, b, { seq: 9, hash: "right" }));
    for (let seq = 10; seq < 10 + 20; seq++) {
      await post(env, f.key, checkpoint(f, a, { seq, hash: `a${seq}` }));
      await post(env, f.key, checkpoint(f, b, { seq, hash: `b${seq}` }));
    }
    const nine = (await list(env, f.key)).body.checkpoints.filter((c) => c.cp[4] === 9).map((c) => c.cp[5]).sort();
    expect(nine).toEqual(["left", "right"]);
  });

  test("a busy signer keeps its own latest rows only, so it cannot push another signer's fork evidence out", async () => {
    const { env } = fakeEnv();
    const f = makeFleet();
    const a = makeSigner();
    const b = makeSigner();
    await post(env, f.key, proven(f, a, { seq: 10, hash: "forkA" }));
    await post(env, f.key, proven(f, b, { seq: 10, hash: "forkB" }));
    await post(env, f.key, checkpoint(f, b, { seq: 11, hash: "b11" }));
    for (let seq = 11; seq < 11 + 4 * ROWS_PER_PROVEN_SIGNER; seq++) await post(env, f.key, checkpoint(f, a, { seq, hash: `a${seq}` }));
    const { body } = await list(env, f.key);
    const hashes = body.checkpoints.map((c) => c.cp[5]);
    expect(hashes).toContain("forkB");
    expect(hashes).toContain("b11");
    expect(body.checkpoints.filter((c) => c.spub === a.spub).length).toBe(ROWS_PER_PROVEN_SIGNER);
    expect(hashes).not.toContain("forkA"); // a's own old rows are what goes
  });

  test("a tier's rows are capped as a whole, and every signer's newest checkpoint stays", async () => {
    const { env } = fakeEnv();
    const f = makeFleet();
    const signers = Array.from({ length: Math.ceil(MAX_ROWS_PROVEN / ROWS_PER_PROVEN_SIGNER) + 4 }, () => makeSigner());
    for (const [i, s] of signers.entries()) {
      await post(env, f.key, proven(f, s, { seq: 1, hash: `s${i}-1` }));
      for (let seq = 2; seq <= ROWS_PER_PROVEN_SIGNER; seq++) await post(env, f.key, checkpoint(f, s, { seq, hash: `s${i}-${seq}` }));
    }
    const { body } = await list(env, f.key);
    expect(body.checkpoints.length).toBeLessThanOrEqual(MAX_ROWS_PROVEN + signers.length);
    expect(body.checkpoints.length).toBeLessThan(signers.length * ROWS_PER_PROVEN_SIGNER);
    for (const [i, s] of signers.entries()) expect(body.checkpoints.some((c) => c.spub === s.spub && c.cp[5] === `s${i}-${ROWS_PER_PROVEN_SIGNER}`)).toBe(true);
  });
});

describe("proof of membership", () => {
  test("a proof signed by a key other than the genesis owner is refused", async () => {
    const { env } = fakeEnv();
    const f = makeFleet();
    const a = makeSigner();
    const forged = { ...proofFor(f, a), sig: signJson(makeSigner(), proofFor(f, a).entry) };
    expect((await post(env, f.key, checkpoint(f, a, { proof: forged }))).status).toBe(401);
  });

  test("a proof naming another key, another incarnation or another op is refused", async () => {
    const { env } = fakeEnv();
    const f = makeFleet();
    const a = makeSigner();
    const other = proofFor(f, makeSigner());
    expect((await post(env, f.key, checkpoint(f, a, { proof: other }))).status).toBe(401);
    const entry = ["prime-roster-v1", f.fleet, "inc-else", 1, "prev", 2, "add", "dev", "xpub", a.spub, "member", 0, null];
    expect((await post(env, f.key, checkpoint(f, a, { proof: { genesis: f.genesis, entry, sig: signJson(f.owner, entry) } }))).status).toBe(401);
    const removal = proofFor(f, a, { op: "remove" });
    expect((await post(env, f.key, checkpoint(f, a, { proof: removal }))).status).toBe(401);
  });

  test("a genesis entry that does not hash to the fleetKey is refused (the owner cannot be chosen by the poster)", async () => {
    const { env } = fakeEnv();
    const f = makeFleet();
    const impostor = makeFleet(); // same names, another owner, another key
    impostor.fleet = f.fleet;
    const a = makeSigner();
    const lie = proofFor({ ...impostor, fleet: f.fleet, inc: f.inc, genesis: impostor.genesis }, a);
    expect((await post(env, f.key, checkpoint(f, a, { proof: lie }))).status).toBe(401);
  });

  test("a squatter cannot take the proven tier: 8 throwaway keys fill only the small tier, members are still admitted", async () => {
    const { env } = fakeEnv();
    const f = makeFleet();
    await post(env, f.key, proven(f, makeSigner(), { hash: "first" })); // the fleet exists
    for (let i = 0; i < MAX_UNPROVEN; i++) expect((await post(env, f.key, checkpoint(f, makeSigner()), ip(i))).status).toBe(200);
    expect((await post(env, f.key, checkpoint(f, makeSigner()), ip(100))).status).toBe(507);
    const member = makeSigner();
    expect(await (await post(env, f.key, proven(f, member, { seq: 5, hash: "m5" }), ip(101))).json()).toEqual({ ok: true, stored: true, tier: "proven" });
  });

  test("silent real members are never displaced, however long they are silent and however full the fleet", async () => {
    const { env, fleetDb } = fakeEnv();
    const f = makeFleet();
    const real = [makeSigner(), makeSigner(), makeSigner(), makeSigner()];
    for (const r of real) await post(env, f.key, proven(f, r, { seq: 100, hash: "H100" }));
    for (let i = 0; i < MAX_UNPROVEN + 5; i++) await post(env, f.key, checkpoint(f, makeSigner()), ip(i));
    fleetDb(f.key)!.run("UPDATE cps SET at = ? WHERE tier = 'proven'", [Date.now() - UNPROVEN_IDLE_MS * 5]);
    const res = await post(env, f.key, checkpoint(f, makeSigner()), ip(999));
    expect(res.status).toBe(507);
    const have = new Set((await list(env, f.key)).body.checkpoints.map((c) => c.spub));
    expect(real.every((r) => have.has(r.spub))).toBe(true);
  });

  test("the proven tier is full at 64 signers and refuses a 65th with 507, evicting nobody", async () => {
    const { env } = fakeEnv();
    const f = makeFleet();
    const all = Array.from({ length: MAX_DEVICES }, () => makeSigner());
    for (const s of all) expect((await post(env, f.key, proven(f, s))).status).toBe(200);
    expect((await post(env, f.key, proven(f, makeSigner()))).status).toBe(507);
    expect(new Set((await list(env, f.key)).body.checkpoints.map((c) => c.spub)).size).toBe(MAX_DEVICES);
  });

  test("an unproven signer that later brings the owner's proof moves to the proven tier", async () => {
    const { env } = fakeEnv();
    const f = makeFleet();
    await post(env, f.key, proven(f, makeSigner()));
    const late = makeSigner();
    expect(await (await post(env, f.key, checkpoint(f, late, { seq: 1, hash: "x" }))).json()).toMatchObject({ tier: "unproven" });
    expect(await (await post(env, f.key, proven(f, late, { seq: 2, hash: "y" }))).json()).toMatchObject({ stored: true, tier: "proven" });
    expect((await list(env, f.key)).body.checkpoints.filter((c) => c.spub === late.spub).every((c) => c.tier === "proven")).toBe(true);
  });

  test("a rotate-self signed by a proven key moves its place to the new key, and only then", async () => {
    const { env } = fakeEnv();
    const f = makeFleet();
    const old = makeSigner();
    await post(env, f.key, proven(f, old, { seq: 4, hash: "old4" }));
    const next = makeSigner();
    const res = await post(env, f.key, checkpoint(f, next, { seq: 5, hash: "new5", proof: rotateProof(f, old, next) }));
    expect(await res.json()).toEqual({ ok: true, stored: true, tier: "proven" });
    const tiers = Object.fromEntries((await list(env, f.key)).body.checkpoints.map((c) => [c.spub, c.tier]));
    expect(tiers).toEqual({ [next.spub]: "proven", [old.spub]: "retired" });
    // the old key posts no more
    expect((await post(env, f.key, checkpoint(f, old, { seq: 6, hash: "old6" }))).status).toBe(409);
    // a key that holds no slot cannot vouch for another
    const stranger = makeSigner();
    const next2 = makeSigner();
    expect((await post(env, f.key, checkpoint(f, next2, { proof: rotateProof(f, stranger, next2) }))).status).toBe(409);
  });

  test("a rotation whose checkpoint is refused as older leaves the old key where it was", async () => {
    const { env } = fakeEnv();
    const f = makeFleet();
    const old = makeSigner();
    const next = makeSigner();
    await post(env, f.key, proven(f, old, { seq: 4, hash: "old4" }));
    await post(env, f.key, checkpoint(f, next, { seq: 10, hash: "next10" })); // the new key was seen unproven, further on
    const res = await post(env, f.key, checkpoint(f, next, { seq: 5, hash: "next5", proof: rotateProof(f, old, next) }));
    expect(await res.json()).toMatchObject({ stored: false });
    const tiers = Object.fromEntries((await list(env, f.key)).body.checkpoints.map((c) => [c.spub, c.tier]));
    expect(tiers).toEqual({ [old.spub]: "proven", [next.spub]: "unproven" });
  });

  test("a rotate-self whose signature is not by the key it names is refused", async () => {
    const { env } = fakeEnv();
    const f = makeFleet();
    const old = makeSigner();
    await post(env, f.key, proven(f, old));
    const next = makeSigner();
    const p = rotateProof(f, makeSigner(), next);
    expect((await post(env, f.key, checkpoint(f, next, { proof: { ...p, by: old.spub } }))).status).toBe(401);
  });
});

describe("rotation vouchers", () => {
  test("a key that holds one device's slot cannot rotate another device's key", async () => {
    const { env } = fakeEnv();
    const f = makeFleet();
    const a = makeSigner();
    const b = makeSigner();
    await post(env, f.key, proven(f, a, { device: "dA" }));
    await post(env, f.key, proven(f, b, { device: "dB" }));
    const c = makeSigner();
    // a's key signs a rotate-self for device dB
    const res = await post(env, f.key, checkpoint(f, c, { proof: rotateProof(f, a, c, 5, "dB") }));
    expect(res.status).toBe(409);
    const tiers = Object.fromEntries((await list(env, f.key)).body.checkpoints.map((x) => [x.spub, x.tier]));
    expect(tiers).toEqual({ [a.spub]: "proven", [b.spub]: "proven" });
  });
});

describe("checkpoint checks", () => {
  test("a signature by another key, a changed checkpoint, a malformed signature are refused", async () => {
    const { env } = fakeEnv();
    const f = makeFleet();
    const a = makeSigner();
    const c = proven(f, a);
    expect((await post(env, f.key, { ...c, spub: makeSigner().spub })).status).toBe(401);
    expect((await post(env, f.key, { ...proven(f, a), cp: [...c.cp.slice(0, 4), 99, ...c.cp.slice(5)] })).status).toBe(401);
    expect((await post(env, f.key, { ...c, sig: "AAAA" })).status).toBe(401);
    expect((await post(env, f.key, { ...c, spub: "not base64url!" })).status).toBe(401);
    expect((await post(env, f.key, { ...c, sig: 5 })).status).toBe(400);
  });

  test("a checkpoint signed for fleet X cannot be posted into fleet Y", async () => {
    const { env } = fakeEnv();
    const x = makeFleet("acme");
    const y = makeFleet("beta");
    const a = makeSigner();
    const forX = proven(x, a, { seq: 3, hash: "hx" });
    await post(env, x.key, forX);
    await post(env, y.key, proven(y, a, { seq: 1, hash: "hy" }));
    const res = await post(env, y.key, forX);
    expect(res.status).toBe(400);
    expect((await list(env, y.key)).body.checkpoints.map((c) => c.cp[1])).toEqual([y.key]);
  });

  test("a checkpoint for another incarnation of a held fleet is refused", async () => {
    const { env } = fakeEnv();
    const f = makeFleet();
    const a = makeSigner();
    await post(env, f.key, proven(f, a));
    const cp = ["prime-cp-v1", f.key, f.fleet, "inc-other", 5, "h", 1, Date.now()];
    expect((await post(env, f.key, { cp, sig: signJson(a, cp), spub: a.spub })).status).toBe(400);
  });

  test.each([
    ["wrong version", (cp: unknown[]) => (cp[0] = "prime-cp-v2")],
    ["short array", (cp: unknown[]) => cp.pop()],
    ["fleetKey of the wrong shape", (cp: unknown[]) => (cp[1] = "short")],
    ["negative seq", (cp: unknown[]) => (cp[4] = -1)],
    ["fractional seq", (cp: unknown[]) => (cp[4] = 1.5)],
    ["string seq", (cp: unknown[]) => (cp[4] = "1")],
    ["unsafe seq", (cp: unknown[]) => (cp[4] = 2 ** 60)],
    ["odd characters in the hash", (cp: unknown[]) => (cp[5] = 'a"b')],
    ["empty fleet", (cp: unknown[]) => (cp[2] = "")],
    ["long incarnation", (cp: unknown[]) => (cp[3] = "x".repeat(129))],
    ["rosterN of the wrong type", (cp: unknown[]) => (cp[6] = "3")],
    ["ts of the wrong type", (cp: unknown[]) => (cp[7] = "now")],
  ])("%s is refused as a bad checkpoint even when signed", async (_name: string, change: (cp: unknown[]) => void) => {
    const { env } = fakeEnv();
    const f = makeFleet();
    const a = makeSigner();
    const cp: unknown[] = ["prime-cp-v1", f.key, f.fleet, f.inc, 1, "h1", 3, Date.now()];
    change(cp);
    expect((await post(env, f.key, { cp, sig: signJson(a, cp), spub: a.spub, proof: proofFor(f, a) })).status).toBe(400);
  });

  test("a null rosterN is fine, a ts a little ahead is fine, one far ahead is not", async () => {
    const { env } = fakeEnv();
    const f = makeFleet();
    const a = makeSigner();
    expect((await post(env, f.key, proven(f, a, { rosterN: null }))).status).toBe(200);
    expect((await post(env, f.key, checkpoint(f, a, { seq: 2, hash: "b", ts: Date.now() + 60_000 }))).status).toBe(200);
    expect((await post(env, f.key, checkpoint(f, a, { seq: 3, hash: "c", ts: Date.now() + FUTURE_SKEW_MS + 60_000 }))).status).toBe(400);
  });

  test("a body over the cap is refused with 413, by header and by streaming", async () => {
    const { env } = fakeEnv();
    const f = makeFleet();
    expect((await post(env, f.key, JSON.stringify({ pad: "x".repeat(MAX_BODY_BYTES) }))).status).toBe(413);
    const streamed = new Request(`https://w/w/${f.key}`, {
      method: "POST",
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("x".repeat(MAX_BODY_BYTES + 1)));
          c.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect((await worker.fetch(streamed, env)).status).toBe(413);
  });

  test("a body that is not JSON is a 400; a bad fleet key a 400; other paths 404; other methods 405", async () => {
    const { env } = fakeEnv();
    const f = makeFleet();
    expect((await post(env, f.key, "{nope")).status).toBe(400);
    expect((await post(env, f.key, "[]")).status).toBe(400);
    expect((await post(env, "short", proven(f, makeSigner()))).status).toBe(400);
    expect((await worker.fetch(new Request("https://w/elsewhere"), env)).status).toBe(404);
    expect((await worker.fetch(new Request(`https://w/w/${f.key}`, { method: "DELETE" }), env)).status).toBe(405);
    expect((await worker.fetch(new Request("https://w/"), env)).status).toBe(200);
  });

  test("nothing is created for a refused post", async () => {
    const { env, dbs } = fakeEnv();
    const f = makeFleet();
    const good = proven(f, makeSigner());
    await post(env, f.key, { ...good, cp: good.cp.map((v, i) => (i === 4 ? 2 : v)) }); // altered after signing
    await post(env, f.key, "{nope");
    expect([...dbs.keys()].filter((k) => k.startsWith("w:"))).toEqual([]);
    expect((await status(env)).fleets).toBe(0);
  });
});

describe("cost and retention", () => {
  test("the witness holds at most MAX_FLEETS fleets, says so with 507 and counts the refusals in /status", async () => {
    const { env } = fakeEnv({ MAX_FLEETS: "2" });
    const fleets = [makeFleet("a"), makeFleet("b"), makeFleet("c")];
    expect((await post(env, fleets[0]!.key, proven(fleets[0]!, makeSigner()))).status).toBe(200);
    expect((await post(env, fleets[1]!.key, proven(fleets[1]!, makeSigner()))).status).toBe(200);
    expect((await post(env, fleets[2]!.key, proven(fleets[2]!, makeSigner()))).status).toBe(507);
    expect(await status(env)).toMatchObject({ fleets: 2, max: 2, refused: 1 });
    // a fleet already held is not turned away
    expect((await post(env, fleets[0]!.key, checkpoint(fleets[0]!, makeSigner()))).status).toBe(200);
  });

  test("the daily alarm drops unproven signers idle for 30 days and keeps proven ones, and re-arms itself", async () => {
    const { env, fleetDb, alarm, alarms } = fakeEnv();
    const f = makeFleet();
    const member = makeSigner();
    const guest = makeSigner();
    await post(env, f.key, proven(f, member));
    await post(env, f.key, checkpoint(f, guest));
    expect(alarms.get("w:" + f.key)).toBeGreaterThan(Date.now());
    fleetDb(f.key)!.run("UPDATE cps SET at = ?", [Date.now() - UNPROVEN_IDLE_MS - 1000]);
    fleetDb(f.key)!.run("UPDATE cps SET at = ? WHERE tier = 'proven'", [Date.now() - 1000]);
    await alarm(f.key);
    expect((await list(env, f.key)).body.checkpoints.map((c) => c.spub)).toEqual([member.spub]);
    expect(alarms.get("w:" + f.key)).toBeGreaterThan(Date.now());
  });

  test("a fleet with nothing new for a year is deleted and forgotten, and can be made again", async () => {
    const { env, fleetDb, alarm } = fakeEnv();
    const f = makeFleet();
    await post(env, f.key, proven(f, makeSigner()));
    fleetDb(f.key)!.run("UPDATE cps SET at = ?", [Date.now() - FLEET_IDLE_MS - 1000]);
    await alarm(f.key);
    resetRateLimit(); // another isolate, which has not been told the fleet exists
    expect((await list(env, f.key)).res.status).toBe(404);
    expect((await status(env)).fleets).toBe(0);
    expect((await post(env, f.key, proven(f, makeSigner()))).status).toBe(200);
    expect((await list(env, f.key)).body.checkpoints).toHaveLength(1);
  });
});

describe("devices and removals", () => {
  test("many key changes of one device keep one slot: the old keys are history, not members", async () => {
    const { env } = fakeEnv();
    const f = makeFleet();
    const keys = Array.from({ length: MAX_DEVICES + 6 }, () => makeSigner());
    for (const [i, k] of keys.entries()) expect((await post(env, f.key, proven(f, k, { device: "laptop", n: i + 1 }))).status).toBe(200);
    // the slots left: every other device is still admitted
    for (let i = 0; i < MAX_DEVICES - 1; i++) expect((await post(env, f.key, proven(f, makeSigner()))).status).toBe(200);
    expect((await post(env, f.key, proven(f, makeSigner()))).status).toBe(507);
    const { body } = await list(env, f.key);
    const last = keys[keys.length - 1]!;
    expect(body.checkpoints.find((c) => c.spub === last.spub)!.tier).toBe("proven");
    expect(body.checkpoints.filter((c) => c.tier === "retired").length).toBe(keys.length - 1);
    // a replaced key posts no more, and an older entry for the device does not undo a later one
    expect((await post(env, f.key, checkpoint(f, keys[0]!, { seq: 9, hash: "late" }))).status).toBe(409);
    expect((await post(env, f.key, proven(f, keys[0]!, { device: "laptop", n: 1, seq: 9, hash: "replay" }))).status).toBe(409);
    expect((await list(env, f.key)).body.checkpoints.find((c) => c.spub === last.spub)!.tier).toBe("proven");
  });

  test("a replaced key never posts again, even long after its history lapsed, unless the owner adds it back", async () => {
    const { env, fleetDb, alarm } = fakeEnv();
    const f = makeFleet();
    const old = makeSigner();
    const next = makeSigner();
    await post(env, f.key, proven(f, old, { device: "d", n: 1 }));
    await post(env, f.key, proven(f, next, { device: "d", n: 2, seq: 2, hash: "n2" }));
    fleetDb(f.key)!.run("UPDATE cps SET at = ? WHERE tier = 'retired'", [Date.now() - UNPROVEN_IDLE_MS - 1000]);
    fleetDb(f.key)!.run("UPDATE retired SET at = ?", [Date.now() - UNPROVEN_IDLE_MS - 1000]);
    await alarm(f.key);
    expect((await list(env, f.key)).body.checkpoints.map((c) => c.spub)).toEqual([next.spub]); // the history has lapsed
    const res = await post(env, f.key, checkpoint(f, old, { seq: 5, hash: "again" }));
    expect(res.status).toBe(409);
    // the owner adds it back with a later entry
    expect((await post(env, f.key, proven(f, old, { device: "d", n: 3, seq: 6, hash: "back" }))).status).toBe(200);
    expect((await post(env, f.key, checkpoint(f, next, { seq: 7, hash: "n7" }))).status).toBe(409); // and now the other one is the replaced key
  });

  test("a key may not take a slot another device's key already holds", async () => {
    const { env } = fakeEnv();
    const f = makeFleet();
    const a = makeSigner();
    await post(env, f.key, proven(f, a, { device: "one" }));
    expect((await post(env, f.key, proven(f, a, { device: "two", n: 5, seq: 2, hash: "x" }))).status).toBe(409);
  });

  test("an owner-signed remove frees the slot, retires the key, and cannot be undone by an older entry", async () => {
    const { env } = fakeEnv();
    const f = makeFleet();
    const gone = makeSigner();
    await post(env, f.key, proven(f, gone, { device: "old-laptop", n: 1, seq: 3, hash: "g3" }));
    for (let i = 0; i < MAX_DEVICES - 1; i++) await post(env, f.key, proven(f, makeSigner()));
    expect((await post(env, f.key, proven(f, makeSigner()))).status).toBe(507);
    const res = await remove(env, f.key, removal(f, "old-laptop", 7));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, applied: true });
    expect((await post(env, f.key, proven(f, makeSigner()))).status).toBe(200); // the freed slot
    expect((await post(env, f.key, checkpoint(f, gone, { seq: 4, hash: "g4" }))).status).toBe(409);
    expect((await post(env, f.key, proven(f, gone, { device: "old-laptop", n: 1, seq: 4, hash: "g4" }))).status).toBe(409); // the old add, replayed
    const row = (await list(env, f.key)).body.checkpoints.find((c) => c.spub === gone.spub)!;
    expect(row.tier).toBe("retired");
    expect(row.cp[4]).toBe(3);
    // a later add for the same device (re-admitted by the owner) works
    expect((await post(env, f.key, proven(f, makeSigner(), { device: "old-laptop", n: 9 }))).status).toBe(507); // full again: 64 live devices
  });

  test("a remove with a lower position than the device's is ignored; a remove of an unknown device is recorded", async () => {
    const { env } = fakeEnv();
    const f = makeFleet();
    const a = makeSigner();
    await post(env, f.key, proven(f, a, { device: "d", n: 5 }));
    expect(await (await remove(env, f.key, removal(f, "d", 3))).json()).toMatchObject({ applied: false });
    expect((await post(env, f.key, checkpoint(f, a, { seq: 2, hash: "ok" }))).status).toBe(200);
    expect(await (await remove(env, f.key, removal(f, "never-seen", 4))).json()).toMatchObject({ applied: true });
    expect((await post(env, f.key, proven(f, makeSigner(), { device: "never-seen", n: 2 }))).status).toBe(409); // an older add cannot undo the remove
  });

  test("a remove must be signed by the genesis owner, name this fleet, and the fleet must exist", async () => {
    const { env } = fakeEnv();
    const f = makeFleet();
    await post(env, f.key, proven(f, makeSigner()));
    const other = makeFleet("beta");
    const forged = { ...removal(f, "x", 3), sig: signJson(other.owner, removal(f, "x", 3).entry) };
    expect((await remove(env, f.key, forged)).status).toBe(401);
    const lie = removal(other, "x", 3);
    expect((await remove(env, f.key, lie)).status).toBe(401); // its genesis does not hash to this key
    // owner-signed entries of the wrong op, or for another fleet or incarnation, are no removal
    for (const op of ["add", "rotate", "genesis", "owner-rotate"]) {
      const entry = ["prime-roster-v1", f.fleet, f.inc, 9, "p", 3, op, "victim", null, null, null, 0, null];
      expect((await remove(env, f.key, { genesis: f.genesis, entry, sig: signJson(f.owner, entry) })).status).toBe(401);
    }
    for (const [fleet, inc] of [["other", f.inc], [f.fleet, "inc-other"]] as const) {
      const entry = ["prime-roster-v1", fleet, inc, 9, "p", 3, "remove", "victim", null, null, null, 0, null];
      expect((await remove(env, f.key, { genesis: f.genesis, entry, sig: signJson(f.owner, entry) })).status).toBe(401);
    }
    // and none of them freed or blocked the device: it can still be added
    expect((await post(env, f.key, proven(f, makeSigner(), { device: "victim", n: 1 }))).status).toBe(200);
    expect((await remove(env, other.key, removal(other, "x", 3))).status).toBe(404); // not held
    expect((await worker.fetch(new Request(`https://w/w/${f.key}/remove`), env)).status).toBe(405);
  });
});

describe("who may create a fleet", () => {
  test("with OWNER_KEYS set, only those owners' fleets are made; reads and held fleets are unaffected", async () => {
    const mine = makeFleet("mine");
    const squatter = makeFleet("squat");
    const { env } = fakeEnv({ OWNER_KEYS: ` ${makeSigner().spub} , ${mine.owner.spub} ` });
    const res = await post(env, squatter.key, proven(squatter, makeSigner()));
    expect(res.status).toBe(403);
    expect((await status(env)).fleets).toBe(0);
    expect((await post(env, mine.key, proven(mine, makeSigner()))).status).toBe(200);
    expect((await list(env, mine.key)).res.status).toBe(200);
  });

  test("with OWNER_KEYS empty no fleet is made (closed); only \"*\" opens it", async () => {
    const f = makeFleet();
    const closed = fakeEnv({ OWNER_KEYS: "" });
    expect((await post(closed.env, f.key, proven(f, makeSigner()))).status).toBe(403);
    const open = fakeEnv({ OWNER_KEYS: "*" });
    expect((await post(open.env, f.key, proven(f, makeSigner()))).status).toBe(200);
  });

  test("when OWNER_KEYS stops allowing a held fleet's owner it is refused at once and purged by the daily alarm", async () => {
    const { env, alarm, dbs } = fakeEnv();
    const f = makeFleet();
    const a = makeSigner();
    await post(env, f.key, proven(f, a));
    env.OWNER_KEYS = makeSigner().spub; // someone else's key now
    expect((await post(env, f.key, checkpoint(f, a, { seq: 2, hash: "x" }))).status).toBe(403);
    expect((await list(env, f.key)).res.status).toBe(404);
    expect((await remove(env, f.key, removal(f, "d", 4))).status).toBe(404);
    await alarm(f.key);
    resetRateLimit();
    expect((await status(env)).fleets).toBe(0);
    expect(dbs.get("w:" + f.key)!.query("SELECT name FROM sqlite_master").all()).toEqual([]);
    // allowed again: it is a new fleet to the witness
    env.OWNER_KEYS = f.owner.spub;
    expect((await post(env, f.key, proven(f, a, { seq: 9, hash: "back" }))).status).toBe(200);
  });

  test("filling the registry with self-made fleets is stopped by the allowlist, and a real fleet is then still made", async () => {
    const real = makeFleet("credio");
    const { env } = fakeEnv({ MAX_FLEETS: "5", OWNER_KEYS: real.owner.spub, FLEET_CREATES_PER_HOUR: "1000" });
    for (let i = 0; i < 20; i++) {
      const junk = makeFleet("junk" + i);
      expect((await post(env, junk.key, proven(junk, makeSigner()), ip(i))).status).toBe(403);
    }
    expect((await post(env, real.key, proven(real, makeSigner()))).status).toBe(200);
  });

  test("one address (one /64) may create only a few fleets an hour, others are not held back, held fleets are not counted", async () => {
    const { env } = fakeEnv({ FLEET_CREATES_PER_HOUR: "3" });
    const from = { "cf-connecting-ip": "2001:db8:5:5::1" };
    const made: Fleet[] = [];
    for (let i = 0; i < 3; i++) {
      const f = makeFleet("c" + i);
      made.push(f);
      expect((await post(env, f.key, proven(f, makeSigner()), from)).status).toBe(200);
    }
    const fourth = makeFleet("c4");
    const over = await post(env, fourth.key, proven(fourth, makeSigner()), { "cf-connecting-ip": "2001:db8:5:5::ffff" });
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("3600");
    expect((await post(env, fourth.key, proven(fourth, makeSigner()), ip(5))).status).toBe(200); // another address
    expect((await post(env, made[0]!.key, checkpoint(made[0]!, makeSigner()), from)).status).toBe(200); // a held fleet
    expect((await status(env)).refused).toBe(1);
  });
});

describe("registry traffic and races", () => {
  test("a held fleet is asked of the registry once, not on every request", async () => {
    const { env, registryCalls } = fakeEnv();
    const f = makeFleet();
    const a = makeSigner();
    await post(env, f.key, proven(f, a));
    const before = registryCalls.length;
    for (let seq = 2; seq < 12; seq++) await post(env, f.key, checkpoint(f, a, { seq, hash: `h${seq}` }));
    for (let i = 0; i < 5; i++) await list(env, f.key);
    expect(registryCalls.length).toBe(before);
  });

  test("what an isolate knows of fleets lapses after a few minutes and is bounded", () => {
    rememberKnown("k1", 1000);
    expect(isKnownHere("k1", 1000 + KNOWN_TTL_MS)).toBe(true);
    expect(isKnownHere("k1", 1000 + KNOWN_TTL_MS + 1)).toBe(false);
    expect(isKnownHere("never", 0)).toBe(false);
  });

  test("a post that remakes a fleet while the yearly deletion is telling the registry is not lost", async () => {
    const { env, fleetDb, alarm, hooks } = fakeEnv();
    const f = makeFleet();
    const a = makeSigner();
    await post(env, f.key, proven(f, a, { seq: 1, hash: "first" }));
    fleetDb(f.key)!.run("UPDATE cps SET at = ?", [Date.now() - FLEET_IDLE_MS - 1000]);
    // the registry still knows the fleet when this post arrives, so the Worker sends it straight to the emptied object
    hooks.beforeDrop = async () => {
      hooks.beforeDrop = undefined;
      expect((await post(env, f.key, proven(f, a, { seq: 50, hash: "again" }))).status).toBe(200);
    };
    await alarm(f.key);
    resetRateLimit(); // forget the isolate's cache: what the registry says is what counts
    const got = await list(env, f.key);
    expect(got.res.status).toBe(200);
    expect(got.body.checkpoints.map((c) => c.cp[5])).toEqual(["again"]);
    expect((await status(env)).fleets).toBe(1);
  });
});

describe("a fleet deleted behind a warm cache", () => {
  test("a read answers 404 and wakes nothing that stays; a post without the proof is told to send it", async () => {
    const { env, fleetDb, alarm, dbs, registryCalls } = fakeEnv();
    const f = makeFleet();
    const a = makeSigner();
    await post(env, f.key, proven(f, a));
    fleetDb(f.key)!.run("UPDATE cps SET at = ?", [Date.now() - FLEET_IDLE_MS - 1000]);
    await alarm(f.key); // this isolate still believes the fleet exists
    expect((await list(env, f.key)).res.status).toBe(404);
    expect(dbs.get("w:" + f.key)!.query("SELECT name FROM sqlite_master").all()).toEqual([]);
    // the cache was dropped on that answer: the next ask goes to the registry
    const before = registryCalls.filter((p) => p === "/has").length;
    const again = await post(env, f.key, checkpoint(f, a, { seq: 2, hash: "x" }));
    expect(registryCalls.filter((p) => p === "/has").length).toBe(before + 1);
    expect(again.status).toBe(400);
    expect(((await again.json()) as { reason: string }).reason).toBe("proof-required");
  });

  test("a post that finds the fleet gone gets the machine-readable reason and the cache forgets it", async () => {
    const { env, fleetDb, alarm } = fakeEnv();
    const f = makeFleet();
    const a = makeSigner();
    await post(env, f.key, proven(f, a));
    fleetDb(f.key)!.run("UPDATE cps SET at = ?", [Date.now() - FLEET_IDLE_MS - 1000]);
    await alarm(f.key);
    const res = await post(env, f.key, checkpoint(f, a, { seq: 2, hash: "x" })); // cache is warm: goes to the empty object
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toBe("proof-required");
    // sending the proof again makes it again (the registry was told of the deletion)
    expect((await post(env, f.key, proven(f, a, { seq: 3, hash: "y" }))).status).toBe(200);
    expect((await status(env)).fleets).toBe(1);
  });
});

describe("rate limits", () => {
  test("the per-address limit answers 429 and does not count other addresses", async () => {
    const { env } = fakeEnv({ RATE_LIMIT_MAX: "60" });
    const f = makeFleet();
    const a = makeSigner();
    await post(env, f.key, proven(f, a));
    for (let i = 1; i < 60; i++) expect((await post(env, f.key, checkpoint(f, a, { seq: i + 1, hash: `h${i}` }))).status).toBe(200);
    const over = await post(env, f.key, checkpoint(f, a, { seq: 61, hash: "over" }));
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("60");
    expect((await post(env, f.key, checkpoint(f, a, { seq: 62, hash: "other" }), { "cf-connecting-ip": "9.9.9.9" })).status).toBe(200);
  });

  test("addresses of one IPv6 /64 share a limit", async () => {
    const { env } = fakeEnv({ RATE_LIMIT_MAX: "10" });
    let ok = 0;
    for (let i = 0; i < 200; i++) {
      const f = makeFleet("f" + i);
      if ((await post(env, f.key, proven(f, makeSigner()), { "cf-connecting-ip": `2001:db8:1:2::${i.toString(16)}` })).status === 200) ok++;
    }
    expect(ok).toBe(10);
    expect((await post(env, makeFleet("g").key, "{}", { "cf-connecting-ip": "2001:db8:1:3::1" })).status).toBe(400); // another /64 is not limited
  });

  test("limiterKey: IPv4 as is, IPv6 as its /64, compressed or not", () => {
    expect(limiterKey("1.2.3.4")).toBe("1.2.3.4");
    expect(limiterKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(limiterKey("2001:0db8:0001:0002::1"));
    expect(limiterKey("2001:db8::1")).toBe(limiterKey("2001:db8:0:0:ffff::2"));
    expect(limiterKey("2001:db8:0:1::1")).not.toBe(limiterKey("2001:db8:0:2::1"));
    expect(limiterKey("::1")).toBe("v6:0:0:0:0");
    // IPv4-mapped IPv6 is the IPv4 machine, in either spelling
    expect(limiterKey("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(limiterKey("::ffff:9.9.9.9")).toBe("9.9.9.9");
    expect(limiterKey("::FFFF:0102:0304")).toBe("1.2.3.4");
    expect(limiterKey("0:0:0:0:0:ffff:c000:2a")).toBe("192.0.0.42");
  });

  test("the per-isolate counter map stays bounded under a spray of addresses", async () => {
    const { env } = fakeEnv();
    for (let i = 0; i < MAX_LIMITER_ENTRIES + 500; i++) await worker.fetch(new Request("https://w/"), env); // not counted
    for (let i = 0; i < MAX_LIMITER_ENTRIES + 500; i++) {
      await worker.fetch(new Request(`https://w/w/${makeFleet().key}`, { headers: { "cf-connecting-ip": `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}` } }), env);
    }
    expect(limiterSize()).toBeLessThanOrEqual(MAX_LIMITER_ENTRIES);
  });

  test("the rate-limit binding, when present, can refuse", async () => {
    const { env } = fakeEnv({}, { limit: async () => ({ success: false }) });
    const f = makeFleet();
    expect((await post(env, f.key, proven(f, makeSigner()))).status).toBe(429);
  });

  test("when the binding throws, reads and posts to held fleets go on but a new fleet is not made", async () => {
    const down: Env["LIMITER"] = { limit: async () => { throw new Error("down"); } };
    const healthy = fakeEnv();
    const f = makeFleet();
    await post(healthy.env, f.key, proven(f, makeSigner()));
    const broken = { ...healthy.env, LIMITER: down } as Env;
    expect((await list(broken, f.key)).res.status).toBe(200);
    expect((await post(broken, f.key, checkpoint(f, makeSigner()))).status).toBe(200);
    const g = makeFleet("beta");
    expect((await post(broken, g.key, proven(g, makeSigner()))).status).toBe(503);
    expect((await list(broken, g.key)).res.status).toBe(404);
  });
});

describe("parseCheckpoint", () => {
  test("accepts the documented shape and refuses non-objects", () => {
    const f = makeFleet();
    expect(parseCheckpoint(proven(f, makeSigner()), Date.now()).ok).toBe(true);
    expect(parseCheckpoint(null, 0).ok).toBe(false);
    expect(parseCheckpoint([], 0).ok).toBe(false);
  });
});
