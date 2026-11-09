/**
 * @jest-environment node
 *
 * Round 9 lane A9: tree totals by service. A pipe (or conduit, or sprinkler)
 * leaf on an air tree no longer adds to the air total, and a pipe on the tree
 * keeps no air total of its own. Fails on round 8b's code: the air total
 * summed every leaf on the tree, so the shared-tree fixture (written by 8b)
 * has the water terminal's 300 inside the unit's 650.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { executeCommand, recomputeDerived, type BimElement, type ElementId, type ModelState } from "@permitzip/bim-kernel";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { airflowOf, computeAirflow, storedAirflowOf } from "@permitzip/bim-pack-mechanical";

interface Fixture {
  readonly head: ModelState;
  readonly expected: { readonly airflow: Readonly<Record<string, number>> };
}

const shared = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "stored-changesets", "r8-shared-tree.json"), "utf8")) as Fixture;
const id = (s: string) => s as ElementId;

describe("a9 pipe not in the air total", () => {
  it("round 8b counted the water terminal on the air tree (the stored fixture)", () => {
    expect(shared.expected.airflow["ahu-1"]).toBe(650);
    expect(shared.expected.airflow["seg-trunk"]).toBe(650);
  });

  it("now only air leaves count: the unit and the trunk carry 350, the water terminal has no airflow", () => {
    const totals = computeAirflow(shared.head);
    expect(totals.get(id("ahu-1"))).toBe(350);
    expect(totals.get(id("seg-trunk"))).toBe(350);
    expect(totals.get(id("seg-run-1"))).toBe(350);
    expect(totals.get(id("seg-run-2"))).toBe(0);
    const water = shared.head.elements["sd-2"] as BimElement;
    expect(airflowOf(water)).toBeNull();
    // Its stored value is kept as stored; it just isn't air.
    expect(storedAirflowOf(water)).toBe(300);
  });

  it("re-deriving the stored model corrects the air ducts' totals and nothing else", () => {
    const r = recomputeDerived(shared.head);
    expect([...r.changedIds].sort()).toEqual(["ahu-1", "seg-riser-2", "seg-run-2", "seg-trunk"].sort());
    expect(airflowOf(r.model.elements["ahu-1"] as BimElement)).toBe(350);
    expect(airflowOf(r.model.elements["seg-run-2"] as BimElement)).toBe(0);
  });

  it("on the full-BIM trees, editing a water leaf changes no air total and keeps every water record's stored value", () => {
    const model = recomputeDerived(createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "a9-pipe-xs" })).model;
    const water = Object.values(model.elements).find((el) => el.kind === "terminal" && el.service === "water");
    if (!water) throw new Error("no water terminal in the XS model");
    const before = computeAirflow(model);
    const r = executeCommand(model, { type: "set_terminal_cfm", terminalId: water.id, cfm: (storedAirflowOf(water) ?? 0) + 7 });
    if (!r.ok) throw new Error(r.error.message);
    const after = computeAirflow(r.model);
    for (const el of Object.values(r.model.elements)) {
      if (airflowOf(el) !== null) expect([el.id, after.get(el.id)]).toEqual([el.id, before.get(el.id)]);
      else if (el.kind === "duct_segment" || el.kind === "equipment") expect([el.id, storedAirflowOf(el)]).toEqual([el.id, storedAirflowOf(model.elements[el.id] as BimElement)]);
    }
    expect(r.changedIds).toEqual([water.id]);
  });
});
