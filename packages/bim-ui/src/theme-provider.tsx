"use client";

import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { mergeTheme, themeProblems, themeToCssVars, type MutinyTheme, type MutinyThemeOverrides } from "./theme";
import { defaultComponents, type MutinyComponents } from "./components";
import { MutinyContext, useMutinyContext, useMutinyPortalContainer, type MutinyContextValue } from "./mutiny-context";
import {
  baseThemeFor,
  createMemoryColorSchemeAdapter,
  isMutinyColorScheme,
  resolveColorScheme,
  subscribeSystemColorScheme,
  systemPrefersDark,
  type ColorSchemeAdapter,
  type MutinyColorScheme,
  type MutinyResolvedScheme,
} from "./color-scheme";

/**
 * How MutinyBIM is being shown. `standalone` is its own app or window (full brand
 * splash and empty states); `embedded` lives inside a host (a small mark only).
 */
export type MutinyPresentation = "standalone" | "embedded";

/**
 * A host's theme adapter: a React hook that reads the host's own tokens (its
 * theme context, color scheme, user preset) and returns overrides on the Mutiny
 * default. It is called on every render, so it must be stable for the provider's
 * lifetime (pass a module-level function, not an inline lambda).
 */
export type MutinyThemeAdapter = () => MutinyThemeOverrides | undefined;

/** The colour scheme as the toggle and any other control sees it. */
export interface MutinyColorSchemeState {
  /** The person's pick, `system` included. */
  readonly preference: MutinyColorScheme;
  /** What is drawn now. */
  readonly resolved: MutinyResolvedScheme;
  /**
   * Changes the pick, or null when MutinyBIM is embedded or has no adapter: the
   * host owns the scheme then, and MutinyBIM shows no toggle of its own.
   */
  readonly setPreference: ((scheme: MutinyColorScheme) => void) | null;
  /** Plain-words reason the last read or save failed, else null. */
  readonly error: string | null;
}

export { useMutinyPortalContainer };

const noAdapter: MutinyThemeAdapter = () => undefined;

export interface MutinyThemeProviderProps {
  readonly children: ReactNode;
  /** Explicit overrides, applied after the adapter. */
  readonly theme?: MutinyThemeOverrides;
  readonly adapter?: MutinyThemeAdapter;
  readonly presentation?: MutinyPresentation;
  /**
   * Extra CSS variables derived from the resolved theme, for host components
   * rendered inside the BIM root (e.g. re-pointing a host's shadcn tokens so its
   * buttons follow the Mutiny palette in standalone mode).
   */
  readonly hostVars?: (theme: MutinyTheme) => Record<string, string>;
  /** Host-supplied primitives that replace the vendored ones. */
  readonly components?: Partial<MutinyComponents>;
  /**
   * Host-driven scheme (read only). Use when the host already owns light / dark
   * and MutinyBIM should simply follow it, e.g. embedded in the host's page.
   */
  readonly colorScheme?: MutinyColorScheme;
  /**
   * Where the person's scheme is stored, and how changes made elsewhere arrive.
   * Standalone with neither this nor `colorScheme` uses an in-memory adapter
   * starting at `system`. Embedded never shows a toggle, adapter or not.
   */
  readonly colorSchemeAdapter?: ColorSchemeAdapter;
  /** The scheme the server already knows, so the first paint is right. Default `system`. */
  readonly initialColorScheme?: MutinyColorScheme;
  /**
   * What `system` resolves to on the server (a cookie or the
   * `Sec-CH-Prefers-Color-Scheme` hint). Without it the server draws `system` as light.
   */
  readonly initialSystemScheme?: MutinyResolvedScheme;
  /** Also write the variables onto `<html>` (a page that is nothing but MutinyBIM). */
  readonly applyToDocument?: boolean;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly "data-testid"?: string;
}

/**
 * Resolves the theme (Mutiny default → host adapter → explicit overrides) and
 * scopes it as `--mutiny-*` CSS variables on a root element. Everything inside
 * reads those variables; nothing outside the root is touched unless
 * `applyToDocument` is set.
 */
