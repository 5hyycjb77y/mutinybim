/**
 * @jest-environment node
 *
 * Round 5b f-graphics (NEXT-BATCH 5b-3, KERNEL-FOUNDATION §3.12): one
 * category registry generated from the class registry, one override shape,
 * one resolver. The equivalence blocks run the code this replaced (copied
 * verbatim below as the "old path") against the resolver on the electrical
 * fixtures, so saved views resolve every category exactly as before.
 */
import {
  DRAFTING_CATEGORIES,
  VIEW_CATEGORIES,
  buildViewScene,
  builtinPartType,
  builtinRegistry,
  commandSchema,
  firstPartyServiceRegistry,
  gatedRecordFeatures,
  rawRegistryWords,
  withUpgradePolicy,
  type BimElement,
  type ModelState,
  type PartCategory,
  type Primitive,
  type ServiceDef,
  type ViewCategory,
  type ViewElement,
  type ViewProps,
} from "../src";
import {
  CATEGORY_OVERRIDES_FEATURE,
  CLASS_VIEW_CATEGORY,
  DEFAULT_LOOK,
  buildCategoryRegistry,
  builtinCategoryRegistry,
  categoryLook,
  drawnCategories,
  activeCategoryRegistry,
  elementClass,
  elementLook,
  elementViewCategory,
  planDisplayFor,
  viewCategoryOfPartCategory,
  withCategoryRegistry,
} from "../src/categories";
import { PART_CATEGORY_CLASSES } from "../src/registry/builtin";
import { partHiddenInView, partViewCategory } from "../src/view-categories";
import { Building } from "./fixtures/electrical-building";

// ── The old path, verbatim (view-categories.ts and drawing/views.ts before 5b) ──

const OLD_PART_VIEW_CATEGORY: Readonly<Partial<Record<PartCategory, ViewCategory>>> = {
  air_terminal: "air_terminal",
  duct_accessory: "duct_fitting",
  pipe_accessory: "pipe",
  electrical_device: "electrical_devices",
  lighting_fixture: "lighting_fixtures",
  electrical_equipment: "electrical_equipment",
};
const OLD_CATEGORY_OF: Partial<Record<BimElement["kind"], ViewCategory>> = {
  duct_segment: "duct",
  elbow: "duct_fitting",
  tap: "duct_fitting",
  terminal: "air_terminal",
  equipment: "equipment",
  wall: "walls",
  opening: "doors_windows",
  room: "rooms",
  grid: "grids",
  column: "structure",
  beam: "structure",
  tag: "tags",
  dimension: "dimensions",
};
function oldRunCategory(el: BimElement): "duct" | "duct_fitting" | "pipe" | null {
  if (el.kind === "run_segment") return el.domain === "duct" ? "duct" : "pipe";
  if (el.kind === "run_fitting") return el.domain === "duct" ? "duct_fitting" : "pipe";
  return null;
}
function oldPartViewCategory(model: Pick<ModelState, "elements">, el: BimElement): ViewCategory | null {
  if (el.kind !== "part") return null;
  const type = model.elements[el.typeId];
  if (type?.kind !== "part_type") return null;
  return OLD_PART_VIEW_CATEGORY[type.definition.category] ?? "equipment";
}
function oldHidden(model: ModelState, view: ViewElement, el: BimElement): boolean {
  const c = oldRunCategory(el) ?? OLD_CATEGORY_OF[el.kind];
  const partCat = oldPartViewCategory(model, el);
  return (c !== undefined && c !== null && (view.props?.hiddenCategories ?? []).includes(c)) || (partCat !== null && (view.props?.hiddenCategories ?? []).includes(partCat));
}
function oldPen(view: ViewElement, c: ViewCategory | null, kind: "cut" | "projection"): string | undefined {
  return c ? view.props?.lineWeights?.[c]?.[kind] : undefined;
}

// ── Fixtures ──

const crop = { min: { x: -12000, y: -8000 }, max: { x: 12000, y: 8000 } };

