/**
 * @jest-environment node
 *
 * Clearance zones and hosts in the coordination lint (workstream `spatial`):
 * clearance-intrusion fires on something solid inside a zone and stays quiet
 * when the zone is clear or only touched; floating-equipment reads a part's
 * stated host and curb first, says when the host is gone or moved, and the
 * drill (RTU on the linked roof with service clearance → a second unit moved
 * into it → the deck it stood on removed) shows in the per-edit lint block.
 */
import { builtinPartType, type ClearanceZone, type Slab } from "@permitzip/bim-kernel";
import { LintEngine, lintEdit, type LintBlock } from "../src";
import { config, engineFor, FT, IN, linkedBuilding, Model, ROOF_ELEVATION, rulesFired, SUPPLY } from "./fixtures";

const PANEL = builtinPartType("builtin:panelboard-225@1");
const SERVICE: ClearanceZone = { id: "service", name: "Service access", purpose: "service_access", face: "front", depth: 4 * FT };
const WORKING: ClearanceZone = { id: "working_space", name: "Working space", purpose: "working_space", face: "front", depth: 3 * FT, width: 30 * IN, height: 6.5 * FT, fromFloor: true };

const fired = (m: Model, rule: string, linked = [linkedBuilding()]) => rulesFired(m.head, linked).get(rule) ?? [];

function withServiceZone(m: Model): void {
  m.ok({ type: "set_part_clearances", id: "rtu-1", scope: "type", zones: [SERVICE] });
}

function placePanel(m: Model, at: { x: number; y: number }): void {
  if (!PANEL) throw new Error("starter library is missing the panelboard");
  m.ok({ type: "place_part", partId: "mdp-1", typeId: PANEL.id, partType: PANEL.definition, levelId: "lvl-1", position: at, offsetMm: 0, mark: "MDP-1" });
  m.ok({ type: "set_part_clearances", id: "mdp-1", scope: "instance", overrides: { working_space: { name: WORKING.name, purpose: "working_space", face: "front", depth: 3 * FT, width: 30 * IN, height: 6.5 * FT, fromFloor: true } } });
}

