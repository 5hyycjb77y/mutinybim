/**
 * @jest-environment node
 *
 * Round 6 lane Y (1M cold paths). The area index now walks the store's slots
 * with flat member arrays, connection ends are resolved once and shared by
 * the area and topology indexes, and view display reads annotation targets
 * without proxy traps. Each answer must equal the plain-record reference.
 */
import {
  DEFAULT_GROUP_ID,
  connectionEndSlots,
  displayResolver,
  draftElements,
  elementEntries,
  elementReader,
  elementSlots,
  elementValues,
  executeCommand,
  freezeElements,
  inInterest,
  isOrganized,
  partitionMembers,
  partitionOf,
  planCommit,
  plainElements,
  sliceModel,
  type BimElement,
  type Command,
  type DisplayContext,
  type ElementDisplay,
  type Interest,
  type ModelState,
  type Organization,
} from "../src";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";
import { groupIdOf, organizationOf, phaseCreatedOf, phaseDemolishedOf, viewPhaseFilterId, viewPhaseId } from "../src/organization/model";
import { networkOf } from "../src/network";

const actor = { id: "c6y", name: "Lane Y", kind: "human" as const };

function plainCopy(model: ModelState): ModelState {
  return structuredClone({ ...model, elements: plainElements(model.elements) });
}

function run(model: ModelState, command: Command): ModelState {
  const r = executeCommand(model, command);
  if (!r.ok) throw new Error(`${command.type} refused: ${r.error.message}`);
  return r.model;
}

function commit(model: ModelState, command: Command): ModelState {
  const d = planCommit(model, [], { idempotencyKey: `c6y-${command.type}-${model.revision}`, baseRevision: model.revision, actor, command }, () => "2026-10-30T00:00:00.000Z");
  if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
  return d.model;
}

/** What a slice must hold: every element inside the interest in key order, and every connection with both ends inside. */
function referenceSlice(model: ModelState, interest: Interest): { ids: string[]; connections: number[] } {
  const ids = elementEntries(model.elements)
    .filter(([, el]) => inInterest(partitionOf(el), interest))
    .map(([id]) => id);
  const held = new Set(ids);
  const connections: number[] = [];
  model.connections.forEach((c, i) => {
    if (held.has(c.a.elementId) && held.has(c.b.elementId)) connections.push(i);
  });
  return { ids, connections };
}

function sliceShape(model: ModelState, interest: Interest): { ids: string[]; connections: number[] } {
  const slice = sliceModel(model, interest);
  return { ids: Object.keys(slice.elements), connections: slice.connections.map((c) => model.connections.indexOf(c)) };
}

const INTERESTS: readonly Interest[] = [
  { areas: [{ level: "L02", zone: "Z2" }] },
  { areas: [{ level: "L01", zone: "Z1" }, { level: "L02", zone: "Z1" }] },
  { areas: [{ level: "L01" }] },
  { areas: [{ level: "L02" }], disciplines: ["mechanical"] },
];

describe("c6y area index on the store's slots", () => {
  const generated = createFullBimModel(FULL_BIM_TIERS.XS);
  const plain = plainCopy(generated);
  const frozen = commit(plainCopy(generated), { type: "create_level", levelId: "c6y-level", name: "C6Y", elevationMm: 9000 });
  const draft = run(plainCopy(generated), { type: "create_level", levelId: "c6y-draft-level", name: "C6Y draft", elevationMm: 9100 });

  it.each([
    ["a plain record (first join on a loaded head)", plain],
    ["a committed record that added an element (index carried)", frozen],
    ["a draft (a prediction)", draft],
  ])("slices %s exactly like the reference", (_name, model) => {
    for (const interest of INTERESTS) expect(sliceShape(model, interest)).toEqual(referenceSlice(model, interest));
  });

  it("lists partition members in element order, as the reference", () => {
    for (const model of [plain, frozen, draft]) {
      const members = partitionMembers(model, (p) => p.level === "L01" || p.level === "*").map((el) => el.id);
      const reference = elementValues(model.elements)
        .filter((el) => partitionOf(el).level === "L01" || partitionOf(el).level === "*")
        .map((el) => el.id);
      expect(members).toEqual(reference);
    }
  });

  it("resolves connection ends once: the topology index reads them from the area index's lookup", () => {
    const head = plainCopy(generated);
    sliceModel(head, INTERESTS[0]);
    const slotOf = elementSlots(head.elements).table.slotOf as Map<string, number>;
    let lookups = 0;
    const get = slotOf.get.bind(slotOf);
    Object.defineProperty(slotOf, "get", {
      configurable: true,
      value: (id: string) => {
        lookups += 1;
        return get(id);
      },
    });
    try {
      networkOf(head);
    } finally {
      Reflect.deleteProperty(slotOf, "get");
    }
    // Only taps' hosts and annotations' targets are looked up; before, every connection's two ends were too.
    const references = elementValues(head.elements).reduce((n, el) => n + (el.kind === "dimension" ? 2 : el.kind === "tap" || el.kind === "opening" || el.kind === "tag" ? 1 : 0), 0);
    expect(head.connections.length).toBeGreaterThan(0);
    expect(lookups).toBe(references);
  });
});

