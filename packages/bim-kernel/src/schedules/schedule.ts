import { emForCapHeight, textWidth } from "../annotation/text-layout";
import { elementsOfKind, recordsOfKinds } from "../store";
import { elementKindTable, type ElementKindTable } from "../registry/element-kind-point";
import type { BimElement, ModelState, Vec2 } from "../types";
import type { Primitive } from "../drawing/sheet";
import { isRelationshipField } from "../fields/resolver";
import type { ScheduleCategory, ScheduleColumn, ScheduleDefinition } from "../documents";
import { SCHEDULE_CATEGORY_LABELS } from "./definition";
import { BASE_FIELDS, DUCT_FIELDS, elementRecord, isDeleted, lastRevision, PANEL_FIELDS, PIPE_FIELDS, POWERED_FIELDS, SHEET_FIELDS, withRelationshipFields, type Record_ } from "./records";

/**
 * Model-driven schedules: a table of one category's elements (or the set's
 * sheets), evaluated from the model at the revision it is drawn from. Nothing
 * is stored but the definition, so a schedule on a sheet always prints what the
 * model says. The table's paper size is its "window" (scale 1), so a schedule
 * view places, follows and prints through the same viewport path as any view.
 */


const ROW_TEXT_MM = 2.5;
const PAD_MM = 1.5;
const MIN_COL_MM = 12;
const MAX_COL_MM = 120;
/** Text widths come from the note font's metrics; the printed Helvetica runs a few percent wider. */
const WIDTH_SAFETY = 1.08;
/** One comparer for every sort: building one per comparison is most of a large schedule's cost. */
const COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export interface ScheduleField {
  readonly key: string;
  readonly label: string;
}

/** How a printed row reads: an element, a sub-row under it, a group heading spanning the table, a group footer or the grand total. */
export type ScheduleRowStyle = "item" | "child" | "group" | "footer" | "total";

export interface EvaluatedSchedule {
  readonly title: string;
  readonly headings: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** The element ids behind each row (combined rows list every one). */
  readonly elementIds: readonly (readonly string[])[];
  /** Per row; absent: every row is an element row (v1 schedules). */
  readonly rowStyles?: readonly ScheduleRowStyle[];
}

/** What every schedule of an element record reads, each category listed from the kind index on first read. */
interface ScheduleIndex {
  readonly levels: ReadonlyMap<string, string>;
  readonly partTypes: readonly Extract<BimElement, { kind: "part_type" }>[];
  /** Elements that can appear in a schedule of this category: the category's own kinds in model order, then its parts in model order. */
  category(c: ScheduleCategory): readonly BimElement[];
}

const indexes = new WeakMap<object, ScheduleIndex>();

/** The non-part elements a category lists. */
function categoryKinds(elements: ModelState["elements"], c: ScheduleCategory, table: ElementKindTable): BimElement[] {
  switch (c) {
    case "sheet_list":
      return elementsOfKind(elements, "sheet").filter((el) => !el.deleted);
    case "duct":
      return elementsOfKind(elements, "run_segment").filter((el) => el.domain === "duct");
    case "pipe":
      return elementsOfKind(elements, "run_segment").filter((el) => el.domain === "pipe");
    default:
      return recordsOfKinds(elements, listedKinds(c, table));
  }
}

/** The add-on kinds whose rows list their records under schedule category `c` (`scheduleCategory` with `scheduleListing`), in row order. */
function listedKinds(c: ScheduleCategory, table: ElementKindTable): readonly string[] {
  return table.kinds.filter((kind) => {
    const row = table.row(kind);
    return row?.scheduleListing !== undefined && row.scheduleCategory === c;
  });
}

function scheduleIndex(model: Pick<ModelState, "elements">): ScheduleIndex {
  const cached = indexes.get(model.elements);
  if (cached) return cached;
  const elements = model.elements;
  const levels = new Map<string, string>();
  for (const el of elementsOfKind(elements, "level")) levels.set(el.id, el.name);
  const partTypes = elementsOfKind(elements, "part_type");
  // Which kinds a category lists is the set in force's, so the lists are kept per kind table.
  const listsByTable = new WeakMap<ElementKindTable, Map<ScheduleCategory, readonly BimElement[]>>();
  const built: ScheduleIndex = {
    levels,
    partTypes,
    category: (c) => {
      const table = elementKindTable();
      let lists = listsByTable.get(table);
      if (!lists) listsByTable.set(table, (lists = new Map()));
      const known = lists.get(c);
      if (known) return known;
      const out = categoryKinds(elements, c, table);
      for (const part of elementsOfKind(elements, "part")) {
        const type = elements[part.typeId];
        if (type?.kind === "part_type" && type.definition.category === c) out.push(part);
      }
      lists.set(c, out);
      return out;
    },
  };
  indexes.set(model.elements, built);
  return built;
}

