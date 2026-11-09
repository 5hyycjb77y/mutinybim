import { resolveConnectors, routingIssues, type BimElement, type RunIssue } from "@permitzip/bim-kernel";
import { partPrimitives } from "../../shapes";
import { clip, feet } from "../format";
import type { RuleContext, RuleDef } from "../registry";

/**
 * Network and value checks: a duct system with no terminals (bug log #13),
 * terminals with no airflow (#12), the kernel's own routing issues named
 * near the edit (#18), values outside any plausible range (#2, #17), and a
 * part whose geometry draws nothing (#20).
 */

const MM_PER_IN = 25.4;
const MM_PER_FT = 304.8;
const TWO_MILES_MM = 2 * 5280 * MM_PER_FT;

function linkedPartIds(ctx: RuleContext, runIds: readonly string[]): string[] {
  const out = new Set<string>();
  const els = ctx.model.elements;
  for (const id of runIds) {
    const el = els[id];
    if (!el) continue;
    const refs = el.kind === "run_segment" ? [el.links.start, el.links.end] : el.kind === "run_fitting" ? el.ports.map((p) => p.link) : [];
    for (const r of refs) if (r && els[r.elementId]?.kind === "part") out.add(r.elementId);
  }
  return [...out].sort();
}

function atOf(ctx: RuleContext, el: BimElement) {
  const body = ctx.body(el.id);
  const c = body ? { x: (body.box.min.x + body.box.max.x) / 2, y: (body.box.min.y + body.box.max.y) / 2, z: body.box.min.z } : { x: 0, y: 0, z: 0 };
  return { level: ctx.levelNameOf(el), x_ft: feet(c.x), y_ft: feet(c.y), z_ft: feet(c.z) };
}

