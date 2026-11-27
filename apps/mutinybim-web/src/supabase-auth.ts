/**
 * Supabase Auth (GoTrue REST + PKCE) client for the hosted web app.
 *
 * Uses built-in fetch and node:crypto with zero extra dependencies:
 * - Email + password sign-up (immediate session or confirmation email)
 * - Email + password sign-in
 * - Continue with Google (OAuth 2.0 authorization code + PKCE S256)
 * - Self-service password reset emails + recovery token verification + password update
 */
import type { SupabaseConfig } from "./config";
import type { Fetch } from "./oauth";

const AUTH_TIMEOUT_MS = 10_000;

export interface SupabaseUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly emailConfirmed: boolean;
  /** The account has only Google identities, and each one verifies this email. */
  readonly googleVerifiedEmail: boolean;
  /** Auth providers attached to this Supabase user (e.g. ["email", "google"]). */
  readonly providers: readonly string[];
}

export interface SupabaseAuthSession {
  readonly user: SupabaseUser;
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
  readonly needsConfirmation: boolean;
  /** True when Supabase returned an existing-user obfuscated signup response (empty identities). */
  readonly alreadyExists: boolean;
}

export class SupabaseAuthError extends Error {
  constructor(
    readonly status: number,
    readonly words: string,
    readonly code: string | null = null,
  ) {
    super(words);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function parseUser(raw: unknown): SupabaseUser | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const email = str(raw.email)?.toLowerCase();
  if (!id || !email) return null;
  const meta = isRecord(raw.user_metadata) ? raw.user_metadata : {};
  const displayName = (str(meta.display_name) ?? str(meta.full_name) ?? str(meta.name) ?? email.split("@")[0] ?? "You").slice(0, 80);
  const appMeta = isRecord(raw.app_metadata) ? raw.app_metadata : {};
  const providers = Array.isArray(appMeta.providers)
    ? appMeta.providers.filter((p): p is string => typeof p === "string")
    : str(appMeta.provider)
      ? [str(appMeta.provider)!]
      : [];
  // app_metadata.provider names only the first provider. Use the full list
  // and Google's identity data to establish which address Google verified.
  const onlyGoogle = Array.isArray(appMeta.providers) && appMeta.providers.length > 0
    && appMeta.providers.every((provider) => provider === "google");
  const googleVerifiedEmail = onlyGoogle && Array.isArray(raw.identities) && raw.identities.length > 0
    && raw.identities.every((identity: unknown) => isRecord(identity) && identity.provider === "google"
      && isRecord(identity.identity_data) && identity.identity_data.email_verified === true
      && str(identity.identity_data.email)?.toLowerCase() === email);
  const emailConfirmed = str(raw.email_confirmed_at) !== null;
  return { id, email, displayName, emailConfirmed, googleVerifiedEmail, providers };
}

function extractError(body: unknown, status: number): { readonly code: string | null; readonly message: string } {
  if (!isRecord(body)) return { code: null, message: `status ${status}` };
  const code = str(body.error_code) ?? str(body.code) ?? str(body.error);
  const message = str(body.msg) ?? str(body.error_description) ?? str(body.message) ?? str(body.error) ?? `status ${status}`;
  return { code, message };
}

function friendlyError(code: string | null, message: string, status: number): SupabaseAuthError {
  const lowerCode = (code ?? "").toLowerCase();
  const lowerMsg = message.toLowerCase();
  if (lowerCode === "email_not_confirmed" || lowerMsg.includes("email not confirmed")) {
    return new SupabaseAuthError(401, "Confirm your email first — check your inbox for the confirmation link, then log in.", "email_not_confirmed");
  }
  if (lowerCode === "invalid_credentials" || lowerCode === "invalid_grant" || lowerMsg.includes("invalid login credentials")) {
    return new SupabaseAuthError(401, "That email and password don't match an account. Check both and try again.", "invalid_credentials");
  }
  if (lowerCode === "user_already_exists" || lowerCode === "email_exists" || lowerMsg.includes("already registered")) {
    return new SupabaseAuthError(409, "An account with that email already exists. Log in instead.", "user_already_exists");
  }
  if (lowerCode === "weak_password" || lowerMsg.includes("password should be at least")) {
    return new SupabaseAuthError(400, "Use a password of at least 8 characters.", "weak_password");
  }
  if (lowerCode === "over_request_rate_limit" || lowerCode === "over_email_send_rate_limit" || status === 429) {
    return new SupabaseAuthError(429, "Too many tries right now. Wait a few minutes, then try again.", "rate_limited");
  }
  if (lowerCode === "otp_expired" || lowerMsg.includes("expired") || lowerMsg.includes("invalid token")) {
    return new SupabaseAuthError(400, "That sign-in or reset link expired or was already used. Request a new one.", "otp_expired");
  }
  if (lowerCode === "same_password" || lowerMsg.includes("different from the old password")) {
    return new SupabaseAuthError(400, "Pick a new password that is different from your current one.", "same_password");
  }
  return new SupabaseAuthError(status >= 400 && status < 500 ? status : 502, "Sign-in didn't go through right now. Try again in a minute.", code);
}

async function authRequest(
  config: SupabaseConfig,
  endpoint: string,
  options: { readonly method?: "GET" | "POST" | "PUT"; readonly body?: unknown; readonly bearer?: string; readonly fetchImpl?: Fetch } = {},
): Promise<{ readonly status: number; readonly ok: boolean; readonly data: unknown }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    apikey: config.publishableKey,
    accept: "application/json",
  };
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await fetchImpl(`${config.url}${endpoint}`, {
      method: options.method ?? "POST",
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
  } catch (err) {
    console.error("[mutinybim-web supabase-auth] request failed", { endpoint, err });
    throw new SupabaseAuthError(502, "Our sign-in service can't be reached right now. Try again in a minute.", "network_error");
  }
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }
  return { status: response.status, ok: response.ok, data };
}

