'use client'

import { useState } from 'react'
import { Building2, Layers, MousePointerClick, Plus, RefreshCw, TriangleAlert, WifiOff } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Button } from '../ui/button'
import { FIRST_LEVEL, type ToolBlocker, type ToolFixId } from './tool-readiness'

/**
 * At the tool, over the view: why the selected tool can't act yet and the
 * fix, one click away. Stays until the cause is gone; pointer moves never clear it.
 */
export function ToolReadinessNotice({
  blocker,
  onCreateLevel,
  onOpenAddLevel,
  onRetry,
  onUseArchitectLevels,
}: {
  readonly blocker: ToolBlocker
  /** Returns the plain refusal, or null when the level was added. */
  readonly onCreateLevel: (name: string, elevationMm: number) => string | null
  readonly onOpenAddLevel: () => void
  /** Reconnect to the model server now (the paused blocker's Try now); the fix is hidden without it. */
  readonly onRetry?: () => void
  /** Take a linked model's storeys as levels; the fix is hidden without it. */
  readonly onUseArchitectLevels?: () => void
}) {
  const [refusal, setRefusal] = useState<string | null>(null)
  const fixes = blocker.fixes.filter((fix) => (fix.id !== 'retry-now' || onRetry) && (fix.id !== 'use-architect-levels' || onUseArchitectLevels))
  const run = (id: ToolFixId) => {
    setRefusal(null)
    if (id === 'add-level') {
      onOpenAddLevel()
      return
    }
    if (id === 'retry-now') {
      onRetry?.()
      return
    }
    if (id === 'use-architect-levels') {
      onUseArchitectLevels?.()
      return
    }
    const refused = onCreateLevel(FIRST_LEVEL.name, FIRST_LEVEL.elevationMm)
    if (refused) {
      console.error('[ToolReadinessNotice] adding the first level was refused', { refused })
      setRefusal(refused)
    }
  }
  return (
    <div className="absolute bottom-3 left-1/2 z-10 w-full max-w-lg -translate-x-1/2 px-3" data-testid="tool-blocker" data-blocker={blocker.id}>
      <Alert>
        {blocker.id === 'no-level' ? <Layers /> : blocker.id === 'paused' ? <WifiOff /> : blocker.id === 'no-model-view' ? <MousePointerClick /> : <TriangleAlert />}
        <AlertTitle>{blocker.title}</AlertTitle>
        <AlertDescription>
          <p>{blocker.message}</p>
          {refusal && (
            <p className="text-danger-600" data-testid="tool-fix-refused">
              {refusal}
            </p>
          )}
          {fixes.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {fixes.map((fix, i) => (
                <Button key={fix.id} size="sm" variant={i === 0 ? 'default' : 'outline'} onClick={() => run(fix.id)} data-testid={`tool-fix-${fix.id}`}>
                  {fix.id === 'retry-now' ? <RefreshCw data-icon="inline-start" /> : fix.id === 'use-architect-levels' ? <Building2 data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
                  {fix.label}
                </Button>
              ))}
            </div>
          )}
        </AlertDescription>
      </Alert>
    </div>
  )
}
