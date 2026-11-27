import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { chooseRoute } from "../src/fleet-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFetched, loadOrCreateKeyPair, publish, pull, type MemberPaths } from "../src/fleet-agent";
import {
  applyReady,
  placeDue,
  positions,
  prefetch,
  promote,
  promotionDelayMs,
  replicaMode,
  type PlaceAnswer,
  type ReplicaState,
} from "../src/fleet-replica";
import { COLLECT_GRACE_MS, storeBytes } from "../src/fleet-store";
import { reportApplied, reportBackoff } from "../src/fleet-transport";
import { FakeGateway, credsFor, fingerprint, sameTree, useFakeGateway } from "./fleet-fake-gateway";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

interface World {
  root: string;
  gateway: FakeGateway;
  primary: MemberPaths;
  primaryWork: string;
  /** A replica, with its own state kept the way the agent keeps it. */
  replica(name: string): { paths: MemberPaths; id: string; state: ReplicaState; save: (patch: Partial<ReplicaState>) => void };
  publishNext(content?: string): Promise<{ seq: number; commit: string; roster: string; full: boolean; bytes: number }>;
}

async function world(files = 12): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "fleet-replica-"));
  const gateway = new FakeGateway();
  const primaryWork = join(root, "primary");
  mkdirSync(primaryWork, { recursive: true });
  let seed = 3;
  const noise = (): string => {
    let out = "";
    for (let i = 0; i < 2000; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      out += (seed % 36).toString(36);
    }
    return out;
  };
  for (let i = 0; i < files; i++) writeFileSync(join(primaryWork, "f" + i + ".txt"), noise());
  writeFileSync(join(primaryWork, ".gitignore"), "*.log\n");
  const primary: MemberPaths = { work: primaryWork, gitDir: join(root, "p-meta"), keyFile: join(root, "p.key") };
  useFakeGateway(gateway);
  gateway.seed("primary-device", loadOrCreateKeyPair(primary.keyFile).publicKey);
  let last: { seq: number; commit: string; roster: string; full: boolean; bytes: number } | null = null;
  let members = 1;
  const w: World = {
    root,
    gateway,
    primary,
    primaryWork,
    replica(name) {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      const paths: MemberPaths = { work: dir, gitDir: join(root, name + "-meta"), keyFile: join(root, name + ".key") };
      gateway.seed(name, loadOrCreateKeyPair(paths.keyFile).publicKey);
      members++;
      const holder = { paths, id: name, state: {} as ReplicaState, save: (_: Partial<ReplicaState>) => {} };
      holder.save = (patch) => {
        holder.state = { ...holder.state, ...patch };
      };
      return holder;
    },
    async publishNext(content) {
      if (last) writeFileSync(join(primaryWork, "f" + (last.seq % files) + ".txt"), content ?? noise());
      last = await publish(credsFor("primary-device"), "x", primary, last?.commit ?? null, last?.seq ?? 0, members, last?.roster);
      return last;
    },
  };
  return w;
}

