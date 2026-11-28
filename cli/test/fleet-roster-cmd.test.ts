// `prime fleets roster ...`, the signed approve and remove, the invite with the owner key and the pin, against
// a gateway that keeps the chain the way the roster wire says (see docs/fleets.md, "The signed roster").
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fleetKeyFile, fleetsApprove, fleetsInvite, fleetsJoin, fleetsRemove, fleetsRoster, fleetsTrust } from "../src/fleets";
import { keyFingerprintOf } from "../src/fleet-crypto";
import { fleetKeyOf, generateOwnerKey, ownerFingerprint, parseInviteCode, readOwnerKey, verifyChain, type SignedEntry } from "../src/fleet-roster";
import { loadOrCreateSignKey } from "../src/fleet-agent";
import { FleetTrust } from "../src/fleet-trust";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

interface Fake {
  url: string;
  entries: SignedEntry[];
  signed: boolean;
  fenced: string[];
  head: number;
  /** What /remove-fence answers as seqAt; undefined: the head. */
  fenceAt: number | undefined;
  /** What /head answers from the second read on (the head moves between the reads). */
  headAfterFence: number | undefined;
  witness: Array<{ path: string; body: any }>;
  /** What POST /roster answers instead of taking the entry, once each (a gateway that wants another seqAt, or no device's genesis). */
  refuse: Array<{ status: number; error: string; code?: string }>;
  members: Array<Record<string, unknown>>;
  pending: Array<Record<string, unknown>>;
  stop(): void;
}

const xpubOf = (spub: string) => createHash("sha256").update(spub).digest().toString("base64");
const member = (id: string, role = "member") => {
  const k = generateOwnerKey();
  return { deviceId: id, role, pubkey: xpubOf(k.publicKey), spub: k.publicKey };
};

function fakeGateway(): Fake {
  const state: Fake = { url: "", entries: [], signed: false, fenced: [], head: 7, fenceAt: undefined, headAfterFence: undefined, witness: [], refuse: [], members: [], pending: [], stop: () => undefined };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      if (p === "/fleets/acme/roster" && req.method === "GET") return Response.json({ mode: state.signed ? "signed" : "open", incarnation: "inc-1", entries: state.entries });
      if (p === "/fleets/acme/roster" && req.method === "POST") {
        const refused = state.refuse.shift();
        if (refused) return Response.json({ error: refused.error, ...(refused.code ? { code: refused.code } : {}) }, { status: refused.status });
        try {
          const chain = [...state.entries, body as SignedEntry];
          verifyChain(chain, { fleet: "acme", incarnation: "inc-1" });
        } catch (e) {
          return Response.json({ error: (e as Error).message, expected: state.entries.length }, { status: 409 });
        }
        state.entries.push(body as SignedEntry);
        state.signed = true;
        return Response.json({ ok: true, n: state.entries.length - 1 });
      }
      if (p === "/fleets/acme/members") return Response.json({ ok: true, incarnation: "inc-1", members: state.members });
      if (p === "/fleets/acme/pending") return Response.json({ ok: true, pending: state.pending });
      if (p === "/fleets/acme/head") return Response.json({ ok: true, head: { seq: state.fenced.length > 0 && state.headAfterFence !== undefined ? state.headAfterFence : state.head } });
      if (p === "/fleets/acme/remove-fence") {
        state.fenced.push((body as { deviceId: string }).deviceId);
        return Response.json({ ok: true, seqAt: state.fenceAt ?? state.head });
      }
      if (p.startsWith("/w/") && p.endsWith("/remove")) {
        state.witness.push({ path: p, body });
        return Response.json({ ok: true });
      }
      if (p === "/fleets/acme/approve" || p === "/fleets/acme/remove") {
        if (state.signed) return Response.json({ error: "the roster is signed", rosterSigned: true }, { status: 409 });
        return Response.json({ ok: true });
      }
      if (p === "/fleets/acme/invite") return Response.json({ ok: true, code: "CODE-123", expiresAt: Date.now() + 600_000 });
      return Response.json({ error: "no" }, { status: 404 });
    },
  });
  state.url = "http://127.0.0.1:" + server.port;
  state.stop = () => server.stop(true);
  return state;
}

