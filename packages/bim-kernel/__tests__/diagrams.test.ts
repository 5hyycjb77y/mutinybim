import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildSheetSceneFor,
  buildViewScene,
  builtinPartTypes,
  type PartTypeDefinition,
  evaluateDiagram,
  diagramElementAt,
  formatFieldTemplate,
  resolveField,
  sceneToSvg,
  type ViewElement,
} from "../src";
import { Building, distributionType, referenceBuilding } from "./fixtures/electrical-building";

const GOLDEN = path.join(__dirname, "golden");

/** Compare against a checked-in golden file; UPDATE_GOLDEN=1 rewrites it. */
function golden(name: string, actual: string): void {
  const file = path.join(GOLDEN, name);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, actual);
  }
  expect(actual).toBe(readFileSync(file, "utf8"));
}

function view(b: Building, id: string): ViewElement {
  const v = b.head.elements[id];
  if (v?.kind !== "view") throw new Error(`missing view ${id}`);
  return v;
}

/** The reference building with a live one-line on sheet E-601. */
function withOneLine(hints: Record<string, unknown> = {}): Building {
  const b = referenceBuilding();
  b.ok({ type: "create_view", viewId: "v-one-line", name: "One-line diagram", viewType: "detail", props: { diagram: { kind: "one_line", hints } } });
  b.ok({ type: "create_sheet", sheetId: "s-e601", number: "E-601", name: "Electrical one-line diagram" });
  b.ok({ type: "place_viewport", viewportId: "vp-one-line", sheetId: "s-e601", viewId: "v-one-line", center: { x: 300, y: 250 } });
  return b;
}

function texts(b: Building, viewId = "v-one-line"): string[] {
  const ev = evaluateDiagram(b.head.elements, view(b, viewId));
  return (ev?.items ?? []).flatMap((i) => (i.shape === "text" ? (i.note?.paragraphs ?? []).map((p) => p.runs.map((r) => r.text).join("")) : []));
}

describe("field paths", () => {
  it("read live equipment and supply fields", () => {
    const b = referenceBuilding();
    const els = b.head.elements;
    expect(resolveField(els, "h1", "name").text).toBe("H1");
    expect(resolveField(els, "h1", "bus_rating").value).toBe(225);
    expect(resolveField(els, "h1", "mains_text").text).toBe("MLO");
    expect(resolveField(els, "mdp", "mains_text").text).toBe("800A MCB");
    expect(resolveField(els, "h1", "voltage_system").text).toBe("480Y/277V");
    expect(resolveField(els, "l1", "voltage_system").text).toBe("208Y/120V");
    expect(resolveField(els, "h1", "phases_wires").text).toBe("3PH 4W");
    expect(resolveField(els, "t1", "primary_system").text).toBe("480V Δ");
    expect(resolveField(els, "h1", "supply.source.name").text).toBe("MDP");
    expect(resolveField(els, "h1", "supply.breaker").text).toBe("225A/3P");
    expect(resolveField(els, "h1", "supply.feeder_type").text).toBe("F225");
    expect(resolveField(els, "h1", "supply.text").text).toBe("MDP via 225A/3P breaker, F225");
    expect(resolveField(els, "h1", "nonsense.path").value).toBeNull();
  });

  it("fill templates and drop what has no value", () => {
    const els = referenceBuilding().head.elements;
    expect(formatFieldTemplate(els, "h1", "{bus_rating}A BUS {mains_text}").text).toBe("225A BUS MLO");
    expect(formatFieldTemplate(els, "h1", "{enclosure} {kaic}").text).toBe("");
    expect(formatFieldTemplate(els, "h1", "{enclosure|NEMA 1}").text).toBe("NEMA 1");
    expect(formatFieldTemplate(els, "mdp", "FED FROM {supply.text}").missing).toEqual(["supply.text"]);
  });
});

