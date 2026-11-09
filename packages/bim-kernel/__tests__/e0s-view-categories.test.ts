/**
 * @jest-environment node
 *
 * Electrical Demo 2 (9:09, 10:37): a plan's "Categories shown" had no
 * electrical devices, lighting fixtures, panels or insulation, so none of them
 * could be switched off or given a pen; and a linked model's Underlay and
 * See-through looked exactly like Halftone in a plan's live canvas.
 */
import {
  UNDERLAY_MIN_TRANSPARENCY_PCT,
  VIEW_CATEGORIES,
  buildViewScene,
  builtinPartType,
  commandSchema,
  referencePresetDisplay,
  resolveCanvasDisplay,
  resolveReferenceDisplay,
  type Primitive,
  type ViewCategory,
} from "../src";
import { partViewCategory } from "../src/view-categories";
import { Building } from "./fixtures/electrical-building";

const SCALE = 48;
const crop = { min: { x: -12000, y: -8000 }, max: { x: 12000, y: 8000 } };

function withDevices(): Building {
  const b = new Building();
  const receptacle = builtinPartType("builtin:gfci-receptacle@1");
  const troffer = builtinPartType("builtin:troffer-2x4-led@1");
  if (!receptacle || !troffer) throw new Error("starter electrical types missing");
  b.ok({ type: "place_part", partId: "r1", typeId: "t-rec", partType: receptacle.definition, levelId: "lvl-1", position: { x: 0, y: 0 } });
  b.ok({ type: "place_part", partId: "f1", typeId: "t-tr", partType: troffer.definition, levelId: "lvl-1", position: { x: 3000, y: 2000 } });
  b.ok({ type: "create_view", viewId: "v-p", name: "Level 1 Power", viewType: "floor_plan", crop, props: { level: "Level 1", scale: SCALE } });
  return b;
}

function primitives(b: Building): string {
  return JSON.stringify(buildViewScene(b.head, "v-p").scene.primitives.filter((p: Primitive) => p.kind !== "text"));
}

describe("view categories for the electrical trades", () => {
  it("lists devices, lighting fixtures, panels and insulation after every earlier category, unchanged", () => {
    expect(VIEW_CATEGORIES.slice(0, 12)).toEqual(["duct", "duct_fitting", "pipe", "air_terminal", "equipment", "walls", "doors_windows", "rooms", "grids", "structure", "tags", "dimensions"]);
    const added: ViewCategory[] = ["electrical_devices", "lighting_fixtures", "electrical_equipment", "insulation"];
    for (const c of added) expect(VIEW_CATEGORIES).toContain(c);
  });

  it("a view can switch electrical devices off and set their pen (the command takes the new names)", () => {
    const ok = commandSchema.safeParse({ type: "set_view_properties", viewId: "v-p", props: { hiddenCategories: ["electrical_devices"], lineWeights: { lighting_fixtures: { projection: "heavy" } } } });
    expect(ok.success).toBe(true);
  });

  it("classifies a part by its type: a receptacle is an electrical device, a troffer a lighting fixture", () => {
    const b = withDevices();
    const r1 = b.head.elements.r1;
    const f1 = b.head.elements.f1;
    if (!r1 || !f1) throw new Error("parts not placed");
    expect(partViewCategory(b.head, r1)).toBe("electrical_devices");
    expect(partViewCategory(b.head, f1)).toBe("lighting_fixtures");
  });

  it("hiding electrical devices removes the receptacle from the plan and nothing else", () => {
    const b = withDevices();
    const all = primitives(b);
    b.ok({ type: "set_view_properties", viewId: "v-p", props: { hiddenCategories: ["electrical_devices"] } });
    const without = primitives(b);
    expect(without).not.toEqual(all);
    b.ok({ type: "set_view_properties", viewId: "v-p", props: { hiddenCategories: ["electrical_devices", "lighting_fixtures"] } });
    const neither = primitives(b);
    expect(neither.length).toBeLessThan(without.length);
    b.ok({ type: "set_view_properties", viewId: "v-p", props: { hiddenCategories: [] } });
    expect(primitives(b)).toEqual(all);
  });

  it("a pen set for lighting fixtures reaches the troffer's symbol; with no pens set the plan draws as before", () => {
    const b = withDevices();
    const plain = primitives(b);
    b.ok({ type: "set_view_properties", viewId: "v-p", props: { hiddenCategories: ["insulation"] } });
    expect(primitives(b)).toEqual(plain);
    b.ok({ type: "set_view_properties", viewId: "v-p", props: { hiddenCategories: [], lineWeights: { lighting_fixtures: { projection: "heavy" } } } });
    expect(primitives(b)).not.toEqual(plain);
  });
});

describe("linked-model look in a plan's live canvas", () => {
  it("Underlay is see-through beneath our work, not an opaque copy of Halftone", () => {
    const underlay = referencePresetDisplay("underlay");
    const halftone = referencePresetDisplay("halftone");
    expect(resolveReferenceDisplay(underlay, "drawing", "architecture").transparencyPct).toBe(0);
    expect(resolveCanvasDisplay(underlay, "drawing", "architecture").transparencyPct).toBeGreaterThanOrEqual(UNDERLAY_MIN_TRANSPARENCY_PCT);
    expect(resolveCanvasDisplay(halftone, "drawing", "architecture").transparencyPct).toBe(0);
  });

  it("See-through keeps its amount; Hidden stays hidden; no setting is unchanged", () => {
    expect(resolveCanvasDisplay(referencePresetDisplay("transparent"), "drawing", "architecture").transparencyPct).toBe(60);
    expect(resolveCanvasDisplay(referencePresetDisplay("hidden"), "drawing", "architecture").visible).toBe(false);
    expect(resolveCanvasDisplay(undefined, "drawing", "mep")).toEqual(resolveReferenceDisplay(undefined, "drawing", "mep"));
    expect(resolveCanvasDisplay(underlay3d(), "3d", "architecture")).toEqual(resolveReferenceDisplay(underlay3d(), "3d", "architecture"));
  });
});

function underlay3d() {
  return referencePresetDisplay("underlay");
}
