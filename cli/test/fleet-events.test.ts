// The held connection to the gateway, tested against a fake gateway.
//
// No network beyond localhost: Bun.serve stands in for the gateway, so each
// test can make it speak, stay silent, refuse or hang up.

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  EVENTS_SAFETY_POLL_MS,
  FAILING_MAX_MS,
  FleetEvents,
  PAUSED_RETRY_MS,
  PAUSED_SAFETY_MS,
  parseFleetEvent,
  roundSleepMs,
  type FleetEvent,
  type FleetEventsOptions,
} from "../src/fleet-events.ts";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

interface Fake {
  url: string;
  /** How many upgrades were attempted. */
  attempts: () => number;
  /** The text frames the clients sent. */
  received: string[];
  headers: Array<Record<string, string>>;
  paths: string[];
  sockets: any[];
  stop: () => void;
}

/** A fake gateway; "answer" decides what happens to each connection. */
function fake(opts: {
  refuse?: number;
  onOpen?: (ws: any, n: number) => void;
  onMessage?: (ws: any, text: string) => void;
}): Fake {
  let attempts = 0;
  const f: Fake = { url: "", attempts: () => attempts, received: [], headers: [], paths: [], sockets: [], stop: () => {} };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      attempts++;
      f.paths.push(new URL(req.url).pathname);
      f.headers.push({
        device: req.headers.get("x-prime-device") ?? "",
        token: req.headers.get("x-device-token") ?? "",
      });
      if (opts.refuse) return new Response(JSON.stringify({ error: "no" }), { status: opts.refuse });
      if (srv.upgrade(req, { data: { n: attempts } } as never)) return undefined;
      return new Response("expected a websocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        f.sockets.push(ws);
        opts.onOpen?.(ws, (ws.data as unknown as { n: number }).n);
      },
      message(ws, message) {
        const text = String(message);
        f.received.push(text);
        opts.onMessage?.(ws, text);
      },
    },
  });
  f.url = "http://127.0.0.1:" + server.port;
  f.stop = () => server.stop(true);
  return f;
}

const live: Array<{ stop: () => void }> = [];
afterEach(() => {
  for (const x of live.splice(0)) x.stop();
});

