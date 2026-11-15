// A held connection to the gateway, so the fleet agent is told when something
// happens instead of asking over and over.
//
// Asking costs the gateway a request each time, and a paused or idle fleet
// would be asked forever. A held socket costs almost nothing while it is quiet:
// the gateway says "a new snapshot is out", "the fleet was paused", "the place
// is free", and the agent acts then. Asking stays as the fallback - an old
// gateway has no such socket, and a socket can drop - so the agent always has
// a way to carry on.
//
// This class only keeps the socket and reports what it hears. It never throws
// into its caller, and it holds nothing open once it is stopped.

/** What the gateway can tell a member. */
export type FleetEvent =
  | { type: "hello"; paused: boolean; leaseHolder: string | null; leaseMs: number }
  | { type: "paused" }
  | { type: "resumed" }
  | { type: "head"; seq: number }
  | { type: "lease-free" }
  | { type: "bye"; reason: string };

/** The small part of a WebSocket that is used, so a test can stand in for it. */
export interface EventSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: any) => void): void;
}

export type EventSocketFactory = (url: string, headers: Record<string, string>) => EventSocket;

export interface FleetEventsOptions {
  gateway: string;
  fleet: string;
  deviceId: string;
  deviceToken: string;
  /** Called for each event the gateway sends. */
  onEvent: (event: FleetEvent) => void;
  /** Called when the socket comes up or goes down. */
  onStatus?: (connected: boolean) => void;
  /** Open the socket; the default is the runtime's WebSocket. */
  createSocket?: EventSocketFactory;
  /** How often to ping. The gateway answers "pong" and does not bill for either. */
  pingMs?: number;
  /** How long to wait for the "pong" before the socket is taken for dead. */
  pongMs?: number;
  /** The first wait before a reconnect, and the longest one. */
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** A connection that stayed up this long was healthy: the wait starts over. */
  stableMs?: number;
  /** How rarely to look again once the gateway said it has no events. */
  unsupportedRetryMs?: number;
  /** A number in [0, 1); injectable so a test can be exact. */
  random?: () => number;
}

const DEFAULT_PING_MS = 25_000;
const DEFAULT_PONG_MS = 20_000;
const DEFAULT_BACKOFF_MIN_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 60_000;
const DEFAULT_STABLE_MS = 30_000;
const DEFAULT_UNSUPPORTED_RETRY_MS = 10 * 60_000;

/** When events are flowing, a poll only covers an event that went missing. */
export const EVENTS_SAFETY_POLL_MS = 30_000;
/** A paused fleet with events: nothing is due, this only covers a missed event. */
export const PAUSED_SAFETY_MS = 10 * 60_000;
/** A paused fleet without events: how long to wait when the gateway gave no hint. */
export const PAUSED_RETRY_MS = 60_000;

/**
 * How long a space's loop sleeps between rounds.
 *
 *   paused,     events connected  -> until woken (safety timer, 10 minutes)
 *   paused,     no events         -> what the gateway asked (default 60 s)
 *   not paused, events connected  -> 30 seconds (events make polling needless)
 *   otherwise                     -> the normal poll interval
 *
 * "supported" is not needed to choose: a gateway without events never has a
 * connected socket, so it already falls through to the normal poll. A wake
 * (a file changed, an event came) ends any sleep early; that is not decided here.
 */
export function roundSleepMs(input: {
  paused: boolean;
  connected: boolean;
  supported?: boolean;
  retryAfterMs?: number;
  pollMs: number;
}): number {
  if (input.paused) {
    if (input.connected) return PAUSED_SAFETY_MS;
    const asked = input.retryAfterMs;
    if (typeof asked === "number" && Number.isFinite(asked) && asked > 0) {
      return Math.min(PAUSED_SAFETY_MS, Math.max(1_000, asked));
    }
    return PAUSED_RETRY_MS;
  }
  if (input.connected) return EVENTS_SAFETY_POLL_MS;
  return input.pollMs;
}

