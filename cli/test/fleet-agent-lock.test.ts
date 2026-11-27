import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { acquireAgentLock, agentLockPath, isFleetAgentProcess, procProbeWith } from "../src/fleet-agent-lock";
import { bindServiceStatus, fleetAgentServiceStatus } from "../src/fleet-service";
import { launchdAnswered } from "../src/service";
import {
  SettingsPendingError,
  agentCommand,
  agentServiceFor,
  agentSettingsPath,
  ensureFleetAgent,
  fleetAgentDir,
  fleetAgentStatePath,
  fleetAgentStatus,
  installFleetAgent,
  ownsAgentState,
  readAgentSettings,
  runFleetAgent,
  stopFleetAgent,
  managerHolds,
  stopFleetAgentManaged,
  uninstallFleetAgent,
  writeAgentState,
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

  test("two agents that find the same dead lock do not both take it: the one that was too slow puts the other's lock back", async () => {
    const dir = scratch();
    writeFileSync(agentLockPath(dir), "999999\n");
    const alive = (pid: number) => pid !== 999999;
    let a: Awaited<ReturnType<typeof acquireAgentLock>> | undefined;
    let once = false;
    // B has judged the lock dead and is about to take it away; A, which saw the same lock, has just done so.
    const b = await acquireAgentLock(dir, {
      pid: 2222,
      isAgent: alive,
      beforeTakeover: async () => {
        if (once) return;
        once = true;
        a = await acquireAgentLock(dir, { pid: 1111, isAgent: alive });
      },
    });
    expect(a?.held).toBe(true);
    expect(b).toEqual({ held: false, holder: 1111 });
    expect(readFileSync(agentLockPath(dir), "utf8").trim()).toBe("1111");
    expect(readdirSync(dir).filter((n) => n !== "agent.lock")).toEqual([]);
    if (a?.held) a.release();
  });

  test("a holder whose lock names another agent stops: two holders last one touch, not for ever", async () => {
    const dir = scratch();
    let lost = 0;
    const a = await acquireAgentLock(dir, { pid: 1111, isAgent: () => true, touchMs: 30, onLost: () => void lost++ });
    expect(a.held).toBe(true);
    // A third starter links its own into the gap a slow taker left.
    writeFileSync(agentLockPath(dir), "3333\n");
    await new Promise((r) => setTimeout(r, 200));
    expect(lost).toBe(1);
    // And it only says so once.
    await new Promise((r) => setTimeout(r, 100));
    expect(lost).toBe(1);
    if (a.held) a.release();
    // Its lock is not removed from under the one that holds it.
    expect(readFileSync(agentLockPath(dir), "utf8").trim()).toBe("3333");
  });

  test("a lock that is gone for a moment (a takeover putting a live one back) is not a loss, one that stays gone is", async () => {
    const dir = scratch();
    let lost = 0;
    const a = await acquireAgentLock(dir, { pid: 1111, isAgent: () => true, touchMs: 40, onLost: () => void lost++ });
    const file = agentLockPath(dir);
    rmSync(file);
    await new Promise((r) => setTimeout(r, 55));
    writeFileSync(file, "1111\n");
    await new Promise((r) => setTimeout(r, 150));
    expect(lost).toBe(0);
    rmSync(file);
    await new Promise((r) => setTimeout(r, 200));
    expect(lost).toBe(1);
    if (a.held) a.release();
  });

  test("where there are no hard links a live lock moved aside by a slow taker is written back, not deleted", async () => {
    const dir = scratch();
    writeFileSync(agentLockPath(dir), "999999\n");
    const alive = (pid: number) => pid !== 999999;
    const noLinks = (): void => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    };
    let a: Awaited<ReturnType<typeof acquireAgentLock>> | undefined;
    let once = false;
    const b = await acquireAgentLock(dir, {
      pid: 2222,
      isAgent: alive,
      link: noLinks,
      beforeTakeover: async () => {
        if (once) return;
        once = true;
        a = await acquireAgentLock(dir, { pid: 1111, isAgent: alive, link: noLinks });
      },
    });
    expect(a?.held).toBe(true);
    expect(b).toEqual({ held: false, holder: 1111 });
    expect(readFileSync(agentLockPath(dir), "utf8").trim()).toBe("1111");
    if (a?.held) a.release();
  });

  test("the leftovers of attempts that were cut short are swept once they are old, not while they might be in use", async () => {
    const dir = scratch();
    const old = new Date(Date.now() - 3_600_000);
    for (const name of ["agent.lock.123.abcd1234.tmp", "agent.lock.stale.deadbeef"]) {
      writeFileSync(join(dir, name), "x");
      utimesSync(join(dir, name), old, old);
    }
    writeFileSync(join(dir, "agent.lock.456.ffff0000.tmp"), "x");
    const lock = await acquireAgentLock(dir);
    expect(readdirSync(dir).sort()).toEqual(["agent.lock", "agent.lock.456.ffff0000.tmp"]);
    if (lock.held) lock.release();
  });

  test("where the file system has no hard links the lock is still taken exactly once, with its pid in it", async () => {
    const dir = scratch();
    const noLinks = (): void => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    };
    const first = await acquireAgentLock(dir, { pid: 1111, isAgent: () => true, link: noLinks });
    expect(first.held).toBe(true);
    expect(readFileSync(agentLockPath(dir), "utf8").trim()).toBe("1111");
    expect(await acquireAgentLock(dir, { pid: 2222, isAgent: () => true, link: noLinks })).toEqual({ held: false, holder: 1111 });
    if (first.held) first.release();
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
    // What it does say is believed, whatever the lock's age: "something else", or "an agent".
    writeFileSync(lock, process.pid + "\n");
    // Status 1 and nothing printed is what busybox's ps says for a pid it cannot list. The pid is alive: unknown, not gone.
    expect(isFleetAgentProcess(process.pid, dir, () => ({ status: 1, stdout: "" }))).toBe(true);
    expect(isFleetAgentProcess(process.pid, dir, () => ({ status: 0, stdout: "vim notes.md\n" }))).toBe(false);
    utimesSync(lock, old, old);
    expect(isFleetAgentProcess(process.pid, dir, () => ({ status: 0, stdout: "bun cli.ts __fleet-agent --config x\n" }))).toBe(true);
  });

  test("an agent of a build from before the lock is still seen where the process list says nothing: by its state file", async () => {
    const dir = scratch();
    const old = await fakeAgent();
    const state = join(dir, "state.json");
    const none = () => null;
    writeFileSync(state, JSON.stringify({ pid: old.pid, started_at: "x" }));
    // No lock, a fresh state file that names it: it is the agent.
    expect(isFleetAgentProcess(old.pid, dir, none)).toBe(true);
    // Another pid is not named by it, however fresh.
    expect(isFleetAgentProcess(process.pid, dir, none)).toBe(false);
    // A state file nobody has written for a while names nobody.
    const longAgo = new Date(Date.now() - 600_000);
    utimesSync(state, longAgo, longAgo);
    expect(isFleetAgentProcess(old.pid, dir, none)).toBe(false);
    // With a lock, the lock decides: it names its holder, and nobody else for being alive.
    writeFileSync(state, JSON.stringify({ pid: old.pid, started_at: "x" }));
    writeFileSync(agentLockPath(dir), process.pid + "\n");
    expect(isFleetAgentProcess(old.pid, dir, none)).toBe(false);
    expect(isFleetAgentProcess(process.pid, dir, none)).toBe(true);
  });

  test("status, stop and start see a pre-lock agent where the process list says nothing: it is not started beside", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const old = await fakeAgent();
    mkdirp(fleetAgentDir(configPath));
    writeFileSync(fleetAgentStatePath(configPath), JSON.stringify({ pid: old.pid, started_at: "x", config_path: configPath, replica: "lazy" }));
    // Where ps or /proc answer, the command line names it; where they do not (some sandboxes, Windows), the state file does.
    expect(fleetAgentStatus(configPath).running).toBe(true);
    expect((await ensureFleetAgent(configPath, {}, { installed: () => false, pid: () => undefined, restart: () => false })).pid).toBe(old.pid);
    expect(stopFleetAgent(configPath)).toBe(true);
    await Bun.sleep(100);
    expect(() => process.kill(old.pid, 0)).toThrow();
  });

  test("/proc says what a pid is where it can: a command line is an answer, and anything else is not", () => {
    const dir = scratch();
    const files: Record<string, string> = {
      "/proc/10/cmdline": "/usr/bin/bun\0/opt/prime/cli.ts\0__fleet-agent\0--config\0c.yaml\0",
      "/proc/20/cmdline": "vim\0notes.md\0",
      "/proc/30/cmdline": "",
    };
    const probe = procProbeWith((file) => {
      const text = files[file];
      if (text === undefined) throw new Error("ENOENT");
      return text;
    });
    expect(probe(10)).toEqual({ status: 0, stdout: "/usr/bin/bun /opt/prime/cli.ts __fleet-agent --config c.yaml" });
    expect(probe(20)?.stdout).toBe("vim notes.md");
    // A kernel thread (empty) and a pid that is not there say nothing.
    expect(probe(30)).toBeNull();
    expect(probe(40)).toBeNull();
    // Through the check, on this process, which is alive: the named command decides, whatever the lock says.
    writeFileSync(agentLockPath(dir), process.pid + "\n");
    expect(isFleetAgentProcess(process.pid, dir, () => probe(10))).toBe(true);
    expect(isFleetAgentProcess(process.pid, dir, () => probe(20))).toBe(false);
  });

  test("racing `agent start`s: concurrent writers of settings and state never trip over each other's temp file", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const daemon = join(import.meta.dir, "../src/fleet-daemon.ts");
    const code = `
      const d = await import(${JSON.stringify(daemon)});
      const cfg = ${JSON.stringify(configPath)};
      for (let i = 0; i < 60; i++) {
        d.persistAgentSettings(cfg, { PRIME_FLEET_REPLICA: (i + process.pid) % 2 ? "mirror" : "lazy" });
        d.writeAgentState(cfg, { pid: process.pid, started_at: "x", config_path: cfg, rounds: i });
      }
    `;
    mkdirp(fleetAgentDir(configPath));
    const children = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, "-e", code], { stdin: "ignore", stdout: "ignore", stderr: "pipe" }));
    const results = await Promise.all(children.map(async (c) => ({ code: await c.exited, err: await new Response(c.stderr).text() })));
    expect(results.filter((r) => r.code !== 0).map((r) => r.err.slice(0, 200))).toEqual([]);
    // What is left is whole, and no temp file is.
    expect(["lazy", "mirror"]).toContain(readAgentSettings(configPath).replica!);
    expect(JSON.parse(readFileSync(fleetAgentStatePath(configPath), "utf8")).rounds).toBeGreaterThanOrEqual(0);
    expect(readdirSync(fleetAgentDir(configPath)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("the state file is an agent's own to write or remove only if it names that agent or nobody alive", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    mkdirp(fleetAgentDir(configPath));
    const winner = await fakeAgent();
    const state = (pid: number) => writeFileSync(fleetAgentStatePath(configPath), JSON.stringify({ pid, started_at: "x", config_path: configPath }));
    // No file: ours to write.
    expect(ownsAgentState(configPath, 4242)).toBe(true);
    // It names the agent that won the lock: the one that lost must leave it alone.
    state(winner.pid);
    expect(ownsAgentState(configPath, 4242)).toBe(false);
    expect(ownsAgentState(configPath, winner.pid)).toBe(true);
    // It names an agent that is gone (a crash): the next agent takes it over.
    state(999999);
    expect(ownsAgentState(configPath, 4242)).toBe(true);
  });

  test("the agent's state is replaced, not rewritten in place: a reader never finds it empty", () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    mkdirp(fleetAgentDir(configPath));
    const state = { pid: 1, started_at: "x", config_path: configPath } as const;
    writeAgentState(configPath, state);
    const first = statSync(fleetAgentStatePath(configPath)).ino;
    writeAgentState(configPath, { ...state, rounds: 2 });
    expect(JSON.parse(readFileSync(fleetAgentStatePath(configPath), "utf8")).rounds).toBe(2);
    expect(statSync(fleetAgentStatePath(configPath)).ino).not.toBe(first);
    expect(readdirSync(fleetAgentDir(configPath)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
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
    expect(() => process.kill(old.pid, 0)).not.toThrow();
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
  });

  test("a service file whose manager cannot be reached does not leave a machine with no agent: it is started directly", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    let spawned = 0;
    const state = await ensureFleetAgent(configPath, {}, {
      installed: () => true,
      pid: () => undefined,
      restart: () => false,
      spawnAgent: () => {
        spawned++;
        running(configPath, plainAgent().pid, "lazy");
      },
    });
    expect(spawned).toBe(1);
    expect(isFleetAgentProcess(state.pid, fleetAgentDir(configPath))).toBe(true);
  });

  test("a service file whose manager cannot be reached manages nothing: the healthy agent is neither stopped nor replaced", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const mine = await fakeAgent();
    running(configPath, mine.pid, "lazy");
    let asked = 0;
    // Bound to this configuration, but launchctl / systemctl could not be reached (pid unknown too).
    const service = agentServiceFor(
      configPath,
      () => ({ installed: true, reachable: false }),
      () => {
        asked++;
        return false;
      },
    );
    for (let i = 0; i < 3; i++) expect((await ensureFleetAgent(configPath, {}, service)).pid).toBe(mine.pid);
    expect(() => process.kill(mine.pid, 0)).not.toThrow();
    expect(asked).toBe(0);
  });

  test("a settings change that cannot reach the manager of an installed service leaves the running agent alone, and says why", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const mine = await fakeAgent();
    running(configPath, mine.pid, "lazy");
    withMode("mirror");
    let spawned = 0;
    const service = {
      ...agentServiceFor(configPath, () => ({ installed: true, reachable: false }), () => false),
      spawnAgent: () => void spawned++,
    };
    let error: unknown;
    try {
      await ensureFleetAgent(configPath, { fromShell: true }, service);
    } catch (err) {
      error = err;
    }
    expect(String((error as Error)?.message)).toMatch(/manager cannot be reached/);
    // Not a failure to start the agent: callers say "settings pending", not "did not start".
    expect(error).toBeInstanceOf(SettingsPendingError);
    // Nothing was stopped or spawned, and the state of the agent that runs is still there.
    expect(spawned).toBe(0);
    expect(() => process.kill(mine.pid, 0)).not.toThrow();
    expect(existsSync(fleetAgentStatePath(configPath))).toBe(true);
    // What was asked for is saved for the service's next restart.
    expect(readAgentSettings(configPath).replica).toBe("mirror");
  });

  test("the agent is started with the absolute path of its configuration, so a relative one is not skipped by the pid-reuse check", () => {
    const cmd = agentCommand("rel/config.yaml");
    expect(cmd.slice(-3)).toEqual(["__fleet-agent", "--config", resolve("rel/config.yaml")]);
    expect(isAbsolute(cmd[cmd.length - 1]!)).toBe(true);
  });

  test("a manager that answers and then will not restart the running agent leaves it and its state alone, and says so", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const own = await fakeAgent();
    running(configPath, own.pid, "lazy");
    withMode("mirror");
    let spawned = 0;
    let error: unknown;
    try {
      await ensureFleetAgent(configPath, { fromShell: true }, {
        installed: () => true,
        pid: () => own.pid,
        restart: () => false,
        spawnAgent: () => void spawned++,
        stopWaitMs: 300,
      });
    } catch (err) {
      error = err;
    }
    expect(String(error)).toContain("would not restart the running fleet agent");
    expect(error).toBeInstanceOf(SettingsPendingError);
    expect(spawned).toBe(0);
    expect(existsSync(fleetAgentStatePath(configPath))).toBe(true);
    expect(() => process.kill(own.pid, 0)).not.toThrow();
  });

  test("the service of another configuration is not this one's: its agent is left alone and the manager is never asked", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const mine = await fakeAgent();
    running(configPath, mine.pid, "lazy");
    // The one service on the machine runs /somewhere/else.yaml, as the default configuration's agent.
    let asked = 0;
    const service = agentServiceFor(
      configPath,
      () => bindServiceStatus({ installed: true, running: true, where: "w", pid: 4242 }, "/somewhere/else.yaml", configPath),
      () => {
        asked++;
        return true;
      },
    );
    // Nothing differs: the running agent is returned as it is.
    expect((await ensureFleetAgent(configPath, {}, service)).pid).toBe(mine.pid);
    // A settings change restarts it directly (this configuration has no service), not through the manager.
    withMode("mirror");
    let envSeen: Record<string, string | undefined> = {};
    const state = await ensureFleetAgent(configPath, { fromShell: true }, {
      ...service,
      stopWaitMs: 3000,
      spawnAgent: (env) => {
        envSeen = env;
        running(configPath, plainAgent().pid, "mirror");
      },
    });
    expect(asked).toBe(0);
    expect(isFleetAgentProcess(mine.pid, fleetAgentDir(configPath))).toBe(false);
    expect(envSeen.PRIME_FLEET_REPLICA).toBe("mirror");
    expect(state.pid).not.toBe(mine.pid);
  });

  test("installing for a configuration while the one service runs another is refused, and nothing is stopped", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const old = await fakeAgent();
    running(configPath, old.pid, "lazy");
    let installed = false;
    let error: unknown;
    try {
      await installFleetAgent(configPath, { install: () => ((installed = true), "x"), boundTo: () => "/somewhere/else.yaml", servicePid: () => undefined });
    } catch (err) {
      error = err;
    }
    expect(String(error)).toContain("installed for /somewhere/else.yaml");
    expect(installed).toBe(false);
    expect(isFleetAgentProcess(old.pid, fleetAgentDir(configPath))).toBe(true);
  });

  test("uninstalling under another configuration refuses to remove the service that runs the default one, unless forced", () => {
    let removed = 0;
    const uninstall = () => (removed++, true);
    const there = join(scratch(), "config.json");
    expect(() => uninstallFleetAgent(there, { uninstall, boundTo: () => "/home/me/.prime/config.yaml" })).toThrow("runs /home/me/.prime/config.yaml");
    expect(removed).toBe(0);
    // Its own configuration, or when none is installed, or when forced: removed.
    expect(uninstallFleetAgent(there, { uninstall, boundTo: () => there })).toBe(true);
    expect(uninstallFleetAgent(there, { uninstall, boundTo: () => undefined })).toBe(true);
    expect(uninstallFleetAgent(there, { uninstall, boundTo: () => "/home/me/.prime/config.yaml", force: true })).toBe(true);
    expect(removed).toBe(3);
  });

  test("a reinstall leaves the service's own agent to the manager, which stops it itself", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const own = await fakeAgent();
    running(configPath, own.pid, "lazy");
    let aliveAtInstall: boolean | undefined;
    await installFleetAgent(configPath, {
      boundTo: () => configPath,
      servicePid: () => own.pid,
      install: () => {
        aliveAtInstall = isFleetAgentProcess(own.pid, fleetAgentDir(configPath));
        return "x";
      },
    });
    expect(aliveAtInstall).toBe(true);
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
      boundTo: () => undefined,
      servicePid: () => undefined,
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
      await installFleetAgent(other, { stopWaitMs: 300, boundTo: () => undefined, servicePid: () => undefined, install: () => ((installed = true), "x") });
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
    const longAgo = new Date(Date.now() - 600_000);
    utimesSync(fleetAgentStatePath(configPath), longAgo, longAgo);
    expect(fleetAgentStatus(configPath).running).toBe(false);
    expect(stopFleetAgent(configPath)).toBe(false);
    await Bun.sleep(100);
    expect(other.killed).toBe(false);
    expect(other.exitCode).toBeNull();
    expect(existsSync(fleetAgentStatePath(configPath))).toBe(false);
  });

  test("an agent that a command starts is told not to wait for a lock that is held, and leaves at once when it lost the race", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    let seen: Record<string, string | undefined> = {};
    const winner = plainAgent();
    const state = await ensureFleetAgent(configPath, {}, {
      installed: () => false,
      pid: () => undefined,
      restart: () => false,
      spawnAgent: (env) => {
        seen = env;
        // Another start won: the state that appears is the winner's.
        running(configPath, winner.pid, "lazy");
      },
    });
    expect(seen.PRIME_FLEET_LOCK_WAIT_MS).toBe("0");
    expect(state.pid).toBe(winner.pid);
    // The agent, with that setting, does not wait for a live holder (the default is 10 s).
    const other = join(scratch(), "config.json");
    running(other, winner.pid, "lazy");
    withEnv("PRIME_FLEET_LOCK_WAIT_MS", "0");
    const was = process.exitCode;
    cleanups.push(() => {
      process.exitCode = was;
    });
    const began = Date.now();
    await runFleetAgent(other);
    expect(Date.now() - began).toBeLessThan(2000);
    expect(process.exitCode).toBe(1);
    // And leaves the winner's state and lock as they were.
    expect(JSON.parse(readFileSync(fleetAgentStatePath(other), "utf8")).pid).toBe(winner.pid);
    expect(readFileSync(agentLockPath(fleetAgentDir(other)), "utf8").trim()).toBe(String(winner.pid));
  });

  test("a configuration with no service restarts its own agent on a mode change (a new pid), and the manager is never called", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const old = await fakeAgent();
    running(configPath, old.pid, "mirror");
    withMode("lazy");
    let managerCalls = 0;
    let spawnedPid = 0;
    const state = await ensureFleetAgent(configPath, { fromShell: true }, {
      installed: () => false,
      pid: () => (managerCalls++, undefined),
      restart: () => (managerCalls++, true),
      stopWaitMs: 3000,
      spawnAgent: () => {
        spawnedPid = plainAgent().pid;
        running(configPath, spawnedPid, "lazy");
      },
    });
    expect(state.pid).toBe(spawnedPid);
    expect(state.pid).not.toBe(old.pid);
    expect(state.replica).toBe("lazy");
    expect(() => process.kill(old.pid, 0)).toThrow();
    expect(managerCalls).toBe(0);
  });
});

