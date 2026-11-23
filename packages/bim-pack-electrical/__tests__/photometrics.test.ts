/**
 * @jest-environment node
 *
 * Deterministic unit, physics, compliance, rendering, and performance tests for
 * native IES LM-63 photometrics & normal + NFPA 101 / IBC emergency egress lighting.
 */
import { builtinCalcRegistry } from "@permitzip/bim-calc";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import {
  BUILTIN_LIBRARY_VERSION,
  DEFAULT_SETTINGS,
  PARTS_LONG_TEXT_VALUES_FEATURE,
  VIEWPORT_NORTH_ARROW_OFFSET_FEATURE,
  asElementId,
  buildSheetSceneFor,
  builtinFormTemplate,
  builtinPartType,
  executeCommand,
  evaluateFormSchedule,
  sceneToSvg,
  withUpgradePolicy,
  type Command,
  type ModelState,
  type Revision,
  type ViewElement,
} from "@permitzip/bim-kernel";
import { LintEngine, readLintConfig } from "@permitzip/bim-lint";
import {
  BUILTIN_IES_PROFILES,
  BUILTIN_IES_PROFILE_IDS,
  cachedParseIesFile,
  evaluateEgressPhotometrics,
  evaluateNormalPhotometrics,
  exportRadianceScene,
  extractIsoContours,
  hexColorToLrv,
  materialReflectance,
  materialTransmittance,
  parseIesFile,
  radianceGlassTransmissivity,
  sampleCandela,
  sampleCandelaDirection,
  sampleTiltFactor,
} from "@permitzip/bim-pack-electrical";

const FT = 304.8;

installFirstPartyAddOns();

function runCmds(initial: ModelState, commands: readonly Command[]): ModelState {
  return withUpgradePolicy(
    () => true,
    () => {
      let m = initial;
      for (const cmd of commands) {
        const res = executeCommand(m, cmd);
        if (!res.ok) throw new Error(`${cmd.type} failed: ${res.error.code} — ${res.error.message}`);
        m = res.model;
      }
      return m;
    },
  );
}

function emptyModel(id = "phot-test"): ModelState {
  return runCmds(
    {
      modelId: id,
      revision: 0 as Revision,
      elements: {},
      connections: [],
      settings: DEFAULT_SETTINGS,
    },
    [{ type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 }],
  );
}

describe("IES LM-63-1995 / LM-63-2002 / ANSI/IES LM-63-19 parser & photometric web", () => {
  it("parses LM-63-2002 Type C quadrant symmetry and matches hand-computed bilinear candela lookups", () => {
    const ies = `IESNA:LM-63-2002
[TEST] HAND-QUAD-001
[MANUFAC] PermitZIP Test Lab
[LUMCAT] PZ-Q90
[LUMINAIRE] Quadrant Symmetric Test Fixture
[LAMP] 1x LED 2000lm
TILT=NONE
1 2000 1.25 4 3 1 1 2.0 4.0 0.25
0.95 1.0 24.0
0 30 60 90
0 45 90
1000 800 400 0
1000 900 500 0
1000 1000 600 0
`;
    const web = parseIesFile(ies);
    expect(web.standard).toBe("LM-63-2002");
    expect(web.symmetry).toBe("quadrant");
    expect(web.metadata.test).toBe("HAND-QUAD-001");
    expect(web.metadata.manufac).toBe("PermitZIP Test Lab");
    expect(web.metadata.lumcat).toBe("PZ-Q90");
    expect(web.metadata.luminaire).toBe("Quadrant Symmetric Test Fixture");
    expect(web.metadata.lamp).toBe("1x LED 2000lm");
    expect(web.lampCount).toBe(1);
    expect(web.lumensPerLamp).toBe(2000);
    expect(web.inputWatts).toBe(24);
    expect(web.candelaScale).toBeCloseTo(1.25 * 0.95, 6);
    expect(web.widthM).toBeCloseTo(2 * 0.3048, 5);
    expect(web.lengthM).toBeCloseTo(4 * 0.3048, 5);

    // Exact node at (theta=30, phi=45): raw 900 * 1.25 * 0.95 = 1068.75 cd
    expect(sampleCandela(web, 30, 45)).toBeCloseTo(900 * 1.25 * 0.95, 5);

    // Midpoint bilinear interpolation at (theta=45, phi=22.5):
    // phi=0: lerp(800, 400, 0.5) = 600
    // phi=45: lerp(900, 500, 0.5) = 700
    // phi=22.5: lerp(600, 700, 0.5) = 650 -> scaled = 650 * 1.1875 = 771.875 cd
    const expectedMid = 650 * 1.25 * 0.95;
    expect(sampleCandela(web, 45, 22.5)).toBeCloseTo(expectedMid, 5);

    // Quadrant symmetry mirroring: phi = 22.5°, 157.5°, 202.5°, 337.5° must all match identically!
    expect(sampleCandela(web, 45, 157.5)).toBeCloseTo(expectedMid, 5);
    expect(sampleCandela(web, 45, 202.5)).toBeCloseTo(expectedMid, 5);
    expect(sampleCandela(web, 45, 337.5)).toBeCloseTo(expectedMid, 5);

    // Above 90° on direct-only luminaire returns 0
    expect(sampleCandela(web, 100, 0)).toBe(0);
  });

  it("handles axial (0°), bilateral (0°–180°), and full asymmetric (0°–360°) Type C symmetries", () => {
    const axial = parseIesFile(`IESNA:LM-63-2002
TILT=NONE
1 1000 1.0 3 1 1 2 0.2 0.2 0.0
1.0 1.0 10.0
0 45 90
0
500 300 0
`);
    expect(axial.symmetry).toBe("axial");
    expect(sampleCandela(axial, 22.5, 0)).toBeCloseTo(400, 5);
    expect(sampleCandela(axial, 22.5, 137)).toBeCloseTo(400, 5);
    expect(sampleCandela(axial, 22.5, 311)).toBeCloseTo(400, 5);

    const bilateral = parseIesFile(`ANSI/IES LM-63-19
[TEST] BI-180
[MORE] Continuation Line
TILT=NONE
1 -1 1.0 3 3 1 2 0.3 0.3 0.1
1.0 2.0 18.0
0 45 90
0 90 180
400 300 0
400 200 0
400 100 0
`);
    expect(bilateral.standard).toBe("LM-63-19");
    expect(bilateral.symmetry).toBe("bilateral_0_180");
    // LM-63-19 fileGenerationType=2.0 must NOT scale candela!
    expect(bilateral.candelaScale).toBeCloseTo(1.0, 6);
    expect(bilateral.metadata.test).toBe("BI-180 Continuation Line");
    // Absolute photometry (lumensPerLamp = -1) integrates positive lumens
    expect(bilateral.totalLumens).toBeGreaterThan(500);
    // Bilateral mirroring around 0°–180°: phi=60° equals phi=300°; phi=120° equals phi=240°
    expect(sampleCandela(bilateral, 45, 60)).toBeCloseTo(sampleCandela(bilateral, 45, 300), 5);
    expect(sampleCandela(bilateral, 45, 120)).toBeCloseTo(sampleCandela(bilateral, 45, 240), 5);
    expect(sampleCandela(bilateral, 45, 0)).toBeCloseTo(300, 5);
    expect(sampleCandela(bilateral, 45, 180)).toBeCloseTo(100, 5);

    const asym = parseIesFile(`IESNA:LM-63-1995
[TEST] ASYM-360
TILT=INCLUDE
1
3
0 45 90
1.0 0.9 0.7
1 1500 1.0 2 4 1 1 1.0 1.0 0.5
1.0 0.95 20.0
0 90
0 90 180 270
100 200
100 400
100 600
100 800
`);
    expect(asym.standard).toBe("LM-63-1995");
    expect(asym.symmetry).toBe("asymmetric");
    // LM-63-1995 applies ballastLampPhotometricFactor (0.95)
    expect(asym.candelaScale).toBeCloseTo(0.95, 6);
    expect(asym.tiltMode).toBe("INCLUDE");
    expect(sampleTiltFactor(asym, 22.5)).toBeCloseTo(0.95, 5);
    // Wrap-around interpolation between 270° (800) and 360°=0° (200) -> midpoint 315° = 500 * 0.95 = 475
    expect(sampleCandela(asym, 90, 315)).toBeCloseTo(500 * 0.95, 5);
  });

  it("supports Type B and Type A photometric webs and ships 5 valid built-in IES profiles", () => {
    const typeB = parseIesFile(`IESNA:LM-63-2002
TILT=NONE
1 2000 1.0 3 3 2 1 1.0 1.0 0.5
1.0 1.0 25.0
-45 0 45
0 30 60
200 600 200
150 450 150
80 200 80
`);
    expect(typeB.photometricType).toBe(2);
    expect(sampleCandelaDirection(typeB, 0, 0, -1)).toBeCloseTo(600, 4);

    expect(BUILTIN_IES_PROFILE_IDS.length).toBe(5);
    for (const id of BUILTIN_IES_PROFILE_IDS) {
      const profile = BUILTIN_IES_PROFILES[id];
      const web = cachedParseIesFile(profile.iesText);
      expect(web.maxCandela).toBeGreaterThan(50);
      expect(web.totalLumens).toBeCloseTo(profile.ratedLumens, -1);
      expect(web.inputWatts).toBe(profile.inputWatts);
    }
  });
});

