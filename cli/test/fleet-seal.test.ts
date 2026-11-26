// What a member checks before it believes a snapshot: the seal over the manifest,
// the key the snapshot came from, and no going back to snapshots without a seal.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes } from "node:crypto";

import { loadOrCreateKeyPair, manifestIdOf, publish, pull, type MemberPaths } from "../src/fleet-agent";
import { generateMemberKeyPair, openForMember, sealManyForMembers } from "../src/fleet-crypto";
import { FleetTrust, TamperedSnapshotError, sealFieldsOf } from "../src/fleet-trust";
import { snapshot } from "../src/fleet-sync";
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

  test("the roster is read once for a catch-up, not once for every snapshot on it", async () => {
    const w = await world();
    await w.next("1\n");
    await w.pullReplica(0);
    const first = w.gateway.requests.get("GET members") ?? 0;
    expect(first).toBe(1);
    await w.next("2\n");
    await w.next("3\n");
    await w.next("4\n");
    // Three snapshots, newer than any the roster was read for: one read stands for all of them.
    await w.pullReplica(1);
    expect(w.gateway.requests.get("GET members") ?? 0).toBe(first + 1);
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
    expect(FleetTrust.beside(w.replica.keyFile).sealedFrom).toBeUndefined();
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
    expect(FleetTrust.beside(w.replica.keyFile).sealedFrom).toBe(2);
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
    expect(FleetTrust.beside(w.primary.keyFile).sealedFrom).toBe(1);
  });
});