describe("a pid that another configuration's agent now has", () => {
  test("is not this configuration's agent, however fresh the lock; the same configuration's is", () => {
    const root = scratch();
    const mine = join(root, "mine");
    const other = join(root, "other");
    mkdirSync(join(mine, "fleet-agent"), { recursive: true });
    mkdirSync(join(other, "fleet-agent"), { recursive: true });
    const dir = join(mine, "fleet-agent");
    writeFileSync(agentLockPath(dir), process.pid + "\n");
    const says = (config: string) => () => ({ status: 0, stdout: "bun /x/index.ts __fleet-agent --config " + config + "\n" });
    expect(isFleetAgentProcess(process.pid, dir, says(join(other, "config.yaml")))).toBe(false);
    expect(isFleetAgentProcess(process.pid, dir, says(join(mine, "config.yaml")))).toBe(true);
    // `--config=`, a path with spaces, and flags after it.
    expect(isFleetAgentProcess(process.pid, dir, () => ({ status: 0, stdout: "bun i.ts __fleet-agent --config=" + join(other, "c.yaml") + "\n" }))).toBe(false);
    expect(isFleetAgentProcess(process.pid, dir, () => ({ status: 0, stdout: "bun i.ts __fleet-agent --config " + join(mine, "my config.yaml") + " --verbose\n" }))).toBe(true);
    // A command line that names no configuration, or a relative one, cannot say: it counts.
    expect(isFleetAgentProcess(process.pid, dir, () => ({ status: 0, stdout: "bun i.ts __fleet-agent\n" }))).toBe(true);
    expect(isFleetAgentProcess(process.pid, dir, () => ({ status: 0, stdout: "bun i.ts __fleet-agent --config rel.yaml\n" }))).toBe(true);
  });

  test("a stale lock that names it is taken over", async () => {
    const root = scratch();
    const dir = join(root, "mine", "fleet-agent");
    mkdirSync(dir, { recursive: true });
    const other = plainAgent(); // a live "agent", whose command line has no --config here
    writeFileSync(agentLockPath(dir), other.pid + "\n");
    const probe = () => ({ status: 0, stdout: "bun i.ts __fleet-agent --config " + join(root, "other", "config.yaml") + "\n" });
    const got = await acquireAgentLock(dir, { isAgent: (pid) => isFleetAgentProcess(pid, dir, probe) });
    expect(got.held).toBe(true);
    if (got.held) got.release();
  });
});

