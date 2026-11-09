import { flattenTree, type GridCell, type GridColumn, type GridEditIntent, type GridRows } from "@permitzip/bim-grid";
import type { CellEdit, CellRef, CellValue, ColumnValues, EditingPresence, RowSet, RowSetColumn } from "./contracts";
import { rowIndexOf } from "./apply-patch";
import type { ScheduleUnits } from "./units";

/**
 * Maps a `RowSet` onto the generic grid: formatting through the unit
 * profile, lock reasons, the way to the source of a locked value, save state
 * and other people's presence. Nothing here walks every row: cells are
 * computed when the grid mounts them.
 */

export type CellOverlay =
  | { readonly state: "pending"; readonly text: string }
  | { readonly state: "saved" }
  | { readonly state: "refused"; readonly reason: string; readonly text?: string }
  | { readonly state: "held"; readonly heldBy: string; readonly text: string };

const SEP = "\u001f";

export function cellKey(ref: CellRef): string {
  return ref.parent ? `${ref.parent.rowKey}${SEP}${ref.parent.columnId}${SEP}${ref.rowKey}${SEP}${ref.columnId}` : `${ref.rowKey}${SEP}${ref.columnId}`;
}

function childRowKey(parentKey: string, expandColumn: string, childKey: string): string {
  return `${parentKey}${SEP}${expandColumn}${SEP}${childKey}`;
}

export interface GridModelInput {
  readonly rowSet: RowSet;
  readonly units: ScheduleUnits;
  readonly expanded: ReadonlySet<string>;
  readonly overlays: ReadonlyMap<string, CellOverlay>;
  readonly presence: readonly EditingPresence[];
  readonly explanations: ReadonlyMap<string, string>;
  readonly widths: ReadonlyMap<string, number>;
  readonly onGoToSource?: (column: RowSetColumn, cell: CellRef) => void;
}

export interface GridModel {
  readonly columns: readonly GridColumn[];
  readonly rows: GridRows;
  readonly hierarchical: boolean;
  /** The schedule cell behind a grid cell, plus its column (child column for sub-rows). */
  resolve(gridRowKey: string, gridColumnId: string): { ref: CellRef; column: RowSetColumn | null; elementId: string | null };
}

function editorFor(column: RowSetColumn): GridColumn["editor"] {
  switch (column.valueType) {
    case "quantity":
      return "number";
    case "boolean":
      return "boolean";
    case "choice":
      return "enum";
    default:
      return "text";
  }
}

function defaultWidth(column: RowSetColumn): number {
  if (column.kind === "expand") return 120;
  return column.valueType === "quantity" ? 136 : column.valueType === "boolean" ? 80 : 140;
}

/** Plain reason a locked column can't be typed in, when the engine didn't say. */
export function lockedReasonFor(column: RowSetColumn): string {
  if (column.lockedReason) return column.lockedReason;
  switch (column.kind) {
    case "formula":
      return column.source ? `Calculated by ${column.source.label}.` : "Calculated by a formula.";
    case "aggregate":
      return column.source ? `Totalled from ${column.source.label}.` : "Totalled from related items.";
    case "expand":
      return `Open the ${column.expandLabel ?? column.heading} list to edit its rows.`;
    default:
      return "This value comes from the model and can't be typed here.";
  }
}

function sourceLabel(column: RowSetColumn): string {
  const kind = column.source?.kind;
  return kind === "formula" || kind === "calculation" ? "Go to formula" : "Go to source";
}

export function formatValue(col: ColumnValues | undefined, column: RowSetColumn, i: number, units: ScheduleUnits): string {
  if (!col) return "";
  if (col.type === "quantity") {
    const v = col.values[i] ?? NaN;
    return Number.isNaN(v) ? "" : units.format(col.kind, v, { ...(column.unit ? { unit: column.unit } : {}), ...(column.precision ? { precision: column.precision } : {}) });
  }
  if (col.type === "boolean") {
    const v = col.values[i] ?? -1;
    return v === 1 ? "Yes" : v === 0 ? "No" : "";
  }
  return col.values[i] ?? "";
}

