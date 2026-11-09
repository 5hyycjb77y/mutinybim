'use client'

import { GitBranchPlus } from 'lucide-react'
import { DIVERGENCE_BADGE, type ModelState } from '@permitzip/bim-kernel'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { divergenceFor } from './submittal-rows'

/**
 * The Inspector's badge on an element an approved substitution names: "Approved
 * substitution: differs from the design. Design not changed." The design is
 * changed only on purpose, through a branch and its merge.
 */
export function DivergenceBadge({ model, elementId, canEdit, blockedReason, onUpdateDesign }: { readonly model: ModelState; readonly elementId: string; readonly canEdit: boolean; readonly blockedReason: string; readonly onUpdateDesign: () => void }) {
  const d = divergenceFor(model, elementId)
  if (!d) return null
  return (
    <Alert data-testid="divergence-badge">
      <AlertTitle>{DIVERGENCE_BADGE}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-2">
        <span>
          Approved: {d.product}, by {d.approvedBy}
          {d.notes ? `. ${d.notes}` : ''}
          {d.responsible ? `. Responsible for the difference: ${d.responsible}` : ''}
        </span>
        <Button size="sm" variant="outline" onClick={onUpdateDesign} disabled={!canEdit} title={canEdit ? 'Opens a branch; Main changes only when the branch is merged' : blockedReason} data-testid="divergence-update-design">
          <GitBranchPlus data-icon="inline-start" />
          Update design to match (opens a branch for review)
        </Button>
      </AlertDescription>
    </Alert>
  )
}
