import { describe, expect, test } from "bun:test";
import { generateMemberKeyPair, openForMember, openPayload, sealForMembers, sealManyForMembers } from "../src/fleet-crypto";
import { applyTestTimeout } from "./setup";

applyTestTimeout();

describe("member keys", () => {
  test("are X25519 pairs whose public half is 32 bytes", () => {
    const pair = generateMemberKeyPair();
    expect(Buffer.from(pair.publicKey, "base64").length).toBe(32);
    expect(pair.privateKey).toContain("PRIVATE KEY");
  });

  test("differ from each other", () => {
    const a = generateMemberKeyPair();
    const b = generateMemberKeyPair();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
  });
});

describe("sealing for members", () => {
  test("every member opens the payload it was wrapped for", () => {
    const sender = generateMemberKeyPair();
    const alice = generateMemberKeyPair();
    const bob = generateMemberKeyPair();
    const plain = Buffer.from("the workspace contents".repeat(50));

    const sealed = sealForMembers(
      plain,
      [
        { memberId: "alice", publicKey: alice.publicKey },
        { memberId: "bob", publicKey: bob.publicKey },
      ],
      sender.privateKey,
      sender.publicKey,
    );

    const openedAlice = openForMember(sealed.ciphertext, sealed.wrapped, sealed.senderPublicKey, "alice", alice.privateKey);
    const openedBob = openForMember(sealed.ciphertext, sealed.wrapped, sealed.senderPublicKey, "bob", bob.privateKey);
    expect(openedAlice && Buffer.compare(openedAlice, plain)).toBe(0);
    expect(openedBob && Buffer.compare(openedBob, plain)).toBe(0);
  });

  test("a member that was not wrapped for cannot open it", () => {
    const sender = generateMemberKeyPair();
    const alice = generateMemberKeyPair();
    const eve = generateMemberKeyPair();
    const plain = Buffer.from("secret");
    const sealed = sealForMembers(plain, [{ memberId: "alice", publicKey: alice.publicKey }], sender.privateKey, sender.publicKey);
    expect(openForMember(sealed.ciphertext, sealed.wrapped, sealed.senderPublicKey, "eve", eve.privateKey)).toBe(null);
  });

  test("a member without the right private key cannot open it", () => {
    const sender = generateMemberKeyPair();
    const alice = generateMemberKeyPair();
    const impostor = generateMemberKeyPair();
    const sealed = sealForMembers(Buffer.from("secret"), [{ memberId: "alice", publicKey: alice.publicKey }], sender.privateKey, sender.publicKey);
    expect(openForMember(sealed.ciphertext, sealed.wrapped, sealed.senderPublicKey, "alice", impostor.privateKey)).toBe(null);
  });

  test("the ciphertext does not contain the plaintext", () => {
    const sender = generateMemberKeyPair();
    const alice = generateMemberKeyPair();
    const plain = Buffer.from("PLAINTEXT-MARKER-12345");
    const sealed = sealForMembers(plain, [{ memberId: "alice", publicKey: alice.publicKey }], sender.privateKey, sender.publicKey);
    expect(sealed.ciphertext.includes(plain)).toBe(false);
    expect(sealed.ciphertext.toString("utf8")).not.toContain("PLAINTEXT-MARKER-12345");
  });

  test("a tampered payload does not open", () => {
    const sender = generateMemberKeyPair();
    const alice = generateMemberKeyPair();
    const sealed = sealForMembers(Buffer.from("secret"), [{ memberId: "alice", publicKey: alice.publicKey }], sender.privateKey, sender.publicKey);
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    expect(openForMember(tampered, sealed.wrapped, sealed.senderPublicKey, "alice", alice.privateKey)).toBe(null);
  });

  test("a member without a public key is skipped rather than breaking the seal", () => {
    const sender = generateMemberKeyPair();
    const alice = generateMemberKeyPair();
    const plain = Buffer.from("payload");
    const sealed = sealForMembers(
      plain,
      [
        { memberId: "alice", publicKey: alice.publicKey },
        { memberId: "no-key" },
      ],
      sender.privateKey,
      sender.publicKey,
    );
    expect(sealed.wrapped).toHaveLength(1);
    const opened = openForMember(sealed.ciphertext, sealed.wrapped, sealed.senderPublicKey, "alice", alice.privateKey);
    expect(opened && Buffer.compare(opened, plain)).toBe(0);
  });
});

