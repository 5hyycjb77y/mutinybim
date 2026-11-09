'use client'

import { useEffect, useState } from 'react'
import type { BimElement } from '@permitzip/bim-kernel'

type Elements = Readonly<Record<string, BimElement>>

/** The room or space among the hovered ids, if any (a proposer previews for it). */
export function hoveredRoomOf(elements: Elements, ids: readonly string[] | null): string | null {
  if (!ids) return null
  for (const id of ids) {
    const kind = elements[id]?.kind
    if (kind === 'room' || kind === 'space') return id
  }
  return null
}

/**
 * The room or space under the pointer in the plan or 3D view, from the
 * session's hover (its pre-highlight). Null when nothing is hovered, or when
 * there is no hover feed (a host that doesn't offer one).
 */
export function useHoveredRoom(subscribeHover: ((listener: (ids: readonly string[] | null) => void) => () => void) | undefined, elements: Elements): string | null {
  const [ids, setIds] = useState<readonly string[] | null>(null)
  useEffect(() => {
    if (!subscribeHover) return
    return subscribeHover(setIds)
  }, [subscribeHover])
  return hoveredRoomOf(elements, ids)
}
