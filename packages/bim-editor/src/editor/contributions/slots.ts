import type { ComponentContribution, ComponentSlot, InspectorSectionProps, PartSectionProps, RailSectionProps, RouteSectionProps, RunSectionProps, SpaceLoadsSectionProps, WorkflowHostProps } from './types'

/** The host's component slots (`types.ts` says what each is given). */
export const INSPECTOR_SECTION: ComponentSlot<InspectorSectionProps> = { kind: 'inspector-section' }
export const RAIL_SECTION: ComponentSlot<RailSectionProps> = { kind: 'rail' }
export const RUN_SECTION: ComponentSlot<RunSectionProps> = { kind: 'run-section' }
export const PART_SECTION: ComponentSlot<PartSectionProps> = { kind: 'part-section' }
export const ROUTE_SECTION: ComponentSlot<RouteSectionProps> = { kind: 'route-section' }
export const SPACE_LOADS_SECTION: ComponentSlot<SpaceLoadsSectionProps> = { kind: 'space-loads-section' }
export const WORKFLOW_HOST: ComponentSlot<WorkflowHostProps> = { kind: 'workflow-host' }

/** Builds a component contribution, keeping its props tied to its slot. */
export function componentContribution<P>(c: ComponentContribution<P>): ComponentContribution<never> {
  return c as unknown as ComponentContribution<never>
}
