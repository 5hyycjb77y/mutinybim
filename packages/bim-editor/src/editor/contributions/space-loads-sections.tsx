'use client'

import { AddonComponent, useContributionsVersion } from './AddonComponent'
import { componentContributions } from './registry'
import { SPACE_LOADS_SECTION } from './slots'
import type { SpaceLoadsSectionProps } from './types'

/** Every add-on's sections of a space's Properties › Loads (`space-loads-section`), each behind `import()` with its loading line, or its error and Retry. */
export function SpaceLoadsSections(props: SpaceLoadsSectionProps) {
  useContributionsVersion()
  return (
    <>
      {componentContributions(SPACE_LOADS_SECTION).map((c) => (
        <AddonComponent key={c.id} contribution={c} props={props} />
      ))}
    </>
  )
}
