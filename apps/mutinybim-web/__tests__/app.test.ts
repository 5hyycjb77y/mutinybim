/**
 * @jest-environment node
 *
 * The hosted app end to end over HTTP and WebSocket: sign up, make a model,
 * keep strangers out, share it to view or edit, edit it through the model
 * server with an agent key (as the tool server does), find edits, branches
 * and saved versions after a restart, and get back in with a reset link.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { AgentSession, agentActor, builtinWebSocketFactory } from "@permitzip/bim-sync";
import { createApp, type App, type AppOptions } from "../src/app";
import type { Mail, Mailer } from "../src/mailer";
import { ModelStore, starterModel } from "../src/models";
import { digest, randomToken } from "../src/secrets";
import type { WebConfig } from "../src/config";
import type { Fetch } from "../src/oauth";
import { seedTeamShare } from "../__fixtures__/team-share";

let dataDir = "";
let app: App | null = null;
let base = "";

function config(port: number, extra: Partial<WebConfig> = {}): WebConfig {
  return { port, host: "127.0.0.1", origin: `http://127.0.0.1:${port}`, dataDir, modelLimit: 3, signupOpen: true, providers: [], quote: null, secure: false, ...extra };
}

async function start(extra: Partial<WebConfig> = {}, fetchImpl?: Fetch, more: AppOptions = {}): Promise<void> {
  const probe = createApp(config(0, extra), { editor: false, ...(fetchImpl ? { fetchImpl } : {}) });
  await new Promise<void>((resolve) => probe.server.listen(0, "127.0.0.1", resolve));
  const address = probe.server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await probe.close();
  app = createApp(config(address.port, extra), { editor: false, ...(fetchImpl ? { fetchImpl } : {}), ...more });
  await app.listen();
  base = `http://127.0.0.1:${address.port}`;
}

async function post(pathname: string, form: Record<string, string>, cookie = ""): Promise<Response> {
  return fetch(`${base}${pathname}`, { method: "POST", redirect: "manual", headers: { origin: base, cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
}

function sessionCookie(response: Response): string {
  const raw = response.headers.get("set-cookie") ?? "";
  const match = raw.match(/mutinybim_session=[^;]+/);
  if (!match) throw new Error(`no session cookie in ${raw}`);
  return match[0];
}

async function signUp(email: string, name = "Sam Example"): Promise<string> {
  const response = await post("/signup", { name, email, password: "correct-horse" });
  expect(response.status).toBe(303);
  return sessionCookie(response);
}

async function makeModel(cookie: string, name: string): Promise<string> {
  const response = await post("/models", { name, start: "blank" }, cookie);
  expect(response.status).toBe(303);
  const id = response.headers.get("location")?.match(/\/m\/([a-z0-9-]+)/)?.[1];
  if (!id) throw new Error("no model id in the redirect");
  return id;
}

async function makeAgentKey(cookie: string): Promise<string> {
  const page = await (await post("/connect/keys", { label: "Test assistant" }, cookie)).text();
  const key = page.match(/data-testid="new-agent-key">(mbk_[A-Za-z0-9_-]+)<\/code>/)?.[1];
  if (!key) throw new Error("the connect page showed no new key");
  return key;
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "mutinybim-web-test-"));
});

afterEach(async () => {
  await app?.close();
  app = null;
  await rm(dataDir, { recursive: true, force: true });
});

test("sign up, make a model, and see it listed; signed-out visitors are sent to log in", async () => {
  await start();
  const cookie = await signUp("sam@example.com");
  const id = await makeModel(cookie, "Sample Warehouse");
  const list = await (await fetch(`${base}/models`, { headers: { cookie } })).text();
  expect(list).toContain("Sample Warehouse");
  expect(list).toContain(`/m/${id}`);
  const anon = await fetch(`${base}/m/${id}`, { redirect: "manual" });
  expect(anon.status).toBe(303);
  expect(anon.headers.get("location")).toBe(`/login?return_to=${encodeURIComponent(`/m/${id}`)}`);
});

test("wrong password, duplicate email and cross-site posts are refused in words", async () => {
  await start();
  await signUp("sam@example.com");
  const wrong = await post("/login", { email: "sam@example.com", password: "not-the-one" });
  expect(wrong.status).toBe(401);
  expect(await wrong.text()).toMatch(/don(&#x27;|&#39;|’|')t match an account/);
  const dup = await post("/signup", { name: "Again", email: "SAM@example.com", password: "correct-horse" });
  expect(dup.status).toBe(409);
  const cross = await fetch(`${base}/models`, { method: "POST", headers: { origin: "https://elsewhere.example", "content-type": "application/x-www-form-urlencoded" }, body: "name=x" });
  expect(cross.status).toBe(403);
});

test("a lost create reply reopens the original model from the signed-in form after restart at quota", async () => {
  await start({ modelLimit: 1 });
  const cookie = await signUp("creator@example.com");
  const page = await (await fetch(`${base}/models`, { headers: { cookie } })).text();
  const key = page.match(/name="creation_key" value="([^"]+)"/)?.[1];
  if (!key || !app) throw new Error("Missing model creation form");
  const form = { name: "East plant", start: "blank", creation_key: key };
  const lost = new AbortController();
  const finish = app.db.finishCreation.bind(app.db);
  let id = "";
  jest.spyOn(app.db, "finishCreation").mockImplementationOnce(async (...args) => {
    const receipt = await finish(...args);
    id = receipt.model_id;
    lost.abort();
    return receipt;
  });
  await expect(fetch(`${base}/models`, { method: "POST", body: new URLSearchParams(form),
    headers: { cookie, origin: base }, signal: lost.signal, redirect: "manual" })).rejects.toMatchObject({ name: "AbortError" });
  expect(id).toMatch(/^m-/);
  await app.close();
  app = null;
  await start({ modelLimit: 1 });
  const replay = await post("/models", form, cookie);
  expect(replay.status).toBe(303);
  expect(replay.headers.get("location")).toBe(`/m/${id}?view=plan`);
  const summary = await fetch(`${base}/api/hosted/models/${id}/summary`, { headers: { cookie } });
  expect(await summary.json()).toMatchObject({ byKind: { level: 1 } });
  expect((await post("/models", { ...form, name: "Different" }, cookie)).status).toBe(409);
  const full = await post("/models", { name: "East plant", start: "blank" }, cookie);
  expect(full.status).toBe(409);
  expect(await full.text()).toContain("up to 1 model.");
});

test("someone else's model is not found, in the list, the editor or its summary", async () => {
  await start();
  const owner = await signUp("owner@example.com");
  const id = await makeModel(owner, "Owners model");
  const other = await signUp("other@example.com");
  expect((await fetch(`${base}/m/${id}`, { headers: { cookie: other } })).status).toBe(404);
  expect((await fetch(`${base}/api/hosted/models/${id}/summary`, { headers: { cookie: other } })).status).toBe(404);
  expect(await (await fetch(`${base}/models`, { headers: { cookie: other } })).text()).not.toContain("Owners model");
  expect((await post(`/models/${id}/share`, { email: "other@example.com", role: "edit" }, other)).status).toBe(404);
});

test("the model limit is enforced with a reason", async () => {
  await start();
  const cookie = await signUp("sam@example.com");
  for (const name of ["One", "Two", "Three"]) await makeModel(cookie, name);
  const over = await post("/models", { name: "Four", start: "blank" }, cookie);
  expect(over.status).toBe(409);
  expect(await over.text()).toContain("up to 3 models");
});

test("an agent key edits the model through the model server, the edit is saved, and survives a restart", async () => {
  await start();
  const cookie = await signUp("sam@example.com");
  const id = await makeModel(cookie, "Agent target");
  const key = await makeAgentKey(cookie);
  const syncUrl = `${base.replace(/^http/, "ws")}/sync?key=${key}`;

  const session = await AgentSession.open({ url: syncUrl, token: "local", modelId: id, actor: agentActor("sam", "run-1", "Test assistant"), socketFactory: builtinWebSocketFactory() });
  const result = await session.edit({ type: "create_level", levelId: "level-2", name: "Level 2", elevationMm: 4000 }, { idempotencyKey: "add-level-2" });
  expect(result).toMatchObject({ status: "saved" });
  session.close();

  const summary = await (await fetch(`${base}/api/hosted/models/${id}/summary`, { headers: { cookie } })).json();
  expect(summary).toMatchObject({ byKind: { level: 2 } });

  await app?.close();
  app = null;
  const saved: unknown = JSON.parse(await readFile(path.join(dataDir, "models", `${id}.json`), "utf8"));
  expect(JSON.stringify(saved)).toContain("Level 2");

  await start();
  const again = await (await fetch(`${base}/api/hosted/models/${id}/summary`, { headers: { cookie } })).json();
  expect(again).toMatchObject({ byKind: { level: 2 } });
});

test("a model connection without a session or with a bad key is refused", async () => {
  await start();
  const cookie = await signUp("sam@example.com");
  const id = await makeModel(cookie, "Locked");
  await expect(
    AgentSession.open({ url: `${base.replace(/^http/, "ws")}/sync?key=mbk_not-a-real-key`, token: "local", modelId: id, actor: agentActor("x", "run-1", "Stranger"), socketFactory: builtinWebSocketFactory(), timeoutMs: 3000 }),
  ).rejects.toThrow();
});

test("Log in with a provider: registers itself, signs in through UserInfo, and makes the account", async () => {
  const issuer = "https://id.example.test";
  const calls: string[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${input}`);
    if (input === `${issuer}/.well-known/oauth-authorization-server`) {
      return Response.json({ authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register`, userinfo_endpoint: `${issuer}/userinfo` });
    }
    if (input === `${issuer}/register`) return Response.json({ client_id: "client-123" }, { status: 201 });
    if (input === `${issuer}/token`) {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("client_id")).toBe("client-123");
      expect(body.get("code")).toBe("code-abc");
      expect(body.get("code_verifier")).toBeTruthy();
      return Response.json({ access_token: "provider-token", token_type: "bearer" });
    }
    if (input === `${issuer}/userinfo`) {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer provider-token");
      return Response.json({ sub: "person-1", email: "pat@example.com", name: "Pat Example", email_verified: true });
    }
    return new Response("not here", { status: 404 });
  };
  await start({ providers: [{ id: "example", label: "Log in with Example", issuer }] }, fetchImpl);

  const login = await (await fetch(`${base}/login`)).text();
  expect(login).toContain("Log in with Example");

  const begin = await fetch(`${base}/auth/example/start?return_to=%2Fmodels`, { redirect: "manual" });
  expect(begin.status).toBe(303);
  const authorize = new URL(begin.headers.get("location") ?? "");
  expect(authorize.origin + authorize.pathname).toBe(`${issuer}/authorize`);
  expect(authorize.searchParams.get("client_id")).toBe("client-123");
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorize.searchParams.get("redirect_uri")).toBe(`${base}/auth/example/callback`);

  const back = await fetch(`${base}/auth/example/callback?code=code-abc&state=${authorize.searchParams.get("state")}`, { redirect: "manual" });
  expect(back.status).toBe(303);
  expect(back.headers.get("location")).toBe("/models");
  const cookie = sessionCookie(back);
  expect(await (await fetch(`${base}/models`, { headers: { cookie } })).text()).toContain("Pat Example");
  expect((await app?.db.userByIdentity("example", "person-1"))?.email_confirmed_at).toEqual(expect.any(String));

  const replay = await fetch(`${base}/auth/example/callback?code=code-abc&state=${authorize.searchParams.get("state")}`, { redirect: "manual" });
  expect(replay.status).toBe(400);
  expect(calls.filter((c) => c.endsWith("/register"))).toHaveLength(1);
});

test("OIDC confirms only the linked identity's current email on sign-in or explicit linking", async () => {
  const issuer = "https://accounts.example.test";
  let userInfo: Record<string, unknown> = {};
  await start({ providers: [{ id: "org", label: "Log in with Org", issuer, clientId: "test-client" }] }, async (input) => {
    if (input === issuer + "/.well-known/oauth-authorization-server") {
      return Response.json({ authorization_endpoint: issuer + "/authorize", token_endpoint: issuer + "/token", userinfo_endpoint: issuer + "/userinfo" });
    }
    if (input === issuer + "/token") return Response.json({ access_token: "test-token" });
    if (input === issuer + "/userinfo") return Response.json(userInfo);
    throw new Error(`Unexpected provider request: ${input}`);
  });

  async function signIn(claims: Record<string, unknown>, linkCookie = ""): Promise<Response> {
    userInfo = claims;
    const options = { redirect: "manual" as const, headers: { cookie: linkCookie } };
    const begin = await fetch(`${base}/auth/org/start${linkCookie ? "?link=1" : ""}`, options);
    expect(begin.status).toBe(303);
    const state = new URL(begin.headers.get("location") ?? "").searchParams.get("state");
    return fetch(`${base}/auth/org/callback?code=ok&state=${state}`, options);
  }
  const confirmation = async (email: string) => (await app?.db.userByEmail(email))?.email_confirmed_at;

  const bea = { sub: "bea", email: "Bea@Example.com" };
  for (const claim of [
    {}, { email_verified: false }, { email_verified: "true" }, { email_verified: 1 },
    { email: "other@example.com", email_verified: true }, { email: null, email_verified: true },
  ]) {
    expect((await signIn({ ...bea, ...claim })).status).toBe(303);
    expect(await confirmation(bea.email)).toBeNull();
  }
  expect((await signIn({ ...bea, email_verified: true })).status).toBe(303);
  const confirmedAt = await confirmation(bea.email);
  expect(confirmedAt).toEqual(expect.any(String));
  for (const claim of [{}, { email_verified: false }, { email_verified: true }]) {
    expect((await signIn({ ...bea, ...claim })).status).toBe(303);
    expect(await confirmation(bea.email)).toBe(confirmedAt);
  }

  const jules = { sub: "jules", email: "jules@example.com", email_verified: true };
  const julesCookie = await signUp(jules.email);
  expect((await signIn(jules)).status).toBe(409);
  expect(await confirmation(jules.email)).toBeNull();
  expect(await app?.db.userByIdentity("org", jules.sub)).toBeNull();
  expect((await signIn({ ...jules, sub: bea.sub }, julesCookie)).status).toBe(409);
  expect(await confirmation(jules.email)).toBeNull();
  expect((await signIn({ ...jules, email: "other@example.com" }, julesCookie)).status).toBe(303);
  expect(await confirmation(jules.email)).toBeNull();
  expect((await signIn(jules, julesCookie)).status).toBe(303);
  expect(await confirmation(jules.email)).toEqual(expect.any(String));
});

async function agentEdit(key: string, modelId: string, levelId: string): Promise<unknown> {
  const session = await AgentSession.open({ url: `${base.replace(/^http/, "ws")}/sync?key=${key}`, token: "local", modelId, actor: agentActor("x", `run-${levelId}`, "Test assistant"), socketFactory: builtinWebSocketFactory() });
  try {
    return await session.edit({ type: "create_level", levelId, name: levelId, elevationMm: 4000 }, { idempotencyKey: `add-${levelId}` });
  } finally {
    session.close();
  }
}

test("sharing: view only can look but not edit, edit can edit, only the owner shares, and removing takes it away", async () => {
  await start();
  const owner = await signUp("owner@example.com", "Olive Owner");
  const id = await makeModel(owner, "Shared warehouse");
  const guest = await signUp("guest@example.com", "Gus Guest");
  const guestKey = await makeAgentKey(guest);

  const unknown = await post(`/models/${id}/share`, { email: "nobody@example.com", role: "view" }, owner);
  expect(unknown.status).toBe(404);
  expect(await unknown.text()).toContain("Ask them to sign up first");

  expect((await post(`/models/${id}/share`, { email: "GUEST@example.com", role: "view" }, owner)).status).toBe(200);
  const list = await (await fetch(`${base}/models`, { headers: { cookie: guest } })).text();
  expect(list).toContain("Shared with you");
  expect(list).toContain("Shared warehouse");
  expect(list).toContain("View only");
  expect((await fetch(`${base}/api/hosted/models/${id}/summary`, { headers: { cookie: guest } })).status).toBe(200);
  expect(await agentEdit(guestKey, id, "level-view")).not.toMatchObject({ status: "saved" });
  expect((await post(`/models/${id}/rename`, { name: "Mine now" }, guest)).status).toBe(403);
  expect((await post(`/models/${id}/share`, { email: "guest@example.com", role: "edit" }, guest)).status).toBe(403);
  expect((await post(`/models/${id}/delete`, {}, guest)).status).toBe(403);

  expect((await post(`/models/${id}/share`, { email: "guest@example.com", role: "edit" }, owner)).status).toBe(200);
  expect(await agentEdit(guestKey, id, "level-edit")).toMatchObject({ status: "saved" });

  const sharePage = await (await fetch(`${base}/models/${id}/share`, { headers: { cookie: owner } })).text();
  const guestId = (await app?.db.userByEmail("guest@example.com"))?.id;
  expect(sharePage).toContain("Gus Guest");
  expect((await post(`/models/${id}/share/${guestId}/delete`, {}, owner)).status).toBe(200);
  expect((await fetch(`${base}/m/${id}`, { headers: { cookie: guest } })).status).toBe(404);
  expect(await (await fetch(`${base}/models`, { headers: { cookie: guest } })).text()).not.toContain("Shared warehouse");
});

test("East plant team edit survives personal unsharing, while the original handover offer ends", async () => {
  await start({ modelLimit: 1 });
  const alex = await signUp("alex@example.test", "Alex");
  const bea = await signUp("bea@example.test", "Bea");
  const id = await makeModel(alex, "East plant room");
  const alexId = (await app?.db.userByEmail("alex@example.test"))?.id;
  const beaId = (await app?.db.userByEmail("bea@example.test"))?.id;
  if (!alexId || !beaId || !app) throw new Error("Missing fixture accounts");
  seedTeamShare(path.join(dataDir, "accounts.sqlite"), {
    id: "hvac", name: "Mechanical", ownerId: alexId, memberId: beaId, modelId: id, role: "edit",
  });
  const share = `/models/${id}/share`;
  const offer = `/models/${id}/transfer`;
  const terms = { recipient: beaId, retained: "none" };
  const list = await (await fetch(base + "/models", { headers: { cookie: bea } })).text();
  expect(list.match(/East plant room/g)).toHaveLength(1);
  expect(list).toContain("Can edit");
  expect(list).toContain("via Mechanical");
  expect((await fetch(base + share, { headers: { cookie: bea } })).status).toBe(403);
  expect(await app.db.sharesOf(id)).toEqual([]);
  const directPage = await (await fetch(base + share, { headers: { cookie: alex } })).text();
  expect(directPage).toContain("No personal shares yet.");
  expect(directPage).not.toContain("Transfer ownership");
  expect((await post(offer, terms, alex)).status).toBe(409);
  // Being a team editor takes none of Bea's one personal model slot.
  const own = await makeModel(bea, "Bea's first model");
  expect((await post(`/models/${own}/delete`, {}, bea)).status).toBe(303);
  const key = await makeAgentKey(bea);
  const session = await AgentSession.open({ url: `${base.replace(/^http/, "ws")}/sync?key=${key}`, token: "local",
    modelId: id, actor: agentActor("bea", "team-edit", "Bea"), socketFactory: builtinWebSocketFactory() });
  try {
    expect((await post(share, { email: "bea@example.test", role: "view" }, alex)).status).toBe(200);
    expect((await post(offer, terms, alex)).status).toBe(303);
    const [first] = await app.db.transfers.inbox(beaId);
    if (!first) throw new Error("Missing direct-share offer");
    const removed = await post(`${share}/${beaId}/delete`, {}, alex);
    expect(await removed.text()).toContain("They can still edit it.");
    expect(await session.edit({ type: "create_level", levelId: "mezz", name: "Mezzanine", elevationMm: 4000 },
      { idempotencyKey: "existing-team-editor" })).toMatchObject({ status: "saved" });
    expect((await post(share, { email: "bea@example.test", role: "view" }, alex)).status).toBe(200);
    expect((await post(`/transfers/${first.id}/accept`, {}, bea)).status).toBe(409);
  } finally { session.close(); }
  expect((await post(offer, terms, alex)).status).toBe(303);
  const [second] = await app.db.transfers.inbox(beaId);
  if (!second) throw new Error("Missing replacement offer");
  expect((await post(`/transfers/${second.id}/accept`, {}, bea)).status).toBe(303);
  expect(await app.db.accessTo(alexId, id)).toMatchObject({ access: "edit" });
  expect(await app.db.sharesOf(id)).toEqual([]);
  expect(await app.db.sharedWith(beaId)).toEqual([]);
  expect((await fetch(base + share, { headers: { cookie: alex } })).status).toBe(403);
  expect((await fetch(base + share, { headers: { cookie: bea } })).status).toBe(200);
}, 30_000);

test("removing the recipient's share explains how to recover an ended offer", async () => {
  await start();
  const alex = await signUp("alex@example.com", "Alex");
  const bea = await signUp("bea@example.com", "Bea");
  await signUp("cam@example.com", "Cam");
  const id = await makeModel(alex, "East plant room");
  const share = `/models/${id}/share`;
  const beaId = (await app?.db.userByEmail("bea@example.com"))?.id;
  if (!beaId) throw new Error("Missing recipient");
  for (const email of ["bea@example.com", "cam@example.com"]) {
    expect((await post(share, { email, role: "view" }, alex)).status).toBe(200);
  }
  expect((await post(`/models/${id}/transfer`, { recipient: beaId, retained: "view" }, alex)).status).toBe(303);
  const offer = (await app?.db.transfers.inbox(beaId))?.[0];
  if (!offer) throw new Error("Missing offer");
  const page = await (await fetch(base + share, { headers: { cookie: alex } })).text();
  expect(page).toMatch(/with Bea\? [^"]*ends their ownership offer/);
  expect(page).not.toMatch(/with Cam\? [^"]*ends their ownership offer/);

  expect((await post(`${share}/${beaId}/delete`, {}, alex)).status).toBe(200);
  expect((await post(share, { email: "bea@example.com", role: "view" }, alex)).status).toBe(200);
  const stale = await post(`/transfers/${offer.id}/accept`, {}, bea);
  expect(stale.status).toBe(409);
  const notice = await stale.text();
  expect(notice).toContain("Ownership offer ended");
  expect(notice).toContain("ask the model owner to send a new offer");
  expect(notice).toMatch(/href="\/models"[^>]*>My models</);
});

test("a direct viewer accepts a handover and recovers the same receipt after restart and model deletion", async () => {
  await start({ modelLimit: 1 });
  const alex = await signUp("alex@example.com", "Alex");
  const bea = await signUp("bea@example.com", "Bea");
  const id = await makeModel(alex, "Plant room");
  const full = await makeModel(bea, "Current job");
  const beaId = (await app?.db.userByEmail("bea@example.com"))?.id;
  if (!beaId) throw new Error("Missing recipient");
  expect((await post(`/models/${id}/share`, { email: "bea@example.com", role: "view" }, alex)).status).toBe(200);
  expect((await post(`/models/${id}/transfer`, { recipient: beaId, retained: "view" }, alex)).status).toBe(303);
  const inbox = await (await fetch(base + "/models", { headers: { cookie: bea } })).text();
  const action = inbox.match(/action="(\/transfers\/[a-f0-9-]+\/accept)"/)?.[1];
  if (!action) throw new Error("Transfer offer missing from My models");
  expect(inbox).toContain("Alex");
  expect(inbox).toContain("Your model slots are full. Free one to accept this offer.");
  expect(inbox).not.toContain("1 models");
  expect((await post(action, {}, bea)).status).toBe(409);
  expect((await post(`/models/${full}/delete`, {}, bea)).status).toBe(303);
  const refreshed = await (await fetch(base + "/models", { headers: { cookie: bea } })).text();
  expect(refreshed).toContain("Accepting uses one of your model slots.");
  expect(refreshed).toContain(action);
  const first = await post(action, {}, bea);
  expect(first.status).toBe(303);
  const receipt = first.headers.get("location");
  expect(receipt).toMatch(/\/receipt$/);
  const firstReceipt = await (await fetch(base + receipt, { headers: { cookie: bea } })).text();
  expect(firstReceipt).toContain("Ownership transfer accepted");
  expect(firstReceipt).toContain("Plant room");
  expect((await fetch(`${base}/api/hosted/models/${id}/summary`, { headers: { cookie: alex } })).status).toBe(200);
  expect((await post(`/models/${id}/rename`, { name: "Next job" }, bea)).status).toBe(303);
  expect((await post(`/models/${id}/delete`, {}, bea)).status).toBe(303);
  await app?.close();
  app = null;
  await start({ modelLimit: 1 });
  expect((await post(action, {}, bea)).headers.get("location")).toBe(receipt);
  expect(await (await fetch(base + receipt, { headers: { cookie: bea } })).text()).toBe(firstReceipt);
  expect((await fetch(base + receipt, { headers: { cookie: alex } })).status).toBe(404);
  expect((await fetch(`${base}/api/hosted/models/${id}/summary`, { headers: { cookie: bea } })).status).toBe(404);
});

test("both open model connections reconnect with their new rights after a handover", async () => {
  await start();
  const owner = await signUp("owner@example.test");
  const viewer = await signUp("viewer@example.test");
  const id = await makeModel(owner, "East plant");
  const viewerId = (await app?.db.userByEmail("viewer@example.test"))?.id;
  if (!viewerId) throw new Error("Missing test viewer");
  await post(`/models/${id}/share`, { email: "viewer@example.test", role: "view" }, owner);
  const senderKey = await makeAgentKey(owner);
  const recipientKey = await makeAgentKey(viewer);
  async function openEditor(key: string, person: string) {
    let notify!: (reason: string) => void;
    const closed = new Promise<string>((resolve) => { notify = resolve; });
    const connect = builtinWebSocketFactory();
    const session = await AgentSession.open({
      modelId: id, token: "local", url: `${base.replace(/^http/, "ws")}/sync?key=${key}`, actor: agentActor(person, "run", person),
      socketFactory: (url, handlers) => connect(url, { ...handlers, onClose(reason) { handlers.onClose(reason); notify(reason); } }),
    });
    return { session, closed };
  }
  const sender = await openEditor(senderKey, "sender");
  const recipient = await openEditor(recipientKey, "recipient");
  try {
    expect((await post(`/models/${id}/transfer`, { recipient: viewerId, retained: "view" }, owner)).status).toBe(303);
    const offer = (await app?.db.transfers.inbox(viewerId))?.[0];
    if (!offer) throw new Error("Missing ownership offer");
    expect((await post(`/transfers/${offer.id}/accept`, {}, viewer)).status).toBe(303);
    expect(await Promise.all([sender.closed, recipient.closed])).toEqual([expect.stringContaining("access"), expect.stringContaining("access")]);
    await expect(sender.session.edit({ type: "create_level", levelId: "stale", name: "Stale edit", elevationMm: 4000 },
      { idempotencyKey: "stale" })).rejects.toMatchObject({ code: "closed" });
    expect(await agentEdit(senderKey, id, "after-as-viewer")).toMatchObject({ status: "refused" });
    expect(await agentEdit(recipientKey, id, "after-as-owner")).toMatchObject({ status: "saved" });
  } finally {
    sender.session.close();
    recipient.session.close();
  }
});

test("branches, their edits and saved versions are on disk and come back after a restart", async () => {
  const dir = path.join(dataDir, "models");
  const store = new ModelStore(dir);
  await store.create("m-branches-test", "blank");
  const host = await store.host("m-branches-test");
  const actor = { id: "sam", name: "Sam", kind: "human" as const };
  const head = await host.main.sequencer.head();
  await host.registry.saveVersion({ modelId: "m-branches-test", revision: head.revision, name: "Before options", savedBy: "sam" });
  const branch = await host.registry.create({ baseModelId: "m-branches-test", name: "Option B", baseRevision: head.revision, createdBy: "sam" });
  const served = await host.open(branch.modelId);
  if (!served) throw new Error("branch not served");
  const outcome = await served.sequencer.submit({ idempotencyKey: "b-1", baseRevision: head.revision, actor, command: { type: "create_level", levelId: "level-b", name: "Level B", elevationMm: 3000 } });
  expect(outcome.status).toBe("committed");
  await store.flush();

  const again = new ModelStore(dir);
  const reopened = await again.host("m-branches-test");
  expect((await reopened.registry.versions("m-branches-test")).map((v) => v.name)).toEqual(["Before options"]);
  expect((await reopened.registry.list("m-branches-test")).map((b) => b.name)).toEqual(["Option B"]);
  const branchAgain = await reopened.open(branch.modelId);
  expect(Object.keys((await branchAgain?.sequencer.head())?.elements ?? {})).toContain("level-b");
  expect(Object.keys((await reopened.main.sequencer.head()).elements)).not.toContain("level-b");
});

test("password recovery: a reset link works once, signs out everywhere, and changing a password needs the old one", async () => {
  await start();
  const first = await signUp("sam@example.com");
  const user = await app?.db.userByEmail("sam@example.com");
  if (!user || !app) throw new Error("no account");

  const wrong = await post("/settings/password", { current: "not-it", password: "new-password-1" }, first);
  expect(wrong.status).toBe(401);

  const token = randomToken();
  await app.db.createPasswordReset(digest(token), user.id, new Date(Date.now() + 3_600_000));
  expect((await fetch(`${base}/reset/${token}`)).status).toBe(200);
  const done = await post(`/reset/${token}`, { password: "new-password-2" });
  expect(done.status).toBe(303);
  expect(done.headers.get("location")).toBe("/models?reset=1");
  expect((await fetch(`${base}/models`, { headers: { cookie: first }, redirect: "manual" })).status).toBe(303);
  expect((await post(`/reset/${token}`, { password: "new-password-3" })).status).toBe(410);
  expect((await post("/login", { email: "sam@example.com", password: "new-password-2" })).status).toBe(303);

  const forgot = await (await fetch(`${base}/forgot`)).text();
  expect(forgot).toContain("npm run web:reset-password");
});

test("two uses of one reset link at once: exactly one password is saved, and only its session survives", async () => {
  await start();
  const earlier = await signUp("sam@example.com");
  const user = await app?.db.userByEmail("sam@example.com");
  if (!user || !app) throw new Error("no account");
  const token = randomToken();
  await app.db.createPasswordReset(digest(token), user.id, new Date(Date.now() + 3_600_000));
  const signedIn = async (cookie: string) => (await fetch(`${base}/models`, { headers: { cookie }, redirect: "manual" })).status === 200;

  const attempts = await Promise.all(["password-from-a", "password-from-b"].map(async (password) => ({ password, response: await post(`/reset/${token}`, { password }) })));
  expect(attempts.map((a) => a.response.status).sort()).toEqual([303, 410]);
  const won = attempts.find((a) => a.response.status === 303);
  const lost = attempts.find((a) => a.response.status === 410);
  if (!won || !lost) throw new Error("expected one winner and one refusal");
  expect(lost.response.headers.get("set-cookie")).toBeNull();
  expect(await signedIn(sessionCookie(won.response))).toBe(true);
  expect(await signedIn(earlier)).toBe(false);
  expect((await post("/login", { email: "sam@example.com", password: won.password })).status).toBe(303);
  expect((await post("/login", { email: "sam@example.com", password: lost.password })).status).toBe(401);
  expect(await app.db.userByPasswordReset(digest(token))).toBeNull();
});

test("redeeming a reset link refuses an expired or used link and then changes nothing", async () => {
  await start();
  const cookie = await signUp("sam@example.com");
  const user = await app?.db.userByEmail("sam@example.com");
  if (!user || !app) throw new Error("no account");
  const before = user.password_hash;
  const stale = randomToken();
  await app.db.createPasswordReset(digest(stale), user.id, new Date(Date.now() - 1_000));
  expect(await app.db.redeemPasswordReset(digest(stale), "scrypt$not-used")).toBeNull();
  expect((await app.db.userById(user.id))?.password_hash).toBe(before);
  expect((await fetch(`${base}/models`, { headers: { cookie }, redirect: "manual" })).status).toBe(200);

  const live = randomToken();
  await app.db.createPasswordReset(digest(live), user.id, new Date(Date.now() + 3_600_000));
  expect((await app.db.redeemPasswordReset(digest(live), "scrypt$first"))?.id).toBe(user.id);
  expect(await app.db.redeemPasswordReset(digest(live), "scrypt$second")).toBeNull();
  expect((await app.db.userById(user.id))?.password_hash).toBe("scrypt$first");
  expect((await fetch(`${base}/models`, { headers: { cookie }, redirect: "manual" })).status).toBe(303);
});

/** An in-memory mailer: keeps every message so tests can read the links. */
function recordingMailer(): Mailer & { readonly sent: Mail[] } {
  const sent: Mail[] = [];
  return {
    sent,
    async send(mail) {
      sent.push(mail);
    },
  };
}

