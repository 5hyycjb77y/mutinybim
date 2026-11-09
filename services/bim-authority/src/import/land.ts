import {
  IMPORT_CHUNK_SIZE,
  importChunks,
  planIfcImport,
  usesDropped,
  type Actor,
  type BimElement,
  type BranchRef,
  type ElementId,
  type IfcImportPlan,
  type IfcImportReport,
  type ImportSource,
  type ModelState,
} from "@permitzip/bim-kernel";
import type { Sequencer } from "@permitzip/bim-sync";

/**
 * Land a linked model's import on a new branch of Main (round 9 I9). The
 * plan is decided here, on the model server, from Main's head and the
 * model's own pack set; a client never supplies records. The branch is made
 * from Main's head, then the records land in chunks through the branch's
 * sequencer as server-only `import_elements` revisions attributed to the
 * person. A chunk the model refuses for named records lands without them
 * (each stays on the linked model, with the reason in the report); Cancel
 * between chunks closes the half-made branch, and Main never changes.
 */

export interface ImportLandDeps {
  createBranch(input: { readonly name: string; readonly baseRevision: number; readonly createdBy: string }): Promise<BranchRef>;
  closeBranch(modelId: string): Promise<void>;
  openBranch(modelId: string): Promise<Pick<Sequencer, "head" | "submit">>;
}

export interface ImportLandInput {
  readonly main: ModelState;
  readonly source: ImportSource;
  readonly referenceId: string;
  readonly sourceKey: string;
  readonly branchName: string;
  readonly actor: Actor;
  readonly chunkSize?: number;
  readonly isCancelled?: () => boolean;
  readonly onProgress?: (p: { readonly landed: number; readonly total: number; readonly branch: BranchRef | null }) => void;
}

export type ImportLandResult =
  | { readonly status: "done"; readonly branch: BranchRef; readonly report: IfcImportReport; readonly revisions: number; readonly landed: number }
  | { readonly status: "cancelled"; readonly report: IfcImportReport; readonly landed: number }
  | { readonly status: "nothing"; readonly report: IfcImportReport };

/** A refusal the person reads ("the model server refused part of this"); anything else is a fault. */
export class ImportRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportRefusal";
  }
}

const MAX_RETRIES = 3;

export async function landImportOnBranch(deps: ImportLandDeps, input: ImportLandInput): Promise<ImportLandResult> {
  const plan: IfcImportPlan = planIfcImport(input.source, { model: input.main, referenceId: input.referenceId, sourceKey: input.sourceKey });
  if (plan.records.length === 0 || plan.report.converted === 0) return { status: "nothing", report: plan.report };
  if (input.isCancelled?.()) return { status: "cancelled", report: plan.report, landed: 0 };

  const branch = await deps.createBranch({ name: input.branchName, baseRevision: input.main.revision, createdBy: input.actor.id });
  const sequencer = await deps.openBranch(branch.modelId);
  const session = `import-${globalThis.crypto.randomUUID()}`;
  const chunks = importChunks(plan.records, input.chunkSize ?? IMPORT_CHUNK_SIZE);
  const dropped: Array<{ id: ElementId; reason: string }> = [];
  let landed = 0;
  let revisions = 0;
  input.onProgress?.({ landed, total: plan.records.length, branch });
  for (const [i, chunk] of chunks.entries()) {
    if (input.isCancelled?.()) {
      await closeQuietly(deps, branch.modelId);
      return { status: "cancelled", report: withDropped(plan.report, dropped, plan.records), landed };
    }
    let pending: BimElement[] = chunk.filter((r) => !dropped.some((d) => r.id === d.id || usesDropped(r, d.id)));
    for (let attempt = 0; pending.length > 0; attempt++) {
      const head = await sequencer.head();
      const outcome = await sequencer.submit(
        {
          idempotencyKey: `${session}-${i}-${attempt}`.slice(0, 128),
          baseRevision: head.revision,
          actor: input.actor,
          clientSessionId: session,
          command: { type: "import_elements", sourceId: input.source.id.slice(0, 200), label: `Import ${input.source.label}`.slice(0, 160), chunk: i + 1, of: chunks.length },
        },
        { importLanding: { records: pending } },
      );
      if (outcome.status === "committed") {
        landed += pending.length;
        revisions += 1;
        break;
      }
      const named = new Set(outcome.error.elementIds);
      const hit = pending.filter((r) => named.has(r.id));
      if (hit.length === 0 || attempt >= MAX_RETRIES) {
        console.error("[bim-authority/import] a chunk was refused; closing the branch", { branch: branch.modelId, chunk: i + 1, of: chunks.length, error: outcome.error });
        await closeQuietly(deps, branch.modelId);
        throw new ImportRefusal(`The model server refused part of this import: ${outcome.error.message} The branch was closed; Main didn't change.`);
      }
      for (const r of hit) if (!dropped.some((d) => d.id === r.id)) dropped.push({ id: r.id, reason: outcome.error.message });
      pending = pending.filter((r) => !named.has(r.id) && !dropped.some((d) => usesDropped(r, d.id)));
    }
    input.onProgress?.({ landed, total: plan.records.length, branch });
  }
  return { status: "done", branch, report: withDropped(plan.report, dropped, plan.records), revisions, landed };
}

async function closeQuietly(deps: ImportLandDeps, modelId: string): Promise<void> {
  try {
    await deps.closeBranch(modelId);
  } catch (err) {
    console.error("[bim-authority/import] closing the half-made branch failed; it stays open and holds what landed", { modelId, err });
  }
}

/** The plan's report with what the model refused moved to "stays linked". */
function withDropped(report: IfcImportReport, dropped: readonly { readonly id: ElementId; readonly reason: string }[], records: readonly BimElement[]): IfcImportReport {
  if (dropped.length === 0) return report;
  const ids = new Set(dropped.map((d) => d.id));
  const lost = records.filter((r) => ids.has(r.id) || dropped.some((d) => usesDropped(r, d.id))).length;
  const first = dropped[0]?.reason ?? "";
  return {
    ...report,
    converted: Math.max(0, report.converted - lost),
    stayLinked: report.stayLinked + lost,
    notes: [...report.notes, `${lost} converted ${lost === 1 ? "item" : "items"} didn't fit the model and stay on the linked model (${first})`],
    summary: `${report.summary} ${lost} more stay linked because the model refused them.`,
  };
}
