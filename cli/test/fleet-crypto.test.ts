import { describe, expect, test } from "bun:test";
import { generateMemberKeyPair, openForMember, sealForMembers } from "../src/fleet-crypto";

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