function e101(): Building {
  const b = new Building();
  const receptacle = builtinPartType("builtin:gfci-receptacle@1");
  const troffer = builtinPartType("builtin:troffer-2x4-led@1");
  if (!receptacle || !troffer) throw new Error("starter electrical types missing");
  b.ok({ type: "place_part", partId: "r1", typeId: "t-rec", partType: receptacle.definition, levelId: "lvl-1", position: { x: 0, y: 0 } });
  b.ok({ type: "place_part", partId: "f1", typeId: "t-tr", partType: troffer.definition, levelId: "lvl-1", position: { x: 3000, y: 2000 } });
  b.ok({ type: "place_part", partId: "fa1", typeId: "t-fa", partType: { ...receptacle.definition, familyName: "Fire alarm device", typeName: "Horn strobe" }, levelId: "lvl-1", position: { x: -3000, y: 1500 } });
  b.ok({ type: "create_view", viewId: "v-e101", name: "E-101 Power plan", viewType: "floor_plan", crop, props: { level: "Level 1", scale: 48, discipline: "electrical" } });
  b.ok({ type: "create_view", viewId: "v-hide", name: "Lights off", viewType: "floor_plan", crop, props: { level: "Level 1", scale: 48, hiddenCategories: ["lighting_fixtures", "tags"], lineWeights: { electrical_devices: { projection: "heavy", cut: "thin" } } } });
  b.ok({ type: "create_view", viewId: "v-mech", name: "Mechanical", viewType: "floor_plan", crop, props: { level: "Level 1", scale: 48, discipline: "mechanical", hiddenCategories: ["electrical_devices"] } });
  return b;
}

const views = (m: ModelState): ViewElement[] => Object.values(m.elements).filter((e): e is ViewElement => e.kind === "view");
const fireAlarmRegistry = () =>
  builtinRegistry()
    .extend()
    .addClass({
      id: "firm.fire_alarm_device",
      label: "Fire alarm device",
      discipline: "fire_protection",
      parent: "mep.electrical_device",
      recognize: { partCategories: ["electrical_device"], where: [{ path: "family", op: "contains", value: "Fire alarm" }] },
      source: "library:fire-alarm@1",
    })
    .build();

