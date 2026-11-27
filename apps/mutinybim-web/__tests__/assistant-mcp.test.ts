/**
 * @jest-environment node
 *
 * Outside assistants over the internet: discovery (protected resource and
 * authorization server metadata), dynamic registration, sign-in with PKCE,
 * tokens (refresh rotation, a reused refresh token ends the grant), the
 * core-only default tool list, a family at /packs/<family>/mcp, every
 * change asking the person (in the assistant, or on the approvals page),
 * and a model shared view-only staying view-only.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CORE_TOOLS, CORE_TOOL_BUDGET, PACK_CONTROL_TOOL, toolFamily } from "@permitzip/bim-mcp";
import { createApp, type App } from "../src/app";
import { approvalTitle } from "../src/assistant-approvals";
import { checkAuthorize, redirectUriMatches } from "../src/assistant-auth";
import { HOSTED_PROJECT_ID } from "../src/assistant-tools";
import type { WebConfig } from "../src/config";
import { openDb } from "../src/db";
import { DatabaseSync } from "node:sqlite";
import { seedTeamShare } from "../__fixtures__/team-share";

let dataDir = "";
let app: App | null = null;
let base = "";
const REDIRECT = "https://assistant.example/oauth/callback";
const EDIT_FAMILY = toolFamily("bim_create_level") ?? "";

function config(port: number): WebConfig {
  return { port, host: "127.0.0.1", origin: `http://127.0.0.1:${port}`, dataDir, modelLimit: 5, signupOpen: true, providers: [], quote: null, secure: false };
}

async function start(): Promise<void> {
  const probe = createApp(config(0), { editor: false });
  await new Promise<void>((resolve) => probe.server.listen(0, "127.0.0.1", resolve));
  const address = probe.server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await probe.close();
  app = createApp(config(address.port), { editor: false, approvalWaitMs: 4_000 });
  await app.listen();
  base = `http://127.0.0.1:${address.port}`;
}

async function post(pathname: string, form: Record<string, string>, cookie = ""): Promise<Response> {
  return fetch(`${base}${pathname}`, { method: "POST", redirect: "manual", headers: { origin: base, cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
}

async function signUp(email: string, name: string): Promise<string> {
  const response = await post("/signup", { name, email, password: "correct-horse" });
  expect(response.status).toBe(303);
  const cookie = (response.headers.get("set-cookie") ?? "").match(/mutinybim_session=[^;]+/)?.[0];
  if (!cookie) throw new Error("no session cookie");
  return cookie;
}

async function makeModel(cookie: string, name: string): Promise<string> {
  const response = await post("/models", { name, start: "blank" }, cookie);
  const id = response.headers.get("location")?.match(/\/m\/([a-z0-9-]+)/)?.[1];
  if (!id) throw new Error("no model id");
  return id;
}

async function register(redirectUris: readonly string[] = [REDIRECT]): Promise<Response> {
  return fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Test Assistant", redirect_uris: redirectUris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }) });
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** The whole sign-in an assistant does: register, the person allows, the code for tokens. */
async function signInAssistant(cookie: string, resource = `${base}/mcp`): Promise<{ clientId: string; access: string; refresh: string; consentHtml: string }> {
  const registered = (await (await register()).json()) as { client_id: string };
  const { verifier, challenge } = pkce();
  const params = new URLSearchParams({ response_type: "code", client_id: registered.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s-1", scope: "models", resource });
  const consent = await fetch(`${base}/oauth/authorize?${params}`, { headers: { cookie } });
  expect(consent.status).toBe(200);
  const consentHtml = await consent.text();
  expect(consentHtml).toContain("Let “Test Assistant” use your models?");
  // The browser checks form-action on every redirect after Allow, and an assistant's callback can go on to its app scheme.
  expect(consent.headers.get("content-security-policy")).not.toContain("form-action");
  const allowed = await post("/oauth/authorize", { request: params.toString(), decision: "allow" }, cookie);
  expect(allowed.status).toBe(303);
  const back = new URL(allowed.headers.get("location") ?? "");
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
  expect(back.searchParams.get("state")).toBe("s-1");
  expect(back.searchParams.get("iss")).toBe(base);
  const code = back.searchParams.get("code") ?? "";
  const token = async (verifierUsed: string) =>
    fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: registered.client_id, code_verifier: verifierUsed, resource }).toString() });
  const wrong = await token(pkce().verifier);
  expect(wrong.status).toBe(400);
  expect(((await wrong.json()) as { error: string }).error).toBe("invalid_grant");
  // A wrong verifier used the code up, as a stolen code would be: sign in again for a fresh one.
  const again = await post("/oauth/authorize", { request: params.toString(), decision: "allow" }, cookie);
  const code2 = new URL(again.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const ok = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: code2, redirect_uri: REDIRECT, client_id: registered.client_id, code_verifier: verifier, resource }).toString() });
  expect(ok.status).toBe(200);
  const tokens = (await ok.json()) as { access_token: string; refresh_token: string; token_type: string; expires_in: number };
  expect(tokens.token_type).toBe("Bearer");
  expect(tokens.expires_in).toBe(3600);
  const reused = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: code2, redirect_uri: REDIRECT, client_id: registered.client_id, code_verifier: verifier }).toString() });
  expect(reused.status).toBe(400);
  return { clientId: registered.client_id, access: tokens.access_token, refresh: tokens.refresh_token, consentHtml };
}

