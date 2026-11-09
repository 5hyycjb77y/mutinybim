/**
 * @jest-environment node
 *
 * Round 9 lane Q9: submittals beside the design. A submittal is offered for
 * elements or a type and reviewed per item; an approved substitution is a
 * divergence that never touches the design; changing the design is a branch
 * (the kernel offers no command that edits the design from a submittal);
 * responsibility is recorded only when someone sets it; `productChainOf`
 * reads design → submittal → field.
 *
 * Fails on round 8b's code: `add_submittal`, `review_submittal` and
 * `record_divergence` don't parse and there is no chain read.
 */
import { commandSchema, DIVERGENCE_BADGE, divergencesIn, executeCommand, hasDivergence, productChainOf, submittalsDependingOn, submittalsIn, withUpgradePolicy, type Actor, type BimElement, type Command, type ModelState } from "../src";
import { floor } from "./g7-fixtures";

const REVIEWER: Actor = { id: "user-example", name: "K. Example", kind: "human" };
const GC: Actor = { id: "user-gc", name: "Contractor PM", kind: "human" };

function run(m: ModelState, command: Command, actor: Actor, policy: (f: string) => boolean = () => true): ModelState {
  const r = withUpgradePolicy(policy, () => executeCommand(m, commandSchema.parse(command), { actorId: actor.id, actor, at: "2026-11-03T12:00:00.000Z" }));
  if (!r.ok) throw new Error(`${command.type}: ${r.error.message}`);
  return r.model;
}

function withType(m: ModelState): ModelState {
  const wall = m.elements["W-13"];
  if (!wall) throw new Error("fixture wall missing");
  const typed = { ...wall, typeId: "WT-1" } as unknown as BimElement;
  const type = { id: "WT-1", kind: "element_type", version: 1, authoredRev: {}, name: "1 hr partition" } as unknown as BimElement;
  return { ...m, elements: { ...m.elements, "W-13": typed, "WT-1": type } };
}

function submitted(m0: ModelState): ModelState {
  return run(
    m0,
    {
      type: "add_submittal",
      submittalId: "SUB-1",
      title: "Partition product data",
      offeredFor: { typeIds: ["WT-1"] },
      items: [
        { id: "1", label: "Product data" },
        { id: "2", label: "Listing", offeredFor: { elementIds: ["W-13"] } },
      ],
    } as Command,
    GC,
  );
}

