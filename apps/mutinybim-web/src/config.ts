/**
 * Everything a deployment chooses, read once from the environment. The app
 * runs with none of it set (a local server on 127.0.0.1:3100 with email
 * sign-in only); a hosted deployment adds its public address, its data folder
 * and, if it wants them, sign-in providers and a quote link.
 *
 *   MUTINYBIM_WEB_PORT            port (default 3100)
 *   MUTINYBIM_WEB_HOST            listen address (default 127.0.0.1; 0.0.0.0 in a container)
 *   MUTINYBIM_WEB_ORIGIN          public address, e.g. https://app.mutinybim.com (default http://127.0.0.1:<port>)
 *   MUTINYBIM_WEB_DATA            folder for the account database and model files (default ./mutinybim-web-data)
 *   MUTINYBIM_WEB_MODEL_LIMIT     models one account may own (default 25)
 *   MUTINYBIM_WEB_SIGNUP          "open" (default) or "closed" (existing accounts and providers only)
 *   MUTINYBIM_WEB_PROVIDERS       JSON array of sign-in providers (see OAuthProviderConfig)
 *   MUTINYBIM_WEB_QUOTE           JSON object: a link that asks a services firm for a quote (see QuoteConfig).
 *                                 Off when unset: no button, page or wording about quotes anywhere.
 *   MUTINYBIM_WEB_SCRIPTS         where outside assistants' scripts run: "sealed" (default; the sealed box,
 *                                 Linux with bubblewrap), "off", or "local" (a fresh process on this
 *                                 computer, allowed only when the public address is a loopback address)
 *   MUTINYBIM_WEB_SCRIPT_RUNNER   folder holding the runner's two built files (default /usr/local/lib/mutinybim/script-runner)
 *   MUTINYBIM_WEB_SCRIPT_RUNS     scripts running at once on this machine (default 2; each may use about 1.2 GB)
 *
 * Provider and quote settings are addresses and labels only. No secret is
 * read here: providers are public clients (authorization code with PKCE,
 * registering themselves dynamically when no client id is given). A provider
 * may also be a linked host (its `models`, docs/LINKED-HOSTS.md); the key the
 * app keeps those passes under is read by linked-hosts.ts, not here.
 */
import path from "node:path";

export interface OAuthProviderConfig {
  /** Short id used in addresses (`/auth/<id>/start`) and stored with each linked account. */
  readonly id: string;
  /** Button text, e.g. "Log in with Example". */
  readonly label: string;
  /** The authorization server's address; its `/.well-known/oauth-authorization-server` (or `openid-configuration`) is read. */
  readonly issuer: string;
  /** A pre-registered public client id. Absent: the app registers itself (RFC 7591) and remembers the id. */
  readonly clientId?: string;
  /** Scopes to ask for (default "openid email profile"). */
  readonly scope?: string;
  /** The name shown on the provider's consent screen when the app registers itself. */
  readonly clientName?: string;
  /** The provider is also a linked host: it lists models people can open there and serves the open tools for them. */
  readonly models?: LinkedModelsConfig;
}

/** A linked host (docs/LINKED-HOSTS.md): addresses and a scope, nothing secret. */
export interface LinkedModelsConfig {
  /** The heading people see over these models, e.g. "Example projects". */
  readonly label: string;
  /** The narrow scope that opens models there (asked for on its own, after sign-in). */
  readonly scope: string;
  /** GET with the pass: the models this person may open there. */
  readonly list: string;
  /** The host's MCP tool server for those models (the open core). */
  readonly mcp: string;
  /** Where the pass is issued and refreshed (default: the issuer's token endpoint). */
  readonly token?: string;
  /** Where the pass is handed back when the person turns this off (RFC 7009). */
  readonly revoke?: string;
}

export interface QuoteConfig {
  /** Button text, e.g. "Get an engineering quote". */
  readonly label: string;
  /** Who the quote comes from, in the page's words ("Example Engineering"). */
  readonly provider: string;
  /** The quote form. The app adds `source`, `model` and `email` query values the form may read. */
  readonly url: string;
  /** One or two sentences on the quote page about what the firm does. */
  readonly blurb?: string;
}

export interface WebConfig {
  readonly port: number;
  readonly host: string;
  readonly origin: string;
  readonly dataDir: string;
  readonly modelLimit: number;
  readonly signupOpen: boolean;
  readonly providers: readonly OAuthProviderConfig[];
  readonly quote: QuoteConfig | null;
  /** True when the public address is https (cookies are then marked Secure). */
  readonly secure: boolean;
  /** Where outside assistants' scripts run (absent: the sealed box with its defaults). */
  readonly scripts?: ScriptsConfig;
}

