/**
 * @jest-environment node
 *
 * Round 13 lane P13: a bathroom group made a typical with 24 instances (the
 * original and 23 copies, one mirrored) draws its three stubs on every
 * instance: 72 stubs on plan, a copy's tagged "TYP.", the mirrored copy's
 * stubs mirrored with it, and the totals count 3 × 24. A view that turns the
 * stubs off draws none.
 *
 * Fails on round 12's code: stubs existed only as data (`assemblyStubs`);
 * nothing placed them on the copies or drew them (`assemblyStubMarks`,
 * `drawAssemblyStubs`, `typicalStubCount` didn't exist).
 */
import { fixedSpaceLocator, typicalStubCount, type BimElement, type ElementId, type ModelState, type PartInstance, type Primitive } from "@permitzip/bim-kernel";
import { ASSEMBLY_STUBS_VIEW_GRAPHICS, ASSEMBLY_STUB_LENGTH_MM, assemblyStubMarks, drawAssemblyStubs } from "@permitzip/bim-kernel/typicals";

const COPIES = Array.from({ length: 23 }, (_, i) => ({ id: `g-bath:${i + 2}`, mark: String(i + 2).padStart(3, "0"), offset: { x: (i + 1) * 6000, y: 0 }, rotationDeg: 0, ...(i === 0 ? { mirror: { axis: "x" as const } } : {}) }));

const group = {
  id: "g-bath",
  kind: "organization",
  entry: { type: "group", name: "Bathroom 001", color: "#336699", description: "", locked: false, defaultVisibility: "show", order: 1, typical: { label: "Unit", mark: "001", basePoint: { x: 1000, y: 0 }, copies: COPIES } },
} as unknown as BimElement;
const part = (id: string, x: number): BimElement => ({ id, kind: "part", position: { x, y: 2000 }, rotationDeg: 0, groupId: "g-bath" }) as unknown as BimElement;
const load = (id: string, service: string, values: Record<string, number>, attachedPartId: string): BimElement => ({ id, kind: "load_point", version: 1, authoredRev: {}, connectionType: "", values, service, attachedPartId }) as unknown as BimElement;

const els = [group, part("wc-1", 1000), part("lav-1", 3000), load("cw-1", "cold_water", { wsfu_cold: 2.5 }, "wc-1"), load("hw-1", "hot_water", { wsfu_hot: 1.5 }, "lav-1"), load("san-1", "sanitary", { dfu: 4 }, "wc-1")];
const model = { elements: Object.fromEntries(els.map((e) => [e.id, e])), connections: [] } as unknown as ModelState;
const G = "g-bath" as ElementId;

describe("p13-bathroom-stubs-on-plan", () => {
  it("3 stubs on each of 24 instances, copies tagged TYP., totals 3 × 24", () => {
    const marks = assemblyStubMarks(model, G, fixedSpaceLocator({}));
    if ("refused" in marks) throw new Error(marks.refused);
    expect(marks).toHaveLength(72);
    expect(typicalStubCount(model.elements, G, 3)).toBe(72);
    expect(marks.filter((m) => !m.copy).map((m) => m.instanceMark)).toEqual(["001", "001", "001"]);
    const cold = marks.filter((m) => m.serviceId === "cold_water");
    expect(cold[0]?.at).toEqual({ x: 1000, y: 2000 });
    expect(cold[2]?.at).toEqual({ x: 1000 + 12_000, y: 2000 });
  });

  it("the mirrored copy's stubs are mirrored with it", () => {
    const marks = assemblyStubMarks(model, G, fixedSpaceLocator({}));
    if ("refused" in marks) throw new Error(marks.refused);
    const hot = marks.filter((m) => m.serviceId === "hot_water");
    // The lavatory sits 2,000 mm right of the base in the original, 2,000 mm left of it in the mirrored copy.
    expect(hot[0]?.at).toEqual({ x: 3000, y: 2000 });
    expect(hot[1]?.at).toEqual({ x: 1000 - 2000 + 6000, y: 2000 });
    expect(hot[1]?.tip).toEqual({ x: 1000 - 2000 + 6000, y: 2000 + ASSEMBLY_STUB_LENGTH_MM });
  });

  it("draws every stub with its tag on plan; a view that turns them off draws none", () => {
    const shown = new Map<string, PartInstance>([["wc-1", model.elements["wc-1"] as PartInstance]]);
    const prims: Primitive[] = [];
    expect(drawAssemblyStubs({ model, shown, toPaper: (p) => p, prims }, undefined)).toBe(72);
    expect(prims.filter((p) => p.kind === "line")).toHaveLength(72);
    const tags = prims.flatMap((p) => (p.kind === "text" ? [p.text] : []));
    expect(tags.filter((t) => t.endsWith(" TYP."))).toHaveLength(69);
    expect(drawAssemblyStubs({ model, shown, toPaper: (p) => p, prims: [] }, { show: false })).toBe(0);
    expect(ASSEMBLY_STUBS_VIEW_GRAPHICS.hintsKey).toBe("assemblyStubs");
  });
});
