// A snapshot too big for one request goes up in pieces, when the gateway takes them and every member can read
// them, and comes back the same: each piece checked as it arrives, and the whole against what the seal binds.
import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOrCreateKeyPair, publish, pull, type MemberPaths } from "../src/fleet-agent";
import { TamperedSnapshotError, forgetIncarnationAnswers } from "../src/fleet-trust";
import { CHUNKS_CAP, CHUNKED_BYTES_MAX, CHUNKS_MAX, chunkListProblem, getChunks, putChunks, type FleetManifest } from "../src/fleet-transport";

import { FakeGateway, credsFor, fingerprint, sameTree, useFakeGateway } from "./fleet-fake-gateway";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

const roots: string[] = [];
afterEach(() => {
  (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const KB = 1024;
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

interface World {
  gateway: FakeGateway;
  primary: MemberPaths;
  replica: MemberPaths;
  work: string;
}

// A tree of incompressible files (so its pack is about as big as its files), against a gateway that takes
// 600 KB in one request (a pack, and the room a manifest takes), a piece of 48 KB, and 4 MB in pieces.
async function world(opts: { caps?: string[]; files?: number; chunkedLimit?: number } = {}): Promise<World> {
  forgetIncarnationAnswers();
  const root = mkdtempSync(join(tmpdir(), "fleet-chunks-"));
  roots.push(root);
  const gateway = new FakeGateway();
  gateway.snapshotLimit = 600 * KB;
  gateway.advertiseLimit = true;
  gateway.chunkLimit = 48 * KB;
  gateway.chunkedLimit = opts.chunkedLimit ?? 4 * 1024 * KB;
  gateway.fleetCaps = opts.caps ?? [CHUNKS_CAP];
  useFakeGateway(gateway);
  const work = join(root, "primary");
  mkdirSync(work, { recursive: true });
  for (let i = 0; i < (opts.files ?? 12); i++) writeFileSync(join(work, "big" + i + ".bin"), randomBytes(40 * KB));
  const primary: MemberPaths = { work, gitDir: join(root, "p-meta"), keyFile: join(root, "p.key") };
  const replica: MemberPaths = { work: join(root, "replica"), gitDir: join(root, "r-meta"), keyFile: join(root, "r.key") };
  mkdirSync(replica.work, { recursive: true });
  gateway.seed("primary-device", loadOrCreateKeyPair(primary.keyFile).publicKey);
  gateway.seed("replica-device", loadOrCreateKeyPair(replica.keyFile).publicKey);
  return { gateway, primary, replica, work };
}

const manifestOf = (w: World, key: string): FleetManifest => JSON.parse(w.gateway.payloads.get(key)!.toString("utf8")) as FleetManifest;

describe("a snapshot bigger than one request", () => {
  test("is refused as it always was when the members cannot all read pieces", async () => {
    for (const caps of [undefined, [], ["meta2"]]) {
      const w = await world({ caps });
      w.gateway.fleetCaps = caps;
      await expect(publish(credsFor("primary-device"), "x", w.primary, null, 0, 2)).rejects.toThrow(/too big to publish/);
    }
  });

  test("is refused when one of the members listed with the keys cannot read pieces, whatever the gateway said a moment before", async () => {
    const w = await world();
    w.gateway.memberCaps.set("replica-device", []);
    await expect(publish(credsFor("primary-device"), "x", w.primary, null, 0, 2)).rejects.toThrow(/too big to publish/);
  });

  test("goes up in pieces and is applied by a replica", async () => {
    const w = await world();
    const first = await publish(credsFor("primary-device"), "x", w.primary, null, 0, 2);
    const m = manifestOf(w, first.manifestKey);
    expect(m.full).toBe(true);
    expect(m.chunks!.length).toBeGreaterThan(8);
    expect(m.chunks!.every((c) => c.bytes <= 48 * KB)).toBe(true);
    expect(m.chunks!.reduce((n, c) => n + c.bytes, 0)).toBe(m.packBytes!);
    // The seal binds the hash of the whole pack, which is what the manifest says; the key is the first piece's.
    expect(m.packKey).toBe("fleets/x/packs/" + m.chunks![0]!.hash);
    expect(m.packHash).not.toBe(m.chunks![0]!.hash);
    // Nothing of it travelled in the snapshot request itself.
    expect(w.gateway.payloads.has("fleets/x/packs/" + m.packHash)).toBe(false);
    const got = await pull(credsFor("replica-device"), "x", w.replica, 0);
    expect(got.applied).toBe(true);
    expect(sameTree(fingerprint(w.work), fingerprint(w.replica.work))).toBe(true);
  });

  test("pieces go up four at a time", async () => {
    const w = await world();
    w.gateway.packDelayMs = 15;
    await publish(credsFor("primary-device"), "x", w.primary, null, 0, 2);
    expect(w.gateway.maxPackPostsInFlight).toBe(4);
  });

  test("a change pack bigger than a request is in pieces too, and a replica that holds the base takes it", async () => {
    const w = await world();
    const first = await publish(credsFor("primary-device"), "x", w.primary, null, 0, 2);
    await pull(credsFor("replica-device"), "x", w.replica, 0);
    // Every file rewritten: the change is as big as the tree.
    for (let i = 0; i < 12; i++) writeFileSync(join(w.work, "big" + i + ".bin"), randomBytes(40 * KB));
    const second = await publish(credsFor("primary-device"), "x", w.primary, first.commit, first.seq, 2, first.roster);
    const m = manifestOf(w, second.manifestKey);
    expect(m.full).toBe(false);
    expect(m.chunks!.length).toBeGreaterThan(8);
    const got = await pull(credsFor("replica-device"), "x", w.replica, 1, first.commit);
    expect(got.seq).toBe(2);
    expect(sameTree(fingerprint(w.work), fingerprint(w.replica.work))).toBe(true);
  });

  test("a whole tree and the change beside it are both in pieces, and each member takes the one it needs", async () => {
    const w = await world();
    const first = await publish(credsFor("primary-device"), "x", w.primary, null, 0, 2);
    await pull(credsFor("replica-device"), "x", w.replica, 0);
    // A member joins, and the files are rewritten: the next snapshot is a whole tree with the change beside it.
    const newcomer: MemberPaths = { work: join(w.replica.work, "..", "newcomer"), gitDir: join(w.replica.work, "..", "n-meta"), keyFile: join(w.replica.work, "..", "n.key") };
    mkdirSync(newcomer.work, { recursive: true });
    w.gateway.seed("newcomer-device", loadOrCreateKeyPair(newcomer.keyFile).publicKey);
    for (let i = 0; i < 12; i++) writeFileSync(join(w.work, "big" + i + ".bin"), randomBytes(40 * KB));
    const second = await publish(credsFor("primary-device"), "x", w.primary, first.commit, first.seq, 2, first.roster);
    const m = manifestOf(w, second.manifestKey);
    expect(m.full).toBe(true);
    expect(m.chunks!.length).toBeGreaterThan(8);
    expect(m.delta!.chunks!.length).toBeGreaterThan(8);
    w.gateway.packReads.length = 0;
    await pull(credsFor("replica-device"), "x", w.replica, 1, first.commit);
    // The replica that holds the base took the change's pieces and none of the tree's (the same size here, different bytes).
    const deltaKeys = new Set(m.delta!.chunks!.map((c) => "fleets/x/packs/" + c.hash));
    expect(w.gateway.packReads.length).toBe(m.delta!.chunks!.length);
    expect(w.gateway.packReads.every((k) => deltaKeys.has(k))).toBe(true);
    await pull(credsFor("newcomer-device"), "x", newcomer, 0);
    expect(sameTree(fingerprint(w.work), fingerprint(w.replica.work))).toBe(true);
    expect(sameTree(fingerprint(w.work), fingerprint(newcomer.work))).toBe(true);
  });

  test("a small change after it is as small as ever: no pieces", async () => {
    const w = await world();
    const first = await publish(credsFor("primary-device"), "x", w.primary, null, 0, 2);
    writeFileSync(join(w.work, "note.txt"), "hello\n");
    const second = await publish(credsFor("primary-device"), "x", w.primary, first.commit, first.seq, 2, first.roster);
    expect(manifestOf(w, second.manifestKey).chunks).toBeUndefined();
  });

  test("a piece the gateway swapped is refused, and nothing is written", async () => {
    const w = await world();
    const first = await publish(credsFor("primary-device"), "x", w.primary, null, 0, 2);
    const m = manifestOf(w, first.manifestKey);
    // Another piece of the right size under the first piece's name.
    const key = "fleets/x/packs/" + m.chunks![1]!.hash;
    w.gateway.payloads.set(key, randomBytes(m.chunks![1]!.bytes));
    await expect(pull(credsFor("replica-device"), "x", w.replica, 0)).rejects.toThrow(/piece 2 of/);
    expect(fingerprint(w.replica.work).size).toBe(0);
  });

  test("the pieces of a manifest the gateway rewrote do not make the pack that was sealed", async () => {
    const w = await world();
    const first = await publish(credsFor("primary-device"), "x", w.primary, null, 0, 2);
    const m = manifestOf(w, first.manifestKey);
    // The gateway lists the same pieces in another order: each one is real, the whole is not the pack.
    const swapped: FleetManifest = { ...m, chunks: [m.chunks![1]!, m.chunks![0]!, ...m.chunks!.slice(2)] };
    const bytes = Buffer.from(JSON.stringify(swapped), "utf8");
    const key = "fleets/x/manifests/" + sha(bytes);
    w.gateway.payloads.set(key, bytes);
    w.gateway.head = { seq: 1, manifestKey: key, manifestHash: sha(bytes), epoch: 1 };
    w.gateway.indexEntries.splice(0, 1, { seq: 1, manifestKey: key, full: true, packBytes: m.packBytes! });
    await expect(pull(credsFor("replica-device"), "x", w.replica, 0)).rejects.toBeInstanceOf(TamperedSnapshotError);
    expect(fingerprint(w.replica.work).size).toBe(0);
  });

  test("a snapshot over what the gateway takes in pieces is refused before anything is uploaded", async () => {
    const w = await world({ chunkedLimit: 300 * KB });
    const posts = (): number => w.gateway.requests.get("POST packs") ?? 0;
    await expect(publish(credsFor("primary-device"), "x", w.primary, null, 0, 2)).rejects.toThrow(/too big to publish/);
    expect(posts()).toBe(0);
  });

  test("a piece the gateway lost is sent again, and the publish goes through", async () => {
    const w = await world();
    const original = w.gateway.handle.bind(w.gateway);
    let dropped = 0;
    // A gateway that takes the upload of a piece and loses it, once.
    w.gateway.handle = async (creds, method, path, body, search) => {
      const res = await original(creds, method, path, body, search);
      if (method === "POST" && path.endsWith("/packs") && dropped++ === 3) {
        const { hash } = (await res.clone().json()) as { hash: string };
        w.gateway.payloads.delete("fleets/x/packs/" + hash);
      }
      return res;
    };
    const one = await publish(credsFor("primary-device"), "x", w.primary, null, 0, 2);
    expect(one.seq).toBe(1);
    expect(w.gateway.head).not.toBeNull();
  });

  test("a gateway that keeps losing a piece is a refused publish, not a head that names it", async () => {
    const w = await world();
    const original = w.gateway.handle.bind(w.gateway);
    let lost: string | undefined;
    w.gateway.handle = async (creds, method, path, body, search) => {
      const res = await original(creds, method, path, body, search);
      if (method === "POST" && path.endsWith("/packs")) {
        const { hash } = (await res.clone().json()) as { hash: string };
        lost ??= hash;
        if (hash === lost) w.gateway.payloads.delete("fleets/x/packs/" + hash);
      }
      return res;
    };
    await expect(publish(credsFor("primary-device"), "x", w.primary, null, 0, 2)).rejects.toThrow(/head moved|another member/);
    expect(w.gateway.head).toBeNull();
  });

  test("a gateway that says a member cannot read pieces gives an error that says so", async () => {
    const w = await world();
    const original = w.gateway.handle.bind(w.gateway);
    w.gateway.handle = async (creds, method, path, body, search) => {
      if (method === "POST" && path.endsWith("/snapshot")) return Response.json({ error: "every member must list chunks", chunks: false, members: 2 }, { status: 409 });
      return original(creds, method, path, body, search);
    };
    await expect(publish(credsFor("primary-device"), "x", w.primary, null, 0, 2)).rejects.toThrow(/cannot read a snapshot in pieces/);
  });
});

describe("the list of pieces", () => {
  const ok = { hash: "a".repeat(64), bytes: 1000 };
  test("is believed only when it is one a publisher makes", () => {
    expect(chunkListProblem([ok, ok])).toBeUndefined();
    for (const bad of [undefined, [], "x", [{ hash: "z", bytes: 1 }], [{ hash: ok.hash, bytes: 0 }], [{ hash: ok.hash, bytes: -1 }], [{ hash: ok.hash, bytes: 1.5 }], [{ hash: ok.hash, bytes: 100 * 1024 * 1024 }], [{ hash: ok.hash }], [null]]) {
      expect(chunkListProblem(bad)).toBeDefined();
    }
    expect(chunkListProblem(Array.from({ length: CHUNKS_MAX + 1 }, () => ok))).toBeDefined();
    expect(chunkListProblem(Array.from({ length: CHUNKS_MAX }, () => ({ hash: ok.hash, bytes: CHUNKED_BYTES_MAX / CHUNKS_MAX + 1 })))).toBeDefined();
  });

  test("putChunks and getChunks give back the bytes, and getChunks refuses a list nobody makes before it asks", async () => {
    const w = await world();
    const pack = randomBytes(150 * KB + 7);
    const creds = credsFor("primary-device");
    const { chunks } = await putChunks(creds, "x", pack, 48 * KB);
    expect(chunks.map((c) => c.bytes)).toEqual([48 * KB, 48 * KB, 48 * KB, 6 * KB + 7]);
    expect((await getChunks(creds, "x", chunks)).equals(pack)).toBe(true);
    const asked = w.gateway.requests.get("GET packs") ?? 0;
    await expect(getChunks(creds, "x", [{ hash: "nope", bytes: 3 }])).rejects.toThrow(/not named by a hash/);
    expect(w.gateway.requests.get("GET packs") ?? 0).toBe(asked);
  });
});
