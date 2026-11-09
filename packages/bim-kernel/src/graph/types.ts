import type { JurisdictionId } from "../jurisdiction";
import type { ElementId, ModelElementBase } from "../types";

/**
 * The requirements graph (contract 1.4.0):
 * why every element exists, and what re-opens when something changes.
 *
 * Five node kinds, shared by every discipline:
 *   input          a fact the design starts from (space use, occupant load,
 *                  construction type, jurisdiction, adopted edition, a design
 *                  choice such as "protected throughout"), read from the model
 *   determination  a recorded judgment with the inputs it used (stored here,
 *                  record kind `determination`)
 *   rule           one provision as a code study: citation, applicability and
 *                  logic in the author's own words, never the code's text
 *                  (from a requirements source; the bundled local source
 *                  stores them as record kind `rule`)
 *   requirement    what a rule produced for an anchor; derived on read, stored
 *                  only when a person verifies, overrides or withdraws it
 *                  (record kind `requirement_state`)
 *   fulfilment     the elements that satisfy a requirement (the existing need /
 *                  fulfilment status, `requirements/status.ts`)
 *
 * Every edge carries its cause in plain words. Stored value lists are open:
 * readers keep a kind, status or key this release doesn't know.
 *
 * This file is types and constants only, so every layer may import it.
 */

// ── Protocol features ──────────────────────────────────────────────────────

/** Peers read and store `determination` records. */
export const GRAPH_DETERMINATIONS_FEATURE = "graph:determinations";
/** Peers read and store `rule` records (the local source). */
export const GRAPH_RULES_FEATURE = "graph:rules";
/** Peers read and store `requirement_state` records. */
export const GRAPH_REQUIREMENT_STATES_FEATURE = "graph:requirement_states";
/** Reserved: `observation` records. Readers keep them; no peer of this release advertises it, so nothing writes one. */
export const GRAPH_OBSERVATIONS_FEATURE = "graph:observations";

// ── Nodes and edges ────────────────────────────────────────────────────────

export const KNOWN_NODE_KINDS = ["input", "determination", "rule", "requirement", "fulfilment", "element", "space", "override"] as const;
export type NodeKind = (typeof KNOWN_NODE_KINDS)[number] | (string & {});

/** A node in an answer. `provider` names the requirements source a rule or requirement came from. */
export interface NodeRef {
  readonly kind: NodeKind;
  readonly id: string;
  readonly provider?: string;
}

export const KNOWN_EDGE_KINDS = ["informs", "produces", "fulfilled_by", "relaxes", "tightens", "supersedes", "decided_from", "anchors"] as const;
/**
 *   informs       input or determination → rule application
 *   produces      rule → requirement
 *   fulfilled_by  requirement → element
 *   relaxes       design choice → another rule's requirement (made easier)
 *   tightens      design choice → another rule's requirement (made harder)
 *   supersedes    override (requirement state) → requirement
 *   decided_from  determination → input
 *   anchors       space, zone or element → requirement anchored there (re-open on room makeup)
 */
export type EdgeKind = (typeof KNOWN_EDGE_KINDS)[number] | (string & {});

export interface GraphEdge {
  readonly from: NodeRef;
  readonly to: NodeRef;
  readonly kind: EdgeKind;
  /** Plain words: "Room 104 is hazard class 1 (your determination, Oct 30)". */
  readonly cause: string;
}

// ── Inputs ─────────────────────────────────────────────────────────────────

/**
 * What a rule declares it reads (`RuleRecord.reads`): dotted keys, open.
 *   `space.<field or parameter>`        a space's use, area, occupant load, a value
 *   `zone.<field or parameter>`
 *   `ceiling.<height_at | form | slope>` the typed ceiling over the anchor
 *   `determination.<key>`               a recorded determination on the anchor or the model
 *   `model.<setting or parameter>`      a model-wide input ("model.protected_throughout")
 *   `class.<class id>`                  elements of a class in the anchor (fulfilment readers)
 *   `<parameter key>`                   any registered parameter on the anchor
 */
export type InputKey = string;

/** One input a determination used, as it stood when decided. */
export interface InputRef {
  readonly key: InputKey;
  /** The element the input was read from, when there is one. */
  readonly elementId?: string;
  /** The value as it stood when decided (shown when it has since changed). */
  readonly value?: number | string | boolean;
  readonly unit?: string;
}

