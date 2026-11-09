import { ipcTables } from "@permitzip/bim-calc";
import { questionsOnElements, type BimElement } from "@permitzip/bim-kernel";
import { dfuAtSewerConnection, floorsAgainstSewer, gravityDrainCapacity, sewagePumpCheck, smallestGravityDrain, type GravityCapacityTable } from "../drainage/gravity";
import { indirectWasteSolidJoints } from "../drainage/indirect";
import { drainageRoleOf, sewerConnectionOf } from "../drainage/read";
import { drainOverDrainageUnits } from "../drainage/walk";
import { outfallWalkFindingsAt, type OutfallWalkFindingCode } from "../drainage/outfall";
import { clip, feet, feetInches, type RuleContext, type RuleDef } from "@permitzip/bim-lint";

/**
 * Building sewer checks (ROADMAP P4 / P5). A part plays a drainage role when its
 * type carries `drainage_role` (sewer connection, sewage pump, backwater valve;
 * see bim-kernel/src/drainage/types.ts), so these rules run on those parts only
 * and say nothing on a model without them.
 *
 *   sewer-floor-needs-pump        a floor below what drains to the sewer by gravity (IPC 712.1)
 *   sewer-floor-needs-backwater   a floor below the next upstream manhole cover (IPC 715.1)
 *   sewer-floor-through-backwater a floor above the cover that drains through a backwater valve (715.1)
 *   building-drain-over-capacity  fixture units at the connection beyond the drain's size and slope (Table 710.1(1))
 *   sewer-elevation-unverified    an assumed or field-verify invert with no question asking for it
 *   sewage-pump-inflow-unknown    a pump with no inflow, head or rating typed (fixture units become a flow only through a cited firm flow table, on the pump sheet)
 *   drain-over-drainage-units     a drawn drain carrying more drainage units than the firm's table allows at its size and slope
 *   sewage-pump-undersized        a pump rated below the inflow or head typed for it (712.4.2)
 *   indirect-waste-no-air-gap     an indirect waste line joined solid to a floor sink or a drain, with no air gap (IPC 802.2)
 *
 * Floors use their floor as the flood-level rim and the drain's depth below the
 * floor from the connection (absent: 0): exact for floor drains, conservative for
 * a lavatory. Code tables come from the plumbing pack (VPC / IPC 2021).
 */

const SEWER_WALK_SEVERITY: Readonly<Record<OutfallWalkFindingCode, "error" | "warning" | "info">> = {
  no_outfall: "info",
  invert_missing: "info",
  rim_missing: "info",
  below_invert: "error",
  runs_uphill: "error",
  backwater_required: "warning",
};

const BUILDING_DRAIN: GravityCapacityTable = { rows: ipcTables.TABLE_710_1_1, slopes: ipcTables.TABLE_710_1_1_SLOPES };

function leastSlope(nominalIn: number): number {
  return ipcTables.TABLE_704_1.find((b) => nominalIn <= b.maxNominalIn + 1e-9)?.inPerFt ?? 0.0625;
}

const slopeText = (s: number) => (s === 0.0625 ? '1/16"' : s === 0.125 ? '1/8"' : s === 0.25 ? '1/4"' : s === 0.5 ? '1/2"' : `${Math.round(s * 1000) / 1000}"`);
const loads = (n: number) => `${n} drainage load${n === 1 ? "" : "s"}`;

function atPart(ctx: RuleContext, el: BimElement, levelName?: string) {
  const body = ctx.body(el.id);
  const c = body ? { x: (body.box.min.x + body.box.max.x) / 2, y: (body.box.min.y + body.box.max.y) / 2, z: body.box.min.z } : { x: 0, y: 0, z: 0 };
  return { level: levelName ?? ctx.levelNameOf(el), x_ft: feet(c.x), y_ft: feet(c.y), z_ft: feet(c.z) };
}

function isRole(ctx: RuleContext, el: BimElement, role: "sewer_connection" | "sewage_pump"): boolean {
  // A sewer connection is any registered kind (`SEWER_NODE_POINT`: the built-in part role, or an add-on's manhole).
  if (role === "sewer_connection") return sewerConnectionOf(ctx.model.elements, el.id) !== null;
  return drainageRoleOf(ctx.model.elements, el) === role;
}

