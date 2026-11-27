/**
 * @jest-environment node
 *
 * The hosted app end to end over HTTP and WebSocket: sign up, make a model,
 * keep strangers out, share it to view or edit, edit it through the model
 * server with an agent key (as the tool server does), find edits, branches
 * and saved versions after a restart, and get back in with a reset link.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession, agentActor, builtinWebSocketFactory } from "@permitzip/bim-sync";
import { createApp, type App } from "../src/app";
import { ModelStore, starterModel } from "../src/models";
import { digest, randomToken } from "../src/secrets";
import type { WebConfig } from "../src/config";
import type { Fetch } from "../src/oauth";

let dataDir = "";
let app: App | null = null;
let base = "";

function config(port: number, extra: Partial<WebConfig> = {}): WebConfig {
  return { port, host: "127.0.0.1", origin: `http://127.0.0.1:${port}`, dataDir, modelLimit: 3, signupOpen: true, providers: [], quote: null, secure: false, ...extra };
}

async function start(extra: Partial<WebConfig> = {}, fetchImpl?: Fetch): Promise<void> {
  const probe = createApp(config(0, extra), { editor: false, ...(fetchImpl ? { fetchImpl } : {}) });
  await new Promise<void>((resolve) => probe.server.listen(0, "127.0.0.1", resolve));
  const address = probe.server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await probe.close();
  app = createApp(config(address.port, extra), { editor: false, ...(fetchImpl ? { fetchImpl } : {}) });
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
