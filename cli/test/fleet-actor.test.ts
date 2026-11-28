// Who made a snapshot: the publisher's key and software, and the tools its tool server ran since the last one, in the
// sealed metadata; and `prime fleets snapshots`, which reads them back with the member's own key.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActivityJournal } from "../src/activity-journal";
import { ACTOR_TOOLS_MAX, actorFrom, actorOf, toolCounts } from "../src/fleet-actor";
import { loadOrCreateKeyPair, publish, type MemberPaths } from "../src/fleet-agent";
import { keyIdOf, openPayload } from "../src/fleet-crypto";
import { forgetIncarnationAnswers, metaBindingOf } from "../src/fleet-trust";
import { payloadHash, type FleetManifest } from "../src/fleet-transport";

import { FakeGateway, credsFor, useFakeGateway } from "./fleet-fake-gateway";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

describe("the actor of a snapshot", () => {
  test("calls are counted by tool and caller, most often first, and no more than the limit are named", () => {
    const calls = [
      ...Array.from({ length: 3 }, () => ({ tool: "write", caller: "key1" })),
      { tool: "read", caller: "local" },
      { tool: "write", caller: "local" },
    ];
    expect(toolCounts(calls)).toEqual([
      { tool: "write", caller: "key1", n: 3 },
      { tool: "read", caller: "local", n: 1 },
      { tool: "write", caller: "local", n: 1 },
    ]);
    const many = Array.from({ length: ACTOR_TOOLS_MAX + 20 }, (_, i) => ({ tool: "t" + i, caller: "local" }));
    expect(toolCounts(many).length).toBe(ACTOR_TOOLS_MAX);
  });

  test("a journal that is not there is no calls: the snapshot has its key and software only, and the position stays", () => {
    const pair = loadOrCreateKeyPair(join(mkdtempSync(join(tmpdir(), "actor-")), "k"));
    const { actor, position } = actorOf(pair.publicKey, { file: "/nonexistent/activity.jsonl", after: { seq: 4, fid: "abc" } }, "26.1.1");
    expect(actor).toEqual({ key: keyIdOf(pair.publicKey), agent: "prime/26.1.1" });
    expect(position).toEqual({ seq: 4, fid: "abc" });
    expect(actorOf(pair.publicKey, undefined, "26.1.1").position).toBeUndefined();
  });

  test("what the metadata says of an actor is only taken as one", () => {
    expect(actorFrom(null)).toBeUndefined();
    expect(actorFrom({ key: 1, agent: "x" })).toBeUndefined();
    expect(actorFrom({ key: "k", agent: "a", tools: [{ tool: "w", caller: "c", n: 2 }, { tool: 3 }, { tool: "x", caller: "y", n: 0 }], gap: true })).toEqual({ key: "k", agent: "a", tools: [{ tool: "w", caller: "c", n: 2 }], gap: true });
  });
});

