/**
 * Signing in an outside assistant (Claude, ChatGPT, Grok, Cursor, …) over
 * the internet, the way the MCP authorization spec asks: this app is both
 * the tool server (an OAuth protected resource) and its own authorization
 * server.
 *
 * - Discovery: protected resource metadata (RFC 9728) for /mcp and every
 *   /packs/<family>/mcp, and authorization server metadata (RFC 8414).
 * - Client registration: dynamic registration (RFC 7591) and client ID
 *   metadata documents (an https client_id the app fetches, carefully).
 *   Registered clients may be public (`none`) or confidential
 *   (`client_secret_post` / `client_secret_basic`, secret kept as a digest);
 *   a metadata document client must be able to use `none`.
 * - Sign-in: authorization code with PKCE (S256 only, for every client), the `resource`
 *   parameter (RFC 8707) checked against this app's tool addresses, and
 *   `iss` in every redirect (RFC 9207).
 * - Tokens: opaque, stored as digests; access for an hour, refresh for 30
 *   days, rotated on every use (a reused refresh token ends the grant).
 *
 * The tokens let an assistant reach the tool server only. They never sign
 * anyone in to the pages, and the pages' cookies never reach the tool server.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { AssistantClientRow, AssistantTokenAuthMethod, Db, UserRow } from "./db";
import { digest, randomToken } from "./secrets";

/** The one scope: use your models through an assistant (what you can do is still your access to each model). */
export const MCP_SCOPE = "models";
/** Scopes an assistant may ask for that grant nothing extra here; they are dropped, not refused. */
const IGNORED_SCOPES = new Set(["offline_access", "openid", "profile", "email"]);
const TOKEN_AUTH_METHODS: readonly AssistantTokenAuthMethod[] = ["none", "client_secret_post", "client_secret_basic"];
const CODE_MINUTES = 5;
const ACCESS_MINUTES = 60;
const REFRESH_DAYS = 30;
const MAX_REGISTERED_CLIENTS = 5_000;
const METADATA_DOCUMENT_MAX_BYTES = 5 * 1024;
const METADATA_DOCUMENT_REFRESH_MS = 24 * 3_600_000;

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export type ResolveHost = (hostname: string) => Promise<readonly string[]>;

export interface AssistantAuthOptions {
  readonly origin: string;
  /** The tool families served at /packs/<family>/mcp. */
  readonly families: readonly string[];
  readonly db: Db;
  readonly fetchImpl?: Fetch;
  readonly resolveHost?: ResolveHost;
}

/** An OAuth error answer: the JSON body and status the token and registration endpoints send. */
export interface OAuthAnswer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const oauthError = (status: number, error: string, description: string): OAuthAnswer => ({ status, body: { error, error_description: description } });

/** The tool path a request is for: "" is /mcp, a family slug is /packs/<family>/mcp, null is neither. */
export function toolPathOf(pathname: string, families: readonly string[]): string | null {
  if (pathname === "/mcp") return "";
  const match = /^\/packs\/([a-z0-9-]+)\/mcp$/.exec(pathname);
  return match?.[1] && families.includes(match[1]) ? match[1] : null;
}

export function toolPath(family: string): string {
  return family ? `/packs/${family}/mcp` : "/mcp";
}

/** The protected resource metadata path for a tool path (RFC 9728 puts the resource's path after the well-known part). */
export function resourceMetadataUrl(origin: string, family: string): string {
  return `${origin}/.well-known/oauth-protected-resource${toolPath(family)}`;
}

export function protectedResourceMetadata(origin: string, family: string): Record<string, unknown> {
  return {
    resource: `${origin}${toolPath(family)}`,
    authorization_servers: [origin],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: family ? `MutinyBIM (${family} tools)` : "MutinyBIM",
    resource_documentation: `${origin}/connect`,
  };
}

