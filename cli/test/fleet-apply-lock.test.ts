// The work tree and the state that says what it holds are written together, by one writer at a time:
// the agent and `prime fleets sync` can both apply, and a state that says N over a work tree that
// holds N-1 makes a takeover publish N-1 on top of N, for the whole fleet.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOrCreateKeyPair, publish, pull, type MemberPaths } from "../src/fleet-agent";
import { LockBusyError, withDirLock } from "../src/dir-lock";
import { fleetStateDir, readFleetState, recordedPosition, updateFleetState, writeFleetState } from "../src/fleets";
import { localChanges } from "../src/fleet-sync";
import { applyReady } from "../src/fleet-replica";

import { FakeGateway, credsFor, useFakeGateway } from "./fleet-fake-gateway";

const roots: string[] = [];
afterEach(() => {
  (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("two writers of one work tree", () => {
  test("a sync that planned to an older head does not write it over what the agent has applied since", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-apply-lock-"));
    roots.push(root);
    const cfg = join(root, "config.yaml");
    const gateway = new FakeGateway();
    gateway.advanceMarksApplied = true;
    useFakeGateway(gateway);
    const mk = (id: string): MemberPaths => {
      mkdirSync(join(root, id), { recursive: true });
      return { work: join(root, id), gitDir: join(root, id + "-store"), keyFile: join(root, id + ".key") };
    };
    const P = mk("p");
    const Q = mk("q");
    Q.gitDir = fleetStateDir(cfg, "x", "q");
    Q.recorded = recordedPosition(cfg, "x", "q");
    gateway.seed("p", loadOrCreateKeyPair(P.keyFile).publicKey);
    gateway.seed("q", loadOrCreateKeyPair(Q.keyFile).publicKey);
    let base: string | null = null;
    let seq = 0;
    let roster: string | undefined;
    const pub = async (v: string): Promise<void> => {
      writeFileSync(join(P.work, "f.txt"), v + "\n");
      const r = await publish(credsFor("p"), "x", P, base, seq, 2, roster);
      base = r.commit;
      seq = r.seq;
      roster = r.roster;
    };
    const tree = (): string => readFileSync(join(Q.work, "f.txt"), "utf8").trim();

    await pub("v1");
    const q1 = await pull(credsFor("q"), "x", Q, 0, null);
    writeFleetState(cfg, "x", "q", { seq: 1, base: q1.commit, tree: q1.tree ?? "", roster: q1.roster ?? "" }, { replace: true });
    await pub("v2");

    // `prime fleets sync` has planned to head 2 and is downloading its pack; the agent publishes 3 and applies it meanwhile.
    const real = globalThis.fetch;
    let held = false;
    (globalThis as { fetch: unknown }).fetch = async (url: string, init: unknown) => {
      if (!held && String(url).includes("/packs/")) {
        held = true;
        (globalThis as { fetch: unknown }).fetch = real;
        await pub("v3");
        const s = readFleetState(cfg, "x", "q");
        await pull(credsFor("q"), "x", Q, s.seq ?? 0, s.base ?? null, (st) => {
          updateFleetState(cfg, "x", "q", { seq: st.seq, base: st.commit, tree: st.tree, fetchedSeq: st.seq, fetchedCommit: st.commit, fetchedTree: st.tree });
        });
        expect(tree()).toBe("v3");
      }
      return real(url, init as never);
    };
    const state = readFleetState(cfg, "x", "q");
    const headWhenPlanned = { ...gateway.head! };
    const pulling = (async () => {
      const saved = gateway.head;
      gateway.head = headWhenPlanned;
      try {
        return await pull(credsFor("q"), "x", Q, state.seq ?? 0, state.base ?? null, (st) => {
          writeFleetState(cfg, "x", "q", { ...state, seq: st.seq, base: st.commit, tree: st.tree, fetchedSeq: st.seq, fetchedCommit: st.commit, fetchedTree: st.tree });
        });
      } finally {
        if (gateway.head === headWhenPlanned) gateway.head = saved;
      }
    })();
    await pulling;
    (globalThis as { fetch: unknown }).fetch = real;

    const after = readFleetState(cfg, "x", "q");
    // The state and the work tree agree, and agree on the newer snapshot.
    expect(after.seq).toBe(3);
    expect(tree()).toBe("v3");
    expect(await localChanges(Q.work, Q.gitDir, after.tree ?? "", { base: after.base })).toEqual([]);
  });
});

describe("an apply that finds the work tree already written", () => {
  test("applyReady writes nothing, and records nothing, when the state says the work tree is at the snapshot already", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-apply-ready-"));
    roots.push(root);
    const saved: unknown[] = [];
    const paths: MemberPaths = {
      work: join(root, "work"),
      gitDir: join(root, "store"),
      keyFile: join(root, "k"),
      recorded: () => ({ seq: 3, commit: "c".repeat(40), tree: "t3" }),
    };
    // The caller read the state when the work tree was at 1 and a fetched 3 was waiting.
    const stale = { seq: 1, base: "a".repeat(40), tree: "t1", fetchedSeq: 3, fetchedCommit: "c".repeat(40), fetchedTree: "t3" };
    const done = await applyReady(credsFor("q"), "x", paths, stale, (patch) => void saved.push(patch));
    expect(done).toBeNull();
    expect(saved).toEqual([]);
    expect(existsSync(paths.work)).toBe(false);
  });
});

describe("a lock between processes", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const scratch = (): string => {
    const d = mkdtempSync(join(tmpdir(), "dir-lock-"));
    dirs.push(d);
    return d;
  };

  test("holders go one at a time", async () => {
    const lock = join(scratch(), "l");
    let inside = 0;
    let most = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        withDirLock(lock, async () => {
          inside++;
          most = Math.max(most, inside);
          await new Promise((r) => setTimeout(r, 15));
          inside--;
        }),
      ),
    );
    expect(most).toBe(1);
    expect(existsSync(lock)).toBe(false);
  });

  test("a lock whose holder is gone is broken, and one that is held is waited for", async () => {
    const dir = scratch();
    const lock = join(dir, "l");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), JSON.stringify({ pid: 2 ** 22 + 12345, token: "dead" }));
    expect(await withDirLock(lock, () => "took it")).toBe("took it");

    const held = withDirLock(lock, () => new Promise((r) => setTimeout(r, 200)), { waitMs: 5000 });
    await new Promise((r) => setTimeout(r, 30));
    await expect(withDirLock(lock, () => "no", { waitMs: 60 })).rejects.toBeInstanceOf(LockBusyError);
    await held;
  });

  test("several that find a stale lock at once break it once, and go one at a time after", async () => {
    const lock = join(scratch(), "l");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), JSON.stringify({ pid: 2 ** 22 + 99, token: "dead" }));
    let inside = 0;
    let most = 0;
    let ran = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withDirLock(lock, async () => {
          inside++;
          ran++;
          most = Math.max(most, inside);
          await new Promise((r) => setTimeout(r, 10));
          inside--;
        }),
      ),
    );
    expect(ran).toBe(8);
    expect(most).toBe(1);
  });

  test("a holder does not remove a lock that was taken from it", async () => {
    const lock = join(scratch(), "l");
    await withDirLock(lock, () => {
      // Broken and taken by another while this one was slow.
      rmSync(lock, { recursive: true, force: true });
      mkdirSync(lock);
      writeFileSync(join(lock, "owner"), JSON.stringify({ pid: process.pid, token: "somebody else" }));
    });
    expect(existsSync(lock)).toBe(true);
  });
});
