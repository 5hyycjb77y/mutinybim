/**
 * @jest-environment node
 *
 * Linked hosts (docs/LINKED-HOSTS.md) against a fake host on this computer:
 * the one extra Allow right after the first sign-in, the host's projects
 * under the person's own models with every state (listed, empty, host down,
 * reconnect, key missing), the pass kept only as ciphertext, an assistant's
 * core calls sent to the host with the host's ids (and answers in this app's
 * ids), view-only refused before asking, a change asked first, other
 * families kept off linked models, and turning it off handing the pass back.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { toolFamily } from "@permitzip/bim-mcp";
import { createApp, type App } from "../src/app";
import { HOSTED_PROJECT_ID } from "../src/assistant-tools";
import type { WebConfig } from "../src/config";
import { readLinkKeys, type LinkKeys } from "../src/linked-hosts";

const PROJECT = "11111111-2222-4333-8444-555555555555";
const VIEW_PROJECT = "66666666-7777-4888-8999-000000000000";
const ASSISTANT_REDIRECT = "https://assistant.example/oauth/callback";
const EDIT_FAMILY = toolFamily("bim_create_level") ?? "";

// ── The fake host ────────────────────────────────────────────────────────────

interface HostCall {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly agentName: string | null;
  readonly authorization: string | null;
}

interface FakeHost {
  readonly url: string;
  readonly calls: HostCall[];
  readonly revoked: string[];
  listStatus: number;
  refreshStatus: number;
  accessToken: string;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => resolve(raw));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function startHost(): Promise<FakeHost> {
  const host: FakeHost = { url: "", calls: [], revoked: [], listStatus: 200, refreshStatus: 200, accessToken: "pass-access-1", close: async () => undefined };
  const toolServer = (headers: IncomingMessage["headers"]) => {
    const server = new McpServer({ name: "fake-host", version: "1.0.0" });
    const record = (tool: string) => async (args: Record<string, unknown>) => {
      host.calls.push({ tool, args, agentName: typeof headers["x-linked-agent-name"] === "string" ? headers["x-linked-agent-name"] : null, authorization: typeof headers.authorization === "string" ? headers.authorization : null });
      return { content: [{ type: "text" as const, text: JSON.stringify({ status: "ok", tool, model_id: args.model_id, project_id: args.project_id }) }] };
    };
    for (const tool of ["bim_model_summary", "bim_run_script", "bim_apply_output"]) {
      server.registerTool(tool, { inputSchema: { project_id: z.string(), model_id: z.string(), label: z.string().optional() }, annotations: {} }, record(tool) as never);
    }
    return server;
  };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", host.url);
      const raw = req.method === "POST" ? await readBody(req) : "";
      if (url.pathname === "/.well-known/oauth-authorization-server") return json(res, 200, { authorization_endpoint: `${host.url}/authorize`, token_endpoint: `${host.url}/token`, registration_endpoint: `${host.url}/register`, userinfo_endpoint: `${host.url}/userinfo` });
      if (url.pathname === "/register") return json(res, 201, { client_id: `client-${JSON.parse(raw).scope}` });
      if (url.pathname === "/token") return json(res, 200, { access_token: "identity-token", token_type: "Bearer" });
      if (url.pathname === "/userinfo") return json(res, 200, { sub: "host-person-1", email: "pat@example.com", name: "Pat Example" });
      if (url.pathname === "/linked/token") {
        const form = new URLSearchParams(raw);
        if (form.get("grant_type") === "refresh_token") {
          if (host.refreshStatus !== 200) return json(res, host.refreshStatus, { error: "invalid_grant", error_description: "That connection ended." });
          host.accessToken = `pass-access-${randomBytes(4).toString("hex")}`;
          return json(res, 200, { access_token: host.accessToken, refresh_token: "pass-refresh-2", expires_in: 3600, token_type: "Bearer" });
        }
        if (form.get("code") !== "models-code" || form.get("client_id") !== "client-bim:models") return json(res, 400, { error: "invalid_grant" });
        return json(res, 200, { access_token: host.accessToken, refresh_token: "pass-refresh-1", expires_in: 3600, token_type: "Bearer", scope: "bim:models" });
      }
      if (url.pathname === "/linked/models") {
        if (req.headers.authorization !== `Bearer ${host.accessToken}`) return json(res, 401, { error: "reconnect" });
        if (host.listStatus !== 200) return json(res, host.listStatus, { error: "down" });
        return json(res, 200, {
          subject: "host-person-1",
          models: [
            { id: "site-9901", project_id: PROJECT, label: "9901 Sample Warehouse", group: "Example projects", can_edit: true, open_url: `${host.url}/models/${PROJECT}` },
            { id: "site-9902", project_id: VIEW_PROJECT, label: "9902 Sample Office", group: "Example projects", can_edit: false, open_url: "https://elsewhere.example/steal" },
          ],
        });
      }
      if (url.pathname === "/linked/revoke") {
        host.revoked.push(new URLSearchParams(raw).get("token") ?? "");
        return json(res, 200, {});
      }
      if (url.pathname === "/linked/mcp") {
        if (req.headers.authorization !== `Bearer ${host.accessToken}`) return json(res, 401, { error: "invalid_token" });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        const mcp = toolServer(req.headers);
        res.on("close", () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        return transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
      }
      json(res, 404, { error: "not here" });
    })().catch((err: unknown) => {
      console.error("fake host failed", err);
      if (!res.headersSent) json(res, 500, { error: String(err) });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return Object.assign(host, {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}

// ── The app ──────────────────────────────────────────────────────────────────

let dataDir = "";
let app: App | null = null;
let base = "";
let host: FakeHost;
const KEYS = readLinkKeys({ MUTINYBIM_WEB_LINK_KEY: "k".repeat(48) });

function config(port: number): WebConfig {
  return {
    port,
    host: "127.0.0.1",
    origin: `http://127.0.0.1:${port}`,
    dataDir,
    modelLimit: 5,
    signupOpen: true,
    quote: null,
    secure: false,
    providers: [
      {
        id: "example",
        label: "Log in with Example",
        issuer: host.url,
        scope: "identity",
        models: { label: "Example projects", scope: "bim:models", list: `${host.url}/linked/models`, mcp: `${host.url}/linked/mcp`, token: `${host.url}/linked/token`, revoke: `${host.url}/linked/revoke` },
      },
    ],
  };
}

async function start(linkKeys: LinkKeys | null = KEYS): Promise<void> {
  const probe = createApp(config(0), { editor: false, linkKeys });
  await new Promise<void>((resolve) => probe.server.listen(0, "127.0.0.1", resolve));
  const address = probe.server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await probe.close();
  app = createApp(config(address.port), { editor: false, approvalWaitMs: 3_000, linkKeys });
  await app.listen();
  base = `http://127.0.0.1:${address.port}`;
}

async function post(pathname: string, form: Record<string, string>, cookie = ""): Promise<Response> {
  return fetch(`${base}${pathname}`, { method: "POST", redirect: "manual", headers: { origin: base, cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
}

const page = async (pathname: string, cookie: string) => (await fetch(`${base}${pathname}`, { headers: { cookie } })).text();

/** Logs in with the host, then (unless `skipModels`) allows the models pass the app offers next. */
async function signInWithHost(options: { readonly skipModels?: boolean } = {}): Promise<string> {
  const begin = await fetch(`${base}/auth/example/start?return_to=%2Fmodels`, { redirect: "manual" });
  const state = new URL(begin.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const back = await fetch(`${base}/auth/example/callback?code=identity-code&state=${state}`, { redirect: "manual" });
  expect(back.status).toBe(303);
  expect(back.headers.get("location")).toBe("/auth/example/models/offer?return_to=%2Fmodels");
  const cookie = (back.headers.get("set-cookie") ?? "").match(/mutinybim_session=[^;]+/)?.[0] ?? "";
  expect(await page("/auth/example/models/offer?return_to=%2Fmodels", cookie)).toContain("Show your Example projects too?");
  if (options.skipModels) {
    const later = await post("/auth/example/models/offer", { return_to: "/models" }, cookie);
    expect(later.headers.get("location")).toBe("/models");
    return cookie;
  }
  const allow = await fetch(`${base}/auth/example/models/start?return_to=%2Fmodels`, { redirect: "manual", headers: { cookie } });
  const authorize = new URL(allow.headers.get("location") ?? "");
  expect(authorize.origin + authorize.pathname).toBe(`${host.url}/authorize`);
  expect(authorize.searchParams.get("scope")).toBe("bim:models");
  expect(authorize.searchParams.get("redirect_uri")).toBe(`${base}/auth/example/models/callback`);
  const linked = await fetch(`${base}/auth/example/models/callback?code=models-code&state=${authorize.searchParams.get("state")}`, { redirect: "manual", headers: { cookie } });
  expect(linked.status).toBe(303);
  expect(linked.headers.get("location")).toBe("/models?linked_models=example");
  return cookie;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function assistant(cookie: string, elicit: (() => "accept" | "decline") | null): Promise<Client> {
  const registered = (await (await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Test Assistant", redirect_uris: [ASSISTANT_REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }) })).json()) as { client_id: string };
  const { verifier, challenge } = pkce();
  const resource = `${base}/mcp`;
  const params = new URLSearchParams({ response_type: "code", client_id: registered.client_id, redirect_uri: ASSISTANT_REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s-1", scope: "models", resource });
  const allowed = await post("/oauth/authorize", { request: params.toString(), decision: "allow" }, cookie);
  const code = new URL(allowed.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const tokens = (await (await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: ASSISTANT_REDIRECT, client_id: registered.client_id, code_verifier: verifier, resource }).toString() })).json()) as { access_token: string };
  const client = new Client({ name: "test-assistant", version: "1.0.0" }, elicit ? { capabilities: { elicitation: {} } } : {});
  if (elicit) client.setRequestHandler(ElicitRequestSchema, async () => (elicit() === "accept" ? { action: "accept", content: { approve: true } } : { action: "decline" }));
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }));
  return client;
}

