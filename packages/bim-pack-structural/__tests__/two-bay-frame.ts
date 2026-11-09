import { asElementId, asRevision, DEFAULT_SETTINGS, type BimElement, type Beam, type Column, type Component, type ElementId, type ElementTypeElement, type Level, type ModelState, type PartInstance, type PartTypeElement, type Slab, type Vec2 } from "@permitzip/bim-kernel/types";

/**
 * A synthetic two-bay steel roof frame (no client data). Plan, feet:
 *
 *        x = 0            x = 30
 *  line 3  C3A ── B3 ──── C3B     y = 50
 *           |              |
 *  line 2  C2A ── B2 ──── C2B     y = 25      RTU-1 on B2 at x = 10
 *           |              |
 *  line 1  C1A ── B1 ──── C1B     y = 0
 *
 * Three column lines (1, 2, 3), two 25 ft bays between them. W16X26 beams
 * span 30 ft along x on each line; the roof deck spans along y (90°)
 * between them, over the whole 30 × 50 ft frame. W8X31 columns run 15 ft
 * from the ground level to the roof; each stands on a 5 × 5 ft pad footing.
 * Sections are shared element types (`type-beam`, `type-column`); RTU-1
 * stands on B2 at its 10 ft station.
 */

export const FT = 304.8;
const ft = (x: number, y: number): Vec2 => ({ x: x * FT, y: y * FT });
const id = asElementId;
const base = (eid: string) => ({ id: id(eid), version: 1, authoredRev: {} });

export const GROUND = id("level-ground");
export const ROOF = id("level-roof");
export const ROOF_HEIGHT_FT = 15;

const LINES = [
  { line: 1, y: 0 },
  { line: 2, y: 25 },
  { line: 3, y: 50 },
] as const;
const SIDES = [
  { side: "A", x: 0 },
  { side: "B", x: 30 },
] as const;

export interface FrameOptions {
  /** Leave this column's footing out. */
  readonly withoutFooting?: string;
  /** The roof deck's use. */
  readonly roofUse?: string;
  readonly rtuWeightLb?: number;
  /** Where RTU-1 is, feet. Default on B2 at x = 10. */
  readonly rtuAt?: Vec2;
  /** What RTU-1 stands on. Default: B2 at the 10 ft station. */
  readonly rtuHost?: PartInstance["host"];
  /** The beams' shared section. */
  readonly beamSection?: string;
}

export const BEAM_TYPE = id("type-beam");
export const COLUMN_TYPE = id("type-column");

export function twoBayFrame(opts: FrameOptions = {}): ModelState {
  const elements: BimElement[] = [];
  const level = (lid: ElementId, name: string, elevFt: number): Level => ({ ...base(lid), kind: "level", name, elevationMm: elevFt * FT });
  elements.push(level(GROUND, "Ground", 0), level(ROOF, "Roof", ROOF_HEIGHT_FT));
  const sectionType = (tid: ElementId, name: string, classId: string, kind: "beam" | "column"): ElementTypeElement => ({ ...base(tid), kind: "element_type", name, classId, values: { "struct.section": name }, forKinds: [kind] });
  elements.push(sectionType(BEAM_TYPE, opts.beamSection ?? "W16X26", "struct.beam_steel", "beam"), sectionType(COLUMN_TYPE, "W8X31", "struct.column_steel", "column"));

  for (const { line, y } of LINES) {
    const beam: Beam = {
      ...base(`B${line}`),
      kind: "beam",
      sectionName: "W16X26",
      start: ft(0, y),
      end: ft(30, y),
      classId: "struct.beam_steel",
      typeId: BEAM_TYPE,
      values: { mark: `B${line}` },
      placement: { kind: "line", levelId: ROOF, start: ft(0, y), end: ft(30, y), startOffsetMm: 0, endOffsetMm: 0, lateral: "center", vertical: "top" },
    };
    elements.push(beam);
    for (const { side, x } of SIDES) {
      const cid = `C${line}${side}`;
      const column: Column = {
        ...base(cid),
        kind: "column",
        material: "steel",
        position: ft(x, y),
        size: { x: 8 * 25.4, y: 8 * 25.4 },
        classId: "struct.column_steel",
        typeId: COLUMN_TYPE,
        values: { mark: cid },
        placement: { kind: "line", levelId: GROUND, start: ft(x, y), end: ft(x, y), startOffsetMm: 0, endOffsetMm: ROOF_HEIGHT_FT * FT, lateral: "center", vertical: "bottom", topLevelId: ROOF },
      };
      elements.push(column);
      if (opts.withoutFooting === cid) continue;
      const footing: Component = {
        ...base(`F${line}${side}`),
        kind: "component",
        category: "footing",
        typeName: "Pad 5'-0\" square",
        position: ft(x, y),
        size: { x: 5 * FT, y: 5 * FT },
        rotationDeg: 0,
        classId: "struct.footing_pad",
        values: { mark: `F${line}${side}` },
        placement: { kind: "point", levelId: GROUND, position: ft(x, y), offsetMm: 0, rotationDeg: 0 },
      };
      elements.push(footing);
    }
  }

  const outline = [ft(0, 0), ft(30, 0), ft(30, 50), ft(0, 50)];
  const deck: Slab = {
    ...base("DECK-1"),
    kind: "slab",
    outline,
    thickness: 38,
    classId: "struct.roof_deck",
    values: { mark: "DECK-1", "struct.occupancy": opts.roofUse ?? "struct.roof_ordinary" },
    placement: { kind: "area", levelId: ROOF, outline, offsetMm: 0, vertical: "top", spanDirectionDeg: 90 },
  };
  elements.push(deck);

  const rtuType: PartTypeElement = {
    ...base("type-rtu"),
    kind: "part_type",
    definition: { familyName: "Rooftop unit", typeName: "Synthetic 10 ton", category: "mechanical_equipment", typeParams: [], typeValues: {}, instanceParams: [], connectors: [], geometry: [], symbol: [], tagFields: [], source: { kind: "builtin", libraryVersion: "test" } },
  };
  const rtu: PartInstance = {
    ...base("RTU-1"),
    kind: "part",
    typeId: rtuType.id,
    levelId: ROOF,
    position: opts.rtuAt ? ft(opts.rtuAt.x, opts.rtuAt.y) : ft(10, 25),
    offsetMm: 0,
    rotationDeg: 0,
    mark: "RTU-1",
    values: { weight: opts.rtuWeightLb ?? 2000 },
    host: opts.rtuHost ?? { kind: "element", elementId: id("B2"), stationMm: 10 * FT },
  };
  elements.push(rtuType, rtu);

  return { modelId: "synthetic-two-bay", revision: asRevision(1), elements: Object.fromEntries(elements.map((e) => [e.id, e])), connections: [], settings: DEFAULT_SETTINGS };
}

