/**
 * Supabase / Postgres metadata store implementing `WebStore` over PostgREST
 * and the atomic RPCs defined in `db/migrations/`.
 *
 * Uses built-in fetch with zero extra dependencies, keeping the open-source
 * app self-contained while letting hosted deployments store accounts, sessions,
 * shares and assistant state in managed Postgres instead of a single SQLite file.
 */
import {
  shareRole,
  toAgentKey,
  toApproval,
  toAssistantClient,
  toAssistantSession,
  toGrant,
  toLinkedGrant,
  toLinkedModel,
  toModel,
  toModelAccess,
  toModelCreation,
  toSharedModel,
  toUser,
  type AssistantCodeRow,
  type OAuthClientRow,
  type OAuthStateRow,
  type ShareRow,
  type WebStore,
} from "./db";
import type { Fetch } from "./oauth";
import { transferResult, transferRow } from "./model-transfers";

const REST_TIMEOUT_MS = 10_000;

function now(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`[mutinybim-web supabase-db] column ${key} is not text`);
  return value;
}

/** Escapes PostgREST filter values (`eq.`, `gt.`, etc.). */
function eq(value: string): string {
  return `eq.${value}`;
}

export interface SupabaseStoreOptions {
  readonly url: string;
  /** Server-side Supabase secret / service_role key (never exposed to browsers). */
  readonly secretKey: string;
  readonly fetchImpl?: Fetch;
}

