import { DEFAULT_SETTINGS, asRevision, commandSchema, elementsOfKind, executeCommand, withUpgradePolicy, type ModelState } from "@permitzip/bim-kernel";
import { DEFAULT_LINT_CONFIG, LintEngine } from "@permitzip/bim-lint";
import { ELECTRICAL_LINT_RULES, deriveCircuitGraphics, electricalDiagramGraph, electricalStarterTypes, previewWireCurve } from "../src";

function emptyModel(id: string): ModelState {
  return { modelId: id, revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS };
}

function run(model: ModelState, raw: Record<string, unknown>): ModelState {
  const res = withUpgradePolicy(() => true, () => executeCommand(model, commandSchema.parse(raw)));
  if (!res.ok) throw new Error(`Command ${String(raw.type)} failed: ${res.error.message}`);
  return res.model;
}

describe("Nov 24 huddle electrical features", () => {
  it("provides floor-hosted floor boxes (duplex and quad) and clean wall-hosted quad receptacles", () => {
    const types = electricalStarterTypes("1.0.0");
    const floorDuplex = types.find((t) => t.id === "builtin:floor-receptacle@1");
    const floorQuad = types.find((t) => t.id === "builtin:floor-receptacle-quad@1");
    const wallQuad = types.find((t) => t.id === "builtin:quad-receptacle@1");

    expect(floorDuplex?.definition.hosting).toBe("floor");
    expect(floorQuad?.definition.hosting).toBe("floor");
    expect(wallQuad?.definition.hosting).toBe("wall_face");
    expect(floorQuad?.definition.instanceParams.find((p) => p.name === "load")?.default).toBe(360);
    // Floor boxes sit flush at the slab (top z <= 5 mm), not vertical wall plates.
    for (const g of floorDuplex?.definition.geometry ?? []) {
      if (g.kind === "box" && typeof g.center[2] === "number" && typeof g.size[2] === "number") {
        expect(g.center[2] + g.size[2] / 2).toBeLessThanOrEqual(5);
      }
    }
  });

  it("filters one-line diagram loads by minLoadRatingA and equipment by phaseScope", () => {
    let model = emptyModel("m-sld");
    model = run(model, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    const types = electricalStarterTypes("1.0.0");
    const panelDef = types.find((t) => t.id === "builtin:panelboard-225-mcb@1")!.definition;
    const rtuDef = {
      familyName: "Rooftop unit",
      typeName: "RTU",
      category: "mechanical_equipment",
      typeParams: [],
      typeValues: {},
      instanceParams: [],
      connectors: [
        {
          id: "power",
          label: "Power",
          domain: "electrical",
          systemKind: "power",
          position: [0, 0, 0],
          direction: [0, 0, -1],
          shape: "none",
          voltage: 208,
          poles: 3,
          flow: 10000,
        },
      ],
      geometry: [{ kind: "box", center: [0, 0, 500], size: [1000, 1000, 1000] }],
      symbol: [{ kind: "rect", center: [0, 0], size: [1000, 1000], pen: "medium" }],
      tagFields: ["mark"],
      source: { kind: "builtin", libraryVersion: "1.0.0" },
    };
    model = run(model, { type: "place_part", partId: "mdp", typeId: "pt-panel", partType: panelDef, position: { x: 0, y: 0 }, levelId: "lvl-1", mark: "MDP" });
    model = run(model, { type: "place_part", partId: "rtu-small", typeId: "pt-rtu", partType: rtuDef, position: { x: 2000, y: 0 }, levelId: "lvl-1", mark: "RTU-30A" });
    model = run(model, { type: "place_part", partId: "rtu-big", typeId: "pt-rtu", position: { x: 4000, y: 0 }, levelId: "lvl-1", mark: "RTU-80A" });

    model = run(model, {
      type: "create_service_link",
      linkId: "lnk-30",
      sourceId: "mdp",
      positions: [1, 3, 5],
      members: [{ elementId: "rtu-small" }],
      electrical: { ratingA: 30 },
    });
    model = run(model, {
      type: "create_service_link",
      linkId: "lnk-80",
      sourceId: "mdp",
      positions: [2, 4, 6],
      members: [{ elementId: "rtu-big" }],
      electrical: { ratingA: 80 },
    });

    // Without minLoadRatingA, both 30A and 80A loads appear when showLoads is true.
    const full = electricalDiagramGraph(model.elements, { showLoads: true });
    expect(full.roots[0]?.children.map((c) => c.elementId).sort()).toEqual(["rtu-big", "rtu-small"]);

    // With minLoadRatingA: 60, only the 80A unit appears (30A is hidden).
    const filtered = electricalDiagramGraph(model.elements, { showLoads: true, minLoadRatingA: 60 });
    expect(filtered.roots[0]?.children.map((c) => c.elementId)).toEqual(["rtu-big"]);

    // Per-equipment includeEquipmentIds pins a <60A unit onto the diagram, and excludeEquipmentIds hides a >=60A unit.
    const overridden = electricalDiagramGraph(model.elements, {
      showLoads: true,
      minLoadRatingA: 60,
      includeEquipmentIds: ["rtu-small"],
      excludeEquipmentIds: ["rtu-big"],
    });
    expect(overridden.roots[0]?.children.map((c) => c.elementId)).toEqual(["rtu-small"]);

    // Mark MDP as existing and rtu-small as existing + demolished; rtu-big is new work.
    model = run(model, { type: "set_element_phases", ids: ["mdp", "rtu-small"], phaseCreated: "phase-existing" });
    model = run(model, { type: "demolish_elements", ids: ["rtu-small"] });

    // New work scope hides demolished equipment.
    const newGraph = electricalDiagramGraph(model.elements, { showLoads: true, phaseScope: "new" });
    expect(newGraph.roots[0]?.children.map((c) => c.elementId)).toEqual(["rtu-big"]);

    // Demolition scope shows existing/demolished equipment and marks demolished items.
    const demoGraph = electricalDiagramGraph(model.elements, { showLoads: true, phaseScope: "demolition" });
    expect(demoGraph.roots[0]?.children.map((c) => c.elementId)).toEqual(["rtu-small"]);
    expect(demoGraph.roots[0]?.children[0]?.lines.some((l) => l.text.includes("DEMOLISHED"))).toBe(true);
  });

  it("uses single-circle 4-blade ANSI quad, upright 240V/TL masks, and curved flex whip on hardwired J-box", () => {
    const types = electricalStarterTypes("1.0.0");
    const wallQuad = types.find((t) => t.id === "builtin:quad-receptacle@1");
    const r240 = types.find((t) => t.id === "builtin:receptacle-nema-6-20r@1");
    const tl = types.find((t) => t.id === "builtin:receptacle-twist-lock@1");
    const hw = types.find((t) => t.id === "builtin:hardwired-connection@1");

    const quadPrims = wallQuad?.definition.symbol ?? [];
    expect(quadPrims.filter((p) => p.kind === "circle")).toHaveLength(1);
    expect(quadPrims.filter((p) => p.kind === "line").length).toBeGreaterThanOrEqual(4);

    const r240Text = r240?.definition.symbol?.find((p) => p.kind === "text");
    expect(r240Text && "uprightOffset" in r240Text && r240Text.mask).toBe(true);

    const tlText = tl?.definition.symbol?.find((p) => p.kind === "text");
    expect(tlText && "uprightOffset" in tlText && tlText.mask).toBe(true);

    const hwPrims = hw?.definition.symbol ?? [];
    expect(hwPrims.some((p) => p.kind === "polyline" && p.points.length >= 6)).toBe(true);
  });

  it("flags remote HVAC equipment missing a local disconnect (NEC 440.14) and traverses disconnects on One-Line", () => {
    let model = emptyModel("disc-lint-test");
    model = run(model, { type: "create_level", levelId: "l1", name: "Level 1", elevationMm: 0 });
    model = run(model, { type: "create_level", levelId: "roof", name: "Roof", elevationMm: 4000 });
    const types = electricalStarterTypes("1.0.0");
    const panelDef = types.find((t) => t.id === "builtin:panelboard-225-480@1")!.definition;
    const discDef = types.find((t) => t.id === "builtin:disconnect-nf-30-480@1")!.definition;
    const rtuDef = {
      familyName: "Rooftop unit",
      typeName: "RTU",
      category: "mechanical_equipment",
      typeParams: [],
      typeValues: {},
      instanceParams: [],
      connectors: [
        {
          id: "power",
          label: "Power",
          domain: "electrical",
          systemKind: "power",
          position: [0, 0, 0],
          direction: [0, 0, -1],
          shape: "none",
          voltage: 480,
          poles: 3,
          flow: 14000,
        },
      ],
      geometry: [{ kind: "box", center: [0, 0, 500], size: [1000, 1000, 1000] }],
      symbol: [{ kind: "rect", center: [0, 0], size: [1000, 1000], pen: "medium" }],
      tagFields: ["mark"],
      source: { kind: "builtin", libraryVersion: "1.0.0" },
    };
    model = run(model, { type: "place_part", partId: "hp-1", typeId: "pt-panel", partType: panelDef, levelId: "l1", position: { x: 0, y: 0 }, mark: "HP-1" });
    model = run(model, { type: "place_part", partId: "rtu-1", typeId: "pt-rtu", partType: rtuDef, levelId: "roof", position: { x: 20000, y: 0 }, mark: "RTU-1" });
    model = run(model, {
      type: "create_service_link",
      linkId: "ckt-direct",
      sourceId: "hp-1",
      positions: [1, 3, 5],
      members: [{ elementId: "rtu-1" }],
      electrical: { ratingA: 40 },
    });

    const rule = ELECTRICAL_LINT_RULES.find((r) => r.id === "equipment-missing-disconnect");
    expect(rule).toBeDefined();

    // Direct panel->RTU feed across levels triggers NEC 440.14 warning.
    const check = (m: ModelState) => {
      const engine = new LintEngine([...ELECTRICAL_LINT_RULES]);
      engine.build(m, []);
      return engine.check({ config: DEFAULT_LINT_CONFIG }).filter((f) => f.rule === "equipment-missing-disconnect");
    };
    expect(check(model).some((f) => f.elementIds.includes("rtu-1"))).toBe(true);

    // Insert local disconnect on the roof and re-circuit HP-1 -> SD-RTU-1 -> RTU-1.
    model = run(model, { type: "place_part", partId: "sd-rtu-1", typeId: "pt-disc", partType: discDef, levelId: "roof", position: { x: 19000, y: 0 }, mark: "SD-RTU-1" });
    model = run(model, { type: "delete_elements", ids: ["ckt-direct"], policy: "cascade" });
    model = run(model, {
      type: "create_service_link",
      linkId: "ckt-to-disc",
      sourceId: "hp-1",
      positions: [1, 3, 5],
      members: [{ elementId: "sd-rtu-1" }],
      electrical: { ratingA: 40 },
    });
    model = run(model, {
      type: "create_service_link",
      linkId: "ckt-to-rtu",
      sourceId: "sd-rtu-1",
      members: [{ elementId: "rtu-1" }],
      electrical: { ratingA: 40 },
    });

    // Warning clears once fed through local disconnect.
    expect(check(model).some((f) => f.elementIds.includes("rtu-1"))).toBe(false);

    // One-Line Diagram traverses HP-1 -> SD-RTU-1 -> RTU-1.
    const graph = electricalDiagramGraph(model.elements, { showLoads: true });
    const discNode = graph.roots[0]?.children.find((c) => c.elementId === "sd-rtu-1");
    expect(discNode?.children.map((c) => c.elementId)).toEqual(["rtu-1"]);
  });

  it("steps aligned wall-mounted receptacle wires outward into the room with smooth fillets", () => {
    let model = emptyModel("wall-fillet-test");
    model = run(model, { type: "create_level", levelId: "l1", name: "Level 1", elevationMm: 0 });
    const types = electricalStarterTypes("1.0.0");
    const panelDef = types.find((t) => t.id === "builtin:panelboard-225-mcb@1")!.definition;
    const dupDef = types.find((t) => t.id === "builtin:gfci-receptacle@1")!.definition;
    model = run(model, {
      type: "add_architecture",
      levelId: "l1",
      walls: [{ wallId: "w-west", start: { x: 0, y: 0 }, end: { x: 0, y: 8000 }, thicknessMm: 150, heightMm: 3000 }],
    });
    model = run(model, { type: "place_part", partId: "lp-1", typeId: "pt-panel", partType: panelDef, levelId: "l1", position: { x: 5000, y: 4000 }, mark: "LP-1" });
    // Two receptacles mounted along the east face of w-west (facing +X into the room, rotationDeg: 270 -> +Y normal is +X).
    model = run(model, {
      type: "place_part",
      partId: "r-1",
      typeId: "pt-dup",
      partType: dupDef,
      levelId: "l1",
      position: { x: 75, y: 2000 },
      offsetMm: 450,
      rotationDeg: 270,
      host: { kind: "wall_face", elementId: "w-west", side: -1, stationMm: 2000 },
    });
    model = run(model, {
      type: "place_part",
      partId: "r-2",
      typeId: "pt-dup",
      levelId: "l1",
      position: { x: 75, y: 4000 },
      offsetMm: 450,
      rotationDeg: 270,
      host: { kind: "wall_face", elementId: "w-west", side: -1, stationMm: 4000 },
    });
    model = run(model, {
      type: "create_service_link",
      linkId: "ckt-1",
      sourceId: "lp-1",
      positions: [1],
      members: [{ elementId: "r-1" }, { elementId: "r-2" }],
      electrical: { ratingA: 20 },
    });
    const shown = new Map(elementsOfKind(model.elements, "part").map((p) => [p.id, p]));
    const graphics = deriveCircuitGraphics(
      model,
      {
        id: "v-1",
        kind: "view",
        name: "Power",
        viewType: "floor_plan",
        props: {
          discipline: "electrical",
          circuitGraphics: { style: "chamfered", hashMarksOn: "home_runs" },
        },
      } as never,
      shown,
      48,
    );
    // At least one branch wire connects r-1 and r-2, stepping into +X (> 75 mm) with multi-point rounded arc fillets.
    const branch = graphics.find((g) => g.paths.length > 0)?.paths[0];
    expect(branch).toBeDefined();
    expect(branch!.some((p) => p.x > 150)).toBe(true);
    expect(branch!.length).toBeGreaterThan(4);
  });

  it("renders chamfered style on lighting switch legs and matches chamfered preview geometry during interactive drag", () => {
    let model = emptyModel("m-chamfer-ctrl");
    model = run(model, { type: "create_level", levelId: "l1", name: "Level 1", elevationMm: 0 });
    const types = electricalStarterTypes("1.0.0");
    const sw = types.find((t) => t.id === "builtin:switch-dimmer@1")!;
    const fix = types.find((t) => t.id === "builtin:troffer-2x4-led@1") ?? types.find((t) => t.definition.category === "lighting_fixture")!;
    model = run(model, { type: "save_part_types", types: [{ typeId: sw.id, definition: sw.definition }, { typeId: fix.id, definition: fix.definition }] });
    model = run(model, { type: "place_part", partId: "sw-1", typeId: sw.id, levelId: "l1", position: { x: 1000, y: 1000 }, mark: "SW-1", values: { switch_leg: "a" } });
    model = run(model, { type: "place_part", partId: "lt-1", typeId: fix.id, levelId: "l1", position: { x: 4000, y: 3000 }, mark: "F1", values: { switch_leg: "a" } });

    const shown = new Map(elementsOfKind(model.elements, "part").map((p) => [p.id, p]));
    const graphics = deriveCircuitGraphics(
      model,
      {
        id: "v-ctrl",
        kind: "view",
        name: "Controls",
        viewType: "ceiling_plan",
        props: {
          discipline: "electrical",
          circuitGraphics: { style: "chamfered", showCircuits: false, switchLegs: true },
        },
      } as never,
      shown,
      64,
    );
    const swGraphic = graphics.find((g) => g.kind === "switch_leg");
    expect(swGraphic).toBeDefined();
    expect(swGraphic!.dashed).toBe(true);
    const swPath = swGraphic!.paths[0]!;
    // Chamfered orthogonal + rounded corner path has a straight horizontal or vertical run segment (unlike a continuous arc).
    let hasOrthoSeg = false;
    for (let i = 1; i < swPath.length; i++) {
      const dx = Math.abs(swPath[i]!.x - swPath[i - 1]!.x);
      const dy = Math.abs(swPath[i]!.y - swPath[i - 1]!.y);
      if ((dx > 200 && dy < 1) || (dy > 200 && dx < 1)) hasOrthoSeg = true;
    }
    expect(hasOrthoSeg).toBe(true);

    // Interactive drag preview in `chamfered` mode produces orthogonal segments + rounded corners, not a spline.
    const chamferPreview = previewWireCurve({ x: 0, y: 0 }, [{ x: 30, y: 20 }], { x: 60, y: 0 }, "chamfered");
    const arcPreview = previewWireCurve({ x: 0, y: 0 }, [{ x: 30, y: 20 }], { x: 60, y: 0 }, "arcs");
    expect(chamferPreview).not.toEqual(arcPreview);
    expect(chamferPreview.some((p, i) => i > 0 && Math.abs(p.y - chamferPreview[i - 1]!.y) < 0.01 && Math.abs(p.x - chamferPreview[i - 1]!.x) > 10)).toBe(true);
  });

  it("omits expensive feeder kVA load tags by default and includes them when showFeederLoads is enabled", () => {
    let model = emptyModel("m-feeder-loads");
    model = run(model, { type: "create_level", levelId: "l1", name: "Level 1", elevationMm: 0 });
    const types = electricalStarterTypes("1.0.0");
    const panelDef = types.find((t) => t.id === "builtin:panelboard-225-mcb@1")!.definition;
    const recDef = types.find((t) => t.id === "builtin:gfci-receptacle@1")!.definition;
    model = run(model, { type: "place_part", partId: "mdp", typeId: "pt-mdp", partType: panelDef, levelId: "l1", position: { x: 0, y: 0 }, mark: "MDP" });
    model = run(model, { type: "place_part", partId: "lp1", typeId: "pt-lp1", partType: panelDef, levelId: "l1", position: { x: 5000, y: 0 }, mark: "LP-1" });
    model = run(model, { type: "place_part", partId: "r1", typeId: "pt-rec", partType: recDef, levelId: "l1", position: { x: 8000, y: 0 }, mark: "R1" });
    model = run(model, { type: "create_service_link", linkId: "f-lp1", sourceId: "mdp", members: [{ elementId: "lp1" }], electrical: { ratingA: 225 } });
    model = run(model, { type: "create_service_link", linkId: "c-r1", sourceId: "lp1", positions: [1], members: [{ elementId: "r1" }], electrical: { ratingA: 20 } });

    const defaultGraph = electricalDiagramGraph(model.elements);
    expect(defaultGraph.roots[0]?.children[0]?.feed?.load).toBeUndefined();

    const withLoads = electricalDiagramGraph(model.elements, { showFeederLoads: true });
    expect(withLoads.roots[0]?.children[0]?.feed?.load).toMatch(/kVA (DEM|CONN)/);
  });
});
