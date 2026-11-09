import type { PartCategory } from '@permitzip/bim-kernel'
import { MM_PER_FT, defaultHeightMm } from './placement'

/**
 * A Place height the person typed, and the kind of part chosen when they
 * typed it (null: typed before choosing any part). Null when they haven't typed one.
 */
export type TypedPlaceHeight = { readonly forCategory: PartCategory | null } | null

/**
 * The Place part height field after a part type is chosen. A height typed
 * before choosing, or for the same kind of part, stays (10 ft stays 10 ft when
 * they pick the 5-ton unit). Any other field takes the part's usual height: a
 * 13 ft typed for a rooftop unit was not meant for the ceiling diffuser picked next.
 */
export function heightAfterChoosingPart(currentFt: string, typed: TypedPlaceHeight, category: PartCategory): { heightFt: string; typed: TypedPlaceHeight } {
  if (typed && (typed.forCategory === null || typed.forCategory === category)) return { heightFt: currentFt, typed: { forCategory: category } }
  return { heightFt: String(Math.round((defaultHeightMm(category) / MM_PER_FT) * 100) / 100), typed: null }
}