describe("a fleet that is upgraded one member at a time", () => {
  const trustOf = (w: World): { sealedFrom?: number; boundSeq?: number } => {
    const file = w.replica.keyFile + ".trust.json";
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  };
  const read = (w: World): string => readFileSync(join(w.replica.work, "file.txt"), "utf8");

  test("a publisher that finds an unsealed head publishes a whole tree", async () => {
    const w = await world();
    await w.next("one\n");
    w.gateway.unsealed = true; // an old member was promoted
    await w.next("two\n");
    w.gateway.unsealed = false; // and the primary is back, upgraded
    const three = await w.next("three\n");
    expect(w.manifest(three.manifestKey).full).toBe(true);
    // Once the head is sealed, the next one is a change again.
    const four = await w.next("four\n");
    expect(w.manifest(four.manifestKey).full).toBe(false);
  });

  test("a replica that refused the unsealed snapshot goes around it, by the whole tree after it", async () => {
    const w = await world();
    await w.next("one\n");
    await w.pullReplica(0);
    w.gateway.unsealed = true;
    await w.next("two\n");
    w.gateway.unsealed = false;
    await w.next("three\n");
    await w.next("four\n");
    const got = await w.pullReplica(1);
    expect(got.seq).toBe(4);
    expect(read(w)).toBe("four\n");
  });

  test("a member whose catch-up is refused only because the head is unsealed can be told to take it", async () => {
    const w = await world();
    await w.next("one\n");
    const got = await w.pullReplica(0);
    w.gateway.unsealed = true;
    await w.next("two\n"); // the old member, and then it is gone
    w.gateway.primary = "replica-device";
    const take = (): ReturnType<typeof publish> => publish(credsFor("replica-device"), "x", w.replica, got.commit, got.seq, 2);
    // The refusal says what to do about it.
    await expect(take()).rejects.toThrow(/prime fleets trust reset/);
    expect(FleetTrust.reset(w.replica.keyFile)).toBe(1);
    w.gateway.unsealed = false;
    const out = await take();
    expect(out.seq).toBe(3);
    expect(out.full).toBe(true); // the snapshot is sealed again, whole
    expect(read(w)).toBe("two\n");
    expect(FleetTrust.beside(w.replica.keyFile).sealedFrom).toBe(3);
  });

  test("a snapshot downloaded ahead of the one before it does not raise the guard", async () => {
    const w = await world();
    w.gateway.unsealed = true;
    await w.next("one\n");
    await w.next("two\n");
    await w.pullReplica(0);
    w.gateway.unsealed = false;
    const three = await w.next("three\n");
    await w.next("four\n");
    // The packs of 3 are not served; those of 4 are, and are checked while 3 is being waited for.
    const m3 = w.manifest(three.manifestKey);
    const lost = [m3.packKey, m3.delta?.packKey].filter((k): k is string => k !== undefined).map(manifestIdOf);
    const real = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async (url: string, init: unknown) => {
      if (lost.some((id) => String(url).includes("/packs/" + id))) {
        await new Promise((r) => setTimeout(r, 150));
        return new Response("{}", { status: 503 });
      }
      return real(url, init as never);
    };
    try {
      await expect(w.pullReplica(2)).rejects.toThrow();
    } finally {
      (globalThis as { fetch: unknown }).fetch = real;
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(trustOf(w).sealedFrom ?? trustOf(w).boundSeq).toBeUndefined();
  });

  test("an unsealed snapshot at or above the lowest sealed one taken in is refused, though below the highest", async () => {
    const w = await world();
    w.gateway.unsealed = true;
    const one = await w.next("one\n");
    const two = await w.next("two\n");
    w.gateway.unsealed = false;
    await w.next("three\n");
    await w.next("four\n");
    await w.pullReplica(0);
    // The gateway shows snapshot 1 (unsealed) as snapshot 3, which is below the newest sealed one.
    w.forge({ ...w.manifest(one.manifestKey), seq: 3, parentSeq: 2, parentManifest: two.manifestKey });
    await expect(w.pullReplica(2)).rejects.toThrow(/carries no seal/);
    expect(read(w)).toBe("four\n");
    expect(FleetTrust.beside(w.replica.keyFile).sealedFrom).toBe(3);
  });
});

describe("a member that was removed", () => {
  // Three members: the primary, the replica and one that is then removed.
  async function withExMember(): Promise<{ w: World; ex: MemberPaths; one: { seq: number; manifestKey: string }; two: { seq: number; manifestKey: string } }> {
    const w = await world();
    const ex: MemberPaths = { work: join(w.root, "ex"), gitDir: join(w.root, "ex-meta"), keyFile: join(w.root, "ex.key") };
    mkdirSync(ex.work, { recursive: true });
    w.gateway.seed("ex-device", loadOrCreateKeyPair(ex.keyFile).publicKey);
    const one = await w.next("price = 100\n");
    await w.pullReplica(0); // the replica reads the roster: all three
    w.gateway.members.delete("ex-device"); // the operator removes it
    const two = await w.next("price = 101\n");
    await w.pullReplica(1);
    return { w, ex, one, two };
  }

  test("cannot publish with its own key: the roster no longer lists it", async () => {
    const { w, ex } = await withExMember();
    writeFileSync(join(ex.work, "file.txt"), "price = 0 (forged by the removed member)\n");
    w.gateway.primary = "ex-device";
    w.gateway.applied.set("ex-device", 2);
    await publish(credsFor("ex-device"), "x", ex, null, 2, 2);
    w.gateway.primary = "primary-device";
    await expect(w.pullReplica(2)).rejects.toThrow(/not any member's/);
    expect(readFileSync(join(w.replica.work, "file.txt"), "utf8")).toBe("price = 101\n");
  });

  test("cannot publish under a current member's name with a snapshot key it was once given", async () => {
    const { w, ex, one } = await withExMember();
    const pk = (b64: string) => createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), Buffer.from(b64, "base64")]), format: "der", type: "spki" });
    const shared = (privPem: string, pubB64: string) =>
      Buffer.from(hkdfSync("sha256", diffieHellman({ privateKey: createPrivateKey(privPem), publicKey: pk(pubB64) }), Buffer.alloc(32), Buffer.from("prime-fleet-content-v1"), 32));
    const m1 = w.manifest(one.manifestKey);
    const exKeys = loadOrCreateKeyPair(ex.keyFile);
    // The removed member opens the snapshot key of snapshot 1, which was wrapped for it.
    const mine = Buffer.from(m1.wrapped.find((e) => e.memberId === "ex-device")!.wrapped, "base64");
    const un = createDecipheriv("aes-256-gcm", shared(exKeys.privateKey, m1.senderPublicKey), mine.subarray(0, 12));
    un.setAuthTag(mine.subarray(mine.length - 16));
    const K1 = Buffer.concat([un.update(mine.subarray(12, mine.length - 16)), un.final()]);

    writeFileSync(join(ex.work, "file.txt"), "price = -1 (forged under the primary's name)\n");
    const snap = await snapshot({ work: ex.work, gitDir: ex.gitDir, base: null, seq: 4, wantFull: true });
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", K1, iv);
    const pack = Buffer.concat([iv, c.update(snap.pack), c.final(), c.getAuthTag()]);
    const head = w.gateway.head!;
    const forged: FleetManifest = {
      fleet: "x",
      seq: head.seq + 1,
      tipCommit: snap.commit,
      tree: snap.tree,
      packKey: "fleets/x/packs/" + payloadHash(pack),
      packHash: payloadHash(pack),
      packBytes: pack.length,
      full: true,
      parentManifest: head.manifestKey,
      parentSeq: head.seq,
      // Everything is the primary's: its key as sender, the entries it wrapped for snapshot 1.
      senderPublicKey: m1.senderPublicKey,
      wrapped: m1.wrapped.filter((e) => e.memberId !== "ex-device").map(({ mac: _mac, ...rest }) => rest),
      ...(m1.roster !== undefined ? { roster: m1.roster } : {}),
      epoch: 1,
      createdAt: Date.now(),
    };
    // The seal is an HMAC under a key derived from the snapshot key: whoever held it can make it.
    const f = sealFieldsOf(forged, forged.packHash, null);
    const sealKey = Buffer.from(hkdfSync("sha256", K1, Buffer.alloc(32), Buffer.from("prime-fleet-seal-v1"), 32));
    forged.seal =
      "v1:" +
      createHmac("sha256", sealKey)
        .update(JSON.stringify(["prime-fleet-seal-v1", f.fleet, f.seq, f.parentSeq, f.parentManifest, f.tipCommit, f.tree, f.full, f.packHash, f.deltaHash, f.senderPublicKey, f.roster]))
        .digest("base64");
    w.gateway.payloads.set(forged.packKey, pack);
    w.forge(forged);
    await expect(w.pullReplica(2)).rejects.toThrow(/tag its sender made|carries no tag from its sender/);
    expect(readFileSync(join(w.replica.work, "file.txt"), "utf8")).toBe("price = 101\n");
  });

  test("a tag that does not match is refused, and so is a snapshot without one after snapshots that had them", async () => {
    const w = await world();
    const one = await w.next("one\n");
    await w.pullReplica(0);
    expect(FleetTrust.beside(w.replica.keyFile).macFrom).toBe(1);
    const two = await w.next("two\n");
    const m2 = w.manifest(two.manifestKey);
    // A tag of another snapshot's (it is the sender's, but not over these fields).
    const mac1 = w.manifest(one.manifestKey).wrapped.find((e) => e.memberId === "replica-device")!.mac!;
    w.forge({ ...m2, wrapped: m2.wrapped.map((e) => (e.memberId === "replica-device" ? { ...e, mac: mac1 } : e)) });
    await expect(w.pullReplica(1)).rejects.toThrow(/tag its sender made/);
  });

  test("a publisher that seals but does not tag each member's entry is refused once tags have been seen", async () => {
    const w = await world();
    await w.next("one\n");
    await w.pullReplica(0);
    w.gateway.noMacs = true; // an earlier build
    await w.next("two\n");
    await expect(w.pullReplica(1)).rejects.toThrow(/no tag from its sender/);
    expect(FleetTrust.reset(w.replica.keyFile)).toBe(1);
    expect((await w.pullReplica(1)).seq).toBe(2);
  });

  test("a publisher that finds a head without those tags publishes a whole tree", async () => {
    const w = await world();
    w.gateway.noMacs = true;
    await w.next("one\n");
    w.gateway.noMacs = false;
    const two = await w.next("two\n");
    expect(w.manifest(two.manifestKey).full).toBe(true);
    const three = await w.next("three\n");
    expect(w.manifest(three.manifestKey).full).toBe(false);
  });
});