/** The unit after a heading, unless the heading already names it ("CFM", not "CFM (CFM)"). */
function unitSuffix(heading: string, label: string): { readonly unitLabel?: string } {
  if (!label) return {};
  const words = heading.toLowerCase().split(/[^a-z0-9/²³.]+/);
  return words.includes(label.toLowerCase()) ? {} : { unitLabel: label };
}

export function buildGridModel(input: GridModelInput): GridModel {
  const { rowSet, units, expanded, overlays, presence, explanations, widths, onGoToSource } = input;
  const cols = rowSet.columns;
  const expandColumn = cols.find((c) => c.kind === "expand") ?? null;
  const expandChildren = expandColumn ? rowSet.children.get(expandColumn.id) : undefined;

  const presenceByCell = new Map<string, EditingPresence>();
  for (const p of presence) presenceByCell.set(cellKey(p), p);

  const columns: GridColumn[] = cols.map((c) => ({
    id: c.id,
    heading: c.heading,
    width: widths.get(c.id) ?? c.width ?? defaultWidth(c),
    editor: editorFor(c),
    ...(c.choices ? { options: c.choices.map((v) => ({ value: v, label: v })) } : {}),
    align: c.valueType === "quantity" || c.kind === "expand" ? "end" : "start",
    ...(c.valueType === "quantity" && c.quantityKind ? unitSuffix(c.heading, units.heading(c.quantityKind, c.unit ? { unit: c.unit } : undefined)) : {}),
    ...(c.writer === null ? { description: lockedReasonFor(c) } : c.writer.scope === "type" ? { description: "Changes every part of the row's type." } : {}),
  }));

  const flat = flattenTree(rowSet.rowCount, (p) => {
    if (!expandChildren) return 0;
    const key = rowSet.rowKeys[p];
    if (key === undefined || !expanded.has(key)) return 0;
    return expandChildren.get(key)?.rowCount ?? 0;
  });

  const childSet = (p: number): RowSet | undefined => {
    const key = rowSet.rowKeys[p];
    return key === undefined ? undefined : expandChildren?.get(key);
  };

  const colIndexById = new Map(cols.map((c, i) => [c.id, i] as const));
  /** Parent column index → sub-table column: `under` first, then the remaining columns in order. */
  const childAt: (RowSetColumn | undefined)[] = new Array(cols.length);
  if (expandColumn?.childColumns) {
    const rest: RowSetColumn[] = [];
    for (const cc of expandColumn.childColumns) {
      const at = cc.under !== undefined ? colIndexById.get(cc.under) : undefined;
      if (at !== undefined && childAt[at] === undefined) childAt[at] = cc;
      else rest.push(cc);
    }
    for (let i = 0; i < cols.length && rest.length; i++) if (childAt[i] === undefined && cols[i]?.kind !== "expand") childAt[i] = rest.shift();
  }

  const decorate = (ref: CellRef, column: RowSetColumn, base: GridCell): GridCell => {
    const key = cellKey(ref);
    const overlay = overlays.get(key);
    const other = presenceByCell.get(key);
    let cell: GridCell = base;
    if (overlay) {
      if (overlay.state === "pending") cell = { ...cell, state: "pending", display: overlay.text };
      else if (overlay.state === "saved") cell = { ...cell, state: "saved" };
      else if (overlay.state === "refused") cell = { ...cell, state: "refused", refusedReason: overlay.reason, ...(overlay.text !== undefined ? { editText: overlay.text } : {}) };
      else cell = { ...cell, state: "held", heldBy: overlay.heldBy, display: overlay.text };
    }
    if (other) cell = { ...cell, presence: { name: other.actor.name, color: other.actor.color } };
    if (cell.state === "locked") {
      const explain = explanations.get(key);
      cell = {
        ...cell,
        lockedReason: base.lockedReason ?? lockedReasonFor(column),
        ...(explain ? { explain } : {}),
        ...(column.source && onGoToSource ? { sourceAction: { label: sourceLabel(column), run: () => onGoToSource(column, ref) } } : {}),
      };
    }
    return cell;
  };

  /** " for WH-3": names the row so each toggle is distinguishable to a screen reader. */
  const firstColumn = cols.find((c) => c.kind !== "expand");
  const rowName = (p: number): string => {
    if (!firstColumn) return "";
    const name = formatValue(rowSet.values.get(firstColumn.id), firstColumn, p, units);
    return name ? ` for ${name}` : "";
  };

  const rows: GridRows = {
    count: flat.count,
    rowAt(i) {
      const p = flat.parent[i] ?? 0;
      const c = flat.child[i] ?? -1;
      const parentKey = rowSet.rowKeys[p] ?? `#${p}`;
      if (c < 0) {
        const n = childSet(p)?.rowCount ?? 0;
        return {
          key: parentKey,
          depth: 0,
          expandable: expandColumn !== null && n > 0,
          expanded: expanded.has(parentKey),
          expandLabel: `${expandColumn?.expandLabel ?? expandColumn?.heading ?? "rows"} (${n})${rowName(p)}`,
        };
      }
      const sub = childSet(p);
      const childKey = sub?.rowKeys[c] ?? `#${c}`;
      return { key: childRowKey(parentKey, expandColumn?.id ?? "", childKey), depth: 1, expandable: false, expanded: false };
    },
    cellAt(i, columnId) {
      const p = flat.parent[i] ?? 0;
      const c = flat.child[i] ?? -1;
      const colIndex = colIndexById.get(columnId) ?? -1;
      const parentCol = cols[colIndex];
      const gridColumn = columns[colIndex];
      if (!parentCol || !gridColumn) return { display: "", state: "locked", lockedReason: "No such column." };
      const parentKey = rowSet.rowKeys[p] ?? `#${p}`;
      if (c < 0) {
        const ref: CellRef = { rowKey: parentKey, columnId };
        if (parentCol.kind === "expand") {
          const n = rowSet.children.get(parentCol.id)?.get(parentKey)?.rowCount ?? 0;
          return decorate(ref, parentCol, { display: String(n), state: "locked", lockedReason: lockedReasonFor(parentCol) });
        }
        const display = formatValue(rowSet.values.get(columnId), parentCol, p, units);
        const hl = rowSet.highlights?.get(columnId)?.get(parentKey);
        const base: GridCell = { display, state: parentCol.writer ? "editable" : "locked", ...(hl ? { highlight: hl } : {}) };
        return decorate(ref, parentCol, base);
      }
      // A child row of the expanded sub-list: child columns sit under parent columns by position.
      const sub = childSet(p);
      const childCol = childAt[colIndex];
      const childKey = sub?.rowKeys[c] ?? `#${c}`;
      if (!sub || !childCol || !expandColumn) {
        return { display: "", state: "locked", lockedReason: `${expandColumn?.expandLabel ?? "Sub-list"} rows have no value in this column.` };
      }
      const ref: CellRef = { rowKey: childKey, columnId: childCol.id, parent: { rowKey: parentKey, columnId: expandColumn.id } };
      const display = formatValue(sub.values.get(childCol.id), childCol, c, units);
      const sameEditor = editorFor(childCol) === gridColumn.editor;
      const base: GridCell =
        childCol.writer && sameEditor
          ? { display, state: "editable", label: childCol.heading }
          : { display, state: "locked", label: childCol.heading, lockedReason: childCol.writer ? `Edit ${childCol.heading} from the item's own schedule.` : lockedReasonFor(childCol) };
      return decorate(ref, childCol, base);
    },
  };

  return {
    columns,
    rows,
    hierarchical: expandColumn !== null,
    resolve(gridRowKey, gridColumnId) {
      const parts = gridRowKey.split(SEP);
      if (parts.length === 3 && expandColumn) {
        const [parentKey = "", , childKey = ""] = parts;
        const colIndex = colIndexById.get(gridColumnId) ?? -1;
        const childCol = childAt[colIndex] ?? null;
        const sub = expandChildren?.get(parentKey);
        const ci = sub ? sub.rowKeys.indexOf(childKey) : -1;
        return {
          ref: { rowKey: childKey, columnId: childCol?.id ?? gridColumnId, parent: { rowKey: parentKey, columnId: expandColumn.id } },
          column: childCol,
          elementId: sub && ci >= 0 ? (sub.elementIds[ci] ?? null) : null,
        };
      }
      const i = rowIndexOf(rowSet).get(gridRowKey) ?? -1;
      return { ref: { rowKey: gridRowKey, columnId: gridColumnId }, column: cols[colIndexById.get(gridColumnId) ?? -1] ?? null, elementId: i >= 0 ? (rowSet.elementIds[i] ?? null) : null };
    },
  };
}