const finish = (w: World): void => {
  (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  rmSync(w.root, { recursive: true, force: true });
};

describe("fetching ahead", () => {
  test("snapshots come into the store and the work tree is not touched", async () => {
    const w = await world();
    try {
      const r = w.replica("r1");
      await w.publishNext();
      // The replica has the first snapshot, applied.
      const first = await pull(credsFor("r1"), "x", r.paths, 0, null, (s) => r.save({ seq: s.seq, base: s.commit, tree: s.tree }));
      expect(first.applied).toBe(true);
      const before = fingerprint(r.paths.work);

      for (let i = 0; i < 3; i++) await w.publishNext();
      const got = await prefetch(credsFor("r1"), "x", r.paths, r.state, r.save);
      expect(got.steps).toBe(3);
      expect(got.fetched.seq).toBe(4);
      // Fetched is recorded after every snapshot kept; applied has not moved.
      expect(r.state.fetchedSeq).toBe(4);
      expect(r.state.seq).toBe(1);
      expect(sameTree(fingerprint(r.paths.work), before)).toBe(true);
      expect(positions(r.state).applied.seq).toBe(1);
      expect(positions(r.state).fetched.seq).toBe(4);
      // Nothing more to fetch: no pack is downloaded.
      w.gateway.packReads.length = 0;
      expect((await prefetch(credsFor("r1"), "x", r.paths, r.state, r.save)).steps).toBe(0);
      expect(w.gateway.packReads).toEqual([]);
    } finally {
      finish(w);
    }
  });

  test("a restart in the middle loses nothing that was already kept", async () => {
    const w = await world();
    try {
      const r = w.replica("r1");
      await w.publishNext();
      await pull(credsFor("r1"), "x", r.paths, 0, null, (s) => r.save({ seq: s.seq, base: s.commit, tree: s.tree }));
      for (let i = 0; i < 4; i++) await w.publishNext();
      // The gateway loses the newest pack halfway: the others were kept and recorded.
      const head = JSON.parse(w.gateway.payloads.get(w.gateway.head!.manifestKey)!.toString("utf8")) as { packKey: string };
      const lost = w.gateway.payloads.get(head.packKey)!;
      w.gateway.payloads.delete(head.packKey);
      await expect(prefetch(credsFor("r1"), "x", r.paths, r.state, r.save)).rejects.toThrow();
      expect(r.state.fetchedSeq).toBe(4);
      w.gateway.payloads.set(head.packKey, lost);
      w.gateway.packReads.length = 0;
      const again = await prefetch(credsFor("r1"), "x", r.paths, r.state, r.save);
      expect(again.fetched.seq).toBe(5);
      expect(w.gateway.packReads.length).toBe(1); // only the one that was missing
    } finally {
      finish(w);
    }
  });
});

describe("writing it out when it matters", () => {
  test("one apply covers the lag, reports it, and only the replica's own edit is moved aside", async () => {
    const w = await world();
    try {
      const r = w.replica("r1");
      await w.publishNext();
      await pull(credsFor("r1"), "x", r.paths, 0, null, (s) => r.save({ seq: s.seq, base: s.commit, tree: s.tree }));
      for (let i = 0; i < 5; i++) await w.publishNext();
      await prefetch(credsFor("r1"), "x", r.paths, r.state, r.save);
      writeFileSync(join(r.paths.work, "f1.txt"), "edited on the replica");
      writeFileSync(join(r.paths.work, "debug.log"), "ignored, and the replica's own");

      const done = await applyReady(credsFor("r1"), "x", r.paths, r.state, r.save);
      expect(done!.applied.seq).toBe(6);
      expect(done!.kept?.moved).toBe(1);
      expect(readFileSync(join(done!.kept!.to, "f1.txt"), "utf8")).toBe("edited on the replica");
      expect(sameTree(fingerprint(w.primaryWork), (() => { const m = fingerprint(r.paths.work); m.delete("debug.log"); return m; })())).toBe(true);
      expect(readFileSync(join(r.paths.work, "debug.log"), "utf8")).toBe("ignored, and the replica's own");
      expect(r.state.seq).toBe(6);
      expect(r.state.fetchedSeq).toBe(6);
      expect(w.gateway.applied.get("r1")).toBe(6);
      rmSync(done!.kept!.to, { recursive: true, force: true });
      // Nothing newer: nothing to do.
      expect(await applyReady(credsFor("r1"), "x", r.paths, r.state, r.save)).toBeNull();
    } finally {
      finish(w);
    }
  });

  test("a note left by an apply that finished does not hide the replica's own edits", async () => {
    const w = await world();
    try {
      const r = w.replica("r1");
      await w.publishNext();
      await pull(credsFor("r1"), "x", r.paths, 0, null, (s) => r.save({ seq: s.seq, base: s.commit, tree: s.tree }));
      const firstCommit = r.state.base!;
      const old = readFileSync(join(r.paths.work, "f1.txt"), "utf8");
      await w.publishNext(); // f1.txt changes
      await pull(credsFor("r1"), "x", r.paths, 1, firstCommit, (s) => r.save({ seq: s.seq, base: s.commit, tree: s.tree }));
      expect(readFileSync(join(r.paths.work, "f1.txt"), "utf8")).not.toBe(old);
      // The first apply was stopped between its sidecar and the removal of its note.
      writeFileSync(join(r.paths.gitDir, "apply.target"), JSON.stringify({ from: null, to: firstCommit }));
      // The member puts f1.txt back as it was in that first snapshot: an edit of its own now.
      writeFileSync(join(r.paths.work, "f1.txt"), old);
      await w.publishNext();
      await prefetch(credsFor("r1"), "x", r.paths, r.state, r.save);
      const done = await applyReady(credsFor("r1"), "x", r.paths, r.state, r.save);
      expect(done!.kept?.moved).toBe(1);
      expect(readFileSync(join(done!.kept!.to, "f1.txt"), "utf8")).toBe(old);
      expect(existsSync(join(r.paths.gitDir, "apply.target"))).toBe(false);
      rmSync(done!.kept!.to, { recursive: true, force: true });
    } finally {
      finish(w);
    }
  });

  test("a note is removed when the sidecar says the apply it was for is done", async () => {
    const w = await world();
    try {
      const r = w.replica("r1");
      await w.publishNext();
      await pull(credsFor("r1"), "x", r.paths, 0, null, (s) => r.save({ seq: s.seq, base: s.commit, tree: s.tree }));
      await w.publishNext();
      const got = await prefetch(credsFor("r1"), "x", r.paths, r.state, r.save);
      // As if the stop came right after the sidecar was written.
      writeFileSync(join(r.paths.gitDir, "apply.target"), JSON.stringify({ from: null, to: got.fetched.commit }));
      writeFileSync(join(r.paths.gitDir, "apply.commit"), got.fetched.commit + "\n");
      await applyReady(credsFor("r1"), "x", r.paths, r.state, r.save);
      expect(existsSync(join(r.paths.gitDir, "apply.target"))).toBe(false);
    } finally {
      finish(w);
    }
  });

  test("a catch-up on request uses what was fetched and downloads nothing again", async () => {
    const w = await world();
    try {
      const r = w.replica("r1");
      await w.publishNext();
      await pull(credsFor("r1"), "x", r.paths, 0, null, (s) => r.save({ seq: s.seq, base: s.commit, tree: s.tree }));
      for (let i = 0; i < 3; i++) await w.publishNext();
      await prefetch(credsFor("r1"), "x", r.paths, r.state, r.save);
      w.gateway.packReads.length = 0;
      const { fetched } = positions(r.state);
      const pulled = await pull(credsFor("r1"), "x", r.paths, r.state.seq!, r.state.base!, undefined, fetched);
      expect(pulled.seq).toBe(4);
      expect(w.gateway.packReads).toEqual([]);
      expect(sameTree(fingerprint(w.primaryWork), fingerprint(r.paths.work))).toBe(true);
    } finally {
      finish(w);
    }
  });
});

describe("taking the lease", () => {
  const ask = (_w: World, id: string) => async (): Promise<PlaceAnswer> => {
    const res = await fetch("http://fake/fleets/x/bootstrap", { method: "POST", headers: { "x-prime-device": id }, body: "{}" } as RequestInit);
    const body = (await res.json()) as { role?: string; reason?: string; catchUpTo?: number };
    return { primary: body.role === "primary", ...(body.reason ? { reason: body.reason } : {}), ...(body.catchUpTo !== undefined ? { catchUpTo: body.catchUpTo } : {}) };
  };

  test("a replica that only fetched applies, then takes over and publishes on top of what it holds", async () => {
    const w = await world();
    try {
      const r = w.replica("r1");
      await w.publishNext();
      await pull(credsFor("r1"), "x", r.paths, 0, null, (s) => r.save({ seq: s.seq, base: s.commit, tree: s.tree }));
      for (let i = 0; i < 4; i++) await w.publishNext();
      await prefetch(credsFor("r1"), "x", r.paths, r.state, r.save);
      const stale = fingerprint(r.paths.work);
      expect(sameTree(stale, fingerprint(w.primaryWork))).toBe(false); // a lazy replica is behind

      // The primary goes away.
      w.gateway.primary = "";
      const outcome = await promote({
        takePlace: ask(w, "r1"),
        catchUp: async () => {
          await prefetch(credsFor("r1"), "x", r.paths, r.state, r.save);
          await applyReady(credsFor("r1"), "x", r.paths, r.state, r.save);
        },
      });
      expect(outcome).toBe("primary");
      expect(w.gateway.primary).toBe("r1");
      expect(sameTree(fingerprint(w.primaryWork), fingerprint(r.paths.work))).toBe(true);

      // It publishes on the state it applied: the fleet does not fork.
      writeFileSync(join(r.paths.work, "new.txt"), "from the new primary");
      const next = await publish(credsFor("r1"), "x", r.paths, r.state.base!, r.state.seq!, 2);
      expect(next.seq).toBe(6);
      expect(next.full).toBe(false);
    } finally {
      finish(w);
    }
  });

  test("two replicas race for a free lease: one wins, the other stays a replica", async () => {
    const w = await world();
    try {
      const a = w.replica("ra");
      const b = w.replica("rb");
      await w.publishNext();
      for (const r of [a, b]) {
        await pull(credsFor(r.id), "x", r.paths, 0, null, (s) => r.save({ seq: s.seq, base: s.commit, tree: s.tree }));
      }
      for (let i = 0; i < 3; i++) await w.publishNext();
      for (const r of [a, b]) await prefetch(credsFor(r.id), "x", r.paths, r.state, r.save);
      w.gateway.primary = "";

      const attempt = (r: typeof a) =>
        promote({
          takePlace: ask(w, r.id),
          catchUp: async () => {
            await applyReady(credsFor(r.id), "x", r.paths, r.state, r.save);
          },
        });
      const results = await Promise.all([attempt(a), attempt(b)]);
      expect(results.filter((o) => o === "primary").length).toBe(1);
      // The other one is told to wait (the first to ask holds the claim) or finds the lease held.
      expect(results.filter((o) => o === "claimed" || o === "lease-held").length).toBe(1);
      expect(["ra", "rb"]).toContain(w.gateway.primary);
    } finally {
      finish(w);
    }
  });

  test("a replica that finds the lease held does nothing at all", async () => {
    const w = await world();
    try {
      const r = w.replica("r1");
      await w.publishNext();
      await pull(credsFor("r1"), "x", r.paths, 0, null, (s) => r.save({ seq: s.seq, base: s.commit, tree: s.tree }));
      await w.publishNext();
      await prefetch(credsFor("r1"), "x", r.paths, r.state, r.save);
      const before = fingerprint(r.paths.work);
      let caughtUp = false;
      const outcome = await promote({ takePlace: ask(w, "r1"), catchUp: async () => void (caughtUp = true) });
      expect(outcome).toBe("lease-held");
      expect(caughtUp).toBe(false);
      expect(sameTree(fingerprint(r.paths.work), before)).toBe(true);
    } finally {
      finish(w);
    }
  });

  test("a claim held by another replica, or a question already in flight, is not taken for a refusal", async () => {
    expect(await promote({ takePlace: async () => ({ primary: false, reason: "claimed", retryAfterMs: 20_000 }), catchUp: async () => undefined })).toBe("claimed");
    expect(await promote({ takePlace: async () => ({ primary: false, busy: true }), catchUp: async () => undefined })).toBe("busy");
    expect(await promote({ takePlace: async () => ({ primary: false, reason: "lease-held" }), catchUp: async () => undefined })).toBe("lease-held");
  });

  test("a head that keeps moving under a member that is catching up ends, and says so", async () => {
    let calls = 0;
    const outcome = await promote({
      takePlace: async () => ({ primary: false, reason: "not-caught-up", catchUpTo: ++calls }),
      catchUp: async () => undefined,
      attempts: 3,
    });
    expect(outcome).toBe("gave-up");
    expect(calls).toBe(3);
    expect(await promote({ takePlace: async () => ({ primary: false, paused: true }), catchUp: async () => undefined })).toBe("paused");
  });
});

describe("when a replica asks the fleet anything", () => {
  const base = { primary: false, lastBootstrap: 1_000_000, heartbeatMs: 5_000, wanted: false, leaseMs: 45_000 };

  test("with the socket up it asks about every five minutes; without, a third of a lease apart", () => {
    expect(placeDue({ ...base, now: 1_000_000 + 10_000, eventsConnected: true })).toBe(false);
    expect(placeDue({ ...base, now: 1_000_000 + 299_000, eventsConnected: true })).toBe(false);
    expect(placeDue({ ...base, now: 1_000_000 + 301_000, eventsConnected: true })).toBe(true);
    expect(placeDue({ ...base, now: 1_000_000 + 14_000, eventsConnected: false })).toBe(false);
    expect(placeDue({ ...base, now: 1_000_000 + 16_000, eventsConnected: false })).toBe(true);
  });

  test("without a socket and without being told the lease, it assumes the fleet's forty-five seconds", () => {
    const { leaseMs: _told, ...unknown } = base;
    void _told;
    expect(placeDue({ ...unknown, now: 1_000_000 + 10_000, eventsConnected: false })).toBe(false);
    expect(placeDue({ ...unknown, now: 1_000_000 + 16_000, eventsConnected: false })).toBe(true);
  });

  test("it asks when the first look has not happened yet, and when it was told the lease is free", () => {
    expect(placeDue({ ...base, lastBootstrap: 0, now: 5, eventsConnected: true })).toBe(true);
    expect(placeDue({ ...base, wanted: true, now: 1_000_001, eventsConnected: true })).toBe(true);
  });

  test("a primary renews on its heartbeat, as it always did", () => {
    expect(placeDue({ ...base, primary: true, now: 1_000_000 + 4_000, eventsConnected: true })).toBe(false);
    expect(placeDue({ ...base, primary: true, now: 1_000_000 + 6_000, eventsConnected: true })).toBe(true);
  });

  test("the wait before asking is shorter for a member that is ahead and differs between members", () => {
    const fixed = () => 0;
    expect(promotionDelayMs("dev-a", false, fixed)).toBeLessThan(promotionDelayMs("dev-a", true, fixed));
    const delays = new Set(["dev-a", "dev-b", "dev-c", "dev-d", "dev-e"].map((d) => promotionDelayMs(d, false, fixed)));
    expect(delays.size).toBeGreaterThan(1);
    for (const d of delays) expect(d).toBeLessThan(2000);
  });

  test("a replica is lazy unless told to mirror", () => {
    expect(replicaMode({})).toBe("lazy");
    expect(replicaMode({ PRIME_FLEET_REPLICA: "mirror" })).toBe("mirror");
    expect(replicaMode({ PRIME_FLEET_REPLICA: "anything" })).toBe("lazy");
  });

  test("positions never put fetched behind applied", () => {
    expect(positions({ seq: 5, base: "a", fetchedSeq: 3, fetchedCommit: "b" }).fetched.seq).toBe(5);
    expect(positions({ seq: 5, base: "a", fetchedSeq: 9, fetchedCommit: "c" }).fetched).toEqual({ seq: 9, commit: "c" });
    expect(positions({}).fetched).toEqual({ seq: 0, commit: null });
  });
});


// A space the way the agent keeps it, with the socket reported as up.
async function space(w: World, name: string, opts: { connected?: boolean } = {}) {
  const { round } = await import("../src/fleet-daemon");
  const { fleetKeyFile, fleetStateDir, readFleetState } = await import("../src/fleets");
  const { NestedRepoCache } = await import("../src/fleet-sync");
  const configPath = join(w.root, "cfg-" + name, "config.json");
  const work = join(w.root, name);
  mkdirSync(work, { recursive: true });
  const gitDir = fleetStateDir(configPath, "x", name);
  mkdirSync(gitDir, { recursive: true });
  const paths: MemberPaths = { work, gitDir, keyFile: fleetKeyFile(configPath, "x", name), nested: new NestedRepoCache(work) };
  w.gateway.seed(name, loadOrCreateKeyPair(paths.keyFile).publicKey);
  const said: string[] = [];
  // The agent's own type is not exported whole; a test only sets what a round reads.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loop: any = {
    configPath,
    name,
    space: {} as never,
    fleet: "x",
    creds: credsFor(name),
    paths,
    dirty: false,
    claim: false,
    claimAt: 0,
    headDirty: false,
    lastHeadCheck: 0,
    lastPublish: 0,
    lastCheck: 0,
    primary: false,
    lastBootstrap: 0,
    timing: {},
    paused: false,
    events: { connected: opts.connected ?? true } as never,
  };
  return {
    loop,
    paths,
    said,
    state: () => readFleetState(configPath, "x", name),
    round: () => round(loop, { heartbeatMs: 5000 }, (what) => void said.push(what)),
  };
}

const baseline = async (w: World, name: string) => {
  const s = await space(w, name);
  await w.publishNext();
  await s.round(); // the first look: no baseline yet, so it is given one
  return s;
};
const total = (w: World): number => [...w.gateway.requests.values()].reduce((a, b) => a + b, 0);

