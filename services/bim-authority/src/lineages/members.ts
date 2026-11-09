import type { LineageMemberStore } from "@permitzip/bim-sync";
import type { LineageGrantRecord } from "@permitzip/bim-sync/lineages";
import type { Sql } from "../pg-store";

/**
 * Standalone per-copy members (round 11 W11): who is named on which copy when
 * no host stores it (the open-source host and the disposable test stack).
 * db/migrations/20261103100200_bim_lineage_members.sql. A host plug-in that
 * keeps its own grants returns them from its authorizer's `lineageGrants`.
 */
export class PgLineageMemberStore implements LineageMemberStore {
  private hasTable: Promise<boolean> | null = null;

  constructor(private readonly sql: Sql) {}

  private stored(): Promise<boolean> {
    const known = this.hasTable;
    if (known) return known;
    const asked = this.sql<{ ok: boolean }[]>`select to_regclass('bim.lineage_members') is not null as ok`.then(
      (rows: readonly { ok: boolean }[]) => rows[0]?.ok === true,
      (err: unknown) => {
        this.hasTable = null;
        throw err;
      },
    );
    this.hasTable = asked;
    return asked;
  }

  async grantsOf(baseModelId: string, userId: string): Promise<readonly LineageGrantRecord[]> {
    if (!(await this.stored())) return [];
    const rows = await this.sql<{ lineage_id: string; capability: string }[]>`
      select lineage_id, capability from bim.lineage_members
      where base_model_id = ${baseModelId} and user_id = ${userId} and revoked_at is null`;
    return rows.map((r: { lineage_id: string; capability: string }) => ({ lineageId: r.lineage_id, capability: r.capability }));
  }
}
