'use client'

import { useState, type KeyboardEvent } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import type { PlusHandle } from './model-session'
import { nextBranchFace, planFaceHint, type BranchFace } from './plus-tee'

/** A "+" on a level run's top or bottom face, at its screen point. */
export interface FaceHandle {
  readonly x: number
  readonly y: number
  readonly elementId: string
  readonly face: BranchFace
  /** mm along the run from its start where the branch leaves. */
  readonly s: number
  readonly label: string
}

/** Plan draws top and bottom on top of each other, so one "+" switches face with Tab; 3D and section show both. */
export type PlusHandlesView = 'plan' | '3d' | 'section'

/** Closer than this on screen (px), a run's top and bottom "+" would be one button over another. */
const FACES_APART_PX = 16

/**
 * How to draw the face "+" for the camera they were measured from: when a
 * run's top and bottom land on (nearly) the same screen spot, as looking
 * straight down in plan, one "+" that Tab switches; otherwise both.
 */
export function plusHandlesViewFor(faceHandles: readonly FaceHandle[]): PlusHandlesView {
  for (const top of faceHandles) {
    if (top.face !== 'top') continue
    const bottom = faceHandles.find((h) => h.elementId === top.elementId && h.face === 'bottom')
    if (bottom && Math.hypot(top.x - bottom.x, top.y - bottom.y) < FACES_APART_PX) return 'plan'
  }
  return '3d'
}

interface Props {
  readonly handles: readonly PlusHandle[]
  readonly onPick: (handle: PlusHandle) => void
  readonly faceHandles?: readonly FaceHandle[]
  readonly view?: PlusHandlesView
  readonly onPickFace?: (handle: FaceHandle) => void
  /** Esc on a "+": leave the handles, nothing started. */
  readonly onCancel?: () => void
}

const HANDLE_CLASS = 'absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-full border-primary bg-background text-primary shadow-sm'

function stop(e: { stopPropagation: () => void }) {
  e.stopPropagation()
}

/**
 * The "+" buttons on the selected duct or pipe: past an open end, continue the
 * run from there (at this size, or another one picked in the Route panel); on
 * an elbow's free side, turn it into a tee and route the branch on; on a level
 * run's top or bottom, branch off that face. Each button is its own named
 * action, drawn over the canvas. Esc on any of them cancels.
 */
export function PlusHandles({ handles, onPick, faceHandles = [], view = '3d', onPickFace, onCancel }: Props) {
  const [planFace, setPlanFace] = useState<Readonly<Record<string, BranchFace>>>({})
  const escape = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'Escape' || !onCancel) return false
    e.preventDefault()
    e.stopPropagation()
    onCancel()
    return true
  }

  const planGroups = view === 'plan' ? [...new Set(faceHandles.map((h) => h.elementId))] : []

  return (
    <>
      {handles.map((h) => (
        <Tooltip key={`${h.kind}:${h.elementId}:${h.port}`}>
          <TooltipTrigger asChild>
            <Button
              size="icon-xs"
              variant="outline"
              className={HANDLE_CLASS}
              style={{ left: h.x, top: h.y }}
              aria-label={h.label}
              data-testid="plus-handle"
              data-kind={h.kind}
              data-element-id={h.elementId}
              data-port={h.port}
              onPointerDown={stop}
              onKeyDown={escape}
              onClick={(e) => {
                e.stopPropagation()
                onPick(h)
              }}
            >
              <Plus data-icon="inline-start" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{h.label}</TooltipContent>
        </Tooltip>
      ))}
      {view !== 'plan' &&
        faceHandles.map((h) => (
          <Tooltip key={`face:${h.elementId}:${h.face}`}>
            <TooltipTrigger asChild>
              <Button
                size="icon-xs"
                variant="outline"
                className={HANDLE_CLASS}
                style={{ left: h.x, top: h.y }}
                aria-label={h.label}
                data-testid="plus-face-handle"
                data-face={h.face}
                data-element-id={h.elementId}
                onPointerDown={stop}
                onKeyDown={escape}
                onClick={(e) => {
                  e.stopPropagation()
                  onPickFace?.(h)
                }}
              >
                <Plus data-icon="inline-start" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{h.label}</TooltipContent>
          </Tooltip>
        ))}
      {planGroups.map((elementId) => {
        const face = planFace[elementId] ?? 'top'
        const h = faceHandles.find((f) => f.elementId === elementId && f.face === face) ?? faceHandles.find((f) => f.elementId === elementId)
        if (!h) return null
        const hint = planFaceHint(h.face)
        return (
          <Tooltip key={`plan-face:${elementId}`}>
            <TooltipTrigger asChild>
              <Button
                size="icon-xs"
                variant="outline"
                className={HANDLE_CLASS}
                style={{ left: h.x, top: h.y }}
                aria-label={`${h.label}. ${hint}`}
                aria-keyshortcuts="Tab Escape"
                data-testid="plus-face-handle"
                data-face={h.face}
                data-element-id={h.elementId}
                onPointerDown={stop}
                onKeyDown={(e) => {
                  if (escape(e)) return
                  if (e.key !== 'Tab') return
                  e.preventDefault()
                  e.stopPropagation()
                  setPlanFace((m) => ({ ...m, [elementId]: nextBranchFace(h.face) }))
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  onPickFace?.(h)
                }}
              >
                <Plus data-icon="inline-start" />
              </Button>
            </TooltipTrigger>
            <TooltipContent data-testid="plus-face-hint">{hint}</TooltipContent>
          </Tooltip>
        )
      })}
    </>
  )
}
