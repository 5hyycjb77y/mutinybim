/**
 * The model server itself keeps existing circuits in place and lets every
 * piece of electrical equipment hold the fault-current figures (ROADMAP E3,
 * E5). The Panel view refused these moves in its own code, but the commands
 * did not: on the old code `edit_service_link` and `reposition_service_links`
 * renumbered an existing circuit for the agent or any other caller, and
 * `set_parameters` refused `available_fault_current` / `impedance_pct` on
 * equipment types that don't declare them ("… has no parameter …").
 */
import { fieldPaths, resolveField, type ServiceLink } from "../src";
import { stacksOf } from "@permitzip/bim-pack-plumbing";
import { Building, referenceDistribution } from "./fixtures/electrical-building";
import { STACK_SAN, stackRisers } from "./fixtures/stack-risers";

function withExisting(): Building {
  const b = referenceDistribution();
  b.place("r0", "receptacle", { voltage: 120, load_va: 1000 });
  b.place("r1", "receptacle", { voltage: 120, load_va: 1100 });
  b.ok({ type: "create_service_link", linkId: "c0", sourceId: "l1", positions: [1], members: [{ elementId: "r0" }], description: "Existing load" });
  b.ok({ type: "create_service_link", linkId: "c1", sourceId: "l1", positions: [3], members: [{ elementId: "r1" }], description: "New load" });
  b.ok({ type: "set_element_phases", ids: ["c0"], phaseCreated: "phase-existing" });
  return b;
}

const positions = (b: Building, id: string) => (b.el(id) as ServiceLink).source.positions;

describe("existing circuits are locked in the commands, not only in the panel view", () => {
  it("edit_service_link refuses a renumber or a move and still takes a new description", () => {
    const b = withExisting();
    expect(b.refused({ type: "edit_service_link", linkId: "c0", positions: [5] })).toMatch(/^L1-1 is an existing circuit \(made in Existing\), so it keeps its panel and circuit number/);
    expect(b.refused({ type: "edit_service_link", linkId: "c0", sourceId: "h1" })).toMatch(/^L1-1 is an existing circuit .* To move it,/);
    expect(positions(b, "c0")).toEqual([1]);
    b.ok({ type: "edit_service_link", linkId: "c0", description: "Existing load (verified)" });
    b.ok({ type: "edit_service_link", linkId: "c1", positions: [5] });
    expect(positions(b, "c1")).toEqual([5]);
  });

  it("reposition_service_links refuses to move an existing circuit and moves new ones", () => {
    const b = withExisting();
    expect(b.refused({ type: "reposition_service_links", sourceId: "l1", moves: [{ linkId: "c0", positions: [7] }] })).toMatch(/^L1-1 is an existing circuit/);
    expect(positions(b, "c0")).toEqual([1]);
    b.ok({ type: "reposition_service_links", sourceId: "l1", moves: [{ linkId: "c1", positions: [7] }] });
    expect(positions(b, "c1")).toEqual([7]);
  });
});

describe("tags and templates read a stack's fields through the one resolver", () => {
  // On the old code resolveField had no stack.* paths: a tag template "{stack.tag}" printed blank on plans.
  it("resolves stack.tag on any pipe of a named stack and lists the stack paths for the tag style picker", () => {
    const b = stackRisers();
    const san = stacksOf(b.head.elements).stacks.find((s) => s.systemId === STACK_SAN.id && s.chain.offsets.length === 0);
    if (!san) throw new Error("no sanitary stack");
    b.ok({ type: "name_stacks", stacks: [{ stackId: "stk-a", pipeId: san.key, number: "19", serves: "K/L" }] });
    expect(resolveField(b.head.elements, san.chain.pieces[1] ?? san.key, "stack.tag").text).toBe('4"//S/K/L//19');
    expect(fieldPaths().map((p) => p.path)).toEqual(expect.arrayContaining(["stack.tag", "stack.number"]));
  });
});

describe("electrical equipment holds the fault-current figures without declaring them", () => {
  it("takes available fault current and %Z on equipment, checks their ranges, and refuses them elsewhere", () => {
    const b = referenceDistribution();
    b.ok({ type: "set_parameters", id: "mdp", scope: "instance", values: { available_fault_current: 22_000 } });
    b.ok({ type: "set_parameters", id: "t1", scope: "instance", values: { impedance_pct: 5.75 } });
    expect(b.refused({ type: "set_parameters", id: "t1", scope: "instance", values: { impedance_pct: 40 } })).toMatch(/Impedance \(%Z\)/);
    expect(b.refused({ type: "set_parameters", id: "mdp", scope: "instance", values: { available_fault_current: -1 } })).toMatch(/Available fault current/);
    b.place("r9", "receptacle", { voltage: 120, load_va: 180 });
    expect(b.refused({ type: "set_parameters", id: "r9", scope: "instance", values: { available_fault_current: 10_000 } })).toMatch(/has no parameter available_fault_current/);
  });
});
