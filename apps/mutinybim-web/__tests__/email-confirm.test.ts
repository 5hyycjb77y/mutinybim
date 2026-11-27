/**
 * @jest-environment node
 *
 * Where an account's confirmed address comes from (#28): a mailed link opened
 * while logged in to that account, a Google sign-in through Supabase with no
 * password on the Supabase user, or a Supabase sign-up link opened in the
 * browser that chose the password. Supabase replies here are fakes.
 */
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp, type App, type AppOptions } from "../src/app";
import type { WebConfig } from "../src/config";
import type { Mail, Mailer } from "../src/mailer";
import type { Fetch } from "../src/oauth";
import { openSupabaseStore } from "../src/db-supabase";
import { digest } from "../src/secrets";

const SUPABASE_URL = "https://example-project.supabase.co";
let dataDir = "";
let app: App | null = null;
let base = "";

async function start(extra: Partial<WebConfig> = {}, more: AppOptions = {}): Promise<void> {
  const config = (port: number): WebConfig => ({ port, host: "127.0.0.1", origin: `http://127.0.0.1:${port}`, dataDir, modelLimit: 3, signupOpen: true, providers: [], quote: null, secure: false, ...extra });
  const probe = createApp(config(0), { editor: false, ...more });
  await probe.listen();
  const port = (probe.server.address() as AddressInfo).port;
  await probe.close();
  app = createApp(config(port), { editor: false, ...more });
  await app.listen();
  base = `http://127.0.0.1:${port}`;
}

function recordingMailer(): Mailer & { readonly sent: Mail[] } {
  const sent: Mail[] = [];
  return { sent, async send(mail) { sent.push(mail); } };
}

function post(pathname: string, form: Record<string, string>, cookie = ""): Promise<Response> {
  return fetch(`${base}${pathname}`, { method: "POST", redirect: "manual", headers: { origin: base, cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
}

function get(pathname: string, cookie = ""): Promise<Response> {
  return fetch(`${base}${pathname}`, { redirect: "manual", headers: { cookie } });
}

function sessionCookie(response: Response): string {
  const list = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie") ?? ""];
  const raw = list.find((c) => c.startsWith("mutinybim_session="));
  if (!raw) throw new Error("no session cookie");
  return raw.split(";")[0] ?? "";
}

async function signUp(email: string, name: string): Promise<string> {
  const response = await post("/signup", { name, email, password: "correct-horse" });
  expect(response.status).toBe(303);
  return sessionCookie(response);
}

function confirmToken(mail: Mail | undefined): string {
  const token = mail?.text.match(new RegExp(`^${base.replace(/\./g, "\\.")}/confirm/([A-Za-z0-9_-]{20,80})$`, "m"))?.[1];
  if (!token) throw new Error("the email held no confirmation link for this server");
  return token;
}

async function confirmedAt(email: string): Promise<string | null | undefined> {
  return (await app?.db.userByEmail(email))?.email_confirmed_at;
}

function sqlite(): DatabaseSync {
  return new DatabaseSync(path.join(dataDir, "accounts.sqlite"));
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "mutinybim-web-confirm-"));
});
afterEach(async () => {
  jest.useRealTimers();
  await app?.close();
  app = null;
  await rm(dataDir, { recursive: true, force: true });
});

