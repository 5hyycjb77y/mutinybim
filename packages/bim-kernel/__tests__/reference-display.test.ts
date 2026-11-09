import {
  REFERENCE_DISPLAY_PRESETS,
  buildViewScene,
  commandSchema,
  planCommit,
  referenceDisplayFor,
  referenceDisplayPreset,
  referencePresetDisplay,
  resolveReferenceDisplay,
  withCategoryDisplay,
  type ModelState,
  type ReferencePlan,
  type SheetReference,
  type ViewElement,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

const actor = { id: "avery", name: "Avery", kind: "human" as const };
let seq = 0;

function commit(head: ModelState, command: { readonly type: string } & Record<string, unknown>): ModelState {
  seq += 1;
  const d = planCommit(head, [], { idempotencyKey: `ref-display-${seq}`, baseRevision: head.revision, actor, command: commandSchema.parse(command) }, () => "2026-10-21T00:00:00.000Z");
  if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
  return d.model;
}

function refused(head: ModelState, command: { readonly type: string } & Record<string, unknown>): boolean {
  return !commandSchema.safeParse(command).success || !planCommit(head, [], { idempotencyKey: `ref-display-${++seq}`, baseRevision: head.revision, actor, command: commandSchema.parse(command) }, () => "2026-10-21T00:00:00.000Z").ok;
}

const plan: ReferencePlan = {
  id: "arch",
  source: { file: "arch.ifc", sha256: "0".repeat(64) },
  level: { name: "LEVEL 1", elevationMm: 0 },
  cutHeightMm: 1200,
  bounds: { min: { x: -100_000, y: -100_000 }, max: { x: 100_000, y: 100_000 } },
  layers: [
    { id: "w", discipline: "architecture", kind: "cut", category: "IFCWALL", segments: [0, 2000, 10000, 2000] },
    { id: "d", discipline: "architecture", kind: "cut", category: "IFCDOOR", segments: [2000, 2000, 3000, 2000] },
  ],
  labels: [],
};
const background: SheetReference = { plan, pen: "medium", tone: "ink" };

function planModel(references?: Record<string, unknown>): ModelState {
  return commit(createDemoModel(), { type: "create_view", viewId: "v-plan", name: "Level 1 Mechanical", viewType: "floor_plan", props: { level: "L1", ...(references ? { references } : {}) } });
}

function view(m: ModelState, id: string): ViewElement {
  const v = m.elements[id];
  if (!v || v.kind !== "view") throw new Error(`no view ${id}`);
  return v;
}

/** Tones of the linked linework in the plan's drawing, per layer category (by segment length, which is unique per layer here). */
function linkedTones(m: ModelState): string[] {
  const { scene } = buildViewScene(m, "v-plan", [background]);
  return scene.primitives.flatMap((p) => (p.kind === "line" && p.tone !== undefined ? [p.tone] : []));
}

describe("linked model display defaults", () => {
  it("architecture is halftone in drawings and halftone + 30% see-through in 3D; MEP stays in colour in 3D", () => {
    expect(resolveReferenceDisplay(undefined, "drawing", "architecture")).toEqual({ visible: true, halftone: true, transparencyPct: 0, underlay: false, categories: {}, cutPen: null, beyondPen: null });
    expect(resolveReferenceDisplay(undefined, "3d", "architecture")).toEqual({ visible: true, halftone: true, transparencyPct: 30, underlay: false, categories: {}, cutPen: null, beyondPen: null });
    expect(resolveReferenceDisplay(undefined, "3d", "mep")).toEqual({ visible: true, halftone: false, transparencyPct: 0, underlay: false, categories: {}, cutPen: null, beyondPen: null });
  });

  it("an underlay is greyed everywhere and at least 65% see-through in 3D", () => {
    const d = resolveReferenceDisplay({ visible: true, halftone: false, underlay: true, transparencyPct: 10 }, "3d", "mep");
    expect(d.halftone).toBe(true);
    expect(d.transparencyPct).toBe(65);
    expect(resolveReferenceDisplay({ visible: true, halftone: true, underlay: true }, "drawing", "architecture").transparencyPct).toBe(0);
  });

  it("the free model reads as 3D; a plan reads as a drawing", () => {
    expect(referenceDisplayFor(null, "arch", "architecture").transparencyPct).toBe(30);
    expect(referenceDisplayFor(view(planModel(), "v-plan"), "arch", "architecture").transparencyPct).toBe(0);
  });

  it("each preset round-trips to itself", () => {
    for (const preset of REFERENCE_DISPLAY_PRESETS) expect(referenceDisplayPreset(referencePresetDisplay(preset))).toBe(preset);
    expect(referenceDisplayPreset(undefined)).toBe("halftone");
    expect(referenceDisplayPreset(withCategoryDisplay(referencePresetDisplay("normal"), "IFCDOOR", { visible: false }))).toBe("custom");
    expect(referenceDisplayPreset({ visible: true, halftone: true, transparencyPct: 45 })).toBe("custom");
  });
});

describe("set_view_properties stores linked model display", () => {
  it("keeps transparency, underlay and category overrides on the view", () => {
    const m = commit(planModel(), {
      type: "set_view_properties",
      viewId: "v-plan",
      props: { references: { arch: { visible: true, halftone: true, transparencyPct: 40, underlay: true, categories: { IFCDOOR: { visible: false } } } } },
    });
    expect(view(m, "v-plan").props?.references?.arch).toEqual({ visible: true, halftone: true, transparencyPct: 40, underlay: true, categories: { IFCDOOR: { visible: false } } });
  });

  it("refuses transparency over 90%, a non-IFC category and unknown fields", () => {
    const m = planModel();
    const set = (arch: Record<string, unknown>) => ({ type: "set_view_properties", viewId: "v-plan", props: { references: { arch } } });
    expect(refused(m, set({ visible: true, halftone: true, transparencyPct: 95 }))).toBe(true);
    expect(refused(m, set({ visible: true, halftone: true, categories: { walls: { visible: false } } }))).toBe(true);
    expect(refused(m, set({ visible: true, halftone: true, opacity: 0.5 }))).toBe(true);
  });
});

describe("plans draw linked models by the view's display", () => {
  it("default and halftone draw the linked linework halftone", () => {
    expect(new Set(linkedTones(planModel()))).toEqual(new Set(["halftone"]));
  });

  it("normal draws it in its own tone", () => {
    expect(linkedTones(planModel({ arch: referencePresetDisplay("normal") }))).not.toContain("halftone");
  });

  it("underlay draws it screened, lighter than halftone", () => {
    expect(new Set(linkedTones(planModel({ arch: referencePresetDisplay("underlay") })))).toEqual(new Set(["screened"]));
  });

  it("a hidden category drops out; a category set back to ink draws ink inside a halftone model", () => {
    const hiddenDoors = linkedTones(planModel({ arch: { visible: true, halftone: true, categories: { IFCDOOR: { visible: false } } } }));
    expect(hiddenDoors).toHaveLength(linkedTones(planModel()).length - 1);
    const inkWalls = linkedTones(planModel({ arch: { visible: true, halftone: true, categories: { IFCWALL: { halftone: false } } } }));
    expect(inkWalls.filter((t) => t === "ink")).toHaveLength(1);
    expect(inkWalls.filter((t) => t === "halftone")).toHaveLength(1);
  });

  it("hidden draws none of it", () => {
    expect(linkedTones(planModel({ arch: referencePresetDisplay("hidden") }))).toEqual([]);
  });
});

describe("the working 3D view keeps its own linked model display", () => {
  it("create_3d_view can start a person's working view with a linked model halftone and see-through", () => {
    const m = commit(createDemoModel(), {
      type: "create_3d_view",
      viewId: "v-work",
      name: "Avery's 3D",
      workingFor: "avery",
      cropView: false,
      showCropBox: false,
      references: { arch: referencePresetDisplay("transparent") },
    });
    const v = view(m, "v-work");
    expect(v.props?.workingFor).toBe("avery");
    expect(v.props?.cropView).toBe(false);
    expect(referenceDisplayFor(v, "arch", "architecture")).toMatchObject({ halftone: true, transparencyPct: 60 });
    const after = commit(m, { type: "set_view_properties", viewId: "v-work", props: { references: { arch: referencePresetDisplay("normal") } } });
    expect(referenceDisplayFor(view(after, "v-work"), "arch", "architecture")).toMatchObject({ halftone: false, transparencyPct: 0 });
  });
});