function resetToken(mail: Mail | undefined): string {
  const token = mail?.text.match(new RegExp(`^${base.replace(/\./g, "\\.")}/reset/([A-Za-z0-9_-]{20,80})$`, "m"))?.[1];
  if (!token) throw new Error("the email held no reset link for this server");
  return token;
}

async function forgot(email: string): Promise<{ status: number; body: string; cookie: string | null }> {
  const response = await post("/forgot", { email });
  const body = await response.text();
  await app?.settled();
  return { status: response.status, body, cookie: response.headers.get("set-cookie") };
}

async function signedIn(cookie: string): Promise<boolean> {
  const response = await fetch(`${base}/models`, { headers: { cookie }, redirect: "manual" });
  return response.status === 200;
}

function resetRows(): { token_hash: string; created_at: string; expires_at: string }[] {
  const sqlite = new DatabaseSync(path.join(dataDir, "accounts.sqlite"), { readOnly: true });
  try {
    return sqlite.prepare("SELECT token_hash, created_at, expires_at FROM password_resets").all() as { token_hash: string; created_at: string; expires_at: string }[];
  } finally {
    sqlite.close();
  }
}

/** Freezes the clock the app reads (Date only; timers and I/O run normally). */
function freezeClock(): (minutes: number) => void {
  const start = Date.now();
  jest.useFakeTimers({ now: start, doNotFake: ["hrtime", "nextTick", "performance", "queueMicrotask", "setImmediate", "clearImmediate", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  return (minutes) => jest.setSystemTime(start + minutes * 60_000);
}

test("Forgot password with mail on: one reply for an unknown and a known address, and only the account gets a link that works once", async () => {
  const mailer = recordingMailer();
  const logs = [jest.spyOn(console, "log"), jest.spyOn(console, "error")];
  await start({}, undefined, { mailer });
  const page = await (await fetch(`${base}/forgot`)).text();
  expect(page).toContain("Send reset link");
  expect(page).not.toContain("This server sends no email");

  // Before the account exists.
  const before = await forgot(" Bea@Example.com ");
  expect(mailer.sent).toHaveLength(0);

  const first = await signUp("bea@example.com", "Bea Example");
  const second = sessionCookie(await post("/login", { email: "bea@example.com", password: "correct-horse" }));
  expect(await signedIn(first)).toBe(true);
  expect(await signedIn(second)).toBe(true);

  // After: the same status and the same page, and now one email.
  const after = await forgot("bea@example.com");
  expect(before.status).toBe(200);
  expect(after.status).toBe(before.status);
  expect(after.body).toBe(before.body);
  expect(after.body).toContain("If an account uses bea@example.com, we sent a password reset link.");
  expect([before.cookie, after.cookie]).toEqual([null, null]);
  expect(mailer.sent).toEqual([{ to: "bea@example.com", purpose: "reset", subject: "Reset your MutinyBIM password", text: expect.stringContaining("within 1 hour") }]);
  const token = resetToken(mailer.sent[0]);

  // The existing one-hour, digest-only link: the database holds no copy of the token.
  const rows = resetRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.token_hash).toBe(digest(token));
  expect(JSON.stringify(rows)).not.toContain(token);
  expect(Date.parse(rows[0]?.expires_at ?? "") - Date.parse(rows[0]?.created_at ?? "")).toBeGreaterThanOrEqual(3_599_000);
  expect(Date.parse(rows[0]?.expires_at ?? "") - Date.parse(rows[0]?.created_at ?? "")).toBeLessThanOrEqual(3_601_000);

  const open = await fetch(`${base}/reset/${token}`);
  expect(open.status).toBe(200);
  expect(open.headers.get("referrer-policy")).toBe("strict-origin");
  expect(await open.text()).toContain("For bea@example.com.");
  const done = await post(`/reset/${token}`, { password: "new-password-2" });
  expect(done.status).toBe(303);
  expect(done.headers.get("location")).toBe("/models?reset=1");
  expect(await signedIn(sessionCookie(done))).toBe(true);

  // Spent, and every older session is signed out.
  expect(await signedIn(first)).toBe(false);
  expect(await signedIn(second)).toBe(false);
  expect((await fetch(`${base}/reset/${token}`)).status).toBe(410);
  expect((await post(`/reset/${token}`, { password: "new-password-3" })).status).toBe(410);
  expect(resetRows()).toHaveLength(0);
  expect((await post("/login", { email: "bea@example.com", password: "correct-horse" })).status).toBe(401);
  expect((await post("/login", { email: "bea@example.com", password: "new-password-2" })).status).toBe(303);

  const logged = logs.flatMap((spy) => spy.mock.calls).map((call) => JSON.stringify(call)).join("\n");
  expect(logged).not.toContain(token);
  expect(logged).not.toContain("/reset/");
});

test("an emailed reset link stops working after an hour, and a new request sends a fresh one", async () => {
  const mailer = recordingMailer();
  await start({}, undefined, { mailer });
  const cookie = await signUp("sam@example.com");
  const at = freezeClock();

  await forgot("sam@example.com");
  const stale = resetToken(mailer.sent[0]);
  at(59);
  expect((await fetch(`${base}/reset/${stale}`)).status).toBe(200);
  at(61);
  expect((await fetch(`${base}/reset/${stale}`)).status).toBe(410);
  expect((await post(`/reset/${stale}`, { password: "new-password-2" })).status).toBe(410);
  expect((await post("/login", { email: "sam@example.com", password: "correct-horse" })).status).toBe(303);
  expect(await signedIn(cookie)).toBe(true);

  await forgot("sam@example.com");
  expect(mailer.sent).toHaveLength(2);
  const fresh = resetToken(mailer.sent[1]);
  expect((await post(`/reset/${fresh}`, { password: "new-password-2" })).status).toBe(303);
  expect(await signedIn(cookie)).toBe(false);
});

test("reset emails to one address stop at three an hour; replies never change and the last link keeps working", async () => {
  const mailer = recordingMailer();
  await start({}, undefined, { mailer });
  await signUp("sam@example.com");
  await signUp("pat@example.com", "Pat Example");
  const at = freezeClock();

  const replies = [];
  for (let i = 0; i < 5; i += 1) replies.push(await forgot("sam@example.com"));
  expect(new Set(replies.map((r) => `${r.status} ${r.body}`)).size).toBe(1);
  expect(replies[0]?.status).toBe(200);
  expect(mailer.sent.map((m) => m.to)).toEqual(["sam@example.com", "sam@example.com", "sam@example.com"]);

  // Each email replaced the one before; the skipped requests made no new link.
  const tokens = mailer.sent.map(resetToken);
  expect((await fetch(`${base}/reset/${tokens[0]}`)).status).toBe(410);
  expect((await fetch(`${base}/reset/${tokens[1]}`)).status).toBe(410);
  expect((await fetch(`${base}/reset/${tokens[2]}`)).status).toBe(200);

  // Another address has its own limit.
  await forgot("pat@example.com");
  expect(mailer.sent.at(-1)?.to).toBe("pat@example.com");

  // The next hour allows another email.
  at(61);
  await forgot("sam@example.com");
  expect(mailer.sent.filter((m) => m.to === "sam@example.com")).toHaveLength(4);
});

test("a failed send preserves the previous reset link, gives the same reply, and logs no link", async () => {
  const attempts: Mail[] = [];
  const failing: Mailer = {
    async send(mail) {
      attempts.push(mail);
      throw Object.assign(new Error(`relay refused: ${mail.text}`), { code: "EENVELOPE" });
    },
  };
  const errors = jest.spyOn(console, "error");
  await start({}, undefined, { mailer: failing });
  const unknown = await forgot("sam@example.com");
  await signUp("sam@example.com");
  const user = await app?.db.userByEmail("sam@example.com");
  if (!app || !user) throw new Error("no account");
  const previous = randomToken();
  await app.db.createPasswordReset(digest(previous), user.id, new Date(Date.now() + 3_600_000));
  const known = await forgot("sam@example.com");
  expect(known.status).toBe(unknown.status);
  expect(known.body).toBe(unknown.body);
  expect(attempts).toHaveLength(1);
  expect((await fetch(`${base}/reset/${previous}`)).status).toBe(200);
  expect((await fetch(`${base}/reset/${resetToken(attempts[0])}`)).status).toBe(410);
  const logged = JSON.stringify(errors.mock.calls);
  expect(logged).toContain("EENVELOPE");
  expect(logged).not.toContain(resetToken(attempts[0]));
});

test("late SMTP replies preserve the newest delivered link and cannot revive a spent reset", async () => {
  await start();
  await signUp("sam@example.com");
  const db = app?.db;
  const user = await db?.userByEmail("sam@example.com");
  if (!db?.resetMail || !user) throw new Error("no local reset store");
  const expires = new Date(Date.now() + 3_600_000);
  const first = digest(randomToken());
  const second = digest(randomToken());
  await db.resetMail.stage(first, user.id, expires);
  await db.resetMail.stage(second, user.id, expires);
  db.resetMail.delivered(second);
  db.resetMail.delivered(first);
  expect(await db.userByPasswordReset(first)).toBeNull();
  expect((await db.userByPasswordReset(second))?.id).toBe(user.id);

  const pending = digest(randomToken());
  await db.resetMail.stage(pending, user.id, expires);
  expect((await db.redeemPasswordReset(second, "scrypt$recovered"))?.id).toBe(user.id);
  db.resetMail.delivered(pending);
  expect(await db.userByPasswordReset(pending)).toBeNull();
});

test("with mail off, Forgot password explains the two ways back and the operator's link still works", async () => {
  await start({}, undefined, { mailer: null });
  const cookie = await signUp("sam@example.com");
  const page = await (await fetch(`${base}/forgot`)).text();
  expect(page).toContain("This server sends no email");
  expect(page).toContain("npm run web:reset-password");
  expect(page).not.toContain("Send reset link");
  const posted = await post("/forgot", { email: "sam@example.com" });
  expect(await posted.text()).not.toContain("we sent a password reset link");
  expect(resetRows()).toHaveLength(0);

  // The real operator command, against this server's data folder.
  const root = path.resolve(__dirname, "../../..");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MUTINYBIM_")));
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "apps/mutinybim-web/src/admin.ts", "reset-password", "Sam@Example.com"], {
    cwd: root,
    env: { ...env, TSX_TSCONFIG_PATH: "apps/mutinybim-web/tsconfig.runtime.json", MUTINYBIM_WEB_DATA: dataDir, MUTINYBIM_WEB_ORIGIN: base },
  });
  expect(stdout).toContain("works once, for 1 hour");
  const token = stdout.match(new RegExp(`${base.replace(/\./g, "\\.")}/reset/([A-Za-z0-9_-]{20,80})`))?.[1];
  if (!token) throw new Error(`the operator command printed no link: ${stdout}`);
  expect(resetRows().map((r) => r.token_hash)).toEqual([digest(token)]);
  const done = await post(`/reset/${token}`, { password: "new-password-2" });
  expect(done.status).toBe(303);
  expect(await signedIn(cookie)).toBe(false);
  expect((await post(`/reset/${token}`, { password: "new-password-3" })).status).toBe(410);
}, 60_000);

