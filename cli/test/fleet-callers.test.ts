// Who may call the primary of a fleet, from the signed roster: what the agent writes, what a space's tool server
// does with it, and the commands that put a caller key in the roster.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { CallerAuth } from "../src/caller-auth.ts";
import { GatewayClient } from "../src/client.ts";
import { CallSigner, FLEET_PROBE_TOOL, callTarget, fleetMemberTarget, loadOrCreateCallerKey, parseCallSig, signCall } from "../src/caller-key.ts";
import { FLEET_CALLERS_FRESH_MS, callersOfRoster, readFleetCallers } from "../src/fleet-callers.ts";
import { FleetTrust, forgetRosterAnswers } from "../src/fleet-trust.ts";
import { FleetCallersWriter, refreshFleetCallers, startFleetCallers, type CallersLoop } from "../src/fleet-callers-agent.ts";
import { fleetsRoster } from "../src/fleets.ts";
import {
  type OwnerKey,
  type RosterEntry,
  type SignedEntry,
  entryHash,
  generateOwnerKey,
  makeEntry,
  signEntry,
  verifyChain,
} from "../src/fleet-roster.ts";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

let dir: string;
const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "prime-fleet-callers-"));
  dirs.push(d);
  return d;
}
beforeAll(() => {
  dir = scratch();
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sha = (s: string) => Buffer.from(s).toString("base64");

/** A chain: the owner's genesis, then the members given (device, role), then the entries `more` makes. */
function chain(
  owner: OwnerKey,
  members: Array<{ device: string; role: string; spub: string }>,
  more: (add: (f: Omit<Parameters<typeof makeEntry>[0], "fleet" | "incarnation" | "n" | "prevHash" | "at">) => void) => void = () => undefined,
): SignedEntry[] {
  const entries: SignedEntry[] = [];
  const add = (f: Omit<Parameters<typeof makeEntry>[0], "fleet" | "incarnation" | "n" | "prevHash" | "at">): void => {
    const prev = entries[entries.length - 1];
    const e: RosterEntry = makeEntry({ ...f, fleet: "acme", incarnation: "inc-1", n: entries.length, prevHash: prev ? entryHash(prev) : null, at: 1_700_000_000_000 + entries.length });
    entries.push({ entry: e, sig: signEntry(e, owner.privateKeyPem) });
  };
  add({ op: "genesis", seqAt: 0, extra: owner.publicKey });
  for (const m of members) add({ op: "add", device: m.device, xpub: sha(m.device), spub: m.spub, role: m.role, seqAt: 0 });
  more(add);
  return entries;
}

/** A caller key (a PEM on disk, as the CLI keeps it) and its public key as the roster names it. */
function callerKey(name: string) {
  const owner = generateOwnerKey();
  const file = join(dir, name + ".pem");
  writeFileSync(file, owner.privateKeyPem, { mode: 0o600 });
  chmodSync(file, 0o600);
  const key = loadOrCreateCallerKey(file);
  return { key, spub: owner.publicKey, keyId: key.keyId };
}

describe("the callers a verified roster names", () => {
  test("are the live members that are not viewers and the owner's caller keys: a viewer, a removed member and a removed caller are not", () => {
    const owner = generateOwnerKey();
    const a = callerKey("a");
    const viewer = callerKey("viewer");
    const gone = callerKey("gone");
    const laptop = callerKey("laptop");
    const dropped = callerKey("dropped");
    const v = verifyChain(
      chain(owner, [{ device: "dev-a", role: "member", spub: a.spub }, { device: "dev-v", role: "viewer", spub: viewer.spub }, { device: "dev-g", role: "member", spub: gone.spub }], (add) => {
        add({ op: "remove", device: "dev-g", seqAt: 3 });
        add({ op: "caller", spub: laptop.spub, extra: "laptop" });
        add({ op: "caller", spub: dropped.spub, extra: "old" });
        add({ op: "caller-remove", spub: dropped.spub });
      }),
      { fleet: "acme" },
    );
    const callers = callersOfRoster(v);
    expect(callers.map((c) => c.keyId).sort()).toEqual([a.keyId, laptop.keyId].sort());
    expect(callers.find((c) => c.keyId === a.keyId)!.label).toBe("member dev-a");
    expect(callers.find((c) => c.keyId === laptop.keyId)!).toMatchObject({ label: "laptop", pub: laptop.key.publicKeyB64 });
    expect(callers.find((c) => c.keyId === laptop.keyId)!.addedAt).toMatch(/^2023-/);
  });

  test("a viewer made a member again, or a member made a viewer, follows the roster", () => {
    const owner = generateOwnerKey();
    const m = callerKey("m");
    const v = verifyChain(chain(owner, [{ device: "dev-m", role: "member", spub: m.spub }], (add) => add({ op: "role", device: "dev-m", role: "viewer", seqAt: 2 })), { fleet: "acme" });
    expect(callersOfRoster(v)).toEqual([]);
  });
});

describe("what the agent writes", () => {
  const rosterOf = (members: Array<{ device: string; role: string; spub: string }>) => verifyChain(chain(generateOwnerKey(), members), { fleet: "acme" });

  test("says whether the space is the primary and since when, and writes at once when that changes", () => {
    const file = join(scratch(), "fleet-callers.json");
    let now = 1_000_000;
    const w = new FleetCallersWriter(file, "acme", () => undefined, () => now);
    const m = callerKey("w1");
    w.setRoster(rosterOf([{ device: "dev-a", role: "member", spub: m.spub }]));
    w.update(false);
    expect(readFleetCallers(file).file).toMatchObject({ fleet: "acme", roster: "signed", primary: false });
    now += 1_000;
    w.update(true);
    expect(readFleetCallers(file).file).toMatchObject({ primary: true, primarySince: 1_001_000 });
    // renewed, and the time it became the primary is the same
    now += 25_000;
    w.update(true);
    expect(readFleetCallers(file).file).toMatchObject({ primary: true, primarySince: 1_001_000, writtenAt: 1_026_000 });
    // nothing changed and it is not time: not written again
    const before = readFileSync(file, "utf8");
    now += 1_000;
    w.update(true);
    expect(readFileSync(file, "utf8")).toBe(before);
    // not the primary any more: at once; the next time it is the primary is a new time
    w.update(false);
    expect(readFleetCallers(file).file).toMatchObject({ primary: false });
    now += 1_000;
    w.update(true);
    expect(readFleetCallers(file).file!.primarySince).toBe(now);
  });

  test("a roster that cannot be read is believed for an hour and then lists nobody; it is read again every thirty seconds while primary", () => {
    const file = join(scratch(), "fleet-callers.json");
    let now = 5_000_000;
    const w = new FleetCallersWriter(file, "acme", () => undefined, () => now);
    const m = callerKey("w2");
    // not primary: no need of the roster; just became primary: read it; then every 30 s
    expect(w.wantsRoster(false)).toBe(false);
    expect(w.wantsRoster(true)).toBe(true);
    w.setRoster(rosterOf([{ device: "dev-a", role: "member", spub: m.spub }]));
    w.update(true);
    now += 10_000;
    expect(w.wantsRoster(true)).toBe(false);
    now += 20_000;
    expect(w.wantsRoster(true)).toBe(true);
    // it cannot be read from now on: kept for an hour
    now += 59 * 60_000;
    w.update(true);
    expect(readFleetCallers(file).file).toMatchObject({ roster: "signed" });
    expect(readFleetCallers(file).file!.callers).toHaveLength(1);
    now += 120_000;
    w.update(true);
    expect(readFleetCallers(file).file).toMatchObject({ roster: "refused", callers: [] });
    expect(readFleetCallers(file).file!.note).toContain("could not be read for 60 minutes");
  });

  test("lists nobody for a roster the gateway keeps or one that was refused", () => {
    const file = join(scratch(), "fleet-callers.json");
    const w = new FleetCallersWriter(file, "acme");
    w.setRoster({ open: true });
    w.update(true);
    expect(readFleetCallers(file).file).toMatchObject({ roster: "open", callers: [] });
    w.setRoster({ refused: "the gateway went back" });
    w.update(true);
    expect(readFleetCallers(file).file).toMatchObject({ roster: "refused", note: "the gateway went back", callers: [] });
  });

  test("says once when it cannot write", () => {
    const blocker = join(scratch(), "blocker");
    writeFileSync(blocker, "x");
    const said: string[] = [];
    const w = new FleetCallersWriter(join(blocker, "fleet-callers.json"), "acme", (t) => said.push(t));
    w.update(true);
    w.update(true);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("fleet calls to this space are refused until it can be written");
  });

  test("a replica does not fetch the roster, and a space with no secret directory writes nothing", async () => {
    const secret = scratch();
    const loop = { fleet: "acme", creds: { gateway: "http://127.0.0.1:1", deviceId: "d", deviceToken: "t", timeoutMs: 100 }, primary: false, paths: { keyFile: join(secret, "k") }, space: { secret_dir: secret } } as unknown as CallersLoop;
    await refreshFleetCallers(loop);
    expect(readFleetCallers(join(secret, "fleet-callers.json")).file).toMatchObject({ primary: false, roster: "refused" });
    const none = { fleet: "acme", creds: loop.creds, primary: false, paths: loop.paths, space: {} } as CallersLoop;
    await refreshFleetCallers(none);
    expect(none.callersWriter).toBeUndefined();
  });
  test("the agent's timer follows the lease, and says \"not the primary\" when it stops", async () => {
    const secret = scratch();
    const loop = { fleet: "acme", creds: { gateway: "http://127.0.0.1:1", deviceId: "d", deviceToken: "t", timeoutMs: 200 }, primary: false, paths: { keyFile: join(secret, "key") }, space: { secret_dir: secret } } as unknown as CallersLoop;
    const file = join(secret, "fleet-callers.json");
    const stop = startFleetCallers(loop, () => undefined, 20);
    try {
      const until = async (ok: () => boolean) => {
        for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
        expect(ok()).toBe(true);
      };
      await until(() => readFleetCallers(file).file?.primary === false);
      loop.primary = true;
      await until(() => readFleetCallers(file).file?.primary === true);
      stop();
      expect(readFleetCallers(file).file?.primary).toBe(false);
    } finally {
      stop();
    }
  });

  test("a primary reads the roster through the member's own trust: what it verified is written, and a gateway that then serves another owner's chain lists nobody", async () => {
    const secret = scratch();
    const owner = generateOwnerKey();
    const member = callerKey("live-member");
    const laptop = callerKey("live-laptop");
    const original = chain(owner, [{ device: "dev-a", role: "member", spub: member.spub }], (add) => add({ op: "caller", spub: laptop.spub, extra: "laptop" }));
    let served: SignedEntry[] = original;
    const server = Bun.serve({ port: 0, fetch: (req) => (new URL(req.url).pathname === "/fleets/acme/roster" ? Response.json({ mode: "signed", entries: served }) : Response.json({ error: "no" }, { status: 404 })) });
    try {
      const loop = { fleet: "acme", creds: { gateway: "http://127.0.0.1:" + server.port, deviceId: "d", deviceToken: "t", timeoutMs: 2000 }, primary: true, paths: { keyFile: join(secret, "key") }, space: { secret_dir: secret } } as unknown as CallersLoop;
      // the agent reads the roster every 30 seconds: the test's clock goes that far between rounds
      let now = Date.now();
      loop.callersWriter = new FleetCallersWriter(join(secret, "fleet-callers.json"), "acme", () => undefined, () => now);
      now += 31_000;
      forgetRosterAnswers();
      await refreshFleetCallers(loop);
      const file = readFleetCallers(join(secret, "fleet-callers.json")).file!;
      expect(file).toMatchObject({ roster: "signed", primary: true });
      expect(file.callers.map((c) => c.keyId).sort()).toEqual([member.keyId, laptop.keyId].sort());
      // another owner's chain from now on: refused against the owner key this member pinned at first sight
      const mallory = generateOwnerKey();
      served = chain(mallory, [{ device: "dev-a", role: "member", spub: callerKey("evil").spub }]);
      now += 31_000;
      forgetRosterAnswers();
      await refreshFleetCallers(loop);
      expect(readFleetCallers(join(secret, "fleet-callers.json")).file).toMatchObject({ roster: "refused", callers: [] });
      // a gateway that cannot be reached keeps what was last verified
      served = original;
      now += 31_000;
      forgetRosterAnswers();
      await refreshFleetCallers(loop);
      expect(readFleetCallers(join(secret, "fleet-callers.json")).file).toMatchObject({ roster: "signed" });
      server.stop(true);
      now += 31_000;
      forgetRosterAnswers();
      await refreshFleetCallers(loop);
      expect(readFleetCallers(join(secret, "fleet-callers.json")).file).toMatchObject({ roster: "signed", primary: true });
    } finally {
      server.stop(true);
    }
  });
});

describe("what a space reads", () => {
  test("a missing file is no callers, a damaged one is an error, and an open roster lists nobody whatever the file says", () => {
    const d = scratch();
    expect(readFleetCallers(join(d, "none.json"))).toEqual({});
    writeFileSync(join(d, "bad.json"), "{ nope");
    expect(readFleetCallers(join(d, "bad.json")).error).toContain("not valid JSON");
    const k = callerKey("r1");
    writeFileSync(
      join(d, "open.json"),
      JSON.stringify({ version: 1, fleet: "acme", roster: "open", primary: true, primarySince: 1, writtenAt: 2, callers: [{ pub: k.key.publicKeyB64 }] }),
    );
    expect(readFleetCallers(join(d, "open.json")).file!.callers).toEqual([]);
    writeFileSync(join(d, "v2.json"), JSON.stringify({ version: 2 }));
    expect(readFleetCallers(join(d, "v2.json")).error).toContain("version 2");
    writeFileSync(join(d, "nokey.json"), JSON.stringify({ version: 1, fleet: "acme", roster: "signed", primary: true, primarySince: 1, writtenAt: 2, callers: [{ pub: "x" }] }));
    expect(readFleetCallers(join(d, "nokey.json")).error).toContain("no valid key");
  });
});

describe("a space's tool server and a call made for the fleet", () => {
  const BODY = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bash", arguments: { command: "id" } } });
  const body = (n: number) => BODY.replace('"id":1', `"id":${n}`);

  function space(state: { primary: boolean; roster?: "signed" | "open"; writtenAgoMs?: number; primarySinceAgoMs?: number }, callersOfFleet: Array<ReturnType<typeof callerKey>>, deviceCallers: Array<ReturnType<typeof callerKey>> = [], deviceId = "space-1") {
    const d = scratch();
    const now = 1_800_000_000_000;
    const callers = join(d, "callers.json");
    const { addCaller } = require("../src/caller-key.ts") as typeof import("../src/caller-key.ts");
    for (const c of deviceCallers) addCaller(callers, { pub: c.key.publicKey });
    const fleetFile = join(d, "fleet-callers.json");
    const write = () =>
      writeFileSync(
        fleetFile,
        JSON.stringify({
          version: 1,
          fleet: "acme",
          roster: state.roster ?? "signed",
          primary: state.primary,
          primarySince: now - (state.primarySinceAgoMs ?? 60_000),
          writtenAt: now - (state.writtenAgoMs ?? 1_000),
          callers: callersOfFleet.map((c) => ({ keyId: c.keyId, pub: c.key.publicKeyB64, label: "x", addedAt: "" })),
        }),
      );
    write();
    // the device started two minutes before the calls
    let clock = now - 120_000;
    const auth = new CallerAuth({ mode: "enforce", deviceId, callersFile: callers, now: () => clock, stateDir: join(d, "state") });
    clock = now;
    const sign = (c: ReturnType<typeof callerKey>, target: string, raw: string, ago = 0) => signCall(c.key, target, raw, { now: now - ago });
    return { auth, now, sign, fleetFile, write };
  }

  /** What a call for the fleet is signed for: the fleet and the one member that is to run it. */
  const BOUND = fleetMemberTarget("acme", "space-1");
  const reason = (a: ReturnType<CallerAuth["admit"]>) => (a.action === "refuse" ? (a.response.error.data.reason as string) : "ran");

  test("the primary runs a call signed for the fleet by a key of the roster", () => {
    const k = callerKey("f1");
    const s = space({ primary: true }, [k]);
    const raw = body(1);
    const a = s.auth.admit({ raw, callerSig: s.sign(k, BOUND, raw) });
    expect(a.action).toBe("run");
  });

  test("a replica refuses it, and says that the call did not run (a gateway that kept a signed fleet call must not have it run elsewhere)", () => {
    const k = callerKey("f2");
    const s = space({ primary: false }, [k]);
    const raw = body(2);
    const a = s.auth.admit({ raw, callerSig: s.sign(k, BOUND, raw) });
    expect(reason(a)).toBe("not-primary");
    if (a.action === "refuse") expect(a.response.error.message).toContain("did not run");
  });

  test("the agent's word that this is the primary is not believed for long: an old file refuses", () => {
    const k = callerKey("f3");
    const old = space({ primary: true, writtenAgoMs: FLEET_CALLERS_FRESH_MS + 1_000 }, [k]);
    const raw = body(3);
    expect(reason(old.auth.admit({ raw, callerSig: old.sign(k, BOUND, raw) }))).toBe("not-primary");
    const fresh = space({ primary: true, writtenAgoMs: FLEET_CALLERS_FRESH_MS - 1_000 }, [k]);
    expect(fresh.auth.admit({ raw, callerSig: fresh.sign(k, BOUND, raw) }).action).toBe("run");
  });

  test("a call signed before the space became the primary, or within the clocks' skew of it, is refused: it may have run on the member that was", () => {
    const k = callerKey("f4");
    const s = space({ primary: true, primarySinceAgoMs: 120_000 }, [k]);
    const raw = body(4);
    const early = s.auth.admit({ raw, callerSig: s.sign(k, BOUND, raw, 150_000) });
    expect(reason(early)).toBe("before-primary");
    if (early.action === "refuse") expect(early.response.error.message).toContain("may have run");
    // signed just after it became the primary, within the skew: refused too
    const raw1 = body(41);
    expect(reason(s.auth.admit({ raw: raw1, callerSig: s.sign(k, BOUND, raw1, 117_000) }))).toBe("before-primary");
    const raw2 = body(5);
    expect(s.auth.admit({ raw: raw2, callerSig: s.sign(k, BOUND, raw2, 5_000) }).action).toBe("run");
  });

  test("a call for the fleet signed more than a minute ahead of the clock is refused, with the figure; 50 seconds ahead is a clock that is a little off, and runs", () => {
    const k = callerKey("f4b");
    const s = space({ primary: true }, [k]);
    const raw = body(42);
    const ahead = s.auth.admit({ raw, callerSig: s.sign(k, BOUND, raw, -240_000) });
    expect(reason(ahead)).toBe("ahead");
    if (ahead.action === "refuse") {
      expect(ahead.response.error.message).toContain("a minute ahead");
      expect(ahead.response.error.message).not.toContain("5 minutes");
      expect(ahead.response.error.message).toContain("did not run");
    }
    const raw50 = body(421);
    expect(s.auth.admit({ raw: raw50, callerSig: s.sign(k, BOUND, raw50, -50_000) }).action).toBe("run");
    const raw70 = body(422);
    expect(reason(s.auth.admit({ raw: raw70, callerSig: s.sign(k, BOUND, raw70, -70_000) }))).toBe("ahead");
    // a call for the device itself keeps the 5 minutes
    const d = space({ primary: true }, [], [k]);
    const raw2 = body(43);
    expect(d.auth.admit({ raw: raw2, callerSig: d.sign(k, callTarget("device", "space-1"), raw2, -240_000) }).action).toBe("run");
    // the failover itself: the call that ran on the old primary is not run by the one that takes over later
    const ran = space({ primary: true }, [k]);
    const raw3 = body(44);
    expect(ran.auth.admit({ raw: raw3, callerSig: ran.sign(k, BOUND, raw3, -3_000) }).action).toBe("run");
    const next = space({ primary: true, primarySinceAgoMs: 0 }, [k]);
    expect(reason(next.auth.admit({ raw: raw3, callerSig: ran.sign(k, BOUND, raw3, -3_000) }))).toBe("before-primary");
  });

  test("a call for the fleet names one member: a gateway that sends it to two, and tells both that they hold the place, has it run once", () => {
    const k = callerKey("m1");
    const a = space({ primary: true }, [k], [], "member-a");
    const b = space({ primary: true }, [k], [], "member-b");
    const raw = body(60);
    const forA = a.sign(k, fleetMemberTarget("acme", "member-a"), raw);
    expect(a.auth.admit({ raw, callerSig: forA }).action).toBe("run");
    // the same bytes, sent to the other member (which believes it is a primary too): not run
    expect(reason(b.auth.admit({ raw, callerSig: forA }))).toBe("invalid");
    // and the other way round
    const raw2 = body(61);
    const forB = b.sign(k, fleetMemberTarget("acme", "member-b"), raw2);
    expect(reason(a.auth.admit({ raw: raw2, callerSig: forB }))).toBe("invalid");
    expect(b.auth.admit({ raw: raw2, callerSig: forB }).action).toBe("run");
  });

  test("the question which member this is is answered with the member's id, runs nothing and is signed, in every mode but off", () => {
    const k = callerKey("m2");
    for (const mode of ["enforce", "warn"] as const) {
      const s = space({ primary: false }, [k]);
      const auth = mode === "enforce" ? s.auth : new CallerAuth({ mode, deviceId: "space-1", callersFile: join(dirname(s.fleetFile), "callers.json"), now: () => s.now, stateDir: join(scratch(), "st") });
      const probeBody = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/call", params: { name: FLEET_PROBE_TOOL, arguments: {} } });
      const a = auth.admit({ raw: probeBody, callerSig: s.sign(k, fleetMemberTarget("acme", ""), probeBody) });
      expect(a.action).toBe("refuse");
      if (a.action === "refuse") {
        expect(a.response.error.data).toMatchObject({ reason: "fleet-member", member: "space-1" });
        expect(a.response.error.message).toContain("nothing ran");
        expect(a.reply).toBeDefined();
      }
    }
  });

  test("a call that names no member (what older builds sign) is refused with what to do, and the call did not run", () => {
    const k = callerKey("m3");
    const s = space({ primary: true }, [k]);
    const raw = body(62);
    const a = s.auth.admit({ raw, callerSig: s.sign(k, callTarget("fleet", "acme"), raw) });
    expect(reason(a)).toBe("fleet-unbound");
    if (a.action === "refuse") expect(a.response.error.message).toContain("update prime");
  });

  test("the same call again is a replay, and a call for another fleet or for the device does not verify as a call for this fleet", () => {
    const k = callerKey("f5");
    const s = space({ primary: true }, [k]);
    const raw = body(6);
    const sig = s.sign(k, BOUND, raw);
    expect(s.auth.admit({ raw, callerSig: sig }).action).toBe("run");
    expect(reason(s.auth.admit({ raw, callerSig: sig }))).toBe("replay");
    const raw7 = body(7);
    expect(reason(s.auth.admit({ raw: raw7, callerSig: s.sign(k, fleetMemberTarget("other", "space-1"), raw7) }))).toBe("invalid");
    // a key of the roster is a caller of the fleet, not of the device
    const raw8 = body(8);
    expect(reason(s.auth.admit({ raw: raw8, callerSig: s.sign(k, callTarget("device", "space-1"), raw8) }))).toBe("invalid");
  });

  test("a key the device allows is a caller of the device, not of the fleet; a key in both may do either", () => {
    const own = callerKey("f6");
    const both = callerKey("f7");
    const s = space({ primary: true }, [both], [own, both]);
    const raw = body(9);
    expect(reason(s.auth.admit({ raw, callerSig: s.sign(own, BOUND, raw) }))).toBe("invalid");
    const raw2 = body(10);
    expect(s.auth.admit({ raw: raw2, callerSig: s.sign(own, callTarget("device", "space-1"), raw2) }).action).toBe("run");
    const raw3 = body(11);
    expect(s.auth.admit({ raw: raw3, callerSig: s.sign(both, BOUND, raw3) }).action).toBe("run");
    const raw4 = body(12);
    expect(s.auth.admit({ raw: raw4, callerSig: s.sign(both, callTarget("device", "space-1"), raw4) }).action).toBe("run");
  });

  test("a roster the gateway keeps, and no file at all, list nobody", () => {
    const k = callerKey("f8");
    const open = space({ primary: true, roster: "open" }, [k]);
    const raw = body(13);
    expect(reason(open.auth.admit({ raw, callerSig: open.sign(k, BOUND, raw) }))).toBe("invalid");
    const none = space({ primary: true }, [k]);
    rmSync(none.fleetFile);
    expect(reason(none.auth.admit({ raw, callerSig: none.sign(k, BOUND, raw) }))).toBe("invalid");
  });

  test("a file the agent rewrites is read again: a space that stops being the primary refuses at once", () => {
    const k = callerKey("f9");
    const s = space({ primary: true }, [k]);
    const raw = body(14);
    expect(s.auth.admit({ raw, callerSig: s.sign(k, BOUND, raw) }).action).toBe("run");
    const written = JSON.parse(readFileSync(s.fleetFile, "utf8"));
    writeFileSync(s.fleetFile, JSON.stringify({ ...written, primary: false, writtenAt: written.writtenAt + 1 }));
    const raw2 = body(15);
    expect(reason(s.auth.admit({ raw: raw2, callerSig: s.sign(k, BOUND, raw2) }))).toBe("not-primary");
  });
});

describe("prime fleets roster add-caller and remove-caller", () => {
  let gw: { url: string; entries: SignedEntry[]; stop(): void };
  let ownerFile: string;
  let owner: OwnerKey;
  const out: string[] = [];

  beforeAll(() => {
    owner = generateOwnerKey();
    ownerFile = join(dir, "owner", "acme.pem");
    mkdirSync(join(dir, "owner"), { recursive: true });
    writeFileSync(ownerFile, owner.privateKeyPem, { mode: 0o600 });
    const member = callerKey("cmd-member");
    const state = { url: "", entries: chain(owner, [{ device: "dev-1", role: "owner", spub: member.spub }]), stop: () => undefined };
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/fleets/acme/roster" && req.method === "GET") return Response.json({ mode: "signed", incarnation: "inc-1", entries: state.entries });
        if (p === "/fleets/acme/roster" && req.method === "POST") {
          const body = (await req.json()) as SignedEntry;
          try {
            verifyChain([...state.entries, body], { fleet: "acme", incarnation: "inc-1" });
          } catch (e) {
            return Response.json({ error: (e as Error).message }, { status: 409 });
          }
          state.entries.push(body);
          return Response.json({ ok: true });
        }
        return Response.json({ error: "no" }, { status: 404 });
      },
    });
    state.url = "http://127.0.0.1:" + server.port;
    state.stop = () => void server.stop(true);
    gw = state;
  });
  afterAll(() => gw.stop());
  afterEach(() => {
    out.length = 0;
  });

  const ctx = (sub: string, flags: Record<string, string | boolean> = {}) =>
    ({
      config: { defaults: { gateway: gw.url, fleet_operator_token: "op" }, devices: {}, spaces: {}, codeMcp: {} },
      configPath: join(dir, "config.yaml"),
      json: false,
      out: (l: string) => out.push(l),
      parsed: { positionals: ["fleets", "roster", sub, "acme"], flags: new Map<string, string | boolean>(Object.entries({ "owner-key": ownerFile, ...flags })), help: false },
    }) as never;

  test("add-caller signs the key into the roster, and the roster then lists it", async () => {
    const laptop = callerKey("cmd-laptop");
    await fleetsRoster(ctx("add-caller", { key: laptop.key.publicKeyB64, label: "laptop" }));
    const v = verifyChain(gw.entries, { fleet: "acme" });
    expect(v.callers).toEqual([{ spub: laptop.spub, label: "laptop", n: gw.entries.length - 1 }]);
    expect(out.join("\n")).toContain(laptop.keyId);
    // the same again is nothing to sign
    const n = gw.entries.length;
    await fleetsRoster(ctx("add-caller", { key: laptop.key.publicKeyB64, label: "laptop" }));
    expect(gw.entries).toHaveLength(n);
  });

  test("remove-caller takes it out again, and refuses a key that is not there", async () => {
    const other = callerKey("cmd-other");
    await fleetsRoster(ctx("add-caller", { key: other.key.publicKeyB64 }));
    await fleetsRoster(ctx("remove-caller", { key: other.key.publicKeyB64 }));
    expect(verifyChain(gw.entries, { fleet: "acme" }).callers.map((c) => c.spub)).not.toContain(other.spub);
    await expect(fleetsRoster(ctx("remove-caller", { key: other.key.publicKeyB64 }))).rejects.toThrow("is not a caller");
  });

  test("a key id is not a key, and --key or --self is needed, and not both", async () => {
    await expect(fleetsRoster(ctx("add-caller", { key: callerKey("cmd-x").keyId }))).rejects.toThrow("not a public key");
    await expect(fleetsRoster(ctx("add-caller", {}))).rejects.toThrow("--key <public-key> or --self");
    await expect(fleetsRoster(ctx("add-caller", { key: callerKey("cmd-y").key.publicKeyB64, self: true }))).rejects.toThrow("--key <public-key> or --self");
  });

  test("without the owner key nothing is signed", async () => {
    const before = gw.entries.length;
    const c = ctx("add-caller", { key: callerKey("cmd-z").key.publicKeyB64, "owner-key": join(dir, "owner", "missing.pem") });
    await expect(fleetsRoster(c)).rejects.toThrow();
    expect(gw.entries).toHaveLength(before);
  });
});