export function authorizationServerMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    scopes_supported: [MCP_SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: TOKEN_AUTH_METHODS,
    revocation_endpoint_auth_methods_supported: TOKEN_AUTH_METHODS,
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${origin}/connect`,
  };
}

/** The WWW-Authenticate challenge for a tool request with no usable token. */
export function bearerChallenge(origin: string, family: string, error?: "invalid_token"): string {
  const parts = [`resource_metadata="${resourceMetadataUrl(origin, family)}"`, `scope="${MCP_SCOPE}"`];
  if (error) parts.unshift(`error="${error}"`, `error_description="The sign-in expired or was ended. Sign in again."`);
  return `Bearer ${parts.join(", ")}`;
}

const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:", "filesystem:", "ws:", "wss:"]);

/**
 * Where an assistant may send people back to: https anywhere, plain http
 * only to this computer (desktop apps), or an app's own scheme
 * (`cursor://…`). Never a fragment, never a script address.
 */
export function redirectUriProblem(value: string): string | null {
  if (value.length > 2000) return "is too long";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "is not an address";
  }
  if (url.hash) return "has a # part";
  if (BLOCKED_SCHEMES.has(url.protocol)) return `uses ${url.protocol}, which is not allowed`;
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ? null : "uses plain http to another computer (use https)";
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) ? null : "has a scheme that isn't allowed";
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? value : null;
}

function cleanName(value: unknown, fallback: string): string {
  const name = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 80) : "";
  return name || fallback;
}

function isTokenAuthMethod(value: unknown): value is AssistantTokenAuthMethod {
  return typeof value === "string" && (TOKEN_AUTH_METHODS as readonly string[]).includes(value);
}

/**
 * Dynamic client registration (RFC 7591), redirect addresses checked. A
 * public client (`none`) gets no secret; a confidential one gets a secret
 * shown once here and kept only as its digest. PKCE is required either way.
 */
export function registerClient(db: Db, body: unknown): OAuthAnswer {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return oauthError(400, "invalid_client_metadata", "Send the client's metadata as a JSON object.");
  const meta = body as Record<string, unknown>;
  const uris = stringList(meta.redirect_uris);
  if (!uris || uris.length === 0 || uris.length > 10) return oauthError(400, "invalid_redirect_uri", "Give one to ten redirect_uris.");
  for (const uri of uris) {
    const problem = redirectUriProblem(uri);
    if (problem) return oauthError(400, "invalid_redirect_uri", `The redirect address ${uri.slice(0, 200)} ${problem}.`);
  }
  const method = meta.token_endpoint_auth_method ?? "none";
  if (!isTokenAuthMethod(method)) return oauthError(400, "invalid_client_metadata", `token_endpoint_auth_method must be one of ${TOKEN_AUTH_METHODS.join(", ")}.`);
  const grants = stringList(meta.grant_types) ?? ["authorization_code", "refresh_token"];
  if (grants.some((g) => g !== "authorization_code" && g !== "refresh_token")) return oauthError(400, "invalid_client_metadata", "Only authorization_code and refresh_token grants are offered.");
  const responseTypes = stringList(meta.response_types) ?? ["code"];
  if (responseTypes.some((t) => t !== "code")) return oauthError(400, "invalid_client_metadata", "Only the code response type is offered.");
  if (db.countAssistantClients() >= MAX_REGISTERED_CLIENTS) {
    console.error("[mutinybim-web] assistant registration refused: the client table is full", { max: MAX_REGISTERED_CLIENTS });
    return oauthError(503, "temporarily_unavailable", "Registration is full on this server right now. Try again later.");
  }
  const clientId = `mbc_${randomUUID()}`;
  const clientName = cleanName(meta.client_name, "An assistant");
  const secret = method === "none" ? null : randomToken("mbs_");
  db.saveAssistantClient({ clientId, clientName, redirectUris: uris, kind: "registered", tokenAuthMethod: method, secretHash: secret ? digest(secret) : null });
  console.log("[mutinybim-web] an assistant registered", { clientId, clientName, tokenAuthMethod: method });
  return {
    status: 201,
    body: {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: clientName,
      redirect_uris: uris,
      grant_types: grants,
      response_types: ["code"],
      token_endpoint_auth_method: method,
      scope: MCP_SCOPE,
    },
  };
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
  return lower === "::" || lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80") || lower.startsWith("ff");
}

/**
 * Whether a metadata document client can sign in as a public client. The
 * singular `token_endpoint_auth_method` may be a preference (SEP-3149): a
 * document that names another method but lists `none` in
 * `token_endpoint_auth_methods_supported` uses `none` here, with PKCE.
 */
export function metadataClientCanUseNone(meta: Record<string, unknown>): boolean {
  const preferred = meta.token_endpoint_auth_method;
  if (preferred === undefined || preferred === "none") return true;
  return stringList(meta.token_endpoint_auth_methods_supported)?.includes("none") ?? false;
}

const defaultResolve: ResolveHost = async (hostname) => (await lookup(hostname, { all: true })).map((a) => a.address);

