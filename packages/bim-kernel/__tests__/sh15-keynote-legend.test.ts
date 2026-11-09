/**
 * @jest-environment node
 *
 * Round 15 (lane SH15): keynotes, one concept for every trade. An element
 * carries its keynote as its own value, a `keynote` tag prints the key, and a
 * sheet's keynote list (a field block table) lists only the keys on the views
 * placed on that sheet, worded by the keynote table it was given. Fails on
 * round 14: no keynote list kind, and a tag field read no element value.
 */
import { buildSheetSceneFor, commandSchema, executeCommand, sheetKeynoteKeys, tagLines, type ModelState, type Sheet } from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

function run(model: ModelState, command: Record<string, unknown> & { type: string }): ModelState {
  const r = executeCommand(model, commandSchema.parse(command));
  if (!r.ok) throw new Error(r.error.message);
  return { ...r.model, revision: (model.revision + 1) as ModelState["revision"] };
}

const table = {
  id: "zz:keynote_table:general",
  revision: 1,
  name: "General keynotes",
  keynotes: [
    { key: "3", text: "Provide fire damper at rated wall.", group: "Ductwork" },
    { key: "7", text: "Seal penetration.", group: "Ductwork" },
    { key: "10", text: "Route condensate to nearest drain." },
  ],
};

function sheetOf(m: ModelState): Sheet {
  const s = m.elements["s1"];
  if (s?.kind !== "sheet") throw new Error("no sheet");
  return s;
}

/** The demo's ducts: two inside the plan's crop get keys 3 and 10; one outside gets 7. */
function model(): ModelState {
  let m = createDemoModel();
  const ducts = Object.values(m.elements).filter((e) => e.kind === "duct_segment");
  expect(ducts.length).toBeGreaterThanOrEqual(3);
  m = run(m, { type: "create_sheet", sheetId: "s1", number: "M-101", name: "Plan" });
  m = run(m, { type: "create_view", viewId: "v1", name: "L1", viewType: "floor_plan", props: { level: "L1" } });
  m = run(m, { type: "place_viewport", viewportId: "vp1", sheetId: "s1", viewId: "v1", center: { x: 300, y: 300 } });
  const [a, b, c] = ducts;
  m = { ...m, elements: { ...m.elements, [a!.id]: { ...a!, values: { keynote: "10" } }, [b!.id]: { ...b!, values: { keynote: "3" } }, [c!.id]: { ...c!, values: { keynote: "3" } } } as ModelState["elements"] };
  return m;
}

describe("sh15-keynote-legend", () => {
  it("lists each key on the sheet once, in natural order, with its words and group", () => {
    let m = model();
    expect(sheetKeynoteKeys(m, sheetOf(m))).toEqual(["3", "10"]);
    m = run(m, { type: "add_field_block", itemId: "kn1", sheetId: "s1", at: { x: 700, y: 40 }, block: { template: "Keynotes", title: "KEYNOTES", table: { kind: "keynotes", sheetId: "s1", table } } });
    const scene = buildSheetSceneFor(m, "s1", { projectName: "Test" });
    const words = (scene.textBlocks ?? []).flatMap((b) => b.layout.lines.map((l) => l.pieces.map((p) => p.text).join("")));
    const text = words.join("\n");
    expect(text).toContain("DUCTWORK");
    expect(text).toContain("3  Provide fire damper at rated wall.");
    expect(text).toContain("10  Route condensate to nearest drain.");
    // 7 is in the table but on no element here: the list shows only keys used on this sheet.
    expect(text).not.toContain("Seal penetration");
  });

  it("a key the table lacks is named, not dropped; a sheet with no plan lists nothing", () => {
    let m = model();
    const duct = Object.values(m.elements).find((e) => e.kind === "duct_segment");
    m = { ...m, elements: { ...m.elements, [duct!.id]: { ...duct!, values: { keynote: "99" } } } as ModelState["elements"] };
    m = run(m, { type: "add_field_block", itemId: "kn1", sheetId: "s1", at: { x: 700, y: 40 }, block: { template: "Keynotes", table: { kind: "keynotes", sheetId: "s1", table } } });
    const text = (buildSheetSceneFor(m, "s1", { projectName: "Test" }).textBlocks ?? []).flatMap((b) => b.layout.lines.map((l) => l.pieces.map((p) => p.text).join(""))).join("\n");
    expect(text).toContain("99  (not in General keynotes)");
    const bare = run(m, { type: "create_sheet", sheetId: "s2", number: "M-001", name: "Notes" });
    const s2 = bare.elements["s2"];
    expect(s2?.kind === "sheet" ? sheetKeynoteKeys(bare, s2) : null).toEqual([]);
  });

  it("a keynote tag prints the element's key", () => {
    const m = model();
    const keyed = Object.values(m.elements).find((e) => e.kind === "duct_segment" && "values" in e && (e.values as Record<string, unknown> | undefined)?.keynote === "10");
    expect(tagLines(m, { elementId: keyed!.id, template: "fields", fields: ["keynote"], leader: true })).toEqual(["10"]);
  });
});
