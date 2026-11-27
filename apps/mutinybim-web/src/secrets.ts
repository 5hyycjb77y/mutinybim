/**
 * Passwords (scrypt), random tokens and their stored digests. A session
 * cookie or an agent key is shown to its owner once; only its SHA-256 digest
 * is kept, so a copy of the database signs no one in.
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { WebStore } from "./db";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[4] ?? "", "base64url");
  const expected = Buffer.from(parts[5] ?? "", "base64url");
  if (salt.length === 0 || expected.length !== KEY_LEN) return false;
  const key = await scryptAsync(password, salt);
  return timingSafeEqual(key, expected);
}

/** How long a password reset link works. */
export const RESET_LINK_HOURS = 1;

/**
 * Makes a one-time password reset link for an account and returns its token.
 * Only the token's digest is stored. The caller chooses when earlier links
 * expire so an SMTP delivery failure can preserve a link already received.
 */
export async function issuePasswordReset(save: WebStore["createPasswordReset"], userId: string): Promise<string> {
  const token = randomToken();
  await save(digest(token), userId, new Date(Date.now() + RESET_LINK_HOURS * 3_600_000));
  return token;
}

/** A URL-safe random token with the given prefix (e.g. `mbk_` for agent keys). */
export function randomToken(prefix = ""): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** PKCE (RFC 7636): a verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
