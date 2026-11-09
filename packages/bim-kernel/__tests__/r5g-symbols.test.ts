/**
 * @jest-environment node
 *
 * Symbols as data (round 5b E2). The electrical one-line symbols are rows of
 * an immutable symbol registry and draft exactly as before; a symbol added
 * as a row (no code) drafts in a detail view and draws in plans for the
 * class that names it. Before this, a symbol existed only as code in
 * `electrical-symbols.ts` / `detailing.ts`, and an unknown id was refused.
 */
import { DEFAULT_SETTINGS, buildViewScene, builtinPartType, builtinRegistry, detailComponent, planCommit, type Command, type ModelState, type Primitive } from "../src";
import { ELECTRICAL_COMPONENTS } from "@permitzip/bim-pack-electrical";
import {
  BUILTIN_SYMBOL_REGISTRY,
  activeSymbolRegistry,
  buildCategoryRegistry,
  createSymbolRegistry,
  draftingFormOf,
  symbolById,
  withCategoryRegistry,
  withSymbolRegistry,
  withSymbolRows,
  type SymbolDef,
} from "../src/categories";

let seq = 0;
function run(m: ModelState, command: Command): ModelState {
  seq += 1;
  const d = planCommit(m, [], { idempotencyKey: `r5g-sym-${seq}`, baseRevision: m.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, () => "2026-10-29T00:00:00.000Z");
  if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
  return d.model;
}
const empty = (): ModelState => ({ modelId: "r5g-sym", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS });
const lines = (prims: readonly Primitive[]) => prims.filter((p) => p.kind === "line");

/** A firm's smoke detector, as data: a 300 mm circle with an "SD" cross, attached at its centre. */
const SMOKE: SymbolDef = {
  id: "firm:smoke_detector",
  label: "Smoke detector",
  primitives: [
    { kind: "circle", center: [0, 0], radius: 150 },
    { kind: "line", from: [-100, -100], to: [100, 100] },
    { kind: "line", from: [-100, 100], to: [100, -100] },
  ],
  connectionPoint: [0, 0],
};

describe("r5g symbol registry", () => {
  it("every electrical one-line symbol is a row of the Electrical pack (round 6: the kernel's own registry is empty), and drafts as the same symbol object (byte-identical prints)", () => {
    expect(BUILTIN_SYMBOL_REGISTRY.rows).toEqual([]);
    expect(activeSymbolRegistry().rows.map((r) => r.id)).toEqual(ELECTRICAL_COMPONENTS.map((c) => c.id));
    for (const c of ELECTRICAL_COMPONENTS) {
      expect(detailComponent(c.id)).toBe(c);
      const row = symbolById(c.id);
      expect(row?.primitives.length).toBe(c.prims.length);
      expect(row?.connectionPoint).toHaveLength(2);
    }
    expect(detailComponent("gate_valve")?.id).toBe("gate_valve");
  });

  it("is an immutable value: adding rows makes a new registry and refuses bad or repeated ids", () => {
    const more = withSymbolRows(activeSymbolRegistry(), [SMOKE]);
    expect(more).not.toBe(activeSymbolRegistry());
    expect(symbolById("firm:smoke_detector")).toBeNull();
    expect(symbolById("firm:smoke_detector", more)?.label).toBe("Smoke detector");
    expect(() => createSymbolRegistry([SMOKE, SMOKE])).toThrow(/defined twice/);
    expect(() => createSymbolRegistry([{ ...SMOKE, id: "Smoke Detector" }])).toThrow(/not a symbol id/);
  });

  it("a symbol added as a row drafts in a detail view (old code: no detail component)", () => {
    const symbols = withSymbolRows(activeSymbolRegistry(), [SMOKE]);
    let m = run(empty(), { type: "create_view", viewId: "det", name: "Detail", viewType: "detail", props: { scale: 8 }, crop: { min: { x: -3000, y: -3000 }, max: { x: 3000, y: 3000 } } });
    m = withSymbolRegistry(symbols, () => run(m, { type: "add_drawing_item", itemId: "sd", ownerId: "det", shape: "component", points: [{ x: 0, y: 0 }], component: { symbolId: "firm:smoke_detector" } }));
    const drafted = withSymbolRegistry(symbols, () => lines(buildViewScene(m, "det").scene.primitives));
    expect(drafted.length).toBeGreaterThanOrEqual(10);
    const form = draftingFormOf(SMOKE);
    expect(form).toMatchObject({ widthMm: 300, heightMm: 300, terminals: { line: [0.5, 0.5] } });
  });

  it("a class that names the row draws it in plans in place of its type's lines; other classes are unchanged", () => {
    const receptacle = builtinPartType("builtin:gfci-receptacle@1");
    if (!receptacle) throw new Error("starter receptacle missing");
    let m = run(empty(), { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    m = run(m, { type: "place_part", partId: "sd1", typeId: "t-sd", partType: { ...receptacle.definition, familyName: "Smoke detector", typeName: "Photoelectric" }, levelId: "lvl-1", position: { x: 0, y: 0 } });
    m = run(m, { type: "create_view", viewId: "v", name: "Level 1 Fire alarm", viewType: "floor_plan", crop: { min: { x: -3000, y: -3000 }, max: { x: 3000, y: 3000 } }, props: { level: "Level 1", scale: 48 } });
    const before = JSON.stringify(buildViewScene(m, "v").scene.primitives);
    const classes = builtinRegistry()
      .extend()
      .addClass({ id: "firm.smoke_detector", label: "Smoke detector", discipline: "fire_protection", parent: "mep.electrical_device", symbolId: "firm:smoke_detector", recognize: { partCategories: ["electrical_device"], where: [{ path: "family", op: "contains", value: "Smoke" }] }, source: "library:sd@1" })
      .build();
    const categories = buildCategoryRegistry({ classes });
    const symbols = withSymbolRows(activeSymbolRegistry(), [SMOKE]);
    const drawn = withCategoryRegistry(categories, () => withSymbolRegistry(symbols, () => JSON.stringify(buildViewScene(m, "v").scene.primitives)));
    expect(drawn).not.toBe(before);
    // The class names a row this host doesn't have: the type's own lines, unchanged.
    expect(withCategoryRegistry(categories, () => JSON.stringify(buildViewScene(m, "v").scene.primitives))).toBe(before);
  });

  it("refuses an async draw, so a registry never outlives its synchronous window", () => {
    expect(() => withSymbolRegistry(BUILTIN_SYMBOL_REGISTRY, async () => 1)).toThrow(/synchronous/);
  });
});
