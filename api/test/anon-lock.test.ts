// A lock on an anonymous device is held against the address the wrong codes came from, never against
// the device: whoever knows a member's device id must not be able to shut the member out.
import { describe, expect, mock, test } from "bun:test";

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
const { RegistryDO } = await import("../src/registry-do");
const { anonLockKey } = await import("../src/config");

function storage() {
  const data = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return structuredClone(data.get(key)) as T | undefined;
    },
    async put(key: string, value: unknown) {
      data.set(key, structuredClone(value));
    },
    async delete(key: string) {
      return data.delete(key);
    },
    async list<T>(): Promise<Map<string, T>> {
      return new Map<string, T>();
    },
  };
}

async function registry() {
  let ready: Promise<unknown> = Promise.resolve();
  const ctx = {
    storage: storage(),
    blockConcurrencyWhile(fn: () => Promise<unknown>) {
      ready = fn();
      return ready;
    },
  };
  const reg = new RegistryDO(ctx as never, { TOKEN_PEPPER: "p".repeat(40), ANON_AUTH_MAX_FAILURES: "3" } as never);
  await ready;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await reg.fetch(
      new Request("https://registry" + path, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return (await res.json()) as Record<string, any>;
  };
  const device = async () => (await call("POST", "/anon/create", { ip: "192.0.2.1", exempt: true })).deviceId as string;
  const fail = (id: string, ip: string) => call("POST", "/anon/fail?id=" + id + "&ip=" + encodeURIComponent(ip));
  return { call, device, fail };
}

describe("the lock on an anonymous device", () => {
  test("wrong codes from one address lock that address and no other", async () => {
    const { call, device, fail } = await registry();
    const id = await device();
    expect((await fail(id, "198.51.100.7")).locked).toBe(false);
    expect((await fail(id, "198.51.100.7")).locked).toBe(false);
    expect((await fail(id, "198.51.100.7")).locked).toBe(true);
    const map = await call("GET", "/map");
    expect(map.locked).toEqual([anonLockKey(id, "198.51.100.7")]);
    // The member's own address is not in it.
    expect(map.locked).not.toContain(anonLockKey(id, "203.0.113.5"));
  });

  test("any number of addresses that each stay under the limit lock nothing", async () => {
    const { call, device, fail } = await registry();
    const id = await device();
    for (let n = 0; n < 40; n++) {
      for (let i = 0; i < 2; i++) expect((await fail(id, "198.51.100." + n)).locked).toBe(false);
    }
    expect((await call("GET", "/map")).locked).toEqual([]);
  });

  test("a stranger's lock on one device is not a lock on another", async () => {
    const { call, device, fail } = await registry();
    const a = await device();
    const b = await device();
    for (let i = 0; i < 3; i++) await fail(a, "198.51.100.7");
    expect((await call("GET", "/map")).locked).toEqual([anonLockKey(a, "198.51.100.7")]);
    expect((await fail(b, "198.51.100.7")).locked).toBe(false);
  });

  test("an IPv6 address is held by its /64, as a block is", async () => {
    const { call, device, fail } = await registry();
    const id = await device();
    await fail(id, "2001:db8:1:2::1");
    await fail(id, "2001:db8:1:2:ffff::9");
    expect((await fail(id, "2001:db8:1:2:abcd::1")).locked).toBe(true);
    expect((await call("GET", "/map")).locked).toEqual([anonLockKey(id, "2001:db8:1:2::5")]);
  });

  test("the admin list says a device is locked while any address is", async () => {
    const { call, device, fail } = await registry();
    const id = await device();
    expect((await call("GET", "/anon/list")).devices[0].locked).toBe(false);
    for (let i = 0; i < 3; i++) await fail(id, "198.51.100.7");
    expect((await call("GET", "/anon/list")).devices[0].locked).toBe(true);
  });

  test("a device the registry does not know is never locked", async () => {
    const { fail } = await registry();
    for (let i = 0; i < 5; i++) expect((await fail("anon-0000000000000000", "198.51.100.7")).locked).toBe(false);
  });
});