describe("r5g category registry", () => {
  it("every view category is a category with its existing id, label and no parent", () => {
    const reg = builtinCategoryRegistry();
    for (const c of VIEW_CATEGORIES) {
      const def = reg.get(c);
      expect(def?.source).toBe("view");
      expect(def?.parent).toBeUndefined();
      expect(def?.label).toMatch(/^[A-Z]/);
    }
  });

  it("every class is a category; a class drawn under a view category is its subcategory", () => {
    const reg = builtinCategoryRegistry();
    for (const cls of builtinRegistry().listClasses({ includeAbstract: true })) expect(reg.get(cls.id)?.source).toBe("class");
    expect(reg.lineage("mep.electrical_device")).toEqual(["mep.electrical_device", "electrical_devices"]);
    expect(reg.lineage("mep.electrical_equipment")).toEqual(["mep.electrical_equipment", "electrical_equipment"]);
  });

  it("drafting categories map in as drafting:<id>", () => {
    const reg = builtinCategoryRegistry();
    for (const d of DRAFTING_CATEGORIES) expect(reg.get(`drafting:${d}`)?.source).toBe("drafting");
  });

  it("a firm class appears with no code change and follows the class it extends", () => {
    const reg = buildCategoryRegistry({ classes: fireAlarmRegistry() });
    expect(reg.get("firm.fire_alarm_device")).toMatchObject({ label: "Fire alarm device", source: "firm", discipline: "fire_protection", parent: "mep.electrical_device" });
    expect(reg.lineage("firm.fire_alarm_device")).toEqual(["firm.fire_alarm_device", "mep.electrical_device", "electrical_devices"]);
    expect(drawnCategories(reg).map((c) => c.id)).toContain("firm.fire_alarm_device");
    // Known only by its library summary (before the library registry loads): still listed.
    const fromSummary = buildCategoryRegistry({ extraClasses: [{ id: "firm.fire_alarm_device", label: "Fire alarm device" }] });
    expect(fromSummary.get("firm.fire_alarm_device")?.source).toBe("firm");
  });

  it("services become service:<id> categories carrying their default line look", () => {
    const grease: ServiceDef = {
      id: "grease_waste",
      label: "Grease waste",
      discipline: "plumbing",
      medium: "liquid",
      regime: "gravity",
      connector: "pipe",
      quantities: ["load.dfu"],
      asSystem: true,
      asLoad: false,
      ifc: { system: "IfcDistributionSystem", predefinedType: "WASTEWATER" },
      graphics: { colour: "#7a4b00", pattern: "dash_dot", weight: "medium" },
    };
    const reg = buildCategoryRegistry({ services: [grease] });
    expect(reg.get("service:grease_waste")).toMatchObject({ label: "Grease waste", source: "service", discipline: "plumbing", defaults: { colour: "#7a4b00", pattern: "dash_dot", lineWeights: { projection: "medium" } } });
    expect(reg.revision).not.toBe(builtinCategoryRegistry().revision);
  });

  it("the built-in categories carry every built-in service, grease waste with its heavy line", () => {
    const reg = builtinCategoryRegistry();
    for (const s of firstPartyServiceRegistry().rows) expect(reg.get(`service:${s.id}`)?.source).toBe("service");
    expect(reg.get("service:grease_waste")).toMatchObject({ label: "Grease waste", discipline: "plumbing", defaults: { colour: "#6d4c1f", pattern: "solid", lineWeights: { projection: "heavy" } } });
  });

  it("PART_VIEW_CATEGORY is now a view of the registry: identical for every part category", () => {
    for (const cat of Object.keys(PART_CATEGORY_CLASSES) as PartCategory[]) {
      expect(viewCategoryOfPartCategory(cat)).toBe(OLD_PART_VIEW_CATEGORY[cat] ?? "equipment");
    }
    expect(Object.values(CLASS_VIEW_CATEGORY).every((c) => (VIEW_CATEGORIES as readonly string[]).includes(c))).toBe(true);
  });
});

describe("r5g one resolver: equivalence with the old path on the E-101 fixture", () => {
  it("every view resolves every element's visibility and pens exactly as the old code did", () => {
    const b = e101();
    const m = b.head;
    let compared = 0;
    for (const view of views(m)) {
      for (const el of Object.values(m.elements)) {
        const look = elementLook(m, view, el);
        expect(!look.visible).toBe(oldHidden(m, view, el));
        if (el.kind === "part") expect(partHiddenInView(m, view, el)).toBe(oldHidden(m, view, el));
        const c = oldRunCategory(el) ?? OLD_CATEGORY_OF[el.kind] ?? oldPartViewCategory(m, el);
        expect(elementViewCategory(m.elements, el)).toBe(c ?? null);
        expect(partViewCategory(m, el)).toBe(oldPartViewCategory(m, el));
        for (const kind of ["cut", "projection"] as const) expect(look.lineWeights[kind]).toBe(oldPen(view, c ?? null, kind));
        expect(look.halftone).toBeNull();
        expect(look.planSymbol).toBeNull();
        compared++;
      }
      for (const c of VIEW_CATEGORIES) {
        const look = categoryLook(view, c);
        expect(look.visible).toBe(!(view.props?.hiddenCategories ?? []).includes(c));
        expect(look.lineWeights.cut).toBe(view.props?.lineWeights?.[c]?.cut);
        expect(look.lineWeights.projection).toBe(view.props?.lineWeights?.[c]?.projection);
      }
    }
    expect(compared).toBeGreaterThan(20);
  });

  it("a view with no overrides resolves unknown and class categories to the drawing default", () => {
    const view = { props: {} } as const;
    expect(categoryLook(view, "mep.service_link")).toBe(DEFAULT_LOOK);
    expect(categoryLook(view, "firm.nothing_here")).toBe(DEFAULT_LOOK);
  });
});