describe("the agent's round for a replica", () => {

  test("with a socket, a replica asks nothing while nothing happens, and fetches without writing when the head moves", async () => {
    const w = await world();
    try {
      w.gateway.seed("primary-device", loadOrCreateKeyPair(w.primary.keyFile).publicKey);
      const s = await baseline(w, "r1");
      expect(s.state().seq).toBe(1);
      expect(s.loop.primary).toBe(false);
      const before = fingerprint(s.paths.work);

      // Nothing happened: not a single request.
      const asked = total(w);
      await s.round();
      await s.round();
      expect(total(w)).toBe(asked);

      // The socket says the head moved: it fetches, and does not take a place again.
      for (let i = 0; i < 3; i++) await w.publishNext();
      const bootstraps = w.gateway.bootstraps;
      s.loop.headDirty = true;
      await s.round();
      expect(w.gateway.bootstraps).toBe(bootstraps);
      expect(s.state().fetchedSeq).toBe(4);
      expect(s.state().seq).toBe(1);
      expect(sameTree(fingerprint(s.paths.work), before)).toBe(true);
      expect(s.said).toContain("fetched 4");
    } finally {
      finish(w);
    }
  });

  test("when the lease is freed, a replica that only fetched writes its work tree and takes over", async () => {
    const w = await world();
    try {
      const s = await baseline(w, "r1");
      for (let i = 0; i < 4; i++) await w.publishNext();
      s.loop.headDirty = true;
      await s.round();
      expect(s.state().seq).toBe(1);

      w.gateway.primary = ""; // the lease-free event
      s.loop.claim = true;
      await s.round();
      expect(s.loop.primary).toBe(true);
      expect(w.gateway.primary).toBe("r1");
      expect(s.state().seq).toBe(5);
      expect(sameTree(fingerprint(w.primaryWork), fingerprint(s.paths.work))).toBe(true);
      expect(s.said.some((m) => m.startsWith("took over at 5"))).toBe(true);
      // Nothing changed in the fleet or in the work tree: taking over publishes nothing.
      const head = w.gateway.head!.seq;
      await s.round();
      expect(w.gateway.head!.seq).toBe(head);
    } finally {
      finish(w);
    }
  });

  test("a replica that loses the race stays a replica and writes nothing it did not have to", async () => {
    const w = await world();
    try {
      const a = await baseline(w, "ra");
      const b = await space(w, "rb");
      await w.publishNext(); // the member that joined is sealed for from here on
      await a.round();
      await b.round();
      for (let i = 0; i < 3; i++) await w.publishNext();
      for (const s of [a, b]) {
        s.loop.headDirty = true;
        await s.round();
      }
      w.gateway.primary = "";
      a.loop.claim = true;
      b.loop.claim = true;
      await a.round(); // a is first
      await b.round();
      expect(a.loop.primary).toBe(true);
      expect(b.loop.primary).toBe(false);
      expect(b.loop.claim).toBe(false);
      expect(w.gateway.primary).toBe("ra");
    } finally {
      finish(w);
    }
  });

  test("the replica that loses the race for a free lease writes nothing, and asks again when the claim runs out", async () => {
    const w = await world();
    try {
      const a = await baseline(w, "ra");
      const b = await space(w, "rb");
      await w.publishNext(); // the member that joined is sealed for from here on
      await a.round();
      await b.round();
      for (let i = 0; i < 3; i++) await w.publishNext();
      for (const s of [a, b]) {
        s.loop.headDirty = true;
        await s.round();
      }
      w.gateway.primary = ""; // the lease is free; both hear it
      const staleB = fingerprint(b.paths.work);

      // a asks first: it is told to catch up, and has the claim on doing so.
      const asked = await fetch("http://fake/fleets/x/bootstrap", { method: "POST", headers: { "x-prime-device": "ra" }, body: "{}" } as RequestInit);
      expect(((await asked.json()) as { reason?: string }).reason).toBe("not-caught-up");

      // b asks while a is writing its work tree: it is told to wait, and writes nothing.
      b.loop.claim = true;
      b.loop.claimAt = 0;
      await b.round();
      expect(sameTree(fingerprint(b.paths.work), staleB)).toBe(true);
      expect(b.state().seq).toBeLessThan(w.gateway.head!.seq);
      expect(b.loop.primary).toBe(false);
      expect(b.loop.claim).toBe(true);
      expect(b.loop.claimAt).toBeGreaterThan(Date.now() + 20_000);

      // a never finishes (it died): the claim runs out and b takes over.
      w.gateway.claim = { device: "ra", since: Date.now() - 31_000, until: Date.now() - 1 };
      b.loop.claimAt = 0;
      await b.round();
      expect(b.loop.primary).toBe(true);
      expect(sameTree(fingerprint(w.primaryWork), fingerprint(b.paths.work))).toBe(true);
    } finally {
      finish(w);
    }
  });

  test("a heartbeat that finds the lease free sets the replica about taking it, as a round would", async () => {
    const { heartbeat } = await import("../src/fleet-daemon");
    const w = await world();
    try {
      const s = await baseline(w, "r1");
      for (let i = 0; i < 2; i++) await w.publishNext();
      s.loop.headDirty = true;
      await s.round();
      w.gateway.primary = "";
      s.loop.lastBootstrap = 1; // long ago: due
      let woken = 0;
      await heartbeat(s.loop as never, () => void woken++);
      expect(s.loop.claim).toBe(true);
      expect(woken).toBe(1);
      // And the round that is woken takes over.
      await s.round();
      expect(s.loop.primary).toBe(true);
    } finally {
      finish(w);
    }
  });

  test("PRIME_FLEET_REPLICA=mirror writes every snapshot as it arrives", async () => {
    const w = await world();
    const saved = process.env.PRIME_FLEET_REPLICA;
    process.env.PRIME_FLEET_REPLICA = "mirror";
    try {
      const s = await baseline(w, "r1");
      for (let i = 0; i < 2; i++) await w.publishNext();
      s.loop.headDirty = true;
      await s.round();
      expect(s.state().seq).toBe(3);
      expect(sameTree(fingerprint(w.primaryWork), fingerprint(s.paths.work))).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.PRIME_FLEET_REPLICA;
      else process.env.PRIME_FLEET_REPLICA = saved;
      finish(w);
    }
  });

  test("an object store over its cap is collected once a round is over, at most every ten minutes, and the replica still works", async () => {
    const { maybeCollect } = await import("../src/fleet-daemon");
    const w = await world();
    const saved = process.env.PRIME_FLEET_CACHE_MB;
    process.env.PRIME_FLEET_CACHE_MB = "0.001";
    try {
      const s = await baseline(w, "r1");
      for (let i = 0; i < 12; i++) {
        await w.publishNext();
        s.loop.headDirty = true;
        await s.round();
      }
      expect(s.state().fetchedSeq).toBe(13);
      const long = new Date(Date.now() - 2 * COLLECT_GRACE_MS);
      const walk = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory()) walk(join(dir, e.name));
          else utimesSync(join(dir, e.name), long, long);
        }
      };
      walk(join(s.paths.gitDir, "objects"));
      const before = storeBytes(s.paths.gitDir);

      const said: string[] = [];
      await maybeCollect(s.loop as never, (m) => void said.push(m), 1_000_000);
      expect(storeBytes(s.paths.gitDir)).toBeLessThan(before);
      expect(said.some((m) => m.startsWith("collected the object store"))).toBe(true);
      // Looked at again within ten minutes: nothing.
      const again: string[] = [];
      await maybeCollect(s.loop as never, (m) => void again.push(m), 1_000_000 + 60_000);
      expect(again).toEqual([]);

      // It still takes the next change, and writes it out when it has to.
      await w.publishNext();
      s.loop.headDirty = true;
      await s.round();
      w.gateway.primary = "";
      s.loop.claim = true;
      await s.round();
      expect(s.loop.primary).toBe(true);
      expect(sameTree(fingerprint(w.primaryWork), fingerprint(s.paths.work))).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.PRIME_FLEET_CACHE_MB;
      else process.env.PRIME_FLEET_CACHE_MB = saved;
      finish(w);
    }
  }, 60_000);

  // Virtual time: the agent's rounds happen at the instants a test chooses.
  const atTime = async (start: number, fn: (set: (ms: number) => void) => Promise<void>): Promise<void> => {
    const real = Date.now;
    let clock = start;
    Date.now = () => clock;
    try {
      await fn((ms) => void (clock = start + ms));
    } finally {
      Date.now = real;
    }
  };

  test("a store that holds only what is in use and is still over the cap is not collected again and again", async () => {
    const { maybeCollect, collectPolicy } = await import("../src/fleet-daemon");
    const w = await world();
    const saved = process.env.PRIME_FLEET_CACHE_MB;
    const policy = { ...collectPolicy };
    process.env.PRIME_FLEET_CACHE_MB = "0.001"; // always over
    collectPolicy.growthBytes = 20_000;
    try {
      const s = await baseline(w, "r1");
      const said: string[] = [];
      const check = async (minute: number): Promise<void> => maybeCollect(s.loop as never, (m) => void said.push(m), minute * 60_000);
      await check(11);
      await check(22);
      await check(33);
      await check(44);
      // Nothing was published in between: one collection, and the cap said once.
      expect(said.filter((m) => m.startsWith("collected")).length).toBe(1);
      expect(said.filter((m) => m.includes("over the cap")).length).toBe(1);

      // It grows by more than the policy asks: collected again.
      for (let i = 0; i < 30; i++) {
        await w.publishNext();
        s.loop.headDirty = true;
        await s.round();
      }
      await check(55);
      expect(said.filter((m) => m.startsWith("collected")).length).toBe(2);
    } finally {
      Object.assign(collectPolicy, policy);
      if (saved === undefined) delete process.env.PRIME_FLEET_CACHE_MB;
      else process.env.PRIME_FLEET_CACHE_MB = saved;
      finish(w);
    }
  }, 60_000);

  test("without a socket a lazy replica asks for its place about every fifteen seconds and for nothing else", async () => {
    const w = await world();
    try {
      const s = await space(w, "r1", { connected: false });
      await w.publishNext();
      await atTime(1_000_000, async (at) => {
        await s.round(); // the first look: it gets a baseline
        const heads = w.gateway.requests.get("GET head") ?? 0;
        const bootstraps = w.gateway.bootstraps;
        // Rounds a second and a half apart: nothing to ask, nothing asked.
        for (let t = 1500; t < 14_000; t += 1500) {
          at(t);
          await s.round();
        }
        expect(w.gateway.bootstraps).toBe(bootstraps);
        expect(w.gateway.requests.get("GET head") ?? 0).toBe(heads);

        // The primary publishes. The replica finds out when it next asks for its
        // place, and the answer carries the head: no separate look at it.
        await w.publishNext();
        const headsNow = w.gateway.requests.get("GET head") ?? 0; // the primary asked for it once
        expect(headsNow).toBeGreaterThan(heads);
        at(16_000);
        await s.round();
        expect(w.gateway.bootstraps).toBe(bootstraps + 1);
        expect(w.gateway.requests.get("GET head") ?? 0).toBe(headsNow);
        expect(s.state().fetchedSeq).toBe(2);
        expect(s.state().seq).toBe(1);
      });
    } finally {
      finish(w);
    }
  });

  test("a replica that mirrors, without a socket, still looks at the head every round", async () => {
    const w = await world();
    const saved = process.env.PRIME_FLEET_REPLICA;
    process.env.PRIME_FLEET_REPLICA = "mirror";
    try {
      const s = await space(w, "r1", { connected: false });
      await w.publishNext();
      await atTime(1_000_000, async (at) => {
        await s.round();
        const heads = w.gateway.requests.get("GET head") ?? 0;
        for (let i = 1; i <= 5; i++) {
          at(i * 1500);
          await s.round();
        }
        expect((w.gateway.requests.get("GET head") ?? 0) - heads).toBe(5);
      });
    } finally {
      if (saved === undefined) delete process.env.PRIME_FLEET_REPLICA;
      else process.env.PRIME_FLEET_REPLICA = saved;
      finish(w);
    }
  });

  test("with a socket a lazy replica looks at the head every ten minutes and at its place every five, when nothing is said", async () => {
    const w = await world();
    try {
      const s = await space(w, "r1", { connected: true });
      await w.publishNext();
      await atTime(1_000_000, async (at) => {
        await s.round();
        const heads = w.gateway.requests.get("GET head") ?? 0;
        const bootstraps = w.gateway.bootstraps;
        at(4 * 60_000);
        await s.round();
        expect(total(w)).toBe(total(w));
        expect(w.gateway.bootstraps).toBe(bootstraps);
        at(5.5 * 60_000);
        await s.round();
        expect(w.gateway.bootstraps).toBe(bootstraps + 1);
        expect(w.gateway.requests.get("GET head") ?? 0).toBe(heads);
        at(11 * 60_000);
        await s.round();
        expect((w.gateway.requests.get("GET head") ?? 0) - heads).toBe(1);
      });
    } finally {
      finish(w);
    }
  });

  test("how long a replica sleeps, and how often a primary renews against the lease", async () => {
    const { heartbeatIntervalMs } = await import("../src/fleet-daemon");
    const { replicaSleepMs } = await import("../src/fleet-replica");
    expect(replicaSleepMs({ mode: "lazy", connected: false, pollMs: 1500 })).toEqual({ pollMs: 15_000, idleMs: 300_000 });
    expect(replicaSleepMs({ mode: "lazy", connected: false, pollMs: 1500, leaseMs: 15_000 }).pollMs).toBe(5_000);
    expect(replicaSleepMs({ mode: "mirror", connected: false, pollMs: 1500 }).pollMs).toBe(1500);
    // Two renewals can be lost and the place is still held, for any lease the fleet reports.
    for (const lease of [15_000, 45_000, 120_000]) {
      const beat = heartbeatIntervalMs(lease, 15_000);
      expect(beat * 3).toBeLessThanOrEqual(lease);
    }
    expect(heartbeatIntervalMs(45_000, 15_000)).toBe(15_000);
    expect(heartbeatIntervalMs(undefined, 15_000)).toBe(15_000);
    expect(heartbeatIntervalMs(15_000, 15_000)).toBe(5_000);
  });
});

