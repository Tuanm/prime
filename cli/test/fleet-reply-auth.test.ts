// The replies of a fleet are a member's, as the owner's signed roster names it: the member's certificate for the key of the space,
// what the agent writes, what the space adds to its replies, and what a caller makes of them (and of a refusal, to try again).

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CallerAuth, replyCertOf, verifyReplySig } from "../src/caller-auth.ts";
import { GatewayClient } from "../src/client.ts";
import { CallSigner, FLEET_PROBE_TOOL, fleetMemberTarget, loadOrCreateCallerKey, parseCallSig, signCall } from "../src/caller-key.ts";
import { FleetCallersWriter, issueReplyCert } from "../src/fleet-callers-agent.ts";
import { readFleetCallers, replyKeyFileOf } from "../src/fleet-callers.ts";
import { REPLY_CERT_RENEW_MS, REPLY_CERT_TTL_MS, checkReplyCert, parseReplyCert, publicKeyOfPem, signReplyCert } from "../src/fleet-reply-cert.ts";
import { FleetAuthority, pinFleetOwner, pinnedFleetOwner, unpinFleetOwner } from "../src/fleet-reply-trust.ts";
import { type OwnerKey, type RosterEntry, type SignedEntry, entryHash, generateOwnerKey, makeEntry, ownerFingerprint, signEntry } from "../src/fleet-roster.ts";
import { containerArgs, entrypointScript, spaceCallerStateDir, spaceStateDir } from "../src/spaces.ts";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "prime-reply-auth-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const unsignedBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bash", arguments: { command: "id" } } });

/** An owner-signed chain naming these members (device, spub). */
function chainOf(owner: OwnerKey, members: Array<{ device: string; spub: string; role?: string }>, removed: string[] = []): SignedEntry[] {
  const entries: SignedEntry[] = [];
  const add = (f: Omit<Parameters<typeof makeEntry>[0], "fleet" | "incarnation" | "n" | "prevHash" | "at">): void => {
    const prev = entries[entries.length - 1];
    const e: RosterEntry = makeEntry({ ...f, fleet: "acme", incarnation: "inc-1", n: entries.length, prevHash: prev ? entryHash(prev) : null, at: 1_700_000_000_000 + entries.length });
    entries.push({ entry: e, sig: signEntry(e, owner.privateKeyPem) });
  };
  add({ op: "genesis", seqAt: 0, extra: owner.publicKey });
  for (const m of members) add({ op: "add", device: m.device, xpub: Buffer.from(m.device).toString("base64"), spub: m.spub, role: m.role ?? "member", seqAt: 0 });
  for (const device of removed) add({ op: "remove", device, seqAt: 1 });
  return entries;
}

describe("the certificate", () => {
  const sign = generateOwnerKey();
  const subject = { fleet: "acme", device: "space-1", replyKey: "A".repeat(43) };

  test("is good for the fleet, the device and the key it was made for, and for nothing else", () => {
    const now = 1_800_000_000_000;
    const cert = parseReplyCert(signReplyCert(sign.privateKeyPem, subject, now + REPLY_CERT_TTL_MS))!;
    expect(cert.spub).toBe(sign.publicKey);
    expect(checkReplyCert(cert, subject, now)).toBe(true);
    expect(checkReplyCert(cert, { ...subject, fleet: "other" }, now)).toBe(false);
    expect(checkReplyCert(cert, { ...subject, device: "space-2" }, now)).toBe(false);
    expect(checkReplyCert(cert, { ...subject, replyKey: "B".repeat(43) }, now)).toBe(false);
    expect(checkReplyCert(cert, subject, now + REPLY_CERT_TTL_MS + 1)).toBe(false);
  });

  test("one that claims to last longer than this build makes them, or whose signature is changed, is not good", () => {
    const now = 1_800_000_000_000;
    const long = parseReplyCert(signReplyCert(sign.privateKeyPem, subject, now + 10 * REPLY_CERT_TTL_MS))!;
    expect(checkReplyCert(long, subject, now)).toBe(false);
    const good = signReplyCert(sign.privateKeyPem, subject, now + REPLY_CERT_TTL_MS);
    const bytes = good.split(":");
    const flipped = parseReplyCert([...bytes.slice(0, 3), (bytes[3]![0] === "A" ? "B" : "A") + bytes[3]!.slice(1)].join(":"))!;
    expect(checkReplyCert(flipped, subject, now)).toBe(false);
  });

  test("text that is not a certificate is not parsed", () => {
    for (const bad of ["", "c1", "c1:a:b:c", "c2:" + "A".repeat(43) + ":1:" + "A".repeat(86), "c1:" + "A".repeat(43) + ":x:" + "A".repeat(86), "c1." + "A".repeat(43) + ".1." + "A".repeat(86)]) {
      expect(parseReplyCert(bad)).toBeUndefined();
    }
  });
});

