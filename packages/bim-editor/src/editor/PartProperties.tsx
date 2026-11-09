'use client'

import { PartInspector, type PartInspectorProps, type SaveLabel } from './inspector/PartInspector'

export type { SaveLabel }

/**
 * A placed or planned part's properties: the parameter-driven Inspector
 * (round 5b). Kept under this name, with the same props, so the surface and
 * every existing test keep working while the surface moves onto
 * `inspector/` (expand, then contract: this file goes once nothing imports it).
 */
export function PartProperties(props: PartInspectorProps) {
  return <PartInspector {...props} />
}