describe("planning from the gateway's index", () => {
  const reads = (w: World, what: string): number => w.gateway.requests.get(what) ?? 0;

  async function behind(w: World, name: string, lag: number) {
    const r = w.replica(name);
    await w.publishNext();
    await pull(credsFor(name), "x", r.paths, 0, null, (s) => r.save({ seq: s.seq, base: s.commit, tree: s.tree }));
    for (let i = 0; i < lag; i++) await w.publishNext();
    return r;
  }

  test("a replica one behind takes the index, one manifest and one pack - fewer than walking", async () => {
    const withIndex = await world();
    let indexed = 0;
    try {
      const r = await behind(withIndex, "r1", 1);
      const m = reads(withIndex, "GET manifests");
      const i = reads(withIndex, "GET index");
      const got = await prefetch(credsFor("r1"), "x", r.paths, r.state, r.save);
      expect(got.fetched.seq).toBe(2);
      indexed = reads(withIndex, "GET manifests") - m;
      expect(reads(withIndex, "GET index") - i).toBe(1);
    } finally {
      finish(withIndex);
    }
    const walking = await world();
    try {
      walking.gateway.indexEnabled = false;
      const r = await behind(walking, "r1", 1);
      const m = reads(walking, "GET manifests");
      const got = await prefetch(credsFor("r1"), "x", r.paths, r.state, r.save);
      expect(got.fetched.seq).toBe(2);
      const walked = reads(walking, "GET manifests") - m;
      // The walk fetches the head's manifest and then its parent to see where it stops.
      expect(walked).toBe(2);
      expect(indexed).toBe(1);
    } finally {
      finish(walking);
    }
  });

  test("a head the socket named is not asked for", async () => {
    const w = await world();
    try {
      const r = await behind(w, "r1", 2);
      const heads = reads(w, "GET head");
      const got = await prefetch(credsFor("r1"), "x", r.paths, r.state, r.save, { seq: w.gateway.head!.seq, manifestKey: w.gateway.head!.manifestKey });
      expect(got.fetched.seq).toBe(3);
      expect(reads(w, "GET head")).toBe(heads);
    } finally {
      finish(w);
    }
  });

  test("a gateway with no index, or an index with a hole in it, is walked, and the replica still gets there", async () => {
    const w = await world();
    try {
      const r = await behind(w, "r1", 4);
      w.gateway.indexEntries.splice(2, 1); // a hole
      const got = await prefetch(credsFor("r1"), "x", r.paths, r.state, r.save);
      expect(got.fetched.seq).toBe(5);
    } finally {
      finish(w);
    }
    const old = await world();
    try {
      old.gateway.indexEnabled = false;
      const r = await behind(old, "r1", 3);
      expect((await prefetch(credsFor("r1"), "x", r.paths, r.state, r.save)).fetched.seq).toBe(4);
    } finally {
      finish(old);
    }
  });

  test("an index that claims a snapshot this member cannot open is not believed", async () => {
    const w = await world();
    try {
      await w.publishNext(); // seq 1, sealed for the primary only
      const r = w.replica("r1"); // joins after it
      await w.publishNext(); // seq 2: a whole tree, sealed for r1 too (the roster changed)
      await w.publishNext();
      // The index is honest about sizes but cannot know who a snapshot is sealed for:
      // the replica finds out from the manifest, and takes the tree at 2.
      const got = await prefetch(credsFor("r1"), "x", r.paths, r.state, r.save);
      expect(got.fetched.seq).toBe(3);
      const { applied } = positions(r.state);
      expect(applied.seq).toBe(0);
      await applyReady(credsFor("r1"), "x", r.paths, r.state, r.save);
      expect(sameTree(fingerprint(w.primaryWork), fingerprint(r.paths.work))).toBe(true);
    } finally {
      finish(w);
    }
  });
});

describe("what the socket says", () => {
  test("a head news without a manifest, from a gateway that does not name it, still parses", async () => {
    const { parseFleetEvent } = await import("../src/fleet-events");
    expect(parseFleetEvent('{"type":"head","seq":4}')).toEqual({ type: "head", seq: 4 });
    expect(parseFleetEvent('{"type":"head","seq":4,"manifestKey":"fleets/x/manifests/abc"}')).toEqual({
      type: "head",
      seq: 4,
      manifestKey: "fleets/x/manifests/abc",
    });
    expect(parseFleetEvent('{"type":"head","seq":4,"manifestKey":7}')).toEqual({ type: "head", seq: 4 });
  });
});

describe("a report that did not get through", () => {
  const quick = (): (() => void) => {
    const saved = [...reportBackoff.delays];
    reportBackoff.delays = [0, 0];
    return () => void (reportBackoff.delays = saved);
  };

  test("a replica whose report was lost says it again at its next try, and takes the lease", async () => {
    const restore = quick();
    const w = await world();
    try {
      const r = w.replica("r1");
      await w.publishNext();
      await pull(credsFor("r1"), "x", r.paths, 0, null, (s) => r.save({ seq: s.seq, base: s.commit, tree: s.tree }));
      for (let i = 0; i < 3; i++) await w.publishNext();
      w.gateway.primary = ""; // the primary is gone for good; the head will not move again

      const ask = async (): Promise<PlaceAnswer> => {
        const res = await fetch("http://fake/fleets/x/bootstrap", { method: "POST", headers: { "x-prime-device": "r1" }, body: "{}" } as RequestInit);
        const b = (await res.json()) as { role?: string; reason?: string; catchUpTo?: number };
        return { primary: b.role === "primary", ...(b.reason ? { reason: b.reason } : {}), ...(b.catchUpTo ? { catchUpTo: b.catchUpTo } : {}) };
      };
      const catchUp = async (): Promise<void> => {
        await prefetch(credsFor("r1"), "x", r.paths, r.state, r.save);
        await applyReady(credsFor("r1"), "x", r.paths, r.state, r.save, { report: true });
      };
      // The first report is lost, every attempt of it.
      w.gateway.failApplied = 3;
      await expect(promote({ takePlace: ask, catchUp })).rejects.toThrow("could not tell the fleet");
      expect(r.state.seq).toBe(4); // the work tree is written and recorded
      expect(w.gateway.applied.get("r1")).toBe(1);
      // The next try finds nothing to apply, and still says where it is.
      expect(await promote({ takePlace: ask, catchUp })).toBe("primary");
      expect(w.gateway.applied.get("r1")).toBe(4);
    } finally {
      restore();
      finish(w);
    }
  });

  test("a primary whose report of its own publish was lost can publish again", async () => {
    const restore = quick();
    const w = await world();
    try {
      await w.publishNext();
      w.gateway.failApplied = 3; // the report after the next publish never arrives
      const second = await w.publishNext();
      expect(second.seq).toBe(2);
      expect(w.gateway.applied.get("primary-device")).toBe(1);
      // An older gateway refuses "catch up first"; the member says where it is and publishes.
      const third = await w.publishNext();
      expect(third.seq).toBe(3);
      expect(w.gateway.applied.get("primary-device")).toBe(3);
    } finally {
      restore();
      finish(w);
    }
  });

  test("a report is retried, and says so when it cannot get through", async () => {
    const restore = quick();
    const w = await world();
    try {
      w.gateway.failApplied = 2;
      expect(await reportApplied(credsFor("primary-device"), "x", 1)).toBe(true);
      expect(w.gateway.applied.get("primary-device")).toBe(1);
      w.gateway.failApplied = 5;
      await expect(reportApplied(credsFor("primary-device"), "x", 2)).rejects.toThrow("status 503");
      w.gateway.failApplied = 0;
      // A refusal that asking again cannot change is not repeated.
      const before = w.gateway.requests.get("POST applied") ?? 0;
      await expect(reportApplied(credsFor("stranger"), "x", 1)).resolves.toBe(true); // the fake accepts anyone
      expect((w.gateway.requests.get("POST applied") ?? 0) - before).toBe(1);
    } finally {
      restore();
      finish(w);
    }
  });
});

