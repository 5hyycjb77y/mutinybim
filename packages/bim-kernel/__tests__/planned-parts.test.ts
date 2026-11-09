/**
 * @jest-environment node
 *
 * Planned parts (ROADMAP F1, KERNEL-REQUIREMENTS-MODEL §3.1): a panel can
 * exist with its id, values and feeders before anyone draws it, and placing
 * it later keeps everything that points at it. Geometry consumers skip it and
 * say so; topology consumers (feeders, panel schedules, one-line, fields)
 * include it.
 *
 * Consumer tests build the planned part by stamping `planned` onto a placed
 * part's record, so they fail on code that predates the field: there the
 * placeholder location (level origin) is drawn, measured and checked.
 */
import { anchorOf, asElementId, applyChangeset, buildSheetSceneFor, buildViewScene, canonicalJson, elementsAabb, evaluateDiagram, hostState, partClearances, validateModel, type BimElement, type DiagramNode, type ModelState, type PartInstance, type ViewElement } from "../src";
import { electricalDiagramGraph, panelSchedule, planServiceLayout } from "@permitzip/bim-pack-electrical";
import { elementSolid } from "../src/drawing/solids";
import { placedSymbol } from "../src/part-placed";
import { advancePlannedIndex, plannedPartCount, plannedPartGroups, plannedParts, plannedSkipReport, plannedSkipText } from "../src/placement/planned-index";
import { PLACEMENT_FIELD_PROVIDER } from "../src/fields/providers/placement";
import { Building, TYPES, referenceDistribution } from "./fixtures/electrical-building";

function part(b: Building, id: string): PartInstance {
  const el = b.el(id);
  if (el.kind !== "part") throw new Error(`${id} is a ${el.kind}`);
  return el;
}

/** The model with `ids` turned into planned parts, record by record (no command). */
function stampPlanned(model: ModelState, ids: readonly string[]): ModelState {
  const elements: Record<string, BimElement> = { ...model.elements };
  for (const id of ids) {
    const el = elements[id];
    if (el?.kind !== "part") throw new Error(`${id} is not a part`);
    elements[id] = { ...el, planned: { levelHint: el.levelId } };
  }
  return { ...model, elements };
}

function planView(b: Building): void {
  b.ok({ type: "create_view", viewId: "v-plan", name: "Level 1 plan", viewType: "floor_plan", props: { level: "Level 1" } });
}

function graphNode(roots: readonly DiagramNode[], elementId: string): DiagramNode | null {
  for (const n of roots) {
    if (n.elementId === elementId) return n;
    const hit = graphNode([...n.children, ...(n.emergency ? [n.emergency] : [])], elementId);
    if (hit) return hit;
  }
  return null;
}

