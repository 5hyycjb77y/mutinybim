'use client'

import { Fragment, useLayoutEffect, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import type { ViewElement } from '@permitzip/bim-kernel'
import { RotateCw } from 'lucide-react'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { useContributionsVersion } from './AddonComponent'
import { componentContributions, isAddonActive, loadState, retryContribution, type LoadState } from './registry'
import { WORKFLOW_HOST } from './slots'
import type { AddonAvailability, AddonId, AddonInput, ComponentContribution, WorkflowData, WorkflowServices, WorkflowShared, WorkflowView } from './types'
import type { ModelStore } from '../model-store'
import { ModelFromStore } from '../state/model-from-store'

/**
 * Slots the Building Model surface hosts beyond the ribbon, for every
 * add-on that fills them: each add-on's workflow (`WORKFLOW_HOST`) and its
 * rail sections. The code behind each arrives with `import()`, so none of it
 * is in the surface's first load.
 *
 * A workflow host is mounted once, where its dialogs and docked views draw
 * (over the canvas). It runs the add-on's workflow and reports what the
 * surface shows elsewhere (ribbon input, auto tab, shared values) through an
 * outlet. The surface re-renders only when that data changes (its
 * signature: the values without the functions); the functions it holds
 * always call the host's latest ones. Inspector and view-property sections
 * render through `OutletView`, which follows every host render without the
 * surface.
 */

// ---- Outlet

const ids = new WeakMap<object, number>()
let nextId = 1
function idOf(value: object): number {
  let id = ids.get(value)
  if (id === undefined) {
    id = nextId++
    ids.set(value, id)
  }
  return id
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Data only: functions dropped, class instances (an engine) by identity. */
function signatureOf(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'function') return undefined
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && !isPlainObject(v)) return `#${idOf(v)}`
    return v
  })
}

function readPath(root: unknown, path: readonly string[]): unknown {
  let at = root
  for (const key of path) {
    if (!isPlainObject(at)) return undefined
    at = at[key]
  }
  return at
}

/** `value` with every function (in plain objects, any depth) replaced by one that calls the same path on `latest()` when called. */
function withLatestFunctions(value: unknown, latest: () => unknown, path: readonly string[]): unknown {
  if (typeof value === 'function') {
    return (...args: unknown[]): unknown => {
      const fn = readPath(latest(), path)
      if (typeof fn !== 'function') {
        console.error('[building-model] an add-on command is gone since the ribbon was drawn', { path: path.join('.') })
        return undefined
      }
      return fn(...args)
    }
  }
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value)) out[key] = withLatestFunctions(v, latest, [...path, key])
  return out
}

export class WorkflowOutlet<O, D> {
  private latest: O | null = null
  private signature = signatureOf(null)
  private dataVersion = 0
  private nodeVersion = 0
  private stableFor = -1
  private stable: D | null = null
  private readonly dataListeners = new Set<() => void>()
  private readonly nodeListeners = new Set<() => void>()

  /** `project`: the part of the workflow the surface reads while it renders. */
  constructor(private readonly project: (o: O) => D) {}

  readonly subscribeData = (l: () => void): (() => void) => {
    this.dataListeners.add(l)
    return () => this.dataListeners.delete(l)
  }
  readonly subscribeNodes = (l: () => void): (() => void) => {
    this.nodeListeners.add(l)
    return () => this.nodeListeners.delete(l)
  }
  readonly getDataVersion = (): number => this.dataVersion
  readonly getNodeVersion = (): number => this.nodeVersion

  /** The workflow as the host last rendered it; null until its code has loaded. */
  current(): O | null {
    return this.latest
  }

  /** The surface's data: the same object while its signature holds, its functions calling the latest. */
  data(): D | null {
    if (!this.latest) return null
    if (this.stableFor !== this.dataVersion || this.stable === null) {
      // The functions read the latest workflow when called, so the object can outlive this render.
      this.stable = withLatestFunctions(this.project(this.latest), () => (this.latest ? this.project(this.latest) : null), []) as D
      this.stableFor = this.dataVersion
    }
    return this.stable
  }

  /** The host, after each of its renders (null when it goes). */
  publish(next: O | null): void {
    this.latest = next
    this.nodeVersion += 1
    for (const l of [...this.nodeListeners]) l()
    const signature = signatureOf(next ? this.project(next) : null)
    if (signature === this.signature) return
    this.signature = signature
    this.dataVersion += 1
    for (const l of [...this.dataListeners]) l()
  }
}

/** The outlet's surface data, re-rendering the caller only when it changes. */
export function useOutletData<O, D>(outlet: WorkflowOutlet<O, D>): D | null {
  useSyncExternalStore(outlet.subscribeData, outlet.getDataVersion, outlet.getDataVersion)
  return outlet.data()
}

/** Renders part of the workflow (an Inspector section, a view's schedule section) wherever the surface puts it, following every host render. */
export function OutletView<O, D>({ outlet, render }: { readonly outlet: WorkflowOutlet<O, D>; readonly render: (workflow: O) => ReactNode }): ReactNode {
  useSyncExternalStore(outlet.subscribeNodes, outlet.getNodeVersion, outlet.getNodeVersion)
  const workflow = outlet.current()
  return workflow ? render(workflow) : null
}

// ---- Mounting

/** Why an add-on's ribbon commands are off while its workflow isn't running: loading, or it failed (the notice over the view has Retry). */
export function workflowWaitReason(subject: string, state: LoadState<unknown> | null): string {
  if (state?.status === 'error') return `The ${subject} tools didn't load (${state.message}). Press Retry on the notice over the view, or reload the page.`
  return `The ${subject} tools are loading. They are ready in a moment.`
}

