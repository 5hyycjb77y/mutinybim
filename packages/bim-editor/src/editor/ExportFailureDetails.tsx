'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight, Copy } from 'lucide-react'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import {
  exportFailureElementLabel,
  exportFailureSupportText,
  type ExportFailureDetailsView,
} from '../contracts/building-model/linked-contract'

interface Props {
  /** What failed, as the card names it ("Sample Warehouse · from Autodesk Docs"). */
  title: string
  jobId: string
  error: string | null
  details: ExportFailureDetailsView
}

/** The exact reason behind a failed export, from Autodesk's job report, under the plain-language line. */
export function ExportFailureDetails({ title, jobId, error, details }: Props) {
  const [open, setOpen] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(exportFailureSupportText({ title, jobId, error }, details))
      toast.success('Copied the failure details for support.')
    } catch (err) {
      console.error('[ExportFailureDetails] copy failed', err)
      toast.error("Couldn't copy to the clipboard. Select the details and copy them by hand.")
    }
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-1" data-testid="export-failure-details">
      <div className="flex flex-wrap items-center gap-1">
        <CollapsibleTrigger asChild>
          <Button size="sm" variant="ghost" className="h-7 px-1" data-testid="export-failure-details-toggle">
            {open ? <ChevronDown data-icon="inline-start" /> : <ChevronRight data-icon="inline-start" />}
            {open ? 'Hide details' : 'Show details'}
          </Button>
        </CollapsibleTrigger>
        <Button size="sm" variant="ghost" className="h-7 px-1" onClick={() => void copy()} data-testid="export-failure-copy">
          <Copy data-icon="inline-start" />
          Copy for support
        </Button>
      </div>
      <CollapsibleContent className="flex flex-col gap-1 break-words pt-1" data-testid="export-failure-details-body">
        {!details.recorded && (
          <span>Autodesk&apos;s report wasn&apos;t kept for this attempt (it ran before reports were stored). Try again to record one.</span>
        )}
        {details.recorded && (
          <>
            {details.exception && (
              <span data-testid="export-failure-exception">
                <span className="font-medium">What Revit reported:</span> {details.exception}
              </span>
            )}
            {details.crash && <span data-testid="export-failure-crash">{details.crash}</span>}
            {!details.exception && !details.crash && (
              <span>Autodesk&apos;s report names no exception for this failure. Copy the details for support.</span>
            )}
            {details.step && (
              <span>
                <span className="font-medium">Step:</span> {details.step}
              </span>
            )}
            {details.elements.length > 0 && (
              <span className="flex flex-col" data-testid="export-failure-elements">
                <span className="font-medium">Elements Revit named:</span>
                {details.elements.map((e) => (
                  <span key={e.id}>{exportFailureElementLabel(e)}</span>
                ))}
              </span>
            )}
            {details.skippedElements.length > 0 && (
              <span className="flex flex-col" data-testid="export-failure-skipped">
                <span className="font-medium">Left out to finish the export:</span>
                {details.skippedElements.map((e) => (
                  <span key={e.id}>{exportFailureElementLabel(e)}</span>
                ))}
              </span>
            )}
            {!details.reportFetched && (
              <span>Autodesk&apos;s report couldn&apos;t be downloaded: {details.reportError ?? 'no reason given'}.</span>
            )}
            {details.attempts.length > 1 && (
              <span className="flex flex-col" data-testid="export-failure-attempts">
                <span className="font-medium">Attempts:</span>
                {details.attempts.map((a) => (
                  <span key={`${a.attempt}-${a.autodeskJobId}`}>
                    {a.attempt}. {a.outcome === 'revit_crashed' ? 'Revit crashed' : a.outcome === 'succeeded' ? 'Finished' : 'Failed'}
                    {a.headline ? ` — ${a.headline}` : ''} (Autodesk job {a.autodeskJobId})
                  </span>
                ))}
              </span>
            )}
            <span className="text-muted-foreground" data-testid="export-failure-job-id">
              Autodesk job {details.autodeskJobId ?? 'unknown'}
              {details.autodeskStatus ? ` · ${details.autodeskStatus}` : ''}
              {details.engineYear ? ` · Revit ${details.engineYear}` : ''}
            </span>
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}
