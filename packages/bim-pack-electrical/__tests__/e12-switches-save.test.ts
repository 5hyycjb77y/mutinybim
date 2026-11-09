/**
 * @jest-environment node
 *
 * Round 12 lane E: the plan's "Wire hash marks" and the one-line's "Show
 * fault current" save on the view like every other view setting, and draw.
 * A model server on an older version would refuse the new fields with its
 * strict view schema, so each is saved only when every peer reads it, and is
 * otherwise refused in words; nothing is half-written.
 *
 * On round 11's code both fields were refused by the strict schema
 * ("Unrecognized key"), so neither switch could be saved.
 */
import { DIAGRAM_FAULT_CURRENT_FEATURE, VIEW_HASH_MARKS_FEATURE, evaluateDiagram, withUpgradePolicy, type Command } from "@permitzip/bim-kernel";
import { resolveCircuitGraphics } from "@permitzip/bim-pack-electrical";
import { Building, referenceDistribution } from "../../bim-kernel/__tests__/fixtures/electrical-building";

const reads = (f: string) => f === VIEW_HASH_MARKS_FEATURE || f === DIAGRAM_FAULT_CURRENT_FEATURE;

function withViews(): Building {
  const b = referenceDistribution();
  b.ok({ type: "create_view", viewId: "v-e1", name: "Level 1 Power", viewType: "floor_plan", crop: { min: { x: -12000, y: -8000 }, max: { x: 12000, y: 8000 } }, props: { level: "Level 1", scale: 48, discipline: "electrical" } });
  b.ok({ type: "create_view", viewId: "v-ol", name: "One-line", viewType: "detail", props: { diagram: { kind: "one_line" } } });
  return b;
}

const HASH: Command = { type: "set_view_properties", viewId: "v-e1", props: { circuitGraphics: { style: "orthogonal", hashMarks: "hots_neutral_ground" } } };
const AFC: Command = { type: "set_view_properties", viewId: "v-ol", props: { diagram: { kind: "one_line", hints: { faultCurrent: true } } } };

describe("e12: the hash-mark and fault-current switches save", () => {
  it("saves both when every peer reads them, and the drawings follow", () => {
    const b = withViews();
    withUpgradePolicy(reads, () => {
      b.ok(HASH);
      b.ok(AFC);
    });
    const plan = b.el("v-e1");
    expect(plan.kind === "view" ? resolveCircuitGraphics(plan).hashMarks : null).toBe("hots_neutral_ground");
    const ol = b.el("v-ol");
    if (ol.kind !== "view") throw new Error("no one-line");
    const texts = JSON.stringify(evaluateDiagram(b.head.elements, ol));
    // The one-line prints its text blocks in capitals.
    expect(texts).toContain("AFC: UTILITY VALUE NEEDED");
  });

  it("refuses each in words on an older model server, writing nothing", () => {
    const b = withViews();
    expect(b.refused(HASH)).toMatch(/^Wire hash marks can't be saved yet: the model server this model is open on is an older version/);
    expect(b.refused(AFC)).toMatch(/^Show fault current can't be saved yet/);
    const plan = b.el("v-e1");
    expect(plan.kind === "view" ? plan.props?.circuitGraphics : null).toBeUndefined();
  });
});
