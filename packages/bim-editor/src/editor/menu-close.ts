/**
 * Class for a Select or DropdownMenu content on a tool surface whose next
 * click lands on the drawing or the live model (a tool's options, the
 * ribbon's tool menus).
 *
 * While a Radix Select or modal menu is open it sets `pointer-events: none`
 * on the page, and it keeps that lock until its closing animation ends. The
 * close is ~150 ms, longer while the drawing redraws for the new choice, so
 * the clicks right after a pick fall on nothing (a hatch picked, then a
 * region's corners clicked, draws no region). Closing at once releases the
 * page with the pick. Opening still animates.
 *
 * Important (`!`): the stylesheet emits `animate-none` before tw-animate's
 * `animate-out`, both under the same `data-[state=closed]` variant, so a
 * plain `animate-none` loses and the exit animation still runs.
 */
export const CLOSES_AT_ONCE = 'data-[state=closed]:animate-none!'

/**
 * `onCloseAutoFocus` for a tool option's picker: focus does not go back to the
 * picker's button, so Enter and Esc after a pick reach the drawing (finish or
 * cancel the shape) instead of opening the picker again over the page.
 */
export function handKeyboardToDrawing(e: Event): void {
  e.preventDefault()
  const active = document.activeElement
  if (active instanceof HTMLElement) active.blur()
}
