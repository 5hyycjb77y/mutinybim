'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { View3dCamera } from '@permitzip/bim-kernel'
import type { EditorDataHost } from '@permitzip/bim-editor-host'
import { unavailableWords } from '@permitzip/bim-editor/host/unavailable'
import { viewCameraSchema } from '../../contracts/building-model/view-camera-prefs'
import { sameCamera } from './view-camera-memory'

/** A look is saved once the camera has rested this long (orbiting fires many settles). */
export const CAMERA_SAVE_DELAY_MS = 1200

export interface ViewCameraMemory {
  /** False until the saved cameras have arrived (or failed to). */
  readonly loaded: boolean
  /** Where this person last left a 3D view, or undefined (it opens at the view's own camera). */
  readonly cameraFor: (key: string) => View3dCamera | undefined
  /** Remember where they are now (saved in the background after the camera rests; a failure says so once). */
  readonly remember: (key: string, camera: View3dCamera) => void
}

type ViewPrefsPort = EditorDataHost['viewPrefs']

function isCameras(value: unknown): value is { cameras: Record<string, unknown> } {
  return typeof value === 'object' && value !== null && 'cameras' in value && typeof value.cameras === 'object' && value.cameras !== null
}

/**
 * The 3D view reopens where the signed-in person left it (product decision, Nov 6: "it
 * doesn't seem to remember where I was last on the 3D view"): loaded once per
 * project from the database, saved there when the camera rests, so it follows
 * them across reloads and machines.
 */
export function useViewCameraMemoryFrom(port: ViewPrefsPort, projectId: string): ViewCameraMemory {
  const [loaded, setLoaded] = useState(false)
  const cameras = useRef(new Map<string, View3dCamera>())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const warned = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    setLoaded(false)
    cameras.current = new Map()
    if (!port) {
      setLoaded(true)
      return () => controller.abort()
    }
    port
      .cameras({ projectId }, { signal: controller.signal })
      .then(async (res) => {
        const body: unknown = await res.json()
        if (!res.ok) throw new Error(typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : `HTTP ${res.status}`)
        if (!isCameras(body)) throw new Error('The saved 3D cameras came back in an unexpected shape.')
        for (const [key, value] of Object.entries(body.cameras)) {
          const parsed = viewCameraSchema.safeParse(value)
          if (parsed.success && !cameras.current.has(key)) cameras.current.set(key, parsed.data)
        }
        setLoaded(true)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        console.error('[useViewCameraMemory] loading where 3D views were left failed', { projectId, err })
        toast.error("Where you left each 3D view couldn't be loaded, so they open at their own cameras until you reload.")
        setLoaded(true)
      })
    return () => controller.abort()
  }, [port, projectId])

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const t of pending.values()) clearTimeout(t)
      pending.clear()
    }
  }, [])

  const cameraFor = useCallback<ViewCameraMemory['cameraFor']>((key) => cameras.current.get(key), [])

  const remember = useCallback<ViewCameraMemory['remember']>(
    (key, camera) => {
      if (sameCamera(cameras.current.get(key), camera)) return
      cameras.current.set(key, camera)
      if (!port) {
        if (warned.current) return
        warned.current = true
        toast.info(unavailableWords('Remembering where you left each 3D view'))
        return
      }
      const before = timers.current.get(key)
      if (before) clearTimeout(before)
      timers.current.set(
        key,
        setTimeout(() => {
          timers.current.delete(key)
          port
            .saveCamera({ projectId, viewKey: key, camera })
            .then(async (res) => {
              if (res.ok) return
              const body: unknown = await res.json().catch((err: unknown) => {
                console.error('[useViewCameraMemory] reading the refusal failed', err)
                return null
              })
              throw new Error(typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : `HTTP ${res.status}`)
            })
            .catch((err: unknown) => {
              console.error('[useViewCameraMemory] saving where the 3D view was left failed', { projectId, key, err })
              if (warned.current) return
              warned.current = true
              toast.error("Where you are in this 3D view couldn't be saved for next time; it will open at its own camera.")
            })
        }, CAMERA_SAVE_DELAY_MS),
      )
    },
    [port, projectId],
  )

  return useMemo(() => ({ loaded, cameraFor, remember }), [loaded, cameraFor, remember])
}
