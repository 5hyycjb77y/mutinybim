import { base64UrlDecode, base64UrlEncode, COSE_ES256, hexToBytes } from "@permitzip/bim-kernel"
import type { AttachResponse, CodeCheckView, EnrolmentOptions, SignoffEntriesResponse, SigningKeyView, SigningKeysResponse, TotpConfirmView, TotpEnrolmentView } from "./api"
import { SIGNING_WORDS } from "./words"
import type { EditorDataAnswer, EditorDataHost } from "@permitzip/bim-editor-host"
import { EditorServiceUnavailableError } from "@permitzip/bim-editor/host/unavailable"

/**
 * Browser side of passkey signing: the host's `signing` port, and the two WebAuthn
 * ceremonies with the browser's own `navigator.credentials` (no library).
 * Every failure throws an Error with words a person can act on.
 */

type SigningPort = EditorDataHost["signing"]

function portOf(port: SigningPort): NonNullable<SigningPort> {
  if (!port) throw new EditorServiceUnavailableError("Signing and verifying sign-offs")
  return port
}

async function call<T>(port: SigningPort, send: (port: NonNullable<SigningPort>) => Promise<EditorDataAnswer>, what: string): Promise<T> {
  const ready = portOf(port)
  let res: EditorDataAnswer
  try {
    res = await send(ready)
  } catch (err) {
    console.error(`[bim/signing] ${what} unreachable`, err)
    throw new Error(`Couldn't reach the app to ${what}. Check your connection and try again.`)
  }
  const body: unknown = await res.json().catch((err: unknown) => {
    console.error(`[bim/signing] ${what} answered without JSON`, { status: res.status, err })
    return null
  })
  if (!res.ok) {
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : `Couldn't ${what} (error ${res.status}).`
    console.error(`[bim/signing] ${what} refused`, { status: res.status, message })
    throw new Error(message)
  }
  return body as T
}

/** The browser can make and use passkeys at all. */
export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && typeof navigator.credentials?.get === "function"
}

function bytes(b64: string): Uint8Array<ArrayBuffer> {
  const out = base64UrlDecode(b64)
  if (!out) throw new Error("The app sent something the browser can't read. Reload and try again.")
  return new Uint8Array(out)
}

function b64(buffer: ArrayBuffer): string {
  return base64UrlEncode(new Uint8Array(buffer))
}

/** Words for a browser's refusal: cancelled, timed out, or not allowed here. */
function ceremonyError(err: unknown, cancelled: string): Error {
  if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "AbortError")) return new Error(cancelled)
  if (err instanceof DOMException && err.name === "InvalidStateError") return new Error("This passkey is already added.")
  if (err instanceof DOMException && err.name === "SecurityError") return new Error("Passkeys work only on the app's own address. Reload the page and try again.")
  return new Error(err instanceof Error ? err.message : "The passkey didn't answer. Try again.")
}

export function fetchSigningKeysFrom(port: SigningPort, signal?: AbortSignal): Promise<SigningKeysResponse> {
  return call(port, (p) => p.keys({ signal }), "load your signing keys")
}

