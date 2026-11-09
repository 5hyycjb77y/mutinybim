/**
 * @jest-environment node
 *
 * Round 11 lane F11 (D2): one problem list. A clash (lint), a failed rule
 * (a requirement not met), an open question that holds the issue, a stale
 * approval (an answer whose reliance no longer holds) and a divergence all
 * appear as `FindingRef`s in one ledger, each with its source, severity,
 * subjects, copy and revision. After an edit the ledger moves by the
 * changed ids (lint's before / after change handed in, the requirement
 * anchors the edit reached, the other indexes re-read only when their kind
 * changed) and matches a fresh read of the same revision.
 *
 * Fails on round 10's code: there was no `FindingRef`, no ledger, no adapter
 * and no source point (`findings/` held one reliance disposition shape).
 */
import { commandSchema, planCommit, unbindRequirementsSnapshot, withUpgradePolicy, type Actor, type ModelState } from "@permitzip/bim-kernel";
import { FindingLedger, lintFindingChange, lintFindingSource, mergeWaitFindings } from "../../bim-kernel/src/findings/api";
import { bindModelPacks, PackSet } from "../../bim-kernel/src/packs";
import { bindStudy, floor, FT as G7_FT, ZT_PACK } from "../../bim-kernel/__tests__/g7-fixtures";
import type { Finding } from "../src";
import { config, engineFor, Model, RETURN, SUPPLY } from "./fixtures";

const ID = "f11-one-ledger";
const RAO: Actor = { id: "user-rao", name: "J. Rao", kind: "human" };
const EXAMPLE: Actor = { id: "user-example", name: "K. Example", kind: "human" };
const CFG = config({ ruleset: "issue" });

let key = 0;
function commit(m: ModelState, command: unknown, actor: Actor = RAO): { model: ModelState; changed: string[] } {
  key += 1;
  const d = withUpgradePolicy(() => true, () => planCommit(m, [], { idempotencyKey: `f11-one-${key}`, baseRevision: m.revision, actor, command: commandSchema.parse(command) }, () => "2026-11-02T10:00:00.000Z"));
  if (!d.ok) throw new Error(`${(command as { type: string }).type}: ${d.error.message}`);
  return { model: d.model, changed: [...d.changeset.elements.map((e) => e.id as string), ...(d.changeset.removedIds ?? []).map(String)] };
}

/** The synthetic floor (rooms, rules, heads) with two crossing air runs over Corridor 100. */
function building(): ModelState {
  const ducts = new Model();
  ducts.duct("sa", SUPPLY, [[2, 3], [40, 3]], 9);
  ducts.duct("ra", RETURN, [[20, 0], [20, 6]], 9);
  const f = floor(ID);
  return { ...f, elements: { ...f.elements, ...ducts.head.elements }, connections: [...f.connections, ...ducts.head.connections] };
}

function full(m: ModelState): Finding[] {
  return engineFor(m).check({ config: CFG });
}

beforeAll(() => {
  bindModelPacks(ID, PackSet.create([ZT_PACK]));
  bindStudy(ID);
});
afterAll(() => unbindRequirementsSnapshot(ID));

function fiveSourceModel(): ModelState {
  let m = building();
  // A failed rule: Room 104's ceiling drops to 8 ft, so its two heads no longer meet the head count.
  m = commit(m, { type: "edit_ceiling", ceilingId: "CLG-104", heightMm: 8 * G7_FT }).model;
  // An open question that holds the issue.
  m = commit(m, { type: "add_question", questions: [{ questionId: "Q-beam", text: "Is there a beam over the corridor?", askOf: "Structural", anchor: { elementIds: ["S100"] }, blocksIssue: true }] }).model;
  // A stale approval: an answer about Office 102, then Office 102 changes.
  m = commit(m, { type: "add_question", questions: [{ questionId: "Q-room", text: "Is 102 an office?", askOf: "Architect", anchor: { elementIds: ["S102"] } }] }).model;
  m = commit(m, { type: "answer_question", questionId: "Q-room", answer: "Yes, an office for four." }, EXAMPLE).model;
  m = commit(m, { type: "edit_space", spaceId: "S102", name: "Storage" }).model;
  // A divergence: an approved product in place of the design basis of W-13.
  m = commit(m, { type: "record_divergence", divergenceId: "DIV-1", designBasis: { elementIds: ["W-13"] }, approvedProduct: { label: "Alternate partition, maker B" }, notes: "Equivalent rating." }, EXAMPLE).model;
  return m;
}

