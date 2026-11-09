'use client'

import { useState } from 'react'
import { CalendarIcon, X } from 'lucide-react'
import { formatParameterValue, isoDateOf, type ProjectParameterDef } from '@permitzip/bim-kernel'
import { Button } from '../../ui/button'
import { ButtonGroup } from '../../ui/button-group'
import { Calendar } from '../../ui/calendar'
import { Input } from '../../ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'

/** The "not set" item of a choice list (a Select item can't carry an empty value). */
const UNSET = '__unset__'

/** A local calendar day as YYYY-MM-DD (the picker's day, not the UTC one). */
export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function dayOf(iso: string): Date | undefined {
  const day = isoDateOf(iso)
  if (!day) return undefined
  return new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)))
}

/**
 * One project parameter (or a sheet's own value of it) as its type asks: a
 * date picker for a date, a list for a choice, a box for text. `value` is the
 * stored form (dates YYYY-MM-DD); "" is not set, and `fallback` says what
 * prints then (the project's value on a sheet).
 */
export function ParameterInput({ def, id, value, onChange, fallback, disabled }: { def: ProjectParameterDef; id: string; value: string; onChange: (value: string) => void; fallback?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  if (def.valueType === 'date') {
    const selected = dayOf(value)
    return (
      <ButtonGroup className="w-full">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button id={id} type="button" variant="outline" disabled={disabled} className="flex-1 justify-start font-normal" aria-label={`${def.label}: ${value ? formatParameterValue(def, value) : fallback ? `from the project, ${fallback}` : 'not set'}`}>
              <CalendarIcon data-icon="inline-start" />
              {value ? formatParameterValue(def, value) : <span className="text-muted-foreground">{fallback ? `From project: ${fallback}` : 'Pick a date'}</span>}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              captionLayout="dropdown"
              selected={selected}
              defaultMonth={selected ?? new Date()}
              onSelect={(day) => {
                if (!day) return
                onChange(isoDay(day))
                setOpen(false)
              }}
            />
            <div className="flex justify-end gap-2 border-t p-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  onChange(isoDay(new Date()))
                  setOpen(false)
                }}
              >
                Today
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        {value && (
          <Button type="button" variant="outline" size="icon" disabled={disabled} onClick={() => onChange('')} aria-label={`Clear ${def.label}`}>
            <X />
          </Button>
        )}
      </ButtonGroup>
    )
  }
  if (def.valueType === 'choice') {
    return (
      <Select value={value || UNSET} onValueChange={(v) => onChange(v === UNSET ? '' : v)} disabled={disabled}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value={UNSET}>{fallback ? `From project: ${fallback}` : 'Not set'}</SelectItem>
            {(def.choices ?? []).map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    )
  }
  return <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} maxLength={200} disabled={disabled} placeholder={fallback ? `From project: ${fallback}` : def.hint} />
}
