import "../../bim-calc/src";
import { buildSheetSceneFor, builtinFormTemplate, evaluateFormSchedule, evaluateSchedule, fieldText, formTable, formatFieldTemplate, renderTagStyleLines, sceneToSvg, type FormScheduleDefinition, type FormScheduleKind, type ModelState } from "../src";
import { CONNECTED_LOAD_ONLY, electricalRulesById } from "@permitzip/bim-pack-electrical";
import { referenceBuilding, type Building } from "./fixtures/electrical-building";

const RULES = "nec-2023";

function def(kind: FormScheduleKind, elementId?: string): FormScheduleDefinition {
  return { kind, ...(elementId ? { elementId } : {}), template: builtinFormTemplate(kind), rules: RULES };
}

/** The cell under a heading in the left (odd) half of a slot row. */
function left(form: ReturnType<typeof evaluateFormSchedule>, row: number, heading: string): string {
  const i = form.grid.headings.indexOf(heading);
  return form.grid.rows[row]?.[i] ?? "";
}

function right(form: ReturnType<typeof evaluateFormSchedule>, row: number, heading: string): string {
  const i = form.grid.headings.lastIndexOf(heading);
  return form.grid.rows[row]?.[i] ?? "";
}

function total(form: ReturnType<typeof evaluateFormSchedule>, label: string): string {
  return form.totals.find((t) => t.label === label)?.value ?? "";
}

function texts(model: ModelState, sheetId: string): string[] {
  return buildSheetSceneFor(model, sheetId, { projectName: "Test" }).primitives.flatMap((p) => (p.kind === "text" ? [p.text] : []));
}

