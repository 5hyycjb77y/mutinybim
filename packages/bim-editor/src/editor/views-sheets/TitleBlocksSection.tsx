'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../../ui/empty'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { SettingsCard, SettingsLoadError, SettingsLoading } from '../../ui/settings-page'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { loadTitleBlocksFrom, makeDefaultTitleBlockFrom, type TitleBlockList } from './title-blocks-client'

type LoadState = { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly list: TitleBlockList } | { readonly kind: 'error'; readonly message: string }

const inches = (mm: number) => Math.round(mm / 25.4)

/**
 * Library › Title blocks (round 15, SH15): every title block in the firm
 * library, its paper, and the firm default new sheets start with. A sheet
 * keeps the title block it was given, so changing the default never redraws
 * an issued sheet; Sheets › Title block switches one sheet.
 */
export function TitleBlocksSection({ load: loadOverride, makeDefault: makeDefaultOverride }: { readonly load?: () => Promise<TitleBlockList>; readonly makeDefault?: (id: string) => Promise<void> }) {
  const titleBlocks = useEditorHost().data.titleBlocks
  const load = useCallback(() => (loadOverride ? loadOverride() : loadTitleBlocksFrom(titleBlocks)), [loadOverride, titleBlocks])
  const makeDefault = (id: string) => (makeDefaultOverride ? makeDefaultOverride(id) : makeDefaultTitleBlockFrom(titleBlocks, id))
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [saving, setSaving] = useState<string | null>(null)

  const fetchList = useCallback(() => {
    load()
      .then((list) => setState({ kind: 'ready', list }))
      .catch((err: unknown) => {
        console.error('[TitleBlocksSection] the title blocks failed to load', err)
        setState({ kind: 'error', message: `Title blocks couldn't be read (${err instanceof Error ? err.message : 'unknown error'}).` })
      })
  }, [load])

  useEffect(() => {
    fetchList()
  }, [fetchList])

  if (state.kind === 'loading') return <SettingsLoading rows={3} label="Loading title blocks" />
  if (state.kind === 'error')
    return (
      <SettingsLoadError
        title="Title blocks didn't load"
        message={state.message}
        onRetry={() => {
          setState({ kind: 'loading' })
          fetchList()
        }}
      />
    )

  const { choices, canWrite } = state.list
  const blocked = canWrite ? null : 'Making a title block the default needs MutinyBIM library publishing.'

  const choose = async (id: string, name: string) => {
    setSaving(id)
    try {
      await makeDefault(id)
      toast.success(`${name} is now the title block new sheets start with`)
      fetchList()
    } catch (err) {
      console.error('[TitleBlocksSection] make default failed', err)
      toast.error(`${name} couldn't be made the default: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally {
      setSaving(null)
    }
  }

  return (
    <SettingsCard
      id="title-blocks"
      title="Title blocks"
      description="The title blocks sheets can use, with the paper each is drawn for. New sheets start with the default; a sheet keeps its own title block until you change it in Sheets › Title block."
    >
      {choices.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No title blocks in the library</EmptyTitle>
            <EmptyDescription>Sheets use the built-in MutinyBIM title block until the firm adds one.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table aria-label="Title blocks">
          <TableHeader>
            <TableRow>
              <TableHead>Title block</TableHead>
              <TableHead>Paper</TableHead>
              <TableHead className="text-right">Default</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {choices.map((c) => {
              const paper = c.row.definition.paperMm
              const button = (
                <Button size="sm" variant="outline" disabled={Boolean(blocked) || saving !== null} onClick={() => void choose(c.id, c.name)}>
                  {saving === c.id ? 'Saving…' : 'Make default'}
                </Button>
              )
              return (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>
                    {c.paperName} · {inches(paper.y)} × {inches(paper.x)} in, landscape
                  </TableCell>
                  <TableCell className="text-right">
                    {c.isDefault ? (
                      <Badge variant="secondary">Default</Badge>
                    ) : blocked ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>{button}</span>
                        </TooltipTrigger>
                        <TooltipContent>{blocked}</TooltipContent>
                      </Tooltip>
                    ) : (
                      button
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </SettingsCard>
  )
}