test("the theme choice is kept in the account and drawn on every page", async () => {
  await start();
  const cookie = await signUp("sam@example.com");
  expect(await (await fetch(`${base}/models`, { headers: { cookie } })).text()).toContain('data-mutiny-scheme="system"');
  expect((await post("/settings/scheme", { scheme: "dark" }, cookie)).status).toBe(303);
  const page = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
  expect(page).toContain('data-mutiny-scheme="dark"');
  expect(page).toContain("--mutiny-surface");
  const json = await fetch(`${base}/settings/scheme`, { method: "POST", headers: { origin: base, cookie, "content-type": "application/json" }, body: JSON.stringify({ scheme: "light" }) });
  expect(json.status).toBe(204);
  expect((await app?.db.userByEmail("sam@example.com"))?.color_scheme).toBe("light");
});

test("sign-up shows the terms and privacy agreement, and the pages answer", async () => {
  await start();
  const form = await (await fetch(`${base}/signup`)).text();
  expect(form).toContain('name="agree"');
  expect(form).toContain('href="/terms"');
  expect(form).toContain('href="/privacy"');
  for (const pathname of ["/terms", "/privacy"]) {
    const response = await fetch(`${base}${pathname}`);
    expect(response.status).toBe(200);
    expect((await response.text()).toLowerCase()).toContain(pathname.slice(1));
  }
  const refused = await post("/signup", { name: "Sam", email: "sam@example.com", password: "correct-horse", agree: "0" });
  expect(refused.status).toBe(400);
});

