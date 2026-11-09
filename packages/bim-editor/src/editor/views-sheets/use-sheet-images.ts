'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { elementsOfKind, type ModelState } from '@permitzip/bim-kernel'
import type { SheetImageSource } from '@permitzip/bim-sheets/pdf-core'
import type { EditorDataHost } from '@permitzip/bim-editor-host'
import { EditorServiceUnavailableError, unavailableWords } from '@permitzip/bim-editor/host/unavailable'

type SheetImagesPort = EditorDataHost['sheetImages']
const PICTURES = 'Pictures on sheets'

/** What a sheet needs from the host to show and print its pictures. */
export interface SheetImages {
  /** A loaded picture's URL for the screen; null while it loads or when it couldn't be read. */
  readonly url: (fileId: string) => string | null
  /** Why a picture couldn't be read (gone, no access), by file id. */
  readonly errors: ReadonlyMap<string, string>
  /** Bytes for Print PDF and the printed preview. */
  readonly source: SheetImageSource
  /** Put a picture into the project's workspace (Workspace › project root); its workspace file id, or why not. */
  readonly upload: (file: File) => Promise<{ readonly fileId: string } | { readonly error: string }>
}

interface WorkspaceFileResponse {
  readonly download_url?: string | null
  readonly download_error?: string
  readonly error?: string
}

/** A picture's short-lived download link, read through the workspace file route (the person's own access decides). */
async function signedUrl(port: SheetImagesPort, projectId: string, fileId: string): Promise<string> {
  if (!port) throw new EditorServiceUnavailableError(PICTURES)
  const res = await port.link({ projectId, fileId })
  const body = (await res.json().catch((err: unknown) => {
    console.error('[use-sheet-images] reading the workspace file reply failed', { fileId, err })
    return {}
  })) as WorkspaceFileResponse
  if (!res.ok) throw new Error(res.status === 404 ? 'The picture is no longer in the workspace' : (body.error ?? `HTTP ${res.status}`))
  if (!body.download_url) throw new Error(body.download_error ?? 'The picture has no file to show')
  return body.download_url
}

/**
 * Pictures placed on this model's sheets: their links for the screen, their
 * bytes for print, and the upload that puts a new one in the project's
 * workspace. Links are signed for an hour; a model edit re-reads only new ids.
 */
export function useSheetImagesFrom(port: SheetImagesPort, projectId: string, model: ModelState | null): SheetImages {
  const fileIds = useMemo(() => {
    const ids = new Set<string>()
    if (model) for (const it of elementsOfKind(model.elements, 'drawing_item')) if (!it.deleted && it.figure?.kind === 'image') ids.add(it.figure.image.fileId)
    return [...ids].sort()
  }, [model])
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map())
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map())
  const requested = useRef(new Set<string>())

  useEffect(() => {
    for (const id of fileIds) {
      if (requested.current.has(id)) continue
      requested.current.add(id)
      signedUrl(port, projectId, id)
        .then((url) => setUrls((m) => new Map(m).set(id, url)))
        .catch((err: unknown) => {
          console.error('[use-sheet-images] loading a sheet picture failed', { projectId, fileId: id, err })
          setErrors((m) => new Map(m).set(id, err instanceof Error ? err.message : String(err)))
        })
    }
  }, [port, projectId, fileIds])

  const url = useCallback((fileId: string) => urls.get(fileId) ?? null, [urls])
  const source = useMemo<SheetImageSource>(
    () => ({
      load: async (fileId) => {
        if (!port) throw new EditorServiceUnavailableError(PICTURES)
        const link = urls.get(fileId) ?? (await signedUrl(port, projectId, fileId))
        const res = await port.bytes({ url: link })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return new Uint8Array(await res.arrayBuffer())
      },
    }),
    [port, projectId, urls],
  )
  const upload = useCallback(
    async (file: File) => {
      if (!port) return { error: unavailableWords('Adding pictures to the project') }
      const res = await port.upload({ projectId, file })
      const body = (await res.json().catch((err: unknown) => {
        console.error('[use-sheet-images] reading the upload reply failed', { err })
        return {}
      })) as { results?: Array<{ ok: boolean; id?: string; error?: string }>; error?: string }
      const first = body.results?.[0]
      if (!res.ok || !first?.ok || !first.id) {
        const error = first?.error ?? body.error ?? `The upload failed (HTTP ${res.status})`
        console.error('[use-sheet-images] uploading a sheet picture failed', { projectId, status: res.status, error })
        return { error: res.status === 403 ? "You can't add files to this project's workspace; ask a project lead." : error }
      }
      return { fileId: first.id }
    },
    [port, projectId],
  )
  return { url, errors, source, upload }
}
