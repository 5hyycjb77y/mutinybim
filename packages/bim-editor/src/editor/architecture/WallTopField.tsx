'use client'

import { editableLinePlacement, elementsOfKind, topLevelOf, type BimElement, type Command, type LinePlacement, type ModelState, type SurfaceBinding } from '@permitzip/bim-kernel'
import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '../../ui/select'
import { parseFeet } from '../parse-feet'
import { feetInches } from '../placement'
import type { SubmitCommand } from '../views-sheets/types'

const UNCONNECTED = '__unconnected__'
const ON_LEVEL = '__level__'
const FT_MM = 304.8

/** The surfaces a wall's top can run to, as the Top list says them. */
const TOP_SURFACES = [
  { to: 'structure', label: 'Underside of slab above', words: 'the underside of the slab above', follows: 'that floor’s level and thickness' },
  { to: 'ceiling', label: 'To ceiling', words: 'the ceiling', follows: 'the ceiling’s height' },
  { to: 'roof', label: 'To roof', words: 'the underside of the roof', follows: 'the roof, sloped where the roof is' },
] as const
type TopSurface = (typeof TOP_SURFACES)[number]['to']

const surfaceValue = (to: string) => `surface:${to}`

type Props = {
  readonly model: ModelState
  readonly el: BimElement
  readonly submit: SubmitCommand
  readonly editBlocked: string | null
  readonly notify: (message: string, kind?: 'info' | 'error') => void
  /** The model server stores wall tops tied to a level; absent: it does. */
  readonly tiesStored?: boolean
  /** The model server stores tops and bases bound to surfaces (`walls:surface_binding`); absent: it does. */
  readonly surfacesStored?: boolean
}

const OLD_SERVER = 'Up to a level needs a newer model server; this one keeps only a set height. Type the height below.'
const OLD_SURFACE_SERVER = 'Running to a slab, ceiling or roof needs a newer model server; this one keeps a level or a set height.'

export type WallTopChoice = { readonly topLevelId: string; readonly offsetMm?: number } | { readonly surface: TopSurface; readonly offsetMm?: number } | { readonly heightMm: number }
export type WallBaseChoice = { readonly on: 'level' | 'floor'; readonly offsetMm?: number }

/** The placement less its top, and the top offset the person set (kept when they pick another top). */
function splitTop(p: LinePlacement): { readonly untied: LinePlacement; readonly offsetMm: number | undefined } {
  const { topLevelId: _top, topOffsetMm, topSurface, ...untied } = p
  return { untied, offsetMm: topOffsetMm ?? topSurface?.offsetMm }
}

/**
 * What a wall's top does: run up to a level above or to a surface over it
 * (the slab above's underside, a ceiling, a roof), its height following it,
 * or stay at a set height. The offset already set is kept when the person
 * picks another top. The command for each choice; a string says why it can't
 * be made.
 */
export function wallTopCommand(model: ModelState, el: BimElement, choice: WallTopChoice): Command | string {
  const p = editableLinePlacement(el, model.elements)
  if (!p) return 'This wall has no level to measure its top from; move it onto a level first'
  const { untied, offsetMm: kept } = splitTop(p)
  if ('heightMm' in choice) {
    if (!(choice.heightMm > 0)) return 'A wall needs a height above zero'
    return { type: 'set_element_placement', elementId: el.id, placement: untied, heightMm: Math.round(choice.heightMm) }
  }
  const offsetMm = Math.round(choice.offsetMm ?? kept ?? 0)
  if ('topLevelId' in choice) return { type: 'set_element_placement', elementId: el.id, placement: { ...untied, topLevelId: choice.topLevelId, ...(offsetMm ? { topOffsetMm: offsetMm } : {}) } }
  const topSurface: SurfaceBinding = { to: choice.surface, ...(offsetMm ? { offsetMm } : {}) }
  return { type: 'set_element_placement', elementId: el.id, placement: { ...untied, topSurface } }
}

/** What a wall's base does: stand on its level (raised by the offset) or on the top of the floor under it. */
export function wallBaseCommand(model: ModelState, el: BimElement, choice: WallBaseChoice): Command | string {
  const p = editableLinePlacement(el, model.elements)
  if (!p) return 'This wall has no level to stand on; move it onto a level first'
  const { baseSurface, ...rest } = p
  const offsetMm = Math.round(choice.offsetMm ?? baseSurface?.offsetMm ?? (baseSurface ? 0 : p.startOffsetMm))
  if (choice.on === 'floor') return { type: 'set_element_placement', elementId: el.id, placement: { ...rest, baseSurface: { to: 'floor', ...(offsetMm ? { offsetMm } : {}) } } }
  return { type: 'set_element_placement', elementId: el.id, placement: { ...rest, startOffsetMm: offsetMm, endOffsetMm: offsetMm } }
}