describe("the change pack that travels beside a whole tree", () => {
  test("is sealed under the hash computed here, and a gateway that reports another is not believed", async () => {
    const w = await world();
    await w.next("one\n");
    // A member joins: the next snapshot is a whole tree with a change pack beside it.
    w.gateway.seed("third-device", generateMemberKeyPair().publicKey);
    const real = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async (url: string, init: { method?: string } & Record<string, unknown>) => {
      const res = await real(url, init as never);
      if (init.method === "POST" && String(url).endsWith("/fleets/x/packs")) {
        const body = (await res.json()) as Record<string, unknown>;
        return Response.json({ ...body, hash: "0".repeat(64) });
      }
      return res;
    };
    try {
      await expect(w.next("two\n")).rejects.toThrow(/another hash/);
    } finally {
      (globalThis as { fetch: unknown }).fetch = real;
    }
    // The head did not move: the refused publish left nothing to be applied.
    expect(w.gateway.head?.seq).toBe(1);
  });
});

describe("a publish that is refused once and sent again", () => {
  test("sends the change pack again, so the head does not name one the gateway deleted", async () => {
    const w = await world();
    w.gateway.dropChangePackOnRefusal = true;
    await w.next("one\n");
    w.gateway.failApplied = 1; // the report that this member applied 1 is lost
    w.gateway.applied.set("primary-device", 0);
    w.gateway.seed("third-device", generateMemberKeyPair().publicKey); // the next snapshot is a whole tree with a change pack
    const two = await w.next("two\n");
    const m2 = w.manifest(two.manifestKey);
    expect(m2.delta).toBeDefined();
    expect(w.gateway.payloads.has(m2.delta!.packKey)).toBe(true);
  });
});