/** Builds the Supabase OAuth authorize URL for "Continue with Google" (PKCE S256). */
export function googleAuthorizeUrl(config: SupabaseConfig, input: { readonly redirectTo: string; readonly codeChallenge: string }): string {
  const target = new URL(`${config.url}/auth/v1/authorize`);
  target.searchParams.set("provider", "google");
  target.searchParams.set("redirect_to", input.redirectTo);
  target.searchParams.set("code_challenge", input.codeChallenge);
  target.searchParams.set("code_challenge_method", "s256");
  return target.toString();
}

export async function signUpWithPassword(
  config: SupabaseConfig,
  input: { readonly email: string; readonly password: string; readonly displayName: string; readonly redirectTo: string; readonly codeChallenge?: string },
  fetchImpl?: Fetch,
): Promise<SupabaseAuthSession> {
  const query = new URLSearchParams({ redirect_to: input.redirectTo }).toString();
  const payload: Record<string, unknown> = {
    email: input.email,
    password: input.password,
    data: { display_name: input.displayName, full_name: input.displayName },
  };
  if (input.codeChallenge) {
    payload.code_challenge = input.codeChallenge;
    payload.code_challenge_method = "s256";
  }
  const res = await authRequest(config, `/auth/v1/signup?${query}`, { body: payload, fetchImpl });
  if (!res.ok) {
    const err = extractError(res.data, res.status);
    throw friendlyError(err.code, err.message, res.status);
  }
  const data = isRecord(res.data) ? res.data : {};
  const rawUser = isRecord(data.user) ? data.user : data;
  const user = parseUser(rawUser);
  if (!user) throw new SupabaseAuthError(502, "Account creation returned an unexpected answer. Try again.", "bad_response");
  const accessToken = str(data.access_token);
  const refreshToken = str(data.refresh_token);
  // Supabase hides duplicate signups when confirmation is on by returning a user with an empty identities array.
  const identities = isRecord(rawUser) && Array.isArray(rawUser.identities) ? rawUser.identities : null;
  const alreadyExists = !accessToken && identities !== null && identities.length === 0;
  return { user, accessToken, refreshToken, needsConfirmation: !accessToken && !alreadyExists, alreadyExists };
}