// ── Determinations (record kind `determination`) ───────────────────────────

export const KNOWN_DETERMINATION_SUBJECTS = ["space", "zone", "element", "model"] as const;
export type DeterminationSubjectKind = (typeof KNOWN_DETERMINATION_SUBJECTS)[number] | (string & {});

export interface DeterminationSubject {
  readonly kind: DeterminationSubjectKind;
  /** The space, zone or element. Absent for `model`. */
  readonly id?: string;
}

export const KNOWN_DETERMINATION_CONFIDENCES = ["high", "medium", "low"] as const;
export type DeterminationConfidence = (typeof KNOWN_DETERMINATION_CONFIDENCES)[number] | (string & {});

export const KNOWN_DETERMINATION_STATUSES = ["draft", "recorded", "superseded"] as const;
export type DeterminationStatus = (typeof KNOWN_DETERMINATION_STATUSES)[number] | (string & {});

export interface DeterminationBody {
  readonly subject: DeterminationSubject;
  /** What was decided, open registry id ("occupancy", "hazard_class", "occupant_load"). */
  readonly key: string;
  readonly value: number | string | boolean;
  readonly unit?: string;
  readonly inputs: readonly InputRef[];
  /** In the author's words. Never code text. */
  readonly reasoning: string;
  /** Who decided, as a person names themselves ("K. Example"). */
  readonly decidedBy: string;
  /** ISO 8601. */
  readonly decidedAt?: string;
  /** The adopted edition it was decided under ("VCC 2021"). */
  readonly edition?: string;
  readonly confidence: DeterminationConfidence;
  readonly status: DeterminationStatus;
  /** The determination this one replaces. */
  readonly supersedes?: string;
}

export interface DeterminationElement extends ModelElementBase {
  readonly kind: "determination";
  readonly determination: DeterminationBody;
  /** Record schema version (`schema-version/`). Absent: 1. */
  readonly schemaVersion?: number;
}

// ── Rules (what a source supplies; record kind `rule` for the local source) ─

export interface RuleCitation {
  /** The instrument ("IBC", "a standard", "a local code"). */
  readonly instrument: string;
  readonly edition: string;
  readonly section: string;
  /** Words as a source gave them ("VA", "Fairfax County"). Kept as written; `jurisdictionId` is the open id (C10). */
  readonly jurisdiction?: string;
  /** Where the adopted code applies, any country (round 10, C10). Absent: read `jurisdiction` with `parseJurisdiction`. */
  readonly jurisdictionId?: JurisdictionId;
  /** The adopting instrument when it isn't the model code itself ("Virginia USBC 2021"). Part of the pin: a change flags. */
  readonly adoptedAs?: string;
  /** A local amendment to this section and its version. Part of the pin: a changed amendment flags and is named. */
  readonly amendment?: { readonly id: string; readonly version: string };
}

/**
 * A code pack's declaration that a rule in a new edition carries forward the
 * same requirement from an earlier one unchanged (round 10, C10). Only the
 * pack says so; nothing infers it. An approval checked against the earlier
 * edition's section then stays current.
 */
export interface CarriedForward {
  /** The earlier edition ("2021"). */
  readonly fromEdition: string;
  /** The earlier section, when it moved ("903.2.1"); absent: the same section. */
  readonly fromSection?: string;
}

/** When a rule applies. Every field narrows; an absent field doesn't. `when` is a bim-formula expression over the rule's declared inputs. */
export interface Applicability {
  readonly jurisdiction?: readonly string[];
  readonly editions?: readonly string[];
  /** Determination values ("A-3", "B"). */
  readonly occupancy?: readonly string[];
  /** Space-use ids. */
  readonly spaceUses?: readonly string[];
  /** Element classes it reads. */
  readonly classes?: readonly string[];
  readonly when?: string;
}

/**
 * Where a requirement can sit. Round 11 (D3) adds `site` (the model's site),
 * `parcel` (a piece of land inside it: an add-on's intent record), `lineage`
 * (a copy, by id) and `gate` (a frozen stage), so a rule about the land
 * holds before a building exists. Which records an anchor kind is read
 * from is data (`GRAPH_ANCHOR_POINT`, graph/anchors.ts); the kernel names
 * the kinds only.
 */
