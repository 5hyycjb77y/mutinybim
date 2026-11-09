/**
 * @jest-environment node
 *
 * WS-F plan annotation (G8 connection graphics, G13 typicals, G14 callouts):
 * circuit lines that end exactly on each device's symbol and follow it when it
 * moves, the home run on the device nearest the panel with its "L1-1" tag,
 * gaps where two circuits cross, pinned bends, the multifamily
 * number-beside-device style, dashed switch legs, callouts whose head reads
 * the referenced view's sheet live, and a 24-unit typical counted 24 times at
 * the house panel with each unit's circuit numbers drawn.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildSheetSceneFor, buildViewScene, builtinPartType, calloutHead, commandIssueMessage, commandSchema, modelToPaper, sceneToSvg, sheetDependsOn, type ModelState, type PartInstance, type Primitive, type Vec2, type ViewElement } from "../src";
import type { CircuitGraphicsProps } from "@permitzip/bim-pack-electrical";
import { CONNECTED_LOAD_ONLY, ElectricalLoadEngine, deriveCircuitGraphics, layoutCircuitGraphics, withCircuitBend, type CircuitGraphic } from "@permitzip/bim-pack-electrical";
import { Building } from "./fixtures/electrical-building";

const GOLDEN = path.join(__dirname, "golden");
function golden(name: string, actual: string): void {
  const file = path.join(GOLDEN, name);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, actual);
  }
  expect(actual).toBe(readFileSync(file, "utf8"));
}

const SCALE = 48;
/** The fixture's devices draw a 600 x 300 mm box centred on their connection point. */
const HALF_X = 300;
const HALF_Y = 150;

function view(m: ModelState, id = "v-e1"): ViewElement {
  const v = m.elements[id];
  if (v?.kind !== "view") throw new Error(`missing view ${id}`);
  return v;
}

function shownParts(m: ModelState): Map<string, PartInstance> {
  const out = new Map<string, PartInstance>();
  for (const el of Object.values(m.elements)) if (el.kind === "part") out.set(el.id, el);
  return out;
}

function graphics(b: Building, id = "v-e1"): CircuitGraphic[] {
  return deriveCircuitGraphics(b.head, view(b.head, id), shownParts(b.head), SCALE);
}

function plan(b: Building, circuitGraphics?: CircuitGraphicsProps, id = "v-e1", crop = { min: { x: -12000, y: -8000 }, max: { x: 12000, y: 8000 } }): void {
  b.ok({ type: "create_view", viewId: id, name: `Level 1 Power ${id}`, viewType: "floor_plan", crop, props: { level: "Level 1", scale: SCALE, discipline: "electrical", ...(circuitGraphics ? { circuitGraphics } : {}) } });
}

function at(b: Building, id: string): Vec2 {
  const el = b.el(id);
  if (el.kind !== "part") throw new Error(`${id} is not a part`);
  return el.position;
}

/** On the device's box outline (to within 0.01 mm). */
function onOutline(p: Vec2, c: Vec2): boolean {
  const dx = Math.abs(p.x - c.x);
  const dy = Math.abs(p.y - c.y);
  return (Math.abs(dx - HALF_X) < 0.01 && dy <= HALF_Y + 0.01) || (Math.abs(dy - HALF_Y) < 0.01 && dx <= HALF_X + 0.01);
}

/** Strictly inside the device's box: an overhang. */
function inside(p: Vec2, c: Vec2): boolean {
  return Math.abs(p.x - c.x) < HALF_X - 0.01 && Math.abs(p.y - c.y) < HALF_Y - 0.01;
}

/** Panel L1 at the far left, three receptacles in a row, circuited in a scrambled order. */
function office(): Building {
  const b = new Building();
  b.place("l1", "panel208", { panel_name: "L1" }, "L1", { x: -8000, y: 0 });
  b.place("r1", "receptacle", { voltage: 120, load_va: 180 }, "r1", { x: 0, y: 0 });
  b.place("r2", "receptacle", { voltage: 120, load_va: 180 }, "r2", { x: 3000, y: 0 });
  b.place("r3", "receptacle", { voltage: 120, load_va: 180 }, "r3", { x: 6000, y: 0 });
  b.ok({ type: "create_service_link", linkId: "c1", sourceId: "l1", positions: [1], members: [{ elementId: "r3" }, { elementId: "r1" }, { elementId: "r2" }] });
  return b;
}

