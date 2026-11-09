/**
 * Scenarios: the stored shape only, reserved for round 6 (FOUNDATION-COVERAGE
 * §2.7 item 9, KERNEL-FOUNDATION §7). A scenario is a named read-only layer
 * over needs: a load combination (1.2D + 1.6L), a design alternative (one system
 * against another) or a what-if. Nothing in this release writes one, no command takes
 * one and no screen shows one; the shape is fixed now so a model saved by a
 * round-6 peer reads here without loss. Readers keep fields they don't know.
 */

export const KNOWN_SCENARIO_KINDS = ["combination", "alternative", "what_if"] as const;
export type ScenarioKind = (typeof KNOWN_SCENARIO_KINDS)[number] | (string & {});

export interface ScenarioRef {
  readonly id: string;
  readonly label: string;
  readonly kind: ScenarioKind;
}

/** One term of a scenario: a factor on what a source contributes (a load case, a need group, an alternative's element set). */
export interface ScenarioTerm {
  /** What the factor applies to: a load case id, a need group id, a class id. Open: the owning pack reads it. */
  readonly ref: string;
  readonly factor: number;
}

/** An override a scenario lays over one element's values, by parameter key. */
export interface ScenarioValueOverride {
  readonly elementId: string;
  readonly values: Readonly<Record<string, number | string | boolean>>;
}

/** The overlay record a scenario stores. Every field but the ref is optional; unknown fields are kept. */
export interface ScenarioOverlay {
  readonly scenario: ScenarioRef;
  readonly terms?: readonly ScenarioTerm[];
  readonly overrides?: readonly ScenarioValueOverride[];
  /** Top-level fields a newer peer wrote, kept as stored (not a stored field itself: written back flat). */
  readonly kept?: Readonly<Record<string, unknown>>;
}

export type ScenarioReadResult = { readonly ok: true; readonly overlay: ScenarioOverlay; readonly knownKind: boolean } | { readonly ok: false; readonly reason: string };

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readRef(raw: unknown): ScenarioRef | string {
  if (!isRecord(raw)) return "a scenario needs an id, a label and a kind";
  const { id, label, kind } = raw;
  if (typeof id !== "string" || id.length === 0) return "a scenario's id must be a non-empty string";
  if (typeof label !== "string") return `scenario ${id}'s label must be a string`;
  if (typeof kind !== "string" || kind.length === 0) return `scenario ${id}'s kind must be a non-empty string`;
  return { ...raw, id, label, kind };
}

function readTerms(raw: unknown, id: string): ScenarioTerm[] | string {
  if (!Array.isArray(raw)) return `scenario ${id}'s terms must be a list`;
  const out: ScenarioTerm[] = [];
  for (const t of raw) {
    if (!isRecord(t) || typeof t.ref !== "string" || typeof t.factor !== "number" || !Number.isFinite(t.factor)) return `scenario ${id} has a term that isn't { ref, factor }`;
    out.push({ ...t, ref: t.ref, factor: t.factor });
  }
  return out;
}

const scalar = (v: unknown): v is number | string | boolean => typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));

function readOverrides(raw: unknown, id: string): ScenarioValueOverride[] | string {
  if (!Array.isArray(raw)) return `scenario ${id}'s overrides must be a list`;
  const out: ScenarioValueOverride[] = [];
  for (const o of raw) {
    if (!isRecord(o) || typeof o.elementId !== "string" || !isRecord(o.values)) return `scenario ${id} has an override that isn't { elementId, values }`;
    const values: Record<string, number | string | boolean> = {};
    for (const [k, v] of Object.entries(o.values)) {
      if (!scalar(v)) return `scenario ${id}'s override of ${o.elementId} has a value for ${k} that isn't a number, text or yes/no`;
      values[k] = v;
    }
    out.push({ ...o, elementId: o.elementId, values });
  }
  return out;
}

const OWN_FIELDS = new Set(["scenario", "terms", "overrides"]);

/**
 * A stored overlay as this release reads it: the ref, terms and overrides
 * checked, a kind this release doesn't know kept (`knownKind: false`), and
 * every field it doesn't read kept (top-level ones in `kept`, nested ones
 * on their own objects) so writing it back loses nothing. Refuses, with the reason, a record that isn't a scenario at all.
 */
export function readScenarioOverlay(raw: unknown): ScenarioReadResult {
  if (!isRecord(raw)) return { ok: false, reason: "a scenario overlay must be an object" };
  const ref = readRef(raw.scenario);
  if (typeof ref === "string") return { ok: false, reason: ref };
  const terms = raw.terms === undefined ? undefined : readTerms(raw.terms, ref.id);
  if (typeof terms === "string") return { ok: false, reason: terms };
  const overrides = raw.overrides === undefined ? undefined : readOverrides(raw.overrides, ref.id);
  if (typeof overrides === "string") return { ok: false, reason: overrides };
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!OWN_FIELDS.has(k)) kept[k] = v;
  const overlay: ScenarioOverlay = {
    scenario: ref,
    ...(terms ? { terms } : {}),
    ...(overrides ? { overrides } : {}),
    ...(Object.keys(kept).length > 0 ? { kept } : {}),
  };
  return { ok: true, overlay, knownKind: (KNOWN_SCENARIO_KINDS as readonly string[]).includes(ref.kind) };
}

/** The stored form of a read overlay: kept fields back at the top level, so read → write is lossless. */
export function scenarioOverlayRecord(overlay: ScenarioOverlay): Record<string, unknown> {
  return {
    ...(overlay.kept ?? {}),
    scenario: overlay.scenario,
    ...(overlay.terms ? { terms: overlay.terms } : {}),
    ...(overlay.overrides ? { overrides: overlay.overrides } : {}),
  };
}
