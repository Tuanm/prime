// What a member does with a fleet whose roster is signed with an owner key: seal only for the members the chain names,
// take in only the snapshots of keys the chain says were members' then, and believe no chain that is another's,
// older, or not one. And the signing key a member makes for it.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOrCreateKeyPair, loadOrCreateSignKey, publish, pull, rotateKeyPair, type MemberPaths } from "../src/fleet-agent";
import { generateOwnerKey, makeEntry, ownerFingerprint, signEntry, type OwnerKey, type RosterEntry, type SignedEntry } from "../src/fleet-roster";
import { FleetTrust, RosterRefusedError, TamperedSnapshotError, forgetIncarnationAnswers, forgetRosterAnswers } from "../src/fleet-trust";
import type { FleetManifest } from "../src/fleet-transport";

import { FakeGateway, credsFor, useFakeGateway } from "./fleet-fake-gateway";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

const roots: string[] = [];
afterEach(() => {
  (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

class Chain {
  entries: SignedEntry[] = [];
  at = 1000;
  constructor(
    readonly owner: OwnerKey,
    readonly incarnation = "incarnation-1",
  ) {
    this.push({ op: "genesis", seqAt: 0, extra: owner.publicKey });
  }
  push(f: { op: RosterEntry[6]; device?: string; xpub?: string; spub?: string; role?: string; seqAt?: number | null; extra?: string }, signer = this.owner): SignedEntry {
    const prev = this.entries[this.entries.length - 1];
    const entry = makeEntry({
      fleet: "x",
      incarnation: this.incarnation,
      n: this.entries.length,
      prevHash: prev ? hashOf(prev) : null,
      at: this.at++,
      ...f,
    });
    const signed = { entry, sig: signEntry(entry, signer.privateKeyPem) };
    this.entries.push(signed);
    return signed;
  }
  add(device: string, xpub: string, role = "member", seqAt = 0): void {
    this.push({ op: "add", device, xpub, spub: generateOwnerKey().publicKey, role, seqAt });
  }
  copy(n = this.entries.length): SignedEntry[] {
    return this.entries.slice(0, n);
  }
}

import { entryHash } from "../src/fleet-roster";
const hashOf = entryHash;

interface World {
  root: string;
  gateway: FakeGateway;
  owner: OwnerKey;
  chain: Chain;
  primary: MemberPaths;
  replica: MemberPaths;
  serve(entries: SignedEntry[]): void;
  next(content: string): Promise<Awaited<ReturnType<typeof publish>>>;
  pullReplica(from: number): ReturnType<typeof pull>;
  manifest(key: string): FleetManifest;
}

function world(options: { signed?: boolean } = {}): World {
  forgetIncarnationAnswers();
  forgetRosterAnswers();
  const root = mkdtempSync(join(tmpdir(), "fleet-signed-"));
  roots.push(root);
  const gateway = new FakeGateway();
  useFakeGateway(gateway);
  const work = join(root, "primary");
  mkdirSync(work, { recursive: true });
  mkdirSync(join(root, "replica"), { recursive: true });
  const primary: MemberPaths = { work, gitDir: join(root, "p-meta"), keyFile: join(root, "p.key") };
  const replica: MemberPaths = { work: join(root, "replica"), gitDir: join(root, "r-meta"), keyFile: join(root, "r.key") };
  const pk = loadOrCreateKeyPair(primary.keyFile).publicKey;
  const rk = loadOrCreateKeyPair(replica.keyFile).publicKey;
  gateway.seed("primary-device", pk);
  gateway.seed("replica-device", rk);
  const owner = generateOwnerKey();
  const chain = new Chain(owner);
  chain.add("primary-device", pk);
  chain.add("replica-device", rk);
  let last: { seq: number; commit: string } | null = null;
  const w: World = {
    root,
    gateway,
    owner,
    chain,
    primary,
    replica,
    serve(entries) {
      forgetRosterAnswers();
      gateway.roster = { mode: "signed", entries };
    },
    async next(content) {
      writeFileSync(join(work, "file.txt"), content);
      forgetRosterAnswers();
      const out = await publish(credsFor("primary-device"), "x", primary, last?.commit ?? null, last?.seq ?? 0, 2);
      last = out;
      return out;
    },
    pullReplica(from) {
      forgetRosterAnswers();
      return pull(credsFor("replica-device"), "x", replica, from);
    },
    manifest: (key) => JSON.parse(gateway.payloads.get(key)!.toString("utf8")) as FleetManifest,
  };
  if (options.signed !== false) w.serve(chain.copy());
  return w;
}

describe("the signing key a member makes", () => {
  test("is made when first asked for, kept in the key file, and the same every time after", () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-sign-"));
    roots.push(root);
    const file = join(root, "m.key");
    const pair = loadOrCreateKeyPair(file);
    expect(JSON.parse(readFileSync(file, "utf8")).sign).toBeUndefined();
    const a = loadOrCreateSignKey(file);
    const b = loadOrCreateSignKey(file);
    expect(a).toEqual(b);
    expect(a.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.privateKey).toContain("PRIVATE KEY");
    expect(loadOrCreateKeyPair(file).publicKey).toBe(pair.publicKey);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("survives a rotation of the key pair: the roster names it, and the pair is another thing", () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-sign-"));
    roots.push(root);
    const file = join(root, "m.key");
    loadOrCreateKeyPair(file);
    const before = loadOrCreateSignKey(file);
    const rotated = rotateKeyPair(file);
    expect(loadOrCreateKeyPair(file).publicKey).toBe(rotated.publicKey);
    expect(loadOrCreateSignKey(file)).toEqual(before);
  });
});

describe("a fleet whose roster is signed", () => {
  test("is published and taken in as before, and the member pins the owner key the first time it sees the chain", async () => {
    const w = world();
    const one = await w.next("one\n");
    expect(one.unrostered).toBeUndefined();
    const pulled = await w.pullReplica(0);
    expect(pulled.applied).toBe(true);
    expect(readFileSync(join(w.replica.work, "file.txt"), "utf8")).toBe("one\n");
    const trust = FleetTrust.beside(w.replica.keyFile);
    expect(trust.ownerFp).toBe(ownerFingerprint(w.owner.publicKey).replace(/-/g, ""));
    expect(trust.rosterHead?.n).toBe(w.chain.entries.length - 1);
  });

  test("a key the gateway adds to its list is not sealed for: the publisher names it and skips it", async () => {
    const w = world();
    const evil = loadOrCreateKeyPair(join(w.root, "evil.key"));
    w.gateway.seed("gateway-spy", evil.publicKey);
    const out = await w.next("secret\n");
    expect(out.unrostered).toEqual(["gateway-spy"]);
    const m = w.manifest(out.manifestKey);
    expect(m.wrapped.map((x) => x.memberId).sort()).toEqual(["primary-device", "replica-device"]);
  });

  test("a member whose key the gateway swapped is not sealed for either: the chain's key is the one that counts", async () => {
    const w = world();
    const evil = loadOrCreateKeyPair(join(w.root, "evil.key"));
    w.gateway.members.get("replica-device")!.pubkey = evil.publicKey;
    const out = await w.next("secret\n");
    expect(out.unrostered).toEqual(["replica-device"]);
    expect(w.manifest(out.manifestKey).wrapped.map((x) => x.memberId)).toEqual(["primary-device"]);
  });

  test("an open roster is sealed for everyone the gateway lists, as it always was (nothing is skipped)", async () => {
    const w = world({ signed: false });
    const evil = loadOrCreateKeyPair(join(w.root, "evil.key"));
    w.gateway.seed("another", evil.publicKey);
    const out = await w.next("one\n");
    expect(out.members).toBe(3);
    expect(out.unrostered).toBeUndefined();
    expect(FleetTrust.beside(w.primary.keyFile).ownerFp).toBeUndefined();
  });

  test("a viewer reads, and does not publish: the roster has no place for its snapshots", async () => {
    const w = world();
    w.chain.entries.length = 0;
    w.chain.push({ op: "genesis", seqAt: 0, extra: w.owner.publicKey });
    w.chain.add("primary-device", loadOrCreateKeyPair(w.primary.keyFile).publicKey, "viewer");
    w.chain.add("replica-device", loadOrCreateKeyPair(w.replica.keyFile).publicKey);
    w.serve(w.chain.copy());
    await expect(w.next("one\n")).rejects.toThrow(/does not let this member publish/);
  });

  test("a snapshot after its publisher was removed is refused, and the ones before it are taken", async () => {
    const w = world();
    await w.next("one\n");
    const two = await w.next("two\n");
    expect(two.seq).toBe(2);
    // The operator removes the primary as of snapshot 1; the gateway then serves the longer chain.
    w.chain.push({ op: "remove", device: "primary-device", seqAt: 1 });
    w.serve(w.chain.copy());
    await expect(w.pullReplica(0)).rejects.toBeInstanceOf(TamperedSnapshotError);
    expect(existsSync(join(w.replica.work, "file.txt")) ? readFileSync(join(w.replica.work, "file.txt"), "utf8") : "").not.toBe("two\n");
  });

  test("a chain that is not the owner's is refused by a member that pinned the owner", async () => {
    const w = world();
    await w.next("one\n");
    FleetTrust.pinOwner(w.replica.keyFile, ownerFingerprint(generateOwnerKey().publicKey));
    await expect(w.pullReplica(0)).rejects.toBeInstanceOf(TamperedSnapshotError);
    await expect(w.pullReplica(0)).rejects.toThrow(/owner key|genesis/);
  });

  test("a chain forged by the gateway with a key of its own is refused when the owner is pinned", async () => {
    const w = world();
    await w.next("one\n");
    FleetTrust.pinOwner(w.replica.keyFile, ownerFingerprint(w.owner.publicKey));
    const gatewayKey = generateOwnerKey();
    const forged = new Chain(gatewayKey);
    forged.add("primary-device", loadOrCreateKeyPair(w.primary.keyFile).publicKey);
    forged.add("replica-device", loadOrCreateKeyPair(w.replica.keyFile).publicKey);
    w.serve(forged.copy());
    await expect(w.pullReplica(0)).rejects.toBeInstanceOf(TamperedSnapshotError);
  });

  test("an older chain than the member has seen is a rollback, and is refused", async () => {
    const w = world();
    await w.next("one\n");
    await w.pullReplica(0);
    w.chain.add("third-device", loadOrCreateKeyPair(join(w.root, "t.key")).publicKey);
    w.serve(w.chain.copy());
    await w.next("two\n");
    await w.pullReplica(1); // sees the longer chain
    expect(FleetTrust.beside(w.replica.keyFile).rosterHead?.n).toBe(3);
    w.serve(w.chain.copy(3));
    // Neither the publisher nor the replica, which have both seen the longer chain, takes the shorter one.
    await expect(w.next("three\n")).rejects.toThrow(/roll|older|contain|fork|behind/i);
    await expect(w.pullReplica(0)).rejects.toThrow(/roll|older|contain|fork|behind/i);
  });

  test("a gateway that says the roster is not signed, to a member that has seen it signed, is refused", async () => {
    const w = world();
    await w.next("one\n");
    await w.pullReplica(0);
    forgetRosterAnswers();
    w.gateway.roster = undefined;
    await expect(w.next("two\n")).rejects.toBeInstanceOf(Error);
    await expect(w.next("two\n")).rejects.toThrow(/not signed/);
    const trust = FleetTrust.beside(w.replica.keyFile);
    await expect(trust.verifiedRoster(credsFor("replica-device"), "x")).rejects.toBeInstanceOf(RosterRefusedError);
  });

  test("the fleet it names is the fleet: a snapshot of another incarnation is refused even where the gateway says it is this one", async () => {
    const w = world();
    // The chain is for "incarnation-1"; the gateway tells the publisher it is "other".
    w.gateway.incarnation = "other";
    await w.next("one\n");
    await expect(w.pullReplica(0)).rejects.toThrow(/earlier fleet/);
  });

  test("a forged entry (signed with another key) makes the chain unusable: nothing is taken in", async () => {
    const w = world();
    await w.next("one\n");
    const stranger = generateOwnerKey();
    const bad = new Chain(w.owner);
    bad.entries = w.chain.copy();
    bad.push({ op: "add", device: "spy", xpub: loadOrCreateKeyPair(join(w.root, "s.key")).publicKey, spub: stranger.publicKey, role: "member", seqAt: 0 }, stranger);
    w.serve(bad.entries);
    await expect(w.pullReplica(0)).rejects.toBeInstanceOf(TamperedSnapshotError);
    expect(existsSync(join(w.replica.work, "file.txt"))).toBe(false);
  });
});