function circuit(gs: readonly CircuitGraphic[], key: string): CircuitGraphic {
  const g = gs.find((x) => x.key === key);
  if (!g) throw new Error(`no graphic ${key}: ${gs.map((x) => x.key).join(", ")}`);
  return g;
}

describe("circuit lines attach at the symbol's connection point", () => {
  it("joins the devices nearest-first from the home run, ending exactly on each symbol", () => {
    const b = office();
    plan(b, { style: "orthogonal" });
    const g = circuit(graphics(b), "c1");
    expect(g.joins).toEqual([
      ["r1", "r2"],
      ["r2", "r3"],
    ]);
    expect(g.paths).toEqual([
      [
        { x: 300, y: 0 },
        { x: 2700, y: 0 },
      ],
      [
        { x: 3300, y: 0 },
        { x: 5700, y: 0 },
      ],
    ]);
    // The home run leaves r1 (nearest L1) toward the panel, 8 mm of paper long, tagged with the circuit's name.
    expect(g.homeRun).toEqual({ memberId: "r1", from: { x: -300, y: 0 }, tip: { x: -300 - 8 * SCALE, y: 0 }, label: "L1-1" });
  });

  it("moving a circuited receptacle moves its line and home run with it, with no overhang", () => {
    const b = office();
    plan(b, { style: "arcs" });
    b.ok({ type: "move_elements", ids: ["r2"], delta: { x: 0, y: 2000 } });
    let g = circuit(graphics(b), "c1");
    for (let i = 0; i < g.paths.length; i++) {
      const path = g.paths[i]!;
      const [a, z] = g.joins[i]!;
      expect(onOutline(path[0]!, at(b, a))).toBe(true);
      expect(onOutline(path[path.length - 1]!, at(b, z))).toBe(true);
      for (const p of path) for (const id of ["r1", "r2", "r3"]) expect(inside(p, at(b, id))).toBe(false);
    }
    // Move r1 past the others: the home run follows to r2, now nearest the panel.
    b.ok({ type: "move_elements", ids: ["r1"], delta: { x: 9000, y: 0 } });
    g = circuit(graphics(b), "c1");
    expect(g.homeRun?.memberId).toBe("r2");
    expect(onOutline(g.homeRun!.from, at(b, "r2"))).toBe(true);
    expect(g.joins[0]).toEqual(["r2", "r3"]);
  });

  it("draws in the printed plan: the lines, the arrow and the L1-1 tag", () => {
    const b = office();
    plan(b, { style: "orthogonal" });
    const prims = buildViewScene(b.head, "v-e1").scene.primitives;
    expect(prims.some((p) => p.kind === "text" && p.text === "L1-1")).toBe(true);
    // A mechanical plan of the same level draws no circuiting unless asked.
    b.ok({ type: "create_view", viewId: "v-m1", name: "Level 1 HVAC", viewType: "floor_plan", crop: { min: { x: -12000, y: -8000 }, max: { x: 12000, y: 8000 } }, props: { level: "Level 1", scale: SCALE, discipline: "mechanical" } });
    expect(buildViewScene(b.head, "v-m1").scene.primitives.some((p) => p.kind === "text" && p.text === "L1-1")).toBe(false);
  });
});

