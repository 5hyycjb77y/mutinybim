/**
 * @jest-environment node
 *
 * A planned part (not placed yet) has no location: the clash, surface and
 * clearance rules must not check its placeholder at the level origin, and the
 * lint must say how many parts it did not check instead of staying silent.
 * On code that predates `planned`, the two panels stacked at the origin clash.
 */
import type { BimElement, ModelState } from "@permitzip/bim-kernel";
import { rulesFired } from "./fixtures";
import { Building } from "../../bim-kernel/__tests__/fixtures/electrical-building";

function stacked(): Building {
  const b = new Building();
  b.place("pa", "panel208", { panel_name: "PA" }, "PA", { x: 0, y: 0 });
  b.place("pb", "panel208", { panel_name: "PB" }, "PB", { x: 0, y: 0 });
  return b;
}

function stampPlanned(model: ModelState, ids: readonly string[]): ModelState {
  const elements: Record<string, BimElement> = { ...model.elements };
  for (const id of ids) {
    const el = elements[id];
    if (el?.kind !== "part") throw new Error(`${id} is not a part`);
    elements[id] = { ...el, planned: { levelHint: el.levelId } };
  }
  return { ...model, elements };
}

describe("planned parts in the lint", () => {
  it("two placed panels at the same point clash (the control)", () => {
    const fired = rulesFired(stacked().head);
    expect(fired.get("clash-hard") ?? []).not.toEqual([]);
    expect(fired.get("planned-not-checked") ?? []).toEqual([]);
  });

  it("a planned panel is not checked for clashes, and the lint says so", () => {
    const fired = rulesFired(stampPlanned(stacked().head, ["pb"]));
    expect(fired.get("clash-hard") ?? []).toEqual([]);
    expect(fired.get("clash-soft") ?? []).toEqual([]);
    expect(fired.get("planned-not-checked")).toEqual(["PB isn't placed yet: 1 planned element not checked for clashes"]);
  });

  it("counts every planned part in the message", () => {
    const fired = rulesFired(stampPlanned(stacked().head, ["pa", "pb"]));
    expect(fired.get("planned-not-checked")).toEqual([
      "PA isn't placed yet: 2 planned elements not checked for clashes",
      "PB isn't placed yet: 2 planned elements not checked for clashes",
    ]);
  });
});
