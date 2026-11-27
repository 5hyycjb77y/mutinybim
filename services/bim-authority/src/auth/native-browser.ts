import type { IncomingMessage, ServerResponse } from "node:http";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import { z } from "zod";
import { NativeSessionStoreError, PgNativeSessionStore, type ClaimedSignIn, type SignInProvider } from "../native-session-store";
import type { Sql } from "../pg-store";

const callback = "/auth/native/callback";
const finish = "/auth/native/finish";
const signOut = "/auth/native/sign-out";
const responseFields = z.object({ transactionId: z.guid(), state: z.string().length(43), code: z.string().min(1).max(4096) }).strict();
const metadata = z.object({
  issuer: z.string(), authorization_endpoint: z.string(), token_endpoint: z.string(), jwks_uri: z.string(),
});

// Only locally authored messages are safe to log verbatim. Parser and provider errors can carry input.
class SignInFailure extends Error {}

function failureReason(error: unknown): string {
  if (error instanceof SignInFailure) return error.message;
  if (error instanceof errors.JOSEError || error instanceof NativeSessionStoreError) return error.code;
  if (error instanceof z.ZodError) return "Invalid fields: " + error.issues.map(issue => issue.path.join(".") || "(root)").join(", ");
  if (error instanceof SyntaxError) return "Invalid JSON";
  if (error instanceof DOMException && error.name === "TimeoutError") return "Provider request timed out";
  return "Request could not be processed";
}

function receivedOrigin(value: string | undefined): string | null {
  if (!value) return null;
  const url = URL.parse(value);
  return url && (url.protocol === "http:" || url.protocol === "https:") && url.origin === value ? url.origin : "(invalid origin)";
}

function checkedUrl(value: string, local: boolean): URL {
  const url = URL.parse(value);
  if (!url) throw new SignInFailure("Invalid native sign-in URL");
  const loopback = local && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((!loopback && url.protocol !== "https:") || url.username || url.password || url.hash) {
    throw new SignInFailure("Invalid native sign-in URL. Use HTTPS or local-stack loopback.");
  }
  return url;
}