describe("a space in a fleet takes its mode from the fleet's roster", () => {
  const unsigned = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bash", arguments: { command: "id" } } });
  function fleetSpace(roster: "signed" | "open", callers: number) {
    const d = scratch();
    const k = callerKey("mode-" + roster + callers);
    const logs: string[] = [];
    const file = join(d, "fleet-callers.json");
    const write = (r: string, n: number) =>
      writeFileSync(file, JSON.stringify({ version: 1, fleet: "acme", roster: r, primary: true, primarySince: 1, writtenAt: Date.now(), callers: n > 0 ? [{ pub: k.key.publicKeyB64, label: "x", addedAt: "" }] : [] }));
    write(roster, callers);
    // no callers file of the device at all: nobody was allowed on the machine
    const auth = new CallerAuth({ deviceId: "space-1", callersFile: join(d, "callers.json"), stateDir: join(d, "st"), log: (t) => logs.push(t) });
    return { auth, logs, write };
  }

  test("a member that has no owner pinned and has seen no roster: warns while the roster lists nobody, enforces once a signed roster lists callers, and says when it changes", () => {
    const s = fleetSpace("open", 0);
    expect(s.auth.mode).toBe("warn");
    expect(s.auth.admit({ raw: unsigned }).action).toBe("run");
    s.write("signed", 1);
    expect(s.auth.mode).toBe("enforce");
    expect(s.auth.admit({ raw: unsigned }).action).toBe("refuse");
    expect(s.logs.join("\n")).toContain("now enforce");
    // the roster is the gateway's again (or lists nobody): back to warn, and it says so
    s.write("open", 0);
    expect(s.auth.mode).toBe("warn");
    expect(s.logs.join("\n")).toContain("now warn");
    // a roster that is open lists nobody whatever the file says
    const open = fleetSpace("open", 1);
    expect(open.auth.mode).toBe("warn");
  });

  test("a file the agent wrote that cannot be read counts as one that lists callers", () => {
    const s = fleetSpace("signed", 1);
    writeFileSync(join(dirname(s.auth["opts"].callersFile), "fleet-callers.json"), "{ nope");
    expect(s.auth.mode).toBe("enforce");
  });
});

