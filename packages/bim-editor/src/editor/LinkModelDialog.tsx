'use client'

import { useRef, useState } from 'react'
import { HostLink as Link } from '@permitzip/bim-editor/host'
import { toast } from 'sonner'
import { Building2, FileUp } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../ui/empty'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { Progress } from '../ui/progress'
import { Spinner } from '../ui/spinner'
import type { PackSet } from '@permitzip/bim-kernel/packs'
import { LinkedContributorFields, LinkedDisciplinesField } from './linked-display/LinkedDisciplinesField'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import {
  exportStatusLabel,
  formatBytes,
  isInProgress,
  uploadProblem,
  type AutodeskExportView,
  type LinkedDiscipline,
} from '../contracts/building-model/linked-contract'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { canLinkFrom, completeUploadFrom, linkSourcesOf, linkUnavailableReason, putFileFrom, startAutodeskExportFrom, startUploadFrom, UploadCancelled, type UploadHandle } from './linked-api'

interface Props {
  projectId: string
  open: boolean
  onOpenChange(open: boolean): void
  /** The project's connected Revit model; null when none is connected. */
  revitModel: { name: string } | null
  autodeskExport: AutodeskExportView | null
  /** Set when uploading a new version of an existing linked model. */
  replacing: { id: string; label: string } | null
  /** Called after something was queued, so the panel refreshes now instead of at the next poll. */
  onQueued(): void
  /** Opens "Add from Autodesk Docs" for a model that isn't linked in our Revit file; null when it can't be used. */
  onOpenDocsPicker: (() => void) | null
  /** The open model's discipline registry (its add-ons and firm rows); built-in and first-party when absent. */
  disciplineSet?: PackSet
}

