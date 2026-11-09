'use client'

import { useCallback, useEffect, useState } from 'react'
import { Download, FileBox, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../../ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import { Spinner } from '../../ui/spinner'
import type { IfcExportView } from '../../contracts/building-model/ifc-export-contract'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { fetchIfcExportsFrom, ifcExportDownloadUrlFrom, startIfcExportFrom } from './ifc-export-client'

/**
 * Building Model › Sheets › Issue › Export IFC. Writes the last saved model
 * as an IFC 4.3 file (spaces, zones, systems, circuits, equipment with its
 * parameters; planned equipment without a body) and lists this project's
 * exports with their state: exporting, ready to download, or failed with
 * the reason and Retry.
 */

const STATUS_WORDS: Readonly<Record<IfcExportView['status'], string>> = { exporting: 'Exporting', ready: 'Ready', failed: 'Failed' }

function sizeWords(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function whenWords(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function summary(e: IfcExportView): string {
  const parts = [e.revision !== null ? `Rev ${e.revision}` : null, e.byName, whenWords(e.startedAt)]
  const c = e.counts
  if (c) parts.push(`${c.spaces} spaces, ${c.systems} systems, ${c.elements} elements (${c.planned} planned)`)
  return parts.filter((p): p is string => !!p).join(' · ')
}

export function IfcExportDialog({ projectId, modelId, pendingEdits, onClose }: {
  projectId: string
  /** Null when no model server serves this project. */
  modelId: string | null
  /** Edits not saved yet: the export writes the last saved revision. */
  pendingEdits: number
  onClose: () => void
}) {
  const ifcExport = useEditorHost().data.ifcExport
  const [exports, setExports] = useState<IfcExportView[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [downloading, setDownloading] = useState<string | null>(null)

  const fetchList = useCallback(
    () =>
      fetchIfcExportsFrom(ifcExport, projectId).then(
        (list) => ({ list, error: null }),
        (err: unknown) => {
          console.error('[IfcExportDialog] loading exports failed', err)
          return { list: null, error: err instanceof Error ? err.message : "This project's IFC exports couldn't be loaded. Try again." }
        },
      ),
    [ifcExport, projectId],
  )

  const load = async () => {
    setLoadError(null)
    const got = await fetchList()
    if (got.list) setExports(got.list)
    setLoadError(got.error)
  }

  useEffect(() => {
    let live = true
    void fetchList().then((got) => {
      if (!live) return
      if (got.list) setExports(got.list)
      setLoadError(got.error)
    })
    return () => {
      live = false
    }
  }, [fetchList])

  const run = async () => {
    if (!modelId) return
    setRunning(true)
    try {
      const done = await startIfcExportFrom(ifcExport, projectId, modelId)
      setExports((list) => [done, ...(list ?? []).filter((e) => e.jobId !== done.jobId)])
      if (done.status === 'ready') toast.success(`IFC file ready${done.file ? `: ${done.file.name}` : ''}.`)
      else toast.error(done.error ?? "The IFC export didn't finish.")
    } catch (err) {
      console.error('[IfcExportDialog] export failed', err)
      toast.error(err instanceof Error ? err.message : "The IFC export couldn't start. Try again.")
      await load()
    } finally {
      setRunning(false)
    }
  }

  const download = async (e: IfcExportView) => {
    if (!e.file) return
    setDownloading(e.jobId)
    try {
      window.open(await ifcExportDownloadUrlFrom(ifcExport, projectId, e.file.artifactId), '_blank', 'noopener,noreferrer')
    } catch (err) {
      console.error('[IfcExportDialog] download link failed', err)
      toast.error(err instanceof Error ? err.message : "The download link couldn't be made. Try again.")
    } finally {
      setDownloading(null)
    }
  }

  const exportDisabled = !modelId ? "This project's model server isn't connected, so there is no saved model to export. Reload, or ask an admin to connect it." : running ? 'An export is running.' : null
  const anyRunning = running || (exports ?? []).some((e) => e.status === 'exporting')

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl" data-testid="ifc-export-dialog">
        <DialogHeader>
          <DialogTitle>Export IFC</DialogTitle>
          <DialogDescription>
            An IFC 4.3 file of the last saved model for Revit, Navisworks and contractors: levels, spaces, zones, systems and circuits, and every element with its parameters. Planned equipment is listed without a body. Exporting again keeps every element&apos;s IFC id.
          </DialogDescription>
        </DialogHeader>
        {pendingEdits > 0 && <p className="text-xs text-muted-foreground">{pendingEdits} of your changes {pendingEdits === 1 ? "isn't" : "aren't"} saved yet; the export writes the model as last saved.</p>}
        {loadError && (
          <Alert variant="destructive">
            <AlertTitle>Couldn&apos;t load the exports</AlertTitle>
            <AlertDescription className="flex flex-col gap-2">
              {loadError}
              <Button variant="outline" size="sm" className="self-start" onClick={() => void load()}>
                <RotateCcw data-icon="inline-start" />
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {exports === null && !loadError ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            Loading exports…
          </div>
        ) : exports && exports.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileBox />
              </EmptyMedia>
              <EmptyTitle>No IFC exports yet</EmptyTitle>
              <EmptyDescription>Export IFC writes the first one; it is kept here for everyone on the project.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : exports ? (
          <ItemGroup className="max-h-80 overflow-y-auto" data-testid="ifc-export-list">
            {exports.map((e) => (
              <Item key={e.jobId} variant="outline" size="sm" data-testid="ifc-export-row" data-status={e.status}>
                <ItemContent>
                  <ItemTitle>
                    {e.file?.name ?? (e.status === 'exporting' ? 'Writing the file…' : 'No file')}
                    <Badge variant={e.status === 'failed' ? 'destructive' : e.status === 'ready' ? 'secondary' : 'outline'}>{STATUS_WORDS[e.status]}</Badge>
                  </ItemTitle>
                  <ItemDescription>{e.status === 'failed' ? e.error : `${summary(e)}${e.file ? ` · ${sizeWords(e.file.bytes)}` : ''}${e.warnings > 0 ? ` · ${e.warnings} written as generic or adjusted` : ''}`}</ItemDescription>
                  {e.status === 'ready' && e.workspace && (
                    <ItemDescription data-testid="ifc-export-files-status">
                      {e.workspace.status === 'filed' ? `Also in the project's Files › ${e.workspace.folder} as ${e.workspace.name}` : `Not added to the project's Files: ${e.workspace.reason}. Download it here instead.`}
                    </ItemDescription>
                  )}
                </ItemContent>
                <ItemActions>
                  {e.status === 'exporting' && <Spinner />}
                  {e.status === 'ready' && e.file && (
                    <Button variant="outline" size="sm" onClick={() => void download(e)} disabled={downloading !== null} data-testid="ifc-export-download">
                      {downloading === e.jobId ? <Spinner data-icon="inline-start" /> : <Download data-icon="inline-start" />}
                      Download
                    </Button>
                  )}
                  {e.status === 'failed' && (
                    <Button variant="outline" size="sm" onClick={() => void run()} disabled={exportDisabled !== null || anyRunning} title={exportDisabled ?? (anyRunning ? 'An export is running.' : undefined)} data-testid="ifc-export-retry">
                      <RotateCcw data-icon="inline-start" />
                      Retry
                    </Button>
                  )}
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        ) : null}
        {exportDisabled && !running && <p className="text-xs text-muted-foreground">{exportDisabled}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => void run()} disabled={exportDisabled !== null || anyRunning} data-testid="ifc-export-start">
            {running ? <Spinner data-icon="inline-start" /> : <FileBox data-icon="inline-start" />}
            {running ? 'Exporting…' : 'Export IFC'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
