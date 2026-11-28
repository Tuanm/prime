// RegistryDO - a SINGLE shared instance that tracks:
//   1. the device -> token map (writable: the admin UI registers devices here;
//      seeded once from the DEVICE_TOKENS secret on first run), and
//   2. which deviceIds are currently online.
//
// A plain Worker cannot enumerate devices or hold shared state across
// isolates, so both the roster and the device registry live in this one
// Durable Object. Everything is persisted to durable storage so it survives
// restarts. The online set is TTL-swept (devices that died without a clean
// unregister).

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./config";
import { FleetCreationAllowance, validFleetId } from "./fleets";
import {
  ANON_ID_RE,
  ANON_TOKEN_ALPHABET,
  ANON_TOKEN_LENGTH,
  FILE_ID_RE,
  anonConfig,
  anonLockKey,
  ipBlockKey,
  r2Budget,
  r2Cost,
  r2MaxBytes,
  r2Round,
  validDeviceId,
  virtualDeviceIds,
} from "./config";
import { bucketBytes, costOf, HitMeter, meterStorage, monthlyBudget, ZERO_USAGE, type UsageCounts } from "./usage";
import { fingerprint, isVerifier, pepperFrom, pepperMissingResponse, verifierFor, type TokenKind } from "./token-hash";

const ONLINE_TTL_DEFAULT_MS = 150_000; // longer than keepalive timeout; swept on read
const TOKEN_MAX = 256; // token length cap (sanity bound)
const UNMIGRATED = "unmigrated"; // served in place of a value that is not a verifier yet

/** fileId -> owning deviceId, for /files/{id} downloads that carry only an id. */
interface FileIndexEntry {
  deviceId: string;
  expiresAt: number;
}

interface DeviceRec {
  seenAt: number;
}

/**
 * An anonymous device: created by POST /api/devices/anonymous with a generated
 * id and a 25-character device code (older ones are 6). Its id and token live in `tokens` like any
 * other device, so every auth path treats it the same; this record is what makes
 * it anonymous. `ref` is a separate random handle - the admin UI addresses the
 * device by it, so the admin never sees (or can change) the id or the token.
 */
interface AnonRec {
  ref: string;
  createdAt: number;
  lastSeenAt: number | null; // null until it first connects
}

/** How often the bucket is listed to learn how much it holds. */
const STORAGE_MEASURE_EVERY_MS = 6 * 60 * 60_000;
const STORAGE_MEASURE_RETRY_MS = 10 * 60_000;

/** Persist an anonymous device's lastSeenAt at most this often (it re-registers every 30s). */
const ANON_SEEN_PERSIST_MS = 5 * 60_000;

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Unbiased device code: rejection-sample bytes into the 36-symbol alphabet. */
function randomDeviceCode(): string {
  const n = ANON_TOKEN_ALPHABET.length; // 36
  const limit = 256 - (256 % n); // 252: bytes at or above it would bias the low symbols
  let out = "";
  while (out.length < ANON_TOKEN_LENGTH) {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < limit && out.length < ANON_TOKEN_LENGTH) out += ANON_TOKEN_ALPHABET[b % n];
    }
  }
  return out;
}

/**
 * What the account has spent this month, and what it is holding.
 *
 * `bytes` is deliberately *not* reset when the month rolls over: bytes admitted
 * last month are still stored, and still billed, this month. Keeping it as a
 * standing ceiling means the storage bound holds across the boundary instead of
 * resetting to zero while the data is still there. Operation counts are
 * per-month, which is how R2 bills them.
 */
interface R2BudgetState {
  month: string; // UTC "YYYY-MM", the month classA/classB belong to
  bytes: number; // live bytes admitted and not yet released
  classA: number;
  classB: number;
}

