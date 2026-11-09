'use client'

import type { SheetRevision } from '@permitzip/bim-kernel'
import type { ReissueCheck } from '@permitzip/bim-sheets'
import type { EditorDataAnswer, EditorDataHost } from '@permitzip/bim-editor-host'
import { EditorServiceUnavailableError } from '@permitzip/bim-editor/host/unavailable'
import type { IssueCheckResult, IssueSetResult, PrintSetResult, SetHistory } from '../../contracts/bim/drawing-set-results'

/**
 * The browser's side of Print set and Issue set: the Building Model asks the
 * host's server, which prints and issues through the same path as the agent's
 * tools.
 */

export interface SetStatus {
  readonly check: IssueCheckResult
  readonly history: SetHistory
  /** Round 10 C10: approvals on these sheets checked against an older rule (absent from an older server). */
  readonly codeCheck?: ReissueCheck
}

async function answer<T>(res: EditorDataAnswer, doing: string): Promise<T> {
  const body: unknown = await res.json().catch((err: unknown) => {
    console.error(`[drawing-set-client] ${doing}: the answer wasn't readable`, err)
    return null
  })
  if (!res.ok) {
    const said = body && typeof body === 'object' ? ((body as { error?: unknown; detail?: unknown }).detail ?? (body as { error?: unknown }).error) : null
    throw new Error(typeof said === 'string' && said ? said : `${doing} failed (HTTP ${res.status}). Try again.`)
  }
  if (body === null) throw new Error(`${doing}: the server's answer couldn't be read. Try again.`)
  return body as T
}

type DrawingSetsPort = EditorDataHost['drawingSets']

function portOf(port: DrawingSetsPort): NonNullable<DrawingSetsPort> {
  if (!port) throw new EditorServiceUnavailableError('Printing and issuing sets')
  return port
}

export async function fetchSetStatusFrom(port: DrawingSetsPort, projectId: string, modelId: string, sheets?: readonly string[]): Promise<SetStatus> {
  return answer<SetStatus>(await portOf(port).status({ projectId, modelId, ...(sheets ? { sheets } : {}) }), 'Checking the set')
}

export async function printSetFrom(port: DrawingSetsPort, projectId: string, modelId: string, input: { sheets?: readonly string[]; title?: string }): Promise<PrintSetResult> {
  const res = await portOf(port).print({ projectId, modelId, input })
  return answer<PrintSetResult>(res, 'Printing the set')
}

export async function issueSetFrom(
  port: DrawingSetsPort,
  projectId: string,
  modelId: string,
  input: { name: string; expectedRevision: number; sheets?: readonly string[]; addRevision?: SheetRevision; acceptChangesSincePrint?: boolean },
): Promise<IssueSetResult> {
  const res = await portOf(port).issue({ projectId, modelId, input })
  return answer<IssueSetResult>(res, 'Issuing the set')
}