export function openSupabaseStore(options: SupabaseStoreOptions): WebStore {
  const baseUrl = options.url.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request(
    pathAndQuery: string,
    init: {
      readonly method?: "GET" | "POST" | "PATCH" | "DELETE" | "HEAD";
      readonly body?: unknown;
      readonly prefer?: string;
    } = {},
  ): Promise<{ readonly data: unknown; readonly contentRange: string | null }> {
    const headers: Record<string, string> = {
      apikey: options.secretKey,
      authorization: `Bearer ${options.secretKey}`,
      accept: "application/json",
    };
    if (init.prefer) headers.prefer = init.prefer;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const response = await fetchImpl(`${baseUrl}${pathAndQuery}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(REST_TIMEOUT_MS),
    });
    const text = init.method === "HEAD" ? "" : await response.text();
    if (!response.ok) {
      throw new Error(`[mutinybim-web supabase-db] ${init.method ?? "GET"} ${pathAndQuery.split("?")[0]} failed (${response.status}): ${text.slice(0, 300)}`);
    }
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { data, contentRange: response.headers.get("content-range") };
  }

  async function selectRows(table: string, params: Record<string, string>): Promise<unknown[]> {
    const query = new URLSearchParams(params).toString();
    const { data } = await request(`/rest/v1/${table}${query ? `?${query}` : ""}`);
    return Array.isArray(data) ? data : [];
  }

  async function selectOne(table: string, params: Record<string, string>): Promise<unknown> {
    const rows = await selectRows(table, { ...params, limit: "1" });
    return rows[0] ?? null;
  }

  async function countRows(table: string, params: Record<string, string>): Promise<number> {
    const query = new URLSearchParams({ select: "id", ...params }).toString();
    const { contentRange } = await request(`/rest/v1/${table}?${query}`, { method: "HEAD", prefer: "count=exact" });
    if (!contentRange) return 0;
    const total = contentRange.split("/")[1];
    const parsed = total ? Number(total) : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  }

  async function rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
    const { data } = await request(`/rest/v1/rpc/${fn}`, { method: "POST", body: args });
    return data;
  }

  const userById = async (id: string) => toUser(await selectOne("users", { select: "*", id: eq(id) }));

  return {
    transfers: {
      async forRecipient(id, person) {
        const row = await selectOne("model_transfers", { select: "*", id: eq(id), recipient_id: eq(person) });
        return row ? transferRow(row) : null;
      },
      async outgoing(modelId) {
        const row = await selectOne("model_transfers", { select: "*", model_id: eq(modelId), state: eq("open"), expires_at: "gt.now" });
        return row ? transferRow(row) : null;
      },
      async inbox(recipientId) {
        return (await selectRows("model_transfers", { select: "*", recipient_id: eq(recipientId), state: eq("open"),
          expires_at: "gt.now", order: "expires_at,id" })).map(transferRow);
      },
      async offer(id, modelId, sender, recipient, retained) {
        return transferResult(await rpc("web_offer_model_transfer", { p_id: id, p_model: modelId, p_sender: sender, p_recipient: recipient, p_retained: retained }));
      },
      async respond(id, actor, action, limit) {
        return transferResult(await rpc("web_respond_model_transfer", { p_id: id, p_actor: actor, p_action: action, p_limit: limit }));
      },
    },
    async close() {
      // Stateless HTTPS client; nothing to tear down.
    },

    async createUser(input) {
      const { data } = await request("/rest/v1/users", {
        method: "POST",
        prefer: "return=representation",
        body: { id: input.id, email: input.email.toLowerCase(), display_name: input.displayName, password_hash: input.passwordHash, created_at: now() },
      });
      const user = toUser(Array.isArray(data) ? data[0] : data);
      if (!user) throw new Error("[mutinybim-web supabase-db] the new account was not saved");
      return user;
    },
    async createSupabaseUser({ id, email, displayName }) {
      return (await rpc("web_create_supabase_user", { p_id: id, p_email: email, p_display_name: displayName })) === true;
    },
    async userByEmail(email) {
      const rows = await rpc("web_user_by_email", { p_email: email.trim() });
      return toUser(Array.isArray(rows) ? rows[0] : null);
    },
    userById,
    async renameUser(id, displayName) {
      await request(`/rest/v1/users?${new URLSearchParams({ id: eq(id) })}`, { method: "PATCH", body: { display_name: displayName } });
    },
    async setColorScheme(id, scheme) {
      await request(`/rest/v1/users?${new URLSearchParams({ id: eq(id) })}`, { method: "PATCH", body: { color_scheme: scheme } });
    },

    async userByIdentity(provider, subject) {
      const row = await selectOne("identities", { select: "user_id", provider: eq(provider), subject: eq(subject) });
      if (!isRecord(row) || typeof row.user_id !== "string") return null;
      return userById(row.user_id);
    },
    async linkIdentity(provider, subject, userId) {
      await request("/rest/v1/identities?on_conflict=provider,subject", {
        method: "POST",
        prefer: "resolution=ignore-duplicates",
        body: { provider, subject, user_id: userId, created_at: now() },
      });
    },
    async confirmIdentityEmail(provider, subject, userId, email) {
      await rpc("web_confirm_oidc_email", { p_provider: provider, p_subject: subject, p_user_id: userId, p_email: email });
    },
    async identitySubject(userId, provider) {
      const row = await selectOne("identities", { select: "subject", user_id: eq(userId), provider: eq(provider) });
      return isRecord(row) && typeof row.subject === "string" ? row.subject : null;
    },
    async identitiesOf(userId) {
      const rows = await selectRows("identities", { select: "provider", user_id: eq(userId), order: "provider.asc" });
      return rows.flatMap((r) => (isRecord(r) && typeof r.provider === "string" ? [r.provider] : []));
    },

    async createSession(tokenHash, userId, expiresAt, via) {
      await request("/rest/v1/sessions", {
        method: "POST",
        body: { token_hash: tokenHash, user_id: userId, created_at: now(), expires_at: expiresAt.toISOString(), via },
      });
    },
    async userBySession(tokenHash) {
      const row = await selectOne("sessions", { select: "user_id", token_hash: eq(tokenHash), expires_at: `gt.${now()}` });
      if (!isRecord(row) || typeof row.user_id !== "string") return null;
      return userById(row.user_id);
    },
    async session(tokenHash) {
      const row = await selectOne("sessions", { select: "via,created_at,user_id", token_hash: eq(tokenHash), expires_at: `gt.${now()}` });
      if (!isRecord(row)) return null;
      const user = await userById(str(row, "user_id"));
      return user ? { user, via: str(row, "via"), created_at: str(row, "created_at") } : null;
    },
    async deleteSession(tokenHash) {
      await request(`/rest/v1/sessions?${new URLSearchParams({ token_hash: eq(tokenHash) })}`, { method: "DELETE" });
    },
    async deleteSessionsOf(userId, keepTokenHash = null) {
      const params: Record<string, string> = { user_id: eq(userId) };
      if (keepTokenHash) params.token_hash = `neq.${keepTokenHash}`;
      await request(`/rest/v1/sessions?${new URLSearchParams(params)}`, { method: "DELETE" });
    },
    async setPassword(userId, passwordHash) {
      await request(`/rest/v1/users?${new URLSearchParams({ id: eq(userId) })}`, { method: "PATCH", body: { password_hash: passwordHash } });
    },

    async createPasswordReset(tokenHash, userId, expiresAt) {
      await request(`/rest/v1/password_resets?${new URLSearchParams({ or: `(user_id.eq.${userId},expires_at.lt.${now()})` })}`, { method: "DELETE" });
      await request("/rest/v1/password_resets", {
        method: "POST",
        body: { token_hash: tokenHash, user_id: userId, created_at: now(), expires_at: expiresAt.toISOString() },
      });
    },
    async userByPasswordReset(tokenHash) {
      const row = await selectOne("password_resets", { select: "user_id", token_hash: eq(tokenHash), expires_at: `gt.${now()}` });
      if (!isRecord(row) || typeof row.user_id !== "string") return null;
      return userById(row.user_id);
    },
    async redeemPasswordReset(tokenHash, passwordHash) {
      const userId = await rpc("web_redeem_password_reset", { p_token_hash: tokenHash, p_password_hash: passwordHash });
      return typeof userId === "string" ? userById(userId) : null;
    },

    async createModel(input) {
      const at = now();
      const { data } = await request("/rest/v1/models", {
        method: "POST",
        prefer: "return=representation",
        body: { id: input.id, owner_id: input.ownerId, name: input.name, created_at: at, updated_at: at },
      });
      const model = toModel(Array.isArray(data) ? data[0] : data);
      if (!model) throw new Error("[mutinybim-web supabase-db] the new model was not saved");
      return model;
    },
    async creationByKey(ownerId, key) {
      const row = await selectOne("model_creations", { select: "*", owner_id: eq(ownerId), creation_key: eq(key) });
      return row ? toModelCreation(row) : null;
    },
    async pendingCreations(ownerId) {
      return (await selectRows("model_creations", { select: "*", owner_id: eq(ownerId), state: eq("reserved"), order: "model_id" })).map(toModelCreation);
    },
    async reserveCreation(input, limit) {
      const result = await rpc("web_reserve_model_creation", { p_owner: input.owner_id, p_key: input.creation_key,
        p_model: input.model_id, p_name: input.name, p_starter: input.starter, p_hash: input.starter_hash, p_limit: limit });
      return result === "quota" || result === "conflict" || result === "id_used" ? result : toModelCreation(result);
    },
    async finishCreation(ownerId, key, state) {
      return toModelCreation(await rpc("web_finish_model_creation", { p_owner: ownerId, p_key: key, p_state: state }));
    },
    async modelsOf(userId) {
      return (await selectRows("models", { select: "*", owner_id: eq(userId), order: "updated_at.desc" })).flatMap((r) => toModel(r) ?? []);
    },
    async modelById(id) {
      return toModel(await selectOne("models", { select: "*", id: eq(id) }));
    },
    async countModelsOf(userId) {
      return countRows("models", { owner_id: eq(userId) });
    },
    async renameModel(id, name, ownerId) {
      const { data } = await request(`/rest/v1/models?${new URLSearchParams({ id: eq(id), owner_id: eq(ownerId), select: "id" })}`,
        { method: "PATCH", body: { name, updated_at: now() }, prefer: "return=representation" });
      return Array.isArray(data) && data.length === 1;
    },
    async touchModel(id) {
      await request(`/rest/v1/models?${new URLSearchParams({ id: eq(id) })}`, { method: "PATCH", body: { updated_at: now() } });
    },
    async deleteModel(id, ownerId) {
      const { data } = await request(`/rest/v1/models?${new URLSearchParams({ id: eq(id), owner_id: eq(ownerId), select: "id" })}`,
        { method: "DELETE", prefer: "return=representation" });
      return Array.isArray(data) && data.length === 1;
    },

    async accessTo(userId, modelId) {
      return toModelAccess(await rpc("web_access_to", { p_user: userId, p_model: modelId }), userId);
    },
    async sharedWith(userId) {
      const rows = await rpc("web_shared_with", { p_user: userId });
      if (!Array.isArray(rows)) throw new Error("[mutinybim-web supabase-db] expected a shared model list");
      return rows.flatMap((r) => toSharedModel(r) ?? []);
    },
    async sharesOf(modelId) {
      const rows = await selectRows("model_shares", {
        select: "user_id,role,created_at,users!model_shares_user_id_fkey(email,display_name)",
        model_id: eq(modelId),
        order: "created_at.asc",
      });
      const out: ShareRow[] = [];
      for (const r of rows) {
        if (!isRecord(r) || !isRecord(r.users)) continue;
        out.push({
          user_id: str(r, "user_id"),
          email: str(r.users, "email"),
          display_name: str(r.users, "display_name"),
          role: shareRole(r.role),
          created_at: str(r, "created_at"),
        });
      }
      return out;
    },
    async share(input) {
      return (await rpc("web_change_model_share", { p_model: input.modelId, p_owner: input.invitedBy, p_user: input.userId, p_role: input.role })) === true;
    },
    async unshare(modelId, userId, ownerId) {
      return (await rpc("web_change_model_share", { p_model: modelId, p_owner: ownerId, p_user: userId, p_role: null })) === true;
    },

    async createAgentKey(input) {
      await request("/rest/v1/agent_keys", {
        method: "POST",
        body: { id: input.id, user_id: input.userId, key_hash: input.keyHash, label: input.label, last4: input.last4, created_at: now() },
      });
    },
    async agentKeysOf(userId) {
      return (await selectRows("agent_keys", { select: "*", user_id: eq(userId), order: "created_at.desc" })).flatMap((r) => toAgentKey(r) ?? []);
    },
    async userByAgentKey(keyHash) {
      const row = await selectOne("agent_keys", { select: "user_id", key_hash: eq(keyHash) });
      if (!isRecord(row) || typeof row.user_id !== "string") return null;
      await request(`/rest/v1/agent_keys?${new URLSearchParams({ key_hash: eq(keyHash) })}`, { method: "PATCH", body: { last_used_at: now() } });
      return userById(row.user_id);
    },
    async deleteAgentKey(id, userId) {
      await request(`/rest/v1/agent_keys?${new URLSearchParams({ id: eq(id), user_id: eq(userId) })}`, { method: "DELETE" });
    },

    async oauthClient(provider, redirectUri): Promise<OAuthClientRow | null> {
      const row = await selectOne("oauth_clients", { select: "*", provider: eq(provider), redirect_uri: eq(redirectUri) });
      if (!isRecord(row)) return null;
      return { provider: str(row, "provider"), client_id: str(row, "client_id"), redirect_uri: str(row, "redirect_uri"), registered_at: str(row, "registered_at") };
    },
    async saveOAuthClient(provider, redirectUri, clientId) {
      await request("/rest/v1/oauth_clients?on_conflict=provider,redirect_uri", {
        method: "POST",
        prefer: "resolution=merge-duplicates",
        body: { provider, redirect_uri: redirectUri, client_id: clientId, registered_at: now() },
      });
    },
    async forgetOAuthClient(provider, redirectUri) {
      await request(`/rest/v1/oauth_clients?${new URLSearchParams({ provider: eq(provider), redirect_uri: eq(redirectUri) })}`, { method: "DELETE" });
    },

    async saveAssistantClient(input) {
      await request("/rest/v1/assistant_clients?on_conflict=client_id", {
        method: "POST",
        prefer: "resolution=merge-duplicates",
        body: {
          client_id: input.clientId,
          client_name: input.clientName,
          redirect_uris: input.redirectUris,
          kind: input.kind,
          token_auth_method: input.tokenAuthMethod ?? "none",
          secret_hash: input.secretHash ?? null,
          created_at: now(),
        },
      });
    },
    async assistantClient(clientId) {
      return toAssistantClient(await selectOne("assistant_clients", { select: "*", client_id: eq(clientId) }));
    },
    async countAssistantClients() {
      const { contentRange } = await request("/rest/v1/assistant_clients?select=client_id", { method: "HEAD", prefer: "count=exact" });
      if (!contentRange) return 0;
      const total = contentRange.split("/")[1];
      const parsed = total ? Number(total) : 0;
      return Number.isFinite(parsed) ? parsed : 0;
    },

    async saveAssistantCode(codeHash, code, expiresAt) {
      await request(`/rest/v1/assistant_codes?${new URLSearchParams({ expires_at: `lt.${now()}` })}`, { method: "DELETE" });
      await request("/rest/v1/assistant_codes", {
        method: "POST",
        body: {
          code_hash: codeHash,
          client_id: code.client_id,
          user_id: code.user_id,
          redirect_uri: code.redirect_uri,
          code_challenge: code.code_challenge,
          resource: code.resource,
          scope: code.scope,
          expires_at: expiresAt.toISOString(),
        },
      });
    },
    async takeAssistantCode(codeHash): Promise<AssistantCodeRow | null> {
      const data = await rpc("web_take_assistant_code", { p_code_hash: codeHash });
      const row = Array.isArray(data) ? data[0] : data;
      if (!isRecord(row)) return null;
      return {
        client_id: str(row, "client_id"),
        user_id: str(row, "user_id"),
        redirect_uri: str(row, "redirect_uri"),
        code_challenge: str(row, "code_challenge"),
        resource: str(row, "resource"),
        scope: str(row, "scope"),
      };
    },

    async createAssistantGrant(input) {
      await request("/rest/v1/assistant_grants", {
        method: "POST",
        body: {
          id: input.id,
          user_id: input.userId,
          client_id: input.clientId,
          client_name: input.clientName,
          resource: input.resource,
          scope: input.scope,
          access_hash: input.accessHash,
          access_expires_at: input.accessExpiresAt.toISOString(),
          refresh_hash: input.refreshHash,
          refresh_expires_at: input.refreshExpiresAt.toISOString(),
          created_at: now(),
        },
      });
    },
    async assistantGrantByAccess(accessHash) {
      const grant = toGrant(await selectOne("assistant_grants", { select: "*", access_hash: eq(accessHash), access_expires_at: `gt.${now()}` }));
      if (!grant) return null;
      const user = await userById(grant.user_id);
      if (!user) return null;
      await request(`/rest/v1/assistant_grants?${new URLSearchParams({ id: eq(grant.id) })}`, { method: "PATCH", body: { last_used_at: now() } });
      return { grant, user };
    },
    async rotateAssistantRefresh(refreshHash, clientId, next) {
      const data = await rpc("web_rotate_assistant_refresh", {
        p_refresh_hash: refreshHash,
        p_client_id: clientId,
        p_next_access_hash: next.accessHash,
        p_next_access_expires_at: next.accessExpiresAt.toISOString(),
        p_next_refresh_hash: next.refreshHash,
        p_next_refresh_expires_at: next.refreshExpiresAt.toISOString(),
      });
      if (!isRecord(data)) return null;
      if (data.status === "reused") return { reused: true };
      if (data.status !== "ok") return null;
      const grant = toGrant(data.grant);
      return grant ? { grant } : null;
    },
    async assistantGrantsOf(userId) {
      return (await selectRows("assistant_grants", { select: "*", user_id: eq(userId), order: "created_at.desc" })).flatMap((r) => toGrant(r) ?? []);
    },
    async deleteAssistantGrant(id, userId) {
      await request(`/rest/v1/assistant_grants?${new URLSearchParams({ id: eq(id), user_id: eq(userId) })}`, { method: "DELETE" });
    },
    async revokeAssistantToken(tokenHash) {
      const data = await rpc("web_revoke_assistant_token", { p_token_hash: tokenHash });
      return typeof data === "string" && data.length > 0 ? data : null;
    },
    async assistantGrantExists(id) {
      return (await selectOne("assistant_grants", { select: "id", id: eq(id) })) !== null;
    },

    async saveAssistantApproval(row) {
      await request("/rest/v1/assistant_approvals?on_conflict=id", {
        method: "POST",
        prefer: "resolution=merge-duplicates",
        body: {
          id: row.id,
          user_id: row.user_id,
          client_name: row.client_name,
          model_id: row.model_id,
          model_name: row.model_name,
          summary: row.summary,
          details: row.details,
          kind: row.kind,
          key: row.key,
          state: row.state,
          outcome: row.outcome,
          landing: row.landing ?? null,
          created_at: row.created_at,
        },
      });
    },
    async assistantApproval(id) {
      return toApproval(await selectOne("assistant_approvals", { select: "*", id: eq(id) }));
    },
    async assistantApprovalsOf(userId) {
      return (await selectRows("assistant_approvals", { select: "*", user_id: eq(userId), order: "created_at.desc" })).flatMap((r) => toApproval(r) ?? []);
    },
    async expireAssistantApprovals(cutoff, dropBefore, outcome) {
      await request(`/rest/v1/assistant_approvals?${new URLSearchParams({ state: eq("waiting"), created_at: `lt.${cutoff}` })}`, {
        method: "PATCH",
        body: { state: "expired", outcome, landing: null },
      });
      await request(`/rest/v1/assistant_approvals?${new URLSearchParams({ created_at: `lt.${dropBefore}` })}`, { method: "DELETE" });
    },

    async saveKeptScript(input) {
      await rpc("web_save_kept_script", {
        p_id: input.id,
        p_user_id: input.userId,
        p_body: input.body,
        p_expires_at: input.expiresAt,
        p_saved_at: Date.now(),
        p_keep: input.keep,
      });
    },
    async keptScript(id, userId) {
      const row = await selectOne("assistant_kept_scripts", { select: "body", id: eq(id), user_id: eq(userId), expires_at: `gt.${Date.now()}` });
      return isRecord(row) ? (row.body ?? null) : null;
    },

    async saveAssistantSession(row) {
      await request("/rest/v1/assistant_sessions?on_conflict=id", {
        method: "POST",
        prefer: "resolution=merge-duplicates",
        body: {
          id: row.id,
          user_id: row.user_id,
          grant_id: row.grant_id,
          family: row.family,
          families: row.families,
          run_id: row.run_id,
          init: row.init,
          created_at: Date.now(),
          last_seen_at: row.last_seen_at,
        },
      });
    },
    async assistantSession(id) {
      return toAssistantSession(await selectOne("assistant_sessions", { select: "*", id: eq(id) }));
    },
    async touchAssistantSession(id, at) {
      await request(`/rest/v1/assistant_sessions?${new URLSearchParams({ id: eq(id) })}`, { method: "PATCH", body: { last_seen_at: at } });
    },
    async deleteAssistantSession(id) {
      await request(`/rest/v1/assistant_sessions?${new URLSearchParams({ id: eq(id) })}`, { method: "DELETE" });
    },
    async deleteAssistantSessionsBefore(cutoff) {
      await request(`/rest/v1/assistant_sessions?${new URLSearchParams({ last_seen_at: `lt.${cutoff}` })}`, { method: "DELETE" });
    },
    async trimAssistantSessions(userId, keep) {
      await rpc("web_trim_assistant_sessions", { p_user_id: userId, p_keep: keep });
    },

    async linkedGrant(userId, provider) {
      return toLinkedGrant(await selectOne("linked_grants", { select: "*", user_id: eq(userId), provider: eq(provider) }));
    },
    async saveLinkedGrant(input) {
      const at = now();
      await request("/rest/v1/linked_grants?on_conflict=user_id,provider", {
        method: "POST",
        prefer: "resolution=merge-duplicates",
        body: {
          user_id: input.userId,
          provider: input.provider,
          client_id: input.clientId,
          access_cipher: input.accessCipher,
          refresh_cipher: input.refreshCipher,
          access_expires_at: input.accessExpiresAt.toISOString(),
          refresh_expires_at: input.refreshExpiresAt.toISOString(),
          state: "ok",
          last_error: null,
          created_at: at,
          updated_at: at,
        },
      });
    },
    async markLinkedReconnect(userId, provider, error) {
      await request(`/rest/v1/linked_grants?${new URLSearchParams({ user_id: eq(userId), provider: eq(provider) })}`, {
        method: "PATCH",
        body: { state: "reconnect", access_cipher: "", refresh_cipher: "", last_error: error.slice(0, 300), updated_at: now() },
      });
      await request(`/rest/v1/linked_models?${new URLSearchParams({ user_id: eq(userId), provider: eq(provider) })}`, { method: "DELETE" });
    },
    async deleteLinkedGrant(userId, provider) {
      await request(`/rest/v1/linked_grants?${new URLSearchParams({ user_id: eq(userId), provider: eq(provider) })}`, { method: "DELETE" });
      await request(`/rest/v1/linked_models?${new URLSearchParams({ user_id: eq(userId), provider: eq(provider) })}`, { method: "DELETE" });
    },
    async linkedModelsOf(userId, provider) {
      return (await selectRows("linked_models", { select: "*", user_id: eq(userId), provider: eq(provider), order: "label.asc" })).flatMap((r) => toLinkedModel(r) ?? []);
    },
    async linkedModelByAlias(userId, aliasId) {
      return toLinkedModel(await selectOne("linked_models", { select: "*", user_id: eq(userId), alias_id: eq(aliasId) }));
    },
    async replaceLinkedModels(userId, provider, rows, newAlias) {
      const payload = rows.map((r) => ({
        alias_id: newAlias(),
        remote_model_id: r.remoteModelId,
        remote_project_id: r.remoteProjectId,
        label: r.label,
        can_edit: r.canEdit,
        open_url: r.openUrl ?? "",
      }));
      const data = await rpc("web_replace_linked_models", { p_user_id: userId, p_provider: provider, p_rows: payload });
      return Array.isArray(data) ? data.flatMap((r) => toLinkedModel(r) ?? []) : [];
    },
    async linkedOfferAnswered(userId, provider) {
      return (await selectOne("linked_offers", { select: "user_id", user_id: eq(userId), provider: eq(provider) })) !== null;
    },
    async answerLinkedOffer(userId, provider) {
      await request("/rest/v1/linked_offers?on_conflict=user_id,provider", {
        method: "POST",
        prefer: "resolution=merge-duplicates",
        body: { user_id: userId, provider, answered_at: now() },
      });
    },

    async saveOAuthState(input) {
      await request(`/rest/v1/oauth_states?${new URLSearchParams({ created_at: `lt.${new Date(Date.now() - 15 * 60_000).toISOString()}` })}`, { method: "DELETE" });
      await request("/rest/v1/oauth_states", {
        method: "POST",
        body: { state: input.state, provider: input.provider, code_verifier: input.codeVerifier, return_to: input.returnTo, created_at: now() },
      });
    },
    async takeOAuthState(state): Promise<OAuthStateRow | null> {
      const data = await rpc("web_take_oauth_state", { p_state: state });
      const row = Array.isArray(data) ? data[0] : data;
      if (!isRecord(row)) return null;
      return {
        state: str(row, "state"),
        provider: str(row, "provider"),
        code_verifier: str(row, "code_verifier"),
        return_to: str(row, "return_to"),
        created_at: str(row, "created_at"),
      };
    },
  };
}
