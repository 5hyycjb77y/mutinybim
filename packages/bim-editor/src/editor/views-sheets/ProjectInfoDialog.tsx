'use client'

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { PROJECT_PARAMETER_GROUPS, projectParametersOf, type ModelState, type ProjectParameterGroup } from '@permitzip/bim-kernel'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../../ui/field'
import { ParameterInput } from './ParameterInput'
import type { SubmitCommand } from './types'

const GROUP_TITLE: Record<ProjectParameterGroup, string> = { project: 'Project', people: 'People', issue: 'Issue' }

/** What the host fills in when the project states nothing (its own name and number). */
export interface HostProjectFacts {
  readonly projectName?: string
  readonly projectNumber?: string
}

/**
 * Sheets › Project info: the facts every sheet's title block prints, stated
 * once for the project (name, number, address, people, issue date, status).
 * A sheet's own value still wins (Sheets › Title block). One save is one
 * edit, so Undo takes it back.
 */
export function ProjectInfoDialog({ model, host, canEdit, blockedReason, submit, onClose }: { model: ModelState; host: HostProjectFacts; canEdit: boolean; blockedReason: string; submit: SubmitCommand; onClose: () => void }) {
  const params = useMemo(() => projectParametersOf(model), [model])
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...params.values }))
  const [error, setError] = useState<string | null>(null)
  const changed = params.defs.filter((d) => (values[d.key] ?? '') !== (params.values[d.key] ?? ''))
  const hostFallback: Record<string, string | undefined> = { project_name: host.projectName, project_number: host.projectNumber }

  const save = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canEdit) {
      setError(blockedReason)
      return
    }
    if (changed.length === 0) {
      onClose()
      return
    }
    const refusal = submit({ type: 'set_project_parameters', values: Object.fromEntries(changed.map((d) => [d.key, values[d.key]?.trim() ? (values[d.key] ?? '') : null])) }, 'update the project information')
    if (refusal) {
      setError(refusal)
      return
    }
    toast.success(`Project information saved: every sheet shows ${changed.length === 1 ? 'the change' : `the ${changed.length} changes`}.`)
    onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" data-testid="project-info-dialog">
        <form onSubmit={save} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Project information</DialogTitle>
            <DialogDescription>Filled in once, printed in every sheet&apos;s title block. A sheet can still say something else in its own Title block.</DialogDescription>
          </DialogHeader>
          {PROJECT_PARAMETER_GROUPS.map((group) => {
            const defs = params.defs.filter((d) => d.group === group)
            if (defs.length === 0) return null
            return (
              <FieldSet key={group}>
                <FieldLegend>{GROUP_TITLE[group]}</FieldLegend>
                <FieldGroup className="grid grid-cols-2 gap-3">
                  {defs.map((d) => (
                    <Field key={d.key}>
                      <FieldLabel htmlFor={`pi-${d.key}`}>{d.label}</FieldLabel>
                      <ParameterInput def={d} id={`pi-${d.key}`} value={values[d.key] ?? ''} fallback={hostFallback[d.key]} disabled={!canEdit} onChange={(v) => setValues((prev) => ({ ...prev, [d.key]: v }))} />
                      {d.hint && <FieldDescription>{d.hint}</FieldDescription>}
                    </Field>
                  ))}
                </FieldGroup>
              </FieldSet>
            )
          })}
          {!canEdit && <FieldDescription>{blockedReason}</FieldDescription>}
          {error && <FieldError>{error}</FieldError>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canEdit} data-testid="project-info-save">
              {changed.length > 1 ? `Save ${changed.length} changes` : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