/** A fleet member's space: its secret dir (with the file the agent writes), its tool server's auth, and the member's signing key. */
function memberSpace(id: string, caller: { publicKeyB64: string }, options: { primary: boolean; sign?: OwnerKey }) {
  const root = scratch();
  const secretDir = join(root, "secret");
  mkdirSync(secretDir, { recursive: true });
  // where the entrypoint of a space puts the state of its tool server (--caller-state): not made up here
  const stateDir = spaceCallerStateDir(secretDir);
  mkdirSync(stateDir, { recursive: true });
  const sign = options.sign ?? generateOwnerKey();
  const keyFile = join(root, "member-key.json");
  writeFileSync(keyFile, JSON.stringify({ publicKey: "x", privateKey: "y", sign: { publicKey: sign.publicKey, privateKey: sign.privateKeyPem } }), { mode: 0o600 });
  // the space has made its reply key (it does at its first signed reply)
  loadOrCreateCallerKey(replyKeyFileOf(secretDir));
  const writer = new FleetCallersWriter(join(secretDir, "fleet-callers.json"), "acme");
  writer.setRoster({ open: true });
  const loop = { fleet: "acme", creds: { deviceId: id }, paths: { keyFile }, space: { secret_dir: secretDir }, primary: options.primary } as never;
  const write = (now?: number) => {
    issueReplyCert(loop, writer, secretDir, () => undefined, now);
    // a signed roster listing the caller (what the agent writes after reading the roster)
    writer.setRoster({ open: true });
    writer.update(options.primary);
  };
  write();
  // the callers are listed by the roster; this file is made the way the agent makes it, with the caller added by hand since no roster is read here
  const file = join(secretDir, "fleet-callers.json");
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...parsed, roster: "signed", primarySince: Date.now() - 120_000, callers: [{ pub: caller.publicKeyB64, label: "x", addedAt: "" }] }));
  const auth = new CallerAuth({ mode: "enforce", deviceId: id, callersFile: join(secretDir, "callers.json"), stateDir });
  return { id, secretDir, stateDir, sign, auth, writer, keyFile, loop };
}

