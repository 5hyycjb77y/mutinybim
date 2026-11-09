/**
 * Public contract of `@permitzip/bim-formula` (SCHEDULES-PLAN §5c, milestone M1).
 *
 * Formulas are field-based (`{own.mbh} * 1000`), never A1 cells. Every value
 * is typed: numbers carry a quantity kind from `@permitzip/bim-units`, so
 * adding a length to a gas input is refused when the formula is defined, not
 * when a sheet prints. Field and relationship values arrive through the
 * schema and input interfaces below; this package never imports the kernel.
 */

import type { Kind, Quantity, UnitCode } from "@permitzip/bim-units";

export type { Kind, Quantity, UnitCode };

// ---------------------------------------------------------------- types

/** The static type of a field, a parameter or a formula result. */
export type FormulaType =
  | {
      readonly type: "quantity";
      readonly kind: Kind;
      /** Unit the value is shown in (explain text, default cell display). Any unit of `kind`. */
      readonly unit: UnitCode;
    }
  | { readonly type: "text" }
  | { readonly type: "boolean" };

/** One value at one row. Quantities are canonical SI for their kind; `null` is an empty cell. */
export type FormulaValue =
  | { readonly type: "quantity"; readonly kind: Kind; readonly value: Quantity<Kind> }
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "boolean"; readonly value: boolean }
  | { readonly type: "empty" };

/** Raw cell value handed in by a host. Quantities must already be canonical SI for the field's kind. */
export type CellValue = Quantity<Kind> | string | boolean | null;

// ---------------------------------------------------------------- schema (compile time)

/** What a field path means. Paths follow the kernel template convention: `[A-Za-z_][A-Za-z0-9_]*` joined by dots. */
export interface FieldSignature {
  readonly type: FormulaType;
  /** Plain label for errors and explain text, e.g. "gas input". Defaults to the path. */
  readonly label?: string;
}

/** A relationship usable in `sum/count/min/max/avg/list(rel, expr)`. Inner `{paths}` resolve against `target`. */
export interface RelationshipSignature {
  readonly label?: string;
  readonly target: FormulaSchema;
}

/** A library table for `lookup(table, key)`. Data is pinned at compile time; evaluation never calls a provider. */
export interface LookupTableSignature {
  readonly key: FormulaType;
  readonly value: FormulaType;
  /** `exact`: key must match. `floor`: largest key <= the lookup value (step tables such as demand factors). */
  readonly match: "exact" | "floor";
  /** Quantity keys/values are canonical SI. Keys must be unique. */
  readonly rows: readonly { readonly key: CellValue; readonly value: CellValue }[];
}

/**
 * A named calculation (library item), called as `PZ.GasDemandBtuh({own.mbh}, 0.8)`.
 * Inside `expression`, parameters are bare identifiers (`input * factor`) and
 * `{paths}` read the calling row.
 */
export interface NamedCalculationSignature {
  readonly id: string;
  readonly params: readonly { readonly name: string; readonly type: FormulaType }[];
  readonly result: FormulaType;
  readonly expression: string;
}

/**
 * Everything a formula may refer to, injected by the host (the kernel field
 * registry in MutinyBIM, a test double in tests). Lookups return `undefined`
 * for unknown names; the compiler turns that into a plain error with the span.
 */
export interface FormulaSchema {
  field(path: string): FieldSignature | undefined;
  relationship(name: string): RelationshipSignature | undefined;
  table?(name: string): LookupTableSignature | undefined;
  calculation?(id: string): NamedCalculationSignature | undefined;
}

// ---------------------------------------------------------------- compile

export interface SourceSpan {
  /** UTF-16 offsets into the expression text, end exclusive. */
  readonly start: number;
  readonly end: number;
}

export type FormulaErrorCode =
  | "syntax"
  | "unknown_field"
  | "unknown_relationship"
  | "unknown_function"
  | "unknown_table"
  | "unknown_calculation"
  | "unknown_unit"
  | "unknown_name"
  | "arity"
  | "type_mismatch"
  | "unit_mismatch"
  | "unitless_number"
  | "no_kind"
  | "cycle"
  | "too_complex";

