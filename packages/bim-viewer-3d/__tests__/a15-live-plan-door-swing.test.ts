/**
 * @jest-environment node
 *
 * Round 15 lane A15 (A0b): the live plan draws the plan symbols the printed
 * drawing draws. Review video (Nov 4): "Level 1 Plan, Live model: no door swing,
 * no window lines; the printed drawing has them." The live plan was only the
 * 3D model cut at the plan height, so a door showed as a gap.
 *
 * One generic layer (`livePlanSymbols`): for the records on the plan's
 * levels, the same `planGraphicsOf` the printed plan reads — a class's plan
 * symbols (the door's swing, the window's glass lines), or a kind row's lines
 * for a record with no body (an add-on's arc, so E15's circuit arcs ride the
 * same layer). Records already drawn as bodies with no class symbol (walls,
 * runs) are left to the cut.
 *
 * Fails on round 14's code: there was no live plan symbol layer
 * (`../src/live-plan-graphics` did not exist); the live plan drew no swing.
 */
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { definePack, contribute, PackSet, withPackSet } from "../../bim-kernel/src/packs";
import { ELEMENT_KIND_POINT, graphicSegments, planGraphicsContext, planGraphicsOf, type BimElement, type ModelState } from "@permitzip/bim-kernel";
import { twoLevels } from "../../bim-kernel/__tests__/a13a-fixtures";
import { livePlanSymbols, symbolPositions, type LivePlanOptions } from "../src/live-plan-graphics";
import { modelSolids } from "../src/native-geometry";
import { MM } from "../src/coords";

installFirstPartyAddOns();

function plan(): ModelState {
  const m = twoLevels("a15-live");
  m.ok({ type: "create_element", elementId: "w", kind: "wall", levelId: "L1", size: { thicknessMm: 200, heightMm: 3000 }, placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 8000, y: 0 } } });
  m.ok({ type: "create_hosted", elementId: "d", kind: "opening", openingType: "door", mark: "101", hostId: "w", s: 2000, side: 1, size: { widthMm: 900, heightMm: 2100 } });
  m.ok({ type: "create_hosted", elementId: "win", kind: "opening", openingType: "window", mark: "W1", hostId: "w", s: 6000, side: 1, size: { widthMm: 1200, heightMm: 1200 } });
  return m.head as ModelState;
}

function options(model: ModelState, extra: Partial<LivePlanOptions> = {}): LivePlanOptions {
  const bodies = new Set<string>(modelSolids(model).map((s) => s.elementId));
  return { levelId: "L1", scale: 100, detail: "medium", levels: null, hasBody: (id) => bodies.has(id), ...extra };
}

describe("a15-live-plan-door-swing", () => {
  it("the live plan draws the door's swing and the window's lines, exactly as the printed plan does", () => {
    const model = plan();
    const symbols = livePlanSymbols(model, options(model));
    const printed = (id: string) => {
      const el = model.elements[id];
      if (!el) throw new Error(`no ${id}`);
      return (planGraphicsOf(el, planGraphicsContext(model, { scale: 100, levelId: "L1", detail: "medium", drawing: "view" })) ?? []).flatMap((g) => graphicSegments(g));
    };
    const live = (id: string) => symbols.segments.filter((s) => s.owner === id).map((s) => [s.a, s.b] as const);
    // The door: its leaf line plus the quarter-circle swing (four chords), hinged on the face it opens to.
    expect(live("d")).toEqual(printed("d"));
    expect(live("d").length).toBe(1 + 4);
    expect(live("d")[0]).toEqual([{ x: 1550, y: 100 }, { x: 1550, y: 1000 }]);
    // The window: three lines across the gap.
    expect(live("win")).toEqual(printed("win"));
    expect(live("win").length).toBe(3);
    // The wall is the cut's: no symbol lines of its own here.
    expect(live("w")).toEqual([]);
    // Marks come along for tags.
    expect(symbols.texts.map((t) => t.text).sort()).toEqual(["101", "W1"]);
  });

  it("only the plan's levels, and not what the view hides", () => {
    const model = plan();
    expect(livePlanSymbols(model, options(model, { levels: new Set(["L2"]) })).segments).toEqual([]);
    const hidden = livePlanSymbols(model, options(model, { hidden: (id) => id === "d" }));
    expect(new Set(hidden.segments.map((s) => s.owner))).toEqual(new Set(["win"]));
  });

  it("is generic: an add-on kind with no body draws its kind row's lines on the same layer", () => {
    const pack = definePack({ id: "zz", name: "ZZ arcs", version: "1.0.0", kernel: "^1.12.0" }, [
      contribute(ELEMENT_KIND_POINT, [
        {
          kind: "zz.arc",
          label: "Arc",
          nature: "physical",
          planGraphics: () => [{ form: "arc", center: { x: 0, y: 0 }, radiusMm: 1000, startDeg: 0, sweepDeg: 90, pen: "thin" }],
        },
      ]),
    ]);
    const base = plan();
    const raw: Record<string, unknown> = { id: "a1", kind: "zz.arc", version: 1, authoredRev: {}, partition: { level: "L1" } };
    const model: ModelState = { ...base, elements: { ...base.elements, a1: raw as unknown as BimElement } };
    withPackSet(PackSet.create([pack]), () => {
      const symbols = livePlanSymbols(model, options(model));
      expect(symbols.segments.filter((s) => s.owner === "a1").length).toBe(4);
    });
  });

  it("lays the lines just under the cut, in scene metres", () => {
    const model = plan();
    const seg = livePlanSymbols(model, options(model)).segments.slice(0, 1);
    const p = symbolPositions(seg, 1169);
    expect(Array.from(p).map((v) => Math.round(v / MM))).toEqual([1550, 1169, -100, 1550, 1169, -1000]);
  });
});
