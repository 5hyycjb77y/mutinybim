'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import type { PackSet } from '@permitzip/bim-kernel/packs'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { FieldGroup } from '../../ui/field'
import { Spinner } from '../../ui/spinner'
import { disciplinesOf, type LinkedDiscipline, type LinkedReferenceView } from '../../contracts/building-model/linked-contract'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { updateLinkedReferenceFrom } from '../linked-api'
import { LinkedContributorFields, LinkedDisciplinesField } from './LinkedDisciplinesField'

/**
 * Linked models › a model › What it shows and who sent it…: the disciplines
 * the model carries and the company and contact who contributed it. Saved for
 * everyone on the project.
 */
export function LinkedIdentityDialog({
  projectId,
  reference,
  set,
  onClose,
  onSaved,
}: {
  readonly projectId: string
  readonly reference: LinkedReferenceView | null
  readonly set?: PackSet
  readonly onClose: () => void
  readonly onSaved: () => void
}) {
  return (
    <Dialog open={reference !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="linked-identity-dialog">
        {reference && <IdentityForm key={reference.id} projectId={projectId} reference={reference} set={set} onClose={onClose} onSaved={onSaved} />}
      </DialogContent>
    </Dialog>
  )
}

function IdentityForm({ projectId, reference, set, onClose, onSaved }: { readonly projectId: string; readonly reference: LinkedReferenceView; readonly set?: PackSet; readonly onClose: () => void; readonly onSaved: () => void }) {
  const linked = useEditorHost().data.linkedModels
  const [disciplines, setDisciplines] = useState<readonly LinkedDiscipline[]>(disciplinesOf(reference))
  const [contributor, setContributor] = useState({ organization: reference.contributor?.organization ?? '', contact: reference.contributor?.contact ?? '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await updateLinkedReferenceFrom(linked, projectId, reference.id, { disciplines, contributor: { organization: contributor.organization.trim(), contact: contributor.contact.trim() } })
      toast.success(`Saved what ${reference.label} shows.`)
      onSaved()
      onClose()
    } catch (err) {
      console.error('[LinkedIdentityDialog] saving the disciplines failed', { referenceId: reference.id, err })
      setError(err instanceof Error ? err.message : "That wasn't saved.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>What {reference.label} shows</DialogTitle>
        <DialogDescription>The disciplines in this linked model and who contributed it. Everyone on the project sees the change.</DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <LinkedDisciplinesField id="linked-identity-discipline" value={disciplines} onChange={setDisciplines} set={set} disabled={saving} />
        <LinkedContributorFields id="linked-identity-contributor" organization={contributor.organization} contact={contributor.contact} onChange={setContributor} disabled={saving} />
      </FieldGroup>
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Not saved</AlertTitle>
          <AlertDescription>{error} Try again, or press Cancel to keep it as it was.</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => void save()} disabled={saving} data-testid="linked-identity-save">
          {saving && <Spinner data-icon="inline-start" />}
          {error ? 'Try again' : 'Save'}
        </Button>
      </DialogFooter>
    </>
  )
}
