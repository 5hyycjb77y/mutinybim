'use client'

import { clientOnly as dynamic } from '@permitzip/bim-editor/client-only'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Command, ElementId, ModelState, Vec2 } from '@permitzip/bim-kernel'
import { acceptAll, acceptedSpacesCommand, decide, proposeRooms, type ProposalDecision, type ReviewedProposal } from './propose-rooms'
import type { DrawSpaceMode } from './SpacesPlanLayer'
import type { SeparatorLine } from './separator-tool'
import { traceableUnderlays } from './trace-geometry'
import { acceptedWallRoomsCommand, proposeRoomsFromWalls } from './walls-rooms'
import { linkedPlanHeight, linkedReferenceWords } from '../linked-reference/linked-reference-store'
import { useLinkedReferenceState } from '../linked-reference/use-linked-reference'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { underlayLineworkFrom, underlayPageInfoFrom } from './use-underlays'
import { useFireAreas } from './use-fire-areas'

const AddUnderlayDialog = dynamic(() => import('./AddUnderlayDialog').then((m) => m.AddUnderlayDialog), { ssr: false })
const CalibrateUnderlayDialog = dynamic(() => import('./CalibrateUnderlayDialog').then((m) => m.CalibrateUnderlayDialog), { ssr: false })
const SplitSpaceDialog = dynamic(() => import('./SplitSpaceDialog').then((m) => m.SplitSpaceDialog), { ssr: false })

interface Options {
  readonly projectId: string
  readonly model: ModelState | null
  readonly levelId: ElementId | null
  readonly levelName: string | null
  readonly submit: (command: Command, undoLabel: string) => string | null
  /** Where a newly calibrated drawing's first picked point lands (the plan's centre). */
  readonly planCentre: Vec2
  /** The newest model when a proposal is made or accepted; `model` may be a slice that refreshes only for underlays and levels. */
  readonly currentModel?: () => ModelState | null
}

/** "Propose rooms from this drawing", as the panel shows it. Nothing is written until the person accepts. */
export type ProposeState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly drawing: string }
  | { readonly kind: 'empty'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string }
  /** `underlayId` null and `seeds` set: found from the walls (Find rooms from walls), accepted as rooms bounded by them. */
  | { readonly kind: 'review'; readonly drawing: string; readonly underlayId: ElementId | null; readonly proposals: readonly ReviewedProposal[]; readonly alreadySpaces: number; readonly seeds?: Readonly<Record<string, Vec2>>; /** Rooms a linked model's wall bounds: made from these outlines. */ readonly linkedOutlines?: Readonly<Record<string, readonly Vec2[]>> }

export interface ProposeControls {
  readonly state: ProposeState
  /** Why the action is off, in words; null when it can run. */
  readonly reason: string | null
  readonly start: () => void
  /** Find rooms from walls: the same review, from the walls on this level. */
  readonly startFromWalls: () => void
  /** Why Find rooms from walls is off, in words; null when it can run. */
  readonly wallsReason: string | null
  /** "Use the linked model's walls" for Find rooms from walls: shown when a model is linked, on by default. */
  readonly linkedWalls: { readonly shown: boolean; readonly on: boolean; readonly toggle: () => void; /** Why they can't be used right now (still loading, failed), in words. */ readonly note: string | null }
  readonly decide: (key: string, decision: ProposalDecision) => void
  readonly acceptAll: () => void
  /** Writes the accepted rooms as spaces in one undoable step; the refusal in words, or null. */
  readonly commit: () => string | null
  /** Leave with nothing written. */
  readonly cancel: () => void
}

/**
 * The Spaces tool's state in one place, so the surface mounts it with one
 * hook: the Draw space mode for the plan layer (or the proposed rooms shown
 * as ghosts), the panel's handlers, and the Add drawing / Set scale dialogs.
 * Esc on the plan ends drawing or reviewing; closing a dialog changes nothing.
 */
