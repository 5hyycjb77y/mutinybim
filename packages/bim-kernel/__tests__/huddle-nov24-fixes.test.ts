import {
  DEFAULT_SETTINGS,
  VIEW_HIDDEN_ELEMENTS_FEATURE,
  ORGANIZATION_ELEMENT_LOCKS_FEATURE,
  DIAGRAM_FILTERS_FEATURE,
  asElementId,
  asRevision,
  buildViewPickIndex,
  commandSchema,
  drawPartClearancesBatch,
  drawView,
  elementLook,
  elementViewCategory,
  executeCommand,
  leaderStart,
  layoutDraft,
  organizationOf,
  partClearances,
  planViewRangeExcludes,
  visiblePlanParts,
  withUpgradePolicy,
  type ModelState,
  type PartTypeDefinition,
  type TextBlock,
  type Vec2,
  type ViewElement,
} from "../src";

function emptyModel(id: string): ModelState {
  return { modelId: id, revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS };
}

function run(model: ModelState, raw: Record<string, unknown>): ModelState {
  const res = executeCommand(model, commandSchema.parse(raw));
  if (!res.ok) throw new Error(`Command ${String(raw.type)} failed: ${res.error.message}`);
  return res.model;
}

function makePartType(overrides: Partial<PartTypeDefinition> = {}): PartTypeDefinition {
  return {
    familyName: "Test Part",
    typeName: "Default",
    category: "mechanical_equipment",
    typeParams: [],
    typeValues: {},
    instanceParams: [],
    connectors: [],
    geometry: [{ kind: "box", center: [0, 0, 500], size: [1000, 1000, 1000] }],
    symbol: [{ kind: "rect", center: [0, 0], size: [1000, 1000], pen: "medium" }],
    tagFields: ["mark"],
    source: { kind: "builtin", libraryVersion: "1.0.0" },
    ...overrides,
  };
}

