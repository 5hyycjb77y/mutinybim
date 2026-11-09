import type { DockDeclaration } from '../contributions/types'
import type { RibbonCommand } from '../ribbon/types'

/** The tab's title for one record ("<title> · L1"), or the bare title before the model has loaded. */
export function dockTitle(dock: DockDeclaration, name: string | null): string {
  return name ? `${dock.title} · ${name}` : dock.title
}

/**
 * The ribbon's per-record entries (one per record, each opening it docked).
 * Ids are `<kind>-view-<record>`, test ids `ribbon-<addon>-<kind>-<record>`.
 */
export function dockChildren(addon: string, dock: DockDeclaration, icon: RibbonCommand['icon'], records: readonly { readonly id: string; readonly name: string }[], open: (id: string) => void): RibbonCommand[] {
  return records.map((r) => ({
    id: `${dock.kind}-view-${r.id}`,
    label: r.name,
    icon,
    description: dock.openOne.replace('{name}', r.name),
    keywords: [dock.title.toLowerCase(), r.name],
    run: () => open(r.id),
    testId: `ribbon-${addon}-${dock.kind}-${r.id}`,
  }))
}