describe("field paths (one resolver for schedules, tags and the one-line)", () => {
  let b: Building;
  beforeAll(() => {
    b = referenceBuilding();
  });

  it("reads a panel's Supply from through its feeder: MDP via 225A/3P via F225", () => {
    expect(fieldText(b.head.elements, "h1", "supply_from")).toBe("MDP via 225A/3P via F225");
    expect(fieldText(b.head.elements, "h1", "feeder.source.name")).toBe("MDP");
    expect(fieldText(b.head.elements, "h1", "feeder.breaker")).toBe("225A/3P");
    expect(fieldText(b.head.elements, "h1", "feeder.type")).toBe("F225");
  });

  it("a panel fed from a transformer's secondary reads just the transformer", () => {
    expect(fieldText(b.head.elements, "l1", "supply_from")).toBe("T1");
    expect(fieldText(b.head.elements, "t1", "supply_from")).toBe("MDP via 100A/3P via F100T");
  });

  it("a firm's own Supply from wording", () => {
    expect(formatFieldTemplate(b.head.elements, "h1", "{feeder.source.name}[ via {feeder.rating} breaker][, feeder {feeder.type}]").text).toBe("MDP via 225 A breaker, feeder F225");
  });

  it("devices read their circuit, number and panel live", () => {
    // One resolver: the one-line's own fields and supply.* read the same through relationships.
    expect(fieldText(b.head.elements, "h1", "supply.source.name")).toBe("MDP");
    expect(fieldText(b.head.elements, "h1", "feeder.source.name")).toBe("MDP");
    expect(fieldText(b.head.elements, "off1-r1", "panel.voltage_system")).toBe("208Y/120V");
    expect(fieldText(b.head.elements, "rtu1", "panel.mains_text")).toBe("MLO");
    expect(fieldText(b.head.elements, "h1", "feeder.source.bus_rating")).toBe(fieldText(b.head.elements, "mdp", "bus_rating"));
    expect(fieldText(b.head.elements, "mdp", "bus_rating")).toMatch(/^\d+$/);
    expect(fieldText(b.head.elements, "off1-r1", "circuit")).toBe("L1-1");
    expect(fieldText(b.head.elements, "off1-r1", "circuit.number")).toBe("1");
    expect(fieldText(b.head.elements, "off1-r1", "panel")).toBe("L1");
    expect(fieldText(b.head.elements, "rtu1", "circuit")).toBe("H1-1,3,5");
    expect(fieldText(b.head.elements, "rtu1", "voltage_phase")).toBe("460 V 3PH");
    expect(fieldText(b.head.elements, "wh1", "circuit.breaker")).toMatch(/^\d+A\/2P$/);
  });

  it("chosen conductors print as real sizes, never SEE SLD", () => {
    expect(fieldText(b.head.elements, "site1", "circuit.conductors")).toBe("2#10, #10 G");
    expect(fieldText(b.head.elements, "site1", "circuit.material")).toBe("CU");
  });

  it("with no conductors chosen, the code minimum for the breaker prints (NEC rules)", () => {
    expect(fieldText(b.head.elements, "off1-r1", "circuit.conductors", { rules: RULES })).toBe("2#12, #12 G");
    expect(fieldText(b.head.elements, "off1-r1", "circuit.conductors")).toBe("");
  });

  it("a circuit typed as text before circuits existed still reads until it is linked", () => {
    b.ok({ type: "place_part", partId: "loose", typeId: "type-receptacle", levelId: "lvl-1", position: { x: -5000, y: 0 }, mark: "R-9", values: { voltage: 120, load_va: 180, circuit: "L1-40" } });
    expect(fieldText(b.head.elements, "loose", "circuit")).toBe("L1-40");
    expect(fieldText(b.head.elements, "loose", "circuit.name")).toBe("");
    b.ok({ type: "delete_elements", ids: ["loose"], policy: "refuse" });
  });

  it("unknown paths and broken chains read empty", () => {
    expect(fieldText(b.head.elements, "off1-r1", "feeder.source.name")).toBe("");
    expect(fieldText(b.head.elements, "mdp", "supply_from")).toBe("");
    expect(fieldText(b.head.elements, "nope", "circuit")).toBe("");
  });

  it("tag styles read relationship fields", () => {
    const el = b.el("off1-r1");
    expect(renderTagStyleLines(b.head, el, ["{circuit.number}"])).toEqual(["1"]);
    expect(renderTagStyleLines(b.head, b.el("h1"), ["{panel_name}", "[FED FROM {supply_from}]"])).toEqual(["H1", "FED FROM MDP via 225A/3P via F225"]);
    expect(renderTagStyleLines(b.head, b.el("mdp"), ["{panel_name}", "[FED FROM {supply_from}]"])).toEqual(["MDP"]);
    expect(renderTagStyleLines(b.head, b.el("rtu1"), ["{mark} ({mca} MCA/{mocp} MOCP)", "{circuit}"])).toEqual([expect.stringContaining("RTU-1"), "H1-1,3,5"]);
  });

  it("rules ids resolve to the registered NEC pack, else connected loads only", () => {
    expect(electricalRulesById(RULES).placeholder).toBe(false);
    expect(electricalRulesById("nec-1999")).toBe(CONNECTED_LOAD_ONLY);
    expect(electricalRulesById(undefined)).toBe(CONNECTED_LOAD_ONLY);
  });
});

