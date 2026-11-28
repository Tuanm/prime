// One agent handing over to the next: the successor an update starts, and a stop that has to reach it.
// The agents here are bun processes whose command line says __fleet-agent and that take the REAL agent lock through
// `acquireStarting`, as `runFleetAgent` does; the service manager is a hooks object.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentBoot } from "../src/boot";
import { acquireAgentLock, agentLockPath } from "../src/fleet-agent-lock";
import {
  acquireStarting,
  claimSuccessor,
  agentRestartJson,
  isSuccessorProcess,
  mayAskAgainToStop,
  readSuccessor,
  registerSuccessor,
  requestStop,
  stopPath,
  stopRequestedSince,
  stopSuccessor,
  stopWaitingSuccessor,
  successorPath,
  takeHandoverEnv,
  watchForStop,
} from "../src/fleet-agent-handover";
import {
  fleetAgentDir,
  fleetAgentStatePath,
  ensureFleetAgent,
  fleetAgentStatus,
  installFleetAgent,
  restartFleetAgentAfterUpdate,
  runFleetAgent,
  stopFleetAgent,
  stopFleetAgentManaged,
  type StartedAgent,
} from "../src/fleet-daemon";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "handover-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (what: () => boolean, ms = 6000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end && !what()) await Bun.sleep(25);
  return what();
};

// Agents that are processes of their own (and a process list that says what they are): not on Windows, where the
// platform-specific behaviour is tested through the `platform` the restart is given, and in CI by the end-to-end run.
const withProcesses = process.platform === "win32" ? describe.skip : describe;

const HANDOVER = JSON.stringify(join(import.meta.dir, "../src/fleet-agent-handover.ts"));

/**
 * An agent: takes the lock the way `runFleetAgent` does (waiting PRIME_FLEET_LOCK_WAIT_MS, and for the agent in
 * PRIME_FLEET_REPLACES), writes its state, and logs what it does. When it is asked to stop (SIGTERM, or, with WATCH, the
 * request file) it finishes a "round" of ROUND_MS (never, if that is "never") and lets go.
 */
function agentScript(configPath: string, log: string): string {
  const dir = fleetAgentDir(configPath);
  return `import { acquireStarting, watchForStop } from ${HANDOVER}; import { appendFileSync, writeFileSync, rmSync } from "node:fs";
    const say = (s) => appendFileSync(${JSON.stringify(log)}, s + " " + process.pid + "\\n");
    const startedAt = Date.now() - process.uptime() * 1000;
    const replaces = Number(process.env.PRIME_FLEET_REPLACES) || undefined;
    say("waiting");
    const lock = await acquireStarting(${JSON.stringify(dir)}, { waitMs: Number(process.env.PRIME_FLEET_LOCK_WAIT_MS ?? 0), startedAt, replaces, onWait: () => say("rearm") });
    if (!lock.held) { say("stopped" in lock ? "stopped" : "gave-up"); process.exit(1); }
    say("took");
    writeFileSync(${JSON.stringify(fleetAgentStatePath(configPath))}, JSON.stringify({ pid: process.pid, started_at: "x", config_path: ${JSON.stringify(configPath)}, replica: "lazy", settings: { replica: "lazy", cacheMb: 512, pollMs: 1500, heartbeatMs: 15000 } }));
    let asked = false;
    const finish = (how) => { if (asked) return; asked = true; say(how); const r = process.env.ROUND_MS;
      if (r === "never") return;
      setTimeout(() => { say("released"); lock.release(); rmSync(${JSON.stringify(fleetAgentStatePath(configPath))}, { force: true }); process.exit(0); }, Number(r ?? 0)); };
    process.on("SIGTERM", () => finish("sigterm"));
    if (process.env.WATCH) watchForStop(${JSON.stringify(dir)}, startedAt, () => finish("stopfile"), 100);
    setInterval(() => {}, 1000);`;
}

type Spawned = StartedAgent & { kill(sig?: string): void };
function startAgent(configPath: string, log: string, env: Record<string, string | undefined> = {}): Spawned {
  const c = Bun.spawn([process.execPath, "-e", agentScript(configPath, log), "__fleet-agent"], {
    env: { ...process.env, ...env },
    stdout: "ignore",
    stderr: "ignore",
  });
  cleanups.push(() => c.kill("SIGKILL"));
  return c as unknown as Spawned;
}

/** An agent that is running and holds the lock. */
async function oldAgent(configPath: string, log: string, round: string, extra: Record<string, string> = {}): Promise<Spawned> {
  mkdirSync(fleetAgentDir(configPath), { recursive: true });
  const a = startAgent(configPath, log, { PRIME_FLEET_LOCK_WAIT_MS: "0", ROUND_MS: round, ...extra });
  expect(await until(() => existsSync(fleetAgentStatePath(configPath)))).toBe(true);
  // A request made in the first moments of an agent's life is for the agent before it (see SLACK_MS).
  await Bun.sleep(150);
  return a;
}

const events = (log: string): Array<{ what: string; pid: number }> =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => {
          const [what, pid] = l.split(" ");
          return { what: what!, pid: Number(pid) };
        })
    : [];
const said = (log: string, pid: number): string[] => events(log).filter((e) => e.pid === pid).map((e) => e.what);
/** At most one holder at any time: replay took/released. */
function maxHolders(log: string): number {
  let n = 0;
  let m = 0;
  for (const e of events(log)) {
    if (e.what === "took") m = Math.max(m, ++n);
    if (e.what === "released") n--;
  }
  return m;
}

const unsupervised = (spawn: (env: Record<string, string | undefined>) => StartedAgent, extra: Record<string, unknown> = {}) => ({
  installed: () => false,
  pid: () => undefined,
  unreachable: () => false,
  restart: () => false,
  stopWaitMs: 1500,
  spawnAgent: spawn,
  ...extra,
});

