// A small snapshot comes with the news that it is the head: the member that hears it asks the gateway for
// neither the manifest nor the pack, and what it was told is held to the same checks as what it asked for.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOrCreateKeyPair, manifestIdOf, publish, pull, type MemberPaths } from "../src/fleet-agent";
import { applyHeadEvent, noteHeadInline } from "../src/fleet-daemon";
import { INLINE_MANIFEST_MAX, parseFleetEvent } from "../src/fleet-events";
import { TamperedSnapshotError, forgetIncarnationAnswers } from "../src/fleet-trust";
import { forgetInline, getPayload, noteInline, type FleetManifest } from "../src/fleet-transport";

import { FakeGateway, credsFor, useFakeGateway } from "./fleet-fake-gateway";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

const roots: string[] = [];
afterEach(() => {
  (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  forgetInline();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

describe("the head event", () => {
  test("keeps an inline snapshot of two strings, and nothing of any other shape", () => {
    const line = (inline: unknown): string => JSON.stringify({ type: "head", seq: 4, manifestKey: "fleets/x/manifests/" + "a".repeat(64), inline });
    expect(parseFleetEvent(line({ manifest: "{}", pack: "AAAA" }))).toEqual({ type: "head", seq: 4, manifestKey: "fleets/x/manifests/" + "a".repeat(64), inline: { manifest: "{}", pack: "AAAA" } });
    for (const bad of [undefined, null, "x", 3, {}, { manifest: "{}" }, { pack: "AAAA" }, { manifest: 1, pack: "AAAA" }, { manifest: "{}", pack: ["A"] }, { manifest: "", pack: "AAAA" }, { manifest: "x".repeat(INLINE_MANIFEST_MAX + 1), pack: "AAAA" }]) {
      const got = parseFleetEvent(line(bad));
      expect(got).toEqual({ type: "head", seq: 4, manifestKey: "fleets/x/manifests/" + "a".repeat(64) });
    }
  });

  test("an event with none is as it was", () => {
    expect(parseFleetEvent(JSON.stringify({ type: "head", seq: 7 }))).toEqual({ type: "head", seq: 7 });
  });
});

describe("what the socket brought", () => {
  async function fleet() {
    forgetIncarnationAnswers();
    forgetInline();
    const root = mkdtempSync(join(tmpdir(), "fleet-inline-"));
    roots.push(root);
    const gateway = new FakeGateway();
    useFakeGateway(gateway);
    const work = join(root, "primary");
    mkdirSync(work, { recursive: true });
    mkdirSync(join(root, "replica"), { recursive: true });
    for (let i = 0; i < 10; i++) writeFileSync(join(work, "f" + i + ".txt"), "file " + i + "\n");
    const primary: MemberPaths = { work, gitDir: join(root, "p-meta"), keyFile: join(root, "p.key") };
    const replica: MemberPaths = { work: join(root, "replica"), gitDir: join(root, "r-meta"), keyFile: join(root, "r.key") };
    gateway.seed("primary-device", loadOrCreateKeyPair(primary.keyFile).publicKey);
    gateway.seed("replica-device", loadOrCreateKeyPair(replica.keyFile).publicKey);
    const first = await publish(credsFor("primary-device"), "x", primary, null, 0, 2);
    const got = await pull(credsFor("replica-device"), "x", replica, 0);
    expect(got.applied).toBe(true);
    // A one-file edit: a delta of a few hundred bytes.
    writeFileSync(join(work, "f3.txt"), "edited\n");
    const edit = await publish(credsFor("primary-device"), "x", primary, first.commit, first.seq, 2, first.roster);
    expect(edit.full).toBe(false);
    const manifestText = gateway.payloads.get(edit.manifestKey)!;
    const manifest = JSON.parse(manifestText.toString("utf8")) as FleetManifest;
    const pack = gateway.payloads.get(manifest.packKey)!;
    const count = (kind: string): number => gateway.requests.get("GET " + kind) ?? 0;
    return { gateway, replica, edit, got, manifestText, manifest, pack, count, hint: { seq: edit.seq, manifestKey: edit.manifestKey } };
  }

  test("is taken in with no ask for the manifest or the pack", async () => {
    const f = await fleet();
    noteHeadInline("x", { type: "head", seq: f.edit.seq, manifestKey: f.edit.manifestKey, inline: { manifest: f.manifestText.toString("utf8"), pack: f.pack.toString("base64") } });
    const manifests = f.count("manifests");
    const packs = f.count("packs");
    const { fetchAhead } = await import("../src/fleet-agent");
    const got = await fetchAhead(credsFor("replica-device"), "x", f.replica, { seq: f.got.seq, commit: f.got.commit }, undefined, f.hint);
    expect(got.fetched.seq).toBe(2);
    expect(f.count("manifests") - manifests).toBe(0);
    expect(f.count("packs") - packs).toBe(0);
  });

  test("the agent's handling of the head event keeps what came with it, notes the head, and the next fetch asks for nothing", async () => {
    const f = await fleet();
    // The part of the agent that hears the news (the socket's `head` case): the loop's own fields are what it changes.
    const loop = { fleet: "x", knownHeadSeq: f.got.seq, knownHeadManifest: undefined as string | undefined, headDirty: false };
    applyHeadEvent(loop, { type: "head", seq: f.edit.seq, manifestKey: f.edit.manifestKey, inline: { manifest: f.manifestText.toString("utf8"), pack: f.pack.toString("base64") } });
    expect(loop.knownHeadSeq).toBe(f.edit.seq);
    expect(loop.knownHeadManifest).toBe(f.edit.manifestKey);
    expect(loop.headDirty).toBe(true);
    const manifests = f.count("manifests");
    const packs = f.count("packs");
    const { fetchAhead } = await import("../src/fleet-agent");
    const got = await fetchAhead(credsFor("replica-device"), "x", f.replica, { seq: f.got.seq, commit: f.got.commit }, undefined, { seq: loop.knownHeadSeq, manifestKey: loop.knownHeadManifest! });
    expect(got.fetched.seq).toBe(2);
    expect(f.count("manifests") - manifests).toBe(0);
    expect(f.count("packs") - packs).toBe(0);
    // an older head is noted for nothing but the look at the fleet
    applyHeadEvent(loop, { type: "head", seq: 1 });
    expect(loop.knownHeadSeq).toBe(f.edit.seq);
  });

  test("the gateway's own check lets through exactly the bytes a publish stored, and the member takes them in with no ask", async () => {
    const f = await fleet();
    const gatewaySide = join(import.meta.dir, "..", "..", "api", "src", "fleets.ts");
    // The gateway is in this repository: a path that moved is a test that must say so, not one that passes without looking.
    expect(existsSync(gatewaySide)).toBe(true);
    const { checkedInline, INLINE_CAP } = (await import(pathToFileURL(gatewaySide).href)) as {
      checkedInline(asked: unknown, manifestKey: string, manifestHash: string, fleetId: string, full: boolean): Promise<{ manifest: string; pack: string } | undefined>;
      INLINE_CAP: string;
    };
    const { MEMBER_CAPS } = await import("../src/fleet-transport");
    expect(MEMBER_CAPS).toContain(INLINE_CAP);
    const asked = { manifest: f.manifestText.toString("utf8"), pack: f.pack.toString("base64") };
    const hash = f.edit.manifestKey.split("/").pop()!;
    const answered = await checkedInline(asked, f.edit.manifestKey, hash, "x", false);
    // the manifest text that goes in the event is the stored manifest, byte for byte
    expect(answered?.manifest).toBe(f.gateway.payloads.get(f.edit.manifestKey)!.toString("utf8"));
    expect(sha(Buffer.from(answered!.manifest, "utf8"))).toBe(hash);
    // what comes out of the gateway's check is an event this side parses and takes in
    const event = parseFleetEvent(JSON.stringify({ type: "head", seq: f.edit.seq, manifestKey: f.edit.manifestKey, inline: answered }));
    expect(event).toMatchObject({ type: "head", inline: { manifest: asked.manifest } });
    const loop = { fleet: "x", knownHeadSeq: f.got.seq, knownHeadManifest: undefined as string | undefined, headDirty: false };
    applyHeadEvent(loop, event as never);
    const manifests = f.count("manifests");
    const packs = f.count("packs");
    const { fetchAhead } = await import("../src/fleet-agent");
    const got = await fetchAhead(credsFor("replica-device"), "x", f.replica, { seq: f.got.seq, commit: f.got.commit }, undefined, { seq: loop.knownHeadSeq, manifestKey: loop.knownHeadManifest! });
    expect(got.fetched.seq).toBe(2);
    expect(f.count("manifests") - manifests).toBe(0);
    expect(f.count("packs") - packs).toBe(0);
    // and the gateway refuses what this side would refuse: a pack that is not the one the manifest names
    const wrong = Buffer.from(f.pack);
    wrong[0] = wrong[0]! ^ 0xff;
    expect(await checkedInline({ manifest: asked.manifest, pack: wrong.toString("base64") }, f.edit.manifestKey, hash, "x", false)).toBeUndefined();
  });

  test("is asked for twice without it (the control)", async () => {
    const f = await fleet();
    const manifests = f.count("manifests");
    const packs = f.count("packs");
    const { fetchAhead } = await import("../src/fleet-agent");
    await fetchAhead(credsFor("replica-device"), "x", f.replica, { seq: f.got.seq, commit: f.got.commit }, undefined, f.hint);
    expect(f.count("manifests") - manifests).toBeGreaterThanOrEqual(1);
    expect(f.count("packs") - packs).toBe(1);
  });

  test("a pack that is not the one the manifest names is never used: the real one is asked for", async () => {
    const f = await fleet();
    const wrong = Buffer.from(f.pack);
    wrong[wrong.length - 1] = wrong[wrong.length - 1]! ^ 0xff;
    noteHeadInline("x", { type: "head", seq: f.edit.seq, manifestKey: f.edit.manifestKey, inline: { manifest: f.manifestText.toString("utf8"), pack: wrong.toString("base64") } });
    const packs = f.count("packs");
    const { fetchAhead } = await import("../src/fleet-agent");
    const got = await fetchAhead(credsFor("replica-device"), "x", f.replica, { seq: f.got.seq, commit: f.got.commit }, undefined, f.hint);
    expect(got.fetched.seq).toBe(2);
    expect(f.count("packs") - packs).toBe(1);
  });

  test("a manifest that is not the one the head names is never used, and one the head names that was forged is refused as a forged fetch is", async () => {
    const f = await fleet();
    // The gateway names a manifest of its own making as the head, and brings it, with the real pack.
    const forged: FleetManifest = { ...f.manifest, tree: "0".repeat(40) };
    const forgedText = JSON.stringify(forged);
    const forgedKey = "fleets/x/manifests/" + sha(forgedText);
    f.gateway.payloads.set(forgedKey, Buffer.from(forgedText, "utf8"));
    f.gateway.head = { seq: 2, manifestKey: forgedKey, manifestHash: sha(forgedText), epoch: 1 };
    f.gateway.indexEntries.push({ seq: 2, manifestKey: forgedKey, full: false });
    f.gateway.indexEntries.splice(f.gateway.indexEntries.findIndex((e) => e.seq === 2), 1);
    noteHeadInline("x", { type: "head", seq: 2, manifestKey: forgedKey, inline: { manifest: forgedText, pack: f.pack.toString("base64") } });
    await expect(pull(credsFor("replica-device"), "x", f.replica, f.got.seq, f.got.commit)).rejects.toBeInstanceOf(TamperedSnapshotError);
    expect(readFileSync(join(f.replica.work, "f3.txt"), "utf8")).toBe("file 3\n");
  });

  test("answers an ask by id with exactly the bytes that hash to it, once, and for a few minutes", async () => {
    const f = await fleet();
    const text = f.manifestText.toString("utf8");
    noteInline("x", { manifest: text, pack: f.pack.toString("base64") });
    const id = sha(f.manifestText);
    expect((await getPayload(credsFor("replica-device"), "x", "manifests", id)).equals(f.manifestText)).toBe(true);
    expect(manifestIdOf(f.edit.manifestKey)).toBe(id);
    // Another fleet of the same hash is not answered from it, and neither is a longer-ago one.
    forgetInline();
    noteInline("x", { manifest: text, pack: f.pack.toString("base64") }, Date.now() - 6 * 60_000);
    const before = f.count("manifests");
    await getPayload(credsFor("replica-device"), "x", "manifests", id);
    expect(f.count("manifests") - before).toBe(1);
  });

  test("holds a few snapshots, the newest", () => {
    forgetInline();
    for (let i = 0; i < 20; i++) noteInline("x", { manifest: JSON.stringify({ n: i }), pack: Buffer.from("pack " + i).toString("base64") });
    return Promise.all(
      [0, 11, 12, 19].map(async (i) => {
        // Only a held one is answered without the network (there is none here: the ask would fail).
        const held = await getPayload({ gateway: "http://127.0.0.1:1", deviceId: "d", deviceToken: "t", timeoutMs: 200 }, "x", "manifests", sha(JSON.stringify({ n: i }))).then(
          () => true,
          () => false,
        );
        expect(held).toBe(i >= 12);
      }),
    );
  });
});
