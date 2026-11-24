/**
 * @jest-environment node
 *
 * End-to-end CAD drafting script API & kernel print-quality tests:
 * - Every `drafting.*` helper + `documents.detailView`
 * - Protocol feature gating (`DRAFTING_CAD_STANDARDS_FEATURE`)
 * - Halftone/screened hatches, extended CAD hatch patterns, masked notes, filled NCS arrowheads/dots
 * - Mechanical pack 2D detail symbols (`mechanical.*`)
 * - Automated overlap & crop QA (`drafting.check` / `auditDetailView`)
 * - Full `mechanical-details` showcase script execution + SVG/PDF rendering
 */
import "@permitzip/bim-pack-mechanical";
import {
  DEFAULT_SETTINGS,
  DRAFTING_CAD_STANDARDS_FEATURE,
  buildSheetSceneFor,
  buildViewScene,
  executeCommand,
  sceneToSvg,
  withUpgradePolicy,
  type Command,
  type ModelState,
  type Revision,
  type Sheet,
  type ViewElement,
} from "@permitzip/bim-kernel";
import { renderSheetPdf } from "@permitzip/bim-sheets";
import { PROTOCOL_FEATURES } from "@permitzip/bim-sync";
import {
  KIT_ENTRIES,
  KIT_RECIPES,
  checkScriptSource,
  defineScript,
  documents,
  drafting,
  kitDeclarations,
  kitExample,
  kitUseWarnings,
  runScript,
  searchReference,
  sliceModel,
  units,
} from "../src";
import mechanicalDetailsScript from "../examples/mechanical-details";

const FEATURES = Object.values(PROTOCOL_FEATURES);

function emptyModel(): ModelState {
  return {
    modelId: "cad-drafting-test",
    revision: 0 as Revision,
    elements: {},
    connections: [],
    settings: DEFAULT_SETTINGS,
  };
}

function applyOutput(base: ModelState, output: Awaited<ReturnType<typeof runScript>>, features: readonly string[] = FEATURES): ModelState {
  if (output.kind !== "edits") throw new Error("Expected edits output");
  const featureSet = new Set(features);
  let cur = base;
  for (const batch of output.batches) {
    const r = withUpgradePolicy((f) => featureSet.has(f), () => executeCommand(cur, batch as Command));
    if (!r.ok) throw new Error(`Batch failed: ${r.error.message}`);
    cur = r.model;
  }
  return cur;
}