withProcesses("a stop while an update's successor waits for the lock", () => {
  test("reaches the successor: it never takes the lock, and nothing runs afterwards", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const log = join(root, "log");
    const old = await oldAgent(configPath, log, "5000");
    let fresh: Spawned | undefined;
    const result = await restartFleetAgentAfterUpdate(
      configPath,
      unsupervised((env) => (fresh = startAgent(configPath, log, env))),
      { platform: "linux", startCheckMs: 300, lockWaitMs: 20_000 },
    );
    expect(result.restarted && result.pending).toBe(true);
    // The successor is written down, with its pid.
    expect(readSuccessor(fleetAgentDir(configPath))?.pid).toBe(fresh!.pid);
    // What `agent stop` does with no service.
    expect(await stopFleetAgentManaged(configPath, { installed: () => false, pid: () => undefined, restart: () => false }, 3000)).toMatchObject({ stopped: true, via: "process" });
    expect(await until(() => !alive(old.pid))).toBe(true);
    expect(await until(() => !alive(fresh!.pid))).toBe(true);
    await Bun.sleep(300);
    expect(said(log, fresh!.pid)).not.toContain("took");
    expect(existsSync(successorPath(fleetAgentDir(configPath)))).toBe(false);
    expect(existsSync(fleetAgentStatePath(configPath))).toBe(false);
  }, 20_000);

  test("wins even when it arrives with the handover and the successor is not signalled: the agent that takes the lock leaves", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const log = join(root, "log");
    const old = await oldAgent(configPath, log, "never");
    let fresh: Spawned | undefined;
    await restartFleetAgentAfterUpdate(
      configPath,
      unsupervised((env) => (fresh = startAgent(configPath, log, env))),
      { platform: "linux", startCheckMs: 300, lockWaitMs: 20_000 },
    );
    // A stop whose signal to the successor is lost: only the request, and the old agent leaving.
    requestStop(fleetAgentDir(configPath));
    process.kill(old.pid, "SIGKILL");
    expect(await until(() => !alive(fresh!.pid))).toBe(true);
    expect(said(log, fresh!.pid)).toContain("stopped");
    expect(said(log, fresh!.pid)).not.toContain("took");
    // It took the lock for a moment and let go of it: nothing holds it now.
    expect(existsSync(agentLockPath(fleetAgentDir(configPath)))).toBe(false);
  }, 20_000);

  test("an agent that is started after a stop is not stopped by it, and the old request is cleared", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const log = join(root, "log");
    mkdirSync(fleetAgentDir(configPath), { recursive: true });
    requestStop(fleetAgentDir(configPath), Date.now() - 5000);
    const a = await oldAgent(configPath, log, "0");
    expect(said(log, a.pid)).toContain("took");
    expect(existsSync(stopPath(fleetAgentDir(configPath)))).toBe(false);
  });

  test("`agent stop` reaches it when the agent it replaced is already gone", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const log = join(root, "log");
    const dir = fleetAgentDir(configPath);
    mkdirSync(dir, { recursive: true });
    // A successor that waits for a lock held by an agent of another process (a plain one that holds it).
    const holder = Bun.spawn(["sh", "-c", "sleep 60", "__fleet-agent"], { stdout: "ignore", stderr: "ignore" });
    cleanups.push(() => holder.kill("SIGKILL"));
    writeFileSync(agentLockPath(dir), holder.pid + "\n");
    const waiting = startAgent(configPath, log, { PRIME_FLEET_LOCK_WAIT_MS: "20000" });
    registerSuccessor(dir, waiting.pid);
    expect(await until(() => said(log, waiting.pid).includes("waiting"))).toBe(true);
    // No agent state at all (the old agent is gone): the successor is what there is to stop.
    expect(await stopFleetAgentManaged(configPath, { installed: () => false, pid: () => undefined, restart: () => false })).toMatchObject({ stopped: true });
    expect(await until(() => !alive(waiting.pid))).toBe(true);
  }, 20_000);

  test("`agent install` stops it too, for the service's agent is the one that is left to run", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const log = join(root, "log");
    const old = await oldAgent(configPath, log, "never");
    let fresh: Spawned | undefined;
    await restartFleetAgentAfterUpdate(
      configPath,
      unsupervised((env) => (fresh = startAgent(configPath, log, env))),
      { platform: "linux", startCheckMs: 300, lockWaitMs: 20_000 },
    );
    let installed = 0;
    await installFleetAgent(configPath, { install: () => (installed++, "unit"), boundTo: () => undefined, servicePid: () => old.pid, stopWaitMs: 500 });
    expect(installed).toBe(1);
    expect(await until(() => !alive(fresh!.pid))).toBe(true);
    // The service's own agent is left for its manager to replace.
    expect(alive(old.pid)).toBe(true);
  }, 20_000);
});

withProcesses("two updates at the same moment", () => {
  test("start one successor, and both report that the agent is restarting", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const log = join(root, "log");
    await oldAgent(configPath, log, "4000");
    const fresh: Spawned[] = [];
    const hooks = unsupervised((env) => {
      const a = startAgent(configPath, log, env);
      fresh.push(a);
      return a;
    });
    const opts = { platform: "linux", startCheckMs: 300, lockWaitMs: 20_000 };
    const [a, b] = await Promise.all([restartFleetAgentAfterUpdate(configPath, hooks, opts), restartFleetAgentAfterUpdate(configPath, hooks, opts)]);
    expect(fresh.length).toBe(1);
    expect(a.restarted && a.pending).toBe(true);
    expect(b.restarted && b.pending).toBe(true);
    expect(await until(() => said(log, fresh[0]!.pid).includes("took"))).toBe(true);
    expect(maxHolders(log)).toBe(1);
    // The successor that took over is not a waiting one any more: a later update starts another for it to replace.
    expect(existsSync(successorPath(fleetAgentDir(configPath)))).toBe(false);
  }, 20_000);

  test("a claim that nobody followed with a process, and a successor that is gone, do not keep an update from starting one", () => {
    const dir = join(scratch(), "fleet-agent");
    expect(claimSuccessor(dir, undefined, 1_000_000)).toEqual({ claimed: true, at: 1_000_000 });
    // Somebody is starting one just now.
    expect(claimSuccessor(dir, undefined, 1_000_500)).toEqual({ claimed: false, pid: 0 });
    // Nobody did, and it is long ago.
    expect(claimSuccessor(dir, undefined, 1_100_000)).toEqual({ claimed: true, at: 1_100_000 });
    // A successor that is a live agent is waited for; one that is not, or that is the agent that runs, is not.
    registerSuccessor(dir, 4242, 1_100_000);
    expect(claimSuccessor(dir, undefined, 1_100_100, () => true)).toEqual({ claimed: false, pid: 4242 });
    expect(claimSuccessor(dir, 4242, 1_100_100, () => true)).toEqual({ claimed: true, at: 1_100_100 });
    registerSuccessor(dir, 4243, 1_100_000);
    expect(claimSuccessor(dir, undefined, 1_100_100, () => false)).toEqual({ claimed: true, at: 1_100_100 });
  });
});

