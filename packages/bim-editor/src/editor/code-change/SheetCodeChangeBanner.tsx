'use client'

import { useEffect, useMemo, useState } from 'react'
import { CurrentRuleIndex, currentCodesFor, type ModelState, type Sheet } from '@permitzip/bim-kernel'
import { reissueCheck, type BlockedApproval } from '@permitzip/bim-sheets/reissue-check'
import type { ModelSignoffsResponse } from '../../contracts/bim/code-change/api'
import type { EditorDataHost } from '@permitzip/bim-editor-host'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { fetchModelSignoffsFrom } from '../../contracts/bim/code-change/client'
import { sheetApprovals, standingsFor } from '../../contracts/bim/code-change/standings'
import { CodeChangeBanner, type BannerLoad } from './CodeChangeBanner'
import { OverrideDialog } from './OverrideDialog'

type Log = { readonly state: 'loading' } | { readonly state: 'error'; readonly message: string } | { readonly state: 'ready'; readonly log: ModelSignoffsResponse }

type CodeChangePort = NonNullable<EditorDataHost['codeChange']>

interface SheetCodeChangeBannerProps {
  readonly projectId: string
  readonly modelId: string
  readonly model: ModelState
  readonly sheet: Pick<Sheet, 'id' | 'number'>
  readonly viewerId: string
  /** Re-check and sign, or sign a new approval: where approvals are made (Manage › Responsibilities). */
  readonly onRecheck: () => void
}

/**
 * Sheets › a sheet (round 10, C10 mount): the model's sign-off log against
 * the open model's code of record, for this one sheet. Loaded on demand with
 * the sheet, so the page's first download doesn't carry it. A host that keeps
 * no sign-off log has no approvals a code change could block: nothing shows.
 */
export function SheetCodeChangeBanner(props: SheetCodeChangeBannerProps) {
  const codeChange = useEditorHost().data.codeChange
  return codeChange ? <SheetCodeChangeBannerFor codeChange={codeChange} {...props} /> : null
}

function SheetCodeChangeBannerFor({ codeChange, projectId, modelId, model, sheet, viewerId, onRecheck }: SheetCodeChangeBannerProps & { readonly codeChange: CodeChangePort }) {
  const [log, setLog] = useState<Log>({ state: 'loading' })
  const [run, setRun] = useState(0)
  const [overriding, setOverriding] = useState<BlockedApproval | null>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    fetchModelSignoffsFrom(codeChange, projectId, modelId, ctrl.signal)
      .then((next) => setLog({ state: 'ready', log: next }))
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return
        console.error('[SheetCodeChangeBanner] loading the sign-off log failed', { projectId, modelId, err })
        setLog({ state: 'error', message: err instanceof Error ? err.message : 'The approvals on this sheet couldn’t be read.' })
      })
    return () => ctrl.abort()
  }, [codeChange, projectId, modelId, run])

  const reload = () => {
    setLog({ state: 'loading' })
    setRun((n) => n + 1)
  }

  const codes = useMemo(() => new CurrentRuleIndex(currentCodesFor(model)), [model])
  const load = useMemo<BannerLoad>(() => {
    if (log.state !== 'ready') return log
    const approvals = sheetApprovals(standingsFor(log.log, codes), [String(sheet.id)])
    return { state: 'ready', blocked: reissueCheck([sheet], approvals).blocked }
  }, [log, codes, sheet])

  return (
    <>
      <CodeChangeBanner load={load} viewerId={viewerId} onRecheck={onRecheck} onOverride={setOverriding} onNewApproval={onRecheck} onRetry={reload} />
      <OverrideDialog projectId={projectId} approval={overriding} open={overriding !== null} onOpenChange={(open) => !open && setOverriding(null)} onRecorded={reload} />
    </>
  )
}
