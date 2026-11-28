// Epoch keys: a copy of a member's key file opens the snapshots of the epochs it still holds, and no more.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chooseRoute, loadOrCreateKeyPair, loadOrCreateSignKey, publish, pull, rotateKeyPair, type MemberPaths } from "../src/fleet-agent";
import { generateEpochKey, generateMemberKeyPair, openPayload, sealManyForMembers, type EpochKey } from "../src/fleet-crypto";
import { EPOCH_GRACE_MS, countTakenIn, epochsAfterPrune, epochsAfterTakenIn, ensureEpoch, epochEntry, epochSettings, epochsToWrapTo, noteEpochTakenIn, pruneEpochs, readEpochs, resetEpochThrottle, signEpochEntry, tickEpoch } from "../src/fleet-epoch";
import { updateKeyFile } from "../src/fleet-keyfile";
import { forgetIncarnationAnswers } from "../src/fleet-trust";
import { EPOCH_CAP, fetchManifest, getPayload, type FleetManifest } from "../src/fleet-transport";

import { FakeGateway, credsFor, fingerprint, sameTree, useFakeGateway } from "./fleet-fake-gateway";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

const roots: string[] = [];
describe("epoch keys", () => {
  beforeEach(() => {
    resetEpochThrottle();
    delete process.env.PRIME_FLEET_EPOCH;
    delete process.env.PRIME_FLEET_EPOCH_HOURS;
  });
  afterEach(() => {
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
    delete process.env.PRIME_FLEET_EPOCH;
  });

  const HOUR = 3_600_000;

  interface World {
    gateway: FakeGateway;
    primary: MemberPaths;
    replica: MemberPaths;
    work: string;
    /** Publish a change. */
    next(content: string): Promise<Awaited<ReturnType<typeof publish>>>;
    pullReplica(): Promise<Awaited<ReturnType<typeof pull>>>;
    /** Make the replica's newest epoch key a day old, and let it make and post the next. */
    turn(who: "primary" | "replica"): Promise<void>;
    manifests(): FleetManifest[];
  }

  async function world(opts: { epochSupport?: boolean } = {}): Promise<World> {
    forgetIncarnationAnswers();
    const root = mkdtempSync(join(tmpdir(), "fleet-epoch-"));
    roots.push(root);
    const gateway = new FakeGateway();
    gateway.epochSupport = opts.epochSupport ?? true;
    // Every member of this fleet lists the capability (what the members' own bootstrap says).
    gateway.fleetCaps = [EPOCH_CAP];
    useFakeGateway(gateway);
    const work = join(root, "primary");
    mkdirSync(work, { recursive: true });
    mkdirSync(join(root, "replica"), { recursive: true });
    const primary: MemberPaths = { work, gitDir: join(root, "p-meta"), keyFile: join(root, "p.key") };
    const replica: MemberPaths = { work: join(root, "replica"), gitDir: join(root, "r-meta"), keyFile: join(root, "r.key") };
    gateway.seed("primary-device", loadOrCreateKeyPair(primary.keyFile).publicKey);
    gateway.seed("replica-device", loadOrCreateKeyPair(replica.keyFile).publicKey);
    gateway.spubs.set("primary-device", loadOrCreateSignKey(primary.keyFile).publicKey);
    gateway.spubs.set("replica-device", loadOrCreateSignKey(replica.keyFile).publicKey);
    let last: Awaited<ReturnType<typeof publish>> | null = null;
    let at = { seq: 0, commit: null as string | null };
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
      async pullReplica() {
        const got = await pull(credsFor("replica-device"), "x", replica, at.seq, at.commit);
        if (got.applied) at = { seq: got.seq, commit: got.commit };
        return got;
      },
      async turn(who) {
        const paths = who === "primary" ? primary : replica;
        const device = who === "primary" ? "primary-device" : "replica-device";
        updateKeyFile(paths.keyFile, (p) => ({ ...p, epochs: (p.epochs ?? []).map((e) => ({ ...e, createdAt: e.createdAt - 25 * HOUR })) }));
        resetEpochThrottle();
        await tickEpoch(credsFor(device), "x", paths.keyFile, loadOrCreateSignKey(paths.keyFile));
      },
      manifests() {
        return [...gateway.payloads.entries()]
          .filter(([k]) => k.includes("/manifests/"))
          .map(([, v]) => JSON.parse(v.toString("utf8")) as FleetManifest)
          .sort((a, b) => a.seq - b.seq);
      },
    };
  }

  /** The snapshots (by sequence) that a copy of this key file opens, with the packs the gateway holds. */
  function opensWith(w: World, copy: string): number[] {
    const keys = loadOrCreateKeyPair(copy);
    const out: number[] = [];
    for (const m of w.manifests()) {
      const packKey = [...w.gateway.payloads.keys()].find((k) => k.endsWith("/packs/" + m.packKey.split("/").pop()));
      if (!packKey) continue;
      const opened = openPayload(w.gateway.payloads.get(packKey)!, m.wrapped, m.senderPublicKey, "replica-device", keys.privateKey, m.incarnation, { ...(m.epk ? { epk: m.epk } : {}), keys: keys.epochs ?? [] });
      if (opened) out.push(m.seq);
    }
    return out;
  }

  describe("the key file", () => {
    test("a key file taken after three epochs opens only the snapshots of the epoch it still holds", async () => {
      const w = await world();
      // Epoch 1 for both members, then a snapshot, and the replica takes it in.
      await w.turn("primary");
      await w.turn("replica");
      await w.next("one\n");
      await w.pullReplica();
      // Two more epochs, a snapshot wrapped to each, each taken in.
      for (const text of ["two\n", "three\n"]) {
        await w.turn("replica");
        await w.next(text);
        await w.pullReplica();
      }
      const seqs = w.manifests().map((m) => m.seq);
      expect(seqs.length).toBe(3);
      // The replica has taken in a snapshot of epoch 3: a little later, the older private halves are gone.
      pruneEpochs(w.replica.keyFile, Date.now() + EPOCH_GRACE_MS + 1);
      expect(readEpochs(w.replica.keyFile).map((e) => e.n)).toEqual([3]);
      const stolen = join(roots[0]!, "stolen.key");
      copyFileSync(w.replica.keyFile, stolen);
      // Before this change every snapshot the gateway held opened with the long-term key alone.
      expect(opensWith(w, stolen)).toEqual([3]);
    });

    test("the newest epoch key is never deleted, however old, and an older one only after a newer one was taken in", () => {
      const keyFile = join(mkdtempSync(join(tmpdir(), "fleet-epoch-k-")), "k.key");
      roots.push(join(keyFile, ".."));
      loadOrCreateKeyPair(keyFile);
      const t0 = 1_000_000_000_000;
      updateKeyFile(keyFile, (p) => ({ ...p, epochs: [generateEpochKey(1, t0), generateEpochKey(2, t0 + HOUR)] }));
      // Nothing was taken in: nothing is let go of before the hard limit.
      expect(pruneEpochs(keyFile, t0 + 3 * HOUR)).toBe(0);
      noteEpochTakenIn(keyFile, 2, t0 + 3 * HOUR);
      // The grace is not over.
      expect(pruneEpochs(keyFile, t0 + 3 * HOUR + EPOCH_GRACE_MS - 1)).toBe(0);
      expect(pruneEpochs(keyFile, t0 + 3 * HOUR + EPOCH_GRACE_MS)).toBe(1);
      expect(readEpochs(keyFile).map((e) => e.n)).toEqual([2]);
      // The newest goes on for ever: a member that was away for a year still holds the one the fleet wrapped to.
      expect(pruneEpochs(keyFile, t0 + 400 * 24 * HOUR)).toBe(0);
    });

    test("an epoch kept past the hard limit is deleted though nothing newer was taken in", () => {
      const keyFile = join(mkdtempSync(join(tmpdir(), "fleet-epoch-k-")), "k.key");
      roots.push(join(keyFile, ".."));
      loadOrCreateKeyPair(keyFile);
      const t0 = 1_000_000_000_000;
      updateKeyFile(keyFile, (p) => ({ ...p, epochs: [generateEpochKey(1, t0), generateEpochKey(2, t0 + 30 * 24 * HOUR)] }));
      // 2 x 24 h + 7 d after the first.
      expect(pruneEpochs(keyFile, t0 + 9 * 24 * HOUR - 1)).toBe(0);
      expect(pruneEpochs(keyFile, t0 + 9 * 24 * HOUR)).toBe(1);
    });

    test("a random fetch lag never loses a snapshot that was not yet taken in", () => {
      // The publisher wraps to the newest epoch its view of the fleet has, which is behind by up to half the grace; the member takes snapshots in in
      // order, after a lag of its own, and prunes after each. Every snapshot it takes in is one it can open.
      let seed = 11;
      const rnd = (n: number): number => {
        seed = (seed * 48271) % 2147483647;
        return seed % n;
      };
      for (let round = 0; round < 40; round++) {
        let now = 2_000_000_000_000;
        let epochs: EpochKey[] = [generateEpochKey(1, now)];
        const queue: number[] = [];
        for (let step = 0; step < 80; step++) {
          now += rnd(6 * HOUR);
          if (rnd(3) === 0) epochs = [...epochs, generateEpochKey(epochs[epochs.length - 1]!.n + 1, now)];
          // What the publisher has seen of the member's keys trails by less than the grace.
          const lag = rnd(EPOCH_GRACE_MS / 2);
          const seen = [...epochs].filter((e) => e.createdAt <= now - lag);
          queue.push(seen.length > 0 ? seen[seen.length - 1]!.n : 1);
          for (let i = rnd(3); i > 0 && queue.length > 0; i--) {
            const wrappedTo = queue.shift()!;
            expect(
              epochs.map((e) => e.n),
              "round " + round + " step " + step,
            ).toContain(wrappedTo);
            epochs = epochsAfterTakenIn(epochs, wrappedTo, now) ?? epochs;
          }
          epochs = epochsAfterPrune(epochs, now);
        }
      }
    });
  });

  describe("sealing and opening", () => {
    test("a snapshot key wrapped to an epoch key opens with its private half and with nothing else of the member's", () => {
      const sender = generateMemberKeyPair();
      const member = generateMemberKeyPair();
      const epoch = generateEpochKey(4);
      const sealed = sealManyForMembers([Buffer.from("secret")], [{ memberId: "m", publicKey: member.publicKey, epoch: { n: 4, publicKey: epoch.publicKey } }], sender.privateKey, sender.publicKey);
      expect(sealed.epk).toBeDefined();
      expect(sealed.wrapped[0]!.epoch).toBe(4);
      const fields = { fleet: "x", seq: 1, parentSeq: null, parentManifest: null, tipCommit: "a", tree: "b", full: true, packHash: "h", deltaHash: null, senderPublicKey: sender.publicKey, roster: "r", incarnation: null };
      const seal = sealed.seal(fields);
      const open = (epochs: EpochKey[], priv = member.privateKey) => openPayload(sealed.ciphertexts[0]!, sealed.wrapped, sender.publicKey, "m", priv, undefined, { epk: sealed.epk, keys: epochs });
      const got = open([epoch]);
      expect(got?.plain.toString()).toBe("secret");
      // The seal and the tag the sender made for this member are what they always were.
      expect(got?.sealMatches(fields, seal)).toBe(true);
      expect(got?.macMatches(fields)).toBe(true);
      // The long-term key alone does not open it, nor does another epoch's, nor does a copy taken after the epoch was deleted.
      expect(open([])).toBeNull();
      expect(open([generateEpochKey(4)])).toBeNull();
      expect(open([{ ...generateEpochKey(5) }])).toBeNull();
      expect(openPayload(sealed.ciphertexts[0]!, sealed.wrapped, sender.publicKey, "m", member.privateKey)).toBeNull();
      // The sender's own key does not give it back either: the ephemeral key it was wrapped with is not kept.
      expect(openPayload(sealed.ciphertexts[0]!, sealed.wrapped, member.publicKey, "m", sender.privateKey, undefined, { epk: sealed.epk, keys: [epoch] })).toBeNull();
    });

    test("a member without an epoch key is wrapped as it always was, beside one that has", () => {
      const sender = generateMemberKeyPair();
      const old = generateMemberKeyPair();
      const fresh = generateMemberKeyPair();
      const epoch = generateEpochKey(1);
      const sealed = sealManyForMembers(
        [Buffer.from("x")],
        [
          { memberId: "old", publicKey: old.publicKey },
          { memberId: "fresh", publicKey: fresh.publicKey, epoch: { n: 1, publicKey: epoch.publicKey } },
        ],
        sender.privateKey,
        sender.publicKey,
      );
      expect(sealed.wrapped.find((w) => w.memberId === "old")!.epoch).toBeUndefined();
      expect(openPayload(sealed.ciphertexts[0]!, sealed.wrapped, sender.publicKey, "old", old.privateKey)?.plain.toString()).toBe("x");
      expect(openPayload(sealed.ciphertexts[0]!, sealed.wrapped, sender.publicKey, "fresh", fresh.privateKey, undefined, { epk: sealed.epk, keys: [epoch] })?.plain.toString()).toBe("x");
    });

    test("no epoch key anywhere: the manifest has no epk and nothing changes in it", () => {
      const sender = generateMemberKeyPair();
      const m = generateMemberKeyPair();
      const sealed = sealManyForMembers([Buffer.from("x")], [{ memberId: "m", publicKey: m.publicKey }], sender.privateKey, sender.publicKey);
      expect(sealed.epk).toBeUndefined();
      expect(sealed.wrapped[0]).not.toHaveProperty("epoch");
    });
  });

  describe("through a fleet", () => {
    test("the first key is made and posted with a signature the gateway checks, and a snapshot is wrapped to it", async () => {
      const w = await world();
      await w.next("one\n");
      // The primary made and posted one in passing (the gateway took its signature against its signing key).
      expect(w.gateway.epochPosts.length).toBe(1);
      const posted = w.gateway.epochPosts[0]!;
      expect(posted.slice(0, 2)).toEqual(["prime-epoch-v1", "x"]);
      expect(posted[2]).toBe("incarnation-1");
      expect(posted[3]).toBe("primary-device");
      expect(readEpochs(w.primary.keyFile)[0]!.posted).toBe(loadOrCreateSignKey(w.primary.keyFile).publicKey);
      // The replica asks the same way; the next snapshot is wrapped to both.
      await w.pullReplica();
      expect(w.gateway.epochPosts.length).toBe(2);
      await w.next("two\n");
      const m = w.manifests()[1]!;
      expect(m.epk).toBeDefined();
      expect(m.wrapped.map((e) => e.epoch)).toEqual([1, 1]);
      // And the replica reads it with its epoch key.
      const got = await w.pullReplica();
      expect(got.applied).toBe(true);
      expect(readFileSync(join(w.replica.work, "file.txt"), "utf8")).toBe("two\n");
    });

    test("an epoch key signed by a key that is not the member's is not wrapped to", async () => {
      const w = await world();
      const stderr: string[] = [];
      const real = process.stderr.write.bind(process.stderr);
      (process.stderr as { write: unknown }).write = (s: string | Uint8Array): boolean => {
        stderr.push(String(s));
        return true;
      };
      try {
        await w.next("one\n");
        await w.pullReplica();
        // The gateway puts a key of its own in place of the replica's, signed by a key of its own.
        const evil = generateKeyPairSync("ed25519");
        const pub = generateEpochKey(9).publicKey;
        const notAfter = Date.now() + 48 * HOUR;
        const entry = epochEntry("x", "incarnation-1", "replica-device", 9, pub, notAfter);
        const sig = cryptoSign(null, Buffer.from(JSON.stringify(entry)), evil.privateKey).toString("base64url");
        w.gateway.epochKeys.set("replica-device", { n: 9, pub, notAfter, sig });
        await w.next("two\n");
      } finally {
        (process.stderr as { write: unknown }).write = real;
      }
      const m = w.manifests()[1]!;
      expect(m.wrapped.find((e) => e.memberId === "replica-device")!.epoch).toBeUndefined();
      expect(stderr.join("")).toContain("not signed by its signing key");
      // The replica reads it, as it always did.
      expect((await w.pullReplica()).applied).toBe(true);
    });

    test("an epoch key whose time is over is not wrapped to", async () => {
      const w = await world();
      await w.next("one\n");
      await w.pullReplica();
      const held = w.gateway.epochKeys.get("replica-device")!;
      w.gateway.epochKeys.set("replica-device", { ...held, notAfter: Date.now() - 1000 });
      await w.next("two\n");
      expect(w.manifests()[1]!.wrapped.find((e) => e.memberId === "replica-device")!.epoch).toBeUndefined();
      expect((await w.pullReplica()).applied).toBe(true);
    });

    test("a gateway with no such route gets no more asking for an hour, and the key file is left as it was", async () => {
      const w = await world({ epochSupport: false });
      await w.next("one\n");
      await w.next("two\n");
      await w.pullReplica();
      expect(w.gateway.requests.get("POST epoch-key")).toBe(2);
      expect(readEpochs(w.primary.keyFile)).toEqual([]);
      expect(readEpochs(w.replica.keyFile)).toEqual([]);
      expect(w.manifests().every((m) => m.epk === undefined)).toBe(true);
    });

    test("PRIME_FLEET_EPOCH=off makes no key and wraps to none", async () => {
      process.env.PRIME_FLEET_EPOCH = "off";
      const w = await world();
      await w.next("one\n");
      await w.pullReplica();
      await w.next("two\n");
      expect(w.gateway.requests.get("POST epoch-key")).toBeUndefined();
      expect(w.manifests().every((m) => m.epk === undefined)).toBe(true);
      expect(readEpochs(w.replica.keyFile)).toEqual([]);
    });

    test("a gateway that holds a later number than the file has the key numbered after it", async () => {
      const w = await world();
      const spub = loadOrCreateSignKey(w.replica.keyFile).publicKey;
      expect(spub).toBeDefined();
      const pub = generateEpochKey(1).publicKey;
      const entry = epochEntry("x", "incarnation-1", "replica-device", 7, pub, Date.now() + 48 * HOUR);
      w.gateway.epochKeys.set("replica-device", { n: 7, pub, notAfter: Date.now() + 48 * HOUR, sig: signEpochEntry(entry, loadOrCreateSignKey(w.replica.keyFile).privateKey) });
      await tickEpoch(credsFor("replica-device"), "x", w.replica.keyFile, loadOrCreateSignKey(w.replica.keyFile));
      // Refused for being behind; numbered after the one the fleet holds, and posted at the next asking.
      // (The key that was refused is kept as it is: snapshots may be wrapped to it.)
      expect(readEpochs(w.replica.keyFile).map((e) => e.n)).toEqual([1, 8]);
      resetEpochThrottle();
      await tickEpoch(credsFor("replica-device"), "x", w.replica.keyFile, loadOrCreateSignKey(w.replica.keyFile));
      expect(w.gateway.epochKeys.get("replica-device")!.n).toBe(8);
    });

    test("a signing key that changed has the key posted again under the new one", async () => {
      const w = await world();
      await w.pullReplica().catch(() => undefined);
      await tickEpoch(credsFor("replica-device"), "x", w.replica.keyFile, loadOrCreateSignKey(w.replica.keyFile));
      expect(w.gateway.epochKeys.has("replica-device")).toBe(true);
      // The gateway drops its copy when the member's signing key changes; the key file's new signing key makes the same epoch key be posted again.
      w.gateway.epochKeys.delete("replica-device");
      updateKeyFile(w.replica.keyFile, (p) => {
        const fresh = generateKeyPairSync("ed25519");
        return {
          ...p,
          sign: { publicKey: fresh.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url"), privateKey: fresh.privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
        };
      });
      w.gateway.spubs.set("replica-device", loadOrCreateSignKey(w.replica.keyFile).publicKey);
      resetEpochThrottle();
      await tickEpoch(credsFor("replica-device"), "x", w.replica.keyFile, loadOrCreateSignKey(w.replica.keyFile));
      expect(w.gateway.epochKeys.get("replica-device")?.n).toBe(readEpochs(w.replica.keyFile)[0]!.n);
    });

    test("rotating the member's key pair makes a new signing key and a new epoch key, and keeps the old epoch keys until a snapshot wrapped to the new one is taken in", async () => {
      const w = await world();
      await tickEpoch(credsFor("replica-device"), "x", w.replica.keyFile, loadOrCreateSignKey(w.replica.keyFile));
      const before = readEpochs(w.replica.keyFile);
      const signBefore = loadOrCreateSignKey(w.replica.keyFile).publicKey;
      expect(before.length).toBe(1);
      const stolen = join(roots[0]!, "stolen.key");
      copyFileSync(w.replica.keyFile, stolen);
      rotateKeyPair(w.replica.keyFile);
      // A copy of the old key file no longer holds the member's signing key: what it signs is not what the fleet will have.
      expect(loadOrCreateSignKey(w.replica.keyFile).publicKey).not.toBe(signBefore);
      const after = readEpochs(w.replica.keyFile);
      expect(after.map((e) => e.n)).toEqual([1, 2]);
      expect(after[0]!.supersededAt).toBeUndefined();
      expect(after[1]!.posted).toBeUndefined();
      // Not let go of by time while nothing wrapped to the new key has been taken in.
      expect(pruneEpochs(w.replica.keyFile, Date.now() + EPOCH_GRACE_MS + 1000)).toBe(0);
      noteEpochTakenIn(w.replica.keyFile, 2, Date.now());
      expect(pruneEpochs(w.replica.keyFile, Date.now() + EPOCH_GRACE_MS + 1000)).toBe(1);
      expect(readEpochs(w.replica.keyFile).map((e) => e.n)).toEqual([2]);
    });

    test("while the fleet has not taken the rotated key (it waits for approval), the member still reads what is wrapped to its old epoch key, however long it waits", async () => {
      const w = await world();
      await w.next("one\n");
      const at = await w.pullReplica();
      await w.next("two\n");
      expect((await w.pullReplica()).applied).toBe(true);
      void at;
      rotateKeyPair(w.replica.keyFile);
      // Half an hour and more on, the agent's tick prunes.
      pruneEpochs(w.replica.keyFile, Date.now() + 31 * 60_000);
      expect(readEpochs(w.replica.keyFile).map((e) => e.n)).toEqual([1, 2]);
      // The primary still sees the replica's old key and epoch key 1 on /keys: it wraps to those.
      await w.next("three\n");
      expect((await w.pullReplica()).applied).toBe(true);
      expect(readFileSync(join(w.replica.work, "file.txt"), "utf8")).toBe("three\n");
    });

    test("after a rotation an epoch key signed by a copy of the old key file is not wrapped to", () => {
      const keyFile = join(mkdtempSync(join(tmpdir(), "fleet-epoch-r-")), "k.key");
      roots.push(join(keyFile, ".."));
      loadOrCreateKeyPair(keyFile);
      const old = loadOrCreateSignKey(keyFile);
      const stolen = join(keyFile, "..", "stolen.key");
      copyFileSync(keyFile, stolen);
      rotateKeyPair(keyFile);
      const now = loadOrCreateSignKey(keyFile);
      expect(now.publicKey).not.toBe(old.publicKey);
      // Whoever holds the copy signs an epoch key of its own with the signing key in it.
      const mine = generateEpochKey(1000);
      const notAfter = Date.now() + 48 * HOUR;
      const sig = signEpochEntry(epochEntry("x", "i", "d", 1000, mine.publicKey, notAfter), loadOrCreateSignKey(stolen).privateKey);
      const listed = [{ deviceId: "d", epochKey: { n: 1000, pub: mine.publicKey, notAfter, sig }, caps: [EPOCH_CAP] }];
      // The fleet's signing key for the member is the new one (the rotation reached it): the copy's signature does not hold.
      expect(epochsToWrapTo(listed, new Map([["d", now.publicKey]]), "x", "i").size).toBe(0);
      expect(epochsToWrapTo(listed, new Map([["d", old.publicKey]]), "x", "i").get("d")?.n).toBe(1000);
    });

    test("after a rotation the new epoch key is posted under the new signing key, once the fleet has the key", async () => {
      const w = await world();
      await w.next("one\n");
      await w.pullReplica();
      const fresh = rotateKeyPair(w.replica.keyFile);
      // What the gateway does with a member's new key and signing key: takes them, and drops its epoch key.
      w.gateway.seed("replica-device", fresh.publicKey);
      w.gateway.spubs.set("replica-device", loadOrCreateSignKey(w.replica.keyFile).publicKey);
      w.gateway.epochKeys.delete("replica-device");
      resetEpochThrottle();
      await tickEpoch(credsFor("replica-device"), "x", w.replica.keyFile, loadOrCreateSignKey(w.replica.keyFile));
      expect(w.gateway.epochKeys.get("replica-device")?.n).toBe(2);
    });

    test("a post whose answer was lost is sent again as it was, and the fleet says it has it: the key keeps its number", async () => {
      const w = await world();
      w.gateway.loseEpochAnswers = 1;
      await tickEpoch(credsFor("replica-device"), "x", w.replica.keyFile, loadOrCreateSignKey(w.replica.keyFile));
      // The fleet took it; the answer never came.
      expect(w.gateway.epochKeys.get("replica-device")?.n).toBe(1);
      expect(readEpochs(w.replica.keyFile)[0]!.posted).toBeUndefined();
      const held = { ...w.gateway.epochKeys.get("replica-device")! };
      // Asked again a while on (the throttle after a failure is ten minutes): the same entry goes, whatever the time.
      resetEpochThrottle();
      await tickEpoch(credsFor("replica-device"), "x", w.replica.keyFile, loadOrCreateSignKey(w.replica.keyFile), Date.now() + 11 * 60_000);
      expect(w.gateway.epochKeys.get("replica-device")).toEqual(held);
      expect(readEpochs(w.replica.keyFile).map((e) => [e.n, e.posted !== undefined])).toEqual([[1, true]]);
      // And the snapshots wrapped to it open.
      await w.next("one\n");
      await w.pullReplica();
      await w.next("two\n");
      expect((await w.pullReplica()).applied).toBe(true);
    });

    test("two processes of one member ticking at once send one entry, and the second is told it has it", async () => {
      const w = await world();
      const creds = credsFor("replica-device");
      const sign = loadOrCreateSignKey(w.replica.keyFile);
      const a = tickEpoch(creds, "x", w.replica.keyFile, sign);
      // The other process has its own throttle.
      const t0 = Date.now();
      const b = (async () => {
        await new Promise((r) => setTimeout(r, 0));
        const before = new Map<string, number>();
        void before;
        return tickEpoch(creds, "x", w.replica.keyFile, sign, t0 + 61_000);
      })();
      await Promise.all([a, b]);
      expect(readEpochs(w.replica.keyFile).map((e) => e.n)).toEqual([1]);
      expect(w.gateway.epochKeys.get("replica-device")?.n).toBe(1);
    });

    test("a snapshot wrapped to an epoch key that was deleted is one sealed for a key this member let go of, not a tampered one", async () => {
      const w = await world();
      await w.next("one\n");
      await w.pullReplica();
      await w.next("two\n");
      // The replica loses its epoch key (a restored backup of the key file from before it was made, say).
      updateKeyFile(w.replica.keyFile, (p) => {
        const { epochs: _gone, ...rest } = p;
        return rest;
      });
      const err = await w.pullReplica().then(
        () => null,
        (e: unknown) => e,
      );
      expect((err as Error | null)?.name ?? "").not.toBe("TamperedSnapshotError");
      expect(String((err as Error | null)?.constructor?.name)).toMatch(/NotSealed/);
    });

    test("the route does not go through a snapshot wrapped to an epoch the member no longer holds", () => {
      const entry = (epoch: number | undefined) => [{ memberId: "me", keyId: "k", wrapped: "", ...(epoch !== undefined ? { epoch } : {}) }];
      const m = (seq: number, full: boolean, epoch: number | undefined): FleetManifest =>
        ({ fleet: "x", seq, full, packBytes: 10, packKey: "p" + seq, delta: full ? { packKey: "d" + seq, packHash: "h", bytes: 1 } : undefined, wrapped: entry(epoch) }) as unknown as FleetManifest;
      // Newest first, as the walk gives it.
      const walked = [m(3, false, 2), m(2, true, 1), m(1, true, 1)];
      const held = chooseRoute(walked, 0, { memberId: "me", keyId: "k", epochs: [2] });
      // 3 is a change on 2, which is wrapped to a deleted epoch: nothing the member can open leads to it from 0.
      expect(held).toBeNull();
      expect(chooseRoute(walked, 0, { memberId: "me", keyId: "k", epochs: [1, 2] })).not.toBeNull();
    });

    test("the settings", () => {
      expect(epochSettings({}).lengthMs).toBe(24 * HOUR);
      expect(epochSettings({ PRIME_FLEET_EPOCH_HOURS: "6" }).lengthMs).toBe(6 * HOUR);
      expect(epochSettings({ PRIME_FLEET_EPOCH_HOURS: "0" }).lengthMs).toBe(24 * HOUR);
      expect(epochSettings({ PRIME_FLEET_EPOCH: "off" }).enabled).toBe(false);
      expect(epochSettings({ PRIME_FLEET_EPOCH: "on" }).enabled).toBe(true);
    });

    test("epochsToWrapTo checks the chain's signing key, not the gateway's", () => {
      const sign = (device: string, key: string, who: { privateKey: KeyObject }) => {
        const pub = generateEpochKey(1).publicKey;
        const notAfter = Date.now() + 48 * HOUR;
        const entry = epochEntry("x", "i", device, 1, pub, notAfter);
        return { pub, notAfter, n: 1, sig: cryptoSign(null, Buffer.from(JSON.stringify(entry)), who.privateKey).toString("base64url"), key };
      };
      const real = generateKeyPairSync("ed25519") as { publicKey: KeyObject; privateKey: KeyObject };
      const other = generateKeyPairSync("ed25519") as { publicKey: KeyObject; privateKey: KeyObject };
      const raw = (k: { publicKey: KeyObject }): string => k.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url");
      const posted = sign("d", "", real);
      const members = [{ deviceId: "d", spub: raw(other), epochKey: posted, caps: [EPOCH_CAP] }];
      // The gateway says d's signing key is `other`; the chain says it is `real`: the chain is believed.
      expect(epochsToWrapTo(members, new Map([["d", raw(real)]]), "x", "i").get("d")?.n).toBe(1);
      // The other way round: the gateway's word for it matches, the chain's does not.
      expect(epochsToWrapTo([{ deviceId: "d", spub: raw(real), epochKey: posted, caps: [EPOCH_CAP] }], new Map([["d", raw(other)]]), "x", "i").size).toBe(0);
      // A chain that does not name a signing key for the device wraps nothing to it.
      expect(epochsToWrapTo(members, new Map(), "x", "i").size).toBe(0);
      // Another fleet, another incarnation, another device: not this key.
      expect(epochsToWrapTo(members, new Map([["d", raw(real)]]), "y", "i").size).toBe(0);
      expect(epochsToWrapTo(members, new Map([["d", raw(real)]]), "x", "j").size).toBe(0);
      expect(epochsToWrapTo([{ deviceId: "e", epochKey: posted, caps: [EPOCH_CAP] }], new Map([["e", raw(real)]]), "x", "i").size).toBe(0);
      // A member that does not list the capability (an earlier build, rolled back to after it posted a key) is wrapped to as it always was.
      expect(epochsToWrapTo([{ deviceId: "d", spub: raw(other), epochKey: posted }], new Map([["d", raw(real)]]), "x", "i").size).toBe(0);
      expect(epochsToWrapTo([{ deviceId: "d", spub: raw(other), epochKey: posted, caps: ["meta2"] }], new Map([["d", raw(real)]]), "x", "i").size).toBe(0);
      // A fleet without an incarnation has no key to sign against.
      expect(epochsToWrapTo(members, null, "x", undefined).size).toBe(0);
    });
  });

  test("ensureEpoch makes the next key only when the newest was posted and is old enough, or enough snapshots were taken in", () => {
    const keyFile = join(mkdtempSync(join(tmpdir(), "fleet-epoch-e-")), "k.key");
    roots.push(join(keyFile, ".."));
    loadOrCreateKeyPair(keyFile);
    const t0 = Date.now();
    expect(ensureEpoch(keyFile, t0)?.n).toBe(1);
    // Not posted: not followed by another, however old.
    expect(ensureEpoch(keyFile, t0 + 48 * HOUR)?.n).toBe(1);
    updateKeyFile(keyFile, (p) => ({ ...p, epochs: p.epochs!.map((e) => ({ ...e, posted: "s" })) }));
    expect(ensureEpoch(keyFile, t0 + 23 * HOUR)?.n).toBe(1);
    expect(ensureEpoch(keyFile, t0 + 24 * HOUR)?.n).toBe(2);
    // 256 snapshots taken in is as good as a day.
    updateKeyFile(keyFile, (p) => ({ ...p, epochs: p.epochs!.map((e) => ({ ...e, posted: "s" })) }));
    for (let i = 0; i < 256; i++) countTakenIn(keyFile);
    expect(ensureEpoch(keyFile, t0 + 25 * HOUR)?.n).toBe(3);
  });
});

void fetchManifest;
void getPayload;
void copyFileSync;
void fingerprint;
void sameTree;
