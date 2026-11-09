/**
 * @jest-environment node
 *
 * Round 12 lane E: fault current on the one-line. With the view's "Show
 * fault current" on, every bus prints its available fault current from the
 * same calculation the Fault current strip reads ("AFC 22 kA" at the service,
 * less downstream); with no utility value anywhere it says so ("AFC: utility
 * value needed") instead of printing nothing. Off (the default), the
 * one-line is round 11's, byte for byte (`e12-old-models-open-identically`).
 *
 * On round 11's code the one-line never printed fault current.
 */
import { type ParamDef, type PartTypeDefinition } from "@permitzip/bim-kernel";
import { afcLine, electricalDiagramGraph, faultCurrentAt } from "@permitzip/bim-pack-electrical";
import { Building, distributionType, referenceDistribution } from "../../bim-kernel/__tests__/fixtures/electrical-building";

const num = (name: string, label: string): ParamDef => ({ name, label, kind: "number", unit: "a", min: 0 });
const SWBD: PartTypeDefinition = (() => {
  const t = distributionType("Switchboard", "800A 480Y/277V", 480, "3", 30, 800, "800A MCB");
  return { ...t, instanceParams: [...t.instanceParams, num("aic", "AIC"), num("available_fault_current", "Available fault current")] };
})();

function linesOf(graph: ReturnType<typeof electricalDiagramGraph>, id: string): string[] {
  const walk = (nodes: typeof graph.roots): string[] | null => {
    for (const n of nodes) {
      if (n.elementId === id) return n.lines.map((l) => l.text);
      const found = walk(n.children);
      if (found) return found;
    }
    return null;
  };
  return walk(graph.roots) ?? [];
}

function serviceWithUtilityValue(): Building {
  const b = new Building();
  b.ok({ type: "place_part", partId: "mdp", typeId: "t-swbd", partType: SWBD, levelId: "lvl-1", position: { x: 0, y: 0 }, mark: "MDP", values: { panel_name: "MDP", aic: 65_000, available_fault_current: 22_000 } });
  b.place("h1", "panel480", { panel_name: "H1" });
  b.ok({ type: "create_service_link", linkId: "f-h1", sourceId: "mdp", positions: [1, 3, 5], members: [{ elementId: "h1" }], electrical: { ratingA: 225, lengthFt: 100, conductors: { sets: 1, phaseSize: "4/0", groundSize: "4", material: "cu" } } });
  return b;
}

describe("e12: available fault current on the one-line", () => {
  it("prints AFC at each bus from the fault current calculation when the view asks", () => {
    const b = serviceWithUtilityValue();
    const graph = electricalDiagramGraph(b.head.elements, { faultCurrent: true });
    expect(linesOf(graph, "mdp")).toContain("AFC 22 kA");
    const h1 = faultCurrentAt(b.head.elements, "h1")?.availableA ?? 0;
    expect(h1).toBeGreaterThan(0);
    expect(h1).toBeLessThan(22_000);
    expect(linesOf(graph, "h1")).toContain(afcLine(b.head.elements, "h1"));
    expect(afcLine(b.head.elements, "h1")).toMatch(/^AFC \d+(\.\d)? kA$/);
  });

  it("never prints a blank: with no utility value it says what is needed", () => {
    const b = referenceDistribution();
    const graph = electricalDiagramGraph(b.head.elements, { faultCurrent: true });
    expect(linesOf(graph, "mdp")).toContain("AFC: utility value needed");
    expect(linesOf(graph, "h1")).toContain("AFC: utility value needed");
  });

  it("prints nothing about fault current when the view doesn't ask", () => {
    const b = serviceWithUtilityValue();
    expect(linesOf(electricalDiagramGraph(b.head.elements), "mdp").some((l) => l.startsWith("AFC"))).toBe(false);
  });
});
