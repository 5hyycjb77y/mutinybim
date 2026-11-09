/**
 * @jest-environment node
 *
 * The perf gate's synthetic distribution is built as elements, not commands.
 * Replaying it as the commands a person would send (place every part, make
 * every circuit and feeder) must give the same parts, links and back-links,
 * a valid model, and the same reports.
 */
import { DEFAULT_SETTINGS, executeCommand, validateModel, type BimElement, type Command, type ModelState } from "@permitzip/bim-kernel";
import { CONNECTED_LOAD_ONLY, ElectricalLoadEngine, syntheticDistribution } from "@permitzip/bim-pack-electrical";

function replay(elements: Readonly<Record<string, BimElement>>): ModelState {
  let m: ModelState = { modelId: "syn", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const run = (c: Command) => {
    const r = executeCommand(m, c);
    if (!r.ok) throw new Error(`${c.type}: ${r.error.message}`);
    m = r.model;
  };
  const all = Object.values(elements);
  const level = all.find((e) => e.kind === "level");
  if (level?.kind !== "level") throw new Error("level");
  run({ type: "create_level", levelId: level.id, name: level.name, elevationMm: level.elevationMm });
  const placedTypes = new Set<string>();
  for (const el of all) {
    if (el.kind !== "part") continue;
    const type = elements[el.typeId];
    if (type?.kind !== "part_type") throw new Error(`type of ${el.id}`);
    run({ type: "place_part", partId: el.id, typeId: el.typeId, ...(placedTypes.has(el.typeId) ? {} : { partType: type.definition }), levelId: level.id, position: el.position, mark: el.mark, values: el.values });
    placedTypes.add(el.typeId);
  }
  for (const el of all) {
    if (el.kind !== "service_link") continue;
    run({ type: "create_service_link", linkId: el.id, sourceId: el.source.elementId, positions: [...el.source.positions], members: el.members.map((x) => ({ elementId: x.elementId, connector: x.connector })), description: el.description, ...(el.electrical ? { electrical: el.electrical } : {}) });
  }
  return m;
}

const shape = (el: BimElement | undefined) => {
  if (el?.kind === "part") return { kind: el.kind, typeId: el.typeId, values: el.values, mark: el.mark, feeds: el.feeds, served: el.served };
  if (el?.kind === "service_link") return { kind: el.kind, trade: el.trade, role: el.role, source: el.source, members: el.members, description: el.description, electrical: el.electrical };
  return el?.kind;
};

describe("synthetic distribution", () => {
  const syn = syntheticDistribution({ floors: 1, zonesPerFloor: 2 });
  const model: ModelState = { modelId: "syn", revision: 0 as ModelState["revision"], elements: syn.elements, connections: [], settings: DEFAULT_SETTINGS };

  it("is what the commands write: same parts, links and back-links, and a valid model", () => {
    const byCommands = replay(syn.elements);
    for (const id of Object.keys(syn.elements)) expect([id, shape(syn.elements[id])]).toEqual([id, shape(byCommands.elements[id])]);
    expect(validateModel(model)).toEqual([]);
    expect(syn.counts).toEqual({ distribution: 1 + 1 + 2 * 3, loads: 2 * 427, links: 1 + 2 * (3 + 61) });
  });

  it("reports the same at every node either way", () => {
    const byCommands = replay(syn.elements);
    const a = new ElectricalLoadEngine(CONNECTED_LOAD_ONLY);
    const b = new ElectricalLoadEngine(CONNECTED_LOAD_ONLY);
    const ids = a.distribution(model);
    expect(ids).toEqual(b.distribution(byCommands));
    for (const id of ids) {
      const x = a.report(model, id);
      const y = b.report(byCommands, id);
      expect([id, x?.connectedVa, x?.perPhase, x?.demand.sizingVa, x?.capacity.reason]).toEqual([id, y?.connectedVa, y?.perPhase, y?.demand.sizingVa, y?.capacity.reason]);
    }
    // Per zone: 240 x 40 + 3 x 15,000 + 180 x 180 + 4 x 1,500 = 93,000 VA.
    expect(a.report(model, syn.mdpId)?.connectedVa).toBeCloseTo(2 * 93_000, 6);
  });
});