describe("Point-by-point inverse-square physics, 3D wall occlusion & inter-reflectance", () => {
  it("matches exact hand-computed E = (I(theta,phi) * LLF * cos^3(theta)) / h^2 and blocks light bleed through opaque walls", () => {
    // Pure constant-candela 1000 cd downward hemisphere IES file for exact analytical verification
    const constant1000CdIes = `IESNA:LM-63-2002
[TEST] ANALYTICAL-1000CD
TILT=NONE
1 6283 1.0 3 1 1 1 0.5 0.5 0.0
1.0 1.0 20.0
0 45 90
0
1000 1000 1000
`;
    const troffer = builtinPartType("builtin:troffer-2x4-led@1")!;
    // Two adjacent 10'×10' rooms separated by an opaque solid wall at x = 10'
    // Room A (x=0..10', y=0..10') has 1 fixture centered at (5', 5') mounted at Z = 10'-6" (h = 8.0 ft above 30" workplane)
    // Room B (x=10'..20', y=0..10') has ZERO fixtures -> must receive EXACTLY 0.00 fc because of opaque wall!
    let m = emptyModel("physics-test");
    m = runCmds(m, [
      { type: "save_part_types", types: [{ typeId: troffer.id, definition: troffer.definition }] },
      {
        type: "add_architecture",
        levelId: "L1",
        walls: [
          { wallId: "w-s", start: { x: 0, y: 0 }, end: { x: 20 * FT, y: 0 }, thicknessMm: 150, heightMm: 3600 },
          { wallId: "w-n", start: { x: 0, y: 10 * FT }, end: { x: 20 * FT, y: 10 * FT }, thicknessMm: 150, heightMm: 3600 },
          { wallId: "w-w", start: { x: 0, y: 0 }, end: { x: 0, y: 10 * FT }, thicknessMm: 150, heightMm: 3600 },
          { wallId: "w-e", start: { x: 20 * FT, y: 0 }, end: { x: 20 * FT, y: 10 * FT }, thicknessMm: 150, heightMm: 3600 },
          { wallId: "w-div", start: { x: 10 * FT, y: 0 }, end: { x: 10 * FT, y: 10 * FT }, thicknessMm: 150, heightMm: 3600 },
        ],
        rooms: [
          {
            roomId: "rm-a",
            number: "101",
            name: "Lit Office",
            outline: [
              { x: 0, y: 0 },
              { x: 10 * FT, y: 0 },
              { x: 10 * FT, y: 10 * FT },
              { x: 0, y: 10 * FT },
            ],
          },
          {
            roomId: "rm-b",
            number: "102",
            name: "Dark Adjacent Office",
            outline: [
              { x: 10 * FT, y: 0 },
              { x: 20 * FT, y: 0 },
              { x: 20 * FT, y: 10 * FT },
              { x: 10 * FT, y: 10 * FT },
            ],
          },
        ],
        openings: [],
        casework: [],
      },
      {
        type: "place_part",
        partId: "fix-1",
        typeId: troffer.id,
        levelId: "L1",
        position: { x: 5 * FT, y: 5 * FT },
        offsetMm: 10.5 * FT, // 10'-6" mounting -> h = 8'-0" above 2'-6" (30") workplane
        mark: "F1",
      },
      {
        type: "set_element_values",
        elementIds: ["fix-1"],
        values: {
          "electrical.ies_file": constant1000CdIes,
          "electrical.llf": 0.8,
        },
      },
    ]);

    // Direct-only (interReflectance: false) analytical verification
    const directRes = evaluateNormalPhotometrics(m, {
      gridSpacingFt: 2,
      workplaneHeightIn: 30,
      interReflectance: false,
    });
    const rmA = directRes.spaces.find((s) => s.spaceId === "rm-a")!;
    const rmB = directRes.spaces.find((s) => s.spaceId === "rm-b")!;

    // Center point (5', 5') is directly at nadir: theta = 0, cos^3(0) = 1, h = 8 ft
    // Hand math: E = (1000 * 0.8 * 1^3) / 8^2 = 800 / 64 = 12.50 fc!
    const centerPt = rmA.gridPoints.find((p) => Math.abs(p.xMm - 5 * FT) < 1 && Math.abs(p.yMm - 5 * FT) < 1)!;
    expect(centerPt).toBeDefined();
    expect(centerPt.fc).toBeCloseTo(12.5, 2);

    // Off-axis point at (1', 5'): horiz = 4 ft, h = 8 ft -> d = sqrt(80), cos(theta) = 8/sqrt(80)
    // E = (1000 * 0.8 * (8/sqrt(80))^3) / 8^2 = 800 * 8 / (80^1.5) = 6400 / 715.54175 = 8.944 fc
    const sidePt = rmA.gridPoints.find((p) => Math.abs(p.xMm - 1 * FT) < 1 && Math.abs(p.yMm - 5 * FT) < 1)!;
    expect(sidePt).toBeDefined();
    expect(sidePt.fc).toBeCloseTo(8.94, 1);

    // Wall occlusion: Room B behind opaque wall w-div MUST receive ZERO light bleed!
    expect(rmB.maxFc).toBe(0);
    expect(rmB.avgFc).toBe(0);

    // Inter-reflectance (80/50/20) must strictly increase room A illuminance above direct-only
    const bouncedRes = evaluateNormalPhotometrics(m, {
      gridSpacingFt: 2,
      workplaneHeightIn: 30,
      interReflectance: true,
    });
    const rmABounced = bouncedRes.spaces.find((s) => s.spaceId === "rm-a")!;
    expect(rmABounced.reflectedFc).toBeGreaterThan(2.0);
    expect(rmABounced.avgFc).toBeGreaterThan(rmA.avgFc + 2.0);
  });
});

