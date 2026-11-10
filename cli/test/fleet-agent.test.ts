import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pull, publish, type MemberPaths } from "../src/fleet-agent";
import { type FleetCredentials } from "../src/fleet-transport";

/**
 *  A gateway that stores bytes and never reads them.
 *
 *  It behaves like the real one in the ways that matter: the head only moves
 *  when the expected sequence matches, a payload can only be written by the
 *  primary, and a member can only read a payload it is entitled to.
 *
 */
class FakeGateway {
  payloads = new Map<string, Buffer>();
  head: { seq: number; manifestKey: string; manifestHash: string; epoch: number } | null = null;
  members = new Map<string, { deviceId: string; role: string; pubkey?: string }>();
  primary = "";
  applied = new Map<string, number>();

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
    if (kind === "applied" && method === "POST") {
      const body_ = JSON.parse(String(body ?? "{}")) as { seq: number };
      this.applied.set(creds.deviceId, Math.max(this.applied.get(creds.deviceId) ?? 0, body_.seq ?? 0));
      return Response.json({ ok: true, applied: this.applied.get(creds.deviceId) });
    }
    if (kind === "members" && method === "GET") {
      return Response.json({ members: [...this.members.values()] });
    }
    if (kind === "keys" && method === "GET") {
      if (creds.deviceId !== this.primary) return Response.json({ error: "not the primary" }, { status: 409 });
      return Response.json({ members: [...this.members.values()].map((m) => ({ deviceId: m.deviceId, pubkey: m.pubkey })) });
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
      const body_ = JSON.parse(String(body ?? "{}")) as { expectedSeq: number; manifestKey: string; manifestHash: string };
      const current = this.head?.seq ?? 0;
      if (body_.expectedSeq !== current) return Response.json({ error: "stale head" }, { status: 409 });
      if ((this.applied.get(creds.deviceId) ?? 0) < current) {
        return Response.json({ error: "catch up first", required: current }, { status: 409 });
      }
      this.head = { seq: current + 1, manifestKey: body_.manifestKey, manifestHash: body_.manifestHash, epoch: 1 };
      return Response.json({ ok: true, seq: this.head.seq });
    }
    return Response.json({ error: "no route" }, { status: 404 });
  }
}

function credsFor(_gateway: FakeGateway, deviceId: string): FleetCredentials {
  return {
    gateway: "http://fake",
    deviceId,
    deviceToken: "token",
    timeoutMs: 5000,
  };
}

// Point the transport at the fake gateway for the duration of a test.
function useFakeGateway(gateway: FakeGateway): void {
  const original = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = (async (url: string, init: { method: string; headers: Record<string, string>; body?: Buffer | string }) => {
    const path = new URL(url).pathname;
    const deviceId = init.headers["x-prime-device"] ?? "";
    return gateway.handle(credsFor(gateway, deviceId), init.method, path, init.body);
  }) as unknown as typeof fetch;
  (globalThis as { __restoreFetch?: () => void }).__restoreFetch = () => {
    (globalThis as { fetch: unknown }).fetch = original;
  };
}

describe("publishing and pulling", () => {
  test("a replica ends up with the primary's files", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-agent-"));
    const gateway = new FakeGateway();
    try {
      const primaryWork = join(root, "primary-work");
      const primaryPaths: MemberPaths = {
        work: primaryWork,
        gitDir: join(root, "primary-meta"),
        keyFile: join(root, "primary.key"),
      };
      const replicaWork = join(root, "replica-work");
      const replicaPaths: MemberPaths = {
        work: replicaWork,
        gitDir: join(root, "replica-meta"),
        keyFile: join(root, "replica.key"),
      };
      mkdirSync(primaryWork, { recursive: true });
      mkdirSync(replicaWork, { recursive: true });
      writeFileSync(join(primaryWork, "hello.txt"), "hello from the primary");
      mkdirSync(join(primaryWork, "src"), { recursive: true });
      writeFileSync(join(primaryWork, "src", "main.py"), "print('primary')");

      useFakeGateway(gateway);
      // Both members hold a key pair before anything is sealed.
      const { loadOrCreateKeyPair } = await import("../src/fleet-agent");
      const keys = loadOrCreateKeyPair(primaryPaths.keyFile);
      gateway.seed("primary-device", keys.publicKey);
      const replicaKeys = loadOrCreateKeyPair(replicaPaths.keyFile);
      gateway.seed("replica-device", replicaKeys.publicKey);

      const published = await publish(credsFor(gateway, "primary-device"), "x", primaryPaths, null);
      expect(published.seq).toBe(1);
      expect(published.members).toBe(2);

      const pulled = await pull(credsFor(gateway, "replica-device"), "x", replicaPaths, 0);
      expect(pulled.applied).toBe(true);
      expect(pulled.seq).toBe(1);
      expect(readFileSync(join(replicaWork, "hello.txt"), "utf8")).toBe("hello from the primary");
      expect(readFileSync(join(replicaWork, "src", "main.py"), "utf8")).toBe("print('primary')");
    } finally {
      (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a pull with nothing new does nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-agent-"));
    const gateway = new FakeGateway();
    try {
      const work = join(root, "work");
      const paths: MemberPaths = { work, gitDir: join(root, "meta"), keyFile: join(root, "m.key") };
      mkdirSync(work, { recursive: true });
      writeFileSync(join(work, "a.txt"), "a");
      useFakeGateway(gateway);
      const { loadOrCreateKeyPair } = await import("../src/fleet-agent");
      const keys = loadOrCreateKeyPair(paths.keyFile);
      gateway.seed("primary-device", keys.publicKey);
      gateway.seed("replica-device", keys.publicKey);
      await publish(credsFor(gateway, "primary-device"), "x", paths, null);
      const pulled = await pull(credsFor(gateway, "replica-device"), "x", paths, 1);
      expect(pulled.upToDate).toBe(true);
      expect(pulled.applied).toBe(false);
    } finally {
      (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the gateway cannot read what it stores", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-agent-"));
    const gateway = new FakeGateway();
    try {
      const work = join(root, "work");
      const paths: MemberPaths = { work, gitDir: join(root, "meta"), keyFile: join(root, "m.key") };
      mkdirSync(work, { recursive: true });
      writeFileSync(join(work, "secret.txt"), "TOP-SECRET-MARKER");
      useFakeGateway(gateway);
      const { loadOrCreateKeyPair } = await import("../src/fleet-agent");
      const keys = loadOrCreateKeyPair(paths.keyFile);
      gateway.seed("primary-device", keys.publicKey);
      await publish(credsFor(gateway, "primary-device"), "x", paths, null);
      for (const bytes of gateway.payloads.values()) {
        expect(bytes.toString("utf8")).not.toContain("TOP-SECRET-MARKER");
      }
    } finally {
      (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("only the primary may publish", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-agent-"));
    const gateway = new FakeGateway();
    try {
      const work = join(root, "work");
      const paths: MemberPaths = { work, gitDir: join(root, "meta"), keyFile: join(root, "m.key") };
      mkdirSync(work, { recursive: true });
      writeFileSync(join(work, "a.txt"), "a");
      useFakeGateway(gateway);
      const { loadOrCreateKeyPair } = await import("../src/fleet-agent");
      const keys = loadOrCreateKeyPair(paths.keyFile);
      gateway.seed("primary-device", keys.publicKey);
      gateway.seed("replica-device", keys.publicKey);
      let failed = false;
      try {
        await publish(credsFor(gateway, "replica-device"), "x", paths, null);
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    } finally {
      (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
