// End to end, against a real local worker: the socket a fleet member listens on.
//
// The unit tests drive the fleet object with stand-in sockets. What they cannot
// show is the part the runtime owns: the upgrade through the Worker, a socket
// that survives the object going to sleep, the alarm that ends a lease, and a
// ping answered without waking anything. This runs those for real.

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { port } from "./ports";

const ROOT = import.meta.dir + "/..";
const WRANGLER = ROOT + "/node_modules/.bin/wrangler";
const PORT = port(8842);
// FLEET_E2E_BASE points the test at a deployed gateway instead of a local worker;
// FLEET_E2E_TOKEN is that gateway's operator token, for the calls only it may make.
const EXTERNAL = (process.env.FLEET_E2E_BASE ?? "").replace(/\/+$/, "");
const OPERATOR = process.env.FLEET_E2E_TOKEN ?? "";
const BASE = EXTERNAL || "http://127.0.0.1:" + PORT;
const WS = BASE.replace(/^http/i, "ws");

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, cond: unknown, detail = ""): void {
  if (cond) {
    pass++;
    console.log("PASS " + name);
  } else {
    fail++;
    failures.push(name + (detail ? ": " + detail : ""));
    console.log("FAIL " + name + (detail ? ": " + detail : ""));
  }
}

async function startWorker(): Promise<{ stop: () => void }> {
  if (EXTERNAL) return { stop: () => {} };
  rmSync(ROOT + "/.wrangler/state-" + PORT, { recursive: true, force: true });
  const proc = spawn(
    "node",
    [WRANGLER, "dev", "--local", "-c", ROOT + "/wrangler.dev.toml", "--port", String(PORT), "--ip", "127.0.0.1",
      "--persist-to", ROOT + "/.wrangler/state-" + PORT, "--var", "RATE_LIMIT_MAX:100000", "--var", "FLEET_LEASE_MIN_MS:1000"],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  const log: string[] = [];
  const keep = (c: Buffer) => {
    log.push(c.toString());
    while (log.length > 60) log.shift();
  };
  proc.stdout?.on("data", keep);
  proc.stderr?.on("data", keep);
  for (let i = 0; i < 1200; i++) {
    try {
      const r = await fetch(BASE + "/admin/api/devices");
      if (r.status < 500) return { stop: () => proc.kill() };
    } catch {}
    await Bun.sleep(250);
  }
  proc.kill();
  throw new Error("wrangler did not become ready\n" + log.join("").slice(-1200));
}

/**
 * Whether the server has let go of a socket: it reported closed, or it no longer
 * answers a ping. A server-side close is a close frame; how soon a client library
 * turns that into an event is the library's business, so either is proof.
 */
async function letGo(l: Listener, ms = 6000): Promise<boolean> {
  if (await l.waitFor(() => l.closed, 1500)) return true;
  const before = l.texts.filter((t) => t === "pong").length;
  try {
    l.sock.send("ping");
  } catch {
    return true;
  }
  await Bun.sleep(Math.min(ms, 2500));
  return l.closed || l.texts.filter((t) => t === "pong").length === before;
}

/** One socket, and everything it has been told. */
class Listener {
  readonly sock: WebSocket;
  texts: string[] = [];
  opened = false;
  closed = false;
  errored = false;
  constructor(device: string, token: string, fleet = "e2e") {
    this.sock = new WebSocket(WS + "/fleets/" + fleet + "/events", { headers: { "x-prime-device": device, "x-device-token": token } } as never);
    this.sock.addEventListener("open", () => (this.opened = true));
    this.sock.addEventListener("close", () => (this.closed = true));
    this.sock.addEventListener("error", () => (this.errored = true));
    this.sock.addEventListener("message", (e) => this.texts.push(String(e.data)));
  }
  events(): Record<string, any>[] {
    return this.texts.filter((t) => t.startsWith("{")).map((t) => JSON.parse(t));
  }
  of(type: string): Record<string, any>[] {
    return this.events().filter((e) => e.type === type);
  }
  async waitFor(what: () => boolean, ms = 6000): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (what()) return true;
      await Bun.sleep(25);
    }
    return what();
  }
}

const JSON_HEADERS: Record<string, string> = { "content-type": "application/json" };
const OPERATOR_HEADERS: Record<string, string> = OPERATOR ? { ...JSON_HEADERS, authorization: "Bearer " + OPERATOR } : JSON_HEADERS;
const PUBKEY = "A".repeat(43) + "=";
const asDevice = (id: string, token: string) => ({ ...JSON_HEADERS, "x-prime-device": id, "x-device-token": token });

