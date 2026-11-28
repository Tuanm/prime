// Witness Worker: a place the fleet gateway does not control, where fleet
// members leave their newest signed checkpoints so that one member can tell
// that the gateway has shown it an older history than another member saw.
// The wire contract, limits and what clients must do are in ../README.md.
//
//   POST /w/<fleetKey>   store a checkpoint (<= 4 KiB JSON)
//   POST /w/<fleetKey>/remove   an owner-signed roster `remove`, which frees its device's slot
//   GET  /w/<fleetKey>   every stored checkpoint, newest post first (404 for a fleet it does not hold)
//   GET  /status         {fleets, max, refused, lastRefusedAt}: what to watch
//   GET  /               liveness
//
// Two kinds of Durable Object: one WitnessDO per fleet (SQLite) and one
// WitnessRegistry that knows which fleets exist, so that a read for a fleet
// nobody has posted to answers 404 without waking an object, and the number of
// fleets is bounded.

import {
  ALARM_EVERY_MS, MAX_RETIRED, DEFAULT_CREATES_PER_HOUR, DEFAULT_MAX_FLEETS, FLEET_IDLE_MS, FLEET_KEY_RE, MAX_BODY_BYTES, MAX_CREATE_TRACK, MAX_DEVICES, MAX_DEVICE_RECORDS,
  MAX_ROWS_PROVEN, MAX_ROWS_UNPROVEN, MAX_UNPROVEN, ROWS_PER_PROVEN_SIGNER, ROWS_PER_UNPROVEN_SIGNER, UNPROVEN_IDLE_MS,
  admit, checkProof, checkRemoval, checkpointSigned, forgetKnown, isKnownHere, json, limiterKey, ownerAllowed, parseCheckpoint, readCapped, rememberKnown,
} from "./lib";
import type { Checkpoint, Env, ProofResult, Removal } from "./lib";

/** `reason` of the 400 that asks a member to send its owner proof again (the fleet was deleted or is not held here). */
const PROOF_REQUIRED = "proof-required";

type Tier = "proven" | "unproven" | "retired";