describe("where the reply key is", () => {
  test("the agent looks where the space's tool server keeps it: the --caller-state of the entrypoint, under the state directory that is mounted", () => {
    const secret = join(scratch(), "secret");
    expect(replyKeyFileOf(secret)).toBe(join(spaceCallerStateDir(secret), "device-ed25519.pem"));
    expect(replyKeyFileOf(secret + "/")).toBe(replyKeyFileOf(secret));
    // the entrypoint passes that directory as --caller-state, and mounts the state directory where it says
    const script = entrypointScript({ id: "s", runtime: "docker", image: "i", mode: "ephemeral", container: "c", token: "t" } as never);
    expect(script).toContain("--caller-state /run/prime-state/caller-auth");
    const args = containerArgs({ kind: "podman" } as never, { id: "s", runtime: "podman", image: "i", mode: "ephemeral", container: "c", token: "t", port: 7777 } as never, "img", secret);
    expect(args).toContain(spaceStateDir(secret) + ":/run/prime-state");
    // and a space's tool server run as the entrypoint says makes its key there
    const state = spaceCallerStateDir(secret);
    mkdirSync(state, { recursive: true });
    const auth = new CallerAuth({ mode: "enforce", deviceId: "space-1", callersFile: join(secret, "callers.json"), stateDir: state });
    auth.replySig({ nonce: "n", raw: "{}" }, "{}");
    expect(existsSync(replyKeyFileOf(secret))).toBe(true);
  });

  test("a reply key that is a link, a named pipe or is not a key is not read, says so once, and certifies nothing", () => {
    const caller = loadOrCreateCallerKey(join(scratch(), "c.pem"));
    const m = memberSpace("space-1", caller, { primary: true });
    const said: string[] = [];
    const key = replyKeyFileOf(m.secretDir);
    const other = join(scratch(), "host.pem");
    writeFileSync(other, readFileSync(key, "utf8"));
    rmSync(key);
    if (process.platform !== "win32") {
      symlinkSync(other, key);
      m.writer.setReplyCert(undefined);
      issueReplyCert(m.loop, m.writer, m.secretDir, (t) => said.push(t));
      expect(m.writer.currentReplyCert()).toBeUndefined();
      expect(said.join("\n")).toContain("is a link");
      rmSync(key);
      // a named pipe that nobody writes to: refused at once, in a child so that a wait is a failure and not a hang
      expect(Bun.spawnSync(["mkfifo", key], { timeout: 10_000 }).exitCode).toBe(0);
      const script = `import { readControlledFile } from ${JSON.stringify(join(import.meta.dir, "..", "src", "safe-file.ts"))};
        try { readControlledFile(${JSON.stringify(key)}, 16384); console.log("read"); } catch (e) { console.log(String(e)); }`;
      const r = Bun.spawnSync(["bun", "-e", script], { timeout: 8_000, stdout: "pipe", stderr: "pipe" });
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).toContain("not a regular file");
      rmSync(key);
    }
    writeFileSync(key, "x".repeat(100_000));
    issueReplyCert(m.loop, m.writer, m.secretDir, () => undefined);
    expect(m.writer.currentReplyCert()).toBeUndefined();
  });
});

