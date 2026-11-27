/**
 * @jest-environment node
 *
 * Invitations to a native hosted model (#26, closes #27). The owner names an
 * address and always gets the same reply; nothing is shared until an account
 * whose confirmed address matches accepts, while the inviter still owns the
 * model. With mail off the owner copies a one-time link; with mail on it is
 * emailed. Only the link's digest is kept.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { confirmAddress } from "../__fixtures__/invitation";
import { createApp, type App, type AppOptions } from "../src/app";
import type { WebConfig } from "../src/config";
import { openDb } from "../src/db";
import { openSupabaseStore } from "../src/db-supabase";
import { invitationMail, oneLine, type Mail, type Mailer } from "../src/mailer";
import { migrateSqliteToSupabase } from "../src/migrate-sqlite";
import type { Fetch } from "../src/oauth";
import { digest, hashPassword } from "../src/secrets";

let dataDir = "";
let app: App | null = null;
let base = "";

async function start(extra: Partial<WebConfig> = {}, more: AppOptions = {}): Promise<App> {
  const config = (port: number): WebConfig => ({ port, host: "127.0.0.1", origin: `http://127.0.0.1:${port}`, dataDir, modelLimit: 5, signupOpen: true, providers: [], quote: null, secure: false, ...extra });
  const probe = createApp(config(0), { editor: false, ...more });
  await probe.listen();
  const port = (probe.server.address() as AddressInfo).port;
  await probe.close();
  app = createApp(config(port), { editor: false, ...more });
  await app.listen();
  base = `http://127.0.0.1:${port}`;
  return app;
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

async function signUp(email: string, name: string): Promise<string> {
  const response = await post("/signup", { name, email, password: "correct-horse" });
  expect(response.status).toBe(303);
  const list = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  const raw = list.find((c) => c.startsWith("mutinybim_session="));
  if (!raw) throw new Error("no session cookie");
  return raw.split(";")[0] ?? "";
}

async function makeModel(cookie: string, name: string): Promise<string> {
  const response = await post("/models", { name, start: "blank" }, cookie);
  const id = response.headers.get("location")?.match(/^\/m\/([a-z0-9-]+)/)?.[1];
  if (!id) throw new Error(`making ${name} answered ${response.status}`);
  return id;
}

async function idOf(email: string): Promise<string> {
  const id = (await app?.db.userByEmail(email))?.id;
  if (!id) throw new Error(`no account for ${email}`);
  return id;
}

const LINK = /value="(http:\/\/127\.0\.0\.1:\d+\/invitations\/([A-Za-z0-9_-]{20,80}))"/;

/** The token from a mail-off reply's one-time link. */
function linkToken(page: string): string {
  const token = page.match(LINK)?.[2];
  if (!token) throw new Error("the reply showed no invitation link");
  return token;
}

/** A page with the parts that name the address, model, link or ids replaced, to compare two replies' shape. */
function shape(page: string, ...names: string[]): string {
  let out = page.replace(LINK, 'value="LINK"').replace(/\/invitations\/[A-Za-z0-9_-]{20,80}/g, "/invitations/TOKEN")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "UUID")
    .replace(/expires [^<]+</g, "expires WHEN<");
  for (const n of names) out = out.split(n).join("NAME");
  return out;
}

function rows(sql: string, ...params: string[]): Record<string, unknown>[] {
  const db = new DatabaseSync(path.join(dataDir, "accounts.sqlite"));
  try { return db.prepare(sql).all(...params) as Record<string, unknown>[]; } finally { db.close(); }
}

function exec(sql: string, ...params: string[]): void {
  const db = new DatabaseSync(path.join(dataDir, "accounts.sqlite"));
  try { db.prepare(sql).run(...params); } finally { db.close(); }
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "mutinybim-web-invite-"));
});
afterEach(async () => {
  jest.restoreAllMocks();
  await app?.close();
  app = null;
  await rm(dataDir, { recursive: true, force: true });
});

