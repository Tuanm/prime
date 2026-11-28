import { createHash, verify as cryptoVerify } from "node:crypto";
import { publicKeyFromRaw } from "../src/caller-key";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { type FleetCredentials } from "../src/fleet-transport";

/**
 * A gateway that stores bytes and never reads them.
 *
 * It behaves like the real one in the ways that matter: the head only moves
 * when the expected sequence matches, a payload can only be written by the
 * primary, and a member may only publish once it has caught up.
 */
export class FakeGateway {
  payloads = new Map<string, Buffer>();
  head: { seq: number; manifestKey: string; manifestHash: string; epoch: number } | null = null;
  members = new Map<string, { deviceId: string; role: string; pubkey?: string }>();
  applied = new Map<string, number>();
  primary = "";
  /** The most one snapshot upload may be (the gateway answers 413 above it). */
  snapshotLimit: number | undefined = undefined;
  /** Whether /role says what the limit is (the gateway now does; an earlier one did not). */
  advertiseLimit = false;
  /** How many snapshots are kept; older packs and manifests are deleted, as the real gateway does. */
  retain = Infinity;
  /** Whether the gateway has an index (an older one answers 404). */
  indexEnabled = true;
  /** What the index lists; tests may cut holes in it. */
  indexEntries: Array<{ seq: number; manifestKey: string; full: boolean; packBytes?: number; deltaBytes?: number }> = [];
  /** Who is catching up to take the free lease, and until when. */
  claim: { device: string; since: number; until: number; queue?: Array<{ device: string; at: number; by: number }> } | null = null;
  /** Publishers that predate the roster in manifests. */
  stripRoster = false;
  /** Publishers that predate the seal over the manifest. */
  unsealed = false;
  /** What /role says of the gate that keeps the head from going from a sealed snapshot to one that is not. */
  sealGate = false;
  /** Which fleet of the name this is (what /role says); undefined for a gateway that predates it. */
  incarnation: string | undefined = "incarnation-1";
  /** What every member can read, as /role says (`fleetCaps`); undefined for a gateway that predates it. */
  fleetCaps: string[] | undefined = undefined;
  /** What a member says it can do, as /keys lists it (default: what `fleetCaps` says, for every member). */
  memberCaps = new Map<string, string[]>();
  /** What /role says one piece, and a whole chunked pack, may be (a gateway that takes packs in pieces). */
  chunkLimit: number | undefined = undefined;
  chunkedLimit: number | undefined = undefined;
  /** How long a pack upload takes (ms), and how many were in flight at once at most. */
  packDelayMs = 0;
  packPostsInFlight = 0;
  maxPackPostsInFlight = 0;
  /** A refused publish deletes the change pack its manifest names (the gateway's cleanup). */
  dropChangePackOnRefusal = false;
  /** The next snapshots come from a publisher that seals but does not tag each entry (an earlier build). */
  noMacs = false;
  /** Publishers that predate the sealed metadata of a manifest. */
  stripMeta = false;
  /** Publishers that predate the key fingerprint in wrapped keys. */
  stripKeyIds = false;
  /** How many of the next /applied reports fail with a 503. */
  failApplied = 0;
  /** How many of the next reads of a manifest fail with a 503. */
  failManifestReads = 0;
  /** How many of the next asks for the member's role fail with a 503 (the answer a gateway that does not know the route gives is not one: it is a 404 with a body). */
  failRoleReads = 0;
  /** Every read of a manifest is answered with this status (for good), when set. */
  manifestStatus: number | undefined = undefined;
  /** Every ask for the role is answered with this status (for good), when set. */
  roleStatus: number | undefined = undefined;
  /** A manifest is answered with other bytes than the ones it is stored under. */
  corruptManifests = false;
  /** Like the real gateway now: a publish makes the publisher applied. */
  advanceMarksApplied = false;
  /** How many times a member asked for its place. */
  bootstraps = 0;
  /** An ask for a place is never answered (a gateway that hangs): only the caller's own time limit ends it. */
  hangBootstraps = false;
  /** What each ask for a place said. */
  bootstrapBodies: Array<Record<string, unknown>> = [];
  /** The key the gateway's object makes key-change proofs with (what /role says); undefined for a gateway that predates it. */
  keyProofKey: string | undefined = undefined;
  /** The fleet is paused: a place is answered with a 409 that says so. */
  paused = false;
  /** The newest snapshot is in pieces: a member without the capability is given no place, and told to update. */
  upgradeRequired: { need: string; hint: string } | undefined = undefined;
  /** What the gateway's clock says (its answers' Date header); undefined: no header. */
  serverDate: string | undefined = undefined;
  /** A key other than the one on the roster waits for the operator: the ask is refused, as the real object does without a proof. */
  keyChangePending = false;
  /** The signed roster the gateway serves (GET /roster); undefined: a gateway that has none (404). */
  roster: { mode: "open" | "signed"; entries: unknown[] } | undefined = undefined;
  /** Whether the gateway takes epoch keys (POST /epoch-key, and /keys lists them); an earlier one answers 404. */
  epochSupport = false;
  /** Each member's signing key (what the gateway knows of it), and the epoch key it last took. */
  spubs = new Map<string, string>();
  epochKeys = new Map<string, { n: number; pub: string; notAfter: number; sig: string }>();
  /** When each member's epoch key was taken, and how long the gateway makes the next wait (0: not at all, as the unit tests need). */
  epochKeyAt = new Map<string, number>();
  epochMinIntervalMs = 0;
  /** The next this many posts of an epoch key are taken, and their answer is lost (a timeout). */
  loseEpochAnswers = 0;
  /** The epoch keys posted, in order (the entry as sent). */
  epochPosts: unknown[][] = [];
  /** The next this many pack uploads are answered as the gateway does when a body broke off on the way (a 400), and keep nothing. */
  breakOffPacks = 0;
  /** Whether that answer carries the code the gateway gives it. */
  breakOffCode = true;
  /** What each pack upload said its hash was (`x-prime-sha256`), in order. */
  packHashHeaders: Array<string | undefined> = [];
  /** Requests of each kind, by route. */
  requests = new Map<string, number>();
  /** Pack downloads, by the pack's key. */
  packReads: string[] = [];
  /** Bytes served for pack downloads. */
  packBytesServed = 0;
  /** Behave like a gateway whose publisher predates pack sizes and the checkpoint's change pack. */
  legacyManifests = false;
  private kept: string[][] = [];

