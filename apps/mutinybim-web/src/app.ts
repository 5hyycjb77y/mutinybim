/**
 * The hosted MutinyBIM web app: accounts, a person's models and the ones
 * shared with them, the editor, the model server those models sync through,
 * bring-your-own-AI settings, the page for connecting an outside assistant,
 * and an optional quote link.
 * One Node process, no framework; see README.md.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import postcss from "postcss";
import { WebSocketServer, type WebSocket } from "ws";
import { parseBranchModelId } from "@permitzip/bim-kernel";
import { TOOL_FAMILIES } from "@permitzip/bim-mcp";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { LocalScriptRunner } from "@permitzip/bim-script-runner/local";
import { readClientMessage, type SyncHub } from "@permitzip/bim-sync";
import { createEditorDemo, type EditorDemo } from "../../../packages/bim-editor/demo/server";
import { ApprovalBook, approvalTitle } from "./assistant-approvals";
import { approveAuthorize, checkAuthorize, errorRedirect, type AssistantAuthOptions } from "./assistant-auth";
import { createAssistantTools, type AttachModel, type ModelEndpoint } from "./assistant-tools";
import type { OAuthProviderConfig, WebConfig } from "./config";
import { DEFAULT_RUNNER_DIR, localScripts, ScriptSandbox, scriptsOff, sealedScripts, type HostedScripts } from "./script-sandbox";
import { isColorScheme, openDb, type Db, type ModelAccess, type ModelRow, type ShareRole, type UserRow } from "./db";
import { openSupabaseStore } from "./db-supabase";
import { esc, formatWhen, setWaitingApprovals, type Flash } from "./ui";
import { ModelStore, summarize, type StarterKind } from "./models";
import { ModelCreator } from "./model-creation";
import { finishSignIn, SignInError, startSignIn, type Fetch } from "./oauth";
import { createLinkedHosts, LINK_STATE_PREFIX, readLinkKeys, type LinkedProvider, type LinkKeys } from "./linked-hosts";
import { approvalPage, approvalsPage, assistantConsentPage, connectPage, forgotPage, landingPage, linkedOfferPage, loginPage, messagePage, modelsPage, privacyPage, quotePage, resetPage, settingsPage, sharePage, signupPage, supabaseResetPage, termsPage, type LinkedModelsView, type LinkedSwitch } from "./pages";
import { digest, hashPassword, pkcePair, randomToken, verifyPassword } from "./secrets";
import { exchangePkceCode, googleAuthorizeUrl, requestPasswordReset, signInWithPassword, signUpWithPassword, SupabaseAuthError, updatePassword, verifyTokenHash, type SupabaseUser } from "./supabase-auth";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, "..");
const SESSION_COOKIE = "mutinybim_session";
const SUPABASE_PKCE_COOKIE = "mutinybim_sb_pkce";
const SUPABASE_RECOVERY_COOKIE = "mutinybim_sb_recovery";
const SESSION_DAYS = 30;
const BODY_LIMIT = 64 * 1024;
/** After a linked sign-in, a password can be set without the old one for this long (the recovery path). */
const RECOVERY_WINDOW_MS = 10 * 60_000;

