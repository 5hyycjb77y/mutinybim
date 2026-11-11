/**
 * @jest-environment node
 *
 * Scripts from an outside assistant over /mcp, and what survives a restart.
 *
 * - The rooftop unit recipe end to end: the assistant reads the reference
 *   (scripts ready), checks the starter part script, previews it (nothing
 *   saved) and saves its part types after the person approves in the
 *   assistant's own box.
 * - A layout script: preview changes nothing; bim_apply_output waits for the
 *   person on the approvals page and lands when they approve. A model shared
 *   view-only previews but never lands, and nobody is asked.
 * - A restart: the assistant's session carries on (with the family it turned
 *   on) and a change approved after the restart still lands.
 *
 * The runner here is the open local one (this test runs on any computer);
 * the sealed box it runs in on the server is script-sandbox.test.ts.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { toolFamily } from "@permitzip/bim-mcp";
import { starterScriptItems } from "@permitzip/bim-script";
import { LocalScriptRunner } from "@permitzip/bim-script-runner/local";
import { createApp, type App } from "../src/app";
import { HOSTED_PROJECT_ID } from "../src/assistant-tools";
import type { WebConfig } from "../src/config";
import { localScripts, type HostedScripts } from "../src/script-sandbox";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const REDIRECT = "https://assistant.example/oauth/callback";
const EDIT_FAMILY = toolFamily("bim_create_level") ?? "";
const scripts: HostedScripts = localScripts(new LocalScriptRunner({ repoRoot: REPO_ROOT }));

let dataDir = "";
let port = 0;
let app: App | null = null;
let base = "";

function config(p: number): WebConfig {
  return { port: p, host: "127.0.0.1", origin: `http://127.0.0.1:${p}`, dataDir, modelLimit: 5, signupOpen: true, providers: [], quote: null, secure: false };
}

async function start(): Promise<void> {
  if (!port) {
    const probe = createApp(config(0), { editor: false, scripts });
    await new Promise<void>((resolve) => probe.server.listen(0, "127.0.0.1", resolve));
    const address = probe.server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    port = address.port;
    await probe.close();
  }
  app = createApp(config(port), { editor: false, approvalWaitMs: 1_500, scripts });
  await app.listen();
  base = `http://127.0.0.1:${port}`;
}

async function post(pathname: string, form: Record<string, string>, cookie = ""): Promise<Response> {
  return fetch(`${base}${pathname}`, { method: "POST", redirect: "manual", headers: { origin: base, cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
}

async function signUp(email: string, name: string): Promise<string> {
  const response = await post("/signup", { name, email, password: "correct-horse" });
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

/** Registers "Test Assistant", the person allows it, and the code is swapped for an access token. */
async function signInAssistant(cookie: string): Promise<string> {
  const registered = (await (await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Test Assistant", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }) })).json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const resource = `${base}/mcp`;
  const params = new URLSearchParams({ response_type: "code", client_id: registered.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s", scope: "models", resource });
  const allowed = await post("/oauth/authorize", { request: params.toString(), decision: "allow" }, cookie);
  const code = new URL(allowed.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const token = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: registered.client_id, code_verifier: verifier, resource }).toString() });
  return ((await token.json()) as { access_token: string }).access_token;
}

async function connect(access: string, elicit?: (message: string) => "accept" | "decline"): Promise<Client> {
  const client = new Client({ name: "test-assistant", version: "1.0.0" }, elicit ? { capabilities: { elicitation: {} } } : {});
  if (elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => (elicit(String(request.params.message)) === "accept" ? { action: "accept", content: { approve: true } } : { action: "decline" }));
  }
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base), { requestInit: { headers: { authorization: `Bearer ${access}` } } }));
  return client;
}

type Body = Record<string, unknown>;

async function call(client: Client, name: string, args: Body): Promise<Body> {
  const result = await client.callTool({ name, arguments: args });
  const text = ((result as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");
  return text.trimStart().startsWith("{") ? (JSON.parse(text) as Body) : { message: text };
}

async function waitingApproval(cookie: string): Promise<string> {
  for (let i = 0; i < 60; i += 1) {
    const id = (await (await fetch(`${base}/approvals`, { headers: { cookie } })).text()).match(/\/approvals\/([0-9a-f-]{36})"/)?.[1];
    if (id) return id;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("no approval request appeared");
}

const LEVEL_SCRIPT = (id: string, name: string, mm: number) =>
  [
    'import { defineScript } from "@permitzip/bim-script";',
    "export default defineScript({",
    '  kind: "layout",',
    "  reads: { levels: true },",
    "  parameters: {},",
    "  run(ctx) {",
    `    ctx.edit({ type: "create_level", levelId: "${id}", name: "${name}", elevationMm: ${mm} });`,
    "  },",
    "});",
    "",
  ].join("\n");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "mutinybim-web-scripts-"));
  port = 0;
  await start();
});

afterEach(async () => {
  await app?.close();
  app = null;
  await rm(dataDir, { recursive: true, force: true });
});

