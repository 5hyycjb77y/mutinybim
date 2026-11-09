import type { Symbol2D, SymbolPrim } from "@permitzip/bim-kernel";

/**
 * Electrical one-line (single-line) symbols for the 2D detail component
 * library, in the usual ANSI / IEEE one-line style: power flows top to bottom,
 * the line (supply) terminal at the top centre and the load terminal at the
 * bottom centre of each symbol's unit box. Sized for a drafting view at
 * SCALE: NONE (1 drawing mm = 1 paper mm); give a width and height to use one
 * at another scale.
 *
 * Letters inside symbols (G, M, ATS…) are strokes, so the symbol prints the
 * same everywhere without a font.
 */

const IN = 25.4;

type Pt = readonly [number, number];

/** Stroke glyphs in a unit cell (x 0..1 across, y 0..1 up). */
const GLYPHS: Readonly<Record<string, readonly (readonly Pt[])[]>> = {
  A: [[[0, 0], [0.5, 1], [1, 0]], [[0.2, 0.4], [0.8, 0.4]]],
  B: [[[0, 0], [0, 1], [0.7, 1], [0.9, 0.85], [0.9, 0.62], [0.7, 0.5], [0, 0.5]], [[0.7, 0.5], [1, 0.36], [1, 0.14], [0.75, 0], [0, 0]]],
  C: [[[1, 0.85], [0.75, 1], [0.25, 1], [0, 0.75], [0, 0.25], [0.25, 0], [0.75, 0], [1, 0.15]]],
  D: [[[0, 0], [0, 1], [0.6, 1], [1, 0.7], [1, 0.3], [0.6, 0], [0, 0]]],
  F: [[[1, 1], [0, 1], [0, 0]], [[0, 0.5], [0.7, 0.5]]],
  G: [[[1, 0.85], [0.75, 1], [0.25, 1], [0, 0.75], [0, 0.25], [0.25, 0], [0.75, 0], [1, 0.15], [1, 0.45], [0.55, 0.45]]],
  H: [[[0, 0], [0, 1]], [[1, 0], [1, 1]], [[0, 0.5], [1, 0.5]]],
  L: [[[0, 1], [0, 0], [1, 0]]],
  M: [[[0, 0], [0, 1], [0.5, 0.45], [1, 1], [1, 0]]],
  N: [[[0, 0], [0, 1], [1, 0], [1, 1]]],
  P: [[[0, 0], [0, 1], [0.75, 1], [1, 0.85], [1, 0.6], [0.75, 0.45], [0, 0.45]]],
  S: [[[1, 0.85], [0.75, 1], [0.25, 1], [0, 0.8], [0.1, 0.55], [0.9, 0.45], [1, 0.2], [0.75, 0], [0.25, 0], [0, 0.15]]],
  T: [[[0, 1], [1, 1]], [[0.5, 1], [0.5, 0]]],
  U: [[[0, 1], [0, 0.25], [0.25, 0], [0.75, 0], [1, 0.25], [1, 1]]],
  V: [[[0, 1], [0.5, 0], [1, 1]]],
  W: [[[0, 1], [0.25, 0], [0.5, 0.6], [0.75, 0], [1, 1]]],
};

/**
 * `text` centred at (cx, cy) in the unit box, letters `h` tall (unit box
 * heights). `aspect` is the symbol's width / height, so letters keep their
 * shape in a box that is not square.
 */
function letters(text: string, cx: number, cy: number, h: number, aspect: number): SymbolPrim[] {
  const w = (h * 0.62) / aspect;
  const gap = (h * 0.28) / aspect;
  const total = text.length * w + (text.length - 1) * gap;
  const out: SymbolPrim[] = [];
  [...text].forEach((ch, i) => {
    const glyph = GLYPHS[ch];
    if (!glyph) throw new Error(`No stroke glyph for "${ch}"`);
    const x0 = cx - total / 2 + i * (w + gap);
    for (const stroke of glyph) out.push({ k: "line", pts: stroke.map(([x, y]) => [x0 + x * w, cy - h / 2 + y * h] as const), pen: "thin" });
  });
  return out;
}

const box: SymbolPrim = { k: "line", pts: [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]], pen: "medium" };
const ring: SymbolPrim = { k: "circle", c: [0.5, 0.5], r: 0.5, pen: "medium" };
const through = (y0: number, y1: number): SymbolPrim => ({ k: "line", pts: [[0.5, y0], [0.5, y1]], pen: "medium" });

/** Points on an ellipse quadrant sweep in the unit box. */
function arc(cx: number, cy: number, rx: number, ry: number, fromDeg: number, toDeg: number, steps = 16): Pt[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = ((fromDeg + ((toDeg - fromDeg) * i) / steps) * Math.PI) / 180;
    return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)] as const;
  });
}

const sine: Pt[] = Array.from({ length: 25 }, (_, i) => [0.22 + (0.56 * i) / 24, 0.5 + 0.13 * Math.sin((i / 24) * 2 * Math.PI)] as const);

