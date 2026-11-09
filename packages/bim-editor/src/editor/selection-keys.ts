/** A group selection as the Properties panel sees it (box-select, select-all-like, a system…). */
export interface GroupSelectionLike {
  readonly scope: string
  readonly ids: readonly string[]
  readonly anchorId: string | null
}

/** FNV-1a over the ids in order: a short, stable fingerprint of exactly which parts are picked. */
function fingerprint(ids: readonly string[]): string {
  let h = 0x811c9dc5
  for (const id of ids) {
    for (let i = 0; i < id.length; i += 1) {
      h ^= id.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    h ^= 0x2c
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/**
 * React keys for the panels shown beside one group selection. Each panel gets its own prefix
 * (siblings in one list must differ), and a different set of the same size gets a new key so a
 * half-typed move or field never carries over to parts nobody picked.
 */
export function groupSelectionKeys(selection: GroupSelectionLike): { readonly properties: string; readonly organization: string } {
  const base = `${selection.scope}:${selection.ids.length}:${selection.anchorId ?? ''}:${fingerprint(selection.ids)}`
  return { properties: `group-properties:${base}`, organization: `group-organization:${base}` }
}
