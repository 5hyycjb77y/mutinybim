import { authorWords } from "./author";
import { sha256, utf8Bytes } from "./canonical";
import type { AuthorClaims, AuthorRef, IdentityProviderDef, SignatureEnvelope, VerifyOutcome } from "./types";

/**
 * Passkey (WebAuthn) signatures, checked with the platform's own WebCrypto:
 * ECDSA P-256 over `authenticatorData ‖ SHA-256(clientDataJSON)` (WebAuthn
 * Level 2 §7.2, COSE alg -7). The same code runs in a browser, in Node and in
 * anyone's verifier; no library, no network.
 *
 * What is signed: the WebAuthn challenge is the SHA-256 of the payload's
 * bytes (for a sign-off record, its `record_hash`), so the server holds no
 * challenge secret and an outsider can check the signature from the record
 * alone.
 *
 * Enrolment uses `attestation: "none"`: the key is the person's because they
 * enrolled it into their own account, not because a vendor vouches for the
 * device.
 */

export const WEBAUTHN_ES256_ALG = "webauthn-es256";
/** COSE algorithm id of ES256 (`PublicKeyCredential.getPublicKeyAlgorithm()`). */
export const COSE_ES256 = -7;

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_DATA = 0x40;
const PACK_VERSION = 1;

export type WebAuthnCheck = { readonly ok: true; readonly signCount: number; readonly userVerified: boolean } | { readonly ok: false; readonly reason: string };

/** One `navigator.credentials.get()` answer, as bytes. */
export interface WebAuthnAssertion {
  /** The credential id (base64url), which is the envelope's `keyId`. */
  readonly credentialId: string;
  readonly authenticatorData: Uint8Array;
  readonly clientDataJSON: Uint8Array;
  /** DER-encoded ECDSA signature, as the authenticator returns it. */
  readonly signature: Uint8Array;
}

/** Who the signature must have been made for. */
export interface WebAuthnRelyingParty {
  /** The relying-party id the key is bound to (a host name, "app.example.com"). */
  readonly rpId: string;
  /** Page origins allowed to ask for it ("https://app.example.com"), or a rule (`originMatchesRpId`). */
  readonly origins: readonly string[] | ((origin: string) => boolean);
}

/**
 * Whether a page origin may use keys of a relying-party id (WebAuthn §5.1.3):
 * the origin's host is the id or a subdomain of it, over https; plain http
 * only on `localhost` and `*.localhost` (a developer's machine).
 */
export function originMatchesRpId(origin: string, rpId: string): boolean {
  if (!URL.canParse(origin)) return false;
  const url = new URL(origin);
  if (url.origin !== origin) return false;
  const host = url.hostname;
  if (host !== rpId && !host.endsWith(`.${rpId}`)) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (host === "localhost" || host.endsWith(".localhost"));
}

export interface WebAuthnExpectation extends WebAuthnRelyingParty {
  readonly challenge: Uint8Array;
  /** Touch ID / Face ID / PIN, not just a tap. Defaults to true. */
  readonly requireUserVerification?: boolean;
}

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_INDEX = new Map([...B64URL].map((c, i) => [c, i]));

/** Base64url text (no padding) of bytes. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64URL[a >> 2];
    out += B64URL[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) out += B64URL[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) out += B64URL[c & 63];
  }
  return out;
}

/** Bytes of base64url (or base64) text, or null when it isn't any. Padding is optional. */
export function base64UrlDecode(text: string): Uint8Array | null {
  const clean = text.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  if (clean.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let j = 0;
  for (const ch of clean) {
    const v = B64URL_INDEX.get(ch);
    if (v === undefined) return null;
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (value >> bits) & 0xff;
    }
  }
  return out.slice(0, j);
}

/** Bytes of lowercase or uppercase hex, or null. */
export function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function subtle(): SubtleCrypto | null {
  const c: Crypto | undefined = globalThis.crypto;
  return c?.subtle ?? null;
}

