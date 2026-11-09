import { scaleLabel, type Viewport } from "../documents";
import { documentIndex } from "../commands/views";
import { elementsOfKind, kindsWrittenSince } from "../store";
import { viewLevelNames } from "../levels";
import { siteOf } from "../site";
import { sheetFieldValues } from "../project-parameters";
import { DEFAULT_PARTITION, type ModelState, type Sheet, type Vec2, type ViewElement } from "../types";
import { drawNorthArrow } from "./north";
import type { Primitive, SceneFont } from "./sheet";
import { titleBlockStripFrame, type TitleBlockDefinition, type TitleBlockFont, type TitleBlockLogo, type TitleBlockSlot } from "./title-block-definition";

/**
 * Draws a library title block (`title-block-definition.ts`): the border with
 * its binding margin and the vertical strip of slots on the right edge. One
 * drawer for every firm's row; the values come from the sheet's fields, then
 * the project's (the host passes them), then the model (key plan, scale).
 */

export interface TitleBlockInputs {
  readonly projectName: string;
  readonly projectNumber?: string;
  readonly projectAddress?: string;
  /** Two-letter state of the project (picks the firm's registration number). */
  readonly projectState?: string;
  /** Owner and consultants by role key (`owner`, `architect`), "Name, City". */
  readonly consultants?: Readonly<Record<string, string>>;
  /** Once issued through sign-off: "Digitally signed by … on …". */
  readonly sealStatement?: string;
  /** The host's firm, printed by a title block that names none of its own. */
  readonly firmName?: string;
}

/** Every value the strip prints, by slot. Empty strings print nothing (an optional value left blank). */
export interface TitleBlockValues {
  readonly firmLines: readonly string[];
  readonly registration: string;
  readonly consultants: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  readonly projectName: string;
  readonly projectAddress: string;
  readonly projectNumber: string;
  readonly keyPlan: boolean;
  readonly engineerName: string;
  readonly engineerLicense: string;
  readonly sealStatement: string;
  readonly issuePurpose: string;
  readonly revisions: ReadonlyArray<{ readonly number: string; readonly description: string; readonly date: string }>;
  readonly drawnBy: string;
  readonly checkedBy: string;
  readonly date: string;
  readonly scale: string;
  readonly sheetTitle: string;
  readonly sheetNumber: string;
  readonly footer: string;
}

const upper = (v: string | undefined) => (v ?? "").trim().toUpperCase();
const plain = (v: string | undefined) => (v ?? "").trim();

/** The sheet's own field, else the model's project parameter (`project-parameters.ts`), else the host's value. */
function fieldOr(fields: Readonly<Record<string, string>>, key: string, fallback: string | undefined): string {
  return plain(fields[key]) || plain(fallback);
}

/** The printed scale: the placed views' one scale, AS NOTED for several, NONE when nothing is to scale. */
export function sheetScaleText(model: ModelState, sheet: Sheet): string {
  const labels = new Set<string>();
  for (const { viewport, view } of placedViews(model, sheet)) {
    if (view.viewType === "schedule" || view.viewType === "three_d") continue;
    if (view.viewType === "detail" && viewport.scale === 1) continue;
    labels.add(scaleLabel(viewport.scale));
  }
  if (labels.size === 0) return "NONE";
  if (labels.size > 1) return "AS NOTED";
  return [...labels][0] ?? "NONE";
}

function placedViews(model: ModelState, sheet: Sheet): Array<{ viewport: Viewport; view: ViewElement }> {
  const out: Array<{ viewport: Viewport; view: ViewElement }> = [];
  for (const vp of documentIndex(model).viewportsBySheet.get(sheet.id) ?? []) {
    const view = model.elements[vp.viewId];
    if (view?.kind === "view" && !view.deleted) out.push({ viewport: vp, view });
  }
  out.sort((a, b) => sheet.viewIds.indexOf(a.view.id) - sheet.viewIds.indexOf(b.view.id));
  return out;
}