withProcesses("an old agent whose round outlasts the successor's wait", () => {
  test("the successor waits on while that agent lives, and takes over when it is gone", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const log = join(root, "log");
    const old = await oldAgent(configPath, log, "never");
    let fresh: Spawned | undefined;
    // A wait of 600 ms: it is over three times before the old agent is ended.
    await restartFleetAgentAfterUpdate(
      configPath,
      unsupervised((env) => (fresh = startAgent(configPath, log, env))),
      { platform: "linux", startCheckMs: 300, lockWaitMs: 600 },
    );
    expect(await until(() => said(log, fresh!.pid).filter((w) => w === "rearm").length >= 2)).toBe(true);
    expect(alive(fresh!.pid)).toBe(true);
    expect(said(log, fresh!.pid)).not.toContain("gave-up");
    // The round ends (here: the agent is ended).
    process.kill(old.pid, "SIGKILL");
    expect(await until(() => said(log, fresh!.pid).includes("took"))).toBe(true);
    expect(alive(fresh!.pid)).toBe(true);
  }, 20_000);

  test("one that was not started to replace anybody gives up, as it always did", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const log = join(root, "log");
    const old = await oldAgent(configPath, log, "never");
    const second = startAgent(configPath, log, { PRIME_FLEET_LOCK_WAIT_MS: "300" });
    expect(await until(() => !alive(second.pid))).toBe(true);
    expect(said(log, second.pid)).toContain("gave-up");
    expect(alive(old.pid)).toBe(true);
  }, 20_000);
});

describe("asking an agent to stop in a file", () => {
  test("a request is for the agents that were started before it", () => {
    const dir = join(scratch(), "fleet-agent");
    expect(stopRequestedSince(dir, 0)).toBe(false);
    requestStop(dir, 5000);
    expect(stopRequestedSince(dir, 4000)).toBe(true);
    // An agent that started within the margin of its clock is not asked by a request that came as it started.
    expect(stopRequestedSince(dir, 4990)).toBe(false);
    expect(stopRequestedSince(dir, 5000)).toBe(false);
    expect(stopRequestedSince(dir, 9999)).toBe(false);
    // One for a single agent is for that one.
    requestStop(dir, 5000, 42);
    expect(stopRequestedSince(dir, 4000, 42)).toBe(true);
    expect(stopRequestedSince(dir, 4000, 43)).toBe(false);
  });

  test("a running agent sees it and stops what it is doing, once", async () => {
    const dir = join(scratch(), "fleet-agent");
    let stops = 0;
    const end = watchForStop(dir, Date.now() - 1000, () => stops++, 20);
    await Bun.sleep(80);
    expect(stops).toBe(0);
    requestStop(dir);
    expect(await until(() => stops > 0, 2000)).toBe(true);
    await Bun.sleep(100);
    expect(stops).toBe(1);
    end();
  });

  test("an agent that is asked while it starts leaves without running, and without a failure exit", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    // A request from the future of this process (it was started a moment ago): the stop that came with its start.
    requestStop(fleetAgentDir(configPath), Date.now() + 1000);
    const was = process.exitCode ?? 0;
    cleanups.push(() => {
      process.exitCode = was;
    });
    await runFleetAgent(configPath, { lockWaitMs: 100 });
    expect(process.exitCode ?? 0).toBe(was);
    expect(existsSync(fleetAgentStatePath(configPath))).toBe(false);
    expect(existsSync(agentLockPath(fleetAgentDir(configPath)))).toBe(false);
  });

  test("stopSuccessor signals a live agent only, and forgets the entry either way", () => {
    const dir = join(scratch(), "fleet-agent");
    const killed: number[] = [];
    registerSuccessor(dir, 777);
    expect(stopSuccessor(dir, () => false, (pid) => void killed.push(pid))).toBeUndefined();
    expect(existsSync(successorPath(dir))).toBe(false);
    registerSuccessor(dir, 778);
    expect(stopSuccessor(dir, () => true, (pid) => void killed.push(pid))).toBe(778);
    expect(killed).toEqual([778]);
  });

  test("taking the lock finds the request even when the agent waited for it", async () => {
    const dir = join(scratch(), "fleet-agent");
    mkdirSync(dir, { recursive: true });
    requestStop(dir, 10_000);
    const lock = await acquireStarting(dir, { waitMs: 0, startedAt: 9_000 });
    expect(lock.held).toBe(false);
    expect("stopped" in lock && lock.stopped).toBe(true);
    // Not holding it any more.
    const again = await acquireAgentLock(dir, { waitMs: 0 });
    expect(again.held).toBe(true);
    if (again.held) again.release();
  });
});

