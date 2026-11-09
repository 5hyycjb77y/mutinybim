import { divergencesIn, productChainOf, submittalsIn, SUBMITTAL_REVIEW_LABELS, SUBMITTAL_REVIEW_STATES, type ModelState, type SubmittalReviewState } from '@permitzip/bim-kernel'

export interface SubmittalItemRow {
  readonly id: string
  readonly label: string
  readonly state: SubmittalReviewState
  readonly stateLabel: string
  readonly reviewer: string | null
  readonly notes: string | null
  /** An approved substitution names this item. */
  readonly substituted: boolean
}

export interface SubmittalRow {
  readonly id: string
  readonly title: string
  readonly revision: string
  readonly submittedBy: string | null
  readonly state: SubmittalReviewState
  readonly stateLabel: string
  readonly about: string
  readonly items: readonly SubmittalItemRow[]
}

/** A review state in words; a workflow's own state reads from its id ("owner_review" → "Owner review"). */
export function reviewLabel(state: string): string {
  const known = SUBMITTAL_REVIEW_STATES.find((s) => s === state)
  if (known) return SUBMITTAL_REVIEW_LABELS[known]
  const words = state.replace(/_/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Other'
}

function aboutWords(model: ModelState, ids: readonly string[]): string {
  const names = ids.flatMap((id) => {
    const el = model.elements[id]
    if (!el) return []
    const mark = 'mark' in el && typeof el.mark === 'string' && el.mark.trim() ? el.mark.trim() : null
    const name = 'name' in el && typeof el.name === 'string' && el.name.trim() ? el.name.trim() : null
    return [mark ?? name ?? el.kind.replace(/_/g, ' ')]
  })
  const unique = [...new Set(names)]
  return unique.slice(0, 3).join(', ') + (unique.length > 3 ? ` and ${unique.length - 3} more` : '')
}

/** Every submittal in the model, newest id last, each item with its own review. */
export function submittalRows(model: ModelState): SubmittalRow[] {
  const substituted = new Set<string>()
  for (const d of divergencesIn(model.elements)) {
    const p = d.divergence.approvedProduct
    if (p.submittalId && p.itemId) substituted.add(`${p.submittalId}#${p.itemId}`)
  }
  return submittalsIn(model.elements)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) => {
      const b = s.submittal
      return {
        id: s.id,
        title: b.title,
        revision: b.revision,
        submittedBy: b.submittedBy ?? null,
        state: b.review.state,
        stateLabel: reviewLabel(b.review.state),
        about: aboutWords(model, [...(b.offeredFor.elementIds ?? []), ...(b.offeredFor.typeIds ?? [])]),
        items: b.items.map((i) => ({
          id: i.id,
          label: i.label,
          state: i.review?.state ?? 'pending',
          stateLabel: reviewLabel(i.review?.state ?? 'pending'),
          reviewer: i.review?.reviewer ?? null,
          notes: i.review?.notes ?? null,
          substituted: substituted.has(`${s.id}#${i.id}`),
        })),
      }
    })
}

/** What the Inspector's badge reads for one element, or null when no approved substitution names it (or its type). */
export function divergenceFor(model: ModelState, elementId: string): { readonly product: string; readonly approvedBy: string; readonly notes: string; readonly responsible: string | null } | null {
  const d = productChainOf(model.elements, elementId).divergences.at(-1)
  if (!d) return null
  const v = d.divergence
  return { product: v.approvedProduct.label, approvedBy: v.approvedBy, notes: v.notes, responsible: v.responsibleParty?.label ?? null }
}