function records(model: Pick<ModelState, "elements">, def: ScheduleDefinition): Record_[] {
  const index = scheduleIndex(model);
  const candidates = index.category(def.category);
  const out: Record_[] = [];
  if (def.category === "sheet_list") {
    for (const el of candidates) {
      if (el.kind !== "sheet") continue;
      const rev = lastRevision(el.props?.revisions);
      out.push({
        ids: [el.id],
        values: { number: el.number, name: el.title, revision: rev?.number ?? "", revision_date: rev?.date ?? "", revision_description: rev?.description ?? "" },
        numbers: {},
      });
    }
    return out;
  }
  const wantedLevel = def.level?.trim().toLowerCase();
  const paths = relationshipPaths(def);
  for (const el of candidates) {
    if (isDeleted(el)) continue;
    const base = elementRecord(model, el, index.levels);
    if (!base) continue;
    if (wantedLevel && (base.values.level ?? "").trim().toLowerCase() !== wantedLevel) continue;
    out.push(paths.length > 0 && (el.kind === "part" || el.kind === "service_link") ? withRelationshipFields(model, el.id, base, paths) : base);
  }
  return out;
}

/** Fields the definition reads through connections (circuit, panel, voltage_phase, feeder.source.name…). */
function relationshipPaths(def: ScheduleDefinition): string[] {
  const fields = [...def.columns.map((c) => c.field), ...(def.sort ?? []).map((s) => s.field), ...(def.filters ?? []).map((f) => f.field)];
  return [...new Set(fields.filter(isRelationshipField))];
}

/** Fields a schedule of this category can show, from what the model holds now. */
export function scheduleFields(model: Pick<ModelState, "elements">, category: ScheduleCategory): ScheduleField[] {
  if (category === "sheet_list") return Object.entries(SHEET_FIELDS).map(([key, label]) => ({ key, label }));
  if (category === "duct") return [...Object.entries(BASE_FIELDS), ...Object.entries(DUCT_FIELDS)].map(([key, label]) => ({ key, label }));
  if (category === "pipe") return [...Object.entries(BASE_FIELDS), ...Object.entries(PIPE_FIELDS)].map(([key, label]) => ({ key, label }));
  const out = new Map<string, string>(Object.entries(BASE_FIELDS));
  if (category === "mechanical_equipment" || category === "air_terminal") out.set("cfm", "CFM");
  let powered = false;
  for (const el of scheduleIndex(model).partTypes) {
    if (el.definition.category !== category) continue;
    if (el.definition.connectors?.some((c) => c.domain === "electrical")) powered = true;
    for (const p of [...el.definition.typeParams, ...el.definition.instanceParams]) {
      if (!out.has(p.name)) out.set(p.name, (p.label || p.name).toUpperCase());
    }
  }
  // Parts with a power connector: the live electrical fields, read through their circuit (these replace a typed "circuit" parameter).
  if (powered) for (const [key, label] of Object.entries(category === "electrical_equipment" ? PANEL_FIELDS : POWERED_FIELDS)) out.set(key, label);
  return [...out].map(([key, label]) => ({ key, label }));
}

function compareValues(a: Record_, b: Record_, field: string): number {
  const na = a.numbers[field];
  const nb = b.numbers[field];
  if (na !== undefined && nb !== undefined) return na - nb;
  return COLLATOR.compare(a.values[field] ?? "", b.values[field] ?? "");
}

