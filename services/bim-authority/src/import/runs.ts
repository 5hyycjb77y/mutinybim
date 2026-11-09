import type { IfcImportReport } from "@permitzip/bim-kernel";

/** What one import run is doing, as the person's page reads it. */
export type ImportRunStatus = "converting" | "landing" | "done" | "failed" | "cancelled";

export interface ImportRunRow {
  readonly id: string;
  readonly baseModelId: string;
  readonly branchModelId: string | null;
  readonly createdBy: string;
  readonly referenceId: string;
  readonly sourceVersionId: string;
  readonly sourceSha256: string;
  readonly hostJobId: string | null;
  readonly status: ImportRunStatus;
  readonly total: number;
  readonly landed: number;
  readonly report: IfcImportReport | null;
  readonly error: string | null;
}

export interface ImportRunStore {
  create(row: Omit<ImportRunRow, "branchModelId" | "total" | "landed" | "report" | "error">): Promise<void>;
  update(id: string, patch: Partial<Pick<ImportRunRow, "branchModelId" | "status" | "total" | "landed" | "report" | "error">>): Promise<void>;
  get(id: string): Promise<ImportRunRow | null>;
  /** Whether `userId` opened this branch through a finished import (they may edit it, product decision answer 7). */
  ownsProposal(branchModelId: string, userId: string): Promise<boolean>;
}

/** In memory, for tests and drills. */
export class InMemoryImportRuns implements ImportRunStore {
  readonly rows = new Map<string, ImportRunRow>();

  async create(row: Omit<ImportRunRow, "branchModelId" | "total" | "landed" | "report" | "error">): Promise<void> {
    this.rows.set(row.id, { ...row, branchModelId: null, total: 0, landed: 0, report: null, error: null });
  }

  async update(id: string, patch: Partial<Pick<ImportRunRow, "branchModelId" | "status" | "total" | "landed" | "report" | "error">>): Promise<void> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
  }

  async get(id: string): Promise<ImportRunRow | null> {
    return this.rows.get(id) ?? null;
  }

  async ownsProposal(branchModelId: string, userId: string): Promise<boolean> {
    return [...this.rows.values()].some((r) => r.branchModelId === branchModelId && r.createdBy === userId && r.status === "done");
  }
}
