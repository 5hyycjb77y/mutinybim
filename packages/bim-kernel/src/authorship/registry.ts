import { defineExtensionPoint } from "../packs/contract";
import type { PackSet } from "../packs/set";
import { PROVIDER_ID, authorWords, sameAuthor } from "./author";
import { parseDigest, payloadDigest } from "./canonical";
import type { AuthorClaims, AuthorRef, IdentityProviderDef, SignatureEnvelope, VerifyOutcome } from "./types";
import { UNSIGNED_PROVIDER } from "./unsigned";

/**
 * Identity providers (contract 1.6.0): another firm's login, a certificate
 * authority, a board's credential wallet. An add-on's provider ids carry its
 * namespace ("acme.oidc"); a host hands its own to the registry
 * in its process. The built-in `unsigned` provider is always there.
 */
export const IDENTITY_PROVIDER_POINT = defineExtensionPoint<IdentityProviderDef>({
  id: "kernel.identity_provider",
  version: 1,
  label: "Identity providers",
  idOf: (p) => p.id,
  builtins: () => [UNSIGNED_PROVIDER],
});

export class IdentityProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityProviderError";
  }
}

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function check(def: IdentityProviderDef): void {
  if (!PROVIDER_ID.test(def.id) || def.id.length > 64) throw new IdentityProviderError(`"${def.id}" isn't a provider id (lower case letters, digits, and . : - between parts).`);
  if (def.label.trim() === "") throw new IdentityProviderError(`Identity provider ${def.id} has no label.`);
  if (!SEMVER.test(def.version)) throw new IdentityProviderError(`Identity provider ${def.id}: version "${def.version}" isn't semver.`);
  if (def.algorithms.length === 0 || def.algorithms.some((a) => a.trim() === "")) throw new IdentityProviderError(`Identity provider ${def.id} names no signature algorithm.`);
  if (typeof def.resolveAuthor !== "function" || typeof def.verify !== "function") throw new IdentityProviderError(`Identity provider ${def.id} must give resolveAuthor and verify.`);
  for (const legacy of def.legacyIds ?? []) {
    if (!PROVIDER_ID.test(legacy) || legacy.length > 64) throw new IdentityProviderError(`Identity provider ${def.id}: earlier id "${legacy}" isn't a provider id.`);
  }
}

/** The providers one process can use, by id (or an earlier id). Registration refuses a malformed or duplicate provider. */
export class IdentityProviderRegistry {
  private readonly byId = new Map<string, IdentityProviderDef>();
  private readonly primary: string[] = [];

  constructor(providers: readonly IdentityProviderDef[] = []) {
    this.register(UNSIGNED_PROVIDER);
    for (const p of providers) if (p !== UNSIGNED_PROVIDER) this.register(p);
  }

  register(def: IdentityProviderDef): void {
    check(def);
    for (const id of [def.id, ...(def.legacyIds ?? [])]) {
      if (this.byId.has(id)) throw new IdentityProviderError(`Identity provider "${id}" is already registered; a provider can't be replaced.`);
    }
    this.byId.set(def.id, def);
    for (const legacy of def.legacyIds ?? []) this.byId.set(legacy, def);
    this.primary.push(def.id);
  }

  get(id: string): IdentityProviderDef | undefined {
    return this.byId.get(id);
  }

  ids(): readonly string[] {
    return [...this.primary];
  }

  /** What the author's provider knows about them, or null (unknown provider, unknown subject, or the provider failed, which is logged). */
  async resolveAuthor(author: AuthorRef): Promise<AuthorClaims | null> {
    const provider = this.byId.get(author.provider);
    if (!provider) return null;
    try {
      return await provider.resolveAuthor(author.subject);
    } catch (err) {
      console.error("[authorship] identity provider failed to resolve an author", { provider: author.provider, err });
      return null;
    }
  }

  /**
   * Checks one signature over `payload` (the canonical bytes). In order: the
   * signer is a person; the digest matches the bytes; the provider and the
   * algorithm are known here; the provider says yes; and the provider's
   * signer is the envelope's. Anything this process can't check is
   * `unverifiable`, never `valid`.
   */
  async verifyEnvelope(env: SignatureEnvelope, payload: Uint8Array): Promise<VerifyOutcome> {
    if (env.signer.kind !== "person") return { status: "invalid", reason: `Only people sign. This signature names ${authorWords(env.signer)}.` };
    const digest = parseDigest(env.payloadDigest);
    if (!digest) return { status: "invalid", reason: "This signature doesn't say what it signed." };
    if (digest.alg !== "sha256") return { status: "unverifiable", reason: `This signature names its content with ${digest.alg}, which this app can't check.` };
    if (payloadDigest(payload) !== env.payloadDigest) return { status: "invalid", reason: "What was signed has changed since it was signed." };
    const provider = this.byId.get(env.provider);
    if (!provider) return { status: "unverifiable", reason: `This was signed through "${env.provider}", which this app can't check.` };
    if (!provider.algorithms.includes(env.alg)) return { status: "unverifiable", reason: `${provider.label} can't check "${env.alg}" signatures.` };
    let outcome: VerifyOutcome;
    try {
      outcome = await provider.verify(env, payload);
    } catch (err) {
      console.error("[authorship] identity provider failed while checking a signature", { provider: env.provider, alg: env.alg, err });
      return { status: "unverifiable", reason: `${provider.label} couldn't check this signature right now. Try again.` };
    }
    if (outcome.status !== "valid") return outcome;
    if (outcome.signer.kind !== "person" || !sameAuthor(outcome.signer, env.signer)) {
      return { status: "invalid", reason: `The key belongs to ${authorWords(outcome.signer)}, not ${authorWords(env.signer)}.` };
    }
    return outcome;
  }
}

/** A registry with a model's pack set's providers (built-ins included), then the host's own. */
export function identityRegistryFor(set: PackSet, host: readonly IdentityProviderDef[] = []): IdentityProviderRegistry {
  return new IdentityProviderRegistry([...set.items(IDENTITY_PROVIDER_POINT), ...host]);
}