describe("plan_part, place_planned_part, unplace_part", () => {
  it("plans a panel with values and no location, lists it, and keeps the model valid", () => {
    const b = new Building();
    b.ok({ type: "plan_part", partId: "p1", typeId: "type-panel208", partType: TYPES.panel208, mark: "P1", values: { panel_name: "P1" }, levelHint: "lvl-1", note: "Electrical room, once the architect shows it" });
    b.valid();
    const p1 = part(b, "p1");
    expect(p1.planned).toEqual({ levelHint: "lvl-1", note: "Electrical room, once the architect shows it" });
    expect(plannedParts(b.head.elements).map((p) => p.id)).toEqual(["p1"]);
    expect(plannedPartGroups(b.head.elements)).toEqual([
      { discipline: "electrical", categoryLabel: "Electrical equipment", rows: [expect.objectContaining({ id: "p1", name: "P1", levelHint: "Level 1" })] },
    ]);
  });

  it("placing keeps the id, the feeder and the panel schedule; the list shrinks", () => {
    const b = referenceDistribution();
    b.ok({ type: "plan_part", partId: "p2", typeId: "type-panel208", values: { panel_name: "P2" }, mark: "P2" });
    b.ok({ type: "create_service_link", linkId: "f-p2", sourceId: "t1", members: [{ elementId: "p2" }] });
    const before = panelSchedule(b.head.elements, "p2");
    expect(before?.fedBy?.sourceName).toBe("T1");
    expect(plannedPartCount(b.head.elements)).toBe(1);

    b.ok({ type: "place_planned_part", partId: "p2", levelId: "lvl-1", position: { x: 6000, y: 1200 }, rotationDeg: 90 });
    b.valid();
    const p2 = part(b, "p2");
    expect(p2.planned).toBeUndefined();
    expect(p2.position).toEqual({ x: 6000, y: 1200 });
    expect(p2.rotationDeg).toBe(90);
    expect(p2.served).toEqual({ feeder: "f-p2" });
    expect(canonicalJson(panelSchedule(b.head.elements, "p2"))).toBe(canonicalJson(before));
    expect(plannedPartCount(b.head.elements)).toBe(0);
  });

  it("unplace puts it back on the list and keeps its feeder; a second unplace is refused in words", () => {
    const b = referenceDistribution();
    b.ok({ type: "unplace_part", partId: "l1", note: "Moving rooms" });
    const l1 = part(b, "l1");
    expect(l1.planned).toEqual({ levelHint: "lvl-1", note: "Moving rooms" });
    expect(l1.served).toEqual({ feeder: "f-l1" });
    expect(panelSchedule(b.head.elements, "l1")?.fedBy?.sourceName).toBe("T1");
    expect(b.refused({ type: "unplace_part", partId: "l1" })).toMatch(/isn't placed yet/);
  });

  it("refuses in plain words: placing twice, moving or turning a planned part, a level that isn't there", () => {
    const b = referenceDistribution();
    expect(b.refused({ type: "place_planned_part", partId: "l1", levelId: "lvl-1", position: { x: 0, y: 0 } })).toMatch(/already placed; move it instead/);
    b.ok({ type: "unplace_part", partId: "l1" });
    expect(b.refused({ type: "move_elements", ids: ["l1"], delta: { x: 100, y: 0 } })).toMatch(/isn't placed yet, so it can't be moved; place it first/);
    expect(b.refused({ type: "rotate_elements", ids: ["l1"], angleDeg: 90 })).toMatch(/can't be rotated/);
    expect(b.refused({ type: "plan_part", partId: "p9", typeId: "type-panel208", levelHint: "lvl-nope" })).toMatch(/There is no level lvl-nope/);
    expect(b.refused({ type: "plan_part", partId: "l1", typeId: "type-panel208" })).toMatch(/already exists/);
  });

  it("undo of a plan removes the part", () => {
    const b = new Building();
    const cs = b.ok({ type: "plan_part", partId: "p1", typeId: "type-panel208", partType: TYPES.panel208 });
    b.ok({ type: "undo", revision: cs.revision });
    expect(b.head.elements.p1).toBeUndefined();
    expect(plannedPartCount(b.head.elements)).toBe(0);
  });
});

describe("the planned-parts index carries forward from changed ids", () => {
  it("matches a fresh build after plan, place and unplace", () => {
    const b = referenceDistribution();
    plannedParts(b.head.elements);
    const step = (command: Parameters<Building["ok"]>[0]) => {
      const prev = b.head.elements;
      const cs = b.ok(command);
      advancePlannedIndex(prev, b.head.elements, cs.elements.map((e) => e.id), cs.removedIds ?? []);
      const fresh = Object.values(b.head.elements).filter((e) => e.kind === "part" && e.planned !== undefined).map((e) => e.id).sort();
      expect(plannedParts(b.head.elements).map((p) => p.id).sort()).toEqual(fresh);
    };
    step({ type: "plan_part", partId: "p2", typeId: "type-panel208" });
    step({ type: "unplace_part", partId: "h1" });
    step({ type: "place_planned_part", partId: "p2", levelId: "lvl-1", position: { x: 1, y: 2 } });
    step({ type: "delete_elements", ids: ["p2"], policy: "cascade" });
    expect(plannedParts(b.head.elements).map((p) => p.id)).toEqual(["h1"]);
  });
});

describe("geometry consumers skip planned parts and say so", () => {
  function onePlaced(): { b: Building; placed: ModelState; planned: ModelState } {
    const b = new Building();
    planView(b);
    b.ok({ type: "create_sheet", sheetId: "s1", number: "E-101", name: "Power plan" });
    b.ok({ type: "place_viewport", viewportId: "vp1", sheetId: "s1", viewId: "v-plan", center: { x: 300, y: 300 } });
    b.place("px", "panel208", { panel_name: "PX" }, "PX", { x: 0, y: 0 });
    return { b, placed: b.head, planned: stampPlanned(b.head, ["px"]) };
  }

  it("plan views draw nothing for it", () => {
    const { placed, planned } = onePlaced();
    const drawn = buildViewScene(placed, "v-plan").scene.primitives.length;
    const empty = buildViewScene({ ...placed, elements: Object.fromEntries(Object.entries(placed.elements).filter(([id]) => id !== "px")) }, "v-plan").scene.primitives.length;
    expect(drawn).toBeGreaterThan(empty);
    expect(buildViewScene(planned, "v-plan").scene.primitives.length).toBe(empty);
    expect(plannedSkipReport("plan view", planned.elements)).toEqual({ consumer: "plan view", plannedIds: ["px"] });
  });

  it("sheets draw nothing for it", () => {
    const { placed, planned } = onePlaced();
    const count = (m: ModelState) => buildSheetSceneFor(m, "s1", { projectName: "Test" }).primitives.length;
    expect(count(planned)).toBeLessThan(count(placed));
  });

  it("no solid, no bounds, no clearance, no host and no symbol", () => {
    const { planned } = onePlaced();
    const px = planned.elements.px;
    if (px?.kind !== "part") throw new Error("px");
    expect(elementSolid(planned, px, 0)).toBeNull();
    expect(elementsAabb(planned, ["px"])).toBeNull();
    expect(partClearances(planned, px)).toEqual([]);
    expect(hostState(planned, px)).toMatchObject({ status: "none", label: "Not placed yet" });
    const type = planned.elements[px.typeId];
    if (type?.kind !== "part_type") throw new Error("type");
    expect(placedSymbol(type, px)).toEqual([]);
    expect(plannedSkipText(1, "checked for clashes")).toBe("1 planned element not checked for clashes");
  });

  it("a run can't connect to a part that isn't drawn; validation says why", () => {
    const { planned } = onePlaced();
    const px = planned.elements.px;
    if (px?.kind !== "part") throw new Error("px");
    const linked: ModelState = { ...planned, elements: { ...planned.elements, px: { ...px, links: { feeder: { elementId: "r1" as PartInstance["id"], port: "start" } } } } };
    expect(validateModel(linked).map((i) => i.message)).toEqual(expect.arrayContaining([expect.stringMatching(/PX isn't placed yet, so no run can connect to it/)]));
  });
});

describe("topology consumers include planned parts", () => {
  it("one-line: a planned panel is on the diagram, dashed and marked NOT PLACED; placed gear is unchanged", () => {
    const b = referenceDistribution();
    const view: Pick<ViewElement, "id" | "props"> = { id: asElementId("v-ol"), props: { diagram: { kind: "one_line", hints: {} } } };
    const placedGraph = electricalDiagramGraph(b.head.elements);
    const placedItems = evaluateDiagram(b.head.elements, view)?.items ?? [];
    expect(graphNode(placedGraph.roots, "l1")?.planned).toBeUndefined();
    expect(placedItems.some((i) => i.lineStyle?.pattern === "dashed")).toBe(false);

    const planned = stampPlanned(b.head, ["l1"]);
    const graph = electricalDiagramGraph(planned.elements);
    const l1 = graphNode(graph.roots, "l1");
    expect(l1?.planned).toBe(true);
    expect(l1?.lines.map((l) => l.text)).toContain("NOT PLACED");
    expect(graphNode(graph.roots, "h1")?.planned).toBeUndefined();
    const items = evaluateDiagram(planned.elements, view)?.items ?? [];
    expect(items.some((i) => i.lineStyle?.pattern === "dashed")).toBe(true);
  });

  it("the Placement field reads Placed / Not placed yet and the planned level", () => {
    const b = referenceDistribution();
    const planned = stampPlanned(b.head, ["l1"]);
    const [placement, level] = PLACEMENT_FIELD_PROVIDER.fields ?? [];
    const read = (path: typeof placement, id: string) => path?.read?.(planned.elements[id] as BimElement, { elements: planned.elements });
    expect(read(placement, "l1")).toBe("Not placed yet");
    expect(read(placement, "h1")).toBe("Placed");
    expect(read(level, "l1")).toBe("Level 1");
    expect(read(level, "h1")).toBeNull();
  });
});

describe("service layout, plan only", () => {
  it("MDP and P1 exist with their feeder and panel schedule, none of them placed", () => {
    const b = new Building();
    const p = planServiceLayout(b.head, { levelId: "lvl-1", serviceA: 400, system: "208Y/120", meter: false, planOnly: true, equipment: [{ kind: "panel", name: "P1", fedFrom: "MDP", busA: 225, mains: "MCB" }] });
    if (!p.ok) throw new Error(p.reason);
    expect(p.command.planOnly).toBe(true);
    expect(p.where).toMatch(/not placed yet/);
    b.ok(p.command);
    b.valid();
    const ids = p.items.map((i) => i.partId);
    for (const id of ids) expect(part(b, id).planned).toEqual({ levelHint: "lvl-1" });
    expect(plannedParts(b.head.elements).map((x) => x.id).sort()).toEqual([...ids].sort());
    const p1 = p.items.find((i) => i.name === "P1");
    expect(panelSchedule(b.head.elements, p1?.partId ?? "")?.fedBy?.sourceName).toBe("MDP");
  });

  it("without plan only, the same request still places everything (unchanged)", () => {
    const b = new Building();
    const p = planServiceLayout(b.head, { levelId: "lvl-1", serviceA: 400, system: "208Y/120", meter: false, equipment: [{ kind: "panel", name: "P1", fedFrom: "MDP", busA: 225 }] });
    if (!p.ok) throw new Error(p.reason);
    expect("planOnly" in p.command).toBe(false);
    b.ok(p.command);
    expect(plannedPartCount(b.head.elements)).toBe(0);
  });
});

describe("rolling deploy: an older client that doesn't know `planned`", () => {
  it("reads the flat placeholder fields: a real level, the level origin, no crash", () => {
    const b = new Building();
    const prior = b.head;
    const cs = b.ok({ type: "plan_part", partId: "p1", typeId: "type-panel208", partType: TYPES.panel208, mark: "P1" });
    // An old reader sees the record as JSON and applies the changeset with code that never mentions `planned`.
    const wire = JSON.parse(JSON.stringify(cs)) as typeof cs;
    const old = applyChangeset(prior, wire);
    const p1 = old.elements.p1;
    if (p1?.kind !== "part") throw new Error("p1 missing after apply");
    expect(old.elements[p1.levelId]?.kind).toBe("level");
    expect(p1.position).toEqual({ x: 0, y: 0 });
    expect(p1.offsetMm).toBe(0);
    expect(anchorOf(p1)).toEqual({ x: 0, y: 0 });
  });
});