withProcesses("on Windows an agent is asked in the file, and ended only when it does not finish", () => {
  test("`agent stop`: an agent that sees the request finishes and leaves, and is never signalled", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const log = join(root, "log");
    const old = await oldAgent(configPath, log, "300", { WATCH: "1" });
    const stopped = await stopFleetAgentManaged(configPath, { installed: () => false, pid: () => undefined, restart: () => false }, 5000, "win32");
    expect(stopped).toMatchObject({ stopped: true, via: "process" });
    expect(alive(old.pid)).toBe(false);
    expect(said(log, old.pid)).toContain("stopfile");
    expect(said(log, old.pid)).not.toContain("sigterm");
    expect(said(log, old.pid)).toContain("released");
  }, 20_000);

  test("`agent stop`: one that does not is ended after the time it was given", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const log = join(root, "log");
    // Does not look at the file (an agent of an older build): the signal is what ends it.
    const old = await oldAgent(configPath, log, "0");
    const began = Date.now();
    await stopFleetAgentManaged(configPath, { installed: () => false, pid: () => undefined, restart: () => false }, 600, "win32");
    expect(Date.now() - began).toBeGreaterThanOrEqual(550);
    expect(await until(() => !alive(old.pid))).toBe(true);
    expect(said(log, old.pid)).toContain("sigterm");
  }, 20_000);

  test("an update with a Scheduled Task: the agent is asked in the file, and the task is started once it has left", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const log = join(root, "log");
    const old = await oldAgent(configPath, log, "300", { WATCH: "1" });
    let started = 0;
    let oldAliveAtStart: boolean | undefined;
    let fresh: Spawned | undefined;
    const result = await restartFleetAgentAfterUpdate(
      configPath,
      {
        installed: () => false,
        pid: () => undefined,
        restart: () => false,
        task: () => true,
        startTask: () => {
          started++;
          oldAliveAtStart = alive(old.pid);
          fresh = startAgent(configPath, log, { PRIME_FLEET_LOCK_WAIT_MS: "0", ROUND_MS: "0" });
          return true;
        },
        stopWaitMs: 5000,
        spawnAgent: () => {
          throw new Error("no agent is started beside the task's");
        },
      },
      { platform: "win32" },
    );
    expect(started).toBe(1);
    expect(oldAliveAtStart).toBe(false);
    expect(said(log, old.pid)).toContain("stopfile");
    expect(said(log, old.pid)).not.toContain("sigterm");
    expect(result).toEqual({ restarted: true, via: "service", pid: fresh!.pid });
  }, 20_000);

  test("an update with a Scheduled Task: a round that does not finish in time is ended, and the task is started", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const log = join(root, "log");
    const old = await oldAgent(configPath, log, "0");
    let fresh: Spawned | undefined;
    const result = await restartFleetAgentAfterUpdate(
      configPath,
      {
        installed: () => false,
        pid: () => undefined,
        restart: () => false,
        task: () => true,
        startTask: () => {
          fresh = startAgent(configPath, log, { PRIME_FLEET_LOCK_WAIT_MS: "0", ROUND_MS: "0" });
          return true;
        },
        stopWaitMs: 700,
      },
      { platform: "win32" },
    );
    expect(alive(old.pid)).toBe(false);
    expect(result).toEqual({ restarted: true, via: "service", pid: fresh!.pid });
  }, 20_000);

  test("an update where Task Scheduler will not start the task says so, and does not start an agent of its own", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const log = join(root, "log");
    await oldAgent(configPath, log, "0", { WATCH: "1" });
    await expect(
      restartFleetAgentAfterUpdate(configPath, { installed: () => false, pid: () => undefined, restart: () => false, task: () => true, startTask: () => false, stopWaitMs: 3000 }, { platform: "win32" }),
    ).rejects.toThrow(/Task Scheduler would not start its task/);
  }, 20_000);

  test("an update with no task: the new build is started first, and the old agent is asked in the file, not signalled", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const log = join(root, "log");
    const old = await oldAgent(configPath, log, "400", { WATCH: "1" });
    let fresh: Spawned | undefined;
    let oldAliveWhenStarted: boolean | undefined;
    const result = await restartFleetAgentAfterUpdate(
      configPath,
      unsupervised(
        (env) => {
          oldAliveWhenStarted = alive(old.pid);
          return (fresh = startAgent(configPath, log, { ...env, WATCH: "1" }));
        },
        { stopWaitMs: 5000 },
      ),
      { platform: "win32", startCheckMs: 300, lockWaitMs: 20_000 },
    );
    expect(oldAliveWhenStarted).toBe(true);
    expect(said(log, old.pid)).toContain("stopfile");
    expect(said(log, old.pid)).not.toContain("sigterm");
    expect(result).toEqual({ restarted: true, via: "direct", pid: fresh!.pid });
    expect(maxHolders(log)).toBe(1);
    // The request is for the agents that were started before it: the new one runs.
    await Bun.sleep(400);
    expect(alive(fresh!.pid)).toBe(true);
  }, 20_000);
});

describe("stopping the agent from a command", () => {
  test("stopFleetAgent writes the request before it signals anything, and says it stopped a successor alone", () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const dir = fleetAgentDir(configPath);
    expect(stopFleetAgent(configPath)).toBe(false);
    expect(existsSync(stopPath(dir))).toBe(false);
    registerSuccessor(dir, 99_999_999);
    expect(stopFleetAgent(configPath)).toBe(false);
    expect(existsSync(stopPath(dir))).toBe(true);
    expect(existsSync(successorPath(dir))).toBe(false);
  });
});

describe("a request to stop that cannot be believed", () => {
  const heldLock = async () => ({ held: true as const, release: () => {} });

  test("one from the future (a clock that was stepped back) stops nobody, and is cleared", async () => {
    const dir = join(scratch(), "fleet-agent");
    requestStop(dir, Date.now() + 120_000);
    expect(stopRequestedSince(dir, Date.now())).toBe(false);
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await acquireStarting(dir, { waitMs: 0, startedAt: Date.now(), acquire: heldLock });
      outcomes.push("stopped" in r ? "stopped" : r.held ? "runs" : "other");
    }
    expect(outcomes).toEqual(["runs", "runs", "runs"]);
    expect(existsSync(stopPath(dir))).toBe(false);
  });

  test("one from an earlier boot is not applied either, and one a moment ahead of the clock still is", async () => {
    const dir = join(scratch(), "fleet-agent");
    mkdirSync(dir, { recursive: true });
    // Another boot: a different id, or (where the system has none) a longer uptime than there is now.
    if (currentBoot().id) {
      writeFileSync(stopPath(dir), JSON.stringify({ at: Date.now() + 1000, boot: "another boot", up: 5 }));
      expect(stopRequestedSince(dir, 0)).toBe(false);
    }
    writeFileSync(stopPath(dir), JSON.stringify({ at: Date.now() + 1000, up: 100 * 24 * 3600 }));
    expect(stopRequestedSince(dir, 0)).toBe(false);
    // The same boot, a second ahead (two clocks that are not the same): it is a stop.
    requestStop(dir, Date.now() + 1000);
    expect(stopRequestedSince(dir, 0)).toBe(true);
  });
});

