/**
 * @jest-environment node
 *
 * Batch 16-D round 2: a printed plan or section measures a dimension to the
 * linked wall's current position. A print carries the linked elements its
 * dimensions name (the server answers them with the view's cut, from the same
 * element index the live view reads), and the drawing resolves from those,
 * not only from links the page has loaded. When the wall is gone the print
 * says so in the same words as the live view.
 *
 * Fails on the old code: a print (no page catalogue on a server) drew every
 * linked anchor at its stored point, so a wall moved in a new link version
 * left the printed dimension at the old length; sections never followed.
 */
import {
  ANNOTATION_LINKED_ANCHORS_FEATURE,
  ELEMENTS_LINKED_COPY_FEATURE,
  anchorOnlyReference,
  buildLinkedReferenceIndex,
  buildViewScene,
  linkedCopyReview,
  linkedCopyStamp,
  linkedCopyStampOf,
  linkedReferenceItem,
  linkedReferenceRulesOf,
  commandSchema,
  dimensionValues,
  executeCommand,
  linkedAnchorKeysOfView,
  linkedElementKey,
  withLinkedReferenceModels,
  withUpgradePolicy,
  type DrawingItem,
  type LinkedReferenceModel,
  type ModelState,
  type ViewElement,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { LINK_ID, linkedWall, sampleWarehouse } from "./d16-linked-fixtures";
import { twoLevels } from "./a13a-fixtures";

function run(m: ModelState, command: Record<string, unknown>): ModelState {
  const r = withUpgradePolicy((f) => f === ANNOTATION_LINKED_ANCHORS_FEATURE || f === ELEMENTS_LINKED_COPY_FEATURE || f.startsWith("elements:"), () => executeCommand(m, commandSchema.parse(command)));
  if (!r.ok) throw new Error(r.error.message);
  return r.model;
}

const KEY = linkedElementKey({ sourceId: LINK_ID, globalId: "V1" });
const v1: LinkedReferenceModel = sampleWarehouse(2, 1);
const moved: LinkedReferenceModel = { ...v1, elements: v1.elements.map((e) => (e.globalId === "V1" ? linkedWall("V1", { x: 6500, y: 0 }, { x: 6500, y: 6000 }) : e)) };
const gone: LinkedReferenceModel = { ...v1, elements: v1.elements.filter((e) => e.globalId !== "V1") };

function withDimension(viewType: "floor_plan" | "section"): { model: ModelState; view: ViewElement; item: DrawingItem } {
  let m = createDemoModel();
  m = run(m, viewType === "floor_plan"
    ? { type: "create_view", viewId: "v", name: "Level 1 plan", viewType: "floor_plan", props: { level: "Level 1", scale: 48 } }
    : { type: "create_view", viewId: "v", name: "Section A", viewType: "section", props: { scale: 48, section: { start: { x: -1000, y: 3000 }, end: { x: 13_000, y: 3000 }, direction: 1, depthMm: 5000 } } });
  // Plans store model x/y; sections store (along the cut, height).
  const points = viewType === "floor_plan" ? [{ x: 6100, y: 3000 }, { x: 9000, y: 3000 }] : [{ x: 7100, y: 1000 }, { x: 10_000, y: 1000 }];
  m = run(m, { type: "add_drawing_item", itemId: "dim", ownerId: "v", shape: "dimension", points, dim: { kind: "linear", direction: "horizontal", refs: [{ elementId: KEY, anchor: "edge_left" }, null], offsetMm: -8 } });
  const view = m.elements.v;
  const item = m.elements.dim;
  if (view?.kind !== "view" || item?.kind !== "drawing_item") throw new Error("setup failed");
  return { model: m, view, item };
}

const texts = (m: ModelState, linked: LinkedReferenceModel) => buildViewScene(m, "v", [anchorOnlyReference([linked])]).scene.primitives.flatMap((p) => (p.kind === "text" ? [p.text] : []));

describe("d16b printed dimensions follow linked walls", () => {
  it("a view asks only for the linked elements its dimensions name", () => {
    const { model } = withDimension("floor_plan");
    expect(linkedAnchorKeysOfView(model, "v")).toEqual([KEY]);
    expect(linkedAnchorKeysOfView(model, "other-view")).toEqual([]);
  });

  for (const viewType of ["floor_plan", "section"] as const) {
    it(`${viewType === "floor_plan" ? "a plan" : "a section"}: the printed length changes with the link's new version, and a gone wall prints the plain warning`, () => {
      const { model, view, item } = withDimension(viewType);
      const before = withLinkedReferenceModels([v1], () => dimensionValues(model, view, item))[0] ?? 0;
      const after = withLinkedReferenceModels([moved], () => dimensionValues(model, view, item))[0] ?? 0;
      expect(before - after).toBeCloseTo(500, 3);
      // Nothing loaded (the old print path): the stored points.
      expect(dimensionValues(model, view, item)[0]).toBeCloseTo(2900, 3);

      expect(texts(model, gone).some((t) => t.includes("Measured to something no longer in Sample Warehouse (architect)"))).toBe(true);
      expect(texts(model, moved).some((t) => t.includes("no longer in"))).toBe(false);
    });
  }
});

describe("d16b copies kept in step with the link (kernel)", () => {
  it("stamps a wall as a copy of a linked wall, lists it when the source moves or goes, and clears the stamp on request", () => {
    let m = twoLevels("d16b-copies-kernel").head;
    m = withUpgradePolicy(() => true, () => {
      const r = executeCommand(m, commandSchema.parse({ type: "create_element", elementId: "copy-w", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 6000, y: -100 }, end: { x: 6000, y: 6100 } }, size: { thicknessMm: 200, heightMm: 3600 } }));
      if (!r.ok) throw new Error(r.error.message);
      return r.model;
    });
    const index1 = buildLinkedReferenceIndex([{ ...v1, version: "v1" }], linkedReferenceRulesOf([], ["IFCWALLSTANDARDCASE", "IFCWINDOW"]));
    const source = linkedReferenceItem(index1, { sourceId: LINK_ID, globalId: "V1" });
    if (!source) throw new Error("no source");
    m = run(m, { type: "set_element_linked_copy", stamps: [{ elementId: "copy-w", stamp: linkedCopyStampOf(index1, source) }] });
    expect(linkedCopyStamp(m.elements["copy-w"])).toMatchObject({ linkId: LINK_ID, globalId: "V1", version: "v1" });
    expect(linkedCopyReview(m.elements, index1)).toEqual({ rows: [], current: 1, notLoaded: 0 });

    const index2 = buildLinkedReferenceIndex([{ ...moved, version: "v2" }], linkedReferenceRulesOf([], ["IFCWALLSTANDARDCASE", "IFCWINDOW"]));
    expect(linkedCopyReview(m.elements, index2).rows.map((r) => [r.status, r.words])).toEqual([["changed", "The linked wall this wall was copied from moved 500 mm in Sample Warehouse (architect)."]]);
    const index3 = buildLinkedReferenceIndex([{ ...gone, version: "v3" }], linkedReferenceRulesOf([], ["IFCWALLSTANDARDCASE"]));
    expect(linkedCopyReview(m.elements, index3).rows[0]?.status).toBe("gone");
    // A link not loaded here: nothing to say yet.
    expect(linkedCopyReview(m.elements, buildLinkedReferenceIndex([], linkedReferenceRulesOf([], [])))).toEqual({ rows: [], current: 0, notLoaded: 1 });

    m = run(m, { type: "set_element_linked_copy", stamps: [{ elementId: "copy-w", stamp: null }] });
    expect(linkedCopyStamp(m.elements["copy-w"])).toBeNull();
  });
});