describe("r5g one override shape: category → parent → legacy → default", () => {
  const props = (p: ViewProps) => ({ props: p });

  it("an override wins over the older fields; its parent's override applies to subcategories", () => {
    const reg = buildCategoryRegistry({ classes: fireAlarmRegistry() });
    const v = props({ hiddenCategories: ["electrical_devices"], lineWeights: { electrical_devices: { projection: "thin" } }, categoryOverrides: { "mep.electrical_device": { halftone: true }, "firm.fire_alarm_device": { visible: true, lineWeights: { projection: "heavy" } } } });
    expect(categoryLook(v, "electrical_devices", reg)).toMatchObject({ visible: false, halftone: null, lineWeights: { projection: "thin" } });
    expect(categoryLook(v, "mep.electrical_device", reg)).toMatchObject({ visible: false, halftone: true, lineWeights: { projection: "thin" } });
    expect(categoryLook(v, "firm.fire_alarm_device", reg)).toMatchObject({ visible: true, halftone: true, lineWeights: { projection: "heavy" } });
  });

  it("a firm class's elements resolve through it while the firm registry is active", () => {
    const b = e101();
    const reg = buildCategoryRegistry({ classes: fireAlarmRegistry() });
    const fa = b.head.elements.fa1;
    const rec = b.head.elements.r1;
    if (!fa || !rec) throw new Error("fixture parts missing");
    expect(elementClass(b.head.elements, fa, reg)).toBe("firm.fire_alarm_device");
    expect(elementClass(b.head.elements, rec, reg)).toBe("mep.electrical_device");
    const view = props({ categoryOverrides: { "firm.fire_alarm_device": { visible: false } } });
    withCategoryRegistry(reg, () => {
      expect(elementLook(b.head, view, fa).visible).toBe(false);
      expect(elementLook(b.head, view, rec).visible).toBe(true);
    });
    // Without the firm registry the class is unknown: nothing is hidden by it.
    expect(elementLook(b.head, view, fa).visible).toBe(true);
  });

  it("plan symbol or body: the override decides only when the part can draw that way", () => {
    expect(planDisplayFor(null, { typeDisplay: "both", hasSymbol: true, hasBody: true })).toBe("both");
    expect(planDisplayFor(true, { typeDisplay: "both", hasSymbol: true, hasBody: true })).toBe("symbol");
    expect(planDisplayFor(false, { typeDisplay: undefined, hasSymbol: true, hasBody: true })).toBe("model");
    expect(planDisplayFor(false, { typeDisplay: undefined, hasSymbol: true, hasBody: false })).toBe("symbol");
    expect(planDisplayFor(true, { typeDisplay: "model", hasSymbol: false, hasBody: true })).toBe("model");
  });
});