/**
 * A synthetic grid for the perf row: `bays × bays` 30 × 25 ft bays, a beam
 * per bay per column line, a column and footing at every grid point, one
 * roof deck over all of it and one rooftop unit per bay.
 */
export function gridFrame(bays: number): ModelState {
  const elements: BimElement[] = [
    { ...base(GROUND), kind: "level", name: "Ground", elevationMm: 0 },
    { ...base(ROOF), kind: "level", name: "Roof", elevationMm: ROOF_HEIGHT_FT * FT },
  ];
  for (let j = 0; j <= bays; j++) {
    const y = j * 25;
    for (let i = 0; i <= bays; i++) {
      const x = i * 30;
      const cid = `C${i}-${j}`;
      elements.push({ ...base(cid), kind: "column", material: "steel", position: ft(x, y), size: { x: 203, y: 203 }, classId: "struct.column_steel", values: { "struct.section": "W8X31" }, placement: { kind: "line", levelId: GROUND, start: ft(x, y), end: ft(x, y), startOffsetMm: 0, endOffsetMm: ROOF_HEIGHT_FT * FT, lateral: "center", vertical: "bottom", topLevelId: ROOF } });
      elements.push({ ...base(`F${i}-${j}`), kind: "component", category: "footing", typeName: "Pad", position: ft(x, y), size: { x: 5 * FT, y: 5 * FT }, rotationDeg: 0, classId: "struct.footing_pad", placement: { kind: "point", levelId: GROUND, position: ft(x, y), offsetMm: 0, rotationDeg: 0 } });
      if (i === bays) continue;
      elements.push({ ...base(`B${i}-${j}`), kind: "beam", sectionName: "W16X26", start: ft(x, y), end: ft(x + 30, y), classId: "struct.beam_steel", values: { "struct.section": "W16X26" }, placement: { kind: "line", levelId: ROOF, start: ft(x, y), end: ft(x + 30, y), startOffsetMm: 0, endOffsetMm: 0, lateral: "center", vertical: "top" } });
    }
  }
  const outline = [ft(0, 0), ft(bays * 30, 0), ft(bays * 30, bays * 25), ft(0, bays * 25)];
  elements.push({ ...base("DECK"), kind: "slab", outline, thickness: 38, classId: "struct.roof_deck", values: { "struct.occupancy": "struct.roof_ordinary" }, placement: { kind: "area", levelId: ROOF, outline, offsetMm: 0, vertical: "top", spanDirectionDeg: 90 } });
  const type: PartTypeElement = {
    ...base("type-rtu"),
    kind: "part_type",
    definition: { familyName: "Rooftop unit", typeName: "Synthetic", category: "mechanical_equipment", typeParams: [], typeValues: {}, instanceParams: [], connectors: [], geometry: [], symbol: [], tagFields: [], source: { kind: "builtin", libraryVersion: "test" } },
  };
  elements.push(type);
  for (let j = 0; j < bays; j++) for (let i = 0; i < bays; i++) elements.push({ ...base(`RTU-${i}-${j}`), kind: "part", typeId: type.id, levelId: ROOF, position: ft(i * 30 + 10, j * 25 + 12.5), offsetMm: 0, rotationDeg: 0, mark: `RTU-${i}-${j}`, values: { weight: 1500 }, host: { kind: "slab", elementId: id("DECK") } });
  return { modelId: "synthetic-grid", revision: asRevision(1), elements: Object.fromEntries(elements.map((e) => [e.id, e])), connections: [], settings: DEFAULT_SETTINGS };
}
