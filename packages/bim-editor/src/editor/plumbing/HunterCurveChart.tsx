'use client'

import { CartesianGrid, Line, LineChart, ReferenceDot, XAxis, YAxis } from 'recharts'
import type { HunterChart } from '@permitzip/bim-pack-plumbing'
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '../../ui/chart'

const COLOURS = ['hsl(var(--chart-1))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))', 'hsl(var(--chart-4))', 'hsl(var(--chart-5))']

/**
 * The modified Hunter's curve chart: fixture units against gpm for each
 * demand curve, the curves the model uses drawn heavier, and each water
 * system's design point marked with its reading (the product owner's "where we fall on
 * that curve").
 */
export function HunterCurveChart({ chart, className, only }: { chart: HunterChart; className?: string; only?: readonly string[] }) {
  const curves = only ? chart.curves.filter((c) => only.includes(c.id)) : chart.curves
  const points = only ? chart.points.filter((p) => only.includes(p.curveId)) : chart.points
  const config: ChartConfig = Object.fromEntries(curves.map((c, i) => [c.id, { label: c.label, color: COLOURS[i % COLOURS.length] }]))
  return (
    <ChartContainer config={config} className={className ?? 'h-[320px] w-full'} data-testid="hunter-curve-chart">
      <LineChart margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis type="number" dataKey="wsfu" domain={[0, chart.axes.xMax]} label={{ value: chart.axes.x, position: 'insideBottom', offset: -4 }} allowDuplicatedCategory={false} />
        <YAxis type="number" dataKey="gpm" domain={[0, chart.axes.yMax]} label={{ value: chart.axes.y, angle: -90, position: 'insideLeft' }} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        {curves.map((c) => (
          <Line key={c.id} name={c.id} data={c.points.map((p) => ({ wsfu: p.wsfu, gpm: p.gpm }))} dataKey="gpm" stroke={`var(--color-${c.id})`} strokeWidth={c.used ? 2.5 : 1} strokeOpacity={c.used ? 1 : 0.55} dot={false} isAnimationActive={false} />
        ))}
        {points.map((p) => (
          <ReferenceDot key={p.systemId} x={p.wsfu} y={p.gpm} r={5} fill={`var(--color-${p.curveId})`} stroke="hsl(var(--foreground))" label={{ value: `${p.systemName}: ${p.wsfu} WSFU, ${p.gpm} gpm`, position: 'top', fontSize: 11 }} />
        ))}
      </LineChart>
    </ChartContainer>
  )
}