export interface FormulaError {
  readonly code: FormulaErrorCode;
  /** Plain words a person can act on, e.g. "Can't add a length (ft) to a gas input (MBH)". */
  readonly message: string;
  readonly span: SourceSpan;
}

export interface CompileOptions {
  /** Declared result type (a library item's result kind/unit, a column's unit). A mismatch is refused. */
  readonly expect?: FormulaType;
}

/** Everything a compiled formula reads, for dependency tracking and incremental re-evaluation. */
export interface FormulaDependencies {
  readonly fields: readonly string[];
  readonly relationships: readonly { readonly name: string; readonly dependencies: FormulaDependencies }[];
  readonly tables: readonly string[];
  readonly calculations: readonly string[];
}

/**
 * Handle returned by `compile`. Compile once, evaluate many times; holds no
 * per-row state. Only handles created by the same engine evaluate.
 */
export interface CompiledFormula {
  readonly source: string;
  readonly type: FormulaType;
  readonly dependencies: FormulaDependencies;
}

export type CompileResult =
  | { readonly ok: true; readonly formula: CompiledFormula }
  | { readonly ok: false; readonly errors: readonly FormulaError[] };

// ---------------------------------------------------------------- columnar evaluation

/**
 * One column of values for every row. Plain typed arrays so a Rust/WASM
 * backend could sit behind `evaluateColumn` without an API change.
 * - quantity: canonical SI of `kind`; `NaN` is an empty cell.
 * - boolean: 1 true, 0 false, -1 empty.
 * - text: `null` is an empty cell.
 */
export type ValueColumn =
  | { readonly type: "quantity"; readonly kind: Kind; readonly values: Float64Array }
  | { readonly type: "boolean"; readonly values: Int8Array }
  | { readonly type: "text"; readonly values: readonly (string | null)[] };

/** Related rows for every parent row, CSR style: parent `i` owns target rows `offsets[i] .. offsets[i+1]`. */
export interface RelationColumn {
  /** Length `rowCount + 1`, non-decreasing, `offsets[0] = 0`, last = `target.rowCount`. */
  readonly offsets: Int32Array;
  readonly target: ColumnarInputs;
}

export interface ColumnarInputs {
  readonly rowCount: number;
  readonly fields: ReadonlyMap<string, ValueColumn>;
  readonly relations: ReadonlyMap<string, RelationColumn>;
}

// ---------------------------------------------------------------- row evaluation and explain

/** One row read lazily, for single cells, `explain`, library examples and tests. */
export interface RowValues {
  field(path: string): CellValue;
  related(name: string): readonly RowValues[];
}

export interface Explanation {
  /** The substituted expression, e.g. "199 MBH × 1000 = 199,000 MBH". */
  readonly text: string;
  readonly value: FormulaValue;
}

// ---------------------------------------------------------------- engine interface

/**
 * The evaluator other packages depend on (the library validates `examples`
 * with it, the schedule engine evaluates formula columns with it). Depend on
 * this interface, not on module internals.
 */
export interface FormulaEngine {
  compile(source: string, schema: FormulaSchema, options?: CompileOptions): CompileResult;
  evaluateColumn(formula: CompiledFormula, inputs: ColumnarInputs): ValueColumn;
  evaluateRow(formula: CompiledFormula, row: RowValues): FormulaValue;
  explain(formula: CompiledFormula, row: RowValues): Explanation;
  /** Names a formula reads, from the text alone (no schema). Library cycle checks build graphs from this. */
  dependenciesOf(source: string): { readonly ok: true; readonly fields: readonly string[]; readonly calculations: readonly string[]; readonly tables: readonly string[]; readonly relationships: readonly string[] } | { readonly ok: false; readonly errors: readonly FormulaError[] };
  /** Cycles in a dependency graph (id -> ids it uses), each listed once in a stable order. */
  findCycles(graph: ReadonlyMap<string, readonly string[]>): readonly (readonly string[])[];
}
