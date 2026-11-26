// What a member checks before it believes a snapshot: the seal over the manifest,
// the key the snapshot came from, and no going back to snapshots without a seal.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { loadOrCreateKeyPair, manifestIdOf, publish, pull, type MemberPaths } from "../src/fleet-agent";
import { generateMemberKeyPair, openForMember, sealManyForMembers } from "../src/fleet-crypto";
import { FleetTrust, TamperedSnapshotError, sealFieldsOf } from "../src/fleet-trust";
import { FleetTransportError, payloadHash, fetchManifest, type FleetManifest } from "../src/fleet-transport";

import { FakeGateway, credsFor, fingerprint, sameTree, useFakeGateway } from "./fleet-fake-gateway";

interface World {
  root: string;
  gateway: FakeGateway;
  primary: MemberPaths;
  replica: MemberPaths;
  work: string;
  /** Write a file and publish; the primary keeps its own position. */
  next(content: string): Promise<{ seq: number; manifestKey: string }>;
  manifest(key: string): FleetManifest;
  /** Put a manifest in the gateway as the head, as a gateway that rewrites history would. */
  forge(m: FleetManifest): string;
  pullReplica(from: number): ReturnType<typeof pull>;
}

const roots: string[] = [];
afterEach(() => {
  (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function world(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "fleet-seal-"));
  roots.push(root);
  const gateway = new FakeGateway();
  useFakeGateway(gateway);
  const work = join(root, "primary");
  mkdirSync(work, { recursive: true });
  mkdirSync(join(root, "replica"), { recursive: true });
  const primary: MemberPaths = { work, gitDir: join(root, "p-meta"), keyFile: join(root, "p.key") };
  const replica: MemberPaths = { work: join(root, "replica"), gitDir: join(root, "r-meta"), keyFile: join(root, "r.key") };
  gateway.seed("primary-device", loadOrCreateKeyPair(primary.keyFile).publicKey);
  gateway.seed("replica-device", loadOrCreateKeyPair(replica.keyFile).publicKey);
  let last: { seq: number; commit: string } | null = null;
  const hash = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
  return {
    root,
    gateway,
    primary,
    replica,
    work,
    async next(content) {
      writeFileSync(join(work, "file.txt"), content);
      const out = await publish(credsFor("primary-device"), "x", primary, last?.commit ?? null, last?.seq ?? 0, 2);
      last = out;
      return out;
    },
    manifest: (key) => JSON.parse(gateway.payloads.get(key)!.toString("utf8")) as FleetManifest,
    forge(m) {
      const bytes = Buffer.from(JSON.stringify(m), "utf8");
      const key = "fleets/x/manifests/" + hash(bytes);
      gateway.payloads.set(key, bytes);
      gateway.head = { seq: m.seq, manifestKey: key, manifestHash: hash(bytes), epoch: 1 };
      gateway.indexEntries.push({ seq: m.seq, manifestKey: key, full: m.full, ...(m.packBytes !== undefined ? { packBytes: m.packBytes } : {}) });
      return key;
    },
    pullReplica: (from) => pull(credsFor("replica-device"), "x", replica, from),
  };
}

describe("a manifest the gateway rewrote", () => {
  test("an old snapshot relabelled as a newer sequence is refused, and nothing is written", async () => {
    const w = await world();
    const one = await w.next("price = 100\n");
    const two = await w.next("price = 999\n");
    await w.pullReplica(0);
    const before = fingerprint(w.replica.work);
    expect(readFileSync(join(w.replica.work, "file.txt"), "utf8")).toBe("price = 999\n");

    // The gateway shows snapshot 1 (full, sealed) as snapshot 3 on top of 2.
    const m1 = w.manifest(one.manifestKey);
    w.forge({ ...m1, seq: 3, parentManifest: two.manifestKey, parentSeq: 2 });

    await expect(w.pullReplica(2)).rejects.toBeInstanceOf(TamperedSnapshotError);
    expect(sameTree(fingerprint(w.replica.work), before)).toBe(true);
  });

  test("a relabel by a fresh member is refused too", async () => {
    const w = await world();
    const one = await w.next("a\n");
    const two = await w.next("b\n");
    // Snapshot 1 is a whole tree: shown as 3, a member that starts from nothing would take it as the head.
    w.forge({ ...w.manifest(one.manifestKey), seq: 3, parentManifest: two.manifestKey, parentSeq: 2 });
    await expect(w.pullReplica(0)).rejects.toBeInstanceOf(TamperedSnapshotError);
    expect(existsSync(join(w.replica.work, "file.txt"))).toBe(false);
  });

  test("a swapped tree and commit, with the pack that goes with them, is refused", async () => {
    const w = await world();
    const one = await w.next("one\n");
    const two = await w.next("two\n");
    const m1 = w.manifest(one.manifestKey);
    const m2 = w.manifest(two.manifestKey);
    // Snapshot 2 now claims snapshot 1's content, packs included: it is consistent in itself.
    w.forge({ ...m2, tipCommit: m1.tipCommit, tree: m1.tree, packKey: m1.packKey, packHash: m1.packHash, packBytes: m1.packBytes, full: m1.full, wrapped: m1.wrapped });
    await expect(w.pullReplica(0)).rejects.toBeInstanceOf(TamperedSnapshotError);
  });

  test("a manifest with its tree changed is refused", async () => {
    const w = await world();
    const one = await w.next("one\n");
    const m1 = w.manifest(one.manifestKey);
    const other = "0".repeat(40);
    w.forge({ ...m1, tree: other });
    await expect(w.pullReplica(0)).rejects.toThrow(/refused|does not match/);
  });

  test("a snapshot of another fleet is refused", async () => {
    const w = await world();
    const one = await w.next("one\n");
    const m1 = w.manifest(one.manifestKey);
    w.forge({ ...m1, fleet: "y" });
    await expect(w.pullReplica(0)).rejects.toThrow(/fleet y/);
  });

  test("a pack swapped for another snapshot's is refused", async () => {
    const w = await world();
    const one = await w.next("one\n");
    const two = await w.next("two\n");
    const m1 = w.manifest(one.manifestKey);
    const m2 = w.manifest(two.manifestKey);
    // Same manifest, but the bytes behind its pack key are another snapshot's (both really sealed by the primary).
    const m2pack = [...w.gateway.payloads.entries()].find(([k]) => k === m2.packKey)!;
    w.gateway.payloads.set(m2pack[0], w.gateway.payloads.get(m1.packKey)!);
    await expect(w.pullReplica(0)).rejects.toBeInstanceOf(TamperedSnapshotError);
  });

  test("an honest chain is applied, and the replica ends with the primary's files", async () => {
    const w = await world();
    await w.next("one\n");
    await w.next("two\n");
    const got = await w.pullReplica(0);
    expect(got.seq).toBe(2);
    expect(sameTree(fingerprint(w.work), fingerprint(w.replica.work))).toBe(true);
  });
});

describe("a manifest stored under a hash", () => {
  test("is the one asked for, or it is refused", async () => {
    const w = await world();
    const one = await w.next("one\n");
    const two = await w.next("two\n");
    w.gateway.payloads.set(one.manifestKey, w.gateway.payloads.get(two.manifestKey)!);
    await expect(fetchManifest(credsFor("replica-device"), "x", manifestIdOf(one.manifestKey))).rejects.toBeInstanceOf(FleetTransportError);
  });
});

describe("a snapshot the gateway made up", () => {
  test("is refused: its key is not any member's, however well it is sealed", async () => {
    const w = await world();
    const one = await w.next("one\n");
    const m1 = w.manifest(one.manifestKey);
    const replicaKeys = loadOrCreateKeyPair(w.replica.keyFile);
    const primaryKeys = loadOrCreateKeyPair(w.primary.keyFile);
    // Open the real pack, and seal it again as the gateway would: its own key pair, the snapshot key
    // wrapped for the replica, a seal that is perfectly valid for that snapshot key.
    const plain = openForMember(w.gateway.payloads.get(m1.packKey)!, m1.wrapped, m1.senderPublicKey, "replica-device", replicaKeys.privateKey)!;
    const gw = generateMemberKeyPair();
    const sealed = sealManyForMembers([plain], [{ memberId: "replica-device", publicKey: replicaKeys.publicKey }], gw.privateKey, gw.publicKey);
    const pack = sealed.ciphertexts[0]!;
    const forged: FleetManifest = { ...m1, packKey: "fleets/x/packs/" + payloadHash(pack), packHash: payloadHash(pack), senderPublicKey: gw.publicKey, wrapped: sealed.wrapped };
    forged.seal = sealed.seal(sealFieldsOf(forged, payloadHash(pack), null));
    w.gateway.payloads.set(forged.packKey, pack);
    w.forge(forged);
    expect(primaryKeys.publicKey).not.toBe(gw.publicKey);
    await expect(w.pullReplica(0)).rejects.toThrow(/not any member's/);
  });

  test("the roster is read when a key is new, and not for every snapshot after", async () => {
    const w = await world();
    await w.next("1\n");
    await w.pullReplica(0);
    const first = w.gateway.requests.get("GET members") ?? 0;
    expect(first).toBe(1);
    await w.next("2\n");
    await w.next("3\n");
    await w.pullReplica(1);
    expect(w.gateway.requests.get("GET members") ?? 0).toBe(first);
  });
});

describe("snapshots from publishers that predate the seal", () => {
  test("are accepted while the fleet has seen no seal", async () => {
    const w = await world();
    w.gateway.unsealed = true;
    await w.next("one\n");
    await w.next("two\n");
    const got = await w.pullReplica(0);
    expect(got.seq).toBe(2);
    expect(sameTree(fingerprint(w.work), fingerprint(w.replica.work))).toBe(true);
    expect(FleetTrust.beside(w.replica.keyFile).boundSeq).toBeUndefined();
  });

  test("a sealed snapshot after them is applied, and the fleet remembers it has seen a seal", async () => {
    const w = await world();
    w.gateway.unsealed = true;
    await w.next("one\n");
    await w.pullReplica(0);
    w.gateway.unsealed = false;
    await w.next("two\n");
    const got = await w.pullReplica(1);
    expect(got.seq).toBe(2);
    expect(FleetTrust.beside(w.replica.keyFile).boundSeq).toBe(2);
  });

  test("an unsealed snapshot with a higher sequence is refused once a sealed one has been seen", async () => {
    const w = await world();
    await w.next("one\n");
    await w.pullReplica(0);
    w.gateway.unsealed = true; // the gateway passes an old publisher's snapshot off as the next one
    await w.next("two\n");
    await expect(w.pullReplica(1)).rejects.toThrow(/carries no seal/);
    expect(readFileSync(join(w.replica.work, "file.txt"), "utf8")).toBe("one\n");
  });

  test("an unsealed snapshot below the newest sealed one is history, and is taken", async () => {
    const w = await world();
    w.gateway.unsealed = true;
    await w.next("one\n");
    w.gateway.unsealed = false;
    await w.next("two\n");
    // A member that was never there: the sealed head (a delta on the unsealed first) is followed from 0.
    const got = await w.pullReplica(0);
    expect(got.seq).toBe(2);
    expect(sameTree(fingerprint(w.work), fingerprint(w.replica.work))).toBe(true);
  });

  test("the primary that published a seal does not take an unsealed successor", async () => {
    const w = await world();
    await w.next("one\n");
    expect(FleetTrust.beside(w.primary.keyFile).boundSeq).toBe(1);
  });
});

describe("old readers and new publishers", () => {
  test("a reader that knows nothing of seals opens what a sealing publisher stored", async () => {
    const w = await world();
    const one = await w.next("one\n");
    const m1 = w.manifest(one.manifestKey);
    expect(m1.seal).toMatch(/^v1:/);
    const keys = loadOrCreateKeyPair(w.replica.keyFile);
    const plain = openForMember(w.gateway.payloads.get(m1.packKey)!, m1.wrapped, m1.senderPublicKey, "replica-device", keys.privateKey);
    expect(plain).not.toBeNull();
  });

  test("the seal is over the sealed hashes the gateway computed", async () => {
    const w = await world();
    const one = await w.next("one\n");
    const m1 = w.manifest(one.manifestKey);
    expect(m1.packHash).toBe(payloadHash(w.gateway.payloads.get(m1.packKey)!));
  });
});
