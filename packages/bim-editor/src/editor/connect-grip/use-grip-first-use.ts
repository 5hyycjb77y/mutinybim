'use client'

import { useCallback } from 'react'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { BUILDING_MODEL_INPUT_PREFS, type BuildingModelInputSettings } from '../input/TrackpadHint'

const DEFAULTS: BuildingModelInputSettings = { connectGripUsed: false }

/**
 * Whether the hint line should teach the "+" grip ("Drag the + to a panel"):
 * until the person's first connection by grip, saved in their own Building
 * Model input preferences (database, not browser storage), so it stops on
 * every device once they have used it.
 */
export function useGripFirstUse(): { readonly showHint: boolean; readonly markUsed: () => void } {
  const { values: preferences, set: updatePreference, loaded: isAuthoritative } = useEditorHost().preferences.usePreferences(BUILDING_MODEL_INPUT_PREFS, DEFAULTS)
  const used = preferences.connectGripUsed === true
  const markUsed = useCallback(() => {
    if (used) return
    updatePreference('connectGripUsed', true).catch((err: unknown) => {
      console.error('[useGripFirstUse] saving that the grip was used failed; its hint may show again next time', err)
    })
  }, [used, updatePreference])
  return { showHint: isAuthoritative && !used, markUsed }
}
