import type { CreateLinkRequest, LinkCandidatesResponse, QuestionLinkView, QuestionLinksResponse } from "./links"
import type { EditorDataAnswer, EditorDataHost } from "@permitzip/bim-editor-host"
import { EditorServiceUnavailableError } from "@permitzip/bim-editor/host/unavailable"

type QuestionsPort = EditorDataHost["questions"]

function portOf(port: QuestionsPort): NonNullable<QuestionsPort> {
  if (!port) throw new EditorServiceUnavailableError("Questions")
  return port
}

async function readJson(res: EditorDataAnswer, what: string): Promise<unknown> {
  const body: unknown = await res.json().catch((err: unknown) => {
    console.error(`[questions/links] ${what}: unreadable response`, err)
    return null
  })
  if (!res.ok) {
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : `${what} failed (${res.status}).`
    throw new Error(message)
  }
  return body
}

export async function fetchQuestionLinksFrom(port: QuestionsPort, projectId: string, modelId: string, recordId: string): Promise<readonly QuestionLinkView[]> {
  const body = await readJson(await portOf(port).links({ projectId, modelId, recordId }), "Reading the links")
  return typeof body === "object" && body !== null && "links" in body && Array.isArray(body.links) ? (body as QuestionLinksResponse).links : []
}

export async function fetchLinkCandidatesFrom(port: QuestionsPort, projectId: string): Promise<LinkCandidatesResponse> {
  const body = await readJson(await portOf(port).linkCandidates({ projectId }), "Reading what can be linked")
  if (typeof body !== "object" || body === null || !("candidates" in body) || !Array.isArray(body.candidates)) throw new Error("What can be linked came back in a shape this page doesn't read. Refresh.")
  return body as LinkCandidatesResponse
}

export async function createQuestionLinkFrom(port: QuestionsPort, projectId: string, link: CreateLinkRequest): Promise<QuestionLinkView> {
  const body = await readJson(await portOf(port).createLink({ projectId, link }), "Linking")
  if (typeof body !== "object" || body === null || !("link" in body)) throw new Error("The link was saved but can't be shown. Refresh.")
  return (body as { link: QuestionLinkView }).link
}

export async function removeQuestionLinkFrom(port: QuestionsPort, projectId: string, linkId: string): Promise<void> {
  await readJson(await portOf(port).removeLink({ projectId, linkId }), "Removing the link")
}