/**
 * A client ID metadata document: the client_id is an https address the
 * assistant's maker publishes. Fetched only from public addresses, without
 * following redirects, small and quick, and kept for a day.
 */
async function metadataClient(clientId: string, options: AssistantAuthOptions): Promise<AssistantClientRow | string> {
  const cached = options.db.assistantClient(clientId);
  if (cached && Date.now() - Date.parse(cached.created_at) < METADATA_DOCUMENT_REFRESH_MS) return cached;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return "The assistant's client_id is not an address this server knows.";
  }
  if (url.protocol !== "https:" || url.pathname === "/" || url.hash || url.username || url.password) return "The assistant's client_id must be an https address with a path.";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  try {
    const addresses = isIP(host) ? [host] : await (options.resolveHost ?? defaultResolve)(host);
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) return "The assistant's client_id points at a private address, so it was not fetched.";
  } catch (err) {
    console.error("[mutinybim-web] an assistant's metadata address didn't resolve", { clientId, err });
    return "The assistant's client_id address couldn't be found.";
  }
  let doc: unknown;
  try {
    const response = await (options.fetchImpl ?? fetch)(url.href, { redirect: "error", signal: AbortSignal.timeout(5_000), headers: { accept: "application/json" } });
    if (!response.ok) return `The assistant's metadata answered ${response.status}.`;
    const text = await response.text();
    if (text.length > METADATA_DOCUMENT_MAX_BYTES) return "The assistant's metadata is larger than 5 KB.";
    doc = JSON.parse(text);
  } catch (err) {
    console.error("[mutinybim-web] fetching an assistant's metadata failed", { clientId, err });
    return "The assistant's metadata couldn't be read.";
  }
  if (typeof doc !== "object" || doc === null) return "The assistant's metadata is not a JSON object.";
  const meta = doc as Record<string, unknown>;
  if (meta.client_id !== clientId) return "The assistant's metadata names a different client_id.";
  const uris = stringList(meta.redirect_uris);
  if (!uris || uris.length === 0 || uris.some((u) => redirectUriProblem(u) !== null)) return "The assistant's metadata has no usable redirect_uris.";
  if (!metadataClientCanUseNone(meta)) {
    console.warn("[mutinybim-web] an assistant's metadata offers no public sign-in", { clientId, method: meta.token_endpoint_auth_method, methods: meta.token_endpoint_auth_methods_supported });
    return "This assistant can only sign in with a key this server doesn't check (it doesn't offer the public, no-secret sign-in).";
  }
  const clientName = cleanName(meta.client_name, url.hostname);
  options.db.saveAssistantClient({ clientId, clientName, redirectUris: uris, kind: "metadata" });
  const saved = options.db.assistantClient(clientId);
  return saved ?? "The assistant's metadata couldn't be kept.";
}

/** Who is asking, where they go back to, and what for. */
export interface AuthorizeRequest {
  readonly client: AssistantClientRow;
  readonly redirectUri: string;
  readonly state: string | null;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly scope: string;
}

/**
 * Checks a sign-in request. A bad client or redirect address is shown to
 * the person (never redirected to); anything else wrong goes back to the
 * assistant as an OAuth error.
 */
export type AuthorizeCheck =
  | { readonly ok: true; readonly request: AuthorizeRequest }
  | { readonly ok: false; readonly show: string }
  | { readonly ok: false; readonly redirect: string };

/** The canonical resource for a requested one, or null when it isn't this app's tool server. */
export function canonicalResource(origin: string, families: readonly string[], requested: string | null): string | null {
  if (!requested) return `${origin}/mcp`;
  let url: URL;
  try {
    url = new URL(requested);
  } catch {
    return null;
  }
  const base = `${url.protocol}//${url.host}`.toLowerCase();
  if (base !== origin.toLowerCase() || url.search || url.hash) return null;
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname === "") return `${origin}/mcp`;
  const family = toolPathOf(pathname, families);
  return family === null ? null : `${origin}${toolPath(family)}`;
}

export function errorRedirect(origin: string, redirectUri: string, state: string | null, error: string, description: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state !== null) url.searchParams.set("state", state);
  url.searchParams.set("iss", origin);
  return url.href;
}

