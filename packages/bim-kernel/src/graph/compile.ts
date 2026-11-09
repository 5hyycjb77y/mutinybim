import type { FormulaType } from "@permitzip/bim-formula";
import { expectedType, formulaFields } from "./formula";
import { readRuleRecord } from "./records";
import type { RequirementsSnapshot } from "./source";
import type { RequirementTemplate, RuleEffect, RuleRecord } from "./types";

/**
 * A rule compiled once per rule object (a snapshot's rules once per snapshot
 * revision, REQUIREMENTS-GRAPH §6): its formulas' field lists parsed, the
 * template's expected result type, and what it is indexed by (space uses,
 * classes, anchor kinds). Evaluation compiles each formula per input
 * signature on first use (`formula.ts`).
 */

export interface CompiledFormulaText {
  readonly source: string;
  /** Null when the text doesn't parse; `problem` says why. */
  readonly fields: readonly string[] | null;
}

export interface CompiledTemplate {
  readonly template: RequirementTemplate;
  readonly value: CompiledFormulaText;
  readonly expect: FormulaType | undefined;
}

export interface CompiledEffect {
  readonly effect: RuleEffect;
  readonly value: CompiledFormulaText;
}

export interface CompiledRule {
  /** `<provider>\u0000<ruleId>`. */
  readonly key: string;
  readonly rule: RuleRecord;
  readonly when: CompiledFormulaText | null;
  readonly templates: readonly CompiledTemplate[];
  readonly effects: readonly CompiledEffect[];
  readonly anchorKinds: ReadonlySet<string>;
  /** Every field any of its formulas reads (inputs, parameters, `value`). */
  readonly fields: readonly string[];
  /** It reads the typed ceiling over its anchor (re-opens on a ceiling change). */
  readonly readsCeiling: boolean;
}

export function ruleKeyOf(provider: string, ruleId: string): string {
  return `${provider}\u0000${ruleId}`;
}

function text(source: string): CompiledFormulaText {
  return { source, fields: formulaFields(source) };
}

const byRule = new WeakMap<RuleRecord, CompiledRule>();

export function compileRule(rule: RuleRecord): CompiledRule {
  const hit = byRule.get(rule);
  if (hit) return hit;
  // An equality or one-of requirement may be a label ("light", "A"); its unit only checks a quantity result (valueInUnit).
  const templates = rule.produces.map((t): CompiledTemplate => ({ template: t, value: text(t.value), expect: t.compare === "equal" || t.compare === "one_of" ? undefined : expectedType(t.unit) }));
  const effects = (rule.relaxes ?? []).map((e): CompiledEffect => ({ effect: e, value: text(e.value) }));
  const when = rule.applies.when ? text(rule.applies.when) : null;
  const fields = new Set<string>();
  for (const f of [when, ...templates.map((t) => t.value), ...effects.map((e) => e.value)]) for (const p of f?.fields ?? []) fields.add(p);
  const compiled: CompiledRule = {
    key: ruleKeyOf(rule.provider, rule.ruleId),
    rule,
    when,
    templates,
    effects,
    anchorKinds: new Set(rule.produces.map((t) => t.anchor)),
    fields: [...fields],
    readsCeiling: rule.reads.some((k) => k.startsWith("ceiling.")) || [...fields].some((k) => k.startsWith("ceiling.")),
  };
  byRule.set(rule, compiled);
  return compiled;
}

const readByRaw = new WeakMap<object, RuleRecord | null>();

/** `readRuleRecord` once per supplied object, so an add-on row returning the same rules every read compiles them once. Null (logged) when unreadable. */
export function readRuleOnce(raw: unknown, provider: string): RuleRecord | null {
  if (typeof raw !== "object" || raw === null) {
    console.error(`[bim-kernel/graph] ${provider} supplied a rule that isn't an object; it is skipped`);
    return null;
  }
  if (readByRaw.has(raw)) return readByRaw.get(raw) ?? null;
  const r = readRuleRecord(raw);
  let out: RuleRecord | null = null;
  if (!r.ok) console.error(`[bim-kernel/graph] ${provider} supplied a rule this release can't read; it is skipped`, { reason: r.reason });
  else out = r.value.provider === provider ? r.value : { ...r.value, provider };
  readByRaw.set(raw, out);
  return out;
}

export interface CompiledSnapshot {
  readonly rules: readonly CompiledRule[];
  /** Rules the snapshot carried that this release can't read, with the reason. */
  readonly refused: readonly { readonly ruleId: string; readonly reason: string }[];
}

const bySnapshot = new WeakMap<RequirementsSnapshot, CompiledSnapshot>();

/**
 * Read and compile a snapshot's rules once (`requirements.snapshot.bind.2k_rules`).
 * An unreadable rule is refused with its reason, logged, and skipped; the
 * rest of the snapshot still binds. Each rule's provider is the snapshot's
 * source id.
 */
export function compileSnapshot(snapshot: RequirementsSnapshot): CompiledSnapshot {
  const hit = bySnapshot.get(snapshot);
  if (hit) return hit;
  const rules: CompiledRule[] = [];
  const refused: { ruleId: string; reason: string }[] = [];
  for (const raw of snapshot.rules) {
    const r = readRuleRecord(raw);
    if (!r.ok) {
      const ruleId = typeof raw === "object" && raw !== null && "ruleId" in raw && typeof raw.ruleId === "string" ? raw.ruleId : "?";
      refused.push({ ruleId, reason: r.reason });
      continue;
    }
    rules.push(compileRule(r.value.provider === snapshot.source.id ? r.value : { ...r.value, provider: snapshot.source.id }));
  }
  if (refused.length > 0) console.error(`[bim-kernel/graph] ${snapshot.source.label} supplied ${refused.length} rule(s) this release can't read; they are skipped`, { refused: refused.slice(0, 10) });
  const out: CompiledSnapshot = { rules, refused };
  bySnapshot.set(snapshot, out);
  return out;
}
