import { SCHEDULE_CATEGORIES, SCHEDULE_CATEGORY_CLASSES, disciplineLabel, elementsOfKind, fieldProviderRegistry, scheduleFields, type ModelState, type Registry, type ScheduleCategory } from '@permitzip/bim-kernel'
import { ScheduleDefinitionError, buildRowSet, scheduleV1ToV2 } from '@permitzip/bim-kernel/schedules'
import type { CatalogClass, CatalogField, CatalogRelationship, ScheduleCatalog } from '@permitzip/bim-schedules-ui'

/**
 * What the schedule builder offers, read from the kernel's class, field and
 * relationship registry (every discipline, with the MEP field providers),
 * plus the fields this model's part types declare (CFM, fixture units,
 * waste size…). Types, units and headings come from the engine itself, so
 * the builder names, totals and locks a column exactly as the grid and the
 * sheet print it. Nothing is listed here by hand.
 */

function categoriesFor(classIds: readonly string[]): ScheduleCategory[] {
  return SCHEDULE_CATEGORIES.filter((c) => classIds.includes(SCHEDULE_CATEGORY_CLASSES[c]))
}

/** Whether any part type these classes list has a power connection (as v1 schedules decide whether to offer circuit fields). */
function powered(model: Pick<ModelState, 'elements'>, categories: readonly ScheduleCategory[]): boolean {
  const wanted = new Set<string>(categories)
  return elementsOfKind(model.elements, 'part_type').some((t) => wanted.has(t.definition.category) && (t.definition.connectors?.some((c) => c.domain === 'electrical') ?? false))
}

/** The model's own fields for a category, typed by the engine (it opens a probe schedule over them; nothing is saved). */
function modelFields(model: ModelState, category: ScheduleCategory): CatalogField[] {
  const fields = scheduleFields(model, category).filter((f) => f.key !== 'count')
  if (fields.length === 0) return []
  try {
    const def = scheduleV1ToV2({ category, columns: fields.map((f) => ({ field: f.key })) })
    const rows = buildRowSet(model, def, { viewId: 'builder-catalog', revision: model.revision })
    return rows.columns.flatMap((c, i): CatalogField[] => {
      const key = fields[i]?.key
      if (!key) return []
      return [
        {
          path: key,
          label: c.heading,
          valueType: c.valueType,
          ...(c.quantityKind ? { kind: c.quantityKind } : {}),
          ...(c.unit ? { unit: c.unit } : {}),
          editable: c.writer !== null,
          aggregation: c.valueType === 'quantity' ? 'sum' : 'none',
        },
      ]
    })
  } catch (err) {
    if (!(err instanceof ScheduleDefinitionError)) console.error('[registryCatalog] typing the model fields failed; they are offered as text', { category, err })
    return fields.map((f) => ({ path: f.key, label: f.label, valueType: 'text', editable: true, aggregation: 'none' }))
  }
}

export function registryCatalog(registry: Registry = fieldProviderRegistry(), model?: ModelState | null): ScheduleCatalog {
  return {
    classes: (): readonly CatalogClass[] => registry.listClasses({}).map((c) => ({ id: c.id, label: c.label, discipline: c.discipline, disciplineLabel: disciplineLabel(c.discipline) })),
    fieldsFor: (classIds): readonly CatalogField[] => {
      const seen = new Map<string, CatalogField>()
      const categories = categoriesFor(classIds)
      // Model fields first: they carry the engine's own heading and type for v1 columns.
      if (model) for (const category of categories) for (const f of modelFields(model, category)) if (!seen.has(f.path)) seen.set(f.path, f)
      // Circuit and panel fields only where these items have a power connection.
      const showElectrical = !model || categories.length === 0 || powered(model, categories)
      for (const id of classIds) {
        for (const f of registry.fieldsFor(id)) {
          if (seen.has(f.path)) continue
          if (!showElectrical && f.group === 'Electrical') continue
          seen.set(f.path, {
            path: f.path,
            label: f.label,
            // An element reference reads as the related item's name.
            valueType: f.valueType === 'element' ? 'text' : f.valueType,
            ...(f.kind ? { kind: f.kind } : {}),
            ...(f.unit ? { unit: f.unit } : {}),
            editable: f.writer.kind !== 'none',
            aggregation: f.aggregation ?? 'none',
          })
        }
      }
      return [...seen.values()]
    },
    relationshipsFor: (classIds): readonly CatalogRelationship[] => {
      const seen = new Map<string, CatalogRelationship>()
      for (const id of classIds) {
        for (const r of registry.relationshipsFor(id)) {
          if (seen.has(r.id)) continue
          seen.set(r.id, { id: r.id, label: r.label, targetClasses: r.to === 'any' ? [] : r.to })
        }
      }
      return [...seen.values()]
    },
  }
}
