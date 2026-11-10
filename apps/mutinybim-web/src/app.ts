/**
 * The hosted MutinyBIM web app: accounts, a person's models and the ones
 * shared with them, the editor, the model server those models sync through,
 * bring-your-own-AI settings, the page for connecting an outside assistant,
 * and an optional quote link.
 * One Node process, no framework; see README.md.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { WebSocketServer, type WebSocket } from "ws";
import { parseBranchModelId } from "@permitzip/bim-kernel";
import { TOOL_FAMILIES } from "@permitzip/bim-mcp";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { LocalScriptRunner } from "@permitzip/bim-script-runner/local";
import type { SyncHub } from "@permitzip/bim-sync";
import { createEditorDemo, type EditorDemo } from "../../../packages/bim-editor/demo/server";
import { ApprovalBook } from "./assistant-approvals";
import { approveAuthorize, checkAuthorize, errorRedirect, type AssistantAuthOptions } from "./assistant-auth";
import { createAssistantTools, type AttachModel, type ModelEndpoint } from "./assistant-tools";
import type { OAuthProviderConfig, WebConfig } from "./config";
import { DEFAULT_RUNNER_DIR, localScripts, ScriptSandbox, scriptsOff, sealedScripts, type HostedScripts } from "./script-sandbox";
import { isColorScheme, openDb, type Db, type ModelAccess, type ModelRow, type ShareRole, type UserRow } from "./db";
import { esc, setWaitingApprovals, type Flash } from "./ui";
import { ModelStore, summarize, type StarterKind } from "./models";
import { finishSignIn, SignInError, startSignIn, type Fetch } from "./oauth";
import { createLinkedHosts, LINK_STATE_PREFIX, readLinkKeys, type LinkedProvider, type LinkKeys } from "./linked-hosts";
import { approvalPage, approvalsPage, assistantConsentPage, connectPage, forgotPage, landingPage, linkedOfferPage, loginPage, messagePage, modelsPage, privacyPage, quotePage, resetPage, settingsPage, sharePage, signupPage, termsPage, type LinkedModelsView, type LinkedSwitch } from "./pages";
import { digest, hashPassword, randomToken, verifyPassword } from "./secrets";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, "..");
const SESSION_COOKIE = "mutinybim_session";
const SESSION_DAYS = 30;
const BODY_LIMIT = 64 * 1024;
/** After a linked sign-in, a password can be set without the old one for this long (the recovery path). */
const RECOVERY_WINDOW_MS = 10 * 60_000;

export interface AppOptions {
  /** Used by tests to answer the sign-in provider's addresses. */
  readonly fetchImpl?: Fetch;
  /** Skip the editor bundle (tests that only need accounts and sync). */
  readonly editor?: boolean;
  /** Used by tests to answer where an assistant's metadata address points. */
  readonly resolveHost?: (hostname: string) => Promise<readonly string[]>;
  /** How long an assistant's change waits on the approvals page inside its tool call (tests shorten it). */
  readonly approvalWaitMs?: number;
  /** Where assistants' scripts run (tests pass a runner on this computer); default from the config. */
  readonly scripts?: HostedScripts;
  /** The key linked-host passes are kept under (tests); default MUTINYBIM_WEB_LINK_KEY. null: linked hosts off. */
  readonly linkKeys?: LinkKeys | null;
}

/** The scripts setting as a runner: the sealed box (default), off, or this computer's own runner (loopback servers only). */
function scriptsFor(config: WebConfig): HostedScripts {
  const chosen = config.scripts ?? { mode: "sealed" };
  if (chosen.mode === "off") return scriptsOff("Scripts are off on this server. Turn on a tool family with bim_enable_pack and use its tools, or run the script with the open-source kit on your own computer and send its output to bim_apply_output.");
  if (chosen.mode === "local") {
    console.warn("[mutinybim-web] scripts run in plain local processes (MUTINYBIM_WEB_SCRIPTS=local): for one person's own computer only");
    return localScripts(new LocalScriptRunner({ repoRoot: path.resolve(APP_DIR, "../..") }));
  }
  return sealedScripts(new ScriptSandbox({ runnerDir: chosen.runnerDir ?? DEFAULT_RUNNER_DIR, workDir: path.join(os.tmpdir(), "mutinybim-script-requests"), ...(chosen.maxRunning ? { maxRunning: chosen.maxRunning } : {}) }));
}

export interface App {
  readonly server: Server;
  readonly db: Db;
  readonly models: ModelStore;
  listen(): Promise<void>;
  close(): Promise<void>;
}

class Refusal extends Error {
  constructor(readonly status: number, readonly words: string) {
    super(words);
  }
}

function send(res: ServerResponse, status: number, type: string, body: string | Uint8Array, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
  res.end(body);
}

function html(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  send(res, status, "text/html; charset=utf-8", body, {
    "content-security-policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss: https:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https:",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    ...headers,
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, "application/json", JSON.stringify(body));
}

function redirect(res: ServerResponse, location: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(303, { location, "cache-control": "no-store", ...headers });
  res.end();
}

function cookies(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0) out.set(part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1).trim()));
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > BODY_LIMIT) throw new Refusal(413, "That form was too large.");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readBody(req));
}

/** The `scheme` of a small JSON body (the editor's theme toggle), or null. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const text = await readBody(req);
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && "scheme" in parsed ? parsed.scheme : null;
  } catch (err) {
    console.error("[mutinybim-web] a JSON body didn't parse", { err });
    return null;
  }
}

/** The path of the page a form was posted from, when it was this app. */
function refererPath(req: IncomingMessage): string | null {
  const referer = req.headers.referer;
  if (!referer) return null;
  try {
    const url = new URL(referer);
    return url.host === req.headers.host ? url.pathname + url.search : null;
  } catch (err) {
    console.error("[mutinybim-web] the referer wasn't an address", { err });
    return null;
  }
}

/** Only addresses inside this app may be a return target (no open redirect). */
function safeReturn(value: string | null | undefined, fallback = "/models"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  return value;
}

function newModelId(): string {
  return `m-${randomBytes(10).toString("hex")}`;
}

function baseModelOf(modelId: string): string {
  return parseBranchModelId(modelId)?.baseModelId ?? modelId;
}