export async function checkAuthorize(params: URLSearchParams, options: AssistantAuthOptions): Promise<AuthorizeCheck> {
  const clientId = params.get("client_id") ?? "";
  if (!clientId) return { ok: false, show: "The assistant didn't say who it is (no client_id). Start connecting again from the assistant." };
  const found = clientId.startsWith("https://") ? await metadataClient(clientId, options) : options.db.assistantClient(clientId);
  if (typeof found === "string") return { ok: false, show: found };
  if (!found) return { ok: false, show: "This server doesn't know that assistant. Remove MutinyBIM from the assistant and add it again, so it registers afresh." };
  const redirectUri = params.get("redirect_uri") ?? (found.redirect_uris.length === 1 ? found.redirect_uris[0] ?? "" : "");
  if (!found.redirect_uris.includes(redirectUri)) return { ok: false, show: "The assistant asked to send you back to an address it didn't register, so this was stopped." };
  const state = params.get("state");
  const back = (error: string, description: string): AuthorizeCheck => ({ ok: false, redirect: errorRedirect(options.origin, redirectUri, state, error, description) });
  if (params.get("response_type") !== "code") return back("unsupported_response_type", "Only response_type=code is offered.");
  const codeChallenge = params.get("code_challenge") ?? "";
  if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) return back("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  const resource = canonicalResource(options.origin, options.families, params.get("resource"));
  if (!resource) return back("invalid_target", "The resource is not this MutinyBIM tool server.");
  const requested = (params.get("scope") ?? MCP_SCOPE).split(/\s+/).filter(Boolean);
  if (requested.some((s) => s !== MCP_SCOPE && !IGNORED_SCOPES.has(s))) return back("invalid_scope", `The only scope is "${MCP_SCOPE}".`);
  return { ok: true, request: { client: found, redirectUri, state, codeChallenge, resource, scope: MCP_SCOPE } };
}

