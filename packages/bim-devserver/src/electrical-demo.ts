import {
  DEFAULT_SETTINGS,
  builtinPartType,
  executeCommand,
  type Command,
  type ModelState,
  type Revision,
} from "@permitzip/bim-kernel";

const FT = 304.8;

/**
 * Commercial electrical power + lighting demo model for visually inspecting
 * ANSI/NEC paper-scaled symbols, opaque white masks, under-parts circuit arcs
 * trimmed to symbol/fixture boundaries, switch legs, and non-overlapping labels.
 *
 * Run with: `npm run demo:electrical` (or `BIM_DEV_MODEL=electrical-plan npm run demo`).
 */
export function createElectricalDemoModel(modelId = "electrical-plan-demo"): ModelState {
  const must = (id: string) => {
    const t = builtinPartType(id);
    if (!t) throw new Error(`[electrical-demo] missing builtin part type "${id}"`);
    return t;
  };

  const lp = must("builtin:panelboard-225@1");
  const hp = must("builtin:panelboard-225-480@1");
  const duplex = must("builtin:duplex-receptacle@1");
  const gfci = must("builtin:gfci-receptacle@1");
  const quad = must("builtin:quad-receptacle@1");
  const sw1 = must("builtin:switch-single-pole@1");
  const sw3 = must("builtin:switch-three-way@1");
  const swD = must("builtin:switch-dimmer@1");
  const occ = must("builtin:occupancy-sensor-ceiling@1");
  const jbox = must("builtin:junction-box-4sq@1");
  const downlight = must("builtin:downlight-6-led@1");
  const troffer = must("builtin:troffer-2x4-led@1");
  const trofferEm = must("builtin:troffer-2x4-led-em@1");
  const exitSign = must("builtin:exit-sign-led@1");

  const wall = (wallId: string, x1: number, y1: number, x2: number, y2: number) => ({
    wallId,
    start: { x: x1 * FT, y: y1 * FT },
    end: { x: x2 * FT, y: y2 * FT },
    thicknessMm: 152.4,
    heightMm: 3048,
  });

  const rect = (x1: number, y1: number, x2: number, y2: number) => [
    { x: x1 * FT, y: y1 * FT },
    { x: x2 * FT, y: y1 * FT },
    { x: x2 * FT, y: y2 * FT },
    { x: x1 * FT, y: y2 * FT },
  ];

  const place = (
    partId: string,
    t: ReturnType<typeof must>,
    xFt: number,
    yFt: number,
    mark: string,
    rotationDeg = 0,
    values?: Record<string, number | string>,
  ): Command => ({
    type: "place_part",
    partId,
    typeId: t.id,
    partType: t.definition,
    levelId: "lvl-1",
    position: { x: xFt * FT, y: yFt * FT },
    rotationDeg,
    mark,
    ...(values ? { values } : {}),
  });

  const commands: Command[] = [
    { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 },

    // Perimeter & interior partitions, doors, and rooms (40' x 28' suite).
    {
      type: "add_architecture",
      levelId: "lvl-1",
      walls: [
        wall("w-south", 0, 0, 40, 0),
        wall("w-north", 0, 28, 40, 28),
        wall("w-west", 0, 0, 0, 28),
        wall("w-east", 40, 0, 40, 28),
        wall("w-elec", 10, 16, 10, 28),
        wall("w-mid-n", 0, 16, 40, 16),
        wall("w-mid-s", 0, 9, 40, 9),
        wall("w-rr-div", 20, 0, 20, 9),
      ],
      openings: [
        { openingId: "d-elec", wallId: "w-mid-n", kind: "door", offsetMm: 5 * FT, widthMm: 3 * FT, mark: "101" },
        { openingId: "d-bar", wallId: "w-mid-n", kind: "door", offsetMm: 16 * FT, widthMm: 3 * FT, mark: "102" },
        { openingId: "d-rr1", wallId: "w-mid-s", kind: "door", offsetMm: 17 * FT, widthMm: 3 * FT, mark: "103" },
        { openingId: "d-rr2", wallId: "w-mid-s", kind: "door", offsetMm: 23 * FT, widthMm: 3 * FT, mark: "104" },
      ],
      casework: [],
      rooms: [
        { roomId: "rm-elec", number: "101", name: "ELECTRICAL", outline: rect(0, 16, 10, 28) },
        { roomId: "rm-bar", number: "102", name: "OFFICE / BAR", outline: rect(10, 16, 40, 28) },
        { roomId: "rm-corr", number: "101B", name: "CORRIDOR", outline: rect(0, 9, 40, 16) },
        { roomId: "rm-rr1", number: "103", name: "RESTROOM", outline: rect(0, 0, 20, 9) },
        { roomId: "rm-rr2", number: "104", name: "RESTROOM", outline: rect(20, 0, 40, 9) },
      ],
    },

    // Panels mounted flush against the west wall of Electrical Room (x = 0.25' + half-depth 0.24' = 0.49').
    place("pnl-lp1", lp, 0.49, 24, "LP-1", 90, { panel_name: "LP-1" }),
    place("pnl-hp1", hp, 0.49, 19.5, "HP-1", 90, { panel_name: "HP-1" }),

    // Power devices: receptacles mounted FLUSH on actual wall inner faces (6" walls: +/-0.25' from centerline).
    place("r-1", duplex, 15, 27.75, "W-01", 180),
    place("r-2", gfci, 23, 27.75, "GFCI-1", 180),
    place("r-3", gfci, 31, 27.75, "GFCI-2", 180),
    place("r-4", quad, 39.75, 22, "POS-B", 90),
    place("r-5", quad, 12.5, 16.25, "POS-D", 0),

    // Restroom GFCIs & switches flush on their actual wall inner faces (zero floating devices!).
    place("r-rr1", gfci, 10, 0.25, "W-09", 0),
    place("r-rr2", gfci, 30, 0.25, "W-10", 0),
    place("sw-rr1", sw1, 14.2, 8.75, "SW-RR1", 180),
    place("sw-rr2", sw1, 25.8, 8.75, "SW-RR2", 180),
    place("sw-c1", sw1, 6, 9.25, "SW-C1", 0),
    place("sw-d1", sw3, 18.5, 16.25, "SW-D1", 0),
    place("sw-d2", sw3, 21.0, 16.25, "SW-D2", 0),
    place("sw-k1", swD, 39.75, 12.5, "SW-K1", 90),
    place("os-1", occ, 7, 4.5, "OS-1", 0),
    place("os-2", occ, 33, 4.5, "OS-2", 0),
    place("jb-1", jbox, 20, 12.5, "JB-1", 0),

    // Lighting fixtures: 2x4 troffers (standard + emergency half-shaded), 6" downlights, exit signs.
    place("lt-t1", troffer, 17, 22, "F2-1", 0),
    place("lt-t2", trofferEm, 26, 22, "F2-EM1", 0),
    place("lt-t3", troffer, 34.5, 22, "F2-2", 0),
    place("lt-t4", trofferEm, 28, 12.5, "F2-EM2", 0),
    place("lt-d1", downlight, 8, 12.5, "F1-1", 0),
    place("lt-d2", downlight, 15, 12.5, "F1-2", 0),
    place("lt-d3", downlight, 12.5, 4.5, "F1-3", 0),
    place("lt-d4", downlight, 27.5, 4.5, "F1-4", 0),
    place("lt-ex1", exitSign, 2.5, 12.5, "EX-1", 0),
    place("lt-ex2", exitSign, 35.5, 12.5, "EX-2", 0),

    // Branch circuits on LP-1 (120V receptacles & controls).
    {
      type: "create_service_link",
      linkId: "ckt-lp-1",
      sourceId: "pnl-lp1",
      positions: [1],
      members: [{ elementId: "r-1" }, { elementId: "r-2" }, { elementId: "r-3" }, { elementId: "r-4" }],
      description: "North wall receptacles",
    },
    {
      type: "create_service_link",
      linkId: "ckt-lp-3",
      sourceId: "pnl-lp1",
      positions: [3],
      members: [{ elementId: "r-5" }, { elementId: "r-rr1" }, { elementId: "r-rr2" }],
      description: "Restroom & bar GFCI",
    },
    {
      type: "create_service_link",
      linkId: "ckt-lp-5",
      sourceId: "pnl-lp1",
      positions: [5],
      members: [{ elementId: "os-1" }, { elementId: "os-2" }, { elementId: "jb-1" }],
      description: "Occupancy sensors & controls",
    },

    // Branch circuits on HP-1 (277V lighting).
    {
      type: "create_service_link",
      linkId: "ckt-hp-1",
      sourceId: "pnl-hp1",
      positions: [1],
      members: [{ elementId: "lt-t1" }, { elementId: "lt-t2" }, { elementId: "lt-t3" }, { elementId: "lt-t4" }],
      description: "Office & corridor 2x4 troffers",
    },
    {
      type: "create_service_link",
      linkId: "ckt-hp-3",
      sourceId: "pnl-hp1",
      positions: [3],
      members: [{ elementId: "lt-d1" }, { elementId: "lt-d2" }, { elementId: "lt-d3" }, { elementId: "lt-d4" }, { elementId: "lt-ex1" }, { elementId: "lt-ex2" }],
      description: "Downlights & exit signs",
    },

    // Floor plans at 1/8" = 1'-0" (1:96) and 1/4" = 1'-0" (1:48) to inspect paper-space scaling & wire trimming.
    {
      type: "create_view",
      viewId: "v-e101",
      name: "E101 Electrical Plan (1/8\" = 1'-0\")",
      viewType: "floor_plan",
      crop: { min: { x: -2 * FT, y: -2 * FT }, max: { x: 42 * FT, y: 30 * FT } },
      props: { level: "Level 1", scale: 96, discipline: "electrical" },
    },
    {
      type: "create_view",
      viewId: "v-e102",
      name: "E102 Enlarged Electrical Plan (1/4\" = 1'-0\")",
      viewType: "floor_plan",
      crop: { min: { x: -2 * FT, y: -2 * FT }, max: { x: 42 * FT, y: 30 * FT } },
      props: { level: "Level 1", scale: 48, discipline: "electrical" },
    },
    // Real Sheet E101 with viewport v-e101 placed (so the Sheets tab opens to a complete electrical sheet with circuits & no missing demo dimensions).
    {
      type: "create_sheet",
      sheetId: "sh-e101",
      number: "E101",
      name: "Electrical Power & Lighting Plan",
    },
    {
      type: "place_viewport",
      viewportId: "vp-e101",
      sheetId: "sh-e101",
      viewId: "v-e102",
      center: { x: 380, y: 280 },
    },
  ];

  let m: ModelState = { modelId, revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  for (const command of commands) {
    const r = executeCommand(m, command);
    if (!r.ok) throw new Error(`[electrical-demo] ${command.type} failed: ${r.error.message}`);
    m = { ...r.model, revision: (m.revision + 1) as Revision };
  }
  return m;
}
