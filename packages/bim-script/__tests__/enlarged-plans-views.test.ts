/**
 * @jest-environment node
 *
 * Script API coverage for Revit-style enlarged plans, live parametric callouts,
 * sections, elevations, and crop boxes (`documents.enlargedPlan`, `callout`,
 * `sectionView`, `elevationView`, `setCrop`), plus `bim_script_reference` lookup.
 */
import { DEFAULT_SETTINGS, calloutHead, executeCommand, type Command, type ModelState, type Revision, type ViewElement } from "@permitzip/bim-kernel";
import { defineScript, documents, kitDeclarations, runScript, searchReference, sliceModel, units } from "../src";

const FT = 304.8;

function baseModel(): ModelState {
  let m: ModelState = { modelId: "script-views", revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const r = executeCommand(m, { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 });
  if (!r.ok) throw new Error(r.error.message);
  return r.model;
}

describe("documents enlargedPlan, callout, sectionView, elevationView, setCrop", () => {
  it("runs a script creating an overall plan, enlarged plan with live callout, section, elevation, and sheets", async () => {
    const model = baseModel();
    const script = defineScript({
      kind: "layout",
      reads: { levels: true },
      parameters: {},
      run(ctx) {
        const overall = documents.planView(ctx, {
          level: "L1",
          name: "Level 1 - Plumbing",
          discipline: "plumbing",
          scale: 96,
          crop: { from: { x: units.ft(0), y: units.ft(0) }, to: { x: units.ft(60), y: units.ft(40) } },
          id: "v-overall",
        });
        const { viewId: enlarged } = documents.enlargedPlan(ctx, {
          parent: overall,
          name: "Enlarged Restroom Plan",
          from: { x: units.ft(10), y: units.ft(10) },
          to: { x: units.ft(22), y: units.ft(20) },
          scale: 24,
          id: "v-enlarged",
          calloutId: "co-enlarged",
        });
        const sec = documents.sectionView(ctx, {
          name: "Section A-A",
          level: "L1",
          from: { x: units.ft(5), y: units.ft(15) },
          to: { x: units.ft(50), y: units.ft(15) },
          direction: 1,
          depth: units.ft(15),
          scale: 48,
          id: "v-sec",
        });
        const elev = documents.elevationView(ctx, {
          name: "Restroom North Elevation",
          level: "L1",
          from: { x: units.ft(10), y: units.ft(12) },
          to: { x: units.ft(22), y: units.ft(12) },
          direction: 1,
          depth: units.ft(8),
          scale: 24,
          id: "v-elev",
        });
        documents.setCrop(ctx, elev, { depth: units.ft(10) });

        // Also test standalone callout referencing an existing view
        documents.callout(ctx, {
          view: overall,
          target: sec,
          from: { x: units.ft(30), y: units.ft(10) },
          to: { x: units.ft(40), y: units.ft(20) },
          label: "SEC",
          id: "co-sec",
        });

        const p401 = documents.sheet(ctx, { number: "P-401", name: "Enlarged Plumbing Plans", id: "s-p401" });
        documents.place(ctx, p401, enlarged, { x: units.mm(250), y: units.mm(250) }, 24);
        documents.place(ctx, p401, elev, { x: units.mm(600), y: units.mm(250) }, 24);
      },
    });

    const out = await runScript(script, { slice: sliceModel(model, script.manifest.reads), values: {}, scriptHash: "sha256:enlarged-plans" });
    const commands = out.kind === "edits" ? out.batches.flatMap((b) => b.commands) : [];
    let m = model;
    for (const cmd of commands) {
      const r = executeCommand(m, cmd as Command);
      if (!r.ok) throw new Error(`Command ${(cmd as Command).type} failed: ${r.error.message}`);
      m = r.model;
    }

    const enlargedView = m.elements["v-enlarged"] as ViewElement;
    expect(enlargedView.viewType).toBe("floor_plan");
    expect(enlargedView.props?.scale).toBe(24);
    expect(calloutHead(m, { viewId: "v-enlarged" })).toMatchObject({ top: "1", bottom: "P-401", resolved: true });

    const elevView = m.elements["v-elev"] as ViewElement;
    expect(elevView.viewType).toBe("elevation");
    expect(elevView.props?.section?.depthMm).toBe(Math.round(10 * FT * 1000) / 1000);
    expect(calloutHead(m, { viewId: "v-elev" })).toMatchObject({ top: "2", bottom: "P-401", resolved: true });

    const secView = m.elements["v-sec"] as ViewElement;
    expect(secView.viewType).toBe("section");
    expect(m.elements["co-enlarged"]?.kind).toBe("drawing_item");
    expect(m.elements["co-sec"]?.kind).toBe("drawing_item");
  });

  it("documents enlargedPlan, callout, sectionView, elevationView and setCrop in bim_script_reference", () => {
    for (const q of ["enlarged plan", "callout", "elevation", "section", "crop"]) {
      const hits = searchReference(q);
      expect(hits.length).toBeGreaterThan(0);
    }
    const names = searchReference("enlarged plan").map((e) => e.name);
    expect(names).toContain("documents.enlargedPlan");
    expect(names).toContain("documents.callout");

    const dts = kitDeclarations();
    expect(dts).toContain("export interface CropBoxSpec");
    expect(dts).toContain("export interface VerticalViewSpec");
    expect(dts).toContain("export interface EnlargedPlanSpec");
    expect(dts).toContain("export interface CalloutRefSpec");
    expect(dts).toContain("crop?: { from: PlanPoint; to: PlanPoint }");
  });
});