  /** The keys of members that have been removed, with the head's sequence when they were (what the fleet says). */
  left: Array<{ pubkey: string; until: number }> = [];

  /** Remove a member as the fleet does: its key is remembered with the head's sequence, and it gives up the lease. */
  remove(deviceId: string): void {
    const member = this.members.get(deviceId);
    this.members.delete(deviceId);
    if (member?.pubkey) this.left.push({ pubkey: member.pubkey, until: this.head?.seq ?? 0 });
    if (this.primary === deviceId) this.primary = "";
  }

  seed(deviceId: string, pubkey: string): void {
    this.members.set(deviceId, { deviceId, role: "member", pubkey });
    if (!this.primary) this.primary = deviceId;
  }

  async handle(creds: FleetCredentials, method: string, path: string, body?: Buffer | string, search = ""): Promise<Response> {
    const parts = path.split("/").filter(Boolean);
    const kind = parts[2];
    this.requests.set(method + " " + kind, (this.requests.get(method + " " + kind) ?? 0) + 1);
    if (kind === "head" && method === "GET") {
      if (!this.head) return new Response("{}", { status: 404 });
      return Response.json({ head: this.head });
    }
    if (kind === "index" && method === "GET") {
      if (!this.indexEnabled) return Response.json({ error: "no such fleet action" }, { status: 404 });
      const after = Number(new URLSearchParams(search).get("after") ?? 0);
      return Response.json({ entries: this.indexEntries.filter((e) => e.seq > after) });
    }
    if (kind === "bootstrap" && method === "POST") {
      this.bootstraps++;
      if (this.hangBootstraps) return new Promise<Response>(() => undefined);
      const said = (() => {
        try {
          return JSON.parse(String(body ?? "{}")) as Record<string, unknown>;
        } catch {
          return {};
        }
      })();
      this.bootstrapBodies.push(said);
      if (!this.members.has(creds.deviceId)) return Response.json({ error: "forbidden" }, { status: 403 });
      if (this.paused) return Response.json({ error: "the fleet is paused", paused: true, retryAfterMs: 60_000 }, { status: 409 });
      if (this.upgradeRequired) {
        return Response.json({ ok: true, role: "replica", reason: "upgrade-required", ...this.upgradeRequired, head: this.head ?? { seq: 0 }, epoch: 1, ttlMs: 45_000, retryAfterMs: 60_000 });
      }
      const held = this.members.get(creds.deviceId)!.pubkey;
      if (this.keyChangePending && typeof said.pubkey === "string" && said.pubkey !== held) {
        return Response.json(
          { error: "this member's key is not the one the fleet holds, and it could not show that it holds the old one: the new key waits for the operator (or the fleet's owner) to approve it", keyChange: "pending", retryAfterMs: 60_000 },
          { status: 409, headers: { "retry-after": "60" } },
        );
      }
      // Whoever holds the lease keeps it; the others are told so.
      if (this.primary && this.primary !== creds.deviceId) {
        return Response.json({ ok: true, role: "replica", reason: "lease-held", holder: this.primary, head: this.head ?? { seq: 0 } });
      }
      const current = this.head?.seq ?? 0;
      if (current > 0 && (this.applied.get(creds.deviceId) ?? 0) < current) {
        // The first to ask has a claim on catching up; the others wait, in the order they
        // asked (as the real object does). A claim lasts a minute at most, and its holder is
        // behind everyone who waits when it is over.
        const now = Date.now();
        const c = this.claim;
        const live = c !== null && c.until > now;
        const queue = (c?.queue ?? []).filter((w) => w.by > now);
        const wait = (holder: string, ms: number): Response => {
          const by = now + Math.max(1000, ms) + 15_000;
          const mine = queue.find((w) => w.device === creds.deviceId);
          if (mine) mine.by = by;
          else queue.push({ device: creds.deviceId, at: now, by });
          this.claim = { device: c?.device ?? "", since: c?.since ?? 0, until: c?.until ?? 0, queue };
          return Response.json({ ok: true, role: "replica", reason: "claimed", holder, head: this.head, retryAfterMs: Math.max(1000, ms) });
        };
        if (c && live && c.device !== creds.deviceId) return wait(c.device, c.until - now);
        if (c && live) {
          this.claim = { device: c.device, since: c.since, until: Math.min(now + 30_000, c.since + 60_000), queue };
        } else {
          const head = queue[0];
          if (head && head.device !== creds.deviceId) return wait(head.device, Math.min(30_000, head.by - now));
          this.claim = { device: creds.deviceId, since: now, until: now + 30_000, queue: queue.filter((w) => w.device !== creds.deviceId) };
        }
        return Response.json({ ok: true, role: "replica", reason: "not-caught-up", catchUpTo: current, head: this.head ?? { seq: 0 } });
      }
      this.claim = null;
      this.primary = creds.deviceId;
      return Response.json({ ok: true, role: "primary", ttlMs: 45_000, ...(current > 0 ? { catchUpTo: current } : {}) });
    }
    if (kind === "role" && method === "GET" && this.roleStatus !== undefined) return new Response("{}", { status: this.roleStatus });
    if (kind === "manifests" && method === "GET" && this.manifestStatus !== undefined) return new Response("{}", { status: this.manifestStatus });
    if (kind === "manifests" && method === "GET" && this.corruptManifests) return new Response("{\"seq\": 0, \"not\": \"the manifest\"}");
    if (kind === "role" && method === "GET" && this.failRoleReads > 0) {
      this.failRoleReads--;
      throw new TypeError("fetch failed");
    }
    if (kind === "manifests" && method === "GET" && this.failManifestReads > 0) {
      this.failManifestReads--;
      throw new TypeError("fetch failed");
    }
    if (kind === "role" && method === "GET") {
      const member = this.members.has(creds.deviceId);
      return Response.json({ member, primary: creds.deviceId === this.primary, epoch: 1, ...(member && this.incarnation !== undefined ? { incarnation: this.incarnation } : {}), ...(this.sealGate ? { sealGate: true } : {}), ...(this.advertiseLimit && this.snapshotLimit !== undefined ? { snapshotLimit: this.snapshotLimit } : {}), ...(this.fleetCaps !== undefined ? { fleetCaps: this.fleetCaps } : {}), ...(this.chunkLimit !== undefined ? { chunkLimit: this.chunkLimit } : {}), ...(this.chunkedLimit !== undefined ? { chunkedLimit: this.chunkedLimit } : {}), ...(member && this.keyProofKey ? { keyProofKey: this.keyProofKey } : {}) }, this.serverDate ? { headers: { date: this.serverDate } } : undefined);
    }
    if (kind === "roster" && method === "GET") {
      if (!this.roster) return Response.json({ error: "no such fleet action" }, { status: 404 });
      return Response.json(this.roster);
    }
    if (kind === "members" && method === "GET") {
      return Response.json({ members: [...this.members.values()], left: this.left });
    }
    if (kind === "epoch-key" && method === "POST") {
      // As the gateway checks it: the member's own signing key, a number above the one held, a form.
      if (!this.epochSupport) return Response.json({ error: "no such fleet action" }, { status: 404 });
      if (!this.members.has(creds.deviceId)) return Response.json({ error: "forbidden" }, { status: 403 });
      const said = JSON.parse(String(body ?? "{}")) as { entry?: unknown[]; sig?: string };
      const e = said.entry;
      if (!Array.isArray(e) || e.length !== 7 || e[0] !== "prime-epoch-v1" || typeof said.sig !== "string") return Response.json({ error: "form" }, { status: 400 });
      if (e[3] !== creds.deviceId) return Response.json({ error: "not your key" }, { status: 400 });
      const spub = this.spubs.get(creds.deviceId);
      if (!spub) return Response.json({ error: "no signing key" }, { status: 409 });
      let good = false;
      try {
        good = cryptoVerify(null, Buffer.from(JSON.stringify(e), "utf8"), publicKeyFromRaw(Buffer.from(spub, "base64url")), Buffer.from(said.sig, "base64url"));
      } catch {
        good = false;
      }
      if (!good) return Response.json({ error: "bad signature" }, { status: 401 });
      // The gateway's own rule (`epochKey` in api/src/fleet-do.ts): the same key again is "taken already" only with the same expiry and signature; another
      // number at or below the one held is refused with the held number; a key too soon after the last is made to wait.
      const held = this.epochKeys.get(creds.deviceId);
      if (held && held.n === e[4] && held.pub === e[5] && held.notAfter === e[6] && held.sig === said.sig) return Response.json({ ok: true, n: held.n, again: true });
      if (held && (e[4] as number) <= held.n) return Response.json({ error: "an epoch key is newer than the one the fleet holds (n " + held.n + ")", n: held.n }, { status: 409 });
      const heldAt = this.epochKeyAt.get(creds.deviceId);
      if (held && heldAt !== undefined && this.epochMinIntervalMs > 0 && Date.now() - heldAt < this.epochMinIntervalMs) {
        const wait = this.epochMinIntervalMs - (Date.now() - heldAt);
        return Response.json({ error: "an epoch key was taken a moment ago", retryAfterMs: wait }, { status: 429 });
      }
      this.epochKeyAt.set(creds.deviceId, Date.now());
      this.epochPosts.push(e);
      this.epochKeys.set(creds.deviceId, { n: e[4] as number, pub: e[5] as string, notAfter: e[6] as number, sig: said.sig });
      if (this.loseEpochAnswers > 0) {
        this.loseEpochAnswers--;
        return new Response("{}", { status: 503 });
      }
      return Response.json({ ok: true });
    }
    if (kind === "keys" && method === "GET") {
      if (creds.deviceId !== this.primary) return Response.json({ error: "not the primary" }, { status: 409 });
      return Response.json({ members: [...this.members.values()].map((m) => ({ deviceId: m.deviceId, pubkey: m.pubkey, ...(this.epochSupport && this.spubs.has(m.deviceId) ? { spub: this.spubs.get(m.deviceId) } : {}), ...(this.epochSupport && this.epochKeys.has(m.deviceId) ? { epochKey: this.epochKeys.get(m.deviceId) } : {}), applied: this.applied.get(m.deviceId) ?? 0, ...((this.memberCaps.get(m.deviceId) ?? this.fleetCaps) ? { caps: this.memberCaps.get(m.deviceId) ?? this.fleetCaps } : {}) })) });
    }
    if (kind === "applied" && method === "POST" && this.failApplied > 0) {
      this.failApplied--;
      return new Response("{}", { status: 503 });
    }
    if (kind === "applied" && method === "POST") {
      const parsed = JSON.parse(String(body ?? "{}")) as { seq: number };
      this.applied.set(creds.deviceId, Math.max(this.applied.get(creds.deviceId) ?? 0, parsed.seq ?? 0));
      return Response.json({ ok: true, applied: this.applied.get(creds.deviceId) });
    }
    if (kind === "snapshot" && method === "POST") {
      if (creds.deviceId !== this.primary) return Response.json({ error: "not the primary" }, { status: 409 });
      if (this.snapshotLimit !== undefined && (Buffer.isBuffer(body) ? body.length : String(body ?? "").length) > this.snapshotLimit) {
        return Response.json({ error: "this snapshot is bigger than the gateway takes", limit: this.snapshotLimit }, { status: 413 });
      }
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""));
      const manifestLength = bytes.readUInt32BE(0);
      const manifestBytes = bytes.subarray(4, 4 + manifestLength);
      const pack = bytes.subarray(4 + manifestLength);
      const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
      const manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
      let packKey = "fleets/x/packs/" + hash(pack);
      if (pack.length === 0) {
        // A pack that went up in pieces: the manifest names them, they must all be there, and they may add up to so much.
        const pieces = manifest.chunks as Array<{ hash: string; bytes: number }> | undefined;
        if (!Array.isArray(pieces) || pieces.length === 0) return Response.json({ error: "empty pack" }, { status: 400 });
        if (this.chunkedLimit !== undefined && pieces.reduce((n, c) => n + c.bytes, 0) > this.chunkedLimit) {
          return Response.json({ error: "this snapshot is bigger than the gateway takes in pieces", limit: this.chunkedLimit }, { status: 413 });
        }
        const gone = pieces.filter((c) => !this.payloads.has("fleets/x/packs/" + c.hash));
        if (gone.length > 0) return Response.json({ error: "a piece of the pack is not stored (or not at its size)", missing: gone.map((c) => c.hash) }, { status: 409 });
        packKey = String(manifest.packKey);
      } else {
        manifest.packKey = packKey;
        manifest.packHash = hash(pack);
      }
      // Each of these is a publisher that predates something the manifest is sealed over,
      // so what it published has no seal either.
      if (this.legacyManifests || this.stripRoster || this.unsealed) delete manifest.seal;
      // ...and none of them has the sealed metadata, which was made after all of those.
      if (this.legacyManifests || this.stripRoster || this.unsealed || this.noMacs || this.stripKeyIds || this.stripMeta) delete manifest.meta;
      // A publisher that predates the per-member tags does not put them on its entries.
      if ((this.legacyManifests || this.stripRoster || this.unsealed || this.noMacs) && Array.isArray(manifest.wrapped)) {
        for (const w of manifest.wrapped as Array<{ mac?: string }>) delete w.mac;
      }
      if (this.legacyManifests) {
        delete manifest.packBytes;
        delete manifest.delta;
      }
      // An older publisher does not say who a snapshot was sealed for.
      if (this.stripRoster) delete manifest.roster;
      // An older publisher does not say which key a snapshot was wrapped for.
      if (this.stripKeyIds && Array.isArray(manifest.wrapped)) {
        for (const w of manifest.wrapped as Array<{ keyId?: string }>) delete w.keyId;
      }
      const finalManifest = Buffer.from(JSON.stringify(manifest), "utf8");
      const manifestKey = "fleets/x/manifests/" + hash(finalManifest);
      if (pack.length > 0) this.payloads.set(packKey, pack);
      this.payloads.set(manifestKey, finalManifest);
      this.indexEntries.push({
        seq: typeof manifest.seq === "number" ? manifest.seq : 0,
        manifestKey,
        full: manifest.full === true,
        ...(typeof manifest.packBytes === "number" ? { packBytes: manifest.packBytes } : {}),
        ...(manifest.delta && typeof (manifest.delta as { bytes?: unknown }).bytes === "number" ? { deltaBytes: (manifest.delta as { bytes: number }).bytes } : {}),
      });
      while (this.indexEntries.length > this.retain) this.indexEntries.shift();
      this.kept.push([packKey, manifestKey]);
      while (this.kept.length > this.retain) for (const key of this.kept.shift()!) this.payloads.delete(key);
      const current = this.head?.seq ?? 0;
      if ((this.applied.get(creds.deviceId) ?? 0) < current) {
        // A gateway that cleans up after a refused publish takes the change pack the manifest names with it.
        const gone = (manifest.delta as { packKey?: string } | undefined)?.packKey;
        if (this.dropChangePackOnRefusal && gone) this.payloads.delete(gone);
        return Response.json({ error: "catch up first", required: current }, { status: 409 });
      }
      const seq = typeof manifest.seq === "number" ? manifest.seq : current + 1;
      this.head = { seq, manifestKey, manifestHash: hash(finalManifest), epoch: 1 };
      if (this.advanceMarksApplied) this.applied.set(creds.deviceId, seq);
      return Response.json({ ok: true, seq, manifestKey });
    }
    if ((kind === "packs" || kind === "manifests") && method === "POST") {
      if (creds.deviceId !== this.primary) return Response.json({ error: "not the primary" }, { status: 409 });
      if (kind === "packs" && this.breakOffPacks > 0) {
        this.breakOffPacks--;
        // The gateway's own sentence and code (`streamedPack` in api/src/fleets-routes.ts); a gateway from before the code says only the sentence.
        return Response.json({ error: "the body is not the pack whose hash was named, or not as long as it said: upload it again", ...(this.breakOffCode ? { code: "body-mismatch" } : {}) }, { status: 400 });
      }
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""));
      if (kind === "packs" && this.snapshotLimit !== undefined && bytes.length > this.snapshotLimit) {
        return Response.json({ error: "this change pack is bigger than the gateway takes", limit: this.snapshotLimit }, { status: 413 });
      }
      const hash = createHash("sha256").update(bytes).digest("hex");
      const key = "fleets/x/" + kind + "/" + hash;
      this.packPostsInFlight++;
      this.maxPackPostsInFlight = Math.max(this.maxPackPostsInFlight, this.packPostsInFlight);
      try {
        if (this.packDelayMs > 0) await new Promise((r) => setTimeout(r, this.packDelayMs));
      } finally {
        this.packPostsInFlight--;
      }
      this.payloads.set(key, bytes);
      return Response.json({ ok: true, key, hash, size: bytes.length });
    }
    if ((kind === "packs" || kind === "manifests") && method === "GET") {
      const id = parts[3] ?? "";
      const found = [...this.payloads.entries()].find(([k]) => k.endsWith("/" + id));
      if (!found) return Response.json({ error: "no such payload" }, { status: 404 });
      if (kind === "packs") {
        this.packReads.push(found[0]);
        this.packBytesServed += found[1].length;
      }
      return new Response(found[1]);
    }
    if (kind === "head" && parts[3] === "advance") {
      const parsed = JSON.parse(String(body ?? "{}")) as { expectedSeq: number; manifestKey: string; manifestHash: string };
      const current = this.head?.seq ?? 0;
      if (parsed.expectedSeq !== current) return Response.json({ error: "stale head" }, { status: 409 });
      if ((this.applied.get(creds.deviceId) ?? 0) < current) {
        return Response.json({ error: "catch up first", required: current }, { status: 409 });
      }
      this.head = { seq: current + 1, manifestKey: parsed.manifestKey, manifestHash: parsed.manifestHash, epoch: 1 };
      return Response.json({ ok: true, seq: this.head.seq });
    }
    return Response.json({ error: "no route" }, { status: 404 });
  }
}

