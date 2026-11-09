import {
  buildSheetSceneFor,
  documentIndex,
  evaluateSchedule,
  normalizeLevelName,
  scheduleEmptyRow,
  sheetPaper,
  viewLevelNames,
  type BimElement,
  type ModelState,
  type Sheet,
  type ViewElement,
  type Viewport,
} from "@permitzip/bim-kernel";
import { p3 } from "../../geometry/convex";
import { clip } from "../format";
import type { RuleDef } from "../registry";

/**
 * Drawing and sheet checks: what prints must be the project's real data and
 * show something (bug log #1, #6, #7, #10), viewports stay on the paper, and
 * an agent doesn't quietly change a person's own working view.
 */

const SAME_FLOOR_MM = 5;
const VIEW_HEIGHT_MM = 4000;
const MM_PER_FT = 304.8;

const noAt = (level = "") => ({ level, x_ft: 0, y_ft: 0, z_ft: 0 });

function placedViewports(model: ModelState, viewId: string): Viewport[] {
  const out: Viewport[] = [];
  for (const vps of documentIndex(model).viewportsBySheet.values()) for (const vp of vps) if (vp.viewId === viewId && !vp.deleted) out.push(vp);
  return out;
}

function isPlan(v: ViewElement): boolean {
  return v.viewType === "floor_plan" || v.viewType === "ceiling_plan";
}

/** Linked storeys named like the view's level (exact, normalised) or at its elevation. */
function storeyMatches(storeys: ReadonlyArray<{ name: string; elevationMm: number }>, level: string, elevationMm: number | undefined): boolean {
  const want = normalizeLevelName(level);
  return storeys.some((s) => s.name === level || normalizeLevelName(s.name) === want || (elevationMm !== undefined && Math.abs(s.elevationMm - elevationMm) < SAME_FLOOR_MM));
}

function sheetTexts(model: ModelState, sheet: Sheet, projectName: string): string[] {
  // The title block alone: a model holding only the sheet draws its border, title block and nothing else.
  const scene = buildSheetSceneFor({ ...model, elements: { [sheet.id]: sheet } }, sheet.id, { projectName });
  return scene.primitives.flatMap((p) => (p.kind === "text" ? [p.text.toUpperCase().trim()] : []));
}