export const KNOWN_REQUIREMENT_ANCHORS = ["space", "zone", "element", "model", "site", "parcel", "lineage", "gate"] as const;
export type RequirementAnchorKind = (typeof KNOWN_REQUIREMENT_ANCHORS)[number] | (string & {});

/** One anchor a rule is tied to: its kind and the record (or lineage) id; null for the model. */
export interface AppliesAtAnchor {
  readonly kind: RequirementAnchorKind;
  readonly id: string | null;
}

/**
 * Where and when a rule applies beyond `applies` (round 11, D3): only while
 * the model is in one of `stages` (stage ids of its stage list), and only at
 * `anchors` when listed. Every field narrows; an absent field doesn't.
 * Stored on rule records; an older peer keeps it and doesn't narrow by it
 * (it shows the rule's requirements at every stage).
 */
export interface AppliesAt {
  readonly stages?: readonly string[];
  readonly anchors?: readonly AppliesAtAnchor[];
}

export const KNOWN_REQUIREMENT_COMPARES = ["at_least", "at_most", "equal", "one_of"] as const;
export type RequirementCompare = (typeof KNOWN_REQUIREMENT_COMPARES)[number] | (string & {});

export interface RequirementTemplate {
  /** Dotted, open ("mech.outside_air", "arch.exit_count", "pack.spacing"). */
  readonly key: string;
  readonly anchor: RequirementAnchorKind;
  /** bim-formula over the declared inputs and the rule's tables. */
  readonly value: string;
  /** bim-units code. */
  readonly unit: string;
  readonly compare: RequirementCompare;
  /**
   * How the model's delivered value is read for the fulfilment, as an input
   * key over the anchor ("class.pack.device:count"). Absent: the
   * requirement has no model check (a person fills it).
   */
  readonly delivered?: InputKey;
}

/** Numbers and short labels the author tabulated. Never a reproduced page. */
export interface RuleTable {
  readonly id: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (number | string)[])[];
}

/** A design choice that changes another rule's requirement ("protected throughout" raises allowable area). */
export interface RuleEffect {
  /** The requirement key it acts on. */
  readonly target: string;
  readonly effect: "relaxes" | "tightens";
  /** bim-formula: the new value, with `value` bound to the target's value. */
  readonly value: string;
  /** Plain words shown as the cause ("protected throughout: allowable area raised"). */
  readonly cause: string;
}

export const KNOWN_RULE_VERIFICATIONS = ["agent_found", "proposed", "verified", "invalidated"] as const;
export type RuleVerificationStatus = (typeof KNOWN_RULE_VERIFICATIONS)[number] | (string & {});

export interface RuleVerification {
  readonly status: RuleVerificationStatus;
  readonly by?: string;
  readonly at?: string;
  readonly reason?: string;
}

/** Longest rule summary a source may carry (author's words; a long summary is a sign of copied text). */
export const RULE_SUMMARY_MAX_LENGTH = 600;
export const RULE_TITLE_MAX_LENGTH = 160;

export interface RuleRecord {
  /** Stable within the provider. */
  readonly ruleId: string;
  /** The source descriptor's id. */
  readonly provider: string;
  readonly citation: RuleCitation;
  /** Author's words, short (≤ RULE_TITLE_MAX_LENGTH). */
  readonly title: string;
  /** Author's words, never the code's text (≤ RULE_SUMMARY_MAX_LENGTH). */
  readonly summary: string;
  /** Open discipline id ("architecture", "fire_protection", a pack's). */
  readonly discipline: string;
  readonly applies: Applicability;
  readonly reads: readonly InputKey[];
  readonly produces: readonly RequirementTemplate[];
  readonly parameters?: Readonly<Record<string, { readonly value: number; readonly unit: string } | string | boolean>>;
  readonly tables?: readonly RuleTable[];
  readonly relaxes?: readonly RuleEffect[];
  readonly verification: RuleVerification;
  /**
   * The rule has no machine-readable logic: its requirements appear for a
   * person to fill, with no model check. `produces` may be empty.
   */
  readonly manual?: boolean;
  /** `coordination_only`: shown, never checked. */
  readonly scope?: "in_scope" | "coordination_only" | (string & {});
  /** Plain words a source gives for why it applies, shown as the cause until `applies` exists. */
  readonly triggeredBy?: string;
  /** Opaque back-pointer to the source's own row (a code-study requirement id). */
  readonly sourceRef?: { readonly provider: string; readonly ref: string };
  /** Chips the host shows beside the rule ("Library", "Weak source"). Words only. */
  readonly chips?: readonly string[];
  /**
   * Values the source's own people accepted for one requirement key at one
   * anchor (an override the model offered back and a person accepted). Each
   * replaces the derived value there; the derived value is kept as `was`.
   */
  readonly acceptedValues?: readonly AcceptedRequirementValue[];
  /**
   * The source's own version of this rule (round 10, C10): changes when the
   * source corrects the rule within one edition ("3", "2026-11-04"). Absent:
   * the rule has never been versioned, read as "1". A sign-off pins it.
   */
  readonly ruleVersion?: string;
  /** ISO 8601 date of the correction that made `ruleVersion`, shown as "corrected Nov 4". */
  readonly correctedAt?: string;
  /** Earlier editions this rule carries forward unchanged, declared by the source (never inferred). */
  readonly carriedForward?: readonly CarriedForward[];
  /** Tied to stages or anchors (round 11, D3). Absent: every stage, every anchor its templates name. */
  readonly appliesAt?: AppliesAt;
}