export interface ScriptsConfig {
  readonly mode: "sealed" | "off" | "local";
  readonly runnerDir?: string;
  readonly maxRunning?: number;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function parseScripts(env: NodeJS.ProcessEnv, origin: string): ScriptsConfig {
  const mode = env.MUTINYBIM_WEB_SCRIPTS ?? "sealed";
  if (mode !== "sealed" && mode !== "off" && mode !== "local") throw new Error(`[mutinybim-web] MUTINYBIM_WEB_SCRIPTS="${mode}" must be sealed, off or local`);
  if (mode === "local" && !LOOPBACK.has(new URL(origin).hostname)) throw new Error("[mutinybim-web] MUTINYBIM_WEB_SCRIPTS=local runs scripts unsealed; it is allowed only when MUTINYBIM_WEB_ORIGIN is a loopback address");
  const runs = Number(env.MUTINYBIM_WEB_SCRIPT_RUNS ?? 2);
  return { mode, ...(env.MUTINYBIM_WEB_SCRIPT_RUNNER ? { runnerDir: env.MUTINYBIM_WEB_SCRIPT_RUNNER } : {}), maxRunning: Number.isInteger(runs) && runs > 0 ? runs : 2 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(name: string, raw: string | undefined): unknown {
  if (!raw || raw.trim() === "") return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`[mutinybim-web] ${name} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function linkedAddress(id: string, what: string, value: unknown): string {
  const raw = text(value);
  if (!raw) throw new Error(`[mutinybim-web] provider ${id}: models.${what} is required`);
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost" && !parsed.hostname.endsWith(".localhost")) {
    throw new Error(`[mutinybim-web] provider ${id}: models.${what} must be https (or this computer)`);
  }
  return parsed.toString();
}

function parseLinkedModels(id: string, value: unknown): LinkedModelsConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`[mutinybim-web] provider ${id}: models must be an object`);
  const label = text(value.label);
  const scope = text(value.scope);
  if (!label || !scope) throw new Error(`[mutinybim-web] provider ${id}: models needs a label and a scope`);
  return {
    label,
    scope,
    list: linkedAddress(id, "list", value.list),
    mcp: linkedAddress(id, "mcp", value.mcp),
    ...(value.token !== undefined ? { token: linkedAddress(id, "token", value.token) } : {}),
    ...(value.revoke !== undefined ? { revoke: linkedAddress(id, "revoke", value.revoke) } : {}),
  };
}

export function parseProviders(raw: string | undefined): readonly OAuthProviderConfig[] {
  const parsed = parseJson("MUTINYBIM_WEB_PROVIDERS", raw);
  if (parsed === null) return [];
  if (!Array.isArray(parsed)) throw new Error("[mutinybim-web] MUTINYBIM_WEB_PROVIDERS must be a JSON array");
  return parsed.map((entry, i) => {
    if (!isRecord(entry)) throw new Error(`[mutinybim-web] provider ${i} is not an object`);
    const id = text(entry.id);
    const label = text(entry.label);
    const issuer = text(entry.issuer);
    if (!id || !/^[a-z0-9-]{1,40}$/.test(id)) throw new Error(`[mutinybim-web] provider ${i} needs an id of lowercase letters, digits or dashes`);
    if (!label || !issuer) throw new Error(`[mutinybim-web] provider ${id} needs a label and an issuer`);
    const issuerUrl = new URL(issuer);
    if (issuerUrl.protocol !== "https:" && issuerUrl.hostname !== "127.0.0.1" && issuerUrl.hostname !== "localhost" && !issuerUrl.hostname.endsWith(".localhost")) {
      throw new Error(`[mutinybim-web] provider ${id}: the issuer must be https (or this computer)`);
    }
    const clientId = text(entry.clientId);
    const scope = text(entry.scope);
    const clientName = text(entry.clientName);
    const models = parseLinkedModels(id, entry.models);
    return { id, label, issuer: issuerUrl.toString().replace(/\/$/, ""), ...(clientId ? { clientId } : {}), ...(scope ? { scope } : {}), ...(clientName ? { clientName } : {}), ...(models ? { models } : {}) };
  });
}

export function parseQuote(raw: string | undefined): QuoteConfig | null {
  const parsed = parseJson("MUTINYBIM_WEB_QUOTE", raw);
  if (parsed === null) return null;
  if (!isRecord(parsed)) throw new Error("[mutinybim-web] MUTINYBIM_WEB_QUOTE must be a JSON object");
  const label = text(parsed.label);
  const provider = text(parsed.provider);
  const url = text(parsed.url);
  if (!label || !provider || !url) throw new Error("[mutinybim-web] MUTINYBIM_WEB_QUOTE needs label, provider and url");
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") throw new Error("[mutinybim-web] the quote url must be a web address");
  const blurb = text(parsed.blurb);
  return { label, provider, url: parsedUrl.toString(), ...(blurb ? { blurb } : {}) };
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const port = Number(env.MUTINYBIM_WEB_PORT ?? 3100);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`[mutinybim-web] MUTINYBIM_WEB_PORT="${env.MUTINYBIM_WEB_PORT}" is not a port`);
  const host = env.MUTINYBIM_WEB_HOST ?? "127.0.0.1";
  const origin = (env.MUTINYBIM_WEB_ORIGIN ?? `http://127.0.0.1:${port}`).replace(/\/$/, "");
  const modelLimit = Number(env.MUTINYBIM_WEB_MODEL_LIMIT ?? 25);
  return {
    port,
    host,
    origin,
    dataDir: path.resolve(env.MUTINYBIM_WEB_DATA ?? "mutinybim-web-data"),
    modelLimit: Number.isInteger(modelLimit) && modelLimit > 0 ? modelLimit : 25,
    signupOpen: (env.MUTINYBIM_WEB_SIGNUP ?? "open") !== "closed",
    providers: parseProviders(env.MUTINYBIM_WEB_PROVIDERS),
    quote: parseQuote(env.MUTINYBIM_WEB_QUOTE),
    secure: origin.startsWith("https://"),
    scripts: parseScripts(env, origin),
  };
}