/** Resolves the caller's IP for rate limiting, trusting Fly-Client-IP / X-Forwarded-For only behind a trusted proxy. */
function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fly = req.headers["fly-client-ip"];
    if (typeof fly === "string" && fly.trim() !== "") return fly.trim();
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string") {
      const first = forwarded.split(",")[0]?.trim();
      if (first) return first;
    }
  }
  return req.socket.remoteAddress ?? "?";
}

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
  const db: Db = config.supabase?.secretKey
    ? openSupabaseStore({ url: config.supabase.url, secretKey: config.supabase.secretKey, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) })
    : openDb(path.join(config.dataDir, "accounts.sqlite"));
  const models = new ModelStore(path.join(config.dataDir, "models"), (modelId) => {
    void db.touchModel(modelId).catch((err: unknown) => console.error("[mutinybim-web] touching model updated_at failed", { modelId, err }));
  });
  const creator = new ModelCreator(db, path.join(config.dataDir, "models"));
  const throttle = new Throttle(20, 10 * 60_000);
  const ipOf = (req: IncomingMessage): string => clientIp(req, Boolean(config.trustProxy));
  const syncUrl = `${config.origin.replace(/^http/, "ws")}/sync`;
  const approvals = new ApprovalBook(db);
  setWaitingApprovals((userId) => approvals.cachedWaiting(userId));
  const linkedHosts = createLinkedHosts({ config, db, keys: options.linkKeys !== undefined ? options.linkKeys : readLinkKeys(), ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  const assistantAuth: AssistantAuthOptions = { origin: config.origin, families: TOOL_FAMILIES, db, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), ...(options.resolveHost ? { resolveHost: options.resolveHost } : {}) };

  const editor: EditorDemo | null =
    options.editor === false
      ? null
      : createEditorDemo({
          entry: path.join(APP_DIR, "client/entry.tsx"),
          outDir: process.env.MUTINYBIM_WEB_BUILD ?? path.join(config.dataDir, "editor-build"),
          // The image's sources never change: don't stat every input on each editor request.
          watchSources: process.env.NODE_ENV !== "production",
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
    appCss ??= Promise.all([readFile(from, "utf8"), import("@tailwindcss/postcss")])
      .then(([source, { default: tailwind }]) => postcss([tailwind({ base: APP_DIR })]).process(source, { from }))
      .then((r) => r.css)
      .catch((err: unknown) => {
        appCss = null;
        throw err;
      });
    return appCss;
  };

  const sessionToken = (req: IncomingMessage): string | null => cookies(req).get(SESSION_COOKIE) ?? null;
  const sessionUser = async (req: IncomingMessage): Promise<UserRow | null> => {
    const token = sessionToken(req);
    return token ? db.userBySession(digest(token)) : null;
  };
  /** True when this session came from a linked sign-in in the last few minutes (setting a password needs no old one then). */
  const recentProviderSignIn = async (req: IncomingMessage): Promise<boolean> => {
    const token = sessionToken(req);
    const info = token ? await db.session(digest(token)) : null;
    return Boolean(info && info.via !== "password" && info.via !== "reset" && Date.now() - Date.parse(info.created_at) < RECOVERY_WINDOW_MS);
  };

  const makeCookie = (name: string, value: string, maxAgeS: number, cookiePath = "/"): string =>
    `${name}=${encodeURIComponent(value)}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${config.secure ? "; Secure" : ""}`;

  const sessionCookie = (token: string, maxAgeS: number): string => makeCookie(SESSION_COOKIE, token, maxAgeS, "/");

  const startSession = async (userId: string, via: string): Promise<string> => {
    const token = randomToken();
    await db.createSession(digest(token), userId, new Date(Date.now() + SESSION_DAYS * 86_400_000), via);
    return sessionCookie(token, SESSION_DAYS * 86_400);
  };

  /**
   * Ensures a Supabase Auth user has a matching local user + identity row.
   * An existing account is attached by email only when this sign-in came
   * through Google and Google reported the address verified. Supabase marks
   * every address confirmed when its "Confirm email" setting is off, so a
   * password sign-up proves nothing. An emailed link isn't enough either: the
   * Supabase user behind it may carry a password someone else chose. For the
   * same reason the Supabase user must sign in only through Google: Supabase
   * merges a Google sign-in into an existing Supabase user with that address,
   * which may already hold someone else's password.
   */
  async function syncSupabaseUser(sbUser: SupabaseUser, options?: { readonly allowCreate?: boolean; readonly provenBy?: "google" }): Promise<{ readonly user: UserRow; readonly created: boolean } | "email_in_use" | null> {
    const isGoogle = sbUser.providers.includes("google");
    const byIdentity = await db.userByIdentity("supabase", sbUser.id);
    if (byIdentity) {
      if (isGoogle) await db.linkIdentity("google", sbUser.id, byIdentity.id);
      return { user: byIdentity, created: false };
    }
    const byEmail = await db.userByEmail(sbUser.email);
    let created = false;
    if (byEmail) {
      if (options?.provenBy !== "google" || !sbUser.emailConfirmed || !sbUser.googleVerifiedEmail) {
        console.warn("[mutinybim-web] a supabase sign-in used an existing account's email; not attached", { userId: byEmail.id });
        return "email_in_use";
      }
      await db.linkIdentity("supabase", sbUser.id, byEmail.id);
    } else {
      if (options?.allowCreate === false || !config.signupOpen) return null;
      created = await db.createSupabaseUser({ id: sbUser.id, email: sbUser.email, displayName: sbUser.displayName });
    }
    // A duplicate insert can lose to a different binding. Only the stored
    // subject owner can receive this session or its Google sign-in marker.
    const linked = await db.userByIdentity("supabase", sbUser.id);
    if (!linked || linked.id !== (byEmail?.id ?? sbUser.id)) return "email_in_use";
    if (isGoogle) await db.linkIdentity("google", sbUser.id, linked.id);
    if (created) console.log("[mutinybim-web] account synced from supabase", { userId: linked.id, google: isGoogle });
    return { user: linked, created };
  }

  /** A form post must come from this app's own pages (SameSite cookies plus an Origin check). */
  const sameOrigin = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (!origin) return req.headers["sec-fetch-site"] === undefined || req.headers["sec-fetch-site"] === "same-origin";
    return origin === config.origin || origin === `http://${req.headers.host ?? ""}`;
  };

  const NOT_YOURS = "That model isn't in your account or shared with you. It may have been deleted, or its owner stopped sharing it.";
  /** A model the person owns or that was shared with them. */
  const reachableModel = async (user: UserRow, modelId: string): Promise<{ readonly model: ModelRow; readonly access: ModelAccess }> => {
    const found = await db.accessTo(user.id, modelId);
    if (!found) throw new Refusal(404, NOT_YOURS);
    return found;
  };
  /** Renaming, deleting and sharing are the owner's alone. */
  const ownModel = async (user: UserRow, modelId: string): Promise<ModelRow> => {
    const found = await reachableModel(user, modelId);
    if (found.access !== "owner") throw new Refusal(403, `Only the owner can do that. You can ${found.access === "edit" ? "edit" : "view"} “${found.model.name}”.`);
    return found.model;
  };

  const providerOf = (id: string): OAuthProviderConfig => {
    const provider = config.providers.find((p) => p.id === id);
    if (!provider) throw new Refusal(404, "That way of signing in isn't set up on this server.");
    return provider;
  };

  const callbackUri = (provider: OAuthProviderConfig) => `${config.origin}/auth/${provider.id}/callback`;
  const supabaseCallbackUri = () => `${config.origin}/auth/supabase/callback`;

  const linkedProviderOf = (id: string): LinkedProvider => {
    const provider = linkedHosts.provider(id);
    if (!provider) throw new Refusal(404, "Projects from that sign-in aren't set up on this server.");
    return provider;
  };

  /** Right after a sign-in with a linked host, once: offer to show its models too (or go straight on). */
  const afterSignIn = async (userId: string, provider: OAuthProviderConfig, returnTo: string): Promise<string> => {
    const host = linkedHosts.provider(provider.id);
    if (!host || (await db.linkedGrant(userId, host.id)) || (await db.linkedOfferAnswered(userId, host.id))) return returnTo;
    return `/auth/${host.id}/models/offer?return_to=${encodeURIComponent(returnTo)}`;
  };

  /** The linked hosts' sections on My models: for each host this person signs in with (or already linked). */
  async function linkedModelsView(user: UserRow, fresh: boolean): Promise<LinkedModelsView> {
    const mine = await db.identitiesOf(user.id);
    const eligible: LinkedProvider[] = [];
    for (const p of linkedHosts.providers) {
      if (mine.includes(p.id) || (await db.linkedGrant(user.id, p.id))) eligible.push(p);
    }
    const sections = await Promise.all(eligible.map((p) => linkedHosts.view(user, p, { fresh })));
    const keyMissing = linkedHosts.keyMissing ? config.providers.filter((p) => p.models && mine.includes(p.id)) : [];
    const emailDomain = user.email.split("@")[1]?.toLowerCase() ?? "";
    const linkPrompts: OAuthProviderConfig[] = [];
    if (emailDomain) {
      for (const p of config.providers) {
        if (!p.domains?.includes(emailDomain) || mine.includes(p.id)) continue;
        if (await db.linkedOfferAnswered(user.id, `link-prompt:${p.id}`)) continue;
        linkPrompts.push(p);
      }
    }
    return { sections, keyMissing, linkPrompts };
  }

  async function linkedSwitches(user: UserRow): Promise<{ readonly provider: LinkedProvider; readonly state: LinkedSwitch }[]> {
    return Promise.all(
      linkedHosts.providers.map(async (provider) => {
        const grant = await db.linkedGrant(user.id, provider.id);
        return { provider, state: !grant ? "off" : grant.state === "reconnect" ? "reconnect" : "on" };
      }),
    );
  }

  async function modelsView(user: UserRow, flash: Flash | null, status = 200, fresh = false): Promise<{ status: number; body: string }> {
    const [own, shared, linked, pending, inbox] = await Promise.all([
      db.modelsOf(user.id), db.sharedWith(user.id), linkedModelsView(user, fresh), db.pendingCreations(user.id), db.transfers.inbox(user.id),
    ]);
    return { status, body: modelsPage(config, user, own, shared, flash ?? undefined, linked, pending, inbox) };
  }

  async function handleAuthCallback(req: IncomingMessage, res: ServerResponse, url: URL, provider: OAuthProviderConfig): Promise<void> {
    const error = url.searchParams.get("error");
    if (error) {
      const words = error === "access_denied" ? `You didn't allow MutinyBIM on ${provider.label.replace(/^Log in with /i, "")}. Nothing changed.` : `${provider.label} sign-in stopped (${error}). Try again, or sign in with email.`;
      return html(res, 400, loginPage(config, { returnTo: "/models", flash: { kind: "error", text: words } }));
    }
    const code = url.searchParams.get("code");
    const stateParam = url.searchParams.get("state");
    const state = stateParam ? await db.takeOAuthState(stateParam) : null;
    if (!code || !state || state.provider !== provider.id || state.return_to.startsWith(LINK_STATE_PREFIX)) {
      return html(res, 400, loginPage(config, { returnTo: "/models", flash: { kind: "error", text: "That sign-in link expired or was already used. Start again." } }));
    }
    const person = await finishSignIn({ provider, redirectUri: callbackUri(provider), code, codeVerifier: state.code_verifier, db, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
    const linking = state.return_to.startsWith("link:");
    const returnTo = safeReturn(linking ? state.return_to.slice(5) : state.return_to);
    const known = await db.userByIdentity(provider.id, person.subject);
    async function confirmProviderEmail(user: UserRow): Promise<void> {
      if (person.emailVerified && person.email && !user.email_confirmed_at) {
        await db.confirmIdentityEmail(provider.id, person.subject, user.id, person.email);
      }
    }
    if (linking) {
      const current = await sessionUser(req);
      if (!current) return redirect(res, "/login?return_to=%2Fsettings");
      if (known && known.id !== current.id) return html(res, 409, settingsPage(config, current, await db.identitiesOf(current.id), { flash: { kind: "error", text: `That ${provider.label.replace(/^Log in with /i, "")} account is already linked to another MutinyBIM account.` } }));
      await db.linkIdentity(provider.id, person.subject, current.id);
      await confirmProviderEmail(current);
      console.log("[mutinybim-web] linked a sign-in", { provider: provider.id, userId: current.id });
      return redirect(res, await afterSignIn(current.id, provider, `${returnTo}${returnTo.includes("?") ? "&" : "?"}linked=${provider.id}`));
    }
    if (known) {
      await confirmProviderEmail(known);
      console.log("[mutinybim-web] signed in", { provider: provider.id, userId: known.id });
      return redirect(res, await afterSignIn(known.id, provider, returnTo), { "set-cookie": await startSession(known.id, provider.id) });
    }
    if (!person.email) return html(res, 400, loginPage(config, { returnTo, flash: { kind: "error", text: `${provider.label} didn't share an email address, which a MutinyBIM account needs. Sign up with email instead.` } }));
    const sameEmail = await db.userByEmail(person.email);
    if (sameEmail) {
      const how = config.supabase?.google ? "Google or your password" : "its password";
      return html(res, 409, loginPage(config, { email: person.email, returnTo: "/settings", flash: { kind: "error", text: `A MutinyBIM account with ${person.email} already exists. Log in with ${how}, then link ${provider.label.replace(/^Log in with /i, "")} under Settings → Ways to log in.` } }));
    }
    if (!config.signupOpen) return html(res, 403, loginPage(config, { returnTo, flash: { kind: "error", text: "New accounts can't be made on this server right now." } }));
    const user = await db.createUser({ id: randomUUID(), email: person.email, displayName: person.name ?? person.email.split("@")[0] ?? "You", passwordHash: null });
    await db.linkIdentity(provider.id, person.subject, user.id);
    await confirmProviderEmail(user);
    console.log("[mutinybim-web] account made through a sign-in provider", { provider: provider.id, userId: user.id });
    return redirect(res, await afterSignIn(user.id, provider, returnTo), { "set-cookie": await startSession(user.id, provider.id) });
  }

  /** Finishes a Supabase Auth callback (Google OAuth PKCE, email confirmation, or password recovery). */
  async function handleSupabaseCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const sb = config.supabase;
    if (!sb) throw new Refusal(404, "Supabase sign-in isn't set up on this server.");
    const clearPkce = makeCookie(SUPABASE_PKCE_COOKIE, "", 0, "/auth/supabase/callback");
    const error = url.searchParams.get("error");
    if (error) {
      const desc = url.searchParams.get("error_description");
      const words = error === "access_denied" ? "You didn't allow Google sign-in. Nothing changed." : desc ? `Sign-in stopped: ${desc}` : `Sign-in stopped (${error}). Try again, or sign in with email.`;
      return html(res, 400, loginPage(config, { returnTo: "/models", flash: { kind: "error", text: words } }), { "set-cookie": clearPkce });
    }
    const code = url.searchParams.get("code");
    const tokenHash = url.searchParams.get("token_hash");
    const rawType = url.searchParams.get("type");
    const pkceStateKey = cookies(req).get(SUPABASE_PKCE_COOKIE) ?? null;
    const state = pkceStateKey ? await db.takeOAuthState(pkceStateKey) : null;
    let verified: { readonly user: SupabaseUser; readonly accessToken: string };
    let flow: "google" | "signup" | "recovery" | "email" = "email";
    let returnTo = "/models";
    try {
      if (code) {
        if (!state || !state.provider.startsWith("supabase-")) {
          return html(res, 400, loginPage(config, { returnTo: "/models", flash: { kind: "error", text: "That sign-in link expired or was opened in a different browser. Start again." } }), { "set-cookie": clearPkce });
        }
        verified = await exchangePkceCode(sb, { code, codeVerifier: state.code_verifier }, options.fetchImpl);
        returnTo = safeReturn(state.return_to);
        if (state.provider === "supabase-google") flow = "google";
        else if (state.provider === "supabase-recovery") flow = "recovery";
        else if (state.provider === "supabase-signup") flow = "signup";
      } else if (tokenHash && (rawType === "signup" || rawType === "recovery" || rawType === "magiclink" || rawType === "email")) {
        verified = await verifyTokenHash(sb, { tokenHash, type: rawType }, options.fetchImpl);
        flow = rawType === "recovery" ? "recovery" : rawType === "signup" ? "signup" : "email";
        if (state) returnTo = safeReturn(state.return_to);
      } else {
        return html(res, 400, loginPage(config, { returnTo: "/models", flash: { kind: "error", text: "That sign-in link was incomplete or expired. Start again." } }), { "set-cookie": clearPkce });
      }
    } catch (err) {
      if (!(err instanceof SupabaseAuthError)) throw err;
      console.error("[mutinybim-web] supabase callback verification failed", { code: err.code, status: err.status });
      return html(res, err.status, loginPage(config, { returnTo: "/models", flash: { kind: "error", text: err.words } }), { "set-cookie": clearPkce });
    }
    const synced = await syncSupabaseUser(verified.user, flow === "google" ? { provenBy: "google" } : {});
    if (synced === "email_in_use") {
      return html(res, 409, loginPage(config, { returnTo: "/models", flash: { kind: "error", text: "That email belongs to an existing MutinyBIM account. Log in with that account's password, or reset it." } }), { "set-cookie": clearPkce });
    }
    if (!synced) {
      return html(res, 403, loginPage(config, { returnTo: "/models", flash: { kind: "error", text: "New accounts can't be made on this server right now." } }), { "set-cookie": clearPkce });
    }
    if (flow === "recovery") {
      const cookiesOut = [
        clearPkce,
        await startSession(synced.user.id, "recovery"),
        makeCookie(SUPABASE_RECOVERY_COOKIE, verified.accessToken, 600, "/reset-password"),
      ];
      return redirect(res, "/reset-password", { "set-cookie": cookiesOut });
    }
    const via = flow === "google" || verified.user.providers.includes("google") ? "google" : "supabase";
    const destination = synced.created && returnTo === "/models" ? "/models?welcome=1" : returnTo;
    return redirect(res, destination, { "set-cookie": [clearPkce, await startSession(synced.user.id, via)] });
  }

  /** Back from the linked host: keep its pass, then show its models. */
  async function handleLinkedCallback(req: IncomingMessage, res: ServerResponse, url: URL, provider: LinkedProvider): Promise<void> {
    const current = await sessionUser(req);
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
    const state = stateParam ? await db.takeOAuthState(stateParam) : null;
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
    const user = await sessionUser(req);
    if (user && !pathname.startsWith("/dist/") && !pathname.startsWith("/assets/") && !pathname.startsWith("/static/")) {
      await approvals.waiting(user.id);
    }

    // The tool server and its sign-in addresses take requests from assistants (other origins, bearer tokens, no cookies).
    if (await assistantTools.handle(req, res, url)) return;

    if (method === "POST" && !sameOrigin(req)) throw new Refusal(403, "That form came from another site, so it was not accepted. Reload this app and try again.");

    if (method === "GET" && pathname === "/healthz") return json(res, 200, { ok: true });
    if (method === "GET" && pathname === "/static/app.css") return send(res, 200, "text/css; charset=utf-8", await bundleCss(), { "cache-control": "public, max-age=300" });
    if (method === "GET" && pathname === "/static/confirm.js") return send(res, 200, "text/javascript; charset=utf-8", await readFile(path.join(APP_DIR, "public/confirm.js")), { "cache-control": "public, max-age=300" });
    if (method === "GET" && pathname === "/static/approvals.js") return send(res, 200, "text/javascript; charset=utf-8", await readFile(path.join(APP_DIR, "public/approvals.js")), { "cache-control": "public, max-age=300" });
    if (method === "GET" && pathname === "/static/settings.js") return send(res, 200, "text/javascript; charset=utf-8", await bundleSettings(), { "cache-control": "public, max-age=300" });

    if (method === "GET" && pathname === "/") return user ? redirect(res, "/models") : html(res, 200, landingPage(config));

    if (pathname === "/login") {
      if (method === "GET") return user ? redirect(res, safeReturn(url.searchParams.get("return_to"))) : html(res, 200, loginPage(config, { returnTo: safeReturn(url.searchParams.get("return_to")) }));
      if (method === "POST") {
        const form = await readForm(req);
        const email = (form.get("email") ?? "").trim().toLowerCase();
        const password = form.get("password") ?? "";
        const returnTo = safeReturn(form.get("return_to"));
        if (!throttle.allow(`login:${ipOf(req)}`)) return html(res, 429, loginPage(config, { email, returnTo, flash: { kind: "error", text: "Too many tries from here. Wait ten minutes, then try again." } }));
        if (config.supabase) {
          // Pre-migration local accounts still hold an scrypt hash; the right password opens them without linking anything.
          const localAccount = async (): Promise<UserRow | null> => {
            const legacy = email ? await db.userByEmail(email) : null;
            return legacy?.password_hash && (await verifyPassword(password, legacy.password_hash)) ? legacy : null;
          };
          try {
            const signedIn = await signInWithPassword(config.supabase, { email, password }, options.fetchImpl);
            const synced = await syncSupabaseUser(signedIn.user);
            if (synced === "email_in_use") {
              // The Supabase user stays unattached, but whoever knows this account's own password is its owner.
              const legacy = await localAccount();
              if (legacy) return redirect(res, returnTo, { "set-cookie": await startSession(legacy.id, "password") });
              return html(res, 409, loginPage(config, { email, returnTo, flash: { kind: "error", text: "That email belongs to an existing MutinyBIM account. Log in with that account's password, or reset it." } }));
            }
            if (!synced) return html(res, 403, loginPage(config, { email, returnTo, flash: { kind: "error", text: "New accounts can't be made on this server right now." } }));
            return redirect(res, returnTo, { "set-cookie": await startSession(synced.user.id, "password") });
          } catch (err) {
            if (!(err instanceof SupabaseAuthError)) throw err;
            if (err.code === "invalid_credentials") {
              const legacy = await localAccount();
              if (legacy) return redirect(res, returnTo, { "set-cookie": await startSession(legacy.id, "password") });
            }
            return html(res, err.status, loginPage(config, { email, returnTo, flash: { kind: "error", text: err.words } }));
          }
        }
        const found = email ? await db.userByEmail(email) : null;
        const ok = found?.password_hash ? await verifyPassword(password, found.password_hash) : false;
        if (!found || !ok) {
          const words = found && !found.password_hash ? "This account signs in through a linked account (no password). Use the button below." : "That email and password don't match an account. Check both and try again.";
          return html(res, 401, loginPage(config, { email, returnTo, flash: { kind: "error", text: words } }));
        }
        return redirect(res, returnTo, { "set-cookie": await startSession(found.id, "password") });
      }
    }

    if (pathname === "/forgot") {
      if (method === "GET") return user ? redirect(res, "/settings#password") : html(res, 200, forgotPage(config));
      if (method === "POST" && config.supabase) {
        const form = await readForm(req);
        const email = (form.get("email") ?? "").trim().toLowerCase();
        if (!throttle.allow(`forgot:${ipOf(req)}`)) return html(res, 429, forgotPage(config, { email, flash: { kind: "error", text: "Too many reset requests from here. Wait ten minutes, then try again." } }));
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return html(res, 400, forgotPage(config, { email, flash: { kind: "error", text: "Enter a full email address, like name@example.com." } }));
        const { verifier, challenge } = pkcePair();
        const state = randomToken();
        await db.saveOAuthState({ state, provider: "supabase-recovery", codeVerifier: verifier, returnTo: "/reset-password" });
        try {
          await requestPasswordReset(config.supabase, { email, redirectTo: supabaseCallbackUri(), codeChallenge: challenge }, options.fetchImpl);
        } catch (err) {
          if (err instanceof SupabaseAuthError && err.status === 429) {
            return html(res, 429, forgotPage(config, { email, flash: { kind: "error", text: err.words } }));
          }
          console.error("[mutinybim-web] supabase password reset request failed", { err });
        }
        return html(res, 200, forgotPage(config, { email, flash: { kind: "ok", text: `If an account uses ${email}, we sent a password reset link. Check your inbox.` } }), {
          "set-cookie": makeCookie(SUPABASE_PKCE_COOKIE, state, 900, "/auth/supabase/callback"),
        });
      }
    }

    if (pathname === "/reset-password" && config.supabase) {
      const recoveryToken = cookies(req).get(SUPABASE_RECOVERY_COOKIE) ?? null;
      if (!user || !recoveryToken) return redirect(res, "/forgot");
      if (method === "GET") return html(res, 200, supabaseResetPage({ email: user.email }));
      if (method === "POST") {
        const password = (await readForm(req)).get("password") ?? "";
        if (password.length < 8) return html(res, 400, supabaseResetPage({ email: user.email, flash: { kind: "error", text: "Use a password of at least 8 characters." } }));
        try {
          await updatePassword(config.supabase, { accessToken: recoveryToken, password }, options.fetchImpl);
        } catch (err) {
          if (!(err instanceof SupabaseAuthError)) throw err;
          return html(res, err.status, supabaseResetPage({ email: user.email, flash: { kind: "error", text: err.words } }));
        }
        await db.deleteSessionsOf(user.id);
        console.log("[mutinybim-web] password reset through supabase recovery", { userId: user.id });
        return redirect(res, "/models?reset=1", {
          "set-cookie": [makeCookie(SUPABASE_RECOVERY_COOKIE, "", 0, "/reset-password"), await startSession(user.id, "reset")],
        });
      }
    }

    const reset = pathname.match(/^\/reset\/([A-Za-z0-9_-]{20,80})$/);
    if (reset?.[1]) {
      const tokenHash = digest(reset[1]);
      const person = await db.userByPasswordReset(tokenHash);
      if (method === "GET") return html(res, person ? 200 : 410, resetPage({ token: reset[1], email: person?.email ?? null }));
      if (method === "POST") {
        if (!person) return html(res, 410, resetPage({ token: reset[1], email: null }));
        const password = (await readForm(req)).get("password") ?? "";
        if (password.length < 8) return html(res, 400, resetPage({ token: reset[1], email: person.email, flash: { kind: "error", text: "Use a password of at least 8 characters." } }));
        // The link is checked again where it is used up: of two uses at once, only one saves a password.
        const redeemed = await db.redeemPasswordReset(tokenHash, await hashPassword(password));
        if (!redeemed) return html(res, 410, resetPage({ token: reset[1], email: null }));
        console.log("[mutinybim-web] password reset with a reset link", { userId: redeemed.id });
        return redirect(res, "/models?reset=1", { "set-cookie": await startSession(redeemed.id, "reset") });
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
        if (!throttle.allow(`signup:${ipOf(req)}`)) return fail("Too many sign-ups from here. Wait ten minutes, then try again.", 429);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("Enter a full email address, like name@example.com.");
        if (!name) return fail("Enter your name; it's what people editing with you see.");
        if (password.length < 8) return fail("Use a password of at least 8 characters.");
        // The sign-up page requires the agreement box (HTML `required`, so a
        // browser can't submit without it). A post that sends no `agree` field
        // at all, such as the app's own tests, is accepted; an explicit "no"
        // is refused.
        if (form.has("agree") && form.get("agree") !== "1") return fail("Tick the box to agree to the Terms of use and the Privacy notice.");
        if (config.supabase) {
          const { verifier, challenge } = pkcePair();
          const state = randomToken();
          await db.saveOAuthState({ state, provider: "supabase-signup", codeVerifier: verifier, returnTo: "/models" });
          try {
            const signedUp = await signUpWithPassword(config.supabase, { email, password, displayName: name, redirectTo: supabaseCallbackUri(), codeChallenge: challenge }, options.fetchImpl);
            if (signedUp.alreadyExists) return fail("An account with that email already exists. Log in instead.", 409);
            if (signedUp.needsConfirmation) {
              return html(res, 200, loginPage(config, { email, returnTo: "/models", flash: { kind: "ok", text: `Check your email — we sent a confirmation link to ${email}. Open it to finish creating your account.` } }), {
                "set-cookie": makeCookie(SUPABASE_PKCE_COOKIE, state, 900, "/auth/supabase/callback"),
              });
            }
            const synced = await syncSupabaseUser({ ...signedUp.user, displayName: name });
            if (synced === "email_in_use") return fail("An account with that email already exists. Log in instead.", 409);
            if (!synced) return fail("New accounts can't be made on this server right now.", 403);
            console.log("[mutinybim-web] account made", { userId: synced.user.id, auth: "supabase" });
            return redirect(res, "/models?welcome=1", { "set-cookie": await startSession(synced.user.id, "password") });
          } catch (err) {
            if (!(err instanceof SupabaseAuthError)) throw err;
            return fail(err.words, err.status);
          }
        }
        if (await db.userByEmail(email)) return fail("An account with that email already exists. Log in instead.", 409);
        const created = await db.createUser({ id: randomUUID(), email, displayName: name, passwordHash: await hashPassword(password) });
        console.log("[mutinybim-web] account made", { userId: created.id });
        return redirect(res, "/models?welcome=1", { "set-cookie": await startSession(created.id, "password") });
      }
    }

    if (method === "POST" && pathname === "/logout") {
      const token = cookies(req).get(SESSION_COOKIE);
      if (token) await db.deleteSession(digest(token));
      return redirect(res, "/", { "set-cookie": sessionCookie("", 0) });
    }

    if (method === "GET" && pathname === "/auth/supabase/google/start") {
      if (!config.supabase?.google) throw new Refusal(404, "Google sign-in isn't set up on this server.");
      const returnTo = safeReturn(url.searchParams.get("return_to"));
      const { verifier, challenge } = pkcePair();
      const state = randomToken();
      await db.saveOAuthState({ state, provider: "supabase-google", codeVerifier: verifier, returnTo });
      const target = googleAuthorizeUrl(config.supabase, { redirectTo: supabaseCallbackUri(), codeChallenge: challenge });
      return redirect(res, target, { "set-cookie": makeCookie(SUPABASE_PKCE_COOKIE, state, 900, "/auth/supabase/callback") });
    }

    if (method === "GET" && pathname === "/auth/supabase/callback") {
      return handleSupabaseCallback(req, res, url);
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
    const linkPromptDismiss = pathname.match(/^\/auth\/([a-z0-9-]+)\/link-prompt\/dismiss$/);
    if (user && method === "POST" && linkPromptDismiss?.[1]) {
      const provider = providerOf(linkPromptDismiss[1]);
      await db.answerLinkedOffer(user.id, `link-prompt:${provider.id}`);
      return redirect(res, "/models");
    }
    const linkedRoute = pathname.match(/^\/auth\/([a-z0-9-]+)\/models\/(start|callback|offer)$/);
    if (linkedRoute?.[1] && linkedRoute[2]) {
      const provider = linkedProviderOf(linkedRoute[1]);
      if (!user) return redirect(res, `/login?return_to=${encodeURIComponent(linkedRoute[2] === "callback" ? "/models" : pathname + url.search)}`);
      const returnTo = safeReturn(url.searchParams.get("return_to"));
      try {
        if (method === "GET" && linkedRoute[2] === "offer") return html(res, 200, linkedOfferPage(config, user, provider, returnTo));
        if (method === "POST" && linkedRoute[2] === "offer") {
          await db.answerLinkedOffer(user.id, provider.id);
          return redirect(res, safeReturn((await readForm(req)).get("return_to")));
        }
        if (method === "GET" && linkedRoute[2] === "start") {
          await db.answerLinkedOffer(user.id, provider.id);
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
        await creator.recover(user.id);
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
        const linkedSignInId = url.searchParams.get("linked");
        const linkedSignIn = linkedSignInId ? config.providers.find((p) => p.id === linkedSignInId) : null;
        const view = await modelsView(
          user,
          flash ??
            (linkedProvider
              ? { kind: "ok", text: `Done. Your ${linkedProvider.models.label} are below.` }
              : linkedSignIn
                ? { kind: "ok", text: `Linked. You can now log in with ${linkedSignIn.label.replace(/^Log in with /i, "")}.` }
                : null),
          200,
          url.searchParams.get("fresh") === "1" || Boolean(linkedProvider),
        );
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
        const key = form.get("creation_key") ?? randomUUID();
        if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(key)) {
          const view = await modelsView(user, { kind: "error", text: "Open My models and submit a fresh creation form." }, 400);
          return html(res, view.status, view.body);
        }
        const result = await creator.create(user.id, key, name, start, config.modelLimit);
        if (result === "quota") {
          const unit = config.modelLimit === 1 ? "model" : "models";
          const view = await modelsView(user, { kind: "error", text: `A free account keeps up to ${config.modelLimit} ${unit}. Free a slot to make another.` }, 409);
          return html(res, view.status, view.body);
        }
        if (result === "conflict") {
          const view = await modelsView(user, { kind: "error", text: "This form already requested a different model. Use a fresh form to make another." }, 409);
          return html(res, view.status, view.body);
        }
        if (result === "busy") {
          res.setHeader("retry-after", "1");
          const view = await modelsView(user, { kind: "error", text: "Your model is being created. Reopen My models to see it." }, 503);
          return html(res, view.status, view.body);
        }
        if (result.state === "abandoned") {
          const view = await modelsView(user, { kind: "error", text: "The starter could not be published. Use a fresh form to create the model." }, 410);
          return html(res, view.status, view.body);
        }
        return redirect(res, `/m/${result.model_id}?view=plan`);
      }
    }
    if (user && method === "POST" && pathname === "/models/creations/cancel") {
      const form = await readForm(req);
      const result = await creator.cancel(user.id, form.get("creation_key") ?? "");
      if (result === "busy") {
        const view = await modelsView(user, { kind: "error", text: "This model is being saved. Reopen My models to check its status." }, 409);
        return html(res, view.status, view.body);
      }
      return redirect(res, "/models");
    }
    const modelAction = pathname.match(/^\/models\/([a-z0-9-]+)\/(rename|delete)$/);
    if (user && method === "POST" && modelAction?.[1]) {
      const model = await ownModel(user, modelAction[1]);
      if (modelAction[2] === "rename") {
        const name = ((await readForm(req)).get("name") ?? "").trim().slice(0, 120);
        if (!name) {
          const view = await modelsView(user, { kind: "error", text: "A model needs a name." }, 400);
          return html(res, view.status, view.body);
        }
        if (!(await db.renameModel(model.id, name, user.id))) throw new Refusal(404, NOT_YOURS);
        return redirect(res, "/models");
      }
      if (!(await db.deleteModel(model.id, user.id))) throw new Refusal(404, NOT_YOURS);
      disconnect(model.id, null);
      await models.remove(model.id);
      console.log("[mutinybim-web] model deleted", { modelId: model.id, userId: user.id });
      return redirect(res, `/models?deleted=${encodeURIComponent(model.name)}`);
    }

    const offerRoute = pathname.match(/^\/models\/([a-z0-9-]+)\/transfer$/);
    if (user && method === "POST" && offerRoute?.[1]) {
      const model = await ownModel(user, offerRoute[1]);
      const form = await readForm(req);
      const retained = form.get("retained") ?? "edit";
      if (retained !== "edit" && retained !== "view" && retained !== "none") throw new Refusal(400, "Choose your access after the transfer.");
      const result = await db.transfers.offer(randomUUID(), model.id, user.id, form.get("recipient") ?? "", retained);
      if (result === "unavailable") throw new Refusal(404, NOT_YOURS);
      if (result === "exists") throw new Refusal(409, "An offer is already open. Cancel it before sending another.");
      if (typeof result === "string") throw new Refusal(409, "Choose someone who has a direct share on this model.");
      return redirect(res, `/models/${model.id}/share`);
    }
    const receiptRoute = pathname.match(/^\/transfers\/([a-f0-9-]{36})\/receipt$/);
    if (user && method === "GET" && receiptRoute?.[1]) {
      const receipt = await db.transfers.forRecipient(receiptRoute[1], user.id);
      if (receipt?.state !== "accepted" || !receipt.accepted_at) throw new Refusal(404, "This transfer receipt is unavailable.");
      return html(res, 200, messagePage(config, user, "Ownership transfer accepted",
        `You accepted “${receipt.model_name}” from ${receipt.sender_name} on ${formatWhen(receipt.accepted_at)}.`,
        { href: "/models", label: "My models" }));
    }
    const answerRoute = pathname.match(/^\/transfers\/([a-f0-9-]{36})\/(accept|decline|cancel)$/);
    if (user && method === "POST" && answerRoute?.[1]) {
      const action = answerRoute[2];
      if (action !== "accept" && action !== "decline" && action !== "cancel") throw new Refusal(404, NOT_YOURS);
      // The database can commit even if its reply is lost. Identify the affected live sessions first.
      const candidate = action === "accept" ? await db.transfers.forRecipient(answerRoute[1], user.id) : null;
      let result;
      try {
        result = await db.transfers.respond(answerRoute[1], user.id, action, config.modelLimit);
      } catch (err) {
        if (candidate?.state === "open") {
          disconnect(candidate.model_id, candidate.sender_id);
          disconnect(candidate.model_id, candidate.recipient_id);
        }
        throw err;
      }
      if (result === "quota") {
        const view = await modelsView(user, { kind: "error", text: "Your account has no free model slot. Free a slot and accept this offer again before it expires." }, 409);
        return html(res, view.status, view.body);
      }
      if (typeof result === "string") throw new Refusal(404, "This transfer offer is unavailable.");
      const expected = action === "accept" ? "accepted" : action === "decline" ? "declined" : "cancelled";
      if (result.state !== expected) {
        const message = action === "accept"
          ? "Check My models for a newer offer. If you still need one, ask the model owner to send a new offer."
          : "Check My models for current offers.";
        return html(res, 409, messagePage(config, user, "Ownership offer ended", message, { href: "/models", label: "My models" }));
      }
      if (action === "accept") {
        if (candidate?.state === "open") {
          disconnect(result.model_id, result.sender_id);
          disconnect(result.model_id, result.recipient_id);
        }
        return redirect(res, `/transfers/${result.id}/receipt`);
      }
      return redirect(res, action === "cancel" ? `/models/${result.model_id}/share` : "/models");
    }
    const shareRoute = pathname.match(/^\/models\/([a-z0-9-]+)\/share$/);
    if (user && shareRoute?.[1]) {
      const model = await ownModel(user, shareRoute[1]);
      const renderShare = async (options: { email?: string; flash?: Flash } = {}) =>
        sharePage(config, user, model, await db.sharesOf(model.id), { ...options, offer: await db.transfers.outgoing(model.id) });
      if (method === "GET") return html(res, 200, await renderShare());
      if (method === "POST") {
        const form = await readForm(req);
        const email = (form.get("email") ?? "").trim().toLowerCase();
        const role: ShareRole = form.get("role") === "view" ? "view" : "edit";
        const fail = async (status: number, text: string) => html(res, status, await renderShare({ email, flash: { kind: "error", text } }));
        const person = email ? await db.userByEmail(email) : null;
        if (!person) return fail(404, `No MutinyBIM account here uses ${email || "that email"}. Ask them to sign up first (this app sends no invitations), then share again.`);
        if (person.id === user.id) return fail(400, "That's you; you already own this model.");
        const before = (await db.sharesOf(model.id)).find((s) => s.user_id === person.id);
        if (!(await db.share({ modelId: model.id, userId: person.id, role, invitedBy: user.id }))) throw new Refusal(404, NOT_YOURS);
        if (before && before.role !== role) disconnect(model.id, person.id);
        console.log("[mutinybim-web] model shared", { modelId: model.id, ownerId: user.id, userId: person.id, role });
        const words = before ? `${person.display_name} can now ${role === "edit" ? "edit" : "only view"} it.` : `Shared with ${person.display_name}. They see it under “Shared with you” on My models.`;
        return html(res, 200, await renderShare({ flash: { kind: "ok", text: words } }));
      }
    }
    const unshareRoute = pathname.match(/^\/models\/([a-z0-9-]+)\/share\/([0-9a-f-]{36})\/delete$/);
    if (user && method === "POST" && unshareRoute?.[1] && unshareRoute[2]) {
      const model = await ownModel(user, unshareRoute[1]);
      const removed = (await db.sharesOf(model.id)).find((s) => s.user_id === unshareRoute[2]);
      if (!(await db.unshare(model.id, unshareRoute[2], user.id))) throw new Refusal(404, NOT_YOURS);
      disconnect(model.id, unshareRoute[2]);
      console.log("[mutinybim-web] model unshared", { modelId: model.id, ownerId: user.id, userId: unshareRoute[2] });
      return html(res, 200, sharePage(config, user, model, await db.sharesOf(model.id), { offer: await db.transfers.outgoing(model.id),
        flash: { kind: "ok", text: removed ? `${removed.display_name} no longer has “${model.name}”.` : "They already didn't have it." } }));
    }

    if (user && pathname === "/settings" && method === "GET") {
      const linked = url.searchParams.get("linked");
      const provider = linked ? config.providers.find((p) => p.id === linked) : undefined;
      const linkedProvider = url.searchParams.get("linked_models") ? linkedHosts.provider(url.searchParams.get("linked_models") ?? "") : null;
      const flash: Flash | null = provider ? { kind: "ok", text: `Linked. You can now log in with ${provider.label.replace(/^Log in with /i, "")}.` } : linkedProvider ? { kind: "ok", text: `On. Your ${linkedProvider.models.label} show on My models.` } : null;
      return html(res, 200, settingsPage(config, user, await db.identitiesOf(user.id), { passwordFree: await recentProviderSignIn(req), flash, linkedModels: await linkedSwitches(user) }));
    }
    const linkedOff = pathname.match(/^\/settings\/linked\/([a-z0-9-]+)\/off$/);
    if (user && method === "POST" && linkedOff?.[1]) {
      const provider = linkedProviderOf(linkedOff[1]);
      await linkedHosts.unlink(user, provider);
      return html(res, 200, settingsPage(config, user, await db.identitiesOf(user.id), { flash: { kind: "ok", text: `Off. ${provider.models.label} no longer show here, and your assistants can't reach them through this app.` }, linkedModels: await linkedSwitches(user) }));
    }
    if (user && pathname === "/settings/profile" && method === "POST") {
      const name = ((await readForm(req)).get("name") ?? "").trim().slice(0, 80);
      if (!name) return html(res, 400, settingsPage(config, user, await db.identitiesOf(user.id), { flash: { kind: "error", text: "Your name can't be empty." } }));
      await db.renameUser(user.id, name);
      const fresh = (await db.userById(user.id)) ?? user;
      return html(res, 200, settingsPage(config, fresh, await db.identitiesOf(user.id), { flash: { kind: "ok", text: "Saved." }, linkedModels: await linkedSwitches(fresh) }));
    }
    if (user && pathname === "/settings/password" && method === "POST") {
      const form = await readForm(req);
      const password = form.get("password") ?? "";
      const passwordFree = await recentProviderSignIn(req);
      const fail = async (status: number, text: string) => html(res, status, settingsPage(config, user, await db.identitiesOf(user.id), { passwordFree, flash: { kind: "error", text }, linkedModels: await linkedSwitches(user) }));
      if (!throttle.allow(`password:${user.id}`)) return fail(429, "Too many tries. Wait ten minutes, then try again.");
      if (password.length < 8) return fail(400, "Use a new password of at least 8 characters.");
      if (config.supabase) {
        const current = form.get("current") ?? "";
        if (!current) return fail(400, "Enter your current password. Signed up with Google? Log out and use Forgot your password to set an email password.");
        try {
          const verified = await signInWithPassword(config.supabase, { email: user.email, password: current }, options.fetchImpl);
          await updatePassword(config.supabase, { accessToken: verified.accessToken, password }, options.fetchImpl);
        } catch (err) {
          if (!(err instanceof SupabaseAuthError)) throw err;
          const words = err.code === "invalid_credentials" ? "Your current password isn't right. Forgot it? Log out, then use “Forgot your password?” on the log-in page." : err.words;
          return fail(err.status, words);
        }
        const token = sessionToken(req);
        await db.deleteSessionsOf(user.id, token ? digest(token) : null);
        console.log("[mutinybim-web] password updated in supabase", { userId: user.id });
        const fresh = (await db.userById(user.id)) ?? user;
        return html(res, 200, settingsPage(config, fresh, await db.identitiesOf(user.id), { flash: { kind: "ok", text: "Password saved. You were signed out on every other device." }, linkedModels: await linkedSwitches(fresh) }));
      }
      if (user.password_hash && !passwordFree && !(await verifyPassword(form.get("current") ?? "", user.password_hash))) return fail(401, "Your current password isn't right. Forgot it? Log out, then use “Forgot your password?” on the log-in page.");
      await db.setPassword(user.id, await hashPassword(password));
      const token = sessionToken(req);
      await db.deleteSessionsOf(user.id, token ? digest(token) : null);
      console.log("[mutinybim-web] password set", { userId: user.id, recovery: passwordFree });
      const fresh = (await db.userById(user.id)) ?? user;
      return html(res, 200, settingsPage(config, fresh, await db.identitiesOf(user.id), { flash: { kind: "ok", text: "Password saved. You were signed out on every other device." }, linkedModels: await linkedSwitches(fresh) }));
    }
    if (user && pathname === "/settings/scheme" && method === "POST") {
      const json = (req.headers["content-type"] ?? "").startsWith("application/json");
      const raw = json ? await readJson(req) : (await readForm(req)).get("scheme");
      if (!isColorScheme(raw)) {
        if (json) return send(res, 400, "application/json", JSON.stringify({ error: "Pick light, dark or system." }));
        throw new Refusal(400, "Pick light, dark or auto.");
      }
      await db.setColorScheme(user.id, raw);
      if (json) return send(res, 204, "text/plain", "");
      return redirect(res, safeReturn(refererPath(req), "/models"));
    }

    if (user && pathname === "/connect" && method === "GET") return html(res, 200, await connectView(user, null));
    const assistantDelete = pathname.match(/^\/connect\/assistants\/([0-9a-f-]{36})\/delete$/);
    if (user && method === "POST" && assistantDelete?.[1]) {
      await db.deleteAssistantGrant(assistantDelete[1], user.id);
      assistantTools.endGrant(assistantDelete[1]);
      console.log("[mutinybim-web] an assistant was signed out", { userId: user.id });
      return html(res, 200, await connectView(user, null, { kind: "ok", text: "Signed out. That assistant can no longer reach your models; it asks you to sign in again next time." }));
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
        const [ownModels, sharedModels] = await Promise.all([db.modelsOf(user.id), db.sharedWith(user.id)]);
        return html(res, 200, assistantConsentPage(config, user, { clientName: checked.request.client.client_name, backTo: web ? back.host : back.protocol.replace(/:$/, ""), request: params.toString(), models: ownModels.length, shared: sharedModels.length }), { "content-security-policy": csp });
      }
      if (form.get("decision") !== "allow") {
        console.log("[mutinybim-web] a person declined an assistant", { userId: user.id, clientId: checked.request.client.client_id });
        return redirect(res, errorRedirect(config.origin, checked.request.redirectUri, checked.request.state, "access_denied", "The person declined."));
      }
      return redirect(res, await approveAuthorize(checked.request, user, assistantAuth));
    }

    if (user && pathname === "/approvals" && method === "GET") return html(res, 200, approvalsPage(config, user, await approvals.of(user.id)));
    const approvalRoute = pathname.match(/^\/approvals\/([0-9a-f-]{36})$/);
    if (user && approvalRoute?.[1]) {
      const id = approvalRoute[1];
      if (method === "GET") {
        const item = await approvals.get(user.id, id);
        return item ? html(res, 200, approvalPage(config, user, item)) : html(res, 404, messagePage(config, user, "Not found", "That approval request isn't yours, or it was dropped after 30 minutes. Nothing changed.", { href: "/approvals", label: "Approvals" }));
      }
      if (method === "POST") {
        // The editor's notice answers in the background and reads the result as JSON; a page form gets the page.
        const wantsJson = (req.headers.accept ?? "").includes("application/json");
        const decision = (await readForm(req)).get("decision");
        if (decision !== "approve" && decision !== "decline") throw new Refusal(400, "Choose Approve or Decline. Nothing changed.");
        const item = await approvals.answer(user.id, id, decision === "approve");
        if (!item && wantsJson) return json(res, 404, { error: "That approval request isn't yours, or it was dropped after 30 minutes. Nothing changed." });
        if (!item) return html(res, 404, messagePage(config, user, "Not found", "That approval request isn't yours, or it was dropped after 30 minutes. Nothing changed.", { href: "/approvals", label: "Approvals" }));
        console.log("[mutinybim-web] a person answered an assistant's change", { userId: user.id, approved: decision === "approve", state: item.state });
        if (wantsJson) return json(res, 200, { id: item.id, state: item.state, outcome: item.outcome, title: approvalTitle(item) });
        return html(res, 200, approvalPage(config, user, item));
      }
    }

    if (user && pathname === "/connect/keys" && method === "POST") {
      const label = ((await readForm(req)).get("label") ?? "").trim().slice(0, 60) || "Assistant";
      if ((await db.agentKeysOf(user.id)).length >= 10) return html(res, 409, await connectView(user, null, { kind: "error", text: "You have 10 agent keys, the most one account keeps. Turn one off first." }));
      const key = randomToken("mbk_");
      await db.createAgentKey({ id: randomUUID(), userId: user.id, keyHash: digest(key), label, last4: key.slice(-4) });
      console.log("[mutinybim-web] agent key made", { userId: user.id });
      return html(res, 200, await connectView(user, key, { kind: "ok", text: `Made “${label}”.` }));
    }
    const keyDelete = pathname.match(/^\/connect\/keys\/([0-9a-f-]{36})\/delete$/);
    if (user && method === "POST" && keyDelete?.[1]) {
      await db.deleteAgentKey(keyDelete[1], user.id);
      return html(res, 200, await connectView(user, null, { kind: "ok", text: "Turned off. Assistants using that key can no longer reach your models." }));
    }

    if (user && pathname === "/quote" && method === "GET") {
      // Off unless the deployment sets MUTINYBIM_WEB_QUOTE: then this page is an ordinary "not here".
      if (!config.quote) return html(res, 404, messagePage(config, user, "Not here", "There's no page at this address.", { href: "/models", label: "Back to my models" }));
      const list = await db.modelsOf(user.id);
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

    // What is waiting for this person's answer (the editor's notice and the header count read it every few seconds).
    if (user && method === "GET" && pathname === "/api/hosted/approvals/waiting") return json(res, 200, { waiting: await approvals.waiting(user.id) });

    const summaryRoute = pathname.match(/^\/api\/hosted\/models\/([a-z0-9-]+)\/summary$/);
    if (user && method === "GET" && summaryRoute?.[1]) {
      const { model } = await reachableModel(user, summaryRoute[1]);
      return json(res, 200, summarize(await models.head(model.id)));
    }
    const buildingModel = pathname.match(/^\/api\/projects\/([^/]+)\/building-model$/);
    if (user && method === "GET" && buildingModel?.[1]) {
      const { model } = await reachableModel(user, decodeURIComponent(buildingModel[1]));
      const branch = url.searchParams.get("branch");
      return json(res, 200, { projectNumber: "", references: [], authority: branch ? { url: syncUrl, modelId: `${model.id}~${branch}`, mainModelId: model.id, branchId: branch } : { url: syncUrl, modelId: model.id } });
    }

    const editorPage = pathname.match(/^\/m\/([a-z0-9-]+)\/?$/);
    if (user && method === "GET" && editorPage?.[1]) {
      const { model, access } = await reachableModel(user, editorPage[1]);
      if (!editor) return html(res, 503, messagePage(config, user, "The editor is off", "This server was started without the editor."));
      const owner = access === "owner" ? null : ((await db.userById(model.owner_id))?.display_name ?? "its owner");
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
    handle(req, res).catch(async (err: unknown) => {
      if (err instanceof Refusal) {
        const user = await sessionUser(req).catch(() => null);
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
    void (async () => {
      const url = new URL(req.url ?? "/", config.origin);
      if (url.pathname !== "/sync") {
        socket.destroy();
        return;
      }
      const key = url.searchParams.get("key");
      const person = key ? await db.userByAgentKey(digest(key)) : await sessionUser(req);
      if (!person) {
        console.warn("[mutinybim-web] a model connection was refused: not signed in", { agentKey: Boolean(key) });
        socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nSign in (or use an agent key from Connect an assistant) to open this model.");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => serveSocket(ws, person, url.searchParams.get("model"), Boolean(key)));
    })().catch((err: unknown) => {
      console.error("[mutinybim-web] model socket upgrade failed", { err });
      socket.destroy();
    });
  });

  /** Open model connections, by base model, so losing access disconnects at once. */
  interface LiveModelConnection { readonly base: string; readonly userId: string; readonly access: ModelAccess; active: boolean; readonly endpoint: ModelEndpoint }
  const live = new Map<string, Set<LiveModelConnection>>();
  function closeChanged(entry: LiveModelConnection): void {
    if (!entry.active) return;
    entry.active = false;
    entry.endpoint.close(4403, "Your access to this model changed. Reopen it from My models.");
  }
  /** Closes connections to a model: everyone's (`userId` null, the model was deleted) or one person's. They reconnect and are checked again. */
  function disconnect(baseModelId: string, userId: string | null): void {
    for (const entry of live.get(baseModelId) ?? []) {
      if (userId === null || entry.userId === userId) closeChanged(entry);
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
    let entry: LiveModelConnection | null = null;
    const conn = { id: randomUUID(), send: (data: string) => { if (entry?.active !== false) endpoint.send(data); } };
    let joined: SyncHub | null = null;
    async function current(binding: LiveModelConnection): Promise<boolean> {
      try {
        const access = await db.accessTo(person.id, binding.base);
        if (binding.active && access?.access === binding.access) return true;
      } catch (err) {
        closeChanged(binding);
        throw err;
      }
      closeChanged(binding);
      return false;
    }
    const deny = (reason: string) => conn.send(JSON.stringify({ type: "denied", reason }));
    return {
      async receive(raw) {
        if (entry?.active === false) return;
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
          const found = await db.accessTo(person.id, base);
          if (!found) {
            console.warn("[mutinybim-web] a model connection asked for a model its person can't reach", { userId: person.id, actorId });
            return deny(NOT_YOURS);
          }
          const hub = await models.hubFor(base, requested);
          if (!hub) return deny("That branch was closed or no longer exists. Switch back to Main.");
          entry = { base, userId: person.id, access: found.access, active: true, endpoint };
          const set = live.get(base) ?? new Set();
          set.add(entry);
          live.set(base, set);
          if (!(await current(entry))) return;
          joined = hub;
          joined.join(conn, { actorId, canWrite: found.access !== "view" });
        } else if (entry) {
          const message = readClientMessage(raw);
          if (message.ok && message.message.type !== "heartbeat" && message.message.type !== "presence" && !(await current(entry))) return;
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
  const assistantTools = createAssistantTools({ auth: assistantAuth, db, dataDir: config.dataDir, approvals, attach, scripts: hostedScripts, linked: linkedHosts, clientIp: ipOf, ...(options.approvalWaitMs !== undefined ? { approvalWaitMs: options.approvalWaitMs } : {}) });

  async function connectView(user: UserRow, newKey: string | null, flash?: Flash): Promise<string> {
    const linkedLabels: string[] = [];
    for (const p of linkedHosts.providers) {
      if ((await db.linkedGrant(user.id, p.id))?.state === "ok") linkedLabels.push(p.models.label);
    }
    const [ownModels, keys, assistants] = await Promise.all([db.modelsOf(user.id), db.agentKeysOf(user.id), db.assistantGrantsOf(user.id)]);
    return connectPage(config, user, { models: ownModels, keys, assistants, newKey, linkedLabels }, flash);
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
      await db.close();
    },
  };
}
