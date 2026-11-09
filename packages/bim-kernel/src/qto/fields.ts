import type { Kind, UnitCode } from "@permitzip/bim-units";
import { readCode } from "../classification/registry";
import { builtinRegistry } from "../registry/builtin";
import type { ClassId, FieldProvider, FieldValue } from "../registry/types";
import type { BimElement } from "../types";
import { locked, textOrNull } from "../fields/providers/support";
import type { ProviderField } from "../fields/providers/support";
import type { FieldProviderRow } from "../fields/providers";
import { constructionStageIdOf, qtoGroupOf } from "./group";
import { BUILTIN_MEASURE_RULES, measureElement } from "./measure";
import { isConstructionStage } from "../construction/members";

/**
 * `qto.*` derived parameters as fields, on every class the kernel measures:
 * quantities (length, areas, volume, count, weight), the code and stage they
 * group by, and in words what each quantity is measured from (Nielsen 2).
 * Read-only in a schedule: quantities come from the geometry; codes are set
 * in the type's Inspector and stages in Manage › Construction stages.
 */

type Elements = Readonly<Record<string, BimElement>>;

/** Kinds a pack's rule may measure beyond the kernel's own (links a service draws between parts). */
const PACK_MEASURED_KINDS: readonly string[] = ["service_link"];

let measuredClasses: readonly ClassId[] | null = null;

/** Every built-in class whose elements a measure rule reads: recognised from a measured kind, or a part category. */
export function qtoMeasuredClasses(): readonly ClassId[] {
  if (measuredClasses) return measuredClasses;
  const kinds = new Set<string>([...BUILTIN_MEASURE_RULES.flatMap((r) => r.kinds ?? []), ...PACK_MEASURED_KINDS]);
  measuredClasses = builtinRegistry()
    .listClasses()
    .filter((c) => (c.recognize?.elementKinds ?? []).some((k) => kinds.has(k)) || (c.recognize?.partCategories?.length ?? 0) > 0)
    .map((c) => c.id);
  return measuredClasses;
}

/** What a takeoff groups an uncoded or unstaged element under, so the group has words. */
export const NO_CODE = "No cost code";
export const NO_STAGE = "No stage";

const READ_ONLY = locked("Measured from the model's geometry and types; change the element to change it.");
const CODE_LOCKED = locked("Set the code in the type's Inspector › Classification, or on the element.");
const STAGE_LOCKED = locked("Set the stage from Manage › Construction stages.");

function quantityField(key: string, label: string, kind: Kind, unit: UnitCode, from: string): ProviderField {
  return {
    path: key,
    label,
    classes: qtoMeasuredClasses(),
    valueType: "quantity",
    kind,
    unit,
    writer: READ_ONLY,
    deps: { elementKinds: ["opening", "element_type", "room"] },
    group: "Quantities",
    description: `Measured from: ${from}.`,
    read: (el, ctx): FieldValue => measureElement(ctx.elements, el)?.values[key] ?? null,
  };
}

function stageName(elements: Elements, el: BimElement): string | null {
  const id = constructionStageIdOf(el);
  if (id === null) return NO_STAGE;
  const stage = elements[id];
  // A stage deleted by another person while this element still names it reads as its id, never blank.
  return isConstructionStage(stage) ? stage.stage.name : `Stage ${id} (deleted)`;
}

function measuredFrom(elements: Elements, el: BimElement): string | null {
  const m = measureElement(elements, el);
  if (!m) return null;
  const present = m.rule.measures.filter((d) => m.values[d.key] !== undefined);
  return textOrNull(present.map((d) => `${d.label ?? d.key}: ${d.from}`).join("; "));
}

function codeText(elements: Elements, el: BimElement): string | null {
  const g = qtoGroupOf(elements, el);
  return g.kind === "classification" ? g.label : NO_CODE;
}

function codeWarning(elements: Elements, el: BimElement): string | null {
  const g = qtoGroupOf(elements, el);
  if (g.kind !== "classification" || !g.classification) return null;
  return readCode(g.classification.system, g.classification.code).warning;
}

