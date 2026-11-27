/**
 * @jest-environment node
 *
 * End-to-end bim-script execution of the civil LandXML TIN import and
 * prismoidal cut-and-fill calc under real server protocol features.
 */
import { DEFAULT_SETTINGS, type ModelState, type Revision } from "@permitzip/bim-kernel";
import { PackSet, bindModelPacks, withPackSet } from "@permitzip/bim-pack";
import { CIVIL_PACK, IMPORT_LANDXML_SURFACES, readGradingSurfaces } from "@permitzip/bim-pack-civil";
import { PROTOCOL_FEATURES } from "@permitzip/bim-sync";
import { KIT_RECIPES, checkScriptOutput, defineScript, runScript, searchReference, sliceModel } from "../src";

const DEMO_LANDXML = `<?xml version="1.0"?>
<LandXML version="1.2">
  <Units><Imperial linearUnit="foot"/></Units>
  <Surfaces>
    <Surface name="Existing"><Definition surfType="TIN">
      <Pnts><P id="1">0 0 100</P><P id="2">0 80 100</P><P id="3">50 80 100</P><P id="4">50 0 100</P></Pnts>
      <Faces><F>1 2 3</F><F>1 3 4</F></Faces>
    </Definition></Surface>
    <Surface name="Proposed"><Definition surfType="TIN">
      <Pnts><P id="1">0 0 101.25</P><P id="2">0 80 101.25</P><P id="3">50 80 101.25</P><P id="4">50 0 101.25</P></Pnts>
      <Faces><F>1 2 3</F><F>1 3 4</F></Faces>
    </Definition></Surface>
  </Surfaces>
</LandXML>`;

describe("civil LandXML grading in bim-script", () => {
  it("surfaces the grading recipe via searchReference", () => {
    expect(KIT_RECIPES.some((r) => r.name === "Civil LandXML grading and cut/fill")).toBe(true);
    const hits = searchReference("landxml cut fill");
    expect(hits.map((h) => h.name)).toContain("Civil LandXML grading and cut/fill");
  });

  it("imports LandXML TIN surfaces and computes cut/fill through runScript + checkScriptOutput", async () => {
    const modelId = "script-civil-landxml";
    const set = PackSet.create([CIVIL_PACK]);
    bindModelPacks(modelId, set);
    const base: ModelState = { modelId, revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    const features = Object.values(PROTOCOL_FEATURES);

    const script = defineScript({
      kind: "layout",
      reads: { levels: true },
      parameters: {},
      run(ctx) {
        ctx.edit({ type: IMPORT_LANDXML_SURFACES, landXml: DEMO_LANDXML });
        const earthwork = ctx.calc({ calc: "civil.surface_cut_fill", inputs: { existingId: "gs-existing", proposedId: "gs-proposed" } });
        ctx.report("Cut and fill", earthwork);
        ctx.label("Import LandXML surfaces and compute earthwork");
      },
    });

    const slice = sliceModel(base, script.manifest.reads, [], features);
    const out = await runScript(script, { slice, scriptHash: "civil-landxml-test", values: {}, packs: set });
    expect(out.kind).toBe("edits");
    if (out.kind !== "edits") return;

    let after: ModelState | null = null;
    const checked = withPackSet(set, () =>
      checkScriptOutput(base, out, {
        features,
        onAfterEdits: (m) => {
          after = m;
        },
      }),
    );
    expect(checked.ok).toBe(true);
    expect(after).not.toBeNull();
    if (!after) return;
    const surfaces = readGradingSurfaces((after as ModelState).elements);
    expect(surfaces.problems).toEqual([]);
    expect(surfaces.surfaces.map((s) => s.id).sort()).toEqual(["gs-existing", "gs-proposed"]);

    const entry = out.report?.[0]?.value as { ok?: boolean; run?: { values?: readonly { key: string; value: number }[] } } | undefined;
    expect(entry?.ok).toBe(true);
    const fillYd3 = entry?.run?.values?.find((v) => v.key === "fill_yd3")?.value ?? Number.NaN;
    expect(fillYd3).toBeCloseTo(5000 / 27, 4);
  });
});
