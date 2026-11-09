/**
 * @jest-environment node
 *
 * Round 10 lane C10: rules are a reliance source in Q9's validity facility.
 * A record in the model that pins the rule it was checked against "may no
 * longer hold — checked against an older rule" when the project's code of
 * record (a model-wide determination, set through the existing commands)
 * moves to another edition, or the model's own rule gets a new version.
 * Setting the code back clears it. Only records filed under that rule or
 * instrument are re-checked. Fails on round 9: a reliance had no rules and a
 * code-of-record change touched no record.
 */
import {
  checkingContextFor,
  codeOfRecordDecision,
  codesOfRecord,
  commandSchema,
  planCommit,
  readReliance,
  recordValidity,
  registerRelianceSource,
  relianceFor,
  validityStats,
  withUpgradePolicy,
  type Actor,
  type BimElement,
  type ModelState,
} from "../src";
import { IBC_2021, IBC_2024, rule } from "./fixtures/c10-rules";
import { floor } from "./g7-fixtures";

const RAO: Actor = { id: "user-rao", name: "J. Rao", kind: "human" };
let key = 0;
function commit(m: ModelState, command: unknown): ModelState {
  key += 1;
  const d = withUpgradePolicy(() => true, () => planCommit(m, [], { idempotencyKey: `c10-validity-${key}`, baseRevision: m.revision, actor: RAO, command: commandSchema.parse(command) }, () => "2026-11-02T10:00:00.000Z"));
  if (!d.ok) throw new Error(d.error.message);
  return d.model;
}

function setCode(m: ModelState, id: string, code: typeof IBC_2021, supersedes?: string): ModelState {
  const d = codeOfRecordDecision(code);
  const decision = { value: d.value, edition: d.edition, inputs: d.inputs.map((i) => ({ key: i.key, value: i.value })), reasoning: "Permit application date sets the code of record.", decidedBy: "J. Rao", confidence: "high" };
  return supersedes
    ? commit(m, { type: "supersede_determination", determinationId: supersedes, newDeterminationId: id, ...decision })
    : commit(m, { type: "record_determination", determinationId: id, subject: { kind: "model" }, key: d.key, ...decision });
}

registerRelianceSource({ name: "c10_test_approval", kinds: ["c10_test_approval"], relianceOf: (el) => readReliance((el as unknown as { reliance?: unknown }).reliance) });

function withApproval(m: ModelState, id: string, rules: Parameters<typeof relianceFor>[1]["rules"]): ModelState {
  const approval = { id, kind: "c10_test_approval", version: 1, authoredRev: {}, reliance: relianceFor(m, { rules }) } as unknown as BimElement;
  return { ...m, elements: { ...m.elements, [id]: approval } };
}

const r903 = rule({ ruleId: "ibc21-903-2", section: "903.2" });

describe("c10 validity: rules as a reliance source", () => {
  it("the code of record is a model-wide determination per discipline, read back as a code of record", () => {
    const m = setCode(floor("c10v-a"), "COR-bldg", IBC_2021);
    expect(codesOfRecord(m.elements)).toEqual([IBC_2021]);
  });

  it("2021 → 2024 flags the reliant record \"checked against an older rule\"; setting it back clears it", () => {
    let m = setCode(floor("c10v-b"), "COR-bldg-1", IBC_2021);
    m = withApproval(m, "APR-1", [r903]);
    expect(recordValidity(m.elements, "APR-1")).toEqual({ state: "holds" });
    m = setCode(m, "COR-bldg-2", IBC_2024, "COR-bldg-1");
    const v = recordValidity(m.elements, "APR-1");
    expect(v.state).toBe("may_not_hold");
    expect(v.state === "may_not_hold" && v.words).toBe("May no longer hold — checked against an older rule (IBC 2021 §903.2)");
    expect(validityStats(m.elements).rechecks).toBe(1);
    m = setCode(m, "COR-bldg-3", IBC_2021, "COR-bldg-2");
    expect(recordValidity(m.elements, "APR-1")).toEqual({ state: "holds" });
  });

  it("an edit that touches no rule and no code of record re-checks nothing", () => {
    let m = setCode(floor("c10v-c"), "COR-bldg-1", IBC_2021);
    m = withApproval(m, "APR-1", [r903]);
    expect(recordValidity(m.elements, "APR-1").state).toBe("holds");
    m = commit(m, { type: "edit_space", spaceId: "S102", name: "Storage" });
    expect(validityStats(m.elements).rechecks).toBe(0);
  });

  it("checkingContextFor pins, from the open model, the jurisdiction, the codes of record and the rules in force with their versions", () => {
    let m = setCode(floor("c10v-d"), "COR-bldg-1", IBC_2021);
    m = commit(m, { type: "record_determination", determinationId: "DET-where", subject: { kind: "model" }, key: "jurisdiction", value: "VA", reasoning: "Project address.", decidedBy: "J. Rao", confidence: "high" });
    m = commit(m, { type: "add_local_rule", rule: { ...rule({ ruleId: "egress-count", section: "1006.3", ruleVersion: "2", provider: "local" }), produces: [{ key: "arch.exit_count", anchor: "model", value: "2", unit: "count", compare: "at_least" }] } });
    const ctx = checkingContextFor(m);
    expect(ctx.jurisdiction).toEqual({ country: "US", subdivision: "US-VA" });
    expect(ctx.codesOfRecord).toEqual([IBC_2021]);
    expect(ctx.rules).toEqual([expect.objectContaining({ ruleId: "egress-count", ruleVersion: "2", section: "1006.3", edition: "2021" })]);
    expect(ctx.determinationsDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
