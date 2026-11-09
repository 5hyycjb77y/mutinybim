/**
 * @jest-environment node
 *
 * Round 13 lane K13: an outside add-on (not first-party) draws its own kind
 * in plans through its kind row, with no kernel edit. A conveying add-on's
 * conveyor draws its two belt edges and its mark (a tag place) from
 * `planGraphics`, and a click on it picks it through `pickShape`. Without
 * the add-on the conveyor keeps only its stored outline, screened (step
 * 1.6), and can't be picked; its record is kept as stored.
 *
 * Fails on round 12's code: no plan read `planGraphics` or `pickShape`, so
 * the conveyor drew nothing and wasn't pickable.
 */
import {
  ELEMENT_KIND_POINT,
  buildSheetScene,
  buildViewPickIndex,
  buildViewScene,
  commandSchema,
  demoSheetDefinition,
  executeCommand,
  freezeElements,
  type BimElement,
  type ElementKindItem,
  type ModelState,
  type Vec2,
  type ViewElement,
} from "../src";
import { pickAt } from "../src/view-mapping/pick";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { PackSet, contribute, definePack, PACK_CONTRACT_VERSION, withPackSet } from "../src/packs";

const BELT_HALF_MM = 450;

function belt(el: BimElement): { readonly start: Vec2; readonly end: Vec2; readonly mark: string } | null {
  const start: unknown = Reflect.get(el, "start");
  const end: unknown = Reflect.get(el, "end");
  const mark: unknown = Reflect.get(el, "mark");
  const isVec = (v: unknown): v is Vec2 => typeof v === "object" && v !== null && typeof Reflect.get(v, "x") === "number" && typeof Reflect.get(v, "y") === "number";
  return isVec(start) && isVec(end) && typeof mark === "string" ? { start, end, mark } : null;
}

const CONVEYOR: ElementKindItem = {
  kind: "k13cv.conveyor",
  label: "Conveyor",
  nature: "physical",
  planGraphics: (el) => {
    const b = belt(el);
    if (!b) return null;
    const len = Math.hypot(b.end.x - b.start.x, b.end.y - b.start.y);
    const n = { x: -(b.end.y - b.start.y) / len, y: (b.end.x - b.start.x) / len };
    const off = (p: Vec2, s: number): Vec2 => ({ x: p.x + n.x * BELT_HALF_MM * s, y: p.y + n.y * BELT_HALF_MM * s });
    const mid = { x: (b.start.x + b.end.x) / 2, y: (b.start.y + b.end.y) / 2 };
    return [
      { form: "line", a: off(b.start, 1), b: off(b.end, 1), pen: "medium" },
      { form: "line", a: off(b.start, -1), b: off(b.end, -1), pen: "medium" },
      { form: "tag_place", at: mid, rotationDeg: 0, text: b.mark, ref: "centerline_mid", anchor: "middle" },
    ];
  },
  pickShape: (el) => {
    const b = belt(el);
    return b ? { form: "segment", a: b.start, b: b.end, halfWidthMm: BELT_HALF_MM } : null;
  },
};

const CONVEYING = definePack({ id: "k13cv", name: "K13 conveying", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(ELEMENT_KIND_POINT, [CONVEYOR])]);

function run(model: ModelState, command: Record<string, unknown> & { type: string }): ModelState {
  const r = executeCommand(model, commandSchema.parse(command));
  if (!r.ok) throw new Error(r.error.message);
  return r.model;
}

/** Between the demo's trunk and its branches, inside the plan's fitted crop. */
const Y = 1524;
const A = { x: 2000, y: Y };
const B = { x: 8000, y: Y };

function model(): ModelState {
  const m = run(createDemoModel("k13-conveyor"), { type: "create_view", viewId: "plan", name: "Plan", viewType: "floor_plan", props: { level: "L1", scale: 48 } });
  const conveyor = { id: "CV-1", version: 1, authoredRev: {}, kind: "k13cv.conveyor", start: A, end: B, mark: "CV-1" } as unknown as BimElement;
  return { ...m, elements: freezeElements({ ...m.elements, [conveyor.id]: conveyor }) };
}

function view(m: ModelState): ViewElement {
  const v = m.elements.plan;
  if (!v || v.kind !== "view") throw new Error("no plan view");
  return v;
}

describe("k13 outside add-on draws and picks its kind through rows", () => {
  const m = model();
  const set = PackSet.create([CONVEYING]);

  it("a floor plan draws the belt's edges and its mark, and a click on the belt picks it", () => {
    const scene = withPackSet(set, () => buildViewScene(m, "plan").scene);
    expect(scene.tags.filter((t) => t.elementId === "CV-1").map((t) => [t.ref, t.text])).toEqual([["centerline_mid", "CV-1"]]);
    const label = scene.primitives.filter((p) => p.kind === "text" && p.text === "CV-1");
    expect(label).toHaveLength(1);
    const inked = (prims: typeof scene.primitives) => prims.filter((p) => p.kind === "line" && p.pen === "medium" && p.tone !== "halftone");
    expect(inked(scene.primitives).length - inked(buildViewScene(m, "plan").scene.primitives).length).toBe(2);

    const index = withPackSet(set, () => buildViewPickIndex(m, view(m)));
    expect(withPackSet(set, () => pickAt(index, { x: 5000, y: Y + BELT_HALF_MM - 50 }, 10))).toContain("CV-1");
    expect(withPackSet(set, () => pickAt(index, { x: 5000, y: Y + BELT_HALF_MM + 400 }, 10))).not.toContain("CV-1");
  });

  it("the one-sheet printout labels it from the same row", () => {
    const sheet = withPackSet(set, () => buildSheetScene(m, demoSheetDefinition()));
    expect(sheet.tags.filter((t) => t.elementId === "CV-1").map((t) => t.text)).toEqual(["CV-1"]);
  });

  it("without the add-on it keeps only a screened outline, can't be picked, and its record is kept", () => {
    const scene = buildViewScene(m, "plan").scene;
    const screened = (prims: typeof scene.primitives) => prims.filter((p) => p.kind === "line" && p.tone === "halftone").length;
    expect(screened(scene.primitives) - screened(withPackSet(set, () => buildViewScene(m, "plan").scene).primitives)).toBe(1);
    expect(scene.tags.filter((t) => t.elementId === "CV-1")).toEqual([]);
    expect(scene.primitives.filter((p) => p.kind === "text" && p.text === "CV-1")).toEqual([]);
    expect(pickAt(buildViewPickIndex(m, view(m)), { x: 5000, y: Y }, 10)).not.toContain("CV-1");
    expect(m.elements["CV-1"]).toMatchObject({ kind: "k13cv.conveyor", start: A, end: B });
  });
});