describe("CAD drafting scripting API", () => {
  it("exposes DRAFTING_CAD_STANDARDS_FEATURE in PROTOCOL_FEATURES and full drafting namespace in kitDeclarations + reference", () => {
    expect(FEATURES).toContain(DRAFTING_CAD_STANDARDS_FEATURE);
    const dts = kitDeclarations();
    expect(dts).toContain("export declare const drafting:");
    for (const fn of [
      "drafting.view",
      "drafting.fitCrop",
      "drafting.line",
      "drafting.rect",
      "drafting.chain",
      "drafting.polygon",
      "drafting.arc",
      "drafting.arcRadius",
      "drafting.arcTangent",
      "drafting.circle",
      "drafting.spline",
      "drafting.region",
      "drafting.component",
      "drafting.repeat",
      "drafting.batt",
      "drafting.breakLine",
      "drafting.note",
      "drafting.calloutStack",
      "drafting.detailTitle",
      "drafting.dimension",
      "drafting.modify",
      "drafting.group",
      "drafting.catalog",
      "drafting.check",
      "documents.detailView",
    ]) {
      const entry = KIT_ENTRIES.find((e) => e.name === fn);
      expect(entry).toBeDefined();
      expect(checkScriptSource(entry!.example)).toEqual([]);
      expect(kitUseWarnings(entry!.example)).toEqual([]);
    }
    const recipe = KIT_RECIPES.find((r) => r.name === "CAD drafting detail views");
    expect(recipe).toBeDefined();
    expect(searchReference("mechanical detail callout hatch").some((h) => h.name === "CAD drafting detail views")).toBe(true);
    expect(kitExample("mechanical-details")?.source).toContain("drafting.calloutStack");
  });

  it("supports every geometry, annotation, modify, breakLine, catalog, and QA helper in one script", async () => {
    const script = defineScript({
      kind: "layout",
      reads: {},
      parameters: {},
      run(ctx) {
        const cat = drafting.catalog(ctx);
        expect(cat.components.some((c) => c.id === "mechanical.hooded_louver")).toBe(true);
        expect(cat.components.some((c) => c.id === "break_line")).toBe(true);
        expect(cat.hatchPatterns).toContain("metal_deck");
        expect(cat.hatchPatterns).toContain("insulation_rigid");
        expect(cat.regionTones).toEqual(["ink", "halftone", "screened"]);
        expect(cat.leaderArrows).toContain("filled_arrow");
        expect(cat.leaderArrows).toContain("filled_dot");

        const v = documents.detailView(ctx, { name: "All Primitives Detail", scale: 16, discipline: "mechanical" });
        const l1 = drafting.line(ctx, { view: v, from: { x: units.in(0), y: units.in(0) }, to: { x: units.in(24), y: units.in(0) }, lineStyle: "wide" });
        const l2 = drafting.line(ctx, { view: v, from: { x: units.in(24), y: units.in(0) }, to: { x: units.in(24), y: units.in(24) }, lineStyle: "wide" });
        drafting.modify(ctx, { view: v, items: [l1, l2], op: { op: "chamfer", distanceA: units.in(3) } });

        const box = drafting.rect(ctx, { view: v, at: { x: units.in(30), y: units.in(0) }, width: units.in(18), height: units.in(12), lineStyle: "medium" });
        drafting.group(ctx, { view: v, items: box, group: "sample-box" });

        drafting.chain(ctx, { view: v, points: [{ x: units.in(0), y: units.in(30) }, { x: units.in(12), y: units.in(36) }, { x: units.in(24), y: units.in(30) }] });
        drafting.polygon(ctx, { view: v, center: { x: units.in(60), y: units.in(10) }, radius: units.in(4), sides: 6 });
        drafting.arc(ctx, { view: v, center: { x: units.in(60), y: units.in(24) }, start: { x: units.in(64), y: units.in(24) }, end: { x: units.in(60), y: units.in(28) } });
        drafting.arcRadius(ctx, { view: v, start: { x: units.in(0), y: units.in(40) }, end: { x: units.in(10), y: units.in(40) }, radius: units.in(8), toward: { x: units.in(5), y: units.in(48) } });
        drafting.arcTangent(ctx, { view: v, from: { x: units.in(-10), y: units.in(40) }, start: { x: units.in(0), y: units.in(40) }, end: { x: units.in(6), y: units.in(46) } });
        drafting.circle(ctx, { view: v, center: { x: units.in(40), y: units.in(24) }, radius: units.in(4) });
        drafting.spline(ctx, { view: v, points: [{ x: units.in(30), y: units.in(34) }, { x: units.in(40), y: units.in(38) }, { x: units.in(50), y: units.in(34) }] });
        drafting.region(ctx, { view: v, rect: { at: { x: units.in(0), y: units.in(-10) }, width: units.in(48), height: units.in(6) }, hatch: "metal_deck", tone: "halftone" });
        drafting.component(ctx, { view: v, symbol: "mechanical.volume_damper", at: { x: units.in(72), y: units.in(4) }, width: units.in(8), height: units.in(10) });
        drafting.repeat(ctx, { view: v, symbol: "concrete_anchor", from: { x: units.in(0), y: units.in(-10) }, to: { x: units.in(36), y: units.in(-10) }, spacing: units.in(12) });
        drafting.batt(ctx, { view: v, from: { x: units.in(0), y: units.in(-16) }, to: { x: units.in(48), y: units.in(-16) }, thickness: units.in(4) });
        drafting.breakLine(ctx, { view: v, from: { x: units.in(48), y: units.in(-18) }, to: { x: units.in(48), y: units.in(0) }, maskSide: "right" });

        drafting.detailTitle(ctx, { view: v, at: { x: units.in(0), y: units.in(58) }, title: "ALL CAD PRIMITIVES", subtitle: "SCALE: 3/4\" = 1'-0\"" });
        drafting.dimension(ctx, { view: v, from: { x: units.in(30), y: units.in(-18) }, to: { x: units.in(48), y: units.in(-18) }, offset: units.in(0.45), suffix: " BOX" });
        drafting.note(ctx, { view: v, at: { x: units.in(86), y: units.in(24) }, text: "VOLUME DAMPER\nLOCKING QUADRANT", leaders: [{ to: { x: units.in(80), y: units.in(10) }, arrow: "filled_arrow" }] });
        drafting.calloutStack(ctx, {
          view: v,
          side: "left",
          x: inchNeg(8),
          topY: units.in(24),
          notes: [
            { text: "CHAMFERED CORNER", to: { x: units.in(21), y: units.in(3) } },
            { text: "METAL ROOF DECK", to: { x: units.in(6), y: units.in(-7) } },
          ],
        });
        drafting.fitCrop(ctx, v);
        const qa = drafting.check(ctx, v);
        ctx.report("qa", qa);
      },
    });
    function inchNeg(n: number) {
      return units.in(-n);
    }

    const slice = sliceModel(emptyModel(), script.manifest.reads, [], FEATURES);
    const out = await runScript(script, { slice, values: {}, scriptHash: "test-all-cad" });
    expect(out.kind).toBe("edits");
    const qa = out.report?.find((r) => r.label === "qa")?.value as { ok: boolean; textOverlaps: unknown[]; clippedItems: unknown[]; lineCrossings: unknown[]; issues: string[] };
    expect(qa.issues).toEqual([]);
    expect(qa.ok).toBe(true);
    expect(qa.textOverlaps).toEqual([]);
    expect(qa.clippedItems).toEqual([]);
    expect(qa.lineCrossings).toEqual([]);

    const finalModel = applyOutput(emptyModel(), out);
    const view = Object.values(finalModel.elements).find((e): e is ViewElement => e.kind === "view");
    expect(view).toBeDefined();
    const { scene } = buildViewScene(finalModel, view!.id);
    // Verify filled polygons exist (filled arrowheads + masking regions) and masked text blocks exist.
    expect(scene.primitives.some((p) => p.kind === "fill" && p.grey === 0)).toBe(true);
    expect((scene.textBlocks ?? []).some((b) => b.mask === true)).toBe(true);
    const svg = sceneToSvg(scene);
    expect(svg).toContain('fill="#ffffff"');
  });

  it("gates extended CAD drafting features behind DRAFTING_CAD_STANDARDS_FEATURE while falling back cleanly on legacy servers", async () => {
    const legacyOk = defineScript({
      kind: "layout",
      reads: {},
      parameters: {},
      run(ctx) {
        const v = drafting.view(ctx, { name: "Legacy Detail", scale: 16 });
        drafting.region(ctx, { view: v, rect: { at: { x: units.in(0), y: units.in(0) }, width: units.in(24), height: units.in(8) }, hatch: "diagonal" });
        drafting.note(ctx, { view: v, at: { x: units.in(30), y: units.in(8) }, text: "LEGACY NOTE", leaders: [{ to: { x: units.in(24), y: units.in(4) } }] });
      },
    });
    const legacyFeatures = FEATURES.filter((f) => f !== DRAFTING_CAD_STANDARDS_FEATURE);
    const outLegacy = await runScript(legacyOk, { slice: sliceModel(emptyModel(), {}, [], legacyFeatures), values: {}, scriptHash: "legacy-ok" });
    expect(outLegacy.kind).toBe("edits");

    // Explicitly requesting extended hatch or mask on a legacy server is refused cleanly.
    const gatedScript = defineScript({
      kind: "layout",
      reads: {},
      parameters: {},
      run(ctx) {
        const v = drafting.view(ctx, { name: "New Feature Detail", scale: 16 });
        drafting.region(ctx, { view: v, rect: { at: { x: units.in(0), y: units.in(0) }, width: units.in(24), height: units.in(8) }, hatch: "metal_deck", tone: "halftone" });
      },
    });
    await expect(
      runScript(gatedScript, { slice: sliceModel(emptyModel(), {}, [], legacyFeatures), values: {}, scriptHash: "legacy-refused" }),
    ).rejects.toThrow(/older version|updated/i);
  });

  it("runs the mechanical-details showcase script with zero overlap/crop QA issues and renders SVG + PDF cleanly", async () => {
    const slice = sliceModel(emptyModel(), mechanicalDetailsScript.manifest.reads, [], FEATURES);
    const out = await runScript(mechanicalDetailsScript, { slice, values: {}, scriptHash: "mech-details-showcase" });
    expect(out.kind).toBe("edits");
    const qa = out.report?.find((r) => r.label === "Detail QA")?.value as {
      rtuDetail: { ok: boolean; issues: string[] };
      fanDetail: { ok: boolean; issues: string[] };
    };
    expect(qa.rtuDetail.issues).toEqual([]);
    expect(qa.rtuDetail.ok).toBe(true);
    expect(qa.fanDetail.issues).toEqual([]);
    expect(qa.fanDetail.ok).toBe(true);

    const model = applyOutput(emptyModel(), out);
    const sheet = Object.values(model.elements).find((e): e is Sheet => e.kind === "sheet");
    expect(sheet).toBeDefined();
    const sheetScene = buildSheetSceneFor(model, sheet!.id, { projectName: "CAD Drafting Test" });
    const svg = sceneToSvg(sheetScene);
    const plainSvg = svg.replace(/\u00a0/g, " ");
    expect(plainSvg).toContain("CARRIER 50FEQ HEAT PUMP RTU");
    expect(plainSvg).toContain("HOODED WALL CAP");
    const pdf = await renderSheetPdf(sheetScene, {
      title: "M-501 Mechanical Details",
      renderer: "mutinybim-test",
      modelRevision: 1,
      snapshotSha256: "0".repeat(64),
    });
    expect(pdf.bytes.byteLength).toBeGreaterThan(2000);
  });
});
