'use client'

import { type ViewElement, type ViewPropsPatch } from '@permitzip/bim-kernel'
import { resolveCircuitGraphics, type CircuitGraphicStyle, type CircuitGraphicsProps, type HashMarkStyle } from '@permitzip/bim-pack-electrical'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../../ui/field'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'

const STYLES: ReadonlyArray<{ readonly value: CircuitGraphicStyle; readonly label: string; readonly hint: string }> = [
  { value: 'arcs', label: 'Arcs', hint: 'Curved lines join each circuit’s devices, with a home run on the one nearest the panel.' },
  { value: 'orthogonal', label: 'Square', hint: 'Lines with 90° corners. Drag a line on the drawing to move its corner; it stays where you put it.' },
  { value: 'numbers', label: 'Numbers', hint: 'The circuit number beside each device and one home run per circuit (multifamily style).' },
  { value: 'off', label: 'Off', hint: 'No circuiting on this plan.' },
]

type Mark = 'hot' | 'neutral' | 'ground'

/** Wire hash marks (round 12), each with a picture of a 1-pole home run as it draws. */
const HASH_MARKS: ReadonlyArray<{ readonly value: HashMarkStyle; readonly label: string; readonly hint: string; readonly marks: readonly Mark[] }> = [
  { value: 'off', label: 'None', hint: 'No marks on the home runs.', marks: [] },
  { value: 'hots_neutral', label: 'Hot + neutral', hint: 'A long mark for each hot wire and a short one for the neutral.', marks: ['hot', 'neutral'] },
  { value: 'hots_neutral_ground', label: 'With ground', hint: 'Hots long, the neutral short, and the ground as a long mark with a foot.', marks: ['hot', 'neutral', 'ground'] },
]

/** A 48 × 20 picture: a home run with its marks, as the plan draws them. */
function HashMarkPicture({ marks }: { readonly marks: readonly Mark[] }) {
  const cx = 24
  return (
    <svg width={48} height={20} viewBox="0 0 48 20" aria-hidden className="text-foreground">
      <line x1={4} y1={10} x2={40} y2={10} stroke="currentColor" strokeWidth={1.2} />
      <polyline points="36,7 41,10 36,13" fill="none" stroke="currentColor" strokeWidth={1.2} />
      {marks.map((m, i) => {
        const x = cx + (i - (marks.length - 1) / 2) * 4
        const half = m === 'neutral' ? 3 : 5
        return (
          <g key={i}>
            <line x1={x - 1.5} y1={10 + half} x2={x + 1.5} y2={10 - half} stroke="currentColor" strokeWidth={1} />
            {m === 'ground' && <line x1={x + 1.5} y1={10 - half} x2={x + 4} y2={10 - half} stroke="currentColor" strokeWidth={1} />}
          </g>
        )
      })}
    </svg>
  )
}

interface Props {
  readonly view: ViewElement
  readonly canEdit: boolean
  readonly disabledHint: string | undefined
  readonly set: (patch: ViewPropsPatch, label: string) => void
}

/**
 * How this plan draws circuits: lines (arcs or square), the number beside each
 * device, or nothing; home runs, dashed switch legs, and circuiting on every
 * copy of a typical unit. The lines are worked out from the circuits each time
 * the plan draws, so they follow devices when they move.
 */