describe("two spellings of one configuration", () => {
  test("a path that differs only in case is the same file where the file system folds case", () => {
    // Under /tmp, which is a symlink on macOS: realpath leaves the case of a directory after it as it was typed.
    // Made by another process, and asked in a fresh one (a guard: realpath already settles this).
    const base = "/tmp/FleetCase-" + process.pid + "-" + Date.now();
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const dir = join(base, "CaseDir");
    Bun.spawnSync(["sh", "-c", 'mkdir -p "$1" && : > "$1/Config.yaml"', "sh", dir]);
    const swapped = join(base.toLowerCase(), "casedir", "config.yaml");
    if (!existsSync(swapped)) return; // a case-sensitive file system: these are two files, and not the same
    // In a process of its own: realpath remembers the spellings it has been given.
    const ask = (a: string, b: string): string =>
      Bun.spawnSync([process.execPath, "-e", 'import { sameConfig } from "' + join(import.meta.dir, "../src/fleet-service.ts") + '"; console.log(sameConfig(process.argv[1], process.argv[2]));', a, b], {
        env: process.env,
      }).stdout.toString().trim();
    expect(ask(swapped, join(dir, "Config.yaml"))).toBe("true");
    expect(ask(join(base.toLowerCase(), "casedir", "other.yaml"), join(dir, "Config.yaml"))).toBe("false");
  });
});

