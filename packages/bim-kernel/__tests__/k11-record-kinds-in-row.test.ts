/**
 * @jest-environment node
 *
 * Round 11 lane K11: the four record kinds the kernel kept outside every row
 * (submittals, divergences, answers and replies) are rows of the one record
 * registry: a `record` nature, no shape, no ends, sitting nowhere, and a
 * `read` face that is their domain's own tolerant reader. A stored record a
 * newer peer wrote reads the same through the row as through its domain,
 * survives this release's edits byte for byte, and an older peer (no rows at
 * all) receives it as stored. No add-on may take one of these kinds, and the
 * point's own table still lists add-on kinds only.
 *
 * Fails on round 10's code: `kindRowOf`, `kernelKindRow`, `registerKernelKindRows`,
 * the `read` face and `kinds/records/` don't exist (the imports don't resolve),
 * and `kindRowOf("submittal")` had no row to find.
 */
import {
  KERNEL_ELEMENT_KINDS,
  anchorOf,
  elementKindRowProblems,
  elementKindTable,
  executeCommand,
  kindRowOf,
  lowerForOlderPeer,
  readDivergenceBody,
  readQuestionAnswerBody,
  readQuestionReplyBody,
  readSubmittalBody,
  withUpgradePolicy,
  type BimElement,
  type Command,
  type ElementKindItem,
  type ModelState,
} from "../src";
import { KERNEL_KIND_ROWS } from "../src/kinds/rows";
import { RECORD_KIND_ROWS } from "../src/kinds/records";
import { FINDING_DISPOSITION_KIND_ROW } from "../src/findings/record";
import { LIFECYCLE_KIND_ROWS } from "../src/lifecycle/records";
import { kernelKindRow, kernelKindRowKinds, registerKernelKindRows } from "../src/registry/element-kind-point";
import { floor } from "./g7-fixtures";

const RECORD_KINDS = ["submittal", "divergence", "question_answer", "question_reply"] as const;
const OLDER_PEER = (feature: string) => !["questions:answers", "questions:threads", "submittals:records", "submittals:divergence"].includes(feature);

const base = { version: 3, authoredRev: {}, partition: { level: "", zone: "", discipline: "general" } };

/** What a newer peer stores: fields and states this release doesn't know. */
function storedRecords(): BimElement[] {
  const records: readonly object[] = [
    { ...base, id: "QA-1", kind: "question_answer", answer: { questionId: "Q-1", text: "Rated one hour.", by: "Architect", at: "2026-11-02T10:00:00.000Z", outcome: "judgment_recorded", signedWith: "seal-7" } },
    { ...base, id: "QR-1", kind: "question_reply", reply: { questionId: "Q-1", text: "Thanks, noted.", author: { provider: "hours", subject: "u-1", kind: "person", displayName: "Avery" }, at: "2026-11-02T11:00:00.000Z", mood: "relieved" } },
    {
      ...base,
      id: "SUB-1",
      kind: "submittal",
      submittal: { title: "Section 3 product data", revision: "1", offeredFor: { elementIds: ["W-13"] }, review: { state: "owner_review" }, items: [{ id: "1", label: "Product data", stamp: "B" }], transmittal: 12 },
    },
    {
      ...base,
      id: "DIV-1",
      kind: "divergence",
      divergence: { designBasis: { elementIds: ["W-13"] }, approvedProduct: { label: "Alternate assembly" }, approvedBy: "K. Example", at: "2026-11-03", notes: "Equivalent rating.", fieldNote: "seen on site" },
    },
  ];
  return records as unknown as BimElement[];
}

function withRecords(m0: ModelState, records: readonly BimElement[]): ModelState {
  return { ...m0, elements: { ...m0.elements, ...Object.fromEntries(records.map((e) => [e.id, e])) } };
}

function run(m: ModelState, c: Command): ModelState {
  const r = withUpgradePolicy(OLDER_PEER, () => executeCommand(m, c));
  if (!r.ok) throw new Error(`${c.type}: ${r.error.message}`);
  return r.model;
}

function readThrough(row: ElementKindItem | undefined, record: object): unknown {
  if (row?.read === undefined) throw new Error(`no read face on ${row?.kind ?? "a missing row"}`);
  return row.read(record);
}

