import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync as readSource } from "node:fs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_PACK_WINDOW, ROUTE_STEP_COST, chooseRoute, loadOrCreateKeyPair, manifestIdOf, openStep, publish, pull, rosterGained, type MemberPaths } from "../src/fleet-agent";
import { applyPack } from "../src/fleet-sync";
import type { FleetManifest } from "../src/fleet-transport";

import { FakeGateway, credsFor, fingerprint, sameTree, useFakeGateway } from "./fleet-fake-gateway";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

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

  test("a chain that cannot be downloaded whole leaves the work tree as it was", async () => {
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
      gateway.seed("primary-device", loadOrCreateKeyPair(primaryPaths.keyFile).publicKey);
      gateway.seed("replica-device", loadOrCreateKeyPair(replicaPaths.keyFile).publicKey);

      let last = await publish(credsFor("primary-device"), "x", primaryPaths, null, 0, 2);
      const first = await pull(credsFor("replica-device"), "x", replicaPaths, 0);
      for (let i = 2; i <= 4; i++) {
        writeFileSync(join(primaryWork, "a.txt"), "step " + i + " ".repeat(100));
        writeFileSync(join(primaryWork, "f" + i + ".txt"), "file " + i);
        last = await publish(credsFor("primary-device"), "x", primaryPaths, last.commit, last.seq, 2, last.roster);
      }
      const before = fingerprint(replicaWork);

      // The last pack in the chain is gone from the gateway.
      for (const key of [...gateway.payloads.keys()]) if (key.includes("/packs/") && key === lastPackKey(gateway)) gateway.payloads.delete(key);
      let failed = false;
      const steps: number[] = [];
      try {
        await pull(credsFor("replica-device"), "x", replicaPaths, first.seq, first.commit, (step) => void steps.push(step.seq));
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
      // Nothing was applied, so the state the member recorded still describes its tree.
      expect(steps).toEqual([]);
      expect(sameTree(fingerprint(replicaWork), before)).toBe(true);
    } finally {
      (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("a catch-up writes the work tree once, for the whole lag, and says so", async () => {
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
      gateway.seed("primary-device", loadOrCreateKeyPair(primaryPaths.keyFile).publicKey);
      gateway.seed("replica-device", loadOrCreateKeyPair(replicaPaths.keyFile).publicKey);
      let last = await publish(credsFor("primary-device"), "x", primaryPaths, null, 0, 2);
      const first = await pull(credsFor("replica-device"), "x", replicaPaths, 0);
      for (let i = 2; i <= 4; i++) {
        writeFileSync(join(primaryWork, "a.txt"), "step " + i + " ".repeat(100));
        last = await publish(credsFor("primary-device"), "x", primaryPaths, last.commit, last.seq, 2, last.roster);
      }
      const seen: Array<{ seq: number; commit: string; tree: string }> = [];
      const done = await pull(credsFor("replica-device"), "x", replicaPaths, first.seq, first.commit, (step) => void seen.push(step));
      // Three snapshots came in; the work tree saw one change, to the newest.
      expect(seen.map((s) => s.seq)).toEqual([4]);
      expect(seen[0]!.commit).toBe(done.commit);
      expect(seen[0]!.tree).toBe(done.tree!);
    } finally {
      (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

/** The key of the pack the head's manifest names. */
function lastPackKey(gateway: FakeGateway): string {
  const manifest = JSON.parse(gateway.payloads.get(gateway.head!.manifestKey)!.toString("utf8")) as { packKey: string };
  return manifest.packKey;
}

describe("the gateway keeps what the checkpoint interval needs", () => {
  test("it keeps at least twice FULL_PACK_WINDOW snapshots", () => {
    // The newest whole tree is at most FULL_PACK_WINDOW back and the deltas after
    // it are all newer, so a member that fell behind finds its whole route only
    // if the gateway keeps twice the window (one for the anchor's own interval,
    // one for the interval being published). The two numbers live in different
    // packages; this is what holds them together.
    const source = readSource(join(import.meta.dir, "..", "..", "api", "src", "fleets.ts"), "utf8");
    const kept = Number(/export const RECENT_SNAPSHOTS = (\d+);/.exec(source)?.[1]);
    expect(Number.isInteger(kept)).toBe(true);
    expect(kept).toBeGreaterThanOrEqual(2 * FULL_PACK_WINDOW);
  });
});

// A manifest with only what the route choice looks at.
function manifest(seq: number, opts: { full?: boolean; bytes?: number; delta?: number; sealedFor?: string[] } = {}): FleetManifest {
  return {
    fleet: "x",
    seq,
    tipCommit: "c" + seq,
    tree: "t" + seq,
    packKey: "fleets/x/packs/p" + seq,
    packHash: "p" + seq,
    ...(opts.bytes !== undefined ? { packBytes: opts.bytes } : {}),
    ...(opts.delta !== undefined ? { delta: { packKey: "fleets/x/packs/d" + seq, packHash: "d" + seq, bytes: opts.delta } } : {}),
    full: opts.full ?? false,
    senderPublicKey: "k",
    wrapped: (opts.sealedFor ?? ["me"]).map((id) => ({ memberId: id, wrapped: "w" })),
    epoch: 1,
    createdAt: 0,
  };
}
const newestFirst = (list: FleetManifest[]): FleetManifest[] => [...list].sort((a, b) => b.seq - a.seq);

describe("choosing the cheapest route", () => {
  test("a member that holds the snapshot before takes the change, also across a checkpoint", () => {
    const route = chooseRoute(newestFirst([manifest(31, { bytes: 10 }), manifest(32, { full: true, bytes: 5000, delta: 12 }), manifest(33, { bytes: 11 })]), 31, "me")!;
    expect(route.map((s) => [s.manifest.seq, s.packKey, s.whole])).toEqual([
      [32, "fleets/x/packs/d32", false],
      [33, "fleets/x/packs/p33", false],
    ]);
  });

  test("many small changes beat one whole tree, and one whole tree beats many large changes", () => {
    const small = [1, 2, 3, 4, 5].map((n) => manifest(n, { bytes: 10 }));
    small[0] = manifest(1, { full: true, bytes: 500 }); // the first snapshot has no base, so no change pack
    small[2] = manifest(3, { full: true, bytes: 500, delta: 10 });
    // From nothing the route starts at the newest whole tree.
    expect(chooseRoute(newestFirst(small), 0, "me")!.map((s) => [s.manifest.seq, s.whole])).toEqual([[3, true], [4, false], [5, false]]);
    const mixed = [manifest(2, { full: true, bytes: 500, delta: 10 }), manifest(3, { bytes: 10 }), manifest(4, { bytes: 10 })];
    expect(chooseRoute(newestFirst(mixed), 1, "me")!.map((s) => s.manifest.seq)).toEqual([2, 3, 4]);
    expect(chooseRoute(newestFirst(mixed), 1, "me")!.every((s) => !s.whole)).toBe(true);
    // Large changes, and a whole tree at the head that weighs less than all three.
    const large = [manifest(2, { bytes: 400 }), manifest(3, { bytes: 400 }), manifest(4, { full: true, bytes: 450, delta: 400 })];
    const route = chooseRoute(newestFirst(large), 1, "me")!;
    expect(route.map((s) => [s.manifest.seq, s.whole])).toEqual([[4, true]]);
  });

  test("a member with nothing starts from a whole tree; the newest one that is cheaper wins", () => {
    const list = [manifest(1, { full: true, bytes: 900 }), manifest(2, { bytes: 5 }), manifest(3, { full: true, bytes: 800, delta: 5 }), manifest(4, { bytes: 5 })];
    const route = chooseRoute(newestFirst(list), 0, "me")!;
    expect(route.map((s) => [s.manifest.seq, s.whole])).toEqual([[3, true], [4, false]]);
  });

  test("a snapshot sealed for others is not a step; the route goes round it or there is none", () => {
    const list = [manifest(1, { bytes: 5 }), manifest(2, { bytes: 5, sealedFor: ["other"] }), manifest(3, { full: true, bytes: 100, delta: 5 }), manifest(4, { bytes: 5 })];
    // From seq 1 the change at 2 cannot be opened: the whole tree at 3 is the way.
    expect(chooseRoute(newestFirst(list), 1, "me")!.map((s) => [s.manifest.seq, s.whole])).toEqual([[3, true], [4, false]]);
    // A whole tree nobody can open for this member, and a gap before it: no route.
    const none = [manifest(2, { bytes: 5, sealedFor: ["other"] }), manifest(3, { bytes: 5 })];
    expect(chooseRoute(newestFirst(none), 1, "me")).toBeNull();
  });

  test("a snapshot published before sizes were recorded: a whole tree is assumed large, a change small", () => {
    const list = [manifest(2, { full: true }), manifest(3, {}), manifest(4, {})];
    // With the previous snapshot in hand the changes are chosen, though seq 2 has no change pack: only the tree.
    expect(chooseRoute(newestFirst(list), 1, "me")!.map((s) => [s.manifest.seq, s.whole])).toEqual([[2, true], [3, false], [4, false]]);
    // Another with a change pack and no sizes at the checkpoint is cheaper than its whole tree.
    const withDelta = [manifest(2, { full: true, delta: 7 }), manifest(3, {})];
    expect(chooseRoute(newestFirst(withDelta), 1, "me")!.every((s) => !s.whole)).toBe(true);
  });
});

describe("what a step costs", () => {
  test("a handful of tiny changes is not worth forty-one steps: the whole tree is taken instead", () => {
    // 41 snapshots of 300 bytes against a tree of 14 KB: the changes save 1.7 KB and cost 41 round trips.
    const list: FleetManifest[] = [manifest(1, { full: true, bytes: 14_600 })];
    for (let seq = 2; seq <= 42; seq++) list.push(seq === 42 ? manifest(42, { full: true, bytes: 14_600, delta: 300 }) : manifest(seq, { bytes: 300 }));
    const route = chooseRoute(newestFirst(list), 1, "me")!;
    expect(route.map((s) => [s.manifest.seq, s.whole])).toEqual([[42, true]]);
    // With steps costing nothing it would take all forty-one (the bytes alone say so).
    expect(chooseRoute(newestFirst(list), 1, { memberId: "me", stepCost: 0 })!.length).toBe(41);
  });

  test("a big tree is still worth many small changes: 39 snapshots of 1.5 KB against 1.9 MB", () => {
    const list: FleetManifest[] = [manifest(1, { full: true, bytes: 1_900_000 })];
    for (let seq = 2; seq <= 40; seq++) list.push(manifest(seq, { bytes: 1500 }));
    list[31] = manifest(32, { full: true, bytes: 1_900_000, delta: 1500 });
    const route = chooseRoute(newestFirst(list), 1, "me")!;
    expect(route.length).toBe(39);
    expect(route.every((s) => !s.whole)).toBe(true);
  });

  test("the cost of a step is a named constant", () => {
    expect(ROUTE_STEP_COST).toBe(24 * 1024);
  });
});

describe("a checkpoint carries the change as well as the tree", () => {
  async function fleet(root: string, files = 24) {
    const gateway = new FakeGateway();
    const primaryWork = join(root, "primary");
    mkdirSync(primaryWork, { recursive: true });
    const noise = (): string => randomBytes(1500).toString("hex");
    for (let i = 0; i < files; i++) writeFileSync(join(primaryWork, "f" + i + ".txt"), noise());
    const primary: MemberPaths = { work: primaryWork, gitDir: join(root, "p-meta"), keyFile: join(root, "p.key") };
    const replica = (name: string): MemberPaths => {
      mkdirSync(join(root, name), { recursive: true });
      return { work: join(root, name), gitDir: join(root, name + "-meta"), keyFile: join(root, name + ".key") };
    };
    useFakeGateway(gateway);
    gateway.seed("primary-device", loadOrCreateKeyPair(primary.keyFile).publicKey);
    return { gateway, primary, primaryWork, replica, noise };
  }
  const join_ = async (gateway: FakeGateway, paths: MemberPaths, id: string) => gateway.seed(id, loadOrCreateKeyPair(paths.keyFile).publicKey);

  test("a replica that is caught up crosses it on the change; a newcomer takes the tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-delta-"));
    try {
      const { gateway, primary, primaryWork, replica, noise } = await fleet(root);
      const r1 = replica("r1");
      await join_(gateway, r1, "r1");
      let last = await publish(credsFor("primary-device"), "x", primary, null, 0, 2);
      let got = await pull(credsFor("r1"), "x", r1, 0);
      let wholeAt = 0;
      let wholeBytes = 0;
      let deltaBytes = 0;
      for (let seq = 2; seq <= FULL_PACK_WINDOW + 1; seq++) {
        writeFileSync(join(primaryWork, "f" + (seq % 24) + ".txt"), noise());
        last = await publish(credsFor("primary-device"), "x", primary, last.commit, last.seq, 2, last.roster);
        if (last.full) {
          wholeAt = seq;
          wholeBytes = last.bytes;
          deltaBytes = last.deltaBytes ?? 0;
        }
        gateway.packBytesServed = 0;
        got = await pull(credsFor("r1"), "x", r1, got.seq, got.commit);
        if (seq === FULL_PACK_WINDOW) {
          // The checkpoint: the replica took the change, not the tree.
          expect(gateway.packBytesServed).toBeLessThan(wholeBytes / 5);
        }
      }
      expect(wholeAt).toBe(FULL_PACK_WINDOW);
      expect(deltaBytes).toBeGreaterThan(0);
      expect(deltaBytes).toBeLessThan(wholeBytes / 5);
      expect(sameTree(fingerprint(primaryWork), fingerprint(r1.work))).toBe(true);

      // A newcomer starts from the tree at the checkpoint and the changes after it.
      const r2 = replica("r2");
      await join_(gateway, r2, "r2");
      last = await publish(credsFor("primary-device"), "x", primary, last.commit, last.seq, 2, last.roster);
      expect(last.full).toBe(true); // a member joined: the whole tree is sealed for it
      gateway.packBytesServed = 0;
      const joined = await pull(credsFor("r2"), "x", r2, 0);
      expect(joined.seq).toBe(last.seq);
      expect(gateway.packBytesServed).toBeGreaterThan(wholeBytes * 0.9);
      expect(sameTree(fingerprint(primaryWork), fingerprint(r2.work))).toBe(true);
    } finally {
      (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("a laggard that crosses the checkpoint takes the small changes, not the tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-delta-"));
    try {
      // A tree big enough that 34 small changes, steps and all, weigh less than the tree.
      const { gateway, primary, primaryWork, replica, noise } = await fleet(root, 700);
      const r1 = replica("r1");
      await join_(gateway, r1, "r1");
      let last = await publish(credsFor("primary-device"), "x", primary, null, 0, 2);
      const got = await pull(credsFor("r1"), "x", r1, 0);
      let whole = 0;
      for (let seq = 2; seq <= FULL_PACK_WINDOW + 3; seq++) {
        writeFileSync(join(primaryWork, "f" + (seq % 700) + ".txt"), noise());
        last = await publish(credsFor("primary-device"), "x", primary, last.commit, last.seq, 2, last.roster);
        if (last.full) whole = last.bytes;
      }
      gateway.packBytesServed = 0;
      gateway.packReads.length = 0;
      const caught = await pull(credsFor("r1"), "x", r1, got.seq, got.commit);
      expect(caught.seq).toBe(FULL_PACK_WINDOW + 3);
      // 34 small changes, one of them the checkpoint's own: far less than the tree.
      expect(gateway.packReads.length).toBe(FULL_PACK_WINDOW + 2);
      expect(gateway.packBytesServed).toBeLessThan(whole);
      expect(sameTree(fingerprint(primaryWork), fingerprint(r1.work))).toBe(true);
    } finally {
      (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("a replica that predates the change pack still applies the checkpoint's whole tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-delta-"));
    try {
      const { gateway, primary, primaryWork, replica, noise } = await fleet(root, 6);
      const old = replica("old");
      await join_(gateway, old, "old");
      let last = await publish(credsFor("primary-device"), "x", primary, null, 0, 2);
      let got = await pull(credsFor("old"), "x", old, 0);
      for (let seq = 2; seq <= FULL_PACK_WINDOW; seq++) {
        writeFileSync(join(primaryWork, "f" + (seq % 6) + ".txt"), noise());
        last = await publish(credsFor("primary-device"), "x", primary, last.commit, last.seq, 2, last.roster);
      }
      // What an older client does: walk back to the first whole-tree snapshot (or
      // what it has) and apply each snapshot's own pack. Nothing of the new fields.
      const keys = loadOrCreateKeyPair(old.keyFile);
      const chain: FleetManifest[] = [];
      let m = JSON.parse(gateway.payloads.get(gateway.head!.manifestKey)!.toString("utf8")) as FleetManifest;
      while (m.seq > got.seq) {
        chain.push(m);
        if (m.full || !m.parentManifest) break;
        m = JSON.parse(gateway.payloads.get(m.parentManifest)!.toString("utf8")) as FleetManifest;
      }
      chain.reverse();
      expect(chain[0]!.full).toBe(true);
      let previous = got.commit;
      for (const step of chain) {
        const pack = await openStep(credsFor("old"), "x", keys, { manifest: step, packKey: step.packKey, bytes: 0, whole: step.full });
        await applyPack(old.work, old.gitDir, step.tipCommit, pack, [], previous);
        previous = step.tipCommit;
      }
      expect(sameTree(fingerprint(primaryWork), fingerprint(old.work))).toBe(true);
      expect(manifestIdOf(chain[0]!.packKey)).toBeTruthy();
    } finally {
      (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("a publisher that predates sizes and the change pack still works with a new replica", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-delta-"));
    try {
      const { gateway, primary, primaryWork, replica, noise } = await fleet(root, 6);
      gateway.legacyManifests = true;
      const r1 = replica("r1");
      await join_(gateway, r1, "r1");
      let last = await publish(credsFor("primary-device"), "x", primary, null, 0, 2);
      let got = await pull(credsFor("r1"), "x", r1, 0);
      for (let seq = 2; seq <= FULL_PACK_WINDOW + 2; seq++) {
        writeFileSync(join(primaryWork, "f" + (seq % 6) + ".txt"), noise());
        last = await publish(credsFor("primary-device"), "x", primary, last.commit, last.seq, 2, last.roster);
        got = await pull(credsFor("r1"), "x", r1, got.seq, got.commit);
      }
      expect(got.seq).toBe(FULL_PACK_WINDOW + 2);
      expect(sameTree(fingerprint(primaryWork), fingerprint(r1.work))).toBe(true);
    } finally {
      (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("who needs a whole tree", () => {
  test("a member that joined or changed its key does; one that only left does not", () => {
    const before = "a:AAAA,b:BBBB,c:CCCC";
    expect(rosterGained(before, before)).toBe(false);
    expect(rosterGained(before, "a:AAAA,c:CCCC")).toBe(false); // b left
    expect(rosterGained(before, "a:AAAA,b:BBBB,c:CCCC,d:DDDD")).toBe(true); // d joined
    expect(rosterGained(before, "a:AAAA,b:ZZZZ,c:CCCC")).toBe(true); // b came back with a new key
    expect(rosterGained(before, "a:AAAA,c:CCCC,d:DDDD")).toBe(true); // b left, d joined
    expect(rosterGained("", "a:AAAA")).toBe(true);
  });
});
