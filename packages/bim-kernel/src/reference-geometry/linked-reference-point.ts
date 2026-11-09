import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import { linkedPlanDisplay } from "../registry/linked-plan-display-point";

/**
 * What a linked model's elements are good for besides being drawn
 * (`kernel.linked_reference` v1): snapping and dimensioning to them, bounding
 * rooms, and envelope facts. Each add-on names, for the IFC entities its
 * trade owns, which of these apply. The kernel names no entity: with no row,
 * whatever a plan cuts as a body (`kernel.linked_plan_display`: drawn by body
 * where cut) can be snapped to, and nothing bounds rooms.
 */

export type LinkedEnvelopeRole = "wall" | "window" | "door" | "roof";

export interface LinkedReferenceRow {
  readonly id: string;
  readonly label: string;
  /** IFC entity names, upper case as the file spells them (IFCWALL). */
  readonly ifcEntities: readonly string[];
  /** The noun a snap marker uses ("On the linked wall"). */
  readonly noun: string;
  /** Tools snap and dimensions attach to its faces, centre line, ends and corners. */
  readonly snap: boolean;
  /** Its faces bound rooms found from walls. */
  readonly boundsRooms: boolean;
  /** Read as envelope data for loads (outside walls, windows, doors, roofs). */
  readonly envelope?: LinkedEnvelopeRole;
}

export const LINKED_REFERENCE_POINT = defineExtensionPoint<LinkedReferenceRow>({
  id: "kernel.linked_reference",
  version: 1,
  label: "Linked model elements as reference geometry",
  idOf: (row) => row.id,
});

const IFC_ENTITY = /^IFC[A-Z0-9]{2,60}$/;
const ENVELOPE_ROLES: readonly LinkedEnvelopeRole[] = ["wall", "window", "door", "roof"];

/** Problems with linked reference rows (pack conformance), in words. */
export function linkedReferenceRowProblems(rows: readonly LinkedReferenceRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) out.push(`linked reference ${row.id} is declared twice`);
    seen.add(row.id);
    if (row.label.trim().length === 0) out.push(`linked reference ${row.id} has no label`);
    if (row.noun.trim().length === 0) out.push(`linked reference ${row.id} has no noun for its snap marker`);
    if (row.ifcEntities.length === 0) out.push(`linked reference ${row.id} names no IFC entity`);
    for (const e of row.ifcEntities) if (!IFC_ENTITY.test(e)) out.push(`linked reference ${row.id}: "${e}" is not an upper-case IFC entity name such as IFCWALL`);
    if (row.envelope !== undefined && !ENVELOPE_ROLES.includes(row.envelope)) out.push(`linked reference ${row.id}: envelope "${String(row.envelope)}" is not one of ${ENVELOPE_ROLES.join(", ")}`);
  }
  return out;
}

/** One entity's resolved rule: plain data. */
export interface LinkedReferenceRule {
  readonly noun: string;
  readonly snap: boolean;
  readonly boundsRooms: boolean;
  readonly envelope: LinkedEnvelopeRole | null;
}

export interface LinkedReferenceRules {
  /** By IFC entity name; an entity with no rule is not reference geometry. */
  readonly rules: Readonly<Record<string, LinkedReferenceRule>>;
  readonly fingerprint: string;
}

/** The noun for an entity no row names: its IFC name without the prefix or the exporter's suffix (IFCCOLUMN → column). */
export function nounOfIfcEntity(entity: string): string {
  return entity
    .replace(/^IFC/, "")
    .replace(/(STANDARDCASE|ELEMENTEDCASE|TYPE)$/, "")
    .toLowerCase();
}

function fingerprintOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * The rules these rows make, in order (the first row to name an entity wins),
 * then the fallback: an entity the plan display draws by body where cut is a
 * snap reference. `cutBodies` lists those entities.
 */
export function linkedReferenceRulesOf(rows: readonly LinkedReferenceRow[], cutBodies: readonly string[]): LinkedReferenceRules {
  const rules: Record<string, LinkedReferenceRule> = {};
  for (const row of rows) {
    const rule: LinkedReferenceRule = { noun: row.noun, snap: row.snap, boundsRooms: row.boundsRooms, envelope: row.envelope ?? null };
    for (const e of row.ifcEntities) if (!(e in rules)) rules[e] = rule;
  }
  for (const e of cutBodies) if (!(e in rules)) rules[e] = { noun: nounOfIfcEntity(e), snap: true, boundsRooms: false, envelope: null };
  const canonical = Object.keys(rules)
    .sort()
    .map((e) => `${e}=${JSON.stringify(rules[e])}`)
    .join(";");
  return { rules, fingerprint: fingerprintOf(canonical) };
}

function build(set: PackSet): LinkedReferenceRules {
  const display = linkedPlanDisplay(set);
  const cutBodies = Object.keys(display.rules).filter((e) => {
    const r = display.rules[e];
    return r !== undefined && r.drawAs === "body" && r.cut;
  });
  return linkedReferenceRulesOf(set.items(LINKED_REFERENCE_POINT), cutBodies);
}

/** The linked reference rules of the set in force (built once per set). */
export function linkedReferenceRules(set: PackSet = activePackSet()): LinkedReferenceRules {
  return set.memo("kernel.linked_reference#rules", build);
}
