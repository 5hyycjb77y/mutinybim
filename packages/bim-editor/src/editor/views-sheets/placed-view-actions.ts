import type { ViewElement } from '@permitzip/bim-kernel'

/**
 * What a double-click on a view placed on a sheet does. Plans, sections, 3D
 * and detail views open for editing in place on the sheet; a schedule has
 * nothing to draw there, so it opens as itself (its grid), where its columns,
 * rows and filters are edited.
 */
export function doubleClickOpensView(view: Pick<ViewElement, 'viewType'>): boolean {
  return view.viewType === 'schedule'
}