export function CircuitGraphicsFields({ view, canEdit, disabledHint, set }: Props) {
  const current: CircuitGraphicsProps = view.props?.circuitGraphics ?? {}
  const resolved = resolveCircuitGraphics(view)
  const change = (patch: Partial<CircuitGraphicsProps>, label: string) => set({ circuitGraphics: { ...current, ...patch } }, label)
  const bends = Object.values(current.hints ?? {}).reduce(
    (n, h) =>
      n +
      Object.keys(h.bends ?? {}).length +
      Object.keys(h.waypoints ?? {}).length +
      Object.keys(h.flipArc ?? {}).length +
      Object.keys(h.memberLabelOffsets ?? {}).length +
      (h.homeRun ? 1 : 0),
    0,
  )
  const hint = STYLES.find((s) => s.value === resolved.style)?.hint ?? ''
  const off = resolved.style === 'off'
  const defaulted = current.style === undefined

  return (
    <FieldSet data-testid="view-circuit-graphics">
      <FieldLegend variant="label">Circuits on this plan</FieldLegend>
      <FieldGroup className="gap-3">
        <Field>
          <FieldLabel>Draw circuits as</FieldLabel>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={resolved.style}
            onValueChange={(v) => {
              const picked = STYLES.find((s) => s.value === v)
              if (picked) change({ style: picked.value }, 'change how circuits draw')
            }}
            disabled={!canEdit}
            data-testid="view-circuit-style"
          >
            {STYLES.map((s) => (
              <ToggleGroupItem key={s.value} value={s.value} aria-label={s.label} data-testid={`view-circuit-style-${s.value}`}>
                {s.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <FieldDescription className="text-xs">
            {disabledHint ?? (defaulted ? `${hint} ${view.props?.discipline === 'electrical' ? 'Electrical plans draw arcs unless you pick otherwise.' : 'Plans of other disciplines draw none unless you pick a style.'}` : hint)}
          </FieldDescription>
        </Field>
        {([
          ['showCircuits', 'Branch power lines', 'branch power lines', 'Draw branch power wires and home runs. Turn off with Switch legs on for a dedicated lighting controls schematic plan.', resolved.showCircuits],
          ['homeRuns', 'Home runs', 'home runs', 'An arrow and the source tag (L1-1) on the device nearest the source. Drag its tip, shaft or label on the plan to adjust.', resolved.homeRuns],
          ['switchLegs', 'Switch legs & controls', 'switch legs', 'Dashed switch legs (and dash-dot 0-10V / DALI control loops) from switches, dimmers and sensors to controlled loads.', resolved.switchLegs],
          ['switchLegLabels', 'Switch-leg letters (a, b)', 'switch-leg letters', 'Lowercase ANSI/NECA 100 switch-leg designations beside switches and controlled fixtures. Drag any letter on the plan to move it.', resolved.switchLegLabels],
          ['allCopies', 'Show circuiting on all units', 'circuiting on all units', 'Typical units draw their own circuiting. Off: only the original, its home runs marked TYP.', resolved.allCopies],
        ] as const).map(([key, label, what, description, checked]) => (
          <Field key={key} orientation="horizontal">
            <Checkbox
              id={`vp-circuit-${key}`}
              checked={checked}
              disabled={!canEdit || off}
              onCheckedChange={(v) => change({ [key]: v === true }, `${v === true ? 'show' : 'hide'} ${what}`)}
              data-testid={`view-circuit-${key}`}
            />
            <FieldLabel htmlFor={`vp-circuit-${key}`} className="font-normal" title={off ? 'Pick a style first: this plan draws no circuits.' : description}>
              {label}
            </FieldLabel>
          </Field>
        ))}
        <Field orientation="horizontal">
          <Checkbox
            id="vp-typ-labels-once"
            checked={resolved.typLabelsOnce}
            disabled={!canEdit || off || !resolved.allCopies || !resolved.homeRuns}
            onCheckedChange={(v) => change({ typLabelsOnce: v === true }, v === true ? 'label repeated typicals once' : 'label every typical unit')}
            data-testid="view-typ-labels-once"
          />
          <FieldContent>
            <FieldLabel htmlFor="vp-typ-labels-once" className="font-normal">
              Label repeated typicals once
            </FieldLabel>
            <FieldDescription className="text-xs">
              {off || !resolved.allCopies || !resolved.homeRuns
                ? 'Applies when home runs and circuiting on all units are on.'
                : resolved.typLabelsOnce
                  ? 'Units fed from one shared source: the first unit’s home run carries the project’s typical label (Electrical types › Drafting) and the others draw the arrow only. Units with their own source keep their own labels.'
                  : 'Every unit’s home run carries its own label.'}
            </FieldDescription>
          </FieldContent>
        </Field>
        <Field>
          <FieldLabel>Wire hash marks</FieldLabel>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={resolved.hashMarks}
            onValueChange={(v) => {
              const picked = HASH_MARKS.find((s) => s.value === v)
              if (picked) change({ hashMarks: picked.value }, 'change the wire hash marks')
            }}
            disabled={!canEdit || off || (!resolved.homeRuns && !resolved.switchLegs)}
            data-testid="view-circuit-hash-marks"
          >
            {HASH_MARKS.map((s) => (
              <ToggleGroupItem key={s.value} value={s.value} aria-label={s.label} title={s.hint} className="h-auto flex-col gap-1 py-1" data-testid={`view-circuit-hash-marks-${s.value}`}>
                <HashMarkPicture marks={s.marks} />
                <span className="text-xs">{s.label}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <FieldDescription className="text-xs">
            {off || (!resolved.homeRuns && !resolved.switchLegs) ? 'Turn home runs or switch legs on first to show wire hash marks.' : (HASH_MARKS.find((s) => s.value === resolved.hashMarks)?.hint ?? '')}
          </FieldDescription>
        </Field>
        {!off && resolved.hashMarks !== 'off' && (
          <Field>
            <FieldLabel>Tick mark placement</FieldLabel>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={resolved.hashMarksOn}
              onValueChange={(v) => {
                if (v === 'home_runs' || v === 'home_runs_and_switch_legs' || v === 'all_runs') {
                  const msg =
                    v === 'all_runs'
                      ? 'show wire ticks on all runs'
                      : v === 'home_runs_and_switch_legs'
                        ? 'show wire ticks on home runs and switch legs'
                        : 'show wire ticks on home runs only'
                  change({ hashMarksOn: v }, msg)
                }
              }}
              disabled={!canEdit}
              data-testid="view-circuit-hash-marks-on"
            >
              <ToggleGroupItem value="home_runs" className="text-xs">Home runs</ToggleGroupItem>
              <ToggleGroupItem value="home_runs_and_switch_legs" className="text-xs">+ Switch legs</ToggleGroupItem>
              <ToggleGroupItem value="all_runs" className="text-xs">All runs</ToggleGroupItem>
            </ToggleGroup>
          </Field>
        )}
        {bends > 0 && (
          <Button
            variant="outline"
            size="sm"
            disabled={!canEdit}
            onClick={() =>
              change(
                {
                  hints: Object.fromEntries(
                    Object.entries(current.hints ?? {}).map(([id, h]) => [
                      id,
                      {
                        ...(h.priority !== undefined ? { priority: h.priority } : {}),
                        ...(h.mwbcGroup !== undefined ? { mwbcGroup: h.mwbcGroup } : {}),
                      },
                    ]),
                  ),
                },
                'reset wire bends and home runs',
              )
            }
            data-testid="view-circuit-clear-bends"
          >
            Reset {bends} manual {bends === 1 ? 'adjustment' : 'adjustments'}
          </Button>
        )}
      </FieldGroup>
    </FieldSet>
  )
}
