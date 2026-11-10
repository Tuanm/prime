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
  OWNER_SILENCE_MS,
  RECENT_SNAPSHOTS,
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

  // Forget everything about this fleet.
  private async clear(fleetId: string): Promise<void> {
    await this.state.storage.delete("members");
    await this.state.storage.delete("invites");
    await this.state.storage.delete("pending");
    await this.state.storage.delete("lease");
    await this.state.storage.delete("epoch");
    await this.state.storage.delete("applied");
    await this.state.storage.delete("ownerSeenAt");
    try {
      await this.bucket().delete(this.headKey(fleetId));
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
    return Response.json({ members: Object.keys(members), lastActivity });
  }

  //
  // Who holds the lease, for a client that wants to talk to the fleet.
  //
  // A client that is not a member learns nothing: it is told that there is
  // no primary, not who it is.
  private async primary(caller: Caller): Promise<Response> {
    if (caller.kind !== "device") return this.deny();
    const members = await this.members();
    if (!members[caller.deviceId]) return Response.json({ member: false, primary: null });
    const held = await this.lease();
    return Response.json({
      member: true,
      primary: held ? held.holder : null,
      epoch: held ? held.epoch : 0,
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
    return Response.json({
      members: Object.values(members).map((m) => ({
        deviceId: m.deviceId,
        ...(m.pubkey ? { pubkey: m.pubkey } : {}),
        // How far this member has got, so the publisher knows who needs a
        // whole tree rather than a delta.
        applied: applied[m.deviceId] ?? 0,
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
    return Response.json({ ok: true, applied: applied[caller.deviceId] ?? 0 });
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

    if (path === "/create" && request.method === "POST") return this.create(caller, body);
    if (path === "/invite" && request.method === "POST") return this.invite(caller, body);
    if (path === "/invite-check" && request.method === "POST") return this.inviteCheck(body);
    if (path === "/join" && request.method === "POST") {
      await this.touch();
      return this.join(caller, body);
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
    if (path === "/applied" && request.method === "POST") {
      await this.touch();
      return this.applied(caller, body);
    }
    if (path === "/delete" && request.method === "POST") return this.delete(caller, request);
    if (path === "/keys" && request.method === "GET") return this.keys(caller);

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

  private async create(caller: Caller, body: Record<string, unknown>): Promise<Response> {
    // Both the operator and a proven device may create a fleet: the first
    // member of a fleet is usually a space, and it has to be able to bring
    // the fleet into being. Admission of everyone else still takes an invite
    // and an approval.
    if (!caller.deviceId) return Response.json({ error: "device required" }, { status: 400 });

    let out: Response = Response.json({ error: "unreachable" }, { status: 500 });
    await this.state.blockConcurrencyWhile(async () => {
      const existing = await this.members();
      if (Object.keys(existing).length > 0) {
        out = Response.json({ error: "fleet already exists" }, { status: 409 });
        return;
      }
      // How many fleets a device may create is counted in the registry
      // object, which every device shares: a counter kept here would be
      // fresh for every new fleet and so would never count anything.
      const pubkey = cleanPubkey(body.pubkey);
      const owner: Member = {
        deviceId: caller.deviceId,
        role: "owner",
        addedAt: Date.now(),
        addedBy: caller.deviceId,
        ...(pubkey ? { pubkey } : {}),
      };
      await this.state.storage.put("members", { [caller.deviceId]: owner });
      out = Response.json({ ok: true, member: owner });
    });
    return out;
  }

  private async invite(caller: Caller, body: Record<string, unknown>): Promise<Response> {
    const denied = await this.requireOperatorOrOwner(caller);
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
    return Response.json({ ok: true, autoApprove: invite.autoApprove, expiresAt: invite.expiresAt });
  }

  private async join(caller: Caller, body: Record<string, unknown>): Promise<Response> {
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

      if (invite.autoApprove) {
        const member: Member = {
          deviceId: caller.deviceId,
          role: "member",
          addedAt: now,
          addedBy: invite.createdBy,
          ...(pubkey ? { pubkey } : {}),
        };
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
      const member: Member = {
        deviceId,
        role: "member",
        addedAt: Date.now(),
        addedBy: caller.deviceId,
        ...(request.pubkey ? { pubkey: request.pubkey } : {}),
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
      delete members[deviceId];
      // A member that leaves gives up the lease, so the fleet is not held by
      // somebody who is no longer there.
      const held = await this.lease();
      if (held && held.holder === deviceId) {
        await this.state.storage.delete("lease");
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
    if (caller.kind === "admin") return Response.json({ ok: true, members: Object.values(members) });
    // The owner runs the fleet: it admits and removes members, so it needs
    // their ids in full. Any other member sees the other ids cut short:
    // knowing a member's full id is not something a member needs, and the
    // primary gets the keys it needs from the dedicated route instead.
    if (caller.kind === "device" && members[caller.deviceId]) {
      const self = members[caller.deviceId]!;
      if (self.role === "owner") return Response.json({ ok: true, members: Object.values(members) });
      const redacted = Object.values(members).map((m) =>
        m.deviceId === self.deviceId ? m : { ...m, deviceId: m.deviceId.slice(0, 8) + "…" },
      );
      return Response.json({ ok: true, members: redacted });
    }
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
    const denied = await this.requireOperatorOrOwner(caller);
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
  private async bootstrap(caller: Caller, request: Request, body: Record<string, unknown>): Promise<Response> {
    if (caller.kind !== "device") return this.deny();
    const fleetId = request.headers.get("x-prime-fleet") ?? "";
    // The lease is short-lived on purpose: a member that stops speaking
    // releases the fleet to the others without anyone having to notice.
    const ttlMs = 60_000;
    const head = await this.readHead(fleetId);
    const members = await this.members();
    if (!members[caller.deviceId]) return this.deny();

    // A member that comes back with a new key takes the new key: it is
    // proving itself, and the snapshots sealed for the old key are of no use
    // to it.
    const pubkey = cleanPubkey(body.pubkey);
    if (pubkey && members[caller.deviceId]!.pubkey !== pubkey) {
      members[caller.deviceId]!.pubkey = pubkey;
      await this.state.storage.put("members", members);
    }

    let out: Response = Response.json({ error: "unreachable" }, { status: 500 });
    await this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const held = await this.lease();

      if (held && held.holder !== caller.deviceId) {
        out = Response.json({ ok: true, role: "replica", reason: "lease-held", head, epoch: head.epoch });
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
      const epoch = head.epoch + 1;
      const lease: Lease = { holder: caller.deviceId, epoch, expiresAt: now + ttlMs };
      await this.state.storage.put("lease", lease);
      await this.state.storage.put("epoch", epoch);
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
    const packKey = typeof body.packKey === "string" ? body.packKey : "";
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

    // Keep a bounded number of snapshots. A member that falls further behind
    // than this is given a whole tree again, so the old ones are of no use.
    const recent = (await this.state.storage.get<string[]>("recent")) ?? [];
    recent.push(manifestKey + (packKey ? "\n" + packKey : ""));
    const evicted = recent.splice(0, Math.max(0, recent.length - RECENT_SNAPSHOTS));
    await this.state.storage.put("recent", recent);
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
    });
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