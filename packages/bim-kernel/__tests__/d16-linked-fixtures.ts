/**
 * Batch 16-D test fixtures: a synthetic linked building model in the shape a
 * host sends (box and plan hull per element, host mm). No real project data:
 * a "Sample Warehouse" made of rectangles.
 */
import { linkedReferenceRulesOf, type LinkedReferenceElement, type LinkedReferenceModel, type LinkedReferenceRow, type Vec2 } from "../src";

export const LINK_ID = "link-sample-arch";
export const WALL_T = 200;
export const STOREY_TOP = 3600;

/** The rows a building add-on would give (tests stay off the packs). */
export const TEST_ROWS: readonly LinkedReferenceRow[] = [
  { id: "test.walls", label: "Walls", ifcEntities: ["IFCWALL", "IFCWALLSTANDARDCASE"], noun: "wall", snap: true, boundsRooms: true, envelope: "wall" },
  { id: "test.windows", label: "Windows", ifcEntities: ["IFCWINDOW"], noun: "window", snap: true, boundsRooms: false, envelope: "window" },
  { id: "test.columns", label: "Columns", ifcEntities: ["IFCCOLUMN"], noun: "column", snap: true, boundsRooms: false },
];

export const TEST_RULES = linkedReferenceRulesOf(TEST_ROWS, []);

/** A straight wall on its centreline, `WALL_T` thick, carried half a thickness past each end (as exporters overlap corners). */
export function linkedWall(globalId: string, a: Vec2, b: Vec2, opts: { readonly z0?: number; readonly z1?: number; readonly thickness?: number; readonly ifcClass?: string } = {}): LinkedReferenceElement {
  const t = opts.thickness ?? WALL_T;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const nx = -uy * (t / 2);
  const ny = ux * (t / 2);
  const s = { x: a.x - ux * (t / 2), y: a.y - uy * (t / 2) };
  const e = { x: b.x + ux * (t / 2), y: b.y + uy * (t / 2) };
  const corners = [
    { x: s.x + nx, y: s.y + ny },
    { x: e.x + nx, y: e.y + ny },
    { x: e.x - nx, y: e.y - ny },
    { x: s.x - nx, y: s.y - ny },
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return {
    globalId,
    name: `Basic Wall ${globalId}`,
    ifcClass: opts.ifcClass ?? "IFCWALLSTANDARDCASE",
    box: [Math.min(...xs), Math.min(...ys), opts.z0 ?? 0, Math.max(...xs), Math.max(...ys), opts.z1 ?? STOREY_TOP],
    hull: corners.flatMap((c) => [c.x, c.y]),
  };
}

/** A window centred on a wall centreline point, `width` along the wall (axis-aligned walls only). */
export function linkedWindow(globalId: string, at: Vec2, alongX: boolean, width: number, sill = 900, head = 2100): LinkedReferenceElement {
  const hw = width / 2;
  const ht = WALL_T / 2;
  const box: LinkedReferenceElement["box"] = alongX ? [at.x - hw, at.y - ht, sill, at.x + hw, at.y + ht, head] : [at.x - ht, at.y - hw, sill, at.x + ht, at.y + hw, head];
  return { globalId, name: `Window ${globalId}`, ifcClass: "IFCWINDOW", box };
}

/** A building `cols` × `rows` rooms of `bay` mm on centrelines, from (0, 0): outer walls, inner partitions, a window per outside bay. */
export function sampleWarehouse(cols: number, rows: number, bay = 6000): LinkedReferenceModel {
  const elements: LinkedReferenceElement[] = [];
  for (let i = 0; i <= cols; i++) elements.push(linkedWall(`V${i}`, { x: i * bay, y: 0 }, { x: i * bay, y: rows * bay }));
  for (let j = 0; j <= rows; j++) elements.push(linkedWall(`H${j}`, { x: 0, y: j * bay }, { x: cols * bay, y: j * bay }));
  for (let i = 0; i < cols; i++) {
    elements.push(linkedWindow(`WS${i}`, { x: (i + 0.5) * bay, y: 0 }, true, 1200));
    elements.push(linkedWindow(`WN${i}`, { x: (i + 0.5) * bay, y: rows * bay }, true, 1200));
  }
  return { modelId: LINK_ID, label: "Sample Warehouse (architect)", elements };
}

/** Many separate small walls, for the index's speed: `n` walls on a grid, 3 m long, 1 m apart. */
export function manyWalls(n: number): LinkedReferenceModel {
  const side = Math.ceil(Math.sqrt(n));
  const elements: LinkedReferenceElement[] = [];
  for (let k = 0; k < n; k++) {
    const x = (k % side) * 4000;
    const y = Math.floor(k / side) * 1000;
    elements.push(linkedWall(`W${k}`, { x, y }, { x: x + 3000, y }));
  }
  return { modelId: "link-perf", label: "Perf link", elements };
}
