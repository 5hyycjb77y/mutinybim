import { z } from "zod"
import { QUESTION_READER_REASONS, type ForwardCandidate, type SharedWithMe, type ThreadReader } from "./contract"
import type { SharedQuestionThread, SharedThreadEntry } from "./shared-thread"
import type { EditorDataAnswer, EditorDataHost } from "@permitzip/bim-editor-host"
import { EditorServiceUnavailableError } from "@permitzip/bim-editor/host/unavailable"

/**
 * Round 10 question follow-ups: the request shapes the routes accept and the
 * browser helpers that call them (forward candidates, readers of one thread,
 * threads shared with me). Every helper throws the route's words on failure
 * so the screen can show them with a Retry.
 */

const ID = /^[A-Za-z0-9._:~-]{1,200}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const entrySchema: z.ZodType<SharedThreadEntry> = z.object({ at: z.string().max(64), who: z.string().max(200), act: z.string().max(400), text: z.string().max(4000), stale: z.string().max(400).optional() }).strict()

export const sharedThreadSchema: z.ZodType<SharedQuestionThread> = z
  .object({
    v: z.literal(1),
    number: z.string().trim().min(1).max(20),
    text: z.string().max(1000),
    askOf: z.string().max(60),
    status: z.string().max(60),
    askedBy: z.string().max(200).nullable(),
    carriedBy: z.string().max(200).nullable(),
    entries: z.array(entrySchema).max(500),
  })
  .strict()

const where = { modelId: z.string().regex(ID, "Say which model."), questionId: z.string().regex(ID, "Say which question.") }

export const grantReaderSchema = z
  .object({
    ...where,
    reason: z.enum(QUESTION_READER_REASONS),
    thread: sharedThreadSchema,
    readerUserId: z.string().regex(UUID, "Pick a person on this project.").optional(),
    readerEmail: z.string().trim().email("Give their email, e.g. name@company.com.").max(320).optional(),
  })
  .strict()
  .refine((v) => (v.readerUserId === undefined) !== (v.readerEmail === undefined), { message: "Say who keeps reading it: one person, or one email." })

export type GrantReaderRequest = z.infer<typeof grantReaderSchema>

export const refreshThreadSchema = z.object({ ...where, thread: sharedThreadSchema }).strict()

export interface ForwardCandidatesResponse {
  readonly people: readonly ForwardCandidate[]
}

export interface ThreadReadersResponse {
  readonly readers: readonly ThreadReader[]
}

export interface SharedWithMeResponse {
  readonly threads: readonly SharedWithMe[]
}

type QuestionsPort = EditorDataHost["questions"]

function portOf(port: QuestionsPort): NonNullable<QuestionsPort> {
  if (!port) throw new EditorServiceUnavailableError("Sharing questions")
  return port
}

async function readJson(res: EditorDataAnswer, fallback: string): Promise<unknown> {
  const body: unknown = await res.json().catch((err: unknown) => {
    console.error("[questions/readers] response body unreadable", { status: res.status, err })
    return null
  })
  if (!res.ok) {
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : `${fallback} (${res.status}).`
    throw new Error(message)
  }
  return body
}

function hasArray<K extends string>(v: unknown, key: K): v is Record<K, unknown[]> {
  return typeof v === "object" && v !== null && key in v && Array.isArray((v as Record<string, unknown>)[key])
}

/** People this question can be forwarded to (the project's real access sources). */
export async function fetchForwardCandidatesFrom(port: QuestionsPort, projectId: string): Promise<readonly ForwardCandidate[]> {
  const body = await readJson(await portOf(port).people({ projectId }), "The project's people didn't load")
  if (!hasArray(body, "people")) throw new Error("The project's people came back in a shape this page doesn't read. Refresh.")
  return body.people as ForwardCandidate[]
}

export async function fetchThreadReadersFrom(port: QuestionsPort, projectId: string, modelId: string, questionId: string): Promise<readonly ThreadReader[]> {
  const body = await readJson(await portOf(port).readers({ projectId, modelId, questionId }), "Who this is shared with didn't load")
  if (!hasArray(body, "readers")) throw new Error("Who this is shared with came back in a shape this page doesn't read. Refresh.")
  return body.readers as ThreadReader[]
}

export async function postThreadReaderFrom(port: QuestionsPort, projectId: string, request: GrantReaderRequest): Promise<{ readonly name: string; readonly created: boolean }> {
  const body = await readJson(await portOf(port).addReader({ projectId, request }), "The conversation wasn't shared")
  const name = typeof body === "object" && body !== null && "name" in body && typeof body.name === "string" ? body.name : "them"
  const created = typeof body === "object" && body !== null && "created" in body && body.created === true
  return { name, created }
}

export async function deleteThreadReaderFrom(port: QuestionsPort, projectId: string, readerId: string): Promise<void> {
  await readJson(await portOf(port).removeReader({ projectId, readerId }), "Sharing didn't stop")
}

export async function putSharedThreadCopyFrom(port: QuestionsPort, projectId: string, request: z.infer<typeof refreshThreadSchema>): Promise<void> {
  await readJson(await portOf(port).refreshCopy({ projectId, request }), "The shared copy wasn't brought up to date")
}

export async function fetchSharedWithMeFrom(port: QuestionsPort): Promise<readonly SharedWithMe[]> {
  const body = await readJson(await portOf(port).sharedWithMe(), "Questions shared with you didn't load")
  if (!hasArray(body, "threads")) throw new Error("Questions shared with you came back in a shape this page doesn't read. Refresh.")
  return body.threads as SharedWithMe[]
}