describe("f11-one-ledger", () => {
  it("a clash, a failed rule, an open question, a stale approval and a divergence are five FindingRefs in one list", () => {
    const m = fiveSourceModel();
    const ledger = new FindingLedger({ feeds: [lintFindingSource(full)] });
    ledger.open(m);
    const kinds = new Map<string, number>();
    for (const f of ledger.findings()) kinds.set(f.source.kind, (kinds.get(f.source.kind) ?? 0) + 1);
    expect([...kinds.keys()].sort()).toEqual(["divergence", "lint_rule", "question", "reliance", "requirement"]);

    const clash = ledger.findings().find((f) => f.source.kind === "lint_rule" && f.source.id === "clash-hard");
    expect(clash).toMatchObject({ severity: "blocking", lineageId: "main", revision: m.revision, source: { version: "1" } });
    expect(clash?.id).toMatch(/^lint_rule:clash-hard:/);
    expect(clash?.subjects.length).toBe(2);

    expect(ledger.get("requirement:zt.code_study:head-count:fp.head_count:S104")).toMatchObject({ severity: "blocking", subjects: ["S104", "SP-14", "SP-15"] });
    expect(ledger.get("question:Q-beam")).toMatchObject({ severity: "blocking", subjects: ["Q-beam", "S100"], words: expect.stringContaining("holds this issue") });
    const stale = ledger.findings().find((f) => f.source.kind === "reliance");
    expect(stale).toMatchObject({ severity: "warning", words: expect.stringMatching(/^May no longer hold — Storage 102 changed/) });
    expect(stale?.subjects).toContain("S102");
    expect(ledger.get("divergence:DIV-1")).toMatchObject({ severity: "info", subjects: ["DIV-1", "W-13"] });
    for (const f of ledger.findings()) expect(ledger.standingOf(f)).toEqual({ state: "open" });
  });

  it("merge waits read as findings on the branch's copy", () => {
    const refs = mergeWaitFindings("br-1", [{ part: { discipline: "fire_protection", elementIds: ["SP-14"] }, lands: false, waits: [{ kind: "approval", waitingFor: ["resp-1"] }], words: "Waiting for J. Rao's approval" }], { revision: 7, lineageId: "br-1" });
    expect(refs).toEqual([expect.objectContaining({ id: "merge:br-1:fire_protection:approval", severity: "blocking", subjects: ["SP-14"], lineageId: "br-1", words: "Waiting for J. Rao's approval" })]);
  });

  it("after edits the ledger moves by the changed ids and matches a fresh read of the same revision", () => {
    let m = fiveSourceModel();
    const engine = engineFor(m);
    const ledger = new FindingLedger({ feeds: [lintFindingSource(full)] });
    ledger.open(m);
    const radius = CFG.scope_radius_ft * 304.8;
    const edits: unknown[] = [
      { type: "edit_ceiling", ceilingId: "CLG-104", heightMm: 10 * G7_FT },
      { type: "answer_question", questionId: "Q-beam", answer: "No beam; clear to the deck." },
      { type: "edit_space", spaceId: "S101", name: "Lab" },
      { type: "edit_ceiling", ceilingId: "CLG-104", heightMm: 8 * G7_FT },
    ];
    for (const c of edits) {
      const before = m;
      const { model: after, changed } = commit(m, c, EXAMPLE);
      const scope = { ...engine.scopeFor(changed, engine.boxesIn(before, changed), engine.boxesIn(after, changed), radius), pairsFrom: changed };
      const was = engine.run(scope, { config: CFG });
      engine.advance(after, changed);
      const now = engine.run(scope, { config: CFG, previous: before });
      ledger.apply(after, changed, new Map([["lint_rule", lintFindingChange(was, now, after, "main")]]));
      const fresh = new FindingLedger({ feeds: [lintFindingSource(full)] });
      fresh.open(after);
      expect(ledger.findings().map((f) => f.id)).toEqual(fresh.findings().map((f) => f.id));
      m = after;
    }
    expect(ledger.get("question:Q-beam")).toBeUndefined();
    expect(ledger.get("requirement:zt.code_study:head-count:fp.head_count:S104")).toBeDefined();
  });
});
