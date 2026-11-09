/**
 * @jest-environment node
 *
 * Kernel seams left by the Oct 27 builders (kernel-seams):
 *
 * 1. The per-kind index. The reported "poisoning" (elementsOfKind(older) → []
 *    once a newer record was planned from it) was a caller handing the whole
 *    model (`d1`) where its element record (`d1.elements`) belongs: the
 *    kernel indexed modelId, revision, elements, connections and settings as
 *    five "elements" with no kind, cached that by identity, and answered []
 *    for every kind, silently. Now that record is refused, loudly.
 * 2. Not placed yet follows a part's connections and loads, not only its
 *    class: kitchen equipment pasted from Electrical › Equipment list is
 *    filed as Mechanical equipment, and must still list on Electrical.
 * 3. A copy is on no circuit, so it drops the typed Circuit / Fed from text.
 */
import { DEFAULT_SETTINGS, elementsOfKind, elementValues, planCommit, type Command, type ModelState, type PartInstance, type PartTypeDefinition } from "../src";
import { plannedPartGroups } from "../src/placement/planned-index";
import { Building } from "./fixtures/electrical-building";

let seq = 0;
function apply(m: ModelState, command: Command): ModelState {
  seq += 1;
  const d = planCommit(m, [], { idempotencyKey: `kseams-${seq}`, baseRevision: m.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command });
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

function blank(): ModelState {
  return apply({ modelId: "kseams", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS }, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
}

/** The shape the Equipment list files kitchen items under: Mechanical equipment, nameplate values, no drawn connectors. */
const LISTED: PartTypeDefinition = {
  familyName: "Equipment, from an equipment list",
  typeName: "Listed item",
  category: "mechanical_equipment",
  typeParams: [],
  typeValues: {},
  instanceParams: [
    { name: "description", label: "Description", kind: "text" },
    { name: "voltage", label: "Voltage", kind: "number", unit: "v", min: 0 },
    { name: "phases", label: "Phases", kind: "number", unit: "none", min: 0 },
    { name: "load_va", label: "Load", kind: "number", unit: "va", min: 0 },
    { name: "input_mbh", label: "Gas input (MBH)", kind: "number", unit: "none", min: 0 },
    { name: "cw_size", label: "Cold water", kind: "text" },
  ],
  connectors: [],
  geometry: [{ kind: "box", center: [0, 0, 450], size: [600, 600, 900] }],
  symbol: [{ kind: "rect", center: [0, 0], size: [600, 600] }],
  tagFields: ["mark"],
  source: { kind: "builtin", libraryVersion: "test" },
};

const ids = (groups: ReturnType<typeof plannedPartGroups>) => groups.flatMap((g) => g.rows.map((r) => r.id));

describe("per-kind index across snapshots", () => {
  function chain() {
    const d0 = blank();
    const d1 = apply(d0, { type: "place_part", partId: "fryer", typeId: "type-equip", partType: LISTED, levelId: "lvl-1", position: { x: 2000, y: 0 }, mark: "FRYER" });
    const d2 = apply(d1, { type: "place_part", partId: "oven", typeId: "type-equip", levelId: "lvl-1", position: { x: 4000, y: 0 }, mark: "OVEN" });
    return { d1, d2 };
  }

  it("reads an older record, then the newer one built from it, and agrees with the values (both orders)", () => {
    const a = chain();
    expect([elementsOfKind(a.d1.elements, "part").map((p) => p.id), elementsOfKind(a.d2.elements, "part").map((p) => p.id)]).toEqual([["fryer"], ["fryer", "oven"]]);
    const b = chain();
    expect([elementsOfKind(b.d2.elements, "part").map((p) => p.id), elementsOfKind(b.d1.elements, "part").map((p) => p.id)]).toEqual([["fryer", "oven"], ["fryer"]]);
    for (const m of [a.d1, a.d2]) expect(elementsOfKind(m.elements, "part", "level", "part_type").map((e) => e.id)).toEqual(elementValues(m.elements).map((e) => e.id));
  });

  it("refuses the whole model where its element record belongs, instead of answering [] for every kind", () => {
    const { d1 } = chain();
    const notElements = d1 as unknown as ModelState["elements"];
    expect(() => elementsOfKind(notElements, "part")).toThrow('Not an element record: "modelId" holds string, not an element. Pass model.elements, not the model.');
    // The refusal is not cached as an empty index: the real record still reads.
    expect(elementsOfKind(d1.elements, "part").map((p) => p.id)).toEqual(["fryer"]);
  });
});

describe("Not placed yet follows connections and loads", () => {
  function kitchen(): ModelState {
    let m = blank();
    const plan = (partId: string, mark: string, values: PartInstance["values"]): Command => ({ type: "plan_part", partId, typeId: "type:listed", ...(m.elements["type:listed"] ? {} : { partType: LISTED }), mark, values });
    m = apply(m, plan("k-fryer", "K-1", { description: "Fryer", voltage: 120, phases: 1, load_va: 1800, input_mbh: 80 }));
    m = apply(m, plan("k-range", "K-2", { description: "Range, gas", input_mbh: 220 }));
    m = apply(m, plan("k-sink", "K-3", { description: "Prep sink", cw_size: "1/2 in." }));
    m = apply(m, plan("k-hood", "K-4", { description: "Hood, no services listed yet" }));
    m = apply(m, plan("k-mixer", "K-5", { description: "Mixer" }));
    m = apply(m, { type: "create_load", loads: [{ id: "lp-mixer", anchor: { kind: "part", partId: "k-mixer" }, values: { va: 1200 } }] });
    return m;
  }

  it("lists kitchen equipment with an electrical load on Electrical, gas and water on Plumbing, and everything on Mechanical as before", () => {
    const m = kitchen();
    expect(ids(plannedPartGroups(m.elements, ["electrical"]))).toEqual(["k-fryer", "k-mixer"]);
    expect(ids(plannedPartGroups(m.elements, ["plumbing", "fire_protection"]))).toEqual(["k-fryer", "k-range", "k-sink"]);
    expect(ids(plannedPartGroups(m.elements, ["mechanical"]))).toEqual(["k-fryer", "k-range", "k-sink", "k-hood", "k-mixer"]);
  });

  it("files them under the tab's trade on that tab, and under their own class with no tab", () => {
    const m = kitchen();
    expect(plannedPartGroups(m.elements, ["electrical"]).map((g) => [g.discipline, g.categoryLabel])).toEqual([["electrical", "Mechanical equipment"]]);
    expect(plannedPartGroups(m.elements).map((g) => [g.discipline, g.categoryLabel, g.rows.length])).toEqual([["mechanical", "Mechanical equipment", 5]]);
  });

  it("an electrical panel planned on its own still lists on Electrical only", () => {
    const b = new Building();
    b.ok({ type: "plan_part", partId: "p1", typeId: "type-panel208", partType: { ...LISTED, familyName: "Panelboard", typeName: "208Y/120", category: "electrical_equipment", instanceParams: [] }, mark: "P1" });
    expect(ids(plannedPartGroups(b.head.elements, ["electrical"]))).toEqual(["p1"]);
    expect(ids(plannedPartGroups(b.head.elements, ["plumbing", "fire_protection"]))).toEqual([]);
  });
});

describe("copy_elements", () => {
  it("drops the typed Circuit and Fed from text on the copy; the original keeps it", () => {
    const b = new Building();
    b.place("r1", "receptacle", { voltage: 120, load_va: 180, circuit: "P1-1" });
    b.place("p2", "panel208", { panel_name: "P2", fed_from: "MDP" });
    b.ok({ type: "copy_elements", ids: ["r1", "p2"], newIds: ["r1-copy", "p2-copy"], delta: { x: 1000, y: 0 } });
    const values = (id: string) => {
      const el = b.el(id);
      if (el.kind !== "part") throw new Error(`${id} is a ${el.kind}`);
      return el.values;
    };
    expect([values("r1-copy"), values("p2-copy")]).toEqual([{ voltage: 120, load_va: 180 }, { panel_name: "P2" }]);
    expect([values("r1"), values("p2")]).toEqual([{ voltage: 120, load_va: 180, circuit: "P1-1" }, { panel_name: "P2", fed_from: "MDP" }]);
  });
});