describe("the owner's reply", () => {
  test("is the same whether or not an account uses the address, and nothing is shared until someone accepts (mail off)", async () => {
    const logs = jest.spyOn(console, "log");
    await start();
    const alex = await signUp("alex@example.test", "Alex");
    await signUp("bea@example.test", "Bea");
    const first = await makeModel(alex, "Plant room");
    const second = await makeModel(alex, "Plant room");

    const known = await post(`/models/${first}/share`, { email: "Bea@Example.test", role: "edit" }, alex);
    const unknown = await post(`/models/${second}/share`, { email: "nobody@example.test", role: "edit" }, alex);
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    const [knownPage, unknownPage] = [await known.text(), await unknown.text()];
    expect(knownPage).toContain("Invitation saved for bea@example.test. Nothing is shared until they accept.");
    expect(knownPage).not.toContain("No MutinyBIM account");
    expect(shape(knownPage, "bea@example.test", first)).toBe(shape(unknownPage, "nobody@example.test", second));

    // Nothing shared; only the link's digest is kept, and nothing logged names the address or link.
    const beaId = await idOf("bea@example.test");
    expect(await app?.db.sharedWith(beaId)).toEqual([]);
    const token = linkToken(knownPage);
    const saved = rows("SELECT * FROM model_invitations WHERE model_id = ?", first);
    expect(saved).toEqual([expect.objectContaining({ email: "bea@example.test", role: "edit", token_hash: digest(token), state: "open" })]);
    expect(JSON.stringify(rows("SELECT * FROM model_invitations"))).not.toContain(token);
    const logged = JSON.stringify(logs.mock.calls);
    expect(logged).not.toContain("bea@example.test");
    expect(logged).not.toContain(token);

    // The link is shown once: the Share page doesn't show it again.
    const again = await (await get(`/models/${first}/share`, alex)).text();
    expect(again).not.toContain(token);
    expect(again).toContain("bea@example.test");
    expect(again).toMatch(/data-testid="invitations"[\s\S]*Can edit/);
  });

  test("with mail on, every address gets the same reply and an email whose link's digest is the only copy kept", async () => {
    const mailer = recordingMailer();
    await start({}, { mailer });
    const alex = await signUp("alex@example.test", "Alex\nBcc: evil@example.test");
    await signUp("bea@example.test", "Bea");
    const first = await makeModel(alex, "Plant room");
    const second = await makeModel(alex, "Plant room");
    const known = await (await post(`/models/${first}/share`, { email: "bea@example.test", role: "view" }, alex)).text();
    const unknown = await (await post(`/models/${second}/share`, { email: "nobody@example.test", role: "view" }, alex)).text();
    expect(known).toContain("Invitation saved. We&#x27;re emailing a link to bea@example.test.");
    expect(known).not.toContain('data-testid="invitation-link"');
    expect(shape(known, "bea@example.test", first)).toBe(shape(unknown, "nobody@example.test", second));

    await app?.settled();
    expect(mailer.sent.map((m) => [m.to, m.purpose, m.subject])).toEqual([
      ["bea@example.test", "invite", "You're invited to a model on MutinyBIM"],
      ["nobody@example.test", "invite", "You're invited to a model on MutinyBIM"],
    ]);
    const mail = mailer.sent[0]?.text ?? "";
    expect(mail).toContain('to view the model "Plant room"');
    expect(mail.split("\n").some((line) => line.startsWith("Bcc:"))).toBe(false);
    const token = mail.match(/\/invitations\/([A-Za-z0-9_-]{20,80})$/m)?.[1] ?? "";
    expect(rows("SELECT token_hash FROM model_invitations WHERE model_id = ?", first)).toEqual([{ token_hash: digest(token) }]);
  });

  test("invitation emails to one address stop at three an hour, and the replies never change", async () => {
    const mailer = recordingMailer();
    await start({}, { mailer });
    const alex = await signUp("alex@example.test", "Alex");
    const id = await makeModel(alex, "Plant room");
    const replies: string[] = [];
    for (let i = 0; i < 4; i++) replies.push(shape(await (await post(`/models/${id}/share`, { email: "bea@example.test", role: "view" }, alex)).text(), id));
    await app?.settled();
    expect(new Set(replies).size).toBe(1);
    expect(mailer.sent).toHaveLength(3);
    // Each new invitation replaced the last, so one stays open.
    expect(rows("SELECT state, count(*) AS n FROM model_invitations GROUP BY state")).toEqual([{ state: "cancelled", n: 3 }, { state: "open", n: 1 }]);
  });

  test("refuses an owner's own address or a malformed one, and someone else's model, a shared editor or a linked alias takes none", async () => {
    const a = await start();
    const alex = await signUp("alex@example.test", "Alex");
    const cam = await signUp("cam@example.test", "Cam");
    const id = await makeModel(alex, "Plant room");
    expect((await post(`/models/${id}/share`, { email: "ALEX@example.test", role: "edit" }, alex)).status).toBe(400);
    expect((await post(`/models/${id}/share`, { email: "two@example.test, three@example.test", role: "edit" }, alex)).status).toBe(400);
    expect((await post(`/models/${id}/share`, { email: "", role: "edit" }, alex)).status).toBe(400);

    const camId = await idOf("cam@example.test");
    await a.db.share({ modelId: id, userId: camId, role: "edit", invitedBy: await idOf("alex@example.test") });
    expect((await post(`/models/${id}/share`, { email: "pat@example.test", role: "edit" }, cam)).status).toBe(403);
    const camsOwn = await makeModel(cam, "Cam's job");
    expect((await post(`/models/${camsOwn}/share`, { email: "pat@example.test", role: "edit" }, alex)).status).toBe(404);

    // A linked host's entry lists under an alias; the hosted invitation and share routes don't know it.
    await a.db.replaceLinkedModels(await idOf("alex@example.test"), "org",
      [{ remoteModelId: "rm-1", remoteProjectId: "rp-1", label: "Tower", canEdit: true, openUrl: "https://org.example.test/m/1" }], () => "lm-tower");
    expect((await post("/models/lm-tower/share", { email: "pat@example.test", role: "edit" }, alex)).status).toBe(404);
    expect((await post(`/models/lm-tower/share/${camId}/role`, { role: "edit" }, alex)).status).toBe(404);
    expect(rows("SELECT * FROM model_invitations")).toEqual([]);
    expect(await a.db.sharesOf("lm-tower")).toEqual([]);
    expect(rows("SELECT * FROM team_shares")).toEqual([]);
    // The native model next to it still takes an invitation.
    expect((await post(`/models/${id}/share`, { email: "pat@example.test", role: "edit" }, alex)).status).toBe(200);
  });
});

