/**
 * @jest-environment node
 *
 * Verifies the `BIM_DEV_MODEL=enlarged-plans` devserver demo model builds
 * cleanly and prints live callout, section, and elevation bubbles on M-101.
 */
import { buildSheetSceneFor, calloutHead } from "@permitzip/bim-kernel";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { enlargedPlansDemoModel } from "../src/enlarged-plans-demo";

installFirstPartyAddOns();

describe("enlargedPlansDemoModel (BIM_DEV_MODEL=enlarged-plans)", () => {
  it("builds M-101, M-301, and M-401 with live callout, section, and elevation bubbles", () => {
    const m = enlargedPlansDemoModel();
    expect(calloutHead(m, { viewId: "v-enlarged-branch" })).toMatchObject({ top: "1", bottom: "M-401", resolved: true });
    expect(calloutHead(m, { viewId: "v-elev-north" })).toMatchObject({ top: "2", bottom: "M-401", resolved: true });
    expect(calloutHead(m, { viewId: "v-section-a" })).toMatchObject({ top: "1", bottom: "M-301", resolved: true });

    const m101 = buildSheetSceneFor(m, "s-m101", { projectName: "Enlarged Plans Demo" });
    expect(m101.primitives.some((p) => p.kind === "text" && p.text === "M-401")).toBe(true);
    expect(m101.primitives.some((p) => p.kind === "text" && p.text === "M-301")).toBe(true);
    const m301 = buildSheetSceneFor(m, "s-m301", { projectName: "Enlarged Plans Demo" });
    const m401 = buildSheetSceneFor(m, "s-m401", { projectName: "Enlarged Plans Demo" });
    // NCS / Revit back-referencing: M-301 and M-401 view title bubbles point back to M-101.
    expect(m301.primitives.some((p) => p.kind === "text" && p.text === "M-101")).toBe(true);
    expect(m401.primitives.some((p) => p.kind === "text" && p.text === "M-101")).toBe(true);
  });
});
