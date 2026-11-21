/** @jest-environment node */
import {
  DEFAULT_SETTINGS,
  GEOMETRY_SOLID_PROGRAM_2_FEATURE,
  buildViewScene,
  builtinPartType,
  executeCommand,
  partPlanOutline,
  withUpgradePolicy,
  type Command,
  type ModelState,
  type PartInstance,
  type Revision,
} from "@permitzip/bim-kernel";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { CIRCUIT_GRAPHICS_ROW, deriveCircuitGraphics, ELECTRICAL_PLAN_SYMBOLS } from "@permitzip/bim-pack-electrical";
import { defineScript, documents, parts, runScript, sliceModel, units } from "@permitzip/bim-script";

installFirstPartyAddOns();

const SCALE_96 = 96; // 1/8" = 1'-0"
const SCALE_48 = 48; // 1/4" = 1'-0"

function emptyModel(): ModelState {
  return { modelId: "elec-sym-test", revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
}

function runCmds(model: ModelState, cmds: readonly Command[]): ModelState {
  let m = model;
  for (const c of cmds) {
    const r = withUpgradePolicy(
      (f) => f === GEOMETRY_SOLID_PROGRAM_2_FEATURE,
      () => executeCommand(m, c),
    );
    if (!r.ok) throw new Error(`command ${c.type} failed: ${r.error.message}`);
    m = r.model;
  }
  return m;
}

describe("electrical plan symbols, wire trimming, draw order and scriptability", () => {
  it("paper-scaled ANSI/NEC electrical symbols stay legible (~3.2 mm) at 1:96 with opaque white masks and detail-level switching", () => {
    const gfci = builtinPartType("builtin:gfci-receptacle@1")!;
    const sw = builtinPartType("builtin:switch-single-pole@1")!;
    const occ = builtinPartType("builtin:occupancy-sensor-ceiling@1")!;
    const downlight = builtinPartType("builtin:downlight-6-led@1")!;
    const trofferEm = builtinPartType("builtin:troffer-2x4-led-em@1")!;

    const m = runCmds(emptyModel(), [
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      { type: "place_part", partId: "p-gfci", typeId: gfci.id, partType: gfci.definition, levelId: "L1", position: { x: 1000, y: 1000 }, mark: "W-09" },
      { type: "place_part", partId: "p-sw", typeId: sw.id, partType: sw.definition, levelId: "L1", position: { x: 2500, y: 1000 }, mark: "SW-RR1" },
      { type: "place_part", partId: "p-occ", typeId: occ.id, partType: occ.definition, levelId: "L1", position: { x: 4000, y: 1000 }, mark: "OS-1" },
      { type: "place_part", partId: "p-dl", typeId: downlight.id, partType: downlight.definition, levelId: "L1", position: { x: 5500, y: 1000 }, mark: "F1" },
      { type: "place_part", partId: "p-tr", typeId: trofferEm.id, partType: trofferEm.definition, levelId: "L1", position: { x: 8000, y: 1000 }, mark: "F2-EM" },
      {
        type: "create_view",
        viewId: "v-e101",
        name: "E101 Power & Lighting",
        viewType: "floor_plan",
        crop: { min: { x: -1000, y: -1000 }, max: { x: 12000, y: 4000 } },
        props: { level: "Level 1", scale: SCALE_96, discipline: "electrical" },
      },
    ]);

    // At 1:96, GFCI circle radius 1.6 paper mm => 153.6 model mm (3.2 mm diameter on paper — never a sub-1 mm speck).
    const gfciOutline = partPlanOutline(m, m.elements["p-gfci"] as PartInstance, { scale: SCALE_96, detail: "medium" });
    const circle = gfciOutline.outline.find((o) => o.kind === "circle");
    expect(circle?.kind).toBe("circle");
    if (circle?.kind === "circle") expect(circle.r / SCALE_96).toBeCloseTo(1.5, 2);

    // Downlight switches from paper-scaled (1.8 mm) at medium to physical (3.5" = 88.9 mm) at fine.
    const dlMed = partPlanOutline(m, m.elements["p-dl"] as PartInstance, { scale: SCALE_96, detail: "medium" });
    const dlFine = partPlanOutline(m, m.elements["p-dl"] as PartInstance, { scale: SCALE_96, detail: "fine" });
    const rMed = dlMed.outline.find((o) => o.kind === "circle");
    const rFine = dlFine.outline.find((o) => o.kind === "circle");
    expect(rMed?.kind === "circle" && rMed.r / SCALE_96).toBeCloseTo(1.8, 2);
    expect(rFine?.kind === "circle" && rFine.r).toBeCloseTo(3.5 * 25.4, 1);

    // Build view scene: opaque white masks (grey: 1) and solid black fills (grey: 0, e.g. EM troffer half-fill) are emitted.
    const { scene } = buildViewScene(m, "v-e101");
    const whiteMasks = scene.primitives.filter((p) => p.kind === "fill" && p.grey === 1);
    const solidFills = scene.primitives.filter((p) => p.kind === "fill" && p.grey === 0);
    expect(whiteMasks.length).toBeGreaterThanOrEqual(4);
    expect(solidFills.length).toBeGreaterThanOrEqual(1);

    // Part marks (W-09, SW-RR1, OS-1, F1) are offset outside the symbol center — never stamped dead-center.
    const texts = scene.primitives.filter((p): p is Extract<typeof p, { kind: "text" }> => p.kind === "text");
    const w09 = texts.find((t) => t.text === "W-09");
    const gfiSub = texts.find((t) => t.text === "GFI");
    expect(w09).toBeDefined();
    expect(gfiSub).toBeDefined();
    expect(Math.hypot(w09!.at.x - gfiSub!.at.x, w09!.at.y - gfiSub!.at.y)).toBeGreaterThan(1.5);
  });

  it("circuit arcs trim cleanly at the outer edge of Schema-2 custom symbols and 2x4 troffers, and draw behind fixtures", () => {
    const panel = builtinPartType("builtin:panelboard-225-480@1")!;
    const troffer = builtinPartType("builtin:troffer-2x4-led@1")!;

    // Custom Schema-2 lighting fixture built via bim-script with paper-scaled symbol + white mask.
    const customLight = parts
      .part("Custom LED", { type: "6in", category: "lighting_fixture" })
      .cylinder({ diameter: units.in(6), length: units.in(4), axis: "z" })
      .connector("top", { id: "power", label: "Power", domain: "electrical", systemKind: "power", shape: "none", voltage: 277, poles: 1, flow: 15 })
      .symbol(["coarse", "medium"], {
        units: "paper",
        mask: true,
        shapes: [parts.circle(units.mm(4))],
        lines: [[[units.mm(-2), units.mm(0)], [units.mm(2), units.mm(0)]]],
      })
      .build();

    const m = runCmds(emptyModel(), [
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      { type: "place_part", partId: "pnl-1", typeId: panel.id, partType: panel.definition, levelId: "L1", position: { x: 0, y: 0 }, mark: "LP-1", values: { panel_name: "LP-1" } },
      { type: "place_part", partId: "tr-1", typeId: troffer.id, partType: troffer.definition, levelId: "L1", position: { x: 3000, y: 0 }, mark: "F2-A" },
      { type: "place_part", partId: "tr-2", typeId: troffer.id, partType: troffer.definition, levelId: "L1", position: { x: 7000, y: 0 }, mark: "F2-B" },
      { type: "place_part", partId: "cl-1", typeId: "custom:led-6", partType: customLight, levelId: "L1", position: { x: 10000, y: 0 }, mark: "F1-A" },
      {
        type: "create_service_link",
        linkId: "ckt-1",
        sourceId: "pnl-1",
        positions: [1],
        members: [{ elementId: "tr-1" }, { elementId: "tr-2" }, { elementId: "cl-1" }],
        description: "Lighting",
      },
      {
        type: "create_view",
        viewId: "v-e101",
        name: "E101 Lighting",
        viewType: "floor_plan",
        crop: { min: { x: -1000, y: -2000 }, max: { x: 12000, y: 3000 } },
        props: { level: "Level 1", scale: SCALE_48, discipline: "electrical" },
      },
    ]);

    const view = m.elements["v-e101"];
    if (view?.kind !== "view") throw new Error("view missing");
    const shown = new Map<string, PartInstance>(
      ["pnl-1", "tr-1", "tr-2", "cl-1"].map((id) => [id, m.elements[id] as PartInstance]),
    );

    const graphics = deriveCircuitGraphics(m, view, shown, SCALE_48, "medium");
    const ckt = graphics.find((g) => g.key === "ckt-1")!;
    expect(ckt.paths).toHaveLength(2);

    // Path 0 (tr-1 -> tr-2): no point lies strictly inside either 4'x2' troffer (half-length 609.6 mm, half-width 304.8 mm).
    const insideTroffer = (p: { x: number; y: number }, cx: number, cy: number) =>
      Math.abs(p.x - cx) < 609.6 - 1 && Math.abs(p.y - cy) < 304.8 - 1;
    for (const pt of ckt.paths[0]!) {
      expect(insideTroffer(pt, 3000, 0)).toBe(false);
      expect(insideTroffer(pt, 7000, 0)).toBe(false);
    }

    // Path 1 (tr-2 -> cl-1): stops at the custom Schema-2 paper-scaled circle boundary (radius 2 * 48 = 96 mm), NOT at center (10000, 0).
    const endPt = ckt.paths[1]![ckt.paths[1]!.length - 1]!;
    expect(Math.hypot(endPt.x - 10000, endPt.y - 0)).toBeCloseTo(2 * SCALE_48, 0);

    // Layer order: CIRCUIT_GRAPHICS_ROW is on `under_parts`, so circuit wire lines appear BEFORE part white masks in scene.primitives.
    expect(CIRCUIT_GRAPHICS_ROW.layer).toBe("under_parts");
    const { scene } = buildViewScene(m, "v-e101");
    const firstLineIdx = scene.primitives.findIndex((p) => p.kind === "line");
    const firstMaskIdx = scene.primitives.findIndex((p) => p.kind === "fill" && p.grey === 1);
    const homeRunTextIdx = scene.primitives.findIndex((p) => p.kind === "text" && p.text === "LP-1-1");
    expect(firstLineIdx).toBeGreaterThanOrEqual(0);
    expect(firstMaskIdx).toBeGreaterThan(firstLineIdx);
    // Home run label draws on top of masks (`drawOver`).
    expect(homeRunTextIdx).toBeGreaterThan(firstMaskIdx);
  });

  it("bim-script supports custom paper symbols, symbolRef, planLabels overlap inspection, and tag movement/suppression", async () => {
    expect(ELECTRICAL_PLAN_SYMBOLS.some((s) => s.id === "electrical.plan_gfci")).toBe(true);

    const wp = parts
      .part("WP GFCI", { type: "20A", category: "electrical_device" })
      .box({ length: units.in(3), width: units.in(1), height: units.in(4.5) })
      .connector("back", { id: "power", label: "Power", domain: "electrical", systemKind: "power", shape: "none", voltage: 120, poles: 1, flow: 180 })
      .symbolRef(["coarse", "medium", "fine"], "electrical.plan_gfci")
      .build();

    const partScript = defineScript({
      kind: "part",
      reads: {},
      parameters: {},
      run(ctx) {
        ctx.parts.define("demo.wp_gfci", wp);
      },
    });
    const partOut = await runScript(partScript, { slice: sliceModel(emptyModel(), {}), values: {}, scriptHash: "test-part" });
    expect(partOut.kind).toBe("part_types");
    if (partOut.kind === "part_types") expect(partOut.types).toHaveLength(1);

    const script = defineScript({
      kind: "layout",
      reads: { levels: true },
      parameters: {},
      run(ctx) {
        ctx.edit({ type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 });
        ctx.edit({ type: "place_part", partId: "r-1", typeId: "demo.wp_gfci", partType: wp, levelId: "L1", position: { x: 1000, y: 1000 }, mark: "W-01" });
        ctx.edit({ type: "place_part", partId: "r-2", typeId: "demo.wp_gfci", partType: wp, levelId: "L1", position: { x: 1400, y: 1000 }, mark: "W-02" });
        ctx.edit({ type: "create_view", viewId: "v-e101", name: "E101", viewType: "floor_plan", crop: { min: { x: 0, y: 0 }, max: { x: 4000, y: 4000 } }, props: { level: "Level 1", scale: 96, discipline: "electrical" } });
        const view = "v-e101";

        // Inspect rendered labels: zero overlaps even for two adjacent receptacles 400 mm apart!
        const beforeTag = documents.planLabels(ctx, view);
        expect(beforeTag.labels.some((l) => l.text === "W-01")).toBe(true);
        expect(beforeTag.labels.some((l) => l.text === "W-02")).toBe(true);
        expect(beforeTag.overlaps).toHaveLength(0);

        // Placing a real movable tag on r-1 suppresses its automatic mark (no duplicate W-01) and can be moved with documents.moveTag.
        const tagId = documents.tag(ctx, { view, element: "r-1", at: { x: units.mm(1000), y: units.mm(1800) } });
        documents.moveTag(ctx, tagId, { x: units.mm(1000), y: units.mm(2200) }, { leader: true });
        const afterTag = documents.planLabels(ctx, view);
        expect(afterTag.labels.filter((l) => l.text === "W-01")).toHaveLength(1);
      },
    });

    const slice = { ...sliceModel(emptyModel(), script.manifest.reads), features: [GEOMETRY_SOLID_PROGRAM_2_FEATURE] };
    const res = await runScript(script, { slice, values: {}, scriptHash: "test-layout" });
    expect(res.kind).toBe("edits");
    if (res.kind === "edits") expect(res.steps).toBeGreaterThan(0);
  });
});