describe("a successor entry that is no longer one", () => {
  const dirOf = (): string => join(scratch(), "a", "fleet-agent");

  test("is cleared when the successor gives up, so that its pid is not taken for a successor later", async () => {
    const dir = dirOf();
    registerSuccessor(dir, process.pid);
    const gaveUp = await acquireStarting(dir, { waitMs: 0, startedAt: Date.now(), acquire: async () => ({ held: false, holder: 4242 }) });
    expect(gaveUp.held).toBe(false);
    expect(existsSync(successorPath(dir))).toBe(false);
  });

  test("names a process only if it is an agent of THIS configuration", () => {
    const dir = dirOf();
    const live = process.pid;
    registerSuccessor(dir, live);
    const ours = "bun __fleet-agent --config " + join(dir, "..", "config.yaml");
    const theirs = "bun __fleet-agent --config " + join(dir, "..", "..", "b", "config.yaml");
    expect(isSuccessorProcess(dir, live, () => ours)).toBe(true);
    expect(isSuccessorProcess(dir, live, () => theirs)).toBe(false);
    expect(isSuccessorProcess(dir, live, () => "sleep 60")).toBe(false);
    // Where the process list cannot say, an entry that was touched lately does.
    expect(isSuccessorProcess(dir, live, () => undefined)).toBe(true);
    expect(isSuccessorProcess(dir, 99_999_999, () => ours)).toBe(false);
  });

  test("another configuration's agent is not signalled by a stop, and does not keep an update waiting", () => {
    const dir = dirOf();
    const killed: number[] = [];
    registerSuccessor(dir, process.pid);
    const theirs = (pid: number) => isSuccessorProcess(dir, pid, () => "bun __fleet-agent --config " + join(dir, "..", "..", "b", "config.yaml"));
    expect(stopSuccessor(dir, theirs, (pid) => void killed.push(pid))).toBeUndefined();
    expect(killed).toEqual([]);
    registerSuccessor(dir, process.pid);
    expect(claimSuccessor(dir, undefined, Date.now(), theirs).claimed).toBe(true);
  });

  test("a stale entry is removed without a stop request that would restart the agent that runs", () => {
    const dir = dirOf();
    registerSuccessor(dir, 99_999_999);
    expect(stopWaitingSuccessor(dir)).toBe(false);
    expect(existsSync(successorPath(dir))).toBe(false);
    expect(existsSync(stopPath(dir))).toBe(false);
  });
});

describe("a stop between the update's claim and its start", () => {
  test("is for the successor that is started after it", async () => {
    const dir = join(scratch(), "fleet-agent");
    const claim = claimSuccessor(dir, 1);
    expect(claim.claimed).toBe(true);
    const at = claim.claimed ? claim.at : 0;
    // `agent stop` now: the claim has no process to signal, and the request is what is left.
    await Bun.sleep(60);
    expect(stopWaitingSuccessor(dir)).toBe(false);
    expect(existsSync(stopPath(dir))).toBe(true);
    // The update starts it a moment later, on behalf of the claim.
    await Bun.sleep(60);
    registerSuccessor(dir, process.pid);
    const r = await acquireStarting(dir, { waitMs: 0, startedAt: Math.min(Date.now(), at - 100), acquire: async () => ({ held: true as const, release: () => {} }) });
    expect("stopped" in r && r.stopped).toBe(true);
  });
});

