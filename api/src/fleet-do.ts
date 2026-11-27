// One FleetDO per fleet id. It owns the member list and the outstanding
// invites; nothing else.
//
// Two invariants drive the shape of this file.
//
// 1. Every check-then-act runs inside blockConcurrencyWhile(). A Durable Object
//    serializes requests, but an `await` is a suspension point: two joins can
//    both read "not a member" before either writes. The lock makes the decision
//    and its effect one step.
//
// 2. Nothing inside that lock touches the network. The callback also blocks
//    every other request to this object, so a fetch in there would serialize
//    the whole fleet behind one round-trip. Storage in a SQLite-backed Durable
//    Object is local, so the lock is microseconds.

import {
  type Invite,
  type Member,
  type PendingRequest,
  cleanLabel,
  cleanPubkey,
  clampTtl,
  hashCode,
  inviteShape,
  MAX_MEMBERS,
  MAX_SNAPSHOT_BYTES,
  OWNER_SILENCE_MS,
  RECENT_SNAPSHOTS,
  MAX_PENDING,
  newInviteCode,
  validFleetId,
} from "./fleets";
import { HitMeter, sendUsage } from "./usage";
import type { Env } from "./config";


/** The name another member or waiting request already uses, if there is one. */
function findClash(
  members: Members,
  pending: Record<string, PendingRequest>,
  self: string,
  label: string | undefined,
): string | undefined {
  if (!label) return undefined;
  const want = label.toLowerCase();
  for (const m of Object.values(members)) {
    if (m.deviceId === self) continue;
    if ((m.label ?? "").toLowerCase() === want) return m.label;
  }
  for (const p of Object.values(pending)) {
    if (p.deviceId === self) continue;
    if ((p.label ?? "").toLowerCase() === want) return p.label;
  }
  return undefined;
}

/** What the operator has decided about a fleet itself. */
interface FleetMeta {
  /** A name for the operator to read; the id stays the id. */
  label?: string;
  /** A paused fleet takes no part in anything. */
  disabled?: boolean;
}

/** The routes a paused fleet refuses. */
const PAUSED_ROUTES = new Set(["/join", "/bootstrap", "/head/advance"]);
/** How long a member is told to wait before asking a paused fleet again. */
const PAUSED_RETRY_MS = 60_000;

interface Caller {
  kind: "admin" | "device";
  deviceId: string;
}

type Members = Record<string, Member>;

interface Head {
  seq: number;
  manifestKey: string;
  manifestHash: string;
  epoch: number;
}

interface Lease {
  holder: string;
  epoch: number;
  expiresAt: number;
  /** When the lease was granted (a renewal keeps it). Absent on one stored before it was recorded. */
  since?: number;
}

/** A key that has left the fleet, and the sequence the head was at when it did. */
interface LeftKey {
  pubkey: string;
  until: number;
  /** The device the key was a member's under, so a publish that was in flight when it left can raise `until`. Not served. */
  device?: string;
}
/**
 * The most keys that are kept as left. They are also dropped once the snapshots they could have made
 * are out of the retained index (`2 * RECENT_SNAPSHOTS` behind the tip), so this is only reached by a
 * fleet that has had this many members come and go within that: far more than `MAX_MEMBERS`.
 */
// A publish that has not finished storing after this long is taken to have died.
const STORING_MAX_MS = 10 * 60_000;
const LEFT_KEYS_KEPT = 256;
const EMPTY_HEAD: Head = { seq: 0, manifestKey: "", manifestHash: "", epoch: 0 };

/**
 * How long a place in a fleet lasts without being renewed.
 *
 * This has to be comfortably longer than the heartbeat of every agent that may
 * be deployed, not just the newest one: an agent renewing every fifteen seconds
 * against a fifteen-second lease loses it between two renewals, and the fleet
 * spends part of every cycle with no primary at all. The CLI now adapts its
 * heartbeat to the `ttlMs` this file returns, but an older agent still polls at
 * its own pace, so the lease is set to three of the slowest one.
 */
const LEASE_TTL_MS = 45_000;

/** How long the first replica to ask for a free lease has to catch up before another may. */
const CLAIM_MS = 30_000;

/** The most a claim lasts in all, however often its holder asks again. */
const CLAIM_MAX_MS = 60_000;

/**
 * How long past the time it was told to ask again a waiting replica keeps its place in
 * the queue. A replica that does not come back by then is taken for gone.
 */
const WAIT_GRACE_MS = 15_000;

/** A replica that asked for the free lease while another was catching up, and is waiting its turn. */
interface Waiter {
  device: string;
  /** When it first asked: the queue is in this order, and asking again does not change it. */
  at: number;
  /** It keeps its place until then; each ask moves this on. */
  by: number;
}

/** A replica that is catching up to take a free lease. */
interface Claim {
  device: string;
  /** When it was first made: a claim does not outlive this by more than CLAIM_MAX_MS. */
  since: number;
  until: number;
  /**
   * Who asked while the claim was held, in the order they first asked. When the claim
   * ends, the first of them (who still comes back) has the next one, and a holder that
   * ran its whole life is behind all of them: it cannot take the claim again while any
   * other replica is waiting, and no replica that asks again and again can take it
   * ahead of those that were told to wait.
   */
  queue?: Waiter[];
}

/** One snapshot the fleet keeps, as the index lists it. */
interface IndexEntry {
  seq: number;
  manifestKey: string;
  full: boolean;
  packBytes?: number;
  deltaBytes?: number;
  /**
   * Whether the publisher sealed the manifest (members check it). Absent on an entry written before
   * this was recorded: `advance` reads the manifest then, once, and fills it in.
   */
  sealed?: boolean;
}

/** How long a member that published without a seal after sealed snapshots is kept from the lease. */
const UNSEALED_BAR_MS = 10 * 60_000;

