import { activeDrawnSource, anchorWords, loadAnchorOf, loadPointLabel, loadStatusOf, type BimElement, type ElementId, type LoadRecord } from "@permitzip/bim-kernel";
import { clip, feet } from "../format";
import type { RuleContext, RuleDef } from "../registry";

/**
 * Loads before and after they are drawn (KERNEL-REQUIREMENTS-MODEL §3.4): a load
 * typed on a space, a part or a row that names no source yet, a load whose
 * drawing disagrees with the source it names (or whose source, space or fixture
 * is gone), and a power load its panel can't serve at its voltage and poles.
 * Run-end loads written before anchors existed name no source, so the first rule
 * never fires on them; the Properties panel already explains a lost pipe.
 */

/** The tool that fixes a load rule's finding. */
export const LOAD_RULE_FIX = "bim_edit_load_point";

function isLoad(el: BimElement): el is LoadRecord {
  return el.kind === "load_point";
}

/** Where to point at a load: its fixture, its pipe, its space, or its point on the plan. */
export function loadRuleAt(ctx: RuleContext, lp: LoadRecord) {
  const els = ctx.model.elements;
  const a = loadAnchorOf(lp);
  const target = a.kind === "run_end" ? a.hostId : a.kind === "part" ? a.partId : a.kind === "space" || a.kind === "zone" ? a.id : (lp.attachedPartId ?? null);
  const el = target ? els[target] : undefined;
  if (a.kind === "point") {
    const level = els[a.levelId];
    return { level: level?.kind === "level" ? level.name : "", x_ft: feet(a.position.x), y_ft: feet(a.position.y), z_ft: 0 };
  }
  if (!el) return { level: "", x_ft: 0, y_ft: 0, z_ft: 0 };
  const body = ctx.body(el.id);
  const c = body ? { x: (body.box.min.x + body.box.max.x) / 2, y: (body.box.min.y + body.box.max.y) / 2, z: body.box.min.z } : { x: 0, y: 0, z: 0 };
  return { level: ctx.levelNameOf(el), x_ft: feet(c.x), y_ft: feet(c.y), z_ft: feet(c.z) };
}

function words(ctx: RuleContext, lp: LoadRecord): string {
  return `${loadPointLabel(ctx.model.elements, lp)} ${anchorWords(loadAnchorOf(lp), (id: ElementId) => ctx.name(id))}`;
}

export const requirementRules: readonly RuleDef[] = [
  {
    id: "load-unserved",
    version: 1,
    pack: "systems",
    severity: "info",
    title: "A load typed before it is drawn that names no source (panel, meter, heater, unit) yet",
    scope: "element",
    kinds: ["load_point"],
    run: (ctx, el) => {
      if (!isLoad(el) || !el.anchor || el.anchor.kind === "run_end" || el.servedBy) return;
      ctx.emit({
        rule: "load-unserved",
        severity: "info",
        elementIds: [el.id],
        at: loadRuleAt(ctx, el),
        message: clip(`${words(ctx, el)} has no source yet, so no panel, meter or heater counts it`),
        fix: { tool: LOAD_RULE_FIX, hint: "set served_by to the panel, meter, water heater or unit that serves it" },
      });
    },
  },
  {
    id: "load-status-mismatch",
    version: 1,
    pack: "systems",
    severity: "warning",
    title: "A load whose drawing disagrees with its source, or whose source, space or fixture was deleted",
    scope: "element",
    kinds: ["load_point"],
    run: (ctx, el) => {
      if (!isLoad(el)) return;
      const s = loadStatusOf(ctx.model.elements, el, activeDrawnSource());
      if (s.status !== "mismatch" || !s.why) return;
      const ids = [el.id, ...s.reads.filter((id) => ctx.model.elements[id] && id !== el.id)].filter((id, i, all) => all.indexOf(id) === i);
      ctx.emit({
        rule: "load-status-mismatch",
        severity: "warning",
        elementIds: ids,
        at: loadRuleAt(ctx, el),
        message: clip(`${loadPointLabel(ctx.model.elements, el)}: ${s.why}`),
        fix: { tool: LOAD_RULE_FIX, hint: "name the source it is really served from, or move it" },
      });
    },
  },
];
