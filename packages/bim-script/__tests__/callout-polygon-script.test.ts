/**
 * @jest-environment node
 *
 * `@permitzip/bim-script` polygonal enlarged callout & cropPolygon API tests.
 */
import { DEFAULT_SETTINGS, planCommit, withUpgradePolicy, type Command, type DrawingItem, type ModelState, type ViewElement } from "@permitzip/bim-kernel";
import { defineScript, documents, runScript, sliceModel, units } from "../src";

let seq = 0;
function commit(model: ModelState, command: Command): ModelState {
  const d = withUpgradePolicy(
    () => true,
    () =>
      planCommit(
        model,
        [],
        {
          idempotencyKey: `cs-${++seq}`,
          baseRevision: model.revision,
          actor: { id: "avery", name: "Avery", kind: "human" },
          command,
        },
        () => "2026-11-22T00:00:00.000Z",
      ),
  );
  if (!d.ok) throw new Error(`${command.type}: ${d.error.code} — ${d.error.message}`);
  return d.model;
}

describe("@permitzip/bim-script polygonal callouts & cropPolygon API", () => {
  it("supports documents.enlargedPlan({ polygon }), documents.setCalloutBoundary, and resetting to rectangle", async () => {
    let model: ModelState = { modelId: "m-callout-script", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    model = commit(model, { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 });
    model = commit(model, {
      type: "add_architecture",
      levelId: "L1",
      walls: [{ wallId: "w1", start: { x: 0, y: 0 }, end: { x: 6096, y: 0 }, thicknessMm: 200, heightMm: 3048 }],
      openings: [],
      rooms: [],
      casework: [],
    });

    let viewId = "";
    let calloutId = "";
    const script1 = defineScript({
      kind: "layout",
      reads: { levels: true, kinds: ["wall", "view", "drawing_item"] },
      parameters: {},
      run(ctx) {
        const plan = documents.planView(ctx, { level: "Level 1", name: "Level 1 Plan", scale: 96 });
        const created = documents.enlargedPlan(ctx, {
          parent: plan,
          name: "Enlarged Wet Core",
          polygon: [
            { x: units.ft(0), y: units.ft(0) },
            { x: units.ft(16), y: units.ft(0) },
            { x: units.ft(16), y: units.ft(6) },
            { x: units.ft(10), y: units.ft(6) },
            { x: units.ft(10), y: units.ft(14) },
            { x: units.ft(0), y: units.ft(14) },
          ],
          scale: 24,
        });
        viewId = created.viewId;
        calloutId = created.calloutId;
        // Reshape callout boundary to a wider 6-corner L-shape
        documents.setCalloutBoundary(ctx, calloutId, {
          polygon: [
            { x: units.ft(0), y: units.ft(0) },
            { x: units.ft(18), y: units.ft(0) },
            { x: units.ft(18), y: units.ft(7) },
            { x: units.ft(10), y: units.ft(7) },
            { x: units.ft(10), y: units.ft(14) },
            { x: units.ft(0), y: units.ft(14) },
          ],
        });
      },
    });

    const out1 = await runScript(script1, { slice: sliceModel(model, script1.manifest.reads), values: {}, scriptHash: "sha256:cs1" });
    expect(out1.kind).toBe("edits");
    if (out1.kind !== "edits") throw new Error("expected edits");
    for (const cmd of out1.batches) model = commit(model, cmd);

    const view = model.elements[viewId] as ViewElement;
    const callout = model.elements[calloutId] as DrawingItem;
    expect(view.props?.cropPolygon?.length).toBe(6);
    expect(callout.callout?.boundary?.length).toBe(6);
    expect(view.cropMax.x).toBeCloseTo(18 * 304.8, 0);

    // Reset back to rectangle via setCalloutBoundary({ from, to })
    const script2 = defineScript({
      kind: "layout",
      reads: { levels: true, kinds: ["view", "drawing_item"] },
      parameters: {},
      run(ctx) {
        documents.setCalloutBoundary(ctx, calloutId, {
          from: { x: units.ft(0), y: units.ft(0) },
          to: { x: units.ft(12), y: units.ft(10) },
        });
      },
    });
    const out2 = await runScript(script2, { slice: sliceModel(model, script2.manifest.reads), values: {}, scriptHash: "sha256:cs2" });
    expect(out2.kind).toBe("edits");
    if (out2.kind !== "edits") throw new Error("expected edits");
    for (const cmd of out2.batches) model = commit(model, cmd);

    const view2 = model.elements[viewId] as ViewElement;
    const callout2 = model.elements[calloutId] as DrawingItem;
    expect(view2.props?.cropPolygon).toBeUndefined();
    expect(callout2.callout?.boundary).toBeUndefined();
    expect(view2.cropMax.x).toBeCloseTo(12 * 304.8, 0);
  });
});
