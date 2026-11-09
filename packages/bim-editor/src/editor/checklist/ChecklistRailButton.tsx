'use client'

import { ListChecks } from 'lucide-react'
import { requirementsOf } from '@permitzip/bim-kernel'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import type { ModelSelector, ModelStore } from '../model-store'
import { useModelSelector } from '../use-model-selector'
import { needsCount } from './checklist-model'

/** How many requirements still need attention; the graph caches per revision, so this is cheap on every edit. */
const selectNeedsCount: ModelSelector<number | null> = (s) => {
  if (!s.model) return null
  try {
    return needsCount(requirementsOf(s.model))
  } catch (err) {
    console.error('[Checklist] counting open requirements failed', err)
    return null
  }
}

/** Rail › Checklist, with the number of requirements that still need something. */
export function ChecklistRailButton({ store, onOpen }: { store: ModelStore; onOpen: () => void }) {
  const count = useModelSelector(store, selectNeedsCount)
  return (
    <Button variant="outline" size="sm" className="justify-start" onClick={onOpen} data-testid="rail-checklist">
      <ListChecks data-icon="inline-start" />
      Checklist
      {count !== null && count > 0 && (
        <Badge variant="secondary" className="ml-auto" data-testid="rail-checklist-count">
          {count}
        </Badge>
      )}
    </Button>
  )
}
