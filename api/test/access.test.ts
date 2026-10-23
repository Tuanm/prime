import { describe, expect, test } from "bun:test";
import { verifyAccessJwt, accessToken } from "../src/access";

// A throwaway RSA keypair, so the verifier is exercised for real.
const pair = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1", alg: "RS256" };
const certs = async () => ({ keys: [jwk] });
const TEAM = "team.example.com";
const AUD = "aud-123";

const b64 = (text: string) => btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function token(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "k1" }) {
  const head = b64(JSON.stringify(header)) + "." + b64(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(head)));
  let raw = "";
  for (const byte of sig) raw += String.fromCharCode(byte);
  return head + "." + btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const at = (t: string) => new Request("https://gw.example/admin", { headers: { "cf-access-jwt-assertion": t } });
const now = Math.floor(Date.now() / 1000);
const good = { iss: "https://" + TEAM, aud: [AUD], exp: now + 600, nbf: now - 10, email: "me@example.com" };

describe("Cloudflare Access verification", () => {
  test("a valid token is accepted, with its email", async () => {
    const v = await verifyAccessJwt(at(await token(good)), { team: TEAM, aud: AUD, certs });
    expect(v.ok).toBe(true);
    expect(v.ok && v.email).toBe("me@example.com");
  });

  test("no token, or a header without one, is refused", async () => {
    expect((await verifyAccessJwt(new Request("https://gw.example/admin"), { team: TEAM, aud: AUD, certs })).ok).toBe(false);
    const v = await verifyAccessJwt(at("not.a.jwt"), { team: TEAM, aud: AUD, certs });
    expect(v.ok).toBe(false);
  });

  test("the cookie works when the header is absent", async () => {
    const t = await token(good);
    const req = new Request("https://gw.example/admin", { headers: { cookie: "a=b; CF_Authorization=" + t } });
    expect((await verifyAccessJwt(req, { team: TEAM, aud: AUD, certs })).ok).toBe(true);
    expect(accessToken(req)).toBe(t);
  });

  test("wrong audience, issuer, expiry and signature are all refused", async () => {
    const cases: [string, Record<string, unknown>][] = [
      ["wrong audience", { ...good, aud: ["other-aud"] }],
      ["wrong issuer", { ...good, iss: "https://evil.example.com" }],
      ["expired", { ...good, exp: now - 120 }],
      ["not valid yet", { ...good, nbf: now + 600 }],
    ];
    for (const [name, payload] of cases) {
      const v = await verifyAccessJwt(at(await token(payload)), { team: TEAM, aud: AUD, certs });
      expect({ name, ok: v.ok }).toEqual({ name, ok: false });
    }
    // A token signed by another key
    const other = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const head = b64(JSON.stringify({ alg: "RS256", kid: "k1" })) + "." + b64(JSON.stringify(good));
    const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", other.privateKey, new TextEncoder().encode(head)));
    let raw = "";
    for (const byte of sig) raw += String.fromCharCode(byte);
    const forged = head + "." + btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect((await verifyAccessJwt(at(forged), { team: TEAM, aud: AUD, certs })).ok).toBe(false);
  });

  test("an unexpected algorithm is refused, and so is an unreachable certificate set", async () => {
    const hs = await token(good, { alg: "HS256", kid: "k1" });
    expect((await verifyAccessJwt(at(hs), { team: TEAM, aud: AUD, certs })).ok).toBe(false);
    const v = await verifyAccessJwt(at(await token(good)), { team: TEAM, aud: AUD, certs: async () => { throw new Error("offline"); } });
    expect(v.ok).toBe(false);
  });
});
