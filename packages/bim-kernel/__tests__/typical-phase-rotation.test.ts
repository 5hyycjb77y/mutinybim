/**
 * Typical units fed from a house panel (V1, WS-F typicals): each real unit
 * panel is its own 2-pole breaker, and the engineer spreads them over A-B,
 * B-C, C-A. Copies of a typical now land that way by default; "same" keeps
 * every copy on the original's phases when the engineer chooses it. Branch
 * circuits from outside a typical stay on their own phases unless asked.
 */
import { builtinPartTypes, DEFAULT_SETTINGS, asRevision, executeCommand, rotationCounts, type Command, type ModelState } from "../src";
import { CONNECTED_LOAD_ONLY, ElectricalLoadEngine } from "@permitzip/bim-pack-electrical";

function run(model: ModelState, command: Command): ModelState {
  const r = executeCommand(model, command);
  if (!r.ok) throw new Error(`${command.type}: ${r.error.message}`);
  return r.model;
}

function type(id: string) {
  const t = builtinPartTypes().find((x) => x.id === id);
  if (!t) throw new Error(id);
  return t;
}

/** HP (120/208 V 3-phase) feeds unit panel A001 (1-phase 3-wire) on a 2-pole breaker in slots 1 and 3 (A-B); the unit has 2,000 VA, half on each leg. */
function building(): ModelState {
  let m: ModelState = { modelId: "rot", revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const place = (partId: string, typeId: string, x: number, values: Record<string, string | number> = {}) => {
    const t = type(typeId);
    m = run(m, { type: "place_part", partId, typeId: t.id, ...(m.elements[t.id] ? {} : { partType: t.definition }), levelId: "lvl", position: { x, y: 0 }, values });
  };
  m = run(m, { type: "create_level", levelId: "lvl", name: "Level 1", elevationMm: 0 });
  place("hp", "builtin:panelboard-225@1", -20000, { panel_name: "HP" });
  place("a001", "builtin:panelboard-125-208-1ph@1", 0, { panel_name: "A001" });
  place("r1", "builtin:duplex-receptacle@1", 1000, { load: 1000 });
  place("r2", "builtin:duplex-receptacle@1", 2000, { load: 1000 });
  m = run(m, { type: "create_service_link", linkId: "c1", sourceId: "a001", positions: [1], members: [{ elementId: "r1" }] });
  m = run(m, { type: "create_service_link", linkId: "c2", sourceId: "a001", positions: [3], members: [{ elementId: "r2" }] });
  m = run(m, { type: "create_service_link", linkId: "f1", sourceId: "hp", positions: [1, 3], members: [{ elementId: "a001" }], electrical: { ratingA: 60 } });
  m = run(m, { type: "create_group", groupId: "g-001", name: "Unit 001" });
  m = run(m, { type: "assign_elements_to_group", ids: ["a001", "r1", "r2"], groupId: "g-001" });
  return m;
}

const typical = (count: number, phaseRotation?: "rotate" | "same"): Command => ({ type: "set_group_typical", groupId: "g-001", mark: "001", array: { count, columns: 6, spacingMm: { x: 10000, y: -8000 } }, ...(phaseRotation ? { phaseRotation } : {}) });
const phases = (m: ModelState) => new ElectricalLoadEngine(CONNECTED_LOAD_ONLY).loads(m, "hp")?.inventory.perPhase.map(Math.round);

describe("phase rotation across typical copies", () => {
  it("one unit sits on A-B", () => {
    expect(phases(building())).toEqual([1000, 1000, 0]);
  });

  it("by default 24 unit panels spread over A-B, B-C, C-A: the house panel is balanced", () => {
    const m = run(building(), typical(24));
    expect(phases(m)).toEqual([16000, 16000, 16000]);
    expect(new ElectricalLoadEngine(CONNECTED_LOAD_ONLY).loads(m, "hp")?.inventory.va).toBe(48000);
  });

  it("three units: one on each pair; four: the fourth back on A-B", () => {
    expect(phases(run(building(), typical(3)))).toEqual([2000, 2000, 2000]);
    expect(phases(run(building(), typical(4)))).toEqual([3000, 3000, 2000]);
    expect(rotationCounts(4, 3)).toEqual([2, 1, 1]);
    expect(rotationCounts(2, 3)).toEqual([1, 1]);
  });

  it('"same" keeps every copy on the original\'s phases when the engineer chooses it, and the choice is kept', () => {
    let m = run(building(), typical(24, "same"));
    expect(phases(m)).toEqual([24000, 24000, 0]);
    // Changing the count later keeps "same".
    m = run(m, { type: "set_group_typical", groupId: "g-001", array: { count: 12, columns: 6, spacingMm: { x: 10000, y: -8000 } } });
    expect(phases(m)).toEqual([12000, 12000, 0]);
    m = run(m, { type: "set_group_typical", groupId: "g-001", phaseRotation: "rotate" });
    expect(phases(m)).toEqual([8000, 8000, 8000]);
  });

  it("devices of a typical circuited straight from the house panel stay on their phases unless the engineer asks to rotate", () => {
    let m = building();
    m = run(m, { type: "remove_link_members", linkId: "c1", elementIds: ["r1"] });
    m = run(m, { type: "create_service_link", linkId: "h1", sourceId: "hp", positions: [5], members: [{ elementId: "r1" }] });
    m = run(m, typical(3));
    // r1 (1,000 VA) on HP slot 5 (phase C) x3, plus the unit panel's r2 (1,000 VA on its leg A) rotated A, B, C.
    expect(phases(m)).toEqual([1000, 1000, 4000]);
    m = run(m, { type: "set_group_typical", groupId: "g-001", phaseRotation: "rotate" });
    expect(phases(m)).toEqual([2000, 2000, 2000]);
  });
});
