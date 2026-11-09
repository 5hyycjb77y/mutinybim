'use client'

import { Droplets, Flame } from 'lucide-react'
import { Checkbox } from '../../ui/checkbox'
import { Label } from '../../ui/label'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '../../ui/item'
import { proposalTotals, type RowLoadProposal } from './plan-equipment'

interface Props {
  readonly proposals: readonly RowLoadProposal[]
  /** Proposal keys the engineer unticked. */
  readonly declined: ReadonlySet<string>
  readonly onToggle: (key: string, accept: boolean) => void
  readonly disabledReason: string | null
}

function what(p: RowLoadProposal): string {
  const l = p.load
  if (l.kind === 'gas') return `Gas ${l.mbh ?? 0} MBH (${l.cfh ?? 0} CFH)`
  const parts = [l.wsfuTotal !== null ? `${l.wsfuTotal} WSFU` : null, l.dfu !== null ? `${l.dfu} DFU` : null].filter(Boolean)
  return parts.length > 0 ? `Water and drain: ${parts.join(', ')}` : 'Water and drain connections'
}

/**
 * The plumbing and gas loads the pasted list would add (ROADMAP F4), each one
 * ticked by default and shown with where its numbers come from. Added with the
 * planned items as one change, so one Undo takes both back.
 */
export function ProposedLoadsPanel({ proposals, declined, onToggle, disabledReason }: Props) {
  if (proposals.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="equipment-list-loads-none">
        No plumbing or gas loads in this list: no row gives gas MBH, fixture units or water and waste sizes, or names a fixture such as a dishwasher, sink or gas fryer.
      </p>
    )
  }
  const accepted = new Set(proposals.filter((p) => !declined.has(p.key)).map((p) => p.key))
  const t = proposalTotals(proposals, accepted)
  return (
    <section className="flex flex-col gap-2" data-testid="equipment-list-loads" aria-label="Plumbing and gas loads">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">Plumbing and gas loads</h3>
        <span className="text-xs text-muted-foreground" data-testid="equipment-list-loads-total">
          {accepted.size === 0 ? 'None ticked: the items are added without plumbing or gas loads' : `Adds ${t.count} load${t.count === 1 ? '' : 's'}: ${t.cfh} CFH gas, ${t.wsfu} WSFU, ${t.dfu} DFU`}
        </span>
      </div>
      <ItemGroup className="max-h-56 overflow-auto rounded-md border">
        {proposals.map((p) => {
          const on = !declined.has(p.key)
          const id = `bm-equipment-load-${p.key.replace(/[^A-Za-z0-9_-]/g, '-')}`
          return (
            <Item key={p.key} size="sm" data-testid="equipment-list-load" data-kind={p.load.kind}>
              <ItemMedia variant="icon">{p.load.kind === 'gas' ? <Flame /> : <Droplets />}</ItemMedia>
              <ItemContent>
                <ItemTitle>
                  <Label htmlFor={id} className="font-medium">
                    {p.mark || 'No mark'} {p.description ? `· ${p.description}` : ''} — {what(p)}
                    {p.quantity > 1 ? ` each, ×${p.quantity}` : ''}
                  </Label>
                </ItemTitle>
                <ItemDescription>{p.load.basis}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Checkbox id={id} checked={on} onCheckedChange={(v) => onToggle(p.key, v === true)} disabled={disabledReason !== null} title={disabledReason ?? undefined} aria-label={`Add the ${p.load.kind === 'gas' ? 'gas' : 'plumbing'} load for ${p.mark || 'this row'}`} data-testid={`equipment-list-load-toggle-${p.load.kind}`} />
              </ItemActions>
            </Item>
          )
        })}
      </ItemGroup>
    </section>
  )
}