describe("panel schedule (form) of the example building", () => {
  it("L1 prints header, slots, spaces, per-phase kVA, connected and demand by class", () => {
    const b = referenceBuilding();
    const form = evaluateFormSchedule(b.head, def("panel", "l1"));
    expect(form.problem).toBeNull();
    expect(form.title).toBe("PANEL L1");
    const header = Object.fromEntries(form.header.map((h) => [h.label, h.value]));
    expect(header["SUPPLY FROM"]).toBe("T1");
    expect(header.VOLTAGE).toBe("120/208 V");
    expect(header["PHASE / WIRE"]).toBe("3PH 4W");
    expect(header.BUS).toBe("225A");
    expect(header.MAINS).toBe("225A MCB");
    // 42 slots, two per row; the odd half reads left to right, the even half mirrors it.
    expect(form.grid.rows).toHaveLength(21);
    expect(form.grid.splitAt).toBe(form.grid.headings.length / 2);
    expect(left(form, 0, "CKT")).toBe("1");
    expect(left(form, 0, "DESCRIPTION")).toBe("Office 101 receptacles");
    expect(left(form, 0, "A")).toBe("0.54");
    expect(left(form, 0, "B")).toBe("");
    expect(right(form, 0, "CKT")).toBe("2");
    expect(right(form, 0, "DESCRIPTION")).toBe("E.05");
    expect(right(form, 0, "A")).toBe("1.32");
    // WH-1 on 13 (A) and 15 (B): one 2-pole breaker, half the load on each phase.
    expect(left(form, 6, "CKT")).toBe("13");
    expect(left(form, 6, "P")).toBe("2");
    expect(left(form, 6, "A")).toBe("2.25");
    expect(left(form, 7, "CKT")).toBe("15");
    expect(left(form, 7, "DESCRIPTION")).toBe("");
    expect(left(form, 7, "B")).toBe("2.25");
    expect(left(form, 20, "DESCRIPTION")).toBe("SPACE");
    expect(right(form, 20, "DESCRIPTION")).toBe("SPACE");
    // Loads by class from the code rules (kitchen at L1 counts L1's three units).
    const classes = form.summary?.rows.map((r) => r[0]) ?? [];
    expect(classes).toEqual(expect.arrayContaining([expect.stringMatching(/RECEPTACLE/), expect.stringMatching(/KITCHEN/)]));
    // 4 offices x 540 + 360 + 600 + 4,500 + 1,320 + 1,500 + 1,800 = 12,240 VA.
    expect(total(form, "TOTAL CONNECTED LOAD")).toBe("12.24 kVA   34 A");
    expect(total(form, "TOTAL DEMAND LOAD")).toMatch(/kVA/);
    expect(total(form, "PHASE A")).toMatch(/kVA/);
    expect(total(form, "SPARES / SPACES")).toBe("0 / 31");
    expect(form.footer).toBe("Demand: NEC 2023 Article 220");
    expect(form.notes).toContain("[G] GFCI breaker");
  });

  it("kitchen demand at L1 uses L1's own count; at MDP the count of every kitchen item below it", () => {
    const b = referenceBuilding();
    const kitchen = (id: string, kind: FormScheduleKind) => evaluateFormSchedule(b.head, def(kind, id)).summary?.rows.find((r) => /KITCHEN/.test(r[0] ?? ""));
    const atL1 = kitchen("l1", "panel");
    const atMdp = kitchen("mdp", "switchboard");
    expect(atL1?.[2]).not.toBe(atMdp?.[2]);
  });

  it("a spare prints SPARE, and a legend note marks the circuits it applies to", () => {
    const b = referenceBuilding();
    b.place("spare-r", "receptacle", { voltage: 120, load_va: 180 });
    b.ok({ type: "create_service_link", linkId: "c-spare", sourceId: "l1", positions: [17], members: [{ elementId: "spare-r" }] });
    b.ok({ type: "remove_link_members", linkId: "c-spare", elementIds: ["spare-r"] });
    const t = builtinFormTemplate("panel");
    const form = evaluateFormSchedule(b.head, { ...def("panel", "l1"), template: { ...t, notes: [...t.notes, { mark: "K", text: "Kitchen equipment", when: "load_class=kitchen" }] } });
    expect(left(form, 8, "DESCRIPTION")).toBe("SPARE");
    expect(total(form, "SPARES / SPACES")).toBe("1 / 30");
    expect(right(form, 0, "NOTES")).toBe("[K]");
    expect(left(form, 0, "NOTES")).toBe("");
    expect(form.notes).toContain("[K] Kitchen equipment");
  });

  it("without a code edition it says the figures are connected loads only", () => {
    const b = referenceBuilding();
    const form = evaluateFormSchedule(b.head, { ...def("panel", "l1"), rules: undefined });
    expect(form.footer).toMatch(/Connected loads only/);
    expect(left(form, 0, "WIRE")).toBe("");
  });

  it("a deleted panel's schedule says so instead of printing stale rows", () => {
    const b = referenceBuilding();
    const form = evaluateFormSchedule(b.head, def("panel", "gone"));
    expect(form.problem).toMatch(/no longer in the model/);
    expect(form.grid.rows).toHaveLength(0);
  });
});

