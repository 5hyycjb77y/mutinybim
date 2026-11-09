/**
 * Responsible professionals, many-to-many and scoped (contract 1.5.0,
 * NEXT-BATCH-8 §8.2). Reserved in round 8 step 8a; lane M writes the rows,
 * acceptance and merge approvals.
 *
 * A responsibility is (person or firm, registered discipline, optional
 * scope). Several rows may name one discipline (two engineers on
 * one discipline, each for some systems), and one person may hold several
 * disciplines. A scope selects parts only through selectors the kernel
 * already has: systems, groups and typicals, levels and zones, sheets,
 * classes (with subclasses) and types, and schedule-style field filters.
 * No scope means the whole discipline. A row counts only once its person has
 * accepted it.
 *
 * The kernel holds the shape and the coverage rule; people, acceptance,
 * permissions and the project lead are the host's.
 */
import { disciplineAncestors } from "../disciplines/registry";
import type { ScheduleFilter } from "../schedules/definition";
import type { BimElement, ElementId } from "../types";

/** Peers that read and store `responsibility` records. Never advertised in round 8 step 8a. */
export const RESPONSIBILITY_FEATURE = "responsibility:records";

export interface ResponsibleParty {
  readonly kind: "person" | "firm";
  /** The host's id for the person or firm; opaque to the kernel. */
  readonly ref: string;
  /** What people read ("J. Rao", "Acme Fire Design"). */
  readonly label: string;
}

/** A zone on a level (the partition's `level` / `zone`). */
export interface ResponsibilityZone {
  readonly level: string;
  readonly zone: string;
}

/**
 * Which parts of a discipline a responsibility covers. Every listed selector
 * kind narrows (an element must match each kind that is listed); within a
 * kind, any listed value matches. An empty scope (or none) is the whole
 * discipline.
 */
export interface ResponsibilityScope {
  /** Networks or service kinds: an mep_system id, or a service id (`domestic_cold_water`, `vt.hoistway`). */
  readonly systems?: readonly string[];
  /** Organization groups (`groupId`) and typical ids. */
  readonly groups?: readonly string[];
  /** Level names (the partition's `level`). */
  readonly levels?: readonly string[];
  readonly zones?: readonly ResponsibilityZone[];
  /** Sheet (document) ids: an element shown in a view placed on the sheet. */
  readonly sheets?: readonly string[];
  /** Registry class ids; a class covers its subclasses. */
  readonly classes?: readonly string[];
  /** Element or part type ids. */
  readonly types?: readonly string[];
  /** Field filters, as schedules write them. */
  readonly where?: readonly ScheduleFilter[];
}

export interface Responsibility {
  readonly id: string;
  readonly party: ResponsibleParty;
  /** A registered discipline id; a parent covers its children unless a child has its own row. */
  readonly discipline: string;
  readonly scope?: ResponsibilityScope;
  /** When the person accepted. Absent: named, not yet accepted; the row covers nothing. */
  readonly acceptedAt?: string;
  /**
   * The approver set this row belongs to (8b): the people a firm entry names
   * for one discipline and scope approve under that entry's rule, `each`
   * (all of them) or `any_one`. Absent: the row approves on its own.
   */
  readonly approval?: { readonly group: string; readonly rule: ApprovalRule };
}

/**
 * How a discipline's overlapping responsibilities approve: each covering
 * row's person (`each`, the default), or any one of them (`any_one`, a firm
 * rule).
 */
export type ApprovalRule = "each" | "any_one";

/**
 * What coverage needs to know about an element beyond the record itself,
 * supplied by the caller from indexes it already has (the class index, the
 * network index, sheet membership, the field engine). Nothing here scans
 * the model.
 */
export interface CoverageContext {
  /** The element's stored discipline (its partition's). */
  disciplineOf(el: BimElement): string;
  classOf(el: BimElement): string | undefined;
  /** Whether `classId` is `ancestor` or one of its subclasses. */
  isA(classId: string, ancestor: string): boolean;
  /** The systems and service ids the element belongs to. */
  systemsOf(el: BimElement): readonly string[];
  /** The group and typical ids the element belongs to. */
  groupsOf(el: BimElement): readonly string[];
  /** Sheet ids the element appears on. */
  sheetsOf(el: BimElement): readonly string[];
  /** A field filter's verdict for the element. */
  matches(el: BimElement, filter: ScheduleFilter): boolean;
}

function typeIdOf(el: BimElement): string | undefined {
  if ("typeId" in el && typeof el.typeId === "string") return el.typeId;
  return undefined;
}

function anyOf<T>(list: readonly T[] | undefined, test: (v: T) => boolean): boolean {
  return list === undefined || list.length === 0 || list.some(test);
}