async function connect(access: string, pathname = "/mcp", elicit?: (message: string) => "accept" | "decline" | Promise<"accept" | "decline">): Promise<Client> {
  const client = new Client({ name: "test-assistant", version: "1.0.0" }, elicit ? { capabilities: { elicitation: {} } } : {});
  if (elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const said = await elicit(String(request.params.message));
      return said === "accept" ? { action: "accept", content: { approve: true } } : { action: "decline" };
    });
  }
  await client.connect(new StreamableHTTPClientTransport(new URL(pathname, base), { requestInit: { headers: { authorization: `Bearer ${access}` } } }));
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content?: { text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "mutinybim-web-mcp-"));
  await start();
});

afterEach(async () => {
  await app?.close();
  app = null;
  await rm(dataDir, { recursive: true, force: true });
});

test("discovery: /mcp asks for sign-in and names its metadata, which names this app's sign-in server", async () => {
  const bare = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  expect(bare.status).toBe(401);
  const challenge = bare.headers.get("www-authenticate") ?? "";
  expect(challenge).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
  expect(challenge).toContain('scope="models"');
  const resource = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
  expect(resource).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["models"] });
  const family = (await (await fetch(`${base}/.well-known/oauth-protected-resource/packs/${EDIT_FAMILY}/mcp`)).json()) as Record<string, unknown>;
  expect(family.resource).toBe(`${base}/packs/${EDIT_FAMILY}/mcp`);
  expect((await fetch(`${base}/.well-known/oauth-protected-resource/packs/everything/mcp`)).status).toBe(404);
  const server = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
  expect(server).toMatchObject({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  });
});

test("registration refuses unsafe return addresses; sign-in needs the person, PKCE and a one-time code", async () => {
  const evil = await register(["http://evil.example/cb"]);
  expect(evil.status).toBe(400);
  expect(((await evil.json()) as { error: string }).error).toBe("invalid_redirect_uri");
  expect((await register(["javascript:alert(1)"])).status).toBe(400);
  const okDesktop = await register(["http://127.0.0.1:33418/callback", "cursor://anysphere.cursor-mcp/oauth/callback"]);
  expect(okDesktop.status).toBe(201);

  const registered = (await (await register()).json()) as { client_id: string };
  const signedOut = await fetch(`${base}/oauth/authorize?client_id=${registered.client_id}&response_type=code`, { redirect: "manual" });
  expect(signedOut.status).toBe(303);
  expect(signedOut.headers.get("location")).toMatch(/^\/login\?return_to=%2Foauth%2Fauthorize/);

  const cookie = await signUp("sam@example.com", "Sam Example");
  const wrongBack = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ client_id: registered.client_id, response_type: "code", redirect_uri: "https://elsewhere.example/cb", code_challenge: pkce().challenge, code_challenge_method: "S256" })}`, { headers: { cookie }, redirect: "manual" });
  expect(wrongBack.status).toBe(400);
  expect(await wrongBack.text()).toContain("didn&#x27;t register");
  const noPkce = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ client_id: registered.client_id, response_type: "code", redirect_uri: REDIRECT, state: "x" })}`, { headers: { cookie }, redirect: "manual" });
  expect(noPkce.status).toBe(303);
  expect(new URL(noPkce.headers.get("location") ?? "").searchParams.get("error")).toBe("invalid_request");
  const otherServer = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ client_id: registered.client_id, response_type: "code", redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: "S256", resource: "https://other.example/mcp" })}`, { headers: { cookie }, redirect: "manual" });
  expect(new URL(otherServer.headers.get("location") ?? "").searchParams.get("error")).toBe("invalid_target");

  const declined = await post("/oauth/authorize", { request: new URLSearchParams({ client_id: registered.client_id, response_type: "code", redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: "S256", state: "d" }).toString(), decision: "deny" }, cookie);
  expect(new URL(declined.headers.get("location") ?? "").searchParams.get("error")).toBe("access_denied");

  const tokens = await signInAssistant(cookie);
  const connectPage = await (await fetch(`${base}/connect`, { headers: { cookie } })).text();
  expect(connectPage).toContain(`${base}/mcp`);
  expect(connectPage).toContain("Test Assistant");
  expect(tokens.access.startsWith("mba_")).toBe(true);
});

test("tokens: refresh rotates, a reused refresh token ends the sign-in, and signing out from Connect ends it too", async () => {
  const cookie = await signUp("sam@example.com", "Sam Example");
  const first = await signInAssistant(cookie);
  const refresh = (token: string) => fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: first.clientId }).toString() });
  const rotated = await refresh(first.refresh);
  expect(rotated.status).toBe(200);
  const next = (await rotated.json()) as { access_token: string; refresh_token: string };
  expect(next.refresh_token).not.toBe(first.refresh);
  const oldAccess = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${first.access}`, "content-type": "application/json" }, body: "{}" });
  expect(oldAccess.status).toBe(401);
  expect(oldAccess.headers.get("www-authenticate")).toContain('error="invalid_token"');
  const client = await connect(next.access_token);
  await client.close();
  const replay = await refresh(first.refresh);
  expect(replay.status).toBe(400);
  const ended = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${next.access_token}`, "content-type": "application/json" }, body: "{}" });
  expect(ended.status).toBe(401);

  const second = await signInAssistant(cookie);
  const page = await (await fetch(`${base}/connect`, { headers: { cookie } })).text();
  const grantId = page.match(/\/connect\/assistants\/([0-9a-f-]{36})\/delete/)?.[1];
  expect(grantId).toBeTruthy();
  await post(`/connect/assistants/${grantId}/delete`, {}, cookie);
  expect((await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${second.access}`, "content-type": "application/json" }, body: "{}" })).status).toBe(401);
});