async function discover(provider: SignInProvider, local: boolean) {
  const response = await fetch(provider.issuer.replace(/\/$/, "") + "/.well-known/openid-configuration", {
    redirect: "error", signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new SignInFailure("Provider discovery failed (HTTP " + response.status + ")");
  const doc = metadata.parse(await response.json());
  if (doc.issuer !== provider.issuer) throw new SignInFailure("The discovery issuer differs from the configured issuer. Check the exact URL, including its trailing slash.");
  return { authorize: checkedUrl(doc.authorization_endpoint, local), token: checkedUrl(doc.token_endpoint, local),
    keys: createRemoteJWKSet(checkedUrl(doc.jwks_uri, local), { timeoutDuration: 5000 }) };
}

async function exchange(claim: ClaimedSignIn, code: string, endpoints: Awaited<ReturnType<typeof discover>>, secret?: string) {
  const body = new URLSearchParams({ grant_type: "authorization_code", redirect_uri: claim.redirectUri,
    code, code_verifier: claim.codeVerifier });
  const headers = new Headers();
  if (secret) {
    const formEncode = (s: string) => new URLSearchParams({ x: s }).toString().slice(2);
    const basic = Buffer.from(formEncode(claim.clientId) + ":" + formEncode(secret)).toString("base64");
    headers.set("authorization", "Basic " + basic);
  } else body.set("client_id", claim.clientId);
  const response = await fetch(endpoints.token, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new SignInFailure("Provider exchange failed (HTTP " + response.status + ")");
  const { id_token } = z.object({ id_token: z.string() }).parse(await response.json());
  const { payload } = await jwtVerify(id_token, endpoints.keys, { issuer: claim.issuer, audience: claim.clientId,
    algorithms: ["RS256", "ES256", "PS256"], requiredClaims: ["exp", "iat", "sub", "nonce"] });
  if (payload.nonce !== claim.nonce || !payload.sub || payload.sub.length > 255 ||
      ((Array.isArray(payload.aud) && payload.aud.length > 1) || payload.azp !== undefined) && payload.azp !== claim.clientId) {
    throw new SignInFailure("Provider identity did not match this sign-in");
  }
  const name = [payload.name, payload.preferred_username].find((value): value is string => typeof value === "string" && !!value.trim()) ?? payload.sub;
  return { issuer: claim.issuer, subject: payload.sub, displayName: [...name].slice(0, 200).join("") };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const bytes of req) {
    const chunk = Buffer.from(bytes);
    length += chunk.length;
    if (length > 8192) throw new Error("Sign-in reply is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** Mount behind the editor's origin. Only the callback's short-lived binding travels in a cookie. */
export function nativeBrowserRoutes(sql: Sql, env: NodeJS.ProcessEnv, local: boolean) {
  const issuer = env.MUTINYBIM_OIDC_ISSUER, clientId = env.MUTINYBIM_OIDC_CLIENT_ID, origin = env.MUTINYBIM_EDITOR_ORIGIN;
  if (!issuer && !clientId && !origin && !env.MUTINYBIM_OIDC_CLIENT_SECRET) return null;
  if (!issuer || !clientId || !origin || checkedUrl(origin, local).origin !== origin || checkedUrl(issuer, local).search) {
    throw new Error("Configure a native OIDC issuer, client ID and exact editor origin");
  }
  const provider = { issuer, clientId, redirectUri: origin + callback };
  let discovery: ReturnType<typeof discover> | undefined;
  const endpoints = () => discovery ??= discover(provider, local).catch((error: unknown) => { discovery = undefined; throw error; });
  const sessions = new PgNativeSessionStore(sql);
  const secure = origin.startsWith("https://") ? "; Secure" : "";
  const suffix = "; Path=" + finish + "; HttpOnly; SameSite=Strict" + secure;
  return async (req: IncomingMessage, res: ServerResponse, pathname: string) => {
    const send = (status: number, value: object) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "referrer-policy": "no-referrer" });
      res.end(JSON.stringify(value));
    };
    let stage = "request";
    const reject = (status: number, message: string, reason = message, origins?: { expected: string; received: string | null }) => {
      console.warn("[bim-authority] native sign-in failed", JSON.stringify({ stage, reason, ...origins }));
      send(status, { error: message });
    };
    if (req.headers.origin !== origin) {
      stage = "origin";
      return reject(403, `Open the editor at ${origin} to sign in.`, "Editor origin differs", { expected: origin, received: receivedOrigin(req.headers.origin) });
    }
    if (req.method !== "POST" || req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return reject(403, "Open sign-in from the editor.", "Expected a JSON POST");
    }
    let claimed: ClaimedSignIn | undefined;
    try {
      if (pathname === signOut) {
        stage = "sign-out";
        const token = /^Bearer[ \t]+([A-Za-z0-9_-]{43})$/i.exec(req.headers.authorization ?? "")?.[1];
        if (!token) return reject(401, "This sign-out needs the session from the editor.");
        const empty = await readBody(req).then(body => z.object({}).strict().safeParse(body).success, () => false);
        if (!empty) return reject(400, "Send an empty object to sign out of this session.");
        await sessions.revokeSession(token);
        res.writeHead(204, { "cache-control": "no-store", "referrer-policy": "no-referrer" });
        res.end();
        return;
      }
      if (pathname === "/auth/native/start") {
        stage = "start";
        const discovered = await endpoints();
        const transaction = await sessions.startSignIn(provider);
        const authorize = new URL(discovered.authorize);
        for (const [key, value] of Object.entries({ response_type: "code", scope: "openid profile", client_id: clientId,
          redirect_uri: provider.redirectUri, state: transaction.state, nonce: transaction.nonce,
          code_challenge: transaction.codeChallenge, code_challenge_method: "S256" })) authorize.searchParams.set(key, value);
        res.setHeader("set-cookie", "bim_signin_" + transaction.transactionId + "=" + transaction.browserBinding + "; Max-Age=300" + suffix);
        return send(200, { transactionId: transaction.transactionId, authorizationUrl: authorize.href });
      }
      if (pathname !== finish) return reject(404, "Unknown sign-in route.");
      stage = "claim";
      const fields = await readBody(req).then(body => responseFields.parse(body)).catch(() => null);
      if (!fields) return reject(400, "Start a fresh sign-in from the model.", "Invalid callback fields");
      const prefix = "bim_signin_" + fields.transactionId + "=";
      const bindings = (req.headers.cookie ?? "").split(";").map(c => c.trim()).filter(c => c.startsWith(prefix));
      const binding = bindings.length === 1 ? bindings[0]!.slice(prefix.length) : "";
      const claim = await sessions.claimSignIn({ state: fields.state, browserBinding: binding });
      if (claim.status !== "claimed") return reject(400, "This sign-in expired or was already used. Open the model again.");
      claimed = claim;
      res.setHeader("set-cookie", prefix + "; Max-Age=0" + suffix);
      stage = "config";
      if (claim.transactionId !== fields.transactionId || claim.issuer !== issuer || claim.clientId !== clientId || claim.redirectUri !== provider.redirectUri) {
        throw new SignInFailure("The provider configuration changed");
      }
      const discovered = await endpoints();
      stage = "exchange";
      const identity = await exchange(claim, fields.code, discovered, env.MUTINYBIM_OIDC_CLIENT_SECRET);
      stage = "complete";
      const issued = await sessions.completeSignIn({ transactionId: claim.transactionId, claimToken: claim.claimToken, identity });
      if (issued.status !== "issued") throw new SignInFailure("Sign-in expired");
      return send(200, { transactionId: claim.transactionId, userId: issued.personId, displayName: identity.displayName,
        token: issued.sessionToken, expiresAt: issued.expiresAt.toISOString() });
    } catch (error) {
      const reason = failureReason(error);
      if (claimed) {
        try {
          await sessions.abandonSignIn(claimed);
        } catch {
          return reject(503, "Sign-in is temporarily unavailable. Try again.", reason + " (closing the transaction also failed)");
        }
        return reject(401, "Sign-in could not be completed. Open the model to sign in again.", reason);
      }
      return reject(503, pathname === signOut ? "Sign-out could not be confirmed. Try again." : "Sign-in is temporarily unavailable. Try again.", reason);
    }
  };
}