/** Line in at the top centre, load out at the bottom centre. */
const LINE_LOAD = { line: [0.5, 1], load: [0.5, 0] } as const;

export const ELECTRICAL_COMPONENTS: readonly Symbol2D[] = [
  {
    id: "elec_utility_source",
    name: "Utility source (AC)",
    category: "electrical",
    widthMm: 0.55 * IN,
    heightMm: 0.55 * IN,
    terminals: { load: [0.5, 0] },
    prims: [ring, { k: "line", pts: sine, pen: "medium" }],
  },
  {
    id: "elec_meter",
    name: "Utility meter",
    category: "electrical",
    widthMm: 0.45 * IN,
    heightMm: 0.45 * IN,
    terminals: LINE_LOAD,
    prims: [ring, ...letters("WH", 0.5, 0.5, 0.32, 1)],
  },
  {
    id: "elec_current_transformer",
    name: "Current transformer",
    category: "electrical",
    widthMm: 0.3 * IN,
    heightMm: 0.3 * IN,
    terminals: LINE_LOAD,
    prims: [through(0, 1), { k: "circle", c: [0.5, 0.5], r: 0.32, pen: "thin" }],
  },
  {
    id: "elec_ct_cabinet",
    name: "CT cabinet",
    category: "electrical",
    widthMm: 0.6 * IN,
    heightMm: 0.45 * IN,
    terminals: LINE_LOAD,
    prims: [box, ...letters("CT", 0.5, 0.5, 0.42, 0.6 / 0.45)],
  },
  {
    id: "elec_breaker",
    name: "Circuit breaker",
    category: "electrical",
    widthMm: 0.3 * IN,
    heightMm: 0.6 * IN,
    terminals: LINE_LOAD,
    prims: [through(0, 0.25), { k: "line", pts: arc(0.5, 0.5, 0.5, 0.25, -90, 90), pen: "medium" }, through(0.75, 1)],
  },
  {
    id: "elec_breaker_drawout",
    name: "Circuit breaker, draw-out",
    category: "electrical",
    widthMm: 0.3 * IN,
    heightMm: 0.8 * IN,
    terminals: LINE_LOAD,
    prims: [
      through(0, 0.3),
      { k: "line", pts: [[0.15, 0.2], [0.5, 0.13], [0.85, 0.2]], pen: "thin" },
      { k: "line", pts: arc(0.5, 0.5, 0.5, 0.2, -90, 90), pen: "medium" },
      { k: "line", pts: [[0.15, 0.8], [0.5, 0.87], [0.85, 0.8]], pen: "thin" },
      through(0.7, 1),
    ],
  },
  {
    id: "elec_fuse",
    name: "Fuse",
    category: "electrical",
    widthMm: 0.25 * IN,
    heightMm: 0.6 * IN,
    terminals: LINE_LOAD,
    prims: [{ k: "line", pts: [[0.1, 0.25], [0.9, 0.25], [0.9, 0.75], [0.1, 0.75], [0.1, 0.25]], pen: "medium" }, through(0, 1)],
  },
  {
    id: "elec_disconnect",
    name: "Disconnect switch, non-fused",
    category: "electrical",
    widthMm: 0.4 * IN,
    heightMm: 0.6 * IN,
    terminals: LINE_LOAD,
    prims: [through(0, 0.3), { k: "line", pts: [[0.5, 0.3], [0.92, 0.68]], pen: "medium" }, { k: "line", pts: [[0.32, 0.72], [0.68, 0.72]], pen: "medium" }, through(0.72, 1)],
  },
  {
    id: "elec_disconnect_fused",
    name: "Disconnect switch, fused",
    category: "electrical",
    widthMm: 0.4 * IN,
    heightMm: 0.9 * IN,
    terminals: LINE_LOAD,
    prims: [
      through(0, 0.12),
      { k: "line", pts: [[0.3, 0.12], [0.7, 0.12], [0.7, 0.4], [0.3, 0.4], [0.3, 0.12]], pen: "medium" },
      through(0.12, 0.5),
      { k: "line", pts: [[0.5, 0.5], [0.92, 0.77]], pen: "medium" },
      { k: "line", pts: [[0.32, 0.8], [0.68, 0.8]], pen: "medium" },
      through(0.8, 1),
    ],
  },
  {
    id: "elec_contactor",
    name: "Contactor, normally open",
    category: "electrical",
    widthMm: 0.4 * IN,
    heightMm: 0.5 * IN,
    terminals: LINE_LOAD,
    prims: [through(0, 0.4), { k: "line", pts: [[0.1, 0.4], [0.9, 0.4]], pen: "medium" }, { k: "line", pts: [[0.1, 0.6], [0.9, 0.6]], pen: "medium" }, through(0.6, 1)],
  },
  {
    id: "elec_transformer",
    name: "Transformer, two winding",
    category: "electrical",
    widthMm: 0.5 * IN,
    heightMm: 0.8 * IN,
    terminals: LINE_LOAD,
    prims: [
      through(0.884, 1),
      { k: "circle", c: [0.5, 0.69], r: 0.31, pen: "medium" },
      { k: "circle", c: [0.5, 0.31], r: 0.31, pen: "medium" },
      through(0, 0.116),
    ],
  },
  {
    id: "elec_generator",
    name: "Generator",
    category: "electrical",
    widthMm: 0.55 * IN,
    heightMm: 0.55 * IN,
    terminals: { load: [0.5, 0] },
    prims: [ring, ...letters("G", 0.5, 0.5, 0.42, 1)],
  },
  {
    id: "elec_motor",
    name: "Motor",
    category: "electrical",
    widthMm: 0.45 * IN,
    heightMm: 0.45 * IN,
    terminals: { line: [0.5, 1] },
    prims: [ring, ...letters("M", 0.5, 0.5, 0.42, 1)],
  },
  {
    id: "elec_ats",
    name: "Automatic transfer switch",
    category: "electrical",
    widthMm: 0.8 * IN,
    heightMm: 0.5 * IN,
    terminals: { line: [0.3, 1], emergency: [0.7, 1], load: [0.5, 0] },
    prims: [box, ...letters("ATS", 0.5, 0.5, 0.4, 0.8 / 0.5)],
  },
  {
    id: "elec_vfd",
    name: "Variable frequency drive",
    category: "electrical",
    widthMm: 0.8 * IN,
    heightMm: 0.45 * IN,
    terminals: LINE_LOAD,
    prims: [box, ...letters("VFD", 0.5, 0.5, 0.42, 0.8 / 0.45)],
  },
  {
    id: "elec_ups",
    name: "Uninterruptible power supply",
    category: "electrical",
    widthMm: 0.8 * IN,
    heightMm: 0.45 * IN,
    terminals: LINE_LOAD,
    prims: [box, ...letters("UPS", 0.5, 0.5, 0.42, 0.8 / 0.45)],
  },
  {
    id: "elec_switchboard",
    name: "Switchboard",
    category: "electrical",
    widthMm: 1.2 * IN,
    heightMm: 0.45 * IN,
    terminals: LINE_LOAD,
    prims: [box, ...letters("SWBD", 0.5, 0.5, 0.42, 1.2 / 0.45)],
  },
  {
    id: "elec_panelboard",
    name: "Panelboard",
    category: "electrical",
    widthMm: 0.9 * IN,
    heightMm: 0.45 * IN,
    terminals: LINE_LOAD,
    prims: [box, ...letters("PNL", 0.5, 0.5, 0.42, 0.9 / 0.45)],
  },
  {
    id: "elec_mcc",
    name: "Motor control center",
    category: "electrical",
    widthMm: 0.9 * IN,
    heightMm: 0.45 * IN,
    terminals: LINE_LOAD,
    prims: [box, ...letters("MCC", 0.5, 0.5, 0.42, 0.9 / 0.45)],
  },
  {
    id: "elec_bus",
    name: "Bus (switchboard, panelboard or MCC)",
    category: "electrical",
    widthMm: 3 * IN,
    heightMm: 0.12 * IN,
    linear: true,
    prims: [{ k: "line", pts: [[0, 0.5], [1, 0.5]], pen: "heavy" }],
  },
  {
    id: "elec_busway",
    name: "Busway",
    category: "electrical",
    widthMm: 3 * IN,
    heightMm: 0.14 * IN,
    linear: true,
    prims: [
      { k: "line", pts: [[0, 0.1], [1, 0.1]], pen: "medium" },
      { k: "line", pts: [[0, 0.9], [1, 0.9]], pen: "medium" },
      ...Array.from({ length: 12 }, (_, i): SymbolPrim => ({ k: "line", pts: [[(i + 0.5) / 12 - 0.02, 0.1], [(i + 0.5) / 12 + 0.02, 0.9]], pen: "thin" })),
    ],
  },
  {
    id: "elec_ground",
    name: "Ground",
    category: "electrical",
    widthMm: 0.4 * IN,
    heightMm: 0.35 * IN,
    terminals: { line: [0.5, 1] },
    prims: [
      through(0.55, 1),
      { k: "line", pts: [[0.05, 0.55], [0.95, 0.55]], pen: "medium" },
      { k: "line", pts: [[0.22, 0.32], [0.78, 0.32]], pen: "medium" },
      { k: "line", pts: [[0.38, 0.09], [0.62, 0.09]], pen: "medium" },
    ],
  },
  {
    id: "elec_surge_protector",
    name: "Surge protective device",
    category: "electrical",
    widthMm: 0.6 * IN,
    heightMm: 0.4 * IN,
    terminals: { line: [0.5, 1] },
    prims: [box, ...letters("SPD", 0.5, 0.5, 0.42, 0.6 / 0.4)],
  },
  {
    id: "elec_equipment",
    name: "Equipment or load (box)",
    category: "electrical",
    widthMm: 0.8 * IN,
    heightMm: 0.45 * IN,
    terminals: { line: [0.5, 1] },
    prims: [box],
  },
];
