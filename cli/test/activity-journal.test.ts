// The activity journal: what a device writes down about each tool call it runs. Unit tests of the ring,
// and the real code-mcp behind a stub gateway for who is written down as the caller.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ACTIVITY_LIMIT_BYTES, ActivityJournal, readActivity } from "../src/activity-journal.ts";
import { addCaller, loadOrCreateCallerKey, signCall } from "../src/caller-key.ts";
import { parseCodeMcpArgs, toCodeMcpArgv } from "../src/code-mcp-options.ts";
import { withDirLock } from "../src/dir-lock.ts";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch = () => mkdtempSync(join(tmpdir(), "prime-activity-"));

/** Wait (up to 10 s) until `done()`: the journal of a running code-mcp is written a moment after the answer. */
async function waitFor(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 50));
}

/** Fill a journal with `n` calls and wait until they are in the file. */
async function fill(journal: ActivityJournal, n: number, name = (i: number) => `tool${i}`): Promise<void> {
  for (let i = 0; i < n; i++) journal.record(name(i), "unsigned");
  await journal.flush();
}

describe("ActivityJournal", () => {
  test("writes one line per call with its number, the file's id, the time, the tool and the caller, and nothing else", async () => {
    const file = join(scratch(), "state", "activity.jsonl");
    let now = Date.parse("2026-12-01T10:00:00.000Z");
    const journal = new ActivityJournal(file, { now: () => now });
    journal.record("write", "keyA");
    now += 1000;
    journal.record("bash", "unsigned");
    await journal.flush();
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].fid).toMatch(/^[0-9a-f]{8}$/);
    expect(lines).toEqual([
      { seq: 1, fid: lines[0].fid, ts: "2026-12-01T10:00:00.000Z", tool: "write", caller: "keyA" },
      { seq: 2, fid: lines[0].fid, ts: "2026-12-01T10:00:01.000Z", tool: "bash", caller: "unsigned" },
    ]);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("a call is only queued when it is noted: nothing is on disk until the queue is written, and flushSync writes it", () => {
    const file = join(scratch(), "a.jsonl");
    const journal = new ActivityJournal(file);
    journal.record("a", "k");
    journal.record("b", "k");
    expect(existsSync(file)).toBe(false);
    journal.flushSync();
    expect(readActivity(file).entries.map((e) => e.tool)).toEqual(["a", "b"]);
  });

  test("noting a call is cheap and does not block: back to back, p95 under 1 ms, and the event loop keeps turning", async () => {
    const file = join(scratch(), "a.jsonl");
    const journal = new ActivityJournal(file);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    const times: number[] = [];
    for (let i = 0; i < 1500; i++) {
      const t = performance.now();
      journal.record(`tool${i}`, "unsigned");
      times.push(performance.now() - t);
      if (i % 100 === 99) await new Promise((r) => setTimeout(r, 2)); // calls arrive over time, as they do
    }
    const wrote = performance.now();
    await journal.flush();
    clearInterval(timer);
    times.sort((x, y) => x - y);
    expect(times[Math.floor(times.length * 0.95)]!).toBeLessThan(1);
    expect(times[times.length - 1]!).toBeLessThan(50);
    expect(ticks).toBeGreaterThan(5); // the loop was not held by the writing
    expect(performance.now() - wrote).toBeLessThan(5000);
    expect(readActivity(file).entries).toHaveLength(1500);
  });

  test("is a ring: it never grows past the limit and the oldest lines go first", async () => {
    const file = join(scratch(), "activity.jsonl");
    const journal = new ActivityJournal(file, { limit: 2000 });
    for (let i = 0; i < 60; i++) {
      journal.record(`tool${i}`, "unsigned");
      await journal.flush();
      expect(statSync(file).size).toBeLessThanOrEqual(2000);
    }
    const { entries } = readActivity(file);
    expect(entries.length).toBeGreaterThan(10);
    expect(entries[entries.length - 1]!.tool).toBe("tool59");
    // What is left is the newest run, in order, with no gap, and the numbers carry on across the compactions.
    const first = Number(entries[0]!.tool.slice(4));
    expect(entries.map((e) => e.tool)).toEqual(Array.from({ length: 60 - first }, (_, i) => `tool${first + i}`));
    expect(entries.map((e) => e.seq)).toEqual(Array.from({ length: 60 - first }, (_, i) => first + i + 1));
    expect(new Set(entries.map((e) => e.fid)).size).toBe(1);
  });

  test("a batch bigger than the ring keeps its newest calls, and the file still stays within the limit", async () => {
    const file = join(scratch(), "activity.jsonl");
    const journal = new ActivityJournal(file, { limit: 2000 });
    await fill(journal, 100);
    expect(statSync(file).size).toBeLessThanOrEqual(2000);
    const { entries } = readActivity(file);
    expect(entries[entries.length - 1]).toMatchObject({ seq: 100, tool: "tool99" });
  });

  test("the limit is in bytes: a name of multi-byte characters does not take the file past it", async () => {
    const file = join(scratch(), "activity.jsonl");
    const limit = 4000;
    const journal = new ActivityJournal(file, { limit });
    for (let i = 0; i < 40; i++) {
      journal.record("日本語".repeat(30) + i, "unsigned");
      await journal.flush();
      expect(statSync(file).size).toBeLessThanOrEqual(limit);
    }
    expect(readActivity(file).entries.length).toBeGreaterThan(2);
  });

  test("the default limit is 1 MiB", () => {
    expect(ACTIVITY_LIMIT_BYTES).toBe(1024 * 1024);
  });

  test("a tool name is cut to a sane length", async () => {
    const file = join(scratch(), "a.jsonl");
    const journal = new ActivityJournal(file);
    journal.record("x".repeat(500), "unsigned");
    await journal.flush();
    expect(readActivity(file).entries[0]!.tool).toHaveLength(128);
  });

  test("never throws when the file cannot be written, and says why once", async () => {
    const dir = scratch();
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "a file where a directory is needed");
    const said: string[] = [];
    const journal = new ActivityJournal(join(blocker, "activity.jsonl"), { onError: (m) => said.push(m) });
    expect(() => journal.record("bash", "unsigned")).not.toThrow();
    await journal.flush();
    journal.record("bash", "unsigned");
    await journal.flush();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("cannot be written");
  });

  test("a reader resumes from its position, and two calls in the same millisecond are not split", async () => {
    const file = join(scratch(), "a.jsonl");
    const journal = new ActivityJournal(file, { now: () => 1_000_000 }); // a clock that does not move
    await fill(journal, 1, () => "a");
    const first = readActivity(file);
    expect(first.entries.map((e) => e.tool)).toEqual(["a"]);
    await fill(journal, 2, (i) => ["b", "c"][i]!); // the same millisecond as the one just read
    const next = readActivity(file, first.position);
    expect(next.entries.map((e) => e.tool)).toEqual(["b", "c"]);
    expect(next.gap).toBe(false);
    expect(readActivity(file, next.position).entries).toEqual([]);
    // the clock stepping back changes nothing
    const back = new ActivityJournal(file, { now: () => 5 });
    await fill(back, 1, () => "d");
    expect(readActivity(file, next.position).entries.map((e) => e.tool)).toEqual(["d"]);
  });

  test("a reader that fell behind the ring sees a gap", async () => {
    const file = join(scratch(), "a.jsonl");
    const journal = new ActivityJournal(file, { limit: 1500 });
    await fill(journal, 1, () => "t0");
    const seen = readActivity(file).position;
    for (let i = 1; i < 40; i++) {
      journal.record(`t${i}`, "k");
      await journal.flush();
    }
    const behind = readActivity(file, seen);
    expect(behind.gap).toBe(true);
    expect(behind.entries[behind.entries.length - 1]!.tool).toBe("t39");
  });

  test("a file that was deleted and made again is another file, even when it has grown past the reader's position", async () => {
    const file = join(scratch(), "a.jsonl");
    const journal = new ActivityJournal(file);
    await fill(journal, 5);
    const seen = readActivity(file).position;
    expect(seen.seq).toBe(5);
    rmSync(file);
    await fill(new ActivityJournal(file), 20, (i) => `new${i}`);
    const reread = readActivity(file, seen);
    expect(reread.gap).toBe(true); // the position was 5 and the file now has 20: by number alone nothing would show
    expect(reread.entries).toHaveLength(20);
    expect(reread.entries[0]!.tool).toBe("new0");
    expect(reread.position.fid).not.toBe(seen.fid);
    // the same file, read again, is not a gap
    expect(readActivity(file, reread.position).gap).toBe(false);
    expect(readActivity(join(scratch(), "missing.jsonl"), { seq: 5, fid: "aa" })).toEqual({ entries: [], position: { seq: 5, fid: "aa" }, gap: false });
  });

  test("skips what is not an entry, and carries on counting from the last good line", async () => {
    const file = join(scratch(), "a.jsonl");
    const l = (o: object) => JSON.stringify(o);
    writeFileSync(
      file,
      [
        l({ seq: 1, fid: "aabbccdd", ts: "2026-12-01T10:00:00.000Z", tool: "a", caller: "k" }),
        "garbage",
        l({ seq: 2, fid: "aabbccdd", ts: "2026-12-01T11:00:00.000Z", tool: "b", caller: "k" }),
        l({ seq: 3, fid: "aabbccdd", ts: 1, tool: "c", caller: "k" }),
        l({ fid: "aabbccdd", ts: "2026-12-01T12:00:00.000Z", tool: "d", caller: "k" }),
        l({ seq: 0, fid: "aabbccdd", ts: "2026-12-01T12:00:00.000Z", tool: "e", caller: "k" }),
        l({ seq: 4, ts: "2026-12-01T12:00:00.000Z", tool: "no file id", caller: "k" }),
        "",
      ].join("\n"),
    );
    expect(readActivity(file).entries.map((e) => e.tool)).toEqual(["a", "b"]);
    await fill(new ActivityJournal(file), 1, () => "f");
    expect(readActivity(file).entries.map((e) => [e.seq, e.fid, e.tool])).toEqual([[1, "aabbccdd", "a"], [2, "aabbccdd", "b"], [3, "aabbccdd", "f"]]);
  });

  /** Hold the journal's lock, as another process would, until `release()`. */
  async function holdLock(file: string): Promise<() => Promise<void>> {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let taken!: () => void;
    const got = new Promise<void>((r) => (taken = r));
    const held = withDirLock(file + ".lock", async () => {
      taken();
      await gate;
    });
    await got;
    return async () => {
      release();
      await held;
    };
  }

  test("a clean exit does not wait on the lock while a drain waits for it: the lines are written at once, and not twice", async () => {
    const file = join(scratch(), "a.jsonl");
    const journal = new ActivityJournal(file);
    const release = await holdLock(file);
    journal.record("a", "k");
    journal.record("b", "k");
    await new Promise((r) => setTimeout(r, 30)); // the drain has taken the batch and waits for the lock
    const t = performance.now();
    journal.flushSync();
    expect(performance.now() - t).toBeLessThan(500); // not the second the lock wait would take
    expect(readActivity(file).entries.map((e) => e.tool)).toEqual(["a", "b"]);
    await release();
    await journal.flush();
    expect(readActivity(file).entries.map((e) => e.tool)).toEqual(["a", "b"]); // the drain wrote nothing more
  });

  test("while the file cannot be written the queue is bounded, what is dropped is counted and said, and the rest is written when it can be", async () => {
    const file = join(scratch(), "a.jsonl");
    const said: string[] = [];
    const journal = new ActivityJournal(file, { queueLimit: 5, onError: (m) => said.push(m) });
    const release = await holdLock(file);
    for (let i = 0; i < 20; i++) journal.record(`t${i}`, "k");
    expect(journal.pending).toBeLessThanOrEqual(5);
    expect(journal.droppedCalls).toBe(15);
    expect(said.filter((m) => m.includes("queue is full"))).toHaveLength(1);
    await journal.flush(); // the drain gives up on the lock (1 s) and puts the batch back
    expect(journal.pending).toBeLessThanOrEqual(5);
    await release();
    journal.record("last", "k"); // the next call tries again
    await journal.flush();
    const tools = readActivity(file).entries.map((e) => e.tool);
    expect(tools[tools.length - 1]).toBe("last");
    expect(tools.length).toBeLessThanOrEqual(5);
    expect(tools).toEqual([...tools].sort((x, y) => (x === "last" ? 1 : y === "last" ? -1 : Number(x.slice(1)) - Number(y.slice(1)))));
    expect(said.some((m) => /\d+ calls? (was|were) not noted/.test(m))).toBe(true);
    expect(journal.droppedCalls).toBe(0);
  });

  test("several processes writing one file lose no line and take no number twice", async () => {
    const file = join(scratch(), "shared.jsonl");
    const script = `import { ActivityJournal } from ${JSON.stringify(join(ROOT, "src", "activity-journal.ts"))};
      const j = new ActivityJournal(process.argv[1], { limit: 60000 });
      for (let i = 0; i < 30; i++) { j.record(process.argv[2] + "-" + i, "k"); if (i % 5 === 4) await j.flush(); }
      await j.flush();`;
    const procs = Array.from({ length: 4 }, (_, i) => Bun.spawn(["bun", "-e", script, file, `p${i}`], { stdout: "ignore", stderr: "pipe" }));
    for (const p of procs) expect(await p.exited).toBe(0);
    const { entries } = readActivity(file);
    expect(entries).toHaveLength(120);
    expect(entries.map((e) => e.seq)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    expect(new Set(entries.map((e) => e.tool)).size).toBe(120);
    expect(new Set(entries.map((e) => e.fid)).size).toBe(1);
  });

  test("two processes with a ring that keeps compacting lose no number either", async () => {
    const file = join(scratch(), "ring.jsonl");
    const script = `import { ActivityJournal } from ${JSON.stringify(join(ROOT, "src", "activity-journal.ts"))};
      const j = new ActivityJournal(process.argv[1], { limit: 1500 });
      for (let i = 0; i < 30; i++) { j.record(process.argv[2] + "-" + i, "k"); if (i % 3 === 2) await j.flush(); }
      await j.flush();`;
    const procs = Array.from({ length: 3 }, (_, i) => Bun.spawn(["bun", "-e", script, file, `p${i}`], { stdout: "ignore", stderr: "pipe" }));
    for (const p of procs) expect(await p.exited).toBe(0);
    const { entries, position } = readActivity(file);
    expect(position.seq).toBe(90); // every call took a number, in the order the lock gave them
    const seqs = entries.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[seqs.length - 1]).toBe(90);
  });
});

