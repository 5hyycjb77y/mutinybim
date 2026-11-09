/**
 * @jest-environment node
 *
 * Round 9 lane S9: the open-source passkey verifier. A fixed WebAuthn-shaped
 * ES256 vector verifies with WebCrypto alone; a single changed byte anywhere
 * (authenticator data, client data, signature, what was signed), another
 * site, another origin, or no Touch ID / PIN does not. Enrolment checks bind
 * the browser's key to the authenticator's. Fails on round 8b's code: there
 * is no `webauthn` module (`verifyWebAuthnEs256` is undefined).
 */
import {
  IdentityProviderRegistry,
  base64UrlDecode,
  base64UrlEncode,
  checkWebAuthnRegistration,
  createWebAuthnIdentityProvider,
  derToP1363,
  hexToBytes,
  packWebAuthnSignature,
  payloadDigest,
  originMatchesRpId,
  sha256HexOf,
  unpackWebAuthnSignature,
  utf8Bytes,
  verifyWebAuthnEs256,
  webAuthnEnvelope,
  type WebAuthnAssertion,
  type WebAuthnKeyRecord,
} from "@permitzip/bim-kernel";
import { VECTOR } from "./s9-webauthn-vector";

function bytes(b64: string): Uint8Array {
  const out = base64UrlDecode(b64);
  if (!out) throw new Error(`bad base64url in the vector: ${b64.slice(0, 12)}`);
  return out;
}

const SPKI = bytes(VECTOR.spki);
const PAYLOAD = utf8Bytes(VECTOR.payload);
const RP = { rpId: VECTOR.rpId, origins: [VECTOR.origin] };
const CHALLENGE: Uint8Array = hexToBytes(VECTOR.recordHash) ?? new Uint8Array();
const EXPECT = { ...RP, challenge: CHALLENGE };

function assertion(overrides: Partial<WebAuthnAssertion> = {}): WebAuthnAssertion {
  return {
    credentialId: VECTOR.credentialId,
    authenticatorData: bytes(VECTOR.authenticatorData),
    clientDataJSON: bytes(VECTOR.clientDataJSON),
    signature: bytes(VECTOR.signature),
    ...overrides,
  };
}

function flipped(b: Uint8Array, at: number): Uint8Array {
  const out = b.slice();
  out[at] = (out[at] ?? 0) ^ 0x01;
  return out;
}

