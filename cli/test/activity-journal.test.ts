// The activity journal: what a device writes down about each tool call it runs. Unit tests of the ring,
// and the real code-mcp behind a stub gateway for who is written down as the caller.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  test("writes one line per call with the time, the tool and the caller, and nothing else", () => {
    const file = join(scratch(), "state", "activity.jsonl");
    let now = Date.parse("2026-12-01T10:00:00.000Z");
    const journal = new ActivityJournal(file, { now: () => now });
    journal.record("write", "keyA");
    now += 1000;
    journal.record("bash", "unsigned");
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { ts: "2026-12-01T10:00:00.000Z", tool: "write", caller: "keyA" },
      { ts: "2026-12-01T10:00:01.000Z", tool: "bash", caller: "unsigned" },
    ]);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("is a ring: it never grows past the limit and the oldest lines go first", () => {
    const file = join(scratch(), "activity.jsonl");
    let n = 0;
    const journal = new ActivityJournal(file, { limit: 2000, now: () => Date.UTC(2026, 11, 1) + n++ * 1000 });
    for (let i = 0; i < 200; i++) {
      journal.record(`tool${i}`, "unsigned");
      expect(statSync(file).size).toBeLessThanOrEqual(2000);
    }
    const entries = readActivity(file);
    expect(entries.length).toBeGreaterThan(10);
    expect(entries[entries.length - 1]!.tool).toBe("tool199");
    // What is left is the newest run, in order, with no gap.
    const first = Number(entries[0]!.tool.slice(4));
    expect(entries.map((e) => e.tool)).toEqual(Array.from({ length: 200 - first }, (_, i) => `tool${first + i}`));
  });

  test("the default limit is 1 MiB", () => {
    expect(ACTIVITY_LIMIT_BYTES).toBe(1024 * 1024);
  });

  test("a tool name is cut to a sane length", () => {
    const file = join(scratch(), "a.jsonl");
    new ActivityJournal(file).record("x".repeat(500), "unsigned");
    expect(readActivity(file)[0]!.tool).toHaveLength(128);
  });

  test("never throws when the file cannot be written", () => {
    const dir = scratch();
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "a file where a directory is needed");
    expect(() => new ActivityJournal(join(blocker, "activity.jsonl")).record("bash", "unsigned")).not.toThrow();
  });

  test("readActivity gives the entries after a time, and skips what is not an entry", () => {
    const file = join(scratch(), "a.jsonl");
    writeFileSync(
      file,
      [
        '{"ts":"2026-12-01T10:00:00.000Z","tool":"a","caller":"k"}',
        "garbage",
        '{"ts":"2026-12-01T11:00:00.000Z","tool":"b","caller":"k"}',
        '{"ts":1,"tool":"c","caller":"k"}',
        '{"ts":"2026-12-01T12:00:00.000Z","tool":"d","caller":"unsigned"}',
        "",
      ].join("\n"),
    );
    expect(readActivity(file).map((e) => e.tool)).toEqual(["a", "b", "d"]);
    expect(readActivity(file, "2026-12-01T10:00:00.000Z").map((e) => e.tool)).toEqual(["b", "d"]);
    expect(readActivity(file, "2026-12-01T12:00:00.000Z")).toEqual([]);
    expect(readActivity(join(scratch(), "missing.jsonl"))).toEqual([]);
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

      const entries = readActivity(journal);
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
