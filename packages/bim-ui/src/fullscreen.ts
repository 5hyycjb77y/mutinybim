"use client";

import { useCallback, useSyncExternalStore } from "react";

export interface FullscreenState {
  /** Whether `target` is the element currently shown full screen. */
  readonly active: boolean;
  /** Whether this browser lets a page go full screen at all. */
  readonly supported: boolean;
  /** Puts `target` full screen, or takes it out. Resolves to a problem message, or null on success. */
  readonly toggle: () => Promise<string | null>;
}

export const FULLSCREEN_UNSUPPORTED = "This browser doesn't allow full screen here. Use Open in new window instead.";

/**
 * Browser Fullscreen API on one element. Esc (handled by the browser) exits;
 * `active` follows the browser's own state, so Esc and the button stay in sync.
 */
function subscribeFullscreen(onChange: () => void): () => void {
  document.addEventListener("fullscreenchange", onChange);
  return () => document.removeEventListener("fullscreenchange", onChange);
}

const notOnServer = () => false;

export function useFullscreen(target: HTMLElement | null): FullscreenState {
  // The server render can't know either value; React uses `false` while hydrating, then the browser's.
  const supported = useSyncExternalStore(subscribeFullscreen, () => document.fullscreenEnabled === true, notOnServer);
  const active = useSyncExternalStore(subscribeFullscreen, () => target !== null && document.fullscreenElement === target, notOnServer);

  const toggle = useCallback(async (): Promise<string | null> => {
    if (!supported || !target) return FULLSCREEN_UNSUPPORTED;
    try {
      if (document.fullscreenElement === target) await document.exitFullscreen();
      else await target.requestFullscreen();
      return null;
    } catch (err) {
      console.error("[useFullscreen] full screen request failed", err);
      return "The browser refused full screen. Try again, or use Open in new window.";
    }
  }, [supported, target]);

  return { active, supported, toggle };
}

export const POPUP_BLOCKED = "Your browser blocked the new window. Allow pop-ups for this site, then try again.";

/**
 * Opens MutinyBIM in its own browser window. Returns a problem message when the
 * browser blocks it. The new window shares the session (same origin) but not
 * this page's JavaScript (`opener` is cleared).
 */
export function openInNewWindow(href: string, name: string): string | null {
  const win = window.open(href, name);
  if (!win) return POPUP_BLOCKED;
  win.opener = null;
  win.focus();
  return null;
}
