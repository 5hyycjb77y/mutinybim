import type { AuthorRef } from "../authorship/types";
import type { BasisId } from "../basis/types";
import { registerKernelKindRows, type ElementKindItem } from "../registry/element-kind-point";
import { registerSchemaStep, schemaSteps, stepAllowed, type SchemaStep } from "../schema-version/registry";
import type { BimElement, ModelElementBase } from "../types";

/**
 * The two lifecycle record kinds (round 11 D3), registered through the
 * element-kind row (`nature: "record"`, no shape, no ends, no anchor):
 *
 *   gate        a frozen record of one stage on one lineage: the revision and
 *               its state digest, the issued sets, sign-offs and dispositions
 *               it relied on, and totals (quantities by basis, cost by basis
 *               when the party that froze it chose to record its own prices,
 *               loads). Never edited after it is written.
 *   stage_plan  the model's one stage plan: which stage list (and version)
 *               it uses and the stage it is in now (id `stage_plan`).
 *
 * Written only when every peer reads them (`gates:records`); an older peer is
 * refused in the "older server" words. Readers are tolerant: a field this
 * release doesn't know is kept; a record that isn't one reads as nothing.
 */

/** Peers read and store `gate` and `stage_plan` records and rules' `appliesAt`. */
export const GATES_RECORDS_FEATURE = "gates:records";

export const GATE_KIND = "gate";
export const STAGE_PLAN_KIND = "stage_plan";
/** The model's one stage plan record. */
export const STAGE_PLAN_ID = "stage_plan";

/** The key a gate total groups "nothing recorded" under (beside the `BASIS_POINT` rung ids). */
export const NOT_RECORDED_BASIS_KEY = "not_recorded";

/** One quantity line of a gate: a measure of a group (a cost code, a type, a class, a kind), and how much of it rests on each basis. */
export interface GateQuantityLine {
  /** `QtoGroup.key` ("code:<system>:<code>", "type:<id>", "class:<id>", "kind:<kind>"). */
  readonly group: string;
  readonly label: string;
  /** `qto.*` measure key. */
  readonly measure: string;
  /** bim-units code; totals are SI in it. */
  readonly unit: string;
  readonly total: number;
  /** By `BASIS_POINT` rung id, plus `not_recorded`; sums to `total`. */
  readonly byBasis: Readonly<Record<BasisId, number>>;
  readonly elementCount: number;
}

export interface QuantitySummary {
  readonly lines: readonly GateQuantityLine[];
}

/** Money by basis, in the reader's process (or, reserved, a newer host's stored copy). Minor units. */
export interface GateMoney {
  readonly minor: number;
  readonly currency: string;
  /** The price list it came from (`COST_SOURCE_POINT` id) and whose it is. */
  readonly sourceId: string;
  readonly party: string;
  /** That list's own basis (estimate, budget, contract, …). */
  readonly listBasis: string;
}

/** Load totals a host recorded at the gate (the load engine's numbers, by quantity key). */
export interface LoadSummary {
  readonly lines: readonly { readonly key: string; readonly unit: string; readonly total: number; readonly byBasis?: Readonly<Record<BasisId, number>> }[];
}

export interface GateTotals {
  readonly quantities: QuantitySummary;
  /**
   * Reserved (D3): money by `BASIS_POINT` rung id. No writer in this release:
   * a model never stores money (`cost/price.ts`), so a party prices a gate's
   * quantities in its own process (`gateCostByBasis`). Readers keep one a
   * newer host wrote.
   */
  readonly costByBasis?: Readonly<Record<BasisId, GateMoney>>;
  readonly loads?: LoadSummary;
}

/** What a gate marks. Open: a host's own purpose is kept. */
export type GatePurpose = "stage" | "issued_set" | "permit_submission" | "bid_lock" | "occupancy" | (string & {});

export interface GateBody {
  readonly stageId: string;
  /** The stage list the stage is from, as the model's plan pinned it. */
  readonly stageSet: { readonly id: string; readonly version: string };
  readonly purpose: GatePurpose;
  /** What a person reads ("CD issue", "Permit submission 2"). */
  readonly label: string;
  /** A plain lineage id (L11); `main` for the main copy. */
  readonly lineageId: string;
  readonly revision: number;
  /** `sha256:<hex>` over the frozen revision's records (`modelStateDigest`), or the host's checkpoint digest of the same revision. */
  readonly stateDigest: string;
  /** Issued sets it froze (the host's PDF and snapshot refs; the hashes stay in the host). */
  readonly issuedSetRefs: readonly string[];
  /** Sign-off chain sequence numbers it relied on. */
  readonly signoffSeqs: readonly number[];
  /** Disposition record ids (F11) it relied on. */
  readonly dispositionIds: readonly string[];
  readonly totals: GateTotals;
  readonly frozenBy: AuthorRef;
  /** ISO 8601. */
  readonly frozenAt: string;
}

export interface GateElement extends ModelElementBase {
  readonly kind: typeof GATE_KIND;
  readonly gate: GateBody;
  /** `sha256:<hex>` over the canonical body (`gateDigest`). A sign-off names it. */
  readonly digest: string;
  readonly schemaVersion?: number;
}

