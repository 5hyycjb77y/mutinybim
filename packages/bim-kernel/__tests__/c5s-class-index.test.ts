/**
 * @jest-environment node
 *
 * Round 5c f-scale (audit H-8): the class index is carried across an edit
 * instead of rebuilt. After random edit sequences (elements written, added,
 * removed; part types edited so parts change class without being touched;
 * committed heads and unconfirmed predictions), the carried index lists
 * exactly what a full recognition of that revision lists, in model order.
 *
 * Fails on the old code: `carryClassIndexes` didn't exist, and every new
 * element record paid a full pass (`elementValues` over the model) on its
 * first read.
 */
import * as store from "../src/store";
import {
  asElementId,
  builtinPartType,
  builtinRegistryBuilder,
  buildClassIndex,
  carryClassIndexes,
  executeCommand,
  recognizes,
  type BimElement,
  type ClassId,
  type Command,
  type ModelState,
  type Registry,
} from "../src";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";

jest.mock("../src/store", () => {
  const actual: typeof import("../src/store") = jest.requireActual("../src/store");
  return { ...actual, elementValues: jest.fn(actual.elementValues) };
});
const elementValuesSpy = store.elementValues as jest.MockedFunction<typeof store.elementValues>;

type Elements = ModelState["elements"];

const RTU = builtinPartType("builtin:rtu-5-ton@1");
const PANEL = builtinPartType("builtin:panelboard-225-480@1");

function run(m: ModelState, c: Command): ModelState {
  const r = executeCommand(m, c);
  if (!r.ok) throw new Error(`${c.type}: ${r.error.message}`);
  return r.model;
}

function baseModel(): ModelState {
  if (!RTU || !PANEL) throw new Error("starter library is missing a type");
  let m = createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "c5s-classes" });
  m = { ...m, elements: store.freezeElements(m.elements) };
  m = run(m, { type: "create_level", levelId: "lvl-1", name: "L01", elevationMm: 0 });
  for (let i = 0; i < 12; i++) {
    const t = i % 2 === 0 ? RTU : PANEL;
    m = run(m, { type: "place_part", partId: `p-${i}`, typeId: t.id, partType: t.definition, levelId: "lvl-1", position: { x: i * 3000, y: 0 }, offsetMm: 0, mark: i % 3 === 0 ? `X-${i}` : `P-${i}` });
  }
  return m;
}

/** The built-ins plus a class read from a type value (a part type's edit moves parts in or out) and a conditions-only class (any kind). */
function testRegistry(): Registry {
  if (!RTU) throw new Error("starter library is missing the RTU");
  return builtinRegistryBuilder()
    .addClass({ id: "test.tagged_unit", label: "Tagged units", discipline: "mechanical", parent: "mep.equipment", recognize: { partCategories: [RTU.definition.category], where: [{ path: "type.param.c5s_tag", op: "present" }] }, source: "library:c5s@1" })
    .addClass({ id: "test.marked_x", label: "Marked X", discipline: "general", recognize: { where: [{ path: "mark", op: "contains", value: "X-" }] }, source: "library:c5s@1" })
    .build();
}

