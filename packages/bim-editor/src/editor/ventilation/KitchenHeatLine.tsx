'use client'

import { useMemo } from 'react'
import { CircleAlert, Flame } from 'lucide-react'
import type { ElementId, ModelState } from '@permitzip/bim-kernel'
import { spaceHeatGainNeed, type SpaceHeatGainNeed } from '@permitzip/bim-pack-mechanical'
import { Alert, AlertDescription } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Spinner } from '../../ui/spinner'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { useKitchenHeatTablesFrom, type KitchenHeatTables } from './kitchen-heat-client'

interface Props {
  readonly model: ModelState
  readonly spaceId: ElementId
  /** The project whose own tables win over the firm's; absent: the firm's only. */
  readonly projectId?: string | null
  /** Tables the host already read (a list of spaces shares one read). Absent: read here. */
  readonly tables?: KitchenHeatTables
}

/** The need as one line, from tables already read; null when no kitchen appliance stands in the space. */
export function kitchenHeatNeedFor(model: ModelState, spaceId: ElementId, tables: KitchenHeatTables): SpaceHeatGainNeed | null {
  return spaceHeatGainNeed(model.elements, spaceId, { firm: tables.firm, project: tables.project })
}

/**
 * Space › Properties › Loads: the heat the space's kitchen equipment adds,
 * "Kitchen heat 18,400 Btu/h (firm table)" with the table's row and citation
 * under it, or where to add the table. Nothing shows for a space with no
 * kitchen appliance.
 */
export function KitchenHeatLine({ model, spaceId, projectId, tables: given }: Props) {
  const read = useKitchenHeatTablesFrom(useEditorHost().data.firmLibrary, given ? undefined : projectId)
  const tables = given ?? read
  const need = useMemo(() => (tables.status === 'ready' ? kitchenHeatNeedFor(model, spaceId, tables) : null), [model, spaceId, tables])

  if (tables.status === 'loading') {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="kitchen-heat-loading">
        <Spinner />
        Reading the kitchen heat table…
      </p>
    )
  }
  if (tables.status === 'error') {
    return (
      <Alert data-testid="kitchen-heat-error">
        <CircleAlert />
        <AlertDescription className="flex flex-col items-start gap-2">
          {tables.error}
          <Button size="sm" variant="outline" onClick={tables.retry}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    )
  }
  if (!need) return null
  return (
    <div className="flex flex-col gap-1 text-sm" data-testid="kitchen-heat-line" data-state={need.state}>
      <p className="flex items-center gap-2 font-medium">
        <Flame aria-hidden="true" />
        <span>{need.line}</span>
      </p>
      {need.detail ? <p className="text-xs text-muted-foreground">{need.detail}</p> : null}
      {need.state === 'needs_table' ? <p className="text-xs text-muted-foreground">{need.partIds.length === 1 ? 'One kitchen appliance stands here' : `${need.partIds.length} kitchen appliances stand here`}; nothing is added until the table has their rows.</p> : null}
      {need.missing.map((m) => (
        <p key={m} className="text-xs text-warning-700" data-testid="kitchen-heat-missing">
          {m}
        </p>
      ))}
    </div>
  )
}
