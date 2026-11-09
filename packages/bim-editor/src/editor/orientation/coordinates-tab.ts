import type { OriginPoint } from '@permitzip/bim-kernel'
import type { CoordinatesTopic } from './CoordinatesDiagram'

/** The Coordinates dialog's tabs: one idea each. */
export type CoordinatesTab = CoordinatesTopic

/** The tab that shows a marker point. */
export function tabForPoint(point: OriginPoint): CoordinatesTab {
  return point === 'survey_point' ? 'site_point' : 'origin'
}
