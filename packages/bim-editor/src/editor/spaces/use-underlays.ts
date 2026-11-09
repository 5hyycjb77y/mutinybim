'use client'

import { useCallback, useEffect, useState } from 'react'
import type { DrawingUnderlay } from '@permitzip/bim-kernel'
import type { EditorDataAnswer, EditorDataHost } from '@permitzip/bim-editor-host'
import { useOptionalEditorHost } from '@permitzip/bim-editor/host'
import { EditorServiceUnavailableError, unavailableWords } from '@permitzip/bim-editor/host/unavailable'
import { underlayRoutes, type UnderlayCandidate, type UnderlayPageInfo, type UnderlaySegment } from '../../contracts/bim/underlays/formats'

/**
 * The host side of underlays (`underlays` port): the project's workspace
 * drawings to pick from, and for a placed underlay its page picture and
 * linework. Every read goes through the host, which checks the person's
 * access each time.
 */

type UnderlaysPort = EditorDataHost['underlays']
const DRAWINGS = 'Drawings to trace over'

export type Loadable<T> = { readonly state: 'loading' } | { readonly state: 'error'; readonly message: string } | { readonly state: 'ready'; readonly value: T }

async function readJson<T>(url: string, request: () => Promise<EditorDataAnswer>, what: string): Promise<T> {
  const res = await request()
  const body: unknown = await res.json().catch((err: unknown) => {
    console.error('[use-underlays] reading the reply failed', { url, err })
    return null
  })
  if (!res.ok) throw new Error(underlayReplyMessage(res.status, body, what))
  return body as T
}

/** What a refused underlay request says to the person: access in plain words, otherwise the server's own reason. */
export function underlayReplyMessage(status: number, body: unknown, what: string): string {
  if (status === 401) return 'You’re signed out. Sign in again, then reopen the drawings.'
  if (status === 403) return 'You can’t see this project’s drawings. Ask the project lead to add you to the project.'
  const said = typeof body === 'object' && body !== null ? Reflect.get(body, 'error') : undefined
  return typeof said === 'string' && said.trim() !== '' ? said : `${what} didn’t load (error ${status}). Try again in a moment.`
}

/** The workspace drawings the person can place, newest first. `reload` after an upload. */
export function useUnderlayCandidatesFrom(port: UnderlaysPort, projectId: string, enabled: boolean): { readonly files: Loadable<readonly UnderlayCandidate[]>; readonly reload: () => void } {
  const capabilities = useOptionalEditorHost()?.capabilities ?? null
  const [files, setFiles] = useState<Loadable<readonly UnderlayCandidate[]>>({ state: 'loading' })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!enabled || !port) return
    let live = true
    setFiles({ state: 'loading' })
    readJson<{ files: UnderlayCandidate[] }>('underlay candidates', () => port.candidates({ projectId }), 'The drawings list')
      .then((r) => live && setFiles({ state: 'ready', value: r.files }))
      .catch((err: unknown) => {
        console.error('[use-underlays] listing drawings failed', { projectId, err })
        if (live) setFiles({ state: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      live = false
    }
  }, [port, projectId, enabled, tick])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { files: port ? files : { state: 'error', message: unavailableWords(DRAWINGS, capabilities) }, reload }
}

const infoCache = new Map<string, Promise<UnderlayPageInfo>>()
const lineworkCache = new Map<string, Promise<readonly UnderlaySegment[]>>()

export function underlayPageInfoFrom(port: UnderlaysPort, projectId: string, fileId: string, page: number): Promise<UnderlayPageInfo> {
  if (!port) return Promise.reject(new EditorServiceUnavailableError(DRAWINGS))
  const url = underlayRoutes(projectId, fileId, page).info
  let p = infoCache.get(url)
  if (!p) {
    p = readJson<UnderlayPageInfo>(url, () => port.pageInfo({ projectId, fileId, page }), 'The drawing page')
    p.catch(() => infoCache.delete(url))
    infoCache.set(url, p)
  }
  return p
}

export function underlayLineworkFrom(port: UnderlaysPort, url: string): Promise<readonly UnderlaySegment[]> {
  if (!port) return Promise.reject(new EditorServiceUnavailableError(DRAWINGS))
  let p = lineworkCache.get(url)
  if (!p) {
    p = readJson<{ segments: UnderlaySegment[] }>(url, () => port.linework({ url }), 'The drawing linework').then((r) => r.segments)
    p.catch(() => lineworkCache.delete(url))
    lineworkCache.set(url, p)
  }
  return p
}

/** A placed underlay's page (size, picture link) and its linework once loaded. */
export function useUnderlayPageFrom(port: UnderlaysPort, projectId: string, underlay: DrawingUnderlay | null): { readonly page: Loadable<UnderlayPageInfo>; readonly linework: readonly UnderlaySegment[] } {
  const [page, setPage] = useState<Loadable<UnderlayPageInfo>>({ state: 'loading' })
  const [linework, setLinework] = useState<readonly UnderlaySegment[]>([])
  const ref = underlay?.source.ref ?? null
  const pageNo = underlay?.source.page ?? 1
  useEffect(() => {
    if (!ref) return
    let live = true
    setPage({ state: 'loading' })
    setLinework([])
    underlayPageInfoFrom(port, projectId, ref, pageNo)
      .then((info) => {
        if (!live) return
        setPage({ state: 'ready', value: info })
        if (info.lineworkUrl)
          underlayLineworkFrom(port, info.lineworkUrl)
            .then((s) => live && setLinework(s))
            .catch((err: unknown) => console.error('[use-underlays] linework failed; tracing still works, without snapping to the drawing', { ref, err }))
      })
      .catch((err: unknown) => {
        console.error('[use-underlays] page info failed', { projectId, ref, err })
        if (live) setPage({ state: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      live = false
    }
  }, [port, projectId, ref, pageNo])
  return { page, linework }
}
