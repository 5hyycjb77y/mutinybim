/**
 * @jest-environment node
 *
 * Round 12 lane E: wire hash marks on home runs. The view's "Wire hash marks"
 * draws one mark per conductor across each circuit's home run: a long mark
 * per hot (from the breaker's poles), a short one for the neutral (a
 * single-pole circuit, or one that states a neutral), and with the ground
 * style a long mark with a foot for the ground. Off (the default) draws
 * nothing new, so old plans print as before.
 *
 * On round 11's code there were no hash marks.
 */
import { type ModelState, type PartInstance, type Primitive, type Vec2, type ViewElement } from "@permitzip/bim-kernel";
import { circuitConductorMarks, drawCircuitGraphics, resolveCircuitGraphics } from "@permitzip/bim-pack-electrical";
import { Building } from "../../bim-kernel/__tests__/fixtures/electrical-building";

const SCALE = 48;

function building(): Building {
  const b = new Building();
  b.place("p1", "panel208", { panel_name: "P1" }, "P1", { x: -6000, y: 0 });
  b.place("r1", "receptacle", { voltage: 120, load_va: 180 }, "R1", { x: 0, y: 0 });
  b.place("r2", "receptacle", { voltage: 120, load_va: 180 }, "R2", { x: 3000, y: 0 });
  b.place("wh", "equip2", { voltage: 208, load_va: 4500 }, "WH-1", { x: 0, y: 4000 });
  b.ok({ type: "create_service_link", linkId: "c1", sourceId: "p1", positions: [1], members: [{ elementId: "r1" }, { elementId: "r2" }] });
  b.ok({ type: "create_service_link", linkId: "c2", sourceId: "p1", positions: [2, 4], members: [{ elementId: "wh" }] });
  b.ok({ type: "create_view", viewId: "v-e1", name: "Level 1 Power", viewType: "floor_plan", crop: { min: { x: -12000, y: -8000 }, max: { x: 12000, y: 8000 } }, props: { level: "Level 1", scale: SCALE, discipline: "electrical", circuitGraphics: { style: "orthogonal" } } });
  return b;
}

/** The plan view with a hash-mark style set beside the kernel's circuit fields (as the add-on stores it). */
function withMarks(m: ModelState, style: string | undefined): ViewElement {
  const v = m.elements["v-e1"];
  if (v?.kind !== "view") throw new Error("no view");
  return { ...v, props: { ...v.props, circuitGraphics: { ...v.props?.circuitGraphics, ...(style ? { hashMarks: style } : {}) } } } as ViewElement;
}

function thinLines(m: ModelState, view: ViewElement): number {
  const shown = new Map<string, PartInstance>();
  for (const el of Object.values(m.elements)) if (el.kind === "part") shown.set(el.id, el);
  const prims: Primitive[] = [];
  const toPaper = (p: Vec2): Vec2 => ({ x: 200 + p.x / SCALE, y: 150 - p.y / SCALE });
  drawCircuitGraphics({ toPaper, scale: SCALE, window: { min: { x: 0, y: 0 }, max: { x: 400, y: 300 } }, prims }, m, view, shown);
  return prims.filter((p) => p.kind === "line" && p.pen === "thin").length;
}

describe("e12: wire hash marks on home runs", () => {
  it("counts conductors from the breaker's poles: hots long, neutral short, ground with a foot", () => {
    const m = building().head;
    expect(circuitConductorMarks(m, "c1", "hots_neutral")).toEqual(["hot", "neutral"]);
    expect(circuitConductorMarks(m, "c1", "hots_neutral_ground")).toEqual(["hot", "neutral", "ground"]);
    expect(circuitConductorMarks(m, "c2", "hots_neutral_ground")).toEqual(["hot", "hot", "ground"]);
    expect(circuitConductorMarks(m, "c2", "off")).toEqual([]);
  });

  it("draws them across each home run only when the view asks", () => {
    const m = building().head;
    expect(resolveCircuitGraphics(withMarks(m, undefined)).hashMarks).toBe("off");
    const off = thinLines(m, withMarks(m, undefined));
    // c1: hot + neutral = 2; c2: two hots = 2.
    expect(thinLines(m, withMarks(m, "hots_neutral")) - off).toBe(4);
    // Plus a ground mark and its foot on each circuit.
    expect(thinLines(m, withMarks(m, "hots_neutral_ground")) - off).toBe(8);
    expect(thinLines(m, withMarks(m, "nonsense"))).toBe(off);
  });
});