export function titleBlockRowValues(model: ModelState, sheet: Sheet, def: TitleBlockDefinition, inputs: TitleBlockInputs): TitleBlockValues {
  const firm = def.slots.find((s): s is Extract<TitleBlockSlot, { kind: "firm" }> => s.kind === "firm");
  const consultants = def.slots.find((s): s is Extract<TitleBlockSlot, { kind: "consultants" }> => s.kind === "consultants");
  const footer = def.slots.find((s): s is Extract<TitleBlockSlot, { kind: "footer" }> => s.kind === "footer");
  const fields = sheetFieldValues(model, sheet);
  const state = upper(fieldOr(fields, "project_state", inputs.projectState));
  const reg = state ? firm?.registrations?.[state] : undefined;
  const f = (key: string, fallback?: string) => fieldOr(fields, key, fallback);
  const revisions = sheet.props?.revisions ?? [];
  // A title block with no firm lines of its own (MutinyBIM's) prints the project's firm.
  const firmName = f("firm_name", inputs.firmName);
  return {
    firmLines: firm?.lines && firm.lines.length > 0 ? firm.lines : firmName ? [firmName] : [],
    registration: reg ? `${state} REG. NO. ${upper(reg)}` : "",
    consultants: (consultants?.roles ?? []).map((r) => ({ label: upper(r.label), value: f(r.key, inputs.consultants?.[r.key]) })),
    projectName: upper(f("project_name", inputs.projectName)),
    projectAddress: upper(f("address", inputs.projectAddress)),
    projectNumber: upper(f("project_number", inputs.projectNumber)),
    keyPlan: mainPlan(model, sheet) !== null,
    engineerName: upper(f("engineer_name")),
    engineerLicense: [upper(f("engineer_license")), upper(f("engineer_state"))].filter(Boolean).join(" · "),
    sealStatement: plain(inputs.sealStatement),
    // What the sheet is issued for: its purpose, else the project's status; a sheet never issued and with neither says so.
    issuePurpose: upper(f("issue_purpose") || f("status")) || (revisions.length === 0 ? "NOT ISSUED" : ""),
    revisions: [...revisions].reverse().map((r) => ({ number: r.number, description: upper(r.description), date: r.date })),
    drawnBy: upper(f("drawn_by")),
    checkedBy: upper(f("checked_by")),
    date: upper(f("date")),
    scale: sheetScaleText(model, sheet),
    sheetTitle: upper(sheet.title),
    sheetNumber: sheet.number,
    footer: footer?.text ?? "",
  };
}

// ---------------------------------------------------------------------------
// Key plan: the level's outline, with the area the sheet's main plan shows hatched.
// ---------------------------------------------------------------------------

interface LevelOutline {
  readonly segments: ReadonlyArray<readonly [Vec2, Vec2]>;
  readonly min: Vec2;
  readonly max: Vec2;
}

/** Per model revision (the elements record), per level: the walls' and floors' linework. */
const outlineCache = new WeakMap<object, Map<string, LevelOutline | null>>();
/** The kinds whose edits can change a level's outline; any other edit reuses the previous revision's outlines. */
const OUTLINE_KINDS: readonly string[] = ["wall", "slab", "level"];
/** The revision last read, so the next one (an edit on it) can carry its outlines over. Held weakly: a closed model is not kept alive. */
let lastOutlines: { readonly elements: WeakRef<ModelState["elements"]>; readonly byLevel: Map<string, LevelOutline | null> } | null = null;

function outlinesFor(elements: ModelState["elements"]): Map<string, LevelOutline | null> {
  const hit = outlineCache.get(elements);
  if (hit) return hit;
  // An edit that wrote no wall, floor or level leaves every outline as it was (O(writes) to tell).
  const previous = lastOutlines?.elements.deref();
  const written = previous ? kindsWrittenSince(elements, previous) : null;
  const byLevel = written && lastOutlines && !OUTLINE_KINDS.some((k) => written.has(k)) ? lastOutlines.byLevel : new Map<string, LevelOutline | null>();
  outlineCache.set(elements, byLevel);
  lastOutlines = { elements: new WeakRef(elements), byLevel };
  return byLevel;
}