export function MutinyThemeProvider({
  children,
  theme: overrides,
  adapter,
  presentation = "embedded",
  hostVars,
  components,
  colorScheme: controlledScheme,
  colorSchemeAdapter,
  initialColorScheme,
  initialSystemScheme,
  applyToDocument = false,
  className,
  style,
  "data-testid": testId,
}: MutinyThemeProviderProps) {
  const useAdapter = adapter ?? noAdapter;
  const adapted = useAdapter();
  const scheme = useColorSchemeState({ presentation, controlledScheme, colorSchemeAdapter, initialColorScheme, initialSystemScheme });
  const theme = useMemo(() => mergeTheme(mergeTheme(baseThemeFor(scheme.resolved), adapted), overrides), [scheme.resolved, adapted, overrides]);
  const vars = useMemo(() => ({ ...themeToCssVars(theme), ...(hostVars ? hostVars(theme) : {}) }), [theme, hostVars]);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const problems = themeProblems(theme);
    if (problems.length > 0) console.error("[MutinyThemeProvider] theme has problems; affected colors fall back to the browser default", { themeId: theme.id, problems });
  }, [theme]);

  useLayoutEffect(() => {
    if (!applyToDocument) return;
    const el = document.documentElement;
    const previousScheme = el.dataset.mutinyScheme;
    const previousColorScheme = el.style.colorScheme;
    el.dataset.mutinyScheme = scheme.resolved;
    el.style.colorScheme = scheme.resolved;
    return () => {
      if (previousScheme === undefined) delete el.dataset.mutinyScheme;
      else el.dataset.mutinyScheme = previousScheme;
      el.style.colorScheme = previousColorScheme;
    };
  }, [applyToDocument, scheme.resolved]);

  useLayoutEffect(() => {
    if (!applyToDocument) return;
    const el = document.documentElement;
    const previous = new Map<string, string>();
    for (const [key, value] of Object.entries(vars)) {
      previous.set(key, el.style.getPropertyValue(key));
      el.style.setProperty(key, value);
    }
    return () => {
      for (const [key, value] of previous) {
        if (value) el.style.setProperty(key, value);
        else el.style.removeProperty(key);
      }
    };
  }, [applyToDocument, vars]);

  const value = useMemo<MutinyContextValue>(
    () => ({ theme, colorScheme: scheme, presentation, components: { ...defaultComponents, ...components }, portalContainer: root }),
    [theme, scheme, presentation, components, root],
  );

  return (
    <MutinyContext.Provider value={value}>
      <div
        ref={setRoot}
        data-mutiny-root=""
        data-mutiny-theme={theme.id}
        data-mutiny-presentation={presentation}
        data-mutiny-scheme={scheme.resolved}
        data-mutiny-scheme-preference={scheme.preference}
        data-testid={testId}
        className={scheme.resolved === "dark" ? (className ? `${className} dark` : "dark") : className}
        style={{ ...(vars as CSSProperties), colorScheme: scheme.resolved, fontFamily: "var(--mutiny-font-body)", color: "var(--mutiny-text)", ...style }}
      >
        {children}
      </div>
    </MutinyContext.Provider>
  );
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Sync answers arrive before paint (no flash); async ones when they land. */
function readAdapter(adapter: ColorSchemeAdapter, onValue: (value: unknown) => void, onError: (err: unknown) => void): void {
  try {
    const value = adapter.get();
    if (isPromiseLike(value)) value.then(onValue, onError);
    else onValue(value);
  } catch (err) {
    onError(err);
  }
}

interface ColorSchemeInputs {
  readonly presentation: MutinyPresentation;
  readonly controlledScheme: MutinyColorScheme | undefined;
  readonly colorSchemeAdapter: ColorSchemeAdapter | undefined;
  readonly initialColorScheme: MutinyColorScheme | undefined;
  readonly initialSystemScheme: MutinyResolvedScheme | undefined;
}

/**
 * Preference from the controlled prop or the adapter (read once, then kept in
 * step through `subscribe`), resolved against the OS scheme. Standalone with
 * nothing passed gets its own in-memory adapter.
 */
function useColorSchemeState({ presentation, controlledScheme, colorSchemeAdapter, initialColorScheme, initialSystemScheme }: ColorSchemeInputs): MutinyColorSchemeState {
  const [fallbackAdapter] = useState(() => createMemoryColorSchemeAdapter(initialColorScheme ?? "system"));
  const adapter = controlledScheme !== undefined ? undefined : (colorSchemeAdapter ?? (presentation === "standalone" ? fallbackAdapter : undefined));
  const [stored, setStored] = useState<MutinyColorScheme>(initialColorScheme ?? "system");
  const [error, setError] = useState<string | null>(null);
  const storedRef = useRef(stored);
  useLayoutEffect(() => {
    storedRef.current = stored;
  }, [stored]);

  const systemDark = useSyncExternalStore(subscribeSystemColorScheme, systemPrefersDark, () => initialSystemScheme === "dark");

  useLayoutEffect(() => {
    if (!adapter) return;
    let cancelled = false;
    const accept = (value: unknown, source: string) => {
      if (cancelled) return;
      if (isMutinyColorScheme(value)) {
        setStored(value);
        return;
      }
      console.error("[MutinyThemeProvider] colour scheme adapter returned something that isn't light, dark or system; keeping the current scheme", { source, value });
    };
    readAdapter(adapter, (value) => accept(value, "get"), (err) => {
      console.error("[MutinyThemeProvider] colour scheme adapter get() failed; keeping the current scheme", err);
      if (!cancelled) setError(`Couldn't load your saved theme: ${errorText(err)}`);
    });
    const unsubscribe = adapter.subscribe?.((value) => accept(value, "subscribe"));
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [adapter]);

  const canChange = adapter !== undefined && presentation === "standalone";
  const setPreference = useCallback(
    (next: MutinyColorScheme) => {
      if (!adapter) return;
      const previous = storedRef.current;
      const fail = (err: unknown) => {
        console.error("[MutinyThemeProvider] colour scheme adapter set() failed; going back to the previous scheme", { next, previous, err });
        setStored(previous);
        setError(`Couldn't save your theme, so it went back to ${previous}: ${errorText(err)}`);
      };
      setStored(next);
      setError(null);
      try {
        const result = adapter.set(next);
        if (isPromiseLike(result)) result.catch(fail);
      } catch (err) {
        fail(err);
      }
    },
    [adapter],
  );

  const preference = controlledScheme ?? stored;
  const resolved = resolveColorScheme(preference, systemDark);
  return useMemo(
    () => ({ preference, resolved, setPreference: canChange ? setPreference : null, error }),
    [preference, resolved, canChange, setPreference, error],
  );
}

export function useMutinyTheme(): MutinyTheme {
  return useMutinyContext().theme;
}

export function useMutinyColorScheme(): MutinyColorSchemeState {
  return useMutinyContext().colorScheme;
}

export function useMutinyPresentation(): MutinyPresentation {
  return useMutinyContext().presentation;
}

export function useMutinyComponents(): MutinyComponents {
  return useMutinyContext().components;
}

/** The theme when inside a provider, else null (for code that also runs un-themed). */
export function useOptionalMutinyTheme(): MutinyTheme | null {
  return useContext(MutinyContext)?.theme ?? null;
}
