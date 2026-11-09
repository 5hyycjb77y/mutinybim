'use client'

import { useState } from 'react'
import { MAX_TYPICAL_COPIES, typicalCapStatus, type ModelState } from '@permitzip/bim-kernel'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Field, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import type { SubmitCommand } from '../views-sheets/types'

interface Props {
  readonly model: ModelState
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly submit: SubmitCommand
}

/**
 * How many typical types the project has against what the contract covers
 * (STATUS decision 15: default 10, a model setting). Above the cap it is a
 * warning with the count to change; within it, one quiet line. Never blocks
 * making a typical.
 */
export function TypicalCapNotice({ model, canEdit, blockedReason, submit }: Props) {
  const status = typicalCapStatus(model)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(status.cap))
  const [error, setError] = useState<string | null>(null)
  if (status.count === 0 && !status.over) return null

  const n = Number(draft)
  const reason = !canEdit ? blockedReason : !Number.isInteger(n) || n < 1 || n > MAX_TYPICAL_COPIES ? `Type a whole number from 1 to ${MAX_TYPICAL_COPIES}.` : null
  const save = () => {
    if (reason || n === status.cap) {
      setEditing(false)
      return
    }
    const refusal = submit({ type: 'set_typical_cap', cap: n }, `set the contract's typicals to ${n}`)
    setError(refusal)
    if (!refusal) setEditing(false)
  }

  const form = (
    <form
      className="flex items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <Field className="w-40">
        <FieldLabel htmlFor="typical-cap">Contract covers</FieldLabel>
        <Input
          id="typical-cap"
          inputMode="numeric"
          value={draft}
          disabled={!canEdit}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              setDraft(String(status.cap))
              setEditing(false)
            }
          }}
          data-testid="typical-cap-input"
        />
      </Field>
      <Button type="submit" size="sm" disabled={reason !== null} title={reason ?? undefined} data-testid="typical-cap-save">
        Save
      </Button>
      {(reason ?? error) && <span className="text-xs text-muted-foreground" data-testid="typical-cap-reason">{error ?? reason}</span>}
    </form>
  )

  if (status.over) {
    return (
      <Alert variant="default" className="border-warning-300 bg-warning-50" data-testid="typical-cap-warning">
        <AlertTitle>{status.message}</AlertTitle>
        <AlertDescription className="flex flex-col gap-2">
          <span>Agree the extra {status.count - status.cap === 1 ? 'one' : 'ones'} with the client, or change the number the contract covers.</span>
          {form}
        </AlertDescription>
      </Alert>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" data-testid="typical-cap-line">
      <span>
        {status.count} of {status.cap} typicals the contract covers
      </span>
      {editing ? (
        form
      ) : (
        <Button variant="ghost" size="sm" disabled={!canEdit} title={canEdit ? 'Change how many typicals the contract covers' : blockedReason} onClick={() => setEditing(true)} data-testid="typical-cap-change">
          Change
        </Button>
      )}
    </div>
  )
}
