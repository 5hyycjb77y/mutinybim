import {
  buildSheetScene,
  canonicalJson,
  clipSegment,
  demoSheetDefinition,
  isReferencePlan,
  referenceStroke,
  validateModel,
  type ReferencePlan,
} from "../src";
import { createDemoModel, createPlacedDemoModel } from "@permitzip/bim-pack-mechanical/seed";

const plan: ReferencePlan = {
  id: "test-arch",
  source: { file: "arch.ifc", sha256: "0".repeat(64) },
  level: { name: "LEVEL 1", elevationMm: 0 },
  cutHeightMm: 1200,
  bounds: { min: { x: -100_000, y: -100_000 }, max: { x: 100_000, y: 100_000 } },
  // One wall inside the demo viewport, one far outside it.
  layers: [{ id: "w", discipline: "architecture", kind: "cut", category: "IFCWALL", segments: [0, 2000, 10000, 2000, 90_000, 90_000, 95_000, 90_000] }],
  labels: [{ text: "STORAGE 101", at: { x: 5000, y: 2500 } }],
};

describe("linked references", () => {
  it("clips segments to a box and drops ones fully outside", () => {
    expect(clipSegment({ x: -10, y: 5 }, { x: 10, y: 5 }, { x: 0, y: 0 }, { x: 8, y: 8 })).toEqual([
      { x: 0, y: 5 },
      { x: 8, y: 5 },
    ]);
    expect(clipSegment({ x: 20, y: 20 }, { x: 30, y: 30 }, { x: 0, y: 0 }, { x: 8, y: 8 })).toBeNull();
  });

  it("recognises reference plans and rejects other JSON", () => {
    expect(isReferencePlan(plan)).toBe(true);
    expect(isReferencePlan({ layers: "nope" })).toBe(false);
  });

  it("a sheet without references draws exactly as before", () => {
    const model = createDemoModel();
    const a = buildSheetScene(model, demoSheetDefinition());
    const b = buildSheetScene(model, { ...demoSheetDefinition(), references: [] });
    expect(canonicalJson(b.primitives)).toBe(canonicalJson(a.primitives));
  });

  it("draws references screened, under the model, clipped to the viewport", () => {
    const model = createDemoModel();
    const plain = buildSheetScene(model, demoSheetDefinition());
    const withRef = buildSheetScene(model, { ...demoSheetDefinition(), references: [{ plan, pen: "medium", tone: "halftone" }] });
    const refLines = withRef.primitives.filter((p) => p.kind === "line" && p.tone === "halftone");
    expect(refLines).toHaveLength(1); // the far wall is outside the viewport
    const label = withRef.primitives.find((p) => p.kind === "text" && p.text === "STORAGE 101");
    expect(label && label.kind === "text" ? label.tone : null).toBe("halftone");
    // References come before every native primitive except the sheet border.
    const firstNative = withRef.primitives.findIndex((p, i) => i > 0 && !(p.kind === "line" && p.tone) && !(p.kind === "text" && p.tone));
    const lastRef = withRef.primitives.reduce((last, p, i) => ((p.kind === "line" || p.kind === "text") && p.tone ? i : last), -1);
    expect(lastRef).toBeLessThan(firstNative);
    expect(withRef.primitives.length).toBe(plain.primitives.length + 2);
  });

  it("a placed demo is the same valid network, translated", () => {
    const origin = { x: 119_500, y: -26_000 };
    const base = createDemoModel("site");
    const placed = createPlacedDemoModel("site", origin);
    expect(validateModel(placed)).toEqual([]);
    expect(placed.connections).toEqual(base.connections);
    const trunk = placed.elements["seg-trunk"];
    const baseTrunk = base.elements["seg-trunk"];
    if (!trunk || trunk.kind !== "duct_segment" || !baseTrunk || baseTrunk.kind !== "duct_segment") throw new Error("trunk missing");
    expect(trunk.start).toEqual({ x: baseTrunk.start.x + origin.x, y: baseTrunk.start.y + origin.y });
    const sd = placed.elements["sd-1"];
    const baseSd = base.elements["sd-1"];
    if (!sd || sd.kind !== "terminal" || !baseSd || baseSd.kind !== "terminal") throw new Error("terminal missing");
    expect(sd.cfm).toBe(baseSd.cfm);
  });

  it("styles reference layers by kind and category, falling back to the reference pen", () => {
    const layered: ReferencePlan = {
      ...plan,
      layers: [
        { id: "cut-wall", discipline: "architecture", kind: "cut", category: "IFCWALL", segments: [0, 2000, 10000, 2000] },
        { id: "cut-window", discipline: "architecture", kind: "cut", category: "IFCWINDOW", segments: [0, 2500, 10000, 2500] },
        { id: "beyond", discipline: "architecture", kind: "projection", category: "IFCSLAB", segments: [0, 3000, 10000, 3000] },
      ],
      labels: [],
    };
    const ref = {
      plan: layered,
      pen: "thin" as const,
      tone: "screened" as const,
      strokes: { "cut:IFCWALL": { pen: "heavy" as const, tone: "halftone" as const }, projection: { pen: "thin" as const, tone: "screened" as const, dash: [2, 1] } },
    };
    expect(referenceStroke(ref, { kind: "cut", category: "IFCWALL" })).toEqual({ pen: "heavy", tone: "halftone" });
    expect(referenceStroke(ref, { kind: "cut", category: "IFCWINDOW" })).toEqual({ pen: "thin", tone: "screened" });
    const scene = buildSheetScene(createDemoModel(), { ...demoSheetDefinition(), references: [ref] });
    const lines = scene.primitives.filter((p) => p.kind === "line" && p.tone !== undefined);
    expect(lines.map((p) => (p.kind === "line" ? [p.pen, p.tone, p.dash ?? null] : null))).toEqual([
      ["heavy", "halftone", null],
      ["thin", "screened", null],
      ["thin", "screened", [2, 1]],
    ]);
  });
});
