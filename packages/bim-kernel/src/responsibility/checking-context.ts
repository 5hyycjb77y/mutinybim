import { canonicalize, sha256HexOf } from "../authorship/canonical";
import { MAIN_LINEAGE } from "../findings";
import { isDeterminationRecord } from "../graph/records";
import type { DeterminationElement, RuleRecord } from "../graph/types";
import { jurisdictionKey, jurisdictionWords, parseJurisdiction, writeJurisdiction, type JurisdictionId } from "../jurisdiction";
import { elementsOfKind } from "../store";
import { graphStateIn, requirementsOf } from "../graph/engine";
import { withModelStatePacks } from "../packs/scope";
import type { BimElement, ModelState } from "../types";
import type { SignoffJson } from "./signoff-chain";

/**
 * What a sign-off was checked against (round 10 lane C10, design call 6).
 *
 * An approval, an acceptance, a classification or an answer pins its
 * checking context at sign time, **inside** the hashed payload of its
 * sign-off record (and so inside the S9 signature, which signs the record's
 * hash): the place it applies (an open `JurisdictionId`), the project's code
 * of record per discipline, the code packs and their versions, every rule it
 * relied on with its version, instrument, edition, section, adopting
 * instrument and amendment, and a digest of the determinations it rested on.
 *
 * Later, `contextStanding` compares the pin with what the project uses now.
 * Only the project's **code of record** (a model-wide determination
 * `code_of_record.<discipline>`, set on the project) and the rules' own
 * versions move it: a state adopting a new edition never does (vesting).
 * Comparisons are per instrument and section, never per book.
 *
 * Old records carry no context and read "Checking context not recorded";
 * they never block anything.
 */

/** Peers that read and keep `checking_context` on sign-off records (round 10). An older peer keeps the payload untouched. */
export const SIGNOFFS_CHECKING_CONTEXT_FEATURE = "signoffs:checking_context";
/** Peers that read `finding_disposition` records (round 10). */
export const SIGNOFFS_DISPOSITIONS_FEATURE = "signoffs:dispositions";
/** The payload key the context rides under. */
export const CHECKING_CONTEXT_KEY = "checking_context";
export const CHECKING_CONTEXT_VERSION = 1;
/** The most rules one record pins; beyond this the context says so (a sign-off payload is capped at 64 KB). */
export const MAX_PINNED_RULES = 200;
/** Determination key prefix for the project's code of record, one per discipline. */
export const CODE_OF_RECORD_KEY = "code_of_record";
/** The model-wide determination naming where the project is. */
export const JURISDICTION_KEY = "jurisdiction";

/** The slot a code of record fills ("building", "energy", a pack's own): an open id; the host lists and names them. */
export type CodeOfRecordDiscipline = string;

export interface Amendment {
  readonly id: string;
  readonly version: string;
}

/** The code the project is designed under for one discipline. */
export interface CodeOfRecord {
  readonly discipline: CodeOfRecordDiscipline;
  /** The model code as rules cite it ("IBC", "IECC", "NBC"). */
  readonly instrument: string;
  /** "2021". */
  readonly edition: string;
  /** The adopting instrument ("Virginia USBC 2021"). */
  readonly adoptedAs?: string;
  readonly amendment?: Amendment;
  /** The authority adopting it, when it differs from the project's (the fire marshal). */
  readonly jurisdiction?: JurisdictionId;
}

/** One rule a record relied on, as it was then. */
export interface RuleVersionRef {
  readonly provider: string;
  readonly ruleId: string;
  /** "1" when the source never versioned the rule. */
  readonly ruleVersion: string;
  readonly instrument: string;
  readonly edition: string;
  readonly section: string;
  readonly adoptedAs?: string;
  readonly amendment?: Amendment;
  readonly jurisdiction?: JurisdictionId;
}

export interface CheckingContext {
  readonly v: number;
  /** Which copy of the model it was true of: "main" until round 11's lineages. */
  readonly lineageId: string;
  readonly jurisdiction: JurisdictionId | null;
  readonly codesOfRecord: readonly CodeOfRecord[];
  readonly packs: ReadonlyArray<{ readonly id: string; readonly version: string }>;
  readonly rules: readonly RuleVersionRef[];
  /** `sha256:<hex>` of the determinations it rested on (id and version), so a reader can tell they're the same ones. */
  readonly determinationsDigest: string;
  /** True when more than `MAX_PINNED_RULES` rules were relied on; the first are kept. */
  readonly truncated?: boolean;
}

