import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireAgentLock, agentLockPath, isFleetAgentProcess } from "../src/fleet-agent-lock";
import { agentSettingsPath, ensureFleetAgent, fleetAgentDir, fleetAgentStatePath, readAgentSettings, runFleetAgent } from "../src/fleet-daemon";

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
async function fakeAgent(ignoreTerm = false): Promise<{ pid: number }> {
  if (!ignoreTerm) {
    const child = Bun.spawn(["sh", "-c", "sleep 60", "__fleet-agent"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    cleanups.push(() => child.kill("SIGKILL"));
    return { pid: child.pid };
  }
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
    expect((await acquireAgentLock(dir)).held).toBe(true);
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
  }
  const hooks = (restarts: { n: number }, configPath: string, replica: "lazy" | "mirror", cacheMb = 512) => ({
    installed: () => true,
    restart: () => {
      restarts.n++;
      running(configPath, process.pid, replica, cacheMb);
      return true;
    },
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
      restart: () => {
        restarts++;
        // The manager has started the agent again: it is another process (this one stands in for it).
        running(configPath, process.pid, "mirror");
        return true;
      },
    });
    expect(restarts).toBe(1);
    expect(state.pid).toBe(process.pid);
    expect(state.replica).toBe("mirror");
    // The old agent was left to the manager: nothing here signalled it.
    expect(isFleetAgentProcess(old.pid)).toBe(true);
  });

  test("without a service the old agent is stopped, and a new one is never spawned while it is alive", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const stubborn = await fakeAgent(true);
    running(configPath, stubborn.pid, "lazy");
    withMode("mirror");
    let error: unknown;
    try {
      await ensureFleetAgent(configPath, { fromShell: true }, { installed: () => false, restart: () => false, stopWaitMs: 400 });
    } catch (err) {
      error = err;
    }
    expect(String(error)).toContain("has not stopped yet");
    // Nobody else was started: the state still is the old agent's.
    expect(existsSync(fleetAgentStatePath(configPath))).toBe(false);
    expect(isFleetAgentProcess(stubborn.pid)).toBe(true);
  });

  test("a new cache size restarts it too, not only a new mode", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const old = await fakeAgent();
    running(configPath, old.pid, "lazy", 512);
    withEnv("PRIME_FLEET_CACHE_MB", "64");
    const restarts = { n: 0 };
    const state = await ensureFleetAgent(configPath, { fromShell: true }, hooks(restarts, configPath, "lazy", 64));
    expect(restarts.n).toBe(1);
    expect(state.settings?.cacheMb).toBe(64);
    expect(readAgentSettings(configPath)).toEqual({ cacheMb: 64 });
    // The same again changes nothing.
    await ensureFleetAgent(configPath, { fromShell: true }, hooks(restarts, configPath, "lazy", 64));
    expect(restarts.n).toBe(1);
  });

  test("a command that only needs an agent (creating a space) neither saves the shell's settings nor restarts for them", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const old = await fakeAgent();
    running(configPath, old.pid, "lazy");
    withMode("mirror");
    const restarts = { n: 0 };
    const state = await ensureFleetAgent(configPath, {}, hooks(restarts, configPath, "mirror"));
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
    const state = await ensureFleetAgent(configPath, { fromShell: true }, hooks(restarts, configPath, "lazy"));
    expect(restarts.n).toBe(1);
    expect(state.replica).toBe("lazy");
    expect(existsSync(agentSettingsPath(configPath))).toBe(false);
  });
});