/** One accepted value from a source (contract 1.4.0, optional). */
export interface AcceptedRequirementValue {
  /** The requirement template key. */
  readonly key: string;
  /** The anchor it applies to; null for a model-anchored requirement. */
  readonly anchorId: string | null;
  readonly value: number | string | boolean;
  /** bim-units code; absent: the template's unit. */
  readonly unit?: string;
  readonly reason: string;
  /** Who accepted it, as the source names them. */
  readonly acceptedBy?: string;
  /** ISO 8601. */
  readonly acceptedAt?: string;
}

export interface RuleElement extends ModelElementBase {
  readonly kind: "rule";
  readonly rule: RuleRecord;
  readonly schemaVersion?: number;
}

// ── Requirements (derived) and their person-made states ────────────────────

export const KNOWN_REQUIREMENT_STATUSES = ["proposed", "verified", "overridden", "withdrawn"] as const;
export type RequirementStatus = (typeof KNOWN_REQUIREMENT_STATUSES)[number] | (string & {});

/** A requirement's stable id: `<provider>:<ruleId>:<template key>:<anchor id or "model">`. */
export type RequirementId = string;

export function requirementIdOf(provider: string, ruleId: string, key: string, anchorId: string | null): RequirementId {
  return `${provider}:${ruleId}:${key}:${anchorId ?? "model"}`;
}

export interface RequirementStateBody {
  readonly requirementId: RequirementId;
  readonly status: RequirementStatus;
  /** The replacing value, for `overridden`. */
  readonly value?: number | string | boolean;
  readonly unit?: string;
  /** Required for `overridden` and `withdrawn`. */
  readonly reason: string;
  readonly by: string;
  readonly at?: string;
  /** For write-back: the source's verdict on the offer, set by the host ("PermitZIP code study didn't accept it: …"). */
  readonly writeBack?: { readonly provider: string; readonly status: "pending" | "accepted" | "declined" | "failed" | (string & {}); readonly note?: string };
}

export interface RequirementStateElement extends ModelElementBase {
  readonly kind: "requirement_state";
  readonly state: RequirementStateBody;
  readonly schemaVersion?: number;
}

export const KNOWN_FULFILMENT_STATUSES = ["met", "not_met", "unchecked", "open"] as const;
export type FulfilmentState = (typeof KNOWN_FULFILMENT_STATUSES)[number] | (string & {});