/** Full recognition of one revision, class by class, with no cache: the reference. */
function reference(registry: Registry, elements: Elements) {
  const all = store.elementValues(elements);
  const classes = registry.listClasses().filter((c) => c.recognize);
  const direct = new Map<ClassId, Set<string>>();
  for (const cls of classes) direct.set(cls.id, new Set(all.filter((el) => recognizes(cls, el, elements)).map((el) => el.id)));
  return {
    elementsOf: (id: ClassId, withSub: boolean) => {
      const wanted = withSub ? registry.descendants(id) : [id];
      return all.filter((el) => wanted.some((c) => direct.get(c)?.has(el.id))).map((el) => el.id);
    },
    classesOf: (id: string) => classes.filter((c) => direct.get(c.id)?.has(id)).map((c) => c.id),
  };
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function pick<T>(r: () => number, xs: readonly T[]): T {
  const x = xs[Math.floor(r() * xs.length)];
  if (x === undefined) throw new Error("empty pick");
  return x;
}

/** One random edit on a copy of `from`: the new record (a committed head or a prediction) and the ids it changed. */
function randomEdit(r: () => number, from: Elements, step: number): { to: Elements; changed: string[] } {
  const draft = store.draftElements(from);
  const changed: string[] = [];
  const all = store.elementValues(from);
  const edits = 1 + Math.floor(r() * 3);
  for (let e = 0; e < edits; e++) {
    const op = r();
    const el = pick(r, all);
    if (op < 0.35) {
      // Write: a door becomes a window, a part changes mark, anything else is rewritten as a new object.
      const next: BimElement =
        el.kind === "opening" ? { ...el, openingType: el.openingType === "door" ? "window" : "door" } : el.kind === "part" ? { ...el, mark: el.mark.startsWith("X-") ? `P-${step}` : `X-${step}` } : { ...el };
      draft[el.id] = next;
      changed.push(el.id);
    } else if (op < 0.55) {
      if (el.kind === "part_type" || el.kind === "level") continue;
      delete draft[el.id];
      changed.push(el.id);
    } else if (op < 0.8) {
      const parts = store.elementsOfKind(from, "part");
      const source = pick(r, parts);
      const id = asElementId(`added-${step}-${e}`);
      draft[id] = { ...source, id, mark: r() < 0.5 ? `X-${step}` : `P-${step}` };
      changed.push(id);
    } else {
      // A part type gains or loses the value a class reads: its parts change class, untouched.
      const types = store.elementsOfKind(from, "part_type");
      const t = pick(r, types);
      const values = { ...t.definition.typeValues };
      if ("c5s_tag" in values) delete values.c5s_tag;
      else values.c5s_tag = "on";
      draft[t.id] = { ...t, definition: { ...t.definition, typeValues: values } };
      changed.push(t.id);
    }
  }
  return { to: step % 2 === 0 ? store.freezeElements(draft) : draft, changed };
}

function expectEquivalent(registry: Registry, elements: Elements, ids: readonly string[]) {
  const index = buildClassIndex(registry, { elements });
  const ref = reference(registry, elements);
  for (const cls of registry.listClasses()) {
    for (const withSub of [true, false]) {
      const got = index.elementsOf(cls.id, { includeSubclasses: withSub }).map((el) => el.id);
      expect({ cls: cls.id, withSub, ids: got }).toEqual({ cls: cls.id, withSub, ids: ref.elementsOf(cls.id, withSub) });
    }
  }
  for (const id of ids) expect({ id, classes: index.classesOf(asElementId(id)) }).toEqual({ id, classes: ref.classesOf(id) });
}

describe("c5s class index carried across edits", () => {
  it("random edit sequences: the carried index equals a full recognition of every revision", () => {
    const base = baseModel();
    for (const seed of [1, 7, 42]) {
      const r = rng(seed);
      const registry = testRegistry();
      let elements = base.elements;
      const classes = registry.listClasses().map((c) => c.id);
      // Some classes read before the edits, so their lists are carried; the rest are listed fresh.
      const index0 = buildClassIndex(registry, { elements });
      for (const c of classes) if (r() < 0.5) index0.elementsOf(c, { includeSubclasses: r() < 0.5 });
      for (let step = 0; step < 25; step++) {
        const { to, changed } = randomEdit(r, elements, step);
        carryClassIndexes(elements, to, changed);
        const sample = [...changed, ...store.elementsOfKind(to, "part").slice(0, 6).map((p) => p.id), ...store.elementsOfKind(to, "opening").slice(0, 4).map((o) => o.id)];
        if (step % 5 === 4) expectEquivalent(registry, to, sample);
        else {
          const index = buildClassIndex(registry, { elements: to });
          for (const c of classes) if (r() < 0.4) index.elementsOf(c, { includeSubclasses: r() < 0.5 });
        }
        elements = to;
      }
      expectEquivalent(registry, elements, store.elementsOfKind(elements, "part").map((p) => p.id));
    }
  });

  it("commands: carried with the result's changed and removed ids, as the command core does", () => {
    if (!RTU) throw new Error("starter library is missing the RTU");
    const registry = testRegistry();
    let m = baseModel();
    buildClassIndex(registry, m).elementsOf("mep.equipment");
    buildClassIndex(registry, m).elementsOf("test.marked_x");
    const commands: Command[] = [
      { type: "move_elements", ids: ["p-0"], delta: { x: 300, y: 0 } },
      { type: "place_part", partId: "p-new", typeId: RTU.id, partType: RTU.definition, levelId: "lvl-1", position: { x: 0, y: 9000 }, offsetMm: 0, mark: "X-new" },
      { type: "delete_elements", ids: ["p-3"], policy: "cascade" },
    ];
    for (const c of commands) {
      const res = executeCommand(m, c);
      if (!res.ok) throw new Error(`${c.type}: ${res.error.message}`);
      carryClassIndexes(m.elements, res.model.elements, [...res.changedIds, ...res.removedIds]);
      expectEquivalent(registry, res.model.elements, ["p-0", "p-3", "p-new"]);
      m = res.model;
    }
  });

  it("through executeCommand alone (the command core carries): random command sequences equal a full recognition, with no pass on read", () => {
    if (!RTU || !PANEL) throw new Error("starter library is missing a type");
    for (const seed of [2, 13, 404]) {
      const r = rng(seed);
      const registry = testRegistry();
      let m = baseModel();
      const index0 = buildClassIndex(registry, m);
      for (const c of registry.listClasses()) if (r() < 0.6) index0.elementsOf(c.id);
      let compared = 0;
      for (let step = 0; step < 20; step++) {
        const parts = store.elementsOfKind(m.elements, "part").map((p) => p.id);
        const roll = r();
        const type = r() < 0.5 ? RTU : PANEL;
        const command: Command =
          roll < 0.4 || parts.length < 3
            ? { type: "place_part", partId: `cmd-${seed}-${step}`, typeId: type.id, partType: type.definition, levelId: "lvl-1", position: { x: step * 2000, y: 6000 }, offsetMm: 0, mark: r() < 0.5 ? `X-c${step}` : `P-c${step}` }
            : roll < 0.75
              ? { type: "move_elements", ids: [pick(r, parts)], delta: { x: 250, y: 0 } }
              : { type: "delete_elements", ids: [pick(r, parts)], policy: "cascade" };
        const res = executeCommand(m, command);
        if (!res.ok) continue;
        m = res.model;
        if (step % 3 === 2) {
          elementValuesSpy.mockClear();
          const index = buildClassIndex(registry, m);
          for (const c of registry.listClasses()) if (r() < 0.5) index.elementsOf(c.id, { includeSubclasses: r() < 0.5 });
          // Only the conditions-only class reads every element; the rest come from the kind index.
          expect(elementValuesSpy.mock.calls.length).toBeLessThanOrEqual(2);
          expectEquivalent(registry, m.elements, store.elementsOfKind(m.elements, "part").map((p) => p.id));
          compared += 1;
        }
      }
      expect(compared).toBeGreaterThan(4);
    }
  });

  it("a carried revision's first read makes no pass over the model", () => {
    const registry = builtinRegistryBuilder().build();
    const m = baseModel();
    const before = buildClassIndex(registry, m);
    before.elementsOf("mep.equipment");
    before.elementsOf("arch.door");
    const res = executeCommand(m, { type: "move_elements", ids: ["p-1"], delta: { x: 300, y: 0 } });
    if (!res.ok) throw new Error(res.error.message);
    carryClassIndexes(m.elements, res.model.elements, [...res.changedIds, ...res.removedIds]);
    elementValuesSpy.mockClear();
    const after = buildClassIndex(registry, res.model);
    expect(after.elementsOf("arch.door")).toBe(before.elementsOf("arch.door"));
    expect(after.elementsOf("mep.equipment").map((e) => e.id)).toContain("p-1");
    expect(after.classesOf(asElementId("p-1")).length).toBeGreaterThan(0);
    expect(elementValuesSpy).not.toHaveBeenCalled();
  });
});