describe("answering an invitation", () => {
  test("only a confirmed account with the invited address can accept, once", async () => {
    await start();
    const alex = await signUp("alex@example.test", "Alex");
    const bea = await signUp("bea@example.test", "Bea");
    const pat = await signUp("pat@example.test", "Pat");
    confirmAddress(dataDir, "pat@example.test");
    const id = await makeModel(alex, "East plant");
    const token = linkToken(await (await post(`/models/${id}/share`, { email: "bea@example.test", role: "edit" }, alex)).text());
    const [{ id: invitationId }] = rows("SELECT id FROM model_invitations") as [{ id: string }];
    const beaId = await idOf("bea@example.test");

    // Signed out: sent to log in, and back.
    const signedOut = await get(`/invitations/${token}`);
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("location")).toBe(`/login?return_to=${encodeURIComponent(`/invitations/${token}`)}`);

    // The right address, not yet confirmed: no card, no model name, and no acceptance.
    expect(await (await get("/models", bea)).text()).not.toContain('data-testid="invitation"');
    const unconfirmed = await get(`/invitations/${token}`, bea);
    expect(unconfirmed.status).toBe(200);
    expect(unconfirmed.headers.get("referrer-policy")).toBe("strict-origin");
    const unconfirmedPage = await unconfirmed.text();
    expect(unconfirmedPage).toContain("Confirm your email first");
    expect(unconfirmedPage).not.toContain("East plant");
    expect((await post(`/invitations/${invitationId}/accept`, {}, bea)).status).toBe(410);
    expect((await post(`/invitations/${invitationId}/decline`, {}, bea)).status).toBe(410);

    // A confirmed account with another address, or the owner: nothing about the invitation shows.
    for (const who of [pat, alex]) {
      const other = await get(`/invitations/${token}`, who);
      expect(other.status).toBe(404);
      const page = await other.text();
      expect(page).toContain("This invitation doesn&#x27;t work here");
      expect(page).not.toContain("East plant");
      expect((await post(`/invitations/${invitationId}/accept`, {}, who)).status).toBe(410);
    }
    expect(await app?.db.sharedWith(beaId)).toEqual([]);
    expect(rows("SELECT state FROM model_invitations")).toEqual([{ state: "open" }]);

    // Confirmed: the card and the link both offer it; accepting shares it once.
    confirmAddress(dataDir, "bea@example.test");
    const models = await (await get("/models", bea)).text();
    expect(models).toContain("Join “East plant”?");
    expect(models).toContain("Alex invited bea@example.test to edit this model.");
    expect(await (await get(`/invitations/${token}`, bea)).text()).toContain("Join “East plant”?");
    const accepted = await post(`/invitations/${invitationId}/accept`, {}, bea);
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("location")).toBe(`/models?joined=${encodeURIComponent("East plant")}`);
    expect(await (await get(accepted.headers.get("location") ?? "", bea)).text()).toContain("Accepted. “East plant” is under Shared with you.");
    expect((await app?.db.accessTo(beaId, id))?.access).toBe("edit");
    expect((await post(`/invitations/${invitationId}/accept`, {}, bea)).status).toBe(410);
    expect((await get(`/invitations/${token}`, bea)).status).toBe(404);
    const sharePage = await (await get(`/models/${id}/share`, alex)).text();
    expect(sharePage).toMatch(/data-testid="shares"[\s\S]*Bea/);
    expect(sharePage).toContain("No invitations waiting.");
  });

  test("declining shares nothing and clears the owner's list", async () => {
    await start();
    const alex = await signUp("alex@example.test", "Alex");
    const bea = await signUp("bea@example.test", "Bea");
    confirmAddress(dataDir, "bea@example.test");
    const id = await makeModel(alex, "East plant");
    await post(`/models/${id}/share`, { email: "bea@example.test", role: "view" }, alex);
    const [{ id: invitationId }] = rows("SELECT id FROM model_invitations") as [{ id: string }];
    const declined = await post(`/invitations/${invitationId}/decline`, {}, bea);
    expect(declined.headers.get("location")).toBe("/models?invitation=declined");
    expect(await app?.db.sharedWith(await idOf("bea@example.test"))).toEqual([]);
    expect(await (await get(`/models/${id}/share`, alex)).text()).toContain("No invitations waiting.");
    expect((await post(`/invitations/${invitationId}/accept`, {}, bea)).status).toBe(410);
  });

  test("the owner cancels or replaces an invitation, and an expired one can't be accepted", async () => {
    await start();
    const alex = await signUp("alex@example.test", "Alex");
    const bea = await signUp("bea@example.test", "Bea");
    confirmAddress(dataDir, "bea@example.test");
    const id = await makeModel(alex, "East plant");
    const share = `/models/${id}/share`;

    const old = linkToken(await (await post(share, { email: "bea@example.test", role: "view" }, alex)).text());
    const fresh = linkToken(await (await post(share, { email: "bea@example.test", role: "edit" }, alex)).text());
    expect((await get(`/invitations/${old}`, bea)).status).toBe(404);
    expect(await (await get(`/invitations/${fresh}`, bea)).text()).toContain("to edit this model");
    const open = rows("SELECT id, role FROM model_invitations WHERE state = 'open'");
    expect(open).toEqual([expect.objectContaining({ role: "edit" })]);

    const cancelled = await post(`/models/${id}/invitations/${String(open[0]?.id)}/cancel`, {}, alex);
    expect(await cancelled.text()).toContain("Invitation cancelled. Its link no longer works.");
    expect((await get(`/invitations/${fresh}`, bea)).status).toBe(404);
    expect(await (await get("/models", bea)).text()).not.toContain('data-testid="invitation"');
    expect(await (await post(`/models/${id}/invitations/${String(open[0]?.id)}/cancel`, {}, alex)).text()).toContain("already answered, replaced or cancelled");
    // Only the owner cancels.
    await post(share, { email: "bea@example.test", role: "view" }, alex);
    const [{ id: third }] = rows("SELECT id FROM model_invitations WHERE state = 'open'") as [{ id: string }];
    expect((await post(`/models/${id}/invitations/${third}/cancel`, {}, bea)).status).toBe(404);

    exec("UPDATE model_invitations SET expires_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", third);
    const page = await (await get(share, alex)).text();
    expect(page).toContain("Expired");
    expect(page).toContain(">Remove<");
    expect(await (await get("/models", bea)).text()).not.toContain('data-testid="invitation"');
    expect((await post(`/invitations/${third}/accept`, {}, bea)).status).toBe(410);
    expect(await app?.db.sharedWith(await idOf("bea@example.test"))).toEqual([]);
  });

  test("existing shares keep working without a confirmed address, and a role change needs no invitation", async () => {
    const a = await start();
    const alex = await signUp("alex@example.test", "Alex");
    const cam = await signUp("cam@example.test", "Cam");
    const id = await makeModel(alex, "East plant");
    const camId = await idOf("cam@example.test");
    // A share saved before invitations existed: Cam's address was never confirmed.
    await a.db.share({ modelId: id, userId: camId, role: "view", invitedBy: await idOf("alex@example.test") });
    expect(await (await get("/models", cam)).text()).toContain("East plant");
    const page = await (await get(`/models/${id}/share`, alex)).text();
    const grantId = page.match(/name="grant_id" value="([^"]+)"/)?.[1];
    if (!grantId) throw new Error("the role form is missing its grant");
    const form = { grant_id: grantId, role: "edit" };
    const changed = await post(`/models/${id}/share/${camId}/role`, form, alex);
    expect(await changed.text()).toContain("Saved Cam’s personal share as Can edit.");
    expect((await a.db.accessTo(camId, id))?.access).toBe("edit");
    expect(rows("SELECT * FROM model_invitations")).toEqual([]);
    await post(`/models/${id}/share/${camId}/delete`, {}, alex);
    expect((await post(`/models/${id}/share/${camId}/role`, form, alex)).status).toBe(404);
    expect(await a.db.accessTo(camId, id)).toBeNull();
    await a.db.share({ modelId: id, userId: camId, role: "view", invitedBy: await idOf("alex@example.test") });
    expect((await post(`/models/${id}/share/${camId}/role`, form, alex)).status).toBe(409);
    expect((await a.db.accessTo(camId, id))?.access).toBe("view");
  });

  test("removing a share between the role form's lookup and write leaves access revoked", async () => {
    const a = await start();
    const owner = await signUp("alex@example.test", "Alex");
    await signUp("cam@example.test", "Cam");
    const model = await makeModel(owner, "East plant");
    const ownerId = await idOf("alex@example.test");
    const recipient = await idOf("cam@example.test");
    await a.db.share({ modelId: model, userId: recipient, invitedBy: ownerId, role: "view" });
    const shares = await a.db.sharesOf(model);
    const grant = shares[0]?.grant_id;
    if (!grant) throw new Error("missing grant");
    // Return the snapshot the handler read just before another owner request revoked it.
    const lookup = jest.spyOn(a.db, "sharesOf").mockImplementationOnce(async () => {
      await a.db.unshare(model, recipient, ownerId);
      return shares;
    });
    try {
      expect((await post(`/models/${model}/share/${recipient}/role`, { role: "edit", grant_id: grant }, owner)).status).toBe(409);
      expect(await a.db.accessTo(recipient, model)).toBeNull();
    } finally { lookup.mockRestore(); }
  });

  test("an ownership handover leaves the earlier owner's invitations unusable", async () => {
    const a = await start();
    const alex = await signUp("alex@example.test", "Alex");
    const bea = await signUp("bea@example.test", "Bea");
    const cam = await signUp("cam@example.test", "Cam");
    confirmAddress(dataDir, "bea@example.test");
    const id = await makeModel(alex, "East plant");
    const token = linkToken(await (await post(`/models/${id}/share`, { email: "bea@example.test", role: "edit" }, alex)).text());
    const [{ id: invitationId }] = rows("SELECT id FROM model_invitations") as [{ id: string }];
    const [alexId, camId] = [await idOf("alex@example.test"), await idOf("cam@example.test")];
    await a.db.share({ modelId: id, userId: camId, role: "view", invitedBy: alexId });
    await a.db.transfers.offer("offer-1", id, alexId, camId, "none");
    expect(await a.db.transfers.respond("offer-1", camId, "accept", 5)).toMatchObject({ state: "accepted" });

    expect(await (await get("/models", bea)).text()).not.toContain('data-testid="invitation"');
    expect((await get(`/invitations/${token}`, bea)).status).toBe(404);
    expect((await post(`/invitations/${invitationId}/accept`, {}, bea)).status).toBe(410);
    expect(await (await get(`/models/${id}/share`, cam)).text()).toContain("No invitations waiting.");
    expect(await a.db.accessTo(await idOf("bea@example.test"), id)).toBeNull();

    // Handed back: the earlier invitation stays ended.
    await a.db.share({ modelId: id, userId: alexId, role: "view", invitedBy: camId });
    await a.db.transfers.offer("offer-2", id, camId, alexId, "none");
    expect(await a.db.transfers.respond("offer-2", alexId, "accept", 5)).toMatchObject({ state: "accepted" });
    expect((await post(`/invitations/${invitationId}/accept`, {}, bea)).status).toBe(410);
    expect((await get(`/invitations/${token}`, bea)).status).toBe(404);
    expect(rows("SELECT state FROM model_invitations")).toEqual([{ state: "cancelled" }]);
  });
});