type Outlet = WorkflowOutlet<WorkflowView, WorkflowData>

/** One outlet per workflow host, and one change signal for all of them. */
class WorkflowOutlets {
  private readonly byHost = new Map<object, Outlet>()
  private version = 0
  private readonly listeners = new Set<() => void>()

  readonly subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  readonly getVersion = (): number => this.version

  for(host: object): Outlet {
    let outlet = this.byHost.get(host)
    if (!outlet) {
      outlet = new WorkflowOutlet<WorkflowView, WorkflowData>((v) => v.data)
      outlet.subscribeData(() => {
        this.version += 1
        for (const l of [...this.listeners]) l()
      })
      this.byHost.set(host, outlet)
    }
    return outlet
  }
}

/** What the surface draws from every active add-on's workflow. */
export interface AddonWorkflows {
  /** The hosts, mounted over the canvas: their dialogs and docked views. */
  readonly overlays: ReactNode
  /** Sections below the selection's properties. */
  readonly properties: ReactNode
  /** Sections of a view's properties. */
  readonly viewProperties: (view: ViewElement) => ReactNode
  /** Each add-on's ribbon input, for `BuildingModelRibbonContext.addonInputs`. */
  readonly ribbonInputs: Readonly<Record<AddonId, AddonInput<unknown>>>
  /** The first auto tab a workflow asks for; null: the surface decides. */
  readonly autoTab: string | null
  /** What the workflows lend shared screens (`sharedValue`). */
  readonly shared: WorkflowShared
}

/**
 * Mounts every active add-on's workflow host and gathers what they report.
 * The surface re-renders when an add-on's code arrives or a host's data
 * changes, not on every host render. With `store`, each host reads the newest
 * model from it (and re-renders on an edit) while the surface's `services`
 * may carry a model that refreshes only for what the surface itself shows.
 */
export function useAddonWorkflows(services: WorkflowServices, availability?: AddonAvailability, store?: ModelStore): AddonWorkflows {
  useContributionsVersion()
  const [outlets] = useState(() => new WorkflowOutlets())
  useSyncExternalStore(outlets.subscribe, outlets.getVersion, outlets.getVersion)
  const hosts = componentContributions(WORKFLOW_HOST).filter((h) => isAddonActive(h.addon, availability))
  const ribbonInputs: Record<AddonId, AddonInput<unknown>> = {}
  let autoTab: string | null = null
  let shared: WorkflowShared = {}
  for (const host of hosts) {
    const data = outlets.for(host).data()
    ribbonInputs[host.addon] = data ? { ready: data.ribbon } : { waiting: workflowWaitReason(host.subject ?? host.label, loadState(host)) }
    if (data) {
      autoTab = autoTab ?? data.autoTab
      shared = { ...shared, ...data.shared }
    }
  }
  return {
    overlays: hosts.map((host) =>
      store ? (
        <ModelFromStore key={host.id} store={store}>
          {(model) => <HostedWorkflow contribution={host} props={{ services: { ...services, model }, outlet: outlets.for(host) }} />}
        </ModelFromStore>
      ) : (
        <HostedWorkflow key={host.id} contribution={host} props={{ services, outlet: outlets.for(host) }} />
      ),
    ),
    properties: hosts.map((host) => <OutletView key={host.id} outlet={outlets.for(host)} render={(v) => v.properties ?? null} />),
    viewProperties: (view) => (
      <>
        {hosts.map((host) => (
          <Fragment key={host.id}>
            <OutletView outlet={outlets.for(host)} render={(v) => v.viewProperties?.(view) ?? null} />
          </Fragment>
        ))}
      </>
    ),
    ribbonInputs,
    autoTab,
    shared,
  }
}

/** A value a workflow lends shared screens, typed by the screen that reads it; null when no workflow lends it yet. */
export function sharedValue<T>(shared: WorkflowShared, key: string): T | null {
  return key in shared ? (shared[key] as T) : null
}

/**
 * Mounts a workflow host where its overlays draw. While its code loads,
 * nothing shows here (the add-on's ribbon commands say they are loading); if
 * it fails, a notice says so with Retry.
 */
export function HostedWorkflow<P extends object>({ contribution, props }: { readonly contribution: ComponentContribution<P> | null; readonly props: P }): ReactNode {
  useContributionsVersion()
  if (!contribution) return null
  const state = loadState(contribution)
  if (state.status === 'loading') return null
  if (state.status === 'error') {
    return (
      <Alert variant="destructive" className="absolute top-3 left-1/2 z-30 w-96 -translate-x-1/2 shadow-sm" data-testid={`addon-error-${contribution.id}`}>
        <AlertTitle>{contribution.label} didn’t load</AlertTitle>
        <AlertDescription>{state.message}. Check your connection and try again.</AlertDescription>
        <AlertAction>
          <Button size="sm" variant="outline" onClick={() => retryContribution(contribution)} data-testid={`addon-retry-${contribution.id}`}>
            <RotateCw data-icon="inline-start" />
            Retry
          </Button>
        </AlertAction>
      </Alert>
    )
  }
  const Loaded: ComponentType<P> = state.module
  return <Loaded {...props} />
}

/** For a host component: report each render to the outlet, and nothing once unmounted. */
export function usePublishWorkflow<O>(outlet: { readonly publish: (next: O | null) => void }, workflow: O): void {
  useLayoutEffect(() => {
    outlet.publish(workflow)
  })
  useLayoutEffect(() => () => outlet.publish(null), [outlet])
}