export function useSpacesTool({ projectId, model, levelId, levelName, submit, planCentre, currentModel }: Options) {
  const underlays = useEditorHost().data.underlays
  const [mode, setMode] = useState<DrawSpaceMode | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [calibrating, setCalibrating] = useState<ElementId | null>(null)
  const [proposeRaw, setPropose] = useState<ProposeState>({ kind: 'idle' })
  // The level it was started on: a plan change leaves the review (its ghosts belong to the other level's drawing).
  const [proposeLevel, setProposeLevel] = useState<ElementId | null>(null)
  const [splitLine, setSplitLine] = useState<SeparatorLine | null>(null)
  const propose = useMemo<ProposeState>(() => (proposeLevel === levelId ? proposeRaw : { kind: 'idle' }), [proposeRaw, proposeLevel, levelId])

  const underlay = calibrating && model ? model.elements[calibrating] : undefined
  const proposeFrom = useMemo(() => (model && levelId ? (traceableUnderlays(model, levelId)[0] ?? null) : null), [model, levelId])
  const cancelPropose = useCallback(() => setPropose({ kind: 'idle' }), [])
  const stop = useCallback(() => {
    setMode(null)
    setPropose({ kind: 'idle' })
  }, [])

  // Esc leaves the review with nothing written, wherever the focus is.
  const reviewing = propose.kind === 'review'
  useEffect(() => {
    if (!reviewing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPropose({ kind: 'idle' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [reviewing])

  const proposeReason = !levelId ? 'Open a floor plan to propose rooms on its level.' : !proposeFrom ? 'Add a drawing under this plan and set its scale first.' : mode !== null ? 'Stop drawing first.' : null

  const startPropose = useCallback(() => {
    if (!model || !levelId || !proposeFrom) return
    const latest = currentModel ?? (() => model)
    const drawing = `${proposeFrom.source.name}${proposeFrom.source.page ? `, page ${proposeFrom.source.page}` : ''}`
    setProposeLevel(levelId)
    setPropose({ kind: 'loading', drawing })
    underlayPageInfoFrom(underlays, projectId, proposeFrom.source.ref, proposeFrom.source.page ?? 1)
      .then((info) => {
        if (!info.lineworkUrl) {
          setPropose({ kind: 'error', message: `${drawing} has no drawn lines to read (it is a scanned picture). Draw the spaces with Draw space.` })
          return null
        }
        return underlayLineworkFrom(underlays, info.lineworkUrl)
      })
      .then((linework) => {
        if (!linework) return
        const now = latest() ?? model
        const outcome = proposeRooms(now, levelId, proposeFrom, linework)
        if (outcome.kind === 'review') setPropose({ kind: 'review', drawing, underlayId: proposeFrom.id, proposals: outcome.proposals, alreadySpaces: outcome.alreadySpaces })
        else setPropose(outcome)
      })
      .catch((err: unknown) => {
        console.error('[use-spaces-tool] proposing rooms failed', { projectId, underlayId: proposeFrom.id, err })
        setPropose({ kind: 'error', message: `The drawing’s lines didn’t load: ${err instanceof Error ? err.message : String(err)}` })
      })
  }, [underlays, model, levelId, proposeFrom, projectId, currentModel])

  const wallsReason = !levelId ? 'Open a floor plan to find the rooms its walls close.' : mode !== null ? 'Stop drawing first.' : null
  const linkedReference = useLinkedReferenceState()
  const [useLinkedWalls, setUseLinkedWalls] = useState(true)
  const linkedShown = linkedReference.status !== 'none'
  const linkedNote = linkedReference.status === 'ready' && !linkedReference.index.items.some((i) => i.rule.boundsRooms) ? `${linkedReference.index.sources.map((x) => x.label).join(', ')} has no walls that bound rooms.` : linkedReferenceWords(linkedReference)
  const startFromWalls = useCallback(() => {
    const now = currentModel?.() ?? model
    if (!now || !levelId) return
    setProposeLevel(levelId)
    const zMm = linkedPlanHeight(now, levelId)
    const linked = useLinkedWalls && linkedReference.status === 'ready' && zMm !== null ? { index: linkedReference.index, zMm } : null
    const outcome = proposeRoomsFromWalls(now, levelId, linked)
    const own = `the walls on ${levelName ?? 'this level'}`
    // Say plainly when the linked walls were wanted but couldn't be used.
    const linkedLabel = linked ? linked.index.sources.map((x) => x.label).join(', ') : null
    const drawing = linkedLabel ? `${own} and ${linkedLabel}` : useLinkedWalls && linkedNote ? `${own} only (${linkedNote})` : own
    if (outcome.kind === 'review') setPropose({ kind: 'review', drawing, underlayId: null, proposals: outcome.proposals, alreadySpaces: 0, seeds: outcome.seeds, ...(outcome.linkedOutlines ? { linkedOutlines: outcome.linkedOutlines } : {}) })
    else setPropose({ kind: 'empty', message: useLinkedWalls && linkedNote && !linked ? `${outcome.message} ${linkedNote}` : outcome.message })
  }, [model, levelId, levelName, currentModel, useLinkedWalls, linkedReference, linkedNote])

  const proposeControls = useMemo<ProposeControls>(
    () => ({
      state: propose,
      reason: proposeReason,
      start: startPropose,
      startFromWalls,
      wallsReason,
      linkedWalls: { shown: linkedShown, on: useLinkedWalls, toggle: () => setUseLinkedWalls((v) => !v), note: linkedNote },
      decide: (key, decision) => setPropose((s) => (s.kind === 'review' ? { ...s, proposals: decide(s.proposals, key, decision) } : s)),
      acceptAll: () => setPropose((s) => (s.kind === 'review' ? { ...s, proposals: acceptAll(s.proposals) } : s)),
      commit: () => {
        const now = currentModel?.() ?? model
        if (propose.kind !== 'review' || !now || !levelId) return 'Nothing to add.'
        if (propose.seeds) {
          const fromWalls = acceptedWallRoomsCommand(now, levelId, propose.proposals, propose.seeds, propose.linkedOutlines)
          if (!fromWalls) return 'Accept at least one room first.'
          const n = propose.proposals.filter((p) => p.decision === 'accepted').length
          const refusedWalls = submit(fromWalls, n === 1 ? 'Add room from walls' : `Add ${n} rooms from walls`)
          if (refusedWalls === null) setPropose({ kind: 'idle' })
          return refusedWalls
        }
        if (!propose.underlayId) return 'The drawing was removed; propose the rooms again.'
        const u = now.elements[propose.underlayId]
        if (u?.kind !== 'drawing_underlay') return 'The drawing was removed; propose the rooms again.'
        const command = acceptedSpacesCommand(now, levelId, u, propose.proposals)
        if (!command) return 'Accept at least one room first.'
        const accepted = propose.proposals.filter((p) => p.decision === 'accepted').length
        const refused = submit(command, accepted === 1 ? 'Add proposed room' : `Add ${accepted} proposed rooms`)
        if (refused === null) setPropose({ kind: 'idle' })
        return refused
      },
      cancel: cancelPropose,
    }),
    [propose, proposeReason, startPropose, startFromWalls, wallsReason, linkedShown, useLinkedWalls, linkedNote, model, levelId, submit, cancelPropose, currentModel],
  )

  const fireAreas = useFireAreas({ model, levelId, submit, currentModel, busyReason: mode !== null ? 'Stop drawing first.' : propose.kind !== 'idle' ? 'Finish the room review open below first.' : null })
  const fireOpen = fireAreas.state.kind !== 'idle'
  const closeFireAreas = fireAreas.close
  useEffect(() => {
    if (fireOpen && (mode !== null || propose.kind !== 'idle')) closeFireAreas()
  }, [fireOpen, mode, propose.kind, closeFireAreas])

  // The plan layer shows the proposals as ghosts while they are being reviewed.
  const fireState = fireAreas.state
  const planMode = useMemo<DrawSpaceMode | null>(() => {
    if (propose.kind === 'review') return { kind: 'review', proposals: propose.proposals }
    if (fireState.kind === 'review')
      return { kind: 'review', label: 'Fire area', proposals: fireState.rows.map((r) => ({ room: r.proposal, decision: r.decision === 'added' ? 'accepted' : r.decision === 'dismissed' ? 'rejected' : 'pending' })) }
    return mode
  }, [propose, fireState, mode])

  const panel = useMemo(
    () => ({
      drawing: mode !== null,
      onDrawSpace: () => {
        setPropose({ kind: 'idle' })
        setMode({ kind: 'new', shape: 'polygon' })
      },
      onRedrawSpace: (spaceId: ElementId) => {
        setPropose({ kind: 'idle' })
        setMode({ kind: 'redraw', spaceId, shape: 'polygon' })
      },
      onStopDrawing: stop,
      /** Room from walls: hover a room on the plan, click to make it. */
      onRoomFromWalls: () => {
        setPropose({ kind: 'idle' })
        setMode({ kind: 'from_walls' })
      },
      /** Separation line, then the Split space dialog. */
      onSeparationLine: () => {
        setPropose({ kind: 'idle' })
        setMode({ kind: 'separator' })
      },
      onAddUnderlay: () => setAddOpen(true),
      onCalibrate: (underlayId: ElementId) => setCalibrating(underlayId),
      propose: proposeControls,
      fireAreas,
    }),
    [mode, stop, proposeControls, fireAreas],
  )

  const dialogs = (
    <>
      <AddUnderlayDialog open={addOpen} onOpenChange={setAddOpen} projectId={projectId} levelId={levelId} levelName={levelName} submit={submit} onPlaced={(id) => setCalibrating(id)} />
      {model ? (
        <SplitSpaceDialog
          line={splitLine}
          model={currentModel?.() ?? model}
          submit={submit}
          onClose={() => setSplitLine(null)}
        />
      ) : null}
      <CalibrateUnderlayDialog
        open={calibrating !== null}
        onOpenChange={(o) => !o && setCalibrating(null)}
        projectId={projectId}
        underlay={underlay?.kind === 'drawing_underlay' ? underlay : null}
        modelAt={planCentre}
        submit={submit}
      />
    </>
  )

  // The separation line is drawn: the plan tool stops and the dialog asks the rest (its own Esc and Cancel close it).
  const onSeparatorLine = useCallback((line: SeparatorLine) => {
    setMode(null)
    setSplitLine(line)
  }, [])

  return { mode: planMode, setMode, stop, panel, dialogs, onDrawn: stop, onSeparatorLine }
}