function passes(rec: Record_, filter: NonNullable<ScheduleDefinition["filters"]>[number]): boolean {
  const text = (rec.values[filter.field] ?? "").toLowerCase();
  const want = filter.value.toLowerCase();
  const n = rec.numbers[filter.field];
  const wantN = Number(filter.value);
  switch (filter.op) {
    case "equals":
      return text === want;
    case "not_equals":
      return text !== want;
    case "contains":
      return text.includes(want);
    case "greater_than":
      return n !== undefined && Number.isFinite(wantN) ? n > wantN : COLLATOR.compare(text, want) > 0;
    case "less_than":
      return n !== undefined && Number.isFinite(wantN) ? n < wantN : COLLATOR.compare(text, want) < 0;
  }
}

function headingFor(col: ScheduleColumn, fields: ReadonlyMap<string, string>): string {
  return (col.heading ?? fields.get(col.field) ?? col.field.replace(/_/g, " ").toUpperCase()).trim();
}

/** The schedule's rows as they print, at this model state. */
export function evaluateSchedule(model: Pick<ModelState, "elements">, def: ScheduleDefinition): EvaluatedSchedule {
  const fields = new Map(scheduleFields(model, def.category).map((f) => [f.key, f.label]));
  let recs = records(model, def).filter((r) => (def.filters ?? []).every((f) => passes(r, f)));
  const sort = def.sort && def.sort.length > 0 ? def.sort : [{ field: def.category === "sheet_list" ? "number" : "mark" }];
  recs = [...recs].sort((a, b) => {
    for (const s of sort) {
      const c = compareValues(a, b, s.field);
      if (c !== 0) return "descending" in s && s.descending ? -c : c;
    }
    return 0;
  });
  const shown = def.columns.filter((c) => c.field !== "count");
  const rows: string[][] = [];
  const ids: string[][] = [];
  if (def.itemize === false) {
    const groups = new Map<string, { cells: string[]; ids: string[] }>();
    for (const r of recs) {
      const cells = shown.map((c) => r.values[c.field] ?? "");
      const key = JSON.stringify(cells);
      const g = groups.get(key);
      if (g) g.ids.push(...r.ids);
      else groups.set(key, { cells, ids: [...r.ids] });
    }
    for (const g of groups.values()) {
      rows.push(def.columns.map((c) => (c.field === "count" ? String(g.ids.length) : (g.cells[shown.indexOf(c)] ?? ""))));
      ids.push(g.ids);
    }
  } else {
    for (const r of recs) {
      rows.push(def.columns.map((c) => (c.field === "count" ? "1" : (r.values[c.field] ?? ""))));
      ids.push([...r.ids]);
    }
  }
  const headings = def.columns.map((c) => headingFor(c, fields));
  if (def.itemize === false && !def.columns.some((c) => c.field === "count")) {
    headings.push("COUNT");
    rows.forEach((row, i) => row.push(String(ids[i]?.length ?? 0)));
  }
  return { title: (def.title ?? SCHEDULE_CATEGORY_LABELS[def.category]).toUpperCase(), headings, rows, elementIds: ids };
}

/** What an empty schedule prints under its headings: "NONE" unless the definition says otherwise ("" for nothing). */
export function scheduleEmptyRow(emptyText: string | undefined): string | null {
  const text = (emptyText ?? "NONE").trim();
  return text ? text.toUpperCase() : null;
}

export interface ScheduleTable {
  readonly evaluated: EvaluatedSchedule;
  /** The row printed in place of rows when there are none (null: headings only). */
  readonly placeholder: string | null;
  readonly columnWidths: readonly number[];
  /** Each heading as it prints: one line, or two when it is wider than its column. */
  readonly headingLines: readonly (readonly string[])[];
  /** The heading row's height (taller when a heading wraps). */
  readonly headingHeight: number;
  readonly titleHeight: number;
  readonly rowHeight: number;
  readonly textSize: number;
  /** Paper mm. */
  readonly size: Vec2;
}

function measure(text: string, size: number, bold: boolean): number {
  return textWidth(bold ? "bold" : "regular", text, emForCapHeight(size)) * WIDTH_SAFETY;
}

/** Most lines a heading wraps to. */
const HEADING_LINES = 2;

