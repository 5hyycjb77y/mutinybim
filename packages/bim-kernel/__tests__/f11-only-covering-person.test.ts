/**
 * @jest-environment node
 *
 * Round 11 lane F11 (D2): who may record a decision on a finding. A person
 * whose accepted responsibility covers every subject of the finding (round 8
 * coverage, "any one of" included); the project lead for elements no one is
 * responsible for; never an agent; and an override of a reliance finding
 * stays the record's own signer's (C10).
 *
 * Fails on round 10's code: there was no `dispositionRefusal`.
 */
import { modelCoverageContext, type BimElement, type ModelState, type Responsibility } from "../src";
import { dispositionRefusal, type DispositionAuthorityInput } from "../src/findings/api";
import { floor } from "./g7-fixtures";

const RAO = { provider: "test.identity", subject: "user-rao", kind: "person" as const, displayName: "J. Rao" };
const LEE = { provider: "test.identity", subject: "user-lee", kind: "person" as const, displayName: "A. Lee" };
const AGENT = { provider: "test.identity", subject: "agent:user-rao:t1", kind: "agent" as const, onBehalfOf: RAO };
const AT = "2026-11-01T12:00:00.000Z";

/** W-12 is architecture; W-13 is fire protection here. */
function model(): ModelState {
  const m = floor("f11-cover");
  const w13 = m.elements["W-13"] as BimElement & { partition: { level: string; zone: string; discipline: string } };
  return { ...m, elements: { ...m.elements, "W-13": { ...w13, partition: { ...w13.partition, discipline: "fire_protection" } } as unknown as BimElement } };
}

const row = (id: string, person: typeof RAO, discipline: string, approval?: Responsibility["approval"]): Responsibility => ({ id, party: { kind: "person", ref: person.subject, label: person.displayName }, discipline, acceptedAt: AT, ...(approval ? { approval } : {}) });

function input(over: Partial<DispositionAuthorityInput>, responsibilities: readonly Responsibility[]): DispositionAuthorityInput {
  const m = model();
  return {
    by: RAO,
    action: "accepted_known",
    reason: "Known clash; rerouted in the field.",
    finding: { id: "lint_rule:clash-hard:W-12|W-13", source: { kind: "lint_rule", id: "clash-hard", version: "1" }, subjects: ["W-12", "W-13"] },
    elements: m.elements,
    responsibilities,
    coverage: modelCoverageContext(m),
    ...over,
  };
}

describe("f11-only-covering-person", () => {
  it("a person responsible for every subject may decide; responsible for only one, refused with who can", () => {
    expect(dispositionRefusal(input({}, [row("r-a", RAO, "architecture"), row("r-f", RAO, "fire_protection")]))).toBeNull();
    expect(dispositionRefusal(input({}, [row("r-a", RAO, "architecture"), row("r-f", LEE, "fire_protection")]))).toBe("Only someone responsible for W-13 can decide this (A. Lee).");
  });

  it("'any one of': any one of the covering people may decide", () => {
    const anyOne = { group: "fp-firm", rule: "any_one" as const };
    expect(dispositionRefusal(input({}, [row("r-a", RAO, "architecture"), row("r-f1", LEE, "fire_protection", anyOne), row("r-f2", RAO, "fire_protection", anyOne)]))).toBeNull();
  });

  it("no one responsible: only the project lead decides", () => {
    expect(dispositionRefusal(input({}, []))).toBe("Only someone responsible for W-12 and W-13 can decide this (the project lead).");
    expect(dispositionRefusal(input({ isProjectLead: true }, []))).toBeNull();
  });

  it("an agent proposes, never records; a reason is required", () => {
    const rows = [row("r-a", RAO, "architecture"), row("r-f", RAO, "fire_protection")];
    expect(dispositionRefusal(input({ by: AGENT }, rows))).toBe("An agent can propose this decision; a person records it.");
    expect(dispositionRefusal(input({ reason: "ok" }, rows))).toBe("Say why in a sentence; reviewers will read it.");
  });

  it("override of a reliance finding: only the record's own signer (C10), whatever else they cover", () => {
    const reliance = { id: "reliance:rec-1", source: { kind: "reliance", id: "rec-1", version: "abc" }, subjects: ["W-12"] };
    const rows = [row("r-a", LEE, "architecture")];
    expect(dispositionRefusal(input({ action: "override", finding: reliance, by: LEE, signer: RAO, signerName: "J. Rao" }, rows))).toBe("Only J. Rao can override it. To take it on yourself, re-check it and sign your own approval.");
    expect(dispositionRefusal(input({ action: "override", finding: reliance, by: RAO, signer: RAO }, rows))).toBeNull();
  });
});
