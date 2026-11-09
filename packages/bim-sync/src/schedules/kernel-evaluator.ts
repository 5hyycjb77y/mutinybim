import { canonicalJson, fieldProviderRegistry, type Changeset, type ModelState, type ScheduleDefinitionV2 } from "@permitzip/bim-kernel";
import { ScheduleDefinitionError, openSchedule, scheduleChangeFromChangeset, scheduleV1ToV2, V1_SCHEDULE_PROFILE_ID, type RowPatch, type ScheduleChange, type ScheduleEngineContext, type ScheduleSession } from "@permitzip/bim-kernel/schedules";
import { withModelPacks } from "@permitzip/bim-kernel/packs";
import type { ScheduleApplyResult, ScheduleEvaluator, ScheduleInstance, ScheduleOpenResult } from "./evaluator";
import type { ScheduleTarget } from "./protocol";

/**
 * The production evaluator: the kernel's incremental row engine (Stream E)
 * over the whole model. A view target reads the schedule view's definition
 * (`scheduleV2` first; v1 list schedules are converted with `scheduleV1ToV2`); an ad hoc target
 * carries a v2 definition. Each batch of commits becomes one `ScheduleChange`
 * and the session patches only the rows it touches.
 */

export const SCHEDULE_DELETED = "This schedule was deleted.";
export const FORM_SCHEDULE_NOT_IN_GRID = "Panel, switchboard and feeder schedules open on their sheet for now. The grid shows list schedules.";
export const NO_SCHEDULE_ON_VIEW = "This view has no schedule yet. Choose what it lists in the schedule builder first.";

type Resolved = { readonly ok: true; readonly definition: ScheduleDefinitionV2; readonly signature: string } | { readonly ok: false; readonly reason: "deleted" | "closed"; readonly message: string };

