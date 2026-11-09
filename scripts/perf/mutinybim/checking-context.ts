/**
 * Round 10 lane C10: what pinning and the code-change carry cost.
 *
 * - signoff.pin.context: build the checking context at sign time (read the
 *   codes of record, the jurisdiction and the determinations in force from
 *   the kind index of the tier's model; pin 20 rules) and write its stored
 *   form. Target ≤ 5 ms at 250k and 1M.
 * - validity.code_change.carry: 10,000 pinned sign-offs (5 rules each from
 *   400 rules over 4 instruments); the building code moves 2021 → 2024 and
 *   40 rules change. Only records filed under the changed instrument are
 *   re-checked; the rest are never read.
 * - set.issue.check: the reissue check over 100 sheets, 3 approvals each.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/checking-context.ts --tier=250k --samples=21
 *   (--tier=none skips the full-building model: the pin then reads a model of determinations only)
 *
 * Prints one `@@perf-result` JSON line.
 */
import {
  CheckingContextIndex,
  asElementId,
  buildCheckingContext,
  codeChangeCarry,
  codeOfRecordDecision,
  codesOfRecord,
  contextStanding,
  determinationsInForce,
  freezeElements,
  projectJurisdiction,
  writeCheckingContext,
  type BimElement,
  type CodeOfRecord,
  type PinnedRecord,
  type RuleRecord,
} from "@permitzip/bim-kernel";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { reissueCheck, type SheetApproval } from "@permitzip/bim-sheets";
import { emit, gc, memoryMB, timeSync, type Sample } from "./lib";

const arg = (name: string, fallback: string): string => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const tier = arg("tier", "250k");
const samplesPerRun = Number(arg("samples", "21"));
if (tier !== "none" && !(tier in FULL_BIM_TIERS)) throw new Error(`--tier must be none or one of ${Object.keys(FULL_BIM_TIERS).join(", ")}`);

const VA = { country: "US", subdivision: "US-VA" } as const;
const INSTRUMENTS = ["IBC", "IECC", "IPC", "NEC"] as const;
const DISCIPLINE: Record<(typeof INSTRUMENTS)[number], string> = { IBC: "building", IECC: "energy", IPC: "plumbing", NEC: "electrical" };

function rule(instrument: string, edition: string, i: number): RuleRecord {
  return { ruleId: `${instrument.toLowerCase()}${edition}-${i}`, provider: "perf.codes", citation: { instrument, edition, section: `${100 + i}.1`, jurisdictionId: VA }, title: `Requirement ${i}`, summary: "Synthetic requirement.", discipline: "architecture", applies: {}, reads: [], produces: [], verification: { status: "verified" } };
}

function codeOf(instrument: (typeof INSTRUMENTS)[number], edition: string): CodeOfRecord {
  return { discipline: DISCIPLINE[instrument], instrument, edition, jurisdiction: VA };
}

