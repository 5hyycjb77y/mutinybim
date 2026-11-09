import type { UnitCatalog } from "@permitzip/bim-kernel";
import { formulaEngine, type CellValue, type FormulaError, type FormulaSchema, type FormulaType, type NamedCalculationSignature, type RowValues } from "@permitzip/bim-formula";
import { convert, fromCanonical, fromSI, isUnitCode, toSI, unitAllowed } from "@permitzip/bim-units";
import type { CalculationSignature, FormulaCheck, FormulaEngine, FormulaFieldContext, FormulaSpan, FormulaTypeContext, FormulaValue } from "./formula";
import type { ExampleValue, OperandType } from "./schema";

/**
 * Library validation over the real engines (`@permitzip/bim-formula`,
 * `@permitzip/bim-units`), so a library is checked by the code that will
 * evaluate it in schedules and tags. Kept out of the package index: the core
 * takes engines by injection and runs without these two packages.
 *
 * A calculation with parameters is checked the way it will run: as a call
 * `PZ.Key({__param_0}, …)` whose arguments are typed like the parameters, so
 * the engine compiles the body with the parameters bare in scope. Errors in
 * the body then point at the whole expression.
 */

const paramField = (i: number) => `__param_${i}`;

function toFormulaType(t: OperandType): FormulaType {
  return t.valueType === "quantity" ? { type: "quantity", kind: t.kind, unit: t.unit } : { type: t.valueType };
}

function toOperandType(t: FormulaType): OperandType {
  return t.type === "quantity" ? { valueType: "quantity", kind: t.kind, unit: t.unit } : { valueType: t.type };
}

function signature(id: string, sig: CalculationSignature): NamedCalculationSignature {
  return { id, params: sig.params.map((p) => ({ name: p.name, type: toFormulaType(p.type) })), result: toFormulaType(sig.result), expression: sig.expression };
}

function fieldSchema(ctx: FormulaFieldContext, extra: ReadonlyMap<string, OperandType> = new Map()): FormulaSchema {
  return {
    field(path) {
      const t = extra.get(path) ?? ctx.field(path);
      return t ? { type: toFormulaType(t) } : undefined;
    },
    relationship(name) {
      const rel = ctx.relationship(name);
      return rel ? { ...(rel.label ? { label: rel.label } : {}), target: fieldSchema(rel) } : undefined;
    },
  };
}

interface Prepared {
  readonly source: string;
  readonly schema: FormulaSchema;
  /** True when the expression is compiled as a call to itself (it has parameters). */
  readonly wrapped: boolean;
}

function prepare(expression: string, ctx: FormulaTypeContext, expect: OperandType | undefined): Prepared {
  const params = new Map(ctx.params.map((p, i) => [paramField(i), p.type] as const));
  const self: CalculationSignature | undefined = expect ? { params: ctx.params, result: expect, expression } : ctx.calculation(ctx.key);
  const schema: FormulaSchema = {
    ...fieldSchema(ctx, params),
    calculation(id) {
      if (id === ctx.key && self) return signature(id, self);
      const sig = ctx.calculation(id);
      return sig ? signature(id, sig) : undefined;
    },
  };
  if (ctx.params.length === 0) return { source: expression, schema, wrapped: false };
  return { source: `${ctx.key}(${ctx.params.map((_, i) => `{${paramField(i)}}`).join(", ")})`, schema, wrapped: true };
}

function located(expression: string, prepared: Prepared, key: string, e: FormulaError): { message: string; span: FormulaSpan } {
  if (!prepared.wrapped) return { message: e.message, span: e.span };
  const prefix = `In ${key}: `;
  return { message: e.message.startsWith(prefix) ? e.message.slice(prefix.length) : e.message, span: { start: 0, end: expression.length } };
}

/** A parameter written as `{name}` reads a field of that name in this engine; the library refuses it so there is one syntax. */
function bracedParams(expression: string, ctx: FormulaTypeContext): { message: string; span: FormulaSpan }[] {
  const deps = formulaEngine.dependenciesOf(expression);
  if (!deps.ok) return [];
  const names = new Set(ctx.params.map((p) => p.name));
  return deps.fields
    .filter((path) => names.has(path))
    .map((name) => {
      const at = new RegExp(`\\{\\s*${name}\\s*\\}`).exec(expression);
      return {
        message: `Write the input ${name} without braces, as ${name}: braces read a field of the element, like {own.mbh}`,
        span: at ? { start: at.index, end: at.index + at[0].length } : { start: 0, end: expression.length },
      };
    });
}