const registry = (env: Env) => env.REGISTRY.get(env.REGISTRY.idFromName("fleets"));

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/status") {
      if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "method not allowed" }, 405, { allow: "GET, HEAD" });
      if (url.pathname === "/") return json({ service: "prime-witness" });
      return registry(env).fetch("https://registry/status");
    }
    const m = /^\/w\/([^/]+)(\/remove)?$/.exec(url.pathname);
    if (!m) return json({ error: "not found" }, 404);
    const fleetKey = m[1]!;
    const removing = m[2] !== undefined;
    if (!FLEET_KEY_RE.test(fleetKey)) return json({ error: "fleetKey must be base64url(sha256(genesis entry)), 43 characters" }, 400);
    const allowedMethods = removing ? "POST" : "GET, POST";
    if (!allowedMethods.split(", ").includes(req.method)) return json({ error: "method not allowed" }, 405, { allow: allowedMethods });

    const now = Date.now();
    const admission = await admit(req, env, now);
    if (admission === "limited") return json({ error: "too many requests" }, 429, { "retry-after": "60" });

    const fleet = () => env.WITNESS.get(env.WITNESS.idFromName(fleetKey));
    const known = async (): Promise<boolean> => {
      if (isKnownHere(fleetKey, now)) return true;
      const yes = ((await (await registry(env).fetch(`https://registry/has?key=${fleetKey}`)).json()) as { known: boolean }).known;
      if (yes) rememberKnown(fleetKey, now);
      return yes;
    };

    if (req.method === "GET") {
      if (!(await known())) return json({ error: "no such fleet" }, 404);
      const listed = await fleet().fetch("https://witness/list");
      if (listed.status === 404) forgetKnown(fleetKey); // deleted since this isolate was told of it
      return listed;
    }

    const text = await readCapped(req, MAX_BODY_BYTES);
    if (text === null) return json({ error: `body over ${MAX_BODY_BYTES} bytes` }, 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: "body is not JSON" }, 400);
    }

    if (removing) {
      const checked = await checkRemoval(body, fleetKey);
      if (!checked.ok) return json({ error: checked.error }, 401);
      if (!(await known())) return json({ error: "no such fleet" }, 404);
      const removed = await fleet().fetch("https://witness/remove", { method: "POST", body: JSON.stringify(checked.removal) });
      if (removed.status === 404) forgetKnown(fleetKey);
      return removed;
    }

    const parsed = parseCheckpoint(body, now);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const c = parsed.value;
    if (c.cp[1] !== fleetKey) return json({ error: "checkpoint is signed for another fleetKey" }, 400);
    if (!(await checkpointSigned(c))) return json({ error: "signature does not verify" }, 401);
    let proof: ProofResult | null = null;
    if (c.proof) {
      const checked = await checkProof(c, fleetKey);
      if (!checked.ok) return json({ error: checked.error }, 401);
      proof = checked.result;
    }

    if (!(await known())) {
      if (proof?.kind !== "owner") return json({ error: "a fleet's first checkpoint must carry the owner's roster proof (proof.genesis, proof.entry, proof.sig)", reason: PROOF_REQUIRED }, 400);
      if (!ownerAllowed(env, proof.owner)) return json({ error: "this witness holds only the fleets of the owners it is set up for" }, 403);
      // A fleet costs the witness an object and a registry row: with the limiter binding down, do not make one.
      if (admission === "degraded") return json({ error: "rate limiter unavailable; try again" }, 503, { "retry-after": "30" });
      const ip = limiterKey(req.headers.get("cf-connecting-ip") ?? "unknown");
      const made = await registry(env).fetch(`https://registry/admit?key=${fleetKey}&ip=${encodeURIComponent(ip)}`, { method: "POST" });
      if (!made.ok) return made;
      rememberKnown(fleetKey, now);
    }
    const stored = await fleet().fetch("https://witness/store", { method: "POST", body: JSON.stringify({ checkpoint: { cp: c.cp, sig: c.sig, spub: c.spub }, proof }) });
    if (stored.status === 400 || stored.status === 403) forgetKnown(fleetKey); // the fleet is not what this isolate was told
    return stored;
  },
};

// ---- the registry: which fleets exist -----------------------------------

export class WitnessRegistry implements DurableObject {
  private readonly sql: SqlStorage;
  private readonly max: number;
  private readonly createsPerHour: number;

  constructor(state: DurableObjectState, env: Env) {
    this.sql = state.storage.sql;
    this.max = Math.max(1, Number(env.MAX_FLEETS) || DEFAULT_MAX_FLEETS);
    this.createsPerHour = Math.max(1, Number(env.FLEET_CREATES_PER_HOUR) || DEFAULT_CREATES_PER_HOUR);
    this.sql.exec("CREATE TABLE IF NOT EXISTS fleets (key TEXT PRIMARY KEY, at INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS refusals (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL, last INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS creations (k TEXT PRIMARY KEY, n INTEGER NOT NULL, since INTEGER NOT NULL)");
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const key = url.searchParams.get("key") ?? "";
    switch (url.pathname) {
      case "/has":
        return json({ known: this.has(key) });
      case "/admit": {
        if (this.has(key)) return json({ ok: true, created: false });
        const now = Date.now();
        // `force` is a fleet object telling the registry about a fleet it already holds: never refused.
        if (url.searchParams.get("force") !== "1") {
          const n = this.count();
          if (n >= this.max) return this.refuse(`${n} fleets held (limit ${this.max})`, "the witness holds the most fleets it will", 507);
          const quota = this.takeCreation(url.searchParams.get("ip") ?? "unknown", now);
          if (!quota) return this.refuse("creation quota of one address used", "too many fleets created from this address; try again later", 429);
        }
        this.sql.exec("INSERT INTO fleets (key, at) VALUES (?, ?)", key, now);
        return json({ ok: true, created: true });
      }
      case "/drop":
        this.sql.exec("DELETE FROM fleets WHERE key = ?", key);
        return json({ ok: true });
      case "/status": {
        const r = this.sql.exec<{ n: number; last: number }>("SELECT n, last FROM refusals").toArray()[0];
        return json({ fleets: this.count(), max: this.max, refused: r?.n ?? 0, lastRefusedAt: r?.last ?? null });
      }
      default:
        return json({ error: "not found" }, 404);
    }
  }

