/** @jest-environment node */
import {
  ANNOTATION_TEXT_STYLES_FEATURE,
  DEFAULT_SETTINGS,
  ELEMENTS_CREATE_FEATURE,
  GEOMETRY_SOLID_PROGRAM_2_FEATURE,
  PARTS_WALL_FACE_HOST_FEATURE,
  VIEW_HASH_MARKS_FEATURE,
  VIEW_LINK_ROUTING_FEATURE,
  VIEW_SYMBOL_SCALE_FEATURE,
  buildViewPickIndex,
  buildViewScene,
  builtinPartType,
  drawPartSymbol,
  evaluateDiagram,
  evaluateFormSchedule,
  executeCommand,
  isPartModel2,
  isWallFaceMountable,
  nearestWallFace,
  partPlanOutline,
  pickAt,
  planAutoPartMarks,
  refreshBuiltinPartTypes,
  resolveTextStyle,
  sceneToSvg,
  tagLeaderTarget,
  wallFaceFrame,
  withUpgradePolicy,
  elbowLeaderPath,
  type Command,
  type ModelState,
  type PartInstance,
  type PartTypeElement,
  type Revision,
  type RunSegment,
  type ViewElement,
  type Wall,
} from "@permitzip/bim-kernel";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { building, defineScript, documents, equipment, parts, runScript, sliceModel, units } from "@permitzip/bim-script";
import {
  circuitHomeRunNear,
  circuitHomeRunsOnPaper,
  deriveCircuitGraphics,
  previewWireCurve,
  withCircuitFlipArc,
  withCircuitHomeRun,
  withCircuitWaypoints,
} from "../src/annotation/circuit-graphics";

installFirstPartyAddOns();

const FT = 304.8;
const ALL_TEST_FEATURES = [
  ELEMENTS_CREATE_FEATURE,
  GEOMETRY_SOLID_PROGRAM_2_FEATURE,
  PARTS_WALL_FACE_HOST_FEATURE,
  VIEW_SYMBOL_SCALE_FEATURE,
  ANNOTATION_TEXT_STYLES_FEATURE,
  VIEW_LINK_ROUTING_FEATURE,
  VIEW_HASH_MARKS_FEATURE,
];

