/**
 * @jest-environment node
 *
 * Round 8b lane O, kernel half:
 * - o8-significance-default-unclassified: nothing classified reads "Not
 *   classified", and a design change reads "Design change. Not a change order."
 * - o8-firm-kind: a test add-on adds its own kind on CHANGE_SIGNIFICANCE_POINT
 *   with zero kernel edits; a stored kind from an add-on the model lacks is
 *   kept and named, never shown as "not classified".
 * - o8-refuse-with-citation (kernel rules): refusing and "no cost" need a
 *   reason; "required coordination not done" needs a citation; only the
 *   addressee answers, only the opener sends.
 * - o8-only-covering-professional-classifies (kernel rules): only a person
 *   whose accepted responsibility covers a changed element may classify; a
 *   project-lead fallback never does.
 * - o8-no-auto-change-order (kernel): no command makes a change order and no
 *   shape here carries money.
 *
 * Fails on round 8's code: there is no change-orders module.
 */
import {
  BUILT_IN_CHANGE_KINDS,
  CHANGE_SIGNIFICANCE_POINT,
  CHANGE_WORDS,
  REQUIRED_COORDINATION_KIND,
  UNCLASSIFIED_KIND,
  changeKindProblems,
  changeKindWords,
  changeKindsFor,
  changeOrderMoveProblem,
  changeOrderMoves,
  changeTargetKey,
  classificationProblem,
  classifyProblem,
  classifyingResponsibilities,
  commandSchema,
  coveringResponsibilities,
  modelCoverageContext,
  readChangeOrderStatus,
  type Responsibility,
} from "../src";
import { PackSet, contribute, definePack } from "../src/packs";
import { threeOffices } from "./q7-fixtures";

const FIRM_PACK = definePack({ id: "o8firm", name: "Test firm kinds", version: "1.0.0", kernel: "^1.5.0" }, [
  contribute(CHANGE_SIGNIFICANCE_POINT, [{ id: "o8firm.allowance", label: "Within the allowance", description: "Covered by an allowance already carried.", mayLeadToChangeOrder: false }]),
]);

describe("o8-significance-default-unclassified", () => {
  const set = PackSet.create([]);
  it("unclassified is the first built-in and reads as Not classified", () => {
    expect(BUILT_IN_CHANGE_KINDS[0]?.id).toBe(UNCLASSIFIED_KIND);
    expect(changeKindWords(set, null)).toBe("Not classified");
    expect(changeKindWords(set, undefined)).toBe("Not classified");
    expect(changeKindWords(set, UNCLASSIFIED_KIND)).toBe("Not classified");
    expect(CHANGE_WORDS.notAChangeOrder).toBe("Design change. Not a change order.");
  });
  it("lists the seven built-ins in operator words", () => {
    expect(changeKindsFor(set).map((k) => k.id)).toEqual(["unclassified", "no_change_order", "no_cost", "required_coordination_not_done", "owner_requested", "error_or_omission", "field_condition"]);
    for (const k of changeKindsFor(set)) expect(changeKindProblems(k)).toEqual([]);
  });
});

