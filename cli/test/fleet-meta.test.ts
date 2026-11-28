// The manifest the gateway stores says what it must (where the pack is, how big, who it is sealed for) and what the
// snapshot is (commit, tree, roster) only to a member: in a sealed metadata, which is all the gateway is shown once
// every member can read it.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOrCreateKeyPair, publish, pull, type MemberPaths } from "../src/fleet-agent";
import { wrapIdOf } from "../src/fleet-crypto";
import { TamperedSnapshotError, forgetIncarnationAnswers } from "../src/fleet-trust";
import { META_CAP, type FleetManifest } from "../src/fleet-transport";

import { FakeGateway, credsFor, fingerprint, sameTree, useFakeGateway } from "./fleet-fake-gateway";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

const roots: string[] = [];
afterEach(() => {
  (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

interface World {
  gateway: FakeGateway;
  primary: MemberPaths;
  replica: MemberPaths;
  work: string;
  next(content: string): Promise<Awaited<ReturnType<typeof publish>>>;
  manifest(key: string): FleetManifest;
  rawManifest(key: string): string;
  forge(m: FleetManifest): string;
  pullReplica(from: number, commit?: string): ReturnType<typeof pull>;
}

async function world(fleetCaps?: string[]): Promise<World> {
  forgetIncarnationAnswers();
  const root = mkdtempSync(join(tmpdir(), "fleet-meta-"));
  roots.push(root);
  const gateway = new FakeGateway();
  gateway.fleetCaps = fleetCaps;
  useFakeGateway(gateway);
  const work = join(root, "primary");
  mkdirSync(work, { recursive: true });
  mkdirSync(join(root, "replica"), { recursive: true });
  const primary: MemberPaths = { work, gitDir: join(root, "p-meta"), keyFile: join(root, "p.key") };
  const replica: MemberPaths = { work: join(root, "replica"), gitDir: join(root, "r-meta"), keyFile: join(root, "r.key") };
  gateway.seed("primary-device", loadOrCreateKeyPair(primary.keyFile).publicKey);
  gateway.seed("replica-device", loadOrCreateKeyPair(replica.keyFile).publicKey);
  let last: Awaited<ReturnType<typeof publish>> | null = null;
  return {
    gateway,
    primary,
    replica,
    work,
    async next(content) {
      writeFileSync(join(work, "file.txt"), content);
      last = await publish(credsFor("primary-device"), "x", primary, last?.commit ?? null, last?.seq ?? 0, 2, last?.roster);
      return last;
    },
    manifest: (key) => JSON.parse(gateway.payloads.get(key)!.toString("utf8")) as FleetManifest,
    rawManifest: (key) => gateway.payloads.get(key)!.toString("utf8"),
    forge(m) {
      const bytes = Buffer.from(JSON.stringify(m), "utf8");
      const key = "fleets/x/manifests/" + new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      gateway.payloads.set(key, bytes);
      gateway.head = { seq: m.seq, manifestKey: key, manifestHash: key.split("/").pop()!, epoch: 1 };
      gateway.indexEntries.push({ seq: m.seq, manifestKey: key, full: m.full, ...(m.packBytes !== undefined ? { packBytes: m.packBytes } : {}) });
      return key;
    },
    pullReplica: (from, commit) => pull(credsFor("replica-device"), "x", replica, from, commit),
  };
}

describe("while a member cannot read sealed metadata", () => {
  for (const caps of [undefined, [], ["chunks"]]) {
    test("the manifest carries it beside the plain fields (gateway says " + JSON.stringify(caps) + ")", async () => {
      const w = await world(caps);
      const one = await w.next("one\n");
      const m = w.manifest(one.manifestKey);
      expect(typeof m.meta).toBe("string");
      // As it always was, for a member that predates the metadata.
      expect(m.tipCommit).toBe(one.commit);
      expect(m.tree).toMatch(/^[0-9a-f]{40}$/);
      expect(m.roster).toBe(one.roster);
      expect(m.wrapped.map((e) => e.memberId).sort()).toEqual(["primary-device", "replica-device"]);
      const got = await w.pullReplica(0);
      expect(got.applied).toBe(true);
      expect(got.tree).toBe(m.tree);
      expect(got.roster).toBe(one.roster);
    });
  }

  test("a manifest whose plain fields were changed beside its metadata is refused", async () => {
    const w = await world();
    const one = await w.next("one\n");
    w.forge({ ...w.manifest(one.manifestKey), tree: "0".repeat(40) });
    await expect(w.pullReplica(0)).rejects.toBeInstanceOf(TamperedSnapshotError);
  });

  test("a manifest from a publisher that has no metadata opens as before", async () => {
    const w = await world();
    w.gateway.stripMeta = true;
    await w.next("one\n");
    const two = await w.next("two\n");
    expect(w.manifest(two.manifestKey).meta).toBeUndefined();
    const got = await w.pullReplica(0);
    expect(got.applied).toBe(true);
    expect(readFileSync(join(w.replica.work, "file.txt"), "utf8")).toBe("two\n");
  });
});

describe("when every member can read it", () => {
  test("the gateway is shown no commit, no tree, no roster and no device id", async () => {
    const w = await world([META_CAP]);
    const one = await w.next("one\n");
    const two = await w.next("two\n");
    for (const result of [one, two]) {
      const text = w.rawManifest(result.manifestKey);
      const m = w.manifest(result.manifestKey);
      expect(m.tipCommit).toBe("");
      expect(m.tree).toBe("");
      expect(m.roster).toBeUndefined();
      expect(text).not.toContain(result.commit);
      expect(text).not.toContain("primary-device");
      expect(text).not.toContain("replica-device");
      // Listed under ids that are not device ids, one for each member.
      expect(m.wrapped.map((e) => e.memberId).sort()).toEqual([wrapIdOf("incarnation-1", "primary-device"), wrapIdOf("incarnation-1", "replica-device")].sort());
    }
    const got = await w.pullReplica(0);
    expect(got.applied).toBe(true);
    expect(got.seq).toBe(2);
    // What the replica holds is what the primary published, though the manifest never said it.
    expect(got.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(w.rawManifest(two.manifestKey)).not.toContain(got.tree!);
    expect(got.roster).toBe(two.roster);
    expect(sameTree(fingerprint(w.work), fingerprint(w.replica.work))).toBe(true);
  });

  test("the keys of the packs stay in the clear, where the gateway's sweep reads them: packKey, and delta.packKey beside a whole tree", async () => {
    const w = await world([META_CAP]);
    await w.next("one\n");
    // A member that joins makes the next snapshot a whole tree, with the change beside it.
    w.gateway.seed("third-device", loadOrCreateKeyPair(join(roots[0]!, "third.key")).publicKey);
    const whole = await w.next("two\n");
    const delta = await w.next("three\n");
    expect(whole.full).toBe(true);
    for (const r of [whole, delta]) {
      const m = w.manifest(r.manifestKey);
      expect(m.tipCommit).toBe(""); // the sealed form is the one in use
      expect(m.packKey).toMatch(/^fleets\/x\/packs\/[0-9a-f]{64}$/);
      expect(m.packHash).toMatch(/^[0-9a-f]{64}$/);
      expect(w.gateway.payloads.has(m.packKey)).toBe(true);
      if (r === whole) {
        expect(m.delta?.packKey).toMatch(/^fleets\/x\/packs\/[0-9a-f]{64}$/);
        expect(w.gateway.payloads.has(m.delta!.packKey)).toBe(true);
      }
    }
  });

  test("a chain of changes is followed, a replica that was away and one that follows each", async () => {
    const w = await world([META_CAP]);
    await w.next("one\n");
    const first = await w.pullReplica(0);
    for (const c of ["two\n", "three\n", "four\n"]) await w.next(c);
    const got = await w.pullReplica(first.seq, first.commit);
    expect(got.seq).toBe(4);
    expect(readFileSync(join(w.replica.work, "file.txt"), "utf8")).toBe("four\n");
  });

  test("a metadata taken from one manifest and put on another does not open", async () => {
    const w = await world([META_CAP]);
    const one = await w.next("one\n");
    const two = await w.next("two\n");
    const m1 = w.manifest(one.manifestKey);
    const m2 = w.manifest(two.manifestKey);
    // Snapshot 2 with snapshot 1's metadata: its own fields are bound, so it is not another snapshot's.
    w.forge({ ...m2, meta: m1.meta });
    await expect(w.pullReplica(0)).rejects.toThrow(/sealed metadata does not open/);
  });

  test("a manifest with its metadata cut away is refused, not read as an empty snapshot", async () => {
    const w = await world([META_CAP]);
    const one = await w.next("one\n");
    const { meta: _meta, ...without } = w.manifest(one.manifestKey);
    w.forge(without as FleetManifest);
    await expect(w.pullReplica(0)).rejects.toBeInstanceOf(TamperedSnapshotError);
  });

  test("the fleet goes back to the plain form when a member that cannot read it appears, with a whole tree", async () => {
    const w = await world([META_CAP]);
    await w.next("one\n");
    const two = await w.next("two\n");
    expect(w.manifest(two.manifestKey).full).toBe(false);
    w.gateway.fleetCaps = [];
    const three = await w.next("three\n");
    const m = w.manifest(three.manifestKey);
    expect(m.full).toBe(true);
    expect(m.tipCommit).toBe(three.commit);
    expect(m.wrapped.map((e) => e.memberId).sort()).toEqual(["primary-device", "replica-device"]);
    const got = await w.pullReplica(0);
    expect(got.seq).toBe(3);
  });

  test("a member that appears in /keys without the cap keeps the snapshot in the plain form, whatever /role said a moment before", async () => {
    // /role says every member can read it (the answer from before the new member was admitted); /keys, read for the same publish, lists one that cannot
    const w = await world([META_CAP]);
    w.gateway.memberCaps.set("replica-device", []);
    const one = await w.next("one\n");
    const m = w.manifest(one.manifestKey);
    expect(m.tipCommit).toBe(one.commit);
    expect(m.wrapped.map((e) => e.memberId).sort()).toEqual(["primary-device", "replica-device"]);
    const got = await w.pullReplica(0);
    expect(got.seq).toBe(1);
  });

  test("the id a member is listed under depends on the fleet it is in and on the device", () => {
    const a = wrapIdOf("one", "device");
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(wrapIdOf("one", "device")).toBe(a);
    expect(wrapIdOf("two", "device")).not.toBe(a);
    expect(wrapIdOf("one", "other")).not.toBe(a);
    expect(wrapIdOf(undefined, "device")).toBe(wrapIdOf("", "device"));
  });
});

describe("the size of the sealed metadata", () => {
  test("what a reader would refuse for its size is left out of it, optional parts first, and the snapshot is still readable", async () => {
    const { generateMemberKeyPair, openPayload, sealManyForMembers } = await import("../src/fleet-crypto");
    const sender = generateMemberKeyPair();
    const me = generateMemberKeyPair();
    const sealed = sealManyForMembers([Buffer.from("tree")], [{ memberId: "me", publicKey: me.publicKey }], sender.privateKey, sender.publicKey);
    const binding = { fleet: "x", seq: 1, parentSeq: null, parentManifest: null, full: true, packHash: "p", deltaHash: null, senderPublicKey: sender.publicKey, incarnation: null };
    const big = { tipCommit: "c".repeat(40), tree: "t".repeat(40), roster: "r", actor: { key: "k", agent: "a", tools: [{ tool: "x".repeat(100), caller: "c", n: 1 }] }, kept: Array.from({ length: 400 }, (_, i) => "d" + i + "/" + "p".repeat(200)) };
    const blob = sealed.sealMeta(binding, big);
    const opened = openPayload(sealed.ciphertexts[0]!, sealed.wrapped, sender.publicKey, "me", me.privateKey)!;
    const meta = opened.openMeta(binding, blob)!;
    expect(meta.tipCommit).toBe(big.tipCommit);
    expect(meta.roster).toBe("r");
    // the actor fits and stays; the long list of paths is what goes
    expect(meta.actor).toEqual(big.actor);
    expect(meta.kept).toBeUndefined();
    // a metadata that cannot be made to fit is an error at the publisher, not a snapshot nobody reads
    expect(() => sealed.sealMeta(binding, { ...big, roster: "r".repeat(70_000) })).toThrow(/sealed metadata/);
  });
});