/** Whether a scope selects the element (an absent or empty scope selects every element of the discipline). */
export function scopeSelects(scope: ResponsibilityScope | undefined, el: BimElement, ctx: CoverageContext): boolean {
  if (!scope) return true;
  const p = el.partition;
  if (!anyOf(scope.levels, (l) => p?.level === l)) return false;
  if (!anyOf(scope.zones, (z) => p?.level === z.level && p.zone === z.zone)) return false;
  if (scope.classes && scope.classes.length > 0) {
    const cls = ctx.classOf(el);
    if (!cls || !scope.classes.some((c) => ctx.isA(cls, c))) return false;
  }
  if (!anyOf(scope.types, (t) => typeIdOf(el) === t)) return false;
  if (scope.systems && scope.systems.length > 0) {
    const systems = ctx.systemsOf(el);
    if (!scope.systems.some((s) => systems.includes(s))) return false;
  }
  if (scope.groups && scope.groups.length > 0) {
    const groups = ctx.groupsOf(el);
    if (!scope.groups.some((g) => groups.includes(g))) return false;
  }
  if (scope.sheets && scope.sheets.length > 0) {
    const sheets = ctx.sheetsOf(el);
    if (!scope.sheets.some((s) => sheets.includes(s))) return false;
  }
  return (scope.where ?? []).every((f) => ctx.matches(el, f));
}

function isUnscoped(scope: ResponsibilityScope | undefined): boolean {
  return !scope || Object.values(scope).every((v) => !Array.isArray(v) || v.length === 0);
}

/** Who approves one changed element. `fallback`: no accepted scoped row covered it. */
export interface ElementCoverage {
  readonly elementId: ElementId;
  readonly discipline: string;
  /** Accepted rows whose scope covers the element (the discipline's own rows, else its nearest ancestor's). */
  readonly covering: readonly Responsibility[];
  /**
   * `null`: covered. `discipline_default`: no scoped row covered it; the
   * discipline's unscoped rows approve. `project_lead`: no accepted row at all;
   * the host's project lead approves, shown plainly.
   */
  readonly fallback: null | "discipline_default" | "project_lead";
}

/**
 * Coverage for a changed set: for each element, the accepted responsibilities
 * of its discipline whose scope covers it. A child discipline with rows of
 * its own is covered by those rows only; one without falls to its nearest
 * ancestor with rows. Cost: per element, the rows of its discipline chain.
 */
export function coveringResponsibilities(changed: readonly BimElement[], rows: readonly Responsibility[], ctx: CoverageContext): ElementCoverage[] {
  const accepted = new Map<string, Responsibility[]>();
  for (const r of rows) {
    if (r.acceptedAt === undefined) continue;
    const list = accepted.get(r.discipline) ?? [];
    list.push(r);
    accepted.set(r.discipline, list);
  }
  const out: ElementCoverage[] = [];
  for (const el of changed) {
    const discipline = ctx.disciplineOf(el);
    // The nearest discipline in the chain (itself first) that has any accepted row.
    const owner = [discipline, ...disciplineAncestors(discipline)].find((d) => accepted.has(d));
    const own = owner ? (accepted.get(owner) ?? []) : [];
    const scoped = own.filter((r) => !isUnscoped(r.scope) && scopeSelects(r.scope, el, ctx));
    if (scoped.length > 0) {
      out.push({ elementId: el.id, discipline, covering: scoped, fallback: null });
      continue;
    }
    const unscoped = own.filter((r) => isUnscoped(r.scope));
    out.push(unscoped.length > 0 ? { elementId: el.id, discipline, covering: unscoped, fallback: "discipline_default" } : { elementId: el.id, discipline, covering: [], fallback: "project_lead" });
  }
  return out;
}

/**
 * One approval a merge needs: any one of `anyOf` approving satisfies it.
 * Under `each`, every covering row is its own approval; under `any_one`,
 * the covering rows of one element form one approval. `projectLead`: no one
 * is named for these elements, so the host's project lead approves them.
 */
export interface RequiredApproval {
  readonly discipline: string;
  readonly anyOf: readonly Responsibility[];
  readonly projectLead: boolean;
  readonly elementIds: readonly ElementId[];
}

/** The approvals a changed set needs, grouped so each person or "any one of" set appears once. `ruleFor`: the firm's rule per discipline (default `each`). */
export function requiredApprovals(coverage: readonly ElementCoverage[], ruleFor: (discipline: string) => ApprovalRule = () => "each"): RequiredApproval[] {
  const byKey = new Map<string, { discipline: string; anyOf: readonly Responsibility[]; projectLead: boolean; elementIds: ElementId[] }>();
  const add = (key: string, discipline: string, anyOf: readonly Responsibility[], projectLead: boolean, id: ElementId) => {
    const hit = byKey.get(key);
    if (hit) hit.elementIds.push(id);
    else byKey.set(key, { discipline, anyOf, projectLead, elementIds: [id] });
  };
  for (const c of coverage) {
    if (c.fallback === "project_lead") {
      add(`lead|${c.discipline}`, c.discipline, [], true, c.elementId);
      continue;
    }
    if (ruleFor(c.discipline) === "any_one") {
      const ids = c.covering.map((r) => r.id).sort();
      add(`any|${c.discipline}|${ids.join(",")}`, c.discipline, c.covering, false, c.elementId);
    } else for (const r of c.covering) add(`each|${r.id}`, c.discipline, [r], false, c.elementId);
  }
  return [...byKey.values()];
}
