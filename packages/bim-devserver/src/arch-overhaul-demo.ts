/**
 * Architectural Overhaul Showcase — Modern Two-Story Pavilion Residence & Studio (`BIM_DEV_MODEL=arch-overhaul`).
 *
 * Contemporary architectural BIM model showcasing:
 * - White architectural stucco, board-formed concrete, charcoal matte metal, natural cedar slats
 * - Full-height dark-bronze mullioned glass curtain walls
 * - Sloped 2.5:12 standing-seam charcoal metal roof with EVERY Level 2 wall tightly attached (`topSurface: { to: "roof" }`)
 * - Flat architectural roof membrane cleanly tucked inside 2'-6" concrete parapets
 * - Flush exterior floor slabs extending cleanly to outer wall faces
 * - Real 3D cut stairwell hole in Level 2 oak floor slab + code-compliant straight-run oak stair w/ 3D steel handrails
 * - Enclosed gypsum soffit ceiling (`form: "soffit"`, extrudes vertical fascia skirt up to structure) + suspended 2'x4' ACT drop ceiling
 * - Overhead garage door, glazed sliding patio/balcony doors, bi-fold closet door, double-hung & triple-panel windows
 * - Complete 4-Sheet architectural set: A-101 L1 Floor Plan, A-102 L2 Floor Plan, A-103 Reflected Ceiling Plan, A-104 Roof Plan, plus E-W Building Section
 */
import {
  DEFAULT_SETTINGS,
  executeCommand,
  planAutoTags,
  withUpgradePolicy,
  type Command,
  type ModelState,
  type Revision,
  type Vec2,
} from "@permitzip/bim-kernel";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";

const FT = 304.8;
const IN = 25.4;

const EXT_T = Math.round(10 * IN); // 254 mm exterior insulated assembly
const INT_T = Math.round(5 * IN);  // 127 mm interior gypsum partition
const SHR_T = Math.round(10 * IN); // 254 mm CMU shear core
const CW_T = Math.round(5 * IN);   // 127 mm dark-bronze aluminum curtain wall frame

const H1 = Math.round(11 * FT);    // 3353 mm Level 1 floor-to-floor
const H2 = Math.round(10 * FT);    // 3048 mm Level 2 base plate (trims up cleanly to sloped roof!)

const pt = (x: number, y: number): Vec2 => ({ x: Math.round(x), y: Math.round(y) });