test("--activity-log is a code-mcp option", () => {
  expect(parseCodeMcpArgs(["--activity-log", "/s/activity.jsonl"]).options).toEqual({ "activity-log": "/s/activity.jsonl" });
  expect(toCodeMcpArgv({ "activity-log": "/s/activity.jsonl" })).toEqual(["--activity-log", "/s/activity.jsonl"]);
});

// ---- the real code-mcp --------------------------------------------------------------------------

describe("code-mcp journals the calls it runs", () => {
  const procs: ReturnType<typeof Bun.spawn>[] = [];
  afterAll(() => {
    for (const p of procs) p.kill();
  });

  async function freePort(): Promise<number> {
    const s = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = s.port;
    s.stop(true);
    return port as number;
  }

  async function start(dir: string, extra: string[]) {
    let socket: { send(text: string): void } | undefined;
    const pending = new Map<string, (m: Record<string, any>) => void>();
    let ready!: () => void;
    const connected = new Promise<void>((r) => (ready = r));
    const gw = Bun.serve({
      port: 0,
      fetch: (req, server) => (server.upgrade(req) ? undefined : new Response("no", { status: 400 })),
      websocket: {
        open: (ws) => {
          socket = ws;
        },
        message: (_ws, data) => {
          const m = JSON.parse(String(data)) as Record<string, any>;
          if (m.type === "register") ready();
          else if (m.id && pending.has(m.id)) pending.get(m.id)!(m);
        },
      },
    });
    const port = await freePort();
    const proc = Bun.spawn(
      ["bun", join(ROOT, "src", "code-mcp.ts"), "--gateway", `ws://127.0.0.1:${gw.port}`, "--id", "laptop", "--port", String(port), "--bind", "127.0.0.1", "--token", "t", ...extra],
      { cwd: dir, env: { ...process.env, HOME: dir }, stdout: "ignore", stderr: "ignore" },
    );
    procs.push(proc);
    await connected;
    let n = 0;
    return {
      port,
      send(frame: Record<string, unknown>): Promise<Record<string, any>> {
        const id = `f${++n}`;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("no reply from code-mcp")), 20_000);
          pending.set(id, (m) => {
            clearTimeout(timer);
            resolve(m);
          });
          socket!.send(JSON.stringify({ id, ...frame }));
        });
      },
      stop() {
        proc.kill();
        gw.stop(true);
      },
    };
  }

  const writeCall = (dir: string, name: string) => ({
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write", arguments: { cwd: dir, path: name, content: "SECRET-CONTENT" } },
  });

  test("a signed call is journaled under its key id, an unsigned one as unsigned, a local one as local; listing is not", async () => {
    const dir = scratch();
    const journal = join(dir, "state", "activity.jsonl");
    const callers = join(dir, "callers.json");
    const key = loadOrCreateCallerKey(join(dir, "me.pem"));
    addCaller(callers, { pub: key.publicKey });
    const r = await start(dir, ["--caller-auth", "warn", "--callers", callers, "--activity-log", journal]);
    try {
      const raw = JSON.stringify(writeCall(dir, "signed.txt"));
      const signed = await r.send({ request: JSON.parse(raw), raw, callerSig: signCall(key, "device:laptop", raw) });
      expect(signed.response.error).toBeUndefined();
      await r.send({ request: writeCall(dir, "bare.txt") });
      await r.send({ request: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
      const local = await fetch(`http://127.0.0.1:${r.port}/mcp?token=t`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(writeCall(dir, "local.txt")),
      });
      expect(local.status).toBe(200);

      await waitFor(() => existsSync(journal) && readActivity(journal).entries.length >= 3);
      const { entries } = readActivity(journal);
      expect(entries.map((e) => [e.tool, e.caller])).toEqual([
        ["write", key.keyId],
        ["write", "unsigned"],
        ["write", "local"],
      ]);
      // The journal says what ran, not with what.
      expect(readFileSync(journal, "utf8")).not.toContain("SECRET-CONTENT");
      expect(existsSync(join(dir, "signed.txt"))).toBe(true);
    } finally {
      r.stop();
    }
  });

  test("a call that did not run is not journaled: an unknown tool, a disabled one, a call that is refused", async () => {
    const dir = scratch();
    const journal = join(dir, "state", "activity.jsonl");
    const callers = join(dir, "callers.json");
    const key = loadOrCreateCallerKey(join(dir, "me.pem"));
    addCaller(callers, { pub: key.publicKey });
    const r = await start(dir, ["--caller-auth", "enforce", "--callers", callers, "--activity-log", journal, "--disallowed-tools", "bash"]);
    try {
      const call = (id: number, name: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { cwd: dir, command: "id" } } });
      const signed = async (id: number, name: string) => {
        const raw = JSON.stringify(call(id, name));
        return r.send({ request: JSON.parse(raw), raw, callerSig: signCall(key, "device:laptop", raw) });
      };
      const unknown = await signed(1, "no_such_tool");
      expect(unknown.response.error.code).toBe(-32601);
      const disabled = await signed(2, "bash");
      expect(JSON.stringify(disabled.response)).toContain("disabled");
      const refused = await r.send({ request: call(3, "write") }); // not signed: refused in enforce
      expect(refused.response.error.code).toBe(-32001);
      expect(existsSync(journal)).toBe(false);
      // and one that does run is
      const raw = JSON.stringify(writeCall(dir, "ok.txt"));
      await r.send({ request: JSON.parse(raw), raw, callerSig: signCall(key, "device:laptop", raw) });
      await waitFor(() => existsSync(journal));
      expect(readActivity(journal).entries.map((e) => [e.tool, e.caller])).toEqual([["write", key.keyId]]);
    } finally {
      r.stop();
    }
  });

  test("without --activity-log nothing is written", async () => {
    const dir = scratch();
    const r = await start(dir, []);
    try {
      await r.send({ request: writeCall(dir, "a.txt") });
      expect(existsSync(join(dir, "activity.jsonl"))).toBe(false);
    } finally {
      r.stop();
    }
  });
});
