import { createHash } from "node:crypto";
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
  /** A refused publish deletes the change pack its manifest names (the gateway's cleanup). */
  dropChangePackOnRefusal = false;
  /** The next snapshots come from a publisher that seals but does not tag each entry (an earlier build). */
  noMacs = false;
  /** Publishers that predate the key fingerprint in wrapped keys. */
  stripKeyIds = false;
  /** How many of the next /applied reports fail with a 503. */
  failApplied = 0;
  /** Like the real gateway now: a publish makes the publisher applied. */
  advanceMarksApplied = false;
  /** How many times a member asked for its place. */
  bootstraps = 0;
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
      if (!this.members.has(creds.deviceId)) return Response.json({ error: "forbidden" }, { status: 403 });
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
    if (kind === "role" && method === "GET") {
      const member = this.members.has(creds.deviceId);
      return Response.json({ member, primary: creds.deviceId === this.primary, epoch: 1, ...(member && this.incarnation !== undefined ? { incarnation: this.incarnation } : {}), ...(this.sealGate ? { sealGate: true } : {}), ...(this.advertiseLimit && this.snapshotLimit !== undefined ? { snapshotLimit: this.snapshotLimit } : {}) });
    }
    if (kind === "members" && method === "GET") {
      return Response.json({ members: [...this.members.values()], left: this.left });
    }
    if (kind === "keys" && method === "GET") {
      if (creds.deviceId !== this.primary) return Response.json({ error: "not the primary" }, { status: 409 });
      return Response.json({ members: [...this.members.values()].map((m) => ({ deviceId: m.deviceId, pubkey: m.pubkey, applied: this.applied.get(m.deviceId) ?? 0 })) });
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
      const packKey = "fleets/x/packs/" + hash(pack);
      const manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
      manifest.packKey = packKey;
      manifest.packHash = hash(pack);
      // Each of these is a publisher that predates something the manifest is sealed over,
      // so what it published has no seal either.
      if (this.legacyManifests || this.stripRoster || this.unsealed) delete manifest.seal;
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
      this.payloads.set(packKey, pack);
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
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""));
      if (kind === "packs" && this.snapshotLimit !== undefined && bytes.length > this.snapshotLimit) {
        return Response.json({ error: "this change pack is bigger than the gateway takes", limit: this.snapshotLimit }, { status: 413 });
      }
      const hash = createHash("sha256").update(bytes).digest("hex");
      const key = "fleets/x/" + kind + "/" + hash;
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
  const original = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = (async (url: string, init: { method: string; headers: Record<string, string>; body?: Buffer | string }) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const deviceId = init.headers["x-prime-device"] ?? "";
    return gateway.handle(credsFor(deviceId), init.method, path, init.body, parsed.search);
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

