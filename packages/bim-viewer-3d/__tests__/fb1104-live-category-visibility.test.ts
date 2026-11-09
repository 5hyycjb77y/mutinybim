/**
 * @jest-environment node
 *
 * Product decision, Nov 4 ("more comments" review video, 3:20): in Level 1 Plan he unticked
 * Walls under Visibility/Graphics, got "Hide walls", and the walls stayed.
 * The live model only followed the view's groups and phases; the category
 * switches reached the printed drawing alone. Now the live model reads the
 * same answer (`elementLook`) for the open view.
 *
 * Fails on the old viewer: there was no category step, so the wall resolved
 * shown (and the free model had no resolver at all).
 */
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import type { BimElement, ModelState, ViewElement } from "@permitzip/bim-kernel";
import { twoLevels } from "../../bim-kernel/__tests__/a13a-fixtures";
import { liveDisplayOf } from "../src/live-display";

installFirstPartyAddOns();

function model(): ModelState {
  const m = twoLevels("fb1104-vg");
  m.ok({ type: "create_element", elementId: "w", kind: "wall", levelId: "L1", size: { thicknessMm: 200 }, placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } } });
  m.ok({ type: "create_element", elementId: "f", kind: "slab", levelId: "L1", size: { thicknessMm: 150 }, placement: { kind: "area", outline: [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 4000 }, { x: 0, y: 4000 }], holes: [] } });
  return m.head as ModelState;
}

function el(m: ModelState, id: string): BimElement {
  const found = m.elements[id];
  if (!found) throw new Error(`no ${id}`);
  return found;
}

const view = (props: ViewElement["props"]): Pick<ViewElement, "props"> => ({ props });

describe("fb1104: the live model follows the open view's Visibility/Graphics", () => {
  it("Walls switched off hides walls and only walls", () => {
    const m = model();
    const resolve = liveDisplayOf(m, {}, view({ hiddenCategories: ["walls"] }));
    expect(resolve?.(el(m, "w")).visible).toBe(false);
    expect(resolve?.(el(m, "f")).visible).toBe(true);
  });

  it("a halftone override draws the category see-through", () => {
    const m = model();
    const resolve = liveDisplayOf(m, null, view({ categoryOverrides: { walls: { halftone: true } } }));
    expect(resolve?.(el(m, "w"))).toEqual({ visible: true, halftone: true, dashed: false });
  });

  it("the free model (no open view, no choices) is not narrowed", () => {
    expect(liveDisplayOf(model(), null, null)).toBeNull();
  });
});
