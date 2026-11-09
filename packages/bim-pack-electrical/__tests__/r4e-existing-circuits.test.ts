/**
 * Existing circuits on a renovation (ROADMAP E3, Elec review 09:00–09:06):
 * a circuit made in an earlier phase than the one being designed keeps its
 * panel and circuit number. Rebalance leaves it where it is, the circuit-text
 * proposals put no new loads on it, and moving or renumbering it is refused in
 * plain words. "Existing" is the model's own phase (`set_element_phases` on
 * the circuit), not a new flag.
 *
 * On the old code Rebalance moved the existing circuits like any other (the
 * first test shows the unmarked plan moves them), proposals added new devices
 * to them, and nothing said a circuit was existing.
 */
import { type ServiceLink } from "@permitzip/bim-kernel";
import { existingCircuitRefusal, existingPhaseOf, panelSchedule, planRebalance, proposeLinksFromText } from "@permitzip/bim-pack-electrical";
import { Building, referenceDistribution } from "../../bim-kernel/__tests__/fixtures/electrical-building";

function lopsided(): Building {
  const b = referenceDistribution();
  // Everything on phase A: slots 1, 2, 7, 8.
  [1, 2, 7, 8].forEach((slot, i) => {
    b.place(`r${i}`, "receptacle", { voltage: 120, load_va: 1000 + 100 * i });
    b.ok({ type: "create_service_link", linkId: `c${i}`, sourceId: "l1", positions: [slot], members: [{ elementId: `r${i}` }], description: `Load ${i}` });
  });
  return b;
}

function markExisting(b: Building, ids: string[]): void {
  b.ok({ type: "set_element_phases", ids, phaseCreated: "phase-existing" });
}

const link = (b: Building, id: string) => b.el(id) as ServiceLink;

describe("existing circuits keep their panel and number", () => {
  it("Rebalance moves every circuit when none is existing, and leaves existing ones where they are", () => {
    const unmarked = planRebalance(lopsided().head.elements, "l1");
    const movedBefore = new Set(unmarked?.moves.map((m) => m.linkId));
    expect([...movedBefore].some((id) => id === "c2" || id === "c3")).toBe(true);
    expect(unmarked?.existingKept).toBeUndefined();

    const b = lopsided();
    markExisting(b, ["c2", "c3"]);
    const plan = planRebalance(b.head.elements, "l1");
    expect(plan?.moves.map((m) => m.linkId)).not.toContain("c2");
    expect(plan?.moves.map((m) => m.linkId)).not.toContain("c3");
    expect(plan?.existingKept).toEqual(["L1-7", "L1-8"]);
    expect(plan?.message).toMatch(/ 2 existing circuits stay where they are \(L1-7, L1-8\)\.$/);
    if (plan?.command) b.ok(plan.command);
    expect(link(b, "c2").source.positions).toEqual([7]);
    expect(link(b, "c3").source.positions).toEqual([8]);
  });

  it("the panel view marks them existing with the phase they were made in", () => {
    const b = lopsided();
    markExisting(b, ["c0"]);
    const circuits = panelSchedule(b.head.elements, "l1")?.circuits ?? [];
    expect(circuits.find((c) => c.linkId === "c0")?.existing).toEqual({ phase: "Existing" });
    expect(circuits.find((c) => c.linkId === "c1")?.existing).toBeUndefined();
  });

  it("moving or renumbering an existing circuit is refused in plain words; its description may change", () => {
    const b = lopsided();
    markExisting(b, ["c0"]);
    const c0 = link(b, "c0");
    expect(existingCircuitRefusal(b.head.elements, c0, { positions: [3] })).toBe(
      "L1-1 is an existing circuit (made in Existing), so it keeps its panel and circuit number on this renovation. To renumber it, set its phase to the one you are designing first.",
    );
    expect(existingCircuitRefusal(b.head.elements, c0, { sourceId: "h1" })).toMatch(/^L1-1 is an existing circuit .* To move it,/);
    expect(existingCircuitRefusal(b.head.elements, c0, { positions: [1] })).toBeNull();
    expect(existingCircuitRefusal(b.head.elements, c0, {})).toBeNull();
    expect(existingCircuitRefusal(b.head.elements, link(b, "c1"), { positions: [3] })).toBeNull();
  });

  it("circuit text does not put a new device on an existing circuit; an existing device may join it", () => {
    const b = lopsided();
    markExisting(b, ["c0"]);
    b.place("new1", "receptacle", { voltage: 120, load_va: 180, circuit: "L1-1" }, "R-NEW");
    const p = proposeLinksFromText(b.head).find((x) => x.id === "branch:l1:1");
    expect(p?.status).toBe("refused");
    expect(p?.command).toBeNull();
    expect(p?.reason).toBe("Their circuit text says L1-1, but L1-1 is an existing circuit (made in Existing): it keeps what it serves on this renovation, so put R-NEW on a new circuit");

    const old = lopsided();
    markExisting(old, ["c0"]);
    old.place("old1", "receptacle", { voltage: 120, load_va: 180, circuit: "L1-1" }, "R-OLD");
    markExisting(old, ["old1"]);
    expect(proposeLinksFromText(old.head).find((x) => x.id === "branch:l1:1")?.status).toBe("ready");
  });

  it("while the engineer draws existing conditions (active phase Existing), nothing is locked", () => {
    const b = lopsided();
    markExisting(b, ["c0"]);
    expect(existingPhaseOf(b.head.elements, link(b, "c0"))).toBe("Existing");
    b.ok({ type: "set_active_phase", phaseId: "phase-existing" });
    expect(existingPhaseOf(b.head.elements, link(b, "c0"))).toBeNull();
  });
});