describe("Google through Supabase", () => {
  const SUPABASE_URL = "https://example-project.supabase.co";
  const googleUser = (id: string, email: string) => ({ id, email, email_confirmed_at: "2026-11-27T12:00:00Z", user_metadata: { display_name: "Bea" },
    app_metadata: { provider: "google", providers: ["google"] }, identities: [{ provider: "google", identity_data: { email, email_verified: true } }] });

  async function googleSignIn(): Promise<Response> {
    const begin = await fetch(`${base}/auth/supabase/google/start?return_to=%2Fmodels`, { redirect: "manual" });
    const list = typeof begin.headers.getSetCookie === "function" ? begin.headers.getSetCookie() : [];
    const pkce = (list.find((c) => c.startsWith("mutinybim_sb_pkce=")) ?? "").split(";")[0] ?? "";
    return fetch(`${base}/auth/supabase/callback?code=google-code`, { headers: { cookie: pkce }, redirect: "manual" });
  }

  test.each([
    ["a pre-migration account that still holds a password someone chose stays unconfirmed, so that person can't accept", "squatter-pass", false],
    ["an account with no local password is confirmed by the same sign-in, and can accept", null, true],
  ])("%s", async (_label, password, confirmed) => {
    const a = await start({ supabase: { url: SUPABASE_URL, publishableKey: "test-publishable-key", google: true } }, { fetchImpl: async (input) => {
      if (String(input) === `${SUPABASE_URL}/auth/v1/token?grant_type=pkce`) return Response.json({ access_token: "a", user: googleUser("00000000-0000-4000-8000-0000000000b1", "bea@example.test") });
      return new Response("unexpected", { status: 404 });
    } });
    // Someone made a local account with Bea's address before the move to Supabase sign-in.
    await a.db.createUser({ id: "legacy-bea", email: "bea@example.test", displayName: "Not Bea", passwordHash: password === null ? null : await hashPassword(password) });
    await a.db.createUser({ id: "legacy-alex", email: "alex@example.test", displayName: "Alex", passwordHash: null });
    await a.db.createModel({ id: "plant", ownerId: "legacy-alex", name: "East plant" });
    await a.db.invitations.create({ id: "i-1", modelId: "plant", ownerId: "legacy-alex", email: "bea@example.test", role: "edit", tokenHash: "h", expiresAt: new Date(Date.now() + 86_400_000) });

    // The real Bea signs in with Google: Variant B attaches the subject to the existing account.
    expect((await googleSignIn()).status).toBe(303);
    expect(await a.db.userByIdentity("supabase", "00000000-0000-4000-8000-0000000000b1")).toMatchObject({ id: "legacy-bea" });
    expect(Boolean((await a.db.userById("legacy-bea"))?.email_confirmed_at)).toBe(confirmed);
    expect(await a.db.invitations.respond("i-1", "legacy-bea", "accept")).toBe(confirmed ? "accepted" : "unavailable");
  });
});