describe("o8-firm-kind", () => {
  it("a test add-on's kind joins the list only in its set", () => {
    const withFirm = PackSet.create([FIRM_PACK]);
    expect(changeKindsFor(withFirm).map((k) => k.id)).toContain("o8firm.allowance");
    expect(changeKindsFor(PackSet.create([])).map((k) => k.id)).not.toContain("o8firm.allowance");
    expect(changeKindWords(withFirm, "o8firm.allowance")).toBe("Within the allowance");
    expect(classificationProblem(withFirm, { kind: "o8firm.allowance", reason: "Carried in allowance 3." })).toBeNull();
  });
  it("a stored kind from an add-on the model lacks is kept and named", () => {
    expect(changeKindWords(PackSet.create([]), "o8firm.allowance")).toBe('Classified as "o8firm.allowance" (from an add-on this model doesn\'t have)');
    expect(classificationProblem(PackSet.create([]), { kind: "o8firm.allowance", reason: "x" })).toMatch(/isn't a kind of change/);
  });
  it("conformance refuses a malformed kind", () => {
    expect(changeKindProblems({ id: "Bad Id", label: "", description: "" })).toHaveLength(3);
  });
});

describe("o8-refuse-with-citation", () => {
  const set = PackSet.create([]);
  it("classifying needs a reason; required coordination needs a citation", () => {
    expect(classificationProblem(set, { kind: "owner_requested", reason: " " })).toBe(CHANGE_WORDS.reasonRequired);
    expect(classificationProblem(set, { kind: REQUIRED_COORDINATION_KIND, reason: "Sleeves not coordinated." })).toBe(CHANGE_WORDS.citationRequired);
    expect(classificationProblem(set, { kind: REQUIRED_COORDINATION_KIND, reason: "Sleeves not coordinated.", citation: "Spec 01 31 00, 1.4.B" })).toBeNull();
  });
  it("only the addressee answers a sent order, each answer with a reason", () => {
    expect(changeOrderMoves("draft", "opener")).toEqual(["sent"]);
    expect(changeOrderMoves("draft", "addressee")).toEqual([]);
    expect(changeOrderMoves("sent", "addressee")).toEqual(["accepted", "refused", "no_cost"]);
    expect(changeOrderMoves("sent", "opener")).toEqual([]);
    expect(changeOrderMoveProblem({ from: "sent", to: "refused", actor: "addressee", reason: "" })).toBe(CHANGE_WORDS.reasonRequired);
    expect(changeOrderMoveProblem({ from: "sent", to: "no_cost", actor: "opener", reason: "x" })).toBe(CHANGE_WORDS.onlyAddressee);
    expect(changeOrderMoveProblem({ from: "sent", to: "refused", actor: "addressee", reason: "Coordination was required by spec 01 31 00." })).toBeNull();
    expect(changeOrderMoveProblem({ from: "refused", to: "accepted", actor: "addressee", reason: "x" })).toMatch(/already answered/);
    expect(changeOrderMoveProblem({ from: "draft", to: "accepted", actor: "addressee", reason: "x" })).toMatch(/Send the change order first/);
  });
  it("an unknown stored status allows nothing", () => {
    expect(readChangeOrderStatus("void")).toBeNull();
    expect(changeOrderMoves(readChangeOrderStatus("void"), "addressee")).toEqual([]);
    expect(changeOrderMoveProblem({ from: null, to: "accepted", actor: "addressee", reason: "x" })).toMatch(/doesn't know/);
  });
});

describe("o8-only-covering-professional-classifies (kernel)", () => {
  const model = threeOffices();
  const ctx = modelCoverageContext(model);
  const wall = model.elements["W-12"];
  if (!wall) throw new Error("fixture");
  const discipline = ctx.disciplineOf(wall);
  const row = (id: string, ref: string, accepted: boolean, scope?: Responsibility["scope"]): Responsibility => ({ id, party: { kind: "person", ref, label: ref }, discipline, ...(scope ? { scope } : {}), ...(accepted ? { acceptedAt: "2026-11-01T00:00:00Z" } : {}) });

  it("the covering person may classify; someone else may not", () => {
    const coverage = coveringResponsibilities([wall], [row("r1", "u-rao", true)], ctx);
    expect(classifyingResponsibilities(coverage, "u-rao").map((r) => r.id)).toEqual(["r1"]);
    expect(classifyProblem(coverage, "u-rao")).toBeNull();
    expect(classifyProblem(coverage, "u-other")).toBe(CHANGE_WORDS.noResponsibility);
  });
  it("a named but unaccepted person may not, and the project-lead fallback never classifies", () => {
    const coverage = coveringResponsibilities([wall], [row("r1", "u-rao", false)], ctx);
    expect(coverage[0]?.fallback).toBe("project_lead");
    expect(classifyProblem(coverage, "u-rao")).toBe(CHANGE_WORDS.noResponsibility);
  });
  it("a scoped person whose scope misses the change may not", () => {
    const coverage = coveringResponsibilities([wall], [row("r1", "u-rao", true, { levels: ["Level 9"] }), row("r2", "u-example", true)], ctx);
    expect(classifyProblem(coverage, "u-rao")).toBe(CHANGE_WORDS.noResponsibility);
    expect(classifyProblem(coverage, "u-example")).toBeNull();
  });
  it("target keys separate ranges and branches", () => {
    expect(changeTargetKey({ kind: "version_range", modelId: "site-1", fromRevision: 3, toRevision: 9 })).toBe("range:site-1:3:9");
    expect(changeTargetKey({ kind: "branch", modelId: "site-1", branchId: "lobby-b", branchHead: 12 })).toBe("branch:site-1:lobby-b");
  });
});

describe("o8-no-auto-change-order (kernel)", () => {
  it("no model command opens, sends or answers a change order", () => {
    const types: string[] = commandSchema.options.map((o) => o.shape.type.value);
    expect(types.some((t) => /change_?order/i.test(t))).toBe(false);
  });
});