test("/mcp lists only the core (ten at most); /packs/<family>/mcp adds that family", async () => {
  const cookie = await signUp("sam@example.com", "Sam Example");
  const { access } = await signInAssistant(cookie);
  const core = await connect(access);
  const names = (await core.listTools()).tools.map((t) => t.name);
  expect(names).toEqual([...CORE_TOOLS, PACK_CONTROL_TOOL]);
  expect(names.length).toBeLessThanOrEqual(CORE_TOOL_BUDGET);
  expect(core.getInstructions()).toContain("Sam Example");
  await core.close();
  const family = await connect(access, `/packs/${EDIT_FAMILY}/mcp`);
  expect((await family.listTools()).tools.map((t) => t.name)).toContain("bim_create_level");
  await family.close();
});

test("every change asks first: the assistant's own box, or the approvals page; a decline changes nothing", async () => {
  const cookie = await signUp("sam@example.com", "Sam Example");
  const modelId = await makeModel(cookie, "Sample Warehouse");
  const { access } = await signInAssistant(cookie);
  const levels = async () => Object.values((await app?.models.head(modelId))?.elements ?? {}).filter((e) => e.kind === "level").length;
  expect(await levels()).toBe(1);

  const asked: string[] = [];
  const withBox = await connect(access, `/packs/${EDIT_FAMILY}/mcp`, (message) => (asked.push(message), "accept"));
  const landed = await withBox.callTool({ name: "bim_create_level", arguments: { project_id: HOSTED_PROJECT_ID, model_id: modelId, name: "Level 2", elevation_ft: 12 } });
  expect(asked[0]).toContain("Sample Warehouse");
  expect(textOf(landed)).toContain('"saved"');
  expect(await levels()).toBe(2);
  await withBox.close();

  // A person who reads the box and says no: declined, nothing changes.
  const declining = await connect(access, `/packs/${EDIT_FAMILY}/mcp`, () => new Promise((r) => setTimeout(() => r("decline"), 1_700)));
  const refused = await declining.callTool({ name: "bim_create_level", arguments: { project_id: HOSTED_PROJECT_ID, model_id: modelId, name: "Level 3", elevation_ft: 24 } });
  expect(textOf(refused)).toContain("declined");
  expect(await levels()).toBe(2);
  await declining.close();

  // An assistant that says no at once never showed the box: the change waits on the approvals page instead.
  const hasty = await connect(access, `/packs/${EDIT_FAMILY}/mcp`, () => "decline");
  const hastyCall = textOf(await hasty.callTool({ name: "bim_create_level", arguments: { project_id: HOSTED_PROJECT_ID, model_id: modelId, name: "Hasty", elevation_ft: 50 } }));
  expect(hastyCall).toContain("awaiting_approval");
  const hastyId = hastyCall.match(/\/approvals\/([0-9a-f-]{36})/)?.[1];
  expect((await post(`/approvals/${hastyId}`, { decision: "decline" }, cookie)).status).toBe(200);
  expect(await levels()).toBe(2);
  await hasty.close();

  // No approval box: the change waits on the approvals page; approving it there lands it.
  const plain = await connect(access, `/packs/${EDIT_FAMILY}/mcp`);
  const call = plain.callTool({ name: "bim_create_level", arguments: { project_id: HOSTED_PROJECT_ID, model_id: modelId, name: "Level 3", elevation_ft: 24 } });
  let approvalId: string | undefined;
  for (let i = 0; i < 40 && !approvalId; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
    approvalId = (await (await fetch(`${base}/approvals`, { headers: { cookie } })).text()).match(/\/approvals\/([0-9a-f-]{36})"/)?.[1];
  }
  expect(approvalId).toBeTruthy();
  const answered = await post(`/approvals/${approvalId}`, { decision: "approve" }, cookie);
  expect(answered.status).toBe(200);
  expect(textOf(await call)).toContain('"saved"');
  expect(await levels()).toBe(3);

  // Nobody answers in time: the call returns "waiting", and approving later still lands it.
  const late = await plain.callTool({ name: "bim_create_level", arguments: { project_id: HOSTED_PROJECT_ID, model_id: modelId, name: "Level 4", elevation_ft: 36 } });
  const words = textOf(late);
  expect(words).toContain("awaiting_approval");
  const lateId = words.match(/\/approvals\/([0-9a-f-]{36})/)?.[1];
  expect(await levels()).toBe(3);
  const page = await (await post(`/approvals/${lateId}`, { decision: "approve" }, cookie)).text();
  expect(page).toContain("Approved and applied");
  expect(await levels()).toBe(4);
  await plain.close();
}, 30_000);

test("a waiting change shows on every signed-in page and to the editor, only to its person, and reads Applied once it landed", async () => {
  const sam = await signUp("sam@example.com", "Sam Example");
  const pat = await signUp("pat@example.com", "Pat Example");
  const modelId = await makeModel(sam, "Sample Warehouse");
  const { access } = await signInAssistant(sam);
  const pageOf = async (pathname: string, cookie: string) => (await fetch(`${base}${pathname}`, { headers: { cookie } })).text();
  const waitingOf = (cookie: string) => fetch(`${base}/api/hosted/approvals/waiting`, { headers: cookie ? { cookie } : {} });
  type Waiting = { waiting: { id: string; assistant: string; modelId: string; modelName: string; title: string; href: string }[] };

  // Nothing waiting: the Approvals link is there with no count, and no notice.
  const quiet = await pageOf("/models", sam);
  expect(quiet).toContain('data-testid="nav-approvals"');
  expect(quiet).toMatch(/hidden=""[^>]*data-testid="nav-approvals-count">0</);
  expect(quiet).not.toContain('data-testid="approval-notice"');
  expect(quiet).toContain("<title>My models");
  expect(await (await waitingOf(sam)).json()).toEqual({ waiting: [] });

  const plain = await connect(access, `/packs/${EDIT_FAMILY}/mcp`);
  const call = plain.callTool({ name: "bim_create_level", arguments: { project_id: HOSTED_PROJECT_ID, model_id: modelId, name: "Level 2", elevation_ft: 12 } });
  let waiting: Waiting["waiting"] = [];
  for (let i = 0; i < 40 && waiting.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
    waiting = ((await (await waitingOf(sam)).json()) as Waiting).waiting;
  }
  expect(waiting).toHaveLength(1);
  const id = waiting[0]?.id ?? "";
  expect(waiting[0]).toMatchObject({ assistant: "Test Assistant", modelId, modelName: "Sample Warehouse", title: "Create level “Level 2”, in “Sample Warehouse”", href: `/approvals/${id}` });

  // Only its person: someone else and a signed-out caller see nothing, and can't answer it.
  expect(await (await waitingOf(pat)).json()).toEqual({ waiting: [] });
  expect((await waitingOf("")).status).toBe(401);
  expect(await pageOf("/models", pat)).not.toContain('data-testid="approval-notice"');
  expect((await post(`/approvals/${id}`, { decision: "approve" }, pat)).status).toBe(404);
  const elsewhere = await fetch(`${base}/approvals/${id}`, { method: "POST", headers: { origin: "https://elsewhere.example", cookie: sam, "content-type": "application/x-www-form-urlencoded" }, body: "decision=approve" });
  expect(elsewhere.status).toBe(403);
  expect((await post(`/approvals/${id}`, {}, sam)).status).toBe(400);
  expect(((await (await waitingOf(sam)).json()) as Waiting).waiting).toHaveLength(1);

  // My models (and the other signed-in pages) say so: the count, who, which model by name, and Approve / Decline.
  for (const pathname of ["/models", "/connect", "/settings"]) {
    const shown = await pageOf(pathname, sam);
    expect(shown).toMatch(/data-testid="nav-approvals-count">1</);
    expect(shown).toContain('data-testid="approval-notice"');
    expect(shown).toContain("Test Assistant is waiting for your approval to change “Sample Warehouse”");
    expect(shown).toContain(`action="/approvals/${id}"`);
    expect(shown).toContain("<title>(1) ");
    expect(shown).toContain('src="/static/approvals.js"');
  }
  expect((await fetch(`${base}/static/approvals.js`)).status).toBe(200);

  // Approved from the editor's notice (a background post that reads JSON) while the assistant's call still waits.
  const answered = await fetch(`${base}/approvals/${id}`, { method: "POST", headers: { origin: base, cookie: sam, accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: "decision=approve" });
  expect(answered.status).toBe(200);
  expect(await answered.json()).toMatchObject({ id, state: "approved" });
  expect(textOf(await call)).toContain('"saved"');

  // The assistant applied it, so the page must not go on saying "applying it now".
  const item = await pageOf(`/approvals/${id}`, sam);
  expect(item).toContain("Approved and applied (model revision");
  expect(item).toContain(">Applied<");
  expect(item).not.toContain("applying it now");
  expect(await (await waitingOf(sam)).json()).toEqual({ waiting: [] });
  const after = await pageOf("/models", sam);
  expect(after).not.toContain('data-testid="approval-notice"');
  expect(after).toMatch(/hidden=""[^>]*data-testid="nav-approvals-count">0</);
  await plain.close();
}, 30_000);

test("an approval's title names the model and what changes, never the model's id", () => {
  const modelId = "m-0123456789abcdef0123";
  expect(approvalTitle({ summary: `land "Mechanical: supply ductwork" in model ${modelId} as one undo step: 319 new, 0 changed, 0 deleted`, modelId, modelName: "Sample Project" })).toBe("Mechanical: supply ductwork — 319 new, 0 changed, 0 deleted, in “Sample Project”");
  expect(approvalTitle({ summary: `make the edit "create_level" in model ${modelId}`, modelId, modelName: "Sample Project" })).toBe("Make the edit \"create_level\" in “Sample Project”");
  expect(approvalTitle({ summary: "save 2 part types (Fan, Coil) and the script version to the library", modelId: "", modelName: "your script library" })).toBe("Save 2 part types (Fan, Coil) and the script version to the library");
});

test("an assistant lists East plant once and reads its new role in the same session", async () => {
  const alex = await signUp("alex@example.test", "Alex");
  const bea = await signUp("bea@example.test", "Bea");
  const modelId = await makeModel(alex, "East plant");
  const alexId = (await app?.db.userByEmail("alex@example.test"))?.id;
  const beaId = (await app?.db.userByEmail("bea@example.test"))?.id;
  if (!alexId || !beaId || !app) throw new Error("Missing fixture accounts");
  const sqlitePath = path.join(dataDir, "accounts.sqlite");
  seedTeamShare(sqlitePath, { id: "mech", name: "Mechanical", ownerId: alexId, memberId: beaId, modelId, role: "edit" });
  expect((await post(`/models/${modelId}/share`, { email: "bea@example.test", role: "view" }, alex)).status).toBe(200);
  await app.db.transfers.offer("open-offer", modelId, alexId, beaId, "none");
  const { access, consentHtml } = await signInAssistant(bea);
  expect(consentHtml).toContain("and the 1 shared with you");
  const client = await connect(access);
  try {
    const listing = () => client.callTool({ name: "bim_model_summary", arguments: { model_id: "list" } }).then(textOf);
    expect(client.getInstructions()).toContain("you can edit, shared by Alex, via Mechanical");
    expect((await listing()).match(/East plant/g)).toHaveLength(1);
    const db = new DatabaseSync(sqlitePath);
    try { db.prepare("DELETE FROM team_shares WHERE team_id = ? AND model_id = ?").run("mech", modelId); }
    finally { db.close(); }
    const changed = await listing();
    expect(changed).toContain(`East plant (model_id ${modelId}, view only, shared by Alex)`);
    expect(changed).not.toContain("Mechanical");
    expect(await app.db.transfers.respond("open-offer", beaId, "accept", 5)).toMatchObject({ state: "accepted" });
  } finally { await client.close(); }
}, 30_000);

test("a model shared view-only: the assistant reads it but can't change it, and is never asked to approve", async () => {
  const sam = await signUp("sam@example.com", "Sam Example");
  const modelId = await makeModel(sam, "Sample Warehouse");
  const pat = await signUp("pat@example.com", "Pat Example");
  expect((await post(`/models/${modelId}/share`, { email: "pat@example.com", role: "view" }, sam)).status).toBeLessThan(400);
  const strangerModel = await makeModel(sam, "Not shared");

  const { access } = await signInAssistant(pat);
  const asked: string[] = [];
  const client = await connect(access, `/packs/${EDIT_FAMILY}/mcp`, (message) => (asked.push(message), "accept"));
  const read = await client.callTool({ name: "bim_model_summary", arguments: { model_id: modelId } });
  expect(read.isError).toBeFalsy();
  const edit = await client.callTool({ name: "bim_create_level", arguments: { project_id: HOSTED_PROJECT_ID, model_id: modelId, name: "Level 2", elevation_ft: 12 } });
  expect(textOf(edit)).toContain("view-only");
  expect(asked).toEqual([]);
  const levels = Object.values((await app?.models.head(modelId))?.elements ?? {}).filter((e) => e.kind === "level").length;
  expect(levels).toBe(1);
  const notShared = await client.callTool({ name: "bim_model_summary", arguments: { model_id: strangerModel } });
  expect(notShared.isError).toBe(true);
  expect(textOf(notShared)).toContain("isn't in your account or shared with you");
  // An assistant that was never shown the sign-in instructions can still find the person's models.
  const tools = await client.listTools();
  expect(JSON.stringify(tools.tools.find((t) => t.name === "bim_model_summary")?.inputSchema)).toContain('Pass \\"list\\"');
  const listed = await client.callTool({ name: "bim_model_summary", arguments: { model_id: "list" } });
  expect(listed.isError).toBeFalsy();
  expect(textOf(listed)).toContain(`Sample Warehouse (model_id ${modelId}, view only, shared by Sam Example)`);
  expect(textOf(listed)).not.toContain(strangerModel);
  await client.close();
}, 30_000);

test("an assistant can name itself by a client metadata address instead of registering; private addresses are never fetched", async () => {
  await app?.close();
  const clientId = "https://assistant.example/mcp-client.json";
  const fetched: string[] = [];
  const probe = createApp(config(0), { editor: false });
  await new Promise<void>((resolve) => probe.server.listen(0, "127.0.0.1", resolve));
  const address = probe.server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await probe.close();
  app = createApp(config(address.port), {
    editor: false,
    resolveHost: async (host) => (host === "assistant.example" ? ["203.0.113.7"] : ["10.0.0.5"]),
    fetchImpl: async (url) => {
      fetched.push(url);
      return new Response(JSON.stringify({ client_id: clientId, client_name: "Metadata Assistant", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }), { status: 200 });
    },
  });
  await app.listen();
  base = `http://127.0.0.1:${address.port}`;
  const cookie = await signUp("sam@example.com", "Sam Example");
  const params = (id: string) => new URLSearchParams({ response_type: "code", client_id: id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: "S256" });
  const consent = await fetch(`${base}/oauth/authorize?${params(clientId)}`, { headers: { cookie } });
  expect(consent.status).toBe(200);
  expect(await consent.text()).toContain("Metadata Assistant");
  expect(fetched).toEqual([clientId]);
  const inside = await fetch(`${base}/oauth/authorize?${params("https://intranet.example/client.json")}`, { headers: { cookie } });
  expect(inside.status).toBe(400);
  expect(await inside.text()).toContain("private address");
  expect(fetched).toEqual([clientId]);
});

/** A confidential client: registers for a secret, the person allows, then the code (with PKCE) and the secret for tokens. */
async function signInConfidential(cookie: string, method: "client_secret_post" | "client_secret_basic"): Promise<void> {
  const registration = await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Secret Assistant", redirect_uris: [REDIRECT], token_endpoint_auth_method: method, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
  expect(registration.status).toBe(201);
  const registered = (await registration.json()) as { client_id: string; client_secret?: string; token_endpoint_auth_method: string; client_secret_expires_at?: number };
  expect(registered.token_endpoint_auth_method).toBe(method);
  expect(registered.client_secret_expires_at).toBe(0);
  const secret = registered.client_secret ?? "";
  expect(secret.length).toBeGreaterThan(30);
  const { verifier, challenge } = pkce();
  const params = new URLSearchParams({ response_type: "code", client_id: registered.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s-2", scope: "models offline_access" });
  const consent = await fetch(`${base}/oauth/authorize?${params}`, { headers: { cookie } });
  expect(consent.status).toBe(200);
  const allow = async () => new URL((await post("/oauth/authorize", { request: params.toString(), decision: "allow" }, cookie)).headers.get("location") ?? "").searchParams.get("code") ?? "";
  const basic = (id: string, s: string) => `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(s)}`).toString("base64")}`;
  const token = (form: Record<string, string>, secretUsed: string | null) => {
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    const body: Record<string, string> = { ...form };
    if (secretUsed !== null && method === "client_secret_basic") headers.authorization = basic(registered.client_id, secretUsed);
    else body.client_id = registered.client_id;
    if (secretUsed !== null && method === "client_secret_post") body.client_secret = secretUsed;
    return fetch(`${base}/oauth/token`, { method: "POST", headers, body: new URLSearchParams(body).toString() });
  };
  const missing = await token({ grant_type: "authorization_code", code: await allow(), redirect_uri: REDIRECT, code_verifier: verifier }, null);
  expect(missing.status).toBe(401);
  expect(((await missing.json()) as { error: string }).error).toBe("invalid_client");
  const wrong = await token({ grant_type: "authorization_code", code: await allow(), redirect_uri: REDIRECT, code_verifier: verifier }, "mbs_not-the-secret");
  expect(wrong.status).toBe(401);
  const noPkce = await token({ grant_type: "authorization_code", code: await allow(), redirect_uri: REDIRECT, code_verifier: pkce().verifier }, secret);
  expect(noPkce.status).toBe(400);
  const ok = await token({ grant_type: "authorization_code", code: await allow(), redirect_uri: REDIRECT, code_verifier: verifier }, secret);
  expect(ok.status).toBe(200);
  const tokens = (await ok.json()) as { access_token: string; refresh_token: string };
  const refreshed = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }, secret);
  expect(refreshed.status).toBe(200);
  const fresh = (await refreshed.json()) as { access_token: string };
  const client = await connect(fresh.access_token);
  expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  await client.close();
}

test("a confidential assistant (client_secret_post) gets a secret at registration and must send it, with PKCE, for tokens", async () => {
  await signInConfidential(await signUp("pat@example.com", "Pat Example"), "client_secret_post");
}, 30_000);

test("a confidential assistant (client_secret_basic) proves its secret with HTTP Basic", async () => {
  await signInConfidential(await signUp("lee@example.com", "Lee Example"), "client_secret_basic");
}, 30_000);

test("a metadata document that prefers private_key_jwt but supports none signs in as a public client; one without none is refused", async () => {
  await app?.close();
  const both = "https://assistant.example/oauth/client-both.json";
  const keyOnly = "https://assistant.example/oauth/client-key-only.json";
  const probe = createApp(config(0), { editor: false });
  await new Promise<void>((resolve) => probe.server.listen(0, "127.0.0.1", resolve));
  const address = probe.server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await probe.close();
  app = createApp(config(address.port), {
    editor: false,
    resolveHost: async () => ["203.0.113.7"],
    fetchImpl: async (url) => {
      const methods = url === both ? ["none", "private_key_jwt"] : ["private_key_jwt"];
      return new Response(JSON.stringify({ client_id: url, client_name: "Key Assistant", redirect_uris: [REDIRECT], token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_methods_supported: methods, jwks_uri: "https://assistant.example/oauth/jwks.json" }), { status: 200 });
    },
  });
  await app.listen();
  base = `http://127.0.0.1:${address.port}`;
  const cookie = await signUp("kim@example.com", "Kim Example");
  const { verifier, challenge } = pkce();
  const params = new URLSearchParams({ response_type: "code", client_id: both, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", scope: "models", resource: `${base}/mcp` });
  const consent = await fetch(`${base}/oauth/authorize?${params}`, { headers: { cookie } });
  expect(consent.status).toBe(200);
  expect(await consent.text()).toContain("Key Assistant");
  const allowed = await post("/oauth/authorize", { request: params.toString(), decision: "allow" }, cookie);
  const code = new URL(allowed.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const ok = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: both, code_verifier: verifier }).toString() });
  expect(ok.status).toBe(200);
  const refused = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: keyOnly, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" })}`, { headers: { cookie } });
  expect(refused.status).toBe(400);
});

