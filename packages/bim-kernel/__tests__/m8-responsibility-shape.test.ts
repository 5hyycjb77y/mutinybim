/**
 * @jest-environment node
 *
 * Round 8 (contract 1.5.0, NEXT-BATCH-8 §8.2): responsible professionals are
 * many-to-many and scoped. Reserved in step 8a; lane M writes the rows and
 * approvals. Round 7 had no responsibility shape at all.
 */
import { coveringResponsibilities, requiredApprovals, type BimElement, type CoverageContext, type Responsibility } from "@permitzip/bim-kernel";

function part(id: string, discipline: string, level = "L1", system = "sys-a"): BimElement {
  // A minimal element: coverage reads only id, partition and the context.
  return { id, kind: "part", version: 1, authoredRev: {}, partition: { level, zone: "Z1", discipline }, typeId: "pt", values: {}, system } as unknown as BimElement;
}

const ctx: CoverageContext = {
  disciplineOf: (el) => el.partition?.discipline ?? "general",
  classOf: () => undefined,
  isA: (c, a) => c === a,
  systemsOf: (el) => [String((el as unknown as { system: string }).system)],
  groupsOf: () => [],
  sheetsOf: () => [],
  matches: () => true,
};

const ACCEPTED = "2026-10-31T22:00:00Z";
const hvac: Responsibility = { id: "r-hvac", party: { kind: "person", ref: "u1", label: "J. Rao" }, discipline: "mechanical", scope: { systems: ["sys-a"] }, acceptedAt: ACCEPTED };
const exhaust: Responsibility = { id: "r-exhaust", party: { kind: "person", ref: "u2", label: "K. Example" }, discipline: "mechanical", scope: { systems: ["sys-b"] }, acceptedAt: ACCEPTED };
const mechAll: Responsibility = { id: "r-mech", party: { kind: "person", ref: "u3", label: "M. Lee" }, discipline: "mechanical", acceptedAt: ACCEPTED };
const fp: Responsibility = { id: "r-fp", party: { kind: "firm", ref: "f1", label: "Acme Fire" }, discipline: "fire_protection", acceptedAt: ACCEPTED };

describe("m8 responsibility shape and coverage", () => {
  it("m8-two-mechanical-pes: two engineers on mechanical each approve only the systems they cover", () => {
    const cover = coveringResponsibilities([part("a", "mechanical", "L1", "sys-a"), part("b", "mechanical", "L1", "sys-b")], [hvac, exhaust], ctx);
    expect(cover.map((c) => [c.elementId, c.covering.map((r) => r.id), c.fallback])).toEqual([
      ["a", ["r-hvac"], null],
      ["b", ["r-exhaust"], null],
    ]);
    expect(requiredApprovals(cover).map((a) => a.anyOf.map((r) => r.party.label))).toEqual([["J. Rao"], ["K. Example"]]);
  });

  it("m8-any-one-of: overlapping scopes need each covering approver, unless the firm's rule is any one of them", () => {
    const both: Responsibility = { ...exhaust, scope: { systems: ["sys-a"] } };
    const cover = coveringResponsibilities([part("a", "mechanical")], [hvac, both], ctx);
    expect(requiredApprovals(cover)).toHaveLength(2);
    const anyOne = requiredApprovals(cover, () => "any_one");
    expect(anyOne).toHaveLength(1);
    expect(anyOne[0]?.anyOf.map((r) => r.id).sort()).toEqual(["r-exhaust", "r-hvac"]);
  });

  it("m8-uncovered-falls-to-default: an element no scoped row covers goes to the discipline's unscoped row", () => {
    const [c] = coveringResponsibilities([part("c", "mechanical", "L1", "sys-z")], [hvac, mechAll], ctx);
    expect([c?.fallback, c?.covering.map((r) => r.id)]).toEqual(["discipline_default", ["r-mech"]]);
  });

  it("m8-uncovered-falls-to-project-lead: no accepted row at all, shown as the project lead", () => {
    const cover = coveringResponsibilities([part("e", "electrical")], [hvac], ctx);
    expect(cover[0]?.fallback).toBe("project_lead");
    expect(requiredApprovals(cover)).toEqual([{ discipline: "electrical", anyOf: [], projectLead: true, elementIds: ["e"] }]);
  });

  it("m8-unaccepted-cannot-approve: a named person who hasn't accepted covers nothing", () => {
    const { acceptedAt: _accepted, ...named } = hvac;
    expect(coveringResponsibilities([part("a", "mechanical")], [named], ctx)[0]?.fallback).toBe("project_lead");
  });

  it("a child discipline with no rows of its own falls to its parent's rows", () => {
    const [c] = coveringResponsibilities([part("fa1", "fire_alarm")], [fp], ctx);
    expect([c?.discipline, c?.covering.map((r) => r.id), c?.fallback]).toEqual(["fire_alarm", ["r-fp"], "discipline_default"]);
    const own: Responsibility = { id: "r-fa", party: { kind: "person", ref: "u9", label: "P. Diaz" }, discipline: "fire_alarm", acceptedAt: ACCEPTED };
    expect(coveringResponsibilities([part("fa1", "fire_alarm")], [fp, own], ctx)[0]?.covering.map((r) => r.id)).toEqual(["r-fa"]);
  });

  it("levels narrow a scope", () => {
    const l2: Responsibility = { ...hvac, id: "r-l2", scope: { levels: ["L2"] } };
    const cover = coveringResponsibilities([part("x", "mechanical", "L1"), part("y", "mechanical", "L2")], [l2], ctx);
    expect(cover.map((c) => c.fallback)).toEqual(["project_lead", null]);
  });
});