describe("q9 submittals", () => {
  it("q9-submittal-three-layers: approved as noted leaves the design type unchanged and shows the divergence with the approver and notes", () => {
    const m0 = withType(floor("q9s-a"));
    let m = submitted(m0);
    m = run(m, { type: "review_submittal", submittalId: "SUB-1", itemId: "1", state: "approved_as_noted", notes: "Provide the listing." } as Command, REVIEWER);
    m = run(m, { type: "record_divergence", divergenceId: "DIV-1", designBasis: { typeIds: ["WT-1"] }, approvedProduct: { label: "Alternate assembly, maker B", submittalId: "SUB-1", itemId: "1" }, notes: "Equivalent rating; thicker." } as Command, REVIEWER);
    expect(m.elements["WT-1"]).toBe(m0.elements["WT-1"]);
    expect(m.elements["W-13"]).toBe(m0.elements["W-13"]);
    const sub = submittalsIn(m.elements)[0]?.submittal;
    expect(sub?.submittedBy).toBe("Contractor PM");
    expect(sub?.items[0]?.review).toMatchObject({ state: "approved_as_noted", reviewer: "K. Example", notes: "Provide the listing." });
    expect(divergencesIn(m.elements)[0]?.divergence).toMatchObject({ approvedBy: "K. Example", notes: "Equivalent rating; thicker." });
    expect(hasDivergence(m.elements, "W-13")).toBe(true);
    expect(DIVERGENCE_BADGE).toBe("Approved substitution: differs from the design. Design not changed.");
  });

  it("q9-update-design-explicit: no submittal command changes a design element; only the branch path does", () => {
    const m0 = withType(floor("q9s-b"));
    let m = submitted(m0);
    m = run(m, { type: "review_submittal", submittalId: "SUB-1", state: "approved" } as Command, REVIEWER);
    m = run(m, { type: "record_divergence", divergenceId: "DIV-1", designBasis: { elementIds: ["W-13"] }, approvedProduct: { label: "Maker B" }, notes: "" } as Command, REVIEWER);
    const changedDesign = Object.keys(m0.elements).filter((id) => m.elements[id] !== m0.elements[id]);
    expect(changedDesign).toEqual([]);
    for (const t of ["update_design_to_match", "apply_divergence", "apply_submittal"]) expect(commandSchema.safeParse({ type: t, divergenceId: "DIV-1" }).success).toBe(false);
  });

  it("q9-divergence-responsibility: recorded only when someone sets it", () => {
    let m = submitted(withType(floor("q9s-c")));
    m = run(m, { type: "record_divergence", divergenceId: "DIV-a", designBasis: { elementIds: ["W-13"] }, approvedProduct: { label: "Maker B" }, notes: "Equal." } as Command, REVIEWER);
    m = run(m, { type: "record_divergence", divergenceId: "DIV-b", designBasis: { elementIds: ["W-12"] }, approvedProduct: { label: "Maker C" }, notes: "", responsibleParty: { label: "Contractor" }, responsibilityNote: "Proposed by the contractor." } as Command, REVIEWER);
    const byId = Object.fromEntries(divergencesIn(m.elements).map((d) => [d.id, d.divergence]));
    expect(byId["DIV-a"]?.responsibleParty).toBeUndefined();
    expect(byId["DIV-b"]).toMatchObject({ responsibleParty: { label: "Contractor" }, responsibilityNote: "Proposed by the contractor." });
  });

  it("q9-chain-of: design → submittal (with the items for this element) → field, for one element and its type", () => {
    let m = submitted(withType(floor("q9s-d")));
    m = run(m, { type: "record_divergence", divergenceId: "DIV-1", designBasis: { typeIds: ["WT-1"] }, approvedProduct: { label: "Maker B", submittalId: "SUB-1" }, notes: "" } as Command, REVIEWER);
    const observation = { id: "OBS-1", kind: "observation", version: 1, authoredRev: {}, observation: { subject: { kind: "element", id: "W-13" }, observedBy: "Inspector", at: "2026-12-01", result: "meets", note: "Installed as approved.", attachments: [] } } as unknown as BimElement;
    m = { ...m, elements: { ...m.elements, "OBS-1": observation } };
    const chain = productChainOf(m.elements, "W-13");
    expect(chain.typeId).toBe("WT-1");
    expect(chain.design).toBe(m.elements["W-13"]);
    expect(chain.submittals.map((s) => [s.submittal.id, s.items.map((i) => i.id)])).toEqual([["SUB-1", ["2"]]]);
    expect(chain.divergences.map((d) => d.id)).toEqual(["DIV-1"]);
    expect(chain.field.map((o) => o.id)).toEqual(["OBS-1"]);
    expect(productChainOf(m.elements, "W-12").submittals).toEqual([]);
    expect(submittalsDependingOn(m.elements, "WT-1").map((s) => s.id)).toEqual(["SUB-1"]);
  });

  it("an older server refuses a submittal in words; a submittal for nothing is refused", () => {
    const m = withType(floor("q9s-e"));
    const r = withUpgradePolicy(() => false, () => executeCommand(m, commandSchema.parse({ type: "add_submittal", submittalId: "S", title: "T", offeredFor: { typeIds: ["WT-1"] }, items: [{ id: "1", label: "A" }] }), { actorId: GC.id, actor: GC }));
    expect(r.ok === false && r.error.message).toMatch(/older version that doesn't store submittals/);
    const empty = withUpgradePolicy(() => true, () => executeCommand(m, commandSchema.parse({ type: "add_submittal", submittalId: "S", title: "T", offeredFor: {}, items: [{ id: "1", label: "A" }] }), { actorId: GC.id, actor: GC }));
    expect(empty.ok === false && empty.error.message).toBe("Say what the submittal is for: pick elements, a type or a requirement");
  });
});
