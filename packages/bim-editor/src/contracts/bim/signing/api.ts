import type { BimJson } from "../json"

/** What the signing routes answer, shared by routes and screens. */

export interface SigningKeyView {
  readonly id: string
  readonly credentialId: string
  readonly label: string
  readonly createdAt: string
  readonly retiredAt: string | null
  /** This key was made for the site the page is on, so it can sign here. */
  readonly usableHere: boolean
}

/** The person's authenticator app (one-time codes, "Verified"). */
export interface TotpStatusView {
  readonly state: "none" | "active" | "locked"
  readonly addedAt: string | null
  readonly lastUsedAt: string | null
  readonly lockedUntil: string | null
}

export interface SigningKeysResponse {
  readonly keys: readonly SigningKeyView[]
  /** The site passkeys are made for on this page ("app.example.com"). */
  readonly rpId: string
  readonly totp: TotpStatusView
  /** How long after recording an entry it can be signed or verified (one place: `bim_signoff_attach_window_minutes`). */
  readonly attachWindowMinutes: number
}

export interface TotpEnrolmentView {
  readonly factorId: string
  /** `otpauth://` URI for the QR code. */
  readonly otpauthUri: string
  /** Base32 key, grouped, for typing in by hand. */
  readonly manualKey: string
}

/** A code check: refused in words (and counted), or a 2-minute single-use grant. */
export type CodeCheckView = { readonly ok: true; readonly grantId: string } | { readonly ok: false; readonly reason: string; readonly locked: boolean }

export type TotpConfirmView = { readonly ok: true; readonly recoveryCodes: readonly string[] } | { readonly ok: false; readonly reason: string; readonly locked: boolean }

export interface EnrolmentOptions {
  readonly challengeId: string
  readonly expiresAt: string
  /** `PublicKeyCredentialCreationOptions`, JSON-safe (base64url for bytes). */
  readonly publicKey: {
    readonly challenge: string
    readonly rp: { readonly id: string; readonly name: string }
    readonly user: { readonly id: string; readonly name: string; readonly displayName: string }
    readonly excludeCredentialIds: readonly string[]
    readonly timeoutMs: number
  }
}

/** One key-history entry, as the kernel's `KeyLogEvent` reads it. */
export interface KeyLogEventView {
  readonly seq: number
  readonly subject: string
  readonly eventKind: string
  readonly keyId: string
  readonly payload: BimJson
  readonly prevHash: string
  readonly eventHash: string
  readonly createdAt: string
}

/** One sign-off entry with what a browser needs to re-check its signature. */
export interface SignoffEntryView {
  readonly id: string
  readonly seq: number
  readonly projectId: string
  readonly baseModelId: string
  readonly recordKind: string
  readonly subjectId: string
  readonly actorUserId: string
  readonly payload: BimJson
  readonly prevHash: string
  readonly recordHash: string
  readonly createdAt: string
  readonly signatureEnvelope: BimJson | null
  /** "Verified" with a one-time code (not a digital signature), or null. */
  readonly verifiedAt: string | null
  readonly verification: BimJson | null
  /** The viewer recorded it, it isn't signed or verified, and it is recent enough to be. */
  readonly signableByViewer: boolean
}

export interface SignoffEntriesResponse {
  readonly entries: readonly SignoffEntryView[]
  readonly attachWindowMinutes: number
  /** Each signer's key history (only for people who signed one of these entries). */
  readonly keyLogs: readonly { readonly subject: string; readonly events: readonly KeyLogEventView[] }[]
}

export interface AttachResponse {
  readonly id: string
  readonly seq: number
  /** The passkey that signed it; null for "Verified". */
  readonly signerKeyId: string | null
}
