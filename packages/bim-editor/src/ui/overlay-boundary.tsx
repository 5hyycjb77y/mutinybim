"use client"

import * as React from "react"

/** Margin from the collision box (Flight Deck bay, or the viewport). */
export const OVERLAY_COLLISION_PADDING = 12

/** Matches Radix Popper `collisionBoundary` (element, null, or a list). */
export type OverlayCollisionBoundary = Element | null | Array<Element | null>

const EMPTY_BOUNDARY_REF: { readonly current: Element | null } = {
  current: null,
}

type OverlayBoundaryValue = {
  collisionBoundaryRef: { readonly current: Element | null }
}

const OverlayBoundaryContext = React.createContext<OverlayBoundaryValue>({
  collisionBoundaryRef: EMPTY_BOUNDARY_REF,
})

/**
 * Marks a visible window (Flight Deck bay) as the collision box for
 * portaled popovers, menus, tooltips, and selects. React portals keep
 * this context, so overlays rendered on document.body still see it.
 *
 * Pass a ref, not a state-held element — writing the node into state on
 * mount re-renders the bay and can collapse docked pane height.
 */
export function OverlayBoundaryProvider({
  boundaryRef,
  children,
}: {
  boundaryRef: { readonly current: Element | null }
  children: React.ReactNode
}) {
  const value = React.useMemo(
    () => ({ collisionBoundaryRef: boundaryRef }),
    [boundaryRef],
  )
  return (
    <OverlayBoundaryContext.Provider value={value}>
      {children}
    </OverlayBoundaryContext.Provider>
  )
}

export function useOverlayCollisionBoundary(): {
  collisionBoundary: Element | undefined
  collisionPadding: number
} {
  const { collisionBoundaryRef } = React.useContext(OverlayBoundaryContext)
  return {
    collisionBoundary: collisionBoundaryRef.current ?? undefined,
    collisionPadding: OVERLAY_COLLISION_PADDING,
  }
}

export function useResolvedOverlayCollision(
  collisionBoundary?: OverlayCollisionBoundary,
  collisionPadding?: number,
): {
  collisionBoundary: Element | Array<Element | null> | undefined
  collisionPadding: number
} {
  const overlay = useOverlayCollisionBoundary()
  if (collisionBoundary === undefined) {
    return {
      collisionBoundary: overlay.collisionBoundary,
      collisionPadding: collisionPadding ?? overlay.collisionPadding,
    }
  }
  return {
    collisionBoundary: collisionBoundary ?? undefined,
    collisionPadding: collisionPadding ?? overlay.collisionPadding,
  }
}

const PortalContainerContext = React.createContext<HTMLElement | null>(null)

/**
 * Where portaled overlays (selects, menus, popovers, tooltips, dialogs) mount.
 * Default is document.body. A surface shown with the browser's Fullscreen API
 * passes its fullscreen element, because anything outside it is not drawn.
 */
export function PortalContainerProvider({
  container,
  children,
}: {
  container: HTMLElement | null
  children: React.ReactNode
}) {
  return (
    <PortalContainerContext.Provider value={container}>
      {children}
    </PortalContainerContext.Provider>
  )
}

/** The portal mount point, or undefined for Radix's default (document.body). */
export function usePortalContainer(): HTMLElement | undefined {
  return React.useContext(PortalContainerContext) ?? undefined
}
