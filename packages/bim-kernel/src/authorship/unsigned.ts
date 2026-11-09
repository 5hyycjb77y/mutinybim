import type { IdentityProviderDef } from "./types";

/** The built-in provider for acts recorded with no digital signature (a click, a password re-entry). */
export const UNSIGNED_PROVIDER_ID = "unsigned";

/**
 * Knows no one and checks nothing: an act under it was recorded, not signed,
 * and is never shown as signed.
 */
export const UNSIGNED_PROVIDER: IdentityProviderDef = Object.freeze({
  id: UNSIGNED_PROVIDER_ID,
  label: "Not signed",
  version: "1.0.0",
  algorithms: Object.freeze(["none"]),
  resolveAuthor: async () => null,
  verify: async () => ({ status: "unverifiable" as const, reason: "This was recorded without a digital signature." }),
});