describe("a member that came back with a new key", () => {
  // The key file is lost and made again, and the fleet records the new key.
  const rotate = (w: World, r: ReturnType<World["replica"]>) => {
    rmSync(r.paths.keyFile);
    w.gateway.members.get(r.id)!.pubkey = loadOrCreateKeyPair(r.paths.keyFile).publicKey;
  };

  async function stuck(w: World) {
    const r = w.replica("r1");
    await w.publishNext();
    await pull(credsFor("r1"), "x", r.paths, 0, null, (s) => r.save({ seq: s.seq, base: s.commit, tree: s.tree }));
    await w.publishNext();
    await w.publishNext(); // sealed for the old key
    rotate(w, r);
    const whole = await w.publishNext(); // the roster gained a key: a whole tree, and the change, for the new one
    expect(whole.full).toBe(true);
    return r;
  }

  test("is not sent through snapshots that were sealed for the key it had", async () => {
    const w = await world();
    try {
      const r = await stuck(w);
      const got = await prefetch(credsFor("r1"), "x", r.paths, r.state, r.save);
      expect(got.fetched.seq).toBe(4);
      const done = await applyReady(credsFor("r1"), "x", r.paths, r.state, r.save);
      expect(done!.applied.seq).toBe(4);
      expect(sameTree(fingerprint(w.primaryWork), fingerprint(r.paths.work))).toBe(true);
    } finally {
      finish(w);
    }
  });

  test("finds its way too when the snapshots do not say which key they were sealed for", async () => {
    const w = await world();
    try {
      w.gateway.stripKeyIds = true; // a publisher from before the fingerprint
      const r = await stuck(w);
      const got = await prefetch(credsFor("r1"), "x", r.paths, r.state, r.save);
      expect(got.fetched.seq).toBe(4);
    } finally {
      finish(w);
    }
  });

  test("the route only goes through what the member's own key opens", () => {
    const m = (seq: number, keyId: string | undefined, over: Partial<Parameters<typeof chooseRoute>[0][number]> = {}) =>
      ({
        fleet: "x", seq, tipCommit: "c" + seq, tree: "t" + seq, packKey: "fleets/x/packs/p" + seq, packHash: "p", full: false,
        packBytes: 10, senderPublicKey: "k", epoch: 1, createdAt: 0,
        wrapped: [{ memberId: "me", wrapped: "w", ...(keyId ? { keyId } : {}) }], ...over,
      }) as Parameters<typeof chooseRoute>[0][number];
    const walked = [
      m(4, "NEW", { full: true, packBytes: 900, delta: { packKey: "fleets/x/packs/d4", packHash: "d", bytes: 10 } }),
      m(3, "OLD"),
      m(2, "OLD"),
    ];
    // A member holding seq 1, with the new key: the old-key snapshots are no steps.
    const route = chooseRoute(walked, 1, { memberId: "me", keyId: "NEW" })!;
    expect(route.map((s) => [s.manifest.seq, s.whole])).toEqual([[4, true]]);
    // With no fingerprint to compare (an older snapshot), the id decides.
    expect(chooseRoute([m(3, undefined), m(2, undefined)], 1, { memberId: "me", keyId: "NEW" })!.length).toBe(2);
    // Snapshots up to a failed step are out.
    expect(chooseRoute([m(4, undefined, { full: true, packBytes: 900 }), m(3, undefined), m(2, undefined)], 1, { memberId: "me", skipThrough: 3 })!.map((s) => s.manifest.seq)).toEqual([4]);
  });
});

describe("a member that joined and has nothing sealed for it yet", () => {
  test("is told so after reading one manifest, not the whole retained history", async () => {
    const w = await world(6);
    try {
      for (let i = 0; i < 36; i++) await w.publishNext(); // a checkpoint at 32, whole tree and change
      const r = w.replica("newcomer");
      w.gateway.requests.clear();
      let message = "";
      try {
        await prefetch(credsFor("newcomer"), "x", r.paths, r.state, r.save);
      } catch (err) {
        message = String(err);
      }
      expect(message).toContain("no snapshot sealed for this member yet");
      expect(w.gateway.requests.get("GET manifests") ?? 0).toBeLessThanOrEqual(2);

      // The same without an index to start from.
      w.gateway.indexEnabled = false;
      w.gateway.requests.clear();
      await expect(prefetch(credsFor("newcomer"), "x", r.paths, r.state, r.save)).rejects.toThrow("no snapshot sealed for this member yet");
      expect(w.gateway.requests.get("GET manifests") ?? 0).toBe(1);

      // The primary notices the roster and publishes again: now there is something.
      await w.publishNext();
      const got = await prefetch(credsFor("newcomer"), "x", r.paths, r.state, r.save);
      expect(got.fetched.seq).toBe(37);
    } finally {
      finish(w);
    }
  }, 60_000);
});

describe("a replica that takes over knows who the fleet was sealed for", () => {
  test("it does not take the fleet for changed: no whole tree, no snapshot for nothing", async () => {
    const w = await world();
    try {
      const r = w.replica("r1");
      await w.publishNext();
      await pull(credsFor("r1"), "x", r.paths, 0, null, (s) => r.save({ seq: s.seq, base: s.commit, tree: s.tree, ...(s.roster !== undefined ? { roster: s.roster } : {}) }));
      const second = await w.publishNext();
      for (let i = 0; i < 2; i++) await w.publishNext();
      await prefetch(credsFor("r1"), "x", r.paths, r.state, r.save);
      w.gateway.primary = "";
      const outcome = await promote({
        takePlace: async () => {
          const res = await fetch("http://fake/fleets/x/bootstrap", { method: "POST", headers: { "x-prime-device": "r1" }, body: "{}" } as RequestInit);
          const b = (await res.json()) as { role?: string; reason?: string; catchUpTo?: number };
          return { primary: b.role === "primary", ...(b.reason ? { reason: b.reason } : {}), ...(b.catchUpTo ? { catchUpTo: b.catchUpTo } : {}) };
        },
        catchUp: async () => {
          await applyReady(credsFor("r1"), "x", r.paths, r.state, r.save, { report: true });
        },
      });
      expect(outcome).toBe("primary");
      // The roster of the snapshot it applied is the one it publishes from.
      expect(r.state.roster).toBe(second.roster);
      writeFileSync(join(r.paths.work, "new.txt"), "from the new primary");
      const next = await publish(credsFor("r1"), "x", r.paths, r.state.base!, r.state.seq!, 2, r.state.roster);
      expect(next.full).toBe(false);
    } finally {
      finish(w);
    }
  });
});

describe("a look at the head that gets no answer", () => {
  test("is not taken for another member having won", async () => {
    const w = await world();
    try {
      await w.publishNext();
      w.replica("late"); // the next snapshot is a whole tree with a change beside it
      let heads = 0;
      const handle = w.gateway.handle.bind(w.gateway);
      w.gateway.handle = async (creds, method, path, body, search) => {
        // The look just before the upload fails, and so does the second try.
        if (method === "GET" && path.endsWith("/head") && ++heads >= 2 && heads <= 3) return new Response("{}", { status: 503 });
        return handle(creds, method, path, body, search);
      };
      const next = await w.publishNext();
      expect(next.seq).toBe(2);
      expect(next.full).toBe(true);
    } finally {
      finish(w);
    }
  });

  test("one failed look is asked again, and a real mismatch still refuses", async () => {
    const w = await world();
    try {
      await w.publishNext();
      w.replica("late");
      let heads = 0;
      const handle = w.gateway.handle.bind(w.gateway);
      w.gateway.handle = async (creds, method, path, body, search) => {
        if (method === "GET" && path.endsWith("/head")) {
          heads++;
          if (heads === 2) return new Response("{}", { status: 503 });
          if (heads === 3 && w.gateway.head) return Response.json({ head: { ...w.gateway.head, seq: w.gateway.head.seq + 1 } });
        }
        return handle(creds, method, path, body, search);
      };
      await expect(w.publishNext()).rejects.toThrow("head moved while publishing");
    } finally {
      finish(w);
    }
  });
});

describe("a publish that is refused", () => {
  test("does not leave a change pack behind when the head moved before it was uploaded", async () => {
    const w = await world();
    try {
      await w.publishNext();
      // The next snapshot is a whole tree with a change beside it (a member joined).
      w.replica("late");
      let heads = 0;
      const handle = w.gateway.handle.bind(w.gateway);
      w.gateway.handle = async (creds, method, path, body, search) => {
        // The second look at the head (just before the upload) finds another snapshot on top.
        if (method === "GET" && path.endsWith("/head") && ++heads === 2 && w.gateway.head) {
          return Response.json({ head: { ...w.gateway.head, seq: w.gateway.head.seq + 1 } });
        }
        return handle(creds, method, path, body, search);
      };
      await expect(w.publishNext()).rejects.toThrow("head moved while publishing");
      expect(w.gateway.requests.get("POST packs") ?? 0).toBe(0);
    } finally {
      finish(w);
    }
  });
});

describe("snapshots the gateway lets go of while a catch-up runs", () => {
  test("the catch-up is planned again from what it kept, and the member is told it happened", async () => {
    const w = await world();
    try {
      const r = w.replica("r1");
      await w.publishNext();
      await pull(credsFor("r1"), "x", r.paths, 0, null, (s) => r.save({ seq: s.seq, base: s.commit, tree: s.tree }));
      for (let i = 0; i < 5; i++) await w.publishNext();
      // The pack of seq 4 is gone when it is asked for (let go meanwhile), and back after.
      const handle = w.gateway.handle.bind(w.gateway);
      let gone = true;
      w.gateway.handle = async (creds, method, path, body, search) => {
        if (gone && method === "GET" && path.includes("/packs/")) {
          const wanted = [...w.gateway.payloads.keys()].find((k) => path.endsWith("/" + k.split("/").pop()));
          const manifest = [...w.gateway.payloads.entries()].find(([k, v]) => k.includes("/manifests/") && wanted && v.toString().includes(wanted));
          if (manifest && JSON.parse(manifest[1].toString()).seq === 4) {
            gone = false;
            return new Response("{}", { status: 404 });
          }
        }
        return handle(creds, method, path, body, search);
      };
      const got = await prefetch(credsFor("r1"), "x", r.paths, r.state, r.save);
      expect(got.fetched.seq).toBe(6);
      expect(got.evicted).toBe(1);
      expect(r.state.fetchedSeq).toBe(6);
    } finally {
      finish(w);
    }
  });

  test("a gateway that keeps letting go says so instead of looping", async () => {
    const w = await world();
    try {
      const r = w.replica("r1");
      await w.publishNext();
      await pull(credsFor("r1"), "x", r.paths, 0, null, (s) => r.save({ seq: s.seq, base: s.commit, tree: s.tree }));
      for (let i = 0; i < 3; i++) await w.publishNext();
      const handle = w.gateway.handle.bind(w.gateway);
      w.gateway.handle = async (creds, method, path, body, search) =>
        method === "GET" && path.includes("/packs/") ? new Response("{}", { status: 404 }) : handle(creds, method, path, body, search);
      await expect(prefetch(credsFor("r1"), "x", r.paths, r.state, r.save)).rejects.toThrow("let go by the gateway");
    } finally {
      finish(w);
    }
  });
});

