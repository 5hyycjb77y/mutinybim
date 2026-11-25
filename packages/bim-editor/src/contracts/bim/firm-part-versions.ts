import { canonicalJson, definitionTypes, FormulaError, modelDims, partGroupName, resolveDim, typeSlug, type ModelState, type PartTypeDefinition } from "@permitzip/bim-kernel"
import { partDefinitionHash, type PartTypeItem } from "@permitzip/bim-library"
import type { EditorPartPublishRequest } from "@permitzip/bim-editor-host"

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

/** Only this request's receipt can acknowledge its saved or unchanged revision. */
export function confirmedPartPublish(request: EditorPartPublishRequest, body: unknown): { revision: number; upToDate: boolean } | null {
  if (!body || typeof body !== "object" || !("status" in body) || !("receipt" in body)) return null
  const { receipt } = body
  if (!receipt || typeof receipt !== "object" || !("requestId" in receipt) || receipt.requestId !== request.requestId ||
      !("baseRevision" in receipt) || receipt.baseRevision !== request.baseRevision || !("revision" in receipt)) return null
  const def = request.definition
  const model = def && typeof def === "object" && "model" in def ? def.model : null
  if (!model || typeof model !== "object" || !("id" in model) || typeof model.id !== "string" ||
      !("familyId" in receipt) || receipt.familyId !== drawnPartItemId(model.id)) return null
  const revision = receipt.revision
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision <= 0) return null
  if (body.status === "up_to_date" && "revision" in body && body.revision === revision && revision === request.baseRevision) return { revision, upToDate: true }
  const summary = "summary" in body ? body.summary : null
  if (body.status === "saved" && summary && typeof summary === "object" && "revision" in summary && summary.revision === revision && revision === request.baseRevision + 1) return { revision, upToDate: false }
  return null
}

/** A definite refusal from the local publish endpoint ends this intent. Other failures can be retried. */
export function isPartPublishRefusal(status: number): boolean {
  return [400, 409, 413, 415, 422].includes(status)
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

/** Start a recognized project copy at the revision it came from, including when the catalog opens later. */
export function draftBaseRevision(item: LibraryPartTypeEntry | undefined, initial: PartTypeDefinition | null): number {
  if (!item) return 0
  if (initial) {
    const hash = partDefinitionHash(initial)
    const match = item.revisions.find(revision => Object.values(revision.sizes).includes(hash))
    if (match) return match.revision
  }
  return item.revision
}

/** A drawn size already carries its row's effective values in typeValues. Keep the full table in the stored and applied definitions. */
function sizeForComparison(def: PartTypeDefinition): PartTypeDefinition {
  if (!def.model || def.source.kind === "script") return def
  return { ...def, model: { ...def.model, types: [] } }
}

/** A project can accept each size separately. Read its own saved row when opening another size's family table. */
export function projectFamilyTable(def: PartTypeDefinition, elements: ModelState["elements"], baseline?: PartTypeDefinition): PartTypeDefinition {
  const model = def.model
  if (!model || def.source.kind === "script") return def
  const before = new Map(baseline?.model?.types.map(row => [row.name, row.values]))
  const types = model.types.map(row => {
    // On save, retain rows the designer actually edited in this draft.
    if (baseline && canonicalJson(before.get(row.name) ?? null) !== canonicalJson(row.values)) return row
    const saved = elements[`${model.id}.${typeSlug(row.name)}`]
    if (saved?.kind !== "part_type" || saved.definition.model?.id !== model.id) return row
    const ownRow = saved.definition.model.types.find(r => r.name === saved.definition.typeName)
    return ownRow ? { ...row, values: ownRow.values } : row
  })
  return { ...def, model: { ...model, types } }
}

/** Save a family edit as one command. Unedited project sizes keep their individual revision and local changes. */
export function projectPartTypesToSave(def: PartTypeDefinition, baseline: PartTypeDefinition | null, elements: ModelState["elements"]) {
  const proposed = definitionTypes(def)
  if (!baseline?.model || !def.model || baseline.model.id !== def.model.id || def.source.kind === "script") return proposed
  const previous = new Map(definitionTypes(baseline).map(size => [size.typeId, size.definition]))
  const layoutChanged = canonicalJson(def.model.types.map(r => r.name)) !== canonicalJson(baseline.model.types.map(r => r.name))
  const rows = def.model.types
  const oldRows = baseline.model.types
  const rebased = definitionTypes(projectFamilyTable(def, elements, baseline))
  const effective = (size: PartTypeDefinition) => canonicalJson(sizeForComparison(size))
  return rebased.filter(({ typeId, definition }, index) => {
    const saved = elements[typeId]
    const before = previous.get(typeId)
    if (saved?.kind !== "part_type" || !before) return true
    const old = effective(before)
    if (!layoutChanged && effective(proposed[index]!.definition) === old
      && canonicalJson(rows[index]?.values ?? null) === canonicalJson(oldRows[index]?.values ?? null)) return false
    const current = effective(saved.definition)
    if (current !== old && current !== effective(definition)) {
      throw new Error(`${definition.typeName} changed in the project. Reopen the part editor to review its current definition before saving.`)
    }
    return true
  })
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
      if (canonicalJson(sizeForComparison(t.definition)) === canonicalJson(sizeForComparison(latest.definition))) continue
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

/** The inputs to the solid, including dimensions bound to this size, at every detail level. */
function modelShape(def: PartTypeDefinition) {
  const model = def.model
  if (!model) return null
  const dimensions = modelDims(model).map(dim => {
    try {
      return resolveDim(def, {}, dim)
    } catch (err) {
      if (err instanceof FormulaError) return { unresolved: err.message }
      throw err
    }
  })
  return {
    referencePlanes: model.referencePlanes, sketches: model.sketches,
    profiles: "profiles" in model ? model.profiles : undefined, features: model.features, dimensions,
  }
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
  if ((before.description ?? "") !== (after.description ?? "")) other.push(after.description ? `Description changed to “${after.description}”` : "Description removed")
  if (canonicalJson(before.geometry) !== canonicalJson(after.geometry) || canonicalJson(modelShape(before)) !== canonicalJson(modelShape(after))) other.push("Shape changed")
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
