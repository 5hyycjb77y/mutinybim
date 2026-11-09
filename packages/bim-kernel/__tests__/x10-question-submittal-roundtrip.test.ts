/**
 * @jest-environment node
 *
 * Round 8 lane R (contract 1.5.0, reserved): the question, answer,
 * submittal and divergence records a newer peer writes read here, are kept
 * through this release's own edits, and are written back unchanged. No peer
 * of this release advertises `questions:answers`, `submittals:records` or
 * `submittals:divergence`, so nothing here writes one; a divergence never
 * touches the design element it names.
 *
 * Fails on round 7's code: the readers, record kinds and features did not
 * exist (the imports don't resolve), and an anchor edit dropped the
 * question's requirement and drawing references.
 */
import {
  answersTo,
  divergencesIn,
  divergencesWritable,
  executeCommand,
  gatedRecordFeatures,
  questionAnswersIn,
  questionAnswersWritable,
  readDivergenceBody,
  readQuestionAnswerBody,
  readQuestionRecord,
  readSubmittalBody,
  submittalsIn,
  submittalsWritable,
  withUpgradePolicy,
  type BimElement,
  type Command,
  type ModelState,
} from "../src";
import { floor } from "./g7-fixtures";

const RESERVED = ["questions:answers", "submittals:records", "submittals:divergence"];
const ROUND_8_PEER = (feature: string) => !RESERVED.includes(feature);

const base = { version: 3, authoredRev: {}, partition: { level: "", zone: "", discipline: "general" } };

/** What a round-9 peer stores: fields, statuses, outcomes and review states this release only reserves or doesn't know. */
function newerPeersRecords(): BimElement[] {
  return [
    {
      ...base,
      id: "Q-r9",
      kind: "question",
      type: "formal_rfi",
      number: "Q-7",
      text: "Is the wall at gridline 3 rated?",
      askOf: "Architect",
      askedBy: "Contractor",
      status: "declined",
      anchor: { elementIds: ["W-12"], requirementRefs: ["arch.rating:W-12"], documentRefs: [{ kind: "detail", id: "sheet-A501", detail: "4" }], pinColour: "teal" },
      externalRefs: [{ provider: "workflow", ref: "rfi/0042" }],
      triage: { queue: "architect" },
    },
    {
      ...base,
      id: "QA-1",
      kind: "question_answer",
      answer: { questionId: "Q-r9", text: "Rated one hour; see 4/A501.", by: "Architect", at: "2026-11-02T10:00:00.000Z", outcome: "judgment_recorded", links: [{ kind: "determination", ref: "D-rating-W-12" }], signedWith: "seal-7" },
    },
    {
      ...base,
      id: "QA-2",
      kind: "question_answer",
      answer: { questionId: "Q-r9", text: "Passed to the owner.", by: "Architect", at: "2026-11-01T09:00:00.000Z", outcome: "wf.referred_on" },
    },
    {
      ...base,
      id: "SUB-1",
      kind: "submittal",
      submittal: {
        title: "Section 3 product data",
        revision: "1",
        submittedBy: "Contractor",
        offeredFor: { elementIds: ["W-13"], requirementRefs: ["arch.rating:W-13"] },
        review: { state: "approved_as_noted", reviewer: "K. Example", at: "2026-11-03", notes: "Provide the listing." },
        items: [
          { id: "1", label: "Product data", review: { state: "approved", reviewer: "K. Example" } },
          { id: "2", label: "Listing", review: { state: "owner_review", reviewer: "Owner" }, stamp: "B" },
        ],
        externalRefs: [{ provider: "files", ref: "f-913" }],
        transmittal: 12,
      },
    },
    {
      ...base,
      id: "DIV-1",
      kind: "divergence",
      divergence: {
        designBasis: { elementIds: ["W-13"] },
        approvedProduct: { label: "Alternate assembly, maker B", submittalId: "SUB-1", itemId: "1" },
        approvedBy: "K. Example",
        at: "2026-11-03",
        notes: "Equivalent rating; thicker.",
        responsibleParty: { label: "Contractor", ref: "party-gc" },
        responsibilityNote: "Proposed by the contractor.",
        fieldNote: "seen on site",
      },
    },
  ] as unknown as BimElement[];
}

function withRecords(m0: ModelState, received: readonly BimElement[]): ModelState {
  return { ...m0, elements: { ...m0.elements, ...Object.fromEntries(received.map((e) => [e.id, e])) } };
}

function run(m: ModelState, c: Command): ModelState {
  const r = withUpgradePolicy(ROUND_8_PEER, () => executeCommand(m, c));
  if (!r.ok) throw new Error(`${c.type}: ${r.error.message}`);
  return r.model;
}

