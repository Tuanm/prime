// The gateway's own reading of the roster chain, against the chain made here. The gateway's code (`api/src/fleet-roster.ts`) is
// in this repository once the gateway side has landed; until then there is nothing to read, and the test says so and passes. Set
// PRIME_GATEWAY_ROSTER to a file to read another copy (a branch checked out elsewhere).
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { entryHash, fleetKeyOf, generateOwnerKey, makeEntry, signEntry, verifyChain, type OwnerKey, type RosterEntry, type SignedEntry } from "../src/fleet-roster";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

const file = process.env.PRIME_GATEWAY_ROSTER ?? join(import.meta.dir, "..", "..", "api", "src", "fleet-roster.ts");
const present = existsSync(file);

interface State {
  head: { n: number; hash: string };
  live: Map<string, { xpub: string; spub: string; role: string }>;
}

interface Gateway {
  begin(s: unknown, fleet: string, incarnation: string): Promise<State>;
  extend(state: unknown, s: unknown, trusted?: boolean): Promise<State>;
  entryHash(s: unknown): Promise<string>;
  fleetKeyOf(genesis: unknown[]): Promise<string>;
  parseSigned(v: unknown): { entry: unknown[]; sig: string };
  foldTrusted(entries: unknown[], fleet: string, incarnation: string): Promise<State | null>;
}

const xpub = (n: string): string => Buffer.from(n.padEnd(32, "x")).toString("base64");

class Maker {
  entries: SignedEntry[] = [];
  constructor(readonly owner: OwnerKey, readonly fleet = "acme", readonly incarnation = "inc-1") {}
  push(f: Partial<Parameters<typeof makeEntry>[0]> & { op: RosterEntry[6] }): SignedEntry {
    const last = this.entries[this.entries.length - 1];
    const entry = makeEntry({ fleet: this.fleet, incarnation: this.incarnation, n: this.entries.length, prevHash: last ? entryHash(last) : null, at: 1_700_000_000_000 + this.entries.length, ...f });
    const signed = { entry, sig: signEntry(entry, this.owner.privateKeyPem) };
    this.entries.push(signed);
    return signed;
  }
}

describe("the chain made here, read by the gateway", () => {
  test(present ? "the gateway takes every kind of entry, agrees on every hash, and its fleet key is ours" : "(the gateway's roster code is not in this checkout: nothing to compare with)", async () => {
    if (!present) return;
    const g = (await import(pathToFileURL(file).href)) as Gateway;
    const owner = generateOwnerKey();
    const m = new Maker(owner);
    const member = generateOwnerKey();
    const other = generateOwnerKey();
    m.push({ op: "genesis", seqAt: 0, extra: owner.publicKey });
    m.push({ op: "add", device: "laptop", xpub: xpub("laptop"), spub: member.publicKey, role: "member", seqAt: 0 });
    m.push({ op: "add", device: "viewer-1", xpub: xpub("viewer-1"), spub: other.publicKey, role: "viewer", seqAt: 3 });
    m.push({ op: "rotate", device: "laptop", xpub: xpub("laptop-2"), spub: member.publicKey, seqAt: 5 });
    m.push({ op: "remove", device: "viewer-1", seqAt: 7 });

    let state = await g.begin(m.entries[0], m.fleet, m.incarnation);
    expect(state.head.hash).toBe(entryHash(m.entries[0]!));
    for (const s of m.entries.slice(1)) {
      state = await g.extend(state, s);
      expect(state.head.hash).toBe(entryHash(s));
      expect(await g.entryHash(s)).toBe(entryHash(s));
    }
    expect(await g.fleetKeyOf(m.entries[0]!.entry)).toBe(fleetKeyOf(m.entries[0]!.entry));
    expect([...state.live.keys()]).toEqual(["laptop"]);
    expect(state.live.get("laptop")!.xpub).toBe(xpub("laptop-2"));
    const folded = await g.foldTrusted(m.entries, m.fleet, m.incarnation);
    expect(folded?.head).toEqual(state.head);
    // and what the gateway stores and serves is read here the same way
    const parsed = m.entries.map((s) => g.parseSigned(JSON.parse(JSON.stringify(s))));
    const v = verifyChain(parsed, { fleet: m.fleet, incarnation: m.incarnation });
    expect(v.head.n).toBe(4);
  });

  test(present ? "an entry the gateway refuses is one this side refuses too: a wrong signer, a gap, another fleet" : "(the gateway's roster code is not in this checkout)", async () => {
    if (!present) return;
    const g = (await import(pathToFileURL(file).href)) as Gateway;
    const owner = generateOwnerKey();
    const intruder = generateOwnerKey();
    const m = new Maker(owner);
    m.push({ op: "genesis", seqAt: 0, extra: owner.publicKey });
    const state = await g.begin(m.entries[0], m.fleet, m.incarnation);
    const forged = (by: OwnerKey, mutate: (e: RosterEntry) => RosterEntry = (e) => e): SignedEntry => {
      const entry = mutate(makeEntry({ fleet: "acme", incarnation: "inc-1", n: 1, prevHash: entryHash(m.entries[0]!), at: 1_700_000_000_001, op: "add", device: "d", xpub: xpub("d"), spub: generateOwnerKey().publicKey, role: "member", seqAt: 0 }));
      return { entry, sig: signEntry(entry, by.privateKeyPem) };
    };
    const refusedBy = async (s: SignedEntry): Promise<boolean> => g.extend(state, s).then(() => false, () => true);
    const refusedHere = (s: SignedEntry): boolean => {
      try {
        verifyChain([m.entries[0], s], { fleet: "acme", incarnation: "inc-1" });
        return false;
      } catch {
        return true;
      }
    };
    const cases: SignedEntry[] = [
      forged(intruder),
      forged(owner, (e) => [...e.slice(0, 3), 2, ...e.slice(4)] as RosterEntry),
      forged(owner, (e) => [...e.slice(0, 1), "other", ...e.slice(2)] as RosterEntry),
      forged(owner, (e) => [...e.slice(0, 2), "inc-2", ...e.slice(3)] as RosterEntry),
      forged(owner, (e) => [...e.slice(0, 4), "x".repeat(43), ...e.slice(5)] as RosterEntry),
    ];
    for (const c of cases) {
      expect(await refusedBy(c)).toBe(true);
      expect(refusedHere(c)).toBe(true);
    }
    // the one that is right is taken by both
    const good = forged(owner);
    expect(await refusedBy(good)).toBe(false);
    expect(refusedHere(good)).toBe(false);
  });
});