describe("the seal of a manifest", () => {
  const fields = {
    fleet: "x", seq: 7, parentSeq: 6, parentManifest: "fleets/x/manifests/abc", tipCommit: "c".repeat(40), tree: "t".repeat(40),
    full: false, packHash: "a".repeat(64), deltaHash: null as string | null, senderPublicKey: "", roster: "a:b" as string | null, incarnation: "inc-1" as string | null,
  };
  const make = () => {
    const alice = generateMemberKeyPair();
    const sender = generateMemberKeyPair();
    const f = { ...fields, senderPublicKey: sender.publicKey };
    const sealed = sealManyForMembers([Buffer.from("x")], [{ memberId: "alice", publicKey: alice.publicKey }], sender.privateKey, sender.publicKey);
    const opened = openPayload(sealed.ciphertexts[0]!, sealed.wrapped, sender.publicKey, "alice", alice.privateKey)!;
    return { f, tag: sealed.seal(f), opened, sealed, alice, sender };
  };

  test("a member that opens the payload can check it", () => {
    const { f, tag, opened } = make();
    // A seal that covers the fleet's incarnation is of a kind of its own: an earlier build says so, not "changed".
    expect(tag.startsWith("v2:")).toBe(true);
    expect(opened.sealMatches(f, tag)).toBe(true);
  });

  test("a seal that covers the incarnation is read under either prefix (an earlier test build wrote v1: for it), and only then", () => {
    const { f, tag, sealed, opened } = make();
    expect(opened.sealMatches(f, "v1:" + tag.slice(3))).toBe(true);
    // The prefix does not stand in for the incarnation: without one, a v2 tag is not what such a publisher seals.
    const without = { ...f, incarnation: null };
    const old = sealed.seal(without);
    expect(opened.sealMatches(without, "v2:" + old.slice(3))).toBe(false);
    expect(opened.sealMatches({ ...f, incarnation: "inc-2" }, "v1:" + tag.slice(3))).toBe(false);
  });

  test("any field changed, and it does not match", () => {
    const { f, tag, opened } = make();
    const changed: Array<Partial<typeof f>> = [
      { fleet: "y" }, { seq: 8 }, { parentSeq: 5 }, { parentSeq: null as unknown as number }, { parentManifest: "other" }, { tipCommit: "d".repeat(40) },
      { tree: "u".repeat(40) }, { full: true }, { packHash: "b".repeat(64) }, { deltaHash: "b".repeat(64) }, { roster: null }, { senderPublicKey: "other" }, { incarnation: "inc-2" }, { incarnation: null },
    ];
    for (const c of changed) expect(opened.sealMatches({ ...f, ...c }, tag)).toBe(false);
  });

  test("a publisher that does not know the incarnation seals what it always did", () => {
    const { f, sealed, opened } = make();
    const without = { ...f, incarnation: null };
    const old = sealed.seal(without);
    expect(old.startsWith("v1:")).toBe(true);
    expect(opened.sealMatches(without, old)).toBe(true);
    // And the seal says which fleet of the name it is, so one of an earlier fleet is not this one's.
    expect(opened.sealMatches(without, sealed.seal(f))).toBe(false);
  });

  test("a seal made under another snapshot key does not match", () => {
    const a = make();
    const b = make();
    expect(a.opened.sealMatches(a.f, b.sealed.seal(a.f))).toBe(false);
  });

  test("a garbage tag does not match and does not throw", () => {
    const { f, opened } = make();
    expect(opened.sealMatches(f, "")).toBe(false);
    expect(opened.sealMatches(f, "v1:")).toBe(false);
  });

  test("the payload still opens for a reader that does not look at the seal", () => {
    const { sealed, alice, sender } = make();
    expect(openForMember(sealed.ciphertexts[0]!, sealed.wrapped, sender.publicKey, "alice", alice.privateKey)?.toString()).toBe("x");
  });
});