describe("a mailed confirmation link", () => {
  test("confirms the address only for its own account, while logged in to it, once", async () => {
    const mailer = recordingMailer();
    const logs = [jest.spyOn(console, "log"), jest.spyOn(console, "error")];
    await start({}, { mailer });
    const bea = await signUp("bea@example.test", "Bea Example");
    const pat = await signUp("pat@example.test", "Pat Example");

    const before = await (await get("/settings", bea)).text();
    expect(before).toContain('data-testid="email-unconfirmed"');
    expect(before).toContain("Send confirmation link");
    const asked = await post("/settings/confirm-email", {}, bea);
    expect(asked.status).toBe(200);
    expect(await asked.text()).toContain("Check bea@example.test for your confirmation link.");
    await app?.settled();
    expect(mailer.sent).toEqual([expect.objectContaining({ to: "bea@example.test", purpose: "confirm", subject: "Confirm your email for MutinyBIM" })]);
    const token = confirmToken(mailer.sent[0]);

    // Only a digest is kept, with the address, for 24 hours.
    const db = sqlite();
    const rows = db.prepare("SELECT token_hash, email, created_at, expires_at FROM email_confirmations").all() as { token_hash: string; email: string; created_at: string; expires_at: string }[];
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ token_hash: digest(token), email: "bea@example.test" });
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(Date.parse(rows[0]?.expires_at ?? "") - Date.parse(rows[0]?.created_at ?? "")).toBeGreaterThanOrEqual(24 * 3_600_000 - 1_000);

    // Signed out: sent to log in first, nothing used up.
    const signedOut = await get(`/confirm/${token}`);
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("location")).toBe(`/login?return_to=${encodeURIComponent(`/confirm/${token}`)}`);

    // Another account can't use it, and doesn't use it up.
    expect((await post(`/confirm/${token}`, {}, pat)).status).toBe(410);
    expect(await confirmedAt("bea@example.test")).toBeNull();
    expect(await confirmedAt("pat@example.test")).toBeNull();

    // Bea, logged in: a page with one button, then confirmed.
    const page = await get(`/confirm/${token}`, bea);
    expect(page.status).toBe(200);
    expect(page.headers.get("referrer-policy")).toBe("strict-origin");
    expect(await page.text()).toContain("Confirm bea@example.test");
    expect(await confirmedAt("bea@example.test")).toBeNull();
    const done = await post(`/confirm/${token}`, {}, bea);
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/settings?confirmed=1");
    expect(await confirmedAt("bea@example.test")).toEqual(expect.any(String));
    const after = await (await get("/settings?confirmed=1", bea)).text();
    expect(after).toContain('data-testid="email-confirmed"');
    expect(after).toContain("Your email is confirmed.");
    expect(after).not.toContain("Send confirmation link");

    // Spent.
    expect((await post(`/confirm/${token}`, {}, bea)).status).toBe(410);
    const logged = logs.flatMap((spy) => spy.mock.calls).map((call) => JSON.stringify(call)).join("\n");
    expect(logged).not.toContain(token);
  });

  test("a failed resend leaves the previously delivered link usable", async () => {
    const mailer = recordingMailer();
    await start({}, { mailer });
    const bea = await signUp("bea@example.test", "Bea Example");
    await post("/settings/confirm-email", {}, bea);
    await app?.settled();
    jest.spyOn(mailer, "send").mockRejectedValueOnce(new Error("SMTP unavailable"));
    await post("/settings/confirm-email", {}, bea);
    await app?.settled();
    expect((await post(`/confirm/${confirmToken(mailer.sent[0])}`, {}, bea)).status).toBe(303);
  });

  test("a storage failure on the confirmation page logs no token", async () => {
    const mailer = recordingMailer();
    await start({}, { mailer });
    const bea = await signUp("bea@example.test", "Bea Example");
    await post("/settings/confirm-email", {}, bea);
    await app?.settled();
    const token = confirmToken(mailer.sent[0]);
    const log = jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(app!.db, "redeemEmailConfirmation").mockRejectedValueOnce(new Error("Store unavailable"));
    expect((await post(`/confirm/${token}`, {}, bea)).status).toBe(500);
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(token);
  });

  test("stops working after a day", async () => {
    const mailer = recordingMailer();
    await start({}, { mailer });
    const bea = await signUp("bea@example.test", "Bea Example");
    const startAt = Date.now();
    jest.useFakeTimers({ now: startAt, doNotFake: ["hrtime", "nextTick", "performance", "queueMicrotask", "setImmediate", "clearImmediate", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    await post("/settings/confirm-email", {}, bea);
    await app?.settled();
    jest.setSystemTime(startAt + 25 * 3_600_000);
    expect((await post(`/confirm/${confirmToken(mailer.sent[0])}`, {}, bea)).status).toBe(410);
    expect(await confirmedAt("bea@example.test")).toBeNull();
  });

  test("sent to an earlier address confirms nothing", async () => {
    const mailer = recordingMailer();
    await start({}, { mailer });
    const bea = await signUp("bea@example.test", "Bea Example");
    await post("/settings/confirm-email", {}, bea);
    await app?.settled();
    const db = sqlite();
    db.prepare("UPDATE users SET email = ? WHERE email = ?").run("bea.new@example.test", "bea@example.test");
    db.close();
    expect((await post(`/confirm/${confirmToken(mailer.sent[0])}`, {}, bea)).status).toBe(410);
    expect(await confirmedAt("bea.new@example.test")).toBeNull();
  });

  test("goes out at most three times an hour per address", async () => {
    const mailer = recordingMailer();
    await start({}, { mailer });
    const bea = await signUp("bea@example.test", "Bea Example");
    for (let i = 0; i < 5; i += 1) expect((await post("/settings/confirm-email", {}, bea)).status).toBe(200);
    await app?.settled();
    expect(mailer.sent).toHaveLength(3);
    // The last link sent is the one that works.
    expect((await post(`/confirm/${confirmToken(mailer.sent[2])}`, {}, bea)).status).toBe(303);
  });

  test("isn't offered when this server sends no email", async () => {
    await start({}, { mailer: null });
    const bea = await signUp("bea@example.test", "Bea Example");
    const page = await (await get("/settings", bea)).text();
    expect(page).toContain("This server sends no email.");
    expect(page).not.toContain("Send confirmation link");
    expect((await post("/settings/confirm-email", {}, bea)).status).toBe(404);
  });
});

describe("confirmation from Supabase sign-in", () => {
  const supabase = { url: SUPABASE_URL, publishableKey: "test-publishable-key", google: true };
  const confirmedAtSupabase = "2026-11-26T12:00:00Z";
  test("mailed confirmation for a Supabase password account requires a password session", async () => {
    const mailer = recordingMailer();
    await start({ supabase }, { mailer });
    const db = app!.db;
    const id = "00000000-0000-4000-8000-000000000009";
    const email = "reauth@example.test";
    await db.createSupabaseUser({ id, email, displayName: "Reauth" });
    const until = new Date(Date.now() + 60_000);
    await db.createSession(digest("password-session"), id, until, "password");
    await db.createSession(digest("email-session"), id, until, "supabase");
    const passwordSession = "mutinybim_session=password-session";
    const emailSession = "mutinybim_session=email-session";
    expect((await post("/settings/confirm-email", {}, emailSession)).status).toBe(403);
    expect((await post("/settings/confirm-email", {}, passwordSession)).status).toBe(200);
    await app?.settled();
    expect(mailer.sent).toHaveLength(1);
    const pathname = `/confirm/${confirmToken(mailer.sent[0])}`;
    expect((await post(pathname, {}, emailSession)).status).toBe(403);
    expect(await confirmedAt(email)).toBeNull();
    expect((await post(pathname, {}, passwordSession)).status).toBe(303);
    expect(await confirmedAt(email)).toEqual(expect.any(String));
  });

  const sbUser = (id: string, email: string, providers: string[], confirmed: string | null = confirmedAtSupabase, googleVerified = true) => ({
    id, email, email_confirmed_at: confirmed, user_metadata: { display_name: "Sam" }, app_metadata: { provider: providers[0], providers },
    identities: providers.map((provider) => ({ provider, identity_data: provider === "google" ? { email, email_verified: googleVerified } : { email } })),
  });

  /** Starts a flow that sets the PKCE cookie, then opens the callback with a code. */
  async function pkceCallback(begin: Response, code: string): Promise<Response> {
    const list = typeof begin.headers.getSetCookie === "function" ? begin.headers.getSetCookie() : [];
    const pkce = (list.find((c) => c.startsWith("mutinybim_sb_pkce=")) ?? "").split(";")[0] ?? "";
    return fetch(`${base}/auth/supabase/callback?code=${code}`, { headers: { cookie: pkce }, redirect: "manual" });
  }

  test.each([
    ["Google, with no password on the Supabase user", ["google"], true, true],
    ["Google merged into a Supabase user that also has a password", ["email", "google"], true, false],
    ["Google that doesn't vouch for this address", ["google"], false, false],
  ])("%s", async (_label, providers, googleVerified, confirmed) => {
    const fetchImpl: Fetch = async (input) => {
      if (String(input) === `${SUPABASE_URL}/auth/v1/token?grant_type=pkce`) return Response.json({ access_token: "a", user: sbUser("00000000-0000-4000-8000-000000000001", "sam@example.test", providers, confirmedAtSupabase, googleVerified) });
      return new Response("unexpected", { status: 404 });
    };
    await start({ supabase }, { fetchImpl });
    const reply = await pkceCallback(await fetch(`${base}/auth/supabase/google/start?return_to=%2Fmodels`, { redirect: "manual" }), "google-code");
    expect(reply.status).toBe(303);
    expect(Boolean(await confirmedAt("sam@example.test"))).toBe(confirmed);
  });

  test("a sign-up link opened in the browser that signed up confirms; the same link opened elsewhere doesn't", async () => {
    const fetchImpl: Fetch = async (input) => {
      const url = String(input);
      if (url.startsWith(`${SUPABASE_URL}/auth/v1/signup`)) return Response.json({ id: "pending", email: "x", identities: [{ id: "i" }] });
      if (url === `${SUPABASE_URL}/auth/v1/token?grant_type=pkce`) return Response.json({ access_token: "a", user: sbUser("00000000-0000-4000-8000-000000000002", "sam@example.test", ["email"]) });
      if (url.startsWith(`${SUPABASE_URL}/auth/v1/verify`)) return Response.json({ access_token: "a", user: sbUser("00000000-0000-4000-8000-000000000003", "pat@example.test", ["email"]) });
      return new Response("unexpected", { status: 404 });
    };
    await start({ supabase }, { fetchImpl });
    const pending = await post("/signup", { name: "Sam", email: "sam@example.test", password: "correct-horse" });
    expect(pending.status).toBe(200);
    expect((await pkceCallback(pending, "signup-code")).status).toBe(303);
    expect(await confirmedAt("sam@example.test")).toEqual(expect.any(String));

    // A token-hash link isn't tied to the browser that chose the password.
    const elsewhere = await fetch(`${base}/auth/supabase/callback?token_hash=hash-from-email&type=signup`, { redirect: "manual" });
    expect(elsewhere.status).toBe(303);
    expect(await app?.db.userByEmail("pat@example.test")).not.toBeNull();
    expect(await confirmedAt("pat@example.test")).toBeNull();
  });

  test("a password sign-up that Supabase confirms on its own (Confirm email off) confirms nothing", async () => {
    const fetchImpl: Fetch = async (input) => {
      if (String(input).startsWith(`${SUPABASE_URL}/auth/v1/signup`)) return Response.json({ access_token: "a", refresh_token: "r", user: sbUser("00000000-0000-4000-8000-000000000004", "sam@example.test", ["email"]) });
      return new Response("unexpected", { status: 404 });
    };
    await start({ supabase }, { fetchImpl });
    expect((await post("/signup", { name: "Sam", email: "sam@example.test", password: "correct-horse" })).status).toBe(303);
    expect(await confirmedAt("sam@example.test")).toBeNull();
  });
});

test("the Supabase store keeps confirmation links through PostgREST and uses them up in one RPC", async () => {
  const seen: { method: string; path: string; body: unknown }[] = [];
  const store = openSupabaseStore({ url: SUPABASE_URL, secretKey: "test-secret", fetchImpl: async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    seen.push({ method: init?.method ?? "GET", path: url.pathname, body });
    if (url.pathname === "/rest/v1/rpc/web_redeem_email_confirmation") return Response.json(body?.p_token_hash === "live-hash");
    return Response.json([]);
  } });
  await store.createEmailConfirmation("live-hash", "u-1", "bea@example.test", new Date("2026-11-27T12:00:00Z"));
  await store.finishEmailConfirmationMail("live-hash", true);
  await store.finishEmailConfirmationMail("failed-hash", false);
  expect(await store.redeemEmailConfirmation("live-hash", "u-1")).toBe(true);
  expect(await store.redeemEmailConfirmation("spent-hash", "u-1")).toBe(false);
  expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
    "POST /rest/v1/rpc/web_stage_email_confirmation",
    "POST /rest/v1/rpc/web_deliver_email_confirmation",
    "DELETE /rest/v1/email_confirmations",
    "POST /rest/v1/rpc/web_redeem_email_confirmation",
    "POST /rest/v1/rpc/web_redeem_email_confirmation",
  ]);
  expect(seen[0]?.body).toEqual({ p_token_hash: "live-hash", p_user_id: "u-1", p_email: "bea@example.test", p_expires_at: "2026-11-27T12:00:00.000Z" });
  expect(seen[1]?.body).toEqual({ p_token_hash: "live-hash" });
  expect(seen[3]?.body).toEqual({ p_token_hash: "live-hash", p_user_id: "u-1" });
});
