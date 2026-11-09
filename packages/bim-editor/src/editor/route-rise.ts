/**
 * How the Route tool makes a height change mid-run: straight up or down (two
 * 90° elbows), or a slope at 60°, 45° or 22½° (two elbows of that angle).
 * Which slopes a pipe may take follows the bends its fittings come in
 * (`pipeTurnAngles` in the kernel reads them from the fitting families);
 * anything else rises at 45° or straight.
 */

export type RiseStyle = 'vertical' | '45' | '60' | '22.5'

/** Every style, in the order the Route tool lists them. */
export const RISE_STYLES: readonly RiseStyle[] = ['vertical', '60', '45', '22.5']

export function isRiseStyle(v: string): v is RiseStyle {
  return (RISE_STYLES as readonly string[]).includes(v)
}

/** The style's angle from level, degrees (90 for straight up and down). */
export function riseAngle(s: RiseStyle): number {
  return s === 'vertical' ? 90 : Number(s)
}

function deg(a: number): string {
  return a === 22.5 ? '22½°' : `${a}°`
}

/** The words for a style: "Straight (90°)", "60° slope". */
export function riseStyleLabel(s: RiseStyle): string {
  return s === 'vertical' ? 'Straight (90°)' : `${deg(riseAngle(s))} slope`
}

/** The styles a run whose elbows turn `angles` can rise with; straight is always one. Empty `angles`: straight and 45°. */
export function riseStylesFor(angles: readonly number[]): readonly RiseStyle[] {
  const made = angles.length > 0 ? angles : [45, 90]
  return RISE_STYLES.filter((s) => s === 'vertical' || made.some((a) => Math.abs(a - riseAngle(s)) < 0.01))
}

/** The hint while drawing: "60° elbows; click the next point to slope towards" or "straight up or down". */
export function riseHint(s: RiseStyle): string {
  return s === 'vertical' ? 'straight up or down' : `${deg(riseAngle(s))} elbows; click the next point to slope towards`
}