/** A heading broken at spaces to fit its column, at most HEADING_LINES lines (the last may still be too wide). */
function wrapHeading(heading: string, width: number, size: number): string[] {
  const room = width - PAD_MM * 2;
  if (measure(heading, size, true) <= room) return [heading];
  const words = heading.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (line && measure(next, size, true) > room && lines.length < HEADING_LINES - 1) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** Headings that still don't fit their column after wrapping, in plain words (empty: every heading fits). */
export function scheduleHeadingsCut(model: Pick<ModelState, "elements">, def: ScheduleDefinition): string[] {
  const table = scheduleTable(model, def);
  const out: string[] = [];
  table.headingLines.forEach((lines, i) => {
    const w = table.columnWidths[i] ?? MIN_COL_MM;
    const widest = Math.max(...lines.map((l) => measure(l, table.textSize, true)));
    if (widest > w - PAD_MM * 2) out.push(`"${table.evaluated.headings[i] ?? ""}" needs a column about ${Math.ceil(((widest + PAD_MM * 2) / 25.4) * 100) / 100} in wide (it is ${Math.round((w / 25.4) * 100) / 100} in), so it prints cut off`);
  });
  return out;
}

/** Column widths and the table's paper size (the smallest a viewport frame may be is 1 in a side). */
export function scheduleTable(model: Pick<ModelState, "elements">, def: ScheduleDefinition): ScheduleTable {
  return layoutScheduleTable(evaluateSchedule(model, def), { textSizeMm: def.textSizeMm, emptyText: def.emptyText, widthsMm: def.columns.map((c) => c.widthMm) });
}

export interface ScheduleTableOptions {
  /** Row text height, paper mm. Absent: 2.5. */
  readonly textSizeMm?: number;
  /** See `scheduleEmptyRow`. */
  readonly emptyText?: string;
  /** Fixed paper widths by printed column; absent entries size to their longest text. */
  readonly widthsMm?: readonly (number | undefined)[];
}

/** Lay out evaluated rows as a printed table (v1 and v2 schedules share it). */
export function layoutScheduleTable(evaluated: EvaluatedSchedule, opts: ScheduleTableOptions): ScheduleTable {
  const textSize = opts.textSizeMm ?? ROW_TEXT_MM;
  const rowHeight = Math.max(4, textSize * 2.6);
  const titleHeight = rowHeight * 1.3;
  const columnWidths = evaluated.headings.map((heading, i) => {
    const fixed = opts.widthsMm?.[i];
    if (fixed !== undefined) return fixed;
    // Most cells repeat (types, levels); measure each distinct value once.
    const seen = new Set<string>();
    let longest = measure(heading, textSize, true);
    for (const [r, row] of evaluated.rows.entries()) {
      const style = evaluated.rowStyles?.[r];
      if (style === "group") continue;
      const bold = style === "footer" || style === "total";
      const cell = row[i] ?? "";
      const key = bold ? `\u0001${cell}` : cell;
      if (seen.has(key)) continue;
      seen.add(key);
      longest = Math.max(longest, measure(cell, textSize, bold));
    }
    return Math.min(MAX_COL_MM, Math.max(MIN_COL_MM, longest + PAD_MM * 2));
  });
  const titleWidth = measure(evaluated.title, textSize * 1.2, true) + PAD_MM * 2;
  const width = Math.max(25.4, titleWidth, columnWidths.reduce((a, b) => a + b, 0));
  // Spread any extra title width over the columns so the grid closes under it.
  const sum = columnWidths.reduce((a, b) => a + b, 0);
  const widths = sum > 0 && sum < width ? columnWidths.map((w) => (w * width) / sum) : columnWidths;
  const placeholder = evaluated.rows.length === 0 ? scheduleEmptyRow(opts.emptyText) : null;
  const headingLines = evaluated.headings.map((h, i) => wrapHeading(h, widths[i] ?? MIN_COL_MM, textSize));
  const lineCount = Math.max(1, ...headingLines.map((l) => l.length));
  const headingHeight = rowHeight + (lineCount - 1) * textSize * 1.4;
  const height = Math.max(25.4, titleHeight + headingHeight + rowHeight * Math.max(evaluated.rows.length, placeholder ? 1 : 0));
  return { evaluated, placeholder, headingLines, headingHeight, columnWidths: widths, titleHeight, rowHeight, textSize, size: { x: Math.round(width * 100) / 100, y: Math.round(height * 100) / 100 } };
}

/** Clip cell text to its column so a long value never runs into the next one. */
function fit(text: string, width: number, size: number, bold: boolean): string {
  if (measure(text, size, bold) <= width - PAD_MM * 2) return text;
  let out = text;
  while (out.length > 1 && measure(`${out}…`, size, bold) > width - PAD_MM * 2) out = out.slice(0, -1);
  return `${out}…`;
}

/** Draw the table with its top-left corner at `topLeft` (paper mm). */
export function drawScheduleTable(prims: Primitive[], table: ScheduleTable, topLeft: Vec2): void {
  const { evaluated, placeholder, headingLines, headingHeight, columnWidths, titleHeight, rowHeight, textSize } = table;
  const width = columnWidths.reduce((a, b) => a + b, 0);
  const x0 = topLeft.x;
  const y0 = topLeft.y;
  prims.push({ kind: "text", at: { x: x0 + width / 2, y: y0 + titleHeight * 0.68 }, text: evaluated.title, size: textSize * 1.2, anchor: "middle", bold: true });
  const gridTop = y0 + titleHeight;
  const bodyTop = gridTop + headingHeight;
  const columnsBottom = bodyTop + rowHeight * evaluated.rows.length;
  const bottom = columnsBottom + (placeholder ? rowHeight : 0);
  prims.push({ kind: "rect", at: { x: x0, y: y0 }, size: { x: width, y: bottom - y0 }, pen: "wide" });
  prims.push({ kind: "line", a: { x: x0, y: gridTop }, b: { x: x0 + width, y: gridTop }, pen: "medium" });
  let hx = x0;
  headingLines.forEach((lines, j) => {
    const w = columnWidths[j] ?? MIN_COL_MM;
    const lead = textSize * 1.4;
    const first = gridTop + headingHeight / 2 + textSize / 2 - ((lines.length - 1) * lead) / 2;
    lines.forEach((line, k) => prims.push({ kind: "text", at: { x: hx + w / 2, y: first + k * lead }, text: fit(line, w, textSize, true), size: textSize, anchor: "middle", bold: true }));
    hx += w;
  });
  const styles = evaluated.rowStyles;
  evaluated.rows.forEach((cells, r) => {
    const y = bodyTop + rowHeight * r;
    const style = styles?.[r];
    const strong = style === "group" || style === "footer" || style === "total";
    prims.push({ kind: "line", a: { x: x0, y }, b: { x: x0 + width, y }, pen: r === 0 || strong ? "medium" : "thin" });
    if (style === "group") {
      prims.push({ kind: "text", at: { x: x0 + PAD_MM, y: y + rowHeight / 2 + textSize / 2 }, text: fit(cells.join(""), width, textSize, true), size: textSize, anchor: "start", bold: true });
      return;
    }
    const bold = style === "footer" || style === "total";
    let x = x0;
    cells.forEach((cell, j) => {
      const w = columnWidths[j] ?? MIN_COL_MM;
      prims.push({ kind: "text", at: { x: x + w / 2, y: y + rowHeight / 2 + textSize / 2 }, text: fit(cell, w, textSize, bold), size: textSize, anchor: "middle", bold });
      x += w;
    });
  });
  if (placeholder) {
    prims.push({ kind: "line", a: { x: x0, y: columnsBottom }, b: { x: x0 + width, y: columnsBottom }, pen: "medium" });
    prims.push({ kind: "text", at: { x: x0 + width / 2, y: columnsBottom + rowHeight / 2 + textSize / 2 }, text: fit(placeholder, width, textSize, false), size: textSize, anchor: "middle", bold: false });
  }
  // Column rules run from the headings down, broken by group headings (which span the table).
  const spans: (readonly [number, number])[] = [];
  if (!styles) spans.push([gridTop, columnsBottom]);
  else {
    let from = gridTop;
    styles.forEach((style, r) => {
      if (style !== "group") return;
      const y = bodyTop + rowHeight * r;
      if (y > from) spans.push([from, y]);
      from = y + rowHeight;
    });
    if (columnsBottom > from) spans.push([from, columnsBottom]);
  }
  let x = x0;
  for (const w of columnWidths.slice(0, -1)) {
    x += w;
    for (const [a, b] of spans) prims.push({ kind: "line", a: { x, y: a }, b: { x, y: b }, pen: "thin" });
  }
}