/** A wall height as typed (10'-0", 9 ft 6 in, 108", 9.5), in mm; or why it doesn't read as one. */
export function parseWallHeight(text: string): { readonly mm: number } | { readonly why: string } {
  // 10'-0": the dash between feet and inches is how heights are written, not a minus.
  const ft = parseFeet(text.replace(/'\s*-\s*/, "' "))
  if (ft === null || ft <= 0) return { why: `"${text.trim()}" doesn't read as a height. Type feet and inches: 10'-0", 9 ft 6 in, 108".` }
  return { mm: Math.round(ft * FT_MM * 10) / 10 }
}

/** A typed offset in feet and inches as mm, or null. A leading minus is below; the dash between feet and inches is not. */
function typedMm(text: string): number | null {
  const ft = parseFeet(text.trim().replace(/'\s*-\s*/, "' "))
  return ft === null ? null : ft * FT_MM
}

/** How tall a wall is, in words: one height, or the range a sloped or stepped top gives. */
function tallWords(el: BimElement): string {
  if (el.kind !== 'wall') return ''
  const profile = el.bodyProfile
  if (!profile || profile.length < 2) return `${feetInches(el.height)} tall`
  const spans = profile.map((q) => q.topMm - q.baseMm)
  return `${feetInches(Math.min(...spans))} to ${feetInches(Math.max(...spans))} tall`
}

const offsetWords = (mm: number | undefined, from: string): string => (mm ? `, ${feetInches(Math.abs(mm))} ${mm > 0 ? 'above' : 'below'} ${from}` : '')

/** A feet-and-inches box that writes on Enter or when it loses focus; Esc puts back what is stored. */
function LengthBox({ id, label, testId, mm, disabled, onCommit }: { readonly id: string; readonly label: string; readonly testId: string; readonly mm: number; readonly disabled: boolean; readonly onCommit: (text: string) => void }): ReactNode {
  const shown = feetInches(mm)
  const [text, setText] = useState(shown)
  const [synced, setSynced] = useState(shown)
  if (synced !== shown) {
    setSynced(shown)
    setText(shown)
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      onCommit(text)
    } else if (e.key === 'Escape') setText(shown)
  }
  return (
    <Input
      id={id}
      className="h-8 w-28"
      aria-label={label}
      data-testid={testId}
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text.trim() !== shown) onCommit(text)
      }}
      onKeyDown={onKey}
    />
  )
}

