import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";

/**
 * A project's life as data (round 11 D3, `kernel.lifecycle_stage` v1 and
 * `kernel.stage_set` v1).
 *
 * Stages are rows, never a fixed list (product owner answer 5): the kernel ships a
 * default set, a jurisdiction or trade add-on adds its own stage rows to it
 * ("plan review round 2"), and a firm defines its own set, usually by copying
 * the defaults and reordering or replacing them (`copyStageSet`). A model
 * records which set and version it uses (the `stage_plan` record,
 * lifecycle/records.ts); freezing a stage writes a gate (lifecycle/freeze.ts).
 *
 * Stored ids (stage ids, set ids and versions) are forever. Readers keep a
 * stage or a set this release doesn't have: a model pinned to a set that
 * isn't installed reads the default stages and says so.
 */

/** A lineage role id (L11's `LINEAGE_ROLE_POINT`). Plain text here: the kernel names roles only as data. */
export type LineageRoleRef = string;

export interface LifecycleStageDef {
  /** Stable, stored in gates and sign-offs. Built-in rows are bare; an add-on's are `<pack>.<name>`; a firm's `firm:<name>` set may keep any of them. */
  readonly id: string;
  /** What a person reads ("Design development"). */
  readonly label: string;
  /** Sort order in the default set. A set lists its own order. */
  readonly order: number;
  /** The copy this stage's work is usually done on (`design_record`, `shop`, `as_built`). A hint for screens only. */
  readonly typicalLineageRole?: LineageRoleRef;
  /** Code packs and checklists that apply during the stage (ids, opaque here). */
  readonly codePackIds?: readonly string[];
  readonly checklistIds?: readonly string[];
  /**
   * What must be closed or disposed before the stage is left (frozen): open
   * findings of these severities, from these sources when listed (the problem
   * list's source kinds, F11). Absent: nothing blocks.
   */
  readonly exitBlockers?: { readonly severity: readonly string[]; readonly sources?: readonly string[] };
  /**
   * product owner question 6 (pending): freezing this stage *offers* a copy with this
   * role (occupancy offers the operations copy). Data only: nothing in the
   * kernel forks on freeze; a host shows the offer.
   */
  readonly onFreeze?: { readonly offerLineageRole?: LineageRoleRef };
}

/**
 * The default stages (D3), earliest first: our defaults, which a firm copies,
 * reorders or replaces. Words are generic to every stakeholder; a pack adds
 * its own trade or jurisdiction stages as rows.
 */
export const DEFAULT_STAGE_ROWS: readonly LifecycleStageDef[] = Object.freeze([
  { id: "due_diligence", label: "Due diligence", order: 10 },
  { id: "feasibility", label: "Feasibility", order: 20 },
  { id: "schematic_design", label: "Schematic design", order: 30, typicalLineageRole: "design_record" },
  { id: "design_development", label: "Design development", order: 40, typicalLineageRole: "design_record" },
  { id: "construction_documents", label: "Construction documents", order: 50, typicalLineageRole: "design_record", exitBlockers: { severity: ["blocking"] } },
  { id: "permit", label: "Permit", order: 60, typicalLineageRole: "design_record", exitBlockers: { severity: ["blocking"] } },
  { id: "bid", label: "Bid and buyout", order: 70 },
  { id: "construction", label: "Construction", order: 80, typicalLineageRole: "shop" },
  { id: "inspections", label: "Inspections", order: 90, exitBlockers: { severity: ["blocking"] } },
  { id: "occupancy", label: "Occupancy", order: 100, typicalLineageRole: "as_built", onFreeze: { offerLineageRole: "operations" } },
  { id: "operations", label: "Operations", order: 110, typicalLineageRole: "operations" },
]);

export const LIFECYCLE_STAGE_POINT = defineExtensionPoint<LifecycleStageDef>({
  id: "kernel.lifecycle_stage",
  version: 1,
  label: "Project stages",
  idOf: (row) => row.id,
  builtins: () => DEFAULT_STAGE_ROWS,
});

/** A whole list of stages a firm (or an add-on) uses, in its own order. */
export interface StageSetDef {
  /** `firm:<name>` for a firm's set, `<pack>.<name>` for an add-on's. Stored on the model's stage plan. */
  readonly id: string;
  /** The set's own version ("2026-11", "3"). A model pins it; a newer version is a new pin. */
  readonly version: string;
  readonly label: string;
  /** In order; each stage's `order` is ignored here. */
  readonly stages: readonly LifecycleStageDef[];
}

export const STAGE_SET_POINT = defineExtensionPoint<StageSetDef>({
  id: "kernel.stage_set",
  version: 1,
  label: "Stage lists",
  idOf: (row) => row.id,
});

/** The id a model's plan names for the default stages (every stage row in the set, by order). */
export const DEFAULT_STAGE_SET_ID = "default";
export const DEFAULT_STAGE_SET_VERSION = "1";

/** A stage list as a model reads it. */
export interface StageSetView {
  readonly id: string;
  readonly version: string;
  readonly label: string;
  readonly stages: readonly LifecycleStageDef[];
  /** Set when the pinned list isn't installed (or is at another version) and the default stages are shown instead, in words. */
  readonly problem?: string;
}

const DEFAULT_KEY = "kernel.lifecycle_stage#default";

