import { elementIntegrityIssues, type BimElement, type ElementKind, type ConnectorIntegrityCheck, type ConnectorIntegrityIssue, type RunPoint } from "@permitzip/bim-kernel";
import { p3 } from "../geometry/convex";
import { clip, feet } from "./format";
import type { RuleContext, RuleDef } from "./registry";

/**
 * Connector integrity (round 9 J9): ends that touch but aren't joined, a
 * joined pair whose openings differ in shape or size, end types that don't
 * join, and a part joined to a part on another system. The kernel decides
 * (connections/integrity.ts; end types are the add-ons' rows); these rules
 * only report. Each is a warning on the Checklist and never refuses an edit;
 * a firm that wants one to stop work turns it on as an issue rule.
 *
 * The edit-time pass reads only the ends an edit can have changed (`inEdit`):
 * an open end looks for others through the lint grid within a few millimetres.
 */

/** One computation per element per model state, shared by the four rules. */
const perModel = new WeakMap<object, Map<string, readonly ConnectorIntegrityIssue[]>>();

function issuesOf(ctx: RuleContext, el: BimElement): readonly ConnectorIntegrityIssue[] {
  let byId = perModel.get(ctx.model.elements);
  if (!byId) {
    byId = new Map();
    perModel.set(ctx.model.elements, byId);
  }
  const known = byId.get(el.id);
  if (known) return known;
  const near = (at: RunPoint, radius: number): string[] => {
    const r = radius + 1;
    const ids: string[] = [];
    for (const b of ctx.bodiesNear({ min: p3(at.x - r, at.y - r, at.z - r), max: p3(at.x + r, at.y + r, at.z + r) })) if (b.elementId !== null) ids.push(b.elementId);
    return ids;
  };
  let found: readonly ConnectorIntegrityIssue[];
  try {
    found = elementIntegrityIssues(ctx.model.elements, el, near);
  } catch (err) {
    console.error("[bim-lint] connector integrity could not be checked for an element", { elementId: el.id, err });
    found = [];
  }
  byId.set(el.id, found);
  return found;
}

/** On an edit, only ends the edit can have moved or retyped: the changed elements, parts of a changed type, and what links to a changed element. A full check reads every end. */
function inEdit(ctx: RuleContext, el: BimElement): boolean {
  if (ctx.changed.size === 0 || ctx.changed.has(el.id)) return true;
  if (el.kind === "part") return ctx.changed.has(el.typeId) || Object.values(el.links ?? {}).some((l) => ctx.changed.has(l.elementId));
  if (el.kind === "run_segment") return [el.links.start, el.links.end].some((l) => l !== undefined && ctx.changed.has(l.elementId));
  if (el.kind === "run_fitting") return el.ports.some((p) => p.link !== undefined && ctx.changed.has(p.link.elementId));
  return false;
}

function emitAll(ctx: RuleContext, el: BimElement, rule: string, checks: readonly ConnectorIntegrityCheck[]): void {
  if (!inEdit(ctx, el)) return;
  for (const issue of issuesOf(ctx, el)) {
    if (!checks.includes(issue.check)) continue;
    const ids = issue.elementIds.filter((id) => ctx.model.elements[id] !== undefined);
    ctx.emit({
      rule,
      severity: "warning",
      elementIds: ids.length > 0 ? ids : [el.id],
      at: { level: ctx.levelNameOf(el), x_ft: feet(issue.at.x), y_ft: feet(issue.at.y), z_ft: feet(issue.at.z) },
      message: clip(`${issue.message}. ${issue.nextStep}`),
    });
  }
}

const KINDS: readonly ElementKind[] = ["part", "run_segment", "run_fitting"];

export const connectorRules: readonly RuleDef[] = [
  {
    id: "connector-touching-not-joined",
    version: 1,
    pack: "systems",
    severity: "warning",
    title: "Two open ends that touch and face each other but aren't joined",
    scope: "element",
    kinds: KINDS,
    reads: ["part_type"],
    run: (ctx, el) => emitAll(ctx, el, "connector-touching-not-joined", ["touching_not_joined"]),
  },
  {
    id: "connector-shape-size-mismatch",
    version: 1,
    pack: "systems",
    severity: "warning",
    title: "Two joined parts whose openings differ in shape or size, with no transition",
    scope: "element",
    kinds: ["part"],
    reads: ["part_type"],
    run: (ctx, el) => emitAll(ctx, el, "connector-shape-size-mismatch", ["shape_mismatch", "size_mismatch"]),
  },
  {
    id: "connector-end-type-mismatch",
    version: 1,
    pack: "systems",
    severity: "warning",
    title: "Joined ends whose end types don't join, or join only with a fitting that isn't there",
    scope: "element",
    kinds: KINDS,
    reads: ["part_type"],
    run: (ctx, el) => emitAll(ctx, el, "connector-end-type-mismatch", ["end_type_mismatch"]),
  },
  {
    id: "connector-service-mismatch",
    version: 1,
    pack: "systems",
    severity: "warning",
    title: "A part joined to a part on another system (supply joined to return)",
    scope: "element",
    kinds: ["part"],
    reads: ["part_type"],
    run: (ctx, el) => emitAll(ctx, el, "connector-service-mismatch", ["service_mismatch"]),
  },
];
