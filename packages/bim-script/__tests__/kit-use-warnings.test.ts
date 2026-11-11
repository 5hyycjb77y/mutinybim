/**
 * @jest-environment node
 *
 * Mistakes that only failed in a run, said by reading the source instead: a
 * kit function that doesn't exist and a ctx.edit command that doesn't exist,
 * each with its line and the closest real names. Nothing the kit ships is
 * flagged (every reference example, recipe and showcase script is clean), and
 * a script's own variable named like a kit namespace is left alone. Fails on
 * the kit before: there was no such check, so these cost a preview each.
 */
import { KIT_ENTRIES, KIT_EXAMPLES, KIT_RECIPES, kitUseWarnings, starterScriptItems } from "../src";

const script = (imports: string, body: string) => [`import { ${imports} } from "@permitzip/bim-script";`, 'export default defineScript({ kind: "layout", reads: { levels: true }, parameters: {}, run(ctx) {', body, "} });", ""].join("\n");

describe("kit-use-warnings", () => {
  it("names a kit function that doesn't exist, its line and the closest real ones", () => {
    const found = kitUseWarnings(script("defineScript, units, building", '  building.rooms(ctx, { level: "L1" });\n  const h = units.feet(9);'));
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ line: 3, rule: "kit" });
    expect(found[0]?.message).toContain("building has no rooms");
    expect(found[0]?.message).toContain("Near: building.room");
    expect(found[1]).toMatchObject({ line: 4, rule: "kit" });
    expect(found[1]?.message).toContain("units has no feet");
  });

  it("names a ctx.edit command that doesn't exist, also when the object starts on the next line", () => {
    const found = kitUseWarnings(script("defineScript", '  ctx.edit({ type: "create_levels", name: "Level 2" });\n  ctx.edit({\n    type: "invent_wall",\n  });'));
    expect(found.map((w) => w.line)).toEqual([3, 4]);
    expect(found[0]?.message).toContain('"create_levels"');
    expect(found[0]?.message).toContain("Near: create_level");
    expect(found[1]?.message).toContain('"invent_wall"');
  });

  it("says each mistake once, and nothing about real functions and commands", () => {
    const found = kitUseWarnings(script("defineScript, units, building", '  building.rooms(ctx, {});\n  building.rooms(ctx, {});\n  building.level(ctx, { name: "Level 2", elevation: units.ft(12) });\n  ctx.edit({ type: "create_level", levelId: "L2", name: "Level 2", elevationMm: 3600 });'));
    expect(found).toHaveLength(1);
  });

  it("leaves a script's own variable alone, and a namespace it didn't import, and comments", () => {
    expect(kitUseWarnings(script("defineScript, parts", '  const parts = ctx.model.ofKind("part");\n  const names = parts.map((p) => p.id);\n  parts.sortBy(names);'))).toEqual([]);
    expect(kitUseWarnings(script("defineScript", "  documents.everything(ctx);"))).toEqual([]);
    expect(kitUseWarnings(script("defineScript, building", "  // building.rooms was the old name\n  ctx.model.building.rooms;"))).toEqual([]);
  });

  it("flags nothing the kit ships: every reference example, recipe, showcase and starter script", () => {
    const sources = [...KIT_ENTRIES.map((e) => [e.name, e.example] as const), ...KIT_RECIPES.map((r) => [r.name, r.example] as const), ...KIT_EXAMPLES.map((x) => [x.name, x.source] as const), ...starterScriptItems().map((s) => [s.key, s.source] as const)];
    expect(sources.length).toBeGreaterThan(100);
    for (const [name, source] of sources) expect({ name, warnings: kitUseWarnings(source) }).toEqual({ name, warnings: [] });
  });
});