describe("an apply that was stopped before it was recorded", () => {
  test("is recorded next time, and the fleet's files are not taken for the member's own edits", async () => {
    const w = await world();
    try {
      const r = w.replica("r1");
      await w.publishNext();
      await pull(credsFor("r1"), "x", r.paths, 0, null, (s) => r.save({ seq: s.seq, base: s.commit, tree: s.tree }));
      for (let i = 0; i < 3; i++) await w.publishNext();
      await prefetch(credsFor("r1"), "x", r.paths, r.state, r.save);
      // The work tree is written ... and the member is stopped before it says so.
      const { applied, fetched } = positions(r.state);
      await applyFetched(r.paths, applied, fetched);
      expect(r.state.seq).toBe(1);

      const done = await applyReady(credsFor("r1"), "x", r.paths, r.state, r.save);
      expect(done!.applied.seq).toBe(4);
      expect(done!.kept).toBeUndefined();
      expect(r.state.seq).toBe(4);
      expect(w.gateway.applied.get("r1")).toBe(4);
      expect(readdirSync(join(r.paths.work, "..")).filter((n) => n.startsWith("local-change-"))).toEqual([]);
      expect(sameTree(fingerprint(w.primaryWork), fingerprint(r.paths.work))).toBe(true);
    } finally {
      finish(w);
    }
  });
});

describe("what the state says was fetched but is not in the store", () => {
  test("is fetched again from what is there, instead of failing for ever", async () => {
    const w = await world();
    try {
      const r = w.replica("r1");
      await w.publishNext();
      await pull(credsFor("r1"), "x", r.paths, 0, null, (s) => r.save({ seq: s.seq, base: s.commit, tree: s.tree }));
      for (let i = 0; i < 3; i++) await w.publishNext();
      await prefetch(credsFor("r1"), "x", r.paths, r.state, r.save);
      expect(r.state.fetchedSeq).toBe(4);

      // Something cleaned the store (a git gc by hand, with the fetched snapshot unreferenced).
      const long = new Date(Date.now() - 2 * COLLECT_GRACE_MS);
      const walk = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory()) walk(join(dir, e.name));
          else utimesSync(join(dir, e.name), long, long);
        }
      };
      walk(join(r.paths.gitDir, "objects"));
      const { collectStore } = await import("../src/fleet-store");
      await collectStore(r.paths.gitDir, [r.state.base]);

      await w.publishNext();
      const got = await prefetch(credsFor("r1"), "x", r.paths, r.state, r.save);
      expect(got.fetched.seq).toBe(5);
      const done = await applyReady(credsFor("r1"), "x", r.paths, r.state, r.save);
      expect(done!.applied.seq).toBe(5);
      expect(sameTree(fingerprint(w.primaryWork), fingerprint(r.paths.work))).toBe(true);
    } finally {
      finish(w);
    }
  });
});