describe("s9-verify-vector: WebAuthn ES256 with WebCrypto, no library", () => {
  it("the vector's challenge is the record hash of its payload", () => {
    expect(sha256HexOf(PAYLOAD)).toBe(VECTOR.recordHash);
    expect(CHALLENGE).toHaveLength(32);
  });

  it("the fixed vector verifies", async () => {
    await expect(verifyWebAuthnEs256(assertion(), SPKI, EXPECT)).resolves.toEqual({ ok: true, signCount: 7, userVerified: true });
  });

  it("a changed byte in the authenticator data, the client data or the signature fails", async () => {
    const auth = bytes(VECTOR.authenticatorData);
    // the last byte of the sign count: still well-formed, so only the signature can catch it
    await expect(verifyWebAuthnEs256(assertion({ authenticatorData: flipped(auth, auth.length - 1) }), SPKI, EXPECT)).resolves.toMatchObject({ ok: false, reason: "The signature doesn't match the key." });
    const client = bytes(VECTOR.clientDataJSON);
    const withSpace = utf8Bytes(new TextDecoder().decode(client).replace('"origin"', ' "origin"'));
    await expect(verifyWebAuthnEs256(assertion({ clientDataJSON: withSpace }), SPKI, EXPECT)).resolves.toMatchObject({ ok: false, reason: "The signature doesn't match the key." });
    const sig = bytes(VECTOR.signature);
    await expect(verifyWebAuthnEs256(assertion({ signature: flipped(sig, sig.length - 1) }), SPKI, EXPECT)).resolves.toMatchObject({ ok: false });
  });

  it("another challenge, origin or relying party fails, in words", async () => {
    await expect(verifyWebAuthnEs256(assertion(), SPKI, { ...EXPECT, challenge: new Uint8Array(32) })).resolves.toEqual({ ok: false, reason: "The passkey signed something else." });
    // oss-clean: legacy-host-id: the vector's signed origin
    await expect(verifyWebAuthnEs256(assertion(), SPKI, { ...EXPECT, origins: ["https://evil.example"] })).resolves.toEqual({ ok: false, reason: "The passkey was used on https://app.polygnotos.test, not on this app." });
    await expect(verifyWebAuthnEs256(assertion(), SPKI, { ...EXPECT, rpId: "evil.example" })).resolves.toEqual({ ok: false, reason: "The passkey belongs to another site, not evil.example." });
  });

  it("no Touch ID, Face ID or PIN (user verified flag off) fails", async () => {
    const auth = bytes(VECTOR.authenticatorData);
    const noUv = auth.slice();
    noUv[32] = 0x01;
    await expect(verifyWebAuthnEs256(assertion({ authenticatorData: noUv }), SPKI, EXPECT)).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("didn't check it was you") });
  });

  it("another key does not verify the vector", async () => {
    const other = bytes(VECTOR.spki).slice();
    other[other.length - 1] = (other[other.length - 1] ?? 0) ^ 0x01;
    await expect(verifyWebAuthnEs256(assertion(), other, EXPECT)).resolves.toMatchObject({ ok: false });
  });

  (process.env.S9_PERF === "1" ? it : it.skip)("one signature verifies inside the budget (signoff.signature.verify_one, 5 ms)", async () => {
    const times: number[] = [];
    for (let run = 0; run < 50; run++) {
      const t0 = performance.now();
      await verifyWebAuthnEs256(assertion(), SPKI, EXPECT);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const p50 = times[25] ?? Infinity;
    const p95 = times[47] ?? Infinity;
    process.stderr.write(`[s9-perf] signoff.signature.verify_one p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms\n`);
    expect(p95).toBeLessThan(5);
  });

  it("the origin rule: https on the site or a subdomain; http only on localhost", async () => {
    expect(originMatchesRpId("https://app.example.test", "app.example.test")).toBe(true);
    expect(originMatchesRpId("https://eu.app.example.test", "app.example.test")).toBe(true);
    expect(originMatchesRpId("http://app.example.test", "app.example.test")).toBe(false);
    expect(originMatchesRpId("https://app.example.test.evil.example", "app.example.test")).toBe(false);
    expect(originMatchesRpId("http://permitzip-3003.localhost:3003", "permitzip-3003.localhost")).toBe(true);
    expect(originMatchesRpId("not a url", "localhost")).toBe(false);
    await expect(verifyWebAuthnEs256(assertion(), SPKI, { rpId: VECTOR.rpId, origins: (o) => originMatchesRpId(o, VECTOR.rpId), challenge: CHALLENGE })).resolves.toMatchObject({ ok: true });
  });

  it("DER is read strictly and the envelope packing round-trips", () => {
    expect(derToP1363(bytes(VECTOR.signature))).toHaveLength(64);
    expect(derToP1363(new Uint8Array([0x30, 0x02, 0x02, 0x00]))).toBeNull();
    expect(derToP1363(new Uint8Array(64))).toBeNull();
    const packed = packWebAuthnSignature(assertion());
    expect(packed).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(unpackWebAuthnSignature(packed, VECTOR.credentialId)).toEqual(assertion());
    expect(unpackWebAuthnSignature("AA", VECTOR.credentialId)).toBeNull();
  });
});

