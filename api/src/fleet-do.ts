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
  clampTtl,
  hashCode,
  inviteShape,
  MAX_MEMBERS,
  MAX_PENDING,
  newInviteCode,
} from "./fleets";
import type { Env } from "./config";

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
}

const EMPTY_HEAD: Head = { seq: 0, manifestKey: "", manifestHash: "", epoch: 0 };

export class FleetDO implements DurableObject {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

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
    try {
      const obj = await this.bucket().get(this.headKey(fleetId));
      if (!obj) return { ...EMPTY_HEAD };
      return (await obj.json()) as Head;
    } catch {
      return { ...EMPTY_HEAD };
    }
  }

  private async members(): Promise<Members> {
    return (await this.state.storage.get<Members>("members")) ?? {};
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};

    // The Worker has already proved the caller; these headers are internal.
    const kind = request.headers.get("x-prime-caller") === "admin" ? "admin" : "device";
    const deviceId = request.headers.get("x-prime-device") ?? "";
    const caller: Caller = { kind, deviceId };

    if (path === "/create" && request.method === "POST") return this.create(caller);
    if (path === "/invite" && request.method === "POST") return this.invite(caller, body);
    if (path === "/join" && request.method === "POST") return this.join(caller, body);
    if (path === "/approve" && request.method === "POST") return this.approve(caller, body);
    if (path === "/remove" && request.method === "POST") return this.remove(caller, body);
    if (path === "/revoke" && request.method === "POST") return this.revoke(caller, body);
    if (path === "/members" && request.method === "GET") return this.listMembers(caller);
    if (path === "/pending" && request.method === "GET") return this.listPending(caller);
    if (path === "/me" && request.method === "GET") return this.me(caller);
    if (path === "/bootstrap" && request.method === "POST") return this.bootstrap(caller, request);
    if (path === "/lease/renew" && request.method === "POST") return this.renew(caller, body);
    if (path === "/lease/release" && request.method === "POST") return this.release(caller);
    if (path === "/head/advance" && request.method === "POST") return this.advance(caller, body, request);

    return Response.json({ error: "not found" }, { status: 404 });
  }

  private deny(): Response {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  private async requireAdmin(caller: Caller): Promise<Response | null> {
    if (caller.kind !== "admin") return this.deny();
    return null;
  }

  private async create(caller: Caller): Promise<Response> {
    const denied = await this.requireAdmin(caller);
    if (denied) return denied;
    if (!caller.deviceId) return Response.json({ error: "device required" }, { status: 400 });

    let out: Response = Response.json({ error: "unreachable" }, { status: 500 });
    await this.state.blockConcurrencyWhile(async () => {
      const existing = await this.members();
      if (Object.keys(existing).length > 0) {
        out = Response.json({ error: "fleet already exists" }, { status: 409 });
        return;
      }
      const owner: Member = { deviceId: caller.deviceId, role: "owner", addedAt: Date.now(), addedBy: caller.deviceId };
      await this.state.storage.put("members", { [caller.deviceId]: owner });
      out = Response.json({ ok: true, member: owner });
    });
    return out;
  }

  private async invite(caller: Caller, body: Record<string, unknown>): Promise<Response> {
    const denied = await this.requireAdmin(caller);
    if (denied) return denied;

    const ttlMs = clampTtl(typeof body.ttlMs === "number" ? body.ttlMs : undefined);
    const autoApprove = body.autoApprove === true;
    const code = newInviteCode();
    const codeHash = await hashCode(code);

    let out: Response = Response.json({ error: "unreachable" }, { status: 500 });
    await this.state.blockConcurrencyWhile(async () => {
      const members = await this.members();
      if (Object.keys(members).length === 0) {
        out = Response.json({ error: "fleet does not exist" }, { status: 404 });
        return;
      }
      const now = Date.now();
      const invites = (await this.state.storage.get<Record<string, Invite>>("invites")) ?? {};
      // Drop expired invites while we are here, so storage does not accumulate.
      for (const [hash, inv] of Object.entries(invites)) if (inv.expiresAt <= now) delete invites[hash];
      const invite: Invite = { codeHash, expiresAt: now + ttlMs, autoApprove, createdBy: caller.deviceId, createdAt: now };
      invites[codeHash] = invite;
      await this.state.storage.put("invites", invites);
      out = Response.json({ ok: true, code, expiresAt: invite.expiresAt, autoApprove });
    });
    return out;
  }

  private async join(caller: Caller, body: Record<string, unknown>): Promise<Response> {
    if (caller.kind !== "device") return this.deny();
    const code = typeof body.code === "string" ? body.code : "";
    if (!inviteShape(code)) return Response.json({ error: "invalid invite code" }, { status: 400 });
    const label = cleanLabel(body.label);
    const codeHash = await hashCode(code);

    let out: Response = Response.json({ error: "unreachable" }, { status: 500 });
    await this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const members = await this.members();
      const invites = (await this.state.storage.get<Record<string, Invite>>("invites")) ?? {};

      const existing = members[caller.deviceId];
      if (existing) {
        // Idempotent re-join: already a member is not an error.
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

      if (invite.autoApprove) {
        const member: Member = { deviceId: caller.deviceId, role: "member", addedAt: now, addedBy: invite.createdBy };
        members[caller.deviceId] = member;
        await this.state.storage.put("members", members);
        out = Response.json({ ok: true, status: "member", member });
        return;
      }

      const pending = (await this.state.storage.get<Record<string, PendingRequest>>("pending")) ?? {};
      if (!pending[caller.deviceId] && Object.keys(pending).length >= MAX_PENDING) {
        out = Response.json({ error: "too many pending requests" }, { status: 429 });
        return;
      }
      pending[caller.deviceId] = { deviceId: caller.deviceId, ...(label ? { label } : {}), requestedAt: now };
      await this.state.storage.put("pending", pending);
      out = Response.json({ ok: true, status: "pending", requestedAt: now });
    });
    return out;
  }

  private async approve(caller: Caller, body: Record<string, unknown>): Promise<Response> {
    const denied = await this.requireAdmin(caller);
    if (denied) return denied;
    const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";

    let out: Response = Response.json({ error: "unreachable" }, { status: 500 });
    await this.state.blockConcurrencyWhile(async () => {
      const pending = (await this.state.storage.get<Record<string, PendingRequest>>("pending")) ?? {};
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
      const member: Member = { deviceId, role: "member", addedAt: Date.now(), addedBy: caller.deviceId };
      members[deviceId] = member;
      await this.state.storage.put("members", members);
      await this.state.storage.put("pending", pending);
      out = Response.json({ ok: true, member });
    });
    return out;
  }

  private async remove(caller: Caller, body: Record<string, unknown>): Promise<Response> {
    const denied = await this.requireAdmin(caller);
    if (denied) return denied;
    const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";

    let out: Response = Response.json({ error: "unreachable" }, { status: 500 });
    await this.state.blockConcurrencyWhile(async () => {
      const members = await this.members();
      const pending = (await this.state.storage.get<Record<string, PendingRequest>>("pending")) ?? {};
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
      // The owner cannot remove itself; that would leave the fleet unowned and
      // nobody able to mint invites or approve members.
      if (member.role === "owner") {
        out = Response.json({ error: "cannot remove the fleet owner" }, { status: 409 });
        return;
      }
      delete members[deviceId];
      await this.state.storage.put("members", members);
      out = Response.json({ ok: true, removed: "member" });
    });
    return out;
  }

  private async revoke(caller: Caller, body: Record<string, unknown>): Promise<Response> {
    // Invalidate every outstanding invite.
    const denied = await this.requireAdmin(caller);
    if (denied) return denied;
    const before = Object.keys((await this.state.storage.get<Record<string, Invite>>("invites")) ?? {}).length;
    await this.state.storage.put("invites", {});
    return Response.json({ ok: true, revoked: before });
  }

  private async listMembers(caller: Caller): Promise<Response> {
    const members = await this.members();
    if (caller.kind === "admin") return Response.json({ ok: true, members: Object.values(members) });
    // A device may see the roster only if it is in it.
    if (!members[caller.deviceId]) return this.deny();
    const redacted = Object.values(members).map((m) => ({
      deviceId: m.deviceId === caller.deviceId ? m.deviceId : m.deviceId.slice(0, 6) + "\u2026",
      role: m.role,
      addedAt: m.addedAt,
    }));
    return Response.json({ ok: true, members: redacted });
  }

  private async listPending(caller: Caller): Promise<Response> {
    const denied = await this.requireAdmin(caller);
    if (denied) return denied;
    const pending = (await this.state.storage.get<Record<string, PendingRequest>>("pending")) ?? {};
    return Response.json({ ok: true, pending: Object.values(pending) });
  }

  private async lease(): Promise<Lease | null> {
    const lease = await this.state.storage.get<Lease>("lease");
    if (!lease) return null;
    return lease.expiresAt > Date.now() ? lease : null;
  }

  // One atomic decision, so two spaces created at the same moment cannot both
  // conclude that they are the first. Only storage reads inside the lock.
  private async bootstrap(caller: Caller, request: Request): Promise<Response> {
    if (caller.kind !== "device") return this.deny();
    const fleetId = request.headers.get("x-prime-fleet") ?? "";
    const ttlMs = 15_000;
    const head = await this.readHead(fleetId);
    const members = await this.members();
    if (!members[caller.deviceId]) return this.deny();

    let out: Response = Response.json({ error: "unreachable" }, { status: 500 });
    await this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const held = await this.lease();

      if (held && held.holder !== caller.deviceId) {
        out = Response.json({ ok: true, role: "replica", reason: "lease-held", head, epoch: head.epoch });
        return;
      }
      if (head.seq > 0 && !held) {
        // State exists and nobody holds the lease: a replica first, promoted
        // only after it has caught up. Promotion is a separate, explicit step.
        out = Response.json({ ok: true, role: "replica", reason: "head-exists", head, epoch: head.epoch });
        return;
      }
      const epoch = head.epoch + 1;
      const lease: Lease = { holder: caller.deviceId, epoch, expiresAt: now + ttlMs };
      await this.state.storage.put("lease", lease);
      await this.state.storage.put("epoch", epoch);
      out = Response.json({ ok: true, role: "primary", epoch, head, ttlMs });
    });
    return out;
  }

  private async renew(caller: Caller, body: Record<string, unknown>): Promise<Response> {
    if (caller.kind !== "device") return this.deny();
    const ttlMs = typeof body.ttlMs === "number" && body.ttlMs > 0 ? Math.min(body.ttlMs, 300_000) : 15_000;
    let out: Response = Response.json({ error: "unreachable" }, { status: 500 });
    await this.state.blockConcurrencyWhile(async () => {
      const held = await this.lease();
      if (!held || held.holder !== caller.deviceId) {
        out = Response.json({ error: "not the lease holder" }, { status: 409 });
        return;
      }
      await this.state.storage.put("lease", { ...held, expiresAt: Date.now() + ttlMs });
      out = Response.json({ ok: true, epoch: held.epoch });
    });
    return out;
  }

  private async release(caller: Caller): Promise<Response> {
    if (caller.kind !== "device") return this.deny();
    const held = await this.lease();
    if (!held || held.holder !== caller.deviceId) return Response.json({ error: "not the lease holder" }, { status: 409 });
    await this.state.storage.delete("lease");
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
    if (!manifestKey || !manifestHash) return Response.json({ error: "manifest required" }, { status: 400 });

    const held = await this.lease();
    if (!held || held.holder !== caller.deviceId) return Response.json({ error: "not the lease holder" }, { status: 409 });

    const key = this.headKey(fleetId);
    const current = await this.bucket().get(key);
    const etag = current?.etag;
    const currentHead = current ? ((await current.json()) as Head) : { ...EMPTY_HEAD };
    if (currentHead.seq !== expectedSeq) {
      return Response.json({ error: "stale sequence", current: currentHead.seq }, { status: 409 });
    }
    const next: Head = { seq: currentHead.seq + 1, manifestKey, manifestHash, epoch: held.epoch };
    let written: R2Object | null;
    try {
      written = await this.bucket().put(key, JSON.stringify(next), etag ? { onlyIf: { etagMatches: etag } } : { onlyIf: { etagDoesNotMatch: "*" } });
    } catch {
      return Response.json({ error: "head write refused" }, { status: 409 });
    }
    // A failed conditional write returns null rather than throwing: that is the
    // CAS losing the race, not an error.
    if (!written) return Response.json({ error: "head changed" }, { status: 409 });
    await this.state.storage.put("epoch", next.epoch);
    return Response.json({ ok: true, head: next });
  }

  private async me(caller: Caller): Promise<Response> {
    if (caller.kind !== "device") return this.deny();
    const members = await this.members();
    const member = members[caller.deviceId];
    if (member) return Response.json({ ok: true, status: "member", member });
    const pending = (await this.state.storage.get<Record<string, PendingRequest>>("pending")) ?? {};
    if (pending[caller.deviceId]) return Response.json({ ok: true, status: "pending" });
    return Response.json({ ok: true, status: "none" });
  }
}