export function credsFor(deviceId: string): FleetCredentials {
  return { gateway: "http://fake", deviceId, deviceToken: "token", timeoutMs: 5000 };
}

export function useFakeGateway(gateway: FakeGateway): void {
  // The real fetch, kept from the first time: a test that makes two worlds installs a second fake over the
  // first, and putting back "what was there before" would then put back the first fake for every file after.
  const g = globalThis as { __realFetch?: typeof fetch };
  g.__realFetch ??= globalThis.fetch;
  const original = g.__realFetch;
  (globalThis as { fetch: unknown }).fetch = (async (url: string, init: { method: string; headers: Record<string, string>; body?: Buffer | string; signal?: AbortSignal }) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const deviceId = init.headers["x-prime-device"] ?? "";
    if (init.method === "POST" && path.endsWith("/packs")) gateway.packHashHeaders.push(init.headers["x-prime-sha256"]);
    const answer = gateway.handle(credsFor(deviceId), init.method, path, init.body, parsed.search);
    const signal = init.signal;
    if (!signal) return answer;
    // The caller's own time limit ends the request, as it does a real one.
    return Promise.race([
      answer,
      new Promise<never>((_, reject) => {
        const abort = (): void => reject(new DOMException("The operation was aborted.", "AbortError"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  }) as unknown as typeof fetch;
  (globalThis as { __restoreFetch?: () => void }).__restoreFetch = () => {
    (globalThis as { fetch: unknown }).fetch = original;
  };
}

/** Every file under a directory, with its contents hashed. */
export function fingerprint(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      out.set(relative(dir, full), String(statSync(full).size) + ":" + readFileSync(full).toString("base64").slice(0, 64));
    }
  };
  walk(dir);
  return out;
}

export function sameTree(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

