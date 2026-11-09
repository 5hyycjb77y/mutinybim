import { disciplineAncestors, elementValues, modelCoverageContext, partitionOf, scopeSelects, type ModelState } from "@permitzip/bim-kernel"
import type { BimJson } from "../json"
import { readScope } from "./model"

/**
 * The elements an acceptance of this responsibility covers (its discipline and
 * child disciplines, inside its scope), so the approval pins only the rules
 * that read them (C10). Undefined when the stored scope can't be read: the
 * approval then pins every rule in force, never fewer than it relied on.
 */
export function responsibilityElementIds(model: Pick<ModelState, "elements">, row: { readonly id: string; readonly discipline: string; readonly scope: BimJson }): string[] | undefined {
  const scope = readScope(row.scope, row.id)
  if (scope === null) return undefined
  const ctx = modelCoverageContext(model)
  const out: string[] = []
  for (const el of elementValues(model.elements)) {
    const discipline = partitionOf(el).discipline
    if (discipline !== row.discipline && !disciplineAncestors(discipline).includes(row.discipline)) continue
    if (scope && !scopeSelects(scope, el, ctx)) continue
    out.push(el.id)
  }
  return out
}