/** One derived requirement as the graph returns it. */
export interface Requirement {
  readonly id: RequirementId;
  readonly provider: string;
  readonly ruleId: string;
  readonly key: string;
  readonly anchor: { readonly kind: RequirementAnchorKind; readonly id: string | null };
  /** The required value; null for a manual rule or a formula that couldn't evaluate (see `problem`). */
  readonly value: number | string | boolean | null;
  readonly unit: string;
  readonly compare: RequirementCompare;
  readonly status: RequirementStatus;
  readonly citation: RuleCitation;
  readonly title: string;
  /** Why it is here, in plain words. */
  readonly cause: string;
  /**
   * What a checklist groups it under: the design choice that changed it, the
   * determinations it rests on, the source's own trigger, or else the place
   * ("Room 104 is Ordinary Hazard 1"). Requirements with one cause share it.
   */
  readonly causeGroup?: string;
  /** `governing` unless a higher source produced the same key for the same anchor. */
  readonly standing: "governing" | "conflicting";
  /** The other requirements for the same key and anchor, from other sources. */
  readonly conflictsWith?: readonly RequirementId[];
  readonly fulfilment: {
    readonly state: FulfilmentState;
    readonly delivered?: number | string | boolean;
    readonly elementIds: readonly ElementId[];
    /** "Unit 2 delivers 150 of 138". */
    readonly summary?: string;
  };
  /** Element ids it read (re-derive when one changes). */
  readonly reads: readonly string[];
  /** Why it couldn't evaluate, in plain words. */
  readonly problem?: string;
  /** Design choices that changed its value (`relaxes` / `tightens`), with the value before each. */
  readonly effects?: readonly RequirementEffectApplied[];
  /** The value a person overrode (status `overridden`): the derived value it replaced. */
  readonly derivedValue?: number | string | boolean | null;
  /** The reason on its requirement state (verified, overridden or withdrawn). */
  readonly stateReason?: string;
  /** Its rule's standing in its source ("verified", "agent_found", "proposed"), apart from the model's own `status`. */
  readonly ruleVerification?: RuleVerificationStatus;
  /** Its rule's chips ("PermitZIP code study", "Library"). */
  readonly chips?: readonly string[];
  /** Its rule's back-pointer to the source's own row. */
  readonly sourceRef?: { readonly provider: string; readonly ref: string };
  /** A value its source accepted for this anchor (`RuleRecord.acceptedValues`), with the derived value it replaced. */
  readonly accepted?: { readonly was: number | string | boolean | null; readonly reason: string; readonly acceptedBy?: string; readonly acceptedAt?: string };
}

/** One design choice's effect on a requirement, as applied. */
export interface RequirementEffectApplied {
  readonly provider: string;
  readonly ruleId: string;
  readonly effect: "relaxes" | "tightens";
  readonly before: number | string | boolean | null;
  readonly after: number | string | boolean | null;
  readonly cause: string;
}

// ── Observations (reserved, record kind `observation`) ─────────────────────

export interface ObservationBody {
  readonly subject: DeterminationSubject;
  readonly requirementKey?: string;
  readonly observedBy: string;
  readonly at: string;
  readonly result: "meets" | "does_not_meet" | "not_observed" | (string & {});
  readonly note: string;
  readonly attachments: readonly { readonly provider: string; readonly ref: string }[];
}

export interface ObservationElement extends ModelElementBase {
  readonly kind: "observation";
  readonly observation: ObservationBody;
  readonly schemaVersion?: number;
}

export type GraphElement = DeterminationElement | RuleElement | RequirementStateElement | ObservationElement;

// ── Query answers ──────────────────────────────────────────────────────────

/** How long an impact or why list is before "and N more" (product owner decision 6). */
export const GRAPH_ANSWER_LIMIT = 5;

/** A quantity change a "what re-opens" answer carries ("+42 ft of 1-hour wall"). No money. */
export interface QuantityDelta {
  /** `qto.*` measure key ("qto.length"). */
  readonly measure: string;
  /** A class or classification code the delta is grouped by. */
  readonly group: string;
  readonly delta: number;
  /** bim-units code. */
  readonly unit: string;
  readonly label: string;
}

export interface RankedItem {
  readonly node: NodeRef;
  /** What it is, short ("Exits from Office 101–103"). */
  readonly label: string;
  /** Why it is in the answer, in plain words. */
  readonly cause: string;
  /** How many requirements and fulfilments it moves (the rank). */
  readonly weight: number;
  readonly edges?: readonly GraphEdge[];
}

export interface RankedAnswer {
  /** At most the limit, most consequential first. */
  readonly items: readonly RankedItem[];
  /** How many more there are ("and N more"). */
  readonly more: number;
  /** When there are no items: what the person sees instead. */
  readonly empty?: string;
}

export interface DependsOnAnswer extends RankedAnswer {
  readonly quantityDeltas: readonly QuantityDelta[];
}

export interface GraphQueryOptions {
  /** Default GRAPH_ANSWER_LIMIT. */
  readonly limit?: number;
}

/** The empty "why" answer (Nielsen 1). */
export const WHY_EMPTY = "Nothing in the code studies on this model points here";
/** The empty "what re-opens" answer. */
export const DEPENDS_ON_EMPTY = "Nothing in the code studies on this model re-opens";