describe("live one-line diagram", () => {
  it("draws the distribution from the model's feeders, not from a description", () => {
    const b = withOneLine();
    const ev = evaluateDiagram(b.head.elements, view(b, "v-one-line"));
    expect(ev?.equipment).toEqual(["mdp", "h1", "t1", "l1"]);
    const words = texts(b);
    for (const w of ["MDP", "800A BUS 800A MCB", "480Y/277V 3PH 4W", "H1", "225A BUS MLO", "T1", "75 KVA", "480V Δ - 208Y/120V", "L1", "225A BUS 225A MCB", "208Y/120V 3PH 4W", "225A/3P", "100A/3P", "F225", "F100T", "UTILITY"]) {
      expect(words).toContain(w);
    }
  });

  it("is the same bytes for the same model", () => {
    const a = withOneLine();
    const b = withOneLine();
    const svgA = sceneToSvg(buildSheetSceneFor(a.head, "s-e601", { projectName: "Example" }));
    const svgB = sceneToSvg(buildSheetSceneFor(b.head, "s-e601", { projectName: "Example" }));
    expect(svgA).toBe(svgB);
    expect(sceneToSvg(buildViewScene(a.head, "v-one-line").scene)).toBe(sceneToSvg(buildViewScene(b.head, "v-one-line").scene));
  });

  it("prints on E-601 the same as the golden drawing", () => {
    const b = withOneLine();
    golden("one-line-example.svg", sceneToSvg(buildViewScene(b.head, "v-one-line").scene));
    golden("one-line-e601.svg", sceneToSvg(buildSheetSceneFor(b.head, "s-e601", { projectName: "Example building" })));
  });

  it("follows a bus change in the same revision: text and the feeding-breaker warning", () => {
    const b = withOneLine();
    expect(texts(b)).not.toContain("! 400A BUS FED BY 225A BREAKER");
    // H1 is the only part of its type in the fixture, so its type's bus is H1's bus.
    const cs = b.ok({ type: "set_parameters", id: "h1", scope: "type", values: { bus_rating: 400 } });
    const words = texts(b);
    expect(words).toContain("400A BUS MLO");
    expect(words).not.toContain("225A BUS MLO");
    expect(words).toContain("! 400A BUS FED BY 225A BREAKER");
    const ev = evaluateDiagram(b.head.elements, view(b, "v-one-line"));
    expect(ev?.warnings.map((w) => w.message)).toEqual(["H1's 400 A bus is fed by a 225 A breaker in MDP; most of the time the breaker matches the bus. Raise the breaker, or keep it and note why."]);
    expect(cs.revision).toBe(b.head.revision);
  });

  it("re-derives the whole diagram from the graph each evaluation (no stored line work)", () => {
    const b = withOneLine();
    const stored = Object.values(b.head.elements).filter((e) => e.kind === "drawing_item");
    expect(stored).toEqual([]);
    const v = view(b, "v-one-line");
    expect(evaluateDiagram(b.head.elements, v)).toBe(evaluateDiagram(b.head.elements, v));
    b.ok({ type: "set_parameters", id: "h1", scope: "instance", values: { panel_name: "H1A" } });
    expect(texts(b)).toContain("H1A");
  });

  it("keeps the engineer's hints across model edits, and draws them as hints (orientation, order, pins, 3D boxes)", () => {
    const hints = { orientation: "horizontal", style: "box3d", order: { mdp: ["t1", "h1"] }, pins: { l1: { dx: 0, dy: -12 } } };
    const b = withOneLine(hints);
    const before = view(b, "v-one-line").props?.diagram;
    b.ok({ type: "set_parameters", id: "h1", scope: "instance", values: { panel_name: "H1A" } });
    b.ok({ type: "create_service_link", linkId: "c-new", sourceId: "l1", positions: [17], members: [{ elementId: b.place("rx1", "receptacle", { voltage: 120, load_va: 180 }) }] });
    expect(view(b, "v-one-line").props?.diagram).toEqual(before);
    const ev = evaluateDiagram(b.head.elements, view(b, "v-one-line"));
    if (!ev) throw new Error("no diagram");
    // Horizontal: power flows left to right, so the utility is left of the MDP and the MDP left of its panels.
    const center = (id: string) => {
      const box = ev.boxes.find((x) => x.elementId === id);
      if (!box) throw new Error(`no ${id}`);
      return { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2 };
    };
    expect(center("mdp").x).toBeLessThan(center("h1").x);
    // T1 first under the MDP (on top), H1 after it.
    expect(center("t1").y).toBeGreaterThan(center("h1").y);
    golden("one-line-horizontal-box3d.svg", sceneToSvg(buildViewScene(b.head, "v-one-line").scene));
  });

  it("draws equipment loads and future spaces when asked", () => {
    const b = withOneLine({ showLoads: true, futureSpaces: { mdp: 2 }, detail: "schematic" });
    const words = texts(b);
    expect(words).toContain("RTU-1");
    expect(words).toContain("H1-1,3,5");
    expect(words.filter((w) => w === "SPACE FOR FUTURE")).toHaveLength(2);
    // Schematic: no conductor tags.
    expect(words.some((w) => w.includes("#10"))).toBe(false);
    const dashed = evaluateDiagram(b.head.elements, view(b, "v-one-line"))?.items.filter((i) => i.lineStyle?.pattern === "dashed") ?? [];
    expect(dashed.length).toBeGreaterThan(0);
  });

  it("draws no utility above a panel nothing feeds, and still says NOT FED (#28)", () => {
    const b = withOneLine();
    b.place("p2", "panel480", { panel_name: "P2" });
    const ev = evaluateDiagram(b.head.elements, view(b, "v-one-line"));
    expect(ev?.warnings.filter((w) => w.kind === "not_fed").map((w) => w.elementId)).toEqual(["p2"]);
    const words = texts(b);
    expect(words).toContain("P2");
    expect(words).toContain("! NOT FED");
    // One utility, above the MDP; none above P2.
    expect(words.filter((w) => w.startsWith("UTILITY"))).toEqual(["UTILITY"]);
    golden("one-line-unfed-panel.svg", sceneToSvg(buildViewScene(b.head, "v-one-line").scene));
  });

  it("selects the equipment you click", () => {
    const b = withOneLine();
    const ev = evaluateDiagram(b.head.elements, view(b, "v-one-line"));
    const h1 = ev?.boxes.find((x) => x.elementId === "h1");
    if (!ev || !h1) throw new Error("no H1 box");
    expect(diagramElementAt(ev, { x: (h1.min.x + h1.max.x) / 2, y: (h1.min.y + h1.max.y) / 2 })).toBe("h1");
  });
});

