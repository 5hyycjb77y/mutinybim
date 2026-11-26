/** @jest-environment node */
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { nativeBrowserRoutes } from "../auth/native-browser";
import { PgNativeSessionStore } from "../native-session-store";
import type { Sql } from "../pg-store";

const editor = "http://127.0.0.1:3095";
const clientId = "east plant:editor";
const clientSecret = "test:client+secret";
const random = () => randomBytes(32).toString("base64url");
const tx = { transactionId: randomUUID(), state: random(), nonce: random(), browserBinding: random(),
  codeChallenge: random(), expiresAt: new Date(Date.now() + 300_000) };
const code = random(), verifier = random(), claimToken = random(), sessionToken = random();
const cookie = "bim_signin_" + tx.transactionId + "=" + tx.browserBinding;
const callback = { transactionId: tx.transactionId, state: tx.state, code };

async function listen(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  return { server, url: "http://127.0.0.1:" + (server.address() as AddressInfo).port };
}

async function close(server: Server | undefined) {
  if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
}

let issuer: string, provider: Server, authority: Server | undefined, origin: string;
let discoveredIssuer: string, claims: JWTPayload, lastIdToken: string;
let tokenRequest: { auth?: string; form: URLSearchParams } | undefined;
let warn: jest.SpyInstance;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(keys.publicKey), kid: "provider-test", alg: "RS256" };
  const fixture = await listen(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/.well-known/openid-configuration") {
      res.end(JSON.stringify({ issuer: discoveredIssuer, authorization_endpoint: issuer + "/authorize",
        token_endpoint: issuer + "/token", jwks_uri: issuer + "/keys" }));
    } else if (req.url === "/keys") {
      res.end(JSON.stringify({ keys: [jwk] }));
    } else if (req.url === "/token" && req.method === "POST") {
      const parts: Buffer[] = [];
      for await (const part of req) parts.push(Buffer.from(part));
      tokenRequest = { auth: req.headers.authorization, form: new URLSearchParams(Buffer.concat(parts).toString()) };
      lastIdToken = await new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: jwk.kid })
        .setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
      res.end(JSON.stringify({ id_token: lastIdToken }));
    } else {
      res.writeHead(404).end();
    }
  });
  provider = fixture.server;
  issuer = fixture.url;
});

beforeEach(() => {
  discoveredIssuer = issuer;
  claims = { iss: issuer, aud: clientId, sub: "person-at-provider", nonce: tx.nonce, name: "Mara" };
  lastIdToken = "";
  tokenRequest = undefined;
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const store = PgNativeSessionStore.prototype;
  jest.spyOn(store, "startSignIn").mockResolvedValue(tx);
  jest.spyOn(store, "claimSignIn").mockImplementation(async input => input.browserBinding === tx.browserBinding
    ? { status: "claimed", issuer, clientId, redirectUri: editor + "/auth/native/callback", transactionId: tx.transactionId,
      codeVerifier: verifier, claimToken, nonce: tx.nonce, expiresAt: tx.expiresAt }
    : { status: "unavailable" });
  jest.spyOn(store, "completeSignIn").mockResolvedValue({ status: "issued", personId: "mara", sessionId: "session",
    sessionToken, expiresAt: tx.expiresAt });
  jest.spyOn(store, "abandonSignIn").mockResolvedValue(undefined);
});

afterEach(async () => {
  await close(authority);
  authority = undefined;
  const log = JSON.stringify(warn.mock.calls);
  for (const secret of [code, tx.state, tx.nonce, tx.browserBinding, verifier, claimToken, lastIdToken, sessionToken, clientSecret]) {
    if (secret) expect(log).not.toContain(secret);
  }
});
afterAll(async () => close(provider));

async function mount(secret?: string) {
  const route = nativeBrowserRoutes({} as Sql, { MUTINYBIM_OIDC_ISSUER: issuer, MUTINYBIM_OIDC_CLIENT_ID: clientId,
    MUTINYBIM_EDITOR_ORIGIN: editor, MUTINYBIM_OIDC_CLIENT_SECRET: secret }, true)!;
  const fixture = await listen((req, res) => void route(req, res, req.url!));
  authority = fixture.server;
  origin = fixture.url;
}

function post(path: "start" | "finish", headers: Record<string, string> = {}) {
  return fetch(origin + "/auth/native/" + path, { method: "POST",
    headers: { origin: editor, "content-type": "application/json", ...headers }, body: JSON.stringify(path === "start" ? {} : callback) });
}

