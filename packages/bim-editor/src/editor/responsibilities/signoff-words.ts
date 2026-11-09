import type { TakeResult } from '../../contracts/bim/responsibilities/api'

/**
 * Words for the sign-off log on screens. An entry is recorded; a passkey
 * signature, when there is one, is shown beside it (signing/SignoffSignatureLine).
 */

function when(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** "Recorded Nov 1, 2026, 6:00 AM · entry 42 in this model's sign-off log" */
export function recordedWords(at: string, seq: number): string {
  return `Recorded ${when(at)} · entry ${seq} in this model’s sign-off log`
}

/** What "Take responsibility" did, in words. */
export function takeOutcomeWords(out: TakeResult, disciplineName: string): string {
  if (out.outcome === 'taken') return `You are now responsible for ${disciplineName} on this model. The project team can see this.`
  return `Request sent to ${out.sentTo.length > 0 ? out.sentTo.join(', ') : 'the project lead'}. The part keeps waiting until they approve it.`
}