describe("k11 the four record kinds are rows of the one registry", () => {
  it("each is a record row: no shape, no ends, sits nowhere, names the feature its writers wait for", () => {
    const features: Record<string, string> = { submittal: "submittals:records", divergence: "submittals:divergence", question_answer: "questions:answers", question_reply: "questions:threads" };
    for (const kind of RECORD_KINDS) {
      const row = kindRowOf(kind);
      expect(row).toBeDefined();
      expect(row?.nature).toBe("record");
      expect(row?.shape).toBeUndefined();
      expect(row?.connectorEnds).toBeUndefined();
      expect(row?.anchor).toBeUndefined();
      expect(row?.upgrade?.feature).toBe(features[kind]);
      expect(row?.label.trim().length).toBeGreaterThan(0);
    }
    for (const el of storedRecords()) expect(anchorOf(el)).toBeNull();
  });

  it("a stored record reads the same through its row as through its domain's reader, unknown fields kept", () => {
    const readers: Record<string, (raw: unknown) => { ok: boolean }> = { submittal: readSubmittalBody, divergence: readDivergenceBody, question_answer: readQuestionAnswerBody, question_reply: readQuestionReplyBody };
    const bodyField: Record<string, string> = { submittal: "submittal", divergence: "divergence", question_answer: "answer", question_reply: "reply" };
    for (const el of storedRecords()) {
      const domain = readers[el.kind]?.(Reflect.get(el, bodyField[el.kind] ?? ""));
      expect(domain?.ok).toBe(true);
      expect(readThrough(kindRowOf(el.kind), el)).toEqual({ ok: true });
    }
    // A record that isn't one: the domain's reason, in words.
    expect(readThrough(kindRowOf("question_answer"), { ...base, id: "QA-x", kind: "question_answer", answer: { questionId: "Q", text: "x", by: "A" } })).toEqual({ ok: false, reason: "an answer needs who answered and when" });
    expect(readThrough(kindRowOf("submittal"), { ...base, id: "S-x", kind: "submittal", submittal: { title: "X", revision: "0", offeredFor: {}, review: { state: "pending" }, items: [] } })).toEqual({ ok: false, reason: "a submittal must name at least one element, type or requirement" });
    expect(readThrough(kindRowOf("question_reply"), { ...base, id: "R-x", kind: "question_reply" })).toEqual({ ok: false, reason: "a reply must be an object" });
  });

  it("this release's edits keep every record byte for byte, and an older peer receives it as stored", () => {
    const received = storedRecords();
    const m = withRecords(floor("k11-rec"), received);
    const m1 = run(m, { type: "create_level", levelId: "L2", name: "Level 2", elevationMm: 4000 });
    const m2 = run(m1, { type: "edit_space", spaceId: "S101", name: "Open office" });
    for (const e of received) {
      expect(JSON.stringify(m2.elements[e.id])).toBe(JSON.stringify(e));
      // The sync hub lowers by the point's table (add-on kinds only): nothing to lower, the same object goes out.
      expect(lowerForOlderPeer(e)).toBe(e);
      expect(elementKindTable().row(e.kind)).toBeUndefined();
    }
  });

  it("no add-on may take a kind the kernel keeps a row for, and the kernel refuses a second row for one", () => {
    const taken = elementKindRowProblems([{ kind: "submittal", label: "Shop drawing", nature: "record" }], new Set<string>(KERNEL_ELEMENT_KINDS));
    expect(taken).toEqual(["element kind submittal is one of the kernel's own kinds; an add-on registers a kind of its own"]);
    expect(elementKindRowProblems([{ kind: "k11.transmittal", label: "Transmittal", nature: "record", read: () => ({ ok: true }) }], new Set<string>(KERNEL_ELEMENT_KINDS))).toEqual([]);
    const errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() => registerKernelKindRows("k11.test", [{ kind: "submittal", label: "Another submittal", nature: "record" }])).toThrow('the kernel already keeps a row for the kind "submittal"');
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
    // The same rows again are a no-op.
    registerKernelKindRows("kernel.records", RECORD_KIND_ROWS);
    expect(kernelKindRow("submittal")).toBe(RECORD_KIND_ROWS[0]);
  });

  it("every kernel kind has exactly one kernel row, and the kernel rows are the kernel kinds plus the four record kinds", () => {
    expect(KERNEL_KIND_ROWS.map((r) => r.kind).sort()).toEqual([...KERNEL_ELEMENT_KINDS].sort());
    // Kernel modules declare their own record rows through the same registry (F11 dispositions, G11 gates and stage plans).
    const moduleRecordKinds = [FINDING_DISPOSITION_KIND_ROW, ...LIFECYCLE_KIND_ROWS].map((r) => r.kind);
    expect([...kernelKindRowKinds()].sort()).toEqual([...KERNEL_ELEMENT_KINDS, ...RECORD_KINDS, ...moduleRecordKinds].sort());
    for (const r of [...KERNEL_KIND_ROWS, ...RECORD_KIND_ROWS]) expect(elementKindRowProblems([{ ...r, kind: `k11.${r.kind}` }], new Set<string>())).toEqual([]);
  });
});
