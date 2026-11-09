'use client'

import type { PackSet } from '@permitzip/bim-kernel/packs'
import { SelectGroup, SelectItem } from '../../ui/select'
import { linkedDisciplineChoices } from '../../contracts/building-model/linked-contract'

/**
 * What a linked model can show: the host's four, then every discipline the
 * open model's registry has (add-on and firm rows included), labelled and
 * coloured from it. `set`: the model's registry (built-in and first-party
 * when absent). `current`: the picked value, kept listed if the set lacks it.
 */
export function LinkedDisciplineSelectItems({ set, current }: { readonly set?: PackSet; readonly current?: string }) {
  return (
    <SelectGroup>
      {linkedDisciplineChoices(set, current).map((d) => (
        <SelectItem key={d.value} value={d.value}>
          {d.colour ? <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: d.colour }} /> : <span aria-hidden className="size-2.5 shrink-0 rounded-full border border-border" />}
          {d.label}
        </SelectItem>
      ))}
    </SelectGroup>
  )
}