function levelOutline(model: ModelState, levels: ReadonlySet<string>): LevelOutline | null {
  const key = [...levels].sort().join("\u0000");
  const byLevel = outlinesFor(model.elements);
  if (byLevel.has(key)) return byLevel.get(key) ?? null;
  const segments: Array<readonly [Vec2, Vec2]> = [];
  const on = (el: { readonly partition?: { readonly level: string } }) => levels.has((el.partition ?? DEFAULT_PARTITION).level);
  for (const wall of elementsOfKind(model.elements, "wall")) if (on(wall)) segments.push([wall.start, wall.end]);
  for (const slab of elementsOfKind(model.elements, "slab")) {
    if (!on(slab)) continue;
    slab.outline.forEach((p, i) => {
      const q = slab.outline[(i + 1) % slab.outline.length];
      if (q) segments.push([p, q]);
    });
  }
  let found: LevelOutline | null = null;
  if (segments.length > 0) {
    const min = { x: Infinity, y: Infinity };
    const max = { x: -Infinity, y: -Infinity };
    for (const [a, b] of segments)
      for (const p of [a, b]) {
        min.x = Math.min(min.x, p.x);
        min.y = Math.min(min.y, p.y);
        max.x = Math.max(max.x, p.x);
        max.y = Math.max(max.y, p.y);
      }
    found = { segments, min, max };
  }
  byLevel.set(key, found);
  return found;
}

/** The sheet's main plan: its first placed floor or ceiling plan with a level. */
function mainPlan(model: ModelState, sheet: Sheet): { readonly view: ViewElement; readonly levels: ReadonlySet<string> } | null {
  for (const { view } of placedViews(model, sheet)) {
    if (view.viewType !== "floor_plan" && view.viewType !== "ceiling_plan") continue;
    const levels = viewLevelNames(model, view.props?.level, view.props?.levelElevationMm);
    if (levels) return { view, levels };
  }
  return null;
}

