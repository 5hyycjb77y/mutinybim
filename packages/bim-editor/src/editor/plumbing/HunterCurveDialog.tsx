'use client'

import { useMemo } from 'react'
import { CircleAlert } from 'lucide-react'
import { hunterChart } from '@permitzip/bim-pack-plumbing'
import type { ModelState } from '@permitzip/bim-kernel'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../../ui/empty'
import { FieldDescription } from '../../ui/field'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table'
import { HunterCurveChart } from './HunterCurveChart'

/** Plumbing › Sizing › Hunter curve: the demand curves and where each domestic water system falls on its curve, live from the model. */
export function HunterCurveDialog({ open, onOpenChange, model }: { open: boolean; onOpenChange: (open: boolean) => void; model: ModelState }) {
  const chart = useMemo(() => hunterChart(model), [model])
  const curveLabel = new Map(chart.curves.map((c) => [c.id, c.label]))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" data-testid="hunter-curve-dialog">
        <DialogHeader>
          <DialogTitle>{chart.title}</DialogTitle>
          <DialogDescription>Estimated water demand from fixture units on each curve, and each water system&apos;s design point: the fixture units at its source and the gpm its curve reads there.</DialogDescription>
        </DialogHeader>
        <HunterCurveChart chart={chart} />
        {chart.points.length === 0 ? (
          <Empty className="border py-3">
            <EmptyHeader>
              <EmptyTitle>No design points yet</EmptyTitle>
              <EmptyDescription>Route domestic water pipe to fixtures or load points with water supply fixture units, and each system&apos;s point appears on its curve.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table data-testid="hunter-curve-points">
            <TableCaption className="sr-only">Design points</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>System</TableHead>
                <TableHead>Curve</TableHead>
                <TableHead className="text-right">Total WSFU</TableHead>
                <TableHead className="text-right">Total gpm</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {chart.points.map((p) => (
                <TableRow key={p.systemId}>
                  <TableCell>{p.systemName}</TableCell>
                  <TableCell>{curveLabel.get(p.curveId) ?? p.curveId}</TableCell>
                  <TableCell className="text-right">{p.wsfu}</TableCell>
                  <TableCell className="text-right">{p.gpm}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {chart.missing.map((m) => (
          <Alert key={m.systemName}>
            <CircleAlert />
            <AlertTitle>{m.systemName} has no demand curve</AlertTitle>
            <AlertDescription>{m.reason}</AlertDescription>
          </Alert>
        ))}
        <FieldDescription className="text-xs">{chart.source}. Choose the curve in Plumbing › Analyze › Demand curve, or per system in Plumbing › Systems.</FieldDescription>
      </DialogContent>
    </Dialog>
  )
}
