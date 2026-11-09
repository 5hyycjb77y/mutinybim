/**
 * @jest-environment node
 *
 * Round 15 lane E15 (E2): keep adding devices to one circuit while placing.
 * AUDIT §5 E2: "Circuiting is after the fact; no 'keep adding to this
 * circuit' while placing." Electrical › Circuits › Continue circuit › L1 ›
 * place 4 receptacles → all four on one circuit, each placement one edit.
 *
 * Each device joins through Electrical's connect face (the "+" grip's), and
 * the face now reads positions a circuit already holds as "join that
 * circuit". Fails on the old code: the face started a second circuit on
 * those spaces (or refused: they were taken), and `planContinueCircuit` did
 * not exist.
 */
import type { ElementId } from "@permitzip/bim-kernel";
import { electricalConnect, newUncircuitedDevices, panelCircuits, planContinueCircuit, type ContinueCircuitTarget } from "../src";
import { Building } from "../../bim-kernel/__tests__/fixtures/electrical-building";

function linkOf(b: Building, partId: string): string | null {
  const p = b.head.elements[partId];
  if (p?.kind !== "part") return null;
  return Object.values(p.served ?? {})[0] ?? null;
}

function runAll(b: Building, commands: readonly Parameters<Building["ok"]>[0][]): void {
  for (const c of commands) b.ok(c);
}

describe("e15-continue-circuit", () => {
  it("four receptacles placed one after another all land on the one circuit the first started", () => {
    const b = new Building();
    b.place("l1", "panel208", { panel_name: "L1" }, "L1", { x: -6000, y: 0 });
    let target: ContinueCircuitTarget = { panelId: "l1", linkId: null, newLinkId: "c-new" };
    const known = new Set(Object.keys(b.head.elements));
    for (const [i, x] of [0, 2000, 4000, 6000].entries()) {
      b.place(`r${i}`, "receptacle", { voltage: 120, load_va: 180 }, `R${i}`, { x, y: 0 });
      const placed = newUncircuitedDevices(b.head, known);
      expect(placed).toEqual([`r${i}`]);
      const plan = planContinueCircuit(b.head, `r${i}`, target);
      if (!plan.ok) throw new Error(plan.reason);
      // One device, one edit: nothing else is moved.
      expect(plan.commands).toHaveLength(1);
      runAll(b, plan.commands);
      target = { ...target, linkId: plan.linkId };
      for (const id of placed) known.add(id);
    }
    expect(new Set([0, 1, 2, 3].map((i) => linkOf(b, `r${i}`)))).toEqual(new Set(["c-new"]));
    expect(panelCircuits(b.head, "l1")).toEqual([expect.objectContaining({ linkId: "c-new", members: 4 })]);
  });

  it("joining an existing circuit: the connect face reads the circuit's spaces as that circuit", () => {
    const b = new Building();
    b.place("l1", "panel208", { panel_name: "L1" }, "L1", { x: -6000, y: 0 });
    b.place("a", "receptacle", { voltage: 120, load_va: 180 }, "A", { x: 0, y: 0 });
    b.place("z", "receptacle", { voltage: 120, load_va: 180 }, "Z", { x: 2000, y: 0 });
    b.ok({ type: "create_service_link", linkId: "c3", sourceId: "l1", positions: [3], members: [{ elementId: "a" }] });
    const plan = electricalConnect(b.head, { elementId: "z" as ElementId }, { sourceId: "l1" as ElementId, label: "L1", distanceMm: 0, positions: [3] }, "c-other");
    expect(plan?.ok).toBe(true);
    if (!plan?.ok) return;
    runAll(b, plan.commands);
    expect(linkOf(b, "z")).toBe("c3");
    expect(b.head.elements["c-other"]).toBeUndefined();
  });

  it("free spaces still start a new circuit there, as the grip's drop always did", () => {
    const b = new Building();
    b.place("l1", "panel208", { panel_name: "L1" }, "L1", { x: -6000, y: 0 });
    b.place("z", "receptacle", { voltage: 120, load_va: 180 }, "Z", { x: 2000, y: 0 });
    const plan = electricalConnect(b.head, { elementId: "z" as ElementId }, { sourceId: "l1" as ElementId, label: "L1", distanceMm: 0, positions: [5] }, "c-5");
    if (!plan?.ok) throw new Error("expected a plan");
    runAll(b, plan.commands);
    const link = b.head.elements["c-5"];
    expect(link?.kind === "service_link" ? link.source.positions : null).toEqual([5]);
  });

  it("refuses in words when the circuit was undone, or the device can't go on that panel", () => {
    const b = new Building();
    b.place("l1", "panel208", { panel_name: "L1" }, "L1", { x: -6000, y: 0 });
    b.place("z", "receptacle", { voltage: 120, load_va: 180 }, "Z", { x: 2000, y: 0 });
    const gone = planContinueCircuit(b.head, "z", { panelId: "l1", linkId: "c-undone", newLinkId: "c-x" });
    expect(gone).toEqual({ ok: false, reason: expect.stringMatching(/circuit is gone/) });
    const noPanel = planContinueCircuit(b.head, "z", { panelId: "nope", linkId: null, newLinkId: "c-x" });
    expect(noPanel).toEqual({ ok: false, reason: expect.stringMatching(/panel is gone/) });
  });
});
