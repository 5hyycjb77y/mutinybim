import { PROVIDER_ID, authorWords, readAuthorRef, sameAuthor, writeAuthorRef, type AuthorRefJson } from "./author";
import { AuthorshipWriteError, type Attribution, type AuthorshipRead, type SignatureEnvelope } from "./types";

/** The envelope format this release writes. */
export const SIGNATURE_ENVELOPE_VERSION = 1;

const KNOWN = new Set(["v", "alg", "provider", "keyId", "signer", "payloadDigest", "signature", "certChain", "signedAt"]);
const ALG = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_SIGNATURE = 65_536;
const MAX_CERTS = 10;
const MAX_CERT = 16_384;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Tolerant reader. Keeps an unknown provider, algorithm, digest kind or
 * envelope version, and any field a newer writer added (in `extensions`), so
 * reading and writing back loses nothing. Refuses, in words, only what can't
 * be a signature at all.
 */
export function readSignatureEnvelope(value: unknown): AuthorshipRead<SignatureEnvelope> {
  if (!isRecord(value)) return { ok: false, reason: "A signature must be an object." };
  const { v, alg, provider, keyId, signer, payloadDigest, signature, certChain, signedAt } = value;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return { ok: false, reason: "A signature has no format version." };
  if (typeof alg !== "string" || alg === "") return { ok: false, reason: "A signature has no algorithm." };
  if (typeof provider !== "string" || provider === "") return { ok: false, reason: "A signature has no provider." };
  if (typeof keyId !== "string" || keyId === "") return { ok: false, reason: "A signature has no key id." };
  if (typeof payloadDigest !== "string" || payloadDigest === "") return { ok: false, reason: "A signature has no digest of what was signed." };
  if (typeof signature !== "string" || signature === "") return { ok: false, reason: "A signature has no signature value." };
  const notes: string[] = [];
  const who = readAuthorRef(signer);
  if (!who.ok) return { ok: false, reason: `A signature's signer can't be read: ${who.reason}` };
  notes.push(...who.notes);
  if (v > SIGNATURE_ENVELOPE_VERSION) notes.push(`This signature uses envelope format ${v}; this release reads format ${SIGNATURE_ENVELOPE_VERSION} fields and keeps the rest.`);
  let chain: string[] | undefined;
  if (certChain !== undefined) {
    if (!Array.isArray(certChain) || certChain.some((c) => typeof c !== "string")) return { ok: false, reason: "A signature's certificate chain must be a list of certificates." };
    chain = certChain.filter((c): c is string => typeof c === "string");
  }
  const extensions: Record<string, unknown> = {};
  for (const [k, field] of Object.entries(value)) if (!KNOWN.has(k)) extensions[k] = field;
  if (Object.keys(extensions).length > 0) notes.push(`This signature carries fields this release doesn't know (${Object.keys(extensions).sort().join(", ")}); they are kept as written.`);
  return {
    ok: true,
    notes,
    value: {
      v,
      alg,
      provider,
      keyId,
      signer: who.value,
      payloadDigest,
      signature,
      ...(chain ? { certChain: chain } : {}),
      ...(typeof signedAt === "string" ? { signedAt } : {}),
      ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
    },
  };
}

/** The wire form of an envelope: known fields plus any kept extensions, flat. */
export type SignatureEnvelopeJson = {
  v: number;
  alg: string;
  provider: string;
  keyId: string;
  signer: AuthorRefJson;
  payloadDigest: string;
  signature: string;
  certChain?: string[];
  signedAt?: string;
  [extension: string]: unknown;
};

/**
 * Strict writer. Writes format 1 only, with a `sha256:` digest, base64url
 * signature, base64 certificates and a person as signer. Extensions a reader
 * kept are written back unchanged; this writer never invents one.
 */
export function writeSignatureEnvelope(env: SignatureEnvelope): SignatureEnvelopeJson {
  if (env.v !== SIGNATURE_ENVELOPE_VERSION) throw new AuthorshipWriteError(`This release writes signature format ${SIGNATURE_ENVELOPE_VERSION}, not ${env.v}.`);
  if (env.signer.kind !== "person") throw new AuthorshipWriteError(`Only people sign. ${authorWords(env.signer)} can't be a signer.`);
  if (!ALG.test(env.alg)) throw new AuthorshipWriteError(`"${env.alg}" isn't a signature algorithm name.`);
  if (!PROVIDER_ID.test(env.provider)) throw new AuthorshipWriteError(`"${env.provider}" isn't a provider id.`);
  if (env.keyId.length === 0 || env.keyId.length > 512) throw new AuthorshipWriteError("A signature's key id must be 1-512 characters.");
  if (!SHA256_DIGEST.test(env.payloadDigest)) throw new AuthorshipWriteError("A signature must name what it signed as sha256:<64 lowercase hex>.");
  if (env.signature.length > MAX_SIGNATURE || !BASE64URL.test(env.signature)) throw new AuthorshipWriteError("A signature value must be base64url text under 64 KB.");
  if (env.certChain !== undefined) {
    if (env.certChain.length === 0 || env.certChain.length > MAX_CERTS) throw new AuthorshipWriteError(`A certificate chain holds 1-${MAX_CERTS} certificates.`);
    if (env.certChain.some((c) => c.length > MAX_CERT || !BASE64.test(c))) throw new AuthorshipWriteError("Each certificate must be base64 text under 16 KB.");
  }
  if (env.signedAt !== undefined && !ISO_TIME.test(env.signedAt)) throw new AuthorshipWriteError("A signature's time must be an ISO 8601 date and time.");
  const out: SignatureEnvelopeJson = {
    v: env.v,
    alg: env.alg,
    provider: env.provider,
    keyId: env.keyId,
    signer: writeAuthorRef(env.signer),
    payloadDigest: env.payloadDigest,
    signature: env.signature,
    ...(env.certChain ? { certChain: [...env.certChain] } : {}),
    ...(env.signedAt !== undefined ? { signedAt: env.signedAt } : {}),
  };
  for (const [k, field] of Object.entries(env.extensions ?? {})) {
    if (KNOWN.has(k)) throw new AuthorshipWriteError(`A kept extension can't be named "${k}"; that is a signature field.`);
    out[k] = field;
  }
  return out;
}

/**
 * The act with its signature. Only a person signs their own act: an agent's
 * act carries the agent and the person it acted for, and no signature, even
 * one that claims to be that person's.
 */
export function attachSignature(act: Attribution, env: SignatureEnvelope): Attribution {
  if (act.author.kind === "agent") {
    const person = act.author.onBehalfOf;
    throw new AuthorshipWriteError(`Agents can't sign. ${person ? authorWords(person) : "The person the agent acted for"} signs this themselves.`);
  }
  if (act.author.kind !== "person") throw new AuthorshipWriteError(`Only people sign. ${authorWords(act.author)} can't sign.`);
  if (!sameAuthor(act.author, env.signer)) throw new AuthorshipWriteError(`This signature is ${authorWords(env.signer)}'s, but the act is ${authorWords(act.author)}'s. People sign only their own acts.`);
  writeSignatureEnvelope(env);
  return { ...act, signature: env };
}
