/**
 * @jest-environment node
 *
 * Round 11 lane F11: the finding id recipe is stored forever (dispositions
 * name it), so it must not move: `<source kind>:<local id>`, the local id
 * being the source's own stable id (lint's finding id, a requirement id, a
 * question or record id) or the check id plus the sorted subjects. Order of
 * subjects never matters, long ids shorten deterministically, and C10's
 * reliance ids are unchanged.
 *
 * Fails on round 10's code: `findingRefId`, `localFindingId`, the adapters
 * and `lintLedgerFindingId` don't exist.
 */
import { relianceFindingId } from "../src/findings";
import { FINDING_LOCAL_ID_MAX, findingRefId, findingSourceKindOf, findingSubjects, localFindingId } from "../src/findings/ref";
import { lintLedgerFindingId } from "../src/findings/lint-acceptance";
import { lintFindingRef, mergeWaitFindings, requirementFindingId } from "../src/findings/api";

describe("f11-stable-ids", () => {
  it("the recipe: source kind, then the source's own id or the check plus sorted subjects", () => {
    expect(findingRefId("question", "Q-3")).toBe("question:Q-3");
    expect(localFindingId("zz.door_swing", ["D-2", "D-1", "D-2"])).toBe("zz.door_swing:D-1|D-2");
    expect(localFindingId("zz.door_swing", ["D-1", "D-2"])).toBe(localFindingId("zz.door_swing", ["D-2", "D-1"]));
    expect(findingSourceKindOf("requirement:zt:head:fp.count:S104")).toBe("requirement");
    expect(findingSubjects(["b", "a", "b", ""])).toEqual(["a", "b"]);
  });

  it("long local ids shorten the same way every time", () => {
    const many = Array.from({ length: 80 }, (_, i) => `element-${String(i).padStart(3, "0")}`);
    const a = localFindingId("zz.long", many);
    expect(a.length).toBeLessThanOrEqual(FINDING_LOCAL_ID_MAX);
    expect(localFindingId("zz.long", [...many].reverse())).toBe(a);
    expect(localFindingId("zz.long", many.slice(1))).not.toBe(a);
  });

  it("each adapter keeps its producer's own stable id: lint, requirement, reliance (C10's), merge", () => {
    const lint = { id: "clash-hard:ra-s1|sa-s1", rule: "clash-hard", severity: "error", elementIds: ["sa-s1", "ra-s1"], message: "Supply passes into return" } as const;
    const ref = lintFindingRef(lint, { revision: 4 }, "main");
    expect(ref.id).toBe("lint_rule:clash-hard:ra-s1|sa-s1");
    expect(ref.id).toBe(lintLedgerFindingId(lint.id));
    expect(ref.subjects).toEqual(["ra-s1", "sa-s1"]);
    expect(lintFindingRef({ ...lint, linked: [{ globalId: "2Fq" }] }, { revision: 4 }, "main").subjects).toEqual(["linked:2Fq", "ra-s1", "sa-s1"]);
    expect(requirementFindingId("zt.code_study:head-count:fp.head_count:S104")).toBe("requirement:zt.code_study:head-count:fp.head_count:S104");
    expect(findingRefId("reliance", "rec-9")).toBe(relianceFindingId("rec-9"));
    const wait = (elementIds: string[]) => mergeWaitFindings("br-1", [{ part: { discipline: "plumbing", elementIds: ["P-1"] }, lands: false, waits: [{ kind: "conflict", elementIds }], words: null }], { revision: 1, lineageId: "br-1" })[0]?.id;
    expect(wait(["P-2", "P-1"])).toBe(wait(["P-1", "P-2"]));
  });
});
