/**
 * @jest-environment node
 *
 * Golden tests for every rule the data supports today: one fixture where it
 * fires and one near miss where it doesn't. Each fixture is the smallest
 * model that shows the case (LINT-CLASH-ENGINE.md § Proof).
 */
import type { BimElement, ModelState, Sheet, ViewElement, Viewport } from "@permitzip/bim-kernel";
import { FT, IN, linkedBuilding, Model, RETURN, ROOF_ELEVATION, rulesFired, SUPPLY, id, config, engineFor } from "./fixtures";
import { Building, referenceDistribution, TYPES } from "../../bim-kernel/__tests__/fixtures/electrical-building";

const meta = { version: 0, authoredRev: {} };
const docs = { partition: { level: "project", zone: "documents", discipline: "mechanical" as const } };

function view(viewId: string, over: Partial<ViewElement> = {}): ViewElement {
  return { ...meta, ...docs, id: id(viewId), kind: "view", name: viewId, viewType: "floor_plan", cropMin: { x: 0, y: 0 }, cropMax: { x: 60 * FT, y: 40 * FT }, props: { level: "Level 1" }, ...over } as ViewElement;
}

function sheet(sheetId: string, over: Partial<Sheet> = {}): Sheet {
  return { ...meta, ...docs, id: id(sheetId), kind: "sheet", number: "M-101", title: "Mechanical plan", viewIds: [], ...over } as Sheet;
}

function viewport(vpId: string, sheetId: string, viewId: string, center: { x: number; y: number }, size = { x: 300, y: 200 }): Viewport {
  return { ...meta, ...docs, id: id(vpId), kind: "viewport", sheetId: id(sheetId), viewId: id(viewId), center, size, scale: 48 } as Viewport;
}

const fired = (m: ModelState, rule: string, linked = [linkedBuilding()]) => rulesFired(m, linked).get(rule) ?? [];

describe("coordination", () => {
  it("clash-hard: a supply duct through the return at the same height", () => {
    const m = new Model();
    m.duct("sa", SUPPLY, [[10, 10], [50, 10]], 9);
    m.duct("ra", RETURN, [[30, 0], [30, 30]], 9);
    const hits = fired(m.head, "clash-hard", []);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/(Supply|Return) Air 1 .* passes 12 in\. into (Supply|Return) Air 1/);
  });

  it("near miss: the return dropped 2 ft passes under with room to spare (no hard, no soft)", () => {
    const m = new Model();
    m.duct("sa", SUPPLY, [[10, 10], [50, 10]], 9);
    m.duct("ra", RETURN, [[30, 0], [30, 30]], 7);
    expect(fired(m.head, "clash-hard", [])).toEqual([]);
    expect(fired(m.head, "clash-soft", [])).toEqual([]);
  });

  it("clash-soft: half an inch apart is inside the 1 in. clearance, not a hard clash", () => {
    const m = new Model();
    m.duct("sa", SUPPLY, [[10, 10], [50, 10]], 9);
    // Supply bottom at 9 ft - 6 in.; return top half an inch below it.
    m.duct("ra", RETURN, [[30, 0], [30, 30]], 9 - (12 * IN + 0.5 * IN) / FT);
    expect(fired(m.head, "clash-hard", [])).toEqual([]);
    expect(fired(m.head, "clash-soft", [])[0]).toMatch(/is 0\.5 in\. from (Supply|Return) Air 1 .*\(clearance 1 in\.\)/);
  });

  it("clash-self: a run that loops back across itself (bug log #21)", () => {
    const m = new Model();
    m.duct("sa", SUPPLY, [[0, 0], [20, 0], [20, 10], [10, 10], [10, -10]], 9);
    const hits = fired(m.head, "clash-self", []);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/crosses its own system/);
  });

  it("near miss: an L and a U with elbows never clash with themselves", () => {
    const m = new Model();
    m.duct("sa", SUPPLY, [[0, 0], [20, 0], [20, 10], [0, 10]], 9);
    const all = rulesFired(m.head, []);
    expect(all.get("clash-self") ?? []).toEqual([]);
    expect(all.get("clash-hard") ?? []).toEqual([]);
    expect(all.get("clash-soft") ?? []).toEqual([]);
  });

  it("clash-hard against the linked model: a duct through a linked beam names the beam", () => {
    const m = new Model();
    m.duct("sa", SUPPLY, [[10, 20], [50, 20]], -1.5, { shape: "rect", width: 20 * IN, height: 12 * IN }, "lvl-roof");
    const e = engineFor(m.head, [linkedBuilding()]);
    const hits = e.check({ config: config() }).filter((f) => f.rule === "clash-hard");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.linked?.[0]).toMatchObject({ globalId: "2Fq-beam-w12", name: "BEAM W12x26" });
    expect(hits[0]?.message).toMatch(/BEAM W12x26 \(linked\)/);
  });

  it("near miss: the same duct with linked models switched off, and one below the beam", () => {
    const m = new Model();
    m.duct("sa", SUPPLY, [[10, 20], [50, 20]], -1.5, undefined, "lvl-roof");
    expect(rulesFired(m.head, [linkedBuilding()], { include_linked: false }).get("clash-hard") ?? []).toEqual([]);
    const low = new Model();
    low.duct("sa", SUPPLY, [[10, 20], [50, 20]], -4, undefined, "lvl-roof");
    expect(fired(low.head, "clash-hard")).toEqual([]);
  });
});

