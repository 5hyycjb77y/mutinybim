/**
 * @jest-environment node
 *
 * Round 8b lane A: most people acting on a model hold no licence (employees,
 * drafters, contractors, third parties, agents acting for them). An
 * unlicensed author round-trips, is attributed on edits, proposals and
 * approvals, and signs and verifies exactly like a licensed one; verifying
 * never reads licence claims; only sealing needs a licence. Fails on round 8's
 * code: there is no authorship module.
 */
import {
  IdentityProviderRegistry,
  agentAuthor,
  attachSignature,
  authorFromActor,
  canonicalBytes,
  createTestIdentityProvider,
  licenceRefusal,
  readAuthorRef,
  requiresLicence,
  writeAuthorRef,
  writeSignatureEnvelope,
  type AuthorClaims,
  type AuthorRef,
  type Attribution,
  type AuthorshipRole,
  type IdentityProviderDef,
  type LicenceClaim,
} from "@permitzip/bim-kernel";

const PE: LicenceClaim = { jurisdiction: "US-VA", kind: "pe", number: "0402-000000", issuer: { id: "us-va-dpor" }, evidence: "self_reported" };

const test = createTestIdentityProvider([
  { subject: "drafter", displayName: "A. Drafter", keyId: "key-drafter", secret: "s1" },
  { subject: "pe", displayName: "J. Rao", keyId: "key-pe", secret: "s2", licences: [PE] },
]);
const ref = (subject: string, displayName: string): AuthorRef => ({ provider: "test.identity", subject, kind: "person", displayName });
const DRAFTER = ref("drafter", "A. Drafter");
const LICENSED = ref("pe", "J. Rao");
const payload = canonicalBytes({ record: "merge_approved", seq: 7 });

describe("a8b-unlicensed-author", () => {
  it("an author with no licence round-trips and resolves with an empty licence list", async () => {
    const read = readAuthorRef(writeAuthorRef(DRAFTER));
    if (!read.ok) throw new Error(read.reason);
    expect(read.value).toEqual(DRAFTER);
    const claims = await new IdentityProviderRegistry([test.provider]).resolveAuthor(DRAFTER);
    expect(claims?.licences).toEqual([]);
  });

  it("is attributed on edits, proposals and approvals, and so is an agent acting for them", () => {
    const edit = authorFromActor({ id: "drafter", name: "A. Drafter", kind: "human" }, "test.identity");
    const agent = agentAuthor(DRAFTER, "run-1", "Model agent");
    for (const role of ["authored", "proposed", "approved", "accepted", "answered", "classified"] satisfies AuthorshipRole[]) {
      expect(licenceRefusal(role, [], "US-VA")).toBeNull();
      const act: Attribution = { author: edit, role, at: "2026-11-01T06:00:00Z" };
      expect(writeAuthorRef(act.author).subject).toBe("drafter");
    }
    expect(writeAuthorRef(agent).onBehalfOf?.subject).toBe("drafter");
  });

  it("signs and verifies exactly like a licensed author", async () => {
    const registry = new IdentityProviderRegistry([test.provider]);
    for (const [who, author] of [["drafter", DRAFTER], ["pe", LICENSED]] as const) {
      const env = test.sign(who, payload);
      expect(attachSignature({ author, role: "approved", at: "2026-11-01T06:00:00Z" }, env).signature).toBe(env);
      expect(writeSignatureEnvelope(env).signer.subject).toBe(who);
      await expect(registry.verifyEnvelope(env, payload)).resolves.toMatchObject({ status: "valid", signer: { subject: who } });
    }
  });

  it("verifyEnvelope never reads licence claims", async () => {
    const resolveAuthor = jest.fn(async (): Promise<AuthorClaims | null> => {
      throw new Error("verify must not ask for claims");
    });
    const provider: IdentityProviderDef = { ...test.provider, resolveAuthor };
    const registry = new IdentityProviderRegistry([provider]);
    await expect(registry.verifyEnvelope(test.sign("drafter", payload), payload)).resolves.toMatchObject({ status: "valid" });
    expect(resolveAuthor).not.toHaveBeenCalled();
  });

  it("only sealing needs a licence, refused in plain words", () => {
    expect(requiresLicence("sealed")).toBe(true);
    for (const role of ["authored", "proposed", "approved", "declined", "accepted", "answered", "classified", "a-firm-role"]) expect(requiresLicence(role)).toBe(false);
    expect(licenceRefusal("sealed", [], "US-VA")).toBe("Sealing needs a licence on record for US-VA; approving doesn't.");
    expect(licenceRefusal("sealed", [PE], "US-MD")).toBe("Sealing needs a licence on record for US-MD; approving doesn't.");
    expect(licenceRefusal("sealed", [PE], "US-VA")).toBeNull();
    expect(licenceRefusal("approved", [], "US-VA")).toBeNull();
  });
});
