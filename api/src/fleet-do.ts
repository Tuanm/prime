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
  type KeyProof,
  type Member,
  type PendingRequest,
  cleanKeyProof,
  cleanLabel,
  cleanPubkey,
  cleanSpub,
  keyChangeMessage,
  keyFingerprintLong,
  keyFingerprintMatches,
  KEY_PROOF_INFO,
  KEY_PROOF_WINDOW_MS,
  clampTtl,
  checkedInline,
  INLINE_CAP,
  cleanCaps,
  commonCaps,
  effectiveLeaseMs,
  FENCE_TTL_MS,
  hashCode,
  LEASE_DEFAULT_MS,
  LEASE_MIN_MS,
  leaseBounds,
  inviteShape,
  MAX_MEMBERS,
  CHUNK_BYTES,
  CHUNKS_CAP,
  MAX_CHUNKED_SNAPSHOT_BYTES,
  MAX_CHUNKS,
  MAX_SNAPSHOT_BYTES,
  UPLOAD_KEEP_MS,
  UPLOADS_KEPT,
  RECENT_SNAPSHOTS,
  MAX_PENDING,
  newInviteCode,
  validFleetId,
} from "./fleets";
import { AUDIT_PAGE_MAX, AuditLog, type AuditDetail, actorOf, auditLimits } from "./fleet-audit";
import { HitMeter, meterStorage, sendUsage } from "./usage";
import { ROSTER_MAX_ENTRIES, RosterRefusal, type SignedEntry, begin, entryHash, extend, foldTrusted, fleetKeyOf, parseSigned } from "./fleet-roster";
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
  /** How long a place in the fleet lasts without being renewed (held between the bounds; see `effectiveLeaseMs`). */
  leaseMs?: number;
}

/** The routes a paused fleet refuses. */
const PAUSED_ROUTES = new Set(["/join", "/bootstrap", "/head/advance"]);
/** How long a member is told to wait before asking a paused fleet again. */
const PAUSED_RETRY_MS = 60_000;
/** How long a viewer is told to wait before asking again: it will never be given the lease, so there is no hurry. */
const VIEWER_RETRY_MS = 30_000;

interface Caller {
  kind: "admin" | "device";
  deviceId: string;
  /** `x-prime-actor`, which the Worker sets on an operator's call: who the operator is (see `actorOf`). */
  actorHeader?: string | null;
  /** Set when the call was let in because the device owns the fleet, so the log says the owner did it. */
  asOwner?: boolean;
}

type Members = Record<string, Member>;
/** A fence for a removal: the sequence it was fenced at (null while it is being waited for), when, and whether the member left by itself. */
type Fence = { seqAt: number | null; at: number; left?: true };

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
interface Storing {
  manifestKey: string;
  keys: string[];
  seq: number;
  headKey: string;
  meta: Record<string, unknown>;
  at: number;
}

// A publish still storing after this long is taken to have died, and what it left is settled (see `settleStoring`).
const STORING_GRACE_MS = 60_000;
// The most publishes recorded as storing at once; a longer list is of publishers that died, oldest let go.
const STORING_MAX_ENTRIES = 64;
// How many keys the gateway's sweep may ask about at once (a member asks about 8).
const SWEEP_ASK_MAX = 1000;
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
export const LEASE_TTL_MS = LEASE_DEFAULT_MS;