function emptyModel(): ModelState {
  return { modelId: "wall-host-annotative", revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
}

function runCmds(m: ModelState, cmds: readonly Command[]): ModelState {
  let cur = m;
  return withUpgradePolicy(() => true, () => {
    for (const c of cmds) {
      const r = executeCommand(cur, c);
      if (!r.ok) throw new Error(`${c.type}: ${r.error.message}`);
      cur = { ...r.model, revision: (cur.revision + 1) as Revision };
    }
    return cur;
  });
}

describe("Revit-style wall-face hosting, hybrid minPaperMm symbols, view symbolScale, and built-in symbol refresh", () => {
  it("refuses wall_face hosts and view symbolScale when older peers do not advertise their protocol features", () => {
    const duplex = builtinPartType("builtin:duplex-receptacle@1")!;
    const base = runCmds(emptyModel(), [
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      { type: "add_architecture", levelId: "L1", walls: [{ wallId: "w1", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 }, thicknessMm: 200, heightMm: 3000 }], openings: [], casework: [], rooms: [] },
    ]);

    const refusedHost = withUpgradePolicy(() => false, () =>
      executeCommand(base, {
        type: "place_part",
        partId: "r1",
        typeId: duplex.id,
        partType: duplex.definition,
        levelId: "L1",
        position: { x: 0, y: 0 },
        host: { kind: "wall_face", elementId: "w1", stationMm: 2000, side: 1 },
      }),
    );
    expect(refusedHost.ok).toBe(false);

    const refusedScale = withUpgradePolicy(() => false, () =>
      executeCommand(base, {
        type: "create_view",
        viewId: "v1",
        name: "Plan",
        viewType: "floor_plan",
        props: { level: "Level 1", scale: 96, symbolScale: 1.5 },
      }),
    );
    expect(refusedScale.ok).toBe(false);
  });

  it("wall_face host snaps flush onto wall finish face, orients +Y into room, bows circuit arcs into the room, and follows wall moves", () => {
    const duplex = builtinPartType("builtin:duplex-receptacle@1")!;
    const panel = builtinPartType("builtin:panelboard-225@1")!;
    let m = runCmds(emptyModel(), [
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      {
        type: "add_architecture",
        levelId: "L1",
        walls: [
          { wallId: "w-south", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 }, thicknessMm: 200, heightMm: 3000 },
          { wallId: "w-north", start: { x: 0, y: 4000 }, end: { x: 6000, y: 4000 }, thicknessMm: 200, heightMm: 3000 },
        ],
        openings: [],
        casework: [],
        rooms: [],
      },
      {
        type: "place_part",
        partId: "lp-1",
        typeId: panel.id,
        partType: panel.definition,
        levelId: "L1",
        position: { x: 0, y: 0 },
        host: { kind: "wall_face", elementId: "w-south", stationMm: 500, side: 1 },
        mark: "LP-1",
        values: { panel_name: "LP-1" },
      },
      {
        type: "place_part",
        partId: "r-in",
        typeId: duplex.id,
        partType: duplex.definition,
        levelId: "L1",
        position: { x: 0, y: 0 },
        offsetMm: 457.2,
        host: { kind: "wall_face", elementId: "w-south", stationMm: 2000, side: 1 },
        mark: "R-1",
      },
      {
        type: "place_part",
        partId: "r-out",
        typeId: duplex.id,
        partType: duplex.definition,
        levelId: "L1",
        position: { x: 0, y: 0 },
        offsetMm: 457.2,
        host: { kind: "wall_face", elementId: "w-south", stationMm: 2000, side: -1 },
        mark: "R-2",
      },
      {
        type: "place_part",
        partId: "r-n1",
        typeId: duplex.id,
        partType: duplex.definition,
        levelId: "L1",
        position: { x: 0, y: 0 },
        offsetMm: 457.2,
        host: { kind: "wall_face", elementId: "w-north", stationMm: 1500, side: -1 },
        mark: "R-N1",
      },
      {
        type: "place_part",
        partId: "r-n2",
        typeId: duplex.id,
        partType: duplex.definition,
        levelId: "L1",
        position: { x: 0, y: 0 },
        offsetMm: 457.2,
        host: { kind: "wall_face", elementId: "w-north", stationMm: 4500, side: -1 },
        mark: "R-N2",
      },
      {
        type: "create_service_link",
        linkId: "ckt-1",
        sourceId: "lp-1",
        positions: [1],
        members: [{ elementId: "r-n1" }, { elementId: "r-n2" }],
      },
      {
        type: "create_view",
        viewId: "v-1",
        name: "E101",
        viewType: "floor_plan",
        crop: { min: { x: -500, y: -500 }, max: { x: 6500, y: 4500 } },
        props: { level: "Level 1", scale: 96, discipline: "electrical" },
      },
    ]);

    const rIn = m.elements["r-in"] as PartInstance;
    const rOut = m.elements["r-out"] as PartInstance;
    // Wall thickness 200 mm -> finish faces at y = +100 mm (side 1, rot 0) and y = -100 mm (side -1, rot 180).
    expect(rIn.position).toEqual({ x: 2000, y: 100 });
    expect(rIn.rotationDeg).toBe(0);
    expect(rOut.position).toEqual({ x: 2000, y: -100 });
    expect(rOut.rotationDeg).toBe(180);

    // Duplex symbol prongs sit flush at y = +100 and project into the room (+Y), NEVER inside the wall (-100..+100).
    const outIn = partPlanOutline(m, rIn, { scale: 96, detail: "medium" });
    expect(outIn.bounds!.min.y).toBeCloseTo(100, 1);
    expect(outIn.bounds!.max.y).toBeGreaterThan(100 + 3 * 96);

    // Circuit arc between north-wall receptacles bows SOUTH into the room (y < 3900 mm finish face), never into the wall!
    const v1 = m.elements["v-1"];
    expect(v1?.kind).toBe("view");
    const shown = new Map<string, PartInstance>();
    for (const el of Object.values(m.elements)) if (el.kind === "part") shown.set(el.id, el);
    if (v1?.kind === "view") {
      const graphics = deriveCircuitGraphics(m, v1, shown, 96, "medium");
      const ckt = graphics.find((g) => g.linkId === "ckt-1");
      expect(ckt).toBeDefined();
      for (const path of ckt!.paths) {
        for (const pt of path) expect(pt.y).toBeLessThan(3900 - 10);
      }
    }

    // Moving the south wall +500 mm in Y carries BOTH hosted receptacles flush with its new finish faces automatically!
    m = runCmds(m, [{ type: "move_elements", ids: ["w-south"], delta: { x: 0, y: 500 } }]);
    expect((m.elements["r-in"] as PartInstance).position).toEqual({ x: 2000, y: 600 });
    expect((m.elements["r-out"] as PartInstance).position).toEqual({ x: 2000, y: 400 });

    const frame = wallFaceFrame(m.elements["w-south"] as Wall, 2000, 1);
    expect(frame.position).toEqual({ x: 2000, y: 600 });
    const near = nearestWallFace(m, "L1", { x: 2500, y: 650 });
    expect(near?.wallId).toBe("w-south");
    expect(near?.side).toBe(1);
    expect(near?.position).toEqual({ x: 2500, y: 600 });
  });

  it("hybrid minPaperMm keeps model-sized symbols true 1:1 when large and clamps up uniformly when zoomed out", () => {
    const troffer = builtinPartType("builtin:troffer-2x4-led@1")!; // 4'x2' = 1219.2 x 609.6 mm, minPaperMm: 4
    const panel = builtinPartType("builtin:panelboard-225@1")!; // 20"x5.75" = 508 x 146.05 mm, minPaperMm: 4.5
    const duplex = builtinPartType("builtin:duplex-receptacle@1")!;

    const m = runCmds(emptyModel(), [
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      { type: "place_part", partId: "tr1", typeId: troffer.id, partType: troffer.definition, levelId: "L1", position: { x: 3000, y: 3000 }, mark: "F1" },
      { type: "place_part", partId: "lp1", typeId: panel.id, partType: panel.definition, levelId: "L1", position: { x: 0, y: 0 }, mark: "LP-1" },
      { type: "place_part", partId: "r1", typeId: duplex.id, partType: duplex.definition, levelId: "L1", position: { x: 1000, y: 0 }, mark: "R1" },
      { type: "create_view", viewId: "v-std", name: "1/8 Plan", viewType: "floor_plan", crop: { min: { x: -1000, y: -1000 }, max: { x: 5000, y: 5000 } }, props: { level: "Level 1", scale: 96, discipline: "electrical" } },
      { type: "create_view", viewId: "v-big", name: "1/8 Big Symbols", viewType: "floor_plan", crop: { min: { x: -1000, y: -1000 }, max: { x: 5000, y: 5000 } }, props: { level: "Level 1", scale: 96, symbolScale: 1.5, discipline: "electrical" } },
    ]);

    const tr = m.elements["tr1"] as PartInstance;
    const lp = m.elements["lp1"] as PartInstance;
    const rc = m.elements["r1"] as PartInstance;

    // At 1:96 (1/8"=1'-0"), 2x4 troffer is 12.7 mm on paper (> 4 mm) => exact 1:1 true model size (1219.2 x 609.6 mm)!
    const tr96 = partPlanOutline(m, tr, { scale: 96 });
    expect(tr96.bounds!.max.x - tr96.bounds!.min.x).toBeCloseTo(4 * FT, 1);
    expect(tr96.bounds!.max.y - tr96.bounds!.min.y).toBeCloseTo(2 * FT, 1);

    // At 1:500 (site/campus scale), natural 2x4 troffer would be 2.44 mm (< 4 mm) => clamps up to 4.0 mm on paper, preserving 2:1 aspect!
    const tr500 = partPlanOutline(m, tr, { scale: 500 });
    expect((tr500.bounds!.max.x - tr500.bounds!.min.x) / 500).toBeCloseTo(4.0, 2);
    expect((tr500.bounds!.max.y - tr500.bounds!.min.y) / 500).toBeCloseTo(2.0, 2);

    // Panelboard (508 mm wide, minPaperMm 4.5): exact model size at 1:96 (5.29 mm), clamped to 4.5 mm at 1:192 (1/16") with back face pinned at y = 0!
    const lp96 = partPlanOutline(m, lp, { scale: 96 });
    expect(lp96.bounds!.max.x - lp96.bounds!.min.x).toBeCloseTo(20 * 25.4, 1);
    const lp192 = partPlanOutline(m, lp, { scale: 192 });
    expect((lp192.bounds!.max.x - lp192.bounds!.min.x) / 192).toBeCloseTo(4.5, 2);
    expect(lp192.bounds!.min.y).toBeCloseTo(0, 2);

    // View `symbolScale: 1.5` scales paper-space receptacle by 1.5x while keeping model-size troffer at 1:96 untouched!
    const rcStd = partPlanOutline(m, rc, { scale: 96, symbolScale: 1 });
    const rcBig = partPlanOutline(m, rc, { scale: 96, symbolScale: 1.5 });
    const cStd = rcStd.outline.find((o) => o.kind === "circle")!;
    const cBig = rcBig.outline.find((o) => o.kind === "circle")!;
    expect(cStd.kind === "circle" && cBig.kind === "circle" && cBig.r / cStd.r).toBeCloseTo(1.5, 3);

    const trBig = partPlanOutline(m, tr, { scale: 96, symbolScale: 1.5 });
    expect(trBig.bounds!.max.x - trBig.bounds!.min.x).toBeCloseTo(4 * FT, 1);

    expect(buildViewScene(m, "v-std").scene.primitives.length).toBeGreaterThan(0);
    expect(buildViewScene(m, "v-big").scene.primitives.length).toBeGreaterThan(0);
  });

  it("refreshBuiltinPartTypes upgrades stale baked built-in symbols without touching custom types or placed instances", () => {
    const duplex = builtinPartType("builtin:duplex-receptacle@1")!;
    const legacyDuplex = {
      ...duplex.definition,
      symbol: [{ kind: "circle" as const, center: [0, 0] as [number, number], radius: 40 }],
    };
    const m = runCmds(emptyModel(), [
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      { type: "place_part", partId: "r1", typeId: duplex.id, partType: legacyDuplex, levelId: "L1", position: { x: 1000, y: 1000 }, mark: "R-OLD" },
    ]);

    const staleCircle = partPlanOutline(m, m.elements["r1"] as PartInstance, { scale: 96 }).outline.find((o) => o.kind === "circle");
    expect(staleCircle?.kind === "circle" && staleCircle.r).toBeCloseTo(40, 1);

    const refreshed = refreshBuiltinPartTypes(m);
    expect(refreshed.updated.map((u) => u.typeId)).toEqual(["builtin:duplex-receptacle@1"]);
    expect(refreshed.command).not.toBeNull();

    const upgraded = runCmds(m, [refreshed.command!]);
    const upgradedCircle = partPlanOutline(upgraded, upgraded.elements["r1"] as PartInstance, { scale: 96 }).outline.find((o) => o.kind === "circle");
    expect(upgradedCircle?.kind === "circle" && upgradedCircle.r / 96).toBeCloseTo(1.5, 2);
    expect((upgraded.elements["r1"] as PartInstance).mark).toBe("R-OLD");
    expect(refreshBuiltinPartTypes(upgraded).command).toBeNull();
  });

  it("unified @permitzip/bim-script APIs: onWall, hostOnWall, minPaperMm, symbolScale, and parts.refreshBuiltins work end-to-end", async () => {
    const partScript = defineScript({
      kind: "part",
      reads: {},
      parameters: {},
      run(ctx) {
        const b = parts.part("Wall sconce", { type: "6in LED", category: "lighting_fixture" });
        b.box({ length: units.in(6), width: units.in(6), height: units.in(10) });
        b.symbol(["coarse", "medium", "fine"], {
          units: "model",
          minPaperMm: 4,
          mask: true,
          shapes: [parts.rect(units.in(6), units.in(6))],
        });
        ctx.parts.define("acme.sconce.6", b.build());
      },
    });
    const partSlice = { ...sliceModel(emptyModel(), partScript.manifest.reads), features: ALL_TEST_FEATURES };
    const partRes = await runScript(partScript, { slice: partSlice, values: {}, scriptHash: "part-minpaper" });
    expect(partRes.kind).toBe("part_types");
    if (partRes.kind !== "part_types") throw new Error("expected part_types");
    const sconceModel = partRes.types[0]!.definition.model;
    expect(sconceModel !== undefined && isPartModel2(sconceModel)).toBe(true);
    if (sconceModel && isPartModel2(sconceModel)) {
      expect(sconceModel.symbols[0]?.minPaperMm).toBe(4);
    }

    const duplex = builtinPartType("builtin:duplex-receptacle@1")!;
    const legacyModel = runCmds(emptyModel(), [
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      { type: "save_part_types", label: "Seed sconce", types: [...partRes.types] },
      {
        type: "place_part",
        partId: "legacy-r",
        typeId: duplex.id,
        partType: { ...duplex.definition, symbol: [{ kind: "circle", center: [0, 0], radius: 35 }] },
        levelId: "L1",
        position: { x: 3 * FT, y: 0.5 * FT },
        mark: "R-LEGACY",
      },
    ]);

    const layoutScript = defineScript({
      kind: "layout",
      reads: { levels: true, kinds: ["part", "part_type", "wall"] },
      parameters: {},
      run(ctx) {
        const refreshed = parts.refreshBuiltins(ctx);
        ctx.report("refreshedCount", refreshed.length);

        const northWall = building.wall(ctx, { level: "L1", from: { x: units.ft(0), y: units.ft(12) }, to: { x: units.ft(20), y: units.ft(12) }, thickness: units.in(6) });
        const southWall = building.wall(ctx, { level: "L1", from: { x: units.ft(0), y: units.ft(0) }, to: { x: units.ft(20), y: units.ft(0) }, thickness: units.in(6) });

        const r1 = equipment.place(ctx, {
          level: "L1",
          type: "builtin:duplex-receptacle@1",
          onWall: { wall: northWall, along: units.ft(6), toward: { x: units.ft(6), y: units.ft(6) } },
          height: units.in(18),
          mark: "R-NORTH",
        });

        const r2 = equipment.place(ctx, {
          level: "L1",
          type: "builtin:switch-single-pole@1",
          at: { x: units.ft(12), y: units.ft(11.3) },
          onWall: "nearest",
          height: units.in(48),
          mark: "SW-1",
        });

        const sc = equipment.place(ctx, {
          level: "L1",
          type: "acme.sconce.6",
          onWall: { wall: southWall, along: units.ft(10), side: 1 },
          height: units.ft(7),
          mark: "SC-1",
        });

        equipment.hostOnWall(ctx, "legacy-r", "nearest");

        const viewId = documents.planView(ctx, { level: "L1", name: "E101", discipline: "electrical", scale: 96, symbolScale: 1.25 });
        documents.setView(ctx, viewId, { symbolScale: 1.5 });

        ctx.report("ids", { r1: r1.id, r2: r2.id, sc: sc.id, viewId });
      },
    });

    const layoutSlice = { ...sliceModel(legacyModel, layoutScript.manifest.reads), features: ALL_TEST_FEATURES };
    const out = await runScript(layoutScript, { slice: layoutSlice, values: {}, scriptHash: "layout-wall-host" });
    expect(out.kind).toBe("edits");
    if (out.kind !== "edits") throw new Error("expected edits");
    const finalModel = runCmds(legacyModel, out.batches);

    const pt = finalModel.elements["builtin:duplex-receptacle@1"] as PartTypeElement;
    expect(pt.definition.symbol.some((s) => s.units === "paper")).toBe(true);

    const idsReport = out.report!.find((r) => r.label === "ids")!.value as { r1: string; r2: string; sc: string; viewId: string };
    const r1 = finalModel.elements[idsReport.r1] as PartInstance;
    expect(r1.host?.kind).toBe("wall_face");
    expect(r1.position.x).toBeCloseTo(6 * FT, 1);
    expect(r1.position.y).toBeCloseTo(11.75 * FT, 1);
    expect(r1.rotationDeg).toBe(180);

    const r2 = finalModel.elements[idsReport.r2] as PartInstance;
    expect(r2.host?.kind).toBe("wall_face");
    expect(r2.position.y).toBeCloseTo(11.75 * FT, 1);
    expect(r2.rotationDeg).toBe(180);

    const rLeg = finalModel.elements["legacy-r"] as PartInstance;
    expect(rLeg.host?.kind).toBe("wall_face");
    expect(rLeg.position.y).toBeCloseTo(76.2, 1);
    expect(rLeg.rotationDeg).toBe(0);

    const sc = finalModel.elements[idsReport.sc] as PartInstance;
    const sc24 = partPlanOutline(finalModel, sc, { scale: 24 });
    expect(sc24.bounds!.max.x - sc24.bounds!.min.x).toBeCloseTo(6 * 25.4, 1);
    const sc96 = partPlanOutline(finalModel, sc, { scale: 96 });
    expect((sc96.bounds!.max.x - sc96.bounds!.min.x) / 96).toBeCloseTo(4.0, 2);

    const v = finalModel.elements[idsReport.viewId];
    expect(v?.kind === "view" && v.props?.symbolScale).toBe(1.5);
  });

  it("unifies Text Types (opaque background masking across marks, home runs, switch-leg letters & SVG), annotative plan picking, wall-face sliding, spline wires, movable home runs, and 0-10V switching", async () => {
    let m = runCmds(emptyModel(), [
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      {
        type: "add_architecture",
        levelId: "L1",
        walls: [
          { wallId: "w-south", start: { x: 0, y: 0 }, end: { x: 20 * FT, y: 0 }, thicknessMm: 152.4, heightMm: 3000 },
          { wallId: "w-north", start: { x: 0, y: 12 * FT }, end: { x: 20 * FT, y: 12 * FT }, thicknessMm: 152.4, heightMm: 3000 },
          { wallId: "w-west", start: { x: 0, y: 0 }, end: { x: 0, y: 12 * FT }, thicknessMm: 152.4, heightMm: 3000 },
          { wallId: "w-east", start: { x: 20 * FT, y: 0 }, end: { x: 20 * FT, y: 12 * FT }, thicknessMm: 152.4, heightMm: 3000 },
        ],
        openings: [],
        casework: [],
        rooms: [],
      },
    ]);
    const gfci = builtinPartType("builtin:gfci-receptacle@1")!;
    const sw3 = builtinPartType("builtin:switch-three-way@1")!;
    const swD = builtinPartType("builtin:switch-dimmer@1")!;
    const ctrlRec = builtinPartType("builtin:controlled-receptacle@1")!;
    const troffer = builtinPartType("builtin:troffer-2x4-led@1")!;
    const panel = builtinPartType("builtin:panelboard-225-mcb@1")!;

    m = runCmds(m, [
      {
        type: "save_part_types",
        types: [gfci, sw3, swD, ctrlRec, troffer, panel].map((t) => ({ typeId: t.id, definition: t.definition })),
      },
      { type: "place_part", partId: "pnl-1", typeId: panel.id, levelId: "L1", position: { x: 0, y: 0 }, host: { kind: "wall_face", elementId: "w-west", stationMm: 6 * FT, side: -1 }, mark: "LP-1" },
      { type: "place_part", partId: "r-1", typeId: gfci.id, levelId: "L1", position: { x: 0, y: 0 }, host: { kind: "wall_face", elementId: "w-north", stationMm: 5 * FT, side: -1 }, mark: "GFCI-1" },
      { type: "place_part", partId: "r-2", typeId: ctrlRec.id, levelId: "L1", position: { x: 0, y: 0 }, host: { kind: "wall_face", elementId: "w-north", stationMm: 14 * FT, side: -1 }, mark: "CR-1" },
      { type: "place_part", partId: "sw-1", typeId: sw3.id, levelId: "L1", position: { x: 0, y: 0 }, host: { kind: "wall_face", elementId: "w-south", stationMm: 4 * FT, side: 1 }, mark: "SW-1" },
      { type: "place_part", partId: "sw-2", typeId: sw3.id, levelId: "L1", position: { x: 0, y: 0 }, host: { kind: "wall_face", elementId: "w-south", stationMm: 8 * FT, side: 1 }, mark: "SW-2" },
      { type: "place_part", partId: "sw-d", typeId: swD.id, levelId: "L1", position: { x: 0, y: 0 }, host: { kind: "wall_face", elementId: "w-east", stationMm: 6 * FT, side: 1 }, mark: "SD-1" },
      { type: "place_part", partId: "lt-1", typeId: troffer.id, levelId: "L1", position: { x: 10 * FT, y: 6 * FT }, mark: "F1" },
      { type: "create_service_link", linkId: "ckt-1", sourceId: "pnl-1", positions: [1], members: [{ elementId: "r-1" }, { elementId: "r-2" }] },
      { type: "create_view", viewId: "v-e", name: "Power & Lighting", viewType: "floor_plan", crop: { min: { x: -2 * FT, y: -2 * FT }, max: { x: 22 * FT, y: 14 * FT } }, props: { level: "Level 1", scale: 96, discipline: "electrical" } },
    ]);

    // 1. Annotative plan picking: clicking inside r-1's paper circle (2 mm * 96 = 192 mm into the room,
    //    well outside its 28 mm physical wall box) hits r-1!
    const viewE = m.elements["v-e"] as ViewElement;
    const pickIdx = buildViewPickIndex(m, viewE);
    const r1 = m.elements["r-1"] as PartInstance;
    const circleCenter = { x: r1.position.x, y: r1.position.y - 2.0 * 96 };
    const picked = pickAt(pickIdx, { x: circleCenter.x, y: circleCenter.y }, 10);
    expect(picked[0]).toBe("r-1");

    // 2. Dragging a wall_face part along its wall updates stationMm; dragging to an adjacent wall re-hosts it;
    //    dragging far into the room cleanly detaches the wall_face host.
    let mMoved = runCmds(m, [{ type: "move_elements", ids: ["r-1"], delta: { x: 3 * FT, y: 0 } }]);
    const r1Slid = mMoved.elements["r-1"] as PartInstance;
    expect(r1Slid.host?.kind).toBe("wall_face");
    if (r1Slid.host?.kind === "wall_face") {
      expect(r1Slid.host.elementId).toBe("w-north");
      expect(r1Slid.host.stationMm).toBeCloseTo(8 * FT, 1);
    }
    expect(r1Slid.position.y).toBeCloseTo(11.75 * FT, 1);

    mMoved = runCmds(m, [{ type: "move_elements", ids: ["r-1"], delta: { x: 0, y: -5 * FT } }]);
    const r1Detached = mMoved.elements["r-1"] as PartInstance;
    expect(r1Detached.host).toBeUndefined();

    // 3. Protocol gate rejects Text Types and Link Routing when peer lacks the features.
    const gatedText = withUpgradePolicy(() => false, () =>
      executeCommand(m, { type: "create_text_style", styleId: "txt-custom", name: "Custom", textSizeMm: 2.6, background: "opaque", defaultFor: ["part_mark"] }),
    );
    expect(gatedText.ok).toBe(false);
    const gatedSpline = withUpgradePolicy(() => false, () =>
      executeCommand(m, {
        type: "set_view_properties",
        viewId: "v-e",
        props: { circuitGraphics: withCircuitWaypoints(viewE, "ckt-1", "r-1", "r-2", [{ x: 8 * FT, y: 9 * FT }, { x: 11 * FT, y: 9 * FT }]) },
      }),
    );
    expect(gatedSpline.ok).toBe(false);

    // 4. Unified @permitzip/bim-script workflow: Text Type + opaque mask, multi-vertex spline wire,
    //    editable home run, all-runs NECA 100 hash marks, 3-way travelers (leg a), and 0-10V dimmer (leg b).
    const unifiedScript = defineScript({
      kind: "layout",
      reads: { levels: true, kinds: ["wall", "part", "part_type", "view", "service_link", "organization"] },
      parameters: {},
      run(ctx) {
        const tsId = documents.textStyle(ctx, {
          name: '3/32" Unified Opaque',
          textSizeMm: 2.4,
          fontFamily: "Arial",
          background: "opaque",
          defaultFor: ["part_mark", "link_label", "tag"],
        });
        documents.setTextStyle(ctx, tsId, { bold: false });
        documents.setCircuitGraphics(ctx, "v-e", {
          style: "arcs",
          homeRuns: true,
          switchLegs: true,
          switchLegLabels: true,
          hashMarks: "hots_neutral_ground",
          hashMarksOn: "all_runs",
        });
        documents.setWirePath(ctx, "v-e", "ckt-1", "r-1", "r-2", [
          { x: units.ft(8), y: units.ft(9.5) },
          { x: units.ft(11), y: units.ft(9.2) },
        ]);
        documents.setHomeRun(ctx, "v-e", "ckt-1", {
          member: "r-1",
          tipOffset: { x: units.ft(-3.5), y: units.ft(-1.5) },
          bendOffset: { x: units.ft(-1.5), y: units.ft(-2.0) },
          labelOffset: { x: units.ft(-1.0), y: units.ft(0) },
        });
        equipment.controlZone(ctx, { leg: "a", controllers: ["sw-1", "sw-2"], loads: ["lt-1"], protocol: "line_voltage" });
        equipment.controlZone(ctx, { leg: "b", controllers: ["sw-d"], loads: ["r-2"], protocol: "0-10v" });
      },
    });
    const slice = { ...sliceModel(m, unifiedScript.manifest.reads), features: ALL_TEST_FEATURES };
    const res = await runScript(unifiedScript, { slice, values: {}, scriptHash: "unified-test" });
    expect(res.kind).toBe("edits");
    if (res.kind !== "edits") throw new Error("expected edits");
    const m2 = runCmds(m, res.batches);

    // Text Type resolved identically for part_mark and link_label.
    const markLook = resolveTextStyle(m2, "part_mark");
    const linkLook = resolveTextStyle(m2, "link_label");
    expect(markLook?.textSizeMm).toBe(2.4);
    expect(markLook?.mask).toBe(true);
    expect(markLook?.fontFamily).toBe("Arial");
    expect(linkLook?.id).toBe(markLook?.id);

    // SVG emits opaque white mask <rect fill="#fff" stroke="none"/> before masked text!
    const built = buildViewScene(m2, "v-e");
    const svg = sceneToSvg(built.scene);
    expect(svg).toContain('fill="#fff" stroke="none"');
    expect(built.scene.primitives.some((p) => p.kind === "text" && p.text === "GFCI-1" && p.mask === true && p.size === 2.4)).toBe(true);
    expect(built.scene.primitives.some((p) => p.kind === "text" && p.text === "LP-1-1" && p.mask === true && p.size === 2.4)).toBe(true);

    // Spline wire has > 12 smooth points (multi-segment Catmull-Rom) and curved home run follows r-1 if r-1 slides!
    const v2 = m2.elements["v-e"] as ViewElement;
    const shown2 = new Map<string, PartInstance>();
    for (const el of Object.values(m2.elements)) if (el.kind === "part") shown2.set(el.id, el);
    const graphics = deriveCircuitGraphics(m2, v2, shown2, 96, "medium");
    const ckt = graphics.find((g) => g.linkId === "ckt-1")!;
    expect(ckt.paths[0]!.length).toBeGreaterThan(20);
    expect((ckt.homeRun!.path ?? []).length).toBeGreaterThan(2);
    expect(ckt.homeRun!.labelAt).toBeDefined();

    // Moving r-1 moves the custom home run tip right along with r-1!
    const tipBefore = ckt.homeRun!.tip;
    const m3 = runCmds(m2, [{ type: "move_elements", ids: ["r-1"], delta: { x: 2 * FT, y: 0 } }]);
    const shown3 = new Map<string, PartInstance>();
    for (const el of Object.values(m3.elements)) if (el.kind === "part") shown3.set(el.id, el);
    const cktAfterMove = deriveCircuitGraphics(m3, m3.elements["v-e"] as ViewElement, shown3, 96, "medium").find((g) => g.linkId === "ckt-1")!;
    expect(cktAfterMove.homeRun!.tip.x - tipBefore.x).toBeCloseTo(2 * FT, 1);

    // Switch leg a (3-way travelers sw-1 <-> sw-2 -> lt-1) + switch leg b (0-10V dash-dot -> controlled receptacle r-2) + lowercase letters!
    const legA = graphics.find((g) => g.kind === "switch_leg" && g.numbers.some((n) => n.text === "a"))!;
    const legB = graphics.find((g) => g.kind === "switch_leg" && g.numbers.some((n) => n.text === "b"))!;
    expect(legA).toBeDefined();
    expect(legA.joins.length).toBe(2); // sw-1 <-> sw-2 traveler + switch -> lt-1
    expect(legA.numbers.map((n) => n.text)).toEqual(["a", "a", "a"]);
    expect(legB).toBeDefined();
    expect(legB.dashPattern).toEqual([2.2, 0.8, 0.45, 0.8]); // 0-10V dash-dot control linetype!
    expect(legB.numbers.map((n) => n.text)).toEqual(["b", "b"]);

    // Interactive helpers: circuitHomeRunsOnPaper + circuitHomeRunNear + planAutoPartMarks + flipArc.
    const toPaper = (q: { x: number; y: number }) => ({ x: q.x / 96, y: -q.y / 96 });
    const hrs = circuitHomeRunsOnPaper(m2, v2, shown2, 96, toPaper);
    expect(hrs.length).toBe(1);
    expect(circuitHomeRunNear(hrs, hrs[0]!.tipPaper, 2)?.part).toBe("tip");
    expect(circuitHomeRunNear(hrs, hrs[0]!.labelAtPaper, 2)?.part).toBe("label");
    const autoMarks = planAutoPartMarks(m2, v2, built.frame);
    expect(autoMarks.some((mk) => mk.partId === "r-1" && mk.text === "GFCI-1")).toBe(true);

    // Flip arc & clear home run helpers cleanly update hints.
    const flippedProps = withCircuitFlipArc(v2, "ckt-1", "r-1", "r-2");
    expect(flippedProps.hints?.["ckt-1"]?.flipArc?.["r-1|r-2"]).toBe(true);
    const clearedHr = withCircuitHomeRun(v2, "ckt-1", null);
    expect(clearedHr.hints?.["ckt-1"]?.homeRun).toBeUndefined();

    // Deep bend / moved-device guard: pulling a wire bend far past close endpoints (would be a 336° circumcircle loop)
    // stays smoothly bounded near {a, m, b} and passes right through `m` instead of exploding off the viewport.
    const a = { x: 1800, y: 8200 };
    const b = { x: 2600, y: 7400 };
    const via = { x: 2200, y: 4000 };
    const bounded = previewWireCurve(a, [via], b);
    expect(bounded.length).toBeGreaterThanOrEqual(18);
    expect(bounded.some((p) => Math.hypot(p.x - via.x, p.y - via.y) < 1)).toBe(true);
    for (const p of bounded) {
      expect(p.x).toBeGreaterThanOrEqual(1400);
      expect(p.x).toBeLessThanOrEqual(3000);
      expect(p.y).toBeGreaterThanOrEqual(3600);
      expect(p.y).toBeLessThanOrEqual(8400);
    }
  });

  it("renders true vector circles, smart rim tag leaders, dynamic emergency battery fills, GFI text masks, switch-leg hash marks, dedicated controls plan, and MWBC multi-arrowhead home runs", async () => {
    const model = runCmds(emptyModel(), [
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      {
        type: "add_architecture",
        levelId: "L1",
        walls: [{ wallId: "w-1", start: { x: 0, y: 0 }, end: { x: 20 * FT, y: 0 }, thicknessMm: 150, heightMm: 3000 }],
        openings: [],
        casework: [],
        rooms: [],
      },
    ]);
    const s = defineScript({
      kind: "layout",
      reads: { levels: true, kinds: ["wall", "part", "part_type", "view", "service_link", "organization"] },
      parameters: {},
      run(ctx) {
        const plan = documents.planView(ctx, { name: "E101 Plan", level: "Level 1", scale: 48, discipline: "electrical" });
        const controlsPlan = documents.planView(ctx, { name: "E104 Controls", level: "Level 1", scale: 48, discipline: "electrical" });
        const panel = equipment.place(ctx, { level: "Level 1", type: "builtin:panelboard-225@1", at: { x: units.ft(1), y: units.ft(1) }, mark: "LP-1" });
        const gfci = equipment.place(ctx, { level: "Level 1", type: "builtin:gfci-receptacle@1", onWall: { wall: "w-1", along: units.ft(5), side: 1 }, mark: "W-01" });
        const r2 = equipment.place(ctx, { level: "Level 1", type: "builtin:duplex-receptacle@1", onWall: { wall: "w-1", along: units.ft(10), side: 1 }, mark: "W-02" });
        const sw3 = equipment.place(ctx, { level: "Level 1", type: "builtin:switch-three-way@1", onWall: { wall: "w-1", along: units.ft(14), side: 1 }, mark: "S-1" });
        const dl = equipment.place(ctx, { level: "Level 1", type: "builtin:downlight-6-led@1", at: { x: units.ft(6), y: units.ft(6) }, mark: "F1-1" });
        const tr = equipment.place(ctx, { level: "Level 1", type: "builtin:troffer-2x4-led@1", at: { x: units.ft(12), y: units.ft(6) }, mark: "F2-1" });

        // Branch circuits 1 & 3 on LP-1 paired into a shared-neutral MWBC home run!
        ctx.edit({
          type: "create_service_link",
          linkId: "ckt-mwbc-1",
          sourceId: panel.id,
          positions: [1],
          members: [{ elementId: gfci.id }],
          description: "GFCI Receptacle",
          electrical: { ratingA: 20, poles: 1, conductors: { sets: 1, phaseSize: "12", neutralSize: "12", groundSize: "12", material: "cu" } },
        });
        ctx.edit({
          type: "create_service_link",
          linkId: "ckt-mwbc-3",
          sourceId: panel.id,
          positions: [3],
          members: [{ elementId: r2.id }],
          description: "General Receptacle",
          electrical: { ratingA: 20, poles: 1, conductors: { sets: 1, phaseSize: "12", neutralSize: "12", groundSize: "12", material: "cu" } },
        });
        equipment.controlZone(ctx, { leg: "a", controllers: [sw3], loads: [dl, tr], protocol: "0-10v", emergencyMode: "switched" });

        documents.setCircuitGraphics(ctx, plan, {
          style: "arcs",
          homeRuns: true,
          switchLegs: true,
          switchLegLabels: true,
          hashMarks: "hots_neutral_ground",
          hashMarksOn: "home_runs_and_switch_legs",
        });
        documents.setMwbcGroup(ctx, plan, ["ckt-mwbc-1", "ckt-mwbc-3"], "mwbc-a");
        documents.setSwitchLegLabelOffset(ctx, plan, `switch:${sw3.id}`, sw3.id, { x: units.in(18), y: units.in(10) });

        // Dedicated Controls Plan: hides branch circuits & home runs, shows switch legs + switch-leg ticks only.
        documents.setCircuitGraphics(ctx, controlsPlan, {
          style: "arcs",
          showCircuits: false,
          homeRuns: false,
          switchLegs: true,
          switchLegLabels: true,
          hashMarks: "hots_neutral_ground",
          hashMarksOn: "home_runs_and_switch_legs",
        });
      },
    });
    const slice = { ...sliceModel(model, s.manifest.reads), features: ALL_TEST_FEATURES };
    const res = await runScript(s, { slice, values: {}, scriptHash: "video-feedback-test" });
    expect(res.kind).toBe("edits");
    if (res.kind !== "edits") throw new Error("expected edits");
    const next = runCmds(model, res.batches);
    const planView = Object.values(next.elements).find((e): e is ViewElement => e.kind === "view" && e.name === "E101 Plan")!;
    const controlsView = Object.values(next.elements).find((e): e is ViewElement => e.kind === "view" && e.name === "E104 Controls")!;
    const gfci = Object.values(next.elements).find((e): e is PartInstance => e.kind === "part" && e.typeId === "builtin:gfci-receptacle@1")!;
    const dl = Object.values(next.elements).find((e): e is PartInstance => e.kind === "part" && e.typeId === "builtin:downlight-6-led@1")!;
    const sw3 = Object.values(next.elements).find((e): e is PartInstance => e.kind === "part" && e.typeId === "builtin:switch-three-way@1")!;

    // 1. True vector `<circle>` primitives rendered in SVG (no faceted 12-gon polygons!) + GFI subscript carries opaque mask!
    const scene = buildViewScene(next, planView.id).scene;
    expect(scene.primitives.some((p) => p.kind === "circle")).toBe(true);
    const svg = sceneToSvg(scene);
    expect(svg).toContain("<circle ");
    const gfiPrim = scene.primitives.find((p) => p.kind === "text" && p.text === "GFI");
    expect(gfiPrim?.kind === "text" && gfiPrim.mask).toBe(true);

    // 2. Dynamic Emergency battery fill: both downlight & troffer have emergency=true -> solid fill primitives present; toggling off removes them!
    const solidFillsEm = scene.primitives.filter((p) => p.kind === "fill" && p.grey < 0.5).length;
    expect(solidFillsEm).toBeGreaterThanOrEqual(2);
    const toggledOff = runCmds(next, [{ type: "set_parameters", id: dl.id, scope: "instance", values: { emergency: false, emergency_mode: "none" } }]);
    const solidFillsOff = buildViewScene(toggledOff, planView.id).scene.primitives.filter((p) => p.kind === "fill" && p.grey < 0.5).length;
    expect(solidFillsOff).toBeLessThan(solidFillsEm);

    // 3. Smart tag leader perimeter attachment: tag head above wall-mounted GFCI lands on the symbol's outer rim (NOT at the wall face y=0)!
    const rim = tagLeaderTarget(next, planView, { elementId: gfci.id, template: "mark", leader: true }, { x: gfci.position.x, y: gfci.position.y + 800 });
    expect(rim).not.toBeNull();
    expect(rim!.y).toBeGreaterThan(gfci.position.y + 100);
    // Vertical tag placement directly above target attaches cleanly from the bottom center of the tag box (no awkward side jog).
    const vertical = elbowLeaderPath({ min: { x: 40, y: 20 }, max: { x: 60, y: 26 } }, { x: 50, y: 40 });
    expect(vertical).not.toBeNull();
    expect(vertical!.points).toHaveLength(2);
    expect(vertical!.points[0]!.x).toBeCloseTo(50, 2);
    expect(vertical!.points[0]!.y).toBeCloseTo(26, 2);

    // 4. MWBC combined double-arrowhead home run ("LP-1-1,3") with 2 hots + 1 shared neutral + 1 ground!
    const shown = new Map<string, PartInstance>();
    for (const el of Object.values(next.elements)) if (el.kind === "part") shown.set(el.id, el);
    const planGraphics = deriveCircuitGraphics(next, planView, shown, 48);
    const mwbcLeader = planGraphics.find((g) => g.linkId === "ckt-mwbc-1");
    const mwbcPeer = planGraphics.find((g) => g.linkId === "ckt-mwbc-3");
    expect(mwbcLeader?.homeRun?.label).toBe("LP-1-1,3");
    expect(mwbcLeader?.homeRun?.arrows).toBe(2);
    expect(mwbcLeader?.homeRun?.mwbcHots).toBe(2);
    expect(mwbcPeer?.homeRun).toBeNull();

    // 5. Switch-leg custom offset applied on sw3 + Dedicated Controls Plan shows ONLY switch legs (zero branch circuits)!
    const swLeg = planGraphics.find((g) => g.kind === "switch_leg");
    const swNum = swLeg?.numbers.find((n) => n.memberId === sw3.id);
    expect(swNum).toBeDefined();
    expect(Math.abs(swNum!.at.x - (sw3.position.x + 18 * 25.4))).toBeLessThan(200);

    const ctrlGraphics = deriveCircuitGraphics(next, controlsView, shown, 48);
    expect(ctrlGraphics.some((g) => g.kind === "circuit")).toBe(false);
    expect(ctrlGraphics.some((g) => g.kind === "switch_leg")).toBe(true);
  });

  it("supports kernel-level declarative wall hosting, auto-rotating wall switches with east-wall safe subscripts, live lighting controls schedule, and live controls diagram via @permitzip/bim-script", async () => {
    // 1. Kernel `isWallFaceMountable` is discipline-neutral: explicit `hosting`, switches, receptacles, panelboards, and custom scripted parts work without family-name hardcoding.
    const customWallSensor = parts
      .part("Thermostat", { type: "24V Smart", category: "generic", hosting: "wall_face" })
      .box({ length: units.in(4), width: units.in(1), height: units.in(4) })
      .planSymbol([
        { kind: "line", from: [0, 0], to: [0, 1.4], pen: "medium", units: "paper" },
        { kind: "circle", center: [0, 2.8], radius: 1.4, fill: "mask", pen: "medium", units: "paper" },
        { kind: "text", at: [0, 2.8], text: "T", heightMm: 1.5, mask: true, units: "paper" },
      ])
      .build();
    expect(customWallSensor.hosting).toBe("wall_face");
    expect(customWallSensor.symbol).toHaveLength(3);
    expect(isWallFaceMountable(customWallSensor)).toBe(true);
    expect(isWallFaceMountable(builtinPartType("builtin:switch-single-pole@1")?.definition)).toBe(true);
    expect(isWallFaceMountable(builtinPartType("builtin:switch-dimmer@1")?.definition)).toBe(true);
    expect(isWallFaceMountable(builtinPartType("builtin:duplex-receptacle@1")?.definition)).toBe(true);
    expect(isWallFaceMountable(builtinPartType("builtin:panelboard-225@1")?.definition)).toBe(true);
    expect(isWallFaceMountable(builtinPartType("builtin:occupancy-sensor-ceiling@1")?.definition)).toBe(false);
    expect(isWallFaceMountable(builtinPartType("builtin:downlight-6-led@1")?.definition)).toBe(false);

    // 2. Build a room with an east wall (`x = 20 ft`), place an unhosted switch and drag it near the east wall -> it snaps flush & auto-rotates (90 deg, facing west into room),
    //    and both east-wall switch `$D` and east-wall `GFI` keep their subscripts strictly inside the room (x < eastWallFace)!
    const base = runCmds(emptyModel(), [
      { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 },
      {
        type: "add_architecture",
        levelId: "lvl-1",
        walls: [
          { wallId: "w-east", start: { x: 20 * FT, y: 0 }, end: { x: 20 * FT, y: 16 * FT }, thicknessMm: 152.4, heightMm: 3048 },
        ],
        openings: [],
        casework: [],
        rooms: [{ roomId: "rm-1", number: "101", name: "OFFICE", outline: [{ x: 0, y: 0 }, { x: 20 * FT, y: 0 }, { x: 20 * FT, y: 16 * FT }, { x: 0, y: 16 * FT }] }],
      },
      {
        type: "place_part",
        partId: "sw-free",
        typeId: "builtin:switch-dimmer@1",
        partType: builtinPartType("builtin:switch-dimmer@1")!.definition,
        levelId: "lvl-1",
        position: { x: 10 * FT, y: 8 * FT },
        offsetMm: 1219.2,
        rotationDeg: 0,
        mark: "SW-D",
      },
      {
        type: "place_part",
        partId: "gfi-east",
        typeId: "builtin:gfci-receptacle@1",
        partType: builtinPartType("builtin:gfci-receptacle@1")!.definition,
        levelId: "lvl-1",
        position: { x: 0, y: 0 },
        offsetMm: 457.2,
        host: { kind: "wall_face", elementId: "w-east", stationMm: 4 * FT, side: 1 },
        mark: "GFI-E",
      },
    ]);

    // Drag the unhosted switch close to the east wall -> kernel re-hosts & auto-rotates to 90° (facing west into room)!
    const snappedModel = runCmds(base, [{ type: "move_elements", ids: ["sw-free"], delta: { x: 9.6 * FT, y: 0 } }]);
    const swSnapped = snappedModel.elements["sw-free"] as PartInstance;
    expect(swSnapped.host?.kind).toBe("wall_face");
    expect(swSnapped.rotationDeg).toBeCloseTo(90, 1);
    const eastFaceX = 20 * FT - 152.4 / 2;
    expect(swSnapped.position.x).toBeCloseTo(eastFaceX, 1);

    // Check rendered symbol text positions on east wall: neither `$D` nor `GFI` crosses into the wall (x >= eastFaceX)!
    const swTexts: Array<{ text: string; x: number; anchor?: string }> = [];
    drawPartSymbol(snappedModel, swSnapped, () => {}, (at, text, _size, anchor) => swTexts.push({ text, x: at.x, anchor }), null, "medium", { scale: 96, showMark: false });
    expect(swTexts.find((t) => t.text === "S")!.x).toBeLessThan(eastFaceX - 150);
    expect(swTexts.find((t) => t.text === "D")!.x).toBeLessThan(eastFaceX - 80);

    const gfiEast = snappedModel.elements["gfi-east"] as PartInstance;
    const gfiTexts: Array<{ text: string; x: number; anchor?: string }> = [];
    drawPartSymbol(snappedModel, gfiEast, () => {}, (at, text, _size, anchor) => gfiTexts.push({ text, x: at.x, anchor }), null, "medium", { scale: 96, showMark: false });
    const gfiLabel = gfiTexts.find((t) => t.text === "GFI");
    expect(gfiLabel).toBeDefined();
    expect(gfiLabel!.anchor).toBe("end");
    expect(gfiLabel!.x).toBeLessThan(eastFaceX - 250);

    // 3. `@permitzip/bim-script`: discover `controls_diagram` via `documents.diagramKinds`, create live controls diagram + live lighting_controls form schedule!
    const script = defineScript({
      kind: "layout",
      reads: { levels: true, kinds: ["wall", "part", "part_type", "view", "service_link", "room"] },
      parameters: {},
      run(ctx) {
        const kinds = documents.diagramKinds(ctx).map((d) => d.kind);
        if (!kinds.includes("controls_diagram")) throw new Error(`Missing controls_diagram in ${kinds.join(", ")}`);
        const forms = documents.formKinds(ctx).map((f) => f.kind);
        if (!forms.includes("lighting_controls")) throw new Error(`Missing lighting_controls in ${forms.join(", ")}`);

        const pnl = equipment.place(ctx, { level: "Level 1", type: "builtin:panelboard-225-480@1", at: { x: units.ft(2), y: units.ft(2) }, mark: "HP-1" });
        const f1 = equipment.place(ctx, { level: "Level 1", type: "builtin:troffer-2x4-led@1", at: { x: units.ft(10), y: units.ft(8) }, mark: "F2-1" });
        ctx.edit({
          type: "create_service_link",
          linkId: "ckt-hp-1",
          sourceId: pnl.id,
          positions: [1],
          members: [{ elementId: f1.id }],
          description: "Office Lighting",
        });
        equipment.controlZone(ctx, { leg: "a", protocol: "0-10v", emergencyMode: "switched", controllers: ["sw-free"], loads: [f1.id] });
        documents.formSchedule(ctx, { id: "v-ctrl-sch", kind: "lighting_controls", name: "Lighting Controls Schedule" });
        documents.diagram(ctx, { id: "v-ctrl-diag", kind: "controls_diagram", name: "Lighting Controls Diagram" });
      },
    });
    const slice = { ...sliceModel(snappedModel, script.manifest.reads), features: [...ALL_TEST_FEATURES, "diagrams:open_kinds"] };
    const res = await runScript(script, { slice, values: {}, scriptHash: "controls-diagram-test" });
    expect(res.kind).toBe("edits");
    if (res.kind !== "edits") throw new Error("expected edits");
    const after = runCmds(snappedModel, res.batches);

    const schView = after.elements["v-ctrl-sch"] as ViewElement;
    expect(schView.props?.formSchedule?.kind).toBe("lighting_controls");
    const schEval = evaluateFormSchedule(after, schView.props!.formSchedule!);
    expect(schEval.grid.rows).toHaveLength(1);
    expect(schEval.grid.rows[0]![0]).toBe("A");
    expect(schEval.grid.rows[0]![4]).toBe("0-10V Dimming");
    expect(schEval.grid.rows[0]![6]).toBe("Switched EM (UL 924)");

    const diagView = after.elements["v-ctrl-diag"] as ViewElement;
    expect(diagView.props?.diagram?.kind).toBe("controls_diagram");
    const diagEval = evaluateDiagram(after.elements, diagView);
    expect(diagEval?.items.length).toBeGreaterThan(10);
    expect(diagEval?.boxes.length).toBeGreaterThanOrEqual(2);
    expect(buildViewScene(after, "v-ctrl-diag").scene.primitives.length).toBeGreaterThan(0);
    expect(buildViewScene(after, "v-ctrl-sch").scene.primitives.length).toBeGreaterThan(0);
  });

  it("projects station from `at` before `onWall.toward`, preserves builder solid `.planSymbol(...)`, and propagates connected runs through wall-follow and snapped part moves", async () => {
    const base = runCmds(emptyModel(), [
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      {
        type: "add_architecture",
        levelId: "L1",
        walls: [
          { wallId: "w-south", start: { x: 0, y: 0 }, end: { x: 20 * FT, y: 0 }, thicknessMm: 152.4, heightMm: 3000 },
          { wallId: "w-west", start: { x: 0, y: 0 }, end: { x: 0, y: 12 * FT }, thicknessMm: 152.4, heightMm: 3000 },
        ],
        openings: [],
        casework: [],
        rooms: [],
      },
    ]);

    // 1) Two devices with different `at` and a shared room-center `toward` must NOT stack at `toward`,
    //    AND a builder-created part with solid geometry + `.planSymbol(...)` must render its direct plan symbol.
    const customWallBox = parts
      .part("Custom Wall Sensor", { type: "WS-1", category: "electrical_equipment", hosting: "wall_face" })
      .box({ length: units.in(4), width: units.in(2), height: units.in(4) })
      .planSymbol([
        { kind: "circle", center: [0, 2], radius: 1.5, units: "paper" },
        { kind: "text", at: [0, 2], text: "S", heightMm: 1.5, units: "paper" },
      ])
      .build();
    const withCustomType = runCmds(base, [
      { type: "save_part_types", types: [{ typeId: "custom:wall-sensor@1", definition: customWallBox }] },
    ]);
    const script = defineScript({
      kind: "layout",
      reads: { levels: true, kinds: ["wall", "part", "part_type"] },
      parameters: {},
      run(ctx) {
        const roomCenter = { x: units.ft(10), y: units.ft(6) };
        equipment.place(ctx, {
          id: "dev-a",
          level: "Level 1",
          type: "custom:wall-sensor@1",
          at: { x: units.ft(4), y: units.ft(0) },
          onWall: { wall: "w-south", toward: roomCenter },
          mark: "SA",
        });
        equipment.place(ctx, {
          id: "dev-b",
          level: "Level 1",
          type: "custom:wall-sensor@1",
          at: { x: units.ft(14), y: units.ft(0) },
          onWall: { wall: "w-south", toward: roomCenter },
          mark: "SB",
        });
      },
    });
    const slice = { ...sliceModel(withCustomType, script.manifest.reads), features: [...ALL_TEST_FEATURES] };
    const res = await runScript(script, { slice, values: {}, scriptHash: "wall-station-and-solid-symbol" });
    expect(res.kind).toBe("edits");
    if (res.kind !== "edits") throw new Error("expected edits");
    let m = runCmds(withCustomType, res.batches);

    const devA = m.elements["dev-a"] as PartInstance;
    const devB = m.elements["dev-b"] as PartInstance;
    expect(devA.host?.kind).toBe("wall_face");
    expect(devB.host?.kind).toBe("wall_face");
    expect(devA.position.x).toBeCloseTo(4 * FT, 1);
    expect(devB.position.x).toBeCloseTo(14 * FT, 1);
    expect(devA.position.y).toBeCloseTo(76.2, 1);
    expect(devB.position.y).toBeCloseTo(76.2, 1);

    // Direct `.planSymbol(...)` primitives on a solid builder part must survive plan resolution!
    const circles: number[] = [];
    const texts: string[] = [];
    drawPartSymbol(
      m,
      devA,
      () => {},
      (_at, txt) => texts.push(txt),
      null,
      "medium",
      { scale: 48, showMark: false, circle: (_c, r) => circles.push(r) },
    );
    expect(circles.length).toBeGreaterThan(0);
    expect(texts).toContain("S");

    // 2) Connected run propagation through wall-follow and snapped part moves:
    //    Place a wall-hosted part with a connector and route a connected run perpendicular out of it.
    const connType = parts
      .part("Wall Conduit Box", { type: "JB-12", category: "electrical_equipment", hosting: "wall_face" })
      .box({ length: units.in(12), width: units.in(6), height: units.in(12) })
      .connector("left", { id: "out", label: "Supply", domain: "duct", systemKind: "supply_air", shape: "round", diameter: units.in(6) })
      .build();
    m = runCmds(m, [
      { type: "save_part_types", types: [{ typeId: "custom:wall-conduit-box@1", definition: connType }] },
      {
        type: "place_part",
        partId: "box-1",
        typeId: "custom:wall-conduit-box@1",
        levelId: "L1",
        position: { x: 6 * FT, y: 76.2 },
        host: { kind: "wall_face", elementId: "w-south", stationMm: 6 * FT, side: 1 },
        mark: "JB-1",
      },
      {
        type: "route_run",
        idPrefix: "run-jb",
        system: { id: "sys-sa", kind: "supply_air", name: "Supply Air 1" },
        levelId: "L1",
        domain: "duct",
        size: { shape: "round", diameter: 6 * 25.4 },
        elevationMm: 6 * 25.4,
        from: { kind: "part", partId: "box-1", connectorId: "out" },
        points: [{ x: 6 * FT, y: 6 * FT }],
      },
    ]);
    const segBefore = Object.values(m.elements).find((e): e is RunSegment => e.kind === "run_segment")!;
    expect(segBefore).toBeDefined();
    expect(segBefore.start.x).toBeCloseTo(6 * FT, 1);

    // 2a) Moving the host wall in +Y carries BOTH the wall-hosted part AND its connected conduit run together.
    const movedWall = runCmds(m, [{ type: "move_elements", ids: ["w-south"], delta: { x: 0, y: 300 } }]);
    const boxAfterWall = movedWall.elements["box-1"] as PartInstance;
    const segAfterWall = movedWall.elements[segBefore.id] as RunSegment;
    expect(boxAfterWall.position.y).toBeCloseTo(76.2 + 300, 1);
    expect(segAfterWall.start.y).toBeCloseTo(segBefore.start.y + 300, 1);

    // 2b) Dragging the connected wall-hosted part along its wall WITH off-axis wobble (y: +25mm)
    //     snaps back onto y=76.2 BEFORE propagating connected runs, so the move succeeds cleanly and keeps endpoints aligned!
    const movedPart = runCmds(m, [{ type: "move_elements", ids: ["box-1"], delta: { x: 500, y: 25 } }]);
    const boxAfterDrag = movedPart.elements["box-1"] as PartInstance;
    const segAfterDrag = movedPart.elements[segBefore.id] as RunSegment;
    expect(boxAfterDrag.position.x).toBeCloseTo(6 * FT + 500, 1);
    expect(boxAfterDrag.position.y).toBeCloseTo(76.2, 1);
    expect(segAfterDrag.start.x).toBeCloseTo(segBefore.start.x + 500, 1);
    expect(segAfterDrag.start.y).toBeCloseTo(segBefore.start.y, 1);

    // 2c) Seating a connected part onto a differently-oriented wall via set_part_host refuses cleanly instead of misaligning runs.
    const turnRefusal = withUpgradePolicy(
      () => true,
      () =>
        executeCommand(m, {
          type: "set_part_host",
          ids: ["box-1"],
          host: { kind: "wall_face", elementId: "w-west", stationMm: 4 * FT, side: -1 },
        }),
    );
    expect(turnRefusal.ok).toBe(false);
    if (!turnRefusal.ok) expect(turnRefusal.error.code).toBe("anchored_would_move");
  });
});