describe("what the agent writes and the space adds", () => {
  test("the agent certifies the key the space replies with, and makes a new certificate when the key changes or the old one is half gone", () => {
    const caller = loadOrCreateCallerKey(join(scratch(), "c.pem"));
    const m = memberSpace("space-1", caller, { primary: true });
    const first = readFleetCallers(join(m.secretDir, "fleet-callers.json")).file!.replyCert!;
    const replyPub = publicKeyOfPem(readFileSync(replyKeyFileOf(m.secretDir), "utf8"));
    expect(first.key).toBe(replyPub);
    expect(checkReplyCert(parseReplyCert(first.cert)!, { fleet: "acme", device: "space-1", replyKey: replyPub }, Date.now())).toBe(true);
    // nothing to do while it has plenty left
    issueReplyCert(m.loop, m.writer, m.secretDir, () => undefined, Date.now() + 1000);
    expect(m.writer.currentReplyCert()!.cert).toBe(first.cert);
    // less than the renewal limit left: a new one
    issueReplyCert(m.loop, m.writer, m.secretDir, () => undefined, Date.now() + REPLY_CERT_TTL_MS - REPLY_CERT_RENEW_MS + 60_000);
    expect(m.writer.currentReplyCert()!.cert).not.toBe(first.cert);
    // the key changed: certified again, for the new key
    rmSync(replyKeyFileOf(m.secretDir));
    loadOrCreateCallerKey(replyKeyFileOf(m.secretDir));
    issueReplyCert(m.loop, m.writer, m.secretDir, () => undefined);
    expect(m.writer.currentReplyCert()!.key).not.toBe(first.key);
  });

  test("a member that rotated its keys (a new signing key) certifies the reply key again, with the new one, at once", () => {
    const caller = loadOrCreateCallerKey(join(scratch(), "c.pem"));
    const m = memberSpace("space-1", caller, { primary: true });
    const first = m.writer.currentReplyCert()!;
    expect(parseReplyCert(first.cert)!.spub).toBe(m.sign.publicKey);
    const next = generateOwnerKey();
    writeFileSync(m.keyFile, JSON.stringify({ publicKey: "x", privateKey: "y", sign: { publicKey: next.publicKey, privateKey: next.privateKeyPem } }), { mode: 0o600 });
    issueReplyCert(m.loop, m.writer, m.secretDir, () => undefined);
    const after = m.writer.currentReplyCert()!;
    expect(after.cert).not.toBe(first.cert);
    expect(parseReplyCert(after.cert)!.spub).toBe(next.publicKey);
  });

  test("no key to certify, no certificate", () => {
    const caller = loadOrCreateCallerKey(join(scratch(), "c.pem"));
    const m = memberSpace("space-1", caller, { primary: true });
    rmSync(replyKeyFileOf(m.secretDir));
    issueReplyCert(m.loop, m.writer, m.secretDir, () => undefined);
    expect(m.writer.currentReplyCert()).toBeUndefined();
  });

  test("the certificate goes with the replies to a call that names the member, and the question which member it is; not with the others (an older client does not read it)", () => {
    const caller = new CallSigner({ path: join(scratch(), "c.pem") });
    const m = memberSpace("space-1", { publicKeyB64: caller.callerKey()!.publicKeyB64 }, { primary: true });
    const sigOf = (member: string | undefined) => {
      const header = caller.header("tools/call", { deviceId: "acme", fleetBuddy: true, ...(member !== undefined ? { member } : {}) }, unsignedBody)!;
      const adm = m.auth.admit({ raw: unsignedBody, callerSig: header });
      return { adm, sig: adm.reply ? m.auth.replySig(adm.reply, "{}") : undefined };
    };
    expect(replyCertOf(sigOf("space-1").sig!)).toBeDefined(); // the call
    expect(replyCertOf(sigOf("").sig!)).toBeDefined(); // the question
    const legacy = sigOf(undefined); // the form an older prime signs
    expect(legacy.adm.action).toBe("refuse");
    expect(legacy.sig).toBeDefined();
    expect(replyCertOf(legacy.sig!)).toBeUndefined();
    const other = sigOf("space-2"); // made for another member
    expect(other.adm.action).toBe("refuse");
    expect(replyCertOf(other.sig!)).toBeUndefined();
  });

  test("a call that a member refused, signed, is not run by it after a restart, when it is the primary then (a call signed 50 s ahead)", () => {
    const caller = new CallSigner({ path: join(scratch(), "c.pem") });
    const key = caller.callerKey()!;
    const m = memberSpace("space-1", { publicKeyB64: key.publicKeyB64 }, { primary: false });
    const raw = unsignedBody.replace('"id":1', '"id":9');
    const sig = signCall(key, fleetMemberTarget("acme", "space-1"), raw, { now: Date.now() + 50_000 });
    const first = m.auth.admit({ raw, callerSig: sig });
    expect(first.action).toBe("refuse");
    expect(first.reply).toBeDefined(); // signed: "it did not run"
    // the tool server restarts (a new process, the same state directory), and the member becomes the primary
    const restarted = new CallerAuth({ mode: "enforce", deviceId: "space-1", callersFile: join(m.secretDir, "callers.json"), stateDir: m.stateDir });
    const file = join(m.secretDir, "fleet-callers.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), primary: true, primarySince: Date.now() - 600_000, writtenAt: Date.now() }));
    const again = restarted.admit({ raw, callerSig: sig });
    expect(again.action).toBe("refuse");
    if (again.action === "refuse") expect(again.response.error.data.reason).toBe("replay");
    // without the restart's memory it would have run: another state directory knows nothing of it
    const forgetful = new CallerAuth({ mode: "enforce", deviceId: "space-1", callersFile: join(m.secretDir, "callers.json"), stateDir: scratch() });
    expect(forgetful.admit({ raw, callerSig: sig }).action).toBe("run");
  });

  test("the nonces that are kept over a restart are bounded and run out with their calls; one that cannot be kept makes the refusal unsigned", () => {
    const caller = new CallSigner({ path: join(scratch(), "c.pem") });
    const key = caller.callerKey()!;
    const m = memberSpace("space-1", { publicKeyB64: key.publicKeyB64 }, { primary: false });
    const file = join(m.stateDir, "retired-nonces.jsonl");
    const refuse = (n: number, auth = m.auth) => {
      const raw = unsignedBody.replace('"id":1', `"id":${n}`);
      return auth.admit({ raw, callerSig: signCall(key, fleetMemberTarget("acme", "space-1"), raw) });
    };
    expect(refuse(1).reply).toBeDefined();
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
    // lines of calls that have run out are dropped when the file is read at the start
    const old = JSON.stringify({ n: "old", t: Date.now() - 20 * 60_000 });
    writeFileSync(file, readFileSync(file, "utf8") + old + "\n" + "not json\n");
    new CallerAuth({ mode: "enforce", deviceId: "space-1", callersFile: join(m.secretDir, "callers.json"), stateDir: m.stateDir });
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
    // a state directory that cannot be written: the refusal goes unsigned (the caller is told it may or may not have run)
    const blocked = new CallerAuth({ mode: "enforce", deviceId: "space-1", callersFile: join(m.secretDir, "callers.json"), stateDir: join(file, "under-a-file") });
    expect(refuse(2, blocked).reply).toBeUndefined();
  });

  test("a reply to a call made for the fleet carries the certificate, one to a call for the device does not", () => {
    const caller = new CallSigner({ path: join(scratch(), "c.pem") });
    const key = caller.callerKey()!;
    const m = memberSpace("space-1", { publicKeyB64: key.publicKeyB64 }, { primary: true });
    const asked = (target: string) => {
      const header = caller.header("tools/call", target === "fleet" ? { deviceId: "acme", fleetBuddy: true, member: "space-1" } : { deviceId: "space-1" }, unsignedBody)!;
      return { header, admission: m.auth.admit({ raw: unsignedBody, callerSig: header }) };
    };
    const fleet = asked("fleet");
    expect(fleet.admission.action).toBe("run");
    if (fleet.admission.action !== "run") throw new Error("not run");
    const sig = m.auth.replySig(fleet.admission.reply!, "{}")!;
    expect(replyCertOf(sig)).toBeDefined();
    expect(verifyReplySig(sig, parseCallSig(fleet.header)!.nonce, unsignedBody, "{}")).toBeDefined();
  });

  test("a certificate for another key, or one that has run out, is not added", () => {
    const caller = new CallSigner({ path: join(scratch(), "c.pem") });
    const key = caller.callerKey()!;
    const m = memberSpace("space-1", { publicKeyB64: key.publicKeyB64 }, { primary: true });
    const file = join(m.secretDir, "fleet-callers.json");
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...parsed, replyCert: { ...parsed.replyCert, key: "B".repeat(43) } }));
    const header = caller.header("tools/call", { deviceId: "acme", fleetBuddy: true, member: "space-1" }, unsignedBody)!;
    const adm = m.auth.admit({ raw: unsignedBody, callerSig: header });
    if (adm.action !== "run") throw new Error("not run");
    expect(replyCertOf(m.auth.replySig(adm.reply!, "{}")!)).toBeUndefined();
  });
});