function client(gateway: string, extra: Partial<FleetEventsOptions> = {}): { c: FleetEvents; events: FleetEvent[]; status: boolean[] } {
  const events: FleetEvent[] = [];
  const status: boolean[] = [];
  const c = new FleetEvents({
    gateway,
    fleet: "f 1",
    deviceId: "dev-1",
    deviceToken: "tok-1",
    onEvent: (e) => events.push(e),
    onStatus: (up) => status.push(up),
    random: () => 0.5,
    ...extra,
  });
  live.push(c);
  return { c, events, status };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

describe("the lease frame", () => {
  test("is read as the new length of a place, and one that says nothing usable is ignored", async () => {
    const { parseFleetEvent } = await import("../src/fleet-events");
    expect(parseFleetEvent(JSON.stringify({ type: "lease", leaseMs: 90_000 }))).toEqual({ type: "lease", leaseMs: 90_000 });
    for (const bad of [{ type: "lease" }, { type: "lease", leaseMs: 0 }, { type: "lease", leaseMs: -5 }, { type: "lease", leaseMs: "90" }, { type: "lease", leaseMs: null }]) {
      expect(parseFleetEvent(JSON.stringify(bad))).toBeUndefined();
    }
  });
});

describe("events", () => {
  test("are parsed and delivered, with the device headers on the right path", async () => {
    const gw = fake({
      onOpen: (ws) => {
        ws.send(JSON.stringify({ type: "hello", paused: true, leaseHolder: "a", leaseMs: 15000 }));
        ws.send(JSON.stringify({ type: "head", seq: 7 }));
        ws.send("not json");
        ws.send(JSON.stringify({ type: "something-new" }));
        ws.send(JSON.stringify({ type: "resumed" }));
        ws.send(JSON.stringify({ type: "lease-free" }));
      },
    });
    try {
      const { c, events, status } = client(gw.url);
      c.start();
      await until(() => events.length >= 4);
      expect(events).toEqual([
        { type: "hello", paused: true, leaseHolder: "a", leaseMs: 15000 },
        { type: "head", seq: 7 },
        { type: "resumed" },
        { type: "lease-free" },
      ]);
      expect(c.connected).toBe(true);
      expect(c.supported).toBe(true);
      expect(status).toEqual([true]);
      expect(gw.paths[0]).toBe("/fleets/f%201/events");
      expect(gw.headers[0]).toEqual({ device: "dev-1", token: "tok-1" });
    } finally {
      gw.stop();
    }
  });

  test("a callback that throws does not break the socket", async () => {
    const gw = fake({
      onOpen: (ws) => {
        ws.send(JSON.stringify({ type: "paused" }));
        ws.send(JSON.stringify({ type: "resumed" }));
      },
    });
    try {
      const seen: string[] = [];
      const c = new FleetEvents({
        gateway: gw.url,
        fleet: "f",
        deviceId: "d",
        deviceToken: "t",
        onEvent: (e) => {
          seen.push(e.type);
          throw new Error("boom");
        },
      });
      live.push(c);
      c.start();
      await until(() => seen.length >= 2);
      expect(c.connected).toBe(true);
    } finally {
      gw.stop();
    }
  });

  test("ping is answered by pong and keeps the socket up", async () => {
    const gw = fake({ onMessage: (ws, text) => text === "ping" && ws.send("pong") });
    try {
      const { c, events } = client(gw.url, { pingMs: 30, pongMs: 100 });
      c.start();
      await until(() => gw.received.filter((t) => t === "ping").length >= 4);
      expect(c.connected).toBe(true);
      expect(gw.attempts()).toBe(1);
      // Nothing but pings is ever sent.
      expect(new Set(gw.received)).toEqual(new Set(["ping"]));
      // A pong is not an event.
      expect(events).toEqual([]);
    } finally {
      gw.stop();
    }
  });

  test("a socket that never answers the ping is reconnected", async () => {
    const gw = fake({});
    try {
      const { c, status } = client(gw.url, { pingMs: 30, pongMs: 40, backoffMinMs: 10, backoffMaxMs: 40 });
      c.start();
      await until(() => gw.attempts() >= 2);
      expect(status[0]).toBe(true);
      expect(status).toContain(false);
    } finally {
      gw.stop();
    }
  });

  test("the wait between reconnects grows and does not spin", async () => {
    // The gateway hangs up at once, every time.
    const gw = fake({ onOpen: (ws) => ws.close() });
    try {
      const { c } = client(gw.url, { backoffMinMs: 50, backoffMaxMs: 200 });
      c.start();
      await Bun.sleep(700);
      // Waits of 50, 100, 200, 200 ...: about six tries in 700 ms, never dozens.
      expect(gw.attempts()).toBeGreaterThanOrEqual(3);
      expect(gw.attempts()).toBeLessThanOrEqual(8);
    } finally {
      gw.stop();
    }
  });

  test("a 404 on the upgrade means no events, and it is not retried soon", async () => {
    const gw = fake({ refuse: 404 });
    try {
      const { c, status } = client(gw.url, { backoffMinMs: 10, backoffMaxMs: 20, unsupportedRetryMs: 60_000 });
      c.start();
      await until(() => !c.supported);
      await Bun.sleep(300);
      expect(gw.attempts()).toBe(1);
      expect(c.connected).toBe(false);
      expect(c.lastStatus).toBe(404);
      expect(status).toEqual([]);
    } finally {
      gw.stop();
    }
  });

  test("426 and 501 mean no events either", async () => {
    for (const code of [426, 501]) {
      const gw = fake({ refuse: code });
      try {
        const { c } = client(gw.url, { unsupportedRetryMs: 60_000 });
        c.start();
        await until(() => !c.supported);
        expect(c.lastStatus).toBe(code);
      } finally {
        gw.stop();
      }
    }
  });

  test("an unsupported gateway is asked again after the long wait", async () => {
    const gw = fake({ refuse: 404 });
    try {
      const { c } = client(gw.url, { unsupportedRetryMs: 80 });
      c.start();
      await until(() => gw.attempts() >= 2);
      expect(c.supported).toBe(false);
    } finally {
      gw.stop();
    }
  });

  test("a refusal (403) is still supported, but is retried slowly", async () => {
    const gw = fake({ refuse: 403 });
    try {
      const { c } = client(gw.url, { backoffMinMs: 10, backoffMaxMs: 60_000 });
      c.start();
      await until(() => c.lastStatus === 403);
      await Bun.sleep(200);
      expect(c.supported).toBe(true);
      expect(gw.attempts()).toBe(1);
    } finally {
      gw.stop();
    }
  });

  test("a temporary failure (503) is retried with the backoff", async () => {
    const gw = fake({ refuse: 503 });
    try {
      const { c } = client(gw.url, { backoffMinMs: 20, backoffMaxMs: 80 });
      c.start();
      await until(() => gw.attempts() >= 3);
      expect(c.supported).toBe(true);
    } finally {
      gw.stop();
    }
  });

  test("bye, then the close, reconnects", async () => {
    const gw = fake({
      onOpen: (ws, n) => {
        if (n === 1) {
          ws.send(JSON.stringify({ type: "bye", reason: "replaced" }));
          setTimeout(() => ws.close(), 10);
        } else {
          ws.send(JSON.stringify({ type: "head", seq: 2 }));
        }
      },
    });
    try {
      const { c, events, status } = client(gw.url, { backoffMinMs: 20, backoffMaxMs: 40 });
      c.start();
      await until(() => events.some((e) => e.type === "head"));
      expect(events[0]).toEqual({ type: "bye", reason: "replaced" });
      expect(gw.attempts()).toBe(2);
      expect(status).toEqual([true, false, true]);
      expect(c.connected).toBe(true);
    } finally {
      gw.stop();
    }
  });

  test("a gateway that is down is retried, and comes back", async () => {
    const gw = fake({});
    const port = Number(new URL(gw.url).port);
    gw.stop();
    const { c } = client("http://127.0.0.1:" + port, { backoffMinMs: 20, backoffMaxMs: 40 });
    c.start();
    await Bun.sleep(100);
    expect(c.connected).toBe(false);
    expect(c.supported).toBe(true);
    // Bring a gateway up on the same port.
    const server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
      websocket: { message() {} },
    });
    try {
      await until(() => c.connected);
    } finally {
      c.stop();
      server.stop(true);
    }
  });

  test("stop() closes the socket and nothing reconnects", async () => {
    const gw = fake({ onOpen: (ws) => ws.send(JSON.stringify({ type: "paused" })) });
    try {
      const { c, events, status } = client(gw.url, { pingMs: 20, backoffMinMs: 10 });
      c.start();
      await until(() => c.connected);
      c.stop();
      expect(c.connected).toBe(false);
      const before = gw.attempts();
      const pings = gw.received.length;
      await Bun.sleep(250);
      expect(gw.attempts()).toBe(before);
      expect(gw.received.length).toBe(pings);
      // Stopping is not "the gateway went away": no callback for it.
      expect(status).toEqual([true]);
      expect(events.length).toBe(1);
      c.stop();
      c.start();
      await Bun.sleep(50);
      expect(gw.attempts()).toBe(before);
    } finally {
      gw.stop();
    }
  });

  test("stop() cancels a pending reconnect", async () => {
    const gw = fake({ refuse: 503 });
    try {
      const { c } = client(gw.url, { backoffMinMs: 60, backoffMaxMs: 60 });
      c.start();
      await until(() => gw.attempts() === 1);
      c.stop();
      await Bun.sleep(250);
      expect(gw.attempts()).toBe(1);
    } finally {
      gw.stop();
    }
  });

  test("a process with a stopped client exits by itself", async () => {
    const script = [
      'import { FleetEvents } from ' + JSON.stringify(join(import.meta.dir, "../src/fleet-events.ts")) + ';',
      // Nothing listens on this port, so it is always in the "wait to reconnect" state.
      'const c = new FleetEvents({ gateway: "http://127.0.0.1:1", fleet: "f", deviceId: "d", deviceToken: "t", onEvent() {} });',
      "c.start();",
      "await Bun.sleep(100);",
      "c.stop();",
    ].join("\n");
    const proc = Bun.spawn({ cmd: [process.execPath, "-e", script], stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), 8000);
    const code = await proc.exited;
    clearTimeout(timer);
    expect(code).toBe(0);
  });

  test("a factory that throws does not throw into the caller", async () => {
    let tries = 0;
    const { c } = client("http://x", {
      backoffMinMs: 10,
      backoffMaxMs: 20,
      createSocket: () => {
        tries++;
        throw new Error("no sockets here");
      },
    });
    expect(() => c.start()).not.toThrow();
    await until(() => tries >= 2);
    expect(c.connected).toBe(false);
  });

  test("an injected socket works", async () => {
    const handlers: Record<string, (e: any) => void> = {};
    const sent: string[] = [];
    let url = "";
    const { c, events } = client("https://gw.example/", {
      createSocket: (u) => {
        url = u;
        return {
          send: (d) => sent.push(d),
          close: () => {},
          addEventListener: (t, fn) => {
            handlers[t] = fn;
          },
        };
      },
    });
    c.start();
    handlers.open!({});
    handlers.message!({ data: JSON.stringify({ type: "head", seq: 3 }) });
    expect(url).toBe("wss://gw.example/fleets/f%201/events");
    expect(c.connected).toBe(true);
    expect(events).toEqual([{ type: "head", seq: 3 }]);
  });
});