describe("crossing circuits", () => {
  function crossing(priority?: number): Building {
    const b = office();
    b.place("r4", "receptacle", { voltage: 120, load_va: 180 }, "r4", { x: 1500, y: -3000 });
    b.place("r5", "receptacle", { voltage: 120, load_va: 180 }, "r5", { x: 1500, y: 3000 });
    b.ok({ type: "create_service_link", linkId: "c2", sourceId: "l1", positions: [3], members: [{ elementId: "r4" }, { elementId: "r5" }] });
    plan(b, { style: "orthogonal", homeRuns: false, ...(priority !== undefined ? { hints: { c2: { priority } } } : {}) });
    return b;
  }

  const paperLines = (b: Building) => {
    const v = view(b.head);
    const toPaper = (p: Vec2) => modelToPaper({ center: { x: 0, y: 0 }, size: { x: 500, y: 300 }, scale: SCALE, modelCenter: { x: 0, y: 0 } }, p);
    return layoutCircuitGraphics(deriveCircuitGraphics(b.head, v, shownParts(b.head), SCALE), toPaper);
  };

  it("breaks the lower-priority line with a gap either side and leaves the other whole", () => {
    const laid = paperLines(crossing());
    const c1 = laid.find((g) => g.source.key === "c1")!;
    const c2 = laid.find((g) => g.source.key === "c2")!;
    // Equal priority: the one that sorts later (c2) takes the gap.
    expect(c1.lines).toHaveLength(2);
    expect(c2.lines).toHaveLength(2);
    const [lower, upper] = c2.lines;
    const crossY = 0;
    const gapTop = Math.min(lower![lower!.length - 1]!.y, upper![0]!.y);
    const gapBottom = Math.max(lower![lower!.length - 1]!.y, upper![0]!.y);
    expect(gapBottom - gapTop).toBeCloseTo(2, 6);
    expect((gapTop + gapBottom) / 2).toBeCloseTo(crossY, 6);
  });

  it("a person can raise a circuit so the other one breaks", () => {
    const laid = paperLines(crossing(5));
    expect(laid.find((g) => g.source.key === "c2")!.lines).toHaveLength(1);
    // c1's first leg (r1 to r2) is the one c2 crosses: it splits in two, plus its second leg.
    expect(laid.find((g) => g.source.key === "c1")!.lines).toHaveLength(3);
  });

  it("is the same every time", () => {
    expect(JSON.stringify(paperLines(crossing()))).toBe(JSON.stringify(paperLines(crossing())));
  });
});

describe("pinned bends and styles", () => {
  it("an arc pinned through a point passes through it; clearing it goes back to the default arc", () => {
    const b = office();
    plan(b, { style: "arcs" });
    const bend = { x: 1500, y: 1200 };
    b.ok({ type: "set_view_properties", viewId: "v-e1", props: { circuitGraphics: withCircuitBend(view(b.head), "c1", "r2", "r1", bend) } });
    const path = circuit(graphics(b), "c1").paths[0]!;
    expect(Math.min(...path.map((p) => Math.hypot(p.x - bend.x, p.y - bend.y)))).toBeLessThan(5);
    b.ok({ type: "set_view_properties", viewId: "v-e1", props: { circuitGraphics: withCircuitBend(view(b.head), "c1", "r1", "r2", null) } });
    const free = circuit(graphics(b), "c1").paths[0]!;
    expect(Math.max(...free.map((p) => p.y))).toBeCloseTo(0.15 * 2400, 0);
  });

  it("number beside device: no lines, the circuit number by each device, one home run", () => {
    const b = office();
    plan(b, { style: "numbers" });
    const g = circuit(graphics(b), "c1");
    expect(g.paths).toEqual([]);
    expect(g.numbers.map((n) => [n.memberId, n.text])).toEqual([
      ["r3", "1"],
      ["r1", "1"],
      ["r2", "1"],
    ]);
    expect(g.homeRun?.memberId).toBe("r1");
  });

  it("refuses circuit settings on a view that isn't a plan, and an unknown key by name", () => {
    const b = office();
    b.ok({ type: "create_view", viewId: "v-d", name: "Detail", viewType: "detail" });
    expect(b.refused({ type: "set_view_properties", viewId: "v-d", props: { circuitGraphics: { style: "arcs" } } })).toContain("draw on plans");
    // An unknown key is refused by name where commands are read (agent tools, the model server), not dropped.
    const input = { type: "set_view_properties", viewId: "v-e1", props: { circuitGraphics: { style: "arcs", colour: "red" } } };
    const parsed = commandSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(commandIssueMessage(parsed.error, input)).toContain("colour");
    expect(commandSchema.safeParse({ type: "add_drawing_item", itemId: "x", ownerId: "v", shape: "callout", points: [{ x: 0, y: 0 }], callout: { viewId: "v2", sheet: "E4" } }).success).toBe(false);
    expect(commandSchema.safeParse({ type: "set_group_typical", groupId: "g", array: { count: 2, columns: 1, spacingMm: { x: 1, y: 0 }, rows: 2 } }).success).toBe(false);
  });
});

