/**
 * @jest-environment node
 *
 * Round 13 lane A13a: moving the building classes into the Architecture
 * add-on changes no stored byte and no id. On the stored fixtures (round
 * 8b changesets, the demo, the heavy model, full-BIM XS), every stored
 * class id still names a class, opening a model rewrites no record, and the
 * upgrade on edit recognises each building kind as the class round 12
 * wrote (frozen table below).
 *
 * Fails on round 12's code: nothing; it is the equivalence the move keeps,
 * and fails on a move that drops a class or changes a recognised id.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson, recomputeDerived, type BimElement, type ModelState } from "../src";
import { activeClassRegistry } from "../src/registry";
import { isCoreElement } from "../src/elements/feature";
import { builtinClassOf } from "../src/elements/recognise";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";

interface Fixture {
  readonly scenario: string;
  readonly head: ModelState;
}

const DIR = path.join(__dirname, "fixtures", "stored-changesets");
const STORED = ["r1-demo", "r2-demo-edited", "r3-heavy", "r5-fullbim-xs", "r8-shared-tree"] as const;
const FIXTURES: readonly Fixture[] = STORED.map((name) => JSON.parse(readFileSync(path.join(DIR, `${name}.json`), "utf8")) as Fixture);

/** What round 12's upgrade wrote for each building kind (openings by type; a footing component is the Structural class). */
function round12Class(el: BimElement): string | null {
  switch (el.kind) {
    case "wall":
      return "arch.wall";
    case "slab":
      return "arch.slab";
    case "room":
      return "arch.room";
    case "opening":
      return el.openingType === "door" ? "arch.door" : el.openingType === "window" ? "arch.window" : null;
    case "component":
      return el.category === "footing" ? "struct.footing" : "arch.component";
    case "grid":
      return "struct.grid";
    case "column":
      return "struct.column";
    case "beam":
      return "struct.beam";
    default:
      return null;
  }
}

describe("a13a old models open identically", () => {
  it.each(FIXTURES.map((f) => [f.scenario, f] as const))("%s: stored class ids resolve, opening rewrites nothing, recognition matches round 12", (_name, f) => {
    const registry = activeClassRegistry();
    const els = Object.values(f.head.elements);
    for (const el of els) if (isCoreElement(el) && el.classId !== undefined) expect([el.id, registry.getClass(el.classId)?.id]).toEqual([el.id, el.classId]);
    const opened = recomputeDerived(f.head).model;
    const stored = (m: ModelState) => canonicalJson(Object.fromEntries(Object.entries(m.elements).map(([id, el]) => [id, isCoreElement(el) ? { classId: el.classId, classSource: el.classSource, typeId: el.typeId } : null])));
    expect(stored(opened)).toBe(stored(f.head));
    for (const el of els) {
      if (!isCoreElement(el)) continue;
      const { classId: _c, classSource: _s, ...bare } = el;
      expect([el.id, builtinClassOf(bare)]).toEqual([el.id, round12Class(el)]);
    }
  });

  it("full-BIM XS: every wall, slab, door, window, room and component is recognised as round 12 recognised it", () => {
    const head = createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "a13a-old" });
    const kinds = new Set<string>();
    for (const el of Object.values(head.elements)) {
      if (!isCoreElement(el)) continue;
      expect([el.id, builtinClassOf(el)]).toEqual([el.id, round12Class(el)]);
      kinds.add(el.kind);
    }
    expect([...kinds].sort()).toEqual(expect.arrayContaining(["opening", "slab", "wall"]));
  });
});