/** After the person said yes: a one-time code, and the address that hands it to the assistant. */
export function approveAuthorize(request: AuthorizeRequest, user: UserRow, options: AssistantAuthOptions): string {
  const code = randomToken("mbcode_");
  options.db.saveAssistantCode(digest(code), { client_id: request.client.client_id, user_id: user.id, redirect_uri: request.redirectUri, code_challenge: request.codeChallenge, resource: request.resource, scope: request.scope }, new Date(Date.now() + CODE_MINUTES * 60_000));
  console.log("[mutinybim-web] an assistant was let in", { userId: user.id, clientId: request.client.client_id });
  const url = new URL(request.redirectUri);
  url.searchParams.set("code", code);
  if (request.state !== null) url.searchParams.set("state", request.state);
  url.searchParams.set("iss", options.origin);
  return url.href;
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function issueTokens(): { access: string; refresh: string; accessExpiresAt: Date; refreshExpiresAt: Date } {
  return { access: randomToken("mba_"), refresh: randomToken("mbr_"), accessExpiresAt: new Date(Date.now() + ACCESS_MINUTES * 60_000), refreshExpiresAt: new Date(Date.now() + REFRESH_DAYS * 86_400_000) };
}

function tokenBody(tokens: { access: string; refresh: string }, scope: string): Record<string, unknown> {
  return { access_token: tokens.access, token_type: "Bearer", expires_in: ACCESS_MINUTES * 60, refresh_token: tokens.refresh, scope };
}

function sameSecret(secret: string, storedHash: string): boolean {
  const a = Buffer.from(digest(secret), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** RFC 6749 §2.3.1: HTTP Basic with the form-encoded client_id and secret. */
function basicCredentials(authorization: string | undefined): { id: string; secret: string } | null | "bad" {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(authorization ?? "");
  if (!match?.[1]) return authorization && /^Basic\b/i.test(authorization) ? "bad" : null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return "bad";
  try {
    const decode = (s: string) => decodeURIComponent(s.replace(/\+/g, " "));
    return { id: decode(decoded.slice(0, colon)), secret: decode(decoded.slice(colon + 1)) };
  } catch {
    return "bad";
  }
}

/**
 * Who is calling the token endpoint. A public client names itself with
 * client_id; a confidential client must also prove its secret, in the body
 * (`client_secret_post`) or in HTTP Basic (`client_secret_basic`), never both.
 */
function authenticateClient(form: URLSearchParams, authorization: string | undefined, options: AssistantAuthOptions): { clientId: string } | OAuthAnswer {
  const basic = basicCredentials(authorization);
  if (basic === "bad") return oauthError(401, "invalid_client", "The Basic credentials couldn't be read.");
  const formId = form.get("client_id");
  const formSecret = form.get("client_secret");
  if (basic && formSecret) return oauthError(400, "invalid_request", "Send the client secret one way only: Basic or client_secret, not both.");
  if (basic && formId && formId !== basic.id) return oauthError(401, "invalid_client", "The client_id doesn't match the Basic credentials.");
  const clientId = basic?.id ?? formId ?? "";
  if (!clientId) return oauthError(401, "invalid_client", "Send client_id (public clients authenticate with PKCE, not a secret).");
  const secret = basic?.secret ?? formSecret ?? "";
  const client = options.db.assistantClient(clientId);
  if (client && client.token_auth_method !== "none") {
    if (!secret || !client.secret_hash || !sameSecret(secret, client.secret_hash)) {
      console.warn("[mutinybim-web] an assistant's client secret was missing or wrong", { clientId, via: basic ? "basic" : formSecret ? "post" : "none" });
      return oauthError(401, "invalid_client", "The client secret is missing or wrong.");
    }
    return { clientId };
  }
  if (secret) return oauthError(401, "invalid_client", "This client registered without a secret; sign in with PKCE only.");
  return { clientId };
}

/** The token endpoint: a code (with its PKCE verifier) or a refresh token, for new tokens. */
export function exchangeToken(form: URLSearchParams, options: AssistantAuthOptions, authorization?: string): OAuthAnswer {
  const grantType = form.get("grant_type");
  const caller = authenticateClient(form, authorization, options);
  if ("status" in caller) return caller;
  const { clientId } = caller;
  if (grantType === "authorization_code") {
    const code = form.get("code") ?? "";
    const found = code ? options.db.takeAssistantCode(digest(code)) : null;
    if (!found || found.client_id !== clientId) return oauthError(400, "invalid_grant", "That sign-in code is unknown, used or expired. Sign in again.");
    if ((form.get("redirect_uri") ?? found.redirect_uri) !== found.redirect_uri) return oauthError(400, "invalid_grant", "The redirect_uri doesn't match the sign-in.");
    const verifier = form.get("code_verifier") ?? "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || s256(verifier) !== found.code_challenge) return oauthError(400, "invalid_grant", "The PKCE code_verifier doesn't match.");
    const resource = form.get("resource");
    if (resource !== null && canonicalResource(options.origin, options.families, resource) !== found.resource) return oauthError(400, "invalid_target", "The resource doesn't match the sign-in.");
    const client = options.db.assistantClient(clientId);
    const tokens = issueTokens();
    options.db.createAssistantGrant({
      id: randomUUID(),
      userId: found.user_id,
      clientId,
      clientName: client?.client_name ?? "An assistant",
      resource: found.resource,
      scope: found.scope,
      accessHash: digest(tokens.access),
      accessExpiresAt: tokens.accessExpiresAt,
      refreshHash: digest(tokens.refresh),
      refreshExpiresAt: tokens.refreshExpiresAt,
    });
    return { status: 200, body: tokenBody(tokens, found.scope) };
  }
  if (grantType === "refresh_token") {
    const refresh = form.get("refresh_token") ?? "";
    const tokens = issueTokens();
    const rotated = refresh ? options.db.rotateAssistantRefresh(digest(refresh), clientId, { accessHash: digest(tokens.access), accessExpiresAt: tokens.accessExpiresAt, refreshHash: digest(tokens.refresh), refreshExpiresAt: tokens.refreshExpiresAt }) : null;
    if (rotated && "reused" in rotated) {
      console.warn("[mutinybim-web] a refresh token was used twice; the assistant's access was ended", { clientId });
      return oauthError(400, "invalid_grant", "That refresh token was already used, so this sign-in was ended. Sign in again.");
    }
    if (!rotated) return oauthError(400, "invalid_grant", "That refresh token is unknown or expired. Sign in again.");
    return { status: 200, body: tokenBody(tokens, rotated.grant.scope) };
  }
  return oauthError(400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
}

/** The person and grant behind a tool request's bearer token, when the token is valid for this tool server. */
export function verifyAccessToken(authorization: string | undefined, options: AssistantAuthOptions): { readonly user: UserRow; readonly grantId: string; readonly clientName: string } | null {
  const match = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(authorization ?? "");
  if (!match?.[1]) return null;
  const found = options.db.assistantGrantByAccess(digest(match[1]));
  if (!found) return null;
  // Audience: a token issued for any of this app's tool addresses (one server, several tool lists).
  if (canonicalResource(options.origin, options.families, found.grant.resource) !== found.grant.resource) return null;
  return { user: found.user, grantId: found.grant.id, clientName: found.grant.client_name };
}