describe("a fleet made again under the name of a deleted one", () => {
  test("does not take a sealed snapshot of the earlier fleet, replayed from storage that survived it", async () => {
    const w = await world();
    await w.next("old fleet: secret project v2\n");
    // The fleet is deleted and made again under the same name: the gateway says it is another incarnation,
    // and the members' key files are still there. What the old one stored is replayed as the head.
    w.gateway.incarnation = "incarnation-2";
    await expect(w.pullReplica(0)).rejects.toThrow(/earlier fleet that had the name x/);
    expect(existsSync(join(w.replica.work, "file.txt"))).toBe(false);
  });

  test("a member that learnt which fleet it is in refuses a snapshot that does not say, once one has", async () => {
    const w = await world();
    await w.next("one\n");
    await w.pullReplica(0);
    w.gateway.incarnation = undefined; // a publisher whose gateway does not say
    await w.next("two\n");
    await expect(w.pullReplica(1)).rejects.toThrow(/no mark of which fleet/);
  });

  test("a publisher that finds a head without the mark publishes a whole tree", async () => {
    const w = await world();
    w.gateway.incarnation = undefined;
    await w.next("one\n");
    w.gateway.incarnation = "incarnation-1";
    const two = await w.next("two\n");
    expect(w.manifest(two.manifestKey).full).toBe(true);
    expect(w.manifest(two.manifestKey).incarnation).toBe("incarnation-1");
  });

  test("a member that joins forgets what an earlier membership under the name left beside its key", async () => {
    const w = await world();
    await w.next("one\n");
    await w.pullReplica(0);
    expect(existsSync(w.replica.keyFile + ".trust.json")).toBe(true);
    FleetTrust.forget(w.replica.keyFile);
    expect(existsSync(w.replica.keyFile + ".trust.json")).toBe(false);
    // It learns again from what it is told, and the key itself is kept.
    expect(existsSync(w.replica.keyFile)).toBe(true);
    expect((await w.pullReplica(0)).seq).toBe(1);
    expect(FleetTrust.beside(w.replica.keyFile).incarnation).toBe("incarnation-1");
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