export interface BatchResult {
  readonly edits: readonly CellEdit[];
  /** Typed text the UI refused before sending (not a number, not a choice), with the typed text kept. */
  readonly refused: readonly { readonly ref: CellRef; readonly reason: string; readonly text: string }[];
  /** Display text per edit, for the pending state. */
  readonly texts: ReadonlyMap<string, string>;
}

/** Turns a grid intent into typed cell edits: parses units, checks choices, and keeps skipped-cell reasons. */
export function intentToEdits(intent: GridEditIntent, model: GridModel, units: ScheduleUnits): BatchResult {
  const edits: CellEdit[] = [];
  const refused: { ref: CellRef; reason: string; text: string }[] = [];
  const texts = new Map<string, string>();
  for (const e of intent.edits) {
    const { ref, column } = model.resolve(e.rowKey, e.columnId);
    if (!column || !column.writer) {
      refused.push({ ref, reason: column ? lockedReasonFor(column) : "That cell isn't in this schedule.", text: e.text });
      continue;
    }
    const text = e.text.trim();
    let value: CellValue;
    if (text === "") value = null;
    else if (column.valueType === "quantity" && column.quantityKind) {
      const parsed = units.parse(text, column.quantityKind, column.unit ? { unit: column.unit } : undefined);
      if (!parsed.ok) {
        refused.push({ ref, reason: parsed.message, text: e.text });
        continue;
      }
      value = parsed.si;
    } else if (column.valueType === "boolean") {
      const t = text.toLowerCase();
      if (t === "true" || t === "yes" || t === "y" || t === "1") value = true;
      else if (t === "false" || t === "no" || t === "n" || t === "0") value = false;
      else {
        refused.push({ ref, reason: `${column.heading} is Yes or No.`, text: e.text });
        continue;
      }
    } else if (column.valueType === "choice" && column.choices) {
      const match = column.choices.find((c) => c.toLowerCase() === text.toLowerCase());
      if (!match) {
        refused.push({ ref, reason: `Pick one of: ${column.choices.slice(0, 8).join(", ")}${column.choices.length > 8 ? ", …" : ""}.`, text: e.text });
        continue;
      }
      value = match;
    } else value = text;
    edits.push({ ...ref, value });
    texts.set(cellKey(ref), e.text);
  }
  for (const s of intent.skipped) {
    const { ref } = model.resolve(s.rowKey, s.columnId);
    refused.push({ ref, reason: s.reason, text: "" });
  }
  return { edits, refused, texts };
}

/** CSV of the visible schedule (parents only), as printed values. */
export function rowSetToCsv(rowSet: RowSet, units: ScheduleUnits): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const cols = rowSet.columns.filter((c) => c.kind !== "expand");
  const head = cols.map((c) => {
    const unit = c.valueType === "quantity" && c.quantityKind ? units.heading(c.quantityKind, c.unit ? { unit: c.unit } : undefined) : "";
    return esc(unit ? `${c.heading} (${unit})` : c.heading);
  });
  const lines = [head.join(",")];
  for (let i = 0; i < rowSet.rowCount; i++) lines.push(cols.map((c) => esc(formatValue(rowSet.values.get(c.id), c, i, units))).join(","));
  return lines.join("\n");
}