describe("s9-verify-vector: enrolment", () => {
  const reg = {
    credentialId: VECTOR.credentialId,
    clientDataJSON: bytes(VECTOR.regClientDataJSON),
    authenticatorData: bytes(VECTOR.regAuthenticatorData),
    publicKeySpki: SPKI,
    publicKeyAlgorithm: -7,
  };
  const expectReg = { ...RP, challenge: bytes(VECTOR.regChallenge) };

  it("a passkey made for this site, with Touch ID, and this key, enrols", async () => {
    await expect(checkWebAuthnRegistration(reg, expectReg)).resolves.toEqual({ ok: true });
  });

  it("a signature answer, another key, another credential id or another key type is refused", async () => {
    await expect(checkWebAuthnRegistration({ ...reg, clientDataJSON: bytes(VECTOR.clientDataJSON) }, expectReg)).resolves.toMatchObject({ ok: false });
    const swapped = SPKI.slice();
    swapped[swapped.length - 1] = (swapped[swapped.length - 1] ?? 0) ^ 0x01;
    await expect(checkWebAuthnRegistration({ ...reg, publicKeySpki: swapped }, expectReg)).resolves.toEqual({ ok: false, reason: "The key the browser handed over isn't the one the passkey made." });
    await expect(checkWebAuthnRegistration({ ...reg, credentialId: base64UrlEncode(utf8Bytes("someone-else")) }, expectReg)).resolves.toMatchObject({ ok: false, reason: "The passkey's id doesn't match what the browser reported." });
    await expect(checkWebAuthnRegistration({ ...reg, publicKeyAlgorithm: -257 }, expectReg)).resolves.toMatchObject({ ok: false });
  });
});

describe("s9-verify-vector: a passkey provider on the identity point", () => {
  const signer = { provider: "acme.passkeys", subject: VECTOR.signer, kind: "person" as const, displayName: "J. Rao" };
  const env = webAuthnEnvelope({ provider: "acme.passkeys", signer, payloadDigest: payloadDigest(PAYLOAD), assertion: assertion(), signedAt: "2026-11-01T18:00:00Z" });

  function registry(key: WebAuthnKeyRecord | null): IdentityProviderRegistry {
    return new IdentityProviderRegistry([
      createWebAuthnIdentityProvider({
        id: "acme.passkeys",
        label: "Acme sign-in",
        version: "1.0.0",
        relyingParty: RP,
        resolveAuthor: async () => null,
        resolveKey: async (keyId) => (keyId === VECTOR.credentialId ? key : null),
      }),
    ]);
  }

  it("verifies through the registry with zero kernel edits (another firm's provider)", async () => {
    expect(env.payloadDigest).toBe(`sha256:${VECTOR.recordHash}`);
    await expect(registry({ subject: VECTOR.signer, publicKeySpki: SPKI, retiredAt: null }).verifyEnvelope(env, PAYLOAD)).resolves.toMatchObject({ status: "valid", signer: { subject: VECTOR.signer, keyId: VECTOR.credentialId } });
  });

  it("a retired key still verifies its past signature and says when it was retired", async () => {
    await expect(registry({ subject: VECTOR.signer, publicKeySpki: SPKI, retiredAt: "2026-11-02T00:00:00Z" }).verifyEnvelope(env, PAYLOAD)).resolves.toMatchObject({ status: "valid", note: "Signed with a key retired on 2026-11-02." });
  });

  it("someone else's key, an unknown key, a changed payload and an agent signer do not", async () => {
    await expect(registry({ subject: "someone-else", publicKeySpki: SPKI, retiredAt: null }).verifyEnvelope(env, PAYLOAD)).resolves.toMatchObject({ status: "invalid" });
    await expect(registry(null).verifyEnvelope(env, PAYLOAD)).resolves.toMatchObject({ status: "unverifiable" });
    await expect(registry({ subject: VECTOR.signer, publicKeySpki: SPKI, retiredAt: null }).verifyEnvelope(env, utf8Bytes(`${VECTOR.payload} `))).resolves.toEqual({ status: "invalid", reason: "What was signed has changed since it was signed." });
    const agent = { ...env, signer: { provider: "acme.passkeys", subject: `agent:${VECTOR.signer}:run1`, kind: "agent" as const, onBehalfOf: signer } };
    await expect(registry({ subject: VECTOR.signer, publicKeySpki: SPKI, retiredAt: null }).verifyEnvelope(agent, PAYLOAD)).resolves.toMatchObject({ status: "invalid", reason: expect.stringContaining("Only people sign") });
  });
});
