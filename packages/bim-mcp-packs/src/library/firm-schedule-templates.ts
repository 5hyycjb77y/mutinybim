import { builtinFormTemplate, formScheduleKindLabel, formScheduleKinds, formScheduleRow, formTemplateSchema, type FormScheduleKind, type FormTemplate } from "@permitzip/bim-kernel"
import { ensureFirstPartyAddOns } from "@permitzip/bim-editor/contracts/building-model/installed-packs"

/**
 * Firm schedule templates: the firm's own layouts for the form schedules the
 * add-ons make (panel, switchboard, feeder, connection type, equipment
 * connection…), one default per kind. A host keeps them wherever it keeps
 * firm data; a schedule on a sheet keeps its own copy of the template, so a
 * firm edit never rewrites a drawn sheet.
 */

export interface FirmScheduleTemplate {
  readonly kind: FormScheduleKind
  readonly name: string
  readonly template: FormTemplate
  readonly isDefault: boolean
  readonly revision: number
  readonly updatedAt: string
}

export interface SaveScheduleTemplateInput {
  readonly kind: FormScheduleKind
  readonly name: string
  /** Checked with formTemplateSchema before anything is written. */
  readonly template: unknown
  /** Make it the kind's firm default (the previous default stops being one). */
  readonly makeDefault?: boolean
}

export interface SavedScheduleTemplate {
  readonly status: "added" | "updated"
  readonly kind: FormScheduleKind
  readonly name: string
  readonly revision: number
  readonly isDefault: boolean
}

export interface FirmScheduleTemplatesStore {
  list(filter?: { readonly kind?: FormScheduleKind }): Promise<FirmScheduleTemplate[]>
  get(kind: FormScheduleKind, name: string): Promise<FirmScheduleTemplate | null>
  /** Add or replace the template with this kind and name. */
  save(input: SaveScheduleTemplateInput, userId: string): Promise<SavedScheduleTemplate>
}

export class FirmScheduleTemplateRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FirmScheduleTemplateRefusal"
  }
}


/** A template the firm library accepts for this kind, named as it is saved. Throws a plain-words refusal naming the bad field. */
export function scheduleTemplateChecks(kind: FormScheduleKind, name: string, template: unknown): FormTemplate {
  const trimmed = name.trim()
  if (trimmed.length < 1 || trimmed.length > 80) throw new FirmScheduleTemplateRefusal("A template name is 1 to 80 characters")
  const parsed = formTemplateSchema.safeParse(template && typeof template === "object" ? { ...template, name: trimmed } : template)
  if (!parsed.success) throw new FirmScheduleTemplateRefusal(`The template doesn't fit: ${parsed.error.issues.map((i) => `${i.path.join(".") || "template"} ${i.message}`).slice(0, 3).join("; ")}`)
  ensureFirstPartyAddOns()
  const row = formScheduleRow(kind)
  if (!row?.template) throw new FirmScheduleTemplateRefusal(`No add-on loaded here makes ${kind.replace(/_/g, " ")} schedules`)
  const label = formScheduleKindLabel(kind).toLowerCase()
  const slots = row.template.body.layout === "slots"
  if (slots && parsed.data.body.layout !== "slots") throw new FirmScheduleTemplateRefusal(`A ${label}'s body is the slot grid (body.layout "slots")`)
  if (!slots && parsed.data.body.layout === "slots") throw new FirmScheduleTemplateRefusal(`Only a kind whose built-in template is a slot grid has one; a ${label} lists rows (body.layout "rows")`)
  return parsed.data
}

/** In memory, for drills, tests and a local server. One default per kind, a template edit is the next revision. */
export function memoryFirmScheduleTemplatesStore(): FirmScheduleTemplatesStore & { readonly rows: Map<string, FirmScheduleTemplate> } {
  const rows = new Map<string, FirmScheduleTemplate>()
  const key = (kind: FormScheduleKind, name: string) => `${kind}\u0000${name.trim()}`
  return {
    rows,
    async list(filter) {
      return [...rows.values()].filter((t) => !filter?.kind || t.kind === filter.kind).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
    },
    async get(kind, name) {
      return rows.get(key(kind, name)) ?? null
    },
    async save(input) {
      const template = scheduleTemplateChecks(input.kind, input.name, input.template)
      const before = rows.get(key(input.kind, template.name))
      if (input.makeDefault) for (const [k, t] of rows) if (t.kind === input.kind && t.isDefault) rows.set(k, { ...t, isDefault: false })
      const changed = !before || JSON.stringify(before.template) !== JSON.stringify(template)
      const saved: FirmScheduleTemplate = {
        kind: input.kind,
        name: template.name,
        template,
        isDefault: Boolean(input.makeDefault) || (before?.isDefault ?? false),
        revision: before ? before.revision + (changed ? 1 : 0) : 1,
        updatedAt: new Date().toISOString(),
      }
      rows.set(key(input.kind, template.name), saved)
      return { status: before ? "updated" : "added", kind: saved.kind, name: saved.name, revision: saved.revision, isDefault: saved.isDefault }
    },
  }
}

/** Where the template a new schedule starts from came from. */
export interface ChosenScheduleTemplate {
  readonly template: FormTemplate
  readonly source: "firm" | "built_in"
  readonly name: string
  /** Firm templates: the revision copied, recorded on the schedule. */
  readonly revision?: number
}

/**
 * The template a new schedule of `kind` starts from: the named firm template,
 * else the firm default for the kind, else the built-in one. A name that
 * isn't in the firm library is refused (a typo must not silently fall back).
 */
export async function chooseScheduleTemplate(store: FirmScheduleTemplatesStore, kind: FormScheduleKind, name?: string): Promise<ChosenScheduleTemplate> {
  const builtin = builtinFormTemplate(kind)
  if (name) {
    if (name.trim().toLowerCase() === builtin.name.toLowerCase()) return { template: builtin, source: "built_in", name: builtin.name }
    const named = await store.get(kind, name)
    if (!named) {
      const known = (await store.list({ kind })).map((t) => `"${t.name}"`)
      throw new FirmScheduleTemplateRefusal(`No firm ${formScheduleKindLabel(kind).toLowerCase()} template "${name}". ${known.length > 0 ? `The firm has ${known.join(", ")}` : "The firm has none yet"}; the built-in one is "${builtin.name}"`)
    }
    return { template: named.template, source: "firm", name: named.name, revision: named.revision }
  }
  const firmDefault = (await store.list({ kind })).find((t) => t.isDefault)
  return firmDefault ? { template: firmDefault.template, source: "firm", name: firmDefault.name, revision: firmDefault.revision } : { template: builtin, source: "built_in", name: builtin.name }
}

/** The firm default's name for every kind (null: the built-in one is used). */
export function firmDefaultsByKind(templates: readonly FirmScheduleTemplate[]): Record<FormScheduleKind, string | null> {
  ensureFirstPartyAddOns()
  return Object.fromEntries(formScheduleKinds().map((k) => [k, templates.find((t) => t.kind === k && t.isDefault)?.name ?? null]))
}
