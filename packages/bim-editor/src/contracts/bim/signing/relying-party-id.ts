import { originMatchesRpId, type WebAuthnRelyingParty } from "@permitzip/bim-kernel"

/** The relying party for a key whose id is known (a stored key's `rp_id`). Pure: the browser checks signatures with it too. */
export function relyingPartyForRpId(rpId: string): WebAuthnRelyingParty {
  return { rpId, origins: (origin) => originMatchesRpId(origin, rpId) }
}