/** Built-in starter parts, placed the way the Electrical tab places them. */
function builtinBuilding(): Building {
  const b = new Building();
  const lib = new Map(builtinPartTypes().map((e) => [e.id, e.definition]));
  const placed = new Set<string>();
  const place = (id: string, libId: string, values: Record<string, string | number>) => {
    const def = lib.get(libId);
    if (!def) throw new Error(`no ${libId}`);
    const typeId = `type-${libId}`;
    b.ok({ type: "place_part", partId: id, typeId, ...(placed.has(typeId) ? {} : { partType: def }), levelId: "lvl-1", position: { x: placed.size * 3000 + id.length * 100, y: 0 }, mark: id.toUpperCase(), values });
    placed.add(typeId);
  };
  place("mdp", "builtin:switchboard-800-480@1", { panel_name: "MDP" });
  place("h1", "builtin:panelboard-225-480@1", { panel_name: "H1" });
  place("t1", "builtin:transformer-75kva@1", { panel_name: "T1" });
  place("l1", "builtin:panelboard-225@1", { panel_name: "L1", mains: "225A MCB" });
  b.ok({ type: "create_service_link", linkId: "f-h1", sourceId: "mdp", positions: [1, 3, 5], members: [{ elementId: "h1" }], electrical: { ratingA: 225, feederType: "F225" } });
  b.ok({ type: "create_service_link", linkId: "f-t1", sourceId: "mdp", positions: [2, 4, 6], members: [{ elementId: "t1" }], electrical: { ratingA: 100, feederType: "F100T" } });
  b.ok({ type: "create_service_link", linkId: "f-l1", sourceId: "t1", members: [{ elementId: "l1" }] });
  b.ok({ type: "create_view", viewId: "v-one-line", name: "One-line diagram", viewType: "detail", props: { diagram: { kind: "one_line" } } });
  return b;
}

