import { fieldProviderRegistry, libraryRowsOf, type AddonLibraryRows, type Command, type ModelState, type ScheduleDefinitionV2 } from "@permitzip/bim-kernel"
import { validateScheduleDefinition } from "@permitzip/bim-kernel/schedules"

/**
 * Schedule templates add-ons bring (`kernel.library_rows`, section
 * `scheduleTemplates`), as Schedules › New schedule… lists them: the ones
 * whose add-on is on, ready to make, and the ones an add-on's UI data names
 * while that add-on is off, with where they come from. Names no add-on: a
 * first-party add-on and an outside one read the same way.
 */

/** What an add-on's UI data (`ADDON_UI`) says it brings, read while it is off. */
export interface AddonScheduleOffer {
  readonly addon: string
  readonly name: string
  readonly scheduleTemplates?: readonly { readonly key: string; readonly name: string }[]
}

export type AddonScheduleChoice =
  | { readonly kind: "available"; readonly id: string; readonly key: string; readonly name: string; readonly description: string | null; readonly addon: string; readonly definition: ScheduleDefinitionV2 }
  | { readonly kind: "off"; readonly key: string; readonly name: string; readonly addon: string; readonly why: string }

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === "object" && v !== null && !Array.isArray(v)

/** The row engine checks the rest when the schedule is made (`addonScheduleBlocked`). */
function isDefinition(v: unknown): v is ScheduleDefinitionV2 {
  return isRecord(v) && typeof v.name === "string" && isRecord(v.source) && Array.isArray(v.columns) && Array.isArray(v.filters) && Array.isArray(v.sort) && Array.isArray(v.groups) && isRecord(v.presentation) && isRecord(v.display)
}

/** Templates by add-on, available first in add-on order; then those named by an add-on that is off. */
export function addonScheduleTemplateChoices(groups: readonly AddonLibraryRows[] = libraryRowsOf(), offers: readonly AddonScheduleOffer[] = []): AddonScheduleChoice[] {
  const out: AddonScheduleChoice[] = []
  const on = new Set<string>()
  for (const group of groups) {
    on.add(group.packId)
    for (const row of group.rows) {
      if (row.section !== "scheduleTemplates") continue
      const { id, key, name, description, definition } = row.item
      if (typeof key !== "string" || typeof name !== "string" || !isDefinition(definition)) {
        console.error("[addon-schedule-templates] a schedule template row isn't a template; it is left out of New schedule", { addon: group.packId, id })
        continue
      }
      out.push({ kind: "available", id, key, name, description: typeof description === "string" ? description : null, addon: group.packId, definition })
    }
  }
  for (const offer of offers) {
    if (on.has(offer.addon)) continue
    for (const t of offer.scheduleTemplates ?? []) out.push({ kind: "off", key: t.key, name: t.name, addon: offer.addon, why: `Comes with the ${offer.name} add-on` })
  }
  return out
}

/** Why this template can't be made in this model, in words, or null. */
export function addonScheduleBlocked(model: ModelState | null, choice: AddonScheduleChoice): string | null {
  if (choice.kind === "off") return `${choice.why}, which isn't on for this model.`
  if (!model) return "The model is still loading."
  try {
    const problems = validateScheduleDefinition(model, choice.definition, { viewId: `addon-${choice.key}`, revision: model.revision, registry: fieldProviderRegistry() })
    const first = problems[0]
    return first ? `${choice.name} can't be made yet: ${first.message}` : null
  } catch (err) {
    console.error("[addon-schedule-templates] checking a template failed", { key: choice.key, err })
    return `${choice.name} can't be checked: ${err instanceof Error ? err.message : String(err)}`
  }
}

/** Make the schedule view (one undo step): the template's definition under the name typed. */
export function addonScheduleCommand(viewId: string, name: string, choice: Extract<AddonScheduleChoice, { kind: "available" }>): Command {
  return { type: "create_view", viewId, name: name.trim(), viewType: "schedule", props: { scheduleV2: { ...choice.definition, name: name.trim() } } }
}