withProcesses("an update only signals what is still the agent it meant to stop", () => {
  test("a pid that is not the agent any more (it left, and another process has the number) is not signalled", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const log = join(root, "log");
    const old = await oldAgent(configPath, log, "never");
    let fresh: Spawned | undefined;
    await restartFleetAgentAfterUpdate(
      configPath,
      unsupervised((env) => (fresh = startAgent(configPath, log, env)), { stopWaitMs: 400 }),
      { platform: "linux", startCheckMs: 300, lockWaitMs: 20_000, isAgent: () => false },
    );
    await Bun.sleep(300);
    expect(said(log, old.pid)).not.toContain("sigterm");
    expect(alive(old.pid)).toBe(true);
    expect(alive(fresh!.pid)).toBe(true);
  }, 20_000);

  test("on Windows neither the wait nor the end of the old agent is about a pid that has left", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const log = join(root, "log");
    const old = await oldAgent(configPath, log, "never");
    let started = 0;
    const began = Date.now();
    await restartFleetAgentAfterUpdate(
      configPath,
      { installed: () => false, pid: () => undefined, restart: () => false, task: () => true, startTask: () => (started++, true), stopWaitMs: 600 },
      { platform: "win32", isAgent: () => false },
    ).catch(() => undefined);
    expect(started).toBe(1);
    expect(Date.now() - began).toBeLessThan(3000);
    expect(said(log, old.pid)).not.toContain("sigterm");
    expect(alive(old.pid)).toBe(true);
  }, 20_000);

  test("an update that finds a successor already there asks the old agent to stop again, in case the first update died before it did", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const log = join(root, "log");
    const old = await oldAgent(configPath, log, "5000");
    // The successor of an update that died: a process that is an agent to the process list, and an entry that was just touched.
    const waiting = Bun.spawn(["sh", "-c", "sleep 60", "__fleet-agent"], { stdout: "ignore", stderr: "ignore" });
    cleanups.push(() => waiting.kill("SIGKILL"));
    // Started for this agent, and past the time an update gives a new build to show it starts.
    registerSuccessor(fleetAgentDir(configPath), waiting.pid, Date.now() - 10_000, old.pid);
    let spawned = 0;
    const result = await restartFleetAgentAfterUpdate(
      configPath,
      unsupervised(() => (spawned++, waiting as unknown as StartedAgent)),
      { platform: "linux", startCheckMs: 100, isAgent: () => true },
    );
    expect(spawned).toBe(0);
    expect(result).toEqual({ restarted: true, via: "direct", pid: waiting.pid, pending: true });
    expect(await until(() => said(log, old.pid).includes("sigterm"))).toBe(true);
  }, 20_000);

  async function secondUpdate(entry: (dir: string, old: Spawned, waiting: Spawned) => void): Promise<{ result: unknown; old: Spawned; log: string; spawned: number }> {
    const root = scratch();
    const configPath = join(root, "config.json");
    const log = join(root, "log");
    const old = await oldAgent(configPath, log, "never");
    const waiting = Bun.spawn(["sh", "-c", "sleep 60", "__fleet-agent"], { stdout: "ignore", stderr: "ignore" });
    cleanups.push(() => waiting.kill("SIGKILL"));
    entry(fleetAgentDir(configPath), old, waiting as unknown as Spawned);
    let spawned = 0;
    const result = await restartFleetAgentAfterUpdate(
      configPath,
      unsupervised(() => (spawned++, waiting as unknown as StartedAgent)),
      { platform: "linux", startCheckMs: 1500, isAgent: () => true },
    );
    await Bun.sleep(300);
    return { result, old, log, spawned };
  }

  test("a claim that has no process yet is the other update's to finish: the running agent is left alone, and the update says so", async () => {
    const { result, old, log, spawned } = await secondUpdate((dir) => void claimSuccessor(dir, undefined));
    expect(spawned).toBe(0);
    expect(result).toEqual({ restarted: true, via: "direct", pending: true, inProgress: true });
    expect(said(log, old.pid)).not.toContain("sigterm");
    expect(alive(old.pid)).toBe(true);
  }, 20_000);

  test("a successor that is still inside the time it is given to show that it starts is left to the update that started it", async () => {
    const { result, old, log } = await secondUpdate((dir, o, w) => registerSuccessor(dir, w.pid, Date.now() - 200, o.pid));
    expect(result).toMatchObject({ restarted: true, pending: true, inProgress: true });
    expect(said(log, old.pid)).not.toContain("sigterm");
  }, 20_000);

  test("a successor that does not say whom it was started for does not have the agent stopped either", async () => {
    const { result, old, log } = await secondUpdate((dir, _o, w) => registerSuccessor(dir, w.pid, Date.now() - 10_000));
    expect(result).toMatchObject({ restarted: true, pending: true, inProgress: true });
    expect(said(log, old.pid)).not.toContain("sigterm");
  }, 30_000);

  test("the new agent is told when its claim was made, so that a stop from then on is for it", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const log = join(root, "log");
    await oldAgent(configPath, log, "never");
    const before = Date.now();
    const envs: Array<Record<string, string | undefined>> = [];
    await restartFleetAgentAfterUpdate(
      configPath,
      unsupervised((env) => {
        envs.push(env);
        return startAgent(configPath, log, env);
      }, { stopWaitMs: 300 }),
      { platform: "linux", startCheckMs: 100, lockWaitMs: 20_000 },
    );
    const since = Number(envs[0]!.PRIME_FLEET_SINCE);
    expect(since).toBeGreaterThanOrEqual(before);
    expect(since).toBeLessThanOrEqual(Date.now());
  }, 20_000);
});

describe("what `agent status` says of a successor", () => {
  test.skipIf(process.platform === "win32")("it names the process that waits to take over, while it does", () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    expect(fleetAgentStatus(configPath).successor).toBeUndefined();
    // A process that is an agent to the process list.
    const waiting = Bun.spawn(["sh", "-c", "sleep 60", "__fleet-agent"], { stdout: "ignore", stderr: "ignore" });
    cleanups.push(() => waiting.kill("SIGKILL"));
    registerSuccessor(fleetAgentDir(configPath), waiting.pid);
    expect(fleetAgentStatus(configPath)).toMatchObject({ running: false, successor: waiting.pid });
    stopSuccessor(fleetAgentDir(configPath), () => false);
    expect(fleetAgentStatus(configPath).successor).toBeUndefined();
  });
});

describe("a successor that is waiting for another agent than the one that runs", () => {
  test("does not stand in the way of a new claim, and one for the agent that runs still does", () => {
    const dir = join(scratch(), "a", "fleet-agent");
    registerSuccessor(dir, process.pid, Date.now(), 555);
    // The agent that runs now is 777, not the 555 it was started for.
    expect(claimSuccessor(dir, 777, Date.now(), () => true).claimed).toBe(true);
    registerSuccessor(dir, process.pid, Date.now(), 777);
    expect(claimSuccessor(dir, 777, Date.now(), () => true)).toEqual({ claimed: false, pid: process.pid });
    // An entry that does not say whom it replaces is taken as it always was.
    registerSuccessor(dir, process.pid, Date.now());
    expect(claimSuccessor(dir, 777, Date.now(), () => true).claimed).toBe(false);
  });
});

describe("what `prime update --json` says when another update is at the agent", () => {
  test("it does not say that this one restarted anything", () => {
    expect(agentRestartJson({ restarted: true, via: "direct", pending: true, inProgress: true })).toEqual({ agent_restart_in_progress: true });
    expect(agentRestartJson({ restarted: true, via: "direct", pending: true })).toEqual({ agent_restarted: "direct", agent_restart_pending: true });
    expect(agentRestartJson({ restarted: true, via: "service", pid: 4 })).toEqual({ agent_restarted: "service" });
    expect(agentRestartJson({ restarted: false, reason: "x" })).toEqual({});
    expect(agentRestartJson({ error: "no" })).toEqual({ agent_restart_error: "no" });
  });
});

