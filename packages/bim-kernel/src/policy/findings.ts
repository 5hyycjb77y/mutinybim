import type { FindingChange, FindingChangeContext, FindingReadContext, FindingSourceRow } from "../findings/sources/point";
import { findingRefId, findingSubjects, findingWords, localFindingId, type FindingRef, type FindingSeverity } from "../findings/ref";
import type { ModelState } from "../types";
import { designLimitMeasures, designLimitViolation, type DesignLimitMeasureRow, type DesignLimitMeasurement } from "./check";
import type { DesignLimitSeverity, DesignLimitSources } from "./design-limits";

/**
 * Design limit violations as problems (`FINDING_SOURCE_POINT`, round 11 D2).
 * The firm's and project's limits live in the host's library, not the model,
 * so the row is built per ledger with a reader for them (like lint's feed):
 * `designLimitFindingSource({ limits, stage })`.
 *
 * Every add-on's `DESIGN_LIMIT_MEASURE_POINT` rows are asked; after an edit,
 * only the changed ids are re-measured, and only findings about those ids are
 * retired or replaced. A finding's id is the limit plus the element, so
 * editing a limit's band rewrites its words, never its id.
 */

export const DESIGN_LIMIT_FINDING_KIND = "design_limit";
/** The check's version; a disposition recorded against an older one says so. */
export const DESIGN_LIMIT_FINDING_VERSION = "1";

const SEVERITY: Readonly<Record<DesignLimitSeverity, FindingSeverity>> = { error: "blocking", warning: "warning", info: "info" };

export interface DesignLimitFindingInputs {
  /** The firm's and project's limits now (the host's library read). */
  limits(): DesignLimitSources;
  /** The project's stage now (`LIFECYCLE_STAGE_POINT` id); absent: every stage. */
  stage?(): string | undefined;
}

function refsOf(model: ModelState, lineageId: string, measured: readonly DesignLimitMeasurement[], inputs: DesignLimitFindingInputs): FindingRef[] {
  const sources = inputs.limits();
  const stage = inputs.stage?.();
  const out: FindingRef[] = [];
  const seen = new Set<string>();
  for (const m of measured) {
    const check = designLimitViolation(m, stage, sources);
    if (!check || !check.limit) continue;
    const limitId = check.limit.limit.id;
    const id = findingRefId(DESIGN_LIMIT_FINDING_KIND, localFindingId(limitId, [m.elementId]));
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      source: { kind: DESIGN_LIMIT_FINDING_KIND, id: limitId, version: DESIGN_LIMIT_FINDING_VERSION },
      severity: SEVERITY[check.limit.limit.severity],
      subjects: findingSubjects([m.elementId]),
      lineageId,
      revision: model.revision,
      words: findingWords(check.words),
    });
  }
  return out;
}

function measureAll(model: ModelState, rows: readonly DesignLimitMeasureRow[], ids?: ReadonlySet<string>): DesignLimitMeasurement[] {
  const out: DesignLimitMeasurement[] = [];
  for (const row of rows) {
    try {
      out.push(...row.measure(model, ids));
    } catch (err) {
      console.error("[bim-kernel/policy] a design limit measure failed; its values aren't checked this time", { measure: row.id, err });
    }
  }
  return out;
}

/** The design limit problem source for one ledger. */
export function designLimitFindingSource(inputs: DesignLimitFindingInputs): FindingSourceRow {
  return {
    id: DESIGN_LIMIT_FINDING_KIND,
    label: "Design limits",
    all(ctx: FindingReadContext): readonly FindingRef[] {
      return refsOf(ctx.model, ctx.lineageId, measureAll(ctx.model, designLimitMeasures()), inputs);
    },
    changed(ctx: FindingChangeContext): FindingChange | null {
      const rows = designLimitMeasures();
      if (rows.length === 0 || ctx.changedIds.length === 0) return null;
      const ids = new Set(ctx.changedIds);
      const measured = measureAll(ctx.model, rows, ids);
      const put = refsOf(ctx.model, ctx.lineageId, measured, inputs);
      const subjects = new Set<string>([...ids, ...measured.map((m) => m.elementId)]);
      const retire = ctx.touching(subjects).map((f) => f.id);
      return { retire, put };
    },
  };
}