describe("asking the service manager", () => {
  const platformHasDefinitions = process.platform === "darwin" || process.platform === "linux";

  test.skipIf(!platformHasDefinitions)("a configuration with no service definition is not a reason to ask launchd or systemd", () => {
    let asked = 0;
    const status = fleetAgentServiceStatus("/somewhere/config.yaml", {
      definition: null,
      probe: () => {
        asked++;
        return { installed: true, running: true, where: "x", reachable: true };
      },
    });
    expect(asked).toBe(0);
    expect(status.installed).toBe(false);
    expect(status.running).toBe(false);
    expect(status.where).toContain("fleet-agent");
  });

  test.skipIf(!platformHasDefinitions)("a definition that is there is asked about, once", () => {
    let asked = 0;
    const status = fleetAgentServiceStatus("/somewhere/config.yaml", {
      definition: { config: "/somewhere/config.yaml" },
      probe: () => {
        asked++;
        return { installed: true, running: true, where: "x", reachable: true, pid: 7 };
      },
    });
    expect(asked).toBe(1);
    expect(status.installed).toBe(true);
    expect(status.pid).toBe(7);
  });

  test("what one call wants to know of it is asked in one go, not once for each thing", () => {
    if (!platformHasDefinitions) return;
    let asked = 0;
    const service = agentServiceFor(
      "/somewhere/config.yaml",
      () => {
        asked++;
        return { installed: true, reachable: true, pid: 12 };
      },
      () => false,
    );
    expect(service.installed()).toBe(true);
    expect(service.pid()).toBe(12);
    expect(service.unreachable?.()).toBe(false);
    expect(asked).toBe(1);
    // After a restart it is asked again: what it said before is not what it says now.
    service.restart();
    service.installed();
    expect(asked).toBe(2);
  });
});