// ---------------------------------------------------------------- pinning

export function ruleVersionOf(rule: Pick<RuleRecord, "ruleVersion">): string {
  return rule.ruleVersion?.trim() || "1";
}

/** A rule as a record relies on it now. */
export function ruleVersionRef(rule: RuleRecord): RuleVersionRef {
  const c = rule.citation;
  const j = c.jurisdictionId ?? (c.jurisdiction ? parseJurisdiction(c.jurisdiction) : null);
  return {
    provider: rule.provider,
    ruleId: rule.ruleId,
    ruleVersion: ruleVersionOf(rule),
    instrument: c.instrument,
    edition: c.edition,
    section: c.section,
    ...(c.adoptedAs ? { adoptedAs: c.adoptedAs } : {}),
    ...(c.amendment ? { amendment: { id: c.amendment.id, version: c.amendment.version } } : {}),
    ...(j ? { jurisdiction: j } : {}),
  };
}

function determinationsDigest(determinations: ReadonlyArray<{ readonly id: string; readonly version: number }>): string {
  const pairs = determinations.map((d) => [d.id, d.version] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return `sha256:${sha256HexOf(canonicalize(pairs))}`;
}

export interface CheckingContextInput {
  readonly jurisdiction: JurisdictionId | null;
  readonly codesOfRecord: readonly CodeOfRecord[];
  readonly packs?: ReadonlyArray<{ readonly id: string; readonly version: string }>;
  readonly rules: readonly RuleRecord[];
  readonly determinations?: ReadonlyArray<{ readonly id: string; readonly version: number }>;
  readonly lineageId?: string;
}

/** The context a record pins at sign time. Deterministic: the same inputs give the same bytes. */
export function buildCheckingContext(input: CheckingContextInput): CheckingContext {
  const seen = new Set<string>();
  const refs: RuleVersionRef[] = [];
  for (const r of input.rules) {
    const key = `${r.provider}\u0000${r.ruleId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ruleVersionRef(r));
  }
  refs.sort((a, b) => (a.provider + a.ruleId < b.provider + b.ruleId ? -1 : a.provider + a.ruleId > b.provider + b.ruleId ? 1 : 0));
  const kept = refs.slice(0, MAX_PINNED_RULES);
  const codes = [...input.codesOfRecord].sort((a, b) => (a.discipline < b.discipline ? -1 : a.discipline > b.discipline ? 1 : 0));
  const packs = [...(input.packs ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    v: CHECKING_CONTEXT_VERSION,
    lineageId: input.lineageId ?? MAIN_LINEAGE,
    jurisdiction: input.jurisdiction,
    codesOfRecord: codes,
    packs,
    rules: kept,
    determinationsDigest: determinationsDigest(input.determinations ?? []),
    ...(refs.length > kept.length ? { truncated: true } : {}),
  };
}

// ---------------------------------------------------------------- the code of record, in the model

type Elements = Readonly<Record<string, BimElement>>;

function inForce(d: DeterminationElement): boolean {
  return d.determination.status === "recorded";
}

/** Determination records, from the kind index (a handful per model; never a model scan). */
function determinations(elements: Elements): DeterminationElement[] {
  const out: DeterminationElement[] = [];
  for (const el of elementsOfKind(elements, "determination" as BimElement["kind"])) if (isDeterminationRecord(el)) out.push(el);
  return out;
}

function inputText(d: DeterminationElement, key: string): string | undefined {
  const v = d.determination.inputs.find((i) => i.key === key)?.value;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function amendmentFrom(text: string | undefined): Amendment | undefined {
  if (!text) return undefined;
  const at = text.lastIndexOf("@");
  return at > 0 ? { id: text.slice(0, at), version: text.slice(at + 1) } : { id: text, version: "1" };
}

/** A code-of-record determination's body as a code of record, or null when it isn't one. */
export function codeOfRecordOf(d: DeterminationElement): CodeOfRecord | null {
  const key = d.determination.key;
  if (!key.startsWith(`${CODE_OF_RECORD_KEY}.`) || d.determination.subject.kind !== "model") return null;
  const discipline = key.slice(CODE_OF_RECORD_KEY.length + 1);
  const instrument = inputText(d, "instrument");
  const edition = inputText(d, "edition") ?? d.determination.edition;
  if (!discipline || !instrument || !edition) return null;
  const adoptedAs = inputText(d, "adopted_as");
  const amendment = amendmentFrom(inputText(d, "amendment"));
  const j = parseJurisdiction(inputText(d, "jurisdiction"));
  return { discipline, instrument, edition, ...(adoptedAs ? { adoptedAs } : {}), ...(amendment ? { amendment } : {}), ...(j ? { jurisdiction: j } : {}) };
}

/** The project's codes of record (one per discipline, the determinations in force), from the kind index. */
export function codesOfRecord(elements: Elements): CodeOfRecord[] {
  const out = new Map<string, CodeOfRecord>();
  for (const d of determinations(elements)) {
    if (!inForce(d)) continue;
    const c = codeOfRecordOf(d);
    if (c) out.set(c.discipline, c);
  }
  return [...out.values()].sort((a, b) => (a.discipline < b.discipline ? -1 : 1));
}

/** Where the project is (the model-wide `jurisdiction` determination), read tolerantly: a stored "VA" is Virginia. */
export function projectJurisdiction(elements: Elements): JurisdictionId | null {
  for (const d of determinations(elements)) {
    if (!inForce(d) || d.determination.key !== JURISDICTION_KEY || d.determination.subject.kind !== "model") continue;
    return parseJurisdiction(d.determination.value);
  }
  return null;
}

/** The determinations in force a pin rests on (id and version). */
export function determinationsInForce(elements: Elements): Array<{ readonly id: string; readonly version: number }> {
  return determinations(elements).filter(inForce).map((d) => ({ id: d.id, version: d.version }));
}

/** The decision a person records to set a discipline's code of record (`record_determination` / `supersede_determination` fields). */
export function codeOfRecordDecision(c: CodeOfRecord): {
  readonly key: string;
  readonly value: string;
  readonly edition: string;
  readonly inputs: ReadonlyArray<{ readonly key: string; readonly value: string }>;
} {
  const inputs: Array<{ key: string; value: string }> = [
    { key: "instrument", value: c.instrument },
    { key: "edition", value: c.edition },
  ];
  if (c.adoptedAs) inputs.push({ key: "adopted_as", value: c.adoptedAs });
  if (c.amendment) inputs.push({ key: "amendment", value: `${c.amendment.id}@${c.amendment.version}` });
  if (c.jurisdiction) inputs.push({ key: "jurisdiction", value: jurisdictionKey(c.jurisdiction) });
  return { key: `${CODE_OF_RECORD_KEY}.${c.discipline}`, value: codeLabel(c), edition: c.edition, inputs };
}

/**
 * The rules a sign-off over these elements relies on: every rule whose
 * requirement is anchored at, read from, or fulfilled by one of them (the
 * graph's own dependency index), or every rule in force when no elements are
 * named (a model-wide approval).
 */
export function reliedRules(model: ModelState, elementIds?: readonly string[]): RuleRecord[] {
  return withModelStatePacks(model, () => {
    const state = graphStateIn(model);
    const scope = elementIds && elementIds.length > 0 ? new Set(elementIds) : null;
    const keys = new Set<string>();
    for (const r of requirementsOf(model)) {
      if (scope && !(r.anchor.id !== null && scope.has(r.anchor.id)) && !r.reads.some((id) => scope.has(id)) && !r.fulfilment.elementIds.some((id) => scope.has(id))) continue;
      keys.add(`${r.provider}\u0000${r.ruleId}`);
    }
    const out: RuleRecord[] = [];
    for (const k of keys) {
      const cr = state.compiled.rules.get(k);
      if (cr) out.push(cr.rule);
    }
    return out;
  });
}

/** What the project uses now, from the open model: its codes of record and every rule in force (for `contextStanding`). */
export function currentCodesFor(model: ModelState): CurrentCodes {
  const rules = withModelStatePacks(model, () => [...graphStateIn(model).compiled.rules.values()].map((cr) => cr.rule));
  return { codesOfRecord: codesOfRecord(model.elements), rules };
}

/** Everything a sign-off pins, read from the open model: where, the codes of record, the relied rules, the determinations in force. */
export function checkingContextFor(model: ModelState, on: { readonly elementIds?: readonly string[]; readonly packs?: CheckingContextInput["packs"] } = {}): CheckingContext {
  return buildCheckingContext({
    jurisdiction: projectJurisdiction(model.elements),
    codesOfRecord: codesOfRecord(model.elements),
    rules: reliedRules(model, on.elementIds),
    determinations: determinationsInForce(model.elements),
    packs: on.packs ?? model.settings.packs ?? [],
  });
}

// ---------------------------------------------------------------- stored form

function amendmentJson(a: Amendment): SignoffJson {
  return { id: a.id, version: a.version };
}

function codeJson(c: CodeOfRecord): SignoffJson {
  return {
    discipline: c.discipline,
    instrument: c.instrument,
    edition: c.edition,
    ...(c.adoptedAs ? { adoptedAs: c.adoptedAs } : {}),
    ...(c.amendment ? { amendment: amendmentJson(c.amendment) } : {}),
    ...(c.jurisdiction ? { jurisdiction: writeJurisdiction(c.jurisdiction) } : {}),
  };
}

function ruleJson(r: RuleVersionRef): SignoffJson {
  return {
    provider: r.provider,
    ruleId: r.ruleId,
    ruleVersion: r.ruleVersion,
    instrument: r.instrument,
    edition: r.edition,
    section: r.section,
    ...(r.adoptedAs ? { adoptedAs: r.adoptedAs } : {}),
    ...(r.amendment ? { amendment: amendmentJson(r.amendment) } : {}),
    ...(r.jurisdiction ? { jurisdiction: writeJurisdiction(r.jurisdiction) } : {}),
  };
}

/** The JSON a sign-off payload stores under `checking_context` (text and whole numbers only, so every host hashes it the same way). */
export function writeCheckingContext(ctx: CheckingContext): { readonly [key: string]: SignoffJson } {
  return {
    v: ctx.v,
    lineageId: ctx.lineageId,
    jurisdiction: ctx.jurisdiction ? writeJurisdiction(ctx.jurisdiction) : null,
    codesOfRecord: ctx.codesOfRecord.map(codeJson),
    packs: ctx.packs.map((p) => ({ id: p.id, version: p.version })),
    rules: ctx.rules.map(ruleJson),
    determinationsDigest: ctx.determinationsDigest,
    ...(ctx.truncated ? { truncated: true } : {}),
  };
}

type Raw = Readonly<Record<string, unknown>>;

function isRaw(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function readAmendment(v: unknown): Amendment | undefined {
  return isRaw(v) && str(v.id) && str(v.version) ? { id: String(v.id), version: String(v.version) } : undefined;
}

function readCode(v: unknown): CodeOfRecord | null {
  if (!isRaw(v)) return null;
  const discipline = str(v.discipline);
  const instrument = str(v.instrument);
  const edition = str(v.edition);
  if (!discipline || !instrument || !edition) return null;
  const adoptedAs = str(v.adoptedAs);
  const amendment = readAmendment(v.amendment);
  const j = v.jurisdiction === undefined ? null : parseJurisdiction(v.jurisdiction);
  return { discipline, instrument, edition, ...(adoptedAs ? { adoptedAs } : {}), ...(amendment ? { amendment } : {}), ...(j ? { jurisdiction: j } : {}) };
}

function readRule(v: unknown): RuleVersionRef | null {
  if (!isRaw(v)) return null;
  const provider = str(v.provider);
  const ruleId = str(v.ruleId);
  const instrument = str(v.instrument);
  const edition = str(v.edition);
  const section = str(v.section);
  if (!provider || !ruleId || !instrument || edition === undefined || !section) return null;
  const adoptedAs = str(v.adoptedAs);
  const amendment = readAmendment(v.amendment);
  const j = v.jurisdiction === undefined ? null : parseJurisdiction(v.jurisdiction);
  return { provider, ruleId, ruleVersion: str(v.ruleVersion) ?? "1", instrument, edition, section, ...(adoptedAs ? { adoptedAs } : {}), ...(amendment ? { amendment } : {}), ...(j ? { jurisdiction: j } : {}) };
}

/**
 * A stored context, from a sign-off payload (or the context object itself).
 * Null when the record carries none (every record before round 10). Tolerant:
 * unknown fields are ignored, malformed rules or codes are dropped, a newer
 * version is read for the fields this release knows.
 */
export function readCheckingContext(payloadOrContext: unknown): CheckingContext | null {
  if (!isRaw(payloadOrContext)) return null;
  const raw = isRaw(payloadOrContext[CHECKING_CONTEXT_KEY]) ? (payloadOrContext[CHECKING_CONTEXT_KEY] as Raw) : "determinationsDigest" in payloadOrContext ? payloadOrContext : null;
  if (!raw) return null;
  const codes = Array.isArray(raw.codesOfRecord) ? raw.codesOfRecord.map(readCode).filter((c): c is CodeOfRecord => c !== null) : [];
  const rules = Array.isArray(raw.rules) ? raw.rules.map(readRule).filter((r): r is RuleVersionRef => r !== null) : [];
  const packs = Array.isArray(raw.packs) ? raw.packs.filter(isRaw).flatMap((p) => (str(p.id) && str(p.version) ? [{ id: String(p.id), version: String(p.version) }] : [])) : [];
  return {
    v: typeof raw.v === "number" ? raw.v : CHECKING_CONTEXT_VERSION,
    lineageId: str(raw.lineageId) ?? MAIN_LINEAGE,
    jurisdiction: raw.jurisdiction == null ? null : parseJurisdiction(raw.jurisdiction),
    codesOfRecord: codes,
    packs,
    rules,
    determinationsDigest: str(raw.determinationsDigest) ?? "",
    ...(raw.truncated === true ? { truncated: true } : {}),
  };
}

// ---------------------------------------------------------------- words

/** "IBC 2021", or the adopting instrument's words when there is one ("Virginia USBC 2021 (IBC 2021)"). */
export function codeLabel(c: Pick<CodeOfRecord, "instrument" | "edition" | "adoptedAs">): string {
  const base = `${c.instrument} ${c.edition}`.trim();
  return c.adoptedAs && c.adoptedAs !== base ? `${c.adoptedAs} (${base})` : base;
}

function sectionWords(r: RuleVersionRef): string {
  return `${r.instrument} ${r.edition} §${r.section.replace(/^§/, "")}`.replace(/\s+/g, " ").trim();
}

function adoptionWords(r: RuleVersionRef): string | null {
  if (r.jurisdiction) return `${jurisdictionWords(r.jurisdiction)} adoption`;
  return r.adoptedAs ?? null;
}

/** "IBC 2021 §903.2 (Virginia adoption), rule v3". */
export function ruleRefWords(r: RuleVersionRef): string {
  const adoption = adoptionWords(r);
  const amend = r.amendment ? `, amendment ${r.amendment.id} v${r.amendment.version}` : "";
  return `${sectionWords(r)}${adoption ? ` (${adoption})` : ""}${amend}, rule v${r.ruleVersion}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}` : null;
}

// ---------------------------------------------------------------- standing

/** What the project uses now, to compare a pin against. */
export interface CurrentCodes {
  readonly codesOfRecord: readonly CodeOfRecord[];
  /** The rules every loaded source supplies now. */
  readonly rules: readonly RuleRecord[];
}

/** One relied rule that no longer matches, and why, in words. */
export interface OlderRuleItem {
  readonly rule: RuleVersionRef;
  readonly why: "edition" | "removed" | "rule_version" | "amendment" | "adoption";
  readonly words: string;
  /** The record line's lead words for this item ("Checked against an earlier version of this rule (corrected Nov 4)"). */
  readonly headline: string;
}

export type ContextStanding =
  | { readonly state: "not_recorded"; readonly words: string }
  | { readonly state: "current"; readonly words: string; readonly carried: readonly string[] }
  | { readonly state: "older"; readonly words: string; readonly items: readonly OlderItem[]; readonly sourceVersion: string };

export type OlderItem = OlderRuleItem;

export const NOT_RECORDED_WORDS = "Checking context not recorded";
export const OLDER_RULE_WORDS = "Checked against an older rule";

/** The current rules, indexed once per call set (by provider + rule id, and by instrument + edition). */
export class CurrentRuleIndex {
  readonly byId = new Map<string, RuleRecord>();
  readonly byEdition = new Map<string, RuleRecord[]>();
  readonly providers = new Set<string>();
  readonly codes = new Map<string, CodeOfRecord>();
  /** Override keys by what changed, so records sharing a change hash it once. */
  readonly sourceVersions = new Map<string, string>();

  constructor(current: CurrentCodes) {
    for (const r of current.rules) {
      this.byId.set(`${r.provider}\u0000${r.ruleId}`, r);
      this.providers.add(r.provider);
      const k = editionKey(r.citation.instrument, r.citation.edition);
      const list = this.byEdition.get(k);
      if (list) list.push(r);
      else this.byEdition.set(k, [r]);
    }
    for (const c of current.codesOfRecord) this.codes.set(c.instrument.toLowerCase(), c);
  }

  private readonly editionIndex = new Map<string, { readonly sections: ReadonlySet<string>; readonly carried: ReadonlyMap<string, RuleRecord> }>();

  /** One edition's sections and carried-forward declarations (`<from edition>|<section>`), built once per edition. */
  edition(instrument: string, edition: string): { readonly sections: ReadonlySet<string>; readonly carried: ReadonlyMap<string, RuleRecord>; readonly empty: boolean } {
    const k = editionKey(instrument, edition);
    let hit = this.editionIndex.get(k);
    if (!hit) {
      const sections = new Set<string>();
      const carried = new Map<string, RuleRecord>();
      for (const r of this.byEdition.get(k) ?? []) {
        sections.add(normSection(r.citation.section));
        for (const f of r.carriedForward ?? []) carried.set(`${f.fromEdition}|${normSection(f.fromSection ?? r.citation.section)}`, r);
      }
      hit = { sections, carried };
      this.editionIndex.set(k, hit);
    }
    return { ...hit, empty: hit.sections.size === 0 };
  }
}

function normSection(s: string): string {
  return s.replace(/^§/, "").trim().toLowerCase();
}

function editionKey(instrument: string, edition: string): string {
  return `${instrument.toLowerCase()}\u0000${edition}`;
}

function sameAmendment(a: Amendment | undefined, b: Amendment | undefined): boolean {
  return (a?.id ?? null) === (b?.id ?? null) && (a?.version ?? null) === (b?.version ?? null);
}

function ruleStanding(pinned: RuleVersionRef, idx: CurrentRuleIndex): { readonly older: OlderItem | null; readonly carried: string | null; readonly now: string } {
  const code = idx.codes.get(pinned.instrument.toLowerCase());
  if (code && code.edition !== pinned.edition) {
    const inNew = idx.edition(pinned.instrument, code.edition);
    const carrier = inNew.carried.get(`${pinned.edition}|${normSection(pinned.section)}`);
    if (carrier) return { older: null, carried: `${sectionWords(pinned)} is carried forward unchanged into ${codeLabel(code)} (as §${carrier.citation.section.replace(/^§/, "")})`, now: `${code.edition}|carried|${carrier.provider}:${carrier.ruleId}` };
    const now = `${code.instrument}|${code.edition}`;
    if (!inNew.empty && !inNew.sections.has(normSection(pinned.section))) {
      return { older: { rule: pinned, why: "removed", headline: OLDER_RULE_WORDS, words: `The rule this was checked against is not in ${codeLabel(code)} (${sectionWords(pinned)})` }, carried: null, now };
    }
    return { older: { rule: pinned, why: "edition", headline: OLDER_RULE_WORDS, words: `Checked against ${sectionWords(pinned)}; the project now uses ${codeLabel(code)}` }, carried: null, now };
  }
  if (code && code.adoptedAs && pinned.adoptedAs && code.adoptedAs !== pinned.adoptedAs) {
    return { older: { rule: pinned, why: "adoption", headline: OLDER_RULE_WORDS, words: `Checked against ${pinned.adoptedAs}; the project now uses ${code.adoptedAs}` }, carried: null, now: `${code.edition}|${code.adoptedAs}` };
  }
  const live = idx.byId.get(`${pinned.provider}\u0000${pinned.ruleId}`);
  if (!live) {
    if (idx.providers.has(pinned.provider)) return { older: { rule: pinned, why: "removed", headline: OLDER_RULE_WORDS, words: `The rule this was checked against (${sectionWords(pinned)}) is no longer in its code pack` }, carried: null, now: `${pinned.provider}:${pinned.ruleId}|gone` };
    return { older: null, carried: null, now: `${pinned.provider}:${pinned.ruleId}|unloaded` };
  }
  const liveAmend = live.citation.amendment;
  if (!sameAmendment(liveAmend, pinned.amendment)) {
    const named = liveAmend ?? pinned.amendment;
    return { older: { rule: pinned, why: "amendment", headline: OLDER_RULE_WORDS, words: `Checked against ${sectionWords(pinned)} before amendment ${named?.id ?? ""} changed${liveAmend ? ` (now v${liveAmend.version})` : " (now withdrawn)"}`.replace(/\s+/g, " ") }, carried: null, now: `amend|${liveAmend?.id ?? ""}@${liveAmend?.version ?? ""}` };
  }
  const liveVersion = ruleVersionOf(live);
  if (liveVersion !== pinned.ruleVersion) {
    const when = shortDate(live.correctedAt);
    const headline = `Checked against an earlier version of this rule${when ? ` (corrected ${when})` : ""}`;
    return { older: { rule: pinned, why: "rule_version", headline, words: `${headline}: ${sectionWords(pinned)}, v${pinned.ruleVersion} → v${liveVersion}` }, carried: null, now: `v${liveVersion}` };
  }
  return { older: null, carried: null, now: `v${liveVersion}` };
}

function sourceVersionOf(idx: CurrentRuleIndex, now: string[]): string {
  const key = now.sort().join("\u0001");
  const hit = idx.sourceVersions.get(key);
  if (hit) return hit;
  const v = `sha256:${sha256HexOf(canonicalize(now))}`;
  idx.sourceVersions.set(key, v);
  return v;
}

/** "Checked against IBC 2021 §903.2 (Virginia adoption), rule v3" (and "and N more"). */
export function checkedAgainstWords(ctx: CheckingContext): string {
  const first = ctx.rules[0];
  if (!first) {
    const code = ctx.codesOfRecord[0];
    return code ? `Checked under ${codeLabel(code)}; no rule relied on` : "No code rule relied on";
  }
  const more = ctx.rules.length > 1 ? `, and ${ctx.rules.length - 1} more rule${ctx.rules.length > 2 ? "s" : ""}` : "";
  return `Checked against ${ruleRefWords(first)}${more}`;
}

/**
 * Whether a pinned context still matches what the project uses. O(pinned
 * rules) with the index; reads nothing else.
 */
export function contextStanding(ctx: CheckingContext | null, current: CurrentCodes | CurrentRuleIndex): ContextStanding {
  if (!ctx) return { state: "not_recorded", words: NOT_RECORDED_WORDS };
  const idx = current instanceof CurrentRuleIndex ? current : new CurrentRuleIndex(current);
  const older: OlderItem[] = [];
  const carried: string[] = [];
  const now: string[] = [];
  for (const r of ctx.rules) {
    const s = ruleStanding(r, idx);
    if (s.older) {
      older.push(s.older);
      now.push(`${r.provider}:${r.ruleId}=${s.now}`);
    }
    if (s.carried) carried.push(s.carried);
  }
  if (older.length === 0) return { state: "current", words: checkedAgainstWords(ctx), carried };
  const only = older.length === 1 ? older[0] : undefined;
  return {
    state: "older",
    words: only ? only.headline : OLDER_RULE_WORDS,
    items: older,
    sourceVersion: sourceVersionOf(idx, now),
  };
}

// ---------------------------------------------------------------- the carry, across many records

/** A sign-off record and its pin, as the host reads them. */
export interface PinnedRecord {
  readonly id: string;
  /** The person who signed it (their user id / subject). */
  readonly signer: string;
  readonly signerName?: string;
  readonly context: CheckingContext | null;
}

/** What changed: disciplines' codes of record, by instrument, and rules by provider + id. */
export interface CodeChange {
  readonly instruments?: readonly string[];
  readonly rules?: ReadonlyArray<{ readonly provider: string; readonly ruleId: string }>;
}

/**
 * Records filed by what they pinned (instrument, rule), so a code change
 * re-checks only the records relying on it: never the whole log.
 */
export class CheckingContextIndex {
  private readonly byInstrument = new Map<string, Set<string>>();
  private readonly byRule = new Map<string, Set<string>>();
  readonly records = new Map<string, PinnedRecord>();

  constructor(records: readonly PinnedRecord[]) {
    for (const r of records) this.add(r);
  }

  add(r: PinnedRecord): void {
    this.records.set(r.id, r);
    if (!r.context) return;
    for (const rule of r.context.rules) {
      file(this.byInstrument, rule.instrument.toLowerCase(), r.id);
      file(this.byRule, `${rule.provider}\u0000${rule.ruleId}`, r.id);
    }
  }

  /** The ids of records relying on anything in the change. */
  relyingOn(change: CodeChange): Set<string> {
    const out = new Set<string>();
    for (const i of change.instruments ?? []) for (const id of this.byInstrument.get(i.toLowerCase()) ?? []) out.add(id);
    for (const r of change.rules ?? []) for (const id of this.byRule.get(`${r.provider}\u0000${r.ruleId}`) ?? []) out.add(id);
    return out;
  }
}

function file(map: Map<string, Set<string>>, key: string, id: string): void {
  const set = map.get(key);
  if (set) set.add(id);
  else map.set(key, new Set([id]));
}

export interface CarryResult {
  /** Records whose pin no longer matches, with why. */
  readonly older: ReadonlyArray<{ readonly record: PinnedRecord; readonly standing: Extract<ContextStanding, { state: "older" }> }>;
  /** How many records were re-checked (the reliant ones only). */
  readonly rechecked: number;
}

/** Re-check only the records relying on what changed. */
export function codeChangeCarry(index: CheckingContextIndex, change: CodeChange, current: CurrentCodes | CurrentRuleIndex): CarryResult {
  const idx = current instanceof CurrentRuleIndex ? current : new CurrentRuleIndex(current);
  const ids = index.relyingOn(change);
  const older: Array<{ record: PinnedRecord; standing: Extract<ContextStanding, { state: "older" }> }> = [];
  for (const id of ids) {
    const record = index.records.get(id);
    if (!record) continue;
    const s = contextStanding(record.context, idx);
    if (s.state === "older") older.push({ record, standing: s });
  }
  return { older, rechecked: ids.size };
}

/** One bell per signer per code change, listing the rules (never one per rule). */
export interface CodeChangeNotice {
  readonly signer: string;
  readonly signerName?: string;
  readonly recordIds: readonly string[];
  /** The relied rules that changed, each once ("IBC 2021 §903.2"). */
  readonly rules: readonly string[];
}

export function codeChangeNotices(carry: CarryResult): CodeChangeNotice[] {
  const by = new Map<string, { signerName?: string; ids: string[]; rules: Set<string> }>();
  for (const { record, standing } of carry.older) {
    let n = by.get(record.signer);
    if (!n) by.set(record.signer, (n = { ...(record.signerName ? { signerName: record.signerName } : {}), ids: [], rules: new Set() }));
    n.ids.push(record.id);
    for (const item of standing.items) n.rules.add(sectionWords(item.rule));
  }
  return [...by]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([signer, n]) => ({ signer, ...(n.signerName ? { signerName: n.signerName } : {}), recordIds: n.ids.sort(), rules: [...n.rules].sort() }));
}

/** A discipline's code of record moving from one code to another (or being set or cleared). */
export interface CodeOfRecordChange {
  readonly discipline: string;
  readonly instrument: string;
  readonly from: CodeOfRecord | null;
  readonly to: CodeOfRecord | null;
}

function codeKey(c: CodeOfRecord | null): string {
  return c ? `${c.instrument}|${c.edition}|${c.adoptedAs ?? ""}|${c.amendment ? `${c.amendment.id}@${c.amendment.version}` : ""}|${c.jurisdiction ? jurisdictionKey(c.jurisdiction) : ""}` : "";
}

/** Which disciplines' codes of record differ between two readings. Nothing else is a code change. */
export function codeOfRecordChanges(before: readonly CodeOfRecord[], after: readonly CodeOfRecord[]): CodeOfRecordChange[] {
  const b = new Map(before.map((c) => [c.discipline, c]));
  const a = new Map(after.map((c) => [c.discipline, c]));
  const out: CodeOfRecordChange[] = [];
  for (const discipline of new Set([...b.keys(), ...a.keys()])) {
    const from = b.get(discipline) ?? null;
    const to = a.get(discipline) ?? null;
    if (codeKey(from) === codeKey(to)) continue;
    out.push({ discipline, instrument: (to ?? from)?.instrument ?? discipline, from, to });
  }
  return out.sort((x, y) => (x.discipline < y.discipline ? -1 : 1));
}

/** The notice key: one bell per signer per (model, discipline, from → to). The same change twice is the same key. */
export function codeChangeKey(modelId: string, change: CodeOfRecordChange): string {
  return `${modelId}:${change.discipline}:${change.from ? codeLabel(change.from) : "none"}->${change.to ? codeLabel(change.to) : "none"}`;
}

/** "The project now uses IBC 2024. 3 of your approvals were checked against IBC 2021." */
export function codeChangeWords(change: CodeOfRecordChange, count: number): string {
  const now = change.to ? `The project now uses ${codeLabel(change.to)}.` : `The project no longer names a ${change.discipline.replace(/_/g, " ")} code.`;
  const was = change.from ? codeLabel(change.from) : "an earlier code";
  return `${now} ${count} of your approvals ${count === 1 ? "was" : "were"} checked against ${was}.`;
}
