/**
 * @jest-environment node
 *
 * `struct.footing_unsupported` runs on every coordination lint advance (it
 * `reads` columns and components, and Structural is on in every model since
 * round 14). Before 2026-11-04 it read the whole structural frame for every
 * new elements record, every part's operating weight included: 121 ms of
 * lint.advance.50's 124 ms at 250k. It reads only columns, footings and
 * levels now, and an edit that changed none of them reuses the last read.
 */
import { asElementId, type BimElement, type ModelState } from "@permitzip/bim-kernel/types";
import { columnBearings, footingUnsupported, frameOf, frameSupportsOf } from "../src";
import { FT, twoBayFrame } from "./two-bay-frame";

const el = (model: ModelState, id: string): BimElement => {
  const e = model.elements[id];
  if (!e) throw new Error(`${id} missing`);
  return e;
};

/** The frame with every part's values watched: a read of any part's parameters counts. */
function watchedFrame(): { readonly model: ModelState; readonly partReads: () => number; readonly reset: () => void } {
  const model = twoBayFrame({ withoutFooting: "C2B" });
  let reads = 0;
  const watch = (e: BimElement): BimElement =>
    e.kind === "part"
      ? {
          ...e,
          values: new Proxy(e.values, {
            get(target, key, receiver) {
              reads += 1;
              return Reflect.get(target, key, receiver) as unknown;
            },
          }),
        }
      : e;
  const elements = Object.fromEntries(Object.entries(model.elements).map(([id, e]) => [id, watch(e)]));
  return { model: { ...model, elements }, partReads: () => reads, reset: () => (reads = 0) };
}

/** The same model with RTU-1 moved 1 ft: an edit that touches no column, footing or level. */
function withRtuMoved(model: ModelState): ModelState {
  const rtu = el(model, "RTU-1");
  if (rtu.kind !== "part") throw new Error("RTU-1 is not a part");
  return { ...model, elements: { ...model.elements, "RTU-1": { ...rtu, position: { x: rtu.position.x + FT, y: rtu.position.y } } } };
}

const unsupported = (model: ModelState) =>
  Object.values(model.elements)
    .filter((e) => e.kind === "column")
    .map((c) => footingUnsupported(model, c)?.elementIds.join(","))
    .filter((x): x is string => x !== undefined);

describe("c5x struct.footing_unsupported reads only what a column bears on", () => {
  it("an edit that moved only equipment reads no part and reuses the last columns-and-footings read", () => {
    const { model, partReads, reset } = watchedFrame();
    expect(footingUnsupported(model, el(model, "C2B"))?.elementIds).toEqual(["C2B"]);
    const after = withRtuMoved(model);
    reset();
    expect(footingUnsupported(after, el(after, "C2B"))?.elementIds).toEqual(["C2B"]);
    expect(footingUnsupported(after, el(after, "C1A"))).toBeNull();
    // The old rule read the whole frame for each new record: every part's operating weight.
    expect(partReads()).toBe(0);
    expect(frameSupportsOf(after)).toBe(frameSupportsOf(model));
  });

  it("an edit to a footing reads again, and the finding follows it", () => {
    const model = twoBayFrame();
    expect(unsupported(model)).toEqual([]);
    const { F1A: _gone, ...rest } = model.elements;
    const after: ModelState = { ...model, elements: rest };
    expect(frameSupportsOf(after)).not.toBe(frameSupportsOf(model));
    expect(unsupported(after)).toEqual(["C1A"]);
    const f2b = el(model, "F2B");
    if (f2b.kind !== "component") throw new Error("F2B is not a component");
    const moved: ModelState = { ...model, elements: { ...model.elements, F2B: { ...f2b, position: { x: f2b.position.x + 20 * FT, y: f2b.position.y }, placement: { kind: "point", levelId: asElementId("level-ground"), position: { x: f2b.position.x + 20 * FT, y: f2b.position.y }, offsetMm: 0, rotationDeg: 0 } } } };
    expect(unsupported(moved)).toEqual(["C2B"]);
  });

  it("flags exactly the columns the load path finds bearing on nothing", () => {
    for (const model of [twoBayFrame(), twoBayFrame({ withoutFooting: "C2B" }), twoBayFrame({ withoutFooting: "C3A" })]) {
      const bearings = columnBearings(frameOf(model));
      const loadPath = [...bearings].filter(([, b]) => b === null).map(([id]) => id).sort();
      expect(unsupported(model).sort()).toEqual(loadPath);
    }
  });
});
