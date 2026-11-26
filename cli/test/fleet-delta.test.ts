import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { FULL_PACK_WINDOW, loadOrCreateKeyPair, publish, pull, type MemberPaths } from "../src/fleet-agent";
import { type FleetCredentials } from "../src/fleet-transport";

/**
 * A gateway that stores bytes and never reads them.
 *
 * It behaves like the real one in the ways that matter: the head only moves
 * when the expected sequence matches, a payload can only be written by the
 * primary, and a member may only publish once it has caught up.
 */
class FakeGateway {
  payloads = new Map<string, Buffer>();
  head: { seq: number; manifestKey: string; manifestHash: string; epoch: number } | null = null;
  members = new Map<string, { deviceId: string; role: string; pubkey?: string }>();
  applied = new Map<string, number>();
  primary = "";
  /** How many snapshots are kept; older packs and manifests are deleted, as the real gateway does. */
  retain = Infinity;
  /** Pack downloads, by the pack's key. */
  packReads: string[] = [];
  private kept: string[][] = [];

  seed(deviceId: string, pubkey: string): void {
    this.members.set(deviceId, { deviceId, role: "member", pubkey });
    if (!this.primary) this.primary = deviceId;
  }

  async handle(creds: FleetCredentials, method: string, path: string, body?: Buffer | string): Promise<Response> {
    const parts = path.split("/").filter(Boolean);
    const kind = parts[2];
    if (kind === "head" && method === "GET") {
      if (!this.head) return new Response("{}", { status: 404 });
      return Response.json({ head: this.head });
    }
    if (kind === "role" && method === "GET") {
      return Response.json({ member: this.members.has(creds.deviceId), primary: creds.deviceId === this.primary, epoch: 1 });
    }
    if (kind === "members" && method === "GET") {
      return Response.json({ members: [...this.members.values()] });
    }
    if (kind === "keys" && method === "GET") {
      if (creds.deviceId !== this.primary) return Response.json({ error: "not the primary" }, { status: 409 });
      return Response.json({ members: [...this.members.values()].map((m) => ({ deviceId: m.deviceId, pubkey: m.pubkey, applied: this.applied.get(m.deviceId) ?? 0 })) });
    }
    if (kind === "applied" && method === "POST") {
      const parsed = JSON.parse(String(body ?? "{}")) as { seq: number };
      this.applied.set(creds.deviceId, Math.max(this.applied.get(creds.deviceId) ?? 0, parsed.seq ?? 0));
      return Response.json({ ok: true, applied: this.applied.get(creds.deviceId) });
    }
    if (kind === "snapshot" && method === "POST") {
      if (creds.deviceId !== this.primary) return Response.json({ error: "not the primary" }, { status: 409 });
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""));
      const manifestLength = bytes.readUInt32BE(0);
      const manifestBytes = bytes.subarray(4, 4 + manifestLength);
      const pack = bytes.subarray(4 + manifestLength);
      const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
      const packKey = "fleets/x/packs/" + hash(pack);
      const manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
      manifest.packKey = packKey;
      manifest.packHash = hash(pack);
      const finalManifest = Buffer.from(JSON.stringify(manifest), "utf8");
      const manifestKey = "fleets/x/manifests/" + hash(finalManifest);
      this.payloads.set(packKey, pack);
      this.payloads.set(manifestKey, finalManifest);
      this.kept.push([packKey, manifestKey]);
      while (this.kept.length > this.retain) for (const key of this.kept.shift()!) this.payloads.delete(key);
      const current = this.head?.seq ?? 0;
      if ((this.applied.get(creds.deviceId) ?? 0) < current) {
        return Response.json({ error: "catch up first", required: current }, { status: 409 });
      }
      const seq = typeof manifest.seq === "number" ? manifest.seq : current + 1;
      this.head = { seq, manifestKey, manifestHash: hash(finalManifest), epoch: 1 };
      return Response.json({ ok: true, seq, manifestKey });
    }
    if ((kind === "packs" || kind === "manifests") && method === "POST") {
      if (creds.deviceId !== this.primary) return Response.json({ error: "not the primary" }, { status: 409 });
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""));
      const hash = createHash("sha256").update(bytes).digest("hex");
      const key = "fleets/x/" + kind + "/" + hash;
      this.payloads.set(key, bytes);
      return Response.json({ ok: true, key, hash, size: bytes.length });
    }
    if ((kind === "packs" || kind === "manifests") && method === "GET") {
      const id = parts[3] ?? "";
      const found = [...this.payloads.entries()].find(([k]) => k.endsWith("/" + id));
      if (!found) return Response.json({ error: "no such payload" }, { status: 404 });
      if (kind === "packs") this.packReads.push(found[0]);
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

function credsFor(deviceId: string): FleetCredentials {
  return { gateway: "http://fake", deviceId, deviceToken: "token", timeoutMs: 5000 };
}

function useFakeGateway(gateway: FakeGateway): void {
  const original = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = (async (url: string, init: { method: string; headers: Record<string, string>; body?: Buffer | string }) => {
    const path = new URL(url).pathname;
    const deviceId = init.headers["x-prime-device"] ?? "";
    return gateway.handle(credsFor(deviceId), init.method, path, init.body);
  }) as unknown as typeof fetch;
  (globalThis as { __restoreFetch?: () => void }).__restoreFetch = () => {
    (globalThis as { fetch: unknown }).fetch = original;
  };
}

/** Every file under a directory, with its contents hashed. */
function fingerprint(dir: string): Map<string, string> {
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

function sameTree(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

describe("incremental snapshots", () => {
  test("a change travels as a delta, and the replica still ends up with the same tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-delta-"));
    const gateway = new FakeGateway();
    try {
      const primaryWork = join(root, "primary");
      const replicaWork = join(root, "replica");
      mkdirSync(primaryWork, { recursive: true });
      mkdirSync(replicaWork, { recursive: true });
      for (let i = 0; i < 40; i++) writeFileSync(join(primaryWork, "file-" + i + ".txt"), "content ".repeat(50) + i);

      const primaryPaths: MemberPaths = { work: primaryWork, gitDir: join(root, "p-meta"), keyFile: join(root, "p.key") };
      const replicaPaths: MemberPaths = { work: replicaWork, gitDir: join(root, "r-meta"), keyFile: join(root, "r.key") };

      useFakeGateway(gateway);
      const { loadOrCreateKeyPair } = await import("../src/fleet-agent");
      const keys = loadOrCreateKeyPair(primaryPaths.keyFile);
      gateway.seed("primary-device", keys.publicKey);
      const replicaKeys = loadOrCreateKeyPair(replicaPaths.keyFile);
      gateway.seed("replica-device", replicaKeys.publicKey);

      // The first snapshot has no base, so it carries the whole tree.
      const first = await publish(credsFor("primary-device"), "x", primaryPaths, null, 0, 2);
      expect(first.seq).toBe(1);
      const firstBytes = first.bytes;

      // The replica catches up with the whole tree.
      const pulled = await pull(credsFor("replica-device"), "x", replicaPaths, 0);
      expect(pulled.applied).toBe(true);
      expect(sameTree(fingerprint(primaryWork), fingerprint(replicaWork))).toBe(true);

      // A small change, published on top of the first snapshot.
      writeFileSync(join(primaryWork, "file-0.txt"), "changed content ".repeat(50));
      const second = await publish(credsFor("primary-device"), "x", primaryPaths, first.commit, first.seq, 2);
      expect(second.seq).toBe(2);
      expect(second.bytes).toBeLessThan(firstBytes);

      // The replica applies the delta and still matches.
      const pulled2 = await pull(credsFor("replica-device"), "x", replicaPaths, 1);
      expect(pulled2.applied).toBe(true);
      expect(pulled2.seq).toBe(2);
      expect(sameTree(fingerprint(primaryWork), fingerprint(replicaWork))).toBe(true);
    } finally {
      (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a member that joins later is given a whole tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-delta-"));
    const gateway = new FakeGateway();
    try {
      const primaryWork = join(root, "primary");
      const replicaWork = join(root, "replica");
      mkdirSync(primaryWork, { recursive: true });
      mkdirSync(replicaWork, { recursive: true });
      writeFileSync(join(primaryWork, "a.txt"), "alpha".repeat(100));

      const primaryPaths: MemberPaths = { work: primaryWork, gitDir: join(root, "p-meta"), keyFile: join(root, "p.key") };
      const replicaPaths: MemberPaths = { work: replicaWork, gitDir: join(root, "r-meta"), keyFile: join(root, "r.key") };

      useFakeGateway(gateway);
      const { loadOrCreateKeyPair } = await import("../src/fleet-agent");
      const keys = loadOrCreateKeyPair(primaryPaths.keyFile);
      gateway.seed("primary-device", keys.publicKey);

      const first = await publish(credsFor("primary-device"), "x", primaryPaths, null, 0, 1);
      expect(first.seq).toBe(1);

      // A second member joins: the membership changed, so the next publish
      // carries the whole tree again.
      const replicaKeys = loadOrCreateKeyPair(replicaPaths.keyFile);
      gateway.seed("replica-device", replicaKeys.publicKey);
      writeFileSync(join(primaryWork, "a.txt"), "alpha changed".repeat(100));
      const second = await publish(credsFor("primary-device"), "x", primaryPaths, first.commit, first.seq, 1);
      expect(second.seq).toBe(2);

      // The new member applies the whole tree and matches.
      const pulled = await pull(credsFor("replica-device"), "x", replicaPaths, 0);
      expect(pulled.applied).toBe(true);
      expect(sameTree(fingerprint(primaryWork), fingerprint(replicaWork))).toBe(true);
    } finally {
      (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a member several snapshots behind is caught up over the chain", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-delta-"));
    const gateway = new FakeGateway();
    try {
      const primaryWork = join(root, "primary");
      const replicaWork = join(root, "replica");
      mkdirSync(primaryWork, { recursive: true });
      mkdirSync(replicaWork, { recursive: true });
      writeFileSync(join(primaryWork, "a.txt"), "one".repeat(100));

      const primaryPaths: MemberPaths = { work: primaryWork, gitDir: join(root, "p-meta"), keyFile: join(root, "p.key") };
      const replicaPaths: MemberPaths = { work: replicaWork, gitDir: join(root, "r-meta"), keyFile: join(root, "r.key") };

      useFakeGateway(gateway);
      const { loadOrCreateKeyPair } = await import("../src/fleet-agent");
      const keys = loadOrCreateKeyPair(primaryPaths.keyFile);
      gateway.seed("primary-device", keys.publicKey);
      const replicaKeys = loadOrCreateKeyPair(replicaPaths.keyFile);
      gateway.seed("replica-device", replicaKeys.publicKey);

      // The replica takes the first snapshot.
      const first = await publish(credsFor("primary-device"), "x", primaryPaths, null, 0, 2);
      await pull(credsFor("replica-device"), "x", replicaPaths, 0);

      // Three more snapshots are published while the replica is away.
      let base = first.commit;
      let baseSeq = first.seq;
            for (let i = 0; i < 3; i++) {
        writeFileSync(join(primaryWork, "a.txt"), "step " + i + " ".repeat(100));
        const next = await publish(credsFor("primary-device"), "x", primaryPaths, base, baseSeq, 2);
        base = next.commit;
        baseSeq = next.seq;
      }

      // The replica catches up over the chain, and the tree matches.
      const pulled = await pull(credsFor("replica-device"), "x", replicaPaths, 1);
      expect(pulled.applied).toBe(true);
      expect(pulled.seq).toBe(4);
      expect(sameTree(fingerprint(primaryWork), fingerprint(replicaWork))).toBe(true);
    } finally {
      (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a member far behind does not turn every publish into a whole tree, and still catches up", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-delta-"));
    const gateway = new FakeGateway();
    try {
      const primaryWork = join(root, "primary");
      const replicaWork = join(root, "replica");
      mkdirSync(primaryWork, { recursive: true });
      mkdirSync(replicaWork, { recursive: true });
      for (let i = 0; i < 20; i++) writeFileSync(join(primaryWork, "file-" + i + ".txt"), "content ".repeat(100) + i);
      writeFileSync(join(primaryWork, "doomed.txt"), "will be deleted");

      const primaryPaths: MemberPaths = { work: primaryWork, gitDir: join(root, "p-meta"), keyFile: join(root, "p.key") };
      const replicaPaths: MemberPaths = { work: replicaWork, gitDir: join(root, "r-meta"), keyFile: join(root, "r.key") };

      useFakeGateway(gateway);
      gateway.seed("primary-device", loadOrCreateKeyPair(primaryPaths.keyFile).publicKey);
      gateway.seed("replica-device", loadOrCreateKeyPair(replicaPaths.keyFile).publicKey);
      // Fewer snapshots are kept than were published: the replica's own is long gone.
      gateway.retain = FULL_PACK_WINDOW + 2;

      let last = await publish(credsFor("primary-device"), "x", primaryPaths, null, 0, 2);
      const first = last;
      const firstPull = await pull(credsFor("replica-device"), "x", replicaPaths, 0);
      expect(firstPull.applied).toBe(true);
      writeFileSync(join(replicaWork, ".env"), "SECRET=1");

      // The replica goes away at seq 1. The primary keeps working past the
      // checkpoint and beyond; each publish is a delta, the checkpoint apart.
      rmSync(join(primaryWork, "doomed.txt"));
      const publishedFull: number[] = [];
      const deltaBytes: number[] = [];
      let checkpointBytes = 0;
      for (let seq = 2; seq <= FULL_PACK_WINDOW + 3; seq++) {
        writeFileSync(join(primaryWork, "file-0.txt"), "edit " + seq + " ".repeat(10));
        last = await publish(credsFor("primary-device"), "x", primaryPaths, last.commit, last.seq, 2, last.roster);
        expect(last.seq).toBe(seq);
        if (last.full) {
          publishedFull.push(seq);
          checkpointBytes = last.bytes;
        } else deltaBytes.push(last.bytes);
      }
      // Only the checkpoint was a whole tree, and a delta is a fraction of it.
      expect(publishedFull).toEqual([FULL_PACK_WINDOW]);
      expect(Math.max(...deltaBytes)).toBeLessThan(checkpointBytes / 4);

      // The replica is further behind than the window. It starts at the
      // checkpoint and applies the deltas after it: it never asks for the
      // snapshots in between, which the gateway no longer has.
      gateway.packReads.length = 0;
      const caught = await pull(credsFor("replica-device"), "x", replicaPaths, first.seq, first.commit);
      expect(caught.applied).toBe(true);
      expect(caught.seq).toBe(FULL_PACK_WINDOW + 3);
      expect(gateway.packReads.length).toBe(4);
      const fp = fingerprint(replicaWork);
      fp.delete(".env");
      expect(sameTree(fingerprint(primaryWork), fp)).toBe(true);
      // What the fleet dropped on the way is gone; what it never had stays.
      expect(readFileSync(join(replicaWork, ".env"), "utf8")).toBe("SECRET=1");
    } finally {
      (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("a swap of one member for another is a membership change, though the count is the same", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-delta-"));
    const gateway = new FakeGateway();
    try {
      const primaryWork = join(root, "primary");
      const newcomerWork = join(root, "newcomer");
      mkdirSync(primaryWork, { recursive: true });
      mkdirSync(newcomerWork, { recursive: true });
      writeFileSync(join(primaryWork, "a.txt"), "alpha".repeat(100));
      const primaryPaths: MemberPaths = { work: primaryWork, gitDir: join(root, "p-meta"), keyFile: join(root, "p.key") };
      const newcomerPaths: MemberPaths = { work: newcomerWork, gitDir: join(root, "n-meta"), keyFile: join(root, "n.key") };

      useFakeGateway(gateway);
      gateway.seed("primary-device", loadOrCreateKeyPair(primaryPaths.keyFile).publicKey);
      gateway.seed("leaver-device", loadOrCreateKeyPair(join(root, "l.key")).publicKey);
      const first = await publish(credsFor("primary-device"), "x", primaryPaths, null, 0, 2);

      // One leaves, one joins: still two members.
      gateway.members.delete("leaver-device");
      gateway.seed("newcomer-device", loadOrCreateKeyPair(newcomerPaths.keyFile).publicKey);
      writeFileSync(join(primaryWork, "a.txt"), "alpha changed".repeat(100));

      // The roster names who is in, so the swap is seen: the snapshot carries
      // the whole tree, sealed for the newcomer, who can open it.
      const second = await publish(
        credsFor("primary-device"), "x", primaryPaths, first.commit, first.seq, first.members, first.roster,
      );
      expect(second.full).toBe(true);
      const pulled = await pull(credsFor("newcomer-device"), "x", newcomerPaths, 0);
      expect(pulled.applied).toBe(true);
      expect(sameTree(fingerprint(primaryWork), fingerprint(newcomerWork))).toBe(true);

      // Nothing changed in the roster since: the next publish is a delta again.
      writeFileSync(join(primaryWork, "a.txt"), "alpha changed again".repeat(100));
      const third = await publish(
        credsFor("primary-device"), "x", primaryPaths, second.commit, second.seq, second.members, second.roster,
      );
      expect(third.full).toBe(false);
    } finally {
      (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a member that was away across a takeover catches up from the new primary's chain", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-delta-"));
    const gateway = new FakeGateway();
    try {
      const mk = (n: string): MemberPaths => {
        mkdirSync(join(root, n), { recursive: true });
        return { work: join(root, n), gitDir: join(root, n + "-meta"), keyFile: join(root, n + ".key") };
      };
      const A = mk("a"), B = mk("b"), C = mk("c");
      useFakeGateway(gateway);
      for (const [id, p] of [["A", A], ["B", B], ["C", C]] as const) gateway.seed(id, loadOrCreateKeyPair(p.keyFile).publicKey);
      writeFileSync(join(A.work, "f.txt"), "v0".repeat(200));
      let last = await publish(credsFor("A"), "x", A, null, 0, 3);
      let b = await pull(credsFor("B"), "x", B, 0);
      const c = await pull(credsFor("C"), "x", C, 0);
      // C goes away at seq 1. A publishes 2..5 and B follows.
      for (let i = 2; i <= 5; i++) {
        writeFileSync(join(A.work, "f.txt"), "v" + i + "x".repeat(200));
        last = await publish(credsFor("A"), "x", A, last.commit, last.seq, 3, last.roster);
        b = await pull(credsFor("B"), "x", B, b.seq, b.commit);
      }
      // A dies and B takes over. A replica's state has no manifest of its own.
      gateway.primary = "B";
      writeFileSync(join(B.work, "g.txt"), "from B");
      const published = await publish(credsFor("B"), "x", B, b.commit, b.seq, 3, last.roster);
      expect(published.seq).toBe(6);
      expect(published.full).toBe(false);

      // C comes back at seq 1: the chain from the head reaches it.
      const caught = await pull(credsFor("C"), "x", C, c.seq, c.commit);
      expect(caught.seq).toBe(6);
      expect(sameTree(fingerprint(B.work), fingerprint(C.work))).toBe(true);
    } finally {
      (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("a new primary that was behind builds its first delta on the state it caught up to", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-delta-"));
    const gateway = new FakeGateway();
    try {
      const mk = (n: string): MemberPaths => {
        mkdirSync(join(root, n), { recursive: true });
        return { work: join(root, n), gitDir: join(root, n + "-meta"), keyFile: join(root, n + ".key") };
      };
      const A = mk("a"), B = mk("b");
      useFakeGateway(gateway);
      for (const [id, p] of [["A", A], ["B", B]] as const) gateway.seed(id, loadOrCreateKeyPair(p.keyFile).publicKey);
      writeFileSync(join(A.work, "f.txt"), "v0".repeat(200));
      let last = await publish(credsFor("A"), "x", A, null, 0, 2);
      const b1 = await pull(credsFor("B"), "x", B, 0);
      writeFileSync(join(A.work, "f.txt"), "v1".repeat(200));
      writeFileSync(join(A.work, "second.txt"), "added by A");
      last = await publish(credsFor("A"), "x", A, last.commit, last.seq, 2, last.roster);

      // B takes over one snapshot behind: publish catches it up first.
      gateway.primary = "B";
      writeFileSync(join(B.work, "g.txt"), "from B");
      const published = await publish(credsFor("B"), "x", B, b1.commit, b1.seq, 2, last.roster);
      expect(published.seq).toBe(3);
      // Its snapshot follows the one it caught up to, not the one it held before.
      const parent = execFileSync("git", ["--git-dir=" + B.gitDir, "rev-parse", published.commit + "^"], { encoding: "utf8" }).trim();
      expect(parent).toBe(last.commit);
      // The fleet has A's work and B's, and a replica that follows gets both.
      const A2 = await pull(credsFor("A"), "x", A, last.seq, last.commit);
      expect(A2.seq).toBe(3);
      expect(readFileSync(join(A.work, "g.txt"), "utf8")).toBe("from B");
      expect(readFileSync(join(A.work, "second.txt"), "utf8")).toBe("added by A");
    } finally {
      (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