  private has(key: string): boolean {
    return this.sql.exec("SELECT 1 FROM fleets WHERE key = ?", key).toArray().length > 0;
  }

  private count(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM fleets").one().n;
  }

  private refuse(why: string, message: string, status: number): Response {
    this.sql.exec("INSERT INTO refusals (id, n, last) VALUES (1, 1, ?) ON CONFLICT (id) DO UPDATE SET n = n + 1, last = excluded.last", Date.now());
    // The line to alert on: the witness is turning fleets away.
    console.warn(`prime-witness: refusing a new fleet: ${why}`);
    return json({ error: message }, status, status === 429 ? { "retry-after": "3600" } : {});
  }

  // One address (a /64 for IPv6) may create `createsPerHour` fleets an hour. The table of addresses is
  // bounded: expired rows go first, and a full table of live ones refuses creation (fails closed).
  private takeCreation(ip: string, now: number): boolean {
    this.sql.exec("DELETE FROM creations WHERE since < ?", now - 3600_000);
    const row = this.sql.exec<{ n: number }>("SELECT n FROM creations WHERE k = ?", ip).toArray()[0];
    if (row) {
      if (row.n >= this.createsPerHour) return false;
      this.sql.exec("UPDATE creations SET n = n + 1 WHERE k = ?", ip);
      return true;
    }
    if (this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM creations").one().n >= MAX_CREATE_TRACK) return false;
    this.sql.exec("INSERT INTO creations (k, n, since) VALUES (?, 1, ?)", ip, now);
    return true;
  }
}

// ---- one fleet ----------------------------------------------------------

interface Row extends Record<string, SqlStorageValue> {
  spub: string;
  hash: string;
  seq: number;
  cp: string;
  sig: string;
  tier: Tier;
  at: number;
  touched: number;
}
interface Device extends Record<string, SqlStorageValue> {
  device: string;
  n: number;
  spub: string | null;
  removed: number;
}

export class WitnessDO implements DurableObject {
  private readonly sql: SqlStorage;

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    this.sql = state.storage.sql;
  }

