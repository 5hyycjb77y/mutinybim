import type { BimElement, ElementId, ModelState } from "../types";
import { storedField } from "../kinds";
import { elementKindTable } from "../registry/element-kind-point";
import { DEFAULT_GROUP_ID, DEFAULT_PHASE_ID, groupOf, isOrganized, organizationOf, type Organization } from "./model";

/**
 * Rules every model command obeys, applied once in the shared commit path
 * (`finish`), so routing, parts, fittings, undo and agents all get them:
 *
 * - A new element goes in the model's active group and is created in its
 *   active phase (unless the command already set them, as a copy does).
 * - Nothing in a locked group is created, changed, moved out, moved in or
 *   deleted. Derived values (a flow total recomputed downstream) are not edits
 *   and still update.
 */

/** Stamp new elements with the active group and phase. Writes into `working`. */
export function stampNewElements(base: ModelState, working: Record<string, BimElement>, touched: readonly ElementId[]): void {
  const org = organizationOf(base);
  const group = org.activeGroupId;
  const phase = org.activePhaseId;
  if (group === DEFAULT_GROUP_ID && phase === DEFAULT_PHASE_ID) return;
  for (const id of touched) {
    if (base.elements[id]) continue;
    const el = working[id];
    if (!el || !isOrganized(el)) continue;
    const needsGroup = group !== DEFAULT_GROUP_ID && el.groupId === undefined;
    const needsPhase = phase !== DEFAULT_PHASE_ID && el.phaseCreated === undefined;
    if (!needsGroup && !needsPhase) continue;
    working[id] = { ...el, ...(needsGroup ? { groupId: group } : {}), ...(needsPhase ? { phaseCreated: phase } : {}) };
  }
}

function describe(el: BimElement): string {
  switch (el.kind) {
    case "part":
      return el.mark ? el.mark : "This part";
    case "run_segment":
      return "This run";
    case "run_fitting":
      return "This fitting";
    default:
      return describeByRow(el) ?? `This ${el.kind.replace(/_/g, " ")}`;
  }
}

/** An add-on kind's record in its row's words: its mark when its shape keeps one ("This element" while unmarked), else "This <label>". Null when no row names the kind. */
function describeByRow(el: BimElement): string | null {
  const row = elementKindTable().row(el.kind);
  if (!row) return null;
  if (row.shape?.fields.some((f) => f.name === "mark")) {
    const mark = storedField(el, "mark");
    return typeof mark === "string" && mark !== "" ? mark : "This element";
  }
  const label = row.label;
  const word = label.length > 1 && label[1] === label[1]?.toUpperCase() && label[1] !== label[1]?.toLowerCase() ? label : label.charAt(0).toLowerCase() + label.slice(1);
  return `This ${word}`;
}

function lockedName(org: Organization, el: BimElement | undefined): string | null {
  if (!el || !isOrganized(el)) return null;
  const group = groupOf(org, el);
  return group.entry.locked ? group.entry.name : null;
}

export interface LockRefusal {
  readonly message: string;
  readonly elementIds: readonly ElementId[];
}

/**
 * Plain reason the command touches a locked group, or null. `ids` are the
 * elements the command set or removed (not ones only re-derived).
 */
export function lockRefusal(base: ModelState, working: Readonly<Record<string, BimElement>>, ids: readonly ElementId[]): LockRefusal | null {
  const org = organizationOf(base);
  if (!org.groups.some((g) => g.entry.locked)) return null;
  const blocked: ElementId[] = [];
  let first: { el: BimElement; group: string } | null = null;
  for (const id of ids) {
    const before = base.elements[id];
    const after = working[id];
    const subject = before ?? after;
    if (!subject || after === before) continue;
    const group = lockedName(org, before) ?? lockedName(org, after);
    if (group === null) continue;
    blocked.push(id);
    if (!first) first = { el: subject, group };
  }
  if (!first) return null;
  const more = blocked.length > 1 ? ` (and ${blocked.length - 1} more)` : "";
  const created = !base.elements[first.el.id];
  const message = created
    ? `New elements go in "${first.group}", which is locked. Make another group active, or unlock "${first.group}" (Manage › Groups & phases).`
    : `${describe(first.el)}${more} is in the locked group "${first.group}", so it can't be changed. Unlock the group first (Manage › Groups & phases).`;
  return { message, elementIds: blocked };
}