test("with no quote setting there is no quote button, page or wording anywhere", async () => {
  await start();
  const cookie = await signUp("sam@example.com");
  const id = await makeModel(cookie, "Plain");
  for (const pathname of ["/", "/login", "/signup", "/forgot"]) expect((await (await fetch(`${base}${pathname}`)).text()).toLowerCase()).not.toContain("quote");
  for (const pathname of ["/models", "/settings", "/connect", `/models/${id}/share`]) expect((await (await fetch(`${base}${pathname}`, { headers: { cookie } })).text()).toLowerCase()).not.toContain("quote");
  const hidden = await fetch(`${base}/quote`, { headers: { cookie } });
  expect(hidden.status).toBe(404);
  expect((await hidden.text()).toLowerCase()).not.toContain("quote");
});

test("the quote button appears only when the deployment sets it", async () => {
  await start({ quote: { label: "Get an engineering quote", provider: "Example Engineering", url: "https://www.example.com/quote" } });
  const cookie = await signUp("sam@example.com");
  expect(await (await fetch(`${base}/models`, { headers: { cookie } })).text()).toContain("Get an engineering quote");
  expect((await fetch(`${base}/quote`, { headers: { cookie } })).status).toBe(200);
});

test("starterModel('...', 'sample') seeds the multi-discipline showcase with views and sheets", () => {
  const sample = starterModel("m-sample-showcase", "sample");
  expect(sample.modelId).toBe("m-sample-showcase");
  const els = Object.values(sample.elements);
  expect(els.some((e) => e.kind === "wall")).toBe(true);
  expect(els.some((e) => e.kind === "view" && e.viewType === "three_d")).toBe(true);
  expect(els.some((e) => e.kind === "sheet" && e.number === "A-101")).toBe(true);
  expect(els.some((e) => e.kind === "sheet" && e.number === "S-101")).toBe(true);
  expect(els.some((e) => e.kind === "sheet" && e.number === "E-101")).toBe(true);
});