export class FleetDO implements DurableObject {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    // A member's agent keeps a socket open to hear about the fleet instead of asking
    // every second. It sends "ping" to know the socket is alive, and the runtime
    // answers "pong" without waking this object - so an idle fleet costs nothing.
    try {
      if (typeof WebSocketRequestResponsePair !== "undefined") {
        this.state.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair("ping", "pong"));
      }
    } catch {}
  }

  // ---- events: what the fleet tells the members that listen ----
  //
  // Sockets are hibernatable, so they survive this object being unloaded, and a
  // test double that has none sees an empty list rather than an error.

  private sockets(tag?: string): WebSocket[] {
    const s = this.state as unknown as { getWebSockets?: (tag?: string) => WebSocket[] };
    try {
      return s.getWebSockets ? s.getWebSockets(tag) : [];
    } catch {
      return [];
    }
  }

  /** Tell every listening member, except the one named. */
  private broadcast(event: Record<string, unknown>, except?: string): void {
    const text = JSON.stringify(event);
    for (const ws of this.sockets()) {
      try {
        if (except) {
          const attached = ws.deserializeAttachment?.() as { deviceId?: string } | null | undefined;
          if (attached?.deviceId === except) continue;
        }
        ws.send(text);
      } catch {}
    }
  }

  /** Hang up on a member's socket, or on all of them. */
  private hangUp(reason: string, deviceId?: string): void {
    for (const ws of this.sockets(deviceId)) {
      try {
        ws.send(JSON.stringify({ type: "bye", reason }));
        ws.close(1000, reason);
      } catch {}
    }
  }

  /**
   * Wake the listeners when the lease runs out.
   *
   * A lease that lapses is silence, and silence has no event: nobody is sending
   * anything to hear it end. So an alarm is set for the moment it would, and it
   * tells the replicas to ask for the place. It moves with every renewal, so it
   * only ever fires for a lease that really ended - and only when someone is
   * listening, because otherwise nothing needs the call.
   */
  private async scheduleLeaseAlarm(expiresAt: number): Promise<void> {
    if (this.sockets().length === 0) return;
    const s = this.state.storage as unknown as { setAlarm?: (at: number) => Promise<void> };
    try {
      await s.setAlarm?.(expiresAt + 250);
    } catch {}
  }

  async alarm(): Promise<void> {
    return this.meter.busy(() => this.onAlarm());
  }

  private async onAlarm(): Promise<void> {
    const raw = await this.state.storage.get<Lease>("lease");
    if (raw && raw.expiresAt + 250 > Date.now()) {
      await this.scheduleLeaseAlarm(raw.expiresAt);
      return;
    }
    // A paused fleet has nobody asking for the place, so nobody is told it is free.
    if (await this.paused()) return;
    this.broadcast({ type: "lease-free" });
  }

  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // Nothing is expected from a member over this socket but its ping, which the
    // runtime answers on its own.
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // 1005 and 1006 describe how a socket ended; they cannot be sent back.
    const sendable = code === 1005 || code === 1006 || code === 1015 ? 1000 : code;
    try {
      ws.close(sendable, reason);
    } catch {}
  }

  async webSocketError(_ws: WebSocket): Promise<void> {}

  /** The first thing a listener hears: how the fleet is now. */
  private async helloFrame(): Promise<Record<string, unknown>> {
    const meta = await this.meta();
    const held = await this.lease();
    return { type: "hello", paused: meta.disabled === true, leaseHolder: held ? held.holder : null, leaseMs: LEASE_TTL_MS };
  }

  /** A member opens a socket to be told what happens in the fleet. */
  private async events(caller: Caller, request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "expected a websocket upgrade" }, { status: 426 });
    }
    if (caller.kind !== "device") return this.deny();
    const members = await this.members();
    if (!members[caller.deviceId]) return this.deny();

    // One listener per member: a reconnect replaces the one that is left over.
    for (const old of this.sockets(caller.deviceId)) {
      try {
        old.send(JSON.stringify({ type: "bye", reason: "replaced" }));
        old.close(1000, "replaced");
      } catch {}
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server!, [caller.deviceId]);
    server!.serializeAttachment({ deviceId: caller.deviceId });
    server!.send(JSON.stringify(await this.helloFrame()));
    const held = await this.lease();
    if (held) await this.scheduleLeaseAlarm(held.expiresAt);
    return new Response(null, { status: 101, webSocket: client });
  }

  // The head and the epoch live in R2, not in this object's storage: losing the
  // object must not reset them, or a stale primary could replay an old head.
  private headKey(fleetId: string): string {
    return "fleets/" + fleetId + "/head";
  }

  private bucket(): R2Bucket {
    if (!this.env.BUCKET) throw new Error("FleetDO needs the BUCKET binding");
    return this.env.BUCKET;
  }

  private async readHead(fleetId: string): Promise<Head> {
    return (await this.readHeadOrNull(fleetId)) ?? { ...EMPTY_HEAD };
  }

  /**
   * The head, or null when the read failed.
   *
   * A failed read is not "no head": a fleet that has published has one, and
   * saying otherwise would let a member that is behind take the lease with the
   * state it already had - the one thing the lease exists to prevent. Callers
   * that decide whether to grant the lease use this and refuse on null;
   * callers that only read use readHead, where an empty head is a safe answer.
   */
  private async readHeadOrNull(fleetId: string): Promise<Head | null> {
    try {
      this.meter.r2("read");
      const obj = await this.bucket().get(this.headKey(fleetId));
      if (!obj) return { ...EMPTY_HEAD };
      return (await obj.json()) as Head;
    } catch {
      return null;
    }
  }

  // Delete the fleet.
  //
  // The membership, the invites and the head all go, so the name is free
  // again and nothing of the workspace is left behind.
  // Remember that this fleet was touched.
  //
  // A fleet nobody touches is not being run. That is what tells a device
  // that meets an abandoned fleet that it may clean it up.
  private async touch(): Promise<void> {
    await this.state.storage.put("lastActivity", Date.now());
  }

  // Everything this fleet put in the bucket: the head, and every snapshot's manifest and packs. The
  // snapshots the fleet still kept are not the only ones there (a publish that was refused or that died
  // leaves its objects, and an old gateway never cleaned up), so the prefix is listed rather than `recent`.
  // Best effort: a fleet that cannot be deleted from storage right now is still deleted.
  private async deleteStored(fleetId: string): Promise<void> {
    const bucket = this.bucket();
    const prefix = "fleets/" + fleetId + "/";
    try {
      let cursor: string | undefined;
      for (let page = 0; page < 200; page++) {
        const listed = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
        const keys = listed.objects.map((o) => o.key);
        if (keys.length > 0) await bucket.delete(keys);
        if (!listed.truncated) break;
        cursor = listed.cursor;
      }
    } catch {
      // Whatever is left is only storage: it is no part of a fleet that no longer exists.
    }
    try {
      await bucket.delete(this.headKey(fleetId));
    } catch {}
  }

  // Forget everything about this fleet.
  private async clear(fleetId: string): Promise<void> {
    this.hangUp("the fleet is gone");
    // A fleet that is deleted is not still paused: the name can be made again.
    await this.state.storage.delete("meta");
    await this.state.storage.delete("members");
    await this.state.storage.delete("created");
    await this.state.storage.delete("incarnation");
    await this.state.storage.delete("left");
    await this.state.storage.delete("unsealedBar");
    await this.state.storage.delete("invites");
    await this.state.storage.delete("pending");
    await this.state.storage.delete("storing");
    await this.state.storage.delete("lease");
    await this.state.storage.delete("epoch");
    await this.state.storage.delete("applied");
    await this.state.storage.delete("claim");
    await this.state.storage.delete("fetched");
    await this.state.storage.delete("index");
    await this.state.storage.delete("recent");
    await this.state.storage.delete("ownerSeenAt");
    await this.deleteStored(fleetId);
    // The fleet is gone, so the registry should stop listing it.
    await this.registerWithRegistry(fleetId, false);
  }


  /**
   * Tell the registry whether this fleet exists.
   *
   * The list of fleets lives in the registry object, because the fleet
   * objects cannot be enumerated.
   */
  private async registerWithRegistry(fleetId: string, exists: boolean): Promise<void> {
    try {
      const reg = this.env.REGISTRY.get(this.env.REGISTRY.idFromName("global"));
      await reg.fetch("https://registry/" + (exists ? "fleet-add" : "fleet-remove") + "?id=" + encodeURIComponent(fleetId), {
        method: "POST",
      });
    } catch {}
  }

  private async delete(caller: Caller, request: Request): Promise<Response> {
    const denied = await this.requireOperatorOrOwner(caller);
    if (denied) {
      // A fleet that has not been touched for a day is not being run by
      // anybody, and a fleet whose members are all gone cannot be run at
      // all. A proven device may clean such a fleet up, otherwise it sits
      // there for ever with nobody able to touch it.
      if (caller.kind !== "device") return denied;
      const last = (await this.state.storage.get<number>("lastActivity")) ?? 0;
      if (last === 0 || Date.now() - last < OWNER_SILENCE_MS) return denied;
    }
    const fleetId = request.headers.get("x-prime-fleet") ?? "";
    await this.clear(fleetId);
    return Response.json({ ok: true, deleted: fleetId });
  }

  //
  // The members' identities, for the gateway to check whether any of them
  // still exist.
  //
  // Only the gateway asks: a member does not get to see the whole roster
  // through this.
  private async reap(caller: Caller): Promise<Response> {
    if (caller.kind !== "admin") return this.deny();
    const members = await this.members();
    const lastActivity = (await this.state.storage.get<number>("lastActivity")) ?? 0;
    const meta = await this.meta();
    return Response.json({ members: Object.keys(members), lastActivity, meta });
  }

  //
  // Who holds the lease, for a client that wants to talk to the fleet.
  //
  // A client that is not a member learns nothing: it is told that there is
  // no primary, not who it is.
  private async primary(caller: Caller): Promise<Response> {
    const held = await this.lease();
    // The operator may ask: the admin interface shows who holds the lease.
    if (caller.kind === "admin") {
      return Response.json({
        member: true,
        primary: held ? held.holder : null,
        epoch: held ? held.epoch : 0,
        ...(held?.since !== undefined ? { since: held.since } : {}),
      });
    }
    if (caller.kind !== "device") return this.deny();
    const members = await this.members();
    if (!members[caller.deviceId]) return Response.json({ member: false, primary: null });
    return Response.json({
      member: true,
      primary: held ? held.holder : null,
      epoch: held ? held.epoch : 0,
      ...(held?.since !== undefined ? { since: held.since } : {}),
    });
  }

  // The head, for a member that wants to know what state the fleet is at.
  private async head(caller: Caller, request: Request): Promise<Response> {
    if (caller.kind !== "device") return this.deny();
    const fleetId = request.headers.get("x-prime-fleet") ?? "";
    const members = await this.members();
    if (!members[caller.deviceId]) return this.deny();
    const head = await this.readHead(fleetId);
    return Response.json({ head });
  }

  // The snapshots the fleet keeps, newest last, from a sequence on: what a member
  // needs to work out the cheapest way to catch up (which of them are whole trees,
  // and how big the packs are) in one request instead of one per manifest. Only
  // what was published since the object began to record it is listed; a member
  // that finds a gap walks the manifests instead.
  private async index(caller: Caller, request: Request): Promise<Response> {
    if (caller.kind !== "device") return this.deny();
    const members = await this.members();
    if (!members[caller.deviceId]) return this.deny();
    const after = Math.max(0, Math.floor(Number(new URL(request.url).searchParams.get("after") ?? 0)) || 0);
    // `sealed: false` is this object's own note (that the manifest was looked at); a member is told of a seal, not of its absence.
    const entries = ((await this.state.storage.get<IndexEntry[]>("index")) ?? [])
      .filter((e) => e.seq > after)
      .map(({ sealed, ...rest }) => (sealed === true ? { ...rest, sealed: true as const } : rest));
    return Response.json({ entries });
  }

  // The members' public keys, for the member that publishes snapshots.
  //
  // Only the primary sees this in full. The roster itself keeps the device
  // ids truncated for ordinary members; a public key is useless without the
  // private half, but a full roster is information a member has no need for.
  private async keys(caller: Caller): Promise<Response> {
    if (caller.kind !== "device") return this.deny();
    const members = await this.members();
    if (!members[caller.deviceId]) return this.deny();
    const held = await this.lease();
    if (!held || held.holder !== caller.deviceId) {
      return Response.json({ error: "only the primary may read the members' keys" }, { status: 409 });
    }
    const applied = (await this.state.storage.get<Record<string, number>>("applied")) ?? {};
    const fetched = (await this.state.storage.get<Record<string, number>>("fetched")) ?? {};
    return Response.json({
      members: Object.values(members).map((m) => ({
        deviceId: m.deviceId,
        ...(m.pubkey ? { pubkey: m.pubkey } : {}),
        // How far this member has got. The admin page shows it; the publisher
        // does not decide anything from it (a member that fell behind catches
        // up from the newest checkpoint).
        applied: applied[m.deviceId] ?? 0,
        // How far it has fetched, for a replica that fetches ahead of applying.
        ...(fetched[m.deviceId] !== undefined ? { fetched: fetched[m.deviceId] } : {}),
      })),
    });
  }

  // How far this member has got. The Durable Object uses it to fence a
  // member that took over: it may not publish until it has applied the state
  // it is about to replace.
  private async applied(caller: Caller, body: Record<string, unknown>): Promise<Response> {
    if (caller.kind !== "device") return this.deny();
    const members = await this.members();
    if (!members[caller.deviceId]) return this.deny();
    const seq = typeof body.seq === "number" && body.seq >= 0 ? Math.floor(body.seq) : 0;
    const applied = (await this.state.storage.get<Record<string, number>>("applied")) ?? {};
    if (seq > (applied[caller.deviceId] ?? 0)) applied[caller.deviceId] = seq;
    await this.state.storage.put("applied", applied);
    // A replica that fetches ahead says how far it has fetched, which is not
    // how far it has applied: only `applied` gates the lease. Members that do
    // not say have nothing recorded.
    let fetchedSeq: number | undefined;
    if (typeof body.fetched === "number" && body.fetched >= 0) {
      const fetched = (await this.state.storage.get<Record<string, number>>("fetched")) ?? {};
      fetchedSeq = Math.max(fetched[caller.deviceId] ?? 0, Math.floor(body.fetched));
      fetched[caller.deviceId] = fetchedSeq;
      await this.state.storage.put("fetched", fetched);
    }
    return Response.json({ ok: true, applied: applied[caller.deviceId] ?? 0, ...(fetchedSeq !== undefined ? { fetched: fetchedSeq } : {}) });
  }

  /** Whether this object has told the registry it exists. */
  private announced = false;

  private async members(): Promise<Members> {
    return (await this.state.storage.get<Members>("members")) ?? {};
  }

  /** What the operator has set about the fleet itself. */
  private async meta(): Promise<FleetMeta> {
    return (await this.state.storage.get<FleetMeta>("meta")) ?? {};
  }

  /** A fleet the operator has paused takes no part in anything. */
  private async paused(): Promise<boolean> {
    return (await this.meta()).disabled === true;
  }

  /** Set what the operator has decided about the fleet. */
  private async setMeta(caller: Caller, body: Record<string, unknown>): Promise<Response> {
    if (caller.kind !== "admin") return this.deny();
    if (!(await this.exists())) return Response.json({ error: "no such fleet" }, { status: 404 });
    const meta = await this.meta();
    if (typeof body.label === "string") {
      const label = cleanLabel(body.label);
      if (label === undefined) delete meta.label;
      else meta.label = label;
    }
    const wasPaused = meta.disabled === true;
    if (typeof body.disabled === "boolean") meta.disabled = body.disabled;
    await this.state.storage.put("meta", meta);
    if ((meta.disabled === true) !== wasPaused) this.broadcast({ type: meta.disabled === true ? "paused" : "resumed" });
    return Response.json({ ok: true, meta });
  }

  /** What this fleet served this month, sent on in batches. */
  private readonly meter = new HitMeter((add) => {
    sendUsage(this.env.REGISTRY.get(this.env.REGISTRY.idFromName("global")), add);
  });

  async fetch(request: Request): Promise<Response> {
    this.meter.hit();
    return this.meter.busy(() => this.serve(request));
  }

  private async serve(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};

    // The Worker has already proved the caller; these headers are internal.
    const kind = request.headers.get("x-prime-caller") === "admin" ? "admin" : "device";
    const deviceId = request.headers.get("x-prime-device") ?? "";
    const caller: Caller = { kind, deviceId };

    // The operator lists the fleets from the registry, because the objects
    // cannot be enumerated. A fleet made before the registry existed, or one
    // whose registration was lost, would be invisible to the operator for
    // ever; it puts itself back on the first request the object sees.
    if (!this.announced) {
      this.announced = true;
      const name = request.headers.get("x-prime-fleet") ?? "";
      if (validFleetId(name)) {
        void this.exists().then((there) => (there ? this.registerWithRegistry(name, true) : undefined)).catch(() => {});
      }
    }

    // A paused fleet takes no part in the work: nothing joins it, nobody
    // takes a place in it, and nothing is published to it. The operator
    // still runs it, so the routes that manage it are left alone.
    //
    // The events socket is the one thing a paused fleet still offers: it is how the
    // members hear that the pause is over, instead of asking.
    if (path === "/events" && request.method === "GET") return this.events(caller, request);
    if (PAUSED_ROUTES.has(path) && (await this.paused())) {
      return Response.json(
        { error: "the fleet is paused", paused: true, retryAfterMs: PAUSED_RETRY_MS },
        { status: 409, headers: { "retry-after": String(Math.ceil(PAUSED_RETRY_MS / 1000)) } },
      );
    }

    if (path === "/create" && request.method === "POST") return this.create(caller, body, request);
    if (path === "/invite" && request.method === "POST") return this.invite(caller, body);
    if (path === "/invite-check" && request.method === "POST") return this.inviteCheck(body);
    if (path === "/join" && request.method === "POST") {
      await this.touch();
      return this.join(caller, body, request);
    }
    if (path === "/approve" && request.method === "POST") return this.approve(caller, body);
    if (path === "/remove" && request.method === "POST") return this.remove(caller, body, request);
    if (path === "/revoke" && request.method === "POST") return this.revoke(caller, body);
    if (path === "/members" && request.method === "GET") return this.listMembers(caller);
    if (path === "/pending" && request.method === "GET") return this.listPending(caller);
    if (path === "/me" && request.method === "GET") return this.me(caller);
    if (path === "/role") return this.role(caller);
    if (path === "/primary" && request.method === "GET") return this.primary(caller);
    if (path === "/reap" && request.method === "POST") return this.reap(caller);
    if (path === "/meta" && request.method === "POST") return this.setMeta(caller, body);
    if (path === "/bootstrap" && request.method === "POST") {
      await this.touch();
      return this.bootstrap(caller, request, body);
    }
    if (path === "/lease/renew" && request.method === "POST") return this.renew(caller, body);
    if (path === "/lease/release" && request.method === "POST") return this.release(caller);
    if (path === "/head/advance" && request.method === "POST") {
      await this.touch();
      return this.advance(caller, body, request);
    }
    if (path === "/head" && request.method === "GET") return this.head(caller, request);
    if (path === "/index" && request.method === "GET") return this.index(caller, request);
    if (path === "/applied" && request.method === "POST") {
      await this.touch();
      return this.applied(caller, body);
    }
    if (path === "/unreferenced" && request.method === "POST") return this.unreferenced(caller, body, request);
    if (path === "/delete" && request.method === "POST") return this.delete(caller, request);
    if (path === "/keys" && request.method === "GET") return this.keys(caller);
    if (path === "/vacate" && request.method === "POST") return this.vacate(caller, body);

    return Response.json({ error: "not found" }, { status: 404 });
  }

  private deny(): Response {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  private async requireAdmin(caller: Caller): Promise<Response | null> {
    if (caller.kind !== "admin") return this.deny();
    return null;
  }

  // The operator, or the owner of this fleet.
  //
  // The operator holds the gateway token, which is the authority of the whole
  // deployment. The owner is the device that created the fleet, and it runs
  // its own fleet: a member it invited would have no way to admit anyone if
  // only the operator could.
  private async requireOperatorOrOwner(caller: Caller): Promise<Response | null> {
    if (caller.kind === "admin") return null;
    if (caller.kind !== "device") return this.deny();
    const members = await this.members();
    const member = members[caller.deviceId];
    if (!member || member.role !== "owner") return this.deny();
    // The owner speaks for its fleet by acting on it.
    await this.touch();
    return null;
  }

  private async create(caller: Caller, body: Record<string, unknown>, request: Request): Promise<Response> {
    // Only the operator may create a fleet. A fleet is a thing an operator
    // sets up: the spaces join it afterwards, and the operator admits them.
    if (caller.kind !== "admin") {
      return Response.json(
        { error: "only the operator may create a fleet" },
        { status: 403 },
      );
    }
    const fleetId = request.headers.get("x-prime-fleet") ?? "";

    let out: Response = Response.json({ error: "unreachable" }, { status: 500 });
    await this.state.blockConcurrencyWhile(async () => {
      if (await this.exists()) {
        out = Response.json({ error: "fleet already exists" }, { status: 409 });
        return;
      }
      // The fleet is reached as a device under its own name, so a name a
      // device already has belongs to that device.
      if (await this.nameTaken(fleetId)) {
        out = Response.json(
          { error: "a device already has that id", hint: "give the fleet another name" },
          { status: 409 },
        );
        return;
      }
      // The fleet starts empty. The first member the operator admits owns
      // it: a fleet with nobody in it cannot be run by anybody, so the
      // first one in takes it.
      await this.state.storage.put("created", Date.now());
      out = Response.json({ ok: true, fleet: fleetId });
      // The registry keeps the list of fleets, so the operator can see them.
      await this.registerWithRegistry(fleetId, true);
    });
    return out;
  }

  /** Whether a device on this gateway already answers to the name. */
  private async nameTaken(fleetId: string): Promise<boolean> {
    try {
      const reg = this.env.REGISTRY.get(this.env.REGISTRY.idFromName("global"));
      const res = await reg.fetch("https://registry/name-taken?kind=fleet&id=" + encodeURIComponent(fleetId));
      if (!res.ok) return false;
      return ((await res.json()) as { taken?: boolean }).taken === true;
    } catch {
      return false;
    }
  }

  /** Whether this fleet has been created, whether anybody is in it yet or not. */
  private async exists(): Promise<boolean> {
    if ((await this.state.storage.get<number>("created")) !== undefined) return true;
    const members = await this.members();
    return Object.keys(members).length > 0;
  }

  private async invite(caller: Caller, body: Record<string, unknown>): Promise<Response> {
    const denied = await this.requireOperatorOrOwner(caller);
    if (denied) return denied;

    const ttlMs = clampTtl(typeof body.ttlMs === "number" ? body.ttlMs : undefined);

    const code = newInviteCode();
    const codeHash = await hashCode(code);

    let out: Response = Response.json({ error: "unreachable" }, { status: 500 });
    await this.state.blockConcurrencyWhile(async () => {
      if (!(await this.exists())) {
        out = Response.json({ error: "fleet does not exist" }, { status: 404 });
        return;
      }
      const now = Date.now();
      const invites = (await this.state.storage.get<Record<string, Invite>>("invites")) ?? {};
      // Drop expired invites while we are here, so storage does not accumulate.
      for (const [hash, inv] of Object.entries(invites)) if (inv.expiresAt <= now) delete invites[hash];
      const invite: Invite = { codeHash, expiresAt: now + ttlMs, createdBy: caller.deviceId, createdAt: now };
      invites[codeHash] = invite;
      await this.state.storage.put("invites", invites);
      out = Response.json({ ok: true, code, expiresAt: invite.expiresAt });
    });
    return out;
  }

  //
  // Whether an invite is worth having, without using it.
  //
  // The code is the proof, so this needs no credential of its own: a caller
  // that holds a valid code learns the same thing by joining.
  private async inviteCheck(body: Record<string, unknown>): Promise<Response> {
    const code = typeof body.code === "string" ? body.code : "";
    if (!inviteShape(code)) return Response.json({ ok: false, error: "invalid invite code" }, { status: 400 });
    const codeHash = await hashCode(code);
    const invites = (await this.state.storage.get<Record<string, Invite>>("invites")) ?? {};
    const invite = invites[codeHash];
    if (!invite) return Response.json({ ok: false, error: "unknown or already-used invite" }, { status: 403 });
    if (invite.expiresAt <= Date.now()) return Response.json({ ok: false, error: "invite expired" }, { status: 403 });
    return Response.json({ ok: true, expiresAt: invite.expiresAt });
  }

  private async join(caller: Caller, body: Record<string, unknown>, request: Request): Promise<Response> {
    if (caller.kind !== "device") return this.deny();
    const code = typeof body.code === "string" ? body.code : "";
    if (!inviteShape(code)) return Response.json({ error: "invalid invite code" }, { status: 400 });
    const label = cleanLabel(body.label);
    const pubkey = cleanPubkey(body.pubkey);
    const codeHash = await hashCode(code);

    let out: Response = Response.json({ error: "unreachable" }, { status: 500 });
    await this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const members = await this.members();
      const invites = (await this.state.storage.get<Record<string, Invite>>("invites")) ?? {};

      const existing = members[caller.deviceId];
      if (existing) {
        // Idempotent re-join: already a member is not an error.
        // A member that comes back with a new key takes the new key: it is
        // proving itself, and the snapshots it cannot open are its own.
        if (pubkey && existing.pubkey !== pubkey) {
          // The old key made snapshots a replica may not have taken in yet: it is a member's key up to there.
          if (existing.pubkey) await this.recordLeft(existing.pubkey, request.headers.get("x-prime-fleet") ?? "", caller.deviceId);
          existing.pubkey = pubkey;
          members[caller.deviceId] = existing;
          await this.state.storage.put("members", members);
        }
        out = Response.json({ ok: true, status: "member", member: existing });
        return;
      }

      const invite = invites[codeHash];
      if (!invite) {
        out = Response.json({ error: "unknown or already-used invite" }, { status: 403 });
        return;
      }
      if (invite.expiresAt <= now) {
        delete invites[codeHash];
        await this.state.storage.put("invites", invites);
        out = Response.json({ error: "invite expired" }, { status: 403 });
        return;
      }

      // The invite is consumed by the first device that presents it, whether or
      // not approval follows. One code, one admission attempt.
      delete invites[codeHash];
      await this.state.storage.put("invites", invites);

      if (Object.keys(members).length >= MAX_MEMBERS) {
        out = Response.json({ error: "fleet is full" }, { status: 409 });
        return;
      }

      // Two spaces with the same name cannot be told apart in the operator's
      // list, and the name is all the list shows. A space on another machine
      // is the only way to meet one: this machine's spaces are its own keys.
      const clashes = findClash(members, {}, caller.deviceId, label);
      if (clashes) {
        out = Response.json(
          {
            error: "a space called \"" + clashes + "\" is already in this fleet",
            hint: "give this space another name with --name, so the fleet can tell the two apart",
          },
          { status: 409 },
        );
        return;
      }

      const pending = await this.joinRequests();
      const waiting = findClash(members, pending, caller.deviceId, label);
      if (waiting) {
        out = Response.json(
          {
            error: "a space called \"" + waiting + "\" is already waiting to join this fleet",
            hint: "give this space another name with --name, so the fleet can tell the two apart",
          },
          { status: 409 },
        );
        return;
      }
      if (!pending[caller.deviceId] && Object.keys(pending).length >= MAX_PENDING) {
        out = Response.json({ error: "too many pending requests" }, { status: 429 });
        return;
      }
      pending[caller.deviceId] = {
        deviceId: caller.deviceId,
        ...(label ? { label } : {}),
        ...(pubkey ? { pubkey } : {}),
        requestedAt: now,
      };
      await this.state.storage.put("pending", pending);
      out = Response.json({ ok: true, status: "pending", requestedAt: now });
    });
    return out;
  }

  private async approve(caller: Caller, body: Record<string, unknown>): Promise<Response> {
    const denied = await this.requireOperatorOrOwner(caller);
    if (denied) return denied;
    const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";

    let out: Response = Response.json({ error: "unreachable" }, { status: 500 });
    await this.state.blockConcurrencyWhile(async () => {
      const pending = await this.joinRequests();
      const request = pending[deviceId];
      if (!request) {
        out = Response.json({ error: "no such request" }, { status: 404 });
        return;
      }
      const members = await this.members();
      if (Object.keys(members).length >= MAX_MEMBERS) {
        out = Response.json({ error: "fleet is full" }, { status: 409 });
        return;
      }
      delete pending[deviceId];
      // The first member the operator admits owns the fleet: a fleet with
      // nobody in it cannot be run by anybody.
      const first = Object.keys(members).length === 0;
      const member: Member = {
        deviceId,
        role: first ? "owner" : "member",
        addedAt: Date.now(),
        addedBy: caller.deviceId,
        ...(request.pubkey ? { pubkey: request.pubkey } : {}),
        ...(request.label ? { label: request.label } : {}),
      };
      members[deviceId] = member;
      await this.state.storage.put("members", members);
      await this.state.storage.put("pending", pending);
      out = Response.json({ ok: true, member });
    });
    return out;
  }

  private async remove(caller: Caller, body: Record<string, unknown>, request: Request): Promise<Response> {
    const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
    // A member may leave of its own accord. Only the owner may remove
    // somebody else.
    if (!(caller.kind === "device" && caller.deviceId === deviceId)) {
      const denied = await this.requireOperatorOrOwner(caller);
      if (denied) return denied;
    }

    let out: Response = Response.json({ error: "unreachable" }, { status: 500 });
    let wasMember = false;
    let freedLease = false;
    await this.state.blockConcurrencyWhile(async () => {
      const members = await this.members();
      const pending = await this.joinRequests();
      if (pending[deviceId]) {
        delete pending[deviceId];
        await this.state.storage.put("pending", pending);
        out = Response.json({ ok: true, removed: "pending" });
        return;
      }
      const member = members[deviceId];
      if (!member) {
        out = Response.json({ error: "no such member" }, { status: 404 });
        return;
      }
      delete members[deviceId];
      wasMember = true;
      // What the fleet's snapshots were when this member's key stopped being a member's: it made the
      // ones up to there, and a member that was away has still to take them in.
      if (member.pubkey) await this.recordLeft(member.pubkey, request.headers.get("x-prime-fleet") ?? "", deviceId);
      // A member that leaves gives up the lease, so the fleet is not held by
      // somebody who is no longer there.
      const held = await this.lease();
      if (held && held.holder === deviceId) {
        await this.state.storage.delete("lease");
        freedLease = true;
      }
      // Removing the owner hands the fleet to the member that has been in it
      // the longest. A fleet whose owner is gone and that nobody can take
      // over is a fleet nobody can run.
      if (member.role === "owner") {
        const rest = Object.values(members).sort((a, b) => a.addedAt - b.addedAt);
        if (rest.length > 0) {
          const next = rest[0]!;
          members[next.deviceId] = { ...next, role: "owner" };
        }
      }
      // A fleet with no members is not a fleet: it goes away with the last
      // one, rather than sitting there with nobody able to run it.
      if (Object.keys(members).length === 0) {
        await this.clear(request.headers.get("x-prime-fleet") ?? "");
        out = Response.json({ ok: true, removed: "member", fleet: "gone" });
        return;
      }
      await this.state.storage.put("members", members);
      out = Response.json({ ok: true, removed: "member" });
    });
    // Told after the decision is made and stored, outside the block that made it:
    // a socket closed while the object is held shut is not let go of cleanly.
    if (freedLease) this.broadcast({ type: "lease-free" }, deviceId);
    // It is not a member any more, so it has nothing to listen for.
    if (wasMember) this.hangUp("removed", deviceId);
    return out;
  }

  private async revoke(caller: Caller, body: Record<string, unknown>): Promise<Response> {
    // Invalidate every outstanding invite.
    const denied = await this.requireOperatorOrOwner(caller);
    if (denied) return denied;
    const before = Object.keys((await this.state.storage.get<Record<string, Invite>>("invites")) ?? {}).length;
    await this.state.storage.put("invites", {});
    return Response.json({ ok: true, revoked: before });
  }

  private async listMembers(caller: Caller): Promise<Response> {
    const members = await this.members();
    if (caller.kind === "admin") {
      // The operator also sees how far each member says it has got (informational: only `applied` gates the lease).
      const applied = (await this.state.storage.get<Record<string, number>>("applied")) ?? {};
      const fetched = (await this.state.storage.get<Record<string, number>>("fetched")) ?? {};
      const shown = Object.values(members).map((m) => ({
        ...m,
        applied: applied[m.deviceId] ?? 0,
        ...(fetched[m.deviceId] !== undefined ? { fetched: fetched[m.deviceId] } : {}),
      }));
      return Response.json({ ok: true, members: shown, left: await this.leftKeys() });
    }
    // The owner runs the fleet: it admits and removes members, so it needs
    // their ids in full. Any other member sees the other ids cut short:
    // knowing a member's full id is not something a member needs, and the
    // primary gets the keys it needs from the dedicated route instead.
    if (caller.kind === "device" && members[caller.deviceId]) {
      const self = members[caller.deviceId]!;
      if (self.role === "owner") return Response.json({ ok: true, members: Object.values(members), left: await this.leftKeys() });
      const redacted = Object.values(members).map((m) =>
        m.deviceId === self.deviceId ? m : { ...m, deviceId: m.deviceId.slice(0, 8) + "…" },
      );
      return Response.json({ ok: true, members: redacted, left: await this.leftKeys() });
    }
    // A device may see the roster only if it is in it.
    if (!members[caller.deviceId]) return this.deny();

    const redacted = Object.values(members).map((m) => ({
      deviceId: m.deviceId === caller.deviceId ? m.deviceId : m.deviceId.slice(0, 6) + "\u2026",
      role: m.role,
      addedAt: m.addedAt,
    }));
    return Response.json({ ok: true, members: redacted, left: await this.leftKeys() });
  }

  private async listPending(caller: Caller): Promise<Response> {
    const denied = await this.requireOperatorOrOwner(caller);
    if (denied) return denied;
    const pending = await this.joinRequests();
    return Response.json({ ok: true, pending: Object.values(pending) });
  }

  private async lease(): Promise<Lease | null> {
    const lease = await this.state.storage.get<Lease>("lease");
    if (!lease) return null;
    return lease.expiresAt > Date.now() ? lease : null;
  }

  // One atomic decision, so two spaces created at the same moment cannot both
  // conclude that they are the first. Only storage reads inside the lock.
  private async bootstrap(caller: Caller, request: Request, body: Record<string, unknown>): Promise<Response> {
    if (caller.kind !== "device") return this.deny();
    const fleetId = request.headers.get("x-prime-fleet") ?? "";
    // The lease is the failover clock: when a primary dies, the fleet is stuck
    // until it runs out. It must also be long enough that the agent's own
    // heartbeat fits inside it several times over, or a live primary loses the
    // lease between two renewals and the fleet flaps with no primary at all -
    // which is exactly what happened when the agents renewed every fifteen
    // seconds against a fifteen-second lease.
    const ttlMs = LEASE_TTL_MS;
    // The head decides whether this member is caught up, and the lease must not
    // be granted on a guess: a failed read refuses the bootstrap instead of
    // pretending the fleet has published nothing.
    const head = await this.readHeadOrNull(fleetId);
    if (head === null) {
      return Response.json({ error: "the fleet's head could not be read" }, { status: 503 });
    }
    const members = await this.members();
    if (!members[caller.deviceId]) return this.deny();

    // A member that comes back with a new key takes the new key: it is
    // proving itself, and the snapshots sealed for the old key are of no use
    // to it.
    const pubkey = cleanPubkey(body.pubkey);
    const label = cleanLabel(body.label);
    // A space that is renamed, or an identity that was taken over by another
    // space, says what it is called now. The name is only for the operator to
    // read, but it is read on every round of the agent, so a stale one is
    // corrected the next time the space takes its place.
    let membersChanged = false;
    if (pubkey && members[caller.deviceId]!.pubkey !== pubkey) {
      if (members[caller.deviceId]!.pubkey) await this.recordLeft(members[caller.deviceId]!.pubkey!, fleetId, caller.deviceId);
      members[caller.deviceId]!.pubkey = pubkey;
      membersChanged = true;
    }
    if (label !== undefined && members[caller.deviceId]!.label !== label) {
      // A name another member already uses is not taken on: the list would
      // then show two spaces that cannot be told apart.
      if (!findClash(members, {}, caller.deviceId, label)) {
        members[caller.deviceId]!.label = label;
        membersChanged = true;
      }
    }
    if (membersChanged) await this.state.storage.put("members", members);

    let out: Response = Response.json({ error: "unreachable" }, { status: 500 });
    await this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const held = await this.lease();

      if (held && held.holder !== caller.deviceId) {
        out = Response.json({
          ok: true,
          role: "replica",
          reason: "lease-held",
          holder: held.holder,
          ...(held.since !== undefined ? { holderSince: held.since } : {}),
          head,
          epoch: head.epoch,
        });
        return;
      }
      // A member that published without a seal on a fleet whose snapshots are sealed is not given the
      // lease back for a while: an upgraded member has it (see `advance`). It carries on as a replica.
      const bar = (await this.state.storage.get<Record<string, number>>("unsealedBar")) ?? {};
      // A build that says it seals has been upgraded since: the bar was for the build that refused.
      if (body.seals === true && bar[caller.deviceId] !== undefined) {
        delete bar[caller.deviceId];
        await this.state.storage.put("unsealedBar", bar);
      }
      if ((bar[caller.deviceId] ?? 0) > now) {
        out = Response.json({
          ok: true,
          role: "replica",
          reason: "upgrade-required",
          holder: held?.holder ?? null,
          head,
          epoch: head.epoch,
          error: "this fleet's snapshots are sealed: upgrade prime on this member",
        });
        return;
      }
      // A member without a public key can never open a snapshot, so it can
      // never catch up. It may not hold the lease: it would publish on top
      // of state it cannot read.
      const member = members[caller.deviceId]!;
      if (!member.pubkey) {
        out = Response.json({ error: "this member has no key for content encryption" }, { status: 409 });
        return;
      }
      // A member that has not applied the head cannot hold the lease: it
      // would block the member that can publish, and it could not publish
      // itself. It catches up first, and takes the lease on a later round.
      const applied = (await this.state.storage.get<Record<string, number>>("applied")) ?? {};
      if (head.seq > 0 && (applied[caller.deviceId] ?? 0) < head.seq) {
        // Every replica that is behind is told the same while the lease is free,
        // and each would write its whole work tree to catch up. The first to ask
        // is given a short claim on doing so (renewed whenever it asks again):
        // the others are told to wait and ask later. The lease itself is decided
        // as ever - by who has applied the head when it asks - so a claim that
        // lapses (its holder died half way) costs the others its length at most.
        const claim = await this.state.storage.get<Claim>("claim");
        const live = claim !== undefined && claim.until > now && members[claim.device] !== undefined;
        const wait = (holder: string, ms: number): Response =>
          Response.json({ ok: true, role: "replica", reason: "claimed", holder, head, epoch: head.epoch, retryAfterMs: Math.max(1000, ms) });
        // Those waiting, in the order they asked, minus the ones that stopped coming back.
        const queue = (claim?.queue ?? []).filter((w) => w.by > now && members[w.device] !== undefined);
        // Put the caller in the queue (or keep its place) and tell it to ask again in `ms`.
        const queued = async (holder: string, ms: number): Promise<Response> => {
          const by = now + Math.max(1000, ms) + WAIT_GRACE_MS;
          const mine = queue.find((w) => w.device === caller.deviceId);
          if (!mine || mine.by !== by) {
            if (mine) mine.by = by;
            else queue.push({ device: caller.deviceId, at: now, by });
            await this.state.storage.put("claim", {
              device: claim?.device ?? "",
              since: claim?.since ?? 0,
              until: claim?.until ?? 0,
              queue,
            } satisfies Claim);
          }
          return wait(holder, ms);
        };
        if (claim && live && claim.device !== caller.deviceId) {
          out = await queued(claim.device, claim.until - now);
          return;
        }
        if (claim && live) {
          // The holder asks again. A claim is renewed while it is working, but not for
          // ever: a member that is alive and cannot catch up (nothing sealed for it, a
          // work tree it cannot write) asks again and again, and would keep the others
          // waiting as long as it lives. The renewal never goes past the total life;
          // when that is over the claim lapses, and the holder - behind everyone that
          // is waiting - does not get the next one while there is somebody who is.
          const since = Number.isFinite(claim.since) ? claim.since : claim.until - CLAIM_MS;
          await this.state.storage.put("claim", {
            device: claim.device,
            since,
            until: Math.min(now + CLAIM_MS, since + CLAIM_MAX_MS),
            queue,
          } satisfies Claim);
        } else {
          // Nobody holds the claim. It goes to the replica that has waited longest,
          // and to anyone if nobody has been waiting.
          const first = queue[0];
          if (first && first.device !== caller.deviceId) {
            out = await queued(first.device, Math.min(CLAIM_MS, first.by - now));
            return;
          }
          await this.state.storage.put("claim", {
            device: caller.deviceId,
            since: now,
            until: now + CLAIM_MS,
            queue: queue.filter((w) => w.device !== caller.deviceId),
          } satisfies Claim);
        }
        out = Response.json({
          ok: true,
          role: "replica",
          reason: "not-caught-up",
          head,
          epoch: head.epoch,
          catchUpTo: head.seq,
        });
        return;
      }
      // Nobody holds the lease, so this member takes it. State may exist:
      // that is what a takeover looks like, and a member that took over
      // without the state would fork the fleet. It is told what it has to
      // catch up to, and the Durable Object refuses to let it publish until
      // it says it has.
      // One more than the last grant, not than the last publish: a holder that published nothing
      // would hand its epoch to the next one, and the epoch would stop saying who held the lease.
      // (The head's epoch is the floor, so a fleet whose object storage was lost does not go back.)
      // A holder that asks again while its lease lives keeps it as it is (its epoch, and since when it has held it):
      // only a grant to another holder, or a new one after the lease lapsed, is a new epoch.
      const epoch = held && held.holder === caller.deviceId ? held.epoch : Math.max((await this.state.storage.get<number>("epoch")) ?? 0, head.epoch) + 1;
      const lease: Lease = { holder: caller.deviceId, epoch, expiresAt: now + ttlMs, since: held && held.holder === caller.deviceId ? (held.since ?? now) : now };
      await this.state.storage.put("lease", lease);
      await this.state.storage.put("epoch", epoch);
      await this.state.storage.delete("claim");
      await this.scheduleLeaseAlarm(lease.expiresAt);
      out = Response.json({
        ok: true,
        role: "primary",
        epoch,
        head,
        ttlMs,
        // The sequence this member must have applied before it may publish.
        ...(head.seq > 0 ? { catchUpTo: head.seq } : {}),
      });
    });
    return out;
  }

  private async renew(caller: Caller, body: Record<string, unknown>): Promise<Response> {
    if (caller.kind !== "device") return this.deny();
    const ttlMs = typeof body.ttlMs === "number" && body.ttlMs > 0 ? Math.min(body.ttlMs, 300_000) : LEASE_TTL_MS;
    let out: Response = Response.json({ error: "unreachable" }, { status: 500 });
    await this.state.blockConcurrencyWhile(async () => {
      const held = await this.lease();
      if (!held || held.holder !== caller.deviceId) {
        out = Response.json({ error: "not the lease holder" }, { status: 409 });
        return;
      }
      const expiresAt = Date.now() + ttlMs;
      await this.state.storage.put("lease", { ...held, expiresAt });
      await this.scheduleLeaseAlarm(expiresAt);
      out = Response.json({ ok: true, epoch: held.epoch });
    });
    return out;
  }

  /**
   * Take a member out of the running: a space the operator has switched off
   * must not keep the fleet's lease, or the fleet would go on being driven by
   * a space that cannot be reached. The next member to ask takes its place.
   */
  private async vacate(caller: Caller, body: Record<string, unknown>): Promise<Response> {
    if (caller.kind !== "admin") return this.deny();
    const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
    const held = await this.lease();
    if (!held || held.holder !== deviceId) {
      return Response.json({ ok: true, vacated: false, primary: held ? held.holder : null });
    }
    await this.state.storage.delete("lease");
    // The caller that asked for the place right after (the Worker, when a member
    // finds the holder gone) is about to give it to that member itself. Telling
    // everyone else the place is free would send all of them after it at once, and
    // whoever lost would find the new holder just as unreachable, and ask the same.
    if (body.quiet !== true) this.broadcast({ type: "lease-free" });
    return Response.json({ ok: true, vacated: true, primary: null });
  }

  private async release(caller: Caller): Promise<Response> {
    if (caller.kind !== "device") return this.deny();
    const held = await this.lease();
    if (!held || held.holder !== caller.deviceId) return Response.json({ error: "not the lease holder" }, { status: 409 });
    await this.state.storage.delete("lease");
    this.broadcast({ type: "lease-free" });
    return Response.json({ ok: true });
  }

  // Advance the head with a conditional write in R2. The condition is the fence:
  // a stale primary's expectedSeq no longer matches, so its write is refused by
  // storage rather than by a check this object could get wrong.
  private async advance(caller: Caller, body: Record<string, unknown>, request: Request): Promise<Response> {
    if (caller.kind !== "device") return this.deny();
    const fleetId = request.headers.get("x-prime-fleet") ?? "";
    const expectedSeq = typeof body.expectedSeq === "number" ? body.expectedSeq : -1;
    const manifestKey = typeof body.manifestKey === "string" ? body.manifestKey : "";
    const manifestHash = typeof body.manifestHash === "string" ? body.manifestHash : "";
    const packKey = typeof body.packKey === "string" ? body.packKey : "";
    // Other objects that belong to this snapshot (the change pack beside a
    // checkpoint's whole tree): kept and let go with it. Only this fleet's own
    // payloads may be named, so a publisher cannot have another fleet's deleted.
    const own = "fleets/" + fleetId + "/packs/";
    const extraKeys = Array.isArray(body.extraKeys)
      ? body.extraKeys.filter((k): k is string => typeof k === "string" && k.startsWith(own) && /^[0-9a-f]{16,64}$/.test(k.slice(own.length))).slice(0, 4)
      : [];
    // What a member needs to choose its route (see `index`). Only numbers and a flag.
    const rawMeta = (body.meta ?? {}) as Record<string, unknown>;
    const size = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);
    const meta = {
      full: rawMeta.full === true,
      ...(rawMeta.sealed === true ? { sealed: true as const } : {}),
      ...(size(rawMeta.packBytes) !== undefined ? { packBytes: size(rawMeta.packBytes)! } : {}),
      ...(size(rawMeta.deltaBytes) !== undefined ? { deltaBytes: size(rawMeta.deltaBytes)! } : {}),
    };
    if (!manifestKey || !manifestHash) return Response.json({ error: "manifest required" }, { status: 400 });

    const held = await this.lease();
    if (!held || held.holder !== caller.deviceId) return Response.json({ error: "not the lease holder" }, { status: 409 });

    const key = this.headKey(fleetId);
    this.meter.r2("read");
    const current = await this.bucket().get(key);
    const etag = current?.etag;
    const currentHead = current ? ((await current.json()) as Head) : { ...EMPTY_HEAD };
    if (currentHead.seq !== expectedSeq) {
      return Response.json({ error: "stale sequence", current: currentHead.seq }, { status: 409 });
    }
    // A fleet whose snapshots are sealed does not go back to ones that are not. The members check the
    // seal, and one that has seen it refuses a snapshot without; an old build that was promoted would
    // publish those and leave the fleet with no primary that anyone could replace. Its lease is handed
    // on instead (it opens sealed snapshots as it always did, and carries on as a replica), and it is
    // kept from taking the lease back for a while, so that an upgraded member has it.
    const index = (await this.state.storage.get<IndexEntry[]>("index")) ?? [];
    const tip = index[index.length - 1];
    if (tip && tip.seq === currentHead.seq && tip.sealed === undefined && meta.sealed !== true) {
      // Written through a gateway that did not record whether it was sealed: its manifest says, once.
      this.meter.r2("read");
      const sealedTip = await this.manifestIsSealed(tip.manifestKey);
      if (sealedTip !== undefined) {
        tip.sealed = sealedTip;
        await this.state.storage.put("index", index);
      }
    }
    if (tip && tip.seq === currentHead.seq && tip.sealed === true && meta.sealed !== true) {
      await this.state.storage.delete("lease");
      const bar = (await this.state.storage.get<Record<string, number>>("unsealedBar")) ?? {};
      const now = Date.now();
      for (const [device, until] of Object.entries(bar)) if (until <= now) delete bar[device];
      bar[caller.deviceId] = now + UNSEALED_BAR_MS;
      await this.state.storage.put("unsealedBar", bar);
      this.broadcast({ type: "lease-free" }, caller.deviceId);
      return Response.json(
        {
          // An old client prints this after "the fleet head moved while publishing: " and shows nothing else of the reply.
          error:
            "no, it did not: this publish was refused because this fleet's snapshots are sealed and this prime is too old to seal them. Upgrade prime on this member (it carries on as a replica)",
          upgrade: true,
        },
        { status: 409 },
      );
    }
    // A member that took over has to have applied the state it is about to
    // replace. Without this, a new primary could publish on top of state it
    // never fetched, and the fleet would lose whatever it had missed.
    const applied = (await this.state.storage.get<Record<string, number>>("applied")) ?? {};
    if ((applied[caller.deviceId] ?? 0) < currentHead.seq) {
      return Response.json(
        { error: "catch up first", required: currentHead.seq, applied: applied[caller.deviceId] ?? 0 },
        { status: 409 },
      );
    }
    const next: Head = { seq: currentHead.seq + 1, manifestKey, manifestHash, epoch: held.epoch };
    // From the moment the head can name these objects until they are in `recent`, a request for the
    // objects no snapshot names (`unreferenced`) must not see them as that: the head is written to R2
    // first, and R2 is outside this object, so other requests run in between. A publish that is sent
    // again after it was already accepted names the same objects.
    await this.startStoring(manifestKey, [manifestKey, packKey, ...extraKeys].filter(Boolean));
    let written: R2Object | null;
    try {
      this.meter.r2("write");
      written = await this.bucket().put(key, JSON.stringify(next), etag ? { onlyIf: { etagMatches: etag } } : { onlyIf: { etagDoesNotMatch: "*" } });
    } catch {
      await this.endStoring(manifestKey);
      return Response.json({ error: "head write refused" }, { status: 409 });
    }
    // A failed conditional write returns null rather than throwing: that is the
    // CAS losing the race, not an error.
    if (!written) {
      await this.endStoring(manifestKey);
      return Response.json({ error: "head changed" }, { status: 409 });
    }
    // The write above gave other requests room to run, and one of them may have removed this member. Its
    // key is recorded as left up to the head as that request saw it, which does not have this snapshot;
    // it is a member's up to this one, which the member made while it was one.
    const rostered = await this.members();
    if (!rostered[caller.deviceId]) {
      const left = (await this.state.storage.get<LeftKey[]>("left")) ?? [];
      let raised = false;
      for (const k of left) {
        if (k.device === caller.deviceId && k.until < next.seq) {
          k.until = next.seq;
          raised = true;
        }
      }
      if (raised) await this.state.storage.put("left", left);
    }
    await this.state.storage.put("epoch", next.epoch);
    // The publisher holds the state it has just published: it needs no report to
    // say so. Without this a member whose own report was lost (a timeout, a 503)
    // would be refused its next publish as "catch up first", with nothing it
    // could catch up to.
    // Read again, with no other I/O between that and the write: the write to R2
    // above gave other requests (a member's report, in particular) room to run, and
    // the map read before it would put their change back as it was.
    const now_ = (await this.state.storage.get<Record<string, number>>("applied")) ?? {};
    now_[caller.deviceId] = Math.max(now_[caller.deviceId] ?? 0, next.seq);
    await this.state.storage.put("applied", now_);
    // The members that listen pull now instead of at their next look; the one that
    // published already has it.
    this.broadcast({ type: "head", seq: next.seq, manifestKey }, caller.deviceId);

    // Keep a bounded number of snapshots: more than the newest whole tree and
    // the changes after it, which is all a member far behind needs. The old
    // ones are of no use.
    const recent = (await this.state.storage.get<string[]>("recent")) ?? [];
    recent.push([manifestKey, packKey, ...extraKeys].filter(Boolean).join("\n"));
    const evicted = recent.splice(0, Math.max(0, recent.length - RECENT_SNAPSHOTS));
    await this.state.storage.put("recent", recent);
    const kept = (await this.state.storage.get<IndexEntry[]>("index")) ?? [];
    kept.push({ seq: next.seq, manifestKey, ...meta, sealed: meta.sealed === true });
    await this.state.storage.put("index", kept.slice(-RECENT_SNAPSHOTS));
    await this.endStoring(manifestKey);
    for (const entry of evicted) {
      for (const key of entry.split("\n")) {
        if (!key) continue;
        try {
          await this.bucket().delete(key);
        } catch {}
      }
    }

    return Response.json({ ok: true, head: next });
  }

  // Which of these stored objects no retained snapshot names. The Worker stores a snapshot's
  // objects before the head moves, so a publish that is refused leaves them behind; it asks which
  // of the ones it wrote are not, and were never, part of a snapshot the fleet keeps (a retry of a
  // request that already succeeded writes the same bytes: those are the head's) and deletes them.
  // Only this fleet's own packs and manifests are answered for.
  private async unreferenced(caller: Caller, body: Record<string, unknown>, request: Request): Promise<Response> {
    if (caller.kind !== "device") return this.deny();
    const members = await this.members();
    if (!members[caller.deviceId]) return this.deny();
    const fleetId = request.headers.get("x-prime-fleet") ?? "";
    const own = new RegExp("^fleets/" + fleetId.replace(/[^a-z0-9-]/g, "") + "/(packs|manifests)/[0-9a-f]{64}$");
    const asked = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === "string" && own.test(k)).slice(0, 8) : [];
    const recent = (await this.state.storage.get<string[]>("recent")) ?? [];
    const kept = new Set([...recent.flatMap((entry) => entry.split("\n")), ...(await this.storingKeys())]);
    return Response.json({ keys: asked.filter((k) => !kept.has(k)) });
  }

  // The join requests waiting for the operator. Read tolerantly: an earlier build kept the keys of a
  // publish in flight under this same name, so what is stored may be a list of keys, or have such
  // entries among the requests, and only what has the shape of a request is one.
  private async joinRequests(): Promise<Record<string, PendingRequest>> {
    const stored = await this.state.storage.get<unknown>("pending");
    const out: Record<string, PendingRequest> = {};
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return out;
    for (const [device, value] of Object.entries(stored as Record<string, unknown>)) {
      const r = value as Partial<PendingRequest> | null;
      if (r && typeof r === "object" && typeof r.deviceId === "string" && r.deviceId === device && typeof r.requestedAt === "number") out[device] = r as PendingRequest;
    }
    return out;
  }

  // What publishes in flight are storing, so that `unreferenced` does not offer it for deletion between
  // the head being written and the snapshot being kept. One entry per publish (by its manifest), each let
  // go by the publish that made it; an entry whose publisher died is let go after a few minutes.
  private async startStoring(manifestKey: string, keys: string[]): Promise<void> {
    const now = Date.now();
    const storing = (await this.state.storage.get<Record<string, { keys: string[]; at: number }>>("storing")) ?? {};
    for (const [k, v] of Object.entries(storing)) if (now - v.at > STORING_MAX_MS) delete storing[k];
    storing[manifestKey] = { keys, at: now };
    await this.state.storage.put("storing", storing);
  }

  private async endStoring(manifestKey: string): Promise<void> {
    const storing = (await this.state.storage.get<Record<string, { keys: string[]; at: number }>>("storing")) ?? {};
    if (!(manifestKey in storing)) return;
    delete storing[manifestKey];
    if (Object.keys(storing).length === 0) await this.state.storage.delete("storing");
    else await this.state.storage.put("storing", storing);
  }

  private async storingKeys(): Promise<string[]> {
    const storing = (await this.state.storage.get<Record<string, { keys: string[] }>>("storing")) ?? {};
    return Object.values(storing).flatMap((v) => v.keys);
  }

  // Whether a stored manifest carries a seal; undefined when it cannot be read (the gate then does not fire:
  // it is a rule about availability, and a manifest nobody can read is one nobody can take in either).
  private async manifestIsSealed(manifestKey: string): Promise<boolean | undefined> {
    try {
      const obj = await this.bucket().get(manifestKey);
      if (!obj) return undefined;
      const manifest = (await obj.json()) as { seal?: unknown };
      return typeof manifest.seal === "string" && manifest.seal !== "";
    } catch {
      return undefined;
    }
  }

  // The keys of members that have left, each with the sequence the head was at when it did. A member
  // that was asleep while the primary published and then left (a machine that is retired for another)
  // still has those snapshots to take in, and they are made with a key that is no longer on the roster:
  // it is a member's for the snapshots up to there, and for none after.
  private async recordLeft(pubkey: string, fleetId: string, device: string): Promise<void> {
    const index = (await this.state.storage.get<IndexEntry[]>("index")) ?? [];
    // The index is pushed after the head is written (see `advance`), so the head can be ahead of it.
    const tip = Math.max(index.length > 0 ? index[index.length - 1]!.seq : 0, (await this.readHead(fleetId)).seq);
    const left = ((await this.state.storage.get<LeftKey[]>("left")) ?? []).filter((k) => k.pubkey !== pubkey && k.until >= tip - 2 * RECENT_SNAPSHOTS);
    left.push({ pubkey, until: tip, device });
    await this.state.storage.put("left", left.slice(-LEFT_KEYS_KEPT));
  }

  private async leftKeys(): Promise<{ pubkey: string; until: number }[]> {
    return ((await this.state.storage.get<LeftKey[]>("left")) ?? []).map(({ pubkey, until }) => ({ pubkey, until }));
  }

  // Which fleet this is, as opposed to another that was made under the same name after this one was
  // deleted. A snapshot of the earlier one is sealed and signed all the same, and its key files
  // are still on the members' disks: the members bind it into what they seal and check, so a
  // replayed snapshot of an earlier fleet does not pass for one of this. Made when first asked
  // (a fleet that predates it gets one then), and gone with the fleet.
  private async incarnation(): Promise<string> {
    const known = await this.state.storage.get<string>("incarnation");
    if (known) return known;
    const made = crypto.randomUUID();
    await this.state.storage.put("incarnation", made);
    return made;
  }

  // What this device may do right now. The Worker asks before serving a
  // payload, so the answer has to be cheap and cannot involve the network.
  private async role(caller: Caller): Promise<Response> {
    if (caller.kind !== "device") return this.deny();
    const members = await this.members();
    const member = members[caller.deviceId];
    if (!member) return Response.json({ member: false, primary: false, epoch: 0 });
    const held = await this.lease();
    return Response.json({
      member: true,
      primary: held !== null && held.holder === caller.deviceId,
      epoch: held ? held.epoch : 0,
      role: member.role,
      incarnation: await this.incarnation(),
      // This object does not move the head from a sealed snapshot to one that is not (see `advance`).
      sealGate: true,
      // The most one upload may be: a member says so before it sends what the gateway would refuse.
      snapshotLimit: MAX_SNAPSHOT_BYTES,
    });
  }

  private async me(caller: Caller): Promise<Response> {
    if (caller.kind !== "device") return this.deny();
    const members = await this.members();
    const member = members[caller.deviceId];
    if (member) return Response.json({ ok: true, status: "member", member });
    const pending = await this.joinRequests();
    if (pending[caller.deviceId]) return Response.json({ ok: true, status: "pending" });
    return Response.json({ ok: true, status: "none" });
  }
}