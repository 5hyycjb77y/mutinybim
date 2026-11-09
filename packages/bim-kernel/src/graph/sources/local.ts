import { canonicalJson } from "../../canonical";
import { REQUIREMENTS_SOURCE_CONTRACT, type RequirementsSourceDescriptor, type RequirementsSourceRow } from "../source";
import { elementsOfKind } from "../../store";
import type { BimElement, ModelState } from "../../types";
import { registerBuiltinRequirementsSource } from "../builtin-sources";
import { readRuleOnce } from "../compile";
import { checkRuleWords, type RuleFinding } from "../conformance";
import { readRuleRecord, type ReadResult } from "../records";
import type { RuleElement, RuleRecord } from "../types";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * The bundled `local` requirements source (REQUIREMENTS-GRAPH §4.6): the
 * firm's own code studies, stored with the model as `rule` records, so a
 * model carries its studies with it and an open-source user has a source out
 * of the box. It is also the fallback when a host's provider is unreachable.
 *
 * A local rule moves between models as a library item (`requirement_rule`):
 * the same header a `@permitzip/bim-library` item carries (id, revision,
 * optional content hash, key, name), with the rule as its body.
 */

export const LOCAL_SOURCE_ID = "local";

export const LOCAL_SOURCE_DESCRIPTOR: RequirementsSourceDescriptor = {
  id: LOCAL_SOURCE_ID,
  label: "This model's code studies",
  version: "1.0.0",
  contract: `^${REQUIREMENTS_SOURCE_CONTRACT}`,
  capabilities: { rules: true, verification: true },
  visibility: "model",
};

const rulesByRecord = new WeakMap<Elements, readonly RuleRecord[]>();

/** The local rules stored in a model (readable `rule` records), each under provider `local`. */
export function localRules(elements: Elements): readonly RuleRecord[] {
  const hit = rulesByRecord.get(elements);
  if (hit) return hit;
  const out: RuleRecord[] = [];
  // Read once per stored rule body, so an unchanged record is the same rule object in every revision.
  for (const el of elementsOfKind(elements, "rule")) {
    const r = readRuleOnce(el.rule, LOCAL_SOURCE_ID);
    if (r) out.push(r);
  }
  rulesByRecord.set(elements, out);
  return out;
}

export const LOCAL_SOURCE_ROW: RequirementsSourceRow = {
  descriptor: LOCAL_SOURCE_DESCRIPTOR,
  rules: (model: ModelState) => localRules(model.elements),
};

registerBuiltinRequirementsSource(LOCAL_SOURCE_ROW);

/** The element id a local rule is stored under. */
export function localRuleElementId(ruleId: string): string {
  return `rule:${ruleId}`;
}

/** The stored local rule record for a rule id, if any. */
export function localRuleRecord(elements: Elements, ruleId: string): RuleElement | null {
  const el = elements[localRuleElementId(ruleId)];
  return el?.kind === "rule" ? el : null;
}

// ── library items ──────────────────────────────────────────────────────────

export const RULE_LIBRARY_ITEM_TYPE = "requirement_rule";

export interface RuleLibraryItemBody {
  readonly id: string;
  readonly revision: number;
  readonly contentHash?: string;
  /** The rule id, stable across models ("firm.exit_count_small_rooms"). */
  readonly key: string;
  /** The rule's title. */
  readonly name: string;
  readonly description?: string;
  readonly rule: RuleRecord;
}

export interface RuleLibraryItem {
  readonly type: typeof RULE_LIBRARY_ITEM_TYPE;
  readonly body: RuleLibraryItemBody;
}

const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/** A local rule as a library item, ready for a firm library. Its provider becomes `local` again wherever it is imported. */
export function exportRuleToLibraryItem(rule: RuleRecord, options: { readonly itemId?: string; readonly revision?: number; readonly description?: string } = {}): RuleLibraryItem {
  const id = options.itemId ?? `rule.${rule.ruleId}`.replace(/[^A-Za-z0-9._:-]/g, "_");
  if (!ITEM_ID.test(id)) throw new Error(`"${id}" can't be a library item id: use letters, digits, dot, dash, colon or underscore`);
  return {
    type: RULE_LIBRARY_ITEM_TYPE,
    body: {
      id,
      revision: options.revision ?? 1,
      key: rule.ruleId,
      name: rule.title,
      ...(options.description ? { description: options.description } : {}),
      rule: { ...rule, provider: LOCAL_SOURCE_ID },
    },
  };
}

export interface ImportedRule {
  readonly rule: RuleRecord;
  /** Words and length findings (a copied-looking summary); the host shows them before the rule is added. */
  readonly findings: readonly RuleFinding[];
}

/** A library item read back as a local rule; refuses, with the reason, anything that isn't a readable `requirement_rule` item. Unknown fields are kept. */
export function importRuleFromLibraryItem(raw: unknown): ReadResult<ImportedRule> {
  if (typeof raw !== "object" || raw === null || !("type" in raw) || !("body" in raw)) return { ok: false, reason: "a library item needs a type and a body" };
  if (raw.type !== RULE_LIBRARY_ITEM_TYPE) return { ok: false, reason: `this library item is a ${String(raw.type)}, not a code-study rule` };
  const body: unknown = raw.body;
  if (typeof body !== "object" || body === null || !("rule" in body)) return { ok: false, reason: "this rule item has no rule in it" };
  const r = readRuleRecord(body.rule);
  if (!r.ok) return r;
  const rule: RuleRecord = { ...r.value, provider: LOCAL_SOURCE_ID };
  return { ok: true, value: { rule, findings: checkRuleWords(rule) } };
}

/** What two rules have in common for a round trip: equal canonical JSON. */
export function sameRule(a: RuleRecord, b: RuleRecord): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
