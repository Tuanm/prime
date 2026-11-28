// The client of the witness: the checkpoint a member posts, what it reads back, and what it makes of a gateway that shows it an older
// head than another member saw (a rollback), or two members two histories (a fork). The witness here is a small server of the
// contract in api/witness/README.md; the gateway is the fake one, with a signed roster.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOrCreateKeyPair, loadOrCreateSignKey, manifestIdOf, publish, type MemberPaths } from "../src/fleet-agent";
import { generateOwnerKey, makeEntry, entryHash, signEntry, type OwnerKey, type RosterEntry, type SignedEntry, verifyChain, verifyEntry, fleetKeyOf } from "../src/fleet-roster";
import { noteHeld, watchWitness, type SpaceLoop } from "../src/fleet-daemon";
import { forgetIncarnationAnswers, forgetRosterAnswers } from "../src/fleet-trust";
import {
  CHECKPOINT_TAG,
  checkpointOf,
  forkBlocking,
  judgeWitness,
  lookAtWitness,
  normalizeWitnessUrl,
  parseCheckpoint,
  postCheckpoint,
  postHeld,
  proofFor,
  readWitness,
  readWitnessState,
  signCheckpoint,
  updateWitnessState,
  verifyCheckpoint,
  witnessUrlOf,
  type WitnessCheckpoint,
  type WitnessOutcome,
} from "../src/fleet-witness";

import { FakeGateway, credsFor, useFakeGateway } from "./fleet-fake-gateway";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

/** The real fetch: the fake gateway answers every request made with the global one, and the witness is a server of its own. */
const real = (): typeof fetch => (globalThis as { __realFetch?: typeof fetch }).__realFetch ?? fetch;

const cleanups: Array<() => void> = [];
afterEach(() => {
  (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  while (cleanups.length) cleanups.pop()!();
});

// ---- a witness, as the contract has it --------------------------------------------------------

interface Witness {
  url: string;
  /** What it holds, newest post last. */
  held: WitnessCheckpoint[];
  posts: Array<Record<string, unknown>>;
  down: boolean;
  /** Refuse a post with this status, once. */
  refuse: number[];
}

function witness(): Witness {
  const w: Witness = { url: "", held: [], posts: [], down: false, refuse: [] };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (w.down) return new Response("down", { status: 503 });
      const path = new URL(req.url).pathname;
      if (!path.startsWith("/w/")) return Response.json({ error: "no" }, { status: 404 });
      if (req.method === "POST") {
        const refused = w.refuse.shift();
        if (refused !== undefined) return Response.json({ error: "refused" }, { status: refused });
        const body = (await req.json()) as Record<string, unknown>;
        w.posts.push(body);
        const c = parseCheckpoint(body);
        if (c === null || !verifyCheckpoint(c)) return Response.json({ error: "bad signature" }, { status: 401 });
        const newest = w.held.filter((h) => h.spub === c.spub).reduce((m, h) => Math.max(m, h.cp[4]), -1);
        if (c.cp[4] < newest) return Response.json({ ok: true, stored: false });
        w.held = w.held.filter((h) => !(h.spub === c.spub && h.cp[4] === c.cp[4] && h.cp[5] === c.cp[5]));
        w.held.push(c);
        return Response.json({ ok: true, stored: true });
      }
      if (w.held.length === 0) return Response.json({ error: "not held" }, { status: 404 });
      return Response.json({ v: 2, now: Date.now(), checkpoints: [...w.held].reverse().map((c) => ({ ...c, tier: "proven", at: Date.now() })) });
    },
  });
  w.url = "http://127.0.0.1:" + server.port;
  cleanups.push(() => server.stop(true));
  return w;
}

// ---- a fleet with a signed roster -----------------------------------------------------------------

class Chain {
  entries: SignedEntry[] = [];
  at = 1000;
  constructor(
    readonly owner: OwnerKey,
    readonly incarnation = "incarnation-1",
  ) {
    this.push({ op: "genesis", seqAt: 0, extra: owner.publicKey });
  }
  push(f: { op: RosterEntry[6]; device?: string; xpub?: string; spub?: string; role?: string; seqAt?: number | null; extra?: string }, signer = this.owner): SignedEntry {
    const prev = this.entries[this.entries.length - 1];
    const entry = makeEntry({ fleet: "x", incarnation: this.incarnation, n: this.entries.length, prevHash: prev ? entryHash(prev) : null, at: this.at++, ...f });
    const signed = { entry, sig: signEntry(entry, signer.privateKeyPem) };
    this.entries.push(signed);
    return signed;
  }
}