function failure(stage: string) {
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toBe("[bim-authority] native sign-in failed");
  return expect(JSON.parse(warn.mock.calls[0][1])).toMatchObject({ stage });
}

it("starts a browser-bound sign-in with the registered callback and PKCE", async () => {
  await mount();
  const response = await post("start");
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toBe(cookie + "; Max-Age=300; Path=/auth/native/finish; HttpOnly; SameSite=Strict");
  const body = await response.json();
  expect(body.transactionId).toBe(tx.transactionId);
  const url = new URL(body.authorizationUrl);
  expect(url.origin + url.pathname).toBe(issuer + "/authorize");
  expect(Object.fromEntries(url.searchParams)).toMatchObject({ state: tx.state, nonce: tx.nonce, client_id: clientId,
    code_challenge: tx.codeChallenge, code_challenge_method: "S256", redirect_uri: editor + "/auth/native/callback" });
  expect(warn).not.toHaveBeenCalled();
});

it.each([false, true])("finishes using a verified identity (confidential client %s)", async confidential => {
  await mount(confidential ? clientSecret : undefined);
  if (confidential) { delete claims.name; claims.preferred_username = "Mara Plant"; }
  const result = await post("finish", { cookie });
  expect(result.status).toBe(200);
  const displayName = confidential ? "Mara Plant" : "Mara";
  expect(await result.json()).toMatchObject({ token: sessionToken, userId: "mara", displayName });
  expect(PgNativeSessionStore.prototype.completeSignIn).toHaveBeenCalledWith({ transactionId: tx.transactionId, claimToken,
    identity: { issuer, subject: "person-at-provider", displayName } });
  expect(tokenRequest?.form.get("code_verifier")).toBe(verifier);
  expect(tokenRequest?.form.get("client_id")).toBe(confidential ? null : clientId);
  const basic = Buffer.from("east+plant%3Aeditor:test%3Aclient%2Bsecret").toString("base64");
  expect(tokenRequest?.auth).toBe(confidential ? "Basic " + basic : undefined);
  expect(warn).not.toHaveBeenCalled();
});

it.each([{ nonce: "different-transaction" }, { aud: "different-client" }, { aud: [clientId, "other-client"] }])(
  "declines an identity with mismatched claims %#", async mismatch => {
    Object.assign(claims, mismatch);
    await mount();
    expect((await post("finish", { cookie })).status).toBe(401);
    expect(PgNativeSessionStore.prototype.completeSignIn).not.toHaveBeenCalled();
    expect(PgNativeSessionStore.prototype.abandonSignIn).toHaveBeenCalledTimes(1);
    failure("exchange");
  });

it("reports a different discovery issuer without starting a session", async () => {
  discoveredIssuer += "/";
  await mount();
  expect((await post("start")).status).toBe(503);
  expect(PgNativeSessionStore.prototype.startSignIn).not.toHaveBeenCalled();
  failure("start");
  expect(warn.mock.calls[0][1]).toContain("discovery issuer");
});

it("guides a browser opened at a different origin to the configured editor", async () => {
  await mount();
  const response = await post("start", { origin: "http://localhost:3095" });
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "Open the editor at " + editor + " to sign in." });
  expect(PgNativeSessionStore.prototype.startSignIn).not.toHaveBeenCalled();
  failure("origin");
  expect(JSON.parse(warn.mock.calls[0][1])).toMatchObject({ expected: editor, received: "http://localhost:3095" });
});

it("keeps an unexpected upstream exception's contents out of operator logs", async () => {
  jest.mocked(PgNativeSessionStore.prototype.startSignIn).mockRejectedValue(new Error("upstream detail " + tx.state));
  await mount();
  expect((await post("start")).status).toBe(503);
  failure("start");
});

it.each(["", cookie + "; " + cookie])("requires exactly one binding cookie for this transaction %#", async value => {
  await mount();
  const response = await post("finish", { cookie: value });
  expect(response.status).toBe(400);
  expect(PgNativeSessionStore.prototype.claimSignIn).toHaveBeenCalledWith({ state: tx.state, browserBinding: "" });
  expect(PgNativeSessionStore.prototype.completeSignIn).not.toHaveBeenCalled();
  failure("claim");
});

it("accepts application/json content-type with charset parameters", async () => {
  await mount();
  const response = await post("start", { "content-type": "Application/JSON; charset=utf-8" });
  expect(response.status).toBe(200);
  expect(PgNativeSessionStore.prototype.startSignIn).toHaveBeenCalledTimes(1);
});
