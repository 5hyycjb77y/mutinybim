'use client'

import { Suspense, createElement, lazy, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'

/**
 * A part of the editor that loads on demand and only in the browser (it needs
 * the window, WebGL or a big library): off the page's first download. On the
 * server and while the page hydrates it shows `loading` (or nothing); after
 * that it loads the module and renders it. Any bundler that splits on
 * `import()` gives it its own chunk.
 */
export interface ClientOnlyOptions {
  /** Always false: these parts never render on the server. */
  readonly ssr?: false
  /** Shown until the part has loaded. */
  readonly loading?: () => ReactNode
}

type Loaded<P> = ComponentType<P> | { readonly default: ComponentType<P> }

const noSubscription = () => () => {}

function useInBrowser(): boolean {
  return useSyncExternalStore(noSubscription, () => true, () => false)
}

function componentOf<P>(loaded: Loaded<P>): ComponentType<P> {
  return typeof loaded === 'object' && loaded !== null && 'default' in loaded ? loaded.default : loaded
}

export function clientOnly<P extends object>(load: () => Promise<Loaded<P>>, options: ClientOnlyOptions = {}): ComponentType<P> {
  const Part = lazy(async () => ({ default: componentOf(await load()) }))
  const loading = options.loading ?? (() => null)
  function ClientOnly(props: P) {
    const inBrowser = useInBrowser()
    if (!inBrowser) return loading()
    return createElement(Suspense, { fallback: loading() }, createElement(Part as ComponentType<P>, props))
  }
  return ClientOnly
}