/** Clip a segment to a rectangle (Liang–Barsky); null when it misses. */
function clip(a: Vec2, b: Vec2, min: Vec2, max: Vec2): [Vec2, Vec2] | null {
  let t0 = 0;
  let t1 = 1;
  const d = { x: b.x - a.x, y: b.y - a.y };
  const edges: Array<[number, number]> = [
    [-d.x, a.x - min.x],
    [d.x, max.x - a.x],
    [-d.y, a.y - min.y],
    [d.y, max.y - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return null;
  }
  return [
    { x: a.x + d.x * t0, y: a.y + d.y * t0 },
    { x: a.x + d.x * t1, y: a.y + d.y * t1 },
  ];
}

/**
 * The key plan in a box on paper (mm, y down): the main plan's level drawn to
 * fit, and the main plan's crop (the area this sheet shows) hatched. Draws
 * nothing on a sheet with no plan (the box stays empty).
 */
export function keyPlanPrimitives(model: ModelState, sheet: Sheet, box: { readonly at: Vec2; readonly size: Vec2 }, ink?: string): Primitive[] {
  const plan = mainPlan(model, sheet);
  if (!plan) return [];
  const outline = levelOutline(model, plan.levels);
  const crop = { min: plan.view.cropMin, max: plan.view.cropMax };
  const min = { x: Math.min(outline?.min.x ?? crop.min.x, crop.min.x), y: Math.min(outline?.min.y ?? crop.min.y, crop.min.y) };
  const max = { x: Math.max(outline?.max.x ?? crop.max.x, crop.max.x), y: Math.max(outline?.max.y ?? crop.max.y, crop.max.y) };
  const pad = 3;
  const span = { x: Math.max(1, max.x - min.x), y: Math.max(1, max.y - min.y) };
  const s = Math.min((box.size.x - pad * 2) / span.x, (box.size.y - pad * 2) / span.y);
  const ox = box.at.x + (box.size.x - span.x * s) / 2;
  const oy = box.at.y + (box.size.y - span.y * s) / 2;
  // Plan north up: model +y is paper up.
  const toPaper = (p: Vec2): Vec2 => ({ x: ox + (p.x - min.x) * s, y: oy + (max.y - p.y) * s });
  const style = ink ? { color: ink } : {};
  const out: Primitive[] = [];
  const a = toPaper({ x: Math.max(crop.min.x, min.x), y: Math.min(crop.max.y, max.y) });
  const b = toPaper({ x: Math.min(crop.max.x, max.x), y: Math.max(crop.min.y, min.y) });
  // Hatch at 45°, 1.2 mm apart, clipped to the shown area.
  const hatch = 1.2;
  const w = b.x - a.x;
  const h = b.y - a.y;
  for (let k = hatch; k < w + h; k += hatch) {
    const seg = clip({ x: a.x + k, y: a.y }, { x: a.x + k - (w + h), y: a.y + (w + h) }, a, b);
    if (seg) out.push({ kind: "line", a: seg[0], b: seg[1], pen: "thin", widthMm: 0.13, ...style });
  }
  for (const [p, q] of outline?.segments ?? []) out.push({ kind: "line", a: toPaper(p), b: toPaper(q), pen: "medium", ...style });
  out.push({ kind: "rect", at: a, size: { x: w, y: h }, pen: "medium", ...style });
  return out;
}

// ---------------------------------------------------------------------------
// The strip
// ---------------------------------------------------------------------------

type FontKey = "display" | "displayBold" | "body";

function fontId(font: TitleBlockFont): string {
  return `${font.family.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${font.weight}`;
}

/** The fonts a definition's text uses, as the scene lists them. */
export function titleBlockSceneFonts(def: TitleBlockDefinition): SceneFont[] {
  const out = new Map<string, SceneFont>();
  for (const font of [def.fonts.display, def.fonts.displayBold, def.fonts.body]) out.set(fontId(font), { id: fontId(font), family: font.family, weight: font.weight, file: font.file, capHeight: font.capHeight });
  return [...out.values()];
}

/** Rough advance of capitals per mm of cap height (title-block faces are wider than the sheet font). Used to wrap and fit; the writers place the real glyphs. */
const CAPS_WIDTH_PER_CAP = 0.92;

function wrap(text: string, size: number, room: number, maxLines: number): string[] {
  const perLine = Math.max(1, Math.floor(room / (size * CAPS_WIDTH_PER_CAP)));
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= perLine || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1] ?? "";
  kept[maxLines - 1] = last.length >= perLine ? `${last.slice(0, Math.max(1, perLine - 1))}…` : `${last}…`;
  return kept;
}

export interface DrawnTitleBlock {
  readonly primitives: Primitive[];
  readonly fonts: SceneFont[];
  /** Where the issued sheet's Verify code goes (the QR slot), mm. Absent: the definition has no QR slot. */
  readonly codeSlot?: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number };
  /** Each slot's frame on paper, top to bottom (checks and the Settings preview). */
  readonly slots: ReadonlyArray<{ readonly kind: TitleBlockSlot["kind"]; readonly top: number; readonly bottom: number }>;
}

