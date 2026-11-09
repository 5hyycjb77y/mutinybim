import { z } from "zod"
import type { Responsibility, ResponsibilityScope } from "@permitzip/bim-kernel"
import type { BimJson } from "../json"
import { MERGE_POLICY } from "./policy"

/**
 * The host's rows → the kernel's `Responsibility`. Person rows count only once
 * accepted (the kernel ignores a row with no `acceptedAt`); firm rows only
 * suggest (question 7), so they never reach coverage.
 */

const selector = z.array(z.string().trim().min(1).max(200)).max(200)

/** The stored scope: the kernel's selectors only (never a query language). Unknown keys are kept out. */
export const responsibilityScopeSchema = z
  .object({
    systems: selector.optional(),
    groups: selector.optional(),
    levels: selector.optional(),
    zones: z.array(z.object({ level: z.string().trim().min(1).max(200), zone: z.string().trim().min(1).max(200) }).strict()).max(200).optional(),
    sheets: selector.optional(),
    classes: selector.optional(),
    types: selector.optional(),
    where: z
      .array(
        z
          .object({
            path: z.string().trim().min(1).max(200),
            op: z.enum(["equals", "not_equals", "contains", "greater_than", "less_than", "present", "absent"]),
            value: z.string().max(400).optional(),
          })
          .strict(),
      )
      .max(50)
      .optional(),
  })
  .strip()

export type StoredScope = z.infer<typeof responsibilityScopeSchema>

/**
 * A stored scope read back: `undefined` for the whole discipline, `null` when
 * it is malformed (logged; the row then covers nothing, so it can never
 * approve more than the lead meant).
 */
export function readScope(raw: BimJson, rowId: string): ResponsibilityScope | undefined | null {
  const parsed = responsibilityScopeSchema.safeParse(raw)
  if (!parsed.success) {
    console.error("[bim/responsibilities] stored scope is not a selector set; the row covers nothing until it is fixed", { rowId, issue: parsed.error.issues[0]?.message })
    return null
  }
  const scope: ResponsibilityScope = parsed.data
  const listed = Object.values(scope).some((v) => Array.isArray(v) && v.length > 0)
  return listed ? scope : undefined
}

/** True when the stored scope names no selector: the whole discipline. */
export function isWholeDiscipline(raw: BimJson): boolean {
  const parsed = responsibilityScopeSchema.safeParse(raw)
  return !parsed.success || !Object.values(parsed.data).some((v) => Array.isArray(v) && v.length > 0)
}

// db-shape: the columns of a host's responsibility row this reader takes; the host checks them against its own database row
export type ResponsibilityRowForKernel = {
  readonly id: string
  readonly party_kind: string
  readonly person_id: string | null
  readonly organization_id: string | null
  readonly firm_entry_id: string | null
  readonly party_label: string
  readonly discipline: string
  readonly scope: BimJson
  readonly approval_rule: string
  readonly accepted_at: string | null
  readonly counts: boolean
}

/**
 * The kernel record for a row, or null when it can't count: a firm entry
 * (it only says whom to name), or a malformed scope. A person row is
 * accepted for the kernel only when it counts (accepted, and granted if it
 * was a request). People named from a firm entry approve as one set under
 * the entry's rule.
 */
export function toKernelResponsibility(row: ResponsibilityRowForKernel): Responsibility | null {
  if ((row.party_kind !== "person" || row.person_id === null) && !MERGE_POLICY.firmRowsApprove) return null
  const scope = readScope(row.scope, row.id)
  if (scope === null) return null
  const rule = row.approval_rule === "any_one" ? "any_one" : "each"
  return {
    id: row.id,
    party: { kind: row.party_kind === "firm" ? "firm" : "person", ref: row.person_id ?? row.organization_id ?? row.id, label: row.party_label },
    discipline: row.discipline,
    ...(scope ? { scope } : {}),
    ...(row.counts && row.accepted_at ? { acceptedAt: row.accepted_at } : {}),
    ...(row.firm_entry_id ? { approval: { group: row.firm_entry_id, rule } } : {}),
  }
}

/** Words for a scope when the lead didn't write their own ("Systems: sys-a; Levels: L1, L2"). */
export function scopeSummary(raw: BimJson, words: string | null): string {
  if (words && words.trim() !== "") return words.trim()
  const parsed = responsibilityScopeSchema.safeParse(raw)
  if (!parsed.success) return "All of it"
  const s = parsed.data
  const bits: string[] = []
  const list = (label: string, v: readonly string[] | undefined) => {
    if (v && v.length > 0) bits.push(`${label}: ${v.join(", ")}`)
  }
  list("Systems", s.systems)
  list("Groups", s.groups)
  list("Levels", s.levels)
  if (s.zones && s.zones.length > 0) bits.push(`Zones: ${s.zones.map((z) => `${z.level} ${z.zone}`).join(", ")}`)
  list("Sheets", s.sheets)
  list("Classes", s.classes)
  list("Types", s.types)
  if (s.where && s.where.length > 0) bits.push(`${s.where.length} field filter${s.where.length === 1 ? "" : "s"}`)
  return bits.length > 0 ? bits.join("; ") : "All of it"
}