describe("the client of a fleet asks which member it is calling, and signs for it", () => {
  /** A gateway that sends every call to one device, as the gateway does for a fleet: the device is a CallerAuth over a fleet-callers file. */
  function device(options: { legacy?: boolean; primary?: boolean } = {}) {
    const d = scratch();
    const k = callerKey("client-key");
    const now = Date.now();
    const callersFile = join(d, "callers.json");
    writeFileSync(
      join(d, "fleet-callers.json"),
      JSON.stringify({ version: 1, fleet: "acme", roster: "signed", primary: options.primary ?? true, primarySince: now - 120_000, writtenAt: now, callers: [{ pub: k.key.publicKeyB64, label: "x", addedAt: "" }] }),
    );
    const auth = new CallerAuth({ mode: "enforce", deviceId: "member-a", callersFile, stateDir: join(d, "state") });
    const seen: Array<{ target: string; tool: string; ran: boolean }> = [];
    const ran: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const raw = await req.text();
        const sig = req.headers.get("x-prime-call-sig") ?? undefined;
        const request = JSON.parse(raw) as { id: number; method: string; params?: { name?: string } };
        if (options.legacy) {
          // a device that does not know fleet calls: it runs whatever it is sent
          ran.push(request.params?.name ?? request.method);
          return Response.json({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "unknown tool" } });
        }
        const a = auth.admit({ raw, ...(sig ? { callerSig: sig } : {}) });
        seen.push({ target: sig ? "signed" : "unsigned", tool: request.params?.name ?? request.method, ran: a.action === "run" });
        const answer = a.action === "refuse" ? a.response : { jsonrpc: "2.0", id: request.id, result: { ok: true } };
        if (a.action === "run") ran.push(request.params?.name ?? request.method);
        const text = JSON.stringify(answer);
        const replySig = a.reply ? auth.replySig(a.reply, text) : undefined;
        return new Response(text, { headers: { "content-type": "application/json", ...(replySig ? { "x-prime-reply-sig": replySig } : {}) } });
      },
    });
    return { url: "http://127.0.0.1:" + server.port, key: k, seen, ran, stop: () => void server.stop(true) };
  }
  const clientFor = (d: ReturnType<typeof device>) =>
    new GatewayClient({ deviceId: "acme", gateway: d.url, fleetBuddy: true, timeoutMs: 5000 } as never, { signer: new CallSigner({ path: join(dir, "client-key.pem") }), notice: () => undefined });

  test("asks first (a call that runs nothing), then makes the call for that member; the answer is kept for a few seconds", async () => {
    const d = device();
    try {
      // the client signs with the key the device lists
      writeFileSync(join(dir, "client-key.pem"), readFileSync(join(dir, "client-key.pem"), "utf8"));
      const c = clientFor(d);
      await c.rpc("tools/call", { name: "bash", arguments: { command: "id" } });
      expect(d.ran).toEqual(["bash"]);
      expect(d.seen.map((s) => [s.tool, s.ran])).toEqual([[FLEET_PROBE_TOOL, false], ["bash", true]]);
      await c.rpc("tools/call", { name: "read", arguments: {} });
      expect(d.seen.map((s) => s.tool)).toEqual([FLEET_PROBE_TOOL, "bash", "read"]);
    } finally {
      d.stop();
    }
  });

  test("a device that does not answer the question (older, or not checking) gets the call signed as before, and the question ran nothing there", async () => {
    const d = device({ legacy: true });
    try {
      const c = clientFor(d);
      await c.rpc("tools/call", { name: "bash", arguments: {} }).catch(() => undefined);
      // the question reached a device that runs what it is sent: it asked for a tool no device has
      expect(d.ran).toEqual([FLEET_PROBE_TOOL, "bash"]);
    } finally {
      d.stop();
    }
  });
  test("a call that is refused makes the next one ask again, and a replica that is sent a call says that it did not run it", async () => {
    const d = device({ primary: false });
    try {
      const c = clientFor(d);
      await expect(c.rpc("tools/call", { name: "bash", arguments: {} })).rejects.toThrow("did not run");
      expect(d.ran).toEqual([]);
      // a refusal is not answered by signing again (see the test of the gateway that runs a call and refuses it): one question, one call
      expect(d.seen.map((s) => s.tool)).toEqual([FLEET_PROBE_TOOL, "bash"]);
      await expect(c.rpc("tools/call", { name: "bash", arguments: {} })).rejects.toThrow();
      // the next call asks again
      expect(d.seen.map((s) => s.tool)).toEqual([FLEET_PROBE_TOOL, "bash", FLEET_PROBE_TOOL, "bash"]);
    } finally {
      d.stop();
    }
  });
});

