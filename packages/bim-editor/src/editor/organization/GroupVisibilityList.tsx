'use client'

import { Contrast, Eye, EyeOff, Lock } from 'lucide-react'
import { GROUP_VISIBILITIES, organizationOf, type GroupVisibility, type ModelState } from '@permitzip/bim-kernel'
import { Field, FieldContent, FieldDescription, FieldLabel } from '../../ui/field'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { GROUP_VISIBILITY_LABEL } from './labels'

const ICON = { show: Eye, halftone: Contrast, hide: EyeOff } as const

interface Props {
  readonly model: ModelState
  /** Per group: what the open view (or the free 3D model) uses. */
  readonly visibility: (groupId: string) => GroupVisibility
  /** Null when saved; otherwise the plain reason it wasn't. */
  readonly onChange: (groupId: string, visibility: GroupVisibility) => string | null
  /** Why the toggles are read-only (a saved view you can't edit), or null. */
  readonly blockedReason: string | null
  /** "this view" or "the 3D model". */
  readonly scope: string
}

/** The model's groups with show / halftone / hide for what is open. */
export function GroupVisibilityList({ model, visibility, onChange, blockedReason, scope }: Props) {
  const org = organizationOf(model)
  return (
    <div className="flex flex-col gap-2" data-testid="group-visibility">
      {org.groups.map((g) => {
        const value = visibility(g.id)
        return (
          <Field key={g.id} orientation="horizontal" className="items-center justify-between gap-2" data-testid={`group-visibility-${g.id}`}>
            <FieldContent className="min-w-0">
              <FieldLabel className="min-w-0 font-normal">
                <span aria-hidden className="size-2.5 shrink-0 rounded-full border" style={{ backgroundColor: g.entry.color }} />
                <span className="truncate">{g.entry.name}</span>
                {g.entry.locked && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="Locked" />
                    </TooltipTrigger>
                    <TooltipContent>Locked: its elements can&apos;t be changed until someone unlocks it</TooltipContent>
                  </Tooltip>
                )}
              </FieldLabel>
            </FieldContent>
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              value={value}
              disabled={blockedReason !== null}
              aria-label={`How ${g.entry.name} shows in ${scope}`}
              onValueChange={(v) => {
                const next = GROUP_VISIBILITIES.find((x) => x === v)
                if (next && next !== value) onChange(g.id, next)
              }}
            >
              {GROUP_VISIBILITIES.map((v) => {
                const Icon = ICON[v]
                return (
                  <Tooltip key={v}>
                    <TooltipTrigger asChild>
                      <ToggleGroupItem value={v} aria-label={`${GROUP_VISIBILITY_LABEL[v]} ${g.entry.name}`} data-testid={`group-${g.id}-${v}`}>
                        <Icon />
                      </ToggleGroupItem>
                    </TooltipTrigger>
                    <TooltipContent>{blockedReason ?? `${GROUP_VISIBILITY_LABEL[v]} ${g.entry.name} in ${scope}`}</TooltipContent>
                  </Tooltip>
                )
              })}
            </ToggleGroup>
          </Field>
        )
      })}
      {blockedReason && <FieldDescription>{blockedReason}</FieldDescription>}
    </div>
  )
}
