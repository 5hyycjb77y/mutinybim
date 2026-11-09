import { payloadDigest, sha256HexOf } from "./canonical";
import type { AuthorClaims, AuthorRef, IdentityProviderDef, LicenceClaim, SignatureEnvelope } from "./types";

/**
 * A deterministic identity provider for tests and add-on conformance. NOT a
 * signature scheme: its "signature" is a hash with a shared test secret, so
 * anyone holding the secret can forge it. Never register it in a product.
 */
export interface TestPerson {
  readonly subject: string;
  readonly displayName: string;
  readonly keyId: string;
  readonly secret: string;
  readonly licences?: readonly LicenceClaim[];
}

export const TEST_SIGNATURE_ALG = "test-sha256";

export interface TestIdentityProvider {
  readonly provider: IdentityProviderDef;
  /** An envelope by `subject` over `payload`. */
  sign(subject: string, payload: Uint8Array, signedAt?: string): SignatureEnvelope;
}

function mark(secret: string, keyId: string, digest: string): string {
  return sha256HexOf(`${secret}\n${keyId}\n${digest}`);
}

export function createTestIdentityProvider(people: readonly TestPerson[], id = "test.identity"): TestIdentityProvider {
  const bySubject = new Map(people.map((p) => [p.subject, p]));
  const byKey = new Map(people.map((p) => [p.keyId, p]));
  const ref = (p: TestPerson): AuthorRef => ({ provider: id, subject: p.subject, kind: "person", displayName: p.displayName, keyId: p.keyId });
  const provider: IdentityProviderDef = {
    id,
    label: "Test identity provider",
    version: "1.0.0",
    algorithms: [TEST_SIGNATURE_ALG],
    resolveAuthor: async (subject): Promise<AuthorClaims | null> => {
      const p = bySubject.get(subject);
      return p ? { author: ref(p), licences: p.licences ?? [] } : null;
    },
    verify: async (env) => {
      const p = byKey.get(env.keyId);
      if (!p) return { status: "invalid", reason: "This key isn't one the test provider issued." };
      if (env.signature !== mark(p.secret, p.keyId, env.payloadDigest)) return { status: "invalid", reason: "The signature doesn't match the key." };
      return { status: "valid", signer: ref(p) };
    },
  };
  return {
    provider,
    sign(subject, payload, signedAt) {
      const p = bySubject.get(subject);
      if (!p) throw new Error(`The test provider has no person "${subject}"`);
      const digest = payloadDigest(payload);
      return { v: 1, alg: TEST_SIGNATURE_ALG, provider: id, keyId: p.keyId, signer: ref(p), payloadDigest: digest, signature: mark(p.secret, p.keyId, digest), ...(signedAt ? { signedAt } : {}) };
    },
  };
}
