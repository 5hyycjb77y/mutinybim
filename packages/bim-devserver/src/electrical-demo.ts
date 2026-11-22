import {
  DEFAULT_SETTINGS,
  builtinFormTemplate,
  builtinPartType,
  enlargedPlanCommands,
  executeCommand,
  libraryRowsOf,
  sheetLayoutCommand,
  withUpgradePolicy,
  type Command,
  type ModelState,
  type Revision,
  type ScheduleDefinitionV2,
} from "@permitzip/bim-kernel";

const FT = 304.8;

/**
 * Complete commercial electrical power, lighting & controls demo set flexing
 * the end-game MutinyBIM workflow:
 * - Service entrance & distribution in Electrical Room 101 (MDP -> HP-1, MDP -> T-1 -> LP-1)
 * - Wall-face hosted devices (`wall_face` host) with crisp stems & room-facing orientation
 * - True vector circles, masked GFI/subscripts, dynamic emergency battery shading (EM & UL 924)
 * - Multi-Wire Branch Circuit (MWBC) shared-neutral multi-arrowhead home run (`LP-1-1,3`)
 * - Separated Power Plan (E101) + live parametric Enlarged Electrical Room 101 (E102)
 *   + Lighting RCP (E103) + Dedicated Controls Schematic Plan (E104)
 * - Live Panelboard Schedules (LP-1, HP-1), Switchboard Schedule (MDP), Lighting Fixture Schedule,
 *   Lighting Controls Schedule, Live Electrical One-Line Diagram & Live Lighting Controls Diagram
 * - Three complete Arch D sheets (E101, E201, E501) arranged cleanly via `sheetLayoutCommand`.
 *
 * Run with: `npm run demo:electrical` (or `BIM_DEV_MODEL=electrical-plan npm run demo`).
 */
