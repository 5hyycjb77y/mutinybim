import { z } from 'zod'
import {
  proposeProgressSchema,
  proposeStartedSchema,
  proposeStateSchema,
  type ProposeProgress,
  type ProposeStartBody,
  type ProposeStarted,
  type ProposeState,
} from '../../contracts/building-model/ifc-import/contract'
import type { EditorDataAnswer, EditorDataHost } from '@permitzip/bim-editor-host'
import { EditorServiceUnavailableError } from '@permitzip/bim-editor/host/unavailable'

/** Browser calls for Propose changes to this model (round 9 I9; the host's `ifcImport` port). Each throws an Error whose message is the route's own words. */

type ProposePort = EditorDataHost['ifcImport']

async function call<T>(port: ProposePort, request: (port: NonNullable<ProposePort>) => Promise<EditorDataAnswer>, schema: z.ZodType<T>, what: string): Promise<T> {
  if (!port) throw new EditorServiceUnavailableError('Proposing changes from a linked model')
  let res: EditorDataAnswer
  try {
    res = await request(port)
  } catch (err) {
    console.error(`[propose-api] ${what}: no answer`, err)
    throw new Error("The app didn't answer. Check your connection and try again.")
  }
  const body: unknown = await res.json().catch((err: unknown) => {
    console.error(`[propose-api] ${what}: the answer wasn't JSON`, { status: res.status, err })
    return null
  })
  if (!res.ok) {
    const message = z.object({ error: z.string() }).safeParse(body)
    throw new Error(message.success ? message.data.error : `${what} didn't work (${res.status}). Try again.`)
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    console.error(`[propose-api] ${what}: unexpected answer`, parsed.error.issues)
    throw new Error(`${what} came back in a shape this page doesn't read. Reload the page.`)
  }
  return parsed.data
}

export function fetchProposeStateFrom(port: ProposePort, projectId: string, referenceId: string, signal?: AbortSignal): Promise<ProposeState> {
  return call(port, (p) => p.state({ projectId, referenceId }, { ...(signal ? { signal } : {}) }), proposeStateSchema, 'Reading the agreement')
}

export function startProposalFrom(port: ProposePort, projectId: string, referenceId: string, body: ProposeStartBody): Promise<ProposeStarted> {
  return call(port, (p) => p.start({ projectId, referenceId, body }), proposeStartedSchema, 'Starting the proposal')
}

export function fetchProposalProgressFrom(port: ProposePort, projectId: string, referenceId: string, runId: string, jobId: string): Promise<ProposeProgress> {
  return call(port, (p) => p.progress({ projectId, referenceId, runId, jobId }), proposeProgressSchema, 'Checking on the proposal')
}

export function stopProposalFrom(port: ProposePort, projectId: string, referenceId: string, runId: string): Promise<{ ok: boolean }> {
  return call(port, (p) => p.stop({ projectId, referenceId, runId }), z.object({ ok: z.boolean() }), 'Stopping the proposal')
}