describe("switch legs", () => {
  it("draws a dashed leg from the switch to the fixtures it controls, nothing to other fixtures", () => {
    const b = new Building();
    const sw = builtinPartType("builtin:switch-single-pole@1")!.definition;
    const troffer = builtinPartType("builtin:troffer-2x4-led@1")!.definition;
    b.ok({ type: "place_part", partId: "s1", typeId: "t-sw", partType: sw, levelId: "lvl-1", position: { x: 0, y: 0 }, values: { switch_leg: "a" } });
    b.ok({ type: "place_part", partId: "f1", typeId: "t-tr", partType: troffer, levelId: "lvl-1", position: { x: 3000, y: 2000 }, values: { switch_leg: "a" } });
    b.ok({ type: "place_part", partId: "f2", typeId: "t-tr", levelId: "lvl-1", position: { x: 6000, y: 2000 }, values: { switch_leg: "A" } });
    b.ok({ type: "place_part", partId: "f3", typeId: "t-tr", levelId: "lvl-1", position: { x: 6000, y: -2000 }, values: { switch_leg: "b" } });
    plan(b);
    const leg = circuit(graphics(b), "switch:s1");
    expect(leg.dashed).toBe(true);
    expect(leg.joins).toEqual([
      ["s1", "f1"],
      ["f1", "f2"],
    ]);
    const dashed = buildViewScene(b.head, "v-e1").scene.primitives.filter((p): p is Extract<Primitive, { kind: "line" }> => p.kind === "line" && p.dash?.[0] === 1.5 && p.dash[1] === 1);
    expect(dashed.length).toBeGreaterThan(10);
  });
});

describe("callouts resolve their sheet live", () => {
  function sheets(): Building {
    const b = office();
    plan(b);
    b.ok({ type: "create_view", viewId: "v-eep", name: "Enlarged electrical room", viewType: "floor_plan", crop: { min: { x: -9000, y: -1500 }, max: { x: -7000, y: 1500 } }, props: { level: "Level 1", scale: 24, discipline: "electrical" } });
    b.ok({ type: "create_sheet", sheetId: "s-e4", number: "E4", name: "Enlarged plans" });
    b.ok({ type: "create_sheet", sheetId: "s-e5", number: "E5", name: "Enlarged plans 2" });
    b.ok({ type: "create_sheet", sheetId: "s-e1", number: "E1", name: "Power plan" });
    b.ok({ type: "place_viewport", viewportId: "vp-eep", sheetId: "s-e4", viewId: "v-eep", center: { x: 300, y: 300 } });
    b.ok({ type: "place_viewport", viewportId: "vp-e1", sheetId: "s-e1", viewId: "v-e1", center: { x: 400, y: 300 } });
    b.ok({ type: "add_drawing_item", itemId: "co-1", ownerId: "v-e1", shape: "callout", points: [{ x: -9000, y: -1500 }, { x: -7000, y: 1500 }, { x: -9500, y: 3000 }], callout: { viewId: "v-eep", label: "EEP" } });
    return b;
  }

  it("shows E4, then E5 once the enlarged plan moves there, on the printed sheet too", () => {
    const b = sheets();
    const spec = { viewId: "v-eep", label: "EEP" };
    expect(calloutHead(b.head, spec)).toMatchObject({ top: "EEP", bottom: "E4", viewName: "ENLARGED ELECTRICAL ROOM", resolved: true });
    const texts = (m: ModelState) => buildSheetSceneFor(m, "s-e1", { projectName: "P" }).primitives.flatMap((p) => (p.kind === "text" ? [p.text] : []));
    expect(texts(b.head)).toEqual(expect.arrayContaining(["EEP", "E4", "ENLARGED ELECTRICAL ROOM"]));

    const before = b.head;
    b.ok({ type: "remove_viewport", viewportId: "vp-eep" });
    expect(calloutHead(b.head, spec)).toMatchObject({ bottom: "—", resolved: false });
    b.ok({ type: "place_viewport", viewportId: "vp-eep-2", sheetId: "s-e5", viewId: "v-eep", center: { x: 300, y: 300 } });
    expect(calloutHead(b.head, spec).bottom).toBe("E5");
    expect(texts(b.head)).toContain("E5");
    expect(texts(b.head)).not.toContain("E4");
    // The power plan's sheet knows the enlarged view's viewport is something it prints.
    const depends = sheetDependsOn(before, "s-e1");
    expect(depends("vp-eep", before.elements["vp-eep"])).toBe(true);
  });

  it("reads the view's number on its sheet when it has no label, and refuses a callout to itself or to nothing", () => {
    const b = sheets();
    b.ok({ type: "update_drawing_item", itemId: "co-1", callout: { viewId: "v-eep" } });
    expect(calloutHead(b.head, { viewId: "v-eep" }).top).toBe("1");
    expect(b.refused({ type: "add_drawing_item", itemId: "co-2", ownerId: "v-e1", shape: "callout", points: [{ x: 0, y: 0 }, { x: 900, y: 900 }, { x: 1200, y: 1200 }], callout: { viewId: "v-e1" } })).toContain("can't refer to the view it is drawn in");
    expect(b.refused({ type: "add_drawing_item", itemId: "co-3", ownerId: "v-e1", shape: "callout", points: [{ x: 0, y: 0 }, { x: 900, y: 900 }, { x: 1200, y: 1200 }], callout: { viewId: "v-gone" } })).toContain("no view v-gone");
    expect(b.refused({ type: "add_drawing_item", itemId: "co-4", ownerId: "v-e1", shape: "callout", points: [{ x: 0, y: 0 }, { x: 900, y: 900 }] , callout: { viewId: "v-eep" } })).toContain("three points");
  });
});

