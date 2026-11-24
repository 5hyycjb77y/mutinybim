/**
 * @jest-environment node
 *
 * Supabase Auth (email + Google PKCE + self-service password reset),
 * Postgres PostgREST/RPC metadata store, Fly-Client-IP rate limiting,
 * and signup/login provider ordering.
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createApp, type App } from "../src/app";
import type { WebConfig } from "../src/config";
import { openSupabaseStore } from "../src/db-supabase";
import { openDb } from "../src/db";
import { migrateSqliteToSupabase } from "../src/migrate-sqlite";
import type { Fetch } from "../src/oauth";
import { hashPassword } from "../src/secrets";

const SUPABASE_URL = "https://example-project.supabase.co";
const PUBLISHABLE_KEY = "test-publishable-key";
const SECRET_KEY = "test-secret-key";

let dataDir = "";
let app: App | null = null;
let base = "";

function makeConfig(port: number, extra: Partial<WebConfig> = {}): WebConfig {
  return {
    port,
    host: "127.0.0.1",
    origin: `http://127.0.0.1:${port}`,
    dataDir,
    modelLimit: 5,
    signupOpen: true,
    providers: [],
    quote: null,
    secure: false,
    supabase: { url: SUPABASE_URL, publishableKey: PUBLISHABLE_KEY, google: true },
    trustProxy: false,
    ...extra,
  };
}

async function start(extra: Partial<WebConfig> = {}, fetchImpl?: Fetch): Promise<void> {
  app = createApp(makeConfig(0, extra), { editor: false, ...(fetchImpl ? { fetchImpl } : {}) });
  await app.listen();
  const address = app.server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
  await app.close();
  app = createApp(makeConfig(address.port, extra), { editor: false, ...(fetchImpl ? { fetchImpl } : {}) });
  await app.listen();
}

function cookieMap(response: Response): Map<string, string> {
  const out = new Map<string, string>();
  const list = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie") ?? ""];
  for (const raw of list) {
    const first = raw.split(";")[0] ?? "";
    const eq = first.indexOf("=");
    if (eq > 0) out.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
  return out;
}

function post(pathname: string, fields: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base, ...headers },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "mutinybim-web-sb-"));
});

afterEach(async () => {
  await app?.close();
  app = null;
  rmSync(dataDir, { recursive: true, force: true });
});

test("signup & login put Continue with Google at top and move organization providers below email form", async () => {
  await start({
    providers: [{ id: "org", label: "Log in with ExampleOrg", issuer: "https://org.example.test" }],
  });

  const signupHtml = await (await fetch(`${base}/signup`)).text();
  const googleAt = signupHtml.indexOf("Continue with Google");
  const emailFormAt = signupHtml.indexOf('action="/signup"');
  const orgAt = signupHtml.indexOf("Log in with ExampleOrg");
  expect(googleAt).toBeGreaterThan(0);
  expect(emailFormAt).toBeGreaterThan(googleAt);
  expect(orgAt).toBeGreaterThan(emailFormAt);
  expect(signupHtml).toContain("Already have an organization account?");

  const loginHtml = await (await fetch(`${base}/login`)).text();
  expect(loginHtml.indexOf("Continue with Google")).toBeLessThan(loginHtml.indexOf('action="/login"'));
  expect(loginHtml.indexOf('action="/login"')).toBeLessThan(loginHtml.indexOf("Log in with ExampleOrg"));
});

test("Fly-Client-IP separates rate-limit buckets only when trustProxy is enabled", async () => {
  await start({ supabase: null, trustProxy: true });
  for (let i = 0; i < 20; i += 1) {
    const res = await post("/login", { email: "nobody@example.com", password: "wrong-password" }, { "fly-client-ip": "198.51.100.10" });
    expect(res.status).toBe(401);
  }
  const blocked = await post("/login", { email: "nobody@example.com", password: "wrong-password" }, { "fly-client-ip": "198.51.100.10" });
  expect(blocked.status).toBe(429);
  const otherClient = await post("/login", { email: "nobody@example.com", password: "wrong-password" }, { "fly-client-ip": "203.0.113.25" });
  expect(otherClient.status).toBe(401);

  // Without trustProxy, spoofed Fly-Client-IP headers share the socket IP bucket.
  await app?.close();
  await start({ supabase: null, trustProxy: false });
  for (let i = 0; i < 20; i += 1) {
    const res = await post("/login", { email: "nobody@example.com", password: "wrong-password" }, { "fly-client-ip": `198.51.100.${i + 1}` });
    expect(res.status).toBe(401);
  }
  const spoofBlocked = await post("/login", { email: "nobody@example.com", password: "wrong-password" }, { "fly-client-ip": "198.51.100.99" });
  expect(spoofBlocked.status).toBe(429);
});

test("Supabase Auth: Google OAuth PKCE sign-in creates account, sets session, and marks Google linked in settings", async () => {
  let exchangedVerifier = "";
  const fetchImpl: Fetch = async (input, init) => {
    const url = String(input);
    if (url === `${SUPABASE_URL}/auth/v1/token?grant_type=pkce`) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { auth_code?: string; code_verifier?: string };
      expect(body.auth_code).toBe("google-pkce-code");
      exchangedVerifier = body.code_verifier ?? "";
      expect(exchangedVerifier.length).toBeGreaterThanOrEqual(43);
      return Response.json({
        access_token: "sb-access-google",
        refresh_token: "sb-refresh-google",
        user: {
          id: "00000000-0000-4000-8000-000000000101",
          email: "ada@example.com",
          email_confirmed_at: "2026-11-24T00:00:00Z",
          user_metadata: { full_name: "Ada Lovelace" },
          app_metadata: { provider: "google", providers: ["google"] },
        },
      });
    }
    return new Response("unexpected", { status: 404 });
  };

  await start({}, fetchImpl);
  const begin = await fetch(`${base}/auth/supabase/google/start?return_to=%2Fmodels`, { redirect: "manual" });
  expect(begin.status).toBe(303);
  const redirectUrl = new URL(begin.headers.get("location") ?? "");
  expect(`${redirectUrl.origin}${redirectUrl.pathname}`).toBe(`${SUPABASE_URL}/auth/v1/authorize`);
  expect(redirectUrl.searchParams.get("provider")).toBe("google");
  expect(redirectUrl.searchParams.get("redirect_to")).toBe(`${base}/auth/supabase/callback`);
  expect(redirectUrl.searchParams.get("code_challenge_method")).toBe("s256");

  const pkceCookie = cookieMap(begin).get("mutinybim_sb_pkce");
  expect(pkceCookie).toBeTruthy();

  const done = await fetch(`${base}/auth/supabase/callback?code=google-pkce-code`, {
    headers: { cookie: `mutinybim_sb_pkce=${pkceCookie}` },
    redirect: "manual",
  });
  expect(done.status).toBe(303);
  expect(done.headers.get("location")).toBe("/models?welcome=1");
  const session = cookieMap(done).get("mutinybim_session");
  expect(session).toBeTruthy();

  const settings = await (await fetch(`${base}/settings`, { headers: { cookie: `mutinybim_session=${session}` } })).text();
  expect(settings).toContain("Ada Lovelace");
  expect(settings).toContain("Google");
  expect(settings).toContain("Linked");
});

test("Supabase Auth: email signup confirmation, duplicate detection, login, legacy fallback, and password reset", async () => {
  let updatedPassword = "";
  const fetchImpl: Fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/signup`)) {
      if (body.email === "taken@example.com") {
        return Response.json({ id: "00000000-0000-4000-8000-000000000200", email: "taken@example.com", identities: [] });
      }
      return Response.json({
        id: "00000000-0000-4000-8000-000000000201",
        email: body.email,
        user_metadata: body.data,
        identities: [{ id: "id-1" }],
      });
    }
    if (url === `${SUPABASE_URL}/auth/v1/token?grant_type=password`) {
      if (body.email === "unconfirmed@example.com") {
        return Response.json({ error_code: "email_not_confirmed", msg: "Email not confirmed" }, { status: 400 });
      }
      if (body.email === "sam@example.com" && body.password === "correct-horse") {
        return Response.json({
          access_token: "sb-access-sam",
          user: { id: "00000000-0000-4000-8000-000000000201", email: "sam@example.com", email_confirmed_at: "2026-11-24T00:00:00Z", user_metadata: { display_name: "Sam" } },
        });
      }
      return Response.json({ error_code: "invalid_credentials", msg: "Invalid login credentials" }, { status: 400 });
    }
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/recover`)) {
      return Response.json({});
    }
    if (url === `${SUPABASE_URL}/auth/v1/token?grant_type=pkce`) {
      return Response.json({
        access_token: "sb-recovery-access",
        user: { id: "00000000-0000-4000-8000-000000000201", email: "sam@example.com", email_confirmed_at: "2026-11-24T00:00:00Z", user_metadata: { display_name: "Sam" } },
      });
    }
    if (url === `${SUPABASE_URL}/auth/v1/user` && init?.method === "PUT") {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer sb-recovery-access");
      updatedPassword = String(body.password ?? "");
      return Response.json({ id: "00000000-0000-4000-8000-000000000201", email: "sam@example.com", user_metadata: { display_name: "Sam" } });
    }
    return new Response("unexpected", { status: 404 });
  };

  await start({}, fetchImpl);

  // Duplicate email (empty identities array) returns 409.
  const dup = await post("/signup", { name: "Taken", email: "taken@example.com", password: "correct-horse", agree: "1" });
  expect(dup.status).toBe(409);

  // Confirmation-pending signup shows clear inbox instructions.
  const pending = await post("/signup", { name: "Sam", email: "sam@example.com", password: "correct-horse", agree: "1" });
  expect(pending.status).toBe(200);
  expect(await pending.text()).toContain("Check your email");

  // Unconfirmed login explains why cleanly.
  const unconfirmed = await post("/login", { email: "unconfirmed@example.com", password: "correct-horse" });
  expect(unconfirmed.status).toBe(401);
  expect(await unconfirmed.text()).toContain("Confirm your email first");

  // Valid Supabase login succeeds.
  const loggedIn = await post("/login", { email: "sam@example.com", password: "correct-horse" });
  expect(loggedIn.status).toBe(303);
  const firstSession = cookieMap(loggedIn).get("mutinybim_session");
  expect(firstSession).toBeTruthy();

  // Pre-migration local scrypt user still logs in seamlessly.
  await app?.db.createUser({ id: "legacy-user-1", email: "legacy@example.com", displayName: "Legacy", passwordHash: await hashPassword("legacy-pass-1") });
  const legacyLogin = await post("/login", { email: "legacy@example.com", password: "legacy-pass-1" });
  expect(legacyLogin.status).toBe(303);

  // Self-service password reset: /forgot renders email form and completes via /auth/supabase/callback -> /reset-password.
  const forgotHtml = await (await fetch(`${base}/forgot`)).text();
  expect(forgotHtml).toContain("Send reset link");
  const forgotPost = await post("/forgot", { email: "sam@example.com" });
  expect(forgotPost.status).toBe(200);
  const pkce = cookieMap(forgotPost).get("mutinybim_sb_pkce");
  expect(pkce).toBeTruthy();

  const recoveryCb = await fetch(`${base}/auth/supabase/callback?code=recovery-code`, {
    headers: { cookie: `mutinybim_sb_pkce=${pkce}` },
    redirect: "manual",
  });
  expect(recoveryCb.status).toBe(303);
  expect(recoveryCb.headers.get("location")).toBe("/reset-password");
  const recoveryCookies = cookieMap(recoveryCb);
  const recoveryHeader = `mutinybim_session=${recoveryCookies.get("mutinybim_session")}; mutinybim_sb_recovery=${recoveryCookies.get("mutinybim_sb_recovery")}`;

  const resetDone = await post("/reset-password", { password: "brand-new-password" }, { cookie: recoveryHeader });
  expect(resetDone.status).toBe(303);
  expect(resetDone.headers.get("location")).toBe("/models?reset=1");
  expect(updatedPassword).toBe("brand-new-password");
  // Previous session was invalidated.
  expect((await fetch(`${base}/models`, { headers: { cookie: `mutinybim_session=${firstSession}` }, redirect: "manual" })).status).toBe(303);
});

test("openSupabaseStore sends authenticated PostgREST and atomic RPC calls", async () => {
  const seen: { method: string; path: string; body: unknown }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    expect(headers.get("apikey")).toBe(SECRET_KEY);
    expect(headers.get("authorization")).toBe(`Bearer ${SECRET_KEY}`);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    seen.push({ method: init?.method ?? "GET", path: `${url.pathname}${url.search}`, body });
    if (url.pathname === "/rest/v1/users" && init?.method === "POST") {
      return Response.json([{ id: "u-1", email: "sam@example.com", display_name: "Sam", password_hash: null, color_scheme: "system", created_at: "2026-11-24T00:00:00Z" }]);
    }
    if (url.pathname === "/rest/v1/rpc/web_take_oauth_state") {
      return Response.json([{ state: "st-1", provider: "supabase-google", code_verifier: "ver-1", return_to: "/models", created_at: "2026-11-24T00:00:00Z" }]);
    }
    if (url.pathname === "/rest/v1/rpc/web_rotate_assistant_refresh") {
      return Response.json({ status: "reused" });
    }
    return Response.json([]);
  };

  const store = openSupabaseStore({ url: SUPABASE_URL, secretKey: SECRET_KEY, fetchImpl });
  const created = await store.createUser({ id: "u-1", email: "SAM@example.com", displayName: "Sam", passwordHash: null });
  expect(created.email).toBe("sam@example.com");
  const state = await store.takeOAuthState("st-1");
  expect(state).toMatchObject({ state: "st-1", provider: "supabase-google", code_verifier: "ver-1" });
  const rotated = await store.rotateAssistantRefresh("old-hash", "client-1", {
    accessHash: "a",
    accessExpiresAt: new Date(),
    refreshHash: "r",
    refreshExpiresAt: new Date(),
  });
  expect(rotated).toEqual({ reused: true });
  expect(seen.map((s) => s.path.split("?")[0])).toEqual(["/rest/v1/users", "/rest/v1/rpc/web_take_oauth_state", "/rest/v1/rpc/web_rotate_assistant_refresh"]);
});

test("configured provider domains show a dismissible opt-in link prompt on My models only for matching unlinked users", async () => {
  await start({
    supabase: null,
    providers: [{ id: "acme", label: "Log in with Acme", issuer: "https://acme.example.test", domains: ["acme.test"] }],
  });

  const matching = await post("/signup", { name: "Ada", email: "ada@acme.test", password: "correct-horse", agree: "1" });
  const adaCookie = `mutinybim_session=${cookieMap(matching).get("mutinybim_session")}`;

  const first = await (await fetch(`${base}/models`, { headers: { cookie: adaCookie } })).text();
  expect(first).toContain('data-testid="link-prompt-acme"');
  expect(first).toContain("/auth/acme/start?link=1&amp;return_to=%2Fmodels");

  // Non-matching domain sees no prompt.
  const outside = await post("/signup", { name: "Bob", email: "bob@other.test", password: "correct-horse", agree: "1" });
  const bobCookie = `mutinybim_session=${cookieMap(outside).get("mutinybim_session")}`;
  const bobModels = await (await fetch(`${base}/models`, { headers: { cookie: bobCookie } })).text();
  expect(bobModels).not.toContain('data-testid="link-prompt-acme"');

  // Dismissing hides it permanently.
  const dismiss = await post("/auth/acme/link-prompt/dismiss", {}, { cookie: adaCookie });
  expect(dismiss.status).toBe(303);
  const afterDismiss = await (await fetch(`${base}/models`, { headers: { cookie: adaCookie } })).text();
  expect(afterDismiss).not.toContain('data-testid="link-prompt-acme"');
});

test("migrateSqliteToSupabase copies records and remaps foreign keys when an email already exists in Postgres", async () => {
  const sqlitePath = path.join(dataDir, "accounts.sqlite");
  const sqlite = openDb(sqlitePath);
  const legacyUser = await sqlite.createUser({
    id: "00000000-0000-4000-8000-000000000001",
    email: "ada@example.com",
    displayName: "Ada",
    passwordHash: "scrypt$hash",
  });
  await sqlite.createModel({ id: "mdl-1", ownerId: legacyUser.id, name: "Studio" });
  await sqlite.linkIdentity("org", "sub-1", legacyUser.id);
  await sqlite.createSession("tok-hash", legacyUser.id, new Date(Date.now() + 60_000), "password");
  await sqlite.saveOAuthClient("org", "https://app.example.test/auth/org/callback", "cid-1");
  await sqlite.createAgentKey({ id: "ak-1", userId: legacyUser.id, keyHash: "kh-1", label: "CLI", last4: "1234" });
  await sqlite.saveAssistantClient({ clientId: "ac-1", clientName: "Claude", redirectUris: ["https://claude.ai/cb"], kind: "registered" });
  await sqlite.saveLinkedGrant({
    userId: legacyUser.id,
    provider: "org",
    clientId: "cid-1",
    accessCipher: "enc-a",
    refreshCipher: "enc-r",
    accessExpiresAt: new Date(Date.now() + 60_000),
    refreshExpiresAt: new Date(Date.now() + 120_000),
  });
  await sqlite.replaceLinkedModels(legacyUser.id, "org", [{ remoteModelId: "rm-1", remoteProjectId: "rp-1", label: "Tower", canEdit: true, openUrl: "https://org.example.test/m/1" }], () => "lm-1");
  await sqlite.close();

  const posted: { path: string; method: string; body: unknown }[] = [];
  const existingPgId = "00000000-0000-4000-8000-000000009999";
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.pathname === "/rest/v1/users" && method === "GET") {
      return Response.json([{ id: existingPgId, email: "ada@example.com", password_hash: null }]);
    }
    posted.push({ path: url.pathname, method, body });
    return new Response(null, { status: 204 });
  };

  const summary = await migrateSqliteToSupabase({ sqlitePath, supabaseUrl: SUPABASE_URL, secretKey: SECRET_KEY, fetchImpl });
  expect(summary.remappedUsers).toBe(1);
  expect(summary.tables.models).toBe(1);
  expect(summary.tables.identities).toBe(1);
  expect(summary.tables.sessions).toBe(1);
  expect(summary.tables.oauth_clients).toBe(1);
  expect(summary.tables.agent_keys).toBe(1);
  expect(summary.tables.assistant_clients).toBe(1);
  expect(summary.tables.linked_grants).toBe(1);
  expect(summary.tables.linked_models).toBe(1);

  expect(posted.find((p) => p.path === "/rest/v1/sessions")?.body).toEqual([expect.objectContaining({ token_hash: "tok-hash", user_id: existingPgId, via: "password" })]);
  expect(posted.find((p) => p.path === "/rest/v1/oauth_clients")?.body).toEqual([expect.objectContaining({ provider: "org", client_id: "cid-1" })]);
  expect(posted.find((p) => p.path === "/rest/v1/agent_keys")?.body).toEqual([expect.objectContaining({ id: "ak-1", user_id: existingPgId, key_hash: "kh-1", label: "CLI", last4: "1234" })]);
  expect(posted.find((p) => p.path === "/rest/v1/assistant_clients")?.body).toEqual([expect.objectContaining({ client_id: "ac-1", redirect_uris: ["https://claude.ai/cb"] })]);
  expect(posted.find((p) => p.path === "/rest/v1/linked_grants")?.body).toEqual([expect.objectContaining({ user_id: existingPgId, provider: "org", access_cipher: "enc-a", state: "ok" })]);
  expect(posted.find((p) => p.path === "/rest/v1/linked_models")?.body).toEqual([expect.objectContaining({ user_id: existingPgId, remote_model_id: "rm-1", can_edit: true })]);
  const modelPost = posted.find((p) => p.path === "/rest/v1/models");
  expect(modelPost?.body).toEqual([expect.objectContaining({ id: "mdl-1", owner_id: existingPgId, name: "Studio" })]);
  const identityPost = posted.find((p) => p.path === "/rest/v1/identities");
  expect(identityPost?.body).toEqual([expect.objectContaining({ provider: "org", subject: "sub-1", user_id: existingPgId })]);
  const passwordPatch = posted.find((p) => p.path === "/rest/v1/users" && p.method === "PATCH");
  expect(passwordPatch?.body).toEqual({ password_hash: "scrypt$hash" });
});


