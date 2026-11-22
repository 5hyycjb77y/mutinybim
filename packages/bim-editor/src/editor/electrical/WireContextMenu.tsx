'use client'

import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { paperToDrawing, type ModelState, type Vec2, type ViewOnPaper } from '@permitzip/bim-kernel'
import {
  circuitHomeRunNear,
  circuitHomeRunsOnPaper,
  circuitJoinNear,
  circuitJoinsOnPaper,
  circuitSwitchLegLabelNear,
  circuitSwitchLegLabelsOnPaper,
  previewWireCurve,
  withCircuitFlipArc,
  withCircuitHomeRun,
  withCircuitMwbcGroup,
  withCircuitWaypoints,
  withSwitchLegLabelOffset,
  type CircuitHomeRunOnPaper,
  type CircuitJoinOnPaper,
  type CircuitSwitchLegLabelOnPaper,
  type HomeRunHitPart,
} from '@permitzip/bim-pack-electrical'
import { Button } from '../../ui/button'
import type { ModelEditBridge } from '../view-input/bridge'

export {
  circuitHomeRunNear as wireHomeRunNear,
  circuitHomeRunsOnPaper as wireHomeRunsOnPaper,
  circuitJoinNear as wireJoinNear,
  circuitJoinsOnPaper as wireJoinsOnPaper,
  circuitSwitchLegLabelNear as wireSwitchLabelNear,
  circuitSwitchLegLabelsOnPaper as wireSwitchLabelsOnPaper,
  previewWireCurve,
  type CircuitHomeRunOnPaper as WireHomeRunOnPaper,
  type CircuitJoinOnPaper as WireJoinOnPaper,
  type CircuitSwitchLegLabelOnPaper as WireSwitchLabelOnPaper,
  type HomeRunHitPart as WireHomeRunHitPart,
}

export function submitWireWaypoints(
  bridge: ModelEditBridge,
  view: ViewOnPaper,
  join: CircuitJoinOnPaper,
  nextWaypoints: readonly Vec2[] | null,
): string | null {
  return bridge.submit(
    { type: 'set_view_properties', viewId: view.view.id, props: { circuitGraphics: withCircuitWaypoints(view.view, join.linkId, join.a, join.b, nextWaypoints) } },
    'reshape wire',
  )
}

export function submitWireHomeRun(
  bridge: ModelEditBridge,
  view: ViewOnPaper,
  homeRun: CircuitHomeRunOnPaper,
  part: HomeRunHitPart,
  at: Vec2,
): string | null {
  const existing = view.view.props?.circuitGraphics?.hints?.[homeRun.linkId]?.homeRun ?? {}
  const anchor = homeRun.anchorModel
  const nextHr =
    part === 'tip'
      ? { ...existing, memberId: homeRun.memberId, tipOffset: { x: at.x - anchor.x, y: at.y - anchor.y } }
      : part === 'label'
        ? { ...existing, memberId: homeRun.memberId, labelOffset: { x: at.x - homeRun.tipModel.x, y: at.y - homeRun.tipModel.y } }
        : { ...existing, memberId: homeRun.memberId, bendOffset: { x: at.x - anchor.x, y: at.y - anchor.y } }
  return bridge.submit(
    { type: 'set_view_properties', viewId: view.view.id, props: { circuitGraphics: withCircuitHomeRun(view.view, homeRun.linkId, nextHr) } },
    part === 'tip' ? 'move home run arrow' : part === 'label' ? 'move home run label' : 'curve home run arrow',
  )
}

export function submitSwitchLabelOffset(
  bridge: ModelEditBridge,
  view: ViewOnPaper,
  label: CircuitSwitchLegLabelOnPaper,
  offset: Vec2 | null,
): string | null {
  return bridge.submit(
    { type: 'set_view_properties', viewId: view.view.id, props: { circuitGraphics: withSwitchLegLabelOffset(view.view, label.hintKey, label.memberId, offset) } },
    `move switch-leg letter "${label.text}"`,
  )
}

