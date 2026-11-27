/**
 * @jest-environment node
 */
import { createShowcaseDemoModel } from "@permitzip/bim-first-party/seed";
import { defineScript, documents, markups, runScript, sliceModel } from "@permitzip/bim-script";
import { renderScriptRequests } from "../src/scripts/render-images";

describe("bim_run_script sheet markup PNG rendering", () => {
  it("renders marked showcase sheet M-101 to valid PNG buffers for agent inspection", async () => {
    const model = createShowcaseDemoModel("showcase-markup-render-test");
    const script = defineScript({
      kind: "layout",
      reads: { kinds: ["sheet", "viewport", "view", "drawing_item"] },
      parameters: {},
      run(ctx) {
        const sheets = markups.sheetsWithMarkups(ctx);
        markups.renderSheet(ctx, "M-101", { focusStatus: "open", monochromeSheet: true, dpi: 96, maxPx: 1200 });
        markups.renderSheet(ctx, "M-101", { monochromeSheet: true, dpi: 72, maxPx: 1000 });
        ctx.report("sheets", sheets);
      },
    });
    const output = await runScript(script, { slice: sliceModel(model, script.manifest.reads), values: {}, scriptHash: "render-test" });
    expect(output.kind).toBe("edits");
    if (output.kind !== "edits") return;
    expect(output.renders).toHaveLength(2);

    const images = await renderScriptRequests(model, output.renders!);
    expect(images).toHaveLength(2);
    for (const img of images) {
      // Valid PNG signature: 89 50 4E 47
      expect(img.png.subarray(0, 4).toString("hex")).toBe("89504e47");
      expect(img.widthPx).toBeGreaterThan(100);
      expect(img.heightPx).toBeGreaterThan(100);
      expect(img.targetId).toBe("sheet-m101");
    }
    // Focused markup crop should have tighter region than full sheet
    const cropW = images[0]!.regionMm.max.x - images[0]!.regionMm.min.x;
    const fullW = images[1]!.regionMm.max.x - images[1]!.regionMm.min.x;
    expect(cropW).toBeLessThan(fullW);
  });

  it("honors highlightIds for model elements on both sheet and view renders", async () => {
    const model = createShowcaseDemoModel("showcase-highlight-render-test");
    const firstPart = Object.values(model.elements).find((e) => e.kind === "part");
    const firstPlan = Object.values(model.elements).find((e) => e.kind === "view" && !e.deleted && e.viewType === "floor_plan");
    expect(firstPart).toBeDefined();
    expect(firstPlan).toBeDefined();
    const script = defineScript({
      kind: "layout",
      reads: { kinds: ["sheet", "viewport", "view", "drawing_item", "part"] },
      parameters: {},
      run(ctx) {
        documents.renderSheet(ctx, "M-101", { highlightIds: [firstPart!.id], dpi: 72, maxPx: 800 });
        documents.renderView(ctx, firstPlan!.id, { highlightIds: [firstPart!.id], dpi: 72, maxPx: 800 });
      },
    });
    const output = await runScript(script, { slice: sliceModel(model, script.manifest.reads), values: {}, scriptHash: "highlight-test" });
    expect(output.kind).toBe("edits");
    if (output.kind !== "edits") return;
    const images = await renderScriptRequests(model, output.renders!);
    expect(images).toHaveLength(2);
    expect(images[0]!.kind).toBe("sheet");
    expect(images[1]!.kind).toBe("view");
    for (const img of images) {
      expect(img.png.subarray(0, 4).toString("hex")).toBe("89504e47");
    }
  });
});