describe("the commands that sign a fleet's roster", () => {
  let dir: string;
  let gw: Fake;
  let keyFile: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "roster-cmd-"));
    keyFile = join(dir, "owner", "acme.pem");
    gw = fakeGateway();
  });
  afterAll(() => {
    gw.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const out: string[] = [];
  const ctx = (sub: string, positionals: string[], flags: Record<string, string | boolean> = {}) =>
    ({
      config: { defaults: { gateway: gw.url, fleet_operator_token: "op" }, devices: {}, spaces: {}, codeMcp: {} },
      configPath: join(dir, "config.yaml"),
      json: false,
      out: (l: string) => out.push(l),
      parsed: { positionals: ["fleets", sub, ...positionals], flags: new Map<string, string | boolean>(Object.entries({ "owner-key": keyFile, ...flags })), help: false },
    }) as never;
  const said = () => out.join("\n");
  // eslint-disable-next-line no-control-regex
  const digestShown = () => /--expect (\S+)/.exec(said().replace(/\u001b\[[0-9;]*m/g, ""))?.[1] ?? "";
  /** The dry run, then the run that signs exactly what it showed. */
  const initSigned = async (flags: Record<string, string | boolean> = {}) => {
    out.length = 0;
    await fleetsRoster(ctx("roster", ["init", "acme"], flags));
    const digest = digestShown();
    expect(digest).not.toBe("");
    await fleetsRoster(ctx("roster", ["init", "acme"], { ...flags, yes: true, expect: digest }));
  };

  test("init shows what it would sign and signs nothing without --yes", async () => {
    gw.members = [member("dev-1", "owner"), member("dev-2")];
    out.length = 0;
    await fleetsRoster(ctx("roster", ["init", "acme"]));
    expect(said()).toContain("nothing was signed or sent");
    expect(gw.entries.length).toBe(0);
    expect(existsSync(keyFile)).toBe(false);
  });

  test("init refuses a member that has not told the gateway its signing key", async () => {
    const bare = { ...member("dev-3"), spub: undefined };
    gw.members = [member("dev-1", "owner"), bare];
    await expect(fleetsRoster(ctx("roster", ["init", "acme"], { yes: true, expect: "x" }))).rejects.toThrow(/dev-3/);
    expect(gw.entries.length).toBe(0);
    expect(existsSync(keyFile)).toBe(false);
  });

  test("init --yes makes the owner key, a genesis and an add for each member, and never prints the key", async () => {
    gw.members = [member("dev-1", "owner"), member("dev-2")];
    out.length = 0;
    await initSigned();
    expect(gw.entries.length).toBe(3);
    const v = verifyChain(gw.entries, { fleet: "acme" });
    // the members were members before the chain: their place is from the start, so what they published before it is theirs
    expect(v.tenures.every((t) => t.from === 0)).toBe(true);
    expect(v.tenures.map((t) => t.device)).toEqual(["dev-1", "dev-2"]);
    expect(v.tenures[0]!.role).toBe("owner");
    if (process.platform !== "win32") expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    const key = readOwnerKey(keyFile);
    expect(v.owner).toBe(key.publicKey);
    expect(said()).toContain(ownerFingerprint(key.publicKey));
    expect(said()).not.toContain("PRIVATE KEY");
    expect(said()).not.toContain(key.privateKeyPem.split("\n")[1]!);
  });

  test("a second init adds only the member that is not in the roster yet", async () => {
    gw.members = [...gw.members, member("dev-4")];
    await initSigned();
    expect(gw.entries.length).toBe(4);
    const again = gw.entries.length;
    out.length = 0;
    await fleetsRoster(ctx("roster", ["init", "acme"]));
    expect(said()).toContain("already");
    expect(gw.entries.length).toBe(again);
  });

  test("--yes signs what was compared, and not what the gateway lists by then: a swapped key is refused and nothing is signed", async () => {
    const fresh = member("dev-9");
    gw.members = [...gw.members, fresh];
    out.length = 0;
    await fleetsRoster(ctx("roster", ["init", "acme"]));
    const digest = digestShown();
    const before = gw.entries.length;
    // between the two runs the gateway puts its own keys in place of dev-9's
    const swapped = member("dev-9");
    gw.members = gw.members.map((m) => (m.deviceId === "dev-9" ? swapped : m));
    await expect(fleetsRoster(ctx("roster", ["init", "acme"], { yes: true, expect: digest }))).rejects.toThrow(/not the ones that were shown/);
    expect(gw.entries.length).toBe(before);
    // --yes without what was compared is no signing either
    await expect(fleetsRoster(ctx("roster", ["init", "acme"], { yes: true }))).rejects.toThrow(/--expect/);
    expect(gw.entries.length).toBe(before);
    gw.members = gw.members.filter((m) => m.deviceId !== "dev-9");
  });

  test("the table shows both keys in full, so that they can be compared", async () => {
    const extra = member("dev-10");
    gw.members = [...gw.members, extra];
    out.length = 0;
    await fleetsRoster(ctx("roster", ["init", "acme"]));
    expect(said()).toContain(ownerFingerprint(extra.spub));
    expect(said()).toContain(keyFingerprintOf(extra.pubkey));
    gw.members = gw.members.filter((m) => m.deviceId !== "dev-10");
  });

  test("approve, once the roster is signed, is an add entry signed with the owner key, for the key that was compared", async () => {
    const fresh = member("dev-5");
    gw.pending = [{ ...fresh }];
    out.length = 0;
    await fleetsApprove(ctx("approve", ["acme"], { member: "dev-5", key: keyFingerprintOf(fresh.pubkey), "signing-key": ownerFingerprint(fresh.spub) }));
    const v = verifyChain(gw.entries, { fleet: "acme" });
    expect(v.tenures.find((t) => t.device === "dev-5")?.spub).toBe(fresh.spub);
    expect(said()).toContain("admitted dev-5");
    expect(said()).toContain("as member");
  });

  test("approve for a new member is signed again at the head when the gateway says the head moved", async () => {
    const fresh = member("dev-34");
    gw.pending = [fresh];
    gw.head = 40;
    gw.refuse = [{ status: 409, error: "head is at 41: sign it again at the head" }];
    const before = gw.entries.length;
    await fleetsApprove(ctx("approve", ["acme"], { member: "dev-34", key: keyFingerprintOf(fresh.pubkey), "signing-key": ownerFingerprint(fresh.spub) }));
    expect(gw.entries.length).toBe(before + 1);
    expect(gw.refuse.length).toBe(0);
    gw.head = 7;
  });

  test("approve for a new member is signed again when the gateway says it was asked to join at a later snapshot", async () => {
    const fresh = member("dev-35");
    gw.pending = [fresh];
    gw.head = 40;
    gw.refuse = [{ status: 409, error: "the add's seqAt 40 is before the head (41) the device asked to join at", code: "head-moved" }];
    const before = gw.entries.length;
    await fleetsApprove(ctx("approve", ["acme"], { member: "dev-35", key: keyFingerprintOf(fresh.pubkey), "signing-key": ownerFingerprint(fresh.spub) }));
    expect(gw.entries.length).toBe(before + 1);
    expect(gw.refuse.length).toBe(0);
    gw.head = 7;
  });

  test("a 409 with another code is not read as the head having moved, whatever its words say", async () => {
    const fresh = member("dev-36");
    gw.pending = [fresh];
    gw.refuse = [{ status: 409, error: "head is at 41: sign it again", code: "ahead-of-head" }];
    const before = gw.entries.length;
    await expect(fleetsApprove(ctx("approve", ["acme"], { member: "dev-36", key: keyFingerprintOf(fresh.pubkey), "signing-key": ownerFingerprint(fresh.spub) }))).rejects.toThrow();
    expect(gw.entries.length).toBe(before);
    gw.pending = [];
  });

  test("the genesis from a device is refused by the gateway, and the operator is told what to do", async () => {
    const was = { entries: gw.entries, signed: gw.signed };
    gw.entries = [];
    gw.signed = false;
    gw.refuse = [{ status: 403, error: "forbidden" }];
    try {
      await expect(fleetsRoster(ctx("roster", ["init", "acme"], { yes: true, expect: (await (async () => { out.length = 0; await fleetsRoster(ctx("roster", ["init", "acme"], { "owner-key": join(dir, "other-owner.pem") })); return digestShown(); })()), "owner-key": join(dir, "other-owner.pem") }))).rejects.toThrow(/only the operator/);
    } finally {
      gw.refuse = [];
      gw.entries = was.entries;
      gw.signed = was.signed;
    }
  });

  test("approve without --key signs nothing, and says which key the gateway offers", async () => {
    const offered = member("dev-6");
    gw.pending = [offered];
    const before = gw.entries.length;
    await expect(fleetsApprove(ctx("approve", ["acme"], { member: "dev-6" }))).rejects.toThrow(/the gateway is the one saying so/);
    expect(gw.entries.length).toBe(before);
  });

  test("approve for another key than the one compared is refused, and a plain approve never becomes a key change", async () => {
    const live = member("dev-5"); // a member already, offered under a new key
    gw.pending = [live];
    const before = gw.entries.length;
    await expect(fleetsApprove(ctx("approve", ["acme"], { member: "dev-5", key: "AAAAAAAAAAAA", "signing-key": ownerFingerprint(live.spub) }))).rejects.toThrow(/not the one you compared/);
    await expect(fleetsApprove(ctx("approve", ["acme"], { member: "dev-5", key: keyFingerprintOf(live.pubkey), "signing-key": ownerFingerprint(live.spub) }))).rejects.toThrow(/--rotate/);
    expect(gw.entries.length).toBe(before);
    await fleetsApprove(ctx("approve", ["acme"], { member: "dev-5", key: keyFingerprintOf(live.pubkey), "signing-key": ownerFingerprint(live.spub), rotate: true }));
    const v = verifyChain(gw.entries, { fleet: "acme" });
    expect(v.tenures.find((t) => t.device === "dev-5" && t.until === null)?.xpub).toBe(live.pubkey);
    const newcomer = member("dev-11");
    gw.pending = [newcomer];
    await expect(fleetsApprove(ctx("approve", ["acme"], { member: "dev-11", key: keyFingerprintOf(newcomer.pubkey), "signing-key": ownerFingerprint(newcomer.spub), rotate: true }))).rejects.toThrow(/not a member/);
  });

  test("approve signs the signing key the operator compared, and a signing key the gateway swapped in is refused with nothing signed", async () => {
    const joining = member("dev-33"); // what dev-33's own machine prints
    const gwOwn = generateOwnerKey(); // the gateway's own Ed25519 key, offered with dev-33's X25519 key
    gw.pending = [{ deviceId: "dev-33", pubkey: joining.pubkey, spub: gwOwn.publicKey, role: "member" }];
    const before = gw.entries.length;
    const key = keyFingerprintOf(joining.pubkey);
    await expect(fleetsApprove(ctx("approve", ["acme"], { member: "dev-33", key }))).rejects.toThrow(/signing key/);
    await expect(fleetsApprove(ctx("approve", ["acme"], { member: "dev-33", key, "signing-key": ownerFingerprint(joining.spub) }))).rejects.toThrow(/signing key of the request is/);
    // a prefix of either is not what was compared
    await expect(fleetsApprove(ctx("approve", ["acme"], { member: "dev-33", key: key.split(".")[0], "signing-key": ownerFingerprint(gwOwn.publicKey) }))).rejects.toThrow(/not the one you compared/);
    expect(gw.entries.length).toBe(before);
    await fleetsApprove(ctx("approve", ["acme"], { member: "dev-33", key, "signing-key": ownerFingerprint(gwOwn.publicKey).toLowerCase().replace(/-/g, "") }));
    expect(verifyChain(gw.entries, { fleet: "acme" }).tenures.find((t) => t.device === "dev-33")?.spub).toBe(gwOwn.publicKey);
  });

  test("approve refuses a request that offers no signing key", async () => {
    gw.pending = [{ deviceId: "dev-12", pubkey: xpubOf("x"), role: "member" }];
    const before = gw.entries.length;
    await expect(fleetsApprove(ctx("approve", ["acme"], { member: "dev-12", key: keyFingerprintOf(xpubOf("x")) }))).rejects.toThrow(/signing key/);
    expect(gw.entries.length).toBe(before);
  });

  test("remove fences the member first and signs the sequence the gateway named, and prints it with the head", async () => {
    gw.head = 12;
    out.length = 0;
    await fleetsRemove(ctx("remove", ["acme"], { member: "dev-2" }));
    expect(gw.fenced).toEqual(["dev-2"]);
    const v = verifyChain(gw.entries, { fleet: "acme" });
    const last = gw.entries[gw.entries.length - 1]!.entry;
    expect(last[6]).toBe("remove");
    expect(last[11]).toBe(12);
    expect(v.tenures.find((t) => t.device === "dev-2")?.until).toBe(12);
    expect(said()).toContain("as of snapshot 12");
    expect(said()).toContain("the head is 12");
    expect(said()).toContain("the witness was not told");
    await expect(fleetsRemove(ctx("remove", ["acme"], { member: "dev-2" }))).rejects.toThrow(/not a member/);
  });

  test("a fence at a sequence the head never had is not signed: a removed key would stay a sender for ever", async () => {
    gw.head = 20;
    try {
      gw.fenceAt = Number.MAX_SAFE_INTEGER;
      const before = gw.entries.length;
      await expect(fleetsRemove(ctx("remove", ["acme"], { member: "dev-4" }))).rejects.toThrow(/not a sequence it could have fenced at/);
      expect(gw.entries.length).toBe(before);
      // one in the past is no better
      gw.fenceAt = 3;
      await expect(fleetsRemove(ctx("remove", ["acme"], { member: "dev-4" }))).rejects.toThrow(/not a sequence it could have fenced at/);
      expect(gw.entries.length).toBe(before);
      // a publish that was in flight when the fence fell (the head is one past it afterwards) is let through
      gw.fenceAt = 20;
      gw.headAfterFence = 21;
      gw.fenced = [];
      await fleetsRemove(ctx("remove", ["acme"], { member: "dev-4" }));
      expect(gw.entries[gw.entries.length - 1]!.entry[11]).toBe(20);
    } finally {
      gw.fenceAt = undefined;
      gw.headAfterFence = undefined;
      gw.fenced = [];
    }
  });

  test("with a witness the removal is posted to it, as {genesis, entry, sig}, and a witness that refuses is said, not fatal", async () => {
    gw.head = 30;
    // (the real gateway no longer lists a member that was removed)
    gw.members = [...gw.members.filter((m) => !["dev-2", "dev-4"].includes(String(m.deviceId))), member("dev-13")];
    await initSigned();
    gw.witness = [];
    await fleetsRemove(ctx("remove", ["acme"], { member: "dev-13", witness: gw.url }));
    expect(gw.witness.length).toBe(1);
    const { path, body } = gw.witness[0]!;
    const last = gw.entries[gw.entries.length - 1]!;
    expect(path).toBe("/w/" + fleetKeyOf(gw.entries[0]!.entry) + "/remove");
    expect(body.genesis).toEqual(gw.entries[0]!.entry);
    expect(body.entry).toEqual(last.entry);
    expect(body.sig).toBe(last.sig);
    expect(said()).toContain("the witness was told");
    // the same entries, told again, by the command made for it
    gw.witness = [];
    out.length = 0;
    await fleetsRoster(ctx("roster", ["witness", "acme"], { witness: gw.url }));
    expect(gw.witness.length).toBeGreaterThanOrEqual(2); // dev-2, dev-4 and dev-13 were removed
    expect(said()).toContain("told the witness");
  });

  test("a machine without the owner key cannot change a signed roster", async () => {
    gw.pending = [member("dev-8")];
    const c = ctx("approve", ["acme"], { member: "dev-8", "owner-key": join(dir, "nowhere.pem") });
    await expect(fleetsApprove(c)).rejects.toThrow();
    // ... and one that holds another key is told so, not given a roster it cannot extend
    const stranger = join(dir, "stranger.pem");
    const { createOwnerKeyFile } = await import("../src/fleet-roster");
    createOwnerKeyFile(stranger);
    await expect(fleetsApprove(ctx("approve", ["acme"], { member: "dev-8", "owner-key": stranger }))).rejects.toThrow(/signed by the owner key/);
  });

  test("the invite names the owner key, and the code can be taken apart again", async () => {
    out.length = 0;
    await fleetsInvite(ctx("invite", ["acme"]));
    const fp = ownerFingerprint(readOwnerKey(keyFile).publicKey);
    expect(said()).toContain("CODE-123~" + fp);
    const parsed = parseInviteCode("CODE-123~" + fp);
    expect(parsed.code).toBe("CODE-123");
    expect(ownerFingerprint(readOwnerKey(keyFile).publicKey).replace(/-/g, "")).toBe(parsed.ownerFp!);
    expect(() => parseInviteCode("CODE~short")).toThrow(/fingerprint/);
  });

  test("a member pins the owner key; a join does not replace a pin, the operator's command does", () => {
    const keyPath = join(dir, "member", "acme.key");
    const a = ownerFingerprint(generateOwnerKey().publicKey);
    const b = ownerFingerprint(generateOwnerKey().publicKey);
    expect(FleetTrust.ownerPinned(keyPath)).toBeUndefined();
    FleetTrust.pinOwner(keyPath, a);
    expect(FleetTrust.ownerPinned(keyPath)).toBe(a.replace(/-/g, ""));
    expect(() => FleetTrust.pinOwner(keyPath, b)).toThrow(/another owner key/);
    expect(FleetTrust.pinOwner(keyPath, b, true).replaced).toBe(a.replace(/-/g, ""));
    expect(FleetTrust.ownerPinned(keyPath)).toBe(b.replace(/-/g, ""));
    expect(() => FleetTrust.pinOwner(keyPath, "nope")).toThrow(/fingerprint/);
  });

  test("roster show checks the chain and prints the owner key and the members", async () => {
    out.length = 0;
    await fleetsRoster(ctx("roster", ["show", "acme"]));
    expect(said()).toContain("signed roster");
    expect(said()).toContain("dev-1");
    expect(said()).not.toContain("dev-2");
  });

  test("roster show says so when the chain the gateway holds is tampered with", async () => {
    const saved = gw.entries[1]!;
    gw.entries[1] = { ...saved, entry: [...saved.entry.slice(0, 7), "dev-evil", ...saved.entry.slice(8)] as never };
    await expect(fleetsRoster(ctx("roster", ["show", "acme"]))).rejects.toThrow(/not valid/);
    gw.entries[1] = saved;
  });

  test("trust pin needs a fleet space and a well-formed fingerprint", async () => {
    await expect(fleetsTrust(ctx("trust", ["pin", "acme"], { space: "none", owner: "x" }))).rejects.toThrow(/owner/);
  });

  test("a join with the owner key in the code pins it and sends the gateway the code alone", async () => {
    const fp = ownerFingerprint(generateOwnerKey().publicKey);
    const cfg = join(dir, "joiner", "config.yaml");
    const sent: Array<Record<string, unknown>> = [];
    const real = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async (input: Request | string, init?: { body?: string }) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/me")) return Response.json({ ok: true, status: "none" });
      sent.push(JSON.parse(init?.body ?? "{}"));
      return Response.json({ status: "pending" });
    };
    try {
      const c = {
        parsed: { positionals: ["fleets", "join", "acme"], flags: new Map<string, string | boolean>([["code", "c0de~" + fp], ["device", "dev-9"], ["token", "t"], ["gateway", "https://gw.example"]]), help: false },
        config: { defaults: {}, devices: {}, spaces: {}, codeMcp: {} },
        configPath: cfg,
        json: true,
        out() {},
      } as never;
      await fleetsJoin(c);
    } finally {
      (globalThis as { fetch: unknown }).fetch = real;
    }
    expect(sent[0]!.code).toBe("c0de");
    // ... and tells the fleet the key it signs with, so the operator can put it in the roster
    expect(sent[0]!.spub).toBe(loadOrCreateSignKey(fleetKeyFile(cfg, "acme", "dev-9")).publicKey);
    expect(JSON.stringify(sent)).not.toContain(fp);
    expect(FleetTrust.ownerPinned(fleetKeyFile(cfg, "acme", "dev-9"))).toBe(fp.replace(/-/g, ""));
  });
});