describe("placement (bug log #27)", () => {
  it("outside-building and floating-equipment: an RTU off the roof edge", () => {
    const m = new Model();
    m.placeRtu("rtu-1", { x: 70 * FT, y: 20 * FT });
    expect(fired(m.head, "outside-building")[0]).toMatch(/RTU-1 is outside the building: \d+(\.\d+)? ft past the edge of ROOF \(linked\)/);
    expect(fired(m.head, "floating-equipment")[0]).toMatch(/no floor, roof or curb under it/);
  });

  it("near miss: the same RTU on the roof", () => {
    const m = new Model();
    m.placeRtu("rtu-1", { x: 40 * FT, y: 20 * FT });
    expect(fired(m.head, "outside-building")).toEqual([]);
    expect(fired(m.head, "floating-equipment")).toEqual([]);
    expect(fired(m.head, "buried-equipment")).toEqual([]);
  });

  it("stays quiet with no building to compare with (no linked model, no slabs or rooms)", () => {
    const m = new Model();
    m.placeRtu("rtu-1", { x: 70 * FT, y: 20 * FT });
    expect(fired(m.head, "outside-building", [])).toEqual([]);
  });

  it("floating-equipment: 2 ft above the roof", () => {
    const m = new Model();
    m.placeRtu("rtu-1", { x: 40 * FT, y: 20 * FT }, 2 * FT);
    expect(fired(m.head, "floating-equipment")[0]).toMatch(/RTU-1 floats 2'-0" above ROOF \(linked\) \(top 24'-6"\)/);
  });

  it("buried-equipment: sunk 6 in. into the roof", () => {
    const m = new Model();
    m.placeRtu("rtu-1", { x: 40 * FT, y: 20 * FT }, -6 * IN);
    expect(fired(m.head, "buried-equipment")[0]).toMatch(/sunk 6 in\. into ROOF \(linked\)/);
  });

  // Site 7352 after bim_trace_rooms (Rev 149): three rough Level 1 rooms, no roof in our model,
  // RTUs on the Roof level. The lint said "RTU-1 floats 13'-7" above room 101 Dining / Bar".
  const room = (roomId: string, number: string, name: string, x0: number, y0: number, x1: number, y1: number) =>
    ({ ...meta, id: id(roomId), kind: "room", number, name, outline: [{ x: x0 * FT, y: y0 * FT }, { x: x1 * FT, y: y0 * FT }, { x: x1 * FT, y: y1 * FT }, { x: x0 * FT, y: y1 * FT }], areaSqM: 1, partition: { level: "Level 1", zone: "Z1", discipline: "architecture" } }) as BimElement;

  it("a Level 1 room is not what a roof-top unit stands on (7352: RTU-1 'floats 13 ft above room 101')", () => {
    const m = new Model(false);
    m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    m.ok({ type: "create_level", levelId: "lvl-roof", name: "Roof", elevationMm: 4140.2 });
    m.put(room("r-101", "101", "Dining / Bar", 0, 0, 60, 40));
    m.placeRtu("rtu-1", { x: 40 * FT, y: 20 * FT });
    expect(fired(m.head, "floating-equipment", [])).toEqual([]);
    expect(fired(m.head, "outside-building", [])).toEqual([]);
  });

  it("near miss: a unit standing in the room's own level still floats when lifted off its floor", () => {
    const m = new Model();
    m.put(room("r-101", "101", "Dining / Bar", 0, 0, 60, 40));
    m.placeRtu("rtu-1", { x: 40 * FT, y: 20 * FT }, 3 * FT, "lvl-1");
    expect(fired(m.head, "floating-equipment", [])[0]).toMatch(/RTU-1 floats 3'-0" above room 101 Dining \/ Bar/);
  });

  it("outside traced rooms only says so: it isn't 'outside the building' (7352: Panel D past room 101)", () => {
    const m = new Model();
    m.put(room("r-101", "101", "Dining / Bar", 0, 0, 60, 40));
    m.placeRtu("rtu-4", { x: -25 * FT, y: 20 * FT }, 0, "lvl-1");
    expect(fired(m.head, "outside-building", [])[0]).toBe("RTU-4 is outside every room on its level: 25 ft past room 101 Dining / Bar");
  });

  it("the architect's grass, parking and sidewalk slabs are the site, not the building", () => {
    const site = linkedBuilding();
    const grass = { globalId: "2Fq-grass", name: 'Floor:Generic - 12" grass:1111500', ifcClass: "IFCSLAB", kind: "slab" as const, storey: "Grade", box: [-200 * FT, -200 * FT, -1 * FT, 300 * FT, 300 * FT, -0.17 * FT] as const, hull: [-200 * FT, -200 * FT, 300 * FT, -200 * FT, 300 * FT, 300 * FT, -200 * FT, 300 * FT] };
    const linked = { ...site, elements: [...site.elements, grass] };
    const m = new Model();
    m.placeRtu("rtu-4", { x: 90 * FT, y: 20 * FT });
    const all = rulesFired(m.head, [linked]);
    expect(all.get("outside-building")?.[0]).toMatch(/RTU-4 is outside the building: 30 ft past the edge of ROOF \(linked\)/);
    expect(all.get("floating-equipment") ?? []).toEqual([]);
  });

  it("our own slabs count as the building too", () => {
    const m = new Model();
    m.put({ ...meta, id: id("slab-roof"), kind: "slab", outline: [{ x: 0, y: 0 }, { x: 60 * FT, y: 0 }, { x: 60 * FT, y: 40 * FT }, { x: 0, y: 40 * FT }], thickness: 300, partition: { level: "ROOF", zone: "Z1", discipline: "architecture" } } as BimElement);
    m.placeRtu("rtu-1", { x: 70 * FT, y: 20 * FT });
    expect(fired(m.head, "outside-building", [])[0]).toMatch(/past the edge of slab/);
  });
});

describe("systems", () => {
  it("system-without-terminals: an RTU's supply that reaches no diffuser (#13); a diffuser on it clears it", () => {
    const m = new Model();
    m.placeRtu("rtu-1", { x: 0, y: 0 }, 12 * FT, "lvl-1");
    m.ok({ type: "route_run", idPrefix: "sa", levelId: "lvl-1", domain: "duct", size: { shape: "rect", width: 14 * IN, height: 10 * IN }, elevationMm: 10 * FT, system: SUPPLY, points: [{ x: 20 * FT, y: 0 }], from: { kind: "part", partId: "rtu-1", connectorId: "supply" } });
    expect(fired(m.head, "system-without-terminals", [])[0]).toMatch(/Supply Air 1 serves RTU-1 but reaches no air terminals/);

    const ok = new Model();
    ok.placeRtu("rtu-1", { x: 0, y: 0 }, 12 * FT, "lvl-1");
    ok.placeDiffuser("sd-1", { x: 20 * FT, y: 0 }, 8 * FT);
    ok.ok({ type: "route_run", idPrefix: "sa", levelId: "lvl-1", domain: "duct", size: { shape: "rect", width: 14 * IN, height: 10 * IN }, elevationMm: 10 * FT, system: SUPPLY, points: [], from: { kind: "part", partId: "rtu-1", connectorId: "supply" }, to: { kind: "part", partId: "sd-1", connectorId: "neck" } });
    expect(fired(ok.head, "system-without-terminals", [])).toEqual([]);
  });

  it("zero-flow-terminal: a diffuser at 0 CFM; near miss at 150 CFM", () => {
    const m = new Model();
    m.placeDiffuser("sd-0", { x: 10 * FT, y: 10 * FT }, 9 * FT, 0);
    m.placeDiffuser("sd-1", { x: 20 * FT, y: 10 * FT }, 9 * FT, 150);
    const hits = fired(m.head, "zero-flow-terminal", []);
    expect(hits).toEqual(["SD-0 has 0 CFM"]);
  });

  it("part-draws-nothing: a part type whose only feature has no size draws nothing in 3D (#20); the built-in RTU draws", () => {
    const m = new Model();
    m.placeRtu("rtu-1", { x: 40 * FT, y: 20 * FT });
    // The kernel refuses a type with no shape or no symbol; one whose only feature has no size gets past it and draws nothing in 3D.
    const def = { ...TYPES.receptacle, familyName: "Empty part", geometry: [{ kind: "box" as const, center: [0, 0, 0] as [number, number, number], size: [0, 0, 0] as [number, number, number] }] };
    m.ok({ type: "place_part", partId: "ghost", typeId: "type-ghost", partType: def, levelId: "lvl-1", position: { x: 10 * FT, y: 10 * FT }, mark: "GHOST-1" });
    const hits = fired(m.head, "part-draws-nothing", []);
    expect(hits).toEqual(["GHOST-1 has a plan symbol but no solid: it draws nothing in 3D, sections or clash checks"]);
  });

  it("unit-sanity: a 150 in. duct (mm read as inches) and a 1 ft crop; near miss: a 24 in. duct", () => {
    const m = new Model();
    m.duct("big", SUPPLY, [[0, 0], [40, 0]], 9, { shape: "rect", width: 150 * IN, height: 12 * IN });
    m.duct("ok", RETURN, [[0, 30], [40, 30]], 9, { shape: "rect", width: 24 * IN, height: 12 * IN });
    m.put(view("v-tiny", { cropMin: { x: 0, y: 0 }, cropMax: { x: 175, y: 175 } }));
    const hits = fired(m.head, "unit-sanity", []);
    expect(hits).toHaveLength(2);
    expect(hits.join("\n")).toMatch(/150 in\. across/);
    expect(hits.join("\n")).toMatch(/v-tiny's crop is 0\.6 x 0\.6 ft/);
  });

  it("open-validation-issue: a run on a level that no longer exists names the issue", () => {
    const m = new Model();
    const ids = m.duct("sa", SUPPLY, [[0, 0], [20, 0]], 9);
    const seg = m.head.elements[ids.find((x) => x.startsWith("sa-s")) as string];
    if (seg?.kind !== "run_segment") throw new Error("no segment");
    m.put({ ...seg, levelId: id("lvl-gone") });
    expect(fired(m.head, "open-validation-issue", [])[0]).toMatch(/Open issue: .*which does not exist/);
  });
});

describe("documents", () => {
  it("level-name-mismatch: Level 1 against a linked model with only '01 - Ground' (#7); 'LEVEL 01' matches", () => {
    const m = new Model();
    m.put(view("v-l1"));
    const odd = linkedBuilding({ storeys: [{ name: "01 - Ground", elevationMm: 100 }, { name: "ROOF", elevationMm: ROOF_ELEVATION }] });
    expect(fired(m.head, "level-name-mismatch", [odd])[0]).toMatch(/level Level 1 matches no level in Architecture \(it has 01 - Ground, ROOF\)/);
    expect(fired(m.head, "level-name-mismatch", [linkedBuilding()])).toEqual([]);
  });

  it("view-shows-nothing: a crop 1,000 ft away from everything; near miss over the building", () => {
    const m = new Model();
    m.duct("sa", SUPPLY, [[10, 10], [50, 10]], 9);
    m.put(view("v-far", { cropMin: { x: 1000 * FT, y: 1000 * FT }, cropMax: { x: 1060 * FT, y: 1040 * FT } }), view("v-near"));
    const hits = fired(m.head, "view-shows-nothing", []);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/View v-far shows nothing/);
  });

  it("empty-schedule-on-sheet: plumbing fixtures schedule on a sheet with none in the model (#10)", () => {
    const m = new Model();
    m.placeRtu("rtu-1", { x: 40 * FT, y: 20 * FT });
    const schedule = (viewId: string, category: "plumbing_fixture" | "mechanical_equipment") => view(viewId, { viewType: "schedule", props: { schedule: { category, columns: [{ field: "mark" }] } } });
    m.put(schedule("v-pf", "plumbing_fixture"), schedule("v-me", "mechanical_equipment"), sheet("s-1"), viewport("vp-pf", "s-1", "v-pf", { x: 200, y: 150 }), viewport("vp-me", "s-1", "v-me", { x: 600, y: 150 }));
    expect(fired(m.head, "empty-schedule-on-sheet", [])).toEqual(["Schedule v-pf is on a sheet with no rows (it prints NONE)"]);
  });

  it("title-field-not-printing: the title block prints the model id as the project (#1); a project name clears it", () => {
    const m = new Model();
    m.put(sheet("s-1", { props: { fields: { project_number: "7334" } } }));
    expect(fired(m.head, "title-field-not-printing", [])[0]).toMatch(/prints the model id site-7334/);
    const e = engineFor(m.head);
    expect(e.check({ config: config({ ruleset: "documents" }), projectName: "Hilltop Bistro" }).filter((f) => f.rule === "title-field-not-printing")).toEqual([]);
  });

  it("viewport-off-sheet: a viewport hanging off the paper, and two overlapping; near miss: two side by side", () => {
    const m = new Model();
    m.put(view("v-a"), view("v-b"), view("v-c"), sheet("s-1"), viewport("vp-a", "s-1", "v-a", { x: 900, y: 300 }), viewport("vp-b", "s-1", "v-b", { x: 200, y: 200 }), viewport("vp-c", "s-1", "v-c", { x: 300, y: 250 }));
    const hits = fired(m.head, "viewport-off-sheet", []);
    expect(hits).toEqual(expect.arrayContaining([expect.stringMatching(/v-a hangs off sheet M-101/), expect.stringMatching(/v-b and v-c overlap/)]));
    const ok = new Model();
    ok.put(view("v-a"), view("v-b"), sheet("s-1"), viewport("vp-a", "s-1", "v-a", { x: 200, y: 200 }), viewport("vp-b", "s-1", "v-b", { x: 550, y: 200 }));
    expect(fired(ok.head, "viewport-off-sheet", [])).toEqual([]);
  });

  it("edited-operator-view: the agent changing a person's {3D - name} view; an ordinary view is fine", () => {
    const m = new Model();
    m.put(view("v-3d", { name: "{3D - avery}", viewType: "three_d", props: {} }), view("v-plan"));
    const e = engineFor(m.head);
    const run = (ids: string[]) => e.run({ box: null, documents: ids, changed: ids }, { config: config(), editedByAgent: true }).filter((f) => f.rule === "edited-operator-view");
    expect(run(["v-3d"]).map((f) => f.message)).toEqual(["The agent changed {3D - avery}, a person's own working view; make a new view instead"]);
    expect(run(["v-plan"])).toEqual([]);
  });
});

describe("electrical", () => {
  function withOneLine(b: Building, hints: Record<string, unknown> = {}): Building {
    b.ok({ type: "create_view", viewId: "v-one-line", name: "Power", viewType: "detail", props: { diagram: { kind: "one_line", hints } } });
    return b;
  }

  it("not-fed and phantom-utility: an unfed panel; the one-line no longer draws a utility above it (#28)", () => {
    const b = withOneLine(new Building());
    b.place("p1", "panel208", { panel_name: "P1" }, "P1");
    const all = rulesFired(b.head, []);
    expect(all.get("not-fed")).toEqual(["P1 is not fed from anything"]);
    // The one-line stopped drawing the phantom utility; the rule stays as the guard should it come back.
    expect(all.get("phantom-utility") ?? []).toEqual([]);
  });

  it("near miss: the fed reference distribution has neither", () => {
    const b = withOneLine(referenceDistribution());
    const all = rulesFired(b.head, []);
    expect(all.get("not-fed") ?? []).toEqual([]);
    expect(all.get("phantom-utility") ?? []).toEqual([]);
  });

  it("fed-from-text-mismatch: H1 typed as fed from LP-2 while the feeder says MDP (#29); MDP, mdp and MDP-1 name the feeder", () => {
    const b = referenceDistribution();
    b.ok({ type: "set_parameters", id: "h1", scope: "instance", values: { fed_from: "LP-2" } });
    expect(rulesFired(b.head, []).get("fed-from-text-mismatch")?.[0]).toMatch(/typed Fed from says LP-2 but it is fed from MDP/);
    for (const typed of ["mdp", "MDP-1"]) {
      const same = referenceDistribution();
      same.ok({ type: "set_parameters", id: "h1", scope: "instance", values: { fed_from: typed } });
      expect(rulesFired(same.head, []).get("fed-from-text-mismatch") ?? []).toEqual([]);
    }
  });

  it("fed-from-text-mismatch: P1 typed as fed from MDP with no feeder link says nothing feeds it (#29); no typed text stays quiet", () => {
    const b = new Building();
    b.place("p1", "panel208", { panel_name: "P1", fed_from: "MDP" }, "P1");
    const all = rulesFired(b.head, []);
    expect(all.get("fed-from-text-mismatch")).toEqual(["P1's typed Fed from says MDP but nothing feeds it"]);
    expect(all.get("not-fed")).toEqual(["P1 is not fed from anything"]);
    const blank = new Building();
    blank.place("p1", "panel208", { panel_name: "P1" }, "P1");
    expect(rulesFired(blank.head, []).get("fed-from-text-mismatch") ?? []).toEqual([]);
  });
});

describe("availability", () => {
  it("names the rules that can't run on this model yet, and why", () => {
    const e = engineFor(new Model().head);
    const off = e.availability(config({ ruleset: "issue" })).filter((r) => !r.available);
    expect(off.map((r) => r.rule).sort()).toEqual(["clearance-intrusion", "level-name-mismatch", "no-host", "stack-base-branch-too-close", "stale-print-before-issue"]);
    for (const r of off) expect(r.reason).toBeTruthy();
  });
});
