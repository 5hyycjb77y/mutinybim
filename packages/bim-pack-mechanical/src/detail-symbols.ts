import { symbolOfComponent, type Symbol2D, type SymbolDef } from "@permitzip/bim-kernel";

/**
 * Standard 2D mechanical detailing components contributed by the Mechanical
 * add-on (`SYMBOL_POINT`). Every symbol uses a unit box (0..1 × 0..1) scaled
 * to its real-world dimensions at placement time, following SMACNA / ASHRAE
 * mechanical drafting conventions.
 */

const IN = 25.4;

export const MECHANICAL_DETAIL_COMPONENTS: readonly Symbol2D[] = [
  {
    id: "mechanical.volume_damper",
    name: "Volume damper (quadrant)",
    category: "duct",
    widthMm: 10 * IN,
    heightMm: 12 * IN,
    prims: [
      { k: "line", pts: [[0.5, 0.08], [0.5, 0.92]], pen: "thin", pattern: "center" },
      { k: "line", pts: [[0.2, 0.15], [0.8, 0.85]], pen: "wide" },
      { k: "circle", c: [0.5, 0.5], r: 0.07, pen: "medium" },
      { k: "line", pts: [[0.5, 0.92], [0.5, 1.0], [0.72, 1.0]], pen: "medium" },
    ],
  },
  {
    id: "mechanical.backdraft_damper",
    name: "Backdraft damper (BDD)",
    category: "duct",
    widthMm: 8 * IN,
    heightMm: 10 * IN,
    prims: [
      { k: "line", pts: [[0.15, 0], [0.15, 1]], pen: "medium" },
      { k: "line", pts: [[0.15, 0.9], [0.85, 0.2]], pen: "wide" },
      { k: "circle", c: [0.15, 0.9], r: 0.06, pen: "medium" },
      { k: "fill", pts: [[0.78, 0.14], [0.92, 0.2], [0.78, 0.26]], grey: 0 },
    ],
  },
  {
    id: "mechanical.fire_damper",
    name: "Fire damper (in rated sleeve)",
    category: "duct",
    widthMm: 12 * IN,
    heightMm: 14 * IN,
    prims: [
      { k: "line", pts: [[0, 0.08], [1, 0.08], [1, 0.92], [0, 0.92], [0, 0.08]], pen: "wide" },
      { k: "line", pts: [[0.12, 0.08], [0.12, 0.92]], pen: "medium" },
      { k: "line", pts: [[0.88, 0.08], [0.88, 0.92]], pen: "medium" },
      { k: "line", pts: [[0.2, 0.86], [0.8, 0.14]], pen: "wide" },
      { k: "line", pts: [[0.2, 0.86], [0.8, 0.86]], pen: "thin" },
      { k: "line", pts: [[0.2, 0.78], [0.8, 0.78]], pen: "thin" },
    ],
  },
  {
    id: "mechanical.turning_vanes",
    name: "Turning vanes (duct elbow)",
    category: "duct",
    widthMm: 16 * IN,
    heightMm: 16 * IN,
    prims: [
      { k: "line", pts: [[0.05, 0.95], [0.95, 0.05]], pen: "thin", pattern: "dashed" },
      { k: "line", pts: [[0.14, 0.82], [0.22, 0.72], [0.34, 0.68]], pen: "medium" },
      { k: "line", pts: [[0.34, 0.62], [0.42, 0.52], [0.54, 0.48]], pen: "medium" },
      { k: "line", pts: [[0.54, 0.42], [0.62, 0.32], [0.74, 0.28]], pen: "medium" },
      { k: "line", pts: [[0.74, 0.22], [0.82, 0.12], [0.94, 0.08]], pen: "medium" },
    ],
  },
  {
    id: "mechanical.hooded_louver",
    name: "Hooded exterior wall cap (w/ bird screen & BDD)",
    category: "duct",
    widthMm: 10 * IN,
    heightMm: 10 * IN,
    prims: [
      // Wall mounting flange
      { k: "fill", pts: [[0, 0.04], [0.1, 0.04], [0.1, 0.96], [0, 0.96]], grey: 0.75 },
      { k: "line", pts: [[0, 0.04], [0.1, 0.04], [0.1, 0.96], [0, 0.96], [0, 0.04]], pen: "wide" },
      // Sloped rain hood outer profile
      { k: "line", pts: [[0.1, 0.88], [0.96, 0.42], [0.96, 0.14], [0.1, 0.14]], pen: "wide" },
      // Backdraft damper blade inside hood
      { k: "line", pts: [[0.16, 0.76], [0.58, 0.28]], pen: "medium" },
      { k: "circle", c: [0.16, 0.76], r: 0.045, pen: "medium" },
      // 1/4" bird screen mesh lines at bottom discharge opening
      { k: "line", pts: [[0.16, 0.14], [0.92, 0.14]], pen: "thin", pattern: "dotted" },
      { k: "line", pts: [[0.24, 0.14], [0.24, 0.2]], pen: "thin" },
      { k: "line", pts: [[0.4, 0.14], [0.4, 0.2]], pen: "thin" },
      { k: "line", pts: [[0.56, 0.14], [0.56, 0.2]], pen: "thin" },
      { k: "line", pts: [[0.72, 0.14], [0.72, 0.2]], pen: "thin" },
      { k: "line", pts: [[0.86, 0.14], [0.86, 0.2]], pen: "thin" },
    ],
  },
  {
    id: "mechanical.wall_louver",
    name: "Exterior wall louver (drainable blades)",
    category: "duct",
    widthMm: 6 * IN,
    heightMm: 24 * IN,
    prims: [
      { k: "line", pts: [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]], pen: "wide" },
      { k: "line", pts: [[0.12, 0.12], [0.88, 0.24]], pen: "medium" },
      { k: "line", pts: [[0.12, 0.28], [0.88, 0.4]], pen: "medium" },
      { k: "line", pts: [[0.12, 0.44], [0.88, 0.56]], pen: "medium" },
      { k: "line", pts: [[0.12, 0.6], [0.88, 0.72]], pen: "medium" },
      { k: "line", pts: [[0.12, 0.76], [0.88, 0.88]], pen: "medium" },
      { k: "line", pts: [[0.92, 0.04], [0.92, 0.96]], pen: "thin", pattern: "dotted" },
    ],
  },
  {
    id: "mechanical.concentric_diffuser",
    name: "Concentric diffuser box (4-way supply + return)",
    category: "duct",
    widthMm: 36 * IN,
    heightMm: 14 * IN,
    prims: [
      // Outer plenum box
      { k: "line", pts: [[0.06, 0.12], [0.94, 0.12], [0.94, 1], [0.06, 1], [0.06, 0.12]], pen: "wide" },
      // Ceiling flange trim
      { k: "line", pts: [[0, 0.06], [1, 0.06], [1, 0.12], [0, 0.12], [0, 0.06]], pen: "medium" },
      // Inner return divider walls
      { k: "line", pts: [[0.34, 0.12], [0.34, 1]], pen: "medium" },
      { k: "line", pts: [[0.66, 0.12], [0.66, 1]], pen: "medium" },
      // Supply louver blades (left & right slots)
      { k: "line", pts: [[0.1, 0.28], [0.3, 0.16]], pen: "thin" },
      { k: "line", pts: [[0.1, 0.44], [0.3, 0.32]], pen: "thin" },
      { k: "line", pts: [[0.9, 0.28], [0.7, 0.16]], pen: "thin" },
      { k: "line", pts: [[0.9, 0.44], [0.7, 0.32]], pen: "thin" },
      // Center eggcrate return grille ticks
      { k: "line", pts: [[0.38, 0.12], [0.38, 0.22]], pen: "thin" },
      { k: "line", pts: [[0.44, 0.12], [0.44, 0.22]], pen: "thin" },
      { k: "line", pts: [[0.5, 0.12], [0.5, 0.22]], pen: "thin" },
      { k: "line", pts: [[0.56, 0.12], [0.56, 0.22]], pen: "thin" },
      { k: "line", pts: [[0.62, 0.12], [0.62, 0.22]], pen: "thin" },
    ],
  },
  {
    id: "mechanical.exhaust_fan_ceiling",
    name: "Ceiling cabinet exhaust fan (section)",
    category: "duct",
    widthMm: 14 * IN,
    heightMm: 12 * IN,
    prims: [
      // Sheet-metal fan housing
      { k: "line", pts: [[0.08, 0.1], [0.92, 0.1], [0.92, 0.96], [0.08, 0.96], [0.08, 0.1]], pen: "wide" },
      // Ceiling grille bezel
      { k: "line", pts: [[0, 0], [1, 0], [1, 0.1], [0, 0.1], [0, 0]], pen: "medium" },
      // Grille louver bars
      { k: "line", pts: [[0.2, 0], [0.2, 0.1]], pen: "thin" },
      { k: "line", pts: [[0.4, 0], [0.4, 0.1]], pen: "thin" },
      { k: "line", pts: [[0.6, 0], [0.6, 0.1]], pen: "thin" },
      { k: "line", pts: [[0.8, 0], [0.8, 0.1]], pen: "thin" },
      // Squirrel-cage blower wheel + motor housing inside
      { k: "circle", c: [0.48, 0.56], r: 0.24, pen: "medium" },
      { k: "circle", c: [0.48, 0.56], r: 0.08, pen: "thin" },
      // Discharge collar on right side
      { k: "line", pts: [[0.92, 0.34], [1, 0.34]], pen: "medium" },
      { k: "line", pts: [[0.92, 0.72], [1, 0.72]], pen: "medium" },
    ],
  },
  {
    id: "mechanical.roof_curb_rail",
    name: "Insulated roof curb wall section (w/ nailer & cant)",
    category: "structure",
    widthMm: 8 * IN,
    heightMm: 14 * IN,
    prims: [
      // Heavy-gauge galvanized curb shell sitting squarely on roof deck (y=0) up to RTU base rail (y=1)
      { k: "fill", pts: [[0.35, 0], [0.75, 0], [0.75, 1], [0.35, 1]], grey: 0.94 },
      { k: "line", pts: [[0.35, 0], [0.35, 1], [0.95, 1], [0.95, 0.9], [0.75, 0.9], [0.75, 0], [0.35, 0]], pen: "wide" },
      // Wood nailer block at top of curb (X-braced)
      { k: "line", pts: [[0.35, 0.84], [0.75, 0.84]], pen: "medium" },
      { k: "line", pts: [[0.35, 0.84], [0.75, 1]], pen: "thin" },
      { k: "line", pts: [[0.35, 1], [0.75, 0.84]], pen: "thin" },
      // Rigid insulation inside curb cavity
      { k: "line", pts: [[0.42, 0.04], [0.68, 0.8]], pen: "thin" },
      { k: "line", pts: [[0.68, 0.04], [0.42, 0.8]], pen: "thin" },
      // 45° triangular cant strip resting flush on top of roof membrane (y=0) against curb exterior
      { k: "fill", pts: [[0, 0], [0.35, 0], [0.35, 0.28]], grey: 0.88 },
      { k: "line", pts: [[0, 0], [0.35, 0], [0.35, 0.28], [0, 0]], pen: "medium" },
      // Counterflashing skirt down outside of curb over base flashing
      { k: "line", pts: [[0.31, 0.88], [0.31, 0.36], [0.23, 0.30]], pen: "medium" },
    ],
  },
  {
    id: "mechanical.flex_connector",
    name: "Flexible duct vibration connector",
    category: "duct",
    widthMm: 4 * IN,
    heightMm: 16 * IN,
    prims: [
      { k: "line", pts: [[0, 0], [0, 1]], pen: "wide" },
      { k: "line", pts: [[1, 0], [1, 1]], pen: "wide" },
      { k: "line", pts: [[0, 0.04], [0.5, 0.16], [1, 0.04]], pen: "medium" },
      { k: "line", pts: [[0, 0.96], [0.5, 0.84], [1, 0.96]], pen: "medium" },
      { k: "line", pts: [[0.5, 0.16], [0.5, 0.84]], pen: "thin", pattern: "dashed" },
    ],
  },
  {
    id: "mechanical.cant_strip",
    name: "Roof cant strip (45°)",
    category: "structure",
    widthMm: 4 * IN,
    heightMm: 4 * IN,
    prims: [
      { k: "fill", pts: [[0, 0], [1, 0], [1, 1]], grey: 0.88 },
      { k: "line", pts: [[0, 0], [1, 0], [1, 1], [0, 0]], pen: "medium" },
    ],
  },
  {
    id: "mechanical.duct_liner_section",
    name: "Acoustic duct liner (linear strip)",
    category: "insulation",
    widthMm: 24 * IN,
    heightMm: 1 * IN,
    linear: true,
    prims: [
      { k: "fill", pts: [[0, 0], [1, 0], [1, 1], [0, 1]], grey: 0.9 },
      { k: "line", pts: [[0, 0], [1, 0]], pen: "thin", pattern: "dashed" },
      { k: "line", pts: [[0, 1], [1, 1]], pen: "thin", pattern: "dashed" },
      ...Array.from({ length: 12 }, (_, i) => ({
        k: "line" as const,
        pts: [[i / 12, 0.1], [(i + 0.7) / 12, 0.9]] as const,
        pen: "thin" as const,
      })),
    ],
  },
];

export const MECHANICAL_DETAIL_SYMBOLS: readonly SymbolDef[] = MECHANICAL_DETAIL_COMPONENTS.map(symbolOfComponent);