describe("stopping an agent that a service runs", () => {
  function running(configPath: string, pid: number): void {
    mkdirSync(fleetAgentDir(configPath), { recursive: true });
    writeFileSync(fleetAgentStatePath(configPath), JSON.stringify({ pid, started_at: "x", config_path: configPath, replica: "lazy", settings: { replica: "lazy", cacheMb: 512, pollMs: 1500, heartbeatMs: 15000 } }));
    writeFileSync(agentLockPath(fleetAgentDir(configPath)), pid + "\n");
  }
  const gone = async (pid: number): Promise<boolean> => {
    for (let i = 0; i < 60; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await Bun.sleep(25);
    }
    return false;
  };

  test("the manager is asked to stop it: killing the process only has the manager start another", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const agent = await fakeAgent();
    running(configPath, agent.pid);
    let stops = 0;
    const service = {
      installed: () => true,
      pid: () => agent.pid,
      restart: () => false,
      // What the manager does: it stops the process and does not start it again.
      stop: () => {
        stops++;
        process.kill(agent.pid, "SIGTERM");
        return true;
      },
    };
    const result = await stopFleetAgentManaged(configPath, service);
    expect(result).toEqual({ stopped: true, via: "service", restarts: false });
    expect(stops).toBe(1);
    expect(await gone(agent.pid)).toBe(true);
    expect(existsSync(fleetAgentStatePath(configPath))).toBe(false);
  });

  test("a manager that will not stop it leaves the process stopped, and says the service starts another", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const agent = await fakeAgent();
    running(configPath, agent.pid);
    const result = await stopFleetAgentManaged(configPath, { installed: () => true, pid: () => agent.pid, restart: () => false, stop: () => false });
    expect(result).toEqual({ stopped: true, via: "process", restarts: true });
    expect(await gone(agent.pid)).toBe(true);
  });

  test("with no service the process is stopped, as it always was, and the manager is not asked", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const agent = await fakeAgent();
    running(configPath, agent.pid);
    let stops = 0;
    const result = await stopFleetAgentManaged(configPath, {
      installed: () => false,
      pid: () => undefined,
      restart: () => false,
      stop: () => {
        stops++;
        return true;
      },
    });
    expect(result).toEqual({ stopped: true, via: "process", restarts: false });
    expect(stops).toBe(0);
    expect(await gone(agent.pid)).toBe(true);
  });

  test("an agent that is not running is not a reason to stop a service", async () => {
    const root = scratch();
    let stops = 0;
    const result = await stopFleetAgentManaged(join(root, "config.json"), {
      installed: () => true,
      pid: () => undefined,
      restart: () => false,
      stop: () => {
        stops++;
        return true;
      },
    });
    expect(result.stopped).toBe(false);
    expect(stops).toBe(0);
  });

  test("an agent started by hand beside a loaded service is stopped, and so is the service that would start another", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const agent = await fakeAgent();
    running(configPath, agent.pid);
    let loaded = true;
    const calls: string[] = [];
    const service = {
      installed: () => true,
      pid: () => undefined, // its own instance is crash-looping on the lock
      loaded: () => loaded,
      restart: () => false,
      stop: () => {
        calls.push("stop");
        const was = loaded;
        loaded = false;
        return was;
      },
      stopWaitMs: 300,
    };
    const result = await stopFleetAgentManaged(configPath, service);
    expect(result).toEqual({ stopped: true, via: "process", restarts: false, serviceStopped: true });
    expect(await gone(agent.pid)).toBe(true);
    expect(loaded).toBe(false);
    // Said again, with nothing running and nothing loaded, it is not an error and asks nothing.
    expect(await stopFleetAgentManaged(configPath, service)).toEqual({ stopped: false, via: "process", restarts: false });
    expect(calls).toEqual(["stop"]);
  });

  test("an agent beside a service the manager has unloaded is stopped, and nothing is said to start another", async () => {
    const root = scratch();
    const configPath = join(root, "config.json");
    const agent = await fakeAgent();
    running(configPath, agent.pid);
    let asked = 0;
    const result = await stopFleetAgentManaged(configPath, {
      installed: () => true,
      pid: () => undefined,
      loaded: () => false,
      restart: () => false,
      stop: () => {
        asked++;
        return false; // bootout of what is not loaded fails
      },
    });
    expect(result).toEqual({ stopped: true, via: "process", restarts: false });
    expect(asked).toBe(0);
    expect(await gone(agent.pid)).toBe(true);
  });

  test("a loaded service whose agent is not running (failing, or just starting) is stopped through the manager", async () => {
    const root = scratch();
    let stops = 0;
    const result = await stopFleetAgentManaged(join(root, "config.json"), {
      installed: () => true,
      pid: () => 4242,
      loaded: () => true,
      restart: () => false,
      stop: () => {
        stops++;
        return true;
      },
    });
    expect(result).toEqual({ stopped: false, via: "service", restarts: false, serviceStopped: true });
    expect(stops).toBe(1);
  });

  test("the manager holds a service that is running or about to start again, not one that was stopped", () => {
    expect(managerHolds({ installed: true, running: true, detail: "running" }, "darwin")).toBe(true);
    expect(managerHolds({ installed: true, running: false, detail: "spawn scheduled" }, "darwin")).toBe(true);
    expect(managerHolds({ installed: true, running: false, detail: "not loaded" }, "darwin")).toBe(false);
    expect(managerHolds({ installed: true, running: false, detail: "activating" }, "linux")).toBe(true);
    expect(managerHolds({ installed: true, running: false, detail: "inactive" }, "linux")).toBe(false);
    expect(managerHolds({ installed: true, running: false, detail: "failed" }, "linux")).toBe(false);
    expect(managerHolds({ installed: false, running: true }, "linux")).toBe(false);
  });

  test("a service the manager has unloaded is still its manager answering", () => {
    // launchd, asked about a service that was stopped on purpose.
    expect(launchdAnswered({ code: 113, out: "", err: 'Bad request.\nCould not find service "dev.prime.fleet-agent" in domain for user gui: 501\n' })).toBe(true);
    expect(launchdAnswered({ code: 0, out: "state = running", err: "" })).toBe(true);
    // No session to ask: not an answer.
    expect(launchdAnswered({ code: 113, out: "", err: "Could not find domain for user gui: 501" })).toBe(false);
    expect(launchdAnswered({ code: 1, out: "", err: "launchctl: command not found" })).toBe(false);
  });
});