describe("the operator command", () => {
  /** Runs `npm run web:confirm-email`'s command against this server's data folder. */
  async function confirmEmail(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const root = path.resolve(__dirname, "../../..");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MUTINYBIM_")));
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--import", "tsx", "apps/mutinybim-web/src/admin.ts", "confirm-email", ...args], {
        cwd: root, env: { ...env, TSX_TSCONFIG_PATH: "apps/mutinybim-web/tsconfig.runtime.json", MUTINYBIM_WEB_DATA: dataDir, MUTINYBIM_WEB_ORIGIN: base },
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const failed = err as { code?: number; stdout?: string; stderr?: string };
      return { code: failed.code ?? -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
    }
  }

  test("confirms an address on a server with no email and no sign-in provider, so its invitation can be accepted", async () => {
    await start();
    const alex = await signUp("alex@example.test", "Alex");
    const bea = await signUp("bea@example.test", "Bea");
    const id = await makeModel(alex, "East plant");
    const token = linkToken(await (await post(`/models/${id}/share`, { email: "bea@example.test", role: "edit" }, alex)).text());
    expect(await (await get(`/invitations/${token}`, bea)).text()).toContain("ask whoever runs this server to confirm it");

    const ran = await confirmEmail("Bea@Example.test");
    expect(ran).toMatchObject({ code: 0 });
    expect(ran.stdout).toContain("Confirmed bea@example.test. Invitations to this address can now be accepted.");
    const first = (await app?.db.userByEmail("bea@example.test"))?.email_confirmed_at;
    expect(first).toEqual(expect.any(String));
    expect(await (await get("/models", bea)).text()).toContain("Join “East plant”?");
    const [{ id: invitationId }] = rows("SELECT id FROM model_invitations") as [{ id: string }];
    expect((await post(`/invitations/${invitationId}/accept`, {}, bea)).status).toBe(303);
    expect((await app?.db.accessTo(await idOf("bea@example.test"), id))?.access).toBe("edit");

    // Again: says so and keeps the first time.
    const again = await confirmEmail("bea@example.test");
    expect(again).toMatchObject({ code: 0 });
    expect(again.stdout).toContain(`bea@example.test was already confirmed on ${first}. Nothing changed.`);
    expect((await app?.db.userByEmail("bea@example.test"))?.email_confirmed_at).toBe(first);

    // An unknown address or a missing one changes nothing.
    expect(await confirmEmail("nobody@example.test")).toMatchObject({ code: 1, stderr: expect.stringContaining("No account uses nobody@example.test") });
    expect(await confirmEmail()).toMatchObject({ code: 2, stderr: expect.stringContaining("npm run web:confirm-email -- person@example.com") });
    expect(rows("SELECT count(*) AS n FROM users WHERE email_confirmed_at IS NOT NULL")).toEqual([{ n: 1 }]);
  }, 60_000);
});