function determination(id: string, c: CodeOfRecord): BimElement {
  const d = codeOfRecordDecision(c);
  return { id: asElementId(id), kind: "determination", version: 1, authoredRev: {}, determination: { subject: { kind: "model" }, key: d.key, value: d.value, edition: d.edition, inputs: d.inputs, reasoning: "perf", decidedBy: "perf", confidence: "high", status: "recorded" } } as unknown as BimElement;
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

function main(): void {
  const base = tier === "none" ? {} : createFullBimModel(FULL_BIM_TIERS[tier as keyof typeof FULL_BIM_TIERS]).elements;
  const codes2021 = INSTRUMENTS.map((i) => codeOf(i, "2021"));
  const extra: Record<string, BimElement> = { "det-jurisdiction": { id: asElementId("det-jurisdiction"), kind: "determination", version: 1, authoredRev: {}, determination: { subject: { kind: "model" }, key: "jurisdiction", value: "VA", inputs: [], reasoning: "perf", decidedBy: "perf", confidence: "high", status: "recorded" } } as unknown as BimElement };
  codes2021.forEach((c, i) => (extra[`det-cor-${i}`] = determination(`det-cor-${i}`, c)));
  const elements = freezeElements({ ...base, ...extra });
  const totalElements = Object.keys(elements).length;
  const rules2021 = INSTRUMENTS.flatMap((ins) => Array.from({ length: 100 }, (_, i) => rule(ins, "2021", i)));
  gc();

  // signoff.pin.context
  const pin: number[] = [];
  const relied = rules2021.slice(0, 20);
  let bytes = 0;
  for (let s = 0; s < samplesPerRun; s++) {
    const t = timeSync(() => {
      const ctx = buildCheckingContext({ jurisdiction: projectJurisdiction(elements), codesOfRecord: codesOfRecord(elements), rules: relied, packs: [{ id: "perf.codes", version: "1.0.0" }], determinations: determinationsInForce(elements) });
      return JSON.stringify(writeCheckingContext(ctx)).length;
    });
    pin.push(t.ms);
    bytes = t.value;
  }

  // validity.code_change.carry
  const records: PinnedRecord[] = [];
  for (let i = 0; i < 10_000; i++) {
    const ins = INSTRUMENTS[i % INSTRUMENTS.length] ?? "IBC";
    const own = rules2021.filter((r) => r.citation.instrument === ins);
    const picked = Array.from({ length: 5 }, (_, k) => own[(i * 7 + k * 13) % own.length]).filter((r): r is RuleRecord => r !== undefined);
    records.push({ id: `rec-${i}`, signer: `user-${i % 40}`, context: buildCheckingContext({ jurisdiction: VA, codesOfRecord: codes2021, rules: picked }) });
  }
  const index = new CheckingContextIndex(records);
  const ibc2024 = Array.from({ length: 100 }, (_, i) => rule("IBC", "2024", i)).map((r, i) => (i < 60 ? { ...r, carriedForward: [{ fromEdition: "2021" }] } : r));
  const current = { codesOfRecord: [codeOf("IBC", "2024"), ...codes2021.slice(1)], rules: [...ibc2024, ...rules2021.filter((r) => r.citation.instrument !== "IBC")] };
  const carry: number[] = [];
  let rechecked = 0;
  let older = 0;
  for (let s = 0; s < samplesPerRun; s++) {
    const t = timeSync(() => codeChangeCarry(index, { instruments: ["IBC"] }, current));
    carry.push(t.ms);
    rechecked = t.value.rechecked;
    older = t.value.older.length;
  }

  // set.issue.check
  const sheets = Array.from({ length: 100 }, (_, i) => ({ id: asElementId(`sheet-${i}`), number: `M-${100 + i}` }));
  const approvals: SheetApproval[] = sheets.flatMap((sh, i) =>
    [0, 1, 2].map((k) => {
      const r = records[(i * 3 + k) % records.length];
      return { sheetId: String(sh.id), recordId: r?.id ?? "", signer: r?.signer ?? "", signerName: r?.signer ?? "", standing: contextStanding(r?.context ?? null, current) };
    }),
  );
  const issue: number[] = [];
  let blocked = 0;
  for (let s = 0; s < samplesPerRun; s++) {
    const t = timeSync(() => reissueCheck(sheets, approvals));
    issue.push(t.ms);
    blocked = t.value.blocked.length;
  }

  const samples: Sample[] = [
    { metric: "signoff.pin.context", values: pin, counts: { totalElements, bytes }, note: "20 relied rules; codes of record, jurisdiction and determinations from the kind index" },
    { metric: "validity.code_change.carry", values: carry, counts: { totalElements: records.length, affectedElements: rechecked }, note: `10,000 sign-offs; IBC 2021 → 2024, 40 rules changed (60 carried forward); ${rechecked} re-checked, ${older} older` },
    { metric: "set.issue.check", values: issue, counts: { affectedElements: approvals.length }, note: `100 sheets, 3 approvals each; ${blocked} blocked` },
  ];
  emit({ suite: "synthetic", network: "in-process (no network, no Postgres)", participants: 1, workload: { tier, samplesPerRun }, samples, invariants: { "checking_context.rechecked": rechecked }, info: { memory: memoryMB(), medians: { pin: median(pin), carry: median(carry), issue: median(issue) } } });
}

try {
  main();
} catch (err) {
  console.error("[perf/checking-context] failed", err);
  process.exit(1);
}
