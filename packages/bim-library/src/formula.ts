import type { UnitCode } from "@permitzip/bim-kernel";
import type { ExampleValue, OperandType } from "./schema";

/**
 * What library validation needs from the formula engine, injected so the
 * core of this package never depends on it: check an expression against the
 * types of what it reads, report what it references, and evaluate it for a
 * calculation's examples. `@permitzip/bim-library/bim-formula` is the adapter
 * over `@permitzip/bim-formula`, the engine schedules and tags evaluate with.
 *
 * The syntax is the formula engine's: a calculation's own parameters are bare
 * names (`mbh * 0.8`); `{path}` reads a field of the classes it applies to
 * (`{own.mbh}`); `sum(serves, {load.gpm_fixed})` aggregates over a
 * relationship; `PZ.Name(a, b)` calls another named calculation.
 */

export interface FormulaSpan {
  readonly start: number;
  readonly end: number;
}

/** Fields and relationships of one set of classes: the calculation's own, or the far side of a relationship. */
export interface FormulaFieldContext {
  /** The type of `{path}` on these classes. */
  field(path: string): OperandType | undefined;
  /** A relationship usable in `sum/count/min/max/avg/list(name, …)`: the fields of the classes it reaches. */
  relationship(name: string): (FormulaFieldContext & { readonly label?: string }) | undefined;
}

export interface CalculationSignature {
  readonly params: readonly { readonly name: string; readonly type: OperandType }[];
  readonly result: OperandType;
  readonly expression: string;
}

export interface FormulaTypeContext extends FormulaFieldContext {
  /** The calculation being checked. */
  readonly key: string;
  /** Its parameters, read bare by name. */
  readonly params: CalculationSignature["params"];
  /** Another named calculation (engines that inline calls compile it in place). */
  calculation(key: string): CalculationSignature | undefined;
}

export type FormulaCheck =
  | {
      readonly ok: true;
      readonly resultType: OperandType;
      /** Fields and parameters read, and named calculations called: what cycle detection walks. */
      readonly references: { readonly inputs: readonly string[]; readonly calculations: readonly string[] };
    }
  | { readonly ok: false; readonly errors: readonly { readonly message: string; readonly span: FormulaSpan }[] };

export type FormulaValue = { readonly value: number; readonly unit: UnitCode } | string | number | boolean;

export interface FormulaEvalContext extends FormulaTypeContext {
  /** Evaluates another named calculation with arguments. Engines that inline calls at compile time never use it. */
  call(key: string, args: readonly FormulaValue[]): FormulaValue;
}

export interface FormulaEngine {
  /**
   * `expect`: the type the calculation declares it returns. A call cycle is
   * not an error here: return ok with `expect` and the calls, and validation
   * names the whole circle in plain words.
   */
  check(expression: string, ctx: FormulaTypeContext, opts?: { readonly expect?: OperandType }): FormulaCheck;
  /**
   * `inputs`: parameters by name and fields by path. Relationships read as
   * empty in examples. Throws `Error` with a plain message on a value it
   * cannot compute (division by zero, missing input).
   */
  evaluate(expression: string, inputs: Readonly<Record<string, ExampleValue>>, ctx: FormulaEvalContext, opts?: { readonly expect?: OperandType }): FormulaValue;
}