export type WireMenuState =
  | { readonly kind: 'join'; readonly join: CircuitJoinOnPaper; readonly paper: Vec2; readonly clientX: number; readonly clientY: number }
  | { readonly kind: 'homerun'; readonly homeRun: CircuitHomeRunOnPaper; readonly paper: Vec2; readonly clientX: number; readonly clientY: number }
  | { readonly kind: 'switch_label'; readonly label: CircuitSwitchLegLabelOnPaper; readonly paper: Vec2; readonly clientX: number; readonly clientY: number }

export function WireContextMenu({
  menu,
  model,
  view,
  bridge,
  homeRuns,
  insertWaypoint,
  onClose,
}: {
  menu: WireMenuState
  model: ModelState
  view: ViewOnPaper
  bridge: ModelEditBridge
  homeRuns: readonly CircuitHomeRunOnPaper[]
  insertWaypoint: (aPos: Vec2, bPos: Vec2, existing: readonly Vec2[], point: Vec2) => Vec2[]
  onClose: () => void
}) {
  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      style={{ position: 'fixed', left: menu.clientX, top: menu.clientY, zIndex: 70 }}
      className="min-w-48 rounded-md border bg-popover p-1 text-xs text-popover-foreground shadow-md"
      onPointerDown={(ev) => ev.stopPropagation()}
      data-testid="wire-context-menu"
    >
      {menu.kind === 'join' ? (
        <>
          <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
            {menu.join.kind === 'switch_leg' ? menu.join.name : `Circuit ${menu.join.name}`}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto w-full justify-start rounded-sm px-2 py-1.5 text-left text-xs font-normal"
            onClick={() => {
              const at = view.mapping.toModel(paperToDrawing(view, menu.paper))
              onClose()
              if (!at) return
              const aEl = model.elements[menu.join.a]
              const bEl = model.elements[menu.join.b]
              const aPos = aEl?.kind === 'part' ? aEl.position : { x: at.x, y: at.y }
              const bPos = bEl?.kind === 'part' ? bEl.position : { x: at.x, y: at.y }
              const nextWps = insertWaypoint(aPos, bPos, menu.join.waypointsModel, { x: at.x, y: at.y })
              const refused = bridge.submit(
                { type: 'set_view_properties', viewId: view.view.id, props: { circuitGraphics: withCircuitWaypoints(view.view, menu.join.linkId, menu.join.a, menu.join.b, nextWps) } },
                'insert spline vertex on wire',
              )
              if (refused) toast.error(refused)
              else bridge.hint(`Inserted spline vertex (${nextWps.length} total). Drag vertices to shape, or right-click to add/remove.`)
            }}
          >
            Insert spline vertex here
          </Button>
          {menu.join.waypointsModel.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto w-full justify-start rounded-sm px-2 py-1.5 text-left text-xs font-normal"
              onClick={() => {
                const j = menu.join
                const p = menu.paper
                onClose()
                let closest = 0
                let bestD = Infinity
                j.waypointsPaper.forEach((wp, i) => {
                  const d = Math.hypot(p.x - wp.x, p.y - wp.y)
                  if (d < bestD) {
                    bestD = d
                    closest = i
                  }
                })
                const nextWps = j.waypointsModel.filter((_, i) => i !== closest)
                const refused = bridge.submit(
                  { type: 'set_view_properties', viewId: view.view.id, props: { circuitGraphics: withCircuitWaypoints(view.view, j.linkId, j.a, j.b, nextWps.length > 0 ? nextWps : null) } },
                  'remove spline vertex',
                )
                if (refused) toast.error(refused)
              }}
            >
              Remove nearest vertex
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto w-full justify-start rounded-sm px-2 py-1.5 text-left text-xs font-normal"
            onClick={() => {
              const j = menu.join
              onClose()
              const refused = bridge.submit(
                { type: 'set_view_properties', viewId: view.view.id, props: { circuitGraphics: withCircuitFlipArc(view.view, j.linkId, j.a, j.b) } },
                'flip wire arc side',
              )
              if (refused) toast.error(refused)
            }}
          >
            Flip arc side
          </Button>
          {(menu.join.waypointsModel.length > 0 || menu.join.flipped) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto w-full justify-start rounded-sm px-2 py-1.5 text-left text-xs font-normal text-destructive hover:text-destructive"
              onClick={() => {
                const j = menu.join
                onClose()
                const cleared = withCircuitFlipArc(
                  { ...view.view, props: { ...(view.view.props ?? {}), circuitGraphics: withCircuitWaypoints(view.view, j.linkId, j.a, j.b, null) } },
                  j.linkId,
                  j.a,
                  j.b,
                  false,
                )
                const refused = bridge.submit({ type: 'set_view_properties', viewId: view.view.id, props: { circuitGraphics: cleared } }, 'reset wire shape')
                if (refused) toast.error(refused)
              }}
            >
              Reset wire to automatic
            </Button>
          )}
        </>
      ) : menu.kind === 'switch_label' ? (
        <>
          <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">Switch leg &ldquo;{menu.label.text}&rdquo;</div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!menu.label.custom}
            className="h-auto w-full justify-start rounded-sm px-2 py-1.5 text-left text-xs font-normal"
            onClick={() => {
              const sw = menu.label
              onClose()
              const refused = bridge.submit(
                { type: 'set_view_properties', viewId: view.view.id, props: { circuitGraphics: withSwitchLegLabelOffset(view.view, sw.hintKey, sw.memberId, null) } },
                `reset switch-leg letter "${sw.text}"`,
              )
              if (refused) toast.error(refused)
            }}
          >
            Reset switch-leg letter position
          </Button>
        </>
      ) : (
        <>
          <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">Home run {menu.homeRun.name}</div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!menu.homeRun.hasCustom}
            className="h-auto w-full justify-start rounded-sm px-2 py-1.5 text-left text-xs font-normal"
            onClick={() => {
              const hr = menu.homeRun
              onClose()
              const refused = bridge.submit(
                { type: 'set_view_properties', viewId: view.view.id, props: { circuitGraphics: withCircuitHomeRun(view.view, hr.linkId, null) } },
                'reset home run to automatic',
              )
              if (refused) toast.error(refused)
            }}
          >
            Reset home run to automatic
          </Button>
          {(() => {
            const hr = menu.homeRun
            const currentGroup = view.view.props?.circuitGraphics?.hints?.[hr.linkId]?.mwbcGroup
            const thisLink = model.elements[hr.linkId]
            const panelId = thisLink?.kind === 'service_link' ? thisLink.source.elementId : null
            if (currentGroup) {
              const members = Object.entries(view.view.props?.circuitGraphics?.hints ?? {})
                .filter(([, h]) => h.mwbcGroup === currentGroup)
                .map(([id]) => id)
              return (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto w-full justify-start rounded-sm px-2 py-1.5 text-left text-xs font-normal"
                  onClick={() => {
                    onClose()
                    const refused = bridge.submit(
                      { type: 'set_view_properties', viewId: view.view.id, props: { circuitGraphics: withCircuitMwbcGroup(view.view, members, null) } },
                      'split MWBC shared-neutral home run',
                    )
                    if (refused) toast.error(refused)
                  }}
                >
                  Split MWBC shared-neutral home run
                </Button>
              )
            }
            if (!panelId) return null
            const peers = homeRuns.filter((other) => {
              if (other.linkId === hr.linkId) return false
              const el = model.elements[other.linkId]
              return el?.kind === 'service_link' && el.source.elementId === panelId
            })
            if (peers.length === 0) return null
            const peer = peers[0]!
            return (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto w-full justify-start rounded-sm px-2 py-1.5 text-left text-xs font-normal"
                onClick={() => {
                  onClose()
                  const groupId = `mwbc-${[hr.linkId, peer.linkId].sort().join('-')}`
                  const refused = bridge.submit(
                    { type: 'set_view_properties', viewId: view.view.id, props: { circuitGraphics: withCircuitMwbcGroup(view.view, [hr.linkId, peer.linkId], groupId) } },
                    `combine ${hr.name} & ${peer.name} as MWBC`,
                  )
                  if (refused) toast.error(refused)
                }}
              >
                Combine as MWBC with {peer.name}
              </Button>
            )
          })()}
        </>
      )}
    </div>,
    document.body,
  )
}
