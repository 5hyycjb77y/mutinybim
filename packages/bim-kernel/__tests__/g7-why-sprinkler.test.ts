/**
 * @jest-environment node
 *
 * Round 7 lane G: "why is this head here?" A head in Room 104 answers with
 * the hazard determination (who decided it, when), the rule that turns the
 * hazard into a head count, and the room it is anchored to; every item is a
 * sentence with a named cause, ranked, at most five.
 *
 * Fails on the code before round 7: there was no `why` and no requirements
 * graph engine (graph/ held only the 1.4.0 types).
 */
import { requirementsAt, unbindRequirementsSnapshot, why, WHY_EMPTY, GRAPH_ANSWER_LIMIT } from "../src";
import { bindModelPacks, PackSet } from "../src/packs";
import { bindStudy, floor, ZT_PACK } from "./g7-fixtures";

const ID = "g7-why";

beforeAll(() => {
  bindModelPacks(ID, PackSet.create([ZT_PACK]));
  bindStudy(ID);
});
afterAll(() => unbindRequirementsSnapshot(ID));

describe("g7 why: a head names the hazard determination, the rule and the room", () => {
  it("SP-14 counts toward Room 104's head count, which the ordinary hazard determination drives", () => {
    const model = floor(ID);
    const heads = requirementsAt(model, { kind: "space", id: "S104" }).find((r) => r.key === "fp.head_count");
    expect(heads).toMatchObject({ value: 2, unit: "ea", status: "proposed", standing: "governing", provider: "zt.code_study" });
    expect(heads?.fulfilment).toMatchObject({ state: "met", elementIds: ["SP-14", "SP-15"], summary: "2 elements deliver 2 of 2 ea" });
    expect(heads?.cause).toContain("Room 104 hazard is ordinary_1 (K. Example's determination, Oct 30)");

    const answer = why(model, { kind: "element", id: "SP-14" });
    expect(answer.items.length).toBeLessThanOrEqual(GRAPH_ANSWER_LIMIT);
    const kinds = answer.items.map((i) => i.node.kind);
    expect(kinds).toEqual(expect.arrayContaining(["requirement", "rule", "determination", "space"]));

    const det = answer.items.find((i) => i.node.kind === "determination");
    expect(det).toMatchObject({ node: { id: "D-haz-S104" }, label: "Room 104 hazard is ordinary_1 (K. Example's determination, Oct 30)" });
    expect(det?.edges?.some((e) => e.kind === "informs")).toBe(true);
    expect(det?.edges?.some((e) => e.kind === "decided_from")).toBe(true);

    const rule = answer.items.find((i) => i.node.kind === "rule");
    expect(rule?.label).toBe("Test Building Code T-7.1: Head spacing");
    expect(rule?.cause).toContain("Test code study");

    const room = answer.items.find((i) => i.node.kind === "space");
    expect(room).toMatchObject({ node: { id: "S104" }, label: "Room 104" });

    const req = answer.items.find((i) => i.node.kind === "requirement");
    expect(req?.label).toBe("Head spacing in Room 104");
    expect(req?.edges?.find((e) => e.kind === "fulfilled_by")).toMatchObject({ to: { kind: "element", id: "SP-14" }, cause: "2 elements deliver 2 of 2 ea" });
    for (const item of answer.items) expect(item.cause.length).toBeGreaterThan(0);
  });

  it("an element nothing requires says so in words", () => {
    const answer = why(floor(ID), { kind: "element", id: "W-30" });
    expect(answer).toEqual({ items: [], more: 0, empty: WHY_EMPTY });
  });
});
