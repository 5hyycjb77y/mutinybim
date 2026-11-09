import { z } from "zod"
import {
  priceBookListResponse,
  priceBookSharesResponse,
  readablePriceBookResponse,
  shareTargetsResponse,
} from "./schemas"
import type { PriceBookInput, PriceBookRate } from "./types"
import type { EditorDataAnswer, EditorDataHost } from "@permitzip/bim-editor-host"
import { EditorServiceUnavailableError } from "@permitzip/bim-editor/host/unavailable"

/** The screens' calls to the host's price books (`costSource` port). Every failure throws an Error whose message a person can act on. */

type CostSourcePort = NonNullable<EditorDataHost["costSource"]>

async function request<S extends z.ZodType>(what: string, schema: S, send: () => Promise<EditorDataAnswer>): Promise<z.infer<S>> {
  const res = await send()
  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch (err) {
      console.error("[price-books] response wasn't JSON", { what, status: res.status, err })
      throw new Error(`The server answered with something that isn't data (HTTP ${res.status}). Try again.`)
    }
  }
  if (!res.ok) {
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : `HTTP ${res.status}`
    throw new Error(message)
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    console.error("[price-books] response didn't match", { what, issue: parsed.error.issues[0] })
    throw new Error("The server's answer wasn't what this screen expects. Reload the page.")
  }
  return parsed.data
}

const ok = z.unknown()

/** The price-book calls over a host's `costSource` port; without one, each call says price books aren't available here. */
export function priceBooksApiFrom(port: EditorDataHost["costSource"]) {
  const on = (): CostSourcePort => {
    if (!port) throw new EditorServiceUnavailableError("Price books")
    return port
  }
  return {
    list: (projectId: string | null) => request("price books", priceBookListResponse, () => on().list({ projectId })),
    read: (id: string, projectId: string | null) => request("price book", readablePriceBookResponse, () => on().read({ id, projectId })),
    create: (organizationId: string, input: PriceBookInput) => request("create price book", ok, () => on().create({ organizationId, input })),
    update: (id: string, input: PriceBookInput) => request("update price book", ok, () => on().update({ id, input })),
    remove: (id: string) => request("remove price book", ok, () => on().remove({ id })),
    replaceRates: (id: string, rates: readonly PriceBookRate[]) => request("price book rates", ok, () => on().replaceRates({ id, rates })),
    shares: (id: string) => request("price book shares", priceBookSharesResponse, () => on().shares({ id })),
    shareTargets: (id: string, projectId: string) => request("price book share targets", shareTargetsResponse, () => on().shareTargets({ id, projectId })),
    share: (id: string, organizationId: string, projectId: string) => request("share price book", ok, () => on().share({ id, organizationId, projectId })),
    unshare: (id: string, shareId: string) => request("unshare price book", ok, () => on().unshare({ id, shareId })),
  }
}
