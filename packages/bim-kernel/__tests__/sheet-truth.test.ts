import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BUILTIN_PART_TYPES, builtinFormTemplate, buildSheetSceneFor, buildViewScene, evaluateDiagram, evaluateFormSchedule, evaluateSchedule, formTable, scheduleHeadingsCut, scheduleTable, sceneToSvg, type Primitive, type ScheduleDefinition, type ViewElement } from "../src";
import { CONNECTED_LOAD_ONLY, ElectricalLoadEngine, type FeederTypeEntry } from "@permitzip/bim-pack-electrical";
import { Building, referenceDistribution } from "./fixtures/electrical-building";

/**
 * Nothing false on a printed sheet: every value the title block prints is the
 * project's own data, never the model id or the product name.
 */

const GOLDEN = path.join(__dirname, "golden");

function golden(name: string, actual: string): void {
  const file = path.join(GOLDEN, name);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, actual);
  }
  expect(actual).toBe(readFileSync(file, "utf8"));
}

const texts = (prims: readonly Primitive[]) => prims.flatMap((p) => (p.kind === "text" ? [p.text] : []));

/** The text printed right under a title-block label. */
function valueUnder(prims: readonly Primitive[], label: string): string | null {
  const all = prims.filter((p): p is Extract<Primitive, { kind: "text" }> => p.kind === "text");
  const at = all.find((p) => p.text === label);
  if (!at) return null;
  const below = all.filter((p) => Math.abs(p.at.x - at.at.x) < 0.01 && p.at.y > at.at.y && p.at.y - at.at.y < 6).sort((a, b) => a.at.y - b.at.y);
  return below[0]?.text ?? null;
}

function sheetBuilding(fields: Record<string, string> = {}): Building {
  const b = new Building();
  b.ok({ type: "create_sheet", sheetId: "s-m101", number: "M-101", name: "Mechanical plan", fields });
  return b;
}

describe("title block (#1)", () => {
  it("prints the project's name and number and the firm, not the model id or the product", () => {
    const b = sheetBuilding({ drawn_by: "KG" });
    const scene = buildSheetSceneFor(b.head, "s-m101", { projectName: "Hilltop Bistro", projectNumber: "7334", firmName: "PermitZIP" });
    const words = texts(scene.primitives);
    expect(words).toContain("PERMITZIP");
    expect(words).not.toContain("MUTINYBIM");
    expect(valueUnder(scene.primitives, "PROJECT")).toBe("HILLTOP BISTRO");
    expect(valueUnder(scene.primitives, "PROJECT NO.")).toBe("7334");
    expect(valueUnder(scene.primitives, "DRAWN BY")).toBe("KG");
    golden("title-block-project.svg", sceneToSvg(scene));
  });

  it("the sheet's own fields win over the project's, and are not repeated as extra rows", () => {
    const b = sheetBuilding({ project_name: "Site 7352 mirror", project_number: "7352", firm_name: "Archingen, PLC" });
    const scene = buildSheetSceneFor(b.head, "s-m101", { projectName: "site-7352", projectNumber: "0000", firmName: "PermitZIP" });
    const words = texts(scene.primitives);
    expect(valueUnder(scene.primitives, "PROJECT")).toBe("SITE 7352 MIRROR");
    expect(valueUnder(scene.primitives, "PROJECT NO.")).toBe("7352");
    expect(words).toContain("ARCHINGEN, PLC");
    expect(words).not.toContain("SITE-7352");
    expect(words.filter((w) => w === "7352")).toHaveLength(1);
    expect(words).not.toContain("PROJECT NUMBER");
  });

  it("prints a blank, never a stand-in, when nothing names the project", () => {
    const b = sheetBuilding();
    const scene = buildSheetSceneFor(b.head, "s-m101", { projectName: "" });
    const words = texts(scene.primitives);
    expect(words).not.toContain("MUTINYBIM");
    expect(valueUnder(scene.primitives, "PROJECT")).toBeNull();
  });

  it("shrinks a long project name to the block's width instead of running off it", () => {
    const b = sheetBuilding();
    const name = "Hilltop Bistro restaurant fit-out and rooftop mechanical replacement, phase 2";
    const scene = buildSheetSceneFor(b.head, "s-m101", { projectName: name });
    const t = scene.primitives.find((p): p is Extract<Primitive, { kind: "text" }> => p.kind === "text" && p.text === name.toUpperCase());
    if (!t) throw new Error("project name not printed");
    // Title block: 100 mm wide on a 36 x 24 sheet, text starts 3 mm in.
    expect(t.text.length * t.size * 0.62).toBeLessThanOrEqual(94 + 1e-6);
  });
});

