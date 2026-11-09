'use client'

import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import type { ModelSession } from '../model-session'

/** The query parameter Code Map "Show in model" opens the Building Model with. */
export const SELECT_PARAM = 'select'

/** The Building Model address that opens with this element or space selected. */
export function showInModelHref(projectId: string, elementId: string): string {
  return `/mutinybim/${encodeURIComponent(projectId)}?view=plan&${SELECT_PARAM}=${encodeURIComponent(elementId)}`
}

/**
 * Once the model is showing, select the element named in `?select=` (Code Map
 * "Show in model"), then take the parameter off the address so a reload
 * doesn't select it again.
 */
export function useSelectFromUrl(session: Pick<ModelSession, 'selectElement' | 'currentView'> | null): void {
  const done = useRef(false)
  useEffect(() => {
    if (done.current || !session) return
    const params = new URLSearchParams(window.location.search)
    const id = params.get(SELECT_PARAM)
    if (!id) {
      done.current = true
      return
    }
    const view = session.currentView()
    if (!view) return
    done.current = true
    params.delete(SELECT_PARAM)
    const query = params.toString()
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`)
    if (!view.elements[id]) {
      toast.info("The item linked to that code requirement isn't in this model any more. Re-link it from the requirement.")
      return
    }
    void session.selectElement(id).catch((err: unknown) => {
      console.error('[useSelectFromUrl] selecting the linked element failed', { id, err })
      toast.error("Couldn't select the linked item. Find it in the model and try again.")
    })
  }, [session])
}
