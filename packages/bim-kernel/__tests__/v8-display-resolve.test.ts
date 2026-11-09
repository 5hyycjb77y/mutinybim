/**
 * @jest-environment node
 *
 * Round 8 lane V (view.visibility.resolve at 1M on the model server's load).
 * Rows parsed from storage carry their own copy of every long kind string, so
 * every kind test read a separate scattered string per element. Indexing a
 * plain record now points each element's kind at one shared copy. The display
 * of every element must be exactly what it was, and the record must read and
 * serialise exactly as it did.
 */
import {
  DEFAULT_GROUP_ID,
  displayResolver,
  elementSlots,
  elementValues,
  executeCommand,
  isOrganized,
  plainElements,
  type BimElement,
  type Command,
  type DisplayContext,
  type ElementDisplay,
  type ModelState,
} from "../src";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";
import { sharedKind } from "../src/kind-share";

function run(model: ModelState, command: Command): ModelState {
  const r = executeCommand(model, command);
  if (!r.ok) throw new Error(`${command.type} refused: ${r.error.message}`);
  return r.model;
}

/** The same model as the model server boots it: one JSON row per element, then one record. */
function asStorageRows(model: ModelState): ModelState {
  const { elements, connections, ...header } = model;
  const rows = elementValues(elements).map((el) => JSON.stringify(el));
  const parsed = rows.map((row) => JSON.parse(row) as BimElement);
  return { ...(JSON.parse(JSON.stringify(header)) as Omit<ModelState, "elements" | "connections">), elements: Object.fromEntries(parsed.map((el) => [el.id, el])), connections: JSON.parse(JSON.stringify(connections)) as ModelState["connections"] };
}

/** Group and phase overrides on a third each of the organized elements, as the perf row sets them up. */
function organize(model: ModelState): ModelState {
  const organized = Object.keys(model.elements).filter((id) => {
    const el = model.elements[id];
    return el !== undefined && isOrganized(el);
  });
  const third = Math.floor(organized.length / 3);
  const grouped = run(model, { type: "assign_elements_to_group", ids: organized.slice(0, third), groupId: "grp-coordination" });
  return run(grouped, { type: "set_element_phases", ids: organized.slice(third, 2 * third), phaseCreated: "phase-existing", phaseDemolished: "phase-new" });
}

const CONTEXTS: readonly DisplayContext[] = [
  {},
  { phaseId: "phase-new", phaseFilterId: "pf-existing-demo", groupDisplay: { "grp-coordination": "hide" } },
  { phaseId: "phase-existing", groupDisplay: { "grp-coordination": "halftone" } },
  { phaseId: "phase-new", phaseFilterId: "pf-existing-demo", groupDisplay: { [DEFAULT_GROUP_ID]: "halftone" } },
  { phaseId: "phase-new", phaseFilterId: "pf-new" },
];

function displays(model: ModelState, ctx: DisplayContext): Array<{ id: string } & ElementDisplay> {
  const show = displayResolver(model, ctx);
  return elementValues(model.elements).map((el) => ({ id: el.id, ...show(el) }));
}

describe("v8 display resolve on rows parsed from storage", () => {
  const generated = organize(createFullBimModel(FULL_BIM_TIERS.XS));
  const loaded = organize(asStorageRows(createFullBimModel(FULL_BIM_TIERS.XS)));

  it("resolves every element exactly as the generated model does, in every view setting", () => {
    const all = elementValues(loaded.elements);
    expect(all.some((el) => el.kind === "tag")).toBe(true);
    expect(all.some((el) => el.kind.length > 10)).toBe(true);
    const seen = { hidden: 0, halftone: 0, dashed: 0 };
    for (const ctx of CONTEXTS) {
      const a = displays(generated, ctx);
      for (const d of a) {
        if (!d.visible) seen.hidden++;
        else if (d.dashed) seen.dashed++;
        else if (d.halftone) seen.halftone++;
      }
      expect(displays(loaded, ctx)).toEqual(a);
    }
    expect(seen.hidden).toBeGreaterThan(0);
    expect(seen.halftone).toBeGreaterThan(0);
    expect(seen.dashed).toBeGreaterThan(0);
  });

  it("leaves the record reading and serialising exactly as it did", () => {
    const rows = asStorageRows(createFullBimModel(FULL_BIM_TIERS.XS));
    const before = JSON.stringify(rows.elements);
    elementSlots(rows.elements);
    expect(JSON.stringify(plainElements(rows.elements))).toBe(before);
    expect(JSON.stringify(rows.elements)).toBe(before);
  });

  it("points each parsed element's kind at the shared copy when the record is indexed, once", () => {
    const rows = asStorageRows(createFullBimModel(FULL_BIM_TIERS.XS));
    const writes = new Map<string, number>();
    for (const el of Object.values(rows.elements)) {
      let kind: string = el.kind;
      Object.defineProperty(el, "kind", {
        enumerable: true,
        configurable: true,
        get: () => kind,
        set: (next: string) => {
          expect(next).toBe(kind);
          kind = next;
          writes.set(el.id, (writes.get(el.id) ?? 0) + 1);
        },
      });
    }
    expect(writes.size).toBe(0);
    elementSlots(rows.elements);
    const ids = Object.keys(rows.elements);
    expect(writes.size).toBe(ids.length);
    for (const id of ids) expect(writes.get(id)).toBe(1);
  });

  it("leaves a frozen element as it is and still resolves it", () => {
    const rows = asStorageRows(createFullBimModel(FULL_BIM_TIERS.XS));
    const frozen = Object.values(rows.elements).find((el) => isOrganized(el));
    if (!frozen) throw new Error("XS has no organized element");
    Object.freeze(frozen);
    const ctx = CONTEXTS[1] ?? {};
    const model = organize(rows);
    expect(displays(model, ctx)).toEqual(displays(generated, ctx));
  });

  it("shares one value per kind and never changes it", () => {
    for (const kind of ["duct_segment", "run_segment", "air_terminal", "tag", "x".repeat(40)]) {
      const fresh = JSON.parse(JSON.stringify(kind)) as string;
      expect(sharedKind(fresh)).toBe(kind);
      expect(sharedKind(kind)).toBe(kind);
    }
  });
});