/** Settings › You › Signing › Add Touch ID: make a passkey on this device and add it to your key history. */
export async function addPasskeyFrom(port: SigningPort, label: string): Promise<SigningKeyView> {
  if (!passkeysSupported()) throw new Error(SIGNING_WORDS.noPasskeyBrowser)
  const options = await call<EnrolmentOptions>(port, (p) => p.beginPasskey(), "start adding a passkey")
  let credential: Credential | null
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        challenge: bytes(options.publicKey.challenge),
        rp: options.publicKey.rp,
        user: { id: bytes(options.publicKey.user.id), name: options.publicKey.user.name, displayName: options.publicKey.user.displayName },
        pubKeyCredParams: [{ type: "public-key", alg: COSE_ES256 }],
        authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
        attestation: "none",
        excludeCredentials: options.publicKey.excludeCredentialIds.map((id) => ({ type: "public-key", id: bytes(id) })),
        timeout: options.publicKey.timeoutMs,
      },
    })
  } catch (err) {
    console.error("[bim/signing] passkey creation refused by the browser", err)
    throw ceremonyError(err, "Adding Touch ID was cancelled. Nothing was added.")
  }
  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAttestationResponse)) throw new Error("The browser didn't make a passkey. Try again.")
  const response = credential.response
  const publicKey = response.getPublicKey()
  if (!publicKey) throw new Error("This passkey's key type can't sign here yet. Use Touch ID or a passkey on this device.")
  const enrolled = {
    challengeId: options.challengeId,
    credentialId: b64(credential.rawId),
    clientDataJSON: b64(response.clientDataJSON),
    authenticatorData: b64(response.getAuthenticatorData()),
    publicKey: b64(publicKey),
    publicKeyAlgorithm: response.getPublicKeyAlgorithm(),
    label,
  }
  return call<SigningKeyView>(port, (p) => p.addPasskey({ body: enrolled }), "add the passkey")
}

export function renamePasskeyFrom(port: SigningPort, id: string, label: string): Promise<SigningKeyView> {
  return call(port, (p) => p.renamePasskey({ id, label }), "rename the passkey")
}

export function removePasskeyFrom(port: SigningPort, id: string): Promise<SigningKeyView> {
  return call(port, (p) => p.removePasskey({ id }), "remove the passkey")
}

export function fetchSignoffEntriesFrom(port: SigningPort, projectId: string, subjectId: string, signal?: AbortSignal): Promise<SignoffEntriesResponse> {
  return call(port, (p) => p.entries({ projectId, subjectId }, { signal }), "load the sign-off entries")
}

// ---------------------------------------------------------------------------
// Authenticator app ("Verified")
// ---------------------------------------------------------------------------

/** A code answer that isn't a transport failure: refused in words (400 / 429) or accepted. */
async function codeCall<T extends { readonly ok: boolean }>(port: SigningPort, send: (port: NonNullable<SigningPort>) => Promise<EditorDataAnswer>, what: string): Promise<T> {
  const ready = portOf(port)
  let res: EditorDataAnswer
  try {
    res = await send(ready)
  } catch (err) {
    console.error(`[bim/signing] ${what} unreachable`, err)
    throw new Error(`Couldn't reach the app to ${what}. Check your connection and try again.`)
  }
  const body: unknown = await res.json().catch((err: unknown) => {
    console.error(`[bim/signing] ${what} answered without JSON`, { status: res.status, err })
    return null
  })
  if (typeof body === "object" && body !== null && "ok" in body && typeof body.ok === "boolean") return body as T
  const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : `Couldn't ${what} (error ${res.status}).`
  console.error(`[bim/signing] ${what} refused`, { status: res.status, message })
  throw new Error(message)
}

export function beginTotpEnrolmentFrom(port: SigningPort): Promise<TotpEnrolmentView> {
  return call(port, (p) => p.beginTotp(), "start adding the authenticator")
}

export function confirmTotpEnrolmentFrom(port: SigningPort, factorId: string, code: string): Promise<TotpConfirmView> {
  return codeCall(port, (p) => p.confirmTotp({ factorId, code }), "confirm the authenticator")
}

export function removeTotpFrom(port: SigningPort, code: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string; readonly locked: boolean }> {
  return codeCall(port, (p) => p.removeTotp({ code }), "remove the authenticator")
}

/** Check a code before recording (a wrong code records nothing). */
export function checkTotpCodeFrom(port: SigningPort, code: string): Promise<CodeCheckView> {
  return codeCall(port, (p) => p.checkTotp({ code }), "check the code")
}

/** How the person chose to back a decision: a passkey signature, or a checked one-time code. */
export type Assurance = { readonly method: "passkey"; readonly keys: readonly SigningKeyView[] } | { readonly method: "code"; readonly grantId: string }

export type SecureOutcome = { readonly level: "signed" | "verified"; readonly seq: number } | { readonly level: "recorded"; readonly words: string }

