import assert from "node:assert/strict";
import type { PgNativeSessionStore } from "../src/native-session-store";

/** Input stands in for a provider response that the browser callback has already verified. */
const provider = { issuer: "https://drill.invalid", clientId: "native-drill", redirectUri: "https://drill.invalid/callback" };

export async function signIn(store: PgNativeSessionStore, subject: string) {
  const start = await store.startSignIn(provider);
  const claim = await store.claimSignIn(start);
  assert.equal(claim.status, "claimed");
  const result = await store.completeSignIn({
    transactionId: claim.transactionId, claimToken: claim.claimToken,
    identity: { issuer: provider.issuer, subject, displayName: subject },
  });
  assert.equal(result.status, "issued");
  return result;
}