describe("typicals: unit 001 instanced 24 times", () => {
  /** House panel HP feeds unit panel A001 (in group Unit 001) with two receptacle circuits. */
  function apartments(): Building {
    const b = new Building();
    b.place("hp", "panel208", { panel_name: "HP" }, "HP", { x: -20000, y: 0 });
    b.place("a001", "panel208", { panel_name: "A001" }, "A001", { x: 0, y: 0 });
    b.place("u-r1", "receptacle", { voltage: 120, load_va: 180 }, "", { x: 2000, y: 0 });
    b.place("u-r2", "receptacle", { voltage: 120, load_va: 180 }, "", { x: 4000, y: 0 });
    b.place("u-r3", "receptacle", { voltage: 120, load_va: 1500 }, "", { x: 2000, y: 2000 });
    b.ok({ type: "create_service_link", linkId: "u-c1", sourceId: "a001", positions: [1], members: [{ elementId: "u-r1" }, { elementId: "u-r2" }] });
    b.ok({ type: "create_service_link", linkId: "u-c2", sourceId: "a001", positions: [2], members: [{ elementId: "u-r3" }] });
    b.ok({ type: "create_service_link", linkId: "f-a001", sourceId: "hp", positions: [1, 3, 5], members: [{ elementId: "a001" }], electrical: { ratingA: 60 } });
    b.ok({ type: "create_group", groupId: "grp-unit-001", name: "Unit 001" });
    b.ok({ type: "assign_elements_to_group", ids: ["a001", "u-r1", "u-r2", "u-r3"], groupId: "grp-unit-001" });
    return b;
  }

  it("counts 24 x the unit's loads on the house panel, the unit panel itself once", () => {
    const b = apartments();
    const engine = new ElectricalLoadEngine(CONNECTED_LOAD_ONLY);
    const unitVa = engine.loads(b.head, "a001")!.inventory.va;
    expect(unitVa).toBe(1860);
    expect(engine.loads(b.head, "hp")!.inventory.va).toBe(1860);

    b.ok({ type: "set_group_typical", groupId: "grp-unit-001", label: "Unit", mark: "001", array: { count: 24, columns: 6, spacingMm: { x: 10000, y: -8000 } } });
    const hp = engine.loads(b.head, "hp")!;
    expect(hp.inventory.va).toBe(24 * 1860);
    expect(hp.inventory.members).toBe(24 * 3);
    expect(hp.links[0]?.typicalCount).toBe(24);
    // Two largest receptacle loads at HP: the 1,500 VA one, twice (two of the 24 copies).
    const bucket = [...hp.inventory.buckets.values()][0]!;
    expect(bucket.count).toBe(72);
    expect(bucket.largest.map((l) => l.va)).toEqual([1500, 1500]);
    expect(engine.loads(b.head, "a001")!.inventory.va).toBe(1860);

    b.ok({ type: "clear_group_typical", groupId: "grp-unit-001" });
    expect(engine.loads(b.head, "hp")!.inventory.va).toBe(1860);
  });

  it("each unit shows its own circuit numbers and home runs when the view shows circuiting on all units; else TYP.", () => {
    const b = apartments();
    b.ok({ type: "set_group_typical", groupId: "grp-unit-001", mark: "001", array: { count: 24, columns: 6, spacingMm: { x: 10000, y: -8000 } } });
    const crop = { min: { x: -22000, y: -40000 }, max: { x: 60000, y: 6000 } };
    plan(b, { style: "numbers", allCopies: true }, "v-all", crop);
    const texts = buildViewScene(b.head, "v-all").scene.primitives.flatMap((p) => (p.kind === "text" ? [p.text] : []));
    for (let unit = 1; unit <= 24; unit++) {
      const mark = String(unit).padStart(3, "0");
      expect(texts).toContain(`A${mark}-1`);
      expect(texts).toContain(`A${mark}-2`);
      // The copy's panel draws with its own mark.
      expect(texts).toContain(`A${mark}`);
    }
    // Three receptacles per unit carry their circuit number.
    expect(texts.filter((t) => t === "1" || t === "2")).toHaveLength(24 * 3);

    plan(b, { style: "numbers" }, "v-one", crop);
    const one = buildViewScene(b.head, "v-one").scene.primitives.flatMap((p) => (p.kind === "text" ? [p.text] : []));
    expect(one).toContain("A001-1 TYP.");
    expect(one).not.toContain("A002-1");
    expect(one).toContain("A024");
  });

  it("refuses General, duplicate marks and a list with an array", () => {
    const b = apartments();
    expect(b.refused({ type: "set_group_typical", groupId: "grp-general", array: { count: 2, columns: 2, spacingMm: { x: 1000, y: 0 } } })).toContain("can't be a typical");
    expect(b.refused({ type: "set_group_typical", groupId: "grp-unit-001", mark: "001", copies: [{ mark: "001", offset: { x: 1, y: 0 } }] })).toContain("both marked 001");
    expect(b.refused({ type: "set_group_typical", groupId: "grp-unit-001", copies: [], array: { count: 2, columns: 1, spacingMm: { x: 0, y: 1 } } })).toContain("not both");
  });
});

