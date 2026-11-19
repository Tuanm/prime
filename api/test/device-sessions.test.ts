// The MCP sessions a device's object has seen, read without changing anything.
import { expect, mock, test } from "bun:test";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
const { DeviceDO } = await import("../src/device-do");

function deviceObject(initial: Record<string, unknown>) {
  const data = new Map<string, unknown>(Object.entries(initial));
  const writes: string[] = [];
  const storage = {
    async get(key: string) { return data.get(key); },
    async put(key: string) { writes.push("put " + key); },
    async delete(key: string | string[]) { writes.push("delete " + String(key)); return true; },
    async list(opts: { prefix?: string; limit?: number } = {}) {
      const out = new Map<string, unknown>();
      for (const [k, v] of [...data].sort(([a], [b]) => a.localeCompare(b))) {
        if (opts.prefix && !k.startsWith(opts.prefix)) continue;
        out.set(k, v);
        if (opts.limit && out.size >= opts.limit) break;
      }
      return out;
    },
    async setAlarm() {},
  };
  const ctx = { storage, getWebSockets: () => [] };
  const env = { REGISTRY: { idFromName: () => "global", get: () => ({ fetch: async () => new Response("{}") }) } };
  return { obj: new DeviceDO(ctx as never, env as never), writes };
}

const WEEK = 7 * 86_400_000;

test("GET /sessions lists every sess: entry, oldest first, and writes nothing", async () => {
  const now = Date.now();
  const { obj, writes } = deviceObject({
    "sess:late": { name: "claude-code", at: now - 1_000 },
    "sess:early": { name: "cursor", at: now - 60_000 },
    // Older than the week pruneSessions keeps: a read must still show it, not drop it.
    "sess:stale": { name: "old-client", at: now - 2 * WEEK },
    "client-salt": "not-a-session",
    "ticket:abc": now + 60_000,
  });
  const res = await obj.fetch(new Request("https://device/sessions", { headers: { "x-device-id": "dev-1" } }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { sessions: Array<{ sid: string; name: string; at: number }> };
  expect(body.sessions.map((s) => s.sid)).toEqual(["stale", "early", "late"]);
  expect(body.sessions[2]).toEqual({ sid: "late", name: "claude-code", at: now - 1_000 });
  expect(JSON.stringify(body).includes("not-a-session")).toBe(false);
  expect(writes).toEqual([]);
});

test("a malformed sess: entry is listed as it is, not skipped", async () => {
  const { obj } = deviceObject({ "sess:odd": "just a string" });
  const res = await obj.fetch(new Request("https://device/sessions", { headers: { "x-device-id": "dev-1" } }));
  const body = (await res.json()) as { sessions: Array<{ sid: string; name: unknown; at: unknown }> };
  expect(body.sessions).toEqual([{ sid: "odd", name: null, at: null, raw: "just a string" }]);
});

test("/sessions answers only GET", async () => {
  const { obj, writes } = deviceObject({ "sess:a": { name: "x", at: 1 } });
  const res = await obj.fetch(new Request("https://device/sessions", { method: "POST", headers: { "x-device-id": "dev-1" } }));
  expect(res.status).not.toBe(200);
  expect(writes).toEqual([]);
});
