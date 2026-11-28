// When the fleet publishes a whole tree: by what the chain of changes since the last one has cost, and never
// later than the cap.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RETAINED_SNAPSHOTS, ROUTE_STEP_COST, chainWantsWhole, checkpointPolicy, loadOrCreateKeyPair, publish, pull, sinceWholeFrom, sinceWholeOf, type MemberPaths, type SinceWhole } from "../src/fleet-agent";
import { mergeFleetState } from "../src/fleets";

import { FakeGateway, credsFor, fingerprint, sameTree, useFakeGateway } from "./fleet-fake-gateway";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

const DEFAULT_POLICY = { ...checkpointPolicy };
// (A hook outside a describe applies to every file's tests in the process, so each describe below sets it.)
function defaultChain(): void {
  beforeEach(() => {
    Object.assign(checkpointPolicy, DEFAULT_POLICY);
  });
  afterEach(() => {
    Object.assign(checkpointPolicy, DEFAULT_POLICY);
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  });
}

describe("the decision", () => {
  defaultChain();
  test("the defaults: a step costs what the route says, and 56 snapshots may follow a whole tree", () => {
    expect(checkpointPolicy.stepCost).toBe(ROUTE_STEP_COST);
    expect(checkpointPolicy.maxSinceWhole).toBe(56);
    expect(checkpointPolicy.minSinceWhole).toBe(8);
    // The newest whole tree is at most 57 back, and the gateway keeps 64.
    expect(RETAINED_SNAPSHOTS - (checkpointPolicy.maxSinceWhole + 1)).toBeGreaterThanOrEqual(4);
  });

  test("a whole tree when the chain has cost as much as one, or is as long as it may be", () => {
    const base: SinceWhole = { seq: 10, wholeBytes: 1_000_000, chainBytes: 0, count: 0 };
    expect(chainWantsWhole(base)).toBe(false);
    expect(chainWantsWhole({ ...base, chainBytes: 999_999, count: 30 })).toBe(false);
    expect(chainWantsWhole({ ...base, chainBytes: 1_000_000, count: 8 })).toBe(true);
    // A tree smaller than a few steps is not published whole every time to save the chain's cost.
    expect(chainWantsWhole({ ...base, chainBytes: 1_000_000, count: 7 })).toBe(false);
    expect(chainWantsWhole({ seq: 3, wholeBytes: 4_000, chainBytes: 50_000, count: 2 })).toBe(false);
    expect(chainWantsWhole({ ...base, chainBytes: 10, count: 56 })).toBe(true);
    expect(chainWantsWhole({ ...base, chainBytes: 10, count: 55 })).toBe(false);
  });

  // Simulate what a publisher does: 200 small edits of a 2000-file tree (a whole tree of 1.88 MB, a change of 1 KB).
  function wholeTrees(policy: { maxSinceWhole: number; byBytes: boolean; stepCost: number }, deltaAt: (seq: number) => number): number[] {
    const wholes: number[] = [1];
    let chain: SinceWhole = { seq: 1, wholeBytes: 1_880_000, chainBytes: 0, count: 0 };
    for (let seq = 2; seq <= 200; seq++) {
      if (chainWantsWhole(chain, policy as typeof checkpointPolicy)) {
        wholes.push(seq);
        chain = { seq, wholeBytes: 1_880_000, chainBytes: 0, count: 0 };
      } else {
        chain = { ...chain, seq, chainBytes: chain.chainBytes + deltaAt(seq) + policy.stepCost, count: chain.count + 1 };
      }
    }
    return wholes;
  }

  test("200 small edits make a whole tree only at the cap (it was every 32nd)", () => {
    const wholes = wholeTrees({ ...DEFAULT_POLICY }, () => 1_000);
    expect(wholes).toEqual([1, 58, 115, 172]);
    // Counted from the second: 3 checkpoints in 200 snapshots, where a modulo of 32 made 6.
    expect(wholes.length - 1).toBe(3);
    expect([...Array(200).keys()].filter((i) => (i + 1) % 32 === 0).length).toBe(6);
  });

  test("a burst of large changes brings the whole tree early", () => {
    const wholes = wholeTrees({ ...DEFAULT_POLICY }, (seq) => (seq >= 10 && seq <= 12 ? 800_000 : 1_000));
    expect(wholes[1]).toBe(13);
    expect(wholes[1]!).toBeLessThan(58);
  });

  test("the chain is read back from the index: the last whole tree and what follows it", () => {
    const entries = [
      { seq: 1, manifestKey: "m1", full: true, packBytes: 5000, deltaBytes: 0 },
      { seq: 2, manifestKey: "m2", full: false, packBytes: 300 },
      { seq: 3, manifestKey: "m3", full: true, packBytes: 6000, deltaBytes: 200 },
      { seq: 4, manifestKey: "m4", full: false, packBytes: 100 },
      { seq: 5, manifestKey: "m5", full: false, packBytes: 50 },
    ];
    expect(sinceWholeOf(entries, 10)).toEqual({ seq: 5, wholeBytes: 6000, chainBytes: 100 + 10 + 50 + 10, count: 2 });
    expect(sinceWholeOf(entries.filter((e) => !e.full))).toBeNull();
    expect(sinceWholeOf([])).toBeNull();
  });

  test("what a state file says is believed only when it is a chain", () => {
    const good = { seq: 4, wholeBytes: 10, chainBytes: 3, count: 2 };
    expect(sinceWholeFrom(good)).toEqual(good);
    for (const bad of [undefined, null, "x", {}, { ...good, count: -1 }, { ...good, wholeBytes: 0 }, { ...good, chainBytes: 1.5 }, { ...good, seq: "4" }]) {
      expect(sinceWholeFrom(bad)).toBeUndefined();
    }
  });

  test("the chain is part of the state that moves with the work tree, and never goes back", () => {
    const newer = { seq: 9, base: "b9", tree: "t9", sinceWhole: { seq: 9, wholeBytes: 9, chainBytes: 1, count: 1 } };
    const older = { seq: 5, base: "b5", tree: "t5", sinceWhole: { seq: 5, wholeBytes: 9, chainBytes: 0, count: 0 } };
    expect(mergeFleetState(newer, older).sinceWhole).toEqual(newer.sinceWhole);
    expect(mergeFleetState(older, newer).sinceWhole).toEqual(newer.sinceWhole);
  });
});

