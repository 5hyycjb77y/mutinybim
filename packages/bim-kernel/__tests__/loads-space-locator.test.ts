/**
 * @jest-environment node
 *
 * The requirements engine reads spaces through the spaces module's locator,
 * which answers for one record (`modelSpaceLocator(elements)`), so the engine
 * must take a locator per record and ask the new one after every edit. And a
 * space drawn around equipment that is already there must claim that
 * equipment's loads, so the estimate on it then counts the larger of the two.
 *
 * On the old engine (one fixed locator object): a function locator is never
 * called, so the device stays outside every space (the first case fails), and
 * a device derived before its space existed is never re-derived when the space
 * is drawn (the second case reads actual 0).
 */
import { RequirementsEngine, asElementId, fixedSpaceLocator, freezeElements, type BimElement, type ElementId, type LoadPointElement, type ModelState, type Space } from "../src";
import { Building } from "./fixtures/electrical-building";

const SPACE = asElementId("sp-kitchen");
const space: Space = { id: SPACE, kind: "space", version: 1, authoredRev: {}, number: "101", name: "Kitchen", levelId: asElementId("lvl-1"), bounds: { kind: "none" }, origin: { kind: "typed" } };
const load = (id: string, rest: Omit<LoadPointElement, "id" | "kind" | "version" | "authoredRev" | "connectionType">): LoadPointElement => ({ id: asElementId(id), kind: "load_point", version: 1, authoredRev: {}, connectionType: "", ...rest });
const estimate = load("est-kitchen", { anchor: { kind: "space", id: SPACE }, values: { va: 2000 } });
const fryer = load("dev-fryer", { anchor: { kind: "part", partId: asElementId("fryer") }, values: { va: 15000 } });

/** Stands in for geometry: the fryer is inside the kitchen whenever the kitchen exists in that record. */
const perRecord = (elements: Readonly<Record<string, BimElement>>) =>
  fixedSpaceLocator(elements[SPACE] ? { spaceOf: { fryer: SPACE }, measures: { [SPACE]: { areaSqM: 93, occupants: 0 } } } : {});

function base(): ModelState {
  const b = new Building();
  b.place("fryer", "kitchen", {}, "FRYER");
  return b.head;
}

function withElements(m: ModelState, add: readonly BimElement[]): ModelState {
  return { ...m, revision: (m.revision + 1) as ModelState["revision"], elements: freezeElements({ ...m.elements, ...Object.fromEntries(add.map((e) => [e.id, e])) }) };
}

const ids = (xs: readonly ElementId[]) => [...xs];

describe("requirements engine and the spaces locator", () => {
  it("asks the locator for each record: an estimate and the fryer in the kitchen meet (max: 15 kW counts, not 17 kW)", () => {
    const m = withElements(base(), [space, estimate, fryer]);
    const engine = new RequirementsEngine({ locator: perRecord });
    const aa = engine.allocatedActual(m, estimate.id);
    expect(aa?.actual.va).toBe(15000);
    expect(ids(aa?.actualIds ?? [])).toEqual([fryer.id]);
    expect(engine.counted(m).va).toBe(15000);
  });

  it("a kitchen drawn after the fryer was placed claims it; the estimate added next counts against it", () => {
    const m0 = withElements(base(), [fryer]);
    const engine = new RequirementsEngine({ locator: perRecord });
    expect(engine.counted(m0).va).toBe(15000);
    const m1 = withElements(m0, [space]);
    engine.advance(m1, [SPACE]);
    const m2 = withElements(m1, [estimate]);
    engine.advance(m2, [estimate.id]);
    expect(engine.allocatedActual(m2, estimate.id)?.actual.va).toBe(15000);
    expect(engine.counted(m2)).toEqual(new RequirementsEngine({ locator: perRecord }).counted(m2));
    expect(engine.counted(m2).va).toBe(15000);
  });
});