describe("the client of a fleet when the question fails, and when the primary has moved", () => {
  /** Two members, a gateway that sends each request to the one that is current, and what goes wrong is chosen by the test. */
  function pair(options: { signReplies?: boolean } = {}) {
    const d = scratch();
    const k = callerKey("client-key");
    const now = Date.now();
    const members = ["member-a", "member-b"].map((id) => {
      const dir = join(d, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "fleet-callers.json"),
        JSON.stringify({ version: 1, fleet: "acme", roster: "signed", primary: true, primarySince: now - 120_000, writtenAt: now, callers: [{ pub: k.key.publicKeyB64, label: "x", addedAt: "" }] }),
      );
      return { id, auth: new CallerAuth({ mode: "enforce", deviceId: id, callersFile: join(dir, "callers.json"), stateDir: join(dir, "state") }) };
    });
    const st = { current: 0, ran: [] as string[], questions: 0, calls: 0, failQuestions: 0, failWith: "503" as "503" | "429" | "text" | "reset" };
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const raw = await req.text();
        const sig = req.headers.get("x-prime-call-sig") ?? undefined;
        const request = JSON.parse(raw) as { id: number; params?: { name?: string } };
        const m = members[st.current]!;
        if (request.params?.name === FLEET_PROBE_TOOL) {
          st.questions++;
          if (st.failQuestions > 0) {
            st.failQuestions--;
            if (st.failWith === "503") return new Response("down", { status: 503 });
            if (st.failWith === "429") return new Response("slow down", { status: 429 });
            if (st.failWith === "text") return new Response("<html>bad gateway</html>", { status: 200 });
          }
        } else st.calls++;
        const a = m.auth.admit({ raw, ...(sig ? { callerSig: sig } : {}) });
        const answer = a.action === "refuse" ? a.response : { jsonrpc: "2.0", id: request.id, result: { ok: true } };
        if (a.action === "run") st.ran.push(m.id + ":" + request.params?.name);
        const text = JSON.stringify(answer);
        const replySig = options.signReplies !== false && a.reply ? m.auth.replySig(a.reply, text) : undefined;
        return new Response(text, { headers: { "content-type": "application/json", ...(replySig ? { "x-prime-reply-sig": replySig } : {}) } });
      },
    });
    const client = () => new GatewayClient({ deviceId: "acme", gateway: "http://127.0.0.1:" + server.port, fleetBuddy: true, timeoutMs: 5000 } as never, { signer: new CallSigner({ path: join(dir, "client-key.pem") }), notice: () => undefined });
    return { st, client, stop: () => void server.stop(true) };
  }

  for (const failWith of ["503", "429", "text"] as const) {
    test(`a question that fails (${failWith}) is asked once more, and the call is made for the member that answers`, async () => {
      const p = pair();
      try {
        p.st.failQuestions = 1;
        p.st.failWith = failWith;
        await p.client().rpc("tools/call", { name: "bash", arguments: {} });
        expect(p.st.questions).toBe(2);
        expect(p.st.ran).toEqual(["member-a:bash"]);
      } finally {
        p.stop();
      }
    });
  }

  test("a question that fails twice is not remembered as 'this device is old': the next call asks again, and is signed for the member", async () => {
    const p = pair();
    try {
      p.st.failQuestions = 2;
      const c = p.client();
      // asked twice, no answer: the call goes out the old way, and an enforcing device refuses it saying so, and that it did not run
      const first = await c.rpc("tools/call", { name: "bash", arguments: {} }).catch((e: Error) => e);
      expect(String((first as Error).message)).toContain("did not run");
      expect(String((first as Error).message)).toContain("did not get through");
      expect(p.st.ran).toEqual([]);
      // a minute has not passed, and the client asks again at once
      await c.rpc("tools/call", { name: "bash", arguments: {} });
      expect(p.st.questions).toBe(3);
      expect(p.st.ran).toEqual(["member-a:bash"]);
    } finally {
      p.stop();
    }
  });

  test("the primary moved: the call that is refused is not sent again by the client; the user's next call asks again and runs on the new primary", async () => {
    const p = pair();
    try {
      const c = p.client();
      await c.rpc("tools/call", { name: "bash", arguments: { n: 1 } });
      p.st.current = 1; // the fleet's primary is now member-b; the client still has member-a for a few seconds
      await expect(c.rpc("tools/call", { name: "bash", arguments: { n: 2 } })).rejects.toThrow("signed by a key it trusts");
      expect(p.st.ran).toEqual(["member-a:bash"]);
      expect(p.st.calls).toBe(2); // not sent again
      await c.rpc("tools/call", { name: "bash", arguments: { n: 3 } });
      expect(p.st.ran).toEqual(["member-a:bash", "member-b:bash"]);
    } finally {
      p.stop();
    }
  });

  test("a gateway that has a call run and answers with a refusal it signed itself does not get the call run twice", async () => {
    const d = scratch();
    const k = callerKey("g1-client");
    const now = Date.now();
    writeFileSync(join(d, "fleet-callers.json"), JSON.stringify({ version: 1, fleet: "acme", roster: "signed", primary: true, primarySince: now - 120_000, writtenAt: now, callers: [{ pub: k.key.publicKeyB64, label: "x", addedAt: "" }] }));
    const member = new CallerAuth({ mode: "enforce", deviceId: "member-a", callersFile: join(d, "callers.json"), stateDir: join(d, "state") });
    const gatewayKey = new CallerAuth({ mode: "off", deviceId: "gw", callersFile: join(d, "gw-callers.json"), stateDir: join(d, "gw-state") });
    const ran: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const raw = await req.text();
        const sig = req.headers.get("x-prime-call-sig") ?? undefined;
        const request = JSON.parse(raw) as { id: number; params?: { name?: string } };
        const a = member.admit({ raw, ...(sig ? { callerSig: sig } : {}) });
        if (a.action === "refuse") {
          const text = JSON.stringify(a.response);
          const rs = a.reply ? member.replySig(a.reply, text) : undefined;
          return new Response(text, { headers: { "content-type": "application/json", ...(rs ? { "x-prime-reply-sig": rs } : {}) } });
        }
        ran.push(request.params?.name ?? "?"); // the member ran it; the gateway throws the answer away and says it did not
        const forged = JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32001, message: "not the primary; did not run", data: { reason: "not-primary" } } });
        const rs = gatewayKey.replySig({ nonce: parseCallSig(sig!)!.nonce, raw } as never, forged);
        return new Response(forged, { headers: { "content-type": "application/json", "x-prime-reply-sig": rs! } });
      },
    });
    try {
      const c = new GatewayClient({ deviceId: "acme", gateway: "http://127.0.0.1:" + server.port, fleetBuddy: true, timeoutMs: 5000 } as never, { signer: new CallSigner({ path: join(dir, "g1-client.pem") }), notice: () => undefined });
      await c.rpc("tools/call", { name: "bash", arguments: { command: "rm -rf build" } }).catch(() => undefined);
      expect(ran).toEqual(["bash"]);
    } finally {
      server.stop(true);
    }
  });
});