describe("the SQLite store", () => {
  async function store() {
    const file = path.join(dataDir, "accounts.sqlite");
    const db = openDb(file);
    const second = openDb(file);
    for (const id of ["alex", "bea", "cam"]) await db.createUser({ id, email: `${id}@example.test`, displayName: id, passwordHash: null });
    await db.createModel({ id: "plant", ownerId: "alex", name: "Plant room" });
    const raw = new DatabaseSync(file);
    raw.exec("UPDATE users SET email_confirmed_at = '2026-11-27T00:00:00.000Z'");
    const invite = (id: string, email: string, role: "view" | "edit" = "edit") => db.invitations.create({ id, modelId: "plant", ownerId: "alex", email, role,
      tokenHash: `hash-${id}`, expiresAt: new Date(Date.now() + 86_400_000) });
    return { db, second, raw, invite };
  }

  test("a role edit can update only the displayed grant, even when another connection removes or replaces it", async () => {
    const { db, second, raw } = await store();
    try {
      const share = { modelId: "plant", userId: "bea", invitedBy: "alex", role: "view" } as const;
      await db.share(share);
      const grant = (await db.sharesOf("plant"))[0]?.grant_id;
      if (!grant) throw new Error("missing initial grant");
      expect(await db.changeShareRole("plant", "bea", "cam", grant, "edit")).toBe(false);
      await second.unshare("plant", "bea", "alex");
      expect(await db.changeShareRole("plant", "bea", "alex", grant, "edit")).toBe(false);
      expect(await db.sharesOf("plant")).toEqual([]);
      await second.share(share);
      expect(await db.changeShareRole("plant", "bea", "alex", grant, "edit")).toBe(false);
      const [replacement] = await db.sharesOf("plant");
      expect(replacement?.role).toBe("view");
      expect(replacement?.grant_id).not.toBe(grant);
    } finally { raw.close(); await second.close(); await db.close(); }
  });

  test("accepting takes the invitation's role, keeps an existing share's grant, and only one of two answers wins", async () => {
    const { db, second, raw, invite } = await store();
    try {
      await db.share({ modelId: "plant", userId: "bea", role: "view", invitedBy: "alex" });
      const grant = raw.prepare("SELECT grant_id FROM model_shares WHERE user_id = 'bea'").get()?.grant_id;
      expect(await invite("i-1", "bea@example.test")).toBe(true);
      const answers = await Promise.all([db.invitations.respond("i-1", "bea", "accept"), second.invitations.respond("i-1", "bea", "decline")]);
      expect(answers.sort()).toEqual(["accepted", "unavailable"]);
      expect(raw.prepare("SELECT role, grant_id FROM model_shares WHERE user_id = 'bea'").get()).toEqual({ role: "edit", grant_id: grant });
      expect(raw.prepare("SELECT state, answered_by FROM model_invitations WHERE id = 'i-1'").get()).toEqual({ state: "accepted", answered_by: "bea" });
    } finally { raw.close(); await second.close(); await db.close(); }
  });

  test("answering in the store itself refuses another address, the owner, an expired invitation and one from a former owner", async () => {
    const { db, second, raw, invite } = await store();
    try {
      await invite("i-bea", "bea@example.test");
      await invite("i-alex", "alex@example.test");
      expect(await db.invitations.respond("i-bea", "cam", "accept")).toBe("unavailable");
      expect(await db.invitations.respond("i-alex", "alex", "accept")).toBe("unavailable");
      raw.exec("UPDATE model_invitations SET expires_at = '2026-01-01T00:00:00.000Z' WHERE id = 'i-bea'");
      expect(await db.invitations.respond("i-bea", "bea", "accept")).toBe("unavailable");
      await invite("i-bea-2", "bea@example.test");
      raw.exec("UPDATE models SET owner_id = 'cam' WHERE id = 'plant'");
      expect(await db.invitations.respond("i-bea-2", "bea", "accept")).toBe("unavailable");
      raw.exec("UPDATE models SET owner_id = 'alex' WHERE id = 'plant'");
      expect(await db.invitations.respond("i-bea-2", "bea", "accept")).toBe("unavailable");
      expect(raw.prepare("SELECT count(*) AS n FROM model_shares").get()).toEqual({ n: 0 });
      expect(raw.prepare("SELECT count(*) AS n FROM model_invitations WHERE state IN ('accepted', 'declined')").get()).toEqual({ n: 0 });
    } finally { raw.close(); await second.close(); await db.close(); }
  });

  test("an operator's confirmation keeps the first time and refuses an address the account no longer uses", async () => {
    const { db, second, raw } = await store();
    try {
      raw.exec("UPDATE users SET email_confirmed_at = NULL WHERE id = 'cam'");
      expect(await db.confirmEmail("cam", "cam@elsewhere.test")).toBe(false);
      expect((await db.userById("cam"))?.email_confirmed_at).toBeNull();
      expect(await db.confirmEmail("cam", "cam@example.test")).toBe(true);
      const first = (await db.userById("cam"))?.email_confirmed_at;
      expect(first).toEqual(expect.any(String));
      expect(await second.confirmEmail("cam", "cam@example.test")).toBe(true);
      expect((await db.userById("cam"))?.email_confirmed_at).toBe(first);
    } finally { raw.close(); await second.close(); await db.close(); }
  });

  test("a changed address, a lost confirmation or a deleted model ends an invitation; a stranger's model takes none", async () => {
    const { db, second, raw, invite } = await store();
    try {
      await invite("i-1", "cam@example.test");
      raw.exec("UPDATE users SET email = 'cam@elsewhere.test' WHERE id = 'cam'");
      expect(await db.invitations.respond("i-1", "cam", "accept")).toBe("unavailable");
      raw.exec("UPDATE users SET email = 'cam@example.test' WHERE id = 'cam'");
      // Changing the address cleared its confirmation; changing it back doesn't restore it.
      expect(await db.invitations.respond("i-1", "cam", "accept")).toBe("unavailable");
      expect(await db.invitations.inbox("cam@example.test")).toHaveLength(1);

      expect(await db.invitations.create({ id: "i-2", modelId: "plant", ownerId: "bea", email: "x@example.test", role: "edit", tokenHash: "h2", expiresAt: new Date(Date.now() + 1000) })).toBe(false);
      await db.deleteModel("plant", "alex");
      expect(raw.prepare("SELECT count(*) AS n FROM model_invitations").get()).toEqual({ n: 0 });
    } finally { raw.close(); await second.close(); await db.close(); }
  });
});