async function admin(path: string, body: unknown = {}, method = "POST"): Promise<{ status: number; json: any }> {
  const r = await fetch(BASE + path, { method, headers: OPERATOR_HEADERS, body: method === "GET" ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

async function member(path: string, device: string, token: string, body: unknown = {}): Promise<{ status: number; json: any; headers: Headers }> {
  const r = await fetch(BASE + path, { method: "POST", headers: asDevice(device, token), body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})), headers: r.headers };
}

async function admit(device: string, token: string): Promise<void> {
  const inv = await admin("/admin/api/fleets/e2e/invite");
  await member("/fleets/e2e/join", device, token, { code: inv.json.code, label: device, pubkey: PUBKEY });
  await admin("/admin/api/fleets/e2e/approve", { deviceId: device });
}

const worker = await startWorker();
const listeners: Listener[] = [];
try {
  // ---- the fleet, and two members, and one stranger -----------------------------
  for (const [id, token] of [["dev-a", "token-a-1234"], ["dev-b", "token-b-1234"], ["dev-c", "token-c-1234"]]) {
    await admin("/admin/api/devices", { deviceId: id, token });
  }
  const made = await admin("/admin/api/fleets/e2e");
  check("the fleet is made", made.status === 200, JSON.stringify(made.json));
  await admit("dev-a", "token-a-1234");
  await admit("dev-b", "token-b-1234");

  // ---- listening ------------------------------------------------------------------
  const a = new Listener("dev-a", "token-a-1234");
  listeners.push(a);
  check("a member's socket opens and is told how the fleet is", await a.waitFor(() => a.of("hello").length === 1));
  const hello = a.of("hello")[0] ?? {};
  check("hello says the fleet is not paused and nobody holds the lease", hello.paused === false && hello.leaseHolder === null, JSON.stringify(hello));
  check("hello says how long a lease lasts", hello.leaseMs === 45000, JSON.stringify(hello));

  const stranger = new Listener("dev-c", "token-c-1234");
  listeners.push(stranger);
  await stranger.waitFor(() => stranger.errored || stranger.closed, 4000);
  check("a device that is not a member gets no socket", !stranger.opened && stranger.of("hello").length === 0);
  const wrongToken = new Listener("dev-a", "not-the-token");
  listeners.push(wrongToken);
  await wrongToken.waitFor(() => wrongToken.errored || wrongToken.closed, 4000);
  check("a wrong token gets no socket", !wrongToken.opened);
  const plain = await fetch(BASE + "/fleets/e2e/events", { headers: asDevice("dev-a", "token-a-1234") });
  check("without an upgrade it is told to upgrade", plain.status === 426, String(plain.status));

  // A ping is answered by the runtime, without waking the object.
  a.sock.send("ping");
  check("a ping is answered with a pong", await a.waitFor(() => a.texts.includes("pong"), 4000));

  const b = new Listener("dev-b", "token-b-1234");
  listeners.push(b);
  check("the second member's socket opens", await b.waitFor(() => b.of("hello").length === 1));

  // ---- the object goes to sleep, and the sockets still work ---------------------
  // The runtime unloads an idle object that holds only hibernatable sockets. What
  // arrives after that must still reach them, with their identity intact - the
  // identity is what "everyone but the publisher" depends on.
  console.log("... idle for 13s so the object can hibernate");
  await Bun.sleep(13_000);

  const boot = await member("/fleets/e2e/bootstrap", "dev-a", "token-a-1234", {});
  check("a member takes the lease", boot.status === 200 && boot.json.role === "primary", JSON.stringify(boot.json));
  const advance = await member("/fleets/e2e/head/advance", "dev-a", "token-a-1234", { expectedSeq: 0, manifestKey: "m1", manifestHash: "h1" });
  check("the holder advances the head", advance.status === 200, JSON.stringify(advance.json));
  // The publisher has the state it just published; it says so, as the agent does,
  // or the fleet would not let it keep the lease once the lease changes hands.
  await member("/fleets/e2e/applied", "dev-a", "token-a-1234", { seq: 1 });
  check("the other member is told, after the object slept", await b.waitFor(() => b.of("head").length === 1));
  check("and told which sequence", b.of("head")[0]?.seq === 1, JSON.stringify(b.of("head")));
  await Bun.sleep(500);
  check("the one that published is not told", a.of("head").length === 0);

  // ---- pausing ---------------------------------------------------------------------
  const paused = await admin("/admin/api/fleets/e2e/meta", { disabled: true });
  check("the operator pauses the fleet", paused.status === 200, JSON.stringify(paused.json));
  check("every listener is told it is paused", await a.waitFor(() => a.of("paused").length === 1) && (await b.waitFor(() => b.of("paused").length === 1)));
  const refused = await member("/fleets/e2e/bootstrap", "dev-b", "token-b-1234", {});
  check("asking a paused fleet for a place is refused", refused.status === 409, String(refused.status));
  check("and says how long to wait", refused.json.paused === true && refused.json.retryAfterMs === 60000 && refused.headers.get("retry-after") === "60", JSON.stringify(refused.json) + " " + refused.headers.get("retry-after"));
  // A snapshot is something only the Worker's own gate would refuse with this
  // answer: left to the usual path it would be judged on its content first.
  const snap = await member("/fleets/e2e/snapshot", "dev-a", "token-a-1234", {});
  check("a snapshot to a paused fleet is turned away at the door", snap.status === 409 && snap.json.paused === true, snap.status + " " + JSON.stringify(snap.json));
  const late = new Listener("dev-b", "token-b-1234");
  listeners.push(late);
  check("a socket opened during the pause is told so", await late.waitFor(() => late.of("hello").length === 1));
  check("...in its hello", late.of("hello")[0]?.paused === true, JSON.stringify(late.of("hello")));
  // Opening a second socket as the same member replaces the first one.
  check("the first socket of that member was replaced", await b.waitFor(() => b.of("bye").some((e) => e.reason === "replaced")));

  const resumed = await admin("/admin/api/fleets/e2e/meta", { disabled: false });
  check("the operator resumes the fleet", resumed.status === 200, JSON.stringify(resumed.json));
  check("every listener is told", await a.waitFor(() => a.of("resumed").length === 1) && (await late.waitFor(() => late.of("resumed").length === 1)));
  const again = await member("/fleets/e2e/bootstrap", "dev-a", "token-a-1234", {});
  check("a resumed fleet serves again", again.status === 200 && again.json.role === "primary", JSON.stringify(again.json));

  // ---- the lease ending, with nobody to say so ---------------------------------
  // The holder renews and then says nothing. The only thing that can announce the lease ending is the alarm
  // the fleet set for that moment. The lease is the fleet's, not the holder's: it is set short here (the
  // local worker lowers the floor for this), because a deployed gateway keeps it between 30 and 180 seconds.
  if (EXTERNAL) {
    console.log("SKIP the lease ending (a deployed gateway's lease is at least 30 s)");
  } else {
    const set = await admin("/admin/api/fleets/e2e/meta", { leaseMs: 2000 });
    check("the operator sets a short lease", set.status === 200 && set.json.leaseMs === 2000, JSON.stringify(set.json));
    const renew = await member("/fleets/e2e/lease/renew", "dev-a", "token-a-1234", { ttlMs: 300000 });
    check("the holder renews, and the fleet's lease is the one that applies", renew.status === 200, JSON.stringify(renew.json));
    const renewedAt = Date.now();
    const before = late.of("lease-free").length;
    check("the lease ending is announced by the alarm", await late.waitFor(() => late.of("lease-free").length > before, 8000));
    const waited = Date.now() - renewedAt;
    check("...not before it ended", waited >= 1900, waited + "ms");
    check("...and soon after", waited < 6000, waited + "ms");
    await admin("/admin/api/fleets/e2e/meta", { leaseMs: null });
  }

  // ---- giving it up ------------------------------------------------------------------
  await member("/fleets/e2e/bootstrap", "dev-a", "token-a-1234", {});
  const beforeRelease = late.of("lease-free").length;
  await member("/fleets/e2e/lease/release", "dev-a", "token-a-1234", {});
  check("a lease that is released is announced at once", await late.waitFor(() => late.of("lease-free").length > beforeRelease, 3000));

  // ---- leaving -------------------------------------------------------------------------
  const removed = await admin("/admin/api/fleets/e2e/remove", { deviceId: "dev-b" });
  check("the operator removes a member", removed.status === 200, JSON.stringify(removed.json));
  const toldBye = await late.waitFor(() => late.of("bye").some((e) => e.reason === "removed"));
  check("that member is told it was removed", toldBye, "heard " + JSON.stringify(late.texts));
  check("and the fleet lets go of its socket", await letGo(late));
  a.sock.send("ping");
  const pongsBefore = a.texts.filter((t) => t === "pong").length;
  await Bun.sleep(1500);
  check("the others are not hung up on", !a.closed && a.texts.filter((t) => t === "pong").length > pongsBefore);
  // ---- what was done is written down -----------------------------------------------------
  const log = await admin("/admin/api/fleets/e2e/audit?tail=500", {}, "GET");
  const done: string[] = (log.json.entries ?? []).map((e: { action: string }) => e.action);
  for (const action of ["fleet-created", "member-admitted", "lease-taken", "lease-released", "fleet-changed", "member-removed"]) {
    check("the log says " + action, done.includes(action), JSON.stringify(done));
  }
  // The entries chain: each carries the hash of the one before.
  let chained = true;
  let prev = "0".repeat(64);
  for (const e of log.json.entries ?? []) {
    if (e.prev !== prev) chained = false;
    const sorted = (v: unknown): unknown => (Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v);
    prev = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(sorted(e))))), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  check("and the entries are a chain", chained && (log.json.entries ?? []).length > 0 && log.json.head?.hash === prev);
  const gone = await admin("/admin/api/fleets/e2e", {}, "DELETE");
  check("the fleet is deleted", gone.status === 200, JSON.stringify(gone.json));
  check("everyone is told, and the fleet lets go", (await a.waitFor(() => a.of("bye").length > 0)) && (await letGo(a)));
} catch (err) {
  fail++;
  failures.push("crashed: " + (err instanceof Error ? err.stack ?? err.message : String(err)));
  console.log("FAIL crashed: " + (err instanceof Error ? err.message : String(err)));
} finally {
  if (EXTERNAL) await admin("/admin/api/fleets/e2e", {}, "DELETE").catch(() => null);
  for (const l of listeners) {
    try {
      l.sock.close();
    } catch {}
  }
  worker.stop();
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail > 0) {
  console.log("Failures:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
process.exit(0);
