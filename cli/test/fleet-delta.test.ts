import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { publish, pull, type MemberPaths } from "../src/fleet-agent";
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
      return Response.json({ members: [...this.members.values()].map((m) => ({ deviceId: m.deviceId, pubkey: m.pubkey })) });
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
      const hash = (b: Buffer) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
      const packKey = "fleets/x/packs/" + hash(pack);
      const manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
      manifest.packKey = packKey;
      manifest.packHash = hash(pack);
      const finalManifest = Buffer.from(JSON.stringify(manifest), "utf8");
      const manifestKey = "fleets/x/manifests/" + hash(finalManifest);
      this.payloads.set(packKey, pack);
      this.payloads.set(manifestKey, finalManifest);
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
      const hash = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
      const key = "fleets/x/" + kind + "/" + hash;
      this.payloads.set(key, bytes);
      return Response.json({ ok: true, key, hash, size: bytes.length });
    }
    if ((kind === "packs" || kind === "manifests") && method === "GET") {
      const id = parts[3] ?? "";
      const found = [...this.payloads.entries()].find(([k]) => k.endsWith("/" + id));
      if (!found) return Response.json({ error: "no such payload" }, { status: 404 });
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
      const first = await publish(credsFor("primary-device"), "x", primaryPaths, null, 0, undefined, 2);
      expect(first.seq).toBe(1);
      const firstBytes = first.bytes;

      // The replica catches up with the whole tree.
      const pulled = await pull(credsFor("replica-device"), "x", replicaPaths, 0);
      expect(pulled.applied).toBe(true);
      expect(sameTree(fingerprint(primaryWork), fingerprint(replicaWork))).toBe(true);

      // A small change, published on top of the first snapshot.
      writeFileSync(join(primaryWork, "file-0.txt"), "changed content ".repeat(50));
      const second = await publish(credsFor("primary-device"), "x", primaryPaths, first.commit, first.seq, undefined, 2);
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

      const first = await publish(credsFor("primary-device"), "x", primaryPaths, null, 0, undefined, 1);
      expect(first.seq).toBe(1);

      // A second member joins: the membership changed, so the next publish
      // carries the whole tree again.
      const replicaKeys = loadOrCreateKeyPair(replicaPaths.keyFile);
      gateway.seed("replica-device", replicaKeys.publicKey);
      writeFileSync(join(primaryWork, "a.txt"), "alpha changed".repeat(100));
      const second = await publish(credsFor("primary-device"), "x", primaryPaths, first.commit, first.seq, undefined, 1);
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
      const first = await publish(credsFor("primary-device"), "x", primaryPaths, null, 0, undefined, 2);
      await pull(credsFor("replica-device"), "x", replicaPaths, 0);

      // Three more snapshots are published while the replica is away.
      let base = first.commit;
      let baseSeq = first.seq;
      let parentManifest = first.manifestKey;
      for (let i = 0; i < 3; i++) {
        writeFileSync(join(primaryWork, "a.txt"), "step " + i + " ".repeat(100));
        const next = await publish(credsFor("primary-device"), "x", primaryPaths, base, baseSeq, parentManifest, 2);
        base = next.commit;
        baseSeq = next.seq;
        parentManifest = next.manifestKey;
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
});
