/**
 * @jest-environment node
 *
 * Round 15 lane A15 (A0): an outside add-on gives its own class a body with
 * zero kernel edits. A test firm's `zz.louvre` class (the kernel's opening
 * kind, `openingType: "louver"`) contributes a `kernel.class_solids` row:
 * three blades across the void. The 3D viewer draws them and sections cut
 * them; with the add-on off the louvre has no body, as before.
 *
 * Fails on round 14's code: there was no `kernel.class_solids` point, so no
 * add-on could give a kernel kind a body by class.
 */
import { hostVoidsOf, type ClassSolidPart, type ModelState, type Vec2 } from "@permitzip/bim-kernel";
import { CLASS_POINT } from "@permitzip/bim-kernel";
import { CLASS_SOLIDS_POINT, classSolidsRowProblems } from "@permitzip/bim-kernel";
import { contribute, definePack, PackSet, withPackSet } from "../../bim-kernel/src/packs";
import { elementSolid } from "../../bim-kernel/src/drawing/solids";
import { twoLevels } from "../../bim-kernel/__tests__/a13a-fixtures";
import { elementSolids } from "../src/native-geometry";

const BLADES = 3;

const LOUVRE = definePack({ id: "zz", name: "ZZ louvres", version: "1.0.0", kernel: "^1.12.0" }, [
  contribute(CLASS_POINT, [{ id: "zz.louvre", label: "Louvres", discipline: "general", recognize: { elementKinds: ["opening"], where: [{ path: "openingType", op: "equals", value: "louver" }] } }]),
  contribute(CLASS_SOLIDS_POINT, [
    {
      classId: "zz.louvre",
      label: "Louvre blades",
      solids(el, ctx) {
        if (el.kind !== "opening") return null;
        const v = hostVoidsOf(ctx.elements, el.hostId).find((x) => x.elementId === el.id);
        if (!v) return null;
        const xs = v.profile.map((p) => p.x);
        const ys = v.profile.map((p) => p.y);
        const [a, b, lo, hi] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
        const out: ClassSolidPart[] = [];
        for (let i = 0; i < BLADES; i++) {
          const z = lo + ((i + 0.5) * (hi - lo)) / BLADES;
          const outline: Vec2[] = [{ x: a, y: -40 }, { x: b, y: -40 }, { x: b, y: 40 }, { x: a, y: 40 }];
          out.push({ shape: { form: "prism", outline, z0: ctx.floorMm + z - 10, z1: ctx.floorMm + z + 10, category: "equipment", role: "equipment" } });
        }
        return out;
      },
    },
  ]),
]);

function wallWithLouvre() {
  const m = twoLevels("a15-louvre");
  m.ok({ type: "create_element", elementId: "w", kind: "wall", levelId: "L1", size: { thicknessMm: 200, heightMm: 3000 }, placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } } });
  m.ok({ type: "create_hosted", elementId: "o", kind: "opening", openingType: "louver", mark: "L1", hostId: "w", s: 3000, side: 1, size: { widthMm: 600, heightMm: 600 } });
  return m.head as ModelState;
}

describe("a15-outside-pack-louvre-body", () => {
  it("an outside add-on's class body draws in 3D and is cut in sections, with no kernel edit", () => {
    const model = wallWithLouvre();
    const el = model.elements.o;
    if (!el) throw new Error("no louvre");
    expect(elementSolids(el, undefined, model)).toEqual([]);
    expect(elementSolid(model, el, 0)).toBeNull();
    withPackSet(PackSet.create([LOUVRE]), () => {
      const solids = elementSolids(el, undefined, model);
      expect(solids.map((s) => s.group)).toEqual(["equipment"]);
      expect(solids[0]?.mesh?.positions.length).toBe(BLADES * 24 * 3);
      expect(elementSolid(model, el, 0)?.pieces.length).toBe(BLADES);
    });
  });

  it("malformed rows are refused in words", () => {
    expect(classSolidsRowProblems([{ classId: "zz.a", label: " ", solids: () => null }, { classId: "zz.a", label: "Again", solids: () => null }])).toEqual(["class body zz.a has no label", "class body zz.a is declared twice"]);
  });
});
