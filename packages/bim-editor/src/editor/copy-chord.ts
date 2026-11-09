import { useEffect, useRef } from 'react'
import { CHORD_MS } from './create-similar'
import { typingIn } from './views-sheets/draft/copy-paste'

/**
 * Revit's CC: C then C copies the selection (product decision, Nov 6: "copy cc should be
 * copy"). Any other key in between, or a pause longer than Create similar's
 * C then S allows, breaks it, so a lone C and C then S still do what they did.
 */
export class CopyChord {
  private armedAt: number | null = null

  press(key: string, now: number): boolean {
    const k = key.toLowerCase()
    if (k !== 'c') {
      this.armedAt = null
      return false
    }
    if (this.armedAt !== null && now - this.armedAt <= CHORD_MS) {
      this.armedAt = null
      return true
    }
    this.armedAt = now
    return false
  }
}

/** C then C runs `onCopy` while `active` (something is selected, the model is open); typing in a field never counts. */
export function useCopyChord(opts: { readonly active: boolean; readonly onCopy: () => void }): void {
  const latest = useRef(opts)
  useEffect(() => {
    latest.current = opts
  })
  useEffect(() => {
    const chord = new CopyChord()
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || typingIn(e.target) || !latest.current.active) return
      if (!chord.press(e.key, e.timeStamp)) return
      e.preventDefault()
      latest.current.onCopy()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}
