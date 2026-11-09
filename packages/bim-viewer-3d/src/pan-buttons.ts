/**
 * Which mouse buttons pan, the same in every MutinyBIM view: 3D, plan and
 * section cameras, and every flat view (sheets, viewports on a sheet,
 * drafting and detail views, diagrams, the part editor).
 *
 * - The middle button pans.
 * - The left and right buttons held together pan too. Many Mac mice (and
 *   Magic Mouse setups) send that chord, `buttons === 3`, instead of a middle
 *   click. A chord that forms during a left drag turns the drag into a pan.
 * - A pan never opens the right-button menu and never selects or moves
 *   anything. A plain right-click still opens the menu.
 *
 * Pointer events report the second button of a chord as a `pointermove` with
 * the new `buttons`, not as a second `pointerdown`, so surfaces check moves
 * as well as presses. Pens and touches never chord (a pen's barrel button is
 * the right button by itself).
 */

export const BUTTONS_LEFT = 1;
export const BUTTONS_RIGHT = 2;
export const BUTTONS_MIDDLE = 4;
export const BUTTONS_CHORD = BUTTONS_LEFT | BUTTONS_RIGHT;
/** `MouseEvent.button` of the middle button (and of a middle `auxclick`). */
export const BUTTON_MIDDLE = 1;
/** After a pan's buttons come up, the menu and the click it would send stay swallowed this long (Windows sends `contextmenu` after the release), ms. */
export const PAN_RELEASE_GRACE_MS = 400;

export type PanButton = "middle" | "chord";

export interface ButtonState {
  readonly button: number;
  readonly buttons: number;
  readonly pointerType?: string;
}

function isMouse(e: ButtonState): boolean {
  return e.pointerType === undefined || e.pointerType === "" || e.pointerType === "mouse";
}

/** What a press or move asks for: a middle-button pan, a two-button chord pan, or neither (the surface's own click, drag or menu). */
export function panButtonOf(e: ButtonState): PanButton | null {
  if (!isMouse(e)) return null;
  if ((e.buttons & BUTTONS_CHORD) === BUTTONS_CHORD) return "chord";
  if (e.button === BUTTON_MIDDLE) return "middle";
  return null;
}

/**
 * The browser defaults a pan must not trigger, on one view element: the
 * right-button menu (on a Mac it opens on the right press, so a chord whose
 * left press came first is caught by `buttons`), the click the release sends,
 * a middle click's autoscroll, paste or new tab. A plain right-click is left
 * alone so the menu still opens.
 */
export class PanButtonGuard {
  private holding = false;
  private releasedAt: number | null = null;
  private readonly detachers: Array<() => void> = [];

  constructor(
    element: EventTarget,
    private readonly now: () => number = () => performance.now(),
  ) {
    const on = (target: EventTarget, type: string, fn: (e: Event) => void) => {
      target.addEventListener(type, fn, { capture: true });
      this.detachers.push(() => target.removeEventListener(type, fn, { capture: true }));
    };
    on(element, "contextmenu", this.onContextMenu);
    on(element, "auxclick", this.onAuxClick);
    on(element, "click", this.onClick);
    on(element, "mousedown", this.onMouseDown);
    on(element, "pointerdown", this.onPointerDown);
    // The release can land anywhere (the pointer may be captured, or have left the view).
    if (typeof window !== "undefined") {
      on(window, "pointerup", this.onRelease);
      on(window, "pointercancel", this.onRelease);
    }
  }

  dispose() {
    for (const detach of this.detachers.splice(0)) detach();
  }

  /** A pan started (middle, chord, Space or an empty-paper drag): swallow the menu and click this press would send. */
  panStarted() {
    this.holding = true;
    this.releasedAt = null;
  }

  /** A pan is held, or its buttons came up within the grace period. */
  get suppressing(): boolean {
    return this.holding || (this.releasedAt !== null && this.now() - this.releasedAt < PAN_RELEASE_GRACE_MS);
  }

  private readonly onRelease = (e: Event) => {
    if (!this.holding) return;
    if (e.type === "pointerup" && e instanceof MouseEvent && e.buttons !== 0) return;
    this.holding = false;
    this.releasedAt = this.now();
  };

  private readonly onPointerDown = (e: Event) => {
    // A fresh plain press ends the grace: its own click and menu are wanted.
    if (!this.holding && e instanceof MouseEvent && panButtonOf(e) === null) this.releasedAt = null;
  };

  private readonly onContextMenu = (e: Event) => {
    const held = e instanceof MouseEvent ? e.buttons & (BUTTONS_LEFT | BUTTONS_MIDDLE) : 0;
    if (!this.suppressing && held === 0) return;
    e.preventDefault();
    e.stopPropagation();
  };

  private readonly onAuxClick = (e: Event) => {
    if (!(e instanceof MouseEvent)) return;
    if (e.button === BUTTON_MIDDLE) e.preventDefault();
    if (this.suppressing) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  private readonly onClick = (e: Event) => {
    if (!this.suppressing) return;
    e.preventDefault();
    e.stopPropagation();
  };

  private readonly onMouseDown = (e: Event) => {
    // The browser's middle-button autoscroll starts on mousedown.
    if (e instanceof MouseEvent && e.button === BUTTON_MIDDLE) e.preventDefault();
  };
}