/**
 * After a decision is recorded: sign it with the passkey, or attach
 * "Verified" with the checked code. Anything that fails leaves the decision
 * recorded, and says so.
 */
export async function secureLatestEntryFrom(port: SigningPort, projectId: string, subjectId: string, assurance: Assurance): Promise<SecureOutcome> {
  if (assurance.method === "passkey") {
    const out = await signLatestEntry(port, projectId, subjectId, assurance.keys)
    return out.signed ? { level: "signed", seq: out.seq } : { level: "recorded", words: out.words }
  }
  try {
    const { entries } = await fetchSignoffEntriesFrom(port, projectId, subjectId)
    const entry = [...entries].reverse().find((e) => e.signableByViewer)
    if (!entry) return { level: "recorded", words: "Recorded, not verified: there was no new entry of yours to verify." }
    const out = await call<AttachResponse>(port, (p) => p.attachVerification({ projectId, entryId: entry.id, grantId: assurance.grantId }), "attach the verification")
    return { level: "verified", seq: out.seq }
  } catch (err) {
    console.error("[bim/signing] verifying after the decision failed; the decision stays recorded", { projectId, subjectId, err })
    return { level: "recorded", words: `Recorded, not verified: ${err instanceof Error ? err.message : "the verification couldn't be attached."}` }
  }
}

/** Words for what happened, after the decision's own words. */
export function secureOutcomeWords(out: SecureOutcome): string {
  if (out.level === "recorded") return out.words
  return out.level === "signed" ? `Signed with Touch ID (entry ${out.seq}).` : `Verified with a one-time code (entry ${out.seq}; not a digital signature).`
}

type SignOutcome = { readonly signed: true; readonly seq: number } | { readonly signed: false; readonly words: string }

/**
 * After a decision is recorded: find the viewer's newest unsigned entry about
 * `subjectId`, have their passkey sign its hash (Touch ID), and attach it. A
 * cancelled prompt or a refusal leaves the decision recorded, not signed.
 */
async function signLatestEntry(port: SigningPort, projectId: string, subjectId: string, keys: readonly SigningKeyView[]): Promise<SignOutcome> {
  try {
    const { entries } = await fetchSignoffEntriesFrom(port, projectId, subjectId)
    const entry = [...entries].reverse().find((e) => e.signableByViewer)
    if (!entry) return { signed: false, words: "Recorded, not signed: there was no new entry of yours to sign." }
    const challenge = hexToBytes(entry.recordHash)
    if (!challenge) return { signed: false, words: "Recorded, not signed: the entry can't be read." }
    let credential: Credential | null
    try {
      credential = await navigator.credentials.get({
        publicKey: {
          challenge: new Uint8Array(challenge),
          rpId: window.location.hostname,
          allowCredentials: keys.filter((k) => k.usableHere).map((k) => ({ type: "public-key", id: bytes(k.credentialId) })),
          userVerification: "required",
          timeout: 2 * 60 * 1000,
        },
      })
    } catch (err) {
      console.error("[bim/signing] passkey signature refused by the browser", err)
      return { signed: false, words: ceremonyError(err, SIGNING_WORDS.cancelled).message }
    }
    if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAssertionResponse)) return { signed: false, words: SIGNING_WORDS.cancelled }
    const response = credential.response
    const signature = {
      credentialId: b64(credential.rawId),
      clientDataJSON: b64(response.clientDataJSON),
      authenticatorData: b64(response.authenticatorData),
      signature: b64(response.signature),
    }
    const out = await call<AttachResponse>(port, (p) => p.attachSignature({ projectId, entryId: entry.id, body: signature }), "attach your signature")
    return { signed: true, seq: out.seq }
  } catch (err) {
    console.error("[bim/signing] signing after the decision failed; the decision stays recorded", { projectId, subjectId, err })
    return { signed: false, words: `Recorded, not signed: ${err instanceof Error ? err.message : "the signature couldn't be attached."}` }
  }
}
