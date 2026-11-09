import type { BimElement, ChangeOrderStatus, ChangeTarget } from "@permitzip/bim-kernel"
import type { AddresseeSearchResponse, ChangeOrderDetailResponse, ChangeOrdersForMeResponse, ChangeOrdersResponse, ChangeSignificanceResponse } from "./model"
import type { EditorDataAnswer, EditorDataHost } from "@permitzip/bim-editor-host"
import { EditorServiceUnavailableError } from "@permitzip/bim-editor/host/unavailable"

/**
 * Browser calls for "What kind of change was this?" and Manage › Change
 * orders. Every failure throws an Error with the server's words, so screens
 * show it (with Retry) instead of a blank pane. No price is ever sent.
 */

type ChangeOrdersPort = EditorDataHost["changeOrders"]

async function call<T>(port: ChangeOrdersPort, send: (port: NonNullable<ChangeOrdersPort>) => Promise<EditorDataAnswer>, what: string): Promise<T> {
  if (!port) throw new EditorServiceUnavailableError("Change orders")
  let res: EditorDataAnswer
  try {
    res = await send(port)
  } catch (err) {
    console.error(`[bim/change-orders] ${what} unreachable`, err)
    throw new Error(`Couldn't reach the app to ${what}. Check your connection and try again.`)
  }
  const body: unknown = await res.json().catch((err: unknown) => {
    console.error(`[bim/change-orders] ${what} answered without JSON`, { status: res.status, err })
    return null
  })
  if (!res.ok) {
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : `Couldn't ${what} (error ${res.status}).`
    console.error(`[bim/change-orders] ${what} refused`, { status: res.status, message })
    throw new Error(message)
  }
  return body as T
}

/** The wire form of a target: the model is the project's, so it isn't sent. */
function targetBody(target: ChangeTarget) {
  return target.kind === "version_range" ? { kind: target.kind, fromRevision: target.fromRevision, toRevision: target.toRevision } : { kind: target.kind, branchId: target.branchId, branchHead: target.branchHead }
}

export function fetchChangeSignificanceFrom(port: ChangeOrdersPort, projectId: string, signal?: AbortSignal): Promise<ChangeSignificanceResponse> {
  return call(port, (p) => p.significance({ projectId }, { signal }), "load what kind of changes these were")
}

export function classifyChangeFrom(
  port: ChangeOrdersPort,
  projectId: string,
  input: { target: ChangeTarget; kind: string; reason: string; citation?: string; responsibilityId: string; deltaDigest?: string; elements: readonly BimElement[]; /** C10: what the classification was checked against (kernel `writeCheckingContext`). */ checkingContext?: unknown },
): Promise<{ id: string; targetKey: string; kind: string }> {
  const { target, ...rest } = input
  return call(port, (p) => p.classify({ projectId, body: { ...rest, target: targetBody(target) } }), "save what kind of change this was")
}

export function fetchChangeOrdersFrom(port: ChangeOrdersPort, projectId: string, signal?: AbortSignal): Promise<ChangeOrdersResponse> {
  return call(port, (p) => p.list({ projectId }, { signal }), "load change orders")
}

export function fetchChangeOrderFrom(port: ChangeOrdersPort, projectId: string, id: string, signal?: AbortSignal): Promise<ChangeOrderDetailResponse> {
  return call(port, (p) => p.read({ projectId, id }, { signal }), "load the change order")
}

export function openChangeOrderFrom(
  port: ChangeOrdersPort,
  projectId: string,
  input: { target: ChangeTarget; title: string; description?: string; addressee: { kind: "contact" | "organization"; id: string }; deltaDigest?: string },
): Promise<{ id: string }> {
  const { target, ...rest } = input
  return call(port, (p) => p.open({ projectId, body: { ...rest, target: targetBody(target) } }), "open the change order")
}

export function setChangeOrderStatusFrom(
  port: ChangeOrdersPort,
  projectId: string,
  id: string,
  input: { status: Exclude<ChangeOrderStatus, "draft">; reason?: string; citation?: string; deltaDigest?: string },
): Promise<{ id: string; status: string }> {
  return call(port, (p) => p.setStatus({ projectId, id, input }), "update the change order")
}

export function searchAddresseesFrom(port: ChangeOrdersPort, projectId: string, q: string, signal?: AbortSignal): Promise<AddresseeSearchResponse> {
  return call(port, (p) => p.searchAddressees({ projectId, q }, { signal }), "search the contact list")
}

/**
 * The existing portal invite (Settings › Clients uses the same call): the contact gets a login to
 * this project. For a CRM contact, the invite then records which contact it was for, so their login
 * answers change orders by that link, not by matching an email address.
 */
export async function inviteAddresseeFrom(port: ChangeOrdersPort, projectId: string, email: string, contactId: string | null = null): Promise<{ id: string }> {
  const invited = await call<{ id: string }>(port, (p) => p.invite({ projectId, email }), "send the invite")
  if (contactId) await call(port, (p) => p.linkInvite({ projectId, accessId: invited.id, contactId }), "link the invite to the contact")
  return invited
}

/** The sent change orders waiting on you, on every project (the bell and the Change order page). */
export function fetchChangeOrdersForMeFrom(port: ChangeOrdersPort, signal?: AbortSignal): Promise<ChangeOrdersForMeResponse> {
  return call(port, (p) => p.forMe({ signal }), "load the change orders waiting for you")
}