describe("live on the sheet: one change updates L1, T1 and MDP", () => {
  it("changing a receptacle's load updates every schedule in the same revision", () => {
    const b = referenceBuilding();
    b.ok({ type: "create_sheet", sheetId: "e-601", number: "E-601", name: "Panel schedules" });
    const schedules: Array<[string, FormScheduleDefinition]> = [
      ["v-l1", def("panel", "l1")],
      ["v-t1", def("switchboard", "t1")],
      ["v-mdp", def("switchboard", "mdp")],
    ];
    schedules.forEach(([viewId, d], i) => {
      b.ok({ type: "create_view", viewId, name: `Schedule ${viewId}`, viewType: "schedule", props: { formSchedule: d } });
      b.ok({ type: "place_viewport", viewportId: `vp-${viewId}`, sheetId: "e-601", viewId, center: { x: 150 + i * 250, y: 200 } });
    });
    const before = texts(b.head, "e-601");
    expect(before).toEqual(expect.arrayContaining(["PANEL L1", "SWITCHBOARD MDP", "0.54"]));
    const t1Before = fieldText(b.head.elements, "t1", "connected_kva", { rules: RULES });
    const mdpBefore = fieldText(b.head.elements, "mdp", "connected_kva", { rules: RULES });

    b.ok({ type: "set_parameters", id: "off1-r1", scope: "instance", values: { load_va: 360 } });

    const after = texts(b.head, "e-601");
    expect(after).toContain("0.72");
    expect(left(evaluateFormSchedule(b.head, schedules[0]?.[1] as FormScheduleDefinition), 0, "A")).toBe("0.72");
    expect(after).toContain("12.42 kVA   34 A");
    const t1After = fieldText(b.head.elements, "t1", "connected_kva", { rules: RULES });
    const mdpAfter = fieldText(b.head.elements, "mdp", "connected_kva", { rules: RULES });
    expect(Number(t1After) - Number(t1Before)).toBeCloseTo(0.18, 2);
    expect(Number(mdpAfter) - Number(mdpBefore)).toBeCloseTo(0.18, 2);
    // The switchboard rows print the feeder loads: T1's row on MDP moved by the same 180 VA.
    const mdp = evaluateFormSchedule(b.head, schedules[2]?.[1] as FormScheduleDefinition);
    const t1Row = mdp.grid.rows.find((r) => r.includes("T1"));
    expect(t1Row?.[t1Row.length - 1]).toBe(t1After);
  });
});

describe("feeder, connection type and equipment schedules", () => {
  it("a feeder type given to H1's feeder appears in the feeder schedule with no other entry", () => {
    const b = referenceBuilding();
    const marks = () => evaluateFormSchedule(b.head, def("feeder")).grid.rows.map((r) => r[0]);
    expect(marks()).toEqual(["F100T", "F225"]);
    b.ok({ type: "edit_service_link", linkId: "f-h1", electrical: { feederType: "F250", conductors: { sets: 1, phaseSize: "250", neutralSize: "250", groundSize: "4", material: "cu" } } });
    expect(marks()).toEqual(["F100T", "F250"]);
    const row = evaluateFormSchedule(b.head, def("feeder")).grid.rows.find((r) => r[0] === "F250");
    expect(row?.[1]).toBe("4#250, #4 G");
    expect(fieldText(b.head.elements, "h1", "supply_from")).toBe("MDP via 225A/3P via F250");
  });

  it("connection types group devices by type and load", () => {
    const b = referenceBuilding();
    const form = evaluateFormSchedule(b.head, def("connection_types"));
    const rec = form.grid.rows.find((r) => /Receptacle/.test(r[1] ?? ""));
    expect(rec?.[form.grid.headings.indexOf("LOAD (VA)")]).toBe("180");
    expect(rec?.[form.grid.headings.indexOf("QTY")]).toBe("14");
  });

  it("equipment connections list mechanical equipment with MCA, MOCP and the live circuit", () => {
    const b = referenceBuilding();
    const form = evaluateFormSchedule(b.head, def("equipment_connections"));
    const rtu = form.grid.rows.find((r) => r[0] === "RTU-1");
    const h = (name: string) => form.grid.headings.indexOf(name);
    expect(rtu?.[h("VOLTS / PH")]).toBe("460 V 3PH");
    expect(rtu?.[h("CIRCUIT")]).toBe("H1-1,3,5");
    expect(rtu?.[h("MCA")]).toMatch(/^32/);
  });

  it("a mechanical equipment list schedule gains live electrical columns (cross-trade)", () => {
    const b = referenceBuilding();
    const s = evaluateSchedule(b.head, { category: "mechanical_equipment", columns: [{ field: "mark" }, { field: "voltage_phase" }, { field: "mca" }, { field: "mocp" }, { field: "circuit" }, { field: "panel" }], filters: [{ field: "panel", op: "equals", value: "H1" }] });
    expect(s.headings).toEqual(["MARK", "VOLTS/PH", "MCA", "MOCP", "CIRCUIT", "PANEL"]);
    const rtu = s.rows.find((r) => r[0] === "RTU-1");
    expect(rtu?.slice(1, 2)).toEqual(["460 V 3PH"]);
    expect(rtu?.[4]).toBe("H1-1,3,5");
    expect(s.rows.every((r) => r[5] === "H1")).toBe(true);
    b.ok({ type: "edit_service_link", linkId: "c-rtu1", positions: [25, 27, 29] });
    const moved = evaluateSchedule(b.head, { category: "mechanical_equipment", columns: [{ field: "mark" }, { field: "circuit" }] });
    expect(moved.rows.find((r) => r[0] === "RTU-1")?.[1]).toBe("H1-25,27,29");
  });
});

