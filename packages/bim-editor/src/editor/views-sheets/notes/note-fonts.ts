'use client'

import { useEffect, useState } from 'react'
import { NOTE_FONT_FILES, NOTE_SVG_FONT_FAMILY } from '@permitzip/bim-kernel'

/**
 * Load the note fonts into the page as "MutinyBIM Notes": the same files the
 * PDF embeds and the layout measured (public/mutinybim/fonts, hash-checked by
 * the sheets package tests). Until they load, the SVG falls back to Liberation
 * Sans / Arial, which share these advances, and every glyph is placed by x
 * anyway, so text never reflows when the font arrives.
 */

const BASE = '/mutinybim/fonts/'
const FACES: ReadonlyArray<{ readonly file: string; readonly weight: string; readonly style: string }> = [
  { file: NOTE_FONT_FILES.regular, weight: '400', style: 'normal' },
  { file: NOTE_FONT_FILES.bold, weight: '700', style: 'normal' },
  { file: NOTE_FONT_FILES.italic, weight: '400', style: 'italic' },
  { file: NOTE_FONT_FILES.boldItalic, weight: '700', style: 'italic' },
]

let loading: Promise<boolean> | null = null

function loadNoteFonts(): Promise<boolean> {
  if (loading) return loading
  loading = Promise.all(
    FACES.map(async (f) => {
      const face = new FontFace(NOTE_SVG_FONT_FAMILY, `url(${BASE}${f.file}) format('truetype')`, { weight: f.weight, style: f.style, display: 'block' })
      await face.load()
      document.fonts.add(face)
    }),
  )
    .then(() => true)
    .catch((err: unknown) => {
      console.error('[note-fonts] note fonts failed to load; notes draw in the Arial-metric fallback', err)
      return false
    })
  return loading
}

/** 'ready' once the note fonts are in the page, 'fallback' if they couldn't load (logged). */
export function useNoteFonts(): 'loading' | 'ready' | 'fallback' {
  const [state, setState] = useState<'loading' | 'ready' | 'fallback'>('loading')
  useEffect(() => {
    let live = true
    void loadNoteFonts().then((ok) => {
      if (live) setState(ok ? 'ready' : 'fallback')
    })
    return () => {
      live = false
    }
  }, [])
  return state
}
