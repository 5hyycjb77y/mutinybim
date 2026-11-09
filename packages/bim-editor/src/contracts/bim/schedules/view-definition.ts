import { type ModelState, type ScheduleDefinitionV2 } from '@permitzip/bim-kernel'
import { scheduleV1ToV2 } from '@permitzip/bim-kernel/schedules'

/** The schedule a view holds, as the v2 engine reads it (null: not a list or v2 schedule view). Panel-style forms open on their sheet. */
export function viewScheduleDefinition(model: Pick<ModelState, 'elements'>, viewId: string): ScheduleDefinitionV2 | null {
  const el = model.elements[viewId]
  if (!el || el.kind !== 'view' || el.deleted) return null
  if (el.props?.scheduleV2) return el.props.scheduleV2
  // A v1 schedule with no title of its own goes by the view's name (v1 printed the category).
  if (el.props?.schedule) return { ...scheduleV1ToV2(el.props.schedule), ...(el.props.schedule.title ? {} : { name: el.name }) }
  return null
}