describe("what a caller makes of a reply", () => {
  const owner = generateOwnerKey();
  const fp = ownerFingerprint(owner.publicKey);

  function authority(members: Array<{ device: string; spub: string; role?: string }>, options: { chainOwner?: OwnerKey; pin?: boolean } = {}) {
    const pins = join(scratch(), "owners.json");
    const gateway = "http://gw.test";
    if (options.pin !== false) pinFleetOwner(gateway, "acme", fp, pins);
    const entries = chainOf(options.chainOwner ?? owner, members);
    const fetchFn = (async () => Response.json({ mode: "signed", entries })) as unknown as typeof fetch;
    return { pins, gateway, authority: new FleetAuthority({ gateway, fleet: "acme", headers: () => ({}), fetchFn, pinsPath: pins }) };
  }

  /** A reply of a member to a call, as the space signs it. */
  function replyOf(m: ReturnType<typeof memberSpace>, caller: CallSigner, text = "{}") {
    const header = caller.header("tools/call", { deviceId: "acme", fleetBuddy: true, member: m.id }, unsignedBody)!;
    const adm = m.auth.admit({ raw: unsignedBody, callerSig: header });
    const binding = adm.action === "run" ? adm.reply! : adm.reply!;
    return { sig: m.auth.replySig(binding, text)!, nonce: parseCallSig(header)!.nonce, text };
  }

  test("a member that the owner's roster names vouches for its reply; nobody else does", async () => {
    const caller = new CallSigner({ path: join(scratch(), "c.pem") });
    const m = memberSpace("space-1", { publicKeyB64: caller.callerKey()!.publicKeyB64 }, { primary: true });
    const r = replyOf(m, caller);
    const ok = authority([{ device: "space-1", spub: m.sign.publicKey }]);
    expect(await ok.authority.certifiedBy(r.sig, r.nonce, unsignedBody, r.text, "space-1")).toBe(true);
    // the reply was changed
    expect(await ok.authority.certifiedBy(r.sig, r.nonce, unsignedBody, "{ }", "space-1")).toBe(false);
    // the call was made for another member
    expect(await ok.authority.certifiedBy(r.sig, r.nonce, unsignedBody, r.text, "space-2")).toBe(false);
    // the roster does not name that key for that device, or names it as a viewer
    expect(await authority([{ device: "space-1", spub: generateOwnerKey().publicKey }]).authority.certifiedBy(r.sig, r.nonce, unsignedBody, r.text, "space-1")).toBe(false);
    expect(await authority([{ device: "space-1", spub: m.sign.publicKey, role: "viewer" }]).authority.certifiedBy(r.sig, r.nonce, unsignedBody, r.text, "space-1")).toBe(false);
  });

  test("a member that was removed does not vouch for a retry, though the roster that listed it is cached (the retry reads it again)", async () => {
    const caller = new CallSigner({ path: join(scratch(), "c.pem") });
    const m = memberSpace("space-1", { publicKeyB64: caller.callerKey()!.publicKeyB64 }, { primary: true });
    const r = replyOf(m, caller);
    const pins = join(scratch(), "owners.json");
    pinFleetOwner("http://gw.test", "acme", fp, pins);
    let removed = false;
    const fetchFn = (async () => Response.json({ mode: "signed", entries: chainOf(owner, [{ device: "space-1", spub: m.sign.publicKey }], removed ? ["space-1"] : []) })) as unknown as typeof fetch;
    const a = new FleetAuthority({ gateway: "http://gw.test", fleet: "acme", headers: () => ({}), fetchFn, pinsPath: pins });
    expect(await a.certifiedBy(r.sig, r.nonce, unsignedBody, r.text, "space-1")).toBe(true);
    removed = true;
    expect(await a.certifiedBy(r.sig, r.nonce, unsignedBody, r.text, "space-1")).toBe(true); // the cache, for a minute
    expect(await a.certifiedBy(r.sig, r.nonce, unsignedBody, r.text, "space-1", { fresh: true })).toBe(false);
  });

  test("it is said once a day for a fleet that its replies are not authenticated, not once for each process", () => {
    const pins = join(scratch(), "owners.json");
    let now = 1_800_000_000_000;
    const a = () => new FleetAuthority({ gateway: "http://gw.test", fleet: "acme", headers: () => ({}), pinsPath: pins, now: () => now });
    expect(a().shouldSayUnpinned()).toBe(true);
    expect(a().shouldSayUnpinned()).toBe(false); // another process
    now += 25 * 60 * 60_000;
    expect(a().shouldSayUnpinned()).toBe(true);
  });

  test("a roster that is another owner's, or no owner pinned, vouches for nothing", async () => {
    const caller = new CallSigner({ path: join(scratch(), "c.pem") });
    const m = memberSpace("space-1", { publicKeyB64: caller.callerKey()!.publicKeyB64 }, { primary: true });
    const r = replyOf(m, caller);
    const gatewayOwner = generateOwnerKey();
    const forged = authority([{ device: "space-1", spub: m.sign.publicKey }], { chainOwner: gatewayOwner });
    expect(await forged.authority.certifiedBy(r.sig, r.nonce, unsignedBody, r.text, "space-1")).toBe(false);
    expect(forged.authority.lastFailure()).toContain("not the one this member pinned");
    const unpinned = authority([{ device: "space-1", spub: m.sign.publicKey }], { pin: false });
    expect(unpinned.authority.pinned()).toBe(false);
    expect(await unpinned.authority.certifiedBy(r.sig, r.nonce, unsignedBody, r.text, "space-1")).toBe(false);
  });

  test("the pins are kept per fleet and gateway, and taken back", () => {
    const pins = join(scratch(), "owners.json");
    expect(pinnedFleetOwner("http://gw.test/", "acme", pins)).toBeUndefined();
    pinFleetOwner("http://gw.test", "acme", fp, pins);
    expect(pinnedFleetOwner("http://gw.test/", "acme", pins)?.ownerFp).toBe(fp.replace(/-/g, ""));
    expect(pinnedFleetOwner("http://other.test", "acme", pins)).toBeUndefined();
    expect(unpinFleetOwner("http://gw.test", "acme", pins)).toBe(true);
    expect(existsSync(pins)).toBe(true);
    expect(pinnedFleetOwner("http://gw.test", "acme", pins)).toBeUndefined();
  });
});