describe("the owner key a member pins", () => {
  test("a space that joins with the owner key in its invite pins it after the forget that a new membership makes", async () => {
    const { setupFleetSpace } = await import("../src/fleet-space");
    const root = mkdtempSync(join(tmpdir(), "roster-space-"));
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        calls.push({ path, body: req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {} });
        if (req.method === "GET" && path.endsWith("/me")) return Response.json({ status: "none" }, { status: 404 });
        if (req.method === "POST" && path.endsWith("/join")) return Response.json({ ok: true });
        return Response.json({ member: false });
      },
    });
    try {
      const configPath = join(root, "config.yaml");
      const keyFile = fleetKeyFile(configPath, "x", "r1");
      const old = ownerFingerprint(generateOwnerKey().publicKey);
      const fp = ownerFingerprint(generateOwnerKey().publicKey);
      FleetTrust.pinOwner(keyFile, old); // what an earlier membership under this name left
      await setupFleetSpace(
        { configPath, config: {}, parsed: {}, json: false, quiet: true, verbose: false, color: false, out() {}, note() {} } as never,
        { fleet: "x", spaceName: "r1", gateway: "http://127.0.0.1:" + server.port, deviceId: "dev", deviceToken: "tok", code: "invite", ownerFp: fp, create: false, approvalWaitMs: 0 },
      );
      expect(calls.find((c) => c.path.endsWith("/join"))!.body.code).toBe("invite");
      expect(JSON.stringify(calls)).not.toContain(fp);
      expect(FleetTrust.ownerPinned(keyFile)).toBe(fp.replace(/-/g, ""));
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a pin made by the operator is not written back by a trust that was loaded before it", () => {
    const root = mkdtempSync(join(tmpdir(), "roster-pin-"));
    try {
      const keyFile = join(root, "m.key");
      const a = ownerFingerprint(generateOwnerKey().publicKey);
      const b = ownerFingerprint(generateOwnerKey().publicKey);
      FleetTrust.pinOwner(keyFile, a);
      // a round of the agent holds the trust it loaded, and saves it after a step
      const inUse = FleetTrust.beside(keyFile);
      inUse.noteMac(5);
      FleetTrust.pinOwner(keyFile, b, true); // the operator replaces the pin meanwhile
      inUse.save();
      expect(FleetTrust.ownerPinned(keyFile)).toBe(b.replace(/-/g, ""));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the newest roster entry seen is kept only for the owner key it was seen under", () => {
    const root = mkdtempSync(join(tmpdir(), "roster-head-"));
    try {
      const keyFile = join(root, "m.key");
      const a = ownerFingerprint(generateOwnerKey().publicKey);
      const b = ownerFingerprint(generateOwnerKey().publicKey);
      const t = FleetTrust.beside(keyFile);
      t.setOwner(a);
      t.rosterHead = { n: 9, hash: "h" };
      t.save();
      expect(FleetTrust.beside(keyFile).rosterHead).toEqual({ n: 9, hash: "h" });
      FleetTrust.pinOwner(keyFile, b, true);
      expect(FleetTrust.beside(keyFile).rosterHead).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("two runs that make the owner key at once do not replace each other's", async () => {
    const { createOwnerKeyFile } = await import("../src/fleet-roster");
    const root = mkdtempSync(join(tmpdir(), "roster-key-"));
    try {
      const file = join(root, "k", "acme.pem");
      const results = await Promise.allSettled([1, 2, 3, 4].map(async () => createOwnerKeyFile(file)));
      expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
      const winner = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ publicKey: string }>).value;
      expect(readOwnerKey(file).publicKey).toBe(winner.publicKey);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an owner key file that cannot be read does not stop an invite: the plain code is printed, and the reason", async () => {
    const bad = join(dir0(), "bad.pem");
    writeFileSync(bad, "not a key");
    const out: string[] = [];
    const real = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async () => Response.json({ ok: true, code: "CODE-9", expiresAt: Date.now() + 60_000 });
    try {
      await fleetsInvite({
        config: { defaults: { gateway: "https://g.example", fleet_operator_token: "op" }, devices: {}, spaces: {}, codeMcp: {} },
        configPath: join(dir0(), "config.yaml"),
        json: false,
        out: (l: string) => out.push(l),
        parsed: { positionals: ["fleets", "invite", "acme"], flags: new Map([["owner-key", bad]]), help: false },
      } as never);
    } finally {
      (globalThis as { fetch: unknown }).fetch = real;
    }
    expect(out.join("\n")).toContain("CODE-9");
    expect(out.join("\n")).toContain("could not be read");
  });
});

let dirForUnreadable: string | undefined;
function dir0(): string {
  dirForUnreadable ??= mkdtempSync(join(tmpdir(), "roster-bad-"));
  return dirForUnreadable;
}
