'use client'

import type { TitleBlockRow } from '@permitzip/bim-kernel'
import type { EditorDataAnswer, EditorDataHost } from '@permitzip/bim-editor-host'
import { EditorServiceUnavailableError } from '@permitzip/bim-editor/host/unavailable'

/** A title block from the firm library, as the sheet dialog and Settings list it. */
export interface TitleBlockChoice {
  readonly id: string
  readonly name: string
  readonly paperName: string
  readonly row: TitleBlockRow
  readonly isDefault: boolean
}

export interface TitleBlockList {
  readonly choices: readonly TitleBlockChoice[]
  readonly defaultId: string | null
  readonly canWrite: boolean
}

async function readError(res: EditorDataAnswer): Promise<string> {
  const body: unknown = await res.json().catch((err: unknown) => {
    console.error('[title-blocks-client] error body was not JSON', err)
    return null
  })
  return body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
}

type TitleBlocksPort = EditorDataHost['titleBlocks']
const TITLE_BLOCKS = 'The title block library'

export async function loadTitleBlocksFrom(port: TitleBlocksPort): Promise<TitleBlockList> {
  if (!port) throw new EditorServiceUnavailableError(TITLE_BLOCKS)
  const res = await port.list()
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as TitleBlockList
}

export async function makeDefaultTitleBlockFrom(port: TitleBlocksPort, id: string): Promise<void> {
  if (!port) throw new EditorServiceUnavailableError(TITLE_BLOCKS)
  const res = await port.makeDefault({ id })
  if (!res.ok) throw new Error(await readError(res))
}