test("the Supabase store keeps invitations through PostgREST and answers them in one RPC", async () => {
  const seen: { method: string; path: string; query: string; body: unknown }[] = [];
  const card = { id: "i-1", model_id: "plant", email: "bea@example.test", role: "edit", invited_by: "alex",
    created_at: "2026-11-27T00:00:00+00:00", expires_at: "2026-12-04T00:00:00+00:00", model_name: "Plant room", inviter_name: "Alex" };
  const store = openSupabaseStore({ url: "https://example-project.supabase.co", secretKey: "test-secret", fetchImpl: async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    seen.push({ method: init?.method ?? "GET", path: url.pathname, query: url.search, body });
    if (url.pathname === "/rest/v1/rpc/web_update_model_share_role") return Response.json(body?.p_grant === "current-grant");
    if (url.pathname === "/rest/v1/rpc/web_create_model_invitation") return Response.json(true);
    if (url.pathname === "/rest/v1/rpc/web_open_model_invitations") return Response.json([card]);
    if (url.pathname === "/rest/v1/rpc/web_respond_model_invitation") return Response.json(body?.p_action === "accept" ? "accepted" : "unavailable");
    if (url.pathname === "/rest/v1/model_invitations" && init?.method === "PATCH") return Response.json([{ id: "i-1" }]);
    return Response.json([]);
  } });
  expect(await store.invitations.create({ id: "i-1", modelId: "plant", ownerId: "alex", email: " Bea@Example.test ", role: "edit", tokenHash: "h", expiresAt: new Date("2026-12-04T00:00:00Z") })).toBe(true);
  expect(await store.invitations.inbox("BEA@example.test")).toEqual([card]);
  expect(await store.invitations.byToken("h")).toEqual(card);
  expect(await store.invitations.respond("i-1", "bea", "accept")).toBe("accepted");
  expect(await store.invitations.respond("i-1", "bea", "decline")).toBe("unavailable");
  expect(await store.invitations.cancel("i-1", "plant", "alex")).toBe(true);
  expect(seen.map((s) => [s.method, s.path, s.body])).toEqual([
    ["POST", "/rest/v1/rpc/web_create_model_invitation", { p_id: "i-1", p_model: "plant", p_owner: "alex", p_email: "bea@example.test", p_role: "edit", p_token_hash: "h", p_expires_at: "2026-12-04T00:00:00.000Z" }],
    ["POST", "/rest/v1/rpc/web_open_model_invitations", { p_email: "bea@example.test", p_token_hash: null }],
    ["POST", "/rest/v1/rpc/web_open_model_invitations", { p_email: null, p_token_hash: "h" }],
    ["POST", "/rest/v1/rpc/web_respond_model_invitation", { p_id: "i-1", p_user: "bea", p_action: "accept" }],
    ["POST", "/rest/v1/rpc/web_respond_model_invitation", { p_id: "i-1", p_user: "bea", p_action: "decline" }],
    ["PATCH", "/rest/v1/model_invitations", { state: "cancelled", answered_at: expect.any(String) }],
  ]);
  seen.length = 6;
  expect(await store.confirmEmail("bea", "bea@example.test")).toBe(false);
  expect(seen[6]).toMatchObject({ method: "POST", path: "/rest/v1/rpc/web_confirm_email_by_operator", body: { p_user_id: "bea", p_email: "bea@example.test" } });
  expect(await store.changeShareRole("plant", "bea", "alex", "current-grant", "view")).toBe(true);
  expect(seen[7]).toMatchObject({ method: "POST", path: "/rest/v1/rpc/web_update_model_share_role",
    body: { p_model: "plant", p_user: "bea", p_owner: "alex", p_grant: "current-grant", p_role: "view" } });
  expect(await store.changeShareRole("plant", "bea", "alex", "removed-grant", "edit")).toBe(false);
  const cancel = new URLSearchParams(seen[5]?.query);
  expect(Object.fromEntries(cancel)).toEqual({ id: "eq.i-1", model_id: "eq.plant", invited_by: "eq.alex", state: "eq.open", select: "id" });
});

