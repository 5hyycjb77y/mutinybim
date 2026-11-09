/**
 * @jest-environment node
 *
 * Round 8b lane A: the identity provider point. A provider registered with
 * the registry checks its own signatures; the registry checks the digest
 * first and never calls an unknown provider's signature valid. Licence
 * claims say who issued them and who only vouched. Fails on round 8's code:
 * there is no authorship module.
 */
import {
  IDENTITY_PROVIDER_POINT,
  IdentityProviderError,
  IdentityProviderRegistry,
  UNSIGNED_PROVIDER,
  canonicalBytes,
  createTestIdentityProvider,
  licenceStanding,
  type LicenceClaim,
} from "@permitzip/bim-kernel";

const VOUCHED: LicenceClaim = {
  jurisdiction: "US-VA",
  kind: "pe",
  number: "0402-000000",
  discipline: "mechanical-engineering",
  issuer: { id: "us-va-dpor", name: "the Virginia board" },
  evidence: "vouched",
  vouchedBy: { organization: { id: "org-1", name: "PermitZIP" }, voucher: { provider: "test.identity", subject: "admin", kind: "person", displayName: "Office admin" }, relationship: "own_staff", at: "2026-11-01T06:00:00Z" },
};
const ISSUED: LicenceClaim = { ...VOUCHED, evidence: "issuer_credential", vouchedBy: undefined };

const test = createTestIdentityProvider([
  { subject: "jrao", displayName: "J. Rao", keyId: "key-jrao", secret: "s1", licences: [VOUCHED] },
  { subject: "kexample", displayName: "K. Example", keyId: "key-kexample", secret: "s2" },
]);
const payload = canonicalBytes({ record: "merge_approved", part: { discipline: "x", digest: "sha256:00" }, seq: 42 });

describe("a8b-verify-test-provider", () => {
  const registry = new IdentityProviderRegistry([test.provider]);

  it("verifies a signature through its provider", async () => {
    const env = test.sign("jrao", payload, "2026-11-01T06:01:00Z");
    await expect(registry.verifyEnvelope(env, payload)).resolves.toEqual({ status: "valid", signer: expect.objectContaining({ provider: "test.identity", subject: "jrao" }) });
  });

  it("answers invalid for changed content, a forged value and someone else's key", async () => {
    const env = test.sign("jrao", payload);
    const changed = canonicalBytes({ record: "merge_approved", part: { discipline: "y", digest: "sha256:00" }, seq: 42 });
    await expect(registry.verifyEnvelope(env, changed)).resolves.toEqual({ status: "invalid", reason: "What was signed has changed since it was signed." });
    await expect(registry.verifyEnvelope({ ...env, signature: "0".repeat(64) }, payload)).resolves.toMatchObject({ status: "invalid" });
    const theirs = test.sign("kexample", payload);
    const claimed = await registry.verifyEnvelope({ ...theirs, signer: env.signer }, payload);
    expect(claimed).toEqual({ status: "invalid", reason: "The key belongs to K. Example, not J. Rao." });
  });

  it("never calls an unknown provider, an unknown algorithm or an unsigned act valid", async () => {
    const env = test.sign("jrao", payload);
    await expect(new IdentityProviderRegistry().verifyEnvelope(env, payload)).resolves.toEqual({ status: "unverifiable", reason: 'This was signed through "test.identity", which this app can\'t check.' });
    await expect(registry.verifyEnvelope({ ...env, alg: "webauthn-es256" }, payload)).resolves.toMatchObject({ status: "unverifiable" });
    await expect(registry.verifyEnvelope({ ...env, provider: "unsigned", alg: "none" }, payload)).resolves.toEqual({ status: "unverifiable", reason: "This was recorded without a digital signature." });
  });

  it("logs and answers unverifiable when a provider throws", async () => {
    const err = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = new IdentityProviderRegistry([{ ...test.provider, id: "broken.idp", verify: async () => Promise.reject(new Error("network down")) }]);
    const env = { ...test.sign("jrao", payload), provider: "broken.idp" };
    await expect(broken.verifyEnvelope(env, payload)).resolves.toMatchObject({ status: "unverifiable" });
    expect(err).toHaveBeenCalledWith("[authorship] identity provider failed while checking a signature", expect.objectContaining({ provider: "broken.idp" }));
    err.mockRestore();
  });

  it("refuses a malformed or duplicate provider at registration, and the point is versioned with the unsigned built-in", () => {
    expect(() => new IdentityProviderRegistry([test.provider, test.provider])).toThrow(/already registered/);
    expect(() => new IdentityProviderRegistry([{ ...test.provider, id: "Bad Id" }])).toThrow(IdentityProviderError);
    expect(() => new IdentityProviderRegistry([{ ...test.provider, id: "x.y", algorithms: [] }])).toThrow(/no signature algorithm/);
    expect(() => new IdentityProviderRegistry([{ ...UNSIGNED_PROVIDER, label: "Mine" }])).toThrow(/already registered/);
    expect(IDENTITY_PROVIDER_POINT).toMatchObject({ id: "kernel.identity_provider", version: 1 });
    expect(IDENTITY_PROVIDER_POINT.builtins?.()).toEqual([UNSIGNED_PROVIDER]);
  });

  it("resolves claims, and a vouched licence reads differently from a board-issued one", async () => {
    const claims = await registry.resolveAuthor({ provider: "test.identity", subject: "jrao", kind: "person" });
    expect(claims?.licences).toEqual([VOUCHED]);
    await expect(registry.resolveAuthor({ provider: "elsewhere", subject: "jrao", kind: "person" })).resolves.toBeNull();
    expect(licenceStanding(VOUCHED)).toEqual({ level: "vouched", words: "Vouched for by PermitZIP for its own staff (checked by Office admin on 2026-11-01). Not confirmed by the Virginia board." });
    expect(licenceStanding(ISSUED)).toEqual({ level: "confirmed_by_issuer", words: "Confirmed by the Virginia board." });
    expect(licenceStanding({ ...VOUCHED, evidence: "rumour", vouchedBy: undefined }).level).toBe("self_reported");
  });
});