describe("a member that has taken a signed roster into account enforces, whatever the gateway says afterwards", () => {
  const unsigned = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bash", arguments: { command: "id" } } });
  const again = (n: number) => unsigned.replace('"id":1', `"id":${n}`);

  function gateway(owner: OwnerKey, laptop: ReturnType<typeof callerKey>) {
    const signed = chain(owner, [{ device: "dev-a", role: "member", spub: callerKey("enf-m").spub }], (add) => add({ op: "caller", spub: laptop.spub, extra: "laptop" }));
    const st = { mode: "signed" as "signed" | "open" };
    const server = Bun.serve({
      port: 0,
      fetch: (req) => (new URL(req.url).pathname === "/fleets/acme/roster" ? Response.json(st.mode === "signed" ? { mode: "signed", entries: signed } : { mode: "open", entries: [] }) : Response.json({ error: "no" }, { status: 404 })),
    });
    return { st, url: "http://127.0.0.1:" + server.port, stop: () => void server.stop(true) };
  }
  const loopOf = (secret: string, url: string, primary: boolean) =>
    ({ fleet: "acme", creds: { gateway: url, deviceId: "d", deviceToken: "t", timeoutMs: 2000 }, primary, paths: { keyFile: join(secret, "key") }, space: { secret_dir: secret } }) as unknown as CallersLoop;
  const authOf = (secret: string) => new CallerAuth({ deviceId: "space-1", callersFile: join(secret, "callers.json"), stateDir: join(secret, "st") });

  test("a gateway that stops serving the signed roster (open, an older prefix, another owner's chain) does not turn enforcement off", async () => {
    const secret = scratch();
    const g = gateway(generateOwnerKey(), callerKey("enf-laptop"));
    try {
      const loop = loopOf(secret, g.url, true);
      forgetRosterAnswers();
      await refreshFleetCallers(loop);
      const auth = authOf(secret);
      expect(auth.mode).toBe("enforce");
      expect(auth.admit({ raw: unsigned }).action).toBe("refuse");
      g.st.mode = "open";
      forgetRosterAnswers();
      loop.callersWriter!["rosterAt"] = 0;
      loop.callersWriter!["wasPrimary"] = true;
      await refreshFleetCallers(loop);
      const file = readFleetCallers(join(secret, "fleet-callers.json")).file!;
      expect(file.roster).toBe("refused");
      expect(file.callers).toEqual([]);
      expect(file.enforce).toBe(true);
      expect(auth.mode).toBe("enforce");
      expect(auth.admit({ raw: again(2) }).action).toBe("refuse");
    } finally {
      g.stop();
    }
  });

  test("a replica enforces too, and a former primary does, after the roster has been forgotten", async () => {
    const primary = scratch();
    const replica = scratch();
    const g = gateway(generateOwnerKey(), callerKey("enf-laptop2"));
    try {
      forgetRosterAnswers();
      await refreshFleetCallers(loopOf(primary, g.url, true));
      // a replica of the same member (its trust file is the one the primary's agent made), and the gateway is not asked at all
      FleetTrust.beside(join(primary, "key"));
      const trust = FleetTrust.beside(join(primary, "key"));
      expect(trust.ownerFp).toBeDefined();
      const loop = loopOf(primary, "http://127.0.0.1:9", false);
      loop.space.secret_dir = replica;
      await refreshFleetCallers(loop);
      const auth = authOf(replica);
      expect(readFleetCallers(join(replica, "fleet-callers.json")).file).toMatchObject({ primary: false, roster: "refused", enforce: true });
      expect(auth.mode).toBe("enforce");
      expect(auth.admit({ raw: unsigned }).action).toBe("refuse");
    } finally {
      g.stop();
    }
  });

  test("a member with nothing pinned and no roster seen does not enforce (nothing changes until the roster is signed)", async () => {
    const secret = scratch();
    const g = gateway(generateOwnerKey(), callerKey("enf-laptop3"));
    try {
      g.st.mode = "open";
      forgetRosterAnswers();
      await refreshFleetCallers(loopOf(secret, g.url, true));
      expect(readFleetCallers(join(secret, "fleet-callers.json")).file?.enforce).toBeUndefined();
      expect(authOf(secret).mode).toBe("warn");
    } finally {
      g.stop();
    }
  });

  test("a trust file that cannot be parsed does not turn enforcement off; one that is unpinned does, and the agent says so", async () => {
    const secret = scratch();
    const g = gateway(generateOwnerKey(), callerKey("enf-laptop5"));
    const logs: string[] = [];
    try {
      forgetRosterAnswers();
      const loop = loopOf(secret, g.url, true);
      await refreshFleetCallers(loop, (t) => logs.push(t));
      expect(readFleetCallers(join(secret, "fleet-callers.json")).file?.enforce).toBe(true);
      // the file is damaged: it says nothing, and the flag stays
      writeFileSync(join(secret, "key.trust.json"), "{ not json");
      loop.callersWriter!["lastWrite"] = 0;
      await refreshFleetCallers(loop, (t) => logs.push(t));
      expect(readFleetCallers(join(secret, "fleet-callers.json")).file?.enforce).toBe(true);
      expect(logs.join("\n")).not.toContain("no longer enforces");
      // a file that parses and pins nobody: the operator's unpin; it is written, and said
      writeFileSync(join(secret, "key.trust.json"), "{}");
      loop.callersWriter!["lastWrite"] = 0;
      await refreshFleetCallers(loop, (t) => logs.push(t));
      expect(readFleetCallers(join(secret, "fleet-callers.json")).file?.enforce).toBeUndefined();
      expect(logs.join("\n")).toContain("no longer enforces");
    } finally {
      g.stop();
    }
  });

  test("only the operator's unpin clears it", async () => {
    const secret = scratch();
    const g = gateway(generateOwnerKey(), callerKey("enf-laptop4"));
    try {
      forgetRosterAnswers();
      const loop = loopOf(secret, g.url, true);
      await refreshFleetCallers(loop);
      expect(readFleetCallers(join(secret, "fleet-callers.json")).file?.enforce).toBe(true);
      FleetTrust.unpinOwner(join(secret, "key"));
      loop.callersWriter!["lastWrite"] = 0;
      await refreshFleetCallers(loop);
      expect(readFleetCallers(join(secret, "fleet-callers.json")).file?.enforce).toBeUndefined();
    } finally {
      g.stop();
    }
  });
});
