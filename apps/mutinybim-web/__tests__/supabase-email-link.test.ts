/**
 * @jest-environment node
 *
 * A Supabase sign-in must not take over an existing MutinyBIM account merely
 * because it uses the same email address. These fakes stand in for Supabase;
 * they do not show what a real project returns, only what the app does with it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createApp, type App } from "../src/app";
import type { WebConfig } from "../src/config";
import { openDb } from "../src/db";
import type { Fetch } from "../src/oauth";
import { hashPassword } from "../src/secrets";
import { exchangePkceCode } from "../src/supabase-auth";

const SUPABASE_URL = "https://example-project.supabase.co";
const BEA = { id: "local-bea", email: "bea@example.test", password: "bea-local-password" };
const STRANGER_ID = "00000000-0000-4000-8000-0000000000aa";

let dataDir = "";
let app: App | null = null;
let base = "";

function config(port: number): WebConfig {
  return {
    port, host: "127.0.0.1", origin: `http://127.0.0.1:${port}`, dataDir, modelLimit: 5, signupOpen: true,
    providers: [], quote: null, secure: false, trustProxy: false,
    supabase: { url: SUPABASE_URL, publishableKey: "test-publishable-key", google: true },
  };
}

async function start(fetchImpl: Fetch): Promise<void> {
  app = createApp(config(0), { editor: false, fetchImpl });
  await app.listen();
  const port = (app.server.address() as AddressInfo).port;
  await app.close();
  app = createApp(config(port), { editor: false, fetchImpl });
  await app.listen();
  base = `http://127.0.0.1:${port}`;
  // Bea's account predates Supabase sign-in on this server: no Supabase identity yet.
  await app.db.createUser({ id: BEA.id, email: BEA.email, displayName: "Bea Example", passwordHash: await hashPassword(BEA.password) });
}

function sessionOf(response: Response): string | null {
  const list = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie") ?? ""];
  const raw = list.find((c) => c.startsWith("mutinybim_session="));
  return raw ? (raw.split(";")[0] ?? null) : null;
}

function post(pathname: string, fields: Record<string, string>, cookie = ""): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base, ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
}

/** Supabase as a project with "Confirm email" off: it confirms any address at sign-up. */
function strangerUser(confirmed: string | null, provider = "email") {
  return { id: STRANGER_ID, email: BEA.email, email_confirmed_at: confirmed, user_metadata: { display_name: "Not Bea" },
    app_metadata: { provider, providers: [provider] } };
}

async function whoIsSignedIn(session: string | null): Promise<string | null> {
  if (!session) return null;
  const page = await (await fetch(`${base}/settings`, { headers: { cookie: session }, redirect: "manual" })).text();
  return page.includes("Bea Example") ? "Bea's account" : "another account";
}

beforeEach(() => { dataDir = mkdtempSync(path.join(os.tmpdir(), "mutinybim-web-link-")); });
afterEach(async () => { await app?.close(); app = null; rmSync(dataDir, { recursive: true, force: true }); });

const AUTOCONFIRMED = "2026-11-26T12:00:00Z";

function beaGoogleUser() {
  return {
    ...strangerUser(AUTOCONFIRMED, "google"), id: "00000000-0000-4000-8000-0000000000bb",
    identities: [{ provider: "google", identity_data: { email: BEA.email.toUpperCase(), email_verified: true } }],
  };
}

test.each([
  ["confirmed automatically (Confirm email off)", AUTOCONFIRMED],
  ["not confirmed", null],
])("a stranger's Supabase sign-up with Bea's address, %s, does not open Bea's account", async (_label, confirmed) => {
  await start(async (input) => {
    if (String(input).startsWith(`${SUPABASE_URL}/auth/v1/signup`)) {
      return Response.json({ access_token: "sb-access-stranger", refresh_token: "r", user: strangerUser(confirmed) });
    }
    return new Response("unexpected", { status: 404 });
  });
  const reply = await post("/signup", { name: "Not Bea", email: BEA.email, password: "stranger-password", agree: "1" });
  expect(await whoIsSignedIn(sessionOf(reply))).not.toBe("Bea's account");
  expect(await app?.db.identitiesOf(BEA.id)).toEqual([]);
});

test("a stranger's Supabase password sign-in with Bea's address does not open Bea's account", async () => {
  await start(async (input) => {
    if (String(input) === `${SUPABASE_URL}/auth/v1/token?grant_type=password`) {
      return Response.json({ access_token: "sb-access-stranger", user: strangerUser(AUTOCONFIRMED) });
    }
    return new Response("unexpected", { status: 404 });
  });
  const reply = await post("/login", { email: BEA.email, password: "stranger-password" });
  expect(await whoIsSignedIn(sessionOf(reply))).not.toBe("Bea's account");
  expect(await app?.db.identitiesOf(BEA.id)).toEqual([]);
});

