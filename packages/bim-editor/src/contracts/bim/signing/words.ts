/**
 * Words for the three assurance levels on screens (round 9 lane S9, the product owner's
 * answer 5):
 *   Signed    a passkey / Touch ID signature anyone can check;
 *   Verified  a one-time code from the person's authenticator app, recorded
 *             by the host app: always "not a digital signature";
 *   Recorded  the plain button.
 * The decision words stay "approved", "accepted" and "recorded" (a
 * professional stamp is a later round).
 */
export const ASSURANCE_LABELS = { signed: "Signed", verified: "Verified", recorded: "Recorded" } as const

export const SIGNING_WORDS = {
  button: "Sign with Touch ID",
  verifyButton: "Verify with a code",
  recorded: "Recorded · not signed or verified",
  doesntCheck: "Signature doesn’t check",
  notASignature: "not a digital signature",
  noPasskeyBrowser: "Your browser has no passkey. Use the plain button; it is recorded, not signed.",
  noFactor: "Add Touch ID or an authenticator app in Settings › You › Signing (Touch ID) to sign or verify. The plain button records your decision.",
  checking: "Checking for your passkey or authenticator…",
  cancelled: "Touch ID was cancelled. Your decision is recorded, not signed.",
  emptyKeys: "No signing keys yet",
  retireWarning: "This passkey is retired: it stops signing anything new. It is never deleted, so what it already signed stays valid and reads “signed with a key retired on” today’s date.",
  codeHelp: "Enter the 6 digits your authenticator app shows. Verified is recorded by this app; it is not a digital signature.",
} as const

/** "Nov 2, 2026" for an ISO time; the same on every machine (UTC). */
export function dayWords(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "an earlier date" : d.toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" })
}

/** "You can sign within 10 minutes of recording." */
export function windowWords(minutes: number, verb: "sign" | "verify"): string {
  return `You can ${verb} within ${minutes} minutes of recording.`
}

export function signedByWords(name: string, keyRetiredAt: string | null): string {
  return keyRetiredAt ? `Signed by ${name} · signed with a key retired on ${dayWords(keyRetiredAt)}` : `Signed by ${name}`
}

/** "Verified by J. Rao with a one-time code · not a digital signature" (and the password when the session used one). */
export function verifiedByWords(name: string, withPassword: boolean): string {
  return `Verified by ${name} with ${withPassword ? "their password and " : ""}a one-time code · ${SIGNING_WORDS.notASignature}`
}
