import {
  authorFromActor,
  base64UrlDecode,
  createWebAuthnIdentityProvider,
  WEBAUTHN_ES256_ALG,
  type Actor,
  type AuthorClaims,
  type AuthorRef,
  type IdentityProviderDef,
} from "@permitzip/bim-kernel";
import { relyingPartyForRpId } from "../signing/relying-party-id";

/**
 * The host app's login as an identity provider for MutinyBIM. A person's
 * subject is their user id in the host; an agent's is the model server's
 * `agent:<userId>:<runId>` actor id, acting for that user.
 *
 * People sign with passkeys (round 9 lane S9): `verify` is the kernel's
 * open-source WebAuthn check against the key in the signer's key history.
 * Agents never sign (the kernel refuses an agent signer before this runs).
 *
 * The host names its provider (`HostIdentity`): the id written on new
 * records, its label, and any ids its records were stored under before,
 * which keep resolving and verifying forever.
 */
export const HOST_PROVIDER_ID = "host";
export const HOST_PASSKEY_ALG = WEBAUTHN_ES256_ALG;

/** How a host names its login system on records and in words. */
export interface HostIdentity {
  /** Written on new authors and envelopes. */
  readonly id: string;
  /** In words ("Acme login"). */
  readonly label: string;
  /** Ids the host's records were stored under before; read forever, never written. */
  readonly legacyIds?: readonly string[];
}

/** A host that names nothing of its own. */
export const DEFAULT_HOST_IDENTITY: HostIdentity = { id: HOST_PROVIDER_ID, label: "Host login" };

/** Every id the host's people may carry on stored records: the current one first. */
export function hostProviderIds(identity: Pick<HostIdentity, "id" | "legacyIds"> = DEFAULT_HOST_IDENTITY): readonly string[] {
  return [identity.id, ...(identity.legacyIds ?? [])];
}

/** What the provider needs from the host to name a person. Supplied by a caller that already read the user under the host's access rules. */
export interface HostPersonLookup {
  personById(userId: string): Promise<{ readonly id: string; readonly displayName: string; readonly email?: string } | null>;
}

/** An enrolled passkey as the signer's key history describes it (base64url SPKI, the site it was made for). */
export interface HostSigningKey {
  readonly subject: string;
  readonly publicKeySpki: string;
  readonly rpId: string;
  /** When the person retired it, or null. Retired keys are never deleted; past signatures stay valid. */
  readonly retiredAt: string | null;
}

/** Keys by credential id, from key histories the caller already read (and checked) under the host's access rules. */
export interface HostSigningKeyLookup {
  keyById(credentialId: string): Promise<HostSigningKey | null>;
}

/** A signed-in host user as a MutinyBIM author. */
export function hostAuthor(user: { readonly id: string; readonly displayName?: string }, providerId: string = HOST_PROVIDER_ID): AuthorRef {
  return { provider: providerId, subject: user.id, kind: "person", ...(user.displayName ? { displayName: user.displayName } : {}) };
}

/** A changeset actor (a person, or an agent acting for one) as a MutinyBIM author. */
export function hostAuthorFromActor(actor: Actor, providerId: string = HOST_PROVIDER_ID): AuthorRef {
  return authorFromActor(actor, providerId);
}

const NO_KEYS: HostSigningKeyLookup = { keyById: async () => null };

export function createHostIdentityProvider(lookup: HostPersonLookup, keys: HostSigningKeyLookup = NO_KEYS, identity: HostIdentity = DEFAULT_HOST_IDENTITY): IdentityProviderDef {
  async function resolveAuthor(subject: string): Promise<AuthorClaims | null> {
    const person = await lookup.personById(subject);
    if (!person) return null;
    return { author: hostAuthor(person, identity.id), ...(person.email ? { email: person.email } : {}), licences: [] };
  }
  const passkeys = (rpId: string) =>
    createWebAuthnIdentityProvider({
      id: identity.id,
      label: identity.label,
      version: "0.2.0",
      relyingParty: relyingPartyForRpId(rpId),
      resolveAuthor,
      resolveKey: async (keyId) => {
        const key = await keys.keyById(keyId);
        const spki = key ? base64UrlDecode(key.publicKeySpki) : null;
        return key && spki ? { subject: key.subject, publicKeySpki: spki, retiredAt: key.retiredAt } : null;
      },
    });
  return {
    id: identity.id,
    ...(identity.legacyIds?.length ? { legacyIds: identity.legacyIds } : {}),
    label: identity.label,
    version: "0.2.0",
    algorithms: [HOST_PASSKEY_ALG],
    resolveAuthor,
    async verify(env, payload) {
      const key = await keys.keyById(env.keyId);
      if (!key) return { status: "unverifiable", reason: "The passkey that made this signature isn't on record here." };
      // Each key checks against the site it was made for.
      return passkeys(key.rpId).verify(env, payload);
    },
  };
}
