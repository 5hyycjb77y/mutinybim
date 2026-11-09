'use client'

import { useState } from 'react'
import { HostLink as Link } from '@permitzip/bim-editor/host'
import { ChevronDown, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import type { DesignLimit, DesignLimitLayer } from '@permitzip/bim-kernel/policy'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '../../ui/dropdown-menu'
import { Field, FieldDescription, FieldError, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import type { CapacityTargets } from './use-capacity-targets'

/** Where the firm's targets are edited (Library › Design limits). */
export const FIRM_DESIGN_LIMITS_HREF = '/settings/mutinybim-library'

/** A measured value against a design limit's minimum, with the line to print (an add-on's reading has this shape). */
export interface CapacityReading {
  readonly text: string
  readonly below: boolean
  readonly target: { readonly fraction: number; readonly layer: DesignLimitLayer; readonly limit: DesignLimit }
}

const LAYER_WORDS = { project: 'set for this project', firm: 'the firm’s target', addon: 'the default target' } as const

/**
 * One capacity line against its design limit: "Spare capacity: 31 % (target
 * 25 %)". Under the target it says "Below target" in words (amber is only a
 * second cue), and "Change target…" says whether a change is for this project
 * or for the firm.
 */
export function CapacityTargetLine({ reading, targets, canEdit, testId }: { readonly reading: CapacityReading; readonly targets?: CapacityTargets; readonly canEdit: boolean; readonly testId: string }) {
  const [editing, setEditing] = useState(false)
  const t = Math.round(reading.target.fraction * 100)
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={reading.below ? 'flex items-center gap-1 font-medium text-warning-700' : undefined} data-testid={`${testId}-text`}>
          {reading.below && <TriangleAlert aria-hidden className="size-3.5" />}
          {reading.text}
        </span>
        <span className="text-muted-foreground" data-testid={`${testId}-layer`}>
          {targets?.status === 'loading' ? 'Loading the firm’s and project’s targets…' : `${t} % is ${LAYER_WORDS[reading.target.layer]}.`}
        </span>
        {targets && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="link" size="sm" className="h-auto p-0 text-xs" data-testid={`${testId}-change`}>
                Change target…
                <ChevronDown data-icon="inline-end" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Change the {reading.target.limit.label.toLowerCase()} target</DropdownMenuLabel>
              <DropdownMenuGroup>
                <DropdownMenuItem disabled={!canEdit || targets.status !== 'ready'} onSelect={() => setEditing(true)} data-testid={`${testId}-change-project`}>
                  {canEdit ? 'For this project only…' : 'For this project only (needs edit access to this model)'}
                </DropdownMenuItem>
                <DropdownMenuItem asChild data-testid={`${testId}-change-firm`}>
                  <Link href={FIRM_DESIGN_LIMITS_HREF}>For the firm, every project (Library › Design limits)</Link>
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {targets?.problem && (
        <span className="text-danger-600" role="alert">
          {targets.problem}
        </span>
      )}
      {targets && editing && <ProjectTargetDialog reading={reading} targets={targets} onClose={() => setEditing(false)} testId={testId} />}
    </div>
  )
}

function ProjectTargetDialog({ reading, targets, onClose, testId }: { readonly reading: CapacityReading; readonly targets: CapacityTargets; readonly onClose: () => void; readonly testId: string }) {
  const [value, setValue] = useState(String(Math.round(reading.target.fraction * 100)))
  const [problem, setProblem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const label = reading.target.limit.label
  const save = async () => {
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      setProblem('Enter a percentage from 0 to 100.')
      return
    }
    setSaving(true)
    const outcome = await targets.setProjectMinimum(reading.target.limit, n)
    setSaving(false)
    if (!outcome.ok) {
      setProblem(outcome.message)
      return
    }
    toast.success(`${label}: ${n} % for this project. The firm’s target is unchanged.`)
    onClose()
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid={`${testId}-dialog`}>
        <DialogHeader>
          <DialogTitle>{label} for this project</DialogTitle>
          <DialogDescription>This project only. Other projects keep the firm’s target; change that in Library › Design limits.</DialogDescription>
        </DialogHeader>
        <Field data-invalid={problem !== null}>
          <FieldLabel htmlFor={`${testId}-target`}>Target (%)</FieldLabel>
          <Input id={`${testId}-target`} type="number" min={0} max={100} value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={problem !== null} />
          <FieldDescription>Now {Math.round(reading.target.fraction * 100)} % ({LAYER_WORDS[reading.target.layer]}).</FieldDescription>
          {problem && <FieldError>{problem}</FieldError>}
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving} data-testid={`${testId}-save`}>
            {saving ? 'Saving…' : 'Save for this project'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