describe("c6y connectionEndSlots", () => {
  it("matches a lookup per end, is shared per slot layout, and is rebuilt for another layout", () => {
    const model = plainCopy(createFullBimModel(FULL_BIM_TIERS.XS));
    const slots = elementSlots(model.elements);
    const connections = [...model.connections, { ...model.connections[0]!, id: "c6y-ghost", a: { elementId: "c6y-missing", end: "out" as const } }];
    const ends = connectionEndSlots(connections, slots);
    connections.forEach((c, i) => {
      const at = (id: string): number => {
        const s = slots.table.slotOf.get(id);
        return s !== undefined && s < slots.size ? s : -1;
      };
      expect(ends.a[i]).toBe(at(c.a.elementId));
      expect(ends.b[i]).toBe(at(c.b.elementId));
    });
    expect(ends.a[connections.length - 1]).toBe(-1);
    expect(connectionEndSlots(connections, slots)).toBe(ends);
    const draft = draftElements(model.elements);
    draft["c6y-new"] = { ...(Object.values(model.elements)[0] as BimElement), id: "c6y-new" } as BimElement;
    const grown = elementSlots(freezeElements(draft));
    expect(grown.size).toBe(slots.size + 1);
    expect(connectionEndSlots(connections, grown)).not.toBe(ends);
  });
});

describe("c6y elementReader", () => {
  it("answers exactly as record[id] on committed, draft and plain records", () => {
    const model = plainCopy(createFullBimModel(FULL_BIM_TIERS.XS));
    const [firstId, secondId] = Object.keys(model.elements);
    if (!firstId || !secondId) throw new Error("model too small");
    const frozen = freezeElements(model.elements);
    const draft = draftElements(frozen);
    delete draft[firstId];
    draft["c6y-added"] = { ...(model.elements[secondId] as BimElement), id: "c6y-added" } as BimElement;
    for (const record of [model.elements, frozen, draft]) {
      const read = elementReader(record);
      for (const id of [firstId, secondId, "c6y-added", "c6y-missing", "toString", "__proto__", "constructor"]) expect(read(id)).toBe(record[id]);
    }
  });
});

/** The view display rule as it was before round 6, element by element through `model.elements`. */
function referenceResolver(model: ModelState, ctx: DisplayContext): (el: BimElement) => ElementDisplay {
  const org: Organization = organizationOf(model);
  const at = org.phaseIndex.get(viewPhaseId(org, ctx)) ?? Math.max(0, org.phases.length - 1);
  const statuses = org.filterById.get(viewPhaseFilterId(org, ctx))?.entry.statuses;
  const own = (el: BimElement): ElementDisplay => {
    if (!isOrganized(el)) return { visible: true, halftone: false, dashed: false };
    const group = ctx.groupDisplay?.[groupIdOf(org, el)] ?? org.groupById.get(groupIdOf(org, el))?.entry.defaultVisibility ?? "show";
    if (group === "hide") return { visible: false, halftone: false, dashed: false };
    const created = org.phaseIndex.get(phaseCreatedOf(org, el)) ?? at;
    const demolishedId = phaseDemolishedOf(org, el);
    const demolished = demolishedId === null ? undefined : org.phaseIndex.get(demolishedId);
    if (created > at || (demolished !== undefined && demolished < at)) return { visible: false, halftone: false, dashed: false };
    const status = demolished === at ? (created === at ? "temporary" : "demolished") : created === at ? "new" : "existing";
    const phase = statuses?.[status] ?? "show";
    if (phase === "hide") return { visible: false, halftone: false, dashed: false };
    return { visible: true, halftone: group === "halftone" || phase === "halftone", dashed: phase === "dashed" };
  };
  return (el) => {
    if (el.kind === "tag") {
      const target = model.elements[el.targetId];
      return target ? own(target) : { visible: true, halftone: false, dashed: false };
    }
    if (el.kind === "dimension") {
      const a = model.elements[el.aId];
      const b = model.elements[el.bId];
      const da = a ? own(a) : { visible: true, halftone: false, dashed: false };
      const db = b ? own(b) : { visible: true, halftone: false, dashed: false };
      return { visible: da.visible && db.visible, halftone: da.visible && db.visible && da.halftone && db.halftone, dashed: false };
    }
    return own(el);
  };
}

describe("c6y view display", () => {
  const plain = plainCopy(createFullBimModel(FULL_BIM_TIERS.XS));
  const organized = Object.keys(plain.elements).filter((id) => {
    const el = plain.elements[id];
    return el !== undefined && isOrganized(el);
  });
  const third = Math.floor(organized.length / 3);
  const grouped = run(plain, { type: "assign_elements_to_group", ids: organized.slice(0, third), groupId: "grp-coordination" });
  const phased = run(grouped, { type: "set_element_phases", ids: organized.slice(third, 2 * third), phaseCreated: "phase-existing", phaseDemolished: "phase-new" });
  const committed = commit(plainCopy(phased), { type: "assign_elements_to_group", ids: organized.slice(2 * third, 2 * third + 5), groupId: DEFAULT_GROUP_ID });
  const contexts: readonly DisplayContext[] = [
    {},
    { phaseId: "phase-new", phaseFilterId: "pf-existing-demo", groupDisplay: { "grp-coordination": "hide" } },
    { phaseId: "phase-existing", groupDisplay: { "grp-coordination": "halftone" } },
    { phaseId: "phase-new", phaseFilterId: "pf-existing-demo", groupDisplay: { [DEFAULT_GROUP_ID]: "halftone" } },
  ];

  it.each([
    ["a draft", phased],
    ["a committed record", committed],
    ["a plain record", plainCopy(phased)],
  ])("resolves every element of %s as the reference does", (_name, model) => {
    const all = elementValues(model.elements);
    expect(all.some((el) => el.kind === "tag")).toBe(true);
    for (const ctx of contexts) {
      const show = displayResolver(model, ctx);
      const reference = referenceResolver(model, ctx);
      for (const el of all) expect({ id: el.id, ...show(el) }).toEqual({ id: el.id, ...reference(el) });
    }
  });
});