describe("parseFleetEvent", () => {
  test("reads known events and ignores the rest", () => {
    expect(parseFleetEvent('{"type":"head","seq":4}')).toEqual({ type: "head", seq: 4 });
    expect(parseFleetEvent('{"type":"head"}')).toBeUndefined();
    expect(parseFleetEvent('{"type":"bye"}')).toEqual({ type: "bye", reason: "" });
    expect(parseFleetEvent('{"type":"hello","paused":false,"leaseHolder":null,"leaseMs":9}')).toEqual({
      type: "hello",
      paused: false,
      leaseHolder: null,
      leaseMs: 9,
    });
    expect(parseFleetEvent("pong")).toBeUndefined();
    expect(parseFleetEvent("[]")).toBeUndefined();
    expect(parseFleetEvent('{"type":"nope"}')).toBeUndefined();
  });
});

describe("roundSleepMs", () => {
  const poll = 1500;
  test("paused with events: until woken (safety timer)", () => {
    expect(roundSleepMs({ paused: true, connected: true, supported: true, pollMs: poll })).toBe(PAUSED_SAFETY_MS);
    expect(roundSleepMs({ paused: true, connected: true, supported: true, retryAfterMs: 5000, pollMs: poll })).toBe(PAUSED_SAFETY_MS);
    expect(PAUSED_SAFETY_MS).toBe(10 * 60_000);
  });
  test("paused without events: what the gateway asked, else a minute", () => {
    expect(roundSleepMs({ paused: true, connected: false, supported: true, retryAfterMs: 45_000, pollMs: poll })).toBe(45_000);
    expect(roundSleepMs({ paused: true, connected: false, supported: false, pollMs: poll })).toBe(PAUSED_RETRY_MS);
    expect(PAUSED_RETRY_MS).toBe(60_000);
    expect(roundSleepMs({ paused: true, connected: false, supported: true, retryAfterMs: 0, pollMs: poll })).toBe(PAUSED_RETRY_MS);
    expect(roundSleepMs({ paused: true, connected: false, supported: true, retryAfterMs: Number.NaN, pollMs: poll })).toBe(PAUSED_RETRY_MS);
    // Neither absurdly short nor longer than the safety timer.
    expect(roundSleepMs({ paused: true, connected: false, retryAfterMs: 10, pollMs: poll })).toBe(1000);
    expect(roundSleepMs({ paused: true, connected: false, retryAfterMs: 99 * 60_000, pollMs: poll })).toBe(PAUSED_SAFETY_MS);
  });
  test("running with events: a safety poll every 30 s", () => {
    expect(roundSleepMs({ paused: false, connected: true, supported: true, pollMs: poll })).toBe(EVENTS_SAFETY_POLL_MS);
    expect(EVENTS_SAFETY_POLL_MS).toBe(30_000);
  });
  test("running without events: the normal poll, unchanged", () => {
    expect(roundSleepMs({ paused: false, connected: false, supported: true, pollMs: poll })).toBe(poll);
    expect(roundSleepMs({ paused: false, connected: false, supported: false, pollMs: 250 })).toBe(250);
    // A retryAfter left over from an earlier pause means nothing now.
    expect(roundSleepMs({ paused: false, connected: false, supported: true, retryAfterMs: 60_000, pollMs: poll })).toBe(poll);
  });
  test("a round that keeps failing waits longer each time, up to five minutes", () => {
    // An answer the agent does not understand must not become a request every
    // second and a half for as long as the agent runs.
    expect(roundSleepMs({ paused: false, connected: false, pollMs: poll, failures: 0 })).toBe(poll);
    expect(roundSleepMs({ paused: false, connected: false, pollMs: poll, failures: 1 })).toBe(3_000);
    expect(roundSleepMs({ paused: false, connected: false, pollMs: poll, failures: 3 })).toBe(12_000);
    expect(roundSleepMs({ paused: false, connected: false, pollMs: poll, failures: 30 })).toBe(FAILING_MAX_MS);
    expect(FAILING_MAX_MS).toBe(5 * 60_000);
    // Never shorter than what the agent would wait anyway.
    expect(roundSleepMs({ paused: false, connected: true, pollMs: poll, failures: 1 })).toBe(EVENTS_SAFETY_POLL_MS);
    // A pause is not a failure: it keeps its own wait.
    expect(roundSleepMs({ paused: true, connected: false, pollMs: poll, failures: 4 })).toBe(PAUSED_RETRY_MS);
  });
});
