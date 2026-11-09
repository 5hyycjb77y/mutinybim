'use client'

import { AddonComponent, useContributionsVersion } from './AddonComponent'
import { componentContributions } from './registry'
import { ROUTE_SECTION } from './slots'
import type { RouteSectionProps } from './types'

/** Every add-on's sections of the Route tool's form (`route-section`), each behind `import()` with its loading line, or its error and Retry. */
export function RouteSections(props: RouteSectionProps) {
  useContributionsVersion()
  return (
    <>
      {componentContributions(ROUTE_SECTION).map((c) => (
        <AddonComponent key={c.id} contribution={c} props={props} />
      ))}
    </>
  )
}
