import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { chooseRoute } from "../src/fleet-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateKeyPair, publish, pull, type MemberPaths } from "../src/fleet-agent";
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
      expect(results.filter((o) => o === "lease-held").length).toBe(1);
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

  test("with the socket up it asks about once a minute; without, about as often as the lease is renewed", () => {
    expect(placeDue({ ...base, now: 1_000_000 + 10_000, eventsConnected: true })).toBe(false);
    expect(placeDue({ ...base, now: 1_000_000 + 59_000, eventsConnected: true })).toBe(false);
    expect(placeDue({ ...base, now: 1_000_000 + 61_000, eventsConnected: true })).toBe(true);
    expect(placeDue({ ...base, now: 1_000_000 + 4_000, eventsConnected: false })).toBe(false);
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


describe("the agent's round for a replica", () => {
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
    const loop = {
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
  });

  test("without a socket a replica looks at the head every round but takes no place again", async () => {
    const w = await world();
    try {
      const s = await space(w, "r1", { connected: false });
      await w.publishNext();
      await s.round();
      const bootstraps = w.gateway.bootstraps;
      for (let i = 0; i < 5; i++) await s.round();
      expect(w.gateway.bootstraps).toBe(bootstraps);
      expect(w.gateway.requests.get("GET head") ?? 0).toBeGreaterThanOrEqual(5);
    } finally {
      finish(w);
    }
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