export function drawTitleBlock(model: ModelState, sheet: Sheet, def: TitleBlockDefinition, inputs: TitleBlockInputs): DrawnTitleBlock {
  const v = titleBlockRowValues(model, sheet, def, inputs);
  const prims: Primitive[] = [];
  const ink = def.colors.ink;
  const labelInk = def.colors.label;
  const fonts: Record<FontKey, TitleBlockFont> = def.fonts;
  const strip = titleBlockStripFrame(def);
  const pad = 4;
  const x0 = strip.left + pad;
  const x1 = strip.right - pad;
  const w = x1 - x0;
  const text = (at: Vec2, value: string, size: number, font: FontKey, color: string, anchor: "start" | "middle" | "end" = "start") => {
    if (value) prims.push({ kind: "text", at, text: value, size, anchor, font: fontId(fonts[font]), color, ...(font !== "body" ? { bold: true } : {}) });
  };
  const rule = (a: Vec2, b: Vec2, widthMm: number, color = ink) => prims.push({ kind: "line", a, b, pen: "thin", widthMm, color });
  const labelAt = (y: number, value: string, x = x0) => text({ x, y }, value, 1.8, "body", labelInk);
  const heading = (y: number, value: string) => {
    if (def.colors.tint) prims.push({ kind: "fill", points: [{ x: strip.left, y: y - 3.6 }, { x: strip.right, y: y - 3.6 }, { x: strip.right, y: y + 1.6 }, { x: strip.left, y: y + 1.6 }], grey: 0.95, color: def.colors.tint });
    text({ x: x0, y }, value, 2.5, "display", ink);
  };

  // Border, binding margin on the left, and the strip's left edge.
  prims.push({ kind: "rect", at: { x: def.marginsMm.left, y: def.marginsMm.top }, size: { x: strip.right - def.marginsMm.left, y: strip.bottom - strip.top }, pen: "heavy", widthMm: def.lines.borderMm, color: ink });
  rule({ x: strip.left, y: strip.top }, { x: strip.left, y: strip.bottom }, def.lines.borderMm);

  const fixed = def.slots.reduce((sum, s) => sum + (s.kind === "revisions" ? (s.heightMm ?? 0) : s.heightMm), 0);
  const flex = Math.max(0, strip.bottom - strip.top - fixed);
  const frames: Array<{ kind: TitleBlockSlot["kind"]; top: number; bottom: number }> = [];
  let codeSlot: DrawnTitleBlock["codeSlot"];
  let y = strip.top;
  def.slots.forEach((slot, i) => {
    const height = slot.kind === "revisions" ? (slot.heightMm ?? 0) + flex : slot.heightMm;
    const top = y;
    const bottom = y + height;
    frames.push({ kind: slot.kind, top, bottom });
    switch (slot.kind) {
      case "firm": {
        let cy = top + pad;
        if (slot.logo) {
          drawLogo(prims, slot.logo, { x: x0, y: cy }, fonts);
          cy += slot.logo.heightMm + 4;
        }
        v.firmLines.forEach((line, k) => {
          cy += k === 0 ? 2.5 : 3.6;
          if (k === 0) text({ x: x0, y: cy }, line.toUpperCase(), 2.5, "display", ink);
          else text({ x: x0, y: cy }, line, 2.0, "body", ink);
        });
        if (v.registration) text({ x: x0, y: cy + 4 }, v.registration, 2.0, "body", ink);
        // Red, once: a rule under the firm block (accent only; the strip reads without it).
        if (def.lines.accentRuleMm) rule({ x: x0, y: bottom - 2 }, { x: x1, y: bottom - 2 }, def.lines.accentRuleMm, def.colors.accent);
        break;
      }
      case "consultants": {
        heading(top + 6, "OWNER & CONSULTANTS");
        let cy = top + 11;
        for (const row of v.consultants) {
          if (cy + 5 > bottom) break;
          labelAt(cy, row.label);
          text({ x: x0 + w * 0.34, y: cy }, row.value, 2.2, "body", ink);
          cy += 5.2;
        }
        break;
      }
      case "project": {
        heading(top + 6, "PROJECT");
        let cy = top + 13;
        for (const line of wrap(v.projectName, 5, w, 2)) {
          text({ x: x0, y: cy }, line, 5, "displayBold", ink);
          cy += 7;
        }
        for (const line of wrap(v.projectAddress, 2.5, w, 2)) {
          text({ x: x0, y: cy }, line, 2.5, "body", ink);
          cy += 3.8;
        }
        labelAt(bottom - 4, "PROJECT NO.");
        text({ x: x0 + w * 0.34, y: bottom - 4 }, v.projectNumber, 2.5, "body", ink);
        break;
      }
      case "key_plan": {
        heading(top + 6, "KEY PLAN");
        const box = { at: { x: x0 + (w - slot.boxMm.x) / 2, y: top + 10 }, size: slot.boxMm };
        prims.push({ kind: "rect", at: box.at, size: box.size, pen: "thin", widthMm: def.lines.ruleMm, color: ink });
        prims.push(...keyPlanPrimitives(model, sheet, box, ink));
        if (slot.northArrow && v.keyPlan) {
          const north: Primitive[] = [];
          drawNorthArrow(north, { x: box.at.x + box.size.x - 5, y: box.at.y + 8 }, siteOf(model).trueNorthDeg, 3);
          for (const p of north) prims.push(p.kind === "text" ? { ...p, font: fontId(fonts.display), color: ink, size: 2 } : { ...p, color: ink });
        }
        break;
      }
      case "seal": {
        const side = slot.squareMm;
        const at = { x: x0 + (w - side) / 2, y: top + pad };
        // Clear: nothing prints inside the engineer's seal square.
        prims.push({ kind: "rect", at, size: { x: side, y: side }, pen: "thin", widthMm: def.lines.ruleMm, color: ink });
        let cy = at.y + side + 5;
        labelAt(cy, "ENGINEER");
        text({ x: x0 + w * 0.34, y: cy }, v.engineerName, 2.2, "body", ink);
        cy += 4.6;
        labelAt(cy, "LICENSE / STATE");
        text({ x: x0 + w * 0.34, y: cy }, v.engineerLicense, 2.2, "body", ink);
        cy += 6;
        if (v.sealStatement) {
          for (const line of wrap(v.sealStatement.toUpperCase(), 1.8, w, 2)) {
            text({ x: x0, y: cy }, line, 1.8, "body", ink);
            cy += 3;
          }
        } else {
          labelAt(cy, "SIGNATURE");
          rule({ x: x0 + w * 0.34, y: cy + 0.4 }, { x: x1, y: cy + 0.4 }, def.lines.ruleMm);
          cy += 5;
          labelAt(cy, "DATE");
          rule({ x: x0 + w * 0.34, y: cy + 0.4 }, { x: x1, y: cy + 0.4 }, def.lines.ruleMm);
        }
        break;
      }
      case "revisions": {
        heading(top + 6, "ISSUES & REVISIONS");
        text({ x: x0, y: top + 13 }, v.issuePurpose, 3, "displayBold", ink);
        const row = 5;
        const header = top + 17;
        const noW = 9;
        const dateW = 19;
        const cells = (cy: number, no: string, desc: string, date: string, isHeader: boolean) => {
          rule({ x: x0, y: cy }, { x: x1, y: cy }, def.lines.ruleMm);
          const base = cy + row - 1.5;
          const write = isHeader ? (at: Vec2, s: string) => text(at, s, 1.8, "body", labelInk) : (at: Vec2, s: string) => text(at, s, 2.0, "body", ink);
          write({ x: x0 + 1, y: base }, no);
          const room = Math.max(1, Math.floor((w - noW - dateW - 2) / (2.0 * CAPS_WIDTH_PER_CAP)));
          write({ x: x0 + noW + 1, y: base }, desc.length > room ? `${desc.slice(0, Math.max(1, room - 1))}…` : desc);
          write({ x: x1 - dateW + 1, y: base }, date);
        };
        cells(header, "NO.", "DESCRIPTION", "DATE", true);
        const fits = Math.max(0, Math.floor((bottom - header - row - 2) / row));
        const shown = v.revisions.slice(0, fits);
        shown.forEach((r, k) => cells(header + row * (k + 1), r.number, r.description, r.date, false));
        const tableBottom = header + row * (shown.length + 1);
        rule({ x: x0, y: tableBottom }, { x: x1, y: tableBottom }, def.lines.ruleMm);
        rule({ x: x0 + noW, y: header }, { x: x0 + noW, y: tableBottom }, def.lines.ruleMm);
        rule({ x: x1 - dateW, y: header }, { x: x1 - dateW, y: tableBottom }, def.lines.ruleMm);
        break;
      }
      case "sheet_data": {
        const rowH = height / 2;
        const col = w / 3;
        const cell = (cx: number, cy: number, name: string, value: string) => {
          labelAt(cy + 4, name, cx);
          text({ x: cx, y: cy + 9 }, value, 2.5, "body", ink);
        };
        cell(x0, top, "DRAWN BY", v.drawnBy);
        cell(x0 + col, top, "CHECKED BY", v.checkedBy);
        cell(x0 + col * 2, top, "DATE", v.date);
        rule({ x: strip.left, y: top + rowH }, { x: strip.right, y: top + rowH }, def.lines.ruleMm);
        cell(x0, top + rowH, "SCALE", v.scale);
        cell(x0 + col * 2, top + rowH, "PROJECT NO.", v.projectNumber);
        rule({ x: x0 + col - 2, y: top }, { x: x0 + col - 2, y: top + rowH }, def.lines.ruleMm);
        rule({ x: x0 + col * 2 - 2, y: top }, { x: x0 + col * 2 - 2, y: bottom }, def.lines.ruleMm);
        break;
      }
      case "qr": {
        labelAt(top + 5, "VERIFY");
        const side = height - pad * 2;
        codeSlot = { left: x1 - side, right: x1, top: top + pad, bottom: bottom - pad };
        break;
      }
      case "sheet_id": {
        labelAt(top + 5, "SHEET TITLE");
        let cy = top + 6 + slot.titleCapMm + 1.5;
        for (const line of wrap(v.sheetTitle, slot.titleCapMm, w, 2)) {
          text({ x: x0, y: cy }, line, slot.titleCapMm, "display", ink);
          cy += slot.titleCapMm * 1.45;
        }
        labelAt(bottom - slot.numberCapMm - 5, "SHEET");
        text({ x: x1, y: bottom - 3.5 }, v.sheetNumber, slot.numberCapMm, "displayBold", ink, "end");
        break;
      }
      case "footer": {
        let cy = top + 3;
        for (const line of wrap(v.footer.toUpperCase(), 1.8, w, 4)) {
          text({ x: x0, y: cy }, line, 1.8, "body", labelInk);
          cy += 2.8;
        }
        break;
      }
    }
    y = bottom;
    // Dividers between slots (the firm block's rule is its own).
    if (i < def.slots.length - 1) rule({ x: strip.left, y: bottom }, { x: strip.right, y: bottom }, def.lines.dividerMm);
  });
  return { primitives: prims, fonts: titleBlockSceneFonts(def), ...(codeSlot ? { codeSlot } : {}), slots: frames };
}

function drawLogo(prims: Primitive[], logo: TitleBlockLogo, at: Vec2, fonts: Record<FontKey, TitleBlockFont>): void {
  const p = (q: { readonly x: number; readonly y: number }): Vec2 => ({ x: at.x + q.x * logo.widthMm, y: at.y + q.y * logo.heightMm });
  for (const shape of logo.shapes) prims.push({ kind: "fill", points: shape.points.map(p), grey: 0, color: shape.color });
  for (const word of logo.words) prims.push({ kind: "text", at: p(word), text: word.text, size: word.cap * logo.heightMm, anchor: word.anchor, font: fontId(fonts[word.font]), color: word.color, bold: true });
}