describe("publishing with the tool server's journal", () => {
  const roots: string[] = [];
  afterEach(() => {
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  function world() {
    forgetIncarnationAnswers();
    const root = mkdtempSync(join(tmpdir(), "fleet-actor-"));
    roots.push(root);
    const gateway = new FakeGateway();
    useFakeGateway(gateway);
    const work = join(root, "primary");
    mkdirSync(work, { recursive: true });
    mkdirSync(join(root, "replica"), { recursive: true });
    const primary: MemberPaths = { work, gitDir: join(root, "p-meta"), keyFile: join(root, "p.key") };
    const replica: MemberPaths = { work: join(root, "replica"), gitDir: join(root, "r-meta"), keyFile: join(root, "r.key") };
    gateway.seed("primary-device", loadOrCreateKeyPair(primary.keyFile).publicKey);
    gateway.seed("replica-device", loadOrCreateKeyPair(replica.keyFile).publicKey);
    writeFileSync(join(work, "a.txt"), "one\n");
    return { root, gateway, work, primary, replica };
  }

  /** What the replica reads in the sealed metadata of a manifest. */
  function metaOf(w: ReturnType<typeof world>, key: string) {
    const m = JSON.parse(w.gateway.payloads.get(key)!.toString("utf8")) as FleetManifest;
    const pack = w.gateway.payloads.get(m.packKey)!;
    const opened = openPayload(pack, m.wrapped, m.senderPublicKey, "replica-device", loadOrCreateKeyPair(w.replica.keyFile).privateKey)!;
    return { manifest: m, meta: opened.openMeta(metaBindingOf(m, payloadHash(pack), null), m.meta as string)! };
  }

  test("the tools that ran since the last snapshot are in the metadata, a replica reads them, and the gateway's manifest has none of it (fails without: no actor)", async () => {
    const w = world();
    const file = join(w.root, "activity.jsonl");
    const journal = new ActivityJournal(file);
    journal.record("write", "keyA");
    journal.record("write", "keyA");
    journal.record("bash", "local");
    await journal.flush();
    const first = await publish(credsFor("primary-device"), "x", w.primary, null, 0, 2, undefined, { activity: { file } });
    expect(first.activity?.seq).toBe(3);
    const { manifest, meta } = metaOf(w, first.manifestKey);
    const actor = actorFrom(meta.actor)!;
    expect(actor.key).toBe(keyIdOf(loadOrCreateKeyPair(w.primary.keyFile).publicKey));
    expect(actor.tools).toEqual([
      { tool: "write", caller: "keyA", n: 2 },
      { tool: "bash", caller: "local", n: 1 },
    ]);
    // nothing of it in the clear
    const text = JSON.stringify(manifest);
    expect(text).not.toContain("bash");
    expect(text).not.toContain("keyA");
    expect(text).not.toContain("\"actor\"");

    // the next snapshot names only what ran since
    journal.record("read", "local");
    await journal.flush();
    writeFileSync(join(w.work, "a.txt"), "two\n");
    const second = await publish(credsFor("primary-device"), "x", w.primary, first.commit, first.seq, 2, first.roster, { activity: { file, after: first.activity } });
    expect(actorFrom(metaOf(w, second.manifestKey).meta.actor)!.tools).toEqual([{ tool: "read", caller: "local", n: 1 }]);
    // and one with nothing new names none
    writeFileSync(join(w.work, "a.txt"), "three\n");
    const third = await publish(credsFor("primary-device"), "x", w.primary, second.commit, second.seq, 2, second.roster, { activity: { file, after: second.activity } });
    expect(actorFrom(metaOf(w, third.manifestKey).meta.actor)!.tools).toBeUndefined();
  });

  test("a publish with no journal still says who published", async () => {
    const w = world();
    const first = await publish(credsFor("primary-device"), "x", w.primary, null, 0, 2);
    const actor = actorFrom(metaOf(w, first.manifestKey).meta.actor)!;
    expect(actor.agent).toMatch(/^prime\//);
    expect(first.activity).toBeUndefined();
  });

  test("`fleets snapshots` reads the actors back, with the member's own key and without fetching a pack", async () => {
    const { fleetsSnapshots } = await import("../src/fleets");
    const w = world();
    const file = join(w.root, "activity.jsonl");
    const journal = new ActivityJournal(file);
    journal.record("write", "keyA");
    await journal.flush();
    await publish(credsFor("primary-device"), "x", w.primary, null, 0, 2, undefined, { activity: { file } });
    const out: string[] = [];
    const configPath = join(w.root, "config.yaml");
    const { fleetKeyFile } = await import("../src/fleets");
    // the replica's key file is where `fleets snapshots` looks for it
    const { copyFileSync, mkdirSync: mk } = await import("node:fs");
    mk(join(configPath, "..", "fleets"), { recursive: true });
    const keyFile = fleetKeyFile(configPath, "x", "r1");
    mk(join(keyFile, ".."), { recursive: true });
    copyFileSync(w.replica.keyFile, keyFile);
    const packReadsBefore = w.gateway.packReads.length;
    await fleetsSnapshots({
      config: { defaults: {}, devices: {}, spaces: { r1: { fleet: "x", gateway: "https://gw.example", gateway_device: "replica-device", remote_token: "t" } }, codeMcp: {} },
      configPath,
      json: false,
      out: (l: string) => out.push(l),
      parsed: { positionals: ["fleets", "snapshots", "x"], flags: new Map([["space", "r1"]]), help: false },
    } as never);
    expect(out.join("\n")).toContain("write×1 (keyA)");
    expect(out.join("\n")).toContain("prime/");
    expect(w.gateway.packReads.length).toBe(packReadsBefore);
  });
});