/** How seldom the fleet is marked as touched: see `touch`. */
const TOUCH_EVERY_MS = 60_000;

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

  /** The members, other than `except`, that listen and say they take a small snapshot in the event that announces it. */
  private async inlineListeners(except: string): Promise<Set<string>> {
    const listening = new Set<string>();
    for (const ws of this.sockets()) {
      try {
        const id = (ws.deserializeAttachment?.() as { deviceId?: string } | null | undefined)?.deviceId;
        if (id && id !== except) listening.add(id);
      } catch {}
    }
    if (listening.size === 0) return listening;
    const members = await this.members();
    return new Set([...listening].filter((id) => members[id]?.caps?.includes(INLINE_CAP)));
  }

  /** Tell every listening member, except the one named, what `make` says for it (the same text is made once). */
  private broadcastEach(make: (deviceId: string | undefined) => Record<string, unknown>, except?: string): void {
    const texts = new Map<Record<string, unknown>, string>();
    for (const ws of this.sockets()) {
      try {
        const id = (ws.deserializeAttachment?.() as { deviceId?: string } | null | undefined)?.deviceId;
        if (except && id === except) continue;
        const event = make(id);
        let text = texts.get(event);
        if (text === undefined) texts.set(event, (text = JSON.stringify(event)));
        ws.send(text);
      } catch {}
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
    const target = expiresAt + 250;
    // An alarm already set for this moment or an earlier one is left as it is: setting one is a row
    // written, and a holder renews every fifteen seconds. An earlier one is no loss: it finds the lease
    // alive when it fires and sets the next one from the lease it finds (see `onAlarm`), so the call that
    // the place is free is never later than the lease. What is remembered is only what this object
    // set: after it has been evicted it sets one again, which costs a row and is safe.
    if (this.alarmAt !== null && this.alarmAt <= target) return;
    const s = this.storage as unknown as { setAlarm?: (at: number) => Promise<void> };
    try {
      await s.setAlarm?.(target);
      this.alarmAt = target;
    } catch {
      // Not set, so not remembered: the next renewal tries again.
    }
  }

  /** When the alarm this object set will fire, if it has set one that has not yet. */
  private alarmAt: number | null = null;

  async alarm(): Promise<void> {
    return this.meter.alarm(() => this.onAlarm());
  }

  private async onAlarm(): Promise<void> {
    // This one is spent: whatever is set from here is a new one.
    this.alarmAt = null;
    await this.settleStoring().catch(() => undefined);
    const raw = await this.storage.get<Lease>("lease");
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
    return { type: "hello", paused: meta.disabled === true, leaseHolder: held ? held.holder : null, leaseMs: effectiveLeaseMs(meta.leaseMs, this.env) };
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
  // The gateway reads it when a device asks to clear away a fleet it thinks is abandoned (`reap`):
  // one more condition, never the reason to allow a delete.
  //
  // Written once a minute at most: the gateway reads it in days, and a primary that asks for its place
  // every fifteen seconds would otherwise write it every time, and the row is billed. What is kept
  // in memory is only when it was last written, so an object that is woken again writes it at once.
  private lastTouched = 0;
  private async touch(): Promise<void> {
    const now = Date.now();
    if (now >= this.lastTouched && now - this.lastTouched < TOUCH_EVERY_MS) return;
    await this.storage.put("lastActivity", now);
    this.lastTouched = now;
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
  // Resolves whether the fleet's audit log was kept: it is copied to the bucket, outside what is cleared here.
  private async clear(fleetId: string): Promise<boolean> {
    this.hangUp("the fleet is gone");
    // A log that could not be copied to the bucket stays in the object (its rows and the fleet's name are not cleared): the
    // history of a fleet is not lost to a bucket that was down at the moment it was deleted, and a fleet made again under the
    // name carries on from it.
    const kept = await this.auditLog().retire().catch((e) => {
      console.error("audit: could not retire the log: " + String(e));
      return false;
    });
    if (kept) {
      await this.storage.delete("fleetName");
      await this.storage.delete("auditOrphan");
      this.fleetName = "";
    } else {
      // Left in the object, and copied by the next ask whether the fleet exists (the gateway's daily sweep makes it) or read.
      await this.storage.put("auditOrphan", true);
    }
    // A fleet that is deleted is not still paused: the name can be made again.
    await this.storage.delete("meta");
    this.metaKept = undefined;
    await this.storage.delete("members");
    await this.storage.delete("created");
    await this.storage.delete("incarnation");
    await this.storage.delete("left");
    await this.storage.delete("unsealedBar");
    await this.storage.delete("invites");
    await this.storage.delete("pending");
    await this.storage.delete("storing");
    await this.storage.delete("lease");
    await this.storage.delete("epoch");
    await this.storage.delete("applied");
    await this.storage.delete("claim");
    await this.storage.delete("fetched");
    await this.storage.delete("index");
    await this.storage.delete("recent");
    // A fleet of the name made again has no chain, and nobody fenced.
    await this.storage.delete("roster");
    await this.storage.delete("rosterMode");
    await this.storage.delete("fence");
    this.signedMemo = false;
    this.fenceMemo = {};
    await this.storage.delete("uploads");
    await this.storage.delete("ownerSeenAt");
    // The next fleet of the name has a key pair of its own for key-change proofs.
    await this.storage.delete("proofKey");
    await this.storage.delete("proofNonces");
    await this.storage.delete("lastActivity");
    this.lastTouched = 0;
    this.proofKeyMemo = undefined;
    await this.deleteStored(fleetId);
    // The fleet is gone, so the registry should stop listing it.
    await this.registerWithRegistry(fleetId, false);
    return kept;
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

  // Only the operator or the fleet's owner may delete a fleet. A fleet that is paused, or whose
  // agents were stopped for a weekend, records no activity, so silence says nothing about whether
  // anybody still wants it; and on a gateway that gives devices to anyone, "a proven device" is
  // anyone. An abandoned fleet is cleared away by `reap`, which the Worker allows only when the
  // gateway knows none of its members.
  private async delete(caller: Caller, request: Request, body: Record<string, unknown>): Promise<Response> {
    const denied = await this.requireOperatorOrOwner(caller);
    if (denied) return denied;
    const fleetId = request.headers.get("x-prime-fleet") ?? "";
    // A delete of a name that is no fleet (a retry, a reap of one already gone) leaves no entry and no file.
    if (await this.exists()) await this.audit(caller, "fleet-deleted", undefined, typeof body.reason === "string" ? { reason: body.reason } : undefined);
    const kept = await this.clear(fleetId);
    // `auditKept: false`: the log could not be copied to the bucket and stays in the object. It is readable by the operator, and
    // copied the next time the gateway asks whether the fleet exists (the daily sweep does) or the operator reads it.
    return Response.json({ ok: true, deleted: fleetId, ...(kept ? {} : { auditKept: false }) });
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
    const lastActivity = (await this.storage.get<number>("lastActivity")) ?? 0;
    const created = (await this.storage.get<number>("created")) ?? 0;
    const meta = await this.meta();
    return Response.json({ members: Object.keys(members), lastActivity, created, meta, rosterSigned: await this.rosterSigned(), fences: await this.fencesShown(), pendingRemoves: await this.pendingRemoves() });
  }

  //
  // Who holds the lease, for a client that wants to talk to the fleet.
  //
  // A client that is not a member learns nothing: it is told that there is
  // no primary, not who it is.
  private async primary(caller: Caller, request: Request): Promise<Response> {
    const held = await this.lease();
    // The operator may ask: the admin interface shows who holds the lease.
    if (caller.kind === "admin") {
      await this.auditRelay(caller, request, held ? held.holder : null);
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
    // A viewer cannot make the fleet's tools be called: the gateway refuses it before it asks the primary.
    const viewer = members[caller.deviceId]!.role === "viewer";
    if (!viewer) await this.auditRelay(caller, request, held ? held.holder : null);
    return Response.json({
      member: true,
      ...(viewer ? { role: "viewer" } : {}),
      primary: held ? held.holder : null,
      epoch: held ? held.epoch : 0,
      ...(held?.since !== undefined ? { since: held.since } : {}),
    });
  }

  /**
   * The call the gateway is about to relay to the primary, said in the question that asks who the primary is: `audit` is
   * `<method>:<tool>` and `bytes` the size of the body, set by the Worker and by nobody else. What the call asks of the
   * tool is not logged, nor is anything of what it carries. A call that comes by a member is its entry; one that comes by
   * the fleet's token is the gateway's, and says so. Off with FLEET_AUDIT_RELAY=0, for a fleet whose calls are many and
   * whose cost is not worth a row each.
   */
  private async auditRelay(caller: Caller, request: Request, holder: string | null): Promise<void> {
    const asked = new URL(request.url).searchParams.get("audit");
    // Only a call that has a primary to go to: with none, the Worker answers 503 and nothing is relayed.
    if (asked === null || holder === null || this.env.FLEET_AUDIT_RELAY === "0") return;
    const colon = asked.indexOf(":");
    const plain = (v: string): string => (/^[A-Za-z0-9_.\-/]{1,64}$/.test(v) ? v : "?");
    const method = plain(colon === -1 ? asked : asked.slice(0, colon));
    const tool = colon === -1 ? undefined : plain(asked.slice(colon + 1));
    const bytes = Number(new URL(request.url).searchParams.get("bytes"));
    await this.audit(caller, "relayed", holder, {
      method,
      ...(tool !== undefined ? { tool } : {}),
      ...(Number.isFinite(bytes) && bytes >= 0 ? { bytes: Math.floor(bytes) } : {}),
    });
  }

  /**
   * The log, from the entry after `after` (or the newest `tail`): the operator's, or the owner's (who is let in to everything else of the fleet
   * as well). `head` is where it stands now, the number and hash a reader keeps to check what it reads next against, and
   * `first` the oldest entry the object still holds: the ones before it are in the bucket (see fleet-audit.ts), and the
   * first one held carries the hash of the last that went. `unrecorded` is how many entries could not be stored since
   * the object woke.
   */
  /**
   * A deleted fleet whose log could not be copied to the bucket still holds it. Try again; once it is copied the rows are gone
   * and so is the mark. True while rows are still held.
   */
  private async retryOrphanLog(): Promise<boolean> {
    if ((await this.storage.get<boolean>("auditOrphan")) !== true || (await this.exists())) return false;
    const kept = await this.auditLog().retire().catch(() => false);
    if (kept) {
      await this.storage.delete("fleetName");
      await this.storage.delete("auditOrphan");
      this.fleetName = "";
      return false;
    }
    return true;
  }

  private async readAudit(caller: Caller, url: URL): Promise<Response> {
    const denied = await this.requireOperatorOrOwner(caller);
    if (denied) return denied;
    if (!(await this.exists())) {
      // Only the operator reads what a deleted fleet's log still holds (it could not be copied when the fleet was deleted).
      if (caller.kind !== "admin" || !(await this.retryOrphanLog())) return Response.json({ error: "no such fleet" }, { status: 404 });
    }
    const num = (name: string, fallback: number): number => {
      const n = Number(url.searchParams.get(name));
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    // `tail=n` is the newest n, for a page that shows what happened last.
    const read = url.searchParams.has("tail") ? await this.auditLog().readLast(num("tail", 50) || 50) : await this.auditLog().read(num("after", 0), num("limit", 100) || 100);
    return Response.json({ ok: true, ...read, limit: AUDIT_PAGE_MAX, ...(this.auditFailures > 0 ? { unrecorded: this.auditFailures } : {}) });
  }

  /**
   * Something the operator did that the object has no other way to know: the fleet's own token was set or cleared, which
   * the registry holds (nothing of the token is said). Only the gateway says it, and only a few things are taken.
   */
  private async note(caller: Caller, body: Record<string, unknown>): Promise<Response> {
    if (caller.kind !== "admin") return this.deny();
    const what = body.action;
    if (what !== "fleet-token-set" && what !== "fleet-token-cleared" && what !== "bucket-swept") return Response.json({ error: "not a note" }, { status: 400 });
    if (!(await this.exists())) return Response.json({ error: "no such fleet" }, { status: 404 });
    // The daily sweep says how many objects of the fleet it deleted, and nothing else about them.
    const count = what === "bucket-swept" && typeof body.count === "number" && Number.isSafeInteger(body.count) && body.count > 0 ? body.count : undefined;
    if (what === "bucket-swept" && count === undefined) return Response.json({ error: "not a note" }, { status: 400 });
    await this.audit(caller, what, undefined, count !== undefined ? { objects: count } : undefined);
    return Response.json({ ok: true });
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
    const entries = ((await this.storage.get<IndexEntry[]>("index")) ?? [])
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
    const applied = (await this.storage.get<Record<string, number>>("applied")) ?? {};
    const fetched = (await this.storage.get<Record<string, number>>("fetched")) ?? {};
    return Response.json({
      members: Object.values(members).map((m) => ({
        deviceId: m.deviceId,
        ...(m.pubkey ? { pubkey: m.pubkey } : {}),
        // What it says it can do, so that a format is used only when every member can read it.
        ...(m.caps && m.caps.length > 0 ? { caps: m.caps } : {}),
        // A viewer is sealed for like the others and never writes.
        ...(m.role === "viewer" ? { role: "viewer" } : {}),
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
  private async applied(caller: Caller, body: Record<string, unknown>, request: Request): Promise<Response> {
    if (caller.kind !== "device") return this.deny();
    const members = await this.members();
    if (!members[caller.deviceId]) return this.deny();
    // What a member says it has applied or fetched is a position in the chain, so it cannot be past the
    // head: a member that claimed any number would have the lease without catching up. The head is read
    // from where it is kept; a read that fails is not "no head", and nothing is recorded on it.
    const head = await this.readHeadOrNull(request.headers.get("x-prime-fleet") ?? "");
    if (head === null) return Response.json({ error: "the fleet's head could not be read" }, { status: 503 });
    const upTo = (v: unknown): number | undefined => (typeof v === "number" && v >= 0 ? Math.min(Math.floor(v), head.seq) : undefined);
    const seq = upTo(body.seq) ?? 0;
    const applied = (await this.storage.get<Record<string, number>>("applied")) ?? {};
    if (seq > (applied[caller.deviceId] ?? 0)) applied[caller.deviceId] = seq;
    await this.storage.put("applied", applied);
    // A replica that fetches ahead says how far it has fetched, which is not
    // how far it has applied: only `applied` gates the lease. Members that do
    // not say have nothing recorded.
    let fetchedSeq: number | undefined;
    const fetchedAsked = upTo(body.fetched);
    if (fetchedAsked !== undefined) {
      const fetched = (await this.storage.get<Record<string, number>>("fetched")) ?? {};
      fetchedSeq = Math.max(fetched[caller.deviceId] ?? 0, fetchedAsked);
      fetched[caller.deviceId] = fetchedSeq;
      await this.storage.put("fetched", fetched);
    }
    return Response.json({ ok: true, applied: applied[caller.deviceId] ?? 0, ...(fetchedSeq !== undefined ? { fetched: fetchedSeq } : {}) });
  }

  /** Whether this object has told the registry it exists. */
  private announced = false;

  private async members(): Promise<Members> {
    return (await this.storage.get<Members>("members")) ?? {};
  }

  /** What the operator has set about the fleet itself. */
  private async meta(): Promise<FleetMeta> {
    // Kept in memory: it is read by every renewal (for the lease), and changes only here. An object that was
    // evicted reads it again, which is the same value.
    if (this.metaKept === undefined) this.metaKept = (await this.storage.get<FleetMeta>("meta")) ?? {};
    return { ...this.metaKept };
  }
  private metaKept?: FleetMeta;

  /** A fleet the operator has paused takes no part in anything. */
  private async paused(): Promise<boolean> {
    return (await this.meta()).disabled === true;
  }

  /**
   * Set what the operator has decided about the fleet. The label and the pause are the operator's (the admin
   * page). The lease is the operator's or the fleet owner's: `leaseMs` between the bounds, or null to go back to
   * the gateway's. A value outside the bounds is refused, not clamped, so that nobody believes a fleet runs on a
   * lease it does not.
   */
  private async setMeta(caller: Caller, body: Record<string, unknown>): Promise<Response> {
    if (caller.kind !== "admin") {
      const denied = await this.requireOperatorOrOwner(caller);
      if (denied) return denied;
      // The owner of a fleet sets its lease and nothing else of it: pausing and naming are the operator's, and the
      // registry that answers for a paused fleet is told by the operator's route only.
      if (typeof body.label === "string" || typeof body.disabled === "boolean") return this.deny();
    }
    // The floor FLEET_LEASE_MIN_MS lowers (for a test that must see a lease end in seconds) is the operator's alone: an
    // owner device, which any member of a gateway that hands out devices may be, never sets a lease under thirty seconds.
    const { min, max } = caller.kind === "admin" ? leaseBounds(this.env) : leaseBounds({});
    let out: Response = Response.json({ error: "unreachable" }, { status: 500 });
    let leaseChanged = false;
    let pauseChanged: boolean | undefined;
    // Read, changed and written as one step: two changes (the page's label or pause, an owner's lease) that ran at once
    // would each start from the same copy, and one would be lost.
    await this.state.blockConcurrencyWhile(async () => {
      if (!(await this.exists())) {
        out = Response.json({ error: "no such fleet" }, { status: 404 });
        return;
      }
      const meta = await this.meta();
      const wasPaused = meta.disabled === true;
      const wasLease = effectiveLeaseMs(meta.leaseMs, this.env);
      const wasLabel = meta.label;
      if (typeof body.label === "string") {
        const label = cleanLabel(body.label);
        if (label === undefined) delete meta.label;
        else meta.label = label;
      }
      if (typeof body.disabled === "boolean") meta.disabled = body.disabled;
      if (body.leaseMs === null) delete meta.leaseMs;
      else if (body.leaseMs !== undefined) {
        const asked = body.leaseMs;
        if (typeof asked !== "number" || !Number.isFinite(asked) || asked < min || asked > max) {
          out = Response.json({ error: "leaseMs must be a number between " + min + " and " + max, min, max }, { status: 400 });
          return;
        }
        meta.leaseMs = Math.round(asked);
        if (meta.leaseMs < LEASE_MIN_MS) console.warn("fleet: a lease of " + meta.leaseMs + " ms was set, under the " + LEASE_MIN_MS + " ms floor, by FLEET_LEASE_MIN_MS (for tests only)");
      }
      await this.storage.put("meta", meta);
      this.metaKept = { ...meta };
      leaseChanged = effectiveLeaseMs(meta.leaseMs, this.env) !== wasLease;
      if ((meta.disabled === true) !== wasPaused) pauseChanged = meta.disabled === true;
      const changed: AuditDetail = {};
      if (pauseChanged !== undefined) changed.paused = pauseChanged;
      if (leaseChanged) changed.leaseMs = meta.leaseMs ?? null;
      if (meta.label !== wasLabel) changed.label = meta.label ?? null;
      if (Object.keys(changed).length > 0) await this.audit(caller, "fleet-changed", undefined, changed);
      out = Response.json({ ok: true, meta, leaseMs: effectiveLeaseMs(meta.leaseMs, this.env) });
    });
    // Told after the decision is stored, outside the block that made it.
    if (pauseChanged !== undefined) this.broadcast({ type: pauseChanged ? "paused" : "resumed" });
    // A replica that only heard the lease in its first hello would go on asking for the place at that lease's pace;
    // a member of an earlier build ignores a frame it does not know.
    if (leaseChanged) this.broadcast({ type: "lease", leaseMs: effectiveLeaseMs(this.metaKept?.leaseMs, this.env) });
    return out;
  }

  /** What this fleet served this month, sent on in batches. */
  // The requests this object is running that are storing a snapshot (see `startStoring`). Memory, not storage:
  // an object that died has lost it, which is how its entries are known to have no request behind them.
  private readonly live = new Set<string>();
  private readonly meter = new HitMeter((add) => {
    sendUsage(this.env.REGISTRY.get(this.env.REGISTRY.idFromName("global")), add);
  });

  /** This object's storage, with the rows it reads and writes counted. */
  private metered?: DurableObjectStorage;
  private get storage(): DurableObjectStorage {
    return (this.metered ??= meterStorage(this.state.storage, this.meter));
  }

  async fetch(request: Request): Promise<Response> {
    this.meter.hit();
    const answer = await this.meter.busy(() => this.serve(request));
    // Outside every decision, and not waited for by the caller: moving old entries to the bucket reaches the network. It
    // holds nothing that a decision waits for (see AuditLog), and a trim that is cut short is done again.
    if (this.auditLog().due()) void this.meter.busy(() => this.auditLog().trim()).catch(() => undefined);
    return answer;
  }

  // ---- the audit log (see fleet-audit.ts) ----

  /** The fleet's name, as the Worker last said it: the log's files in the bucket are named by it. */
  private fleetName = "";
  private auditKept?: AuditLog;
  /** Entries that could not be stored since this object woke. Said by the log's reader, so a gap is not silent. */
  private auditFailures = 0;

  private auditLog(): AuditLog {
    return (this.auditKept ??= new AuditLog(
      this.storage as never,
      async (name, body, meta) => {
        // A seam for a smoke test that must see a decision made while a copy to the bucket is in flight.
        const slow = Number(this.env.FLEET_AUDIT_ARCHIVE_DELAY_MS);
        if (Number.isFinite(slow) && slow > 0) await new Promise((r) => setTimeout(r, Math.min(slow, 10_000)));
        const incarnation = await this.storage.get<string>("incarnation");
        this.meter.r2("write");
        await this.bucket().put(name, body, { customMetadata: { ...meta, ...(incarnation ? { incarnation } : {}) } });
      },
      () => this.auditPrefix(),
      Date.now,
      auditLimits(this.env),
    ));
  }

  /**
   * Where this fleet's old entries are kept in the bucket: outside `fleets/<id>/`, which is cleared when the fleet is,
   * because what was done to a fleet must outlive it. The name is the one the Worker last said, else the one stored when
   * the fleet was made; with neither, null, and nothing is archived (never under a name that is not the fleet's).
   */
  private async auditPrefix(): Promise<string | null> {
    if (!this.fleetName) {
      const stored = await this.storage.get<string>("fleetName");
      if (stored && validFleetId(stored)) this.fleetName = stored;
    }
    return this.fleetName ? "audit/" + this.fleetName + "/" : null;
  }

  /**
   * Record what was done. It never throws: an entry that cannot be stored is logged and counted (the reader is told),
   * because the decision it records is already made, and failing inside one that holds the object shut would reset it.
   */
  private async audit(caller: Caller, action: string, target?: string, detail?: AuditDetail): Promise<void> {
    try {
      await this.auditLog().append({
        actor: actorOf(caller.kind, caller.deviceId, caller.actorHeader ?? null, caller.asOwner === true),
        action,
        ...(target !== undefined ? { target } : {}),
        ...(detail ? { detail } : {}),
      });
    } catch (e) {
      this.auditFailures++;
      console.error("audit: could not record " + action + ": " + String(e));
    }
  }

  private async serve(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};

    // The Worker has already proved the caller; these headers are internal.
    const kind = request.headers.get("x-prime-caller") === "admin" ? "admin" : "device";
    const deviceId = request.headers.get("x-prime-device") ?? "";
    const caller: Caller = { kind, deviceId, actorHeader: request.headers.get("x-prime-actor") };

    // The operator lists the fleets from the registry, because the objects
    // cannot be enumerated. A fleet made before the registry existed, or one
    // whose registration was lost, would be invisible to the operator for
    // ever; it puts itself back on the first request the object sees.
    // The name, from any request that carries one: an object that was woken by a request that does not (the check of an
    // invite) learns it from the next.
    const named = request.headers.get("x-prime-fleet") ?? "";
    if (!this.fleetName && validFleetId(named)) this.fleetName = named;
    if (!this.announced) {
      this.announced = true;
      const name = named;
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
    if (path === "/approve" && request.method === "POST") return this.approve(caller, body, request.headers.get("x-prime-fleet") ?? "");
    if (path === "/remove" && request.method === "POST") return this.remove(caller, body, request);
    if (path === "/revoke" && request.method === "POST") return this.revoke(caller, body);
    if (path === "/members" && request.method === "GET") return this.listMembers(caller);
    if (path === "/pending" && request.method === "GET") return this.listPending(caller);
    if (path === "/me" && request.method === "GET") return this.me(caller);
    if (path === "/role") return this.role(caller);
    if (path === "/primary" && request.method === "GET") return this.primary(caller, request);
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
      return this.applied(caller, body, request);
    }
    if (path === "/exists" && request.method === "GET") return caller.kind === "admin" ? Response.json({ exists: await this.exists() }) : this.deny();
    if (path === "/uploaded" && request.method === "POST") return this.uploaded(caller, body, request);
    if (path === "/unreferenced" && request.method === "POST") return this.unreferenced(caller, body, request);
    if (path === "/delete" && request.method === "POST") return this.delete(caller, request, body);
    if (path === "/audit" && request.method === "GET") return this.readAudit(caller, url);
    if (path === "/note" && request.method === "POST") return this.note(caller, body);
    if (path === "/keys" && request.method === "GET") return this.keys(caller);
    if (path === "/roster" && request.method === "GET") return this.rosterGet(caller, url);
    if (path === "/roster" && request.method === "POST") return this.rosterPost(caller, body, request);
    if (path === "/remove-fence" && request.method === "POST") return this.removeFence(caller, body, request);
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
  // The operator is what the Worker says is one: the fleet operator token, or the admin page behind
  // Access. The owner is the device that created the fleet, and it runs
  // its own fleet: a member it invited would have no way to admit anyone if
  // only the operator could.
  private async requireOperatorOrOwner(caller: Caller): Promise<Response | null> {
    if (caller.kind === "admin") return null;
    if (caller.kind !== "device") return this.deny();
    const members = await this.members();
    const member = members[caller.deviceId];
    if (!member || member.role !== "owner") return this.deny();
    // The owner speaks for its fleet by acting on it.
    caller.asOwner = true;
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
      await this.storage.put("created", Date.now());
      await this.storage.put("fleetName", fleetId);
      // A log that was kept when the fleet before it was deleted (the bucket was down then) is carried on, and says so.
      await this.storage.delete("auditOrphan");
      const carried = await this.auditLog().held();
      await this.audit(caller, carried > 0 ? "fleet-recreated" : "fleet-created", undefined, caller.deviceId ? { for: caller.deviceId } : undefined);
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
    if ((await this.storage.get<number>("created")) !== undefined) return true;
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
      const invites = (await this.storage.get<Record<string, Invite>>("invites")) ?? {};
      // Drop expired invites while we are here, so storage does not accumulate.
      for (const [hash, inv] of Object.entries(invites)) if (inv.expiresAt <= now) delete invites[hash];
      const invite: Invite = { codeHash, expiresAt: now + ttlMs, createdBy: caller.deviceId, createdAt: now };
      invites[codeHash] = invite;
      await this.storage.put("invites", invites);
      // The code is never written down: only that one was made, and for how long.
      await this.audit(caller, "invite-created", undefined, { ttlMs, expiresAt: invite.expiresAt });
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
    const invites = (await this.storage.get<Record<string, Invite>>("invites")) ?? {};
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
    const spub = cleanSpub(body.spub);
    const codeHash = await hashCode(code);

    let out: Response = Response.json({ error: "unreachable" }, { status: 500 });
    await this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const members = await this.members();
      const invites = (await this.storage.get<Record<string, Invite>>("invites")) ?? {};

      const existing = members[caller.deviceId];
      if (existing) {
        // Idempotent re-join: already a member is not an error. A key that is not the one the fleet
        // holds does not replace it on the strength of the device's credential: see `changeKey`.
        const changed = pubkey ? await this.changeKey(caller, members, caller.deviceId, pubkey, cleanKeyProof(body.keyProof), request.headers.get("x-prime-fleet") ?? "", spub) : "same";
        if (changed === "same" && (await this.noteSpub(members, caller.deviceId, spub))) await this.storage.put("members", members);
        out = changed === "pending" ? this.keyPending() : changed === "full" ? this.tooManyPending() : Response.json({ ok: true, status: "member", member: members[caller.deviceId] });
        return;
      }

      const invite = invites[codeHash];
      if (!invite) {
        out = Response.json({ error: "unknown or already-used invite" }, { status: 403 });
        return;
      }
      if (invite.expiresAt <= now) {
        delete invites[codeHash];
        await this.storage.put("invites", invites);
        out = Response.json({ error: "invite expired" }, { status: 403 });
        return;
      }

      // The invite is consumed by the first device that presents it, whether or
      // not approval follows. One code, one admission attempt.
      delete invites[codeHash];
      await this.storage.put("invites", invites);

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
        ...(spub ? { spub } : {}),
        ...(body.role === "viewer" ? { role: "viewer" as const } : {}),
        requestedAt: now,
      };
      await this.storage.put("pending", pending);
      await this.audit(caller, "join-requested", caller.deviceId, { ...(label ? { label } : {}), ...(pubkey ? { key: await keyFingerprintLong(pubkey) } : {}) });
      out = Response.json({ ok: true, status: "pending", requestedAt: now });
    });
    return out;
  }

  private async approve(caller: Caller, body: Record<string, unknown>, fleetId: string): Promise<Response> {
    const denied = await this.requireOperatorOrOwner(caller);
    if (denied) return denied;
    // In a fleet whose roster is signed, a member is admitted, its key replaced and its role changed by an entry the owner key signs.
    if (await this.rosterSigned()) return this.signedRefusal("approve");
    const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";

    let out: Response = Response.json({ error: "unreachable" }, { status: 500 });
    let freedLease = false;
    await this.state.blockConcurrencyWhile(async () => {
      const pending = await this.joinRequests();
      const request = pending[deviceId];
      if (!request && body.role !== undefined && (await this.members())[deviceId]) {
        // A member that is already in, with a role: what changes is the role (member or viewer), in place.
        const changed = await this.changeRole(caller, deviceId, body.role);
        out = changed.out;
        freedLease = changed.freedLease;
        return;
      }
      if (!request) {
        out = Response.json({ error: "no such request" }, { status: 404 });
        return;
      }
      const members = await this.members();
      // A device that is a member asks for another key: approving it is what replaces the key, and it is
      // not an admission, so a full fleet may still do it. The approval names the key it means (`key`: its
      // fingerprint, as the list shows it), so that a request that was replaced since it was read, or that
      // nobody compared, is not approved by mistake.
      if (request.keyChange) {
        const member = members[deviceId];
        if (!member || !request.pubkey) {
          delete pending[deviceId];
          await this.storage.put("pending", pending);
          out = Response.json({ error: "no such request" }, { status: 404 });
          return;
        }
        // A device that asks for a key does not approve it: whoever holds its credential has it too.
        if (caller.kind === "device" && caller.deviceId === deviceId) {
          out = Response.json(
            {
              error: "forbidden",
              hint: "a device does not approve its own new key: the operator does, from the admin page or with the fleet operator token (prime fleets approve <fleet> --member <id> --key <fingerprint>, with PRIME_FLEET_OPERATOR_TOKEN or --operator-token)",
            },
            { status: 403 },
          );
          return;
        }
        if (typeof body.key !== "string" || body.key === "") {
          out = Response.json(
            { error: "this request is for a new key of a member: say which key you approve", hint: "pass its fingerprint (the KEY of the request: `prime fleets pending`, then `prime fleets approve <fleet> --member <id> --key <fingerprint>`, or the admin page)" },
            { status: 400 },
          );
          return;
        }
        if (!(await keyFingerprintMatches(body.key, request.pubkey))) {
          out = Response.json({ error: "the key waiting is not the one named", hint: "read the list of requests again" }, { status: 409 });
          return;
        }
        delete pending[deviceId];
        await this.replaceKey(members, deviceId, request.pubkey, fleetId, caller, "approved", { spub: request.spub });
        await this.storage.put("pending", pending);
        out = Response.json({ ok: true, member: members[deviceId], keyChanged: true });
        return;
      }
      if (Object.keys(members).length >= MAX_MEMBERS) {
        out = Response.json({ error: "fleet is full" }, { status: 409 });
        return;
      }
      // What it is admitted as: a member, or a viewer that reads and never writes. The owner is not made here.
      if (body.role !== undefined && body.role !== "member" && body.role !== "viewer") {
        out = Response.json({ error: "role is member or viewer" }, { status: 400 });
        return;
      }
      // The first member the operator admits owns the fleet: a fleet with
      // nobody in it cannot be run by anybody.
      const empty = Object.keys(members).length === 0;
      if (empty && body.role === "viewer") {
        out = Response.json({ error: "the first member of a fleet owns it, so it cannot be a viewer", hint: "admit a member first" }, { status: 409 });
        return;
      }
      // A fleet that has no owner (the one it had was removed, and only viewers were left) is owned by the next one that is not a viewer.
      const owns = body.role !== "viewer" && !Object.values(members).some((m) => m.role === "owner");
      delete pending[deviceId];
      const member: Member = {
        deviceId,
        role: owns ? "owner" : body.role === "viewer" ? "viewer" : "member",
        addedAt: Date.now(),
        addedBy: caller.deviceId,
        ...(request.pubkey ? { pubkey: request.pubkey } : {}),
        ...(request.spub ? { spub: request.spub } : {}),
        ...(request.label ? { label: request.label } : {}),
      };
      members[deviceId] = member;
      await this.storage.put("members", members);
      await this.storage.put("pending", pending);
      await this.audit(caller, "member-admitted", deviceId, { role: member.role, ...(member.pubkey ? { key: await keyFingerprintLong(member.pubkey) } : {}) });
      out = Response.json({ ok: true, member });
    });
    // Told after the decision is made and stored, outside the block that made it.
    if (freedLease) this.broadcast({ type: "lease-free" }, deviceId);
    return out;
  }

  /**
   * Make a member a viewer, or a viewer a member, where it stands: it keeps its place in the order the fleet is handed on in.
   * The owner is not changed here (it is removed, and the fleet is handed on). A member that is made a viewer lets go of the lease
   * it holds, and the others are told it is free.
   */
  private async changeRole(caller: Caller, deviceId: string, asked: unknown): Promise<{ out: Response; freedLease: boolean }> {
    if (asked !== "member" && asked !== "viewer") return { out: Response.json({ error: "role is member or viewer" }, { status: 400 }), freedLease: false };
    const members = await this.members();
    const member = members[deviceId]!;
    if (member.role === "owner") {
      return { out: Response.json({ error: "the owner's role is not changed here", hint: "remove the owner, and the fleet is handed to the longest-standing member that is not a viewer" }, { status: 409 }), freedLease: false };
    }
    if (member.role === asked) return { out: Response.json({ ok: true, member, unchanged: true }), freedLease: false };
    // A fleet that has no owner (the one it had was removed, and only viewers were left) is owned by the member a viewer is made.
    const owns = asked === "member" && !Object.values(members).some((m) => m.role === "owner");
    members[deviceId] = { ...member, role: owns ? "owner" : asked };
    await this.storage.put("members", members);
    let freedLease = false;
    if (asked === "viewer") {
      const held = await this.lease();
      if (held && held.holder === deviceId) {
        await this.storage.delete("lease");
        freedLease = true;
      }
      const claim = await this.storage.get<Claim>("claim");
      if (claim && claim.device === deviceId) await this.storage.delete("claim");
    }
    await this.audit(caller, "role-changed", deviceId, { from: member.role, to: members[deviceId]!.role, freedLease, ...(owns ? { owner: true } : {}) });
    return { out: Response.json({ ok: true, member: members[deviceId] }), freedLease };
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
    let leftSigned = false;
    let wasMember = false;
    let freedLease = false;
    await this.state.blockConcurrencyWhile(async () => {
      const members = await this.members();
      const pending = await this.joinRequests();
      // `keyChange` declines a member's request for another key, and only that: it never removes the member,
      // so a request that is gone by the time the operator answers (the member's own key came back, or it was
      // answered elsewhere) is not an eviction.
      if (body.keyChange === true) {
        if (pending[deviceId]?.keyChange && members[deviceId]) {
          delete pending[deviceId];
          await this.storage.put("pending", pending);
          await this.audit(caller, "request-declined", deviceId, { keyChange: true });
          out = Response.json({ ok: true, removed: "pending" });
        } else {
          out = Response.json({ error: "no key change waiting" }, { status: 404 });
        }
        return;
      }
      if (pending[deviceId] && !members[deviceId]) {
        delete pending[deviceId];
        await this.storage.put("pending", pending);
        await this.audit(caller, "request-declined", deviceId, { keyChange: false });
        out = Response.json({ ok: true, removed: "pending" });
        return;
      }
      // In a fleet whose roster is signed, another's removal is an entry the owner key signs (after a fence). A member
      // leaving of its own accord only gives something up, and is let go.
      const leaving = caller.kind === "device" && caller.deviceId === deviceId;
      if (members[deviceId] && !leaving && (await this.rosterSigned())) {
        out = this.signedRefusal("remove");
        return;
      }
      // Removing a member takes a request for its key with it.
      if (pending[deviceId]) {
        delete pending[deviceId];
        await this.storage.put("pending", pending);
      }
      const dropped = await this.dropMember(caller, members, deviceId, request.headers.get("x-prime-fleet") ?? "");
      out = dropped.out;
      wasMember = dropped.wasMember;
      freedLease = dropped.freedLease;
      // In a signed fleet the chain still lists the member that left: the mark is made here, so that nothing it publishes from now on
      // is taken, and its removal's sequence is read below, once what it had in flight has landed.
      if (leaving && wasMember && (await this.rosterSigned()) && (await this.exists())) {
        const fences = await this.fences();
        fences[deviceId] = { seqAt: null, at: Date.now(), left: true };
        await this.putFences(fences);
        leftSigned = true;
      }
    });
    // Told after the decision is made and stored, outside the block that made it:
    // a socket closed while the object is held shut is not let go of cleanly.
    if (freedLease) this.broadcast({ type: "lease-free" }, deviceId);
    // It is not a member any more, so it has nothing to listen for.
    if (wasMember) this.hangUp("removed", deviceId);
    if (leftSigned) await this.settleLeaverFence(deviceId, request.headers.get("x-prime-fleet") ?? "");
    return out;
  }

  /** The sequence the removal of a member that left by itself is signed with: the head once what it had in flight has landed. */
  private async settleLeaverFence(deviceId: string, fleetId: string): Promise<void> {
    await Promise.all([...(this.advancing.get(deviceId) ?? [])]);
    const head = await this.readHeadOrNull(fleetId);
    // Not read: it stays null, and `POST /remove-fence` (which reads it again) gives the sequence when the owner signs.
    if (head === null) return;
    const fences = await this.fences();
    const fence = fences[deviceId];
    if (!fence || fence.seqAt !== null) return;
    fences[deviceId] = { ...fence, seqAt: head.seq };
    await this.putFences(fences);
    await this.audit({ kind: "device", deviceId }, "member-left-fenced", deviceId, { seqAt: head.seq });
  }

  /**
   * Take a member out of the fleet (the block that holds the object shut is the caller's). Its key is a former member's key for the
   * snapshots up to `until` (the head as it is now, unless the owner's entry says); the lease it holds is given up; the fleet is
   * handed to the longest-standing member that is not a viewer when it was the owner; and the last one to go takes the fleet
   * with it.
   */
  private async dropMember(
    caller: Caller,
    members: Members,
    deviceId: string,
    fleetId: string,
    until?: number,
  ): Promise<{ out: Response; wasMember: boolean; freedLease: boolean }> {
    const member = members[deviceId];
    if (!member) return { out: Response.json({ error: "no such member" }, { status: 404 }), wasMember: false, freedLease: false };
    let freedLease = false;
    delete members[deviceId];
    // What the fleet's snapshots were when this member's key stopped being a member's: it made the
    // ones up to there, and a member that was away has still to take them in.
    if (member.pubkey) await this.recordLeft(member.pubkey, fleetId, deviceId, until);
    // A member that leaves gives up the lease, so the fleet is not held by
    // somebody who is no longer there.
    const held = await this.lease();
    if (held && held.holder === deviceId) {
      await this.storage.delete("lease");
      freedLease = true;
    }
    // Removing the owner hands the fleet to the member that has been in it
    // the longest. A fleet whose owner is gone and that nobody can take
    // over is a fleet nobody can run.
    let ownerTo: string | undefined;
    if (member.role === "owner") {
      // A viewer never runs a fleet: if only viewers are left, the fleet has no owner and the operator runs it.
      const rest = Object.values(members).filter((m) => m.role !== "viewer").sort((a, b) => a.addedAt - b.addedAt);
      if (rest.length > 0) {
        const next = rest[0]!;
        members[next.deviceId] = { ...next, role: "owner" };
        ownerTo = next.deviceId;
      }
    }
    await this.audit(caller, "member-removed", deviceId, {
      self: caller.kind === "device" && caller.deviceId === deviceId,
      wasOwner: member.role === "owner",
      freedLease,
      ...(ownerTo ? { ownerTo } : {}),
    });
    // A fleet with no members is not a fleet: it goes away with the last
    // one, rather than sitting there with nobody able to run it.
    if (Object.keys(members).length === 0) {
      await this.audit(caller, "fleet-deleted", undefined, { reason: "the last member left" });
      await this.clear(fleetId);
      return { out: Response.json({ ok: true, removed: "member", fleet: "gone" }), wasMember: true, freedLease };
    }
    await this.storage.put("members", members);
    return { out: Response.json({ ok: true, removed: "member" }), wasMember: true, freedLease };
  }

  private async revoke(caller: Caller, body: Record<string, unknown>): Promise<Response> {
    // Invalidate every outstanding invite.
    const denied = await this.requireOperatorOrOwner(caller);
    if (denied) return denied;
    const before = Object.keys((await this.storage.get<Record<string, Invite>>("invites")) ?? {}).length;
    await this.storage.put("invites", {});
    await this.audit(caller, "invites-revoked", undefined, { count: before });
    return Response.json({ ok: true, revoked: before });
  }

  private async listMembers(caller: Caller): Promise<Response> {
    const members = await this.members();
    if (caller.kind === "admin") {
      // The operator also sees how far each member says it has got (informational: only `applied` gates the lease).
      const applied = (await this.storage.get<Record<string, number>>("applied")) ?? {};
      const fetched = (await this.storage.get<Record<string, number>>("fetched")) ?? {};
      const shown = Object.values(members).map((m) => ({
        ...m,
        applied: applied[m.deviceId] ?? 0,
        ...(fetched[m.deviceId] !== undefined ? { fetched: fetched[m.deviceId] } : {}),
      }));
      return Response.json({ ok: true, members: shown, left: await this.leftKeys(), fences: await this.fencesShown(), pendingRemoves: await this.pendingRemoves() });
    }
    // The owner runs the fleet: it admits and removes members, so it needs
    // their ids in full. Any other member sees the other ids cut short:
    // knowing a member's full id is not something a member needs, and the
    // primary gets the keys it needs from the dedicated route instead.
    if (caller.kind === "device" && members[caller.deviceId]) {
      const self = members[caller.deviceId]!;
      if (self.role === "owner") return Response.json({ ok: true, members: Object.values(members), left: await this.leftKeys(), fences: await this.fencesShown(), pendingRemoves: await this.pendingRemoves() });
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
    const lease = await this.storage.get<Lease>("lease");
    if (!lease) return null;
    return lease.expiresAt > Date.now() ? lease : null;
  }

  /** The lease as it is stored, run out or not: who held it last. */
  private async leaseRow(): Promise<Lease | null> {
    return (await this.storage.get<Lease>("lease")) ?? null;
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
    const ttlMs = effectiveLeaseMs((await this.meta()).leaseMs, this.env);
    // The head decides whether this member is caught up, and the lease must not
    // be granted on a guess: a failed read refuses the bootstrap instead of
    // pretending the fleet has published nothing.
    const head = await this.readHeadOrNull(fleetId);
    if (head === null) {
      return Response.json({ error: "the fleet's head could not be read" }, { status: 503 });
    }
    const pubkey = cleanPubkey(body.pubkey);
    const spub = cleanSpub(body.spub);
    const label = cleanLabel(body.label);
    // What the member can do, as it says it now: a member that says nothing (an earlier build) has nothing, so a
    // member that went back to an earlier build is not kept as if it still could.
    const caps = cleanCaps(body.caps);
    // The roster is read, changed and written in one step: a key change and a name change are made against
    // the roster as it is when they are written (an operator's removal that commits in between is not undone
    // by a copy read before it). A key other than the one the fleet holds is not taken on the strength of the
    // device's credential (see `changeKey`): without the old key's proof it is a request for the operator, and
    // the member does not take a place until it is decided.
    let refused: Response | null = null;
    await this.state.blockConcurrencyWhile(async () => {
      const roster = await this.members();
      if (!roster[caller.deviceId]) {
        refused = this.deny();
        return;
      }
      if (pubkey) {
        const changed = await this.changeKey(caller, roster, caller.deviceId, pubkey, cleanKeyProof(body.keyProof), fleetId, spub);
        if (changed === "pending") refused = this.keyPending();
        if (changed === "full") refused = this.tooManyPending();
        if (refused) return;
      }
      // A space that is renamed, or an identity that was taken over by another space, says what it is called
      // now. The name is only for the operator to read, but it is read on every round of the agent, so a
      // stale one is corrected the next time the space takes its place. A name another member already uses is
      // not taken on: the list would then show two spaces that cannot be told apart.
      let changedRoster = false;
      if (await this.noteSpub(roster, caller.deviceId, spub)) changedRoster = true;
      if (label !== undefined && roster[caller.deviceId]!.label !== label && !findClash(roster, {}, caller.deviceId, label)) {
        roster[caller.deviceId]!.label = label;
        changedRoster = true;
      }
      // Written only when it differs: a member says its caps on every renewal, and a row is billed.
      const held = roster[caller.deviceId]!.caps ?? [];
      if (held.length !== caps.length || held.some((c, i) => c !== caps[i])) {
        if (caps.length > 0) roster[caller.deviceId]!.caps = caps;
        else delete roster[caller.deviceId]!.caps;
        changedRoster = true;
      }
      if (changedRoster) await this.storage.put("members", roster);
    });
    if (refused) return refused;

    let out: Response = Response.json({ error: "unreachable" }, { status: 500 });
    await this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      // Read again: the roster may have changed since the key and name were settled (a removal).
      const members = await this.members();
      if (!members[caller.deviceId]) {
        out = this.deny();
        return;
      }
      // A viewer reads and never writes: it is never given the lease, and takes no claim to catch up (it would hold the
      // place of a member that can publish). It is a replica that stays one; an earlier build of it asks again and is
      // told the same, as it does of any replica.
      if (members[caller.deviceId]!.role === "viewer") {
        out = Response.json({ ok: true, role: "replica", reason: "viewer", head, epoch: head.epoch, ttlMs, retryAfterMs: VIEWER_RETRY_MS });
        return;
      }
      // A member that is being removed takes no place: it is a replica until the owner's entry takes it out.
      if ((await this.fences())[caller.deviceId]) {
        out = Response.json({ ok: true, role: "replica", reason: "fenced", head, epoch: head.epoch, ttlMs, retryAfterMs: VIEWER_RETRY_MS });
        return;
      }
      const row = await this.leaseRow();
      const held = row && row.expiresAt > Date.now() ? row : null;

      if (held && held.holder !== caller.deviceId) {
        out = Response.json({
          ok: true,
          role: "replica",
          reason: "lease-held",
          holder: held.holder,
          ...(held.since !== undefined ? { holderSince: held.since } : {}),
          head,
          epoch: head.epoch,
          ttlMs,
        });
        return;
      }
      // A member that published without a seal on a fleet whose snapshots are sealed is not given the
      // lease back for a while: an upgraded member has it (see `advance`). It carries on as a replica.
      const bar = (await this.storage.get<Record<string, number>>("unsealedBar")) ?? {};
      // A build that says it seals has been upgraded since: the bar was for the build that refused.
      if (body.seals === true && bar[caller.deviceId] !== undefined) {
        delete bar[caller.deviceId];
        await this.storage.put("unsealedBar", bar);
      }
      if ((bar[caller.deviceId] ?? 0) > now) {
        out = Response.json({
          ok: true,
          role: "replica",
          reason: "upgrade-required",
          holder: held?.holder ?? null,
          head,
          epoch: head.epoch,
          ttlMs,
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
      const applied = (await this.storage.get<Record<string, number>>("applied")) ?? {};
      if (head.seq > 0 && (applied[caller.deviceId] ?? 0) < head.seq) {
        // Every replica that is behind is told the same while the lease is free,
        // and each would write its whole work tree to catch up. The first to ask
        // is given a short claim on doing so (renewed whenever it asks again):
        // the others are told to wait and ask later. The lease itself is decided
        // as ever - by who has applied the head when it asks - so a claim that
        // lapses (its holder died half way) costs the others its length at most.
        const claim = await this.storage.get<Claim>("claim");
        const live = claim !== undefined && claim.until > now && members[claim.device] !== undefined;
        const wait = (holder: string, ms: number): Response =>
          Response.json({ ok: true, role: "replica", reason: "claimed", holder, head, epoch: head.epoch, ttlMs, retryAfterMs: Math.max(1000, ms) });
        // Those waiting, in the order they asked, minus the ones that stopped coming back.
        const queue = (claim?.queue ?? []).filter((w) => w.by > now && members[w.device] !== undefined);
        // Put the caller in the queue (or keep its place) and tell it to ask again in `ms`.
        const queued = async (holder: string, ms: number): Promise<Response> => {
          const by = now + Math.max(1000, ms) + WAIT_GRACE_MS;
          const mine = queue.find((w) => w.device === caller.deviceId);
          if (!mine || mine.by !== by) {
            if (mine) mine.by = by;
            else queue.push({ device: caller.deviceId, at: now, by });
            await this.storage.put("claim", {
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
          await this.storage.put("claim", {
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
          await this.storage.put("claim", {
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
          ttlMs,
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
      // Every write below is a row that is billed, and a holder renews every fifteen seconds: what is
      // already as it should be is not written again. The epoch and the claim are read first (a row read
      // costs a thousandth of that), so a stored epoch that is not the lease's is still put right.
      const storedEpoch = await this.storage.get<number>("epoch");
      const epoch = held && held.holder === caller.deviceId ? held.epoch : Math.max(storedEpoch ?? 0, head.epoch) + 1;
      const lease: Lease = { holder: caller.deviceId, epoch, expiresAt: now + ttlMs, since: held && held.holder === caller.deviceId ? (held.since ?? now) : now };
      await this.storage.put("lease", lease);
      if (storedEpoch !== epoch) await this.storage.put("epoch", epoch);
      if ((await this.storage.get<Claim>("claim")) !== undefined) await this.storage.delete("claim");
      await this.scheduleLeaseAlarm(lease.expiresAt);
      // Only a new place is written down, never a renewal: the lease is renewed every fifteen seconds. A holder that
      // had it and let it run out takes it as a new one (a new epoch), and so does the one that takes it from a holder
      // whose time was up, or from nobody.
      if (!(held && held.holder === caller.deviceId)) {
        await this.audit(caller, "lease-taken", caller.deviceId, { epoch, ...(row ? { from: row.holder } : {}), how: row ? "expired" : "free" });
      }
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
    // The fleet's lease, whatever the caller asks for: a holder that could name its own would keep the place for
    // as long as it liked (up to five minutes it used to), and the lease is the fleet's failover clock.
    const ttlMs = effectiveLeaseMs((await this.meta()).leaseMs, this.env);
    let out: Response = Response.json({ error: "unreachable" }, { status: 500 });
    await this.state.blockConcurrencyWhile(async () => {
      const held = await this.lease();
      if (!held || held.holder !== caller.deviceId) {
        out = Response.json({ error: "not the lease holder" }, { status: 409 });
        return;
      }
      const expiresAt = Date.now() + ttlMs;
      await this.storage.put("lease", { ...held, expiresAt });
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
    await this.storage.delete("lease");
    await this.audit(caller, "lease-vacated", deviceId, { quiet: body.quiet === true });
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
    await this.storage.delete("lease");
    await this.audit(caller, "lease-released", caller.deviceId, { epoch: held.epoch });
    this.broadcast({ type: "lease-free" });
    return Response.json({ ok: true });
  }

  // Advance the head with a conditional write in R2. The condition is the fence:
  // a stale primary's expectedSeq no longer matches, so its write is refused by
  // storage rather than by a check this object could get wrong.
  private advance(caller: Caller, body: Record<string, unknown>, request: Request): Promise<Response> {
    // A publish that is running is known to the fence, which waits for it before it says where the head is.
    const running = this.advanceNow(caller, body, request);
    if (caller.kind === "device") {
      const settled = running.then(
        () => undefined,
        () => undefined,
      );
      const set = this.advancing.get(caller.deviceId) ?? new Set<Promise<void>>();
      this.advancing.set(caller.deviceId, set);
      set.add(settled);
      void settled.then(() => {
        set.delete(settled);
        if (set.size === 0 && this.advancing.get(caller.deviceId) === set) this.advancing.delete(caller.deviceId);
      });
    }
    return running;
  }

  private async advanceNow(caller: Caller, body: Record<string, unknown>, request: Request): Promise<Response> {
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
      ? body.extraKeys.filter((k): k is string => typeof k === "string" && k.startsWith(own) && /^[0-9a-f]{16,64}$/.test(k.slice(own.length))).slice(0, 2 * MAX_CHUNKS)
      : [];
    // What a member needs to choose its route (see `index`). Only numbers and a flag.
    const rawMeta = (body.meta ?? {}) as Record<string, unknown>;
    const size = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);
    const meta = {
      full: rawMeta.full === true,
      ...(rawMeta.sealed === true ? { sealed: true as const } : {}),
      ...(size(rawMeta.packBytes) !== undefined ? { packBytes: size(rawMeta.packBytes)! } : {}),
      ...(size(rawMeta.deltaBytes) !== undefined ? { deltaBytes: size(rawMeta.deltaBytes)! } : {}),
      ...(rawMeta.chunked === true ? { chunked: true as const } : {}),
    };
    if (!manifestKey || !manifestHash) return Response.json({ error: "manifest required" }, { status: 400 });

    const held = await this.lease();
    if (!held || held.holder !== caller.deviceId) return Response.json({ error: "not the lease holder" }, { status: 409 });
    // Not reachable by a viewer, which is never given the lease; refused all the same, so that a lease it held some
    // other way (a role that changed under it) cannot publish.
    if ((await this.members())[caller.deviceId]?.role === "viewer") return Response.json({ error: "a viewer does not publish" }, { status: 403 });
    // A member that is being removed (fenced) publishes nothing more: the owner signs its removal with the sequence the fence gave.
    if ((await this.fences())[caller.deviceId]) return Response.json({ error: "this member is being removed from the fleet", fenced: true }, { status: 409 });

    // A snapshot in pieces is one that only a member that reads them can open: a fleet with one that does not is refused it, so that the
    // publisher (which checks the same list) is not the only protection.
    if (meta.chunked === true) {
      const members = await this.members();
      const without = Object.values(members).filter((m) => !(m.caps ?? []).includes(CHUNKS_CAP)).map((m) => m.deviceId);
      if (without.length > 0) {
        return Response.json({ error: "a snapshot in pieces needs every member to read them, and " + without.length + " do not say they can", chunks: false, members: without.length }, { status: 409 });
      }
    }

    const key = this.headKey(fleetId);
    // A publish whose object died after it wrote the head and before it was kept is made good first.
    await this.settleStoring();
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
    const index = (await this.storage.get<IndexEntry[]>("index")) ?? [];
    const tip = index[index.length - 1];
    if (tip && tip.seq === currentHead.seq && tip.sealed === undefined && meta.sealed !== true) {
      // Written through a gateway that did not record whether it was sealed: its manifest says, once.
      this.meter.r2("read");
      const sealedTip = await this.manifestIsSealed(tip.manifestKey);
      if (sealedTip !== undefined) {
        tip.sealed = sealedTip;
        await this.storage.put("index", index);
      }
    }
    if (tip && tip.seq === currentHead.seq && tip.sealed === true && meta.sealed !== true) {
      await this.storage.delete("lease");
      const bar = (await this.storage.get<Record<string, number>>("unsealedBar")) ?? {};
      const now = Date.now();
      for (const [device, until] of Object.entries(bar)) if (until <= now) delete bar[device];
      bar[caller.deviceId] = now + UNSEALED_BAR_MS;
      await this.storage.put("unsealedBar", bar);
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
    const applied = (await this.storage.get<Record<string, number>>("applied")) ?? {};
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
    const stored = [manifestKey, packKey, ...extraKeys].filter(Boolean);
    const token = await this.startStoring({ manifestKey, keys: stored, seq: next.seq, headKey: key, meta });
    // This request is alive as long as it runs here: only an entry whose request is gone (its object died, or it threw) is settled.
    try {
      let written: R2Object | null;
      try {
        this.meter.r2("write");
        written = await this.bucket().put(key, JSON.stringify(next), etag ? { onlyIf: { etagMatches: etag } } : { onlyIf: { etagDoesNotMatch: "*" } });
      } catch {
        await this.endStoring(token);
        return Response.json({ error: "head write refused" }, { status: 409 });
      }
      // A failed conditional write returns null rather than throwing: that is the
      // CAS losing the race, not an error.
      if (!written) {
        await this.endStoring(token);
        return Response.json({ error: "head changed" }, { status: 409 });
      }
      // The write above gave other requests room to run, and one of them may have removed this member. Its
      // key is recorded as left up to the head as that request saw it, which does not have this snapshot;
      // it is a member's up to this one, which the member made while it was one.
      const rostered = await this.members();
      if (!rostered[caller.deviceId]) {
        const left = (await this.storage.get<LeftKey[]>("left")) ?? [];
        let raised = false;
        for (const k of left) {
          if (k.device === caller.deviceId && k.until < next.seq) {
            k.until = next.seq;
            raised = true;
          }
        }
        if (raised) await this.storage.put("left", left);
      }
      await this.storage.put("epoch", next.epoch);
      // The publisher holds the state it has just published: it needs no report to
      // say so. Without this a member whose own report was lost (a timeout, a 503)
      // would be refused its next publish as "catch up first", with nothing it
      // could catch up to.
      // Read again, with no other I/O between that and the write: the write to R2
      // above gave other requests (a member's report, in particular) room to run, and
      // the map read before it would put their change back as it was.
      const now_ = (await this.storage.get<Record<string, number>>("applied")) ?? {};
      now_[caller.deviceId] = Math.max(now_[caller.deviceId] ?? 0, next.seq);
      await this.storage.put("applied", now_);
      // The members that listen pull now instead of at their next look; the one that
      // published already has it.
      // A small snapshot rides in the event itself, to the listeners whose member says it takes it in (the `inline` cap) and
      // only when what is offered is what the key says it is: the others are told as they always were, and when nobody
      // else could use it nothing is hashed.
      const takers = await this.inlineListeners(caller.deviceId);
      const inline = takers.size > 0 ? await checkedInline(body.inline, manifestKey, manifestHash, fleetId, meta.full) : undefined;
      const plain = { type: "head", seq: next.seq, manifestKey };
      this.broadcastEach((id) => (inline && id !== undefined && takers.has(id) ? { ...plain, inline } : plain), caller.deviceId);

      // Keep a bounded number of snapshots: more than the newest whole tree and
      // the changes after it, which is all a member far behind needs. The old
      // ones are of no use.
      await this.keepSnapshot({ manifestKey, keys: stored, seq: next.seq, meta });
      await this.endStoring(token);
      // Who published what: the number, the manifest's hash, the epoch, and the key the member held (its snapshots
      // are signed with it). The head is already moved, so a log that cannot take this is counted, not a failed publish.
      const publisherKey = rostered[caller.deviceId]?.pubkey;
      await this.audit(caller, "published", caller.deviceId, {
        seq: next.seq,
        manifest: manifestHash,
        epoch: next.epoch,
        ...(publisherKey ? { key: await keyFingerprintLong(publisherKey) } : {}),
      });

      return Response.json({ ok: true, head: next });
    } finally {
      this.live.delete(token);
    }
  }

  // Which of these stored objects no retained snapshot names. The Worker stores a snapshot's
  // objects before the head moves, so a publish that is refused leaves them behind; it asks which
  // of the ones it wrote are not, and were never, part of a snapshot the fleet keeps (a retry of a
  // request that already succeeded writes the same bytes: those are the head's) and deletes them.
  // Only this fleet's own packs and manifests are answered for.
  private async unreferenced(caller: Caller, body: Record<string, unknown>, request: Request): Promise<Response> {
    const gateway = caller.kind === "admin";
    if (!gateway) {
      if (caller.kind !== "device") return this.deny();
      const members = await this.members();
      if (!members[caller.deviceId]) return this.deny();
    }
    const fleetId = request.headers.get("x-prime-fleet") ?? "";
    const own = new RegExp("^fleets/" + fleetId.replace(/[^a-z0-9-]/g, "") + "/(packs|manifests)/[0-9a-f]{64}$");
    // A member asks about what it has just stored; the gateway's sweep asks about a whole fleet's worth.
    const asked = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === "string" && own.test(k)).slice(0, gateway ? SWEEP_ASK_MAX : 2 * MAX_CHUNKS + 8) : [];
    if (gateway && !(await this.exists())) return Response.json({ exists: false, keys: [] });
    const recent = (await this.storage.get<string[]>("recent")) ?? [];
    const kept = new Set([...recent.flatMap((entry) => entry.split("\n")), ...(await this.storingKeys())]);
    if (gateway) {
      // What was uploaded and not yet named by a snapshot is kept for a day (a snapshot in pieces is uploaded over hours). A member
      // asking about what its own refused publish stored is not held to this: it is the one that uploaded them.
      for (const key of Object.keys(await this.uploads())) kept.add(key);
      // What the head names is kept whatever this object remembers: the head is in the bucket, and losing the
      // object's own record of it must not make the snapshot everyone is on look like an orphan. When it cannot
      // be read the answer is an error, so that nothing is deleted on a guess.
      try {
        for (const key of await this.headKeys(fleetId)) kept.add(key);
      } catch {
        return Response.json({ error: "the head could not be read" }, { status: 503 });
      }
    }
    return Response.json({ ...(gateway ? { exists: true } : {}), keys: asked.filter((k) => !kept.has(k)) });
  }

  // The objects the head of the fleet needs: its manifest, the pack that manifest names, and the change pack
  // it carries. Empty when the fleet has no head yet. Throws when the bucket cannot say.
  private async headKeys(fleetId: string): Promise<string[]> {
    this.meter.r2("read");
    const headObject = await this.bucket().get(this.headKey(fleetId));
    if (!headObject) return [];
    const head = (await headObject.json()) as Partial<Head>;
    if (typeof head.manifestKey !== "string" || head.manifestKey === "") return [];
    const keys = [head.manifestKey];
    this.meter.r2("read");
    const manifestObject = await this.bucket().get(head.manifestKey);
    if (!manifestObject) return keys;
    const manifest = (await manifestObject.json()) as { packKey?: unknown; chunks?: unknown; delta?: { packKey?: unknown; chunks?: unknown } };
    if (typeof manifest.packKey === "string") keys.push(manifest.packKey);
    if (typeof manifest.delta?.packKey === "string") keys.push(manifest.delta.packKey);
    // The pieces of a snapshot in pieces: the manifest lists them by hash.
    const pieceKeys = (list: unknown): string[] =>
      Array.isArray(list) ? list.flatMap((c) => (typeof (c as { hash?: unknown })?.hash === "string" && /^[0-9a-f]{64}$/.test((c as { hash: string }).hash) ? ["fleets/" + fleetId + "/packs/" + (c as { hash: string }).hash] : [])) : [];
    keys.push(...pieceKeys(manifest.chunks), ...pieceKeys(manifest.delta?.chunks));
    return keys;
  }

  // The packs the publisher has uploaded and no snapshot names yet, by key, with when: the pieces of a snapshot that is being
  // uploaded. The sweep leaves them for UPLOAD_KEEP_MS. Pruned as it is read.
  private async uploads(): Promise<Record<string, number>> {
    const held = (await this.storage.get<Record<string, number>>("uploads")) ?? {};
    const now = Date.now();
    return Object.fromEntries(Object.entries(held).filter(([, at]) => typeof at === "number" && now - at < UPLOAD_KEEP_MS));
  }

  /** The lease holder says it has put a pack in the bucket. */
  private async uploaded(caller: Caller, body: Record<string, unknown>, request: Request): Promise<Response> {
    if (caller.kind !== "device") return this.deny();
    const held = await this.lease();
    if (!held || held.holder !== caller.deviceId) return this.deny();
    const fleetId = request.headers.get("x-prime-fleet") ?? "";
    const key = typeof body.key === "string" ? body.key : "";
    if (!new RegExp("^fleets/" + fleetId.replace(/[^a-z0-9-]/g, "") + "/packs/[0-9a-f]{64}$").test(key)) return Response.json({ error: "not a pack of this fleet" }, { status: 400 });
    const now = Date.now();
    const uploads = await this.uploads();
    uploads[key] = now;
    const newest = Object.entries(uploads).sort((a, b) => b[1] - a[1]).slice(0, UPLOADS_KEPT);
    await this.storage.put("uploads", Object.fromEntries(newest));
    return Response.json({ ok: true });
  }

  // The join requests waiting for the operator. Read tolerantly: an earlier build kept the keys of a
  // publish in flight under this same name, so what is stored may be a list of keys, or have such
  // entries among the requests, and only what has the shape of a request is one.
  private async joinRequests(): Promise<Record<string, PendingRequest>> {
    const stored = await this.storage.get<unknown>("pending");
    const out: Record<string, PendingRequest> = {};
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return out;
    for (const [device, value] of Object.entries(stored as Record<string, unknown>)) {
      const r = value as Partial<PendingRequest> | null;
      if (r && typeof r === "object" && typeof r.deviceId === "string" && r.deviceId === device && typeof r.requestedAt === "number") out[device] = r as PendingRequest;
    }
    return out;
  }

  // What publishes in flight are storing, so that `unreferenced` does not offer it for deletion between
  // the head being written and the snapshot being kept. One entry for each request, by a token of its own
  // (an identical request sent again has the same manifest, and must not release the first's), each let go
  // by the request that made it. An entry whose request died is settled by `settleStoring`.
  private async startStoring(entry: Omit<Storing, "at">): Promise<string> {
    const token = crypto.randomUUID();
    const storing = (await this.storage.get<Record<string, Storing>>("storing")) ?? {};
    storing[token] = { ...entry, at: Date.now() };
    const oldest = Object.keys(storing).sort((a, b) => storing[a]!.at - storing[b]!.at);
    for (const k of oldest.slice(0, Math.max(0, oldest.length - STORING_MAX_ENTRIES))) delete storing[k];
    await this.storage.put("storing", storing);
    this.live.add(token);
    return token;
  }

  private async endStoring(token: string): Promise<void> {
    const storing = (await this.storage.get<Record<string, Storing>>("storing")) ?? {};
    if (!(token in storing)) return;
    delete storing[token];
    if (Object.keys(storing).length === 0) await this.storage.delete("storing");
    else await this.storage.put("storing", storing);
  }

  private async storingKeys(): Promise<string[]> {
    const storing = (await this.storage.get<Record<string, Storing>>("storing")) ?? {};
    return Object.values(storing).flatMap((v) => v.keys);
  }

  // Keep a snapshot the head names: its objects in `recent` (with the oldest let go beyond the number kept) and
  // its entry in the index. Safe to do twice for the same snapshot, which a request that died part way and the
  // settling after it both do.
  private async keepSnapshot(snap: { manifestKey: string; keys: string[]; seq: number; meta: Record<string, unknown> }): Promise<void> {
    const recent = (await this.storage.get<string[]>("recent")) ?? [];
    const already = recent.some((entry) => entry.split("\n")[0] === snap.manifestKey);
    let evicted: string[] = [];
    if (!already) {
      recent.push(snap.keys.join("\n"));
      evicted = recent.splice(0, Math.max(0, recent.length - RECENT_SNAPSHOTS));
      await this.storage.put("recent", recent);
    }
    const kept = (await this.storage.get<IndexEntry[]>("index")) ?? [];
    if (!kept.some((e) => e.manifestKey === snap.manifestKey)) {
      kept.push({ seq: snap.seq, manifestKey: snap.manifestKey, ...snap.meta, sealed: snap.meta.sealed === true } as IndexEntry);
      await this.storage.put("index", kept.slice(-RECENT_SNAPSHOTS));
    }
    for (const entry of evicted) {
      for (const key of entry.split("\n")) {
        if (!key) continue;
        try {
          await this.bucket().delete(key);
        } catch {}
      }
    }
  }

  // Publishes that were storing a while ago and never said they were done: their object died between writing
  // the head and keeping the snapshot. When the head is the snapshot they were storing, it is kept now, so that
  // the objects the head names are always among the ones kept; when it is not, the write did not happen and the
  // entry is let go. An entry whose head cannot be read stays for the next time.
  private async settleStoring(): Promise<void> {
    const storing = (await this.storage.get<Record<string, Storing>>("storing")) ?? {};
    const now = Date.now();
    // Not a request this object is still running: a slow head write is not a dead one, whatever its age.
    const stale = Object.entries(storing).filter(([token, v]) => now - v.at > STORING_GRACE_MS && !this.live.has(token));
    if (stale.length === 0) return;
    const heads = new Map<string, string | undefined | null>();
    for (const [token, entry] of stale) {
      if (!heads.has(entry.headKey)) {
        try {
          this.meter.r2("read");
          const obj = await this.bucket().get(entry.headKey);
          heads.set(entry.headKey, obj ? ((await obj.json()) as Head).manifestKey : undefined);
        } catch {
          heads.set(entry.headKey, null);
        }
      }
      const named = heads.get(entry.headKey);
      if (named === null) continue;
      if (named === entry.manifestKey) await this.keepSnapshot(entry);
      await this.endStoring(token);
    }
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
  private async recordLeft(pubkey: string, fleetId: string, device: string, until?: number): Promise<void> {
    const index = (await this.storage.get<IndexEntry[]>("index")) ?? [];
    // The index is pushed after the head is written (see `advance`), so the head can be ahead of it. In a fleet whose roster is
    // signed the owner names the sequence, and the gateway does not move it.
    const tip = until ?? Math.max(index.length > 0 ? index[index.length - 1]!.seq : 0, (await this.readHead(fleetId)).seq);
    const left = ((await this.storage.get<LeftKey[]>("left")) ?? []).filter((k) => k.pubkey !== pubkey && k.until >= tip - 2 * RECENT_SNAPSHOTS);
    left.push({ pubkey, until: tip, device });
    await this.storage.put("left", left.slice(-LEFT_KEYS_KEPT));
  }

  private async leftKeys(): Promise<{ pubkey: string; until: number }[]> {
    return ((await this.storage.get<LeftKey[]>("left")) ?? []).map(({ pubkey, until }) => ({ pubkey, until }));
  }

  // ---- the signed roster ----
  //
  // A fleet can be put under a chain of entries the owner key signs (see fleet-roster.ts). From the genesis on the object is in
  // "signed" mode: a member is admitted, its key replaced, its role changed and its removal made by an entry, and the plain routes
  // that did those (approve, another's removal, a key changed on the old key's proof) are refused with 409 and `rosterSigned`. The
  // members check the chain themselves; the object checks it too so that what it keeps is a chain they will take, and it applies
  // each entry to the member list the older members read.

  private signedMemo?: boolean;
  private fenceMemo?: Record<string, Fence>;
  /** Publishes that are running, by the device that makes them: a fence waits for them to land. */
  private readonly advancing = new Map<string, Set<Promise<void>>>();

  private async rosterSigned(): Promise<boolean> {
    if (this.signedMemo === undefined) this.signedMemo = (await this.storage.get<boolean>("rosterMode")) === true;
    return this.signedMemo;
  }

  private signedRefusal(what: "approve" | "remove"): Response {
    return Response.json(
      {
        error: "this fleet's roster is signed: " + (what === "approve" ? "admitting a member, replacing its key or changing its role" : "removing a member") + " is an entry the owner key signs",
        rosterSigned: true,
        hint:
          what === "approve"
            ? "prime fleets approve <fleet> --member <id> --key <fingerprint> --signing-key <fingerprint>, on the machine that holds the owner key (a release that signs rosters)"
            : "prime fleets remove <fleet> --member <id>, on the machine that holds the owner key (a release that signs rosters)",
      },
      { status: 409 },
    );
  }

  /**
   * What the object keeps of the fleets it fenced: a member fenced for removal publishes nothing more. A fence lapses
   * `FENCE_TTL_MS` after it was made if no removal was signed under it, and the lapse is written to the audit log. (A member
   * that left of its own accord is fenced too, for its removal's sequence; it is no longer a member, so there is nothing for its
   * fence to hold and it does not lapse: the chain says it is waiting for the owner's `remove`.)
   */
  private async fences(): Promise<Record<string, Fence>> {
    if (this.fenceMemo === undefined) this.fenceMemo = (await this.storage.get<Record<string, Fence>>("fence")) ?? {};
    const lapsed = Object.entries(this.fenceMemo).filter(([, f]) => f.left !== true && Date.now() - f.at >= FENCE_TTL_MS);
    if (lapsed.length > 0) {
      const kept = { ...this.fenceMemo };
      for (const [device, fence] of lapsed) {
        delete kept[device];
        try {
          await this.auditLog().append({ actor: { kind: "gateway" }, action: "remove-fence-lapsed", target: device, detail: { seqAt: fence.seqAt ?? -1, hours: Math.round((Date.now() - fence.at) / 3_600_000) } });
        } catch (e) {
          this.auditFailures++;
          console.error("audit: could not record remove-fence-lapsed: " + String(e));
        }
      }
      await this.putFences(kept);
    }
    return this.fenceMemo;
  }

  /** The fences a member of the fleet is held by (not the ones of members that left), as the operator and the owner see them. */
  private async fencesShown(): Promise<Array<{ deviceId: string; seqAt: number | null; at: number; lapsesAt: number }>> {
    return Object.entries(await this.fences())
      .filter(([, f]) => f.left !== true)
      .map(([deviceId, f]) => ({ deviceId, seqAt: f.seqAt, at: f.at, lapsesAt: f.at + FENCE_TTL_MS }));
  }

  /**
   * The members the chain lists and the fleet no longer has (they left, or the gateway dropped them): their removal waits for the
   * owner's signature, and `seqAt` is the sequence to sign it with (null while the head could not be read at the time).
   */
  private async pendingRemoves(): Promise<Array<{ deviceId: string; seqAt: number | null; left: true; at?: number }>> {
    if (!(await this.rosterSigned())) return [];
    const entries = (await this.storage.get<SignedEntry[]>("roster")) ?? [];
    // The genesis names the fleet it was made for (it was checked against this one when it was stored).
    const state = entries.length === 0 ? null : await foldTrusted(entries, String(entries[0]!.entry[1]), await this.incarnation()).catch(() => null);
    if (!state) return [];
    const members = await this.members();
    const fences = await this.fences();
    return [...state.live.keys()]
      .filter((d) => !members[d])
      .map((deviceId) => ({ deviceId, seqAt: fences[deviceId]?.seqAt ?? null, left: true as const, ...(fences[deviceId] ? { at: fences[deviceId]!.at } : {}) }));
  }

  private async putFences(fences: Record<string, Fence>): Promise<void> {
    this.fenceMemo = fences;
    if (Object.keys(fences).length === 0) await this.storage.delete("fence");
    else await this.storage.put("fence", fences);
  }

  /** A member's signing key, as it says it: kept when the roster is the object's own, and never changed once it is signed. */
  private async noteSpub(members: Members, deviceId: string, spub: string | undefined): Promise<boolean> {
    const member = members[deviceId];
    if (!spub || !member || member.spub === spub) return false;
    if (await this.rosterSigned()) return false;
    member.spub = spub;
    return true;
  }

  private async rosterGet(caller: Caller, url: URL): Promise<Response> {
    if (caller.kind !== "admin" && !(await this.members())[caller.deviceId]) return this.deny();
    const entries = (await this.storage.get<SignedEntry[]>("roster")) ?? [];
    const afterAsked = url.searchParams.get("after");
    const after = afterAsked !== null && Number.isSafeInteger(Number(afterAsked)) ? Number(afterAsked) : -1;
    const incarnation = await this.incarnation();
    if (entries.length === 0) return Response.json({ ok: true, mode: "open", incarnation, entries: [] });
    return Response.json({
      ok: true,
      mode: "signed",
      // The members the chain lists that the fleet no longer has: their removal waits for the owner's signature, at that `seqAt`.
      pendingRemoves: await this.pendingRemoves(),
      incarnation,
      fleetKey: await fleetKeyOf(entries[0]!.entry),
      head: { n: entries.length - 1, hash: await entryHash(entries[entries.length - 1]!) },
      entries: entries.filter((e) => (e.entry[3] as number) > after),
    });
  }

  private async rosterPost(caller: Caller, body: Record<string, unknown>, request: Request): Promise<Response> {
    let signed: SignedEntry;
    try {
      signed = parseSigned(body);
    } catch (error) {
      return Response.json({ error: error instanceof RosterRefusal ? error.message : "malformed entry" }, { status: 400 });
    }
    const op = signed.entry[6];
    // A member changes the signing key it holds its own place with; everything else is the owner key's, sent by the operator or
    // by the owner device.
    const self = op === "rotate-self" && caller.kind === "device" && caller.deviceId === signed.entry[7];
    if (!self) {
      const denied = await this.requireOperatorOrOwner(caller);
      if (denied) return denied;
    }
    const fleetId = request.headers.get("x-prime-fleet") ?? "";
    let result: { out: Response; freed?: string; left?: string } = { out: Response.json({ error: "unreachable" }, { status: 500 }) };
    await this.state.blockConcurrencyWhile(async () => {
      try {
        result = await this.rosterApply(caller, signed, fleetId);
      } catch (error) {
        if (error instanceof RosterRefusal) result = { out: Response.json({ error: error.message }, { status: error.status }) };
        else throw error;
      }
    });
    if (result.freed) this.broadcast({ type: "lease-free" }, result.freed);
    if (result.left) this.hangUp("removed", result.left);
    return result.out;
  }

  /** Check an entry against the chain and the fleet, apply what it says to the members, and keep it. */
  private async rosterApply(caller: Caller, signed: SignedEntry, fleetId: string): Promise<{ out: Response; freed?: string; left?: string }> {
    const entries = (await this.storage.get<SignedEntry[]>("roster")) ?? [];
    const incarnation = await this.incarnation();
    const e = signed.entry;
    const op = e[6] as string;

    if (entries.length === 0) {
      // The genesis roots the chain in a key: it is the operator's to put, not that of a member that happens to be the owner, which a
      // compromised one could use to make itself the root of trust for good. (Every entry after it is the owner key's.)
      if (caller.kind !== "admin") {
        return { out: Response.json({ error: "the first entry of the roster is the operator's to post (prime fleets roster init, with the operator's credential), not a device's" }, { status: 403 }) };
      }
      if (!(await this.exists())) return { out: Response.json({ error: "no such fleet" }, { status: 404 }) };
      const state = await begin(signed, fleetId, incarnation);
      await this.storage.put("roster", [signed]);
      await this.storage.put("rosterMode", true);
      this.signedMemo = true;
      await this.audit(caller, "roster-genesis", undefined, { owner: String(e[12]).slice(0, 12) });
      return { out: Response.json({ ok: true, n: 0, hash: state.head.hash, fleetKey: await fleetKeyOf(e) }) };
    }
    if (entries.length >= ROSTER_MAX_ENTRIES) throw new RosterRefusal("the roster has " + ROSTER_MAX_ENTRIES + " entries, which is as long as it may be: put the fleet under a new genesis", 409);
    const state = await foldTrusted(entries, fleetId, incarnation);
    if (!state) throw new RosterRefusal("the roster could not be read", 500);
    // The same entry again (a retry after the answer was lost) is the answer it had.
    const known = entries[e[3] as number];
    if (known && known.sig === signed.sig && JSON.stringify(known.entry) === JSON.stringify(e)) {
      return { out: Response.json({ ok: true, n: e[3], hash: await entryHash(known), again: true }) };
    }
    const next = await extend(state, signed);

    let effect: { freed?: string; left?: string } = {};
    let headSeq = 0;
    const needsHead = op === "add" || op === "rotate" || op === "rotate-self" || op === "role";
    if (needsHead) {
      const head = await this.readHeadOrNull(fleetId);
      if (head === null) throw new RosterRefusal("the fleet's head could not be read", 503);
      headSeq = head.seq;
      if ((e[11] as number) > head.seq) throw new RosterRefusal("the entry takes effect from snapshot " + String(e[11]) + ", and the head is at " + head.seq, 409);
    }
    switch (op) {
      case "add":
        await this.rosterAdd(caller, signed, headSeq);
        break;
      case "rotate":
        await this.rosterRotate(caller, signed, fleetId);
        break;
      case "rotate-self":
        await this.rosterRotateSelf(signed);
        break;
      case "role":
        effect = await this.rosterRole(caller, signed);
        break;
      case "remove": {
        const removed = await this.rosterRemove(caller, signed, fleetId);
        effect = removed.effect;
        // The last member to go takes the fleet, and the chain with it.
        if (removed.gone) return { out: Response.json({ ok: true, n: e[3], fleet: "gone" }), ...effect };
        break;
      }
      default:
        break;
    }
    entries.push(signed);
    await this.storage.put("roster", entries);
    await this.audit(caller, "roster-entry", typeof e[7] === "string" ? e[7] : undefined, { op, n: e[3] as number, ...(typeof e[11] === "number" ? { seqAt: e[11] } : {}) });
    return { out: Response.json({ ok: true, n: e[3], hash: next.head.hash }), ...effect };
  }

  private async rosterAdd(caller: Caller, signed: SignedEntry, headSeq: number): Promise<void> {
    const e = signed.entry;
    const device = e[7] as string;
    const xpub = e[8] as string;
    const spub = e[9] as string;
    const role = e[10] as "owner" | "member" | "viewer";
    const members = await this.members();
    const have = members[device];
    if (have) {
      // A member the fleet has already (the roster is put over the fleet as it is, or this is a retry): the entry must say what
      // the fleet holds, so that signing it changes nothing it did not show.
      if (have.pubkey !== xpub || have.spub !== spub || have.role !== role) {
        throw new RosterRefusal("the entry does not say what the fleet holds of " + device + " (its key, signing key or role differ)", 409);
      }
      return;
    }
    const pending = await this.joinRequests();
    const request = pending[device];
    if (!request || request.keyChange) throw new RosterRefusal("no request from " + device + " is waiting", 409);
    // A member that is new takes effect from the head on: an earlier sequence would make its key a valid sender for snapshots
    // that were made before it was admitted. (A low one is for a member that was in the fleet before the roster, above.)
    if ((signed.entry[11] as number) < headSeq) throw new RosterRefusal("an add for a new member takes effect from the head or later: the head is at " + headSeq + ", and the entry says " + String(signed.entry[11]) + " (sign it again at the head)", 409);
    if (request.pubkey !== xpub || request.spub !== spub) throw new RosterRefusal("the entry is for another key than the request of " + device + " offers (it was replaced since)", 409);
    if (Object.keys(members).length >= MAX_MEMBERS) throw new RosterRefusal("fleet is full", 409);
    const owned = Object.values(members).some((m) => m.role === "owner");
    if (role === "owner" && owned) throw new RosterRefusal("the fleet has an owner already", 409);
    delete pending[device];
    const member: Member = {
      deviceId: device,
      // A fleet left with only viewers is owned by the next member that is not one.
      role: role === "owner" || (role === "member" && !owned) ? "owner" : role,
      addedAt: Date.now(),
      addedBy: caller.deviceId || "operator",
      pubkey: xpub,
      spub,
      ...(request.label ? { label: request.label } : {}),
    };
    members[device] = member;
    await this.storage.put("members", members);
    await this.storage.put("pending", pending);
    await this.audit(caller, "member-admitted", device, { role: member.role, via: "roster", key: await keyFingerprintLong(xpub) });
  }

  private async rosterRotate(caller: Caller, signed: SignedEntry, fleetId: string): Promise<void> {
    const e = signed.entry;
    const device = e[7] as string;
    const xpub = e[8] as string;
    const spub = e[9] as string;
    const members = await this.members();
    const member = members[device];
    if (!member) throw new RosterRefusal(device + " is not a member", 409);
    const pending = await this.joinRequests();
    const request = pending[device];
    if (member.pubkey === xpub && member.spub === spub && !request) return;
    if (!request?.keyChange || request.pubkey !== xpub || request.spub !== spub) {
      throw new RosterRefusal("no request from " + device + " for this key and signing key is waiting", 409);
    }
    delete pending[device];
    await this.replaceKey(members, device, xpub, fleetId, caller, "roster", { spub, until: e[11] as number });
    await this.storage.put("pending", pending);
  }

  private async rosterRotateSelf(signed: SignedEntry): Promise<void> {
    const e = signed.entry;
    const device = e[7] as string;
    const members = await this.members();
    const member = members[device];
    if (!member) throw new RosterRefusal(device + " is not a member", 409);
    if (e[8] !== null && e[8] !== member.pubkey) throw new RosterRefusal("a rotate-self does not change the key snapshots are sealed for", 409);
    if (member.spub === e[9]) return;
    member.spub = e[9] as string;
    await this.storage.put("members", members);
  }

  private async rosterRole(caller: Caller, signed: SignedEntry): Promise<{ freed?: string }> {
    const e = signed.entry;
    const device = e[7] as string;
    const role = e[10];
    if (role !== "member" && role !== "viewer") throw new RosterRefusal("a role entry makes a member or a viewer", 409);
    if (!(await this.members())[device]) throw new RosterRefusal(device + " is not a member", 409);
    const changed = await this.changeRole(caller, device, role);
    if (changed.out.status >= 400) throw new RosterRefusal(((await changed.out.clone().json().catch(() => ({}))) as { error?: string }).error ?? "the role was not changed", changed.out.status);
    return changed.freedLease ? { freed: device } : {};
  }

  private async rosterRemove(
    caller: Caller,
    signed: SignedEntry,
    fleetId: string,
  ): Promise<{ effect: { freed?: string; left?: string }; gone: boolean }> {
    const e = signed.entry;
    const device = e[7] as string;
    const fences = await this.fences();
    const fence = fences[device];
    // The sequence of a removal is the one thing in it that has an effect, so it is the one the fence gave: the object took
    // nothing more from the member from then on, and no publish of its can be above it.
    if (!fence || fence.seqAt === null) throw new RosterRefusal("fence " + device + " first (POST /remove-fence): the removal is signed with the sequence the fence says", 409);
    if (fence.seqAt !== e[11]) throw new RosterRefusal("the entry removes " + device + " as of snapshot " + String(e[11]) + ", and the fence says " + fence.seqAt, 409);
    const members = await this.members();
    let effect: { freed?: string; left?: string } = {};
    let gone = false;
    if (members[device]) {
      const dropped = await this.dropMember(caller, members, device, fleetId, fence.seqAt);
      effect = { ...(dropped.freedLease ? { freed: device } : {}), ...(dropped.wasMember ? { left: device } : {}) };
      gone = !(await this.exists());
    }
    if (gone) return { effect, gone };
    delete fences[device];
    await this.putFences(fences);
    const pending = await this.joinRequests();
    if (pending[device]) {
      delete pending[device];
      await this.storage.put("pending", pending);
    }
    return { effect, gone };
  }

  /**
   * Fence a member for removal: from now on it is given no lease, takes no claim and publishes nothing; the lease it holds is
   * given up; and what it had in flight is waited for. The answer is the sequence of the head after that, which is the last it
   * can have published at, and what the owner signs the removal with. Run again it answers a sequence that may be later (other
   * members publish) and is still above anything the member made. `lift` ends the fence (a removal that was given up).
   */
  private async removeFence(caller: Caller, body: Record<string, unknown>, request: Request): Promise<Response> {
    const denied = await this.requireOperatorOrOwner(caller);
    if (denied) return denied;
    if (!(await this.rosterSigned())) return Response.json({ error: "this fleet's roster is not signed, so there is nothing to fence a removal for" }, { status: 409 });
    const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
    const fleetId = request.headers.get("x-prime-fleet") ?? "";
    const members = await this.members();
    const entries = (await this.storage.get<SignedEntry[]>("roster")) ?? [];
    const state = await foldTrusted(entries, fleetId, await this.incarnation());
    if (!members[deviceId] && !state?.live.has(deviceId)) return Response.json({ error: "no such member" }, { status: 404 });
    const fences = await this.fences();
    if (body.lift === true) {
      delete fences[deviceId];
      await this.putFences(fences);
      await this.audit(caller, "remove-fence-lifted", deviceId);
      return Response.json({ ok: true, lifted: true });
    }
    // First the mark, so that a publish that starts from here on is refused, and what runs now is waited for.
    fences[deviceId] = { seqAt: fences[deviceId]?.seqAt ?? null, at: Date.now(), ...(fences[deviceId]?.left ? { left: true as const } : {}) };
    await this.putFences(fences);
    let freed = false;
    const held = await this.lease();
    if (held && held.holder === deviceId) {
      await this.storage.delete("lease");
      freed = true;
    }
    const claim = await this.storage.get<Claim>("claim");
    if (claim && claim.device === deviceId) await this.storage.delete("claim");
    if (freed) this.broadcast({ type: "lease-free" }, deviceId);
    await Promise.all([...(this.advancing.get(deviceId) ?? [])]);
    const head = await this.readHeadOrNull(fleetId);
    if (head === null) return Response.json({ error: "the fleet's head could not be read", fenced: true }, { status: 503 });
    fences[deviceId] = { seqAt: head.seq, at: Date.now(), ...(fences[deviceId]?.left ? { left: true as const } : {}) };
    await this.putFences(fences);
    await this.audit(caller, "member-fenced", deviceId, { seqAt: head.seq, freedLease: freed });
    return Response.json({ ok: true, fenced: deviceId, seqAt: head.seq });
  }

  // ---- a member's key ----
  //
  // The roster's key is what every later snapshot is sealed for, so whoever can change it can read what
  // the fleet publishes next. A device's credential (which a 6-character code can be, and which a space
  // keeps in its environment) is not enough for that: a key other than the one the fleet holds is taken
  // only on one of two proofs.
  //
  //   - the member shows it holds the old key. The object has an X25519 key pair of its own (made when
  //     first asked, kept in its storage, gone with the fleet); the member sends
  //     HMAC(HKDF(DH(oldPrivate, objectPublic)), the new key, the fleet, the device, a time and a nonce),
  //     and the object checks it with DH(objectPrivate, oldPublic). Only the holder of the old private
  //     key (or of the object's) can make it, and it is no use for any other key, fleet, device or time.
  //   - the operator or the owner approves it, as it approves a join: the request waits in `pending`.

  private proofKeyMemo?: Promise<{ publicKey: string; privateKey: CryptoKey } | null>;

  /** The object's own key pair for key-change proofs, made on first use; null where the runtime cannot make one. */
  private proofKey(): Promise<{ publicKey: string; privateKey: CryptoKey } | null> {
    if (this.proofKeyMemo) return this.proofKeyMemo;
    const made: Promise<{ publicKey: string; privateKey: CryptoKey } | null> = (async () => {
      try {
        // "X25519" is a WebCrypto algorithm in the Workers runtime and in Bun; the lib types predate it.
        const algo = { name: "X25519" } as never;
        const stored = await this.storage.get<{ publicKey: string; privateKey: string }>("proofKey");
        const b64 = (b: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(b)));
        const raw = (t: string): ArrayBuffer => Uint8Array.from(atob(t), (c) => c.charCodeAt(0)).buffer as ArrayBuffer;
        if (stored) {
          const privateKey = await crypto.subtle.importKey("pkcs8", raw(stored.privateKey), algo, false, ["deriveBits"]);
          return { publicKey: stored.publicKey, privateKey };
        }
        const pair = (await crypto.subtle.generateKey(algo, true, ["deriveBits"])) as CryptoKeyPair;
        const publicKey = b64(await crypto.subtle.exportKey("raw", pair.publicKey));
        await this.storage.put("proofKey", { publicKey, privateKey: b64(await crypto.subtle.exportKey("pkcs8", pair.privateKey)) });
        return { publicKey, privateKey: pair.privateKey };
      } catch {
        return null;
      }
    })();
    this.proofKeyMemo = made;
    // A failure is not kept: the next ask tries again (a key pair that could not be made or stored is not one a member was told of).
    void made.then((k) => {
      if (k === null && this.proofKeyMemo === made) this.proofKeyMemo = undefined;
    });
    return made;
  }

  /** Whether `proof` shows that its sender holds the private half of `oldPubkey` and means `newPubkey` for this device. */
  private async keyProofHolds(oldPubkey: string, newPubkey: string, fleetId: string, deviceId: string, proof: KeyProof): Promise<boolean> {
    try {
      const now = Date.now();
      if (Math.abs(now - proof.ts) > KEY_PROOF_WINDOW_MS) return false;
      const seen = (await this.storage.get<Record<string, number>>("proofNonces")) ?? {};
      for (const [n, at] of Object.entries(seen)) if (now - at > 2 * KEY_PROOF_WINDOW_MS) delete seen[n];
      if (seen[proof.nonce] !== undefined) return false;
      const mine = await this.proofKey();
      if (!mine) return false;
      const unb64 = (t: string): ArrayBuffer => Uint8Array.from(atob(t.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)).buffer as ArrayBuffer;
      const algo = { name: "X25519" } as never;
      const peer = await crypto.subtle.importKey("raw", unb64(oldPubkey), algo, false, []);
      const shared = await crypto.subtle.deriveBits({ name: "X25519", public: peer } as never, mine.privateKey, 256);
      const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
      const macKey = await crypto.subtle.importKey(
        "raw",
        await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new ArrayBuffer(32), info: new TextEncoder().encode(KEY_PROOF_INFO) }, hkdf, 256),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      const ok = await crypto.subtle.verify("HMAC", macKey, unb64(proof.mac), new TextEncoder().encode(keyChangeMessage(newPubkey, fleetId, deviceId, proof.ts, proof.nonce)));
      if (!ok) return false;
      seen[proof.nonce] = now;
      await this.storage.put("proofNonces", seen);
      return true;
    } catch {
      return false;
    }
  }

  /** Put a member's key in its place. The old key made snapshots a replica may not have taken in yet: it is a member's key up to there. */
  private async replaceKey(
    members: Members,
    deviceId: string,
    pubkey: string,
    fleetId: string,
    caller: Caller,
    via: "approved" | "proof" | "roster",
    opts: { spub?: string; until?: number } = {},
  ): Promise<void> {
    const member = members[deviceId]!;
    const was = member.pubkey;
    if (member.pubkey) await this.recordLeft(member.pubkey, fleetId, deviceId, opts.until);
    member.pubkey = pubkey;
    if (opts.spub) member.spub = opts.spub;
    await this.storage.put("members", members);
    await this.audit(caller, "key-replaced", deviceId, { via, key: await keyFingerprintLong(pubkey), ...(was ? { was: await keyFingerprintLong(was) } : {}) });
  }

  /**
   * What a member that says its key is `pubkey` gets of it.
   *
   * "same": it is the key the fleet holds (nothing to do). "changed": the old key's proof held, and the
   * key is replaced. "pending": it could not prove it, and the fleet has no old key to ask it for (a
   * member without one) or the proof was missing, stale or wrong: the key waits as a request for the
   * operator or the owner to approve, and the roster is as it was.
   */
  private async changeKey(caller: Caller, members: Members, deviceId: string, pubkey: string, proof: KeyProof | undefined, fleetId: string, spub?: string): Promise<"same" | "changed" | "pending" | "full"> {
    const member = members[deviceId]!;
    const pending = await this.joinRequests();
    if (member.pubkey === pubkey) {
      // It is back to the key the fleet holds: a request for another one is moot.
      if (pending[deviceId]?.keyChange) {
        delete pending[deviceId];
        await this.storage.put("pending", pending);
      }
      return "same";
    }
    // A fleet whose roster is signed changes a key only by an entry the owner key signs: the old key's proof is not enough.
    if (member.pubkey && proof && !(await this.rosterSigned()) && (await this.keyProofHolds(member.pubkey, pubkey, fleetId, deviceId, proof))) {
      await this.replaceKey(members, deviceId, pubkey, fleetId, caller, "proof", { spub });
      if (pending[deviceId]?.keyChange) {
        delete pending[deviceId];
        await this.storage.put("pending", pending);
      }
      return "changed";
    }
    if (pending[deviceId]?.pubkey !== pubkey || (spub !== undefined && pending[deviceId]?.spub !== spub)) {
      // Not recorded, and the member is told so rather than that it waits: nobody would ever see the request.
      if (!pending[deviceId] && Object.keys(pending).length >= MAX_PENDING) return "full";
      pending[deviceId] = {
        deviceId,
        ...(member.label ? { label: member.label } : {}),
        pubkey,
        ...(spub ? { spub } : {}),
        requestedAt: Date.now(),
        keyChange: true,
      };
      await this.storage.put("pending", pending);
      await this.audit(caller, "key-requested", deviceId, { key: await keyFingerprintLong(pubkey) });
    }
    return "pending";
  }

  /** The answer to a member whose key request could not be kept: the list of requests is full. */
  private tooManyPending(): Response {
    return Response.json({ error: "too many pending requests", hint: "the operator has requests to answer first" }, { status: 429, headers: { "retry-after": "60" } });
  }

  /** The answer to a member whose key is not the fleet's: its request waits, and what it does is says so. */
  private keyPending(): Response {
    return Response.json(
      {
        error: "this member's key is not the one the fleet holds, and it could not show that it holds the old one: the new key waits for the operator (or the fleet's owner) to approve it",
        keyChange: "pending",
        retryAfterMs: PAUSED_RETRY_MS,
      },
      { status: 409, headers: { "retry-after": String(Math.ceil(PAUSED_RETRY_MS / 1000)) } },
    );
  }

  // Which fleet this is, as opposed to another that was made under the same name after this one was
  // deleted. A snapshot of the earlier one is sealed and signed all the same, and its key files
  // are still on the members' disks: the members bind it into what they seal and check, so a
  // replayed snapshot of an earlier fleet does not pass for one of this. Made when first asked
  // (a fleet that predates it gets one then), and gone with the fleet.
  private async incarnation(): Promise<string> {
    const known = await this.storage.get<string>("incarnation");
    if (known) return known;
    const made = crypto.randomUUID();
    await this.storage.put("incarnation", made);
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
    const fence = (await this.fences())[caller.deviceId];
    return Response.json({
      member: true,
      primary: held !== null && held.holder === caller.deviceId,
      epoch: held ? held.epoch : 0,
      role: member.role,
      incarnation: await this.incarnation(),
      // Whether the members of this fleet are what an owner-signed chain says (`GET /roster`), or what the gateway says.
      rosterSigned: await this.rosterSigned(),
      // What every member of the fleet can do, and the lease the fleet runs on (the heartbeat follows it).
      fleetCaps: commonCaps(Object.values(members).map((m) => m.caps)),
      leaseMs: effectiveLeaseMs((await this.meta()).leaseMs, this.env),
      // This object does not move the head from a sealed snapshot to one that is not (see `advance`).
      sealGate: true,
      // The member is fenced for removal (it publishes nothing and takes no lease), until the fence lapses if no removal comes.
      ...(fence ? { fenced: true, fenceLapsesAt: fence.at + FENCE_TTL_MS } : {}),
      // The most one upload may be: a member says so before it sends what the gateway would refuse.
      snapshotLimit: MAX_SNAPSHOT_BYTES,
      // A snapshot too big for that is published in pieces (see `CHUNK_BYTES`): the most one piece may be, and the most the whole may be.
      chunkLimit: CHUNK_BYTES,
      chunkedLimit: MAX_CHUNKED_SNAPSHOT_BYTES,
      // The key a member proves that it holds its old key with, when it changes its own (see `changeKey`).
      ...((await this.proofKey()) ? { keyProofKey: (await this.proofKey())!.publicKey } : {}),
    });
  }

  private async me(caller: Caller): Promise<Response> {
    if (caller.kind !== "device") return this.deny();
    const members = await this.members();
    const member = members[caller.deviceId];
    const pending = await this.joinRequests();
    if (member) return Response.json({ ok: true, status: "member", member, ...(pending[caller.deviceId]?.keyChange ? { keyChange: "pending" } : {}) });
    if (pending[caller.deviceId]) return Response.json({ ok: true, status: "pending" });
    return Response.json({ ok: true, status: "none" });
  }
}