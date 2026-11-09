'use client'

import { useSyncExternalStore } from 'react'
import { RotateCw } from 'lucide-react'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Spinner } from '../../ui/spinner'
import { contributionsVersion, loadState, retryContribution, subscribeContributions } from './registry'
import type { ComponentContribution } from './types'

/** Re-renders the caller whenever an add-on screen finishes loading or fails. */
export function useContributionsVersion(): number {
  return useSyncExternalStore(subscribeContributions, contributionsVersion, contributionsVersion)
}

/**
 * Mounts one add-on component (an Inspector section, a rail panel, a
 * dialog): a spinner while its code loads, the error and Retry if it fails,
 * then the component itself.
 */
export function AddonComponent<P extends object>({ contribution, props }: { readonly contribution: ComponentContribution<P>; readonly props: P }) {
  useContributionsVersion()
  const state = loadState(contribution)
  if (state.status === 'loading') {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid={`addon-loading-${contribution.id}`}>
        <Spinner />
        Loading {contribution.label.toLowerCase()}…
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <Alert variant="destructive" data-testid={`addon-error-${contribution.id}`}>
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
  const Loaded = state.module
  return <Loaded {...props} />
}
