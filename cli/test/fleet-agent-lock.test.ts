import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireAgentLock, agentLockPath, isFleetAgentProcess } from "../src/fleet-agent-lock";
import {
  agentSettingsPath,
  ensureFleetAgent,
  fleetAgentDir,
  fleetAgentStatePath,
  fleetAgentStatus,
  installFleetAgent,
  readAgentSettings,
  runFleetAgent,
  stopFleetAgent,
} from "../src/fleet-daemon";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-lock-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A process that looks like a fleet agent to the process list (and does nothing). */
function plainAgent(): { pid: number } {
  const child = Bun.spawn(["sh", "-c", "sleep 60", "__fleet-agent"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  cleanups.push(() => child.kill("SIGKILL"));
  return { pid: child.pid };
}

async function fakeAgent(ignoreTerm = false): Promise<{ pid: number }> {
  if (!ignoreTerm) return plainAgent();
  // One that does not stop when asked to: it says so when it is set up to ignore the signal.
  const child = Bun.spawn(
    ["python3", "-c", "import signal, sys, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('ready', flush=True); time.sleep(60)", "__fleet-agent"],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  );
  cleanups.push(() => child.kill("SIGKILL"));
  await child.stdout.getReader().read();
  return { pid: child.pid };
}

describe("one fleet agent per configuration", () => {
  test("the first takes the lock and lets it go; the file says who holds it", async () => {
    const dir = scratch();
    const lock = await acquireAgentLock(dir);
    expect(lock.held).toBe(true);
    expect(readFileSync(agentLockPath(dir), "utf8").trim()).toBe(String(process.pid));
    if (lock.held) lock.release();
    expect(existsSync(agentLockPath(dir))).toBe(false);
  });

  test("a live agent keeps it: a second is refused, naming the holder", async () => {
    const dir = scratch();
    const agent = await fakeAgent();
    writeFileSync(agentLockPath(dir), String(agent.pid) + "\n");
    const started = Date.now();
    const lock = await acquireAgentLock(dir, { waitMs: 300 });
    expect(lock).toEqual({ held: false, holder: agent.pid });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    // The holder's lock is untouched.
    expect(readFileSync(agentLockPath(dir), "utf8").trim()).toBe(String(agent.pid));
  });

  test("an agent that is stopping is waited for, and its lock then taken", async () => {
    const dir = scratch();
    const agent = await fakeAgent();
    writeFileSync(agentLockPath(dir), String(agent.pid) + "\n");
    setTimeout(() => rmSync(agentLockPath(dir), { force: true }), 200);
    const lock = await acquireAgentLock(dir, { waitMs: 5000 });
    expect(lock.held).toBe(true);
  });

  test("a lock whose holder is gone, or is not an agent at all (a reused pid), is taken over", async () => {
    const dir = scratch();
    writeFileSync(agentLockPath(dir), "999999\n");
    expect((await acquireAgentLock(dir)).held).toBe(true);
    rmSync(agentLockPath(dir));
    // A live process that is not an agent, in a lock nobody has written for a day (a reboot ago).
    writeFileSync(agentLockPath(dir), String(process.pid) + "\n");
    const old = new Date(Date.now() - 86_400_000);
    utimesSync(agentLockPath(dir), old, old);
    expect(isFleetAgentProcess(process.pid, dir)).toBe(false);
    const other = await acquireAgentLock(dir, { pid: process.pid + 1 });
    expect(other.held).toBe(true);
    expect(readFileSync(agentLockPath(dir), "utf8").trim()).toBe(String(process.pid + 1));
    writeFileSync(agentLockPath(dir), "not a pid");
    utimesSync(agentLockPath(dir), old, old);
    expect((await acquireAgentLock(dir)).held).toBe(true);
  });

  test("two agents that start at the same moment do not both hold it: the lock appears with the pid in it", async () => {
    const dir = scratch();
    let second: Awaited<ReturnType<typeof acquireAgentLock>> | undefined;
    // Agent A has written its pid and is about to put the lock in place; agent B (pid 2222) starts right then.
    const a = await acquireAgentLock(dir, {
      pid: 1111,
      isAgent: () => true,
      beforeLink: async () => {
        if (!second) second = await acquireAgentLock(dir, { pid: 2222, isAgent: () => true });
      },
    });
    expect(second?.held).toBe(true);
    expect(a).toEqual({ held: false, holder: 2222 });
    expect(readFileSync(agentLockPath(dir), "utf8").trim()).toBe("2222");
    if (second?.held) second.release();
    // No file of the attempts is left behind.
    expect(readdirSync(dir).filter((n) => n.startsWith("agent.lock"))).toEqual([]);
  });

  test("a lock that is empty and only just made (an older build's, being written) is waited for, an old empty one is not", async () => {
    const dir = scratch();
    writeFileSync(agentLockPath(dir), "");
    expect(await acquireAgentLock(dir, { waitMs: 250 })).toEqual({ held: false, holder: 0 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(agentLockPath(dir), old, old);
    expect((await acquireAgentLock(dir)).held).toBe(true);
  });

  test("a process list that gives no answer is not an answer: a live pid with a fresh lock is an agent, with an old one it is not", () => {
    const dir = scratch();
    const lock = agentLockPath(dir);
    writeFileSync(lock, process.pid + "\n");
    // A `ps` that exited 2 (busybox, no -p), one that was refused, one that printed nothing.
    for (const probe of [() => ({ status: 2, stdout: "" }), () => ({ status: 127, stdout: "usage" }), () => null, () => ({ status: 0, stdout: "" })]) {
      expect(isFleetAgentProcess(process.pid, dir, probe)).toBe(true);
    }
    const old = new Date(Date.now() - 31_000);
    utimesSync(lock, old, old);
    expect(isFleetAgentProcess(process.pid, dir, () => ({ status: 2, stdout: "" }))).toBe(false);
    // What it does say is believed, whatever the lock's age: "no such process" and "something else", or "an agent".
    writeFileSync(lock, process.pid + "\n");
    expect(isFleetAgentProcess(process.pid, dir, () => ({ status: 1, stdout: "" }))).toBe(false);
    expect(isFleetAgentProcess(process.pid, dir, () => ({ status: 0, stdout: "vim notes.md\n" }))).toBe(false);
    utimesSync(lock, old, old);
    expect(isFleetAgentProcess(process.pid, dir, () => ({ status: 0, stdout: "bun cli.ts __fleet-agent --config x\n" }))).toBe(true);
  });

  test("a holder keeps its lock fresh while it lives, whatever else it writes: a stopping agent is not mistaken for a dead one", async () => {
    const dir = scratch();
    const lock = await acquireAgentLock(dir, { touchMs: 40 });
    expect(lock.held).toBe(true);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(agentLockPath(dir), old, old);
    await new Promise((r) => setTimeout(r, 200));
    expect(Date.now() - statSync(agentLockPath(dir)).mtimeMs).toBeLessThan(5_000);
    expect(isFleetAgentProcess(process.pid, dir, () => null)).toBe(true);
    if (lock.held) lock.release();
    expect(existsSync(agentLockPath(dir))).toBe(false);
  });

  test("a second agent for the same configuration exits without touching the first's files", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const agent = await fakeAgent();
    mkdirp(fleetAgentDir(configPath));
    writeFileSync(agentLockPath(fleetAgentDir(configPath)), String(agent.pid) + "\n");
    writeFileSync(fleetAgentStatePath(configPath), JSON.stringify({ pid: agent.pid, started_at: "x", config_path: configPath }));
    const was = process.exitCode;
    cleanups.push(() => {
      process.exitCode = was;
    });
    await runFleetAgent(configPath, { lockWaitMs: 100 });
    expect(process.exitCode).toBe(1);
    expect(readFileSync(fleetAgentStatePath(configPath), "utf8")).toContain(String(agent.pid));
    expect(readFileSync(agentLockPath(fleetAgentDir(configPath)), "utf8").trim()).toBe(String(agent.pid));
  });
});

function mkdirp(dir: string): void {
  require("node:fs").mkdirSync(dir, { recursive: true });
}

describe("switching the replica mode of a running agent", () => {
  function withEnv(name: string, value: string): void {
    const was = process.env[name];
    process.env[name] = value;
    cleanups.push(() => {
      if (was === undefined) delete process.env[name];
      else process.env[name] = was;
    });
  }
  const withMode = (mode: string): void => withEnv("PRIME_FLEET_REPLICA", mode);
  function running(configPath: string, pid: number, replica: "lazy" | "mirror", cacheMb = 512): void {
    mkdirp(fleetAgentDir(configPath));
    const settings = { replica, cacheMb, pollMs: 1500, heartbeatMs: 15000 };
    writeFileSync(fleetAgentStatePath(configPath), JSON.stringify({ pid, started_at: "x", config_path: configPath, replica, settings }));
    // An agent holds its lock (where the process list cannot be asked, that is what says it is one).
    writeFileSync(agentLockPath(fleetAgentDir(configPath)), pid + "\n");
  }
  /** A service whose manager runs `servicePid` and, when asked to restart it, starts another agent. */
  const hooks = (restarts: { n: number }, configPath: string, replica: "lazy" | "mirror", cacheMb = 512, servicePid?: number) => ({
    installed: () => true,
    pid: () => servicePid,
    restart: () => {
      restarts.n++;
      running(configPath, plainAgent().pid, replica, cacheMb);
      return true;
    },
    stopWaitMs: 3000,
  });

  test("an agent the service runs is restarted by the service, and nothing else is spawned", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const old = await fakeAgent();
    running(configPath, old.pid, "lazy");
    withMode("mirror");
    let restarts = 0;
    const state = await ensureFleetAgent(configPath, { fromShell: true }, {
      installed: () => true,
      pid: () => old.pid,
      restart: () => {
        restarts++;
        // The manager has started the agent again: it is another process.
        running(configPath, plainAgent().pid, "mirror");
        return true;
      },
    });
    expect(restarts).toBe(1);
    expect(state.pid).not.toBe(old.pid);
    expect(state.replica).toBe("mirror");
    // The old agent was left to the manager: nothing here signalled it.
    expect(isFleetAgentProcess(old.pid, fleetAgentDir(configPath))).toBe(true);
  });

  test("without a service the old agent is stopped, and a new one is never spawned while it is alive", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const stubborn = await fakeAgent(true);
    running(configPath, stubborn.pid, "lazy");
    withMode("mirror");
    let error: unknown;
    try {
      await ensureFleetAgent(configPath, { fromShell: true }, { installed: () => false, pid: () => undefined, restart: () => false, stopWaitMs: 400 });
    } catch (err) {
      error = err;
    }
    expect(String(error)).toContain("has not stopped yet");
    // Nobody else was started: the state still is the old agent's.
    expect(existsSync(fleetAgentStatePath(configPath))).toBe(false);
    expect(isFleetAgentProcess(stubborn.pid, fleetAgentDir(configPath))).toBe(true);
  });

  test("a new cache size restarts it too, not only a new mode", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const old = await fakeAgent();
    running(configPath, old.pid, "lazy", 512);
    withEnv("PRIME_FLEET_CACHE_MB", "64");
    const restarts = { n: 0 };
    const state = await ensureFleetAgent(configPath, { fromShell: true }, hooks(restarts, configPath, "lazy", 64, old.pid));
    expect(restarts.n).toBe(1);
    expect(state.settings?.cacheMb).toBe(64);
    expect(readAgentSettings(configPath)).toEqual({ cacheMb: 64 });
    // The same again changes nothing.
    await ensureFleetAgent(configPath, { fromShell: true }, hooks(restarts, configPath, "lazy", 64, state.pid));
    expect(restarts.n).toBe(1);
  });

  test("a command that only needs an agent (creating a space) neither saves the shell's settings nor restarts for them", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const old = await fakeAgent();
    running(configPath, old.pid, "lazy");
    withMode("mirror");
    const restarts = { n: 0 };
    const state = await ensureFleetAgent(configPath, {}, hooks(restarts, configPath, "mirror", 512, old.pid));
    expect(restarts.n).toBe(0);
    expect(state.pid).toBe(old.pid);
    expect(existsSync(agentSettingsPath(configPath))).toBe(false);
  });

  test("an empty variable at `agent start` takes a saved mode away, and the running agent goes back to the default", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const old = await fakeAgent();
    mkdirp(fleetAgentDir(configPath));
    writeFileSync(agentSettingsPath(configPath), JSON.stringify({ replica: "mirror" }));
    running(configPath, old.pid, "mirror");
    withMode("");
    const restarts = { n: 0 };
    const state = await ensureFleetAgent(configPath, { fromShell: true }, hooks(restarts, configPath, "lazy", 512, old.pid));
    expect(restarts.n).toBe(1);
    expect(state.replica).toBe("lazy");
    expect(existsSync(agentSettingsPath(configPath))).toBe(false);
  });

  test("an agent that is not the service's is stopped, not left beside it: the service starts its own", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    // Started by hand (or by `spaces create`, or by an older build with no lock), then the service was installed.
    const detached = await fakeAgent();
    running(configPath, detached.pid, "lazy");
    const restarts = { n: 0 };
    let detachedAtRestart: boolean | undefined;
    const base = hooks(restarts, configPath, "lazy", 512, undefined);
    const state = await ensureFleetAgent(configPath, {}, {
      ...base,
      restart: () => {
        detachedAtRestart = isFleetAgentProcess(detached.pid, fleetAgentDir(configPath));
        return base.restart();
      },
    });
    expect(restarts.n).toBe(1);
    // By the time the manager started its agent, the one beside it was gone.
    expect(detachedAtRestart).toBe(false);
    expect(state.pid).not.toBe(detached.pid);
  });

  test("with a service installed and no agent running, the service starts it: nothing is spawned beside it", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const restarts = { n: 0 };
    const state = await ensureFleetAgent(configPath, {}, hooks(restarts, configPath, "lazy"));
    expect(restarts.n).toBe(1);
    expect(isFleetAgentProcess(state.pid, fleetAgentDir(configPath))).toBe(true);
    // And a manager that will not is an error, not a reason to start one by hand.
    const other = join(scratch(), "config.json");
    let error: unknown;
    try {
      await ensureFleetAgent(other, {}, { installed: () => true, pid: () => undefined, restart: () => false, stopWaitMs: 300 });
    } catch (err) {
      error = err;
    }
    expect(String(error)).toContain("would not start it");
    expect(existsSync(fleetAgentStatePath(other))).toBe(false);
  });

  test("installing the service stops a running agent first, and waits for it", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const old = await fakeAgent();
    running(configPath, old.pid, "lazy");
    withMode("mirror");
    let aliveAtInstall: boolean | undefined;
    const where = await installFleetAgent(configPath, {
      stopWaitMs: 3000,
      install: () => {
        aliveAtInstall = isFleetAgentProcess(old.pid, fleetAgentDir(configPath));
        return "the unit";
      },
    });
    expect(where).toBe("the unit");
    expect(aliveAtInstall).toBe(false);
    // What was set here is saved for the service.
    expect(readAgentSettings(configPath)).toEqual({ replica: "mirror" });
    // One that will not stop is an error, and the service is not installed over it.
    const stubborn = await fakeAgent(true);
    const other = join(scratch(), "config.json");
    running(other, stubborn.pid, "lazy");
    let installed = false;
    let error: unknown;
    try {
      await installFleetAgent(other, { stopWaitMs: 300, install: () => ((installed = true), "x") });
    } catch (err) {
      error = err;
    }
    expect(String(error)).toContain("has not stopped yet");
    expect(installed).toBe(false);
  });

  test("a pid left in the state by an agent that is gone is not signalled, and is not a running agent", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    // Some other process now has the pid the dead agent had.
    const other = Bun.spawn(["sh", "-c", "sleep 60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    cleanups.push(() => other.kill("SIGKILL"));
    mkdirp(fleetAgentDir(configPath));
    writeFileSync(fleetAgentStatePath(configPath), JSON.stringify({ pid: other.pid, started_at: "x", config_path: configPath }));
    expect(fleetAgentStatus(configPath).running).toBe(false);
    expect(stopFleetAgent(configPath)).toBe(false);
    await Bun.sleep(100);
    expect(other.killed).toBe(false);
    expect(other.exitCode).toBeNull();
    expect(existsSync(fleetAgentStatePath(configPath))).toBe(false);
  });
});
