import { expect, mock, test } from "bun:test";

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
const { DeviceDO } = await import("../src/device-do");

for (const method of ["webSocketClose", "webSocketError"] as const) {
  test(`${method} fails old requests before asynchronous registry work`, async () => {
    const oldSocket = {};
    const replacement = {};
    const events: string[] = [];
    let completeRegistry!: () => void;
    const registry = new Promise<void>((resolve) => { completeRegistry = resolve; });
    const fake = {
      ws: oldSocket,
      failDevice: () => events.push("fail"),
      unregisterFromRegistry: () => { events.push("unregister"); return registry; },
    };
    const callback = DeviceDO.prototype[method] as (...args: unknown[]) => Promise<void>;
    const pending = callback.call(fake, oldSocket, 1000, "", true);
    expect(events).toEqual(["fail", "unregister"]);
    expect(fake.ws).toBeNull();
    // A reconnect can install fresh requests while the registry await yields.
    fake.ws = replacement;
    completeRegistry();
    await pending;
    expect(fake.ws).toBe(replacement);
    expect(events).toEqual(["fail", "unregister"]);
    await callback.call(fake, oldSocket, 1000, "", true);
    expect(events).toEqual(["fail", "unregister"]);
  });
}
