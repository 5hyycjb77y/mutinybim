'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { PackSet } from '@permitzip/bim-kernel/packs'
import { CloudDownload, Link2, MoreHorizontal, Move, RefreshCw, Upload } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog'
import { Alert, AlertDescription } from '../ui/alert'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../ui/item'
import { Spinner } from '../ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import {
  ALIGNMENT_LABEL,
  alignmentState,
  disciplinesOf,
  linkedContributorLabel,
  linkedDisciplinesLabel,
  docsImportStatusLabel,
  exportStatusLabel,
  finishedUpdates,
  freshnessLabel,
  isInProgress,
  isUsable,
  PLACEMENT_BASIS_LABEL,
  refreshKindOfView,
  updateOutcomeMessage,
  versionStatusLabel,
  type LinkedFreshnessView,
  type LinkedModelsResponse,
  type LinkedReferenceView,
  type PlacementAdjustment,
} from '../contracts/building-model/linked-contract'
import {
  addDocsItemsFrom,
  canLinkFrom,
  fetchLinkedFreshnessFrom,
  fetchLinkedModelsFrom,
  lineUpDocsReferenceFrom,
  linkButtonHint,
  linkSourcesOf,
  linkUnavailableReason,
  refreshDocsReferenceFrom,
  retryVersionFrom,
  startAutodeskExportFrom,
  unlinkReferenceFrom,
  updateFromRevitFrom,
  updateLinkedReferenceFrom,
} from './linked-api'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { DocsPickerDialog } from './DocsPickerDialog'
import { ExportFailureDetails } from './ExportFailureDetails'
import { LinkModelDialog } from './LinkModelDialog'
import { LinkedIdentityDialog } from './linked-display/LinkedIdentityDialog'
import { ProposeChangesDialog } from './ifc-import/ProposeChangesDialog'
import { PROPOSE_WORDS } from '../contracts/building-model/ifc-import/contract'

const POLL_MS = 4000

interface Props {
  projectId: string
  linkOpen: boolean
  onLinkOpenChange(open: boolean): void
  /** The set of models the 3D view should show changed (a version became ready, was switched, moved or unlinked). */
  onViewChange(): void
  /** Whether this person may link, so the empty-state button can say why it's off. */
  onCanEditChange(canEdit: boolean): void
  /** The project's test export, shown read-only (it isn't linked through this panel). */
  fixtureReferences: readonly { readonly id: string; readonly label: string }[]
  /** How this linked model draws in what is open (halftone, see-through…), under its name. */
  displayControl?: (reference: { readonly id: string; readonly label: string }) => ReactNode
  /** The open model's discipline registry, read on each render (its add-ons and firm rows label and fill the pickers). */
  disciplineSet?: () => PackSet | null
  /** The rail draws the "Linked models" title in its section header. */
  headerless?: boolean
}

/** What the 3D view shows: each linked model's current version and its adjustment. */
function viewSignature(data: LinkedModelsResponse): string {
  return data.references
    .map((r) => `${r.id}:${r.currentVersionId ?? '-'}:${r.adjustment.x},${r.adjustment.y},${r.adjustment.z},${r.adjustment.rotationDeg}`)
    .sort()
    .join('|')
}

