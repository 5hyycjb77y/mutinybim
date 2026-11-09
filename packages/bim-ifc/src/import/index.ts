import { planIfcImport, type IfcImportPlan, type ModelState, type PlanImportOptions } from "@permitzip/bim-kernel";
import { readIfcSource, type IfcReadOptions } from "./read-products";

/**
 * IFC import (round 9 I9): read a linked model's STEP text into neutral
 * products, then plan what converts through the model's class registry and
 * import rules. What the products become is never decided here.
 */
export { IfcReadCancelled, lengthScale, readIfcSource, schemaEntity, type IfcReadOptions } from "./read-products";
export { GeometryReader, boundsOf, hostFrame, type Frame } from "./geometry";

export interface IfcImportInput extends IfcReadOptions {
  readonly model: ModelState;
  readonly referenceId: string;
  readonly sourceKey: string;
  readonly registry?: PlanImportOptions["registry"];
  readonly rules?: PlanImportOptions["rules"];
}

/** Read and plan in one step (tests, drills, the perf row; the model server reads in a worker thread first). */
export function importIfc(text: string, input: IfcImportInput): IfcImportPlan & { readonly readMs: number; readonly planMs: number } {
  const t0 = performance.now();
  const source = readIfcSource(text, input);
  const t1 = performance.now();
  const plan = planIfcImport(source, { model: input.model, referenceId: input.referenceId, sourceKey: input.sourceKey, ...(input.registry ? { registry: input.registry } : {}), ...(input.rules ? { rules: input.rules } : {}) });
  return { ...plan, readMs: t1 - t0, planMs: performance.now() - t1 };
}
