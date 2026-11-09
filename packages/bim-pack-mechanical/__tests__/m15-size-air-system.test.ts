/**
 * @jest-environment node
 *
 * M2 (round 15): Mechanical › Analyze › Size ducts sizes every duct run of
 * the selected air system from the airflow it carries, by the system's own
 * sizing rule (friction rate and velocity limit, round 12), as one edit with
 * a list of what changed and what couldn't be sized. Round 14 sized one run
 * at a time from its Properties (`suggestDuctSize` per run); there was no
 * whole-system plan.
 */
import { sizeLabel, validateModel } from "@permitzip/bim-kernel";
import { DIFFUSER, FT, IN, K15Model, SA } from "../../bim-kernel/__tests__/k15-fixtures";
import { previewAirConnect } from "../src/connect/terminals";
import { airSystemsOfSelection, planSizeAirSystems } from "../src/routing/size-system";

/** A 24x20 supply trunk (far too big) with `n` 150 CFM diffusers connected to it, and a dead-end 10" round stub carrying nothing. */
function oversized(n: number): K15Model {
  const m = new K15Model();
  m.ok({ type: "route_run", idPrefix: "trunk", levelId: "lvl-1", domain: "duct", size: { shape: "rect", width: 24 * IN, height: 20 * IN }, elevationMm: 10 * FT, system: SA, points: [{ x: -4 * FT, y: 0 }, { x: (8 * n + 4) * FT, y: 0 }] });
  for (let i = 0; i < n; i++) m.place(`sd-${i + 1}`, DIFFUSER, (4 + 8 * i) * FT, 5 * FT, 8 * FT, `SD-${i + 1}`);
  const ids = Array.from({ length: n }, (_, i) => `sd-${i + 1}`);
  const preview = previewAirConnect(m.head, ids, "ci");
  if ("refused" in preview) throw new Error(preview.refused);
  for (const command of preview.plan.commands) m.ok(command);
  m.ok({ type: "route_run", idPrefix: "stub", levelId: "lvl-1", domain: "duct", size: { shape: "round", diameter: 10 * IN }, elevationMm: 10 * FT, system: SA, points: [{ x: -4 * FT, y: -20 * FT }, { x: 10 * FT, y: -20 * FT }] });
  return m;
}

describe("Size ducts on a whole air system", () => {
  it("a diffuser in the selection finds its system through the duct it is connected to", () => {
    const m = oversized(2);
    expect(airSystemsOfSelection(m.head.elements, ["sd-1"])).toEqual(["sys-sa"]);
    expect(airSystemsOfSelection(m.head.elements, ["trunk-s1", "sd-2"])).toEqual(["sys-sa"]);
  });

  it("plans every run by the system's own rule, lists what changes and what can't be sized, changes nothing", () => {
    const m = oversized(4);
    const head = m.head;
    const plan = planSizeAirSystems(m.head, ["sys-sa"]);
    expect(m.head).toBe(head);
    expect(plan.systems).toEqual([expect.objectContaining({ systemId: "sys-sa", name: "Supply Air 1", criteria: expect.objectContaining({ frictionInPer100Ft: 0.08, maxVelocityFpm: 2000 }) })]);
    // The trunk carries 600 CFM: it narrows, keeping its 20" depth no deeper than the ceiling set it.
    const trunk = plan.changes.find((c) => c.runId.startsWith("trunk-"));
    if (!trunk) throw new Error(`the trunk wasn't resized: ${JSON.stringify(plan)}`);
    expect(trunk.cfm).toBe(600);
    expect(trunk.to.shape === "rect" && trunk.to.height).toBe(20 * IN);
    expect(trunk.to.shape === "rect" && trunk.to.width).toBeLessThan(24 * IN);
    expect(trunk.frictionInPer100Ft).toBeLessThanOrEqual(0.08);
    // At 600 CFM a 20" deep trunk could be 8" wide, but it carries 8" taps: it stays 2" wider than they are.
    expect(trunk.limitedBy).toBe("branches");
    expect(trunk.to.shape === "rect" && trunk.to.width).toBe(10 * IN);
    // The stub serves nothing: named with the reason, not resized.
    expect(plan.refused.map((r) => r.reason)).toEqual(expect.arrayContaining([expect.stringMatching(/carries no airflow yet/)]));
    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0]?.type).toBe("batch_edits");
  });

  it("applies as one edit (one undo); a second press has nothing left to change", () => {
    const m = oversized(4);
    const plan = planSizeAirSystems(m.head, ["sys-sa"]);
    const before = m.log.length;
    for (const command of plan.commands) m.ok(command);
    expect(m.log.length).toBe(before + 1);
    const trunk = plan.changes.find((c) => c.runId.startsWith("trunk-"));
    if (!trunk) throw new Error("no trunk change");
    expect(sizeLabel(m.seg(trunk.runId).size)).toBe(sizeLabel(trunk.to));
    expect(validateModel(m.head)).toEqual([]);
    const again = planSizeAirSystems(m.head, ["sys-sa"]);
    expect(again.changes).toEqual([]);
    expect(again.commands).toEqual([]);
    expect(again.kept).toBeGreaterThan(0);
  });

  it("follows the system's own friction rate: a tighter rule gives a bigger duct", () => {
    const loose = oversized(10);
    const tight = oversized(10);
    tight.ok({ type: "set_system_design", systemId: "sys-sa", design: { sizing: { frictionInPer100Ft: 0.04 } } });
    const width = (m: K15Model) => {
      const c = planSizeAirSystems(m.head, ["sys-sa"]).changes.find((x) => x.runId.startsWith("trunk-"));
      return c?.to.shape === "rect" ? c.to.width : 0;
    };
    expect(width(tight)).toBeGreaterThan(width(loose));
  });

  it("nothing selected on an air system plans nothing", () => {
    const m = oversized(1);
    expect(airSystemsOfSelection(m.head.elements, ["lvl-1"])).toEqual([]);
    expect(planSizeAirSystems(m.head, []).commands).toEqual([]);
  });
});
