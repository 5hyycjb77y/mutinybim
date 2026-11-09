'use client'

import { CircleCheck, TriangleAlert } from 'lucide-react'
import type { PartImportReport } from '@permitzip/bim-kernel'
import { Badge } from '../../ui/badge'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../../ui/empty'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'

/**
 * The connector report for one part type (round 9 J9): every bad connector,
 * named, with what to do next. Shown before a type is saved (Library ›
 * Import, Part editor › Check connectors). Saving is still allowed: the
 * problems show as issues wherever the type is placed.
 */
export function ConnectorReport({ report }: { readonly report: PartImportReport }) {
  if (report.connectorCount === 0) {
    return (
      <Empty className="border" data-testid="connector-report-none">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TriangleAlert />
          </EmptyMedia>
          <EmptyTitle>No connectors</EmptyTitle>
          <EmptyDescription>{report.typeName} has no connectors, so nothing can be joined to it. Add them in the part editor before connecting this part.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  if (report.problems.length === 0) {
    return (
      <Empty className="border" data-testid="connector-report-clean">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CircleCheck />
          </EmptyMedia>
          <EmptyTitle>Every connector checks out</EmptyTitle>
          <EmptyDescription>
            {report.connectorCount === 1 ? 'Its one connector has' : `All ${report.connectorCount} connectors have`} a size, a direction out of the part, a system and an end type where one is needed.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <div className="flex flex-col gap-2" data-testid="connector-report-problems">
      <p className="text-sm">
        {report.problems.length === 1 ? '1 connector problem' : `${report.problems.length} connector problems`} on {report.typeName}. You can still save it; the problems show as issues wherever it is placed.
      </p>
      <ItemGroup className="gap-1" aria-label={`Connector problems on ${report.typeName}`}>
        {report.problems.map((p, i) => (
          <Item key={`${p.connectorId}-${p.check}-${i}`} variant="outline" size="sm">
            <ItemContent>
              <ItemTitle>
                <Badge variant="outline">{p.connectorLabel}</Badge>
                {p.message}
              </ItemTitle>
              <ItemDescription>{p.nextStep}</ItemDescription>
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
    </div>
  )
}
