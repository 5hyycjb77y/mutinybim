"use client";

import { createContext, useContext } from "react";
import type { MutinyComponents } from "./components";
import type { MutinyTheme } from "./theme";
import type { MutinyColorSchemeState, MutinyPresentation } from "./theme-provider";

/**
 * The provider's context, in a leaf: the vendored primitives (`ui/tooltip`)
 * read the portal container from here, and the provider imports those
 * primitives as its default components.
 */

export interface MutinyContextValue {
  readonly theme: MutinyTheme;
  readonly colorScheme: MutinyColorSchemeState;
  readonly presentation: MutinyPresentation;
  readonly components: MutinyComponents;
  /** Element popovers and tooltips portal into, so they keep the scoped variables. */
  readonly portalContainer: HTMLElement | null;
}

export const MutinyContext = createContext<MutinyContextValue | null>(null);

export function useMutinyContext(): MutinyContextValue {
  const ctx = useContext(MutinyContext);
  if (!ctx) throw new Error("MutinyBIM components must be rendered inside <MutinyThemeProvider>.");
  return ctx;
}

export function useMutinyPortalContainer(): HTMLElement | null {
  return useMutinyContext().portalContainer;
}