export function createElectricalDemoModel(modelId = "electrical-plan-demo"): ModelState {
  const must = (id: string) => {
    const t = builtinPartType(id);
    if (!t) throw new Error(`[electrical-demo] missing builtin part type "${id}"`);
    return t;
  };

  const mdp = must("builtin:switchboard-800-480@1");
  const xfmr = must("builtin:transformer-75kva@1");
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

  const CEILING_MM = 9 * FT;
  const EXIT_MM = 8 * FT;
  const COUNTER_MM = 44 * 25.4;
  const PANEL_OFFSET_MM = 180;

  const place = (
    partId: string,
    t: ReturnType<typeof must>,
    xFt: number,
    yFt: number,
    mark: string,
    offsetMm: number,
    rotationDeg = 0,
    values?: Record<string, number | string | boolean>,
  ): Command => ({
    type: "place_part",
    partId,
    typeId: t.id,
    partType: t.definition,
    levelId: "lvl-1",
    position: { x: xFt * FT, y: yFt * FT },
    offsetMm,
    rotationDeg,
    mark,
    ...(values ? { values } : {}),
  });

  /** Mount flush on a wall finish face (`wall_face` host): kernel computes exact finish-face position & outward rotation, and the device follows wall edits. */
  const placeOnWall = (
    partId: string,
    t: ReturnType<typeof must>,
    wallId: string,
    alongFt: number,
    side: 1 | -1,
    mark: string,
    offsetMm = 457.2,
    values?: Record<string, number | string | boolean>,
  ): Command => ({
    type: "place_part",
    partId,
    typeId: t.id,
    partType: t.definition,
    levelId: "lvl-1",
    position: { x: 0, y: 0 },
    offsetMm,
    host: { kind: "wall_face", elementId: wallId, stationMm: alongFt * FT, side },
    mark,
    ...(values ? { values } : {}),
  });

  const lightingScheduleDef = libraryRowsOf()
    .flatMap((g) => g.rows)
    .find((r) => r.section === "scheduleTemplates" && r.item.key === "lighting_fixture_schedule")?.item.definition as ScheduleDefinitionV2 | undefined;

  const commands: Command[] = [
    { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 },

    // Perimeter & interior partitions, doors, and rooms (40' x 28' commercial suite).
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

    // Electrical Room 101 distribution lineup: MDP (800A 480Y/277V), HP-1 (225A 480Y/277V), T-1 (75 kVA), LP-1 (225A 208Y/120V).
    placeOnWall("pnl-mdp", mdp, "w-north", 5.5, -1, "MDP", 0, { panel_name: "MDP" }),
    placeOnWall("pnl-hp1", hp, "w-west", 24, -1, "HP-1", PANEL_OFFSET_MM, { panel_name: "HP-1" }),
    place("xfmr-t1", xfmr, 7.2, 20.5, "T-1", 0, 0, { panel_name: "T-1" }),
    placeOnWall("pnl-lp1", lp, "w-west", 19.5, -1, "LP-1", PANEL_OFFSET_MM, { panel_name: "LP-1" }),

    // Distribution feeders: MDP -> HP-1 (225A/3P), MDP -> T-1 (125A/3P), T-1 -> LP-1 (225A/3P secondary).
    {
      type: "create_service_link",
      linkId: "fdr-hp1",
      sourceId: "pnl-mdp",
      positions: [1, 3, 5],
      members: [{ elementId: "pnl-hp1" }],
      description: "Lighting Panel HP-1",
      electrical: { ratingA: 225, conductors: { sets: 1, phaseSize: "4/0", neutralSize: "4/0", groundSize: "4", material: "cu" }, lengthFt: 18 },
    },
    {
      type: "create_service_link",
      linkId: "fdr-t1",
      sourceId: "pnl-mdp",
      positions: [7, 9, 11],
      members: [{ elementId: "xfmr-t1" }],
      description: "75 kVA Step-Down Transformer T-1",
      electrical: { ratingA: 125, conductors: { sets: 1, phaseSize: "1", groundSize: "6", material: "cu" }, lengthFt: 15 },
    },
    {
      type: "create_service_link",
      linkId: "fdr-lp1",
      sourceId: "xfmr-t1",
      members: [{ elementId: "pnl-lp1" }],
      description: "Power Panel LP-1 (208Y/120V Secondary)",
      electrical: { ratingA: 225, conductors: { sets: 1, phaseSize: "4/0", neutralSize: "4/0", groundSize: "4", material: "cu" }, lengthFt: 12 },
    },

    // Power devices: wall-face hosted (`wall_face`) so prongs sit flush on finish faces & follow wall edits.
    placeOnWall("r-1", duplex, "w-north", 15, -1, "W-01"),
    placeOnWall("r-2", gfci, "w-north", 23, -1, "GFCI-1", COUNTER_MM),
    placeOnWall("r-3", gfci, "w-north", 31, -1, "GFCI-2", COUNTER_MM),
    placeOnWall("r-4", quad, "w-east", 22, 1, "POS-B"),
    placeOnWall("r-5", quad, "w-mid-n", 12.5, 1, "POS-D"),

    // Restroom GFCIs (44" AFF above vanity) & wall switches (48" AFF) hosted flush on their actual wall finish faces.
    placeOnWall("r-rr1", gfci, "w-south", 10, 1, "W-09", COUNTER_MM),
    placeOnWall("r-rr2", gfci, "w-south", 30, 1, "W-10", COUNTER_MM),
    placeOnWall("sw-rr1", sw1, "w-mid-s", 14.2, -1, "SW-RR1", 1219.2),
    placeOnWall("sw-rr2", sw1, "w-mid-s", 25.8, -1, "SW-RR2", 1219.2),
    placeOnWall("sw-c1", sw1, "w-mid-s", 6, 1, "SW-C1", 1219.2),
    placeOnWall("sw-d1", sw3, "w-mid-n", 18.5, 1, "SW-D1", 1219.2),
    placeOnWall("sw-d2", sw3, "w-mid-n", 21.0, 1, "SW-D2", 1219.2),
    placeOnWall("sw-k1", swD, "w-east", 12.5, 1, "SW-K1", 1219.2),
    // Ceiling-mounted sensors & junction box at 9'-0" AFF ceiling elevation.
    place("os-1", occ, 7, 4.5, "OS-1", CEILING_MM),
    place("os-2", occ, 33, 4.5, "OS-2", CEILING_MM),
    place("jb-1", jbox, 20, 12.5, "JB-1", CEILING_MM),

    // Ceiling lighting fixtures at 9'-0" AFF (2x4 troffers, 6" downlights) and exit signs at 8'-0" AFF above corridor doors.
    place("lt-t1", troffer, 17, 22, "F2-1", CEILING_MM),
    place("lt-t2", trofferEm, 26, 22, "F2-EM1", CEILING_MM),
    place("lt-t3", troffer, 34.5, 22, "F2-2", CEILING_MM),
    place("lt-t4", trofferEm, 28, 12.5, "F2-EM2", CEILING_MM),
    place("lt-d1", downlight, 8, 12.5, "F1-1", CEILING_MM),
    place("lt-d2", downlight, 15, 12.5, "F1-2", CEILING_MM),
    place("lt-d3", downlight, 12.5, 4.5, "F1-3", CEILING_MM),
    place("lt-d4", downlight, 27.5, 4.5, "F1-4", CEILING_MM),
    place("lt-ex1", exitSign, 2.5, 12.5, "EX-1", EXIT_MM),
    place("lt-ex2", exitSign, 35.5, 12.5, "EX-2", EXIT_MM),

    // Dynamic Emergency fixture modes (unswitched EM & UL 924 switched EM) + Lighting control zones (a–e).
    { type: "set_parameters", id: "lt-t2", scope: "instance", values: { emergency: true, emergency_mode: "unswitched" } },
    { type: "set_parameters", id: "lt-t4", scope: "instance", values: { emergency: true, emergency_mode: "switched" } },
    { type: "set_parameters", id: "lt-d2", scope: "instance", values: { emergency: true, emergency_mode: "unswitched" } },
    { type: "set_parameters", id: "sw-d1", scope: "instance", values: { switch_leg: "a", control_type: "line_voltage" } },
    { type: "set_parameters", id: "sw-d2", scope: "instance", values: { switch_leg: "a", control_type: "line_voltage" } },
    { type: "set_parameters", id: "lt-t1", scope: "instance", values: { switch_leg: "a" } },
    { type: "set_parameters", id: "lt-t3", scope: "instance", values: { switch_leg: "a" } },
    { type: "set_parameters", id: "sw-k1", scope: "instance", values: { switch_leg: "b", control_type: "0-10v" } },
    { type: "set_parameters", id: "lt-t4", scope: "instance", values: { switch_leg: "b" } },
    { type: "set_parameters", id: "sw-rr1", scope: "instance", values: { switch_leg: "c", control_type: "low_voltage" } },
    { type: "set_parameters", id: "os-1", scope: "instance", values: { switch_leg: "c", control_type: "low_voltage" } },
    { type: "set_parameters", id: "lt-d3", scope: "instance", values: { switch_leg: "c" } },
    { type: "set_parameters", id: "sw-rr2", scope: "instance", values: { switch_leg: "d", control_type: "low_voltage" } },
    { type: "set_parameters", id: "os-2", scope: "instance", values: { switch_leg: "d", control_type: "low_voltage" } },
    { type: "set_parameters", id: "lt-d4", scope: "instance", values: { switch_leg: "d" } },
    { type: "set_parameters", id: "sw-c1", scope: "instance", values: { switch_leg: "e", control_type: "line_voltage" } },
    { type: "set_parameters", id: "lt-d1", scope: "instance", values: { switch_leg: "e" } },
    { type: "set_parameters", id: "lt-d2", scope: "instance", values: { switch_leg: "e" } },

    // Branch circuits on LP-1 (120V receptacles & controls; circuits 1 & 3 paired as shared-neutral MWBC on E101).
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

    // Unified 3/32" (2.4 mm) opaque annotation Text Type so device marks, home-run labels, switch-leg letters & tags stay crisp over crossing lines.
    {
      type: "update_text_style",
      styleId: "txt-annotation-3-32",
      textSizeMm: 2.4,
      background: "opaque",
      defaultFor: ["part_mark", "link_label", "tag", "dimension"],
    },

    // 1) Overall plan at 1/16" = 1'-0" (demonstrates hybrid `minPaperMm` legibility floor).
    {
      type: "create_view",
      viewId: "v-e100",
      name: "E100 Overall Electrical Plan (1/16\" = 1'-0\")",
      viewType: "floor_plan",
      crop: { min: { x: -2 * FT, y: -2 * FT }, max: { x: 42 * FT, y: 30 * FT } },
      props: { level: "Level 1", scale: 192, discipline: "electrical" },
    },

    // 2) Dedicated Power Plan at 1/8" = 1'-0" (hides lighting fixtures, shows MWBC combined home run LP-1-1,3).
    {
      type: "create_view",
      viewId: "v-e101",
      name: "E101 Electrical Power Plan (1/8\" = 1'-0\")",
      viewType: "floor_plan",
      crop: { min: { x: -2 * FT, y: -2 * FT }, max: { x: 42 * FT, y: 30 * FT } },
      props: {
        level: "Level 1",
        scale: 96,
        discipline: "electrical",
        categoryOverrides: { lighting_fixtures: { visible: false } },
      },
    },
    {
      type: "set_view_properties",
      viewId: "v-e101",
      props: {
        circuitGraphics: {
          style: "arcs",
          showCircuits: true,
          homeRuns: true,
          switchLegs: false,
          switchLegLabels: false,
          hashMarks: "hots_neutral_ground",
          hashMarksOn: "home_runs",
          hints: {
            "ckt-lp-1": { mwbcGroup: "mwbc-1" },
            "ckt-lp-3": { mwbcGroup: "mwbc-1" },
          },
        },
      },
    },

    // 3) Dedicated Lighting Plan / Reflected Ceiling Plan at 1/8" = 1'-0" (luminaires, switches, switch-leg hash marks, dynamic EM shading).
    {
      type: "create_view",
      viewId: "v-e103",
      name: "E103 Lighting Plan / RCP (1/8\" = 1'-0\")",
      viewType: "ceiling_plan",
      crop: { min: { x: -2 * FT, y: -2 * FT }, max: { x: 42 * FT, y: 30 * FT } },
      props: { level: "Level 1", scale: 96, discipline: "electrical" },
    },
    {
      type: "set_view_properties",
      viewId: "v-e103",
      props: {
        circuitGraphics: {
          style: "arcs",
          showCircuits: true,
          homeRuns: true,
          switchLegs: true,
          switchLegLabels: true,
          hashMarks: "hots_neutral_ground",
          hashMarksOn: "home_runs_and_switch_legs",
        },
      },
    },

    // 4) Dedicated Lighting Controls Schematic Plan at 1/8" = 1'-0" (branch power hidden; switch legs, letters & control hash marks only).
    {
      type: "create_view",
      viewId: "v-e104",
      name: "E104 Lighting Controls Schematic Plan (1/8\" = 1'-0\")",
      viewType: "ceiling_plan",
      crop: { min: { x: -2 * FT, y: -2 * FT }, max: { x: 42 * FT, y: 30 * FT } },
      props: { level: "Level 1", scale: 96, discipline: "electrical" },
    },
    {
      type: "set_view_properties",
      viewId: "v-e104",
      props: {
        circuitGraphics: {
          style: "arcs",
          showCircuits: false,
          homeRuns: false,
          switchLegs: true,
          switchLegLabels: true,
          hashMarks: "hots_neutral_ground",
          hashMarksOn: "home_runs_and_switch_legs",
        },
      },
    },

    // 5) Live Electrical Schedules (Panels LP-1 & HP-1, Switchboard MDP, Lighting Fixture Schedule, Lighting Controls Schedule).
    {
      type: "create_view",
      viewId: "v-sch-lp1",
      name: "Panel LP-1 Schedule",
      viewType: "schedule",
      props: {
        formSchedule: {
          kind: "panel",
          elementId: "pnl-lp1",
          template: builtinFormTemplate("panel"),
          rules: "nec-2023",
        },
      },
    },
    {
      type: "create_view",
      viewId: "v-sch-hp1",
      name: "Panel HP-1 Schedule",
      viewType: "schedule",
      props: {
        formSchedule: {
          kind: "panel",
          elementId: "pnl-hp1",
          template: builtinFormTemplate("panel"),
          rules: "nec-2023",
        },
      },
    },
    {
      type: "create_view",
      viewId: "v-sch-mdp",
      name: "Switchboard MDP Schedule",
      viewType: "schedule",
      props: {
        formSchedule: {
          kind: "switchboard",
          elementId: "pnl-mdp",
          template: builtinFormTemplate("switchboard"),
          rules: "nec-2023",
        },
      },
    },
    ...(lightingScheduleDef
      ? [
          {
            type: "create_view" as const,
            viewId: "v-sch-lfx",
            name: "Lighting Fixture Schedule",
            viewType: "schedule" as const,
            props: { scheduleV2: lightingScheduleDef },
          },
        ]
      : []),
    {
      type: "create_view",
      viewId: "v-sch-lctrl",
      name: "Lighting Controls Schedule",
      viewType: "schedule",
      props: {
        formSchedule: {
          kind: "lighting_controls",
          template: builtinFormTemplate("lighting_controls"),
        },
      },
    },

    // 6) Live Electrical Diagrams (One-Line Distribution Diagram & Lighting Controls Schematic Diagram).
    {
      type: "create_view",
      viewId: "v-diag-sld",
      name: "Electrical One-Line Diagram",
      viewType: "detail",
      props: {
        diagram: {
          kind: "one_line",
          hints: {
            title: "ELECTRICAL ONE-LINE DIAGRAM",
            showLoads: true,
            showWarnings: true,
          },
        },
      },
    },
    {
      type: "create_view",
      viewId: "v-diag-ctrl",
      name: "Lighting Controls Diagram",
      viewType: "detail",
      props: {
        diagram: {
          kind: "controls_diagram",
          hints: {
            title: "LIGHTING CONTROLS & SWITCHING DIAGRAM",
            notes: [
              "Provide UL 924 automatic load control relay on switched emergency fixtures (Zone B).",
              "Verify 0-10V dimming leads run in Class 1 rated insulation where sharing branch conduit.",
            ],
          },
        },
      },
    },
  ];

  let m: ModelState = { modelId, revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const run = (cmd: Command) => {
    const r = executeCommand(m, cmd);
    if (!r.ok) throw new Error(`[electrical-demo] ${cmd.type} failed: ${r.error.message}`);
    m = { ...r.model, revision: (m.revision + 1) as Revision };
  };

  return withUpgradePolicy(() => true, () => {
    for (const command of commands) run(command);

    // 7) Live parametric Enlarged Electrical Room 101 Plan (1/2" = 1'-0") + auto-updating callout bubble on E101 Power Plan.
    const enlarged = enlargedPlanCommands(m, {
      parentViewId: "v-e101",
      viewId: "v-e102",
      calloutId: "co-elec-rm",
      name: "E102 Enlarged Electrical Room",
      box: { min: { x: -1 * FT, y: 15 * FT }, max: { x: 11 * FT, y: 29 * FT } },
      scale: 24,
    });
    if (typeof enlarged === "string") throw new Error(`[electrical-demo] enlargedPlan failed: ${enlarged}`);
    for (const step of enlarged) run(step);

    // 8) Three complete Arch D (36" x 24") construction sheets, arranged cleanly via kernel `sheetLayoutCommand`.
    const sheetCmds: Command[] = [
      // Sheet E101: Power Plan + Enlarged Electrical Room 101 + Panel LP-1 Schedule
      { type: "create_sheet", sheetId: "sh-e101", number: "E101", name: "Electrical Power Plan & Enlarged Electrical Room" },
      { type: "place_viewport", viewportId: "vp-e101-pwr", sheetId: "sh-e101", viewId: "v-e101", center: { x: 240, y: 360 } },
      { type: "place_viewport", viewportId: "vp-e101-enl", sheetId: "sh-e101", viewId: "v-e102", center: { x: 560, y: 420 } },
      { type: "place_viewport", viewportId: "vp-e101-lp1", sheetId: "sh-e101", viewId: "v-sch-lp1", center: { x: 640, y: 200 } },

      // Sheet E201: Lighting Plan / RCP + Controls Schematic Plan + Lighting Fixture Schedule + Lighting Controls Schedule
      { type: "create_sheet", sheetId: "sh-e201", number: "E201", name: "Lighting Plan, Controls & Schedules" },
      { type: "place_viewport", viewportId: "vp-e201-rcp", sheetId: "sh-e201", viewId: "v-e103", center: { x: 240, y: 420 } },
      { type: "place_viewport", viewportId: "vp-e201-ctl", sheetId: "sh-e201", viewId: "v-e104", center: { x: 240, y: 180 } },
      ...(lightingScheduleDef ? [{ type: "place_viewport" as const, viewportId: "vp-e201-lfx", sheetId: "sh-e201", viewId: "v-sch-lfx", center: { x: 620, y: 420 } }] : []),
      { type: "place_viewport", viewportId: "vp-e201-lct", sheetId: "sh-e201", viewId: "v-sch-lctrl", center: { x: 620, y: 200 } },

      // Sheet E501: Live One-Line Diagram + Live Lighting Controls Diagram + Switchboard MDP Schedule + Panel HP-1 Schedule
      { type: "create_sheet", sheetId: "sh-e501", number: "E501", name: "Electrical One-Line, Controls Diagram & Distribution" },
      { type: "place_viewport", viewportId: "vp-e501-sld", sheetId: "sh-e501", viewId: "v-diag-sld", center: { x: 230, y: 400 } },
      { type: "place_viewport", viewportId: "vp-e501-ctd", sheetId: "sh-e501", viewId: "v-diag-ctrl", center: { x: 230, y: 160 } },
      { type: "place_viewport", viewportId: "vp-e501-mdp", sheetId: "sh-e501", viewId: "v-sch-mdp", center: { x: 610, y: 420 } },
      { type: "place_viewport", viewportId: "vp-e501-hp1", sheetId: "sh-e501", viewId: "v-sch-hp1", center: { x: 610, y: 190 } },
    ];
    for (const step of sheetCmds) run(step);

    // Pack each sheet cleanly inside its drawing area, then nudge viewports slightly down (+14 mm) so schedule headers never crowd the top sheet border.
    for (const sheetId of ["sh-e101", "sh-e201", "sh-e501"]) {
      const packed = sheetLayoutCommand(m, sheetId, { mode: "pack", gapMm: 16 });
      if (packed.command) run(packed.command);
      for (const move of packed.layout.moves) {
        run({ type: "move_viewport", viewportId: move.viewportId, center: { x: move.center.x, y: move.center.y + 14 } });
      }
    }

    return m;
  });
}
