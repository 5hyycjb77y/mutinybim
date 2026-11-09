'use client'

import { useCallback, useEffect, useState } from 'react'
import { Gauge, Plus } from 'lucide-react'
import { toast } from 'sonner'
import type { DesignLimit, DesignLimitRow } from '@permitzip/bim-kernel/policy'
import { Alert, AlertDescription } from '../../ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../ui/alert-dialog'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../../ui/empty'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { SettingsCard, SettingsLoadError, SettingsLoading } from '../../ui/settings-page'
import { DesignLimitEditor } from './DesignLimitEditor'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { appliesToWords, loadDesignLimitRowsFrom, publishDesignLimitFrom, type DesignLimitRows, type LibraryLimit } from './design-limits-client'

type LoadState = { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly rows: DesignLimitRows } | { readonly kind: 'error'; readonly message: string }

const LAYER_WORDS = { project: 'This project', firm: 'Firm', addon: 'Default' } as const

function whoSetIt(row: DesignLimitRow): string {
  if (row.layer === 'addon' || !row.limit.setBy) return '—'
  const when = new Date(row.limit.setBy.at)
  return `${row.limit.setBy.name}, ${Number.isNaN(when.getTime()) ? row.limit.setBy.at : when.toLocaleDateString()}`
}

/**
 * Library › Design limits (round 12 S12): the rules of thumb every check
 * and calculation sheet designs to, one row per limit, each with its source
 * and who set it. Every discipline and system starts filled in from its
 * add-on's best-practice default; the firm (here) or a project changes any
 * value, and "Put back the default" removes its own row after a confirm.
 * A problem that breaks a limit names it: "Velocity 9.2 ft/s over the firm's
 * 8 ft/s (set by the product owner)".
 */