  // Tables are made when something is first stored, so an object that is only asked about (or that a
  // deletion emptied) holds nothing for the alarm to clean up.
  private init(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id = 1), fleet TEXT NOT NULL, inc TEXT NOT NULL, owner TEXT NOT NULL, key TEXT NOT NULL)");
    // One row per device the owner's roster named: its current key and the roster position `n` of the entry that set it.
    this.sql.exec("CREATE TABLE IF NOT EXISTS devices (device TEXT PRIMARY KEY, n INTEGER NOT NULL, spub TEXT, removed INTEGER NOT NULL)");
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS cps (
         spub TEXT NOT NULL, hash TEXT NOT NULL, seq INTEGER NOT NULL, cp TEXT NOT NULL, sig TEXT NOT NULL,
         tier TEXT NOT NULL, at INTEGER NOT NULL, touched INTEGER NOT NULL,
         PRIMARY KEY (spub, hash)
       )`,
    );
    // Keys the roster replaced or removed: they never post again unless the owner adds them back.
    this.sql.exec("CREATE TABLE IF NOT EXISTS retired (spub TEXT PRIMARY KEY, at INTEGER NOT NULL)");
  }

  /** The genesis owner of a fleet this object holds, if it holds one. */
  private ownerOfHeld(): string | undefined {
    if (this.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'meta'").toArray().length === 0) return undefined;
    return this.sql.exec<{ owner: string }>("SELECT owner FROM meta").toArray()[0]?.owner;
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/list" || path === "/remove") {
      // Not held, or held for an owner this witness no longer serves: as if it were not here.
      const owner = this.ownerOfHeld();
      if (owner === undefined || !ownerAllowed(this.env, owner)) return json({ error: "no such fleet" }, 404);
    }
    if (path === "/list") return this.list();
    if (req.method === "POST" && path === "/store") {
      const { checkpoint, proof } = JSON.parse(await req.text()) as { checkpoint: Checkpoint; proof: ProofResult | null };
      this.init();
      return this.store(checkpoint, proof);
    }
    if (req.method === "POST" && path === "/remove") return this.remove(JSON.parse(await req.text()) as Removal);
    return json({ error: "not found" }, 404);
  }

  private list(): Response {
    const rows = this.sql.exec<Row>("SELECT * FROM cps ORDER BY touched DESC").toArray();
    return json({
      v: 2,
      now: Date.now(),
      checkpoints: rows.map((r) => ({ cp: JSON.parse(r.cp) as Checkpoint["cp"], sig: r.sig, spub: r.spub, tier: r.tier, at: r.at })),
    });
  }

  private device(device: string): Device | undefined {
    return this.sql.exec<Device>("SELECT * FROM devices WHERE device = ?", device).toArray()[0];
  }
  private liveDeviceOf(spub: string): Device | undefined {
    return this.sql.exec<Device>("SELECT * FROM devices WHERE spub = ? AND removed = 0", spub).toArray()[0];
  }
  private tierOf(spub: string): Tier | undefined {
    return this.sql.exec<{ tier: Tier }>("SELECT tier FROM cps WHERE spub = ? LIMIT 1", spub).toArray()[0]?.tier;
  }

  // A key that no longer holds its device's slot keeps its newest checkpoint as history, outside every count, and posts no more.
  private retire(spub: string): void {
    this.sql.exec("INSERT OR REPLACE INTO retired (spub, at) VALUES (?, ?)", spub, Date.now());
    this.sql.exec("DELETE FROM retired WHERE spub NOT IN (SELECT spub FROM retired ORDER BY at DESC LIMIT ?)", MAX_RETIRED);
    this.sql.exec("UPDATE cps SET tier = 'retired' WHERE spub = ?", spub);
    this.sql.exec("DELETE FROM cps WHERE spub = ? AND touched NOT IN (SELECT MAX(touched) FROM cps WHERE spub = ?)", spub, spub);
  }

  // Everything verifiable without state was verified by the Worker; the decisions below read and write with
  // no await between them (but the one that ends a creation), so they are atomic.
  private async store(c: Checkpoint, proof: ProofResult | null): Promise<Response> {
    const now = Date.now();
    const [, fleetKey, fleet, inc, seq, hash] = c.cp;

    // ---- decide, changing nothing
    const meta = this.sql.exec<{ fleet: string; inc: string; owner: string }>("SELECT fleet, inc, owner FROM meta").toArray()[0];
    if (meta && !ownerAllowed(this.env, meta.owner)) return json({ error: "this witness no longer holds the fleets of this owner" }, 403);
    if (!meta) {
      if (proof?.kind !== "owner") return json({ error: "a fleet's first checkpoint must carry the owner's roster proof", reason: PROOF_REQUIRED }, 400);
      if (!ownerAllowed(this.env, proof.owner)) return json({ error: "this witness holds only the fleets of the owners it is set up for" }, 403);
    } else if (meta.fleet !== fleet || meta.inc !== inc) {
      return json({ error: "checkpoint is for another fleet or incarnation than this one" }, 400);
    }

    const stored = this.tierOf(c.spub);
    let tier: Tier = stored ?? "unproven";
    let takeDevice: { device: string; n: number } | null = null; // the device slot this checkpoint's proof sets to c.spub
    let displaced: string | null = null; // the key that held that slot
    if (proof) {
      const dev = this.device(proof.device);
      const elsewhere = this.liveDeviceOf(c.spub);
      if (elsewhere && elsewhere.device !== proof.device) return json({ error: "this key already holds another device's slot" }, 409);
      if (proof.kind === "rotate") {
        const by = this.liveDeviceOf(proof.by);
        if (!by || by.device !== proof.device) return json({ error: "the key that signed the rotation does not hold this device's slot here" }, 409);
      }
      const current = dev && !dev.removed && dev.spub === c.spub;
      if (!current) {
        if (dev && proof.n <= dev.n) return json({ error: "a later roster entry for this device has been seen; this proof is superseded" }, 409);
        if (!dev || dev.removed) {
          if (this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM devices WHERE removed = 0").one().n >= MAX_DEVICES) {
            return json({ error: `this fleet already has the most devices the witness keeps (${MAX_DEVICES})`, tier: "proven" }, 507);
          }
          if (!dev && this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM devices").one().n >= MAX_DEVICE_RECORDS) {
            return json({ error: "this fleet already has the most device records the witness keeps" }, 507);
          }
        }
        takeDevice = { device: proof.device, n: proof.n };
        displaced = dev && !dev.removed ? dev.spub : null;
      }
      tier = "proven";
    } else if (stored === "retired" || this.sql.exec("SELECT 1 FROM retired WHERE spub = ?", c.spub).toArray().length > 0) {
      return json({ error: "this key was replaced or removed by a later roster entry; it posts no more" }, 409);
    }
    if (tier === "unproven" && stored !== "unproven") {
      if (this.sql.exec<{ n: number }>("SELECT COUNT(DISTINCT spub) AS n FROM cps WHERE tier = 'unproven'").one().n >= MAX_UNPROVEN) {
        return json({ error: `this fleet already has the most unproven signers the witness keeps (${MAX_UNPROVEN})`, tier }, 507);
      }
    }
    const newest = this.sql.exec<Row>("SELECT * FROM cps WHERE spub = ? ORDER BY touched DESC LIMIT 1", c.spub).toArray()[0];
    if (newest && seq < newest.seq) return json({ ok: true, stored: false, tier, reason: "older than this signer's newest" });
    const same = this.sql.exec<{ seq: number }>("SELECT seq FROM cps WHERE spub = ? AND hash = ?", c.spub, hash).toArray()[0];
    if (same && same.seq >= seq) return json({ ok: true, stored: false, tier, reason: "already held" });

    // ---- accepted: change
    if (!meta && proof?.kind === "owner") {
      this.sql.exec("INSERT INTO meta (id, fleet, inc, owner, key) VALUES (1, ?, ?, ?, ?)", fleet, inc, proof.owner, fleetKey);
    }
    if (takeDevice) {
      if (displaced) this.retire(displaced);
      this.sql.exec(
        "INSERT INTO devices (device, n, spub, removed) VALUES (?, ?, ?, 0) ON CONFLICT (device) DO UPDATE SET n = excluded.n, spub = excluded.spub, removed = 0",
        takeDevice.device, takeDevice.n, c.spub,
      );
      this.sql.exec("DELETE FROM retired WHERE spub = ?", c.spub); // the owner has added it back
    }
    if (stored && stored !== tier) this.sql.exec("UPDATE cps SET tier = ? WHERE spub = ?", tier, c.spub);

    const touched = (this.sql.exec<{ m: number | null }>("SELECT MAX(touched) AS m FROM cps").one().m ?? 0) + 1;
    this.sql.exec(
      `INSERT INTO cps (spub, hash, seq, cp, sig, tier, at, touched) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (spub, hash) DO UPDATE SET seq = excluded.seq, cp = excluded.cp, sig = excluded.sig, tier = excluded.tier,
         at = excluded.at, touched = excluded.touched`,
      c.spub, hash, seq, JSON.stringify(c.cp), c.sig, tier, now, touched,
    );
    // History: a signer keeps its own latest rows, and a tier keeps the latest rows overall; every signer's newest always stays.
    const perSigner = tier === "proven" ? ROWS_PER_PROVEN_SIGNER : ROWS_PER_UNPROVEN_SIGNER;
    this.sql.exec("DELETE FROM cps WHERE spub = ? AND touched NOT IN (SELECT touched FROM cps WHERE spub = ? ORDER BY touched DESC LIMIT ?)", c.spub, c.spub, perSigner);
    const cap = tier === "proven" ? MAX_ROWS_PROVEN : MAX_ROWS_UNPROVEN;
    this.sql.exec(
      `DELETE FROM cps WHERE tier = ?
         AND touched NOT IN (SELECT MAX(touched) FROM cps WHERE tier = ? GROUP BY spub)
         AND touched NOT IN (SELECT touched FROM cps WHERE tier = ? ORDER BY touched DESC LIMIT ?)`,
      tier, tier, tier, cap,
    );
    if (!meta) {
      // a fleet this registry may not know (a stale answer here, or a race with a deletion): say so, never refused
      await this.state.storage.setAlarm(now + ALARM_EVERY_MS);
      await this.register();
    }
    return json({ ok: true, stored: true, tier });
  }

  // An owner-signed `remove` frees its device's slot; its key keeps its newest checkpoint as history and posts no more.
  private remove(r: Removal): Response {
    const dev = this.device(r.device);
    if (dev && r.n <= dev.n) return json({ ok: true, applied: false, reason: "a later roster entry for this device has been seen" });
    if (!dev && this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM devices").one().n >= MAX_DEVICE_RECORDS) {
      return json({ error: "this fleet already has the most device records the witness keeps" }, 507);
    }
    if (dev?.spub) this.retire(dev.spub);
    this.sql.exec(
      "INSERT INTO devices (device, n, spub, removed) VALUES (?, ?, ?, 1) ON CONFLICT (device) DO UPDATE SET n = excluded.n, removed = 1",
      r.device, r.n, dev?.spub ?? null,
    );
    return json({ ok: true, applied: true });
  }

  private async register(): Promise<void> {
    const key = this.sql.exec<{ key: string }>("SELECT key FROM meta").toArray()[0]?.key;
    if (key) await this.env.REGISTRY.get(this.env.REGISTRY.idFromName("fleets")).fetch(`https://registry/admit?key=${key}&force=1`, { method: "POST" });
  }

  // Daily: unproven and replaced signers with nothing new for 30 days go; a fleet with nothing new for a year, or
  // none left, is deleted and forgotten by the registry. The registry is told after the delete, and if a post made
  // the fleet again in between, it is told about that fleet again.
  async alarm(): Promise<void> {
    const now = Date.now();
    if (this.ownerOfHeld() === undefined) return; // nothing held: nothing to clean, and no alarm to set
    this.sql.exec("DELETE FROM cps WHERE tier IN ('unproven', 'retired') AND at < ?", now - UNPROVEN_IDLE_MS);
    const last = this.sql.exec<{ m: number | null }>("SELECT MAX(at) AS m FROM cps").one().m;
    const owner = this.ownerOfHeld()!;
    if (!ownerAllowed(this.env, owner) || last === null || last < now - FLEET_IDLE_MS) {
      const key = this.sql.exec<{ key: string }>("SELECT key FROM meta").toArray()[0]?.key;
      await this.state.storage.deleteAll();
      if (key) await this.env.REGISTRY.get(this.env.REGISTRY.idFromName("fleets")).fetch(`https://registry/drop?key=${key}`, { method: "POST" });
      if (this.ownerOfHeld() !== undefined) {
        await this.register();
        await this.state.storage.setAlarm(Date.now() + ALARM_EVERY_MS);
      }
      return;
    }
    await this.state.storage.setAlarm(now + ALARM_EVERY_MS);
  }
}