describe("NFPA 101 §7.9.2.1 / IBC §1008.3.5 emergency egress pass/fail, calcs, schedules, lint & SVG overlay", () => {
  function buildCorridorModel(opts: {
    emergencyMode: "none" | "battery_pack" | "generator_circuit";
    emergencyLumens?: number;
    fixtureCount: 1 | 2;
  }): ModelState {
    const troffer = builtinPartType("builtin:troffer-2x4-led-em@1")!;
    let m = emptyModel("egress-corridor");
    const fixtures: Command[] = [
      { type: "save_part_types", types: [{ typeId: troffer.id, definition: troffer.definition }] },
      {
        type: "add_architecture",
        levelId: "L1",
        walls: [
          { wallId: "w1", start: { x: 0, y: 0 }, end: { x: 30 * FT, y: 0 }, thicknessMm: 150, heightMm: 3000 },
          { wallId: "w2", start: { x: 30 * FT, y: 0 }, end: { x: 30 * FT, y: 6 * FT }, thicknessMm: 150, heightMm: 3000 },
          { wallId: "w3", start: { x: 30 * FT, y: 6 * FT }, end: { x: 0, y: 6 * FT }, thicknessMm: 150, heightMm: 3000 },
          { wallId: "w4", start: { x: 0, y: 6 * FT }, end: { x: 0, y: 0 }, thicknessMm: 150, heightMm: 3000 },
        ],
        rooms: [
          {
            roomId: "corr-1",
            number: "100",
            name: "Main Egress Corridor",
            outline: [
              { x: 0, y: 0 },
              { x: 30 * FT, y: 0 },
              { x: 30 * FT, y: 6 * FT },
              { x: 0, y: 6 * FT },
            ],
          },
        ],
        openings: [],
        casework: [],
      },
      {
        type: "place_part",
        partId: "em-1",
        typeId: troffer.id,
        levelId: "L1",
        position: { x: opts.fixtureCount === 2 ? 7 * FT : 3 * FT, y: 3 * FT },
        offsetMm: 9 * FT,
        mark: "EM-1",
      },
    ];
    if (opts.fixtureCount === 2) {
      fixtures.push({
        type: "place_part",
        partId: "em-2",
        typeId: troffer.id,
        levelId: "L1",
        position: { x: 23 * FT, y: 3 * FT },
        offsetMm: 9 * FT,
        mark: "EM-2",
      });
    }
    const ids = opts.fixtureCount === 2 ? ["em-1", "em-2"] : ["em-1"];
    fixtures.push({
      type: "set_element_values",
      elementIds: ids,
      values: {
        "electrical.photometric_profile": "troffer_2x4_led",
        "electrical.emergency_mode": opts.emergencyMode,
        ...(opts.emergencyLumens !== undefined ? { "electrical.emergency_lumens": opts.emergencyLumens } : {}),
        "electrical.egress_fixture": opts.emergencyMode !== "none",
      },
    });
    return runCmds(m, fixtures);
  }

  it("passes NFPA 101 initial and 90-min checks with 2 battery-backed corridor fixtures and populates calcs + schedules", () => {
    const m = buildCorridorModel({ emergencyMode: "battery_pack", emergencyLumens: 1400, fixtureCount: 2 });
    const reg = builtinCalcRegistry();

    const egressRun = reg.run({ calc: "electrical.photometrics_egress", model: m, inputs: { gridSpacingFt: 2 } });
    expect(egressRun.ok).toBe(true);
    if (!egressRun.ok) return;
    const val = (key: string) => egressRun.run.values.find((v) => v.key === key)?.value;
    expect(val("status")).toBe("PASS");
    expect(Number(val("initial_avg_fc"))).toBeGreaterThanOrEqual(1.0);
    expect(Number(val("initial_min_fc"))).toBeGreaterThanOrEqual(0.1);
    expect(Number(val("end_90min_avg_fc"))).toBeGreaterThanOrEqual(0.6);
    expect(Number(val("end_90min_min_fc"))).toBeGreaterThanOrEqual(0.06);

    const normalRun = reg.run({ calc: "electrical.photometrics_normal", model: m, inputs: { gridSpacingFt: 2 } });
    expect(normalRun.ok).toBe(true);

    // Evaluate both form schedules directly
    const summarySched = evaluateFormSchedule(m, { kind: "photometric_summary", template: builtinFormTemplate("photometric_summary") });
    expect(summarySched.grid.rows.length).toBe(1);
    const summaryRow = summarySched.grid.rows[0]!;
    const lastCellText = (cell: unknown) => (typeof cell === "string" ? cell : (cell as { text?: string; value?: string })?.text ?? (cell as { value?: string })?.value);
    expect(lastCellText(summaryRow.at(-1))).toBe("PASS");

    const egressSched = evaluateFormSchedule(m, { kind: "egress_lighting_compliance", template: builtinFormTemplate("egress_lighting_compliance") });
    expect(egressSched.grid.rows.length).toBe(1);
    expect(lastCellText(egressSched.grid.rows[0]!.at(-1))).toBe("PASS");

    // Lint engine produces zero egress errors
    const lint = new LintEngine();
    lint.build(m);
    const findings = lint.check({ config: readLintConfig({ ruleset: "default", include_linked: false }) });
    expect(findings.filter((f) => f.rule === "photometrics-egress-compliance")).toEqual([]);
  });

  it("detects NFPA 101 initial + 90-min failures, distinguishes generator vs battery 90-min derate, and draws crimson fail highlights in SVG", () => {
    // 1 fixture at far west end of 30 ft corridor -> far east end drops below 0.1 fc initial and 0.06 fc 90-min!
    const failingBattery = buildCorridorModel({ emergencyMode: "battery_pack", emergencyLumens: 700, fixtureCount: 1 });
    const egFail = evaluateEgressPhotometrics(failingBattery, { gridSpacingFt: 2, workplaneHeightIn: 0 });
    expect(egFail.pass).toBe(false);
    expect(egFail.paths[0]!.failingPoints).toBeGreaterThan(0);
    expect(egFail.paths[0]!.failReasons.length).toBeGreaterThan(0);

    // Lint engine emits error for failing egress corridor
    const lint = new LintEngine();
    lint.build(failingBattery);
    const findings = lint.check({ config: readLintConfig({ ruleset: "default", include_linked: false }) });
    const egressFinding = findings.find((f) => f.rule === "photometrics-egress-compliance");
    expect(egressFinding).toBeDefined();
    expect(egressFinding?.severity).toBe("error");

    // Generator circuit holds 100% output at 90 minutes (avgFc90Min === avgFc), unlike battery_pack (60%)
    const genModel = buildCorridorModel({ emergencyMode: "generator_circuit", emergencyLumens: 1000, fixtureCount: 2 });
    const egGen = evaluateEgressPhotometrics(genModel, { gridSpacingFt: 2, workplaneHeightIn: 0 });
    expect(egGen.paths[0]!.avgFc90Min).toBeCloseTo(egGen.paths[0]!.avgFc, 2);

    // Render failing egress plan to SVG and verify contours, grid numbers, and bold crimson fail highlights (#dc2626)
    const withView = runCmds(failingBattery, [
      {
        type: "create_view",
        viewId: "v-egress",
        name: "Egress Plan",
        viewType: "floor_plan",
        crop: { min: { x: -2 * FT, y: -2 * FT }, max: { x: 32 * FT, y: 8 * FT } },
        props: {
          level: "Level 1",
          scale: 48,
          discipline: "electrical",
          photometrics: { photometricsMode: "egress", showContours: true, showGridValues: true, gridSpacingFt: 2 },
        },
      },
      { type: "create_sheet", sheetId: "sh-eg", number: "E-202", name: "EGRESS LIGHTING" },
      { type: "place_viewport", viewportId: "vp-eg", sheetId: "sh-eg", viewId: "v-egress", center: { x: 400, y: 300 } },
    ]);

    const view = withView.elements[asElementId("v-egress")] as ViewElement;
    expect(view.props?.photometrics?.photometricsMode).toBe("egress");

    const contours = extractIsoContours(egFail.paths[0]!, 0.1);
    expect(contours.length).toBeGreaterThan(0);

    const scene = buildSheetSceneFor(withView, "sh-eg", { projectName: "Egress Test" });
    const svg = sceneToSvg(scene);
    expect(svg).toContain("EGRESS LIGHTING (NFPA 101) — FAIL");
    expect(svg).toContain("0.1 fc");
    expect(svg).toContain("#dc2626"); // crimson fail highlight border
    expect(svg).toContain("#fee2e2"); // crimson fail highlight fill
  });
});