test("Bea can still sign in with her original password after a refused takeover", async () => {
  await start(async (input) => {
    const url = String(input);
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/signup`)) {
      return Response.json({ access_token: "sb-access-stranger", refresh_token: "r", user: strangerUser(AUTOCONFIRMED) });
    }
    if (url === `${SUPABASE_URL}/auth/v1/token?grant_type=password`) {
      return Response.json({ error_code: "invalid_credentials", msg: "Invalid login credentials" }, { status: 400 });
    }
    return new Response("unexpected", { status: 404 });
  });
  await post("/signup", { name: "Not Bea", email: BEA.email, password: "stranger-password", agree: "1" });
  const reply = await post("/login", { email: BEA.email, password: BEA.password });
  expect(reply.status).toBe(303);
  expect(await whoIsSignedIn(sessionOf(reply))).toBe("Bea's account");
});

async function callback(code: string, google: boolean): Promise<Response> {
  const begin = google
    ? await fetch(`${base}/auth/supabase/google/start?return_to=%2Fmodels`, { redirect: "manual" })
    : await post("/signup", { name: "Not Bea", email: "pending@example.test", password: "stranger-password", agree: "1" });
  const list = typeof begin.headers.getSetCookie === "function" ? begin.headers.getSetCookie() : [];
  const pkce = (list.find((c) => c.startsWith("mutinybim_sb_pkce=")) ?? "").split(";")[0] ?? "";
  return fetch(`${base}/auth/supabase/callback?code=${code}`, { headers: { cookie: pkce }, redirect: "manual" });
}

test("an email-confirmation link for Bea's address does not attach to Bea's existing account", async () => {
  await start(async (input) => {
    const url = String(input);
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/signup`)) return Response.json({ id: STRANGER_ID, email: "pending@example.test", identities: [{ id: "i" }] });
    if (url === `${SUPABASE_URL}/auth/v1/token?grant_type=pkce`) return Response.json({ access_token: "sb-access-stranger", user: strangerUser(AUTOCONFIRMED) });
    return new Response("unexpected", { status: 404 });
  });
  const reply = await callback("confirmation-code", false);
  expect(await whoIsSignedIn(sessionOf(reply))).not.toBe("Bea's account");
  expect(await app?.db.identitiesOf(BEA.id)).toEqual([]);
});

test("Bea's own Google sign-in, which proves her address, still attaches to her existing account", async () => {
  await start(async (input) => {
    if (String(input) === `${SUPABASE_URL}/auth/v1/token?grant_type=pkce`) {
      return Response.json({ access_token: "sb-access-bea-google", user: beaGoogleUser() });
    }
    return new Response("unexpected", { status: 404 });
  });
  const reply = await callback("google-code", true);
  expect(await whoIsSignedIn(sessionOf(reply))).toBe("Bea's account");
  expect(await app?.db.identitiesOf(BEA.id)).toEqual(expect.arrayContaining(["google"]));
});

test.each([
  ["phone confirmation only", { email_confirmed_at: null, confirmed_at: AUTOCONFIRMED }],
  ["only the first provider", { app_metadata: { provider: "google" } }],
  ["incomplete provider list", { app_metadata: { providers: ["google", null] } }],
  ["no provider identity", { identities: [] }],
  ["a different provider email", { identities: [{ provider: "google", identity_data: { email: "other@example.test", email_verified: true } }] }],
  ["a non-boolean verification", { identities: [{ provider: "google", identity_data: { email: BEA.email, email_verified: "true" } }] }],
] as const)("the provider response needs specific email evidence for linking (%s)", async (_label, change) => {
  const { user } = await exchangePkceCode(
    { url: SUPABASE_URL, publishableKey: "test-key", google: true },
    { code: "fixture", codeVerifier: "fixture" },
    async () => Response.json({ access_token: "fixture", user: { ...beaGoogleUser(), ...change } }),
  );
  expect(user.emailConfirmed && user.googleVerifiedEmail).toBe(false);
});

test("a competing saved binding cannot start the requested session or attach a Google marker", async () => {
  const google = beaGoogleUser();
  await start(async () => Response.json({ access_token: "fixture", user: google }));
  const store = app!.db;
  await store.createUser({ id: "other-account", email: "other@example.test", displayName: "Other", passwordHash: null });
  const save = store.linkIdentity.bind(store);
  jest.spyOn(store, "linkIdentity").mockImplementationOnce(async (provider, subject, userId) => {
    await save(provider, subject, "other-account");
    await save(provider, subject, userId);
  });

  const reply = await callback("google-code", true);
  expect(reply.status).toBe(409);
  expect(sessionOf(reply)).toBeNull();
  expect((await store.userByIdentity("supabase", google.id))?.id).toBe("other-account");
  expect(await store.userByIdentity("google", google.id)).toBeNull();
});

