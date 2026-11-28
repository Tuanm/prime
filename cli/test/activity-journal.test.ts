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
import { applyTestTimeout } from "./setup";

applyTestTimeout();

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch = () => mkdtempSync(join(tmpdir(), "prime-activity-"));

describe("ActivityJournal", () => {
  test("writes one line per call with its number, the time, the tool and the caller, and nothing else", () => {
    const file = join(scratch(), "state", "activity.jsonl");
    let now = Date.parse("2026-12-01T10:00:00.000Z");
    const journal = new ActivityJournal(file, { now: () => now });
    journal.record("write", "keyA");
    now += 1000;
    journal.record("bash", "unsigned");
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { seq: 1, ts: "2026-12-01T10:00:00.000Z", tool: "write", caller: "keyA" },
      { seq: 2, ts: "2026-12-01T10:00:01.000Z", tool: "bash", caller: "unsigned" },
    ]);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("is a ring: it never grows past the limit and the oldest lines go first", () => {
    const file = join(scratch(), "activity.jsonl");
    const journal = new ActivityJournal(file, { limit: 2000 });
    for (let i = 0; i < 60; i++) {
      journal.record(`tool${i}`, "unsigned");
      expect(statSync(file).size).toBeLessThanOrEqual(2000);
    }
    const { entries } = readActivity(file);
    expect(entries.length).toBeGreaterThan(10);
    expect(entries[entries.length - 1]!.tool).toBe("tool59");
    // What is left is the newest run, in order, with no gap, and the numbers carry on across the compactions.
    const first = Number(entries[0]!.tool.slice(4));
    expect(entries.map((e) => e.tool)).toEqual(Array.from({ length: 60 - first }, (_, i) => `tool${first + i}`));
    expect(entries.map((e) => e.seq)).toEqual(Array.from({ length: 60 - first }, (_, i) => first + i + 1));
  });

  test("the limit is in bytes: a name of multi-byte characters does not take the file past it", () => {
    const file = join(scratch(), "activity.jsonl");
    const limit = 4000;
    const journal = new ActivityJournal(file, { limit });
    for (let i = 0; i < 40; i++) {
      journal.record("日本語".repeat(30) + i, "unsigned");
      expect(statSync(file).size).toBeLessThanOrEqual(limit);
    }
    expect(readActivity(file).entries.length).toBeGreaterThan(2);
  });

  test("the default limit is 1 MiB", () => {
    expect(ACTIVITY_LIMIT_BYTES).toBe(1024 * 1024);
  });

  test("a tool name is cut to a sane length", () => {
    const file = join(scratch(), "a.jsonl");
    new ActivityJournal(file).record("x".repeat(500), "unsigned");
    expect(readActivity(file).entries[0]!.tool).toHaveLength(128);
  });

  test("never throws when the file cannot be written, and says why once", () => {
    const dir = scratch();
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "a file where a directory is needed");
    const said: string[] = [];
    const journal = new ActivityJournal(join(blocker, "activity.jsonl"), { onError: (m) => said.push(m) });
    expect(() => journal.record("bash", "unsigned")).not.toThrow();
    journal.record("bash", "unsigned");
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("cannot be written");
  });

  test("a reader resumes from a number, and is told when lines went before it read them: two calls in the same millisecond are not split", () => {
    const file = join(scratch(), "a.jsonl");
    const journal = new ActivityJournal(file, { now: () => 1_000_000 }); // a clock that does not move
    journal.record("a", "k");
    const first = readActivity(file);
    expect(first.entries.map((e) => e.tool)).toEqual(["a"]);
    journal.record("b", "k"); // the same millisecond as the one just read
    journal.record("c", "k");
    const next = readActivity(file, first.lastSeq);
    expect(next.entries.map((e) => e.tool)).toEqual(["b", "c"]);
    expect(next.gap).toBe(false);
    expect(readActivity(file, next.lastSeq).entries).toEqual([]);
    // the clock stepping back changes nothing
    const back = new ActivityJournal(file, { now: () => 5 });
    back.record("d", "k");
    expect(readActivity(file, next.lastSeq).entries.map((e) => e.tool)).toEqual(["d"]);
  });

  test("a reader that fell behind the ring sees a gap; one whose file was replaced by a newer count is told, and gets all of it", () => {
    const file = join(scratch(), "a.jsonl");
    const journal = new ActivityJournal(file, { limit: 1500 });
    journal.record("t0", "k");
    const seen = readActivity(file).lastSeq;
    for (let i = 1; i < 40; i++) journal.record(`t${i}`, "k");
    const behind = readActivity(file, seen);
    expect(behind.gap).toBe(true);
    expect(behind.entries[behind.entries.length - 1]!.tool).toBe("t39");
    // a file that is deleted and made again counts from 1: the reader's position is past its end
    rmSync(file);
    new ActivityJournal(file).record("fresh", "k");
    const reset = readActivity(file, 39);
    expect(reset.gap).toBe(true);
    expect(reset.entries.map((e) => e.tool)).toEqual(["fresh"]);
    expect(readActivity(join(scratch(), "missing.jsonl"), 5)).toEqual({ entries: [], lastSeq: 5, gap: false });
  });

  test("skips what is not an entry, and carries on counting from the last good line", () => {
    const file = join(scratch(), "a.jsonl");
    writeFileSync(
      file,
      [
        '{"seq":1,"ts":"2026-12-01T10:00:00.000Z","tool":"a","caller":"k"}',
        "garbage",
        '{"seq":2,"ts":"2026-12-01T11:00:00.000Z","tool":"b","caller":"k"}',
        '{"seq":3,"ts":1,"tool":"c","caller":"k"}',
        '{"ts":"2026-12-01T12:00:00.000Z","tool":"d","caller":"k"}',
        '{"seq":0,"ts":"2026-12-01T12:00:00.000Z","tool":"e","caller":"k"}',
        "",
      ].join("\n"),
    );
    expect(readActivity(file).entries.map((e) => e.tool)).toEqual(["a", "b"]);
    new ActivityJournal(file).record("f", "k");
    expect(readActivity(file).entries.map((e) => [e.seq, e.tool])).toEqual([[1, "a"], [2, "b"], [3, "f"]]);
  });

  test("several processes writing one file lose no line and take no number twice", async () => {
    const file = join(scratch(), "shared.jsonl");
    const script = `import { ActivityJournal } from ${JSON.stringify(join(ROOT, "src", "activity-journal.ts"))};
      const j = new ActivityJournal(process.argv[1], { limit: 60000 });
      for (let i = 0; i < 15; i++) j.record(process.argv[2] + "-" + i, "k");`;
    const procs = Array.from({ length: 4 }, (_, i) => Bun.spawn(["bun", "-e", script, file, `p${i}`], { stdout: "ignore", stderr: "pipe" }));
    for (const p of procs) expect(await p.exited).toBe(0);
    const { entries } = readActivity(file);
    expect(entries).toHaveLength(60);
    expect(entries.map((e) => e.seq)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(new Set(entries.map((e) => e.tool)).size).toBe(60);
  });

  test("two processes with a ring that keeps compacting lose no number either", async () => {
    const file = join(scratch(), "ring.jsonl");
    const script = `import { ActivityJournal } from ${JSON.stringify(join(ROOT, "src", "activity-journal.ts"))};
      const j = new ActivityJournal(process.argv[1], { limit: 1500 });
      for (let i = 0; i < 20; i++) j.record(process.argv[2] + "-" + i, "k");`;
    const procs = Array.from({ length: 3 }, (_, i) => Bun.spawn(["bun", "-e", script, file, `p${i}`], { stdout: "ignore", stderr: "pipe" }));
    for (const p of procs) expect(await p.exited).toBe(0);
    const { entries, lastSeq } = readActivity(file);
    expect(lastSeq).toBe(60); // every call took a number, in the order the lock gave them
    const seqs = entries.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[seqs.length - 1]).toBe(60);
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
