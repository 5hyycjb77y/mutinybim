/**
 * @jest-environment node
 *
 * Round 8 lane S: the model-state binder decides "this model has no setup
 * record" from the store's kind index, not the organization view. Before,
 * every read under `withModelStatePacks` on a head no command produced (just
 * loaded, or an applied changeset) built the organization view and with it
 * the partition index: a pass over every element, 13 ms at the tower. Fails on
 * that code: the counted reads below include every element's partition.
 */
import { DEFAULT_SETTINGS, draftElements, elementsOfKind, executeCommand, freezeElements, installModelSetupHost, modelSetupOf, organizationOf, requirementsAt, withUpgradePolicy, type BimElement, type Command, type ModelState } from "../src";
import { createFullBimModel } from "@permitzip/bim-first-party/seed";
import { withModelStatePacks, type PackPin } from "../src/packs";

const MODEL = { kind: "model", id: null } as const;

function run(m: ModelState, c: Command): ModelState {
  const r = withUpgradePolicy(() => true, () => executeCommand(m, c));
  if (!r.ok) throw new Error(`${c.type}: ${r.error.message}`);
  return r.model;
}

/** The setup the organization view gives (the binder's answer before this change). */
function fromOrganization(model: ModelState): { hasEntries: boolean; pins: readonly PackPin[]; key: string } {
  const org = organizationOf(model);
  const hasEntries = [...org.stored.values()].some((r) => r.entry.type === "addon" || r.entry.type === "discipline");
  const pins = model.settings.packs ?? [];
  return { hasEntries, pins, key: hasEntries ? "(entries)" : pins.length === 0 ? "" : JSON.stringify([pins.map((p) => `${p.id}@${p.version}`), []]) };
}

let reads = 0;
let partitionReads = 0;
/** Elements whose property reads are counted. */
function counted(elements: Readonly<Record<string, BimElement>>): Record<string, BimElement> {
  const out: Record<string, BimElement> = {};
  for (const [id, el] of Object.entries(elements)) {
    out[id] = new Proxy(el, {
      get(target, key, receiver) {
        reads += 1;
        if (key === "partition") partitionReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
  }
  return out;
}

let uninstall: () => void = () => undefined;
beforeAll(() => {
  uninstall = installModelSetupHost(() => []);
});
afterAll(() => uninstall());

describe("s8 setup fast path: same answer as the organization view", () => {
  const empty: ModelState = { modelId: "s8-eq", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const level = run(empty, { type: "create_level", levelId: "lvl-1", name: "L1", elevationMm: 0 });
  const pinned: ModelState = { ...level, settings: { ...level.settings, packs: [{ id: "electrical", version: "1.0.0" }] } };
  const grouped = run(level, { type: "create_group", groupId: "grp-a", name: "Phase A" });

  it.each([
    ["no records", empty],
    ["a level", level],
    ["settings pins only", pinned],
    ["an organization record that is not setup", grouped],
  ])("%s: no setup entries, the same pins and key", (_label, model) => {
    const ref = fromOrganization(model);
    const fresh: ModelState = { ...model, elements: freezeElements({ ...model.elements }) };
    for (const m of [model, fresh]) {
      const setup = modelSetupOf(m);
      expect(setup.hasEntries).toBe(false);
      expect(ref.hasEntries).toBe(false);
      expect(setup.pins).toEqual(ref.pins);
      expect(setup.key).toBe(ref.key);
    }
  });

  it("a stored setup record still goes through the organization view, on the head and on a fresh copy", () => {
    const on = run(level, { type: "pin_firm_discipline", discipline: { id: "firm:low_voltage", label: "Low voltage", parent: "electrical", display: { colour: "#7c3aed" } } });
    expect(fromOrganization(on).hasEntries).toBe(true);
    const fresh: ModelState = { ...on, elements: freezeElements({ ...on.elements }) };
    expect(modelSetupOf(on)).toEqual(modelSetupOf(fresh));
    expect(modelSetupOf(fresh).hasEntries).toBe(true);
    expect(modelSetupOf(fresh).firmDisciplines.map((d) => d.id)).toEqual(["firm:low_voltage"]);
  });

  it("the carry to the next revision drops the answer when a command writes an organization record", () => {
    const before = modelSetupOf(level);
    expect(before.hasEntries).toBe(false);
    const on = run(level, { type: "pin_firm_discipline", discipline: { id: "firm:low_voltage", label: "Low voltage", parent: "electrical", display: { colour: "#7c3aed" } } });
    expect(modelSetupOf(on).hasEntries).toBe(true);
    const later = run(on, { type: "create_level", levelId: "lvl-2", name: "L2", elevationMm: 3000 });
    expect(modelSetupOf(later).hasEntries).toBe(true);
  });
});

describe("s8 setup fast path: a fresh head's first graph query does not scan the model for the binder", () => {
  const base0 = createFullBimModel({ floors: 2, zonesPerFloor: 2, modelId: "s8-visits" });
  const base: ModelState = { ...base0, elements: freezeElements(counted(base0.elements)) };
  const n = Object.keys(base.elements).length;
  // The session's earlier revision: its kind index is built.
  elementsOfKind(base.elements, "organization");
  requirementsAt(base, MODEL);

  function applied(): ModelState {
    const draft = draftElements(base.elements);
    const id = "lvl-ground" in draft ? "lvl-ground" : (Object.keys(draft)[1] as string);
    const el = draft[id];
    if (el) draft[id] = { ...el };
    return { ...base, revision: (base.revision + 1) as ModelState["revision"], elements: freezeElements(draft) };
  }

  it("an applied changeset's head: the binder reads one chunk, not the model", () => {
    expect(n).toBeGreaterThan(10_000);
    const head = applied();
    reads = 0;
    partitionReads = 0;
    withModelStatePacks(head, () => 1);
    expect(partitionReads).toBe(0);
    expect(reads).toBeLessThan(2_100); // the written element's chunk (1,024) re-indexed by kind
  });

  it("an applied changeset's head: the first graph query reads no more with the binder than without it", () => {
    const withBinder = applied();
    reads = 0;
    requirementsAt(withBinder, MODEL);
    const readsWith = reads;
    uninstall();
    try {
      const without = applied();
      reads = 0;
      requirementsAt(without, MODEL);
      expect(readsWith).toBeLessThanOrEqual(reads + 2_100);
      expect(readsWith).toBeLessThan(n);
    } finally {
      uninstall = installModelSetupHost(() => []);
    }
  });

  it("a just-loaded head: the binder reads each element's kind at most, never its partition", () => {
    const head: ModelState = { ...base, elements: freezeElements({ ...base.elements }) };
    reads = 0;
    partitionReads = 0;
    withModelStatePacks(head, () => 1);
    expect(partitionReads).toBe(0);
    // One kind read per element, plus the few organization records' own fields.
    expect(reads).toBeLessThanOrEqual(n + 512);
  });
});