/** The month a count belongs to: 2026-11. The same shape the usage meter uses. */
function monthKey(now: number = Date.now()): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export class RegistryDO extends DurableObject<Env> {
  private online = new Map<string, DeviceRec>();
  // deviceId -> verifier of its token (authoritative; see token-hash.ts). A value
  // that is not a verifier can only be one waiting for TOKEN_PEPPER to be
  // migrated: it is kept, but never served and never matched.
  private tokens = new Map<string, string>();
  private virtual = new Set<string>(); // in-process devices: always online, never swept
  private disabled = new Set<string>(); // deactivated devices: rejected at /mcp + /ws
  private blockedIps = new Set<string>(); // addresses refused everywhere (see ipBlockKey)
  private fileIndex = new Map<string, FileIndexEntry>(); // global: fileId -> device
  private budget: R2BudgetState = { month: monthKey(), bytes: 0, classA: 0, classB: 0 };
  private onlineTtlMs = ONLINE_TTL_DEFAULT_MS;
  private anon = new Map<string, AnonRec>(); // deviceId -> record (persisted)
  private anonCreates = new Map<string, number[]>(); // client IP -> recent creation times (memory)
  private anonFailures = new Map<string, number[]>(); // anonLockKey(device, address) -> recent wrong-token times (memory)
  private anonLockedUntil = new Map<string, number>(); // anonLockKey(device, address) -> lock expiry (memory)
  private fleetCreates = new FleetCreationAllowance();
  private fleets = new Set<string>(); // the fleets that exist (persisted)
  private fleetBuddies = new Map<string, string>(); // fleetId -> verifier of its token (persisted)
  // The fleets the operator has paused. The fleet object is the authority on this;
  // the registry keeps a copy so the Worker can answer for a paused fleet without
  // waking the object, which is the whole point of pausing one.
  private pausedFleets = new Set<string>(); // fleetId (persisted)

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const ttl = parseInt(env.ONLINE_TTL_MS || "", 10);
    if (Number.isFinite(ttl) && ttl > 0) this.onlineTtlMs = ttl;
    // Warm from durable storage on wake (hibernation restores memory too, but
    // this covers cold starts after eviction). Seed the device map from the
    // DEVICE_TOKENS secret the first time the object is created.
    this.ctx.blockConcurrencyWhile(async () => {
      try {
        const savedFleets = (await this.storage.get<string[]>("fleets")) || [];
        for (const id of savedFleets) if (validFleetId(id)) this.fleets.add(id);
      } catch {}
      try {
        const paused = (await this.storage.get<string[]>("paused_fleets")) || [];
        for (const id of paused) if (validFleetId(id)) this.pausedFleets.add(id);
      } catch {}
      try {
        const buddies = (await this.storage.get<Record<string, string>>("fleet_buddies")) || {};
        for (const [id, token] of Object.entries(buddies)) {
          if (validFleetId(id) && typeof token === "string" && token.length > 0) this.fleetBuddies.set(id, token);
        }
        if (await this.migrate(this.fleetBuddies, "fleet")) await this.persistFleetBuddies();
      } catch {}
      try {
        const saved = (await this.storage.get<string[]>("online")) || [];
        const now = Date.now();
        for (const id of saved) {
          if (validDeviceId(id)) this.online.set(id, { seenAt: now });
        }
      } catch {}
      try {
        const saved = (await this.storage.get<Record<string, string>>("device_tokens")) || {};
        for (const [id, tok] of Object.entries(saved)) {
          if (validDeviceId(id) && typeof tok === "string" && tok.length > 0) this.tokens.set(id, tok);
        }
        // A value that is not a verifier yet becomes one here, and is written
        // back before the first answer leaves this object.
        if (await this.migrate(this.tokens, "device")) await this.persistTokens();
        // The seeds are secrets; what is stored from them is their verifiers.
        // Without a pepper nothing can be hashed, so nothing is seeded yet.
        const peppered = pepperFrom(this.env) !== null;
        if (peppered && this.tokens.size === 0 && this.env.DEVICE_TOKENS) {
          try {
            const seed = JSON.parse(this.env.DEVICE_TOKENS) as Record<string, unknown>;
            for (const [id, tok] of Object.entries(seed)) {
              if (typeof tok === "string" && validDeviceId(id) && tok.length > 0) {
                this.tokens.set(id, await verifierFor(this.env, "device", tok));
              }
            }
            if (this.tokens.size > 0) await this.persistTokens();
          } catch {}
        }
        // Virtual devices: merge their tokens unconditionally (they may be the
        // only entries on a fresh registry) and mark them always-online. Only a
        // verifier that differs is a change worth writing.
        if (peppered && this.env.VIRTUAL_DEVICE_TOKENS) {
          try {
            const seed = JSON.parse(this.env.VIRTUAL_DEVICE_TOKENS) as Record<string, unknown>;
            let changed = false;
            for (const [id, tok] of Object.entries(seed)) {
              if (typeof tok === "string" && validDeviceId(id) && tok.length > 0) {
                const verifier = await verifierFor(this.env, "device", tok);
                if (this.tokens.get(id) !== verifier) {
                  this.tokens.set(id, verifier);
                  changed = true;
                }
              }
            }
            if (changed) await this.persistTokens();
          } catch {}
        }
        for (const id of virtualDeviceIds(this.env)) {
          this.virtual.add(id);
          this.online.set(id, { seenAt: Date.now() });
        }
        this.blockedIps = new Set((await this.storage.get<string[]>("blocked-ips")) || []);
      const savedDisabled = (await this.storage.get<string[]>("disabled")) || [];
        for (const id of savedDisabled) {
          if (validDeviceId(id)) this.disabled.add(id);
        }
        const savedBudget = (await this.storage.get<R2BudgetState>("r2_budget")) || null;
        if (savedBudget && typeof savedBudget.month === "string") {
          this.budget = {
            month: savedBudget.month,
            bytes: Math.max(0, Number(savedBudget.bytes) || 0),
            classA: Math.max(0, Number(savedBudget.classA) || 0),
            classB: Math.max(0, Number(savedBudget.classB) || 0),
          };
        }
        const savedAnon = (await this.storage.get<Record<string, AnonRec>>("anon_devices")) || {};
        for (const [id, rec] of Object.entries(savedAnon)) {
          // An anonymous record without its token is debris from a partial write.
          if (validDeviceId(id) && this.tokens.has(id) && rec && typeof rec.ref === "string") this.anon.set(id, rec);
        }
        const savedIndex = (await this.storage.get<Record<string, FileIndexEntry>>("file_index")) || {};
        const now = Date.now();
        for (const [fileId, entry] of Object.entries(savedIndex)) {
          if (entry && validDeviceId(entry.deviceId) && entry.expiresAt > now) this.fileIndex.set(fileId, entry);
        }
      } catch {}
    });
  }

  /** Its own hits and busy time, kept in memory and folded into the month in batches. */
  private readonly meter = new HitMeter((add) => {
    this.addUsage(add).catch(() => {});
  });

  /** This object's storage, with the rows it reads and writes counted. */
  private metered?: DurableObjectStorage;
  private get storage(): DurableObjectStorage {
    return (this.metered ??= meterStorage(this.ctx.storage, this.meter));
  }

  async fetch(request: Request): Promise<Response> {
    // The metering routes are the meter itself: counting them would be a tail
    // chasing itself.
    if (request.url.includes("/usage-add")) return this.serve(request);
    this.meter.hit();
    return this.meter.busy(() => this.serve(request));
  }

  private async serve(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "POST" && path === "/register") {
      const id = url.searchParams.get("id") || "";
      if (!validDeviceId(id)) return Response.json({ error: "invalid deviceId" }, { status: 400 });
      const now = Date.now();
      this.online.set(id, { seenAt: now });
      await this.persist();
      const rec = this.anon.get(id);
      if (rec) {
        const stale = rec.lastSeenAt === null || now - rec.lastSeenAt > ANON_SEEN_PERSIST_MS;
        rec.lastSeenAt = now;
        if (stale) await this.persistAnon();
      }
      return Response.json({ ok: true, deviceId: id });
    }

    if (request.method === "POST" && path === "/unregister") {
      const id = url.searchParams.get("id") || "";
      this.online.delete(id);
      await this.persist();
      return Response.json({ ok: true, deviceId: id });
    }

    // The fleets that exist. The list lives here so the operator can see
    // them: each fleet is its own object, and there is no way to enumerate
    // objects.
    // ---- what the gateway has used this month ----
    //
    // The counts are added by whoever made them: the Worker adds the requests
    // it served, each Durable Object adds the requests it served and how long
    // it was busy, and the fleet routes add the R2 calls they made.
    // They are added in batches, because a write per request would itself cost
    // more than it measures.
    if (request.method === "POST" && path === "/usage-add") {
      const body = (await request.json().catch(() => ({}))) as Partial<UsageCounts>;
      const add: Partial<UsageCounts> = {};
      for (const key of ["gatewayRequests", "doRequests", "doActiveMs", "r2Writes", "r2Reads", "doRowsWritten", "doRowsRead"] as const) {
        const value = Number((body as Record<string, unknown>)[key] ?? 0);
        if (Number.isFinite(value) && value > 0) add[key] = Math.floor(value);
      }
      await this.addUsage(add);
      return Response.json({ ok: true });
    }
    if (request.method === "GET" && path === "/usage") {
      await this.measureStorage();
      const counts = await this.readUsage(monthKey());
      const cost = costOf(counts);
      const budget = monthlyBudget(this.env as unknown as Record<string, string | undefined>);
      return Response.json({
        month: monthKey(),
        counts,
        cost,
        budgetUsd: budget,
        spentUsd: cost.total,
        remainingUsd: Math.round((budget - cost.total) * 100) / 100,
        overBudget: cost.total >= budget,
      });
    }

    if (request.method === "GET" && path === "/fleets") {
      return Response.json({ fleets: [...this.fleets].sort() });
    }
    if (request.method === "POST" && (path === "/fleet-add" || path === "/fleet-remove")) {
      const id = url.searchParams.get("id") || "";
      if (!validFleetId(id)) return Response.json({ error: "invalid fleet id" }, { status: 400 });
      if (path === "/fleet-add") this.fleets.add(id);
      else {
        this.fleets.delete(id);
        // A fleet that no longer exists cannot be reached as a device.
        if (this.fleetBuddies.delete(id)) await this.persistFleetBuddies();
        // ...and a fleet that is gone is not paused: the name may be made again.
        if (this.pausedFleets.delete(id)) await this.persistPaused();
      }
      await this.persistFleets();
      return Response.json({ ok: true, fleets: this.fleets.size });
    }

    // Whether the fleet is paused, as the operator last said. The Worker reads it
    // from the snapshot and answers for a paused fleet itself.
    if (request.method === "POST" && path === "/fleet-paused") {
      const id = url.searchParams.get("id") || "";
      if (!validFleetId(id)) return Response.json({ error: "invalid fleet id" }, { status: 400 });
      const want = url.searchParams.get("paused") === "1";
      const had = this.pausedFleets.has(id);
      if (want && !had) this.pausedFleets.add(id);
      if (!want && had) this.pausedFleets.delete(id);
      if (want !== had) await this.persistPaused();
      return Response.json({ ok: true, paused: want });
    }

    // Whether an id is already spoken for. A fleet is reached as a device
    // under its own name, so the two namespaces must not overlap.
    if (request.method === "GET" && path === "/name-taken") {
      const id = url.searchParams.get("id") || "";
      const kind = url.searchParams.get("kind") || "";
      if (kind === "fleet") {
        return Response.json({ taken: this.tokens.has(id) || this.anon.has(id), by: "device" });
      }
      if (kind === "device") {
        const byFleet = this.fleets.has(id) || this.fleetBuddies.has(id);
        return Response.json({ taken: byFleet, by: byFleet ? "fleet" : "" });
      }
      return Response.json({ error: "kind is fleet or device" }, { status: 400 });
    }

    // A fleet may be reached as a device: the operator gives it a token, and
    // a client that presents it talks to the fleet's primary. The token is
    // kept here, with the device tokens, because this is where the gateway
    // looks when it is deciding who is calling.
    if (request.method === "GET" && path === "/fleet-buddies") {
      return Response.json({ buddies: RegistryDO.verifiersOnly(this.fleetBuddies) });
    }
    if (request.method === "POST" && path === "/fleet-buddy") {
      const id = url.searchParams.get("id") || "";
      if (!validFleetId(id)) return Response.json({ error: "invalid fleet id" }, { status: 400 });
      const body = (await request.json().catch(() => ({}))) as { token?: unknown };
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (token === "") {
        this.fleetBuddies.delete(id);
        await this.persistFleetBuddies();
        return Response.json({ ok: true, cleared: true });
      }
      if (token.length < 8 || token.length > 256 || !/^[\x21-\x7e]+$/.test(token)) {
        return Response.json({ error: "a token is 8 to 256 printable characters" }, { status: 400 });
      }
      if (pepperFrom(this.env) === null) return pepperMissingResponse();
      this.fleetBuddies.set(id, await verifierFor(this.env, "fleet", token));
      await this.persistFleetBuddies();
      return Response.json({ ok: true });
    }

    // A device may create only a few fleets an hour. The counter lives here
    // because this object is the one shared by every device: a counter kept
    // in the fleet's own object would be fresh for every new fleet, and so
    // would never count anything.
    if (request.method === "POST" && path === "/fleet-created") {
      const id = url.searchParams.get("id") || "";
      if (!validDeviceId(id)) return Response.json({ error: "invalid deviceId" }, { status: 400 });
      return Response.json({ ok: true, count: this.fleetCreates.record(id) });
    }

    if (request.method === "GET" && path === "/fleet-count") {
      const id = url.searchParams.get("id") || "";
      if (!validDeviceId(id)) return Response.json({ error: "invalid deviceId" }, { status: 400 });
      return Response.json({ count: this.fleetCreates.count(id) });
    }

    if (request.method === "GET" && path === "/devices") {
      this.sweep();
      // Anonymous ids are never shown to an operator.
      return Response.json({ devices: [...this.online.keys()].filter((id) => !this.anon.has(id)) });
    }

    // ---- device registry (admin UI) ----

    // A device that proves itself to the fleet is still in use, even though
    // it never opens a tunnel. Without this it would be collected as unused
    // and the fleet would lose its members.
    if (request.method === "POST" && path === "/anon/seen") {
      const id = url.searchParams.get("id") || "";
      if (!validDeviceId(id)) return Response.json({ error: "invalid deviceId" }, { status: 400 });
      const rec = this.anon.get(id);
      if (!rec) return Response.json({ ok: true, seen: false });
      rec.lastSeenAt = Date.now();
      await this.persistAnon();
      return Response.json({ ok: true, seen: true });
    }

    if (request.method === "GET" && path === "/map") {
      // Expire anonymous devices here too: this is what the entry authenticates
      // against, so a deleted one stops working within the cache TTL.
      await this.gcAnon();
      const now = Date.now();
      return Response.json({
        map: RegistryDO.verifiersOnly(this.tokens),
        anonymous: [...this.anon.keys()],
        online: [...this.online.keys()],
        // Each is a device and the address that was locked out of it (see `anonLockKey`).
        locked: [...this.anonLockedUntil].filter(([, until]) => until > now).map(([key]) => key),
        buddies: RegistryDO.verifiersOnly(this.fleetBuddies),
        paused: [...this.pausedFleets],
        // Read on every request the Worker gates, so they come in the same
        // answer instead of an ask of their own each.
        blocked: [...this.blockedIps].sort(),
        disabled: [...this.disabled],
      });
    }

    // ---- anonymous devices ----

    if (request.method === "POST" && path === "/anon/create") {
      const policy = anonConfig(this.env);
      if (!policy.enabled) return Response.json({ error: "anonymous devices are disabled" }, { status: 403 });
      const body = (await request.json().catch(() => ({}))) as { ip?: unknown; exempt?: unknown };
      const ip = String(body.ip || "unknown").slice(0, 64);
      const now = Date.now();
      await this.gcAnon();

      // Per-IP creation limit, held here so it is global rather than per isolate.
      // A device that is about to join a fleet is exempt: the Worker has
      // checked the invite, and the fleet has limits of its own.
      const recent = body.exempt === true ? [] : (this.anonCreates.get(ip) || []).filter((t) => now - t < policy.createWindowMs);
      if (recent.length >= policy.createMax) {
        const retry = Math.max(1, policy.createWindowMs - (now - recent[0]));
        return Response.json(
          { error: "rate limited", retry_after_ms: retry },
          { status: 429, headers: { "retry-after": String(Math.ceil(retry / 1000)) } },
        );
      }
      if (this.deviceCount() >= policy.maxDevices) {
        return Response.json({ error: "device limit reached", max_devices: policy.maxDevices }, { status: 503 });
      }

      let id = "";
      do id = "anon-" + randomHex(8);
      while (this.tokens.has(id) || this.virtual.has(id));
      if (pepperFrom(this.env) === null) return pepperMissingResponse();
      // The code is answered once, here; what is kept is its verifier.
      const token = randomDeviceCode();
      this.tokens.set(id, await verifierFor(this.env, "device", token));
      this.anon.set(id, { ref: randomHex(12), createdAt: now, lastSeenAt: null });
      recent.push(now);
      this.anonCreates.set(ip, recent);
      this.pruneCreates(now, policy.createWindowMs);
      // Token first: an anonymous record without a token is discarded on load,
      // the reverse would be a device nobody can see.
      await this.persistTokens();
      await this.persistAnon();
      return Response.json({ deviceId: id, token }, { status: 201 });
    }

    if (request.method === "GET" && path === "/anon/list") {
      this.sweep();
      await this.gcAnon();
      const policy = anonConfig(this.env);
      const now = Date.now();
      const devices = [...this.anon.entries()]
        .map(([id, rec]) => ({
          // The id is for the gateway, which needs it to tell a fleet's space
          // from a stray; it is stripped before the list reaches a page.
          id,
          ref: rec.ref,
          online: this.online.has(id),
          disabled: this.disabled.has(id),
          // Whether any address is locked out of it right now.
          locked: this.lockedOut(id, now),
          createdAt: rec.createdAt,
          lastSeenAt: rec.lastSeenAt,
        }))
        .sort((a, b) => a.createdAt - b.createdAt);
      return Response.json({ devices, count: this.deviceCount(), max_devices: policy.maxDevices });
    }

    // Internal only (the entry never exposes it): ref -> id, so the admin API
    // can act on an anonymous device without the UI ever holding the id.
    if (request.method === "GET" && path === "/anon/resolve") {
      const ref = url.searchParams.get("ref") || "";
      for (const [id, rec] of this.anon) {
        if (rec.ref === ref) return Response.json({ deviceId: id });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    }

    // A wrong device code for an anonymous device. Too many misses lock the address they came from
    // out of that device until the window passes - enforced here, globally, rather than per isolate.
    // The lock is per (device, address): a stranger's wrong codes lock the stranger, never the member
    // whose code is right (the code is long enough, since it is made, that guessing it is out of reach).
    if (request.method === "POST" && path === "/anon/fail") {
      const id = url.searchParams.get("id") || "";
      if (!this.anon.has(id)) return Response.json({ locked: false });
      const policy = anonConfig(this.env);
      const now = Date.now();
      const key = anonLockKey(id, url.searchParams.get("ip") || "");
      const misses = (this.anonFailures.get(key) || []).filter((t) => now - t < policy.authLockMs);
      misses.push(now);
      // Re-inserted, so the oldest in the map is the one that has been quiet longest.
      this.anonFailures.delete(key);
      this.anonFailures.set(key, misses);
      this.pruneFailures(now, policy.authLockMs);
      const locked = misses.length >= policy.authMaxFailures;
      if (locked) this.anonLockedUntil.set(key, now + policy.authLockMs);
      return Response.json({ locked });
    }

    // Addresses refused at the edge of the Worker (both devices and MCP clients).
    if (path === "/blocked") {
      if (request.method === "GET") return Response.json({ ips: [...this.blockedIps].sort() });
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }
      const given = typeof (body as { ip?: unknown })?.ip === "string" ? String((body as { ip: string }).ip) : "";
      const key = ipBlockKey(given);
      if (!key) return Response.json({ error: "not a usable address" }, { status: 400 });
      if (request.method === "POST") this.blockedIps.add(key);
      else if (request.method === "DELETE") this.blockedIps.delete(key);
      else return Response.json({ error: "method not allowed" }, { status: 405 });
      await this.storage.put("blocked-ips", [...this.blockedIps]);
      return Response.json({ ok: true, key, blocked: this.blockedIps.has(key) });
    }

    if (request.method === "GET" && path === "/disabled") {
      return Response.json({ disabled: [...this.disabled] });
    }

    // ---- file index ----
    // A download URL carries only a file id, but the metadata lives in the
    // per-device FilesDO, so this global map resolves id -> device. Entries
    // expire with their file, so a lookup after expiry returns 404 and drops
    // the entry rather than leaking it forever.

    if (request.method === "POST" && path === "/file-index") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }
      const { fileId, deviceId, expiresAt } = (body || {}) as {
        fileId?: unknown;
        deviceId?: unknown;
        expiresAt?: unknown;
      };
      const id = String(fileId || "");
      const owner = String(deviceId || "");
      const expires = Number(expiresAt);
      if (!FILE_ID_RE.test(id)) return Response.json({ error: "invalid fileId" }, { status: 400 });
      if (!validDeviceId(owner)) return Response.json({ error: "invalid deviceId" }, { status: 400 });
      if (!Number.isFinite(expires)) return Response.json({ error: "invalid expiresAt" }, { status: 400 });
      this.fileIndex.set(id, { deviceId: owner, expiresAt: expires });
      await this.persistFileIndex();
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && path === "/file-unindex") {
      let id = url.searchParams.get("id") || "";
      if (!id) {
        try {
          id = String(((await request.json()) as { fileId?: unknown }).fileId || "");
        } catch {}
      }
      const removed = this.fileIndex.delete(id);
      if (removed) await this.persistFileIndex();
      return Response.json({ ok: true, removed });
    }

    if (request.method === "GET" && path === "/file-lookup") {
      const id = url.searchParams.get("id") || "";
      if (!FILE_ID_RE.test(id)) return Response.json({ error: "invalid fileId" }, { status: 400 });
      const entry = this.fileIndex.get(id);
      if (!entry) return Response.json({ error: "not found" }, { status: 404 });
      if (entry.expiresAt <= Date.now()) {
        this.fileIndex.delete(id);
        await this.persistFileIndex();
        return Response.json({ error: "expired" }, { status: 404 });
      }
      return Response.json({ deviceId: entry.deviceId });
    }

    // ---- R2 monthly budget ----
    // A hard ceiling on what the gateway will let this account spend on R2. The
    // entry asks before an upload, so one device cannot run up the bill, and the
    // bytes are released again when a file is deleted or expires.

    if (request.method === "GET" && path === "/budget") {
      this.rollBudgetMonth();
      return Response.json(this.budgetStatus());
    }

    if (request.method === "POST" && path === "/budget/admit") {
      const body = (await request.json().catch(() => ({}))) as { bytes?: unknown; classA?: unknown };
      const wantBytes = Math.max(0, Number(body.bytes) || 0);
      const wantOps = Math.max(0, Number(body.classA) || 0);
      this.rollBudgetMonth();
      const budget = r2Budget(this.env);
      const projected = r2Cost(
        {
          bytes: this.budget.bytes + wantBytes,
          classA: this.budget.classA + wantOps,
          classB: this.budget.classB,
        },
        budget,
      );
      if (projected.totalUsd > budget.budgetUsd) {
        return Response.json(
          { error: "monthly R2 budget would be exceeded", projected_usd: r2Round(projected.totalUsd), ...this.budgetStatus() },
          { status: 507 },
        );
      }
      this.budget.bytes += wantBytes;
      this.budget.classA += wantOps;
      await this.persistBudget();
      return Response.json({ ok: true, ...this.budgetStatus() });
    }

    if (request.method === "POST" && path === "/budget/release") {
      const body = (await request.json().catch(() => ({}))) as { bytes?: unknown; classA?: unknown };
      const freed = Math.max(0, Number(body.bytes) || 0);
      this.budget.bytes = Math.max(0, this.budget.bytes - freed);
      this.budget.classA += Math.max(0, Number(body.classA) || 0);
      await this.persistBudget();
      return Response.json({ ok: true, ...this.budgetStatus() });
    }

    if (request.method === "POST" && path === "/budget/ops") {
      const body = (await request.json().catch(() => ({}))) as { classA?: unknown; classB?: unknown };
      this.rollBudgetMonth();
      this.budget.classA += Math.max(0, Number(body.classA) || 0);
      this.budget.classB += Math.max(0, Number(body.classB) || 0);
      await this.persistBudget();
      return Response.json({ ok: true, ...this.budgetStatus() });
    }

    // Deactivate/activate a device (persisted). Disabled devices are rejected
    // with 403 by the gateway entry before any request reaches a tunnel/DO.
    if (request.method === "POST" && path === "/setstate") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }
      const { deviceId, disabled } = (body || {}) as { deviceId?: unknown; disabled?: unknown };
      const id = String(deviceId || "").trim();
      if (!validDeviceId(id)) return Response.json({ error: "invalid deviceId" }, { status: 400 });
      const dis = disabled === true || disabled === "true";
      if (dis) this.disabled.add(id);
      else this.disabled.delete(id);
      await this.persistDisabled();
      return Response.json({ ok: true, deviceId: id, disabled: dis });
    }

    // The devices that are connected right now.
    //
    // The device list leaves the anonymous devices out, because their ids
    // are not shown; the fleet view needs to know whether the members of a
    // fleet are connected, so it asks for them here.
    if (request.method === "GET" && path === "/online") {
      this.sweep();
      return Response.json({ online: [...this.online.keys()], disabled: [...this.disabled] });
    }

    if (request.method === "GET" && path === "/full") {
      this.sweep();
      await this.gcAnon();
      const devices = await this.deviceList();
      return Response.json({ devices, count: this.deviceCount(), max_devices: anonConfig(this.env).maxDevices });
    }

    if (request.method === "POST" && path === "/upsert") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }
      const { deviceId, token, replaces } = (body || {}) as { deviceId?: unknown; token?: unknown; replaces?: unknown };
      const id = String(deviceId || "").trim();
      const tok = String(token || "").trim();
      const old = String(replaces || "").trim();
      if (!validDeviceId(id)) return Response.json({ error: "invalid deviceId" }, { status: 400 });
      // A rename (id changed in the UI) replaces a registered device in one step,
      // so it still works with the registry full.
      const renaming = old !== "" && old !== id && this.tokens.has(old) && !this.anon.has(old) && !this.virtual.has(old);
      // A rename may come without a token: the device keeps the one it has.
      // Anything else needs a token to store.
      if (tok.length > TOKEN_MAX || (!tok && !renaming)) {
        return Response.json({ error: "token must be 1-" + TOKEN_MAX + " chars" }, { status: 400 });
      }
      // The anonymous namespace is the gateway's: an admin-made "anon-..." device
      // would be indistinguishable from one, and overwriting a live anonymous
      // device would hijack it.
      if (ANON_ID_RE.test(id) || this.anon.has(id)) {
        return Response.json({ error: "device ids starting with anon- are reserved for anonymous devices" }, { status: 400 });
      }
      if (tok && pepperFrom(this.env) === null) return pepperMissingResponse();
      await this.gcAnon();
      const max = anonConfig(this.env).maxDevices;
      if (!this.tokens.has(id) && !renaming && this.deviceCount() >= max) {
        return Response.json({ error: "device limit reached (" + max + " devices, registered and anonymous)", max_devices: max }, { status: 409 });
      }
      const before = this.tokens.get(id);
      const stored = tok ? await verifierFor(this.env, "device", tok) : (this.tokens.get(old) as string);
      this.tokens.set(id, stored);
      if (renaming) {
        this.tokens.delete(old);
        this.online.delete(old);
        if (this.disabled.delete(old)) await this.persistDisabled();
        await this.persist();
      }
      await this.persistTokens();
      this.sweep();
      // Whether a device that was here now answers to another token: the
      // entry drops a tunnel the old token opened.
      const rotated = before !== undefined && before !== stored;
      return Response.json({ ok: true, rotated, devices: await this.deviceList() });
    }

    if (request.method === "POST" && path === "/remove") {
      let id = "";
      try {
        const body = (await request.json()) as { deviceId?: unknown };
        id = String((body && body.deviceId) || "").trim();
      } catch {
        id = url.searchParams.get("id") || "";
      }
      if (!validDeviceId(id)) return Response.json({ error: "invalid deviceId" }, { status: 400 });
      await this.removeDevice(id);
      this.sweep();
      return Response.json({ ok: true, devices: await this.deviceList() });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  }

  /** Devices that count against MAX_DEVICES: registered and anonymous, not virtual. */
  private deviceCount(): number {
    let n = 0;
    for (const id of this.tokens.keys()) if (!this.virtual.has(id)) n++;
    return n;
  }

  private async removeDevice(id: string): Promise<void> {
    this.tokens.delete(id);
    this.online.delete(id);
    this.disabled.delete(id);
    const wasAnon = this.anon.delete(id);
    this.forgetLocks(id);
    await this.persistTokens();
    await this.persist();
    await this.persistDisabled();
    if (wasAnon) await this.persistAnon();
  }

  /**
   * Delete anonymous devices nobody is using: never connected within
   * ANON_UNUSED_TTL_MS of creation, or offline for ANON_IDLE_TTL_MS. Without
   * this, abandoned `prime connect` runs would fill the device cap for good.
   */
  private async gcAnon(): Promise<void> {
    if (this.anon.size === 0) return;
    const policy = anonConfig(this.env);
    const now = Date.now();
    this.sweep();
    const doomed: string[] = [];
    for (const [id, rec] of this.anon) {
      if (this.online.has(id)) continue;
      const age = rec.lastSeenAt === null ? now - rec.createdAt : now - rec.lastSeenAt;
      const ttl = rec.lastSeenAt === null ? policy.unusedTtlMs : policy.idleTtlMs;
      if (age > ttl) doomed.push(id);
    }
    for (const id of doomed) {
      this.tokens.delete(id);
      this.online.delete(id);
      this.disabled.delete(id);
      this.anon.delete(id);
      this.forgetLocks(id);
    }
    if (doomed.length) {
      await this.persistTokens();
      await this.persist();
      await this.persistDisabled();
      await this.persistAnon();
    }
    for (const [id, until] of this.anonLockedUntil) if (until <= now) this.anonLockedUntil.delete(id);
  }

  /** Whether any address is locked out of the device. */
  private lockedOut(id: string, now: number): boolean {
    const prefix = id + "|";
    for (const [key, until] of this.anonLockedUntil) if (until > now && key.startsWith(prefix)) return true;
    return false;
  }

  /** Forget every miss and lock held against a device that is gone. */
  private forgetLocks(id: string): void {
    const prefix = id + "|";
    for (const key of [...this.anonFailures.keys()]) if (key.startsWith(prefix)) this.anonFailures.delete(key);
    for (const key of [...this.anonLockedUntil.keys()]) if (key.startsWith(prefix)) this.anonLockedUntil.delete(key);
  }

  /**
   * Bound the misses kept: a stranger can make one entry for each address it has, so what has had no
   * miss in the window is dropped, and past a hard cap the quietest go first.
   */
  private pruneFailures(now: number, windowMs: number): void {
    if (this.anonFailures.size < 2000) return;
    for (const [key, times] of this.anonFailures) {
      if (!times.some((t) => now - t < windowMs)) this.anonFailures.delete(key);
    }
    for (const key of this.anonFailures.keys()) {
      if (this.anonFailures.size <= 10_000) break;
      this.anonFailures.delete(key);
    }
  }

  /** Bound the per-IP creation map: drop IPs with nothing left in the window. */
  private pruneCreates(now: number, windowMs: number): void {
    if (this.anonCreates.size < 1000) return;
    for (const [ip, times] of this.anonCreates) {
      if (!times.some((t) => now - t < windowMs)) this.anonCreates.delete(ip);
    }
  }

  private async persistAnon(): Promise<void> {
    try {
      await this.storage.put("anon_devices", Object.fromEntries(this.anon));
    } catch {}
  }

  private sweep(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, rec] of this.online) {
      if (this.virtual.has(id)) continue; // virtual devices never go stale
      if (now - rec.seenAt > this.onlineTtlMs) {
        this.online.delete(id);
        changed = true;
      }
    }
    if (changed) this.persist().catch(() => {});
  }

  private async persist(): Promise<void> {
    try {
      await this.storage.put("online", [...this.online.keys()]);
    } catch {}
  }

  /** This month's counts, kept as one small record, and what the bucket holds as last measured. */
  private async readUsage(month: string): Promise<UsageCounts> {
    const saved = (await this.storage.get<Partial<UsageCounts> & { doMinutes?: number }>("usage:" + month)) ?? {};
    // Minutes were how busy time was once guessed: a minute with a request in
    // it counted as sixty seconds, many times what is billed. They are dropped.
    const { doMinutes: _minutes, ...counts } = saved;
    const stored = await this.storage.get<{ bytes?: number }>("r2storage");
    return { ...ZERO_USAGE, ...counts, r2StoredBytes: Math.max(0, Number(stored?.bytes) || 0) };
  }

  /**
   * What the bucket holds, measured now and then rather than at every change: the bytes go up with a
   * publish and down with an eviction, in several places, and a count kept in step with all of them
   * would drift. A listing of the bucket does not, and costs a few Class A calls (counted) a day.
   */
  private measuringStorage = false;
  private measureFailedAt = 0;
  private async measureStorage(): Promise<void> {
    const bucket = this.env.BUCKET;
    if (!bucket || this.measuringStorage) return;
    const now = Date.now();
    // A listing that failed is tried again in a few minutes, not by every ask of the guard.
    if (now >= this.measureFailedAt && now - this.measureFailedAt < STORAGE_MEASURE_RETRY_MS) return;
    const last = await this.storage.get<{ at?: number }>("r2storage");
    if (last && typeof last.at === "number" && now - last.at < STORAGE_MEASURE_EVERY_MS) return;
    this.measuringStorage = true;
    try {
      const measured = await bucketBytes(bucket);
      // Written even when the measure is short (a bucket past the cap): the size is at least this.
      await this.storage.put("r2storage", { bytes: measured.bytes, at: now, truncated: measured.truncated });
      await this.addUsage({ r2Writes: measured.calls });
    } catch {
      // A bucket that cannot be listed is not measured: the guard keeps the last figure, or none.
      this.measureFailedAt = now;
    } finally {
      this.measuringStorage = false;
    }
  }

  private async addUsage(add: Partial<UsageCounts>): Promise<void> {
    const month = monthKey();
    const counts = await this.readUsage(month);
    for (const key of Object.keys(add) as Array<keyof UsageCounts>) {
      if (key === "r2StoredBytes") continue; // a measure, kept apart (see `measureStorage`)
      counts[key] = (counts[key] ?? 0) + (add[key] ?? 0);
    }
    const { r2StoredBytes: _gauge, ...record } = counts;
    await this.storage.put("usage:" + month, record);
    // The month that is over is dropped: it cannot be spent against again, and
    // keeping every month for ever would be its own small bill.
    try {
      const last = await this.storage.get<number>("usageMonth");
      if (last !== undefined && last !== new Date().getUTCMonth()) {
        // Only the previous month is known by name here; prune anything older.
        const keep = new Set([month]);
        const older = await this.storage.list<Partial<UsageCounts>>({ prefix: "usage:" });
        for (const key of older.keys()) {
          if (!keep.has(key.slice("usage:".length))) await this.storage.delete(key);
        }
      }
      await this.storage.put("usageMonth", new Date().getUTCMonth());
    } catch {}
  }

  private async persistFleetBuddies(): Promise<void> {
    try {
      await this.storage.put("fleet_buddies", Object.fromEntries(this.fleetBuddies));
    } catch {}
  }

  private async persistPaused(): Promise<void> {
    try {
      await this.storage.put("paused_fleets", [...this.pausedFleets]);
    } catch {}
  }

  private async persistFleets(): Promise<void> {
    try {
      await this.storage.put("fleets", [...this.fleets]);
    } catch {}
  }

  /**
   * Replace every value in the map that is not yet a verifier by its verifier.
   * Returns whether anything changed. Without a pepper nothing is touched: the
   * values stay as stored, unserved and unmatched, until the secret is set.
   */
  private async migrate(map: Map<string, string>, kind: TokenKind): Promise<boolean> {
    if (pepperFrom(this.env) === null) return false;
    let changed = false;
    for (const [id, value] of map) {
      if (isVerifier(value)) continue;
      map.set(id, await verifierFor(this.env, kind, value));
      changed = true;
    }
    return changed;
  }

  /**
   * A map as it may leave this object: verifiers as they are, and anything else
   * (a value still waiting for TOKEN_PEPPER) as a placeholder no token matches.
   * The id stays listed, so a registry that cannot be checked yet still reads
   * as one that has devices - never as an open gateway.
   */
  private static verifiersOnly(map: Map<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, value] of map) out[id] = isVerifier(value) ? value : UNMIGRATED;
    return out;
  }

  /** The registered devices as the admin page sees them: a fingerprint, never a token. */
  private async deviceList(): Promise<Array<{ deviceId: string; fingerprint: string; online: boolean; virtual: boolean; disabled: boolean }>> {
    const out = [];
    for (const [deviceId, stored] of this.tokens) {
      if (this.anon.has(deviceId)) continue;
      out.push({
        deviceId,
        fingerprint: isVerifier(stored) ? await fingerprint(stored) : "",
        online: this.online.has(deviceId),
        virtual: this.virtual.has(deviceId),
        disabled: this.disabled.has(deviceId),
      });
    }
    return out;
  }

  private async persistTokens(): Promise<void> {
    try {
      await this.storage.put("device_tokens", Object.fromEntries(this.tokens));
    } catch {}
  }

  private async persistDisabled(): Promise<void> {
    try {
      await this.storage.put("disabled", [...this.disabled]);
    } catch {}
  }

  /** Reset the per-month operation counters, keeping the standing byte count. */
  private rollBudgetMonth(): void {
    const key = monthKey();
    if (this.budget.month !== key) {
      this.budget = { month: key, bytes: this.budget.bytes, classA: 0, classB: 0 };
    }
  }

  private budgetStatus(): Record<string, unknown> {
    const budget = r2Budget(this.env);
    const cost = r2Cost(
      { bytes: this.budget.bytes, classA: this.budget.classA, classB: this.budget.classB },
      budget,
    );
    return {
      month: this.budget.month,
      bytes: this.budget.bytes,
      max_bytes: r2MaxBytes(budget),
      class_a_ops: this.budget.classA,
      class_b_ops: this.budget.classB,
      budget_usd: budget.budgetUsd,
      cost_usd: r2Round(cost.totalUsd),
      remaining_usd: r2Round(Math.max(0, budget.budgetUsd - cost.totalUsd)),
      breakdown: {
        storage_usd: r2Round(cost.storageUsd),
        class_a_usd: r2Round(cost.classAUsd),
        class_b_usd: r2Round(cost.classBUsd),
      },
    };
  }

  private async persistBudget(): Promise<void> {
    await this.storage.put("r2_budget", this.budget);
  }

  private async persistFileIndex(): Promise<void> {
    try {
      await this.storage.put("file_index", Object.fromEntries(this.fileIndex));
    } catch {}
  }
}