withProcesses("what the agent starts after it has read the handover variables", () => {
  test("a container runtime it runs does not have them in its environment", async () => {
    const root = scratch();
    const out = join(root, "seen");
    const fake = join(root, "fake-runtime");
    writeFileSync(fake, `#!/bin/sh\necho "since=$PRIME_FLEET_SINCE replaces=$PRIME_FLEET_REPLACES wait=$PRIME_FLEET_LOCK_WAIT_MS" >> ${JSON.stringify(out)}\necho '[]'\n`, { mode: 0o755 });
    const script = `import { takeHandoverEnv } from ${HANDOVER}; import { spaceContainerRunning } from ${JSON.stringify(join(import.meta.dir, "../src/spaces.ts"))};
      takeHandoverEnv(process.env, Date.now());
      spaceContainerRunning({ kind: "docker", bin: ${JSON.stringify(fake)} }, { container: "c" });`;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, PRIME_FLEET_SINCE: String(Date.now() - 1000), PRIME_FLEET_REPLACES: "321", PRIME_FLEET_LOCK_WAIT_MS: "900000" },
      stdout: "ignore",
      stderr: "ignore",
      timeout: 20_000,
      killSignal: "SIGKILL",
    });
    expect(await child.exited).toBe(0);
    expect(readFileSync(out, "utf8").trim().split("\n")).toEqual(["since= replaces= wait="]);
  }, 30_000);
});

describe("when an update asks the agent again", () => {
  const dir = (): string => join(scratch(), "a", "fleet-agent");
  const alive3 = () => true;

  test("only for a registered successor of that agent that is past its start check", () => {
    const d = dir();
    const now = 1_000_000;
    expect(mayAskAgainToStop(d, 7, 1500, now, alive3)).toBe(false); // no entry
    claimSuccessor(d, undefined, now - 9000);
    expect(mayAskAgainToStop(d, 7, 1500, now, alive3)).toBe(false); // a claim
    registerSuccessor(d, 55, now - 1000, 7);
    expect(mayAskAgainToStop(d, 7, 1500, now, alive3)).toBe(false); // too young
    expect(mayAskAgainToStop(d, 7, 1500, now + 1000, alive3)).toBe(true);
    expect(mayAskAgainToStop(d, 8, 1500, now + 1000, alive3)).toBe(false); // for another agent
    expect(mayAskAgainToStop(d, 7, 1500, now + 1000, () => false)).toBe(false); // gone
    registerSuccessor(d, 55, now - 10_000);
    expect(mayAskAgainToStop(d, 7, 1500, now, alive3)).toBe(false); // not told whom it replaces
  });
});

describe("a successor whose agent has left", () => {
  const dirOf = (): string => join(scratch(), "a", "fleet-agent");

  test("waits on for what is left of its time while a stranger holds the lock, and takes it if it is free in a later turn", async () => {
    const dir = dirOf();
    registerSuccessor(dir, process.pid, Date.now(), 555);
    let calls = 0;
    const r = await acquireStarting(dir, {
      waitMs: 60_000,
      turnMs: 20,
      startedAt: Date.now(),
      replaces: 555,
      isAgent: () => false,
      // A short-lived agent that someone started has the lock for two turns; then it is free.
      acquire: async () => (await Bun.sleep(5), ++calls <= 2 ? { held: false as const, holder: 777 } : { held: true as const, release: () => {} }),
    });
    expect(r.held).toBe(true);
    expect(calls).toBe(3);
  });

  test("gives up, and clears its entry, when its time is out", async () => {
    const dir = dirOf();
    registerSuccessor(dir, process.pid, Date.now(), 555);
    const began = Date.now();
    const r = await acquireStarting(dir, {
      waitMs: 120,
      turnMs: 20,
      startedAt: Date.now(),
      replaces: 555,
      isAgent: () => false,
      acquire: async () => (await Bun.sleep(5), { held: false as const, holder: 777 }),
    });
    expect(r.held).toBe(false);
    expect(Date.now() - began).toBeGreaterThanOrEqual(100);
    expect(existsSync(successorPath(dir))).toBe(false);
  });

  test("leaves when an update has put another successor in its place", async () => {
    const dir = dirOf();
    registerSuccessor(dir, process.pid, Date.now(), 555);
    let calls = 0;
    const r = await acquireStarting(dir, {
      waitMs: 60_000,
      turnMs: 20,
      startedAt: Date.now(),
      replaces: 555,
      isAgent: () => false,
      acquire: async () => {
        await Bun.sleep(5);
        if (++calls === 2) registerSuccessor(dir, 4_000_000, Date.now(), 777);
        return { held: false as const, holder: 777 };
      },
    });
    expect(r.held).toBe(false);
    expect(calls).toBe(2);
    // The entry is the other successor's now, and is left to it.
    expect(readSuccessor(dir)?.pid).toBe(4_000_000);
  });

  test("takes the lock when the agent it waited for has gone, in the turn after, and not at the end of its wait", async () => {
    const dir = dirOf();
    let calls = 0;
    const waits: number[] = [];
    let agentIsThere = true;
    const r = await acquireStarting(dir, {
      waitMs: 60_000,
      turnMs: 40,
      startedAt: Date.now(),
      replaces: 555,
      isAgent: () => agentIsThere,
      acquire: async (_d, o) => {
        waits.push(o?.waitMs ?? -1);
        calls++;
        if (calls === 3) agentIsThere = false;
        return calls < 4 ? { held: false as const, holder: 555 } : { held: true as const, release: () => {} };
      },
    });
    expect(r.held).toBe(true);
    expect(waits.every((w) => w <= 40)).toBe(true);
    expect(calls).toBe(4);
  });

  test("keeps waiting for the agent while it is at its round, past its first wait", async () => {
    const dir = dirOf();
    let calls = 0;
    let waited = 0;
    const r = await acquireStarting(dir, {
      waitMs: 30,
      turnMs: 10,
      startedAt: Date.now(),
      replaces: 555,
      isAgent: () => true,
      onWait: () => void waited++,
      acquire: async () => {
        await Bun.sleep(10);
        return ++calls < 12 ? { held: false as const, holder: 555 } : { held: true as const, release: () => {} };
      },
    });
    expect(r.held).toBe(true);
    expect(waited).toBeGreaterThanOrEqual(1);
  });
});

