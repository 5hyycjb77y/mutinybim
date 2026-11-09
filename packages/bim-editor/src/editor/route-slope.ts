import { isGravity, type SystemKind } from '@permitzip/bim-kernel'
import type { ExistingSystem, RouteChoices } from './RoutePanel'

/** The system kind a Route tool system value means: an existing system's, or `new:<kind>`'s. */
export function systemKindOfChoice(value: string, systems: readonly ExistingSystem[], kinds: readonly { kind: SystemKind }[]): SystemKind | null {
  const existing = systems.find((s) => s.id === value)
  if (existing) return existing.kind
  return value.startsWith('new:') ? (kinds.find((k) => `new:${k.kind}` === value)?.kind ?? null) : null
}

/** Slopes a gravity pipe can be drawn at, in inches per foot. */
export const SLOPE_CHOICES: readonly { readonly value: string; readonly label: string }[] = [
  { value: '0.0625', label: '1/16" per ft' },
  { value: '0.125', label: '1/8" per ft' },
  { value: '0.25', label: '1/4" per ft' },
  { value: '0.5', label: '1/2" per ft' },
]

/** The slope and fall direction a route sends: only for a gravity system; absent fields keep the kernel's own rule. */
export function routeSlope(c: RouteChoices, kind: SystemKind | null): { slopeInPerFt?: number; flow?: 'with_points' | 'against_points' } {
  if (c.kind !== 'pipe' || !kind || !isGravity(kind)) return {}
  const slope = c.slopeInPerFt ? Number(c.slopeInPerFt) : NaN
  return {
    ...(Number.isFinite(slope) && slope > 0 ? { slopeInPerFt: slope } : {}),
    ...(c.slopeDirection === 'down' ? { flow: 'with_points' as const } : c.slopeDirection === 'up' ? { flow: 'against_points' as const } : {}),
  }
}

/** A run's slope as a Route tool choice: the nearest standard slope when it is one, else the value. */
export function slopeChoiceOf(inPerFt: number): string {
  if (!(inPerFt > 0.005)) return ''
  const near = SLOPE_CHOICES.find((s) => Math.abs(Number(s.value) - inPerFt) < 0.01)
  return near ? near.value : String(Math.round(inPerFt * 1000) / 1000)
}
