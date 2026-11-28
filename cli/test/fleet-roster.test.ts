// The owner-signed chain: the forms the witness reads, what a chain says, and every way a chain can be wrong.
import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { rawPublicKey } from "../src/caller-key";
import {
  RosterError,
  checkEntryShape,
  createOwnerKeyFile,
  entryHash,
  fleetKeyOf,
  generateOwnerKey,
  isFingerprint,
  liveMembers,
  makeEntry,
  membersAt,
  mayPublishAt,
  normalizeFingerprint,
  ownerFingerprint,
  ownerKeyFromPem,
  readOwnerKey,
  readRosterCache,
  signEntry,
  verifyChain,
  verifyEntry,
  writeRosterCache,
  type OwnerKey,
  type RosterEntry,
  type SignedEntry,
} from "../src/fleet-roster";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

interface Device {
  key: OwnerKey;
  spub: string;
  xpub: string;
}
const device = (): Device => {
  const key = generateOwnerKey();
  // The X25519 key as the gateway holds it: standard base64 with padding.
  const xpub = createHash("sha256").update(key.publicKey).digest().toString("base64");
  return { key, spub: key.publicKey, xpub };
};

/** A chain under construction, signing as the tests say. */
class Builder {
  entries: SignedEntry[] = [];
  at = 1_000;
  constructor(
    readonly owner: OwnerKey,
    readonly fleet = "credio",
    readonly incarnation = "inc-1",
  ) {}
  push(op: RosterEntry[6], f: { device?: string; xpub?: string | null; spub?: string | null; role?: string; seqAt?: number | null; extra?: string | null }, signer: OwnerKey = this.owner): SignedEntry {
    const last = this.entries[this.entries.length - 1];
    const entry = makeEntry({
      fleet: this.fleet,
      incarnation: this.incarnation,
      n: this.entries.length,
      prevHash: last ? entryHash(last) : null,
      at: (this.at += 10),
      op,
      ...f,
    });
    const signed = { entry, sig: signEntry(entry, signer.privateKeyPem) };
    this.entries.push(signed);
    return signed;
  }
  genesis(seqAt = 0): this {
    this.push("genesis", { seqAt, extra: this.owner.publicKey });
    return this;
  }
  add(id: string, d: Device, seqAt: number, role = "member"): this {
    this.push("add", { device: id, xpub: d.xpub, spub: d.spub, role, seqAt });
    return this;
  }
}

