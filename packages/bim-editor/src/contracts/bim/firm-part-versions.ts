import { canonicalJson, definitionTypes, partGroupName, type PartTypeDefinition } from "@permitzip/bim-kernel"
import { partDefinitionHash, type PartTypeItem } from "@permitzip/bim-library"

/**
 * Firm part types as the part editor and a script's saved parts see them: the
 * item a drawn part publishes under, every size it places, and "a newer
 * version is in the library". No database here; the firm part store is in
 * `./firm-parts` (server side).
 */

export class FirmPartRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FirmPartRefusal"
  }
}

// ------------------------------------------------------------ part type publish (shared with scripts)

/**
 * The one publish path for part types (round 14, X14): the part editor's
 * Publish… and a script's saved parts both become revisioned `part_type`
 * items in the firm library (public.bim_library_items, through
 * HoursLibraryProvider on the person's own client). A drawn part is keyed by
 * its model id; a script's part by its type id, with provenance beside it.
 * Placing one copies a size's definition into the model; nothing points back
 * at the library, so "a newer version is in the library" is found by hash:
 * the placed definition matches an older revision's size.
 */

/** The item id a drawn (part editor) part publishes under. */
export function drawnPartItemId(modelId: string): string {
  return `part:${modelId}`
}

/** One size of a library part type, as it is placed in a model. */
export interface PartSize {
  readonly typeId: string
  readonly name: string
  readonly definition: PartTypeDefinition
}

/** Every size a part type item places: a part-editor model's types table, or the item's one type under its key (a script's part keeps the type id its script gave it, solid or not). */
export function partItemSizes(item: { readonly key: string; readonly definition: PartTypeDefinition }): PartSize[] {
  if (item.definition.model && item.definition.source.kind !== "script") return definitionTypes(item.definition).map((t) => ({ typeId: t.typeId, name: t.definition.typeName, definition: t.definition }))
  return [{ typeId: item.key, name: item.definition.typeName, definition: item.definition }]
}

/** One library part type with each revision's size hashes (for finding placed copies of older revisions). */
export interface LibraryPartTypeEntry {
  readonly id: string
  readonly scope: string
  readonly key: string
  readonly name: string
  readonly revision: number
  readonly definition: PartTypeDefinition
  readonly provenance: PartTypeItem["provenance"] | null
  /** Per revision, newest first: each size's type id → `partDefinitionHash` of what that revision places. */
  readonly revisions: readonly { readonly revision: number; readonly sizes: Readonly<Record<string, string>> }[]
}

export function sizeHashes(item: { readonly key: string; readonly definition: PartTypeDefinition }): Record<string, string> {
  return Object.fromEntries(partItemSizes(item).map((s) => [s.typeId, partDefinitionHash(s.definition)]))
}

/** A placed part type whose library item has a newer revision than the one it was placed from. */
export interface NewerPartVersion {
  readonly typeId: string
  readonly itemId: string
  readonly name: string
  readonly placedRevision: number
  readonly latestRevision: number
  readonly before: PartTypeDefinition
  readonly after: PartTypeDefinition
}

/**
 * Model part types that match an older revision of a library item, size for
 * size. A type that matches no revision (edited in this project, or not from
 * the library) is left alone: it isn't "older", it is different.
 */
export function newerLibraryVersions(modelTypes: readonly { readonly typeId: string; readonly definition: PartTypeDefinition }[], library: readonly LibraryPartTypeEntry[]): NewerPartVersion[] {
  const out: NewerPartVersion[] = []
  for (const t of modelTypes) {
    const hash = partDefinitionHash(t.definition)
    for (const entry of library) {
      const latest = partItemSizes(entry).find((s) => s.typeId === t.typeId)
      if (!latest) continue
      const placed = entry.revisions.find((r) => r.sizes[t.typeId] === hash)
      if (!placed || placed.revision >= entry.revision) continue
      if (partDefinitionHash(latest.definition) === hash) continue
      out.push({ typeId: t.typeId, itemId: entry.id, name: `${partGroupName(latest.definition)} ${latest.name}`, placedRevision: placed.revision, latestRevision: entry.revision, before: t.definition, after: latest.definition })
      break
    }
  }
  return out
}