test("the rooftop unit recipe through /mcp: reference, check, preview, then saved after the person approves", async () => {
  const cookie = await signUp("sam@example.com", "Sam Example");
  const access = await signInAssistant(cookie);
  const asked: string[] = [];
  const client = await connect(access, (message) => (asked.push(message), "accept"));
  const rtu = starterScriptItems().find((s) => s.key === "starter.rooftop_unit");
  if (!rtu) throw new Error("no rooftop unit starter");
  const script = { source: rtu.source, reads: rtu.manifest.reads };

  const reference = await call(client, "bim_script_reference", { search: "rooftop unit" });
  expect(JSON.stringify(reference.hits)).toContain("Rooftop unit");
  expect((await call(client, "bim_script_reference", {})).script_machine).toEqual({ ready: true });
  expect(await call(client, "bim_check_output", { script })).toMatchObject({ status: "ok", findings: [] });

  const preview = await call(client, "bim_run_script", { project_id: HOSTED_PROJECT_ID, script });
  expect(preview).toMatchObject({ status: "previewed", kind: "part_types" });
  expect(asked).toEqual([]);
  const args = { ...(preview.apply_with as { args: Body }).args, save_as: { key: "sample.rooftop_unit", name: "Rooftop unit", version: "1.0.0" } };
  const saved = await call(client, "bim_save_part_type", args);
  expect(saved).toMatchObject({ status: "saved", script: { key: "sample.rooftop_unit", result: "saved" } });
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain("Test Assistant");
  await client.close();
}, 120_000);

test("a layout script: preview changes nothing, apply waits for the person on the approvals page; view-only never lands", async () => {
  const sam = await signUp("sam@example.com", "Sam Example");
  const modelId = await makeModel(sam, "Sample Warehouse");
  const levels = async () => Object.values((await app?.models.head(modelId))?.elements ?? {}).filter((e) => e.kind === "level").length;
  const client = await connect(await signInAssistant(sam));
  const script = { source: LEVEL_SCRIPT("level-2", "Level 2", 4000), reads: { levels: true } };

  const preview = await call(client, "bim_run_script", { project_id: HOSTED_PROJECT_ID, model_id: modelId, script });
  expect(preview).toMatchObject({ status: "previewed", kind: "edits", changes: { creates: 1, edits: 0, deletes: 0 } });
  expect(await levels()).toBe(1);

  const applying = call(client, "bim_apply_output", (preview.apply_with as { args: Body }).args);
  const id = await waitingApproval(sam);
  expect(await (await fetch(`${base}/approvals/${id}`, { headers: { cookie: sam } })).text()).toContain("Sample Warehouse");
  // The list names the model, never its id.
  const listed = await (await fetch(`${base}/approvals`, { headers: { cookie: sam } })).text();
  expect(listed).toContain("1 new, 0 changed, 0 deleted, in “Sample Warehouse”");
  expect(listed).not.toContain(modelId);
  await post(`/approvals/${id}`, { decision: "approve" }, sam);
  expect(await applying).toMatchObject({ status: "saved" });
  // Approved while the assistant's call waited: once that call applied it, the page says so (not "applying it now" for good).
  const applied = await (await fetch(`${base}/approvals/${id}`, { headers: { cookie: sam } })).text();
  expect(applied).toContain("Approved and applied by your assistant.");
  expect(applied).toContain(">Applied<");
  expect(applied).not.toContain("applying it now");
  expect(await levels()).toBe(2);
  expect((await app?.models.head(modelId))?.elements["level-2"]).toMatchObject({ kind: "level", name: "Level 2" });
  await client.close();

  const pat = await signUp("pat@example.com", "Pat Example");
  await post(`/models/${modelId}/share`, { email: "pat@example.com", role: "view" }, sam);
  const asked: string[] = [];
  const viewer = await connect(await signInAssistant(pat), (message) => (asked.push(message), "accept"));
  const theirs = { source: LEVEL_SCRIPT("level-3", "Level 3", 8000), reads: { levels: true } };
  const viewed = await call(viewer, "bim_run_script", { project_id: HOSTED_PROJECT_ID, model_id: modelId, script: theirs });
  expect(viewed).toMatchObject({ status: "previewed" });
  const refused = await call(viewer, "bim_apply_output", (viewed.apply_with as { args: Body }).args);
  expect(JSON.stringify(refused)).toContain("view-only");
  expect(asked).toEqual([]);
  expect(await levels()).toBe(2);
  await viewer.close();
}, 120_000);

test("after a restart the assistant's session carries on, with its family on, and an approval still lands", async () => {
  const sam = await signUp("sam@example.com", "Sam Example");
  const modelId = await makeModel(sam, "Sample Warehouse");
  const client = await connect(await signInAssistant(sam));
  expect(await call(client, "bim_enable_pack", { family: EDIT_FAMILY })).toMatchObject({ message: expect.stringContaining("Turned on") });
  const waiting = await call(client, "bim_create_level", { project_id: HOSTED_PROJECT_ID, model_id: modelId, name: "Level 2", elevation_ft: 12 });
  expect(JSON.stringify(waiting)).toContain("awaiting_approval");
  const id = await waitingApproval(sam);

  await app?.close();
  await start();

  // The restart dropped the client's open connection; its next request (a new connection) finds the same session.
  const listed = await client.listTools().catch((err: unknown) => {
    if (!String(err).includes("fetch failed")) throw err;
    return client.listTools();
  });
  expect(listed.tools.map((t) => t.name)).toContain("bim_create_level");
  const page = await (await post(`/approvals/${id}`, { decision: "approve" }, sam)).text();
  expect(page).toContain("Approved and applied");
  expect(Object.values((await app?.models.head(modelId))?.elements ?? {}).filter((e) => e.kind === "level")).toHaveLength(2);
  await client.close();
}, 120_000);