test("when a metadata address answers 403, pinned Claude and Claude Code still complete sign-in (with ephemeral loopback ports); a live document always wins once reachable", async () => {
  await app?.close();
  const claude = "https://claude.ai/oauth/mcp-oauth-client-metadata";
  const claudeCallback = "https://claude.ai/api/mcp/auth_callback";
  const claudeCode = "https://claude.ai/oauth/claude-code-client-metadata";
  let liveClaude = false;
  const probe = createApp(config(0), { editor: false });
  await new Promise<void>((resolve) => probe.server.listen(0, "127.0.0.1", resolve));
  const address = probe.server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await probe.close();
  app = createApp(config(address.port), {
    editor: false,
    resolveHost: async () => ["203.0.113.7"],
    fetchImpl: async (url) => {
      if (liveClaude && url === claude) {
        return new Response(JSON.stringify({ client_id: claude, client_name: "Claude Live", redirect_uris: [claudeCallback], token_endpoint_auth_method: "none" }), { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    },
  });
  await app.listen();
  base = `http://127.0.0.1:${address.port}`;
  const cookie = await signUp("sam@example.com", "Sam Example");
  const authParams = (id: string, redirect: string, challenge: string) =>
    new URLSearchParams({ response_type: "code", client_id: id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", scope: "models", resource: `${base}/mcp` });

  // Claude (hosted web/Desktop/iOS/Cowork): pinned fallback works end-to-end when claude.ai answers 403.
  const claudePkce = pkce();
  const claudeReq = authParams(claude, claudeCallback, claudePkce.challenge);
  const claudeConsent = await fetch(`${base}/oauth/authorize?${claudeReq}`, { headers: { cookie } });
  expect(claudeConsent.status).toBe(200);
  expect(await claudeConsent.text()).toContain("Let “Claude” use your models?");
  const claudeAllowed = await post("/oauth/authorize", { request: claudeReq.toString(), decision: "allow" }, cookie);
  expect(claudeAllowed.status).toBe(303);
  const claudeCodeParam = new URL(claudeAllowed.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const claudeToken = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: claudeCodeParam, redirect_uri: claudeCallback, client_id: claude, code_verifier: claudePkce.verifier, resource: `${base}/mcp` }).toString(),
  });
  expect(claudeToken.status).toBe(200);
  const claudeAccess = ((await claudeToken.json()) as { access_token: string }).access_token;
  const claudeClient = await connect(claudeAccess);
  expect((await claudeClient.listTools()).tools.length).toBeGreaterThan(0);
  await claudeClient.close();

  // Claude is still locked to its exact published callback (no arbitrary URL, no non-loopback port swap).
  const elsewhere = await fetch(`${base}/oauth/authorize?${authParams(claude, REDIRECT, pkce().challenge)}`, { headers: { cookie } });
  expect(elsewhere.status).toBe(400);
  expect(await elsewhere.text()).toContain("an address it didn&#x27;t register");
  const wrongPort = await fetch(`${base}/oauth/authorize?${authParams(claude, "https://claude.ai:8443/api/mcp/auth_callback", pkce().challenge)}`, { headers: { cookie } });
  expect(wrongPort.status).toBe(400);

  // Claude Code: pinned fallback + ephemeral loopback port matching (localhost and 127.0.0.1).
  const codePkce = pkce();
  const codeCallback = "http://localhost:3118/callback";
  const codeReq = authParams(claudeCode, codeCallback, codePkce.challenge);
  const codeConsent = await fetch(`${base}/oauth/authorize?${codeReq}`, { headers: { cookie } });
  expect(codeConsent.status).toBe(200);
  const codeHtml = await codeConsent.text();
  expect(codeHtml).toContain("Let “Claude Code” use your models?");
  expect(codeHtml).toContain("localhost:3118");
  const codeAllowed = await post("/oauth/authorize", { request: codeReq.toString(), decision: "allow" }, cookie);
  expect(codeAllowed.status).toBe(303);
  const codeBack = new URL(codeAllowed.headers.get("location") ?? "");
  expect(`${codeBack.origin}${codeBack.pathname}`).toBe(codeCallback);
  const authCode = codeBack.searchParams.get("code") ?? "";
  // Token exchange still requires the exact redirect_uri (including port) used at /oauth/authorize.
  const wrongTokenPort = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: authCode, redirect_uri: "http://localhost:9999/callback", client_id: claudeCode, code_verifier: codePkce.verifier }).toString(),
  });
  expect(wrongTokenPort.status).toBe(400);
  const codeAllowed2 = await post("/oauth/authorize", { request: codeReq.toString(), decision: "allow" }, cookie);
  const authCode2 = new URL(codeAllowed2.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const codeToken = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: authCode2, redirect_uri: codeCallback, client_id: claudeCode, code_verifier: codePkce.verifier, resource: `${base}/mcp` }).toString(),
  });
  expect(codeToken.status).toBe(200);
  expect((await fetch(`${base}/oauth/authorize?${authParams(claudeCode, "http://127.0.0.1:54321/callback", pkce().challenge)}`, { headers: { cookie } })).status).toBe(200);
  expect((await fetch(`${base}/oauth/authorize?${authParams(claudeCode, "http://localhost:3118/other", pkce().challenge)}`, { headers: { cookie } })).status).toBe(400);
  expect((await fetch(`${base}/oauth/authorize?${authParams(claudeCode, "http://[::1]:3118/callback", pkce().challenge)}`, { headers: { cookie } })).status).toBe(400);

  // Connect page shows both assistants by name, not "An assistant".
  const connectHtml = await (await fetch(`${base}/connect`, { headers: { cookie } })).text();
  expect(connectHtml).toContain("Claude");
  expect(connectHtml).toContain("Claude Code");

  // Unknown assistants still see the real fetch error.
  const unknown = await fetch(`${base}/oauth/authorize?${authParams("https://assistant.example/mcp-client.json", REDIRECT, pkce().challenge)}`, { headers: { cookie } });
  expect(unknown.status).toBe(400);
  expect(await unknown.text()).toContain("metadata answered 403");

  // Because the pin is not persisted, a live document takes effect right away once claude.ai answers 200.
  liveClaude = true;
  const liveConsent = await fetch(`${base}/oauth/authorize?${authParams(claude, claudeCallback, pkce().challenge)}`, { headers: { cookie } });
  expect(liveConsent.status).toBe(200);
  expect(await liveConsent.text()).toContain("Let “Claude Live” use your models?");
}, 30_000);