/** The default stage list: every stage row in force (built-ins and add-ons), by order. */
export function defaultStageSet(set: PackSet = activePackSet()): StageSetView {
  return set.memo(DEFAULT_KEY, () => {
    const stages = [...set.items(LIFECYCLE_STAGE_POINT)].sort((a, b) => a.order - b.order);
    return { id: DEFAULT_STAGE_SET_ID, version: DEFAULT_STAGE_SET_VERSION, label: "Default stages", stages };
  });
}

/** Every stage list a model may pin: the default, then each installed list. */
export function stageSetsInForce(set: PackSet = activePackSet()): readonly StageSetView[] {
  return [defaultStageSet(set), ...set.items(STAGE_SET_POINT).map((s) => ({ id: s.id, version: s.version, label: s.label, stages: s.stages }))];
}

/** The list a pin names; the default stages (with the reason) when it isn't installed at that version. */
export function resolveStageSet(pin: { readonly id: string; readonly version?: string } | null | undefined, set: PackSet = activePackSet()): StageSetView {
  if (!pin || pin.id === DEFAULT_STAGE_SET_ID) return defaultStageSet(set);
  const row = set.items(STAGE_SET_POINT).find((s) => s.id === pin.id);
  const fallback = defaultStageSet(set);
  if (!row) return { ...fallback, problem: `This model uses the stage list "${pin.id}", which isn't installed here; showing the default stages` };
  if (pin.version !== undefined && pin.version !== row.version) return { id: row.id, version: row.version, label: row.label, stages: row.stages, problem: `This model was set up with version ${pin.version} of "${row.label}"; version ${row.version} is installed` };
  return { id: row.id, version: row.version, label: row.label, stages: row.stages };
}

/** A stage in a list, or undefined. */
export function stageIn(view: StageSetView, stageId: string): LifecycleStageDef | undefined {
  return view.stages.find((s) => s.id === stageId);
}

/** The stage after `stageId` in the list; null at the last stage or when it isn't in the list. */
export function nextStageIn(view: StageSetView, stageId: string): LifecycleStageDef | null {
  const at = view.stages.findIndex((s) => s.id === stageId);
  return at < 0 ? null : (view.stages[at + 1] ?? null);
}

export interface StageSetEdit {
  readonly id: string;
  readonly version: string;
  readonly label: string;
  /** Stage ids in their new order; stages left out are dropped. Absent: the base order. */
  readonly order?: readonly string[];
  /** Stages replaced by id (a firm's own label or blockers), or added when the id is new (placed at the end unless `order` names it). */
  readonly replace?: readonly LifecycleStageDef[];
}

/** A firm's own list from a base (usually the defaults): copied, reordered, replaced. Throws, in words, when `order` names a stage neither the base nor `replace` has. */
export function copyStageSet(base: StageSetView, edit: StageSetEdit): StageSetDef {
  const byId = new Map(base.stages.map((s) => [s.id, s] as const));
  for (const r of edit.replace ?? []) byId.set(r.id, r);
  const ids = edit.order ?? [...byId.keys()];
  const stages: LifecycleStageDef[] = [];
  for (const id of ids) {
    const s = byId.get(id);
    if (!s) throw new Error(`The stage list "${edit.label}" names a stage "${id}" that isn't in "${base.label}" and isn't added`);
    stages.push(s);
  }
  return { id: edit.id, version: edit.version, label: edit.label, stages };
}

/** Problems with stage rows and stage lists, in words (pack conformance). */
export function stageProblems(rows: readonly LifecycleStageDef[], sets: readonly StageSetDef[] = []): string[] {
  const out: string[] = [];
  const check = (s: LifecycleStageDef, where: string) => {
    if (s.label.trim().length === 0) out.push(`${where}: stage ${s.id} has no label`);
    if (!Number.isFinite(s.order)) out.push(`${where}: stage ${s.id}'s order must be a number`);
    if (s.exitBlockers && s.exitBlockers.severity.length === 0) out.push(`${where}: stage ${s.id} lists exit blockers with no severity`);
  };
  for (const r of rows) check(r, "stage row");
  for (const set of sets) {
    if (set.version.trim().length === 0) out.push(`stage list ${set.id} has no version`);
    if (set.stages.length === 0) out.push(`stage list ${set.id} has no stages`);
    const seen = new Set<string>();
    for (const s of set.stages) {
      if (seen.has(s.id)) out.push(`stage list ${set.id} lists ${s.id} twice`);
      seen.add(s.id);
      check(s, `stage list ${set.id}`);
    }
  }
  return out;
}

/** One open item on the problem list, as a stage's exit check reads it (F11's `FindingRef` carries these fields). */
export interface OpenFindingLike {
  readonly id: string;
  readonly severity: string;
  /** The finding's source kind (`lint_rule`, `code_rule`, …). */
  readonly sourceKind?: string;
}

/** The open findings that keep a stage from being left: none when the stage lists no blockers. */
export function stageExitBlockers(stage: LifecycleStageDef, open: readonly OpenFindingLike[]): readonly OpenFindingLike[] {
  const b = stage.exitBlockers;
  if (!b) return [];
  return open.filter((f) => b.severity.includes(f.severity) && (b.sources === undefined || (f.sourceKind !== undefined && b.sources.includes(f.sourceKind))));
}