describe("Performance benchmark: 20-room building on 2 ft grid", () => {
  it("evaluates a 20-room office building with walls and 40 luminaires fast in both cavity-bounce and 4-bounce patch radiosity modes", () => {
    const troffer = builtinPartType("builtin:troffer-2x4-led@1")!;
    // 20 rooms arranged in 2 rows of 10 (each 12'×14' = 168 sf -> 3,360 sf total, ~840 grid points, 40 luminaires, 33 opaque walls)
    const walls: Array<{ wallId: string; start: { x: number; y: number }; end: { x: number; y: number }; thicknessMm: number; heightMm: number }> = [];
    const rooms: Array<{ roomId: string; number: string; name: string; outline: Array<{ x: number; y: number }> }> = [];
    const placements: Command[] = [];

    const roomW = 12 * FT;
    const roomD = 14 * FT;
    const totalW = 10 * roomW;
    // Horizontal walls (y = 0, 14', 28')
    walls.push(
      { wallId: "hw-0", start: { x: 0, y: 0 }, end: { x: totalW, y: 0 }, thicknessMm: 150, heightMm: 3000 },
      { wallId: "hw-1", start: { x: 0, y: roomD }, end: { x: totalW, y: roomD }, thicknessMm: 150, heightMm: 3000 },
      { wallId: "hw-2", start: { x: 0, y: 2 * roomD }, end: { x: totalW, y: 2 * roomD }, thicknessMm: 150, heightMm: 3000 },
    );
    // Vertical partition walls
    for (let col = 0; col <= 10; col++) {
      walls.push({
        wallId: `vw-${col}`,
        start: { x: col * roomW, y: 0 },
        end: { x: col * roomW, y: 2 * roomD },
        thicknessMm: 150,
        heightMm: 3000,
      });
    }
    let idx = 1;
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 10; col++) {
        const x0 = col * roomW;
        const y0 = row * roomD;
        rooms.push({
          roomId: `room-${idx}`,
          number: `${100 + idx}`,
          name: `Office ${100 + idx}`,
          outline: [
            { x: x0, y: y0 },
            { x: x0 + roomW, y: y0 },
            { x: x0 + roomW, y: y0 + roomD },
            { x: x0, y: y0 + roomD },
          ],
        });
        placements.push(
          {
            type: "place_part",
            partId: `f-${idx}-a`,
            typeId: troffer.id,
            levelId: "L1",
            position: { x: x0 + 6 * FT, y: y0 + 4.5 * FT },
            offsetMm: 9 * FT,
            mark: `F-${idx}A`,
          },
          {
            type: "place_part",
            partId: `f-${idx}-b`,
            typeId: troffer.id,
            levelId: "L1",
            position: { x: x0 + 6 * FT, y: y0 + 9.5 * FT },
            offsetMm: 9 * FT,
            mark: `F-${idx}B`,
          },
        );
        idx++;
      }
    }

    const m = runCmds(emptyModel("perf-20-rooms"), [
      { type: "save_part_types", types: [{ typeId: troffer.id, definition: troffer.definition }] },
      { type: "add_architecture", levelId: "L1", walls, rooms, openings: [], casework: [] },
      ...placements,
    ]);

    // 1. Measure cold uncached detailed-mode runtime (materials + occlusion + 4-bounce patch radiosity) for 20 rooms / 40 luminaires
    const t0 = performance.now();
    const res = evaluateNormalPhotometrics(m, { gridSpacingFt: 2, workplaneHeightIn: 30, interReflectance: true });
    const elapsedPatch = performance.now() - t0;

    expect(res.spaces.length).toBe(20);
    expect(res.totalFixtures).toBe(40);
    expect(res.gridPoints.length).toBeGreaterThanOrEqual(700);
    expect(elapsedPatch).toBeLessThan(800);

    // 2. Measure fast cavity-bounce mode on the same 20-room building
    const t1 = performance.now();
    const resFast = evaluateNormalPhotometrics(m, {
      gridSpacingFt: 2,
      workplaneHeightIn: 30,
      interReflectance: true,
      radiosityMethod: "cavity",
    });
    const elapsedFast = performance.now() - t1;
    expect(resFast.spaces.length).toBe(20);
    expect(elapsedFast).toBeLessThan(300);
  });
});

// ---------------------------------------------------------------------------
// 7. Materials Library Reflectances, Glazing Transmittance, Furniture Occlusion,
//    Task Surfaces, 3D Multi-Flight Stairs & 3D Scene Lighting Presets
// ---------------------------------------------------------------------------