describe("clearance-intrusion", () => {
  it("a second rooftop unit inside the first one's service access is flagged, by name and depth", () => {
    const m = new Model();
    m.placeRtu("rtu-1", { x: 20 * FT, y: 20 * FT });
    withServiceZone(m);
    m.placeRtu("rtu-2", { x: 25 * FT, y: 20 * FT });
    const hits = fired(m, "clearance-intrusion");
    expect(hits.some((h) => /^RTU-2 is [\d.]+ in\. into RTU-1's service access \(4'-0" front\)$/.test(h))).toBe(true);
  });

  it("near miss: the same unit beyond the zone, and zones may overlap each other", () => {
    const m = new Model();
    m.placeRtu("rtu-1", { x: 20 * FT, y: 20 * FT });
    withServiceZone(m);
    m.placeRtu("rtu-2", { x: 40 * FT, y: 20 * FT });
    expect(fired(m, "clearance-intrusion")).toEqual([]);
  });

  it("a duct through MDP-1's NEC 110.26 working space is an error; one above 6'-6\" is not", () => {
    const m = new Model();
    placePanel(m, { x: 10 * FT, y: 10 * FT });
    m.duct("sa", SUPPLY, [[0, 10], [30, 10]], 4);
    const e = engineFor(m.head, [linkedBuilding()]);
    const hit = e.check({ config: config({ ruleset: "issue" }) }).find((f) => f.rule === "clearance-intrusion");
    expect(hit?.severity).toBe("error");
    expect(hit?.message).toMatch(/Supply Air 1 .* into MDP-1's working space \(3'-0" front\)/);

    const high = new Model();
    placePanel(high, { x: 10 * FT, y: 10 * FT });
    high.duct("sa", SUPPLY, [[0, 10], [30, 10]], 8.5);
    expect(fired(high, "clearance-intrusion")).toEqual([]);
  });

  it("says why it can't run on a model with no clearance zones", () => {
    const m = new Model();
    m.placeRtu("rtu-1", { x: 20 * FT, y: 20 * FT });
    const row = engineFor(m.head).availability(config({ ruleset: "issue" })).find((r) => r.rule === "clearance-intrusion");
    expect(row?.available).toBe(false);
    withServiceZone(m);
    expect(engineFor(m.head).availability(config({ ruleset: "issue" })).find((r) => r.rule === "clearance-intrusion")?.available).toBe(true);
  });
});

describe("floating-equipment with a stated host", () => {
  const roofHost = { kind: "linked" as const, referenceId: "linked-arch-v3", globalId: "2Fq-roof-slab", name: "ROOF", surface: "roof" as const, topMm: ROOF_ELEVATION };

  it("a unit on a 14 in. curb on the linked roof is seated, not floating", () => {
    const m = new Model();
    m.placeRtu("rtu-1", { x: 40 * FT, y: 20 * FT });
    m.ok({ type: "set_part_host", ids: ["rtu-1"], host: roofHost, curbMm: 14 * IN });
    expect(fired(m, "floating-equipment")).toEqual([]);
  });

  it("raised above its curb, it floats and the fix names its host", () => {
    const m = new Model();
    m.placeRtu("rtu-1", { x: 40 * FT, y: 20 * FT });
    m.ok({ type: "set_part_host", ids: ["rtu-1"], host: roofHost, curbMm: 14 * IN });
    m.ok({ type: "move_elements", ids: ["rtu-1"], delta: { x: 0, y: 0 }, dzMm: 1 * FT });
    expect(fired(m, "floating-equipment")).toEqual(['RTU-1 is 12" above ROOF (linked) on a 14" curb']);
  });

  it("the architect raised the roof since: says the host moved", () => {
    const m = new Model();
    m.placeRtu("rtu-1", { x: 40 * FT, y: 20 * FT });
    m.ok({ type: "set_part_host", ids: ["rtu-1"], host: { ...roofHost, topMm: ROOF_ELEVATION - 6 * IN } });
    expect(fired(m, "floating-equipment")[0]).toMatch(/^ROOF \(linked\) moved up 6 in\. since RTU-1 was stood on it/);
  });
});

describe("the drill, through the per-edit lint block", () => {
  function edit(engine: LintEngine, m: Model, apply: () => string[]): LintBlock {
    const before = m.head;
    const changed = apply();
    // No time budget: these check what the lint finds, not how fast the machine is.
    return lintEdit(engine, { before, after: m.head, changedIds: changed, options: { config: config() }, budgetMs: Number.POSITIVE_INFINITY });
  }

  it("RTU on a deck over the linked roof with service clearance → a second unit moved into it → the deck removed", () => {
    const m = new Model();
    const deckTop = ROOF_ELEVATION + 2 * FT;
    m.ok({ type: "create_level", levelId: "lvl-deck", name: "MECH DECK", elevationMm: deckTop });
    const deck: Slab = { id: "deck-1" as Slab["id"], kind: "slab", version: 0, authoredRev: {}, partition: { level: "MECH DECK", zone: "Z1", discipline: "architecture" }, outline: [{ x: 10 * FT, y: 10 * FT }, { x: 50 * FT, y: 10 * FT }, { x: 50 * FT, y: 30 * FT }, { x: 10 * FT, y: 30 * FT }], thickness: 6 * IN };
    m.put(deck);
    const engine = new LintEngine();
    engine.build(m.head, [linkedBuilding()]);

    const placed = edit(engine, m, () => m.placeRtu("rtu-1", { x: 20 * FT, y: 20 * FT }, 0, "lvl-deck"));
    edit(engine, m, () => m.ok({ type: "set_part_host", ids: ["rtu-1"], host: { kind: "slab", elementId: "deck-1" }, curbMm: 14 * IN }));
    edit(engine, m, () => m.ok({ type: "set_part_clearances", id: "rtu-1", scope: "type", zones: [SERVICE] }));
    expect(placed.new.map((f) => f.rule)).not.toContain("outside-building");

    edit(engine, m, () => m.placeRtu("rtu-2", { x: 40 * FT, y: 20 * FT }, 14 * IN, "lvl-deck"));
    const moved = edit(engine, m, () => m.ok({ type: "move_elements", ids: ["rtu-2"], delta: { x: -15 * FT, y: 0 } }));
    expect(moved.new.map((f) => f.rule)).toContain("clearance-intrusion");
    expect(moved.new.find((f) => f.rule === "clearance-intrusion")?.msg).toMatch(/RTU-2 is .* into RTU-1's service access/);

    const removed = edit(engine, m, () => m.ok({ type: "delete_elements", ids: ["deck-1"], policy: "refuse" }));
    expect(removed.new.find((f) => f.rule === "floating-equipment" && f.ids.includes("rtu-1"))?.msg).toBe("RTU-1 has nothing under it: its host slab deck-1 (deleted) is gone");
  });
});
