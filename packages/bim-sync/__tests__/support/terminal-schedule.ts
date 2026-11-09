import type { BimElement, Changeset, ModelState } from "@permitzip/bim-kernel";
import type { CellCommandPlanner, ColumnValues, RowPatch, RowSet, RowSetColumn, ScheduleEvaluator, ScheduleInstance, ScheduleTarget } from "../../src";
import { airflowOf } from "@permitzip/bim-pack-mechanical";

/**
 * A small incremental schedule for the sync tests: every air terminal in the
 * model (mark, CFM), sorted by mark. It counts builds and applies, so a test
 * can tell a patch from a rebuild. The real row engine is the kernel's;
 * this keeps the sync tests about sync.
 */

export const TERMINAL_VIEW = "schedule-terminals";
const CFM_TO_SI = 0.00047194745;

const COLUMNS: readonly RowSetColumn[] = [
  { id: "mark", heading: "MARK", kind: "field", valueType: "text", writer: { scope: "instance" } },
  { id: "cfm", heading: "CFM", kind: "field", valueType: "quantity", quantityKind: "flow_air", unit: "cfm", writer: { scope: "instance" } },
];

type Terminal = Extract<BimElement, { kind: "terminal" }>;

function terminals(model: Pick<ModelState, "elements">): Terminal[] {
  const out: Terminal[] = [];
  for (const el of Object.values(model.elements)) if (el.kind === "terminal") out.push(el);
  return out.sort((a, b) => (a.mark === b.mark ? (a.id < b.id ? -1 : 1) : a.mark < b.mark ? -1 : 1));
}

function rowSet(list: readonly Terminal[], revision: number): RowSet {
  const cfm = new Float64Array(list.length);
  list.forEach((t, i) => (cfm[i] = (airflowOf(t) ?? 0) * CFM_TO_SI));
  const values = new Map<string, ColumnValues>([
    ["mark", { type: "text", values: list.map((t) => t.mark) }],
    ["cfm", { type: "quantity", kind: "flow_air", values: cfm }],
  ]);
  return { viewId: TERMINAL_VIEW, revision, columns: COLUMNS, rowCount: list.length, rowKeys: list.map((t) => t.id), elementIds: list.map((t) => t.id), values, children: new Map() };
}

export interface CountingEvaluator extends ScheduleEvaluator {
  readonly counts: { opens: number; applies: number };
}

export function terminalScheduleEvaluator(): CountingEvaluator {
  const counts = { opens: 0, applies: 0 };
  return {
    counts,
    open(model: ModelState, target: ScheduleTarget) {
      if (!("viewId" in target) || target.viewId !== TERMINAL_VIEW) return { ok: false, reason: "deleted", message: "This schedule was deleted." };
      counts.opens += 1;
      let rows = rowSet(terminals(model), model.revision);
      const instance: ScheduleInstance = {
        viewId: TERMINAL_VIEW,
        rows: () => rows,
        apply(next: ModelState, changes: readonly Changeset[]) {
          counts.applies += 1;
          const touched = new Set<string>();
          for (const cs of changes) {
            for (const el of cs.elements) if (el.kind === "terminal") touched.add(el.id);
            for (const id of cs.removedIds ?? []) if (rows.rowKeys.includes(id)) touched.add(id);
          }
          const toRevision = changes[changes.length - 1]?.revision ?? rows.revision;
          if (touched.size === 0) {
            rows = { ...rows, revision: toRevision };
            return { kind: "unchanged" };
          }
          const before = rows;
          rows = rowSet(terminals(next), toRevision);
          const index = new Map(rows.rowKeys.map((k, i) => [k, i] as const));
          const patch: RowPatch = {
            viewId: TERMINAL_VIEW,
            fromRevision: before.revision,
            toRevision,
            upserts: [...touched]
              .filter((id) => index.has(id))
              .map((id) => {
                const t = next.elements[id];
                const cfm = t?.kind === "terminal" ? (airflowOf(t) ?? 0) * CFM_TO_SI : null;
                return { rowKey: id, elementId: id, values: { mark: t?.kind === "terminal" ? t.mark : null, cfm } };
              }),
            removes: [...touched].filter((id) => !index.has(id)),
            ...(before.rowKeys.join("\u0000") !== rows.rowKeys.join("\u0000") ? { order: rows.rowKeys } : {}),
          };
          return { kind: "patch", patch };
        },
      };
      return { ok: true, instance };
    },
  };
}

/** CFM cells become `set_terminal_cfm` (one edit per batch is enough here). */
export const terminalPlanner: CellCommandPlanner = {
  plan(rows, batch) {
    const edit = batch.edits[0];
    if (!edit || edit.columnId !== "cfm" || typeof edit.value !== "number") return { command: null, typeScope: [], refusals: batch.edits.map((e) => ({ rowKey: e.rowKey, columnId: e.columnId, reason: "Only CFM can be typed here." })) };
    const at = rows.rowKeys.indexOf(edit.rowKey);
    const elementId = rows.elementIds[at];
    if (elementId === undefined) return { command: null, typeScope: [], refusals: [{ rowKey: edit.rowKey, columnId: edit.columnId, reason: "That row is no longer in the schedule." }] };
    return { command: { type: "set_terminal_cfm", terminalId: elementId, cfm: edit.value / CFM_TO_SI }, typeScope: [], refusals: [] };
  },
};

export const cfmToSi = (cfm: number): number => cfm * CFM_TO_SI;