describe("what an update hands the agent it starts", () => {
  test("a claim time within a minute before the start is believed; one from further back, or from after it, is not", () => {
    const start = 10_000_000;
    expect(takeHandoverEnv({ PRIME_FLEET_SINCE: String(start - 2000) }, start).since).toBe(start - 2000);
    expect(takeHandoverEnv({ PRIME_FLEET_SINCE: String(start - 59_000) }, start).since).toBe(start - 59_000);
    expect(takeHandoverEnv({ PRIME_FLEET_SINCE: String(start - 61_000) }, start).since).toBeUndefined();
    expect(takeHandoverEnv({ PRIME_FLEET_SINCE: String(start + 5000) }, start).since).toBeUndefined();
    expect(takeHandoverEnv({ PRIME_FLEET_SINCE: "x" }, start).since).toBeUndefined();
    expect(takeHandoverEnv({}, start)).toEqual({});
  });

  test("the variables are read once and removed, so that what the agent starts does not inherit them", () => {
    const env: Record<string, string | undefined> = {
      PRIME_FLEET_SINCE: String(5_000_000 - 100),
      PRIME_FLEET_REPLACES: "321",
      PRIME_FLEET_LOCK_WAIT_MS: "900000",
      PATH: "/bin",
    };
    expect(takeHandoverEnv(env, 5_000_000)).toEqual({ since: 5_000_000 - 100, replaces: 321, lockWaitMs: 900_000 });
    expect(env).toEqual({ PATH: "/bin" });
  });
});

withProcesses("setting the service up while the agent it starts waits for the lock", () => {
  /** An agent that a hand started and still holds the lock, and the one the service has started, which waits behind it. */
  async function serviceBehindOldAgent(): Promise<{ configPath: string; log: string; old: Spawned; service: Spawned }> {
    const root = scratch();
    const configPath = join(root, "config.json");
    const log = join(root, "log");
    const old = await oldAgent(configPath, log, "300");
    const service = startAgent(configPath, log, { PRIME_FLEET_LOCK_WAIT_MS: "20000" });
    expect(await until(() => said(log, service.pid).includes("waiting"))).toBe(true);
    // A request made in the first moments of an agent's life is for the agent before it (see SLACK_MS).
    await Bun.sleep(200);
    return { configPath, log, old, service };
  }

  test("`agent install` stops the agent in the way, and the service's agent that takes the lock after it runs", async () => {
    const { configPath, log, old, service } = await serviceBehindOldAgent();
    await installFleetAgent(configPath, { install: () => "unit", boundTo: () => undefined, servicePid: () => service.pid, stopWaitMs: 5000 });
    expect(await until(() => said(log, service.pid).includes("took"))).toBe(true);
    await Bun.sleep(1500);
    expect(said(log, service.pid)).not.toContain("stopped");
    expect(alive(service.pid)).toBe(true);
    expect(alive(old.pid)).toBe(false);
  }, 30_000);

  test("a command that changes the agent's settings does the same", async () => {
    const { configPath, log, service } = await serviceBehindOldAgent();
    const state = await ensureFleetAgent(configPath, {}, { installed: () => true, pid: () => service.pid, restart: () => true, stopWaitMs: 5000 });
    expect(state.pid).toBe(service.pid);
    await Bun.sleep(1500);
    expect(said(log, service.pid)).not.toContain("stopped");
    expect(alive(service.pid)).toBe(true);
  }, 30_000);

  test("`agent stop` still stops every agent that was started before it, the service's included", async () => {
    const { configPath, log, old, service } = await serviceBehindOldAgent();
    stopFleetAgent(configPath);
    expect(await until(() => !alive(old.pid))).toBe(true);
    expect(await until(() => said(log, service.pid).includes("stopped"))).toBe(true);
    expect(said(log, service.pid)).not.toContain("took");
  }, 30_000);
});

describe("a request to stop that is for one agent", () => {
  test("a successor that is stopped by name is the only one that the request is for", () => {
    const dir = join(scratch(), "a", "fleet-agent");
    registerSuccessor(dir, process.pid);
    expect(stopWaitingSuccessor(dir, Date.now(), () => true, () => {})).toBe(true);
    expect(stopRequestedSince(dir, Date.now() - 1000, process.pid)).toBe(true);
    // An agent that the service started meanwhile is not the successor.
    expect(stopRequestedSince(dir, Date.now() - 1000, process.pid + 1)).toBe(false);
  });
});

describe("what the agent writes to its log", () => {
  test("it says that it started, that it holds the lock, what asked it to stop, and that it left", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const dir = fleetAgentDir(configPath);
    const script = `import { runFleetAgent } from ${JSON.stringify(join(import.meta.dir, "../src/fleet-daemon.ts"))}; await runFleetAgent(${JSON.stringify(configPath)}, { lockWaitMs: 0 });`;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, PRIME_FLEET_REPLACES: "", PRIME_FLEET_POLL_MS: "50" },
      stdout: "ignore",
      stderr: "pipe",
      timeout: 40_000,
      killSignal: "SIGKILL",
    });
    cleanups.push(() => child.kill("SIGKILL"));
    expect(await until(() => existsSync(fleetAgentStatePath(configPath)), 20_000)).toBe(true);
    await Bun.sleep(150);
    requestStop(dir);
    expect(await child.exited).toBe(0);
    const log = await new Response(child.stderr).text();
    const lines = log.trim().split("\n");
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z fleet agent \(pid \d+\): starting/);
    expect(log).toContain("holds the lock");
    expect(log).toContain("asked to stop (a request to stop in the agent's directory)");
    expect(lines.at(-1)).toContain("leaving: stopped");
  }, 60_000);
});
