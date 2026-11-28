// `prime fleets roster ...`, the signed approve and remove, the invite with the owner key and the pin, against
// a gateway that keeps the chain the way the roster wire says (see docs/fleets.md, "The signed roster").
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fleetKeyFile, fleetsApprove, fleetsInvite, fleetsJoin, fleetsRemove, fleetsRoster, fleetsTrust } from "../src/fleets";
import { generateOwnerKey, ownerFingerprint, parseInviteCode, readOwnerKey, verifyChain, type SignedEntry } from "../src/fleet-roster";
import { FleetTrust } from "../src/fleet-trust";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

interface Fake {
  url: string;
  entries: SignedEntry[];
  signed: boolean;
  fenced: string[];
  head: number;
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
  const state: Fake = { url: "", entries: [], signed: false, fenced: [], head: 7, members: [], pending: [], stop: () => undefined };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      if (p === "/fleets/acme/roster" && req.method === "GET") return Response.json({ mode: state.signed ? "signed" : "open", incarnation: "inc-1", entries: state.entries });
      if (p === "/fleets/acme/roster" && req.method === "POST") {
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
      if (p === "/fleets/acme/head") return Response.json({ ok: true, head: { seq: state.head } });
      if (p === "/fleets/acme/remove-fence") {
        state.fenced.push((body as { deviceId: string }).deviceId);
        return Response.json({ ok: true, seqAt: state.head });
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
    await expect(fleetsRoster(ctx("roster", ["init", "acme"], { yes: true }))).rejects.toThrow(/dev-3/);
    expect(gw.entries.length).toBe(0);
    expect(existsSync(keyFile)).toBe(false);
  });

  test("init --yes makes the owner key, a genesis and an add for each member, and never prints the key", async () => {
    gw.members = [member("dev-1", "owner"), member("dev-2")];
    out.length = 0;
    await fleetsRoster(ctx("roster", ["init", "acme"], { yes: true }));
    expect(gw.entries.length).toBe(3);
    const v = verifyChain(gw.entries, { fleet: "acme" });
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
    await fleetsRoster(ctx("roster", ["init", "acme"], { yes: true }));
    expect(gw.entries.length).toBe(4);
    const again = gw.entries.length;
    await fleetsRoster(ctx("roster", ["init", "acme"], { yes: true }));
    expect(gw.entries.length).toBe(again);
  });

  test("approve, once the roster is signed, is an add entry signed with the owner key", async () => {
    const fresh = member("dev-5");
    gw.pending = [{ ...fresh }];
    out.length = 0;
    await fleetsApprove(ctx("approve", ["acme"], { member: "dev-5" }));
    const v = verifyChain(gw.entries, { fleet: "acme" });
    expect(v.tenures.find((t) => t.device === "dev-5")?.spub).toBe(fresh.spub);
    expect(said()).toContain("admitted dev-5");
  });

  test("approve refuses a request that offers no signing key, and one whose key changed under the operator", async () => {
    gw.pending = [{ deviceId: "dev-6", pubkey: xpubOf("x"), role: "member" }];
    const before = gw.entries.length;
    await expect(fleetsApprove(ctx("approve", ["acme"], { member: "dev-6" }))).rejects.toThrow(/signing key/);
    const other = member("dev-7");
    gw.pending = [other];
    await expect(fleetsApprove(ctx("approve", ["acme"], { member: "dev-7", key: "AAAAAAAAAAAA" }))).rejects.toThrow(/replaced since/);
    expect(gw.entries.length).toBe(before);
  });

  test("remove fences the member first and signs the sequence the gateway named", async () => {
    gw.head = 12;
    await fleetsRemove(ctx("remove", ["acme"], { member: "dev-2" }));
    expect(gw.fenced).toEqual(["dev-2"]);
    const v = verifyChain(gw.entries, { fleet: "acme" });
    const last = gw.entries[gw.entries.length - 1]!.entry;
    expect(last[6]).toBe("remove");
    expect(last[11]).toBe(12);
    expect(v.tenures.find((t) => t.device === "dev-2")?.until).toBe(12);
    await expect(fleetsRemove(ctx("remove", ["acme"], { member: "dev-2" }))).rejects.toThrow(/not a member/);
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
    expect(JSON.stringify(sent)).not.toContain(fp);
    expect(FleetTrust.ownerPinned(fleetKeyFile(cfg, "acme", "dev-9"))).toBe(fp.replace(/-/g, ""));
  });
});