export interface StagePlanBody {
  readonly stageSet: { readonly id: string; readonly version: string };
  /** The stage the model is in now. Absent: before the list's first stage is started (reads as the first stage). */
  readonly currentStageId?: string;
  readonly setBy?: string;
  readonly setAt?: string;
}

export interface StagePlanElement extends ModelElementBase {
  readonly kind: typeof STAGE_PLAN_KIND;
  readonly plan: StagePlanBody;
  readonly schemaVersion?: number;
}

// ── kind rows (the existing row API) ───────────────────────────────────────

export const GATE_KIND_ROW: ElementKindItem = {
  kind: GATE_KIND,
  label: "Gate",
  nature: "record",
  upgrade: { newForOlderPeers: true, feature: GATES_RECORDS_FEATURE },
};

export const STAGE_PLAN_KIND_ROW: ElementKindItem = {
  kind: STAGE_PLAN_KIND,
  label: "Stage plan",
  nature: "record",
  upgrade: { newForOlderPeers: true, feature: GATES_RECORDS_FEATURE },
};

/** The lifecycle record rows, for `ELEMENT_KIND_POINT`'s kernel rows (coordinator / K11 line). */
export const LIFECYCLE_KIND_ROWS: readonly ElementKindItem[] = Object.freeze([GATE_KIND_ROW, STAGE_PLAN_KIND_ROW]);
registerKernelKindRows("kernel.lifecycle", LIFECYCLE_KIND_ROWS);

// ── gated writes ───────────────────────────────────────────────────────────

// The kinds sit outside the element union until K11's `UnknownRecord` lands (the cast `kinds/index.ts` uses for add-on kinds).
const step = (kind: string): SchemaStep => ({ kind: kind as BimElement["kind"], from: 1, to: 2, name: `lifecycle-${kind}`, feature: GATES_RECORDS_FEATURE, detect: () => false });

export const GATE_RECORD_STEP = step(GATE_KIND);
export const STAGE_PLAN_RECORD_STEP = step(STAGE_PLAN_KIND);

for (const s of [GATE_RECORD_STEP, STAGE_PLAN_RECORD_STEP]) {
  if (!schemaSteps(s.kind).some((x) => x.name === s.name)) registerSchemaStep(s);
}

/** Whether the command being decided may store gates and the stage plan (every peer reads `gates:records`). */
export function gatesWritable(): boolean {
  return stepAllowed(GATE_RECORD_STEP);
}

// ── tolerant readers ───────────────────────────────────────────────────────

type Raw = Readonly<Record<string, unknown>>;
const isRecord = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const texts = (v: unknown): v is readonly string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const wholes = (v: unknown): v is readonly number[] => Array.isArray(v) && v.every((x) => Number.isSafeInteger(x));

/** A stored gate body, checked; unknown fields kept. The reason in words when it isn't one. */
export function readGateBody(raw: unknown): { readonly ok: true; readonly value: GateBody } | { readonly ok: false; readonly reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: "a gate must be an object" };
  if (!isText(raw.stageId)) return { ok: false, reason: "a gate names its stage" };
  if (!isRecord(raw.stageSet) || !isText(raw.stageSet.id) || typeof raw.stageSet.version !== "string") return { ok: false, reason: `gate ${raw.stageId} names no stage list` };
  if (!isText(raw.lineageId) || !Number.isSafeInteger(raw.revision) || !isText(raw.stateDigest)) return { ok: false, reason: `gate ${raw.stageId} needs its copy, revision and state digest` };
  if (!texts(raw.issuedSetRefs) || !wholes(raw.signoffSeqs) || !texts(raw.dispositionIds)) return { ok: false, reason: `gate ${raw.stageId}'s issued sets, sign-offs and dispositions must be lists` };
  if (!isRecord(raw.totals) || !isRecord(raw.totals.quantities) || !Array.isArray(raw.totals.quantities.lines)) return { ok: false, reason: `gate ${raw.stageId} has no quantity totals` };
  if (!isRecord(raw.frozenBy) || !isText(raw.frozenBy.subject) || !isText(raw.frozenAt)) return { ok: false, reason: `gate ${raw.stageId} needs who froze it and when` };
  return { ok: true, value: { purpose: "stage", label: raw.stageId, ...raw } as unknown as GateBody };
}

export function isGateRecord(el: { readonly kind: string } | undefined): el is GateElement {
  return el !== undefined && el.kind === GATE_KIND && readGateBody((el as Raw).gate).ok && isText((el as Raw).digest);
}

/** A stored stage plan, checked; null when it isn't one. */
export function readStagePlan(raw: unknown): StagePlanBody | null {
  if (!isRecord(raw) || !isRecord(raw.stageSet) || !isText(raw.stageSet.id) || typeof raw.stageSet.version !== "string") return null;
  if (raw.currentStageId !== undefined && !isText(raw.currentStageId)) return null;
  return raw as unknown as StagePlanBody;
}

/** The model's stage plan, or null when none is recorded (the default stages, first stage). */
export function stagePlanOf(elements: Readonly<Record<string, BimElement>>): StagePlanBody | null {
  const el: unknown = elements[STAGE_PLAN_ID];
  if (!isRecord(el) || el.kind !== STAGE_PLAN_KIND) return null;
  return readStagePlan(el.plan);
}
