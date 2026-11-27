/**
 * @jest-environment node
 *
 * Verifies the default MutinyBIM flagship showcase model (`createShowcaseDemoModel`)
 * used by `npm run demo` (`BIM_DEV_MODEL=showcase`) and `apps/mutinybim-web`:
 * - Builds cleanly with zero validation issues across Architecture + Mechanical + Electrical + Plumbing
 * - Uses smooth non-ribbed PBR materials on cut-sheet commercial equipment, sinks, luminaires & millwork
 * - Has zero 3D ceiling coordination clashes (lights vs diffusers/grilles, lights vs columns, ducts vs ceiling/deck)
 * - Uses real `connect_into` flex duct runs on all 4 supply diffusers + both return grilles
 * - Circuits all mechanical/plumbing loads (`RTU-1`, `WH-1`, `EF-1`) and interior + exterior luminaires
 * - Populates all 6 live diagrams (Air Schematic, One-Line, Lighting Controls, Water Riser, Sanitary/Vent Riser, Isometric)
 * - Renders all 12 Arch D construction sheets cleanly via `buildSheetSceneFor`
 * - Leaves the legacy `createDemoModel("f-a-demo")` mechanical fixture untouched
 */
import { buildSheetSceneFor, buildViewScene, ceilingGridCellCenter, checkDetailView, columnVerticalSpan, documentIndex, elementValues, evaluateDiagram, planAutoPartMarks, resolveElementMaterial, resolveViewProps, sceneToSvg, scheduleV2Paper, tagLines, TILE_2FT_MM, TILE_4FT_MM, validateModel, visiblePlanParts } from "@permitzip/bim-kernel";
import { asRailing, asStair, railingCompliance, railingSpec, stairGeometry, stairLayout } from "@permitzip/bim-pack-architecture";
import { circuitHomeRunsOnPaper, circuitJoinsOnPaper, evaluateEgressPhotometrics, evaluateNormalPhotometrics } from "@permitzip/bim-pack-electrical";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { plumbingDiagramGraph } from "@permitzip/bim-pack-plumbing";
import { BEAM_SCHEDULE, COLUMN_SCHEDULE, beamStrips, footingUnsupportedAll, frameOf, structuralLoadPath } from "@permitzip/bim-pack-structural";
import { createShowcaseDemoModel } from "../src/seed";