/** Built-in parts placed the way the ribbon places them. */
function placeBuiltin(b: Building, id: string, libId: string, values: Record<string, string | number> = {}, x = 0): void {
  const entry = BUILTIN_PART_TYPES.find((e) => e.id === libId);
  if (!entry) throw new Error(`no ${libId}`);
  const typeId = `type-${libId}`;
  b.ok({ type: "place_part", partId: id, typeId, ...(b.head.elements[typeId] ? {} : { partType: entry.definition }), levelId: "lvl-1", position: { x, y: 0 }, mark: id.toUpperCase(), values });
}

const MECH: ScheduleDefinition = { category: "mechanical_equipment", title: "Mechanical equipment schedule", columns: [{ field: "mark" }, { field: "type" }, { field: "cfm" }] };

describe("equipment schedule CFM (#12)", () => {
  it("a part's CFM is its supply connectors' design flow", () => {
    const b = sheetBuilding();
    placeBuiltin(b, "rtu-1", "builtin:rtu-5-ton@2");
    const s = evaluateSchedule(b.head, MECH);
    expect(s.headings).toEqual(["MARK", "TYPE", "CFM"]);
    expect(s.rows).toEqual([["RTU-1", expect.any(String), "2000"]]);
  });

  it("the column follows the type value, and prints on a sheet", () => {
    const b = sheetBuilding();
    placeBuiltin(b, "rtu-1", "builtin:rtu-5-ton@2");
    b.ok({ type: "set_parameters", id: "rtu-1", scope: "type", values: { supply_cfm: 1600 } });
    expect(evaluateSchedule(b.head, MECH).rows[0]?.[2]).toBe("1600");
    b.ok({ type: "create_view", viewId: "v-mech", name: "Mechanical equipment schedule", viewType: "schedule", props: { schedule: MECH } });
    b.ok({ type: "place_viewport", viewportId: "vp-mech", sheetId: "s-m101", viewId: "v-mech", center: { x: 200, y: 150 } });
    golden("schedule-rtu-cfm.svg", sceneToSvg(buildViewScene(b.head, "v-mech").scene));
  });
});

describe("empty schedules (#10)", () => {
  it("a list schedule with nothing to list prints NONE under its headings", () => {
    const b = sheetBuilding();
    const table = scheduleTable(b.head, MECH);
    expect(table.evaluated.rows).toEqual([]);
    expect(table.placeholder).toBe("NONE");
    b.ok({ type: "create_view", viewId: "v-mech", name: "Mechanical equipment schedule", viewType: "schedule", props: { schedule: MECH } });
    const svg = sceneToSvg(buildViewScene(b.head, "v-mech").scene);
    expect(svg).toContain(">NONE<");
    golden("schedule-empty-none.svg", svg);
  });

  it("the placeholder is configurable, and empty text prints headings only", () => {
    const b = sheetBuilding();
    expect(scheduleTable(b.head, { ...MECH, emptyText: "No equipment in this phase" }).placeholder).toBe("NO EQUIPMENT IN THIS PHASE");
    expect(scheduleTable(b.head, { ...MECH, emptyText: "" }).placeholder).toBeNull();
    placeBuiltin(b, "rtu-1", "builtin:rtu-5-ton@2");
    expect(scheduleTable(b.head, MECH).placeholder).toBeNull();
  });

  it("a feeder schedule with no feeders prints NONE; a panel schedule keeps its slots", () => {
    const b = sheetBuilding();
    const ft = formTable(b.head, { kind: "feeder", template: builtinFormTemplate("feeder") });
    expect(ft.form.grid.rows).toEqual([]);
    expect(ft.placeholder).toBe("NONE");
    expect(formTable(b.head, { kind: "feeder", template: builtinFormTemplate("feeder"), emptyText: "" }).placeholder).toBeNull();
  });
});