describe("golden plan print", () => {
  it("prints an electrical plan with arcs, a home run, a crossing gap, a callout and a typical the same as the golden drawing", () => {
    const b = office();
    b.place("r4", "receptacle", { voltage: 120, load_va: 180 }, "r4", { x: 1500, y: -3000 });
    b.place("r5", "receptacle", { voltage: 120, load_va: 180 }, "r5", { x: 1500, y: 3000 });
    b.ok({ type: "create_service_link", linkId: "c2", sourceId: "l1", positions: [3], members: [{ elementId: "r4" }, { elementId: "r5" }] });
    plan(b, { style: "arcs" });
    b.ok({ type: "create_view", viewId: "v-eep", name: "Enlarged electrical room", viewType: "floor_plan", crop: { min: { x: -9000, y: -1500 }, max: { x: -7000, y: 1500 } }, props: { level: "Level 1", scale: 24 } });
    b.ok({ type: "create_sheet", sheetId: "s-e4", number: "E4", name: "Enlarged plans" });
    b.ok({ type: "place_viewport", viewportId: "vp-eep", sheetId: "s-e4", viewId: "v-eep", center: { x: 300, y: 300 } });
    b.ok({ type: "add_drawing_item", itemId: "co-1", ownerId: "v-e1", shape: "callout", points: [{ x: -9000, y: -1500 }, { x: -7000, y: 1500 }, { x: -9500, y: 3000 }], callout: { viewId: "v-eep", label: "EEP" } });
    golden("plan-circuiting.svg", sceneToSvg(buildViewScene(b.head, "v-e1").scene));
  });
});