function resolveView(model: ModelState, viewId: string): Resolved {
  const el = model.elements[viewId];
  if (!el || el.kind !== "view" || el.deleted) return { ok: false, reason: "deleted", message: SCHEDULE_DELETED };
  const props = el.props;
  if (props?.scheduleV2) {
    if (props.scheduleV2.presentation.kind === "form") return { ok: false, reason: "closed", message: FORM_SCHEDULE_NOT_IN_GRID };
    return { ok: true, definition: props.scheduleV2, signature: canonicalJson(props.scheduleV2) };
  }
  if (props?.schedule) return { ok: true, definition: scheduleV1ToV2(props.schedule), signature: canonicalJson(props.schedule) };
  if (props?.formSchedule) return { ok: false, reason: "closed", message: FORM_SCHEDULE_NOT_IN_GRID };
  return { ok: false, reason: "closed", message: NO_SCHEDULE_ON_VIEW };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural check only; the engine refuses a definition with problems, in plain words. */
function isDefinitionV2(value: Readonly<Record<string, unknown>>): value is Readonly<Record<string, unknown>> & ScheduleDefinitionV2 {
  return (
    typeof value.name === "string" &&
    isRecord(value.source) &&
    typeof value.source.kind === "string" &&
    Array.isArray(value.columns) &&
    Array.isArray(value.filters) &&
    Array.isArray(value.sort) &&
    Array.isArray(value.groups) &&
    typeof value.grandTotals === "boolean" &&
    typeof value.itemize === "boolean" &&
    isRecord(value.presentation) &&
    isRecord(value.display)
  );
}

function shortHash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/** Several consecutive changesets as one change against the model after the last. */
export function mergedScheduleChange(model: ModelState, changes: readonly Changeset[]): ScheduleChange {
  const changed = new Set<string>();
  const removed = new Set<string>();
  const endpoints = new Set<string>();
  for (const cs of changes) {
    const one = scheduleChangeFromChangeset(cs, model);
    for (const id of one.changedIds) {
      changed.add(id);
      removed.delete(id);
    }
    for (const id of one.removedIds ?? []) {
      removed.add(id);
      changed.delete(id);
    }
    for (const id of one.connectionEndpoints ?? []) endpoints.add(id);
  }
  return {
    model,
    revision: changes[changes.length - 1]?.revision ?? model.revision,
    changedIds: [...changed],
    ...(removed.size > 0 ? { removedIds: [...removed] } : {}),
    ...(endpoints.size > 0 ? { connectionEndpoints: [...endpoints] } : {}),
  };
}

function isEmptyPatch(p: RowPatch): boolean {
  return p.upserts.length === 0 && p.removes.length === 0 && p.order === undefined && p.totals === undefined && p.groups === undefined;
}

function refusal(err: unknown): ScheduleOpenResult {
  if (err instanceof ScheduleDefinitionError) return { ok: false, reason: "closed", message: `This schedule can't be shown: ${err.problems.map((p) => p.message).join(" ")}` };
  throw err;
}

/**
 * Every schedule that opens over the built-in registry opens exactly as
 * before. A native v2 schedule the built-in registry refuses because it names
 * trade provider fields (the Loads list's `load.status` and
 * `loads.counted.dfu`, Not placed yet's `placement`) opens over the kernel
 * registry with every field provider, as the agent's schedule reads and the
 * builder's field list do. A v1 schedule (read as v2, or converted in place:
 * it keeps the v1 print profile) never does: its bare column names
 * (`circuit`, `load`) must read as v1 printed them.
 */
export function kernelScheduleEvaluator(context: Pick<ScheduleEngineContext, "registry"> = {}): ScheduleEvaluator {
  const open = (model: ModelState, definition: ScheduleDefinitionV2, viewId: string): ScheduleSession => {
    const ctx: ScheduleEngineContext = { ...context, viewId, revision: model.revision };
    return withModelPacks(model.modelId, () => {
      try {
        return openSchedule(model, definition, ctx);
      } catch (err) {
        const providerFields = !context.registry && definition.display.profile !== V1_SCHEDULE_PROFILE_ID && err instanceof ScheduleDefinitionError && err.problems.some((p) => p.code === "unknown_field");
        if (!providerFields) throw err;
        return openSchedule(model, definition, { ...ctx, registry: fieldProviderRegistry() });
      }
    });
  };
  return {
    open(model: ModelState, target: ScheduleTarget): ScheduleOpenResult {
      if ("viewId" in target) {
        const viewId = target.viewId;
        const resolved = resolveView(model, viewId);
        if (!resolved.ok) return resolved;
        let session: ScheduleSession;
        try {
          session = open(model, resolved.definition, viewId);
        } catch (err) {
          return refusal(err);
        }
        let signature = resolved.signature;
        const instance: ScheduleInstance = {
          viewId,
          rows: () => session.rows(),
          apply(next: ModelState, changes: readonly Changeset[]): ScheduleApplyResult {
            if (changes.some((cs) => cs.elements.some((el) => el.id === viewId) || (cs.removedIds ?? []).some((id) => id === viewId))) {
              const again = resolveView(next, viewId);
              if (!again.ok) return { kind: "closed", reason: again.reason, message: again.message };
              if (again.signature !== signature) {
                try {
                  session = open(next, again.definition, viewId);
                } catch (err) {
                  if (err instanceof ScheduleDefinitionError) return { kind: "closed", reason: "closed", message: `This schedule can't be shown: ${err.problems.map((p) => p.message).join(" ")}` };
                  throw err;
                }
                signature = again.signature;
                return { kind: "reset" };
              }
            }
            const patch = session.apply(mergedScheduleChange(next, changes));
            return isEmptyPatch(patch) ? { kind: "unchanged" } : { kind: "patch", patch };
          },
        };
        return { ok: true, instance };
      }
      const raw = target.definition;
      if (!isDefinitionV2(raw)) return { ok: false, reason: "closed", message: "This schedule definition is incomplete: it needs a name, a source, columns, filters, sort, groups, totals, itemize, presentation and display." };
      const viewId = `adhoc:${shortHash(canonicalJson(raw))}`;
      let session: ScheduleSession;
      try {
        session = open(model, raw, viewId);
      } catch (err) {
        return refusal(err);
      }
      return {
        ok: true,
        instance: {
          viewId,
          rows: () => session.rows(),
          apply(next: ModelState, changes: readonly Changeset[]): ScheduleApplyResult {
            const patch = session.apply(mergedScheduleChange(next, changes));
            return isEmptyPatch(patch) ? { kind: "unchanged" } : { kind: "patch", patch };
          },
        },
      };
    },
  };
}
