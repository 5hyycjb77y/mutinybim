'use client'

import { organizationOf, type ModelState } from '@permitzip/bim-kernel'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import type { SubmitCommand } from '../views-sheets/types'
import { MANAGE_PATH } from './labels'

interface Props {
  readonly model: ModelState | null
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly submit: SubmitCommand
  readonly onRefused: (message: string) => void
}

/** Bottom strip: which group new work goes in and which phase it is built in, switchable in one click. */
export function OrganizationStatusBar({ model, canEdit, blockedReason, submit, onRefused }: Props) {
  if (!model) return null
  const org = organizationOf(model)
  const group = org.groupById.get(org.activeGroupId)
  const phase = org.phases.find((p) => p.id === org.activePhaseId)
  const send = (refusal: string | null) => {
    if (refusal) onRefused(refusal)
  }
  return (
    <div className="flex h-9 shrink-0 items-center gap-4 border-t bg-background px-3 text-xs" role="status" aria-label="Active group and phase" data-testid="organization-status-bar">
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">New work goes in</span>
            <Select
              value={org.activeGroupId}
              disabled={!canEdit}
              onValueChange={(id) => send(submit({ type: 'set_active_group', groupId: id }, `make ${org.groupById.get(id)?.entry.name ?? 'that group'} active`))}
            >
              <SelectTrigger size="sm" className="h-7 gap-1.5 text-xs" aria-label="Active group" data-testid="active-group">
                <span aria-hidden className="size-2.5 rounded-full border" style={{ backgroundColor: group?.entry.color }} />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {org.groups.map((g) => (
                    <SelectItem key={g.id} value={g.id} disabled={g.entry.locked}>
                      {g.entry.name}
                      {g.entry.locked ? ' (locked)' : ''}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </TooltipTrigger>
        <TooltipContent>{canEdit ? `New ducts, pipes and parts go in this group. Edit groups in ${MANAGE_PATH}.` : blockedReason}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">built in</span>
            <Select
              value={org.activePhaseId}
              disabled={!canEdit}
              onValueChange={(id) => send(submit({ type: 'set_active_phase', phaseId: id }, `work in ${org.phases.find((p) => p.id === id)?.entry.name ?? 'that phase'}`))}
            >
              <SelectTrigger size="sm" className="h-7 text-xs" aria-label="Active phase" data-testid="active-phase">
                <SelectValue placeholder={phase?.entry.name} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {org.phases.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.entry.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </TooltipTrigger>
        <TooltipContent>{canEdit ? 'New elements are created in this phase; Demolish removes them in it.' : blockedReason}</TooltipContent>
      </Tooltip>
    </div>
  )
}