describe("Photometrics materials, glazing, furniture, surfaces, 3D stairs & 3D scene lighting", () => {
  it("derives ceiling/wall/floor reflectances from the Materials Library so bright finishes bounce more light than dark finishes", () => {
    expect(hexColorToLrv("#ebe8e1")).toBeGreaterThan(0.75); // Gypsum Board
    expect(hexColorToLrv("#8f5446")).toBeLessThan(0.2); // Red Brick

    const troffer = builtinPartType("builtin:troffer-2x4-led@1")!;
    const makeRoom = (id: string, wallMat: string, floorMat: string) =>
      runCmds(emptyModel(id), [
        { type: "save_part_types", types: [{ typeId: troffer.id, definition: troffer.definition }] },
        {
          type: "add_architecture",
          levelId: "L1",
          walls: [
            { wallId: "w1", start: { x: 0, y: 0 }, end: { x: 14 * FT, y: 0 }, thicknessMm: 150, heightMm: 3000 },
            { wallId: "w2", start: { x: 14 * FT, y: 0 }, end: { x: 14 * FT, y: 14 * FT }, thicknessMm: 150, heightMm: 3000 },
            { wallId: "w3", start: { x: 14 * FT, y: 14 * FT }, end: { x: 0, y: 14 * FT }, thicknessMm: 150, heightMm: 3000 },
            { wallId: "w4", start: { x: 0, y: 14 * FT }, end: { x: 0, y: 0 }, thicknessMm: 150, heightMm: 3000 },
          ],
          rooms: [
            {
              roomId: "r1",
              number: "101",
              name: "Office",
              outline: [
                { x: 0, y: 0 },
                { x: 14 * FT, y: 0 },
                { x: 14 * FT, y: 14 * FT },
                { x: 0, y: 14 * FT },
              ],
            },
          ],
          openings: [],
          casework: [],
        },
        {
          type: "create_element",
          elementId: "slab-1",
          kind: "slab",
          levelId: "L1",
          placement: {
            kind: "area",
            outline: [
              { x: 0, y: 0 },
              { x: 14 * FT, y: 0 },
              { x: 14 * FT, y: 14 * FT },
              { x: 0, y: 14 * FT },
            ],
          },
          size: { thicknessMm: 150 },
          values: { "material.id": floorMat },
        },
        { type: "set_element_values", elementIds: ["w1", "w2", "w3", "w4"], values: { "material.id": wallMat } },
        { type: "place_part", partId: "f1", typeId: troffer.id, levelId: "L1", position: { x: 7 * FT, y: 7 * FT }, offsetMm: 9 * FT, mark: "F1" },
      ]);

    const brightModel = makeRoom("bright-room", "architecture.gypsum_partition", "architecture.concrete_slab");
    const darkModel = makeRoom("dark-room", "architecture.brick_red", "architecture.wood_oak");

    const bright = evaluateNormalPhotometrics(brightModel, { calculationMode: "detailed", gridSpacingFt: 2 });
    const dark = evaluateNormalPhotometrics(darkModel, { calculationMode: "detailed", gridSpacingFt: 2 });
    const simplified = evaluateNormalPhotometrics(darkModel, { calculationMode: "simplified", gridSpacingFt: 2 });

    expect(bright.spaces[0]!.reflectancesUsed?.source).toBe("materials");
    expect(dark.spaces[0]!.reflectancesUsed?.source).toBe("materials");
    expect(simplified.spaces[0]!.reflectancesUsed?.source).toBe("default");
    expect(bright.spaces[0]!.reflectedFc).toBeGreaterThan(dark.spaces[0]!.reflectedFc);
    expect(bright.spaces[0]!.avgFc).toBeGreaterThan(dark.spaces[0]!.avgFc);
  });

  it("applies glazing visible transmittance across glass walls (attenuating light realistically rather than blocking 100% or passing 100%)", () => {
    const troffer = builtinPartType("builtin:troffer-2x4-led@1")!;
    const base = (wallMat: string | null) =>
      runCmds(emptyModel("glazing-test"), [
        { type: "save_part_types", types: [{ typeId: troffer.id, definition: troffer.definition }] },
        {
          type: "add_architecture",
          levelId: "L1",
          walls: wallMat
            ? [{ wallId: "w-mid", start: { x: 10 * FT, y: 0 }, end: { x: 10 * FT, y: 12 * FT }, thicknessMm: 100, heightMm: 3000 }]
            : [],
          rooms: [
            {
              roomId: "r-east",
              number: "102",
              name: "Adj Room",
              outline: [
                { x: 10 * FT, y: 0 },
                { x: 16 * FT, y: 0 },
                { x: 16 * FT, y: 12 * FT },
                { x: 10 * FT, y: 12 * FT },
              ],
            },
          ],
          openings: [],
          casework: [],
        },
        ...(wallMat ? [{ type: "set_element_values" as const, elementIds: ["w-mid"], values: { "material.id": wallMat } }] : []),
        { type: "place_part", partId: "f1", typeId: troffer.id, levelId: "L1", position: { x: 6 * FT, y: 6 * FT }, offsetMm: 9 * FT, mark: "F1" },
      ]);

    const openFc = evaluateNormalPhotometrics(base(null), { interReflectance: false }).spaces[0]!.avgFc;
    const glassFc = evaluateNormalPhotometrics(base("architecture.clear_glazing"), { interReflectance: false }).spaces[0]!.avgFc;
    const opaqueFc = evaluateNormalPhotometrics(base("architecture.cmu_concrete"), { interReflectance: false }).spaces[0]!.avgFc;

    expect(openFc).toBeGreaterThan(2);
    expect(opaqueFc).toBe(0);
    // Clear glazing transmits ~82% of incident direct illuminance
    expect(glassFc).toBeGreaterThan(openFc * 0.7);
    expect(glassFc).toBeLessThan(openFc * 0.92);
  });

  it("casts furniture/cabinet shadows in detailed & surfaces modes, evaluates kitchen counters at top Z, and ignores furniture in simplified mode", () => {
    const troffer = builtinPartType("builtin:troffer-2x4-led@1")!;
    const counterDef = {
      familyName: "Casework, kitchen counter",
      typeName: "Kitchen Prep Counter",
      category: "generic" as const,
      description: "Solid kitchen prep counter at 36 in AFF.",
      typeParams: [{ name: "material_id", label: "Material", kind: "text" as const }],
      typeValues: { material_id: "architecture.wood_oak" },
      instanceParams: [],
      connectors: [],
      geometry: [{ kind: "box" as const, center: [0, 0, 457] as [number, number, number], size: [2438, 762, 914] as [number, number, number] }],
      symbol: [{ kind: "rect" as const, center: [0, 0] as [number, number], size: [2438, 762] as [number, number], pen: "thin" as const }],
      tagFields: [],
      source: { kind: "builtin" as const, libraryVersion: BUILTIN_LIBRARY_VERSION },
    };
    const canopyDef = {
      familyName: "Casework, upper cabinet",
      typeName: "Overhead Kitchen Cabinet",
      category: "generic" as const,
      description: "Opaque upper cabinet mounted above counter casting shadow on work surface.",
      typeParams: [{ name: "material_id", label: "Material", kind: "text" as const }],
      typeValues: { material_id: "architecture.wood_oak" },
      instanceParams: [],
      connectors: [],
      geometry: [{ kind: "box" as const, center: [0, 0, 1800] as [number, number, number], size: [2438, 762, 600] as [number, number, number] }],
      symbol: [{ kind: "rect" as const, center: [0, 0] as [number, number], size: [2438, 762] as [number, number], pen: "thin" as const }],
      tagFields: [],
      source: { kind: "builtin" as const, libraryVersion: BUILTIN_LIBRARY_VERSION },
    };

    const m = runCmds(emptyModel("kitchen-surface"), [
      {
        type: "save_part_types",
        types: [
          { typeId: troffer.id, definition: troffer.definition },
          { typeId: "test:kitchen-counter@1", definition: counterDef },
          { typeId: "test:upper-cabinet@1", definition: canopyDef },
        ],
      },
      {
        type: "add_architecture",
        levelId: "L1",
        walls: [],
        rooms: [
          {
            roomId: "r-kit",
            number: "103",
            name: "Kitchen",
            outline: [
              { x: 0, y: 0 },
              { x: 16 * FT, y: 0 },
              { x: 16 * FT, y: 12 * FT },
              { x: 0, y: 12 * FT },
            ],
          },
        ],
        openings: [],
        casework: [],
      },
      { type: "place_part", partId: "kit-counter", typeId: "test:kitchen-counter@1", levelId: "L1", position: { x: 8 * FT, y: 6 * FT }, offsetMm: 0, mark: "KC1" },
      { type: "place_part", partId: "f-kit", typeId: troffer.id, levelId: "L1", position: { x: 8 * FT, y: 6 * FT }, offsetMm: 9 * FT, mark: "F1" },
    ]);

    const openSurfaces = evaluateNormalPhotometrics(m, { calculationMode: "surfaces", interReflectance: false });
    expect(openSurfaces.surfaceSummaries.length).toBe(1);
    const openCounter = openSurfaces.surfaceSummaries[0]!;
    expect(openCounter.surfaceKind).toBe("kitchen_counter");
    expect(openCounter.heightAffIn).toBeCloseTo(36, 0);
    expect(openCounter.avgFc).toBeGreaterThan(20);

    // Now mount an opaque upper cabinet directly between the ceiling luminaire and the counter
    const shadowedModel = runCmds(m, [
      { type: "place_part", partId: "upper-cab", typeId: "test:upper-cabinet@1", levelId: "L1", position: { x: 8 * FT, y: 6 * FT }, offsetMm: 0, mark: "UC1" },
    ]);

    const shadowedSurfaces = evaluateNormalPhotometrics(shadowedModel, { calculationMode: "surfaces", interReflectance: false });
    const simplified = evaluateNormalPhotometrics(shadowedModel, { calculationMode: "simplified", interReflectance: false });
    const detailed = evaluateNormalPhotometrics(shadowedModel, { calculationMode: "detailed", interReflectance: false });

    // Upper cabinet blocks direct ceiling light onto the kitchen counter in surfaces/detailed mode!
    expect(shadowedSurfaces.surfaceSummaries[0]!.avgFc).toBeLessThan(openCounter.avgFc * 0.2);
    expect(detailed.spaces[0]!.avgFc).toBeLessThan(simplified.spaces[0]!.avgFc);
  });

  it("evaluates 3D multi-flight U-shape stair treads & mid-landing at true rising step elevations", () => {
    const downlight = builtinPartType("builtin:downlight-6-led@1")!;
    const m = runCmds(emptyModel("stair-3d-test"), [
      { type: "create_level", levelId: "L2", name: "Level 2", elevationMm: 12 * FT },
      { type: "save_part_types", types: [{ typeId: downlight.id, definition: downlight.definition }] },
      {
        type: "create_element",
        elementId: "st-u",
        kind: "architecture.stair",
        levelId: "L1",
        placement: { kind: "line", start: { x: 10 * FT, y: 10 * FT }, end: { x: 20 * FT, y: 10 * FT } },
        size: { widthMm: 1200 },
        values: { "architecture.stair_form": "u_shape", "architecture.stair_turn": "right" },
      },
      { type: "place_part", partId: "em-top", typeId: downlight.id, levelId: "L2", position: { x: 16 * FT, y: 12 * FT }, offsetMm: 9 * FT, mark: "EM1" },
      {
        type: "set_element_values",
        elementIds: ["em-top"],
        values: { "electrical.photometric_profile": "downlight_6_led", "electrical.emergency_mode": "battery_pack", "electrical.emergency_lumens": 1400, "electrical.egress_fixture": true },
      },
    ]);

    const eg = evaluateEgressPhotometrics(m, { gridSpacingFt: 2 });
    const stairPath = eg.paths.find((p) => p.kind === "stair");
    expect(stairPath).toBeDefined();
    expect(stairPath!.gridPoints.length).toBeGreaterThan(10);
    const zs = stairPath!.gridPoints.map((p) => p.zMm);
    // True rising 3D treads span from near L1 floor up towards L2!
    expect(Math.min(...zs)).toBeLessThan(1.5 * FT);
    expect(Math.max(...zs)).toBeGreaterThan(10 * FT);
  });

  it("emits photometrics-egress-compliance for failing modeled stairs and re-runs incrementally when fixture inputs change", () => {
    const downlight = builtinPartType("builtin:downlight-6-led@1")!;
    const lit = runCmds(emptyModel("stair-lint-test"), [
      { type: "create_level", levelId: "L2", name: "Level 2", elevationMm: 12 * FT },
      { type: "save_part_types", types: [{ typeId: downlight.id, definition: downlight.definition }] },
      {
        type: "create_element",
        elementId: "st-egress",
        kind: "architecture.stair",
        levelId: "L1",
        placement: { kind: "line", start: { x: 10 * FT, y: 10 * FT }, end: { x: 20 * FT, y: 10 * FT } },
        size: { widthMm: 1200 },
        values: { "architecture.stair_form": "u_shape", "architecture.stair_turn": "right" },
      },
      { type: "place_part", partId: "em-low", typeId: downlight.id, levelId: "L1", position: { x: 14 * FT, y: 10 * FT }, offsetMm: 9 * FT, mark: "EM1" },
      { type: "place_part", partId: "em-high", typeId: downlight.id, levelId: "L2", position: { x: 15 * FT, y: 12 * FT }, offsetMm: 9 * FT, mark: "EM2" },
      {
        type: "set_element_values",
        elementIds: ["em-low", "em-high"],
        values: { "electrical.photometric_profile": "downlight_6_led", "electrical.emergency_mode": "generator_circuit", "electrical.emergency_lumens": 3000, "electrical.egress_fixture": true },
      },
    ]);

    const engine = new LintEngine();
    engine.build(lit);
    const config = readLintConfig({ ruleset: "default", include_linked: false });
    const initialFindings = engine.check({ config });
    expect(initialFindings.filter((f) => f.rule === "photometrics-egress-compliance" && f.elementIds.includes("st-egress"))).toEqual([]);

    // Non-spatial fixture parameter edit disables emergency output -> incremental lint re-runs via `reads` and flags the stair!
    const dark = runCmds(lit, [
      {
        type: "set_element_values",
        elementIds: ["em-low", "em-high"],
        values: { "electrical.emergency_mode": "none", "electrical.emergency_lumens": 0, "electrical.egress_fixture": false },
      },
    ]);
    engine.advance(dark, ["em-low", "em-high"]);
    const incFindings = engine.run({ box: null, documents: [], changed: ["em-low", "em-high"] }, { config, previous: lit });
    const stairFinding = incFindings.find((f) => f.rule === "photometrics-egress-compliance" && f.elementIds.includes("st-egress"));
    expect(stairFinding).toBeDefined();
    expect(stairFinding!.severity).toBe("error");
  });

  it("gates >400-char part parameter edits and viewport north-arrow offsets on peer capabilities", () => {
    const longText = "x".repeat(450);
    const base = emptyModel("peer-gate-test");

    const runWithFeatures = (m: ModelState, cmd: Command, allowed: readonly string[]) =>
      withUpgradePolicy(
        (feature) => allowed.includes(feature),
        () => executeCommand(m, cmd),
      );

    // 1. Long text gate on save_part_types (maxLength / default / typeValues) & place_part / set_parameters
    const baseDef = builtinPartType("builtin:downlight-6-led@1")!.definition;
    const longLimitType: Command = {
      type: "save_part_types",
      types: [
        {
          typeId: "custom:long-limit@1",
          definition: {
            ...baseDef,
            familyName: "Custom",
            typeName: "LongLimit",
            instanceParams: [...baseDef.instanceParams, { name: "notes_long", label: "Notes", kind: "text", maxLength: 2048 }],
          },
        },
      ],
    };
    expect(runWithFeatures(base, longLimitType, []).ok).toBe(false);
    const withType = runWithFeatures(base, longLimitType, [PARTS_LONG_TEXT_VALUES_FEATURE]);
    expect(withType.ok).toBe(true);
    if (!withType.ok) return;

    const placeLong: Command = {
      type: "place_part",
      partId: "p-long",
      typeId: "custom:long-limit@1",
      levelId: "L1",
      position: { x: 0, y: 0 },
      values: { notes_long: longText },
    };
    expect(runWithFeatures(withType.model, placeLong, []).ok).toBe(false);
    const placedShort = runWithFeatures(withType.model, { ...placeLong, values: { notes_long: "short" } }, []);
    expect(placedShort.ok).toBe(true);
    if (!placedShort.ok) return;

    const setLong: Command = { type: "set_parameters", id: "p-long", scope: "instance", values: { notes_long: longText } };
    expect(runWithFeatures(placedShort.model, setLong, []).ok).toBe(false);
    expect(runWithFeatures(placedShort.model, setLong, [PARTS_LONG_TEXT_VALUES_FEATURE]).ok).toBe(true);

    // 2. Viewport north-arrow offset gate on place_viewport and set_viewport_north_arrow
    const withSheetAndView = runCmds(base, [
      { type: "create_sheet", sheetId: "sh-1", number: "A-101", name: "Plan" },
      { type: "create_view", viewId: "vw-1", name: "L1 Plan", viewType: "floor_plan", props: { level: "Level 1" } },
    ]);
    const placeWithOffset: Command = {
      type: "place_viewport",
      viewportId: "vp-1",
      sheetId: "sh-1",
      viewId: "vw-1",
      center: { x: 400, y: 300 },
      northArrowOffsetMm: { x: -10, y: -10 },
    };
    expect(runWithFeatures(withSheetAndView, placeWithOffset, []).ok).toBe(false);
    const placedVp = runWithFeatures(withSheetAndView, { ...placeWithOffset, northArrowOffsetMm: undefined }, []);
    expect(placedVp.ok).toBe(true);
    if (!placedVp.ok) return;

    // Legacy show toggle stays allowed; offset-only update requires VIEWPORT_NORTH_ARROW_OFFSET_FEATURE
    expect(runWithFeatures(placedVp.model, { type: "set_viewport_north_arrow", viewportId: "vp-1", show: false }, []).ok).toBe(true);
    expect(runWithFeatures(placedVp.model, { type: "set_viewport_north_arrow", viewportId: "vp-1", offsetMm: { x: -12, y: -8 } }, []).ok).toBe(false);
    expect(runWithFeatures(placedVp.model, { type: "set_viewport_north_arrow", viewportId: "vp-1", offsetMm: { x: -12, y: -8 } }, [VIEWPORT_NORTH_ARROW_OFFSET_FEATURE]).ok).toBe(true);
  });

  it("honors explicit kernel.material optical reflectance (LRV) and visibleTransmittance (T_vis)", () => {
    expect(
      materialReflectance(
        { id: "test.custom_plaster", name: "Plaster", color: "#222222", reflectance: 0.77 },
        0.5,
      ),
    ).toBe(0.77);
    expect(
      materialTransmittance({
        id: "test.triple_lowe",
        name: "Triple Low-E",
        color: "#a8d0ea",
        category: "glazing",
        visibleTransmittance: 0.61,
      }),
    ).toBe(0.61);
    // Canonical Greg Ward glass transmissivity tn > T_vis for clear glass (accounts for surface Fresnel reflection)
    const tn = radianceGlassTransmissivity(0.82);
    expect(tn).toBeGreaterThan(0.85);
    expect(tn).toBeLessThan(0.92);
  });

  it("runs spatially-resolved 4-bounce patch radiosity (higher bounce near luminaire than far corner, energy-conserving)", () => {
    const troffer = builtinPartType("builtin:troffer-2x4-led@1")!;
    // Long 40 ft x 12 ft room with a single luminaire near the west end (x = 5 ft)
    const model = runCmds(emptyModel("radiosity-spatial"), [
      { type: "save_part_types", types: [{ typeId: troffer.id, definition: troffer.definition }] },
      {
        type: "add_architecture",
        levelId: "L1",
        walls: [
          { wallId: "w1", start: { x: 0, y: 0 }, end: { x: 40 * FT, y: 0 }, thicknessMm: 150, heightMm: 3000 },
          { wallId: "w2", start: { x: 40 * FT, y: 0 }, end: { x: 40 * FT, y: 12 * FT }, thicknessMm: 150, heightMm: 3000 },
          { wallId: "w3", start: { x: 40 * FT, y: 12 * FT }, end: { x: 0, y: 12 * FT }, thicknessMm: 150, heightMm: 3000 },
          { wallId: "w4", start: { x: 0, y: 12 * FT }, end: { x: 0, y: 0 }, thicknessMm: 150, heightMm: 3000 },
        ],
        rooms: [
          {
            roomId: "r-long",
            number: "101",
            name: "Long Gallery",
            outline: [
              { x: 0, y: 0 },
              { x: 40 * FT, y: 0 },
              { x: 40 * FT, y: 12 * FT },
              { x: 0, y: 12 * FT },
            ],
          },
        ],
        openings: [],
        casework: [],
      },
      { type: "place_part", partId: "f-west", typeId: troffer.id, levelId: "L1", position: { x: 5 * FT, y: 6 * FT }, offsetMm: 9 * FT, mark: "F1" },
    ]);

    const res = evaluateNormalPhotometrics(model, {
      calculationMode: "detailed",
      radiosityMethod: "patch_radiosity",
      gridSpacingFt: 2,
      reflectances: { ceiling: 0.85, wall: 0.65, floor: 0.35 },
    });
    expect(res.radiosityMethod).toBe("patch_radiosity");
    const pts = res.spaces[0]!.gridPoints;
    const nearPts = pts.filter((p) => p.xMm < 10 * FT);
    const farPts = pts.filter((p) => p.xMm > 30 * FT);
    const nearIndirect = nearPts.reduce((s, p) => s + (p.indirectFc ?? 0), 0) / nearPts.length;
    const farIndirect = farPts.reduce((s, p) => s + (p.indirectFc ?? 0), 0) / farPts.length;
    // Patch radiosity resolves real spatial falloff of inter-reflected light (unlike flat uniform cavity average!)
    expect(nearIndirect).toBeGreaterThan(farIndirect * 2.5);
    expect(farIndirect).toBeGreaterThan(0);
  });

  it("computes CIE Overcast Daylight Factor (DF%) and CIE Clear Solar Daylight through windows while blocking windowless rooms", () => {
    const model = runCmds(emptyModel("daylight-test"), [
      { type: "create_level", levelId: "L-ROOF", name: "Roof", elevationMm: 3000 },
      {
        type: "add_architecture",
        levelId: "L1",
        walls: [
          // Shared perimeter + center partition separating Daylit Room (west, x=0..16) & Windowless Room (east, x=16..32)
          { wallId: "w-south", start: { x: 0, y: 0 }, end: { x: 32 * FT, y: 0 }, thicknessMm: 200, heightMm: 3000 },
          { wallId: "w-east", start: { x: 32 * FT, y: 0 }, end: { x: 32 * FT, y: 14 * FT }, thicknessMm: 200, heightMm: 3000 },
          { wallId: "w-north", start: { x: 32 * FT, y: 14 * FT }, end: { x: 0, y: 14 * FT }, thicknessMm: 200, heightMm: 3000 },
          { wallId: "w-west", start: { x: 0, y: 14 * FT }, end: { x: 0, y: 0 }, thicknessMm: 200, heightMm: 3000 },
          { wallId: "w-part", start: { x: 16 * FT, y: 0 }, end: { x: 16 * FT, y: 14 * FT }, thicknessMm: 150, heightMm: 3000 },
        ],
        rooms: [
          {
            roomId: "r-daylit",
            number: "101",
            name: "Daylit Studio",
            outline: [
              { x: 0, y: 0 },
              { x: 16 * FT, y: 0 },
              { x: 16 * FT, y: 14 * FT },
              { x: 0, y: 14 * FT },
            ],
          },
          {
            roomId: "r-dark",
            number: "102",
            name: "Windowless Vault",
            outline: [
              { x: 16 * FT, y: 0 },
              { x: 32 * FT, y: 0 },
              { x: 32 * FT, y: 14 * FT },
              { x: 16 * FT, y: 14 * FT },
            ],
          },
        ],
        openings: [
          // Large south-facing window in Daylit Studio only
          { openingId: "win-1", wallId: "w-south", kind: "window", offsetMm: 8 * FT, widthMm: 10 * FT, heightMm: 6 * FT },
        ],
        casework: [],
      },
      // Opaque roof slab at z = 3000 mm over both rooms so sky rays can ONLY enter through windows
      {
        type: "create_element",
        elementId: "roof-1",
        kind: "slab",
        levelId: "L-ROOF",
        placement: {
          kind: "area",
          outline: [
            { x: -300, y: -300 },
            { x: 32 * FT + 300, y: -300 },
            { x: 32 * FT + 300, y: 14 * FT + 300 },
            { x: -300, y: 14 * FT + 300 },
          ],
        },
        size: { thicknessMm: 200 },
      },
    ]);

    const overcast = evaluateNormalPhotometrics(model, {
      calculationMode: "detailed",
      gridSpacingFt: 2,
      daylight: { enabled: true, skyModel: "cie_overcast", outdoorHorizontalFc: 1000, includeElectric: false },
    });
    expect(overcast.daylight?.enabled).toBe(true);
    const daylit = overcast.spaces.find((s) => s.name === "Daylit Studio")!;
    const dark = overcast.spaces.find((s) => s.name === "Windowless Vault")!;
    expect(daylit.avgFc).toBeGreaterThan(20);
    expect(daylit.daylightFactorPct ?? 0).toBeGreaterThan(2);
    expect(daylit.daylightFactorPct ?? 100).toBeLessThan(35);
    expect(dark.avgFc).toBe(0);
    expect(dark.daylightFactorPct).toBe(0);

    // Clear sky with South sun (180 deg, 40 deg alt) boosts direct solar illuminance inside the south-facing room
    const clear = evaluateNormalPhotometrics(model, {
      calculationMode: "detailed",
      gridSpacingFt: 2,
      daylight: {
        enabled: true,
        skyModel: "cie_clear",
        outdoorHorizontalFc: 1000,
        sunAzimuthDeg: 180,
        sunElevationDeg: 40,
        includeElectric: false,
      },
    });
    const clearDaylit = clear.spaces.find((s) => s.name === "Daylit Studio")!;
    expect(clearDaylit.avgFc).toBeGreaterThan(daylit.avgFc);
  });

  it("exports valid LBNL Radiance .rad, .ies, and .pts files that round-trip through parseIesFile", () => {
    const troffer = builtinPartType("builtin:troffer-2x4-led@1")!;
    const model = runCmds(emptyModel("radiance-export-test"), [
      { type: "save_part_types", types: [{ typeId: troffer.id, definition: troffer.definition }] },
      {
        type: "add_architecture",
        levelId: "L1",
        walls: [
          { wallId: "w1", start: { x: 0, y: 0 }, end: { x: 20 * FT, y: 0 }, thicknessMm: 200, heightMm: 3000 },
          { wallId: "w2", start: { x: 20 * FT, y: 0 }, end: { x: 20 * FT, y: 14 * FT }, thicknessMm: 200, heightMm: 3000 },
          { wallId: "w3", start: { x: 20 * FT, y: 14 * FT }, end: { x: 0, y: 14 * FT }, thicknessMm: 200, heightMm: 3000 },
          { wallId: "w4", start: { x: 0, y: 14 * FT }, end: { x: 0, y: 0 }, thicknessMm: 200, heightMm: 3000 },
        ],
        rooms: [
          {
            roomId: "r1",
            number: "101",
            name: "Office",
            outline: [
              { x: 0, y: 0 },
              { x: 20 * FT, y: 0 },
              { x: 20 * FT, y: 14 * FT },
              { x: 0, y: 14 * FT },
            ],
          },
        ],
        openings: [{ openingId: "win-1", wallId: "w1", kind: "window", offsetMm: 10 * FT, widthMm: 6 * FT, heightMm: 5 * FT }],
        casework: [],
      },
      { type: "set_element_values", elementIds: ["w1", "w2", "w3", "w4"], values: { "material.id": "architecture.gypsum_partition" } },
      { type: "place_part", partId: "f1", typeId: troffer.id, levelId: "L1", position: { x: 10 * FT, y: 7 * FT }, offsetMm: 9 * FT, mark: "F1" },
    ]);

    const exp = exportRadianceScene(model, { skyModel: "cie_clear", sunAzimuthDeg: 180, sunElevationDeg: 45 });
    expect(exp.summary.wallCount).toBe(4);
    expect(exp.summary.openingCount).toBe(1);
    expect(exp.summary.luminaireCount).toBe(1);
    expect(exp.summary.iesFileCount).toBe(1);
    expect(exp.summary.sensorCount).toBeGreaterThan(20);
    expect(exp.materialsRad).toContain("void plastic architecture.gypsum_partition");
    expect(exp.materialsRad).toContain("void glass");
    expect(exp.geometryRad).toContain("glass_win-1");
    expect(exp.luminairesRad).toContain("!ies2rad");
    expect(exp.skyRad).toContain("!gensky -ang 45.0000 0.0000 +s");
    expect(exp.commands.some((c) => c.includes("evalglare"))).toBe(true);

    // Every exported .ies file must parse cleanly as valid ANSI/IES LM-63
    for (const iesText of Object.values(exp.iesFiles)) {
      const parsed = parseIesFile(iesText);
      expect(parsed.totalLumens).toBeGreaterThan(100);
      expect(parsed.maxCandela).toBeGreaterThan(10);
    }
  });

  it("recomputes egress photometrics immediately when a luminaire is toggled between normal, unswitched EM, and switched UL 924 EM", () => {
    const troffer = builtinPartType("builtin:troffer-2x4-led@1")!;
    const base = runCmds(emptyModel("em-toggle-sync"), [
      { type: "save_part_types", types: [{ typeId: troffer.id, definition: troffer.definition }] },
      {
        type: "add_architecture",
        levelId: "L1",
        walls: [
          { wallId: "w1", start: { x: 0, y: 0 }, end: { x: 20 * FT, y: 0 }, thicknessMm: 150, heightMm: 3000 },
          { wallId: "w2", start: { x: 20 * FT, y: 0 }, end: { x: 20 * FT, y: 8 * FT }, thicknessMm: 150, heightMm: 3000 },
          { wallId: "w3", start: { x: 20 * FT, y: 8 * FT }, end: { x: 0, y: 8 * FT }, thicknessMm: 150, heightMm: 3000 },
          { wallId: "w4", start: { x: 0, y: 8 * FT }, end: { x: 0, y: 0 }, thicknessMm: 150, heightMm: 3000 },
        ],
        rooms: [
          {
            roomId: "r-corr",
            number: "100",
            name: "Main Corridor",
            outline: [
              { x: 0, y: 0 },
              { x: 20 * FT, y: 0 },
              { x: 20 * FT, y: 8 * FT },
              { x: 0, y: 8 * FT },
            ],
          },
        ],
        openings: [],
        casework: [],
      },
      { type: "place_part", partId: "f1", typeId: troffer.id, levelId: "L1", position: { x: 10 * FT, y: 4 * FT }, offsetMm: 9 * FT, mark: "F1" },
    ]);

    // 1. Starts as normal fixture -> 0 egress fc
    const before = evaluateEgressPhotometrics(base, { gridSpacingFt: 2 });
    expect(before.paths[0]!.avgFc).toBe(0);

    // 2. Switched EM (UL 924) via control params + synced electrical.emergency_mode -> lights up egress immediately
    const asSwitchedEm = runCmds(base, [
      { type: "set_parameters", id: "f1", scope: "instance", values: { emergency: true, emergency_mode: "switched" } },
      { type: "set_element_values", elementIds: ["f1"], values: { "electrical.emergency_mode": "battery_pack", "electrical.egress_fixture": true } },
    ]);
    const duringEm = evaluateEgressPhotometrics(asSwitchedEm, { gridSpacingFt: 2 });
    expect(duringEm.paths[0]!.avgFc).toBeGreaterThan(2);

    // 3. Toggled back to Normal -> drops straight back to 0 egress fc
    const backToNormal = runCmds(asSwitchedEm, [
      { type: "set_parameters", id: "f1", scope: "instance", values: { emergency: false, emergency_mode: "none" } },
      { type: "set_element_values", elementIds: ["f1"], values: { "electrical.emergency_mode": "none", "electrical.egress_fixture": false } },
    ]);
    const afterOff = evaluateEgressPhotometrics(backToNormal, { gridSpacingFt: 2 });
    expect(afterOff.paths[0]!.avgFc).toBe(0);
  });
});