describe("r5g plans draw through the resolver", () => {
  const scene = (b: Building, viewId: string): readonly Primitive[] => buildViewScene(b.head, viewId).scene.primitives;
  const allow = <T,>(fn: () => T): T => withUpgradePolicy((f) => f === CATEGORY_OVERRIDES_FEATURE, fn);

  it("halftone on electrical devices halftones the receptacle on an electrical plan (old code: ink)", () => {
    const b = e101();
    const before = scene(b, "v-e101");
    allow(() => b.ok({ type: "set_view_properties", viewId: "v-e101", props: { categoryOverrides: { electrical_devices: { halftone: true } } } }));
    const after = scene(b, "v-e101");
    const inkLines = (prims: readonly Primitive[]) => prims.filter((p) => p.kind === "line" && p.tone === undefined).length;
    expect(inkLines(after)).toBeLessThan(inkLines(before));
    expect(after.filter((p) => p.kind === "line" && p.tone === "halftone").length).toBeGreaterThan(before.filter((p) => p.kind === "line" && p.tone === "halftone").length);
    // Clearing the overrides puts the plan back byte for byte.
    allow(() => b.ok({ type: "set_view_properties", viewId: "v-e101", props: { categoryOverrides: {} } }));
    expect(JSON.stringify(scene(b, "v-e101"))).toBe(JSON.stringify(before));
    expect(b.head.elements["v-e101"]?.kind === "view" && b.head.elements["v-e101"].props?.categoryOverrides).toBeFalsy();
  });

  it("an override naming no category on the plan prints byte-identical", () => {
    const b = e101();
    const before = JSON.stringify(scene(b, "v-hide"));
    allow(() => b.ok({ type: "set_view_properties", viewId: "v-hide", props: { categoryOverrides: { "service:grease_waste": { pattern: "dashed" } } } }));
    expect(JSON.stringify(scene(b, "v-hide"))).toBe(before);
  });

  it("a pattern override dashes the category's linework", () => {
    const b = e101();
    allow(() => b.ok({ type: "set_view_properties", viewId: "v-e101", props: { categoryOverrides: { lighting_fixtures: { pattern: "dashed" } } } }));
    expect(scene(b, "v-e101").some((p) => p.kind === "line" && JSON.stringify(p.dash) === JSON.stringify([4, 2]))).toBe(true);
  });
});