const textOf = (result: unknown): string => ((result as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");

const APPLY = { base_revision: 0, script: { source: "export default () => []", reads: {} }, output_hash: `sha256:${"a".repeat(64)}`, label: "Add Level 2", steps: 1, changes: { creates: 1, edits: 0, deletes: 0 }, approval: "ask_every_time" };

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "mutinybim-web-linked-"));
  host = await startHost();
});

afterEach(async () => {
  await app?.close();
  app = null;
  await host.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("right after the first sign-in: one extra Allow, then the host's projects under the person's own models", async () => {
  await start();
  const cookie = await signInWithHost();
  const models = await page("/models?linked_models=example", cookie);
  expect(models).toContain("Example projects");
  expect(models).toContain("Access and sharing are managed in Example.");
  expect(models).toContain("9901 Sample Warehouse");
  expect(models).toContain("Can edit");
  expect(models).toContain("View only");
  expect(models).toContain(`href="${host.url}/models/${PROJECT}"`);
  expect(models).toContain('target="_blank"');
  // An open address on another site is never shown as a link.
  expect(models).not.toContain("elsewhere.example");
  expect(models.indexOf("No models yet")).toBeLessThan(models.indexOf('data-testid="linked-example"'));

  // Only ciphertext is kept.
  const user = app?.db.userByEmail("pat@example.com");
  const grant = user ? app?.db.linkedGrant(user.id, "example") : null;
  expect(grant?.access_cipher.startsWith("lk1.")).toBe(true);
  expect(JSON.stringify(grant)).not.toContain("pass-access-1");
  expect(JSON.stringify(grant)).not.toContain("pass-refresh-1");

  // The next sign-in doesn't ask again.
  const begin = await fetch(`${base}/auth/example/start?return_to=%2Fmodels`, { redirect: "manual" });
  const state = new URL(begin.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const again = await fetch(`${base}/auth/example/callback?code=identity-code&state=${state}`, { redirect: "manual" });
  expect(again.headers.get("location")).toBe("/models");
});

test("not now, then later from My models; host down; reconnect", async () => {
  await start();
  const cookie = await signInWithHost({ skipModels: true });
  expect(await page("/models", cookie)).toContain("Show my Example projects");

  const allow = await fetch(`${base}/auth/example/models/start?return_to=%2Fmodels`, { redirect: "manual", headers: { cookie } });
  const state = new URL(allow.headers.get("location") ?? "").searchParams.get("state");
  await fetch(`${base}/auth/example/models/callback?code=models-code&state=${state}`, { redirect: "manual", headers: { cookie } });
  expect(await page("/models", cookie)).toContain("9901 Sample Warehouse");

  host.listStatus = 503;
  const down = await page("/models?fresh=1", cookie);
  expect(down).toContain("can&#x27;t be reached right now. Your own models are fine.");
  expect(down).toContain("Try again");

  host.listStatus = 200;
  host.accessToken = "pass-access-moved";
  host.refreshStatus = 400;
  const reconnect = await page("/models?fresh=1", cookie);
  expect(reconnect).toContain("Example needs you to reconnect.");
  expect(reconnect).toContain("Reconnect");
});

test("an assistant works on linked models through the host, in this app's ids; view-only and other families stay out", async () => {
  await start();
  const cookie = await signInWithHost();
  await page("/models", cookie);
  const user = app?.db.userByEmail("pat@example.com");
  const rows = user ? (app?.db.linkedModelsOf(user.id, "example") ?? []) : [];
  const editable = rows.find((r) => r.can_edit)?.alias_id ?? "";
  const viewOnly = rows.find((r) => !r.can_edit)?.alias_id ?? "";
  expect(editable).toMatch(/^lk-/);

  let answer: "accept" | "decline" = "accept";
  let asked = 0;
  const client = await assistant(cookie, () => {
    asked += 1;
    return answer;
  });
  expect(client.getInstructions()).toContain(`9901 Sample Warehouse (model_id ${editable}, you can edit)`);

  const summary = await client.callTool({ name: "bim_model_summary", arguments: { model_id: editable } });
  const sent = host.calls.at(-1);
  expect(sent).toMatchObject({ tool: "bim_model_summary", agentName: "Test Assistant", args: { model_id: "site-9901", project_id: PROJECT } });
  expect(textOf(summary)).toContain(editable);
  expect(textOf(summary)).not.toContain("site-9901");
  expect(textOf(summary)).not.toContain(PROJECT);

  const before = host.calls.length;
  const refused = await client.callTool({ name: "bim_apply_output", arguments: { model_id: viewOnly, ...APPLY } });
  expect(textOf(refused)).toContain("You can only view “9902 Sample Office” in Example");
  expect(asked).toBe(0);
  expect(host.calls.length).toBe(before);

  answer = "decline";
  const declined = await client.callTool({ name: "bim_apply_output", arguments: { model_id: editable, ...APPLY } });
  expect(textOf(declined)).toContain("declined");
  expect(host.calls.length).toBe(before);

  answer = "accept";
  await client.callTool({ name: "bim_apply_output", arguments: { model_id: editable, ...APPLY } });
  expect(asked).toBe(2);
  expect(host.calls.at(-1)).toMatchObject({ tool: "bim_apply_output", args: { model_id: "site-9901", project_id: PROJECT, label: "Add Level 2" } });

  await client.callTool({ name: "bim_enable_pack", arguments: { family: EDIT_FAMILY } });
  const family = await client.callTool({ name: "bim_create_level", arguments: { project_id: HOSTED_PROJECT_ID, model_id: editable, name: "Level 3", elevation_ft: 24 } });
  expect(textOf(family)).toContain("doesn't reach Example models from here");
  await client.close();
});

test("a change approved on the approvals page after the call returned lands on the host once", async () => {
  await start();
  const cookie = await signInWithHost();
  await page("/models", cookie);
  const user = app?.db.userByEmail("pat@example.com");
  const editable = user ? (app?.db.linkedModelsOf(user.id, "example").find((r) => r.can_edit)?.alias_id ?? "") : "";
  const client = await assistant(cookie, null);
  const waiting = await client.callTool({ name: "bim_apply_output", arguments: { model_id: editable, ...APPLY } });
  const id = textOf(waiting).match(/approvals\/([0-9a-f-]{36})/)?.[1] ?? "";
  expect(id).not.toBe("");
  expect(host.calls.filter((c) => c.tool === "bim_apply_output")).toHaveLength(0);
  const approved = await post(`/approvals/${id}`, { decision: "approve" }, cookie);
  expect(await approved.text()).toContain("Approved and applied in Example.");
  const again = await post(`/approvals/${id}`, { decision: "approve" }, cookie);
  expect(again.status).toBeLessThan(500);
  expect(host.calls.filter((c) => c.tool === "bim_apply_output")).toHaveLength(1);
  await client.close();
});

test("turning it off hands the pass back and takes the models away from the page and from assistants", async () => {
  await start();
  const cookie = await signInWithHost();
  await page("/models", cookie);
  const user = app?.db.userByEmail("pat@example.com");
  const alias = user ? (app?.db.linkedModelsOf(user.id, "example")[0]?.alias_id ?? "") : "";
  const settings = await page("/settings", cookie);
  expect(settings).toContain("Show Example projects:");
  const off = await post("/settings/linked/example/off", {}, cookie);
  expect(off.status).toBe(200);
  expect(host.revoked).toEqual(expect.arrayContaining(["pass-refresh-1", "pass-access-1"]));
  expect(await page("/models", cookie)).toContain("Show my Example projects");
  const client = await assistant(cookie, () => "accept");
  const gone = await client.callTool({ name: "bim_model_summary", arguments: { model_id: alias } });
  expect(textOf(gone)).toContain("isn't available to you any more");
  await client.close();
});

test("with no link key the feature is off and says so; the person's own models are untouched", async () => {
  await start(null);
  const begin = await fetch(`${base}/auth/example/start?return_to=%2Fmodels`, { redirect: "manual" });
  const state = new URL(begin.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const back = await fetch(`${base}/auth/example/callback?code=identity-code&state=${state}`, { redirect: "manual" });
  expect(back.headers.get("location")).toBe("/models");
  const cookie = (back.headers.get("set-cookie") ?? "").match(/mutinybim_session=[^;]+/)?.[0] ?? "";
  const models = await page("/models", cookie);
  expect(models).toContain("can&#x27;t be shown on this server yet");
  expect(models).toContain("No models yet");
});
