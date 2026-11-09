'use client'

import { useMemo } from 'react'
import { bagSummary, catalogKey, connectionTypeSummary, connectionTypeTrade, connectionTypes, type CatalogTrade, type ConnectionTypeEntry, type ModelState } from '@permitzip/bim-kernel'
import { PLUMBING_STARTER_CONNECTION_TYPES } from '@permitzip/bim-pack-plumbing/host'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '../../ui/select'

export const NO_CONNECTION_TYPE = '__none__'

/**
 * The connection types a trade's picker lists. Electrical: electrical records
 * and any record with an electrical load (a dishwasher's one record has hot
 * water, waste and 120 V). Plumbing, gas, mechanical: every non-electrical
 * record (a pipe end can be any of them), the trade's own first.
 */
export function connectionTypesFor(model: Pick<ModelState, 'elements'>, trade: CatalogTrade): readonly ConnectionTypeEntry[] {
  const all = connectionTypes(model).map((r) => r.entry)
  if (trade === 'electrical') return all.filter((e) => connectionTypeTrade(e) === 'electrical' || e.loadVa > 0)
  const others = all.filter((e) => connectionTypeTrade(e) !== 'electrical')
  return [...others.filter((e) => connectionTypeTrade(e) === trade), ...others.filter((e) => connectionTypeTrade(e) !== trade)]
}

/** What a connection type is, in a line: its description, else its loads. */
export function connectionTypeLine(entry: ConnectionTypeEntry): string {
  if (connectionTypeTrade(entry) === 'electrical') return entry.description || connectionTypeSummary(entry)
  return entry.description || bagSummary(entry.quantities ?? {})
}

/**
 * Pick a connection type for one trade. Plumbing and gas also list the
 * starter types the project doesn't have yet ("added with it, verify for
 * permit work"), so a first load point needs no catalog set-up.
 */
export function ConnectionTypeSelect({
  model,
  trade,
  value,
  onChange,
  id,
  disabled,
  noneLabel,
  testId,
}: {
  readonly model: ModelState
  readonly trade: CatalogTrade
  readonly value: string
  readonly onChange: (designator: string) => void
  readonly id: string
  readonly disabled?: boolean
  /** Shown for "no connection type" (absent: not offered). */
  readonly noneLabel?: string
  readonly testId?: string
}) {
  const project = useMemo(() => connectionTypesFor(model, trade), [model, trade])
  const starters = useMemo(() => {
    if (trade === 'electrical') return []
    const have = new Set(connectionTypes(model).map((r) => catalogKey(r.entry.designator)))
    return PLUMBING_STARTER_CONNECTION_TYPES.filter((e) => !have.has(catalogKey(e.designator)) && (trade === 'mechanical' ? false : trade === 'gas' ? connectionTypeTrade(e) === 'gas' : true))
  }, [model, trade])
  const known = value === NO_CONNECTION_TYPE || project.some((e) => catalogKey(e.designator) === catalogKey(value)) || starters.some((e) => catalogKey(e.designator) === catalogKey(value))
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} size="sm" className="w-full" data-testid={testId}>
        <SelectValue placeholder="Pick a connection type" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {noneLabel && <SelectItem value={NO_CONNECTION_TYPE}>{noneLabel}</SelectItem>}
          {!known && value !== '' && <SelectItem value={value}>{value} (not in the project&apos;s types)</SelectItem>}
          {project.map((e) => (
            <SelectItem key={e.designator} value={e.designator}>
              {e.designator} · {connectionTypeLine(e)}
            </SelectItem>
          ))}
        </SelectGroup>
        {starters.length > 0 && (
          <SelectGroup>
            <SelectLabel>Starter types (added with it, verify for permit work)</SelectLabel>
            {starters.map((e) => (
              <SelectItem key={e.designator} value={e.designator}>
                {e.designator} · {connectionTypeLine(e)}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  )
}