export const systemRules: readonly RuleDef[] = [
  {
    id: "system-without-terminals",
    version: 1,
    pack: "systems",
    severity: "warning",
    title: "A duct system with equipment but no terminals (its CFM and pressure aren't meaningful)",
    scope: "system",
    kinds: ["mep_system"],
    run: (ctx, el) => {
      if (el.kind !== "mep_system" || el.domain !== "duct") return;
      const runs = ctx.systemMembers(el.id);
      if (runs.length === 0) return;
      const parts = linkedPartIds(ctx, runs);
      const categories = parts.map((id) => {
        const p = ctx.model.elements[id];
        const t = p?.kind === "part" ? ctx.model.elements[p.typeId] : undefined;
        return t?.kind === "part_type" ? t.definition.category : null;
      });
      if (!categories.includes("mechanical_equipment") || categories.includes("air_terminal")) return;
      const equipment = parts.filter((_, i) => categories[i] === "mechanical_equipment");
      const first = runs[0] as string;
      const firstEl = ctx.model.elements[first];
      ctx.emit({
        rule: "system-without-terminals",
        severity: "warning",
        elementIds: [el.id, ...equipment],
        at: firstEl ? atOf(ctx, firstEl) : { level: "", x_ft: 0, y_ft: 0, z_ft: 0 },
        message: clip(`${el.name} serves ${equipment.map((id) => ctx.name(id)).join(", ")} but reaches no air terminals; its CFM and pressure aren't meaningful`),
        fix: { tool: "bim_route_run", hint: `route ${el.name} on to its diffusers or grilles` },
      });
    },
  },
  {
    id: "zero-flow-terminal",
    version: 1,
    pack: "systems",
    severity: "warning",
    title: "An air terminal with no airflow",
    scope: "element",
    kinds: ["part"],
    run: (ctx, el) => {
      if (el.kind !== "part") return;
      const type = ctx.model.elements[el.typeId];
      if (type?.kind !== "part_type" || type.definition.category !== "air_terminal") return;
      let connectors;
      try {
        connectors = resolveConnectors(type.definition, el.values).filter((c) => c.domain === "duct");
      } catch (err) {
        console.error("[bim-lint] a terminal's connectors could not be resolved", { partId: el.id, err });
        return;
      }
      if (connectors.length === 0 || connectors.some((c) => (c.flow ?? 0) > 0)) return;
      const name = ctx.name(el.id);
      ctx.emit({ rule: "zero-flow-terminal", severity: "warning", elementIds: [el.id], at: atOf(ctx, el), message: clip(`${name} has 0 CFM`), fix: { tool: "bim_set_terminal_airflow", hint: `give ${name} its design airflow` } });
    },
  },
  {
    id: "open-validation-issue",
    version: 1,
    pack: "systems",
    severity: "warning",
    title: "An open validation issue near the edit (it can block later saves that touch it)",
    scope: "element",
    kinds: ["run_segment", "run_fitting", "part"],
    run: (ctx, el) => {
      const issues: RunIssue[] = [];
      routingIssues(ctx.model.elements, el, ctx.model.settings, issues);
      for (const issue of issues) {
        const ids = issue.elementIds.filter((id) => ctx.model.elements[id] !== undefined);
        ctx.emit({
          rule: "open-validation-issue",
          severity: "warning",
          elementIds: ids.length > 0 ? ids : [el.id],
          at: atOf(ctx, el),
          message: clip(`Open issue: ${issue.message}`),
          fix: { tool: "bim_validation_issues", hint: "fix this before editing what it touches" },
        });
      }
    },
  },
  {
    id: "unit-sanity",
    version: 1,
    pack: "systems",
    severity: "warning",
    title: "A value outside any plausible range for its kind (often a unit mix-up)",
    scope: "element",
    kinds: ["run_segment", "part", "view"],
    run: (ctx, el) => {
      const emit = (message: string, hint: string, tool: string) => ctx.emit({ rule: "unit-sanity", severity: "warning", elementIds: [el.id], at: atOf(ctx, el), message: clip(message), fix: { tool, hint } });
      if (el.kind === "run_segment" && el.domain === "duct" && (el.size.shape === "rect" || el.size.shape === "oval" || el.size.shape === "round")) {
        const w = el.size.shape === "round" ? el.size.diameter : el.size.width;
        const h = el.size.shape === "round" ? el.size.diameter : el.size.height;
        if (Math.max(w, h) > 120 * MM_PER_IN) emit(`${ctx.name(el.id)} is ${Math.round(Math.max(w, h) / MM_PER_IN)} in. across, more than any duct (inches vs mm?)`, "check the size units", "bim_resize_run");
      }
      if (el.kind === "run_segment") {
        const l = Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y, el.end.z - el.start.z);
        if (l > TWO_MILES_MM) emit(`${ctx.name(el.id)} is ${Math.round(l / MM_PER_FT)} ft long (feet vs mm?)`, "check the points' units", "bim_drag_run");
      }
      if (el.kind === "part" && (el.offsetMm > 1000 * MM_PER_FT || el.offsetMm < -200 * MM_PER_FT)) {
        emit(`${ctx.name(el.id)} sits ${Math.round(el.offsetMm / MM_PER_FT)} ft from its level (feet vs mm?)`, "check the height's units", "bim_set_parameters");
      }
      if (el.kind === "view" && !el.deleted && el.viewType !== "schedule" && el.viewType !== "three_d") {
        const w = el.cropMax.x - el.cropMin.x;
        const h = el.cropMax.y - el.cropMin.y;
        if (Math.min(w, h) < MM_PER_FT || Math.max(w, h) > TWO_MILES_MM) {
          emit(`View ${el.name}'s crop is ${feet(w)} x ${feet(h)} ft (crops are in mm in batch edits)`, "set the crop in feet with bim_set_view_crop", "bim_preview_views_sheets_edit");
        } else if (ctx.previous) {
          const before = ctx.previous.elements[el.id];
          if (before?.kind === "view") {
            const size = Math.max(before.cropMax.x - before.cropMin.x, before.cropMax.y - before.cropMin.y, 1);
            const moved = Math.hypot(el.cropMin.x - before.cropMin.x, el.cropMin.y - before.cropMin.y);
            if (moved > 100 * size) emit(`View ${el.name}'s crop moved ${feet(moved)} ft, 100x its size (unit mix-up?)`, "check the crop's units", "bim_preview_views_sheets_edit");
          }
        }
      }
    },
  },
  {
    id: "part-draws-nothing",
    version: 1,
    pack: "systems",
    severity: "error",
    title: "A part whose geometry doesn't resolve or draws nothing in 3D and print",
    scope: "element",
    kinds: ["part"],
    run: (ctx, el) => {
      if (el.kind !== "part") return;
      const type = ctx.model.elements[el.typeId];
      if (type?.kind !== "part_type") return;
      const name = ctx.name(el.id);
      const resolved = partPrimitives(type, el);
      if ("error" in resolved) {
        ctx.emit({ rule: "part-draws-nothing", severity: "error", elementIds: [el.id], at: atOf(ctx, el), message: clip(`${name} draws nothing: its geometry doesn't resolve (${resolved.error})`), fix: { tool: "bim_check_part_definition", hint: "check every size row of its part type" } });
        return;
      }
      const solid = resolved.prims.some((p) => (p.kind === "box" ? p.size.every((v) => v > 0) : p.kind === "cylinder" ? p.radius > 0 && p.height > 0 : p.profile.length >= 3 && p.height > 0));
      if (solid) return;
      const symbol = type.definition.symbol.length > 0;
      ctx.emit({
        rule: "part-draws-nothing",
        severity: symbol ? "warning" : "error",
        elementIds: [el.id],
        at: atOf(ctx, el),
        message: clip(symbol ? `${name} has a plan symbol but no solid: it draws nothing in 3D, sections or clash checks` : `${name} draws nothing: its part type has no solid and no plan symbol`),
        fix: { tool: "bim_check_part_definition", hint: "give its part type a solid (features or geometry)" },
      });
    },
  },
];