interface Member {
  id: string;
  paths: MemberPaths;
  spub: string;
}

interface World {
  root: string;
  gateway: FakeGateway;
  chain: Chain;
  a: Member;
  b: Member;
  witness: Witness;
  publishA(content: string): Promise<Awaited<ReturnType<typeof publish>>>;
  /**
   * What the agent does in a round, as one call: post the checkpoint of what `m` holds (`held`; by default the gateway's head, when `heldSeq`
   * reaches it), then read. The outcome is the read's, unless the post did not go through.
   */
  look(m: Member, extra?: { heldSeq?: number; held?: { seq: number; manifestHash: string } | null; now?: number; url?: string }): Promise<WitnessOutcome & { posted?: boolean }>;
}

function world(): World {
  forgetIncarnationAnswers();
  forgetRosterAnswers();
  const root = mkdtempSync(join(tmpdir(), "fleet-witness-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const gateway = new FakeGateway();
  useFakeGateway(gateway);
  const owner = generateOwnerKey();
  const chain = new Chain(owner);
  const member = (id: string): Member => {
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    const paths: MemberPaths = { work: dir, gitDir: join(root, id + "-meta"), keyFile: join(root, id + ".key") };
    const pk = loadOrCreateKeyPair(paths.keyFile).publicKey;
    const spub = loadOrCreateSignKey(paths.keyFile).publicKey;
    gateway.seed(id, pk);
    chain.push({ op: "add", device: id, xpub: pk, spub, role: "member", seqAt: 0 });
    return { id, paths, spub };
  };
  const a = member("device-a");
  const b = member("device-b");
  gateway.roster = { mode: "signed", entries: chain.entries };
  const w = witness();
  const world: World = {
    root,
    gateway,
    chain,
    a,
    b,
    witness: w,
    async publishA(content) {
      writeFileSync(join(a.paths.work, "file.txt"), content);
      forgetRosterAnswers();
      const last = lastPublish.get(gateway);
      const out = await publish(credsFor(a.id), "x", a.paths, last?.commit ?? null, last?.seq ?? 0, 2);
      lastPublish.set(gateway, out);
      return out;
    },
    async look(m, extra = {}) {
      forgetRosterAnswers();
      const url = extra.url ?? w.url;
      updateWitnessState(m.paths.keyFile, (s) => void (s.url = url));
      const head = gateway.head;
      const heldSeq = extra.heldSeq ?? head?.seq ?? 0;
      const held = extra.held === undefined ? (head && heldSeq >= head.seq && head.seq > 0 ? { seq: head.seq, manifestHash: head.manifestHash } : null) : extra.held;
      const now = extra.now !== undefined ? { now: extra.now } : {};
      let posted: WitnessOutcome | undefined;
      if (held !== null) {
        posted = await postHeld({ creds: credsFor(m.id), fleet: "x", keyFile: m.paths.keyFile, held, signKey: () => loadOrCreateSignKey(m.paths.keyFile), fetcher: real(), ...now });
        if (posted.status === "unwitnessed" || posted.status === "fault") return posted;
        if (posted.status === "no-roster") return posted;
      }
      const read = await lookAtWitness({ creds: credsFor(m.id), fleet: "x", keyFile: m.paths.keyFile, fetcher: real(), ...now });
      return { ...read, ...(posted?.posted ? { posted: true } : {}) };
    },
  };
  gateway.primary = a.id;
  return world;
}
const lastPublish = new WeakMap<FakeGateway, Awaited<ReturnType<typeof publish>>>();

const roster = (w: World) => verifyChain(w.chain.entries, { fleet: "x" });

/** A checkpoint of `m` for snapshot `seq` with this manifest hash, as the witness would hold it. */
function held(w: World, m: Member, seq: number, hash: string, patch: { fleetKey?: string; fleet?: string } = {}): WitnessCheckpoint {
  const v = roster(w);
  const cp = checkpointOf(v, seq, hash, Date.now());
  if (patch.fleetKey) cp[1] = patch.fleetKey;
  if (patch.fleet) cp[2] = patch.fleet;
  return signCheckpoint(cp, loadOrCreateSignKey(m.paths.keyFile));
}

const H = (n: number): string => createHash("sha256").update("manifest " + n).digest("hex");

// ---- tests ----------------------------------------------------------------------------------------

describe("a checkpoint", () => {
  test("is the form the witness fixes, signed over the array, and checks only for the key that made it", () => {
    const w = world();
    const v = roster(w);
    expect(v.fleetKey).toBe(fleetKeyOf(w.chain.entries[0]!.entry));
    const cp = checkpointOf(v, 7, H(7), 1234);
    expect(cp).toEqual([CHECKPOINT_TAG, v.fleetKey, "x", "incarnation-1", 7, H(7), v.head.n, 1234]);
    const signed = signCheckpoint(cp, loadOrCreateSignKey(w.a.paths.keyFile));
    expect(signed.spub).toBe(w.a.spub);
    expect(verifyCheckpoint(signed)).toBe(true);
    expect(verifyCheckpoint({ ...signed, spub: w.b.spub })).toBe(false);
    expect(verifyCheckpoint({ ...signed, cp: [...cp.slice(0, 4), 8, ...cp.slice(5)] })).toBe(false);
    expect(parseCheckpoint(signed)).not.toBeNull();
    expect(parseCheckpoint({ ...signed, cp: [...cp.slice(0, 7)] })).toBeNull();
    expect(parseCheckpoint({ ...signed, cp: ["other", ...cp.slice(1)] })).toBeNull();
    expect(parseCheckpoint({ ...signed, cp: [...cp.slice(0, 4), -1, ...cp.slice(5)] })).toBeNull();
  });

  test("carries the proof the witness asks for: the owner's entry that names the key, with the genesis whose hash is the fleet's name", () => {
    const w = world();
    const v = roster(w);
    const proof = proofFor(v, w.a.spub)!;
    expect(proof.entry[6]).toBe("add");
    expect(proof.entry[9]).toBe(w.a.spub);
    expect(verifyEntry(proof.entry, proof.sig, v.owner)).toBe(true);
    expect(fleetKeyOf(proof.genesis!)).toBe(v.fleetKey);
    expect(proofFor(v, generateOwnerKey().publicKey)).toBeUndefined();
  });

  test("of a key that took its device's place by rotate-self has the key that held it before as the voucher", () => {
    const w = world();
    const next = generateOwnerKey();
    const before = w.chain.entries.length;
    w.chain.push({ op: "rotate-self", device: w.b.id, spub: next.publicKey, seqAt: 1 }, loadOrCreateSignKeyOwner(w.b));
    expect(w.chain.entries.length).toBe(before + 1);
    const v = roster(w);
    const proof = proofFor(v, next.publicKey)!;
    expect(proof.by).toBe(w.b.spub);
    expect(proof.entry[6]).toBe("rotate-self");
    expect(proof.genesis).toBeUndefined();
  });
});

/** The signing key of a member as an owner-key record, for the entries that member signs itself. */
function loadOrCreateSignKeyOwner(m: Member): OwnerKey {
  const sign = loadOrCreateSignKey(m.paths.keyFile);
  return { publicKey: sign.publicKey, privateKeyPem: sign.privateKey } as OwnerKey;
}

describe("posting a checkpoint", () => {
  test("is the checkpoint of the snapshot a member holds, with the hash of the manifest it published, once", async () => {
    const w = world();
    const one = await w.publishA("one");
    const held = { seq: one.seq, manifestHash: manifestIdOf(one.manifestKey) };
    const first = await w.look(w.a, { held, now: 1_000_000 });
    expect(first.posted).toBe(true);
    expect(w.witness.held.length).toBe(1);
    const c = w.witness.held[0]!;
    expect(c.cp[4]).toBe(1);
    // What the member published, which is the head here (the id of its manifest is the hash of its bytes).
    expect(c.cp[5]).toBe(held.manifestHash);
    expect(c.cp[5]).toBe(w.gateway.head!.manifestHash);
    expect(c.spub).toBe(w.a.spub);
    expect((w.witness.posts[0] as { proof?: unknown }).proof).toBeDefined();
    // The same snapshot again is not posted again.
    expect((await w.look(w.a, { held, now: 2_000_000 })).posted).toBeUndefined();
    expect(w.witness.posts.length).toBe(1);
    // Each new snapshot is: there is no wait of five minutes (the daemon keeps the pace, see "the witness, from the agent's round").
    const two = await w.publishA("two");
    expect((await w.look(w.a, { held: { seq: two.seq, manifestHash: manifestIdOf(two.manifestKey) }, now: 2_000_100 })).posted).toBe(true);
    expect(w.witness.held.map((h) => h.cp[4]).sort()).toEqual([1, 2]);
    const state = readWitnessState(w.a.paths.keyFile);
    expect(state.posted?.seq).toBe(2);
    expect(state.posted?.ts).toBe(2_000_100);
  });

  test("says what the member holds, not what the gateway shows now: a member that took in snapshot 1 posts 1 while the head is 2", async () => {
    const w = world();
    const one = await w.publishA("one");
    await w.publishA("two");
    const out = await w.look(w.b, { held: { seq: one.seq, manifestHash: manifestIdOf(one.manifestKey) } });
    expect(out.posted).toBe(true);
    expect(w.witness.held.map((h) => [h.cp[4], h.cp[5]])).toEqual([[1, manifestIdOf(one.manifestKey)]]);
    // A member that holds nothing yet posts nothing.
    expect((await w.look(w.b, { held: null })).posted).toBeUndefined();
  });

  test("a witness that wants the proof sent again gets it, and one that is down leaves the member 'unwitnessed' and nothing else", async () => {
    const w = world();
    await w.publishA("one");
    w.witness.down = true;
    const out = await w.look(w.a);
    expect(out.status).toBe("unwitnessed");
    expect(readWitnessState(w.a.paths.keyFile).checked?.status).toBe("unwitnessed");
    w.witness.down = false;
    // A refused post is not a crash either.
    w.witness.refuse = [409];
    const refused = await w.look(w.a);
    expect(refused.status).toBe("fault");
    expect(refused.error).toContain("replaced or removed");
    expect(readWitnessState(w.a.paths.keyFile).fault?.status).toBe(409);
    // A refusal that is not the operator's to read (a 400 or a 500) is the witness being out of reach.
    w.witness.refuse = [500];
    expect((await w.look(w.a)).status).toBe("unwitnessed");
    expect((await w.look(w.a)).posted).toBe(true);
    // A post that goes through ends the fault.
    expect(readWitnessState(w.a.paths.keyFile).fault).toBeUndefined();
  });

  test("a witness that is full, limiting or does not serve the owner is a fault the operator reads, not 'unwitnessed'", async () => {
    const w = world();
    await w.publishA("one");
    for (const [status, words] of [[507, "full"], [429, "limiting"], [403, "OWNER_KEYS"]] as const) {
      w.witness.refuse = [status];
      const out = await w.look(w.a);
      expect(out.status).toBe("fault");
      expect(out.error).toContain(words);
      const fault = readWitnessState(w.a.paths.keyFile).fault!;
      expect(fault.status).toBe(status);
      expect(fault.what).toContain(words);
    }
  });

  test("a member whose signing key the roster does not name posts nothing", async () => {
    const w = world();
    await w.publishA("one");
    // Its key file now has another signing key than the roster names.
    const file = w.b.paths.keyFile;
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const other = loadOrCreateSignKeyOwner({ ...w.b, paths: { ...w.b.paths, keyFile: join(w.root, "elsewhere.key") } });
    raw.sign = { publicKey: other.publicKey, privateKey: other.privateKeyPem };
    writeFileSync(file, JSON.stringify(raw));
    const out = await w.look(w.b, { heldSeq: 1 });
    expect(out.posted).toBeUndefined();
    expect(out.error).toContain("not in the roster");
    expect(w.witness.held.length).toBe(0);
  });
});

describe("a gateway that shows an older head than another member saw", () => {
  test("is a rollback: the member is told, with who saw what; the alert ends when the gateway shows the head again", async () => {
    const w = world();
    await w.publishA("one");
    const one = { ...w.gateway.head! };
    await w.publishA("two");
    await w.look(w.a); // posts snapshot 2
    // The gateway now shows member B the snapshot before.
    w.gateway.head = one;
    const out = await w.look(w.b, { held: null });
    expect(out.status).toBe("alert");
    const state = readWitnessState(w.b.paths.keyFile);
    expect(state.alert?.kind).toBe("rollback");
    expect(state.alert?.seq).toBe(2);
    expect(state.alert?.headSeq).toBe(1);
    expect(state.alert?.spub).toBe(w.a.spub);
    // The same finding is not new the next time.
    const again = await w.look(w.b, { heldSeq: 1 });
    expect(again.status).toBe("alert");
    expect(readWitnessState(w.b.paths.keyFile).alert?.at).toBe(state.alert!.at);
    // The gateway shows what the others saw: nothing to alert.
    w.gateway.head = { ...w.gateway.head, seq: 2, manifestHash: w.witness.held[0]!.cp[5] } as typeof w.gateway.head;
    const fine = await w.look(w.b, { heldSeq: 2 });
    expect(fine.status).toBe("ok");
    expect(readWitnessState(w.b.paths.keyFile).alert).toBeUndefined();
  });

  test("the witness is read before the head, so a publish between the two is not a rollback", async () => {
    const w = world();
    await w.publishA("one");
    await w.look(w.a);
    // What the witness holds is what it held when it was asked; the head is the newer one.
    const held1 = w.witness.held.slice();
    await w.publishA("two");
    const v = roster(w);
    const verdict = judgeWitness(v, held1, { seq: 2, manifestHash: w.gateway.head!.manifestHash });
    expect(verdict.alert).toBeUndefined();
  });

  test("the same sequence with another manifest than a member saw is said to be a different head", async () => {
    const w = world();
    await w.publishA("one");
    await w.look(w.a);
    // The gateway shows B a head of the same sequence, with another manifest.
    w.gateway.head = { ...w.gateway.head!, manifestHash: H(99) };
    const out = await w.look(w.b, { held: null });
    expect(out.status).toBe("alert");
    expect(readWitnessState(w.b.paths.keyFile).alert?.kind).toBe("different-head");
  });
});

describe("two members shown two histories", () => {
  test("make a fork proof, which is kept, stops this member publishing, and is not raised again once the operator has looked", async () => {
    const w = world();
    await w.publishA("one");
    const seen = w.gateway.head!.manifestHash;
    await w.look(w.a); // A saw (1, real)
    // B was shown another manifest for snapshot 1, and says so.
    const v = roster(w);
    w.gateway.head = { ...w.gateway.head!, manifestHash: H(1) };
    await postCheckpoint(w.witness.url, v, loadOrCreateSignKey(w.b.paths.keyFile), 1, H(1), Date.now(), real());
    const out = await w.look(w.a, { heldSeq: 1 });
    expect(out.status).toBe("fork");
    const fork = forkBlocking(w.a.paths.keyFile)!;
    expect(fork.seq).toBe(1);
    expect([fork.a.cp[5], fork.b.cp[5]].sort()).toEqual([seen, H(1)].sort());
    expect(fork.id).toBe("fork:1:" + [seen, H(1)].sort().join(":"));
    // It stays, whatever the next look finds.
    w.gateway.head = { ...w.gateway.head!, manifestHash: seen };
    await w.look(w.a, { heldSeq: 1 });
    expect(forkBlocking(w.a.paths.keyFile)).toBeDefined();
    // The operator has looked: it is acknowledged, and not raised again from the same two checkpoints.
    updateWitnessState(w.a.paths.keyFile, (s) => {
      s.acknowledged = [fork.id];
      delete s.fork;
    });
    await w.look(w.a, { heldSeq: 1 });
    expect(forkBlocking(w.a.paths.keyFile)).toBeUndefined();
  });

  test("need two keys: one member's two manifests for a sequence are not a fork (it signed twice, and the newest is its word)", () => {
    const w = world();
    const v = roster(w);
    const verdict = judgeWitness(v, [held(w, w.a, 3, H(1)), held(w, w.a, 3, H(2))], { seq: 3, manifestHash: H(2) });
    expect(verdict.forks).toEqual([]);
  });
});

describe("what is not counted", () => {
  test("a checkpoint of a key the roster does not name, of another fleet or incarnation, or with a bad signature is left out", () => {
    const w = world();
    const v = roster(w);
    const stranger = generateOwnerKey();
    const strangerCp = signCheckpoint(checkpointOf(v, 99, H(99), 1), { publicKey: stranger.publicKey, privateKey: stranger.privateKeyPem });
    const otherFleet = held(w, w.b, 98, H(98), { fleet: "elsewhere" });
    const otherKey = held(w, w.b, 97, H(97), { fleetKey: "A".repeat(43) });
    const forged = { ...held(w, w.b, 96, H(96)), sig: held(w, w.b, 1, H(1)).sig };
    const good = held(w, w.a, 1, H(1));
    const verdict = judgeWitness(v, [strangerCp, otherFleet, otherKey, forged, good], { seq: 1, manifestHash: H(1) });
    expect(verdict.counted).toBe(1);
    expect(verdict.ignored).toBe(4);
    expect(verdict.alert).toBeUndefined();
  });

  test("a checkpoint that is ahead of the head is a rollback only when its key is a member's", () => {
    const w = world();
    const v = roster(w);
    const stranger = generateOwnerKey();
    const strangerCp = signCheckpoint(checkpointOf(v, 99, H(99), 1), { publicKey: stranger.publicKey, privateKey: stranger.privateKeyPem });
    expect(judgeWitness(v, [strangerCp], { seq: 1, manifestHash: H(1) }).alert).toBeUndefined();
    expect(judgeWitness(v, [held(w, w.a, 99, H(99))], { seq: 1, manifestHash: H(1) }).alert?.kind).toBe("rollback");
  });
});

describe("where the witness is", () => {
  test("is what was set for the member, else PRIME_FLEET_WITNESS; only an https address (or a local one) is taken", () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-witness-url-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const keyFile = join(root, "m.key");
    expect(witnessUrlOf(keyFile, {})).toBeUndefined();
    expect(witnessUrlOf(keyFile, { PRIME_FLEET_WITNESS: "https://w.example/" })).toBe("https://w.example");
    updateWitnessState(keyFile, (s) => void (s.url = "https://own.example/path/"));
    expect(witnessUrlOf(keyFile, { PRIME_FLEET_WITNESS: "https://w.example/" })).toBe("https://own.example/path");
    expect(normalizeWitnessUrl("http://w.example")).toBeUndefined();
    expect(normalizeWitnessUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(normalizeWitnessUrl("ftp://w.example")).toBeUndefined();
    expect(normalizeWitnessUrl("not a url")).toBeUndefined();
    expect(existsSync(keyFile + ".witness.json")).toBe(true);
  });

  test("no witness set: the look does nothing at all", async () => {
    const w = world();
    const keyFile = w.a.paths.keyFile;
    const out = await lookAtWitness({ creds: credsFor(w.a.id), fleet: "x", keyFile });
    expect(out.status).toBe("off");
    expect((await postHeld({ creds: credsFor(w.a.id), fleet: "x", keyFile, held: { seq: 1, manifestHash: H(1) }, signKey: () => loadOrCreateSignKey(keyFile) })).status).toBe("off");
    expect(existsSync(keyFile + ".witness.json")).toBe(false);
  });

  test("a fleet whose roster is not signed has nothing to be witnessed by, and says so", async () => {
    const w = world();
    w.gateway.roster = undefined;
    const out = await w.look(w.a);
    expect(out.status).toBe("no-roster");
  });

  test("a witness that does not hold the fleet yet is not an alert", async () => {
    const w = world();
    await w.publishA("one");
    const out = await w.look(w.b, { heldSeq: 0 });
    expect(out.status).toBe("not-held");
    expect(await readWitness(w.witness.url, "A".repeat(43), real())).toBeNull();
  });
});

describe("prime fleets witness", () => {
  function command(w: World) {
    const configPath = join(w.root, "cfg", "config.yaml");
    mkdirSync(join(w.root, "cfg"), { recursive: true });
    const space = { id: "s", runtime: "apple", image: "img", mode: "ephemeral", container: "c", token: "t", gateway: "http://gateway.example", gateway_device: w.a.id, remote_token: "token-a", fleet: "x" };
    const out: string[] = [];
    const run = async (sub: string, flags: Record<string, string | boolean> = {}, fleet = "x", space2 = "mine") => {
      const { fleetsWitness } = await import("../src/fleets");
      out.length = 0;
      await fleetsWitness({
        config: { defaults: {}, devices: {}, spaces: { mine: space }, codeMcp: {} },
        configPath,
        json: false,
        out: (l: string) => out.push(l),
        parsed: { positionals: ["fleets", "witness", sub, fleet], flags: new Map<string, string | boolean>(Object.entries({ space: space2, ...flags })), help: false },
      } as never);
      return out.join("\n");
    };
    return { run, keyFile: async () => (await import("../src/fleets")).fleetKeyFile(configPath, "x", "mine") };
  }

  test("set keeps the address beside the key file, status shows what the agent found, and --clear takes it away", async () => {
    const w = world();
    const c = command(w);
    expect(await c.run("status")).toContain("none: set one");
    await expect(c.run("set", { witness: "http://w.example" })).rejects.toThrow(/https/);
    await expect(c.run("set")).rejects.toThrow(/--witness/);
    expect(await c.run("set", { witness: "https://w.example/" })).toContain("https://w.example");
    expect(witnessUrlOf(await c.keyFile(), {})).toBe("https://w.example");
    const keyFile = await c.keyFile();
    updateWitnessState(keyFile, (s) => {
      s.posted = { seq: 4, manifestHash: H(4), at: Date.UTC(2026, 0, 1), ts: Date.UTC(2026, 0, 1) };
      s.checked = { at: Date.UTC(2026, 0, 1, 0, 5), status: "ok", counted: 3, ignored: 1 };
      s.alert = { kind: "rollback", seq: 9, manifestHash: H(9), spub: w.b.spub, headSeq: 4, headHash: H(4), ts: Date.UTC(2026, 0, 2), at: 1 };
    });
    const status = await c.run("status");
    expect(status).toContain("https://w.example");
    expect(status).toContain("snapshot 4");
    expect(status).toContain("3 checkpoints counted, 1 left out");
    expect(status).toContain("ROLLBACK");
    expect(status).toContain("snapshot 9");
    expect(await c.run("set", { clear: true })).toContain("no witness");
    expect(witnessUrlOf(keyFile, {})).toBeUndefined();
  });

  test("clear acknowledges a fork proof (this member publishes again), and says so when there is none", async () => {
    const w = world();
    const c = command(w);
    const keyFile = await c.keyFile();
    expect(await c.run("clear")).toContain("no fork proof");
    const a = held(w, w.a, 3, H(1));
    const b = held(w, w.b, 3, H(2));
    updateWitnessState(keyFile, (s) => {
      s.fork = { id: "fork:3:x", seq: 3, a, b, at: 1 };
    });
    expect(await c.run("status")).toContain("FORK");
    expect(forkBlocking(keyFile)).toBeDefined();
    expect(await c.run("clear")).toContain("fork:3:x");
    expect(forkBlocking(keyFile)).toBeUndefined();
    expect(readWitnessState(keyFile).acknowledged).toEqual(["fork:3:x"]);
    await expect(c.run("clear", {}, "x", "nope")).rejects.toThrow(/unknown space/);
    await expect(c.run("clear", {}, "other")).rejects.toThrow(/not in the fleet/);
  });
});

describe("a key the roster no longer names", () => {
  test("counts for what it saw up to the entry that ended its place, and for nothing after it: it cannot raise a fork or a rollback", () => {
    const w = world();
    w.chain.push({ op: "remove", device: w.b.id, seqAt: 5 } as never);
    const v = roster(w);
    expect(v.tenures.find((t) => t.spub === w.b.spub)?.until).toBe(5);
    const verdict = judgeWitness(v, [held(w, w.a, 10, H(10)), held(w, w.b, 10, H(666)), held(w, w.b, 99, H(99))], { seq: 10, manifestHash: H(10) });
    // Only A's checkpoint is a member's: B was removed at 5, and what it signs for 10 and 99 is not.
    expect(verdict.counted).toBe(1);
    expect(verdict.ignored).toBe(2);
    expect(verdict.alert).toBeUndefined();
    expect(verdict.forks).toEqual([]);
    // What it saw before it was removed is still its own.
    const early = judgeWitness(v, [held(w, w.a, 4, H(4)), held(w, w.b, 4, H(44))], { seq: 4, manifestHash: H(4) });
    expect(early.counted).toBe(2);
    expect(early.forks.length).toBe(1);
  });

  test("the old key of a member whose key was replaced by a rotation is such a key from the rotation on", () => {
    const w = world();
    const next = generateOwnerKey();
    w.chain.push({ op: "rotate", device: w.b.id, xpub: w.b.spub, spub: next.publicKey, role: "member", seqAt: 7 } as never);
    const v = roster(w);
    expect(v.tenures.find((t) => t.spub === w.b.spub)?.until).toBe(7);
    const verdict = judgeWitness(v, [held(w, w.b, 9, H(9)), held(w, w.b, 3, H(3))], { seq: 9, manifestHash: H(9) });
    expect(verdict.counted).toBe(1);
    expect(verdict.alert).toBeUndefined();
  });
});

describe("the witness, from the agent's loop", () => {
  const loopOf = (m: Member): SpaceLoop => ({ paths: m.paths, creds: credsFor(m.id), fleet: "x", name: "mine", primary: false }) as unknown as SpaceLoop;
  /** The fake gateway answers every request: the witness's own are let through to it. */
  function throughToWitness(w: World): void {
    const fake = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = ((url: string, init: RequestInit) => (String(url).startsWith(w.witness.url) ? real()(url, init) : (fake as (u: string, i: RequestInit) => Promise<Response>)(url, init))) as typeof fetch;
  }
  const settle = async (loop: SpaceLoop): Promise<void> => {
    await loop.witnessing;
    if (loop.witnessTimer !== undefined) {
      clearTimeout(loop.witnessTimer);
      loop.witnessTimer = undefined;
    }
  };

  test("posts the checkpoint of each snapshot the member holds, at most one in ten seconds with the newest in place of the skipped, and reads when the snapshot changed, at most once a minute", async () => {
    const w = world();
    throughToWitness(w);
    updateWitnessState(w.a.paths.keyFile, (s) => void (s.url = w.witness.url));
    forgetRosterAnswers();
    await w.publishA("one");
    const said: string[] = [];
    const loop = loopOf(w.a);
    // The first round reads (nothing was read yet), and has nothing to post.
    watchWitness(loop, (t) => said.push(t));
    await settle(loop);
    expect(w.witness.posts.length).toBe(0);
    expect(readWitnessState(w.a.paths.keyFile).checked?.status).toBe("not-held");
    // A snapshot taken in is posted at once, with the hash of its manifest.
    noteHeld(loop, 1, H(1));
    await settle(loop);
    expect(w.witness.posts.length).toBe(1);
    expect(w.witness.held.map((h) => [h.cp[4], h.cp[5]])).toEqual([[1, H(1)]]);
    // The next two come within the ten seconds: they wait, and only the newest is posted.
    noteHeld(loop, 2, H(2));
    noteHeld(loop, 3, H(3));
    await settle(loop);
    expect(w.witness.posts.length).toBe(1);
    loop.witnessPostedAt = Date.now() - 11_000;
    watchWitness(loop, (t) => said.push(t));
    await settle(loop);
    expect(w.witness.posts.length).toBe(2);
    expect(w.witness.held.map((h) => h.cp[4]).sort()).toEqual([1, 3]);
    // The witness was read a moment ago: a changed snapshot is not a reason to read again before a minute is out; after it, it is.
    const readAt = readWitnessState(w.a.paths.keyFile).checked!.at;
    expect(loop.witnessAt).toBeLessThan(readAt + 5_000);
    loop.witnessAt = Date.now() - 30_000;
    loop.witnessReadHeld = "3:" + H(3);
    watchWitness(loop, (t) => said.push(t));
    await settle(loop);
    expect(loop.witnessAt).toBeLessThan(Date.now() - 20_000);
    noteHeld(loop, 4, H(4));
    loop.witnessAt = Date.now() - 61_000;
    loop.witnessPostedAt = Date.now() - 11_000;
    watchWitness(loop, (t) => said.push(t));
    await settle(loop);
    expect(Date.now() - loop.witnessAt!).toBeLessThan(5_000);
    // With nothing changed, it looks again after two minutes and not before.
    loop.witnessAt = Date.now() - 100_000;
    watchWitness(loop, (t) => said.push(t));
    await settle(loop);
    expect(Date.now() - loop.witnessAt).toBeGreaterThan(90_000);
    loop.witnessAt = Date.now() - 121_000;
    watchWitness(loop, (t) => said.push(t));
    await settle(loop);
    expect(Date.now() - loop.witnessAt!).toBeLessThan(5_000);
  });

  test("a witness that refuses the member for a reason a person has to see is reported, and one that is only out of reach is not", async () => {
    const w = world();
    throughToWitness(w);
    updateWitnessState(w.a.paths.keyFile, (s) => void (s.url = w.witness.url));
    forgetRosterAnswers();
    await w.publishA("one");
    const said: string[] = [];
    const loop = loopOf(w.a);
    watchWitness(loop, (t) => said.push(t));
    await settle(loop);
    w.witness.refuse = [507];
    noteHeld(loop, 1, H(1));
    await settle(loop);
    expect(said.join("\n")).toContain("refuses this member");
    expect(said.join("\n")).toContain("full");
    expect(readWitnessState(w.a.paths.keyFile).fault?.status).toBe(507);
    // Said once, not on every look; and the checkpoint is tried again.
    expect(loop.witnessPosted).toBeUndefined();
  });
});