const definitions = (): readonly ProviderField[] => {
  const d = new Map(BUILTIN_MEASURE_RULES.flatMap((r) => r.measures).map((m) => [m.key, m]));
  const from = (key: string, fallback: string): string => d.get(key)?.from ?? fallback;
  return [
    quantityField("qto.length", "Length", "length", "m", from("qto.length", "centreline length")),
    quantityField("qto.area", "Area", "area", "m2", from("qto.area", "plan area")),
    quantityField("qto.area_gross", "Face area", "area", "m2", from("qto.area_gross", "length × height, one face")),
    quantityField("qto.area_net", "Net face area", "area", "m2", from("qto.area_net", "face area less hosted doors and windows")),
    quantityField("qto.area_surface", "Surface area", "area", "m2", from("qto.area_surface", "surface area along its slope")),
    quantityField("qto.volume", "Volume", "volume", "m3", from("qto.volume", "area × thickness")),
    quantityField("qto.count", "Count", "count", "ea", "one per element"),
    quantityField("qto.mass", "Weight", "mass", "kg", "the type's unit weight or weight per length"),
    {
      path: "qto.code",
      label: "Cost code",
      classes: qtoMeasuredClasses(),
      valueType: "text",
      writer: CODE_LOCKED,
      deps: { elementKinds: ["element_type"] },
      group: "Quantities",
      description: "The element's classification code (its own, else its type's), with the code list's words when the list has them.",
      read: (el, ctx) => codeText(ctx.elements, el),
    },
    {
      path: "qto.code_warning",
      label: "Code check",
      classes: qtoMeasuredClasses(),
      valueType: "text",
      writer: CODE_LOCKED,
      deps: { elementKinds: ["element_type"] },
      group: "Quantities",
      description: "Says when a code isn't in its code list, or its list isn't loaded. The code is kept as typed.",
      read: (el, ctx) => codeWarning(ctx.elements, el),
    },
    {
      path: "qto.group",
      label: "What",
      classes: qtoMeasuredClasses(),
      valueType: "text",
      writer: READ_ONLY,
      deps: { elementKinds: ["element_type"] },
      group: "Quantities",
      description: "What the quantities group under: the cost code, else the type, else the class.",
      read: (el, ctx) => qtoGroupOf(ctx.elements, el).label,
    },
    {
      path: "qto.size",
      label: "Size",
      classes: qtoMeasuredClasses(),
      valueType: "text",
      writer: READ_ONLY,
      group: "Quantities",
      description: "The size or material a trade's measure groups by (a size and material, a wire size).",
      read: (el, ctx) => textOrNull(measureElement(ctx.elements, el)?.sizeGroup ?? null),
    },
    {
      path: "qto.stage",
      label: "Construction stage",
      classes: qtoMeasuredClasses(),
      valueType: "text",
      writer: STAGE_LOCKED,
      deps: { elementKinds: ["construction_stage"] },
      group: "Quantities",
      description: "The construction stage it is built in.",
      read: (el, ctx) => stageName(ctx.elements, el),
    },
    {
      path: "qto.measured_from",
      label: "Measured from",
      classes: qtoMeasuredClasses(),
      valueType: "text",
      writer: READ_ONLY,
      deps: { elementKinds: ["opening", "element_type"] },
      group: "Quantities",
      description: "In words, what each of its quantities is measured from.",
      read: (el, ctx) => measuredFrom(ctx.elements, el),
    },
  ];
};

let provider: FieldProvider | null = null;

/** The quantities provider (built on first use, after every class has registered). */
export function qtoFieldProvider(): FieldProvider {
  provider ??= { id: "qto", fields: definitions() };
  return provider;
}

/** Rank among the built-in providers: after spatial, serves, placement and loads. */
export const QTO_FIELD_PROVIDER_RANK = 80;

const withQto = new WeakMap<readonly FieldProviderRow[], readonly FieldProviderRow[]>();

/** `rows` plus the quantities provider, the same array on every call (the pack set caches by identity). */
export function withQtoFieldProvider(rows: readonly FieldProviderRow[]): readonly FieldProviderRow[] {
  const hit = withQto.get(rows);
  if (hit) return hit;
  const out: readonly FieldProviderRow[] = Object.freeze([...rows, { id: "qto", provider: qtoFieldProvider(), rank: QTO_FIELD_PROVIDER_RANK }]);
  withQto.set(rows, out);
  return out;
}
