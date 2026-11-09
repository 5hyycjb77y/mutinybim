/**
 * How far one wheel or trackpad event zooms, in every MutinyBIM view: the 3D
 * and plan cameras (`navigation.ts`), sheets and drawings, and the part
 * editor's plan, front, side and 3D views. One source of truth so every view
 * feels the same.
 *
 * The step follows the wheel's travel (deltaY), so a trackpad's stream of
 * small events zooms as calmly as one mouse notch, and no single event moves
 * more than MAX_WHEEL_STEP however large its deltaY. No three.js here: flat
 * views import this without the 3D viewer.
 */

/** Per pixel of wheel travel: a mouse notch (about 100 px) zooms about 17%. */
export const WHEEL_GAIN = 0.0016;
/** Per pixel of a trackpad pinch, which arrives as many small Ctrl-wheel events: a full pinch is about 20%. */
export const PINCH_GAIN = 0.012;
/** One event never zooms more than e^0.2 ≈ 22% (as a log of the magnification). */
export const MAX_WHEEL_STEP = 0.2;
export const WHEEL_LINE_PX = 16;
export const WHEEL_PAGE_PX = 400;

export interface WheelDelta {
  readonly deltaY: number;
  readonly deltaMode: number;
  /** Set by the browser for a trackpad pinch (and by Ctrl + wheel). */
  readonly ctrlKey: boolean;
}

/** Wheel travel in CSS pixels, whatever unit the browser reported. */
export function wheelTravelPx(delta: number, deltaMode: number): number {
  return deltaMode === 1 ? delta * WHEEL_LINE_PX : deltaMode === 2 ? delta * WHEEL_PAGE_PX : delta;
}

/** Natural log of how much one event magnifies: positive zooms in (deltaY < 0: scroll up, pinch out). */
export function wheelZoomLog({ deltaY, deltaMode, ctrlKey }: WheelDelta): number {
  const step = -wheelTravelPx(deltaY, deltaMode) * (ctrlKey ? PINCH_GAIN : WHEEL_GAIN);
  return Math.min(MAX_WHEEL_STEP, Math.max(-MAX_WHEEL_STEP, step));
}

/** How much one event magnifies: above 1 zooms in, below 1 out. */
export function wheelMagnification(delta: WheelDelta): number {
  return Math.exp(wheelZoomLog(delta));
}