describe("a call that is refused is made again once, and only when a member of the roster says it did not run", () => {
  const owner = generateOwnerKey();
  const fp = ownerFingerprint(owner.publicKey);

  function fleet(options: { signReplies?: boolean } = {}) {
    const clientPath = join(scratch(), "client.pem");
    const signer = new CallSigner({ path: clientPath });
    const callerKey = { publicKeyB64: signer.callerKey()!.publicKeyB64 };
    const a = memberSpace("member-a", callerKey, { primary: false });
    const b = memberSpace("member-b", callerKey, { primary: true });
    const members = [a, b];
    const entries = chainOf(owner, members.map((m) => ({ device: m.id, spub: m.sign.publicKey })));
    const st = { current: 0, ran: [] as string[], calls: 0, forge: false, rosterReads: [] as Array<Record<string, string | null>> };
    const gatewayKey = new CallerAuth({ mode: "off", deviceId: "gw", callersFile: join(scratch(), "gw-callers.json"), stateDir: scratch() });
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/fleets/acme/roster") {
          st.rosterReads.push({ device: req.headers.get("x-prime-device"), token: req.headers.get("x-device-token"), method: req.method });
          return Response.json({ mode: "signed", entries });
        }
        const raw = await req.text();
        const sig = req.headers.get("x-prime-call-sig") ?? undefined;
        const request = JSON.parse(raw) as { id: number; params?: { name?: string } };
        const m = members[st.current]!;
        if (request.params?.name !== FLEET_PROBE_TOOL) st.calls++;
        const adm = m.auth.admit({ raw, ...(sig ? { callerSig: sig } : {}) });
        const answer = adm.action === "refuse" ? adm.response : { jsonrpc: "2.0", id: request.id, result: { ok: true } };
        if (adm.action === "run" && request.params?.name !== FLEET_PROBE_TOOL) st.ran.push(m.id + ":" + request.params?.name);
        if (adm.action === "run" && st.forge) {
          // the gateway lets the call run, throws the answer away, and refuses it in the name of a key of its own
          const forged = JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32001, message: "not the primary; did not run", data: { reason: "not-primary" } } });
          const own = gatewayKey.replySig({ nonce: parseCallSig(sig!)!.nonce, raw } as never, forged)!;
          // ... with the member's certificate for its own key, which it has seen
          const copied = adm.reply ? replyCertOf(m.auth.replySig(adm.reply, "{}")!) : undefined;
          return new Response(forged, { headers: { "content-type": "application/json", "x-prime-reply-sig": copied ? `${own}.${copied}` : own } });
        }
        const text = JSON.stringify(answer);
        const rs = options.signReplies === false ? undefined : adm.reply ? m.auth.replySig(adm.reply, text) : undefined;
        return new Response(text, { headers: { "content-type": "application/json", ...(rs ? { "x-prime-reply-sig": rs } : {}) } });
      },
    });
    const gateway = "http://127.0.0.1:" + server.port;
    const pins = join(scratch(), "owners.json");
    pinFleetOwner(gateway, "acme", fp, pins);
    const said: string[] = [];
    // the client finds the pinned owners where PRIME_FLEET_OWNERS says, and reads the roster with the credentials it calls with
    const saved = process.env.PRIME_FLEET_OWNERS;
    const client = (pin = true) => {
      process.env.PRIME_FLEET_OWNERS = pin ? pins : join(scratch(), "none.json");
      return new GatewayClient({ deviceId: "acme", gateway, fleetBuddy: true, deviceToken: "buddy-token", timeoutMs: 5000 } as never, { signer, notice: (t) => said.push(t) });
    };
    return { st, client, said, a, b, stop: () => {
        if (saved === undefined) delete process.env.PRIME_FLEET_OWNERS;
        else process.env.PRIME_FLEET_OWNERS = saved;
        void server.stop(true);
      } };
  }

  test("the refusal is certified by the member the call was made for: exactly one more call is made, and runs on the member the fleet has now", async () => {
    const f = fleet();
    try {
      const c = f.client();
      // the call is asked of member-a (a replica): the question is answered by a, the call is refused by a, certified; the gateway then sends to b
      let flipped = false;
      const original = f.a.auth.admit.bind(f.a.auth);
      f.a.auth.admit = (frame) => {
        const adm = original(frame);
        if (adm.action === "refuse" && adm.response.error.data.reason === "not-primary") f.st.current = 1;
        flipped = true;
        return adm;
      };
      await c.rpc("tools/call", { name: "bash", arguments: { command: "id" } });
      expect(flipped).toBe(true);
      expect(f.st.ran).toEqual(["member-b:bash"]);
      expect(f.st.calls).toBe(2); // the refused one, and the one made again
      // the roster is read as the gateway lets a buddy read it: as the fleet, with its token, and only that
      expect(f.st.rosterReads).toEqual([{ device: "acme", token: "buddy-token", method: "GET" }]);
    } finally {
      f.stop();
    }
  });

  test("a gateway that has the call run and refuses it with a signature of its own does not get it run twice (nor with a certificate it copied)", async () => {
    const f = fleet();
    try {
      f.st.current = 1;
      f.st.forge = true;
      const c = f.client();
      await c.rpc("tools/call", { name: "bash", arguments: { command: "rm -rf build" } }).catch(() => undefined);
      expect(f.st.ran).toEqual(["member-b:bash"]);
      expect(f.st.calls).toBe(1);
    } finally {
      f.stop();
    }
  });

  test("with no owner pinned on this machine a refusal is not acted on, and the client says the replies are not authenticated", async () => {
    const f = fleet();
    try {
      const c = f.client(false);
      const ranBefore = f.st.calls;
      f.a.auth.admit = ((original) => (frame: never) => {
        const adm = original(frame);
        if (adm.action === "refuse") f.st.current = 1;
        return adm;
      })(f.a.auth.admit.bind(f.a.auth));
      await c.rpc("tools/call", { name: "bash", arguments: {} }).catch(() => undefined);
      expect(f.st.ran).toEqual([]);
      expect(f.st.calls - ranBefore).toBe(1);
      expect(f.said.join("\n")).toContain("not authenticated");
      expect(f.said.join("\n")).toContain("prime fleets roster pin-caller acme --owner");
    } finally {
      f.stop();
    }
  });
});
