/**
 * @jest-environment node
 *
 * s12-typical-to-graphics: with the view switch on, every copy of a typical
 * draws a hatched halftone outline labelled "TYPICAL TO UNIT 001", carried
 * through the copy's transform (a mirrored copy's outline is mirrored); with
 * it off (or a view that never stored it) nothing is added.
 *
 * Fails on round 11's code: there is no "typical to" drawing.
 */
import { builtinPartType, withUpgradePolicy, TYPICALS_MIRROR_FEATURE, type PartInstance } from "@permitzip/bim-kernel";
import type { Primitive } from "@permitzip/bim-kernel";
import { TYPICAL_TO_HINTS_KEY, TYPICAL_TO_VIEW_GRAPHICS, drawTypicalTo, typicalCopyOutlines, typicalToShown } from "../../bim-kernel/src/annotation/typical-graphics";
import { Model } from "./fixtures";

const RTU = builtinPartType("builtin:rtu-5-ton@2");

function unit(): Model {
  if (!RTU) throw new Error("starter library is missing the RTU");
  const m = new Model();
  m.ok({ type: "place_part", partId: "rtu-1", typeId: RTU.id, partType: RTU.definition, levelId: "lvl-roof", position: { x: 0, y: 0 }, mark: "RTU-1" });
  m.ok({ type: "place_part", partId: "rtu-2", typeId: RTU.id, partType: RTU.definition, levelId: "lvl-roof", position: { x: 4000, y: 2000 }, mark: "RTU-2" });
  m.ok({ type: "create_group", groupId: "g-unit", name: "Unit 001" });
  m.ok({ type: "assign_elements_to_group", ids: ["rtu-1", "rtu-2"], groupId: "g-unit" });
  withUpgradePolicy(
    (f) => f === TYPICALS_MIRROR_FEATURE,
    () =>
      m.ok({
        type: "set_group_typical",
        groupId: "g-unit",
        mark: "001",
        basePoint: { x: 0, y: 0 },
        copies: [
          { mark: "002", offset: { x: 10_000, y: 0 } },
          { mark: "003", offset: { x: 20_000, y: 0 }, mirror: { axis: "x" } },
        ],
      }),
  );
  return m;
}

describe("s12-typical-to-graphics", () => {
  it("one labelled outline per copy, through each copy's transform", () => {
    const m = unit();
    const parts = Object.values(m.head.elements).filter((e): e is PartInstance => e.kind === "part");
    const outlines = typicalCopyOutlines(m.head, parts);
    expect(outlines.map((o) => [o.mark, o.label])).toEqual([
      ["002", "TYPICAL TO UNIT 001"],
      ["003", "TYPICAL TO UNIT 001"],
    ]);
    expect(outlines[0]?.outline).toEqual([
      { x: 9700, y: -300 },
      { x: 14_300, y: -300 },
      { x: 14_300, y: 2300 },
      { x: 9700, y: 2300 },
    ]);
    // Mirrored left for right about the base point, then moved: the outline spans 15,700..20,300.
    const xs = (outlines[1]?.outline ?? []).map((p) => p.x).sort((a, b) => a - b);
    expect([xs[0], xs[3]]).toEqual([15_700, 20_300]);
  });

  it("draws hatch, outline and label halftone only when the view's switch is on", () => {
    const m = unit();
    const shown = new Map(Object.values(m.head.elements).flatMap((e) => (e.kind === "part" ? [[e.id, e] as const] : [])));
    const prims: Primitive[] = [];
    const ctx = { model: m.head, shown, toPaper: (p: { x: number; y: number }) => ({ x: p.x / 100, y: p.y / 100 }), prims };
    expect(drawTypicalTo(ctx, undefined)).toBe(0);
    expect(drawTypicalTo(ctx, { show: false })).toBe(0);
    expect(prims).toEqual([]);
    expect(drawTypicalTo(ctx, { show: true })).toBe(2);
    const texts = prims.filter((p) => p.kind === "text");
    expect(texts.map((t) => (t.kind === "text" ? t.text : ""))).toEqual(["TYPICAL TO UNIT 001", "TYPICAL TO UNIT 001"]);
    expect(prims.every((p) => p.kind === "rect" || p.tone === "halftone")).toBe(true);
    expect(prims.filter((p) => p.kind === "line" && p.dash === undefined).length).toBeGreaterThan(4);
    expect(typicalToShown({ show: "yes" })).toBe(false);
    expect(TYPICAL_TO_VIEW_GRAPHICS.hintsKey).toBe(TYPICAL_TO_HINTS_KEY);
  });
});