export const documentRules: readonly RuleDef[] = [
  {
    id: "level-name-mismatch",
    version: 1,
    pack: "documents",
    severity: "warning",
    title: "A plan's level matches no level in a linked model it shows",
    scope: "document",
    kinds: ["view"],
    available: (ctx) => (ctx.linked.some((m) => m.storeys.length > 0) ? null : "No linked model with levels"),
    run: (ctx, el) => {
      if (el.kind !== "view" || el.deleted || !isPlan(el)) return;
      const level = el.props?.level;
      if (!level) return;
      for (const m of ctx.linked) {
        if (m.storeys.length === 0 || storeyMatches(m.storeys, level, el.props?.levelElevationMm)) continue;
        const near = m.storeys.map((s) => s.name).slice(0, 6).join(", ");
        ctx.emit({
          rule: "level-name-mismatch",
          severity: "warning",
          elementIds: [el.id],
          linked: [{ modelId: m.modelId, globalId: `storeys:${m.modelId}`, name: m.label, ifcClass: "IFCBUILDINGSTOREY" }],
          at: noAt(level),
          message: clip(`View ${el.name}'s level ${level} matches no level in ${m.label} (it has ${near || "none"}), so it shows none of it`),
          fix: { tool: "bim_sync_linked_levels", hint: `rename the level to match ${m.label}, or sync levels` },
        });
      }
    },
  },
  {
    id: "view-shows-nothing",
    version: 1,
    pack: "documents",
    severity: "warning",
    title: "A plan whose crop holds no model or linked content",
    scope: "document",
    kinds: ["view"],
    run: (ctx, el) => {
      if (el.kind !== "view" || el.deleted || !isPlan(el) || el.props?.cropView === false) return;
      const level = el.props?.level;
      const names = level ? viewLevelNames(ctx.model, level, el.props?.levelElevationMm) : null;
      const wanted = names ? new Set([...names].map(normalizeLevelName)) : null;
      const floor = level ? (ctx.elevationOfLevel(level) ?? el.props?.levelElevationMm ?? null) : null;
      const box = {
        min: p3(el.cropMin.x, el.cropMin.y, floor === null ? -1e9 : floor - 1000),
        max: p3(el.cropMax.x, el.cropMax.y, floor === null ? 1e9 : floor + VIEW_HEIGHT_MM),
      };
      const any = ctx.bodiesNear(box).some((b) => {
        if (b.elementId) {
          const e = ctx.model.elements[b.elementId];
          return !wanted || (e !== undefined && wanted.has(normalizeLevelName(ctx.levelNameOf(e))));
        }
        return ctx.config.include_linked;
      });
      if (any) return;
      ctx.emit({
        rule: "view-shows-nothing",
        severity: "warning",
        elementIds: [el.id],
        at: { level: level ?? "", x_ft: Math.round(((el.cropMin.x + el.cropMax.x) / 2 / MM_PER_FT) * 10) / 10, y_ft: Math.round(((el.cropMin.y + el.cropMax.y) / 2 / MM_PER_FT) * 10) / 10, z_ft: 0 },
        message: clip(`View ${el.name} shows nothing: no model or linked content inside its crop${level ? ` on ${level}` : ""} (wrong crop or level name?)`),
        fix: { tool: "bim_preview_views_sheets_edit", hint: "fit the crop to the content, or check the level name" },
      });
    },
  },
  {
    id: "empty-schedule-on-sheet",
    version: 1,
    pack: "documents",
    severity: "warning",
    title: "A schedule placed on a sheet with no rows",
    scope: "document",
    kinds: ["view"],
    run: (ctx, el) => {
      if (el.kind !== "view" || el.deleted || el.viewType !== "schedule" || !el.props?.schedule) return;
      if (placedViewports(ctx.model, el.id).length === 0) return;
      let rows: number;
      try {
        rows = evaluateSchedule(ctx.model, el.props.schedule).rows.length;
      } catch (err) {
        console.error("[bim-lint] a schedule could not be evaluated", { viewId: el.id, err });
        return;
      }
      if (rows > 0) return;
      const placeholder = scheduleEmptyRow(el.props.schedule.emptyText);
      ctx.emit({ rule: "empty-schedule-on-sheet", severity: "warning", elementIds: [el.id], at: noAt(), message: clip(`Schedule ${el.name} is on a sheet with no rows (it prints ${placeholder ?? "headings only"})`), fix: { tool: "bim_schedule_define", hint: "check its category and filters, or take it off the sheet" } });
    },
  },
  {
    id: "title-field-not-printing",
    version: 1,
    pack: "documents",
    severity: "warning",
    title: "A sheet field is set but the title block doesn't print it, or it prints the model id",
    scope: "document",
    kinds: ["sheet"],
    run: (ctx, el) => {
      if (el.kind !== "sheet" || el.deleted) return;
      const fields = el.props?.fields ?? {};
      const set = Object.entries(fields).filter(([, v]) => typeof v === "string" && v.trim() !== "");
      const projectName = ctx.projectName ?? ctx.model.modelId;
      let texts: string[];
      try {
        texts = sheetTexts(ctx.model, el, projectName);
      } catch (err) {
        console.error("[bim-lint] a sheet's title block could not be drawn", { sheetId: el.id, err });
        return;
      }
      const printed = (v: string) => texts.some((t) => t.includes(v.toUpperCase().trim()));
      const missing = set.filter(([, v]) => !printed(v)).map(([k]) => k);
      const showsModelId = ctx.model.modelId.length > 0 && texts.includes(ctx.model.modelId.toUpperCase());
      if (missing.length === 0 && !showsModelId) return;
      const what = [missing.length > 0 ? `${missing.slice(0, 4).join(", ")} set but not printed` : "", showsModelId ? `prints the model id ${ctx.model.modelId}` : ""].filter(Boolean).join("; ");
      ctx.emit({ rule: "title-field-not-printing", severity: "warning", elementIds: [el.id], at: noAt(), message: clip(`Sheet ${el.number}'s title block: ${what}`), fix: { tool: "bim_set_sheet_properties", hint: "set the field the title block prints (project_name, project_number)" } });
    },
  },
  {
    id: "viewport-off-sheet",
    version: 1,
    pack: "documents",
    severity: "warning",
    title: "A viewport outside the paper, or two viewports overlapping",
    scope: "document",
    kinds: ["sheet"],
    run: (ctx, el) => {
      if (el.kind !== "sheet" || el.deleted) return;
      const paper = sheetPaper(el);
      const vps = (documentIndex(ctx.model).viewportsBySheet.get(el.id) ?? []).filter((v) => !v.deleted);
      const rect = (v: Viewport) => ({ x0: v.center.x - v.size.x / 2, y0: v.center.y - v.size.y / 2, x1: v.center.x + v.size.x / 2, y1: v.center.y + v.size.y / 2 });
      const viewName = (v: Viewport) => {
        const view = ctx.model.elements[v.viewId];
        return view?.kind === "view" ? view.name : v.viewId;
      };
      for (const v of vps) {
        const r = rect(v);
        if (r.x0 < -1 || r.y0 < -1 || r.x1 > paper.x + 1 || r.y1 > paper.y + 1) {
          ctx.emit({ rule: "viewport-off-sheet", severity: "warning", elementIds: [el.id, v.id], at: noAt(), message: clip(`${viewName(v)} hangs off sheet ${el.number}'s paper`), fix: { tool: "bim_edit_viewport", hint: "move or crop it onto the sheet" } });
        }
      }
      for (let i = 0; i < vps.length; i++) {
        for (let j = i + 1; j < vps.length; j++) {
          const a = rect(vps[i] as Viewport);
          const b = rect(vps[j] as Viewport);
          const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
          const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
          if (ox > 1 && oy > 1) {
            ctx.emit({ rule: "viewport-off-sheet", severity: "warning", elementIds: [el.id, (vps[i] as Viewport).id, (vps[j] as Viewport).id], at: noAt(), message: clip(`${viewName(vps[i] as Viewport)} and ${viewName(vps[j] as Viewport)} overlap on sheet ${el.number}`), fix: { tool: "bim_auto_layout_sheet", hint: "lay the sheet out again" } });
          }
        }
      }
    },
  },
  {
    id: "edited-operator-view",
    version: 1,
    pack: "documents",
    severity: "warning",
    title: "The agent changed a person's own working view",
    scope: "edit",
    kinds: ["view"],
    run: (ctx, el: BimElement) => {
      if (!ctx.editedByAgent || el.kind !== "view") return;
      const personal = el.props?.workingFor !== undefined || /^\{3D - .+\}$/.test(el.name);
      if (!personal) return;
      ctx.emit({ rule: "edited-operator-view", severity: "warning", elementIds: [el.id], at: noAt(), message: clip(`The agent changed ${el.name}, a person's own working view; make a new view instead`), fix: { tool: "bim_duplicate_view", hint: "duplicate it and edit the copy" } });
    },
  },
];