export function LinkModelDialog({ projectId, open, onOpenChange, revitModel, autodeskExport, replacing, onQueued, onOpenDocsPicker, disciplineSet }: Props) {
  const host = useEditorHost()
  const linked = host.data.linkedModels
  // Only the sources this host serves are offered: no tab, button or wording for one it doesn't.
  const sources = linkSourcesOf(linked)
  const [tab, setTab] = useState<'autodesk' | 'upload'>(replacing ? 'upload' : sources.revitExport && (revitModel || !sources.ifcUpload) ? 'autodesk' : 'upload')
  const [file, setFile] = useState<File | null>(null)
  const [label, setLabel] = useState('')
  const [suppliedByName, setSuppliedByName] = useState('')
  const [disciplines, setDisciplines] = useState<readonly LinkedDiscipline[]>(['architecture'])
  const [contributor, setContributor] = useState({ organization: '', contact: '' })
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const uploadRef = useRef<UploadHandle | null>(null)


  const problem = file ? uploadProblem(file) : null
  const uploading = progress !== null
  const exportRunning = autodeskExport !== null && isInProgress(autodeskExport.status)

  function close(next: boolean) {
    if (!next && uploadRef.current) {
      uploadRef.current.cancel()
      return
    }
    onOpenChange(next)
  }

  async function upload() {
    if (!file || problem) return
    setError(null)
    setProgress(0)
    try {
      const started = await startUploadFrom(linked, projectId, {
        fileName: file.name,
        bytes: file.size,
        label: replacing?.label ?? (label.trim() || file.name.replace(/\.ifc$/i, '')),
        discipline: disciplines[0] ?? 'architecture',
        ...(replacing ? {} : { disciplines, contributor: { organization: contributor.organization.trim(), contact: contributor.contact.trim() } }),
        suppliedByName: suppliedByName.trim() || undefined,
        referenceId: replacing?.id,
      })
      const handle = await putFileFrom(linked, started.sourcePath, file, setProgress)
      uploadRef.current = handle
      await handle.done
      uploadRef.current = null
      await completeUploadFrom(linked, projectId, started.versionId)
      toast.success(`${file.name} uploaded. Converting it for the 3D view…`)
      onQueued()
      onOpenChange(false)
    } catch (err) {
      uploadRef.current = null
      if (err instanceof UploadCancelled) {
        toast('Upload cancelled.')
        setProgress(null)
        return
      }
      console.error('[LinkModelDialog] upload failed', err)
      setError(err instanceof Error ? err.message : 'The upload failed.')
      setProgress(null)
    }
  }

  async function exportFromRevit() {
    setError(null)
    setExporting(true)
    try {
      await startAutodeskExportFrom(linked, projectId)
      toast.success('Exporting from Revit. The models appear here when it finishes (usually 2–5 minutes).')
      onQueued()
      onOpenChange(false)
    } catch (err) {
      console.error('[LinkModelDialog] Autodesk export failed to start', err)
      setError(err instanceof Error ? err.message : "The export from Revit didn't start.")
    } finally {
      setExporting(false)
    }
  }

  const uploadBlockedReason = !file ? 'Choose an IFC file first' : problem
  const exportBlockedReason = exportRunning ? 'An export from Revit is already running' : null

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg" data-testid="link-model-dialog">
        <DialogHeader>
          <DialogTitle>{replacing ? `Upload a new version of ${replacing.label}` : 'Link a model'}</DialogTitle>
          <DialogDescription>
            {replacing
              ? 'The new file becomes the current version. Earlier versions stay listed, and you can switch back.'
              : "Linked models are shown read-only next to the new ductwork, so you can design around the architect's building."}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => (v === 'autodesk' || v === 'upload') && setTab(v)}>
          {!replacing && sources.revitExport && sources.ifcUpload && (
            <TabsList className="w-full">
              <TabsTrigger value="autodesk" disabled={uploading}>
                <Building2 data-icon="inline-start" />
                From linked models in our Revit file
              </TabsTrigger>
              <TabsTrigger value="upload" disabled={uploading}>
                <FileUp data-icon="inline-start" />
                Upload an IFC file
              </TabsTrigger>
            </TabsList>
          )}

          {sources.revitExport && (
          <TabsContent value="autodesk" className="pt-2">
            {revitModel ? (
              <div className="flex flex-col gap-3 text-sm">
                <p>
                  This opens <span className="font-medium">{revitModel.name}</span> in Autodesk read-only and adds it here, along with every
                  model it links (the architect&apos;s, structure, and so on) at the position it&apos;s linked at in Revit. Nothing in Revit
                  changes.
                </p>
                <p className="text-muted-foreground">Usually 2–5 minutes. You can close this and keep working; it finishes on its own.</p>
                {onOpenDocsPicker && (
                  <p className="text-muted-foreground">
                    Architect&apos;s model uploaded to Docs but not linked in ours?{' '}
                    <Button variant="link" size="sm" className="h-auto p-0" onClick={onOpenDocsPicker} data-testid="link-dialog-open-docs">
                      Add it from Autodesk Docs…
                    </Button>
                  </p>
                )}
                {autodeskExport && (
                  <Alert variant={autodeskExport.status === 'failed' ? 'destructive' : 'default'}>
                    {exportRunning && <Spinner />}
                    <AlertTitle>{autodeskExport.status === 'failed' ? 'The last export failed' : 'Export from Revit'}</AlertTitle>
                    <AlertDescription>{exportStatusLabel(autodeskExport)}</AlertDescription>
                  </Alert>
                )}
              </div>
            ) : (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Building2 />
                  </EmptyMedia>
                  <EmptyTitle>No Revit model is connected to this project</EmptyTitle>
                  <EmptyDescription>Connect the project&apos;s Revit model in Autodesk Docs first{sources.ifcUpload ? ', or upload an IFC file instead' : ''}.</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/projects/${projectId}?tab=integrations`}>Connect a Revit model</Link>
                  </Button>
                </EmptyContent>
              </Empty>
            )}
          </TabsContent>
          )}

          {sources.ifcUpload && (
          <TabsContent value="upload" className="pt-2">
            <FieldGroup>
              <Field data-invalid={problem ? true : undefined}>
                <FieldLabel htmlFor="link-model-file">IFC file</FieldLabel>
                <Input
                  id="link-model-file"
                  type="file"
                  accept=".ifc"
                  disabled={uploading}
                  aria-invalid={problem ? true : undefined}
                  onChange={(e) => {
                    const chosen = e.target.files?.[0] ?? null
                    setFile(chosen)
                    setError(null)
                    if (chosen && !label) setLabel(chosen.name.replace(/\.ifc$/i, ''))
                  }}
                />
                {problem ? (
                  <FieldError>{problem}</FieldError>
                ) : (
                  <FieldDescription>
                    {file ? `${formatBytes(file.size)}` : 'Up to 150 MB for now. If the file has location data, the model is placed from it; otherwise you can line it up after.'}
                  </FieldDescription>
                )}
              </Field>
              {!replacing && (
                <>
                  <Field>
                    <FieldLabel htmlFor="link-model-label">Name in the model</FieldLabel>
                    <Input id="link-model-label" value={label} onChange={(e) => setLabel(e.target.value)} disabled={uploading} maxLength={200} placeholder="e.g. Architect's model, July 15" />
                  </Field>
                  <LinkedDisciplinesField id="link-model-discipline" value={disciplines} onChange={setDisciplines} set={disciplineSet} disabled={uploading} />
                  <LinkedContributorFields id="link-model-contributor" organization={contributor.organization} contact={contributor.contact} onChange={setContributor} disabled={uploading} />
                </>
              )}
              <Field>
                <FieldLabel htmlFor="link-model-supplier">Who sent it (optional)</FieldLabel>
                <Input
                  id="link-model-supplier"
                  value={suppliedByName}
                  onChange={(e) => setSuppliedByName(e.target.value)}
                  disabled={uploading}
                  maxLength={200}
                  placeholder="e.g. Acme Architects, by email"
                />
                <FieldDescription>Kept with this version so anyone can see where the file came from.</FieldDescription>
              </Field>
              {uploading && (
                <Field>
                  <FieldLabel>Uploading… {Math.round((progress ?? 0) * 100)}%</FieldLabel>
                  <Progress value={(progress ?? 0) * 100} aria-label="Upload progress" />
                </Field>
              )}
            </FieldGroup>
          </TabsContent>
          )}
        </Tabs>

        {!canLinkFrom(sources) && (
          <Alert data-testid="link-model-unavailable">
            <AlertTitle>Nothing can be linked from here</AlertTitle>
            <AlertDescription>{linkUnavailableReason(sources, host.capabilities.hostName) ?? 'Use Add from Autodesk Docs in the Linked models section instead.'}</AlertDescription>
          </Alert>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertTitle>That didn&apos;t work</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            {uploading ? 'Cancel upload' : 'Cancel'}
          </Button>
          {tab === 'autodesk' && sources.revitExport && revitModel ? (
            <Button onClick={() => void exportFromRevit()} disabled={exporting || exportBlockedReason !== null} title={exportBlockedReason ?? undefined}>
              {exporting && <Spinner data-icon="inline-start" />}
              {exportBlockedReason ?? 'Bring in its linked models'}
            </Button>
          ) : tab === 'upload' && sources.ifcUpload ? (
            <Button onClick={() => void upload()} disabled={uploading || uploadBlockedReason !== null} title={uploadBlockedReason ?? undefined}>
              {uploading && <Spinner data-icon="inline-start" />}
              {uploading ? 'Uploading…' : 'Upload and link'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