describe("publishing", () => {
  defaultChain();
  const FILES = 150;
  async function fleet(root: string) {
    const gateway = new FakeGateway();
    const work = join(root, "primary");
    mkdirSync(work, { recursive: true });
    // About 1.5 KB each once git has compressed them: a whole tree of a few hundred KB, a change of a few KB.
    const noise = (): string => randomBytes(1500).toString("hex");
    for (let i = 0; i < FILES; i++) writeFileSync(join(work, "f" + i + ".txt"), noise());
    const primary: MemberPaths = { work, gitDir: join(root, "p-meta"), keyFile: join(root, "p.key") };
    const late: MemberPaths = { work: join(root, "late"), gitDir: join(root, "late-meta"), keyFile: join(root, "late.key") };
    mkdirSync(late.work, { recursive: true });
    useFakeGateway(gateway);
    gateway.seed("primary-device", loadOrCreateKeyPair(primary.keyFile).publicKey);
    gateway.seed("late-device", loadOrCreateKeyPair(late.keyFile).publicKey);
    return { gateway, work, primary, late, noise };
  }

  // `daemonLike`: pass the chain the last publish returned (as the agent does); otherwise the fleet is asked every time (a takeover).
  async function run(root: string, count: number, daemonLike: boolean): Promise<{ wholes: number[]; work: string; late: MemberPaths; gateway: FakeGateway; last: Awaited<ReturnType<typeof publish>> }> {
    const { gateway, work, primary, late, noise } = await fleet(root);
    let last = await publish(credsFor("primary-device"), "x", primary, null, 0, 2);
    const wholes = [1];
    for (let seq = 2; seq <= count; seq++) {
      writeFileSync(join(work, "f" + (seq % FILES) + ".txt"), noise());
      last = await publish(credsFor("primary-device"), "x", primary, last.commit, last.seq, 2, last.roster, daemonLike && last.sinceWhole ? { sinceWhole: last.sinceWhole } : {});
      expect(last.seq).toBe(seq);
      if (last.full) wholes.push(seq);
    }
    return { wholes, work, late, gateway, last };
  }

  for (const daemonLike of [true, false]) {
    test("small edits make a whole tree at the cap" + (daemonLike ? " (the chain kept in the state)" : " (the chain asked of the fleet)"), async () => {
      const root = mkdtempSync(join(tmpdir(), "fleet-ckpt-"));
      try {
        Object.assign(checkpointPolicy, { maxSinceWhole: 6, minSinceWhole: 0, stepCost: 0 });
        const { wholes, work, late, gateway } = await run(root, 18, daemonLike);
        // After a whole tree, six changes, then the next whole tree: not every 32nd.
        expect(wholes).toEqual([1, 8, 15]);
        // A member that was never caught up still finds a whole tree to start from, with a short gateway memory.
        gateway.retain = 10;
        const got = await pull(credsFor("late-device"), "x", late, 0);
        expect(got.applied).toBe(true);
        expect(sameTree(fingerprint(work), fingerprint(late.work))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 120_000);
  }

  test("a burst of changes as big as the tree brings the next whole tree early", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-ckpt-"));
    try {
      Object.assign(checkpointPolicy, { maxSinceWhole: 50, minSinceWhole: 3, stepCost: 0 });
      const { gateway, work, primary, noise } = await fleet(root);
      let last = await publish(credsFor("primary-device"), "x", primary, null, 0, 2);
      const wholes = [1];
      for (let seq = 2; seq <= 8; seq++) {
        // The third change rewrites every file: the chain has cost a whole tree at once.
        if (seq === 4) for (let i = 0; i < FILES; i++) writeFileSync(join(work, "f" + i + ".txt"), noise());
        else writeFileSync(join(work, "f" + (seq % FILES) + ".txt"), noise());
        last = await publish(credsFor("primary-device"), "x", primary, last.commit, last.seq, 2, last.roster, last.sinceWhole ? { sinceWhole: last.sinceWhole } : {});
        if (last.full) wholes.push(seq);
      }
      expect(wholes).toEqual([1, 5]);
      expect(gateway.head?.seq).toBe(8);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("a gateway that lists a recent whole tree it was not does not put the checkpoint off: this member's own record bounds the chain", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-ckpt-"));
    try {
      Object.assign(checkpointPolicy, { maxSinceWhole: 6, minSinceWhole: 0, stepCost: 0 });
      const { gateway, work, primary, noise } = await fleet(root);
      let last = await publish(credsFor("primary-device"), "x", primary, null, 0, 2);
      let kept: Awaited<ReturnType<typeof publish>>["sinceWhole"];
      for (let seq = 2; seq <= 7; seq++) {
        writeFileSync(join(work, "f" + (seq % FILES) + ".txt"), noise());
        last = await publish(credsFor("primary-device"), "x", primary, last.commit, last.seq, 2, last.roster, last.sinceWhole ? { sinceWhole: last.sinceWhole } : {});
        if (seq === 3) kept = last.sinceWhole;
        expect(last.full).toBe(false);
      }
      expect(kept?.seq).toBe(3);
      // The gateway shows the head as a whole tree, big: the chain looks empty to anyone who believes the index. (This member's record
      // is the one from snapshot 3: another member published since, so it asks.)
      const shown = gateway.indexEntries[gateway.indexEntries.length - 1]!;
      shown.full = true;
      shown.packBytes = 50_000_000;
      writeFileSync(join(work, "f9.txt"), noise());
      const next = await publish(credsFor("primary-device"), "x", primary, last.commit, last.seq, 2, last.roster, kept ? { sinceWhole: kept } : {});
      expect(next.full).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("a fleet whose gateway has no index is counted by sequence, every fourth here", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-ckpt-"));
    try {
      Object.assign(checkpointPolicy, { fallbackModulo: 4 });
      const { gateway, work, primary, noise } = await fleet(root);
      gateway.indexEnabled = false;
      let last = await publish(credsFor("primary-device"), "x", primary, null, 0, 2);
      const wholes = [1];
      for (let seq = 2; seq <= 9; seq++) {
        writeFileSync(join(work, "f" + (seq % FILES) + ".txt"), noise());
        last = await publish(credsFor("primary-device"), "x", primary, last.commit, last.seq, 2, last.roster);
        if (last.full) wholes.push(seq);
      }
      expect(wholes).toEqual([1, 4, 8]);
      expect(last.sinceWhole).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