describe("acceptance: example building on built-in parts", () => {
  it("H1 bus 225 → 400 A in its properties: diagram text and the feeding-breaker warning follow in that revision", () => {
    const b = builtinBuilding();
    expect(texts(b)).toEqual(expect.arrayContaining(["H1", "225A BUS MLO", "480Y/277V 3PH 4W", "NEMA 1 22 KAIC"]));
    b.ok({ type: "set_parameters", id: "h1", scope: "instance", values: { bus_rating: 400 } });
    expect(texts(b)).toEqual(expect.arrayContaining(["400A BUS MLO", "! 400A BUS FED BY 225A BREAKER"]));
    expect(resolveField(b.head.elements, "h1", "bus_rating").value).toBe(400);
  });

  it("H1 → NEMA 3R updates the diagram", () => {
    const b = builtinBuilding();
    b.ok({ type: "set_parameters", id: "h1", scope: "instance", values: { enclosure: "NEMA 3R" } });
    expect(texts(b)).toContain("NEMA 3R 22 KAIC");
    expect(resolveField(b.head.elements, "h1", "enclosure").text).toBe("NEMA 3R");
  });
});

const FT = 304.8;
const IN = 25.4;

function pipePart(name: string, category: PartTypeDefinition["category"], connectors: ReadonlyArray<{ id: string; dir: [number, number, number]; flow?: number }>): PartTypeDefinition {
  return {
    familyName: name,
    typeName: "Test",
    category,
    typeParams: [],
    typeValues: {},
    instanceParams: [],
    connectors: connectors.map((c) => ({ id: c.id, label: c.id, domain: "pipe" as const, systemKind: "domestic_cold_water" as const, position: [0, 0, 0] as [number, number, number], direction: c.dir, shape: "round" as const, diameter: IN, ...(c.flow !== undefined ? { flow: c.flow } : {}) })),
    geometry: [{ kind: "box", center: [0, 0, 100], size: [200, 200, 200] }],
    symbol: [{ kind: "rect", center: [0, 0], size: [200, 200] }],
    tagFields: ["mark"],
    source: { kind: "builtin", libraryVersion: "test" },
  };
}

