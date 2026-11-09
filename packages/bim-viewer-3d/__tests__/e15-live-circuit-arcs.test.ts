/**
 * @jest-environment node
 *
 * Round 15 lane E15 (E1): circuits show in the live plan as you make them.
 * AUDIT §5 E1: "Circuit arcs, home runs and circuit tags show on the printed
 * drawing, never in the live plan." They are drawn by the Electrical add-on's
 * view graphics row (`circuit_lines`); A15's live plan layer only read each
 * record's own plan graphics, so the live plan drew nothing for a circuit.
 *
 * The live plan layer now runs the view graphics rows in force too (the same
 * `drawViewGraphics` call the printed plan makes), at the plan's scale with
 * no sheet edge. Nothing in it names a trade: a fire alarm loop or any other
 * add-on's overlay rides the same call.
 *
 * Fails on the old code: `livePlanSymbols` returned no `view_graphics` lines
 * (and no "P1-1" home-run tag) for a circuit.
 */
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { type ElementId, type ModelState, type PartInstance, type ViewElement } from "@permitzip/bim-kernel";
import { deriveCircuitGraphics } from "@permitzip/bim-pack-electrical";
import { Building } from "../../bim-kernel/__tests__/fixtures/electrical-building";
import { livePlanSymbols, VIEW_GRAPHICS_OWNER, type LivePlanOptions } from "../src/live-plan-graphics";

installFirstPartyAddOns();

const SCALE = 48;
/** The open plan is a power plan (its view settings say electrical), as Level 1 Power is. */
const POWER_PLAN = { props: { discipline: "electrical" } } as const;

function room(): Building {
  const b = new Building();
  b.place("p1", "panel208", { panel_name: "P1" }, "P1", { x: -4000, y: 0 });
  b.place("r1", "receptacle", { voltage: 120, load_va: 180 }, "R1", { x: 2000, y: 300 });
  b.place("r2", "receptacle", { voltage: 120, load_va: 180 }, "R2", { x: 5000, y: 300 });
  b.place("r3", "receptacle", { voltage: 120, load_va: 180 }, "R3", { x: 8000, y: 300 });
  return b;
}

function levelOf(m: ModelState): string {
  const p = m.elements["p1"];
  return p?.partition?.level ?? "L1";
}

function options(m: ModelState, extra: Partial<LivePlanOptions> = {}): LivePlanOptions {
  return { levelId: levelOf(m), scale: SCALE, detail: "medium", levels: null, hasBody: () => true, view: POWER_PLAN, ...extra };
}

const circuitLines = (m: ModelState, extra: Partial<LivePlanOptions> = {}) => livePlanSymbols(m, options(m, extra)).segments.filter((s) => s.owner === VIEW_GRAPHICS_OWNER);
const circuitTexts = (m: ModelState, extra: Partial<LivePlanOptions> = {}) => livePlanSymbols(m, options(m, extra)).texts.filter((t) => t.owner === VIEW_GRAPHICS_OWNER).map((t) => t.text);

function shown(m: ModelState): Map<string, PartInstance> {
  const out = new Map<string, PartInstance>();
  for (const el of Object.values(m.elements)) if (el.kind === "part") out.set(el.id, el);
  return out;
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

describe("e15-live-circuit-arcs", () => {
  it("no circuit, no circuit lines; adding devices to a circuit draws its arcs and home run at once", () => {
    const b = room();
    expect(circuitLines(b.head)).toEqual([]);
    b.ok({ type: "create_service_link", linkId: "c1", sourceId: "p1", positions: [1], members: [{ elementId: "r1" }, { elementId: "r2" }] });
    const two = circuitLines(b.head);
    expect(two.length).toBeGreaterThan(0);
    expect(circuitTexts(b.head)).toContain("P1-1");
    b.ok({ type: "add_link_members", linkId: "c1", members: [{ elementId: "r3" }] });
    expect(circuitLines(b.head).length).toBeGreaterThan(two.length);
  });

  it("the live lines are the printed lines: every arc between devices is on the live plan, in model millimetres", () => {
    const b = room();
    b.ok({ type: "create_service_link", linkId: "c1", sourceId: "p1", positions: [1], members: [{ elementId: "r1" }, { elementId: "r2" }, { elementId: "r3" }] });
    const view: ViewElement = { id: "v" as ElementId, kind: "view", version: 0, authoredRev: {}, name: "Live", viewType: "floor_plan", cropMin: { x: -1e9, y: -1e9 }, cropMax: { x: 1e9, y: 1e9 }, props: { level: levelOf(b.head), scale: SCALE, discipline: "electrical" } };
    const printed = deriveCircuitGraphics(b.head, view, shown(b.head), SCALE).find((g) => g.key === "c1");
    expect(printed).toBeDefined();
    const live = circuitLines(b.head);
    const pathPoints = (printed?.paths ?? []).flat();
    expect(pathPoints.length).toBeGreaterThan(0);
    // Every point the printed drawing's arcs pass through is an end of a live segment (arcs are chorded the same way).
    for (const p of pathPoints) expect(live.some((s) => (near(s.a.x, p.x) && near(s.a.y, p.y)) || (near(s.b.x, p.x) && near(s.b.y, p.y)))).toBe(true);
  });

  it("the open view's settings ride through: a plan whose circuit lines are off (or an architectural plan) draws none, as its print does", () => {
    const b = room();
    b.ok({ type: "create_service_link", linkId: "c1", sourceId: "p1", positions: [1], members: [{ elementId: "r1" }, { elementId: "r2" }] });
    expect(circuitLines(b.head, { view: { props: { discipline: "electrical", circuitGraphics: { style: "off" } } } })).toEqual([]);
    expect(circuitLines(b.head, { view: { props: { discipline: "architecture" } } })).toEqual([]);
    expect(circuitLines(b.head, { view: { props: { circuitGraphics: { style: "orthogonal" } } } }).length).toBeGreaterThan(0);
  });

  it("devices hidden by the view, or on another level, draw no circuit", () => {
    const b = room();
    b.ok({ type: "create_service_link", linkId: "c1", sourceId: "p1", positions: [1], members: [{ elementId: "r1" }, { elementId: "r2" }] });
    expect(circuitLines(b.head, { levels: new Set(["nowhere"]) })).toEqual([]);
    expect(circuitLines(b.head, { hidden: () => true })).toEqual([]);
  });
});