function words(v: unknown): string {
  if (typeof v === "number") return String(Math.round(v * 1000) / 1000)
  if (typeof v === "string") return v === "" ? "(blank)" : v
  return JSON.stringify(v)
}

/** What changes from one placed definition to the next, in words: parameters, connectors, clearances. */
export function partUpdateDiff(before: PartTypeDefinition, after: PartTypeDefinition): { readonly parameters: string[]; readonly connectors: string[]; readonly clearances: string[]; readonly other: string[] } {
  const parameters: string[] = []
  const label = (name: string) => [...after.typeParams, ...before.typeParams].find((p) => p.name === name)?.label ?? name
  const names = new Set([...before.typeParams.map((p) => p.name), ...after.typeParams.map((p) => p.name)])
  for (const name of names) {
    const was = before.typeParams.some((p) => p.name === name)
    const now = after.typeParams.some((p) => p.name === name)
    if (!was) parameters.push(`${label(name)} added (${words(after.typeValues[name] ?? "no value")})`)
    else if (!now) parameters.push(`${label(name)} removed`)
    else if (canonicalJson(before.typeValues[name] ?? null) !== canonicalJson(after.typeValues[name] ?? null)) parameters.push(`${label(name)}: ${words(before.typeValues[name] ?? "no value")} → ${words(after.typeValues[name] ?? "no value")}`)
  }
  const connectors: string[] = []
  const was = new Map(before.connectors.map((c) => [c.id, c]))
  const now = new Map(after.connectors.map((c) => [c.id, c]))
  for (const [id, c] of now) {
    const old = was.get(id)
    if (!old) connectors.push(`${c.label} added (${c.domain}, ${c.shape})`)
    else if (canonicalJson(old) !== canonicalJson(c)) connectors.push(`${c.label} changed${old.shape !== c.shape ? ` (${old.shape} → ${c.shape})` : ""}${canonicalJson(old.position) !== canonicalJson(c.position) ? " (moves)" : ""}`)
  }
  for (const [id, c] of was) if (!now.has(id)) connectors.push(`${c.label} removed`)
  const clearances: string[] = []
  const cb = new Map((before.clearances ?? []).map((z) => [z.id, z]))
  const ca = new Map((after.clearances ?? []).map((z) => [z.id, z]))
  for (const [id, z] of ca) {
    const old = cb.get(id)
    if (!old) clearances.push(`${z.name} added (${z.face})`)
    else if (canonicalJson(old) !== canonicalJson(z)) clearances.push(`${z.name} changed`)
  }
  for (const [id, z] of cb) if (!ca.has(id)) clearances.push(`${z.name} removed`)
  const other: string[] = []
  if (canonicalJson(before.geometry) !== canonicalJson(after.geometry) || canonicalJson(before.model ?? null) !== canonicalJson(after.model ?? null)) other.push("Shape changed")
  if (before.typeName !== after.typeName) other.push(`Size name: ${before.typeName} → ${after.typeName}`)
  return { parameters, connectors, clearances, other }
}

/** The update as one model change (one undo step): the chosen sizes' new definitions in a single save. */
export function partUpdateCommand(chosen: readonly NewerPartVersion[], placedCopies: number): { readonly type: "save_part_types"; readonly label: string; readonly types: { typeId: string; definition: PartTypeDefinition }[] } {
  if (chosen.length === 0) throw new FirmPartRefusal("Choose at least one size to update")
  const first = chosen[0]
  const what = chosen.length === 1 && first ? `${first.name} to library revision ${first.latestRevision}` : `${chosen.length} part sizes to their newest library revision`
  return { type: "save_part_types", label: `Update ${what} (${placedCopies} placed cop${placedCopies === 1 ? "y" : "ies"})`.slice(0, 160), types: chosen.map((c) => ({ typeId: c.typeId, definition: c.after })) }
}