describe("plumbing riser on the same diagram engine", () => {
  it("draws a cold water system's fixtures by level with the pipe size that reaches each", () => {
    const b = new Building();
    b.ok({ type: "create_level", levelId: "lvl-2", name: "Level 2", elevationMm: 12 * FT });
    b.ok({ type: "place_part", partId: "svc", typeId: "t-svc", partType: pipePart("Water service", "mechanical_equipment", [{ id: "a", dir: [1, 0, 0] }, { id: "b", dir: [-1, 0, 0] }]), levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: 3 * FT, mark: "WS-1" });
    const fixture = pipePart("Lavatory", "plumbing_fixture", [{ id: "c", dir: [-1, 0, 0], flow: 1.5 }]);
    b.ok({ type: "place_part", partId: "lav1", typeId: "t-lav", partType: fixture, levelId: "lvl-1", position: { x: 30 * FT, y: 0 }, offsetMm: 3 * FT, mark: "L-1" });
    b.ok({ type: "place_part", partId: "lav2", typeId: "t-lav", levelId: "lvl-2", position: { x: 30 * FT, y: 0 }, offsetMm: 3 * FT, mark: "L-2" });
    const system = { id: "sys-cw", kind: "domestic_cold_water" as const, name: "Domestic Cold Water" };
    const copper = (inches: number) => ({ shape: "pipe" as const, nominalMm: inches * IN, material: "copper" as const });
    b.ok({ type: "route_run", idPrefix: "cw1", levelId: "lvl-1", domain: "pipe", size: copper(1), elevationMm: 3 * FT, system, points: [], from: { kind: "part", partId: "svc", connectorId: "a" }, to: { kind: "part", partId: "lav1", connectorId: "c" } });
    // Runs stay on their level: Level 2 is reached through a riser connection placed on it.
    b.ok({ type: "place_part", partId: "rsr", typeId: "t-rsr", partType: pipePart("Riser connection", "pipe_accessory", [{ id: "a", dir: [1, 0, 0] }]), levelId: "lvl-2", position: { x: 0, y: 0 }, offsetMm: 3 * FT, mark: "R-1" });
    b.ok({ type: "route_run", idPrefix: "cw2", levelId: "lvl-2", domain: "pipe", size: copper(0.75), elevationMm: 3 * FT, system, points: [], from: { kind: "part", partId: "rsr", connectorId: "a" }, to: { kind: "part", partId: "lav2", connectorId: "c" } });
    b.ok({ type: "create_view", viewId: "v-plumb", name: "Domestic water riser", viewType: "detail", props: { diagram: { kind: "plumbing_riser" } } });
    const ev = evaluateDiagram(b.head.elements, view(b, "v-plumb"));
    expect(ev?.equipment).toEqual(expect.arrayContaining(["svc", "lav1", "lav2", "rsr"]));
    const words = texts(b, "v-plumb");
    // Level 2 is its own piece of pipe until a riser joins it, so it says it has no source yet.
    expect(words).toEqual(expect.arrayContaining(["WS-1", "DOMESTIC COLD WATER", "L-1", "L-2", "LEVEL 1", "LEVEL 2", '1"', '¾"', "1.5 WFU", "NO SOURCE CONNECTED"]));
    // L-2 is drawn on the Level 2 band, above L-1.
    const y = (id: string) => ev?.boxes.find((x) => x.elementId === id)?.min.y ?? NaN;
    expect(y("lav2")).toBeGreaterThan(y("lav1"));
    golden("riser-plumbing.svg", sceneToSvg(buildViewScene(b.head, "v-plumb").scene));
  });
});

