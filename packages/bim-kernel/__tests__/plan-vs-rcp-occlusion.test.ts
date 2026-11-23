import {
  DEFAULT_SETTINGS,
  buildViewScene,
  planCommit,
  withUpgradePolicy,
  type Command,
  type ModelState,
  type PartTypeDefinition,
} from "../src";

let seq = 0;
function runAll(model: ModelState, cmds: readonly Command[]): ModelState {
  let cur = model;
  for (const cmd of cmds) {
    const res = withUpgradePolicy(
      () => true,
      () =>
        planCommit(
          cur,
          [],
          { idempotencyKey: `pr-${++seq}`, baseRevision: cur.revision, actor: { id: "tester", name: "Tester", kind: "human" }, command: cmd },
          () => "2026-11-22T00:00:00.000Z",
        ),
    );
    if (!res.ok) throw new Error(`${cmd.type}: ${res.error.code} — ${res.error.message}`);
    cur = res.model;
  }
  return cur;
}

const TEST_TERMINAL: PartTypeDefinition = {
  familyName: "Ceiling Diffuser",
  typeName: "Test 24x24 Ceiling Terminal",
  category: "air_terminal",
  typeParams: [],
  instanceParams: [],
  typeValues: {},
  connectors: [{ id: "neck", label: "Neck", domain: "duct", systemKind: "supply_air", shape: "round", position: [0, 0, 150], direction: [0, 0, 1], diameter: 200 }],
  geometry: [{ kind: "box", center: [0, 0, 75], size: [610, 610, 150] }],
  symbol: [
    { kind: "rect", center: [0, 0], size: [610, 610], fill: "mask", pen: "medium" },
    { kind: "line", from: [-305, -305], to: [305, 305], pen: "thin" },
    { kind: "line", from: [-305, 305], to: [305, -305], pen: "thin" },
  ],
  tagFields: ["mark"],
  source: { kind: "builtin", libraryVersion: "1.0.0" },
};

describe("Floor plan vs RCP hidden-line depth ordering (looking down vs looking up)", () => {
  test("overhead run occludes lower ceiling terminal in floor_plan, while ceiling terminal occludes overhead run in ceiling_plan", () => {
    let m: ModelState = { modelId: "m-depth", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    m = runAll(m, [
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      { type: "save_part_types", types: [{ typeId: "pt-term", definition: TEST_TERMINAL }] },
      // Ceiling terminal at 9'-6" (2896 mm, top 3046 mm) right at (3000, 3000)
      { type: "place_part", partId: "term-1", typeId: "pt-term", levelId: "L1", position: { x: 3000, y: 3000 }, offsetMm: 2896, mark: "SD-1" },
      // Overhead 16"x10" duct passing directly ABOVE the terminal at 10'-8" (3251 mm, 3124..3378 mm)
      {
        type: "route_run",
        idPrefix: "sa-over",
        levelId: "L1",
        domain: "duct",
        size: { shape: "rect", width: 406, height: 254 },
        elevationMm: 3251,
        system: { id: "sys-sa", kind: "supply_air", name: "Supply Air" },
        points: [
          { x: 1000, y: 3000 },
          { x: 5000, y: 3000 },
        ],
      },
      {
        type: "create_view",
        viewId: "v-floor",
        name: "L1 Floor Plan",
        viewType: "floor_plan",
        crop: { min: { x: 0, y: 0 }, max: { x: 6000, y: 6000 } },
        props: { level: "Level 1", scale: 48, visualStyle: "hidden_line" },
      },
      {
        type: "create_view",
        viewId: "v-rcp",
        name: "L1 RCP",
        viewType: "ceiling_plan",
        crop: { min: { x: 0, y: 0 }, max: { x: 6000, y: 6000 } },
        props: { level: "Level 1", scale: 48, visualStyle: "hidden_line" },
      },
    ]);

    const floorScene = buildViewScene(m, "v-floor");
    const rcpScene = buildViewScene(m, "v-rcp");
    expect(floorScene).not.toBeNull();
    expect(rcpScene).not.toBeNull();

    // In floor_plan (looking down), the terminal's white mask fill draws BEFORE the overhead duct lines
    // so the higher duct is never erased by the lower terminal.
    const floorPrims = floorScene!.scene.primitives;
    const floorMaskIdx = floorPrims.findIndex((p) => p.kind === "fill" && p.grey === 1);
    const floorLastLineIdx = floorPrims.reduce((acc, p, i) => (p.kind === "line" ? i : acc), -1);
    expect(floorMaskIdx).toBeGreaterThanOrEqual(0);
    expect(floorLastLineIdx).toBeGreaterThan(floorMaskIdx);

    // In ceiling_plan (looking up), the lower ceiling terminal is closer to the eye than the plenum duct,
    // so the terminal's white mask fill draws AFTER the overhead duct lines (occluding the plenum duct).
    const rcpPrims = rcpScene!.scene.primitives;
    const rcpFirstLineIdx = rcpPrims.findIndex((p) => p.kind === "line");
    const rcpMaskIdx = rcpPrims.reduce((acc, p, i) => (p.kind === "fill" && p.grey === 1 ? i : acc), -1);
    expect(rcpFirstLineIdx).toBeGreaterThanOrEqual(0);
    expect(rcpMaskIdx).toBeGreaterThan(rcpFirstLineIdx);
  });
});
