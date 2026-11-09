'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { EditorPreferenceValue } from '@permitzip/bim-editor-host'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { ToolHintBar } from '../ToolHintBar'
import { TRACKPAD_GESTURE_EVENT } from './flat-view-nav'

export const TRACKPAD_HINT_TEXT = 'Two fingers pan, pinch to zoom'
/** How long the tip stays up after the first swipe or pinch. */
export const TRACKPAD_HINT_MS = 8000
/** Per-person Building Model input preferences (`user_preferences`, saved in the database). */
export const BUILDING_MODEL_INPUT_PREFS = 'building_model.input'

export interface BuildingModelInputSettings {
  /** The person has seen "Two fingers pan, pinch to zoom" once; it never shows again. */
  trackpadHintShown?: boolean
  [key: string]: EditorPreferenceValue | undefined
}

const DEFAULTS: BuildingModelInputSettings = { trackpadHintShown: false }

/**
 * The one-time trackpad tip on flat views: the first time a person swipes or
 * pinches on a plan, sheet or drafting view, the hint line says how. Whether
 * they have seen it is their own preference in the database, so it shows once
 * per person, not once per browser.
 */
export function TrackpadHint() {
  const { values: preferences, set: updatePreference, loaded: isAuthoritative } = useEditorHost().preferences.usePreferences(BUILDING_MODEL_INPUT_PREFS, DEFAULTS)
  const [showing, setShowing] = useState(false)
  const asked = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const shown = preferences.trackpadHintShown === true

  const onGesture = useCallback(() => {
    // Until the saved answer has arrived we don't know if they've seen it; the next view's first swipe asks again.
    if (!isAuthoritative || shown || asked.current) return
    asked.current = true
    setShowing(true)
    timer.current = setTimeout(() => setShowing(false), TRACKPAD_HINT_MS)
    updatePreference('trackpadHintShown', true).catch((err: unknown) => {
      console.error('[TrackpadHint] saving that the trackpad tip was shown failed; it may show again next time', err)
    })
  }, [isAuthoritative, shown, updatePreference])

  useEffect(() => {
    window.addEventListener(TRACKPAD_GESTURE_EVENT, onGesture)
    return () => window.removeEventListener(TRACKPAD_GESTURE_EVENT, onGesture)
  }, [onGesture])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  if (!showing) return null
  return <ToolHintBar text={TRACKPAD_HINT_TEXT} testId="building-model-trackpad-hint" className="bottom-12" />
}
