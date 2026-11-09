import type { GroupVisibility, PhaseDisplay, PhaseStatus } from '@permitzip/bim-kernel'

/** Operator words for groups, phases and phase filters, shared by every organization control. */

export const GROUP_VISIBILITY_LABEL: Record<GroupVisibility, string> = {
  show: 'Show',
  halftone: 'Halftone',
  hide: 'Hide',
}

export const PHASE_DISPLAY_LABEL: Record<PhaseDisplay, string> = {
  show: 'Show',
  halftone: 'Halftone',
  dashed: 'Dashed',
  hide: 'Hide',
}

export const PHASE_STATUS_LABEL: Record<PhaseStatus, { readonly label: string; readonly hint: string }> = {
  new: { label: 'New', hint: 'Built in the phase the view shows' },
  existing: { label: 'Existing', hint: 'Built in an earlier phase and still there' },
  demolished: { label: 'Demolished', hint: 'Removed in the phase the view shows' },
  temporary: { label: 'Temporary', hint: 'Built and removed in the phase the view shows' },
}

/** Where the organization lists live, as a path people can follow. */
export const MANAGE_PATH = 'Manage › Groups & phases'