test("the copier carries invitations to Postgres with the inviter's remapped account and the link digest", async () => {
  const sqlitePath = path.join(dataDir, "accounts.sqlite");
  const sqlite = openDb(sqlitePath);
  await sqlite.createUser({ id: "local-ada", email: "ada@example.com", displayName: "Ada", passwordHash: null });
  await sqlite.createModel({ id: "mdl-1", ownerId: "local-ada", name: "Studio" });
  await sqlite.invitations.create({ id: "i-1", modelId: "mdl-1", ownerId: "local-ada", email: "bea@example.test", role: "view", tokenHash: "kept-digest", expiresAt: new Date(Date.now() + 86_400_000) });
  await sqlite.close();
  const posted: { path: string; body: unknown }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/v1/users" && (init?.method ?? "GET") === "GET") return Response.json([{ id: "pg-ada", email: "ada@example.com", password_hash: null }]);
    posted.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(null, { status: 204 });
  };
  const summary = await migrateSqliteToSupabase({ sqlitePath, supabaseUrl: "https://example-project.supabase.co", secretKey: "test-secret", fetchImpl });
  expect(summary.tables.model_invitations).toBe(1);
  expect(posted.find((p) => p.path === "/rest/v1/model_invitations")?.body).toEqual([
    expect.objectContaining({ id: "i-1", model_id: "mdl-1", email: "bea@example.test", invited_by: "pg-ada", token_hash: "kept-digest", state: "open", answered_by: null }),
  ]);
});

test("an invitation email keeps names out of the subject and on one line in the body", () => {
  expect(oneLine("Alex\r\nBcc: evil@example.test x", 80)).toBe("Alex Bcc: evil@example.test x");
  expect(oneLine("a".repeat(200), 80)).toHaveLength(80);
  const mail = invitationMail("https://app.example.test", "bea@example.test", "tok", { inviter: "Alex\nSubject: hi", model: "Plant\nroom", role: "edit" });
  expect(mail.subject).toBe("You're invited to a model on MutinyBIM");
  expect(mail.text.split("\n")[0]).toBe('Alex Subject: hi invited bea@example.test to edit the model "Plant room" on MutinyBIM.');
  expect(mail.text).toContain("https://app.example.test/invitations/tok");
  expect(() => invitationMail("https://app.example.test", "bea@example.test\nBcc: x@example.test", "tok", { inviter: "A", model: "M", role: "view" })).toThrow();
});
