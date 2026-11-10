/**
 * Linked hosts (docs/LINKED-HOSTS.md): a sign-in provider that also keeps
 * models of its own (a firm's project models) lets a person who signed in
 * with it see those models here, under their own, and lets their assistant
 * work on them through this app's tool server.
 *
 * - The pass: after the person allows it at the host, the host issues a
 *   narrow pass (its `models.scope`) that opens its models and nothing else.
 *   This app keeps only AES-256-GCM ciphertext of it, under
 *   MUTINYBIM_WEB_LINK_KEY (or MUTINYBIM_WEB_LINK_KEY_PREVIOUS while a new key
 *   rolls in; anything read under the previous key is written back under the
 *   current one). No key: the feature is off, and says so.
 * - The list: the host decides, on every call, which models the person may
 *   open and whether they may edit; this app shows what it says, under local
 *   ids (`lk-…`) so the open tools' arguments stay as they are.
 * - The tools: a call naming a linked model is sent to the host's tool server
 *   with the host's own ids; the host enforces its permissions again.
 * - Nothing here touches the person's own models or the ones shared with
 *   them: unlinking, or the host being down, never changes those.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { parseBranchModelId } from "@permitzip/bim-kernel";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { LinkedModelsConfig, OAuthProviderConfig, WebConfig } from "./config";
import type { Db, LinkedModelRow, UserRow } from "./db";
import { clientIdFor, discover, SignInError, type Fetch } from "./oauth";
import { pkcePair, randomToken } from "./secrets";

export type LinkedProvider = OAuthProviderConfig & { readonly models: LinkedModelsConfig };

/** Local ids of linked models: they look like this app's own ids, so the tools' schemas are unchanged. */
export const LINKED_ALIAS_PREFIX = "lk-";
const LIST_CACHE_MS = 60_000;
const ACCESS_SKEW_MS = 60_000;
const HOST_TIMEOUT_MS = 8_000;
/** Marks a sign-in state as a linked-models one (oauth_states.return_to). */
export const LINK_STATE_PREFIX = "models:";

export function isLinkedAlias(modelId: string): boolean {
  return (parseBranchModelId(modelId)?.baseModelId ?? modelId).startsWith(LINKED_ALIAS_PREFIX);
}

// ── The key ─────────────────────────────────────────────────────────────────

interface LinkKey {
  readonly id: string;
  readonly key: Buffer;
}

export interface LinkKeys {
  readonly current: LinkKey;
  readonly previous: LinkKey | null;
}

function keyFrom(secret: string): LinkKey {
  const key = createHash("sha256").update(secret, "utf8").digest();
  return { key, id: createHash("sha256").update(key).digest("hex").slice(0, 8) };
}

/** The link key(s) from the environment, or null (the feature is off). A value shorter than 32 characters is refused. */
export function readLinkKeys(env: NodeJS.ProcessEnv = process.env): LinkKeys | null {
  const current = env.MUTINYBIM_WEB_LINK_KEY?.trim();
  if (!current) return null;
  if (current.length < 32) {
    console.error("[mutinybim-web] MUTINYBIM_WEB_LINK_KEY is shorter than 32 characters; linked hosts stay off");
    return null;
  }
  const previous = env.MUTINYBIM_WEB_LINK_KEY_PREVIOUS?.trim();
  return { current: keyFrom(current), previous: previous && previous.length >= 32 ? keyFrom(previous) : null };
}

