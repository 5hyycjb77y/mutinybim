import {
  builtinFormTemplate,
  builtinPartType,
  DEFAULT_SETTINGS,
  elementValues,
  executeCommand,
  TILE_2FT_MM,
  TILE_4FT_MM,
  withUpgradePolicy,
  type Command,
  type ModelState,
  type Revision,
  type Vec2,
  type ViewElement,
} from "@permitzip/bim-kernel";
import { DOOR_SCHEDULE, WALL_TYPES_SCHEDULE, WINDOW_SCHEDULE } from "@permitzip/bim-pack-architecture";
import { LIGHTING_FIXTURE_SCHEDULE } from "@permitzip/bim-pack-electrical";
import { standardNoteParagraphs } from "@permitzip/bim-library";
import { AIR_DEVICE_SCHEDULE, MECHANICAL_EQUIPMENT_SCHEDULE, previewAirConnect } from "@permitzip/bim-pack-mechanical";
import { PLUMBING_FIXTURE_SCHEDULE } from "@permitzip/bim-pack-plumbing";
import { BEAM_SCHEDULE, COLUMN_SCHEDULE, FOOTING_SCHEDULE, ROOF_ORDINARY_USE } from "@permitzip/bim-pack-structural";
import { installFirstPartyAddOns } from "../index";
import {
  SHOWCASE_CAFE_ISLAND,
  SHOWCASE_CONF_TABLE,
  SHOWCASE_DIFFUSER,
  SHOWCASE_DOWNLIGHT_6,
  SHOWCASE_EXTERIOR_SCONCE,
  SHOWCASE_GRAVITY_HOOD,
  SHOWCASE_INLINE_FAN,
  SHOWCASE_KITCHENETTE_COUNTER,
  SHOWCASE_LAV_UNDERMOUNT,
  SHOWCASE_PART_TYPES,
  SHOWCASE_RTU,
  SHOWCASE_SINK_KITCHENETTE,
  SHOWCASE_TROFFER_2X4,
  SHOWCASE_VANITY_DUAL,
  SHOWCASE_WATER_HEATER,
  SHOWCASE_WC_COMMERCIAL,
  SHOWCASE_WORKTABLE,
} from "./showcase-parts";
import { SHOWCASE_SHEET_MARKUPS } from "./showcase-markups";
import { appendShowcaseDetails } from "./showcase-details";

/**
 * MutinyBIM flagship default showcase model:
 * **Two-Story Creative Office & Architecture Studio** (56'-0" × 28'-0", ~2,600 sq ft)
 *
 * Coordinated multi-discipline commercial architecture + MEP showcase:
 * - Architecture: 12'-0" L1 commercial studio (9'-6" ACT cloud / soffit + 1'-10" MEP plenum)
 *   + 10'-0" L2 conference/loft, board-formed concrete & 2-hr CMU MEP core, dark-bronze
 *   storefront glazing, cedar upper studio, oak U-stair, cut-out quartz dual vanities,
 *   cut-out oak kitchenette counter, and legged studio worktables.
 * - Mechanical: Carrier 50FC-A06 5-ton RTU on east flat parapet roof with vertical curb
 *   supply/return drops into 10'-8" plenum trunks (zero ceiling clash), real `connect_into`
 *   takeoff taps + curved 8" flex ducts into Titus TMS diffusers, Greenheck G-085 roof exhaust
 *   fan with vertical shaft riser to stacked restrooms, Equipment + Air Device schedules,
 *   and live Air Schematic (`air_schematic`).
 * - Electrical: Dedicated MEP Room 101 with 480Y/277V MDP → HP-1 (serving RTU-1, WH-1 & 277V
 *   lighting) + 75 kVA transformer T-1 → 208Y/120V LP-1 (serving NEC-spaced receptacles, GFCIs,
 *   plotter quads & EF-1), flush recessed Lithonia 2GTL4/LDN6 interior luminaires + bronze WDGE2
 *   exterior wall sconces, live One-Line Diagram + live Lighting Controls Diagram (`controls_diagram`).
 * - Plumbing: Exterior Water Meter MTR-1 → 2" DCW service → RPZ Backflow Preventer → A.O. Smith
 *   DRE-52 50-gal electric water heater + Expansion Tank ET-1; stacked L1/L2 commercial restrooms
 *   on an interior 8" wet chase wall (Kohler K-4350 WCs + recessed K-2210 lavatories) + Elkay
 *   LR2522 8"-deep stainless kitchenette sink; 4" sanitary lateral w/ cleanout to exterior Manhole
 *   MH-1; 3" VTR; system-filtered Domestic Water vs Sanitary/Vent plans + live Risers & Isometric.
 */

const FT = 304.8;
const IN = 25.4;

const EXT_T = Math.round(10 * IN);
const CORE_T = Math.round(8 * IN);
const WET_T = Math.round(8 * IN);
const INT_T = Math.round(5 * IN);
const CW_T = Math.round(5 * IN);
const STALL_T = Math.round(2 * IN);
const HALF_EXT = EXT_T / 2;

const W_WEST = 18 * FT;
const W_MAIN = 34 * FT;
const W_ALL = 56 * FT;
const D_ALL = 28 * FT;
const Y_WET = 21 * FT; // 8" interior wet chase dividing MEP 101 (south) & Restroom 102 (north)
const H1 = Math.round(12 * FT); // 12'-0" L1 commercial floor-to-floor -> clean 1'-10" MEP plenum above 9'-6" ceiling
const H2 = Math.round(10 * FT); // 10'-0" L2 floor-to-roof height
const PARAPET_H = Math.round(3 * FT);
const GUARD_H = Math.round(3.5 * FT);

const pt = (x: number, y: number): Vec2 => ({ x: Math.round(x), y: Math.round(y) });

function runCmds(model: ModelState, commands: readonly Command[]): ModelState {
  let cur = model;
  for (const command of commands) {
    const res = executeCommand(cur, command);
    if (!res.ok) {
      const hint = "idPrefix" in command ? ` (${command.idPrefix})` : "partId" in command ? ` (${command.partId})` : "";
      throw new Error(`showcase command ${command.type}${hint} failed: ${res.error.code} — ${res.error.message}`);
    }
    cur = { ...res.model, revision: (cur.revision + 1) as Revision };
  }
  return cur;
}

function mustBuiltin(id: string) {
  const entry = builtinPartType(id);
  if (!entry) throw new Error(`showcase: missing built-in part type ${id}`);
  return entry;
}

function findSeg(
  model: ModelState,
  prefix: string,
  pred: (s: { start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } }) => boolean,
): string {
  for (const el of elementValues(model.elements)) {
    if (el.kind === "run_segment" && !("deleted" in el && el.deleted) && el.id.startsWith(`${prefix}-`) && pred(el)) {
      return el.id;
    }
  }
  throw new Error(`showcase: no segment matching prefix "${prefix}"`);
}

const STRUCT_HIDE_OTHER = {
  "struct.beam": { visible: false },
  "struct.footing": { visible: false },
  "struct.roof_deck": { visible: false },
} as const;

const ARCH_HIDE_MEP = {
  ...STRUCT_HIDE_OTHER,
  duct: { visible: false },
  duct_fitting: { visible: false },
  air_terminal: { visible: false },
  pipe: { visible: false },
  electrical_devices: { visible: false },
  lighting_fixtures: { visible: false },
  "mep.mechanical_equipment": { visible: false },
  "mep.electrical_equipment": { visible: false },
} as const;

const RCP_HIDE_NON_CEILING = {
  ...STRUCT_HIDE_OTHER,
  duct: { visible: false },
  duct_fitting: { visible: false },
  pipe: { visible: false },
  electrical_devices: { visible: false },
  "mep.mechanical_equipment": { visible: false },
  "mep.electrical_equipment": { visible: false },
  "mep.plumbing_fixture": { visible: false },
} as const;

const MECH_HIDE_NON_HVAC = {
  ...STRUCT_HIDE_OTHER,
  pipe: { visible: false },
  electrical_devices: { visible: false },
  lighting_fixtures: { visible: false },
  opening_tags: { visible: false },
  "mep.electrical_equipment": { visible: false },
  "mep.plumbing_fixture": { visible: false },
} as const;

const ELEC_POWER_HIDE = {
  ...STRUCT_HIDE_OTHER,
  duct: { visible: false },
  duct_fitting: { visible: false },
  air_terminal: { visible: false },
  pipe: { visible: false },
  lighting_fixtures: { visible: false },
  opening_tags: { visible: false },
  "electrical.lighting_control": { visible: false },
  "mep.mechanical_equipment": { visible: false },
} as const;

const ELEC_POWER_L2_HIDE = {
  ...STRUCT_HIDE_OTHER,
  duct: { visible: false },
  duct_fitting: { visible: false },
  air_terminal: { visible: false },
  pipe: { visible: false },
  lighting_fixtures: { visible: false },
  opening_tags: { visible: false },
  "electrical.lighting_control": { visible: false },
} as const;

const ELEC_LTG_HIDE = {
  ...STRUCT_HIDE_OTHER,
  duct: { visible: false },
  duct_fitting: { visible: false },
  air_terminal: { visible: false },
  pipe: { visible: false },
  opening_tags: { visible: false },
  "mep.mechanical_equipment": { visible: false },
  "mep.electrical_equipment": { visible: false },
  "mep.plumbing_fixture": { visible: false },
  "electrical.receptacle": { visible: false },
  "electrical.lighting_control": { visible: false },
} as const;

const ELEC_CTRL_HIDE = {
  ...STRUCT_HIDE_OTHER,
  duct: { visible: false },
  duct_fitting: { visible: false },
  air_terminal: { visible: false },
  pipe: { visible: false },
  opening_tags: { visible: false },
  "mep.mechanical_equipment": { visible: false },
  "mep.electrical_equipment": { visible: false },
  "mep.plumbing_fixture": { visible: false },
  "electrical.receptacle": { visible: false },
} as const;

const PLUMB_WATER_HIDE = {
  ...STRUCT_HIDE_OTHER,
  duct: { visible: false },
  duct_fitting: { visible: false },
  air_terminal: { visible: false },
  electrical_devices: { visible: false },
  lighting_fixtures: { visible: false },
  opening_tags: { visible: false },
  "mep.mechanical_equipment": { visible: false },
  "mep.electrical_equipment": { visible: false },
  "service:sanitary": { visible: false },
  "service:vent": { visible: false },
} as const;

const PLUMB_DWV_HIDE = {
  ...STRUCT_HIDE_OTHER,
  duct: { visible: false },
  duct_fitting: { visible: false },
  air_terminal: { visible: false },
  electrical_devices: { visible: false },
  lighting_fixtures: { visible: false },
  opening_tags: { visible: false },
  "mep.mechanical_equipment": { visible: false },
  "mep.electrical_equipment": { visible: false },
  "service:domestic_cold_water": { visible: false },
  "service:domestic_hot_water": { visible: false },
} as const;

const STRUCT_FND_HIDE = {
  duct: { visible: false },
  duct_fitting: { visible: false },
  air_terminal: { visible: false },
  pipe: { visible: false },
  electrical_devices: { visible: false },
  lighting_fixtures: { visible: false },
  opening_tags: { visible: false },
  furniture: { visible: false },
  casework: { visible: false },
  "mep.mechanical_equipment": { visible: false },
  "mep.electrical_equipment": { visible: false },
  "mep.plumbing_fixture": { visible: false },
  "arch.casework": { visible: false },
  "arch.furniture": { visible: false },
} as const;

const STRUCT_FRAMING_HIDE = {
  ...STRUCT_FND_HIDE,
  "struct.footing": { visible: false },
  "mep.mechanical_equipment": { visible: true, halftone: true },
} as const;

const pvc = (inches: number) => ({ shape: "pipe" as const, nominalMm: inches * IN, material: "pvc" as const });
const copper = (inches: number) => ({ shape: "pipe" as const, nominalMm: inches * IN, material: "copper" as const });

export function createShowcaseDemoModel(modelId = "showcase-demo"): ModelState {
  installFirstPartyAddOns();
  return withUpgradePolicy(
    () => true,
    () => buildShowcase(modelId),
  );
}