describe("Nov 24 huddle kernel fixes", () => {
  it("classifies custom structural parts by classId lineage as structure rather than equipment", () => {
    let model = emptyModel("m1");
    model = run(model, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    model = run(model, {
      type: "place_part",
      partId: "col-1",
      typeId: "pt-col",
      partType: makePartType({ familyName: "PEMB Column", typeName: "W14x43", category: "mechanical_equipment" }),
      position: { x: 0, y: 0 },
      levelId: "lvl-1",
      mark: "COL-1",
    });
    // Tag the part instance with a structural classId (as PEMB / custom structural scripts do).
    const colEl = model.elements["col-1"]!;
    const stampedModel: ModelState = {
      ...model,
      elements: {
        ...model.elements,
        "col-1": { ...colEl, classId: "structural_column" } as typeof colEl,
      },
    };
    const cat = elementViewCategory(stampedModel.elements, stampedModel.elements["col-1"]!);
    expect(cat).toBe("structure");

    // Hiding equipment in a view must keep the structural part visible.
    const view: ViewElement = {
      id: asElementId("v-mech"),
      kind: "view",
      version: 1,
      authoredRev: {},
      name: "Level 1 Mechanical",
      viewType: "floor_plan",
      cropMin: { x: -5000, y: -5000 },
      cropMax: { x: 5000, y: 5000 },
      props: { level: "Level 1", hiddenCategories: ["equipment"] },
    };
    expect(elementLook(stampedModel, view, stampedModel.elements["col-1"]!).visible).toBe(true);
  });

  it("hides individual elements per view via hiddenElementIds in drawing, visiblePlanParts, and 2D picking", () => {
    let model = emptyModel("m2");
    model = run(model, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    const pt = makePartType();
    model = run(model, { type: "place_part", partId: "eq-1", typeId: "pt-eq", partType: pt, position: { x: 1000, y: 1000 }, levelId: "lvl-1", mark: "EQ-1" });
    model = run(model, { type: "place_part", partId: "eq-2", typeId: "pt-eq", position: { x: 4000, y: 1000 }, levelId: "lvl-1", mark: "EQ-2" });
    model = run(model, { type: "create_view", viewId: "v-plan", name: "Plan", viewType: "floor_plan", props: { level: "Level 1" } });

    // Refuses when peer lacks VIEW_HIDDEN_ELEMENTS_FEATURE.
    const refused = withUpgradePolicy(() => false, () =>
      executeCommand(model, commandSchema.parse({ type: "set_view_properties", viewId: "v-plan", props: { hiddenElementIds: ["eq-1"] } })),
    );
    expect(refused.ok).toBe(false);

    // Succeeds when peer supports VIEW_HIDDEN_ELEMENTS_FEATURE.
    model = withUpgradePolicy((f) => f === VIEW_HIDDEN_ELEMENTS_FEATURE, () =>
      run(model, { type: "set_view_properties", viewId: "v-plan", props: { hiddenElementIds: ["eq-1", "eq-1"] } }),
    );
    const view = model.elements["v-plan"] as ViewElement;
    expect(view.props?.hiddenElementIds).toEqual(["eq-1"]);

    expect(elementLook(model, view, model.elements["eq-1"]!).visible).toBe(false);
    expect(elementLook(model, view, model.elements["eq-2"]!).visible).toBe(true);

    const visibleParts = visiblePlanParts(model, view);
    expect(visibleParts.has("eq-1")).toBe(false);
    expect(visibleParts.has("eq-2")).toBe(true);

    const pickIdx = buildViewPickIndex(model, view);
    expect(pickIdx.footprints.has("eq-1")).toBe(false);
    expect(pickIdx.footprints.has("eq-2")).toBe(true);
  });

  it("clips elevated rooftop parts out of Level 1 plan view range (including elevated parts and 2D pick index)", () => {
    let model = emptyModel("m3");
    model = run(model, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    const pt = makePartType();
    model = run(model, {
      type: "place_part",
      partId: "rtu-1",
      typeId: "pt-rtu",
      partType: pt,
      position: { x: 2000, y: 2000 },
      levelId: "lvl-1",
      offsetMm: 4877, // 16 ft above Level 1
      mark: "RTU-1",
    });
    model = run(model, {
      type: "place_part",
      partId: "ahu-1",
      typeId: "pt-rtu",
      position: { x: 5000, y: 2000 },
      levelId: "lvl-1",
      offsetMm: 0,
      mark: "AHU-1",
    });
    model = run(model, {
      type: "create_view",
      viewId: "v-l1",
      name: "Level 1 Mechanical",
      viewType: "floor_plan",
      props: { level: "Level 1", viewTopMm: 3048 }, // 10 ft top clip
    });
    const view = model.elements["v-l1"] as ViewElement;
    const shown = visiblePlanParts(model, view);
    expect(shown.has("rtu-1")).toBe(false);
    expect(shown.has("ahu-1")).toBe(true);

    const pickIdx = buildViewPickIndex(model, view);
    expect(pickIdx.footprints.has("rtu-1")).toBe(false);
    expect(pickIdx.footprints.has("ahu-1")).toBe(true);
  });

  it("keeps detail-view callout notes visible when their leader points into the view window", () => {
    let model = emptyModel("m4");
    model = run(model, {
      type: "create_view",
      viewId: "v-det",
      name: "Exhaust Detail",
      viewType: "detail",
      props: { scale: 12, cropView: true },
    });
    model = run(model, {
      type: "set_view_crop",
      viewId: "v-det",
      crop: { min: { x: 0, y: 0 }, max: { x: 500, y: 500 } },
    });
    model = run(model, {
      type: "create_text_note",
      itemId: "note-1",
      ownerId: "v-det",
      at: { x: 650, y: 250 }, // Outside crop right edge, but leader points inside (250, 250)
      width: 40,
      paragraphs: [{ runs: [{ text: "EXHAUST FAN DUCT" }] }],
      leaders: [{ to: { x: 250, y: 250 }, arrow: "arrow" }],
    });
    const view = model.elements["v-det"] as ViewElement;
    const prims: Array<{ kind: string; text?: string }> = [];
    const blocks: TextBlock[] = [];
    drawView(prims as never, [], model, view, {
      center: { x: 100, y: 100 },
      size: { x: 100, y: 100 },
      modelCenter: { x: 250, y: 250 },
      scale: 12,
    }, [], blocks);
    expect(blocks.some((b) => b.itemId === "note-1")).toBe(true);
    expect(prims.some((pr) => pr.kind === "line")).toBe(true);
  });

  it("merges adjacent same-label clearance zones into one clean dashed boundary with one label", () => {
    const segs: Array<[Vec2, Vec2]> = [];
    const labels: string[] = [];
    const line = (a: Vec2, b: Vec2) => segs.push([a, b]);
    const text = (_at: Vec2, t: string) => labels.push(t);

    // Two side-by-side panels with touching 36" (914 mm) working space rectangles: [0..800, 0..914] and [800..1600, 0..914].
    drawPartClearancesBatch([
      {
        name: "Working space",
        corners: [
          { x: 0, y: 0 },
          { x: 800, y: 0 },
          { x: 800, y: 914 },
          { x: 0, y: 914 },
        ],
        line,
        text,
      },
      {
        name: "Working space",
        corners: [
          { x: 800, y: 0 },
          { x: 1600, y: 0 },
          { x: 1600, y: 914 },
          { x: 800, y: 914 },
        ],
        line,
        text,
      },
    ]);

    // Merged outer rectangle has exactly 4 boundary edges (no shared interior vertical seam at x = 800) and ONE label.
    expect(segs).toHaveLength(4);
    expect(labels.join(" ")).toContain("WORKING");
    expect(labels.filter((l) => l.includes("WORKING"))).toHaveLength(1);
  });

  it("auto-shifts a 30-inch working space away from a perpendicular corner wall while covering the full 20-inch panel", () => {
    withUpgradePolicy(() => true, () => {
      let model = emptyModel("m-corner");
      model = run(model, { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 });
      // West host wall (x=0, y=0..4000) and perpendicular South corner wall (y=0, x=0..4000), both 150 mm thick (inner face at y=75 mm)
      model = run(model, {
        type: "add_architecture",
        levelId: "L1",
        walls: [
          { wallId: "w-west", start: { x: 0, y: 0 }, end: { x: 0, y: 4000 }, thicknessMm: 150 },
          { wallId: "w-south", start: { x: 0, y: 0 }, end: { x: 4000, y: 0 }, thicknessMm: 150 },
        ],
      });
      model = run(model, {
        type: "save_part_types",
        types: [
          {
            typeId: "t-panel-20",
            definition: makePartType({
              familyName: "20in Panelboard",
              category: "electrical_equipment",
              geometry: [{ kind: "box", center: [0, 0, 600], size: [508, 150, 1200] }],
              clearances: [
                { id: "working_space", name: "NEC 110.26 WORKING SPACE", purpose: "working_space", face: "right", depth: 914, width: 762 },
              ],
            }),
          },
        ],
      });
      // Place 20" (508 mm) panel tight to south corner: center y=340 -> south edge y=86 (11 mm clear of w-south inner face y=75).
      // Centered 30" (762 mm) clearance would reach y=-41 (clipping into w-south); auto-shift slides it flush to y=75!
      model = run(model, {
        type: "place_part",
        partId: "p-corner",
        typeId: "t-panel-20",
        levelId: "L1",
        position: { x: 150, y: 340 },
        host: { kind: "wall_face", elementId: "w-west", stationMm: 340, side: -1 },
        mark: "LP-C",
      });

      const part = model.elements["p-corner"];
      if (part?.kind !== "part") throw new Error("expected part");
      const autoYs = partClearances(model, part)[0]!.corners.map((c) => c.y);
      const minY = Math.min(...autoYs);
      const maxY = Math.max(...autoYs);
      expect(minY).toBeGreaterThanOrEqual(74);
      expect(maxY - minY).toBeCloseTo(762, 0);
      expect(minY).toBeLessThanOrEqual(87);
      expect(maxY).toBeGreaterThanOrEqual(593);

      // Explicit manual offset overrides automatic wall-corner shifting
      model = run(model, {
        type: "set_part_clearances",
        id: "p-corner",
        scope: "instance",
        overrides: { working_space: { offset: 0 } },
      });
      const manualPart = model.elements["p-corner"];
      if (manualPart?.kind !== "part") throw new Error("expected part");
      const manualYs = partClearances(model, manualPart)[0]!.corners.map((c) => c.y);
      expect(Math.min(...manualYs)).toBeLessThan(0);
    });
  });

  it("attaches multi-line note leaders to the nearest line midpoint on either side", () => {
    const layout = layoutDraft(
      [{ runs: [{ text: "LINE ONE" }] }, { runs: [{ text: "LINE TWO" }] }, { runs: [{ text: "LINE THREE" }] }],
      { box: { width: 40, height: null, rotation: 0 }, lineSpacing: 1.2 },
      3,
    );
    const block: TextBlock = { itemId: "n1", origin: { x: 100, y: 50 }, rotation: 0, layout };
    const lastLine = layout.lines[layout.lines.length - 1]!;
    const lastMidY = 50 + lastLine.top + lastLine.height / 2;
    const startRight = leaderStart(block, { x: 150, y: lastMidY });
    expect(startRight.x).toBeCloseTo(140, 2);
    expect(startRight.y).toBeCloseTo(lastMidY, 2);

    const startLeft = leaderStart(block, { x: 90, y: lastMidY });
    expect(startLeft.x).toBeCloseTo(100, 2);
    expect(startLeft.y).toBeCloseTo(lastMidY, 2);
  });

  it("locks and unlocks individual elements and categories across the kernel command pipeline", () => {
    let model = emptyModel("m5");
    model = run(model, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    const pt = makePartType();
    model = run(model, { type: "place_part", partId: "p1", typeId: "pt-eq", partType: pt, position: { x: 0, y: 0 }, levelId: "lvl-1", mark: "PANEL A" });
    model = run(model, { type: "place_part", partId: "p2", typeId: "pt-eq", position: { x: 2000, y: 0 }, levelId: "lvl-1", mark: "PANEL B" });

    // Refuses when peer lacks ORGANIZATION_ELEMENT_LOCKS_FEATURE.
    const gatedRefusal = withUpgradePolicy(() => false, () =>
      executeCommand(model, commandSchema.parse({ type: "set_element_locks", ids: ["p1"], locked: true })),
    );
    expect(gatedRefusal.ok).toBe(false);

    // Lock single element p1.
    model = withUpgradePolicy((f) => f === ORGANIZATION_ELEMENT_LOCKS_FEATURE, () =>
      run(model, { type: "set_element_locks", ids: ["p1"], locked: true }),
    );
    expect(organizationOf(model).lockedElementIds.has("p1")).toBe(true);

    // Moving locked p1 is refused; moving unlocked p2 succeeds.
    const moveLocked = executeCommand(model, commandSchema.parse({ type: "move_elements", ids: ["p1"], delta: { x: 500, y: 0 } }));
    expect(moveLocked.ok).toBe(false);
    if (!moveLocked.ok) expect(moveLocked.error.message).toMatch(/PANEL A.*locked/i);

    model = run(model, { type: "move_elements", ids: ["p2"], delta: { x: 500, y: 0 } });

    // Unlock p1, then lock the entire "equipment" category.
    model = withUpgradePolicy((f) => f === ORGANIZATION_ELEMENT_LOCKS_FEATURE, () => {
      let next = run(model, { type: "set_element_locks", ids: ["p1"], locked: false });
      expect(organizationOf(next).lockedElementIds.has("p1")).toBe(false);
      next = run(next, { type: "lock_category", category: "equipment", locked: true });
      return next;
    });
    expect(organizationOf(model).lockedCategories.has("equipment")).toBe(true);

    const moveCatLocked = executeCommand(model, commandSchema.parse({ type: "move_elements", ids: ["p2"], delta: { x: 500, y: 0 } }));
    expect(moveCatLocked.ok).toBe(false);
    if (!moveCatLocked.ok) expect(moveCatLocked.error.message).toMatch(/locked category/i);

    // Unlock category and verify edits succeed again.
    model = withUpgradePolicy((f) => f === ORGANIZATION_ELEMENT_LOCKS_FEATURE, () =>
      run(model, { type: "lock_category", category: "equipment", locked: false }),
    );
    model = run(model, { type: "move_elements", ids: ["p2"], delta: { x: 500, y: 0 } });

    // Verify DIAGRAM_FILTERS_FEATURE gating on set_view_properties.
    model = run(model, { type: "create_view", viewId: "v-sld", name: "SLD", viewType: "detail", props: { diagram: { kind: "one_line" } } });
    const gatedDiag = withUpgradePolicy(() => false, () =>
      executeCommand(model, commandSchema.parse({ type: "set_view_properties", viewId: "v-sld", props: { diagram: { kind: "one_line", hints: { minLoadRatingA: 60 } } } })),
    );
    expect(gatedDiag.ok).toBe(false);
    model = withUpgradePolicy((f) => f === DIAGRAM_FILTERS_FEATURE, () =>
      run(model, { type: "set_view_properties", viewId: "v-sld", props: { diagram: { kind: "one_line", hints: { minLoadRatingA: 60, phaseScope: "demolition" } } } }),
    );
    expect((model.elements["v-sld"] as ViewElement).props?.diagram?.hints?.minLoadRatingA).toBe(60);
    expect((model.elements["v-sld"] as ViewElement).props?.diagram?.hints?.phaseScope).toBe("demolition");
  });

  it("supports Revit-standard level-relative view range (viewTopRef), browser grouping/sorting, and PartTypeDefinition.typeMark", () => {
    let model = emptyModel("m-view-range-typemark");
    model = run(model, { type: "create_level", levelId: "l1", name: "Level 1", elevationMm: 0 });
    model = run(model, { type: "create_level", levelId: "l2", name: "Level 2", elevationMm: 3658 }); // 12'-0"

    // Save a part type with a canonical Type Mark ("SD-1") and place two instances with empty per-instance marks.
    model = run(model, {
      type: "save_part_types",
      types: [
        {
          typeId: "test:diffuser-sd1@1",
          definition: {
            familyName: "Supply diffuser",
            typeName: '24x24, 8" neck',
            typeMark: "SD-1",
            category: "air_terminal",
            typeParams: [],
            typeValues: {},
            instanceParams: [],
            connectors: [],
            geometry: [{ kind: "box", center: [0, 0, 0], size: [600, 600, 150] }],
            symbol: [{ kind: "rect", center: [0, 0], size: [600, 600] }],
            tagFields: ["type_mark"],
            source: { kind: "builtin", libraryVersion: "1.0.0" },
          },
        },
      ],
    });
    model = run(model, { type: "place_part", partId: "d-1", typeId: "test:diffuser-sd1@1", levelId: "l1", position: { x: 1000, y: 1000 }, offsetMm: 3350, mark: "" });
    const ptEl = model.elements["test:diffuser-sd1@1"];
    expect(ptEl?.kind === "part_type" ? ptEl.definition.typeMark : null).toBe("SD-1");

    // View with viewTopRef: "level_above" reaches up to Level 2 (3658 mm), including elements at 3350 mm (11 ft).
    model = withUpgradePolicy(() => true, () =>
      run(model, {
        type: "create_view",
        viewId: "v-mech",
        name: "Level 1 — Mechanical",
        viewType: "floor_plan",
        props: {
          level: "Level 1",
          discipline: "mechanical",
          viewBottomMm: 0,
          cutHeightMm: 1219,
          viewTopRef: "level_above",
          browserGroup: "Mechanical",
          sortOrder: 400,
        },
      }),
    );
    const mechView = model.elements["v-mech"] as ViewElement;
    expect(mechView.props?.viewTopRef).toBe("level_above");
    expect(mechView.props?.browserGroup).toBe("Mechanical");
    expect(mechView.props?.sortOrder).toBe(400);

    // Part at 3350 mm is excluded if viewTopMm is 3048 mm (10 ft) associated_level, but INCLUDED under viewTopRef: "level_above" (3658 mm).
    const excludeAbove = planViewRangeExcludes(model, mechView);
    expect(excludeAbove?.(model.elements["d-1"]!)).toBe(false);
    const exclude10ft = planViewRangeExcludes(model, { viewType: "floor_plan", props: { level: "Level 1", viewBottomMm: 0, viewTopMm: 3048 } });
    expect(exclude10ft?.(model.elements["d-1"]!)).toBe(true);
  });
});
