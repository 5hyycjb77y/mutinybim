/**
 * @jest-environment node
 *
 * Round 11 lane F11 (D2, FOUNDATION-REVIEW §4.8): the agent's orientation is
 * small whatever the model's size. Copy, revision and stage; the focus; a
 * nearby set bounded by a capped radius and a count; the open findings
 * touching the focus first (with how decided ones were decided); the
 * requirements on the focus and its space. Every list says how many more.
 *
 * Fails on round 10's code: `AgentOrientation` doesn't exist.
 */
import { unbindRequirementsSnapshot, type ModelState } from "../src";
import { agentOrientation, FindingLedger, ORIENTATION_LIMITS, type FindingSourceRow } from "../src/findings/api";
import { bindModelPacks, PackSet } from "../src/packs";
import { bindStudy, floor, ZT_PACK } from "./g7-fixtures";

const ID = "f11-orient";

const many: FindingSourceRow = {
  id: "f11zo.many",
  label: "Many (test)",
  all: (ctx) => Array.from({ length: 30 }, (_, i) => ({ id: `f11zo.many:S104|${i}`, source: { kind: "f11zo.many", id: "many", version: "1" }, severity: i % 3 === 0 ? "blocking" : "info", subjects: ["S104"], lineageId: ctx.lineageId, revision: ctx.model.revision, words: `Test finding ${i}` })),
};

beforeAll(() => {
  bindModelPacks(ID, PackSet.create([ZT_PACK]));
  bindStudy(ID);
});
afterAll(() => unbindRequirementsSnapshot(ID));

describe("f11-orientation-bounded", () => {
  it("bounded by count and radius, open blocking findings first, requirements on the focus's space", () => {
    const m: ModelState = floor(ID);
    const ledger = new FindingLedger({ feeds: [many] });
    ledger.open(m);
    let askedRadius = -1;
    const o = agentOrientation({
      model: m,
      ledger,
      focus: ["SP-14", "SP-14"],
      radiusMm: 1_000_000,
      stage: "construction_documents",
      nearby: (_focus, radiusMm, limit) => {
        askedRadius = radiusMm;
        return Array.from({ length: limit }, (_, i) => `N-${i}`);
      },
    });
    expect(askedRadius).toBe(ORIENTATION_LIMITS.radiusMm);
    expect(o).toMatchObject({ v: 1, lineageId: "main", revision: m.revision, stage: "construction_documents", focus: ["SP-14"] });
    expect(o.nearby).toEqual({ ids: Array.from({ length: ORIENTATION_LIMITS.nearby }, (_, i) => `N-${i}`), radiusMm: ORIENTATION_LIMITS.radiusMm, more: 1 });
    // SP-14 is a subject of none of the test findings; its space S104 is reached through requirements only.
    expect(o.findings).toEqual([]);
    expect(o.requirements.length).toBeGreaterThan(0);
    expect(o.requirements.length).toBeLessThanOrEqual(ORIENTATION_LIMITS.requirements);
    expect(o.requirements.some((r) => r.id.endsWith(":S104"))).toBe(true);

    const room = agentOrientation({ model: m, ledger, focus: ["S104"] });
    expect(room.findings).toHaveLength(ORIENTATION_LIMITS.findings);
    expect(room.findingsMore).toBe(30 - ORIENTATION_LIMITS.findings);
    expect(room.findings.every((f) => f.severity === "blocking" && f.standing === "open")).toBe(true);
    expect(room.nearby).toEqual({ ids: [], radiusMm: ORIENTATION_LIMITS.radiusMm, more: 0 });
    expect(JSON.stringify(room).length).toBeLessThan(4000);
  });
});
