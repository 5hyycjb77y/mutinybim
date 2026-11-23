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
import { buildSheetSceneFor, elementValues, evaluateDiagram, resolveElementMaterial, sceneToSvg, validateModel } from "@permitzip/bim-kernel";
import { evaluateEgressPhotometrics, evaluateNormalPhotometrics } from "@permitzip/bim-pack-electrical";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { plumbingDiagramGraph } from "@permitzip/bim-pack-plumbing";
import { createShowcaseDemoModel } from "../src/seed";

describe("createShowcaseDemoModel", () => {
  const model = createShowcaseDemoModel("showcase-test");
  const active = elementValues(model.elements).filter((el) => !("deleted" in el && el.deleted));

  it("passes model validation cleanly with coordinated architecture and MEP elements", () => {
    expect(model.modelId).toBe("showcase-test");
    expect(validateModel(model)).toEqual([]);

    const count = (kind: string) => active.filter((el) => el.kind === kind).length;
    expect(count("level")).toBe(3);
    expect(count("wall")).toBeGreaterThanOrEqual(25);
    expect(count("opening")).toBeGreaterThanOrEqual(17);
    expect(count("space")).toBe(9);
    expect(count("grid")).toBe(7);
    expect(count("architecture.roof")).toBe(2);
    expect(count("architecture.stair")).toBe(1);
    expect(count("part")).toBeGreaterThanOrEqual(70);
    expect(count("run_segment")).toBeGreaterThanOrEqual(45);
    expect(count("service_link")).toBeGreaterThanOrEqual(12);

    // Cut-sheet commercial equipment, fixtures & millwork resolve smooth non-ribbed PBR materials
    for (const id of ["rtu-1", "ef-1", "wh-1", "wc-101", "lav-101", "ks-101", "sd-1", "lt-4", "wp-1", "vanity-l1", "cafe-island-l1"]) {
      const el = model.elements[id];
      expect(el).toBeDefined();
      const mat = el ? resolveElementMaterial(model, el) : null;
      expect(mat?.id).toBeTruthy();
      expect(mat?.pattern).toBe("solid");
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

    // All horizontal L1 plenum ducts sit cleanly above 9'-6" ceiling (2896 mm) and below 11'-4" deck underside (3454 mm)
    const ducts = active.filter((el): el is Extract<typeof el, { kind: "run_segment" }> => el.kind === "run_segment" && el.domain === "duct");
    for (const d of ducts) {
      const isHoriz = Math.abs(d.start.z - d.end.z) < 20;
      if (isHoriz && d.start.z < 3658) {
        const halfH = d.size.shape === "rect" ? d.size.height / 2 : d.size.shape === "round" ? d.size.diameter / 2 : 0;
        expect(d.start.z - halfH).toBeGreaterThanOrEqual(2896);
        expect(d.start.z + halfH).toBeLessThanOrEqual(3454);
      }
    }

    // Real `connect_into` flex connectors for SD-1..SD-4 + RG-1..RG-2
    const flexSegments = ducts.filter((d) => d.id.includes("-flex"));
    expect(flexSegments.length).toBe(12);
  });

  it("circuits RTU-1, WH-1, EF-1, and interior + exterior luminaires and populates all 6 live diagrams", () => {
    const links = active.filter((el): el is Extract<typeof el, { kind: "service_link" }> => el.kind === "service_link");
    const hasMember = (sourceId: string, elementId: string) =>
      links.some((l) => l.source.elementId === sourceId && l.members.some((m) => m.elementId === elementId));

    expect(hasMember("hp-1", "rtu-1")).toBe(true);
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

    // Discipline & system filters use canonical category and service:<id> keys
    const archL1 = views.find((v) => v.id === "view-plan-l1");
    expect(archL1?.props?.categoryOverrides?.duct?.visible).toBe(false);
    expect(archL1?.props?.categoryOverrides?.lighting_fixtures?.visible).toBe(false);

    const powerL1 = views.find((v) => v.id === "view-elec-power");
    expect(powerL1?.props?.categoryOverrides?.["electrical.lighting_control"]?.visible).toBe(false);

    const lightingL1 = views.find((v) => v.id === "view-elec-ltg");
    expect(lightingL1?.props?.categoryOverrides?.["electrical.receptacle"]?.visible).toBe(false);

    const waterL1 = views.find((v) => v.id === "view-plumb-water-l1");
    expect(waterL1?.props?.categoryOverrides?.["service:sanitary"]?.visible).toBe(false);
    expect(waterL1?.props?.categoryOverrides?.["service:vent"]?.visible).toBe(false);

    const dwvL1 = views.find((v) => v.id === "view-plumb-dwv-l1");
    expect(dwvL1?.props?.categoryOverrides?.["service:domestic_cold_water"]?.visible).toBe(false);
    expect(dwvL1?.props?.categoryOverrides?.["service:domestic_hot_water"]?.visible).toBe(false);

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

  it("renders all 13 Arch D sheets cleanly with no unresolved callout references and verified passing normal + egress photometrics", () => {
    const sheets = active.filter((el): el is Extract<typeof el, { kind: "sheet" }> => el.kind === "sheet");
    expect(sheets.map((s) => s.number).sort()).toEqual([
      "A-101",
      "A-102",
      "A-103",
      "A-104",
      "A-201",
      "A-301",
      "E-101",
      "E-201",
      "E-202",
      "M-101",
      "M-201",
      "P-101",
      "P-102",
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
      expect(scene.primitives.length).toBeGreaterThan(200);
      const svg = sceneToSvg(scene);
      expect(svg).toContain("<svg");
      expect(svg).not.toContain("?? DIMENSION REFERENCE MISSING");
      if (sh.number === "E-202") {
        expect(svg).toContain("PHOTOMETRICS (NORMAL)");
        expect(svg).toContain("EGRESS LIGHTING (NFPA 101)");
        expect(svg).toContain("PHOTOMETRIC SUMMARY SCHEDULE");
        expect(svg).toContain("EMERGENCY / EGRESS LIGHTING COMPLIANCE SCHEDULE");
      }
    }
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
});