/**
 * An ECDSA P-256 DER signature (SEQUENCE { INTEGER r, INTEGER s }) as the
 * 64-byte r ‖ s form WebCrypto verifies, or null when it isn't strict DER.
 */
export function derToP1363(der: Uint8Array): Uint8Array | null {
  if (der.length < 8 || der.length > 72 || der[0] !== 0x30 || der[1] !== der.length - 2) return null;
  const out = new Uint8Array(64);
  let at = 2;
  for (let part = 0; part < 2; part++) {
    if (der[at] !== 0x02) return null;
    const len = der[at + 1] ?? 0;
    if (len < 1 || len > 33 || at + 2 + len > der.length) return null;
    let int = der.subarray(at + 2, at + 2 + len);
    if ((int[0] ?? 0) & 0x80) return null;
    if (int.length > 1 && int[0] === 0 && !((int[1] ?? 0) & 0x80)) return null;
    if (int.length === 33) int = int.subarray(1);
    out.set(int, part * 32 + (32 - int.length));
    at += 2 + len;
  }
  return at === der.length ? out : null;
}

// ---------------------------------------------------------------------------
// Client data and authenticator data
// ---------------------------------------------------------------------------

interface ClientData {
  readonly type: string;
  readonly challenge: Uint8Array;
  readonly origin: string;
  readonly crossOrigin: boolean;
}

function readClientData(bytes: Uint8Array): ClientData | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (err) {
    console.error("[authorship/webauthn] client data isn't JSON", { err });
    return "The browser's answer can't be read.";
  }
  if (typeof parsed !== "object" || parsed === null) return "The browser's answer can't be read.";
  const type = "type" in parsed ? parsed.type : undefined;
  const challenge = "challenge" in parsed ? parsed.challenge : undefined;
  const origin = "origin" in parsed ? parsed.origin : undefined;
  const crossOrigin = "crossOrigin" in parsed ? parsed.crossOrigin : undefined;
  if (typeof type !== "string" || typeof challenge !== "string" || typeof origin !== "string") return "The browser's answer is missing what was asked.";
  const decoded = base64UrlDecode(challenge);
  if (!decoded) return "The browser's answer names what was asked in a form this app can't read.";
  return { type, challenge: decoded, origin, crossOrigin: crossOrigin === true };
}

function checkClientData(bytes: Uint8Array, type: "webauthn.get" | "webauthn.create", expected: WebAuthnExpectation): string | null {
  const data = readClientData(bytes);
  if (typeof data === "string") return data;
  if (data.type !== type) return type === "webauthn.get" ? "This is a passkey enrolment, not a signature." : "This is a signature, not a passkey enrolment.";
  if (!equalBytes(data.challenge, expected.challenge)) return "The passkey signed something else.";
  if (data.crossOrigin) return "The passkey was used from inside another site's page.";
  const allowed = typeof expected.origins === "function" ? expected.origins(data.origin) : expected.origins.includes(data.origin);
  if (!allowed) return `The passkey was used on ${data.origin}, not on this app.`;
  return null;
}

function checkAuthenticatorData(bytes: Uint8Array, expected: WebAuthnExpectation): { readonly flags: number; readonly signCount: number } | string {
  if (bytes.length < 37) return "The passkey's answer is too short to be one.";
  if (!equalBytes(bytes.subarray(0, 32), sha256(utf8Bytes(expected.rpId)))) return `The passkey belongs to another site, not ${expected.rpId}.`;
  const flags = bytes[32] ?? 0;
  if (!(flags & FLAG_USER_PRESENT)) return "The passkey answered without anyone touching it.";
  if ((expected.requireUserVerification ?? true) && !(flags & FLAG_USER_VERIFIED)) return "The passkey didn't check it was you (Touch ID, Face ID or the device PIN).";
  const signCount = new DataView(buffer(bytes.subarray(33, 37))).getUint32(0);
  return { flags, signCount };
}

