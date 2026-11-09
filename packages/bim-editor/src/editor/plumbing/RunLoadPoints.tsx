'use client'

import { loadPointsOnHost, type Command, type ModelState, type RunFitting, type RunSegment } from '@permitzip/bim-kernel'
import { Separator } from '../../ui/separator'
import { LoadPointProperties } from './LoadPointProperties'
import { PlaceLoadPoint } from './PlaceLoadPoint'

/** The load points on a selected pipe's ends (each editable), and "Place load point" on an open end that has none. */
export function RunLoadPoints({ model, element, canEdit, onCommand }: { readonly model: ModelState; readonly element: RunSegment | RunFitting; readonly canEdit: boolean; readonly onCommand: (command: Command) => string | null }) {
  if (element.domain === 'conduit') return null
  const points = loadPointsOnHost(model.elements, element.id)
  return (
    <div className="flex flex-col gap-3" data-testid="run-load-points">
      {points.map((lp) => (
        <div key={lp.id} className="flex flex-col gap-3">
          <Separator />
          <LoadPointProperties key={`${lp.id}:${lp.version}`} model={model} point={lp} canEdit={canEdit} onCommand={onCommand} />
        </div>
      ))}
      <PlaceLoadPoint key={`${element.id}:${element.version}:${points.length}`} model={model} element={element} canEdit={canEdit} onCommand={onCommand} />
    </div>
  )
}