function runAll(modelId: string, cmds: readonly Command[]): ModelState {
  installFirstPartyAddOns();
  return withUpgradePolicy(
    () => true,
    () => {
      let m: ModelState = { modelId, revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
      for (const cmd of cmds) {
        const r = executeCommand(m, cmd);
        if (!r.ok) throw new Error(`[arch-overhaul-demo] ${cmd.type} failed: ${r.error.code} — ${r.error.message}`);
        m = { ...r.model, revision: (m.revision + 1) as Revision };
      }
      return m;
    },
  );
}

export function createArchOverhaulDemoModel(modelId = "arch-overhaul-demo"): ModelState {
  // Footprint dimensions:
  // Full Ground Floor: X = 0 .. 56 ft, Y = 0 .. 30 ft
  //   - West Bay (Garage + Mudroom): X = 0 .. 18 ft
  //   - Center Bay (Double-Height Great Room + Kitchen + Stair Atrium): X = 18 .. 38 ft
  //   - East Pavilion Wing (1-Story Architecture Studio + Storage): X = 38 .. 56 ft
  // Second Floor (Two-Story Main Volume): X = 0 .. 38 ft, Y = 0 .. 30 ft
  //   - Cantilevered Upper Concrete Balcony Terrace: X = 18 .. 38 ft, Y = -5.5 .. 0 ft
  const W_GAR = 18 * FT;
  const W_MAIN = 38 * FT;
  const W_ALL = 56 * FT;
  const D_ALL = 30 * FT;
  const HALF_EXT = EXT_T / 2; // Flush exterior slab offset so walls never overhang slabs!
  const PARAPET_H = Math.round(2.5 * FT);
  const GUARD_H = Math.round(3.5 * FT);

  const stairwellHole: Vec2[] = [
    pt(24.8 * FT, 21.5 * FT),
    pt(37.2 * FT, 21.5 * FT),
    pt(37.2 * FT, 28.9 * FT),
    pt(24.8 * FT, 28.9 * FT),
  ];

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
    ...(Object.keys(values).length > 0
      ? [{ type: "set_element_values" as const, elementIds: [openingId], values }]
      : []),
  ];

  const cmds: Command[] = [
    // ── 1. Levels ───────────────────────────────────────────────────────────
    { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
    { type: "create_level", levelId: "L2", name: "Level 2", elevationMm: H1 },
    { type: "create_level", levelId: "L3", name: "Roof", elevationMm: H1 + H2 },

    // ── 2. Architectural Element Types (Materials + ISO 6946 Envelope Layers) ──
    {
      type: "create_element_type",
      typeId: "type-wall-stucco",
      name: "Exterior Wall — Smooth White Architectural Stucco (R-24)",
      forKinds: ["wall"],
      values: { "material.id": "architecture.stucco_white", "architecture.wall_function": "EXTERIOR", "architecture.thermal_transmittance": 0.24, "architecture.r_value": 4.2 },
    },
    {
      type: "create_element_type",
      typeId: "type-wall-concrete",
      name: "Exterior Wall — Architectural Board-Formed Concrete",
      forKinds: ["wall"],
      values: { "material.id": "architecture.board_concrete", "architecture.wall_function": "EXTERIOR", "architecture.thermal_transmittance": 0.32, "architecture.r_value": 3.1 },
    },
    {
      type: "create_element_type",
      typeId: "type-wall-charcoal",
      name: "Exterior Wall — Charcoal Matte Standing-Seam Metal",
      forKinds: ["wall"],
      values: { "material.id": "architecture.charcoal_metal", "architecture.wall_function": "EXTERIOR", "architecture.thermal_transmittance": 0.23 },
    },
    {
      type: "create_element_type",
      typeId: "type-wall-cedar",
      name: "Exterior Wall — Natural Cedar Architectural Slats (R-24)",
      forKinds: ["wall"],
      values: { "material.id": "architecture.cedar_siding", "architecture.wall_function": "EXTERIOR", "architecture.thermal_transmittance": 0.24 },
    },
    {
      type: "create_element_type",
      typeId: "type-wall-shear",
      name: "Structural Shear Core — Reinforced CMU (2-hr)",
      forKinds: ["wall"],
      values: { "material.id": "architecture.cmu_concrete", "architecture.wall_function": "SHEAR", "architecture.fire_rating": 2 },
    },
    {
      type: "create_element_type",
      typeId: "type-wall-curtain",
      name: "Storefront Curtain Wall — Dark Bronze Aluminum + Low-E Glass",
      forKinds: ["wall"],
      values: { "material.id": "architecture.curtain_wall_glass", "architecture.wall_function": "CURTAIN", "architecture.mullion_material": "architecture.bronze_mullion", "architecture.thermal_transmittance": 1.6 },
    },
    {
      type: "create_element_type",
      typeId: "type-wall-interior",
      name: "Interior Partition — 5\" Acoustic Gypsum Wall",
      forKinds: ["wall"],
      values: { "material.id": "architecture.gypsum_partition", "architecture.wall_function": "INTERIOR" },
    },
    {
      type: "create_element_type",
      typeId: "type-slab-concrete",
      name: "Floor Slab — Honed Architectural Concrete",
      forKinds: ["slab"],
      values: { "material.id": "architecture.board_concrete" },
    },
    {
      type: "create_element_type",
      typeId: "type-slab-oak",
      name: "Floor Slab — Warm Wide-Plank White Oak",
      forKinds: ["slab"],
      values: { "material.id": "architecture.wood_oak" },
    },
    {
      type: "create_element_type",
      typeId: "type-ceiling-act",
      name: "Suspended Ceiling — 2'×4' Acoustic Tile Grid (ACT)",
      forKinds: ["ceiling"],
      values: { "material.id": "architecture.act_ceiling" },
    },
    {
      type: "create_element_type",
      typeId: "type-ceiling-gypsum",
      name: "Soffit Ceiling — Smooth Painted Gypsum Board",
      forKinds: ["ceiling"],
      values: { "material.id": "architecture.gypsum_partition" },
    },

    // ── 3. Flush Exterior Floor Slabs (L1 + Entry Plinth + L2 w/ REAL 3D Stairwell Hole + Studio Roof Deck) ──
    {
      type: "create_element",
      elementId: "slab-l1-main",
      levelId: "L1",
      kind: "slab",
      typeId: "type-slab-concrete",
      placement: {
        kind: "area",
        outline: [
          pt(-HALF_EXT, -HALF_EXT),
          pt(W_ALL + HALF_EXT, -HALF_EXT),
          pt(W_ALL + HALF_EXT, D_ALL + HALF_EXT),
          pt(-HALF_EXT, D_ALL + HALF_EXT),
        ],
      },
      size: { thicknessMm: Math.round(10 * IN) },
    },
    {
      type: "create_element",
      elementId: "slab-l1-patio",
      levelId: "L1",
      kind: "slab",
      typeId: "type-slab-concrete",
      placement: {
        kind: "area",
        outline: [
          pt(17 * FT, -8 * FT),
          pt(W_ALL + HALF_EXT, -8 * FT),
          pt(W_ALL + HALF_EXT, -HALF_EXT),
          pt(17 * FT, -HALF_EXT),
        ],
      },
      size: { thicknessMm: Math.round(6 * IN) },
    },
    {
      type: "create_element",
      elementId: "slab-l2-main",
      levelId: "L2",
      kind: "slab",
      typeId: "type-slab-oak",
      placement: {
        kind: "area",
        // Framed cleanly inside exterior wall finish cladding (recessed from outer wall face so stucco/concrete runs cleanly over the rim joist)
        outline: [
          pt(0, 0),
          pt(W_MAIN, 0),
          pt(W_MAIN, D_ALL),
          pt(0, D_ALL),
        ],
        holes: [stairwellHole],
      },
      size: { thicknessMm: Math.round(12 * IN) },
    },
    {
      type: "create_element",
      elementId: "slab-l2-balcony",
      levelId: "L2",
      kind: "slab",
      typeId: "type-slab-concrete",
      placement: {
        kind: "area",
        outline: [
          pt(W_GAR - HALF_EXT, -5.5 * FT),
          pt(W_MAIN + HALF_EXT, -5.5 * FT),
          pt(W_MAIN + HALF_EXT, 0),
          pt(W_GAR - HALF_EXT, 0),
        ],
      },
      size: { thicknessMm: Math.round(12 * IN) },
    },
    {
      type: "create_element",
      elementId: "slab-l2-studio-deck",
      levelId: "L2",
      kind: "slab",
      typeId: "type-slab-concrete",
      placement: {
        kind: "area",
        // Framed cleanly inside studio exterior wall & parapet cladding
        outline: [
          pt(W_MAIN, 0),
          pt(W_ALL, 0),
          pt(W_ALL, D_ALL),
          pt(W_MAIN, D_ALL),
        ],
      },
      size: { thicknessMm: Math.round(12 * IN) },
    },

    // ── 4. Level 1 Walls (Modern Facades + Full-Height Glass Curtain Walls + CMU Shear Core) ──
    wall("w-l1-s-gar", "L1", 0, 0, W_GAR, 0, EXT_T, H1, "type-wall-charcoal"),
    wall("w-l1-w-main", "L1", 0, 0, 0, D_ALL, EXT_T, H1, "type-wall-concrete"),
    wall("w-l1-s-curtain", "L1", W_GAR, 0, W_MAIN, 0, CW_T, H1, "type-wall-curtain"),
    wall("w-l1-s-stucco", "L1", W_MAIN, 0, 45 * FT, 0, EXT_T, H1, "type-wall-stucco"),
    wall("w-l1-s-studio-cw", "L1", 45 * FT, 0, W_ALL, 0, CW_T, H1, "type-wall-curtain"),
    wall("w-l1-e-studio-cw", "L1", W_ALL, 0, W_ALL, 16 * FT, CW_T, H1, "type-wall-curtain"),
    wall("w-l1-e-stucco", "L1", W_ALL, 16 * FT, W_ALL, D_ALL, EXT_T, H1, "type-wall-stucco"),
    wall("w-l1-n-west", "L1", 0, D_ALL, W_MAIN, D_ALL, EXT_T, H1, "type-wall-concrete"),
    wall("w-l1-n-east", "L1", W_MAIN, D_ALL, W_ALL, D_ALL, EXT_T, H1, "type-wall-stucco"),
    wall("w-l1-shear", "L1", W_GAR, 0, W_GAR, D_ALL, SHR_T, H1, "type-wall-shear"),
    wall("w-l1-wing-div", "L1", W_MAIN, 0, W_MAIN, D_ALL, EXT_T, H1, "type-wall-concrete"),
    wall("w-l1-mudroom", "L1", 0, 22 * FT, W_GAR, 22 * FT, INT_T, H1, "type-wall-interior"),
    wall("w-l1-stor-w", "L1", 47 * FT, 21 * FT, 47 * FT, D_ALL, INT_T, H1, "type-wall-interior"),
    wall("w-l1-stor-s", "L1", 47 * FT, 21 * FT, W_ALL, 21 * FT, INT_T, H1, "type-wall-interior"),

    // ── 4b. Structural Column Grid Lines (1–4 East-West bays, A–C North-South bays — Revit bubbles on Plans & Sections!) ──
    { type: "create_element", elementId: "grid-1", levelId: "L1", kind: "grid", label: "1", placement: { kind: "line", start: pt(0, -3 * FT), end: pt(0, D_ALL + 3 * FT) } },
    { type: "create_element", elementId: "grid-2", levelId: "L1", kind: "grid", label: "2", placement: { kind: "line", start: pt(W_GAR, -3 * FT), end: pt(W_GAR, D_ALL + 3 * FT) } },
    { type: "create_element", elementId: "grid-3", levelId: "L1", kind: "grid", label: "3", placement: { kind: "line", start: pt(W_MAIN, -3 * FT), end: pt(W_MAIN, D_ALL + 3 * FT) } },
    { type: "create_element", elementId: "grid-4", levelId: "L1", kind: "grid", label: "4", placement: { kind: "line", start: pt(W_ALL, -3 * FT), end: pt(W_ALL, D_ALL + 3 * FT) } },
    { type: "create_element", elementId: "grid-a", levelId: "L1", kind: "grid", label: "A", placement: { kind: "line", start: pt(-3 * FT, 0), end: pt(W_ALL + 3 * FT, 0) } },
    { type: "create_element", elementId: "grid-b", levelId: "L1", kind: "grid", label: "B", placement: { kind: "line", start: pt(-3 * FT, 14 * FT), end: pt(W_ALL + 3 * FT, 14 * FT) } },
    { type: "create_element", elementId: "grid-c", levelId: "L1", kind: "grid", label: "C", placement: { kind: "line", start: pt(-3 * FT, D_ALL), end: pt(W_ALL + 3 * FT, D_ALL) } },

    // ── 5. Level 1 Structural Steel Columns (Aligned cleanly on Grid B, floor-to-slab exact 11'-0" height!) ──
    {
      type: "create_element",
      elementId: "col-l1-1",
      levelId: "L1",
      kind: "column",
      placement: { kind: "point", position: pt(28 * FT, 14 * FT) },
      size: { widthMm: 240, depthMm: 240, heightMm: H1 },
      values: { "material.id": "architecture.bronze_mullion" },
    },
    {
      type: "create_element",
      elementId: "col-l1-2",
      levelId: "L1",
      kind: "column",
      placement: { kind: "point", position: pt(45 * FT, 14 * FT) },
      size: { widthMm: 240, depthMm: 240, heightMm: H1 },
      values: { "material.id": "architecture.bronze_mullion" },
    },

    // ── 6. Level 1 Doors & Windows ──────────────────────────────────────────
    ...opening("door-l1-gar", "L1", "w-l1-s-gar", "door", 9 * FT, 14 * FT, 8 * FT, "D101", { "architecture.door_operation": "ROLLINGUP", "architecture.door_swing": "INWARD" }),
    ...opening("door-l1-mud", "L1", "w-l1-shear", "door", 25.5 * FT, 3 * FT, 7.5 * FT, "D102", { "architecture.door_operation": "SINGLE_SWING_LEFT", "architecture.door_swing": "OUTWARD" }),
    ...opening("door-l1-studio", "L1", "w-l1-wing-div", "door", 12 * FT, 3.5 * FT, 8 * FT, "D103", { "architecture.door_operation": "SINGLE_SWING_RIGHT", "architecture.door_swing": "OUTWARD" }),
    ...opening("door-l1-patio", "L1", "w-l1-n-west", "door", 21.5 * FT, 6 * FT, 8 * FT, "D104", { "architecture.door_operation": "SLIDING_TO_LEFT", "architecture.door_swing": "OUTWARD" }),
    ...opening("door-l1-bifold", "L1", "w-l1-stor-s", "door", 4.5 * FT, 5 * FT, 7.5 * FT, "D105", { "architecture.door_operation": "FOLDING_TO_LEFT", "architecture.door_swing": "OUTWARD" }),
    ...opening("door-l1-gar-int", "L1", "w-l1-mudroom", "door", 13.5 * FT, 3 * FT, 7 * FT, "D106", { "architecture.door_operation": "SINGLE_SWING_LEFT", "architecture.door_swing": "INWARD" }),
    ...opening("win-l1-w1", "L1", "w-l1-w-main", "window", 26 * FT, 4.5 * FT, 5.5 * FT, "W101", { "architecture.window_partition": "DOUBLE_PANEL_HORIZONTAL", "architecture.sill_height": Math.round(3 * FT) }),
    ...opening("win-l1-n1", "L1", "w-l1-n-west", "window", 9 * FT, 6 * FT, 5.5 * FT, "W102", { "architecture.window_partition": "DOUBLE_PANEL_VERTICAL", "architecture.sill_height": Math.round(3 * FT) }),
    ...opening("win-l1-n2", "L1", "w-l1-n-east", "window", 4.5 * FT, 6 * FT, 6.5 * FT, "W103", { "architecture.window_partition": "TRIPLE_PANEL_VERTICAL", "architecture.sill_height": Math.round(2.5 * FT) }),
    ...opening("win-l1-e1", "L1", "w-l1-e-stucco", "window", 2.5 * FT, 4.5 * FT, 6 * FT, "W104", { "architecture.window_partition": "DOUBLE_PANEL_HORIZONTAL", "architecture.sill_height": Math.round(2.5 * FT) }),

    // ── 7. Level 1 Ceilings (Floating 2'×4' ACT Cloud inset cleanly from storefront glass + Enclosed Gypsum Soffit flush to walls) ──
    {
      type: "create_ceiling",
      ceilings: [
        {
          ceilingId: "ceil-l1-studio-act",
          levelId: "L1",
          heightMm: Math.round(9.5 * FT),
          form: "cloud",
          outline: [
            pt(W_MAIN + 2.0 * FT, 2.5 * FT),
            pt(W_ALL - 2.0 * FT, 2.5 * FT),
            pt(W_ALL - 2.0 * FT, 19.5 * FT),
            pt(W_MAIN + 2.0 * FT, 19.5 * FT),
          ],
        },
        {
          ceilingId: "ceil-l1-kitchen-soffit",
          levelId: "L1",
          heightMm: Math.round(9 * FT),
          form: "soffit",
          outline: [
            pt(W_GAR, 14.8 * FT),
            pt(W_MAIN, 14.8 * FT),
            pt(W_MAIN, 21.0 * FT),
            pt(W_GAR, 21.0 * FT),
          ],
        },
      ],
    },
    { type: "set_element_values", elementIds: ["ceil-l1-studio-act"], values: { "material.id": "architecture.act_ceiling" } },
    { type: "set_element_values", elementIds: ["ceil-l1-kitchen-soffit"], values: { "material.id": "architecture.gypsum_partition" } },

    // ── 8. Code-Compliant 180° U-Shape Switchback Stair w/ Mid-Landing (L1 -> L2, 3D steel guardrails, lands into open L2 gallery!) ──
    {
      type: "create_element",
      kind: "architecture.stair",
      elementId: "stair-main",
      levelId: "L1",
      placement: { kind: "line", start: pt(25.0 * FT, 27.1 * FT), end: pt(33.5 * FT, 27.1 * FT) },
      size: { widthMm: Math.round(3.25 * FT) },
      values: {
        "architecture.stair_form": "u_shape",
        "architecture.stair_turn": "right",
        "architecture.landing_depth_mm": Math.round(3.5 * FT),
        "architecture.well_gap_mm": Math.round(0.5 * FT),
        "material.id": "architecture.wood_oak",
      },
    },

    // ── 9. Roofs (Sloped Standing-Seam Metal Shed Roof + Flat Membrane Roof inside Studio Parapet!) ──
    {
      type: "create_element",
      kind: "architecture.roof",
      elementId: "roof-main-shed",
      levelId: "L3",
      placement: {
        kind: "area",
        outline: [
          pt(-2.5 * FT, -2.5 * FT),
          pt(W_MAIN + 2.5 * FT, -2.5 * FT),
          pt(W_MAIN + 2.5 * FT, D_ALL + 2.5 * FT),
          pt(-2.5 * FT, D_ALL + 2.5 * FT),
        ],
      },
      size: { thicknessMm: Math.round(12 * IN) },
      values: {
        "architecture.roof_form": "shed",
        "architecture.slope_rise": 2.5 / 12,
        "architecture.slope_direction_deg": 90,
        "material.id": "architecture.standing_seam_metal",
      },
    },
    {
      type: "create_element",
      kind: "architecture.roof",
      elementId: "roof-studio-flat",
      levelId: "L2",
      placement: {
        kind: "area",
        outline: [
          pt(W_MAIN + HALF_EXT, HALF_EXT),
          pt(W_ALL - HALF_EXT, HALF_EXT),
          pt(W_ALL - HALF_EXT, D_ALL - HALF_EXT),
          pt(W_MAIN + HALF_EXT, D_ALL - HALF_EXT),
        ],
      },
      size: { thicknessMm: Math.round(8 * IN) },
      values: { "architecture.roof_form": "flat", "material.id": "architecture.concrete_slab" },
    },

    // ── 10. Level 2 Walls (ALL Main Walls Attached Tightly to Sloped Roof + Studio Parapets + Glass Guardrail!) ──
    wall("w-l2-s-west", "L2", 0, 0, W_GAR, 0, EXT_T, H2, "type-wall-stucco"),
    wall("w-l2-s-cedar", "L2", W_GAR, 0, W_MAIN, 0, EXT_T, H2, "type-wall-cedar"),
    wall("w-l2-e-cedar", "L2", W_MAIN, 0, W_MAIN, D_ALL, EXT_T, H2, "type-wall-cedar"),
    wall("w-l2-n-main", "L2", 0, D_ALL, W_MAIN, D_ALL, EXT_T, H2, "type-wall-stucco"),
    wall("w-l2-w-main", "L2", 0, 0, 0, D_ALL, EXT_T, H2, "type-wall-charcoal"),
    wall("w-l2-int-suite", "L2", W_GAR, 0, W_GAR, 22 * FT, INT_T, H2, "type-wall-interior"),
    wall("w-l2-int-bath", "L2", 0, 18 * FT, W_GAR, 18 * FT, INT_T, H2, "type-wall-interior"),
    // Cantilevered Upper Balcony Glass + Dark-Bronze Guardrail
    wall("w-l2-rail-s", "L2", W_GAR, -5.2 * FT, W_MAIN, -5.2 * FT, 90, GUARD_H, "type-wall-curtain"),
    wall("w-l2-rail-w", "L2", W_GAR, -5.2 * FT, W_GAR, 0, 90, GUARD_H, "type-wall-curtain"),
    wall("w-l2-rail-e", "L2", W_MAIN, -5.2 * FT, W_MAIN, 0, 90, GUARD_H, "type-wall-curtain"),
    // East Studio Wing Clean 2'-6" Architectural Concrete Parapets
    wall("w-l2-para-s", "L2", W_MAIN, 0, W_ALL, 0, EXT_T, PARAPET_H, "type-wall-concrete"),
    wall("w-l2-para-e", "L2", W_ALL, 0, W_ALL, D_ALL, EXT_T, PARAPET_H, "type-wall-concrete"),
    wall("w-l2-para-n", "L2", W_MAIN, D_ALL, W_ALL, D_ALL, EXT_T, PARAPET_H, "type-wall-concrete"),
  ];

  // Attach EVERY Level 2 main-volume wall tightly up to the sloped standing-seam roof underside (ZERO GAP!)
  const l2Coords: Record<string, [Vec2, Vec2]> = {
    "w-l2-s-west": [pt(0, 0), pt(W_GAR, 0)],
    "w-l2-s-cedar": [pt(W_GAR, 0), pt(W_MAIN, 0)],
    "w-l2-e-cedar": [pt(W_MAIN, 0), pt(W_MAIN, D_ALL)],
    "w-l2-n-main": [pt(0, D_ALL), pt(W_MAIN, D_ALL)],
    "w-l2-w-main": [pt(0, 0), pt(0, D_ALL)],
    "w-l2-int-suite": [pt(W_GAR, 0), pt(W_GAR, 22 * FT)],
    "w-l2-int-bath": [pt(0, 18 * FT), pt(W_GAR, 18 * FT)],
  };
  for (const [elementId, [start, end]] of Object.entries(l2Coords)) {
    cmds.push({
      type: "set_element_placement",
      elementId,
      placement: {
        kind: "line",
        levelId: "L2",
        start,
        end,
        startOffsetMm: 0,
        endOffsetMm: 0,
        lateral: "center",
        vertical: "bottom",
        topSurface: { to: "roof", elementId: "roof-main-shed" },
      },
    });
  }

  // ── 11. Level 2 Doors & Rhythmic Full-Height Modern Windows ────────────────
  cmds.push(
    ...opening("door-l2-balc", "L2", "w-l2-s-cedar", "door", 10 * FT, 10 * FT, 8 * FT, "D201", { "architecture.door_operation": "SLIDING_TO_LEFT", "architecture.door_swing": "OUTWARD" }),
    ...opening("door-l2-suite", "L2", "w-l2-int-suite", "door", 15 * FT, 3 * FT, 7.5 * FT, "D202", { "architecture.door_operation": "SINGLE_SWING_LEFT", "architecture.door_swing": "INWARD" }),
    ...opening("door-l2-bath", "L2", "w-l2-int-bath", "door", 14 * FT, 2.75 * FT, 7.5 * FT, "D203", { "architecture.door_operation": "SINGLE_SWING_RIGHT", "architecture.door_swing": "INWARD" }),
    ...opening("win-l2-s1", "L2", "w-l2-s-west", "window", 5.5 * FT, 4.5 * FT, 7 * FT, "W201", { "architecture.window_partition": "DOUBLE_PANEL_VERTICAL", "architecture.sill_height": Math.round(1.5 * FT) }),
    ...opening("win-l2-s2", "L2", "w-l2-s-west", "window", 12.5 * FT, 4.5 * FT, 7 * FT, "W202", { "architecture.window_partition": "DOUBLE_PANEL_VERTICAL", "architecture.sill_height": Math.round(1.5 * FT) }),
    ...opening("win-l2-e1", "L2", "w-l2-e-cedar", "window", 10 * FT, 7 * FT, 6.5 * FT, "W203", { "architecture.window_partition": "TRIPLE_PANEL_VERTICAL", "architecture.sill_height": Math.round(2.5 * FT) }),
    ...opening("win-l2-n1", "L2", "w-l2-n-main", "window", 9 * FT, 8 * FT, 6.5 * FT, "W204", { "architecture.window_partition": "TRIPLE_PANEL_VERTICAL", "architecture.sill_height": Math.round(2.5 * FT) }),
    ...opening("win-l2-n2", "L2", "w-l2-n-main", "window", 28 * FT, 10 * FT, 5 * FT, "W205", { "architecture.window_partition": "TRIPLE_PANEL_VERTICAL", "architecture.sill_height": Math.round(6 * FT) }),

    // ── 12. Spaces / Rooms (Level 1 + Level 2) ─────────────────────────────
    {
      type: "create_space",
      spaces: [
        { spaceId: "sp-101", levelId: "L1", number: "101", name: "GARAGE", outline: [pt(0, 0), pt(W_GAR, 0), pt(W_GAR, 22 * FT), pt(0, 22 * FT)] },
        { spaceId: "sp-102", levelId: "L1", number: "102", name: "MUDROOM", outline: [pt(0, 22 * FT), pt(W_GAR, 22 * FT), pt(W_GAR, D_ALL), pt(0, D_ALL)] },
        { spaceId: "sp-103", levelId: "L1", number: "103", name: "GREAT ROOM", outline: [pt(W_GAR, 0), pt(W_MAIN, 0), pt(W_MAIN, D_ALL), pt(W_GAR, D_ALL)] },
        { spaceId: "sp-104", levelId: "L1", number: "104", name: "DESIGN STUDIO", outline: [pt(W_MAIN, 0), pt(W_ALL, 0), pt(W_ALL, 21 * FT), pt(47 * FT, 21 * FT), pt(47 * FT, D_ALL), pt(W_MAIN, D_ALL)] },
        { spaceId: "sp-105", levelId: "L1", number: "105", name: "STORAGE", outline: [pt(47 * FT, 21 * FT), pt(W_ALL, 21 * FT), pt(W_ALL, D_ALL), pt(47 * FT, D_ALL)] },
        { spaceId: "sp-201", levelId: "L2", number: "201", name: "BEDROOM 2", outline: [pt(0, 0), pt(W_GAR, 0), pt(W_GAR, 18 * FT), pt(0, 18 * FT)] },
        { spaceId: "sp-202", levelId: "L2", number: "202", name: "PRIMARY BATH", outline: [pt(0, 18 * FT), pt(W_GAR, 18 * FT), pt(W_GAR, D_ALL), pt(0, D_ALL)] },
        { spaceId: "sp-203", levelId: "L2", number: "203", name: "PRIMARY SUITE", outline: [pt(W_GAR, 0), pt(W_MAIN, 0), pt(W_MAIN, 22 * FT), pt(W_GAR, 22 * FT)] },
        { spaceId: "sp-204", levelId: "L2", number: "204", name: "TERRACE", outline: [pt(W_GAR, -5.2 * FT), pt(W_MAIN, -5.2 * FT), pt(W_MAIN, 0), pt(W_GAR, 0)] },
      ],
    },

    // ── 13. Complete Architectural Views (L1 Plan, L2 Plan, L1 RCP, Roof Plan, Building Section) ──
    {
      type: "create_view",
      viewId: "view-plan-l1",
      name: "Level 1 — Floor Plan",
      viewType: "floor_plan",
      crop: { min: pt(-9 * FT, -11 * FT), max: pt(W_ALL + 12 * FT, D_ALL + 8 * FT) },
      props: { level: "Level 1", scale: 96, discipline: "architecture" },
    },
    {
      type: "create_view",
      viewId: "view-plan-l2",
      name: "Level 2 — Floor Plan",
      viewType: "floor_plan",
      crop: { min: pt(-9 * FT, -11 * FT), max: pt(W_ALL + 10 * FT, D_ALL + 8 * FT) },
      props: { level: "Level 2", scale: 96, discipline: "architecture" },
    },
    {
      type: "create_view",
      viewId: "view-rcp-l1",
      name: "Level 1 — Reflected Ceiling Plan",
      viewType: "ceiling_plan",
      crop: { min: pt(-9 * FT, -9 * FT), max: pt(W_ALL + 10 * FT, D_ALL + 8 * FT) },
      props: { level: "Level 1", scale: 96, discipline: "architecture" },
    },
    {
      type: "create_view",
      viewId: "view-roof",
      name: "Roof Plan",
      viewType: "floor_plan",
      crop: { min: pt(-8 * FT, -8 * FT), max: pt(W_ALL + 8 * FT, D_ALL + 8 * FT) },
      props: { level: "Roof", scale: 96, discipline: "architecture" },
    },
    {
      type: "create_view",
      viewId: "view-section-1",
      name: "Building Section A-A (Longitudinal)",
      viewType: "section",
      crop: { min: pt(-2 * FT, -3 * FT), max: pt(W_ALL + 20 * FT, 34 * FT) },
      props: {
        discipline: "architecture",
        scale: 96,
        section: {
          start: pt(-5 * FT, 10.5 * FT),
          end: pt(W_ALL + 5 * FT, 10.5 * FT),
          depthMm: Math.round(20 * FT),
          direction: 1,
        },
      },
    },
    {
      type: "create_view",
      viewId: "view-section-2",
      name: "Building Section B-B (Transverse — Sloped Roof)",
      viewType: "section",
      crop: { min: pt(-2 * FT, -3 * FT), max: pt(D_ALL + 24 * FT, 36 * FT) },
      props: {
        discipline: "architecture",
        scale: 96,
        section: {
          start: pt(22.5 * FT, -8 * FT),
          end: pt(22.5 * FT, D_ALL + 5 * FT),
          depthMm: Math.round(16 * FT),
          direction: -1,
        },
      },
    },

    // ── 14. Movable Room Tags on L1 Floor Plan, L2 Floor Plan, L1 RCP, AND Roof Plan Notes! ──
    { type: "add_drawing_item", itemId: "tag-l1-101", ownerId: "view-plan-l1", shape: "tag", points: [pt(9 * FT, 15.5 * FT)], tag: { elementId: "sp-101", template: "name_number", leader: false } },
    { type: "add_drawing_item", itemId: "tag-l1-102", ownerId: "view-plan-l1", shape: "tag", points: [pt(9 * FT, 26 * FT)], tag: { elementId: "sp-102", template: "name_number", leader: false } },
    { type: "add_drawing_item", itemId: "tag-l1-103", ownerId: "view-plan-l1", shape: "tag", points: [pt(28 * FT, 7 * FT)], tag: { elementId: "sp-103", template: "name_number", leader: false } },
    { type: "add_drawing_item", itemId: "tag-l1-104", ownerId: "view-plan-l1", shape: "tag", points: [pt(47 * FT, 7 * FT)], tag: { elementId: "sp-104", template: "name_number", leader: false } },
    { type: "add_drawing_item", itemId: "tag-l1-105", ownerId: "view-plan-l1", shape: "tag", points: [pt(W_ALL + 6.5 * FT, 25.5 * FT)], tag: { elementId: "sp-105", template: "name_number", leader: true, elbow: pt(W_ALL + 3.5 * FT, 25.5 * FT) } },

    // Reflected Ceiling Plan — movable room tags cleanly positioned clear of automatic ceiling labels!
    { type: "add_drawing_item", itemId: "tag-rcp-101", ownerId: "view-rcp-l1", shape: "tag", points: [pt(9 * FT, 8 * FT)], tag: { elementId: "sp-101", template: "name_number", leader: false } },
    { type: "add_drawing_item", itemId: "tag-rcp-102", ownerId: "view-rcp-l1", shape: "tag", points: [pt(9 * FT, 26 * FT)], tag: { elementId: "sp-102", template: "name_number", leader: false } },
    { type: "add_drawing_item", itemId: "tag-rcp-103", ownerId: "view-rcp-l1", shape: "tag", points: [pt(28 * FT, 7 * FT)], tag: { elementId: "sp-103", template: "name_number", leader: false } },
    { type: "add_drawing_item", itemId: "tag-rcp-104", ownerId: "view-rcp-l1", shape: "tag", points: [pt(47 * FT, 5 * FT)], tag: { elementId: "sp-104", template: "name_number", leader: false } },
    { type: "add_drawing_item", itemId: "tag-rcp-105", ownerId: "view-rcp-l1", shape: "tag", points: [pt(51.5 * FT, 25.5 * FT)], tag: { elementId: "sp-105", template: "name_number", leader: false } },

    // Roof Plan callout notes (movable text annotations)
    { type: "add_drawing_item", itemId: "note-roof-main", ownerId: "view-roof", shape: "text", points: [pt(10 * FT, 24 * FT)], text: "STANDING-SEAM CHARCOAL METAL ROOF\n2.5:12 SLOPE UP TO NORTH RIDGE" },
    { type: "add_drawing_item", itemId: "note-roof-low", ownerId: "view-roof", shape: "text", points: [pt(47 * FT, 16 * FT)], text: "STUDIO LOW-SLOPE ROOF\n(BELOW — 2'-6\" PARAPET)" },

    // Level 2 Floor Plan movable room tags
    { type: "add_drawing_item", itemId: "tag-l2-201", ownerId: "view-plan-l2", shape: "tag", points: [pt(9 * FT, 7 * FT)], tag: { elementId: "sp-201", template: "name_number", leader: false } },
    { type: "add_drawing_item", itemId: "tag-l2-202", ownerId: "view-plan-l2", shape: "tag", points: [pt(9 * FT, 24 * FT)], tag: { elementId: "sp-202", template: "name_number", leader: false } },
    { type: "add_drawing_item", itemId: "tag-l2-203", ownerId: "view-plan-l2", shape: "tag", points: [pt(28 * FT, 7 * FT)], tag: { elementId: "sp-203", template: "name_number", leader: false } },
    { type: "add_drawing_item", itemId: "tag-l2-204", ownerId: "view-plan-l2", shape: "tag", points: [pt(28 * FT, -3.5 * FT)], tag: { elementId: "sp-204", template: "name_number", leader: false } },

    // ── 15. Complete 5-Sheet Architectural Drawing Set (A-101, A-102, A-103 RCP, A-104 Roof Plan, A-201 Section) ──
    { type: "create_sheet", sheetId: "sheet-a101", number: "A-101", name: "Level 1 Architectural Floor Plan" },
    { type: "place_viewport", viewportId: "vp-a101", sheetId: "sheet-a101", viewId: "view-plan-l1", center: { x: 420, y: 310 }, titleOffsetMm: { x: 0, y: 12 } },
    { type: "create_sheet", sheetId: "sheet-a102", number: "A-102", name: "Level 2 Architectural Floor Plan" },
    { type: "place_viewport", viewportId: "vp-a102", sheetId: "sheet-a102", viewId: "view-plan-l2", center: { x: 420, y: 310 }, titleOffsetMm: { x: 0, y: 12 } },
    { type: "create_sheet", sheetId: "sheet-a103", number: "A-103", name: "Level 1 Reflected Ceiling Plan" },
    { type: "place_viewport", viewportId: "vp-a103", sheetId: "sheet-a103", viewId: "view-rcp-l1", center: { x: 420, y: 310 }, titleOffsetMm: { x: 0, y: 12 } },
    { type: "create_sheet", sheetId: "sheet-a104", number: "A-104", name: "Architectural Roof Plan" },
    { type: "place_viewport", viewportId: "vp-a104", sheetId: "sheet-a104", viewId: "view-roof", center: { x: 420, y: 310 } },
    { type: "create_sheet", sheetId: "sheet-a201", number: "A-201", name: "Building Sections A-A & B-B" },
    { type: "place_viewport", viewportId: "vp-a201-a", sheetId: "sheet-a201", viewId: "view-section-1", center: { x: 290, y: 210 } },
    { type: "place_viewport", viewportId: "vp-a201-b", sheetId: "sheet-a201", viewId: "view-section-2", center: { x: 290, y: 420 } },
  );

  let model = runAll(modelId, cmds);
  // Auto-place real, movable, collision-avoided DrawingItem tags:
  // - Doors & windows on L1 and L2 floor plans
  // - Cut rooms/spaces inside Building Sections A-A & B-B (movable & auto-elbow-leader when dragged outside the room, just like plans & RCPs!)
  const autoTagCmds: Command[] = [];
  for (const vid of ["view-plan-l1", "view-plan-l2"]) {
    const plan = planAutoTags(model, vid, { categories: ["opening"], idPrefix: `autotag-${vid}`, leader: "never" });
    for (const item of plan.items) {
      autoTagCmds.push({ type: "add_drawing_item", itemId: item.itemId, ownerId: vid, shape: "tag", points: [item.at], tag: item.tag });
    }
  }
  for (const vid of ["view-section-1", "view-section-2"]) {
    const plan = planAutoTags(model, vid, { categories: ["space"], idPrefix: `autotag-${vid}`, leader: "when_away" });
    for (const item of plan.items) {
      autoTagCmds.push({ type: "add_drawing_item", itemId: item.itemId, ownerId: vid, shape: "tag", points: [item.at], tag: { ...item.tag, mask: true } });
    }
  }
  if (autoTagCmds.length > 0) {
    model = withUpgradePolicy(
      () => true,
      () => {
        let cur = model;
        for (const cmd of autoTagCmds) {
          const r = executeCommand(cur, cmd);
          if (r.ok) cur = { ...r.model, revision: (cur.revision + 1) as Revision };
        }
        return cur;
      },
    );
  }
  return model;
}