const KNOWN = new Set(["hello", "paused", "resumed", "head", "lease-free", "bye"]);

/** Read one text message. Anything that is not a known event is ignored. */
export function parseFleetEvent(text: string): FleetEvent | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.type !== "string" || !KNOWN.has(o.type)) return undefined;
  switch (o.type) {
    case "hello":
      return {
        type: "hello",
        paused: o.paused === true,
        leaseHolder: typeof o.leaseHolder === "string" ? o.leaseHolder : null,
        leaseMs: typeof o.leaseMs === "number" ? o.leaseMs : 0,
      };
    case "head":
      return typeof o.seq === "number" ? { type: "head", seq: o.seq } : undefined;
    case "bye":
      return { type: "bye", reason: typeof o.reason === "string" ? o.reason : "" };
    default:
      return { type: o.type } as FleetEvent;
  }
}

/** The status the gateway answered with, read from the runtime's error text. */
function statusOf(event: unknown): number | undefined {
  const text = String((event as { message?: unknown } | undefined)?.message ?? "");
  const m = /status code:?\s*(\d{3})/i.exec(text);
  return m ? Number(m[1]) : undefined;
}

function defaultFactory(url: string, headers: Record<string, string>): EventSocket {
  // Bun's WebSocket takes headers as an option; the DOM typings do not know it.
  return new (WebSocket as unknown as new (u: string, o: unknown) => EventSocket)(url, { headers });
}

export class FleetEvents {
  /** True while a socket is up. */
  connected = false;
  /** False once the gateway answered that it has no events (an old gateway). */
  supported = true;
  /** The last HTTP status a refused connection got, if any. */
  lastStatus?: number;

  private readonly o: FleetEventsOptions;
  private stopped = false;
  private started = false;
  private socket?: EventSocket;
  private reconnect?: ReturnType<typeof setTimeout>;
  private ping?: ReturnType<typeof setInterval>;
  private pong?: ReturnType<typeof setTimeout>;
  private backoff: number;
  private openedAt = 0;
  private sawBye = false;

  constructor(options: FleetEventsOptions) {
    this.o = options;
    this.backoff = options.backoffMinMs ?? DEFAULT_BACKOFF_MIN_MS;
  }