export function LinkedModelsPanel({ projectId, linkOpen, onLinkOpenChange, onViewChange, onCanEditChange, fixtureReferences, displayControl, disciplineSet, headerless = false }: Props) {
  const host = useEditorHost()
  const linked = host.data.linkedModels
  // What this host can link from; a source it doesn't serve gets no button, tab or check.
  const sources = useMemo(() => linkSourcesOf(linked), [linked])
  const unavailable = linked ? null : linkUnavailableReason(sources, host.capabilities.hostName)
  const checksFreshness = Boolean(linked?.freshness)
  const disciplines = disciplineSet?.() ?? undefined
  const [data, setData] = useState<LinkedModelsResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const signatureRef = useRef<string | null>(null)
  const [replacing, setReplacing] = useState<{
    id: string
    label: string
  } | null>(null)
  const [unlinking, setUnlinking] = useState<LinkedReferenceView | null>(null)
  const [adjusting, setAdjusting] = useState<LinkedReferenceView | null>(null)
  const [identifying, setIdentifying] = useState<LinkedReferenceView | null>(null)
  const [proposing, setProposing] = useState<LinkedReferenceView | null>(null)
  const [docsOpen, setDocsOpen] = useState(false)
  const [refreshTick, setRefreshTick] = useState(0)
  const refresh = useCallback(() => setRefreshTick((t) => t + 1), [])
  const previousRef = useRef<LinkedModelsResponse | null>(null)
  const [freshness, setFreshness] = useState<ReadonlyMap<string, LinkedFreshnessView> | null>(null)
  const [freshnessError, setFreshnessError] = useState<string | null>(null)
  const [freshTick, setFreshTick] = useState(0)

  useEffect(() => {
    // No linked-models service here: nothing to load, and the panel says so in words instead of failing.
    if (!linked) return
    const controller = new AbortController()
    fetchLinkedModelsFrom(linked, projectId, controller.signal)
      .then((next) => {
        for (const done of finishedUpdates(previousRef.current, next)) {
          if (done.status === 'ready') toast.success(`${done.label} is updated (version ${done.versionNumber}).`)
          else toast.error(`${done.label} didn't update${done.error ? `: ${done.error}` : '.'}`)
        }
        previousRef.current = next
        setData(next)
        setLoadError(null)
        onCanEditChange(next.canEdit)
        const sig = viewSignature(next)
        const previous = signatureRef.current
        signatureRef.current = sig
        if (previous !== null && previous !== sig) onViewChange()
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        console.error('[LinkedModelsPanel] load failed', err)
        setLoadError(err instanceof Error ? err.message : "Couldn't load the linked models.")
      })
    return () => controller.abort()
  }, [linked, projectId, refreshTick, onViewChange, onCanEditChange])

  const busy = useMemo(
    () =>
      data !== null &&
      ((data.autodeskExport !== null && isInProgress(data.autodeskExport.status)) ||
        data.docsImports.some((j) => isInProgress(j.status)) ||
        data.references.some((r) => r.versions.some((v) => isInProgress(v.status)))),
    [data],
  )

  useEffect(() => {
    if (!busy) return
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [busy, refresh])

  // Asking Autodesk takes a moment, so it loads after the list, and again whenever an update finishes.
  const hasReferences = (data?.references.length ?? 0) > 0
  useEffect(() => {
    if (!hasReferences || busy || !checksFreshness) return
    const controller = new AbortController()
    fetchLinkedFreshnessFrom(linked, projectId, controller.signal)
      .then((models) => {
        setFreshness(new Map(models.map((m) => [m.referenceId, m])))
        setFreshnessError(null)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        console.error('[LinkedModelsPanel] checking for new versions failed', err)
        setFreshnessError(err instanceof Error ? err.message : "Couldn't check Autodesk Docs for new versions.")
      })
    return () => controller.abort()
  }, [linked, projectId, hasReferences, busy, freshTick, checksFreshness])

  const canEdit = data?.canEdit ?? false
  const exportRunning = data?.autodeskExport ? isInProgress(data.autodeskExport.status) : false
  const projectModel = data?.references.find((r) => r.isProjectModel) ?? null
  const projectModelReadyAt = projectModel?.versions.find((v) => v.id === projectModel.currentVersionId)?.readyAt ?? null
  const hostName = data?.revitModel?.name ?? "our Revit model"
  // The project's Revit model is connected but has never been exported here.
  const hostNeverExported = sources.revitExport && data !== null && data.revitModel !== null && projectModel === null && data.autodeskExport === null
  const startHostExport = useCallback(async () => {
    try {
      await startAutodeskExportFrom(linked, projectId)
    } catch (err) {
      console.error('[LinkedModelsPanel] starting the export of our Revit model failed', err)
      toast.error(err instanceof Error ? err.message : `${hostName} couldn't be exported.`)
    }
    refresh()
  }, [linked, projectId, refresh, hostName])
  // Bring our own Revit model in by itself the first time the panel sees it
  // connected without ever having been exported (projects linked before the
  // Integrations link started the export). Once per project per mount.
  const autoStartedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!hostNeverExported || !canEdit || autoStartedFor.current === projectId) return
    autoStartedFor.current = projectId
    void startHostExport()
  }, [hostNeverExported, canEdit, projectId, startHostExport])
  const editReason = canEdit ? null : "You can view linked models. Linking and unlinking need edit access to this project's model."
  const docsReason = editReason ?? (data && !data.revitModel ? "Connect this project's Revit model first; its Autodesk Docs project is where models are picked from." : null)

  async function refreshFromDocs(ref: Pick<LinkedReferenceView, 'id' | 'label'>, mode: 'check' | 'relink') {
    try {
      const result = await refreshDocsReferenceFrom(linked, projectId, ref.id, mode)
      if (result.outcome === 'up_to_date') toast.success(`${ref.label} is up to date${result.versionNumber !== null ? ` (Docs version ${result.versionNumber})` : ''}.`)
      else if (result.outcome === 'already_running') toast(`${ref.label} is already coming in from Autodesk Docs.`)
      else toast.success(mode === 'check' ? `A newer version of ${ref.label} is in Docs. Bringing it in…` : `Bringing ${ref.label} in again from Autodesk Docs…`)
      refresh()
    } catch (err) {
      console.error(`[LinkedModelsPanel] Docs ${mode} failed`, err)
      toast.error(err instanceof Error ? err.message : "Autodesk Docs didn't answer.")
    }
  }

  async function updateModel(ref: Pick<LinkedReferenceView, 'id' | 'label'>, force: boolean) {
    try {
      const result = await updateFromRevitFrom(linked, projectId, ref.id, force)
      const message = updateOutcomeMessage(ref.label, result, hostName)
      if (result.outcome === 'up_to_date') toast.success(message)
      else toast(message)
      refresh()
      setFreshTick((t) => t + 1)
    } catch (err) {
      console.error('[LinkedModelsPanel] Update from Revit failed', err)
      toast.error(err instanceof Error ? err.message : `${ref.label} couldn't be updated.`)
    }
  }

  async function act(what: string, run: () => Promise<void>, done?: string) {
    try {
      await run()
      if (done) toast.success(done)
      refresh()
    } catch (err) {
      console.error(`[LinkedModelsPanel] ${what} failed`, err)
      toast.error(err instanceof Error ? err.message : `${what} didn't work.`)
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="linked-models-panel" data-busy={busy ? 'true' : 'false'}>
      <div className={headerless ? 'flex items-center justify-end gap-2' : 'flex items-center justify-between gap-2'}>
        {!headerless && <span className="text-sm font-medium">Linked models</span>}
        <div className="flex flex-wrap items-center justify-end gap-1">
        {sources.autodeskDocs && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button size="sm" variant="outline" onClick={() => setDocsOpen(true)} disabled={docsReason !== null} data-testid="docs-picker-open">
                <CloudDownload data-icon="inline-start" />
                Add from Autodesk Docs…
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{docsReason ?? "Pick the architect's (or anyone's) Revit or IFC files in this project's Autodesk Docs"}</TooltipContent>
        </Tooltip>
        )}
        {canLinkFrom(sources) && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button size="sm" variant="outline" onClick={() => onLinkOpenChange(true)} disabled={!canEdit} data-testid="link-model-open">
                <Link2 data-icon="inline-start" />
                Link
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{editReason ?? linkButtonHint(sources)}</TooltipContent>
        </Tooltip>
        )}
        </div>
      </div>

      {unavailable && (
        <p className="text-xs text-muted-foreground" data-testid="linked-models-unavailable">
          {unavailable}
        </p>
      )}

      {loadError && (
        <Alert variant="destructive">
          <AlertDescription>
            {loadError}{' '}
            <Button variant="link" size="sm" className="h-auto p-0" onClick={refresh}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {data?.autodeskExport && data.autodeskExport.status !== 'done' && (
        <Alert variant={data.autodeskExport.status === 'failed' ? 'destructive' : 'default'} data-testid="linked-models-export-status">
          {isInProgress(data.autodeskExport.status) && <Spinner />}
          <AlertDescription className="text-xs">
            <span className="block font-medium">{hostName} · this project&apos;s Revit model</span>
            {exportStatusLabel(data.autodeskExport)}
            {data.autodeskExport.status === 'failed' && data.autodeskExport.details && (
              <ExportFailureDetails
                title={`Export of ${data.revitModel?.name ?? "the project's Revit model"}`}
                jobId={data.autodeskExport.id}
                error={data.autodeskExport.error}
                details={data.autodeskExport.details}
              />
            )}
          </AlertDescription>
        </Alert>
      )}
      {freshnessError && (
        <Alert data-testid="linked-models-freshness-error">
          <AlertDescription className="text-xs">
            Couldn&apos;t check Autodesk Docs for newer versions: {freshnessError}{' '}
            <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setFreshTick((t) => t + 1)}>
              Check again
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {data?.autodeskExport?.leftLocks && (
        <Alert variant="destructive" data-testid="linked-models-left-locks">
          <AlertDescription className="text-xs">
            <span className="block font-medium">The last export left elements borrowed in a Revit model</span>
            {data.autodeskExport.leftLocks} The button is on the Autodesk Revit card: project menu → Setup → Links.
          </AlertDescription>
        </Alert>
      )}
      {data?.autodeskExport && data.autodeskExport.status === 'done' && data.autodeskExport.notice && (
        <Alert data-testid="linked-models-export-notice">
          <AlertDescription className="text-xs">{data.autodeskExport.notice}</AlertDescription>
        </Alert>
      )}
      {data?.autodeskExport && data.autodeskExport.status === 'done' && data.autodeskExport.foundNoRevitLinks && (
        <Alert data-testid="linked-models-no-revit-links">
          <AlertDescription className="text-xs">
            {data.revitModel?.name ?? 'The Revit model'} has no Revit links, so only the project&apos;s own model came in. If the
            architect&apos;s model is a separate file in Autodesk Docs, use Add from Autodesk Docs; otherwise upload its IFC with Link.
          </AlertDescription>
        </Alert>
      )}
      {data?.autodeskExport && data.autodeskExport.status === 'done' && data.autodeskExport.missingLinks.length > 0 && (
        <Alert data-testid="linked-models-missing-links">
          <AlertDescription className="text-xs">
            <span className="block font-medium">Not brought in from Revit:</span>
            {data.autodeskExport.missingLinks.map((m) => (
              <span key={m.title} className="block">
                {m.title}: {m.reason}
                {m.detail && (
                  <span className="block break-words text-muted-foreground" data-testid="linked-models-missing-detail">
                    What Revit reported: {m.detail}
                  </span>
                )}
              </span>
            ))}
          </AlertDescription>
        </Alert>
      )}

      {data?.docsImports.map((job) => (
        <Alert
          key={job.jobId}
          variant={job.status === 'failed' ? 'destructive' : 'default'}
          data-testid="docs-import"
          data-status={job.status}
        >
          {isInProgress(job.status) && <Spinner />}
          <AlertDescription className="text-xs">
            <span className="block font-medium">{job.label} · from Autodesk Docs</span>
            {job.status === 'done' && job.notice ? <span data-testid="docs-import-notice">{job.notice}</span> : docsImportStatusLabel(job)}
            {job.status === 'failed' && job.details && (
              <ExportFailureDetails title={`${job.label} (${job.fileName}) from Autodesk Docs`} jobId={job.jobId} error={job.error} details={job.details} />
            )}
            {job.status === 'failed' && canEdit && (
              <Button
                size="sm"
                variant="outline"
                className="mt-1 h-7 self-start"
                onClick={() =>
                  void (job.referenceId
                    ? refreshFromDocs({ id: job.referenceId, label: job.label }, 'relink')
                    : act('Trying again', async () => {
                        await addDocsItemsFrom(linked, projectId, [{ itemId: job.itemId, label: job.label, discipline: job.discipline }])
                      }, `Bringing ${job.label} in again…`))
                }
              >
                <RefreshCw data-icon="inline-start" />
                Try again
              </Button>
            )}
          </AlertDescription>
        </Alert>
      ))}

      <ItemGroup className="gap-1">
        {linked && data === null && !loadError && (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            Loading…
          </span>
        )}
        {data?.references.length === 0 && fixtureReferences.length === 0 && (
          <span className="text-xs text-muted-foreground" data-testid="linked-models-empty">
            None linked yet. Linking is optional: start modeling now and bring in the architect&apos;s model with Link whenever you have it.
          </span>
        )}
        {data?.revitModel && projectModel === null && (
          <Item size="sm" variant="outline" data-testid="project-model-pending" data-export={data.autodeskExport?.status ?? 'none'}>
            <ItemContent>
              <ItemTitle className="text-xs">{data.revitModel.name}</ItemTitle>
              <ItemDescription className="text-xs">
                This project&apos;s Revit model
                {exportRunning ? (
                  <span className="flex items-center gap-1">
                    <Spinner className="size-3" />
                    Coming in from Revit (usually 2–5 minutes)…
                  </span>
                ) : data.autodeskExport?.status === 'failed' ? (
                  <span className="block text-destructive">Not in yet: the last export didn&apos;t finish (details above).</span>
                ) : data.autodeskExport?.status === 'done' ? (
                  <span className="block">The last export finished without bringing it in. Export it again.</span>
                ) : (
                  <span className="block">Connected but not in the Building Model yet.</span>
                )}
              </ItemDescription>
              {canEdit && !exportRunning && (
                <Button size="sm" className="mt-1 h-7 self-start" data-testid="project-model-export" onClick={() => void startHostExport()}>
                  <RefreshCw data-icon="inline-start" />
                  {data.autodeskExport ? 'Export it again' : 'Bring it in'}
                </Button>
              )}
              {!canEdit && !exportRunning && (
                <span className="text-xs text-muted-foreground">Someone with edit access to this project&apos;s model can bring it in.</span>
              )}
            </ItemContent>
          </Item>
        )}
        {fixtureReferences.map((ref) => (
          <Item key={ref.id} size="sm" variant="outline" data-testid="fixture-model">
            <ItemContent>
              <ItemTitle className="text-xs">{ref.label}</ItemTitle>
              {displayControl?.(ref)}
              <ItemDescription className="text-xs">From this project&apos;s test export · read-only here</ItemDescription>
            </ItemContent>
          </Item>
        ))}
        {data?.references.map((ref) => {
          const latest = ref.versions[0] ?? null
          const current = ref.versions.find((v) => v.id === ref.currentVersionId) ?? null
          const shown = latest && !isUsable(latest) ? latest : current
          const readyVersions = ref.versions.filter(isUsable)
          const alignment = current ? alignmentState(current, ref) : null
          const needsAttention = alignment === 'needs_alignment' || alignment === 'review'
          const fromDocs = ref.source === 'autodesk_docs_item'
          const converting = ref.versions.some((v) => isInProgress(v.status))
          // Our model came in again after this placement, so what it was missing may be there now.
          const hostNewer = projectModelReadyAt !== null && current?.readyAt != null && Date.parse(projectModelReadyAt) > Date.parse(current.readyAt)
          const waitingOnOurModel = fromDocs && current?.alignmentRemedy === 'reexport_host' && !hostNewer
          const offerLineUp = fromDocs && current !== null && (needsAttention || current.placementBasis === 'file_origin') && !waitingOnOurModel
          const kind = refreshKindOfView(ref)
          const fresh = freshness?.get(ref.id) ?? null
          const updating = converting || (exportRunning && (kind === 'project_model' || kind === 'revit_link'))
          return (
            <Item
              key={ref.id}
              size="sm"
              variant="outline"
              data-testid="linked-model"
              data-status={shown?.status ?? 'none'}
              data-alignment={alignment ?? 'none'}
            >
              <ItemContent>
                <ItemTitle className="text-xs">{ref.label}</ItemTitle>
                {current && isUsable(current) && displayControl?.(ref)}
                <ItemDescription className="text-xs">
                  {ref.isProjectModel ? "This project's Revit model" : linkedDisciplinesLabel(disciplinesOf(ref), disciplines)}
                  {!ref.isProjectModel && linkedContributorLabel(ref.contributor ?? null) ? ` · from ${linkedContributorLabel(ref.contributor ?? null)}` : ''}
                  {current ? ` · version ${current.number}` : ''}
                  {ref.docsItem && (
                    <span className="block" data-testid="linked-model-docs">
                      From Autodesk Docs · {ref.docsItem.fileName}
                      {ref.docsItem.versionNumber !== null ? ` · Docs version ${ref.docsItem.versionNumber}` : ''}
                    </span>
                  )}
                  {current?.placementBasis && !ref.isProjectModel && <span className="block">{PLACEMENT_BASIS_LABEL[current.placementBasis]}</span>}
                  {alignment && (
                    <span className={needsAttention ? 'block font-medium text-warning-700' : 'block'} data-testid="linked-model-alignment">
                      {ALIGNMENT_LABEL[alignment]}
                      {needsAttention && current?.alignmentNote ? `: ${current.alignmentNote}` : ''}
                    </span>
                  )}
                  {current && (
                    <span className="block">
                      From {current.suppliedBy.organization ? `${current.suppliedBy.organization} (via ${current.suppliedBy.name})` : current.suppliedBy.name} · {current.originalFileName}
                    </span>
                  )}
                  {shown && !isUsable(shown) && (
                    <span className={shown.status === 'failed' ? 'block text-destructive' : 'flex items-center gap-1'}>
                      {isInProgress(shown.status) && <Spinner className="size-3" />}
                      {versionStatusLabel(shown)}
                    </span>
                  )}
                  {fresh && (
                    <span
                      className={fresh.state === 'newer_available' ? 'block font-medium text-warning-700' : 'block'}
                      data-testid="linked-model-freshness"
                      data-state={fresh.state}
                    >
                      {freshnessLabel(fresh, hostName)}
                    </span>
                  )}
                  {!fresh && kind !== 'upload' && freshness === null && !freshnessError && (
                    <span className="block text-muted-foreground">Checking Autodesk Docs for a newer version…</span>
                  )}
                </ItemDescription>
                {canEdit && kind !== 'upload' && (
                  <Button
                    size="sm"
                    variant={fresh?.state === 'newer_available' || fresh?.state === 'never_recorded' ? 'default' : 'outline'}
                    className="mt-1 h-7 self-start"
                    disabled={updating}
                    data-testid="linked-model-update"
                    title={kind === 'docs_item' ? `Brings in ${ref.label}'s newest version from Autodesk Docs` : `Exports ${hostName} from Revit; it and every model linked in it update together`}
                    onClick={() => void updateModel(ref, false)}
                  >
                    {updating ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
                    {updating ? 'Updating…' : 'Update from Revit'}
                  </Button>
                )}
                {canEdit && (waitingOnOurModel || offerLineUp || needsAttention) && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {waitingOnOurModel && exportRunning && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="linked-model-waiting-host">
                        <Spinner className="size-3" />
                        Waiting for {hostName} to finish exporting; then choose Line up with the project model.
                      </span>
                    )}
                    {waitingOnOurModel && !exportRunning && (
                      <Button
                        size="sm"
                        className="h-7"
                        data-testid="linked-model-reexport-host"
                        title={`Exports ${hostName} (this project's model), not ${ref.label}`}
                        onClick={() =>
                          void act(
                            'Re-exporting our Revit model',
                            () => startAutodeskExportFrom(linked, projectId),
                            `Exporting ${hostName}… When it's in, choose Line up with the project model on ${ref.label}.`,
                          )
                        }
                      >
                        <RefreshCw data-icon="inline-start" />
                        Re-export {hostName} to line this up
                      </Button>
                    )}
                    {offerLineUp && (
                      <Button
                        size="sm"
                        className="h-7"
                        disabled={converting}
                        data-testid="linked-model-line-up"
                        onClick={() => void act('Lining up', () => lineUpDocsReferenceFrom(linked, projectId, ref.id), `Lining ${ref.label} up with the project model…`)}
                      >
                        {converting ? <Spinner data-icon="inline-start" /> : <Link2 data-icon="inline-start" />}
                        {converting ? 'Lining up…' : 'Line up with the project model'}
                      </Button>
                    )}
                    {needsAttention && (
                      <Button size="sm" variant="outline" className="h-7" onClick={() => setAdjusting(ref)}>
                        <Move data-icon="inline-start" />
                        Adjust position
                      </Button>
                    )}
                  </div>
                )}
                {shown?.status === 'abandoned' && canEdit && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-1 h-7 self-start"
                    onClick={() => {
                      setReplacing({ id: ref.id, label: ref.label })
                      onLinkOpenChange(true)
                    }}
                  >
                    <Upload data-icon="inline-start" />
                    Upload again
                  </Button>
                )}
                {shown?.status === 'failed' && canEdit && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-1 h-7 self-start"
                    onClick={() => void act('Trying again', () => retryVersionFrom(linked, projectId, shown.id), 'Trying the conversion again…')}
                  >
                    <RefreshCw data-icon="inline-start" />
                    Try again
                  </Button>
                )}
              </ItemContent>
              <ItemActions>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="size-7" aria-label={`Options for ${ref.label}`}>
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuLabel className="text-xs">{ref.label}</DropdownMenuLabel>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger disabled={readyVersions.length < 2 || !canEdit}>
                        {readyVersions.length < 2 ? 'Only one version so far' : 'Show version'}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        <DropdownMenuRadioGroup
                          value={ref.currentVersionId ?? ''}
                          onValueChange={(versionId) =>
                            void act(
                              'Switching version',
                              () =>
                                updateLinkedReferenceFrom(linked, projectId, ref.id, {
                                  currentVersionId: versionId,
                                }),
                              'Switched version',
                            )
                          }
                        >
                          {readyVersions.map((v) => (
                            <DropdownMenuRadioItem key={v.id} value={v.id}>
                              Version {v.number} · {new Date(v.createdAt).toLocaleDateString()} · {v.originalFileName}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <DropdownMenuItem disabled={!canEdit || !current} onSelect={() => setAdjusting(ref)}>
                      Adjust position…
                    </DropdownMenuItem>
                    {!ref.isProjectModel && (
                      <DropdownMenuItem disabled={!canEdit} onSelect={() => setIdentifying(ref)} data-testid="linked-model-identity">
                        What it shows and who sent it…
                      </DropdownMenuItem>
                    )}
                    {!ref.isProjectModel && (
                      <DropdownMenuItem disabled={current?.status !== 'ready'} onSelect={() => setProposing(ref)} data-testid="linked-model-propose">
                        {current?.status === 'ready' ? `${PROPOSE_WORDS.button}…` : `${PROPOSE_WORDS.button} (once this version is ready)`}
                      </DropdownMenuItem>
                    )}
                    {ref.source === 'autodesk_docs_item' ? (
                      <>
                        <DropdownMenuItem
                          disabled={!canEdit || !current || converting}
                          onSelect={() => void act('Lining up', () => lineUpDocsReferenceFrom(linked, projectId, ref.id), `Lining ${ref.label} up with the project model…`)}
                        >
                          {converting ? 'Lining up…' : 'Line up with the project model'}
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={!canEdit} onSelect={() => void refreshFromDocs(ref, 'relink')}>
                          Export again from Autodesk Docs (even if nothing changed)
                        </DropdownMenuItem>
                      </>
                    ) : ref.source === 'autodesk_docs' ? (
                      <DropdownMenuItem disabled={!canEdit || updating} onSelect={() => void updateModel(ref, true)} data-testid="linked-model-force-update">
                        Export {hostName} again (even if nothing changed)
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem
                        disabled={!canEdit || !sources.ifcUpload}
                        onSelect={() => {
                          setReplacing({ id: ref.id, label: ref.label })
                          onLinkOpenChange(true)
                        }}
                      >
                        Upload a new version…
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-destructive focus:text-destructive" disabled={!canEdit} onSelect={() => setUnlinking(ref)}>
                      Unlink…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </ItemActions>
            </Item>
          )
        })}
      </ItemGroup>

      <LinkModelDialog
        key={linkOpen ? `open-${replacing?.id ?? 'new'}-${data?.revitModel ? 'revit' : 'none'}` : 'closed'}
        projectId={projectId}
        open={linkOpen}
        onOpenChange={(open) => {
          onLinkOpenChange(open)
          if (!open) setReplacing(null)
        }}
        revitModel={data?.revitModel ?? null}
        autodeskExport={data?.autodeskExport ?? null}
        replacing={replacing}
        onQueued={refresh}
        disciplineSet={disciplines}
        onOpenDocsPicker={
          sources.autodeskDocs && docsReason === null
            ? () => {
                onLinkOpenChange(false)
                setDocsOpen(true)
              }
            : null
        }
      />

      {sources.autodeskDocs && (
        <DocsPickerDialog
          key={docsOpen ? 'docs-open' : 'docs-closed'}
          projectId={projectId}
          open={docsOpen}
          onOpenChange={setDocsOpen}
          revitModelName={data?.revitModel?.name ?? null}
          onQueued={refresh}
          disciplineSet={disciplines}
        />
      )}

      <AlertDialog open={unlinking !== null} onOpenChange={(open) => !open && setUnlinking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink {unlinking?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              It disappears from this project&apos;s Building Model for everyone. Its files and versions are kept, so linking it again is quick.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const target = unlinking
                if (target) void act('Unlinking', () => unlinkReferenceFrom(linked, projectId, target.id), `${target.label} unlinked`)
              }}
            >
              Unlink
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AdjustPositionDialog
        reference={adjusting}
        onClose={() => setAdjusting(null)}
        onSave={(adjustment) => {
          const target = adjusting
          if (!target) return
          setAdjusting(null)
          void act('Saving the position', () => updateLinkedReferenceFrom(linked, projectId, target.id, { adjustment }), 'Position saved')
        }}
      />
      <LinkedIdentityDialog projectId={projectId} reference={identifying} set={disciplines} onClose={() => setIdentifying(null)} onSaved={refresh} />
      <ProposeChangesDialog projectId={projectId} reference={proposing} set={disciplines} onClose={() => setProposing(null)} />
    </div>
  )
}

function AdjustPositionDialog({
  reference,
  onClose,
  onSave,
}: {
  reference: LinkedReferenceView | null
  onClose(): void
  onSave(adjustment: PlacementAdjustment): void
}) {
  return (
    <Dialog open={reference !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">{reference && <AdjustPositionForm key={reference.id} reference={reference} onSave={onSave} />}</DialogContent>
    </Dialog>
  )
}

function AdjustPositionForm({ reference, onSave }: { reference: LinkedReferenceView; onSave(adjustment: PlacementAdjustment): void }) {
  const a = reference.adjustment
  const [values, setValues] = useState({
    x: String(a.x),
    y: String(a.y),
    z: String(a.z),
    rotationDeg: String(a.rotationDeg),
  })
  const parsed = {
    x: Number(values.x),
    y: Number(values.y),
    z: Number(values.z),
    rotationDeg: Number(values.rotationDeg),
  }
  const invalid = Object.values(parsed).some((v) => !Number.isFinite(v)) || Math.abs(parsed.rotationDeg) >= 360
  const fields: { key: keyof typeof values; label: string; hint: string }[] = [
    {
      key: 'x',
      label: 'Move east (m)',
      hint: "Along the model's east axis; negative moves west",
    },
    {
      key: 'y',
      label: 'Move north (m)',
      hint: "Along the model's north axis; negative moves south",
    },
    { key: 'z', label: 'Move up (m)', hint: 'Negative moves down' },
    {
      key: 'rotationDeg',
      label: 'Turn (degrees)',
      hint: "Counter-clockwise seen from above, about where the file's own origin sits; less than 360",
    },
  ]
  return (
    <>
      <DialogHeader>
        <DialogTitle>Adjust {reference.label}</DialogTitle>
        <DialogDescription>
          {reference.isProjectModel
            ? "This is the project's own Revit model; its links are placed around it. Only adjust it if it doesn't line up with the new ductwork."
            : reference.source === 'autodesk_docs' || (reference.source === 'autodesk_docs_item' && reference.versions[0]?.placementBasis === 'revit_link')
            ? "This model already sits where it's linked in Revit. Only adjust it if it still doesn't line up."
            : reference.source === 'autodesk_docs_item' && reference.versions[0]?.placementBasis === 'revit_shared_coordinates'
            ? "This model is placed by Revit shared coordinates. Only adjust it if the architect's coordinates don't match ours."
            : 'Line the uploaded model up with the building. Set everything to 0 to put it back where the file places it.'}
        </DialogDescription>
      </DialogHeader>
      <FieldGroup className="grid grid-cols-2 gap-3">
        {fields.map((f) => (
          <Field key={f.key}>
            <FieldLabel htmlFor={`adjust-${f.key}`}>{f.label}</FieldLabel>
            <Input
              id={`adjust-${f.key}`}
              inputMode="decimal"
              value={values[f.key]}
              onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
            />
            <FieldDescription className="text-xs">{f.hint}</FieldDescription>
          </Field>
        ))}
      </FieldGroup>
      <DialogFooter>
        <Button variant="outline" onClick={() => setValues({ x: '0', y: '0', z: '0', rotationDeg: '0' })}>
          Reset to 0
        </Button>
        <Button onClick={() => onSave(parsed)} disabled={invalid} title={invalid ? 'Enter numbers only; the turn must be less than 360 degrees' : undefined}>
          Save position
        </Button>
      </DialogFooter>
    </>
  )
}