test("SQLite commits the new account and subject together and preserves previous bindings on retry", async () => {
  const store = openDb(":memory:");
  try {
    const person = { id: "first-subject", email: "first@example.test", displayName: "First" };
    expect(await store.createSupabaseUser(person)).toBe(true);
    expect(await store.createSupabaseUser(person)).toBe(false);
    expect((await store.userByIdentity("supabase", person.id))?.id).toBe(person.id);
    expect(await store.createSupabaseUser({ ...person, id: "another-subject" })).toBe(false);
    expect(await store.userById("another-subject")).toBeNull();

    await store.linkIdentity("supabase", "occupied-subject", person.id);
    expect(await store.createSupabaseUser({ ...person, id: "occupied-subject", email: "another@example.test" })).toBe(false);
    expect(await store.userById("occupied-subject")).toBeNull();
    expect((await store.userByIdentity("supabase", "occupied-subject"))?.id).toBe(person.id);
  } finally {
    await store.close();
  }
});

test("Bea, refused once at Supabase sign-up, still logs in with her own password, while a stranger's Supabase password is refused", async () => {
  // One Supabase user holds Bea's address. It accepts whichever password it was made with.
  let supabasePassword = "";
  await start(async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as { password?: string }) : {};
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/signup`)) {
      supabasePassword = body.password ?? "";
      return Response.json({ access_token: "sb-access", refresh_token: "r", user: strangerUser(AUTOCONFIRMED) });
    }
    if (url === `${SUPABASE_URL}/auth/v1/token?grant_type=password`) {
      return body.password === supabasePassword
        ? Response.json({ access_token: "sb-access", user: strangerUser(AUTOCONFIRMED) })
        : Response.json({ error_code: "invalid_credentials", msg: "Invalid login credentials" }, { status: 400 });
    }
    return new Response("unexpected", { status: 404 });
  });

  // Bea tries Sign up with her own password: refused, nothing attached.
  const signup = await post("/signup", { name: "Bea Example", email: BEA.email, password: BEA.password, agree: "1" });
  expect(signup.status).toBe(409);
  expect(sessionOf(signup)).toBeNull();
  // Supabase now accepts her password too; the app opens her account through its own password, still attaching nothing.
  const bea = await post("/login", { email: BEA.email, password: BEA.password });
  expect(bea.status).toBe(303);
  expect(await whoIsSignedIn(sessionOf(bea))).toBe("Bea's account");
  expect(await app?.db.identitiesOf(BEA.id)).toEqual([]);

  // A stranger who made the Supabase user with their own password gets nothing.
  supabasePassword = "stranger-password";
  const stranger = await post("/login", { email: BEA.email, password: "stranger-password" });
  expect(stranger.status).toBe(409);
  expect(sessionOf(stranger)).toBeNull();
  expect(await app?.db.identitiesOf(BEA.id)).toEqual([]);
});

test("a Google sign-in whose address Google didn't verify does not attach to Bea's existing account", async () => {
  await start(async (input) => {
    if (String(input) === `${SUPABASE_URL}/auth/v1/token?grant_type=pkce`) {
      return Response.json({ access_token: "sb-access-google", user: { ...strangerUser(null, "google"), id: "00000000-0000-4000-8000-0000000000cc" } });
    }
    return new Response("unexpected", { status: 404 });
  });
  const reply = await callback("google-code", true);
  expect(reply.status).toBe(409);
  expect(await whoIsSignedIn(sessionOf(reply))).not.toBe("Bea's account");
  expect(await app?.db.identitiesOf(BEA.id)).toEqual([]);
});

test("a Google sign-in merged into a Supabase user that also has a password does not attach to Bea's existing account", async () => {
  // Supabase merged Bea's Google sign-in into a password user someone else made earlier with her address.
  await start(async (input) => {
    if (String(input) === `${SUPABASE_URL}/auth/v1/token?grant_type=pkce`) {
      const merged = { ...strangerUser(AUTOCONFIRMED), app_metadata: { provider: "email", providers: ["email", "google"] } };
      return Response.json({ access_token: "sb-access-merged", user: merged });
    }
    return new Response("unexpected", { status: 404 });
  });
  const reply = await callback("google-code", true);
  expect(reply.status).toBe(409);
  expect(await whoIsSignedIn(sessionOf(reply))).not.toBe("Bea's account");
  expect(await app?.db.identitiesOf(BEA.id)).toEqual([]);
});
