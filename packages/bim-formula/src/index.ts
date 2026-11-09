import { formulaEngine } from "./engine";

export type {
  CellValue,
  ColumnarInputs,
  CompileOptions,
  CompileResult,
  CompiledFormula,
  Explanation,
  FieldSignature,
  FormulaDependencies,
  FormulaEngine,
  FormulaError,
  FormulaErrorCode,
  FormulaSchema,
  FormulaType,
  FormulaValue,
  Kind,
  LookupTableSignature,
  NamedCalculationSignature,
  Quantity,
  RelationColumn,
  RelationshipSignature,
  RowValues,
  SourceSpan,
  UnitCode,
  ValueColumn,
} from "./types";

export { formulaEngine, inputsFromRows } from "./engine";
export { rowFromRecord } from "./rows";
export { findCycles } from "./cycles";

export const compileFormula = formulaEngine.compile;
export const evaluateColumn = formulaEngine.evaluateColumn;
export const evaluateRow = formulaEngine.evaluateRow;
export const explain = formulaEngine.explain;
export const formulaDependencies = formulaEngine.dependenciesOf;
