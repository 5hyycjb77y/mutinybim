'use client'

import { hostVoidsOf, OPENING_SILL_KEY, type BimElement, type ModelState } from '@permitzip/bim-kernel'
import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { parseFeet } from '../parse-feet'
import { feetInches } from '../placement'
import type { SubmitCommand } from '../views-sheets/types'

const FT_MM = 304.8

type Props = {
  readonly model: ModelState
  readonly el: BimElement
  readonly submit: SubmitCommand
  readonly editBlocked: string | null
  readonly notify: (message: string, kind?: 'info' | 'error') => void
}

/** The sill a door or window has now: the bottom of its cut in the wall, mm; null when it cuts nothing. */
export function openingSillMm(model: ModelState, el: BimElement): number | null {
  if (el.kind !== 'opening') return null
  const cut = hostVoidsOf(model.elements, el.hostId).find((v) => v.elementId === el.id)
  return cut && cut.profile.length > 0 ? Math.min(...cut.profile.map((p) => p.y)) : null
}

/** A door or window's sill height in Properties: typed in feet and inches, checked by the model (it has to stay inside the wall). */
export function OpeningSillField({ model, el, submit, editBlocked, notify }: Props): ReactNode {
  const sill = openingSillMm(model, el)
  const shown = sill === null ? '' : feetInches(sill)
  const [text, setText] = useState(shown)
  const [why, setWhy] = useState<string | null>(null)
  const [synced, setSynced] = useState(shown)
  if (synced !== shown) {
    setSynced(shown)
    setText(shown)
  }
  if (el.kind !== 'opening') return null
  const what = el.openingType.replace(/_/g, ' ')
  const commit = () => {
    if (text.trim() === shown) return setWhy(null)
    const ft = parseFeet(text.replace(/'\s*-\s*/, "' "))
    if (ft === null || ft < 0) return setWhy(`"${text.trim()}" doesn't read as a height. Type feet and inches: 3'-0", 2 ft 6 in, 36".`)
    const err = submit({ type: 'set_element_values', elementIds: [el.id], values: { [OPENING_SILL_KEY]: Math.round(ft * FT_MM * 10) / 10 } }, `Set the ${what}'s sill height`)
    if (err) {
      console.error('[OpeningSillField] sill height refused', { elementId: el.id, err })
      setWhy(err)
      notify(err, 'error')
      return
    }
    setWhy(null)
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape') {
      setText(shown)
      setWhy(null)
    }
  }
  return (
    <Field data-testid="architecture-opening-sill">
      <FieldLabel htmlFor="architecture-opening-sill-input">Sill height</FieldLabel>
      <Input id="architecture-opening-sill-input" className="h-8 w-28" value={text} disabled={editBlocked !== null} aria-invalid={why !== null} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={onKey} data-testid="architecture-opening-sill-input" />
      <FieldDescription className={why ? 'text-danger-600' : undefined} data-testid="architecture-opening-sill-words">
        {why ?? editBlocked ?? `How high the bottom of the ${what} sits above the floor of its wall. Its head is at ${feetInches((sill ?? 0) + el.height)}.`}
      </FieldDescription>
    </Field>
  )
}
