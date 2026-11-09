import { scriptManifestSchema, valueIssues, type ScriptKind, type ScriptManifest, type ScriptParameter, type ScriptPreset, type ScriptReads, type ScriptValue } from "@permitzip/bim-library";
import { measure, measureIn, type Kind, type Measure, type UnitCode } from "@permitzip/bim-units";
import type { ScriptContext } from "./context";
import type { ScriptResult } from "./output";

/**
 * `defineScript` (round 11 X11; SCRIPTING-PROPOSAL §5.1): a script's
 * manifest (kind, typed parameters, presets, what it reads) and its `run`.
 * The manifest is the library `script` item's, so any host can draw a form
 * from it. Quantities use the shared unit library: a script reads
 * `values.spacing` as a `Measure` and never meets a bare number with no unit.
 */

/** Quantities in the units people write: `units.ft(12)`, `units.in(18)`. */
export const units = {
  mm: (v: number): Measure => measure("length", v, "mm"),
  m: (v: number): Measure => measure("length", v, "m"),
  in: (v: number): Measure => measure("length", v, "in"),
  ft: (v: number): Measure => measure("length", v, "ft"),
  of: (kind: Kind, value: number, unit: UnitCode): Measure => measure(kind, value, unit),
  /** A measure's value in a unit (`units.in_(m, "mm")`). */
  in_: (m: Measure, unit: UnitCode): number => measureIn(m, unit),
};

type Bound = Measure | number;

/** A parameter as a script declares it: the stored shape, with quantity bounds given as measures. */
export type ParameterDecl =
  | (Omit<Extract<ScriptParameter, { type: "quantity" }>, "default" | "min" | "max"> & { readonly default?: Bound; readonly min?: Bound; readonly max?: Bound })
  | Exclude<ScriptParameter, { type: "quantity" }>;

export type ParameterDecls = Readonly<Record<string, ParameterDecl>>;

/** What `run` receives for each parameter. */
export type ValueOf<P extends ParameterDecl> = P extends { type: "quantity" } ? Measure : P extends { type: "number" } ? number : P extends { type: "boolean" } ? boolean : string;
export type ValuesOf<P extends ParameterDecls> = { readonly [K in keyof P]: ValueOf<P[K]> };

export interface ScriptSpec<P extends ParameterDecls> {
  readonly kind: ScriptKind;
  readonly reads: ScriptReads;
  readonly parameters: P;
  readonly presets?: readonly ScriptPreset[];
  run(ctx: ScriptContext, values: ValuesOf<P>): ScriptResult | Promise<ScriptResult>;
}

/** A defined script: its stored manifest and its run over stored (SI) values. */
export interface ScriptDefinition {
  readonly manifest: ScriptManifest;
  /** `values` as stored (quantities in SI), already checked against the manifest. */
  runWith(ctx: ScriptContext, values: Readonly<Record<string, ScriptValue>>): ScriptResult | Promise<ScriptResult>;
}

export class ScriptDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptDefinitionError";
  }
}

function si(name: string, decl: Extract<ParameterDecl, { type: "quantity" }>, b: Bound | undefined): number | undefined {
  if (b === undefined || typeof b === "number") return b;
  if (b.kind !== decl.kind) throw new ScriptDefinitionError(`Parameter ${name} is a ${decl.kind}, and one of its bounds is a ${b.kind}.`);
  return b.value;
}

function storedParameter(name: string, decl: ParameterDecl): ScriptParameter {
  if (decl.type !== "quantity") return decl;
  const { default: d, min, max, ...rest } = decl;
  const out: ScriptParameter = { ...rest };
  const dv = si(name, decl, d);
  const minv = si(name, decl, min);
  const maxv = si(name, decl, max);
  return { ...out, ...(dv !== undefined ? { default: dv } : {}), ...(minv !== undefined ? { min: minv } : {}), ...(maxv !== undefined ? { max: maxv } : {}) };
}

export function defineScript<P extends ParameterDecls>(spec: ScriptSpec<P>): ScriptDefinition {
  const parameters: Record<string, ScriptParameter> = {};
  for (const [name, decl] of Object.entries(spec.parameters)) parameters[name] = storedParameter(name, decl);
  const parsed = scriptManifestSchema.safeParse({ kind: spec.kind, parameters, presets: spec.presets ?? [], reads: spec.reads });
  if (!parsed.success) throw new ScriptDefinitionError(`This script's manifest isn't valid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(top)"} ${i.message}`).join("; ")}.`);
  const manifest = parsed.data;
  return {
    manifest,
    runWith(ctx, values) {
      const typed: Record<string, ScriptValue | Measure> = {};
      for (const [name, p] of Object.entries(manifest.parameters)) {
        const v = values[name];
        if (v === undefined) continue;
        typed[name] = p.type === "quantity" && typeof v === "number" ? { kind: p.kind, value: v } : v;
      }
      // The typed record is exactly ValuesOf<P> by construction from the same manifest.
      return spec.run(ctx, typed as ValuesOf<P>);
    },
  };
}

/**
 * The values a run uses, as stored: the preset's over the defaults, the
 * given ones over both. Refuses an unknown name, a missing required value
 * or one out of range, in words. Quantities may be given as measures.
 */
export function resolveValues(manifest: ScriptManifest, given: Readonly<Record<string, ScriptValue | Measure>> = {}, presetId?: string): Record<string, ScriptValue> {
  const preset = presetId === undefined ? undefined : manifest.presets.find((p) => p.id === presetId);
  if (presetId !== undefined && !preset) throw new ScriptDefinitionError(`This script has no preset "${presetId}" (it has ${manifest.presets.map((p) => p.id).join(", ") || "none"}).`);
  const out: Record<string, ScriptValue> = {};
  for (const name of Object.keys(given)) if (!manifest.parameters[name]) throw new ScriptDefinitionError(`This script has no parameter "${name}" (it has ${Object.keys(manifest.parameters).join(", ") || "none"}).`);
  for (const [name, p] of Object.entries(manifest.parameters)) {
    const raw = given[name] ?? preset?.values[name] ?? ("default" in p ? p.default : undefined);
    if (raw === undefined) {
      if (p.type === "boolean") out[name] = false;
      else throw new ScriptDefinitionError(`${p.label} (${name}) needs a value: it has no default.`);
      continue;
    }
    let value: ScriptValue;
    if (typeof raw === "object") {
      if (p.type !== "quantity") throw new ScriptDefinitionError(`${p.label} (${name}) isn't a quantity, so it can't take a measure.`);
      if (raw.kind !== p.kind) throw new ScriptDefinitionError(`${p.label} (${name}) is a ${p.kind}; the value given is a ${raw.kind}.`);
      value = raw.value;
    } else value = raw;
    const issues = valueIssues(p, value);
    if (issues[0]) throw new ScriptDefinitionError(`${p.label} (${name}) ${issues[0]}`);
    out[name] = value;
  }
  return out;
}