export function WallTopField({ model, el, submit, editBlocked, notify, tiesStored = true, surfacesStored = true }: Props): ReactNode {
  const [why, setWhy] = useState<string | null>(null)
  const p = editableLinePlacement(el, model.elements)
  if (el.kind !== 'wall') return null
  const height = el.height
  const base = p ? model.elements[p.levelId] : undefined
  const baseZ = base?.kind === 'level' ? base.elevationMm : null
  const above = baseZ === null ? [] : elementsOfKind(model.elements, 'level').filter((l) => l.elevationMm > baseZ + 1).sort((a, b) => a.elevationMm - b.elevationMm)
  const top = topLevelOf(el, model.elements)
  const surface = p?.topSurface ? TOP_SURFACES.find((s) => s.to === p.topSurface?.to) : undefined
  const offsetMm = p?.topOffsetMm ?? p?.topSurface?.offsetMm ?? 0
  const blocked = editBlocked ?? (p ? null : 'This wall has no level to measure its top from; move it onto a level first')
  const value = surface ? surfaceValue(surface.to) : top ? top.id : UNCONNECTED

  const send = (choice: WallTopChoice, label: string): void => {
    const command = wallTopCommand(model, el, choice)
    if (typeof command === 'string') {
      setWhy(command)
      return
    }
    const err = submit(command, label)
    if (err) {
      console.error('[WallTopField] wall top change refused', { elementId: el.id, err })
      setWhy(err)
      notify(err, 'error')
      return
    }
    setWhy(null)
  }
  const commitHeight = (text: string) => {
    const parsed = parseWallHeight(text)
    if ('why' in parsed) return setWhy(parsed.why)
    send({ heightMm: parsed.mm }, 'Set the wall height')
  }
  const commitOffset = (text: string) => {
    const mm = typedMm(text)
    if (mm === null) return setWhy(`"${text.trim()}" doesn't read as an offset. Type feet and inches, with a minus for below: -0'-6", 1 ft.`)
    if (surface) send({ surface: surface.to, offsetMm: mm }, 'Set the wall top offset')
    else if (top) send({ topLevelId: top.id, offsetMm: mm }, 'Set the wall top offset')
  }

  const words = why ??
    blocked ??
    (!tiesStored && !top
      ? OLD_SERVER
      : surface
        ? `Runs to ${surface.words}${offsetWords(offsetMm, 'it')}: ${tallWords(el)}. It follows ${surface.follows}.`
        : top
          ? `Runs up to ${top.name}${offsetWords(offsetMm, top.name)}: ${tallWords(el)}. It follows ${top.name} and its own level when either moves.`
          : above.length > 0
            ? `${tallWords(el)}, not tied to a level. Pick "Up to ${above[0]?.name ?? 'the level above'}" to make it follow that level${surfacesStored ? ', or run it to the slab above, a ceiling or a roof' : ''}.`
            : `${tallWords(el)}. There is no level above this one to run up to.`) +
      (!surfacesStored && !why && !blocked ? ` ${OLD_SURFACE_SERVER}` : '')

  return (
    <Field data-testid="architecture-wall-top" data-top-level={top?.name ?? ''} data-top={surface ? surface.to : top ? 'level' : 'height'}>
      <FieldLabel htmlFor="architecture-wall-top">Top</FieldLabel>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={value}
          disabled={blocked !== null}
          onValueChange={(v) => {
            setWhy(null)
            if (v === UNCONNECTED) send({ heightMm: height }, 'Untie the wall top')
            else if (v.startsWith('surface:')) {
              const to = TOP_SURFACES.find((s) => surfaceValue(s.to) === v)
              if (to) send({ surface: to.to }, `Run the wall to ${to.words}`)
            } else send({ topLevelId: v }, 'Run the wall up to a level')
          }}
        >
          <SelectTrigger id="architecture-wall-top" aria-label="Where the wall's top is">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {above.length > 0 ? (
              <SelectGroup>
                {above.map((l) => (
                  <SelectItem key={l.id} value={l.id} disabled={!tiesStored}>
                    Up to {l.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            ) : null}
            <SelectSeparator />
            <SelectGroup>
              {TOP_SURFACES.map((s) => (
                <SelectItem key={s.to} value={surfaceValue(s.to)} disabled={!surfacesStored} data-testid={`architecture-wall-top-${s.to}`}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectGroup>
            <SelectSeparator />
            <SelectGroup>
              <SelectItem value={UNCONNECTED}>Unconnected (set height)</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        {top || surface ? (
          <LengthBox id="architecture-wall-top-offset" label="Top offset" testId="architecture-wall-top-offset" mm={offsetMm} disabled={blocked !== null} onCommit={commitOffset} />
        ) : (
          <LengthBox id="architecture-wall-height" label="Wall height" testId="architecture-wall-height" mm={height} disabled={blocked !== null} onCommit={commitHeight} />
        )}
      </div>
      <FieldDescription data-testid="architecture-wall-top-words">{words}</FieldDescription>
    </Field>
  )
}

export function WallBaseField({ model, el, submit, editBlocked, notify, surfacesStored = true }: Props): ReactNode {
  const [why, setWhy] = useState<string | null>(null)
  const p = editableLinePlacement(el, model.elements)
  if (el.kind !== 'wall') return null
  const level = p ? model.elements[p.levelId] : undefined
  const levelName = level?.kind === 'level' ? level.name : 'its level'
  const onFloor = p?.baseSurface?.to === 'floor'
  const offsetMm = onFloor ? (p?.baseSurface?.offsetMm ?? 0) : (p?.startOffsetMm ?? 0)
  const blocked = editBlocked ?? (p ? null : 'This wall has no level to stand on; move it onto a level first')

  const send = (choice: WallBaseChoice, label: string): void => {
    const command = wallBaseCommand(model, el, choice)
    if (typeof command === 'string') {
      setWhy(command)
      return
    }
    const err = submit(command, label)
    if (err) {
      console.error('[WallBaseField] wall base change refused', { elementId: el.id, err })
      setWhy(err)
      notify(err, 'error')
      return
    }
    setWhy(null)
  }
  const commitOffset = (text: string) => {
    const mm = typedMm(text)
    if (mm === null) return setWhy(`"${text.trim()}" doesn't read as an offset. Type feet and inches, with a minus for below: 0'-6", -1 ft.`)
    send({ on: onFloor ? 'floor' : 'level', offsetMm: mm }, 'Set the wall base offset')
  }
  const words =
    why ??
    blocked ??
    (onFloor
      ? `Stands on the top of the floor under it${offsetWords(offsetMm, 'it')}. It follows that floor.`
      : `Stands on ${levelName}${offsetWords(offsetMm, levelName)}.${surfacesStored ? '' : ` ${OLD_SURFACE_SERVER}`}`)

  return (
    <Field data-testid="architecture-wall-base" data-base={onFloor ? 'floor' : 'level'}>
      <FieldLabel htmlFor="architecture-wall-base">Base</FieldLabel>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={onFloor ? 'floor' : ON_LEVEL}
          disabled={blocked !== null}
          onValueChange={(v) => {
            setWhy(null)
            send({ on: v === 'floor' ? 'floor' : 'level' }, v === 'floor' ? 'Stand the wall on the floor under it' : `Stand the wall on ${levelName}`)
          }}
        >
          <SelectTrigger id="architecture-wall-base" aria-label="Where the wall's base is">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ON_LEVEL}>On {levelName}</SelectItem>
              <SelectItem value="floor" disabled={!surfacesStored} data-testid="architecture-wall-base-floor">
                Top of slab below
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <LengthBox id="architecture-wall-base-offset" label="Base offset" testId="architecture-wall-base-offset" mm={offsetMm} disabled={blocked !== null} onCommit={commitOffset} />
      </div>
      <FieldDescription data-testid="architecture-wall-base-words">{words}</FieldDescription>
    </Field>
  )
}
