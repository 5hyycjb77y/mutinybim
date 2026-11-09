/**
 * Authorship (round 8b lane A): who authored, proposed, approved, sealed,
 * answered or classified something, and the proof of it, for every party on
 * a project, whatever login system they use.
 *
 * The kernel holds the shapes, the identity provider point, the envelope
 * readers and writers and the canonical bytes. It names no provider: a host
 * (the host app's login, another firm's login, a certificate authority, a board's
 * credential wallet) registers one behind `IDENTITY_PROVIDER_POINT`.
 *
 * Stored value lists stay open: readers keep provider ids, algorithms,
 * author kinds, licence kinds and evidence kinds they don't know, and report
 * them as "can't check"; writers refuse anything malformed.
 */

/** "person" or "agent"; a newer peer's kind is kept as written and can never sign. */
export type AuthorKind = "person" | "agent" | (string & {});

/**
 * Who did something. The changeset `Actor` is this shape's compact wire form:
 * its id is the subject and its provider is the session's
 * (`authorFromActor`).
 */
export interface AuthorRef {
  /** The registered identity provider that knows this subject ("host", "unsigned", "acme.oidc"). */
  readonly provider: string;
  /** That provider's stable id for the author (a user id; an agent's actor id). */
  readonly subject: string;
  readonly kind: AuthorKind;
  /** What people read ("J. Rao"). Never used to decide anything. */
  readonly displayName?: string;
  /** The signing key the author used, when known. */
  readonly keyId?: string;
  /** Agents only, and always a person: who the agent acted for. */
  readonly onBehalfOf?: AuthorRef;
}

/** What the author did. Open: a host or add-on may record its own acts. */
export type AuthorshipRole =
  | "authored"
  | "proposed"
  | "approved"
  | "declined"
  | "accepted"
  | "sealed"
  | "answered"
  | "classified"
  | (string & {});

/** One act by one author, with its signature when a person signed it. */
export interface Attribution {
  readonly author: AuthorRef;
  readonly role: AuthorshipRole;
  /** ISO 8601 time of the act. */
  readonly at: string;
  readonly signature?: SignatureEnvelope;
}

/**
 * A signature over a payload's canonical bytes. Only people sign: an agent
 * acting for a person carries the agent and the person, and no signature.
 */
export interface SignatureEnvelope {
  /** Envelope format version. Writers write 1; readers keep a newer one and say so. */
  readonly v: number;
  /** "webauthn-es256", "es256", "x509-cms" (a certificate the signer brings), …; open. */
  readonly alg: string;
  /** The identity provider that can check it. */
  readonly provider: string;
  /** The provider's id for the key (a passkey credential id, a certificate fingerprint). */
  readonly keyId: string;
  /** The person who signed. */
  readonly signer: AuthorRef;
  /** `<digest>:<hex>` over the payload's canonical bytes; writers write `sha256:`. */
  readonly payloadDigest: string;
  /** Provider-defined, base64url. */
  readonly signature: string;
  /** Base64 DER certificates, leaf first, when the signer brought a certificate. */
  readonly certChain?: readonly string[];
  /** ISO 8601 time the signer's device signed. */
  readonly signedAt?: string;
  /** Fields a newer writer added, kept verbatim so a read and a write lose nothing. */
  readonly extensions?: Readonly<Record<string, unknown>>;
}

/**
 * How a licence claim is known. `issuer_credential`: the issuing board's own
 * credential, checked. `vouched`: an organization vouched for one of its own
 * people after checking the board's public lookup. `self_reported`: the
 * person said so. A newer kind reads as self-reported.
 */
export type LicenceEvidence = "issuer_credential" | "vouched" | "self_reported" | (string & {});

export interface LicenceVouch {
  readonly organization: { readonly id: string; readonly name: string };
  /** The person at that organization who checked it. */
  readonly voucher: AuthorRef;
  /** "own_staff": the organization vouches only for its own people. Open. */
  readonly relationship: "own_staff" | (string & {});
  readonly at: string;
}

export interface LicenceClaim {
  /** ISO 3166-2 style ("US-VA"). */
  readonly jurisdiction: string;
  /** "pe", "ra", "contractor", …; open. */
  readonly kind: string;
  readonly number: string;
  readonly discipline?: string;
  readonly validUntil?: string;
  /** The body that issues the licence (a state board), not whoever vouched for it. */
  readonly issuer: { readonly id: string; readonly name?: string };
  readonly evidence: LicenceEvidence;
  /** Present when `evidence` is `vouched`. */
  readonly vouchedBy?: LicenceVouch;
}

/** What a provider knows about a subject. */
export interface AuthorClaims {
  readonly author: AuthorRef;
  readonly email?: string;
  readonly organization?: { readonly id: string; readonly name: string };
  readonly licences: readonly LicenceClaim[];
}

/** A provider's answer about one signature. Only `valid` counts. */
export type VerifyOutcome =
  /** `note`: a fact the reader should see beside "valid" ("Signed with a key since removed."). */
  | { readonly status: "valid"; readonly signer: AuthorRef; readonly note?: string }
  | { readonly status: "invalid"; readonly reason: string }
  | { readonly status: "unverifiable"; readonly reason: string };

/**
 * An identity provider: the login system that knows its subjects and can
 * check their signatures. Registered on `IDENTITY_PROVIDER_POINT` by an
 * add-on, or handed to the registry by a host in its own process.
 */
export interface IdentityProviderDef {
  /** Stable id stored in every author and envelope it backs ("host", "acme.oidc"). */
  readonly id: string;
  /**
   * Ids this provider was stored under before (a host renamed its provider).
   * Authors and envelopes that carry one still resolve and verify here, forever.
   */
  readonly legacyIds?: readonly string[];
  /** In words ("Acme login"). */
  readonly label: string;
  /** The provider's own semver. */
  readonly version: string;
  /** Envelope algorithms it can check. */
  readonly algorithms: readonly string[];
  /** Claims for a subject, or null when it doesn't know them. */
  resolveAuthor(subject: string): Promise<AuthorClaims | null>;
  /**
   * Checks the signature over `payload` (the canonical bytes whose digest is
   * the envelope's). The registry has already checked the digest and that
   * the signer is a person.
   */
  verify(envelope: SignatureEnvelope, payload: Uint8Array): Promise<VerifyOutcome>;
}

/** A tolerant reader's result: the value with notes on what it kept but doesn't understand, or a refusal in words. */
export type AuthorshipRead<T> =
  | { readonly ok: true; readonly value: T; readonly notes: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** Thrown by strict writers, with the reason in words. */
export class AuthorshipWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorshipWriteError";
  }
}
