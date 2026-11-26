import type { IncomingMessage, ServerResponse } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { PgNativeSessionStore, type ClaimedSignIn, type SignInProvider } from "../native-session-store";
import type { Sql } from "../pg-store";

const callback = "/auth/native/callback";
const finish = "/auth/native/finish";
const signOut = "/auth/native/sign-out";
const responseFields = z.object({ transactionId: z.guid(), state: z.string().length(43), code: z.string().min(1).max(4096) }).strict();
const metadata = z.object({
  issuer: z.string(), authorization_endpoint: z.string(), token_endpoint: z.string(), jwks_uri: z.string(),
});

function checkedUrl(value: string, local: boolean): URL {
  const url = new URL(value);
  const loopback = local && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((!loopback && url.protocol !== "https:") || url.username || url.password || url.hash) {
    throw new Error("Invalid native sign-in URL. Use HTTPS or local-stack loopback.");
  }
  return url;
}

async function discover(provider: SignInProvider, local: boolean) {
  const response = await fetch(provider.issuer.replace(/\/$/, "") + "/.well-known/openid-configuration", {
    redirect: "error", signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Provider discovery failed");
  const doc = metadata.parse(await response.json());
  if (doc.issuer !== provider.issuer) throw new Error("The provider returned a different issuer");
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
  if (!response.ok) throw new Error("Provider exchange failed");
  const { id_token } = z.object({ id_token: z.string() }).parse(await response.json());
  const { payload } = await jwtVerify(id_token, endpoints.keys, { issuer: claim.issuer, audience: claim.clientId,
    algorithms: ["RS256", "ES256", "PS256"], requiredClaims: ["exp", "iat", "sub", "nonce"] });
  if (payload.nonce !== claim.nonce || !payload.sub || payload.sub.length > 255 ||
      ((Array.isArray(payload.aud) && payload.aud.length > 1) || payload.azp !== undefined) && payload.azp !== claim.clientId) {
    throw new Error("Provider identity did not match this sign-in");
  }
  const name = typeof payload.name === "string" && payload.name.trim() ? payload.name : payload.sub;
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
    if (req.method !== "POST" || req.headers.origin !== origin || req.headers["content-type"] !== "application/json") {
      return send(403, { error: "Open sign-in from the editor." });
    }
    try {
      if (pathname === signOut) {
        const token = /^Bearer[ \t]+([A-Za-z0-9_-]{43})$/i.exec(req.headers.authorization ?? "")?.[1];
        if (!token) return send(401, { error: "This sign-out needs the session from the editor." });
        const empty = await readBody(req).then(body => z.object({}).strict().safeParse(body).success, () => false);
        if (!empty) return send(400, { error: "Send an empty object to sign out of this session." });
        await sessions.revokeSession(token);
        res.writeHead(204, { "cache-control": "no-store", "referrer-policy": "no-referrer" });
        res.end();
        return;
      }
      if (pathname === "/auth/native/start") {
        const discovered = await endpoints();
        const transaction = await sessions.startSignIn(provider);
        const authorize = new URL(discovered.authorize);
        for (const [key, value] of Object.entries({ response_type: "code", scope: "openid profile", client_id: clientId,
          redirect_uri: provider.redirectUri, state: transaction.state, nonce: transaction.nonce,
          code_challenge: transaction.codeChallenge, code_challenge_method: "S256" })) authorize.searchParams.set(key, value);
        res.setHeader("set-cookie", "bim_signin_" + transaction.transactionId + "=" + transaction.browserBinding + "; Max-Age=300" + suffix);
        return send(200, { transactionId: transaction.transactionId, authorizationUrl: authorize.href });
      }
      if (pathname !== finish) return send(404, { error: "Unknown sign-in route." });
      const fields = await readBody(req).then(body => responseFields.parse(body)).catch(() => null);
      if (!fields) return send(400, { error: "Start a fresh sign-in from the model." });
      const prefix = "bim_signin_" + fields.transactionId + "=";
      const bindings = (req.headers.cookie ?? "").split(";").map(c => c.trim()).filter(c => c.startsWith(prefix));
      const binding = bindings.length === 1 ? bindings[0]!.slice(prefix.length) : "";
      const claim = await sessions.claimSignIn({ state: fields.state, browserBinding: binding });
      if (claim.status !== "claimed") return send(400, { error: "This sign-in expired or was already used. Open the model again." });
      res.setHeader("set-cookie", prefix + "; Max-Age=0" + suffix);
      try {
        if (claim.transactionId !== fields.transactionId || claim.issuer !== issuer || claim.clientId !== clientId || claim.redirectUri !== provider.redirectUri) {
          throw new Error("The provider configuration changed");
        }
        const identity = await exchange(claim, fields.code, await endpoints(), env.MUTINYBIM_OIDC_CLIENT_SECRET);
        const issued = await sessions.completeSignIn({ transactionId: claim.transactionId, claimToken: claim.claimToken, identity });
        if (issued.status !== "issued") throw new Error("Sign-in expired");
        return send(200, { transactionId: claim.transactionId, userId: issued.personId, displayName: identity.displayName,
          token: issued.sessionToken, expiresAt: issued.expiresAt.toISOString() });
      } catch {
        await sessions.abandonSignIn(claim);
        return send(401, { error: "Sign-in could not be completed. Open the model to sign in again." });
      }
    } catch {
      return send(503, { error: pathname === signOut ? "Sign-out could not be confirmed. Try again." : "Sign-in is temporarily unavailable. Try again." });
    }
  };
}
