import { NO_MODEL_ACCESS, type LineageGrantsAnswer, type ModelAuthorizer, type ModelGrant } from "@permitzip/bim-sync";
import { PgLineageMemberStore } from "../lineages/members";
import type { Sql } from "../pg-store";

/**
 * Disposable-stack adapter for seeded test logins: a member of the model's test
 * project (public.project_members on the authority's own database) may read
 * and edit. Real projects use the host plug-in (MUTINYBIM_AUTHORIZER_MODULE).
 * Enabled only when the authority is configured with its own disposable Auth
 * (MUTINYBIM_SUPABASE_URL).
 */
export class TestProjectAuthorizer implements ModelAuthorizer {
  constructor(private readonly sql: Sql) {}

  async capabilities(input: { readonly userId: string; readonly modelId: string }): Promise<ModelGrant> {
    const [row] = await this.sql<{ ok: boolean }[]>`
      select public.has_project_access(m.project_id, ${input.userId}::uuid) as ok from bim.models m where m.id = ${input.modelId}`;
    if (row?.ok !== true) return { ok: false, reason: NO_MODEL_ACCESS };
    return { ok: true, capabilities: new Set(["model.read", "model.edit", "model.issue"]) };
  }

  /** Round 11 (W11): per-copy members on the authority's own database (bim.lineage_members), as a standalone host keeps them. */
  async lineageGrants(input: { readonly userId: string; readonly modelId: string }): Promise<LineageGrantsAnswer> {
    return { ok: true, grants: await new PgLineageMemberStore(this.sql).grantsOf(input.modelId, input.userId) };
  }
}
