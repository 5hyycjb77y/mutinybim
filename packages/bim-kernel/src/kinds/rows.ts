import { elementKindTable, kernelKindRow, registerKernelKindRows, type ElementKindItem, type ElementKindTable } from "../registry/element-kind-point";
import type { BimElement, Vec2 } from "../types";
import { lineJoinPlanGraphics } from "../joins/plan";

/**
 * One record registry (round 11): every stored kind is one row of the same
 * shape (`ElementKindItem`). Add-ons contribute theirs to `ELEMENT_KIND_POINT`;
 * the kernel's own kinds (here) and the record kinds it keeps
 * (`kinds/records/`) are kernel rows, registered once per process.
 * `anchorOf` and every reader that asks "what is this kind" read the row,
 * never a switch over kinds.
 *
 * Kernel rows are never contributed to the point: a pack may not register a
 * kind the kernel keeps a row for (`elementKindRowProblems`), so the two
 * never overlap, and the point's table keeps listing add-on kinds only (the
 * sync hub's older-peer lowering and the edit hook's fast path read it).
 */

type KindOf<K extends BimElement["kind"]> = Extract<BimElement, { kind: K }>;

function midpoint(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
}

function centroid(points: readonly Vec2[]): Vec2 {
  if (points.length === 0) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  const k = 1 / points.length;
  return { x: x * k, y: y * k };
}

/** A kernel kind's row: its label, nature and where one sits. `anchor` sees only records of `kind` (anything else sits nowhere). */
function row<K extends BimElement["kind"]>(kind: K, label: string, nature: ElementKindItem["nature"], anchor?: (el: KindOf<K>) => Vec2 | null): ElementKindItem {
  if (anchor === undefined) return { kind, label, nature };
  return { kind, label, nature, anchor: (el: BimElement) => (el.kind === kind ? anchor(el as KindOf<K>) : null) };
}

const positionOf = (el: { readonly position: Vec2 }): Vec2 => el.position;
const midpointOf = (el: { readonly start: Vec2; readonly end: Vec2 }): Vec2 => midpoint(el.start, el.end);
const centroidOf = (el: { readonly outline: readonly Vec2[] }): Vec2 => centroid(el.outline);

/**
 * The kernel's own kinds (`KERNEL_ELEMENT_KINDS`), one row each. Where each
 * sits is exactly round 10's `anchorOf`: a point kind at its position, a
 * linear kind at its midpoint, an outline at its centroid; documents,
 * records, types and settings nowhere.
 */
export const KERNEL_KIND_ROWS: readonly ElementKindItem[] = [
  { ...row("wall", "Wall", "physical", midpointOf), planGraphics: lineJoinPlanGraphics },
  row("slab", "Slab", "physical", centroidOf),
  row("opening", "Opening", "physical", positionOf),
  row("room", "Room", "physical", centroidOf),
  row("grid", "Grid line", "physical", midpointOf),
  row("column", "Column", "physical", positionOf),
  row("beam", "Beam", "physical", midpointOf),
  row("riser_segment", "Riser segment", "physical", positionOf),
  row("component", "Component", "physical", positionOf),
  row("view", "View", "document"),
  row("sheet", "Sheet", "document"),
  row("tag", "Tag", "document"),
  row("dimension", "Dimension", "document"),
  row("viewport", "Viewport", "document"),
  row("drawing_item", "Drawing item", "document"),
  row("level", "Level", "physical"),
  row("part_type", "Part type", "record"),
  row("element_type", "Element type", "record"),
  row("part", "Part", "physical", positionOf),
  row("mounting_plane", "Mounting plane", "physical", (el) => midpoint(el.min, el.max)),
  row("mep_system", "System", "record"),
  row("run_segment", "Run segment", "physical", (el) => midpoint(el.start, el.end)),
  row("run_fitting", "Run fitting", "physical", (el) => ({ x: el.position.x, y: el.position.y })),
  row("organization", "Organization setting", "record"),
  row("site", "Site", "record"),
  row("service_link", "Served-from link", "record"),
  row("service_catalog", "Service catalog", "record"),
  row("load_point", "Load point", "physical"),
  row("space", "Space", "physical", (el) => ((el.bounds.kind === "outline" || el.bounds.kind === "bounded") && el.bounds.outline.length > 0 ? centroid(el.bounds.outline) : null)),
  row("zone", "Zone", "physical"),
  row("drawing_underlay", "Underlay", "document"),
  row("question", "Question", "record", (el) => el.anchor.point?.position ?? null),
  row("ceiling", "Ceiling", "physical", centroidOf),
  row("determination", "Determination", "record"),
  row("rule", "Rule", "record"),
  row("requirement_state", "Requirement state", "record"),
  row("observation", "Observation", "record"),
  row("construction_stage", "Construction stage", "record"),
  row("space_separator", "Separation line", "physical", midpointOf),
  row("reference_plane", "Reference plane", "document", midpointOf),
];

registerKernelKindRows("kernel.kinds", KERNEL_KIND_ROWS);

/** The row for `kind`: the kernel's own, else the set in force's add-on row; undefined when neither names it (kept as stored). */
export function kindRowOf(kind: string, table: ElementKindTable = elementKindTable()): ElementKindItem | undefined {
  return kernelKindRow(kind) ?? table.row(kind);
}