function cellFor(name: string, value: ExampleValue | undefined, type: FormulaType): CellValue {
  if (value === undefined) return null;
  if (type.type === "quantity") {
    if (typeof value === "number") return fromCanonical(type.kind, toSI(value, type.unit));
    if (typeof value !== "object") throw new Error(`${name} needs a number, not ${JSON.stringify(value)}`);
    if (!isUnitCode(value.unit) || !unitAllowed(type.kind, value.unit)) throw new Error(`${name} is given in "${value.unit}", which is not a ${type.kind.replace(/_/g, " ")} unit`);
    return fromCanonical(type.kind, toSI(value.value, value.unit));
  }
  if (type.type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`${name} needs yes or no (true/false), not ${JSON.stringify(value)}`);
    return value;
  }
  if (typeof value !== "string") throw new Error(`${name} needs text, not ${JSON.stringify(value)}`);
  return value;
}

export const bimFormulaEngine: FormulaEngine = {
  check(expression, ctx, opts): FormulaCheck {
    const braced = bracedParams(expression, ctx);
    if (braced.length > 0) return { ok: false, errors: braced };
    const prepared = prepare(expression, ctx, opts?.expect);
    const compiled = formulaEngine.compile(prepared.source, prepared.schema, opts?.expect ? { expect: toFormulaType(opts.expect) } : undefined);
    if (!compiled.ok) {
      // A call cycle: validation names the whole circle itself, in plain words.
      const deps = formulaEngine.dependenciesOf(expression);
      if (opts?.expect && deps.ok && compiled.errors.every((e) => e.code === "cycle")) {
        return { ok: true, resultType: opts.expect, references: { inputs: deps.fields, calculations: deps.calculations } };
      }
      return { ok: false, errors: compiled.errors.map((e) => located(expression, prepared, ctx.key, e)) };
    }
    const deps = compiled.formula.dependencies;
    return {
      ok: true,
      resultType: toOperandType(compiled.formula.type),
      references: {
        inputs: deps.fields.filter((f) => !f.startsWith("__param_")),
        calculations: deps.calculations.filter((k) => !(prepared.wrapped && k === ctx.key)),
      },
    };
  },

  evaluate(expression, inputs, ctx, opts): FormulaValue {
    const prepared = prepare(expression, ctx, opts?.expect);
    const compiled = formulaEngine.compile(prepared.source, prepared.schema, opts?.expect ? { expect: toFormulaType(opts.expect) } : undefined);
    if (!compiled.ok) throw new Error(compiled.errors.map((e) => located(expression, prepared, ctx.key, e).message).join("; "));
    const paramIndex = new Map(ctx.params.map((p, i) => [paramField(i), p] as const));
    const missing: string[] = [];
    const row: RowValues = {
      field(path) {
        const param = paramIndex.get(path);
        const name = param?.name ?? path;
        const type = param ? toFormulaType(param.type) : prepared.schema.field(path)?.type;
        if (!type) return null;
        const value = inputs[name];
        if (value === undefined) missing.push(name);
        return cellFor(name, value, type);
      },
      related: () => [],
    };
    const out = formulaEngine.evaluateRow(compiled.formula, row);
    switch (out.type) {
      case "empty":
        throw new Error(missing.length > 0 ? `it has no value for ${[...new Set(missing)].join(", ")}` : "it came out empty (a division by zero or an empty value)");
      case "text":
      case "boolean":
        return out.value;
      case "quantity": {
        const declared = opts?.expect?.valueType === "quantity" && opts.expect.kind === out.kind ? opts.expect.unit : undefined;
        const unit = declared ?? (compiled.formula.type.type === "quantity" ? compiled.formula.type.unit : undefined);
        if (unit === undefined || !isUnitCode(unit)) throw new Error(`its result is a ${out.kind.replace(/_/g, " ")} with no unit to show it in`);
        return { value: fromSI(out.value, unit), unit };
      }
    }
  },
};

/** `@permitzip/bim-units` as the library's unit catalog: the same two functions, passed straight in. */
export const bimUnitsCatalog: UnitCatalog = { unitAllowed, convert };