describe("r5g expand, then contract: overrides are written only when the model server reads them", () => {
  it("the feature is a gated record feature, so this release's clients and servers advertise it", () => {
    expect(gatedRecordFeatures()).toContain(CATEGORY_OVERRIDES_FEATURE);
  });

  it("refuses to store overrides for a server that does not advertise the feature, in plain words", () => {
    const b = e101();
    const message = b.refused({ type: "set_view_properties", viewId: "v-e101", props: { categoryOverrides: { electrical_devices: { halftone: true } } } });
    expect(message).toMatch(/can't save per-category graphics yet/);
    // The older fields still save, and clearing never needs the feature.
    b.ok({ type: "set_view_properties", viewId: "v-e101", props: { hiddenCategories: ["tags"], categoryOverrides: {} } });
  });

  it("validates the override shape (category fields only)", () => {
    const parse = (categoryOverrides: unknown) => commandSchema.safeParse({ type: "set_view_properties", viewId: "v-e101", props: { categoryOverrides } }).success;
    expect(parse({ electrical_devices: { visible: false, halftone: true, lineWeights: { cut: "wide" }, pattern: "dash_dot", colour: "#ff0000", planSymbol: true }, "service:grease_waste": { pattern: "dashed" }, "firm.fire_alarm_device": { visible: false } })).toBe(true);
    expect(parse({ electrical_devices: { colour: "red" } })).toBe(false);
    expect(parse({ "Bad Id": { visible: false } })).toBe(false);
    expect(parse({ electrical_devices: { pattern: "zigzag" } })).toBe(false);
    expect(parse({ electrical_devices: { glow: true } })).toBe(false);
  });
});

describe("r5g phase 3: tolerant category ids, drawsUnder, one registry per draw", () => {
  const allow = <T,>(fn: () => T): T => withUpgradePolicy((f) => f === CATEGORY_OVERRIDES_FEATURE, fn);
  const props = (b: Building, id: string): ViewProps => {
    const v = b.head.elements[id];
    if (v?.kind !== "view") throw new Error("no view");
    return v.props ?? {};
  };

  it("a view saved with a pack category this release doesn't know keeps it byte for byte through an edit (A2/E3)", () => {
    const b = e101();
    const pack = { "fp.sprinkler_head": { visible: false, halftone: true, lineWeights: { projection: "thin" as const } } };
    allow(() => b.ok({ type: "set_view_properties", viewId: "v-e101", props: { categoryOverrides: pack } }));
    // What the Visibility/Graphics table sends for one more change: the whole map, the unknown row included.
    const next = { ...props(b, "v-e101").categoryOverrides, electrical_devices: { halftone: true } };
    allow(() => b.ok({ type: "set_view_properties", viewId: "v-e101", props: { categoryOverrides: next } }));
    expect(JSON.stringify(props(b, "v-e101").categoryOverrides?.["fp.sprinkler_head"])).toBe(JSON.stringify(pack["fp.sprinkler_head"]));
    expect(builtinCategoryRegistry().get("fp.sprinkler_head")).toBeUndefined();
    expect(categoryLook({ props: props(b, "v-e101") }, "fp.sprinkler_head")).toMatchObject({ visible: false, halftone: true });
    expect(rawRegistryWords("fp.sprinkler_head")).toBe("Sprinkler head");
    expect(commandSchema.safeParse({ type: "set_view_properties", viewId: "v-e101", props: { categoryOverrides: { "fp.sprinkler_head": { maskBeneath: true, transparency: 0.4 } } } }).success).toBe(true);
    expect(commandSchema.safeParse({ type: "set_view_properties", viewId: "v-e101", props: { categoryOverrides: { "fp.sprinkler_head": { transparency: 2 } } } }).success).toBe(false);
  });

  it("a class's drawsUnder places its instances under the category it names, in a view with no overrides (E1; old code: ignored)", () => {
    const b = e101();
    const classes = builtinRegistry()
      .extend()
      .addClass({ id: "fa.horn_strobe", label: "Horn strobe", discipline: "fire_protection", parent: "mep.electrical_device", drawsUnder: "lighting_fixtures", recognize: { partCategories: ["electrical_device"], where: [{ path: "family", op: "contains", value: "Fire alarm" }] }, source: "library:fa@1" })
      .build();
    const reg = buildCategoryRegistry({ classes });
    expect(reg.lineage("fa.horn_strobe")).toEqual(["fa.horn_strobe", "lighting_fixtures"]);
    expect(reg.classesPlaceElements).toBe(true);
    // Round 14: Structural is first-party and its member classes name where they draw (`drawsUnder`), so the built-in registry places elements too.
    expect(builtinCategoryRegistry().classesPlaceElements).toBe(true);
    const fa = b.head.elements.fa1;
    const rec = b.head.elements.r1;
    if (!fa || !rec) throw new Error("fixture parts missing");
    const lightsOff = { props: { hiddenCategories: ["lighting_fixtures" as const] } };
    withCategoryRegistry(reg, () => {
      expect(elementLook(b.head, lightsOff, fa).visible).toBe(false);
      expect(elementLook(b.head, lightsOff, rec).visible).toBe(true);
    });
  });

  it("the kernel's classes place every fixture element under the view category it always drew under (chain order equivalence)", () => {
    const b = e101();
    const reg = builtinCategoryRegistry();
    for (const el of Object.values(b.head.elements)) {
      const cls = elementClass(b.head.elements, el, reg);
      const classView = cls === null ? undefined : reg.lineage(cls).find((id) => reg.get(id)?.source === "view");
      if (classView !== undefined) expect(classView).toBe(elementViewCategory(b.head.elements, el));
    }
  });

  it("a firm's registry is in force only inside its synchronous draw (H2: no leak to the next model in the process)", () => {
    const firm = buildCategoryRegistry({ classes: fireAlarmRegistry() });
    expect(withCategoryRegistry(firm, () => activeCategoryRegistry())).toBe(firm);
    expect(activeCategoryRegistry()).toBe(builtinCategoryRegistry());
    expect(() => withCategoryRegistry(firm, async () => activeCategoryRegistry())).toThrow(/synchronous/);
    expect(activeCategoryRegistry()).toBe(builtinCategoryRegistry());
    expect(() => withCategoryRegistry(firm, () => {
      throw new Error("draw failed");
    })).toThrow("draw failed");
    expect(activeCategoryRegistry()).toBe(builtinCategoryRegistry());
  });
});