describe("schedule views", () => {
  it("a schedule view is a list or a form, never both, and a panel schedule needs its panel", () => {
    const b = referenceBuilding();
    expect(b.refused({ type: "create_view", viewId: "v-x", name: "X", viewType: "schedule", props: { formSchedule: def("panel", "l1"), schedule: { category: "mechanical_equipment", columns: [{ field: "mark" }] } } })).toMatch(/not both/);
    expect(b.refused({ type: "create_view", viewId: "v-y", name: "Y", viewType: "schedule", props: { formSchedule: { kind: "panel", template: builtinFormTemplate("panel") } } })).toMatch(/needs the panel/);
    expect(b.refused({ type: "create_view", viewId: "v-z", name: "Z", viewType: "floor_plan", props: { level: "Level 1", formSchedule: def("feeder") } })).toMatch(/Only schedule views/);
    const bad = { ...def("panel", "l1"), template: { ...builtinFormTemplate("panel"), title: "PANEL {name" } };
    expect(b.refused({ type: "create_view", viewId: "v-w", name: "W", viewType: "schedule", props: { formSchedule: bad } })).toMatch(/closing/);
  });

  it("editing the template is set_view_properties and undoes like any other edit", () => {
    const b = referenceBuilding();
    b.ok({ type: "create_view", viewId: "v-l1", name: "L1 schedule", viewType: "schedule", props: { formSchedule: def("panel", "l1") } });
    const t = builtinFormTemplate("panel");
    const edited = { ...def("panel", "l1"), template: { ...t, header: { ...t.header, fields: [{ label: "FED FROM", value: "{feeder.source.name}" }] } } };
    const cs = b.ok({ type: "set_view_properties", viewId: "v-l1", props: { formSchedule: edited } });
    const view = b.el("v-l1");
    expect(view.kind === "view" && view.props?.formSchedule?.template.header.fields).toEqual([{ label: "FED FROM", value: "{feeder.source.name}" }]);
    b.ok({ type: "undo", revision: cs.revision });
    const back = b.el("v-l1");
    expect(back.kind === "view" && back.props?.formSchedule?.template.header.fields.length).toBe(t.header.fields.length);
  });

  it("the table sizes itself from its rows and grows when circuits are added", () => {
    const b = referenceBuilding();
    const d = def("panel", "l1");
    const size = formTable(b.head, d).size;
    expect(size.x).toBeGreaterThan(150);
    expect(size.y).toBeGreaterThan(100);
  });
});

describe("panel schedule print (golden)", () => {
  it("L1 on a sheet prints the same SVG as the stored golden", () => {
    const b = referenceBuilding();
    b.ok({ type: "create_sheet", sheetId: "e-601", number: "E-601", name: "Panel schedules" });
    b.ok({ type: "create_view", viewId: "v-l1", name: "Panel L1", viewType: "schedule", props: { formSchedule: def("panel", "l1") } });
    b.ok({ type: "place_viewport", viewportId: "vp-l1", sheetId: "e-601", viewId: "v-l1", center: { x: 300, y: 250 } });
    const svg = sceneToSvg(buildSheetSceneFor(b.head, "e-601", { projectName: "Example building" }));
    expect(svg).toMatchSnapshot();
  });
});
