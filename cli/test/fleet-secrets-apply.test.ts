// What a replica does with the files the gate leaves out of a snapshot: it keeps the ones it already holds.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOrCreateKeyPair, publish, pull, type MemberPaths } from "../src/fleet-agent";
import { writeAllow } from "../src/fleet-secrets";
import { forgetIncarnationAnswers } from "../src/fleet-trust";
import { FakeGateway, credsFor, useFakeGateway } from "./fleet-fake-gateway";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

const roots: string[] = [];
afterEach(() => {
  delete process.env.PRIME_FLEET_SECRET_GATE;
  (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const FAKE_AWS = "AK" + "IA" + "ABCDEFGHIJKLMNOP";

function fleet() {
  forgetIncarnationAnswers();
  const root = mkdtempSync(join(tmpdir(), "fleet-secapply-"));
  roots.push(root);
  const gateway = new FakeGateway();
  useFakeGateway(gateway);
  const primary: MemberPaths = { work: join(root, "p"), gitDir: join(root, "p-meta"), keyFile: join(root, "p.key") };
  const replica: MemberPaths = { work: join(root, "r"), gitDir: join(root, "r-meta"), keyFile: join(root, "r.key") };
  mkdirSync(primary.work, { recursive: true });
  mkdirSync(replica.work, { recursive: true });
  gateway.seed("primary-device", loadOrCreateKeyPair(primary.keyFile).publicKey);
  gateway.seed("replica-device", loadOrCreateKeyPair(replica.keyFile).publicKey);
  return { gateway, primary, replica };
}

describe("a replica that already holds a file the gate now leaves out", () => {
  test("keeps it when the primary upgrades and publishes a delta, by path and by content", async () => {
    const { primary, replica } = fleet();
    writeFileSync(join(primary.work, "ok.txt"), "one\n");
    writeFileSync(join(primary.work, ".env"), "DB_PASSWORD=hunter2\n");
    writeFileSync(join(primary.work, "id_ed25519"), "key\n");
    writeFileSync(join(primary.work, "fixture.ts"), "const k = '" + FAKE_AWS + "';\n");
    process.env.PRIME_FLEET_SECRET_GATE = "off"; // what a build before the gate publishes
    const one = await publish(credsFor("primary-device"), "x", primary, null, 0, 2);
    const got = await pull(credsFor("replica-device"), "x", replica, 0);
    expect(existsSync(join(replica.work, ".env"))).toBe(true);

    delete process.env.PRIME_FLEET_SECRET_GATE;
    writeFileSync(join(primary.work, "ok.txt"), "two\n");
    const two = await publish(credsFor("primary-device"), "x", primary, one.commit, one.seq, 2, one.roster);
    expect(two.full).toBe(false);
    expect(two.kept?.sort()).toEqual([".env", "fixture.ts", "id_ed25519"]);
    await pull(credsFor("replica-device"), "x", replica, got.seq, got.commit);
    expect(readFileSync(join(replica.work, "ok.txt"), "utf8")).toBe("two\n");
    for (const f of [".env", "id_ed25519", "fixture.ts"]) expect(existsSync(join(replica.work, f))).toBe(true);
    expect(readFileSync(join(replica.work, ".env"), "utf8")).toBe("DB_PASSWORD=hunter2\n");
  }, 60_000);

  test("keeps it across a whole-tree snapshot, and across a restart between the fetch and the apply", async () => {
    const { gateway, primary, replica } = fleet();
    writeFileSync(join(primary.work, "ok.txt"), "one\n");
    writeFileSync(join(primary.work, ".env"), "A=1\n");
    writeFileSync(join(primary.work, "fixture.ts"), "const k = '" + FAKE_AWS + "';\n");
    process.env.PRIME_FLEET_SECRET_GATE = "off";
    const one = await publish(credsFor("primary-device"), "x", primary, null, 0, 2);
    const got = await pull(credsFor("replica-device"), "x", replica, 0);
    delete process.env.PRIME_FLEET_SECRET_GATE;
    writeFileSync(join(primary.work, "ok.txt"), "two\n");
    // A whole tree: a new member changes who the snapshot is sealed for.
    gateway.seed("third-device", loadOrCreateKeyPair(join(roots[0]!, "third.key")).publicKey);
    const two = await publish(credsFor("primary-device"), "x", primary, one.commit, one.seq, 2, one.roster);
    expect(two.full).toBe(true);
    expect(two.kept?.sort()).toEqual([".env", "fixture.ts"]);
    // Fetch without applying, then apply later (what a replica does between a fetch and a take-over).
    const { fetchAhead, applyFetched } = await import("../src/fleet-agent");
    const ahead = await fetchAhead(credsFor("replica-device"), "x", replica, { seq: got.seq, commit: got.commit });
    await applyFetched(replica, { seq: got.seq, commit: got.commit }, ahead.fetched);
    for (const f of [".env", "fixture.ts"]) expect(existsSync(join(replica.work, f))).toBe(true);
    expect(readFileSync(join(replica.work, "ok.txt"), "utf8")).toBe("two\n");
  }, 60_000);

  test("keeps a file the secret rules name even when the snapshot lists nothing (a publisher with no gate, or a cut list), and still removes what is not one", async () => {
    const { primary, replica } = fleet();
    writeFileSync(join(primary.work, "ok.txt"), "one\n");
    writeFileSync(join(primary.work, "gone.txt"), "bye\n");
    writeFileSync(join(primary.work, ".env"), "A=1\n");
    process.env.PRIME_FLEET_SECRET_GATE = "off";
    const one = await publish(credsFor("primary-device"), "x", primary, null, 0, 2);
    const got = await pull(credsFor("replica-device"), "x", replica, 0);
    rmSync(join(primary.work, ".env"));
    rmSync(join(primary.work, "gone.txt"));
    const two = await publish(credsFor("primary-device"), "x", primary, one.commit, one.seq, 2, one.roster);
    expect(two.kept).toBeUndefined();
    await pull(credsFor("replica-device"), "x", replica, got.seq, got.commit);
    expect(existsSync(join(replica.work, "gone.txt"))).toBe(false);
    expect(existsSync(join(replica.work, ".env"))).toBe(true);
  }, 60_000);

  test("a file the operator allowed afterwards is the fleet's again: it arrives and is updated", async () => {
    const { primary, replica } = fleet();
    writeFileSync(join(primary.work, "ok.txt"), "one\n");
    writeFileSync(join(primary.work, "fixture.ts"), "const k = '" + FAKE_AWS + "';\n");
    process.env.PRIME_FLEET_SECRET_GATE = "off";
    const one = await publish(credsFor("primary-device"), "x", primary, null, 0, 2);
    const got = await pull(credsFor("replica-device"), "x", replica, 0);
    delete process.env.PRIME_FLEET_SECRET_GATE;
    writeFileSync(join(primary.work, "ok.txt"), "two\n");
    const two = await publish(credsFor("primary-device"), "x", primary, one.commit, one.seq, 2, one.roster);
    expect(two.kept).toEqual(["fixture.ts"]);
    const mid = await pull(credsFor("replica-device"), "x", replica, got.seq, got.commit);
    writeAllow(primary.keyFile, ["fixture.ts"]);
    writeFileSync(join(primary.work, "fixture.ts"), "const k = '" + FAKE_AWS + "'; // new\n");
    const three = await publish(credsFor("primary-device"), "x", primary, two.commit, two.seq, 2, two.roster);
    expect(three.kept).toBeUndefined();
    await pull(credsFor("replica-device"), "x", replica, mid.seq, mid.commit);
    expect(readFileSync(join(replica.work, "fixture.ts"), "utf8")).toContain("// new");
  }, 60_000);
});
