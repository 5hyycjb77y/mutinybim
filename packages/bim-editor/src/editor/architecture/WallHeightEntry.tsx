'use client'

import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { Button } from '../../ui/button'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { feetInches } from '../placement'
import { parseWallHeight } from './WallTopField'

type Props = {
  /** The height the walls are drawn at now (shown to start from). */
  readonly currentMm: number
  readonly onSet: (heightMm: number) => void
  readonly onClose: () => void
  readonly className?: string
}

/**
 * The Wall tool's height box, opened with H while drawing. Its own field, so
 * the digits typed here never reach the wall-length typing. Enter (or Use
 * height) sets the height for the walls that follow; Esc (or Cancel) closes
 * it and the tool stays in hand.
 */
export function WallHeightEntry({ currentMm, onSet, onClose, className }: Props): ReactNode {
  const [text, setText] = useState(feetInches(currentMm))
  const [why, setWhy] = useState<string | null>(null)
  const commit = () => {
    const parsed = parseWallHeight(text)
    if ('why' in parsed) return setWhy(parsed.why)
    onSet(parsed.mm)
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // The tool and the surface listen on the window: these keys belong to the box.
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Enter') commit()
      else onClose()
    }
  }
  return (
    <div className={['pointer-events-auto absolute bottom-16 left-1/2 z-20 w-72 -translate-x-1/2 rounded-md border border-border bg-background p-3 shadow-md', className].filter(Boolean).join(' ')} data-testid="architecture-wall-height-entry">
      <Field>
        <FieldLabel htmlFor="architecture-wall-height-entry-input">Wall height</FieldLabel>
        <div className="flex items-center gap-2">
          <Input id="architecture-wall-height-entry-input" className="h-8" autoFocus value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} aria-invalid={why !== null} data-testid="architecture-wall-height-entry-input" />
          <Button size="sm" onClick={commit} data-testid="architecture-wall-height-entry-set">
            Use height
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
        <FieldDescription className={why ? 'text-danger-600' : undefined} data-testid="architecture-wall-height-entry-words">
          {why ?? 'The walls you draw next are this tall, not tied to a level. Enter to use it, Esc to keep drawing as before.'}
        </FieldDescription>
      </Field>
    </div>
  )
}
