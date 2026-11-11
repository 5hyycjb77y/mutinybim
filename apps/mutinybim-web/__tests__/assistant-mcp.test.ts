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
import { HOSTED_PROJECT_ID } from "../src/assistant-tools";
import type { WebConfig } from "../src/config";

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
async function signInAssistant(cookie: string, resource = `${base}/mcp`): Promise<{ clientId: string; access: string; refresh: string }> {
  const registered = (await (await register()).json()) as { client_id: string };
  const { verifier, challenge } = pkce();
  const params = new URLSearchParams({ response_type: "code", client_id: registered.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s-1", scope: "models", resource });
  const consent = await fetch(`${base}/oauth/authorize?${params}`, { headers: { cookie } });
  expect(consent.status).toBe(200);
  expect(await consent.text()).toContain("Let “Test Assistant” use your models?");
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
  return { clientId: registered.client_id, access: tokens.access_token, refresh: tokens.refresh_token };
}

async function connect(access: string, pathname = "/mcp", elicit?: (message: string) => "accept" | "decline"): Promise<Client> {
  const client = new Client({ name: "test-assistant", version: "1.0.0" }, elicit ? { capabilities: { elicitation: {} } } : {});
  if (elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const said = elicit(String(request.params.message));
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

  const declining = await connect(access, `/packs/${EDIT_FAMILY}/mcp`, () => "decline");
  const refused = await declining.callTool({ name: "bim_create_level", arguments: { project_id: HOSTED_PROJECT_ID, model_id: modelId, name: "Level 3", elevation_ft: 24 } });
  expect(textOf(refused)).toContain("declined");
  expect(await levels()).toBe(2);
  await declining.close();

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