// ---------------------------------------------------------------------------
// Verify one assertion
// ---------------------------------------------------------------------------

/**
 * Checks one passkey signature: the challenge, origin and relying party, that
 * the person was present and verified, and the ECDSA signature against the
 * enrolled public key (SPKI DER). Never throws; a refusal says why in words.
 */
export async function verifyWebAuthnEs256(assertion: WebAuthnAssertion, publicKeySpki: Uint8Array, expected: WebAuthnExpectation): Promise<WebAuthnCheck> {
  const client = checkClientData(assertion.clientDataJSON, "webauthn.get", expected);
  if (client) return { ok: false, reason: client };
  const auth = checkAuthenticatorData(assertion.authenticatorData, expected);
  if (typeof auth === "string") return { ok: false, reason: auth };
  const raw = derToP1363(assertion.signature);
  if (!raw) return { ok: false, reason: "The signature isn't in the form a passkey makes." };
  const s = subtle();
  if (!s) return { ok: false, reason: "This browser can't check signatures (no Web Crypto)." };
  let key: CryptoKey;
  try {
    key = await s.importKey("spki", buffer(publicKeySpki), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch (err) {
    console.error("[authorship/webauthn] public key import failed", { err });
    return { ok: false, reason: "The enrolled key can't be read as a passkey key." };
  }
  const signed = new Uint8Array(assertion.authenticatorData.length + 32);
  signed.set(assertion.authenticatorData);
  signed.set(sha256(assertion.clientDataJSON), assertion.authenticatorData.length);
  let good: boolean;
  try {
    good = await s.verify({ name: "ECDSA", hash: "SHA-256" }, key, buffer(raw), buffer(signed));
  } catch (err) {
    console.error("[authorship/webauthn] signature check failed to run", { err });
    return { ok: false, reason: "The signature couldn't be checked right now. Try again." };
  }
  if (!good) return { ok: false, reason: "The signature doesn't match the key." };
  return { ok: true, signCount: auth.signCount, userVerified: (auth.flags & FLAG_USER_VERIFIED) !== 0 };
}

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

/** One `navigator.credentials.create()` answer, read with the browser's own getters (no attestation object). */
export interface WebAuthnRegistration {
  readonly credentialId: string;
  readonly clientDataJSON: Uint8Array;
  /** `response.getAuthenticatorData()`. */
  readonly authenticatorData: Uint8Array;
  /** `response.getPublicKey()`: SPKI DER. */
  readonly publicKeySpki: Uint8Array;
  /** `response.getPublicKeyAlgorithm()`. */
  readonly publicKeyAlgorithm: number;
}

/** The uncompressed point of a P-256 SPKI (its last 65 bytes, 0x04 ‖ x ‖ y), or null. */
function spkiPoint(spki: Uint8Array): { readonly x: Uint8Array; readonly y: Uint8Array } | null {
  if (spki.length !== 91 || spki[spki.length - 65] !== 0x04) return null;
  const point = spki.subarray(spki.length - 64);
  return { x: point.subarray(0, 32), y: point.subarray(32) };
}

/**
 * Checks a new passkey before it is stored: the enrolment challenge, origin
 * and relying party; that the person was present and verified; that the
 * authenticator's own data names this credential id; that the key is ES256
 * and imports; and that the key the browser handed over (SPKI) is the one in
 * the authenticator data (its COSE x and y, `-2: bstr(32)`, `-3: bstr(32)`).
 */
export async function checkWebAuthnRegistration(reg: WebAuthnRegistration, expected: WebAuthnExpectation): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  if (reg.publicKeyAlgorithm !== COSE_ES256) return { ok: false, reason: "This passkey uses a key type this app can't check yet. Use Touch ID or a passkey on this device." };
  const client = checkClientData(reg.clientDataJSON, "webauthn.create", expected);
  if (client) return { ok: false, reason: client };
  const auth = checkAuthenticatorData(reg.authenticatorData, expected);
  if (typeof auth === "string") return { ok: false, reason: auth };
  if (!(auth.flags & FLAG_ATTESTED_DATA) || reg.authenticatorData.length < 55) return { ok: false, reason: "The passkey didn't say which key it made." };
  const idLen = ((reg.authenticatorData[53] ?? 0) << 8) | (reg.authenticatorData[54] ?? 0);
  const credId = reg.authenticatorData.subarray(55, 55 + idLen);
  const claimed = base64UrlDecode(reg.credentialId);
  if (!claimed || credId.length !== idLen || !equalBytes(credId, claimed)) return { ok: false, reason: "The passkey's id doesn't match what the browser reported." };
  const point = spkiPoint(reg.publicKeySpki);
  if (!point) return { ok: false, reason: "The passkey's key isn't a P-256 key." };
  const coseFrom = 55 + idLen;
  const xAt = indexOfBytes(reg.authenticatorData, new Uint8Array([0x21, 0x58, 0x20, ...point.x]), coseFrom);
  const yAt = indexOfBytes(reg.authenticatorData, new Uint8Array([0x22, 0x58, 0x20, ...point.y]), coseFrom);
  if (xAt < 0 || yAt < 0) return { ok: false, reason: "The key the browser handed over isn't the one the passkey made." };
  const s = subtle();
  if (!s) return { ok: false, reason: "This browser can't check passkeys (no Web Crypto)." };
  try {
    await s.importKey("spki", buffer(reg.publicKeySpki), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch (err) {
    console.error("[authorship/webauthn] enrolled key import failed", { err });
    return { ok: false, reason: "The passkey's key can't be read." };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The envelope's signature value
// ---------------------------------------------------------------------------

/**
 * A `webauthn-es256` envelope's `signature`: base64url of
 * `0x01 ‖ u16(len authenticatorData) ‖ authenticatorData ‖ u16(len clientDataJSON) ‖ clientDataJSON ‖ DER signature`.
 * Everything a verifier needs besides the public key and the payload.
 */
export function packWebAuthnSignature(a: Pick<WebAuthnAssertion, "authenticatorData" | "clientDataJSON" | "signature">): string {
  if (a.authenticatorData.length > 0xffff || a.clientDataJSON.length > 0xffff) throw new Error("A passkey answer can't be over 64 KB.");
  const out = new Uint8Array(1 + 2 + a.authenticatorData.length + 2 + a.clientDataJSON.length + a.signature.length);
  let at = 0;
  out[at++] = PACK_VERSION;
  out[at++] = a.authenticatorData.length >> 8;
  out[at++] = a.authenticatorData.length & 0xff;
  out.set(a.authenticatorData, at);
  at += a.authenticatorData.length;
  out[at++] = a.clientDataJSON.length >> 8;
  out[at++] = a.clientDataJSON.length & 0xff;
  out.set(a.clientDataJSON, at);
  at += a.clientDataJSON.length;
  out.set(a.signature, at);
  return base64UrlEncode(out);
}

export function unpackWebAuthnSignature(value: string, credentialId: string): WebAuthnAssertion | null {
  const bytes = base64UrlDecode(value);
  if (!bytes || bytes.length < 5 || bytes[0] !== PACK_VERSION) return null;
  const authLen = ((bytes[1] ?? 0) << 8) | (bytes[2] ?? 0);
  const clientAt = 3 + authLen;
  if (clientAt + 2 > bytes.length) return null;
  const clientLen = ((bytes[clientAt] ?? 0) << 8) | (bytes[clientAt + 1] ?? 0);
  const sigAt = clientAt + 2 + clientLen;
  if (sigAt >= bytes.length) return null;
  return {
    credentialId,
    authenticatorData: bytes.slice(3, clientAt),
    clientDataJSON: bytes.slice(clientAt + 2, sigAt),
    signature: bytes.slice(sigAt),
  };
}

/**
 * The envelope for a person's passkey signature. `payloadDigest` names what
 * was signed (`payloadDigest(bytes)`; for a sign-off entry,
 * `sha256:<record_hash>`); the passkey's challenge was its SHA-256.
 */
export function webAuthnEnvelope(input: { readonly provider: string; readonly signer: AuthorRef; readonly payloadDigest: string; readonly assertion: WebAuthnAssertion; readonly signedAt?: string }): SignatureEnvelope {
  return {
    v: 1,
    alg: WEBAUTHN_ES256_ALG,
    provider: input.provider,
    keyId: input.assertion.credentialId,
    signer: { ...input.signer, keyId: input.assertion.credentialId },
    payloadDigest: input.payloadDigest,
    signature: packWebAuthnSignature(input.assertion),
    ...(input.signedAt ? { signedAt: input.signedAt } : {}),
  };
}

/** The WebAuthn challenge for a payload: SHA-256 of its bytes (a sign-off record's `record_hash`). */
export function webAuthnChallengeFor(payload: Uint8Array): Uint8Array {
  return sha256(payload);
}

// ---------------------------------------------------------------------------
// A provider that checks passkey envelopes
// ---------------------------------------------------------------------------

/** An enrolled key, as the provider's key log knows it. */
export interface WebAuthnKeyRecord {
  /** The provider's subject the key belongs to. */
  readonly subject: string;
  readonly publicKeySpki: Uint8Array;
  /** When the person retired it (ISO 8601), or null. Retired keys are never deleted; past signatures stay valid. */
  readonly retiredAt: string | null;
}

/** Checks a `webauthn-es256` envelope over `payload` against a key. */
export async function verifyWebAuthnEnvelope(env: SignatureEnvelope, payload: Uint8Array, key: WebAuthnKeyRecord | null, rp: WebAuthnRelyingParty): Promise<VerifyOutcome> {
  if (env.alg !== WEBAUTHN_ES256_ALG) return { status: "unverifiable", reason: `This isn't a passkey signature ("${env.alg}").` };
  if (!key) return { status: "unverifiable", reason: "The key that made this signature isn't on record here." };
  if (key.subject !== env.signer.subject) return { status: "invalid", reason: `The key belongs to someone else, not ${authorWords(env.signer)}.` };
  const assertion = unpackWebAuthnSignature(env.signature, env.keyId);
  if (!assertion) return { status: "invalid", reason: "The signature can't be read as a passkey signature." };
  const check = await verifyWebAuthnEs256(assertion, key.publicKeySpki, { ...rp, challenge: webAuthnChallengeFor(payload) });
  if (!check.ok) return { status: "invalid", reason: check.reason };
  const signer: AuthorRef = { ...env.signer, keyId: env.keyId };
  return key.retiredAt ? { status: "valid", signer, note: `Signed with a key retired on ${key.retiredAt.slice(0, 10)}.` } : { status: "valid", signer };
}

/**
 * An identity provider whose people sign with passkeys. A host gives it its
 * key lookup and relying party; the kernel never names the host.
 */
export function createWebAuthnIdentityProvider(input: {
  readonly id: string;
  readonly label: string;
  readonly version: string;
  readonly relyingParty: WebAuthnRelyingParty;
  resolveAuthor(subject: string): Promise<AuthorClaims | null>;
  resolveKey(keyId: string): Promise<WebAuthnKeyRecord | null>;
}): IdentityProviderDef {
  return {
    id: input.id,
    label: input.label,
    version: input.version,
    algorithms: [WEBAUTHN_ES256_ALG],
    resolveAuthor: (subject) => input.resolveAuthor(subject),
    async verify(env, payload) {
      const key = await input.resolveKey(env.keyId);
      return verifyWebAuthnEnvelope(env, payload, key, input.relyingParty);
    },
  };
}