describe("the member's state file", () => {
  test("is replaced whole, never rewritten in place, and leaves nothing beside it", async () => {
    const { readFleetState, writeFleetState, fleetStateDir } = await import("../src/fleets");
    const root = mkdtempSync(join(tmpdir(), "fleet-state-"));
    try {
      const configPath = join(root, "config.json");
      mkdirSync(fleetStateDir(configPath, "x", "s"), { recursive: true });
      writeFleetState(configPath, "x", "s", { seq: 1, base: "a" });
      const file = join(fleetStateDir(configPath, "x", "s"), "state.json");
      const before = statSync(file).ino;
      writeFleetState(configPath, "x", "s", { seq: 2, base: "b", roster: "r" });
      // A reader that opened the old one keeps a whole file; the new one is another file.
      expect(statSync(file).ino).not.toBe(before);
      expect(readFleetState(configPath, "x", "s")).toEqual({ seq: 2, base: "b", roster: "r" });
      expect(readdirSync(fleetStateDir(configPath, "x", "s")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Drives the rounds of several spaces the way the agent does, on a clock that is ours:
// each round, then the sleep the daemon would sleep, then the next.
async function runRounds(
  spaces: Array<{ loop: any; round: () => Promise<void> }>,
  loopSleepMs: (loop: any, pollMs: number, now?: number) => number,
  minutes: number,
  start = 5_000_000,
): Promise<{ rounds: number[]; failedRounds: number[] }> {
  const real = Date.now;
  let clock = start;
  Date.now = () => clock;
  const rounds = spaces.map(() => 0);
  const failedRounds = spaces.map(() => 0);
  const next = spaces.map(() => start);
  try {
    while (clock < start + minutes * 60_000) {
      const i = next.indexOf(Math.min(...next));
      clock = Math.max(clock, next[i]!);
      if (clock >= start + minutes * 60_000) break;
      const sp = spaces[i]!;
      rounds[i]!++;
      try {
        await sp.round();
        sp.loop.failures = 0;
      } catch {
        failedRounds[i]!++;
        sp.loop.failures = (sp.loop.failures ?? 0) + 1;
      }
      next[i] = clock + loopSleepMs(sp.loop, 1500, clock);
    }
  } finally {
    Date.now = real;
  }
  return { rounds, failedRounds };
}

describe("a claim and the pace of the agent's rounds", () => {
  async function two() {
    const { loopSleepMs } = await import("../src/fleet-daemon");
    return loopSleepMs;
  }

  test("a primary that was current when the lease was freed does not keep claiming: its rounds go at the poll's pace", async () => {
    const loopSleepMs = await two();
    const w = await world();
    try {
      const s = await baseline(w, "r1"); // applied == head
      w.gateway.primary = "";
      s.loop.claim = true; // what a lease-free sets
      await s.round();
      expect(s.loop.primary).toBe(true);
      expect(s.loop.claim).toBe(false);
      expect(loopSleepMs(s.loop, 1500)).toBe(s.loop.events.connected ? 30_000 : 1500);
      s.loop.events = { connected: false } as never;
      expect(loopSleepMs(s.loop, 1500)).toBe(1500);
    } finally {
      finish(w);
    }
  });

  test("a stopped or paused space does not wake its round for a claim", async () => {
    const loopSleepMs = await two();
    const w = await world();
    try {
      const s = await space(w, "r1", { connected: false });
      s.loop.claim = true;
      s.loop.claimAt = Date.now() - 1000;
      expect(loopSleepMs(s.loop, 1500)).toBeLessThanOrEqual(1500);
      s.loop.paused = true;
      expect(loopSleepMs(s.loop, 1500)).toBeGreaterThanOrEqual(60_000);
    } finally {
      finish(w);
    }
  });

  test("a failed request while the lease is free does not put a replica with a socket to sleep for minutes", async () => {
    const loopSleepMs = await two();
    const w = await world();
    try {
      const s = await space(w, "r1", { connected: true });
      s.loop.claim = true;
      s.loop.claimAt = Date.now() - 1000;
      s.loop.failures = 1;
      // Back-off from the poll's pace (3 s), not from the five minutes an idle replica with a socket sleeps.
      expect(loopSleepMs(s.loop, 1500)).toBeLessThanOrEqual(30_000);
      s.loop.failures = 3;
      expect(loopSleepMs(s.loop, 1500)).toBeLessThanOrEqual(30_000);
      expect(loopSleepMs(s.loop, 1500)).toBeGreaterThanOrEqual(10_000);
      // Without a claim an idle replica with a socket sleeps long, as it should.
      s.loop.claim = false;
      expect(loopSleepMs(s.loop, 1500)).toBeGreaterThanOrEqual(60_000);
    } finally {
      finish(w);
    }
  });

  test("a failing round waits as the back-off says, claim pending or not", async () => {
    const loopSleepMs = await two();
    const { roundSleepMs } = await import("../src/fleet-events");
    const w = await world();
    try {
      const s = await space(w, "r1", { connected: false });
      s.loop.claim = true;
      s.loop.claimAt = Date.now() - 1000; // due since a while
      expect(loopSleepMs(s.loop, 1500)).toBeLessThanOrEqual(15_000);
      s.loop.failures = 4;
      const waits = loopSleepMs(s.loop, 1500);
      expect(waits).toBeGreaterThanOrEqual(24_000);
      // Not the 200 ms of a claim that is due, whatever failed; and bounded by the failing round's own maximum.
      expect(waits).toBeLessThanOrEqual(roundSleepMs({ paused: false, connected: false, pollMs: 15_000, failures: 30 }));
    } finally {
      finish(w);
    }
  });

  test("a refusal that says when to ask again is waited for while a claim is pending", async () => {
    const loopSleepMs = await two();
    const w = await world();
    try {
      const s = await space(w, "r1", { connected: false });
      s.loop.claim = true;
      s.loop.claimAt = Date.now() - 1000;
      s.loop.failures = 1;
      expect(loopSleepMs(s.loop, 1500)).toBeLessThan(10_000);
      // The gateway answered 429 with retry-after: 90.
      s.loop.refusedForMs = 90_000;
      expect(loopSleepMs(s.loop, 1500)).toBeGreaterThanOrEqual(90_000);
      // Not for ever: the round's own maximum still bounds it.
      s.loop.refusedForMs = 3_600_000;
      expect(loopSleepMs(s.loop, 1500)).toBeLessThanOrEqual(5 * 60_000);
    } finally {
      finish(w);
    }
  });

  test("what a refusal asked for is waited for through the real request, and forgotten once another outcome comes", async () => {
    const loopSleepMs = await two();
    const w = await world();
    try {
      const s = await space(w, "r1", { connected: false });
      const orig = w.gateway.handle.bind(w.gateway);
      let mode: "refuse" | "drop" | "ok" = "refuse";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (w.gateway as any).handle = async (creds: any, method: string, path: string, ...rest: any[]) => {
        if (path.includes("/bootstrap")) {
          if (mode === "refuse") return new Response(JSON.stringify({ error: "slow down" }), { status: 429, headers: { "retry-after": "90" } });
          if (mode === "drop") throw new Error("connection reset");
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (orig as any)(creds, method, path, ...rest);
      };
      const askAgain = async (): Promise<void> => {
        s.loop.claim = true;
        s.loop.claimAt = 0;
        await s.round().catch(() => undefined);
      };
      await askAgain();
      expect(s.loop.refusedForMs).toBe(90_000);
      s.loop.failures = 1;
      expect(loopSleepMs(s.loop, 1500)).toBeGreaterThanOrEqual(90_000);
      // The next request is lost on the way: the old retry-after no longer says anything about the gateway.
      mode = "drop";
      await askAgain();
      expect(s.loop.refusedForMs).toBeUndefined();
      expect(loopSleepMs(s.loop, 1500)).toBeLessThan(30_000);
      // And an answer that is not a refusal clears it too.
      mode = "refuse";
      await askAgain();
      expect(s.loop.refusedForMs).toBe(90_000);
      mode = "ok";
      await askAgain();
      expect(s.loop.refusedForMs).toBeUndefined();
    } finally {
      finish(w);
    }
  });

  test("a member that can never catch up asks a few times and stops claiming, and a healthy replica takes over", async () => {
    const loopSleepMs = await two();
    const w = await world();
    try {
      const healthy = await baseline(w, "r1");
      for (let i = 0; i < 3; i++) await w.publishNext();
      healthy.loop.headDirty = true;
      await healthy.round(); // fetched, not applied
      // A member that is admitted while no primary is up: nothing is sealed for it.
      const stuck = await space(w, "newcomer", { connected: false });
      w.gateway.primary = ""; // the primary is gone
      healthy.loop.claim = true;
      stuck.loop.claim = true;

      w.gateway.requests.clear();
      const spaces = [stuck, healthy];
      const { rounds } = await runRounds(spaces, loopSleepMs, 10);
      expect(healthy.loop.primary).toBe(true);
      expect(sameTree(fingerprint(w.primaryWork), fingerprint(healthy.paths.work))).toBe(true);
      // It asked for its place as a replica does (every fifteen seconds), not every round of a claim.
      expect(rounds[0]!).toBeLessThan(200);
      expect(w.gateway.bootstraps).toBeLessThan(120);
    } finally {
      finish(w);
    }
  }, 60_000);
});

describe("the heartbeat against the lease", () => {
  test("a renewal that fails is tried again in two seconds, and one that hangs is cut off", async () => {
    const { BEAT_RETRY_MS, PLACE_TIMEOUT_MS, heartbeat, heartbeatIntervalMs, nextBeatDelayMs } = await import("../src/fleet-daemon");
    expect(nextBeatDelayMs(true, 15_000)).toBe(15_000);
    expect(nextBeatDelayMs(false, 15_000)).toBe(BEAT_RETRY_MS);
    expect(nextBeatDelayMs(false, 1_000)).toBe(1_000); // never later than an interval
    // A request for the place is under a quarter of the lease.
    expect(PLACE_TIMEOUT_MS * 4).toBeLessThanOrEqual(45_000);

    // The worst case, with the numbers the agent has: a renewal an interval after the last that
    // went through, then each failing as slowly as it may and tried again. Two failures still
    // leave a third attempt that starts before the place is gone.
    const lease = 45_000;
    const interval = heartbeatIntervalMs(lease, 15_000);
    const thirdStarts = interval + 2 * (PLACE_TIMEOUT_MS + BEAT_RETRY_MS);
    expect(thirdStarts).toBeLessThan(lease);
    expect(lease - thirdStarts).toBeGreaterThan(2_000); // and time to be answered

    // And it says whether it went through.
    const w = await world();
    try {
      const s = await space(w, "r1", { connected: false });
      s.loop.lastBootstrap = 1;
      s.loop.primary = true;
      const ok = await heartbeat(s.loop as never, () => undefined, 10_000_000);
      expect(ok).toBe(true);
      w.gateway.members.delete("r1"); // the fleet refuses it now
      s.loop.lastBootstrap = 1;
      const bad = await heartbeat(s.loop as never, () => undefined, 20_000_000);
      expect(bad).toBe(false);
    } finally {
      finish(w);
    }
  });
});

describe("a snapshot from a publisher that does not say who it was sealed for", () => {
  test("leaves the member not knowing, not holding the roster of an earlier snapshot", async () => {
    const w = await world();
    try {
      const r = w.replica("r1");
      // Both publishers predate seals (a fleet that has seen a sealed snapshot refuses an unsealed newer one).
      w.gateway.unsealed = true;
      await w.publishNext();
      await pull(credsFor("r1"), "x", r.paths, 0, null, (s) => r.save({ seq: s.seq, base: s.commit, tree: s.tree, roster: s.roster ?? "" }));
      expect(r.state.roster).not.toBe("");
      // The next publisher is an older one.
      w.gateway.stripRoster = true;
      await w.publishNext();
      await prefetch(credsFor("r1"), "x", r.paths, r.state, r.save);
      expect(r.state.fetchedRoster).toBe("");
      await applyReady(credsFor("r1"), "x", r.paths, r.state, r.save);
      expect(r.state.roster).toBe("");

      // Taking over, it cannot say nothing changed: it publishes a whole tree, as it always did.
      w.gateway.primary = "";
      await fetch("http://fake/fleets/x/bootstrap", { method: "POST", headers: { "x-prime-device": "r1" }, body: "{}" } as RequestInit);
      writeFileSync(join(r.paths.work, "new.txt"), "x");
      const next = await publish(credsFor("r1"), "x", r.paths, r.state.base!, r.state.seq!, 2, r.state.roster);
      expect(next.full).toBe(true);
    } finally {
      finish(w);
    }
  });
});

describe("what a person sets for the agent", () => {
  const dirs: string[] = [];
  const configIn = (): string => {
    const root = mkdtempSync(join(tmpdir(), "fleet-settings-"));
    dirs.push(root);
    return join(root, "config.json");
  };
  const cleanup = (): void => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  };

  test("PRIME_FLEET_REPLICA reaches the agent that `prime fleets agent start` spawns", async () => {
    const { buildAgentEnv, persistAgentSettings } = await import("../src/fleet-daemon");
    try {
      const configPath = configIn();
      // The shell the person typed it in: only a short list of the environment goes on, and this is on it.
      const env = { PATH: "/bin", HOME: "/h", SECRET_TOKEN: "no", PRIME_FLEET_REPLICA: "mirror", PRIME_FLEET_CACHE_MB: "64" };
      persistAgentSettings(configPath, env);
      const child = buildAgentEnv(configPath, {}, env);
      expect(child.PRIME_FLEET_REPLICA).toBe("mirror");
      expect(child.PRIME_FLEET_CACHE_MB).toBe("64");
      expect(child.SECRET_TOKEN).toBeUndefined();
      // A value that means nothing is not passed on.
      expect(buildAgentEnv(configIn(), {}, { PRIME_FLEET_REPLICA: "sideways", PRIME_FLEET_CACHE_MB: "-1" }).PRIME_FLEET_REPLICA).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("a restart by the service, which has no such environment, keeps the mode that was set", async () => {
    const { applyAgentSettings, buildAgentEnv, persistAgentSettings, readAgentSettings } = await import("../src/fleet-daemon");
    try {
      const configPath = configIn();
      persistAgentSettings(configPath, { PRIME_FLEET_REPLICA: "mirror" });
      expect(readAgentSettings(configPath)).toEqual({ replica: "mirror" });
      // The agent as the service starts it: nothing in its environment.
      const serviceEnv: Record<string, string | undefined> = { PATH: "/bin" };
      applyAgentSettings(configPath, serviceEnv);
      expect(serviceEnv.PRIME_FLEET_REPLICA).toBe("mirror");
      expect(replicaMode(serviceEnv)).toBe("mirror");
      // And so does one started again from a shell that set nothing.
      expect(buildAgentEnv(configPath, {}, { PATH: "/bin" }).PRIME_FLEET_REPLICA).toBe("mirror");
      // What the start says wins, and is remembered in turn.
      const explicit: Record<string, string | undefined> = { PRIME_FLEET_REPLICA: "lazy" };
      applyAgentSettings(configPath, explicit);
      expect(explicit.PRIME_FLEET_REPLICA).toBe("lazy");
      persistAgentSettings(configPath, explicit);
      expect(readAgentSettings(configPath).replica).toBe("lazy");
      // A corrupt file is no settings.
      writeFileSync(join(configPath, "..", "fleet-agent", "settings.json"), "{not json");
      expect(readAgentSettings(configPath)).toEqual({});
    } finally {
      cleanup();
    }
  });

  test("a setting is cleared by naming it empty, and the file goes when nothing is left", async () => {
    const { applyAgentSettings, buildAgentEnv, persistAgentSettings, readAgentSettings, resetAgentSettings, agentSettingsPath } = await import("../src/fleet-daemon");
    try {
      const configPath = configIn();
      persistAgentSettings(configPath, { PRIME_FLEET_REPLICA: "mirror", PRIME_FLEET_CACHE_MB: "64" });
      // A clean shell says nothing and changes nothing; an empty variable is the person saying "back to the default".
      persistAgentSettings(configPath, {});
      expect(readAgentSettings(configPath)).toEqual({ replica: "mirror", cacheMb: 64 });
      persistAgentSettings(configPath, { PRIME_FLEET_REPLICA: "" });
      expect(readAgentSettings(configPath)).toEqual({ cacheMb: 64 });
      expect(buildAgentEnv(configPath, {}, { PRIME_FLEET_REPLICA: "" }).PRIME_FLEET_REPLICA).toBeUndefined();
      persistAgentSettings(configPath, { PRIME_FLEET_CACHE_MB: "" });
      expect(readAgentSettings(configPath)).toEqual({});
      expect(existsSync(agentSettingsPath(configPath))).toBe(false);

      persistAgentSettings(configPath, { PRIME_FLEET_REPLICA: "mirror" });
      resetAgentSettings(configPath);
      expect(readAgentSettings(configPath)).toEqual({});
      const serviceEnv: Record<string, string | undefined> = { PATH: "/bin" };
      applyAgentSettings(configPath, serviceEnv);
      expect(serviceEnv.PRIME_FLEET_REPLICA).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("the timings are remembered with the rest, so the service runs with those of `agent start`", async () => {
    const { applyAgentSettings, buildAgentEnv, persistAgentSettings, readAgentSettings } = await import("../src/fleet-daemon");
    try {
      const configPath = configIn();
      persistAgentSettings(configPath, { PRIME_FLEET_POLL_MS: "500", PRIME_FLEET_HEARTBEAT_MS: "5000", PRIME_FLEET_REPLICA: "nonsense" });
      expect(readAgentSettings(configPath)).toEqual({ pollMs: 500, heartbeatMs: 5000 });
      const serviceEnv: Record<string, string | undefined> = { PATH: "/bin" };
      applyAgentSettings(configPath, serviceEnv);
      expect(serviceEnv.PRIME_FLEET_POLL_MS).toBe("500");
      expect(serviceEnv.PRIME_FLEET_HEARTBEAT_MS).toBe("5000");
      // A spawned agent has them too, from a shell that set nothing; and what is not a number is not kept.
      const child = buildAgentEnv(configPath, {}, { PATH: "/bin" });
      expect([child.PRIME_FLEET_POLL_MS, child.PRIME_FLEET_HEARTBEAT_MS]).toEqual(["500", "5000"]);
      persistAgentSettings(configPath, { PRIME_FLEET_POLL_MS: "soon" });
      expect(readAgentSettings(configPath).pollMs).toBe(500);
    } finally {
      cleanup();
    }
  });
});

describe("an agent killed while it writes the work tree", () => {
  test("is not taken, next time, for a member whose files are all edited", async () => {
    const w = await world(1200);
    try {
      const r = w.replica("r1");
      await w.publishNext();
      await pull(credsFor("r1"), "x", r.paths, 0, null, (s) => r.save({ seq: s.seq, base: s.commit, tree: s.tree }));
      // The fleet changes every file.
      for (let i = 0; i < 1200; i++) writeFileSync(join(w.primaryWork, "f" + i + ".txt"), "version 2 of " + i);
      await w.publishNext("version 2 of 0"); // seq 2 carries them all
      await prefetch(credsFor("r1"), "x", r.paths, r.state, r.save);
      const { fetched, applied } = positions(r.state);
      expect(fetched.seq).toBe(2);

      // The write is run by a process of its own, which is killed once it has begun.
      const child = Bun.spawn(["bun", join(import.meta.dir, "helpers", "apply-child.ts"), r.paths.work, r.paths.gitDir, fetched.commit!, applied.commit!], {
        stdout: "ignore",
        stderr: "ignore",
      });
      // Counted while git is replacing the files, so one may be gone for a moment (git unlinks
      // and writes a new one): that is not a file written yet, and not an error.
      const written = (): number =>
        readdirSync(r.paths.work).filter((n) => {
          if (!n.endsWith(".txt")) return false;
          try {
            return readFileSync(join(r.paths.work, n), "utf8").startsWith("version 2");
          } catch {
            return false;
          }
        }).length;
      const until = Date.now() + 20_000;
      while (written() < 20 && Date.now() < until) await new Promise((res) => setTimeout(res, 5));
      process.kill(child.pid, "SIGKILL");
      await child.exited;
      // Its git goes on writing for a moment, as the one in the field did; it is let finish.
      const lock = join(r.paths.gitDir, "apply.index.lock");
      const waitUntil = Date.now() + 20_000;
      while (Date.now() < waitUntil && (existsSync(lock) || written() < 1200)) await new Promise((res) => setTimeout(res, 50));
      expect(r.state.seq).toBe(1); // nothing was recorded

      const done = await applyReady(credsFor("r1"), "x", r.paths, r.state, r.save);
      expect(done!.applied.seq).toBe(2);
      expect(done!.kept).toBeUndefined();
      expect(readdirSync(join(r.paths.work, "..")).filter((n) => n.startsWith("local-change-"))).toEqual([]);
      expect(sameTree(fingerprint(w.primaryWork), fingerprint(r.paths.work))).toBe(true);
    } finally {
      finish(w);
    }
  }, 120_000);
});

describe("the primary's renewal and the rounds", () => {
  test("a primary renews on its beat whatever its rounds are doing", async () => {
    const { heartbeat } = await import("../src/fleet-daemon");
    const w = await world();
    try {
      const s = await space(w, "r1", { connected: true });
      s.loop.primary = true;
      s.loop.failures = 4; // its snapshots keep failing
      s.loop.lastBootstrap = 1;
      const before = w.gateway.bootstraps;
      expect(await heartbeat(s.loop as never, () => undefined, 10_000_000)).toBe(true);
      expect(w.gateway.bootstraps).toBe(before + 1);
      // A replica whose rounds keep failing leaves asking to the round.
      s.loop.primary = false;
      s.loop.lastBootstrap = 1;
      await heartbeat(s.loop as never, () => undefined, 20_000_000);
      expect(w.gateway.bootstraps).toBe(before + 1);
    } finally {
      finish(w);
    }
  });

  test("a beat that finds the round's renewal in flight looks again soon", async () => {
    const { heartbeat, BEAT_RETRY_MS } = await import("../src/fleet-daemon");
    const w = await world();
    try {
      const s = await space(w, "r1", { connected: true });
      s.loop.primary = true;
      s.loop.lastBootstrap = 1;
      s.loop.placing = true; // the round is asking
      expect(await heartbeat(s.loop as never, () => undefined, 10_000_000)).toBe(false);
      expect(s.loop.beatRetryMs).toBe(BEAT_RETRY_MS);
    } finally {
      finish(w);
    }
  });

  test("a renewal the gateway refused is asked again as it said, not every two seconds", async () => {
    const { heartbeat, renewalRetryMs, PlaceRefused, BEAT_RETRY_MS } = await import("../src/fleet-daemon");
    expect(renewalRetryMs(new Error("socket hang up"))).toBe(BEAT_RETRY_MS); // lost on the way: at once
    expect(renewalRetryMs(new PlaceRefused("status 503"))).toBe(5_000);
    expect(renewalRetryMs(new PlaceRefused("status 429", 60_000), 45_000)).toBe(15_000); // never past a third of the lease
    expect(renewalRetryMs(new PlaceRefused("status 429", 8_000), 45_000)).toBe(8_000);
    const w = await world();
    try {
      const s = await space(w, "r1", { connected: true });
      s.loop.primary = true;
      s.loop.lastBootstrap = 1;
      const handle = w.gateway.handle.bind(w.gateway);
      w.gateway.handle = async (creds, method, path, body, search) =>
        path.endsWith("/bootstrap") ? new Response("{}", { status: 429, headers: { "retry-after": "9" } }) : handle(creds, method, path, body, search);
      expect(await heartbeat(s.loop as never, () => undefined, 10_000_000)).toBe(false);
      expect(s.loop.beatRetryMs).toBe(9_000);
    } finally {
      finish(w);
    }
  });
});

describe("an error that says the work tree cannot be written", () => {
  test("is a permission or a full disk; running out of file descriptors is the agent's own load and passes", async () => {
    const { cannotWrite } = await import("../src/fleet-daemon");
    for (const code of ["EACCES", "EPERM", "ENOSPC", "EROFS", "EDQUOT"]) expect(cannotWrite({ code })).toBe(true);
    expect(cannotWrite({ code: "EMFILE" })).toBe(false);
    expect(cannotWrite({ code: "ENFILE" })).toBe(false);
    expect(cannotWrite(new Error("plain"))).toBe(false);
    expect(cannotWrite(null)).toBe(false);
  });
});

describe("what wakes the primary", () => {
  test("the files of a repository in use do not, a repository arriving does", async () => {
    const { insideGitDir } = await import("../src/fleet-daemon");
    expect(insideGitDir(".git/index")).toBe(true);
    expect(insideGitDir("lib/.git/objects/ab/cd")).toBe(true);
    expect(insideGitDir("lib/.git")).toBe(false);
    expect(insideGitDir(".git")).toBe(false);
    expect(insideGitDir("src/index.ts")).toBe(false);
    expect(insideGitDir(".gitignore")).toBe(false);
    expect(insideGitDir(null)).toBe(false);
  });

  test("the watcher stays quiet for writes inside a .git and speaks for the rest", async () => {
    const { watchTree } = await import("../src/fleet-daemon");
    const root = mkdtempSync(join(tmpdir(), "fleet-watch-"));
    mkdirSync(join(root, "lib", ".git"), { recursive: true });
    const seen: string[] = [];
    const watcher = watchTree(root, (_event, name) => void seen.push(String(name)));
    try {
      await Bun.sleep(100);
      writeFileSync(join(root, "lib", ".git", "index"), "1");
      writeFileSync(join(root, "lib", ".git", "HEAD"), "1");
      await Bun.sleep(200);
      expect(seen.filter((n) => n.includes(".git/"))).toEqual([]);
      writeFileSync(join(root, "a.txt"), "1");
      await Bun.sleep(300);
      expect(seen).toContain("a.txt");
    } finally {
      watcher.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("what the primary writes down after it publishes", () => {
  test("its position, and no pointer to a manifest that nothing reads", async () => {
    const w = await world();
    try {
      const s = await space(w, "r1", { connected: true });
      w.gateway.primary = "r1";
      s.loop.primary = true;
      s.loop.dirty = true;
      s.loop.lastBootstrap = Date.now();
      writeFileSync(join(s.paths.work, "made.txt"), "by the primary\n");
      await s.round();
      expect(s.said).toContain("published 1");
      expect(s.state().seq).toBe(1);
      expect(Object.keys(s.state())).not.toContain("manifest");
    } finally {
      finish(w);
    }
  });
});

describe("a state file from an older build", () => {
  test("loses the pointer to a manifest when it is next written", async () => {
    const { readFleetState, writeFleetState } = await import("../src/fleets");
    const root = mkdtempSync(join(tmpdir(), "fleet-state-"));
    try {
      const config = join(root, "config.json");
      const { fleetStateDir } = await import("../src/fleets");
      writeFileSync(join(fleetStateDir(config, "x", "r1"), "state.json"), JSON.stringify({ seq: 3, base: "a".repeat(40), manifest: "fleets/x/manifests/" + "b".repeat(64) }));
      expect(Object.keys(readFleetState(config, "x", "r1"))).toContain("manifest");
      writeFleetState(config, "x", "r1", { ...readFleetState(config, "x", "r1"), seq: 4 });
      const after = readFleetState(config, "x", "r1");
      expect(after.seq).toBe(4);
      expect(Object.keys(after)).not.toContain("manifest");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the beat of a replica that waits for the lease", () => {
  test("wakes the round when it can take the lease now, and leaves it asleep when it is another's turn", async () => {
    const { heartbeat } = await import("../src/fleet-daemon");
    const w = await world();
    try {
      await w.publishNext();
      const s = await space(w, "r1", { connected: false });
      w.gateway.primary = ""; // the lease is free, and r1 is behind
      w.gateway.applied.set("r1", 0);
      let woken = 0;
      s.loop.lastBootstrap = 1;
      // Another replica is catching up and has the claim: r1 is told to wait for it.
      w.gateway.claim = { device: "someone-else", since: Date.now(), until: Date.now() + 20_000, queue: [] };
      expect(await heartbeat(s.loop as never, () => void woken++, 10_000_000)).toBe(true);
      expect(s.loop.claim).toBe(true);
      expect(s.loop.claimAt).toBeGreaterThan(Date.now() + 5_000);
      expect(woken).toBe(0);
      // Nobody has it: r1 may start now.
      w.gateway.claim = null;
      s.loop.lastBootstrap = 1;
      expect(await heartbeat(s.loop as never, () => void woken++, 20_000_000)).toBe(true);
      expect(s.loop.claimAt).toBeLessThanOrEqual(Date.now());
      expect(woken).toBe(1);
    } finally {
      finish(w);
    }
  });
});