  /** Open the socket. It keeps itself up until stop(). */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.connect();
  }

  /** Close the socket and cancel everything pending. Safe to call twice. */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    this.connected = false;
    if (socket) {
      try {
        socket.close(1000, "stop");
      } catch {}
    }
  }

  private url(): string {
    const base = this.o.gateway.replace(/\/+$/, "").replace(/^http/i, "ws");
    return base + "/fleets/" + encodeURIComponent(this.o.fleet) + "/events";
  }

  private clearTimers(): void {
    if (this.reconnect) clearTimeout(this.reconnect);
    if (this.ping) clearInterval(this.ping);
    if (this.pong) clearTimeout(this.pong);
    this.reconnect = this.ping = this.pong = undefined;
  }

  private connect(): void {
    if (this.stopped) return;
    this.reconnect = undefined;
    let socket: EventSocket;
    try {
      socket = (this.o.createSocket ?? defaultFactory)(this.url(), {
        "x-prime-device": this.o.deviceId,
        "x-device-token": this.o.deviceToken,
      });
    } catch {
      this.down(undefined);
      return;
    }
    this.socket = socket;
    this.sawBye = false;
    // Both "error" and "close" fire for one failure, and a socket that was
    // replaced may still speak. Only the current socket is listened to, and
    // only until it has been dealt with once.
    let done = false;
    const finish = (status?: number): void => {
      if (done || this.socket !== socket) return;
      done = true;
      this.socket = undefined;
      try {
        socket.close();
      } catch {}
      this.down(status);
    };
    const live = (): boolean => !done && this.socket === socket && !this.stopped;
    const guard = (fn: () => void): void => {
      try {
        fn();
      } catch {}
    };

    // A connection that never answers is given the same time as a ping.
    this.pong = setTimeout(() => this.dead(socket), this.o.pongMs ?? DEFAULT_PONG_MS);
    (this.pong as { unref?: () => void }).unref?.();

    socket.addEventListener("open", () => {
      guard(() => {
        if (!live()) return;
        if (this.pong) clearTimeout(this.pong);
        this.pong = undefined;
        this.openedAt = Date.now();
        this.connected = true;
        this.supported = true;
        this.lastStatus = undefined;
        this.armPing(socket);
        this.o.onStatus?.(true);
      });
    });
    socket.addEventListener("message", (event) => {
      guard(() => {
        if (!live()) return;
        const data = event?.data;
        if (typeof data !== "string") return;
        // Any word from the gateway shows the socket is alive.
        if (this.pong) {
          clearTimeout(this.pong);
          this.pong = undefined;
        }
        if (data === "pong") return;
        const parsed = parseFleetEvent(data);
        if (!parsed) return;
        if (parsed.type === "bye") this.sawBye = true;
        try {
          this.o.onEvent(parsed);
        } catch {}
      });
    });
    socket.addEventListener("error", (event) => guard(() => finish(statusOf(event))));
    socket.addEventListener("close", (event) => guard(() => finish(statusOf(event))));
  }

  private armPing(socket: EventSocket): void {
    const pingMs = this.o.pingMs ?? DEFAULT_PING_MS;
    const pongMs = this.o.pongMs ?? DEFAULT_PONG_MS;
    this.ping = setInterval(() => {
      if (this.pong || this.socket !== socket) return;
      try {
        socket.send("ping");
      } catch {
        // A socket that cannot be written to is as good as dead.
        this.dead(socket);
        return;
      }
      this.pong = setTimeout(() => this.dead(socket), pongMs);
      (this.pong as { unref?: () => void }).unref?.();
    }, pingMs);
    (this.ping as { unref?: () => void }).unref?.();
  }

  /** No answer in time: drop the socket and start again, without waiting for a close that may never come. */
  private dead(socket: EventSocket): void {
    if (this.socket !== socket || this.stopped) return;
    this.socket = undefined;
    try {
      socket.close();
    } catch {}
    this.down(undefined);
  }

  /** A socket is gone: decide when to try again. */
  private down(status: number | undefined): void {
    if (this.stopped) return;
    const wasConnected = this.connected;
    const upFor = wasConnected ? Date.now() - this.openedAt : 0;
    this.connected = false;
    this.clearTimers();
    if (status !== undefined) this.lastStatus = status;
    if (wasConnected) {
      try {
        this.o.onStatus?.(false);
      } catch {}
    }
    const min = this.o.backoffMinMs ?? DEFAULT_BACKOFF_MIN_MS;
    const max = this.o.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    let wait: number;
    if (status === 404 || status === 426 || status === 501) {
      // An old gateway. Asking again soon would only waste its time; but it
      // may be upgraded, so the question is asked again now and then.
      this.supported = false;
      wait = this.o.unsupportedRetryMs ?? DEFAULT_UNSUPPORTED_RETRY_MS;
    } else {
      // A connection that held for a while was healthy, so the next wait is
      // short again. One the gateway ended with "bye" is not: the same member
      // may be connecting twice, and answering at once would trade the socket
      // back and forth.
      if (upFor > (this.o.stableMs ?? DEFAULT_STABLE_MS) && !this.sawBye) this.backoff = min;
      wait = this.backoff;
      // Refused or out of budget: it will not change in a second.
      if (status === 401 || status === 403 || status === 402) wait = Math.max(wait, max);
      this.backoff = Math.min(max, this.backoff * 2);
    }
    // Jitter, so many members that lost the gateway together do not return together.
    const rnd = (this.o.random ?? Math.random)();
    wait = Math.max(1, Math.round(wait * (0.8 + 0.4 * rnd)));
    this.reconnect = setTimeout(() => this.connect(), wait);
    (this.reconnect as { unref?: () => void }).unref?.();
  }
}