export function DesignLimitsSection({ scope = 'firm', canEdit, editBlockedReason, loadRows: loadRowsOverride }: { readonly scope?: string; readonly canEdit: boolean; readonly editBlockedReason?: string; readonly loadRows?: (scope: string) => Promise<DesignLimitRows> }) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [editing, setEditing] = useState<{ readonly row: DesignLimitRow | null } | null>(null)
  const [resetting, setResetting] = useState<DesignLimitRow | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const library = useEditorHost().data.firmLibrary
  const loadRows = useCallback((from: string) => (loadRowsOverride ? loadRowsOverride(from) : loadDesignLimitRowsFrom(library, from)), [loadRowsOverride, library])

  const fetchRows = useCallback(() => {
    loadRows(scope)
      .then((rows) => setState({ kind: 'ready', rows }))
      .catch((err: unknown) => {
        console.error('[DesignLimitsSection] the design limits failed to load', err)
        setState({ kind: 'error', message: `Design limits couldn't be read (${err instanceof Error ? err.message : 'unknown error'}). Checks keep using the last limits they read.` })
      })
  }, [loadRows, scope])

  useEffect(() => {
    fetchRows()
  }, [fetchRows])

  const reload = () => {
    setState({ kind: 'loading' })
    fetchRows()
  }

  if (state.kind === 'loading') return <SettingsLoading rows={5} label="Loading design limits" />
  if (state.kind === 'error') return <SettingsLoadError title="Design limits didn't load" message={state.message} onRetry={reload} />

  const { rows, own } = state.rows
  const ownById = new Map<string, LibraryLimit>(own.map((o) => [o.limit.id, o] as const))
  const blocked = canEdit ? null : (editBlockedReason ?? "You can see the firm's limits; changing them needs MutinyBIM library publishing.")

  const save = async (limit: DesignLimit) => {
    const held = ownById.get(limit.id)
    const result = await publishDesignLimitFrom(library, scope, limit, held?.revision ?? 0)
    if (!result.ok) {
      setSaveError(result.message)
      return false
    }
    setSaveError(null)
    toast.success(`Saved ${limit.label}.`)
    reload()
    return true
  }

  const putBack = async (row: DesignLimitRow) => {
    const held = ownById.get(row.limit.id)
    if (!held) return
    const result = await publishDesignLimitFrom(library, scope, held.limit, held.revision, { deprecated: true })
    if (!result.ok) setSaveError(result.message)
    else {
      setSaveError(null)
      toast.success(row.fallback ? `${row.limit.label} is back to the default.` : `${row.limit.label} is removed.`)
      reload()
    }
  }

  const addButton = (
    <Button size="sm" onClick={() => setEditing({ row: null })} disabled={blocked !== null} data-testid="design-limit-add">
      <Plus />
      Add a limit
    </Button>
  )

  return (
    <SettingsCard
      id="design-limits"
      title="Design limits"
      description="The firm's rules of thumb (velocity, pressure loss, spare capacity, margins…), one per discipline and system, each with its source. Checks and calculation sheets design to these; a project can change any of them for itself."
      actions={
        blocked ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>{addButton}</span>
            </TooltipTrigger>
            <TooltipContent>{blocked}</TooltipContent>
          </Tooltip>
        ) : (
          addButton
        )
      }
    >
      {saveError && (
        <Alert variant="destructive" data-testid="design-limit-save-error">
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}
      {rows.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Gauge />
            </EmptyMedia>
            <EmptyTitle>No design limits yet</EmptyTitle>
            <EmptyDescription>None of the add-ons in use ship a default, and the firm hasn&apos;t set one. Add a limit, for example water velocity at most 8 ft/s.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableCaption className="sr-only">Design limits, what each applies to, its band, its source and who set it</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Limit</TableHead>
              <TableHead>Applies to</TableHead>
              <TableHead>Band</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Set by</TableHead>
              <TableHead className="sr-only">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.limit.id} data-testid={`design-limit-row-${row.limit.id}`}>
                <TableCell className="font-medium">{row.limit.label}</TableCell>
                <TableCell className="text-muted-foreground text-sm">{appliesToWords(row.limit)}</TableCell>
                <TableCell className="text-sm">{state.rows.band(row.limit)}</TableCell>
                <TableCell className="text-muted-foreground text-sm">{row.limit.citation.source}</TableCell>
                <TableCell className="text-sm">
                  <div className="flex flex-col gap-1">
                    <Badge variant={row.layer === 'addon' ? 'secondary' : 'outline'}>{LAYER_WORDS[row.layer]}</Badge>
                    <span className="text-muted-foreground">{whoSetIt(row)}</span>
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" disabled={blocked !== null} onClick={() => setEditing({ row })} data-testid={`design-limit-edit-${row.limit.id}`}>
                      Change
                    </Button>
                    {ownById.has(row.limit.id) && (
                      <Button size="sm" variant="ghost" disabled={blocked !== null} onClick={() => setResetting(row)} data-testid={`design-limit-reset-${row.limit.id}`}>
                        {row.fallback ? 'Put back the default' : 'Remove'}
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {editing && <DesignLimitEditor initial={editing.row?.limit ?? null} fallback={editing.row?.fallback ?? null} onCancel={() => setEditing(null)} onSave={async (limit) => {
            const ok = await save(limit)
            if (ok) setEditing(null)
            return ok
          }} />}
      <AlertDialog open={resetting !== null} onOpenChange={(open) => !open && setResetting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{resetting?.fallback ? `Put ${resetting.limit.label} back to the default?` : `Remove ${resetting?.limit.label ?? 'this limit'}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {resetting?.fallback ? `Checks go back to ${state.rows.band(resetting.fallback)} (${resetting.fallback.citation.source}). You can change it again any time.` : 'Checks stop using it. You can add it again any time.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              data-testid="design-limit-reset-confirm"
              onClick={() => {
                if (resetting) void putBack(resetting)
                setResetting(null)
              }}
            >
              {resetting?.fallback ? 'Put back the default' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  )
}