export async function signInWithPassword(
  config: SupabaseConfig,
  input: { readonly email: string; readonly password: string },
  fetchImpl?: Fetch,
): Promise<{ readonly user: SupabaseUser; readonly accessToken: string; readonly refreshToken: string | null }> {
  const res = await authRequest(config, "/auth/v1/token?grant_type=password", {
    body: { email: input.email, password: input.password },
    fetchImpl,
  });
  if (!res.ok) {
    const err = extractError(res.data, res.status);
    throw friendlyError(err.code, err.message, res.status);
  }
  const data = isRecord(res.data) ? res.data : {};
  const user = parseUser(data.user);
  const accessToken = str(data.access_token);
  if (!user || !accessToken) throw new SupabaseAuthError(502, "Sign-in returned an unexpected answer. Try again.", "bad_response");
  return { user, accessToken, refreshToken: str(data.refresh_token) };
}

export async function exchangePkceCode(
  config: SupabaseConfig,
  input: { readonly code: string; readonly codeVerifier: string },
  fetchImpl?: Fetch,
): Promise<{ readonly user: SupabaseUser; readonly accessToken: string; readonly refreshToken: string | null }> {
  const res = await authRequest(config, "/auth/v1/token?grant_type=pkce", {
    body: { auth_code: input.code, code_verifier: input.codeVerifier },
    fetchImpl,
  });
  if (!res.ok) {
    const err = extractError(res.data, res.status);
    throw friendlyError(err.code, err.message, res.status);
  }
  const data = isRecord(res.data) ? res.data : {};
  const user = parseUser(data.user);
  const accessToken = str(data.access_token);
  if (!user || !accessToken) throw new SupabaseAuthError(502, "Sign-in returned an unexpected answer. Try again.", "bad_response");
  return { user, accessToken, refreshToken: str(data.refresh_token) };
}

export async function verifyTokenHash(
  config: SupabaseConfig,
  input: { readonly tokenHash: string; readonly type: "signup" | "recovery" | "magiclink" | "email" },
  fetchImpl?: Fetch,
): Promise<{ readonly user: SupabaseUser; readonly accessToken: string; readonly refreshToken: string | null }> {
  const res = await authRequest(config, "/auth/v1/verify", {
    body: { token_hash: input.tokenHash, type: input.type },
    fetchImpl,
  });
  if (!res.ok) {
    const err = extractError(res.data, res.status);
    throw friendlyError(err.code, err.message, res.status);
  }
  const data = isRecord(res.data) ? res.data : {};
  const user = parseUser(data.user);
  const accessToken = str(data.access_token);
  if (!user || !accessToken) throw new SupabaseAuthError(502, "Verification returned an unexpected answer. Try again.", "bad_response");
  return { user, accessToken, refreshToken: str(data.refresh_token) };
}

export async function requestPasswordReset(
  config: SupabaseConfig,
  input: { readonly email: string; readonly redirectTo: string; readonly codeChallenge?: string },
  fetchImpl?: Fetch,
): Promise<void> {
  const query = new URLSearchParams({ redirect_to: input.redirectTo }).toString();
  const payload: Record<string, unknown> = { email: input.email };
  if (input.codeChallenge) {
    payload.code_challenge = input.codeChallenge;
    payload.code_challenge_method = "s256";
  }
  const res = await authRequest(config, `/auth/v1/recover?${query}`, { body: payload, fetchImpl });
  if (!res.ok) {
    const err = extractError(res.data, res.status);
    throw friendlyError(err.code, err.message, res.status);
  }
}

export async function updatePassword(
  config: SupabaseConfig,
  input: { readonly accessToken: string; readonly password: string },
  fetchImpl?: Fetch,
): Promise<SupabaseUser> {
  const res = await authRequest(config, "/auth/v1/user", {
    method: "PUT",
    bearer: input.accessToken,
    body: { password: input.password },
    fetchImpl,
  });
  if (!res.ok) {
    const err = extractError(res.data, res.status);
    throw friendlyError(err.code, err.message, res.status);
  }
  const user = parseUser(res.data);
  if (!user) throw new SupabaseAuthError(502, "Password update returned an unexpected answer. Try again.", "bad_response");
  return user;
}
