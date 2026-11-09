/**
 * @jest-environment node
 *
 * Round 8b lane A: only people sign. An agent acting for a person can't
 * carry that person's signature, can't be written as a signer, and a
 * verifier answers invalid for an agent signer even when a provider would
 * say yes. Fails on round 8's code: there is no authorship module.
 */
import {
  IdentityProviderRegistry,
  agentAuthor,
  attachSignature,
  canonicalBytes,
  createTestIdentityProvider,
  writeSignatureEnvelope,
  type Attribution,
  type IdentityProviderDef,
} from "@permitzip/bim-kernel";

const test = createTestIdentityProvider([{ subject: "jrao", displayName: "J. Rao", keyId: "key-jrao", secret: "s1" }]);
const PERSON = { provider: "test.identity", subject: "jrao", kind: "person", displayName: "J. Rao" } as const;
const payload = canonicalBytes({ record: "responsibility_accepted", seq: 1 });

describe("a8b-agent-cannot-sign", () => {
  it("refuses a signature claiming the person on the agent's act", () => {
    const act: Attribution = { author: agentAuthor(PERSON, "run-1", "Model agent"), role: "approved", at: "2026-11-01T06:00:00Z" };
    expect(() => attachSignature(act, test.sign("jrao", payload))).toThrow("Agents can't sign. J. Rao signs this themselves.");
  });

  it("attaches a person's own signature to their own act, and refuses someone else's", () => {
    const act: Attribution = { author: PERSON, role: "approved", at: "2026-11-01T06:00:00Z" };
    const env = test.sign("jrao", payload);
    expect(attachSignature(act, env).signature).toBe(env);
    expect(() => attachSignature({ ...act, author: { ...PERSON, subject: "kexample", displayName: "K. Example" } }, env)).toThrow(/People sign only their own acts/);
  });

  it("the writer refuses an agent signer and the verifier answers invalid even when the provider says yes", async () => {
    const agent = agentAuthor(PERSON, "run-1", "Model agent");
    const env = { ...test.sign("jrao", payload), signer: agent };
    expect(() => writeSignatureEnvelope(env)).toThrow("Only people sign. Model agent (agent for J. Rao) can't be a signer.");
    const yesToAnything: IdentityProviderDef = { ...test.provider, id: "lenient.idp", verify: async () => ({ status: "valid", signer: agent }) };
    const registry = new IdentityProviderRegistry([yesToAnything]);
    await expect(registry.verifyEnvelope({ ...env, provider: "lenient.idp" }, payload)).resolves.toMatchObject({ status: "invalid", reason: expect.stringMatching(/^Only people sign/) });
    await expect(registry.verifyEnvelope({ ...test.sign("jrao", payload), provider: "lenient.idp" }, payload)).resolves.toMatchObject({ status: "invalid", reason: expect.stringMatching(/belongs to Model agent/) });
  });
});