test("stale cached metadata survives a failed refresh, and loopback redirect matching follows RFC 8252 + localhost", async () => {
  expect(redirectUriMatches("http://127.0.0.1/callback", "http://127.0.0.1:43210/callback")).toBe(true);
  expect(redirectUriMatches("http://[::1]/callback", "http://[::1]:43210/callback")).toBe(true);
  expect(redirectUriMatches("http://localhost/callback", "http://localhost:3118/callback")).toBe(true);
  expect(redirectUriMatches("http://localhost/callback", "http://127.0.0.1:3118/callback")).toBe(false);
  expect(redirectUriMatches("http://localhost/callback", "http://localhost:3118/callback?extra=1")).toBe(false);
  expect(redirectUriMatches("http://localhost/callback", "http://localhost:3118/callback#frag")).toBe(false);
  expect(redirectUriMatches("http://localhost/callback", "http://user@localhost:3118/callback")).toBe(false);
  expect(redirectUriMatches("https://localhost/callback", "https://localhost:3118/callback")).toBe(false);
  expect(redirectUriMatches("https://claude.ai/api/mcp/auth_callback", "https://claude.ai/api/mcp/auth_callback")).toBe(true);

  const db = openDb(":memory:");
  try {
    const clientId = "https://assistant.example/oauth/stale-client.json";
    await db.saveAssistantClient({ clientId, clientName: "Cached Assistant", redirectUris: [REDIRECT], kind: "metadata" });
    const staleDb = {
      ...db,
      async assistantClient(id: string) {
        const row = await db.assistantClient(id);
        return row ? { ...row, created_at: "2020-01-01T00:00:00.000Z" } : null;
      },
    };
    const params = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: "S256" });
    const on403 = await checkAuthorize(params, {
      origin: "https://app.example",
      families: [],
      db: staleDb,
      resolveHost: async () => ["203.0.113.7"],
      fetchImpl: async () => new Response("Forbidden", { status: 403 }),
    });
    expect(on403.ok).toBe(true);
    if (on403.ok) expect(on403.request.client.client_name).toBe("Cached Assistant");

    const onError = await checkAuthorize(params, {
      origin: "https://app.example",
      families: [],
      db: staleDb,
      resolveHost: async () => ["203.0.113.7"],
      fetchImpl: async () => {
        throw new Error("ECONNRESET");
      },
    });
    expect(onError.ok).toBe(true);
    if (onError.ok) expect(onError.request.client.client_name).toBe("Cached Assistant");
  } finally {
    await db.close();
  }
});
