import type postgres from "postgres";
import type { IfcImportReport } from "@permitzip/bim-kernel";
import type { Sql } from "../pg-store";
import type { ImportRunRow, ImportRunStatus, ImportRunStore } from "./runs";

function toJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

interface Row {
  id: string;
  base_model_id: string;
  branch_model_id: string | null;
  created_by: string;
  reference_id: string;
  source_version_id: string;
  source_sha256: string;
  hours_job_id: string | null;
  status: ImportRunStatus;
  total: number;
  landed: number;
  report: IfcImportReport | null;
  error: string | null;
}

function toRun(r: Row): ImportRunRow {
  return {
    id: r.id,
    baseModelId: r.base_model_id,
    branchModelId: r.branch_model_id,
    createdBy: r.created_by,
    referenceId: r.reference_id,
    sourceVersionId: r.source_version_id,
    sourceSha256: r.source_sha256,
    hostJobId: r.hours_job_id,
    status: r.status,
    total: r.total,
    landed: r.landed,
    report: r.report,
    error: r.error,
  };
}

/** `bim.import_runs` (db/migrations/20261101050500_bim_import_runs.sql). */
export class PgImportRuns implements ImportRunStore {
  private readonly owners = new Map<string, { readonly at: number; readonly owns: boolean }>();

  constructor(private readonly sql: Sql) {}

  async create(row: Omit<ImportRunRow, "branchModelId" | "total" | "landed" | "report" | "error">): Promise<void> {
    await this.sql`
      insert into bim.import_runs (id, base_model_id, created_by, reference_id, source_version_id, source_sha256, hours_job_id, status)
      values (${row.id}, ${row.baseModelId}, ${row.createdBy}, ${row.referenceId}, ${row.sourceVersionId}, ${row.sourceSha256}, ${row.hostJobId}, ${row.status})`;
  }

  async update(id: string, patch: Partial<Pick<ImportRunRow, "branchModelId" | "status" | "total" | "landed" | "report" | "error">>): Promise<void> {
    const finished = patch.status === "done" || patch.status === "failed" || patch.status === "cancelled";
    await this.sql`
      update bim.import_runs set
        branch_model_id = coalesce(${patch.branchModelId ?? null}, branch_model_id),
        status = coalesce(${patch.status ?? null}, status),
        total = coalesce(${patch.total ?? null}, total),
        landed = coalesce(${patch.landed ?? null}, landed),
        report = coalesce(${patch.report ? this.sql.json(toJson(patch.report)) : null}, report),
        error = coalesce(${patch.error ? patch.error.slice(0, 500) : null}, error),
        updated_at = now(),
        finished_at = case when ${finished} then now() else finished_at end
      where id = ${id}`;
    if (patch.branchModelId) this.owners.delete(patch.branchModelId);
  }

  async get(id: string): Promise<ImportRunRow | null> {
    const [row] = await this.sql<Row[]>`
      select id::text, base_model_id, branch_model_id, created_by, reference_id, source_version_id, source_sha256, hours_job_id, status, total, landed, report, error
      from bim.import_runs where id = ${id}`;
    return row ? toRun(row) : null;
  }

  async ownsProposal(branchModelId: string, userId: string): Promise<boolean> {
    const key = `${branchModelId}\u0000${userId}`;
    const cached = this.owners.get(key);
    if (cached && Date.now() - cached.at < 10_000) return cached.owns;
    const rows = await this.sql`
      select 1 from bim.import_runs where branch_model_id = ${branchModelId} and created_by = ${userId} and status = 'done' limit 1`;
    const owns = rows.length > 0;
    this.owners.set(key, { at: Date.now(), owns });
    return owns;
  }
}