export const drainageRules: readonly RuleDef[] = [
  {
    id: "sewer-floor-needs-pump",
    version: 1,
    pack: "systems",
    severity: "error",
    title: "A floor with drains below what can reach the sewer by gravity, with no sewage pump",
    scope: "element",
    kinds: ["part"],
    run: (ctx, el) => {
      if (!isRole(ctx, el, "sewer_connection")) return;
      const conn = sewerConnectionOf(ctx.model.elements, el.id);
      if (!conn || conn.invertMm === null) return;
      for (const f of floorsAgainstSewer(ctx.model.elements, conn)) {
        if (f.needPump.length === 0) continue;
        ctx.emit({
          rule: "sewer-floor-needs-pump",
          severity: "error",
          elementIds: [el.id, f.levelId],
          at: atPart(ctx, el, f.levelName),
          message: clip(`${f.levelName} (floor ${feetInches(f.floorMm)}) is below the sewer at ${conn.label} (invert ${feetInches(conn.invertMm)}): ${loads(f.needPump.length)} can't drain by gravity and need a sewage pump (IPC 712.1)`),
          fix: { tool: "bim_edit_load_point", hint: clip(`name a sewage pump as their source (served_by); if ${conn.label}'s invert is wrong, correct it with bim_set_parameters`, 120) },
        });
      }
    },
  },
  {
    id: "sewer-floor-needs-backwater",
    version: 1,
    pack: "systems",
    severity: "warning",
    title: "A floor with drains below the next upstream manhole cover, with no backwater valve",
    scope: "element",
    kinds: ["part"],
    run: (ctx, el) => {
      if (!isRole(ctx, el, "sewer_connection")) return;
      const conn = sewerConnectionOf(ctx.model.elements, el.id);
      if (!conn || conn.rimMm === null) return;
      for (const f of floorsAgainstSewer(ctx.model.elements, conn)) {
        if (f.needValve.length === 0) continue;
        ctx.emit({
          rule: "sewer-floor-needs-backwater",
          severity: "warning",
          elementIds: [el.id, f.levelId],
          at: atPart(ctx, el, f.levelName),
          message: clip(`${f.levelName} (floor ${feetInches(f.floorMm)}) is below the manhole cover at ${conn.label} (${feetInches(conn.rimMm)}): ${loads(f.needValve.length)} need a backwater valve (IPC 715.1)`),
          fix: { tool: "bim_edit_load_point", hint: "name a backwater valve, or a sewage pump that has one, as their source (served_by)" },
        });
      }
    },
  },
  {
    id: "sewer-floor-through-backwater",
    version: 1,
    pack: "systems",
    severity: "info",
    title: "A floor above the manhole cover that drains through a backwater valve",
    scope: "element",
    kinds: ["part"],
    run: (ctx, el) => {
      if (!isRole(ctx, el, "sewer_connection")) return;
      const conn = sewerConnectionOf(ctx.model.elements, el.id);
      if (!conn || conn.rimMm === null) return;
      for (const f of floorsAgainstSewer(ctx.model.elements, conn)) {
        if (f.throughValveAboveRim.length === 0) continue;
        ctx.emit({
          rule: "sewer-floor-through-backwater",
          severity: "info",
          elementIds: [el.id, f.levelId],
          at: atPart(ctx, el, f.levelName),
          message: clip(`${f.levelName} is above the manhole cover at ${conn.label}, so its ${loads(f.throughValveAboveRim.length)} should not drain through a backwater valve (IPC 715.1)`),
          fix: { tool: "bim_edit_load_point", hint: "serve them from the building drain past the valve instead (served_by)" },
        });
      }
    },
  },
  {
    id: "building-drain-over-capacity",
    version: 1,
    pack: "systems",
    severity: "error",
    title: "More fixture units reach the sewer than the building drain carries at its size and slope",
    scope: "element",
    kinds: ["part"],
    run: (ctx, el) => {
      if (!isRole(ctx, el, "sewer_connection")) return;
      const els = ctx.model.elements;
      const conn = sewerConnectionOf(els, el.id);
      const size = conn?.drain.nominalIn ?? null;
      if (!conn || size === null) return;
      const slope = conn.drain.slopeInPerFt ?? leastSlope(size);
      const at = dfuAtSewerConnection(els, conn.id);
      if (at.dfu <= 0) return;
      const cap = gravityDrainCapacity(BUILDING_DRAIN, size, slope);
      if (cap.maxDfu !== null && cap.maxDfu >= at.dfu - 1e-9) return;
      const dfu = Math.round(at.dfu * 100) / 100;
      const carries = cap.maxDfu === null ? "that size isn't permitted at that slope" : `that size carries ${cap.maxDfu} at that slope`;
      const bigger = smallestGravityDrain(BUILDING_DRAIN, at.dfu, slope, 3);
      ctx.emit({
        rule: "building-drain-over-capacity",
        severity: "error",
        elementIds: [el.id],
        at: atPart(ctx, el),
        message: clip(`${dfu} DFU (${at.basis === "whole_building" ? "whole building" : `loads naming ${conn.label}`}) on a ${size}" drain at ${slopeText(slope)}/ft; ${carries} (IPC Table 710.1(1))`),
        fix: { tool: "bim_set_parameters", hint: clip(`set building_drain_size_in on ${conn.label}${bigger ? ` (${bigger.nominalIn}" carries ${bigger.maxDfu})` : ""} or a steeper slope, then resize the drawn drain`, 120) },
      });
    },
  },
  {
    id: "sewer-elevation-unverified",
    version: 1,
    pack: "systems",
    severity: "info",
    title: "A sewer invert or rim taken as assumed or to be field verified, with no question asking for it",
    scope: "element",
    kinds: ["part"],
    run: (ctx, el) => {
      if (!isRole(ctx, el, "sewer_connection")) return;
      const els = ctx.model.elements;
      const conn = sewerConnectionOf(els, el.id);
      if (!conn || conn.confidence === "verified" || (conn.invertMm === null && conn.rimMm === null)) return;
      if (questionsOnElements(els, [conn.id]).some((q) => q.status !== "withdrawn")) return;
      const what = conn.invertMm !== null && conn.rimMm !== null ? "invert and rim are" : conn.invertMm !== null ? "invert is" : "rim is";
      ctx.emit({
        rule: "sewer-elevation-unverified",
        severity: "info",
        elementIds: [el.id],
        at: atPart(ctx, el),
        message: clip(`${conn.label}'s ${what} ${conn.confidence === "field_verify" ? "to be verified in the field" : "assumed"}, and no question asks the contractor to verify ${what.endsWith("are") ? "them" : "it"}`),
        fix: { tool: "bim_set_parameters", hint: "add a question on it in the Questions panel, or set elevation_confidence to verified once measured" },
      });
    },
  },
  {
    id: "sewage-pump-inflow-unknown",
    version: 1,
    pack: "systems",
    severity: "warning",
    title: "A sewage pump that can't be checked: no inflow in gpm, head or rating typed",
    scope: "element",
    kinds: ["part"],
    run: (ctx, el) => {
      if (!isRole(ctx, el, "sewage_pump")) return;
      const c = sewagePumpCheck(ctx.model.elements, el.id);
      if (!c || c.verdict.kind === "ok" || c.verdict.kind === "undersized") return;
      const draining = c.loads > 0 ? `${Math.round(c.dfu * 100) / 100} DFU drain to it. ` : "";
      const message =
        c.verdict.kind === "inflow_unknown"
          ? `${c.label}: ${draining}Can't check this pump yet: add a flow table (the firm's, with its source) or type the inflow in gpm`
          : c.verdict.kind === "head_unknown"
            ? `${c.label}: enter the total head it lifts against, in feet`
            : `${c.label}: enter its rated ${c.verdict.missing.join(" and ")} from its curve or cut sheet`;
      ctx.emit({
        rule: "sewage-pump-inflow-unknown",
        severity: "warning",
        elementIds: [el.id],
        at: atPart(ctx, el),
        message: clip(message),
        fix: { tool: "bim_set_parameters", hint: "set pump_inflow_gpm, pump_head_ft, pump_rated_gpm and pump_rated_head_ft" },
      });
    },
  },
  {
    id: "sewage-pump-undersized",
    version: 1,
    pack: "systems",
    severity: "error",
    title: "A sewage pump rated below the inflow or head it must handle",
    scope: "element",
    kinds: ["part"],
    run: (ctx, el) => {
      if (!isRole(ctx, el, "sewage_pump")) return;
      const els = ctx.model.elements;
      const c = sewagePumpCheck(els, el.id);
      if (!c || c.verdict.kind !== "undersized") return;
      const v = c.verdict;
      const parts: string[] = [];
      if (!v.flow.ok) parts.push(`${Math.round(-v.flow.spare * 10) / 10} gpm short of the inflow`);
      if (!v.head.ok) parts.push(`${Math.round(-v.head.spare * 10) / 10} ft short of the head`);
      ctx.emit({
        rule: "sewage-pump-undersized",
        severity: "error",
        elementIds: [el.id],
        at: atPart(ctx, el),
        message: clip(`${c.label} is rated ${parts.join(" and ")} (IPC 712.4.2)`),
        fix: { tool: "bim_set_parameters", hint: "pick a pump whose rated flow and head cover the inflow, and set its rating" },
      });
    },
  },
  {
    id: "drain-over-drainage-units",
    version: 1,
    pack: "systems",
    severity: "error",
    title: "A drawn drain carrying more drainage units than the firm's table allows at its size and slope",
    scope: "element",
    kinds: ["run_segment"],
    run: (ctx, el) => {
      if (el.kind !== "run_segment" || el.domain !== "pipe") return;
      const over = drainOverDrainageUnits(ctx.model.elements, el.id);
      if (!over) return;
      ctx.emit({
        rule: "drain-over-drainage-units",
        severity: "error",
        elementIds: [el.id],
        at: { level: ctx.levelNameOf(el), x_ft: feet(el.start.x), y_ft: feet(el.start.y), z_ft: feet(el.start.z) },
        message: clip(`${over.dfu} drainage units, over ${over.maxDfu} for ${over.nominalIn} in at ${over.slopeText} per ft (the firm's drain capacity table)`),
        fix: { tool: "bim_resize_run", hint: "make this drain larger, or steeper if its size must stay" },
      });
    },
  },
  {
    id: "sewer-walk",
    version: 1,
    pack: "systems",
    severity: "error",
    title: "A drawn drain that can't reach the sewer connection by gravity, or needs a backwater valve on the way",
    scope: "element",
    kinds: ["part"],
    reads: ["run_segment", "run_fitting", "level"],
    run: (ctx, el) => {
      if (!isRole(ctx, el, "sewer_connection")) return;
      for (const f of outfallWalkFindingsAt(ctx.model, el.id)) {
        ctx.emit({
          rule: "sewer-walk",
          severity: SEWER_WALK_SEVERITY[f.code],
          elementIds: [...f.selectIds, ...(f.selectIds.includes(el.id) ? [] : [el.id])],
          at: atPart(ctx, el),
          message: clip(f.message),
          fix: f.fix
            ? { tool: "bim_place_part", hint: clip(`${f.fix.label}: the starter ${f.fix.places === "ejector" ? "sewage ejector" : "backwater valve"} on pipe ${f.fix.at}, then connect it`, 120) }
            : { tool: "bim_set_parameters", hint: f.code === "runs_uphill" ? "slope the pipe down toward the sewer connection (bim_set_slope)" : `type ${el.id}'s ${f.code === "rim_missing" ? "rim (upstream manhole cover)" : "invert"} in Properties` },
        });
      }
    },
  },
  {
    id: "indirect-waste-no-air-gap",
    version: 1,
    pack: "systems",
    severity: "error",
    title: "An indirect waste line joined solid to a floor sink or drain, with no air gap or air break",
    scope: "element",
    kinds: ["run_segment"],
    run: (ctx, el) => {
      if (el.kind !== "run_segment") return;
      const els = ctx.model.elements;
      for (const j of indirectWasteSolidJoints(els, el)) {
        const system = els[el.systemId];
        const line = system?.kind === "mep_system" ? system.name : "This indirect waste line";
        const to = els[j.toId];
        const target = j.to === "receptor" && to?.kind === "part" ? `${to.mark.trim() || to.id}'s ${(j.connectorLabel ?? j.connector ?? "drain").toLowerCase()} connection` : "a drain pipe";
        ctx.emit({
          rule: "indirect-waste-no-air-gap",
          severity: "error",
          elementIds: [el.id, j.toId],
          at: atPart(ctx, el),
          message: clip(`${line} is piped straight into ${target}: no air gap. Indirect waste needs an air gap or air break (IPC 802.2)`),
          fix: { tool: "bim_route_run", hint: "disconnect the indirect waste end and leave it open above the floor sink rim (air gap at least twice the pipe's diameter)" },
        });
      }
    },
  },
];
