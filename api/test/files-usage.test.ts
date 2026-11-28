// The temporary-file object counts what it serves and the storage rows it uses, like the others.
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
const { FilesDO } = await import("../src/files-do");

test("a reservation is a request served, and the rows it wrote and read are counted", async () => {
  const data = new Map<string, unknown>();
  const usage: Array<Record<string, number>> = [];
  const storage = {
    async get(key: string) {
      return structuredClone(data.get(key));
    },
    async put(key: string, value: unknown) {
      data.set(key, structuredClone(value));
    },
    async delete(key: string) {
      return data.delete(key);
    },
    async setAlarm() {},
    async deleteAlarm() {},
  };
  let ready: Promise<unknown> = Promise.resolve();
  const ctx = {
    storage,
    blockConcurrencyWhile(fn: () => Promise<unknown>) {
      ready = fn();
      return ready;
    },
  };
  const env = {
    REGISTRY: {
      idFromName: () => "global",
      get: () => ({
        fetch: async (input: string | Request, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input.url;
          if (new URL(url).pathname === "/usage-add") usage.push(JSON.parse(String(init?.body ?? "{}")));
          return Response.json({ ok: true });
        },
      }),
    },
  };
  const files = new FilesDO(ctx as never, env as never);
  await ready;
  const res = await files.fetch(
    new Request("https://files/reserve", {
      method: "POST",
      body: JSON.stringify({ deviceId: "dev-1", name: "a.txt", size: 10, expiresAt: Date.now() + 60_000 }),
    }),
  );
  expect(res.status).toBeLessThan(300);
  (files as unknown as { meter: { flush: () => void } }).meter.flush();
  const sum = (k: string) => usage.reduce((n, u) => n + (u[k] ?? 0), 0);
  expect(sum("doRequests")).toBe(1);
  expect(sum("doRowsWritten")).toBeGreaterThanOrEqual(2); // the record, and the alarm that reaps it
  expect(sum("doRowsRead")).toBeGreaterThanOrEqual(1); // the records read when the object was woken
});

test("an object that only wakes for its alarm sends the request and the rows of it, without waiting for a request to carry them", async () => {
  const data = new Map<string, unknown>();
  const usage: Array<Record<string, number>> = [];
  const storage = {
    async get(key: string) {
      return structuredClone(data.get(key));
    },
    async put(key: string, value: unknown) {
      data.set(key, structuredClone(value));
    },
    async delete(key: string) {
      return data.delete(key);
    },
    async list() {
      return new Map<string, unknown>();
    },
    async setAlarm() {},
    async deleteAlarm() {},
  };
  let ready: Promise<unknown> = Promise.resolve();
  const ctx = {
    storage,
    blockConcurrencyWhile(fn: () => Promise<unknown>) {
      ready = fn();
      return ready;
    },
  };
  const env = {
    REGISTRY: {
      idFromName: () => "global",
      get: () => ({
        fetch: async (input: string | Request, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input.url;
          if (new URL(url).pathname === "/usage-add") usage.push(JSON.parse(String(init?.body ?? "{}")));
          return Response.json({ ok: true });
        },
      }),
    },
  };
  const files = new FilesDO(ctx as never, env as never);
  await ready;
  // The object has been quiet for more than a minute (hourly alarms are the only thing it does).
  (files as unknown as { meter: { at: number } }).meter.at = Date.now() - 3_600_000;
  await files.alarm();
  expect(usage).toHaveLength(1);
  expect(usage[0]!.doRequests).toBe(1);
  expect(usage[0]!.doRowsRead).toBeGreaterThanOrEqual(1);
});
