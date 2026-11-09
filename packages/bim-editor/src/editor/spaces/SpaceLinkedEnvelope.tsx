'use client'

import { useMemo, useState } from 'react'
import { Copy } from 'lucide-react'
import { linkedEnvelopeAt, spaceEnvelopeOf, spaceOutlines, type Command, type ElementId, type LinkedEnvelope, type LinkedReferenceIndex, type ModelState } from '@permitzip/bim-kernel'
import { Button } from '../../ui/button'
import { linkedPlanHeight, linkedReferenceWords } from '../linked-reference/linked-reference-store'
import { copyEnvelopeForLoads } from '../linked-reference/linked-copies-for-loads'
import { useLinkedReferenceState } from '../linked-reference/use-linked-reference'
import { feetInches, newElementId } from '../placement'

/**
 * A space's envelope as the linked building model shows it: the outside
 * walls along its edges (length, which way they face) and the windows and
 * doors in them, for load calculations. Read-only until "Copy into the model
 * for loads" copies them as walls and openings that are kept in step with the
 * link (Spaces › Copies from the linked model lists any that changed).
 */

const envelopeCache = new WeakMap<LinkedReferenceIndex, Map<number, LinkedEnvelope>>()

function envelopeOf(index: LinkedReferenceIndex, zMm: number): LinkedEnvelope {
  let byZ = envelopeCache.get(index)
  if (!byZ) {
    byZ = new Map()
    envelopeCache.set(index, byZ)
  }
  const held = byZ.get(zMm)
  if (held) return held
  const env = linkedEnvelopeAt(index, zMm)
  byZ.set(zMm, env)
  return env
}

const SQ_FT_PER_M2 = 10.7639

const COMPASS = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'] as const

/** The model's +y is plan north until the project's true north is set, so this says "plan" directions. */
function facingWords(deg: number): string {
  return COMPASS[Math.round(deg / 45) % 8] ?? 'east'
}

interface Props {
  readonly model: ModelState
  readonly spaceId: ElementId
  readonly submit: (command: Command, undoLabel: string) => string | null
  /** Why edits are off, in words; null when they may be made. */
  readonly editReason: string | null
}

export function SpaceLinkedEnvelope({ model, spaceId, submit, editReason }: Props) {
  const linked = useLinkedReferenceState()
  const [notice, setNotice] = useState<{ readonly tone: 'info' | 'error'; readonly text: string } | null>(null)
  const space = model.elements[spaceId]
  const levelId = space?.kind === 'space' ? (space.levelId ?? null) : null
  const result = useMemo(() => {
    if (linked.status !== 'ready' || space?.kind !== 'space' || !levelId) return null
    const zMm = linkedPlanHeight(model, levelId)
    const outline = spaceOutlines(model.elements, space)[0]
    if (zMm === null || !outline) return null
    return spaceEnvelopeOf(envelopeOf(linked.index, zMm), outline)
  }, [linked, model, space, levelId])

  if (linked.status === 'none' || !levelId) return null
  const words = linkedReferenceWords(linked)
  const windows = result ? result.openings.filter((o) => o.role === 'window').length : 0

  const copy = () => {
    if (linked.status !== 'ready' || !result) return
    const outcome = copyEnvelopeForLoads(model, linked.index, result, levelId, newElementId)
    if (outcome.kind === 'nothing') {
      setNotice({ tone: 'info', text: outcome.message })
      return
    }
    const refused = submit(outcome.command, 'Copy outside walls and windows for loads')
    setNotice(refused ? { tone: 'error', text: refused } : { tone: 'info', text: `Copied ${outcome.walls} ${outcome.walls === 1 ? 'wall' : 'walls'} and ${outcome.openings} ${outcome.openings === 1 ? 'window or door' : 'windows and doors'} from the linked model. They stay in step with it: when it changes, Spaces lists them to update or keep.` })
  }

  return (
    <div className="flex flex-col gap-1 text-xs" data-testid="space-linked-envelope">
      <span className="font-medium text-muted-foreground">Outside walls and windows from the linked model</span>
      {words ? (
        <span className="text-muted-foreground">{words}</span>
      ) : !result || result.walls.length === 0 ? (
        <span className="text-muted-foreground">No outside wall of the linked model runs along this space.</span>
      ) : (
        <>
          <span data-testid="space-linked-envelope-summary">
            {result.walls.length} outside {result.walls.length === 1 ? 'wall' : 'walls'}, {feetInches(result.exteriorLengthMm)} long; {windows} {windows === 1 ? 'window' : 'windows'}, {(result.windowAreaM2 * SQ_FT_PER_M2).toFixed(1)} sq ft
          </span>
          <ul className="flex flex-col gap-0.5 text-muted-foreground">
            {result.walls.map((w) => (
              <li key={`${w.wall.sourceId}:${w.wall.globalId}`}>
                Faces plan {facingWords(w.facingDeg)}: {feetInches(w.lengthMm)} of {w.name}
              </li>
            ))}
          </ul>
          <div>
            <Button size="sm" variant="outline" onClick={copy} disabled={editReason !== null} title={editReason ?? 'Copies these walls, windows and doors into this model as walls and openings that load calculations read; each is kept in step with the linked model'} data-testid="space-linked-envelope-copy">
              <Copy data-icon="inline-start" />
              Copy into the model for loads
            </Button>
          </div>
        </>
      )}
      {notice ? (
        <span className={notice.tone === 'error' ? 'text-danger-600' : 'text-muted-foreground'} role="status" data-testid="space-linked-envelope-notice">
          {notice.text}
        </span>
      ) : null}
    </div>
  )
}