describe("schedule headings (#9)", () => {
  it("a heading wider than its fixed column wraps to two lines instead of cutting off", () => {
    const b = sheetBuilding();
    placeBuiltin(b, "rtu-1", "builtin:rtu-5-ton@2");
    const def: ScheduleDefinition = { ...MECH, title: "EQ", columns: [{ field: "mark", widthMm: 18 }, { field: "cfm", heading: "SUPPLY AIR CFM", widthMm: 21 }] };
    const table = scheduleTable(b.head, def);
    expect(table.headingLines[1]).toHaveLength(2);
    expect(table.headingLines[1]?.join(" ")).toBe("SUPPLY AIR CFM");
    expect(table.headingHeight).toBeGreaterThan(table.rowHeight);
    expect(scheduleHeadingsCut(b.head, def)).toEqual([]);
  });

  it("says when a heading still can't fit", () => {
    const b = sheetBuilding();
    const def: ScheduleDefinition = { ...MECH, title: "EQ", columns: [{ field: "mark", heading: "EQUIPMENTDESIGNATION", widthMm: 12 }, { field: "type", widthMm: 20 }] };
    const cut = scheduleHeadingsCut(b.head, def);
    expect(cut).toHaveLength(1);
    expect(cut[0]).toMatch(/^"EQUIPMENTDESIGNATION" needs a column about [\d.]+ in wide \(it is 0\.47 in\), so it prints cut off$/);
  });
});

const F225: FeederTypeEntry = {
  type: "feeder_type",
  mark: "F225",
  ratingA: 225,
  poles: 3,
  conductors: { sets: 1, phaseSize: "4/0", neutralSize: "4/0", groundSize: "4", material: "cu" },
  insulation: "THHN",
  conduit: { type: "emt", tradeSize: "2-1/2" },
  conduitBelowGrade: { type: "pvc40", tradeSize: "3" },
  description: "",
};

describe("feeder schedule reads the feeder-type catalog (e)", () => {
  it("lists F225 with the catalog's conductors and conduit", () => {
    const b = referenceDistribution();
    b.ok({ type: "save_catalog_entry", entry: F225 });
    const form = evaluateFormSchedule(b.head, { kind: "feeder", template: builtinFormTemplate("feeder") });
    const f225 = form.grid.rows.find((r) => r[0] === "F225");
    expect(f225).toBeDefined();
    expect(f225?.join(" | ")).toContain("2-1/2 in EMT");
    expect(f225?.join(" | ")).toContain("3 in PVC Sch 40");
    // F100T is used on a feeder but not in the catalog: still listed, from the feeder.
    expect(form.grid.rows.some((r) => r[0] === "F100T")).toBe(true);
  });
});

describe("typed Fed from against the feeder link (#29)", () => {
  function linkedWithText(text: string): Building {
    const b = referenceDistribution();
    b.ok({ type: "set_parameters", id: "h1", scope: "instance", values: { fed_from: text } });
    b.ok({ type: "create_view", viewId: "v-one-line", name: "One-line diagram", viewType: "detail", props: { diagram: { kind: "one_line" } } });
    return b;
  }
  const view = (b: Building): ViewElement => {
    const v = b.head.elements["v-one-line"];
    if (v?.kind !== "view") throw new Error("no view");
    return v;
  };

  it("warns on the one-line and in the panel's findings when the text names other equipment", () => {
    const b = linkedWithText("MSB");
    const ev = evaluateDiagram(b.head.elements, view(b));
    const w = ev?.warnings.find((x) => x.kind === "fed_from_text_mismatch");
    expect(w?.elementId).toBe("h1");
    expect(w?.message).toBe('H1\'s typed Fed from says "MSB", but its feeder comes from MDP. Schedules and this diagram show MDP; clear the typed text or re-feed H1.');
    const finding = new ElectricalLoadEngine(CONNECTED_LOAD_ONLY).report(b.head, "h1")?.findings.find((f) => f.kind === "fed_from_text_mismatch");
    expect(finding?.elementIds).toEqual(["h1", "mdp"]);
  });

  it("stays quiet when the text names the feeder's source", () => {
    for (const ok of ["MDP", "mdp via 225A/3P", "MDP-1,3,5"]) {
      const b = linkedWithText(ok);
      expect(evaluateDiagram(b.head.elements, view(b))?.warnings.some((x) => x.kind === "fed_from_text_mismatch")).toBe(false);
    }
  });
});
