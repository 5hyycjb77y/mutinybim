'use client'

import { useEffect, useRef } from 'react'

/** How long after R the second key still counts (ms), as for Create similar's C then S. */
export const ROOM_CHORD_MS = 1200

/** The room key tips: R then W (Room from walls), R then F (Find rooms from walls). R alone and F alone keep their own jobs. */
export type RoomChord = 'room_from_walls' | 'find_from_walls'

/** Tracks R then W / R then F. `press` returns the chord a key completes; any other key in between breaks it. */
export class RoomChordTracker {
  private armedAt: number | null = null

  press(key: string, now: number): RoomChord | null {
    const k = key.toLowerCase()
    if (k === 'r') {
      this.armedAt = now
      return null
    }
    const armed = this.armedAt !== null && now - this.armedAt <= ROOM_CHORD_MS
    this.armedAt = null
    if (!armed) return null
    return k === 'w' ? 'room_from_walls' : k === 'f' ? 'find_from_walls' : null
  }
}

function typingInField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
}

/**
 * Keyboard R then W starts Room from walls; R then F finds rooms from walls.
 * Listens in the capture phase so the F doesn't also fit the view; only while
 * `active` (editing, the Select tool on, nothing being placed, so R doesn't
 * also rotate a part).
 */
export function useRoomChords(opts: { readonly active: boolean; readonly run: (chord: RoomChord) => void }): void {
  const latest = useRef(opts)
  useEffect(() => {
    latest.current = opts
  })
  useEffect(() => {
    const chords = new RoomChordTracker()
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || typingInField(e.target) || !latest.current.active) return
      const done = chords.press(e.key, e.timeStamp)
      if (!done) return
      e.preventDefault()
      e.stopImmediatePropagation()
      latest.current.run(done)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}