/** The shell warehouse (V5): CT cabinet → tap box → MDP-1, and a separately metered fire pump service off the tap box. Service equipment (CT cabinet, tap box, meter, disconnect) has no breaker positions. */
function warehouse(): Building {
  const b = new Building();
  const types: Record<string, PartTypeDefinition> = {
    ct: distributionType("CT cabinet", "1200A 480Y/277V", 480, "3", 6, 1200, "MLO"),
    tap: distributionType("Tap box", "1200A 480Y/277V", 480, "3", 12, 1200, "MLO"),
    swbd: distributionType("Switchboard", "1200A 480Y/277V", 480, "3", 30, 1200, "1200A MCB"),
    meter: { ...distributionType("Meter", "Fire pump service meter 480V", 480, "3", 6, 400, "MLO"), instanceParams: [{ name: "panel_name", label: "Name", kind: "text" }, { name: "service", label: "Service", kind: "text" }] },
    disc: distributionType("Disconnect, fused", "400A 480V 3P", 480, "3", 6, 400, "MLO"),
    fpc: distributionType("Fire pump controller", "100 HP 480V", 480, "3", 6, 200, "MLO"),
    panel: distributionType("Panelboard", "400A 480Y/277V", 480, "3", 42, 400, "MLO"),
  };
  let x = 0;
  const place = (id: string, t: string, values: Record<string, string>) => {
    const def = types[t];
    if (!def) throw new Error(t);
    x += 2000;
    b.ok({ type: "place_part", partId: id, typeId: `type-${t}`, ...(b.head.elements[`type-${t}`] ? {} : { partType: def }), levelId: "lvl-1", position: { x, y: 0 }, mark: id.toUpperCase(), values });
  };
  place("ct", "ct", { panel_name: "CT CABINET" });
  place("tap", "tap", { panel_name: "TAP BOX" });
  place("mdp1", "swbd", { panel_name: "MDP-1" });
  place("h1", "panel", { panel_name: "H1" });
  place("fpm", "meter", { panel_name: "FP METER", service: "fire pump" });
  place("fpd", "disc", { panel_name: "FP DISC" });
  place("fpc", "fpc", { panel_name: "FPC" });
  b.ok({ type: "create_service_link", linkId: "f-tap", sourceId: "ct", members: [{ elementId: "tap" }] });
  b.ok({ type: "create_service_link", linkId: "f-mdp1", sourceId: "tap", members: [{ elementId: "mdp1" }] });
  b.ok({ type: "create_service_link", linkId: "f-fpm", sourceId: "tap", members: [{ elementId: "fpm" }] });
  b.ok({ type: "create_service_link", linkId: "f-fpd", sourceId: "fpm", members: [{ elementId: "fpd" }] });
  b.ok({ type: "create_service_link", linkId: "f-fpc", sourceId: "fpd", members: [{ elementId: "fpc" }], electrical: { ratingA: 200 } });
  b.ok({ type: "create_service_link", linkId: "f-h1", sourceId: "mdp1", positions: [1, 3, 5], members: [{ elementId: "h1" }], electrical: { ratingA: 400, feederType: "F400" } });
  b.ok({ type: "create_view", viewId: "v-one-line", name: "One-line diagram", viewType: "detail", props: { diagram: { kind: "one_line" } } });
  return b;
}

describe("acceptance: warehouse fire pump service", () => {
  it("draws the fire pump as a separate service from the tap box", () => {
    const b = warehouse();
    const ev = evaluateDiagram(b.head.elements, view(b, "v-one-line"));
    if (!ev) throw new Error("no diagram");
    expect(ev.equipment).toEqual(["ct", "tap", "mdp1", "h1", "fpm", "fpd", "fpc"]);
    const words = texts(b);
    expect(words).toContain("FIRE PUMP SERVICE");
    expect(words.filter((w) => w.endsWith("SERVICE"))).toEqual(["FIRE PUMP SERVICE"]);
    // The section box surrounds the fire pump meter, disconnect and controller and nothing of the normal service.
    const box = (id: string) => ev.boxes.find((x) => x.elementId === id);
    const fpm = box("fpm");
    const mdp = box("mdp1");
    if (!fpm || !mdp) throw new Error("missing boxes");
    expect(fpm.min.x).toBeGreaterThan(mdp.max.x);
    golden("one-line-warehouse.svg", sceneToSvg(buildViewScene(b.head, "v-one-line").scene));
  });

  it("draws the electrical riser from the same graph, by level", () => {
    const b = warehouse();
    b.ok({ type: "create_view", viewId: "v-riser", name: "Electrical riser", viewType: "detail", props: { diagram: { kind: "electrical_riser" } } });
    const ev = evaluateDiagram(b.head.elements, view(b, "v-riser"));
    expect(ev?.equipment).toEqual(["ct", "tap", "mdp1", "h1", "fpm", "fpd", "fpc"]);
    expect(texts(b, "v-riser")).toEqual(expect.arrayContaining(["LEVEL 1", "MDP-1", "F400"]));
    golden("riser-electrical-warehouse.svg", sceneToSvg(buildViewScene(b.head, "v-riser").scene));
  });
});

