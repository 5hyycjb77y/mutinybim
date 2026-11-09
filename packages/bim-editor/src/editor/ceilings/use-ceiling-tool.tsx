'use client'

import { clientOnly as dynamic } from '@permitzip/bim-editor/client-only'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { viewModelLevel, type ModelState } from '@permitzip/bim-kernel'
import { ceilingRibbonCommand, ceilingToolReason, DEFAULT_CEILING_SETTINGS, parseCeilingSettings, type CeilingToolSettings, type ParsedCeilingSettings } from './ceiling-tool'

const CeilingToolBar = dynamic(() => import('./CeilingToolBar').then((m) => m.CeilingToolBar), { ssr: false })

/** The open view, as far as the Ceiling tool reads it. */
interface OpenView {
  readonly viewType: string
  readonly props?: { readonly level?: string; readonly levelElevationMm?: number }
}

interface Options {
  readonly model: ModelState | null
  readonly openView: OpenView | null
  /** Null when editing is allowed; otherwise why not, in words. */
  readonly editBlocked: string | null
  /** The tool draws on the plan's drawing: the surface switches a plan shown as the live model to its drawing, and drops other tools. */
  readonly onStart: () => void
}

/** What the drawing canvas needs to mount the Ceiling tool's layer on a ceiling plan. */
export interface CeilingCanvasTool {
  readonly settings: CeilingToolSettings
  readonly parsed: ParsedCeilingSettings
  readonly onResult: (outcome: { readonly ok: boolean; readonly message: string }) => void
  readonly onCancel: () => void
}

/**
 * The ceiling plan's Ceiling tool in one hook, so the surface mounts it in a
 * few lines: the ribbon command (greyed with the reason off a ceiling plan),
 * the canvas layer's props while it is on, and its bar. Leaving the ceiling
 * plan stops it.
 */
export function useCeilingTool({ model, openView, editBlocked, onStart }: Options) {
  const [active, setActive] = useState(false)
  const [settings, setSettings] = useState<CeilingToolSettings>(DEFAULT_CEILING_SETTINGS)
  const [last, setLast] = useState<{ readonly ok: boolean; readonly message: string } | null>(null)
  const ceilingPlanOpen = openView?.viewType === 'ceiling_plan'
  const levelId = useMemo(() => (model && openView && ceilingPlanOpen ? (viewModelLevel(model, openView.props?.level, openView.props?.levelElevationMm)?.id ?? null) : null), [model, openView, ceilingPlanOpen])
  const reason = ceilingToolReason({ ceilingPlanOpen, levelId, editBlocked })
  const parsed = useMemo(() => parseCeilingSettings(settings), [settings])

  const stop = useCallback(() => {
    setActive(false)
    setLast(null)
  }, [])

  // The tool belongs to the ceiling plan it was started on: a closed plan or lost edit rights stops it.
  useEffect(() => {
    if (active && reason !== null) stop()
  }, [active, reason, stop])

  const ribbon = useMemo(
    () =>
      ceilingRibbonCommand({
        active,
        disabledReason: reason,
        toggle: () => {
          if (active) return stop()
          onStart()
          setActive(true)
        },
      }),
    [active, reason, stop, onStart],
  )

  const canvas = useMemo<CeilingCanvasTool | null>(() => (active ? { settings, parsed, onResult: setLast, onCancel: stop } : null), [active, settings, parsed, stop])

  const bar = active ? (
    <div className="pointer-events-none fixed inset-x-0 top-32 z-30 flex justify-center px-4">
      <div className="pointer-events-auto">
        <CeilingToolBar
          settings={settings}
          parsed={parsed}
          onChange={(next) => {
            setSettings(next)
            setLast(null)
          }}
          last={last}
          onStop={stop}
        />
      </div>
    </div>
  ) : null

  return { active, ribbon, canvas, bar, stop }
}