/** Per-address attempt counter for sign-in forms (resets each window). */
class Throttle {
  private readonly hits = new Map<string, { count: number; until: number }>();
  constructor(private readonly limit: number, private readonly windowMs: number) {}
  allow(key: string): boolean {
    const nowMs = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.until < nowMs) {
      this.hits.set(key, { count: 1, until: nowMs + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}

export function createApp(config: WebConfig, options: AppOptions = {}): App {
  installFirstPartyAddOns();
  const db = openDb(path.join(config.dataDir, "accounts.sqlite"));
  const models = new ModelStore(path.join(config.dataDir, "models"), (modelId) => db.touchModel(modelId));
  const throttle = new Throttle(20, 10 * 60_000);
  const syncUrl = `${config.origin.replace(/^http/, "ws")}/sync`;
  const approvals = new ApprovalBook(db);
  setWaitingApprovals((userId) => approvals.waitingCount(userId));
  const linkedHosts = createLinkedHosts({ config, db, keys: options.linkKeys !== undefined ? options.linkKeys : readLinkKeys(), ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  const assistantAuth: AssistantAuthOptions = { origin: config.origin, families: TOOL_FAMILIES, db, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), ...(options.resolveHost ? { resolveHost: options.resolveHost } : {}) };

  const editor: EditorDemo | null =
    options.editor === false
      ? null
      : createEditorDemo({
          entry: path.join(APP_DIR, "client/entry.tsx"),
          outDir: process.env.MUTINYBIM_WEB_BUILD ?? path.join(config.dataDir, "editor-build"),
          mainModelId: async () => "unused",
          authority: async () => ({ error: "Open the model from My models." }),
        });

  let settingsJs: Promise<string> | null = null;
  const bundleSettings = (): Promise<string> => {
    settingsJs ??= build({ entryPoints: [path.join(APP_DIR, "client/settings.ts")], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", minify: true, logLevel: "silent" })
      .then((r) => r.outputFiles[0]?.text ?? "")
      .catch((err: unknown) => {
        settingsJs = null;
        throw err;
      });
    return settingsJs;
  };

  let appCss: Promise<string> | null = null;
  const bundleCss = (): Promise<string> => {
    const from = path.join(APP_DIR, "styles/app.css");
    appCss ??= readFile(from, "utf8")
      .then((source) => postcss([tailwind({ base: APP_DIR })]).process(source, { from }))
      .then((r) => r.css)
      .catch((err: unknown) => {
        appCss = null;
        throw err;
      });
    return appCss;
  };

  const sessionToken = (req: IncomingMessage): string | null => cookies(req).get(SESSION_COOKIE) ?? null;
  const sessionUser = (req: IncomingMessage): UserRow | null => {
    const token = sessionToken(req);
    return token ? db.userBySession(digest(token)) : null;
  };
  /** True when this session came from a linked sign-in in the last few minutes (setting a password needs no old one then). */
  const recentProviderSignIn = (req: IncomingMessage): boolean => {
    const token = sessionToken(req);
    const info = token ? db.session(digest(token)) : null;
    return Boolean(info && info.via !== "password" && info.via !== "reset" && Date.now() - Date.parse(info.created_at) < RECOVERY_WINDOW_MS);
  };

  const sessionCookie = (token: string, maxAgeS: number): string =>
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${config.secure ? "; Secure" : ""}`;

  const startSession = (userId: string, via: string): string => {
    const token = randomToken();
    db.createSession(digest(token), userId, new Date(Date.now() + SESSION_DAYS * 86_400_000), via);
    return sessionCookie(token, SESSION_DAYS * 86_400);
  };

  /** A form post must come from this app's own pages (SameSite cookies plus an Origin check). */
  const sameOrigin = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (!origin) return req.headers["sec-fetch-site"] === undefined || req.headers["sec-fetch-site"] === "same-origin";
    return origin === config.origin || origin === `http://${req.headers.host ?? ""}`;
  };

  const NOT_YOURS = "That model isn't in your account or shared with you. It may have been deleted, or its owner stopped sharing it.";
  /** A model the person owns or that was shared with them. */
  const reachableModel = (user: UserRow, modelId: string): { readonly model: ModelRow; readonly access: ModelAccess } => {
    const found = db.accessTo(user.id, modelId);
    if (!found) throw new Refusal(404, NOT_YOURS);
    return found;
  };
  /** Renaming, deleting and sharing are the owner's alone. */
  const ownModel = (user: UserRow, modelId: string): ModelRow => {
    const found = reachableModel(user, modelId);
    if (found.access !== "owner") throw new Refusal(403, `Only the owner can do that. You can ${found.access === "edit" ? "edit" : "view"} “${found.model.name}”.`);
    return found.model;
  };

  const providerOf = (id: string): OAuthProviderConfig => {
    const provider = config.providers.find((p) => p.id === id);
    if (!provider) throw new Refusal(404, "That way of signing in isn't set up on this server.");
    return provider;
  };

  const callbackUri = (provider: OAuthProviderConfig) => `${config.origin}/auth/${provider.id}/callback`;

  const linkedProviderOf = (id: string): LinkedProvider => {
    const provider = linkedHosts.provider(id);
    if (!provider) throw new Refusal(404, "Projects from that sign-in aren't set up on this server.");
    return provider;
  };

  /** Right after a sign-in with a linked host, once: offer to show its models too (or go straight on). */
  const afterSignIn = (userId: string, provider: OAuthProviderConfig, returnTo: string): string => {
    const host = linkedHosts.provider(provider.id);
    if (!host || db.linkedGrant(userId, host.id) || db.linkedOfferAnswered(userId, host.id)) return returnTo;
    return `/auth/${host.id}/models/offer?return_to=${encodeURIComponent(returnTo)}`;
  };

  /** The linked hosts' sections on My models: for each host this person signs in with (or already linked). */
  async function linkedModelsView(user: UserRow, fresh: boolean): Promise<LinkedModelsView> {
    const mine = db.identitiesOf(user.id);
    const sections = await Promise.all(linkedHosts.providers.filter((p) => mine.includes(p.id) || db.linkedGrant(user.id, p.id)).map((p) => linkedHosts.view(user, p, { fresh })));
    const keyMissing = linkedHosts.keyMissing ? config.providers.filter((p) => p.models && mine.includes(p.id)) : [];
    return { sections, keyMissing };
  }

  function linkedSwitches(user: UserRow): { readonly provider: LinkedProvider; readonly state: LinkedSwitch }[] {
    return linkedHosts.providers.map((provider) => {
      const grant = db.linkedGrant(user.id, provider.id);
      return { provider, state: !grant ? "off" : grant.state === "reconnect" ? "reconnect" : "on" };
    });
  }

  async function modelsView(user: UserRow, flash: Flash | null, status = 200, fresh = false): Promise<{ status: number; body: string }> {
    return { status, body: modelsPage(config, user, db.modelsOf(user.id), db.sharedWith(user.id), flash ?? undefined, await linkedModelsView(user, fresh)) };
  }

  async function handleAuthCallback(req: IncomingMessage, res: ServerResponse, url: URL, provider: OAuthProviderConfig): Promise<void> {
    const error = url.searchParams.get("error");
    if (error) {
      const words = error === "access_denied" ? `You didn't allow MutinyBIM on ${provider.label.replace(/^Log in with /i, "")}. Nothing changed.` : `${provider.label} sign-in stopped (${error}). Try again, or sign in with email.`;
      return html(res, 400, loginPage(config, { returnTo: "/models", flash: { kind: "error", text: words } }));
    }
    const code = url.searchParams.get("code");
    const stateParam = url.searchParams.get("state");
    const state = stateParam ? db.takeOAuthState(stateParam) : null;
    if (!code || !state || state.provider !== provider.id || state.return_to.startsWith(LINK_STATE_PREFIX)) {
      return html(res, 400, loginPage(config, { returnTo: "/models", flash: { kind: "error", text: "That sign-in link expired or was already used. Start again." } }));
    }
    const person = await finishSignIn({ provider, redirectUri: callbackUri(provider), code, codeVerifier: state.code_verifier, db, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
    const linking = state.return_to.startsWith("link:");
    const returnTo = safeReturn(linking ? state.return_to.slice(5) : state.return_to);
    const known = db.userByIdentity(provider.id, person.subject);
    if (linking) {
      const current = sessionUser(req);
      if (!current) return redirect(res, "/login?return_to=%2Fsettings");
      if (known && known.id !== current.id) return html(res, 409, settingsPage(config, current, db.identitiesOf(current.id), { flash: { kind: "error", text: `That ${provider.label.replace(/^Log in with /i, "")} account is already linked to another MutinyBIM account.` } }));
      db.linkIdentity(provider.id, person.subject, current.id);
      console.log("[mutinybim-web] linked a sign-in", { provider: provider.id, userId: current.id });
      return redirect(res, afterSignIn(current.id, provider, `${returnTo}${returnTo.includes("?") ? "&" : "?"}linked=${provider.id}`));
    }
    if (known) {
      console.log("[mutinybim-web] signed in", { provider: provider.id, userId: known.id });
      return redirect(res, afterSignIn(known.id, provider, returnTo), { "set-cookie": startSession(known.id, provider.id) });
    }
    if (!person.email) return html(res, 400, loginPage(config, { returnTo, flash: { kind: "error", text: `${provider.label} didn't share an email address, which a MutinyBIM account needs. Sign up with email instead.` } }));
    const sameEmail = db.userByEmail(person.email);
    if (sameEmail) {
      return html(res, 409, loginPage(config, { email: person.email, returnTo: "/settings", flash: { kind: "error", text: `A MutinyBIM account with ${person.email} already exists. Log in with its password, then link ${provider.label.replace(/^Log in with /i, "")} under Settings → Ways to log in.` } }));
    }
    if (!config.signupOpen) return html(res, 403, loginPage(config, { returnTo, flash: { kind: "error", text: "New accounts can't be made on this server right now." } }));
    const user = db.createUser({ id: randomUUID(), email: person.email, displayName: person.name ?? person.email.split("@")[0] ?? "You", passwordHash: null });
    db.linkIdentity(provider.id, person.subject, user.id);
    console.log("[mutinybim-web] account made through a sign-in provider", { provider: provider.id, userId: user.id });
    return redirect(res, afterSignIn(user.id, provider, returnTo), { "set-cookie": startSession(user.id, provider.id) });
  }

  /** Back from the linked host: keep its pass, then show its models. */
  async function handleLinkedCallback(req: IncomingMessage, res: ServerResponse, url: URL, provider: LinkedProvider): Promise<void> {
    const current = sessionUser(req);
    if (!current) return redirect(res, "/login?return_to=%2Fmodels");
    const host = provider.label.replace(/^Log in with /i, "");
    const error = url.searchParams.get("error");
    if (error) {
      const words = error === "access_denied" ? `You didn't allow it on ${host}. Nothing changed; you can turn it on later under Settings.` : `${host} stopped (${error}${url.searchParams.get("error_description") ? `: ${url.searchParams.get("error_description")}` : ""}). Try again.`;
      const view = await modelsView(current, { kind: "error", text: words }, 400);
      return html(res, view.status, view.body);
    }
    const code = url.searchParams.get("code");
    const stateParam = url.searchParams.get("state");
    const state = stateParam ? db.takeOAuthState(stateParam) : null;
    if (!code || !state || state.provider !== provider.id || !state.return_to.startsWith(LINK_STATE_PREFIX)) {
      const view = await modelsView(current, { kind: "error", text: "That link expired or was already used. Start again." }, 400);
      return html(res, view.status, view.body);
    }
    await linkedHosts.finish(provider, current, code, state.code_verifier);
    const returnTo = safeReturn(state.return_to.slice(LINK_STATE_PREFIX.length));
    return redirect(res, `${returnTo}${returnTo.includes("?") ? "&" : "?"}linked_models=${provider.id}`);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", config.origin);
    const { pathname } = url;
    const method = req.method ?? "GET";
    const user = sessionUser(req);

    // The tool server and its sign-in addresses take requests from assistants (other origins, bearer tokens, no cookies).
    if (await assistantTools.handle(req, res, url)) return;

    if (method === "POST" && !sameOrigin(req)) throw new Refusal(403, "That form came from another site, so it was not accepted. Reload this app and try again.");

    if (method === "GET" && pathname === "/healthz") return json(res, 200, { ok: true });
    if (method === "GET" && pathname === "/static/app.css") return send(res, 200, "text/css; charset=utf-8", await bundleCss(), { "cache-control": "public, max-age=300" });
    if (method === "GET" && pathname === "/static/confirm.js") return send(res, 200, "text/javascript; charset=utf-8", await readFile(path.join(APP_DIR, "public/confirm.js")), { "cache-control": "public, max-age=300" });
    if (method === "GET" && pathname === "/static/settings.js") return send(res, 200, "text/javascript; charset=utf-8", await bundleSettings(), { "cache-control": "public, max-age=300" });

    if (method === "GET" && pathname === "/") return user ? redirect(res, "/models") : html(res, 200, landingPage(config));

    if (pathname === "/login") {
      if (method === "GET") return user ? redirect(res, safeReturn(url.searchParams.get("return_to"))) : html(res, 200, loginPage(config, { returnTo: safeReturn(url.searchParams.get("return_to")) }));
      if (method === "POST") {
        const form = await readForm(req);
        const email = (form.get("email") ?? "").trim().toLowerCase();
        const returnTo = safeReturn(form.get("return_to"));
        if (!throttle.allow(`login:${req.socket.remoteAddress ?? "?"}`)) return html(res, 429, loginPage(config, { email, returnTo, flash: { kind: "error", text: "Too many tries from here. Wait ten minutes, then try again." } }));
        const found = email ? db.userByEmail(email) : null;
        const ok = found?.password_hash ? await verifyPassword(form.get("password") ?? "", found.password_hash) : false;
        if (!found || !ok) {
          const words = found && !found.password_hash ? "This account signs in through a linked account (no password). Use the button above." : "That email and password don't match an account. Check both and try again.";
          return html(res, 401, loginPage(config, { email, returnTo, flash: { kind: "error", text: words } }));
        }
        return redirect(res, returnTo, { "set-cookie": startSession(found.id, "password") });
      }
    }

    if (method === "GET" && pathname === "/forgot") return user ? redirect(res, "/settings#password") : html(res, 200, forgotPage(config));
    const reset = pathname.match(/^\/reset\/([A-Za-z0-9_-]{20,80})$/);
    if (reset?.[1]) {
      const tokenHash = digest(reset[1]);
      const person = db.userByPasswordReset(tokenHash);
      if (method === "GET") return html(res, person ? 200 : 410, resetPage({ token: reset[1], email: person?.email ?? null }));
      if (method === "POST") {
        if (!person) return html(res, 410, resetPage({ token: reset[1], email: null }));
        const password = (await readForm(req)).get("password") ?? "";
        if (password.length < 8) return html(res, 400, resetPage({ token: reset[1], email: person.email, flash: { kind: "error", text: "Use a password of at least 8 characters." } }));
        db.setPassword(person.id, await hashPassword(password));
        db.usePasswordReset(tokenHash);
        db.deleteSessionsOf(person.id);
        console.log("[mutinybim-web] password reset with a reset link", { userId: person.id });
        return redirect(res, "/models?reset=1", { "set-cookie": startSession(person.id, "reset") });
      }
    }

    if (method === "GET" && pathname === "/terms") return html(res, 200, termsPage());
    if (method === "GET" && pathname === "/privacy") return html(res, 200, privacyPage());

    if (pathname === "/signup") {
      if (method === "GET") return user ? redirect(res, "/models") : html(res, 200, signupPage(config, {}));
      if (method === "POST") {
        if (!config.signupOpen) return html(res, 403, signupPage(config, {}));
        const form = await readForm(req);
        const email = (form.get("email") ?? "").trim().toLowerCase();
        const name = (form.get("name") ?? "").trim().slice(0, 80);
        const password = form.get("password") ?? "";
        const fail = (text: string, status = 400) => html(res, status, signupPage(config, { email, name, flash: { kind: "error", text } }));
        if (!throttle.allow(`signup:${req.socket.remoteAddress ?? "?"}`)) return fail("Too many sign-ups from here. Wait ten minutes, then try again.", 429);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("Enter a full email address, like name@example.com.");
        if (!name) return fail("Enter your name; it's what people editing with you see.");
        if (password.length < 8) return fail("Use a password of at least 8 characters.");
        // The sign-up page requires the agreement box (HTML `required`, so a
        // browser can't submit without it). A post that sends no `agree` field
        // at all, such as the app's own tests, is accepted; an explicit "no"
        // is refused.
        if (form.has("agree") && form.get("agree") !== "1") return fail("Tick the box to agree to the Terms of use and the Privacy notice.");
        if (db.userByEmail(email)) return fail("An account with that email already exists. Log in instead.", 409);
        const created = db.createUser({ id: randomUUID(), email, displayName: name, passwordHash: await hashPassword(password) });
        console.log("[mutinybim-web] account made", { userId: created.id });
        return redirect(res, "/models?welcome=1", { "set-cookie": startSession(created.id, "password") });
      }
    }

    if (method === "POST" && pathname === "/logout") {
      const token = cookies(req).get(SESSION_COOKIE);
      if (token) db.deleteSession(digest(token));
      return redirect(res, "/", { "set-cookie": sessionCookie("", 0) });
    }

    const authStart = pathname.match(/^\/auth\/([a-z0-9-]+)\/start$/);
    if (method === "GET" && authStart?.[1]) {
      const provider = providerOf(authStart[1]);
      const returnTo = safeReturn(url.searchParams.get("return_to"));
      const linking = url.searchParams.get("link") === "1";
      if (linking && !user) return redirect(res, "/login?return_to=%2Fsettings");
      try {
        const target = await startSignIn({ provider, redirectUri: callbackUri(provider), returnTo: linking ? `link:${returnTo}` : returnTo, db, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
        return redirect(res, target);
      } catch (err) {
        if (!(err instanceof SignInError)) throw err;
        console.error("[mutinybim-web] starting a provider sign-in failed", { provider: provider.id, err: err.message });
        return html(res, 502, loginPage(config, { returnTo, flash: { kind: "error", text: err.words } }));
      }
    }
    const linkedRoute = pathname.match(/^\/auth\/([a-z0-9-]+)\/models\/(start|callback|offer)$/);
    if (linkedRoute?.[1] && linkedRoute[2]) {
      const provider = linkedProviderOf(linkedRoute[1]);
      if (!user) return redirect(res, `/login?return_to=${encodeURIComponent(linkedRoute[2] === "callback" ? "/models" : pathname + url.search)}`);
      const returnTo = safeReturn(url.searchParams.get("return_to"));
      try {
        if (method === "GET" && linkedRoute[2] === "offer") return html(res, 200, linkedOfferPage(config, user, provider, returnTo));
        if (method === "POST" && linkedRoute[2] === "offer") {
          db.answerLinkedOffer(user.id, provider.id);
          return redirect(res, safeReturn((await readForm(req)).get("return_to")));
        }
        if (method === "GET" && linkedRoute[2] === "start") {
          db.answerLinkedOffer(user.id, provider.id);
          return redirect(res, await linkedHosts.start(provider, returnTo));
        }
        if (method === "GET" && linkedRoute[2] === "callback") return await handleLinkedCallback(req, res, url, provider);
      } catch (err) {
        if (!(err instanceof SignInError)) throw err;
        console.error("[mutinybim-web] linking a host's models failed", { provider: provider.id, err: err.message });
        const view = await modelsView(user, { kind: "error", text: err.words }, 502);
        return html(res, view.status, view.body);
      }
    }
    const authCallback = pathname.match(/^\/auth\/([a-z0-9-]+)\/callback$/);
    if (method === "GET" && authCallback?.[1]) {
      const provider = providerOf(authCallback[1]);
      try {
        return await handleAuthCallback(req, res, url, provider);
      } catch (err) {
        if (!(err instanceof SignInError)) throw err;
        console.error("[mutinybim-web] finishing a provider sign-in failed", { provider: provider.id, err: err.message });
        return html(res, 502, loginPage(config, { returnTo: "/models", flash: { kind: "error", text: err.words } }));
      }
    }

    // Everything below needs a signed-in person.
    if (!user) {
      if (pathname.startsWith("/api/")) return json(res, 401, { error: "You are signed out. Log in again." });
      if (method === "GET" && (pathname.startsWith("/m/") || pathname.startsWith("/models/") || ["/models", "/settings", "/connect", "/quote", "/approvals"].includes(pathname) || pathname.startsWith("/approvals/") || pathname === "/oauth/authorize")) {
        return redirect(res, `/login?return_to=${encodeURIComponent(pathname + url.search)}`);
      }
    }

    if (user && pathname === "/models") {
      if (method === "GET") {
        const welcome = url.searchParams.get("welcome") === "1";
        const deleted = url.searchParams.get("deleted");
        const flash = welcome
          ? { kind: "ok" as const, text: `Welcome, ${user.display_name}. Make your first model below.` }
          : deleted
            ? { kind: "ok" as const, text: `Deleted “${deleted}”.` }
            : url.searchParams.get("reset") === "1"
              ? { kind: "ok" as const, text: "Your new password is saved. You were signed out everywhere else." }
              : null;
        const linkedId = url.searchParams.get("linked_models");
        const linkedProvider = linkedId ? linkedHosts.provider(linkedId) : null;
        const view = await modelsView(user, flash ?? (linkedProvider ? { kind: "ok", text: `Done. Your ${linkedProvider.models.label} are below.` } : null), 200, url.searchParams.get("fresh") === "1" || Boolean(linkedProvider));
        return html(res, view.status, view.body);
      }
      if (method === "POST") {
        const form = await readForm(req);
        const name = (form.get("name") ?? "").trim().slice(0, 120);
        const start: StarterKind = form.get("start") === "sample" ? "sample" : "blank";
        if (!name) {
          const view = await modelsView(user, { kind: "error", text: "Give the model a name." }, 400);
          return html(res, view.status, view.body);
        }
        if (db.countModelsOf(user.id) >= config.modelLimit) {
          const view = await modelsView(user, { kind: "error", text: `A free account keeps up to ${config.modelLimit} models. Delete one to make another.` }, 409);
          return html(res, view.status, view.body);
        }
        const id = newModelId();
        await models.create(id, start);
        db.createModel({ id, ownerId: user.id, name });
        console.log("[mutinybim-web] model made", { modelId: id, userId: user.id, start });
        return redirect(res, `/m/${id}?view=plan`);
      }
    }
    const modelAction = pathname.match(/^\/models\/([a-z0-9-]+)\/(rename|delete)$/);
    if (user && method === "POST" && modelAction?.[1]) {
      const model = ownModel(user, modelAction[1]);
      if (modelAction[2] === "rename") {
        const name = ((await readForm(req)).get("name") ?? "").trim().slice(0, 120);
        if (!name) {
          const view = await modelsView(user, { kind: "error", text: "A model needs a name." }, 400);
          return html(res, view.status, view.body);
        }
        db.renameModel(model.id, name);
        return redirect(res, "/models");
      }
      db.deleteModel(model.id);
      disconnect(model.id, null);
      await models.remove(model.id);
      console.log("[mutinybim-web] model deleted", { modelId: model.id, userId: user.id });
      return redirect(res, `/models?deleted=${encodeURIComponent(model.name)}`);
    }

    const shareRoute = pathname.match(/^\/models\/([a-z0-9-]+)\/share$/);
    if (user && shareRoute?.[1]) {
      const model = ownModel(user, shareRoute[1]);
      if (method === "GET") return html(res, 200, sharePage(config, user, model, db.sharesOf(model.id)));
      if (method === "POST") {
        const form = await readForm(req);
        const email = (form.get("email") ?? "").trim().toLowerCase();
        const role: ShareRole = form.get("role") === "view" ? "view" : "edit";
        const fail = (status: number, text: string) => html(res, status, sharePage(config, user, model, db.sharesOf(model.id), { email, flash: { kind: "error", text } }));
        const person = email ? db.userByEmail(email) : null;
        if (!person) return fail(404, `No MutinyBIM account here uses ${email || "that email"}. Ask them to sign up first (this app sends no invitations), then share again.`);
        if (person.id === user.id) return fail(400, "That's you; you already own this model.");
        const before = db.sharesOf(model.id).find((s) => s.user_id === person.id);
        db.share({ modelId: model.id, userId: person.id, role, invitedBy: user.id });
        if (before && before.role !== role) disconnect(model.id, person.id);
        console.log("[mutinybim-web] model shared", { modelId: model.id, ownerId: user.id, userId: person.id, role });
        const words = before ? `${person.display_name} can now ${role === "edit" ? "edit" : "only view"} it.` : `Shared with ${person.display_name}. They see it under “Shared with you” on My models.`;
        return html(res, 200, sharePage(config, user, model, db.sharesOf(model.id), { flash: { kind: "ok", text: words } }));
      }
    }
    const unshareRoute = pathname.match(/^\/models\/([a-z0-9-]+)\/share\/([0-9a-f-]{36})\/delete$/);
    if (user && method === "POST" && unshareRoute?.[1] && unshareRoute[2]) {
      const model = ownModel(user, unshareRoute[1]);
      const removed = db.sharesOf(model.id).find((s) => s.user_id === unshareRoute[2]);
      db.unshare(model.id, unshareRoute[2]);
      disconnect(model.id, unshareRoute[2]);
      console.log("[mutinybim-web] model unshared", { modelId: model.id, ownerId: user.id, userId: unshareRoute[2] });
      return html(res, 200, sharePage(config, user, model, db.sharesOf(model.id), { flash: { kind: "ok", text: removed ? `${removed.display_name} no longer has “${model.name}”.` : "They already didn't have it." } }));
    }

    if (user && pathname === "/settings" && method === "GET") {
      const linked = url.searchParams.get("linked");
      const provider = linked ? config.providers.find((p) => p.id === linked) : undefined;
      const linkedProvider = url.searchParams.get("linked_models") ? linkedHosts.provider(url.searchParams.get("linked_models") ?? "") : null;
      const flash: Flash | null = provider ? { kind: "ok", text: `Linked. You can now log in with ${provider.label.replace(/^Log in with /i, "")}.` } : linkedProvider ? { kind: "ok", text: `On. Your ${linkedProvider.models.label} show on My models.` } : null;
      return html(res, 200, settingsPage(config, user, db.identitiesOf(user.id), { passwordFree: recentProviderSignIn(req), flash, linkedModels: linkedSwitches(user) }));
    }
    const linkedOff = pathname.match(/^\/settings\/linked\/([a-z0-9-]+)\/off$/);
    if (user && method === "POST" && linkedOff?.[1]) {
      const provider = linkedProviderOf(linkedOff[1]);
      await linkedHosts.unlink(user, provider);
      return html(res, 200, settingsPage(config, user, db.identitiesOf(user.id), { flash: { kind: "ok", text: `Off. ${provider.models.label} no longer show here, and your assistants can't reach them through this app.` }, linkedModels: linkedSwitches(user) }));
    }
    if (user && pathname === "/settings/profile" && method === "POST") {
      const name = ((await readForm(req)).get("name") ?? "").trim().slice(0, 80);
      if (!name) return html(res, 400, settingsPage(config, user, db.identitiesOf(user.id), { flash: { kind: "error", text: "Your name can't be empty." } }));
      db.renameUser(user.id, name);
      const fresh = db.userById(user.id) ?? user;
      return html(res, 200, settingsPage(config, fresh, db.identitiesOf(user.id), { flash: { kind: "ok", text: "Saved." } }));
    }
    if (user && pathname === "/settings/password" && method === "POST") {
      const form = await readForm(req);
      const password = form.get("password") ?? "";
      const passwordFree = recentProviderSignIn(req);
      const fail = (status: number, text: string) => html(res, status, settingsPage(config, user, db.identitiesOf(user.id), { passwordFree, flash: { kind: "error", text } }));
      if (!throttle.allow(`password:${user.id}`)) return fail(429, "Too many tries. Wait ten minutes, then try again.");
      if (password.length < 8) return fail(400, "Use a new password of at least 8 characters.");
      if (user.password_hash && !passwordFree && !(await verifyPassword(form.get("current") ?? "", user.password_hash))) return fail(401, "Your current password isn't right. Forgot it? Log out, then use “Forgot your password?” on the log-in page.");
      db.setPassword(user.id, await hashPassword(password));
      const token = sessionToken(req);
      db.deleteSessionsOf(user.id, token ? digest(token) : null);
      console.log("[mutinybim-web] password set", { userId: user.id, recovery: passwordFree });
      const fresh = db.userById(user.id) ?? user;
      return html(res, 200, settingsPage(config, fresh, db.identitiesOf(user.id), { flash: { kind: "ok", text: "Password saved. You were signed out on every other device." } }));
    }
    if (user && pathname === "/settings/scheme" && method === "POST") {
      const json = (req.headers["content-type"] ?? "").startsWith("application/json");
      const raw = json ? await readJson(req) : (await readForm(req)).get("scheme");
      if (!isColorScheme(raw)) {
        if (json) return send(res, 400, "application/json", JSON.stringify({ error: "Pick light, dark or system." }));
        throw new Refusal(400, "Pick light, dark or auto.");
      }
      db.setColorScheme(user.id, raw);
      if (json) return send(res, 204, "text/plain", "");
      return redirect(res, safeReturn(refererPath(req), "/models"));
    }

    if (user && pathname === "/connect" && method === "GET") return html(res, 200, connectView(user, null));
    const assistantDelete = pathname.match(/^\/connect\/assistants\/([0-9a-f-]{36})\/delete$/);
    if (user && method === "POST" && assistantDelete?.[1]) {
      db.deleteAssistantGrant(assistantDelete[1], user.id);
      assistantTools.endGrant(assistantDelete[1]);
      console.log("[mutinybim-web] an assistant was signed out", { userId: user.id });
      return html(res, 200, connectView(user, null, { kind: "ok", text: "Signed out. That assistant can no longer reach your models; it asks you to sign in again next time." }));
    }

    if (pathname === "/oauth/authorize" && user && (method === "GET" || method === "POST")) {
      const form = method === "POST" ? await readForm(req) : null;
      const params = form ? new URLSearchParams(form.get("request") ?? "") : url.searchParams;
      const checked = await checkAuthorize(params, assistantAuth);
      if (!checked.ok && "show" in checked) return html(res, 400, messagePage(config, user, "This assistant can't connect", checked.show, { href: "/connect", label: "Connect an assistant" }));
      if (!checked.ok) return redirect(res, checked.redirect);
      const back = new URL(checked.request.redirectUri);
      const web = back.protocol === "https:" || back.protocol === "http:";
      if (!form) {
        // No form-action: the browser applies it to every redirect after the form posts, and an assistant's
        // callback can redirect on to its own app scheme (Cursor: www.cursor.com → cursor.com → cursor://),
        // which no source list can name in advance.
        const csp = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'`;
        return html(res, 200, assistantConsentPage(config, user, { clientName: checked.request.client.client_name, backTo: web ? back.host : back.protocol.replace(/:$/, ""), request: params.toString(), models: db.modelsOf(user.id).length, shared: db.sharedWith(user.id).length }), { "content-security-policy": csp });
      }
      if (form.get("decision") !== "allow") {
        console.log("[mutinybim-web] a person declined an assistant", { userId: user.id, clientId: checked.request.client.client_id });
        return redirect(res, errorRedirect(config.origin, checked.request.redirectUri, checked.request.state, "access_denied", "The person declined."));
      }
      return redirect(res, approveAuthorize(checked.request, user, assistantAuth));
    }

    if (user && pathname === "/approvals" && method === "GET") return html(res, 200, approvalsPage(config, user, approvals.of(user.id)));
    const approvalRoute = pathname.match(/^\/approvals\/([0-9a-f-]{36})$/);
    if (user && approvalRoute?.[1]) {
      const id = approvalRoute[1];
      if (method === "GET") {
        const item = approvals.get(user.id, id);
        return item ? html(res, 200, approvalPage(config, user, item)) : html(res, 404, messagePage(config, user, "Not found", "That approval request isn't yours, or it was dropped after 30 minutes. Nothing changed.", { href: "/approvals", label: "Approvals" }));
      }
      if (method === "POST") {
        const decision = (await readForm(req)).get("decision");
        const item = await approvals.answer(user.id, id, decision === "approve");
        if (!item) return html(res, 404, messagePage(config, user, "Not found", "That approval request isn't yours, or it was dropped after 30 minutes. Nothing changed.", { href: "/approvals", label: "Approvals" }));
        console.log("[mutinybim-web] a person answered an assistant's change", { userId: user.id, approved: decision === "approve", state: item.state });
        return html(res, 200, approvalPage(config, user, item));
      }
    }

    if (user && pathname === "/connect/keys" && method === "POST") {
      const label = ((await readForm(req)).get("label") ?? "").trim().slice(0, 60) || "Assistant";
      if (db.agentKeysOf(user.id).length >= 10) return html(res, 409, connectView(user, null, { kind: "error", text: "You have 10 agent keys, the most one account keeps. Turn one off first." }));
      const key = randomToken("mbk_");
      db.createAgentKey({ id: randomUUID(), userId: user.id, keyHash: digest(key), label, last4: key.slice(-4) });
      console.log("[mutinybim-web] agent key made", { userId: user.id });
      return html(res, 200, connectView(user, key, { kind: "ok", text: `Made “${label}”.` }));
    }
    const keyDelete = pathname.match(/^\/connect\/keys\/([0-9a-f-]{36})\/delete$/);
    if (user && method === "POST" && keyDelete?.[1]) {
      db.deleteAgentKey(keyDelete[1], user.id);
      return html(res, 200, connectView(user, null, { kind: "ok", text: "Turned off. Assistants using that key can no longer reach your models." }));
    }

    if (user && pathname === "/quote" && method === "GET") {
      // Off unless the deployment sets MUTINYBIM_WEB_QUOTE: then this page is an ordinary "not here".
      if (!config.quote) return html(res, 404, messagePage(config, user, "Not here", "There's no page at this address.", { href: "/models", label: "Back to my models" }));
      const list = db.modelsOf(user.id);
      const wanted = url.searchParams.get("model");
      const chosen = (wanted ? list.find((m) => m.id === wanted) : undefined) ?? list[0] ?? null;
      let summary = null;
      if (chosen) {
        try {
          summary = summarize(await models.head(chosen.id));
        } catch (err) {
          console.error("[mutinybim-web] the quote page couldn't read the model summary; showing the page without it", { modelId: chosen.id, err });
        }
      }
      return html(res, 200, quotePage(config, config.quote, user, list, chosen, summary));
    }

    const summaryRoute = pathname.match(/^\/api\/hosted\/models\/([a-z0-9-]+)\/summary$/);
    if (user && method === "GET" && summaryRoute?.[1]) {
      const { model } = reachableModel(user, summaryRoute[1]);
      return json(res, 200, summarize(await models.head(model.id)));
    }
    const buildingModel = pathname.match(/^\/api\/projects\/([^/]+)\/building-model$/);
    if (user && method === "GET" && buildingModel?.[1]) {
      const { model } = reachableModel(user, decodeURIComponent(buildingModel[1]));
      const branch = url.searchParams.get("branch");
      return json(res, 200, { projectNumber: "", references: [], authority: branch ? { url: syncUrl, modelId: `${model.id}~${branch}`, mainModelId: model.id, branchId: branch } : { url: syncUrl, modelId: model.id } });
    }

    const editorPage = pathname.match(/^\/m\/([a-z0-9-]+)\/?$/);
    if (user && method === "GET" && editorPage?.[1]) {
      const { model, access } = reachableModel(user, editorPage[1]);
      if (!editor) return html(res, 503, messagePage(config, user, "The editor is off", "This server was started without the editor."));
      const owner = access === "owner" ? null : (db.userById(model.owner_id)?.display_name ?? "its owner");
      const pageData = JSON.stringify({ modelId: model.id, modelName: model.name, userId: user.id, displayName: user.display_name, quoteLabel: config.quote?.label ?? null, access, owner, colorScheme: user.color_scheme }).replace(/</g, "\\u003c");
      return html(res, 200, editorHtml(model.name, pageData, user.color_scheme));
    }

    if (editor && (pathname.startsWith("/dist/") || pathname.startsWith("/assets/") || (pathname.startsWith("/mutinybim/") && !/^\/mutinybim\/[^/]+\/?$/.test(pathname)) || pathname.startsWith("/pdfjs/") || pathname.startsWith("/api/") || /\.(wasm|mjs)$/.test(pathname))) {
      if (pathname.startsWith("/api/") && !user) return json(res, 401, { error: "You are signed out. Log in again." });
      if (await editor.handle(req, res, url)) return;
    }
    if (pathname.startsWith("/assets/bim-ui/")) {
      const file = path.resolve(APP_DIR, "../../packages/bim-ui/assets", `.${path.sep}${decodeURIComponent(pathname.slice("/assets/bim-ui/".length))}`);
      if (file.startsWith(path.resolve(APP_DIR, "../../packages/bim-ui/assets") + path.sep)) {
        try {
          return send(res, 200, file.endsWith(".svg") ? "image/svg+xml" : "image/png", await readFile(file), { "cache-control": "public, max-age=3600" });
        } catch (err) {
          console.error("[mutinybim-web] brand file missing", { pathname, err });
        }
      }
    }
    html(res, 404, messagePage(config, user, "Not here", "There's no page at this address.", { href: user ? "/models" : "/", label: user ? "Back to my models" : "Home" }));
  }

  function editorHtml(modelName: string, pageData: string, scheme: string): string {
    return `<!doctype html>
<html lang="en" data-mutiny-scheme="${esc(scheme)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(modelName)} · MutinyBIM</title>
<link rel="icon" type="image/svg+xml" href="/assets/bim-ui/mutiny-icon.svg">
<link rel="stylesheet" href="/dist/styles.css">
<script type="application/json" id="mutinybim-page">${pageData}</script>
</head><body><div id="app"><p style="font:15px system-ui,sans-serif;padding:24px;color:#5d6670" id="loading">Opening the editor…</p></div>
<script type="module" src="/dist/app.js"></script></body></html>`;
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (err instanceof Refusal) {
        const user = sessionUser(req);
        if ((req.url ?? "").startsWith("/api/")) return json(res, err.status, { error: err.words });
        return html(res, err.status, messagePage(config, user, err.status === 404 ? "Not found" : "That didn't work", err.words, { href: user ? "/models" : "/", label: user ? "Back to my models" : "Home" }));
      }
      console.error("[mutinybim-web] request failed", { url: req.url, err });
      if (res.headersSent) return res.end();
      const words = "The server hit an error it didn't expect. Try again; if it keeps happening, the server log has the details.";
      try {
        html(res, 500, messagePage(config, null, "Something broke", words, { href: "/", label: "Home" }));
      } catch (pageErr) {
        console.error("[mutinybim-web] the error page itself failed; answering in plain text", { pageErr });
        send(res, 500, "text/plain; charset=utf-8", words);
      }
    });
  });

  // The model server: one address for every model and branch; the first hello names the model.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", config.origin);
    if (url.pathname !== "/sync") {
      socket.destroy();
      return;
    }
    const key = url.searchParams.get("key");
    const person = key ? db.userByAgentKey(digest(key)) : sessionUser(req);
    if (!person) {
      console.warn("[mutinybim-web] a model connection was refused: not signed in", { agentKey: Boolean(key) });
      socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nSign in (or use an agent key from Connect an assistant) to open this model.");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => serveSocket(ws, person, url.searchParams.get("model"), Boolean(key)));
  });

  /** Open model connections, by base model, so losing access disconnects at once. */
  const live = new Map<string, Set<{ readonly userId: string; readonly endpoint: ModelEndpoint }>>();
  /** Closes connections to a model: everyone's (`userId` null, the model was deleted) or one person's. They reconnect and are checked again. */
  function disconnect(baseModelId: string, userId: string | null): void {
    for (const entry of live.get(baseModelId) ?? []) {
      if (userId === null || entry.userId === userId) entry.endpoint.close(4403, "Your access to this model changed. Reopen it from My models.");
    }
  }

  /**
   * One connection to the model server, for a person: the first hello names
   * the model, the person's access to it is checked, and the connection
   * joins that model's hub as `actorId` (the person, an agent run of
   * theirs, or "*" for a key-holding tool server naming its own runs),
   * read-only when the model was shared with them to view.
   */
  const attach: AttachModel = (person, actorId, modelFromUrl, endpoint) => {
    const conn = { id: randomUUID(), send: (data: string) => endpoint.send(data) };
    let joined: SyncHub | null = null;
    let entry: { readonly userId: string; readonly endpoint: ModelEndpoint } | null = null;
    const deny = (reason: string) => conn.send(JSON.stringify({ type: "denied", reason }));
    return {
      async receive(raw) {
        if (!joined) {
          if (!raw.startsWith('{"type":"hello"')) {
            conn.send(JSON.stringify({ type: "error", message: "Say hello first: this connection has not named a model yet." }));
            return;
          }
          const parsed: unknown = JSON.parse(raw);
          const helloModel = typeof parsed === "object" && parsed !== null && "modelId" in parsed && typeof parsed.modelId === "string" ? parsed.modelId : null;
          const requested = helloModel ?? modelFromUrl;
          if (!requested) return deny("Name a model: this server keeps many.");
          const base = baseModelOf(requested);
          const found = db.accessTo(person.id, base);
          if (!found) {
            console.warn("[mutinybim-web] a model connection asked for a model its person can't reach", { userId: person.id, actorId });
            return deny(NOT_YOURS);
          }
          const hub = await models.hubFor(base, requested);
          if (!hub) return deny("That branch was closed or no longer exists. Switch back to Main.");
          joined = hub;
          entry = { userId: person.id, endpoint };
          const set = live.get(base) ?? new Set();
          set.add(entry);
          live.set(base, set);
          joined.join(conn, { actorId, canWrite: found.access !== "view" });
        }
        await joined.handle(conn, raw);
      },
      async leave() {
        if (entry) for (const set of live.values()) set.delete(entry);
        await joined?.leave(conn);
      },
    };
  };

  const hostedScripts = options.scripts ?? scriptsFor(config);
  const assistantTools = createAssistantTools({ auth: assistantAuth, db, dataDir: config.dataDir, approvals, attach, scripts: hostedScripts, linked: linkedHosts, ...(options.approvalWaitMs !== undefined ? { approvalWaitMs: options.approvalWaitMs } : {}) });

  function connectView(user: UserRow, newKey: string | null, flash?: Flash): string {
    const linkedLabels = linkedHosts.providers.filter((p) => db.linkedGrant(user.id, p.id)?.state === "ok").map((p) => p.models.label);
    return connectPage(config, user, { models: db.modelsOf(user.id), keys: db.agentKeysOf(user.id), assistants: db.assistantGrantsOf(user.id), newKey, linkedLabels }, flash);
  }

  function serveSocket(socket: WebSocket, person: UserRow, modelFromUrl: string | null, viaAgentKey: boolean): void {
    // A browser edits as its person; a key-holding tool server names its own runs (`agent:<person>:<run>`), so it may send any actor id.
    const attachment = attach(person, viaAgentKey ? "*" : person.id, modelFromUrl, { send: (data) => socket.send(data), close: (code, reason) => socket.close(code, reason) });
    let queue: Promise<void> = Promise.resolve();
    socket.on("message", (data) => {
      const raw = data.toString();
      queue = queue.then(() => attachment.receive(raw)).catch((err: unknown) => console.error("[mutinybim-web] model message failed", { err }));
    });
    socket.on("close", () => {
      queue = queue.then(() => attachment.leave()).catch((err: unknown) => console.error("[mutinybim-web] leaving a model failed", { err }));
    });
    socket.on("error", (err) => console.error("[mutinybim-web] model socket error", { err }));
  }

  return {
    server,
    db,
    models,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          editor?.warm();
          // Tries the script box once at start, so the log says whether scripts run here.
          void hostedScripts.availability();
          resolve();
        });
      }),
    async close() {
      for (const client of wss.clients) client.terminate();
      await assistantTools.close();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      // Long-lived assistant streams would hold the close open; they reconnect to the next server.
      server.closeAllConnections();
      await closed;
      await models.flush();
      db.close();
    },
  };
}