describe("the forms", () => {
  const good = (): unknown[] => ["prime-roster-v1", "credio", "inc-1", 0, null, 5, "genesis", null, null, null, null, 0, generateOwnerKey().publicKey];

  test("an entry of 13 strings, integers and nulls is one", () => {
    expect(checkEntryShape(good())).toHaveLength(13);
  });

  test("anything else is not: length, tag, objects, floats, long strings, names, keys, operations, roles", () => {
    const withAt = (i: number, v: unknown): unknown[] => good().map((x, k) => (k === i ? v : x));
    for (const bad of [
      good().slice(0, 12),
      [...good(), null],
      withAt(0, "prime-roster-v2"),
      withAt(1, "has space"),
      withAt(1, ""),
      withAt(2, "x".repeat(129)),
      withAt(3, 1.5),
      withAt(3, -1),
      withAt(3, Number.MAX_SAFE_INTEGER + 2),
      withAt(5, {}),
      withAt(5, [1]),
      withAt(6, "grant"),
      withAt(7, "bad device!"),
      withAt(9, "short"),
      withAt(9, "A".repeat(44)),
      withAt(10, "admin"),
      withAt(11, 0.5),
      withAt(12, "x".repeat(257)),
      withAt(12, true),
      withAt(4, 5),
    ]) {
      expect(() => checkEntryShape(bad)).toThrow(RosterError);
    }
  });

  test("a signature is Ed25519 over the entry's JSON, and nothing else verifies it", () => {
    const owner = generateOwnerKey();
    const entry = checkEntryShape(good());
    const sig = signEntry(entry, owner.privateKeyPem);
    expect(sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(verifyEntry(entry, sig, owner.publicKey)).toBe(true);
    expect(verifyEntry(entry, sig, generateOwnerKey().publicKey)).toBe(false);
    expect(verifyEntry([...entry.slice(0, 5), 99, ...entry.slice(6)] as RosterEntry, sig, owner.publicKey)).toBe(false);
    expect(verifyEntry(entry, "x", owner.publicKey)).toBe(false);
    expect(verifyEntry(entry, sig, "short")).toBe(false);
  });

  test("a hash that is the next entry's prevHash covers the entry and its signature; the fleetKey the entry alone", () => {
    const owner = generateOwnerKey();
    const entry = checkEntryShape(["prime-roster-v1", "credio", "inc-1", 0, null, 5, "genesis", null, null, null, null, 0, owner.publicKey]);
    const sig = signEntry(entry, owner.privateKeyPem);
    const expected = createHash("sha256").update(Buffer.from(JSON.stringify(entry), "utf8")).update(Buffer.from(sig, "base64url")).digest("base64url");
    expect(entryHash({ entry, sig })).toBe(expected);
    const key = fleetKeyOf(entry);
    expect(key).toBe(createHash("sha256").update(Buffer.from(JSON.stringify(entry), "utf8")).digest("base64url"));
    expect(key).toHaveLength(43);
    expect(key).not.toBe(entryHash({ entry, sig }));
  });

  test("the witness accepts what is made here: the same fleetKey, and a proof it verifies", async () => {
    const witness = join(import.meta.dir, "..", "..", "api", "witness", "src", "lib.ts");
    // The witness is in this repository: a path that moved is a test that must say so, not one that passes without looking.
    expect(existsSync(witness)).toBe(true);
    const lib = (await import(pathToFileURL(witness).href)) as {
      fleetKeyOf(g: unknown[]): Promise<string>;
      checkProof(c: unknown, key: string): Promise<{ ok: boolean; error?: string }>;
    };
    const owner = generateOwnerKey();
    const m = device();
    const b = new Builder(owner).genesis().add("laptop", m, 0);
    const [genesis, add] = b.entries as [SignedEntry, SignedEntry];
    expect(await lib.fleetKeyOf(genesis.entry)).toBe(fleetKeyOf(genesis.entry));
    const cp = ["prime-cp-v1", fleetKeyOf(genesis.entry), "credio", "inc-1", 3, "m".repeat(10), 1, Date.now()];
    const checked = await lib.checkProof({ cp, sig: "", spub: m.spub, proof: { genesis: genesis.entry, entry: add.entry, sig: add.sig } }, fleetKeyOf(genesis.entry));
    expect(checked).toMatchObject({ ok: true });
  });
});

describe("the owner key", () => {
  test("is Ed25519, 32 raw bytes as base64url, and its fingerprint is 26 base32 characters in groups", () => {
    const k = generateOwnerKey();
    expect(k.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(k.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    const fp = ownerFingerprint(k.publicKey);
    expect(fp).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{6}$/);
    expect(isFingerprint(fp)).toBe(true);
    expect(isFingerprint(fp.toLowerCase().replace(/-/g, " "))).toBe(true);
    expect(isFingerprint("nope")).toBe(false);
    expect(ownerFingerprint(k.publicKey)).toBe(fp);
    expect(ownerFingerprint(generateOwnerKey().publicKey)).not.toBe(fp);
    expect(normalizeFingerprint(fp.toLowerCase())).toBe(fp.replace(/-/g, ""));
    expect(ownerKeyFromPem(k.privateKeyPem).publicKey).toBe(k.publicKey);
  });

  test("is not read from anything that is not an Ed25519 private key", () => {
    expect(() => ownerKeyFromPem("not a key")).toThrow(/Ed25519 private key/);
    const x = generateKeyPairSync("x25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => ownerKeyFromPem(x)).toThrow(/not an Ed25519/);
  });

  test("is written once, with mode 0600, and never over another", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-key-"));
    try {
      const file = join(dir, "sub", "credio.ed25519.pem");
      const k = createOwnerKeyFile(file);
      expect(readOwnerKey(file).publicKey).toBe(k.publicKey);
      if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
      const before = readFileSync(file, "utf8");
      expect(() => createOwnerKeyFile(file)).toThrow(/already an owner key/);
      expect(readFileSync(file, "utf8")).toBe(before);
      expect(() => readOwnerKey(join(dir, "none.pem"))).toThrow(/no owner key at/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a public key from the owner key matches the one node derives", () => {
    const pair = generateKeyPairSync("ed25519");
    const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(ownerKeyFromPem(pem).publicKey).toBe(rawPublicKey(pair.publicKey).toString("base64url"));
  });
});

describe("a chain", () => {
  test("from a genesis through adds, a rotation of each kind, a role, a caller and a removal is read", () => {
    const owner = generateOwnerKey();
    const a = device();
    const b = device();
    const a2 = device();
    const b2 = device();
    const buddy = generateOwnerKey();
    const c = new Builder(owner).genesis().add("laptop", a, 0, "owner").add("server", b, 4);
    // laptop's signing key changes by its own hand, the server's keys by the owner's.
    c.push("rotate-self", { device: "laptop", xpub: a.xpub, spub: a2.spub, seqAt: 10 }, a.key);
    c.push("rotate", { device: "server", xpub: b2.xpub, spub: b2.spub, seqAt: 12 });
    c.push("role", { device: "server", role: "viewer", seqAt: 20 });
    c.push("caller", { spub: buddy.publicKey, extra: "my laptop" });
    c.push("remove", { device: "server", seqAt: 30 });

    const v = verifyChain(c.entries);
    expect(v.fleet).toBe("credio");
    expect(v.incarnation).toBe("inc-1");
    expect(v.head.n).toBe(7);
    expect(v.head.hash).toBe(entryHash(c.entries[7]!));
    expect(v.fleetKey).toBe(fleetKeyOf(c.entries[0]!.entry));
    expect(v.owner).toBe(owner.publicKey);
    expect(v.callers).toEqual([{ spub: buddy.publicKey, label: "my laptop", n: 6 }]);

    expect(membersAt(v, 2).map((t) => t.device)).toEqual(["laptop"]);
    expect(membersAt(v, 5).map((t) => t.device).sort()).toEqual(["laptop", "server"]);
    // The old key of the server holds to the sequence of the rotation; the new one from it.
    expect(mayPublishAt(v, b.xpub, 11)).toBe(true);
    expect(mayPublishAt(v, b.xpub, 13)).toBe(false);
    expect(mayPublishAt(v, b2.xpub, 12)).toBe(true);
    expect(mayPublishAt(v, b2.xpub, 15)).toBe(true);
    // A viewer reads and does not publish; a removed member publishes up to where it was removed.
    expect(mayPublishAt(v, b2.xpub, 22)).toBe(false);
    expect(membersAt(v, 22).find((t) => t.device === "server")?.role).toBe("viewer");
    expect(membersAt(v, 31).map((t) => t.device)).toEqual(["laptop"]);
    // Not before it was added, and never a key the chain does not know.
    expect(mayPublishAt(v, b.xpub, 3)).toBe(false);
    expect(mayPublishAt(v, device().xpub, 5)).toBe(false);
    expect(liveMembers(v).map((t) => t.device)).toEqual(["laptop"]);
    // rotate-self changed the signing key and left the key snapshots are sealed for.
    expect(liveMembers(v)[0]).toMatchObject({ device: "laptop", xpub: a.xpub, spub: a2.spub, role: "owner" });
  });

  test("a removed device can be added again, and its places are kept apart", () => {
    const owner = generateOwnerKey();
    const a = device();
    const a2 = device();
    const c = new Builder(owner).genesis().add("laptop", a, 0);
    c.push("remove", { device: "laptop", seqAt: 5 });
    c.add("laptop", a2, 9);
    const v = verifyChain(c.entries);
    expect(mayPublishAt(v, a.xpub, 5)).toBe(true);
    expect(mayPublishAt(v, a.xpub, 6)).toBe(false);
    expect(mayPublishAt(v, a2.xpub, 8)).toBe(false);
    expect(mayPublishAt(v, a2.xpub, 9)).toBe(true);
  });

  test("an owner-rotate hands the signing of the chain to the new key", () => {
    const owner = generateOwnerKey();
    const next = generateOwnerKey();
    const a = device();
    const c = new Builder(owner).genesis();
    c.push("owner-rotate", { extra: next.publicKey });
    c.push("add", { device: "laptop", xpub: a.xpub, spub: a.spub, role: "member", seqAt: 1 }, next);
    const v = verifyChain(c.entries);
    expect(v.owner).toBe(next.publicKey);
    expect(v.genesisOwner).toBe(owner.publicKey);
    // The old key signs nothing after it.
    c.push("remove", { device: "laptop", seqAt: 2 }, owner);
    expect(() => verifyChain(c.entries)).toThrow(/not signed by the owner key/);
  });

  test("the owner fingerprint a member pinned must be the genesis owner's", () => {
    const owner = generateOwnerKey();
    const c = new Builder(owner).genesis();
    expect(verifyChain(c.entries, { ownerFp: ownerFingerprint(owner.publicKey) }).head.n).toBe(0);
    expect(verifyChain(c.entries, { ownerFp: ownerFingerprint(owner.publicKey).toLowerCase().replace(/-/g, "") }).head.n).toBe(0);
    expect(() => verifyChain(c.entries, { ownerFp: ownerFingerprint(generateOwnerKey().publicKey) })).toThrow(/not the one this member pinned/);
  });

  test("it is for the fleet and the incarnation asked for", () => {
    const c = new Builder(generateOwnerKey()).genesis();
    expect(() => verifyChain(c.entries, { fleet: "other" })).toThrow(/of the fleet credio/);
    expect(() => verifyChain(c.entries, { incarnation: "inc-2" })).toThrow(/earlier fleet/);
    expect(verifyChain(c.entries, { fleet: "credio", incarnation: "inc-1" }).head.n).toBe(0);
  });

  const base = (): Builder => {
    const b = new Builder(generateOwnerKey()).genesis();
    b.add("laptop", device(), 0).add("server", device(), 0).add("desktop", device(), 0);
    return b;
  };

  test("an entry that was changed, replaced, dropped, repeated or reordered breaks it", () => {
    const b = base();
    const e = b.entries;
    const edit = (i: number, f: (x: RosterEntry) => RosterEntry): SignedEntry[] => e.map((s, k) => (k === i ? { entry: f(s.entry), sig: s.sig } : s));
    expect(() => verifyChain(edit(2, (x) => [...x.slice(0, 11), 99, x[12]] as RosterEntry))).toThrow(/not signed/);
    expect(() => verifyChain([e[0]!, e[2]!, e[3]!])).toThrow(/entry 1 says it is entry 2/);
    expect(() => verifyChain([e[0]!, e[1]!, e[1]!])).toThrow(/entry 2 says it is entry 1/);
    expect(() => verifyChain([e[0]!, e[2]!, e[1]!])).toThrow(/says it is entry/);
    expect(() => verifyChain([e[1]!, e[2]!])).toThrow(/genesis/);
    expect(() => verifyChain([])).toThrow(/no entries/);
  });

  test("an entry that does not name the hash of the one before is a different history, even if signed by the owner", () => {
    const b = base();
    // The owner signs an entry 2 that names another entry 1.
    const forged = makeEntry({ fleet: "credio", incarnation: "inc-1", n: 2, prevHash: "x".repeat(43), at: 1, op: "add", device: "x", xpub: "k", spub: null, role: "member", seqAt: 1 });
    expect(() => verifyChain([b.entries[0]!, b.entries[1]!, { entry: forged, sig: signEntry(forged, b.owner.privateKeyPem) }])).toThrow(/does not follow entry 1/);
  });

  test("a signature by anyone but the owner (or, for rotate-self, the device) is refused", () => {
    const owner = generateOwnerKey();
    const gateway = generateOwnerKey();
    const a = device();
    const b = new Builder(owner).genesis().add("laptop", a, 0);
    const c = new Builder(owner).genesis();
    c.entries = [...b.entries];
    c.push("add", { device: "evil", xpub: "gwkey", spub: gateway.publicKey, role: "member", seqAt: 1 }, gateway);
    expect(() => verifyChain(c.entries)).toThrow(/not signed by the owner key/);
    // rotate-self signed by the owner, or by another device's key, or for a device that is not a member.
    for (const signer of [owner, gateway]) {
      const d = new Builder(owner).genesis().add("laptop", a, 0);
      d.push("rotate-self", { device: "laptop", xpub: a.xpub, spub: gateway.publicKey, seqAt: 1 }, signer);
      expect(() => verifyChain(d.entries)).toThrow(/not signed by the key the device holds its place with/);
    }
    const e = new Builder(owner).genesis();
    e.push("rotate-self", { device: "ghost", xpub: a.xpub, spub: a.spub, seqAt: 1 }, a.key);
    expect(() => verifyChain(e.entries)).toThrow(/not signed by the key the device holds/);
  });

  test("a rotate-self may not change the key snapshots are sealed for", () => {
    const owner = generateOwnerKey();
    const a = device();
    const d = new Builder(owner).genesis().add("laptop", a, 0);
    d.push("rotate-self", { device: "laptop", xpub: "another=", spub: a.spub, seqAt: 1 }, a.key);
    expect(() => verifyChain(d.entries)).toThrow(/only the owner may/);
  });

  test("an add of a member that is there, a remove of one that is not, and what goes back in time are refused", () => {
    const a = device();
    const owner = generateOwnerKey();
    expect(() => verifyChain(new Builder(owner).genesis().add("laptop", a, 0).add("laptop", a, 1).entries)).toThrow(/already a member/);
    const r = new Builder(owner).genesis();
    r.push("remove", { device: "laptop", seqAt: 1 });
    expect(() => verifyChain(r.entries)).toThrow(/not a member/);
    const back = new Builder(owner).genesis().add("laptop", a, 10);
    back.push("remove", { device: "laptop", seqAt: 5 });
    expect(() => verifyChain(back.entries)).toThrow(/from before it was added/);
    const nokey = new Builder(owner).genesis();
    nokey.push("add", { device: "laptop", spub: a.spub, role: "member", seqAt: 1 });
    expect(() => verifyChain(nokey.entries)).toThrow(/no key \(xpub\)/);
    const noseq = new Builder(owner).genesis();
    noseq.push("add", { device: "laptop", xpub: a.xpub, spub: a.spub, role: "member" });
    expect(() => verifyChain(noseq.entries)).toThrow(/no seqAt/);
    const norole = new Builder(owner).genesis();
    norole.push("add", { device: "laptop", xpub: a.xpub, spub: a.spub, seqAt: 1 });
    expect(() => verifyChain(norole.entries)).toThrow(/no role/);
  });

  test("a second genesis, an entry of another fleet or incarnation, and a caller removed that was never added are refused", () => {
    const owner = generateOwnerKey();
    const g2 = new Builder(owner).genesis();
    g2.push("genesis", { seqAt: 0, extra: owner.publicKey });
    expect(() => verifyChain(g2.entries)).toThrow(/second genesis/);
    const other = new Builder(owner, "other", "inc-1");
    const mixed = new Builder(owner).genesis();
    other.entries = [mixed.entries[0]!];
    other.push("add", { device: "x", xpub: "k", spub: null, role: "member", seqAt: 1 });
    expect(() => verifyChain(other.entries)).toThrow(/another fleet or incarnation/);
    const cr = new Builder(owner).genesis();
    cr.push("caller-remove", { spub: generateOwnerKey().publicKey });
    expect(() => verifyChain(cr.entries)).toThrow(/was not added/);
  });

  test("a genesis that is not signed by the key it names, or names none, is refused", () => {
    const owner = generateOwnerKey();
    const other = generateOwnerKey();
    const entry = makeEntry({ fleet: "credio", incarnation: "inc-1", n: 0, prevHash: null, at: 1, op: "genesis", seqAt: 0, extra: owner.publicKey });
    expect(() => verifyChain([{ entry, sig: signEntry(entry, other.privateKeyPem) }])).toThrow(/not signed by the owner key it names/);
    const none = makeEntry({ fleet: "credio", incarnation: "inc-1", n: 0, prevHash: null, at: 1, op: "genesis", seqAt: 0 });
    expect(() => verifyChain([{ entry: none, sig: signEntry(none, owner.privateKeyPem) }])).toThrow(/does not name an owner key/);
  });

  test("a chain that does not extend what a member has seen is a rollback or a fork", () => {
    const b = base();
    const seen = { n: 3, hash: entryHash(b.entries[3]!) };
    expect(verifyChain(b.entries, { pinned: seen }).head.n).toBe(3);
    // The gateway shows the chain as it was before the last entry.
    expect(() => verifyChain(b.entries.slice(0, 3), { pinned: seen })).toThrow(/older roster/);
    // Or another history of the same length.
    const fork = new Builder(b.owner).genesis();
    fork.add("laptop", device(), 0).add("server", device(), 0).add("desktop", device(), 0);
    fork.entries[0] = b.entries[0]!;
    expect(() => verifyChain(fork.entries, { pinned: seen })).toThrow(/another history|does not follow|not signed/);
    // More entries after it are fine.
    b.push("role", { device: "laptop", role: "owner", seqAt: 2 });
    expect(verifyChain(b.entries, { pinned: seen }).head.n).toBe(4);
  });

  test("a chain is read from what was kept, and checked again", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-cache-"));
    try {
      const keyFile = join(dir, "m.key");
      expect(readRosterCache(keyFile)).toEqual([]);
      const b = base();
      writeRosterCache(keyFile, b.entries);
      expect(verifyChain(readRosterCache(keyFile)).head.n).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