describe("x10 question and submittal round trip", () => {
  it("the three reserved features are never advertised and nothing may write those records", () => {
    const features = gatedRecordFeatures();
    for (const f of RESERVED) expect(features).not.toContain(f);
    expect(questionAnswersWritable()).toBe(false);
    expect(submittalsWritable()).toBe(false);
    expect(divergencesWritable()).toBe(false);
  });

  it("this release's own edits keep every reserved record byte for byte, and the design element a divergence names is untouched", () => {
    const received = newerPeersRecords();
    const m = withRecords(floor("x10-a"), received);
    const wall = m.elements["W-13"];
    const m1 = run(m, { type: "create_level", levelId: "L2", name: "Level 2", elevationMm: 4000 });
    const m2 = run(m1, { type: "edit_space", spaceId: "S101", name: "Open office" });
    const m3 = run(m2, { type: "add_question", questions: [{ questionId: "Q-new", text: "Confirm the ceiling height?", askOf: "Client", anchor: { elementIds: ["S102"] } }] });
    for (const e of received) expect(JSON.stringify(m3.elements[e.id])).toBe(JSON.stringify(e));
    expect(m3.elements["W-13"]).toBe(wall);
    const written = JSON.parse(JSON.stringify(m3.elements)) as Record<string, unknown>;
    for (const e of received) expect(written[e.id]).toEqual(JSON.parse(JSON.stringify(e)));
  });

  it("editing a reserved question keeps who asked, its type, its status, its references and fields this release doesn't know", () => {
    const m = withRecords(floor("x10-b"), newerPeersRecords());
    const m1 = run(m, { type: "edit_question", questionId: "Q-r9", text: "Is the wall at gridline 3 rated one hour?", anchor: { elementIds: ["W-12", "W-13"] } });
    const q = readQuestionRecord(m1.elements["Q-r9"]);
    expect(q.ok && q.value).toMatchObject({
      type: "formal_rfi",
      askedBy: "Contractor",
      status: "declined",
      text: "Is the wall at gridline 3 rated one hour?",
      anchor: { elementIds: ["W-12", "W-13"], requirementRefs: ["arch.rating:W-12"], documentRefs: [{ kind: "detail", id: "sheet-A501", detail: "4" }], pinColour: "teal" },
      externalRefs: [{ provider: "workflow", ref: "rfi/0042" }],
      triage: { queue: "architect" },
    });
  });

  it("the tolerant readers keep what they don't know and find each record by kind", () => {
    const received = newerPeersRecords();
    const m = withRecords(floor("x10-c"), received);
    const [q, a1, , sub, div] = received as unknown as { answer?: unknown; submittal?: unknown; divergence?: unknown }[];
    expect(readQuestionRecord(q).ok).toBe(true);
    const a = readQuestionAnswerBody(a1?.answer);
    expect(a.ok && a.value).toMatchObject({ outcome: "judgment_recorded", signedWith: "seal-7" });
    const s = readSubmittalBody(sub?.submittal);
    expect(s.ok && s.value).toMatchObject({ transmittal: 12, items: [{ id: "1" }, { id: "2", review: { state: "owner_review" }, stamp: "B" }] });
    const d = readDivergenceBody(div?.divergence);
    expect(d.ok && d.value).toMatchObject({ responsibleParty: { label: "Contractor" }, fieldNote: "seen on site" });

    expect(questionAnswersIn(m.elements).map((e) => e.id).sort()).toEqual(["QA-1", "QA-2"]);
    expect(answersTo(m.elements, "Q-r9").map((e) => e.id)).toEqual(["QA-2", "QA-1"]);
    expect(submittalsIn(m.elements).map((e) => e.id)).toEqual(["SUB-1"]);
    expect(divergencesIn(m.elements).map((e) => e.id)).toEqual(["DIV-1"]);
  });

  it("a record that isn't one is refused with the reason, in words", () => {
    expect(readSubmittalBody({ title: "X", revision: "0", offeredFor: {}, review: { state: "pending" }, items: [] })).toEqual({ ok: false, reason: "a submittal must name at least one element, type or requirement" });
    expect(readSubmittalBody({ title: "X", revision: "0", offeredFor: { typeIds: ["T1"] }, review: { state: "pending" }, items: [{ id: "1", label: "A" }, { id: "1", label: "B" }] })).toEqual({ ok: false, reason: "two submittal items are both 1" });
    expect(readDivergenceBody({ designBasis: { typeIds: ["T1"] }, approvedProduct: { label: "B" }, approvedBy: "K", at: "2026-11-03" })).toEqual({ ok: false, reason: "a divergence needs its notes (they may be empty)" });
    expect(readQuestionAnswerBody({ questionId: "Q", text: "x", by: "A" })).toEqual({ ok: false, reason: "an answer needs who answered and when" });
    expect(readQuestionRecord({ kind: "question", id: "Q", text: "t", askOf: "A", status: "open", type: "question" })).toEqual({ ok: false, reason: "a question needs an anchor with its element list" });
  });
});