export function sealWith(keys: LinkKeys, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.current.key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `lk1.${keys.current.id}.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
}

/** The plaintext, and whether it was sealed under the previous key (so it should be sealed again); null when neither key opens it. */
export function openWith(keys: LinkKeys, sealed: string): { readonly plain: string; readonly stale: boolean } | null {
  const [version, keyId, data] = sealed.split(".");
  if (version !== "lk1" || !keyId || !data) return null;
  const key = keyId === keys.current.id ? keys.current : keyId === keys.previous?.id ? keys.previous : null;
  if (!key) return null;
  try {
    const raw = Buffer.from(data, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    return { plain, stale: key !== keys.current };
  } catch (err) {
    console.error("[mutinybim-web linked] a stored pass didn't decrypt", { keyId, err });
    return null;
  }
}

// ── What the pages and the tools see ─────────────────────────────────────────

export type LinkedState = "not_linked" | "reconnect" | "down" | "ok";

export interface LinkedView {
  readonly provider: LinkedProvider;
  readonly state: LinkedState;
  readonly rows: readonly LinkedModelRow[];
}

export interface LinkedHosts {
  /** Providers that are linked hosts here (none when there is no link key). */
  readonly providers: readonly LinkedProvider[];
  /** True when a provider names a linked host but this server has no link key. */
  readonly keyMissing: boolean;
  provider(id: string): LinkedProvider | null;
  /** Where to send the person to allow the pass at the host. */
  start(provider: LinkedProvider, returnTo: string): Promise<string>;
  /** Trades the host's code for the pass and keeps it. */
  finish(provider: LinkedProvider, user: UserRow, code: string, codeVerifier: string): Promise<void>;
  /** The host's list for this person (cached a minute unless `fresh`). */
  view(user: UserRow, provider: LinkedProvider, options?: { readonly fresh?: boolean }): Promise<LinkedView>;
  /** Turns it off: hands the pass back to the host and forgets it and the list. */
  unlink(user: UserRow, provider: LinkedProvider): Promise<void>;
  /** The linked model an alias names for this person, or null. */
  byAlias(userId: string, modelId: string): LinkedModelRow | null;
  /** One line for an assistant's instructions: the linked models, or why there are none. */
  assistantLine(user: UserRow): Promise<string>;
  /** Sends one tool call to the host's tool server, with the host's ids, and brings the answer back in this app's ids. */
  call(user: UserRow, row: LinkedModelRow, tool: string, args: Record<string, unknown>, who: { readonly agentName: string; readonly runId: string }): Promise<CallToolResult>;
}

class HostAnswer extends Error {
  constructor(readonly state: "reconnect" | "down", readonly words: string, detail?: string) {
    super(detail ? `${words} (${detail})` : words);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hostName(provider: OAuthProviderConfig): string {
  return provider.label.replace(/^Log in with /i, "");
}

function linkedCallbackUri(origin: string, provider: OAuthProviderConfig): string {
  return `${origin}/auth/${provider.id}/models/callback`;
}

interface Pass {
  readonly access: string;
  readonly refresh: string;
  readonly accessExpiresAt: number;
  readonly refreshExpiresAt: number;
}

function passFromTokens(body: Record<string, unknown>): Pass | null {
  const access = typeof body.access_token === "string" ? body.access_token : null;
  const refresh = typeof body.refresh_token === "string" ? body.refresh_token : null;
  if (!access || !refresh) return null;
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  return { access, refresh, accessExpiresAt: Date.now() + expiresIn * 1000, refreshExpiresAt: Date.now() + 30 * 86_400_000 };
}

async function readJsonBody(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text();
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch (err) {
    console.error("[mutinybim-web linked] a linked host answered something that isn't JSON", { status: response.status, err });
    return {};
  }
}

/** Replaces the host's ids in a tool answer with this app's (model alias; the host's project id becomes the one workspace). */
function toLocalIds(result: CallToolResult, row: LinkedModelRow): CallToolResult {
  const exactly = (id: string) => new RegExp(`${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9A-Za-z_-])`, "g");
  const model = exactly(row.remote_model_id);
  const project = exactly(row.remote_project_id);
  const swap = (text: string) => text.replace(model, row.alias_id).replace(project, "local");
  return { ...result, content: (result.content ?? []).map((c) => (c.type === "text" ? { ...c, text: swap(c.text) } : c)) };
}

export function createLinkedHosts(options: { readonly config: WebConfig; readonly db: Db; readonly keys: LinkKeys | null; readonly fetchImpl?: Fetch }): LinkedHosts {
  const { config, db, keys } = options;
  const fetchImpl: Fetch = options.fetchImpl ?? fetch;
  const configured = config.providers.filter((p): p is LinkedProvider => Boolean(p.models));
  const providers = keys ? configured : [];
  if (configured.length > 0 && !keys) console.error("[mutinybim-web] a sign-in provider is a linked host, but MUTINYBIM_WEB_LINK_KEY is not set: linked models are off");
  else if (providers.length > 0) console.log("[mutinybim-web] linked hosts on", { providers: providers.map((p) => p.id) });
  const cache = new Map<string, { readonly at: number; readonly view: LinkedView }>();
  const refreshing = new Map<string, Promise<string>>();

  const cacheKey = (userId: string, provider: string) => `${userId}\u0000${provider}`;

  async function tokenEndpoint(provider: LinkedProvider): Promise<string> {
    return provider.models.token ?? (await discover(provider, fetchImpl)).token_endpoint;
  }

  /** The provider as a client registration for the pass: its own callback, its own scope. */
  const passClient = (provider: LinkedProvider): OAuthProviderConfig => ({ ...provider, scope: provider.models.scope });

  function keep(user: UserRow, provider: LinkedProvider, clientId: string, pass: Pass): void {
    if (!keys) throw new Error("linked hosts are off on this server");
    db.saveLinkedGrant({
      userId: user.id,
      provider: provider.id,
      clientId,
      accessCipher: sealWith(keys, pass.access),
      refreshCipher: sealWith(keys, pass.refresh),
      accessExpiresAt: new Date(pass.accessExpiresAt),
      refreshExpiresAt: new Date(pass.refreshExpiresAt),
    });
  }

  function reconnect(user: UserRow, provider: LinkedProvider, why: string): HostAnswer {
    db.markLinkedReconnect(user.id, provider.id, why);
    cache.delete(cacheKey(user.id, provider.id));
    console.warn("[mutinybim-web linked] a linked host refused the pass; the person must reconnect", { provider: provider.id, userId: user.id, why });
    return new HostAnswer("reconnect", `${hostName(provider)} needs you to reconnect.`, why);
  }

  /** A pass good for another minute: the stored one, or a refreshed one (one refresh at a time per person and host). */
  async function accessFor(user: UserRow, provider: LinkedProvider, force = false): Promise<string> {
    if (!keys) throw new HostAnswer("down", "Linked projects are off on this server.");
    const grant = db.linkedGrant(user.id, provider.id);
    if (!grant) throw new HostAnswer("reconnect", `Connect ${hostName(provider)} to see these projects.`);
    if (grant.state === "reconnect") throw new HostAnswer("reconnect", `${hostName(provider)} needs you to reconnect.`);
    const access = openWith(keys, grant.access_cipher);
    const refresh = openWith(keys, grant.refresh_cipher);
    if (!access || !refresh) throw reconnect(user, provider, "the stored pass couldn't be opened with this server's key");
    if (!force && Date.parse(grant.access_expires_at) - Date.now() > ACCESS_SKEW_MS) {
      if (access.stale || refresh.stale) keep(user, provider, grant.client_id, { access: access.plain, refresh: refresh.plain, accessExpiresAt: Date.parse(grant.access_expires_at), refreshExpiresAt: Date.parse(grant.refresh_expires_at) });
      return access.plain;
    }
    const key = cacheKey(user.id, provider.id);
    const running = refreshing.get(key);
    if (running) return running;
    const work = (async () => {
      let response: Response;
      try {
        response = await fetchImpl(await tokenEndpoint(provider), {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh.plain, client_id: grant.client_id }).toString(),
          signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
        });
      } catch (err) {
        console.error("[mutinybim-web linked] refreshing a pass failed: host unreachable", { provider: provider.id, err });
        throw new HostAnswer("down", `${hostName(provider)} can't be reached right now.`);
      }
      const body = await readJsonBody(response);
      if (response.status === 400 || response.status === 401) throw reconnect(user, provider, typeof body.error_description === "string" ? body.error_description : `refresh ${response.status}`);
      const pass = response.ok ? passFromTokens(body) : null;
      if (!pass) {
        console.error("[mutinybim-web linked] refreshing a pass failed", { provider: provider.id, status: response.status });
        throw new HostAnswer("down", `${hostName(provider)} isn't answering right now.`);
      }
      keep(user, provider, grant.client_id, pass);
      return pass.access;
    })();
    refreshing.set(key, work);
    try {
      return await work;
    } finally {
      refreshing.delete(key);
    }
  }

  function openUrlFor(provider: LinkedProvider, value: unknown): string | null {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      return url.origin === new URL(provider.models.list).origin ? url.toString() : null;
    } catch (err) {
      console.error("[mutinybim-web linked] a linked model's open address isn't usable", { provider: provider.id, err });
      return null;
    }
  }

  async function fetchList(user: UserRow, provider: LinkedProvider, access: string): Promise<readonly LinkedModelRow[] | "unauthorized"> {
    let response: Response;
    try {
      response = await fetchImpl(provider.models.list, { headers: { authorization: `Bearer ${access}`, accept: "application/json" }, signal: AbortSignal.timeout(HOST_TIMEOUT_MS) });
    } catch (err) {
      console.error("[mutinybim-web linked] the host's model list is unreachable", { provider: provider.id, err });
      throw new HostAnswer("down", `${hostName(provider)} can't be reached right now.`);
    }
    if (response.status === 401) return "unauthorized";
    if (!response.ok) {
      console.error("[mutinybim-web linked] the host's model list failed", { provider: provider.id, status: response.status });
      throw new HostAnswer("down", `${hostName(provider)} isn't answering right now.`);
    }
    const body = await readJsonBody(response);
    const subject = typeof body.subject === "string" ? body.subject : null;
    const linkedAs = db.identitySubject(user.id, provider.id);
    if (subject && linkedAs && subject !== linkedAs) {
      await unlinkQuietly(user, provider);
      throw new HostAnswer("reconnect", `That ${hostName(provider)} sign-in isn't the one linked to this account. Connect again with the same ${hostName(provider)} account.`);
    }
    const models = Array.isArray(body.models) ? body.models : [];
    const rows = models.flatMap((m) => {
      if (!isRecord(m) || typeof m.id !== "string" || typeof m.project_id !== "string" || typeof m.label !== "string") return [];
      return [{ remoteModelId: m.id, remoteProjectId: m.project_id, label: m.label.slice(0, 160), canEdit: m.can_edit === true, openUrl: openUrlFor(provider, m.open_url) }];
    });
    return db.replaceLinkedModels(user.id, provider.id, rows, () => `${LINKED_ALIAS_PREFIX}${randomBytes(10).toString("hex")}`);
  }

  async function unlinkQuietly(user: UserRow, provider: LinkedProvider): Promise<void> {
    const grant = db.linkedGrant(user.id, provider.id);
    if (grant && keys && provider.models.revoke) {
      for (const sealed of [grant.refresh_cipher, grant.access_cipher]) {
        const token = sealed ? openWith(keys, sealed) : null;
        if (!token) continue;
        try {
          const response = await fetchImpl(provider.models.revoke, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: token.plain, client_id: grant.client_id }).toString(), signal: AbortSignal.timeout(HOST_TIMEOUT_MS) });
          if (!response.ok) console.error("[mutinybim-web linked] the host didn't accept the pass back; forgetting it here anyway", { provider: provider.id, status: response.status });
        } catch (err) {
          console.error("[mutinybim-web linked] handing the pass back failed; forgetting it here anyway", { provider: provider.id, err });
        }
      }
    }
    db.deleteLinkedGrant(user.id, provider.id);
    cache.delete(cacheKey(user.id, provider.id));
  }

  async function view(user: UserRow, provider: LinkedProvider, viewOptions: { readonly fresh?: boolean } = {}): Promise<LinkedView> {
    const key = cacheKey(user.id, provider.id);
    const cached = cache.get(key);
    if (!viewOptions.fresh && cached && Date.now() - cached.at < LIST_CACHE_MS) return cached.view;
    const grant = db.linkedGrant(user.id, provider.id);
    if (!grant) return { provider, state: "not_linked", rows: [] };
    if (grant.state === "reconnect") return { provider, state: "reconnect", rows: [] };
    try {
      let rows = await fetchList(user, provider, await accessFor(user, provider));
      if (rows === "unauthorized") rows = await fetchList(user, provider, await accessFor(user, provider, true));
      if (rows === "unauthorized") throw reconnect(user, provider, "the host refused the pass");
      const answer: LinkedView = { provider, state: "ok", rows };
      cache.set(key, { at: Date.now(), view: answer });
      return answer;
    } catch (err) {
      if (!(err instanceof HostAnswer)) throw err;
      return { provider, state: err.state, rows: [] };
    }
  }

  return {
    providers,
    keyMissing: configured.length > 0 && !keys,
    provider: (id) => providers.find((p) => p.id === id) ?? null,

    async start(provider, returnTo) {
      const redirectUri = linkedCallbackUri(config.origin, provider);
      const metadata = await discover(provider, fetchImpl);
      const clientId = await clientIdFor(passClient(provider), metadata, redirectUri, db, fetchImpl);
      const { verifier, challenge } = pkcePair();
      const state = randomToken();
      db.saveOAuthState({ state, provider: provider.id, codeVerifier: verifier, returnTo: `${LINK_STATE_PREFIX}${returnTo}` });
      const target = new URL(metadata.authorization_endpoint);
      target.searchParams.set("response_type", "code");
      target.searchParams.set("client_id", clientId);
      target.searchParams.set("redirect_uri", redirectUri);
      target.searchParams.set("scope", provider.models.scope);
      target.searchParams.set("state", state);
      target.searchParams.set("code_challenge", challenge);
      target.searchParams.set("code_challenge_method", "S256");
      return target.toString();
    },

    async finish(provider, user, code, codeVerifier) {
      const redirectUri = linkedCallbackUri(config.origin, provider);
      const metadata = await discover(provider, fetchImpl);
      const clientId = await clientIdFor(passClient(provider), metadata, redirectUri, db, fetchImpl);
      let response: Response;
      try {
        response = await fetchImpl(await tokenEndpoint(provider), {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: codeVerifier }).toString(),
          signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
        });
      } catch (err) {
        console.error("[mutinybim-web linked] the host's token address is unreachable", { provider: provider.id, err });
        throw new SignInError(`${hostName(provider)} can't be reached right now. Try again in a minute.`);
      }
      const body = await readJsonBody(response);
      const pass = response.ok ? passFromTokens(body) : null;
      if (!pass) {
        console.error("[mutinybim-web linked] the host didn't issue a pass", { provider: provider.id, status: response.status, error: body.error });
        throw new SignInError(`${hostName(provider)} didn't allow it${typeof body.error_description === "string" ? `: ${body.error_description}` : ""}. Try again.`);
      }
      keep(user, provider, clientId, pass);
      cache.delete(cacheKey(user.id, provider.id));
      console.log("[mutinybim-web linked] a person linked their models", { provider: provider.id, userId: user.id });
    },

    view,

    async unlink(user, provider) {
      await unlinkQuietly(user, provider);
      console.log("[mutinybim-web linked] a person turned linked models off", { provider: provider.id, userId: user.id });
    },

    byAlias(userId, modelId) {
      const base = parseBranchModelId(modelId)?.baseModelId ?? modelId;
      return base.startsWith(LINKED_ALIAS_PREFIX) ? db.linkedModelByAlias(userId, base) : null;
    },

    async assistantLine(user) {
      const parts: string[] = [];
      for (const provider of providers) {
        if (!db.linkedGrant(user.id, provider.id)) continue;
        const seen = await view(user, provider);
        if (seen.state !== "ok") {
          parts.push(`${provider.models.label}: ${seen.state === "reconnect" ? `${user.display_name} needs to reconnect ${hostName(provider)} on ${config.origin}/models first` : `${hostName(provider)} can't be reached right now`}.`);
          continue;
        }
        if (seen.rows.length === 0) continue;
        const listed = seen.rows.slice(0, 40).map((r) => `${r.label} (model_id ${r.alias_id}, ${r.can_edit ? "you can edit" : "view only"})`);
        parts.push(`${provider.models.label} (through ${user.display_name}'s linked ${hostName(provider)} sign-in; ${hostName(provider)} decides what they may do, and runs scripts on these on its own machines): ${listed.join("; ")}.`);
      }
      return parts.join(" ");
    },

    async call(user, row, tool, args, who) {
      const provider = providers.find((p) => p.id === row.provider);
      if (!provider) throw new HostAnswer("down", "That linked host isn't set up on this server any more.");
      const parsed = typeof args.model_id === "string" ? parseBranchModelId(args.model_id) : null;
      const remoteModel = parsed ? `${row.remote_model_id}~${parsed.branchId}` : row.remote_model_id;
      const sent = { ...args, model_id: remoteModel, project_id: row.remote_project_id };
      const once = async (access: string): Promise<CallToolResult> => {
        const transport = new StreamableHTTPClientTransport(new URL(provider.models.mcp), {
          fetch: (input, init) => fetchImpl(input.toString(), init),
          requestInit: { headers: { authorization: `Bearer ${access}`, "x-linked-agent-name": who.agentName.slice(0, 60), "x-linked-run-id": who.runId.slice(0, 60) } },
        });
        const client = new Client({ name: "mutinybim-web", version: "0.1.0" });
        try {
          await client.connect(transport);
          const result = await client.callTool({ name: tool, arguments: sent }, undefined, { timeout: 280_000 });
          return toLocalIds(result as CallToolResult, row);
        } finally {
          await client.close().catch((err: unknown) => console.error("[mutinybim-web linked] closing a host connection failed", { err }));
        }
      };
      const unauthorized = (err: unknown) => err instanceof Error && /401|unauthori[sz]ed|invalid_token/i.test(err.message);
      try {
        return await once(await accessFor(user, provider));
      } catch (err) {
        if (err instanceof HostAnswer) throw err;
        if (!unauthorized(err)) {
          console.error("[mutinybim-web linked] a forwarded tool call failed", { provider: provider.id, tool, err });
          throw new HostAnswer("down", `${hostName(provider)} didn't answer that call (${err instanceof Error ? err.message.slice(0, 160) : String(err)}).`);
        }
        try {
          return await once(await accessFor(user, provider, true));
        } catch (again) {
          if (again instanceof HostAnswer) throw again;
          if (unauthorized(again)) throw reconnect(user, provider, "the host refused the pass on a tool call");
          throw new HostAnswer("down", `${hostName(provider)} didn't answer that call.`);
        }
      }
    },
  };
}

/** A tool answer for a linked call that didn't reach the host, in the words a person can act on. */
export function linkedRefusal(err: unknown, modelId: string): CallToolResult {
  const words = err instanceof HostAnswer ? err.words : "That call to the linked host failed. Try again in a minute.";
  if (!(err instanceof HostAnswer)) console.error("[mutinybim-web linked] a linked call failed unexpectedly", { err });
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ status: "refused", code: err instanceof HostAnswer && err.state === "reconnect" ? "reconnect" : "host_unavailable", message: words, element_ids: [], model_id: modelId }) }] };
}