function buildShowcase(modelId: string): ModelState {
  const wall = (
    elementId: string,
    levelId: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    thicknessMm: number,
    heightMm: number,
    typeId: string,
  ): Command => ({
    type: "create_element",
    elementId,
    levelId,
    kind: "wall",
    typeId,
    placement: { kind: "line", start: pt(x1, y1), end: pt(x2, y2) },
    size: { thicknessMm, heightMm },
  });

  const opening = (
    openingId: string,
    levelId: string,
    wallId: string,
    kind: "door" | "window",
    offsetMm: number,
    widthMm: number,
    heightMm: number,
    mark: string,
    values: Record<string, string | number | boolean> = {},
  ): Command[] => [
    {
      type: "add_architecture",
      levelId,
      walls: [],
      rooms: [],
      casework: [],
      openings: [{ openingId, wallId, kind, offsetMm: Math.round(offsetMm), widthMm: Math.round(widthMm), heightMm: Math.round(heightMm), mark }],
    },
    ...(Object.keys(values).length > 0 ? [{ type: "set_element_values" as const, elementIds: [openingId], values }] : []),
  ];

  const stairwellHole: Vec2[] = [
    pt(26.7 * FT, 15.2 * FT),
    pt(33.5 * FT, 15.2 * FT),
    pt(33.5 * FT, 27.4 * FT),
    pt(26.7 * FT, 27.4 * FT),
  ];

  let m: ModelState = { modelId, revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };

  // =========================================================================
  // 1. ARCHITECTURE — Levels, Types, Slabs, Walls, Openings, Stair, Roofs, Ceilings, Spaces
  // =========================================================================
  m = runCmds(m, [
    // Levels (L1 Ceiling is a non-story datum — Level 1 plans still reach up to Level 2, 12 ft)
    { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
    { type: "create_level", levelId: "L1_CLG", name: "L1 Ceiling", elevationMm: Math.round(9 * FT), buildingStory: false },
    { type: "create_level", levelId: "L2", name: "Level 2", elevationMm: H1 },
    { type: "create_level", levelId: "ROOF", name: "Roof", elevationMm: H1 + H2 },

    // Architectural Element Types (Materials + ISO 6946 Envelope Thermal Props)
    { type: "create_element_type", typeId: "type-wall-concrete", name: 'Exterior Wall — 10" Board-Formed Concrete', forKinds: ["wall"], values: { "material.id": "architecture.board_concrete", "architecture.wall_function": "EXTERIOR", "architecture.thermal_transmittance": 0.28 } },
    { type: "create_element_type", typeId: "type-wall-stucco", name: 'Exterior Wall — 10" Smooth White Stucco (R-24)', forKinds: ["wall"], values: { "material.id": "architecture.stucco_white", "architecture.wall_function": "EXTERIOR", "architecture.thermal_transmittance": 0.22 } },
    { type: "create_element_type", typeId: "type-wall-cedar", name: 'Exterior Wall — 10" Natural Cedar Slats (R-24)', forKinds: ["wall"], values: { "material.id": "architecture.cedar_siding", "architecture.wall_function": "EXTERIOR", "architecture.thermal_transmittance": 0.24 } },
    { type: "create_element_type", typeId: "type-wall-charcoal", name: 'Exterior Wall — 10" Charcoal Matte Metal', forKinds: ["wall"], values: { "material.id": "architecture.charcoal_metal", "architecture.wall_function": "EXTERIOR", "architecture.thermal_transmittance": 0.23 } },
    { type: "create_element_type", typeId: "type-wall-curtain", name: "Storefront Curtain Wall — Dark Bronze + Low-E Glass", forKinds: ["wall"], values: { "material.id": "architecture.curtain_wall_glass", "architecture.wall_function": "CURTAIN", "architecture.mullion_material": "architecture.bronze_mullion", "architecture.thermal_transmittance": 1.6 } },
    { type: "create_element_type", typeId: "type-wall-cmu", name: 'Core Wall — 8" 2-Hr Reinforced CMU', forKinds: ["wall"], values: { "material.id": "architecture.cmu_concrete", "architecture.wall_function": "SHEAR", "architecture.fire_rating": 2 } },
    { type: "create_element_type", typeId: "type-wall-wet", name: 'Interior Wet Chase — 8" Double-Stud Plumbing Wall', forKinds: ["wall"], values: { "material.id": "architecture.gypsum_partition", "architecture.wall_function": "INTERIOR" } },
    { type: "create_element_type", typeId: "type-wall-interior", name: 'Interior Partition — 5" Acoustic Gypsum', forKinds: ["wall"], values: { "material.id": "architecture.gypsum_partition", "architecture.wall_function": "INTERIOR" } },
    { type: "create_element_type", typeId: "type-wall-stall", name: 'Commercial Restroom Stall Partition — 2" Powder-Coat', forKinds: ["wall"], values: { "material.id": "architecture.bronze_fixture", "architecture.wall_function": "INTERIOR" } },
    { type: "create_element_type", typeId: "type-slab-terrazzo", name: 'Ground Floor Slab — 8" Honed Terrazzo', forKinds: ["slab"], values: { "material.id": "architecture.terrazzo" } },
    { type: "create_element_type", typeId: "type-slab-concrete", name: 'Elevated Concrete Floor Slab — 8"', forKinds: ["slab"], values: { "material.id": "architecture.concrete_slab" } },
    { type: "create_element_type", typeId: "type-slab-oak", name: 'Elevated Floor — Wide-Plank White Oak', forKinds: ["slab"], values: { "material.id": "architecture.wood_oak" } },
    { type: "create_element_type", typeId: "type-slab-limestone", name: 'Terrace & Entry Apron — Honed Limestone Pavers', forKinds: ["slab"], values: { "material.id": "architecture.limestone" } },

    // Structural Element Types (AISC W-Shapes + Reinforced Concrete Pad Footings)
    { type: "create_element_type", typeId: "type-col-w10x33", name: "Steel Column — W10×33 (ASTM A992)", forKinds: ["column"], values: { "struct.section": "W10x33", "struct.grade": "A992", "material.id": "architecture.bronze_mullion" } },
    { type: "create_element_type", typeId: "type-col-w8x31", name: "Steel Column — W8×31 (ASTM A992)", forKinds: ["column"], values: { "struct.section": "W8x31", "struct.grade": "A992", "material.id": "architecture.bronze_mullion" } },
    { type: "create_element_type", typeId: "type-bm-w18x35", name: "Steel Girder — W18×35 (ASTM A992)", forKinds: ["beam"], values: { "struct.section": "W18x35", "struct.grade": "A992", "struct.elastic_modulus": 29000, "material.id": "architecture.charcoal_metal" } },
    { type: "create_element_type", typeId: "type-bm-w16x26", name: "Steel Beam — W16×26 (ASTM A992)", forKinds: ["beam"], values: { "struct.section": "W16x26", "struct.grade": "A992", "struct.elastic_modulus": 29000, "material.id": "architecture.charcoal_metal" } },
    { type: "create_element_type", typeId: "type-bm-w14x22", name: "Steel Roof Beam — W14×22 (ASTM A992)", forKinds: ["beam"], values: { "struct.section": "W14x22", "struct.grade": "A992", "struct.elastic_modulus": 29000, "material.id": "architecture.charcoal_metal" } },
    { type: "create_element_type", typeId: "type-bm-w12x26", name: "Steel Tie Beam — W12×26 (ASTM A992)", forKinds: ["beam"], values: { "struct.section": "W12x26", "struct.grade": "A992", "struct.elastic_modulus": 29000, "material.id": "architecture.charcoal_metal" } },
    { type: "create_element_type", typeId: "type-ftg-6x6", name: `Pad Footing — 6'-0" × 6'-0" × 20" (4000 PSI)`, forKinds: ["component"], values: { "struct.footing_thickness_mm": Math.round(20 * IN), "material.id": "architecture.concrete_slab" } },
    { type: "create_element_type", typeId: "type-ftg-5x5", name: `Pad Footing — 5'-0" × 5'-0" × 18" (4000 PSI)`, forKinds: ["component"], values: { "struct.footing_thickness_mm": Math.round(18 * IN), "material.id": "architecture.concrete_slab" } },
    { type: "create_element_type", typeId: "type-ftg-4x4", name: `Pad Footing — 4'-0" × 4'-0" × 16" (4000 PSI)`, forKinds: ["component"], values: { "struct.footing_thickness_mm": Math.round(16 * IN), "material.id": "architecture.concrete_slab" } },

    // Floor Slabs
    {
      type: "create_element",
      elementId: "slab-l1-main",
      levelId: "L1",
      kind: "slab",
      typeId: "type-slab-terrazzo",
      placement: { kind: "area", outline: [pt(-HALF_EXT, -HALF_EXT), pt(W_ALL + HALF_EXT, -HALF_EXT), pt(W_ALL + HALF_EXT, D_ALL + HALF_EXT), pt(-HALF_EXT, D_ALL + HALF_EXT)] },
      size: { thicknessMm: Math.round(8 * IN) },
    },
    {
      type: "create_element",
      elementId: "slab-l1-apron",
      levelId: "L1",
      kind: "slab",
      typeId: "type-slab-limestone",
      placement: { kind: "area", outline: [pt(W_WEST - HALF_EXT, -5.5 * FT), pt(W_ALL + HALF_EXT, -5.5 * FT), pt(W_ALL + HALF_EXT, -HALF_EXT), pt(W_WEST - HALF_EXT, -HALF_EXT)] },
      size: { thicknessMm: Math.round(6 * IN) },
    },
    {
      type: "create_element",
      elementId: "slab-l2-main",
      levelId: "L2",
      kind: "slab",
      classId: "struct.floor_deck",
      typeId: "type-slab-oak",
      placement: { kind: "area", outline: [pt(0, 0), pt(W_MAIN, 0), pt(W_MAIN, D_ALL), pt(0, D_ALL)], holes: [stairwellHole], spanDirectionDeg: 90 },
      size: { thicknessMm: Math.round(8 * IN) },
      values: { "struct.occupancy": "office_space" },
    },
    {
      type: "create_element",
      elementId: "deck-roof-east",
      levelId: "L2",
      kind: "slab",
      classId: "struct.roof_deck",
      typeId: "type-slab-concrete",
      baseOffsetMm: -Math.round(4 * IN),
      placement: { kind: "area", outline: [pt(W_MAIN, 0), pt(W_ALL, 0), pt(W_ALL, D_ALL), pt(W_MAIN, D_ALL)], spanDirectionDeg: 90 },
      size: { thicknessMm: Math.round(4 * IN) },
      values: { "struct.occupancy": ROOF_ORDINARY_USE },
    },
    {
      type: "create_element",
      elementId: "deck-roof-west",
      levelId: "ROOF",
      kind: "slab",
      classId: "struct.roof_deck",
      typeId: "type-slab-concrete",
      placement: { kind: "area", outline: [pt(0, 0), pt(W_MAIN, 0), pt(W_MAIN, D_ALL), pt(0, D_ALL)], spanDirectionDeg: 90 },
      size: { thicknessMm: Math.round(4 * IN) },
      values: { "struct.occupancy": ROOF_ORDINARY_USE },
    },
    {
      type: "create_element",
      elementId: "slab-l2-terrace",
      levelId: "L2",
      kind: "slab",
      classId: "struct.floor_deck",
      typeId: "type-slab-limestone",
      placement: { kind: "area", outline: [pt(W_WEST - HALF_EXT, -5.0 * FT), pt(W_MAIN + HALF_EXT, -5.0 * FT), pt(W_MAIN + HALF_EXT, 0), pt(W_WEST - HALF_EXT, 0)], spanDirectionDeg: 90 },
      size: { thicknessMm: Math.round(8 * IN) },
      values: { "struct.occupancy": "corridor" },
    },

    // Level 1 Exterior & Interior Walls
    wall("w-l1-s-west", "L1", 0, 0, W_WEST, 0, EXT_T, H1, "type-wall-charcoal"),
    wall("w-l1-s-main", "L1", W_WEST, 0, W_MAIN, 0, CW_T, H1, "type-wall-curtain"),
    wall("w-l1-s-east-solid", "L1", W_MAIN, 0, 40 * FT, 0, EXT_T, H1, "type-wall-stucco"),
    wall("w-l1-s-east-glass", "L1", 40 * FT, 0, W_ALL, 0, CW_T, H1, "type-wall-curtain"),
    wall("w-l1-e-glass", "L1", W_ALL, 0, W_ALL, 15 * FT, CW_T, H1, "type-wall-curtain"),
    wall("w-l1-e-solid", "L1", W_ALL, 15 * FT, W_ALL, D_ALL, EXT_T, H1, "type-wall-stucco"),
    wall("w-l1-n-east", "L1", W_MAIN, D_ALL, W_ALL, D_ALL, EXT_T, H1, "type-wall-stucco"),
    wall("w-l1-n-main", "L1", W_WEST, D_ALL, W_MAIN, D_ALL, EXT_T, H1, "type-wall-concrete"),
    wall("w-l1-n-west", "L1", 0, D_ALL, W_WEST, D_ALL, EXT_T, H1, "type-wall-concrete"),
    wall("w-l1-w", "L1", 0, 0, 0, D_ALL, EXT_T, H1, "type-wall-concrete"),
    wall("w-l1-core", "L1", W_WEST, 0, W_WEST, D_ALL, CORE_T, H1, "type-wall-cmu"),
    wall("w-l1-wet", "L1", 0, Y_WET, W_WEST, Y_WET, WET_T, H1, "type-wall-wet"),
    wall("w-l1-studio-div", "L1", W_MAIN, 0, W_MAIN, D_ALL, INT_T, H1, "type-wall-interior"),
    wall("w-l1-print-w", "L1", 47 * FT, 20.5 * FT, 47 * FT, D_ALL, INT_T, H1, "type-wall-interior"),
    wall("w-l1-print-s", "L1", 47 * FT, 20.5 * FT, W_ALL, 20.5 * FT, INT_T, H1, "type-wall-interior"),
    // Commercial toilet privacy partitions in Restroom 102
    wall("w-l1-stall-1", "L1", 5.75 * FT, Y_WET + 4 * IN, 5.75 * FT, 26.0 * FT, STALL_T, Math.round(6 * FT), "type-wall-stall"),
    wall("w-l1-stall-2", "L1", 9.25 * FT, Y_WET + 4 * IN, 9.25 * FT, 26.0 * FT, STALL_T, Math.round(6 * FT), "type-wall-stall"),

    // Structural Column Grids (1-4 East-West, A-C North-South)
    { type: "create_element", elementId: "grid-1", levelId: "L1", kind: "grid", label: "1", placement: { kind: "line", start: pt(0, -3.5 * FT), end: pt(0, D_ALL + 3.5 * FT) } },
    { type: "create_element", elementId: "grid-2", levelId: "L1", kind: "grid", label: "2", placement: { kind: "line", start: pt(W_WEST, -3.5 * FT), end: pt(W_WEST, D_ALL + 3.5 * FT) } },
    { type: "create_element", elementId: "grid-3", levelId: "L1", kind: "grid", label: "3", placement: { kind: "line", start: pt(W_MAIN, -3.5 * FT), end: pt(W_MAIN, D_ALL + 3.5 * FT) } },
    { type: "create_element", elementId: "grid-4", levelId: "L1", kind: "grid", label: "4", placement: { kind: "line", start: pt(W_ALL, -3.5 * FT), end: pt(W_ALL, D_ALL + 3.5 * FT) } },
    { type: "create_element", elementId: "grid-a", levelId: "L1", kind: "grid", label: "A", placement: { kind: "line", start: pt(-3.5 * FT, 0), end: pt(W_ALL + 3.5 * FT, 0) } },
    { type: "create_element", elementId: "grid-b", levelId: "L1", kind: "grid", label: "B", placement: { kind: "line", start: pt(-3.5 * FT, 14 * FT), end: pt(W_ALL + 3.5 * FT, 14 * FT) } },
    { type: "create_element", elementId: "grid-c", levelId: "L1", kind: "grid", label: "C", placement: { kind: "line", start: pt(-3.5 * FT, D_ALL), end: pt(W_ALL + 3.5 * FT, D_ALL) } },

    // =========================================================================
    // STRUCTURAL STEEL FRAME & CONCRETE PAD FOOTINGS
    // Exercises every @permitzip/bim-pack-structural capability:
    // - Level-tied columns (L1→L2 & L2→ROOF with topOffsetMm under deck/slab)
    // - Multi-story continuous column (col-l1-1, L1→ROOF, visible on both L1 & L2 plans)
    // - Fixed-height exterior balcony columns (size.heightMm under L2 south terrace)
    // - Rotated strong-axis wide-flange I-sections, cambered W18x35 girders, W16x26/W14x22 beams
    // - Full gravity load path (Roof + Floor decks + RTU-1 equipment weight → Beams → Columns → Pad Footings)
    // =========================================================================
    // Continuous 2-story interior column on Grid B (L1 → ROOF); East Studio stays column-free under the 22' clear-span roof girder G2-B4
    { type: "create_element", elementId: "col-l1-1", levelId: "L1", kind: "column", classId: "struct.column_steel", typeId: "type-col-w10x33", material: "steel", placement: { kind: "point", position: pt(26 * FT, 14 * FT), rotationDeg: 90 }, size: { widthMm: 254, depthMm: 254 }, topLevelId: "ROOF", topOffsetMm: -Math.round(4 * IN), values: { mark: "C25B" } },
    // Level 1 Grid 1–4 × A–C steel columns (top tied to L2 underside)
    { type: "create_element", elementId: "col-l1-1a", levelId: "L1", kind: "column", classId: "struct.column_steel", typeId: "type-col-w10x33", material: "steel", placement: { kind: "point", position: pt(0, 0) }, size: { widthMm: 254, depthMm: 254 }, topLevelId: "L2", topOffsetMm: -Math.round(4 * IN), values: { mark: "C1A" } },
    { type: "create_element", elementId: "col-l1-1b", levelId: "L1", kind: "column", classId: "struct.column_steel", typeId: "type-col-w10x33", material: "steel", placement: { kind: "point", position: pt(0, 14 * FT), rotationDeg: 90 }, size: { widthMm: 254, depthMm: 254 }, topLevelId: "L2", topOffsetMm: -Math.round(4 * IN), values: { mark: "C1B" } },
    { type: "create_element", elementId: "col-l1-1c", levelId: "L1", kind: "column", classId: "struct.column_steel", typeId: "type-col-w10x33", material: "steel", placement: { kind: "point", position: pt(0, D_ALL) }, size: { widthMm: 254, depthMm: 254 }, topLevelId: "L2", topOffsetMm: -Math.round(4 * IN), values: { mark: "C1C" } },
    { type: "create_element", elementId: "col-l1-2a", levelId: "L1", kind: "column", classId: "struct.column_steel", typeId: "type-col-w10x33", material: "steel", placement: { kind: "point", position: pt(W_WEST, 0) }, size: { widthMm: 254, depthMm: 254 }, topLevelId: "L2", topOffsetMm: -Math.round(4 * IN), values: { mark: "C2A" } },
    { type: "create_element", elementId: "col-l1-2b", levelId: "L1", kind: "column", classId: "struct.column_steel", typeId: "type-col-w10x33", material: "steel", placement: { kind: "point", position: pt(W_WEST, 14 * FT), rotationDeg: 90 }, size: { widthMm: 254, depthMm: 254 }, topLevelId: "L2", topOffsetMm: -Math.round(4 * IN), values: { mark: "C2B" } },
    { type: "create_element", elementId: "col-l1-2c", levelId: "L1", kind: "column", classId: "struct.column_steel", typeId: "type-col-w10x33", material: "steel", placement: { kind: "point", position: pt(W_WEST, D_ALL) }, size: { widthMm: 254, depthMm: 254 }, topLevelId: "L2", topOffsetMm: -Math.round(4 * IN), values: { mark: "C2C" } },
    { type: "create_element", elementId: "col-l1-3a", levelId: "L1", kind: "column", classId: "struct.column_steel", typeId: "type-col-w10x33", material: "steel", placement: { kind: "point", position: pt(W_MAIN, 0) }, size: { widthMm: 254, depthMm: 254 }, topLevelId: "L2", topOffsetMm: -Math.round(4 * IN), values: { mark: "C3A" } },
    { type: "create_element", elementId: "col-l1-3b", levelId: "L1", kind: "column", classId: "struct.column_steel", typeId: "type-col-w10x33", material: "steel", placement: { kind: "point", position: pt(W_MAIN, 14 * FT), rotationDeg: 90 }, size: { widthMm: 254, depthMm: 254 }, topLevelId: "L2", topOffsetMm: -Math.round(4 * IN), values: { mark: "C3B" } },
    { type: "create_element", elementId: "col-l1-3c", levelId: "L1", kind: "column", classId: "struct.column_steel", typeId: "type-col-w10x33", material: "steel", placement: { kind: "point", position: pt(W_MAIN, D_ALL) }, size: { widthMm: 254, depthMm: 254 }, topLevelId: "L2", topOffsetMm: -Math.round(4 * IN), values: { mark: "C3C" } },
    { type: "create_element", elementId: "col-l1-4a", levelId: "L1", kind: "column", classId: "struct.column_steel", typeId: "type-col-w8x31", material: "steel", placement: { kind: "point", position: pt(W_ALL, 0) }, size: { widthMm: 203, depthMm: 203 }, topLevelId: "L2", topOffsetMm: -Math.round(4 * IN), values: { mark: "C4A" } },
    { type: "create_element", elementId: "col-l1-4b", levelId: "L1", kind: "column", classId: "struct.column_steel", typeId: "type-col-w8x31", material: "steel", placement: { kind: "point", position: pt(W_ALL, 14 * FT), rotationDeg: 90 }, size: { widthMm: 203, depthMm: 203 }, topLevelId: "L2", topOffsetMm: -Math.round(4 * IN), values: { mark: "C4B" } },
    { type: "create_element", elementId: "col-l1-4c", levelId: "L1", kind: "column", classId: "struct.column_steel", typeId: "type-col-w8x31", material: "steel", placement: { kind: "point", position: pt(W_ALL, D_ALL) }, size: { widthMm: 203, depthMm: 203 }, topLevelId: "L2", topOffsetMm: -Math.round(4 * IN), values: { mark: "C4C" } },
    // Explicit fixed-height exterior balcony columns supporting L2 South Terrace (11'-4" clear underside)
    { type: "create_element", elementId: "col-l1-2s", levelId: "L1", kind: "column", classId: "struct.column_steel", typeId: "type-col-w8x31", material: "steel", placement: { kind: "point", position: pt(W_WEST, -4.5 * FT) }, size: { widthMm: 203, depthMm: 203, heightMm: H1 - Math.round(8 * IN) }, values: { mark: "C2S" } },
    { type: "create_element", elementId: "col-l1-3s", levelId: "L1", kind: "column", classId: "struct.column_steel", typeId: "type-col-w8x31", material: "steel", placement: { kind: "point", position: pt(W_MAIN, -4.5 * FT) }, size: { widthMm: 203, depthMm: 203, heightMm: H1 - Math.round(8 * IN) }, values: { mark: "C3S" } },

    // Level 2 West Wing steel columns (spliced above L2 floor, top tied to ROOF underside)
    { type: "create_element", elementId: "col-l2-1a", levelId: "L2", kind: "column", classId: "struct.column_steel", typeId: "type-col-w8x31", material: "steel", placement: { kind: "point", position: pt(0, 0) }, size: { widthMm: 203, depthMm: 203 }, topLevelId: "ROOF", topOffsetMm: -Math.round(4 * IN), values: { mark: "C1A-2" } },
    { type: "create_element", elementId: "col-l2-1b", levelId: "L2", kind: "column", classId: "struct.column_steel", typeId: "type-col-w8x31", material: "steel", placement: { kind: "point", position: pt(0, 14 * FT), rotationDeg: 90 }, size: { widthMm: 203, depthMm: 203 }, topLevelId: "ROOF", topOffsetMm: -Math.round(4 * IN), values: { mark: "C1B-2" } },
    { type: "create_element", elementId: "col-l2-1c", levelId: "L2", kind: "column", classId: "struct.column_steel", typeId: "type-col-w8x31", material: "steel", placement: { kind: "point", position: pt(0, D_ALL) }, size: { widthMm: 203, depthMm: 203 }, topLevelId: "ROOF", topOffsetMm: -Math.round(4 * IN), values: { mark: "C1C-2" } },
    { type: "create_element", elementId: "col-l2-2a", levelId: "L2", kind: "column", classId: "struct.column_steel", typeId: "type-col-w8x31", material: "steel", placement: { kind: "point", position: pt(W_WEST, 0) }, size: { widthMm: 203, depthMm: 203 }, topLevelId: "ROOF", topOffsetMm: -Math.round(4 * IN), values: { mark: "C2A-2" } },
    { type: "create_element", elementId: "col-l2-2b", levelId: "L2", kind: "column", classId: "struct.column_steel", typeId: "type-col-w8x31", material: "steel", placement: { kind: "point", position: pt(W_WEST, 14 * FT), rotationDeg: 90 }, size: { widthMm: 203, depthMm: 203 }, topLevelId: "ROOF", topOffsetMm: -Math.round(4 * IN), values: { mark: "C2B-2" } },
    { type: "create_element", elementId: "col-l2-2c", levelId: "L2", kind: "column", classId: "struct.column_steel", typeId: "type-col-w8x31", material: "steel", placement: { kind: "point", position: pt(W_WEST, D_ALL) }, size: { widthMm: 203, depthMm: 203 }, topLevelId: "ROOF", topOffsetMm: -Math.round(4 * IN), values: { mark: "C2C-2" } },
    { type: "create_element", elementId: "col-l2-3a", levelId: "L2", kind: "column", classId: "struct.column_steel", typeId: "type-col-w8x31", material: "steel", placement: { kind: "point", position: pt(W_MAIN, 0) }, size: { widthMm: 203, depthMm: 203 }, topLevelId: "ROOF", topOffsetMm: -Math.round(4 * IN), values: { mark: "C3A-2" } },
    { type: "create_element", elementId: "col-l2-3b", levelId: "L2", kind: "column", classId: "struct.column_steel", typeId: "type-col-w8x31", material: "steel", placement: { kind: "point", position: pt(W_MAIN, 14 * FT), rotationDeg: 90 }, size: { widthMm: 203, depthMm: 203 }, topLevelId: "ROOF", topOffsetMm: -Math.round(4 * IN), values: { mark: "C3B-2" } },
    { type: "create_element", elementId: "col-l2-3c", levelId: "L2", kind: "column", classId: "struct.column_steel", typeId: "type-col-w8x31", material: "steel", placement: { kind: "point", position: pt(W_MAIN, D_ALL) }, size: { widthMm: 203, depthMm: 203 }, topLevelId: "ROOF", topOffsetMm: -Math.round(4 * IN), values: { mark: "C3C-2" } },

    // Reinforced Concrete Pad Footings (one under every L1 column, top at -8" under ground slab)
    { type: "create_element", elementId: "ftg-1a", levelId: "L1", kind: "component", category: "footing", classId: "struct.footing_pad", typeId: "type-ftg-5x5", placement: { kind: "point", position: pt(0, 0) }, baseOffsetMm: -Math.round(8 * IN), size: { widthMm: Math.round(5 * FT), depthMm: Math.round(5 * FT) }, values: { mark: "F1A" } },
    { type: "create_element", elementId: "ftg-1b", levelId: "L1", kind: "component", category: "footing", classId: "struct.footing_pad", typeId: "type-ftg-5x5", placement: { kind: "point", position: pt(0, 14 * FT) }, baseOffsetMm: -Math.round(8 * IN), size: { widthMm: Math.round(5 * FT), depthMm: Math.round(5 * FT) }, values: { mark: "F1B" } },
    { type: "create_element", elementId: "ftg-1c", levelId: "L1", kind: "component", category: "footing", classId: "struct.footing_pad", typeId: "type-ftg-5x5", placement: { kind: "point", position: pt(0, D_ALL) }, baseOffsetMm: -Math.round(8 * IN), size: { widthMm: Math.round(5 * FT), depthMm: Math.round(5 * FT) }, values: { mark: "F1C" } },
    { type: "create_element", elementId: "ftg-2a", levelId: "L1", kind: "component", category: "footing", classId: "struct.footing_pad", typeId: "type-ftg-5x5", placement: { kind: "point", position: pt(W_WEST, 0) }, baseOffsetMm: -Math.round(8 * IN), size: { widthMm: Math.round(5 * FT), depthMm: Math.round(5 * FT) }, values: { mark: "F2A" } },
    { type: "create_element", elementId: "ftg-2b", levelId: "L1", kind: "component", category: "footing", classId: "struct.footing_pad", typeId: "type-ftg-6x6", placement: { kind: "point", position: pt(W_WEST, 14 * FT) }, baseOffsetMm: -Math.round(8 * IN), size: { widthMm: Math.round(6 * FT), depthMm: Math.round(6 * FT) }, values: { mark: "F2B" } },
    { type: "create_element", elementId: "ftg-2c", levelId: "L1", kind: "component", category: "footing", classId: "struct.footing_pad", typeId: "type-ftg-5x5", placement: { kind: "point", position: pt(W_WEST, D_ALL) }, baseOffsetMm: -Math.round(8 * IN), size: { widthMm: Math.round(5 * FT), depthMm: Math.round(5 * FT) }, values: { mark: "F2C" } },
    { type: "create_element", elementId: "ftg-25b", levelId: "L1", kind: "component", category: "footing", classId: "struct.footing_pad", typeId: "type-ftg-6x6", placement: { kind: "point", position: pt(26 * FT, 14 * FT) }, baseOffsetMm: -Math.round(8 * IN), size: { widthMm: Math.round(6 * FT), depthMm: Math.round(6 * FT) }, values: { mark: "F25B" } },
    { type: "create_element", elementId: "ftg-3a", levelId: "L1", kind: "component", category: "footing", classId: "struct.footing_pad", typeId: "type-ftg-5x5", placement: { kind: "point", position: pt(W_MAIN, 0) }, baseOffsetMm: -Math.round(8 * IN), size: { widthMm: Math.round(5 * FT), depthMm: Math.round(5 * FT) }, values: { mark: "F3A" } },
    { type: "create_element", elementId: "ftg-3b", levelId: "L1", kind: "component", category: "footing", classId: "struct.footing_pad", typeId: "type-ftg-6x6", placement: { kind: "point", position: pt(W_MAIN, 14 * FT) }, baseOffsetMm: -Math.round(8 * IN), size: { widthMm: Math.round(6 * FT), depthMm: Math.round(6 * FT) }, values: { mark: "F3B" } },
    { type: "create_element", elementId: "ftg-3c", levelId: "L1", kind: "component", category: "footing", classId: "struct.footing_pad", typeId: "type-ftg-5x5", placement: { kind: "point", position: pt(W_MAIN, D_ALL) }, baseOffsetMm: -Math.round(8 * IN), size: { widthMm: Math.round(5 * FT), depthMm: Math.round(5 * FT) }, values: { mark: "F3C" } },
    { type: "create_element", elementId: "ftg-4a", levelId: "L1", kind: "component", category: "footing", classId: "struct.footing_pad", typeId: "type-ftg-4x4", placement: { kind: "point", position: pt(W_ALL, 0) }, baseOffsetMm: -Math.round(8 * IN), size: { widthMm: Math.round(4 * FT), depthMm: Math.round(4 * FT) }, values: { mark: "F4A" } },
    { type: "create_element", elementId: "ftg-4b", levelId: "L1", kind: "component", category: "footing", classId: "struct.footing_pad", typeId: "type-ftg-4x4", placement: { kind: "point", position: pt(W_ALL, 14 * FT) }, baseOffsetMm: -Math.round(8 * IN), size: { widthMm: Math.round(4 * FT), depthMm: Math.round(4 * FT) }, values: { mark: "F4B" } },
    { type: "create_element", elementId: "ftg-4c", levelId: "L1", kind: "component", category: "footing", classId: "struct.footing_pad", typeId: "type-ftg-4x4", placement: { kind: "point", position: pt(W_ALL, D_ALL) }, baseOffsetMm: -Math.round(8 * IN), size: { widthMm: Math.round(4 * FT), depthMm: Math.round(4 * FT) }, values: { mark: "F4C" } },
    { type: "create_element", elementId: "ftg-2s", levelId: "L1", kind: "component", category: "footing", classId: "struct.footing_pad", typeId: "type-ftg-4x4", placement: { kind: "point", position: pt(W_WEST, -4.5 * FT) }, baseOffsetMm: -Math.round(8 * IN), size: { widthMm: Math.round(4 * FT), depthMm: Math.round(4 * FT) }, values: { mark: "F2S" } },
    { type: "create_element", elementId: "ftg-3s", levelId: "L1", kind: "component", category: "footing", classId: "struct.footing_pad", typeId: "type-ftg-4x4", placement: { kind: "point", position: pt(W_MAIN, -4.5 * FT) }, baseOffsetMm: -Math.round(8 * IN), size: { widthMm: Math.round(4 * FT), depthMm: Math.round(4 * FT) }, values: { mark: "F3S" } },

    // Level 2 Floor Framing & East Studio Roof Framing (top-of-steel at -4" embedded into composite deck)
    // E-W Primary Gravity Beams & Girders (receiving N-S one-way slab-l2-main, slab-l2-terrace & deck-roof-east + RTU-1)
    { type: "create_element", elementId: "bm-l2-a1", levelId: "L2", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w16x26", label: "W16x26", placement: { kind: "line", start: pt(0, 0), end: pt(W_WEST, 0) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "B2-A1" } },
    { type: "create_element", elementId: "bm-l2-a2", levelId: "L2", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w16x26", label: "W16x26", placement: { kind: "line", start: pt(W_WEST, 0), end: pt(W_MAIN, 0) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "B2-A2" } },
    { type: "create_element", elementId: "bm-l2-a3", levelId: "L2", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w18x35", label: "W18x35", placement: { kind: "line", start: pt(W_MAIN, 0), end: pt(W_ALL, 0) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "B2-A3" } },
    { type: "create_element", elementId: "bm-l2-b1", levelId: "L2", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w14x22", label: "W14x22", placement: { kind: "line", start: pt(0, 14 * FT), end: pt(W_WEST, 14 * FT) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "G2-B1" } },
    { type: "create_element", elementId: "bm-l2-b2", levelId: "L2", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w16x26", label: "W16x26", placement: { kind: "line", start: pt(W_WEST, 14 * FT), end: pt(26 * FT, 14 * FT) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "G2-B2" } },
    { type: "create_element", elementId: "bm-l2-b3", levelId: "L2", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w16x26", label: "W16x26", placement: { kind: "line", start: pt(26 * FT, 14 * FT), end: pt(W_MAIN, 14 * FT) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "G2-B3" } },
    // 22' clear-span East Studio roof girder carrying deck-roof-east live load + RTU-1 equipment point load
    { type: "create_element", elementId: "bm-l2-b4", levelId: "L2", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w14x22", label: "W14x22", placement: { kind: "line", start: pt(W_MAIN, 14 * FT), end: pt(W_ALL, 14 * FT) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "G2-B4" } },
    { type: "create_element", elementId: "bm-l2-c1", levelId: "L2", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w16x26", label: "W16x26", placement: { kind: "line", start: pt(0, D_ALL), end: pt(W_WEST, D_ALL) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "B2-C1" } },
    { type: "create_element", elementId: "bm-l2-c2", levelId: "L2", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w16x26", label: "W16x26", placement: { kind: "line", start: pt(W_WEST, D_ALL), end: pt(W_MAIN, D_ALL) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "B2-C2" } },
    { type: "create_element", elementId: "bm-l2-c3", levelId: "L2", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w16x26", label: "W16x26", placement: { kind: "line", start: pt(W_MAIN, D_ALL), end: pt(W_ALL, D_ALL) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "B2-C3" } },
    // South Balcony Framing + N-S Tie/Collector Beams at Level 2
    { type: "create_element", elementId: "bm-l2-s1", levelId: "L2", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w14x22", label: "W14x22", placement: { kind: "line", start: pt(W_WEST, -4.5 * FT), end: pt(W_MAIN, -4.5 * FT) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "B2-S1" } },
    { type: "create_element", elementId: "bm-l2-1s", levelId: "L2", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w12x26", label: "W12x26", placement: { kind: "line", start: pt(0, 0), end: pt(0, 14 * FT) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "T2-1S" } },
    { type: "create_element", elementId: "bm-l2-1n", levelId: "L2", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w12x26", label: "W12x26", placement: { kind: "line", start: pt(0, 14 * FT), end: pt(0, D_ALL) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "T2-1N" } },
    { type: "create_element", elementId: "bm-l2-2s", levelId: "L2", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w12x26", label: "W12x26", placement: { kind: "line", start: pt(W_WEST, 0), end: pt(W_WEST, 14 * FT) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "T2-2S" } },
    { type: "create_element", elementId: "bm-l2-2n", levelId: "L2", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w12x26", label: "W12x26", placement: { kind: "line", start: pt(W_WEST, 14 * FT), end: pt(W_WEST, D_ALL) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "T2-2N" } },
    { type: "create_element", elementId: "bm-l2-3s", levelId: "L2", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w12x26", label: "W12x26", placement: { kind: "line", start: pt(W_MAIN, 0), end: pt(W_MAIN, 14 * FT) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "T2-3S" } },
    { type: "create_element", elementId: "bm-l2-3n", levelId: "L2", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w12x26", label: "W12x26", placement: { kind: "line", start: pt(W_MAIN, 14 * FT), end: pt(W_MAIN, D_ALL) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "T2-3N" } },
    { type: "create_element", elementId: "bm-l2-4s", levelId: "L2", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w12x26", label: "W12x26", placement: { kind: "line", start: pt(W_ALL, 0), end: pt(W_ALL, 14 * FT) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "T2-4S" } },
    { type: "create_element", elementId: "bm-l2-4n", levelId: "L2", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w12x26", label: "W12x26", placement: { kind: "line", start: pt(W_ALL, 14 * FT), end: pt(W_ALL, D_ALL) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "T2-4N" } },
    { type: "create_element", elementId: "bm-l2-bal-w", levelId: "L2", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w12x26", label: "W12x26", placement: { kind: "line", start: pt(W_WEST, -4.5 * FT), end: pt(W_WEST, 0) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "T2-BW" } },
    { type: "create_element", elementId: "bm-l2-bal-e", levelId: "L2", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w12x26", label: "W12x26", placement: { kind: "line", start: pt(W_MAIN, -4.5 * FT), end: pt(W_MAIN, 0) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "T2-BE" } },

    // Roof Level West Wing Framing (supporting deck-roof-west)
    { type: "create_element", elementId: "bm-rf-a1", levelId: "ROOF", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w14x22", label: "W14x22", placement: { kind: "line", start: pt(0, 0), end: pt(W_WEST, 0) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "BR-A1" } },
    { type: "create_element", elementId: "bm-rf-a2", levelId: "ROOF", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w14x22", label: "W14x22", placement: { kind: "line", start: pt(W_WEST, 0), end: pt(W_MAIN, 0) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "BR-A2" } },
    { type: "create_element", elementId: "bm-rf-b1", levelId: "ROOF", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w16x26", label: "W16x26", placement: { kind: "line", start: pt(0, 14 * FT), end: pt(W_WEST, 14 * FT) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "GR-B1" } },
    { type: "create_element", elementId: "bm-rf-b2", levelId: "ROOF", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w14x22", label: "W14x22", placement: { kind: "line", start: pt(W_WEST, 14 * FT), end: pt(26 * FT, 14 * FT) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "GR-B2" } },
    { type: "create_element", elementId: "bm-rf-b3", levelId: "ROOF", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w14x22", label: "W14x22", placement: { kind: "line", start: pt(26 * FT, 14 * FT), end: pt(W_MAIN, 14 * FT) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "GR-B3" } },
    { type: "create_element", elementId: "bm-rf-c1", levelId: "ROOF", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w14x22", label: "W14x22", placement: { kind: "line", start: pt(0, D_ALL), end: pt(W_WEST, D_ALL) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "BR-C1" } },
    { type: "create_element", elementId: "bm-rf-c2", levelId: "ROOF", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w14x22", label: "W14x22", placement: { kind: "line", start: pt(W_WEST, D_ALL), end: pt(W_MAIN, D_ALL) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "BR-C2" } },
    { type: "create_element", elementId: "bm-rf-1s", levelId: "ROOF", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w12x26", label: "W12x26", placement: { kind: "line", start: pt(0, 0), end: pt(0, 14 * FT) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "TR-1S" } },
    { type: "create_element", elementId: "bm-rf-1n", levelId: "ROOF", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w12x26", label: "W12x26", placement: { kind: "line", start: pt(0, 14 * FT), end: pt(0, D_ALL) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "TR-1N" } },
    { type: "create_element", elementId: "bm-rf-2s", levelId: "ROOF", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w12x26", label: "W12x26", placement: { kind: "line", start: pt(W_WEST, 0), end: pt(W_WEST, 14 * FT) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "TR-2S" } },
    { type: "create_element", elementId: "bm-rf-2n", levelId: "ROOF", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w12x26", label: "W12x26", placement: { kind: "line", start: pt(W_WEST, 14 * FT), end: pt(W_WEST, D_ALL) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "TR-2N" } },
    { type: "create_element", elementId: "bm-rf-3s", levelId: "ROOF", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w12x26", label: "W12x26", placement: { kind: "line", start: pt(W_MAIN, 0), end: pt(W_MAIN, 14 * FT) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "TR-3S" } },
    { type: "create_element", elementId: "bm-rf-3n", levelId: "ROOF", kind: "beam", classId: "struct.beam_steel", typeId: "type-bm-w12x26", label: "W12x26", placement: { kind: "line", start: pt(W_MAIN, 14 * FT), end: pt(W_MAIN, D_ALL) }, baseOffsetMm: -Math.round(4 * IN), values: { mark: "TR-3N" } },

    // Level 1 Doors & Windows
    ...opening("d-101", "L1", "w-l1-s-west", "door", 9 * FT, 6 * FT, 7.5 * FT, "D101", { "architecture.door_operation": "DOUBLE_DOOR_SINGLE_SWING", "host.side": -1 }),
    ...opening("d-102", "L1", "w-l1-core", "door", 6 * FT, 3 * FT, 7 * FT, "D102", { "architecture.door_operation": "SINGLE_SWING_LEFT", "host.side": -1 }),
    ...opening("d-103", "L1", "w-l1-core", "door", 25 * FT, 3 * FT, 7 * FT, "D103", { "architecture.door_operation": "SINGLE_SWING_LEFT", "host.side": -1 }),
    ...opening("d-104", "L1", "w-l1-studio-div", "door", 10.5 * FT, 3.5 * FT, 8 * FT, "D104", { "architecture.door_operation": "SINGLE_SWING_RIGHT", "host.side": -1 }),
    ...opening("d-105", "L1", "w-l1-n-main", "door", 1.8 * FT, 3.0 * FT, 8 * FT, "D105", { "architecture.door_operation": "SINGLE_SWING_LEFT", "host.side": 1 }),
    ...opening("d-106", "L1", "w-l1-print-s", "door", 4.5 * FT, 3 * FT, 7 * FT, "D106", { "architecture.door_operation": "SINGLE_SWING_LEFT", "host.side": 1 }),
    ...opening("win-101", "L1", "w-l1-w", "window", 24.5 * FT, 5 * FT, 3 * FT, "W101", { "architecture.window_partitioning": "DOUBLE_PANEL_VERTICAL", "architecture.sill_height": Math.round(6.5 * FT) }),
    ...opening("win-102", "L1", "w-l1-n-west", "window", 9 * FT, 6 * FT, 3 * FT, "W102", { "architecture.window_partitioning": "DOUBLE_PANEL_VERTICAL", "architecture.sill_height": Math.round(6.5 * FT) }),
    ...opening("win-103", "L1", "w-l1-n-east", "window", 5.5 * FT, 8 * FT, 6 * FT, "W103", { "architecture.window_partitioning": "TRIPLE_PANEL_VERTICAL", "architecture.sill_height": Math.round(2.5 * FT) }),
    ...opening("win-104", "L1", "w-l1-e-solid", "window", 4 * FT, 4.5 * FT, 6.5 * FT, "W104", { "architecture.window_partitioning": "SINGLE_PANEL", "architecture.sill_height": Math.round(2.5 * FT) }),

    // Level 1 Ceilings (9'-6" real-scale 2'×4' ACT Cloud in Studio 104 + 9'-6" GWB Soffit in Reception/Break 103 + 9'-0" GWB in Restroom 102)
    // Leaves a generous 1'-10" clear commercial MEP plenum (9'-6" to 11'-4") for ductwork & flex drops!
    // Explicit 2'×4' (1219.2 × 609.6 mm) ACT grid aligned to (36', 2') so every 2×4 troffer and 2×2 diffuser drops dead-center in real tiles.
    {
      type: "create_ceiling",
      ceilings: [
        {
          ceilingId: "clg-l1-studio",
          levelId: "L1",
          heightMm: Math.round(9.5 * FT),
          form: "cloud",
          outline: [pt(36.0 * FT, 2.0 * FT), pt(54.0 * FT, 2.0 * FT), pt(54.0 * FT, 20.0 * FT), pt(36.0 * FT, 20.0 * FT)],
          grid: { spacingXMm: TILE_4FT_MM, spacingYMm: TILE_2FT_MM, origin: pt(36.0 * FT, 2.0 * FT), rotationDeg: 0 },
        },
        { ceilingId: "clg-l1-reception", levelId: "L1", heightMm: Math.round(9.5 * FT), form: "soffit", outline: [pt(W_WEST + 4 * IN, 13.5 * FT), pt(26.5 * FT, 13.5 * FT), pt(26.5 * FT, 19.8 * FT), pt(W_WEST + 4 * IN, 19.8 * FT)] },
        { ceilingId: "clg-l1-restroom", levelId: "L1", heightMm: Math.round(9.0 * FT), form: "flat", outline: [pt(6 * IN, Y_WET + 4 * IN), pt(W_WEST - 4 * IN, Y_WET + 4 * IN), pt(W_WEST - 4 * IN, D_ALL - 6 * IN), pt(6 * IN, D_ALL - 6 * IN)] },
      ],
    },
    { type: "set_element_values", elementIds: ["clg-l1-studio"], values: { "material.id": "architecture.act_ceiling" } },
    { type: "set_element_values", elementIds: ["clg-l1-reception", "clg-l1-restroom"], values: { "material.id": "architecture.gypsum_partition" } },

    // Code-Compliant 180° U-Turn Oak Stair (L1 0'-0" → L2 12'-0": 22 risers @ 6.55", 10+10 treads @ 11.02", 3'-0" width & mid-landing; climbs North along East wall, turns Left onto NE mid-landing, and arrives heading South onto the wide-open L2 Loft at y = 15.2' with 15' clear ahead & 8'-6" gallery to West!)
    {
      type: "create_element",
      kind: "architecture.stair",
      elementId: "stair-main",
      levelId: "L1",
      placement: { kind: "line", start: pt(31.8 * FT, 15.2 * FT), end: pt(31.8 * FT, 24.386 * FT) },
      size: { widthMm: Math.round(3.0 * FT) },
      values: {
        "architecture.stair_form": "u_shape",
        "architecture.stair_turn": "left",
        "architecture.risers": 22,
        "architecture.landing_depth_mm": Math.round(3.0 * FT),
        "architecture.well_gap_mm": Math.round(0.5 * FT),
        "material.id": "architecture.wood_oak",
      },
    },

    // Architectural Roofs:
    // 1. East Studio flat concrete roof deck at L2 (12'-0", thickness 8" -> underside at 11'-4" — CLEAR above 10'-8" ductwork!)
    // 2. West Upper Wing standing-seam metal shed roof at ROOF (22'-0")
    {
      type: "create_element",
      kind: "architecture.roof",
      elementId: "roof-east-flat",
      levelId: "L2",
      placement: { kind: "area", outline: [pt(W_MAIN, 0), pt(W_ALL, 0), pt(W_ALL, D_ALL), pt(W_MAIN, D_ALL)] },
      size: { thicknessMm: Math.round(8 * IN) },
      values: { "architecture.roof_form": "flat", "material.id": "architecture.concrete_slab" },
    },
    {
      type: "create_element",
      kind: "architecture.roof",
      elementId: "roof-west-shed",
      levelId: "ROOF",
      placement: { kind: "area", outline: [pt(-2.5 * FT, -2.5 * FT), pt(W_MAIN + 2.5 * FT, -2.5 * FT), pt(W_MAIN + 2.5 * FT, D_ALL + 2.5 * FT), pt(-2.5 * FT, D_ALL + 2.5 * FT)] },
      size: { thicknessMm: Math.round(10 * IN) },
      values: { "architecture.roof_form": "shed", "architecture.slope_rise": 2.0 / 12, "architecture.slope_direction_deg": 90, "material.id": "architecture.standing_seam_metal" },
    },

    // Level 2 Walls (main volume attached to sloped roof + East Studio 3'-0" parapet walls screening RTU-1 + Balcony glass guardrail!)
    wall("w-l2-s-west", "L2", 0, 0, W_WEST, 0, EXT_T, H2, "type-wall-stucco"),
    wall("w-l2-s-cedar", "L2", W_WEST, 0, W_MAIN, 0, EXT_T, H2, "type-wall-cedar"),
    wall("w-l2-e", "L2", W_MAIN, 0, W_MAIN, D_ALL, EXT_T, H2, "type-wall-cedar"),
    wall("w-l2-n", "L2", 0, D_ALL, W_MAIN, D_ALL, EXT_T, H2, "type-wall-stucco"),
    wall("w-l2-w", "L2", 0, 0, 0, D_ALL, EXT_T, H2, "type-wall-charcoal"),
    wall("w-l2-core", "L2", W_WEST, 0, W_WEST, D_ALL, INT_T, H2, "type-wall-interior"),
    wall("w-l2-wet", "L2", 0, Y_WET, W_WEST, Y_WET, WET_T, H2, "type-wall-wet"),
    wall("w-l2-stall-1", "L2", 5.75 * FT, Y_WET + 4 * IN, 5.75 * FT, 26.0 * FT, STALL_T, Math.round(6 * FT), "type-wall-stall"),
    wall("w-l2-stall-2", "L2", 9.25 * FT, Y_WET + 4 * IN, 9.25 * FT, 26.0 * FT, STALL_T, Math.round(6 * FT), "type-wall-stall"),
    // East Studio Parapet Walls (3'-0" tall, neatly screening Carrier RTU-1 from street level!)
    wall("w-l2-para-s", "L2", W_MAIN, 0, W_ALL, 0, EXT_T, PARAPET_H, "type-wall-concrete"),
    wall("w-l2-para-e", "L2", W_ALL, 0, W_ALL, D_ALL, EXT_T, PARAPET_H, "type-wall-concrete"),
    wall("w-l2-para-n", "L2", W_MAIN, D_ALL, W_ALL, D_ALL, EXT_T, PARAPET_H, "type-wall-concrete"),
    // L2 South Balcony 42" Architectural Glass Guardrail (first-class `architecture.railing` → `IfcRailing`, continuous U-polyline)
    {
      type: "create_element",
      elementId: "rail-l2-balcony",
      levelId: "L2",
      kind: "architecture.railing",
      placement: { kind: "line", start: pt(W_WEST, 0), end: pt(W_MAIN, 0) },
      size: { heightMm: GUARD_H },
      values: {
        "architecture.railing_style": "glass",
        "architecture.railing_height_mm": GUARD_H,
        "architecture.post_spacing_mm": Math.round(5 * FT),
        "architecture.railing_path": [pt(W_WEST, 0), pt(W_WEST, -4.8 * FT), pt(W_MAIN, -4.8 * FT), pt(W_MAIN, 0)].map((p) => `${p.x},${p.y}`).join(";"),
        "material.id": "architecture.aluminum_frame",
      },
    },
    // L2 Stairwell Opening 42" Architectural Glass Guardrails (West edge + South edge over Flight 1; leaves Flight 2 arrival 26.7'..29.8' open)
    {
      type: "create_element",
      elementId: "rail-l2-stair-w",
      levelId: "L2",
      kind: "architecture.railing",
      placement: { kind: "line", start: pt(26.7 * FT, 15.2 * FT), end: pt(26.7 * FT, 27.4 * FT) },
      size: { heightMm: GUARD_H },
      values: {
        "architecture.railing_style": "glass",
        "architecture.railing_height_mm": GUARD_H,
        "architecture.post_spacing_mm": Math.round(4.5 * FT),
        "material.id": "architecture.aluminum_frame",
      },
    },
    {
      type: "create_element",
      elementId: "rail-l2-stair-s",
      levelId: "L2",
      kind: "architecture.railing",
      placement: { kind: "line", start: pt(29.8 * FT, 15.2 * FT), end: pt(33.5 * FT, 15.2 * FT) },
      size: { heightMm: GUARD_H },
      values: {
        "architecture.railing_style": "glass",
        "architecture.railing_height_mm": GUARD_H,
        "architecture.post_spacing_mm": Math.round(4 * FT),
        "material.id": "architecture.aluminum_frame",
      },
    },

    // Level 2 Doors & Windows
    ...opening("d-201", "L2", "w-l2-core", "door", 10 * FT, 3 * FT, 7 * FT, "D201", { "architecture.door_operation": "SINGLE_SWING_LEFT", "host.side": -1 }),
    ...opening("d-202", "L2", "w-l2-s-cedar", "door", 8 * FT, 7 * FT, 8 * FT, "D202", { "architecture.door_operation": "SLIDING_TO_RIGHT", "host.side": -1 }),
    ...opening("d-203", "L2", "w-l2-core", "door", 25 * FT, 3 * FT, 7 * FT, "D203", { "architecture.door_operation": "SINGLE_SWING_LEFT", "host.side": -1 }),
    ...opening("win-201", "L2", "w-l2-s-west", "window", 9 * FT, 8 * FT, 5.5 * FT, "W201", { "architecture.window_partitioning": "TRIPLE_PANEL_VERTICAL", "architecture.sill_height": Math.round(2.5 * FT) }),
    ...opening("win-202", "L2", "w-l2-e", "window", 10 * FT, 8 * FT, 5.5 * FT, "W202", { "architecture.window_partitioning": "TRIPLE_PANEL_VERTICAL", "architecture.sill_height": Math.round(2.5 * FT) }),
    ...opening("win-203", "L2", "w-l2-w", "window", 10 * FT, 8 * FT, 5.5 * FT, "W203", { "architecture.window_partitioning": "TRIPLE_PANEL_VERTICAL", "architecture.sill_height": Math.round(2.5 * FT) }),
    ...opening("win-204", "L2", "w-l2-n", "window", 9 * FT, 6 * FT, 3 * FT, "W204", { "architecture.window_partitioning": "DOUBLE_PANEL_VERTICAL", "architecture.sill_height": Math.round(6.5 * FT) }),

    // Program Spaces (L1 + L2)
    {
      type: "create_space",
      spaces: [
        { spaceId: "sp-101", levelId: "L1", number: "101", name: "MEP / ELECTRICAL", outline: [pt(0, 0), pt(W_WEST, 0), pt(W_WEST, Y_WET), pt(0, Y_WET)] },
        { spaceId: "sp-102", levelId: "L1", number: "102", name: "RESTROOM", outline: [pt(0, Y_WET), pt(W_WEST, Y_WET), pt(W_WEST, D_ALL), pt(0, D_ALL)] },
        { spaceId: "sp-103", levelId: "L1", number: "103", name: "RECEPTION & BREAK", outline: [pt(W_WEST, 0), pt(W_MAIN, 0), pt(W_MAIN, D_ALL), pt(W_WEST, D_ALL)] },
        { spaceId: "sp-104", levelId: "L1", number: "104", name: "DESIGN STUDIO", outline: [pt(W_MAIN, 0), pt(W_ALL, 0), pt(W_ALL, 20.5 * FT), pt(47 * FT, 20.5 * FT), pt(47 * FT, D_ALL), pt(W_MAIN, D_ALL)] },
        { spaceId: "sp-105", levelId: "L1", number: "105", name: "PRINT / PLOTTER", outline: [pt(47 * FT, 20.5 * FT), pt(W_ALL, 20.5 * FT), pt(W_ALL, D_ALL), pt(47 * FT, D_ALL)] },
        { spaceId: "sp-201", levelId: "L2", number: "201", name: "CONFERENCE", outline: [pt(0, 0), pt(W_WEST, 0), pt(W_WEST, Y_WET), pt(0, Y_WET)] },
        { spaceId: "sp-202", levelId: "L2", number: "202", name: "RESTROOM", outline: [pt(0, Y_WET), pt(W_WEST, Y_WET), pt(W_WEST, D_ALL), pt(0, D_ALL)] },
        { spaceId: "sp-203", levelId: "L2", number: "203", name: "MEZZANINE LOFT", outline: [pt(W_WEST, 0), pt(W_MAIN, 0), pt(W_MAIN, D_ALL), pt(W_WEST, D_ALL)] },
        { spaceId: "sp-204", levelId: "L2", number: "204", name: "BALCONY TERRACE", outline: [pt(W_WEST, -5.0 * FT), pt(W_MAIN, -5.0 * FT), pt(W_MAIN, 0), pt(W_WEST, 0)] },
      ],
    },
  ]);

  // Attach Level 2 main-volume walls tightly up to the sloped standing-seam roof underside
  const l2Attach: Record<string, [Vec2, Vec2]> = {
    "w-l2-s-west": [pt(0, 0), pt(W_WEST, 0)],
    "w-l2-s-cedar": [pt(W_WEST, 0), pt(W_MAIN, 0)],
    "w-l2-e": [pt(W_MAIN, 0), pt(W_MAIN, D_ALL)],
    "w-l2-n": [pt(0, D_ALL), pt(W_MAIN, D_ALL)],
    "w-l2-w": [pt(0, 0), pt(0, D_ALL)],
    "w-l2-core": [pt(W_WEST, 0), pt(W_WEST, D_ALL)],
    "w-l2-wet": [pt(0, Y_WET), pt(W_WEST, Y_WET)],
  };
  m = runCmds(
    m,
    Object.entries(l2Attach).map(([elementId, [start, end]]) => ({
      type: "set_element_placement" as const,
      elementId,
      placement: {
        kind: "line" as const,
        levelId: "L2",
        start,
        end,
        startOffsetMm: 0,
        endOffsetMm: 0,
        lateral: "center" as const,
        vertical: "bottom" as const,
        topSurface: { to: "roof" as const, elementId: "roof-west-shed" },
      },
    })),
  );

  // =========================================================================
  // 2. REGISTER PART TYPES (Cut-Sheet Custom Parts + Built-In Electrical / HVAC / Plumbing)
  // =========================================================================
  const rgRaw = mustBuiltin("builtin:return-grille-24@1");
  const rg = { ...rgRaw, definition: { ...rgRaw.definition, typeMark: "RG-1" } };
  const egRaw = mustBuiltin("builtin:exhaust-grille-12@1");
  const eg = { ...egRaw, definition: { ...egRaw.definition, typeMark: "EG-1" } };
  const swb = mustBuiltin("builtin:switchboard-800-480@1");
  const hpnl = mustBuiltin("builtin:panelboard-225-480@1");
  const xfmr = mustBuiltin("builtin:transformer-75kva@1");
  const lpnl = mustBuiltin("builtin:panelboard-225@1");
  const discFused = mustBuiltin("builtin:disconnect-fused-100-480@1");
  const discNf30 = mustBuiltin("builtin:disconnect-nf-30-480@1");
  const rec = mustBuiltin("builtin:duplex-receptacle@1");
  const gfci = mustBuiltin("builtin:gfci-receptacle@1");
  const quad = mustBuiltin("builtin:quad-receptacle@1");
  const floorRec = mustBuiltin("builtin:floor-receptacle@1");
  const floorQuad = mustBuiltin("builtin:floor-receptacle-quad@1");
  const nema620 = mustBuiltin("builtin:receptacle-nema-6-20r@1");
  const twistLock = mustBuiltin("builtin:receptacle-twist-lock@1");
  const hardwired = mustBuiltin("builtin:hardwired-connection@1");
  const sw1 = mustBuiltin("builtin:switch-single-pole@1");
  const sw3 = mustBuiltin("builtin:switch-three-way@1");
  const swD = mustBuiltin("builtin:switch-dimmer@1");
  const occ = mustBuiltin("builtin:occupancy-sensor-ceiling@1");
  const exit = mustBuiltin("builtin:exit-sign-led@1");
  const linearPendant = mustBuiltin("builtin:linear-pendant-led@1");
  const exitCombo = mustBuiltin("builtin:exit-combo-wall-pack@1");
  const waterMeter = mustBuiltin("builtin:plumbing-water-meter@1");
  const rpz = mustBuiltin("builtin:plumbing-rpz@1");
  const expTank = mustBuiltin("builtin:plumbing-expansion-tank@1");
  const floorCo = mustBuiltin("builtin:plumbing-cleanout-floor@1");
  const vtr = mustBuiltin("builtin:plumbing-vtr@1");
  const manhole = mustBuiltin("builtin:plumbing-sanitary-manhole-existing@1");

  m = runCmds(m, [
    {
      type: "save_part_types",
      types: [
        ...SHOWCASE_PART_TYPES.map((t) => ({ typeId: t.id, definition: t.definition })),
        ...[rg, eg, swb, hpnl, xfmr, lpnl, discFused, discNf30, rec, gfci, quad, floorRec, floorQuad, nema620, twistLock, hardwired, sw1, sw3, swD, occ, exit, linearPendant, exitCombo, waterMeter, rpz, expTank, floorCo, vtr, manhole].map((t) => ({
          typeId: t.id,
          definition: t.definition,
        })),
      ],
    },
  ]);

  // =========================================================================
  // 3. ARCHITECTURAL MILLWORK & STUDIO WORKTABLES (Real Basin Cutouts & Legged Tables!)
  // =========================================================================
  const Y_WET_NORTH_FACE = Y_WET + 4 * IN; // north face of 8" wet chase wall (21'-4")
  const X_CORE_EAST_FACE = W_WEST + 4 * IN; // east face of 8" CMU wall (18'-4")

  m = runCmds(m, [
    // Dual quartz vanities with TWO real undermount basin cutouts (x = 12.8' ± 1.80' = 11.0' & 14.6')
    { type: "place_part", partId: "vanity-l1", typeId: SHOWCASE_VANITY_DUAL.id, levelId: "L1", position: pt(12.8 * FT, Y_WET_NORTH_FACE), rotationDeg: 0, mark: "" },
    { type: "place_part", partId: "vanity-l2", typeId: SHOWCASE_VANITY_DUAL.id, levelId: "L2", position: pt(12.8 * FT, Y_WET_NORTH_FACE), rotationDeg: 0, mark: "" },
    // Oak kitchenette base & counter with REAL sink cutout centered at (18'-4", 15'-0") facing East (270°)
    { type: "place_part", partId: "kitchen-l1", typeId: SHOWCASE_KITCHENETTE_COUNTER.id, levelId: "L1", position: pt(X_CORE_EAST_FACE, 15.0 * FT), rotationDeg: 270, mark: "" },
    // 4 Real legged oak studio drafting worktables + Quartz Café Island + Plotter table + L2 Oak Conference Table
    { type: "place_part", partId: "cafe-island-l1", typeId: SHOWCASE_CAFE_ISLAND.id, levelId: "L1", position: pt(26.5 * FT, 9.5 * FT), rotationDeg: 0, mark: "" },
    { type: "place_part", partId: "tbl-studio-1", typeId: SHOWCASE_WORKTABLE.id, levelId: "L1", position: pt(40.0 * FT, 6.5 * FT), rotationDeg: 0, mark: "" },
    { type: "place_part", partId: "tbl-studio-2", typeId: SHOWCASE_WORKTABLE.id, levelId: "L1", position: pt(50.0 * FT, 6.5 * FT), rotationDeg: 0, mark: "" },
    { type: "place_part", partId: "tbl-studio-3", typeId: SHOWCASE_WORKTABLE.id, levelId: "L1", position: pt(40.0 * FT, 17.5 * FT), rotationDeg: 0, mark: "" },
    { type: "place_part", partId: "tbl-studio-4", typeId: SHOWCASE_WORKTABLE.id, levelId: "L1", position: pt(50.0 * FT, 16.5 * FT), rotationDeg: 0, mark: "" },
    { type: "place_part", partId: "tbl-plotter-l1", typeId: SHOWCASE_WORKTABLE.id, levelId: "L1", position: pt(51.5 * FT, 25.5 * FT), rotationDeg: 0, mark: "" },
    { type: "place_part", partId: "tbl-conf-l2", typeId: SHOWCASE_CONF_TABLE.id, levelId: "L2", position: pt(9.0 * FT, 10.0 * FT), rotationDeg: 0, mark: "" },
  ]);

  // =========================================================================
  // 4. MECHANICAL — Carrier 50FC-A06 RTU + Greenheck G-085 EF-1 + Vertical Plenum Drops
  //                 + Real `connect_into` Takeoff Taps & Curved 8" FLEX DUCTS!
  // =========================================================================
  const SA_SYS = { id: "sys-sa", kind: "supply_air" as const, name: "Supply Air" };
  const RA_SYS = { id: "sys-ra", kind: "return_air" as const, name: "Return Air" };
  const EA_SYS = { id: "sys-ea", kind: "exhaust_air" as const, name: "Exhaust Air" };
  const PLENUM_Z = Math.round(10.67 * FT); // 10'-8" center (10'-3"..11'-1") — 100% clear above 9'-6" ceiling & below 11'-4" deck!
  const CEILING_Z = Math.round(9.5 * FT);

  m = runCmds(m, [
    // Packaged RTU-1 on East flat parapet roof (L2 = 12'-0", hosted on deck-roof-east; 511 lb operating weight from Carrier 50FC-A06 cut sheet) + IMC 306.5 compliant indoor inline EF-1 (Greenheck CSP-B150) discharging up through passive spun-aluminum roof gravity hood GV-1 seated flush on sloped roof!
    { type: "place_part", partId: "rtu-1", typeId: SHOWCASE_RTU.id, levelId: "L2", position: pt(48.5 * FT, 16.0 * FT), offsetMm: 0, host: { kind: "slab", elementId: "deck-roof-east" }, mark: "RTU-1", values: { circuit: "HP-1-1,3,5", serves: "Studio & Reception", room: "East Roof", "electrical.disconnect_required": true, "electrical.local_disconnect": "required", "electrical.disconnect_note": "NEC 440.14 — served via wall-mounted SD-RTU-1 within sight on east parapet" } },
    { type: "place_part", partId: "ef-1", typeId: SHOWCASE_INLINE_FAN.id, levelId: "L2", position: pt(13.0 * FT, 23.5 * FT), offsetMm: Math.round(12.2 * FT), host: { kind: "slab", elementId: "deck-roof-west" }, mark: "EF-1", values: { circuit: "LP-1-7", serves: "Restrooms 102 & 202", room: "Restroom 202 Ceiling Plenum (Indoor)" } },
    { type: "place_part", partId: "gv-1", typeId: SHOWCASE_GRAVITY_HOOD.id, levelId: "ROOF", position: pt(13.0 * FT, 23.5 * FT), offsetMm: Math.round(4.4 * FT), mark: "GV-1", values: { serves: "EF-1 Exhaust Discharge", room: "Upper Roof" } },

    // 4 Titus TMS 24×24 louvered supply diffusers (Type Mark SD-1 shared across instances; each keeps its unique id & individual airflow!)
    { type: "place_part", partId: "sd-1", typeId: SHOWCASE_DIFFUSER.id, levelId: "L1", position: pt(45.0 * FT, 5.0 * FT), offsetMm: CEILING_Z, mark: "", values: { airflow: 450, room: "Design Studio 104" } },
    { type: "place_part", partId: "sd-2", typeId: SHOWCASE_DIFFUSER.id, levelId: "L1", position: pt(43.0 * FT, 15.0 * FT), offsetMm: CEILING_Z, mark: "", values: { airflow: 450, room: "Design Studio 104" } },
    { type: "place_part", partId: "sd-3", typeId: SHOWCASE_DIFFUSER.id, levelId: "L1", position: pt(23.5 * FT, 6.5 * FT), offsetMm: CEILING_Z, mark: "", values: { airflow: 400, room: "Reception & Break 103" } },
    { type: "place_part", partId: "sd-4", typeId: SHOWCASE_DIFFUSER.id, levelId: "L1", position: pt(29.5 * FT, 6.5 * FT), offsetMm: CEILING_Z, mark: "", values: { airflow: 400, room: "Reception & Break 103" } },

    // 2 Return Grilles (Type Mark RG-1; dead-center in Studio ACT 2'×2' half-tile at (45', 25') & Reception at (23.2', 19.2'), 100% clear of supply ducts & stairwell!)
    { type: "place_part", partId: "rg-1", typeId: rg.id, levelId: "L1", position: pt(45.0 * FT, 25.0 * FT), offsetMm: CEILING_Z, mark: "", values: { airflow: 1000 } },
    { type: "place_part", partId: "rg-2", typeId: rg.id, levelId: "L1", position: pt(23.2 * FT, 19.2 * FT), offsetMm: CEILING_Z, mark: "", values: { airflow: 700 } },

    // Stacked Restroom Exhaust Grilles (Type Mark EG-1; L1 9'-0" & L2 8'-6" over open restroom aisle north of vanity)
    { type: "place_part", partId: "eg-2", typeId: eg.id, levelId: "L1", position: pt(11.6 * FT, 25.2 * FT), offsetMm: Math.round(9.0 * FT), mark: "", values: { airflow: 150 } },
    { type: "place_part", partId: "eg-1", typeId: eg.id, levelId: "L2", position: pt(10.2 * FT, 23.5 * FT), offsetMm: Math.round(8.5 * FT), mark: "", values: { airflow: 150 } },

    // Supply Air: vertical drop from RTU-1 curb supply connector (47.12', 15.21') → 16"×10" trunk at 10'-8" (Y = 10.5') with 2" external duct wrap insulation!
    {
      type: "route_run",
      idPrefix: "sa-main",
      levelId: "L1",
      domain: "duct",
      size: { shape: "rect", width: 16 * IN, height: 10 * IN },
      elevationMm: PLENUM_Z,
      insulation: { kind: "wrap", thicknessMm: Math.round(2 * IN) },
      system: SA_SYS,
      from: { kind: "part", partId: "rtu-1", connectorId: "supply" },
      points: [pt(47.12 * FT, 10.5 * FT), pt(22.0 * FT, 10.5 * FT)],
    },

    // Return Air: vertical drop from RTU-1 curb return connector (47.12', 16.85') → turns NORTH to Y = 19.35' (zero overlap with South-going SA drop!),
    // runs West in East Studio north of SD-2, jogs South at X = 35.5' (clear East of stairwell), and continues West at Y = 12.7' (2'-6" south of stairwell & 2'-2" north of SA)!
    {
      type: "route_run",
      idPrefix: "ra-main",
      levelId: "L1",
      domain: "duct",
      size: { shape: "rect", width: 16 * IN, height: 12 * IN },
      elevationMm: PLENUM_Z,
      insulation: { kind: "wrap", thicknessMm: Math.round(2 * IN) },
      system: RA_SYS,
      from: { kind: "part", partId: "rtu-1", connectorId: "return" },
      points: [pt(47.12 * FT, 19.35 * FT), pt(35.5 * FT, 19.35 * FT), pt(35.5 * FT, 12.7 * FT), pt(20.5 * FT, 12.7 * FT)],
    },

    // Exhaust Air: indoor inline EF-1 in Restroom 202 ceiling plenum (100% clear of walls & D203) → straight L2 plenum header to EG-1 + branch drop to L1 EG-2 + vertical roof discharge to GV-1!
    {
      type: "route_run",
      idPrefix: "ea-l2",
      levelId: "L2",
      domain: "duct",
      size: { shape: "round", diameter: 8 * IN },
      elevationMm: Math.round(10.3 * FT),
      system: EA_SYS,
      from: { kind: "part", partId: "ef-1", connectorId: "inlet" },
      points: [pt(13.0 * FT, 23.5 * FT), pt(10.2 * FT, 23.5 * FT)],
      to: { kind: "part", partId: "eg-1", connectorId: "neck" },
    },
    {
      type: "route_run",
      idPrefix: "ea-stack",
      levelId: "L2",
      domain: "duct",
      size: { shape: "round", diameter: 6 * IN },
      elevationMm: Math.round(10.3 * FT),
      system: EA_SYS,
      from: { kind: "run_branch", segmentId: "ea-l2-s2" },
      points: [pt(11.6 * FT, 23.5 * FT), pt(11.6 * FT, 25.2 * FT)],
      to: { kind: "part", partId: "eg-2", connectorId: "neck" },
    },
    {
      type: "route_run",
      idPrefix: "ea-disch",
      levelId: "L2",
      domain: "duct",
      size: { shape: "round", diameter: 8 * IN },
      elevationMm: Math.round(13.5 * FT),
      system: EA_SYS,
      from: { kind: "part", partId: "ef-1", connectorId: "discharge" },
      points: [],
      to: { kind: "part", partId: "gv-1", connectorId: "throat" },
    },
  ]);

  // Connect ALL 4 supply diffusers + BOTH return grilles with REAL kernel `connect_into` takeoff taps + curved flex ducts!
  const airPlan = previewAirConnect(m, ["sd-1", "sd-2", "sd-3", "sd-4", "rg-1", "rg-2"], "hvac-flex");
  if ("refused" in airPlan) {
    throw new Error(`showcase flex connect refused: ${airPlan.refused}`);
  }
  if (airPlan.joinable < 6) {
    throw new Error(`showcase flex connect incomplete (${airPlan.joinable}/6): ${airPlan.lines.filter((l) => !l.ok).map((l) => `${l.elementId}: ${l.text}`).join(" | ")}`);
  }
  m = runCmds(m, airPlan.plan.commands);

  // =========================================================================
  // 5. PLUMBING — Exterior Water Meter MTR-1 → RPZ-1 → WH-1 + ET-1 → Stacked L1/L2 Wet Wall
  //               + Sanitary Building Sewer Lateral w/ Cleanout to Exterior Manhole MH-1
  //               + 3" Vent Through Roof (VTR-1)
  //   (Placed BEFORE Electrical circuits so WH-1 exists when circuited to HP-1!)
  // =========================================================================
  const SAN_SYS = { id: "sys-san", kind: "sanitary" as const, name: "Sanitary" };
  const VENT_SYS = { id: "sys-vent", kind: "vent" as const, name: "Vent" };
  const DCW_SYS = { id: "sys-dcw", kind: "domestic_cold_water" as const, name: "Domestic Cold Water" };
  const DHW_SYS = { id: "sys-dhw", kind: "domestic_hot_water" as const, name: "Domestic Hot Water" };

  const Y_SAN = Y_WET - 1.0 * FT; // 4" under-slab sanitary trunk 12" south of wet wall -> clean horizontal plan separation from vent chase!
  const Y_VENT = Y_WET - 2 * IN; // 2" vent headers inside 8" wet chase (10" north of SAN, 6" south of lavatory face!)
  const Y_WATER = 14.0 * FT; // Street domestic water service separated 6'-6" horizontally from sanitary sewer/manhole (IPC 603.2 >= 5'-0"!) & clear of E-W section cut!
  m = runCmds(m, [
    // Exterior Site Utilities + MEP Room Water Service Entry (buried below 8" slab at -350 mm, ZERO water/sewer clash!)
    { type: "place_part", partId: "mtr-1", typeId: waterMeter.id, levelId: "L1", position: pt(-6.0 * FT, Y_WATER), offsetMm: -350, mark: "MTR-1", values: { room: "Site West" } },
    { type: "place_part", partId: "rpz-1", typeId: rpz.id, levelId: "L1", position: pt(1.6 * FT, Y_WATER), offsetMm: Math.round(3.0 * FT), mark: "RPZ-1", values: { room: "MEP / Electrical 101" } },
    { type: "place_part", partId: "wh-1", typeId: SHOWCASE_WATER_HEATER.id, levelId: "L1", position: pt(13.5 * FT, 18.0 * FT), offsetMm: 0, mark: "WH-1", values: { room: "MEP / Electrical 101", circuit: "HP-1-2,4,6", "electrical.disconnect_required": false, "electrical.local_disconnect": "not_required", "electrical.disconnect_note": "NEC 422.31(B) — lockable breaker in HP-1 within MEP Room 101" } },
    { type: "place_part", partId: "et-1", typeId: expTank.id, levelId: "L1", position: pt(15.6 * FT, 18.8 * FT), offsetMm: Math.round(4.5 * FT), mark: "ET-1", values: { room: "MEP / Electrical 101" } },
    { type: "place_part", partId: "mh-1", typeId: manhole.id, levelId: "L1", position: pt(-10.0 * FT, Y_SAN), offsetMm: -545, rotationDeg: 180, mark: "MH-1", values: { room: "Public Sewer" } },
    // Exterior Floor Cleanout at grade (z = 0) with parametric 21" riser neck extending straight down into the sloped 4" sanitary lateral!
    { type: "place_part", partId: "fco-1", typeId: floorCo.id, levelId: "L1", position: pt(-3.0 * FT, Y_SAN), offsetMm: 0, mark: "FCO-1", values: { room: "Exterior West", riser_height: 530 } },
    { type: "place_part", partId: "vtr-1", typeId: vtr.id, levelId: "ROOF", position: pt(9.5 * FT, Y_VENT), offsetMm: Math.round(3.5 * FT), mark: "VTR-1", values: { room: "Upper Roof" } },

    // Level 1 Restroom 102 commercial fixtures (aligned with vanity-l1 cutouts at 11.0' & 14.6')
    { type: "place_part", partId: "wc-101", typeId: SHOWCASE_WC_COMMERCIAL.id, levelId: "L1", position: pt(4.0 * FT, Y_WET_NORTH_FACE), rotationDeg: 0, mark: "WC-1", values: { room: "Restroom 102", accessible: true } },
    { type: "place_part", partId: "wc-102", typeId: SHOWCASE_WC_COMMERCIAL.id, levelId: "L1", position: pt(7.5 * FT, Y_WET_NORTH_FACE), rotationDeg: 0, mark: "WC-2", values: { room: "Restroom 102", accessible: false } },
    { type: "place_part", partId: "lav-101", typeId: SHOWCASE_LAV_UNDERMOUNT.id, levelId: "L1", position: pt(11.0 * FT, Y_WET_NORTH_FACE), rotationDeg: 0, mark: "L-1", values: { room: "Restroom 102" } },
    { type: "place_part", partId: "lav-102", typeId: SHOWCASE_LAV_UNDERMOUNT.id, levelId: "L1", position: pt(14.6 * FT, Y_WET_NORTH_FACE), rotationDeg: 0, mark: "L-2", values: { room: "Restroom 102" } },

    // Break Room 103 Elkay LR2522 stainless sink (aligned millimeter-for-millimeter into kitchen-l1 cutout!)
    { type: "place_part", partId: "ks-101", typeId: SHOWCASE_SINK_KITCHENETTE.id, levelId: "L1", position: pt(X_CORE_EAST_FACE, 15.0 * FT), rotationDeg: 270, mark: "KS-1", values: { room: "Reception & Break 103" } },

    // Level 2 Restroom 202 stacked directly above L1 (aligned with vanity-l2 cutouts!)
    { type: "place_part", partId: "wc-201", typeId: SHOWCASE_WC_COMMERCIAL.id, levelId: "L2", position: pt(4.0 * FT, Y_WET_NORTH_FACE), rotationDeg: 0, mark: "WC-3", values: { room: "Restroom 202", accessible: true } },
    { type: "place_part", partId: "wc-202", typeId: SHOWCASE_WC_COMMERCIAL.id, levelId: "L2", position: pt(7.5 * FT, Y_WET_NORTH_FACE), rotationDeg: 0, mark: "WC-4", values: { room: "Restroom 202", accessible: false } },
    { type: "place_part", partId: "lav-201", typeId: SHOWCASE_LAV_UNDERMOUNT.id, levelId: "L2", position: pt(11.0 * FT, Y_WET_NORTH_FACE), rotationDeg: 0, mark: "L-3", values: { room: "Restroom 202" } },
    { type: "place_part", partId: "lav-202", typeId: SHOWCASE_LAV_UNDERMOUNT.id, levelId: "L2", position: pt(14.6 * FT, Y_WET_NORTH_FACE), rotationDeg: 0, mark: "L-4", values: { room: "Restroom 202" } },

    // ---- DOMESTIC COLD WATER (Buried Under-Slab Street Main at -350 mm → MTR-1 → Slab Sleeve Riser → RPZ-1 → Straight L1 & L2 Wet Chase Headers!) ----
    {
      type: "route_run",
      idPrefix: "dcw-street",
      levelId: "L1",
      domain: "pipe",
      size: copper(2),
      elevationMm: -350,
      system: DCW_SYS,
      points: [pt(-10.0 * FT, Y_WATER)],
      to: { kind: "part", partId: "mtr-1", connectorId: "in" },
    },
    {
      type: "route_run",
      idPrefix: "dcw-svc",
      levelId: "L1",
      domain: "pipe",
      size: copper(2),
      system: DCW_SYS,
      from: { kind: "part", partId: "mtr-1", connectorId: "out" },
      points: [
        { x: Math.round(0.1 * FT), y: Math.round(Y_WATER), elevationMm: -350 },
        { x: Math.round(0.1 * FT), y: Math.round(Y_WATER), elevationMm: Math.round(3.0 * FT) },
      ],
      to: { kind: "part", partId: "rpz-1", connectorId: "in" },
    },
    {
      type: "route_run",
      idPrefix: "dcw-main",
      levelId: "L1",
      domain: "pipe",
      size: copper(1.25),
      system: DCW_SYS,
      from: { kind: "part", partId: "rpz-1", connectorId: "out" },
      points: [
        { x: Math.round(3.1 * FT), y: Math.round(Y_WATER), elevationMm: Math.round(3.0 * FT) },
        { x: Math.round(3.1 * FT), y: Math.round(Y_WATER), elevationMm: 520 },
        { x: Math.round(3.1 * FT), y: Math.round(20.6 * FT), elevationMm: 520 },
        { x: Math.round(17.5 * FT), y: Math.round(20.6 * FT), elevationMm: 520 },
        { x: Math.round(17.5 * FT), y: Math.round(15.0 * FT) - 120, elevationMm: 520 },
      ],
      to: { kind: "part", partId: "ks-101", connectorId: "cw" },
    },
  ]);

  const dcwL1Header = () => findSeg(m, "dcw-main", (s) => Math.abs(s.start.z - 520) < 20 && Math.abs(s.end.x - s.start.x) > 500 && s.start.x <= 4 * FT && s.end.x >= 15 * FT);
  m = runCmds(m, [
    {
      type: "route_run",
      idPrefix: "dcw-wc1",
      levelId: "L1",
      domain: "pipe",
      size: copper(1),
      elevationMm: 520,
      system: DCW_SYS,
      from: { kind: "run_branch", segmentId: dcwL1Header() },
      points: [{ x: Math.round(4.0 * FT) - 120, y: Math.round(20.6 * FT), elevationMm: 520 }],
      to: { kind: "part", partId: "wc-101", connectorId: "cw" },
    },
    {
      type: "route_run",
      idPrefix: "dcw-wc2",
      levelId: "L1",
      domain: "pipe",
      size: copper(1),
      elevationMm: 520,
      system: DCW_SYS,
      from: { kind: "run_branch", segmentId: dcwL1Header() },
      points: [{ x: Math.round(7.5 * FT) - 120, y: Math.round(20.6 * FT), elevationMm: 520 }],
      to: { kind: "part", partId: "wc-102", connectorId: "cw" },
    },
    {
      type: "route_run",
      idPrefix: "dcw-lav1",
      levelId: "L1",
      domain: "pipe",
      size: copper(0.5),
      elevationMm: 520,
      system: DCW_SYS,
      from: { kind: "run_branch", segmentId: dcwL1Header() },
      points: [{ x: Math.round(11.0 * FT) + 100, y: Math.round(20.6 * FT), elevationMm: 520 }],
      to: { kind: "part", partId: "lav-101", connectorId: "cw" },
    },
    {
      type: "route_run",
      idPrefix: "dcw-lav2",
      levelId: "L1",
      domain: "pipe",
      size: copper(0.5),
      elevationMm: 520,
      system: DCW_SYS,
      from: { kind: "run_branch", segmentId: dcwL1Header() },
      points: [{ x: Math.round(14.6 * FT) + 100, y: Math.round(20.6 * FT), elevationMm: 520 }],
      to: { kind: "part", partId: "lav-102", connectorId: "cw" },
    },
    {
      type: "route_run",
      idPrefix: "dcw-wh",
      levelId: "L1",
      domain: "pipe",
      size: copper(1.25),
      elevationMm: 520,
      system: DCW_SYS,
      from: { kind: "run_branch", segmentId: dcwL1Header() },
      points: [
        { x: Math.round(13.5 * FT) - 102, y: Math.round(20.6 * FT), elevationMm: 520 },
        { x: Math.round(13.5 * FT) - 102, y: Math.round(19.6 * FT), elevationMm: 520 },
        { x: Math.round(13.5 * FT) - 102, y: Math.round(19.6 * FT), elevationMm: Math.round(6.0 * FT) },
        { x: Math.round(13.5 * FT) - 102, y: Math.round(18.0 * FT), elevationMm: Math.round(6.0 * FT) },
      ],
      to: { kind: "part", partId: "wh-1", connectorId: "cw" },
    },
    {
      type: "route_run",
      idPrefix: "dcw-riser",
      levelId: "L1",
      domain: "pipe",
      size: copper(1),
      elevationMm: 520,
      system: DCW_SYS,
      from: { kind: "run_branch", segmentId: dcwL1Header() },
      points: [
        { x: Math.round(5.6 * FT), y: Math.round(20.6 * FT), elevationMm: 520 },
        { x: Math.round(5.6 * FT), y: Math.round(19.6 * FT), elevationMm: 520 },
        { x: Math.round(5.6 * FT), y: Math.round(19.6 * FT), elevationMm: H1 + 520 },
        { x: Math.round(5.6 * FT), y: Math.round(20.6 * FT), elevationMm: H1 + 520 },
        { x: Math.round(14.6 * FT) + 100, y: Math.round(20.6 * FT), elevationMm: H1 + 520 },
      ],
      to: { kind: "part", partId: "lav-202", connectorId: "cw" },
    },
  ]);

  const dcwL2NS = findSeg(m, "dcw-riser", (s) => Math.abs(s.start.z - (H1 + 520)) < 20 && Math.abs(s.end.z - (H1 + 520)) < 20 && Math.abs(s.end.y - s.start.y) > 200);
  const dcwL2EW = findSeg(m, "dcw-riser", (s) => Math.abs(s.start.z - (H1 + 520)) < 20 && Math.abs(s.end.x - s.start.x) > 500);
  m = runCmds(m, [
    {
      type: "route_run",
      idPrefix: "dcw-wc3",
      levelId: "L1",
      domain: "pipe",
      size: copper(1),
      elevationMm: H1 + 520,
      system: DCW_SYS,
      from: { kind: "run_branch", segmentId: dcwL2NS },
      points: [
        { x: Math.round(5.6 * FT), y: Math.round(20.1 * FT), elevationMm: H1 + 520 },
        { x: Math.round(4.0 * FT) - 120, y: Math.round(20.1 * FT), elevationMm: H1 + 520 },
      ],
      to: { kind: "part", partId: "wc-201", connectorId: "cw" },
    },
    {
      type: "route_run",
      idPrefix: "dcw-wc4",
      levelId: "L1",
      domain: "pipe",
      size: copper(1),
      elevationMm: H1 + 520,
      system: DCW_SYS,
      from: { kind: "run_branch", segmentId: dcwL2EW },
      points: [{ x: Math.round(7.5 * FT) - 120, y: Math.round(20.6 * FT), elevationMm: H1 + 520 }],
      to: { kind: "part", partId: "wc-202", connectorId: "cw" },
    },
    {
      type: "route_run",
      idPrefix: "dcw-lav3",
      levelId: "L1",
      domain: "pipe",
      size: copper(0.5),
      elevationMm: H1 + 520,
      system: DCW_SYS,
      from: { kind: "run_branch", segmentId: dcwL2EW },
      points: [{ x: Math.round(11.0 * FT) + 100, y: Math.round(20.6 * FT), elevationMm: H1 + 520 }],
      to: { kind: "part", partId: "lav-201", connectorId: "cw" },
    },

    // ---- DOMESTIC HOT WATER (WH-1 → Straight L1 & L2 Wet Chase Headers at 700 mm, staggered 7" above DCW 520 mm -> ZERO CW/HW clash!) ----
    {
      type: "route_run",
      idPrefix: "dhw-main",
      levelId: "L1",
      domain: "pipe",
      size: copper(0.75),
      elevationMm: Math.round(6.0 * FT),
      system: DHW_SYS,
      from: { kind: "part", partId: "wh-1", connectorId: "hw" },
      points: [
        { x: Math.round(13.5 * FT) + 102, y: Math.round(20.1 * FT), elevationMm: Math.round(6.0 * FT) },
        { x: Math.round(13.5 * FT) + 102, y: Math.round(20.1 * FT), elevationMm: 700 },
        { x: Math.round(16.6 * FT), y: Math.round(20.1 * FT), elevationMm: 700 },
        { x: Math.round(16.6 * FT), y: Math.round(15.0 * FT) + 120, elevationMm: 700 },
        { x: Math.round(17.8 * FT), y: Math.round(15.0 * FT) + 120, elevationMm: 700 },
        { x: Math.round(17.8 * FT), y: Math.round(15.0 * FT) + 120, elevationMm: 520 },
      ],
      to: { kind: "part", partId: "ks-101", connectorId: "hw" },
    },
  ]);

  const dhwL1EW = findSeg(m, "dhw-main", (s) => Math.abs(s.start.z - 700) < 20 && Math.abs(s.end.x - s.start.x) > 500);
  const dhwL1NS = findSeg(m, "dhw-main", (s) => Math.abs(s.start.z - Math.round(6.0 * FT)) < 20 && Math.abs(s.end.y - s.start.y) > 200);
  m = runCmds(m, [
    {
      type: "route_run",
      idPrefix: "dhw-l1-lav1",
      levelId: "L1",
      domain: "pipe",
      size: copper(0.5),
      elevationMm: Math.round(6.0 * FT),
      system: DHW_SYS,
      from: { kind: "run_branch", segmentId: dhwL1NS },
      points: [
        { x: Math.round(13.5 * FT) + 102, y: Math.round(19.4 * FT), elevationMm: Math.round(6.0 * FT) },
        { x: Math.round(11.0 * FT) - 100, y: Math.round(19.4 * FT), elevationMm: Math.round(6.0 * FT) },
        { x: Math.round(11.0 * FT) - 100, y: Math.round(19.4 * FT), elevationMm: 520 },
      ],
      to: { kind: "part", partId: "lav-101", connectorId: "hw" },
    },
    {
      type: "route_run",
      idPrefix: "dhw-lav2",
      levelId: "L1",
      domain: "pipe",
      size: copper(0.5),
      elevationMm: 700,
      system: DHW_SYS,
      from: { kind: "run_branch", segmentId: dhwL1EW },
      points: [
        { x: Math.round(14.6 * FT) - 100, y: Math.round(20.1 * FT), elevationMm: 700 },
        { x: Math.round(14.6 * FT) - 100, y: Math.round(20.8 * FT), elevationMm: 700 },
        { x: Math.round(14.6 * FT) - 100, y: Math.round(20.8 * FT), elevationMm: 520 },
      ],
      to: { kind: "part", partId: "lav-102", connectorId: "hw" },
    },
    {
      type: "route_run",
      idPrefix: "dhw-riser",
      levelId: "L1",
      domain: "pipe",
      size: copper(0.75),
      elevationMm: 700,
      system: DHW_SYS,
      from: { kind: "run_branch", segmentId: dhwL1EW },
      points: [
        { x: Math.round(15.6 * FT), y: Math.round(20.1 * FT), elevationMm: 700 },
        { x: Math.round(15.6 * FT), y: Math.round(19.3 * FT), elevationMm: 700 },
        { x: Math.round(15.6 * FT), y: Math.round(19.3 * FT), elevationMm: H1 + 700 },
        { x: Math.round(15.6 * FT), y: Math.round(20.1 * FT), elevationMm: H1 + 700 },
        { x: Math.round(11.0 * FT) - 100, y: Math.round(20.1 * FT), elevationMm: H1 + 700 },
        { x: Math.round(11.0 * FT) - 100, y: Math.round(20.8 * FT), elevationMm: H1 + 700 },
        { x: Math.round(11.0 * FT) - 100, y: Math.round(20.8 * FT), elevationMm: H1 + 520 },
      ],
      to: { kind: "part", partId: "lav-201", connectorId: "hw" },
    },
  ]);

  const dhwL2EW = findSeg(m, "dhw-riser", (s) => Math.abs(s.start.z - (H1 + 700)) < 20 && Math.abs(s.end.x - s.start.x) > 500);
  m = runCmds(m, [
    {
      type: "route_run",
      idPrefix: "dhw-lav4",
      levelId: "L1",
      domain: "pipe",
      size: copper(0.5),
      elevationMm: H1 + 700,
      system: DHW_SYS,
      from: { kind: "run_branch", segmentId: dhwL2EW },
      points: [
        { x: Math.round(14.6 * FT) - 100, y: Math.round(20.1 * FT), elevationMm: H1 + 700 },
        { x: Math.round(14.6 * FT) - 100, y: Math.round(20.8 * FT), elevationMm: H1 + 700 },
        { x: Math.round(14.6 * FT) - 100, y: Math.round(20.8 * FT), elevationMm: H1 + 520 },
      ],
      to: { kind: "part", partId: "lav-202", connectorId: "hw" },
    },

    // ---- SANITARY DWV (4" Sloped Building Drain + Exterior Sewer Lateral to MH-1 + 3" L2 Stack + Fixture Branches) ----
    {
      type: "route_run",
      idPrefix: "san-main",
      levelId: "L1",
      domain: "pipe",
      size: pvc(4),
      slopeInPerFt: 0.125,
      system: SAN_SYS,
      points: [pt(19.5 * FT, Y_SAN)],
      to: { kind: "part", partId: "mh-1", connectorId: "in" },
    },
    { type: "place_run_accessory", accessoryId: "co-head", segmentId: "san-main-s1", atMm: Math.round(0.7 * FT), family: "dwv.cleanout_wye" },
    { type: "place_run_accessory", accessoryId: "co-ext", segmentId: "san-main-s1", atMm: Math.round(22.5 * FT), family: "dwv.cleanout_wye" },
  ]);

  const sanZ = (xMm: number) => Math.round(-457 - (19.5 * FT - xMm) / 96);
  const sanSeg = () => findSeg(m, "san-main", (s) => Math.abs(s.end.x - s.start.x) > 500);
  m = runCmds(m, [
    {
      type: "route_run",
      idPrefix: "san-ks1",
      levelId: "L1",
      domain: "pipe",
      size: pvc(2),
      elevationMm: 450,
      system: SAN_SYS,
      from: { kind: "part", partId: "ks-101", connectorId: "w" },
      points: [
        { x: Math.round(17.7 * FT), y: Math.round(15.0 * FT), elevationMm: 450 },
        { x: Math.round(17.7 * FT), y: Math.round(15.0 * FT), elevationMm: sanZ(17.7 * FT) },
        { x: Math.round(17.7 * FT), y: Math.round(Y_SAN), elevationMm: sanZ(17.7 * FT) },
      ],
      to: { kind: "run_branch", segmentId: sanSeg() },
    },
    {
      type: "route_run",
      idPrefix: "san-wc1",
      levelId: "L1",
      domain: "pipe",
      size: pvc(3),
      elevationMm: sanZ(4.0 * FT),
      system: SAN_SYS,
      from: { kind: "part", partId: "wc-101", connectorId: "w" },
      points: [
        { x: Math.round(4.0 * FT), y: Math.round(Y_WET_NORTH_FACE + 305), elevationMm: sanZ(4.0 * FT) },
        { x: Math.round(4.0 * FT), y: Math.round(Y_SAN), elevationMm: sanZ(4.0 * FT) },
      ],
      to: { kind: "run_branch", segmentId: sanSeg() },
    },
    {
      type: "route_run",
      idPrefix: "san-wc2",
      levelId: "L1",
      domain: "pipe",
      size: pvc(3),
      elevationMm: sanZ(7.5 * FT),
      system: SAN_SYS,
      from: { kind: "part", partId: "wc-102", connectorId: "w" },
      points: [
        { x: Math.round(7.5 * FT), y: Math.round(Y_WET_NORTH_FACE + 305), elevationMm: sanZ(7.5 * FT) },
        { x: Math.round(7.5 * FT), y: Math.round(Y_SAN), elevationMm: sanZ(7.5 * FT) },
      ],
      to: { kind: "run_branch", segmentId: sanSeg() },
    },
    {
      type: "route_run",
      idPrefix: "san-lav1",
      levelId: "L1",
      domain: "pipe",
      size: pvc(2),
      elevationMm: 480,
      system: SAN_SYS,
      from: { kind: "part", partId: "lav-101", connectorId: "w" },
      points: [
        { x: Math.round(11.0 * FT), y: Math.round(Y_WET_NORTH_FACE + 80), elevationMm: 480 },
        { x: Math.round(11.0 * FT), y: Math.round(Y_WET_NORTH_FACE + 80), elevationMm: sanZ(11.0 * FT) },
        { x: Math.round(11.0 * FT), y: Math.round(Y_SAN), elevationMm: sanZ(11.0 * FT) },
      ],
      to: { kind: "run_branch", segmentId: sanSeg() },
    },
    {
      type: "route_run",
      idPrefix: "san-lav2",
      levelId: "L1",
      domain: "pipe",
      size: pvc(2),
      elevationMm: 480,
      system: SAN_SYS,
      from: { kind: "part", partId: "lav-102", connectorId: "w" },
      points: [
        { x: Math.round(14.6 * FT), y: Math.round(Y_WET_NORTH_FACE + 80), elevationMm: 480 },
        { x: Math.round(14.6 * FT), y: Math.round(Y_WET_NORTH_FACE + 80), elevationMm: sanZ(14.6 * FT) },
        { x: Math.round(14.6 * FT), y: Math.round(Y_SAN), elevationMm: sanZ(14.6 * FT) },
      ],
      to: { kind: "run_branch", segmentId: sanSeg() },
    },
    {
      type: "route_run",
      idPrefix: "san-stack",
      levelId: "L1",
      domain: "pipe",
      size: pvc(3),
      elevationMm: sanZ(2.2 * FT),
      system: SAN_SYS,
      from: { kind: "run_branch", segmentId: sanSeg() },
      points: [
        { x: Math.round(2.2 * FT), y: Math.round(Y_SAN), elevationMm: sanZ(2.2 * FT) },
        { x: Math.round(2.2 * FT), y: Math.round(Y_SAN - 1.6 * FT), elevationMm: sanZ(2.2 * FT) },
        { x: Math.round(2.2 * FT), y: Math.round(Y_SAN - 1.6 * FT), elevationMm: H1 - 350 },
        { x: Math.round(2.2 * FT), y: Math.round(Y_SAN), elevationMm: H1 - 350 },
        { x: Math.round(16.0 * FT), y: Math.round(Y_SAN), elevationMm: H1 - 350 },
      ],
      capEnd: true,
    },
  ]);

  const sanL2Header = () => findSeg(m, "san-stack", (s) => s.start.z > H1 - 600 && Math.abs(s.end.x - s.start.x) > 500);
  const sanL2Z = (xMm: number) => {
    const el = m.elements[sanL2Header()];
    if (!el || el.kind !== "run_segment") return H1 - 350;
    const t = (xMm - el.start.x) / (el.end.x - el.start.x);
    return Math.round(el.start.z + t * (el.end.z - el.start.z));
  };
  m = runCmds(m, [
    {
      type: "route_run",
      idPrefix: "san-wc3",
      levelId: "L1",
      domain: "pipe",
      size: pvc(3),
      elevationMm: sanL2Z(4.0 * FT),
      system: SAN_SYS,
      from: { kind: "part", partId: "wc-201", connectorId: "w" },
      points: [
        { x: Math.round(4.0 * FT), y: Math.round(Y_WET_NORTH_FACE + 305), elevationMm: sanL2Z(4.0 * FT) },
        { x: Math.round(4.0 * FT), y: Math.round(Y_SAN), elevationMm: sanL2Z(4.0 * FT) },
      ],
      to: { kind: "run_branch", segmentId: sanL2Header() },
    },
    {
      type: "route_run",
      idPrefix: "san-wc4",
      levelId: "L1",
      domain: "pipe",
      size: pvc(3),
      elevationMm: sanL2Z(7.5 * FT),
      system: SAN_SYS,
      from: { kind: "part", partId: "wc-202", connectorId: "w" },
      points: [
        { x: Math.round(7.5 * FT), y: Math.round(Y_WET_NORTH_FACE + 305), elevationMm: sanL2Z(7.5 * FT) },
        { x: Math.round(7.5 * FT), y: Math.round(Y_SAN), elevationMm: sanL2Z(7.5 * FT) },
      ],
      to: { kind: "run_branch", segmentId: sanL2Header() },
    },
    {
      type: "route_run",
      idPrefix: "san-lav3",
      levelId: "L1",
      domain: "pipe",
      size: pvc(2),
      elevationMm: H1 + 480,
      system: SAN_SYS,
      from: { kind: "part", partId: "lav-201", connectorId: "w" },
      points: [
        { x: Math.round(11.0 * FT), y: Math.round(Y_WET_NORTH_FACE + 80), elevationMm: H1 + 480 },
        { x: Math.round(11.0 * FT), y: Math.round(Y_WET_NORTH_FACE + 80), elevationMm: sanL2Z(11.0 * FT) },
        { x: Math.round(11.0 * FT), y: Math.round(Y_SAN), elevationMm: sanL2Z(11.0 * FT) },
      ],
      to: { kind: "run_branch", segmentId: sanL2Header() },
    },
    {
      type: "route_run",
      idPrefix: "san-lav4",
      levelId: "L1",
      domain: "pipe",
      size: pvc(2),
      elevationMm: H1 + 480,
      system: SAN_SYS,
      from: { kind: "part", partId: "lav-202", connectorId: "w" },
      points: [
        { x: Math.round(14.6 * FT), y: Math.round(Y_WET_NORTH_FACE + 80), elevationMm: H1 + 480 },
        { x: Math.round(14.6 * FT), y: Math.round(Y_WET_NORTH_FACE + 80), elevationMm: sanL2Z(14.6 * FT) },
        { x: Math.round(14.6 * FT), y: Math.round(Y_SAN), elevationMm: sanL2Z(14.6 * FT) },
      ],
      to: { kind: "run_branch", segmentId: sanL2Header() },
    },

    // ---- IPC 912 HORIZONTAL WET VENTING (3" VTR-1 + L1 & L2 2" Horizontal Branch Vents at 5'-0" AFF serving Lavatories L-1..L-4 + KS-1; WCs wet-vented via lavatory drains per IPC 912!) ----
    {
      type: "route_run",
      idPrefix: "vent-stack",
      levelId: "L1",
      domain: "pipe",
      size: pvc(3),
      elevationMm: Math.round(4.5 * FT),
      system: VENT_SYS,
      points: [{ x: Math.round(9.5 * FT), y: Math.round(Y_VENT) }],
      to: { kind: "part", partId: "vtr-1", connectorId: "v" },
    },
    // L1 Horizontal Branch Vent (Vent Stack 9.5' → LAV-101, LAV-102, KS-101; cleanly offset north of SAN trunk!)
    {
      type: "route_run",
      idPrefix: "vent-l1-east",
      levelId: "L1",
      domain: "pipe",
      size: pvc(2),
      elevationMm: Math.round(5.0 * FT),
      system: VENT_SYS,
      from: { kind: "run_branch", segmentId: "vent-stack-s1" },
      points: [pt(9.5 * FT, Y_VENT), pt(17.5 * FT, Y_VENT), pt(17.5 * FT, 15.0 * FT)],
      to: { kind: "part", partId: "ks-101", connectorId: "v" },
    },
  ]);

  const ventL1EastSeg = findSeg(m, "vent-l1-east", (s) => Math.abs(s.end.x - s.start.x) > 500);
  const ventUpperSeg = findSeg(m, "vent-stack", (s) => Math.max(s.start.z, s.end.z) > H1 + 6 * FT);
  m = runCmds(m, [
    // L1 lavatory dry vents (2" L-1 wet-venting L1 bathroom-group WCs per IPC 912 + 1-1/2" L-2)
    {
      type: "route_run",
      idPrefix: "vent-lav101",
      levelId: "L1",
      domain: "pipe",
      size: pvc(2),
      elevationMm: Math.round(5.0 * FT),
      system: VENT_SYS,
      from: { kind: "run_branch", segmentId: ventL1EastSeg },
      points: [pt(11.0 * FT, Y_VENT), pt(11.0 * FT, Y_WET_NORTH_FACE)],
      to: { kind: "part", partId: "lav-101", connectorId: "v" },
    },
    {
      type: "route_run",
      idPrefix: "vent-lav102",
      levelId: "L1",
      domain: "pipe",
      size: pvc(1.5),
      elevationMm: Math.round(5.0 * FT),
      system: VENT_SYS,
      from: { kind: "run_branch", segmentId: ventL1EastSeg },
      points: [pt(14.6 * FT, Y_VENT), pt(14.6 * FT, Y_WET_NORTH_FACE)],
      to: { kind: "part", partId: "lav-102", connectorId: "v" },
    },
    // L2 Horizontal Branch Vent at L2 + 5'-0" AFF (serving L-3 & L-4, wet-venting L2 bathroom-group WCs per IPC 912!)
    {
      type: "route_run",
      idPrefix: "vent-l2-east",
      levelId: "L1",
      domain: "pipe",
      size: pvc(2),
      elevationMm: H1 + Math.round(5.0 * FT),
      system: VENT_SYS,
      from: { kind: "run_branch", segmentId: ventUpperSeg },
      points: [pt(9.5 * FT, Y_VENT), pt(14.6 * FT, Y_VENT), pt(14.6 * FT, Y_WET_NORTH_FACE)],
      to: { kind: "part", partId: "lav-202", connectorId: "v" },
    },
  ]);

  const ventL2EastSeg = findSeg(m, "vent-l2-east", (s) => Math.abs(s.end.x - s.start.x) > 500);
  m = runCmds(m, [
    {
      type: "route_run",
      idPrefix: "vent-lav201",
      levelId: "L1",
      domain: "pipe",
      size: pvc(2),
      elevationMm: H1 + Math.round(5.0 * FT),
      system: VENT_SYS,
      from: { kind: "run_branch", segmentId: ventL2EastSeg },
      points: [pt(11.0 * FT, Y_VENT), pt(11.0 * FT, Y_WET_NORTH_FACE)],
      to: { kind: "part", partId: "lav-201", connectorId: "v" },
    },
  ]);

  // =========================================================================
  // 6. ELECTRICAL — MEP Room 101 Distribution + Full Circuiting (RTU-1, WH-1, EF-1, Lighting, Receptacles)
  //                 Zero-clash coordinated lighting + bronze exterior wall sconces!
  // =========================================================================
  m = runCmds(m, [
    // Distribution gear inside MEP / Electrical Room 101 — MDP & HP-1 sit adjacent so their NEC 110.26 working clearances merge cleanly!
    { type: "place_part", partId: "mdp", typeId: swb.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-w", stationMm: Math.round(4.2 * FT), side: -1 }, mark: "MDP", values: { available_fault_current: 42000, aic: 65000 } },
    { type: "place_part", partId: "hp-1", typeId: hpnl.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-w", stationMm: Math.round(7.1 * FT), side: -1 }, mark: "HP-1", values: { aic: 42000 } },
    { type: "place_part", partId: "sd-1e", typeId: discFused.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-core", stationMm: Math.round(6.8 * FT), side: 1 }, mark: "SD-1(E)" },
    { type: "place_part", partId: "sd-2d", typeId: discFused.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-core", stationMm: Math.round(5.0 * FT), side: 1 }, mark: "SD-2(D)" },
    // Local NEMA 3R non-fused disconnect wall-mounted on the East Roof parapet beside RTU-1 (NEC 440.14 within sight of equipment)
    { type: "place_part", partId: "disc-rtu-1", typeId: discNf30.id, levelId: "L2", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l2-para-e", stationMm: Math.round(19.0 * FT), side: 1 }, offsetMm: Math.round(16 * IN), mark: "SD-RTU-1", values: { panel_name: "SD-RTU-1", serves: "RTU-1" } },
    { type: "place_part", partId: "t-1", typeId: xfmr.id, levelId: "L1", position: pt(12.5 * FT, 3.0 * FT), mark: "T-1", values: { impedance_pct: 4.5 } },
    { type: "place_part", partId: "lp-1", typeId: lpnl.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-core", stationMm: Math.round(10.5 * FT), side: 1 }, mark: "LP-1", values: { aic: 22000 } },

    // Wall-face NEC-spaced receptacles (mounted on the room-facing side, clear of MDP/HP-1, windows & lavatory marks!)
    { type: "place_part", partId: "rec-101", typeId: gfci.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-w", stationMm: Math.round(1.5 * FT), side: -1 }, offsetMm: Math.round(18 * IN), mark: "GFCI-M1" },
    { type: "place_part", partId: "rec-102", typeId: gfci.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-wet", stationMm: Math.round(16.6 * FT), side: 1 }, offsetMm: Math.round(44 * IN), mark: "GFCI-R1" },
    { type: "place_part", partId: "rec-103", typeId: gfci.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-core", stationMm: Math.round(12.2 * FT), side: -1 }, offsetMm: Math.round(44 * IN), mark: "GFCI-K1" },
    { type: "place_part", partId: "rec-104", typeId: gfci.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-core", stationMm: Math.round(17.8 * FT), side: -1 }, offsetMm: Math.round(44 * IN), mark: "GFCI-K2" },
    { type: "place_part", partId: "rec-105", typeId: rec.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-core", stationMm: Math.round(3.0 * FT), side: -1 }, offsetMm: Math.round(18 * IN), mark: "R-01" },
    { type: "place_part", partId: "rec-106", typeId: rec.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-studio-div", stationMm: Math.round(5.5 * FT), side: 1 }, offsetMm: Math.round(18 * IN), mark: "R-02" },
    { type: "place_part", partId: "rec-107", typeId: rec.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-studio-div", stationMm: Math.round(17.5 * FT), side: 1 }, offsetMm: Math.round(18 * IN), mark: "R-03" },
    // Stagger Q-01 to station 8.2' on east face so it never collides with R-02 (5.5' on west face)!
    { type: "place_part", partId: "rec-108", typeId: quad.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-studio-div", stationMm: Math.round(8.2 * FT), side: -1 }, offsetMm: Math.round(18 * IN), mark: "Q-01" },
    { type: "place_part", partId: "rec-109", typeId: quad.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-studio-div", stationMm: Math.round(17.5 * FT), side: -1 }, offsetMm: Math.round(18 * IN), mark: "Q-02" },
    { type: "place_part", partId: "rec-110", typeId: rec.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-e-solid", stationMm: Math.round(1.2 * FT), side: 1 }, offsetMm: Math.round(18 * IN), mark: "R-04" },
    // R-05 placed cleanly east of W103 (W103 is centered at station 5.5' w/ 8' width -> 1.5'..9.5', so station 11.2' is completely clear!)
    { type: "place_part", partId: "rec-111", typeId: rec.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-n-east", stationMm: Math.round(11.2 * FT), side: -1 }, offsetMm: Math.round(18 * IN), mark: "R-05" },
    { type: "place_part", partId: "rec-112", typeId: quad.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-print-w", stationMm: Math.round(4.0 * FT), side: -1 }, offsetMm: Math.round(18 * IN), mark: "Q-03" },
    // Level 2 Conference 201 & Mezzanine Loft 203 convenience receptacles
    { type: "place_part", partId: "rec-201", typeId: rec.id, levelId: "L2", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l2-core", stationMm: Math.round(6.0 * FT), side: 1 }, offsetMm: Math.round(18 * IN), mark: "R-201" },
    { type: "place_part", partId: "rec-202", typeId: quad.id, levelId: "L2", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l2-core", stationMm: Math.round(16.0 * FT), side: -1 }, offsetMm: Math.round(18 * IN), mark: "Q-201" },
    { type: "place_part", partId: "rec-203", typeId: gfci.id, levelId: "L2", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l2-wet", stationMm: Math.round(16.4 * FT), side: 1 }, offsetMm: Math.round(44 * IN), mark: "GFCI-R2" },
    // Floor-hosted duplex & quad floor boxes (slab/floor-mounted without requiring a wall host)
    { type: "place_part", partId: "fb-studio-1", typeId: floorRec.id, levelId: "L1", position: pt(42.5 * FT, 9.0 * FT), mark: "FB-1" },
    { type: "place_part", partId: "fb-conf-1", typeId: floorQuad.id, levelId: "L2", position: pt(9.0 * FT, 10.5 * FT), mark: "FB-2" },
    // Special-purpose NEMA 6-20R (240V), Twist-Lock (L6-20R), and Hardwired Equipment Connection symbols (cleanly separated along Print Room wall)
    { type: "place_part", partId: "rec-240v", typeId: nema620.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-print-w", stationMm: Math.round(3.5 * FT), side: -1 }, offsetMm: Math.round(18 * IN), mark: "R-240V" },
    { type: "place_part", partId: "rec-tl", typeId: twistLock.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-print-w", stationMm: Math.round(6.0 * FT), side: -1 }, offsetMm: Math.round(18 * IN), mark: "R-TL" },
    { type: "place_part", partId: "hw-mep-1", typeId: hardwired.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-core", stationMm: Math.round(3.0 * FT), side: 1 }, offsetMm: Math.round(48 * IN), mark: "EC-1" },

    // Lighting Control Devices (0-10V dimmers, 3-way travelers, ceiling occupancy sensor, exterior photocell/timeclock)
    { type: "place_part", partId: "sw-a1", typeId: swD.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-core", stationMm: Math.round(21.5 * FT), side: -1 }, offsetMm: Math.round(44 * IN), mark: "SW-A1", values: { switch_leg: "a", control_type: "0-10v" } },
    { type: "place_part", partId: "sw-b1", typeId: sw3.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-studio-div", stationMm: Math.round(13.5 * FT), side: -1 }, offsetMm: Math.round(44 * IN), mark: "SW-B1", values: { switch_leg: "b", control_type: "0-10v" } },
    { type: "place_part", partId: "sw-b2", typeId: sw3.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-print-w", stationMm: Math.round(2.5 * FT), side: 1 }, offsetMm: Math.round(44 * IN), mark: "SW-B2", values: { switch_leg: "b", control_type: "0-10v" } },
    { type: "place_part", partId: "os-b1", typeId: occ.id, levelId: "L1", position: pt(49.5 * FT, 11.5 * FT), offsetMm: CEILING_Z, mark: "OS-1", values: { switch_leg: "b", control_type: "low_voltage" } },
    { type: "place_part", partId: "sw-c1", typeId: sw1.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-core", stationMm: Math.round(8.2 * FT), side: 1 }, offsetMm: Math.round(44 * IN), mark: "SW-C1", values: { switch_leg: "c", control_type: "line_voltage" } },
    { type: "place_part", partId: "sw-d1", typeId: sw1.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-core", stationMm: Math.round(15.0 * FT), side: 1 }, offsetMm: Math.round(44 * IN), mark: "PC-1", values: { switch_leg: "d", control_type: "low_voltage" } },

    // ZERO-CLASH Coordinated Recessed LED Luminaires (277V from HP-1) — photometrically verified for IES normal & NFPA 101 egress!
    // Zone A — Reception & Break 103 architectural downlight grid (clear of col-l1-1 (26,14), SD-3/4, RG-2!)
    { type: "place_part", partId: "lt-1", typeId: SHOWCASE_DOWNLIGHT_6.id, levelId: "L1", position: pt(20.5 * FT, 3.0 * FT), offsetMm: CEILING_Z, mark: "F1-1", values: { switch_leg: "a", control_type: "0-10v", type_mark: "F1" } },
    { type: "place_part", partId: "lt-2", typeId: SHOWCASE_DOWNLIGHT_6.id, levelId: "L1", position: pt(26.0 * FT, 3.0 * FT), offsetMm: CEILING_Z, mark: "F1-2", values: { switch_leg: "a", control_type: "0-10v", type_mark: "F1" } },
    { type: "place_part", partId: "lt-3", typeId: SHOWCASE_DOWNLIGHT_6.id, levelId: "L1", position: pt(31.5 * FT, 3.0 * FT), offsetMm: CEILING_Z, mark: "F1-3", values: { switch_leg: "a", control_type: "0-10v", emergency: true, emergency_mode: "switched", type_mark: "F1E" } },
    { type: "place_part", partId: "lt-16", typeId: SHOWCASE_DOWNLIGHT_6.id, levelId: "L1", position: pt(20.5 * FT, 10.5 * FT), offsetMm: CEILING_Z, mark: "F1-4", values: { switch_leg: "a", control_type: "0-10v", emergency: true, emergency_mode: "switched", type_mark: "F1E" } },
    { type: "place_part", partId: "lt-17", typeId: SHOWCASE_DOWNLIGHT_6.id, levelId: "L1", position: pt(32.0 * FT, 10.5 * FT), offsetMm: CEILING_Z, mark: "F1-5", values: { switch_leg: "a", control_type: "0-10v", type_mark: "F1" } },
    { type: "place_part", partId: "lt-13", typeId: SHOWCASE_DOWNLIGHT_6.id, levelId: "L1", position: pt(20.5 * FT, 17.5 * FT), offsetMm: CEILING_Z, mark: "F1-6", values: { switch_leg: "a", control_type: "0-10v", type_mark: "F1" } },
    { type: "place_part", partId: "lt-14", typeId: SHOWCASE_DOWNLIGHT_6.id, levelId: "L1", position: pt(26.0 * FT, 17.5 * FT), offsetMm: CEILING_Z, mark: "F1-7", values: { switch_leg: "a", control_type: "0-10v", emergency: true, emergency_mode: "switched", type_mark: "F1E" } },
    { type: "place_part", partId: "lt-15", typeId: SHOWCASE_DOWNLIGHT_6.id, levelId: "L1", position: pt(23.5 * FT, 22.5 * FT), offsetMm: CEILING_Z, mark: "F1-8", values: { switch_leg: "a", control_type: "0-10v", type_mark: "F1" } },
    { type: "place_part", partId: "lt-18", typeId: SHOWCASE_DOWNLIGHT_6.id, levelId: "L1", position: pt(20.5 * FT, 24.5 * FT), offsetMm: CEILING_Z, mark: "F1-9", values: { switch_leg: "a", control_type: "0-10v", emergency: true, emergency_mode: "unswitched", type_mark: "F1E" } },
    { type: "place_part", partId: "lt-19", typeId: SHOWCASE_DOWNLIGHT_6.id, levelId: "L1", position: pt(26.5 * FT, 24.5 * FT), offsetMm: CEILING_Z, mark: "F1-10", values: { switch_leg: "a", control_type: "0-10v", emergency: true, emergency_mode: "unswitched", type_mark: "F1E" } },
    { type: "place_part", partId: "lt-20", typeId: SHOWCASE_DOWNLIGHT_6.id, levelId: "L1", position: pt(34.5 * FT, 23.5 * FT), offsetMm: Math.round(10.8 * FT), mark: "F1-11", values: { switch_leg: "a", control_type: "0-10v", emergency: true, emergency_mode: "unswitched", type_mark: "F1E" } },
    // Suspended linear task pendants over 8'-6" Oak Kitchenette Counter (FDA/IES 50 fc food-prep) & Quartz Break Island (30+ fc) — clear of Grid 2B column!
    { type: "place_part", partId: "lt-kit-1", typeId: linearPendant.id, levelId: "L1", position: pt(19.4 * FT, 11.7 * FT), offsetMm: Math.round(7.5 * FT), rotationDeg: 90, mark: "F3-5", values: { switch_leg: "a", control_type: "0-10v", type_mark: "F3" } },
    { type: "place_part", partId: "lt-kit-2", typeId: linearPendant.id, levelId: "L1", position: pt(19.4 * FT, 17.3 * FT), offsetMm: Math.round(7.5 * FT), rotationDeg: 90, mark: "F3-6", values: { switch_leg: "a", control_type: "0-10v", type_mark: "F3" } },
    { type: "place_part", partId: "lt-isl-1", typeId: linearPendant.id, levelId: "L1", position: pt(26.5 * FT, 9.5 * FT), offsetMm: Math.round(7.5 * FT), rotationDeg: 0, mark: "F3-7", values: { switch_leg: "a", control_type: "0-10v", type_mark: "F3" } },

    // Zone B — Design Studio 104 2×4 volumetric LED troffers seated DEAD-CENTER in exact 2'×4' ACT cloud tiles (origin 36', 2')!
    { type: "place_part", partId: "lt-4", typeId: SHOWCASE_TROFFER_2X4.id, levelId: "L1", position: pt(38.0 * FT, 5.0 * FT), offsetMm: CEILING_Z, mark: "F2-1", values: { switch_leg: "b", control_type: "0-10v", emergency: true, emergency_mode: "unswitched", type_mark: "F2E" } },
    { type: "place_part", partId: "lt-5", typeId: SHOWCASE_TROFFER_2X4.id, levelId: "L1", position: pt(50.0 * FT, 5.0 * FT), offsetMm: CEILING_Z, mark: "F2-2", values: { switch_leg: "b", control_type: "0-10v", type_mark: "F2" } },
    { type: "place_part", partId: "lt-21", typeId: SHOWCASE_TROFFER_2X4.id, levelId: "L1", position: pt(42.0 * FT, 3.0 * FT), offsetMm: CEILING_Z, mark: "F2-3", values: { switch_leg: "b", control_type: "0-10v", type_mark: "F2" } },
    { type: "place_part", partId: "lt-22", typeId: SHOWCASE_TROFFER_2X4.id, levelId: "L1", position: pt(50.0 * FT, 13.0 * FT), offsetMm: CEILING_Z, mark: "F2-4", values: { switch_leg: "b", control_type: "0-10v", type_mark: "F2" } },
    { type: "place_part", partId: "lt-6", typeId: SHOWCASE_TROFFER_2X4.id, levelId: "L1", position: pt(38.0 * FT, 17.0 * FT), offsetMm: CEILING_Z, mark: "F2-5", values: { switch_leg: "b", control_type: "0-10v", type_mark: "F2" } },
    { type: "place_part", partId: "lt-7", typeId: SHOWCASE_TROFFER_2X4.id, levelId: "L1", position: pt(50.0 * FT, 17.0 * FT), offsetMm: CEILING_Z, mark: "F2-6", values: { switch_leg: "b", control_type: "0-10v", emergency: true, emergency_mode: "switched", type_mark: "F2E" } },
    { type: "place_part", partId: "lt-23", typeId: SHOWCASE_TROFFER_2X4.id, levelId: "L1", position: pt(46.0 * FT, 19.0 * FT), offsetMm: CEILING_Z, mark: "F2-7", values: { switch_leg: "b", control_type: "0-10v", type_mark: "F2" } },
    { type: "place_part", partId: "lt-24", typeId: SHOWCASE_TROFFER_2X4.id, levelId: "L1", position: pt(40.5 * FT, 24.5 * FT), offsetMm: CEILING_Z, mark: "F2-8", values: { switch_leg: "b", control_type: "0-10v", type_mark: "F2" } },
    // Print / Plotter 105 centered troffer (8'-6" ACT ceiling for task illuminance >= 20 fc)
    { type: "place_part", partId: "lt-8", typeId: SHOWCASE_TROFFER_2X4.id, levelId: "L1", position: pt(51.5 * FT, 24.5 * FT), offsetMm: Math.round(8.5 * FT), mark: "F2-9", values: { switch_leg: "b", control_type: "0-10v", type_mark: "F2" } },

    // Zone C — MEP Room 101 evenly spaced working-aisle troffers + Restroom 102 downlights (clear of EG-2 at 11.6, 25.2!)
    { type: "place_part", partId: "lt-9", typeId: SHOWCASE_TROFFER_2X4.id, levelId: "L1", position: pt(9.0 * FT, 4.5 * FT), offsetMm: Math.round(10.5 * FT), mark: "F2-10", values: { switch_leg: "c", control_type: "line_voltage", type_mark: "F2" } },
    { type: "place_part", partId: "lt-10", typeId: SHOWCASE_TROFFER_2X4.id, levelId: "L1", position: pt(9.0 * FT, 11.0 * FT), offsetMm: Math.round(10.5 * FT), mark: "F2-11", values: { switch_leg: "c", control_type: "line_voltage", emergency: true, emergency_mode: "unswitched", type_mark: "F2E" } },
    { type: "place_part", partId: "lt-9b", typeId: SHOWCASE_TROFFER_2X4.id, levelId: "L1", position: pt(9.0 * FT, 17.5 * FT), offsetMm: Math.round(10.5 * FT), mark: "F2-12", values: { switch_leg: "c", control_type: "line_voltage", type_mark: "F2" } },
    { type: "place_part", partId: "lt-11", typeId: SHOWCASE_DOWNLIGHT_6.id, levelId: "L1", position: pt(3.5 * FT, 24.5 * FT), offsetMm: Math.round(9.0 * FT), mark: "F1-12", values: { switch_leg: "c", control_type: "line_voltage", type_mark: "F1" } },
    { type: "place_part", partId: "lt-11b", typeId: SHOWCASE_DOWNLIGHT_6.id, levelId: "L1", position: pt(7.5 * FT, 25.5 * FT), offsetMm: Math.round(9.0 * FT), mark: "F1-13", values: { switch_leg: "c", control_type: "line_voltage", type_mark: "F1" } },
    { type: "place_part", partId: "lt-12b", typeId: SHOWCASE_DOWNLIGHT_6.id, levelId: "L1", position: pt(14.8 * FT, 26.0 * FT), offsetMm: Math.round(9.0 * FT), mark: "F1-14", values: { switch_leg: "c", control_type: "line_voltage", type_mark: "F1" } },
    { type: "place_part", partId: "lt-12", typeId: SHOWCASE_DOWNLIGHT_6.id, levelId: "L1", position: pt(16.6 * FT, 24.5 * FT), offsetMm: Math.round(9.0 * FT), mark: "F1-15", values: { switch_leg: "c", control_type: "line_voltage", type_mark: "F1" } },

    // Level 2 — Conference 201 direct/indirect linear pendants, Restroom 202 downlights, Mezzanine Loft 203 troffers + Exit/EM Combo
    { type: "place_part", partId: "lt-201", typeId: linearPendant.id, levelId: "L2", position: pt(5.5 * FT, 6.0 * FT), offsetMm: Math.round(8.0 * FT), mark: "F3-1", values: { switch_leg: "e", control_type: "0-10v", type_mark: "F3" } },
    { type: "place_part", partId: "lt-202", typeId: linearPendant.id, levelId: "L2", position: pt(12.5 * FT, 6.0 * FT), offsetMm: Math.round(8.0 * FT), mark: "F3-2", values: { switch_leg: "e", control_type: "0-10v", type_mark: "F3" } },
    { type: "place_part", partId: "lt-203", typeId: linearPendant.id, levelId: "L2", position: pt(5.5 * FT, 15.0 * FT), offsetMm: Math.round(8.0 * FT), mark: "F3-3", values: { switch_leg: "e", control_type: "0-10v", type_mark: "F3" } },
    { type: "place_part", partId: "lt-204", typeId: linearPendant.id, levelId: "L2", position: pt(12.5 * FT, 15.0 * FT), offsetMm: Math.round(8.0 * FT), mark: "F3-4", values: { switch_leg: "e", control_type: "0-10v", type_mark: "F3" } },
    { type: "place_part", partId: "lt-205", typeId: SHOWCASE_DOWNLIGHT_6.id, levelId: "L2", position: pt(3.5 * FT, 24.5 * FT), offsetMm: Math.round(9.0 * FT), mark: "F1-16", values: { switch_leg: "e", control_type: "line_voltage", type_mark: "F1" } },
    { type: "place_part", partId: "lt-206", typeId: SHOWCASE_DOWNLIGHT_6.id, levelId: "L2", position: pt(8.0 * FT, 25.5 * FT), offsetMm: Math.round(9.0 * FT), mark: "F1-17", values: { switch_leg: "e", control_type: "line_voltage", type_mark: "F1" } },
    { type: "place_part", partId: "lt-207", typeId: SHOWCASE_DOWNLIGHT_6.id, levelId: "L2", position: pt(14.8 * FT, 26.0 * FT), offsetMm: Math.round(9.0 * FT), mark: "F1-18", values: { switch_leg: "e", control_type: "line_voltage", type_mark: "F1" } },
    { type: "place_part", partId: "lt-208", typeId: SHOWCASE_DOWNLIGHT_6.id, levelId: "L2", position: pt(16.6 * FT, 24.5 * FT), offsetMm: Math.round(9.0 * FT), mark: "F1-19", values: { switch_leg: "e", control_type: "line_voltage", type_mark: "F1" } },
    { type: "place_part", partId: "lt-209", typeId: SHOWCASE_TROFFER_2X4.id, levelId: "L2", position: pt(22.0 * FT, 5.5 * FT), offsetMm: Math.round(9.5 * FT), mark: "F2-13", values: { switch_leg: "e", control_type: "0-10v", emergency: true, emergency_mode: "switched", type_mark: "F2E" } },
    { type: "place_part", partId: "lt-210", typeId: SHOWCASE_TROFFER_2X4.id, levelId: "L2", position: pt(30.0 * FT, 5.5 * FT), offsetMm: Math.round(9.5 * FT), mark: "F2-14", values: { switch_leg: "e", control_type: "0-10v", type_mark: "F2" } },
    { type: "place_part", partId: "lt-211", typeId: SHOWCASE_TROFFER_2X4.id, levelId: "L2", position: pt(22.0 * FT, 14.0 * FT), offsetMm: Math.round(9.5 * FT), mark: "F2-15", values: { switch_leg: "e", control_type: "0-10v", type_mark: "F2" } },
    { type: "place_part", partId: "lt-212", typeId: SHOWCASE_TROFFER_2X4.id, levelId: "L2", position: pt(30.0 * FT, 14.0 * FT), offsetMm: Math.round(9.5 * FT), mark: "F2-16", values: { switch_leg: "e", control_type: "0-10v", emergency: true, emergency_mode: "unswitched", type_mark: "F2E" } },
    { type: "place_part", partId: "lt-213", typeId: SHOWCASE_TROFFER_2X4.id, levelId: "L2", position: pt(22.0 * FT, 23.0 * FT), offsetMm: Math.round(9.5 * FT), mark: "F2-17", values: { switch_leg: "e", control_type: "0-10v", emergency: true, emergency_mode: "unswitched", type_mark: "F2E" } },
    { type: "place_part", partId: "lt-214", typeId: SHOWCASE_TROFFER_2X4.id, levelId: "L2", position: pt(30.0 * FT, 23.0 * FT), offsetMm: Math.round(9.5 * FT), mark: "F2-18", values: { switch_leg: "e", control_type: "0-10v", type_mark: "F2" } },
    // Dedicated L2 stairwell emergency downlight centered inside the stairwell shaft above the U-stair mid-landing & upper flight (NFPA 101 3D tread compliance!)
    { type: "place_part", partId: "lt-215", typeId: SHOWCASE_DOWNLIGHT_6.id, levelId: "L2", position: pt(30.0 * FT, 22.0 * FT), offsetMm: Math.round(9.5 * FT), mark: "F1-20", values: { switch_leg: "e", control_type: "0-10v", emergency: true, emergency_mode: "unswitched", type_mark: "F1E" } },

    // Emergency Exit / Combo Units above Studio corridor door D104 & L2 Stair Head
    { type: "place_part", partId: "exit-1", typeId: exit.id, levelId: "L1", position: pt(34.5 * FT, 10.5 * FT), offsetMm: Math.round(8.5 * FT), mark: "EX-1", values: { emergency: true, emergency_mode: "unswitched", type_mark: "EX" } },
    { type: "place_part", partId: "exit-2", typeId: exitCombo.id, levelId: "L1", position: pt(26.5 * FT, 26.8 * FT), offsetMm: Math.round(8.5 * FT), mark: "EX-2", values: { emergency: true, emergency_mode: "unswitched", type_mark: "EXC" } },

    // Zone D — Exterior Architectural Dark-Bronze LED Wall Sconces (Lithonia WDGE2, Photocell/Timeclock + Exit Discharge EM!)
    { type: "place_part", partId: "wp-1", typeId: SHOWCASE_EXTERIOR_SCONCE.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-s-west", stationMm: Math.round(6.5 * FT), side: -1 }, offsetMm: Math.round(8.0 * FT), mark: "WP-1", values: { switch_leg: "d", control_type: "low_voltage", emergency: true, emergency_mode: "switched", type_mark: "WP" } },
    { type: "place_part", partId: "wp-2", typeId: SHOWCASE_EXTERIOR_SCONCE.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-n-main", stationMm: Math.round(4.0 * FT), side: 1 }, offsetMm: Math.round(8.0 * FT), mark: "WP-2", values: { switch_leg: "d", control_type: "low_voltage", emergency: true, emergency_mode: "switched", type_mark: "WP" } },
    { type: "place_part", partId: "wp-3", typeId: SHOWCASE_EXTERIOR_SCONCE.id, levelId: "L1", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l1-e-solid", stationMm: Math.round(9.5 * FT), side: -1 }, offsetMm: Math.round(8.0 * FT), mark: "WP-3", values: { switch_leg: "d", control_type: "low_voltage", emergency: false, emergency_mode: "none", type_mark: "WP" } },
    { type: "place_part", partId: "wp-4", typeId: SHOWCASE_EXTERIOR_SCONCE.id, levelId: "L2", position: pt(0, 0), host: { kind: "wall_face", elementId: "w-l2-s-cedar", stationMm: Math.round(3.0 * FT), side: -1 }, offsetMm: Math.round(7.5 * FT), mark: "WP-4", values: { switch_leg: "d", control_type: "low_voltage", emergency: false, emergency_mode: "none", type_mark: "WP" } },

    // Attach explicit IES LM-63 photometric profiles, LLF (0.90 × 0.92 = 0.828), and NFPA 101 emergency battery pack ratings
    {
      type: "set_element_values",
      elementIds: ["lt-1", "lt-2", "lt-13", "lt-15", "lt-17", "lt-11", "lt-11b", "lt-12b", "lt-12", "lt-205", "lt-206", "lt-207", "lt-208"],
      values: { "electrical.photometric_profile": "downlight_6_led", "electrical.emergency_mode": "none", "electrical.lld": 0.9, "electrical.ldd": 0.92 },
    },
    {
      type: "set_element_values",
      elementIds: ["lt-3", "lt-14", "lt-16", "lt-18", "lt-19", "lt-20", "lt-215"],
      values: { "electrical.photometric_profile": "downlight_6_led", "electrical.emergency_mode": "battery_pack", "electrical.emergency_lumens": 1400, "electrical.egress_fixture": true, "electrical.lld": 0.9, "electrical.ldd": 0.92 },
    },
    {
      type: "set_element_values",
      elementIds: ["lt-5", "lt-6", "lt-8", "lt-9", "lt-9b", "lt-21", "lt-22", "lt-23", "lt-24", "lt-210", "lt-211", "lt-214"],
      values: { "electrical.photometric_profile": "troffer_2x4_led", "electrical.emergency_mode": "none", "electrical.lld": 0.9, "electrical.ldd": 0.92 },
    },
    {
      type: "set_element_values",
      elementIds: ["lt-4", "lt-7", "lt-10", "lt-209", "lt-212", "lt-213"],
      values: { "electrical.photometric_profile": "troffer_2x4_led", "electrical.emergency_mode": "battery_pack", "electrical.emergency_lumens": 1400, "electrical.egress_fixture": true, "electrical.lld": 0.9, "electrical.ldd": 0.92 },
    },
    {
      type: "set_element_values",
      elementIds: ["lt-201", "lt-202", "lt-203", "lt-204", "lt-kit-1", "lt-kit-2", "lt-isl-1"],
      values: { "electrical.photometric_profile": "linear_pendant_led", "electrical.emergency_mode": "none", "electrical.lld": 0.9, "electrical.ldd": 0.92 },
    },
    {
      type: "set_element_values",
      elementIds: ["exit-1"],
      values: { "electrical.emergency_mode": "battery_pack", "electrical.egress_fixture": true },
    },
    {
      type: "set_element_values",
      elementIds: ["exit-2"],
      values: { "electrical.photometric_profile": "exit_combo_wall_pack", "electrical.emergency_mode": "battery_pack", "electrical.emergency_lumens": 450, "electrical.egress_fixture": true, "electrical.lld": 0.95, "electrical.ldd": 0.95 },
    },
    {
      type: "set_element_values",
      elementIds: ["wp-1", "wp-2"],
      values: { "electrical.photometric_profile": "exterior_wall_pack_led", "electrical.emergency_mode": "battery_pack", "electrical.emergency_lumens": 1800, "electrical.egress_fixture": true, "electrical.lld": 0.9, "electrical.ldd": 0.9 },
    },
    {
      type: "set_element_values",
      elementIds: ["wp-3", "wp-4"],
      values: { "electrical.photometric_profile": "exterior_wall_pack_led", "electrical.emergency_mode": "none", "electrical.lld": 0.9, "electrical.ldd": 0.9 },
    },

    // Electrical Feeders (MDP → HP-1, MDP → T-1 → LP-1, MDP → Existing SD-1(E)) with NEC-sized copper conductors (live 3D length & AFC auto-calculated!)
    { type: "create_service_link", linkId: "fdr-hp1", sourceId: "mdp", positions: [1, 3, 5], electrical: { ratingA: 225, conductors: { sets: 1, phaseSize: "4/0", neutralSize: "4/0", groundSize: "4", material: "cu" } }, description: "Feeder to Panel HP-1 (480Y/277V)", members: [{ elementId: "hp-1" }] },
    { type: "create_service_link", linkId: "fdr-t1", sourceId: "mdp", positions: [2, 4, 6], electrical: { ratingA: 125, conductors: { sets: 1, phaseSize: "1", groundSize: "6", material: "cu" } }, description: "Feeder to 75 kVA Transformer T-1", members: [{ elementId: "t-1" }] },
    { type: "create_service_link", linkId: "fdr-sd1e", sourceId: "mdp", positions: [7, 9, 11], electrical: { ratingA: 100, conductors: { sets: 1, phaseSize: "3", groundSize: "8", material: "cu" } }, description: "Existing Fused Disconnect SD-1(E) (Halftone Phase Demo)", members: [{ elementId: "sd-1e" }] },
    { type: "create_service_link", linkId: "fdr-sd2d", sourceId: "mdp", positions: [8, 10, 12], electrical: { ratingA: 100, conductors: { sets: 1, phaseSize: "3", groundSize: "8", material: "cu" } }, description: "Demolished Fused Disconnect SD-2(D) (Dashed Demo Phase)", members: [{ elementId: "sd-2d" }] },
    { type: "create_service_link", linkId: "fdr-lp1", sourceId: "t-1", electrical: { ratingA: 225, conductors: { sets: 1, phaseSize: "4/0", neutralSize: "4/0", groundSize: "4", material: "cu" } }, description: "Secondary Feeder to Panel LP-1 (208Y/120V)", members: [{ elementId: "lp-1" }] },

    // Panel HP-1 (480Y/277V) Branch Circuits — EVERY heavy MEP & lighting load circuited (RTU-1 routed via local rooftop NEMA 3R disconnect SD-RTU-1 per NEC 440.14)!
    { type: "create_service_link", linkId: "ckt-hp-rtu", sourceId: "hp-1", positions: [1, 3, 5], electrical: { ratingA: 25 }, description: "RTU-1 via Local Disconnect SD-RTU-1", members: [{ elementId: "disc-rtu-1" }] },
    { type: "create_service_link", linkId: "ckt-disc-rtu1", sourceId: "disc-rtu-1", electrical: { ratingA: 25 }, description: "RTU-1 (Carrier 50FC-A06 5-Ton Packaged Unit)", members: [{ elementId: "rtu-1" }] },
    { type: "create_service_link", linkId: "ckt-hp-wh", sourceId: "hp-1", positions: [2, 4, 6], electrical: { ratingA: 30 }, description: "WH-1 (A.O. Smith DRE-52 18 kW Electric Water Heater)", members: [{ elementId: "wh-1" }] },
    { type: "create_service_link", linkId: "ckt-hp-ltg1", sourceId: "hp-1", positions: [7], electrical: { ratingA: 20 }, description: "L1 Reception & Studio 277V Lighting + Emergency", members: [{ elementId: "lt-1" }, { elementId: "lt-2" }, { elementId: "lt-3" }, { elementId: "lt-16" }, { elementId: "lt-17" }, { elementId: "lt-13" }, { elementId: "lt-14" }, { elementId: "lt-15" }, { elementId: "lt-18" }, { elementId: "lt-19" }, { elementId: "lt-20" }, { elementId: "lt-kit-1" }, { elementId: "lt-kit-2" }, { elementId: "lt-isl-1" }, { elementId: "lt-4" }, { elementId: "lt-5" }, { elementId: "lt-21" }, { elementId: "lt-22" }, { elementId: "lt-6" }, { elementId: "lt-7" }, { elementId: "lt-23" }, { elementId: "lt-24" }, { elementId: "lt-8" }, { elementId: "exit-1" }, { elementId: "exit-2" }] },
    { type: "create_service_link", linkId: "ckt-hp-ltg2", sourceId: "hp-1", positions: [9], electrical: { ratingA: 20 }, description: "L1 MEP Room & Restroom 277V Lighting", members: [{ elementId: "lt-9" }, { elementId: "lt-10" }, { elementId: "lt-9b" }, { elementId: "lt-11" }, { elementId: "lt-11b" }, { elementId: "lt-12b" }, { elementId: "lt-12" }] },
    { type: "create_service_link", linkId: "ckt-hp-ltg3", sourceId: "hp-1", positions: [13], electrical: { ratingA: 20 }, description: "L2 Conference, Restroom & Mezzanine 277V Lighting + Emergency", members: [{ elementId: "lt-201" }, { elementId: "lt-202" }, { elementId: "lt-203" }, { elementId: "lt-204" }, { elementId: "lt-205" }, { elementId: "lt-206" }, { elementId: "lt-207" }, { elementId: "lt-208" }, { elementId: "lt-209" }, { elementId: "lt-210" }, { elementId: "lt-211" }, { elementId: "lt-212" }, { elementId: "lt-213" }, { elementId: "lt-214" }, { elementId: "lt-215" }] },
    { type: "create_service_link", linkId: "ckt-hp-ext", sourceId: "hp-1", positions: [11], electrical: { ratingA: 20 }, description: "Exterior Architectural Wall Sconces VIA TIME CLOCK", members: [{ elementId: "wp-1" }, { elementId: "wp-2" }, { elementId: "wp-3" }, { elementId: "wp-4" }] },

    // Panel LP-1 (208Y/120V) Branch Circuits — Receptacles, GFCIs, Studio Quads, Plotter, NEMA 240V/TL & Exhaust Fan EF-1!
    { type: "create_service_link", linkId: "ckt-lp-gfci", sourceId: "lp-1", positions: [1], electrical: { ratingA: 20 }, description: "Kitchenette, Restroom & MEP GFCI Receptacles", members: [{ elementId: "rec-101" }, { elementId: "rec-102" }, { elementId: "rec-103" }, { elementId: "rec-104" }] },
    { type: "create_service_link", linkId: "ckt-lp-rec", sourceId: "lp-1", positions: [3], electrical: { ratingA: 20 }, description: "Reception & Perimeter Convenience Receptacles", members: [{ elementId: "rec-105" }, { elementId: "rec-106" }, { elementId: "rec-107" }, { elementId: "rec-110" }, { elementId: "rec-111" }] },
    { type: "create_service_link", linkId: "ckt-lp-studio", sourceId: "lp-1", positions: [5], electrical: { ratingA: 20, conductors: { sets: 1, phaseSize: "10", neutralSize: "10", groundSize: "10", material: "cu" } }, description: "Design Studio Workstations, Floor Box & Plotter Quads", members: [{ elementId: "rec-108" }, { elementId: "rec-109" }, { elementId: "rec-112" }, { elementId: "fb-studio-1" }] },
    { type: "create_service_link", linkId: "ckt-lp-ef1", sourceId: "lp-1", positions: [7], electrical: { ratingA: 15 }, description: "EF-1 (Greenheck CSP-B150 Indoor Inline Exhaust Fan)", members: [{ elementId: "ef-1" }] },
    { type: "create_service_link", linkId: "ckt-lp-l2", sourceId: "lp-1", positions: [9], electrical: { ratingA: 20 }, description: "Level 2 Conference Floor Box, Mezzanine & Restroom 202 Receptacles", members: [{ elementId: "rec-201" }, { elementId: "rec-202" }, { elementId: "rec-203" }, { elementId: "fb-conf-1" }] },
    { type: "create_service_link", linkId: "ckt-lp-240v", sourceId: "lp-1", positions: [11, 13], electrical: { ratingA: 20 }, description: "Studio 240V NEMA 6-20R, Twist-Lock & Hardwired Connection [BL]", members: [{ elementId: "rec-240v" }, { elementId: "rec-tl" }, { elementId: "hw-mep-1" }] },
  ]);

  // =========================================================================
  // 7. SAVED 2D / 3D VIEWS, SCHEDULES, LIVE DIAGRAMS & 12-SHEET ARCH D SET
  // =========================================================================
  const plumbingScheduleDef = { ...PLUMBING_FIXTURE_SCHEDULE, filters: [] };

  m = runCmds(m, [
    // ---- First-Class View Templates (Kernel Bedrock — live-bound across discipline plans) ----
    {
      type: "create_view_template",
      viewTemplateId: "vt-arch-plan",
      name: "Arch — Floor Plan",
      description: "Standard architectural floor plan hiding MEP runs and equipment.",
      viewTypes: ["floor_plan"],
      locks: ["discipline", "category_overrides"],
      props: { discipline: "architecture", categoryOverrides: ARCH_HIDE_MEP },
    },
    {
      type: "create_view_template",
      viewTemplateId: "vt-mech-hvac",
      name: "Mech — HVAC Plan (Level Above)",
      description: "Mechanical floor plan using Revit-standard Level Above view top so overhead ductwork and air devices always cut cleanly.",
      viewTypes: ["floor_plan"],
      locks: ["discipline", "view_range", "visual_style", "category_overrides"],
      props: {
        discipline: "mechanical",
        visualStyle: "hidden_line",
        viewBottomMm: 0,
        cutHeightMm: Math.round(4 * FT),
        viewTopRef: "level_above",
        categoryOverrides: MECH_HIDE_NON_HVAC,
      },
    },
    {
      type: "create_view_template",
      viewTemplateId: "vt-elec-power",
      name: "Elec — Power Plan",
      description: "Electrical power plan locking orthogonal circuit graphics and clean device marks.",
      viewTypes: ["floor_plan"],
      locks: ["discipline", "annotations", "pack_props"],
      props: {
        discipline: "electrical",
        hideDeviceMarks: true,
        circuitGraphics: { style: "chamfered", hashMarksOn: "home_runs" },
      },
    },
    {
      type: "create_view_template",
      viewTemplateId: "vt-elec-lighting",
      name: "Elec — Lighting Plan",
      description: "Electrical lighting RCP locking orthogonal wiring and lighting visibility filters.",
      viewTypes: ["ceiling_plan"],
      locks: ["discipline", "category_overrides", "pack_props"],
      props: {
        discipline: "electrical",
        categoryOverrides: ELEC_LTG_HIDE,
        circuitGraphics: { style: "chamfered", hashMarksOn: "home_runs", switchLegs: false },
      },
    },
    {
      type: "create_view_template",
      viewTemplateId: "vt-plumb-water",
      name: "Plumb — Domestic Water Plan",
      description: "Plumbing domestic hot/cold water plan hiding DWV and non-plumbing trades.",
      viewTypes: ["floor_plan"],
      locks: ["discipline", "category_overrides"],
      props: { discipline: "plumbing", categoryOverrides: PLUMB_WATER_HIDE },
    },
    {
      type: "create_view_template",
      viewTemplateId: "vt-plumb-dwv",
      name: "Plumb — Sanitary & Vent Plan",
      description: "Plumbing sanitary & vent DWV plan hiding pressurized water and non-plumbing trades.",
      viewTypes: ["floor_plan"],
      locks: ["discipline", "category_overrides"],
      props: { discipline: "plumbing", categoryOverrides: PLUMB_DWV_HIDE },
    },

    // ---- Saved 3D Perspective Views (Hero Exterior + NW MEP Cutaway, with fovDeg!) ----
    {
      type: "create_3d_view",
      viewId: "view-3d-hero",
      name: "3D Perspective — South-East Hero",
      projection: "perspective",
      camera: {
        eye: { x: Math.round(80 * FT), y: Math.round(-44 * FT), z: Math.round(36 * FT) },
        target: { x: Math.round(28 * FT), y: Math.round(14 * FT), z: Math.round(11 * FT) },
        up: { x: 0, y: 0, z: 1 },
        fovDeg: 40,
        orthoHeightMm: Math.round(36 * FT),
      },
    },
    {
      type: "create_3d_view",
      viewId: "view-3d-mep",
      name: "3D Perspective — North-West MEP Core",
      projection: "perspective",
      camera: {
        eye: { x: Math.round(-36 * FT), y: Math.round(54 * FT), z: Math.round(34 * FT) },
        target: { x: Math.round(18 * FT), y: Math.round(14 * FT), z: Math.round(10 * FT) },
        up: { x: 0, y: 0, z: 1 },
        fovDeg: 42,
        orthoHeightMm: Math.round(36 * FT),
      },
    },

    // ---- Architectural Views & Sheets (A-101 .. A-302) ----
    { type: "create_view", viewId: "view-plan-l1", name: "Level 1 — Floor Plan", viewType: "floor_plan", crop: { min: pt(-11 * FT, -11 * FT), max: pt(W_ALL + 11 * FT, D_ALL + 11 * FT) }, props: { level: "Level 1", scale: 48, viewTemplateId: "vt-arch-plan" } },
    { type: "create_view", viewId: "view-plan-l2", name: "Level 2 — Floor Plan", viewType: "floor_plan", crop: { min: pt(-4 * FT, -7 * FT), max: pt(W_ALL + 4 * FT, D_ALL + 4 * FT) }, props: { level: "Level 2", scale: 64, viewTemplateId: "vt-arch-plan" } },
    { type: "create_view", viewId: "view-enlarged-rr", name: "Enlarged Restroom 202", viewType: "floor_plan", crop: { min: pt(-1 * FT, 19.5 * FT), max: pt(19 * FT, 29 * FT) }, props: { level: "Level 2", scale: 24, viewTemplateId: "vt-arch-plan" } },
    // Live parametric enlarged-plan callout box on Level 2 Floor Plan referencing Enlarged Restroom 202 (2 / A-102)
    { type: "add_drawing_item", itemId: "co-rr-l2", ownerId: "view-plan-l2", shape: "callout", points: [pt(-0.5 * FT, 19.5 * FT), pt(18.5 * FT, 28.5 * FT), pt(-3.0 * FT, 29.8 * FT)], callout: { viewId: "view-enlarged-rr", showLabel: false } },
    { type: "create_view", viewId: "view-rcp-l1", name: "Level 1 — Reflected Ceiling Plan", viewType: "ceiling_plan", crop: { min: pt(-2 * FT, -2 * FT), max: pt(W_ALL + 2 * FT, D_ALL + 2 * FT) }, props: { level: "Level 1", scale: 48, discipline: "architecture", categoryOverrides: RCP_HIDE_NON_CEILING } },
    {
      type: "create_view",
      viewId: "view-sec-ew",
      name: "Building Section — East-West",
      viewType: "section",
      crop: { min: pt(-2 * FT, -3 * FT), max: pt(W_ALL + 14 * FT, 31 * FT) },
      props: {
        scale: 64,
        discipline: "architecture",
        categoryOverrides: { pipe: { detailLevel: "fine" } },
        section: { start: pt(-4 * FT, 11.5 * FT), end: pt(W_ALL + 4 * FT, 11.5 * FT), depthMm: Math.round(18 * FT), direction: 1, referencingViewId: "view-plan-l1", showInDisciplines: ["architecture"] },
      },
    },
    {
      type: "create_view",
      viewId: "view-sec-ns",
      name: "Building Section — North-South",
      viewType: "section",
      crop: { min: pt(-2 * FT, -3 * FT), max: pt(D_ALL + 14 * FT, 31 * FT) },
      props: {
        scale: 64,
        discipline: "architecture",
        categoryOverrides: { pipe: { detailLevel: "fine" } },
        section: { start: pt(24 * FT, -4 * FT), end: pt(24 * FT, D_ALL + 4 * FT), depthMm: Math.round(22 * FT), direction: -1, referencingViewId: "view-plan-l1", showInDisciplines: ["architecture"] },
      },
    },
    {
      type: "create_view",
      viewId: "view-elev-south",
      name: "South Elevation",
      viewType: "elevation",
      crop: { min: pt(-2 * FT, -1 * FT), max: pt(W_ALL + 16 * FT, 31 * FT) },
      props: {
        scale: 64,
        discipline: "architecture",
        categoryOverrides: { pipe: { visible: false } },
        section: { start: pt(-6 * FT, -8 * FT), end: pt(W_ALL + 6 * FT, -8 * FT), depthMm: Math.round(45 * FT), direction: 1, referencingViewId: "view-plan-l1", showInDisciplines: ["architecture"] },
      },
    },
    {
      type: "create_view",
      viewId: "view-elev-east",
      name: "East Elevation",
      viewType: "elevation",
      crop: { min: pt(-2 * FT, -1 * FT), max: pt(D_ALL + 16 * FT, 31 * FT) },
      props: {
        scale: 64,
        discipline: "architecture",
        categoryOverrides: { pipe: { visible: false } },
        section: { start: pt(W_ALL + 8 * FT, -6 * FT), end: pt(W_ALL + 8 * FT, D_ALL + 6 * FT), depthMm: Math.round(68 * FT), direction: 1, referencingViewId: "view-plan-l1", showInDisciplines: ["architecture"] },
      },
    },
    {
      type: "create_view",
      viewId: "view-elev-north",
      name: "North Elevation",
      viewType: "elevation",
      crop: { min: pt(-2 * FT, -1 * FT), max: pt(W_ALL + 16 * FT, 31 * FT) },
      props: {
        scale: 64,
        discipline: "architecture",
        categoryOverrides: { pipe: { visible: false } },
        section: { start: pt(W_ALL + 6 * FT, D_ALL + 8 * FT), end: pt(-6 * FT, D_ALL + 8 * FT), depthMm: Math.round(45 * FT), direction: 1, referencingViewId: "view-plan-l1", showInDisciplines: ["architecture"] },
      },
    },
    {
      type: "create_view",
      viewId: "view-elev-west",
      name: "West Elevation",
      viewType: "elevation",
      crop: { min: pt(-2 * FT, -1 * FT), max: pt(D_ALL + 16 * FT, 31 * FT) },
      props: {
        scale: 64,
        discipline: "architecture",
        categoryOverrides: { pipe: { visible: false } },
        section: { start: pt(-8 * FT, D_ALL + 6 * FT), end: pt(-8 * FT, -6 * FT), depthMm: Math.round(68 * FT), direction: 1, referencingViewId: "view-plan-l1", showInDisciplines: ["architecture"] },
      },
    },

    {
      type: "create_view",
      viewId: "view-sched-rooms",
      name: "Room Schedule",
      viewType: "schedule",
      props: {
        discipline: "architecture",
        scheduleV2: {
          ...DOOR_SCHEDULE,
          name: "ROOM SCHEDULE",
          source: { kind: "classes", classes: ["gen.space"], includeSubclasses: true },
          filters: [],
          columns: [
            { kind: "field", id: "number", heading: "NO.", path: "number" },
            { kind: "field", id: "name", heading: "ROOM NAME", path: "name" },
            { kind: "field", id: "level", heading: "LEVEL", path: "level" },
            { kind: "field", id: "area", heading: "AREA", path: "area" },
          ],
          sort: [{ path: "number", direction: "asc" }],
        },
      },
    },
    { type: "create_view", viewId: "view-sched-doors", name: "Door Schedule", viewType: "schedule", props: { discipline: "architecture", scheduleV2: DOOR_SCHEDULE } },
    { type: "create_view", viewId: "view-sched-windows", name: "Window Schedule", viewType: "schedule", props: { discipline: "architecture", scheduleV2: WINDOW_SCHEDULE } },
    { type: "create_view", viewId: "view-sched-walls", name: "Wall Type Schedule", viewType: "schedule", props: { discipline: "architecture", scheduleV2: WALL_TYPES_SCHEDULE } },

    { type: "create_sheet", sheetId: "sheet-a101", number: "A-101", name: "LEVEL 1 ARCHITECTURAL FLOOR PLAN", discipline: "architecture", group: "Architectural", sortOrder: 101 },
    { type: "place_viewport", viewportId: "vp-plan-l1", sheetId: "sheet-a101", viewId: "view-plan-l1", center: { x: 410, y: 305 } },

    { type: "create_sheet", sheetId: "sheet-a102", number: "A-102", name: "LEVEL 2 PLAN & ENLARGED RESTROOM", discipline: "architecture", group: "Architectural", sortOrder: 102 },
    { type: "place_viewport", viewportId: "vp-plan-l2", sheetId: "sheet-a102", viewId: "view-plan-l2", center: { x: 235, y: 305 } },
    { type: "place_viewport", viewportId: "vp-enlarged-rr", sheetId: "sheet-a102", viewId: "view-enlarged-rr", center: { x: 615, y: 305 } },

    { type: "create_sheet", sheetId: "sheet-a103", number: "A-103", name: "ARCHITECTURAL SCHEDULES", discipline: "architecture", group: "Architectural", sortOrder: 103 },
    { type: "place_viewport", viewportId: "vp-sched-rooms", sheetId: "sheet-a103", viewId: "view-sched-rooms", center: { x: 225, y: 175 } },
    { type: "place_viewport", viewportId: "vp-sched-doors", sheetId: "sheet-a103", viewId: "view-sched-doors", center: { x: 225, y: 420 } },
    { type: "place_viewport", viewportId: "vp-sched-windows", sheetId: "sheet-a103", viewId: "view-sched-windows", center: { x: 605, y: 175 } },
    { type: "place_viewport", viewportId: "vp-sched-walls", sheetId: "sheet-a103", viewId: "view-sched-walls", center: { x: 605, y: 420 } },

    { type: "create_sheet", sheetId: "sheet-a104", number: "A-104", name: "REFLECTED CEILING PLAN", discipline: "architecture", group: "Architectural", sortOrder: 104 },
    { type: "place_viewport", viewportId: "vp-rcp-l1", sheetId: "sheet-a104", viewId: "view-rcp-l1", center: { x: 410, y: 305 } },

    { type: "create_sheet", sheetId: "sheet-a201", number: "A-201", name: "BUILDING SECTIONS", discipline: "architecture", group: "Architectural", sortOrder: 201 },
    { type: "place_viewport", viewportId: "vp-sec-ew", sheetId: "sheet-a201", viewId: "view-sec-ew", center: { x: 390, y: 185 } },
    { type: "place_viewport", viewportId: "vp-sec-ns", sheetId: "sheet-a201", viewId: "view-sec-ns", center: { x: 390, y: 430 } },

    { type: "create_sheet", sheetId: "sheet-a301", number: "A-301", name: "EXTERIOR ELEVATIONS — SOUTH & EAST", discipline: "architecture", group: "Architectural", sortOrder: 301 },
    { type: "place_viewport", viewportId: "vp-elev-south", sheetId: "sheet-a301", viewId: "view-elev-south", center: { x: 390, y: 185 } },
    { type: "place_viewport", viewportId: "vp-elev-east", sheetId: "sheet-a301", viewId: "view-elev-east", center: { x: 390, y: 430 } },

    { type: "create_sheet", sheetId: "sheet-a302", number: "A-302", name: "EXTERIOR ELEVATIONS — NORTH & WEST", discipline: "architecture", group: "Architectural", sortOrder: 302 },
    { type: "place_viewport", viewportId: "vp-elev-north", sheetId: "sheet-a302", viewId: "view-elev-north", center: { x: 390, y: 185 } },
    { type: "place_viewport", viewportId: "vp-elev-west", sheetId: "sheet-a302", viewId: "view-elev-west", center: { x: 390, y: 430 } },

    // ---- Structural Views & Sheets (S-101 Foundation & Column Plan; S-102 Level 2 & Roof Framing; S-201 Framing Sections; S-301 Structural Schedules) ----
    {
      type: "create_view",
      viewId: "view-struct-fnd",
      name: "Foundation & Level 1 Column Plan",
      viewType: "floor_plan",
      crop: { min: pt(-8 * FT, -10 * FT), max: pt(W_ALL + 8 * FT, D_ALL + 8 * FT) },
      props: { level: "Level 1", scale: 48, discipline: "structure", categoryOverrides: STRUCT_FND_HIDE },
    },
    {
      type: "create_view",
      viewId: "view-struct-l2",
      name: "Level 2 Floor & East Roof Framing Plan",
      viewType: "floor_plan",
      crop: { min: pt(-7 * FT, -10 * FT), max: pt(W_ALL + 7 * FT, D_ALL + 7 * FT) },
      props: { level: "Level 2", scale: 64, discipline: "structure", categoryOverrides: STRUCT_FRAMING_HIDE },
    },
    {
      type: "create_view",
      viewId: "view-struct-roof",
      name: "Upper Roof Framing Plan",
      viewType: "floor_plan",
      crop: { min: pt(-7 * FT, -7 * FT), max: pt(W_MAIN + 9 * FT, D_ALL + 7 * FT) },
      props: { level: "Roof", scale: 64, discipline: "structure", categoryOverrides: STRUCT_FRAMING_HIDE },
    },
    {
      type: "create_view",
      viewId: "view-struct-sec-ew",
      name: "Structural Framing Section — Grid B (E-W)",
      viewType: "section",
      crop: { min: pt(-3 * FT, -5 * FT), max: pt(W_ALL + 14 * FT, 30 * FT) },
      props: {
        scale: 48,
        discipline: "structure",
        categoryOverrides: STRUCT_FND_HIDE,
        section: { start: pt(-4 * FT, 14 * FT), end: pt(W_ALL + 4 * FT, 14 * FT), depthMm: Math.round(16 * FT), direction: 1, referencingViewId: "view-struct-fnd", showInDisciplines: ["structure"] },
      },
    },
    {
      type: "create_view",
      viewId: "view-struct-sec-ns",
      name: "Structural Framing Section — Grid 3 (N-S)",
      viewType: "section",
      crop: { min: pt(-8 * FT, -5 * FT), max: pt(D_ALL + 12 * FT, 30 * FT) },
      props: {
        scale: 48,
        discipline: "structure",
        categoryOverrides: STRUCT_FND_HIDE,
        section: { start: pt(W_MAIN, -7 * FT), end: pt(W_MAIN, D_ALL + 4 * FT), depthMm: Math.round(18 * FT), direction: 1, referencingViewId: "view-struct-fnd", showInDisciplines: ["structure"] },
      },
    },
    { type: "create_view", viewId: "view-sched-footings", name: "Pad Footing Schedule", viewType: "schedule", props: { discipline: "structure", scheduleV2: FOOTING_SCHEDULE } },
    { type: "create_view", viewId: "view-sched-columns", name: "Structural Column Schedule", viewType: "schedule", props: { discipline: "structure", scheduleV2: COLUMN_SCHEDULE } },
    { type: "create_view", viewId: "view-sched-beams", name: "Structural Beam Framing Schedule", viewType: "schedule", props: { discipline: "structure", scheduleV2: BEAM_SCHEDULE } },

    { type: "create_sheet", sheetId: "sheet-s101", number: "S-101", name: "FOUNDATION & LEVEL 1 COLUMN PLAN", discipline: "structure", group: "Structural", sortOrder: 351 },
    { type: "place_viewport", viewportId: "vp-struct-fnd", sheetId: "sheet-s101", viewId: "view-struct-fnd", center: { x: 275, y: 300 } },
    { type: "place_viewport", viewportId: "vp-sched-footings", sheetId: "sheet-s101", viewId: "view-sched-footings", center: { x: 670, y: 295 } },

    { type: "create_sheet", sheetId: "sheet-s102", number: "S-102", name: "LEVEL 2 & ROOF FRAMING PLANS", discipline: "structure", group: "Structural", sortOrder: 352 },
    { type: "place_viewport", viewportId: "vp-struct-l2", sheetId: "sheet-s102", viewId: "view-struct-l2", center: { x: 245, y: 300 } },
    { type: "place_viewport", viewportId: "vp-struct-roof", sheetId: "sheet-s102", viewId: "view-struct-roof", center: { x: 615, y: 300 } },

    { type: "create_sheet", sheetId: "sheet-s201", number: "S-201", name: "STRUCTURAL FRAMING SECTIONS", discipline: "structure", group: "Structural", sortOrder: 353 },
    { type: "place_viewport", viewportId: "vp-struct-sec-ew", sheetId: "sheet-s201", viewId: "view-struct-sec-ew", center: { x: 400, y: 170 } },
    { type: "place_viewport", viewportId: "vp-struct-sec-ns", sheetId: "sheet-s201", viewId: "view-struct-sec-ns", center: { x: 400, y: 440 } },

    { type: "create_sheet", sheetId: "sheet-s301", number: "S-301", name: "STRUCTURAL COLUMN & BEAM SCHEDULES", discipline: "structure", group: "Structural", sortOrder: 354 },
    { type: "place_viewport", viewportId: "vp-sched-columns", sheetId: "sheet-s301", viewId: "view-sched-columns", center: { x: 205, y: 240 } },
    { type: "place_viewport", viewportId: "vp-sched-beams", sheetId: "sheet-s301", viewId: "view-sched-beams", center: { x: 590, y: 295 } },
    {
      type: "create_text_note",
      itemId: "note-s301-basis",
      ownerId: "sheet-s301",
      at: { x: 132, y: 415 },
      width: 245,
      textSize: 2.3,
      paragraphs: [
        { runs: [{ text: "STRUCTURAL DEFLECTION & LOAD PATH BASIS", bold: true }] },
        { runs: [{ text: "1. STEEL FRAMING: ASTM A992 (E = 29,000 KSI), STRONG-AXIS CATALOG Ix, SIMPLY SUPPORTED CONSTANT-EI EULER-BERNOULLI BENDING (NO SHEAR DEFORMATION)." }] },
        { runs: [{ text: "2. LIVE DEFL. / LIVE L/Δ: MODELED ONE-WAY DECK LIVE LOAD ONLY (50 PSF OFFICE FLOOR, 100 PSF BALCONY CORRIDOR, 20 PSF ORDINARY ROOF)." }] },
        { runs: [{ text: "3. TOTAL DEFL. / TOTAL L/Δ: SERVICE-LEVEL DEAD (BEAM SELF-WEIGHT) + LIVE + EQUIPMENT POINT LOADS (RTU-1 ON 22' CLEAR-SPAN GIRDER G2-B4, EF-1 ON ROOF)." }] },
        { runs: [{ text: "4. SPAN RATIOS ARE UNFACTORED INFORMATIONAL L/Δ VALUES; NO CODE SERVICEABILITY LIMIT IS EVALUATED." }] },
      ],
    },

    // ---- Mechanical Views & Sheets (M-101 + M-201) ----
    // Separate Rooftop Unit Schedule, Exhaust Fan Schedule (only relevant columns per equipment type!), and Type-Based Air Device Schedule!
    {
      type: "create_view",
      viewId: "view-mech-l1",
      name: "Level 1 — Mechanical HVAC Plan",
      viewType: "floor_plan",
      crop: { min: pt(-2 * FT, -2 * FT), max: pt(W_ALL + 2 * FT, D_ALL + 2 * FT) },
      props: {
        level: "Level 1",
        scale: 64,
        viewTemplateId: "vt-mech-hvac",
        hiddenElementIds: ["cafe-island-l1"],
      },
    },
    {
      type: "create_view",
      viewId: "view-mech-roof",
      name: "Roof — Mechanical Equipment Plan",
      viewType: "floor_plan",
      crop: { min: pt(-2 * FT, -2 * FT), max: pt(W_ALL + 2 * FT, D_ALL + 2 * FT) },
      props: { level: "Level 2", scale: 64, viewTemplateId: "vt-mech-hvac" },
    },
    {
      type: "create_view",
      viewId: "view-sched-air",
      name: "Air Device Schedule (By Type)",
      viewType: "schedule",
      props: {
        discipline: "mechanical",
        scheduleV2: {
          ...AIR_DEVICE_SCHEDULE,
          name: "AIR DEVICE SCHEDULE (BY TYPE)",
          itemize: false,
          groups: [],
          columns: [
            { id: "type_mark", kind: "field", path: "type_mark", heading: "MARK" },
            { id: "type_name", kind: "field", path: "type_name", heading: "TYPE" },
            { id: "family", kind: "field", path: "family", heading: "DESCRIPTION" },
            { id: "count", kind: "field", path: "count", heading: "QTY", total: true },
            { id: "neck_diameter", kind: "parameter", path: "neck_diameter", heading: "NECK", hideWhenEmpty: true },
            { id: "face_size", kind: "parameter", path: "face_size", heading: "FACE", hideWhenEmpty: true },
            { id: "vendor.manufacturer", kind: "field", path: "vendor.manufacturer", heading: "MANUFACTURER", hideWhenEmpty: true },
            { id: "vendor.model", kind: "field", path: "vendor.model", heading: "MODEL", hideWhenEmpty: true },
          ],
          sort: [{ path: "type_mark", direction: "asc" }],
        },
      },
    },
    {
      type: "create_view",
      viewId: "view-sched-rtu",
      name: "Rooftop Unit Schedule",
      viewType: "schedule",
      props: {
        discipline: "mechanical",
        scheduleV2: {
          ...MECHANICAL_EQUIPMENT_SCHEDULE,
          name: "ROOFTOP UNIT SCHEDULE",
          filters: [{ path: "mark", op: "contains", value: "RTU" }],
          columns: MECHANICAL_EQUIPMENT_SCHEDULE.columns.filter((c) => c.id !== "own.exhaust_cfm"),
        },
      },
    },
    {
      type: "create_view",
      viewId: "view-sched-ef",
      name: "Exhaust Fan Schedule",
      viewType: "schedule",
      props: {
        discipline: "mechanical",
        scheduleV2: {
          ...MECHANICAL_EQUIPMENT_SCHEDULE,
          name: "EXHAUST FAN SCHEDULE",
          filters: [{ path: "mark", op: "contains", value: "EF" }],
          columns: MECHANICAL_EQUIPMENT_SCHEDULE.columns.filter(
            (c) => c.id !== "own.cooling_capacity" && c.id !== "own.heating_capacity" && c.id !== "own.cfm" && c.id !== "own.outdoor_cfm" && c.id !== "vendor.curb_size",
          ),
        },
      },
    },
    { type: "create_view", viewId: "view-diag-air", name: "Live Air Schematic", viewType: "detail", props: { discipline: "mechanical", diagram: { kind: "air_schematic" } } },
    { type: "create_sheet", sheetId: "sheet-m101", number: "M-101", name: "MECHANICAL HVAC PLAN & SCHEDULES", discipline: "mechanical", group: "Mechanical", sortOrder: 401 },
    { type: "place_viewport", viewportId: "vp-mech-l1", sheetId: "sheet-m101", viewId: "view-mech-l1", center: { x: 245, y: 195 } },
    { type: "place_viewport", viewportId: "vp-sched-air", sheetId: "sheet-m101", viewId: "view-sched-air", center: { x: 635, y: 185 } },
    { type: "place_viewport", viewportId: "vp-sched-rtu", sheetId: "sheet-m101", viewId: "view-sched-rtu", center: { x: 410, y: 395 } },
    { type: "place_viewport", viewportId: "vp-sched-ef", sheetId: "sheet-m101", viewId: "view-sched-ef", center: { x: 410, y: 515 } },
    { type: "create_sheet", sheetId: "sheet-m201", number: "M-201", name: "ROOF PLAN & AIR SCHEMATIC", discipline: "mechanical", group: "Mechanical", sortOrder: 402 },
    { type: "place_viewport", viewportId: "vp-mech-roof", sheetId: "sheet-m201", viewId: "view-mech-roof", center: { x: 245, y: 305 } },
    { type: "place_viewport", viewportId: "vp-diag-air", sheetId: "sheet-m201", viewId: "view-diag-air", center: { x: 620, y: 305 } },

    // ---- Electrical Views & Sheets (E-101 L1 & L2/Roof Power + Panels; E-102 Separate Lighting & Controls Plans; E-201 One-Line + Controls Diagram + Schedules) ----
    {
      type: "create_view",
      viewId: "view-elec-power",
      name: "Level 1 — Electrical Power Plan",
      viewType: "floor_plan",
      crop: { min: pt(-14 * FT, -2 * FT), max: pt(W_ALL + 2 * FT, D_ALL + 2 * FT) },
      props: {
        level: "Level 1",
        scale: 96,
        viewTemplateId: "vt-elec-power",
        viewBottomMm: 0,
        cutHeightMm: Math.round(4 * FT),
        viewTopMm: Math.round(10 * FT),
        categoryOverrides: ELEC_POWER_HIDE,
      },
    },
    {
      type: "create_view",
      viewId: "view-elec-power-l2",
      name: "Level 2 & Roof — Electrical Power Plan",
      viewType: "floor_plan",
      crop: { min: pt(-2 * FT, -2 * FT), max: pt(W_ALL + 2 * FT, D_ALL + 2 * FT) },
      props: {
        level: "Level 2",
        scale: 96,
        viewTemplateId: "vt-elec-power",
        categoryOverrides: ELEC_POWER_L2_HIDE,
      },
    },
    {
      type: "create_view",
      viewId: "view-elec-ltg",
      name: "Level 1 — Lighting Plan",
      viewType: "ceiling_plan",
      crop: { min: pt(-4 * FT, -4 * FT), max: pt(W_ALL + 4 * FT, D_ALL + 4 * FT) },
      props: {
        level: "Level 1",
        scale: 64,
        viewTemplateId: "vt-elec-lighting",
      },
    },
    {
      type: "create_view",
      viewId: "view-elec-ctrl",
      name: "Level 1 — Lighting Controls Plan",
      viewType: "ceiling_plan",
      crop: { min: pt(-4 * FT, -4 * FT), max: pt(W_ALL + 4 * FT, D_ALL + 4 * FT) },
      props: {
        level: "Level 1",
        scale: 64,
        discipline: "electrical",
        categoryOverrides: ELEC_CTRL_HIDE,
        circuitGraphics: { style: "chamfered", hashMarksOn: "home_runs_and_switch_legs", showCircuits: false, switchLegs: true },
      },
    },
    { type: "create_view", viewId: "view-sched-hp1", name: "Panel HP-1 Schedule (480Y/277V)", viewType: "schedule", props: { discipline: "electrical", formSchedule: { kind: "panel", elementId: "hp-1", template: builtinFormTemplate("panel"), rules: "nec-2023" } } },
    { type: "create_view", viewId: "view-sched-lp1", name: "Panel LP-1 Schedule (208Y/120V)", viewType: "schedule", props: { discipline: "electrical", formSchedule: { kind: "panel", elementId: "lp-1", template: builtinFormTemplate("panel"), rules: "nec-2023" } } },
    { type: "create_view", viewId: "view-sched-lctrl", name: "Lighting Controls Schedule", viewType: "schedule", props: { discipline: "electrical", formSchedule: { kind: "lighting_controls", template: builtinFormTemplate("lighting_controls") } } },
    {
      type: "create_view",
      viewId: "view-sched-ltg",
      name: "Lighting Fixture Schedule",
      viewType: "schedule",
      props: {
        discipline: "electrical",
        scheduleV2: {
          ...LIGHTING_FIXTURE_SCHEDULE,
          name: "LIGHTING FIXTURE SCHEDULE (BY TYPE)",
          itemize: false,
          groups: [],
          sort: [{ path: "type_name", direction: "asc" }],
          columns: [
            { id: "type_name", kind: "field", path: "type_name", heading: "TYPE" },
            { id: "family", kind: "field", path: "family", heading: "DESCRIPTION" },
            { id: "count", kind: "field", path: "count", heading: "QTY", total: true },
            { id: "lumens", kind: "parameter", path: "lumens", heading: "LUMENS", hideWhenEmpty: true },
            { id: "watts", kind: "parameter", path: "watts", heading: "WATTS", total: true, hideWhenEmpty: true },
            { id: "voltage", kind: "parameter", path: "voltage", heading: "VOLTS", hideWhenEmpty: true },
            { id: "emergency", kind: "parameter", path: "emergency", heading: "EM", hideWhenEmpty: true },
            { id: "cut_sheet", kind: "parameter", path: "cut_sheet", heading: "CUT SHEET", hideWhenEmpty: true },
          ],
        },
      },
    },
    { type: "create_view", viewId: "view-oneline", name: "Electrical One-Line Diagram", viewType: "detail", props: { discipline: "electrical", diagram: { kind: "one_line", hints: { title: "ELECTRICAL ONE-LINE DIAGRAM", showLoads: true, showLinkLoads: true, showWarnings: true, faultCurrent: true, lengthMode: "shortest" } } } },
    {
      type: "create_view",
      viewId: "view-oneline-dist",
      name: "Electrical Distribution One-Line (≥ 60A)",
      viewType: "detail",
      props: {
        discipline: "electrical",
        diagram: {
          kind: "one_line",
          hints: {
            title: "DISTRIBUTION ONE-LINE DIAGRAM (≥ 60A FEEDERS)",
            showLoads: true,
            showLinkLoads: true,
            showWarnings: true,
            faultCurrent: true,
            minLoadRatingA: 60,
            phaseScope: "new",
            includeEquipmentIds: ["rtu-1"],
          },
        },
      },
    },
    {
      type: "create_view",
      viewId: "view-controls",
      name: "Lighting Controls Diagram",
      viewType: "detail",
      props: {
        discipline: "electrical",
        diagram: {
          kind: "controls_diagram",
          hints: {
            title: "LIGHTING CONTROLS & SWITCHING DIAGRAM",
            notes: [
              "Provide UL 924 automatic load control relay on switched emergency fixtures (Zones A, B & D).",
              "Exterior wall sconces (Zone D) controlled via roof-mounted photocell + astronomic timeclock.",
            ],
          },
        },
      },
    },

    { type: "create_sheet", sheetId: "sheet-e001", number: "E-001", name: "ELECTRICAL GENERAL NOTES & STANDARDS", discipline: "electrical", group: "Electrical", sortOrder: 500 },

    { type: "create_sheet", sheetId: "sheet-e101", number: "E-101", name: "POWER PLANS & PANEL SCHEDULES", discipline: "electrical", group: "Electrical", sortOrder: 501 },
    { type: "place_viewport", viewportId: "vp-elec-power", sheetId: "sheet-e101", viewId: "view-elec-power", center: { x: 225, y: 175 } },
    { type: "place_viewport", viewportId: "vp-elec-power-l2", sheetId: "sheet-e101", viewId: "view-elec-power-l2", center: { x: 225, y: 425 } },
    { type: "place_viewport", viewportId: "vp-sched-hp1", sheetId: "sheet-e101", viewId: "view-sched-hp1", center: { x: 615, y: 185 } },
    { type: "place_viewport", viewportId: "vp-sched-lp1", sheetId: "sheet-e101", viewId: "view-sched-lp1", center: { x: 615, y: 425 } },

    { type: "create_sheet", sheetId: "sheet-e102", number: "E-102", name: "LIGHTING & CONTROLS PLANS", discipline: "electrical", group: "Electrical", sortOrder: 502 },
    { type: "place_viewport", viewportId: "vp-elec-ltg", sheetId: "sheet-e102", viewId: "view-elec-ltg", center: { x: 230, y: 305 } },
    { type: "place_viewport", viewportId: "vp-elec-ctrl", sheetId: "sheet-e102", viewId: "view-elec-ctrl", center: { x: 600, y: 305 } },

    { type: "create_sheet", sheetId: "sheet-e201", number: "E-201", name: "ELECTRICAL ONE-LINE DIAGRAM", discipline: "electrical", group: "Electrical", sortOrder: 503 },
    { type: "place_viewport", viewportId: "vp-oneline", sheetId: "sheet-e201", viewId: "view-oneline", center: { x: 420, y: 295 } },

    { type: "create_sheet", sheetId: "sheet-e202", number: "E-202", name: "LIGHTING CONTROLS & FIXTURE SCHEDULES", discipline: "electrical", group: "Electrical", sortOrder: 504 },
    { type: "place_viewport", viewportId: "vp-controls", sheetId: "sheet-e202", viewId: "view-controls", center: { x: 420, y: 175 } },
    { type: "place_viewport", viewportId: "vp-sched-lctrl", sheetId: "sheet-e202", viewId: "view-sched-lctrl", center: { x: 225, y: 440 } },
    { type: "place_viewport", viewportId: "vp-sched-ltg", sheetId: "sheet-e202", viewId: "view-sched-ltg", center: { x: 615, y: 440 } },

    // ---- Sheet E-203: Photometrics & Life-Safety Egress Compliance Plans + Schedules ----
    {
      type: "create_view",
      viewId: "view-elec-photometrics",
      name: "Level 1 — Lighting Photometrics Plan",
      viewType: "ceiling_plan",
      crop: { min: pt(-4 * FT, -4 * FT), max: pt(W_ALL + 4 * FT, D_ALL + 6 * FT) },
      props: {
        level: "Level 1",
        scale: 64,
        discipline: "electrical",
        categoryOverrides: ELEC_LTG_HIDE,
        circuitGraphics: { style: "off" },
        photometrics: { photometricsMode: "normal", showContours: true, showGridValues: true, gridSpacingFt: 2 },
      },
    },
    {
      type: "create_view",
      viewId: "view-elec-egress",
      name: "Level 1 — Emergency Egress Lighting Plan",
      viewType: "floor_plan",
      crop: { min: pt(-4 * FT, -7 * FT), max: pt(W_ALL + 4 * FT, D_ALL + 8 * FT) },
      props: {
        level: "Level 1",
        scale: 64,
        discipline: "electrical",
        categoryOverrides: ELEC_LTG_HIDE,
        circuitGraphics: { style: "off" },
        photometrics: { photometricsMode: "egress", showContours: true, showGridValues: true, gridSpacingFt: 2 },
      },
    },
    {
      type: "create_view",
      viewId: "view-sched-photometrics",
      name: "Photometric Summary Schedule",
      viewType: "schedule",
      props: { discipline: "electrical", formSchedule: { kind: "photometric_summary", template: builtinFormTemplate("photometric_summary") } },
    },
    {
      type: "create_view",
      viewId: "view-sched-egress",
      name: "Emergency / Egress Lighting Compliance Schedule",
      viewType: "schedule",
      props: { discipline: "electrical", formSchedule: { kind: "egress_lighting_compliance", template: builtinFormTemplate("egress_lighting_compliance") } },
    },
    { type: "create_sheet", sheetId: "sheet-e203", number: "E-203", name: "PHOTOMETRICS & EGRESS COMPLIANCE", discipline: "electrical", group: "Electrical", sortOrder: 505 },
    { type: "place_viewport", viewportId: "vp-elec-photometrics", sheetId: "sheet-e203", viewId: "view-elec-photometrics", center: { x: 235, y: 175 } },
    { type: "place_viewport", viewportId: "vp-elec-egress", sheetId: "sheet-e203", viewId: "view-elec-egress", center: { x: 235, y: 445 } },
    { type: "place_viewport", viewportId: "vp-sched-photometrics", sheetId: "sheet-e203", viewId: "view-sched-photometrics", center: { x: 635, y: 185 } },
    { type: "place_viewport", viewportId: "vp-sched-egress", sheetId: "sheet-e203", viewId: "view-sched-egress", center: { x: 635, y: 430 } },

    // ---- Plumbing Views & Sheets (P-101 Overall Water + Enlarged Wet Core + Riser + Schedule; P-102 Overall DWV + Enlarged DWV + Riser + Isometric) ----
    {
      type: "create_view",
      viewId: "view-plumb-water-l1",
      name: "Level 1 — Overall Domestic Water Plan",
      viewType: "floor_plan",
      crop: { min: pt(-12 * FT, -2 * FT), max: pt(W_ALL + 2 * FT, D_ALL + 3 * FT) },
      props: { level: "Level 1", scale: 96, viewTemplateId: "vt-plumb-water" },
    },
    // Live L-shape P-line callout & polygonal crop on P-101 wrapping Restroom 102 + MEP Room 101 + Break Room KS-1 while excluding dry corridor/stairwell!
    {
      type: "create_view",
      viewId: "view-plumb-water-enlarged",
      name: "Enlarged L1 — Water Core",
      viewType: "floor_plan",
      crop: { min: pt(-0.5 * FT, 11.5 * FT), max: pt(22.5 * FT, D_ALL + 1.0 * FT) },
      props: {
        level: "Level 1",
        scale: 48,
        viewTemplateId: "vt-plumb-water",
        cropPolygon: [
          pt(-0.5 * FT, 11.5 * FT),
          pt(22.5 * FT, 11.5 * FT),
          pt(22.5 * FT, 20.0 * FT),
          pt(19.5 * FT, 20.0 * FT),
          pt(19.5 * FT, D_ALL + 1.0 * FT),
          pt(-0.5 * FT, D_ALL + 1.0 * FT),
        ],
      },
    },
    // Live L-shape P-line callout on Overall Water Plan pointing to Enlarged Domestic Water Wet Core
    {
      type: "add_drawing_item",
      itemId: "co-water-l1",
      ownerId: "view-plumb-water-l1",
      shape: "callout",
      points: [pt(-0.5 * FT, 11.5 * FT), pt(22.5 * FT, D_ALL + 1.0 * FT), pt(25.0 * FT, D_ALL + 2.5 * FT)],
      callout: {
        viewId: "view-plumb-water-enlarged",
        showLabel: false,
        boundary: [
          pt(-0.5 * FT, 11.5 * FT),
          pt(22.5 * FT, 11.5 * FT),
          pt(22.5 * FT, 20.0 * FT),
          pt(19.5 * FT, 20.0 * FT),
          pt(19.5 * FT, D_ALL + 1.0 * FT),
          pt(-0.5 * FT, D_ALL + 1.0 * FT),
        ],
      },
    },
    {
      type: "create_view",
      viewId: "view-plumb-water-l2",
      name: "Level 2 — Domestic Water Plan",
      viewType: "floor_plan",
      crop: { min: pt(-2 * FT, 18.5 * FT), max: pt(21 * FT, D_ALL + 2 * FT) },
      props: { level: "Level 2", scale: 48, viewTemplateId: "vt-plumb-water" },
    },
    {
      type: "create_view",
      viewId: "view-plumb-riser-water",
      name: "Domestic Water Riser Diagram",
      viewType: "detail",
      props: { discipline: "plumbing", diagram: { kind: "plumbing_riser", hints: { systemKinds: ["domestic_cold_water", "domestic_hot_water"] } } },
    },
    { type: "create_view", viewId: "view-sched-plumb", name: "Plumbing Fixture Schedule", viewType: "schedule", props: { discipline: "plumbing", scheduleV2: plumbingScheduleDef } },
    { type: "create_sheet", sheetId: "sheet-p101", number: "P-101", name: "DOMESTIC WATER PLANS & RISER", discipline: "plumbing", group: "Plumbing", sortOrder: 601 },
    { type: "place_viewport", viewportId: "vp-water-l1", sheetId: "sheet-p101", viewId: "view-plumb-water-l1", center: { x: 185, y: 140 } },
    { type: "place_viewport", viewportId: "vp-water-enlarged", sheetId: "sheet-p101", viewId: "view-plumb-water-enlarged", center: { x: 165, y: 335 } },
    { type: "place_viewport", viewportId: "vp-water-l2", sheetId: "sheet-p101", viewId: "view-plumb-water-l2", center: { x: 165, y: 500 } },
    { type: "place_viewport", viewportId: "vp-riser-water", sheetId: "sheet-p101", viewId: "view-plumb-riser-water", center: { x: 615, y: 185 } },
    { type: "place_viewport", viewportId: "vp-sched-plumb", sheetId: "sheet-p101", viewId: "view-sched-plumb", center: { x: 590, y: 445 } },

    {
      type: "create_view",
      viewId: "view-plumb-dwv-l1",
      name: "Level 1 — Overall Sanitary & Vent Plan",
      viewType: "floor_plan",
      crop: { min: pt(-13 * FT, -2 * FT), max: pt(W_ALL + 2 * FT, D_ALL + 3 * FT) },
      props: { level: "Level 1", scale: 96, viewTemplateId: "vt-plumb-dwv" },
    },
    {
      type: "create_view",
      viewId: "view-plumb-dwv-enlarged",
      name: "Enlarged L1 — DWV Core",
      viewType: "floor_plan",
      crop: { min: pt(-1 * FT, 11.5 * FT), max: pt(22 * FT, D_ALL + 1.5 * FT) },
      props: { level: "Level 1", scale: 48, viewTemplateId: "vt-plumb-dwv" },
    },
    // Live callout box on Overall Sanitary & Vent Plan pointing to Enlarged Sanitary & Vent Wet Core
    { type: "add_drawing_item", itemId: "co-dwv-l1", ownerId: "view-plumb-dwv-l1", shape: "callout", points: [pt(-0.5 * FT, 12.0 * FT), pt(21.5 * FT, D_ALL + 1 * FT), pt(25.0 * FT, D_ALL + 2.5 * FT)], callout: { viewId: "view-plumb-dwv-enlarged", showLabel: false } },
    {
      type: "create_view",
      viewId: "view-plumb-dwv-l2",
      name: "Level 2 — Sanitary & Vent Plan",
      viewType: "floor_plan",
      crop: { min: pt(-2 * FT, 18.5 * FT), max: pt(21 * FT, D_ALL + 2 * FT) },
      props: { level: "Level 2", scale: 48, viewTemplateId: "vt-plumb-dwv" },
    },
    {
      type: "create_view",
      viewId: "view-plumb-riser-dwv",
      name: "Sanitary & Vent Riser Diagram",
      viewType: "detail",
      props: { discipline: "plumbing", diagram: { kind: "plumbing_riser", hints: { systemKinds: ["sanitary", "vent"] } } },
    },
    {
      type: "create_view",
      viewId: "view-plumb-iso",
      name: "Sanitary & Vent Isometric Diagram",
      viewType: "detail",
      props: { discipline: "plumbing", diagram: { kind: "plumbing_isometric", hints: { systemKinds: ["sanitary", "vent"] } } },
    },
    { type: "create_sheet", sheetId: "sheet-p102", number: "P-102", name: "SANITARY & VENT PLANS & ISO", discipline: "plumbing", group: "Plumbing", sortOrder: 602 },
    { type: "place_viewport", viewportId: "vp-dwv-l1", sheetId: "sheet-p102", viewId: "view-plumb-dwv-l1", center: { x: 185, y: 140 } },
    { type: "place_viewport", viewportId: "vp-dwv-enlarged", sheetId: "sheet-p102", viewId: "view-plumb-dwv-enlarged", center: { x: 165, y: 335 } },
    { type: "place_viewport", viewportId: "vp-dwv-l2", sheetId: "sheet-p102", viewId: "view-plumb-dwv-l2", center: { x: 165, y: 500 } },
    { type: "place_viewport", viewportId: "vp-riser-dwv", sheetId: "sheet-p102", viewId: "view-plumb-riser-dwv", center: { x: 615, y: 175 } },
    { type: "place_viewport", viewportId: "vp-plumb-iso", sheetId: "sheet-p102", viewId: "view-plumb-iso", center: { x: 605, y: 435 } },

    // ---- New-feature annotations & locks showcase ----
    // Multi-line leader callouts (auto-snapped leader landing + always-draggable elbow grip)
    {
      type: "create_text_note",
      itemId: "note-elec-fb1",
      ownerId: "view-elec-power",
      at: pt(47.5 * FT, 11.5 * FT),
      width: 65,
      paragraphs: [
        { runs: [{ text: "FB-1: FLOOR-HOSTED DUPLEX FLOOR BOX", bold: true }] },
        { runs: [{ text: "FLUSH BRASS COVER IN TERRAZZO SLAB" }] },
        { runs: [{ text: "CIRCUIT LP-1-5 (20A/1P)" }] },
      ],
      leaders: [{ to: pt(42.5 * FT, 9.0 * FT) }],
    },
    // Multi-line leader callout placed cleanly between Grid Bubbles A and B pointing at the merged MDP + HP-1 NEC 110.26 clearance zone (always-draggable elbow grip)
    {
      type: "create_text_note",
      itemId: "note-elec-clearance",
      ownerId: "view-elec-power",
      at: pt(-13.2 * FT, 10.6 * FT),
      width: 30,
      textSize: 1.8,
      paragraphs: [
        { runs: [{ text: "NEC 110.26 WORKING SPACE", bold: true }] },
        { runs: [{ text: "42\" MIN CLEAR FRONT OF MDP & HP-1" }] },
      ],
      leaders: [{ to: pt(3.2 * FT, 6.2 * FT), elbow: pt(-1.2 * FT, 13.5 * FT) }],
    },
    // Standard Electrical General Notes & Demolition Notes from the shared @permitzip/bim-library catalog placed on Sheet E-001
    {
      type: "create_text_note",
      itemId: "note-e001-general",
      ownerId: "sheet-e001",
      at: { x: 45, y: 55 },
      width: 320,
      paragraphs: standardNoteParagraphs("electrical-general"),
    },
    {
      type: "create_text_note",
      itemId: "note-e001-demo",
      ownerId: "sheet-e001",
      at: { x: 410, y: 55 },
      width: 320,
      paragraphs: standardNoteParagraphs("electrical-demolition"),
    },
    // Mark SD-1(E) as Existing (halftone solid) and SD-2(D) as Demolished (dashed halftone + TO BE DEMOLISHED) on the One-Line Diagram
    {
      type: "set_element_phases",
      ids: ["sd-1e"],
      phaseCreated: "phase-existing",
    },
    {
      type: "set_element_phases",
      ids: ["sd-2d"],
      phaseCreated: "phase-existing",
      phaseDemolished: "phase-new",
    },
    // Protect service switchboard MDP via model-wide element lock (right-click -> Unlock element to edit)
    {
      type: "set_element_locks",
      ids: ["mdp"],
      locked: true,
    },
    // Seeded human review markups (non-printing on permit PDFs; vivid colour on screen & agent renders)
    ...SHOWCASE_SHEET_MARKUPS,
  ]);

  // Append CAD-standard Mechanical Drafting Details sheet (M-501: RTU-1 curb & restroom exhaust wall cap)
  m = appendShowcaseDetails(m);

  const hero = m.elements["view-3d-hero"] as ViewElement | undefined;
  if (!hero) throw new Error("showcase: missing view-3d-hero");
  return m;
}