describe("createShowcaseDemoModel", () => {
  const model = createShowcaseDemoModel("showcase-test");
  const active = elementValues(model.elements).filter((el) => !("deleted" in el && el.deleted));

  it("passes model validation cleanly with coordinated architecture and MEP elements", () => {
    expect(model.modelId).toBe("showcase-test");
    expect(validateModel(model)).toEqual([]);

    const count = (kind: string) => active.filter((el) => el.kind === kind).length;
    expect(count("level")).toBe(4);
    expect(count("wall")).toBeGreaterThanOrEqual(25);
    expect(count("opening")).toBeGreaterThanOrEqual(17);
    expect(count("space")).toBe(9);
    expect(count("grid")).toBe(7);
    expect(count("architecture.roof")).toBe(2);
    expect(count("architecture.stair")).toBe(1);
    expect(count("part")).toBeGreaterThanOrEqual(70);
    expect(count("run_segment")).toBeGreaterThanOrEqual(45);
    expect(count("service_link")).toBeGreaterThanOrEqual(12);

    // Cut-sheet commercial equipment, fixtures & millwork resolve smooth non-ribbed PBR materials (solid or metallic sheet metal)
    for (const id of ["rtu-1", "ef-1", "gv-1", "wh-1", "wc-101", "lav-101", "ks-101", "sd-1", "lt-4", "wp-1", "vanity-l1", "cafe-island-l1"]) {
      const el = model.elements[id];
      expect(el).toBeDefined();
      const mat = el ? resolveElementMaterial(model, el) : null;
      expect(mat?.id).toBeTruthy();
      expect(["solid", "metal"]).toContain(mat?.pattern);
    }

    // Real-scale 2'×4' ACT ceiling tile grid on Studio 104 cloud: troffers (2'×4') & diffusers (2'×2') seat squarely inside tiles
    const studioCloud = model.elements["clg-l1-studio"];
    expect(studioCloud?.kind).toBe("ceiling");
    if (studioCloud?.kind === "ceiling") {
      expect(studioCloud.grid).toEqual({
        spacingXMm: TILE_4FT_MM,
        spacingYMm: TILE_2FT_MM,
        origin: { x: Math.round(36 * 304.8), y: Math.round(2 * 304.8) },
        rotationDeg: 0,
      });
      for (const trofferId of ["lt-4", "lt-5", "lt-6", "lt-7"]) {
        const p = model.elements[trofferId];
        expect(p?.kind).toBe("part");
        if (p?.kind === "part" && studioCloud.grid) {
          const snapped = ceilingGridCellCenter(studioCloud.grid, p.position);
          expect(Math.hypot(snapped.x - p.position.x, snapped.y - p.position.y)).toBeLessThanOrEqual(2);
        }
      }
      for (const airId of ["sd-1", "sd-2", "rg-1"]) {
        const p = model.elements[airId];
        expect(p?.kind).toBe("part");
        if (p?.kind === "part" && studioCloud.grid) {
          const snapped = ceilingGridCellCenter(studioCloud.grid, p.position, { deviceWidthMm: TILE_2FT_MM, deviceDepthMm: TILE_2FT_MM });
          expect(Math.hypot(snapped.x - p.position.x, snapped.y - p.position.y)).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it("maintains zero ceiling/plenum coordination clashes and connects flex ducts to all 6 L1 supply/return air terminals", () => {
    const parts = active.filter((el): el is Extract<typeof el, { kind: "part" }> => el.kind === "part");
    const cols = active.filter((el): el is Extract<typeof el, { kind: "column" }> => el.kind === "column");
    const partCategory = (p: Extract<(typeof active)[number], { kind: "part" }>) => {
      const pt = model.elements[p.typeId];
      return pt?.kind === "part_type" ? pt.definition.category : undefined;
    };

    const l1CeilingLights = parts.filter((p) => partCategory(p) === "lighting_fixture" && p.levelId === "L1" && !p.host);
    const l1AirTerminals = parts.filter((p) => partCategory(p) === "air_terminal" && p.levelId === "L1");
    expect(l1CeilingLights.length).toBeGreaterThanOrEqual(10);
    expect(l1AirTerminals.length).toBe(7);

    // Minimum clearance: lights vs air terminals >= 950 mm, lights vs columns >= 750 mm
    for (const l of l1CeilingLights) {
      for (const a of l1AirTerminals) {
        expect(Math.hypot(l.position.x - a.position.x, l.position.y - a.position.y)).toBeGreaterThanOrEqual(950);
      }
      for (const c of cols) {
        expect(Math.hypot(l.position.x - c.position.x, l.position.y - c.position.y)).toBeGreaterThanOrEqual(750);
      }
    }

    // All horizontal L1 plenum ducts sit cleanly above 9'-6" ceiling (2896 mm), below 11'-4" deck underside (3454 mm),
    // and completely outside the L1→L2 stairwell shaft (26.7'..33.5', 15.2'..27.4')
    const ducts = active.filter((el): el is Extract<typeof el, { kind: "run_segment" }> => el.kind === "run_segment" && el.domain === "duct");
    const swMinX = Math.round(26.7 * 304.8);
    const swMaxX = Math.round(33.5 * 304.8);
    const swMinY = Math.round(15.2 * 304.8);
    const swMaxY = Math.round(27.4 * 304.8);
    for (const d of ducts) {
      const isHoriz = Math.abs(d.start.z - d.end.z) < 20;
      if (isHoriz && d.start.z < 3658) {
        const halfH = d.size.shape === "rect" ? d.size.height / 2 : d.size.shape === "round" ? d.size.diameter / 2 : 0;
        expect(d.start.z - halfH).toBeGreaterThanOrEqual(2896);
        expect(d.start.z + halfH).toBeLessThanOrEqual(3454);
        const segMinX = Math.min(d.start.x, d.end.x);
        const segMaxX = Math.max(d.start.x, d.end.x);
        const segMinY = Math.min(d.start.y, d.end.y);
        const segMaxY = Math.max(d.start.y, d.end.y);
        const overlapsShaft = segMaxX > swMinX && segMinX < swMaxX && segMaxY > swMinY && segMinY < swMaxY;
        expect(overlapsShaft).toBe(false);
      }
    }

    // Real `connect_into` flex connectors for SD-1..SD-4 + RG-1..RG-2
    const flexSegments = ducts.filter((d) => d.id.includes("-flex"));
    expect(flexSegments.length).toBe(12);

    // Zero 3D clashes between Supply Air and Return Air duct segments (including insulation wrap!)
    const ductAabb = (d: (typeof ducts)[number]) => {
      const ins = d.insulation?.thicknessMm ?? 0;
      const halfW = (d.size.shape === "rect" ? d.size.width / 2 : d.size.shape === "round" ? d.size.diameter / 2 : 0) + ins;
      const halfH = (d.size.shape === "rect" ? d.size.height / 2 : d.size.shape === "round" ? d.size.diameter / 2 : 0) + ins;
      const dx = Math.abs(d.end.x - d.start.x);
      const dy = Math.abs(d.end.y - d.start.y);
      const dz = Math.abs(d.end.z - d.start.z);
      const isVert = dz > 20 && dx < 20 && dy < 20;
      const isEW = dx >= dy && !isVert;
      const padX = isVert ? halfW : isEW ? 0 : halfW;
      const padY = isVert ? halfH : isEW ? halfW : 0;
      const padZ = isVert ? 0 : halfH;
      return {
        minX: Math.min(d.start.x, d.end.x) - padX,
        maxX: Math.max(d.start.x, d.end.x) + padX,
        minY: Math.min(d.start.y, d.end.y) - padY,
        maxY: Math.max(d.start.y, d.end.y) + padY,
        minZ: Math.min(d.start.z, d.end.z) - padZ,
        maxZ: Math.max(d.start.z, d.end.z) + padZ,
      };
    };
    const saDucts = ducts.filter((d) => d.systemId === "sys-sa");
    const raDucts = ducts.filter((d) => d.systemId === "sys-ra");
    const clashes: string[] = [];
    for (const s of saDucts) {
      const sb = ductAabb(s);
      for (const r of raDucts) {
        const rb = ductAabb(r);
        if (sb.maxX > rb.minX && sb.minX < rb.maxX && sb.maxY > rb.minY && sb.minY < rb.maxY && sb.maxZ > rb.minZ && sb.minZ < rb.maxZ) {
          clashes.push(`${s.id} x ${r.id}`);
        }
      }
    }
    expect(clashes).toEqual([]);
  });

  it("circuits RTU-1, WH-1, EF-1, and interior + exterior luminaires and populates all 6 live diagrams", () => {
    const links = active.filter((el): el is Extract<typeof el, { kind: "service_link" }> => el.kind === "service_link");
    const hasMember = (sourceId: string, elementId: string) =>
      links.some((l) => l.source.elementId === sourceId && l.members.some((m) => m.elementId === elementId));

    expect(hasMember("hp-1", "disc-rtu-1")).toBe(true);
    expect(hasMember("disc-rtu-1", "rtu-1")).toBe(true);
    expect(hasMember("hp-1", "wh-1")).toBe(true);
    expect(hasMember("hp-1", "wp-1")).toBe(true);
    expect(hasMember("lp-1", "ef-1")).toBe(true);

    const views = active.filter((el): el is Extract<typeof el, { kind: "view" }> => el.kind === "view");
    const view3d = views.find((v) => v.id === "view-3d-hero");
    expect(view3d?.viewType).toBe("three_d");
    expect(view3d?.props?.projection).toBe("perspective");
    expect(view3d?.props?.camera3d?.fovDeg).toBe(40);

    // All 6 live diagrams evaluate richly from the model graph
    for (const vid of ["view-diag-air", "view-oneline", "view-controls", "view-plumb-riser-water", "view-plumb-riser-dwv", "view-plumb-iso"]) {
      const v = views.find((el) => el.id === vid);
      expect(v).toBeDefined();
      const ev = v ? evaluateDiagram(model.elements, v) : null;
      expect(ev?.items.length ?? 0).toBeGreaterThan(20);
    }

    // Discipline & system filters use canonical category and service:<id> keys (resolved through bound View Templates)
    const archL1 = views.find((v) => v.id === "view-plan-l1");
    const archL1Props = archL1 ? resolveViewProps(model.elements, archL1).props : undefined;
    expect(archL1Props?.categoryOverrides?.duct?.visible).toBe(false);
    expect(archL1Props?.categoryOverrides?.lighting_fixtures?.visible).toBe(false);

    const powerL1 = views.find((v) => v.id === "view-elec-power");
    const powerL1Props = powerL1 ? resolveViewProps(model.elements, powerL1).props : undefined;
    expect(powerL1Props?.categoryOverrides?.["electrical.lighting_control"]?.visible).toBe(false);

    const lightingL1 = views.find((v) => v.id === "view-elec-ltg");
    const lightingL1Props = lightingL1 ? resolveViewProps(model.elements, lightingL1).props : undefined;
    expect(lightingL1Props?.categoryOverrides?.["electrical.receptacle"]?.visible).toBe(false);

    const waterL1 = views.find((v) => v.id === "view-plumb-water-l1");
    const waterL1Props = waterL1 ? resolveViewProps(model.elements, waterL1).props : undefined;
    expect(waterL1Props?.categoryOverrides?.["service:sanitary"]?.visible).toBe(false);
    expect(waterL1Props?.categoryOverrides?.["service:vent"]?.visible).toBe(false);

    const dwvL1 = views.find((v) => v.id === "view-plumb-dwv-l1");
    const dwvL1Props = dwvL1 ? resolveViewProps(model.elements, dwvL1).props : undefined;
    expect(dwvL1Props?.categoryOverrides?.["service:domestic_cold_water"]?.visible).toBe(false);
    expect(dwvL1Props?.categoryOverrides?.["service:domestic_hot_water"]?.visible).toBe(false);

    // Exterior water meter (MTR-1) and sanitary manhole (MH-1) keep >= 5'-0" IPC 603.2 separation; FCO-1 extends via parametric riser_height
    const mtr = model.elements["mtr-1"];
    const mh = model.elements["mh-1"];
    const fco = model.elements["fco-1"];
    expect(mtr?.kind).toBe("part");
    expect(mh?.kind).toBe("part");
    expect(fco?.kind).toBe("part");
    if (mtr?.kind === "part" && mh?.kind === "part") {
      expect(Math.hypot(mtr.position.x - mh.position.x, mtr.position.y - mh.position.y)).toBeGreaterThanOrEqual(1524);
    }
    if (fco?.kind === "part") {
      expect(Number(fco.values?.riser_height ?? 0)).toBeGreaterThanOrEqual(450);
    }
  });

  it("renders all 22 Arch D sheets cleanly with no unresolved callout references and verified passing normal + egress photometrics", () => {
    const sheets = active.filter((el): el is Extract<typeof el, { kind: "sheet" }> => el.kind === "sheet");
    expect(sheets.map((s) => s.number).sort()).toEqual([
      "A-101",
      "A-102",
      "A-103",
      "A-104",
      "A-201",
      "A-301",
      "A-302",
      "E-001",
      "E-101",
      "E-102",
      "E-201",
      "E-202",
      "E-203",
      "M-101",
      "M-201",
      "M-501",
      "P-101",
      "P-102",
      "S-101",
      "S-102",
      "S-201",
      "S-301",
    ]);

    const normal = evaluateNormalPhotometrics(model, { gridSpacingFt: 2, interReflectance: true });
    expect(normal.spaces.length).toBe(9);
    expect(normal.failingSpaces).toBe(0);
    expect(normal.pass).toBe(true);

    const egress = evaluateEgressPhotometrics(model, { gridSpacingFt: 2, workplaneHeightIn: 0 });
    expect(egress.paths.length).toBeGreaterThanOrEqual(4);
    expect(egress.passInitial).toBe(true);
    expect(egress.pass90Min).toBe(true);
    expect(egress.pass).toBe(true);

    for (const sh of sheets) {
      const scene = buildSheetSceneFor(model, sh.id, { projectName: "MutinyBIM Showcase" });
      if (sh.number === "E-001") {
        expect(scene.textBlocks?.length ?? 0).toBeGreaterThanOrEqual(2);
      } else {
        expect(scene.primitives.length).toBeGreaterThan(200);
      }
      const svg = sceneToSvg(scene);
      expect(svg).toContain("<svg");
      expect(svg).not.toContain("?? DIMENSION REFERENCE MISSING");
      if (sh.number === "E-201") {
        expect(svg.replace(/\u00a0/g, " ")).toContain("AFC 42 KA");
        expect(svg).toMatch(/\d+(?:\.\d+)?\s*kVA/i);
      }
      if (sh.number === "M-501") {
        const plain = svg.replace(/\u00a0/g, " ");
        expect(plain).toContain("CARRIER 50FC-A06");
        expect(plain).toContain("INSULATED ROOF CURB");
        expect(plain).toContain("HOODED WALL CAP");
      }
      if (sh.number === "E-202") {
        expect(svg).toContain("LIGHTING CONTROLS");
        expect(svg).toContain("<a ");
      }
      if (sh.number === "E-203") {
        expect(svg).toContain("PHOTOMETRICS (NORMAL)");
        expect(svg).toContain("EGRESS LIGHTING (NFPA 101)");
        expect(svg).toContain("PHOTOMETRIC SUMMARY SCHEDULE");
        expect(svg).toContain("EMERGENCY / EGRESS LIGHTING COMPLIANCE SCHEDULE");
      }
      if (sh.number === "M-101") {
        // Level 1 Mech HVAC plan uses viewTopRef: "level_above" so 10'-8" plenum trunks show cleanly,
        // and Air Device Schedule + plan display canonical Type Marks (SD-1, RG-1, EG-1).
        expect(svg).toContain("SD-1");
        expect(svg).toContain("RG-1");
        expect(svg).toContain("EG-1");
        expect(svg).toContain("16&quot;x10&quot;");
      }
      if (sh.number === "S-101") {
        expect(svg).toContain("PAD FOOTING SCHEDULE");
        expect(svg).toContain("F1A");
        expect(svg).toContain("C25B");
      }
      if (sh.number === "S-102") {
        expect(svg).toContain("FLOOR DECK (50 PSF LL)");
        expect(svg).toContain("ROOF DECK (20 PSF LL)");
        expect(svg).toContain("W18×35");
      }
      if (sh.number === "S-301") {
        expect(svg).toContain("STRUCTURAL COLUMN SCHEDULE");
        expect(svg).toContain("STRUCTURAL BEAM FRAMING SCHEDULE");
        expect(svg).toContain("W10×33");
        expect(svg).toContain("W16×26");
      }
    }
  });

  it("exercises the full @permitzip/bim-pack-structural gravity load path, column constraints, tributary zones, and footing lint", () => {
    // 1. Level-tied, continuous multi-story, and fixed-height columns preserve exact vertical spans
    const continuous = model.elements["col-l1-1"];
    const l1Grid = model.elements["col-l1-1a"];
    const balcony = model.elements["col-l1-2s"];
    expect(continuous?.kind).toBe("column");
    expect(l1Grid?.kind).toBe("column");
    expect(balcony?.kind).toBe("column");
    if (continuous?.kind === "column" && l1Grid?.kind === "column" && balcony?.kind === "column") {
      // Continuous L1 → ROOF (22'-0" - 4" = 21'-8" = 6604 mm)
      expect(columnVerticalSpan(model.elements, continuous, 0).heightMm).toBeCloseTo(22 * 304.8 - Math.round(4 * 25.4), 0);
      // Level-tied L1 → L2 (12'-0" - 4" = 11'-8" = 3556 mm)
      expect(columnVerticalSpan(model.elements, l1Grid, 0).heightMm).toBeCloseTo(12 * 304.8 - Math.round(4 * 25.4), 0);
      // Explicit fixed-height exterior balcony column (11'-4" = 3454 mm)
      expect(columnVerticalSpan(model.elements, balcony, 0).heightMm).toBeCloseTo(12 * 304.8 - Math.round(8 * 25.4), 0);
    }

    // 2. Full gravity load path: Roof & Floor decks + RTU-1 equipment weight → Beams → Columns → Pad Footings
    const lp = structuralLoadPath(model);
    expect(lp.unsupportedBeamEnds).toEqual([]);
    expect(lp.problems).toEqual([]);
    expect(lp.beams.length).toBeGreaterThanOrEqual(30);
    expect(lp.columns.length).toBe(24);
    expect(lp.footings.length).toBe(15);
    for (const f of lp.footings) {
      expect(f.load.total).toBeGreaterThan(0);
    }
    // RTU-1 (620 lb operating weight on East Roof) transfers into East Studio footings
    expect(lp.footings.some((f) => f.load.equipment > 0)).toBe(true);
    // Continuous column C25B receives both L2 floor and Roof gravity reactions
    const c25bLoad = lp.columns.find((c) => c.id === "col-l1-1");
    expect(c25bLoad?.load.dead ?? 0).toBeGreaterThan(0);
    expect(c25bLoad?.load.live ?? 0).toBeGreaterThan(0);

    // 3. Tributary zones computed for one-way structural deck framing beams
    const frame = frameOf(model);
    const strips = frame.beams.flatMap((b) => beamStrips(frame, b));
    expect(strips.length).toBeGreaterThanOrEqual(10);

    // 4. Structural lint: zero unsupported columns (every L1 column bears on a pad footing)
    expect(footingUnsupportedAll(model)).toEqual([]);
  });

  it("integrates vent trees onto sanitary risers only, never onto domestic water risers", () => {
    const graph = plumbingDiagramGraph(model.elements, {
      systemKinds: ["domestic_cold_water", "domestic_hot_water", "sanitary", "vent"],
    });
    const hasService = (node: (typeof graph.roots)[number], service: string): boolean =>
      node.service === service || node.children.some((c) => hasService(c, service));
    const waterRoots = graph.roots.filter((r) => r.service === "domestic_cold_water");
    const sanitaryRoots = graph.roots.filter((r) => r.service === "sanitary");
    expect(waterRoots.length).toBeGreaterThan(0);
    expect(sanitaryRoots.length).toBeGreaterThan(0);
    for (const w of waterRoots) expect(hasService(w, "vent")).toBe(false);
    expect(sanitaryRoots.some((r) => hasService(r, "vent"))).toBe(true);
  });
  it("keeps legacy createDemoModel('f-a-demo') intact for existing fixtures and E2E specs", () => {
    const legacy = createDemoModel("f-a-demo");
    const legacyEls = elementValues(legacy.elements).filter((el) => !("deleted" in el && el.deleted));
    expect(legacy.modelId).toBe("f-a-demo");
    expect(legacyEls.some((el) => el.kind === "duct_segment")).toBe(true);
    expect(legacyEls.some((el) => el.kind === "sheet")).toBe(false);
  });

  it("showcases floor-hosted floor boxes, view range, per-view hidden elements, filtered >=60A one-line, multi-line leader notes, and locked service gear", () => {
    const fb1 = model.elements["fb-studio-1"];
    const fb2 = model.elements["fb-conf-1"];
    expect(fb1?.kind).toBe("part");
    expect(fb2?.kind).toBe("part");
    if (fb1?.kind === "part" && fb2?.kind === "part") {
      expect(fb1.host).toBeUndefined();
      expect(fb2.host).toBeUndefined();
    }

    const mechL1 = model.elements["view-mech-l1"];
    expect(mechL1?.kind).toBe("view");
    if (mechL1?.kind === "view") {
      expect(mechL1.props?.hiddenElementIds).toContain("cafe-island-l1");
      expect(resolveViewProps(model.elements, mechL1).props.viewTopRef).toBe("level_above");
    }

    const distOneLine = model.elements["view-oneline-dist"];
    expect(distOneLine?.kind).toBe("view");
    if (distOneLine?.kind === "view") {
      expect(distOneLine.props?.diagram?.hints?.minLoadRatingA).toBe(60);
      expect(distOneLine.props?.diagram?.hints?.phaseScope).toBe("new");
      const ev = evaluateDiagram(model.elements, distOneLine);
      expect(ev?.items.length ?? 0).toBeGreaterThan(10);
    }

    expect(model.elements["note-elec-fb1"]?.kind).toBe("drawing_item");
    expect(model.elements["note-elec-clearance"]?.kind).toBe("drawing_item");
    expect(model.elements["sheet-e001"]?.kind).toBe("sheet");
    expect(model.elements["note-e001-general"]?.kind).toBe("drawing_item");
    expect(model.elements["note-e001-demo"]?.kind).toBe("drawing_item");

    // Verify E-101 renders merged NEC 110.26 working-space clearances cleanly in halftone dashed lines
    const e101 = buildSheetSceneFor(model, "sheet-e101", { projectName: "MutinyBIM Showcase" });
    const e101Svg = sceneToSvg(e101);
    expect(e101Svg).toContain("110.26");
    expect(e101Svg).toContain('stroke-dasharray="2.2 1.2"');

    // Verify E-001 renders the Standard General Notes library blocks
    const e001 = buildSheetSceneFor(model, "sheet-e001", { projectName: "MutinyBIM Showcase" });
    const e001Svg = sceneToSvg(e001);
    expect(e001Svg).toContain("ELECTRICAL");

    // Verify One-Line diagram renders existing-phase SD-1(E) in halftone and demolished SD-2(D) dashed + halftone,
    // AND intelligently shrinks a panel bus bar when child loads are squished closer together via nodeOffsets.
    const fullOneLine = model.elements["view-oneline"];
    expect(fullOneLine?.kind).toBe("view");
    if (fullOneLine?.kind === "view") {
      const ev = evaluateDiagram(model.elements, fullOneLine);
      expect(ev?.items.some((it) => it.lineStyle?.tone === "halftone" && it.lineStyle?.pattern !== "dashed")).toBe(true);
      expect(ev?.items.some((it) => it.lineStyle?.tone === "halftone" && it.lineStyle?.pattern === "dashed")).toBe(true);

      const heavyHorizSpans = (items: readonly { shape: string; points: readonly { x: number; y: number }[]; lineStyle?: { weight?: string } }[]) =>
        items
          .filter((it) => it.shape === "line" && it.lineStyle?.weight === "heavy" && it.points.length >= 2 && Math.abs(it.points[0]!.y - it.points[1]!.y) < 0.2)
          .map((it) => Math.abs(it.points[1]!.x - it.points[0]!.x))
          .reduce((sum, w) => sum + w, 0);

      const totalBusBefore = heavyHorizSpans(ev?.items ?? []);
      expect(totalBusBefore).toBeGreaterThan(50);
      const squishedView = {
        ...fullOneLine,
        props: {
          ...fullOneLine.props,
          diagram: {
            ...fullOneLine.props?.diagram!,
            hints: {
              ...fullOneLine.props?.diagram?.hints,
              pins: {
                "hw-mep-1": { dx: 30, dy: 0 },
                "rec-tl": { dx: -30, dy: 0 },
              },
            },
          },
        },
      };
      const evAfter = evaluateDiagram(model.elements, squishedView);
      const totalBusAfter = heavyHorizSpans(evAfter?.items ?? []);
      expect(totalBusAfter).toBeLessThan(totalBusBefore - 10);
    }

    // Verify Lighting Plan & Lighting Controls Plan both use chamfered orthogonal wire routing
    const ltg = model.elements["view-elec-ltg"];
    expect(ltg?.kind).toBe("view");
    if (ltg?.kind === "view") {
      expect((resolveViewProps(model.elements, ltg).props as { circuitGraphics?: { style?: string } }).circuitGraphics?.style).toBe("chamfered");
    }
    const ctrl = model.elements["view-elec-ctrl"];
    expect(ctrl?.kind).toBe("view");
    if (ctrl?.kind === "view") {
      expect((ctrl.props as { circuitGraphics?: { style?: string } } | undefined)?.circuitGraphics?.style).toBe("chamfered");
    }

    // Verify special-purpose NEMA 6-20R, Twist-Lock, and Hardwired devices + home-run callouts + hideDeviceMarks on E-101
    expect(model.elements["rec-240v"]?.kind).toBe("part");
    expect(model.elements["rec-tl"]?.kind).toBe("part");
    expect(model.elements["hw-mep-1"]?.kind).toBe("part");
    expect(e101Svg).toContain("240V");
    expect(e101Svg).toContain("#10 CU");
    expect(e101Svg).toContain("(BL)");
    const powerView = model.elements["view-elec-power"];
    expect(powerView?.kind).toBe("view");
    if (powerView?.kind === "view") {
      expect(resolveViewProps(model.elements, powerView).props.hideDeviceMarks).toBe(true);
    }

    // Verify per-equipment includeEquipmentIds pins RTU-1 (25A) onto the >=60A Distribution One-Line
    const dist60 = model.elements["view-oneline-dist"];
    expect(dist60?.kind).toBe("view");
    if (dist60?.kind === "view") {
      const ev60 = evaluateDiagram(model.elements, dist60);
      expect(ev60?.equipment).toContain("rtu-1");
    }

    // Verify PR #151 + PR #171 live-load vs total-load elastic beam deflection wired into gravity load path + Sheet S-301
    const lp = structuralLoadPath(model);
    const loadedWithDefl = lp.beams.filter((b) => b.maxDeflection !== undefined && b.maxDeflection > 0);
    const loadedWithLiveDefl = lp.beams.filter((b) => b.maxLiveDeflection !== undefined && b.maxLiveDeflection > 0);
    expect(loadedWithDefl.length).toBeGreaterThanOrEqual(12);
    expect(loadedWithLiveDefl.length).toBeGreaterThanOrEqual(12);
    // Clear-span 22' East Studio roof girder G2-B4 carries deck live load + RTU-1 equipment point load -> total > live deflection
    const g2b4 = lp.beams.find((b) => b.id === "bm-l2-b4");
    expect(g2b4?.maxLiveDeflection).toBeGreaterThan(0);
    expect(g2b4?.maxDeflection).toBeGreaterThan(g2b4!.maxLiveDeflection! * 1.15);
    // L2 office floor girder G2-B1 and L2 south balcony beam B2-S1 both carry non-zero live load deflection
    const g2b1 = lp.beams.find((b) => b.id === "bm-l2-b1");
    expect(g2b1?.maxLiveDeflection).toBeGreaterThan(0);
    expect(g2b1?.maxDeflection).toBeGreaterThan(g2b1!.maxLiveDeflection!);
    const b2s1 = lp.beams.find((b) => b.id === "bm-l2-s1");
    expect(b2s1?.maxLiveDeflection).toBeGreaterThan(0);
    expect(b2s1?.maxDeflection).toBeGreaterThan(b2s1!.maxLiveDeflection!);

    const s301 = model.elements["sheet-s301"];
    expect(s301?.kind).toBe("sheet");
    if (s301?.kind === "sheet") {
      const s301Scene = buildSheetSceneFor(model, s301.id, { projectName: "MutinyBIM Showcase" });
      const s301Svg = sceneToSvg(s301Scene);
      expect(s301Svg).toContain("LIVE DEFL.");
      expect(s301Svg).toContain("LIVE L/Δ");
      expect(s301Svg).toContain("TOTAL DEFL.");
      expect(s301Svg).toContain("TOTAL L/Δ");
      expect(s301Svg).toContain("L/1032");
      expect(s301Svg).toContain("L/877");
      expect(s301Svg).toContain("L/754");
      expect(s301Svg.replace(/\u00a0/g, " ")).toContain("STRUCTURAL DEFLECTION &amp; LOAD PATH BASIS");
      // Verify the two placed schedule viewports on Arch D Sheet S-301 do not overlap horizontally and fit inside the titleblock margin
      const colVp = model.elements["vp-sched-columns"];
      const bmVp = model.elements["vp-sched-beams"];
      const colPaper = scheduleV2Paper(model, COLUMN_SCHEDULE);
      const bmPaper = scheduleV2Paper(model, BEAM_SCHEDULE);
      expect(colVp?.kind).toBe("viewport");
      expect(bmVp?.kind).toBe("viewport");
      expect(colPaper.kind).toBe("list");
      expect(bmPaper.kind).toBe("list");
      if (colVp?.kind === "viewport" && bmVp?.kind === "viewport" && colPaper.kind === "list" && bmPaper.kind === "list") {
        const colW = colPaper.table.columnWidths.reduce((a, b) => a + b, 0);
        const bmW = bmPaper.table.columnWidths.reduce((a, b) => a + b, 0);
        expect(colVp.center.x + colW / 2).toBeLessThan(bmVp.center.x - bmW / 2);
        expect(bmVp.center.x + bmW / 2).toBeLessThan(815);
      }
    }

    // Verify first-class View Templates and full discipline tagging across Showcase views, schedules, and diagrams
    const docs = documentIndex(model);
    expect(docs.viewTemplates.map((t) => t.id).sort()).toEqual([
      "vt-arch-plan",
      "vt-elec-lighting",
      "vt-elec-power",
      "vt-mech-hvac",
      "vt-plumb-dwv",
      "vt-plumb-water",
    ]);
    const mechPlan = model.elements["view-mech-l1"];
    expect(mechPlan?.kind).toBe("view");
    if (mechPlan?.kind === "view") {
      const resolvedMech = resolveViewProps(model.elements, mechPlan);
      expect(resolvedMech.template?.id).toBe("vt-mech-hvac");
      expect(resolvedMech.props.viewTopRef).toBe("level_above");
      expect(resolvedMech.props.discipline).toBe("mechanical");
      // Hidden-line overhead ducts emit opaque white mask fills over walls/furniture below
      const mechBuilt = buildViewScene(model, mechPlan.id);
      const whiteMasks = mechBuilt.scene.primitives.filter((pr) => pr.kind === "fill" && pr.grey === 1);
      expect(whiteMasks.length).toBeGreaterThan(10);
      // Type-mark GRDs (SD-1, RG-1) expose draggable auto-mark hit boxes and promote cleanly into mark tags
      const mechMarks = planAutoPartMarks(model, mechPlan, mechBuilt.frame);
      expect(mechMarks.some((h) => h.text === "SD-1")).toBe(true);
      expect(mechMarks.some((h) => h.text === "RG-1")).toBe(true);
      const sdHit = mechMarks.find((h) => h.text === "SD-1")!;
      expect(tagLines(model, { elementId: sdHit.partId, template: "mark", leader: false })).toEqual(["SD-1"]);
    }
    const elecPower = model.elements["view-elec-power"];
    expect(elecPower?.kind).toBe("view");
    if (elecPower?.kind === "view") {
      const resolvedElec = resolveViewProps(model.elements, elecPower);
      expect(resolvedElec.template?.id).toBe("vt-elec-power");
      expect((resolvedElec.props as Record<string, unknown>).circuitGraphics).toEqual({
        style: "chamfered",
        hashMarksOn: "home_runs",
      });
      // Wire & home-run interactive picking resolves through the bound View Template automatically
      const shownElec = visiblePlanParts(model, elecPower);
      expect(circuitJoinsOnPaper(model, elecPower, shownElec, 96, (pt) => pt).length).toBeGreaterThan(0);
      expect(circuitHomeRunsOnPaper(model, elecPower, shownElec, 96, (pt) => pt).length).toBeGreaterThan(0);
    }
    // Roof / L2 Electrical Power Plan: SD-RTU-1 is wall-mounted on East parapet, RTU-1 connects to SD-RTU-1
    // with a branch wire, and the home run leaves SD-RTU-1 labelled HP-1-1,3,5 (never "SD-RTU-1 to RTU-1").
    const discRtu = model.elements["disc-rtu-1"];
    expect(discRtu?.kind).toBe("part");
    if (discRtu?.kind === "part") {
      expect(discRtu.host?.kind).toBe("wall_face");
      const discType = model.elements[discRtu.typeId];
      expect(discType?.kind).toBe("part_type");
      if (discType?.kind === "part_type") {
        expect(discType.definition.hosting).toBe("wall_face");
      }
    }
    const elecL2 = model.elements["view-elec-power-l2"];
    expect(elecL2?.kind).toBe("view");
    if (elecL2?.kind === "view") {
      const shownL2 = visiblePlanParts(model, elecL2);
      const joinsL2 = circuitJoinsOnPaper(model, elecL2, shownL2, 96, (pt) => pt);
      const hrsL2 = circuitHomeRunsOnPaper(model, elecL2, shownL2, 96, (pt) => pt);
      // Branch wire connects RTU-1 <-> SD-RTU-1
      const rtuToDisc = joinsL2.find(
        (j) =>
          (j.a === "rtu-1" && j.b === "disc-rtu-1") ||
          (j.a === "disc-rtu-1" && j.b === "rtu-1"),
      );
      expect(rtuToDisc).toBeDefined();
      // Home run originates at SD-RTU-1 (disc-rtu-1) and carries upstream panel circuit HP-1-1,3,5
      const rtuHr = hrsL2.find((h) => h.memberId === "disc-rtu-1");
      expect(rtuHr).toBeDefined();
      expect(rtuHr!.label).toContain("HP-1-1,3,5");
      expect(hrsL2.some((h) => h.label.includes("SD-RTU-1 to RTU-1"))).toBe(false);
    }
    const missingDisciplineViews = docs.views
      .filter((v) => v.viewType !== "three_d")
      .filter((v) => !resolveViewProps(model.elements, v).props.discipline)
      .map((v) => v.id);
    expect(missingDisciplineViews).toEqual([]);

    // Verify new-feature showcase coverage:
    // 1. Live feeder kVA demand load tags enabled on both One-Line diagrams (#168)
    const olFull = model.elements["view-oneline"];
    const olDist = model.elements["view-oneline-dist"];
    expect(olFull?.kind === "view" && olFull.props?.diagram?.hints?.showLinkLoads).toBe(true);
    expect(olDist?.kind === "view" && olDist.props?.diagram?.hints?.showLinkLoads).toBe(true);

    // 2. Structured electrical.disconnect pack parameters populated on RTU-1 and WH-1 (#165)
    const rtu1 = model.elements["rtu-1"];
    const wh1 = model.elements["wh-1"];
    expect(rtu1?.kind === "part" && rtu1.values?.["electrical.disconnect_required"]).toBe(true);
    expect(rtu1?.kind === "part" && rtu1.values?.["electrical.local_disconnect"]).toBe("required");
    expect(wh1?.kind === "part" && wh1.values?.["electrical.disconnect_required"]).toBe(false);
    expect(wh1?.kind === "part" && wh1.values?.["electrical.local_disconnect"]).toBe("not_required");

    // 3. Drafted Mechanical Details on Sheet M-501 pass automated CAD overlap & crop QA cleanly
    const rtuQa = checkDetailView(model, "view-detail-rtu-curb");
    const fanQa = checkDetailView(model, "view-detail-ef-wall");
    expect(rtuQa.textOverlaps).toEqual([]);
    expect(rtuQa.lineCrossings).toEqual([]);
    expect(rtuQa.clippedItems).toEqual([]);
    expect(rtuQa.orphanedDimensions).toEqual([]);
    expect(rtuQa.clean).toBe(true);
    expect(fanQa.textOverlaps).toEqual([]);
    expect(fanQa.lineCrossings).toEqual([]);
    expect(fanQa.clippedItems).toEqual([]);
    expect(fanQa.orphanedDimensions).toEqual([]);
    expect(fanQa.clean).toBe(true);

    // 4. U-stair connects L1 (0) -> L2 (3658 mm), skips non-story L1_CLG datum, meets IBC riser/tread specs, and lands flush at L2 stairwell edge
    const stair = asStair(model.elements["stair-main"]!);
    expect(stair).not.toBeNull();
    const sg = stair ? stairGeometry(stair, model.elements) : null;
    expect(sg).not.toBeNull();
    expect(sg!.topLevelId).toBe("L2");
    expect(sg!.heightMm).toBe(Math.round(12 * 304.8));
    expect(sg!.riserMm).toBeLessThanOrEqual(178);
    const sl = stairLayout(stair!, sg!, 0);
    expect(sl.flights.length).toBe(2);
    expect(sl.flights[0]!.treadMm).toBeGreaterThanOrEqual(280);
    expect(sl.flights[1]!.treadMm).toBeGreaterThanOrEqual(280);
    expect(sl.flights[0]!.riserMm).toBeLessThanOrEqual(178);
    expect(sl.flights[1]!.riserMm).toBeLessThanOrEqual(178);
    expect(sl.flights[1]!.z1).toBe(Math.round(12 * 304.8));
    // Upper flight arrives heading South (-y) flush onto the south edge of the L2 stairwell hole (y = 15.2 ft = 4633 mm) opening directly into the L2 Loft
    expect(sl.flights[1]!.u.y).toBeCloseTo(-1, 3);
    expect(Math.abs(sl.flights[1]!.end.y - Math.round(15.2 * 304.8))).toBeLessThanOrEqual(5);

    // 5. First-class `architecture.railing` (IfcRailing) 42" glass guardrails protect L2 balcony & stairwell opening
    for (const rid of ["rail-l2-balcony", "rail-l2-stair-w", "rail-l2-stair-s"]) {
      const r = asRailing(model.elements[rid]!);
      expect(r).not.toBeNull();
      const spec = railingSpec(r!, model.elements);
      expect(spec.style).toBe("glass");
      expect(spec.heightMm).toBeGreaterThanOrEqual(1067);
      expect(railingCompliance(r!, model.elements).compliant).toBe(true);
    }
    expect(railingSpec(asRailing(model.elements["rail-l2-balcony"]!)!, model.elements).path).toHaveLength(4);

    // 6. L2 Architectural Plan renders the L1→L2 stair (`DN` + treads) even with non-story L1_CLG datum between L1 and L2
    const l2Svg = sceneToSvg(buildViewScene(model, "view-plan-l2").scene);
    expect(l2Svg).toContain(">DN<");
  });
});
