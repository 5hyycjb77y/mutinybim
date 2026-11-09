import { partGroupName } from '@permitzip/bim-kernel'
import type { CatalogEntry } from '../model-session'

/** One family (a part group) and its types, in display order. */
export interface PartFamilyGroup {
  readonly key: string
  readonly name: string
  readonly types: readonly CatalogEntry[]
}

/** One category (from the catalog's own category labels) and its families, in display order. */
export interface PartCategoryGroup {
  readonly key: string
  readonly category: string
  readonly label: string
  /** Types in this category that pass the filter. */
  readonly count: number
  readonly families: readonly PartFamilyGroup[]
}

/** A row of the flattened tree: what the list renders, header or type, in order. */
export type PartsListRow =
  | { readonly kind: 'category'; readonly key: string; readonly label: string; readonly count: number; readonly open: boolean; readonly holdsSelected: boolean }
  | { readonly kind: 'family'; readonly key: string; readonly name: string; readonly count: number; readonly open: boolean; readonly holdsSelected: boolean }
  | { readonly kind: 'type'; readonly key: string; readonly entry: CatalogEntry }

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function byName(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0)
}

/** The words of a filter, lower-cased; an entry matches when every word is in its category, family or type name. */
function filterWords(filter: string): string[] {
  return filter.trim().toLowerCase().split(/\s+/).filter((w) => w !== '')
}

function matches(entry: CatalogEntry, words: readonly string[]): boolean {
  if (words.length === 0) return true
  const text = `${entry.categoryLabel} ${partGroupName(entry.definition)} ${entry.definition.typeName}`.toLowerCase()
  return words.every((w) => text.includes(w))
}

export function categoryKey(category: string): string {
  return `c:${category}`
}

export function familyKey(category: string, family: string): string {
  return `f:${category}\u0000${family}`
}

/**
 * Category → family → type, like a project browser's Families tree. One pass
 * to bucket, then a sort per level: O(n log n) on the catalog, never the model.
 * Groups with no matching type are left out; order is stable (name, then id).
 */
export function groupParts(entries: readonly CatalogEntry[], filter: string): PartCategoryGroup[] {
  const words = filterWords(filter)
  const categories = new Map<string, { label: string; families: Map<string, CatalogEntry[]> }>()
  for (const entry of entries) {
    if (!matches(entry, words)) continue
    const category = entry.definition.category
    let bucket = categories.get(category)
    if (!bucket) {
      bucket = { label: entry.categoryLabel, families: new Map() }
      categories.set(category, bucket)
    }
    const family = partGroupName(entry.definition)
    const types = bucket.families.get(family)
    if (types) types.push(entry)
    else bucket.families.set(family, [entry])
  }
  const out: PartCategoryGroup[] = []
  for (const [category, bucket] of categories) {
    const families: PartFamilyGroup[] = []
    let count = 0
    for (const [name, types] of bucket.families) {
      types.sort((a, b) => byName(a.definition.typeName, b.definition.typeName) || byName(a.typeId, b.typeId))
      count += types.length
      families.push({ key: familyKey(category, name), name, types })
    }
    families.sort((a, b) => byName(a.name, b.name))
    out.push({ key: categoryKey(category), category, label: bucket.label, count, families })
  }
  return out.sort((a, b) => byName(a.label, b.label) || byName(a.category, b.category))
}

/** The rows to render: headers always, a group's children only while it is open (not in `collapsed`). */
export function flattenPartGroups(groups: readonly PartCategoryGroup[], collapsed: ReadonlySet<string>, selectedTypeId: string | null): PartsListRow[] {
  const rows: PartsListRow[] = []
  for (const group of groups) {
    const open = !collapsed.has(group.key)
    const holdsSelected = selectedTypeId !== null && group.families.some((f) => f.types.some((t) => t.typeId === selectedTypeId))
    rows.push({ kind: 'category', key: group.key, label: group.label, count: group.count, open, holdsSelected })
    if (!open) continue
    for (const family of group.families) {
      const familyOpen = !collapsed.has(family.key)
      rows.push({ kind: 'family', key: family.key, name: family.name, count: family.types.length, open: familyOpen, holdsSelected: selectedTypeId !== null && family.types.some((t) => t.typeId === selectedTypeId) })
      if (!familyOpen) continue
      for (const entry of family.types) rows.push({ kind: 'type', key: `t:${entry.typeId}`, entry })
    }
  }
  return rows
}
