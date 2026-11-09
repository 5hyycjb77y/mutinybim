/**
 * Lane A13b split fixtures: Office 101 (5.8 × 3.8 m inside its walls) with a
 * lighting estimate at 10 VA/m², a 200 VA copier, and a receptacle at a point
 * in the west half; and the reads the split tests share.
 */
import { asElementId, modelSpaceLocator, type BimElement } from "../src";
import { loadValueOf } from "../src/requirements/allocation";
import type { LoadRecord } from "../src/requirements/anchor";
import { box, modelWith } from "./a13b-fixtures";
import { Log } from "./a13a-fixtures";

export const OFFICE = { libraryId: "test", useId: "office", name: "Office" };
/** A separation line across Office 101 at x = 3 m, overshooting both walls. */
export const LINE = { start: { x: 3000, y: -200 }, end: { x: 3000, y: 4200 } };

const load = (id: string, extra: Record<string, unknown>): BimElement => ({ id: asElementId(id), kind: "load_point", version: 1, authoredRev: {}, connectionType: "", values: {}, ...extra }) as unknown as BimElement;

export function officeWithLoads(modelId: string): Log {
  const m = new Log(modelWith(box("W", 0, 0, 6000, 4000), modelId));
  m.ok({ type: "place_space_in_walls", spaceId: "s-101", levelId: "L1", seed: { x: 2500, y: 2000 }, number: "101", name: "Office", use: OFFICE });
  const loads = [
    load("lp-lights", { anchor: { kind: "space", id: "s-101" }, basis: "density", rates: [{ key: "va", per: "area", value: 10 }] }),
    load("lp-copier", { anchor: { kind: "space", id: "s-101" }, values: { va: 200 } }),
    load("lp-recep", { anchor: { kind: "point", levelId: "L1", position: { x: 1000, y: 1000 } }, values: { va: 180 } }),
  ];
  return new Log({ ...m.head, elements: { ...m.head.elements, ...Object.fromEntries(loads.map((l) => [l.id, l])) } });
}

/** VA of every load anchored to the space (estimates by area read the space's area). */
export function vaOn(m: Log, spaceId: string): number {
  const locator = modelSpaceLocator(m.head.elements);
  let total = 0;
  for (const el of Object.values(m.head.elements)) {
    if (el.kind !== "load_point" || el.anchor?.kind !== "space" || el.anchor.id !== spaceId) continue;
    total += loadValueOf(m.head.elements, el as LoadRecord, locator).va;
  }
  return total;
}

export function space(m: Log, id: string) {
  const s = m.head.elements[id];
  if (s?.kind !== "space") throw new Error(`no space ${id}`);
  return s;
}
